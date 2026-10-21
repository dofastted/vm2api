import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { createDatabase, getDb, quoteIdentifier } from '../../src/lib/db/database.mjs'

async function fixture(t, { acknowledge = true } = {}) {
  const { GlobalMaintenanceCoordinator, coordinationSchemaFor } = await import(
    '../../src/lib/db/global-maintenance.mjs'
  )
  const db = getDb()
  const peer = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const schema = coordinationSchemaFor(db.schema)
  const first = new GlobalMaintenanceCoordinator(db, { ownerId: 'pod-a' })
  const second = new GlobalMaintenanceCoordinator(peer, { ownerId: 'pod-b' })
  const operations = []
  t.after(async () => {
    await Promise.allSettled(operations.map((operation) => operation.close()))
    await Promise.allSettled([first.stop(), second.stop()])
    const cleanup = new pg.Client({ connectionString: db.connectionString })
    await cleanup.connect()
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
    } finally {
      await cleanup.end()
    }
  })
  await first.start()
  await second.start()
  if (acknowledge) {
    await first.acknowledgeEpoch(1)
    await second.acknowledgeEpoch(1)
  }
  return { db, peer, first, second, schema, operations, coordinationSchemaFor }
}

async function waitForPhase(coordinator, phase) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await coordinator.getState()).phase === phase) return
    await delay(5)
  }
  assert.fail(`maintenance did not reach ${phase}`)
}

test('coordination DDL belongs only to a private schema derived from this application schema', async (t) => {
  const { db, schema, coordinationSchemaFor } = await fixture(t)
  assert.notEqual(schema, 'public')
  assert.notEqual(schema, db.schema)
  assert.ok(Buffer.byteLength(schema) <= 63)
  assert.notEqual(coordinationSchemaFor('another_tenant'), schema)
  const namespace = (
    await db.pool.query(
      `SELECT pg_get_userbyid(nspowner) AS owner,
    current_user AS expected_owner,
    EXISTS (SELECT 1 FROM aclexplode(nspacl) WHERE grantee = 0) AS public_access
    FROM pg_namespace WHERE nspname = $1`,
      [schema],
    )
  ).rows[0]
  assert.equal(namespace.owner, namespace.expected_owner)
  assert.equal(namespace.public_access, false)
  const tables = (
    await db.pool.query(
      `SELECT table_name FROM information_schema.tables
    WHERE table_schema = $1 ORDER BY table_name`,
      [schema],
    )
  ).rows.map((row) => row.table_name)
  assert.deepEqual(tables, ['activities', 'control', 'members'])
  assert.equal((await db.pool.query('SELECT to_regclass($1) AS name', [`${db.schema}.activities`])).rows[0].name, null)
})

test('each replica acknowledges its loaded epoch before durable admission of master or endpoint work', async (t) => {
  const { db, first, second, schema } = await fixture(t, { acknowledge: false })
  await assert.rejects(first.admit({ kind: 'master_request', requestId: 'master-1' }), {
    code: 'maintenance_epoch_unbound',
  })
  await first.acknowledgeEpoch(1)
  await second.acknowledgeEpoch(1)
  const gate = await first.admit({ kind: 'api_endpoint', requestId: 'endpoint-1' })
  assert.equal(gate.epoch, 1)
  const row = (
    await db.pool.query(`SELECT * FROM ${quoteIdentifier(schema)}.activities WHERE id = $1`, [gate.activityId])
  ).rows[0]
  assert.equal(row.owner_id, 'pod-a')
  assert.equal(row.request_id, 'endpoint-1')
  assert.equal(row.completed_at, null)
  await gate.complete({ ended: true, reason: 'response_eof' })
  assert.equal(
    (
      await db.pool.query(
        `SELECT completed_at IS NOT NULL AS ended FROM ${quoteIdentifier(schema)}.activities WHERE id = $1`,
        [gate.activityId],
      )
    ).rows[0].ended,
    true,
  )
})

test('DRAINING rejects new work on a busy replica while its admitted scope can finish SQL', async (t) => {
  const { db, first, second, operations } = await fixture(t)
  const gate = await second.admit({ kind: 'request', requestId: 'sse-existing' })
  const pending = first.beginMaintenance({ kind: 'restore', timeoutMs: 5000 })
  await waitForPhase(second, 'draining')
  await assert.rejects(second.admit({ kind: 'request' }), { code: 'database_maintenance' })
  await gate.run(async () => {
    second.assertActivity()
    await db.prepare("INSERT INTO settings (key, value) VALUES ('maintenance-existing-write', 'true')").run()
  })
  await gate.complete({ ended: true })
  const operation = await pending
  operations.push(operation)
  assert.ok(await db.prepare("SELECT key FROM settings WHERE key = 'maintenance-existing-write'").get())
})

