import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  createWarmupMonitor,
  fatalCountSince,
  pinnedRpmOf,
  poolMemberVmIds,
  successCountSince,
} from '../../src/lib/pool/warmup-monitor.mjs'
import { startWarmup } from '../../src/lib/pool/account-warmup.mjs'

function fakeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE vm_pools (id TEXT PRIMARY KEY, name TEXT, enabled INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT)`)
  db.exec(`CREATE TABLE vm_pool_members (pool_id TEXT, vm_id TEXT, created_at TEXT)`)
  db.exec(`CREATE TABLE usage_logs (created_at TEXT, vm_id TEXT, status INTEGER DEFAULT 200, error_code TEXT, error_message TEXT)`)
  return db
}

function insert(db, { at, vm = 'vm-1', status = 200, code = null, msg = null }) {
  db.prepare('INSERT INTO usage_logs (created_at, vm_id, status, error_code, error_message) VALUES (?,?,?,?,?)')
    .run(at, vm, status, code, msg)
}

const NOW_ISO = '2026-11-27T06:00:00Z'
const NOW_MS = Date.parse(NOW_ISO)

test('fatalCountSince counts fatal classes inside the window only', () => {
  const db = fakeDb()
  insert(db, { at: '2026-11-27 05:00:00', code: 'upstream_auth_error' })          // in window
  insert(db, { at: '2026-11-27 04:00:00', code: 'refusal_guard' })                // in window
  insert(db, { at: '2026-11-26 20:00:00', code: 'oauth_revoked' })                // outside 6h
  insert(db, { at: '2026-11-27 05:30:00', code: 'pool_overloaded' })              // not fatal
  insert(db, { at: '2026-11-27 05:30:00', code: 'upstream_status', msg: null })   // not fatal
  insert(db, { at: '2026-11-27 05:30:00', vm: 'vm-2', code: 'refusal_guard' })    // other vm
  assert.equal(fatalCountSince(db, 'vm-1', 6, NOW_MS), 2)
})

test('successCountSince uses the success predicate', () => {
  const db = fakeDb()
  insert(db, { at: '2026-11-27 05:00:00' })
  insert(db, { at: '2026-11-27 05:01:00', status: 500, code: 'upstream_status' }) // failure
  insert(db, { at: '2026-11-26 10:00:00' })                                       // before since
  assert.equal(successCountSince(db, 'vm-1', '2026-11-26T20:00:00Z'.replace('T', ' ').slice(0, 19)), 1)
})

test('poolMemberVmIds unions enabled pools', () => {
  const db = fakeDb()
  db.prepare('INSERT INTO vm_pools (id, name) VALUES (?,?)').run('p1', 'one')
  db.prepare('INSERT INTO vm_pools (id, name, enabled) VALUES (?,?,0)').run('p2', 'two')
  db.prepare('INSERT INTO vm_pool_members (pool_id, vm_id) VALUES (?,?)').run('p1', 'vm-1')
  db.prepare('INSERT INTO vm_pool_members (pool_id, vm_id) VALUES (?,?)').run('p2', 'vm-9')
  assert.deepEqual(poolMemberVmIds(db), new Set(['vm-1']))
})

test('pinnedRpmOf treats an empty flag as unpinned', () => {
  assert.equal(pinnedRpmOf({ policy: { rpmOverride: true, maxRpm: 30 } }), 30)
  assert.equal(pinnedRpmOf({ policy: { rpmOverride: true, maxRpm: 0 } }), null)
  assert.equal(pinnedRpmOf({ policy: { rpmOverride: false, maxRpm: 30 } }), null)
  assert.equal(pinnedRpmOf({}), null)
})

test('monitor tick graduates a ready slot and mirrors the pin', async () => {
  const db = fakeDb()
  for (let i = 0; i < 100; i++) insert(db, { at: '2026-11-27 05:00:00' })

  const store = new Map()
  const vm = { id: 'vm-1', schedulable: true, policy: {} }
  startWarmup(vm, { targetRpm: 30, baseSuccessRequests: 0, now: '2026-11-26T00:00:00Z' })
  vm.policy.warmup.accumulated_minutes = 60 * 24
  store.set('vm-1', vm)

  const pins = []
  const monitor = createWarmupMonitor({
    config: { interval_sec: 600, min_hours: 24, min_requests: 100, fatal_window_hours: 6 },
    getDb: () => db,
    poolMemberVmIds: () => new Set(['vm-1']),
    listVms: () => [{ id: 'vm-1' }],
    getVm: (id) => store.get(id),
    loadVm: async (id) => store.get(id),
    saveVm: async (v) => store.set(v.id, v),
    setPin: (id, n, o) => pins.push([id, n, o]),
    now: () => NOW_MS,
    log: () => {},
  })
  await monitor.tickNow()

  assert.equal(store.get('vm-1').policy.rpmOverride, false)
  assert.equal(store.get('vm-1').policy.maxRpm, null)
  assert.equal(store.get('vm-1').policy.warmup, undefined)
  assert.deepEqual(pins, [['vm-1', 0, { override: false }]])
})

test('monitor tick accumulates time for an in-flight slot', async () => {
  const db = fakeDb()
  insert(db, { at: '2026-11-27 05:00:00' })

  const store = new Map()
  const vm = { id: 'vm-1', schedulable: true, policy: {} }
  startWarmup(vm, { targetRpm: 30, now: '2026-11-26T00:00:00Z' })
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
})

test('monitor tick exits when the operator cleared the pin', async () => {
  const db = fakeDb()
  const store = new Map()
  const vm = { id: 'vm-1', schedulable: true, policy: {} }
  startWarmup(vm, { targetRpm: 30, now: '2026-11-26T00:00:00Z' })
  // operator cleared the pin after warm-up started
  vm.policy.rpmOverride = false
  vm.policy.maxRpm = null
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
  assert.equal(store.get('vm-1').policy.warmup, undefined)
})
