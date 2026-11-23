import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { extractApiKey, redactSecrets } from '../../src/lib/core/security.mjs'
import {
  cancelGeminiNativeTurn,
  prepareGeminiNativeTurn,
  readGeminiNativeHealth,
} from '../../src/lib/gemini/native-turn.mjs'
import {
  createGeminiPublicHandler,
  geminiKeyAllowsPath,
  isGeminiPublicPath,
  isGeminiSharedPath,
} from '../../src/lib/gemini/routes.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { FULL_GEMINI_CAPABILITIES, NATIVE_TUI_CAPABILITIES } from '../../src/lib/protocol/gemini-convert.mjs'

function makeRes() {
  const res = new EventEmitter()
  res.headers = {}
  res.statusCode = 200
  res.chunks = []
  res.writableEnded = false
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v
  }
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status
    for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = v
  }
  res.write = (chunk) => {
    res.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }
  res.end = (chunk) => {
    if (chunk) res.write(chunk)
    res.writableEnded = true
    res.emit('finish')
    res.emit('close')
  }
  res.bodyText = () => res.chunks.join('')
  res.jsonBody = () => JSON.parse(res.bodyText())
  return res
}

function makeReq({ method = 'POST', url, body, headers = {}, groupType = 'gemini', apiKeyKind = 'managed' }) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.body = body
  req.headers = headers
  req.apiKeyKind = apiKeyKind
  req.apiKeyRecord = { id: 'key-1', group_id: 2, group_type: groupType }
  return req
}

function jsonResponder(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function sseResponse(frames, { statusCode = 200, contentType = 'text/event-stream; charset=utf-8', delayMs = 0 } = {}) {
  const stream = new Readable({
    read() {},
  })
  stream.statusCode = statusCode
  stream.headers = { 'content-type': contentType }
  ;(async () => {
    for (const frame of frames) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      if (stream.destroyed) return
      stream.push(frame)
    }
    if (!stream.destroyed) stream.push(null)
  })()
  return stream
}

function makeCircuitTracker() {
  const calls = { success: [], failure: [], probe: [] }
  return {
    calls,
    unitCircuit: {
      recordSuccess: (id) => calls.success.push(id),
      recordFailure: (id) => calls.failure.push(id),
      releaseProbe: (id) => calls.probe.push(id),
    },
    lastUsed: new Map(),
    reserveExternalCandidates(candidates, { excluded }) {
      const sorted = [...candidates]
        .filter((c) => !excluded.has(c.accountId))
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      const selected = sorted[0]
      if (!selected) return null
      return { selected, reservation: { release() {} } }
    },
  }
}

