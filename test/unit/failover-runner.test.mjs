import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FailoverRunner as RawFailoverRunner,
  opaque429Tracker,
  sessionCircuitDedupe,
} from '../../src/lib/pool/failover-runner.mjs'
import { SchedulerApiError } from '../../src/lib/transport/scheduler-client.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { UnitCircuit } from '../../src/lib/pool/unit-circuit.mjs'
import { resolveOutboundSessionId } from '../../src/lib/identity/identity-rewrite.mjs'
import { prepareCragPrintBody } from '../../src/lib/protocol/crag-print-prompt.mjs'

function makeMockFailoverRuntime({ scheduler, config = {} } = {}) {
  let leaseSeq = 0
  const leases = new Map()
  const sessionLocks = new Map()

  const acquireSessionLock = async (sessionKey, timeoutMs, signal) => {
    if (!sessionKey) return () => {}
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    let state = sessionLocks.get(sessionKey)
    if (!state) {
      state = { held: false, waiters: [] }
      sessionLocks.set(sessionKey, state)
    }
    const release = () => {
      const next = state.waiters.shift()
      if (next) {
        next.grant()
      } else {
        state.held = false
        if (sessionLocks.get(sessionKey) === state) sessionLocks.delete(sessionKey)
      }
    }
    if (!state.held) {
      state.held = true
      return release
    }
    await new Promise((resolve, reject) => {
      let settled = false
      const waiter = {
        grant() {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener?.('abort', onAbort)
          resolve()
        },
      }
      const removeWaiter = () => {
        const idx = state.waiters.indexOf(waiter)
        if (idx >= 0) state.waiters.splice(idx, 1)
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        removeWaiter()
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }
      const timer = setTimeout(
        () => {
          if (settled) return
          settled = true
          signal?.removeEventListener?.('abort', onAbort)
          removeWaiter()
          reject(
            new SchedulerApiError({
              status: 529,
              code: 'pool_overloaded',
              message: '号池负载过高，稍后再试',
              retryAfterSec: 1,
              explain: { reason: 'session_queue_timeout' },
            }),
          )
        },
        Math.max(1, Number(timeoutMs) || 900_000),
      )
      signal?.addEventListener?.('abort', onAbort, { once: true })
      state.waiters.push(waiter)
    })
    return release
  }

  const buildExcludedSet = (excludeNodes = []) => {
    const excluded = new Set()
    for (const key of excludeNodes || []) {
      const raw = String(key || '')
      excluded.add(raw)
      const id = raw.includes(':') ? raw.split(':').slice(1).join(':') : raw
      excluded.add(id)
      const match = (scheduler?.candidates || []).find((c) => c.vmId === id || c.accountId === id)
      if (match) {
        if (match.vmId) excluded.add(match.vmId)
        if (match.accountId) excluded.add(match.accountId)
      }
    }
    return excluded
  }

  const selectCandidate = async (params) => {
    if (!scheduler || typeof scheduler.selectAndReserve !== 'function') {
      throw new SchedulerApiError({
        status: 503,
        code: 'account_pool_exhausted',
        message: 'No eligible Claude accounts remain',
      })
    }
    const excluded = buildExcludedSet(params.excludeNodes)
    const pinVmId = params.pinNodeKey ? String(params.pinNodeKey).split(':').slice(1).join(':') : null
    let selected
    try {
      selected = await scheduler.selectAndReserve({
        excluded,
        model: params.model,
        pinVmId,
        skipSessionSlot: params.isEphemeralProbe === true,
        allowWait: params.noQueue !== true,
      })
    } catch (err) {
      if (err?.code === 'pool_wait_queue_full') {
        throw new SchedulerApiError({
          status: 529,
          code: 'pool_overloaded',
          message: '号池负载过高，稍后再试',
          retryAfterSec: 1,
          explain: { reason: 'pool_wait_queue_full' },
        })
      }
      throw err
    }
    if (!selected || !selected.ok) {
      const reason = selected?.reason || 'no_eligible_accounts'
      const retryMs = Number(selected?.retry_after_ms ?? selected?.soonest_available_ms)
      const retryAfterSec = Number.isFinite(retryMs) && retryMs > 0 ? Math.max(1, Math.ceil(retryMs / 1000)) : undefined
      if (reason === 'fable_requires_max') {
        throw new SchedulerApiError({
          status: 429,
          code: 'fable_requires_max',
          message: 'Fable requires a Max account',
          retryAfterSec: retryAfterSec ?? 1,
        })
      }
      if (reason === 'pool_rate_limited') {
        throw new SchedulerApiError({
          status: 429,
          code: 'pool_rate_limited',
          message: 'All accounts are rate limited',
          retryAfterSec: retryAfterSec ?? 1,
        })
      }
      if (reason === 'all_accounts_busy' || reason === 'pool_queue_timeout' || reason === 'pool_overload_cooldown') {
        throw new SchedulerApiError({
          status: 529,
          code: 'pool_overloaded',
          message: '号池负载过高，稍后再试',
          retryAfterSec: retryAfterSec ?? 1,
          explain: { reason, ...selected },
        })
      }
      throw new SchedulerApiError({
        status: 503,
        code: reason === 'pool_resting' ? 'pool_unavailable' : 'account_pool_exhausted',
        message: 'No eligible Claude accounts remain',
        retryAfterSec,
        explain: {
          reason,
          wait_ms: selected?.waitMs ?? 0,
          sticky_cleared: Boolean(selected?.sticky_cleared),
          ...selected,
        },
      })
    }
    return selected
  }

  return {
    candidateForLease(leaseId) {
      return leases.get(leaseId)?.candidate || null
    },
    async acquireNode(params, { signal } = {}) {
      const lockKey = params.isEphemeralProbe ? '' : String(params.sessionId || '')
      const releaseLock = await acquireSessionLock(lockKey, config.session_queue_timeout_ms, signal)
      try {
        const selected = await selectCandidate(params)
        const leaseId = `mock-lease-${++leaseSeq}`
        leases.set(leaseId, { candidate: selected, releaseLock })
        return {
          lease_id: leaseId,
          lease_ttl_ms: 30_000,
          resolved_pool_id: params.originPoolId || '__default_claude__',
          selected_node: {
            node_type: 'claude_vm',
            node_id: selected.vmId,
            node_key: `claude_vm:${selected.vmId}`,
          },
          explain: { affinity: { why: selected.selectionReason || 'balanced' } },
        }
      } catch (err) {
        releaseLock()
        throw err
      }
    },
    async switchNode(body, { signal } = {}) {
      const prev = leases.get(body.release_lease_id)
      leases.delete(body.release_lease_id)
      const releaseLock = prev?.releaseLock || (() => {})
      try {
        prev?.candidate?.release?.()
      } catch {}
      if (signal?.aborted) {
        releaseLock()
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
      try {
        const selected = await selectCandidate(body.next_attempt || {})
        const leaseId = `mock-lease-${++leaseSeq}`
        leases.set(leaseId, { candidate: selected, releaseLock })
        return {
          lease_id: leaseId,
          lease_ttl_ms: 30_000,
          resolved_pool_id: body.next_attempt?.originPoolId || '__default_claude__',
          selected_node: {
            node_type: 'claude_vm',
            node_id: selected.vmId,
            node_key: `claude_vm:${selected.vmId}`,
          },
          explain: { affinity: { why: selected.selectionReason || 'balanced' } },
        }
      } catch (err) {
        releaseLock()
        throw err
      }
    },
    async commitLease() {},
    async releaseLease(leaseId) {
      const rec = leases.get(leaseId)
      if (!rec) return
      leases.delete(leaseId)
      try {
        rec.candidate?.release?.()
      } catch {}
      rec.releaseLock()
    },
  }
}

class FailoverRunner extends RawFailoverRunner {
  constructor(opts = {}) {
    const scheduler = opts.scheduler || null
    const runtime =
      opts.schedulerRuntime ||
      makeMockFailoverRuntime({
        scheduler,
        config: opts.config || {},
      })
    if (scheduler && typeof scheduler.resolveCandidateForNode !== 'function') {
      scheduler.resolveCandidateForNode = (_node, meta) => {
        const cand = runtime.candidateForLease(meta?.leaseId)
        if (!cand) return null
        return {
          ...cand,
          nodeKey: cand.nodeKey || `claude_vm:${cand.vmId}`,
          leaseId: meta?.leaseId || null,
        }
      }
    }
    super({ ...opts, schedulerRuntime: runtime })
  }
}

class Scheduler {
  constructor(candidates) {
    this.candidates = candidates
    this.cooldowns = []
    this.successes = []
    this.releasedAccounts = []
    this.selectCalls = 0
  }

  async selectAndReserve({ excluded, avoid = null, allowWait = true }) {
    this.selectCalls++
    const open = this.candidates.filter((item) => !excluded.has(item.accountId) && !excluded.has(item.vmId))
    const preferred = avoid ? open.filter((item) => !avoid.has(item.accountId) && !avoid.has(item.vmId)) : open
    const candidate = preferred[0] || (allowWait ? open[0] : null)
    if (!candidate) return { ok: false, reason: 'no_eligible_accounts' }
    return { ...candidate, ok: true, release() {} }
  }

  markCooldown(candidate, update) {
    this.cooldowns.push({ candidate, update })
  }

  markSuccess(candidate) {
    this.successes.push(candidate)
  }

  releaseAccountSessions(value) {
    this.releasedAccounts.push(value)
  }
}

class Attempts {
  items = []
  begin(item) {
    this.items.push({ ...item, state: 'started' })
  }
  complete(requestId, attemptNo, result) {
    const item = this.items.find((entry) => entry.requestId === requestId && entry.attemptNo === attemptNo)
    Object.assign(item, result, { state: 'completed' })
  }
}

function candidate(number) {
  return {
    vmId: `vm-0${number}`,
    accountId: `account-${number}`,
    selectionReason: number === 1 ? 'sticky' : 'balanced',
    waitMs: 0,
  }
}

function success(text = 'ok') {
  return {
    ok: true,
    status: 200,
    terminalState: 'verified',
    body: {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}

test('slot OAuth load failure skips the bad VM without retrying or parking its account', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler })
  const visited = []
  const result = await runner.run({
    requestId: 'slot-oauth-unavailable',
    model: 'claude-sonnet-test',
    canonicalBody: { model: 'claude-sonnet-test' },
    callAttempt: ({ candidate: selected }) => {
      visited.push(selected.vmId)
      return selected.vmId === 'vm-01'
        ? {
            ok: false,
            status: 503,
            upstreamExecutions: 0,
            terminalState: 'rejected',
            body: { type: 'error', error: { type: 'worker_error', code: 'slot_oauth_unavailable' } },
          }
        : success()
    },
  })
  assert.deepEqual(visited, ['vm-01', 'vm-02'])
  assert.equal(result.ok, true)
  assert.equal(result.attemptCount, 1)
  assert.deepEqual(scheduler.cooldowns, [])
  assert.deepEqual(scheduler.releasedAccounts, [])
})

test('a CRAG quota change after selection skips that VM without a cooldown or upstream replay', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler })
  const visited = []
  const result = await runner.run({
    requestId: 'crag-seat-downgrade',
    model: 'claude-sonnet-test',
    canonicalBody: { model: 'claude-sonnet-test' },
    callAttempt: ({ candidate: selected }) => {
      visited.push(selected.vmId)
      return selected.vmId === 'vm-01'
        ? {
            ok: false,
            status: 403,
            terminalState: 'rejected',
            upstreamExecutions: 0,
            body: { type: 'error', error: { type: 'permission_error', code: 'license_crag_host_over_quota' } },
          }
        : success()
    },
  })
  assert.deepEqual(visited, ['vm-01', 'vm-02'])
  assert.equal(result.ok, true)
  assert.equal(result.attemptCount, 1)
  assert.deepEqual(scheduler.cooldowns, [])
})

test('failed attempt logging returns the permit without dispatch or failover', async () => {
  let releases = 0
  const scheduler = new Scheduler([])
  scheduler.selectAndReserve = async () => ({ ...candidate(1), ok: true, release: () => releases++ })
  const attemptsRepo = {
    begin: () => {
      throw new Error('attempt log unavailable')
    },
  }
  const runner = new FailoverRunner({ scheduler, attemptsRepo })
  await assert.rejects(
    runner.run({
      requestId: 'logging-failed',
      model: 'claude-sonnet-test',
      canonicalBody: { model: 'claude-sonnet-test' },
      callAttempt: () => assert.fail('must not dispatch'),
    }),
    /attempt log unavailable/,
  )
  assert.equal(releases, 1)
  assert.deepEqual(scheduler.cooldowns, [])
})

test('abort during request preparation never dispatches and returns the permit', async () => {
  let releases = 0
  const controller = new AbortController()
  const scheduler = new Scheduler([])
  scheduler.selectAndReserve = async () => ({ ...candidate(1), ok: true, release: () => releases++ })
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'prepare-aborted',
    model: 'claude-sonnet-test',
    canonicalBody: { model: 'claude-sonnet-test' },
    signal: controller.signal,
    applyAttempt: async (body) => {
      controller.abort()
      return body
    },
    callAttempt: () => assert.fail('must not dispatch'),
  })
  assert.equal(result.status, 499)
  assert.equal(result.attemptCount, 0)
  assert.equal(releases, 1)
})

test('unsupported classifier runtime stops without counting execution or cooling accounts', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler })
  let calls = 0
  const result = await runner.run({
    requestId: 'classifier-runtime',
    model: 'claude-sonnet-4-6',
    canonicalBody: { model: 'claude-sonnet-4-6' },
    callAttempt: async () => {
      calls++
      return {
        ok: false,
        status: 400,
        upstreamExecutions: 0,
        terminalState: 'rejected',
        body: {
          error: {
            type: 'invalid_request_error',
            code: 'classifier_runtime_unsupported',
            message: 'unsupported runtime',
          },
        },
      }
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.attemptCount, 0)
  assert.equal(result.body.error.code, 'classifier_runtime_unsupported')
  assert.deepEqual(scheduler.cooldowns, [])
  assert.equal(scheduler.selectCalls, 1)
})

