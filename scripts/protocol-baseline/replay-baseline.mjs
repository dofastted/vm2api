#!/usr/bin/env node
/**
 * L1 Local Real-Request Standard Baseline Recorder, Verifier & Benchmark Runner.
 *
 * Drives the REAL vm2api protocol handlers (Claude CRAG, Gemini CRAGGemini, Codex Kernel,
 * and external API endpoints) in isolated temp directories against 100% local loopback
 * mocks (zero external network traffic, zero live vms/ or data/ access).
 *
 * Usage:
 *   node scripts/protocol-baseline/replay-baseline.mjs --record golden/node-dev-v0.json
 *   node scripts/protocol-baseline/replay-baseline.mjs --verify golden/node-dev-v0.json
 *   node scripts/protocol-baseline/replay-baseline.mjs --bench
 */
import crypto from 'node:crypto'
import EventEmitter from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { createGeminiPublicHandler } from '../../src/lib/gemini/routes.mjs'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { createGeminiCollector, createGeminiRestoreTransform } from '../../src/lib/protocol/gemini-convert.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { shutdownProtoFront } from '../../src/lib/transport/proto-front-client.mjs'
import { activateFixture, seedEncryptedPackage } from '../../test/fixtures/crag-license.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CORPUS = path.join(__dirname, 'corpus/standard-baseline.json')
const MOCK_ANSWER = '{"count":7}'
const CRAG_CAPABILITIES = [
  'generation_controls_v3',
  'linux_tui_native_queue',
  'prompt_append',
  'prompt_replace',
  'system_text_cache_v3',
  'native_handoff_v1',
  'request_safeguards',
  'request_speed',
  'provider_managed_tools_v1',
]

function parseArgs(argv) {
  const args = { ids: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--record' || t === '--verify' || t === '--corpus' || t === '--save-candidate') {
      args[t.slice(2).replace(/-/g, '_')] = argv[++i]
    } else if (t === '--bench' || t === '--strict-improvements') {
      args[t.slice(2).replace(/-/g, '_')] = true
    } else if (!t.startsWith('--')) {
      args.ids.push(t)
    }
  }
  return args
}

function makeFakeReq(reqSpec, keyRecord = { id: 'key-baseline', group_type: 'all', group_id: 1 }) {
  const emitter = new EventEmitter()
  const headers = {}
  for (const [k, v] of Object.entries(reqSpec.headers || {})) headers[k.toLowerCase()] = String(v)
  return Object.assign(emitter, {
    method: reqSpec.method || 'POST',
    url: reqSpec.path || '/v1/messages',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    apiKeyKind: 'managed',
    apiKeyRecord: keyRecord,
    presentedApiKey: 'sk-fixture-baseline-key',
    aborted: false,
  })
}

function makeFakeRes() {
  const emitter = new EventEmitter()
  const headers = {}
  const chunks = []
  const res = Object.assign(emitter, {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader(k, v) {
      headers[String(k).toLowerCase()] = v
    },
    getHeader(k) {
      return headers[String(k).toLowerCase()]
    },
    writeHead(status, hdrs = {}) {
      this.statusCode = status
      this.headersSent = true
      for (const [k, v] of Object.entries(hdrs)) headers[String(k).toLowerCase()] = v
      return this
    },
    write(chunk) {
      if (!this.headersSent) this.headersSent = true
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    },
    end(chunk) {
      if (chunk != null) this.write(chunk)
      this.writableEnded = true
      this.emit('finish')
      return this
    },
    _headers: headers,
    _chunks: chunks,
  })
  return res
}

function decodeSseFrames(rawText) {
  const normalized = String(rawText || '').replace(/\r\n/g, '\n')
  const blocks = normalized.split('\n\n').filter((b) => b.trim() !== '')
  const frames = []
  for (const block of blocks) {
    let eventName = null
    const dataLines = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    const rawData = dataLines.join('\n')
    if (!rawData) continue
    let data = rawData
    if (rawData !== '[DONE]') {
      try {
        data = JSON.parse(rawData)
      } catch {}
    }
    frames.push(eventName ? { event: eventName, data } : { data })
  }
  return frames
}

function normalizeDynamic(value, key = '') {
  if (typeof value === 'string') {
    if (
      (key === 'id' || key === 'item_id' || key === 'call_id' || key === 'response_id') &&
      /^(msg_|chatcmpl[-_]|cmpl[-_]|resp_|rs_|fc_|call_|item_|toolu_synth_)/.test(value)
    ) {
      return `${value.split(/[-_]/)[0]}_<id>`
    }
    if (key === 'responseId' && value) return 'resp_<id>'
    if (key === 'prompt_cache_key' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) return '<rebuilt-uuid>'
    if (key === 'session_id' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) return '<uuid>'
    if (key === 'x-claude-code-session-id' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) return '<uuid>'
    if (key === 'request_id' && value) return '<req-id>'
    if (value.startsWith('x-anthropic-billing-header:')) {
      return value.replace(/(?<=; cch=)[0-9a-f]+(?=;)/, '<cch>')
    }
    if (key === 'user_id' && value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value)
        if (parsed.session_id) parsed.session_id = '<session>'
        return JSON.stringify(parsed)
      } catch {}
    }
    return value
  }
  if (typeof value === 'number') {
    if (key === 'created' || key === 'created_at' || key === 'timestamp') return '<ts>'
    return value
  }
  if (Array.isArray(value)) return value.map((item) => normalizeDynamic(item))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const k of Object.keys(value).sort()) {
    if (k === 'request_id' || k === 'ts' || k === 'created' || k === 'created_at') {
      out[k] = '<dynamic>'
      continue
    }
    out[k] = normalizeDynamic(value[k], k)
  }
  return out
}

