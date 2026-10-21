import test from 'node:test'
import assert from 'node:assert/strict'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { SeatPlanner } from '../../src/lib/pool/seat-planner.mjs'

function gate() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function sharedPool(admissions) {
  const pool = new PoolScheduler({
    projectRoot: '/tmp',
    executionAdmissions: admissions,
    accountQuota: {
      canAccept: () => ({ ok: true }),
      limitFor: () => 2,
      policyFor: () => ({}),
      rpmLimitFor: () => 0,
    },
    config: { seat_grace_ms: 0 },
  })
  pool.eligibleCandidates = async () => [
    {
      ok: true,
      accountId: 'shared-account',
      vmId: 'shared-vm',
      model: 'claude-test',
      vm: { id: 'shared-vm', policy: { maxConcurrency: 2 } },
      account: { account_id: 'shared-account' },
      maxConcurrency: 2,
      inflight: 0,
      loadRatio: 0,
      priority: 0,
      seatCap: 2,
      headroom: null,
    },
  ]
  return pool
}

test('Kubernetes selection awaits the shared admission decision instead of reserving process-local capacity', async () => {
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  let calls = 0
  const pool = sharedPool({
    async tryReserve() {
      calls++
      return { ok: false, code: 'concurrency_limit' }
    },
  })
  let selected
  try {
    selected = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
    assert.equal(calls, 1, 'the PostgreSQL admission service decides each attempted reservation')
    assert.equal(selected.ok, false)
    assert.equal(pool.inflight.size, 0)
  } finally {
    await selected?.release?.()
    if (previous == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
  }
})

test('Kubernetes selection ignores stale local inflight and exposes the shared execution lease', async () => {
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  let released = 0
  const lease = { ok: true, admissionId: 'admission-test', release: async () => released++ }
  const pool = sharedPool({ tryReserve: async () => lease })
  pool.inflight.set('shared-account', 99)
  let selected
  try {
    selected = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
    assert.equal(selected.ok, true)
    assert.equal(selected.admissionId, lease.admissionId)
    await selected.release()
    assert.equal(released, 1)
  } finally {
    await selected?.release?.()
    if (previous == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
  }
})

test('an asynchronous seat refusal stays queued until its admission decision resolves', async () => {
  const decision = gate()
  const planner = new SeatPlanner({ asyncGrants: true })
  const ticket = {
    seatKey: 'device-test',
    vmId: 'vm-test',
    kind: 'conc',
    enqueuedAt: Date.now(),
    tryGrant: () => decision.promise,
  }
  planner.enqueue(ticket)
  planner.pump('vm-test')
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(ticket.queued, true, 'a pending Promise must not be treated as a successful grant')
    decision.resolve(false)
    await planner.flush()
    assert.equal(ticket.queued, true)
  } finally {
    decision.resolve(false)
    planner.remove(ticket)
  }
})

test('a cancelled queued request awaits release of a late asynchronous seat grant', async () => {
  const decision = gate()
  const released = gate()
  let releaseCalls = 0
  const planner = new SeatPlanner({ asyncGrants: true })
  const ticket = {
    seatKey: 'device-late',
    vmId: 'vm-late',
    kind: 'conc',
    enqueuedAt: Date.now(),
    async tryGrant() {
      await decision.promise
      ticket.granted = {
        reservation: {
          async release() {
            releaseCalls++
            await released.promise
          },
        },
      }
      return true
    },
  }
  planner.enqueue(ticket)
  planner.pump('vm-late')
  planner.remove(ticket)
  decision.resolve()
  try {
    let flushed = false
    const pending = planner.flush().then(() => (flushed = true))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(releaseCalls, 1)
    assert.equal(flushed, false, 'shutdown flush includes the late grant release')
    released.resolve()
    await pending
    assert.equal(ticket.granted, null)
  } finally {
    released.resolve()
  }
})
