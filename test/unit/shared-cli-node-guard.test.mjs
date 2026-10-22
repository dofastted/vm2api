import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { getDb } from '../../src/lib/db/database.mjs'
import { SharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { createCliNodeGuard, runCliNodeGuardCommand } from '../../src/lib/vm/cli-node-guard.mjs'

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

async function engine(t, states, { createStatus = 201, startStatus = 200 } = {}) {
  const execId = 'a'.repeat(64)
  const calls = []
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume the Docker request */
    }
    calls.push(req.url)
    let body
    if (req.url.endsWith('/exec')) {
      res.statusCode = createStatus
      body = { Id: execId }
    } else if (req.url.endsWith('/start')) {
      res.statusCode = startStatus
      body = {}
    } else body = states.length > 1 ? states.shift() : states[0]
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  const connect = () =>
    new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, '127.0.0.1')
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
  return { calls, connect, execId }
}

test('the actual guard executor waits for immutable exec inspection after a start acknowledgement', async (t) => {
  const fx = await engine(t, [
    { Running: true, ExitCode: 0 },
    { Running: false, ExitCode: 0 },
  ])
  const result = await runCliNodeGuardCommand(fx.connect, 'kin-synthetic', ['synthetic'], { pollMs: 1 })
  assert.equal(result.ended, true)
  assert.equal(result.execId, fx.execId)
  assert.deepEqual(fx.calls, [
    '/containers/kin-synthetic/exec',
    `/exec/${fx.execId}/start`,
    `/exec/${fx.execId}/json`,
    `/exec/${fx.execId}/json`,
  ])
})

test('guard executor timeout leaves a running Docker exec unconfirmed', async (t) => {
  const fx = await engine(t, [{ Running: true, ExitCode: 0 }])
  const result = await runCliNodeGuardCommand(fx.connect, 'kin-synthetic', ['synthetic'], { timeoutMs: 0 })
  assert.equal(result.ended, false)
  assert.equal(result.ok, false)
})

for (const createStatus of [404, 409]) {
  test(`a complete Docker create-exec ${createStatus} rejection is proven not started`, async (t) => {
    const fx = await engine(t, [], { createStatus })
    await guard(() => runCliNodeGuardCommand(fx.connect, 'kin-synthetic', ['synthetic'])).tick()
    assert.deepEqual(fx.calls, ['/containers/kin-synthetic/exec'])
    const next = await reserve()
    assert.equal(next.ok, true)
    await next.release()
    const row = await getDb().prepare('SELECT unknown_at, finished_at FROM background_task_runs').get()
    assert.equal(row.unknown_at, null)
    assert.ok(row.finished_at)
  })
}

test('a start-exec 404 remains unknown after an exec was created', async (t) => {
  const fx = await engine(t, [], { startStatus: 404 })
  await guard(() => runCliNodeGuardCommand(fx.connect, 'kin-synthetic', ['synthetic'])).tick()
  assert.equal((await reserve()).code, 'vm_operation_active')
})
