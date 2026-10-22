import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb, getActivityCoordinator } from '../../src/lib/db/database.mjs'
import { withDatabaseActivities } from '../maintenance-fixture.mjs'
import { SharedRoutingConfig } from '../../src/lib/admin/shared-routing-config.mjs'
import { RoutingConfigRepo } from '../../src/lib/db/repos/routing-config-repo.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { initVmDbSync, startVmWatch, stopVmWatch, pauseVmDbSync } from '../../src/lib/vm/vm-db-sync.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'

async function fixture(t) {
  const db = getDb()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-maintenance-producers-'))
  await withDatabaseActivities([db], () => Promise.resolve())
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { db, root, coordinator: getActivityCoordinator(db) }
}

function intervals(t, start) {
  let callback
  const mock = t.mock.method(globalThis, 'setInterval', (fn) => {
    callback = fn
    return { unref() {} }
  })
  try {
    start()
  } finally {
    mock.mock.restore()
  }
  assert.equal(typeof callback, 'function')
  return callback
}

test('routing polling refreshes PostgreSQL after its startup activity has closed', async (t) => {
  const fx = await fixture(t)
  const file = path.join(fx.root, 'routing.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1 }))
  const applied = []
  const state = new SharedRoutingConfig({
    db: fx.db,
    file,
    normalize: (x) => x,
    merge: (a, b) => ({ ...a, ...b }),
    apply: (x) => applied.push(x.version),
  })
  await withDatabaseActivities([fx.db], () => state.init())
  const peer = await createRepositoryTestDatabase({ connectionString: fx.db.connectionString, schema: fx.db.schema })
  t.after(() => peer.close())
  await new RoutingConfigRepo(peer).patch(() => ({ version: 2 }))
  const tick = intervals(t, () => state.start())
  t.after(() => state.stop())
  tick()
  await state.refreshing
  assert.equal(state.lastError, undefined)
  assert.deepEqual(applied, [1, 2])
})

test('request-log cleanup enters a new activity instead of inheriting a closed startup scope', async (t) => {
  const fx = await fixture(t)
  const log = new RequestLogStore({ db: fx.db, dataDir: fx.root })
  let cleaned = 0
  log.repo.cleanup = async () => {
    await fx.db.query('SELECT 1')
    cleaned++
  }
  const tick = intervals(t, () => log.startCleanupScheduler())
  t.after(() => log.stopCleanupScheduler())
  tick()
  await log.flush()
  assert.equal(cleaned, 1)
})

test('each scheduled proxy probe receives its own live activity', async (t) => {
  const fx = await fixture(t)
  const pool = new ProxyPool({ db: fx.db })
  let probes = 0
  pool.probeAll = async () => {
    await fx.db.query('SELECT 1')
    probes++
    return { ok: true }
  }
  const tick = intervals(t, () => pool.startScheduler())
  t.after(() => pool.stopScheduler())
  await pool.flush()
  await tick()
  await pool.flush()
  assert.equal(probes, 2)
})

test('a draining maintenance operation prevents scheduled proxy probes from starting', async (t) => {
  const fx = await fixture(t)
  const operation = await fx.coordinator.beginMaintenance({ kind: 'backup' })
  const pool = new ProxyPool({ db: fx.db })
  let probes = 0
  pool.probeAll = async () => {
    probes++
    return { ok: true }
  }
  try {
    const tick = intervals(t, () => pool.startScheduler())
    await assert.rejects(pool.flush(), { code: 'database_maintenance' })
    await tick()
    await pool.flush()
    assert.equal(probes, 0)
  } finally {
    pool.stopScheduler()
    await operation.close()
    await fx.coordinator.cancelDrain(operation.operationId)
  }
})

test('a failed scheduled proxy probe retains an uncertain activity', async (t) => {
  const fx = await fixture(t)
  const pool = new ProxyPool({ db: fx.db })
  pool.probeAll = async () => {
    await fx.db.query('SELECT 1')
    throw new Error('synthetic probe termination unknown')
  }
  intervals(t, () => pool.startScheduler())
  t.after(() => pool.stopScheduler())
  await assert.rejects(pool.flush(), /synthetic probe termination unknown/)
  const rows = (
    await fx.db.pool.query(
      `SELECT completed_at, uncertain_at FROM ${fx.coordinator.qualified}.activities WHERE kind='proxy_probe'`,
    )
  ).rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].completed_at, null)
  assert.ok(rows[0].uncertain_at)
})

test('file-watcher reconciliation can persist after initialization scope closes', async (t) => {
  const fx = await fixture(t)
  fs.mkdirSync(path.join(fx.root, 'vms'))
  const file = path.join(fx.root, 'vms/vm-watch.json')
  fs.writeFileSync(file, JSON.stringify({ id: 'vm-watch', note: 'before' }))
  await withDatabaseActivities([fx.db], () => initVmDbSync(fx.root, { watch: false }))
  let changed
  const watcher = t.mock.method(fs, 'watch', (_dir, callback) => {
    changed = callback
    return { close() {} }
  })
  try {
    assert.equal(startVmWatch(fx.root), true)
  } finally {
    watcher.mock.restore()
  }
  t.after(async () => {
    stopVmWatch()
    await pauseVmDbSync()
  })
  fs.writeFileSync(file, JSON.stringify({ id: 'vm-watch', note: 'after' }))
  let tick
  const timer = t.mock.method(globalThis, 'setTimeout', (callback) => {
    tick = callback
    return { unref() {} }
  })
  try {
    changed()
  } finally {
    timer.mock.restore()
  }
  await tick()
  const row = await withDatabaseActivities([fx.db], () => new VmsRepo(fx.db).get('vm-watch'))
  assert.equal(row.vm.note, 'after')
})
