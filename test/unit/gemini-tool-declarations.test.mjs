import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { sanitizeErrorDetailsForLog } from '../../src/lib/core/errors.mjs'
import { createGeminiPublicHandler } from '../../src/lib/gemini/routes.mjs'
import { createGeminiSlotPrefs } from '../../src/lib/gemini/slot-prefs.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'
import {
  FULL_GEMINI_CAPABILITIES,
  buildGeminiRequest,
  createGeminiCollector,
  createGeminiEventDecoder,
  createGeminiRestoreTransform,
  parseInboundToGemini,
} from '../../src/lib/protocol/gemini-convert.mjs'
import { createSchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'
import { SchedulerApiError } from '../../src/lib/transport/scheduler-client.mjs'
import { createMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'

const model = 'gemini-4-neon-xhigh'
const tools = [{ type: 'function', name: 'known', parameters: { type: 'object', properties: {} } }]
const requestBody = (extra = {}) => ({ model, input: 'synthetic check', tools, ...extra })
const parse = (extra = {}) => parseInboundToGemini('openai-responses', requestBody(extra))
const chunk = (names, extra = {}) => ({
  candidates: [
    {
      content: { role: 'model', parts: names.map((name) => ({ functionCall: { name, args: {} } })) },
      finishReason: 'STOP',
    },
  ],
  ...extra,
})
const frame = (body) => `data: ${JSON.stringify(body)}\n\n`

function restore(ir, body) {
  const decoder = createGeminiEventDecoder()
  const transform = createGeminiRestoreTransform(ir.restoreContext, { target: 'antigravity' })
  const collector = createGeminiCollector()
  decoder.decodeChunk(body, (event) => transform.push(event, (out) => collector.push(out)))
  transform.flush((out) => collector.push(out))
  return collector.result()
}

function fixture({
  frames = [],
  runtime = createMockSchedulerRuntime(),
  bodyReader = readBody,
  requestLog,
  slotPrefs,
  envIds = ['env-validation'],
  poolScheduler,
  attemptsRepo,
  getRoutingConfig,
} = {}) {
  let calls = 0
  const logs = []
  const scheduler = createGeminiScheduler({
    schedulerRuntime: runtime,
    slotPrefs,
    poolScheduler,
    attemptsRepo,
    getRoutingConfig,
    callHost: async (op, args) => {
      const env = {
        id: args?.id || envIds[0],
        proxy_id: 'px',
        auth_method: 'oauth',
        auth_state: 'authorized',
        models_discovered: true,
        models: [model],
        capabilities: [...FULL_GEMINI_CAPABILITIES],
      }
      if (op === 'list') return { payload_state: 'installed', environments: envIds.map((id) => ({ ...env, id })) }
      if (op === 'get') return env
      throw new Error(`unexpected host operation: ${op}`)
    },
    callHostStream: async () => {
      calls++
      return Object.assign(Readable.from(frames), { statusCode: 200, headers: { 'content-type': 'text/event-stream' } })
    },
    resolveProxy: () => 'socks5h://192.0.2.1:1080',
  })
  const handler = createGeminiPublicHandler({
    scheduler,
    readBody: bodyReader,
    json: (res, status, body) => {
      res.statusCode = status
      res.end(JSON.stringify(body))
    },
    requestLog: requestLog || {
      start: () => ({ request_id: `validation-${logs.length}` }),
      finish: (_ctx, log) => logs.push(log),
    },
  })
  return {
    logs,
    scheduler,
    get calls() {
      return calls
    },
    async call(body, { path = '/v1/responses', raw } = {}) {
      const req = Object.assign(raw === undefined ? new EventEmitter() : Readable.from([raw]), {
        method: 'POST',
        url: path,
        body,
        headers: {},
        apiKeyKind: 'managed',
        apiKeyRecord: { id: 'test', group_type: 'gemini' },
      })
      const res = new EventEmitter()
      Object.assign(res, { statusCode: 200, headers: {}, chunks: [], writableEnded: false, headersSent: false })
      res.setHeader = (key, value) => {
        res.headers[key.toLowerCase()] = value
      }
      res.writeHead = (status, headers = {}) => {
        res.statusCode = status
        res.headersSent = true
        Object.assign(res.headers, headers)
      }
      res.write = (data) => {
        res.headersSent = true
        res.chunks.push(String(data))
        return true
      }
      res.end = (data) => {
        if (data) res.write(data)
        res.writableEnded = true
        res.emit('finish')
      }
      await handler(req, res)
      return { status: res.statusCode, headers: res.headers, text: res.chunks.join('') }
    },
  }
}

test('invalid tool constraints fail before dispatch, including an empty Responses allowlist', async () => {
  for (const tool_choice of [
    { type: 'allowed_tools', mode: 'auto', tools: [] },
    { type: 'allowed_tools', mode: 'required', tools: [] },
    { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'missing' }] },
    { type: 'function', name: 'missing' },
  ]) {
    const f = fixture()
    const res = await f.call(requestBody({ tool_choice }))
    assert.equal(res.status, 400)
    assert.equal(JSON.parse(res.text).error.code, 'gemini_invalid_request')
    assert.equal(f.calls, 0)
    assert.equal(f.logs[0].attempt_count, 0)
  }
  assert.throws(
    () =>
      parseInboundToGemini('openai-chat', {
        model,
        messages: [{ role: 'user', content: 'check' }],
        tools: [{ type: 'function', function: { name: 'known' } }],
        tool_choice: { type: 'allowed_tools', allowed_tools: { mode: 'auto', tools: [] } },
      }),
    { status: 400, code: 'gemini_invalid_request' },
  )
})

