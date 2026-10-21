import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { nodeGrantNamespace, nodeGrantResource } from '../../src/lib/db/node-management-authority.mjs'
import { getDb, createDatabase, quoteIdentifier } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { NodeManagementGrants, nodeAuthoritySchemaFor } from '../../src/lib/cluster/node-management-grants.mjs'
import { realAllocationGate } from '../fixtures/real-allocation-gate.mjs'
import { allocateNodeSlot } from '../../src/lib/transport/slotgate-management-client.mjs'

async function fixture(t) {
  const db = getDb()
  const peer = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const maintenance = new GlobalMaintenanceCoordinator(db)
  const service = new NodeManagementGrants(db)
  const held = []
  const roles = []
  const readers = []
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    for (const operation of held) operation.resume()
    await Promise.allSettled(held.map((operation) => operation.pending))
    await maintenance.stop()
    await peer.close()
    for (const client of readers) await client.end()
    const cleanup = new pg.Client({ connectionString: db.connectionString })
    await cleanup.connect()
    try {
      for (const role of roles) {
        await cleanup.query(`DROP OWNED BY ${quoteIdentifier(role)}; DROP ROLE ${quoteIdentifier(role)}`)
      }
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(service.schema)} CASCADE`)
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(maintenance.schema)} CASCADE`)
    } finally {
      await cleanup.end()
    }
  }
  t.after(close)
  try {
    await maintenance.start()
    await maintenance.acknowledgeEpoch(1)
    await service.initialize()
  } catch (error) {
    await close()
    throw error
  }
  async function issue(allocationId = 'allocation-one', patch = {}) {
    let resume
    let ready
    const waiting = new Promise((resolve) => {
      resume = resolve
    })
    const received = new Promise((resolve) => {
      ready = resolve
    })
    const pending = new SharedVmOperations(db, { ownerId: 'synthetic-controller' }).run(
      'synthetic-vm',
      async (operation) => {
        const grant = await service.issueAllocation({
          operation,
          vmId: 'synthetic-vm',
          nodeId: 'synthetic-node',
          allocationId,
          ...patch,
        })
        ready({ grant, operation })
        await waiting
      },
      { kind: 'node_allocate' },
    )
    pending.catch((error) => ready({ error }))
    held.push({ pending, resume })
    const value = await received
    if (value.error) throw value.error
    return { ...value, resume, pending }
  }
  async function reader(nodeId = 'synthetic-node') {
    const role = 'node_reader_' + crypto.randomBytes(8).toString('hex')
    const password = crypto.randomBytes(24).toString('hex')
    await db.pool.query(
      `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
    )
    roles.push(role)
    await db.pool.query(service.readerRoleSql({ role, nodeId }))
    const url = new URL(db.connectionString)
    url.username = role
    url.password = password
    const client = new pg.Client({ connectionString: url.toString() })
    await client.connect()
    readers.push(client)
    return { client, connectionString: url.toString() }
  }
  return { db, peer, service, maintenance, issue, close, reader }
}

async function usingFixture(t, callback) {
  const fx = await fixture(t)
  try {
    return await callback(fx)
  } finally {
    await fx.close()
  }
}

test('allocation grants require the exact current operation scope and persist outside the application schema', async (t) => {
  await usingFixture(t, async (fx) => {
    await assert.rejects(
      fx.service.issueAllocation({
        operation: { operationId: 'forged', ownerId: 'synthetic-controller' },
        vmId: 'synthetic-vm',
        nodeId: 'synthetic-node',
        allocationId: 'forged',
      }),
      { code: 'node_operation_scope_required' },
    )
    const { grant } = await fx.issue()
    assert.equal(grant.action, 'allocate')
    assert.equal(grant.nodeId, 'synthetic-node')
    assert.notEqual(fx.service.schema, fx.db.schema)
    assert.equal(fx.service.schema, nodeAuthoritySchemaFor(fx.db.schema))
    const row = (await fx.peer.pool.query(`SELECT * FROM ${quoteIdentifier(fx.service.schema)}.allocations`)).rows[0]
    assert.equal(row.operation_id, grant.operationId)
    assert.equal(row.revoked_at, null)
  })
})

test('the installed reader role sees only its node grants and cannot read or mutate business/base tables', async (t) => {
  await usingFixture(t, async (fx) => {
    const correct = await fx.reader()
    const wrong = await fx.reader('different-node')
    await fx.issue()
    const q = quoteIdentifier(fx.service.schema)
    assert.equal((await correct.client.query(`SELECT * FROM ${q}.authorized_allocations`)).rowCount, 1)
    assert.equal((await wrong.client.query(`SELECT * FROM ${q}.authorized_allocations`)).rowCount, 0)
    await assert.rejects(correct.client.query(`SELECT * FROM ${q}.allocations`), { code: '42501' })
    await assert.rejects(correct.client.query(`SELECT * FROM ${quoteIdentifier(fx.db.schema)}.vm_operations`), {
      code: '42501',
    })
    await assert.rejects(correct.client.query(`UPDATE ${q}.allocations SET revoked_at=NULL`), { code: '42501' })
  })
})

test('the actual Go node independently authorizes allocate and preserves the original receipt across two controller connections', {
  skip: process.platform !== 'linux',
}, async (t) => {
  await usingFixture(t, async (fx) => {
    const reader = await fx.reader()
    const node = await realAllocationGate(t, {
      connection_string: reader.connectionString,
      authority_schema: fx.service.schema,
      node_id: 'synthetic-node',
    })
    try {
      const held = await fx.issue()
      const receipts = await Promise.all([
        allocateNodeSlot({ link: node.link, grant: held.grant }),
        allocateNodeSlot({ link: node.link, grant: held.grant }),
      ])
      assert.deepEqual(receipts[0], receipts[1])
      assert.equal(receipts[0].fence.generation, '1')
      await assert.rejects(allocateNodeSlot({ link: node.link, grant: { ...held.grant, ownerId: 'other-owner' } }), {
        code: 'node_allocation_unconfirmed',
      })
      await held.operation.markUncertain()
      await assert.rejects(allocateNodeSlot({ link: node.link, grant: held.grant }), {
        code: 'node_allocation_unconfirmed',
      })
    } finally {
      await node.close()
    }
  })
})

test('operation release or uncertainty revokes its private allocation grant', async (t) => {
  await usingFixture(t, async (fx) => {
    const held = await fx.issue()
    await held.operation.markUncertain()
    const row = (await fx.peer.pool.query(`SELECT revoked_at FROM ${quoteIdentifier(fx.service.schema)}.allocations`))
      .rows[0]
    assert.ok(row.revoked_at)
  })
})

test('once enabled, missing private grant state prevents release rather than becoming legacy mode', async (t) => {
  await usingFixture(t, async (fx) => {
    const held = await fx.issue()
    await fx.peer.pool.query(`DROP SCHEMA ${quoteIdentifier(fx.service.schema)} CASCADE`)
    await assert.rejects(held.operation.release(), { code: 'node_authority_unavailable' })
    const row = await fx.peer
      .prepare('SELECT released_at FROM vm_operations WHERE id=$1')
      .get(held.operation.operationId)
    assert.equal(row.released_at, null)
    // The callback deliberately leaves an unknown operation; cleanup must not retry a normal release.
    await fx.peer
      .prepare('UPDATE vm_operations SET uncertain_at=clock_timestamp() WHERE id=$1')
      .run(held.operation.operationId)
    held.resume()
    await assert.rejects(held.pending)
    // Prevent the shared fixture cleanup from observing the already asserted rejection twice.
    held.pending.catch(() => {})
  })
})

test('release waits for the node shared authorization lock and then revokes before returning', async (t) => {
  await usingFixture(t, async (fx) => {
    const reader = await fx.reader()
    const held = await fx.issue()
    await reader.client.query('BEGIN READ ONLY')
    await reader.client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1),hashtext($2))', [
      nodeGrantNamespace(fx.service.schema),
      nodeGrantResource(held.grant.nodeId, held.grant.vmId),
    ])
    const releasing = held.operation.release()
    try {
      assert.equal(await Promise.race([releasing.then(() => 'released'), delay(100).then(() => 'waiting')]), 'waiting')
    } finally {
      await reader.client.query('COMMIT')
    }
    assert.equal((await releasing).released, true)
    assert.equal(
      (await reader.client.query(`SELECT * FROM ${quoteIdentifier(fx.service.schema)}.authorized_allocations`))
        .rowCount,
      0,
    )
  })
})

test('dropping business state preserves the private view and a new maintenance epoch rejects restored old operation rows', async (t) => {
  await usingFixture(t, async (fx) => {
    const reader = await fx.reader()
    const held = await fx.issue()
    const q = quoteIdentifier(fx.service.schema)
    const app = quoteIdentifier(fx.db.schema)
    await fx.peer.pool.query(`DROP TABLE ${app}.vm_operations CASCADE`)
    assert.ok(
      (await fx.peer.pool.query('SELECT to_regclass($1) AS relation', [`${q}.authorized_allocations`])).rows[0]
        .relation,
    )
    assert.equal((await reader.client.query(`SELECT * FROM ${q}.authorized_allocations`)).rowCount, 0)
    await fx.peer.pool.query(`CREATE TABLE ${app}.vm_operations(id text PRIMARY KEY,vm_id text,owner_id text,kind text,account_id text,
      created_at timestamptz DEFAULT clock_timestamp(),released_at timestamptz,uncertain_at timestamptz)`)
    await fx.peer.pool.query(
      `INSERT INTO ${app}.vm_operations(id,vm_id,owner_id,kind) VALUES($1,$2,$3,'node_allocate')`,
      [held.grant.operationId, held.grant.vmId, held.grant.ownerId],
    )
    await fx.peer.pool.query(`UPDATE ${quoteIdentifier(fx.maintenance.schema)}.control SET epoch=epoch+1 WHERE id=1`)
    assert.equal((await reader.client.query(`SELECT * FROM ${q}.authorized_allocations`)).rowCount, 0)
  })
})

test('the typed service persists the authenticated initial receipt before its VM operation is released', {
  skip: process.platform !== 'linux',
}, async (t) => {
  await usingFixture(t, async (fx) => {
    const reader = await fx.reader()
    const node = await realAllocationGate(t, {
      connection_string: reader.connectionString,
      authority_schema: fx.service.schema,
      node_id: 'synthetic-node',
    })
    try {
      fx.service.resolveNodeLink = async () => node.link
      const receipt = await new SharedVmOperations(fx.db, { ownerId: 'synthetic-typed-controller' }).run(
        'typed-vm',
        (operation) =>
          fx.service.allocate({
            operation,
            nodeId: 'synthetic-node',
            vmId: 'typed-vm',
            allocationId: 'typed-allocation',
          }),
        { kind: 'node_allocate' },
      )
      const row = (
        await fx.peer.pool.query(
          `SELECT receipt,revoked_at FROM ${quoteIdentifier(fx.service.schema)}.allocations WHERE allocation_id='typed-allocation'`,
        )
      ).rows[0]
      assert.deepEqual(row.receipt, receipt)
      assert.ok(row.revoked_at)
    } finally {
      await node.close()
    }
  })
})

test('a node PG authorization failure leaves no local allocation and has no fallback', {
  skip: process.platform !== 'linux',
}, async (t) => {
  await usingFixture(t, async (fx) => {
    const reader = await fx.reader()
    const unreachable = new URL(reader.connectionString)
    unreachable.port = '1'
    const node = await realAllocationGate(t, {
      connection_string: unreachable.toString(),
      authority_schema: fx.service.schema,
      node_id: 'synthetic-node',
    })
    try {
      const held = await fx.issue()
      await assert.rejects(allocateNodeSlot({ link: node.link, grant: held.grant }), {
        code: 'node_allocation_unconfirmed',
      })
      const journal = JSON.parse(fs.readFileSync(path.join(node.root, 'authority', 'authority.json'), 'utf8'))
      assert.deepEqual(journal.slots, {})
      assert.equal(fs.existsSync(path.join(node.root, 'runtime', 'vms')), false)
    } finally {
      await node.close()
    }
  })
})

test('a PG receipt write failure retains the unknown operation after a local allocation', {
  skip: process.platform !== 'linux',
}, async (t) => {
  await usingFixture(t, async (fx) => {
    const reader = await fx.reader()
    const node = await realAllocationGate(t, {
      connection_string: reader.connectionString,
      authority_schema: fx.service.schema,
      node_id: 'synthetic-node',
    })
    try {
      const q = quoteIdentifier(fx.service.schema)
      await fx.db.pool.query(`CREATE FUNCTION ${q}.reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic receipt failure' USING ERRCODE='P0001'; END; $$;
        CREATE TRIGGER reject_receipt BEFORE UPDATE OF receipt ON ${q}.allocations FOR EACH ROW EXECUTE FUNCTION ${q}.reject_receipt()`)
      fx.service.resolveNodeLink = async () => node.link
      await assert.rejects(
        new SharedVmOperations(fx.db, { ownerId: 'synthetic-receipt-controller' }).run(
          'receipt-vm',
          (operation) =>
            fx.service.allocate({
              operation,
              nodeId: 'synthetic-node',
              vmId: 'receipt-vm',
              allocationId: 'receipt-allocation',
            }),
          { kind: 'node_allocate' },
        ),
        { code: 'P0001' },
      )
      const operation = await fx.peer
        .prepare("SELECT released_at,uncertain_at FROM vm_operations WHERE vm_id='receipt-vm'")
        .get()
      assert.equal(operation.released_at, null)
      assert.ok(operation.uncertain_at)
      const allocation = (await fx.peer.pool.query(`SELECT receipt,revoked_at FROM ${q}.allocations`)).rows[0]
      assert.equal(allocation.receipt, null)
      assert.ok(allocation.revoked_at)
      assert.equal(fs.existsSync(path.join(node.root, 'runtime', 'vms')), false)
    } finally {
      await node.close()
    }
  })
})
