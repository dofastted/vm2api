import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { withVmLock, vmLockBusy } from '../../src/lib/vm/vm-file.mjs'

function kubernetes(t) {
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(() => {
    if (previous === undefined) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
  })
}

async function otherDatabase(t) {
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => other.close())
  return other
}

async function operations(db, ownerId) {
  const { SharedVmOperations } = await import('../../src/lib/vm/shared-vm-operations.mjs')
  return new SharedVmOperations(db, { ownerId })
}

function execution(patch = {}) {
  return { accountId: 'account-a', vmId: 'vm-a', accountLimit: 20, vmLimit: 20, fableLimit: 0, rpmLimit: 0, ...patch }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('Kubernetes VM mutation refuses an active execution on another PG connection', async (t) => {
  kubernetes(t)
  const other = await otherDatabase(t)
  const gate = await new ExecutionAdmissionsRepo(other).tryReserve(execution())
  let called = false
  try {
    await assert.rejects(
      withVmLock('/pod-a/vms/vm-a.json', () => {
        called = true
      }),
      { code: 'vm_execution_active', status: 409 },
    )
    assert.equal(called, false)
  } finally {
    await gate.release()
  }
})

test('an active Kubernetes VM mutation blocks new execution on another PG connection', async (t) => {
  kubernetes(t)
  const other = await otherDatabase(t)
  const entered = deferred()
  const finish = deferred()
  const running = withVmLock('/pod-a/vms/vm-a.json', async () => {
    entered.resolve()
    await finish.promise
  })
  await entered.promise
  let gate
  try {
    gate = await new ExecutionAdmissionsRepo(other).tryReserve(execution())
    assert.equal(gate.ok, false)
    assert.equal(gate.code, 'vm_operation_active')
  } finally {
    await gate?.release?.()
    finish.resolve()
    await running
  }
})

test('different Pod paths identify the same VM mutation resource', async (t) => {
  kubernetes(t)
  await otherDatabase(t)
  const entered = deferred()
  const finish = deferred()
  const running = withVmLock('/pod-a/vms/vm-a.json', async () => {
    entered.resolve()
    await finish.promise
  })
  await entered.promise
  try {
    await assert.rejects(
      withVmLock('/pod-b/vms/vm-a.json', () => {}),
      { code: 'vm_operation_active', status: 409 },
    )
  } finally {
    finish.resolve()
    await running
  }
})

test('concurrent operation and execution admission cannot both acquire the same VM', async (t) => {
  const other = await otherDatabase(t)
  const first = await operations(getDb(), 'owner-a')
  const second = new ExecutionAdmissionsRepo(other)
  for (let i = 0; i < 8; i++) {
    const vmId = `race-${i}`
    const [operation, admission] = await Promise.all([
      first.tryAcquire({ vmId }),
      second.tryReserve(execution({ vmId })),
    ])
    assert.equal(Number(operation.ok) + Number(admission.ok), 1)
    if (operation.ok) {
      assert.equal(admission.code, 'vm_operation_active')
      await operation.release()
    } else {
      assert.equal(operation.code, 'vm_execution_active')
      await admission.release()
    }
  }
})

test('same-VM nested callbacks reuse one persistent operation and preserve callback values', async (t) => {
  kubernetes(t)
  const other = await otherDatabase(t)
  const first = await operations(getDb(), 'owner-a')
  const second = await operations(other, 'owner-b')
  const result = await first.run('vm-a', async (outer) => {
    return withVmLock(
      '/another-pod/vms/vm-a.json',
      async (inner) => {
        assert.equal(inner.operationId, outer.operationId)
        assert.equal(
          (await other.prepare('SELECT count(*) AS n FROM vm_operations WHERE released_at IS NULL').get()).n,
          1,
        )
        return 42
      },
      { operations: second },
    )
  })
  assert.equal(result, 42)
  assert.equal((await getDb().prepare('SELECT count(*) AS n FROM vm_operations WHERE released_at IS NULL').get()).n, 0)
})

test('normal completion releases, exceptions and explicit uncertainty retain the VM without TTL', async (t) => {
  const other = await otherDatabase(t)
  const first = await operations(getDb(), 'owner-a')
  const second = await operations(other, 'owner-b')
  await first.run('vm-normal', async () => 'done')
  const next = await second.tryAcquire({ vmId: 'vm-normal' })
  assert.equal(next.ok, true)
  await next.release()
  await assert.rejects(
    first.run('vm-error', async () => {
      throw new Error('synthetic unknown remote result')
    }),
    /synthetic unknown/,
  )
  await first.run('vm-unknown', async () => ({ vmOperationUncertain: true }))
  await getDb().prepare("UPDATE vm_operations SET created_at = clock_timestamp() - interval '10 years'").run()
  for (const vmId of ['vm-error', 'vm-unknown']) {
    assert.equal((await second.tryAcquire({ vmId })).code, 'vm_operation_active')
    assert.equal((await new ExecutionAdmissionsRepo(other).tryReserve(execution({ vmId }))).code, 'vm_operation_active')
  }
})

test('explicitly known not-started errors release and rethrow, while unknown release never frees capacity', async (t) => {
  const other = await otherDatabase(t)
  const first = await operations(getDb(), 'owner-a')
  const second = await operations(other, 'owner-b')
  await assert.rejects(
    first.run('vm-safe', () => {
      throw Object.assign(new Error('validation failed'), { vmOperationNotStarted: true })
    }),
    /validation failed/,
  )
  const next = await second.tryAcquire({ vmId: 'vm-safe' })
  assert.equal(next.ok, true)
  assert.deepEqual(await first.release({ operationId: next.operationId, ownerId: 'owner-a' }), { released: false })
  await next.markUncertain()
  assert.deepEqual(await next.release(), { released: false })
  assert.equal((await first.tryAcquire({ vmId: 'vm-safe' })).code, 'vm_operation_active')
})

test('closing the owner PG connection leaves the committed operation unavailable', async (t) => {
  const other = await otherDatabase(t)
  const owner = await operations(other, 'owner-b')
  const observer = await operations(getDb(), 'owner-a')
  assert.equal((await owner.tryAcquire({ vmId: 'vm-disconnected' })).ok, true)
  await other.close()
  assert.equal((await observer.tryAcquire({ vmId: 'vm-disconnected' })).code, 'vm_operation_active')
})

test('SIGKILL of an operation owner does not make its VM available', async (t) => {
  const observer = await operations(getDb(), 'observer')
  const databaseUrl = new URL('../../src/lib/db/database.mjs', import.meta.url).href
  const serviceUrl = new URL('../../src/lib/vm/shared-vm-operations.mjs', import.meta.url).href
  const script = `import { createDatabase } from ${JSON.stringify(databaseUrl)};
    import { SharedVmOperations } from ${JSON.stringify(serviceUrl)};
    const db = await createDatabase({ connectionString: process.env.VM2API_TEST_DATABASE_URL, schema: process.env.KIN_DATABASE_SCHEMA });
    const claim = await new SharedVmOperations(db, { ownerId: 'killed-owner' }).tryAcquire({ vmId: 'vm-killed' });
    process.stdout.write(JSON.stringify({ ok: claim.ok }) + '\\n');
    setInterval(() => {}, 1000);`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGKILL'))
  const lines = createInterface({ input: child.stdout })
  const ready = await Promise.race([
    once(lines, 'line').then(([line]) => JSON.parse(line)),
    once(child, 'exit').then(() => {
      throw new Error('owner exited before claim')
    }),
  ])
  assert.equal(ready.ok, true)
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  assert.equal((await observer.tryAcquire({ vmId: 'vm-killed' })).code, 'vm_operation_active')
})

test('Kubernetes canonical key validation and PG failures never execute a local fallback', async (t) => {
  kubernetes(t)
  let called = false
  await assert.rejects(
    withVmLock('/pod-a/elsewhere/vm-a.json', () => {
      called = true
    }),
    { code: 'invalid_vm_operation' },
  )
  const other = await otherDatabase(t)
  const service = await operations(other, 'owner-b')
  await other.close()
  await assert.rejects(
    withVmLock(
      'explicit-key',
      () => {
        called = true
      },
      { operations: service, vmId: 'vm-a' },
    ),
  )
  assert.equal(called, false)
  assert.equal(vmLockBusy('explicit-key'), false)
})
