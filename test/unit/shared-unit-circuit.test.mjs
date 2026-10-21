import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../../src/lib/db/database.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
import { SharedExecutionAdmissions } from '../../src/lib/pool/shared-execution-admissions.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { UnitCircuit } from '../../src/lib/pool/unit-circuit.mjs'

const candidate = {
  accountId: 'circuit-account',
  vmId: 'circuit-vm',
  model: 'claude-test',
  vm: { id: 'circuit-vm', policy: { maxConcurrency: 8 } },
  account: { account_id: 'circuit-account' },
  maxConcurrency: 8,
}

const success = {
  ok: true,
  terminalState: 'verified',
  body: {
    type: 'message',
    id: 'msg-test',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
  },
}

async function replicas(threshold = 1) {
  const firstDb = getDb()
  const secondDb = await createRepositoryTestDatabase({
    connectionString: process.env.VM2API_TEST_DATABASE_URL,
    schema: firstDb.schema,
  })
  return [firstDb, secondDb].map((db) => {
    const pool = new PoolScheduler({
      executionAdmissions: new SharedExecutionAdmissions(db),
      accountQuota: {
        db,
        canAccept: () => ({ ok: true }),
        limitFor: () => 8,
        policyFor: () => ({}),
        rpmLimitFor: () => 0,
      },
      config: { circuit_failure_threshold: threshold, circuit_open_ms: 1000 },
    })
    // Separate process-local objects model two control-plane processes.
    pool.unitCircuit = new UnitCircuit({ failureThreshold: threshold, openMs: 1000 })
    return { pool, runner: new FailoverRunner({ scheduler: pool }), db }
  })
}

async function kubernetes(fn) {
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  try {
    await fn()
  } finally {
    if (previous == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
  }
}

test('a circuit opened by one control plane blocks another control plane', () =>
  kubernetes(async () => {
    const [first, second] = await replicas()
    const lease = await first.pool.reserve(candidate)
    assert.ok(lease)
    await first.runner.noteUnitHealth({ ...candidate, ...lease }, { circuit: true }, { ok: false })
    await lease.release()
    const next = await second.pool.reserve(candidate)
    try {
      assert.equal(next, null, 'an independent control plane must observe the shared open circuit')
    } finally {
      await next?.release()
    }
  }))

test('failure streaks combine across control planes before the threshold', () =>
  kubernetes(async () => {
    const peers = await replicas(3)
    for (let index = 0; index < 3; index++) {
      const peer = peers[index % 2]
      const lease = await peer.pool.reserve(candidate)
      assert.ok(lease)
      await peer.runner.noteUnitHealth({ ...candidate, ...lease }, { circuit: true }, { ok: false })
      await lease.release()
    }
    const next = await peers[1].pool.reserve(candidate)
    try {
      assert.equal(next, null, 'three failures must open one shared circuit')
    } finally {
      await next?.release()
    }
  }))

async function openCircuit(peer) {
  const lease = await peer.pool.reserve(candidate)
  await peer.runner.noteUnitHealth({ ...candidate, ...lease }, { circuit: true }, { ok: false })
  await lease.release()
  await peer.db.exec("UPDATE execution_circuits SET open_until = clock_timestamp() - interval '1 second'")
}

test('an expired shared circuit admits exactly one probe and unknown work never expires', () =>
  kubernetes(async () => {
    const peers = await replicas()
    await openCircuit(peers[0])
    const leases = await Promise.all(Array.from({ length: 12 }, (_, index) => peers[index % 2].pool.reserve(candidate)))
    assert.equal(leases.filter(Boolean).length, 1)
    const probe = leases.find(Boolean)
    await probe.markUncertain()
    await peers[0].db.exec("UPDATE execution_admissions SET created_at = clock_timestamp() - interval '1 year'")
    assert.notEqual((await probe.release()).released, true)
    assert.equal(await peers[1].pool.reserve(candidate), null)
    assert.equal(
      (await peers[1].pool.executionAdmissions.inspectCircuit(candidate.accountId, peers[1].pool.circuitConfig()))
        .reason,
      'circuit_probe',
    )
  }))

test('only the current half-open probe can close the shared circuit', () =>
  kubernetes(async () => {
    const [first, second] = await replicas()
    const older = await first.pool.reserve(candidate)
    await openCircuit(second)
    const probe = await second.pool.reserve(candidate)
    assert.ok(probe)
    await first.runner.noteUnitHealth({ ...candidate, ...older }, {}, success)
    assert.equal(await first.pool.reserve(candidate), null, 'old success cannot complete the current probe')
    await second.runner.noteUnitHealth({ ...candidate, ...probe }, {}, success)
    assert.equal(
      (await first.pool.executionAdmissions.inspectCircuit(candidate.accountId, first.pool.circuitConfig())).state,
      'closed',
    )
    await older.release()
    await probe.release()
    const next = await first.pool.reserve(candidate)
    assert.ok(next)
    await next.release()
  }))

test('a half-open probe without submitted jobs is returned only by its own release', () =>
  kubernetes(async () => {
    const [first, second] = await replicas()
    await openCircuit(first)
    const probe = await first.pool.reserve(candidate)
    const otherOwner = { ...probe, ownerId: 'different-controller' }
    assert.equal((await second.pool.executionAdmissions.executions.release(otherOwner)).released, false)
    assert.equal(await second.pool.reserve(candidate), null)
    assert.equal((await probe.release()).released, true)
    const retry = await second.pool.reserve(candidate)
    assert.ok(retry)
    await retry.release()
  }))

test('duplicate outcomes count once and an operator reset invalidates old outcomes', () =>
  kubernetes(async () => {
    const [first, second] = await replicas(3)
    const lease = await first.pool.reserve(candidate)
    await lease.noteCircuitResult('failure')
    await lease.noteCircuitResult('failure')
    let state = await second.pool.executionAdmissions.inspectCircuit(candidate.accountId, second.pool.circuitConfig())
    assert.equal(state.failures, 1)
    const older = await second.pool.reserve(candidate)
    await first.pool.executionAdmissions.resetCircuit(candidate.accountId, first.pool.circuitConfig())
    await older.noteCircuitResult('failure')
    state = await first.pool.executionAdmissions.inspectCircuit(candidate.accountId, first.pool.circuitConfig())
    assert.equal(state.failures, 0)
    await lease.release()
    await older.release()
  }))

test('a failed circuit write preserves its admission and probe', () =>
  kubernetes(async () => {
    const [first, second] = await replicas()
    await openCircuit(first)
    const probe = await first.pool.reserve(candidate)
    await first.db.exec(`CREATE FUNCTION reject_circuit_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic circuit write failure'; END $$;
      CREATE TRIGGER reject_circuit_write BEFORE UPDATE ON execution_circuits
      FOR EACH ROW EXECUTE FUNCTION reject_circuit_write()`)
    await assert.rejects(probe.noteCircuitResult('success'), { code: 'P0001' })
    assert.equal((await probe.release()).released, false)
    assert.equal(await second.pool.reserve(candidate), null)
  }))