test('invalid panel cache layout stops before execution without rotating or cooling accounts', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const attempts = new Attempts()
  const runner = new FailoverRunner({ scheduler, attemptsRepo: attempts })
  const result = await runner.run({
    requestId: 'invalid-cache-layout',
    model: 'claude-opus-5-5',
    canonicalBody: { model: 'claude-opus-5-5' },
    applyAttempt: () => {
      const error = new Error('Cache TTL must place 1h before 5m.')
      error.status = 400
      error.body = { error: { type: 'invalid_request_error', code: 'invalid_cache_control', message: error.message } }
      throw error
    },
    callAttempt: () => assert.fail('invalid cache layout must not execute'),
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'invalid_cache_control')
  assert.equal(result.attemptCount, 0)
  assert.equal(scheduler.selectCalls, 1)
  assert.deepEqual(scheduler.cooldowns, [])
  assert.equal(attempts.items[0].errorScope, 'request')
})

test('oversized CRAG zero replace stops before execution without cooling accounts', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const attempts = new Attempts()
  const runner = new FailoverRunner({ scheduler, attemptsRepo: attempts })
  const result = await runner.run({
    requestId: 'crag-replace-too-large',
    model: 'claude-opus-5-5',
    canonicalBody: { model: 'claude-opus-5-5' },
    applyAttempt: () => {
      const error = new Error('prompt too large for original CLI replace mode')
      error.status = 400
      error.body = { error: { type: 'invalid_request_error', code: 'crag_prompt_too_large', message: error.message } }
      throw error
    },
    callAttempt: () => assert.fail('oversized replace must not execute'),
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'crag_prompt_too_large')
  assert.equal(result.attemptCount, 0)
  assert.equal(scheduler.selectCalls, 1)
  assert.deepEqual(scheduler.cooldowns, [])
  assert.equal(attempts.items[0].errorScope, 'request')
})

test('unsupported CRAG provider tool reports its field without execution or account rotation', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const attempts = new Attempts()
  const runner = new FailoverRunner({ scheduler, attemptsRepo: attempts })
  const model = 'claude-sonnet-5-5'
  const result = await runner.run({
    requestId: 'unsupported-provider-tool',
    model,
    canonicalBody: { model, tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
    applyAttempt: (body) => prepareCragPrintBody(body, { capabilities: ['generation_controls_v3'] }),
    callAttempt: () => assert.fail('unsupported provider tool must not execute'),
  })
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'invalid_kernel_request')
  assert.equal(result.body.error.param, 'tools[0].type')
  assert.equal(result.attemptCount, 0)
  assert.equal(scheduler.selectCalls, 1)
  assert.deepEqual(scheduler.cooldowns, [])
  assert.equal(attempts.items[0].errorScope, 'request')
})

test('account1 quota exhausted rotates to account2 and commits final sticky', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const attempts = new Attempts()
  const runner = new FailoverRunner({
    scheduler,
    attemptsRepo: attempts,
  })
  const seen = []
  const result = await runner.run({
    requestId: 'req-1',
    canonicalBody: { model: 'claude-opus-test', metadata: { user_id: 'caller' } },
    model: 'claude-opus-test',
    stickyKey: 'conversation-1',
    applyAttempt: (body, selected) => {
      body.metadata.user_id = selected.accountId
      return body
    },
    callAttempt: ({ candidate: selected, body }) => {
      seen.push({ accountId: selected.accountId, userId: body.metadata.user_id })
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 429,
          terminalState: 'rejected',
          body: { error: { type: 'rate_limit_error', message: '5h exhausted' } },
          headers: { 'anthropic-ratelimit-unified-5h-status': 'rejected' },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.equal(result.attemptCount, 2)
  assert.deepEqual(seen, [
    { accountId: 'account-1', userId: 'account-1' },
    { accountId: 'account-2', userId: 'account-2' },
  ])
  assert.equal(scheduler.cooldowns.length, 1)
  assert.equal(scheduler.cooldowns[0].candidate.accountId, 'account-1')
  assert.deepEqual(scheduler.releasedAccounts, [{ accountId: 'account-1', vmId: 'vm-01' }])
  assert.equal(attempts.items.length, 2)
  assert.equal(attempts.items[1].terminalState, 'verified')
})

test('slot_busy spill serves the turn elsewhere but keeps the session pinned', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-busy-'))
  const sticky = new StickyRouter({ dataDir, config: { sticky: { enabled: true } } })
  t.after(() => {
    sticky.db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const callerSession = 'slot-busy-caller'
  const stickyKey = sticky.canonicalSessionKey(callerSession)
  sticky.bind(stickyKey, { accountId: 'account-1', vmId: 'vm-01', sessionId: 'stored-home' }, { countHit: false })
  const selections = [1, 2].map((n) => ({
    ok: true,
    accountId: `account-${n}`,
    vmId: `vm-0${n}`,
    seatKey: `seat:sess:${callerSession}`,
    release() {},
  }))
  let index = 0
  const scheduler = {
    async selectAndReserve() {
      return selections[Math.min(index++, selections.length - 1)]
    },
    markSuccess() {},
    markCooldown() {},
    releaseAccountSessions() {
      assert.fail('capacity spill must not unbind')
    },
  }
  const runner = new FailoverRunner({ scheduler, stickyRouter: sticky, config: { same_account_retry_delay_ms: 0 } })
  let clock = 1_000
  const result = await runner.run({
    requestId: 'req-spill',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey,
    seatKey: `seat:sess:${callerSession}`,
    applyAttempt: (body, selected, extra) => ({
      body,
      meta: {
        sessionId: resolveOutboundSessionId(callerSession, {
          boundSessionId: extra.stickyBound?.sessionId,
          boundVmId: extra.stickyBound?.vmId,
          vmId: selected.vmId,
          epoch: `${clock++}:${selected.vmId}`,
        }),
      },
    }),
    callAttempt: ({ candidate: selected }) =>
      selected.accountId === 'account-1'
        ? {
            ok: false,
            status: 503,
            terminalState: 'rejected',
            body: { error: { type: 'api_error', code: 'slot_busy', message: 'no free slot' } },
          }
        : success(),
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual((({ accountId, vmId, sessionId }) => ({ accountId, vmId, sessionId }))(sticky.resolve(stickyKey)), {
    accountId: 'account-1',
    vmId: 'vm-01',
    sessionId: 'stored-home',
  })
})

test('a late device-affinity hop does not overwrite a newer cross-account session pin', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-device-move-race-'))
  const sticky = new StickyRouter({ dataDir, config: { sticky: { enabled: true } } })
  t.after(() => {
    sticky.db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const callerSession = 'device-move-race'
  const stickyKey = sticky.canonicalSessionKey(callerSession)
  sticky.bind(stickyKey, { accountId: 'account-1', vmId: 'vm-01', sessionId: 'old-outbound' }, { countHit: false })
  const scheduler = new Scheduler([
    { ...candidate(2), selectionReason: 'device-affinity', seatKey: `seat:sess:${callerSession}` },
  ])
  const runner = new FailoverRunner({ scheduler, stickyRouter: sticky })
  const result = await runner.run({
    requestId: 'req-device-move-race',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey,
    seatKey: `seat:sess:${callerSession}`,
    applyAttempt: (body) => ({ body, meta: { sessionId: 'moved-outbound' } }),
    callAttempt: () => {
      sticky.bind(
        stickyKey,
        { accountId: 'account-3', vmId: 'vm-03', sessionId: 'newer-outbound' },
        { allowMove: true, replaceSession: true },
      )
      return success()
    },
  })
  assert.equal(result.ok, true)
  const bound = sticky.resolve(stickyKey)
  assert.equal(bound.accountId, 'account-3')
  assert.equal(bound.vmId, 'vm-03')
  assert.equal(bound.sessionId, 'newer-outbound')
})

test('#A20: a late completion never writes back a pin another request released', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const pins = new Map([['conversation-1', { accountId: 'account-1', vmId: 'vm-01', generation: 3 }]])
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: {
      resolve: (key) => pins.get(key) || null,
      bind: (key, value) => pins.set(key, { ...value, generation: (pins.get(key)?.generation || 0) + 1 }),
    },
  })
  const result = await runner.run({
    requestId: 'req-late',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'conversation-1',
    callAttempt: () => {
      // While this hop streams, a quota exclusion elsewhere releases the pin.
      pins.delete('conversation-1')
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-1')
  assert.equal(pins.has('conversation-1'), false)
})

test('verified hop forwards session and parent identity to Rust scheduler runtime', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const acquireCalls = []
  const baseRt = makeMockFailoverRuntime({ scheduler })
  const schedulerRuntime = {
    ...baseRt,
    async acquireNode(params, opts) {
      acquireCalls.push(params)
      return baseRt.acquireNode(params, opts)
    },
  }
  const runner = new FailoverRunner({ scheduler, schedulerRuntime })
  const result = await runner.run({
    requestId: 'req-family',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'child-sess',
    rootSessionId: 'root-sess',
    deviceKey: 'dev:aabbcc',
    callAttempt: () => success(),
  })
  assert.equal(result.ok, true)
  assert.equal(acquireCalls.length, 1)
  assert.equal(acquireCalls[0].sessionId, 'child-sess')
  assert.equal(acquireCalls[0].parentSessionId, 'root-sess')
  assert.equal(acquireCalls[0].machineId, 'dev:aabbcc')
})

test('probe hop passes isEphemeralProbe and machineId without writing legacy Node session pins', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const acquireCalls = []
  const baseRt = makeMockFailoverRuntime({ scheduler })
  const schedulerRuntime = {
    ...baseRt,
    async acquireNode(params, opts) {
      acquireCalls.push(params)
      return baseRt.acquireNode(params, opts)
    },
  }
  const sessionBindings = []
  const runner = new FailoverRunner({
    scheduler,
    schedulerRuntime,
    stickyRouter: {
      bind: (key, value, opts) => sessionBindings.push({ key, value, opts }),
    },
  })
  const result = await runner.run({
    requestId: 'req-probe-seatless',
    canonicalBody: { model: 'claude-haiku-test' },
    model: 'claude-haiku-test',
    stickyKey: null,
    stickyKeys: [],
    stickyDeviceId: 'device-1',
    deviceKey: 'dev2:device-1',
    skipSessionSeat: true,
    callAttempt: () => success(),
  })
  assert.equal(result.ok, true)
  assert.equal(acquireCalls.length, 1)
  assert.equal(acquireCalls[0].isEphemeralProbe, true)
  assert.equal(acquireCalls[0].machineId, 'device-1')
  assert.deepEqual(sessionBindings, [])
})

test('request-scoped entitlement error does not walk the pool', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-2',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: () => ({
      ok: false,
      status: 429,
      terminalState: 'rejected',
      body: { error: { message: 'Usage credits are required for fast mode' } },
    }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.attemptCount, 1)
  assert.equal(scheduler.selectCalls, 1)
  assert.equal(scheduler.cooldowns.length, 0)
})

test('bare 429s on two accounts stop without cooling accounts or Fable', async () => {
  for (const model of ['claude-sonnet-test', 'claude-fable-test']) {
    const scheduler = new Scheduler([candidate(1), candidate(2), candidate(3)])
    const runner = new FailoverRunner({ scheduler })
    const result = await runner.run({
      requestId: `req-bare-${model}`,
      model,
      callAttempt: () => ({
        ok: false,
        status: 429,
        terminalState: 'rejected',
        body: { error: { type: 'rate_limit_error', message: 'Error' } },
      }),
    })
    assert.equal(result.status, 429)
    assert.equal(result.policy.reason, 'rate_limited_request')
    assert.equal(result.attemptCount, 2)
    assert.equal(scheduler.selectCalls, 2)
    assert.deepEqual(scheduler.cooldowns, [])
    assert.deepEqual(scheduler.releasedAccounts, [])
  }
})

/**
 * An opaque CRAG 429 is a bare 429 whose provider-side observation carries no
 * rate-limit headers at all. #1139 made a single one stop the request without
 * cooling anything down, because one such response proves nothing. These cases
 * pin that first-hit behaviour and the escalation that follows repetition.
 */
function opaque429() {
  return {
    ok: false,
    status: 429,
    terminalState: 'rejected',
    headers: {},
    body: { error: { type: 'rate_limit_error', message: 'Error' } },
    providerResult: {
      schema_version: 2,
      source: 'provider_http',
      http_status: 429,
      error: { type: 'rate_limit_error', message: 'Error' },
      response_headers: {},
    },
  }
}

test('#4 a single opaque CRAG 429 still stops without cooling anything down', async () => {
  opaque429Tracker.reset()
  const scheduler = new Scheduler([candidate(1), candidate(2), candidate(3)])
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-opaque-single',
    model: 'claude-sonnet-test',
    callAttempt: opaque429,
  })
  assert.equal(result.status, 429)
  assert.equal(result.policy.reason, 'crag_opaque_429')
  assert.equal(result.attemptCount, 1, 'must not walk the pool on the first hit')
  assert.deepEqual(scheduler.cooldowns, [])
  assert.deepEqual(scheduler.releasedAccounts, [])
})

