import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase, getDb, withSavepoint, withTransaction } from '../../src/lib/db/database.mjs'

async function replicas() {
  const { ExecutionAdmissionsRepo } = await import('../../src/lib/db/repos/execution-admissions-repo.mjs')
  const db = getDb()
  const other = await createDatabase({ connectionString: process.env.VM2API_TEST_DATABASE_URL, schema: db.schema })
  return [
    new ExecutionAdmissionsRepo(db, { ownerId: 'controller-a' }),
    new ExecutionAdmissionsRepo(other, { ownerId: 'controller-b' }),
  ]
}

function candidate(patch = {}) {
  return { accountId: 'account-1', vmId: 'vm-1', accountLimit: 8, vmLimit: 8, fableLimit: 0, rpmLimit: 0, ...patch }
}

test('replicas share account concurrency across different VMs', async () => {
  const repos = await replicas()
  const gates = await Promise.all(
    Array.from({ length: 12 }, (_, i) => repos[i % 2].tryReserve(candidate({ accountLimit: 1, vmId: `vm-${i}` }))),
  )
  assert.equal(gates.filter((gate) => gate.ok).length, 1)
  assert.ok(gates.filter((gate) => !gate.ok).every((gate) => gate.code === 'concurrency_limit'))
  assert.equal((await repos[1].getCounts(candidate())).accountInflight, 1)
  await gates.find((gate) => gate.ok).release()
})

test('replicas share VM concurrency across different accounts', async () => {
  const repos = await replicas()
  const gates = await Promise.all(
    Array.from({ length: 12 }, (_, i) => repos[i % 2].tryReserve(candidate({ accountId: `account-${i}`, vmLimit: 2 }))),
  )
  assert.equal(gates.filter((gate) => gate.ok).length, 2)
  assert.ok(gates.filter((gate) => !gate.ok).every((gate) => gate.code === 'vm_concurrency_limit'))
  assert.equal((await repos[0].getCounts(candidate())).vmInflight, 2)
  await Promise.all(gates.filter((gate) => gate.ok).map((gate) => gate.release()))
})

test('Fable concurrency is an account sublimit and leaves room for ordinary models', async () => {
  const [first, second] = await replicas()
  const fable = candidate({ accountLimit: 3, fableLimit: 1, family: 'fable' })
  const gate = await first.tryReserve(fable)
  assert.equal(gate.ok, true)
  assert.equal((await second.tryReserve({ ...fable, vmId: 'vm-other' })).code, 'fable_concurrency')
  const regular = await second.tryReserve({ ...fable, vmId: 'vm-other', family: null })
  assert.equal(regular.ok, true)
  const counts = await second.getCounts(candidate())
  assert.equal(counts.accountInflight, 2)
  assert.equal(counts.fableInflight, 1)
  await gate.release()
  await regular.release()
})

test('account RPM includes released admissions on other VMs until the window ends', async () => {
  const [first, second] = await replicas()
  const input = candidate({ rpmLimit: 1 })
  const gate = await first.tryReserve(input)
  await gate.release()
  const denied = await second.tryReserve({ ...input, vmId: 'vm-other' })
  assert.equal(denied.code, 'rpm_limit')
  assert.ok(denied.retry_after_ms > 0 && denied.retry_after_ms <= 60_000)
  const counts = await second.getCounts(input)
  assert.equal(counts.accountInflight, 0)
  assert.equal(counts.rpmCount, 1)
  assert.ok(counts.rpmResetAt > Date.now())
  await first.db.prepare("UPDATE execution_admissions SET created_at = clock_timestamp() - interval '61 seconds'").run()
  const next = await second.tryReserve(input)
  assert.equal(next.ok, true)
  assert.equal((await second.db.prepare('SELECT count(*) AS count FROM execution_admissions').get()).count, 1)
  await next.release()
})

test('zero concurrency rejects while zero RPM and Fable sublimits are unlimited', async () => {
  const [first] = await replicas()
  assert.equal((await first.tryReserve(candidate({ accountLimit: 0 }))).code, 'concurrency_limit')
  assert.equal((await first.tryReserve(candidate({ vmLimit: 0 }))).code, 'vm_concurrency_limit')
  const gates = []
  for (let i = 0; i < 4; i++) {
    const gate = await first.tryReserve(candidate({ family: 'fable', fableLimit: 0, rpmLimit: 0 }))
    assert.equal(gate.ok, true)
    gates.push(gate)
  }
  await Promise.all(gates.map((gate) => gate.release()))
})

