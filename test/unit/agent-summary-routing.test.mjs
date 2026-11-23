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
import { agentBody, summaryInstruction } from '../fixtures/agent-summary.mjs'
import { createAnthropicSseErrorRemapper } from '../../src/lib/protocol/stream-truncation.mjs'
import { responsesSseToAnthropicEvents } from '../../src/lib/protocol/codex-convert.mjs'
import { clearRustHealthCache, rememberRustHealth } from '../../src/lib/transport/kernel-router.mjs'

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
  const pool = new PoolScheduler({ projectRoot: root, stickyRouter: sticky, config: poolConfig })
  // Only discovery/health are simulated. The seat planner, reservations,
  // session queue, sticky writes and outbound preparation are the real ones.
  const vm = { id: 'vm-01', fingerprint: {}, claude: { account_tier: 'max' } }
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify(vm))
  const previousKernelBin = process.env.KIN_KERNEL_BIN
  if (crag) {
    process.env.KIN_KERNEL_BIN = '/bin/true'
    rememberRustHealth(
      { vmId: vm.id },
      { ok: true, health: { ok: true, runtime_variant: 'crag-v2', ready_slots: 2, capabilities: ['prompt_append'] } },
    )
  }
  pool.eligibleCandidates = async ({ model, excluded }) =>
    excluded.has('account-1')
      ? []
      : [
          {
            ok: true,
            vmId: vm.id,
            accountId: 'account-1',
            vm,
            model,
            priority: 1,
            draining: false,
            exec: { vmId: vm.id, homeDir: root, vm },
            seatCap: capacity,
            maxConcurrency: capacity,
            headroom: null,
            inflight: pool.inflight.get('account-1') || 0,
            loadRatio: (pool.inflight.get('account-1') || 0) / capacity,
            busy: false,
          },
        ]
  // Reserve re-reads the VM record, proxy and worker health (#795); that is discovery too.
  // Concurrency, seats and quota below stay real.
  pool.admissionSnapshot = () => ({ account: null })
  const runner = new FailoverRunner({
    scheduler: pool,
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
    failoverRunner: {
      run(opts) {
        requests.push(opts)
        return runner.run({
          ...opts,
          callAttempt: async (call) => {
            calls.push({ id: opts.requestId, ...call })
            if (crag) {
              // CRAG claims by tool ID, even when the gateway gives a fork a new session ID.
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
    ...(agentId ? { 'x-claude-code-agent-id': agentId } : {}),
  }
  const parentSession = extractCallerSession({ inbound: agentBody(), headers })
  return {
    sticky,
    routing,
    pool,
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
    },
  }
}

function singleTurnSummary(metadata) {
  return {
    ...agentBody({ summary: true }),
    metadata,
    model: 'claude-haiku-4-5',
    tools: [],
    system: 'x-anthropic-billing-header: test. You are Claude Code.',
    messages: [{ role: 'user', content: summaryInstruction() }],
  }
}

test('messages and agent summaries return the family 529; probes bypass m', async () => {
  const h = harness({ poolConfig: { max_subagents_per_session: 0, max_primary_sessions: 2 } })
  h.pool.config.sticky_wait_timeout_ms = 40
  const body = agentBody()
  body.metadata.user_id = JSON.stringify({ device_id: 'machine-1', account_uuid: '', session_id: 'root' })
  const agent = { 'x-claude-code-agent-id': 'agent', 'x-claude-code-parent-agent-id': 'parent-agent' }
  try {
    assert.equal((await h.invoke('root', body)).statusCode, 200)
    const response = await h.invoke('nested', body, agent)
    assert.equal(response.statusCode, 529, JSON.stringify(response.body))
    assert.equal(response.body.error.code, 'pool_overloaded')
    assert.equal(response.body.error.type, 'overloaded_error')
    assert.deepEqual(response.body.error.details, { reason: 'subagent_limit' })
    assert.ok(Number(response.headers['retry-after']) >= 1)
    h.routing.failover.queue_keepalive_delay_ms = 1
    const stream = await h.invoke('stream', { ...body, stream: true }, agent)
    const event = stream.chunks.find((chunk) => chunk.startsWith('event: error'))
    assert.ok(event)
    assert.deepEqual(JSON.parse(event.split('data: ')[1]).error.details, { reason: 'subagent_limit' })
    const summary = { ...agentBody({ summary: true }), metadata: body.metadata }
    const denied = await h.invoke('summary', summary, agent)
    assert.equal(denied.statusCode, 529)
    assert.equal(denied.body.error.details.reason, 'subagent_limit')
    const short = await h.invoke('companion-shaped-summary', singleTurnSummary(body.metadata), agent)
    assert.ok(h.requests.at(-1).summarySession)
    assert.equal(h.requests.at(-1).skipSessionSeat, true)
    assert.equal(short.body.error.details.reason, 'subagent_limit')
    const probe = { ...body, tools: [], messages: [{ role: 'user', content: 'hello' }] }
    assert.equal((await h.invoke('probe', probe, agent)).statusCode, 200)
    assert.deepEqual(
      h.requests.map((r) => r.rootSessionId),
      [null, 'root', 'root', 'root', 'root', null],
    )
    assert.deepEqual(h.pool.seatSnapshot().seats, {})
  } finally {
    h.close()
  }
})

test('an agent summary with a forwarded session header or body key shares the root limit', async () => {
  const h = harness({ poolConfig: { max_subagents_per_session: 0 } })
  try {
    assert.equal((await h.invoke('root')).statusCode, 200)
    const summary = {
      ...agentBody({ summary: true }),
      metadata: {},
      system: 'x-anthropic-billing-header: cc_entrypoint=cli;',
    }
    for (const [fields, headers] of [
      [{}, { 'x-session-id': 'test-parent' }],
      [{ conversation_id: 'test-parent' }, {}],
    ]) {
      const res = await h.invoke(
        'summary',
        { ...summary, ...fields },
        { 'x-claude-code-agent-id': 'one', 'x-kin-queue': 'off', ...headers },
      )
      assert.ok(h.requests.at(-1).summarySession)
      assert.equal(h.requests.at(-1).stickyKey, null)
      assert.equal(res.statusCode, 529)
      assert.deepEqual(res.body.error.details, { reason: 'subagent_limit' })
    }
    assert.equal(h.calls.length, 1)
    assert.deepEqual(h.pool.seatSnapshot().seats, {})
  } finally {
    h.close()
  }
})

test('a one-turn Haiku summary needs an independent seat when its root VM is unavailable', async () => {
  const h = harness({ capacity: 4, poolConfig: { max_primary_sessions: 1, max_subagents_per_session: 1 } })
  try {
    assert.equal((await h.invoke('root')).statusCode, 200)
    const [home] = await h.pool.eligibleCandidates({ excluded: new Set() })
    const other = { ...home, vmId: 'vm-02', accountId: 'account-2', vm: { ...home.vm, id: 'vm-02' } }
    other.exec = { ...home.exec, vmId: other.vmId, vm: other.vm }
    h.pool.eligibleCandidates = async ({ onlyVmIds, excluded }) =>
      (onlyVmIds && !onlyVmIds.has(other.vmId)) || excluded?.has(other.vmId) || excluded?.has(other.accountId)
        ? []
        : [other]
    const blocker = await h.pool.selectAndReserve({ seatKey: 'seat:sess:blocker' })
    const summary = singleTurnSummary(agentBody().metadata)
    const invoke = () => h.invoke('summary', summary, { 'x-kin-queue': 'off' })
    const full = await invoke()
    blocker.release()
    assert.equal(full.statusCode, 529)
    assert.equal(h.calls.length, 1)
    assert.equal((await invoke()).statusCode, 200)
    const opts = h.requests.at(-1)
    const { candidate } = h.calls.at(-1)
    assert.ok(opts.summarySession)
    assert.equal(opts.stickyKey, null)
    assert.equal(candidate.selectionReason, 'subagent-fallback')
    assert.equal(candidate.seatKey, `platform|seat:sess:${opts.summarySession}`)
    assert.deepEqual([...h.pool.planner.roots.keys()], ['platform|seat:sess:test-parent', 'platform|seat:sess:blocker'])
    assert.deepEqual(h.pool.seatSnapshot().seats, {})
  } finally {
    h.close()
  }
})

test('a one-turn Haiku summary without a registered root takes its own seat only in family mode', async () => {
  for (const m of [1, null]) {
    const h = harness({ capacity: 4, poolConfig: { max_primary_sessions: 1, max_subagents_per_session: m } })
    try {
      const blocker = await h.pool.selectAndReserve({ seatKey: 'seat:sess:blocker' })
      const body = singleTurnSummary(agentBody().metadata)
      const invoke = () => h.invoke('summary', body, { 'x-kin-queue': 'off' })
      const full = await invoke()
      blocker.release()
      assert.equal(full.statusCode, m === null ? 200 : 529)
      if (m !== null) {
        assert.equal(full.body.error.code, 'pool_overloaded')
        assert.ok(Number(full.headers['retry-after']) >= 1)
        assert.equal(h.calls.length, 0)
      }
      assert.equal((await invoke()).statusCode, 200)
      const { summarySession, stickyKey } = h.requests.at(-1)
      assert.ok(summarySession)
      assert.equal(stickyKey, null)
      assert.equal(h.calls.at(-1).candidate.seatKey, m === null ? undefined : `platform|seat:sess:${summarySession}`)
      assert.equal(h.pool.planner.rootVm(`platform|seat:sess:${summarySession}`), null)
      assert.deepEqual(h.pool.seatSnapshot().seats, {})
    } finally {
      h.close()
    }
  }
})

test('an orphan Haiku summary uses an idle legacy VM when its device home has no free seat', async () => {
  const h = harness({ capacity: 1, poolConfig: { max_primary_sessions: 1 } })
  try {
    const [a] = await h.pool.eligibleCandidates({ excluded: new Set() })
    a.vm.policy = { maxSubagentsPerSessionOverride: true, maxSubagentsPerSession: 1 }
    const deviceKey = h.sticky.canonicalDeviceKey('test-device')
    const blocker = await h.pool.selectAndReserve({ seatKey: 'seat:sess:blocker', deviceKey })
    assert.equal(h.pool.machineHome(deviceKey), a.vmId)
    const vm = { ...a.vm, id: 'vm-02', policy: {} }
    const b = { ...a, vm, vmId: vm.id, accountId: 'account-2', exec: { ...a.exec, vm, vmId: vm.id } }
    h.pool.eligibleCandidates = async ({ model, excluded, onlyVmIds }) =>
      [a, b]
        .filter((c) => !excluded.has(c.accountId) && !excluded.has(c.vmId) && (!onlyVmIds || onlyVmIds.has(c.vmId)))
        .map((c) => ({ ...c, model }))

    const body = singleTurnSummary({
      user_id: JSON.stringify({ device_id: 'test-device', account_uuid: '', session_id: 'unknown' }),
    })
    const res = await h.invoke('summary', body, { 'x-kin-queue': 'off' })
    blocker.release()
    const opts = h.requests.at(-1)
    assert.ok(opts.summarySession)
    assert.equal(opts.stickyKey, null)
    assert.equal(opts.deviceKey, deviceKey)
    assert.equal(res.statusCode, 200)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].candidate.vmId, b.vmId)
    assert.equal(h.calls[0].candidate.seatKey, undefined)
    assert.deepEqual(h.pool.seatSnapshot().seats, {})
  } finally {
    h.close()
  }
})

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

test('summaries with and without an agent id execute beside the active parent at n=1', async () => {
  const h = harness({ capacity: 4, poolConfig: { max_primary_sessions: 1, max_subagents_per_session: 1 } })
  const parent = h.invoke('parent')
  try {
    await Promise.race([
      h.parentStarted.promise,
      parent.then((res) => {
        throw new Error(JSON.stringify(res.body))
      }),
    ])
    for (const headers of [{}, { 'x-claude-code-agent-id': 'nested' }]) {
      const response = await h.invoke('summary', agentBody({ summary: true }), headers)
      assert.equal(response.statusCode, 200)
      const call = h.calls.at(-1)
      assert.equal(call.candidate.selectionReason, 'subagent')
      assert.equal(call.candidate.seatKey, h.calls[0].candidate.seatKey)
      assert.notEqual(sessionIdFromOutboundBody(call.body), sessionIdFromOutboundBody(h.calls[0].body))
      assert.equal(h.requests.at(-1).stickyKey, null)
      assert.equal(h.pool.planner.openCount('vm-01'), 1)
    }
  } finally {
    h.parentGate.resolve()
    await parent
    h.close()
  }
})

test('parent-only hints are ordinary sessions; explicit roots and CC agents join the root', async () => {
  const h = harness({ capacity: 4, poolConfig: { max_primary_sessions: 2, max_subagents_per_session: 1 } })
  const root = agentBody()
  const request = agentBody()
  request.metadata.user_id = JSON.stringify({ device_id: 'device', account_uuid: '', session_id: 'other' })
  try {
    assert.equal((await h.invoke('root', root)).statusCode, 200)
    for (const [meta, headers, reason] of [
      [{ parent_session_id: 'test-parent' }, {}, false],
      [{}, { 'x-kin-parent-session': 'test-parent' }, false],
      [{ root_session_id: 'test-parent' }, {}, true],
      [{}, { 'x-kin-root-session': 'test-parent' }, true],
    ]) {
      const response = await h.invoke('relation', { ...request, metadata: { ...request.metadata, ...meta } }, headers)
      assert.equal(response.statusCode, 200)
      assert.equal(!!h.calls.at(-1).candidate.isSubagent, reason)
    }
    const headerOnly = await h.invoke(
      'cc-header-only',
      { ...request, metadata: {} },
      { 'x-claude-code-agent-id': 'one', 'x-session-id': 'test-parent' },
    )
    assert.equal(headerOnly.statusCode, 200)
    assert.equal(h.calls.at(-1).candidate.isSubagent, true)
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
      // The answered call goes read-only with its result: CRAG rejects an unpaired tool_use.
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
      const parentKey = h.sticky.canonicalSessionKey(h.parentSession)
      const before = h.sticky.resolve(parentKey)
      const familyKey = h.sticky.canonicalFamilyKey('test-parent')
      const familyBefore = h.sticky.resolve(familyKey)
      assert.ok(before?.sessionId)
      // A normal follow-up remains serialized even while a summary can run.
      followup = h.invoke('followup')
      const summary = await h.invoke('summary', agentBody({ summary: true, previous: 'Reading coverage.ts' }))
      assert.equal(summary.statusCode, 200, JSON.stringify(summary.body))
      assert.deepEqual(
        h.calls.map((call) => call.id),
        ['parent', 'summary'],
      )
      assert.deepEqual(h.sticky.resolve(parentKey), before)
      assert.deepEqual(h.sticky.resolve(familyKey), familyBefore)
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
      assert.equal(h.pool.planner.openCount('vm-01'), 1, 'summary releases only its own seat')
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
    assert.equal(h.pool.planner.openCount('vm-01'), 0)
    assert.equal(h.runner.sessionTails.size, 0)
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
    assert.equal(h.pool.planner.openCount('vm-01'), 0)
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
    const parentKey = h.sticky.canonicalSessionKey(h.parentSession)
    const before = h.sticky.resolve(parentKey)
    summary = h.invoke('summary', agentBody({ summary: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(h.pool.queuedTotal(), 1)
    h.clients.get('summary').emit('aborted')
    await summary
    assert.equal(h.pool.queuedTotal(), 0)
    assert.equal(h.pool.planner.openCount('vm-01'), 1)
    assert.equal(h.pool.inflight.get('account-1'), 1)
    assert.deepEqual(h.sticky.resolve(parentKey), before)
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

for (const enabled of [false, true]) {
  test(`CRAG print ${enabled ? 'drops' : 'keeps'} unrecorded thinking when crag_drop_foreign_thinking is ${enabled}`, async () => {
    const h = harness({ crag: true, compatibility: { crag_drop_foreign_thinking: enabled } })
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
      assert.equal(types.includes('thinking'), !enabled, JSON.stringify(turn.content))
      assert.ok(turn.content.some((block) => block.type === 'text' && block.text === 'First answer.'))
    } finally {
      h.close()
    }
  })
}
