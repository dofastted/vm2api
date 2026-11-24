import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { isErrorRow, isIgnoredClientCancel } from '../../src/lib/admin/error-class.mjs'
import { RequestLogStore, summarizeBody } from '../../src/lib/admin/request-log.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'
import { createGeminiPublicHandler } from '../../src/lib/gemini/routes.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import {
  FULL_GEMINI_CAPABILITIES,
  createGeminiCollector,
  createGeminiEventDecoder,
  createSseFrameSplitter,
  normalizeGeminiUsage,
  parseInboundToGemini,
} from '../../src/lib/protocol/gemini-convert.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import {
  effortFromModelName,
  effortFromThinkingBudget,
  reasoningEffortOf,
  resolveGeminiReasoningEffort,
} from '../../src/lib/protocol/log-fields.mjs'
import { disjointOpenaiUsage } from '../../src/lib/protocol/openai-usage.mjs'
import { normalizeUsage } from '../../src/lib/admin/pricing.mjs'

function tmpLogStore(mode = 'debug') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-gem-rlog-'))
  return new RequestLogStore({ dataDir: dir, mode })
}

function makeRes() {
  const res = new EventEmitter()
  res.headers = {}
  res.statusCode = 200
  res.chunks = []
  res.writableEnded = false
  res.headersSent = false
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v
  }
  res.getHeaders = () => ({ ...res.headers })
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status
    res.headersSent = true
    for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = v
  }
  res.write = (chunk) => {
    res.headersSent = true
    res.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }
  res.end = (chunk) => {
    if (chunk) res.write(chunk)
    res.headersSent = true
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
  req.socket = { remoteAddress: '127.0.0.1' }
  req.apiKeyKind = apiKeyKind
  req.apiKeyRecord = { id: 'key-gem-1', user_id: 9, group_id: 1, group_type: groupType }
  return req
}