test('#4 repeated opaque CRAG 429s cool the model down and move to another slot', async () => {
  opaque429Tracker.reset()
  const model = 'claude-sonnet-test'

  // Hits below the threshold keep the #1139 behaviour verbatim.
  for (const hit of [1, 2]) {
    const scheduler = new Scheduler([candidate(1), candidate(2), candidate(3)])
    const runner = new FailoverRunner({ scheduler })
    const hitResult = await runner.run({ requestId: `req-opaque-${hit}`, model, callAttempt: opaque429 })
    assert.equal(hitResult.policy.reason, 'crag_opaque_429', `hit ${hit}`)
    assert.deepEqual(scheduler.cooldowns, [], `hit ${hit} must not cool anything`)
    assert.equal(opaque429Tracker.streak('account-1', model), hit)
  }

  // The third one escalates to a model-level cooldown and hops off the slot.
  const scheduler = new Scheduler([candidate(1), candidate(2), candidate(3)])
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({ requestId: 'req-opaque-3', model, callAttempt: opaque429 })
  const cooled = scheduler.cooldowns.find((entry) => entry.update.reason === 'crag_opaque_429_model_cooldown')
  assert.ok(cooled, 'the streak must produce a model cooldown')
  assert.equal(cooled.candidate.accountId, 'account-1')
  assert.equal(cooled.update.model, model, 'cooldown must be scoped to the model, not the whole account')
  assert.ok(cooled.update.until > Date.now(), 'cooldown must be in the future')
  assert.ok(result.attemptCount >= 2, 'escalation must try another slot')
  // Model scope must not drag the account's other conversations off the slot.
  assert.deepEqual(scheduler.releasedAccounts, [])
})

test('#4 the opaque 429 streak is per (account, model) and clears on success', async () => {
  opaque429Tracker.reset()
  const runner = (scheduler) => new FailoverRunner({ scheduler })

  // Two hits on one model leave a sibling model untouched.
  for (const hit of [1, 2]) {
    const scheduler = new Scheduler([candidate(1), candidate(2)])
    await runner(scheduler).run({
      requestId: `req-opaque-sonnet-${hit}`,
      model: 'claude-sonnet-test',
      callAttempt: opaque429,
    })
  }
  assert.equal(opaque429Tracker.streak('account-1', 'claude-sonnet-test'), 2)
  assert.equal(opaque429Tracker.streak('account-1', 'claude-opus-test'), 0, 'must not bleed across models')
  assert.equal(opaque429Tracker.streak('account-2', 'claude-sonnet-test'), 0, 'must not bleed across accounts')

  // A verified success resets the streak, so the next hit starts from one.
  const okScheduler = new Scheduler([candidate(1), candidate(2)])
  await runner(okScheduler).run({
    requestId: 'req-opaque-recover',
    model: 'claude-sonnet-test',
    callAttempt: () => success(),
  })
  assert.equal(opaque429Tracker.streak('account-1', 'claude-sonnet-test'), 0)

  const afterScheduler = new Scheduler([candidate(1), candidate(2)])
  const after = await runner(afterScheduler).run({
    requestId: 'req-opaque-after',
    model: 'claude-sonnet-test',
    callAttempt: opaque429,
  })
  assert.equal(after.policy.reason, 'crag_opaque_429', 'a cleared streak must not escalate on the next hit')
  assert.deepEqual(afterScheduler.cooldowns, [])
})

test('the optional account cap counts executions, not admission misses', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2), candidate(3), candidate(4)])
  const runner = new FailoverRunner({ scheduler, config: { max_accounts_per_request: 1 } })
  const seen = []
  const result = await runner.run({
    requestId: 'req-account-cap',
    model: 'claude-sonnet-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.accountId)
      if (selected.accountId === 'account-1') {
        return { ok: false, status: 503, upstreamExecutions: 0, body: { error: { code: 'slot_busy' } } }
      }
      return { ok: false, status: 529, terminalState: 'rejected', body: { error: { message: 'Overloaded' } } }
    },
  })
  assert.deepEqual(seen, ['account-1', 'account-2'])
  assert.equal(result.account_cap, 1)
  assert.equal(result.attemptCount, 1)
  assert.equal(result.status, 529)
})

test('committed realtime stream failure never switches accounts', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-3',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stream: true,
    callAttempt: ({ onCommit }) => {
      onCommit()
      return {
        ok: false,
        status: 200,
        committed: true,
        terminalState: 'incomplete',
        body: { error: { message: 'stream closed' } },
      }
    },
  })
  assert.equal(result.finalState, 'incomplete')
  assert.equal(result.attemptCount, 1)
  assert.equal(scheduler.selectCalls, 1)
})

test('unconfirmed cluster delivery stops account failover even before any client output', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'cluster-unconfirmed',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stream: true,
    callAttempt: () => ({
      ok: false,
      status: 0,
      transportError: true,
      committed: false,
      clusterDeliveryUnconfirmed: true,
      terminalState: 'transport_error',
      body: { error: { code: 'worker_timeout', message: 'slot worker timeout' } },
    }),
  })
  assert.equal(result.policy.reason, 'cluster_delivery_unconfirmed')
  assert.equal(result.attemptCount, 1)
  assert.equal(scheduler.selectCalls, 1)
  assert.equal(scheduler.cooldowns.length, 0)
})

test('cloudflare 403 does not trigger SOCKS disconnect', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const failures = []
  const runner = new FailoverRunner({
    scheduler,
    onProxyFailure: (vmId, reason) => failures.push({ vmId, reason }),
  })
  const result = await runner.run({
    requestId: 'req-cf',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 403,
          terminalState: 'rejected',
          body: { error: { message: '<html>cloudflare</html>' } },
        }
      }
      return success()
    },
  })
  assert.equal(failures.length, 0)
})

test('proxy transport error notifies onProxyFailure then rotates', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const failures = []
  const runner = new FailoverRunner({
    scheduler,
    onProxyFailure: (vmId, reason) => failures.push({ vmId, reason }),
  })
  const result = await runner.run({
    requestId: 'req-proxy',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 0,
          transportError: true,
          terminalState: 'transport_error',
          body: { error: { code: 'worker_transport_error', message: 'SOCKS proxy dial failed' } },
        }
      }
      return success()
    },
  })
  assert.ok(failures.length >= 1)
  assert.equal(failures[0].vmId, 'vm-01')
  assert.equal(failures[0].reason, 'proxy_transport_failure')
})

function badGateway(message = 'net/http: timeout awaiting response headers') {
  return {
    ok: false,
    status: 502,
    terminalState: 'error',
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        code: 'upstream_transport_error',
        message,
      },
    },
  }
}

test('signature error is repaired once on the same account when enabled', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler, config: { signature_repair: true } })
  let calls = 0
  const result = await runner.run({
    requestId: 'req-4',
    canonicalBody: {
      model: 'claude-opus-test',
      thinking: { type: 'enabled' },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'x' },
            { type: 'text', text: 'keep' },
          ],
        },
      ],
    },
    model: 'claude-opus-test',
    callAttempt: ({ body }) => {
      calls++
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          terminalState: 'rejected',
          body: { error: { message: 'thinking.signature: Field required' } },
        }
      }
      assert.equal(body.thinking, undefined)
      assert.deepEqual(body.messages[0].content, [
        { type: 'text', text: 'x' },
        { type: 'text', text: 'keep' },
      ])
      return success('repaired')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.attemptCount, 2)
  assert.equal(calls, 2)
})

test('search history repair still runs when the rejected hop outlived the deadline', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler, config: { total_retry_deadline_ms: 20 } })
  const bodies = []
  const result = await runner.run({
    requestId: 'req-search-slow-400',
    canonicalBody: {
      model: 'claude-opus-test',
      messages: [
        { role: 'user', content: 'find it' },
        {
          role: 'assistant',
          content: [
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'mac mini' } },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_1',
              content: [{ type: 'web_search_result', title: 'T', url: 'https://a.example', encrypted_content: 'AAAA' }],
            },
            { type: 'text', text: 'found' },
          ],
        },
        { role: 'user', content: 'go on' },
      ],
    },
    model: 'claude-opus-test',
    callAttempt: async ({ body }) => {
      bodies.push(body)
      if (bodies.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return {
          ok: false,
          status: 400,
          terminalState: 'rejected',
          body: {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'messages.1.content.0: Invalid `encrypted_content` in `search_result` block',
            },
          },
        }
      }
      return success('repaired')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(bodies.length, 2)
  assert.equal(JSON.stringify(bodies[1]).includes('encrypted_content'), false)
})

function searchHistoryBody() {
  return {
    model: 'claude-opus-test',
    messages: [
      { role: 'user', content: 'find it' },
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'release notes' } },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [
              { type: 'web_search_result', title: 'Release', url: 'https://a.example', encrypted_content: 'old' },
            ],
          },
        ],
      },
      { role: 'user', content: 'summarize' },
    ],
  }
}

function rejectedSearch() {
  return {
    ok: false,
    status: 400,
    terminalState: 'rejected',
    body: { error: { message: 'Invalid `encrypted_content` in `search_result` block' } },
  }
}

test('confirmed search repair is reused for unchanged history on the next turn', async () => {
  const runner = new FailoverRunner({ scheduler: new Scheduler([candidate(1)]) })
  const history = searchHistoryBody()
  let executions = 0
  const execute = ({ body }) => {
    executions++
    if (JSON.stringify(body).includes('encrypted_content')) {
      return rejectedSearch()
    }
    return success('release summary')
  }
  const args = { model: history.model, stickyKey: 'search-conversation', callAttempt: execute }
  const first = await runner.run({ ...args, requestId: 'search-first', canonicalBody: history })
  assert.equal(first.status, 200)
  assert.equal(first.attemptCount, 2)
  const beforeSecond = executions
  const second = await runner.run({
    ...args,
    requestId: 'search-next',
    canonicalBody: {
      ...history,
      messages: [
        ...history.messages,
        { role: 'assistant', content: 'release summary' },
        { role: 'user', content: 'explain the changes' },
      ],
    },
  })
  assert.equal(second.status, 200)
  assert.equal(executions - beforeSecond, 1, 'known rejected history must not make another failing upstream call')
  assert.equal(second.attemptCount, 1)
  assert.equal(history.messages[1].content[1].content[0].encrypted_content, 'old')
})

for (const changed of ['session', 'account', 'vm', 'model', 'credential', 'history', 'tools', 'new search']) {
  test(`confirmed search repair does not rewrite a different ${changed}`, async () => {
    const scheduler = new Scheduler([{ ...candidate(1), vm: { claude: { _token_version: 1 } } }])
    const runner = new FailoverRunner({ scheduler })
    const history = searchHistoryBody()
    const args = { model: history.model, stickyKey: 'search-conversation', canonicalBody: history }
    const first = await runner.run({
      ...args,
      requestId: 'learn-search',
      callAttempt: ({ body }) => (JSON.stringify(body).includes('encrypted_content') ? rejectedSearch() : success()),
    })
    assert.equal(first.status, 200)
    assert.equal(first.attemptCount, 2)
    switch (changed) {
      case 'session':
        args.stickyKey = 'other-conversation'
        break
      case 'account':
        scheduler.candidates[0].accountId = 'other-account'
        break
      case 'vm':
        scheduler.candidates[0].vmId = 'other-vm'
        break
      case 'model':
        args.model = history.model = 'claude-sonnet-test'
        break
      case 'credential':
        scheduler.candidates[0].vm.claude._token_version = 2
        break
      case 'history':
        history.messages[1].content[1].content[0].encrypted_content = 'new-ciphertext'
        break
      case 'tools':
        history.tools = [{ name: 'extra', input_schema: { type: 'object' } }]
        break
      case 'new search':
        history.messages.push(
          { ...structuredClone(history.messages[1]), content: [{ type: 'search_result', encrypted_content: 'new' }] },
          { role: 'user', content: 'continue' },
        )
        break
    }
    const result = await runner.run({
      ...args,
      requestId: 'fresh-search-contract',
      callAttempt: ({ body }) => {
        assert.deepEqual(body, history, 'a new execution context or search history must get its original opaque data')
        return success('original history accepted')
      },
    })
    assert.equal(result.status, 200)
    assert.equal(result.attemptCount, 1)
  })
}

test('failed search repair is not learned for the next turn', async () => {
  const runner = new FailoverRunner({ scheduler: new Scheduler([candidate(1)]) })
  const history = searchHistoryBody()
  const args = { model: history.model, stickyKey: 'failed-search', canonicalBody: history }
  const rejected = await runner.run({ ...args, requestId: 'failed-repair', callAttempt: rejectedSearch })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.attemptCount, 2)
  const accepted = await runner.run({
    ...args,
    requestId: 'next-after-failed-repair',
    callAttempt: ({ body }) => {
      assert.deepEqual(body, history)
      return success('original accepted')
    },
  })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.attemptCount, 1)
})

test('a confirmed search repair does not hide a later rejection or retry the same transformed body', async () => {
  const runner = new FailoverRunner({ scheduler: new Scheduler([candidate(1)]) })
  const history = searchHistoryBody()
  const args = { model: history.model, stickyKey: 'changed-upstream', canonicalBody: history }
  const learned = await runner.run({
    ...args,
    requestId: 'learned-search',
    callAttempt: ({ body }) => (JSON.stringify(body).includes('encrypted_content') ? rejectedSearch() : success()),
  })
  assert.equal(learned.attemptCount, 2)
  const rejected = await runner.run({ ...args, requestId: 'search-rejected-again', callAttempt: rejectedSearch })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.attemptCount, 1)
  const next = await runner.run({
    ...args,
    requestId: 'after-stale-search-repair',
    callAttempt: ({ body }) => {
      assert.deepEqual(body, history, 'a failed learned repair must be discarded')
      return success('original accepted')
    },
  })
  assert.equal(next.status, 200)
})

test('signature 400 is not repaired when signature_repair is off', async () => {
  const scheduler = new Scheduler([{ ...candidate(1), vm: { family: 'codex', platform: 'openai' } }])
  const runner = new FailoverRunner({ scheduler })
  let calls = 0
  const result = await runner.run({
    requestId: 'req-sig-off',
    canonicalBody: {
      model: 'claude-opus-test',
      thinking: { type: 'enabled' },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'x' },
            { type: 'text', text: 'keep' },
          ],
        },
      ],
    },
    model: 'claude-opus-test',
    callAttempt: () => {
      calls++
      return {
        ok: false,
        status: 400,
        terminalState: 'rejected',
        body: { error: { message: 'thinking.signature: Field required' } },
      }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 400)
  assert.equal(calls, 1)
})

