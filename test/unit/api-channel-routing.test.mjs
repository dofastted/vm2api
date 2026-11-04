import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'

for (const [protocol, model, upstreamProtocol, modelOverride] of [
  ['anthropic.messages', 'relay/sonnet', 'anthropic'],
  ['openai.chat', 'gpt-5.4', 'openai'],
  ['openai.responses', 'gpt-5.4', 'openai'],
  ['anthropic.messages', 'gpt-5.4', 'openai'],
  ['openai.responses', 'request-model', 'openai', true],
]) {
  test(`API key routes ${protocol} ${model} through its endpoint without OAuth slots`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-channel-'))
    fs.mkdirSync(path.join(root, 'run'))
    const routingFile = path.join(root, 'routing.json')
    fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { persona_preset: 'official_full' } }))
    const captured = []
    const kernel = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      captured.push(JSON.parse(Buffer.concat(chunks)))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const events =
        upstreamProtocol === 'openai'
          ? [
              {
                type: 'response.completed',
                response: {
                  id: 'resp_test',
                  object: 'response',
                  status: 'completed',
                  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }],
                  usage: { input_tokens: 2, output_tokens: 1 },
                },
              },
            ]
          : [
              {
                type: 'message_start',
                message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], model },
              },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'pong' } },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
              { type: 'message_stop' },
            ]
      res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
    })
    await new Promise((resolve) => kernel.listen(path.join(root, 'run/api-kernel.sock'), resolve))
    const scheduler = new ApiScheduler()
    scheduler.reload([
      {
        id: 'ep',
        kind: 'custom',
        protocol: upstreamProtocol,
        base_url: 'https://relay.invalid',
        models: [{ name: 'upstream-model', alias: modelOverride ? 'routed-model' : model }],
        api_key_entries: [{ id: 'ek', api_key: 'sk-upstream', proxy_url: 'socks5://proxy.invalid:1080' }],
      },
    ])
    const response = { headersSent: false, on() {}, once() {}, off() {}, end() {}, write() {} }
    const body =
      protocol === 'openai.responses'
        ? { model, input: 'hello', max_output_tokens: 32, stream: false, reasoning: { effort: 'low' } }
        : {
            model,
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 32,
            stream: false,
            ...(protocol === 'openai.chat'
              ? { reasoning_effort: 'low', temperature: 0.2, parallel_tool_calls: false }
              : {}),
          }
    let acquired = 0
    let released = 0
    const handler = createHandleProtocol({
      json: (_res, status, body) => {
        response.status = status
        response.body = body
      },
      writeSSEHeaders() {},
      readBody: async () => body,
      requireAuth: () => true,
      cfg: {
        rewrite: { enabled: false },
        intercept: {
          rules: modelOverride
            ? [{ phase: 'before_upstream', action: { set_body_field: { model: 'routed-model' } } }]
            : [],
        },
        distill: { enabled: false },
        limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
        paths: { data: root, project: root },
      },
      requestLog: { start: () => ({ request_id: 'api-channel', t0: Date.now() }), finish() {} },
      stickyRouter: {},
      accountQuota: {},
      apiKeyStore: {
        acquire: () => {
          acquired++
          return { ok: true }
        },
        release: () => {
          released++
        },
      },
      apiScheduler: scheduler,
      apiEndpointStore: {},
      stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
      routingConfigPath: routingFile,
      routingConfig: { failover: {} },
      groupsRepo: { rateMultiplier: () => 1 },
      codexOps: {
        list: () => {
          throw new Error('API keys must not use OAuth slots')
        },
      },
    })
    const req = {
      method: 'POST',
      url: '/v1/messages',
      headers: { 'user-agent': 'api-test' },
      apiKeyKind: 'managed',
      apiKeyRecord: { category: 'api' },
      once() {},
      off() {},
    }
    try {
      await handler.handleProtocol(req, response, protocol, req.url)
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(captured.length, 1)
      assert.equal(captured[0].proxy_url, 'socks5://proxy.invalid:1080')
      assert.equal(
        captured[0].url,
        `https://relay.invalid/v1/${upstreamProtocol === 'openai' ? 'responses' : 'messages?beta=true'}`,
      )
      const outbound = JSON.parse(captured[0].body)
      assert.equal(outbound.model, 'upstream-model')
      assert.equal(acquired, 1)
      assert.equal(released, 1)
      if (upstreamProtocol === 'openai') {
        assert.equal(captured[0].headers.authorization, 'Bearer sk-upstream')
        assert.doesNotMatch(JSON.stringify(outbound), /Claude Code|Environment|billing-header/)
        if (protocol === 'openai.responses') {
          assert.equal(outbound.input, 'hello')
          assert.deepEqual(outbound.reasoning, { effort: 'low' })
          assert.equal(response.body.output[0].content[0].text, 'pong')
        } else if (protocol === 'openai.chat') {
          assert.equal(response.body.choices[0].message.content, 'pong')
          assert.deepEqual(outbound.reasoning, { effort: 'low' })
          assert.equal(outbound.reasoning_effort, undefined)
          assert.equal(outbound.temperature, 0.2)
          assert.equal(outbound.parallel_tool_calls, false)
        } else assert.equal(response.body.content[0].text, 'pong')
      }
    } finally {
      await new Promise((resolve) => kernel.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}