test('full 4-protocol streaming & non-streaming end-to-end on api_key environment', async () => {
  const inferCalls = []
  const usageRecords = []
  const sseFrames = [
    `data: ${JSON.stringify({
      responseId: 'r-stream-1',
      modelVersion: 'gemini-2.5-pro',
      candidates: [{ content: { role: 'model', parts: [{ text: 'plan', thought: true }] } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Hello ' },
              { text: 'Gemini!' },
              {
                functionCall: { id: 'fc_1', name: 'default_api:lookup', args: { key: 'v' } },
                thoughtSignature: Buffer.from('sig123').toString('base64'),
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 20,
        cachedContentTokenCount: 5,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 4,
        totalTokenCount: 34,
      },
    })}\n\n`,
  ]

  const scheduler = createGeminiScheduler({
    callHost: async (op) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-key',
              proxy_id: 'proxy-1',
              auth_state: 'authorized',
              auth_method: 'api_key',
              models_discovered: true,
              models: ['gemini-2.5-pro'],
              capabilities: [...FULL_GEMINI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get') {
        return { id: 'env-key', proxy_id: 'proxy-1', auth_method: 'api_key' }
      }
      throw new Error(`unexpected op: ${op}`)
    },
    callHostStream: async (op, payload) => {
      inferCalls.push({ op, payload })
      return sseResponse(sseFrames)
    },
    resolveProxy: () => 'socks5h://1.2.3.4:1080',
    poolScheduler: makeCircuitTracker(),
    apiKeyStore: {
      acquire: () => ({ ok: true }),
      release: () => {},
      recordUsage: (_rec, usage, meta) => usageRecords.push({ usage, meta }),
    },
  })

  const handler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async () => ({}),
    scheduler,
  })

  // 1. Google Gemini streamGenerateContent
  const resGem = makeRes()
  await handler(
    makeReq({
      url: '/v1beta/models/gemini-2.5-pro:streamGenerateContent',
      body: {
        system_instruction: { parts: [{ text: 'sys' }] },
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generation_config: { temperature: 0.3 },
      },
    }),
    resGem,
  )
  assert.equal(resGem.statusCode, 200)
  assert.match(resGem.headers['content-type'], /text\/event-stream/)
  assert.match(resGem.bodyText(), /"text":"Hello "/)
  assert.match(resGem.bodyText(), /"name":"lookup"/)
  assert.equal(inferCalls[0].payload.body.systemInstruction.parts[0].text, 'sys')

  // 2. OpenAI Chat Completions streaming
  const resChat = makeRes()
  await handler(
    makeReq({
      url: '/v1/chat/completions',
      body: {
        model: 'gemini-2.5-pro',
        stream: true,
        messages: [
          { role: 'system', content: 'be concise' },
          { role: 'user', content: 'hi' },
        ],
      },
    }),
    resChat,
  )
  assert.equal(resChat.statusCode, 200)
  assert.match(resChat.bodyText(), /"reasoning_content":"plan"/)
  assert.match(resChat.bodyText(), /"extra_content":\{"google":\{"thought_signature":/)
  assert.match(resChat.bodyText(), /data: \[DONE\]\n\n$/)

  // 3. OpenAI Responses non-streaming
  const resResp = makeRes()
  await handler(
    makeReq({
      url: '/v1/responses',
      body: {
        model: 'gemini-2.5-pro',
        instructions: 'solve it',
        input: 'hi',
      },
    }),
    resResp,
  )
  assert.equal(resResp.statusCode, 200)
  const respPayload = resResp.jsonBody()
  assert.equal(respPayload.object, 'response')
  assert.equal(
    respPayload.output.some((o) => o.type === 'function_call' && o.name === 'lookup'),
    true,
  )
  assert.equal(respPayload.usage.input_tokens_details.cached_tokens, 5)
  assert.equal(respPayload.usage.output_tokens_details.reasoning_tokens, 4)

  // 4. Anthropic Messages streaming
  const resAnth = makeRes()
  await handler(
    makeReq({
      url: '/v1/messages',
      body: {
        model: 'gemini-2.5-pro',
        stream: true,
        max_tokens: 256,
        system: 'Be accurate',
        messages: [{ role: 'user', content: 'hi' }],
      },
    }),
    resAnth,
  )
  assert.equal(resAnth.statusCode, 200)
  assert.match(resAnth.bodyText(), /event: message_start/)
  assert.match(resAnth.bodyText(), /"type":"thinking_delta","thinking":"plan"/)
  assert.match(resAnth.bodyText(), /"type":"tool_use"/)
  assert.match(resAnth.bodyText(), /event: message_stop/)

  // Usage accounting recorded cache + reasoning tokens accurately.
  assert.equal(usageRecords.length, 4)
  assert.deepEqual(usageRecords[0].usage, {
    input_tokens: 15,
    output_tokens: 14,
    cache_read_input_tokens: 5,
    reasoning_tokens: 4,
  })
})

