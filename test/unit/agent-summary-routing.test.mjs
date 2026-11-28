import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { ThinkingOwnerStore } from '../../src/lib/pool/thinking-owner.mjs'
import { extractCallerSession, sessionIdFromOutboundBody } from '../../src/lib/identity/identity-rewrite.mjs'
import { agentBody as rawAgentBody } from '../fixtures/agent-summary.mjs'

const OFFICIAL_AGENT_DEVICE = 'a'.repeat(64)
const OFFICIAL_AGENT_SESSION = '11111111-2222-4333-8444-555555555555'
const agentBody = (opts) => ({
  ...rawAgentBody(opts),
  metadata: {
    user_id: JSON.stringify({ device_id: OFFICIAL_AGENT_DEVICE, session_id: OFFICIAL_AGENT_SESSION }),
  },
})
import { createAnthropicSseErrorRemapper } from '../../src/lib/protocol/stream-truncation.mjs'
import { responsesSseToAnthropicEvents } from '../../src/lib/protocol/codex-convert.mjs'
import { clearRustHealthCache, rememberRustHealth } from '../../src/lib/transport/kernel-router.mjs'
import { SchedulerApiError } from '../../src/lib/transport/scheduler-client.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function success() {
  return {
    ok: true,
    status: 200,
    terminalState: 'verified',
    body: {
      id: 'test-message',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'Reading coverage.ts' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 4 },
    },
  }
}

