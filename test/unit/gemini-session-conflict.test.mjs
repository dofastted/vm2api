import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { mapCragWorkerError } from '../../src/lib/gemini/direct-client.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { NATIVE_TUI_CAPABILITIES } from '../../src/lib/protocol/gemini-convert.mjs'
import { SchedulerApiError } from '../../src/lib/transport/scheduler-client.mjs'

const OAUTH_ENV = {
  id: 'env-sticky-a',
  proxy_id: 'proxy-a',
  auth_state: 'authorized',
  auth_method: 'oauth',
  models_discovered: true,
  models: ['gemini-3-pro'],
  capabilities: [...NATIVE_TUI_CAPABILITIES],
}

function jsonInferError(statusCode, body) {
  const stream = new Readable({ read() {} })
  stream.statusCode = statusCode
  stream.headers = { 'content-type': 'application/json' }
  process.nextTick(() => {
    stream.push(JSON.stringify(body))
    stream.push(null)
  })
  return stream
}

function sseOk(text) {
  const stream = new Readable({ read() {} })
  stream.statusCode = 200
  stream.headers = { 'content-type': 'text/event-stream; charset=utf-8' }
  process.nextTick(() => {
    stream.push(
      `data: ${JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
      })}\n\n`,
    )
    stream.push(null)
  })
  return stream
}

const TOOL_CONT_CONV = 'conv_tool_cont_stuck_42'
const TOOL_CONT_CALL = 'call_tool_cont_probe_1'

function sseAwaitingToolCall(convId = TOOL_CONT_CONV, callId = TOOL_CONT_CALL) {
  const stream = new Readable({ read() {} })
  stream.statusCode = 200
  stream.headers = { 'content-type': 'text/event-stream; charset=utf-8' }
  process.nextTick(() => {
    stream.push(
      `data: ${JSON.stringify({
        craggeminiMeta: { conversation_id: convId, awaiting_tool_results: true },
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { id: callId, name: 'probe_tool', args: {} } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
      })}\n\n`,
    )
    stream.push(null)
  })
  return stream
}

function makeCircuitPool() {
  const calls = { success: [], failure: [], probe: [] }
  const accountId = `gemini:${OAUTH_ENV.id}`
  const pool = {
    unitCircuit: {
      recordSuccess: (id) => calls.success.push(id),
      recordFailure: (id) => calls.failure.push(id),
      releaseProbe: (id) => calls.probe.push(id),
    },
    lastUsed: new Map(),
    reserveExternalCandidates(candidates, { excluded }) {
      const found = candidates.find((c) => !excluded.has(c.accountId))
      if (!found) return null
      return { selected: found, reservation: { release() {} } }
    },
  }
  return { pool, accountId, calls }
}

function makeMockGeminiRuntime() {
  let seq = 0
  return {
    async acquireNode(params) {
      const excluded = new Set(params.excludeNodes || [])
      const allowed = Array.isArray(params.allowedNodeKeys) ? params.allowedNodeKeys : []
      const key = allowed.find((k) => !excluded.has(k))
      if (!key) {
        throw new SchedulerApiError({
          status: 429,
          code: 'pool_exhausted',
          message: 'No gemini environment available',
          retryAfterSec: 5,
        })
      }
      const id = key.split(':').slice(1).join(':')
      return {
        lease_id: `gem-lease-${++seq}`,
        lease_ttl_ms: 30_000,
        resolved_pool_id: params.originPoolId || '__default_gemini__',
        selected_node: { node_type: 'gemini_env', node_id: id, node_key: key },
        explain: { affinity: { why: 'balanced' } },
      }
    },
    async switchNode(body) {
      return this.acquireNode(body.next_attempt || {})
    },
    async commitLease() {},
    async releaseLease() {},
  }
}