function buildAnthropicMockSse(model, mode) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_mock_01',
        type: 'message',
        role: 'assistant',
        model: model || 'claude-haiku-4-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 18, output_tokens: 0, cache_read_input_tokens: 4 },
      },
    },
  ]
  if (mode === 'ok_tool_call') {
    events.push(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_mock_1', name: 'lookup', input: {} },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"row":7}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    )
  } else if (mode === 'ok_thinking_tool') {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'checking row 7' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig_mock_valid_0123456789abcdef0123456789' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_mock_2', name: 'lookup', input: {} },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"row":7}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 24 } },
      { type: 'message_stop' },
    )
  } else {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: MOCK_ANSWER } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } },
      { type: 'message_stop' },
    )
  }
  return events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('')
}

function buildResponsesMockLines(model, mode) {
  const id = 'resp_mock_01'
  if (mode === 'ok_tool_call') {
    const item = {
      type: 'function_call',
      id: 'fc_mock_1',
      call_id: 'call_mock_1',
      name: 'lookup',
      arguments: '{"row":7}',
    }
    return [
      `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id, model, status: 'in_progress' } })}\n\n`,
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } })}\n\n`,
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_mock_1', output_index: 0, delta: '{"row":7}' })}\n\n`,
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id,
          object: 'response',
          model,
          status: 'completed',
          output: [item],
          usage: { input_tokens: 18, output_tokens: 12, total_tokens: 30 },
        },
      })}\n\n`,
    ]
  }
  if (mode === 'ok_thinking_tool') {
    const rItem = { type: 'reasoning', id: 'rs_mock_1', summary: [{ type: 'summary_text', text: 'checking row 7' }] }
    const fItem = {
      type: 'function_call',
      id: 'fc_mock_2',
      call_id: 'call_mock_2',
      name: 'lookup',
      arguments: '{"row":7}',
    }
    return [
      `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id, model, status: 'in_progress' } })}\n\n`,
      `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_mock_1', output_index: 0, delta: 'checking row 7' })}\n\n`,
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 1, item: { ...fItem, arguments: '' } })}\n\n`,
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_mock_2', output_index: 1, delta: '{"row":7}' })}\n\n`,
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 1, item: fItem })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id,
          object: 'response',
          model,
          status: 'completed',
          output: [rItem, fItem],
          usage: {
            input_tokens: 18,
            output_tokens: 24,
            total_tokens: 42,
            output_tokens_details: { reasoning_tokens: 10 },
          },
        },
      })}\n\n`,
    ]
  }
  const msg = {
    type: 'message',
    id: 'msg_mock_r1',
    role: 'assistant',
    content: [{ type: 'output_text', text: MOCK_ANSWER }],
  }
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id, model, status: 'in_progress' } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_mock_r1', output_index: 0, content_index: 0, delta: MOCK_ANSWER })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: msg })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id,
        object: 'response',
        model,
        status: 'completed',
        output: [msg],
        usage: { input_tokens: 18, output_tokens: 6, total_tokens: 24 },
      },
    })}\n\n`,
  ]
}

function buildGeminiMockEvents(mode, outboundBody) {
  const firstTool = outboundBody?.tools?.[0]?.functionDeclarations?.[0]?.name || 'lookup'
  if (mode === 'ok_tool_call') {
    return [
      { kind: 'tool_call', id: 'gem_call_1', name: firstTool, args: { row: 7 } },
      { kind: 'usage', usage: { input_tokens: 18, output_tokens: 12, total_tokens: 30 } },
      { kind: 'stop', stopReason: 'tool_use', finishReason: 'STOP' },
    ]
  }
  if (mode === 'ok_thinking_tool') {
    return [
      { kind: 'thinking', text: 'checking row 7' },
      { kind: 'thinking_signature', signature: 'sig-gem-mock-01' },
      { kind: 'tool_call', id: 'gem_call_2', name: firstTool, args: { row: 7 }, signature: 'sig-gem-mock-01' },
      { kind: 'usage', usage: { input_tokens: 18, output_tokens: 24, reasoning_tokens: 10, total_tokens: 42 } },
      { kind: 'stop', stopReason: 'tool_use', finishReason: 'STOP' },
    ]
  }
  return [
    { kind: 'text', text: MOCK_ANSWER },
    { kind: 'usage', usage: { input_tokens: 18, output_tokens: 6, total_tokens: 24 } },
    { kind: 'stop', stopReason: 'stop', finishReason: 'STOP' },
  ]
}