function jsonResponder(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function delayedSseResponse(entries, { statusCode = 200, contentType = 'text/event-stream; charset=utf-8' } = {}) {
  const stream = new Readable({ read() {} })
  stream.statusCode = statusCode
  stream.headers = { 'content-type': contentType }
  ;(async () => {
    for (const entry of entries) {
      if (stream.destroyed) return
      const delayMs = typeof entry === 'object' ? entry.delayMs || 0 : 0
      const data = typeof entry === 'object' ? entry.data : entry
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      if (stream.destroyed) return
      stream.push(data)
    }
    if (!stream.destroyed) stream.push(null)
  })()
  return stream
}

test('Gemini cache + reasoning usage is never double-subtracted in RequestLogStore and UsageLogsView', async (t) => {
  const store = tmpLogStore('debug')
  t.after(() => {
    store.db.close()
    fs.rmSync(store.dataDir, { recursive: true, force: true })
  })

  // Unit check: disjoint Gemini usage with cache_read_tokens + reasoning_tokens stays disjoint.
  const rawGeminiUsage = { input_tokens: 300, output_tokens: 200, cache_read_tokens: 700, reasoning_tokens: 80 }
  const normalized = normalizeUsage(disjointOpenaiUsage(rawGeminiUsage))
  assert.equal(normalized.input_tokens, 300)
  assert.equal(normalized.cache_read_tokens, 700)
  assert.equal(normalized.output_tokens, 200)
  assert.equal(normalized.reasoning_tokens, 80)

  const scheduler = createGeminiScheduler({
    callHost: async (op) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-cache-1',
              proxy_id: 'px-1',
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              models: ['gemini-4-neon'],
              capabilities: [...FULL_GEMINI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get') return { id: 'env-cache-1', proxy_id: 'px-1', auth_method: 'oauth' }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async () =>
      delayedSseResponse([
        {
          delayMs: 15,
          data: `data: ${JSON.stringify({
            response: {
              responseId: 'resp_cache_1',
              modelVersion: 'gemini-4-neon',
              candidates: [{ content: { role: 'model', parts: [{ text: 'Thinking...', thought: true }] } }],
              usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 700 },
            },
          })}\n\n`,
        },
        {
          delayMs: 35,
          data: `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: 'Cached answer.' }] },
                  groundingMetadata: {
                    webSearchQueries: ['gemini cache'],
                    groundingChunks: [{ web: { uri: 'https://example.test/cache', title: 'Cache' } }],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 1000,
                cachedContentTokenCount: 700,
                candidatesTokenCount: 120,
                thoughtsTokenCount: 80,
                totalTokenCount: 1200,
              },
            },
          })}\n\n`,
        },
      ]),
    resolveProxy: () => 'socks5h://192.0.2.10:1080',
  })

  const handler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async () => ({}),
    scheduler,
    requestLog: store,
    groupsRepo: { rateMultiplier: () => 1 },
  })

  const res = makeRes()
  await handler(
    makeReq({
      url: '/v1beta/models/gemini-4-neon:generateContent?key=secret-demo',
      groupType: 'gemini',
      headers: { 'x-opencode-session-id': 'sess-gem-001' },
      body: {
        systemInstruction: { parts: [{ text: 'Be helpful.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Explain cache.' }] }],
        tools: [{ functionDeclarations: [{ name: 'lookup', parameters: { type: 'object', properties: {} } }] }],
        generationConfig: {
          maxOutputTokens: 512,
          thinkingConfig: { thinkingLevel: 'THINKING_LEVEL_HIGH', includeThoughts: true },
        },
      },
    }),
    res,
  )

  assert.equal(res.statusCode, 200)
  const listed = store.queryNormal({ limit: 5 }).items
  assert.equal(listed.length, 1)
  const row = listed[0]
  assert.equal(row.path, '/v1beta/models/gemini-4-neon:generateContent')
  assert.equal(row.input_tokens, 300)
  assert.equal(row.cache_read_tokens, 700)
  assert.equal(row.output_tokens, 200)
  assert.equal(row.web_search_requests, 1)
  assert.equal(row.reasoning_effort, 'high')
  assert.equal(row.session_id, 'sess-gem-001')
  assert.equal(row.outbound_session_id, 'sess-gem-001')
  assert.equal(row.attempt_count, 1)
  assert.equal(row.upstream_status, 200)
  assert.equal(row.has_tools, true)
  assert.ok(Number.isFinite(row.first_byte_ms) && row.first_byte_ms >= 0)
  assert.ok(Number.isFinite(row.first_token_ms) && row.first_token_ms >= row.first_byte_ms)
  assert.ok(Number.isFinite(row.generation_ms) && row.generation_ms > 0)
  assert.ok(row.total_cost != null && row.total_cost > 0)

  const viewRow = new UsageLogsView(store.db).listBatch({ limit: 5 }).logs[0]
  assert.equal(viewRow.inputTokens, 300)
  assert.equal(viewRow.cacheReadInputTokens, 700)
  assert.equal(viewRow.outputTokens, 200)
  assert.equal(viewRow.totalTokens, 1200)
  assert.equal(viewRow.reasoningEffort, 'high')
  assert.ok(viewRow.generationMs != null && viewRow.generationMs > 0)

  // Debug capture must retain inbound, outbound, summary, and full client response body/headers/status.
  const debug = store.getDebug(row.request_id)
  assert.ok(debug)
  assert.equal(debug.inbound_summary.messages_count, 1)
  assert.deepEqual(debug.inbound_summary.roles, ['user'])
  assert.equal(debug.inbound_summary.tool_functions_count, 1)
  assert.equal(debug.inbound_summary.max_tokens, 512)
  assert.equal(debug.inbound_summary.has_thinking, true)
  assert.equal(debug.inbound_summary.system_len, 'Be helpful.'.length)
  assert.equal(debug.outbound_body_source, 'craggemini')
  assert.ok(debug.outbound_body?.contents?.length === 1)
  assert.equal(debug.outbound_summary.messages_count, 1)
  assert.equal(debug.response?.status, 200)
  assert.equal(debug.response?.headers?.['content-type'], 'application/json')
  assert.ok(debug.response?.bytes > 0)
  assert.match(debug.response?.body || '', /Cached answer\./)
})

