import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { getDb, quoteIdentifier, registerActivityCoordinator } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { runPgTool } from '../../src/lib/admin/backup-core.mjs'

async function fixture(t) {
  const db = getDb()
  const coordinator = new GlobalMaintenanceCoordinator(db)
  await coordinator.start()
  await coordinator.acknowledgeEpoch(1)
  registerActivityCoordinator(db, coordinator)
  const operations = []
  t.after(async () => {
    await Promise.allSettled(operations.map((operation) => operation.close()))
    await coordinator.stop().catch(() => {})
    const cleanup = new pg.Client({ connectionString: db.connectionString })
    await cleanup.connect()
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinator.schema)} CASCADE`)
    } finally {
      await cleanup.end()
    }
  })
  return { db, coordinator, operations, q: quoteIdentifier(coordinator.schema) }
}

test('trusted current HTTP activity transfers to maintenance without waiting for itself and resumes for response writes', async (t) => {
  const { db, coordinator, operations, q } = await fixture(t)
  const request = await coordinator.admit({ kind: 'http' })
  const operation = await request.run(() =>
    coordinator.beginMaintenanceFromCurrentActivity({ kind: 'backup', timeoutMs: 1000 }),
  )
  operations.push(operation)
  const history = (
    await db.pool.query(`SELECT source_activity_id, ended_at FROM ${q}.operations WHERE id=$1`, [operation.operationId])
  ).rows[0]
  assert.equal(history.source_activity_id, request.activityId)
  assert.equal(history.ended_at, null)
  await operation.runAdmin(() => db.query('SELECT 1'))
  await operation.resume()
  await operation.close()
  await request.run(() => db.exec("INSERT INTO settings(key,value) VALUES ('after-maintenance-response','true')"))
  await request.complete({ ended: true })
  assert.ok(
    (await db.pool.query(`SELECT ended_at FROM ${q}.operations WHERE id=$1`, [operation.operationId])).rows[0].ended_at,
  )
})

test('scheduled backup claims and deduplication stay outside the business snapshot', async (t) => {
  const { db, coordinator, q } = await fixture(t)
  let calls = 0
  const plan = { taskKey: 'backup', executionId: 'synthetic-backup-1' }
  const result = await coordinator.runScheduledMaintenance(plan, async (operation) => {
    calls++
    await operation.runAdmin(async () => {
      assert.equal(
        (await db.query('SELECT count(*) AS n FROM background_task_runs WHERE finished_at IS NULL')).rows[0].n,
        0,
      )
      const dump = await runPgTool(
        'pg_dump',
        [
          '--data-only',
          '--no-owner',
          '--no-privileges',
          `--schema=${db.schema}`,
          `--table=${db.schema}.background_task_runs`,
        ],
        db.connectionString,
      )
      assert.equal(dump.includes('synthetic-backup-1'), false)
    })
    await operation.resume()
    return { ended: true, value: { backupId: 'synthetic-backup-1' } }
  })
  assert.deepEqual(result, { ran: true, value: { backupId: 'synthetic-backup-1' } })
  const duplicate = await coordinator.runScheduledMaintenance(plan, () => {
    calls++
    throw new Error('must not run')
  })
  assert.equal(duplicate.ran, false)
  assert.deepEqual(duplicate.sharedResult, { backupId: 'synthetic-backup-1' })
  assert.equal(calls, 1)
  assert.equal((await db.pool.query(`SELECT count(*) AS n FROM ${q}.operations WHERE task_key='backup'`)).rows[0].n, 1)
})

test('handoff rejects missing current scope, started remote work and unfinished SQL', async (t) => {
  const { db, coordinator } = await fixture(t)
  await assert.rejects(coordinator.beginMaintenanceFromCurrentActivity({ kind: 'restore' }), {
    code: 'maintenance_activity_closed',
  })
  const remote = await coordinator.admit({ kind: 'http' })
  remote.noteExecution({ requestId: 'remote', started: true, ended: false })
  await remote.run(() =>
    assert.rejects(coordinator.beginMaintenanceFromCurrentActivity({ kind: 'restore' }), {
      code: 'maintenance_handoff_started',
    }),
  )
  await remote.complete({ ended: true })
  const writing = await coordinator.admit({ kind: 'http' })
  await writing.run(async () => {
    const pending = db.query('SELECT pg_sleep(0.05)')
    await assert.rejects(coordinator.beginMaintenanceFromCurrentActivity({ kind: 'restore' }), {
      code: 'maintenance_persistence_pending',
    })
    await pending
  })
  await writing.complete({ ended: true })
  assert.equal((await coordinator.getState()).phase, 'open')
})

test('a transferred restore owner death retains its phase and private unfinished history', async (t) => {
  const { db, coordinator, operations, q } = await fixture(t)
  const request = await coordinator.admit({ kind: 'http' })
  const operation = await request.run(() =>
    coordinator.beginMaintenanceFromCurrentActivity({ kind: 'restore', timeoutMs: 1000 }),
  )
  operations.push(operation)
  await operation.beginRestore()
  await db.pool.query('SELECT pg_terminate_backend($1)', [operation.backendPid])
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal((await coordinator.getState()).phase, 'restoring')
  assert.equal(
    (await db.pool.query(`SELECT ended_at FROM ${q}.operations WHERE id=$1`, [operation.operationId])).rows[0].ended_at,
    null,
  )
  await assert.rejects(coordinator.admit({ kind: 'http' }), { code: 'database_maintenance' })
  await assert.rejects(
    async () => request.run(() => db.query('SELECT 1')),
    { code: 'maintenance_activity_closed' },
  )
})

test('handoff never excludes another active or unknown background claim', async (t) => {
  const { db, coordinator } = await fixture(t)
  await db.pool.query(
    "INSERT INTO background_task_runs(task_key,execution_id,owner_id,unknown_at) VALUES ('other','one','other-pod',clock_timestamp())",
  )
  const request = await coordinator.admit({ kind: 'http' })
  await request.run(() =>
    assert.rejects(coordinator.beginMaintenanceFromCurrentActivity({ kind: 'backup', timeoutMs: 1000 }), (error) => {
      assert.equal(error.code, 'maintenance_claims_active')
      assert.equal(error.claims.background_task_runs, 1)
      return true
    }),
  )
  const state = await coordinator.getState()
  assert.equal(state.phase, 'draining')
  await coordinator.cancelDrain(state.operationId)
  await request.run(() => db.query('SELECT 1'))
  await request.complete({ ended: true })
})