function hostStub(environments, inferHandler) {
  return {
    schedulerRuntime: makeMockGeminiRuntime(),
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments }
      if (op === 'get') {
        return { id: payload.id, proxy_id: payload.id === OAUTH_ENV.id ? 'proxy-a' : 'proxy-b', auth_method: 'oauth' }
      }
      if (op === 'infer-cancel') return { cancelled: true }
      throw new Error(`unexpected op: ${op}`)
    },
    callHostStream: inferHandler,
    resolveProxy: () => 'socks5h://127.0.0.1:1080',
    getRoutingConfig: () => ({
      gemini: {
        sticky: { enabled: true, ttl_seconds: 3600 },
        pool: { strategy: 'balanced', max_concurrency_per_account: 4, timeout_ms: 120_000 },
        failover: { max_account_switches: 3 },
      },
    }),
  }
}

test('mapCragWorkerError maps upstream 403 by upstream_reason (TOS, region, bare)', () => {
  const tos = mapCragWorkerError(502, {
    code: 'upstream_http',
    upstream_status: 403,
    upstream_reason: 'TOS_VIOLATION',
  })
  assert.equal(tos.code, 'gemini_account_ineligible')
  assert.equal(tos.status, 403)

  const region = mapCragWorkerError(502, {
    code: 'upstream_http',
    upstream_status: 403,
    upstream_reason: 'UNSUPPORTED_REGION',
  })
  assert.equal(region.code, 'gemini_location_unsupported')

  const bare = mapCragWorkerError(502, { code: 'upstream_http', upstream_status: 403 })
  assert.equal(bare.code, 'gemini_location_unsupported')

  const multi = mapCragWorkerError(502, {
    code: 'upstream_http',
    upstream_status: 403,
    message: '403 UNSUPPORTED_REGION and TOS_VIOLATION',
  })
  assert.equal(multi.code, 'gemini_account_ineligible')
})

test('mapCragWorkerError maps tool_continuation_aborted to gemini_session_conflict (409)', () => {
  const mapped = mapCragWorkerError(409, {
    code: 'tool_continuation_aborted',
    error: 'suspended tool slot cannot accept prompt turn',
    upstream_status: 409,
  })
  assert.equal(mapped.code, 'gemini_session_conflict')
  assert.equal(mapped.status, 409)
  assert.equal(mapped.upstreamStatus, 409)
})

test('gemini_session_conflict does not increment unit circuit failures', async () => {
  const { pool, accountId, calls } = makeCircuitPool()
  const inferCalls = []
  let attempt = 0

  const scheduler = createGeminiScheduler({
    ...hostStub([OAUTH_ENV], async (_op, payload) => {
      inferCalls.push(payload)
      attempt += 1
      if (attempt === 1) {
        return jsonInferError(409, { code: 'tool_continuation_aborted', message: 'aborted', error: 'aborted' })
      }
      return sseOk('recovered marker')
    }),
    poolScheduler: pool,
  })

  const turn = await scheduler.stream({
    model: 'gemini-3-pro',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'continue after tool' }] }] },
    stickyKey: 'key:test:session-409',
    apiKeyRecord: { id: 'key-test', group_type: 'gemini' },
  })

  assert.equal(turn.text, 'recovered marker')
  assert.equal(inferCalls.length, 2)
  assert.deepEqual(calls.failure, [])
  assert.equal(calls.probe.length, 1)
  assert.equal(calls.probe[0], accountId)
  assert.equal(turn.attempt_count, 2)
})

