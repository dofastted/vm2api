import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { translateSqliteToPg } from '../../src/lib/db/pg/sql-compat.mjs'
import { createImportCommit } from '../../src/lib/oauth/import-commit.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { startWarmup } from '../../src/lib/pool/account-warmup.mjs'
import {
  createWarmupMonitor,
  fatalCountSince,
  pinnedRpmOf,
  poolMemberVmIds,
  successCountSince,
} from '../../src/lib/pool/warmup-monitor.mjs'
import { createSchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'
import { getVm, listVms } from '../../src/lib/vm/vm-registry.mjs'
import { atomicWriteJson, withVmLock } from '../../src/lib/vm/vm-file.mjs'

function fakeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(
    `CREATE TABLE scheduler_pools (
      id TEXT PRIMARY KEY,
      name TEXT,
      enabled INTEGER DEFAULT 1,
      provider_scope TEXT DEFAULT 'mixed',
      created_at TEXT,
      updated_at TEXT
    )`,
  )
  db.exec(
    `CREATE TABLE scheduler_pool_members (
      pool_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      node_id TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    )`,
  )
  db.exec(
    `CREATE TABLE usage_logs (
      created_at TEXT NOT NULL,
      vm_id TEXT,
      status INTEGER DEFAULT 200,
      error_code TEXT,
      error_message TEXT
    )`,
  )
  return db
}

function insert(db, { at, vm = 'vm-1', status = 200, code = null, msg = null }) {
  db.prepare('INSERT INTO usage_logs (created_at, vm_id, status, error_code, error_message) VALUES (?,?,?,?,?)').run(
    at,
    vm,
    status,
    code,
    msg,
  )
}

const NOW_ISO = '2026-11-27T06:00:00.000Z'
const NOW_MS = Date.parse(NOW_ISO)

