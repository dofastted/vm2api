import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifierFixture } from '../fixtures/auto-mode.mjs'
import { runApiInference } from '../../src/lib/pool/api-protocol.mjs'
import {
  createClaudeMessageAssembler,
  applyClaudeSSELineToMessage,
  toClaudeMessages,
} from '../../src/lib/protocol/convert.mjs'

test('API classifier backend preserves contract, rejects model substitution and exposes real failures', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-mode-api-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  fs.mkdirSync(path.join(temp, 'run'))
  fs.writeFileSync(path.join(temp, 'run', 'api-kernel.token'), 'fixture-token')
  let scenario = 'ok'
  let calls = 0
  let wire
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    calls++
    wire = JSON.parse(JSON.parse(raw).body)
    if (scenario === 'http') {
      res.writeHead(400, { 'content-type': 'application/json', 'request-id': 'req_api_classifier' })
      return res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', code: 'bad_classifier', message: 'fixture classifier rejected' },
        }),
      )
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_classifier_api',
          role: 'assistant',
          type: 'message',
          content: [],
          usage: { input_tokens: 1 },
          model: wire.model,
        },
      },
      ...(scenario === 'sse'
        ? [
            {
              type: 'error',
              error: {
                type: 'api_error',
                code: 'classifier_busy',
                status: 503,
                message: 'fixture busy',
                retry_after: '13',
                request_id: 'req_api_classifier',
              },
            },
          ]
        : scenario === 'incomplete'
          ? []
          : [
              {
                type: 'message_delta',
                delta: { stop_reason: 'max_tokens', stop_sequence: null },
                usage: { output_tokens: 1 },
              },
              { type: 'message_stop' },
            ]),
    ]
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise((resolve) => server.listen(path.join(temp, 'run', 'api-kernel.sock'), resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  let selectedModel = 'claude-sonnet-4-6'
  const input = classifierFixture()
  const run = () =>
    runApiInference({
      cfg: { paths: { data: temp } },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'fixture', kind: 'claude', protocol: 'anthropic', base_url: 'https://fixture.invalid' },
          upstream_model: selectedModel,
          key: { id: 'fixture', api_key: 'fixture-key' },
        }),
      },
      store: {},
      inbound: input,
      convertedBody: input,
      clientStream: false,
      protocol: 'anthropic.messages',
      requestContext: { purpose: 'auto_mode_classifier', format: 'xml' },
      converters: { createClaudeMessageAssembler, applyClaudeSSELineToMessage },
      timeoutMs: 3000,
    })
  const ok = await run()
  assert.equal(ok.ok, true)
  assert.equal(ok.body.stop_reason, 'max_tokens')
  assert.equal(wire.max_tokens, 64)
  assert.deepEqual(wire.thinking, { type: 'disabled' })
  // 226f82b3: the 2.1.310 classifier body carries its own temperature; the gateway forwards it unchanged.
  assert.equal(wire.temperature, input.temperature)
  assert.deepEqual(wire.system, input.system)
  for (const [kind, status, code] of [
    ['http', 400, 'bad_classifier'],
    ['sse', 503, 'classifier_busy'],
    ['incomplete', 502, 'upstream_stream_interrupted'],
  ]) {
    scenario = kind
    const result = await run()
    assert.equal(result.ok, false)
    assert.equal(result.status, status)
    assert.equal(result.body.error.code, code)
    if (kind === 'sse') assert.equal(result.headers['retry-after'], '13')
  }
  selectedModel = 'claude-opus-5-5'
  const count = calls
  const incompatible = await run()
  assert.equal(incompatible.status, 400)
  assert.equal(incompatible.body.error.code, 'classifier_model_incompatible')
  assert.equal(calls, count)
})

