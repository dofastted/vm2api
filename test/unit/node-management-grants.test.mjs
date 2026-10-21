import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { getDb, createDatabase, quoteIdentifier } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { NodeManagementGrants, nodeAuthoritySchemaFor } from '../../src/lib/cluster/node-management-grants.mjs'

async function fixture(t) {
  const db = getDb()
  const peer = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const maintenance = new GlobalMaintenanceCoordinator(db)
  await maintenance.start()
  await maintenance.acknowledgeEpoch(1)
  const service = new NodeManagementGrants(db)
  await service.initialize()
  const held = []
  t.after(async () => {
    for (const operation of held) { operation.resume(); await operation.pending }
    await maintenance.stop()
    await peer.close()
    const cleanup = new pg.Client({ connectionString: db.connectionString })
    await cleanup.connect()
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(service.schema)} CASCADE`)
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(maintenance.schema)} CASCADE`)
    } finally { await cleanup.end() }
  })
  async function issue(allocationId = 'allocation-one', patch = {}) {
    let resume
    let ready
    const waiting = new Promise((resolve) => { resume = resolve })
    const received = new Promise((resolve) => { ready = resolve })
    const pending = new SharedVmOperations(db, { ownerId: 'synthetic-controller' }).run('synthetic-vm', async (operation) => {
      const grant = await service.issueAllocation({ operation, vmId: 'synthetic-vm', nodeId: 'synthetic-node', allocationId, ...patch })
      ready({ grant, operation })
      await waiting
    }, { kind: 'node_allocate' })
    pending.catch((error) => ready({ error }))
    held.push({ pending, resume })
    const value = await received
    if (value.error) throw value.error
    return { ...value, resume, pending }
  }
  return { db, peer, service, maintenance, issue }
}

test('allocation grants require the exact current operation scope and persist outside the application schema', async (t) => {
  const fx = await fixture(t)
  await assert.rejects(fx.service.issueAllocation({ operation: { operationId: 'forged', ownerId: 'synthetic-controller' },
    vmId: 'synthetic-vm', nodeId: 'synthetic-node', allocationId: 'forged' }), { code: 'node_operation_scope_required' })
  const { grant } = await fx.issue()
  assert.equal(grant.action, 'allocate')
  assert.equal(grant.nodeId, 'synthetic-node')
  assert.notEqual(fx.service.schema, fx.db.schema)
  assert.equal(fx.service.schema, nodeAuthoritySchemaFor(fx.db.schema))
  const row = (await fx.peer.pool.query(`SELECT * FROM ${quoteIdentifier(fx.service.schema)}.allocations`)).rows[0]
  assert.equal(row.operation_id, grant.operationId)
  assert.equal(row.revoked_at, null)
})

test('operation release or uncertainty revokes its private allocation grant', async (t) => {
  const fx = await fixture(t)
  const held = await fx.issue()
  await held.operation.markUncertain()
  const row = (await fx.peer.pool.query(`SELECT revoked_at FROM ${quoteIdentifier(fx.service.schema)}.allocations`)).rows[0]
  assert.ok(row.revoked_at)
})

test('once enabled, missing private grant state prevents release rather than becoming legacy mode', async (t) => {
  const fx = await fixture(t)
  const held = await fx.issue()
  await fx.peer.pool.query(`DROP SCHEMA ${quoteIdentifier(fx.service.schema)} CASCADE`)
  await assert.rejects(held.operation.release(), { code: 'node_authority_unavailable' })
  const row = await fx.peer.prepare('SELECT released_at FROM vm_operations WHERE id=$1').get(held.operation.operationId)
  assert.equal(row.released_at, null)
  // The callback deliberately leaves an unknown operation; cleanup must not retry a normal release.
  await fx.peer.prepare('UPDATE vm_operations SET uncertain_at=clock_timestamp() WHERE id=$1').run(held.operation.operationId)
  held.resume()
  await assert.rejects(held.pending)
  // Prevent the shared fixture cleanup from observing the already asserted rejection twice.
  held.pending.catch(() => {})
})
