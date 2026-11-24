import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PoolScheduler, normalizePoolRouting } from '../../src/lib/pool/pool-scheduler.mjs'
import { SeatPlanner, budgetAllows, rankSeatCandidates } from '../../src/lib/pool/seat-planner.mjs'
import { servePoolSeatStream } from '../../src/lib/admin/pool-seat-stream.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { configureSlotCapacity } from '../../src/lib/vm/slot-capacity.mjs'
import { bindPlacement, unbindPlacement } from '../../src/lib/cluster/placement.mjs'
import { extractCallerSession, subagentRootSession } from '../../src/lib/identity/identity-rewrite.mjs'

// These tests cover other behaviour on the legacy fixed 20 native slots;
// plan-based capacity has its own tests (slot-capacity*.test.mjs).
configureSlotCapacity({ enabled: false })

const MODEL = 'claude-test'

function project(specs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-seat-planner-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms, { recursive: true })
  specs.forEach(({ id, policy = {}, owner = null }, index) => {
    const accountId = `account-${index + 1}`
    const vm = {
      id,
      name: id,
      status: 'running',
      schedulable: true,
      proxy_cli_enabled: true,
      proxy: { id: `proxy-${id}`, url: `socks5h://127.0.0.1:${11001 + index}` },
      runtime: { worker_socket: path.join(vms, id, 'run', 'worker.sock') },
      ...(owner ? { owner_user_id: owner } : {}),
      policy: { maxConcurrency: 4, concurrencyOverride: true, weight: 1, ...policy },
      claude: {
        account_uuid: accountId,
        account_tier: 'max',
        access_token: `access-${accountId}`,
        refresh_token: `refresh-${accountId}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }
    fs.writeFileSync(path.join(vms, `${id}.json`), JSON.stringify(vm))
  })
  fs.writeFileSync(path.join(vms, 'active.json'), JSON.stringify({ active_vm: specs[0].id }))
  return root
}

class RuntimeRepo {
  constructor(accounts = null) {
    this.accounts = accounts
  }
  schedulingSnapshot(ids) {
    return new Map(
      ids.map((id) => [
        id,
        {
          state: this.get(id),
          account: this.accounts?.get(id) ? { status: 'active', schedulable: true, ...this.accounts.get(id) } : null,
        },
      ]),
    )
  }
  writeHeartbeat(input) {
    this.upsert(input)
  }
  states = new Map()
  get(id) {
    return this.states.get(id) || null
  }
  clearExpired() {}
  upsert(state) {
    this.states.set(state.account_id, { ...(this.states.get(state.account_id) || {}), ...state })
  }
  markCooldown() {}
}

function scheduler(root, config = {}) {
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: new RuntimeRepo(),
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { seat_grace_ms: 0, ...config },
  })
  pool.config.sticky_wait_timeout_ms = config.sticky ?? 2000
  pool.config.fallback_wait_timeout_ms = config.fallback ?? 2000
  return pool
}

function setup(t, specs, config) {
  const root = project(specs)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return scheduler(root, config)
}

async function waitFor(check, ms = 2000) {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const seat = (pool, session, extra = {}) =>
  pool.selectAndReserve({ model: MODEL, seatKey: `seat:sess:${session}`, ...extra })
/** Planner key for a platform-scope session seat. */
const planned = (session) => `platform|seat:sess:${session}`

function agentRequest(root, agent, { nested = false, ...args } = {}) {
  const body = {
    model: MODEL,
    metadata: { user_id: JSON.stringify({ device_id: 'machine-1', account_uuid: '', session_id: root }) },
  }
  const headers = agent ? { 'x-claude-code-agent-id': agent } : {}
  if (nested) headers['x-claude-code-parent-agent-id'] = 'parent-agent'
  const session = extractCallerSession({ inbound: body, headers })
  return {
    model: MODEL,
    canonicalBody: body,
    stickyKey: `sess:${session}`,
    seatKey: `seat:sess:${session}`,
    rootSessionId: subagentRootSession(body, headers),
    ...args,
  }
}

async function familyPool(t, config = {}, specs = [{ id: 'vm-01' }, { id: 'vm-02' }]) {
  const pool = setup(t, specs, { max_primary_sessions: 1, max_subagents_per_session: 2, sticky: 300, ...config })
  pool.stickyRouter = new StickyRouter({ dataDir: pool.projectRoot, config: {} })
  t.after(() => pool.stickyRouter.db.close())
  pool.stickyRouter.bind('sess:root', { vmId: 'vm-01', accountId: 'account-1' })
  const root = await pool.selectAndReserve(agentRequest('root'))
  assert.equal(root.vmId, 'vm-01')
  root.release()
  return pool
}

test('family mode is opt-in per VM; n alone leaves independent child seats', async (t) => {
  const pool = await familyPool(t, { max_subagents_per_session: null }, [{ id: 'vm-01' }])
  const parent = await pool.selectAndReserve(agentRequest('root'))
  const child = await pool.selectAndReserve(agentRequest('root', 'child'))
  assert.equal(pool.planner.openCount('vm-01'), 2)
  assert.equal(pool.planner.subagents.size, 0)
  assert.equal(pool.planner.roots.size, 0)
  assert.ok(!('subagents_max' in pool.seatSnapshot().seats['vm-01'].sessions[0]))
  parent.release()
  child.release()
})

test('nested children keep a single root seat through parent idle and release it after the last child', async (t) => {
  const pool = await familyPool(t)
  const parent = await pool.selectAndReserve(agentRequest('root'))
  const one = await pool.selectAndReserve(agentRequest('root', 'parent-agent', { deviceVmId: 'vm-02' }))
  const two = await pool.selectAndReserve(agentRequest('root', 'nested', { nested: true, familyVmId: 'vm-02' }))
  assert.equal(one.vmId, parent.vmId)
  assert.equal(two.vmId, parent.vmId)
  parent.release()
  const { sessions } = pool.seatSnapshot().seats['vm-01']
  assert.deepEqual(
    sessions.map((s) => [s.session_id, s.inflight, s.subagents_running, s.subagents_queued, s.subagents_max]),
    [['root', 2, 2, 0, 2]],
  )
  const other = await pool.selectAndReserve(agentRequest('other'))
  assert.equal(other.vmId, 'vm-02')
  one.release()
  one.release()
  assert.equal(pool.planner.openCount('vm-01'), 1)
  two.release()
  other.release()
  assert.deepEqual(pool.seatSnapshot().seats, {})
  assert.equal(pool.planner.subagents.size, 0)
})

test('an orphan summary waits for a seat release even when there is no execution to release', async (t) => {
  const pool = await familyPool(t, { max_subagents_per_session: 0, sticky: 1000, fallback: 150 }, [{ id: 'vm-01' }])
  const ctrl = new AbortController()
  const child = pool.selectAndReserve(agentRequest('root', 'waiting', { signal: ctrl.signal }))
  await waitFor(() => pool.queuedTotal() === 1)
  const orphan = pool.selectAndReserve({
    model: MODEL,
    skipSessionSlot: true,
    summarySession: 'summary',
    rootSessionId: 'unknown',
  })
  await waitFor(() => pool.queuedTotal() === 2)
  assert.equal(pool.vmInflight.size, 0)
  ctrl.abort()
  await assert.rejects(child, { code: 'selection_cancelled' })
  const grant = await orphan
  assert.equal(grant.seatKey, planned('summary'))
  grant.release()
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

test('an orphan summary can still use a full legacy seat book in a mixed pool', async (t) => {
  const pool = await familyPool(t, { max_subagents_per_session: null }, [
    { id: 'vm-01', policy: { sessionSlots: 1, maxSubagentsPerSessionOverride: true, maxSubagentsPerSession: 1 } },
    { id: 'vm-02', policy: { sessionSlots: 1 } },
  ])
  const a = await seat(pool, 'root', { deviceVmId: 'vm-01' })
  const b = await seat(pool, 'other', { deviceVmId: 'vm-02' })
  const summary = await pool.selectAndReserve({
    model: MODEL,
    skipSessionSlot: true,
    summarySession: 'summary',
    rootSessionId: 'unknown',
    allowWait: false,
  })
  assert.equal(summary.vmId, 'vm-02')
  assert.equal(summary.seatKey, undefined)
  assert.equal(pool.planner.openCount('vm-02'), 1)
  summary.release()
  a.release()
  b.release()
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

test('family children wait on the root VM for both account and physical execution capacity', async (t) => {
  for (const [sessionSlots, maxConcurrency] of [
    [1, 4],
    [4, 1],
  ]) {
    const pool = await familyPool(t, {}, [{ id: 'vm-01', policy: { sessionSlots, maxConcurrency } }, { id: 'vm-02' }])
    const main = await pool.selectAndReserve(agentRequest('root'))
    const child = pool.selectAndReserve(agentRequest('root', 'one'))
    await waitFor(() => pool.planner.pending() === 1)
    assert.equal(pool.seatSnapshot().seats['vm-01'].sessions[0].subagents_running, 0)
    assert.equal(pool.seatSnapshot().seats['vm-01'].sessions[0].subagents_queued, 1)
    assert.equal(pool.seatSnapshot().seats['vm-01'].conc_waiting, 1)
    assert.equal(pool.planner.globalQueue.length, 0)
    assert.equal(pool.vmInflight.has('vm-02'), false)
    main.release()
    const next = await child
    assert.equal(next.vmId, 'vm-01')
    assert.equal(next.selectionReason, 'subagent')
    next.release()
    assert.equal(pool.planner.seats.size, 0)
  }
})

test('a child reclaims an idle root on its sticky VM, waits for n, and times out there', async (t) => {
  const pool = await familyPool(t, { sticky: 60 })
  const other = await seat(pool, 'other', { deviceVmId: 'vm-01' })
  assert.equal(other.vmId, 'vm-01')
  const failed = await pool.selectAndReserve(agentRequest('root', 'first'))
  assert.equal(failed.reason, 'pool_queue_timeout')
  const queued = pool.selectAndReserve(agentRequest('root', 'second'))
  await waitFor(() => pool.planner.pending() === 1)
  assert.equal(pool.planner.globalQueue.length, 0)
  other.release()
  const child = await queued
  assert.equal(child.vmId, 'vm-01')
  assert.equal(pool.seatSnapshot().seats['vm-01'].sessions[0].session_id, 'root')
  child.release()
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

test('a full family admits in order, returns 529 at m, and cleans up cancellations and grants in transit', async (t) => {
  const pool = await familyPool(t, { max_subagents_per_session: 1, sticky: 150 })
  const first = await pool.selectAndReserve(agentRequest('root', 'one'))
  const runner = new FailoverRunner({ scheduler: pool, stickyRouter: pool.stickyRouter })
  const unexpectedCalls = []
  const run = (agent, signal) =>
    runner.run({
      ...agentRequest('root', agent),
      signal,
      callAttempt: () => {
        unexpectedCalls.push(agent)
        throw new Error('unexpected execution')
      },
    })
  const ctrl = new AbortController()
  const cancelled = run('cancel', ctrl.signal)
  await waitFor(() => pool.planner.pending() === 1)
  ctrl.abort()
  assert.equal((await cancelled).terminalState, 'cancelled')
  const overloaded = await run('timeout')
  assert.equal(overloaded.status, 529)
  assert.equal(overloaded.body.error.type, 'overloaded_error')
  assert.equal(overloaded.body.error.code, 'pool_overloaded')
  assert.equal(overloaded.body.error.details.reason, 'subagent_limit')
  assert.ok(overloaded.retryAfterSec >= 1)
  const abortGranted = new AbortController()
  const pending = run('abort-grant', abortGranted.signal)
  await waitFor(() => pool.planner.pending() === 1)
  const order = []
  const second = pool.selectAndReserve(agentRequest('root', 'two')).then((r) => (order.push('two'), r))
  await waitFor(() => pool.planner.pending() === 2)
  const third = pool.selectAndReserve(agentRequest('root', 'three')).then((r) => (order.push('three'), r))
  await waitFor(() => pool.planner.pending() === 3)
  first.release()
  assert.equal(pool.seatSnapshot().seats['vm-01'].sessions[0].subagents_running, 1)
  abortGranted.abort()
  assert.equal((await pending).terminalState, 'cancelled')
  const got = await second
  assert.deepEqual(order, ['two'])
  got.release()
  ;(await third).release()
  assert.deepEqual(order, ['two', 'three'])
  assert.deepEqual(unexpectedCalls, [])
  assert.equal(pool.planner.pending(), 0)
  assert.equal(pool.planner.subagents.size, 0)
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

test('only a primary registration in the caller scope can share a seat, even after VM reassignment or restart', async (t) => {
  const pool = await familyPool(t, {}, [{ id: 'vm-01' }, { id: 'vm-02', owner: 'tenant' }])
  const scope = { type: 'user', userId: 'tenant' }
  pool.stickyRouter.bind('family2:missing', { vmId: 'vm-02', accountId: 'account-2' })
  pool.stickyRouter.bind('sess:expired', { vmId: 'vm-02', accountId: 'account-2' })
  const repo = pool.stickyRouter.repo
  repo.upsert('sess:expired', { ...repo.get('sess:expired'), expires_at: Date.now() - 1 })
  for (const root of ['missing', 'root', 'expired']) {
    const args = agentRequest(root, 'agent', { ownerScope: scope })
    const ordinary = await pool.selectAndReserve(args)
    assert.equal(ordinary.vmId, 'vm-02')
    assert.equal(ordinary.seatKey, `user:tenant|${args.seatKey}`)
    assert.equal(pool.planner.subagents.size, 0)
    const denied = await seat(pool, 'second', { ownerScope: scope, allowWait: false })
    assert.equal(denied.ok, false)
    ordinary.release()
  }
  const file = path.join(pool.projectRoot, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file))
  fs.writeFileSync(file, JSON.stringify({ ...vm, owner_user_id: 'tenant' }))
  const scoped = agentRequest('root', 'moved', { ownerScope: scope, deviceVmId: 'vm-01' })
  const moved = await pool.selectAndReserve(scoped)
  assert.equal(moved.vmId, 'vm-01')
  assert.equal(moved.isSubagent, undefined)
  moved.release()
  fs.writeFileSync(file, JSON.stringify(vm))
  const restart = scheduler(pool.projectRoot, pool.config)
  restart.stickyRouter = pool.stickyRouter
  const orphan = await restart.selectAndReserve(agentRequest('root', 'orphan'))
  assert.equal(orphan.isSubagent, undefined)
  assert.equal(restart.planner.roots.size, 0)
  orphan.release()
  const main = await restart.selectAndReserve(agentRequest('root'))
  main.release()
  const verified = await restart.selectAndReserve(agentRequest('root', 'verified'))
  assert.equal(verified.isSubagent, true)
  verified.release()
  restart.planner.roots.get(planned('root')).expiresAt = Date.now() - 1
  const expired = await restart.selectAndReserve(agentRequest('root', 'expired'))
  assert.equal(expired.isSubagent, undefined)
  expired.release()
})

test('moving a root retains the old seat and one m across both VMs until old work completes', async (t) => {
  const pool = await familyPool(t, { max_subagents_per_session: 1, sticky: 300 })
  const old = await pool.selectAndReserve(agentRequest('root', 'old'))
  const take = await pool.selectAndReserve(agentRequest('root', null, { excluded: new Set(['vm-01']) }))
  assert.equal(take.vmId, 'vm-02')
  assert.equal(pool.planner.openCount('vm-01'), 1)
  take.release()
  assert.equal(pool.planner.openCount('vm-02'), 1, 'the only active child is on the old VM')
  const other = await seat(pool, 'other', { excluded: new Set(['vm-01']), allowWait: false })
  assert.equal(other.ok, false)
  const pending = pool.selectAndReserve(agentRequest('root', 'new'))
  await waitFor(() => pool.queuedTotal() === 1)
  assert.equal(pool.seatSnapshot().seats['vm-02'].sessions[0].subagents_running, 1)
  old.release()
  const next = await pending
  assert.equal(next.vmId, 'vm-02')
  assert.equal(next.isSubagent, true)
  assert.equal(pool.planner.openCount('vm-01'), 0)
  next.release()
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

for (const exit of ['timeout', 'cancel', 'grant']) {
  test(`a migration wait releases the idle source seat on ${exit}`, async (t) => {
    const pool = await familyPool(t, { max_primary_sessions: 1, max_subagents_per_session: 1 })
    const onA = { excluded: new Set(['vm-02']) }
    const onB = { excluded: new Set(['vm-01']) }
    const blocker = await seat(pool, 'blocker', onB)
    const child = await pool.selectAndReserve(agentRequest('root', 'last'))
    assert.equal(child.vmId, 'vm-01')
    const ctrl = new AbortController()
    const migration = seat(pool, 'root', {
      ...onB,
      deviceVmId: exit === 'cancel' ? 'vm-02' : null,
      deadline: Date.now() + (exit === 'timeout' ? 200 : 2000),
      signal: ctrl.signal,
    })
    await waitFor(() => pool.queuedTotal() === 1)
    child.release()
    assert.equal(pool.vmInflight.has('vm-01'), false)
    assert.equal(pool.planner.subagents.size, 0)

    // A cancelled migration must also wake an existing waiter without another execution ending.
    const waiting = exit === 'cancel' ? seat(pool, 'next', { ...onA, deadline: Date.now() + 600 }) : null
    if (waiting) {
      await waitFor(() => pool.queuedTotal() === 2)
      ctrl.abort()
      await assert.rejects(migration, { code: 'selection_cancelled' })
    } else if (exit === 'timeout') {
      assert.equal((await migration).reason, 'pool_queue_timeout')
    } else {
      blocker.release()
      const moved = await migration
      assert.equal(moved.vmId, 'vm-02')
      moved.release()
    }
    const next = await (waiting ?? seat(pool, 'next', { ...onA, allowWait: false }))
    assert.equal(next.vmId, 'vm-01')
    next.release()
    blocker.release()
    assert.equal(pool.queuedTotal(), 0)
    assert.deepEqual(pool.seatSnapshot().seats, {})
  })
}

test('a primary moving to a legacy VM revokes its old root and wakes children into ordinary selection', async (t) => {
  const pool = await familyPool(t, { max_subagents_per_session: null, sticky: 500, fallback: 2000 }, [
    {
      id: 'vm-01',
      policy: {
        maxConcurrency: 1,
        maxSubagentsPerSessionOverride: true,
        maxSubagentsPerSession: 1,
        allowed_models: [MODEL],
      },
    },
    { id: 'vm-02', policy: { sessionSlots: 1, maxConcurrency: 1 } },
  ])
  const old = await pool.selectAndReserve(agentRequest('root', 'running'))
  const args = agentRequest('root', 'queued')
  const pending = pool.selectAndReserve(args)
  await waitFor(() => pool.planner.vmQueues.get('vm-01')?.length === 1)
  const stickyDeadline = pool.planner.vmQueues.get('vm-01')[0].deadline
  const moved = await seat(pool, 'root', { model: 'claude-sonnet-5', allowWait: false })
  assert.equal(moved.vmId, 'vm-02')
  assert.equal(pool.planner.rootVm(planned('root')), null)
  // Both accounts are busy. Ordinary fallback starts its own wait.
  await waitFor(() => pool.planner.globalQueue.length === 1)
  assert.ok(pool.planner.globalQueue[0].deadline > stickyDeadline)
  assert.equal(pool.planner.vmQueues.has('vm-01'), false)
  moved.release()
  const next = await pending
  assert.equal(next.isSubagent, undefined)
  assert.equal(next.selectionReason, 'queued')
  assert.equal(next.seatKey, `platform|${args.seatKey}`)
  assert.equal(next.vmId, 'vm-02')
  next.release()
  old.release()
  const fresh = await pool.selectAndReserve(agentRequest('root', 'fresh', { familyVmId: 'vm-02' }))
  assert.equal(fresh.vmId, 'vm-02')
  assert.equal(fresh.isSubagent, undefined)
  assert.equal(fresh.selectionReason, 'family-affinity')
  fresh.release()
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

for (const destinationBusy of [false, true]) {
  test(`a queued-only root migrates with n=2, m=1 and one physical permit per VM (destination busy: ${destinationBusy})`, async (t) => {
    const pool = await familyPool(t, { max_primary_sessions: 2, max_subagents_per_session: 1, sticky: 1000 }, [
      { id: 'vm-01', policy: { sessionSlots: 1, allowed_models: [MODEL] } },
      { id: 'vm-02', policy: { sessionSlots: 1 } },
    ])
    const blocker = await seat(pool, 'other', { deviceVmId: 'vm-01' })
    const holder = destinationBusy ? await seat(pool, 'holder', { model: 'claude-sonnet-5' }) : null
    const pending = pool.selectAndReserve(agentRequest('root', 'child'))
    await waitFor(() => pool.planner.vmQueues.get('vm-01')?.length === 1)
    const original = pool.planner.vmQueues.get('vm-01')[0].deadline
    assert.equal(pool.planner.openCount('vm-01'), 2)
    const migration = seat(pool, 'root', { model: 'claude-sonnet-5', deadline: Date.now() + 600 })
    if (holder) {
      await waitFor(() => pool.planner.globalQueue.length === 1)
      assert.equal(pool.planner.rootVm(planned('root')), 'vm-01')
      holder.release()
    }
    const root = await migration
    assert.equal(root.vmId, 'vm-02')
    await waitFor(() => pool.planner.vmQueues.get('vm-02')?.length === 1)
    assert.equal(pool.planner.vmQueues.get('vm-02')[0].deadline, original)
    assert.equal(pool.planner.openCount('vm-01'), 1)
    assert.equal(pool.planner.rootVm(planned('root')), 'vm-02')
    root.release()
    const child = await pending
    assert.equal(child.isSubagent, true)
    assert.equal(child.vmId, 'vm-02')
    child.release()
    blocker.release()
    assert.equal(pool.queuedTotal(), 0)
    assert.deepEqual(pool.seatSnapshot().seats, {})
  })
}

test('the last old-VM child frees the current root seat and wakes its next primary', async (t) => {
  const pool = await familyPool(t)
  const old = await pool.selectAndReserve(agentRequest('root', 'old'))
  const onB = { excluded: new Set(['vm-01']) }
  const moved = await seat(pool, 'root', onB)
  moved.release()
  const heldOnB = pool.planner.openCount('vm-02')
  const other = seat(pool, 'other', onB)
  await new Promise((resolve) => setImmediate(resolve))
  const waiting = pool.queuedTotal()
  old.release()
  const admitted = await other
  assert.equal(admitted.vmId, 'vm-02')
  admitted.release()
  assert.equal(heldOnB, 1)
  assert.equal(waiting, 1)
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

test('n is independent of physical capacity; seatless and seated permits share one physical limit', async (t) => {
  const pool = await familyPool(t, { max_primary_sessions: 2, max_subagents_per_session: 0 }, [
    { id: 'vm-01', policy: { sessionSlots: 1, maxConcurrency: 4 } },
  ])
  const ctrl = new AbortController()
  const pending = pool.selectAndReserve(agentRequest('root', 'held', { signal: ctrl.signal }))
  await waitFor(() => pool.queuedTotal() === 1)
  const other = await seat(pool, 'other', { allowWait: false })
  assert.equal(other.ok, true)
  assert.equal(pool.planner.openCount('vm-01'), 2)
  const probe = { model: MODEL, skipSessionSlot: true, allowWait: false }
  assert.equal((await pool.selectAndReserve(probe)).ok, false)
  other.release()
  const probing = await pool.selectAndReserve(probe)
  assert.equal(probing.ok, true)
  assert.equal((await seat(pool, 'other', { allowWait: false })).ok, false)
  ctrl.abort()
  await assert.rejects(pending, { code: 'selection_cancelled' })
  probing.release()
  pool.reloadConfig({ max_primary_sessions: 2, max_subagents_per_session: 1 })
  const child = await pool.selectAndReserve(agentRequest('root', 'first'))
  assert.equal(child.isSubagent, true)
  assert.equal((await pool.selectAndReserve(probe)).ok, false)
  child.release()
  const probeFirst = await pool.selectAndReserve(probe)
  const waiting = pool.selectAndReserve(agentRequest('root', 'second'))
  await waitFor(() => pool.queuedTotal() === 1)
  assert.equal(pool.vmInflight.get('vm-01'), 1)
  probeFirst.release()
  const next = await waiting
  assert.equal(next.isSubagent, true)
  next.release()
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

test('returning to a draining VM reuses the original root seat at n=1', async (t) => {
  const pool = await familyPool(t)
  const child = await pool.selectAndReserve(agentRequest('root', 'agent'))
  const original = pool.planner.seatOf(planned('root'))
  const moved = await pool.selectAndReserve(agentRequest('root', null, { excluded: new Set(['vm-01']) }))
  moved.release()
  const back = await pool.selectAndReserve(
    agentRequest('root', null, { excluded: new Set(['vm-02']), allowWait: false }),
  )
  assert.equal(back.vmId, 'vm-01')
  assert.equal(pool.planner.seatOf(planned('root')), original)
  assert.equal(pool.planner.openCount('vm-01'), 1)
  child.release()
  back.release()
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

test('enabling family mode leaves an older ordinary ticket intact and cleans both queues', async (t) => {
  const pool = await familyPool(t, { max_subagents_per_session: null }, [
    { id: 'vm-01', policy: { sessionSlots: 3, maxConcurrency: 1 } },
  ])
  const main = await pool.selectAndReserve(agentRequest('root'))
  const queued = pool.selectAndReserve(agentRequest('root', 'older'))
  await waitFor(() => pool.queuedTotal() === 1)
  pool.reloadConfig({ max_primary_sessions: 1, max_subagents_per_session: 0 })
  main.release()
  const old = await queued
  assert.equal(old.ok, true)
  assert.equal(old.isSubagent, undefined)
  old.release()
  const unregistered = await pool.selectAndReserve(agentRequest('root', 'before-root-refresh', { allowWait: false }))
  assert.equal(unregistered.isSubagent, undefined)
  unregistered.release()
  ;(await pool.selectAndReserve(agentRequest('root'))).release()
  const fresh = await pool.selectAndReserve(agentRequest('root', 'fresh', { allowWait: false }))
  assert.equal(fresh.reason, 'subagent_limit')
  assert.equal(pool.queuedTotal(), 0)
  assert.equal(pool.planner.subagents.size, 0)
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

test('a ticket from before family mode must wait for the live physical permit at grant', async (t) => {
  const pool = await familyPool(t, { max_subagents_per_session: null }, [{ id: 'vm-01', policy: { sessionSlots: 1 } }])
  const handoff = pool.planner.restore(planned('handoff'), { vmId: 'vm-01', cap: 1, heldUntil: Date.now() + 60000 })
  const queued = pool.selectAndReserve(agentRequest('root', 'older'))
  await waitFor(() => pool.queuedTotal() === 1)
  pool.reloadConfig({ max_subagents_per_session: 0 })
  const probe = await pool.selectAndReserve({ model: MODEL, skipSessionSlot: true, allowWait: false })
  assert.equal(probe.ok, true)
  pool.planner.free(handoff)
  const atHandoff = [pool.vmInflight.get('vm-01'), pool.queuedTotal()]
  probe.release()
  const old = await queued
  assert.equal(old.ok, true)
  assert.equal(old.isSubagent, undefined)
  old.release()
  assert.deepEqual(atHandoff, [1, 1])
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

test('a queued primary registers at grant, even if cancelled before pickup', async (t) => {
  const pool = setup(t, [{ id: 'vm-01', policy: { sessionSlots: 1 } }], {
    max_primary_sessions: 2,
    max_subagents_per_session: 0,
  })
  const probe = await pool.selectAndReserve({ model: MODEL, skipSessionSlot: true })
  const ctrl = new AbortController()
  const queued = seat(pool, 'root', { signal: ctrl.signal })
  await waitFor(() => pool.queuedTotal() === 1)
  probe.release()
  const grantHome = pool.planner.rootVm(planned('root'))
  const calls = []
  const child = new FailoverRunner({ scheduler: pool }).run({
    ...agentRequest('root', 'child'),
    allowQueue: false,
    callAttempt: async () => {
      calls.push('child')
      return { ok: true, status: 200 }
    },
  })
  ctrl.abort()
  await assert.rejects(queued, { code: 'selection_cancelled' })
  const response = await child
  assert.equal(grantHome, 'vm-01')
  assert.equal(pool.planner.rootVm(planned('root')), 'vm-01')
  assert.equal(response.status, 529)
  assert.equal(response.body.error.details.reason, 'subagent_limit')
  assert.deepEqual(calls, [])
  assert.deepEqual(pool.seatSnapshot().seats, {})
  assert.equal(pool.planner.subagents.size, 0)
})

test('a child reclaim yields to an older global primary waiting only for a physical permit', async (t) => {
  for (const m of [0, 1]) {
    const pool = await familyPool(t, { max_subagents_per_session: m, sticky: 150 }, [
      { id: 'vm-01', policy: { sessionSlots: 1 } },
    ])
    const probe = await pool.selectAndReserve({ model: MODEL, skipSessionSlot: true })
    const main = seat(pool, 'main')
    await waitFor(() => pool.planner.globalQueue.length === 1)
    const child = pool.selectAndReserve(agentRequest('root', 'later'))
    await waitFor(() => pool.queuedTotal() === 2)
    const seatsBeforeRelease = pool.planner.openCount('vm-01')
    probe.release()
    const firstSeat = pool.seatSnapshot().seats['vm-01'].sessions[0]?.session_id
    const first = await main
    first.release?.()
    const second = await child
    second.release?.()
    assert.equal(seatsBeforeRelease, 0)
    assert.equal(firstSeat, 'main')
    assert.equal(first.ok, true)
    if (m === 0) assert.equal(second.reason, 'subagent_limit')
    else assert.equal(second.isSubagent, true)
    assert.deepEqual(pool.seatSnapshot().seats, {})
  }
})

test('an earlier main waiting for n takes the freed seat before a child reclaim, locally and globally', async (t) => {
  for (const sticky of [true, false]) {
    const pool = await familyPool(t, {}, [{ id: 'vm-01' }])
    const held = await seat(pool, 'holding')
    if (sticky) pool.stickyRouter.bind('sess:main', { vmId: 'vm-01', accountId: 'account-1' })
    const main = pool.selectAndReserve(agentRequest('main'))
    await waitFor(() => pool.queuedTotal() === 1)
    const child = pool.selectAndReserve(agentRequest('root', 'child'))
    await waitFor(() => pool.queuedTotal() === 2)
    held.release()
    const first = await main
    assert.equal(first.ok, true)
    assert.equal(pool.planner.seatOf(planned('root')), null)
    first.release()
    const second = await child
    assert.equal(second.isSubagent, true)
    second.release()
    assert.deepEqual(pool.seatSnapshot().seats, {})
  }
})

test('legacy snapshot and a pending seat grant retain the observed seat cap when m is null', async (t) => {
  const pool = await familyPool(t, { max_subagents_per_session: null }, [
    { id: 'vm-01', policy: { sessionSlots: 4, maxConcurrency: 2 } },
  ])
  const first = await seat(pool, 'first')
  const second = await seat(pool, 'second')
  const pending = seat(pool, 'third')
  await waitFor(() => pool.queuedTotal() === 1)
  const file = path.join(pool.projectRoot, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file))
  vm.policy.sessionSlots = 1
  fs.writeFileSync(file, JSON.stringify(vm))
  assert.equal(pool.seatSnapshot().seats['vm-01'].seats_max, 4)
  first.release()
  const third = await pending
  assert.equal(third.ok, true)
  assert.equal(pool.planner.openCount('vm-01'), 2)
  second.release()
  third.release()
})

test('a hot-disabled or unreadable VM snapshot uses the observed physical cap', async (t) => {
  const pool = await familyPool(t, { max_primary_sessions: 9 }, [{ id: 'vm-01', policy: { sessionSlots: 2 } }])
  const main = await seat(pool, 'root')
  const view = () => pool.seatSnapshot().seats['vm-01']
  assert.equal(view().seats_max, 9)
  const probe = await pool.selectAndReserve({ model: MODEL, skipSessionSlot: true })
  main.release()
  assert.equal(view().seats_used, 0)
  assert.equal(view().seats_max, 9)
  const next = await seat(pool, 'next')
  pool.reloadConfig({ max_primary_sessions: 9, max_subagents_per_session: null })
  assert.equal(view().seats_max, 2)
  const legacy = view()
  fs.writeFileSync(path.join(pool.projectRoot, 'vms', 'vm-01.json'), '{')
  assert.deepEqual(view(), legacy)
  next.release()
  probe.release()
})

test('reloading unrelated pool settings does not emit a seat change', async (t) => {
  const pool = setup(t, [{ id: 'vm-01' }])
  let changes = 0
  pool.on('change', () => changes++)
  pool.reloadConfig({ queue_max: 11 })
  await Promise.resolve()
  assert.equal(changes, 0)
})

test('expired root registrations are swept before even the first database maintenance write', async (t) => {
  const pool = await familyPool(t)
  ;(await seat(pool, 'fresh')).release()
  pool.planner.roots.get(planned('root')).expiresAt = Date.now() - 1
  pool.healthWrites.set('account-1', {})
  pool.runtimeRepo.writeHeartbeat = () => {
    throw new Error('heartbeat write failed')
  }
  await assert.rejects(pool.maintain(), /heartbeat write failed/)
  assert.deepEqual([...pool.planner.roots.keys()], [planned('fresh')])
})

test('a gated root falls back with an independent child seat and preserves the root binding', async (t) => {
  const pool = await familyPool(t)
  const parent = await pool.selectAndReserve(agentRequest('root'))
  const child = await pool.selectAndReserve(agentRequest('root', 'child', { excluded: new Set(['vm-01']) }))
  assert.equal(child.selectionReason, 'subagent-fallback')
  assert.equal(child.vmId, 'vm-02')
  assert.notEqual(pool.seatSnapshot().seats['vm-02'].sessions[0].session_id, 'root')
  assert.equal(pool.stickyRouter.resolve('sess:root').vmId, 'vm-01')
  assert.equal(pool.planner.openCount('vm-01'), 1)
  child.release()
  parent.release()
})

test('an offline root with family affinity falls back to a healthy VM with queuing off', async (t) => {
  const pool = await familyPool(t)
  const file = path.join(pool.projectRoot, 'vms', 'vm-01.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), node_id: 'node-1' }))
  bindPlacement({ manager: { slotDataPath: () => 'offline' }, projectRoot: pool.projectRoot })
  t.after(() => unbindPlacement())
  const args = agentRequest('root', 'child', { familyVmId: 'vm-01', allowWait: false })
  pool.stickyRouter.bind(args.stickyKey, { vmId: 'vm-01', accountId: 'account-1' })
  const next = await pool.selectAndReserve(args)
  assert.equal(next.selectionReason, 'subagent-fallback')
  assert.equal(next.vmId, 'vm-02')
  assert.equal(pool.planner.roots.size, 1)
  next.release()
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

test('family limits normalize strict integers; requests queued at zero keep their original rule', async (t) => {
  for (const bad of [true, false, '', '3', -1, 21, 1.5, [], null, undefined]) {
    const config = normalizePoolRouting({ max_primary_sessions: bad, max_subagents_per_session: bad })
    assert.equal(config.max_primary_sessions, null)
    assert.equal(config.max_subagents_per_session, null)
  }
  assert.equal(normalizePoolRouting({ max_primary_sessions: 0 }).max_primary_sessions, null)
  assert.equal(normalizePoolRouting({ max_primary_sessions: 20 }).max_primary_sessions, 20)
  assert.equal(normalizePoolRouting({ max_subagents_per_session: 0 }).max_subagents_per_session, 0)
  const pool = await familyPool(t, { max_subagents_per_session: 0, sticky: 60 })
  const pending = pool.selectAndReserve(agentRequest('root', 'child'))
  await waitFor(() => pool.planner.pending() === 1)
  assert.equal(pool.seatSnapshot().seats['vm-01'].sessions[0].subagents_max, 0)
  pool.reloadConfig({ max_primary_sessions: 1, max_subagents_per_session: 1 })
  assert.equal((await pending).reason, 'subagent_limit')
  const child = await pool.selectAndReserve(agentRequest('root', 'fresh'))
  assert.equal(child.vmId, 'vm-01')
  child.release()
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

test('a slower eligibility check cannot cost a child its place in the root FIFO', async (t) => {
  const pool = await familyPool(t, { max_subagents_per_session: 1 })
  const active = await pool.selectAndReserve(agentRequest('root', 'active'))
  const eligible = pool.eligibleCandidates.bind(pool)
  const check = Promise.withResolvers()
  const first = agentRequest('root', 'first')
  pool.eligibleCandidates = async (args) => {
    if (args.stickyKey === first.stickyKey) await check.promise
    return eligible(args)
  }
  const order = []
  const slow = pool.selectAndReserve(first).then((selected) => {
    order.push('first')
    return selected
  })
  const fast = pool.selectAndReserve(agentRequest('root', 'second')).then((selected) => {
    order.push('second')
    return selected
  })
  await waitFor(() => pool.queuedTotal() === 1)
  active.release()
  assert.equal(pool.inflight.size, 0)
  check.resolve()
  const selected = await slow
  assert.equal(selected.ok, true)
  assert.deepEqual(order, ['first'])
  selected.release()
  const next = await fast
  assert.equal(next.ok, true)
  next.release()
  assert.deepEqual(order, ['first', 'second'])
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

test('queued turns of the same child keep the root through a failed upstream attempt', async (t) => {
  const pool = await familyPool(t)
  const runner = new FailoverRunner({ scheduler: pool, stickyRouter: pool.stickyRouter })
  const started = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const request = agentRequest('root', 'agent')
  const observations = []
  const first = runner.run({
    ...request,
    callAttempt: async () => {
      observations.push(pool.planner.seatOf(planned('root')))
      started.resolve()
      await finish.promise
      return {
        ok: false,
        status: 400,
        body: { error: { type: 'invalid_request_error', code: 'bad_request', message: 'invalid body' } },
      }
    },
  })
  await started.promise
  const original = pool.planner.seatOf(planned('root'))
  const second = runner.run({
    ...request,
    callAttempt: () => {
      observations.push(pool.planner.seatOf(planned('root')))
      throw Object.assign(new Error('invalid request'), {
        status: 400,
        body: { error: { code: 'invalid_cache_control' } },
      })
    },
  })
  assert.equal(pool.seatSnapshot().seats['vm-01'].sessions[0].subagents_queued, 1)
  finish.resolve()
  assert.equal((await first).body.error.code, 'bad_request')
  assert.equal((await second).body.error.code, 'invalid_cache_control')
  assert.equal(observations.length, 2)
  assert.ok(original)
  assert.equal(observations[0], original)
  assert.equal(observations[1], original)
  assert.equal(pool.planner.pending(), 0)
  assert.equal(pool.vmInflight.size, 0)
  assert.equal(pool.planner.subagents.size, 0)
  assert.equal(pool.planner.seats.size, 0)
  assert.equal(pool.inflight.size, 0)
})

test('a family native slot_busy retry waits only on its home and respects the original sticky deadline', async (t) => {
  const pool = await familyPool(t, { sticky: 60 })
  const runner = new FailoverRunner({
    scheduler: pool,
    stickyRouter: pool.stickyRouter,
    config: { home_slot_busy_retry_ms: 10, same_account_retry_delay_ms: 0, total_retry_deadline_ms: 2000 },
  })
  const tried = []
  const result = await runner.run({
    ...agentRequest('root', 'child'),
    callAttempt: ({ candidate }) => {
      tried.push(candidate.vmId)
      return {
        ok: false,
        status: 503,
        upstreamExecutions: 0,
        body: { error: { code: 'slot_busy', message: 'no free slot' } },
      }
    },
  })
  assert.ok(tried.length > 1)
  assert.deepEqual([...new Set(tried)], ['vm-01'])
  assert.equal(result.status, 529)
  assert.equal(result.body.error.details.reason, 'pool_queue_timeout')
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

function perVm(holds) {
  const out = {}
  for (const hold of holds) out[hold.vmId] = (out[hold.vmId] || 0) + 1
  return out
}

test('an uncommitted child retries a revoked credential on an ordinary seat; a committed child does not replay', async (t) => {
  for (const committed of [false, true]) {
    const pool = await familyPool(t)
    const runner = new FailoverRunner({ scheduler: pool, stickyRouter: pool.stickyRouter })
    const calls = []
    const result = await runner.run({
      ...agentRequest('root', 'agent'),
      familyKey: 'family2:root',
      familyVmId: 'vm-01',
      callAttempt: ({ candidate, onCommit }) => {
        calls.push([candidate.vmId, candidate.selectionReason, pool.vmInflight.get('vm-01') || 0])
        if (candidate.vmId === 'vm-01') {
          if (committed) onCommit()
          return {
            ok: false,
            status: 401,
            body: { error: { type: 'authentication_error', message: 'token has been revoked' } },
          }
        }
        return {
          ok: true,
          status: 200,
          terminalState: 'verified',
          body: { type: 'message', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} },
        }
      },
    })
    assert.equal(result.ok, !committed)
    assert.deepEqual(
      calls,
      committed
        ? [['vm-01', 'subagent', 1]]
        : [
            ['vm-01', 'subagent', 1],
            ['vm-02', 'subagent-fallback', 0],
          ],
    )
    assert.equal(pool.planner.roots.has(planned(agentRequest('root', 'agent').stickyKey.slice(5))), false)
    assert.deepEqual(pool.seatSnapshot().seats, {})
  }
})

test('a capacity timeout on a child repair takes precedence over the previous upstream 400', async (t) => {
  const pool = await familyPool(t, { sticky: 60 }, [{ id: 'vm-01', policy: { sessionSlots: 1 } }])
  const runner = new FailoverRunner({
    scheduler: pool,
    stickyRouter: pool.stickyRouter,
    config: { signature_repair: true },
  })
  const called = Promise.withResolvers(),
    finish = Promise.withResolvers()
  let calls = 0
  const pending = runner.run({
    ...agentRequest('root', 'agent'),
    callAttempt: async () => {
      calls++
      called.resolve()
      await finish.promise
      return { ok: false, status: 400, body: { error: { message: 'Invalid `signature` in `thinking` block' } } }
    },
  })
  await called.promise
  const main = pool.selectAndReserve(agentRequest('root'))
  await waitFor(() => pool.queuedTotal() === 1)
  finish.resolve()
  const hold = await main
  const result = await pending
  hold.release()
  assert.equal(calls, 1)
  assert.equal(result.status, 529)
  assert.equal(result.body.error.code, 'pool_overloaded')
  assert.equal(result.body.error.details.reason, 'pool_queue_timeout')
  assert.ok(result.retryAfterSec >= 1)
  assert.deepEqual(pool.seatSnapshot().seats, {})
})

test('5 devices on 2×2 seats: 4 seat now, the 5th queues and the 6th waits behind it', async (t) => {
  const pool = setup(t, [
    { id: 'vm-01', policy: { sessionSlots: 2 } },
    { id: 'vm-02', policy: { sessionSlots: 2 } },
  ])
  const held = []
  for (const device of ['d1', 'd2', 'd3', 'd4']) held.push(await seat(pool, device))
  assert.ok(held.every((hold) => hold.ok))
  assert.deepEqual(perVm(held), { 'vm-01': 2, 'vm-02': 2 })
  const fifth = seat(pool, 'd5')
  await waitFor(() => pool.planner.globalQueue.length === 1)
  const sixth = seat(pool, 'd6')
  await waitFor(() => pool.planner.globalQueue.length === 2)
  assert.deepEqual(
    pool.planner.globalQueue.map((ticket) => ticket.seatKey),
    [planned('d5'), planned('d6')],
  )
  held[0].release()
  pool.planner.free(pool.planner.seatOf(planned('d1')))
  const got5 = await fifth
  assert.equal(got5.ok, true)
  assert.equal(got5.vmId, held[0].vmId)
  assert.equal(got5.selectionReason, 'queued')
  assert.deepEqual(
    pool.planner.globalQueue.map((ticket) => ticket.seatKey),
    [planned('d6')],
  )
  held[1].release()
  pool.planner.free(pool.planner.seatOf(planned('d2')))
  const got6 = await sixth
  assert.equal(got6.ok, true)
  for (const hold of [...held.slice(2), got5, got6]) hold.release()
  for (const id of ['d3', 'd4', 'd5', 'd6']) pool.planner.free(pool.planner.seatOf(planned(id)))
})

test('the same device under another owner scope is another seat and cannot free it', async (t) => {
  const pool = setup(t, [
    { id: 'vm-01', policy: { sessionSlots: 1 } },
    { id: 'vm-02', policy: { sessionSlots: 1 }, owner: 'user-7' },
  ])
  const platform = await seat(pool, 'shared')
  assert.equal(platform.vmId, 'vm-01')
  const tenant = await seat(pool, 'shared', { ownerScope: { type: 'user', userId: 'user-7' } })
  assert.equal(tenant.ok, true)
  assert.equal(tenant.vmId, 'vm-02')
  assert.equal(pool.planner.openCount('vm-01'), 1)
  assert.equal(pool.planner.openCount('vm-02'), 1)
  assert.equal(pool.planner.seatOf(planned('shared')).vmId, 'vm-01')
  platform.release()
  tenant.release()
})

test('one device with 3 concurrent requests holds 1 seat; VM concurrency 2 releases them in arrival order', async (t) => {
  const pool = setup(t, [{ id: 'vm-01', policy: { sessionSlots: 2, maxConcurrency: 2 } }])
  const a = await seat(pool, 'x')
  const b = await seat(pool, 'x')
  const order = []
  const c = seat(pool, 'x').then((hold) => (order.push('c'), hold))
  await waitFor(() => (pool.planner.vmQueues.get('vm-01') || []).length === 1)
  const d = seat(pool, 'x').then((hold) => (order.push('d'), hold))
  await waitFor(() => (pool.planner.vmQueues.get('vm-01') || []).length === 2)
  assert.equal(pool.planner.openCount('vm-01'), 1)
  const snap = pool.seatSnapshot()
  assert.equal(snap.seats['vm-01'].seats_used, 1)
  assert.equal(snap.seats['vm-01'].conc_waiting, 2)
  a.release()
  const gotC = await c
  assert.deepEqual(order, ['c'])
  b.release()
  const gotD = await d
  assert.deepEqual(order, ['c', 'd'])
  assert.equal(pool.planner.openCount('vm-01'), 1)
  gotC.release()
  gotD.release()
})

test('seat cap comes from the VM override, else inference.session_slots, clamped to 20', async (t) => {
  const pool = setup(t, [
    { id: 'vm-01', policy: { sessionSlots: 3 } },
    { id: 'vm-02' },
    { id: 'vm-03', policy: { sessionSlots: 50 } },
  ])
  pool.config.default_session_slots = 5
  const caps = Object.fromEntries((await pool.eligibleCandidates({ model: MODEL })).map((c) => [c.vmId, c.seatCap]))
  assert.deepEqual(caps, { 'vm-01': 3, 'vm-02': 5, 'vm-03': 20 })
  pool.config.default_session_slots = 99
  const clamped = await pool.eligibleCandidates({ model: MODEL })
  assert.equal(clamped.find((c) => c.vmId === 'vm-02').seatCap, 20)
})

test('after the request ends the session frees the slot; sticky TTL does not keep it', async (t) => {
  const pool = setup(t, [{ id: 'vm-01', policy: { sessionSlots: 1 } }], { seat_grace_ms: 0 })
  pool.planner.stickyTtlMs = () => 86_400_000
  const owner = await seat(pool, '01a17519-60b0-7218-9d67-d31c47ceedbc')
  assert.equal(owner.ok, true)
  assert.equal(owner.vmId, 'vm-01')
  owner.release()
  assert.equal(pool.planner.openCount('vm-01'), 0)
  assert.equal(pool.seatSnapshot().seats['vm-01'], undefined)
  const again = await seat(pool, '01a17519-60b0-7218-9d67-d31c47ceedbc', { allowWait: false })
  assert.equal(again.ok, true)
  assert.equal(again.vmId, 'vm-01')
  again.release()
  const other = await seat(pool, 'other-session', { allowWait: false })
  assert.equal(other.ok, true)
  assert.equal(other.vmId, 'vm-01')
  assert.equal(pool.planner.openCount('vm-01'), 1)
  other.release()
  assert.equal(pool.planner.openCount('vm-01'), 0)
})

test('a restarted scheduler does not restore an ended session seat from sticky VM memory', async (t) => {
  const pool = setup(t, [{ id: 'vm-01', policy: { sessionSlots: 1 } }])
  const sessionA = '01a17519-60b0-7218-9d67-d31c47ceedbc'
  const held = await seat(pool, sessionA)
  assert.equal(held.vmId, 'vm-01')
  held.release()
  const expiresAt = Date.now() + 60_000
  const rows = {
    [`sess:${sessionA}`]: {
      account_id: held.accountId,
      vm_id: 'vm-01',
      expires_at: expiresAt,
      slot_index: held.slotIndex,
    },
    'dev2:same-device': { account_id: held.accountId, vm_id: 'vm-01', expires_at: expiresAt, slot_index: null },
    'family2:parent': { account_id: held.accountId, vm_id: 'vm-01', expires_at: expiresAt, slot_index: null },
    'sess:expired': { account_id: held.accountId, vm_id: 'vm-01', expires_at: Date.now() - 1, slot_index: 0 },
  }
  const restarted = new PoolScheduler({
    projectRoot: pool.projectRoot,
    runtimeRepo: new RuntimeRepo(),
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    stickyRouter: {
      config: { ttl_seconds: 86400 },
      repo: { all: () => rows },
      resolve: (key) => {
        const ent = rows[key]
        if (!ent || Date.now() > ent.expires_at) return null
        return { accountId: ent.account_id, vmId: ent.vm_id }
      },
    },
    config: { seat_grace_ms: 0 },
  })
  assert.equal(restarted.planner.openCount('vm-01'), 0)
  assert.equal(restarted.seatSnapshot().seats['vm-01'], undefined)
  const other = await restarted.selectAndReserve({ model: MODEL, seatKey: 'seat:sess:other-session', allowWait: false })
  assert.equal(other.ok, true)
  assert.equal(other.vmId, 'vm-01')
  other.release()
  const again = await restarted.selectAndReserve({
    model: MODEL,
    seatKey: `seat:sess:${sessionA}`,
    stickyKey: `sess:${sessionA}`,
    allowWait: false,
  })
  assert.equal(again.ok, true)
  assert.equal(again.vmId, 'vm-01')
  assert.equal(again.selectionReason, 'sticky')
  again.release()
  assert.equal(restarted.planner.openCount('vm-01'), 0)
})

test('a restarted scheduler does not turn a seatless probe sticky row into a seat', async (t) => {
  const pool = setup(t, [{ id: 'vm-01', policy: { sessionSlots: 1 } }])
  const probe = await seat(pool, 'probe-session', { skipSessionSlot: true, allowWait: false })
  assert.equal(probe.ok, true)
  assert.equal(pool.planner.openCount('vm-01'), 0)
  probe.release()
  const expiresAt = Date.now() + 60_000
  const rows = {
    'sess:probe-session': {
      account_id: probe.accountId,
      vm_id: 'vm-01',
      expires_at: expiresAt,
      slot_index: null,
    },
  }
  const restarted = new PoolScheduler({
    projectRoot: pool.projectRoot,
    runtimeRepo: new RuntimeRepo(),
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    stickyRouter: { config: { ttl_seconds: 86400 }, repo: { all: () => rows } },
    config: { seat_grace_ms: 0 },
  })
  assert.equal(restarted.planner.openCount('vm-01'), 0)
  assert.equal(restarted.seatSnapshot().seats['vm-01'], undefined)
  const next = await restarted.selectAndReserve({
    model: MODEL,
    seatKey: 'seat:sess:real-session',
    allowWait: false,
  })
  assert.equal(next.ok, true)
  assert.equal(next.vmId, 'vm-01')
  next.release()
  restarted.planner.free(restarted.planner.seatOf(planned('real-session')))
})

test('a machine keeps one VM; its next session takes a free slot there and a foreign session does not', async (t) => {
  const pool = setup(
    t,
    [
      { id: 'vm-01', policy: { sessionSlots: 2 } },
      { id: 'vm-02', policy: { sessionSlots: 2 } },
    ],
    { sticky: 80, fallback: 80 },
  )
  const first = await seat(pool, 'sess-a', { deviceVmId: 'vm-01' })
  assert.equal(first.ok, true)
  assert.equal(first.vmId, 'vm-01')
  assert.equal(first.selectionReason, 'device-affinity')
  const sibling = await seat(pool, 'sess-b', { deviceVmId: 'vm-01' })
  assert.equal(sibling.ok, true)
  assert.equal(sibling.vmId, 'vm-01')
  assert.equal(sibling.selectionReason, 'device-affinity')
  assert.equal(pool.planner.openCount('vm-01'), 2)
  assert.equal(pool.planner.openCount('vm-02'), 0)
  const foreign = await seat(pool, 'sess-other', { deviceVmId: 'vm-02', allowWait: false })
  assert.equal(foreign.ok, true)
  assert.equal(foreign.vmId, 'vm-02')
  // The machine's VM is full: queue on it. Do not grant another VM before the sticky wait.
  let granted = false
  const crowded = seat(pool, 'sess-c', { deviceVmId: 'vm-01' }).then((hold) => ((granted = true), hold))
  await waitFor(() => (pool.planner.vmQueues.get('vm-01') || []).some((ticket) => ticket.seatKey === planned('sess-c')))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(granted, false)
  assert.equal(pool.planner.globalQueue.length, 0)
  const got = await crowded
  assert.equal(got.ok, true)
  assert.equal(got.vmId, 'vm-02')
  assert.notEqual(got.selectionReason, 'device-affinity')
  first.release()
  sibling.release()
  foreign.release()
  got.release()
  assert.equal(pool.planner.openCount('vm-01'), 0)
  assert.equal(pool.planner.openCount('vm-02'), 0)
})

test('two first sessions of one machine claim the same VM before sticky affinity is written', async (t) => {
  const root = project([
    { id: 'vm-01', policy: { sessionSlots: 2 } },
    { id: 'vm-02', policy: { sessionSlots: 2 } },
  ])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sticky = new StickyRouter({ dataDir: root, config: { sticky: { enabled: true, ttl_seconds: 600 } } })
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: new RuntimeRepo(),
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    stickyRouter: sticky,
    config: { seat_grace_ms: 0 },
  })
  const original = pool.eligibleCandidates.bind(pool)
  pool.eligibleCandidates = async (args) => {
    await new Promise((resolve) => setTimeout(resolve, 30))
    return original(args)
  }
  const runner = new FailoverRunner({ scheduler: pool, stickyRouter: sticky })
  const deviceKey = sticky.canonicalDeviceKey('machine-1')
  const run = (sessionId) =>
    runner.run({
      requestId: sessionId,
      canonicalBody: { model: MODEL },
      model: MODEL,
      stickyKey: sticky.canonicalSessionKey(sessionId),
      seatKey: `seat:sess:${sessionId}`,
      deviceKey,
      stickyDeviceId: 'machine-1',
      callAttempt: async () => ({
        ok: true,
        status: 200,
        terminalState: 'verified',
        body: { type: 'message', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} },
      }),
    })
  const [a, b] = await Promise.all([run('sess-a'), run('sess-b')])
  assert.equal(a.ok && b.ok, true)
  assert.equal(a.vmId, b.vmId)
  assert.equal(pool.planner.openCount(a.vmId), 0)
  assert.equal(pool.planner.openCount(a.vmId === 'vm-01' ? 'vm-02' : 'vm-01'), 0)
  assert.equal(sticky.resolve(deviceKey)?.vmId, a.vmId)
})

test('an expired or unbound machine affinity does not send the next session back to the old VM', async (t) => {
  const root = project([
    { id: 'vm-01', policy: { sessionSlots: 2 } },
    { id: 'vm-02', policy: { sessionSlots: 2 } },
  ])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sticky = new StickyRouter({ dataDir: root, config: { sticky: { enabled: true, ttl_seconds: 600 } } })
  const pool = scheduler(root, { seat_grace_ms: 0 })
  pool.stickyRouter = sticky
  const deviceKey = sticky.canonicalDeviceKey('machine-1')
  sticky.bindDeviceAffinity(deviceKey, { accountId: 'account-1', vmId: 'vm-01' }, { countHit: false })
  sticky.repo.upsert(deviceKey, {
    ...sticky.repo.get(deviceKey),
    expires_at: Date.now() - 1,
  })
  assert.equal(pool.machineHome(deviceKey), '')
  const next = await pool.selectAndReserve({
    model: MODEL,
    seatKey: 'seat:sess:after-expiry',
    deviceKey,
    allowWait: false,
  })
  assert.equal(next.ok, true)
  assert.notEqual(next.selectionReason, 'device-affinity')
  next.release()
  pool.planner.free(pool.planner.seatOf(planned('after-expiry')))
  sticky.bindDeviceAffinity(deviceKey, { accountId: 'account-2', vmId: 'vm-02' }, { countHit: false })
  sticky.unbind(deviceKey)
  assert.equal(pool.machineHome(deviceKey), '')
  const moved = await pool.selectAndReserve({
    model: MODEL,
    seatKey: 'seat:sess:after-unbind',
    deviceKey,
    allowWait: false,
  })
  assert.equal(moved.ok, true)
  assert.notEqual(moved.selectionReason, 'device-affinity')
  assert.equal(sticky.resolve(deviceKey)?.vmId, moved.vmId)
  moved.release()
  pool.planner.free(pool.planner.seatOf(planned('after-unbind')))
})

test('budget gate: 5% headroom, 2% reserve, 2 open seats → no new seat, open seats still served', async (t) => {
  assert.equal(budgetAllows(0.05, 2, 0.02), false)
  assert.equal(budgetAllows(0.05, 1, 0.02), true)
  assert.equal(budgetAllows(null, 9, 0.02), true)
  const planner = new SeatPlanner({ reservePct: 0.02 })
  planner.open('a', { vmId: 'vm-1', cap: 4 })
  assert.equal(planner.canOpen('vm-1', 4, 0.05), true)
  planner.open('b', { vmId: 'vm-1', cap: 4 })
  assert.equal(planner.canOpen('vm-1', 4, 0.05), false)

  const pool = setup(t, [{ id: 'vm-01', policy: { sessionSlots: 4 } }])
  const check = pool.checkEligibility.bind(pool)
  pool.checkEligibility = async (args) => ({ ...(await check(args)), headroom: 0.05 })
  const d1 = await seat(pool, 'd1')
  const d2 = await seat(pool, 'd2')
  assert.equal(d1.ok && d2.ok, true)
  const d3 = await seat(pool, 'd3', { allowWait: false })
  assert.equal(d3.ok, false)
  const d1Again = await seat(pool, 'd1', { allowWait: false })
  assert.equal(d1Again.ok, true)
  assert.equal(d1Again.selectionReason, 'seat-held')
  for (const hold of [d1, d2, d1Again]) hold.release()
})

test('balanced spreads 4 devices 2/2, fill packs 4/0; headroom then vmId break ties', async (t) => {
  const specs = [
    { id: 'vm-01', policy: { sessionSlots: 4, maxConcurrency: 8 } },
    { id: 'vm-02', policy: { sessionSlots: 4, maxConcurrency: 8 } },
  ]
  const balanced = setup(t, specs)
  const spread = []
  for (const device of ['b1', 'b2', 'b3', 'b4']) spread.push(await seat(balanced, device))
  assert.deepEqual(perVm(spread), { 'vm-01': 2, 'vm-02': 2 })
  assert.equal(spread[0].selectionReason, 'balanced')
  for (const hold of spread) hold.release()

  const fill = setup(t, specs, { strategy: 'fill' })
  const packed = []
  for (const device of ['f1', 'f2', 'f3', 'f4']) packed.push(await seat(fill, device))
  assert.deepEqual(perVm(packed), { 'vm-01': 4 })
  assert.equal(packed[0].selectionReason, 'fill')
  for (const hold of packed) hold.release()

  const openOf = () => 0
  const tie = [
    { vmId: 'vm-a', seatCap: 4, headroom: 0.3 },
    { vmId: 'vm-b', seatCap: 4, headroom: 0.5 },
  ]
  assert.equal(rankSeatCandidates(tie, { strategy: 'balanced', openOf })[0].vmId, 'vm-b')
  assert.equal(rankSeatCandidates(tie, { strategy: 'fill', openOf })[0].vmId, 'vm-b')
  const prio = [{ ...tie[0], priority: 9 }, tie[1]]
  assert.equal(rankSeatCandidates(prio, { strategy: 'balanced', openOf })[0].vmId, 'vm-a')
  const even = [
    { vmId: 'vm-b', seatCap: 4, headroom: 0.4 },
    { vmId: 'vm-a', seatCap: 4, headroom: 0.4 },
  ]
  assert.equal(rankSeatCandidates(even, { strategy: 'balanced', openOf })[0].vmId, 'vm-a')
})

test('a granted global ticket keeps its original fallback deadline for native admission', async (t) => {
  const pool = setup(t, [{ id: 'vm-01', policy: { sessionSlots: 1 } }], { fallback: 1000, sticky: 5000 })
  const held = await seat(pool, 'held')
  const started = Date.now()
  const pending = seat(pool, 'queued', { deadline: started + 8000 })
  await waitFor(() => pool.planner.pending() === 1)
  const ticketDeadline = pool.planner.globalQueue[0].deadline
  held.release()
  const granted = await pending
  assert.equal(granted.ok, true)
  assert.equal(granted.slotWaitDeadlineMs, ticketDeadline)
  granted.release()
  const noWait = await seat(pool, 'no-wait', { allowWait: false })
  assert.equal(noWait.ok, true)
  assert.equal(noWait.slotWaitMs, 0)
  assert.ok(noWait.slotWaitDeadlineMs <= Date.now())
  noWait.release()
  const directNoWait = await pool.selectAndReserve({ model: MODEL, allowWait: false })
  assert.equal(directNoWait.ok, true)
  assert.equal(directNoWait.slotWaitMs, 0)
  assert.ok(directNoWait.slotWaitDeadlineMs <= Date.now())
  directNoWait.release()
})

test('queue timeout is pool_queue_timeout', async (t) => {
  const pool = setup(t, [{ id: 'vm-01', policy: { sessionSlots: 1 } }], { fallback: 80 })
  const held = await seat(pool, 'd1')
  const started = Date.now()
  const late = await seat(pool, 'd2')
  assert.equal(late.ok, false)
  assert.equal(late.reason, 'pool_queue_timeout')
  assert.ok(Date.now() - started >= 70)
  assert.equal(pool.planner.pending(), 0)
  held.release()
})

test('queue_max=2: the 3rd waiter is refused at once; a freed place admits the next', async (t) => {
  const pool = setup(t, [{ id: 'vm-01', policy: { sessionSlots: 1 } }], { queue_max: 2 })
  const held = await seat(pool, 'd1')
  const cancel = new AbortController()
  const second = seat(pool, 'd2', { signal: cancel.signal })
  const third = seat(pool, 'd3')
  await waitFor(() => pool.queuedTotal() === 2)
  const started = Date.now()
  await assert.rejects(seat(pool, 'd4'), { code: 'pool_wait_queue_full' })
  assert.ok(Date.now() - started < 200)
  cancel.abort()
  await assert.rejects(second, { code: 'selection_cancelled' })
  assert.equal(pool.queuedTotal(), 1)
  const fifth = seat(pool, 'd5')
  await waitFor(() => pool.queuedTotal() === 2)
  held.release()
  pool.planner.free(pool.planner.seatOf(planned('d1')))
  const got3 = await third
  got3.release()
  pool.planner.free(pool.planner.seatOf(planned('d3')))
  const got5 = await fifth
  got5.release()
  pool.planner.free(pool.planner.seatOf(planned('d5')))
})

test('pool routing normalization: queue_max clamps, legacy strategy, dropped per-account cap', () => {
  assert.equal(normalizePoolRouting({}).queue_max, 50)
  assert.equal(normalizePoolRouting({ queue_max: 0 }).queue_max, 1)
  assert.equal(normalizePoolRouting({ queue_max: 1000 }).queue_max, 999)
  for (const legacy of ['weighted-round-robin', 'round-robin', 'lru', 'fill-first', 'nope']) {
    assert.equal(normalizePoolRouting({ strategy: legacy }).strategy, 'balanced')
  }
  assert.equal(normalizePoolRouting({ strategy: 'fill' }).strategy, 'fill')
  const next = normalizePoolRouting({
    max_waiters_per_account: 100,
    seat_grace_ms: 999999,
    seat_budget_reserve_pct: 0.9,
  })
  assert.equal(Object.hasOwn(next, 'max_waiters_per_account'), false)
  assert.equal(next.seat_grace_ms, 120000)
  assert.equal(next.seat_budget_reserve_pct, 0.5)
  assert.equal(normalizePoolRouting({}).seat_budget_reserve_pct, 0.02)
})

test('seatless and pinned requests bypass the planner', async (t) => {
  const pool = setup(t, [{ id: 'vm-01', policy: { sessionSlots: 1 } }])
  const probe = await seat(pool, 'p', { skipSessionSlot: true, allowWait: false })
  const pinned = await seat(pool, 'q', { pinVmId: 'vm-01', allowWait: false })
  assert.equal(probe.ok && pinned.ok, true)
  assert.equal(pool.planner.openCount('vm-01'), 0)
  probe.release()
  pinned.release()
})

test('failover off a VM frees the old seat at once and opens one on the new VM', async (t) => {
  const pool = setup(
    t,
    [
      { id: 'vm-01', policy: { sessionSlots: 1 } },
      { id: 'vm-02', policy: { sessionSlots: 1 } },
    ],
    { seat_grace_ms: 30000 },
  )
  const first = await seat(pool, 'dev')
  const home = first.vmId
  first.release()
  assert.equal(pool.planner.openCount(home), 0)
  const other = home === 'vm-01' ? 'vm-02' : 'vm-01'
  const moved = await seat(pool, 'dev', { excluded: new Set([first.accountId]), allowWait: false })
  assert.equal(moved.ok, true)
  assert.equal(moved.vmId, other)
  assert.equal(moved.seatMoved, false)
  assert.equal(pool.planner.openCount(home), 0)
  assert.equal(pool.planner.seatOf(planned('dev')).vmId, other)
  moved.release()
  assert.equal(pool.planner.openCount(other), 0)
})

test('a rehomed concurrency wait starts at the move and stays on that VM', async (t) => {
  const pool = setup(
    t,
    [
      { id: 'vm-01', policy: { sessionSlots: 1, maxConcurrency: 1 } },
      { id: 'vm-02', policy: { sessionSlots: 1, maxConcurrency: 1 } },
    ],
    { fallback: 80, sticky: 500 },
  )
  const heldA = await seat(pool, 'a')
  const heldB = await seat(pool, 'b')
  const home = heldA.vmId
  const first = seat(pool, 'c')
  const second = seat(pool, 'c')
  await waitFor(() => pool.planner.globalQueue.length === 2)
  heldA.release()
  pool.planner.free(pool.planner.seatOf(planned('a')))
  const gotFirst = await first
  assert.equal(gotFirst.ok, true)
  assert.equal(gotFirst.vmId, home)
  await waitFor(() => (pool.planner.vmQueues.get(home) || []).some((ticket) => ticket.kind === 'conc'))
  await new Promise((resolve) => setTimeout(resolve, 180))
  assert.equal(pool.planner.globalQueue.length, 0)
  assert.equal(
    (pool.planner.vmQueues.get(home) || []).some((ticket) => ticket.seatKey === planned('c')),
    true,
  )
  assert.equal(pool.planner.seatOf(planned('c')).vmId, home)
  gotFirst.release()
  const gotSecond = await second
  assert.equal(gotSecond.ok, true)
  assert.equal(gotSecond.vmId, home)
  assert.equal(gotSecond.reason, undefined)
  gotSecond.release()
  heldB.release()
  pool.planner.free(pool.planner.seatOf(planned('b')))
  pool.planner.free(pool.planner.seatOf(planned('c')))
})

test('a follow-up already queued on the VM keeps the slot after the current request ends', async (t) => {
  const pool = setup(t, [{ id: 'vm-01', policy: { sessionSlots: 2, maxConcurrency: 1 } }], {
    sticky: 5000,
    fallback: 5000,
  })
  const heldA = await seat(pool, 'a')
  const heldB = await seat(pool, 'b')
  const waitingC = seat(pool, 'c')
  await waitFor(() => pool.planner.globalQueue.length === 1)
  const againA = seat(pool, 'a')
  await waitFor(() => (pool.planner.vmQueues.get('vm-01') || []).some((ticket) => ticket.seatKey === planned('a')))
  heldA.release()
  const gotA = await againA
  assert.equal(gotA.ok, true)
  assert.equal(gotA.vmId, 'vm-01')
  assert.equal(gotA.selectionReason, 'queued')
  assert.equal(pool.planner.seatOf(planned('a'))?.live, true)
  assert.deepEqual(
    pool.planner.globalQueue.map((ticket) => ticket.seatKey),
    [planned('c')],
  )
  // B's request ended while A was waiting for concurrency, so its slot is already gone.
  assert.equal(heldB.ok, false)
  gotA.release()
  assert.equal(pool.planner.seatOf(planned('a')), null)
  const gotC = await waitingC
  assert.equal(gotC.ok, true)
  assert.equal(gotC.vmId, 'vm-01')
  gotC.release()
  assert.equal(pool.planner.openCount('vm-01'), 0)
})

test('a sticky seat wait leaves a home VM that stopped being eligible', async (t) => {
  const pool = setup(
    t,
    [
      { id: 'vm-01', policy: { sessionSlots: 1, maxConcurrency: 2 } },
      { id: 'vm-02', policy: { sessionSlots: 1, maxConcurrency: 2 } },
    ],
    { sticky: 8000, fallback: 8000 },
  )
  const heldA = await seat(pool, 'a', { deviceVmId: 'vm-01' })
  const heldB = await seat(pool, 'b', { deviceVmId: 'vm-02' })
  assert.equal(heldA.vmId, 'vm-01')
  assert.equal(heldB.vmId, 'vm-02')
  const waiting = seat(pool, 'c', { deviceVmId: 'vm-01' })
  await waitFor(() => (pool.planner.vmQueues.get('vm-01') || []).some((ticket) => ticket.seatKey === planned('c')))
  pool.runtimeRepo.upsert({ account_id: 'account-1', rate_limit_reset_at: Date.now() + 60_000 })
  await waitFor(() => pool.planner.globalQueue.some((ticket) => ticket.seatKey === planned('c')), 4500)
  assert.equal(
    (pool.planner.vmQueues.get('vm-01') || []).some((ticket) => ticket.seatKey === planned('c')),
    false,
  )
  heldB.release()
  pool.planner.free(pool.planner.seatOf(planned('b')))
  const got = await waiting
  assert.equal(got.ok, true)
  assert.equal(got.vmId, 'vm-02')
  assert.equal(got.selectionReason, 'queued')
  got.release()
  heldA.release()
  pool.planner.free(pool.planner.seatOf(planned('a')))
  pool.planner.free(pool.planner.seatOf(planned('c')))
})

test('a queued sticky session is not rehomed when another VM gains priority', async (t) => {
  const pool = setup(
    t,
    [
      { id: 'vm-01', policy: { priority: 1, sessionSlots: 1 } },
      { id: 'vm-02', policy: { priority: 1, sessionSlots: 1 } },
    ],
    { sticky: 5000, fallback: 5000 },
  )
  const stickyKey = 'p:anthropic:sess:continuation'
  pool.stickyRouter = {
    resolve: (key) => (key === stickyKey ? { vmId: 'vm-01', accountId: 'account-1' } : null),
  }
  const held = await seat(pool, 'occupant', { deviceVmId: 'vm-01' })
  assert.equal(held.vmId, 'vm-01')
  const pending = seat(pool, 'continuation', { stickyKey, deadline: Date.now() + 4000 })
  const getTicket = () =>
    pool.planner.vmQueues.get('vm-01')?.find((ticket) => ticket.seatKey === planned('continuation'))
  await waitFor(() => !!getTicket()?.wake)
  const ticket = getTicket()
  const otherVmFile = path.join(pool.projectRoot, 'vms', 'vm-02.json')
  const otherVm = JSON.parse(fs.readFileSync(otherVmFile, 'utf8'))
  otherVm.policy.priority = 10
  fs.writeFileSync(otherVmFile, JSON.stringify(otherVm))
  ticket.wake()
  await waitFor(() => ticket.candidates.get('vm-02')?.priority === 10)
  assert.equal(ticket.kind, 'seat')
  held.release()
  const resumed = await pending
  assert.equal(resumed.ok, true)
  assert.equal(resumed.vmId, 'vm-01')
  resumed.release()
})

test('seat stream frames carry per-VM seats, global queue and queue_max', async (t) => {
  const pool = setup(t, [{ id: 'vm-01', policy: { sessionSlots: 1 } }])
  let changes = 0
  pool.on('change', () => changes++)
  const req = new EventEmitter()
  const res = new EventEmitter()
  const frames = []
  res.write = (chunk) => frames.push(String(chunk))
  servePoolSeatStream({ req, res, getScheduler: () => pool, writeSSEHeaders() {}, throttleMs: 1, pingMs: 60_000 })
  const held = await seat(pool, 'd1')
  await waitFor(() => frames.length >= 2)
  assert.ok(changes > 0)
  const last = JSON.parse(frames.at(-1).split('data: ')[1])
  assert.equal(last.seats['vm-01'].seats_used, 1)
  assert.equal(last.seats['vm-01'].inflight, 1)
  assert.equal(last.global_queue_depth, 0)
  assert.equal(last.queue_max, 50)
  assert.equal(Object.hasOwn(last, 'holds'), false)
  const before = frames.length
  held.release()
  await waitFor(() => frames.length > before)
  const after = JSON.parse(frames.at(-1).split('data: ')[1])
  assert.equal(after.seats['vm-01']?.inflight ?? 0, 0, 'release pushes a frame with the request gone')
  req.emit('close')
})

function gatedQuota(root) {
  const tier = { limit_5h: 0.8, limit_7d: 0.8, max_concurrency: 4 }
  return new AccountQuota({
    dataDir: fs.mkdtempSync(path.join(root, 'quota-')),
    config: {
      quota: { block_on_5h: true, block_on_7d: true, critical_band: 0.05, gate_overshoot: 0.05 },
      tiers: { default: tier, pro: tier, max: tier },
    },
  })
}

function gatedSetup(t, specs) {
  const root = project(specs)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const quota = gatedQuota(root)
  specs.forEach((vm, index) => quota.ensure({ account_id: `account-${index + 1}`, vm_id: vm.id }))
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: new RuntimeRepo(quota.repo),
    accountQuota: quota,
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { seat_grace_ms: 30000 },
  })
  pool.config.sticky_wait_timeout_ms = 2000
  pool.config.fallback_wait_timeout_ms = 2000
  return { pool, quota }
}

function setUtil5h(quota, accountId, value) {
  quota.ingestHeaders(accountId, {
    'anthropic-ratelimit-unified-5h-utilization': String(value),
    'anthropic-ratelimit-unified-5h-status': 'allowed',
  })
}

test('near the gate a seated device waits on its home, one call at a time, and never moves', async (t) => {
  const { pool, quota } = gatedSetup(t, [
    { id: 'vm-01', policy: { sessionSlots: 4 } },
    { id: 'vm-02', policy: { sessionSlots: 4 } },
  ])
  const first = await seat(pool, 'dev', { deviceVmId: 'vm-01' })
  assert.equal(first.vmId, 'vm-01')
  // 76% of an 80% line: inside the 5-point band, below the line.
  setUtil5h(quota, first.accountId, 0.76)
  const second = seat(pool, 'dev')
  await waitFor(() => (pool.planner.vmQueues.get('vm-01') || []).some((ticket) => ticket.seatKey === planned('dev')))
  assert.equal(quota.inflight.get(first.accountId), 1, 'the second call does not run beside the first')
  first.release()
  const got = await second
  assert.equal(got.ok, true)
  assert.equal(got.vmId, 'vm-01')
  got.release()
  assert.equal(pool.planner.openCount('vm-01'), 0)
  // The dialog ended, so the next turn opens a seat again. Inside the overshoot
  // the old home is draining and an open VM is preferred.
  setUtil5h(quota, first.accountId, 0.83)
  const third = await seat(pool, 'dev', { deviceVmId: 'vm-01', allowWait: false })
  assert.equal(third.vmId, 'vm-02')
  assert.equal(third.seatMoved, false)
  third.release()
  assert.equal(pool.planner.openCount('vm-02'), 0)
})

test('at line plus overshoot a seated device leaves and its old seat frees at once', async (t) => {
  const { pool, quota } = gatedSetup(t, [
    { id: 'vm-01', policy: { sessionSlots: 4 } },
    { id: 'vm-02', policy: { sessionSlots: 4 } },
  ])
  const first = await seat(pool, 'dev', { deviceVmId: 'vm-01' })
  first.release()
  setUtil5h(quota, first.accountId, 0.85)
  const moved = await seat(pool, 'dev', { allowWait: false })
  assert.equal(moved.ok, true)
  assert.equal(moved.vmId, 'vm-02')
  assert.equal(moved.seatMoved, false)
  assert.equal(pool.planner.openCount('vm-01'), 0)
  moved.release()
  assert.equal(pool.planner.openCount('vm-02'), 0)
})

test('a new device takes an open VM before a draining one, and a draining one when nothing else is open', async (t) => {
  const { pool, quota } = gatedSetup(t, [
    { id: 'vm-01', policy: { sessionSlots: 1 } },
    { id: 'vm-02', policy: { sessionSlots: 1 } },
  ])
  setUtil5h(quota, 'account-1', 0.78)
  const fresh = await seat(pool, 'new', { deviceVmId: 'vm-01', allowWait: false })
  assert.equal(fresh.vmId, 'vm-02', 'sticky home in the band does not beat an open VM')
  const last = await seat(pool, 'other', { allowWait: false })
  assert.equal(last.vmId, 'vm-01', 'the draining VM still takes a device when it is the only seat left')
  fresh.release()
  last.release()
})

test('new seats exhaust the highest priority tier before using a lower affinity VM', async (t) => {
  const { pool, quota } = gatedSetup(t, [
    { id: 'vm-01', policy: { priority: 1, sessionSlots: 1 } },
    { id: 'vm-02', policy: { priority: 10, sessionSlots: 1 } },
    { id: 'vm-03', policy: { priority: 10, sessionSlots: 1 } },
  ])
  setUtil5h(quota, 'account-2', 0.78)
  const options = { deviceVmId: 'vm-01', familyVmId: 'vm-01', allowWait: false }
  const first = await seat(pool, 'first', options)
  assert.equal(first.vmId, 'vm-03')
  const next = await seat(pool, 'next', options)
  assert.equal(next.vmId, 'vm-02')
  const fallback = await seat(pool, 'fallback', options)
  assert.equal(fallback.vmId, 'vm-01')
  assert.equal(fallback.selectionReason, 'device-affinity')
  for (const hold of [first, next, fallback]) hold.release()
})

test('a released seat does not hold a new turn on its draining own VM', async (t) => {
  const { pool, quota } = gatedSetup(t, [
    { id: 'vm-01', policy: { priority: 10, sessionSlots: 1 } },
    { id: 'vm-02', policy: { priority: 1, sessionSlots: 1 } },
  ])
  pool.stickyRouter = { resolve: (key) => (key === 'conv-drain' ? { vmId: 'vm-02', accountId: 'account-2' } : null) }
  const high = await seat(pool, 'high')
  const low = await seat(pool, 'low')
  assert.equal(high.vmId, 'vm-01')
  assert.equal(low.vmId, 'vm-02')
  setUtil5h(quota, 'account-2', 0.78)
  const queued = seat(pool, 'drain', { stickyKey: 'conv-drain' })
  await waitFor(() => pool.planner.globalQueue.length + (pool.planner.vmQueues.get('vm-02') || []).length === 1)
  assert.equal(pool.planner.globalQueue.length, 1, 'no session-home wait on a draining VM')
  high.release()
  const got = await queued
  assert.equal(got.ok, true)
  assert.equal(got.vmId, 'vm-01')
  got.release()
  low.release()
})

test('a global waiter places its new seat by priority, not by the VM pumped first', async (t) => {
  const pool = setup(t, [
    { id: 'vm-01', policy: { priority: 1, sessionSlots: 1 } },
    { id: 'vm-02', policy: { priority: 10, sessionSlots: 1 } },
  ])
  const pump = pool.planner.pump.bind(pool.planner)
  const high = await seat(pool, 'high')
  const low = await seat(pool, 'low')
  const queued = seat(pool, 'queued')
  await waitFor(() => pool.planner.globalQueue.length === 1)
  pool.planner.pump = () => {}
  low.release()
  high.release()
  pool.planner.pump = pump
  pool.planner.pump('vm-01')
  const granted = await queued
  assert.equal(granted.vmId, 'vm-02')
  granted.release()
})
