import test from 'node:test'
import assert from 'node:assert/strict'
import {
  antigravityNativeRequest,
  antigravityNativeUsage,
  createAntigravityUpstream,
} from '../../scripts/antigravity-upstream.mjs'
import { startAntigravityBridge } from '../../scripts/antigravity-bridge.mjs'
import { callAntigravityBridge } from '../../src/lib/transport/antigravity-bridge-client.mjs'
import fs from 'node:fs'
import http from 'node:http'
import { createAntigravityProtocolStream } from '../../src/lib/protocol/antigravity-convert.mjs'
import os from 'node:os'
import path from 'node:path'

const basic = {
  model: 'gemini-3.8-flash-low',
  system: [{ type: 'text', text: 'system' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [],
}
const token = { access_token: 'PRIVATE_TOKEN_TEST', expiry: new Date(Date.now() + 3600000).toISOString() }
const config = { models: [basic.model], timeout_ms: 1000 }
function sse(chunks, { split = false } = {}) {
  const bytes = Buffer.from(chunks.map((chunk) => `data: ${JSON.stringify({ response: chunk })}\r\n\r\n`).join(''))
  return new Response(
    new ReadableStream({
      start(controller) {
        if (split) for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.subarray(i, i + 1))
        else controller.enqueue(bytes)
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}
function upstream(fetchImpl, extra = {}) {
  return createAntigravityUpstream(config, {
    readToken: () => token,
    loadProject: async () => 'account-project',
    fetch: fetchImpl,
    ...extra,
  })
}
const result = (parts, finishReason) => ({
  candidates: [{ content: { parts, role: 'model' }, ...(finishReason ? { finishReason } : {}) }],
})

test('native request preserves structured roles, system, JSON schema, tool IDs, signatures and inline images', () => {
  const body = antigravityNativeRequest({
    ...basic,
    tools: [
      {
        name: 'lookup',
        description: 'Lookup',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
    tool_choice: { type: 'tool', name: 'lookup' },
    max_tokens: 80,
    response_format: { type: 'json_schema', schema: { type: 'object' } },
    messages: [
      basic.messages[0],
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thinking', signature: 'aQ==' },
          { type: 'tool_use', id: 'call-real', name: 'lookup', input: { city: '上海' }, thought_signature: 'c2ln' },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-real',
            content: [
              { type: 'text', text: '22C' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aQ==' } },
            ],
          },
        ],
      },
    ],
  })
  assert.deepEqual(Object.keys(body).sort(), [
    'contents',
    'generationConfig',
    'systemInstruction',
    'toolConfig',
    'tools',
  ])
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'system' }] })
  assert.equal(body.contents[1].role, 'model')
  assert.deepEqual(body.contents[1].parts[1], {
    functionCall: { id: 'call-real', name: 'lookup', args: { city: '上海' } },
    thoughtSignature: 'c2ln',
  })
  assert.deepEqual(body.contents[2].parts[0].functionResponse, {
    id: 'call-real',
    name: 'lookup',
    response: { result: '22C' },
    parts: [{ inlineData: { mimeType: 'image/png', data: 'aQ==' } }],
  })
  assert.deepEqual(body.tools[0].functionDeclarations[0].parametersJsonSchema, {
    type: 'object',
    properties: { city: { type: 'string' } },
  })
  assert.deepEqual(body.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: ['lookup'] })
  assert.equal(body.generationConfig.maxOutputTokens, 80)
  assert.deepEqual(body.generationConfig.responseJsonSchema, { type: 'object' })
})

test('unsupported remote images and unpaired tool results fail before credential access', async () => {
  let read = 0
  const provider = upstream(() => assert.fail('network must not run'), {
    readToken: () => {
      read++
      return token
    },
  })
  const images = await provider.infer({
    ...basic,
    messages: [
      { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'http://169.254.169.254/latest' } }] },
    ],
  })
  assert.equal(images.code, 'feature_not_supported')
  assert.equal(images.status, 400)
  const missing = await provider.infer({
    ...basic,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unknown', content: [] }] }],
  })
  assert.equal(missing.code, 'invalid_tool_result')
  assert.equal(read, 0)
})

