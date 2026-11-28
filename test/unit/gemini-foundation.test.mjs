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
import { createGeminiScheduler as createRawGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { FULL_GEMINI_CAPABILITIES, NATIVE_TUI_CAPABILITIES } from '../../src/lib/protocol/gemini-convert.mjs'
import { SchedulerApiError } from '../../src/lib/transport/scheduler-client.mjs'
import fs from 'node:fs'
import {
  createDirectCragClient,
  mapCragWorkerError,
  prepareDirectNativeTurnBody,
  targetSupportsProviderResult,
  targetSupportsWireProtocol,
} from '../../src/lib/gemini/direct-client.mjs'
import { isAntigravityRoutedModel, parseAntigravityModelSpec } from '../../src/lib/gemini/model-catalog.mjs'
import { resolveSchedulerIdentity } from '../../src/lib/identity/identity-rewrite.mjs'
import { firstUserFingerprint, isShortProbeRequest } from '../../src/lib/pool/sticky-router.mjs'
import {
  buildGeminiRequest,
  createGeminiEventDecoder,
  createGeminiRestoreTransform,
  parseInboundToGemini,
} from '../../src/lib/protocol/gemini-convert.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { handleUserCountTokens } from '../../src/lib/protocol/user-count-tokens.mjs'

function makeMockGeminiRuntime({ now = () => Date.now(), quotaCooldownMs = 60_000, poolScheduler = null } = {}) {
  let seq = 0
  const stickyBySession = new Map()
  const activeLeases = new Map()
  const modelCooldowns = new Map()
  const failures = []

  const noteFailure = (rec, failure) => {
    if (!rec || !failure) return
    failures.push({ nodeKey: rec.nodeKey, model: rec.model, failure })
    if (failure.error_class === 'rate_limit' || failure.error_class === 'quota_exhausted') {
      const waitMs =
        Number.isFinite(failure.retry_after_sec) && failure.retry_after_sec > 0
          ? failure.retry_after_sec * 1000
          : quotaCooldownMs
      if (waitMs > 0) {
        modelCooldowns.set(`${rec.nodeKey}:${rec.model}`, now() + waitMs)
      }
    }
  }

  return {
    failures,
    modelCooldowns,
    stickyBySession,
    async acquireNode(params) {
      const ts = now()
      const excluded = new Set(params.excludeNodes || [])
      const allowed = (Array.isArray(params.allowedNodeKeys) ? params.allowedNodeKeys : []).filter((k) => {
        if (excluded.has(k)) return false
        const id = k.split(':').slice(1).join(':')
        if (poolScheduler?.unitCircuit?.inspect?.(`gemini:${id}`)?.ok === false) return false
        return true
      })
      if (!allowed.length) {
        throw new SchedulerApiError({
          status: 429,
          code: 'pool_exhausted',
          message: 'No gemini environment available',
          retryAfterSec: 5,
        })
      }
      const model = String(params.model || '')
      const cooldownUntil = (k) => {
        const until = modelCooldowns.get(`${k}:${model}`) || 0
        return until > ts ? until : 0
      }
      const uncooled = allowed.filter((k) => !cooldownUntil(k))
      let chosen = null
      let why = 'balanced'
      const pinned = params.sessionId ? stickyBySession.get(params.sessionId) : null
      if (uncooled.length) {
        if (pinned && uncooled.includes(pinned)) {
          chosen = pinned
          why = 'session_sticky'
        } else if (poolScheduler?.lastUsed?.size) {
          const sorted = [...uncooled].sort((a, b) => {
            const idA = `gemini:${a.split(':').slice(1).join(':')}`
            const idB = `gemini:${b.split(':').slice(1).join(':')}`
            return (poolScheduler.lastUsed.get(idA) || 0) - (poolScheduler.lastUsed.get(idB) || 0) || a.localeCompare(b)
          })
          chosen = sorted[0]
        } else {
          chosen = uncooled[0]
        }
      } else {
        const sortedCooled = [...allowed].sort((a, b) => cooldownUntil(a) - cooldownUntil(b) || a.localeCompare(b))
        chosen = sortedCooled[0]
        why = 'cooldown_fallback'
      }
      const id = chosen.split(':').slice(1).join(':')
      const leaseId = `gem-test-lease-${++seq}`
      activeLeases.set(leaseId, { sessionId: params.sessionId || null, nodeKey: chosen, model })
      return {
        lease_id: leaseId,
        lease_ttl_ms: 30_000,
        resolved_pool_id: params.originPoolId || '__default_gemini__',
        selected_node: { node_type: 'gemini_env', node_id: id, node_key: chosen },
        explain: { affinity: { why } },
      }
    },
    async switchNode(body) {
      const rec = activeLeases.get(body.release_lease_id)
      activeLeases.delete(body.release_lease_id)
      noteFailure(rec, body.failure)
      return this.acquireNode(body.next_attempt || {})
    },
    async commitLease(leaseId) {
      const rec = activeLeases.get(leaseId)
      if (rec?.sessionId) stickyBySession.set(rec.sessionId, rec.nodeKey)
    },
    async releaseLease(leaseId, payload) {
      const rec = activeLeases.get(leaseId)
      activeLeases.delete(leaseId)
      if (rec?.sessionId && payload?.outcome === 'ok') {
        stickyBySession.set(rec.sessionId, rec.nodeKey)
      } else if (payload && payload.outcome !== 'ok' && payload.outcome !== 'aborted') {
        noteFailure(rec, payload)
      }
    },
  }
}

function createGeminiScheduler(opts = {}) {
  const runtime = opts.schedulerRuntime || makeMockGeminiRuntime(opts)
  const sched = createRawGeminiScheduler({ schedulerRuntime: runtime, ...opts })
  sched._mockRuntime = runtime
  return sched
}

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
  // 429 actively retries once on the same account with restart_resume before giving up (2 probes, 0 failures).
  assert.equal(tracker.calls.probe.length, 2)

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

test('Google account verification ineligibility returns 403 and counts toward circuit breaker', async () => {
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
  assert.equal(tracker.calls.failure.length, 1)
  assert.equal(tracker.calls.probe.length, 0)
})

test('Gemini upstream 400 counts toward circuit breaker without failover while local unsupported turn and license 403 do not', async () => {
  const tracker = makeCircuitTracker()
  let mode = 'http400'
  let inferCalls = 0
  const scheduler = createGeminiScheduler({
    callHost: async (op, input) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-a',
              proxy_id: 'proxy-1',
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              models: ['gemini-3-flash'],
              capabilities: [...NATIVE_TUI_CAPABILITIES],
            },
            {
              id: 'env-b',
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
      if (op === 'get') return { id: input.id, proxy_id: 'proxy-1', auth_method: 'oauth' }
      throw new Error(`unexpected op: ${op}`)
    },
    callHostStream: async () => {
      inferCalls += 1
      if (mode === 'http400') {
        return sseResponse([JSON.stringify({ code: 'gemini_invalid_request', message: 'bad upstream request' })], {
          statusCode: 400,
          contentType: 'application/json',
        })
      }
      if (mode === 'unsupported') {
        return sseResponse([JSON.stringify({ code: 'gemini_unsupported_turn' })], {
          statusCode: 400,
          contentType: 'application/json',
        })
      }
      return sseResponse([JSON.stringify({ code: 'license_required' })], {
        statusCode: 403,
        contentType: 'application/json',
      })
    },
    resolveProxy: () => 'socks5h://1.2.3.4:1080',
    poolScheduler: tracker,
  })
  const handler = createGeminiPublicHandler({ json: jsonResponder, readBody: async () => ({}), scheduler })

  // 1. Upstream 400 returns 400 without failover and records circuit failure.
  const res400 = makeRes()
  await handler(
    makeReq({
      url: '/v1/chat/completions',
      body: { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'hello' }] },
    }),
    res400,
  )
  assert.equal(res400.statusCode, 400)
  assert.equal(res400.jsonBody().error.code, 'gemini_invalid_request')
  assert.equal(inferCalls, 1)
  assert.equal(tracker.calls.failure.length, 1)

  // 2. Local unsupported turn 400 does NOT record circuit failure.
  mode = 'unsupported'
  const resUnsupported = makeRes()
  await handler(
    makeReq({
      url: '/v1/chat/completions',
      body: { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'hello' }] },
    }),
    resUnsupported,
  )
  assert.equal(resUnsupported.statusCode, 400)
  assert.equal(tracker.calls.failure.length, 1)
  assert.equal(tracker.calls.probe.length, 1)

  // 3. Local license 403 does NOT record circuit failure.
  mode = 'license'
  const resLicense = makeRes()
  await handler(
    makeReq({
      url: '/v1/chat/completions',
      body: { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'hello' }] },
    }),
    resLicense,
  )
  assert.equal(resLicense.statusCode, 403)
  assert.equal(tracker.calls.failure.length, 1)
  assert.equal(tracker.calls.probe.length, 2)
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

  // Turn 1: lands on env-a, derives tenant-scoped deterministic outbound conversation_id C1 (!== raw callerConv).
  const r1 = await postChat([{ role: 'user', content: 'Start project alpha' }])
  const t1 = calls[calls.length - 1]
  assert.equal(t1.id, 'env-a')
  assert.match(t1.convId, /^cs_[a-f0-9]{24}$/)
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

  // Turn 3: env-a hits 429 -> intra-request failover to env-b MUST derive recovery conversation_id C2 !== C1
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
  assert.equal(
    t3Attempts.length,
    3,
    'intra-request 429 failover retries env-a once with restart_resume then switches to env-b',
  )
  assert.equal(t3Attempts[0].id, 'env-a')
  assert.equal(t3Attempts[0].convId, c1)
  assert.equal(t3Attempts[1].id, 'env-a')
  assert.equal(t3Attempts[1].convId, c1, 'same-account 429 retry keeps conv id for agy resume')
  assert.equal(t3Attempts[2].id, 'env-b')
  const c2 = t3Attempts[2].convId
  assert.equal(c2, `${c1}:r1`)
  assert.notEqual(c2, c1, 'account switch env-a -> env-b must derive a new recovery conversation_id')
  assert.equal(t3Attempts[2].body.contents.length, 5, 'failover target must receive full history for continuity')

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
  // MUST derive a 3rd recovery conversation_id C3 !== C2 AND C3 !== C1!
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
  assert.equal(c3, `${c1}:r2`)
  assert.notEqual(c3, c2, 'switch back env-b -> env-a must not reuse env-b conversation_id')
  assert.notEqual(
    c3,
    c1,
    'returning to previously used env-a must derive a fresh recovery conversation_id (not stale C1)',
  )
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
  assert.equal(calls.length, 4)
  assert.equal(calls[1].id, 'env-a')
  assert.equal(calls[1].convId, 'conv_mcp_orig_7', 'first attempt should target suspended env-a with original conv id')
  assert.equal(calls[2].id, 'env-a')
  assert.equal(calls[2].convId, 'conv_mcp_orig_7', '429 restart_resume retry stays on env-a with same conv id')
  assert.equal(calls[3].id, 'env-b')
  const envBConvId = calls[3].convId
  assert.match(envBConvId, /:r\d+$/)
  assert.notEqual(envBConvId, 'conv_mcp_orig_7', 'failover account must never inherit suspended account conv id')
  assert.notEqual(envBConvId, calls[0].convId)
  assert.equal(calls[3].body.contents.length, 3, 'failover account must receive full tool history')

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

test('publicError sanitizes HOST_INFRASTRUCTURE_CODES details/retryAfter while forwarding over-limit metadata', async () => {
  const infraErr = Object.assign(new Error('ENOENT /run/private-gemini.sock'), {
    code: 'gemini_host_socket_missing',
    status: 503,
    details: { socket_path: '/run/private-gemini.sock' },
    retryAfter: 30,
  })
  const overlimitErr = Object.assign(new Error('API key rate limit exceeded (2/min)'), {
    code: 'api_key_rate_limit',
    status: 429,
    details: {
      limit_type: 'rpm',
      current: 2,
      limit: 2,
      remaining: 0,
      reset_at: '2026-11-24T12:01:00.000Z',
      retry_after: 12,
    },
    retryAfter: 12,
  })

  for (const mode of ['complete', 'stream']) {
    let nextErr = infraErr
    const scheduler = {
      catalog: async () => ({ models: ['gemini-2.5-pro'], environments: [] }),
      ...(mode === 'complete'
        ? {
            complete: async () => {
              throw nextErr
            },
          }
        : {
            stream: async () => {
              throw nextErr
            },
          }),
    }
    const handler = createGeminiPublicHandler({
      json: jsonResponder,
      readBody: async (r) => r.body || {},
      scheduler,
    })

    // 1. Infrastructure error must be sanitized: 503 gemini_host_unavailable, no details, no Retry-After.
    nextErr = infraErr
    const resInfra = makeRes()
    await handler(
      makeReq({
        url: '/v1/chat/completions',
        body: { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] },
      }),
      resInfra,
    )
    assert.equal(resInfra.statusCode, 503)
    assert.equal(resInfra.headers['retry-after'], undefined)
    const infraBody = resInfra.jsonBody()
    assert.equal(infraBody.error.code, 'gemini_host_unavailable')
    assert.equal(infraBody.error.details, undefined)
    assert.doesNotMatch(resInfra.bodyText(), /private-gemini\.sock/)

    // 2. Non-infrastructure over-limit error preserves status, Retry-After, and details.
    nextErr = overlimitErr
    const resLimit = makeRes()
    await handler(
      makeReq({
        url: '/v1/chat/completions',
        body: { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] },
      }),
      resLimit,
    )
    assert.equal(resLimit.statusCode, 429)
    assert.equal(resLimit.headers['retry-after'], '12')
    const limitBody = resLimit.jsonBody()
    assert.equal(limitBody.error.code, 'api_key_rate_limit')
    assert.equal(limitBody.error.type, 'rate_limit_error')
    assert.equal(limitBody.error.details.limit_type, 'rpm')
    assert.equal(limitBody.error.details.current, 2)
    assert.equal(limitBody.error.details.limit, 2)
  }
})