test('fatalCountSince and successCountSince use PG-compatible ISO string comparisons without datetime()', () => {
  const db = fakeDb()
  const preparedSql = []
  const origPrepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    preparedSql.push(sql)
    return origPrepare(sql)
  }

  insert(db, { at: '2026-11-27T05:00:00.000Z', code: 'upstream_auth_error' }) // in window
  insert(db, { at: '2026-11-27T04:00:00.000Z', code: 'refusal_guard' }) // in window
  insert(db, { at: '2026-11-26T20:00:00.000Z', code: 'oauth_revoked' }) // outside 6h
  insert(db, { at: '2026-11-27T05:30:00.000Z', code: 'pool_overloaded' }) // not fatal
  insert(db, { at: '2026-11-27T05:30:00.000Z', code: 'upstream_status', msg: null }) // not fatal
  insert(db, { at: '2026-11-27T05:30:00.000Z', vm: 'vm-2', code: 'refusal_guard' }) // other vm
  insert(db, { at: '2026-11-27T05:00:00.500Z', status: 200 }) // success
  insert(db, { at: '2026-11-27T05:01:00.000Z', status: 500, code: 'upstream_status' }) // failure
  insert(db, { at: '2026-11-26T10:00:00.000Z', status: 200 }) // before since

  assert.equal(fatalCountSince(db, 'vm-1', 6, NOW_MS), 2)
  assert.equal(successCountSince(db, 'vm-1', '2026-11-26T20:00:00Z'), 1)

  const queries = preparedSql.filter((sql) => sql.startsWith('SELECT'))
  assert.equal(queries.length, 2)
  for (const sql of queries) {
    assert.doesNotMatch(sql, /\bdatetime\s*\(/i)
    assert.match(sql, /created_at >= \?/)
    const translated = translateSqliteToPg(sql)
    assert.doesNotMatch(translated.sql, /\bdatetime\s*\(/i)
    assert.match(translated.sql, /created_at >= \$2/)
  }
})

test('poolMemberVmIds queries scheduler_pools and falls back to null (virtual pool) when no Claude pool exists', () => {
  const db = fakeDb()
  // Empty scheduler_pools -> null (built-in __virtual_claude__ covers all enabled Claude slots)
  assert.equal(poolMemberVmIds(db), null)

  // Only non-Claude (openai/google) custom pools -> still null for Claude slots
  db.prepare('INSERT INTO scheduler_pools (id, name, enabled, provider_scope) VALUES (?,?,?,?)').run(
    'p-codex',
    'codex',
    1,
    'openai',
  )
  assert.equal(poolMemberVmIds(db), null)

  // Custom Claude-eligible pools exist -> union only enabled claude_vm members of enabled pools
  db.prepare('INSERT INTO scheduler_pools (id, name, enabled, provider_scope) VALUES (?,?,?,?)').run(
    'p1',
    'claude-main',
    1,
    'anthropic',
  )
  db.prepare('INSERT INTO scheduler_pools (id, name, enabled, provider_scope) VALUES (?,?,?,?)').run(
    'p2',
    'claude-off',
    0,
    'mixed',
  )
  db.prepare('INSERT INTO scheduler_pool_members (pool_id, node_type, node_id, enabled) VALUES (?,?,?,?)').run(
    'p1',
    'claude_vm',
    'vm-1',
    1,
  )
  db.prepare('INSERT INTO scheduler_pool_members (pool_id, node_type, node_id, enabled) VALUES (?,?,?,?)').run(
    'p1',
    'claude_vm',
    'vm-disabled-member',
    0,
  )
  db.prepare('INSERT INTO scheduler_pool_members (pool_id, node_type, node_id, enabled) VALUES (?,?,?,?)').run(
    'p1',
    'codex_vm',
    'vm-codex',
    1,
  )
  db.prepare('INSERT INTO scheduler_pool_members (pool_id, node_type, node_id, enabled) VALUES (?,?,?,?)').run(
    'p2',
    'claude_vm',
    'vm-9',
    1,
  )
  assert.deepEqual(poolMemberVmIds(db), new Set(['vm-1']))
})

test('monitor treats enabled Claude slots as in-pool when scheduler_pools has no custom pools', async () => {
  const db = fakeDb()
  insert(db, { at: '2026-11-27T05:00:00.000Z', vm: 'vm-1' })

  const store = new Map()
  const enabledVm = { id: 'vm-1', status: 'running', schedulable: true, policy: {} }
  const disabledVm = { id: 'vm-disabled', status: 'disabled', schedulable: true, policy: {} }
  startWarmup(enabledVm, { targetRpm: 30, now: '2026-11-26T00:00:00.000Z' })
  startWarmup(disabledVm, { targetRpm: 30, now: '2026-11-26T00:00:00.000Z' })
  store.set('vm-1', enabledVm)
  store.set('vm-disabled', disabledVm)

  const monitor = createWarmupMonitor({
    config: { interval_sec: 600, min_hours: 24, min_requests: 100, fatal_window_hours: 6 },
    getDb: () => db,
    listVms: () => [{ id: 'vm-1' }, { id: 'vm-disabled' }],
    getVm: (id) => store.get(id),
    loadVm: async (id) => store.get(id),
    saveVm: async (v) => store.set(v.id, v),
    now: () => NOW_MS,
    log: () => {},
  })

  await monitor.tickNow()
  assert.equal(store.get('vm-1').policy.warmup.accumulated_minutes, 10)
  assert.equal(store.get('vm-disabled').policy.warmup.accumulated_minutes, 0)
})

test('pinnedRpmOf treats an empty flag as unpinned', () => {
  assert.equal(pinnedRpmOf({ policy: { rpmOverride: true, maxRpm: 30 } }), 30)
  assert.equal(pinnedRpmOf({ policy: { rpmOverride: true, maxRpm: 0 } }), null)
  assert.equal(pinnedRpmOf({ policy: { rpmOverride: false, maxRpm: 30 } }), null)
  assert.equal(pinnedRpmOf({}), null)
})

test('SQL errors emit structured warnings and skip graduation rather than silently succeeding', async () => {
  const brokenDb = {
    prepare() {
      throw new Error('function datetime(text) does not exist')
    },
  }
  const store = new Map()
  const vm = { id: 'vm-1', status: 'running', schedulable: true, policy: {} }
  startWarmup(vm, { targetRpm: 30, now: '2026-11-26T00:00:00.000Z' })
  vm.policy.warmup.accumulated_minutes = 60 * 24
  store.set('vm-1', vm)

  const warnings = []
  const syncCalls = []
  const monitor = createWarmupMonitor({
    config: { interval_sec: 600, min_hours: 24, min_requests: 100, fatal_window_hours: 6 },
    getDb: () => brokenDb,
    poolMemberVmIds: () => new Set(['vm-1']),
    listVms: () => [{ id: 'vm-1' }],
    getVm: (id) => store.get(id),
    loadVm: async (id) => store.get(id),
    saveVm: async (v) => store.set(v.id, v),
    syncScheduler: async (reason) => syncCalls.push(reason),
    warn: (entry) => warnings.push(entry),
    now: () => NOW_MS,
    log: () => {},
  })

  await monitor.tickNow()
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].event, 'warmup_tick_failed')
  assert.equal(warnings[0].vm_id, 'vm-1')
  assert.match(warnings[0].error, /datetime/)
  assert.equal(store.get('vm-1').policy.rpmOverride, true)
  assert.ok(store.get('vm-1').policy.warmup)
  assert.deepEqual(syncCalls, [])

  // Pool query failure also emits structured warning and skips tick
  const poolWarnings = []
  const monitor2 = createWarmupMonitor({
    config: { interval_sec: 600, min_hours: 24, min_requests: 100, fatal_window_hours: 6 },
    getDb: () => brokenDb,
    listVms: () => [{ id: 'vm-1' }],
    getVm: (id) => store.get(id),
    loadVm: async (id) => store.get(id),
    saveVm: async (v) => store.set(v.id, v),
    warn: (entry) => poolWarnings.push(entry),
    now: () => NOW_MS,
    log: () => {},
  })
  await monitor2.tickNow()
  assert.equal(poolWarnings.length, 1)
  assert.equal(poolWarnings[0].event, 'warmup_pool_query_failed')
})

