import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { getDb, registerActivityCoordinator, quoteIdentifier } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { BackupService } from '../../src/lib/admin/backup-service.mjs'

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