test('Gemini scheduler fails over pre-output 502/504, falls back to reactive-cooled accounts, and records attemptsRepo + hop_meta', async () => {
  let clock = 1_700_000_000_000
  const futureReset = new Date(clock + 3_600_000).toISOString()
  const envs = [
    {
      id: 'env-a',
      proxy_id: 'px-1',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-4-neon-high'],
      capabilities: [...FULL_GEMINI_CAPABILITIES],
      account: { state: 'ok', quotas: [], quota_groups: [] },
    },
    {
      id: 'env-b',
      proxy_id: 'px-2',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-4-neon-high'],
      capabilities: [...FULL_GEMINI_CAPABILITIES],
      account: { state: 'ok', quotas: [], quota_groups: [] },
    },
    {
      id: 'env-zero',
      proxy_id: 'px-3',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-4-neon-high'],
      capabilities: [...FULL_GEMINI_CAPABILITIES],
      account: {
        state: 'ok',
        quotas: [{ model: 'gemini-4-neon-high', remaining_fraction: 0, reset_at: futureReset }],
        quota_groups: [],
      },
    },
  ]

  const recordedAttempts = []
  const fakeAttemptsRepo = {
    begin(entry) {
      recordedAttempts.push({ ...entry, completed: null })
    },
    complete(requestId, attemptNo, result) {
      const row = recordedAttempts.find((r) => r.requestId === requestId && r.attemptNo === attemptNo)
      if (row) row.completed = result
    },
  }

  let scenario = '502-then-ok'
  const calls = []
  const scheduler = createGeminiScheduler({
    now: () => clock,
    quotaCooldownMs: 60_000,
    attemptsRepo: fakeAttemptsRepo,
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return envs.find((e) => e.id === payload.id)
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async (_op, payload) => {
      calls.push({ id: payload.id, convId: payload.body?.conversation_id })
      if (scenario === '502-then-ok') {
        if (payload.id === 'env-a') {
          return sseResponse([JSON.stringify({ code: 'gemini_inference_failed', message: 'bridge lost' })], {
            statusCode: 502,
            contentType: 'application/json',
          })
        }
        return sseResponse([
          `data: ${JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'recovered-from-502' }] }, finishReason: 'STOP' }],
          })}\n\n`,
        ])
      }
      if (scenario === 'midstream-502') {
        return sseResponse([
          `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'partial-' }] } }] })}\n\n`,
          `data: ${JSON.stringify({ error: { code: 502, message: 'midstream drop' } })}\n\n`,
        ])
      }
      if (scenario === 'cool-a-only') {
        if (payload.id === 'env-a') {
          return sseResponse([JSON.stringify({ code: 'gemini_quota_exhausted', message: '429 a' })], {
            statusCode: 429,
            contentType: 'application/json',
          })
        }
        return sseResponse([
          `data: ${JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'b-ok' }] }, finishReason: 'STOP' }],
          })}\n\n`,
        ])
      }
      if (scenario === 'b-429-fallback-to-reactive-a') {
        if (payload.id === 'env-b') {
          return sseResponse([JSON.stringify({ code: 'gemini_quota_exhausted', message: '429 b' })], {
            statusCode: 429,
            contentType: 'application/json',
          })
        }
        return sseResponse([
          `data: ${JSON.stringify({
            candidates: [
              { content: { role: 'model', parts: [{ text: 'a-recovered-from-cooldown' }] }, finishReason: 'STOP' },
            ],
          })}\n\n`,
        ])
      }
      throw new Error(`unknown scenario ${scenario}`)
    },
    resolveProxy: () => 'socks5h://192.0.2.10:1080',
  })

  // 1. Pre-output 502 on env-a fails over cleanly to env-b with a distinct conversation_id & full attemptsRepo log.
  const t1 = await scheduler.stream({
    requestId: 'req-502-failover',
    model: 'gemini-4-neon-high',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    stickyKey: 'key:sess-502',
    apiKeyRecord: { id: 'k1', group_type: 'gemini' },
  })
  assert.equal(t1.account_id, 'env-b')
  assert.equal(t1.text, 'recovered-from-502')
  assert.equal(t1.attempt_count, 2)
  assert.equal(t1.attempts.length, 2)
  assert.equal(t1.attempts[0].account_id, 'env-a')
  assert.equal(t1.attempts[0].upstream_status, 502)
  assert.equal(t1.attempts[0].action, 'failover')
  assert.equal(t1.attempts[1].account_id, 'env-b')
  assert.equal(t1.attempts[1].action, 'ok')
  assert.notEqual(calls[0].convId, calls[1].convId, '502 failover must mint a fresh conversation_id')
  const rows1 = recordedAttempts.filter((r) => r.requestId === 'req-502-failover')
  assert.equal(rows1.length, 2)
  assert.equal(rows1[0].completed.terminalState, 'failed_retryable')
  assert.equal(rows1[1].completed.terminalState, 'verified')

  // 2. Mid-stream 502 after partial output MUST NOT failover or duplicate output.
  scenario = 'midstream-502'
  const beforeMid = calls.length
  await assert.rejects(
    () =>
      scheduler.stream({
        requestId: 'req-mid-502',
        model: 'gemini-4-neon-high',
        geminiBody: { contents: [{ role: 'user', parts: [{ text: 'mid' }] }] },
        apiKeyRecord: { id: 'k1', group_type: 'gemini' },
      }),
    (err) => err.code === 'gemini_inference_failed' && err.attemptCount === 1,
  )
  assert.equal(calls.length, beforeMid + 1, 'mid-stream 502 must not failover')

  // 3. Reactive 429 on env-a cools env-a (60s), then on next turn if uncooled env-b ALSO 429s,
  // scheduler falls back to reactive-cooled env-a while STILL skipping proactively-exhausted env-zero!
  scenario = 'cool-a-only'
  const t3 = await scheduler.stream({
    requestId: 'req-cool-a',
    model: 'gemini-4-neon-high',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'trigger cool a' }] }] },
    apiKeyRecord: { id: 'k1', group_type: 'gemini' },
  })
  assert.equal(t3.account_id, 'env-b')

  clock += 5_000
  scenario = 'b-429-fallback-to-reactive-a'
  const beforeFb = calls.length
  const t4 = await scheduler.stream({
    requestId: 'req-fb-reactive',
    model: 'gemini-4-neon-high',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'try fallback' }] }] },
    apiKeyRecord: { id: 'k1', group_type: 'gemini' },
  })
  assert.equal(t4.account_id, 'env-a')
  assert.equal(t4.text, 'a-recovered-from-cooldown')
  assert.equal(t4.attempt_count, 3)
  assert.deepEqual(
    calls.slice(beforeFb).map((c) => c.id),
    ['env-b', 'env-b', 'env-a'],
    'must try uncooled env-b (with 1 restart_resume retry on 429) first, then fall back to reactive-cooled env-a, never touching 0% env-zero',
  )
  assert.equal(t4.attempts[2].selection_reason, 'cooldown_fallback')
})

test('429 failover: pre-content SSE meta/start error switches accounts, preserves earliest-expiry order in all_cooled_probe, honors retry_after_ms, and scopes cooldown per model', async () => {
  let clock = 1_750_000_000_000
  const envs = [
    {
      id: 'env-a',
      proxy_id: 'px-a',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-4-neon-xhigh', 'gemini-4-hydrogen-high'],
      capabilities: [...NATIVE_TUI_CAPABILITIES],
      account: { state: 'ok', quotas: [], quota_groups: [] },
    },
    {
      id: 'env-b',
      proxy_id: 'px-b',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-4-neon-xhigh', 'gemini-4-hydrogen-high'],
      capabilities: [...NATIVE_TUI_CAPABILITIES],
      account: { state: 'ok', quotas: [], quota_groups: [] },
    },
    {
      id: 'env-c',
      proxy_id: 'px-c',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-4-neon-xhigh', 'gemini-4-hydrogen-high'],
      capabilities: [...NATIVE_TUI_CAPABILITIES],
      account: { state: 'ok', quotas: [], quota_groups: [] },
    },
  ]

  // Pool scheduler with biased lastUsed (env-c used most recently, env-a never used)
  const tracker = makeCircuitTracker()
  tracker.lastUsed.set('gemini:env-c', clock - 1_000)
  tracker.lastUsed.set('gemini:env-b', clock - 2_000)
  tracker.lastUsed.set('gemini:env-a', 0)
  tracker.reserveExternalCandidates = (candidates, { excluded }) => {
    const avail = candidates
      .filter((c) => !excluded.has(c.accountId))
      .sort(
        (l, r) =>
          (tracker.lastUsed.get(l.accountId) || 0) - (tracker.lastUsed.get(r.accountId) || 0) ||
          l.accountId.localeCompare(r.accountId),
      )
    return avail[0] ? { selected: avail[0], reservation: { release() {} } } : null
  }

  let mode = 'preContentSse429OnA'
  const calls = []
  const scheduler = createGeminiScheduler({
    now: () => clock,
    quotaCooldownMs: 60_000,
    poolScheduler: tracker,
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return envs.find((e) => e.id === payload.id)
      if (op === 'infer-cancel') return { cancelled: true }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async (_op, payload) => {
      calls.push({ id: payload.id, model: payload.model })
      if (mode === 'preContentSse429OnA' && payload.id === 'env-a') {
        // Upstream emits a metadata-only SSE chunk (triggers decoder `start` + `meta` without any
        // content bytes written to downstream google.gemini stream) followed by SSE 429 error!
        return sseResponse([
          `data: ${JSON.stringify({
            responseId: 'r-pre-429',
            modelVersion: 'gemini-4-neon-xhigh',
            craggeminiMeta: { conversation_id: payload.body?.conversation_id || 'gc_1' },
            candidates: [],
          })}\n\n`,
          `data: ${JSON.stringify({
            error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'model capacity' },
          })}\n\n`,
        ])
      }
      if (mode === 'all429WithRetryAfter') {
        const retryMs = payload.id === 'env-a' ? 90_000 : payload.id === 'env-b' ? 15_000 : 45_000
        return sseResponse(
          [JSON.stringify({ code: 'gemini_quota_exhausted', message: '429', retry_after_ms: retryMs })],
          { statusCode: 429, contentType: 'application/json' },
        )
      }
      if (mode === 'probeOrderCheck') {
        return sseResponse([JSON.stringify({ code: 'gemini_quota_exhausted', message: 'still 429' })], {
          statusCode: 429,
          contentType: 'application/json',
        })
      }
      return sseResponse([
        `data: ${JSON.stringify({
          candidates: [
            { content: { role: 'model', parts: [{ text: `ok-from-${payload.id}` }] }, finishReason: 'STOP' },
          ],
        })}\n\n`,
      ])
    },
    resolveProxy: () => 'socks5h://192.0.2.10:1080',
  })

  const handler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async () => ({}),
    scheduler,
  })

  // 1. Streaming /v1beta/...:streamGenerateContent where env-a emits start+meta then SSE 429 MUST switch to env-b!
  const res1 = makeRes()
  await handler(
    makeReq({
      url: '/v1beta/models/gemini-4-neon-xhigh:streamGenerateContent',
      body: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    }),
    res1,
  )
  assert.equal(res1.statusCode, 200)
  assert.match(res1.bodyText(), /ok-from-env-b/)
  assert.deepEqual(
    calls.map((c) => c.id),
    ['env-a', 'env-a', 'env-b'],
    'pre-content start/meta SSE 429 retries env-a once with restart_resume then switches to env-b',
  )

  // 2. Sibling Gemini model (gemini-4-hydrogen-high) on env-a MUST NOT be poisoned by gemini-4-neon-xhigh 429!
  assert.ok(scheduler._mockRuntime.modelCooldowns.get('gemini_env:env-a:gemini-4-neon-xhigh') > clock)
  assert.equal(scheduler._mockRuntime.modelCooldowns.get('gemini_env:env-a:gemini-4-hydrogen-high'), undefined)

  const beforeSibling = calls.length
  const sibTurn = await scheduler.stream({
    model: 'gemini-4-hydrogen-high',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'sibling ok' }] }] },
    apiKeyRecord: { id: 'k1', group_type: 'gemini' },
  })
  assert.equal(sibTurn.account_id, 'env-c', 'uncooled env-c/env-a remain eligible for sibling model')
  assert.equal(calls.length, beforeSibling + 1)

  // 3. When all accounts 429 with distinct retry_after_ms, all_cooled_probe MUST try earliest-expiry first
  // (env-b @ +15s, then env-c @ +45s, then env-a @ +90s) even when poolScheduler.lastUsed prefers another order!
  clock += 70_000
  mode = 'all429WithRetryAfter'
  await assert.rejects(
    () =>
      scheduler.stream({
        model: 'gemini-4-neon-xhigh',
        geminiBody: { contents: [{ role: 'user', parts: [{ text: 'cool all' }] }] },
        apiKeyRecord: { id: 'k1', group_type: 'gemini' },
      }),
    (err) => err.code === 'gemini_quota_exhausted' && err.attemptCount === 6,
  )
  assert.equal(scheduler._mockRuntime.modelCooldowns.get('gemini_env:env-b:gemini-4-neon-xhigh'), clock + 15_000)
  assert.equal(scheduler._mockRuntime.modelCooldowns.get('gemini_env:env-c:gemini-4-neon-xhigh'), clock + 45_000)
  assert.equal(scheduler._mockRuntime.modelCooldowns.get('gemini_env:env-a:gemini-4-neon-xhigh'), clock + 90_000)

  // Bias poolScheduler.lastUsed heavily toward env-a; all_cooled_probe must STILL probe earliest expiry first!
  tracker.lastUsed.set('gemini:env-a', 1)
  tracker.lastUsed.set('gemini:env-b', clock + 100)
  tracker.lastUsed.set('gemini:env-c', clock + 50)
  clock += 5_000
  mode = 'probeOrderCheck'
  const beforeProbe = calls.length
  await assert.rejects(
    () =>
      scheduler.stream({
        model: 'gemini-4-neon-xhigh',
        geminiBody: { contents: [{ role: 'user', parts: [{ text: 'probe order' }] }] },
        apiKeyRecord: { id: 'k1', group_type: 'gemini' },
      }),
    (err) => err.code === 'gemini_quota_exhausted' && err.attemptCount === 3,
  )
  assert.deepEqual(
    calls.slice(beforeProbe).map((c) => c.id),
    ['env-b', 'env-c', 'env-a'],
    'all_cooled_probe must preserve earliest cooldown expiry order instead of stale lastUsed/alphabetical order',
  )
})