test('reasoningEffortOf and resolveGeminiReasoningEffort cover Gemini, OpenAI, Anthropic, and model suffixes', () => {
  assert.equal(
    reasoningEffortOf({ generationConfig: { thinkingConfig: { thinkingLevel: 'THINKING_LEVEL_MEDIUM' } } }),
    'medium',
  )
  assert.equal(reasoningEffortOf({ generation_config: { thinking_config: { thinking_level: 'minimal' } } }), 'minimal')
  assert.equal(effortFromThinkingBudget(0), 'none')
  assert.equal(effortFromThinkingBudget(-1), 'auto')
  assert.equal(effortFromThinkingBudget(2048), 'low')
  assert.equal(effortFromThinkingBudget(8192), 'medium')
  assert.equal(effortFromThinkingBudget(24576), 'high')

  assert.equal(effortFromModelName('gemini-4-neon-high'), 'high')
  assert.equal(effortFromModelName('ag-gpt-oss-120b-medium'), 'medium')
  assert.equal(effortFromModelName('gemini-3-pro(xhigh)'), 'xhigh')
  assert.equal(effortFromModelName('gemini-2.5-pro'), null)

  // OpenAI xhigh is preserved in Gemini IR instead of being collapsed to high.
  const chatParsed = parseInboundToGemini('openai-chat', {
    model: 'gemini-3-pro',
    reasoning_effort: 'xhigh',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(chatParsed.thinking?.effort, 'xhigh')
  assert.equal(resolveGeminiReasoningEffort({ inbound: { reasoning_effort: 'xhigh' }, parsed: chatParsed }), 'xhigh')

  // Disabled thinking stays 'none' even when Gemini 3 outbound config emits thinkingLevel:'low', includeThoughts:false.
  const disabledParsed = parseInboundToGemini('anthropic', {
    model: 'gemini-3-pro',
    max_tokens: 64,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(
    resolveGeminiReasoningEffort({
      inbound: { thinking: { type: 'disabled' } },
      parsed: disabledParsed,
      outboundBody: { generationConfig: { thinkingConfig: { thinkingLevel: 'low', includeThoughts: false } } },
      model: 'gemini-3-pro-high',
    }),
    'none',
  )

  // Model suffix fallback when request carries no explicit thinking fields.
  assert.equal(
    resolveGeminiReasoningEffort({
      inbound: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      model: 'ag-claude-sonnet-4-6-high',
      upstreamModel: 'claude-sonnet-4-6-high',
    }),
    'high',
  )
})

test('normalizeGeminiUsage and decoder.flush preserve split usageMetadata and missing finishReason totals', () => {
  assert.deepEqual(
    normalizeGeminiUsage({
      cached_content_token_count: 40,
      candidates_token_count: 30,
      thoughts_token_count: 20,
      total_token_count: 150,
    }),
    {
      input_tokens: 60,
      output_tokens: 50,
      cache_read_tokens: 40,
      reasoning_tokens: 20,
      total_tokens: 150,
    },
  )

  const decoder = createGeminiEventDecoder({ fallbackModel: 'gemini-2.5-pro' })
  const collector = createGeminiCollector({ fallbackModel: 'gemini-2.5-pro' })
  const emit = (ev) => collector.push(ev)
  const splitter = createSseFrameSplitter((frame) => decoder.decodeSseFrame(frame, emit))
  splitter.push(
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'Hello ' }] } }],
      usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40 },
    })}\n\n`,
  )
  // Second chunk omits cachedContentTokenCount and finishReason; flush must emit merged usage.
  splitter.push(
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'world' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 25, thoughtsTokenCount: 15, totalTokenCount: 140 },
    })}\n\n`,
  )
  splitter.flush()
  decoder.flush(emit)

  const res = collector.result()
  assert.equal(res.text, 'Hello world')
  assert.deepEqual(res.usage, {
    input_tokens: 60,
    output_tokens: 40,
    cache_read_tokens: 40,
    reasoning_tokens: 15,
    total_tokens: 140,
  })
})

