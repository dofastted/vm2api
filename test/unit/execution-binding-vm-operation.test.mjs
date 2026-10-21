import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createDatabase, getDb, withTransaction } from '../../src/lib/db/database.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'

async function fixture(t) {
  const db = getDb()
  const peer = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => peer.close())
  const first = new ExecutionAdmissionsRepo(db)
  const gate = await first.tryReserve({ accountId: 'refresh-account', vmId: 'refresh-vm',
    accountLimit: 1, vmLimit: 1, rpmLimit: 0, fableLimit: 0 })
  await gate.bindExecution({ requestId: 'completed-before-refresh' })
  await gate.completeExecution({ requestId: 'completed-before-refresh', started: true, ended: true, reason: 'eof' })
  return { db, peer, first, gate, operations: new SharedVmOperations(peer) }
}

test('a held refresh VM operation rejects another job on its exact completed admission', async (t) => {
  const { db, peer, gate, operations } = await fixture(t)
  const operation = await operations.tryAcquire({ vmId: gate.vmId, accountId: gate.accountId,
    kind: 'oauth_refresh', admission: { db, ...gate } })
  try {
    assert.equal(operation.ok, true)
    await assert.rejects(gate.bindExecution({ requestId: 'must-not-overlap-refresh' }), { code: 'vm_operation_active' })
    assert.equal((await peer.prepare('SELECT count(*) AS count FROM execution_jobs').get()).count, 1)
  } finally { await operation.release?.() }
  await gate.bindExecution({ requestId: 'allowed-after-refresh' })
  assert.equal((await peer.prepare('SELECT count(*) AS count FROM execution_jobs').get()).count, 2)
})

test('binding waits for an in-progress management transaction before checking its committed VM operation', async (t) => {
  const { db, peer, gate, operations } = await fixture(t)
  let binding
  await withTransaction(peer, async () => {
    await operations.executions.lockResources({ accountId: gate.accountId, vmIds: [gate.vmId] })
    await peer.prepare('INSERT INTO vm_operations (id,vm_id,owner_id,kind) VALUES ($1,$2,$3,$4)')
      .run('synthetic-uncommitted-operation', gate.vmId, 'synthetic-operation-owner', 'oauth_refresh')
    binding = gate.bindExecution({ requestId: 'wait-for-management-commit' })
    const observed = await Promise.race([binding.then(() => 'bound', () => 'rejected'), delay(200).then(() => 'waiting')])
    assert.equal(observed, 'waiting', 'a new job cannot pass the management transaction using only its admission row')
  })
  await assert.rejects(binding, { code: 'vm_operation_active' })
  assert.equal((await db.prepare('SELECT count(*) AS count FROM execution_jobs').get()).count, 1)
})