test('cli-hop signature 400 is not repaired when signature_repair is off', async () => {
  const scheduler = new Scheduler([
    {
      ...candidate(1),
      vm: { inference_engine: 'rust' },
    },
  ])
  const runner = new FailoverRunner({ scheduler })
  let calls = 0
  const result = await runner.run({
    requestId: 'req-cli-hop-sig',
    canonicalBody: {
      model: 'claude-opus-test',
      thinking: { type: 'enabled' },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'x' },
            { type: 'text', text: 'keep' },
          ],
        },
      ],
    },
    model: 'claude-opus-test',
    callAttempt: () => {
      calls++
      return {
        ok: false,
        status: 400,
        terminalState: 'rejected',
        body: { error: { message: 'Invalid `signature` in `thinking` block' } },
      }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 400)
  assert.equal(calls, 1)
})

test('thinking-only hop moves to the next slot and returns the later text', async () => {
  const scheduler = new Scheduler([candidate(1)])
  let n = 0
  const select = scheduler.selectAndReserve.bind(scheduler)
  scheduler.selectAndReserve = async (args) => {
    const selected = await select(args)
    if (selected?.ok) selected.slotIndex = n++
    return selected
  }
  const runner = new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0 },
  })
  let calls = 0
  const result = await runner.run({
    requestId: 'req-thinking-only',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          committed: false,
          terminalState: 'verified',
          body: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'draft', signature: 'sig' }],
            stop_reason: null,
          },
        }
      }
      return success('full answer')
    },
  })
  assert.equal(calls, 2)
  assert.equal(result.ok, true)
  assert.equal(result.finalState, 'verified')
  assert.equal(result.body.content[0].text, 'full answer')
  assert.equal(result.body.stop_reason, 'end_turn')
})

test('a replayable incomplete hop tries a free VM before repeating the same one', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const parked = []
  const runner = new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0 },
    rateLimitService: {
      handleUpstreamError: () => null,
      tempUnschedule: (item) => parked.push(item),
    },
  })
  const seen = []
  const result = await runner.run({
    requestId: 'req-incomplete-affinity',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'session-affinity',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.vmId)
      if (selected.vmId === 'vm-02') return success('recovered')
      return {
        ok: false,
        status: 200,
        committed: false,
        terminalState: 'incomplete',
        body: { type: 'message', role: 'assistant', content: [], stop_reason: null },
      }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.vmId, 'vm-02')
  assert.equal(result.attemptCount, 2)
  assert.deepEqual(seen, ['vm-01', 'vm-02'])
  assert.deepEqual(parked, [])
})

test('pinned incomplete hop still stops on the pinned VM', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler, config: { same_account_retry_delay_ms: 0 } })
  const result = await runner.run({
    requestId: 'req-incomplete-pin',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    pinVmId: 'vm-01',
    callAttempt: () => ({
      ok: false,
      status: 200,
      committed: false,
      terminalState: 'incomplete',
      body: { type: 'message', role: 'assistant', content: [], stop_reason: null },
    }),
  })
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'incomplete_response')
  assert.equal(result.vmId, 'vm-01')
})

test('aborted signal stops before another account is tried', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler, config: { same_account_retry_delay_ms: 0 } })
  const seen = []
  const signal = AbortSignal.abort()
  const result = await runner.run({
    requestId: 'req-cancel',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    signal,
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.vmId)
      return success('should not run')
    },
  })
  assert.equal(result.body.error.code, 'client_cancelled')
  assert.equal(result.status, 499)
  assert.deepEqual(seen, [])
  assert.equal(scheduler.cooldowns.length, 0)
})

test('streamed plan limit writes the hard block and rotates to another account', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const blocks = []
  const runner = new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0 },
    rateLimitService: {
      handleUpstreamError: ({ accountId, policy }) => {
        if (policy.reason !== 'account_quota_exhausted') return null
        blocks.push({ accountId, reason: policy.reason })
        return { kind: 'rate_limited', until: 9_999_999_999_999 }
      },
      tempUnschedule: () => {},
    },
  })
  const seen = []
  const result = await runner.run({
    requestId: 'req-plan-limit',
    canonicalBody: { model: 'claude-haiku-test' },
    model: 'claude-haiku-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.accountId)
      if (selected.accountId === 'account-2') return success('other account')
      return {
        ok: false,
        status: 429,
        committed: false,
        terminalState: 'rejected',
        body: { type: 'error', error: { type: 'api_error', message: "You've hit your limit · resets 11am (UTC)" } },
      }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual(seen, ['account-1', 'account-2'])
  assert.deepEqual(blocks, [{ accountId: 'account-1', reason: 'account_quota_exhausted' }])
  const cooled = scheduler.cooldowns.find((item) => item.candidate.accountId === 'account-1')
  assert.equal(cooled.update.until, 9_999_999_999_999)
})

test('fast 502 retries the same account once without cooldown', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0 },
  })
  const seen = []
  const result = await runner.run({
    requestId: 'req-502-same',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.accountId)
      return badGateway()
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'upstream_transport_error')
  assert.equal(result.via, 'rust-scheduler')
  assert.notEqual(result.body.error.code, 'server_overloaded')
  assert.deepEqual(seen, ['account-1', 'account-1'])
  assert.equal(scheduler.cooldowns.length, 0)
})

test('a retryable 502 moves to a free account before retrying the same one', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0 },
  })
  const seen = []
  const result = await runner.run({
    requestId: 'req-502-rotate',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.accountId)
      if (selected.accountId === 'account-1') return badGateway()
      return success('recovered')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual(seen, ['account-1', 'account-2'])
  assert.equal(scheduler.cooldowns.length, 0)
})

test('slow 502 does not stack another same-account hop', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({
    scheduler,
    config: {
      same_account_retry_delay_ms: 0,
      same_account_retry_max_hop_ms: 0,
    },
  })
  let calls = 0
  const result = await runner.run({
    requestId: 'req-502-slow',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: () => {
      calls++
      return badGateway()
    },
  })
  assert.equal(result.status, 502)
  assert.equal(calls, 1)
  assert.equal(scheduler.cooldowns.length, 0)
  assert.equal(result.body.error.code, 'upstream_transport_error')
})

test('pin 401 without refresh does not forever-park the slot', async () => {
  const scheduler = new Scheduler([{ ...candidate(1), hasRefresh: false }])
  const failures = []
  const runner = new FailoverRunner({
    scheduler,
    onCredentialFailure: (payload) => failures.push(payload),
  })
  const result = await runner.run({
    requestId: 'req-pin-401',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    pinVmId: 'vm-01',
    callAttempt: () => ({
      ok: false,
      status: 401,
      terminalState: 'rejected',
      body: { error: { message: 'invalid or expired credentials' } },
    }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.equal(scheduler.cooldowns.length, 0)
  assert.equal(failures.length, 0)
})

test('401 without refresh disables that slot then hops', async () => {
  const scheduler = new Scheduler([{ ...candidate(1), hasRefresh: false }, candidate(2)])
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: {},
  })
  const result = await runner.run({
    requestId: 'req-401-no-rt',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 401,
          terminalState: 'rejected',
          body: { error: { message: 'invalid or expired credentials' } },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.equal(scheduler.cooldowns[0].update.reason, 'oauth_no_refresh')
  assert.equal(scheduler.cooldowns[0].update.status, 'disabled')
  assert.ok(scheduler.releasedAccounts.length >= 1)
  assert.equal(scheduler.releasedAccounts[0].accountId, 'account-1')
})

test('second 401 on the same generation disables the slot then hops', async () => {
  const first = {
    ...candidate(1),
    vm: { claude: { has_refresh: true, oauth_401_generation: 4, expires_at: 99 } },
    workerStatus: { credential: { has_refresh: true, generation: 4 } },
  }
  const scheduler = new Scheduler([first, candidate(2)])
  const failures = []
  const runner = new FailoverRunner({
    scheduler,
    onCredentialFailure: (payload) => failures.push(payload),
  })
  const result = await runner.run({
    requestId: 'req-401-escalate',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 401,
          terminalState: 'rejected',
          body: { error: { message: 'OAuth access token has been revoked' } },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.equal(scheduler.cooldowns[0].update.reason, 'oauth_revoked')
  assert.equal(scheduler.cooldowns[0].update.status, 'disabled')
  assert.equal(failures[0].policy.reason, 'oauth_revoked')
})

test('401 unbinds the dead account then continues on the next slot', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: {},
  })
  const result = await runner.run({
    requestId: 'req-401',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'conversation-dead',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 401,
          terminalState: 'rejected',
          body: { error: { message: 'invalid or expired credentials' } },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.ok(scheduler.releasedAccounts.length >= 1)
  assert.equal(scheduler.releasedAccounts[0].accountId, 'account-1')
})

test('first 401 with refresh revokes the slot once then hops', async () => {
  const scheduler = new Scheduler([
    { ...candidate(1), vm: { claude: { has_refresh: true } }, workerStatus: { credential: { has_refresh: true } } },
    candidate(2),
  ])
  const failures = []
  const runner = new FailoverRunner({
    scheduler,
    onCredentialFailure: (payload) => failures.push(payload),
  })
  const seen = []
  const result = await runner.run({
    requestId: 'req-401-once',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.accountId)
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 401,
          terminalState: 'rejected',
          body: { error: { message: 'OAuth access token has been revoked.' } },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual(seen, ['account-1', 'account-2'])
  assert.equal(scheduler.cooldowns[0].update.reason, 'oauth_revoked')
  assert.equal(scheduler.cooldowns[0].update.status, 'disabled')
  assert.equal(failures[0].policy.reason, 'oauth_revoked')
})

test('applyAttempt failure releases its reservation and fails over', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const select = scheduler.selectAndReserve.bind(scheduler)
  let releases = 0
  scheduler.selectAndReserve = async (opts) => {
    const selected = await select(opts)
    if (!selected.ok) return selected
    return { ...selected, release: () => releases++ }
  }
  const attempts = new Attempts()
  const runner = new FailoverRunner({ scheduler, attemptsRepo: attempts, config: { same_account_retry_delay_ms: 0 } })
  const prepared = []
  const result = await runner.run({
    requestId: 'req-prepare-failure',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    applyAttempt: (body, selected) => {
      prepared.push(selected.accountId)
      if (selected.accountId === 'account-1') throw new Error('persona preparation failed')
      return body
    },
    callAttempt: () => success(),
  })

  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual(prepared, ['account-1', 'account-2'])
  assert.equal(releases, 2)
  assert.equal(attempts.items.length, 2)
  assert.ok(attempts.items.every((item) => item.state === 'completed'))
})

test('empty pool without a prior hop stays account_pool_exhausted', async () => {
  const scheduler = new Scheduler([])
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-empty',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: () => success(),
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'account_pool_exhausted')
  assert.equal(result.body.error.message, 'No eligible Claude accounts remain')
  assert.equal(result.body.error.explain, undefined)
  assert.equal(result.body.error.details, undefined)
  assert.equal(result.explain.reason, 'no_eligible_accounts')
  assert.equal(result.explain.wait_ms, 0)
  assert.equal(result.explain.sticky_cleared, false)
})

test('fable without an eligible Max account returns a dedicated HTTP 429', async () => {
  const scheduler = {
    async selectAndReserve() {
      return { ok: false, reason: 'fable_requires_max', waitMs: 0, eligible: 0, available: 0 }
    },
    markCooldown() {},
    markSuccess() {},
  }
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-fable-no-max',
    canonicalBody: { model: 'claude-fable-5' },
    model: 'claude-fable-5',
    callAttempt: () => success(),
  })
  assert.equal(result.status, 429)
  assert.equal(result.body.error.type, 'rate_limit_error')
  assert.equal(result.body.error.code, 'fable_requires_max')
  assert.match(result.body.error.message, /Max account/i)
})

test('pool exhaustion details include the scheduler snapshot', async () => {
  const scheduler = {
    async selectAndReserve() {
      return {
        ok: false,
        reason: 'all_accounts_busy',
        waitMs: 12,
        soonest_available_ms: 10_064_000,
        wait_reasons: ['account_cooldown'],
        eligible: 2,
        available: 0,
        sticky_cleared: true,
      }
    },
    markCooldown() {},
    markSuccess() {},
  }
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-busy-snap',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: () => success(),
  })
  assert.equal(result.status, 529)
  assert.equal(result.body.error.type, 'overloaded_error')
  assert.equal(result.body.error.code, 'pool_overloaded')
  assert.equal(result.body.error.message, '号池负载过高，稍后再试')
  assert.equal(result.retryAfterSec, 10_064)
  assert.equal(result.attemptCount, 0)
  assert.equal(result.body.error.explain, undefined)
  assert.equal(result.body.error.details, undefined)
  assert.equal(result.explain.reason, 'all_accounts_busy')
  assert.equal(result.explain.soonest_available_ms, 10_064_000)
  assert.equal(result.explain.sticky_cleared, true)
  assert.equal(result.explain.eligible, 2)
  assert.deepEqual(result.explain.wait_reasons, ['account_cooldown'])
})

test('a seat queue timeout is a 529 overloaded_error with the planner retry-after', async () => {
  const scheduler = {
    async selectAndReserve() {
      return { ok: false, reason: 'pool_queue_timeout', waitMs: 3000, retry_after_ms: 2_500, eligible: 2 }
    },
    markCooldown() {},
    markSuccess() {},
  }
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-queue-timeout',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: () => success(),
  })
  assert.equal(result.status, 529)
  assert.equal(result.body.error.type, 'overloaded_error')
  assert.equal(result.body.error.code, 'pool_overloaded')
  assert.equal(result.body.error.explain, undefined)
  assert.equal(result.body.error.details, undefined)
  assert.equal(result.explain.reason, 'pool_queue_timeout')
  assert.equal(result.retryAfterSec, 3)
})

