import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { getDb, withTransaction } from '../../src/lib/db/database.mjs'
import { createRepositoryTestDatabase as createDatabase } from '../repository-database.mjs'
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
  assert.equal(vmLockBusy('/pod-a/vms/vm-a.json'), true)
  let gate
  try {
    gate = await new ExecutionAdmissionsRepo(other).tryReserve(execution())
    assert.equal(gate.ok, false)
    assert.equal(gate.code, 'vm_operation_active')
  } finally {
    await gate?.release?.()
    finish.resolve()
    await running
    assert.equal(vmLockBusy('/pod-a/vms/vm-a.json'), false)
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
  const databaseUrl = new URL('../repository-database.mjs', import.meta.url).href
  const serviceUrl = new URL('../../src/lib/vm/shared-vm-operations.mjs', import.meta.url).href
  const script = `import { createRepositoryTestDatabase as createDatabase } from ${JSON.stringify(databaseUrl)};
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

test('two independent operation owners have one winner and unrelated VMs remain available', async (t) => {
  const other = await otherDatabase(t)
  const first = await operations(getDb(), 'owner-a')
  const second = await operations(other, 'owner-b')
  const claims = await Promise.all([first.tryAcquire({ vmId: 'vm-a' }), second.tryAcquire({ vmId: 'vm-a' })])
  assert.equal(claims.filter((claim) => claim.ok).length, 1)
  assert.equal(claims.find((claim) => !claim.ok).code, 'vm_operation_active')
  const independent = await second.tryAcquire({ vmId: 'vm-b' })
  assert.equal(independent.ok, true)
  await independent.release()
  const winner = claims.find((claim) => claim.ok)
  assert.deepEqual(await winner.release(), { released: true })
  assert.deepEqual(await winner.release(), { released: true })
})

test('a failed release remains persistent and retries PostgreSQL rather than caching its rejection', async (t) => {
  const other = await otherDatabase(t)
  const first = await operations(getDb(), 'owner-a')
  const second = await operations(other, 'owner-b')
  const claim = await first.tryAcquire({ vmId: 'vm-a' })
  await getDb().exec(`CREATE FUNCTION refuse_vm_operation_release() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.released_at IS NOT NULL THEN RAISE EXCEPTION 'synthetic release failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER refuse_vm_operation_release BEFORE UPDATE ON vm_operations FOR EACH ROW EXECUTE FUNCTION refuse_vm_operation_release()`)
  await assert.rejects(claim.release(), { code: 'P0001' })
  assert.equal((await second.tryAcquire({ vmId: 'vm-a' })).code, 'vm_operation_active')
  await getDb().exec('DROP TRIGGER refuse_vm_operation_release ON vm_operations')
  assert.deepEqual(await claim.release(), { released: true })
  const next = await second.tryAcquire({ vmId: 'vm-a' })
  assert.equal(next.ok, true)
  await next.release()
})

test('different schemas cannot reuse one another nested operation context', async (t) => {
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema + '_other' })
  t.after(() => other.close())
  const first = await operations(db, 'owner-a')
  const second = await operations(other, 'owner-b')
  await first.run('vm-a', async (outer) =>
    second.run('vm-a', async (inner) => {
      assert.notEqual(inner.operationId, outer.operationId)
      assert.equal(
        (await other.prepare('SELECT count(*) AS n FROM vm_operations WHERE released_at IS NULL').get()).n,
        1,
      )
    }),
  )
})

test('a claim cannot be created in an outer transaction whose later rollback would erase ownership', async () => {
  const service = await operations(getDb(), 'owner-a')
  let called = false
  await assert.rejects(
    withTransaction(getDb(), () =>
      service.run('vm-a', () => {
        called = true
      }),
    ),
    { code: 'vm_operation_transaction_active' },
  )
  assert.equal(called, false)
  assert.equal((await getDb().prepare('SELECT count(*) AS n FROM vm_operations').get()).n, 0)
})

test('async work escaping a finished callback cannot reuse its old claim', async (t) => {
  const other = await otherDatabase(t)
  const first = await operations(getDb(), 'owner-a')
  const second = await operations(other, 'owner-b')
  const proceed = deferred()
  let late
  await first.run('vm-a', async () => {
    late = proceed.promise.then(() => first.run('vm-a', () => 'unexpected callback'))
  })
  const current = await second.tryAcquire({ vmId: 'vm-a' })
  proceed.resolve()
  await assert.rejects(late, { code: 'vm_operation_active' })
  await current.release()
})

test('async work escaping a failed callback cannot reuse the claim while uncertainty is being persisted', async (t) => {
  const other = await otherDatabase(t)
  const first = await operations(getDb(), 'owner-a')
  const second = await operations(other, 'owner-b')
  const mark = first.markUncertain.bind(first)
  const marking = deferred()
  const finish = deferred()
  const proceed = deferred()
  first.markUncertain = async (identity) => {
    marking.resolve()
    await finish.promise
    return mark(identity)
  }
  let late
  const failed = assert.rejects(
    first.run('vm-a', async () => {
      late = proceed.promise.then(() => second.run('vm-a', () => 'unexpected callback'))
      throw new Error('synthetic callback failure')
    }),
    /synthetic callback failure/,
  )
  await marking.promise
  proceed.resolve()
  try {
    await assert.rejects(late, { code: 'vm_operation_active' })
  } finally {
    finish.resolve()
    await failed
  }
})

test('an explicitly supplied VM id still rejects reserved file identities', async (t) => {
  kubernetes(t)
  await assert.rejects(
    withVmLock('explicit-key', () => {}, { vmId: 'active' }),
    { code: 'invalid_vm_operation' },
  )
})
