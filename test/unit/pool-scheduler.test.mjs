import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PoolScheduler, formatPoolSelectionSummary } from '../../src/lib/pool/pool-scheduler.mjs'
import { SessionLimitRegistry } from '../../src/lib/pool/session-limit.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-pool-scheduler-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms, { recursive: true })
  const write = (id, accountId, policy = {}) => {
    const vm = {
      id,
      name: id,
      status: 'running',
      schedulable: true,
      proxy_cli_enabled: true,
      proxy: { id: `proxy-${id}`, url: `socks5h://127.0.0.1:${id === 'vm-01' ? 10001 : 10002}` },
      runtime: { worker_socket: path.join(vms, id, 'run', 'worker.sock') },
      policy: { maxConcurrency: 2, concurrencyOverride: true, weight: 1, priority: 0, ...policy },
      claude: {
        account_uuid: accountId,
        account_tier: 'max',
        access_token: `access-${accountId}`,
        refresh_token: `refresh-${accountId}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }
    fs.writeFileSync(path.join(vms, `${id}.json`), JSON.stringify(vm))
    return vm
  }
  write('vm-01', 'account-1')
  write('vm-02', 'account-2')
  fs.writeFileSync(path.join(vms, 'active.json'), JSON.stringify({ active_vm: 'vm-01' }))
  return root
}

class RuntimeRepo {
  states = new Map()

  get(id) {
    return this.states.get(id) || null
  }
  clearExpired() {}
  upsert(state) {
    const next = { ...(this.states.get(state.account_id) || {}), ...state }
    this.states.set(state.account_id, next)
    return next
  }
  clearGrantRevokeCooldown(id, { vmId = null } = {}) {
    const state = this.states.get(id)
    if (!state) return false
    if (
      !/oauth_revoked|oauth_invalid_grant|invalid_grant|token has been revoked|oauth_no_refresh/i.test(
        String(state.cooldown_reason || ''),
      )
    ) {
      return false
    }
    this.states.set(id, {
      ...state,
      vm_id: state.vm_id || vmId,
      status: 'ready',
      cooldown_until: null,
      cooldown_reason: null,
    })
    return true
  }

  markCooldown(id, update) {
    const state = this.states.get(id) || { account_id: id, vm_id: update.vmId, model_states: {} }
    if (update.model) {
      state.model_states = {
        ...(state.model_states || {}),
        [update.model]: { cooldown_until: update.until, reason: update.reason },
      }
    } else {
      state.cooldown_until = update.until
      state.cooldown_reason = update.reason
      state.status = update.status
    }
    this.states.set(id, state)
    return state
  }
}

function scheduler(root, extras = {}) {
  return new PoolScheduler({
    projectRoot: root,
    runtimeRepo: extras.runtimeRepo || new RuntimeRepo(),
    stickyRouter: extras.stickyRouter || null,
    accountQuota: extras.accountQuota || { canAccept: () => ({ ok: true }) },
    workerHealth: extras.workerHealth || (async () => ({ ok: true, credential: { generation: 1, has_access: true } })),
    config: { fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5 },
  })
}

test('scheduler skips a slot whose access is expired and has no refresh', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm1 = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-01.json'), 'utf8'))
  vm1.claude.expires_at = Math.floor(Date.now() / 1000) - 3600
  delete vm1.claude.refresh_token
  vm1.claude.has_refresh = false
  fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify(vm1))
  const pool = scheduler(root)
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  selected.release()
})

test('scheduler keeps a slot whose access is expired but refresh remains', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm1 = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-01.json'), 'utf8'))
  vm1.claude.expires_at = Math.floor(Date.now() / 1000) - 3600
  fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify(vm1))
  const pool = scheduler(root)
  const selected = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-01')
  selected.release()
})

test('scheduler skips excluded account and reserves the next one', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root)
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-1']),
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.accountId, 'account-2')
  assert.equal(pool.snapshot().inflight['account-2'], 1)
  selected.release()
  assert.equal(pool.snapshot().inflight['account-2'], undefined)
})

test('healthy sticky binding outranks weighted selection', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root, {
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-02', accountId: 'account-2' }),
    },
  })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conversation-1',
    allowWait: false,
  })
  assert.equal(selected.accountId, 'account-2')
  assert.equal(selected.selectionReason, 'sticky')
  selected.release()
})

test('account and model cooldowns remove only affected candidates', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  const pool = scheduler(root, { runtimeRepo: repo })
  pool.markCooldown(
    {
      accountId: 'account-1',
      vmId: 'vm-01',
    },
    {
      model: 'claude-opus',
      until: Date.now() + 60_000,
      reason: 'model_rate_limit',
    },
  )
  let selected = await pool.selectAndReserve({
    model: 'claude-opus',
    allowWait: false,
  })
  assert.equal(selected.accountId, 'account-2')
  selected.release()
  selected = await pool.selectAndReserve({
    model: 'claude-sonnet',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  selected.release()
})

test('weighted round robin distributes equal-load candidates', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root)
  const counts = { 'account-1': 0, 'account-2': 0 }
  for (let i = 0; i < 10; i++) {
    const selected = await pool.selectAndReserve({
      model: 'claude-test',
      allowWait: false,
    })
    counts[selected.accountId]++
    selected.release()
  }
  assert.deepEqual(counts, { 'account-1': 5, 'account-2': 5 })
})

test('adaptive reset level and manual level order ordinary candidates', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const now = Date.now()
  const accounts = new Map([
    [
      'account-1',
      { account_id: 'account-1', unified: { headers: { '7d': { reset: now + 60 * 60_000, status: 'allowed' } } } },
    ],
    [
      'account-2',
      {
        account_id: 'account-2',
        unified: { headers: { '7d': { reset: now + 5 * 24 * 60 * 60_000, status: 'allowed' } } },
      },
    ],
  ])
  const pool = scheduler(root, {
    accountQuota: {
      repo: { get: (id) => accounts.get(id) || null },
      canAccept: () => ({ ok: true }),
    },
  })

  let selected = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(selected.accountId, 'account-1')
  assert.equal(selected.priority, 7)
  selected.release()

  const vm2File = path.join(root, 'vms', 'vm-02.json')
  const vm2 = JSON.parse(fs.readFileSync(vm2File, 'utf8'))
  vm2.policy.priority = 10
  fs.writeFileSync(vm2File, JSON.stringify(vm2))
  selected = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(selected.accountId, 'account-2')
  assert.equal(selected.priority, 10)
  selected.release()

  delete vm2.policy.priority
  fs.writeFileSync(vm2File, JSON.stringify(vm2))
  selected = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(selected.accountId, 'account-1')
  selected.release()
})

test('soft-paused but schedulable account stays eligible', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.status = 'paused'
  vm.schedulable = true
  fs.writeFileSync(file, JSON.stringify(vm))
  const selected = await scheduler(root).selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.accountId, 'account-1')
  selected.release()
})

test('stopped slot stays ineligible even if schedulable was left true', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const id of ['vm-01', 'vm-02']) {
    const file = path.join(root, 'vms', `${id}.json`)
    const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    vm.status = 'stopped'
    vm.schedulable = true
    fs.writeFileSync(file, JSON.stringify(vm))
  }
  const selected = await scheduler(root).selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(selected.ok, false)
  assert.equal(selected.reason, 'no_eligible_accounts')
})

test('cooldown is waitable and becomes selectable after it expires', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: repo,
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fallback_wait_timeout_ms: 200, sticky_wait_timeout_ms: 200 },
  })
  pool.markCooldown(
    {
      accountId: 'account-1',
      vmId: 'vm-01',
    },
    {
      until: Date.now() + 40,
      reason: 'provider_transient_error',
    },
  )
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: true,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.accountId, 'account-1')
  assert.ok(selected.waitMs >= 30)
  selected.release()
})

test('busy slot waits for release instead of failing closed', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy.maxConcurrency = 1
  fs.writeFileSync(file, JSON.stringify(vm))
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: new RuntimeRepo(),
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fallback_wait_timeout_ms: 200, sticky_wait_timeout_ms: 200 },
  })
  const first = await pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(first.ok, true)
  const pending = pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: true,
  })
  setTimeout(() => first.release(), 30)
  const second = await pending
  assert.equal(second.ok, true)
  assert.equal(second.accountId, 'account-1')
  second.release()
})

test('wait timeout on cooldown returns busy rather than empty pool', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: repo,
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fallback_wait_timeout_ms: 20, sticky_wait_timeout_ms: 20 },
  })
  repo.markCooldown('account-1', { vmId: 'vm-01', until: Date.now() + 60_000, reason: 'provider_transient_error' })
  repo.markCooldown('account-2', { vmId: 'vm-02', until: Date.now() + 60_000, reason: 'provider_transient_error' })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    allowWait: true,
  })
  assert.equal(selected.ok, false)
  assert.equal(selected.reason, 'all_accounts_busy')
  assert.ok(selected.waitMs < 50)
  assert.ok(selected.soonest_available_ms > 50_000)
  assert.ok(selected.wait_reasons.includes('account_cooldown'))
})

test('long cooldown beyond wait budget fails immediately', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  const unbound = []
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: repo,
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-01', accountId: 'account-1' }),
      unbind: (key) => unbound.push(key),
    },
    config: { fallback_wait_timeout_ms: 200, sticky_wait_timeout_ms: 200 },
  })
  repo.markCooldown('account-1', { vmId: 'vm-01', until: Date.now() + 60_000, reason: 'account_quota_exhausted' })
  repo.markCooldown('account-2', { vmId: 'vm-02', until: Date.now() + 60_000, reason: 'account_quota_exhausted' })
  const started = Date.now()
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conversation-quota',
    allowWait: true,
  })
  const elapsed = Date.now() - started
  assert.equal(selected.ok, false)
  assert.equal(selected.reason, 'all_accounts_busy')
  assert.ok(elapsed < 80, `expected fail-fast, waited ${elapsed}ms`)
  assert.ok(selected.waitMs < 50)
  assert.ok(selected.soonest_available_ms > 50_000)
  assert.equal(selected.sticky_cleared, true)
  assert.deepEqual(unbound, ['conversation-quota'])
  assert.equal(selected.eligible, 2)
  assert.equal(selected.available, 0)
})

test('wait timeouts clamp to 1s–120s and invalid values fall back', () => {
  const pool = new PoolScheduler({
    config: { sticky_wait_timeout_ms: 500, fallback_wait_timeout_ms: 999999 },
  })
  assert.equal(pool.config.sticky_wait_timeout_ms, 1000)
  assert.equal(pool.config.fallback_wait_timeout_ms, 120000)
  pool.reloadConfig({ sticky_wait_timeout_ms: 'nope', fallback_wait_timeout_ms: null })
  assert.equal(pool.config.sticky_wait_timeout_ms, 45000)
  assert.equal(pool.config.fallback_wait_timeout_ms, 30000)
})

test('formatPoolSelectionSummary keeps a compact internal log line', () => {
  assert.equal(formatPoolSelectionSummary({}), '')
  assert.equal(
    formatPoolSelectionSummary({
      reason: 'all_accounts_busy',
      soonest_available_ms: 10_064_000,
      sticky_cleared: true,
    }),
    'all_accounts_busy soonest=10064s sticky_cleared',
  )
})

test('fable family cooldown still allows sonnet on the same account', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  const pool = scheduler(root, { runtimeRepo: repo })
  pool.markCooldown(
    {
      accountId: 'account-1',
      vmId: 'vm-01',
    },
    {
      model: 'fable',
      until: Date.now() + 60_000,
      reason: 'fable_timeout',
    },
  )
  const fable = await pool.selectAndReserve({
    model: 'claude-fable-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(fable.ok, false)
  const sonnet = await pool.selectAndReserve({
    model: 'claude-sonnet-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(sonnet.ok, true)
  assert.equal(sonnet.accountId, 'account-1')
  sonnet.release()
})

test('fable concurrency cap leaves room for other models', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy.maxConcurrency = 8
  fs.writeFileSync(file, JSON.stringify(vm))
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: new RuntimeRepo(),
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fable_max_per_account: 1, fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5 },
  })
  const first = await pool.selectAndReserve({
    model: 'claude-fable-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(first.ok, true)
  const second = await pool.selectAndReserve({
    model: 'claude-fable-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(second.ok, false)
  const sonnet = await pool.selectAndReserve({
    model: 'claude-sonnet-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(sonnet.ok, true)
  first.release()
  sonnet.release()
})

test('weekly split blocks regular but still accepts fable on the same account', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const split = {
    enabled: true,
    fable_share: 0.5,
    fable_used_weekly: 0,
    regular_used_weekly: 0.5,
    fable_remain_weekly: 0.5,
    regular_remain_weekly: 0,
    fable_blocked: false,
    regular_blocked: true,
    mode: 'fable_only',
  }
  const pool = scheduler(root, {
    accountQuota: {
      canAccept: () => ({ ok: true }),
      weeklySplitOf: () => split,
    },
  })
  const sonnet = await pool.selectAndReserve({
    model: 'claude-sonnet-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(sonnet.ok, false)
  assert.equal(sonnet.reason, 'all_accounts_busy')
  const fable = await pool.selectAndReserve({
    model: 'claude-fable-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(fable.ok, true)
  assert.equal(fable.accountId, 'account-1')
  fable.release()
})

test('weekly split disabled never intercepts even if halves look full', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root, {
    accountQuota: {
      canAccept: () => ({ ok: true }),
      weeklySplitOf: () => ({
        enabled: false,
        regular_blocked: true,
        fable_blocked: true,
        mode: 'open',
      }),
    },
  })
  const sonnet = await pool.selectAndReserve({
    model: 'claude-sonnet-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(sonnet.ok, true)
  assert.equal(sonnet.accountId, 'account-1')
  sonnet.release()
})

test('scheduler skips a slot with no Claude token', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.claude = {}
  fs.writeFileSync(file, JSON.stringify(vm))
  const selected = await scheduler(root).selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  selected.release()
})

test('scheduler hard-excludes worker refresh failure', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: new RuntimeRepo(),
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async (exec) =>
      exec.vmId === 'vm-01'
        ? { ok: false, last_error: 'credential_refresh_failed' }
        : { ok: true, credential: { generation: 1, has_access: true } },
    config: { fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5 },
  })
  const selected = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  selected.release()
})

test('maxConcurrency 0 does not fall back to 20', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const id of ['vm-01', 'vm-02']) {
    const file = path.join(root, 'vms', `${id}.json`)
    const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    vm.policy.maxConcurrency = 0
    vm.policy.concurrencyOverride = true
    fs.writeFileSync(file, JSON.stringify(vm))
  }
  const selected = await scheduler(root).selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(selected.ok, false)
  assert.equal(selected.reason, 'no_eligible_accounts')
})

test('maxConcurrency 8 is the actual reserve cap', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy.maxConcurrency = 8
  vm.policy.concurrencyOverride = true
  fs.writeFileSync(file, JSON.stringify(vm))
  const pool = scheduler(root)
  const held = []
  for (let i = 0; i < 8; i++) {
    const selected = await pool.selectAndReserve({
      model: 'claude-test',
      excluded: new Set(['account-2']),
      allowWait: false,
    })
    assert.equal(selected.ok, true)
    held.push(selected)
  }
  const ninth = await pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(ninth.ok, false)
  for (const item of held) item.release()
})

test('unpinned slot follows live tier concurrency after reloadConfig', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy.maxConcurrency = 2
  vm.policy.concurrencyOverride = false
  fs.writeFileSync(file, JSON.stringify(vm))
  const accountQuota = new AccountQuota({
    dataDir: path.join(root, 'data'),
    config: { tiers: { max: { max_concurrency: 2, max_rpm: 0, max_sessions: 0 } } },
    accounts: [{ account_id: 'account-1', vm_id: 'vm-01', max_concurrency: 2 }],
  })
  accountQuota.setAccountTier('account-1', 'max')
  const pool = scheduler(root, { accountQuota })
  accountQuota.reloadConfig({
    quota: { block_on_5h: true, block_on_7d: true },
    tiers: { max: { max_concurrency: 3, max_rpm: 0, max_sessions: 0 } },
  })
  const held = []
  for (let i = 0; i < 3; i++) {
    const selected = await pool.selectAndReserve({
      model: 'claude-test',
      excluded: new Set(['account-2']),
      allowWait: false,
    })
    assert.equal(selected.ok, true, `reserve ${i}`)
    held.push(selected)
  }
  const fourth = await pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(fourth.ok, false)
  for (const item of held) item.release()
})

test('worker health generation bump clears auth cooldown only', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  repo.clearAuthCooldown = function clearAuthCooldown(id) {
    const state = this.states.get(id)
    if (!state || !/authentication_failed_after_refresh|permission_denied/i.test(String(state.cooldown_reason || ''))) {
      return false
    }
    state.cooldown_until = null
    state.cooldown_reason = null
    state.status = 'ready'
    return true
  }
  repo.upsert({ account_id: 'account-1', vm_id: 'vm-01', credential_generation: 1 })
  repo.markCooldown('account-1', {
    vmId: 'vm-01',
    until: Date.now() + 600_000,
    reason: 'authentication_failed_after_refresh',
  })
  repo.markCooldown('account-2', {
    vmId: 'vm-02',
    until: Date.now() + 600_000,
    reason: 'account_quota_exhausted',
  })
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: repo,
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 2, has_access: true, has_refresh: true } }),
    config: { fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5 },
  })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-01')
  assert.equal(repo.get('account-1').cooldown_reason, null)
  assert.equal(repo.get('account-2').cooldown_reason, 'account_quota_exhausted')
  selected.release()
})

test('same-generation worker health does not wipe a 401 park', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  repo.upsert({ account_id: 'account-1', vm_id: 'vm-01', credential_generation: 1 })
  repo.markCooldown('account-1', {
    vmId: 'vm-01',
    until: Date.now() + 600_000,
    reason: 'authentication_failed_after_refresh',
  })
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: repo,
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true, has_refresh: true } }),
    config: { fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5 },
  })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  assert.equal(repo.get('account-1').cooldown_reason, 'authentication_failed_after_refresh')
  selected.release()
})

test('sticky 401 cooldown unbinds and rotates to a free account', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  const unbound = []
  const pool = scheduler(root, {
    runtimeRepo: repo,
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-01', accountId: 'account-1' }),
      unbind: (key) => unbound.push(key),
    },
  })
  repo.markCooldown('account-1', {
    vmId: 'vm-01',
    until: Date.now() + 600_000,
    reason: 'authentication_failed_after_refresh',
  })
  const selected = await pool.selectAndReserve({
    model: 'claude-sonnet-5',
    stickyKey: 'conversation-401',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  assert.deepEqual(unbound, ['conversation-401'])
  selected.release()
})

test('sticky 401 cooldown soonest ignores the unbound pin', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: repo,
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-01', accountId: 'account-1' }),
      unbind: () => {},
    },
    config: { fallback_wait_timeout_ms: 50, sticky_wait_timeout_ms: 50 },
  })
  repo.markCooldown('account-1', {
    vmId: 'vm-01',
    until: Date.now() + 600_000,
    reason: 'authentication_failed_after_refresh',
  })
  repo.markCooldown('account-2', {
    vmId: 'vm-02',
    until: Date.now() + 80_000,
    reason: 'account_quota_exhausted',
  })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conversation-401-soonest',
    allowWait: true,
  })
  assert.equal(selected.ok, false)
  assert.equal(selected.reason, 'all_accounts_busy')
  assert.equal(selected.sticky_cleared, true)
  assert.ok(selected.soonest_available_ms > 70_000)
  assert.ok(selected.soonest_available_ms < 120_000)
})

test('sticky cooldown unbinds and rotates to a free account', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  const unbound = []
  const pool = scheduler(root, {
    runtimeRepo: repo,
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-01', accountId: 'account-1' }),
      unbind: (key) => unbound.push(key),
    },
  })
  pool.markCooldown(
    {
      accountId: 'account-1',
      vmId: 'vm-01',
    },
    {
      until: Date.now() + 60_000,
      reason: 'account_quota_exhausted',
    },
  )
  const selected = await pool.selectAndReserve({
    model: 'claude-sonnet-5',
    stickyKey: 'conversation-cool',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  assert.equal(selected.accountId, 'account-2')
  assert.notEqual(selected.selectionReason, 'sticky')
  assert.deepEqual(unbound, ['conversation-cool'])
  selected.release()
})

test('sticky concurrency still waits on the bound account', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy.maxConcurrency = 1
  fs.writeFileSync(file, JSON.stringify(vm))
  const unbound = []
  const pool = scheduler(root, {
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-01', accountId: 'account-1' }),
      unbind: (key) => unbound.push(key),
    },
  })
  const first = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conversation-busy',
    allowWait: false,
  })
  assert.equal(first.ok, true)
  assert.equal(first.vmId, 'vm-01')
  const second = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conversation-busy',
    allowWait: false,
  })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'all_accounts_busy')
  assert.deepEqual(unbound, [])
  first.release()
})

test('sticky RPM still waits on the bound account', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const unbound = []
  const rpm = { n: 0 }
  const pool = scheduler(root, {
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-01', accountId: 'account-1' }),
      unbind: (key) => unbound.push(key),
    },
    accountQuota: {
      canAccept: () => {
        if (rpm.n >= 1) return { ok: false, reason: 'rpm_limit', detail: { reset_at: Date.now() + 60_000 } }
        return { ok: true }
      },
      tryAcquire: () => {
        rpm.n += 1
        return { ok: true }
      },
    },
  })
  const first = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conversation-rpm',
    allowWait: false,
  })
  assert.equal(first.ok, true)
  assert.equal(first.vmId, 'vm-01')
  const second = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conversation-rpm',
    allowWait: false,
  })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'all_accounts_busy')
  assert.deepEqual(unbound, [])
  first.release()
})

test('dead sticky binding is unbound then WRR continues', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const unbound = []
  const pool = scheduler(root, {
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-gone', accountId: 'account-gone' }),
      unbind: (key) => unbound.push(key),
    },
  })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'stale-session',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.deepEqual(unbound, ['stale-session'])
  assert.notEqual(selected.selectionReason, 'sticky')
  selected.release()
})

test('pinVmId selects only that slot', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const selected = await scheduler(root).selectAndReserve({
    model: 'claude-test',
    pinVmId: 'vm-02',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  selected.release()
})

test('pinVmId skips quota tryAcquire and does not tight-loop', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root, {
    accountQuota: {
      canAccept: () => ({ ok: false, reason: 'quota_5h_safety' }),
      tryAcquire: (_id, opts = {}) => (opts.skipGate ? { ok: true } : { ok: false, reason: 'quota_5h_safety' }),
    },
  })
  const picked = await Promise.race([
    pool.selectAndReserve({ model: 'claude-test', pinVmId: 'vm-01', allowWait: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('pin+quota tight-loop')), 200)),
  ])
  assert.equal(picked.ok, true)
  assert.equal(picked.vmId, 'vm-01')
  picked.release()
})

test('reserve miss excludes the account instead of spinning', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root, {
    accountQuota: {
      canAccept: () => ({ ok: true }),
      tryAcquire: () => ({ ok: false, reason: 'quota_5h_safety' }),
    },
  })
  const picked = await Promise.race([
    pool.selectAndReserve({ model: 'claude-test', allowWait: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('reserve-miss tight-loop')), 200)),
  ])
  assert.equal(picked.ok, false)
  assert.equal(picked.reason, 'no_eligible_accounts')
})

test('pinVmId can test a slot parked with leftover oauth_no_refresh', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-02.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.schedulable = false
  vm.schedule_disabled_reason = 'disabled'
  vm.schedule_manual = true
  delete vm.claude.refresh_token
  vm.claude.has_refresh = false
  vm.claude.has_access = true
  vm.claude.mode = 'setup-token'
  fs.writeFileSync(file, JSON.stringify(vm))
  const runtimeRepo = new RuntimeRepo()
  runtimeRepo.markCooldown('account-2', {
    vmId: 'vm-02',
    until: Number.MAX_SAFE_INTEGER,
    reason: 'oauth_no_refresh',
    status: 'disabled',
  })
  const pool = scheduler(root, { runtimeRepo })
  const open = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(open.ok, true)
  assert.equal(open.vmId, 'vm-01')
  open.release()
  const parked = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(parked.ok, true)
  assert.equal(parked.vmId, 'vm-01')
  parked.release()
  const pinned = await pool.selectAndReserve({
    model: 'claude-test',
    pinVmId: 'vm-02',
    allowWait: false,
  })
  assert.equal(pinned.ok, true)
  assert.equal(pinned.vmId, 'vm-02')
  assert.equal(pinned.busy, false)
  pinned.release()
})

test('pinVmId can test a slot taken out of the pool', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-02.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.schedulable = false
  fs.writeFileSync(file, JSON.stringify(vm))
  const pool = scheduler(root)
  const open = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(open.ok, true)
  assert.equal(open.vmId, 'vm-01')
  open.release()
  const pinned = await pool.selectAndReserve({
    model: 'claude-test',
    pinVmId: 'vm-02',
    allowWait: false,
  })
  assert.equal(pinned.ok, true)
  assert.equal(pinned.vmId, 'vm-02')
  pinned.release()
})

test('quota-limited account stays off the picker even when schedulable', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const reset = new Date(Date.now() + 4 * 3600_000).toISOString()
  const limited = {
    account_id: 'account-1',
    last_used_at: Date.now(),
    last_probe: { ok: true, source: 'official-cc-usage', at: new Date().toISOString() },
    unified: {
      source: 'official-cc-usage',
      last_probe: { ok: true, source: 'official-cc-usage', at: new Date().toISOString() },
      '5h': { utilization: 1, status: 'rejected', reset },
      '7d': { utilization: 0.1, status: 'allowed' },
    },
  }
  const pool = scheduler(root, {
    accountQuota: {
      repo: { get: (id) => (id === 'account-1' ? limited : null) },
      policyFor: () => ({ limit_5h: 0.85, limit_7d: 0.8 }),
      canAccept: (id) => (id === 'account-1' ? { ok: false, reason: 'quota_5h_cli' } : { ok: true }),
    },
  })
  const selected = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(selected.ok, true)
  assert.equal(selected.accountId, 'account-2')
  selected.release()
})

test('scheduler fails closed when every account is ineligible', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const id of ['vm-01', 'vm-02']) {
    const file = path.join(root, 'vms', `${id}.json`)
    const vm = JSON.parse(fs.readFileSync(file))
    vm.schedulable = false
    fs.writeFileSync(file, JSON.stringify(vm))
  }
  const selected = await scheduler(root).selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(selected.ok, false)
  assert.equal(selected.reason, 'no_eligible_accounts')
})

function writeTier(root, id, tier, extras = {}) {
  const file = path.join(root, 'vms', `${id}.json`)
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (tier == null) delete vm.claude.account_tier
  else vm.claude.account_tier = tier
  if (extras.allowed_models !== undefined) {
    if (extras.allowed_models == null) delete vm.policy.allowed_models
    else vm.policy.allowed_models = extras.allowed_models
  }
  fs.writeFileSync(file, JSON.stringify(vm))
}

test('fable skips pro and unknown, lands on max', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeTier(root, 'vm-01', 'pro')
  writeTier(root, 'vm-02', 'max')
  const pool = scheduler(root)
  const selected = await pool.selectAndReserve({ model: 'claude-fable-5', allowWait: false })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  selected.release()
})

test('fable with only pro slots returns fable_requires_max', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeTier(root, 'vm-01', 'pro')
  writeTier(root, 'vm-02', null)
  const selected = await scheduler(root).selectAndReserve({
    model: 'claude-fable-5',
    allowWait: false,
  })
  assert.equal(selected.ok, false)
  assert.equal(selected.reason, 'fable_requires_max')
})

test('sonnet still lands on a pro slot', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeTier(root, 'vm-01', 'pro')
  writeTier(root, 'vm-02', 'pro')
  const selected = await scheduler(root).selectAndReserve({
    model: 'claude-sonnet-5',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.ok(selected.vmId === 'vm-01' || selected.vmId === 'vm-02')
  selected.release()
})

test('allowed_models whitelist skips other families', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeTier(root, 'vm-01', 'max', { allowed_models: ['claude-sonnet-5'] })
  writeTier(root, 'vm-02', 'max', { allowed_models: ['claude-fable-5'] })
  const pool = scheduler(root)
  const fable = await pool.selectAndReserve({ model: 'claude-fable-5', allowWait: false })
  assert.equal(fable.ok, true)
  assert.equal(fable.vmId, 'vm-02')
  fable.release()
  const opus = await pool.selectAndReserve({ model: 'claude-opus-5', allowWait: false })
  assert.equal(opus.ok, false)
  const sonnet = await pool.selectAndReserve({ model: 'claude-sonnet-5', allowWait: false })
  assert.equal(sonnet.ok, true)
  assert.equal(sonnet.vmId, 'vm-01')
  sonnet.release()
})

test('allowed_models prefix matches dated fable ids', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeTier(root, 'vm-01', 'pro')
  writeTier(root, 'vm-02', 'max', { allowed_models: ['claude-fable-5'] })
  const selected = await scheduler(root).selectAndReserve({
    model: 'claude-fable-5-20260801',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  selected.release()
})

test('reserve release keeps session occupancy until idle prune', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessions = new SessionLimitRegistry()
  const pool = scheduler(root, {
    accountQuota: {
      canAccept: () => ({ ok: true }),
      tryAcquire: () => ({ ok: true }),
      sessions,
    },
  })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'sess-1',
    allowWait: false,
    pinVmId: 'vm-01',
  })
  assert.equal(selected.ok, true)
  assert.equal(sessions.snapshot(selected.accountId, { max: 4 }).active, 1)
  selected.release()
  assert.equal(sessions.snapshot(selected.accountId, { max: 4 }).active, 1)
  assert.equal(sessions.canAccept(selected.accountId, 'sess-1', { max: 1 }).ok, true)
  assert.equal(sessions.canAccept(selected.accountId, 'sess-2', { max: 1 }).ok, false)
})

test('overlapping same session key stays occupied after both reservations release', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessions = new SessionLimitRegistry()
  const pool = scheduler(root, {
    accountQuota: {
      canAccept: () => ({ ok: true }),
      tryAcquire: () => ({ ok: true }),
      sessions,
    },
  })
  const first = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'shared',
    allowWait: false,
    pinVmId: 'vm-01',
  })
  const second = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'shared',
    allowWait: false,
    pinVmId: 'vm-01',
  })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(sessions.snapshot('account-1', { max: 4 }).active, 1)
  first.release()
  assert.equal(sessions.snapshot('account-1', { max: 4 }).active, 1)
  second.release()
  assert.equal(sessions.snapshot('account-1', { max: 4 }).active, 1)
  assert.equal(sessions.canAccept('account-1', 'shared', { max: 1 }).ok, true)
  assert.equal(sessions.canAccept('account-1', 'other', { max: 1 }).ok, false)
})

function cleanupProject(root, pool) {
  try {
    for (const timer of pool?.cooldownTimers?.values?.() || []) clearTimeout(timer)
    pool?.cooldownTimers?.clear?.()
  } catch {}
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {}
}

test('syncQuotaSchedule keeps Extra 5h exhausted schedulable and skips the slot', async (t) => {
  const root = project()
  let pool
  t.after(() => cleanupProject(root, pool))
  const q = new AccountQuota({ dataDir: path.join(root, 'data'), config: {} })
  q.ensure({ account_id: 'account-1', vm_id: 'vm-01' })
  q.ensure({ account_id: 'account-2', vm_id: 'vm-02' })
  const reset = new Date(Date.now() + 4 * 3600_000).toISOString()
  q.ingestHeaders('account-1', {
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': reset,
  })
  const repo = new RuntimeRepo()
  pool = new PoolScheduler({
    projectRoot: root,
    accountQuota: q,
    runtimeRepo: repo,
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
  })
  const vmPath = path.join(root, 'vms', 'vm-01.json')
  const restricted = pool.syncQuotaSchedule(JSON.parse(fs.readFileSync(vmPath, 'utf8')))
  assert.equal(restricted.action, 'restrict')
  assert.equal(restricted.reason, 'quota_5h_header')
  const parked = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(parked.schedulable, true)
  assert.equal(parked.schedule_disabled_reason ?? null, null)
  assert.equal(parked.status, 'running')
  assert.equal(parked.claude.temp_unschedulable_reason, 'quota_5h_header')
  assert.ok(Number(parked.claude.temp_unschedulable_until) > Date.now())
  const picked = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(picked.ok, true)
  assert.equal(picked.accountId, 'account-2')
  picked.release()
})

test('syncQuotaSchedule auto-picks Extra 5h again after the window opens', async (t) => {
  const root = project()
  let pool
  t.after(() => cleanupProject(root, pool))
  const q = new AccountQuota({ dataDir: path.join(root, 'data'), config: {} })
  q.ensure({ account_id: 'account-1', vm_id: 'vm-01' })
  const reset = new Date(Date.now() + 4 * 3600_000).toISOString()
  q.ingestHeaders('account-1', {
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': reset,
  })
  pool = new PoolScheduler({
    projectRoot: root,
    accountQuota: q,
    runtimeRepo: new RuntimeRepo(),
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
  })
  const vmPath = path.join(root, 'vms', 'vm-01.json')
  pool.syncQuotaSchedule(JSON.parse(fs.readFileSync(vmPath, 'utf8')))
  q.ingestHeaders('account-1', {
    'anthropic-ratelimit-unified-5h-utilization': '0.2',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-reset': reset,
  })
  const on = pool.syncQuotaSchedule(JSON.parse(fs.readFileSync(vmPath, 'utf8')))
  assert.equal(on.action, 'clear')
  const restored = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(restored.schedulable, true)
  assert.equal(restored.schedule_disabled_reason ?? null, null)
  assert.equal(restored.claude.temp_unschedulable_until, undefined)
  const other = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-02.json'), 'utf8'))
  other.schedulable = false
  other.schedule_manual = true
  other.schedule_disabled_reason = 'disabled'
  fs.writeFileSync(path.join(root, 'vms', 'vm-02.json'), JSON.stringify(other))
  const picked = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(picked.ok, true)
  assert.equal(picked.accountId, 'account-1')
  picked.release()
})

test('syncQuotaSchedule does not turn a manual-off slot back on', async (t) => {
  const root = project()
  let pool
  t.after(() => cleanupProject(root, pool))
  const q = new AccountQuota({ dataDir: path.join(root, 'data'), config: {} })
  q.ensure({ account_id: 'account-1', vm_id: 'vm-01' })
  q.ensure({ account_id: 'account-2', vm_id: 'vm-02' })
  q.ingestHeaders('account-1', {
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': new Date(Date.now() + 4 * 3600_000).toISOString(),
  })
  const vmPath = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  vm.schedulable = false
  vm.schedule_manual = true
  vm.schedule_disabled_reason = 'disabled'
  fs.writeFileSync(vmPath, JSON.stringify(vm))
  pool = new PoolScheduler({
    projectRoot: root,
    accountQuota: q,
    runtimeRepo: new RuntimeRepo(),
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
  })
  const out = pool.syncQuotaSchedule(JSON.parse(fs.readFileSync(vmPath, 'utf8')))
  assert.ok(out.action === 'restrict' || out.action === 'keep')
  const after = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(after.schedulable, false)
  assert.equal(after.schedule_disabled_reason, 'disabled')
  assert.equal(after.schedule_manual, true)
  const picked = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(picked.ok, true)
  assert.equal(picked.accountId, 'account-2')
  picked.release()
})

test('leftover quota 调度关 is restored to restricted without flipping the operator off', (t) => {
  const root = project()
  let pool
  t.after(() => cleanupProject(root, pool))
  const q = new AccountQuota({ dataDir: path.join(root, 'data'), config: {} })
  q.ensure({ account_id: 'account-1', vm_id: 'vm-01' })
  q.ingestHeaders('account-1', {
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': new Date(Date.now() + 4 * 3600_000).toISOString(),
  })
  const vmPath = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  vm.schedulable = false
  vm.schedule_disabled_reason = 'quota_5h_header'
  fs.writeFileSync(vmPath, JSON.stringify(vm))
  pool = new PoolScheduler({ projectRoot: root, accountQuota: q, runtimeRepo: new RuntimeRepo() })
  const out = pool.syncQuotaSchedule(JSON.parse(fs.readFileSync(vmPath, 'utf8')))
  assert.equal(out.action, 'restore')
  const after = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(after.schedulable, true)
  assert.equal(after.schedule_disabled_reason ?? null, null)
  assert.equal(after.claude.temp_unschedulable_reason, 'quota_5h_header')
})

test('peekAccount keeps sticky without bind unbind or inflight', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const unbound = []
  const bound = []
  const pool = scheduler(root, {
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-02', accountId: 'account-2' }),
      unbind: (key) => unbound.push(key),
      bind: (...args) => bound.push(args),
    },
  })
  const peeked = await pool.peekAccount({ model: 'claude-test', stickyKey: 'conversation-1' })
  assert.equal(peeked.ok, true)
  assert.equal(peeked.accountId, 'account-2')
  assert.equal(peeked.selectionReason, 'sticky')
  assert.deepEqual(unbound, [])
  assert.deepEqual(bound, [])
  assert.equal(pool.snapshot().inflight['account-2'], undefined)
})

test('peekAccount does not unbind when sticky account is ineligible', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const unbound = []
  const vm1 = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-01.json'), 'utf8'))
  vm1.schedulable = false
  fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify(vm1))
  const pool = scheduler(root, {
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-01', accountId: 'account-1' }),
      unbind: (key) => unbound.push(key),
    },
  })
  const peeked = await pool.peekAccount({ model: 'claude-test', stickyKey: 'conversation-1' })
  assert.equal(peeked.ok, true)
  assert.equal(peeked.accountId, 'account-2')
  assert.deepEqual(unbound, [])
})

test('platform scope skips tenant-owned VMs', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const owned = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-02.json'), 'utf8'))
  owned.owner_user_id = 'tenant-1'
  owned.origin = 'user_created'
  fs.writeFileSync(path.join(root, 'vms', 'vm-02.json'), JSON.stringify(owned))
  const pool = scheduler(root)
  const picked = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(picked.ok, true)
  assert.equal(picked.vmId, 'vm-01')
  picked.release()
  const tenant = await pool.selectAndReserve({
    model: 'claude-test',
    allowWait: false,
    ownerScope: { type: 'user', userId: 'tenant-1' },
  })
  assert.equal(tenant.ok, true)
  assert.equal(tenant.vmId, 'vm-02')
  tenant.release()
  const miss = await pool.selectAndReserve({
    model: 'claude-test',
    allowWait: false,
    ownerScope: { type: 'user', userId: 'tenant-1' },
    pinVmId: 'vm-01',
  })
  assert.equal(miss.ok, false)
})

function busyKernelHealth() {
  return { ok: true, ready_slots: 0, cli_pid: 9, credential: { generation: 1, has_access: true } }
}

function applyShortWaits(pool, { sticky = 200, fallback = 20 } = {}) {
  pool.config.sticky_wait_timeout_ms = sticky
  pool.config.fallback_wait_timeout_ms = fallback
}

test('slot-full kernel with live CLI is waitable, not worker_unhealthy', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  const pool = scheduler(root, {
    runtimeRepo: repo,
    workerHealth: async () => busyKernelHealth(),
  })
  const selected = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(selected.ok, true)
  assert.equal(selected.waitReason, 'slot_busy')
  assert.notEqual(repo.get(selected.accountId)?.status, 'worker_unhealthy')
  assert.equal(repo.get(selected.accountId)?.status, 'busy')
  selected.release()
})

test('kernel without cli_pid and no ready slot is skipped as unhealthy', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root, {
    workerHealth: async (exec) => {
      if (exec.vmId === 'vm-01') {
        return { ok: true, engine: 'rust', ready_slots: 0, credential: { generation: 1, has_access: true } }
      }
      return { ok: true, ready_slots: 2, cli_pid: 8, credential: { generation: 1, has_access: true } }
    },
  })
  const selected = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  selected.release()
})

test('sticky wait uses sticky timeout; fallback wait uses fallback timeout', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy.maxConcurrency = 1
  fs.writeFileSync(file, JSON.stringify(vm))
  const pool = scheduler(root, {
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-01', accountId: 'account-1' }),
      unbind: () => {},
    },
  })
  applyShortWaits(pool, { sticky: 200, fallback: 20 })
  const first = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conversation-wait',
    allowWait: false,
  })
  assert.equal(first.ok, true)
  const stickyStarted = Date.now()
  const stickyBusy = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conversation-wait',
    allowWait: true,
  })
  const stickyElapsed = Date.now() - stickyStarted
  assert.equal(stickyBusy.ok, false)
  assert.equal(stickyBusy.reason, 'all_accounts_busy')
  assert.ok(stickyElapsed >= 160, `sticky waited ${stickyElapsed}ms`)
  assert.ok(stickyElapsed < 350, `sticky waited ${stickyElapsed}ms`)
  first.release()

  const holdA = await pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(holdA.ok, true)
  const fallbackStarted = Date.now()
  const fallbackBusy = await pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: true,
  })
  const fallbackElapsed = Date.now() - fallbackStarted
  assert.equal(fallbackBusy.ok, false)
  assert.ok(fallbackElapsed >= 10, `fallback waited ${fallbackElapsed}ms`)
  assert.ok(fallbackElapsed < 80, `fallback waited ${fallbackElapsed}ms`)
  holdA.release()
})

test('failover deadline clips sticky wait instead of waiting the full plan', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy.maxConcurrency = 1
  fs.writeFileSync(file, JSON.stringify(vm))
  const pool = scheduler(root, {
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-01', accountId: 'account-1' }),
      unbind: () => {},
    },
  })
  applyShortWaits(pool, { sticky: 200, fallback: 20 })
  const first = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conversation-deadline',
    allowWait: false,
  })
  const started = Date.now()
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conversation-deadline',
    allowWait: true,
    deadline: Date.now() + 50,
  })
  const elapsed = Date.now() - started
  assert.equal(selected.ok, false)
  assert.equal(selected.reason, 'all_accounts_busy')
  assert.ok(elapsed < 140, `deadline wait lasted ${elapsed}ms`)
  first.release()
})

test('account A wait queue full still allows selecting account B', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy.maxConcurrency = 1
  fs.writeFileSync(file, JSON.stringify(vm))
  const pool = scheduler(root)
  applyShortWaits(pool, { sticky: 400, fallback: 400 })
  pool.config.max_waiters_per_account = 1
  const first = await pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(first.ok, true)
  const waiting = pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: true,
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(pool.snapshot().waiters['account-1'], 1)
  assert.equal(pool.snapshot().waiters.total, 1)
  const other = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(other.ok, true)
  assert.equal(other.accountId, 'account-2')
  other.release()
  first.release()
  const waited = await waiting
  assert.equal(waited.ok, true)
  waited.release()
})

test('rpm window expiry rechecks instead of failing the waiter', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const resetAt = Date.now() + 40
  const pool = scheduler(root, {
    accountQuota: {
      canAccept: () => {
        if (Date.now() < resetAt) return { ok: false, reason: 'rpm_limit', detail: { reset_at: resetAt } }
        return { ok: true }
      },
      tryAcquire: () => ({ ok: true }),
    },
  })
  applyShortWaits(pool, { sticky: 400, fallback: 400 })
  const started = Date.now()
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: true,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.accountId, 'account-1')
  assert.ok(Date.now() - started >= 30)
  selected.release()
})

test('idle candidate is reserved before waiting when another account releases', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const id of ['vm-01', 'vm-02']) {
    const file = path.join(root, 'vms', `${id}.json`)
    const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    vm.policy.maxConcurrency = 1
    fs.writeFileSync(file, JSON.stringify(vm))
  }
  const pool = scheduler(root)
  applyShortWaits(pool, { sticky: 400, fallback: 400 })
  const first = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  const second = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.notEqual(first.accountId, second.accountId)
  const pending = pool.selectAndReserve({ model: 'claude-test', allowWait: true })
  setTimeout(() => second.release(), 30)
  const third = await pending
  assert.equal(third.ok, true)
  assert.equal(third.accountId, second.accountId)
  third.release()
  first.release()
})

test('account concurrency is not clamped to ready_slots', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy.maxConcurrency = 4
  fs.writeFileSync(file, JSON.stringify(vm))
  const pool = scheduler(root, {
    workerHealth: async () => busyKernelHealth(),
  })
  const held = []
  for (let i = 0; i < 4; i++) {
    const selected = await pool.selectAndReserve({
      model: 'claude-test',
      excluded: new Set(['account-2']),
      allowWait: false,
    })
    assert.equal(selected.ok, true, `reserve ${i}`)
    assert.equal(selected.waitReason, 'slot_busy')
    held.push(selected)
  }
  const fifth = await pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(fifth.ok, false)
  assert.equal(fifth.reason, 'all_accounts_busy')
  for (const item of held) item.release()
})

test('sticky slot_busy stays on the bound account', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const unbound = []
  const pool = scheduler(root, {
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-01', accountId: 'account-1' }),
      unbind: (key) => unbound.push(key),
    },
    workerHealth: async (exec) => {
      if (exec.vmId === 'vm-01') return busyKernelHealth()
      return { ok: true, ready_slots: 2, cli_pid: 8, credential: { generation: 1, has_access: true } }
    },
  })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conversation-slot',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.accountId, 'account-1')
  assert.equal(selected.selectionReason, 'sticky')
  assert.equal(selected.waitReason, 'slot_busy')
  assert.deepEqual(unbound, [])
  selected.release()
})