test('delegated handle-protocol path captures inbound/outbound debug bodies, timing, effort, and real attempts/errors', async (t) => {
  const store = tmpLogStore('debug')
  t.after(() => {
    store.db.close()
    fs.rmSync(store.dataDir, { recursive: true, force: true })
  })

  let streamCalls = 0
  const envs = [
    {
      id: 'env-a',
      proxy_id: 'px-1',
      auth_state: 'authorized',
      auth_method: 'api_key',
      models_discovered: true,
      models: ['gemini-4-neon'],
      capabilities: [...FULL_GEMINI_CAPABILITIES],
    },
    {
      id: 'env-b',
      proxy_id: 'px-2',
      auth_state: 'authorized',
      auth_method: 'api_key',
      models_discovered: true,
      models: ['gemini-4-neon'],
      capabilities: [...FULL_GEMINI_CAPABILITIES],
    },
  ]
  const scheduler = createGeminiScheduler({
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return envs.find((e) => e.id === payload.id)
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async () => {
      streamCalls += 1
      if (streamCalls === 1) {
        return delayedSseResponse([JSON.stringify({ code: 'gemini_quota_exhausted', message: '429' })], {
          statusCode: 429,
          contentType: 'application/json',
        })
      }
      return delayedSseResponse([
        {
          delayMs: 10,
          data: `data: ${JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'delegated-ok' }] } }],
            usageMetadata: { promptTokenCount: 200, cachedContentTokenCount: 150 },
          })}\n\n`,
        },
        {
          delayMs: 25,
          data: `data: ${JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: '!' }] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 200,
              cachedContentTokenCount: 150,
              candidatesTokenCount: 20,
              thoughtsTokenCount: 10,
              totalTokenCount: 230,
            },
          })}\n\n`,
        },
      ])
    },
    resolveProxy: () => 'socks5h://192.0.2.10:1080',
  })

  const geminiHandler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async () => ({}),
    scheduler,
    requestLog: store,
    groupsRepo: { rateMultiplier: () => 1 },
  })

  const protocolHandler = createHandleProtocol({
    json: jsonResponder,
    writeSSEHeaders(res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
    },
    readBody: async (req) => req.body,
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 5000 },
      paths: { data: store.dataDir },
    },
    requestLog: store,
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfig: { failover: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    handleGeminiMessages: (req, res, opts) => geminiHandler(req, res, opts),
    handleGeminiPublic: (req, res, opts) => geminiHandler(req, res, opts),
  })

  // Delegated gemini-group /v1/messages call with failover (attempt_count === 2).
  const res = makeRes()
  const req = makeReq({
    url: '/v1/messages',
    groupType: 'gemini',
    headers: { 'x-claude-code-session-id': 'cc-sess-42' },
    body: {
      model: 'gemini-4-neon',
      max_tokens: 256,
      output_config: { effort: 'max' },
      messages: [{ role: 'user', content: 'hello via anthropic' }],
    },
  })
  await protocolHandler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')
  assert.equal(res.statusCode, 200)

  const row = store.queryNormal({ limit: 5 }).items[0]
  assert.equal(row.attempt_count, 2)
  assert.equal(row.upstream_status, 200)
  assert.equal(row.reasoning_effort, 'max')
  assert.equal(row.session_id, 'cc-sess-42')
  assert.equal(row.outbound_session_id, 'cc-sess-42')
  assert.equal(row.input_tokens, 50)
  assert.equal(row.cache_read_tokens, 150)
  assert.equal(row.output_tokens, 30)
  assert.ok(row.generation_ms != null && row.generation_ms > 0)

  const dbg = store.getDebug(row.request_id)
  assert.ok(dbg.inbound_body?.messages?.length === 1)
  assert.equal(dbg.inbound_summary?.messages_count, 1)
  assert.equal(dbg.outbound_body_source, 'gemini_api')
  assert.ok(dbg.outbound_body?.contents?.length === 1)
  assert.equal(dbg.outbound_headers_source, null)
  assert.equal(dbg.response?.status, 200)
  assert.match(dbg.response?.body || '', /delegated-ok!/)

  // Validation error records attempt_count === 0 and captures 400 debug response body.
  const badRes = makeRes()
  await geminiHandler(
    makeReq({
      url: '/v1beta/models/gemini-4-neon:generateContent',
      groupType: 'gemini',
      body: { contents: [] },
    }),
    badRes,
  )
  assert.equal(badRes.statusCode, 400)
  const badRow = store.queryNormal({ limit: 5 }).items.find((r) => r.status === 400)
  assert.equal(badRow.attempt_count, 0)
  assert.equal(badRow.upstream_status, null)
  const badDbg = store.getDebug(badRow.request_id)
  assert.equal(badDbg.response?.status, 400)
  assert.match(badDbg.response?.body || '', /contents must be a non-empty array/)
})