test('every account in an upstream cooldown: 529 cooldown is capacity, 429 cooldown is a 429', async () => {
  const cases = [
    ['pool_overload_cooldown', 529, 'overloaded_error', 'pool_overloaded'],
    ['pool_rate_limited', 429, 'rate_limit_error', 'pool_rate_limited'],
  ]
  for (const [reason, status, type, code] of cases) {
    const scheduler = {
      async selectAndReserve() {
        return { ok: false, reason, retry_after_ms: 41_200, eligible: 0 }
      },
      markCooldown() {},
      markSuccess() {},
    }
    const result = await new FailoverRunner({ scheduler }).run({
      requestId: `req-${reason}`,
      canonicalBody: { model: 'claude-sonnet-test' },
      model: 'claude-sonnet-test',
      callAttempt: () => success(),
    })
    assert.equal(result.status, status, reason)
    assert.equal(result.body.error.type, type, reason)
    assert.equal(result.body.error.code, code, reason)
    assert.equal(result.retryAfterSec, 42, reason)
  }
})

test('a full pool queue answers 529 immediately with retry-after >= 1s', async () => {
  const scheduler = {
    async selectAndReserve() {
      throw Object.assign(new Error('Claude pool queue is full'), { code: 'pool_wait_queue_full', retryAfterMs: null })
    },
    markCooldown() {},
    markSuccess() {},
  }
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-queue-full',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: () => success(),
  })
  assert.equal(result.status, 529)
  assert.equal(result.body.error.type, 'overloaded_error')
  assert.equal(result.body.error.explain, undefined)
  assert.equal(result.body.error.details, undefined)
  assert.equal(result.explain.reason, 'pool_wait_queue_full')
  assert.equal(result.retryAfterSec, 1)
})

test('one VM gets at most three executions for a request, hidden retries included', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const seen = []
  const runner = new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0 },
  })
  const result = await runner.run({
    requestId: 'req-incomplete-cap',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.vmId)
      return {
        ok: false,
        status: 200,
        committed: false,
        terminalState: 'incomplete',
        rust_transport_retried: seen.length === 1,
        body: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'draft', signature: 'sig' }],
          stop_reason: null,
        },
      }
    },
  })
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'incomplete_response')
  assert.equal(result.vmId, 'vm-01')
  assert.equal(result.attemptCount, 2)
  assert.deepEqual(seen, ['vm-01', 'vm-01'])
})

test('a hop that failed with a kernel-named cause ends with that cause, not incomplete_response', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const seen = []
  const runner = new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0 },
  })
  const result = await runner.run({
    requestId: 'req-network',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.vmId)
      return {
        ok: false,
        status: 502,
        committed: false,
        terminalState: 'incomplete',
        body: {
          type: 'error',
          error: { type: 'api_error', code: 'upstream_network_error', message: 'fetch failed: ECONNRESET' },
        },
      }
    },
  })
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'upstream_network_error')
  assert.ok(seen.includes('vm-02'), 'a network failure moves on to another VM')
  assert.deepEqual(scheduler.cooldowns, [], 'no account is penalised for it')
})

test('the fifth candidate is reached after four VMs fail', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)])
  const seen = []
  const result = await new FailoverRunner({
    scheduler,
    config: { same_account_retry_delay_ms: 0, max_total_attempts: 4, max_account_switches: 3 },
  }).run({
    requestId: 'req-fifth',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.vmId)
      if (selected.vmId === 'vm-05') return success('fifth')
      return {
        ok: false,
        status: 529,
        terminalState: 'rejected',
        body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.vmId, 'vm-05')
  assert.deepEqual(seen, ['vm-01', 'vm-02', 'vm-03', 'vm-04', 'vm-05'])
})

test('session queue timeout defaults to 15 minutes and reloads over the default', () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler })
  assert.equal(runner.config.session_queue_timeout_ms, 900_000)
  runner.reloadConfig({ total_retry_deadline_ms: 50 })
  assert.equal(runner.config.session_queue_timeout_ms, 900_000)
  runner.reloadConfig({ session_queue_timeout_ms: 0 })
  assert.equal(runner.config.session_queue_timeout_ms, 0)
})

test('batch member requests sharing a sticky key run concurrently, not serialized', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler })
  const memberKey = 'p:anthropic:bg:key_1:s:abc#0'
  let release
  let entered
  const holderEntered = new Promise((resolve) => {
    entered = resolve
  })
  const holder = runner.run({
    requestId: 'req-bg-1',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: memberKey,
    batchMember: true,
    callAttempt: () => {
      entered()
      return new Promise((resolve) => {
        release = () => resolve(success())
      })
    },
  })
  await holderEntered
  const second = await runner.run({
    requestId: 'req-bg-2',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: memberKey,
    batchMember: true,
    callAttempt: () => success(),
  })
  assert.equal(second.ok, true)
  release()
  assert.equal((await holder).ok, true)
  assert.equal(scheduler.selectCalls, 2)
})

test('a caller session id that looks like a batch member key is still serialized', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler, config: { session_queue_timeout_ms: 40 } })
  const forgedKey = 'p:anthropic:k1:bg:s:ab#0'
  let release
  let entered
  const holderEntered = new Promise((resolve) => {
    entered = resolve
  })
  const holder = runner.run({
    requestId: 'req-forged-1',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: forgedKey,
    callAttempt: () => {
      entered()
      return new Promise((resolve) => {
        release = () => resolve(success())
      })
    },
  })
  await holderEntered
  let waiterCalls = 0
  const second = await runner.run({
    requestId: 'req-forged-2',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: forgedKey,
    callAttempt: () => {
      waiterCalls += 1
      return success()
    },
  })
  assert.equal(second.ok, false)
  assert.equal(waiterCalls, 0)
  release()
  assert.equal((await holder).ok, true)
})

test('a same-session waiter times out without starting or overlapping the holder', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler, config: { session_queue_timeout_ms: 40 } })
  let release
  let entered
  const holderEntered = new Promise((resolve) => {
    entered = resolve
  })
  let holderCalls = 0
  let waiterCalls = 0
  let followerCalls = 0
  const holder = runner.run({
    requestId: 'req-hold',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'shared-session',
    callAttempt: () => {
      holderCalls += 1
      entered()
      return new Promise((resolve) => {
        release = () => resolve(success())
      })
    },
  })
  await holderEntered
  const waiter = await runner.run({
    requestId: 'req-wait',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'shared-session',
    callAttempt: () => {
      waiterCalls += 1
      return success()
    },
  })
  assert.equal(waiter.ok, false)
  assert.equal(waiter.status, 529)
  assert.equal(waiter.body.error.type, 'overloaded_error')
  assert.equal(waiter.body.error.code, 'pool_overloaded')
  assert.equal(waiter.body.error.explain, undefined)
  assert.equal(waiter.body.error.details, undefined)
  assert.equal(waiter.explain.reason, 'session_queue_timeout')
  assert.equal(waiterCalls, 0)
  assert.equal(holderCalls, 1)
  let followerEntered = false
  const follower = runner.run({
    requestId: 'req-follow',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'shared-session',
    callAttempt: () => {
      followerEntered = true
      followerCalls += 1
      return success()
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(followerEntered, false)
  release()
  const held = await holder
  const followed = await follower
  assert.equal(held.ok, true)
  assert.equal(followed.ok, true)
  assert.equal(followerCalls, 1)
  assert.equal(waiterCalls, 0)
  assert.equal(scheduler.selectCalls, 2)
})

test('session queue wait still aborts with the caller', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler, config: { session_queue_timeout_ms: 5_000 } })
  let release
  let entered
  const holderEntered = new Promise((resolve) => {
    entered = resolve
  })
  const holder = runner.run({
    requestId: 'req-hold-abort',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'abort-session',
    callAttempt: () => {
      entered()
      return new Promise((resolve) => {
        release = () => resolve(success())
      })
    },
  })
  await holderEntered
  const controller = new AbortController()
  const pending = runner.run({
    requestId: 'req-abort-wait',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stickyKey: 'abort-session',
    signal: controller.signal,
    callAttempt: () => success(),
  })
  controller.abort()
  const aborted = await pending
  assert.equal(aborted.terminalState, 'cancelled')
  assert.equal(aborted.status, 499)
  release()
  assert.equal((await holder).ok, true)
})

test('same sticky session requests execute serially', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler })
  let active = 0
  let peak = 0
  const callAttempt = async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active -= 1
    return success()
  }
  const request = (requestId) =>
    runner.run({
      requestId,
      canonicalBody: { model: 'claude-opus-test' },
      model: 'claude-opus-test',
      stickyKey: 'shared-session',
      callAttempt,
    })
  const [first, second] = await Promise.all([request('req-serial-1'), request('req-serial-2')])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(peak, 1)
})

test('different sticky sessions still execute concurrently', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler })
  let active = 0
  let peak = 0
  const callAttempt = async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active -= 1
    return success()
  }
  await Promise.all(
    ['session-a', 'session-b'].map((stickyKey) =>
      runner.run({
        requestId: `req-${stickyKey}`,
        canonicalBody: { model: 'claude-opus-test' },
        model: 'claude-opus-test',
        stickyKey,
        callAttempt,
      }),
    ),
  )
  assert.equal(peak, 2)
})

test('fable 403 marks pro and failovers without credential cooldown', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const denied = []
  const accepted = []
  const runner = new FailoverRunner({
    scheduler,
    onFablePlanDenied: (event) => denied.push(event.selected.accountId),
    onFableSuccess: (event) => accepted.push(event.selected.accountId),
  })
  const result = await runner.run({
    requestId: 'req-fable-pro',
    canonicalBody: { model: 'claude-fable-5' },
    model: 'claude-fable-5',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 403,
          terminalState: 'rejected',
          body: { error: { type: 'permission_error', message: 'permission denied' } },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual(denied, ['account-1'])
  assert.deepEqual(accepted, ['account-2'])
  assert.equal(scheduler.cooldowns.length, 0)
})

test('fable usage-credits 429 marks the account and failovers to the next one', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const denied = []
  const accepted = []
  const runner = new FailoverRunner({
    scheduler,
    onFablePlanDenied: (event) => denied.push([event.selected.accountId, event.policy.reason]),
    onFableSuccess: (event) => accepted.push(event.selected.accountId),
  })
  const result = await runner.run({
    requestId: 'req-fable-credits',
    canonicalBody: { model: 'claude-fable-5-2' },
    model: 'claude-fable-5-2',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 429,
          terminalState: 'rejected',
          body: {
            type: 'error',
            error: { type: 'rate_limit_error', message: 'Usage credits are required for this model.' },
          },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual(denied, [['account-1', 'fable_credits_required']])
  assert.deepEqual(accepted, ['account-2'])
  assert.equal(scheduler.cooldowns.length, 0)
})

test('when every account needs Fable usage credits the caller gets that 429, not a generic 502', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler, onFablePlanDenied: () => {} })
  const result = await runner.run({
    requestId: 'req-fable-credits-all',
    canonicalBody: { model: 'claude-fable-5-2' },
    model: 'claude-fable-5-2',
    callAttempt: () => ({
      ok: false,
      status: 429,
      terminalState: 'incomplete',
      body: {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Usage credits are required for this model.' },
      },
    }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 429)
  assert.match(result.body.error.message, /Usage credits are required/)
})

function leasingScheduler(candidates, cap = 2) {
  const state = { inflight: 0, selects: [] }
  return {
    state,
    async selectAndReserve(opts) {
      state.selects.push(opts)
      const vmId = opts.pinVmId || opts.familyVmId || candidates[0].vmId
      const found = candidates.find((item) => item.vmId === vmId)
      if (!found || state.inflight >= cap) return { ok: false, reason: 'all_accounts_busy', eligible: 1 }
      state.inflight++
      let released = false
      return {
        ...found,
        ok: true,
        release() {
          if (released) return
          released = true
          state.inflight--
        },
      }
    },
    markCooldown() {},
    markSuccess() {},
  }
}

test('explicit VM pin is not redirected by a family locked elsewhere', async () => {
  const scheduler = leasingScheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: {
      resolve: (key) => (key === 'family2:root' ? { accountId: 'account-2', vmId: 'vm-02' } : null),
      bind: () => true,
    },
  })
  for (let i = 0; i < 3; i++) {
    const result = await runner.run({
      requestId: `req-pinned-${i}`,
      canonicalBody: { model: 'claude-haiku-test' },
      model: 'claude-haiku-test',
      pinVmId: 'vm-01',
      familyKey: 'family2:root',
      familyVmId: 'vm-02',
      callAttempt: () => success(),
    })
    assert.equal(result.ok, true)
    assert.equal(result.vmId, 'vm-01')
  }
  assert.equal(scheduler.state.selects.length, 3)
  assert.equal(scheduler.state.inflight, 0)
})

test('an all-rest pool 503 carries Retry-After for the next window open', async () => {
  const scheduler = {
    async selectAndReserve() {
      return { ok: false, reason: 'no_eligible_accounts', retry_after_ms: 90_500, eligible: 0, available: 0 }
    },
  }
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-all-rest',
    canonicalBody: { model: 'claude-sonnet-test' },
    model: 'claude-sonnet-test',
    callAttempt: () => success(),
  })
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'account_pool_exhausted')
  assert.equal(result.retryAfterSec, 91)
})