test('CRAGGemini gemini-4-carbon-high forwards high thinkingConfig and returns detailed thinking by default across all 4 protocols', async () => {
  const inferCalls = []
  const scheduler = createGeminiScheduler({
    callHost: async (op, payload) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-carbon',
              proxy_id: 'proxy-carbon',
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              // Only untiered `gemini-4-carbon` in catalog: `gemini-4-carbon-high` must resolve and forward `thinkingLevel: 'high'`!
              models: ['gemini-4-carbon'],
              capabilities: [...NATIVE_TUI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get') return { id: payload.id, proxy_id: 'proxy-carbon', auth_method: 'oauth' }
      throw new Error(`unexpected op: ${op}`)
    },
    callHostStream: async (_op, payload) => {
      inferCalls.push(payload)
      return sseResponse([
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ thought: true, text: 'Detailed agy thinking trace.' }],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { thought: true, text: '', thoughtSignature: 'sig_carbon_high_1' },
                  { text: 'Verified answer.' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 8,
            totalTokenCount: 22,
          },
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

  const cases = [
    {
      name: 'gemini',
      url: '/v1beta/models/gemini-4-carbon-high:generateContent',
      body: { contents: [{ role: 'user', parts: [{ text: 'Check carbon high' }] }] },
      verify: (out) => {
        assert.equal(out.candidates[0].content.parts[0].thought, true)
        assert.equal(out.candidates[0].content.parts[0].text, 'Detailed agy thinking trace.')
        assert.equal(out.candidates[0].content.parts[0].thoughtSignature, 'sig_carbon_high_1')
        assert.equal(out.candidates[0].content.parts[1].text, 'Verified answer.')
      },
    },
    {
      name: 'openai-chat',
      url: '/v1/chat/completions',
      body: {
        model: 'gemini-4-carbon-high',
        messages: [{ role: 'user', content: 'Check carbon high' }],
      },
      verify: (out) => {
        assert.equal(out.model, 'gemini-4-carbon-high')
        assert.equal(out.choices[0].message.reasoning_content, 'Detailed agy thinking trace.')
        assert.equal(out.choices[0].message.content, 'Verified answer.')
        assert.equal(out.usage.completion_tokens_details.reasoning_tokens, 8)
      },
    },
    {
      name: 'openai-responses',
      url: '/v1/responses',
      body: {
        model: 'gemini-4-carbon-high',
        include: ['reasoning.encrypted_content'],
        input: 'Check carbon high',
      },
      verify: (out) => {
        assert.equal(out.model, 'gemini-4-carbon-high')
        assert.equal(out.output[0].type, 'reasoning')
        assert.equal(out.output[0].summary[0].text, 'Detailed agy thinking trace.')
        assert.equal(out.output[0].encrypted_content, 'sig_carbon_high_1')
        assert.equal(out.output[1].content[0].text, 'Verified answer.')
      },
    },
    {
      name: 'anthropic',
      url: '/v1/messages',
      body: {
        model: 'gemini-4-carbon-high',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Check carbon high' }],
      },
      verify: (out) => {
        assert.equal(out.model, 'gemini-4-carbon-high')
        assert.deepEqual(out.content[0], {
          type: 'thinking',
          thinking: 'Detailed agy thinking trace.',
          signature: 'sig_carbon_high_1',
        })
        assert.deepEqual(out.content[1], {
          type: 'text',
          text: 'Verified answer.',
        })
      },
    },
  ]

  for (const c of cases) {
    const res = makeRes()
    await handler(makeReq({ method: 'POST', url: c.url, body: c.body }), res)
    assert.equal(res.statusCode, 200, `[${c.name}] HTTP 200`)
    const sent = inferCalls[inferCalls.length - 1]
    assert.deepEqual(
      sent.body.generationConfig,
      {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: 'high',
        },
      },
      `[${c.name}] CRAGGemini receives high thinkingConfig`,
    )
    c.verify(res.jsonBody())
  }
})

test('429 classification & perf: catalogSnapshot avoids double list, content_rejected skips cooldown/failover, QUOTA_EXHAUSTED cools group with Google retryDelay, short RPM retries same account once', async () => {
  const mockSseResponse = (statusCode, contentType, chunks) => ({
    statusCode,
    headers: { 'content-type': contentType },
    destroy() {},
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield Buffer.from(c)
    },
  })
  let clock = 1_800_000_000_000
  let listCalls = 0
  const inferCalls = []
  let scenario = 'content_rejected'
  let shortAttempts = 0

  const envs = [
    {
      id: 'env-1',
      name: 'Env 1',
      proxy_id: 'px-1',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-3-pro', 'gemini-3-flash'],
      capabilities: ['streaming', 'multi_turn'],
      account: { state: 'ok', quotas: [], quota_groups: [] },
    },
    {
      id: 'env-2',
      name: 'Env 2',
      proxy_id: 'px-2',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-3-pro', 'gemini-3-flash'],
      capabilities: ['streaming', 'multi_turn'],
      account: { state: 'ok', quotas: [], quota_groups: [] },
    },
  ]

  const callHost = async (op, payload) => {
    if (op === 'list') {
      listCalls += 1
      return { payload_state: 'installed', environments: envs }
    }
    if (op === 'get') return envs.find((e) => e.id === payload.id)
    if (op === 'infer-cancel') return { cancelled: true }
    throw new Error(`unexpected op ${op}`)
  }

  const callHostStream = async (_op, payload) => {
    inferCalls.push({ id: payload.id, model: payload.model })
    if (scenario === 'content_rejected') {
      return mockSseResponse(429, 'application/json', [
        JSON.stringify({
          code: 'gemini_content_rejected',
          content_rejected: true,
          message: 'prompt rejected by upstream',
        }),
      ])
    }
    if (scenario === 'quota_exhausted_group') {
      if (payload.id === 'env-1') {
        return mockSseResponse(429, 'application/json', [
          JSON.stringify({
            code: 'gemini_quota_exhausted',
            upstream_reason: 'QUOTA_EXHAUSTED',
            error: {
              details: [{ reason: 'QUOTA_EXHAUSTED', metadata: { quotaResetDelay: '2m30s' } }],
            },
          }),
        ])
      }
      return mockSseResponse(200, 'text/event-stream', [
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok-env-2' }] }, finishReason: 'STOP' }] })}\n\n`,
      ])
    }
    if (scenario === 'short_rpm_backoff') {
      shortAttempts += 1
      if (shortAttempts === 1) {
        return mockSseResponse(429, 'application/json', [
          JSON.stringify({
            code: 'gemini_quota_exhausted',
            upstream_reason: 'RATE_LIMIT_EXCEEDED',
            retry_after_ms: 20,
          }),
        ])
      }
      return mockSseResponse(200, 'text/event-stream', [
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok-after-short-wait' }] }, finishReason: 'STOP' }] })}\n\n`,
      ])
    }
    throw new Error(`unknown scenario ${scenario}`)
  }

  const scheduler = createGeminiScheduler({
    callHost,
    callHostStream,
    resolveProxy: (id) => `socks5h://198.51.100.10:${id === 'px-1' ? 1080 : 1081}`,
    now: () => clock,
  })

  // 1. Preloaded catalogSnapshot prevents duplicate callHost('list') AND content_rejected does NOT cool or failover.
  const preloaded = await scheduler.catalog()
  assert.equal(listCalls, 1)
  await assert.rejects(
    () =>
      scheduler.stream({
        model: 'gemini-3-pro',
        geminiBody: { contents: [{ role: 'user', parts: [{ text: 'trigger' }] }] },
        apiKeyRecord: { id: 'k1', group_type: 'gemini' },
        catalogSnapshot: preloaded,
      }),
    (err) => err.code === 'gemini_content_rejected' && err.status === 429 && err.attemptCount === 1,
  )
  assert.equal(listCalls, 1, 'passing catalogSnapshot must avoid redundant callHost(list)')
  assert.deepEqual(scheduler.cooldownSnapshot(), { groups: {}, models: {}, accounts: {} })

  // 2. Explicit QUOTA_EXHAUSTED with Google quotaResetDelay reports retry_after_sec=150 to Rust and fails over.
  scenario = 'quota_exhausted_group'
  const res2 = await scheduler.stream({
    model: 'gemini-3-pro',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'quota test' }] }] },
    apiKeyRecord: { id: 'k1', group_type: 'gemini' },
    catalogSnapshot: preloaded,
  })
  assert.equal(res2.account_id, 'env-2')
  assert.equal(scheduler._mockRuntime.modelCooldowns.get('gemini_env:env-1:gemini-3-pro'), clock + 150_000)

  // 3. Short non-quota RPM 429 (<= 5s) retries the same account once before switching.
  clock += 200_000
  scenario = 'short_rpm_backoff'
  inferCalls.length = 0
  const res3 = await scheduler.stream({
    model: 'gemini-3-pro',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'short wait' }] }] },
    apiKeyRecord: { id: 'k1', group_type: 'gemini' },
    catalogSnapshot: preloaded,
  })
  assert.equal(res3.text, 'ok-after-short-wait')
  assert.equal(inferCalls.length, 2)
  assert.equal(inferCalls[0].id, inferCalls[1].id, 'short RPM backoff must retry the same account once')
})