test('graduation restores tier RPM via inheritVmScheduling, clears rpm_override, and syncs Rust scheduler', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-warmup-grad-e2e-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const db = openDatabase({ dataDir: path.join(root, 'data') })
  t.after(() => {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const usageDb = fakeDb()
  for (let i = 0; i < 100; i++) insert(usageDb, { at: '2026-11-27T05:00:00.000Z', vm: 'vm-pro-1' })

  const routingConfig = {
    tiers: {
      default: { max_concurrency: 2, max_rpm: 60 },
      pro: { max_concurrency: 2, max_rpm: 90 },
      max: { max_concurrency: 4, max_rpm: 180 },
    },
    concurrency: { default_max_per_account: 2, default_max_rpm: 60 },
    quota: {},
    warmup: { enabled: true, target_rpm: 30, min_hours: 24, min_requests: 100, fatal_window_hours: 6 },
  }

  const accountQuota = new AccountQuota({ db, config: routingConfig })
  accountQuota.rebindToVm('acct-pro-1', 'vm-pro-1', { email: 'pro@example.test' })
  accountQuota.setAccountTier('acct-pro-1', 'pro')
  accountQuota.setMaxRpm('acct-pro-1', 30, { override: true })

  const vmPath = path.join(root, 'vms', 'vm-pro-1.json')
  const vm = {
    id: 'vm-pro-1',
    status: 'running',
    schedulable: true,
    claude: { account_uuid: 'acct-pro-1', account_tier: 'pro', email: 'pro@example.test' },
    policy: {},
  }
  startWarmup(vm, { targetRpm: 30, baseSuccessRequests: 0, now: '2026-11-26T00:00:00.000Z' })
  vm.policy.warmup.accumulated_minutes = 60 * 24
  atomicWriteJson(vmPath, vm, { mode: 0o600 })

  const routingRt = createRoutingRuntime({
    cfg: { paths: { project: root } },
    routingConfig,
    accountQuota,
  })
  const schedulerRt = createSchedulerRuntime({
    cfg: { paths: { project: root } },
    getRoutingConfig: () => routingConfig,
    getVms: () => listVms(root),
    accountQuota,
    getDb: () => usageDb,
  })

  // Before graduation: Rust ConfigSnapshot sees pinned 30 RPM
  const beforeSnap = schedulerRt.buildConfigSnapshot({ configVersion: 1 })
  assert.equal(beforeSnap.nodes.find((n) => n.node_id === 'vm-pro-1')?.capacity?.max_rpm, 30)

  const syncReasons = []
  const monitor = createWarmupMonitor({
    config: routingConfig.warmup,
    projectRoot: root,
    getDb: () => usageDb,
    listVms: () => listVms(root),
    getVm: (id) => getVm(root, id),
    loadVm: async (id) => getVm(root, id),
    saveVm: async (v) => atomicWriteJson(path.join(root, 'vms', `${v.id}.json`), v, { mode: 0o600 }),
    inheritRpm: (id) => routingRt.inheritVmScheduling(id, { rpm: true }),
    syncScheduler: async (reason) => {
      syncReasons.push(reason)
      return { ok: true }
    },
    now: () => NOW_MS,
    log: () => {},
  })

  await monitor.tickNow()

  const persisted = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(persisted.policy.warmup, undefined)
  assert.equal(persisted.policy.rpmOverride, false)
  assert.equal(persisted.policy.maxRpm, 90) // restored tier RPM, NOT null!

  const acc = accountQuota.repo.get('acct-pro-1')
  assert.equal(acc.max_rpm, 90)
  assert.equal(acc.rpm_override, 0)

  // Because rpm_override was cleared to 0, subsequent tier RPM updates apply to the account
  accountQuota.applyTierRpm({
    default: { max_rpm: 60 },
    pro: { max_rpm: 110 },
    max: { max_rpm: 180 },
  })
  assert.equal(accountQuota.repo.get('acct-pro-1').max_rpm, 110)

  // Rust scheduler config sync was triggered and snapshot reflects inherited 90 RPM
  assert.deepEqual(syncReasons, ['warmup_graduate'])
  const afterSnap = schedulerRt.buildConfigSnapshot({ configVersion: 2 })
  assert.equal(afterSnap.nodes.find((n) => n.node_id === 'vm-pro-1')?.capacity?.max_rpm, 90)
})

test('setMaxRpmForVm clears rpm_override when override is false', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-warmup-rpm-clear-'))
  const db = openDatabase({ dataDir: path.join(root, 'data') })
  t.after(() => {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const quota = new AccountQuota({ db })
  quota.rebindToVm('acct-1', 'vm-1')
  quota.setMaxRpmForVm('vm-1', 30, { override: true })
  assert.equal(quota.repo.get('acct-1').rpm_override, 1)

  quota.setMaxRpmForVm('vm-1', 90, { override: false })
  assert.equal(quota.repo.get('acct-1').max_rpm, 90)
  assert.equal(quota.repo.get('acct-1').rpm_override, 0)
})

test('monitor tick accumulates time and exits when operator clears pin', async () => {
  const db = fakeDb()
  insert(db, { at: '2026-11-27T05:00:00.000Z' })

  const store = new Map()
  const vm = { id: 'vm-1', status: 'running', schedulable: true, policy: {} }
  startWarmup(vm, { targetRpm: 30, now: '2026-11-26T00:00:00.000Z' })
  store.set('vm-1', vm)

  const monitor = createWarmupMonitor({
    config: { interval_sec: 600, min_hours: 24, min_requests: 100, fatal_window_hours: 6 },
    getDb: () => db,
    poolMemberVmIds: () => new Set(['vm-1']),
    listVms: () => [{ id: 'vm-1' }],
    getVm: (id) => store.get(id),
    loadVm: async (id) => store.get(id),
    saveVm: async (v) => store.set(v.id, v),
    now: () => NOW_MS,
    log: () => {},
  })
  await monitor.tickNow()
  assert.equal(store.get('vm-1').policy.warmup.accumulated_minutes, 10)

  // Operator clears pin -> exits warm-up
  store.get('vm-1').policy.rpmOverride = false
  store.get('vm-1').policy.maxRpm = 0
  await monitor.tickNow()
  assert.equal(store.get('vm-1').policy.warmup, undefined)
})

test('monitor setConfig recreates interval timer when interval_sec changes', (t) => {
  const origSetInterval = globalThis.setInterval
  const origClearInterval = globalThis.clearInterval
  const scheduled = []
  const cleared = []
  let nextId = 1
  globalThis.setInterval = (_fn, ms) => {
    const handle = { id: nextId++, ms, unref() {} }
    scheduled.push(handle)
    return handle
  }
  globalThis.clearInterval = (handle) => {
    cleared.push(handle)
  }
  t.after(() => {
    globalThis.setInterval = origSetInterval
    globalThis.clearInterval = origClearInterval
  })

  const monitor = createWarmupMonitor({
    config: { interval_sec: 600 },
    listVms: () => [],
    log: () => {},
  })
  const started = monitor.start()
  assert.equal(started.started, true)
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].ms, 600_000)

  // Same interval_sec -> no timer reset
  monitor.setConfig({ enabled: true, interval_sec: 600 })
  assert.equal(scheduled.length, 1)
  assert.equal(cleared.length, 0)

  // Changed interval_sec -> clears old timer and schedules new interval
  monitor.setConfig({ enabled: true, interval_sec: 120 })
  assert.equal(cleared.length, 1)
  assert.equal(cleared[0], scheduled[0])
  assert.equal(scheduled.length, 2)
  assert.equal(scheduled[1].ms, 120_000)

  monitor.stop()
  assert.equal(cleared.length, 2)
})

