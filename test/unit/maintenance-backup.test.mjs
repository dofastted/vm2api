import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { AsyncResource } from 'node:async_hooks'
import { getDb, registerActivityCoordinator, quoteIdentifier } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { BackupService } from '../../src/lib/admin/backup-service.mjs'
import { VmTestScheduleRunner } from '../../src/lib/admin/vm-test-schedule.mjs'
import { SharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'

async function fixture(t) {
  const db = getDb()
  const coordinator = new GlobalMaintenanceCoordinator(db)
  await coordinator.start()
  await coordinator.acknowledgeEpoch(1)
  registerActivityCoordinator(db, coordinator)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-backup-'))
  const service = new BackupService({ dataDir: path.join(root, 'data'), projectRoot: root, sharedTasks: null })
  service._runBackupWorker = async (job, _database, copied) => {
    await copied()
    return { id: job.id, created_at: job.createdAt, kind: job.kind, status: 'ok' }
  }
  t.after(async () => {
    await coordinator.stop().catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
    const cleanup = new pg.Client({ connectionString: db.connectionString })
    await cleanup.connect()
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinator.schema)} CASCADE`)
    } finally {
      await cleanup.end()
    }
  })
  return { db, coordinator, service, q: quoteIdentifier(coordinator.schema) }
}

test('BackupService forwards exact maintenance ownership to local drain and retains the HTTP scope for response writes', async (t) => {
  const { db, coordinator, service, q } = await fixture(t)
  const request = await coordinator.admit({ kind: 'http' })
  const observed = []
  service.onMaintenance(async (enabled, _reason, context) => {
    if (enabled) {
      assert.equal(context?.operation?.sourceActivityId, request.activityId)
      observed.push(context.operation.operationId)
      await db.query('SELECT 1')
    }
  })
  const record = await request.run(() => service.createBackup())
  assert.equal(record.status, 'ok')
  assert.equal(observed.length, 1)
  const operation = (await db.pool.query(`SELECT ended_at FROM ${q}.operations WHERE id=$1`, [observed[0]])).rows[0]
  assert.ok(operation.ended_at)
  await request.run(() => db.query('SELECT 1'))
  await request.complete({ ended: true })
})

test('BackupService scheduled checks finish their read activity before claiming a private maintenance operation', async (t) => {
  const { db, coordinator, service, q } = await fixture(t)
  const result = await service.runScheduled()
  assert.equal(result.status, 'ok')
  assert.equal(
    (await db.pool.query("SELECT count(*) AS n FROM background_task_runs WHERE task_key='scheduled-backup'")).rows[0].n,
    0,
  )
  assert.equal(
    (
      await db.pool.query(
        `SELECT count(*) AS n FROM ${q}.operations WHERE task_key='scheduled-backup' AND ended_at IS NOT NULL`,
      )
    ).rows[0].n,
    1,
  )
  assert.equal(await coordinator.isReady(), true)
})

async function discoveryTimer(t, db) {
  const schedule = new VmTestScheduleRunner({
    projectRoot: '/missing-maintenance-fixture',
    list: () => [],
    sharedTasks: new SharedBackgroundTasks(db),
  })
  let callback
  const timer = t.mock.method(globalThis, 'setInterval', (fn) => {
    callback = fn
    return { unref() {} }
  })
  try {
    await schedule.start()
  } finally {
    timer.mock.restore()
  }
  const context = new AsyncResource('maintenance-discovery-timer')
  t.after(async () => {
    await schedule.stop()
    context.emitDestroy()
  })
  return { schedule, tick: () => context.runInAsyncScope(callback) }
}

test('a scheduled backup drains when periodic discovery is refused before starting in DRAINING', async (t) => {
  const { db, coordinator, service } = await fixture(t)
  const { schedule, tick } = await discoveryTimer(t, db)
  let discoveries = 0
  const listPlans = schedule.resultRepo.listPlans.bind(schedule.resultRepo)
  schedule.resultRepo.listPlans = () => {
    discoveries++
    return listPlans()
  }
  service.onMaintenance(async (enabled) => {
    if (!enabled) return
    assert.equal((await coordinator.getState()).phase, 'draining')
    await tick()
    await schedule.stop()
    await schedule.flush()
  })
  const record = await service.runScheduled()
  assert.equal(record.status, 'ok')
  assert.equal(discoveries, 0)
  assert.equal(await coordinator.isReady(), true)
})

test('a discovery failure after admission remains a persistence failure even with the maintenance error code', async (t) => {
  const { db } = await fixture(t)
  const { schedule, tick } = await discoveryTimer(t, db)
  const failure = Object.assign(new Error('synthetic admitted discovery failure'), { code: 'database_maintenance' })
  let discoveries = 0
  schedule.resultRepo.listPlans = async () => {
    discoveries++
    throw failure
  }
  await tick()
  assert.equal(discoveries, 1)
  await assert.rejects(schedule.flush(), (error) => error === failure)
})

test('a pre-restore refusal cancels only its own drain and leaves ordinary requests available', async (t) => {
  const { db, coordinator, service } = await fixture(t)
  fs.mkdirSync(service.dataDir, { recursive: true })
  const file = path.join(service.dataDir, 'synthetic.tar.gz')
  fs.writeFileSync(file, 'synthetic validation fixture')
  await db.pool.query(
    "INSERT INTO backup_records(id,created_at,kind,status,file_path,file_name) VALUES ('restore-refused','now','manual','ok',$1,'synthetic.tar.gz')",
    [file],
  )
  await db.pool.query(
    "INSERT INTO background_task_runs(task_key,execution_id,owner_id,unknown_at) VALUES ('unknown-remote','one','old-pod',clock_timestamp())",
  )
  service._extractArchive = async () => ({
    tmp: fs.mkdtempSync(path.join(service.dataDir, 'extract-')),
    tables: new Set(),
  })
  const request = await coordinator.admit({ kind: 'http' })
  await request.run(() =>
    assert.rejects(service.restoreBackup('restore-refused'), { code: 'maintenance_claims_active' }),
  )
  assert.equal((await coordinator.getState()).phase, 'open')
  assert.equal(service.isMaintaining, false)
  assert.equal(service.isRestoring, false)
  assert.equal(fs.existsSync(service.maintenanceFile), false)
  await request.complete({ ended: true })
})