test('usage counts cache once and includes reasoning in output tokens', () => {
  assert.deepEqual(
    antigravityNativeUsage({
      promptTokenCount: 120,
      cachedContentTokenCount: 100,
      candidatesTokenCount: 8,
      thoughtsTokenCount: 12,
      totalTokenCount: 140,
    }),
    {
      input_tokens: 20,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 0,
      output_tokens: 20,
      thinking_tokens: 12,
    },
  )
  assert.equal(antigravityNativeUsage({ promptTokenCount: 3 }), null)
  assert.equal(
    antigravityNativeUsage({ promptTokenCount: 2, candidatesTokenCount: 1, cachedContentTokenCount: 3 }),
    null,
  )
})

test('byte-split SSE preserves UTF8, terminal thought signature and exact native payload', async () => {
  let call
  const events = []
  const provider = upstream(async (url, options) => {
    call = { url, options }
    return sse(
      [
        result([{ text: '你好' }]),
        {
          ...result([{ text: '', thoughtSignature: 'opaque-signature' }], 'STOP'),
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
        },
      ],
      { split: true },
    )
  })
  const response = await provider.infer(basic, { onEvent: (event) => events.push(event) })
  assert.equal(response.ok, true)
  assert.equal(call.url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse')
  assert.equal(call.options.redirect, 'error')
  assert.match(call.options.headers['user-agent'], /^antigravity\/cli\/1\.4\.4 /)
  const envelope = JSON.parse(call.options.body)
  assert.equal(envelope.project, 'account-project')
  assert.equal(envelope.model, basic.model)
  assert.equal(envelope.requestType, 'agent')
  assert.match(envelope.requestId, /^agent\//)
  assert.deepEqual(envelope.request.contents, [{ role: 'user', parts: [{ text: 'hello' }] }])
  assert.deepEqual(response.content, [{ type: 'text', text: '你好', thought_signature: 'opaque-signature' }])
  assert.equal(response.stop_reason, 'end_turn')
  assert.equal(response.terminalState, 'verified')
  assert.ok(events.some((event) => event.type === 'thought_signature' && event.signature === 'opaque-signature'))
  assert.equal(JSON.stringify(response).includes(token.access_token), false)
})

test('reasoning and function calls stream with IDs, JSON arguments, signatures and no tool execution', async () => {
  const events = []
  const provider = upstream(async () =>
    sse([
      result([{ thought: true, text: 'consider' }]),
      result([{ thought: true, text: '', thoughtSignature: 'thinking-sig' }]),
      result(
        [
          {
            functionCall: { id: 'upstream-id', name: 'lookup', args: { city: 'Paris' } },
            thoughtSignature: 'tool-sig',
          },
        ],
        'STOP',
      ),
    ]),
  )
  const response = await provider.infer(
    { ...basic, tools: [{ name: 'lookup', input_schema: { type: 'object' } }] },
    { onEvent: (event) => events.push(event) },
  )
  assert.equal(response.ok, true)
  assert.deepEqual(response.content, [
    { type: 'thinking', thinking: 'consider', signature: 'thinking-sig' },
    { type: 'tool_use', id: 'upstream-id', name: 'lookup', input: { city: 'Paris' }, thought_signature: 'tool-sig' },
  ])
  assert.equal(response.stop_reason, 'tool_use')
  assert.ok(events.some((event) => event.delta?.type === 'signature_delta'))
  assert.ok(events.some((event) => event.delta?.partial_json === '{"city":"Paris"}'))
})

test('replayed tool calls missing their signature get the cached one, else the skip validator', async () => {
  const bodies = []
  const provider = upstream(async (_url, init) => {
    bodies.push(JSON.parse(init.body).request)
    return bodies.length === 1
      ? sse([
          result(
            [{ functionCall: { id: 'call_1', name: 'read', args: { path: '/tmp' } }, thoughtSignature: 'tool-sig' }],
            'STOP',
          ),
        ])
      : sse([result([{ text: 'done' }], 'STOP')])
  })
  const tools = [{ name: 'read', input_schema: { type: 'object' } }]
  assert.equal((await provider.infer({ ...basic, tools })).ok, true)
  const replay = (id) => ({
    ...basic,
    tools,
    messages: [
      basic.messages[0],
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reasoning replayed as text' },
          { type: 'tool_use', id, name: 'read', input: { path: '/tmp' } },
          { type: 'tool_use', id: `${id}-b`, name: 'read', input: { path: '/b' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }] },
          { type: 'tool_result', tool_use_id: `${id}-b`, content: [{ type: 'text', text: 'ok' }] },
        ],
      },
    ],
  })
  assert.equal((await provider.infer(replay('call_1'))).ok, true)
  assert.deepEqual(
    bodies[1].contents[1].parts.map((part) => part.thoughtSignature),
    [undefined, 'tool-sig', undefined],
  )
  assert.equal((await provider.infer(replay('call_unknown'))).ok, true)
  assert.deepEqual(
    bodies[2].contents[1].parts.map((part) => part.thoughtSignature),
    [undefined, 'skip_thought_signature_validator', undefined],
  )
})