test('missing and invalid limits reject without creating an admission or RPM event', async () => {
  const [first] = await replicas()
  for (const field of ['accountLimit', 'vmLimit', 'fableLimit', 'rpmLimit']) {
    for (const value of [undefined, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(first.tryReserve(candidate({ [field]: value })), { code: 'invalid_execution_admission' })
    }
  }
  assert.equal((await first.db.prepare('SELECT count(*) AS count FROM execution_admissions').get()).count, 0)
})

test('a VM refusal does not consume the account RPM budget', async () => {
  const [first, second] = await replicas()
  const held = await first.tryReserve(candidate({ accountId: 'account-held', vmLimit: 1 }))
  assert.equal((await second.tryReserve(candidate({ rpmLimit: 1, vmLimit: 1 }))).code, 'vm_concurrency_limit')
  assert.equal((await second.getCounts(candidate())).rpmCount, 0)
  const accepted = await second.tryReserve(candidate({ vmId: 'vm-free', rpmLimit: 1, vmLimit: 1 }))
  assert.equal(accepted.ok, true)
  await held.release()
  await accepted.release()
})

test('release is idempotent and cannot release a later request or another owner', async () => {
  const [first, second] = await replicas()
  const input = candidate({ accountLimit: 1 })
  const held = await first.tryReserve(input)
  await second.release({ admissionId: held.admissionId, ownerId: 'controller-b' })
  assert.equal((await second.tryReserve(input)).code, 'concurrency_limit')
  await Promise.all([held.release(), held.release()])
  const next = await second.tryReserve(input)
  assert.equal(next.ok, true)
  await held.release()
  assert.equal((await first.tryReserve(input)).code, 'concurrency_limit')
  await next.release()
})

test('uncertain executions remain active after release attempts, aging and connection loss', async () => {
  const [first, second] = await replicas()
  const input = candidate({ accountLimit: 1, family: 'fable', fableLimit: 1 })
  const held = await second.tryReserve(input)
  await held.markUncertain()
  await held.release()
  await first.db.prepare("UPDATE execution_admissions SET created_at = clock_timestamp() - interval '2 hours'").run()
  await second.db.close()
  assert.equal((await first.tryReserve(input)).code, 'concurrency_limit')
  const counts = await first.getCounts(input)
  assert.equal(counts.accountInflight, 1)
  assert.equal(counts.vmInflight, 1)
  assert.equal(counts.fableInflight, 1)
  assert.equal(counts.rpmCount, 0)
  const row = await first.db
    .prepare('SELECT owner_id, uncertain_at, released_at FROM execution_admissions WHERE id = $1')
    .get(held.admissionId)
  assert.equal(row.owner_id, 'controller-b')
  assert.ok(row.uncertain_at)
  assert.equal(row.released_at, null)
})

test('release with an uncertain outcome persists the hold before any later release', async () => {
  const [first, second] = await replicas()
  const held = await first.tryReserve(candidate({ accountLimit: 1 }))
  await held.release({ uncertain: true })
  await held.release()
  assert.equal((await second.tryReserve(candidate({ accountLimit: 1 }))).code, 'concurrency_limit')
})

test('admission and RPM creation roll back with an enclosing seat transaction', async () => {
  const [first, second] = await replicas()
  await assert.rejects(
    withTransaction(first.db, async () => {
      const held = await first.tryReserve(candidate({ accountLimit: 1, rpmLimit: 1 }))
      assert.equal(held.ok, true)
      throw new Error('seat unavailable')
    }),
    /seat unavailable/,
  )
  assert.deepEqual(await second.getCounts(candidate()), {
    accountInflight: 0,
    vmInflight: 0,
    fableInflight: 0,
    rpmCount: 0,
    rpmResetAt: null,
  })
  const next = await second.tryReserve(candidate({ accountLimit: 1, rpmLimit: 1 }))
  assert.equal(next.ok, true)
  await next.release()
})

test('accepted requests persist their correlation and optional seat binding', async () => {
  const [first, second] = await replicas()
  const held = await first.tryReserve(candidate({ requestId: 'request-http-1' }))
  assert.equal(held.ownerId, 'controller-a')
  assert.equal(held.requestId, 'request-http-1')
  await first.db
    .prepare('UPDATE execution_admissions SET seat_key = $1, seat_generation = $2, slot_index = $3 WHERE id = $4')
    .run('seat-device-1', 'seat-generation-1', 2, held.admissionId)
  const row = await second.db.prepare('SELECT * FROM execution_admissions WHERE id = $1').get(held.admissionId)
  assert.equal(row.request_id, held.requestId)
  assert.equal(row.account_id, 'account-1')
  assert.equal(row.vm_id, 'vm-1')
  assert.equal(row.seat_key, 'seat-device-1')
  assert.equal(row.seat_generation, 'seat-generation-1')
  assert.equal(row.slot_index, 2)
  await held.release()
})

test('a shared database failure never creates an in-memory fallback admission', async () => {
  const [first, second] = await replicas()
  await second.db.close()
  await assert.rejects(second.tryReserve(candidate()), /database is closed/)
  assert.equal((await first.getCounts(candidate())).accountInflight, 0)
})

test('simultaneous admissions atomically reserve account RPM across replicas', async () => {
  const repos = await replicas()
  const input = candidate({ accountLimit: 20, vmLimit: 20, rpmLimit: 3 })
  const gates = await Promise.all(
    Array.from({ length: 12 }, (_, i) => repos[i % 2].tryReserve({ ...input, vmId: `vm-${i}` })),
  )
  assert.equal(gates.filter((gate) => gate.ok).length, 3)
  assert.ok(gates.filter((gate) => !gate.ok).every((gate) => gate.code === 'rpm_limit'))
  await Promise.all(gates.filter((gate) => gate.ok).map((gate) => gate.release()))
  assert.equal((await repos[1].getCounts(input)).rpmCount, 3)
})

test('simultaneous Fable requests share their sublimit across VMs and replicas', async () => {
  const repos = await replicas()
  const input = candidate({ accountLimit: 20, vmLimit: 20, fableLimit: 2, family: 'fable' })
  const gates = await Promise.all(
    Array.from({ length: 12 }, (_, i) => repos[i % 2].tryReserve({ ...input, vmId: `vm-${i}` })),
  )
  assert.equal(gates.filter((gate) => gate.ok).length, 2)
  assert.ok(gates.filter((gate) => !gate.ok).every((gate) => gate.code === 'fable_concurrency'))
  assert.equal((await repos[1].getCounts(input)).fableInflight, 2)
  await Promise.all(gates.filter((gate) => gate.ok).map((gate) => gate.release()))
})

test('a refused seat can roll back admission in a savepoint and try another VM', async () => {
  const [first, second] = await replicas()
  let accepted
  await withTransaction(first.db, async () => {
    await assert.rejects(
      withSavepoint(first.db, async () => {
        const deniedSeat = await first.tryReserve(candidate({ accountLimit: 1, rpmLimit: 1 }))
        assert.equal(deniedSeat.ok, true)
        throw new Error('first VM has no seat')
      }),
      /first VM has no seat/,
    )
    accepted = await first.tryReserve(candidate({ vmId: 'vm-other', accountLimit: 1, rpmLimit: 1 }))
    assert.equal(accepted.ok, true)
  })
  const counts = await second.getCounts(candidate({ vmId: 'vm-other' }))
  assert.equal(counts.accountInflight, 1)
  assert.equal(counts.rpmCount, 1)
  await accepted.release()
})

test('resource locks compose with seat transactions and leave unrelated resources available', async () => {
  const [first, second] = await replicas()
  await assert.rejects(first.lockVm('vm-1'), { code: 'execution_transaction_required' })
  await withTransaction(first.db, async () => {
    await first.lockResources({ accountId: 'account-1', vmIds: ['vm-2', 'vm-1'] })
    await first.lockVm('vm-1')
    await withTransaction(second.db, async () => {
      for (const [resource, expected] of [
        ['account:account-1', false],
        ['vm:vm-1', false],
        ['vm:vm-2', false],
        ['vm:vm-unrelated', true],
      ]) {
        const result = await second.db
          .prepare('SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS locked')
          .get(`vm2api:execution:${first.db.schema}`, resource)
        assert.equal(result.locked, expected, resource)
      }
    })
  })
})