function buildGeminiRestMockSse(model, mode) {
  const body =
    mode === 'ok_tool_call'
      ? {
          candidates: [
            {
              content: { role: 'model', parts: [{ functionCall: { id: 'gc_1', name: 'lookup', args: { row: 7 } } }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 12, totalTokenCount: 30 },
          modelVersion: model,
        }
      : {
          candidates: [{ content: { role: 'model', parts: [{ text: MOCK_ANSWER }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 6, totalTokenCount: 24 },
          modelVersion: model,
        }
  return `data: ${JSON.stringify(body)}\n\n`
}

async function runClaudeCragCase(testCase, env) {
  const routing = {
    inference: { engine: 'rust', dataplane: 'crag', crag_kernel_version: 'v2' },
    compatibility: {
      official_cc_passthrough: false,
      detect_proxied_official_cc: true,
      claude_code_only: false,
      crag_persona_preset: 'official_full',
      persona_preset: 'official_full',
      cache_ttl: '5m',
      ...(testCase.web_settings?.compatibility || {}),
    },
    sticky: { outbound_session: 'rebuild', ...(testCase.web_settings?.sticky || {}) },
  }
  fs.writeFileSync(env.routingPath, JSON.stringify(routing))
  env.cragCapture.length = 0
  env.cragMockMode = testCase.mock_upstream?.mode || 'ok_text'

  const res = makeFakeRes()
  const req = makeFakeReq(testCase.request)
  const vmRecord = env.cragVm
  const candidate = {
    vmId: vmRecord.id,
    accountId: `acc-crag-${testCase.id}`,
    vm: vmRecord,
    exec: { vm: vmRecord, projectRoot: env.root, homeDir: env.cragHomeDir },
    release() {},
  }
  const fakeRunner = {
    async run({ canonicalBody, applyAttempt, callAttempt }) {
      const attempt = await applyAttempt(canonicalBody, candidate, { attemptStartedAt: 1700000000000 })
      const result = await callAttempt({
        candidate,
        body: attempt.body,
        attemptMeta: attempt.meta,
        deliveryMode: 'realtime',
        signal: new AbortController().signal,
        onCommit() {},
      })
      return { ...result, vmId: candidate.vmId, accountId: candidate.accountId, attempts: 1 }
    },
  }

  let jsonResult = null
  const { handleProtocol } = createHandleProtocol({
    json: (r, status, payload) => {
      jsonResult = { status, payload }
      r.writeHead(status, { 'content-type': 'application/json' })
      r.end(JSON.stringify(payload))
    },
    writeSSEHeaders: (r) => {
      r.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    },
    readBody: async () => structuredClone(testCase.request.body),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 16 * 1024 * 1024, upstream_timeout_ms: 15_000, stream_keepalive_ms: 0 },
      paths: { data: env.root, project: env.root },
    },
    routingConfigPath: env.routingPath,
    getRoutingConfig: () => routing,
    getFailoverRunner: () => fakeRunner,
    admitCragInference: async () => null,
    requestLog: { start: () => ({ request_id: testCase.id, t0: Date.now() }), finish() {} },
    stickyRouter: {},
    accountQuota: { sessions: null },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
    groupsRepo: { rateMultiplier: () => 1 },
    refusalGuards: { get: () => null, remember() {} },
    settings: { get: (_k, fb) => fb },
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
  })

  const t0 = performance.now()
  await handleProtocol(req, res, testCase.inbound_protocol, testCase.request.path)
  const elapsedMs = performance.now() - t0

  const isSse = String(res._headers['content-type'] || '').includes('text/event-stream')
  const rawOut = res._chunks.join('')
  const clientResp = isSse ? decodeSseFrames(rawOut) : (jsonResult?.payload ?? (rawOut ? JSON.parse(rawOut) : null))

  return {
    status: res.statusCode,
    calls: env.cragCapture.length,
    envelopes: env.cragCapture.map((e) => normalizeDynamic(e)),
    client_response_kind: isSse ? 'sse' : 'json',
    client_response: normalizeDynamic(clientResp),
    elapsed_ms: Number(elapsedMs.toFixed(3)),
  }
}

async function runCodexCase(testCase, env) {
  resetOpenAIAccountRuntime()
  const routing = {
    codex: {
      enabled: true,
      protocols: {
        'openai.responses': { mode: 'native', enabled: true },
        'openai.chat': { mode: 'convert', enabled: true },
        'openai.completions': { mode: 'convert', enabled: true },
        'anthropic.messages': { mode: 'convert', enabled: true },
      },
      convert: { chat_to_codex: true, completions_to_codex: true, anthropic_to_codex: true },
      clients: { official_codex: 'allow', openai_compatible: 'allow', claude_code: 'reject', unknown: 'allow' },
      ...(testCase.web_settings?.codex || {}),
    },
    sticky: { outbound_session: 'rebuild', ...(testCase.web_settings?.sticky || {}) },
    failover: { max_total_attempts: 1, max_account_switches: 0, max_same_account_retries: 0 },
  }
  fs.writeFileSync(env.routingPath, JSON.stringify(routing))
  const captured = []
  const mode = testCase.mock_upstream?.mode || 'ok_text'

  const res = makeFakeRes()
  const req = makeFakeReq(testCase.request)
  let jsonResult = null
  const { handleProtocol } = createHandleProtocol({
    json: (r, status, payload) => {
      jsonResult = { status, payload }
      r.writeHead(status, { 'content-type': 'application/json' })
      r.end(JSON.stringify(payload))
    },
    writeSSEHeaders: (r) => {
      r.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    },
    readBody: async () => structuredClone(testCase.request.body),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 16 * 1024 * 1024, upstream_timeout_ms: 15_000 },
      paths: { data: env.root, project: env.root },
    },
    routingConfigPath: env.routingPath,
    getRoutingConfig: () => routing,
    requestLog: { start: () => ({ request_id: testCase.id, t0: Date.now() }), finish() {} },
    stickyRouter: {},
    accountQuota: { sessions: null },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
    groupsRepo: { rateMultiplier: () => 1 },
    refusalGuards: { get: () => null, remember() {} },
    settings: { get: (_k, fb) => fb },
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    codexOps: {
      writeCodexKernelConfig: () => ({ ok: true }),
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ body, headers, session, options, onEvent }) => {
        captured.push({ headers, body, session, options })
        if (mode === 'http_400') {
          return {
            ok: false,
            status: 400,
            committed: false,
            body: { error: { type: 'invalid_request_error', code: 'mock_bad_request', message: 'mock codex 400' } },
          }
        }
        const lines = buildResponsesMockLines(body?.model || 'gpt-5.4', mode)
        for (const chunk of lines) {
          for (const line of chunk.split('\n')) {
            if (line) await onEvent(`${line}\n`)
          }
        }
        return { ok: true, status: 200, committed: true, terminalState: 'verified' }
      },
    },
  })

  const t0 = performance.now()
  await handleProtocol(req, res, testCase.inbound_protocol, testCase.request.path)
  const elapsedMs = performance.now() - t0

  const isSse = String(res._headers['content-type'] || '').includes('text/event-stream')
  const rawOut = res._chunks.join('')
  const clientResp = isSse ? decodeSseFrames(rawOut) : (jsonResult?.payload ?? (rawOut ? JSON.parse(rawOut) : null))

  return {
    status: res.statusCode,
    calls: captured.length,
    envelopes: captured.map((e) => normalizeDynamic(e)),
    client_response_kind: isSse ? 'sse' : 'json',
    client_response: normalizeDynamic(clientResp),
    elapsed_ms: Number(elapsedMs.toFixed(3)),
  }
}