function makeMockSummaryRuntime({ capacity = 2 } = {}) {
  let leaseSeq = 0
  let active = 0
  let nextSlot = 0
  const capWaiters = []
  const sessionLocks = new Map()
  const leases = new Map()

  const wakeCap = () => {
    while (active < capacity && capWaiters.length > 0) {
      const next = capWaiters.shift()
      next.grant()
    }
  }

  const acquireSession = async (sessionKey, signal) => {
    if (!sessionKey) return () => {}
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    let st = sessionLocks.get(sessionKey)
    if (!st) {
      st = { held: false, waiters: [] }
      sessionLocks.set(sessionKey, st)
    }
    const release = () => {
      const next = st.waiters.shift()
      if (next) next.grant()
      else {
        st.held = false
        if (sessionLocks.get(sessionKey) === st) sessionLocks.delete(sessionKey)
      }
    }
    if (!st.held) {
      st.held = true
      return release
    }
    await new Promise((resolve, reject) => {
      let settled = false
      const w = {
        grant() {
          if (settled) return
          settled = true
          signal?.removeEventListener?.('abort', onAbort)
          resolve()
        },
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        const idx = st.waiters.indexOf(w)
        if (idx >= 0) st.waiters.splice(idx, 1)
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      st.waiters.push(w)
    })
    return release
  }

  const acquireCap = async (noQueue, signal) => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    if (active < capacity) {
      active += 1
      return
    }
    if (noQueue) {
      throw new SchedulerApiError({ status: 529, code: 'pool_overloaded', message: 'busy', retryAfterSec: 1 })
    }
    await new Promise((resolve, reject) => {
      let settled = false
      const w = {
        grant() {
          if (settled) return
          settled = true
          signal?.removeEventListener?.('abort', onAbort)
          active += 1
          resolve()
        },
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        const idx = capWaiters.indexOf(w)
        if (idx >= 0) capWaiters.splice(idx, 1)
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      capWaiters.push(w)
    })
  }

  return {
    activeCount: () => active,
    queuedCount: () => capWaiters.length,
    async acquireNode(params, { signal } = {}) {
      const lockKey = params.isEphemeralProbe ? '' : String(params.sessionId || '')
      const releaseLock = await acquireSession(lockKey, signal)
      try {
        await acquireCap(params.noQueue === true, signal)
        const leaseId = `summary-lease-${++leaseSeq}`
        const slotIndex = nextSlot++
        leases.set(leaseId, { releaseLock, slotIndex })
        return {
          lease_id: leaseId,
          lease_ttl_ms: 30_000,
          resolved_pool_id: params.originPoolId || '__default_claude__',
          selected_node: { node_type: 'claude_vm', node_id: 'vm-01', node_key: 'claude_vm:vm-01' },
          explain: { affinity: { why: 'balanced' } },
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
      active = Math.max(0, active - 1)
      rec.releaseLock()
      wakeCap()
    },
    slotIndexFor(leaseId) {
      return leases.get(leaseId)?.slotIndex ?? 0
    },
  }
}

function harness({
  mode = 'rebuild',
  capacity = 2,
  agentId = '',
  crag = false,
  compatibility = {},
  poolConfig = {},
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-summary-'))
  const routing = { compatibility, failover: {}, sticky: { enabled: true, outbound_session: mode } }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const sticky = new StickyRouter({ dataDir: root, config: routing })
  const rt = makeMockSummaryRuntime({ capacity })
  const vm = { id: 'vm-01', fingerprint: {}, claude: { account_uuid: 'account-1', account_tier: 'max' } }
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify(vm))
  const pool = new PoolScheduler({ projectRoot: root, stickyRouter: sticky, schedulerRuntime: rt, config: poolConfig })
  pool.resolveCandidateForNode = (_node, meta = {}) => ({
    ok: true,
    vmId: vm.id,
    accountId: 'account-1',
    vm,
    model: meta.model,
    exec: { vmId: vm.id, homeDir: root, vm },
    nodeKey: 'claude_vm:vm-01',
    leaseId: meta.leaseId || null,
    slotIndex: rt.slotIndexFor(meta.leaseId),
    selectionReason: meta.explain?.affinity?.why || 'balanced',
    waitMs: 0,
    queueWaitMs: 0,
    schedulingMs: 0,
    release() {},
  })
  const previousKernelBin = process.env.KIN_KERNEL_BIN
  if (crag) {
    process.env.KIN_KERNEL_BIN = '/bin/true'
    rememberRustHealth(
      { vmId: vm.id },
      { ok: true, health: { ok: true, runtime_variant: 'crag-v2', ready_slots: 2, capabilities: ['prompt_append'] } },
    )
  }
  const runner = new FailoverRunner({
    scheduler: pool,
    schedulerRuntime: rt,
    stickyRouter: sticky,
    config: { session_queue_timeout_ms: 2000 },
  })
  const requests = []
  const calls = []
  const clients = new Map()
  const consumed = new Set()
  const parentStarted = deferred()
  const parentGate = deferred()
  const thinkingDb = new DatabaseSync(':memory:')
  const handler = createHandleProtocol({
    json(res, status, body) {
      res.statusCode = status
      res.body = body
      res.headersSent = true
    },
    writeSSEHeaders(res) {
      res.headersSent = true
    },
    readBody: async (req) => req.body,
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 5000, stream_idle_timeout_ms: 5000 },
      paths: { data: root, project: root },
    },
    requestLog: {
      start: (req) => ({ request_id: req.id, mode: 'normal', t0: Date.now() }),
      finish() {},
    },
    stickyRouter: sticky,
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: {},
    apiScheduler: {},
    apiEndpointStore: {},
    settings: { get: (_key, fallback) => fallback },
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    thinkingOwners: new ThinkingOwnerStore({ db: thinkingDb }),
    schedulerRuntime: rt,
    failoverRunner: {
      run(opts) {
        requests.push(opts)
        return runner.run({
          ...opts,
          callAttempt: async (call) => {
            calls.push({ id: opts.requestId, ...call })
            if (crag) {
              const user = call.body.messages.findLast((message) => message.role === 'user')
              const results = Array.isArray(user?.content)
                ? user.content.filter((block) => block.type === 'tool_result')
                : []
              if (results.some((block) => consumed.has(block.tool_use_id))) {
                return {
                  ok: false,
                  status: 409,
                  terminalState: 'rejected',
                  body: { type: 'error', error: { type: 'invalid_request_error', message: 'tool_result replayed' } },
                }
              }
              for (const block of results) consumed.add(block.tool_use_id)
            }
            if (opts.requestId === 'parent') {
              parentStarted.resolve()
              await parentGate.promise
            }
            return success()
          },
        })
      },
    },
  })
  const headers = {
    'user-agent': 'claude-cli/2.1.306 (external, cli)',
    'x-app': 'cli',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-claude-code-session-id': OFFICIAL_AGENT_SESSION,
    'x-stainless-lang': 'js',
    'x-stainless-package-version': '0.128.0',
    'x-stainless-os': 'Linux',
    'x-stainless-arch': 'x64',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': 'v26.12.1',
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
    ...(agentId ? { 'x-claude-code-agent-id': agentId } : {}),
  }
  const parentSession = extractCallerSession({ inbound: agentBody(), headers })
  return {
    sticky,
    routing,
    pool,
    rt,
    runner,
    requests,
    calls,
    parentStarted,
    parentGate,
    parentSession,
    clients,
    mapClientError: (result) => handler.mapProtocolClientError(result, {}, 'upstream_error'),
    async invoke(id, body = agentBody(), extraHeaders = {}) {
      const req = Object.assign(new EventEmitter(), {
        id,
        method: 'POST',
        url: '/v1/messages',
        headers: { ...headers, ...extraHeaders },
        apiKeyKind: 'master',
        body,
      })
      const res = Object.assign(new EventEmitter(), {
        headersSent: false,
        statusCode: 0,
        writableEnded: false,
        headers: {},
        setHeader(key, value) {
          this.headers[key] = value
        },
        chunks: [],
        write(chunk) {
          this.chunks.push(chunk)
          return true
        },
        end() {
          this.writableEnded = true
        },
      })
      clients.set(id, req)
      await handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')
      return res
    },
    close() {
      if (crag) {
        clearRustHealthCache(vm.id)
        if (previousKernelBin === undefined) delete process.env.KIN_KERNEL_BIN
        else process.env.KIN_KERNEL_BIN = previousKernelBin
      }
      sticky.db.close()
      thinkingDb.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

test('upstream HTTP and SSE pool errors cannot supply the scheduler subagent reason', () => {
  const h = harness()
  try {
    const body = {
      type: 'error',
      error: { type: 'overloaded_error', code: 'pool_overloaded', details: { reason: 'subagent_limit' } },
    }
    const mapped = h.mapClientError({ status: 529, via: 'pool-failover', body })
    assert.equal(mapped.status, 529)
    const remap = createAnthropicSseErrorRemapper()
    remap.remapLine('event: error')
    const event = JSON.parse(remap.remapLine(`data: ${JSON.stringify(body)}`).slice(5))
    assert.equal(event.error.code, 'pool_overloaded')
    const converted = responsesSseToAnthropicEvents(`data: ${JSON.stringify(body)}`)
    const responsesError = JSON.parse(converted.split('data: ')[1]).error
    assert.equal(responsesError.code, 'pool_overloaded')
    assert.deepEqual(
      [mapped.body.error.details, event.error.details, responsesError.details],
      [undefined, undefined, undefined],
    )
  } finally {
    h.close()
  }
})

for (const summaryFirst of [false, true]) {
  test(`CRAG summary cannot consume its parent's tool result (summary first: ${summaryFirst})`, async () => {
    const h = harness({ crag: true })
    const summaryBody = agentBody({ summary: true })
    const before = structuredClone(summaryBody)
    let parent
    try {
      if (summaryFirst) {
        const response = await h.invoke('summary', summaryBody)
        assert.equal(response.statusCode, 200, JSON.stringify(response.body))
      }
      parent = h.invoke('parent')
      await Promise.race([
        h.parentStarted.promise,
        parent.then((response) => {
          throw new Error(JSON.stringify(response.body))
        }),
      ])
      if (!summaryFirst) {
        const response = await h.invoke('summary', summaryBody)
        assert.equal(response.statusCode, 200, JSON.stringify(response.body))
      }
      const side = h.calls.find((call) => call.id === 'summary').body
      const main = h.calls.find((call) => call.id === 'parent').body
      const sideUser = side.messages.findLast((message) => message.role === 'user')
      const mainUser = main.messages.findLast((message) => message.role === 'user')
      assert.equal(
        sideUser.content.some((block) => block.type === 'tool_result'),
        false,
      )
      assert.ok(sideUser.content.some((block) => block.type === 'text' && block.text.includes('File written.')))
      assert.deepEqual(sideUser.content.at(-1), before.messages[2].content.at(-1))
      assert.equal(mainUser.content[0].type, 'tool_result')
      assert.equal(mainUser.content[0].tool_use_id, 'test-tool')
      assert.deepEqual(side.messages.slice(0, 1), main.messages.slice(0, 1))
      assert.equal(
        side.messages[1].content.some((block) => block.type === 'tool_use'),
        false,
      )
      assert.equal(main.messages[1].content[0].type, 'tool_use')
      assert.deepEqual(summaryBody, before)
      h.parentGate.resolve()
      assert.equal((await parent).statusCode, 200)
    } finally {
      h.parentGate.resolve()
      if (parent) await parent
      h.close()
    }
  })
}

for (const mode of ['rebuild', 'passthrough']) {
  test(`agent summary executes beside its blocked parent with isolated seat and outbound identity (${mode})`, async () => {
    const h = harness({ mode, agentId: 'writer-agent' })
    const parent = h.invoke('parent')
    let followup
    try {
      await Promise.race([
        h.parentStarted.promise,
        parent.then((res) => {
          throw new Error(JSON.stringify({ body: res.body, requests: h.requests.length, calls: h.calls.length }))
        }),
      ])
      // A normal follow-up remains serialized even while a summary can run.
      followup = h.invoke('followup')
      const summary = await h.invoke('summary', agentBody({ summary: true, previous: 'Reading coverage.ts' }))
      assert.equal(summary.statusCode, 200, JSON.stringify(summary.body))
      assert.deepEqual(
        h.calls.map((call) => call.id),
        ['parent', 'summary'],
      )
      const main = h.calls[0]
      const side = h.calls[1]
      assert.equal(side.candidate.vmId, main.candidate.vmId)
      assert.notEqual(side.candidate.slotIndex, main.candidate.slotIndex)
      assert.notEqual(sessionIdFromOutboundBody(side.body), sessionIdFromOutboundBody(main.body))
      assert.notEqual(sessionIdFromOutboundBody(side.body), h.parentSession)
      assert.equal(side.body.model, main.body.model)
      const opts = h.requests.find((request) => request.requestId === 'summary')
      assert.equal(opts.stickyKey, null)
      assert.deepEqual(opts.stickyKeys, [])
      assert.equal(opts.familyKey, null)
      assert.equal(opts.skipSessionSeat, false)
      assert.equal(h.rt.activeCount(), 1, 'summary releases only its own lease')
      assert.equal(h.pool.inflight.get('account-1'), 1)
      // Later summaries also get fresh execution identities, not the main pin.
      assert.equal((await h.invoke('summary-2', agentBody({ summary: true }))).statusCode, 200)
      assert.notEqual(sessionIdFromOutboundBody(h.calls[2].body), sessionIdFromOutboundBody(side.body))
    } finally {
      h.parentGate.resolve()
      await parent
      if (followup) await followup
      h.close()
    }
    assert.equal(h.calls.at(-1).id, 'followup')
    assert.equal(h.rt.activeCount(), 0)
    assert.equal(h.runner.sessionTails, undefined)
  })
}

test('summary still waits for actual VM capacity instead of bypassing admission', async () => {
  const h = harness({ capacity: 1 })
  const parent = h.invoke('parent')
  let summary
  try {
    await Promise.race([
      h.parentStarted.promise,
      parent.then((res) => {
        throw new Error(JSON.stringify({ body: res.body, requests: h.requests.length, calls: h.calls.length }))
      }),
    ])
    summary = h.invoke('summary', agentBody({ summary: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(
      h.calls.map((call) => call.id),
      ['parent'],
    )
    assert.equal(h.pool.inflight.get('account-1'), 1)
    h.parentGate.resolve()
    assert.equal((await parent).statusCode, 200)
    assert.equal((await summary).statusCode, 200)
    assert.deepEqual(
      h.calls.map((call) => call.id),
      ['parent', 'summary'],
    )
    assert.equal(h.rt.activeCount(), 0)
  } finally {
    h.parentGate.resolve()
    await parent
    if (summary) await summary
    h.close()
  }
})

test('cancelling a queued summary removes its ticket without releasing the parent seat', async () => {
  const h = harness({ capacity: 1 })
  const parent = h.invoke('parent')
  let summary
  try {
    await Promise.race([
      h.parentStarted.promise,
      parent.then((res) => {
        throw new Error(JSON.stringify(res.body))
      }),
    ])
    summary = h.invoke('summary', agentBody({ summary: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(h.rt.queuedCount(), 1)
    h.clients.get('summary').emit('aborted')
    await summary
    assert.equal(h.rt.queuedCount(), 0)
    assert.equal(h.rt.activeCount(), 1)
    assert.equal(h.pool.inflight.get('account-1'), 1)
    assert.deepEqual(
      h.calls.map((call) => call.id),
      ['parent'],
    )
  } finally {
    h.parentGate.resolve()
    await parent
    if (summary) await summary
    h.close()
  }
})

// 'foreign_only' keeps an unrecorded signature: only a block recorded against
// another account is dropped, so this case must behave like the off setting.
for (const setting of [false, true, 'foreign_only']) {
  const drops = setting === true
  test(`CRAG print ${drops ? 'drops' : 'keeps'} unrecorded thinking when crag_drop_foreign_thinking is ${setting}`, async () => {
    const h = harness({ crag: true, compatibility: { crag_drop_foreign_thinking: setting } })
    const body = agentBody()
    body.messages = [
      { role: 'user', content: 'First question.' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'from another account', signature: 'sig-never-recorded-0123456789abcd' },
          { type: 'text', text: 'First answer.' },
        ],
      },
      { role: 'user', content: 'Second question.' },
    ]
    try {
      const response = await h.invoke('foreign', body)
      assert.equal(response.statusCode, 200, JSON.stringify(response.body))
      const sent = h.calls.find((call) => call.id === 'foreign').body
      const turn = sent.messages.find((message) => message.role === 'assistant')
      const types = turn.content.map((block) => block.type)
      assert.equal(types.includes('thinking'), !drops, JSON.stringify(turn.content))
      assert.ok(turn.content.some((block) => block.type === 'text' && block.text === 'First answer.'))
    } finally {
      h.close()
    }
  })
}