test('org OAuth refusal pauses that slot and the family request hops to another', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const pauses = []
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: { resolve: () => null, bind: () => true, unbind: () => true },
    onSchedulePause: (value) => pauses.push(value),
  })
  const result = await runner.run({
    requestId: 'req-org-refusal',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    familyKey: 'family2:root',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 403,
          terminalState: 'rejected',
          body: {
            type: 'error',
            error: {
              type: 'permission_error',
              message: 'OAuth authentication is currently not allowed for this organization.',
            },
          },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  // A pause, not a timed or permanent runtime cooldown.
  assert.deepEqual(scheduler.cooldowns, [])
  assert.equal(scheduler.releasedAccounts[0].accountId, 'account-1')
  assert.equal(pauses.length, 1)
  assert.equal(pauses[0].selected.vmId, 'vm-01')
  assert.equal(pauses[0].policy.reason, 'organization_disabled')
  assert.equal(pauses[0].policy.detail.status, 403)
})

test('a slot that cannot refresh its credential hops and cools down', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const seen = []
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-credential-ensure',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.accountId)
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 400,
          credential_ensure_failed: true,
          terminalState: 'rejected',
          body: {
            type: 'error',
            error: { type: 'worker_error', code: 'refresh_failed', message: 'OAuth refresh failed' },
          },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual(seen, ['account-1', 'account-2'])
  assert.equal(scheduler.cooldowns.length, 1)
  assert.equal(scheduler.cooldowns[0].update.reason, 'credential_refresh_failed')
  assert.equal(scheduler.cooldowns[0].update.status, 'cooldown')
})

test('signature 400 on a hop that replayed foreign thinking is stripped and retried with the switch off', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler })
  const seen = []
  const result = await runner.run({
    requestId: 'req-foreign-sig',
    canonicalBody: {
      model: 'claude-opus-test',
      thinking: { type: 'adaptive' },
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 'other-pool-signature' },
            { type: 'text', text: 'keep' },
          ],
        },
        { role: 'user', content: 'next' },
      ],
    },
    model: 'claude-opus-test',
    applyAttempt: (body, _selected, extra) => {
      seen.push(extra.repairs)
      return { body, meta: { foreignThinking: true } }
    },
    callAttempt: ({ body }) => {
      if (seen.length === 1) {
        return {
          ok: false,
          status: 400,
          terminalState: 'error',
          body: { error: { message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } },
        }
      }
      assert.deepEqual(body.messages[1].content, [{ type: 'text', text: 'keep' }])
      return success('stripped')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(seen.length, 2)
  assert.deepEqual(seen[1], [{ action: 'repair-and-retry', reason: 'signature_repairable' }])
})

test('signature 400 without foreign thinking still surfaces with the switch off', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler })
  let calls = 0
  const result = await runner.run({
    requestId: 'req-own-sig',
    canonicalBody: { model: 'claude-opus-test', messages: [{ role: 'user', content: 'q' }] },
    model: 'claude-opus-test',
    applyAttempt: (body) => ({ body, meta: { foreignThinking: false } }),
    callAttempt: () => {
      calls++
      return {
        ok: false,
        status: 400,
        terminalState: 'error',
        body: { error: { message: 'Invalid `signature` in `thinking` block' } },
      }
    },
  })
  assert.equal(result.status, 400)
  assert.equal(calls, 1)
})

// 2026-11-17 prod: three accounts each answered 429 (native stream path tags any
// failed hop 'incomplete'), and the caller got 502 incomplete_response.
test('a Fable 429 with only Retry-After probes usage without cooling ordinary Opus', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const probes = []
  const runner = new FailoverRunner({
    scheduler,
    rateLimitService: {
      handleUpstreamError({ accountId, policy }) {
        probes.push({ accountId, policy })
        return null
      },
    },
  })
  const failed = await runner.run({
    requestId: 'fable-unknown-quota',
    canonicalBody: { model: 'claude-fable-5-2' },
    model: 'claude-fable-5-2',
    callAttempt: () => ({
      ok: false,
      status: 429,
      terminalState: 'incomplete',
      providerResult: { response_headers: { 'retry-after': '109005' } },
      body: { error: { type: 'rate_limit_error', message: "This request would exceed your account's rate limit." } },
    }),
  })
  assert.equal(failed.status, 429)
  assert.equal(failed.headers['retry-after'], '109005')
  assert.equal(probes.length, 1)
  assert.equal(probes[0].policy.reason, 'rate_limited_unknown')
  assert.equal(probes[0].policy.cooldownUntil, null)
  assert.deepEqual(scheduler.cooldowns, [])
  const opus = await runner.run({
    requestId: 'opus-after-fable',
    canonicalBody: { model: 'claude-opus-5-5' },
    model: 'claude-opus-5-5',
    callAttempt: () => success('OK'),
  })
  assert.equal(opus.status, 200)
})

test('when every account answers 429 the caller gets that 429, not a generic 502', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const seen = []
  const runner = new FailoverRunner({ scheduler, config: { same_account_retry_delay_ms: 0 } })
  const result = await runner.run({
    requestId: 'req-all-429',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.accountId)
      return {
        ok: false,
        status: 429,
        committed: false,
        terminalState: 'incomplete',
        headers: { 'retry-after': '30' },
        body: { type: 'error', error: { type: 'rate_limit_error', message: 'Error' } },
      }
    },
  })
  assert.ok(seen.includes('account-1') && seen.includes('account-2'), 'every account was tried first')
  assert.equal(result.ok, false)
  assert.equal(result.status, 429)
  assert.equal(result.body.error.type, 'rate_limit_error')
  assert.equal(result.headers['retry-after'], '30')
})

test('keep_pin_on_model_gate: a borrowed account never takes the session, family or device pin', async () => {
  const binds = []
  const scheduler = new Scheduler([{ ...candidate(2), stickyBorrowed: true }])
  const runner = new FailoverRunner({
    scheduler,
    stickyRouter: {
      resolve: (key) => (key === 'sess:home' ? { accountId: 'account-1', vmId: 'vm-01', generation: 1 } : null),
      bind: (key) => binds.push(key),
      bindDeviceAffinity: (key) => binds.push(key),
      unbind() {},
    },
    config: { same_account_retry_delay_ms: 0, keep_session_home: true },
  })
  const result = await runner.run({
    requestId: 'req-borrow',
    canonicalBody: { model: 'claude-fable-test' },
    model: 'claude-fable-test',
    stickyKey: 'sess:home',
    familyKey: 'family2:home',
    deviceKey: 'dev2:machine',
    callAttempt: () => success('borrowed'),
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.deepEqual(binds, [])
})

// --- poison request quarantine ---------------------------------------------

function silentTimeout() {
  return {
    ok: false,
    status: 504,
    committed: false,
    terminalState: 'rejected',
    body: {
      error: { type: 'upstream_timeout', code: 'upstream_timeout', message: 'job idle timeout: no CLI frame for 180s' },
    },
  }
}

const turnBody = (...extra) => ({
  model: 'claude-opus-test',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ...extra,
  ],
})

function poisonHarness(config = {}) {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler, config: { max_same_account_retries: 0, ...config } })
  runner.poisonGuard.logger = { warn() {} }
  const calls = { n: 0 }
  const send = (body, { stickyKey = 'sess:client-1', outcome = silentTimeout() } = {}) =>
    runner.run({
      requestId: `req-${calls.n + 1}`,
      canonicalBody: body,
      model: 'claude-opus-test',
      stream: false,
      stickyKey,
      stickyKeys: [stickyKey],
      callAttempt: () => {
        calls.n += 1
        return typeof outcome === 'function' ? outcome() : outcome
      },
    })
  return { runner, scheduler, calls, send }
}

test('after two silent timeouts the third identical request is refused without touching a seat', async () => {
  const { scheduler, calls, send } = poisonHarness()
  await send(turnBody())
  await send(turnBody())
  assert.equal(calls.n, 2)
  const selectBefore = scheduler.selectCalls
  const started = Date.now()
  const out = await send(turnBody())
  assert.equal(calls.n, 2, 'no kernel job for the quarantined request')
  assert.equal(scheduler.selectCalls, selectBefore, 'no seat reserved')
  assert.ok(Date.now() - started < 500)
  assert.equal(out.status, 400)
  assert.equal(out.body.error.type, 'invalid_request_error')
  assert.equal(out.body.error.code, 'request_quarantined')
  assert.match(out.body.error.message, /rewind|new conversation|new session/i)
  assert.equal(out.finalState, 'rejected')
  assert.equal(out.attemptCount, 0)
})

test('a quarantined conversation that only grew is still refused, a rewound one goes through', async () => {
  const { calls, send } = poisonHarness()
  await send(turnBody())
  await send(turnBody())
  const grown = await send(turnBody({ role: 'assistant', content: 'x' }, { role: 'user', content: 'continue' }))
  assert.equal(grown.body.error.code, 'request_quarantined')
  const rewound = turnBody()
  rewound.messages.pop()
  const out = await send(rewound, { outcome: success() })
  assert.equal(out.ok, true)
  assert.equal(calls.n, 3)
})

test('another session on the same seat is unaffected', async () => {
  const { send } = poisonHarness()
  await send(turnBody())
  await send(turnBody())
  const other = await send(turnBody(), { stickyKey: 'sess:client-2', outcome: success() })
  assert.equal(other.ok, true)
})

test('ordinary timeouts and other failures never quarantine', async () => {
  const { calls, send } = poisonHarness()
  const plain = () => ({
    ...silentTimeout(),
    body: { error: { type: 'upstream_timeout', message: 'upstream request timed out' } },
  })
  await send(turnBody(), { outcome: plain })
  await send(turnBody(), { outcome: plain })
  const out = await send(turnBody(), { outcome: plain })
  assert.equal(calls.n, 3)
  assert.notEqual(out.body?.error?.code, 'request_quarantined')
})

test('a success on the session lifts the record', async () => {
  const { calls, send } = poisonHarness()
  await send(turnBody())
  await send(turnBody(), { outcome: success() })
  const out = await send(turnBody())
  assert.equal(calls.n, 3)
  assert.notEqual(out.body?.error?.code, 'request_quarantined')
})

test('the guard can be turned off from config', async () => {
  const { calls, send } = poisonHarness({ poison_request_threshold: 0 })
  for (let i = 0; i < 4; i += 1) await send(turnBody())
  assert.equal(calls.n, 4)
})

test('a quarantined session is not counted toward the per-VM kernel circuit', async () => {
  const { vmTimeoutTracker } = await import('../../src/lib/pool/failover-runner.mjs')
  vmTimeoutTracker.reset()
  const { send } = poisonHarness()
  for (let i = 0; i < 6; i += 1) await send(turnBody())
  assert.ok((vmTimeoutTracker.counts.get('vm-01')?.count || 0) < 3, 'refused requests never reach the tracker')
})

// --- per-VM size ceiling in the runner --------------------------------------

const bigBody = (kb) => ({ model: 'claude-opus-test', messages: [{ role: 'user', content: 'x'.repeat(kb * 1024) }] })

function ceilingHarness(candidates) {
  const scheduler = new Scheduler(candidates)
  const runner = new FailoverRunner({ scheduler, config: { max_same_account_retries: 0 } })
  runner.poisonGuard.logger = { warn() {} }
  const served = []
  const send = (kb, session, { outcome = success(), extra = {} } = {}) =>
    runner.run({
      requestId: `req-${served.length + 1}`,
      canonicalBody: bigBody(kb),
      model: 'claude-opus-test',
      stream: false,
      stickyKey: `sess:${session}`,
      stickyKeys: [`sess:${session}`],
      callAttempt: ({ candidate }) => {
        served.push(candidate.vmId)
        return typeof outcome === 'function' ? outcome(candidate) : outcome
      },
      ...extra,
    })
  return { send, served, scheduler, runner }
}

test('once two sessions went silent on a VM, a larger request is served by another seat', async () => {
  const { send, served } = ceilingHarness([candidate(1), candidate(2)])
  // Only vm-01 goes quiet; its failed requests are answered by vm-02 within the same call.
  const onlyVm01Silent = (seat) => (seat.vmId === 'vm-01' ? silentTimeout() : success())
  await send(60, 'a', { outcome: onlyVm01Silent })
  await send(70, 'b', { outcome: onlyVm01Silent })
  served.length = 0
  const out = await send(80, 'c')
  assert.equal(out.ok, true)
  assert.deepEqual(served, ['vm-02'], 'the VM that went silent is skipped for requests this large')
  served.length = 0
  await send(10, 'd')
  assert.deepEqual(served, ['vm-01'], 'small requests still use it')
})

test('with no other seat the oversized request is refused with a clear 400 and sends nothing', async () => {
  const { send, served } = ceilingHarness([candidate(1)])
  await send(60, 'a', { outcome: silentTimeout })
  await send(70, 'b', { outcome: silentTimeout })
  served.length = 0
  const out = await send(80, 'c')
  assert.deepEqual(served, [])
  assert.equal(out.status, 400)
  assert.equal(out.body.error.type, 'invalid_request_error')
  assert.equal(out.body.error.code, 'request_too_large_for_slot')
  assert.match(out.body.error.message, /rewind|new session|new conversation/i)
  assert.match(out.body.error.message, /compact/i, 'warns that compacting sends the whole conversation')
  assert.equal(out.attemptCount, 0)
})

test('an operator pin to the VM still reaches it, for diagnosis', async () => {
  const { send, served } = ceilingHarness([candidate(1)])
  await send(60, 'a', { outcome: silentTimeout })
  await send(70, 'b', { outcome: silentTimeout })
  served.length = 0
  await send(80, 'c', { extra: { pinVmId: 'vm-01' } })
  assert.deepEqual(served, ['vm-01'])
})