async function runGeminiCragCase(testCase, env) {
  const routing = {
    compatibility: {
      craggemini_persona_preset: 'official_full',
      craggemini_prompt_normalization: 'auto',
      craggemini_system_prompt: '',
      ...(testCase.web_settings?.compatibility || {}),
    },
    gemini: {
      enabled: true,
      ...(testCase.web_settings?.gemini || {}),
    },
  }
  const captured = []
  const mode = testCase.mock_upstream?.mode || 'ok_text'
  const scheduler = {
    async stream({ model, targetBodyFor, restoreContext, requiredCapabilities, unsupportedFields, onEvent }) {
      const built = targetBodyFor('antigravity', {
        upstreamModel: model,
        conversationId: 'gem-conv-fixed-01',
      })
      captured.push({
        target: 'antigravity',
        model,
        body: built,
        requiredCapabilities,
        unsupportedFields,
        restoreToolMap: restoreContext?.toolNameMap ? Object.fromEntries(restoreContext.toolNameMap) : {},
      })
      if (mode === 'http_400') {
        const err = new Error('mock gemini 400')
        err.status = 400
        err.code = 'gemini_upstream_error'
        err.upstreamStatus = 400
        throw err
      }
      const rawEvents = buildGeminiMockEvents(mode, built)
      const restore = createGeminiRestoreTransform(restoreContext, { target: 'antigravity', model })
      const collector = createGeminiCollector({ fallbackModel: model })
      const emit = (ev) => {
        collector.push(ev)
        if (typeof onEvent === 'function') onEvent(ev)
      }
      for (const rawEv of rawEvents) restore.push(rawEv, emit)
      restore.flush(emit)
      const collected = collector.result()
      return {
        model,
        response_model: model,
        account_id: 'gem-acc-1',
        ...collected,
        attempt_count: 1,
        upstream_status: 200,
      }
    },
  }

  let jsonResult = null
  const handleGeminiPublic = createGeminiPublicHandler({
    json: (r, status, payload) => {
      jsonResult = { status, payload }
      r.writeHead(status, { 'content-type': 'application/json' })
      r.end(JSON.stringify(payload))
    },
    readBody: async () => structuredClone(testCase.request.body),
    scheduler,
    getRoutingConfig: () => routing,
  })

  const req = makeFakeReq(testCase.request, { id: 'key-gem', group_type: 'gemini', group_id: 1 })
  const res = makeFakeRes()
  const t0 = performance.now()
  await handleGeminiPublic(req, res)
  const elapsedMs = performance.now() - t0

  const isSse = String(res._headers['content-type'] || '').includes('text/event-stream')
  const rawOut = res._chunks.join('')
  const clientResp = isSse ? decodeSseFrames(rawOut) : (jsonResult?.payload ?? (rawOut ? JSON.parse(rawOut) : null))

  return {
    status: res.statusCode,
    calls: captured.length,
    envelopes: captured.map((e) => normalizeDynamic(e)),
    client_response_kind: isSse ? 'sse' : 'json',
    client_response: normalizeDynamic(clientResp),
    elapsed_ms: Number(elapsedMs.toFixed(3)),
  }
}

