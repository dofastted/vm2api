import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PoolScheduler,
  quotaGuardConfigOf,
  quotaGuardLevel,
  quotaGuardUsage,
} from '../../src/lib/pool/pool-scheduler.mjs'
import { classifyUpstreamResult } from '../../src/lib/pool/upstream-error-policy.mjs'
import { RateLimitService } from '../../src/lib/pool/rate-limit-service.mjs'
import { adoptProviderResponseHeaders } from '../../src/lib/pool/failover-runner.mjs'

const HOUR = 3600_000
const on = quotaGuardConfigOf({ exhaustion_guard: true })
const off = quotaGuardConfigOf({})

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-quota-guard-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms, { recursive: true })
  for (const [id, accountId, port] of [
    ['vm-01', 'account-1', 10001],
    ['vm-02', 'account-2', 10002],
  ]) {
    const vm = {
      id,
      name: id,
      status: 'running',
      schedulable: true,
      proxy_cli_enabled: true,
      proxy: { id: `proxy-${id}`, url: `socks5h://127.0.0.1:${port}` },
      runtime: { worker_socket: path.join(vms, id, 'run', 'worker.sock') },
      // vm-01 outranks vm-02, so only the guard moves a new conversation off it.
      policy: { maxConcurrency: 2, concurrencyOverride: true, weight: 1, priority: id === 'vm-01' ? 10 : 0 },
      claude: {
        account_uuid: accountId,
        account_tier: 'pro',
        access_token: `access-${accountId}`,
        refresh_token: `refresh-${accountId}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }
    fs.writeFileSync(path.join(vms, `${id}.json`), JSON.stringify(vm))
  }
  return root
}

function poolWith(root, unifiedByAccount, { guard = true, sticky = null } = {}) {
  const accounts = new Map(
    Object.entries(unifiedByAccount).map(([id, unified]) => [id, { account_id: id, status: 'active', unified }]),
  )
  const runtimeRepo = {
    states: new Map(),
    get: (id) => runtimeRepo.states.get(id) || null,
    clearExpired() {},
    upsert(state) {
      runtimeRepo.states.set(state.account_id, state)
      return state
    },
    writeHeartbeat() {},
    schedulingSnapshot: (ids) => new Map(ids.map((id) => [id, { state: null, account: accounts.get(id) || null }])),
  }
  return new PoolScheduler({
    projectRoot: root,
    runtimeRepo,
    stickyRouter: sticky ? { resolve: (key) => (key === sticky.key ? sticky.bound : null) } : null,
    // Production shape: the legacy 5h/7d gates are off (safety 1, block_on_* false).
    accountQuota: {
      config: {
        safety_ratio: 1,
        weekly_safety_ratio: 1,
        block_on_5h: false,
        block_on_7d: false,
        exhaustion_guard: guard,
      },
      policyFor: () => ({ limit_5h: 1, limit_7d: 1 }),
      canAccept: () => ({ ok: true }),
    },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5 },
  })
}

const at = (ratio, extra = {}) => ({
  headers: { '5h': { utilization: ratio, status: 'allowed', reset: new Date(Date.now() + 2 * HOUR).toISOString() } },
  ...extra,
})

test('guard reads the worse of the header sample and the official /usage sample', () => {
  const now = Date.now()
  const reset = new Date(now + 2 * HOUR).toISOString()
  const unified = {
    headers: { '5h': { utilization: 0.97, status: 'allowed_warning', reset } },
    official: { '5h': { utilization: 1, status: 'rejected', reset } },
  }
  const usage = quotaGuardUsage(unified, now)
  assert.equal(usage.ratio, 1)
  assert.equal(usage.rejected, true)
  assert.equal(quotaGuardLevel(unified, off, now).level, 'stop')
})

test('switch off: only a rejected window stops; switch on: 85% continuing, 95% stop', () => {
  const now = Date.now()
  assert.equal(quotaGuardLevel(at(0.9), off, now).level, 'open')
  assert.equal(quotaGuardLevel(at(0.84), on, now).level, 'open')
  assert.equal(quotaGuardLevel(at(0.85), on, now).level, 'continuing')
  assert.equal(quotaGuardLevel(at(0.95), on, now).level, 'stop')
  const weekly = {
    headers: { '7d': { utilization: 96, status: 'allowed', reset: new Date(now + 48 * HOUR).toISOString() } },
  }
  assert.equal(quotaGuardLevel(weekly, on, now).level, 'stop')
})

test('elapsed windows and open extra usage do not stop the account', () => {
  const now = Date.now()
  const elapsed = {
    headers: { '5h': { utilization: 1, status: 'rejected', reset: new Date(now - 1000).toISOString() } },
  }
  assert.equal(quotaGuardLevel(elapsed, on, now).level, 'open')
  const reset = new Date(now + HOUR).toISOString()
  const overage = { overage_status: 'allowed', headers: { '5h': { utilization: 1, status: 'rejected', reset } } }
  assert.equal(quotaGuardLevel(overage, off, now).level, 'open')
  assert.equal(quotaGuardLevel(overage, on, now).level, 'stop')
})

test('thresholds come from quota config and new-session never exceeds stop', () => {
  assert.deepEqual(
    quotaGuardConfigOf({ exhaustion_guard: true, exhaustion_guard_new_session: 0.9, exhaustion_guard_stop: 0.8 }),
    {
      enabled: true,
      new_session_ratio: 0.8,
      stop_ratio: 0.8,
    },
  )
})

test('in the new-session band a new conversation goes elsewhere, a pinned one stays', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fresh = poolWith(root, { 'account-1': at(0.9), 'account-2': at(0.1) })
  const picked = await fresh.selectAndReserve({ model: 'claude-test', allowWait: false, excluded: new Set() })
  assert.equal(picked.accountId, 'account-2')
  picked.release()

  const pinned = poolWith(
    root,
    { 'account-1': at(0.9), 'account-2': at(0.1) },
    {
      sticky: { key: 'conv-1', bound: { vmId: 'vm-01', accountId: 'account-1' } },
    },
  )
  const kept = await pinned.selectAndReserve({ model: 'claude-test', stickyKey: 'conv-1', allowWait: false })
  assert.equal(kept.accountId, 'account-1')
  assert.equal(kept.selectionReason, 'sticky')
  kept.release()
})

test('past the stop line even a pinned conversation leaves; all stopped is a 429 with the reset', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = poolWith(
    root,
    { 'account-1': at(0.96), 'account-2': at(0.1) },
    {
      sticky: { key: 'conv-1', bound: { vmId: 'vm-01', accountId: 'account-1' } },
    },
  )
  const moved = await pool.selectAndReserve({ model: 'claude-test', stickyKey: 'conv-1', allowWait: false })
  assert.equal(moved.accountId, 'account-2')
  moved.release()

  const dead = poolWith(root, { 'account-1': at(0.96), 'account-2': at(0.99) })
  const none = await dead.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(none.ok, false)
  assert.equal(none.reason, 'pool_rate_limited')
})

test('switch off keeps the old behaviour below a rejected window', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = poolWith(root, { 'account-1': at(0.97), 'account-2': at(0.98) }, { guard: false })
  const picked = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(picked.ok, true)
  picked.release()
})

test('a long Retry-After alone does not prove a plan window; the hop adopts provider headers', () => {
  const now = Date.now()
  const result = adoptProviderResponseHeaders({
    ok: false,
    status: 429,
    terminalState: 'incomplete',
    headers: null,
    body: {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: "This request would exceed your account's rate limit. Please try again later.",
      },
    },
    providerResult: { response_headers: { 'retry-after': '7547', 'request-id': 'req_x' } },
  })
  assert.equal(result.headers['retry-after'], '7547')
  const policy = classifyUpstreamResult(result, { now, model: 'claude-sonnet-test' })
  assert.equal(policy.reason, 'rate_limited_unknown')
})

test('every upstream 429 asks the usage probe, at most once per account per 180s', () => {
  const asked = []
  const service = new RateLimitService({
    runtimeRepo: { updateWindow() {}, updateOverload() {} },
    onUsageProbe: ({ accountId }) => asked.push(accountId),
  })
  const r429 = { ok: false, status: 429, headers: {}, body: { error: { type: 'rate_limit_error', message: 'Error' } } }
  const t0 = 1_000_000
  for (const reason of ['rate_limited_unknown', 'rpm_limited', 'sonnet_rate_limited', 'rate_limited_request']) {
    service.handleUpstreamError({
      accountId: 'a1',
      vmId: 'vm-01',
      result: r429,
      policy: { scope: 'account', reason },
      now: t0,
    })
  }
  assert.deepEqual(asked, ['a1'])
  service.handleUpstreamError({
    accountId: 'a2',
    vmId: 'vm-02',
    result: r429,
    policy: { scope: 'model', reason: 'sonnet_rate_limited' },
    now: t0,
  })
  assert.deepEqual(asked, ['a1', 'a2'])
  service.handleUpstreamError({
    accountId: 'a1',
    vmId: 'vm-01',
    result: r429,
    policy: { scope: 'account', reason: 'rate_limited_unknown' },
    now: t0 + 179_000,
  })
  assert.equal(asked.length, 2)
  service.handleUpstreamError({
    accountId: 'a1',
    vmId: 'vm-01',
    result: r429,
    policy: { scope: 'account', reason: 'rate_limited_unknown' },
    now: t0 + 180_000,
  })
  assert.deepEqual(asked, ['a1', 'a2', 'a1'])
  service.handleUpstreamError({
    accountId: 'a3',
    vmId: 'vm-03',
    result: { ok: false, status: 500 },
    policy: { scope: 'account', reason: 'x' },
    now: t0,
  })
  assert.equal(asked.includes('a3'), false)
})

test('a short Retry-After 429 stays an unproven bare 429', () => {
  const now = Date.now()
  const policy = classifyUpstreamResult(
    {
      ok: false,
      status: 429,
      headers: { 'retry-after': '20' },
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'Error' } },
    },
    { now, model: 'claude-sonnet-test' },
  )
  assert.equal(policy.reason, 'rate_limited_unknown')
})

test('the hop keeps its own headers over provider ones', () => {
  const result = adoptProviderResponseHeaders({
    ok: false,
    headers: { 'Retry-After': '5' },
    providerResult: { response_headers: { 'retry-after': '7547', 'request-id': 'req_x' } },
  })
  assert.equal(result.headers['Retry-After'], '5')
  assert.equal(result.headers['retry-after'], undefined)
  assert.equal(result.headers['request-id'], 'req_x')
})

test('seat path: a new seat avoids the band, a session pinned there keeps its seat', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fresh = poolWith(root, { 'account-1': at(0.9), 'account-2': at(0.1) })
  const picked = await fresh.selectAndReserve({ model: 'claude-test', seatKey: 'seat-new', allowWait: false })
  assert.equal(picked.accountId, 'account-2')
  picked.release()

  const pinned = poolWith(
    root,
    { 'account-1': at(0.9), 'account-2': at(0.1) },
    {
      sticky: { key: 'conv-1', bound: { vmId: 'vm-01', accountId: 'account-1' } },
    },
  )
  const kept = await pinned.selectAndReserve({
    model: 'claude-test',
    seatKey: 'seat-old',
    stickyKey: 'conv-1',
    allowWait: false,
  })
  assert.equal(kept.accountId, 'account-1')
  kept.release()
})

test('without the switch the same pool still sends a new conversation to the 90% account', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const seatKey of [null, 'seat-new']) {
    const pool = poolWith(root, { 'account-1': at(0.9), 'account-2': at(0.1) }, { guard: false })
    const picked = await pool.selectAndReserve({
      model: 'claude-test',
      allowWait: false,
      ...(seatKey ? { seatKey } : {}),
    })
    assert.equal(picked.accountId, 'account-1')
    picked.release()
  }
})
