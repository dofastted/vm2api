import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'

async function fixture(t, { clientStream = false, incomplete = false, rejectStart = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-protocol-observer-'))
  fs.mkdirSync(path.join(root, 'run'))
  const events = []
  let submitted = 0
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume the internal envelope */
    }
    submitted++
    events.push('submitted')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const data = [
      {
        type: 'message_start',
        message: { id: 'synthetic', type: 'message', role: 'assistant', content: [], usage: {} },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      ...(!incomplete ? [{ type: 'message_stop' }] : []),
    ]
    res.end(data.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path.join(root, 'run/api-kernel.sock'), resolve)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const key = { id: 'synthetic-key', category: 'api', group_id: 1 }
  const startError = new Error('request activity was closed')
  const states = []
  const handler = createHandleProtocol({
    cfg: {
      limits: { max_body_bytes: 1 << 20, upstream_timeout_ms: 1000 },
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      paths: { project: root, data: root },
    },
    json(res, status, body) {
      res.statusCode = status
      res.body = body
    },
    writeSSEHeaders(res) {
      res.headersSent = true
    },
    readBody,
    requireAuth(req) {
      req.apiKeyRecord = key
      req.apiKeyKind = 'managed'
      return true
    },
    requestLog: { start: () => ({ request_id: 'synthetic-log-id', t0: Date.now() }) },
    stats: { errors: 0, requests: 0, by_route: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    apiKeyStore: {
      reserve: async () => ({ ok: true, shared: true, release: async () => events.push('release') }),
      recordUsage: async () => events.push('settled'),
    },
    stickyRouter: { resolve: () => null },
    accountQuota: { ingestHeaders() {} },
    routingConfig: { compatibility: { claude_code_only: false } },
    apiEndpointStore: { listRaw: async () => [], setKeyCooldown: async () => {} },
    apiScheduler: {
      reload() {},
      pick: () => ({
        ok: true,
        endpoint: {
          id: 'synthetic-endpoint',
          kind: 'claude',
          protocol: 'anthropic',
          base_url: 'https://synthetic.invalid',
        },
        key: { id: 'synthetic-upstream-key', api_key: 'synthetic' },
        upstream_model: 'claude-sonnet-4-6',
      }),
    },
    async onExecutionState(req, execution) {
      assert.equal(req, request)
      states.push(execution)
      events.push(execution.ended ? 'ended' : 'started')
      if (rejectStart && states.length === 1) throw startError
    },
  })
  const request = Readable.from([
    Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 20,
        stream: clientStream,
        messages: [{ role: 'user', content: 'synthetic' }],
      }),
    ),
  ])
  request.headers = { 'user-agent': 'claude-cli/2.1.0 (external, cli)', 'anthropic-version': '2023-06-01' }
  const response = new EventEmitter()
  response.setHeader = () => {}
  response.write = () => {}
  response.end = () => {
    response.writableEnded = true
  }
  return {
    events,
    states,
    startError,
    submitted: () => submitted,
    run: () => handler.handleProtocol(request, response, 'anthropic.messages', '/v1/messages'),
  }
}

for (const clientStream of [false, true]) {
  test(`the protocol bridge awaits API execution observers (clientStream=${clientStream})`, async (t) => {
    const fx = await fixture(t, { clientStream })
    await fx.run()
    assert.equal(fx.states.length, 2)
    assert.equal(fx.states[0].started, true)
    assert.equal(fx.states[0].ended, false)
    assert.equal(fx.states[1].ended, true)
    assert.equal(fx.states[0].requestId, fx.states[1].requestId)
    assert.ok(fx.events.indexOf('started') < fx.events.indexOf('submitted'))
    assert.ok(fx.events.indexOf('ended') < fx.events.indexOf('release'))
  })
}

test('the protocol bridge cannot submit API work after its activity rejects start', async (t) => {
  const fx = await fixture(t, { rejectStart: true })
  await assert.rejects(fx.run(), (error) => error === fx.startError)
  assert.equal(fx.submitted(), 0)
})

test('an incomplete API execution keeps managed key occupancy after the HTTP handler returns', async (t) => {
  const fx = await fixture(t, { incomplete: true })
  await fx.run()
  assert.equal(fx.states.length, 2)
  assert.equal(fx.states[1].ended, false)
  assert.equal(fx.events.includes('release'), false)
})
