import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifierFixture } from '../fixtures/auto-mode.mjs'
import { runApiInference } from '../../src/lib/pool/api-protocol.mjs'
import { createClaudeMessageAssembler, applyClaudeSSELineToMessage } from '../../src/lib/protocol/convert.mjs'

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
        reload() {},
        pick: () => ({
          ok: true,
          endpoint: { id: 'fixture', kind: 'claude', protocol: 'anthropic', base_url: 'https://fixture.invalid' },
          upstream_model: selectedModel,
          key: { id: 'fixture', api_key: 'fixture-key' },
        }),
      },
      store: { listRaw: async () => [] },
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
  assert.equal(wire.temperature, 0)
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
