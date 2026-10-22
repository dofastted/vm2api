import test from 'node:test'
import assert from 'node:assert/strict'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { callGoWorker } from '../../src/lib/transport/go-worker-client.mjs'
import { fakeSlotgate, syntheticFence } from '../fixtures/fake-slotgate.mjs'
import { realSlotgate } from '../fixtures/real-slotgate.mjs'

const candidate = {
  accountId: 'synthetic-account',
  vmId: 'vm-synthetic',
  accountLimit: 1,
  vmLimit: 1,
  rpmLimit: 0,
  fableLimit: 0,
}

async function fixture(t, options) {
  const gate = await fakeSlotgate(t, options)
  const db = getDb()
  const otherDb = await createDatabase({ connectionString: process.env.VM2API_TEST_DATABASE_URL, schema: db.schema })
  const first = new ExecutionAdmissionsRepo(db, { ownerId: 'synthetic-controller-a' })
  const second = new ExecutionAdmissionsRepo(otherDb, { ownerId: 'synthetic-controller-b' })
  const lease = await first.tryReserve(candidate)
  assert.equal(lease.ok, true)
  return {
    ...gate,
    db,
    second,
    lease,
    async run() {
      const result = await callGoWorker({
        exec: { vmId: candidate.vmId, slotgate: gate.config },
        requestId: 'synthetic-fenced-job',
        envelope: { body: {} },
        onExecutionStart: lease.bindExecution,
      })
      await lease.completeExecution(result.execution)
      return result
    },
  }
}

test('two PG connections observe the original node binding before forwarding and completion before release', async (t) => {
  const fx = await fixture(t)
  const result = await fx.run()
  const row = await fx.second.db
    .prepare('SELECT * FROM execution_jobs WHERE request_id = $1')
    .get('synthetic-fenced-job')
  assert.deepEqual(row.node_binding, result.execution.nodeBinding)
  assert.deepEqual(row.node_completion, result.execution.nodeCompletion)
  assert.equal(row.node_binding.fence.generation, '1')
  assert.ok(row.ended_at)
  assert.equal((await fx.lease.release()).released, true)
  assert.equal((await fx.second.tryReserve(candidate)).ok, true)
})

test('an HTTP success without durable node status retains shared PG capacity', async (t) => {
  const fx = await fixture(t, { status: { ok: false, error: 'authority_unavailable' } })
  const result = await fx.run()
  assert.equal(result.execution.ended, false)
  assert.equal((await fx.lease.release()).released, false)
  assert.equal((await fx.second.tryReserve(candidate)).code, 'concurrency_limit')
  const job = await fx.second.db
    .prepare('SELECT * FROM execution_jobs WHERE request_id = $1')
    .get('synthetic-fenced-job')
  assert.equal(job.ended_at, null)
  assert.equal(job.node_completion, null)
})

test('PG completion refuses a local EOF or a different generation for a node-bound job', async (t) => {
  const fx = await fixture(t)
  const nodeBinding = {
    protocol: 'KSG2',
    nodeId: fx.config.nodeId,
    vmId: candidate.vmId,
    kind: 'kernel',
    fence: syntheticFence(),
  }
  await fx.lease.bindExecution({ requestId: 'synthetic-job', nodeBinding })
  await assert.rejects(
    fx.lease.completeExecution({ requestId: 'synthetic-job', nodeBinding, started: true, ended: true, reason: 'eof' }),
  )
  await assert.rejects(
    fx.lease.completeExecution({
      requestId: 'synthetic-job',
      nodeBinding,
      started: true,
      ended: true,
      reason: 'node_completed',
      nodeCompletion: { id: 'synthetic-job', fence: syntheticFence('2'), status: 'completed', dispatched: true },
    }),
  )
  assert.equal((await fx.lease.release()).released, false)
  assert.equal(
    (await fx.second.db.prepare('SELECT ended_at FROM execution_jobs WHERE request_id=$1').get('synthetic-job'))
      .ended_at,
    null,
  )
})