test('CRAG capability-aware admission routes rich turns away from restricted slots and supports full native capabilities on craggemini', async () => {
  const inferTargets = []
  const legacyRestrictedCaps = ['streaming', 'native_tui']
  let envs = [
    {
      id: 'env-oauth-legacy',
      proxy_id: 'proxy-1',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-2.5-flash'],
      capabilities: [...legacyRestrictedCaps],
    },
    {
      id: 'env-apikey',
      proxy_id: 'proxy-1',
      auth_state: 'authorized',
      auth_method: 'api_key',
      models_discovered: true,
      models: ['gemini-2.5-flash'],
      capabilities: [...FULL_GEMINI_CAPABILITIES],
    },
  ]

  const scheduler = createGeminiScheduler({
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') {
        const found = envs.find((e) => e.id === payload.id)
        return { id: found.id, proxy_id: found.proxy_id, auth_method: found.auth_method }
      }
      throw new Error(`unexpected op: ${op}`)
    },
    callHostStream: async (_op, payload) => {
      inferTargets.push(payload.id)
      return sseResponse([
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })}\n\n`,
      ])
    },
    resolveProxy: () => 'socks5h://1.2.3.4:1080',
    poolScheduler: makeCircuitTracker(),
  })
  const handler = createGeminiPublicHandler({ json: jsonResponder, readBody: async () => ({}), scheduler })

  // Rich turn with system + tools MUST route to api_key when oauth only advertises legacy restricted caps.
  const res1 = makeRes()
  await handler(
    makeReq({
      url: '/v1/chat/completions',
      body: {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'be strict' },
          { role: 'user', content: 'hello' },
        ],
      },
    }),
    res1,
  )
  assert.equal(res1.statusCode, 200)
  assert.deepEqual(inferTargets, ['env-apikey'])

  // When ONLY legacy restricted native_tui environment exists, rich turn MUST fail closed with 400 gemini_unsupported_turn.
  envs = [envs[0]]
  const res2 = makeRes()
  await handler(
    makeReq({
      url: '/v1/messages',
      body: {
        model: 'gemini-2.5-flash',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello' }],
      },
    }),
    res2,
  )
  assert.equal(res2.statusCode, 400)
  assert.equal(res2.jsonBody().type, 'error')
  assert.equal(res2.jsonBody().error.code, 'gemini_unsupported_turn')
  assert.deepEqual(inferTargets, ['env-apikey']) // Zero host calls made for rejected turn!

  // Plain-text turn on legacy oauth-only pool succeeds via native TUI.
  const res3 = makeRes()
  await handler(
    makeReq({
      url: '/v1/chat/completions',
      body: {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'plain hello' }],
      },
    }),
    res3,
  )
  assert.equal(res3.statusCode, 200)
  assert.deepEqual(inferTargets, ['env-apikey', 'env-oauth-legacy'])

  // Modern CRAGGemini OAuth environment (NATIVE_TUI_CAPABILITIES) accepts multi-turn, image, and web search.
  envs = [
    {
      id: 'env-oauth-craggemini',
      proxy_id: 'proxy-1',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-2.5-flash'],
      capabilities: [...NATIVE_TUI_CAPABILITIES],
    },
  ]
  const res4 = makeRes()
  await handler(
    makeReq({
      url: '/v1/chat/completions',
      body: {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'be concise' },
          { role: 'user', content: 'Remember ZEBRA-1' },
          { role: 'assistant', content: 'Got it' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What color is this image?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
        ],
      },
    }),
    res4,
  )
  assert.equal(res4.statusCode, 200)
  assert.deepEqual(inferTargets, ['env-apikey', 'env-oauth-legacy', 'env-oauth-craggemini'])
})

test('error handling: circuit breaker, pre-stream vs mid-stream errors, and disconnect infer-cancel', async () => {
  const cancels = []
  const tracker = makeCircuitTracker()
  let mode = 'http429'

  const scheduler = createGeminiScheduler({
    callHost: async (op, payload) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-1',
              proxy_id: 'proxy-1',
              auth_state: 'authorized',
              auth_method: 'api_key',
              models_discovered: true,
              models: ['gemini-2.5-pro'],
              capabilities: [...FULL_GEMINI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get') return { id: 'env-1', proxy_id: 'proxy-1', auth_method: 'api_key' }
      if (op === 'infer-cancel') {
        cancels.push(payload)
        return { cancelled: true }
      }
      throw new Error(`unexpected op: ${op}`)
    },
    callHostStream: async () => {
      if (mode === 'http429') {
        return sseResponse([JSON.stringify({ code: 'gemini_quota_exhausted', message: 'quota' })], {
          statusCode: 429,
          contentType: 'application/json',
        })
      }
      if (mode === 'http502') {
        return sseResponse([JSON.stringify({ code: 'gemini_inference_failed', message: 'upstream down' })], {
          statusCode: 502,
          contentType: 'application/json',
        })
      }
      if (mode === 'preStreamSseError') {
        return sseResponse([
          `data: ${JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'rate limit' } })}\n\n`,
        ])
      }
      if (mode === 'midStreamSseError') {
        return sseResponse([
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] })}\n\n`,
          `data: ${JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'midstream drop' } })}\n\n`,
        ])
      }
      // Slow stream for mid-stream abort test (emits chunk 1 at 20ms, chunk 2 at 120ms)
      const stream = new Readable({ read() {} })
      stream.statusCode = 200
      stream.headers = { 'content-type': 'text/event-stream; charset=utf-8' }
      setTimeout(() => {
        if (!stream.destroyed) {
          stream.push(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'first' }] } }] })}\n\n`)
        }
      }, 15)
      setTimeout(() => {
        if (!stream.destroyed) {
          stream.push(
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'never' }] }, finishReason: 'STOP' }] })}\n\n`,
          )
          stream.push(null)
        }
      }, 150)
      return stream
    },
    resolveProxy: () => 'socks5h://1.2.3.4:1080',
    poolScheduler: tracker,
  })
  const handler = createGeminiPublicHandler({ json: jsonResponder, readBody: async () => ({}), scheduler })

  // 1. HTTP 429 does NOT trip circuit breaker (verifies ReferenceError: code fix too!)
  const res429 = makeRes()
  await handler(
    makeReq({
      url: '/v1/chat/completions',
      body: { model: 'gemini-2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    }),
    res429,
  )
  assert.equal(res429.statusCode, 429)
  assert.equal(res429.jsonBody().error.code, 'gemini_quota_exhausted')
  assert.equal(tracker.calls.failure.length, 0)
  assert.equal(tracker.calls.probe.length, 1)

  // 2. HTTP 502 DOES record circuit breaker failure
  mode = 'http502'
  const res502 = makeRes()
  await handler(
    makeReq({
      url: '/v1/chat/completions',
      body: { model: 'gemini-2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    }),
    res502,
  )
  assert.equal(res502.statusCode, 502)
  assert.equal(tracker.calls.failure.length, 1)

  // 3. Pre-stream SSE error frame before any text returns HTTP 429 JSON (not HTTP 200 SSE!)
  mode = 'preStreamSseError'
  const resPre = makeRes()
  await handler(
    makeReq({
      url: '/v1beta/models/gemini-2.5-pro:streamGenerateContent',
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    }),
    resPre,
  )
  assert.equal(resPre.statusCode, 429)
  assert.equal(resPre.jsonBody().error.status, 'RESOURCE_EXHAUSTED')

  // 4. Mid-stream SSE error after headers sent emits SSE error frame ONCE (never duplicated)
  mode = 'midStreamSseError'
  const resMid = makeRes()
  await handler(
    makeReq({
      url: '/v1/messages',
      body: { model: 'gemini-2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    }),
    resMid,
  )
  assert.equal(resMid.statusCode, 200)
  const errEvents = resMid.bodyText().match(/event: error/g) || []
  assert.equal(errEvents.length, 1)

  // 5. Client disconnect mid-stream (after first chunk) aborts stream, triggers infer-cancel, does NOT record failure or success
  mode = 'slow'
  const failureBeforeAbort = tracker.calls.failure.length
  const cancelsBeforeAbort = cancels.length
  const reqAbort = makeReq({
    url: '/v1/chat/completions',
    body: { model: 'gemini-2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
  })
  const resAbort = makeRes()
  const running = handler(reqAbort, resAbort)
  await new Promise((r) => setTimeout(r, 50))
  reqAbort.emit('aborted')
  await running
  assert.equal(cancels.length, cancelsBeforeAbort + 1)
  assert.equal(cancels[cancels.length - 1].id, 'env-1')
  assert.equal(tracker.calls.failure.length, failureBeforeAbort)
  assert.equal(tracker.calls.success.length, 0)
})

test('native-turn helpers validate gatewayPolicy and communicate with worker cancel/health endpoints', async () => {
  const env = prepareGeminiNativeTurn({
    protocol: 'gemini',
    model: 'gemini-2.5-pro',
    requestId: 'req-policy-1',
    stream: true,
    gatewayPolicy: { queue_wait_ms: 2000, first_byte_timeout_ms: 8000, stream_idle_timeout_ms: 15000 },
    body: { model: 'gemini-2.5-pro', stream: true, contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
  })
  assert.deepEqual(env.gateway_policy, {
    queue_wait_ms: 2000,
    first_byte_timeout_ms: 8000,
    stream_idle_timeout_ms: 15000,
  })
  assert.throws(
    () =>
      prepareGeminiNativeTurn({
        protocol: 'gemini',
        model: 'gemini-2.5-pro',
        requestId: 'req-bad-policy',
        stream: true,
        gatewayPolicy: { queue_wait_ms: 50 },
        body: { model: 'gemini-2.5-pro', stream: true, contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
      }),
    (err) => err.code === 'gemini_unsupported_turn',
  )

  const token = 'a'.repeat(32)
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\vm2api-gemini-native-${crypto.randomBytes(6).toString('hex')}`
      : path.join(os.tmpdir(), `vm2api-gn-${crypto.randomBytes(6).toString('hex')}.sock`)

  const server = http.createServer((req, res) => {
    assert.equal(req.headers['x-kin-internal-token'], token)
    if (req.method === 'GET' && req.url === '/internal/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, ready: true, capabilities: ['native_tui', 'cancel_v1'] }))
    }
    if (req.method === 'POST' && req.url === '/internal/v1/cancel') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ cancelled: body.request_id === 'turn-1' }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise((resolve) => server.listen(socketPath, resolve))
  try {
    const health = await readGeminiNativeHealth({ socketPath, internalToken: token })
    assert.equal(health.status, 200)
    assert.equal(health.ready, true)
    assert.deepEqual(health.capabilities, ['native_tui', 'cancel_v1'])

    const cancelled = await cancelGeminiNativeTurn({ socketPath, internalToken: token, requestId: 'turn-1' })
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.cancelled, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('Codex and Claude route isolation invariants remain intact', async () => {
  // Public paths must NEVER claim shared OpenAI/Anthropic routes.
  for (const shared of [
    '/v1/chat/completions',
    '/chat/completions',
    '/v1/responses',
    '/responses',
    '/v1/messages',
    '/messages',
    '/v1/models',
  ]) {
    assert.equal(isGeminiPublicPath(shared), false, `${shared} must not be Gemini-only public path`)
  }
  assert.equal(isGeminiPublicPath('/v1beta/models/gemini-2.5-pro:generateContent'), true)
  assert.equal(isGeminiPublicPath('/v1beta/models/gemini-2.5-pro:streamGenerateContent'), true)
  assert.equal(isGeminiSharedPath('/v1/chat/completions'), true)
  assert.equal(isGeminiSharedPath('/v1/responses'), true)
  assert.equal(isGeminiSharedPath('/v1/messages'), false)
  assert.equal(geminiKeyAllowsPath('/v1/messages', 'POST'), true)
  assert.equal(geminiKeyAllowsPath('/v1beta/models', 'GET'), true)

  // Non-Gemini managed keys (codex/claude) are strictly refused by Gemini public handler.
  const handler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async () => ({}),
    scheduler: { catalog: async () => ({ models: [], accounts: [] }) },
  })
  for (const groupType of ['codex', 'claude']) {
    const res = makeRes()
    await handler(makeReq({ url: '/v1/chat/completions', body: {}, groupType }), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.jsonBody().error.code, 'gemini_key_required')
  }
})

test('Google Gemini native auth headers (x-goog-api-key and /v1beta ?key=) extract and redact safely', () => {
  assert.equal(
    extractApiKey({ headers: { 'x-goog-api-key': 'sk-kin-gem-123' }, url: '/v1beta/models' }),
    'sk-kin-gem-123',
  )
  assert.equal(extractApiKey({ headers: { 'x-goog-api-key': 'kin-panel-secret' }, url: '/v1beta/models' }), '')
  assert.equal(
    extractApiKey({
      headers: {},
      url: '/v1beta/models/gemini-2.5-pro:generateContent?key=sk-kin-query-456&alt=sse',
    }),
    'sk-kin-query-456',
  )
  assert.equal(extractApiKey({ headers: {}, url: '/v1beta/models?key=kin-panel-secret' }), '')
  // Query parameter ?key= is scoped strictly to /v1beta/models endpoints.
  assert.equal(extractApiKey({ headers: {}, url: '/v1/chat/completions?key=sk-kin-query-456' }), '')
  assert.equal(extractApiKey({ headers: {}, url: '/api/panel/gemini?key=sk-kin-query-456' }), '')
  const redacted = redactSecrets({ url: '/v1beta/models?key=my-secret-gemini-key&alt=sse' })
  assert.doesNotMatch(redacted, /my-secret-gemini-key/)
  assert.match(redacted, /key=\*\*\*REDACTED\*\*\*/)
})

test('Google account verification ineligibility returns 403 without tripping circuit breaker', async () => {
  const tracker = makeCircuitTracker()
  const scheduler = createGeminiScheduler({
    callHost: async (op) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-verify',
              proxy_id: 'proxy-1',
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              models: ['gemini-3-flash'],
              capabilities: [...NATIVE_TUI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get') return { id: 'env-verify', proxy_id: 'proxy-1', auth_method: 'oauth' }
      throw new Error(`unexpected op: ${op}`)
    },
    callHostStream: async () =>
      sseResponse([JSON.stringify({ code: 'gemini_account_verification_required' })], {
        statusCode: 403,
        contentType: 'application/json',
      }),
    resolveProxy: () => 'socks5h://1.2.3.4:1080',
    poolScheduler: tracker,
  })
  const handler = createGeminiPublicHandler({ json: jsonResponder, readBody: async () => ({}), scheduler })
  const res = makeRes()
  await handler(
    makeReq({
      url: '/v1/chat/completions',
      body: { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'hello' }] },
    }),
    res,
  )
  assert.equal(res.statusCode, 403)
  assert.equal(res.jsonBody().error.code, 'gemini_account_verification_required')
  assert.equal(tracker.calls.failure.length, 0)
  assert.equal(tracker.calls.probe.length, 1)
})