test('Phase 2 perf: catalog TTL cache, single-flight dedup, zero hot-path get, and copy-on-write geminiCamelCase', async () => {
  const { geminiCamelCase } = await import('../../src/lib/protocol/gemini-convert.mjs')
  const alreadyCamel = {
    model: 'gemini-3-pro',
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    generationConfig: { maxOutputTokens: 256 },
  }
  assert.equal(geminiCamelCase(alreadyCamel), alreadyCamel, 'already camelCase tree must avoid cloning')
  const mixedSnake = {
    model: 'gemini-3-pro',
    generation_config: { max_output_tokens: 128 },
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  }
  const converted = geminiCamelCase(mixedSnake)
  assert.equal(converted.generationConfig.maxOutputTokens, 128)
  assert.equal(converted.contents, mixedSnake.contents, 'unchanged subtrees stay shared')

  let clock = 1_750_000_000_000
  let listCalls = 0
  let getCalls = 0
  const env = {
    id: 'env-fast',
    proxy_id: 'px-fast',
    auth_state: 'authorized',
    auth_method: 'oauth',
    models_discovered: true,
    models: ['gemini-3-pro'],
    capabilities: [...NATIVE_TUI_CAPABILITIES],
    account: { state: 'ok', quotas: [] },
  }
  const callHost = async (op) => {
    if (op === 'list') {
      listCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { payload_state: 'installed', environments: [env] }
    }
    if (op === 'get') {
      getCalls += 1
      return env
    }
    throw new Error(`unexpected op ${op}`)
  }
  const callHostStream = async () =>
    sseResponse([
      `data: ${JSON.stringify({
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'fast-ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 },
      })}\n\n`,
    ])

  const scheduler = createGeminiScheduler({
    callHost,
    callHostStream,
    resolveProxy: () => 'socks5h://198.51.100.10:1080',
    listCacheTtlMs: 2000,
    now: () => clock,
  })

  // Concurrent catalog calls coalesce into 1 single-flight host 'list' IPC.
  const [c1, c2, c3] = await Promise.all([scheduler.catalog(), scheduler.catalog(), scheduler.catalog()])
  assert.equal(listCalls, 1, 'concurrent catalog calls must coalesce via single-flight')
  assert.equal(c1.accounts.length, 1)
  assert.equal(c2.accounts.length, 1)
  assert.equal(c3.accounts.length, 1)

  // Streaming within TTL hits cached catalog AND skips redundant host 'get'.
  const res = await scheduler.stream({
    model: 'gemini-3-pro',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
    apiKeyRecord: { id: 'k1', group_type: 'gemini' },
  })
  assert.equal(res.text, 'fast-ok')
  assert.equal(listCalls, 1, 'stream within TTL must reuse cached list')
  assert.equal(getCalls, 0, 'stream hot path must not call redundant host get when catalog has proxy_id')

  // Explicit invalidation forces next catalog read to refresh.
  scheduler.invalidateCatalogCache()
  await scheduler.catalog()
  assert.equal(listCalls, 2)

  // TTL expiration also refreshes.
  clock += 2500
  await scheduler.catalog()
  assert.equal(listCalls, 3)
})