test('only current declarations authorize emitted calls; history names do not grant tool access', () => {
  for (const tool_choice of ['auto', 'required']) {
    const ir = parse({
      tool_choice,
      input: [
        { type: 'function_call', call_id: 'old-call', name: 'old_tool', arguments: '{}' },
        { type: 'function_call_output', call_id: 'old-call', output: 'done' },
        { role: 'user', content: 'continue' },
      ],
    })
    buildGeminiRequest(ir, { target: 'antigravity' })
    for (const name of ['unknown', 'old_tool']) {
      const result = restore(
        ir,
        chunk([name, 'known'], {
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }),
      )
      assert.equal(result.toolCalls.length, 0)
      assert.equal(result.error?.code, 'gemini_inference_invalid_output')
      assert.equal(result.usage.total_tokens, 15, 'usage survives output validation failure')
    }
  }
  assert.equal(restore(parse({ tools: [] }), chunk(['unknown'])).error?.code, 'gemini_inference_invalid_output')
})

test('valid declared, namespaced and collision-disambiguated tools still round-trip', () => {
  const ir = parse({
    tools: [
      ...tools,
      { type: 'function', name: 'a.b' },
      { type: 'function', name: 'a_b' },
      { type: 'namespace', name: 'ns', tools: [{ type: 'function', name: 'run' }] },
    ],
  })
  const result = restore(ir, chunk(ir.tools.map((t) => `mcp_crag_${t.wireName}`)))
  assert.equal(result.error, null)
  assert.deepEqual(
    result.toolCalls.map((t) => t.name),
    ['known', 'a.b', 'a_b', 'run'],
  )
  const forced = parse({ tool_choice: { type: 'function', name: 'known' } })
  assert.equal(restore(forced, chunk(['known'])).toolCalls.length, 1)
  assert.equal(restore(parse({ parallel_tool_calls: false }), chunk(['known', 'known'])).toolCalls.length, 1)
})

test('undeclared calls produce an error at the public route and retain reported usage', async () => {
  for (const stream of [false, true]) {
    const f = fixture({
      frames: [
        frame(
          chunk(['unknown'], { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }),
        ),
      ],
    })
    const res = await f.call(requestBody({ stream }))
    assert.equal(res.status, stream ? 200 : 502)
    assert.match(res.text, /gemini_inference_invalid_output/)
    assert.doesNotMatch(res.text, /"name":"unknown"/)
    assert.equal(f.logs[0].final_state, 'failed')
    assert.equal(f.logs[0].usage.output_tokens, 5)
  }
})

test('forced missing names fail in Chat, Messages and Gemini native requests', () => {
  for (const [protocol, body] of [
    [
      'openai-chat',
      {
        model,
        messages: [{ role: 'user', content: 'check' }],
        tools: [{ type: 'function', function: { name: 'known' } }],
        tool_choice: { type: 'function', function: { name: 'missing' } },
      },
    ],
    [
      'anthropic',
      {
        model,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'check' }],
        tools: [{ name: 'known', input_schema: { type: 'object' } }],
        tool_choice: { type: 'tool', name: 'missing' },
      },
    ],
    [
      'gemini',
      {
        model,
        contents: [{ role: 'user', parts: [{ text: 'check' }] }],
        tools: [{ functionDeclarations: [{ name: 'known' }] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['missing'] } },
      },
    ],
  ]) {
    assert.throws(() => parseInboundToGemini(protocol, body), { status: 400, code: 'gemini_invalid_request' })
  }
})