test('partial streams cannot become successful and retain output commitment', async () => {
  const provider = upstream(async () => sse([result([{ text: 'partial' }])]))
  const response = await provider.infer(basic)
  assert.equal(response.ok, false)
  assert.equal(response.code, 'antigravity_stream_incomplete')
  assert.equal(response.status, 502)
  assert.equal(response.output_committed, true)
  assert.equal(response.terminalState, 'incomplete')
})

function timedUpstream(timeoutMs, fetchImpl) {
  return createAntigravityUpstream(
    { ...config, timeout_ms: timeoutMs },
    { readToken: () => token, loadProject: async () => 'account-project', fetch: fetchImpl },
  )
}

test('timeout_ms bounds silence, not total time: a stream that keeps sending outlives it', async () => {
  const frames = [...Array.from({ length: 6 }, () => result([{ text: 'x' }])), result([{ text: '.' }], 'STOP')]
  const provider = timedUpstream(150, async (_url, { signal }) => {
    const encoder = new TextEncoder()
    let index = 0
    return new Response(
      new ReadableStream({
        async pull(controller) {
          if (index === frames.length) return controller.close()
          await new Promise((resolve) => setTimeout(resolve, 60))
          if (signal.aborted) return controller.error(new DOMException('aborted', 'AbortError'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: frames[index++] })}\n\n`))
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  })
  const started = Date.now()
  const response = await provider.infer(basic)
  assert.ok(Date.now() - started > 300)
  assert.equal(response.ok, true)
  assert.equal(response.content[0].text, 'xxxxxx.')
})

test('a silent stream ends as antigravity_timeout, not the abort exception code', async () => {
  const provider = timedUpstream(100, async (_url, { signal }) => {
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: result([{ text: 'Writing' }]) })}\n\n`))
          signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  })
  const response = await provider.infer(basic)
  assert.equal(response.ok, false)
  assert.equal(response.status, 504)
  assert.equal(response.code, 'antigravity_timeout')
  assert.match(response.message, /antigravity\.timeout_ms/)
  assert.equal(response.output_committed, true)
})

test('401 refresh uses official CLI ownership and retries once without exposing upstream error body', async () => {
  let calls = 0,
    refreshes = 0
  const provider = upstream(
    async () =>
      ++calls === 1
        ? new Response('private-upstream-detail', { status: 401 })
        : sse([result([{ text: 'OK' }], 'STOP')]),
    {
      refresh: async () => {
        refreshes++
      },
    },
  )
  assert.equal((await provider.infer(basic)).ok, true)
  assert.equal(refreshes, 1)
  const failed = await upstream(async () => new Response(token.access_token, { status: 403 })).infer(basic)
  assert.equal(failed.status, 403)
  assert.equal(JSON.stringify(failed).includes(token.access_token), false)
})

test('expired token: a stalled CLI refresh outlives the aborted caller and failures name the cause', async () => {
  let current = { access_token: 'stale', expiry: new Date(Date.now() - 1000).toISOString() }
  let finish
  let refreshes = 0
  const provider = upstream(
    async (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer fresh')
      return sse([result([{ text: 'OK' }], 'STOP')])
    },
    {
      readToken: () => current,
      refresh: () => {
        refreshes++
        return new Promise((resolve) => (finish = resolve))
      },
    },
  )
  const caller = new AbortController()
  const pending = provider.infer(basic, { signal: caller.signal })
  await new Promise((resolve) => setImmediate(resolve))
  caller.abort()
  assert.equal((await pending).code, 'client_cancelled')
  const next = provider.infer(basic)
  current = { access_token: 'fresh', expiry: new Date(Date.now() + 3600_000).toISOString() }
  finish()
  assert.equal((await next).ok, true)
  assert.equal(refreshes, 1, 'the in-flight refresh is shared, not restarted by the next caller')

  current = { access_token: 'stale', expiry: new Date(Date.now() - 1000).toISOString() }
  const failed = await upstream(() => assert.fail('network'), {
    readToken: () => current,
    refresh: async () => {
      throw new Error('official CLI did not finish within 90s')
    },
  }).infer(basic)
  assert.equal(failed.status, 503)
  assert.equal(failed.code, 'antigravity_token_refresh_failed')
  assert.match(failed.message, /did not finish within 90s/)
  const unchanged = await upstream(() => assert.fail('network'), {
    readToken: () => current,
    refresh: async () => {},
  }).infer(basic)
  assert.equal(
    unchanged.code,
    'antigravity_token_refresh_failed',
    'a CLI exit that left the token expired is not success',
  )
})

test('Cloud Code project comes from loadCodeAssist once per token and missing projects fail closed', async () => {
  const seen = []
  const provider = createAntigravityUpstream(config, {
    readToken: () => token,
    fetch: async (url, options) => {
      seen.push(new URL(url).pathname)
      if (url.endsWith(':loadCodeAssist')) return Response.json({ cloudaicompanionProject: 'aicode-consumers' })
      assert.equal(JSON.parse(options.body).project, 'aicode-consumers')
      return sse([result([{ text: 'OK' }], 'STOP')])
    },
  })
  assert.equal((await provider.infer(basic)).ok, true)
  assert.equal((await provider.infer(basic)).ok, true)
  assert.deepEqual(seen, [
    '/v1internal:loadCodeAssist',
    '/v1internal:streamGenerateContent',
    '/v1internal:streamGenerateContent',
  ])
  const missing = await createAntigravityUpstream(config, {
    readToken: () => token,
    fetch: async (url) =>
      url.endsWith(':loadCodeAssist') ? Response.json({}) : assert.fail('inference must not run without a project'),
  }).infer(basic)
  assert.equal(missing.code, 'antigravity_project_unavailable')
  assert.equal(missing.output_committed, false)
})

test('caller cancellation aborts upstream and frees slot capacity', async () => {
  let calls = 0
  const provider = upstream(async (_url, { signal }) => {
    if (++calls > 1) return sse([result([{ text: 'OK' }], 'STOP')])
    return await new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' })), {
        once: true,
      }),
    )
  })
  const controller = new AbortController()
  const pending = provider.infer(basic, { signal: controller.signal })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await provider.infer(basic)).code, 'antigravity_busy')
  controller.abort()
  assert.equal((await pending).code, 'client_cancelled')
  assert.equal((await provider.infer(basic)).ok, true)
})