test('import-commit warmup respects opt-in default, restarts on swap, preserves same-account refresh, and syncs Rust scheduler after rebind', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-warmup-import-'))
  const priorMock = process.env.KIN_CRS_MOCK
  process.env.KIN_CRS_MOCK = '1'
  const db = openDatabase({ dataDir: path.join(root, 'data') })
  t.after(() => {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
    if (priorMock === undefined) delete process.env.KIN_CRS_MOCK
    else process.env.KIN_CRS_MOCK = priorMock
  })

  const vmId = 'vm-import-1'
  const vmPath = path.join(root, 'vms', `${vmId}.json`)
  fs.mkdirSync(path.join(root, 'vms', vmId, 'cli-home'), { recursive: true })
  const existing = { id: vmId, status: 'running', dataplane: 'crag', policy: {} }
  fs.writeFileSync(vmPath, JSON.stringify(existing))

  const accountQuota = new AccountQuota({ db })
  const callOrder = []
  const origRebind = accountQuota.rebindToVm.bind(accountQuota)
  accountQuota.rebindToVm = (...args) => {
    callOrder.push(['rebindToVm', args[0], args[1]])
    return origRebind(...args)
  }
  const origSetMaxRpm = accountQuota.setMaxRpm.bind(accountQuota)
  accountQuota.setMaxRpm = (...args) => {
    callOrder.push(['setMaxRpm', args[0], args[1], args[2]])
    return origSetMaxRpm(...args)
  }

  const syncCalls = []
  let routingConfig = {}
  const { commitImportedOauth } = createImportCommit({
    cfg: { paths: { project: root } },
    getRoutingConfig: () => routingConfig,
    accountQuota,
    getSchedulerRuntime: () => ({
      syncConfigNow: async (reason) => {
        syncCalls.push(reason)
        return { ok: true }
      },
    }),
  })

  const makeGrant = (uuid, email) => ({
    access_token: `at-${uuid}`,
    refresh_token: `rt-${uuid}`,
    expires_in: 3600,
    email,
    account_uuid: uuid,
    org_uuid: `org-${uuid}`,
  })

  // 1. Opt-in default (routing.warmup omitted -> enabled: false): no warmup, no pin, no warmup_start sync
  let res = await commitImportedOauth({
    vmId,
    vmPath,
    existing,
    oauth: makeGrant('acct-0', 'zero@example.test'),
    skipOfficialCc: true,
    fromNativeLogin: true,
  })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(JSON.parse(fs.readFileSync(vmPath, 'utf8')).policy?.warmup, undefined)
  assert.deepEqual(syncCalls, [])

  // 2. Enable warmup -> swapping to acct-1 starts warmup, rebinds BEFORE pinning acct-1, and syncs Rust scheduler
  routingConfig = { warmup: { enabled: true, target_rpm: 30 } }
  callOrder.length = 0
  res = await commitImportedOauth({
    vmId,
    vmPath,
    existing,
    oauth: makeGrant('acct-1', 'one@example.test'),
    skipOfficialCc: true,
    fromNativeLogin: true,
  })
  assert.equal(res.ok, true)
  let saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(saved.policy.warmup.target_rpm, 30)
  assert.equal(saved.policy.warmup.events[0].kind, 'start')
  assert.equal(saved.policy.maxRpm, 30)
  assert.equal(saved.policy.rpmOverride, true)
  assert.deepEqual(callOrder, [
    ['rebindToVm', 'acct-1', vmId],
    ['setMaxRpm', 'acct-1', 30, { override: true }],
  ])
  assert.equal(accountQuota.repo.get(vmId), null) // no ghost account_id=vmId row
  assert.equal(accountQuota.repo.get('acct-1').max_rpm, 30)
  assert.equal(accountQuota.repo.get('acct-1').rpm_override, 1)
  assert.deepEqual(syncCalls, ['warmup_start'])

  // Advance accumulated_minutes to simulate an in-flight warm-up
  await withVmLock(vmPath, () => {
    const rec = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    rec.policy.warmup.accumulated_minutes = 600
    atomicWriteJson(vmPath, rec, { mode: 0o600 })
    Object.assign(existing, rec)
  })

  // 3. Same-account credential refresh (acct-1 -> acct-1) preserves in-flight progress
  syncCalls.length = 0
  res = await commitImportedOauth({
    vmId,
    vmPath,
    existing,
    oauth: makeGrant('acct-1', 'one@example.test'),
    skipOfficialCc: true,
    fromNativeLogin: true,
  })
  assert.equal(res.ok, true)
  saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(saved.policy.warmup.accumulated_minutes, 600)
  assert.deepEqual(syncCalls, [])

  // 4. Account swap while warming (acct-1 -> acct-2) MUST restart warmup and pin acct-2
  callOrder.length = 0
  res = await commitImportedOauth({
    vmId,
    vmPath,
    existing,
    oauth: makeGrant('acct-2', 'two@example.test'),
    skipOfficialCc: true,
    fromNativeLogin: true,
  })
  assert.equal(res.ok, true)
  saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(saved.policy.warmup.accumulated_minutes, 0)
  assert.equal(saved.policy.warmup.events.at(-1).kind, 'restart')
  assert.deepEqual(callOrder, [
    ['rebindToVm', 'acct-2', vmId],
    ['setMaxRpm', 'acct-2', 30, { override: true }],
  ])
  assert.equal(accountQuota.repo.get('acct-2').max_rpm, 30)
  assert.equal(accountQuota.repo.get('acct-2').rpm_override, 1)
  assert.deepEqual(syncCalls, ['warmup_start'])
})