async function runApiChannelCase(testCase, env) {
  const upstreamProtocol = testCase.target_family.replace('api_', '')
  const routing = {
    compatibility: {
      official_cc_passthrough: false,
      persona_preset: 'official_full',
      ...(testCase.web_settings?.compatibility || {}),
    },
  }
  fs.writeFileSync(env.routingPath, JSON.stringify(routing))
  env.apiCapture.length = 0
  env.apiMockProtocol = upstreamProtocol
  env.apiMockMode = testCase.mock_upstream?.mode || 'ok_text'

  const scheduler = new ApiScheduler()
  const modelName =
    testCase.request.body?.model || testCase.request.path.match(/\/models\/([^/:]+)/)?.[1] || 'api-gemini-2.5-pro'
  scheduler.reload([
    {
      id: `ep-${upstreamProtocol}`,
      kind: 'custom',
      protocol: upstreamProtocol,
      body_policy: testCase.web_settings?.endpoint_body_policy || 'default',
      base_url: 'https://relay.invalid',
      models: [{ name: 'upstream-model', alias: modelName }],
      api_key_entries: [{ id: 'ek-1', api_key: 'sk-fixture-upstream', proxy_url: '' }],
    },
  ])

  let jsonResult = null
  const res = makeFakeRes()
  const req = makeFakeReq(testCase.request, {
    id: 'key-api',
    category: 'api',
    api_endpoint_id: `ep-${upstreamProtocol}`,
    group_type: 'all',
    group_id: 1,
  })
  const { handleProtocol } = createHandleProtocol({
    json: (r, status, payload) => {
      jsonResult = { status, payload }
      r.writeHead(status, { 'content-type': 'application/json' })
      r.end(JSON.stringify(payload))
    },
    writeSSEHeaders: (r) => {
      r.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    },
    readBody: async () => structuredClone(testCase.request.body),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 16 * 1024 * 1024, upstream_timeout_ms: 15_000 },
      paths: { data: env.root, project: env.root },
    },
    routingConfigPath: env.routingPath,
    getRoutingConfig: () => routing,
    requestLog: { start: () => ({ request_id: testCase.id, t0: Date.now() }), finish() {} },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
    apiScheduler: scheduler,
    apiEndpointStore: {},
    groupsRepo: { rateMultiplier: () => 1 },
    refusalGuards: { get: () => null, remember() {} },
    settings: { get: (_k, fb) => fb },
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
  })

  const routeMeta =
    testCase.inbound_protocol === 'google.gemini'
      ? {
          routeModel: modelName,
          routeStream: testCase.request.path.includes(':streamGenerateContent'),
        }
      : undefined
  const t0 = performance.now()
  await handleProtocol(req, res, testCase.inbound_protocol, testCase.request.path, routeMeta)
  const elapsedMs = performance.now() - t0

  const isSse = String(res._headers['content-type'] || '').includes('text/event-stream')
  const rawOut = res._chunks.join('')
  const clientResp = isSse ? decodeSseFrames(rawOut) : (jsonResult?.payload ?? (rawOut ? JSON.parse(rawOut) : null))

  return {
    status: res.statusCode,
    calls: env.apiCapture.length,
    envelopes: env.apiCapture.map((e) => {
      const parsedBody = typeof e.body === 'string' ? JSON.parse(e.body) : e.body
      const hdrs = { ...(e.headers || {}) }
      delete hdrs.authorization
      delete hdrs['x-api-key']
      delete hdrs['x-goog-api-key']
      return normalizeDynamic({ method: e.method, url: e.url, headers: hdrs, body: parsedBody })
    }),
    client_response_kind: isSse ? 'sse' : 'json',
    client_response: normalizeDynamic(clientResp),
    elapsed_ms: Number(elapsedMs.toFixed(3)),
  }
}