test('uncertain remote work releases its local lock but durably prevents destructive maintenance', async (t) => {
  const { db, first, second, schema } = await fixture(t)
  const gate = await second.admit({ kind: 'api_endpoint', requestId: 'truncated-upstream' })
  await gate.complete({ ended: false, reason: 'transport_error' })
  const row = (
    await db.pool.query(`SELECT * FROM ${quoteIdentifier(schema)}.activities WHERE id = $1`, [gate.activityId])
  ).rows[0]
  assert.ok(row.uncertain_at)
  assert.equal(row.completed_at, null)
  await assert.rejects(first.beginMaintenance({ kind: 'restore', timeoutMs: 2000 }), (error) => {
    assert.equal(error.code, 'maintenance_claims_active')
    assert.equal(error.claims.activities, 1)
    return true
  })
  assert.equal((await second.getState()).phase, 'draining')
  await gate.complete({ ended: true })
  assert.equal(
    (
      await db.pool.query(`SELECT completed_at FROM ${quoteIdentifier(schema)}.activities WHERE id = $1`, [
        gate.activityId,
      ])
    ).rows[0].completed_at,
    null,
  )
})

test('every existing execution, key, VM, background and session ledger prevents restore', async (t) => {
  const { db, first } = await fixture(t)
  const cases = [
    [
      'execution_admissions',
      "INSERT INTO execution_admissions (id,owner_id,request_id,account_id,vm_id) VALUES ('claim','old','r','a','v')",
      'DELETE FROM execution_admissions',
    ],
    [
      'execution_jobs',
      "INSERT INTO execution_admissions (id,owner_id,request_id,account_id,vm_id,released_at) VALUES ('claim','old','r','a','v',clock_timestamp()); INSERT INTO execution_jobs(request_id,admission_id) VALUES ('job','claim')",
      'DELETE FROM execution_admissions',
    ],
    [
      'api_key_admissions',
      "INSERT INTO api_key_admissions (id,key_id,owner_id) VALUES ('claim','key','old')",
      'DELETE FROM api_key_admissions',
    ],
    [
      'vm_operations',
      "INSERT INTO vm_operations (id,vm_id,owner_id,kind) VALUES ('claim','v','old','restart')",
      'DELETE FROM vm_operations',
    ],
    [
      'background_task_runs',
      "INSERT INTO background_task_runs(task_key,execution_id,owner_id) VALUES ('task','claim','old')",
      'DELETE FROM background_task_runs',
    ],
    [
      'session_turns',
      "INSERT INTO session_turns(id,session_key,owner_id,state) VALUES ('claim','session','old','waiting')",
      'DELETE FROM session_turns',
    ],
  ]
  for (const [kind, insert, cleanup] of cases) {
    await db.exec(insert)
    await assert.rejects(first.beginMaintenance({ kind: 'restore', timeoutMs: 2000 }), (error) => {
      assert.equal(error.code, 'maintenance_claims_active', kind)
      assert.equal(error.claims[kind], 1, kind)
      return true
    })
    await first.cancelDrain((await first.getState()).operationId)
    await db.exec(cleanup)
  }
})

test('restoring latch and epoch survive replacement of the entire application schema', async (t) => {
  const { db, first, second, operations } = await fixture(t)
  const operation = await first.beginMaintenance({ kind: 'restore' })
  operations.push(operation)
  const state = await operation.beginRestore()
  assert.equal(state.epoch, 2)
  await db.pool.query(`DROP SCHEMA ${quoteIdentifier(db.schema)} CASCADE; CREATE SCHEMA ${quoteIdentifier(db.schema)}`)
  assert.equal((await second.getState()).phase, 'restoring')
  assert.equal((await second.getState()).epoch, 2)
  await operation.close()
  await assert.rejects(second.admit({ kind: 'request' }), { code: 'database_maintenance' })
  await assert.rejects(second.cancelDrain(operation.operationId), { code: 'maintenance_operation_changed' })
})

test('losing the restore owner session never clears the durable restoring latch', async (t) => {
  const { db, first, second, operations } = await fixture(t)
  const operation = await first.beginMaintenance({ kind: 'restore' })
  operations.push(operation)
  await operation.beginRestore()
  await db.pool.query('SELECT pg_terminate_backend($1)', [operation.backendPid])
  await delay(10)
  await assert.rejects(operation.beginRebind(), { code: 'maintenance_connection_lost' })
  await assert.rejects(second.admit({ kind: 'request' }), { code: 'database_maintenance' })
  assert.equal((await second.getState()).phase, 'restoring')
})

