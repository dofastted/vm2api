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