test('gemini_session_conflict retries on same account with fresh conversation_id, without account switch', async () => {
  const envB = { ...OAUTH_ENV, id: 'env-sticky-b', proxy_id: 'proxy-b' }
  const inferCalls = []
  let attempt = 0

  const scheduler = createGeminiScheduler({
    ...hostStub([OAUTH_ENV, envB], async (_op, payload) => {
      inferCalls.push({ id: payload.id, convId: payload.body?.conversation_id })
      attempt += 1
      if (attempt === 1) {
        return jsonInferError(409, { code: 'tool_continuation_aborted', error: 'aborted' })
      }
      return sseOk('OK409')
    }),
  })

  const sticky = 'key:test:paired-1837'
  const turn = await scheduler.stream({
    model: 'gemini-3-pro',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'print marker' }] }] },
    stickyKey: sticky,
    apiKeyRecord: { id: 'key-test', group_type: 'gemini' },
  })

  assert.equal(turn.text, 'OK409')
  assert.equal(inferCalls.length, 2)
  assert.equal(inferCalls[0].id, OAUTH_ENV.id)
  assert.equal(inferCalls[1].id, OAUTH_ENV.id, 'session conflict retry must stay on the same account')
  assert.ok(inferCalls[0].convId)
  assert.ok(inferCalls[1].convId)
  assert.notEqual(inferCalls[1].convId, inferCalls[0].convId, 'retry must mint a fresh outbound conversation_id')
  assert.equal(turn.attempts?.[0]?.action, 'session_retry')
})

test('gemini_session_conflict on tool continuation retries with new conv (mas=3)', async () => {
  const inferCalls = []
  let inferNo = 0

  const scheduler = createGeminiScheduler({
    ...hostStub([OAUTH_ENV], async (_op, payload) => {
      inferNo += 1
      inferCalls.push({ n: inferNo, convId: payload.body?.conversation_id })
      if (inferNo === 1) return sseAwaitingToolCall()
      if (inferNo === 2) {
        return jsonInferError(409, { code: 'tool_continuation_aborted', error: 'aborted' })
      }
      return sseOk('continuation recovered')
    }),
  })

  const apiKey = { id: 'key-test', group_type: 'gemini' }
  const userBody = { contents: [{ role: 'user', parts: [{ text: 'after tool' }] }] }

  await scheduler.stream({
    model: 'gemini-3-pro',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'emit tool' }] }] },
    stickyKey: 'key:test:tool-cont-mas3',
    apiKeyRecord: apiKey,
  })

  const turn = await scheduler.stream({
    model: 'gemini-3-pro',
    geminiBody: userBody,
    stickyKey: 'key:test:tool-cont-mas3',
    continuationCallIds: [TOOL_CONT_CALL],
    apiKeyRecord: apiKey,
  })

  assert.equal(turn.text, 'continuation recovered')
  assert.equal(inferCalls.length, 3)
  assert.equal(inferCalls[1].convId, TOOL_CONT_CONV)
  assert.notEqual(inferCalls[2].convId, TOOL_CONT_CONV, 'session conflict retry must not reuse continuation conv id')
})

test('gemini_session_conflict on tool continuation clears binding when mas=0', async () => {
  const inferCalls = []
  let inferNo = 0

  const scheduler = createGeminiScheduler({
    ...hostStub([OAUTH_ENV], async (_op, payload) => {
      inferNo += 1
      inferCalls.push({ convId: payload.body?.conversation_id })
      if (inferNo === 1) return sseAwaitingToolCall()
      if (inferNo === 2) {
        return jsonInferError(409, { code: 'tool_continuation_aborted', error: 'aborted' })
      }
      return sseOk('fresh binding')
    }),
    getRoutingConfig: () => ({
      gemini: {
        sticky: { enabled: true, ttl_seconds: 3600 },
        pool: { strategy: 'balanced', max_concurrency_per_account: 4, timeout_ms: 120_000 },
        failover: { max_account_switches: 0 },
      },
    }),
  })

  const apiKey = { id: 'key-test', group_type: 'gemini' }
  const userBody = { contents: [{ role: 'user', parts: [{ text: 'after tool' }] }] }

  await scheduler.stream({
    model: 'gemini-3-pro',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'emit tool' }] }] },
    stickyKey: 'key:test:tool-cont-mas0',
    apiKeyRecord: apiKey,
  })

  try {
    await scheduler.stream({
      model: 'gemini-3-pro',
      geminiBody: userBody,
      stickyKey: 'key:test:tool-cont-mas0',
      continuationCallIds: [TOOL_CONT_CALL],
      apiKeyRecord: apiKey,
    })
    assert.fail('expected gemini_session_conflict')
  } catch (err) {
    assert.equal(err.code, 'gemini_session_conflict')
    assert.equal(err.attemptCount, 1)
  }
  assert.equal(inferCalls[1].convId, TOOL_CONT_CONV)

  const third = await scheduler.stream({
    model: 'gemini-3-pro',
    geminiBody: userBody,
    stickyKey: 'key:test:tool-cont-mas0',
    continuationCallIds: [TOOL_CONT_CALL],
    apiKeyRecord: apiKey,
  })
  assert.equal(third.text, 'fresh binding')
  assert.notEqual(inferCalls[2].convId, TOOL_CONT_CONV, 'cleared tool continuation must not reuse stuck conv id')
})

