import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { extractApiKey, redactSecrets } from '../../src/lib/core/security.mjs'
import { CORS_ALLOW_HEADERS } from '../../src/lib/http/cors.mjs'
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
  parseGeminiGeneratePath,
  parseGeminiModelGetPath,
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

  // Single-turn request containing slash paths and ANSI control chars succeeds on modern CRAGGemini
  // after target-specific sanitization, while legacy restricted native_tui still rejects it.
  const capturedBodies = []
  const sanitizedScheduler = createGeminiScheduler({
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') {
        const found = envs.find((e) => e.id === payload.id)
        return { id: found.id, proxy_id: found.proxy_id, auth_method: found.auth_method }
      }
      throw new Error(`unexpected op: ${op}`)
    },
    callHostStream: async (_op, payload) => {
      capturedBodies.push(payload.body)
      return sseResponse([
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'sanitized-ok' }] }, finishReason: 'STOP' }] })}\n\n`,
      ])
    },
    resolveProxy: () => 'socks5h://1.2.3.4:1080',
    poolScheduler: makeCircuitTracker(),
  })
  const sanitizedHandler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async () => ({}),
    scheduler: sanitizedScheduler,
  })
  const res5 = makeRes()
  await sanitizedHandler(
    makeReq({
      url: '/v1/messages',
      body: {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Inspect /etc/hosts and \x1b[31m/var/log/syslog\x1b[0m' }],
      },
    }),
    res5,
  )
  assert.equal(res5.statusCode, 200)
  assert.equal(capturedBodies.length, 1)
  const sentText = capturedBodies[0].contents[0].parts[0].text
  assert.equal(/[^\P{Cc}\n\r\t]/u.test(sentText), false)
  assert.equal(
    sentText.split(/\p{White_Space}+/u).some((w) => w.startsWith('/')),
    false,
  )

  // Legacy restricted native_tui environment still fails closed for raw slash text.
  envs = [
    {
      id: 'env-oauth-legacy',
      proxy_id: 'proxy-1',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-2.5-flash'],
      capabilities: [...legacyRestrictedCaps],
    },
  ]
  const res6 = makeRes()
  await sanitizedHandler(
    makeReq({
      url: '/v1/messages',
      body: {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'please run /quit' }],
      },
    }),
    res6,
  )
  assert.equal(res6.statusCode, 400)
  assert.equal(res6.jsonBody().error.code, 'gemini_unsupported_turn')
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

test('Gemini public ports support /v1 native generateContent, single-model GET, /v1/models ?key= auth, and CORS headers', async () => {
  assert.match(CORS_ALLOW_HEADERS, /x-goog-api-key/)
  assert.match(CORS_ALLOW_HEADERS, /x-goog-api-client/)

  assert.equal(extractApiKey({ headers: {}, url: '/v1/models?key=sk-vm-query-v1' }), 'sk-vm-query-v1')
  assert.equal(
    extractApiKey({
      headers: {},
      url: '/v1/models/gemini-4-neon-low:generateContent?key=sk-vm-query-gen',
    }),
    'sk-vm-query-gen',
  )
  assert.equal(extractApiKey({ headers: {}, url: '/v1/models?key=kin-panel-secret' }), '')
  assert.equal(extractApiKey({ headers: {}, url: '/v1/chat/completions?key=sk-vm-nope' }), '')

  assert.equal(isGeminiPublicPath('/v1/models/gemini-4-neon-low:generateContent'), true)
  assert.equal(isGeminiPublicPath('/v1/models/gemini-4-neon-low:streamGenerateContent'), true)
  assert.equal(isGeminiPublicPath('/v1beta/models/gemini-4-neon-low'), true)
  assert.equal(isGeminiPublicPath('/v1/models'), false)
  assert.equal(isGeminiPublicPath('/v1/models/gemini-4-neon-low'), false)
  assert.equal(geminiKeyAllowsPath('/v1/models/gemini-4-neon-low', 'GET'), true)
  assert.equal(geminiKeyAllowsPath('/v1beta/models/gemini-4-neon-low', 'GET'), true)
  assert.equal(geminiKeyAllowsPath('/v1/models/gemini-4-neon-low:generateContent', 'POST'), true)
  assert.deepEqual(parseGeminiGeneratePath('/v1/models/gemini-4-neon-low:streamGenerateContent'), {
    version: 'v1',
    model: 'gemini-4-neon-low',
    action: 'streamGenerateContent',
    stream: true,
  })
  assert.deepEqual(parseGeminiModelGetPath('/v1beta/models/gemini-4-neon-low'), {
    version: 'v1beta',
    model: 'gemini-4-neon-low',
  })

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
              models: ['gemini-4-neon-low'],
              capabilities: [...FULL_GEMINI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get') return { id: 'env-key', proxy_id: 'proxy-1', auth_method: 'api_key' }
      throw new Error(`unexpected op: ${op}`)
    },
    callHostStream: async () =>
      sseResponse([
        `data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'v1-ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
        })}\n\n`,
      ]),
    resolveProxy: () => 'socks5h://1.2.3.4:1080',
  })
  const handler = createGeminiPublicHandler({ json: jsonResponder, readBody: async () => ({}), scheduler })

  const resMetaBeta = makeRes()
  await handler(makeReq({ method: 'GET', url: '/v1beta/models/gemini-4-neon-low' }), resMetaBeta)
  assert.equal(resMetaBeta.statusCode, 200)
  assert.deepEqual(resMetaBeta.jsonBody(), {
    name: 'models/gemini-4-neon-low',
    baseModelId: 'gemini-4-neon-low',
    displayName: 'gemini-4-neon-low',
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
  })

  const resMetaV1 = makeRes()
  await handler(makeReq({ method: 'GET', url: '/v1/models/gemini-4-neon-low' }), resMetaV1)
  assert.equal(resMetaV1.statusCode, 200)
  assert.equal(resMetaV1.jsonBody().id, 'gemini-4-neon-low')

  const resMissing = makeRes()
  await handler(makeReq({ method: 'GET', url: '/v1beta/models/no-such-model' }), resMissing)
  assert.equal(resMissing.statusCode, 404)
  assert.equal(resMissing.jsonBody().error.status, 'NOT_FOUND')

  const resGenV1 = makeRes()
  await handler(
    makeReq({
      method: 'POST',
      url: '/v1/models/gemini-4-neon-low:generateContent',
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    }),
    resGenV1,
  )
  assert.equal(resGenV1.statusCode, 200)
  assert.equal(resGenV1.jsonBody().candidates[0].content.parts[0].text, 'v1-ok')
})

test('Gemini public handler strips safetySettings for CRAGGemini and captures debug inbound/outbound bodies', async () => {
  let capturedInferBody = null
  const logEvents = []
  let tapped = false
  const scheduler = createGeminiScheduler({
    callHost: async (op) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-crag',
              proxy_id: 'proxy-1',
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              models: ['gemini-4-neon-high'],
              capabilities: [...NATIVE_TUI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get') return { id: 'env-crag', proxy_id: 'proxy-1', auth_method: 'oauth' }
      throw new Error(`unexpected op: ${op}`)
    },
    callHostStream: async (_op, payload) => {
      capturedInferBody = payload.body
      return sseResponse([
        `data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
        })}\n\n`,
      ])
    },
    resolveProxy: () => 'socks5h://1.2.3.4:1080',
  })

  const handler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async () => ({}),
    scheduler,
    requestLog: {
      start: (_req, meta) => ({ mode: 'debug', capture_outbound: true, ...meta }),
      tapResponse: () => {
        tapped = true
      },
      finish: (_ctx, extra) => logEvents.push(extra),
    },
  })

  const res = makeRes()
  await handler(
    makeReq({
      method: 'POST',
      url: '/v1beta/models/gemini-4-neon-high:streamGenerateContent',
      body: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
        cachedContent: 'cachedContents/test-1',
      },
    }),
    res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(tapped, true)
  assert.equal('safetySettings' in capturedInferBody, false)
  assert.equal('cachedContent' in capturedInferBody, false)
  assert.equal(logEvents.length, 1)
  assert.equal(logEvents[0].inbound_body?.safetySettings?.length, 1)
  assert.equal(logEvents[0].outbound_body_source, 'craggemini')
  assert.equal('safetySettings' in (logEvents[0].outbound_body || {}), false)
})

test('CRAGGemini end-to-end 4-protocol parity, early-stop cancel, and tool-continuation sticky conversation_id', async () => {
  const inferCalls = []
  const cancelled = []
  let activeTurn = 'parity'

  const scheduler = createGeminiScheduler({
    callHost: async (op, payload) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-a',
              proxy_id: 'proxy-a',
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              models: ['gemini-3-pro'],
              capabilities: [...NATIVE_TUI_CAPABILITIES],
            },
            {
              id: 'env-b',
              proxy_id: 'proxy-b',
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              models: ['gemini-3-pro'],
              capabilities: [...NATIVE_TUI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get')
        return { id: payload.id, proxy_id: payload.id === 'env-a' ? 'proxy-a' : 'proxy-b', auth_method: 'oauth' }
      if (op === 'infer-cancel') {
        cancelled.push(payload)
        return { cancelled: true }
      }
      throw new Error(`unexpected op: ${op}`)
    },
    callHostStream: async (_op, payload) => {
      inferCalls.push({ id: payload.id, body: payload.body })
      if (activeTurn === 'stop-cancel') {
        return sseResponse([
          `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'alpha ###' }] } }] })}\n\n`,
          `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'TAIL_NEVER_SENT' }] }, finishReason: 'STOP' }] })}\n\n`,
        ])
      }
      if (activeTurn === 'tool-turn-1') {
        return sseResponse([
          `data: ${JSON.stringify({
            craggeminiMeta: {
              conversation_id: 'conv_mcp_sticky_42',
              native_conversation_id: 'native_42',
              awaiting_tool_results: true,
            },
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        id: 'call_mcp_1',
                        name: 'mcp__craggemini__get_weather',
                        args: { city: 'Tokyo' },
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
          })}\n\n`,
        ])
      }
      return sseResponse([
        `data: ${JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: '```json\n{"city":"Tokyo","temp":22}\n```' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6, totalTokenCount: 18 },
        })}\n\n`,
      ])
    },
    resolveProxy: () => 'socks5h://1.2.3.4:1080',
  })

  const handler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async () => ({}),
    scheduler,
  })

  // 1. All 4 protocols send minimal CRAGGemini payload (no non-image generationConfig) and unwrap responseFormat JSON cleanly.
  const endpoints = [
    [
      'gemini',
      '/v1beta/models/gemini-3-pro:generateContent',
      {
        contents: [{ role: 'user', parts: [{ text: 'Return Tokyo temp as JSON' }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 128, responseMimeType: 'application/json' },
      },
      (body) => body.candidates[0].content.parts[0].text,
    ],
    [
      'openai-chat',
      '/v1/chat/completions',
      {
        model: 'gemini-3-pro',
        temperature: 0.4,
        max_tokens: 128,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'Return Tokyo temp as JSON' }],
      },
      (body) => body.choices[0].message.content,
    ],
    [
      'openai-responses',
      '/v1/responses',
      {
        model: 'gemini-3-pro',
        temperature: 0.4,
        max_output_tokens: 128,
        text: { format: { type: 'json_object' } },
        input: 'Return Tokyo temp as JSON',
      },
      (body) => body.output[0].content[0].text,
    ],
    [
      'anthropic',
      '/v1/messages',
      {
        model: 'gemini-3-pro',
        temperature: 0.4,
        max_tokens: 128,
        output_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'Return Tokyo temp as JSON' }],
      },
      (body) => body.content[0].text,
    ],
  ]

  for (const [proto, url, payload, extractText] of endpoints) {
    const res = makeRes()
    await handler(makeReq({ method: 'POST', url, body: payload }), res)
    assert.equal(res.statusCode, 200, `[${proto}] HTTP 200`)
    assert.equal(extractText(res.jsonBody()), '{"city":"Tokyo","temp":22}', `[${proto}] JSON fence unwrapped`)
    const lastSent = inferCalls[inferCalls.length - 1].body
    assert.equal('generationConfig' in lastSent, false, `[${proto}] non-image generationConfig stripped`)
    assert.equal('safetySettings' in lastSent, false, `[${proto}] safetySettings stripped`)
  }

  // 2. Local stop sequence in streaming mode truncates output and triggers background infer-cancel on host.
  activeTurn = 'stop-cancel'
  const stopRes = makeRes()
  await handler(
    makeReq({
      method: 'POST',
      url: '/v1/messages',
      body: {
        model: 'gemini-3-pro',
        stream: true,
        max_tokens: 256,
        stop_sequences: ['###'],
        messages: [{ role: 'user', content: 'Write until ###' }],
      },
    }),
    stopRes,
  )
  assert.equal(stopRes.statusCode, 200)
  const stopSse = stopRes.chunks.join('')
  assert.match(stopSse, /"text":"alpha "/)
  assert.doesNotMatch(stopSse, /TAIL_NEVER_SENT/)
  assert.match(stopSse, /"stop_reason":"stop_sequence"/)
  assert.match(stopSse, /"stop_sequence":"###"/)
  assert.equal(cancelled.length, 1, 'early stop must issue infer-cancel to release CRAGGemini slot')

  // 3. Tool continuation pins turn 2 to the original CRAGGemini worker account and forwards conversation_id.
  activeTurn = 'tool-turn-1'
  const toolRes1 = makeRes()
  await handler(
    makeReq({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gemini-3-pro',
        messages: [{ role: 'user', content: 'Weather in Tokyo?' }],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
          },
        ],
      },
    }),
    toolRes1,
  )
  assert.equal(toolRes1.statusCode, 200)
  const turn1Account = inferCalls[inferCalls.length - 1].id
  const turn1Call = toolRes1.jsonBody().choices[0].message.tool_calls[0]
  assert.equal(turn1Call.function.name, 'get_weather', 'mcp__craggemini__ prefix stripped on egress')

  activeTurn = 'parity'
  const toolRes2 = makeRes()
  await handler(
    makeReq({
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'gemini-3-pro',
        messages: [
          { role: 'user', content: 'Weather in Tokyo?' },
          { role: 'assistant', content: null, tool_calls: [turn1Call] },
          { role: 'tool', tool_call_id: turn1Call.id, content: '{"temp":22}' },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
          },
        ],
      },
    }),
    toolRes2,
  )
  assert.equal(toolRes2.statusCode, 200)
  const turn2Infer = inferCalls[inferCalls.length - 1]
  assert.equal(turn2Infer.id, turn1Account, 'tool continuation must stick to the suspended CRAGGemini account')
  assert.equal(turn2Infer.body.conversation_id, 'conv_mcp_sticky_42', 'tool continuation must forward conversation_id')
})

test('CRAGGemini resume keeps conversation_id on same account and always remints on every account switch (failover, A->B->A, tool failover)', async () => {
  let failAccounts = new Set()
  let nowMs = 1_700_000_000_000
  const calls = []

  const scheduler = createGeminiScheduler({
    now: () => nowMs,
    quotaCooldownMs: 30_000,
    callHost: async (op, payload) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-a',
              proxy_id: 'proxy-a',
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              models: ['gemini-3-pro'],
              capabilities: [...NATIVE_TUI_CAPABILITIES],
            },
            {
              id: 'env-b',
              proxy_id: 'proxy-b',
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              models: ['gemini-3-pro'],
              capabilities: [...NATIVE_TUI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get') {
        return { id: payload.id, proxy_id: payload.id === 'env-a' ? 'proxy-a' : 'proxy-b', auth_method: 'oauth' }
      }
      if (op === 'infer-cancel') return { cancelled: true }
      throw new Error(`unexpected op: ${op}`)
    },
    callHostStream: async (_op, payload) => {
      calls.push({
        id: payload.id,
        requestId: payload.request_id,
        convId: payload.body?.conversation_id,
        body: payload.body,
      })
      if (failAccounts.has(payload.id)) {
        return sseResponse([JSON.stringify({ code: 'gemini_quota_exhausted', message: 'rate limited' })], {
          statusCode: 429,
          contentType: 'application/json',
        })
      }
      const turnReply = `reply-${calls.length}-on-${payload.id}`
      return sseResponse([
        `data: ${JSON.stringify({
          craggeminiMeta: {
            conversation_id: payload.body?.conversation_id || '',
            native_conversation_id: `native_${payload.id}_${payload.body?.conversation_id}`,
            awaiting_tool_results: false,
          },
          candidates: [{ content: { role: 'model', parts: [{ text: turnReply }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
        })}\n\n`,
      ])
    },
    resolveProxy: () => 'socks5h://1.2.3.4:1080',
  })

  const handler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async () => ({}),
    scheduler,
  })

  const callerConv = 'caller-fixed-conv-99'
  const postChat = async (messages, extra = {}) => {
    const res = makeRes()
    await handler(
      makeReq({
        method: 'POST',
        url: '/v1/chat/completions',
        body: {
          model: 'gemini-3-pro',
          conversation_id: callerConv,
          messages,
          ...extra,
        },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    return res.jsonBody()
  }

  // Turn 1: lands on env-a, mints account-scoped outbound conversation_id C1 (!== caller raw ID).
  const r1 = await postChat([{ role: 'user', content: 'Start project alpha' }])
  const t1 = calls[calls.length - 1]
  assert.equal(t1.id, 'env-a')
  assert.match(t1.convId, /^gc_[a-f0-9]{24}$/)
  assert.notEqual(t1.convId, callerConv)
  const c1 = t1.convId

  // Turn 2: same account resume on env-a MUST keep exact same outbound conversation_id C1.
  const r2 = await postChat([
    { role: 'user', content: 'Start project alpha' },
    { role: 'assistant', content: r1.choices[0].message.content },
    { role: 'user', content: 'Add step 2' },
  ])
  const t2 = calls[calls.length - 1]
  assert.equal(t2.id, 'env-a')
  assert.equal(t2.convId, c1, 'same-account resume must preserve outbound conversation_id')

  // Turn 3: env-a hits 429 -> intra-request failover to env-b MUST mint a brand-new conversation_id C2 !== C1
  // and deliver the full multi-turn history so env-b continues seamlessly.
  failAccounts = new Set(['env-a'])
  const callsBeforeT3 = calls.length
  const r3 = await postChat([
    { role: 'user', content: 'Start project alpha' },
    { role: 'assistant', content: r1.choices[0].message.content },
    { role: 'user', content: 'Add step 2' },
    { role: 'assistant', content: r2.choices[0].message.content },
    { role: 'user', content: 'Add step 3 after failover' },
  ])
  const t3Attempts = calls.slice(callsBeforeT3)
  assert.equal(t3Attempts.length, 2, 'intra-request failover should try env-a then env-b')
  assert.equal(t3Attempts[0].id, 'env-a')
  assert.equal(t3Attempts[0].convId, c1)
  assert.equal(t3Attempts[1].id, 'env-b')
  const c2 = t3Attempts[1].convId
  assert.match(c2, /^gc_[a-f0-9]{24}$/)
  assert.notEqual(c2, c1, 'account switch env-a -> env-b must mint a new conversation_id')
  assert.notEqual(c2, callerConv)
  assert.equal(t3Attempts[1].body.contents.length, 5, 'failover target must receive full history for continuity')

  // Turn 4: stays on env-b and resumes with C2.
  const r4 = await postChat([
    { role: 'user', content: 'Start project alpha' },
    { role: 'assistant', content: r1.choices[0].message.content },
    { role: 'user', content: 'Add step 2' },
    { role: 'assistant', content: r2.choices[0].message.content },
    { role: 'user', content: 'Add step 3 after failover' },
    { role: 'assistant', content: r3.choices[0].message.content },
    { role: 'user', content: 'Resume on env-b' },
  ])
  const t4 = calls[calls.length - 1]
  assert.equal(t4.id, 'env-b')
  assert.equal(t4.convId, c2, 'subsequent turn on env-b must reuse C2')

  // Turn 5: advance clock so env-a exits cooldown, then env-b hits 429 -> switch BACK env-b -> env-a!
  // MUST mint a 3rd brand-new conversation_id C3 !== C2 AND C3 !== C1!
  nowMs += 60_000
  failAccounts = new Set(['env-b'])
  const callsBeforeT5 = calls.length
  await postChat([
    { role: 'user', content: 'Start project alpha' },
    { role: 'assistant', content: r1.choices[0].message.content },
    { role: 'user', content: 'Add step 2' },
    { role: 'assistant', content: r2.choices[0].message.content },
    { role: 'user', content: 'Add step 3 after failover' },
    { role: 'assistant', content: r3.choices[0].message.content },
    { role: 'user', content: 'Resume on env-b' },
    { role: 'assistant', content: r4.choices[0].message.content },
    { role: 'user', content: 'Return to env-a' },
  ])
  const t5Attempts = calls.slice(callsBeforeT5)
  const t5Ok = t5Attempts[t5Attempts.length - 1]
  assert.equal(t5Ok.id, 'env-a')
  const c3 = t5Ok.convId
  assert.match(c3, /^gc_[a-f0-9]{24}$/)
  assert.notEqual(c3, c2, 'switch back env-b -> env-a must not reuse env-b conversation_id')
  assert.notEqual(c3, c1, 'returning to previously used env-a must mint a fresh conversation_id (not stale C1)')
  assert.equal(t5Ok.body.contents.length, 9)

  // Stateless client (NO conversation_id / NO x-session-id header) keeps same account + C_stateless via fingerprint,
  // and remints on switch. Advance clock so env-b exits Turn 5 quota cooldown before testing failover.
  nowMs += 60_000
  failAccounts = new Set()
  const statelessTurn1 = makeRes()
  await handler(
    makeReq({
      method: 'POST',
      url: '/v1/messages',
      body: {
        model: 'gemini-3-pro',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Unique stateless thread seed 7788' }],
      },
    }),
    statelessTurn1,
  )
  assert.equal(statelessTurn1.statusCode, 200)
  const st1 = calls[calls.length - 1]
  const statelessTurn2 = makeRes()
  await handler(
    makeReq({
      method: 'POST',
      url: '/v1/messages',
      body: {
        model: 'gemini-3-pro',
        max_tokens: 128,
        messages: [
          { role: 'user', content: 'Unique stateless thread seed 7788' },
          { role: 'assistant', content: statelessTurn1.jsonBody().content[0].text },
          { role: 'user', content: 'Follow up without any session header' },
        ],
      },
    }),
    statelessTurn2,
  )
  assert.equal(statelessTurn2.statusCode, 200)
  const st2 = calls[calls.length - 1]
  assert.equal(st2.id, st1.id, 'stateless multi-turn should stick to same account via first-user fingerprint')
  assert.equal(st2.convId, st1.convId, 'stateless same-account resume should keep outbound conversation_id')

  // Failover stateless thread to the other account -> must remint conversation_id!
  failAccounts = new Set([st1.id])
  const statelessTurn3 = makeRes()
  await handler(
    makeReq({
      method: 'POST',
      url: '/v1/messages',
      body: {
        model: 'gemini-3-pro',
        max_tokens: 128,
        messages: [
          { role: 'user', content: 'Unique stateless thread seed 7788' },
          { role: 'assistant', content: statelessTurn1.jsonBody().content[0].text },
          { role: 'user', content: 'Follow up without any session header' },
          { role: 'assistant', content: statelessTurn2.jsonBody().content[0].text },
          { role: 'user', content: 'Failover turn without session header' },
        ],
      },
    }),
    statelessTurn3,
  )
  assert.equal(statelessTurn3.statusCode, 200)
  const st3 = calls[calls.length - 1]
  assert.notEqual(st3.id, st1.id)
  assert.notEqual(st3.convId, st1.convId, 'stateless failover must remint outbound conversation_id')
})

test('CRAGGemini suspended MCP tool continuation remints conversation_id and cleans stale binding on failover', async () => {
  let failAccounts = new Set()
  let turn1ToolPending = true
  const calls = []

  const scheduler = createGeminiScheduler({
    quotaCooldownMs: 30_000,
    callHost: async (op, payload) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-a',
              proxy_id: 'proxy-a',
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              models: ['gemini-3-pro'],
              capabilities: [...NATIVE_TUI_CAPABILITIES],
            },
            {
              id: 'env-b',
              proxy_id: 'proxy-b',
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              models: ['gemini-3-pro'],
              capabilities: [...NATIVE_TUI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get') {
        return { id: payload.id, proxy_id: payload.id === 'env-a' ? 'proxy-a' : 'proxy-b', auth_method: 'oauth' }
      }
      if (op === 'infer-cancel') return { cancelled: true }
      throw new Error(`unexpected op: ${op}`)
    },
    callHostStream: async (_op, payload) => {
      calls.push({ id: payload.id, convId: payload.body?.conversation_id, body: payload.body })
      if (failAccounts.has(payload.id)) {
        return sseResponse([JSON.stringify({ code: 'gemini_quota_exhausted', message: 'rate limited' })], {
          statusCode: 429,
          contentType: 'application/json',
        })
      }
      if (turn1ToolPending) {
        turn1ToolPending = false
        return sseResponse([
          `data: ${JSON.stringify({
            craggeminiMeta: {
              conversation_id: 'conv_mcp_orig_7',
              native_conversation_id: 'native_env_a_7',
              awaiting_tool_results: true,
            },
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        id: 'call_failover_1',
                        name: 'mcp__craggemini__get_weather',
                        args: { city: 'Shanghai' },
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          })}\n\n`,
        ])
      }
      return sseResponse([
        `data: ${JSON.stringify({
          craggeminiMeta: {
            conversation_id: payload.body?.conversation_id || '',
            native_conversation_id: `native_${payload.id}_${payload.body?.conversation_id}`,
            awaiting_tool_results: false,
          },
          candidates: [
            { content: { role: 'model', parts: [{ text: `tool-continued-on-${payload.id}` }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 5, totalTokenCount: 20 },
        })}\n\n`,
      ])
    },
    resolveProxy: () => 'socks5h://1.2.3.4:1080',
  })

  const handler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async () => ({}),
    scheduler,
  })

  const weatherTools = [
    {
      type: 'function',
      function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
    },
  ]
  const send = async (messages) => {
    const res = makeRes()
    await handler(
      makeReq({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'x-session-id': 'mcp-failover-session' },
        body: { model: 'gemini-3-pro', messages, tools: weatherTools },
      }),
      res,
    )
    assert.equal(res.statusCode, 200)
    return res.jsonBody()
  }

  // Turn 1: lands on env-a and suspends waiting for call_failover_1 under conv_mcp_orig_7.
  const t1Res = await send([{ role: 'user', content: 'Weather in Shanghai?' }])
  const callId = t1Res.choices[0].message.tool_calls[0].id
  assert.equal(calls[0].id, 'env-a')

  // Turn 2: env-a hits 429 on tool_result continuation -> fails over to env-b with brand-new conversation_id!
  failAccounts = new Set(['env-a'])
  const t2Res = await send([
    { role: 'user', content: 'Weather in Shanghai?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: callId, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' } },
      ],
    },
    { role: 'tool', tool_call_id: callId, content: '{"temp_c":24}' },
  ])
  assert.equal(calls.length, 3)
  assert.equal(calls[1].id, 'env-a')
  assert.equal(calls[1].convId, 'conv_mcp_orig_7', 'first attempt should target suspended env-a with original conv id')
  assert.equal(calls[2].id, 'env-b')
  const envBConvId = calls[2].convId
  assert.match(envBConvId, /^gc_[a-f0-9]{24}$/)
  assert.notEqual(envBConvId, 'conv_mcp_orig_7', 'failover account must never inherit suspended account conv id')
  assert.notEqual(envBConvId, calls[0].convId)
  assert.equal(calls[2].body.contents.length, 3, 'failover account must receive full tool history')

  // Turn 3: follow-up turn after tool failover (carrying historical tool_result in messages) MUST stay on env-b
  // with envBConvId and NOT bounce back to env-a!
  failAccounts = new Set()
  await send([
    { role: 'user', content: 'Weather in Shanghai?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: callId, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' } },
      ],
    },
    { role: 'tool', tool_call_id: callId, content: '{"temp_c":24}' },
    { role: 'assistant', content: t2Res.choices[0].message.content },
    { role: 'user', content: 'Should I wear a jacket?' },
  ])
  const t3Call = calls[calls.length - 1]
  assert.equal(t3Call.id, 'env-b', 'follow-up turn after tool failover must stay sticky on env-b')
  assert.equal(t3Call.convId, envBConvId, 'follow-up turn on env-b must resume envBConvId')
})

test('Gemini mode=ANY rejects plain-text STOP without functionCall while keeping AUTO and valid ANY calls working (#1732)', async () => {
  const hostPayloads = []
  let nextChunks = []
  let circuitFailures = 0
  let circuitProbesReleased = 0

  const scheduler = createGeminiScheduler({
    callHost: async (op) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-any-1',
              proxy_id: 'px-1',
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              models: ['gemini-4-hydrogen-high'],
              capabilities: [...FULL_GEMINI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get') return { id: 'env-any-1', proxy_id: 'px-1', auth_method: 'oauth' }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async (_op, payload) => {
      hostPayloads.push(payload)
      return sseResponse(nextChunks)
    },
    resolveProxy: () => 'socks5h://192.0.2.10:1080',
    poolScheduler: {
      inflight: new Map(),
      reserveExternalCandidates: (list) => ({ selected: list[0], reservation: { release() {} } }),
      unitCircuit: {
        recordSuccess() {},
        recordFailure() {
          circuitFailures += 1
        },
        releaseProbe() {
          circuitProbesReleased += 1
        },
      },
      lastUsed: new Map(),
    },
  })

  const logs = []
  const handler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async (r) => r.body || {},
    scheduler,
    requestLog: {
      start: () => ({ request_id: `req-${logs.length + 1}` }),
      finish: (_ctx, extra) => logs.push(extra),
    },
  })

  const tools = [
    {
      functionDeclarations: [
        {
          name: 'reply',
          parameters: {
            type: 'OBJECT',
            properties: { content: { type: 'STRING' } },
            required: ['content'],
          },
        },
        {
          name: 'tool_search',
          parameters: { type: 'OBJECT', properties: { q: { type: 'STRING' } } },
        },
      ],
    },
  ]

  const callRoute = async (url, body) => {
    const req = makeReq({ url, body, groupType: 'gemini' })
    const res = makeRes()
    await handler(req, res)
    return res
  }

  // 1. Streaming ANY (with allowedFunctionNames) + plain-text STOP -> SSE error frame, NO normal STOP.
  nextChunks = [
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'plain text only' }] }, finishReason: 'STOP' }],
    })}\n\n`,
  ]
  const r1 = await callRoute('/v1beta/models/gemini-4-hydrogen-high:streamGenerateContent?alt=sse', {
    contents: [{ role: 'user', parts: [{ text: 'Call reply.' }] }],
    tools: [{ functionDeclarations: [tools[0].functionDeclarations[0]] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['reply'] } },
  })
  assert.equal(hostPayloads[0].body.toolConfig.functionCallingConfig.mode, 'ANY')
  assert.deepEqual(hostPayloads[0].body.toolConfig.functionCallingConfig.allowedFunctionNames, ['reply'])
  assert.doesNotMatch(r1.bodyText(), /"finishReason"\s*:\s*"STOP"/)
  assert.match(r1.bodyText(), /gemini_tool_call_required/)
  assert.equal(logs.at(-1).error_code, 'gemini_tool_call_required')
  assert.equal(logs.at(-1).final_state, 'failed')

  // 2. Streaming ANY (without allowedFunctionNames) + plain-text STOP -> SSE error frame, NO normal STOP.
  const r2 = await callRoute('/v1beta/models/gemini-4-hydrogen-high:streamGenerateContent?alt=sse', {
    contents: [{ role: 'user', parts: [{ text: 'Call any tool.' }] }],
    tools,
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
  })
  assert.equal(hostPayloads[1].body.toolConfig.functionCallingConfig.mode, 'ANY')
  assert.doesNotMatch(r2.bodyText(), /"finishReason"\s*:\s*"STOP"/)
  assert.match(r2.bodyText(), /gemini_tool_call_required/)

  // 3. Non-streaming generateContent ANY + plain-text STOP -> HTTP 502 error.
  const r3 = await callRoute('/v1beta/models/gemini-4-hydrogen-high:generateContent', {
    contents: [{ role: 'user', parts: [{ text: 'Call reply.' }] }],
    tools: [{ functionDeclarations: [tools[0].functionDeclarations[0]] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['reply'] } },
  })
  assert.equal(r3.statusCode, 502)
  assert.equal(r3.jsonBody().error.details[0].reason, 'gemini_tool_call_required')
  assert.equal(logs.at(-1).final_state, 'failed')

  // 4. ANY + disallowed functionCall filtered out by restoreTransform -> 0 allowed tool calls -> error.
  nextChunks = [
    `data: ${JSON.stringify({
      candidates: [
        {
          content: { role: 'model', parts: [{ functionCall: { name: 'tool_search', args: { q: 'x' } } }] },
          finishReason: 'STOP',
        },
      ],
    })}\n\n`,
  ]
  const r4 = await callRoute('/v1beta/models/gemini-4-hydrogen-high:generateContent', {
    contents: [{ role: 'user', parts: [{ text: 'Call reply only.' }] }],
    tools,
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['reply'] } },
  })
  assert.equal(r4.statusCode, 502)
  assert.equal(r4.jsonBody().error.details[0].reason, 'gemini_tool_call_required')

  // Contract violations must NOT trip the account's infrastructure circuit breaker.
  assert.equal(circuitFailures, 0)
  assert.equal(circuitProbesReleased, 4)

  // 5. Positive control: ANY + valid functionCall -> HTTP 200 with functionCall preserved.
  nextChunks = [
    `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'reply', args: { content: 'probe' } } }],
          },
          finishReason: 'STOP',
        },
      ],
    })}\n\n`,
  ]
  const r5 = await callRoute('/v1beta/models/gemini-4-hydrogen-high:streamGenerateContent?alt=sse', {
    contents: [{ role: 'user', parts: [{ text: 'Call reply.' }] }],
    tools: [{ functionDeclarations: [tools[0].functionDeclarations[0]] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['reply'] } },
  })
  assert.equal(r5.statusCode, 200)
  assert.match(r5.bodyText(), /"functionCall"/)
  assert.match(r5.bodyText(), /"finishReason":"STOP"/)
  assert.equal(logs.at(-1).final_state, 'verified')

  // 6. Positive control: AUTO + plain-text STOP -> HTTP 200 normal STOP preserved.
  nextChunks = [
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'plain text ok' }] }, finishReason: 'STOP' }],
    })}\n\n`,
  ]
  const r6 = await callRoute('/v1beta/models/gemini-4-hydrogen-high:streamGenerateContent?alt=sse', {
    contents: [{ role: 'user', parts: [{ text: 'Just say hi.' }] }],
    tools,
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
  })
  assert.equal(r6.statusCode, 200)
  assert.match(r6.bodyText(), /plain text ok/)
  assert.match(r6.bodyText(), /"finishReason":"STOP"/)
  assert.equal(logs.at(-1).final_state, 'verified')
})
