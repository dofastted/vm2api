import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb, createDatabase } from '../../src/lib/db/database.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { containerName } from '../../src/lib/vm/vm-runtime.mjs'

async function fixture(t) {
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => other.close())
  return {
    db,
    other,
    operations: new SharedVmOperations(db, { ownerId: 'pod-a' }),
    otherOperations: new SharedVmOperations(other, { ownerId: 'pod-b' }),
    executions: new ExecutionAdmissionsRepo(db),
    otherExecutions: new ExecutionAdmissionsRepo(other),
  }
}

function execution(vmId, accountId = 'synthetic-account') {
  return { vmId, accountId, accountLimit: 4, vmLimit: 4, rpmLimit: 0, fableLimit: 0 }
}

test('logical VM aliases cannot obtain separate operations on the same physical container', async (t) => {
  const f = await fixture(t)
  assert.equal(containerName('vm-synthetic'), containerName('synthetic'))
  const first = await f.operations.tryAcquire({ vmId: 'vm-synthetic', nodeId: 'node-a' })
  const second = await f.otherOperations.tryAcquire({ vmId: 'synthetic', nodeId: 'node-b' })
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.code, 'vm_operation_active')
  await first.release()
  const after = await f.otherOperations.tryAcquire({ vmId: 'synthetic' })
  assert.equal(after.ok, true)
  await after.release()
})

test('an alias operation excludes an execution using the other logical VM identity', async (t) => {
  const f = await fixture(t)
  const operation = await f.operations.tryAcquire({ vmId: 'vm-synthetic' })
  const admission = await f.otherExecutions.tryReserve(execution('synthetic'))
  assert.equal(admission.ok, false)
  assert.equal(admission.code, 'vm_operation_active')
  await operation.release()
})

test('an active execution excludes mutation through a physical alias', async (t) => {
  const f = await fixture(t)
  const admission = await f.executions.tryReserve(execution('vm-synthetic'))
  const operation = await f.otherOperations.tryAcquire({ vmId: 'synthetic' })
  assert.equal(operation.ok, false)
  assert.equal(operation.code, 'vm_execution_active')
  await admission.release()
})

test('different aliases cannot each sell their own VM concurrency budget', async (t) => {
  const f = await fixture(t)
  const first = await f.executions.tryReserve(execution('vm-synthetic', 'account-a'))
  const second = await f.otherExecutions.tryReserve(execution('synthetic', 'account-b'))
  assert.equal(second.ok, false)
  assert.equal(second.code, 'vm_physical_target_conflict')
  assert.equal((await f.otherExecutions.getCounts({ vmId: 'synthetic' })).vmInflight, 1)
  await first.release()
})

test('physical alias mutation and execution races have exactly one winner', async (t) => {
  const f = await fixture(t)
  for (let i = 0; i < 5; i++) {
    const [operation, admission] = await Promise.all([
      f.operations.tryAcquire({ vmId: `vm-race-${i}` }),
      f.otherExecutions.tryReserve(execution(`race-${i}`)),
    ])
    assert.equal(Number(operation.ok) + Number(admission.ok), 1)
    await operation.release?.()
    await admission.release?.()
  }
})

test('a differently named VM cannot reuse its parent operation through an alias', async (t) => {
  const f = await fixture(t)
  await f.operations.run('vm-synthetic', async () => {
    await assert.rejects(
      f.otherOperations.run('synthetic', () => assert.fail('alias callback')),
      {
        code: 'vm_operation_active',
      },
    )
  })
})

test('physical mapping strips the prefix exactly once and does not invent extra aliases', async (t) => {
  const f = await fixture(t)
  const first = await f.operations.tryAcquire({ vmId: 'vm-vm-synthetic' })
  const different = await f.otherOperations.tryAcquire({ vmId: 'vm-synthetic' })
  assert.equal(first.ok, true)
  assert.equal(different.ok, true)
  assert.notEqual(containerName('vm-vm-synthetic'), containerName('vm-synthetic'))
  await first.release()
  await different.release()
})