test('restore resumes only after every participating Pod acknowledges the new epoch', async (t) => {
  const { first, second, operations } = await fixture(t)
  const operation = await first.beginMaintenance({ kind: 'restore' })
  operations.push(operation)
  await operation.beginRestore()
  await operation.beginRebind()
  await first.acknowledgeEpoch(2)
  await assert.rejects(operation.resume(), { code: 'maintenance_rebind_pending' })
  await second.acknowledgeEpoch(2)
  await operation.resume()
  const gate = await second.admit({ kind: 'request' })
  assert.equal(gate.epoch, 2)
  await gate.complete({ ended: true })
  // Backup/schema-DDL exclusion lasts until explicit close, after traffic resumes.
  await assert.rejects(second.beginMaintenance({ kind: 'backup' }), { code: 'maintenance_busy' })
  await operation.close()
})

test('concurrent zero-to-one and one-to-zero transitions do not leak or briefly drop the Pod holder', async (t) => {
  const { first, second, operations } = await fixture(t)
  let gates = await Promise.all(Array.from({ length: 20 }, () => second.admit({ kind: 'request' })))
  for (let round = 0; round < 3; round++) {
    const closing = gates.map((gate) => gate.complete({ ended: true }))
    gates = await Promise.all(Array.from({ length: 20 }, () => second.admit({ kind: 'request' })))
    await Promise.all(closing)
  }
  const pending = first.beginMaintenance({ kind: 'backup', timeoutMs: 5000 })
  await waitForPhase(second, 'draining')
  await assert.rejects(second.admit({ kind: 'request' }), { code: 'database_maintenance' })
  await Promise.all(gates.map((gate) => gate.complete({ ended: true })))
  const operation = await pending
  operations.push(operation)
  await operation.resume()
})

test('an inherited asynchronous scope cannot authorize SQL after its activity completed', async (t) => {
  const { first } = await fixture(t)
  const gate = await first.admit({ kind: 'request' })
  let release
  const wait = new Promise((resolve) => {
    release = resolve
  })
  const child = gate.run(async () => {
    await wait
    assert.throws(() => first.assertActivity(), { code: 'maintenance_activity_closed' })
  })
  await gate.complete({ ended: true })
  release()
  await child
  assert.throws(() => gate.run(() => {}), { code: 'maintenance_activity_closed' })
})

test('failed durable admission does not start work or retain an empty shared holder', async (t) => {
  const { db, first, second, schema, operations } = await fixture(t)
  await db.pool.query(`CREATE FUNCTION ${quoteIdentifier(schema)}.reject_activity() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic admission failure' USING ERRCODE='P6483'; END $$;
    CREATE TRIGGER reject_activity BEFORE INSERT ON ${quoteIdentifier(schema)}.activities
    FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier(schema)}.reject_activity()`)
  await assert.rejects(second.admit({ kind: 'request' }), { code: 'P6483' })
  const operation = await first.beginMaintenance({ kind: 'backup', timeoutMs: 2000 })
  operations.push(operation)
  await operation.resume()
})

test('failed durable completion retains its live scope and blocks restore until completion commits', async (t) => {
  const { db, first, second, schema, operations } = await fixture(t)
  const gate = await second.admit({ kind: 'request' })
  await db.pool.query(`CREATE FUNCTION ${quoteIdentifier(schema)}.reject_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic completion failure' USING ERRCODE='P6484'; END $$;
    CREATE TRIGGER reject_completion BEFORE UPDATE ON ${quoteIdentifier(schema)}.activities
    FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier(schema)}.reject_completion()`)
  await assert.rejects(gate.complete({ ended: true }), { code: 'P6484' })
  await gate.run(() => second.assertActivity())
  const pending = first.beginMaintenance({ kind: 'restore', timeoutMs: 5000 })
  await waitForPhase(second, 'draining')
  await db.pool.query(`DROP TRIGGER reject_completion ON ${quoteIdentifier(schema)}.activities`)
  await gate.complete({ ended: true })
  operations.push(await pending)
})

test('stopping or losing a Pod preserves all of its unfinished durable activities', async (t) => {
  const { db, first, second, schema } = await fixture(t)
  const gate = await second.admit({ kind: 'background', requestId: 'remote-refresh' })
  await second.stop()
  await assert.rejects(gate.complete({ ended: true }), { code: 'maintenance_connection_lost' })
  const row = (
    await db.pool.query(`SELECT completed_at FROM ${quoteIdentifier(schema)}.activities WHERE id = $1`, [
      gate.activityId,
    ])
  ).rows[0]
  assert.equal(row.completed_at, null)
  await assert.rejects(first.beginMaintenance({ kind: 'restore', timeoutMs: 2000 }), {
    code: 'maintenance_claims_active',
  })
})