test('the actual Go KSG2 node persists normal completion but retains an internal error across two PG connections', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const config = await realSlotgate(t)
  const db = getDb()
  const otherDb = await createDatabase({ connectionString: process.env.VM2API_TEST_DATABASE_URL, schema: db.schema })
  const first = new ExecutionAdmissionsRepo(db, { ownerId: 'synthetic-controller-a' })
  const second = new ExecutionAdmissionsRepo(otherDb, { ownerId: 'synthetic-controller-b' })
  for (const mode of ['normal', 'unknown']) {
    const lease = await first.tryReserve(candidate)
    assert.equal(lease.ok, true)
    const result = await callGoWorker({
      exec: { vmId: config.vmId, slotgate: config, vm: { runtime: { worker_token_file: config.kernelTokenFile } } },
      envelope: { body: { mode } },
      onExecutionStart: lease.bindExecution,
    })
    await lease.completeExecution(result.execution)
    assert.equal(result.execution.ended, mode === 'normal')
    assert.equal((await lease.release()).released, mode === 'normal')
  }
  assert.equal((await second.tryReserve(candidate)).code, 'concurrency_limit')
  const rows = await otherDb.prepare('SELECT * FROM execution_jobs ORDER BY created_at').all()
  assert.ok(rows[0].ended_at)
  assert.equal(rows[0].node_completion.status, 'completed')
  assert.equal(rows[1].ended_at, null)
  assert.equal(rows[1].node_completion, null)
})

test('PG binding failure causes zero node prepare or forward operations', async (t) => {
  const fx = await fixture(t)
  await fx.db.exec(`CREATE FUNCTION reject_synthetic_binding() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic node binding failure' USING ERRCODE='P0001'; END; $$;
    CREATE TRIGGER reject_synthetic_binding BEFORE INSERT ON execution_jobs FOR EACH ROW EXECUTE FUNCTION reject_synthetic_binding()`)
  await assert.rejects(fx.run(), { code: 'P0001' })
  assert.equal(fx.requests.length, 0)
})

test('PG completion failure keeps the original job pending after node completion without a resend', async (t) => {
  const fx = await fixture(t)
  await fx.db.exec(`CREATE FUNCTION reject_synthetic_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic completion failure' USING ERRCODE='P0001'; END; $$;
    CREATE TRIGGER reject_synthetic_completion BEFORE UPDATE OF ended_at ON execution_jobs FOR EACH ROW EXECUTE FUNCTION reject_synthetic_completion()`)
  await assert.rejects(fx.run(), { code: 'P0001' })
  assert.equal(fx.requests.filter((value) => value.op === 'forward').length, 1)
  assert.equal((await fx.lease.release()).released, false)
  assert.equal((await fx.second.tryReserve(candidate)).code, 'concurrency_limit')
  assert.equal((await fx.second.db.prepare('SELECT ended_at FROM execution_jobs').get()).ended_at, null)
})

test('the persisted node binding cannot be changed by later mutation or an extraneous identity field', async (t) => {
  const fx = await fixture(t)
  const binding = {
    protocol: 'KSG2',
    nodeId: fx.config.nodeId,
    vmId: candidate.vmId,
    kind: 'kernel',
    fence: syntheticFence('18446744073709551615'),
  }
  const pending = fx.lease.bindExecution({ requestId: 'original-capture', nodeBinding: binding })
  binding.fence.generation = '2'
  const ack = await pending
  assert.equal(ack.nodeBinding.fence.generation, '18446744073709551615')
  const row = await fx.second.db.prepare('SELECT node_binding FROM execution_jobs').get()
  assert.equal(row.node_binding.fence.generation, '18446744073709551615')
  await assert.rejects(
    fx.lease.completeExecution({
      requestId: 'original-capture',
      started: true,
      ended: true,
      reason: 'node_completed',
      nodeBinding: ack.nodeBinding,
      nodeCompletion: {
        id: 'original-capture',
        fence: { ...ack.nodeBinding.fence, extra: true },
        status: 'completed',
        dispatched: true,
      },
    }),
    { code: 'execution_node_unconfirmed' },
  )
  assert.equal((await fx.lease.release()).released, false)
})
