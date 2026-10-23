import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  extractCallerSession,
  resolveInboundIdentity,
  resolveSeatIdentity,
} from '../../src/lib/identity/identity-rewrite.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { explicitParentSessionId, scopeAssignmentKey, StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { UnitCircuit } from '../../src/lib/pool/unit-circuit.mjs'

const MODEL = 'claude-test'

function setup(
  t,
  { mode = 'session', graceMs = 0, owners = {}, policies = {}, config = {}, workerHealth = null } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-session-routing-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms, { recursive: true })
  for (const index of [1, 2]) {
    const id = `vm-0${index}`
    fs.writeFileSync(
      path.join(vms, `${id}.json`),
      JSON.stringify({
        id,
        name: id,
        status: 'running',
        schedulable: true,
        proxy_cli_enabled: true,
        proxy: { id: `proxy-${id}`, url: `socks5h://127.0.0.1:${11000 + index}` },
        runtime: { worker_socket: path.join(vms, id, 'run', 'worker.sock') },
        ...(owners[id] ? { owner_user_id: owners[id] } : {}),
        policy: { maxConcurrency: 2, concurrencyOverride: true, sessionSlots: 4, weight: 1, ...policies[id] },
        claude: {
          account_uuid: `account-${index}`,
          account_tier: 'max',
          access_token: `synthetic-access-${index}`,
          refresh_token: `synthetic-refresh-${index}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    )
  }
  fs.writeFileSync(path.join(vms, 'active.json'), JSON.stringify({ active_vm: 'vm-01' }))
  const states = new Map()
  const runtimeRepo = {
    get: (id) => states.get(id) || null,
    clearExpired() {},
    upsert: (state) => states.set(state.account_id, { ...states.get(state.account_id), ...state }),
    markCooldown(id, update) {
      const state = states.get(id) || { account_id: id, vm_id: update.vmId }
      const cooldown = { cooldown_until: update.until, cooldown_reason: update.reason }
      states.set(
        id,
        update.model
          ? {
              ...state,
              model_states: { ...state.model_states, [update.model]: { ...cooldown, reason: update.reason } },
            }
          : { ...state, ...cooldown, status: update.status },
      )
    },
  }
  let pool
  let sticky
  let runner
  const instances = []
  const restart = () => {
    if (sticky) {
      sticky.db.close()
      instances.at(-1).closed = true
    }
    sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
    pool = new PoolScheduler({
      projectRoot: root,
      stickyRouter: sticky,
      runtimeRepo,
      accountQuota: { canAccept: () => ({ ok: true }) },
      workerHealth: workerHealth || (async () => ({ ok: true, credential: { generation: 1, has_access: true } })),
      config: { ...(mode ? { assignment_mode: mode } : {}), seat_grace_ms: graceMs, ...config },
    })
    pool.unitCircuit = new UnitCircuit({ repo: runtimeRepo })
    runner = new FailoverRunner({
      scheduler: pool,
      stickyRouter: sticky,
      config: { same_account_retry_delay_ms: 0, max_total_attempts: 4, total_retry_deadline_ms: 2000 },
    })
    instances.push({ pool, sticky })
  }
  restart()
  const held = []
  const trace = []
  let nextRequest = 0
  const record = (requestId, sessionId, selected, state = null) => {
    trace.push({
      requestId,
      sessionId,
      vmId: selected?.vmId || null,
      inFlight: { ...pool.snapshot().inflight },
      waiting: pool.queuedTotal(),
      state: state || (selected?.ok ? 'executing' : selected?.reason || 'waiting'),
    })
  }
  const route = (sessionId, extra = {}) => {
    const headers = extra.headers || {}
    const requestedAssignmentMode = extra.assignmentMode || pool.config.assignment_mode || 'device'
    const scope = { ownerScope: extra.ownerScope, keyScope: extra.keyScope }
    const inbound = {
      model: MODEL,
      metadata: {
        user_id: {
          ...(extra.noDevice ? {} : { device_id: 'shared-device' }),
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(extra.parent
            ? { ...(extra.parentOnly ? {} : { root_session_id: extra.parent }), parent_session_id: extra.parent }
            : {}),
        },
      },
      messages: [
        {
          role: 'user',
          content: 'Synthetic scheduling request with stable content, created only for this regression test.',
        },
      ],
    }
    const req = { headers, apiKeyRecord: { id: 'synthetic-key' } }
    const identity = resolveInboundIdentity({ inbound, headers })
    const resolvedRoot = requestedAssignmentMode === 'session' ? sticky.resolveAssignmentRoot(req, inbound, scope) : ''
    const assignmentMode = requestedAssignmentMode === 'session' && resolvedRoot ? 'session' : 'device'
    const rootSession =
      resolvedRoot || explicitParentSessionId(inbound, headers) || extractCallerSession({ inbound, headers })
    const seat = resolveSeatIdentity({ inbound, headers, mode: assignmentMode, rootSessionId: rootSession })
    const sessionKeys = sticky.sessionPoolKeys(req, inbound, {
      sessionId: identity.sessionId,
      deviceId: identity.deviceId,
      assignmentMode,
      ...scope,
    })
    const familyKey = rootSession
      ? sticky.familyPoolKey(req, rootSession, {
          trusted: true,
          assignmentMode,
          ...scope,
        })
      : null
    return {
      model: MODEL,
      canonicalBody: inbound,
      rawSeatKey: seat.key,
      seatKey: assignmentMode === 'session' ? scopeAssignmentKey(seat.key, scope) : seat.key,
      assignmentMode,
      ...sessionKeys,
      sessionLockKey:
        sessionKeys.stickyKey && identity.sessionId
          ? scopeAssignmentKey(sticky.canonicalSessionKey(identity.sessionId), scope)
          : sessionKeys.stickyKey,
      legacyBindingKeys: {
        session: sessionKeys.legacyBindingKeys || [],
        family: rootSession
          ? [sticky.canonicalFamilyKey(rootSession), sticky.familyKey(req, rootSession, 'anthropic')]
          : [],
      },
      familyKey,
      familyVmId: familyKey ? sticky.resolve(familyKey)?.vmId || null : null,
      deviceKey:
        assignmentMode === 'session' && identity.sessionId ? null : sticky.canonicalDeviceKey(identity.deviceId),
      stickyDeviceId: identity.deviceId,
      ...scope,
    }
  }
  const select = async (sessionId, extra = {}) => {
    const requestId = `request-${++nextRequest}`
    const args = route(sessionId, extra)
    record(requestId, sessionId, null, 'submitted')
    const selected = await pool.selectAndReserve({
      ...args,
      allowWait: false,
      ...extra,
    })
    if (selected.ok) {
      held.push(selected)
      const release = selected.release
      let released = false
      selected.release = () => {
        if (released) return
        released = true
        release()
        record(requestId, sessionId, selected, 'released')
      }
    }
    record(requestId, sessionId, selected)
    return selected
  }
  const run = async (sessionId, extra = {}) => {
    const requestId = `request-${++nextRequest}`
    const args = route(sessionId, extra)
    record(requestId, sessionId, null, 'submitted')
    const result = await runner.run({
      ...args,
      requestId,
      ...extra,
      applyAttempt: (body, selected) => ({ body, meta: { sessionId: `outbound:${args.stickyKey}:${selected.vmId}` } }),
      callAttempt: async (attempt) => {
        record(requestId, sessionId, { ...attempt.candidate, ok: true }, 'executing')
        return extra.callAttempt ? extra.callAttempt(attempt) : success()
      },
    })
    record(requestId, sessionId, result, result.ok ? 'completed' : 'failed')
    return result
  }
  t.after(() => {
    for (const hold of held) hold.release()
    for (const instance of instances) {
      for (const seat of [...instance.pool.planner.seats.values()]) instance.pool.planner.free(seat)
      for (const timer of instance.pool.cooldownTimers.values()) clearTimeout(timer)
      if (!instance.closed) instance.sticky.db.close()
    }
    t.diagnostic(`request trace: ${JSON.stringify(trace)}`)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    get pool() {
      return pool
    },
    get sticky() {
      return sticky
    },
    get runner() {
      return runner
    },
    select,
    run,
    route,
    trace,
    record,
    restart,
    runtimeRepo,
  }
}

function success() {
  return {
    ok: true,
    status: 200,
    terminalState: 'verified',
    body: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'synthetic response' }],
      stop_reason: 'end_turn',
    },
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(check, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error('synthetic scheduling condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('session assignment uses an idle VM when another root session on the same device fills its VM', async (t) => {
  const { pool, select, trace } = setup(t)
  const first = await select('root-a')
  const parallel = await select('root-a')
  assert.equal(first.ok, true)
  assert.equal(first.vmId, 'vm-01')
  assert.equal(parallel.vmId, first.vmId)
  assert.deepEqual(pool.snapshot().inflight, { 'account-1': 2 })

  const independent = await select('root-b')
  assert.equal(independent.ok, true, `independent root should execute on idle VM: ${JSON.stringify(trace)}`)
  assert.equal(independent.vmId, 'vm-02')
  assert.deepEqual(pool.snapshot().inflight, { 'account-1': 2, 'account-2': 1 })
  assert.equal(pool.queuedTotal(), 0)
})

test('default device assignment still queues independent sessions on the same device seat', async (t) => {
  const h = setup(t, { mode: null })
  assert.equal(h.pool.config.assignment_mode, 'device')
  const first = await h.select('root-a')
  const second = await h.select('root-b')
  assert.equal(first.vmId, 'vm-01')
  assert.equal(second.vmId, first.vmId)
  const controller = new AbortController()
  const pending = h.select('root-c', { allowWait: true, signal: controller.signal })
  const rejected = assert.rejects(pending, { code: 'selection_cancelled' })
  await waitFor(() => h.pool.queuedTotal() === 1)
  h.record('device-wait', 'root-c', { vmId: first.vmId }, 'waiting')
  assert.deepEqual(h.pool.snapshot().inflight, { 'account-1': 2 })
  assert.equal(h.pool.planner.openCount('vm-02'), 0)
  controller.abort()
  await rejected
  assert.equal(h.pool.queuedTotal(), 0)
})

test('session affinity overrides device affinity and ignores unrelated legacy device binding', async (t) => {
  const h = setup(t)
  h.sticky.bind(h.sticky.canonicalDeviceKey('shared-device'), { accountId: 'account-1', vmId: 'vm-01' })
  const first = await h.select('root-a')
  const other = await h.select('root-b', { deviceVmId: 'vm-01' })
  assert.equal(first.vmId, 'vm-01')
  assert.equal(other.vmId, 'vm-02')
  assert.notEqual(h.route('root-a').familyKey, h.route('root-b').familyKey)
})

test('a busy durable session waits on its account after seat grace expires', async (t) => {
  const h = setup(t, { graceMs: 10 })
  const first = await h.run('root-a')
  assert.equal(first.vmId, 'vm-01')
  const key = h.route('root-a').stickyKey
  await waitFor(() => h.pool.planner.seats.size === 0)
  assert.equal(h.sticky.resolve(key).vmId, first.vmId)
  const holders = await Promise.all([
    h.pool.selectAndReserve({ model: MODEL, pinVmId: first.vmId, allowWait: false }),
    h.pool.selectAndReserve({ model: MODEL, pinVmId: first.vmId, allowWait: false }),
  ])
  t.after(() => holders.forEach((hold) => hold.release()))
  const waiting = h.select('root-a', { allowWait: true })
  await waitFor(() => h.pool.queuedTotal() === 1)
  h.record('sticky-wait', 'root-a', { vmId: first.vmId }, 'waiting')
  assert.deepEqual(h.pool.snapshot().inflight, { 'account-1': 2 })
  holders[0].release()
  const resumed = await waiting
  assert.equal(resumed.vmId, first.vmId)
  assert.equal(h.sticky.resolve(key).vmId, first.vmId)
  resumed.release()
  holders[1].release()
  assert.deepEqual(h.pool.snapshot().inflight, {})
})

test('explicit parent and Claude Code agent sessions share the root account but retain separate context', async (t) => {
  const h = setup(t)
  const parent = await h.run('root-a')
  const child = await h.run('child-a', { parent: 'root-a' })
  const agent = await h.run('root-a', { headers: { 'x-claude-code-agent-id': 'agent-a' } })
  assert.equal(child.vmId, parent.vmId)
  assert.equal(agent.vmId, parent.vmId)
  const parentRoute = h.route('root-a')
  const childRoute = h.route('child-a', { parent: 'root-a' })
  const agentRoute = h.route('root-a', { headers: { 'x-claude-code-agent-id': 'agent-a' } })
  assert.equal(childRoute.seatKey, parentRoute.seatKey)
  assert.equal(agentRoute.seatKey, parentRoute.seatKey)
  assert.equal(childRoute.familyKey, parentRoute.familyKey)
  assert.notEqual(childRoute.stickyKey, parentRoute.stickyKey)
  assert.notEqual(agentRoute.stickyKey, parentRoute.stickyKey)
  assert.notEqual(h.sticky.resolve(childRoute.stickyKey).sessionId, h.sticky.resolve(parentRoute.stickyKey).sessionId)
  assert.deepEqual(h.pool.snapshot().inflight, {})
})

test('missing explicit session keeps stable device or fingerprint fallback', async (t) => {
  const h = setup(t)
  const deviceFirst = await h.select('')
  const deviceAgain = await h.select('')
  assert.equal(deviceAgain.vmId, deviceFirst.vmId)
  assert.equal(h.route('').assignmentMode, 'device')
  assert.equal(h.route('').seatKey, 'seat:dev:shared-device')
  assert.equal(h.route('').rawSeatKey, 'seat:dev:shared-device')
  deviceFirst.release()
  deviceAgain.release()
  const fingerprint = h.route('', { noDevice: true }).seatKey
  assert.equal(h.route('', { noDevice: true }).assignmentMode, 'device')
  assert.match(h.route('', { noDevice: true }).rawSeatKey, /^seat:h:/)
  assert.equal(h.route('', { noDevice: true }).seatKey, fingerprint)
  const first = await h.select('', { noDevice: true })
  const again = await h.select('', { noDevice: true })
  assert.equal(again.vmId, first.vmId)
})

test('concurrent first reservations for one root use one account and never exceed concurrency', async (t) => {
  const h = setup(t)
  const started = await Promise.all(Array.from({ length: 6 }, () => h.select('concurrent-root')))
  const executing = started.filter((selected) => selected.ok)
  assert.equal(executing.length, 2)
  assert.deepEqual(new Set(executing.map((selected) => selected.vmId)), new Set(['vm-01']))
  assert.equal(started.filter((selected) => !selected.ok).length, 4)
  assert.deepEqual(h.pool.snapshot().inflight, { 'account-1': 2 })
  assert.equal(h.pool.planner.seats.size, 1)
  assert.equal(h.sticky.resolve(h.route('concurrent-root').familyKey).vmId, 'vm-01')
  for (const selected of executing) selected.release()
  assert.deepEqual(h.pool.snapshot().inflight, {})
})

test('runner serializes concurrent first turns without losing a cancelled waiter or binding', async (t) => {
  const h = setup(t)
  const finish = deferred()
  let entered = 0
  const first = h.run('serial-root', {
    callAttempt: async () => {
      entered += 1
      await finish.promise
      return success()
    },
  })
  await waitFor(() => entered === 1)
  const controller = new AbortController()
  const cancelled = h.run('serial-root', {
    signal: controller.signal,
    callAttempt: () => {
      entered += 1
      return success()
    },
  })
  const third = h.run('serial-root', {
    callAttempt: () => {
      entered += 1
      return success()
    },
  })
  controller.abort()
  const cancelledResult = await cancelled
  assert.equal(cancelledResult.status, 499)
  assert.equal(entered, 1)
  assert.deepEqual(h.pool.snapshot().inflight, { 'account-1': 1 })
  finish.resolve()
  const [firstResult, thirdResult] = await Promise.all([first, third])
  assert.equal(firstResult.vmId, thirdResult.vmId)
  assert.equal(entered, 2)
  assert.equal(h.sticky.resolve(h.route('serial-root').stickyKey).vmId, firstResult.vmId)
  assert.deepEqual(h.pool.snapshot().inflight, {})
})

test('seat queue cancellation and timeout release no extra concurrency and preserve durable home', async (t) => {
  const h = setup(t)
  h.pool.config.sticky_wait_timeout_ms = 35
  h.pool.config.fallback_wait_timeout_ms = 35
  const first = await h.select('root-a')
  const second = await h.select('root-a')
  const key = h.route('root-a').familyKey
  const controller = new AbortController()
  const pending = h.select('root-a', { allowWait: true, signal: controller.signal })
  const rejected = assert.rejects(pending, { code: 'selection_cancelled' })
  await waitFor(() => h.pool.queuedTotal() === 1)
  h.record('queue-cancel', 'root-a', { vmId: first.vmId }, 'waiting')
  controller.abort()
  await rejected
  assert.equal(h.pool.queuedTotal(), 0)
  const timeout = await h.select('root-a', { allowWait: true })
  assert.equal(timeout.ok, false)
  assert.equal(timeout.reason, 'pool_queue_timeout')
  assert.equal(h.pool.queuedTotal(), 0)
  assert.deepEqual(h.pool.snapshot().inflight, { 'account-1': 2 })
  assert.equal(h.sticky.resolve(key).vmId, first.vmId)
  first.release()
  second.release()
  const after = await h.select('root-a')
  assert.equal(after.vmId, first.vmId)
  after.release()
  assert.deepEqual(h.pool.snapshot().inflight, {})
})

test('cancelling a running mock upstream keeps its session binding and releases reservation', async (t) => {
  const h = setup(t)
  const original = await h.run('root-a')
  const key = h.route('root-a').stickyKey
  const outboundSession = h.sticky.resolve(key).sessionId
  const cancelled = await h.run('root-a', {
    callAttempt: () => ({ ok: false, status: 499, clientCancelled: true, terminalState: 'cancelled' }),
  })
  assert.equal(cancelled.status, 499)
  assert.equal(h.sticky.resolve(key).sessionId, outboundSession)
  assert.deepEqual(h.pool.snapshot().inflight, {})
  const next = await h.run('root-a')
  assert.equal(next.vmId, original.vmId)
  assert.equal(h.sticky.resolve(key).sessionId, outboundSession)
})

test('retryable upstream failure releases each attempt and the following turn keeps the migrated account', async (t) => {
  const h = setup(t)
  const seen = []
  const result = await h.run('retry-root', {
    callAttempt: ({ candidate }) => {
      seen.push(candidate.vmId)
      if (seen.length > 1) return success()
      return {
        ok: false,
        status: 502,
        terminalState: 'rejected',
        body: { type: 'error', error: { type: 'api_error', message: 'synthetic upstream timeout' } },
      }
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(seen, ['vm-01', 'vm-02'])
  assert.deepEqual(h.pool.snapshot().inflight, {})
  const next = await h.run('retry-root')
  assert.equal(next.vmId, result.vmId)
  assert.equal(h.sticky.resolve(h.route('retry-root').familyKey).vmId, result.vmId)
})

test('an unavailable account migrates its family while preserving unrelated session binding', async (t) => {
  const h = setup(t, { graceMs: 1000 })
  const parent = await h.run('root-a')
  const child = await h.run('child-a', { parent: 'root-a' })
  const unrelated = await h.run('root-b')
  assert.equal(parent.vmId, 'vm-01')
  assert.equal(child.vmId, parent.vmId)
  assert.equal(unrelated.vmId, 'vm-02')
  const unrelatedKey = h.route('root-b').stickyKey
  const unrelatedBefore = h.sticky.resolve(unrelatedKey)
  h.runtimeRepo.upsert({ account_id: 'account-1', vm_id: 'vm-01', rate_limit_reset_at: Date.now() + 60_000 })
  const moved = await h.run('root-a')
  const movedChild = await h.run('child-a', { parent: 'root-a' })
  assert.equal(moved.vmId, 'vm-02')
  assert.equal(movedChild.vmId, moved.vmId)
  assert.deepEqual(h.sticky.resolve(unrelatedKey), unrelatedBefore)
  assert.deepEqual(h.pool.snapshot().inflight, {})
})

test('seat expiry and recreated control-plane objects preserve the persisted account binding', async (t) => {
  const h = setup(t, { graceMs: 10 })
  const first = await h.select('persisted-root', { excluded: new Set(['account-1']) })
  assert.equal(first.vmId, 'vm-02')
  first.release()
  await waitFor(() => h.pool.planner.seats.size === 0)
  const familyKey = h.route('persisted-root').familyKey
  assert.equal(h.sticky.resolve(familyKey).vmId, 'vm-02')
  h.restart()
  assert.equal(h.pool.planner.seats.size, 0)
  assert.equal(h.sticky.resolve(familyKey).vmId, 'vm-02')
  const resumed = await h.run('persisted-root')
  assert.equal(resumed.vmId, 'vm-02')
})

test('identical root identifiers in different tenant scopes have separate seats and durable bindings', async (t) => {
  const h = setup(t, { owners: { 'vm-02': 'tenant-b' } })
  const tenant = { ownerScope: { type: 'user', userId: 'tenant-b' } }
  const platform = await h.select('same-root')
  const privateTenant = await h.select('same-root', tenant)
  assert.equal(platform.vmId, 'vm-01')
  assert.equal(privateTenant.vmId, 'vm-02')
  const platformKey = h.route('same-root').familyKey
  const tenantKey = h.route('same-root', tenant).familyKey
  assert.notEqual(platformKey, tenantKey)
  assert.equal(h.sticky.resolve(platformKey).vmId, 'vm-01')
  assert.equal(h.sticky.resolve(tenantKey).vmId, 'vm-02')
  privateTenant.release()
  const again = await h.select('same-root')
  assert.equal(again.vmId, platform.vmId)
  assert.equal(h.sticky.resolve(tenantKey).vmId, 'vm-02')
})

test('identical root identifiers in different pools or API-key slot restrictions do not share bindings', async (t) => {
  const h = setup(t)
  const scope = (pool, vm) => ({ keyScope: { group_type: 'anthropic', vm_pool_id: pool, allowed_vms: [vm] } })
  const one = scope('pool-one', 'vm-01')
  const two = scope('pool-two', 'vm-02')
  const first = await h.run('same-root', one)
  const second = await h.run('same-root', two)
  assert.equal(first.vmId, 'vm-01')
  assert.equal(second.vmId, 'vm-02')
  const firstKey = h.route('same-root', one).familyKey
  const secondKey = h.route('same-root', two).familyKey
  assert.notEqual(firstKey, secondKey)
  assert.equal(h.sticky.resolve(firstKey).vmId, 'vm-01')
  assert.equal(h.sticky.resolve(secondKey).vmId, 'vm-02')
  const restrictedOne = scope(null, 'vm-01')
  const restrictedTwo = scope(null, 'vm-02')
  assert.notEqual(h.route('same-root', restrictedOne).familyKey, h.route('same-root', restrictedTwo).familyKey)
  assert.equal((await h.run('same-root', restrictedOne)).vmId, 'vm-01')
  assert.equal((await h.run('same-root', restrictedTwo)).vmId, 'vm-02')
  assert.equal((await h.run('same-root', one)).vmId, first.vmId)
})

test('configuration changes preserve in-flight counters and queued reservations', async (t) => {
  const h = setup(t)
  const first = await h.select('root-a')
  const second = await h.select('root-a')
  const waiting = h.select('root-a', { allowWait: true })
  await waitFor(() => h.pool.queuedTotal() === 1)
  h.record('reload-wait', 'root-a', { vmId: first.vmId }, 'waiting')
  h.pool.reloadConfig({ ...h.pool.config, assignment_mode: 'device', strategy: 'fill' })
  assert.deepEqual(h.pool.snapshot().inflight, { 'account-1': 2 })
  assert.equal(h.pool.queuedTotal(), 1)
  const third = await h.select('root-new')
  assert.equal(third.vmId, 'vm-02')
  h.pool.reloadConfig({ ...h.pool.config, assignment_mode: 'session' })
  assert.deepEqual(h.pool.snapshot().inflight, { 'account-1': 2, 'account-2': 1 })
  first.release()
  const granted = await waiting
  assert.equal(granted.vmId, first.vmId)
  assert.deepEqual(h.pool.snapshot().inflight, { 'account-1': 2, 'account-2': 1 })
  second.release()
  granted.release()
  third.release()
  assert.deepEqual(h.pool.snapshot().inflight, {})
  assert.equal(h.pool.queuedTotal(), 0)
  assert.equal((await h.run('root-a')).vmId, first.vmId)
})

test('nested parent-only relations keep the root account across a control-plane restart', async (t) => {
  const h = setup(t)
  const initial = await h.select('root-a', { excluded: new Set(['account-1']) })
  initial.release()
  const child = await h.run('child-a', { parent: 'root-a', parentOnly: true })
  const nested = await h.run('grandchild-a', { parent: 'child-a', parentOnly: true })
  assert.equal(child.vmId, 'vm-02')
  assert.equal(nested.vmId, child.vmId)
  const rootKey = h.route('root-a').familyKey
  assert.equal(h.route('grandchild-a').familyKey, rootKey)
  assert.equal(h.route('grandchild-a').seatKey, h.route('root-a').seatKey)
  h.restart()
  const after = await h.run('grandchild-a')
  assert.equal(after.vmId, 'vm-02')
  assert.equal(h.route('grandchild-a').familyKey, rootKey)
  assert.notEqual(h.route('grandchild-a').stickyKey, h.route('child-a').stickyKey)
})

test('existing exact session bindings migrate lazily while unrelated legacy rows stay unchanged', async (t) => {
  const h = setup(t)
  const legacyKey = h.sticky.canonicalSessionKey('existing-root')
  const unrelatedKey = h.sticky.canonicalSessionKey('unrelated-root')
  h.sticky.bind(legacyKey, { accountId: 'account-2', vmId: 'vm-02', sessionId: 'legacy-outbound' })
  h.sticky.bind(unrelatedKey, { accountId: 'account-1', vmId: 'vm-01', sessionId: 'unrelated-outbound' })
  const legacy = h.sticky.repo.get(legacyKey)
  const unrelated = h.sticky.repo.get(unrelatedKey)
  assert.equal(h.sticky.resolve(h.route('existing-root').stickyKey), null)
  const resumed = await h.run('existing-root')
  assert.equal(resumed.vmId, 'vm-02')
  assert.equal(h.sticky.resolve(h.route('existing-root').stickyKey).sessionId, 'legacy-outbound')
  assert.deepEqual(h.sticky.repo.get(legacyKey), legacy)
  assert.deepEqual(h.sticky.repo.get(unrelatedKey), unrelated)
  const independent = await h.run('new-root')
  assert.equal(independent.vmId, 'vm-01')
})

test('legacy pins outside the permitted account pool cannot seed a session assignment', async (t) => {
  const h = setup(t)
  h.sticky.bind(h.sticky.canonicalSessionKey('existing-root'), { accountId: 'account-1', vmId: 'vm-01' })
  h.sticky.bind(h.sticky.canonicalFamilyKey('existing-root'), { accountId: 'account-1', vmId: 'vm-01' })
  const restricted = { keyScope: { group_type: 'anthropic', vm_pool_id: 'restricted', allowed_vms: ['vm-02'] } }
  const allowed = await h.run('existing-root', restricted)
  assert.equal(allowed.ok, true)
  assert.equal(allowed.vmId, 'vm-02')
  assert.equal(h.sticky.resolve(h.route('existing-root', restricted).familyKey).vmId, 'vm-02')
  assert.equal(h.sticky.resolve(h.sticky.canonicalSessionKey('existing-root')).vmId, 'vm-01')
})

test('session assignment persists independently of the legacy sticky enabled setting', async (t) => {
  const h = setup(t)
  h.sticky.config.enabled = false
  const first = await h.select('root-a', { excluded: new Set(['account-1']) })
  assert.equal(first.vmId, 'vm-02')
  first.release()
  assert.equal(h.sticky.resolve(h.route('root-a').familyKey).vmId, 'vm-02')
  const resumed = await h.run('root-a')
  assert.equal(resumed.vmId, first.vmId)
  assert.equal(h.sticky.resolve(h.route('root-a').stickyKey).vmId, first.vmId)
})

test('a busy persisted home times out without moving to an idle account after grace expires', async (t) => {
  const h = setup(t)
  const first = await h.run('root-a')
  assert.equal(h.pool.planner.seats.size, 0)
  const holders = await Promise.all([
    h.pool.selectAndReserve({ model: MODEL, pinVmId: first.vmId, allowWait: false }),
    h.pool.selectAndReserve({ model: MODEL, pinVmId: first.vmId, allowWait: false }),
  ])
  t.after(() => holders.forEach((hold) => hold.release()))
  h.pool.config.sticky_wait_timeout_ms = 30
  h.pool.config.fallback_wait_timeout_ms = 30
  const waiting = h.select('root-a', { allowWait: true })
  await waitFor(() => h.pool.queuedTotal() === 1)
  h.record('expired-home-wait', 'root-a', { vmId: first.vmId }, 'waiting')
  const result = await waiting
  assert.equal(result.reason, 'pool_queue_timeout')
  assert.equal(result.ok, false)
  assert.deepEqual(h.pool.snapshot().inflight, { 'account-1': 2 })
  assert.equal(h.pool.queuedTotal(), 0)
  assert.equal(h.sticky.resolve(h.route('root-a').familyKey).vmId, first.vmId)
  holders.forEach((hold) => hold.release())
  assert.equal((await h.run('root-a')).vmId, first.vmId)
  assert.deepEqual(h.pool.snapshot().inflight, {})
})

for (const gate of ['quota', 'credential', 'model permission', 'manual scheduling', 'circuit fault']) {
  test(`session assignment respects ${gate} eligibility while retaining unrelated session bindings`, async (t) => {
    const h = setup(t, { graceMs: 1000 })
    const affected = await h.run('affected-root')
    const unrelated = await h.run('unrelated-root')
    assert.equal(affected.vmId, 'vm-01')
    assert.equal(unrelated.vmId, 'vm-02')
    const unrelatedKey = h.route('unrelated-root').stickyKey
    const before = h.sticky.repo.get(unrelatedKey)
    const vmFile = path.join(h.root, 'vms', 'vm-01.json')
    const vm = JSON.parse(fs.readFileSync(vmFile, 'utf8'))
    if (gate === 'quota') {
      h.pool.accountQuota.canAccept = (accountId) =>
        accountId === 'account-1' ? { ok: false, reason: 'five_hour_limit' } : { ok: true }
    } else if (gate === 'credential') {
      vm.claude.expires_at = Math.floor(Date.now() / 1000) - 3600
      delete vm.claude.refresh_token
      vm.claude.has_refresh = false
    } else if (gate === 'model permission') {
      vm.policy.allowed_models = ['claude-other']
    } else if (gate === 'manual scheduling') {
      vm.schedulable = false
      vm.schedule_disabled_reason = 'disabled'
    } else {
      for (let failures = 0; failures < 3; failures += 1) h.pool.unitCircuit.recordFailure('account-1')
    }
    fs.writeFileSync(vmFile, JSON.stringify(vm))
    const candidates = await h.pool.eligibleCandidates({ model: MODEL })
    assert.deepEqual(
      candidates.map((candidate) => candidate.vmId),
      ['vm-02'],
    )
    const migrated = await h.run('affected-root')
    assert.equal(migrated.ok, true)
    assert.equal(migrated.vmId, 'vm-02')
    assert.equal(h.sticky.resolve(h.route('affected-root').familyKey).vmId, 'vm-02')
    assert.deepEqual(h.sticky.repo.get(unrelatedKey), before)
    assert.deepEqual(h.pool.snapshot().inflight, {})
    assert.equal(h.pool.queuedTotal(), 0)
  })
}

for (const gate of ['quota', 'credential', 'model permission', 'manual scheduling']) {
  test(`queued session rechecks ${gate} before claiming newly released capacity`, async (t) => {
    const h = setup(t)
    h.pool.config.sticky_wait_timeout_ms = 1000
    h.pool.config.fallback_wait_timeout_ms = 1000
    const parent = await h.select('root-a')
    const child = await h.select('child-a', { parent: 'root-a' })
    const waiting = h.select('child-b', { parent: 'root-a', allowWait: true })
    await waitFor(() => h.pool.queuedTotal() === 1)
    h.record('eligibility-wait', 'child-b', { vmId: parent.vmId }, 'waiting')
    const vmFile = path.join(h.root, 'vms', `${parent.vmId}.json`)
    const vm = JSON.parse(fs.readFileSync(vmFile, 'utf8'))
    if (gate === 'quota') {
      h.runtimeRepo.upsert({
        account_id: parent.accountId,
        vm_id: parent.vmId,
        rate_limit_reset_at: Date.now() + 60_000,
      })
      h.pool.releaseAccountSessions({ accountId: parent.accountId, vmId: parent.vmId })
    } else if (gate === 'credential') {
      vm.claude.expires_at = Math.floor(Date.now() / 1000) - 3600
      delete vm.claude.refresh_token
      vm.claude.has_refresh = false
    } else if (gate === 'model permission') {
      vm.policy.allowed_models = ['claude-other']
    } else {
      vm.schedulable = false
      vm.schedule_disabled_reason = 'disabled'
    }
    fs.writeFileSync(vmFile, JSON.stringify(vm))
    parent.release()
    const granted = await waiting
    assert.equal(granted.ok, true)
    assert.equal(granted.vmId, 'vm-02', `${gate} changed while queued: ${JSON.stringify(h.trace)}`)
    assert.equal(h.sticky.resolve(h.route('root-a').familyKey).vmId, granted.vmId)
    assert.deepEqual(h.pool.snapshot().inflight, { 'account-1': 1, 'account-2': 1 })
    granted.release()
    child.release()
    assert.deepEqual(h.pool.snapshot().inflight, {})
    assert.equal(h.pool.queuedTotal(), 0)
  })
}

test('switching from device to session assignment keeps an in-flight session serialized', async (t) => {
  const h = setup(t, { mode: 'device' })
  const finish = deferred()
  let active = 0
  let peak = 0
  const first = h.run('same-root', {
    callAttempt: async () => {
      active += 1
      peak = Math.max(peak, active)
      await finish.promise
      active -= 1
      return success()
    },
  })
  await waitFor(() => active === 1)
  const deviceRoute = h.route('same-root')
  h.pool.reloadConfig({ ...h.pool.config, assignment_mode: 'session' })
  const sessionRoute = h.route('same-root')
  assert.notEqual(sessionRoute.stickyKey, deviceRoute.stickyKey)
  assert.equal(sessionRoute.sessionLockKey, deviceRoute.sessionLockKey)
  const second = h.run('same-root', {
    callAttempt: () => {
      active += 1
      peak = Math.max(peak, active)
      active -= 1
      return success()
    },
  })
  await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 40))])
  h.record('mode-change', 'same-root', { vmId: 'vm-01' }, 'waiting')
  finish.resolve()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(peak, 1)
  assert.equal(secondResult.vmId, firstResult.vmId)
  assert.deepEqual(h.pool.snapshot().inflight, {})
})

test('eligibility refreshed across asynchronous worker health checks cannot reserve a newly blocked account', async (t) => {
  const finishHealth = deferred()
  let checkingSecondVm = false
  const h = setup(t, {
    workerHealth: async ({ vmId }) => {
      if (vmId === 'vm-02') {
        checkingSecondVm = true
        await finishHealth.promise
      }
      return { ok: true, credential: { generation: 1, has_access: true } }
    },
  })
  const pending = h.select('new-root')
  await waitFor(() => checkingSecondVm)
  h.record('worker-health-wait', 'new-root', { vmId: 'vm-02' }, 'checking eligibility')
  h.runtimeRepo.upsert({ account_id: 'account-1', vm_id: 'vm-01', rate_limit_reset_at: Date.now() + 60_000 })
  h.pool.releaseAccountSessions({ accountId: 'account-1', vmId: 'vm-01' })
  finishHealth.resolve()
  const selected = await pending
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  assert.equal(h.sticky.resolve(h.route('new-root').familyKey).vmId, 'vm-02')
  assert.deepEqual(h.pool.snapshot().inflight, { 'account-2': 1 })
  selected.release()
  assert.deepEqual(h.pool.snapshot().inflight, {})
})

test('kernel slot_busy retries the bound account within its deadline and preserves the session', async (t) => {
  const h = setup(t)
  const slotBusy = () => ({
    ok: false,
    status: 503,
    terminalState: 'rejected',
    body: { error: { type: 'worker_error', code: 'slot_busy', message: 'synthetic kernel has no free slot' } },
  })
  const attempts = []
  const recovered = await h.run('busy-root', {
    callAttempt: ({ candidate }) => {
      attempts.push(candidate.vmId)
      return attempts.length === 1 ? slotBusy() : success()
    },
  })
  assert.equal(recovered.ok, true)
  assert.deepEqual(attempts, ['vm-01', 'vm-01'])
  assert.deepEqual(h.pool.snapshot().inflight, {})
  h.runner.config.total_retry_deadline_ms = 60
  h.runner.config.same_account_retry_delay_ms = 5
  const alwaysBusy = []
  const started = Date.now()
  const bounded = await h.run('busy-root', {
    callAttempt: ({ candidate }) => {
      alwaysBusy.push(candidate.vmId)
      return slotBusy()
    },
  })
  assert.equal(bounded.ok, false)
  assert.ok(Date.now() - started < 1000)
  assert.ok(alwaysBusy.length > 0)
  assert.deepEqual(new Set(alwaysBusy), new Set(['vm-01']))
  assert.equal(h.sticky.resolve(h.route('busy-root').familyKey).vmId, 'vm-01')
  assert.deepEqual(h.pool.snapshot().inflight, {})
  assert.equal(h.pool.queuedTotal(), 0)
  assert.equal((await h.run('busy-root')).vmId, 'vm-01')
})

test('balanced session assignment spreads sequential roots across different priorities after every request ends', async (t) => {
  const h = setup(t, { policies: { 'vm-01': { priority: 6 }, 'vm-02': { priority: 3 } } })
  const homes = []
  for (const root of ['root-a', 'root-b', 'root-c', 'root-d']) {
    const result = await h.run(root)
    assert.equal(result.ok, true)
    homes.push(result.vmId)
    assert.equal(h.pool.planner.seats.size, 0)
  }
  assert.deepEqual(homes, ['vm-01', 'vm-02', 'vm-01', 'vm-02'])
  const resumed = await Promise.all(['root-a', 'root-b', 'root-c', 'root-d'].map((root) => h.select(root)))
  assert.deepEqual(
    resumed.map((result) => result.vmId),
    homes,
  )
  assert.deepEqual(h.pool.snapshot().inflight, { 'account-1': 2, 'account-2': 2 })
})

test('released seats and a control-plane restart retain root load and the original account', async (t) => {
  const h = setup(t, { graceMs: 10, policies: { 'vm-01': { priority: 6 }, 'vm-02': { priority: 3 } } })
  const first = await h.select('root-a')
  first.release()
  await waitFor(() => h.pool.planner.seats.size === 0)
  h.restart()
  const second = await h.run('root-b')
  assert.equal(second.vmId, 'vm-02')
  const resumed = await h.run('root-a')
  assert.equal(resumed.vmId, first.vmId)
})

test('child contexts count as one root when distributing subsequent independent sessions', async (t) => {
  const h = setup(t, { policies: { 'vm-01': { priority: 6 }, 'vm-02': { priority: 3 } } })
  assert.equal((await h.run('root-a')).vmId, 'vm-01')
  for (const child of ['child-a', 'child-b', 'child-c']) {
    assert.equal((await h.run(child, { parent: 'root-a' })).vmId, 'vm-01')
  }
  assert.equal((await h.run('root-b')).vmId, 'vm-02')
  assert.equal((await h.run('root-c')).vmId, 'vm-01')
})

test('new session load accounts for each account concurrency capacity', async (t) => {
  const h = setup(t, {
    policies: { 'vm-01': { priority: 6, maxConcurrency: 4 }, 'vm-02': { priority: 3, maxConcurrency: 2 } },
  })
  const homes = []
  for (const root of ['root-a', 'root-b', 'root-c', 'root-d', 'root-e', 'root-f']) homes.push((await h.run(root)).vmId)
  assert.deepEqual(homes, ['vm-01', 'vm-02', 'vm-01', 'vm-01', 'vm-02', 'vm-01'])
})

test('a resumed unmarked root keeps its account and contributes load for new sessions', async (t) => {
  const h = setup(t, { policies: { 'vm-01': { priority: 6 }, 'vm-02': { priority: 3 } } })
  const old = h.route('old-root')
  h.sticky.bind(old.familyKey, { accountId: 'account-1', vmId: 'vm-01' }, { countHit: false })
  h.sticky.bind(old.stickyKey, { accountId: 'account-1', vmId: 'vm-01', sessionId: 'existing-outbound' })
  h.restart()
  assert.equal((await h.run('old-root')).vmId, 'vm-01')
  assert.equal(h.sticky.resolve(old.stickyKey).sessionId, 'existing-outbound')
  assert.equal((await h.run('new-root')).vmId, 'vm-02')
  assert.equal(h.sticky.resolve(old.familyKey).vmId, 'vm-01')
})

test('fill session assignment retains its priority-first placement', async (t) => {
  const h = setup(t, {
    policies: { 'vm-01': { priority: 6 }, 'vm-02': { priority: 3 } },
    config: { strategy: 'fill' },
  })
  assert.equal((await h.run('root-a')).vmId, 'vm-01')
  assert.equal((await h.run('root-b')).vmId, 'vm-01')
})

test('simultaneous independent first requests observe each prior root reservation', async (t) => {
  const h = setup(t, { policies: { 'vm-01': { priority: 6 }, 'vm-02': { priority: 3 } } })
  const first = await Promise.all(['root-a', 'root-b'].map((root) => h.select(root)))
  assert.deepEqual(
    first.map((result) => result.vmId),
    ['vm-01', 'vm-02'],
  )
  assert.deepEqual(h.pool.snapshot().inflight, { 'account-1': 1, 'account-2': 1 })
})

test('root load expiry affects only new assignments and priority changes preserve old homes', async (t) => {
  const h = setup(t, { policies: { 'vm-01': { priority: 6 }, 'vm-02': { priority: 3 } } })
  assert.equal((await h.run('root-a')).vmId, 'vm-01')
  assert.equal((await h.run('root-b')).vmId, 'vm-02')
  const vmFile = path.join(h.root, 'vms', 'vm-02.json')
  const vm = JSON.parse(fs.readFileSync(vmFile, 'utf8'))
  vm.policy.priority = 10
  fs.writeFileSync(vmFile, JSON.stringify(vm))
  assert.equal((await h.run('root-a')).vmId, 'vm-01')
  assert.equal((await h.run('root-b')).vmId, 'vm-02')
  const rootKey = h.route('root-a').familyKey
  h.sticky.repo.upsert(rootKey, { ...h.sticky.repo.get(rootKey), expires_at: Date.now() - 1 })
  assert.equal((await h.run('root-c')).vmId, 'vm-01')
  assert.equal(h.sticky.resolve(h.route('root-b').familyKey).vmId, 'vm-02')
})

test('old roots concentrated on one account are never redistributed by balancing new roots', async (t) => {
  const h = setup(t, { policies: { 'vm-01': { priority: 6 }, 'vm-02': { priority: 3 } } })
  for (const root of ['old-a', 'old-b']) {
    const route = h.route(root)
    h.sticky.bind(route.familyKey, { accountId: 'account-1', vmId: 'vm-01' }, { countHit: false })
    h.sticky.bind(route.stickyKey, { accountId: 'account-1', vmId: 'vm-01', sessionId: `existing-${root}` })
  }
  h.restart()
  for (const root of ['old-a', 'old-b']) assert.equal((await h.run(root)).vmId, 'vm-01')
  assert.equal((await h.run('new-a')).vmId, 'vm-02')
  for (const root of ['old-a', 'old-b']) {
    assert.equal((await h.run(root)).vmId, 'vm-01')
    assert.equal(h.sticky.resolve(h.route(root).stickyKey).sessionId, `existing-${root}`)
  }
  assert.equal((await h.run('new-b')).vmId, 'vm-02')
})