test('while a ceiling is active a small request is still sent and a large one is still refused', async () => {
  const { send, served } = ceilingHarness([candidate(1)])
  await send(60, 'a', { outcome: silentTimeout })
  await send(70, 'b', { outcome: silentTimeout })
  served.length = 0
  await send(10, 'd')
  const still = await send(80, 'c')
  assert.equal(still.body.error.code, 'request_too_large_for_slot')
  assert.deepEqual(served, ['vm-01'], 'only the small request was sent')
})

test('successes that pass through the runner raise the floor, so an incident cannot close the VM below them', async () => {
  const { send, served } = ceilingHarness([candidate(1)])
  await send(50, 'z') // the VM answers a 50 KB request
  await send(8, 'a', { outcome: silentTimeout }) // then two sessions go quiet for an unrelated reason
  await send(300, 'b', { outcome: silentTimeout })
  served.length = 0
  const small = await send(10, 'c')
  assert.equal(small.ok, true, 'a 10 KB request is below what the VM has just served')
  assert.deepEqual(served, ['vm-01'])
  const big = await send(120, 'd')
  assert.equal(big.body.error.code, 'request_too_large_for_slot', 'what was never shown to work is still kept off')
})

test('#1562: CRAG pre-first-frame SOCKS5/transport_error 502 fails over across sticky/affinity slots without ping-pong', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-1562-socks5-'))
  const sticky = new StickyRouter({ dataDir, config: { sticky: { enabled: true } } })
  t.after(() => {
    sticky.db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const createAffinityScheduler = () => {
    const unitCircuit = new UnitCircuit({ failureThreshold: 3, openMs: 30_000 })
    const cooled = new Map()
    const cooldowns = []
    const candidates = [
      { vmId: 'vm-A', accountId: 'account-A', waitMs: 0 },
      { vmId: 'vm-B', accountId: 'account-B', waitMs: 0 },
      { vmId: 'vm-C', accountId: 'account-C', waitMs: 0 },
    ]
    return {
      unitCircuit,
      cooldowns,
      async selectAndReserve({ stickyKey, deviceVmId, familyVmId, excluded, avoid = null, allowWait = true }) {
        const now = Date.now()
        const stickyBound = stickyKey ? sticky.resolve(stickyKey) : null
        const ordered = [...candidates].sort((a, b) => {
          const rank = (item) => {
            if (stickyBound?.vmId === item.vmId) return 0
            if (deviceVmId === item.vmId || familyVmId === item.vmId) return 1
            return 2
          }
          return rank(a) - rank(b)
        })
        const open = ordered.filter((item) => {
          if (excluded.has(item.accountId) || excluded.has(item.vmId)) return false
          const until = cooled.get(item.accountId) || 0
          if (until > now) return false
          return unitCircuit.admit(item.accountId, now).ok
        })
        const preferred = avoid ? open.filter((item) => !avoid.has(item.accountId) && !avoid.has(item.vmId)) : open
        const selected = preferred[0] || (allowWait ? open[0] : null)
        if (!selected) return { ok: false, reason: 'no_eligible_accounts' }
        return { ...selected, ok: true, release() {} }
      },
      markCooldown(selected, update) {
        cooldowns.push({ candidate: selected, update })
        if (update?.until) cooled.set(selected.accountId, update.until)
      },
      markSuccess() {},
      releaseAccountSessions() {},
    }
  }

  // Subcase 1: SOCKS5 splice_rst (vm-A) + SOCKS5 greeting i/o timeout (vm-B) -> vm-C in 3 hops
  {
    const callerSession = 'sess-1562-proxy'
    const stickyKey = sticky.canonicalSessionKey(callerSession)
    sticky.bind(stickyKey, { accountId: 'account-A', vmId: 'vm-A', sessionId: 'out-a' }, { countHit: false })
    sticky.bindDeviceAffinity('dev2:caller-1', { accountId: 'account-B', vmId: 'vm-B' }, { countHit: false })

    const scheduler = createAffinityScheduler()
    const proxyFailures = []
    const runner = new FailoverRunner({
      scheduler,
      stickyRouter: sticky,
      config: { same_account_retry_delay_ms: 0 },
      onProxyFailure: (vmId, reason) => proxyFailures.push({ vmId, reason }),
    })

    const visited = []
    const result = await runner.run({
      requestId: 'req-1562-proxy',
      canonicalBody: { model: 'claude-opus-test' },
      model: 'claude-opus-test',
      stickyKey,
      deviceKey: 'dev2:caller-1',
      familyVmId: 'vm-B',
      callAttempt: ({ candidate: selected }) => {
        visited.push(selected.vmId)
        if (selected.vmId === 'vm-A') {
          return {
            ok: false,
            status: 502,
            upstreamStatus: 200,
            via: 'rust-kernel-stream',
            nativeHandoff: true,
            committed: false,
            firstByteAt: null,
            terminalState: 'incomplete',
            transportError: false,
            providerResult: {
              type: 'kin_provider_result',
              schema_version: 2,
              source: 'crag',
              provider_complete: false,
              usage_complete: false,
              http_status: null,
              public_status: 502,
              error: {
                type: 'transport_error',
                message: 'splice_rst dest=api.anthropic.com:443: connection reset by peer',
              },
            },
            body: {
              type: 'error',
              error: {
                type: 'transport_error',
                message: 'splice_rst dest=api.anthropic.com:443: connection reset by peer',
              },
            },
          }
        }
        if (selected.vmId === 'vm-B') {
          return {
            ok: false,
            status: 502,
            upstreamStatus: 200,
            via: 'rust-kernel-stream',
            nativeHandoff: true,
            committed: false,
            firstByteAt: null,
            terminalState: 'incomplete',
            transportError: false,
            providerResult: {
              type: 'kin_provider_result',
              schema_version: 2,
              source: 'crag',
              provider_complete: false,
              usage_complete: false,
              http_status: null,
              public_status: 502,
              error: {
                type: 'transport_error',
                message: 'socks_dial dest=api.anthropic.com:443: read SOCKS5 greeting: i/o timeout',
              },
            },
            body: {
              type: 'error',
              error: {
                type: 'transport_error',
                message: 'socks_dial dest=api.anthropic.com:443: read SOCKS5 greeting: i/o timeout',
              },
            },
          }
        }
        return success('healthy-c')
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.vmId, 'vm-C')
    assert.equal(result.attemptCount, 3)
    assert.deepEqual(visited, ['vm-A', 'vm-B', 'vm-C'])
    assert.deepEqual(proxyFailures, [
      { vmId: 'vm-A', reason: 'proxy_transport_failure' },
      { vmId: 'vm-B', reason: 'proxy_transport_failure' },
    ])
    assert.equal(scheduler.cooldowns.length, 2)
    assert.deepEqual(
      scheduler.cooldowns.map((entry) => ({ vmId: entry.candidate.vmId, reason: entry.update.reason })),
      [
        { vmId: 'vm-A', reason: 'proxy_transport_failure' },
        { vmId: 'vm-B', reason: 'proxy_transport_failure' },
      ],
    )
  }

  // Subcase 2: generic pre-first-frame transport_error (no proxy keyword) -> vm-A -> vm-B -> vm-C + UnitCircuit failures
  {
    const callerSession = 'sess-1562-net'
    const stickyKey = sticky.canonicalSessionKey(callerSession)
    sticky.bind(stickyKey, { accountId: 'account-A', vmId: 'vm-A', sessionId: 'out-a2' }, { countHit: false })
    sticky.bindDeviceAffinity('dev2:caller-2', { accountId: 'account-B', vmId: 'vm-B' }, { countHit: false })

    const scheduler = createAffinityScheduler()
    const runner = new FailoverRunner({
      scheduler,
      stickyRouter: sticky,
      config: { same_account_retry_delay_ms: 0 },
    })

    const visited = []
    const result = await runner.run({
      requestId: 'req-1562-net',
      canonicalBody: { model: 'claude-opus-test' },
      model: 'claude-opus-test',
      stickyKey,
      deviceKey: 'dev2:caller-2',
      familyVmId: 'vm-B',
      callAttempt: ({ candidate: selected }) => {
        visited.push(selected.vmId)
        if (selected.vmId === 'vm-C') return success('healthy-c')
        return {
          ok: false,
          status: 502,
          upstreamStatus: 200,
          via: 'rust-kernel-stream',
          nativeHandoff: true,
          committed: false,
          firstByteAt: null,
          terminalState: 'incomplete',
          transportError: false,
          providerResult: {
            type: 'kin_provider_result',
            schema_version: 2,
            source: 'crag',
            provider_complete: false,
            usage_complete: false,
            http_status: null,
            public_status: 502,
            error: { type: 'transport_error', message: 'unexpected EOF writing request body' },
          },
          body: {
            type: 'error',
            error: { type: 'transport_error', message: 'unexpected EOF writing request body' },
          },
        }
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.vmId, 'vm-C')
    assert.equal(result.attemptCount, 3)
    assert.deepEqual(visited, ['vm-A', 'vm-B', 'vm-C'])
    assert.equal(scheduler.unitCircuit.snapshot('account-A').failures, 1)
    assert.equal(scheduler.unitCircuit.snapshot('account-B').failures, 1)
  }
})

test('timeout tracker: repeat trips back off 15/30/60 minutes; success forgets them, reset does not', async () => {
  const { vmTimeoutTracker } = await import('../../src/lib/pool/failover-runner.mjs')
  vmTimeoutTracker.reset()
  const m = 60_000
  assert.equal(vmTimeoutTracker.recordTrip('vm-t', 0), 1)
  assert.equal(vmTimeoutTracker.faultHoldUntil('vm-t', 0), 0, 'one trip: no hold')
  vmTimeoutTracker.recordTrip('vm-t', 10 * m)
  assert.equal(vmTimeoutTracker.faultHoldUntil('vm-t', 10 * m), 25 * m)
  vmTimeoutTracker.reset('vm-t')
  vmTimeoutTracker.recordTrip('vm-t', 30 * m)
  assert.equal(vmTimeoutTracker.faultHoldUntil('vm-t', 30 * m), 60 * m, 'reset keeps trip history')
  vmTimeoutTracker.recordTrip('vm-t', 70 * m)
  vmTimeoutTracker.recordTrip('vm-t', 80 * m)
  assert.equal(vmTimeoutTracker.faultHoldUntil('vm-t', 80 * m), 140 * m, 'capped at 60 minutes')
  assert.equal(vmTimeoutTracker.faultHoldUntil('vm-t', 80 * m + 3 * 60 * m), 0, 'trips age out of the 2h window')
  vmTimeoutTracker.recordSuccess('vm-t')
  assert.equal(vmTimeoutTracker.trips.has('vm-t'), false)
  vmTimeoutTracker.reset()
})

test('timeout tracker: tripCount only counts trips inside the window and prunes the rest', async () => {
  const { vmTimeoutTracker } = await import('../../src/lib/pool/failover-runner.mjs')
  vmTimeoutTracker.reset()
  const m = 60_000
  vmTimeoutTracker.recordTrip('vm-t', 0)
  vmTimeoutTracker.recordTrip('vm-t', 10 * m)
  vmTimeoutTracker.recordTrip('vm-t', 130 * m)
  // The oldest two have left the 2h window by now: the circuit log must not
  // claim them. recordTrip is the only other writer and it is skipped while the
  // fault is already set, so tripCount has to do the pruning itself.
  assert.equal(vmTimeoutTracker.tripCount('vm-t', 140 * m), 1, 'aged-out trips are not counted')
  assert.deepEqual(vmTimeoutTracker.trips.get('vm-t'), [130 * m], 'and are dropped from the list')
  assert.equal(vmTimeoutTracker.tripCount('vm-t', 400 * m), 0, 'an empty window counts nothing')
  assert.equal(vmTimeoutTracker.trips.has('vm-t'), false, 'the VM leaves the map once nothing is left')
  assert.equal(vmTimeoutTracker.tripCount(null), 0)
  vmTimeoutTracker.reset()
})

test('upstream 400 stops without failover while 400 and 403 both count toward UnitCircuit and trip at threshold', async () => {
  let now = 10_000
  const unitCircuit = new UnitCircuit({ failureThreshold: 3, openMs: 30_000, now: () => now })
  const candidates = [
    { vmId: 'vm-A', accountId: 'account-A', waitMs: 0 },
    { vmId: 'vm-B', accountId: 'account-B', waitMs: 0 },
  ]
  const scheduler = {
    unitCircuit,
    async selectAndReserve({ excluded }) {
      const picked = candidates.find(
        (item) =>
          !excluded.has(item.accountId) && !excluded.has(item.vmId) && unitCircuit.inspect(item.accountId, now).ok,
      )
      if (!picked) return { ok: false, reason: 'no_eligible_accounts' }
      const hold = unitCircuit.admit(picked.accountId, now)
      if (!hold.ok) return { ok: false, reason: hold.reason }
      return { ...picked, ok: true, release() {} }
    },
    markCooldown() {},
    markSuccess() {},
    releaseAccountSessions() {},
  }
  const runner = new FailoverRunner({ scheduler, config: { same_account_retry_delay_ms: 0 } })

  // 1. Upstream generic 400 stops immediately (no failover) and increments failures to 1.
  const hop1Vms = []
  const r1 = await runner.run({
    requestId: 'req-400-1',
    canonicalBody: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
    model: 'claude-sonnet-5',
    callAttempt: ({ candidate }) => {
      hop1Vms.push(candidate.vmId)
      return {
        ok: false,
        status: 400,
        terminalState: 'rejected',
        body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad upstream payload' } },
      }
    },
  })
  assert.equal(r1.status, 400)
  assert.deepEqual(hop1Vms, ['vm-A'])
  assert.equal(unitCircuit.snapshot('account-A').failures, 1)
  assert.equal(unitCircuit.snapshot('account-A').state, 'closed')

  // 2. Local validation / refusal 400 does NOT increment failures.
  await runner.run({
    requestId: 'req-400-local',
    canonicalBody: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
    model: 'claude-sonnet-5',
    callAttempt: () => ({
      ok: false,
      status: 400,
      terminalState: 'rejected',
      body: { type: 'error', error: { code: 'invalid_kernel_request', message: 'local invalid' } },
    }),
  })
  assert.equal(unitCircuit.snapshot('account-A').failures, 1)

  // 3. Upstream 403 fails over to vm-B and increments account-A failures to 2.
  const hop3Vms = []
  const r3 = await runner.run({
    requestId: 'req-403-2',
    canonicalBody: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
    model: 'claude-sonnet-5',
    callAttempt: ({ candidate }) => {
      hop3Vms.push(candidate.vmId)
      if (candidate.vmId === 'vm-A') {
        return {
          ok: false,
          status: 403,
          terminalState: 'rejected',
          body: { type: 'error', error: { type: 'permission_error', message: 'permission denied' } },
        }
      }
      return success('ok-from-b')
    },
  })
  assert.equal(r3.ok, true)
  assert.deepEqual(hop3Vms, ['vm-A', 'vm-B'])
  assert.equal(unitCircuit.snapshot('account-A').failures, 2)
  assert.equal(unitCircuit.snapshot('account-A').state, 'closed')

  // 4. First repairable 400 that STILL fails with 400 after repair counts once -> reaches 3 and opens circuit!
  let repairAttempt = 0
  const r4 = await runner.run({
    requestId: 'req-400-3',
    canonicalBody: {
      model: 'claude-sonnet-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
    },
    model: 'claude-sonnet-5',
    callAttempt: () => {
      repairAttempt += 1
      return {
        ok: false,
        status: 400,
        terminalState: 'rejected',
        body: { type: 'error', error: { message: 'Conversation must end with a user message' } },
      }
    },
  })
  assert.equal(repairAttempt, 2)
  assert.equal(r4.status, 400)
  assert.equal(unitCircuit.snapshot('account-A').failures, 3)
  assert.equal(unitCircuit.snapshot('account-A').state, 'open')

  // 5. Next request bypasses tripped vm-A and goes straight to vm-B.
  const hop5Vms = []
  const r5 = await runner.run({
    requestId: 'req-after-trip',
    canonicalBody: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
    model: 'claude-sonnet-5',
    callAttempt: ({ candidate }) => {
      hop5Vms.push(candidate.vmId)
      return success('routed-to-b')
    },
  })
  assert.equal(r5.ok, true)
  assert.deepEqual(hop5Vms, ['vm-B'])
})

/**
 * #1796 counts upstream 400/403 toward the unit circuit on purpose. These
 * cases pin the one exception: a single session may charge a given unit only
 * once for the request-scoped stop fallback, so a client stuck on a body that
 * every slot rejects cannot park the whole pool. Cross-session evidence and
 * unit-scoped circuits are untouched.
 */
function circuitHarness() {
  const now = 10_000
  const unitCircuit = new UnitCircuit({ failureThreshold: 3, openMs: 30_000, now: () => now })
  const candidates = [
    { vmId: 'vm-A', accountId: 'account-A', waitMs: 0 },
    { vmId: 'vm-B', accountId: 'account-B', waitMs: 0 },
  ]
  const scheduler = {
    unitCircuit,
    async selectAndReserve({ excluded }) {
      const picked = candidates.find(
        (item) =>
          !excluded.has(item.accountId) && !excluded.has(item.vmId) && unitCircuit.inspect(item.accountId, now).ok,
      )
      if (!picked) return { ok: false, reason: 'no_eligible_accounts' }
      const hold = unitCircuit.admit(picked.accountId, now)
      if (!hold.ok) return { ok: false, reason: hold.reason }
      return { ...picked, ok: true, release() {} }
    },
    markCooldown() {},
    markSuccess() {},
    releaseAccountSessions() {},
  }
  return {
    unitCircuit,
    runner: new FailoverRunner({ scheduler, config: { same_account_retry_delay_ms: 0 } }),
  }
}

const genericUpstream400 = () => ({
  ok: false,
  status: 400,
  terminalState: 'rejected',
  body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad upstream payload' } },
})

test('#5 one session charges a unit circuit once for the stop-400 fallback', async () => {
  sessionCircuitDedupe.reset()
  const { unitCircuit, runner } = circuitHarness()

  for (const attempt of [1, 2, 3, 4]) {
    const result = await runner.run({
      requestId: `req-dedupe-${attempt}`,
      stickyKey: 'session-A',
      canonicalBody: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
      model: 'claude-sonnet-5',
      callAttempt: genericUpstream400,
    })
    // The caller still gets its 400 every time; only the circuit accounting changes.
    assert.equal(result.status, 400, `attempt ${attempt}`)
  }
  assert.equal(unitCircuit.snapshot('account-A').failures, 1, 'one session must not stack failures')
  assert.equal(unitCircuit.snapshot('account-A').state, 'closed', 'the slot must stay routable')
})

test('#5 separate sessions still park a slot that rejects what others accept', async () => {
  sessionCircuitDedupe.reset()
  const { unitCircuit, runner } = circuitHarness()

  for (const session of ['session-1', 'session-2', 'session-3']) {
    await runner.run({
      requestId: `req-cross-${session}`,
      stickyKey: session,
      canonicalBody: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
      model: 'claude-sonnet-5',
      callAttempt: genericUpstream400,
    })
  }
  assert.equal(unitCircuit.snapshot('account-A').failures, 3, 'cross-session evidence must still accumulate')
  assert.equal(unitCircuit.snapshot('account-A').state, 'open')
})

test('#5 unit-scoped circuits keep charging on every hit from one session', async () => {
  sessionCircuitDedupe.reset()
  const { unitCircuit, runner } = circuitHarness()

  // organization_disabled is account-scoped: it describes the unit, not the
  // request, so the dedupe must not apply to it.
  for (const attempt of [1, 2, 3]) {
    await runner.run({
      requestId: `req-org-${attempt}`,
      stickyKey: 'session-A',
      canonicalBody: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
      model: 'claude-sonnet-5',
      callAttempt: ({ candidate }) =>
        candidate.vmId === 'vm-A'
          ? {
              ok: false,
              status: 400,
              terminalState: 'rejected',
              body: { type: 'error', error: { message: 'This organization has been disabled.' } },
            }
          : success('ok-from-b'),
    })
  }
  assert.equal(unitCircuit.snapshot('account-A').failures, 3, 'unit-scoped failures must not be deduped')
  assert.equal(unitCircuit.snapshot('account-A').state, 'open')
})

test('#5 a verified success clears the session dedupe so later failures count again', async () => {
  sessionCircuitDedupe.reset()
  const { unitCircuit, runner } = circuitHarness()
  const body = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }

  await runner.run({
    requestId: 'req-clear-1',
    stickyKey: 'session-A',
    canonicalBody: body,
    model: 'claude-sonnet-5',
    callAttempt: genericUpstream400,
  })
  assert.equal(unitCircuit.snapshot('account-A').failures, 1)

  // A success resets the circuit's own counter and the dedupe entry with it.
  await runner.run({
    requestId: 'req-clear-ok',
    stickyKey: 'session-A',
    canonicalBody: body,
    model: 'claude-sonnet-5',
    callAttempt: () => success(),
  })
  assert.equal(unitCircuit.snapshot('account-A').failures, 0)

  // So the next failure is a fresh incident rather than a silenced repeat.
  await runner.run({
    requestId: 'req-clear-2',
    stickyKey: 'session-A',
    canonicalBody: body,
    model: 'claude-sonnet-5',
    callAttempt: genericUpstream400,
  })
  assert.equal(unitCircuit.snapshot('account-A').failures, 1)
})

/**
 * A kernel-preflight 400 is a local rejection: the slot's kernel refused to
 * assemble the body, and `via` marks it as such. When the code points at a
 * capability rather than at the request, the other kernel kind may accept the
 * same body, so the conversation gets one hop off that slot.
 */
function preflightReject(code, param = 'messages[1].content[0]') {
  return {
    ok: false,
    status: 400,
    via: 'kernel-preflight',
    headers: {},
    terminalState: 'rejected',
    transportError: false,
    committed: false,
    upstreamExecutions: 0,
    body: { type: 'error', error: { type: 'invalid_request_error', code, message: `rejected: ${code}`, param } },
  }
}

function stickySpy() {
  const unbound = []
  return {
    unbound,
    router: {
      resolve: () => null,
      bind: () => {},
      unbind: (key) => unbound.push(key),
    },
  }
}

test('#3 a kernel capability rejection re-dispatches once and drops the session binding', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const sticky = stickySpy()
  const runner = new FailoverRunner({ scheduler, stickyRouter: sticky.router })
  const seen = []
  const result = await runner.run({
    requestId: 'req-kernel-mismatch',
    stickyKey: 'session-A',
    model: 'claude-sonnet-5',
    canonicalBody: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.accountId)
      // The first slot cannot model this block type; the second one can.
      return selected.accountId === 'account-1' ? preflightReject('invalid_kernel_request') : success('ok-from-2')
    },
  })
  assert.equal(result.ok, true, 'the other kernel must get a chance to answer')
  assert.deepEqual(seen, ['account-1', 'account-2'])
  assert.ok(sticky.unbound.includes('session-A'), 'the session binding must be released, not just the slot seat')
})

test('#3 the re-dispatch happens at most once', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2), candidate(3)])
  const sticky = stickySpy()
  const runner = new FailoverRunner({ scheduler, stickyRouter: sticky.router })
  const seen = []
  const result = await runner.run({
    requestId: 'req-kernel-mismatch-all',
    stickyKey: 'session-A',
    model: 'claude-sonnet-5',
    canonicalBody: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.accountId)
      return preflightReject('unsupported_capability', 'tools[0].type')
    },
  })
  // Two slots tried, then the clear 400 is returned instead of walking the pool.
  assert.equal(seen.length, 2, 'must not keep hopping when every kernel refuses')
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'unsupported_capability')
})