test('structured bridge carries canonical events and result over authenticated UDS', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-api-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const run = path.join(root, 'vms', 'vm-test', 'run')
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'antigravity.token'), 'internal-only')
  const provider = upstream(async () => sse([result([{ text: 'OK' }], 'STOP')]))
  const bridge = await startAntigravityBridge(
    { ...config, socket_path: path.join(run, 'antigravity.sock'), internal_token: 'internal-only' },
    { upstream: provider, pool: { size: 0, close() {} } },
  )
  t.after(() => bridge.close())
  const events = []
  const response = await callAntigravityBridge({
    projectRoot: root,
    vm: { id: 'vm-test' },
    requestPath: '/inference',
    body: basic,
    onEvent: (event) => events.push(event),
  })
  assert.equal(response.ok, true)
  assert.equal(response.content[0].text, 'OK')
  assert.equal(events[1].delta.text, 'OK')
  assert.equal(response.output_committed, true)
})

test('strict guarantees and disabled parallel tools are rejected before credentials/network', async () => {
  const provider = upstream(() => assert.fail('network'), { readToken: () => assert.fail('credentials') })
  for (const fields of [
    { parallel_tool_calls: false },
    { tool_choice: { type: 'auto', disable_parallel_tool_use: true } },
    { tools: [{ name: 'lookup', input_schema: {}, strict: true }] },
    { response_format: { type: 'json_schema', schema: {}, strict: true } },
  ])
    assert.equal((await provider.infer({ ...basic, ...fields })).code, 'feature_not_supported')
})

