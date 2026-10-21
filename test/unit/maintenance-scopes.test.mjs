import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import * as database from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator, coordinationSchemaFor } from '../../src/lib/db/global-maintenance.mjs'
import { SharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'

async function fixture(t) {
  const db = database.getDb()
  const coordinator = new GlobalMaintenanceCoordinator(db)
  await coordinator.start()
  await coordinator.acknowledgeEpoch(1)
  t.after(async () => {
    await coordinator.stop().catch(() => {})
    const cleanup = new pg.Client({ connectionString: db.connectionString })
    await cleanup.connect()
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${database.quoteIdentifier(coordinator.schema)} CASCADE`)
    } finally {
      await cleanup.end()
    }
  })
  database.registerActivityCoordinator(db, coordinator)
  return { db, coordinator }
}

test('registered SQL guards reject missing and closed scopes while another activity remains live', async (t) => {
  const { db, coordinator } = await fixture(t)
  assert.equal(database.getActivityCoordinator(db), coordinator)
  await assert.rejects(db.query('SELECT 1'), { code: 'maintenance_activity_closed' })
  const old = await coordinator.admit()
  let release
  const deferred = new Promise((resolve) => {
    release = resolve
  })
  const escaped = old.run(async () => {
    await deferred
    await assert.rejects(db.query('SELECT 1'), { code: 'maintenance_activity_closed' })
  })
  await old.run(() => db.query('SELECT 1'))
  await old.complete({ ended: true })
  const fresh = await coordinator.admit()
  release()
  await escaped
  await fresh.run(() => db.query('SELECT 1'))
  await fresh.complete({ ended: true })
})

test('a transaction cannot reuse an activity that closed while its JavaScript callback was suspended', async (t) => {
  const { db, coordinator } = await fixture(t)
  const gate = await coordinator.admit()
  let release
  let began
  const paused = new Promise((resolve) => {
    release = resolve
  })
  const started = new Promise((resolve) => {
    began = resolve
  })
  const transaction = gate.run(() =>
    database.withTransaction(db, async () => {
      await db.query('SELECT 1')
      began()
      await paused
      await db.exec("INSERT INTO settings(key,value) VALUES ('closed-scope-write','true')")
    }),
  )
  transaction.catch(() => {})
  await started
  await gate.complete({ ended: true })
  release()
  await assert.rejects(transaction, { code: 'maintenance_activity_closed' })
  assert.equal((await db.pool.query("SELECT count(*) AS n FROM settings WHERE key='closed-scope-write'")).rows[0].n, 0)
})

test('Kubernetes database startup leaves a live bootstrap scope through cache initialization', async (t) => {
  const source = database.getDb()
  const schema = source.schema + '_bootstrap'
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  let db
  try {
    db = await database.createDatabase({ connectionString: source.connectionString, schema })
  } finally {
    if (previous === undefined) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
  }
  t.after(async () => {
    await db?.close()
    const cleanup = new pg.Client({ connectionString: source.connectionString })
    await cleanup.connect()
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${database.quoteIdentifier(coordinationSchemaFor(schema))} CASCADE;
        DROP SCHEMA IF EXISTS ${database.quoteIdentifier(schema)} CASCADE`)
    } finally {
      await cleanup.end()
    }
  })
  const coordinator = database.getActivityCoordinator(db)
  assert.ok(coordinator)
  await assert.rejects(db.query('SELECT 1'), { code: 'maintenance_activity_closed' })
  await db.bootstrapActivity.run(() => db.exec("INSERT INTO settings(key,value) VALUES ('bootstrap-cache','true')"))
  await coordinator.acknowledgeEpoch(db.bootstrapActivity.epoch)
  await db.bootstrapActivity.complete({ ended: true })
  const gate = await coordinator.admit()
  assert.ok(await gate.run(() => db.prepare("SELECT key FROM settings WHERE key='bootstrap-cache'").get()))
  await gate.complete({ ended: true })
})

test('shared background work enters an independent activity and retains unknown remote work', async (t) => {
  const { db, coordinator } = await fixture(t)
  const tasks = new SharedBackgroundTasks(db)
  const done = await tasks.run({ taskKey: 'scope', executionId: 'one' }, async () => {
    coordinator.assertActivity()
    await db.query('SELECT 1')
    return { terminal: true, value: 1 }
  })
  assert.equal(done.unknown, false)
  const unknown = await tasks.run({ taskKey: 'unknown', executionId: 'one' }, () => ({ value: 'transport_error' }))
  assert.equal(unknown.unknown, true)
  const row = (
    await db.pool.query(`SELECT count(*) AS n FROM ${database.quoteIdentifier(coordinator.schema)}.activities
    WHERE completed_at IS NULL AND uncertain_at IS NOT NULL`)
  ).rows[0]
  assert.equal(row.n, 1)
})