async function setupIsolatedEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-baseline-'))
  fs.mkdirSync(path.join(root, 'run'), { recursive: true })
  fs.mkdirSync(path.join(root, 'vms/vm-crag-1/run'), { recursive: true })
  fs.mkdirSync(path.join(root, 'vms/vm-crag-1/home/.claude'), { recursive: true })
  fs.mkdirSync(path.join(root, 'vms/vm-gpt-1'), { recursive: true })

  // Dummy executable path so resolveHopEngine sees a present kernel binary in isolated worktree
  const dummyKernelBin = path.join(root, 'run/dummy-kin-kernel')
  fs.writeFileSync(dummyKernelBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  process.env.KIN_KERNEL_BIN = dummyKernelBin
  process.env.KIN_PROTO_FRONT_SOCK = path.join(root, 'run/proto-front.sock')
  process.env.KIN_PROTO_FRONT_TOKEN = path.join(root, 'run/proto-front.token')

  // Synthetic fixture OAuth credentials for repairLocalCredentialLink + readWorkerCredentialFile
  const fixtureCreds = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fixture-access-token',
      refreshToken: 'fixture-refresh-token',
      expiresAt: Date.now() + 86_400_000,
    },
  })
  const workerCredFile = path.join(root, 'vms/vm-crag-1/home/.claude/credentials.json')
  fs.writeFileSync(workerCredFile, fixtureCreds, { mode: 0o600 })
  fs.symlinkSync('credentials.json', path.join(root, 'vms/vm-crag-1/home/.claude/.credentials.json'))
  fs.writeFileSync(path.join(root, 'vms/vm-crag-1/run/credentials.json'), fixtureCreds, { mode: 0o600 })

  // Valid fixture CRAG package & license in isolated temp dir
  seedEncryptedPackage(root)
  activateFixture(root, { id: 'vm-crag-1' })

  const cragTokenPath = path.join(root, 'vms/vm-crag-1/run/worker.token')
  const cragSockPath = path.join(root, 'vms/vm-crag-1/run/kernel.sock')
  fs.writeFileSync(cragTokenPath, 'fixture-crag-token', { mode: 0o600 })

  const cragVm = {
    id: 'vm-crag-1',
    name: 'vm-crag-1',
    platform: 'anthropic',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    status: 'running',
    schedulable: true,
    has_token: true,
    claude: { account_uuid: 'acc-crag-baseline', has_access: true },
    runtime: {
      kernel_socket: cragSockPath,
      worker_token_file: cragTokenPath,
      worker_run_dir: path.join(root, 'vms/vm-crag-1/run'),
    },
  }
  fs.writeFileSync(path.join(root, 'vms/vm-crag-1.json'), JSON.stringify(cragVm))

  // Isolated Codex VM record
  const codexVm = {
    id: 'vm-gpt-1',
    name: 'vm-gpt-1',
    platform: 'openai',
    family: 'codex',
    codex_kernel: true,
    status: 'running',
    schedulable: true,
    has_token: true,
  }
  fs.writeFileSync(path.join(root, 'vms/vm-gpt-1.json'), JSON.stringify(codexVm))
  fs.writeFileSync(
    path.join(root, 'vms/vm-gpt-1/codex-credentials.json'),
    JSON.stringify({
      accounts: [
        { id: 'gpt-acc-1', access_token: 'fixture-at', refresh_token: 'fixture-rt', chatgpt_account_id: 'vm-gpt-1' },
      ],
    }),
  )

  const env = {
    root,
    routingPath: path.join(root, 'routing.json'),
    cragVm,
    cragHomeDir: path.join(root, 'vms/vm-crag-1/home'),
    cragCapture: [],
    cragMockMode: 'ok_text',
    apiCapture: [],
    apiMockProtocol: 'anthropic',
    apiMockMode: 'ok_text',
  }

  // Local Unix socket mock CRAG worker
  const cragServer = http.createServer(async (req, res) => {
    if (req.url === '/internal/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          healthy: true,
          ready: true,
          ready_slots: 1,
          active: 0,
          waiting: 0,
          idle: 1,
          queued: 0,
          engine: 'rust',
          dataplane: 'crag',
          kernel_version: 'v2',
          runtime_variant: 'crag-v2',
          transport: 'tui',
          cli_version: '2.1.321 (Claude Code)',
          capabilities: CRAG_CAPABILITIES,
        }),
      )
      return
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    env.cragCapture.push(envelope)
    if (env.cragMockMode === 'http_400') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'mock crag 400' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.end(buildAnthropicMockSse(envelope?.body?.model, env.cragMockMode))
  })
  await new Promise((resolve) => cragServer.listen(cragSockPath, resolve))

  // Local Unix socket mock api-kernel
  const apiSockPath = path.join(root, 'run/api-kernel.sock')
  const apiServer = http.createServer(async (req, res) => {
    if (req.url === '/internal/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true,"kernel":"api"}')
      return
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    env.apiCapture.push(envelope)
    const parsedBody = typeof envelope.body === 'string' ? JSON.parse(envelope.body) : envelope.body
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    if (env.apiMockProtocol === 'openai') {
      res.end(buildResponsesMockLines(parsedBody?.model || 'upstream-model', env.apiMockMode).join(''))
    } else if (env.apiMockProtocol === 'gemini') {
      res.end(buildGeminiRestMockSse(parsedBody?.model || 'upstream-model', env.apiMockMode))
    } else {
      res.end(buildAnthropicMockSse(parsedBody?.model || 'upstream-model', env.apiMockMode))
    }
  })
  await new Promise((resolve) => apiServer.listen(apiSockPath, resolve))

  env.close = async () => {
    shutdownProtoFront()
    await Promise.all([new Promise((r) => cragServer.close(r)), new Promise((r) => apiServer.close(r))])
    fs.rmSync(root, { recursive: true, force: true })
  }
  return env
}

async function runCase(testCase, env) {
  if (testCase.target_family === 'claude_crag') return runClaudeCragCase(testCase, env)
  if (testCase.target_family === 'codex_kernel') return runCodexCase(testCase, env)
  if (testCase.target_family === 'gemini_craggemini') return runGeminiCragCase(testCase, env)
  if (testCase.target_family.startsWith('api_')) return runApiChannelCase(testCase, env)
  throw new Error(`Unsupported target_family: ${testCase.target_family}`)
}

