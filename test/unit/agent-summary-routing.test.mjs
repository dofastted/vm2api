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
import { agentBody } from '../fixtures/agent-summary.mjs'
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

function harness({ mode = 'rebuild', capacity = 2, agentId = '', crag = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-summary-'))
  const routing = { compatibility: {}, failover: {}, sticky: { enabled: true, outbound_session: mode } }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const sticky = new StickyRouter({ dataDir: root, config: routing })
  const pool = new PoolScheduler({ stickyRouter: sticky })
  // Only discovery/health are simulated. The seat planner, reservations,
  // session queue, sticky writes and outbound preparation are the real ones.
  const vm = { id: 'vm-01', fingerprint: {}, claude: { account_tier: 'max' } }
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
            exec: { vmId: vm.id, homeDir: root, vm },
            seatCap: capacity,
            maxConcurrency: capacity,
            headroom: null,
            inflight: pool.inflight.get('account-1') || 0,
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
    pool,
    runner,
    requests,
    calls,
    parentStarted,
    parentGate,
    parentSession,
    clients,
    async invoke(id, body = agentBody()) {
      const req = Object.assign(new EventEmitter(), {
        id,
        method: 'POST',
        url: '/v1/messages',
        headers,
        apiKeyKind: 'master',
        body,
      })
      const res = Object.assign(new EventEmitter(), {
        headersSent: false,
        statusCode: 0,
        writableEnded: false,
        setHeader() {},
        write() {
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
      assert.deepEqual(side.messages.slice(0, 2), main.messages.slice(0, 2))
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