test('identical complete thinking signatures are idempotent and signed parts keep distinct blocks', async () => {
  const events = []
  const provider = upstream(async () =>
    sse([
      result([{ thought: true, text: 'one' }]),
      result([{ thought: true, text: '', thoughtSignature: 'sig-one' }]),
      result([{ thought: true, text: '', thoughtSignature: 'sig-one' }]),
      result([{ thought: true, text: 'two', thoughtSignature: 'sig-two' }], 'STOP'),
    ]),
  )
  const response = await provider.infer(basic, { onEvent: (event) => events.push(event) })
  assert.equal(response.ok, true)
  assert.deepEqual(response.content, [
    { type: 'thinking', thinking: 'one', signature: 'sig-one' },
    { type: 'thinking', thinking: 'two', signature: 'sig-two' },
  ])
  assert.equal(events.filter((event) => event.delta?.type === 'signature_delta').length, 2)
})

test('terminal usage survives UDS disconnect and cancellation before HTTP end', async (t) => {
  for (const cancellation of [false, true])
    await t.test(cancellation ? 'cancelled' : 'disconnected', async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-terminal-'))
      t.after(() => fs.rmSync(root, { recursive: true, force: true }))
      const run = path.join(root, 'vms', 'vm-test', 'run')
      fs.mkdirSync(run, { recursive: true })
      fs.writeFileSync(path.join(run, 'antigravity.token'), 'internal-only')
      const controller = new AbortController()
      const usage = { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(JSON.stringify({ event: 'text_delta', text: 'OK' }) + '\n')
        res.write(
          JSON.stringify({
            event: 'result',
            result: {
              ok: true,
              content: [{ type: 'text', text: 'OK' }],
              usage,
              upstream_status: 'STOP',
              output_committed: true,
            },
          }) + '\n',
        )
        if (!cancellation) setTimeout(() => res.destroy(), 20)
      })
      await new Promise((resolve) => server.listen(path.join(run, 'antigravity.sock'), resolve))
      t.after(() => {
        server.closeAllConnections()
        server.close()
      })
      const response = await callAntigravityBridge({
        projectRoot: root,
        vm: { id: 'vm-test' },
        requestPath: '/inference',
        body: basic,
        signal: controller.signal,
        onText: () => {
          if (cancellation) setTimeout(() => controller.abort(), 10)
        },
      })
      assert.equal(response.ok, false)
      assert.deepEqual(response.usage, usage)
      assert.equal(response.output_committed, true)
      assert.equal(response.upstream_status, 'STOP')
      if (cancellation) assert.equal(response.code, 'client_cancelled')
    })
})

test('native provider canonical streams complete through every public protocol converter', async () => {
  for (const protocol of ['anthropic.messages', 'openai.chat', 'openai.responses']) {
    const stream = createAntigravityProtocolStream(protocol, { model: basic.model, includeUsage: true })
    let wire = ''
    const provider = upstream(async () =>
      sse([
        result([{ thought: true, text: 'reason', thoughtSignature: 'reason-sig' }]),
        result([{ text: 'Checking' }]),
        result([{ text: '', thoughtSignature: 'text-sig' }]),
        {
          ...result(
            [
              {
                functionCall: { id: 'call-upstream', name: 'lookup', args: { city: 'Paris' } },
                thoughtSignature: 'tool-sig',
              },
            ],
            'STOP',
          ),
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8, thoughtsTokenCount: 2, totalTokenCount: 20 },
        },
      ]),
    )
    const response = await provider.infer(basic, {
      onEvent: (event) => {
        wire += stream.push(event)
      },
    })
    assert.equal(response.ok, true)
    wire += stream.finish(response)
    assert.doesNotMatch(wire, /antigravity_stream_mismatch/)
    assert.match(wire, /tool-sig/)
    if (protocol === 'anthropic.messages') assert.match(wire, /message_stop/)
    else if (protocol === 'openai.chat') assert.match(wire, /\[DONE\]/)
    else assert.match(wire, /response.completed/)
  }
})