test('P2-B direct Unix socket data plane streams 1-hop from Node to CRAGGemini and falls back transparently', async () => {
  const http = await import('node:http')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { createDirectCragClient } = await import('../../src/lib/gemini/direct-client.mjs')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-direct-'))
  const sockPath = path.join(tmpDir, 'kernel.sock')
  const secretToken = 'd'.repeat(40)
  const receivedPaths = []
  let mode = 'ok'

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      receivedPaths.push({
        method: req.method,
        url: req.url,
        token: req.headers['x-kin-internal-token'],
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
      })
      if (req.headers['x-kin-internal-token'] !== secretToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 'unauthorized' }))
        return
      }
      if (req.url.endsWith('/cancel')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ cancelled: true }))
        return
      }
      if (mode === '429_content_rejected') {
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            code: 'gemini_content_rejected',
            upstream_status: 429,
            content_rejected: true,
            error: 'Prompt rejected by upstream filter',
          }),
        )
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      res.end(
        `data: ${JSON.stringify({
          candidates: [
            { index: 0, content: { role: 'model', parts: [{ text: 'direct-1hop-ok' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
        })}\n\n`,
      )
    })
  })
  await new Promise((resolve) => server.listen(sockPath, resolve))

  let clock = 10_000
  let targetCalls = 0
  let pythonInferCalls = 0
  let target404 = false
  const env = {
    id: 'env-direct-1',
    proxy_id: 'px-direct',
    auth_state: 'authorized',
    auth_method: 'oauth',
    models_discovered: true,
    models: ['gemini-3-pro'],
    capabilities: [...NATIVE_TUI_CAPABILITIES],
    account: { state: 'ok', quotas: [] },
  }

  const callHost = async (op) => {
    if (op === 'list') return { payload_state: 'installed', environments: [env] }
    if (op === 'infer-target') {
      targetCalls += 1
      if (target404) {
        const e = new Error('not_found')
        e.status = 404
        e.code = 'gemini_environment_not_found'
        throw e
      }
      return {
        direct: true,
        kind: 'shard',
        socket_path: sockPath,
        token: secretToken,
        message_path: `/internal/v1/accounts/${env.id}/messages`,
        cancel_path: `/internal/v1/accounts/${env.id}/cancel`,
        account_id: env.id,
        epoch: 'ep-1',
        ttl_ms: 30_000,
      }
    }
    if (op === 'infer-cancel') return { cancelled: true }
    throw new Error(`unexpected op ${op}`)
  }

  const callHostStream = async () => {
    pythonInferCalls += 1
    return sseResponse([
      `data: ${JSON.stringify({
        candidates: [
          { index: 0, content: { role: 'model', parts: [{ text: 'python-fallback-ok' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 },
      })}\n\n`,
    ])
  }

  const directClient = createDirectCragClient({ callHost, now: () => clock })
  const scheduler = createGeminiScheduler({
    callHost,
    callHostStream,
    directClient,
    resolveProxy: () => 'socks5h://198.51.100.10:1080',
    listCacheTtlMs: 2000,
    now: () => clock,
  })

  try {
    // Turn 1 & Turn 2 both stream 1-hop directly over kernel.sock with 0 Python /infer calls,
    // and Turn 2 reuses the cached target with 0 extra /infer-target calls.
    const r1 = await scheduler.stream({
      model: 'gemini-3-pro',
      geminiBody: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'hidden', thought: true }, { text: 'hello direct' }],
          },
        ],
      },
      apiKeyRecord: { id: 'k1', group_type: 'gemini' },
    })
    assert.equal(r1.text, 'direct-1hop-ok')
    assert.equal(targetCalls, 1)
    assert.equal(pythonInferCalls, 0)
    assert.equal(receivedPaths[0].url, `/internal/v1/accounts/${env.id}/messages`)
    assert.equal(receivedPaths[0].body.body.contents[0].parts.length, 1)
    assert.equal(receivedPaths[0].body.body.contents[0].parts[0].text, 'hello direct')

    const r2 = await scheduler.stream({
      model: 'gemini-3-pro',
      geminiBody: { contents: [{ role: 'user', parts: [{ text: 'second warm turn' }] }] },
      apiKeyRecord: { id: 'k1', group_type: 'gemini' },
    })
    assert.equal(r2.text, 'direct-1hop-ok')
    assert.equal(targetCalls, 1, 'second warm turn must reuse cached direct target')
    assert.equal(pythonInferCalls, 0)

    // Structured 429 content_rejected from direct socket maps identically without falling back.
    mode = '429_content_rejected'
    await assert.rejects(
      () =>
        scheduler.stream({
          model: 'gemini-3-pro',
          geminiBody: { contents: [{ role: 'user', parts: [{ text: 'blocked prompt' }] }] },
          apiKeyRecord: { id: 'k1', group_type: 'gemini' },
        }),
      (err) => err?.code === 'gemini_content_rejected' && err?.contentRejected === true && err?.status === 429,
    )
    assert.equal(pythonInferCalls, 0)

    // When kernel.sock disappears (e.g. maintenance quiesce / shard restart), transparent fallback to Python /infer.
    mode = 'ok'
    await new Promise((resolve) => server.close(resolve))
    try {
      fs.unlinkSync(sockPath)
    } catch {}
    const rFallback = await scheduler.stream({
      model: 'gemini-3-pro',
      geminiBody: { contents: [{ role: 'user', parts: [{ text: 'after socket gone' }] }] },
      apiKeyRecord: { id: 'k1', group_type: 'gemini' },
    })
    assert.equal(rFallback.text, 'python-fallback-ok')
    assert.equal(pythonInferCalls, 1, 'missing direct socket must transparently fall back to Python /infer')

    // Older Python host returning 404 on /infer-target disables direct briefly and falls back cleanly.
    target404 = true
    scheduler.invalidateCatalogCache()
    const r404 = await scheduler.stream({
      model: 'gemini-3-pro',
      geminiBody: { contents: [{ role: 'user', parts: [{ text: 'older host' }] }] },
      apiKeyRecord: { id: 'k1', group_type: 'gemini' },
    })
    assert.equal(r404.text, 'python-fallback-ok')
    assert.equal(pythonInferCalls, 2)
  } finally {
    directClient.close()
    try {
      server.close()
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('open unitCircuit surfaces gemini_native_worker_unavailable while genuine slot saturation surfaces pool-busy 503 message', async () => {
  const { PoolScheduler } = await import('../../src/lib/pool/pool-scheduler.mjs')
  const { mapCragWorkerError } = await import('../../src/lib/gemini/direct-client.mjs')

  assert.equal(mapCragWorkerError(503, { code: 'account_circuit_open' }).code, 'gemini_native_worker_unavailable')
  assert.equal(mapCragWorkerError(503, { code: 'queue_full' }).code, 'gemini_operation_busy')

  const env = {
    id: 'gemini-circuit-check-0001',
    proxy_id: 'px-1',
    auth_state: 'authorized',
    auth_method: 'oauth',
    max_concurrency: 1,
    models_discovered: true,
    models: ['gemini-3-pro'],
    capabilities: [...FULL_GEMINI_CAPABILITIES],
  }
  const accountId = `gemini:${env.id}`
  const pool = new PoolScheduler()
  let nowMs = 10_000
  pool.unitCircuit.now = () => nowMs
  pool.unitCircuit.configure({ failureThreshold: 2, openMs: 30_000 })
  pool.unitCircuit.recordFailure(accountId)
  pool.unitCircuit.recordFailure(accountId)
  assert.equal(pool.unitCircuit.inspect(accountId).ok, false)

  const scheduler = createGeminiScheduler({
    poolScheduler: pool,
    now: () => nowMs,
    resolveProxy: () => 'socks5h://127.0.0.1:1080',
    callHost: async (op) => {
      if (op === 'list') return { payload_state: 'installed', environments: [env] }
      if (op === 'get') return env
      throw new Error(`unexpected host op: ${op}`)
    },
  })

  const handle = createGeminiPublicHandler({
    json: (_res, status, body) => ({ status, body }),
    readBody: async (req) => req.body,
    scheduler,
  })

  const circuitRes = await handle(
    {
      method: 'POST',
      url: '/v1beta/models/gemini-3-pro:generateContent',
      body: { contents: [{ role: 'user', parts: [{ text: 'health probe' }] }] },
      apiKeyKind: 'managed',
      apiKeyRecord: { group_type: 'gemini' },
      once() {},
    },
    { setHeader() {}, once() {} },
  )
  assert.equal(circuitRes.status, 429)
  assert.equal(circuitRes.body.error.code, 429)
  assert.equal(circuitRes.body.error.status, 'RESOURCE_EXHAUSTED')
  assert.match(JSON.stringify(circuitRes.body), /负载过高/)

  // Advance past openMs, complete probe -> circuit closed, then simulate Rust pool_exhausted -> 429 High Load.
  nowMs += 30_001
  pool.unitCircuit.admit(accountId)
  pool.unitCircuit.recordSuccess(accountId)
  assert.equal(pool.unitCircuit.inspect(accountId).ok, true)
  const origAcquire = scheduler._mockRuntime.acquireNode
  scheduler._mockRuntime.acquireNode = async () => {
    throw new SchedulerApiError({ status: 429, code: 'pool_exhausted', message: 'Pool exhausted', retryAfterSec: 5 })
  }
  try {
    const busyRes = await handle(
      {
        method: 'POST',
        url: '/v1/chat/completions',
        body: { model: 'gemini-3-pro', messages: [{ role: 'user', content: 'busy check' }] },
        apiKeyKind: 'managed',
        apiKeyRecord: { group_type: 'gemini' },
        once() {},
      },
      { setHeader() {}, once() {} },
    )
    assert.equal(busyRes.status, 429)
    assert.equal(busyRes.body.error.code, 'gemini_pool_overloaded')
    assert.match(busyRes.body.error.message, /负载过高/)
  } finally {
    scheduler._mockRuntime.acquireNode = origAcquire
  }
})

// ===========================================================================
// Claude Code <-> CRAGGemini Boundary & Frozen Wire Contract Regressions
// ===========================================================================

function ccMakeEnv(id, extra = {}) {
  return {
    id,
    proxy_id: `proxy-${id}`,
    auth_state: 'authorized',
    auth_method: 'oauth',
    models_discovered: true,
    models: ['gemini-4-hydrogen-high', 'gemini-4-neon-high', 'gemini-3-pro'],
    capabilities: [...NATIVE_TUI_CAPABILITIES],
    ...extra,
  }
}

function ccMakeSseStream(chunks, headers = {}) {
  const stream = new Readable({ read() {} })
  stream.statusCode = 200
  stream.headers = { 'content-type': 'text/event-stream; charset=utf-8', ...headers }
  process.nextTick(() => {
    for (const c of chunks) stream.push(c)
    stream.push(null)
  })
  return stream
}

function ccMakeReq({
  method = 'POST',
  url = '/v1/messages',
  headers = {},
  body = {},
  apiKeyRecord = null,
  apiKeyKind = 'managed',
}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json', ...headers }
  req.body = body
  req.apiKeyKind = apiKeyKind
  req.apiKeyRecord = apiKeyRecord || { id: 'key-cc', group_type: 'all' }
  return req
}

function ccMakeRes() {
  const chunks = []
  const headers = {}
  const res = new EventEmitter()
  res.statusCode = 200
  res.headersSent = false
  res.writableEnded = false
  res.destroyed = false
  res.writeHead = (code, hdrs = {}) => {
    res.statusCode = code
    res.headersSent = true
    for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v
  }
  res.setHeader = (k, v) => {
    headers[k.toLowerCase()] = v
  }
  res.getHeader = (k) => headers[k.toLowerCase()]
  res.write = (chunk) => {
    res.headersSent = true
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    return true
  }
  res.end = (chunk) => {
    if (chunk !== undefined) res.write(chunk)
    res.headersSent = true
    res.writableEnded = true
    res.emit('finish')
  }
  res.bodyText = () => Buffer.concat(chunks).toString('utf8')
  res.jsonBody = () => JSON.parse(res.bodyText())
  res.headers = headers
  res.chunks = chunks
  return res
}

function ccJsonResponder(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function ccMakeRecordingRuntime(recordedAcquires = []) {
  let seq = 0
  return {
    async acquireNode(params) {
      recordedAcquires.push({ ...params })
      const excluded = new Set(params.excludeNodes || [])
      const allowed = Array.isArray(params.allowedNodeKeys) ? params.allowedNodeKeys : []
      let key = null
      if (params.pinNodeKey && allowed.includes(params.pinNodeKey) && !excluded.has(params.pinNodeKey)) {
        key = params.pinNodeKey
      } else {
        key = allowed.find((k) => !excluded.has(k))
      }
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
        explain: { affinity: { why: params.pinNodeKey === key ? 'pinned' : 'balanced' } },
      }
    },
    async switchNode(body) {
      return this.acquireNode(body.next_attempt || {})
    },
    async commitLease() {},
    async releaseLease() {},
  }
}

// ---------------------------------------------------------------------------
// 1. Frozen Internal Boundary Contract: capabilities, headers, wire passthrough
// ---------------------------------------------------------------------------

test('capabilities negotiation honors protocol_capabilities first and falls back to capabilities array', () => {
  const modernTarget = {
    capabilities: ['internal_wire_protocol_v1'],
    protocolCapabilities: {
      internal_wire_protocols: ['raw', 'gemini', 'anthropic'],
      provider_result_v2: true,
      per_session_mcp: true,
    },
  }
  assert.equal(targetSupportsWireProtocol(modernTarget, 'anthropic'), true)
  assert.equal(targetSupportsWireProtocol(modernTarget, 'gemini'), true)
  assert.equal(targetSupportsWireProtocol(modernTarget, 'raw'), true)
  assert.equal(targetSupportsProviderResult(modernTarget), true)

  const arrayOnlyTarget = {
    capabilities: ['internal_anthropic_wire_v1', 'internal_gemini_wire_v1', 'provider_result_v2'],
    protocolCapabilities: {},
  }
  assert.equal(targetSupportsWireProtocol(arrayOnlyTarget, 'anthropic'), true)
  assert.equal(targetSupportsWireProtocol(arrayOnlyTarget, 'gemini'), true)
  assert.equal(targetSupportsProviderResult(arrayOnlyTarget), true)

  const legacyTarget = { capabilities: [], protocolCapabilities: {} }
  assert.equal(targetSupportsWireProtocol(legacyTarget, 'anthropic'), false)
  assert.equal(targetSupportsWireProtocol(legacyTarget, 'gemini'), false)
  assert.equal(targetSupportsProviderResult(legacyTarget), false)
})

test('directClient openDirectStream emits frozen X-Craggemini-* headers over Unix socket', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-direct-hdr-'))
  const sockPath = path.join(tmpDir, 'worker.sock')
  const captured = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      captured.push({
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      })
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    })
  })
  await new Promise((resolve) => server.listen(sockPath, resolve))
  try {
    const client = createDirectCragClient({
      callHost: async () => ({
        direct: true,
        kind: 'session',
        socket_path: sockPath,
        token: 'a'.repeat(32),
        message_path: '/internal/v1/messages',
        cancel_path: '/internal/v1/cancel',
        env_id: 'env-1',
        capabilities: ['internal_anthropic_wire_v1', 'provider_result_v2'],
        protocol_capabilities: {
          internal_wire_protocols: ['raw', 'gemini', 'anthropic'],
          provider_result_v2: true,
        },
      }),
    })
    const target = await client.resolveTarget({ id: 'env-1', proxyId: 'proxy-1' })
    assert.ok(target)
    assert.equal(targetSupportsWireProtocol(target, 'anthropic'), true)
    assert.equal(targetSupportsProviderResult(target), true)

    const opened = await client.openDirectStream(target, {
      model: 'gemini-4-hydrogen-high',
      requestId: 'req-direct-1',
      bodyObj: {
        model: 'gemini-vm/gemini-4-hydrogen-high',
        max_tokens: 1024,
        system: 'Be exact.',
        messages: [{ role: 'user', content: 'Inspect /mnt/x/vm2api' }],
      },
      wireProtocol: 'anthropic',
      providerResult: true,
      sessionReset: true,
      conversationId: '11111111-2222-4333-8444-555555555555:r1',
    })
    assert.equal(opened.ok, true)
    assert.equal(opened.res.statusCode, 200)
    for await (const _ of opened.res) {
      // drain
    }
    assert.equal(captured.length, 1)
    assert.equal(captured[0].headers['x-craggemini-wire-protocol'], 'anthropic')
    assert.equal(captured[0].headers['x-craggemini-provider-result'], '1')
    assert.equal(captured[0].headers['x-craggemini-session-reset'], '1')
    assert.equal(captured[0].body.conversation_id, '11111111-2222-4333-8444-555555555555:r1')
    assert.equal(captured[0].body.body.model, 'gemini-4-hydrogen-high')
    assert.deepEqual(captured[0].body.body.messages, [{ role: 'user', content: 'Inspect /mnt/x/vm2api' }])
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('Anthropic native passthrough skips IR conversion, strips kin_provider_result, and handles streaming & non-streaming', async () => {
  const envs = [ccMakeEnv('env-anth')]
  const directCalls = []
  let streamFrames = []

  const directClient = {
    async resolveTarget({ id }) {
      return {
        kind: 'session',
        socketPath: '/tmp/fake.sock',
        token: 't'.repeat(32),
        envId: id,
        accountRoute: false,
        capabilities: ['internal_anthropic_wire_v1', 'internal_gemini_wire_v1', 'provider_result_v2'],
        protocolCapabilities: {
          internal_wire_protocols: ['raw', 'gemini', 'anthropic'],
          provider_result_v2: true,
          per_session_mcp: true,
        },
      }
    },
    async openDirectStream(_target, opts) {
      directCalls.push(opts)
      return { ok: true, res: ccMakeSseStream(streamFrames) }
    },
    async cancelDirectTurn() {},
    invalidate() {},
  }

  const scheduler = createRawGeminiScheduler({
    schedulerRuntime: ccMakeRecordingRuntime(),
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return { id: payload.id, proxy_id: `proxy-${payload.id}`, auth_method: 'oauth' }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async () => {
      throw new Error('should use directClient when target supports anthropic wire')
    },
    resolveProxy: () => 'socks5h://127.0.0.1:1080',
    directClient,
  })
  const handler = createGeminiPublicHandler({ json: ccJsonResponder, readBody: async () => ({}), scheduler })

  const sessionUuid = '11111111-2222-4333-8444-555555555555'
  const rawBody = {
    model: 'gemini-vm/gemini-4-hydrogen-high',
    max_tokens: 4096,
    stream: true,
    metadata: { user_id: `user_${'a'.repeat(64)}_account__session_${sessionUuid}` },
    system: [{ type: 'text', text: 'Use Read on /mnt/x/vm2api' }],
    tools: [
      {
        name: 'Read',
        description: 'Read file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    messages: [
      { role: 'user', content: 'Check /mnt/x/vm2api/src/server.mjs' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Checking path', signature: 'sig_keep_me' },
          { type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { path: '/mnt/x/vm2api/src/server.mjs' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_read_1', content: 'ENOENT /mnt/x/vm2api/missing', is_error: true },
          { type: 'text', text: '<system-reminder>stay focused</system-reminder>' },
        ],
      },
    ],
  }

  streamFrames = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_native_1', type: 'message', role: 'assistant', model: 'gemini-4-hydrogen-high', content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'File was missing.' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 45 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    `event: kin_provider_result\ndata: ${JSON.stringify({ conversation_id: sessionUuid, native_conversation_id: 'nc_42', awaiting_tool_results: false, visible_output: true, provider_complete: true, finish_reason: 'end_turn', usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 30 } })}\n\n`,
  ]

  const resStream = ccMakeRes()
  await handler(ccMakeReq({ url: '/v1/messages', body: rawBody }), resStream)
  assert.equal(resStream.statusCode, 200)
  assert.equal(directCalls.length, 1)
  assert.equal(directCalls[0].wireProtocol, 'anthropic')
  assert.equal(directCalls[0].providerResult, true)
  assert.match(directCalls[0].conversationId, /^cs_[a-f0-9]{24}$/)
  assert.notEqual(directCalls[0].conversationId, sessionUuid, 'outbound conversation_id must be tenant-scoped')
  // Native Anthropic payload passed through untouched (no contents[] conversion, no ZWSP, is_error preserved).
  assert.ok(Array.isArray(directCalls[0].bodyObj.messages))
  assert.equal(directCalls[0].bodyObj.contents, undefined)
  assert.equal(directCalls[0].bodyObj.messages[2].content[0].is_error, true)
  assert.equal(directCalls[0].bodyObj.messages[2].content[0].content.includes('\u200B'), false)
  // Downstream SSE has visible output and ZERO kin_provider_result leakage.
  const outSse = resStream.bodyText()
  assert.match(outSse, /File was missing\./)
  assert.match(outSse, /event: message_stop/)
  assert.doesNotMatch(outSse, /kin_provider_result/)
  assert.doesNotMatch(outSse, /craggeminiMeta/)

  // Non-streaming Anthropic passthrough returns HTTP 200 Anthropic JSON message with usage from kin_provider_result.
  const resJson = ccMakeRes()
  await handler(ccMakeReq({ url: '/v1/messages', body: { ...rawBody, stream: false } }), resJson)
  assert.equal(resJson.statusCode, 200)
  const payload = resJson.jsonBody()
  assert.equal(payload.type, 'message')
  assert.equal(payload.role, 'assistant')
  assert.equal(payload.stop_reason, 'end_turn')
  assert.deepEqual(payload.content, [{ type: 'text', text: 'File was missing.' }])
  assert.equal(payload.usage.input_tokens, 120)
  assert.equal(payload.usage.output_tokens, 45)
  assert.equal(payload.usage.cache_read_input_tokens, 30)
})

test('Gemini native /v1beta passthrough preserves historical thought parts and strips craggeminiMeta & kin_provider_result', async () => {
  const envs = [ccMakeEnv('env-gem')]
  const directCalls = []

  const directClient = {
    async resolveTarget({ id }) {
      return {
        kind: 'session',
        socketPath: '/tmp/fake-gem.sock',
        token: 't'.repeat(32),
        envId: id,
        accountRoute: false,
        capabilities: ['internal_gemini_wire_v1', 'provider_result_v2'],
        protocolCapabilities: {
          internal_wire_protocols: ['raw', 'gemini'],
          provider_result_v2: true,
        },
      }
    },
    async openDirectStream(_target, opts) {
      directCalls.push(opts)
      return {
        ok: true,
        res: ccMakeSseStream([
          `data: ${JSON.stringify({
            craggeminiMeta: { conversation_id: 'gem-sess-1', awaiting_tool_results: false },
            candidates: [{ content: { role: 'model', parts: [{ text: 'checked /etc/hosts' }] }, finishReason: 'STOP' }],
          })}\n\n`,
          `event: kin_provider_result\ndata: ${JSON.stringify({ conversation_id: 'gem-sess-1', visible_output: true, provider_complete: true, finish_reason: 'STOP' })}\n\n`,
        ]),
      }
    },
    async cancelDirectTurn() {},
    invalidate() {},
  }

  const scheduler = createRawGeminiScheduler({
    schedulerRuntime: ccMakeRecordingRuntime(),
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return { id: payload.id, proxy_id: `proxy-${payload.id}`, auth_method: 'oauth' }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async () => {
      throw new Error('should use directClient')
    },
    resolveProxy: () => 'socks5h://127.0.0.1:1080',
    directClient,
  })
  const handler = createGeminiPublicHandler({ json: ccJsonResponder, readBody: async () => ({}), scheduler })

  const res = ccMakeRes()
  await handler(
    ccMakeReq({
      url: '/v1beta/models/gemini-4-hydrogen-high:streamGenerateContent?alt=sse',
      headers: { 'x-session-id': 'gem-sess-1' },
      body: {
        contents: [
          { role: 'user', parts: [{ text: 'Read /etc/hosts' }] },
          {
            role: 'model',
            parts: [
              { thought: true, text: 'Need to inspect hosts', thoughtSignature: 'sig_gem_1' },
              { functionCall: { id: 'fc_1', name: 'Read', args: { path: '/etc/hosts' } } },
            ],
          },
          {
            role: 'user',
            parts: [{ functionResponse: { id: 'fc_1', name: 'Read', response: { output: '127.0.0.1 localhost' } } }],
          },
        ],
      },
    }),
    res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(directCalls.length, 1)
  assert.equal(directCalls[0].wireProtocol, 'gemini')
  const prepared = prepareDirectNativeTurnBody('gemini-4-hydrogen-high', directCalls[0].bodyObj, {
    preserveThought: true,
  })
  assert.equal(prepared.contents[1].parts[0].thought, true)
  assert.equal(prepared.contents[1].parts[0].thoughtSignature, 'sig_gem_1')
  assert.deepEqual(prepared.contents[2].parts[0].functionResponse.response, { output: '127.0.0.1 localhost' })
  assert.doesNotMatch(res.bodyText(), /craggeminiMeta/)
  assert.doesNotMatch(res.bodyText(), /kin_provider_result/)
  assert.match(res.bodyText(), /checked \/etc\/hosts/)
})

// ---------------------------------------------------------------------------
// 2. Problem Class (A): Empty/Idle Turns, Pre-Commit Buffering, Abnormal Finish, 409
// ---------------------------------------------------------------------------

test('(A) thinking-only empty STOP does not commit downstream headers and fails over cleanly to second account', async () => {
  const envs = [ccMakeEnv('env-empty-1'), ccMakeEnv('env-good-2')]
  const calls = []
  const scheduler = createRawGeminiScheduler({
    schedulerRuntime: ccMakeRecordingRuntime(),
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return { id: payload.id, proxy_id: `proxy-${payload.id}`, auth_method: 'oauth' }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async (_op, payload) => {
      calls.push(payload.id)
      if (payload.id === 'env-empty-1') {
        return ccMakeSseStream([
          `data: ${JSON.stringify({
            craggeminiMeta: { conversation_id: 'sess-empty-1', awaiting_tool_results: false },
            candidates: [
              {
                content: { role: 'model', parts: [{ thought: true, text: 'stale thought from env 1' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 100, thoughtsTokenCount: 50, totalTokenCount: 150 },
          })}\n\n`,
        ])
      }
      return ccMakeSseStream([
        `data: ${JSON.stringify({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'clean answer from env 2' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12, totalTokenCount: 112 },
        })}\n\n`,
      ])
    },
    resolveProxy: () => 'socks5h://127.0.0.1:1080',
  })
  const handler = createGeminiPublicHandler({ json: ccJsonResponder, readBody: async () => ({}), scheduler })

  const res = ccMakeRes()
  await handler(
    ccMakeReq({
      url: '/v1/messages',
      body: {
        model: 'gemini-4-hydrogen-high',
        stream: true,
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Say hello cleanly.' }],
      },
    }),
    res,
  )
  assert.equal(res.statusCode, 200)
  assert.deepEqual(calls, ['env-empty-1', 'env-good-2'])
  const out = res.bodyText()
  assert.match(out, /clean answer from env 2/)
  assert.doesNotMatch(out, /stale thought from env 1/, 'attempt 1 buffered thinking must be cleared before attempt 2')
})

test('(A) abnormal finishReason (MALFORMED_FUNCTION_CALL/OTHER) & provider_complete=false reject instead of 200 end_turn', async () => {
  const decodeStop = (finishReason) => {
    const dec = createGeminiEventDecoder({ fallbackModel: 'gemini-4-hydrogen-high' })
    const evs = []
    dec.decodeSseFrame(
      `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [] }, finishReason }] })}`,
      (ev) => evs.push(ev),
    )
    return evs.find((e) => e.kind === 'stop')?.stopReason
  }
  assert.equal(decodeStop('MALFORMED_FUNCTION_CALL'), 'malformed_tool_call')
  assert.equal(decodeStop('UNEXPECTED_TOOL_CALL'), 'malformed_tool_call')
  assert.equal(decodeStop('TOO_MANY_TOOL_CALLS'), 'malformed_tool_call')
  assert.equal(decodeStop('OTHER'), 'other')

  const envs = [ccMakeEnv('env-abn')]
  let nextFrames = []
  const scheduler = createRawGeminiScheduler({
    schedulerRuntime: ccMakeRecordingRuntime(),
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return { id: payload.id, proxy_id: `proxy-${payload.id}`, auth_method: 'oauth' }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async () => ccMakeSseStream(nextFrames),
    resolveProxy: () => 'socks5h://127.0.0.1:1080',
  })

  // Case 1: MALFORMED_FUNCTION_CALL with no tool calls
  nextFrames = [
    `data: ${JSON.stringify({
      candidates: [
        { content: { role: 'model', parts: [{ text: 'broken call' }] }, finishReason: 'MALFORMED_FUNCTION_CALL' },
      ],
    })}\n\n`,
  ]
  await assert.rejects(
    () =>
      scheduler.stream({
        model: 'gemini-4-hydrogen-high',
        geminiBody: { contents: [{ role: 'user', parts: [{ text: 'call tool' }] }] },
        apiKeyRecord: { id: 'k1', group_type: 'gemini' },
      }),
    (err) => err.code === 'gemini_inference_invalid_output' && err.status === 502,
  )

  // Case 2: kin_provider_result provider_complete: false
  nextFrames = [
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] }, finishReason: 'STOP' }],
    })}\n\n`,
    `event: kin_provider_result\ndata: ${JSON.stringify({ provider_complete: false, visible_output: true, finish_reason: 'STOP' })}\n\n`,
  ]
  await assert.rejects(
    () =>
      scheduler.stream({
        model: 'gemini-4-hydrogen-high',
        geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
        apiKeyRecord: { id: 'k1', group_type: 'gemini' },
      }),
    (err) => err.code === 'gemini_inference_invalid_output' && err.status === 502,
  )
})

test('(A) createGeminiRestoreTransform does not early-stop long thinking via chars/4 before visible text', () => {
  let earlyStopped = false
  const emitted = []
  const transform = createGeminiRestoreTransform(
    { maxTokens: 100, toolMap: new Map(), stopSequences: [] },
    {
      target: 'antigravity',
      model: 'gemini-4-hydrogen-high',
      onEarlyStop: () => {
        earlyStopped = true
      },
    },
  )
  const emit = (ev) => emitted.push(ev)
  transform.push({ kind: 'thinking', text: 'x'.repeat(8000) }, emit)
  assert.equal(earlyStopped, false, 'thinking must never trigger chars/4 early-stop')
  transform.push({ kind: 'text', text: 'actual final answer' }, emit)
  transform.push({ kind: 'stop', stopReason: 'stop', finishReason: 'STOP' }, emit)
  transform.flush(emit)
  assert.equal(earlyStopped, false)
  assert.ok(emitted.some((e) => e.kind === 'text' && e.text === 'actual final answer'))
})

test('(A) 409 session conflict codes map to 409 gemini_session_conflict and retry with :r1 + X-Craggemini-Session-Reset', async () => {
  for (const code of ['session_conflict', 'tool_continuation_already_settled', 'duplicate_request', 'session_busy']) {
    const mapped = mapCragWorkerError(409, { code, error: code })
    assert.equal(mapped.status, 409, `expected 409 for ${code}`)
    assert.equal(mapped.code, 'gemini_session_conflict', `expected gemini_session_conflict for ${code}`)
  }
  const bare409 = mapCragWorkerError(409, { error: 'busy' })
  assert.equal(bare409.status, 409)
  assert.equal(bare409.code, 'gemini_session_conflict')

  const envs = [ccMakeEnv('env-409')]
  const directAttempts = []
  const directClient = {
    async resolveTarget({ id }) {
      return {
        kind: 'session',
        socketPath: '/tmp/fake-409.sock',
        token: 't'.repeat(32),
        envId: id,
        accountRoute: false,
        capabilities: ['internal_anthropic_wire_v1', 'provider_result_v2'],
        protocolCapabilities: { internal_wire_protocols: ['raw', 'gemini', 'anthropic'], provider_result_v2: true },
      }
    },
    async openDirectStream(_target, opts) {
      directAttempts.push({ conversationId: opts.conversationId, sessionReset: opts.sessionReset })
      if (directAttempts.length === 1) {
        const err = new Error('session busy')
        err.status = 409
        err.upstreamStatus = 409
        err.code = 'gemini_session_conflict'
        return { ok: false, fallback: false, error: err }
      }
      return {
        ok: true,
        res: ccMakeSseStream([
          `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'recovered after 409' } })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
          `event: kin_provider_result\ndata: ${JSON.stringify({ conversation_id: opts.conversationId, visible_output: true, provider_complete: true, finish_reason: 'end_turn' })}\n\n`,
        ]),
      }
    },
    async cancelDirectTurn() {},
    invalidate() {},
  }
  const scheduler = createRawGeminiScheduler({
    schedulerRuntime: ccMakeRecordingRuntime(),
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return { id: payload.id, proxy_id: `proxy-${payload.id}`, auth_method: 'oauth' }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async () => {
      throw new Error('should use directClient')
    },
    resolveProxy: () => 'socks5h://127.0.0.1:1080',
    getRoutingConfig: () => ({ gemini: { failover: { max_account_switches: 1 } } }),
    directClient,
  })

  const out = await scheduler.stream({
    model: 'gemini-4-hydrogen-high',
    inboundProtocol: 'anthropic',
    rawInboundBody: { model: 'gemini-4-hydrogen-high', messages: [{ role: 'user', content: 'hi' }] },
    wantStream: false,
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    inboundConversationId: 'sess-409-canon',
    stickyKey: 'sess-409-canon',
    apiKeyRecord: { id: 'k1', group_type: 'gemini' },
  })
  assert.equal(out.text, 'recovered after 409')
  assert.equal(directAttempts.length, 2)
  assert.match(directAttempts[0].conversationId, /^cs_[a-f0-9]{24}$/)
  assert.equal(directAttempts[0].sessionReset, false)
  assert.equal(directAttempts[1].conversationId, `${directAttempts[0].conversationId}:r1`)
  assert.equal(directAttempts[1].sessionReset, true)
})