test('native Anthropic API backend forwards safeguards and caller protocol headers', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'safeguards-api-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  fs.mkdirSync(path.join(temp, 'run'))
  fs.writeFileSync(path.join(temp, 'run', 'api-kernel.token'), 'fixture-token')

  const safeguardResults = [
    {
      type: 'dangerous_tool_use',
      status: { type: 'available', tool_uses: { toolu_1: { status: 'evaluated', outcome: 'not_flagged' } } },
    },
  ]
  let envelope
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    envelope = JSON.parse(raw)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_safeguard_api',
          role: 'assistant',
          type: 'message',
          content: [],
          model: 'claude-sonnet-5',
          safeguard_results: safeguardResults,
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', safeguard_results: safeguardResults },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise((resolve) => server.listen(path.join(temp, 'run', 'api-kernel.sock'), resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const body = {
    model: 'claude-sonnet-5',
    max_tokens: 64,
    safeguards: [{ type: 'dangerous_tool_use', classifier_context: { permission_mode: 'auto' } }],
    messages: [{ role: 'user', content: 'hi' }],
  }
  const converted = toClaudeMessages('anthropic.messages', body, { rewrite: false }).claude
  assert.deepEqual(converted.safeguards, body.safeguards)
  const req = {
    headers: {
      'anthropic-beta': 'interleaved-thinking-2025-05-14,dangerous-tool-use-2026-09-03,future-beta',
      'anthropic-version': '2023-06-01',
      'user-agent': 'claude-cli/2.1.278 (external, sdk-cli)',
    },
  }
  const common = {
    req,
    cfg: { paths: { data: temp } },
    scheduler: {
      pick: () => ({
        ok: true,
        endpoint: {
          id: 'fixture',
          kind: 'claude',
          protocol: 'anthropic',
          base_url: 'https://fixture.invalid',
          headers: { 'Anthropic-Beta': 'endpoint-default' },
        },
        upstream_model: body.model,
        key: { id: 'fixture', api_key: 'fixture-key' },
      }),
    },
    store: {},
    protocol: 'anthropic.messages',
    inbound: body,
    convertedBody: converted,
    converters: { createClaudeMessageAssembler, applyClaudeSSELineToMessage },
    timeoutMs: 3000,
  }

  const jsonResult = await runApiInference({ ...common, clientStream: false })
  assert.equal(jsonResult.ok, true)
  assert.deepEqual(envelope.body && JSON.parse(envelope.body).safeguards, body.safeguards)
  assert.equal(envelope.headers['anthropic-beta'], `endpoint-default,${req.headers['anthropic-beta']}`)
  assert.equal(envelope.headers['anthropic-version'], req.headers['anthropic-version'])
  assert.deepEqual(jsonResult.body.safeguard_results, safeguardResults)

  const chunks = []
  const streamResult = await runApiInference({
    ...common,
    clientStream: true,
    res: { headersSent: false, write: (chunk) => chunks.push(String(chunk)), end() {} },
    converters: {
      ...common.converters,
      writeSSEHeaders: (res) => {
        res.headersSent = true
      },
    },
  })
  assert.equal(streamResult.ok, true)
  assert.deepEqual(envelope.body && JSON.parse(envelope.body).safeguards, body.safeguards)
  assert.equal(envelope.headers['anthropic-beta'], `endpoint-default,${req.headers['anthropic-beta']}`)
  assert.ok(chunks.some((chunk) => chunk.includes('safeguard_results')))
})

test('native Anthropic API backend keeps endpoint headers and applies the 1M policy to caller betas', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-headers-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  fs.mkdirSync(path.join(temp, 'run'))
  fs.writeFileSync(path.join(temp, 'run', 'api-kernel.token'), 'fixture-token')
  let envelope
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    envelope = JSON.parse(raw)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [
      { type: 'message_start', message: { id: 'msg_h', role: 'assistant', type: 'message', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise((resolve) => server.listen(path.join(temp, 'run', 'api-kernel.sock'), resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const run = (model, endpointHeaders) => {
    const body = { model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }
    return runApiInference({
      req: {
        headers: {
          'anthropic-beta': 'oauth-2025-04-20,context-1m-2025-08-07,future-beta',
          'user-agent': 'claude-cli/2.1.278 (external, sdk-cli)',
          'x-app': 'cli',
        },
      },
      cfg: { paths: { data: temp } },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: {
            id: 'fixture',
            kind: 'custom',
            protocol: 'anthropic',
            auth_scheme: 'bearer',
            base_url: 'https://fixture.invalid',
            headers: endpointHeaders,
          },
          upstream_model: model,
          key: { id: 'fixture', api_key: 'fixture-key' },
        }),
      },
      store: {},
      protocol: 'anthropic.messages',
      inbound: body,
      convertedBody: toClaudeMessages('anthropic.messages', body, { rewrite: false }).claude,
      converters: { createClaudeMessageAssembler, applyClaudeSSELineToMessage },
      clientStream: false,
      timeoutMs: 3000,
    })
  }

  // claude-opus-4-7 does not pass context-1m by default; the endpoint's own opt-in still goes through.
  assert.equal(
    (await run('claude-opus-4-7', { 'User-Agent': 'relay-ua', 'anthropic-beta': 'oauth-2025-04-20' })).ok,
    true,
  )
  assert.equal(envelope.headers['anthropic-beta'], 'oauth-2025-04-20,future-beta')
  assert.equal(envelope.headers['User-Agent'], 'relay-ua')
  assert.equal(envelope.headers['user-agent'], undefined)
  assert.equal(envelope.headers['x-app'], 'cli')
  assert.equal(envelope.headers.authorization, 'Bearer fixture-key')

  assert.equal((await run('claude-opus-4-7', { 'anthropic-beta': 'context-1m-2025-08-07' })).ok, true)
  assert.equal(envelope.headers['anthropic-beta'], 'context-1m-2025-08-07,oauth-2025-04-20,future-beta')

  // claude-sonnet-5 passes context-1m under the default model policy.
  assert.equal((await run('claude-sonnet-5', {})).ok, true)
  assert.equal(envelope.headers['anthropic-beta'], 'oauth-2025-04-20,context-1m-2025-08-07,future-beta')
  assert.equal(envelope.headers['user-agent'], 'claude-cli/2.1.278 (external, sdk-cli)')
})