test('#3 request-shaped preflight rejections are not re-dispatched', async () => {
  for (const code of ['invalid_cache_control', 'image_too_large', 'invalid_image_url', 'invalid_tool_schema']) {
    const scheduler = new Scheduler([candidate(1), candidate(2)])
    const sticky = stickySpy()
    const runner = new FailoverRunner({ scheduler, stickyRouter: sticky.router })
    const seen = []
    const result = await runner.run({
      requestId: `req-fatal-${code}`,
      stickyKey: 'session-A',
      model: 'claude-sonnet-5',
      canonicalBody: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
      callAttempt: ({ candidate: selected }) => {
        seen.push(selected.accountId)
        return preflightReject(code)
      },
    })
    assert.equal(seen.length, 1, `${code} is refused by every kernel; one slot is enough`)
    assert.equal(result.status, 400, code)
    assert.deepEqual(sticky.unbound, [], `${code} must not disturb the session binding`)
  }
})

test('#3 an upstream 400 with the same code is not treated as a capability mismatch', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const sticky = stickySpy()
  const runner = new FailoverRunner({ scheduler, stickyRouter: sticky.router })
  const seen = []
  // Same code, but no `via: kernel-preflight`: this came back from upstream, so
  // the slot assembled the request fine and hopping proves nothing.
  const result = await runner.run({
    requestId: 'req-upstream-code',
    stickyKey: 'session-A',
    model: 'claude-sonnet-5',
    canonicalBody: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
    callAttempt: ({ candidate: selected }) => {
      seen.push(selected.accountId)
      return {
        ok: false,
        status: 400,
        terminalState: 'rejected',
        body: { type: 'error', error: { code: 'invalid_kernel_request', message: 'upstream said no' } },
      }
    },
  })
  assert.equal(seen.length, 1)
  assert.equal(result.status, 400)
  assert.deepEqual(sticky.unbound, [])
})

test('terminal switchNode errors (422 poison_abort, 403 pool_forbidden, 429 session_*) never fall back to same-unit acquireNode', async () => {
  const cases = [
    { status: 422, code: 'poison_abort', message: 'Poison request aborted' },
    { status: 403, code: 'pool_forbidden', message: 'Pool forbidden' },
    { status: 429, code: 'session_in_flight', message: 'Session already in flight' },
    { status: 429, code: 'session_queue_full', message: 'Session queue full' },
    { status: 429, code: 'session_queue_timeout', message: 'Session queue timed out' },
    { status: 429, code: 'session_node_busy', message: 'Session node busy' },
  ]
  for (const tc of cases) {
    const scheduler = new Scheduler([candidate(1)])
    let acquireCalls = 0
    let switchCalls = 0
    const baseRt = makeMockFailoverRuntime({ scheduler })
    const schedulerRuntime = {
      ...baseRt,
      async acquireNode(params, opts) {
        acquireCalls += 1
        return baseRt.acquireNode(params, opts)
      },
      async switchNode() {
        switchCalls += 1
        throw new SchedulerApiError({
          status: tc.status,
          code: tc.code,
          message: tc.message,
          retryAfterSec: tc.status === 429 ? 1 : undefined,
        })
      },
    }
    const runner = new FailoverRunner({
      scheduler,
      schedulerRuntime,
      config: { same_account_retry_delay_ms: 0, max_same_account_retries: 2 },
    })
    const result = await runner.run({
      requestId: `req-terminal-switch-${tc.code}`,
      canonicalBody: { model: 'claude-sonnet-test' },
      model: 'claude-sonnet-test',
      // Fast 502 keeps canSameUnit === true, verifying terminal switch errors are NOT swallowed.
      callAttempt: () => badGateway(),
    })
    assert.equal(acquireCalls, 1, `${tc.code} must not trigger same-unit acquireNode retry`)
    assert.equal(switchCalls, 1, `${tc.code} must call switchNode once`)
    assert.equal(result.ok, false, tc.code)
    assert.equal(result.status, tc.status, tc.code)
    assert.equal(result.body.error.code, tc.code, tc.code)
  }
})