// ---------------------------------------------------------------------------
// 3. Problem Class (B): T1->T2 Identity Parity, Unified Session Extraction, Continuation Pinning
// ---------------------------------------------------------------------------

test('(B) headerless /v1beta T1 and T2 derive identical sessionId while short probes remain random', () => {
  const t1 = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: '<system-reminder>injected metadata</system-reminder>' },
          { text: 'Analyze the transaction isolation model of PostgreSQL MVCC in detail.' },
        ],
      },
    ],
  }
  const t2 = {
    contents: [
      ...t1.contents,
      { role: 'model', parts: [{ text: 'PostgreSQL uses snapshot isolation...' }] },
      { role: 'user', parts: [{ text: 'Now compare with SSI.' }] },
    ],
  }
  const id1 = resolveSchedulerIdentity({ inbound: t1, poolId: 'pool_gem', apiKeyId: 'key_1' })
  const id2 = resolveSchedulerIdentity({ inbound: t2, poolId: 'pool_gem', apiKeyId: 'key_1' })
  assert.equal(id1.sessionId, id2.sessionId)
  assert.equal(id1.sessionSource, 'derived_first_turn')
  assert.equal(id2.sessionSource, 'derived_multi_turn')

  // Short single-turn /v1beta probe without tools stays ephemeral & random.
  const probe = { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }
  assert.equal(isShortProbeRequest(probe), true)
  const p1 = resolveSchedulerIdentity({ inbound: probe, poolId: 'pool_gem', apiKeyId: 'key_1' })
  const p2 = resolveSchedulerIdentity({ inbound: probe, poolId: 'pool_gem', apiKeyId: 'key_1' })
  assert.equal(p1.isEphemeralProbe, true)
  assert.equal(p1.sessionSource, 'generated_random')
  assert.notEqual(p1.sessionId, p2.sessionId)

  // firstUserFingerprint hashes beyond 4000 chars and ignores <system-reminder>.
  const prefix = 'A'.repeat(4200)
  const fpA = firstUserFingerprint({ contents: [{ role: 'user', parts: [{ text: `${prefix}ALPHA` }] }] })
  const fpB = firstUserFingerprint({ contents: [{ role: 'user', parts: [{ text: `${prefix}BETA` }] }] })
  assert.ok(fpA && fpB)
  assert.notEqual(fpA, fpB)
})

