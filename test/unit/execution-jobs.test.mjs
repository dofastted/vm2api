import test from 'node:test'
import assert from 'node:assert/strict'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { createDatabase, getDb, withTransaction } from '../../src/lib/db/database.mjs'

async function replicas() {
  const db = getDb()
  const other = await createDatabase({ connectionString: process.env.VM2API_TEST_DATABASE_URL, schema: db.schema })
  return [
    new ExecutionAdmissionsRepo(db, { ownerId: 'controller-a' }),
    new ExecutionAdmissionsRepo(other, { ownerId: 'controller-b' }),
  ]
}
function candidate(patch = {}) {
  return { accountId: 'account-1', vmId: 'vm-1', accountLimit: 8, vmLimit: 8, rpmLimit: 0, fableLimit: 0, ...patch }
}
function completed(requestId, patch = {}) {
  return { requestId, started: true, ended: true, reason: 'eof', ...patch }
}

test('a persisted pending job prevents release until matching execution completion', async () => {
  const [first, second] = await replicas()
  const held = await first.tryReserve(candidate())
  assert.deepEqual(await held.bindExecution({ requestId: 'hop-1' }), {
    bound: true,
    admissionId: held.admissionId,
    requestId: 'hop-1',
  })
  const job = await second.db.prepare('SELECT * FROM execution_jobs WHERE request_id = $1').get('hop-1')
  assert.equal(job.admission_id, held.admissionId)
  assert.equal(job.ended_at, null)
  assert.equal(job.started, null, 'binding precedes submission and cannot prove that execution has started')
  assert.equal((await held.release()).released, false)
  assert.equal((await second.getCounts(candidate())).accountInflight, 1)
  assert.deepEqual(await held.completeExecution(completed('hop-1')), {
    ended: true,
    uncertain: false,
    requestId: 'hop-1',
  })
  assert.equal((await held.release()).released, true)
  assert.equal((await second.getCounts(candidate())).accountInflight, 0)
})

