import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { SeatPlanner } from '../../src/lib/pool/seat-planner.mjs'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { SharedExecutionAdmissions } from '../../src/lib/pool/shared-execution-admissions.mjs'

function gate() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function sharedPool(
  admissions,
  {
    accountId = 'shared-account',
    vmId = 'shared-vm',
    accountLimit = 2,
    vmLimit = 2,
    rpmLimit = 0,
    fableLimit = 4,
    model = 'claude-test',
  } = {},
) {
  const pool = new PoolScheduler({
    projectRoot: '/tmp',
    executionAdmissions: admissions,
    accountQuota: {
      canAccept: () => ({ ok: true }),
      limitFor: () => accountLimit,
      policyFor: () => ({}),
      rpmLimitFor: () => rpmLimit,
    },
    config: { seat_grace_ms: 0, fable_max_per_account: fableLimit },
  })
  pool.eligibleCandidates = async () => [
    {
      ok: true,
      accountId,
      vmId,
      model,
      vm: { id: vmId, policy: { maxConcurrency: vmLimit } },
      account: { account_id: accountId },
      maxConcurrency: vmLimit,
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

test('asynchronous seat failures reach the waiting request and shutdown flush', async () => {
  const error = new Error('synthetic PostgreSQL admission failed')
  const planner = new SeatPlanner({ asyncGrants: true })
  const ticket = {
    seatKey: 'device-error',
    vmId: 'vm-error',
    kind: 'conc',
    enqueuedAt: Date.now(),
    tryGrant: async () => {
      throw error
    },
  }
  planner.enqueue(ticket)
  await assert.rejects(planner.pump('vm-error'), error)
  assert.equal(ticket.error, error)
  await assert.rejects(planner.flush(), error)
  planner.remove(ticket)
})

async function replicas(t, options = {}) {
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(() => {
    if (previous == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
  })
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => other.close())
  const services = [db, other].map((connection) => {
    const service = new SharedExecutionAdmissions(connection)
    return {
      repo: service.executions,
      tryReserve: (input) => service.tryReserve(input),
      getCounts: (accountId, vmId) => service.getCounts(accountId, vmId),
      getSeat: (seatKey) => service.getSeat(seatKey),
    }
  })
  const pools = services.map((service, index) => sharedPool(service, { ...options, vmId: `shared-vm-${index}` }))
  return { services, pools }
}

test('two Kubernetes schedulers execute overlapping requests under one PostgreSQL account cap', async (t) => {
  const { services, pools } = await replicas(t, { accountLimit: 2, vmLimit: 1 })
  const held = await Promise.all(pools.map((pool) => pool.selectAndReserve({ model: 'claude-test', allowWait: false })))
  try {
    assert.deepEqual(
      held.map((item) => item.ok),
      [true, true],
      'both replicas may execute simultaneously',
    )
    assert.equal((await services[0].repo.getCounts({ accountId: 'shared-account' })).accountInflight, 2)
    await held[0].release()
    const fullVm = await pools[1].selectAndReserve({ model: 'claude-test', allowWait: false })
    assert.equal(fullVm.ok, false)
    assert.ok(fullVm.wait_reasons.includes('vm_concurrency_limit'))
    const reused = await pools[0].selectAndReserve({ model: 'claude-test', allowWait: false })
    assert.equal(reused.ok, true)
    await reused.release()
  } finally {
    for (const item of held) await item.release?.()
    for (const pool of pools) await pool.flush()
  }
})

test('independent schedulers cannot oversell an account while choosing different VMs', async (t) => {
  const { services, pools } = await replicas(t, { accountLimit: 1, vmLimit: 2 })
  const held = await Promise.all(pools.map((pool) => pool.selectAndReserve({ model: 'claude-test', allowWait: false })))
  try {
    assert.equal(held.filter((item) => item.ok).length, 1)
    assert.equal((await services[1].repo.getCounts({ accountId: 'shared-account' })).accountInflight, 1)
  } finally {
    for (const item of held) await item.release?.()
    for (const pool of pools) await pool.flush()
  }
})

test('released executions still consume the shared account RPM window', async (t) => {
  const { services, pools } = await replicas(t, { accountLimit: 2, vmLimit: 2, rpmLimit: 1 })
  const first = await pools[0].selectAndReserve({ model: 'claude-test', allowWait: false })
  try {
    assert.equal(first.ok, true)
    await first.release()
    const limited = await pools[1].selectAndReserve({ model: 'claude-test', allowWait: false })
    assert.equal(limited.ok, false)
    assert.ok(limited.wait_reasons.includes('rpm_limit'))
    const counts = await services[1].repo.getCounts({ accountId: 'shared-account' })
    assert.equal(counts.accountInflight, 0)
    assert.equal(counts.rpmCount, 1)
  } finally {
    await first.release?.()
    for (const pool of pools) await pool.flush()
  }
})

test('the PostgreSQL Fable cap spans schedulers without blocking another model family', async (t) => {
  const { services, pools } = await replicas(t, { accountLimit: 4, vmLimit: 2, fableLimit: 1, model: 'claude-fable-5' })
  const first = await pools[0].selectAndReserve({ model: 'claude-fable-5', allowWait: false })
  let regular
  try {
    assert.equal(first.ok, true)
    const limited = await pools[1].selectAndReserve({ model: 'claude-fable-5', allowWait: false })
    assert.equal(limited.ok, false)
    assert.ok(limited.wait_reasons.includes('fable_concurrency'))
    const otherFamily = sharedPool(services[1], {
      accountLimit: 4,
      vmLimit: 2,
      fableLimit: 1,
      model: 'claude-sonnet-5',
      vmId: 'shared-vm-1',
    })
    regular = await otherFamily.selectAndReserve({ model: 'claude-sonnet-5', allowWait: false })
    assert.equal(regular.ok, true)
    await regular.release()
    await otherFamily.flush()
  } finally {
    await first.release?.()
    await regular?.release?.()
    for (const pool of pools) await pool.flush()
  }
})

test('a second scheduler finds the PostgreSQL device home and retains its shared slot index', async (t) => {
  const { services, pools } = await replicas(t, { accountLimit: 4, vmLimit: 2 })
  const candidates = [...(await pools[0].eligibleCandidates()), ...(await pools[1].eligibleCandidates())]
  pools[0].eligibleCandidates = async () => candidates
  pools[1].eligibleCandidates = async () => [...candidates].reverse()
  const first = await pools[0].selectAndReserve({
    model: 'claude-test',
    seatKey: 'device-cross-replica',
    allowWait: false,
  })
  let second
  try {
    assert.equal(first.ok, true)
    assert.equal(pools[1].planner.seats.size, 0, 'the second replica starts without a local seat mirror')
    second = await pools[1].selectAndReserve({
      model: 'claude-test',
      seatKey: 'device-cross-replica',
      allowWait: false,
    })
    assert.equal(second.ok, true)
    assert.equal(second.vmId, first.vmId)
    assert.equal(second.slotIndex, first.slotIndex)
    assert.equal(second.seatGeneration, first.seatGeneration)
    const shared = await services[1].getSeat('platform|device-cross-replica')
    assert.equal(shared.vmId, first.vmId)
    assert.equal(shared.inflight, 2)
  } finally {
    await first.release?.()
    await second?.release?.()
    for (const pool of pools) await pool.flush()
  }
})

test('cancellation during a PostgreSQL admission waits for its late lease to be released', async (t) => {
  const { services } = await replicas(t)
  const reserved = gate()
  const deliver = gate()
  const pool = sharedPool({
    ...services[0],
    async tryReserve(input) {
      const lease = await services[0].tryReserve(input)
      reserved.resolve()
      await deliver.promise
      return lease
    },
  })
  const controller = new AbortController()
  const pending = pool.selectAndReserve({ model: 'claude-test', signal: controller.signal, allowWait: false })
  const rejected = assert.rejects(pending, { code: 'selection_cancelled' })
  try {
    await reserved.promise
    controller.abort()
    assert.equal((await services[0].repo.getCounts({ accountId: 'shared-account' })).accountInflight, 1)
    deliver.resolve()
    await rejected
    await pool.flush()
    assert.equal((await services[0].repo.getCounts({ accountId: 'shared-account' })).accountInflight, 0)
  } finally {
    deliver.resolve()
    await rejected
    await pool.flush()
  }
})

test('default Kubernetes selection reads PostgreSQL capacity despite stale local quota and inflight caches', async (t) => {
  const { services } = await replicas(t)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-pool-real-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms)
  fs.writeFileSync(
    path.join(vms, 'vm-real.json'),
    JSON.stringify({
      id: 'vm-real',
      status: 'running',
      schedulable: true,
      proxy_cli_enabled: true,
      proxy: { id: 'synthetic-proxy', url: 'socks5h://127.0.0.1:11001' },
      runtime: { worker_socket: path.join(vms, 'vm-real', 'run', 'worker.sock') },
      policy: { maxConcurrency: 1, concurrencyOverride: true },
      claude: {
        account_uuid: 'account-real',
        account_tier: 'max',
        access_token: 'synthetic-access',
        refresh_token: 'synthetic-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }),
  )
  const pools = [getDb(), services[1].repo.db].map(
    (db) =>
      new PoolScheduler({
        projectRoot: root,
        accountQuota: {
          db,
          canAccept: () => ({ ok: false, reason: 'concurrency_limit' }),
          limitFor: () => 2,
          policyFor: () => ({}),
          rpmLimitFor: () => 0,
        },
        workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
      }),
  )
  pools[0].inflight.set('account-real', 99)
  pools[1].inflight.set('account-real', 99)
  const first = await pools[0].selectAndReserve({ model: 'claude-test', allowWait: false })
  let next
  try {
    assert.equal(first.ok, true, 'stale local capacity cannot reject a PostgreSQL-granted request')
    const full = await pools[1].selectAndReserve({ model: 'claude-test', allowWait: false })
    assert.equal(full.ok, false)
    assert.ok(full.wait_reasons.includes('vm_concurrency_limit'))
    await first.release()
    next = await pools[1].selectAndReserve({ model: 'claude-test', allowWait: false })
    assert.equal(next.ok, true)
  } finally {
    await first.release?.()
    await next?.release?.()
    for (const pool of pools) await pool.flush()
  }
})