test('(B) inbound conversationId extraction enforces metadata.user_id > headers > body priority', () => {
  const fromMeta = parseInboundToGemini(
    'anthropic',
    {
      model: 'gemini-4-hydrogen-high',
      metadata: { user_id: `user_${'b'.repeat(64)}_account__session_22222222-3333-4444-8555-666666666666` },
      conversation_id: 'body-conv',
      messages: [{ role: 'user', content: 'hi' }],
    },
    { headers: { 'x-session-id': 'hdr-conv' } },
  ).conversationId
  assert.equal(fromMeta, '22222222-3333-4444-8555-666666666666')

  const fromJsonMeta = parseInboundToGemini(
    'anthropic',
    {
      model: 'gemini-4-hydrogen-high',
      metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: '33333333-4444-4555-8666-777777777777' }) },
      conversation_id: 'body-conv',
      messages: [{ role: 'user', content: 'hi' }],
    },
    { headers: { 'x-session-id': 'hdr-conv' } },
  ).conversationId
  assert.equal(fromJsonMeta, '33333333-4444-4555-8666-777777777777')

  const fromHdr = parseInboundToGemini(
    'anthropic',
    {
      model: 'gemini-4-hydrogen-high',
      conversation_id: 'body-conv',
      messages: [{ role: 'user', content: 'hi' }],
    },
    { headers: { 'x-session-id': 'hdr-conv' } },
  ).conversationId
  assert.equal(fromHdr, 'hdr-conv')

  const fromBody = parseInboundToGemini(
    'anthropic',
    {
      model: 'gemini-4-hydrogen-high',
      conversation_id: 'body-conv',
      messages: [{ role: 'user', content: 'hi' }],
    },
    { headers: {} },
  ).conversationId
  assert.equal(fromBody, 'body-conv')
})

test('(B) trailing [user(tool_result), user(<system-reminder>)] extracts continuationCallIds and pins continuation account', async () => {
  const envs = [ccMakeEnv('env-pin-a'), ccMakeEnv('env-pin-b')]
  const acquires = []
  let turn = 0

  const scheduler = createRawGeminiScheduler({
    schedulerRuntime: ccMakeRecordingRuntime(acquires),
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return { id: payload.id, proxy_id: `proxy-${payload.id}`, auth_method: 'oauth' }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async () => {
      turn += 1
      if (turn === 1) {
        return ccMakeSseStream([
          `data: ${JSON.stringify({
            craggeminiMeta: { conversation_id: 'sess-pin-1', awaiting_tool_results: true },
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ functionCall: { id: 'toolu_pin_99', name: 'Read', args: { path: '/etc/hosts' } } }],
                },
                finishReason: 'STOP',
              },
            ],
          })}\n\n`,
        ])
      }
      return ccMakeSseStream([
        `data: ${JSON.stringify({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'done after continuation' }] }, finishReason: 'STOP' },
          ],
        })}\n\n`,
      ])
    },
    resolveProxy: () => 'socks5h://127.0.0.1:1080',
  })
  const handler = createGeminiPublicHandler({ json: ccJsonResponder, readBody: async () => ({}), scheduler })

  // Turn 1 suspends waiting for toolu_pin_99 on env-pin-a
  const r1 = ccMakeRes()
  await handler(
    ccMakeReq({
      url: '/v1/messages',
      body: {
        model: 'gemini-4-hydrogen-high',
        max_tokens: 1024,
        metadata: { user_id: 'user_a_session_33333333-4444-4555-8666-777777777777' },
        tools: [{ name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
        messages: [{ role: 'user', content: 'Read /etc/hosts' }],
      },
    }),
    r1,
  )
  assert.equal(r1.statusCode, 200)

  // Turn 2 sends [user(tool_result), user(<system-reminder>)] (Magpie / CC style trailing reminder turn)
  const r2 = ccMakeRes()
  await handler(
    ccMakeReq({
      url: '/v1/messages',
      body: {
        model: 'gemini-4-hydrogen-high',
        max_tokens: 1024,
        metadata: { user_id: 'user_a_session_33333333-4444-4555-8666-777777777777' },
        tools: [{ name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
        messages: [
          { role: 'user', content: 'Read /etc/hosts' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_pin_99', name: 'Read', input: { path: '/etc/hosts' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_pin_99', content: '127.0.0.1 localhost' }],
          },
          {
            role: 'user',
            content: [{ type: 'text', text: '<system-reminder>keep concise</system-reminder>' }],
          },
        ],
      },
    }),
    r2,
  )
  assert.equal(r2.statusCode, 200)
  assert.equal(acquires.length, 2)
  assert.equal(acquires[1].pinNodeKey, 'gemini_env:env-pin-a')
})

// ---------------------------------------------------------------------------
// 4. Problem Class (C): Tool History Fidelity
// ---------------------------------------------------------------------------

test('(C) tool history preserves thoughtSignature, single user turn, is_error, rawResponse keys, tool_result files, and anyOf', () => {
  const ir = parseInboundToGemini('anthropic', {
    model: 'gemini-4-hydrogen-high',
    max_tokens: 2048,
    tools: [
      {
        name: 'Edit',
        description: 'Edit file',
        input_schema: {
          type: 'object',
          properties: {
            target: {
              anyOf: [
                { type: 'string', description: 'absolute file path' },
                { type: 'object', properties: { line: { type: 'integer' } } },
              ],
            },
          },
        },
      },
    ],
    messages: [
      { role: 'user', content: 'Edit /home/user/app.js' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Plan edit', signature: 'sig_across_text_123' },
          { type: 'text', text: 'Editing now.' },
          { type: 'tool_use', id: 'toolu_edit_1', name: 'Edit', input: { target: '/home/user/app.js' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_edit_1',
            is_error: true,
            content: [
              { type: 'text', text: 'Permission denied on /home/user/app.js' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
              },
            ],
          },
          { type: 'text', text: '<system-reminder>retry carefully</system-reminder>' },
        ],
      },
    ],
  })

  const agReq = buildGeminiRequest(ir, { target: 'antigravity', escapeSlashes: false })
  // 1. thoughtSignature preserved across [thinking, text, tool_use]
  const modelTurn = agReq.contents.find((c) => c.role === 'model')
  const fcPart = modelTurn.parts.find((p) => p.functionCall)
  assert.equal(fcPart.thoughtSignature, 'sig_across_text_123')

  // 2. [tool_result, text(<system-reminder>)] stays a SINGLE role: 'user' turn (no consecutive user split!)
  const userTurnsAfterModel = agReq.contents.slice(agReq.contents.indexOf(modelTurn) + 1)
  assert.equal(userTurnsAfterModel.length, 1, 'must NOT split [tool_result, text] into consecutive user turns')
  assert.equal(userTurnsAfterModel[0].role, 'user')

  // 3. is_error preserved + zero \u200B corruption + tool_result multimodal attachment stays on tool turn
  const frPart = userTurnsAfterModel[0].parts.find((p) => p.functionResponse)
  assert.deepEqual(frPart.functionResponse.response, {
    error: 'Permission denied on /home/user/app.js',
    is_error: true,
  })
  assert.equal(frPart.functionResponse.response.error.includes('\u200B'), false)
  assert.ok(userTurnsAfterModel[0].parts.some((p) => p.inlineData?.mimeType === 'image/png'))
  assert.ok(userTurnsAfterModel[0].parts.some((p) => typeof p.text === 'string' && p.text.includes('retry carefully')))

  // 4. anyOf preserves branch info in description
  const targetSchema = agReq.tools[0].functionDeclarations[0].parameters.properties.target
  assert.match(targetSchema.description || '', /Accepted \(anyOf\): string \| object\{line\}/)

  // 5. /v1beta native functionResponse preserves original keys without wrapping into { result }
  const gemIr = parseInboundToGemini(
    'gemini',
    {
      contents: [
        { role: 'user', parts: [{ text: 'run' }] },
        { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'Run', args: {} } }] },
        {
          role: 'user',
          parts: [{ functionResponse: { id: 'c1', name: 'Run', response: { output: '/mnt/x/ok', exit_code: 0 } } }],
        },
      ],
    },
    { routeModel: 'gemini-4-hydrogen-high' },
  )
  const gemAgReq = buildGeminiRequest(gemIr, { target: 'antigravity', escapeSlashes: false })
  const gemFr = gemAgReq.contents[2].parts[0].functionResponse
  assert.deepEqual(gemFr.response, { output: '/mnt/x/ok', exit_code: 0 })
})

// ---------------------------------------------------------------------------
// 5. Problem Class (D): Claude Code Direct /v1/messages & /v1/messages/count_tokens
// ---------------------------------------------------------------------------

test('(D) model catalog & inbound parser strip arbitrary <provider>/ prefix for Antigravity Gemini models', () => {
  assert.equal(isAntigravityRoutedModel('gemini-vm/gemini-4-hydrogen-high'), true)
  assert.equal(isAntigravityRoutedModel('google/gemini-4-neon-xhigh'), true)
  assert.equal(parseAntigravityModelSpec('gemini-vm/gemini-4-hydrogen-high').cleaned, 'gemini-4-hydrogen-high')
  assert.equal(
    parseInboundToGemini('anthropic', {
      model: 'gemini-vm/gemini-4-hydrogen-high',
      messages: [{ role: 'user', content: 'hi' }],
    }).model,
    'gemini-4-hydrogen-high',
  )
  assert.equal(
    parseInboundToGemini('anthropic', {
      model: 'google/gemini-4-neon-xhigh',
      messages: [{ role: 'user', content: 'hi' }],
    }).model,
    'gemini-4-neon-xhigh',
  )
})

test('(D) handle-protocol routes master & Gemini-pool-bound keys on /v1/messages with gemini-vm/ prefix to Gemini handler', async () => {
  const routed = []
  let reqSeq = 0
  const { handleProtocol } = createHandleProtocol({
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024 },
      paths: {},
    },
    requireAuth: () => true,
    readBody: async (req) => req.body,
    json: ccJsonResponder,
    writeSSEHeaders() {},
    requestLog: { start: () => ({ request_id: `cc-route-${++reqSeq}`, t0: Date.now() }), finish() {} },
    stickyRouter: {},
    accountQuota: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfig: { failover: {} },
    geminiScheduler: {
      async catalog() {
        return { accounts: [ccMakeEnv('env-cc-1')], models: ['gemini-4-hydrogen-high'], unlicensedAccounts: [] }
      },
    },
    poolsRepo: {
      listBindingsByKey: (keyId) => (keyId === 'key-pool-gem' ? [{ pool_id: 'pool_gem', is_default: true }] : []),
      get: (poolId) =>
        poolId === 'pool_gem'
          ? {
              id: 'pool_gem',
              enabled: true,
              members: [{ node_type: 'gemini_env', node_id: 'env-cc-1', enabled: true }],
            }
          : null,
    },
    handleGeminiPublic: async (req, res) => {
      routed.push({ keyKind: req.apiKeyKind, model: req.body?.model })
      ccJsonResponder(res, 200, { ok: true, routed: 'gemini' })
    },
  })

  // 1. Master key + gemini-vm/gemini-4-hydrogen-high
  const resMaster = ccMakeRes()
  await handleProtocol(
    ccMakeReq({
      url: '/v1/messages',
      apiKeyKind: 'master',
      apiKeyRecord: { id: 'master', group_type: 'all' },
      body: { model: 'gemini-vm/gemini-4-hydrogen-high', max_tokens: 128, messages: [{ role: 'user', content: 'hi' }] },
    }),
    resMaster,
    'anthropic.messages',
    '/v1/messages',
  )
  assert.equal(resMaster.statusCode, 200)

  // 2. Managed key (group_type='claude', bound via default_pool_id='pool_gem' containing Gemini env)
  const resPool = ccMakeRes()
  await handleProtocol(
    ccMakeReq({
      url: '/v1/messages',
      apiKeyKind: 'managed',
      apiKeyRecord: {
        id: 'key-pool-gem',
        group_type: 'claude',
        default_pool_id: 'pool_gem',
        pool_binding_mode: 'strict_pool',
      },
      body: { model: 'gemini-vm/gemini-4-hydrogen-high', max_tokens: 128, messages: [{ role: 'user', content: 'hi' }] },
    }),
    resPool,
    'anthropic.messages',
    '/v1/messages',
  )
  assert.equal(resPool.statusCode, 200)
  assert.equal(routed.length, 2)
  assert.deepEqual(
    routed.map((r) => r.keyKind),
    ['master', 'managed'],
  )
})