function assertImprovementContract(testCase, result) {
  const imp = testCase.expected_improvement
  if (imp === 'G1') {
    if (result.status !== 200 || result.calls !== 1) {
      return `G1 expected 200 & calls=1, got status=${result.status} calls=${result.calls}`
    }
    return null
  }
  if (imp === 'G2') {
    if (result.status !== 200 || result.calls !== 1) {
      return `G2 expected 200 & calls=1, got status=${result.status} calls=${result.calls}`
    }
    const outBody = result.envelopes[0]?.body || {}
    if (!outBody.reasoning?.effort) return `G2 expected reasoning.effort preserved on Codex body`
    if (testCase.request.body.stream && result.client_response_kind === 'sse') {
      const hasThinking = JSON.stringify(result.client_response).includes('thinking_delta')
      if (!hasThinking) return `G2 streaming expected thinking_delta in Anthropic SSE`
    }
    return null
  }
  if (imp === 'G3') {
    if (result.status !== 200 || result.calls !== 1) {
      return `G3 expected 200 & calls=1, got status=${result.status} calls=${result.calls}`
    }
    const raw = JSON.stringify(result.envelopes[0]?.body || {})
    if (!raw.includes('input_image')) return `G3 expected Anthropic image preserved as input_image on OpenAI API`
    return null
  }
  if (imp === 'G4') {
    if (result.status !== 200 || result.calls !== 1) {
      return `G4 expected 200 & calls=1, got status=${result.status} calls=${result.calls}`
    }
    const raw = JSON.stringify(result.client_response)
    if (!raw.includes('"object":"text_completion"')) {
      return `G4 expected text_completion SSE chunks for openai.completions on Codex`
    }
    return null
  }
  if (imp === 'strip_claudeseal') {
    if (result.status !== 200 || result.calls !== 1) {
      return `strip_claudeseal expected 200 & calls=1, got status=${result.status} calls=${result.calls}`
    }
    const raw = JSON.stringify(result.envelopes[0]?.body || {})
    if (raw.includes('magpie-claude1:')) return `strip_claudeseal leaked magpie-claude1 encrypted_content to Codex`
    return null
  }
  if (imp === 'fail_closed_schema') {
    if (result.status !== 400 || result.calls !== 0) {
      return `fail_closed_schema expected status=400 & calls=0, got status=${result.status} calls=${result.calls}`
    }
    return null
  }
  if (imp === 'strict_codex_passthrough') {
    if (result.status !== 200 || result.calls !== 1) {
      return `strict_codex_passthrough expected 200 & calls=1, got status=${result.status} calls=${result.calls}`
    }
    const outBody = result.envelopes[0]?.body || {}
    const raw = JSON.stringify(outBody)
    if (raw.includes('base_url') || raw.includes('sk-leak') || raw.includes('third-party.local')) {
      return `strict_codex_passthrough leaked caller identity field to Codex`
    }
    if (outBody.store !== false || outBody.input?.[0]?.type !== 'message') {
      return `strict_codex_passthrough expected IR-normalized body (store=false, input[0].type=message)`
    }
    return null
  }
  if (imp === 'strict_official_cc_passthrough') {
    if (result.status !== 200 || result.calls !== 1) {
      return `strict_official_cc_passthrough expected 200 & calls=1, got status=${result.status} calls=${result.calls}`
    }
    if (result.envelopes[0]?.preserve_cache_breakpoints !== false) {
      return `strict_official_cc_passthrough expected preserve_cache_breakpoints=false (spoofed client must not passthrough)`
    }
    return null
  }
  return null
}

function summarizeTimings(results) {
  const sorted = results.map((r) => r.elapsed_ms).sort((a, b) => a - b)
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  return {
    count: sorted.length,
    total_ms: Number(sorted.reduce((a, b) => a + b, 0).toFixed(2)),
    p50_ms: pick(0.5),
    p95_ms: pick(0.95),
    p99_ms: pick(0.99),
  }
}