test('client cancel logs final_state=cancelled and error-class ignores gemini_inference_cancelled', async (t) => {
  const store = tmpLogStore('normal')
  t.after(() => {
    store.db.close()
    fs.rmSync(store.dataDir, { recursive: true, force: true })
  })

  const scheduler = createGeminiScheduler({
    callHost: async (op) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-cancel',
              proxy_id: 'px-1',
              auth_state: 'authorized',
              auth_method: 'api_key',
              models_discovered: true,
              models: ['gemini-4-neon'],
              capabilities: [...FULL_GEMINI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get') return { id: 'env-cancel', proxy_id: 'px-1', auth_method: 'api_key' }
      if (op === 'infer-cancel') return { cancelled: true }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async () => {
      const stream = new Readable({ read() {} })
      stream.statusCode = 200
      stream.headers = { 'content-type': 'text/event-stream' }
      return stream
    },
    resolveProxy: () => 'socks5h://192.0.2.10:1080',
  })

  const handler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async () => ({}),
    scheduler,
    requestLog: store,
    groupsRepo: { rateMultiplier: () => 1 },
  })

  const req = makeReq({
    url: '/v1beta/models/gemini-4-neon:streamGenerateContent',
    groupType: 'gemini',
    body: { contents: [{ role: 'user', parts: [{ text: 'wait' }] }] },
  })
  const res = makeRes()
  const running = handler(req, res)
  await new Promise((r) => setTimeout(r, 25))
  req.emit('aborted')
  await running

  const row = store.queryNormal({ limit: 5 }).items[0]
  assert.equal(row.status, 499)
  assert.equal(row.final_state, 'cancelled')
  assert.equal(row.error_code, 'gemini_inference_cancelled')
  assert.equal(row.attempt_count, 1)
  assert.equal(isIgnoredClientCancel(row), true)
  assert.equal(isErrorRow(row), false)
})

test('summarizeBody extracts Gemini native contents, tools, thinkingConfig, maxOutputTokens, and systemInstruction', () => {
  const summary = summarizeBody({
    systemInstruction: { parts: [{ text: 'System rules' }] },
    contents: [
      { role: 'user', parts: [{ text: 'q1' }] },
      { role: 'model', parts: [{ text: 'a1' }] },
    ],
    tools: [
      {
        functionDeclarations: [{ name: 'fn_a' }, { name: 'fn_b' }],
      },
    ],
    generationConfig: {
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: 4096 },
    },
  })
  assert.equal(summary.messages_count, 2)
  assert.deepEqual(summary.roles, ['user', 'model'])
  assert.equal(summary.tools_count, 1)
  assert.equal(summary.tool_functions_count, 2)
  assert.equal(summary.max_tokens, 1024)
  assert.equal(summary.has_thinking, true)
  assert.equal(summary.system_len, 'System rules'.length)
})