test('routing patch hot-reloads warmupMonitor and failed panel routing rollback restores it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-warmup-routing-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const routingFile = path.join(root, 'routing.json')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const seenConfigs = []
  const warmupMonitor = {
    setConfig(cfg) {
      seenConfigs.push(cfg)
    },
  }
  const routingConfig = {
    warmup: { enabled: false, target_rpm: 30, interval_sec: 600 },
    concurrency: {},
    tiers: {},
  }
  fs.writeFileSync(routingFile, JSON.stringify(routingConfig))

  const runtime = createRoutingRuntime({
    cfg: { paths: { project: root } },
    routingConfigPath: routingFile,
    routingConfig,
    warmupMonitor,
    stickyRouter: { reloadConfig() {} },
    accountQuota: {
      reloadConfig() {},
      applyTierConcurrency() {},
      applyTierRpm() {},
      repo: { get: () => null },
    },
    requestLog: { setConfig() {} },
  })

  await runtime.persistRoutingPatch({ warmup: { enabled: true, target_rpm: 45, interval_sec: 120 } })
  assert.equal(seenConfigs.length, 1)
  assert.equal(seenConfigs[0].enabled, true)
  assert.equal(seenConfigs[0].target_rpm, 45)
  assert.equal(seenConfigs[0].interval_sec, 120)

  // Rollback via panel-routes restoreRoutingRuntime restores previous warmup config
  seenConfigs.length = 0
  const response = {}
  const ctx = {
    cfg: { paths: { project: root }, limits: { max_body_bytes: 1024 * 1024 } },
    routingConfig: structuredClone(routingConfig),
    warmupMonitor,
    stickyRouter: { reloadConfig() {}, stats: () => ({}) },
    accountQuota: { reloadConfig() {} },
    requestLog: { setConfig() {} },
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => ({ warmup: { enabled: false, target_rpm: 15 } }),
    persistRoutingPatch: async () => {
      throw Object.assign(new Error('disk full'), { status: 503, code: 'routing_persist_failed' })
    },
  }
  const handlePanel = createPanelHandler(ctx)
  await handlePanel({ method: 'PUT' }, {}, new URL('http://localhost/api/panel/routing'))
  assert.equal(response.status, 503)
  assert.equal(seenConfigs.length, 1)
  assert.equal(seenConfigs[0].enabled, true)
  assert.equal(seenConfigs[0].target_rpm, 45)
})