test('local undeclared-tool failures preserve HTTP 200 and do not persist an account suspension', async () => {
  const slotPrefs = createGeminiSlotPrefs()
  const f = fixture({ slotPrefs, frames: [frame(chunk(['not_declared']))] })
  const res = await f.call(requestBody())
  assert.equal(res.status, 502)
  assert.equal(JSON.parse(res.text).error.code, 'gemini_inference_invalid_output')
  assert.equal(f.logs[0].upstream_status, 200)
  assert.equal(slotPrefs.resolved('env-validation').unschedulable, null)
  await f.call(requestBody())
  assert.equal(f.calls, 2, 'the account remains available for subsequent requests')
})

test('actual upstream SSE 502 still follows the configured account suspension policy', async () => {
  const slotPrefs = createGeminiSlotPrefs()
  const f = fixture({
    slotPrefs,
    frames: [frame({ error: { code: 502, status: 'BAD_GATEWAY', message: 'upstream failure' } })],
  })
  await f.call(requestBody())
  assert.equal(f.logs[0].upstream_status, 502)
  assert.equal(slotPrefs.resolved('env-validation').unschedulable?.reason, 'upstream_502')
})

test('local tool validation is request-scoped for release and failover without tripping Node circuit', async () => {
  for (const switches of [0, 1, 3]) {
    const failures = []
    const completed = []
    const circuitFailures = []
    const runtime = createMockSchedulerRuntime({
      onSwitch: ({ body }) => failures.push(body.failure),
      onRelease: ({ payload }) => failures.push(payload),
    })
    const f = fixture({
      runtime,
      envIds: ['a', 'b', 'c', 'd'],
      frames: [frame(chunk(['not_declared']))],
      getRoutingConfig: () => ({ gemini: { failover: { max_account_switches: switches } } }),
      poolScheduler: { unitCircuit: { recordFailure: (key) => circuitFailures.push(key) } },
      attemptsRepo: { complete: (_id, _attempt, result) => completed.push(result) },
    })
    const res = await f.call(requestBody())
    assert.equal(res.status, 502)
    assert.equal(f.calls, switches + 1, 'the configured switch budget still bounds attempts')
    assert.equal(failures.length, switches + 1)
    for (const failure of failures) {
      assert.equal(failure.http_status, 200)
      assert.equal(failure.error_class, 'request_protocol')
      assert.equal(failure.error_signature, 'gemini_inference_invalid_output')
    }
    assert.deepEqual(circuitFailures, [])
    assert.equal(completed.length, switches + 1)
    assert.ok(completed.every((result) => result.errorScope === 'request'))
  }
})

test('local tool failure after streamed output releases the lease without retry or health penalty', async () => {
  const failures = []
  const circuitFailures = []
  const runtime = createMockSchedulerRuntime({
    onSwitch: () => assert.fail('must not switch after output'),
    onRelease: ({ payload }) => failures.push(payload),
  })
  const f = fixture({
    runtime,
    envIds: ['a', 'b'],
    poolScheduler: { unitCircuit: { recordFailure: (key) => circuitFailures.push(key) } },
    frames: [
      frame({ candidates: [{ content: { role: 'model', parts: [{ text: 'synthetic', thought: true }] } }] }),
      frame(chunk(['not_declared'])),
    ],
  })
  const res = await f.call(requestBody({ stream: true }))
  assert.equal(res.status, 200)
  assert.match(res.text, /gemini_inference_invalid_output/)
  assert.equal(f.calls, 1)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].outcome, 'error')
  assert.equal(failures[0].error_class, 'request_protocol')
  assert.deepEqual(circuitFailures, [])
})

test('upstream failures and other invalid output retain health attribution', async () => {
  for (const [frames, expectedClass, status] of [
    [[frame({ error: { code: 504, status: 'DEADLINE_EXCEEDED', message: 'idle_timeout' } })], 'timeout', 504],
    // Matching names (even a supplied marker) in upstream data must not grant a local validation exemption.
    [
      [
        frame({
          error: {
            code: 502,
            status: 'gemini_inference_invalid_output',
            reason: 'undeclared_tool_call',
            localError: true,
          },
        }),
      ],
      'server5xx',
      502,
    ],
    [[], 'unknown', 200],
  ]) {
    const failures = []
    const circuitFailures = []
    const runtime = createMockSchedulerRuntime({ onRelease: ({ payload }) => failures.push(payload) })
    const f = fixture({
      runtime,
      frames,
      poolScheduler: { unitCircuit: { recordFailure: (key) => circuitFailures.push(key) } },
      getRoutingConfig: () => ({ gemini: { failover: { unschedulable_on_502: false } } }),
    })
    const res = await f.call(requestBody())
    assert.ok(res.status >= 500, res.text)
    assert.equal(failures.length, 1)
    assert.equal(failures[0].http_status, status)
    assert.equal(failures[0].error_class, expectedClass)
    assert.equal(circuitFailures.length, 1)
  }
})