test('API-backend Gemini path records first_byte_ms, first_token_ms, generation_ms, cache, reasoning_effort, and outbound_body', async (t) => {
  const store = tmpLogStore('debug')
  const sockPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\kin-gem-api-rlog-${process.pid}-${Date.now()}`
      : path.join(store.dataDir, 'run', 'api-kernel.sock')
  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(sockPath), { recursive: true })
  const prevSock = process.env.KIN_API_KERNEL_SOCK
  process.env.KIN_API_KERNEL_SOCK = sockPath

  const kernel = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'close' })
      setTimeout(() => {
        res.write(
          `data: ${JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'Thought', thought: true }] } }],
            usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 300 },
          })}\n\n`,
        )
      }, 15)
      setTimeout(() => {
        res.write(
          `data: ${JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'API ok' }] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 500,
              cachedContentTokenCount: 300,
              candidatesTokenCount: 60,
              thoughtsTokenCount: 40,
              totalTokenCount: 600,
            },
          })}\n\n`,
        )
        res.end()
      }, 45)
    })
  })
  await new Promise((resolve, reject) => {
    kernel.once('error', reject)
    kernel.listen(sockPath, resolve)
  })

  t.after(async () => {
    if (prevSock === undefined) delete process.env.KIN_API_KERNEL_SOCK
    else process.env.KIN_API_KERNEL_SOCK = prevSock
    kernel.closeAllConnections?.()
    await new Promise((resolve) => kernel.close(resolve))
    store.db.close()
    fs.rmSync(store.dataDir, { recursive: true, force: true })
  })

  const protocolHandler = createHandleProtocol({
    json: jsonResponder,
    writeSSEHeaders(res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
    },
    readBody: async (req) => req.body,
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 5000 },
      paths: { data: store.dataDir },
    },
    requestLog: store,
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
    apiScheduler: {
      pick: () => ({
        ok: true,
        endpoint: { id: 'ep-gem', kind: 'gemini', protocol: 'gemini', base_url: 'https://gemini.invalid' },
        requested_model: 'gemini-3-pro-high',
        upstream_model: 'gemini-3-pro',
        key: { id: 'key-upstream-1', api_key: 'secret-gem-key' },
      }),
    },
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfig: { failover: {} },
    groupsRepo: { rateMultiplier: () => 1 },
  })

  const req = makeReq({
    url: '/v1beta/models/gemini-3-pro-high:generateContent',
    groupType: 'gemini',
    body: {
      contents: [{ role: 'user', parts: [{ text: 'hello api gemini' }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } },
    },
  })
  req.apiKeyRecord = { id: 'key-api-1', user_id: null, group_id: 1, group_type: 'gemini', category: 'api' }
  const res = makeRes()

  await protocolHandler.handleProtocol(req, res, 'google.gemini', '/v1beta/models/gemini-3-pro-high:generateContent', {
    routeModel: 'gemini-3-pro-high',
    routeStream: false,
  })

  assert.equal(res.statusCode, 200)
  const row = store.queryNormal({ limit: 5 }).items[0]
  assert.equal(row.input_tokens, 200)
  assert.equal(row.cache_read_tokens, 300)
  assert.equal(row.output_tokens, 100)
  assert.equal(row.reasoning_effort, 'medium')
  assert.equal(row.stop_reason, 'stop')
  assert.ok(row.first_byte_ms != null && row.first_byte_ms >= 0)
  assert.ok(row.first_token_ms != null && row.first_token_ms >= row.first_byte_ms)
  assert.ok(row.generation_ms != null && row.generation_ms > 0)

  const dbg = store.getDebug(row.request_id)
  assert.equal(dbg.outbound_body_source, 'gemini_api')
  assert.ok(dbg.outbound_body?.contents?.length === 1)
  assert.equal(dbg.outbound_headers_source, null)
  assert.equal(dbg.response?.status, 200)
  assert.match(dbg.response?.body || '', /API ok/)
})

test('Gemini OAuth preserves upstream-reported modelVersion in logs, model_mismatch, and non-streaming responses (#1728)', async (t) => {
  const store = tmpLogStore('normal')
  t.after(() => {
    store.db.close()
    fs.rmSync(store.dataDir, { recursive: true, force: true })
  })

  const dispatched = []
  let script = []
  const scheduler = createGeminiScheduler({
    callHost: async (op) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-h2n',
              proxy_id: 'px-1',
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              models: ['gemini-4-hydrogen-high', 'gemini-4-neon-high'],
              capabilities: [...FULL_GEMINI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get') return { id: 'env-h2n', proxy_id: 'px-1', auth_method: 'oauth' }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async (_op, payload) => {
      dispatched.push(payload.model)
      return delayedSseResponse(script)
    },
    resolveProxy: () => 'socks5h://192.0.2.10:1080',
  })

  const handler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async () => ({}),
    scheduler,
    requestLog: store,
    groupsRepo: { rateMultiplier: () => 1 },
    apiKeyStore: { users: { getById: () => ({ id: 9, role: 'admin' }) } },
  })

  // 1. Streaming request for Hydrogen where upstream self-reports Neon.
  script = [
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
      modelVersion: 'gemini-4-neon',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    })}\n\n`,
  ]
  const resStream = makeRes()
  await handler(
    makeReq({
      url: '/v1beta/models/gemini-4-hydrogen-high:streamGenerateContent?alt=sse',
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    }),
    resStream,
  )
  assert.equal(resStream.statusCode, 200)
  const sseFrames = resStream
    .bodyText()
    .split('\n\n')
    .filter((b) => b.startsWith('data:'))
    .map((b) => JSON.parse(b.slice(5).trim()))
  assert.ok(sseFrames.length >= 1)
  assert.ok(sseFrames.every((f) => f.modelVersion === 'gemini-4-neon'))

  // 2. Non-streaming request for Hydrogen where upstream self-reports Neon.
  const resJson = makeRes()
  await handler(
    makeReq({
      url: '/v1beta/models/gemini-4-hydrogen-high:generateContent',
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    }),
    resJson,
  )
  assert.equal(resJson.statusCode, 200)
  assert.equal(resJson.jsonBody().modelVersion, 'gemini-4-neon')

  // 3. Late modelVersion arriving only on a subsequent SSE chunk.
  script = [
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'part1' }] } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'part2' }] }, finishReason: 'STOP' }],
      modelVersion: 'gemini-4-neon',
    })}\n\n`,
  ]
  const resLate = makeRes()
  await handler(
    makeReq({
      url: '/v1beta/models/gemini-4-hydrogen-high:streamGenerateContent?alt=sse',
      body: { contents: [{ role: 'user', parts: [{ text: 'late' }] }] },
    }),
    resLate,
  )
  assert.equal(resLate.statusCode, 200)
  const lateFrames = resLate
    .bodyText()
    .split('\n\n')
    .filter((b) => b.startsWith('data:'))
    .map((b) => JSON.parse(b.slice(5).trim()))
  assert.equal(lateFrames.at(-1).modelVersion, 'gemini-4-neon')

  // 4. Control: upstream omits modelVersion -> falls back to dispatched model, no mismatch.
  script = [
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'plain' }] }, finishReason: 'STOP' }],
    })}\n\n`,
  ]
  const resControl = makeRes()
  await handler(
    makeReq({
      url: '/v1beta/models/gemini-4-hydrogen-high:generateContent',
      body: { contents: [{ role: 'user', parts: [{ text: 'control' }] }] },
    }),
    resControl,
  )
  assert.equal(resControl.statusCode, 200)
  assert.equal(resControl.jsonBody().modelVersion, 'gemini-4-hydrogen-high')

  assert.deepEqual(dispatched, [
    'gemini-4-hydrogen-high',
    'gemini-4-hydrogen-high',
    'gemini-4-hydrogen-high',
    'gemini-4-hydrogen-high',
  ])

  const rows = store.db
    .prepare(
      'SELECT path, model, requested_model, upstream_model, model_mismatch, reasoning_effort FROM usage_logs ORDER BY rowid ASC',
    )
    .all()
  assert.equal(rows.length, 4)

  // Streaming, non-streaming, and late-chunk mismatch all record Neon + model_mismatch = 1, while preserving effort from dispatched Hydrogen-high.
  for (const row of rows.slice(0, 3)) {
    assert.equal(row.model, 'gemini-4-hydrogen-high')
    assert.equal(row.requested_model, 'gemini-4-hydrogen-high')
    assert.equal(row.upstream_model, 'gemini-4-neon')
    assert.equal(row.model_mismatch, 1)
    assert.equal(row.reasoning_effort, 'high')
  }
  assert.equal(rows[3].requested_model, 'gemini-4-hydrogen-high')
  assert.equal(rows[3].upstream_model, 'gemini-4-hydrogen-high')
  assert.equal(rows[3].model_mismatch, 0)
})
