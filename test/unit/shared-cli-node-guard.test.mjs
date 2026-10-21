import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../../src/lib/db/database.mjs'
import { SharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { createCliNodeGuard } from '../../src/lib/vm/cli-node-guard.mjs'

function guard(exec, vmId = 'vm-shared-guard') {
  const db = getDb()
  return createCliNodeGuard({
    listTargets: () => [{ id: vmId, status: 'running' }],
    sharedTasks: new SharedBackgroundTasks(db),
    operations: new SharedVmOperations(db),
    exec,
    logger: { warn() {} },
  })
}

function reserve(vmId = 'vm-shared-guard') {
  return new ExecutionAdmissionsRepo(getDb()).tryReserve({
    accountId: 'shared-guard-account',
    vmId,
    accountLimit: 2,
    vmLimit: 2,
    fableLimit: 0,
    rpmLimit: 0,
  })
}

test('a shared CLI guard cannot modify a VM with an admitted inference', async () => {
  const active = await reserve()
  assert.equal(active.ok, true)
  let sent = 0
  await guard(async () => {
    sent++
    return { ended: true, ok: true }
  }).tick()
  assert.equal(sent, 0)
  await active.release()
})

test('shared CLI guards claim one plan across physical VM aliases', async () => {
  let sent = 0
  const exec = async (_connect, _container, cmd) => {
    assert.ok(cmd.includes('--preserve-panel'))
    sent++
    return { ended: true, ok: true }
  }
  await Promise.all([guard(exec).tick(), guard(exec, 'shared-guard').tick()])
  assert.equal(sent, 1)
})

test('unconfirmed CLI guard completion retains mutation and background occupancy', async () => {
  await guard(async () => undefined).tick()
  assert.equal((await reserve()).code, 'vm_operation_active')
  const row = await getDb().prepare('SELECT unknown_at, finished_at FROM background_task_runs').get()
  assert.ok(row.unknown_at)
  assert.equal(row.finished_at, null)
})

test('CLI guard keeps the VM unavailable until its actual command has ended', async () => {
  let entered
  let finish
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const stopped = new Promise((resolve) => {
    finish = resolve
  })
  const running = guard(async () => {
    entered()
    await stopped
    return { ended: true, ok: true }
  }).tick()
  await started
  try {
    assert.equal((await reserve()).code, 'vm_operation_active')
  } finally {
    finish()
    await running
  }
  const next = await reserve()
  assert.equal(next.ok, true)
  await next.release()
})