test('gemini_session_conflict clears sticky when max_account_switches is 0 (no retry)', async () => {
  const inferCalls = []
  let attempt = 0
  const sticky = 'key:test:mas0-sticky-clear'

  const scheduler = createGeminiScheduler({
    ...hostStub([OAUTH_ENV], async (_op, payload) => {
      inferCalls.push({ convId: payload.body?.conversation_id })
      attempt += 1
      if (attempt === 1) return sseOk('seed sticky')
      if (attempt === 2) {
        return jsonInferError(409, { code: 'tool_continuation_aborted', error: 'aborted' })
      }
      return sseOk('after clear')
    }),
    getRoutingConfig: () => ({
      gemini: {
        sticky: { enabled: true, ttl_seconds: 3600 },
        pool: { strategy: 'balanced', max_concurrency_per_account: 4, timeout_ms: 120_000 },
        failover: { max_account_switches: 0 },
      },
    }),
  })

  const apiKey = { id: 'key-test', group_type: 'gemini' }
  const body = { contents: [{ role: 'user', parts: [{ text: 'x' }] }] }

  const first = await scheduler.stream({
    model: 'gemini-3-pro',
    geminiBody: body,
    stickyKey: sticky,
    apiKeyRecord: apiKey,
  })
  assert.equal(first.text, 'seed sticky')
  const boundConv = inferCalls[0].convId
  assert.ok(boundConv)

  try {
    await scheduler.stream({
      model: 'gemini-3-pro',
      geminiBody: body,
      stickyKey: sticky,
      apiKeyRecord: apiKey,
    })
    assert.fail('expected gemini_session_conflict')
  } catch (err) {
    assert.equal(err.code, 'gemini_session_conflict')
    assert.equal(err.attemptCount, 1)
  }
  assert.equal(inferCalls[1].convId, boundConv)

  const third = await scheduler.stream({
    model: 'gemini-3-pro',
    geminiBody: body,
    stickyKey: sticky,
    apiKeyRecord: apiKey,
  })
  assert.equal(third.text, 'after clear')
  assert.notEqual(inferCalls[2].convId, boundConv, 'sticky clear must drop bound conversation after session conflict')
})

test('gemini_session_conflict is only retried once (no infinite retry)', async () => {
  const inferCalls = []

  const scheduler = createGeminiScheduler({
    ...hostStub([OAUTH_ENV], async (_op, payload) => {
      inferCalls.push(payload.id)
      return jsonInferError(409, { code: 'tool_continuation_aborted', error: 'aborted' })
    }),
  })

  try {
    await scheduler.stream({
      model: 'gemini-3-pro',
      geminiBody: { contents: [{ role: 'user', parts: [{ text: 'fail twice' }] }] },
      stickyKey: 'key:test:no-infinite',
      apiKeyRecord: { id: 'key-test', group_type: 'gemini' },
    })
    assert.fail('expected gemini_session_conflict')
  } catch (err) {
    assert.equal(err.code, 'gemini_session_conflict')
    assert.equal(err.status, 409)
    assert.equal(err.attemptCount, 2)
  }
  assert.equal(inferCalls.length, 2)
  assert.equal(inferCalls[0], inferCalls[1])
})