async function runBench(corpus, env) {
  const shortCase = corpus.find((c) => c.id === 'crag-messages-basic-json')
  const fourProtoCases = [
    corpus.find((c) => c.id === 'crag-messages-basic-json'),
    corpus.find((c) => c.id === 'crag-chat-basic-json'),
    corpus.find((c) => c.id === 'crag-responses-basic-json'),
    corpus.find((c) => c.id === 'crag-completions-basic-json'),
  ].filter(Boolean)
  const longCase = structuredClone(shortCase)
  longCase.id = 'bench-long-history'
  longCase.request.body.messages = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `History turn ${i}: ${'payload-segment-'.repeat(60)}`,
  }))
  longCase.request.body.messages.push({ role: 'user', content: 'final summary' })
  const multiCase = corpus.find((c) => c.id === 'crag-messages-multiturn-3step')

  // Warmup
  await runCase(shortCase, env)

  const measure = async (label, fn) => {
    const t0 = performance.now()
    const out = await fn()
    const ms = Number((performance.now() - t0).toFixed(2))
    return { label, elapsed_ms: ms, ...out }
  }

  const dims = []
  dims.push(
    await measure('short_x20', async () => {
      const times = []
      for (let i = 0; i < 20; i++) times.push((await runCase(shortCase, env)).elapsed_ms)
      return { avg_ms: Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(3)) }
    }),
  )
  dims.push(
    await measure('long_history_41turns_x10', async () => {
      const times = []
      for (let i = 0; i < 10; i++) times.push((await runCase(longCase, env)).elapsed_ms)
      return { avg_ms: Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(3)) }
    }),
  )
  dims.push(
    await measure('multi_turn_x10', async () => {
      const times = []
      for (let i = 0; i < 10; i++) times.push((await runCase(multiCase, env)).elapsed_ms)
      return { avg_ms: Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(3)) }
    }),
  )
  dims.push(
    await measure('four_protocols_x5', async () => {
      const times = []
      for (let i = 0; i < 5; i++) {
        for (const c of fourProtoCases) times.push((await runCase(c, env)).elapsed_ms)
      }
      return { avg_ms: Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(3)) }
    }),
  )
  dims.push(
    await measure('concurrency_32', async () => {
      const res = await Promise.all(Array.from({ length: 32 }, () => runCase(shortCase, env)))
      return {
        ok: res.filter((r) => r.status === 200).length,
        p95_ms: summarizeTimings(res).p95_ms,
      }
    }),
  )
  console.log(JSON.stringify({ engine: process.env.KIN_PROTO_FRONT || 'node', dimensions: dims }, null, 2))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const corpusPath = args.corpus || DEFAULT_CORPUS
  const raw = JSON.parse(fs.readFileSync(corpusPath, 'utf8'))
  const allCases = Array.isArray(raw) ? raw : raw.cases
  const selected = args.ids.length ? allCases.filter((c) => args.ids.includes(c.id)) : allCases

  const env = await setupIsolatedEnv()
  try {
    if (args.bench) {
      await runBench(selected, env)
      return
    }
    const results = []
    for (const tc of selected) {
      const r = await runCase(tc, env)
      results.push({
        id: tc.id,
        source: tc.source,
        inbound_protocol: tc.inbound_protocol,
        target_family: tc.target_family,
        expected_improvement: tc.expected_improvement || null,
        ...r,
      })
    }
    const snapshot = {
      version: 1,
      engine: process.env.KIN_PROTO_FRONT || 'node',
      recorded_at: new Date().toISOString(),
      case_count: results.length,
      timings: summarizeTimings(results),
      results,
    }
    const canonicalForHash = JSON.stringify(results.map(({ elapsed_ms: _e, ...rest }) => rest))
    snapshot.sha256 = crypto.createHash('sha256').update(canonicalForHash).digest('hex')

    if (args.record) {
      fs.mkdirSync(path.dirname(args.record), { recursive: true })
      fs.writeFileSync(args.record, JSON.stringify(snapshot, null, 2) + '\n')
      const ok200 = results.filter((r) => r.status === 200).length
      const err4xx = results.filter((r) => r.status >= 400 && r.status < 500).length
      const err5xx = results.filter((r) => r.status >= 500).length
      console.log(
        `Recorded ${results.length} baseline cases (engine=${snapshot.engine}, 200=${ok200}, 4xx=${err4xx}, 5xx=${err5xx}, sha256=${snapshot.sha256.slice(0, 12)}) -> ${args.record}`,
      )
      console.log('Timings:', JSON.stringify(snapshot.timings))
      return
    }

    if (args.save_candidate) {
      fs.mkdirSync(path.dirname(args.save_candidate), { recursive: true })
      fs.writeFileSync(args.save_candidate, JSON.stringify(snapshot, null, 2) + '\n')
    }

    if (args.verify) {
      const golden = JSON.parse(fs.readFileSync(args.verify, 'utf8'))
      const goldenById = new Map(golden.results.map((r) => [r.id, r]))
      let parityPass = 0
      let parityFail = 0
      let impPass = 0
      let impFail = 0
      const failures = []

      for (const cur of results) {
        const tc = selected.find((c) => c.id === cur.id)
        const base = goldenById.get(cur.id)
        if (!base) {
          failures.push(`${cur.id}: missing from golden baseline`)
          parityFail++
          continue
        }
        if (tc.expected_improvement && args.strict_improvements) {
          const msg = assertImprovementContract(tc, cur)
          if (msg) {
            failures.push(`${cur.id} [${tc.expected_improvement}]: ${msg}`)
            impFail++
          } else {
            impPass++
          }
          continue
        }
        const stripTiming = ({ elapsed_ms: _e, ...rest }) => rest
        const a = JSON.stringify(stripTiming(base))
        const b = JSON.stringify(stripTiming(cur))
        if (a !== b) {
          if (tc.expected_improvement) {
            const msg = assertImprovementContract(tc, cur)
            if (!msg) {
              impPass++
              continue
            }
            failures.push(`${cur.id} [${tc.expected_improvement}]: ${msg}`)
            impFail++
          } else {
            failures.push(
              `${cur.id}: parity diff (status ${base.status}->${cur.status}, calls ${base.calls}->${cur.calls})`,
            )
            parityFail++
          }
        } else {
          parityPass++
        }
      }

      console.log(
        `Verify engine=${snapshot.engine} vs golden=${golden.engine}: parity=${parityPass} pass / ${parityFail} fail; improvements=${impPass} pass / ${impFail} fail`,
      )
      console.log('Timings (golden vs current):', JSON.stringify({ golden: golden.timings, current: snapshot.timings }))
      if (failures.length) {
        for (const f of failures.slice(0, 30)) console.error('FAIL:', f)
        process.exitCode = 1
      }
      return
    }

    console.log(`Ran ${results.length} cases (use --record <file>, --verify <file>, or --bench)`)
  } finally {
    await env.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