test('(D) /v1/messages/count_tokens handles Gemini models cleanly without hitting Claude poolScheduler', async () => {
  const calls = []
  let claudePoolTouched = false
  await handleUserCountTokens(
    {
      apiKeyKind: 'managed',
      apiKeyRecord: { id: 'key-gem', group_type: 'gemini' },
      headers: {},
    },
    {},
    {
      json: (_res, status, body) => {
        calls.push({ status, body })
        return body
      },
      requireAuth: () => true,
      readBody: async () => ({
        model: 'gemini-vm/gemini-4-hydrogen-high',
        system: 'You are Claude Code.',
        tools: [
          {
            name: 'Read',
            description: 'Read file',
            input_schema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
        messages: [{ role: 'user', content: 'Count tokens for this Gemini request please.' }],
      }),
      cfg: { limits: { max_body_bytes: 1024 * 1024 } },
      getPoolScheduler: () => {
        claudePoolTouched = true
        throw new Error('Claude poolScheduler must not be touched for Gemini count_tokens')
      },
    },
  )
  assert.equal(claudePoolTouched, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].status, 200)
  assert.ok(Number.isInteger(calls[0].body.input_tokens) && calls[0].body.input_tokens > 0)
})

// ---------------------------------------------------------------------------
// 6. Verifier Cross-Repo & Production Safety Regressions (V1-V5)
// ---------------------------------------------------------------------------

test('(V1) old kernel fallback preserves ZWSP slash escaping for valid_text while new kernel capability omits ZWSP', async () => {
  const envs = [ccMakeEnv('env-v1')]
  const sentBodies = []
  let targetCaps = { capabilities: [], protocolCapabilities: {} }

  const directClient = {
    async resolveTarget({ id }) {
      return {
        kind: 'session',
        socketPath: '/tmp/v1.sock',
        token: 't'.repeat(32),
        envId: id,
        accountRoute: false,
        ...targetCaps,
      }
    },
    async openDirectStream(_target, opts) {
      sentBodies.push(opts.bodyObj)
      return {
        ok: true,
        res: ccMakeSseStream([
          `data: ${JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          })}\n\n`,
        ]),
      }
    },
    async cancelDirectTurn() {},
    invalidate() {},
  }

  const scheduler = createRawGeminiScheduler({
    schedulerRuntime: ccMakeRecordingRuntime(),
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return { id: payload.id, proxy_id: `proxy-${payload.id}`, auth_method: 'oauth' }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async () => {
      throw new Error('should use directClient')
    },
    resolveProxy: () => 'socks5h://127.0.0.1:1080',
    directClient,
  })
  const handler = createGeminiPublicHandler({ json: ccJsonResponder, readBody: async () => ({}), scheduler })

  // 1. Old kernel (no internal_wire_protocol_v1 / no protocol_capabilities): slash tokens MUST be ZWSP-escaped.
  const resOld = ccMakeRes()
  await handler(
    ccMakeReq({
      url: '/v1/chat/completions',
      body: {
        model: 'gemini-4-hydrogen-high',
        messages: [{ role: 'user', content: '/quit\nInspect /tmp and /etc/hosts' }],
      },
    }),
    resOld,
  )
  assert.equal(resOld.statusCode, 200)
  const oldText = sentBodies[0].contents[0].parts[0].text
  assert.equal(
    oldText.split(/\p{White_Space}+/u).some((w) => w.startsWith('/')),
    false,
    'legacy kernel must receive ZWSP-escaped slash tokens for valid_text compatibility',
  )

  // 2. New kernel declaring internal_wire_protocol_v1: slash paths stay literal without ZWSP.
  targetCaps = {
    capabilities: ['internal_wire_protocol_v1'],
    protocolCapabilities: { internal_wire_protocols: ['raw', 'gemini', 'anthropic'], provider_result_v2: true },
  }
  const resNew = ccMakeRes()
  await handler(
    ccMakeReq({
      url: '/v1/chat/completions',
      body: {
        model: 'gemini-4-hydrogen-high',
        messages: [{ role: 'user', content: '/quit\nInspect /tmp and /etc/hosts' }],
      },
    }),
    resNew,
  )
  assert.equal(resNew.statusCode, 200)
  const newText = sentBodies[1].contents[0].parts[0].text
  assert.equal(newText.includes('\u200B'), false, 'new kernel with ACP wire capability must not get ZWSP injection')
  assert.ok(newText.includes('/tmp') && newText.includes('/etc/hosts'))
})

test('(V2) outbound conversation_id is deterministic across restarts yet strictly isolated across tenants/keys', async () => {
  const envs = [ccMakeEnv('env-v2')]
  const runOnce = async ({ apiKeyRecord, ownerScope, originPoolId = null }) => {
    const seenConvIds = []
    const scheduler = createRawGeminiScheduler({
      schedulerRuntime: ccMakeRecordingRuntime(),
      getEnvOwner: () => (ownerScope?.type === 'user' ? ownerScope.userId : null),
      callHost: async (op, payload) => {
        if (op === 'list') return { payload_state: 'installed', environments: envs }
        if (op === 'get') return { id: payload.id, proxy_id: `proxy-${payload.id}`, auth_method: 'oauth' }
        throw new Error(`unexpected op ${op}`)
      },
      callHostStream: async (_op, payload) => {
        seenConvIds.push(payload.body?.conversation_id)
        return ccMakeSseStream([
          `data: ${JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          })}\n\n`,
        ])
      },
      resolveProxy: () => 'socks5h://127.0.0.1:1080',
    })
    await scheduler.stream({
      model: 'gemini-4-hydrogen-high',
      geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      inboundConversationId: 'shared-client-session-uuid',
      stickyKey: 'shared-client-session-uuid',
      apiKeyRecord,
      ownerScope,
      ...(originPoolId ? { originPoolId } : {}),
    })
    return seenConvIds[0]
  }

  const tenantA1 = await runOnce({
    apiKeyRecord: { id: 'key-tenant-a', group_type: 'gemini' },
    ownerScope: { type: 'platform' },
  })
  const tenantA2AfterRestart = await runOnce({
    apiKeyRecord: { id: 'key-tenant-a', group_type: 'gemini' },
    ownerScope: { type: 'platform' },
  })
  const tenantBKey = await runOnce({
    apiKeyRecord: { id: 'key-tenant-b', group_type: 'gemini' },
    ownerScope: { type: 'platform' },
  })
  const tenantBUser = await runOnce({
    apiKeyRecord: { id: 'key-tenant-a', group_type: 'gemini' },
    ownerScope: { type: 'user', userId: 'usr-99' },
  })

  assert.match(tenantA1, /^cs_[a-f0-9]{24}$/)
  assert.equal(tenantA1, tenantA2AfterRestart, 'same tenant + session must survive scheduler restart deterministically')
  assert.notEqual(tenantA1, tenantBKey, 'different API keys with identical session_id must never share conversation_id')
  assert.notEqual(
    tenantA1,
    tenantBUser,
    'different ownerScope with identical session_id must never share conversation_id',
  )
})

test('(V3) kin_provider_result usage bills uncached input=70, cache_read=30, total=120 consistently with zero double-count', async () => {
  const envs = [ccMakeEnv('env-v3')]
  const billed = []
  const directClient = {
    async resolveTarget({ id }) {
      return {
        kind: 'session',
        socketPath: '/tmp/v3.sock',
        token: 't'.repeat(32),
        envId: id,
        accountRoute: false,
        capabilities: ['internal_anthropic_wire_v1', 'provider_result_v2'],
        protocolCapabilities: { internal_wire_protocols: ['raw', 'gemini', 'anthropic'], provider_result_v2: true },
      }
    },
    async openDirectStream() {
      return {
        ok: true,
        res: ccMakeSseStream([
          `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_v3', type: 'message', role: 'assistant', model: 'gemini-4-hydrogen-high', content: [], usage: { input_tokens: 70, cache_read_input_tokens: 30, output_tokens: 0 } } })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'billed cleanly' } })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 70, cache_read_input_tokens: 30, output_tokens: 20 } })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
          `event: kin_provider_result\ndata: ${JSON.stringify({ conversation_id: 'cs_v3', visible_output: true, provider_complete: true, finish_reason: 'end_turn', usage: { input_tokens: 70, cache_read_input_tokens: 30, output_tokens: 20, thinking_tokens: 5 } })}\n\n`,
        ]),
      }
    },
    async cancelDirectTurn() {},
    invalidate() {},
  }

  const scheduler = createRawGeminiScheduler({
    schedulerRuntime: ccMakeRecordingRuntime(),
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return { id: payload.id, proxy_id: `proxy-${payload.id}`, auth_method: 'oauth' }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async () => {
      throw new Error('should use directClient')
    },
    resolveProxy: () => 'socks5h://127.0.0.1:1080',
    apiKeyStore: {
      recordUsage: (_rec, usage) => billed.push(usage),
    },
    directClient,
  })

  const out = await scheduler.stream({
    model: 'gemini-4-hydrogen-high',
    inboundProtocol: 'anthropic',
    rawInboundBody: { model: 'gemini-4-hydrogen-high', messages: [{ role: 'user', content: 'hi' }] },
    wantStream: false,
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    apiKeyRecord: { id: 'key-v3', group_type: 'gemini' },
  })

  assert.equal(out.usage.input_tokens, 70)
  assert.equal(out.usage.cache_read_tokens, 30)
  assert.equal(out.usage.cache_read_input_tokens, 30)
  assert.equal(out.usage.output_tokens, 20)
  assert.equal(out.usage.reasoning_tokens, 5)
  assert.equal(out.usage.total_tokens, 120)
  assert.equal(billed.length, 1)
  assert.equal(billed[0].input_tokens, 70)
  assert.equal(billed[0].cache_read_input_tokens, 30)
  assert.equal(billed[0].output_tokens, 20)

  // Verify legacy createGeminiEventDecoder produces the exact same total_tokens = in + cache + out.
  const dec = createGeminiEventDecoder({ fallbackModel: 'gemini-4-hydrogen-high' })
  const evs = []
  dec.decodeSseFrame(
    `event: kin_provider_result\ndata: ${JSON.stringify({ usage: { input_tokens: 70, cache_read_input_tokens: 30, output_tokens: 20, thinking_tokens: 5 } })}`,
    (ev) => evs.push(ev),
  )
  const usageEv = evs.find((e) => e.kind === 'usage')
  assert.equal(usageEv.usage.input_tokens, 70)
  assert.equal(usageEv.usage.cache_read_tokens, 30)
  assert.equal(usageEv.usage.total_tokens, 120)
})

test('(V4) derived_first_turn hitting 409 isolates onto a random conversation_id without resetting concurrent sibling', async () => {
  const envs = [ccMakeEnv('env-v4')]
  const attempts = []
  const directClient = {
    async resolveTarget({ id }) {
      return {
        kind: 'session',
        socketPath: '/tmp/v4.sock',
        token: 't'.repeat(32),
        envId: id,
        accountRoute: false,
        capabilities: ['internal_anthropic_wire_v1', 'provider_result_v2'],
        protocolCapabilities: { internal_wire_protocols: ['raw', 'gemini', 'anthropic'], provider_result_v2: true },
      }
    },
    async openDirectStream(_target, opts) {
      attempts.push({ conversationId: opts.conversationId, sessionReset: opts.sessionReset })
      if (attempts.length === 1) {
        const err = new Error('session busy')
        err.status = 409
        err.upstreamStatus = 409
        err.code = 'gemini_session_conflict'
        return { ok: false, fallback: false, error: err }
      }
      return {
        ok: true,
        res: ccMakeSseStream([
          `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'isolated ok' } })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
          `event: kin_provider_result\ndata: ${JSON.stringify({ conversation_id: opts.conversationId, visible_output: true, provider_complete: true, finish_reason: 'end_turn' })}\n\n`,
        ]),
      }
    },
    async cancelDirectTurn() {},
    invalidate() {},
  }

  const scheduler = createRawGeminiScheduler({
    schedulerRuntime: ccMakeRecordingRuntime(),
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return { id: payload.id, proxy_id: `proxy-${payload.id}`, auth_method: 'oauth' }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async () => {
      throw new Error('should use directClient')
    },
    resolveProxy: () => 'socks5h://127.0.0.1:1080',
    getRoutingConfig: () => ({ gemini: { failover: { max_account_switches: 1 } } }),
    directClient,
  })

  const out = await scheduler.stream({
    model: 'gemini-4-hydrogen-high',
    inboundProtocol: 'anthropic',
    rawInboundBody: {
      model: 'gemini-4-hydrogen-high',
      messages: [{ role: 'user', content: 'Identical concurrent batch evaluation prompt that exceeds 64 chars.' }],
    },
    wantStream: false,
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'batch' }] }] },
    inboundIdentity: { sessionId: '44444444-5555-4666-8777-888888888888', sessionSource: 'derived_first_turn' },
    stickyKey: 'key-v4:derived',
    apiKeyRecord: { id: 'key-v4', group_type: 'gemini' },
  })
  assert.equal(out.text, 'isolated ok')
  assert.equal(attempts.length, 2)
  assert.match(attempts[0].conversationId, /^cs_[a-f0-9]{24}$/)
  assert.match(attempts[1].conversationId, /^cs_[a-f0-9]{24}$/)
  assert.notEqual(attempts[1].conversationId, attempts[0].conversationId)
  assert.equal(attempts[1].conversationId.includes(':r'), false, 'derived_* 409 retry must mint random isolated id')
  assert.equal(attempts[1].sessionReset, false, 'derived_* 409 retry must not reset concurrent sibling session')
})

test('(V5) MALFORMED_FUNCTION_CALL after valid functionCall preserves stopReason=tool for client tool execution', async () => {
  const dec = createGeminiEventDecoder({ fallbackModel: 'gemini-4-hydrogen-high' })
  const evs = []
  dec.decodeSseFrame(
    `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'fc_valid_1', name: 'Read', args: { path: '/etc/hosts' } } }],
          },
          finishReason: 'MALFORMED_FUNCTION_CALL',
        },
      ],
    })}`,
    (ev) => evs.push(ev),
  )
  assert.equal(evs.find((e) => e.kind === 'stop')?.stopReason, 'tool')
})
