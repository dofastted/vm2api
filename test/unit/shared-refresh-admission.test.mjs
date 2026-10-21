import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { BackgroundTaskRunsRepo } from '../../src/lib/db/repos/background-task-runs-repo.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'

async function fixture(t) {
  const db = getDb()
  const peer = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => peer.close())
  return { db, peer }
}

const execution = (patch = {}) => ({
  accountId: 'refresh-account',
  vmId: 'refresh-vm',
  accountLimit: 10,
  vmLimit: 10,
  rpmLimit: 0,
  fableLimit: 0,
  ...patch,
})

test('a stale background observation cannot create a second attempt after its winner completed', async (t) => {
  const { db, peer } = await fixture(t)
  const first = new BackgroundTaskRunsRepo(db)
  const second = new BackgroundTaskRunsRepo(peer)
  const one = await first.tryClaim({ taskKey: 'refresh-observation', executionId: 'one', ownerId: 'pod-a' })
  await first.complete(one)
  const two = await first.tryClaim({
    taskKey: 'refresh-observation',
    executionId: 'two',
    ownerId: 'pod-a',
    ifPreviousExecutionId: 'one',
  })
  await first.complete(two)
  const stale = await second.tryClaim({
    taskKey: 'refresh-observation',
    executionId: 'three',
    ownerId: 'pod-b',
    ifPreviousExecutionId: 'one',
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'background_task_changed')
  const later = await second.tryClaim({
    taskKey: 'refresh-observation',
    executionId: 'four',
    ownerId: 'pod-b',
    ifPreviousExecutionId: 'two',
  })
  assert.equal(later.ok, true)
  await second.complete(later)
})

test('a refresh can hold its exact completed admission while blocking every new admission', async (t) => {
  const { db, peer } = await fixture(t)
  const gate = await new ExecutionAdmissionsRepo(db).tryReserve(execution())
  await gate.bindExecution({ requestId: 'refresh-ended-job' })
  await gate.completeExecution({
    requestId: 'refresh-ended-job',
    started: true,
    ended: true,
    reason: 'http_body_complete',
  })
  const operation = await new SharedVmOperations(peer).tryAcquire({
    vmId: gate.vmId,
    accountId: gate.accountId,
    kind: 'oauth_refresh',
    admission: { db, ...gate },
  })
  try {
    assert.equal(operation.ok, true)
    assert.equal((await new ExecutionAdmissionsRepo(db).tryReserve(execution())).code, 'vm_operation_active')
  } finally {
    await operation.release?.()
    await gate.release()
  }
})

test('an account refresh blocks inference and another mutation on a different VM', async (t) => {
  const { db, peer } = await fixture(t)
  const operations = new SharedVmOperations(db)
  const operation = await operations.tryAcquire({ vmId: 'refresh-vm', accountId: 'refresh-account' })
  let gate, other
  try {
    gate = await new ExecutionAdmissionsRepo(peer).tryReserve(execution({ vmId: 'other-refresh-vm' }))
    assert.equal(gate.ok, false)
    assert.equal(gate.code, 'vm_operation_active')
    other = await new SharedVmOperations(peer).tryAcquire({ vmId: 'other-refresh-vm', accountId: 'refresh-account' })
    assert.equal(other.ok, false)
    assert.equal(other.code, 'vm_operation_active')
  } finally {
    await gate?.release?.()
    await other?.release?.()
    await operation.release()
  }
})

test('an uncertain account refresh remains exclusive across VMs', async (t) => {
  const { db, peer } = await fixture(t)
  const operation = await new SharedVmOperations(db).tryAcquire({ vmId: 'refresh-vm', accountId: 'refresh-account' })
  await operation.markUncertain()
  const gate = await new ExecutionAdmissionsRepo(peer).tryReserve(execution({ vmId: 'other-refresh-vm' }))
  try {
    assert.equal(gate.ok, false)
  } finally {
    await gate.release?.()
  }
})

test('a nested refresh binds its account to the manual VM operation until that operation ends', async (t) => {
  const { db, peer } = await fixture(t)
  const operations = new SharedVmOperations(db)
  await operations.run('refresh-vm', async () => {
    await operations.run('refresh-vm', async () => {}, { accountId: 'refresh-account' })
    const gate = await new ExecutionAdmissionsRepo(peer).tryReserve(execution({ vmId: 'other-refresh-vm' }))
    try {
      assert.equal(gate.ok, false)
    } finally {
      await gate.release?.()
    }
  })
})

test('refresh never excludes a pending job or another active admission', async (t) => {
  const { db, peer } = await fixture(t)
  const gate = await new ExecutionAdmissionsRepo(db).tryReserve(execution())
  await gate.bindExecution({ requestId: 'refresh-pending-job' })
  const operations = new SharedVmOperations(peer)
  assert.equal(
    (await operations.tryAcquire({ vmId: gate.vmId, accountId: gate.accountId, admission: { db, ...gate } })).ok,
    false,
  )
  await gate.completeExecution({
    requestId: 'refresh-pending-job',
    started: true,
    ended: true,
    reason: 'http_body_complete',
  })
  const sibling = await new ExecutionAdmissionsRepo(db).tryReserve(execution())
  try {
    assert.equal(
      (await operations.tryAcquire({ vmId: gate.vmId, accountId: gate.accountId, admission: { db, ...gate } })).ok,
      false,
    )
    assert.equal(
      (
        await operations.tryAcquire({
          vmId: gate.vmId,
          accountId: gate.accountId,
          admission: { db, ...gate, ownerId: 'wrong-owner' },
        })
      ).ok,
      false,
    )
  } finally {
    await sibling.release()
    await gate.release()
  }
})

test('a refresh is blocked by the same account executing on a different VM', async (t) => {
  const { db, peer } = await fixture(t)
  const other = await new ExecutionAdmissionsRepo(db).tryReserve(execution({ vmId: 'another-refresh-vm' }))
  const operation = await new SharedVmOperations(peer).tryAcquire({
    vmId: 'refresh-vm',
    accountId: other.accountId,
    kind: 'oauth_refresh',
  })
  try {
    assert.equal(operation.ok, false)
    assert.equal(operation.code, 'vm_execution_active')
  } finally {
    await operation.release?.()
    await other.release()
  }
})

test('a nested refresh cannot reuse a VM operation already marked uncertain', async (t) => {
  const { db, peer } = await fixture(t)
  const outer = new SharedVmOperations(db)
  const nested = new SharedVmOperations(peer)
  let effects = 0
  await outer.run('refresh-vm', async (operation) => {
    await operation.markUncertain()
    await assert.rejects(
      nested.run('refresh-vm', async () => {
        effects++
      }),
      { code: 'vm_operation_inactive' },
    )
  })
  assert.equal(effects, 0)
})