test('independent connections cannot bind two pending jobs to one admission', async () => {
  const [first, second] = await replicas()
  const held = await first.tryReserve(candidate())
  const results = await Promise.allSettled([
    first.bindExecution(held, { requestId: 'hop-a' }),
    second.bindExecution(held, { requestId: 'hop-b' }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'execution_job_pending')
  assert.equal((await first.db.prepare('SELECT count(*) AS count FROM execution_jobs').get()).count, 1)
  assert.equal((await held.release()).released, false)
})

test('a hop ID is globally unique across admissions and owners', async () => {
  const [first, second] = await replicas()
  const a = await first.tryReserve(candidate())
  const b = await second.tryReserve(candidate())
  await a.bindExecution({ requestId: 'shared-hop' })
  await assert.rejects(b.bindExecution({ requestId: 'shared-hop' }), { code: 'execution_job_exists' })
  assert.equal((await b.release()).released, true)
  assert.equal((await a.release()).released, false)
})

test('uncertain execution persists its job and admission and cannot be automatically cleared by late completion', async () => {
  const [first, second] = await replicas()
  const held = await first.tryReserve(candidate({ accountLimit: 1 }))
  await held.bindExecution({ requestId: 'uncertain-hop' })
  assert.deepEqual(
    await held.completeExecution(completed('uncertain-hop', { ended: false, reason: 'transport_error' })),
    { ended: false, uncertain: true, requestId: 'uncertain-hop' },
  )
  assert.equal((await held.release()).released, false)
  assert.equal((await second.tryReserve(candidate({ accountLimit: 1 }))).code, 'concurrency_limit')
  const late = await held.completeExecution(completed('uncertain-hop'))
  assert.equal(late.ended, true)
  assert.equal(late.uncertain, true)
  assert.equal((await held.release()).released, false)
  await assert.rejects(held.bindExecution({ requestId: 'late-next-hop' }), { code: 'execution_admission_inactive' })
})

test('missing or malformed completion metadata preserves the pending job and marks uncertainty', async () => {
  const [first, second] = await replicas()
  for (const [i, metadata] of [
    undefined,
    {},
    { requestId: 'missing' },
    { requestId: 'missing', started: true, ended: 1, reason: 'eof' },
  ].entries()) {
    const held = await first.tryReserve(candidate({ accountId: `account-${i}`, vmId: `vm-${i}` }))
    await held.bindExecution({ requestId: `hop-${i}` })
    await assert.rejects(held.completeExecution(metadata), { code: 'invalid_execution_job' })
    assert.equal((await held.release()).released, false)
    const row = await second.db
      .prepare('SELECT uncertain_at FROM execution_admissions WHERE id = $1')
      .get(held.admissionId)
    assert.ok(row.uncertain_at)
    assert.equal(
      (await second.db.prepare('SELECT ended_at FROM execution_jobs WHERE request_id = $1').get(`hop-${i}`)).ended_at,
      null,
    )
  }
})

test('completion cannot close a job belonging to another admission', async () => {
  const [first, second] = await replicas()
  const a = await first.tryReserve(candidate())
  const b = await second.tryReserve(candidate())
  await a.bindExecution({ requestId: 'hop-a' })
  await b.bindExecution({ requestId: 'hop-b' })
  await assert.rejects(a.completeExecution(completed('hop-b')), { code: 'execution_job_mismatch' })
  assert.equal(
    (await second.db.prepare('SELECT ended_at FROM execution_jobs WHERE request_id = $1').get('hop-b')).ended_at,
    null,
  )
  assert.equal((await b.release()).released, false)
  assert.equal(
    (await second.db.prepare('SELECT uncertain_at FROM execution_admissions WHERE id = $1').get(b.admissionId))
      .uncertain_at,
    null,
  )
})

test('late completion of an earlier job cannot release or change a later pending job', async () => {
  const [first, second] = await replicas()
  const held = await first.tryReserve(candidate())
  await held.bindExecution({ requestId: 'hop-first' })
  await held.completeExecution(completed('hop-first'))
  await held.bindExecution({ requestId: 'hop-next' })
  assert.equal((await held.completeExecution(completed('hop-first'))).ended, true)
  assert.equal((await held.release()).released, false)
  assert.equal(
    (await second.db.prepare('SELECT ended_at FROM execution_jobs WHERE request_id = $1').get('hop-next')).ended_at,
    null,
  )
  await held.completeExecution(completed('hop-next'))
  assert.equal((await held.release()).released, true)
})

test('a wrong owner cannot bind, complete or release another controller execution', async () => {
  const [first, second] = await replicas()
  const held = await first.tryReserve(candidate())
  const wrong = { admissionId: held.admissionId, ownerId: 'controller-b' }
  await assert.rejects(second.bindExecution(wrong, { requestId: 'hop-wrong' }), {
    code: 'execution_admission_inactive',
  })
  await held.bindExecution({ requestId: 'hop-owner' })
  await assert.rejects(second.completeExecution(wrong, completed('hop-owner')), {
    code: 'execution_admission_inactive',
  })
  assert.equal((await second.release(wrong)).released, false)
  assert.equal(
    (await second.db.prepare('SELECT uncertain_at FROM execution_admissions WHERE id = $1').get(held.admissionId))
      .uncertain_at,
    null,
  )
})

test('mock and explicitly unstarted jobs can complete only through their matching hop ID', async () => {
  const [first] = await replicas()
  for (const reason of ['mock', 'not_started']) {
    const held = await first.tryReserve(candidate())
    await held.bindExecution({ requestId: `hop-${reason}` })
    assert.equal((await held.completeExecution(completed(`hop-${reason}`, { started: false, reason }))).ended, true)
    const row = await first.db
      .prepare('SELECT started, ended_at FROM execution_jobs WHERE request_id = $1')
      .get(`hop-${reason}`)
    assert.equal(row.started, false)
    assert.ok(row.ended_at)
    assert.equal((await held.release()).released, true)
  }
})

test('aging and closing the binding connection cannot remove or release a pending job', async () => {
  const [first, second] = await replicas()
  const held = await second.tryReserve(candidate({ accountLimit: 1 }))
  await held.bindExecution({ requestId: 'old-hop' })
  await first.db.exec("UPDATE execution_jobs SET created_at = clock_timestamp() - interval '2 days'")
  await first.db.exec("UPDATE execution_admissions SET created_at = clock_timestamp() - interval '2 days'")
  await second.db.close()
  assert.equal((await first.tryReserve(candidate({ accountLimit: 1 }))).code, 'concurrency_limit')
  assert.equal((await first.release(held)).released, false)
  assert.equal(
    (await first.db.prepare('SELECT count(*) AS count FROM execution_jobs WHERE ended_at IS NULL').get()).count,
    1,
  )
})

test('a database failure during completion retains both the pending job and admission', async () => {
  const [first, second] = await replicas()
  const held = await first.tryReserve(candidate())
  await held.bindExecution({ requestId: 'failure-hop' })
  await first.db.exec(`CREATE FUNCTION reject_job_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated completion database failure' USING ERRCODE = 'P0001'; END $$;
    CREATE TRIGGER reject_job_completion BEFORE UPDATE OF ended_at ON execution_jobs
    FOR EACH ROW EXECUTE FUNCTION reject_job_completion();`)
  await assert.rejects(held.completeExecution(completed('failure-hop')), { code: 'P0001' })
  assert.equal(
    (await second.db.prepare('SELECT ended_at FROM execution_jobs WHERE request_id = $1').get('failure-hop')).ended_at,
    null,
  )
  assert.equal((await held.release()).released, false)
  assert.equal((await second.getCounts(candidate())).accountInflight, 1)
})

test('release waits for a concurrent binding transaction before checking pending jobs', async () => {
  const [first, second] = await replicas()
  const held = await first.tryReserve(candidate())
  let bound
  const waiting = new Promise((resolve) => {
    bound = resolve
  })
  let commit
  const proceed = new Promise((resolve) => {
    commit = resolve
  })
  const binding = withTransaction(first.db, async () => {
    await held.bindExecution({ requestId: 'race-hop' })
    bound()
    await proceed
  })
  await waiting
  let releaseEntered
  const entered = new Promise((resolve) => {
    releaseEntered = resolve
  })
  const query = second.db.query.bind(second.db)
  second.db.query = (...args) => {
    const result = query(...args)
    if (args[0].includes('execution_admissions')) releaseEntered()
    return result
  }
  const release = second.release(held)
  await entered
  commit()
  await binding
  assert.equal((await release).released, false)
  assert.equal(
    (await first.db.prepare('SELECT released_at FROM execution_admissions WHERE id = $1').get(held.admissionId))
      .released_at,
    null,
  )
})
