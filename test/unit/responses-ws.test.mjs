import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import {
  createResponsesWsHandler,
  createSseJsonBridge,
  decodeResponseInterrupt,
  interruptTargetResponseId,
  isProtocolWarmup,
  responseInterruptAcceptedFrame,
} from '../../src/lib/protocol/responses-ws.mjs'

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function listen({ routing, requireAuth, handleProtocol, maxBodyBytes }) {
  const httpHits = []
  const handler = createResponsesWsHandler({
    handleProtocol,
    requireAuth,
    json,
    getRouting: () => routing,
    maxBodyBytes,
  })
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && (req.url === '/v1/responses' || req.url === '/responses')) {
      httpHits.push(req.url)
      json(res, 200, { ok: true, transport: 'http' })
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    if (!handler.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    handler,
    server,
    port,
    httpHits,
    url: `ws://127.0.0.1:${port}/v1/responses`,
    httpUrl: `http://127.0.0.1:${port}/v1/responses`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function openWs(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    ws.once('open', () => done({ ok: true, ws }))
    ws.once('unexpected-response', (_req, res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        let body = null
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch {
          body = {}
        }
        done({ ok: false, status: res.statusCode, body, ws: null })
      })
    })
    ws.once('error', (error) => {
      setTimeout(() => {
        if (!settled) done({ ok: false, error, ws: null })
      }, 20)
    })
  })
}

function nextFrame(ws, predicate = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('frame timeout')), timeoutMs)
    const onMessage = (data) => {
      const frame = JSON.parse(String(data))
      if (!predicate(frame)) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(frame)
    }
    ws.on('message', onMessage)
  })
}

function allowAuth(req) {
  req.apiKeyKind = 'managed'
  req.apiKeyRecord = { id: 'key-1' }
  req.presentedApiKey = 'sk-test'
  return true
}

function allowManagedOpenai(req) {
  req.apiKeyKind = 'managed'
  req.apiKeyRecord = { id: 'key-1', group_id: 1, group_type: 'all' }
  req.presentedApiKey = 'sk-test'
  return true
}

function denyAuth(_req, res) {
  json(res, 401, {
    error: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid credentials' },
  })
  return false
}

const ENABLED = {
  websocket: { enabled: true },
  codex: { websocket: { enabled: true }, upstream_transport: 'prefer_websocket' },
}

function writeGptVm(root, id) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(path.join(dir, id), { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      platform: 'openai',
      family: 'codex',
      schedulable: true,
      status: 'running',
      has_token: true,
    }),
  )
  fs.writeFileSync(
    path.join(dir, id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ id: `${id}-acc`, access_token: 'at', refresh_token: 'rt', chatgpt_account_id: id }],
    }),
  )
}

function writeSSEHeaders(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
}

async function listenWithHandleProtocol(
  root,
  {
    codexOps,
    requestLog,
    apiKeyStore,
    routing = {
      websocket: { enabled: true },
      pool: { fallback_wait_timeout_ms: 3000 },
      codex: {
        websocket: { enabled: true },
        upstream_transport: 'prefer_websocket',
        clients: { openai_compatible: 'allow', official_codex: 'allow', unknown: 'allow' },
        protocols: { 'openai.responses': { enabled: true, mode: 'native' } },
      },
    },
    requireAuth = allowManagedOpenai,
  },
) {
  const routingFile = path.join(root, 'routing.json')
  const codexRouting = {
    websocket: { enabled: true },
    upstream_transport: 'prefer_websocket',
    clients: { openai_compatible: 'allow', official_codex: 'allow', unknown: 'allow' },
    protocols: { 'openai.responses': { enabled: true, mode: 'native' } },
  }
  fs.writeFileSync(
    routingFile,
    JSON.stringify({
      websocket: { enabled: true },
      pool: { fallback_wait_timeout_ms: 3000 },
      codex: codexRouting,
    }),
  )
  const stats = { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 }
  const { handleProtocol } = createHandleProtocol({
    json,
    writeSSEHeaders,
    readBody: readJson,
    requireAuth,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: {
        max_body_bytes: 1024 * 1024,
        upstream_timeout_ms: 30_000,
        stream_idle_timeout_ms: 30_000,
      },
      paths: { data: root, project: root },
    },
    requestLog,
    stickyRouter: {
      extractPoolKey: () => 'ws-real',
      collectPoolKeys: () => ['ws-real'],
      resolve: () => null,
    },
    accountQuota: { sessions: null, ingestHeaders: () => {} },
    apiKeyStore,
    apiScheduler: {},
    apiEndpointStore: {},
    stats,
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    codexOps: {
      writeCodexKernelConfig: () => {},
      ensureCodexKernel: async () => ({ ok: true }),
      ...codexOps,
    },
  })
  return listen({ routing, requireAuth, handleProtocol })
}

beforeEach(() => resetOpenAIAccountRuntime())

test('a terminal SSE event without a final newline reaches the WebSocket client', async () => {
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(_req, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"type":"response.completed","response":{"id":"resp_last","status":"completed","output":[]}}')
    },
  })
  const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
  try {
    const completed = nextFrame(opened.ws, (frame) => frame.type === 'response.completed')
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'hi' }))
    assert.equal((await completed).response.id, 'resp_last')
  } finally {
    opened.ws.close()
    await live.close()
  }
})

test('a frame above the request ceiling closes before protocol execution', async () => {
  let hops = 0
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    maxBodyBytes: 256,
    async handleProtocol() {
      hops++
    },
  })
  const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
  try {
    const closed = once(opened.ws, 'close')
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'x'.repeat(512) }))
    assert.equal((await closed)[0], 1009)
    assert.equal(hops, 0)
  } finally {
    opened.ws.terminate()
    await live.close()
  }
})

test('SSE bridge emits JSON frames and never treats [DONE] as completed', () => {
  const bridge = createSseJsonBridge()
  bridge.push('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","output":[]}}\n\n')
  bridge.push('data: [DONE]\n\n')
  bridge.finish()
  assert.equal(bridge.frames.length, 1)
  assert.equal(bridge.terminal, null)
  assert.equal(bridge.snapshot().id, 'resp_1')
})

test('disabled gates reject the handshake with zero upstream hops', async () => {
  const hops = []
  const live = await listen({
    routing: { websocket: { enabled: false }, codex: { websocket: { enabled: true } } },
    requireAuth: allowAuth,
    handleProtocol: async (req) => {
      hops.push(await readJson(req))
    },
  })
  try {
    const ws = await openWs(live.url, { authorization: 'Bearer sk-test' })
    assert.equal(ws.ok, false)
    assert.equal(ws.status, 403)
    assert.equal(ws.body.error.code, 'websocket_disabled')
    assert.equal(hops.length, 0)
    const gptOff = await listen({
      routing: { websocket: { enabled: true }, codex: { websocket: { enabled: false } } },
      requireAuth: allowAuth,
      handleProtocol: async (req) => {
        hops.push(await readJson(req))
      },
    })
    try {
      const second = await openWs(gptOff.url, { authorization: 'Bearer sk-test' })
      assert.equal(second.ok, false)
      assert.equal(second.status, 403)
      assert.equal(hops.length, 0)
      const httpRes = await fetch(gptOff.httpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
        body: JSON.stringify({ model: 'gpt-5.4', input: 'hi' }),
      })
      assert.equal(httpRes.status, 200)
      assert.deepEqual(await httpRes.json(), { ok: true, transport: 'http' })
    } finally {
      await gptOff.close()
    }
  } finally {
    await live.close()
  }
})

test('auth failure rejects the handshake with zero upstream hops', async () => {
  const hops = []
  const live = await listen({
    routing: ENABLED,
    requireAuth: denyAuth,
    handleProtocol: async (req) => {
      hops.push(await readJson(req))
    },
  })
  try {
    const ws = await openWs(live.url, { authorization: 'Bearer nope' })
    assert.equal(ws.ok, false)
    assert.equal(ws.status, 401)
    assert.equal(ws.body.error.code, 'invalid_api_key')
    assert.equal(hops.length, 0)
  } finally {
    await live.close()
  }
})

test('two response.create rounds replay full output including reasoning and tools', async () => {
  const hops = []
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(req, res) {
      const body = await readJson(req)
      hops.push(body)
      const n = hops.length
      const id = `resp_${n}`
      const output = [
        { type: 'reasoning', id: `rs_${n}`, summary: [{ type: 'summary_text', text: 'think' }] },
        {
          type: 'function_call',
          id: `fc_${n}`,
          name: 'lookup',
          arguments: '{"q":"x"}',
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `pong${n}` }],
        },
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id, output: [] } })}\n\n`,
      )
      res.write(
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id, output } })}\n\n`,
      )
      res.end()
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    assert.equal(opened.ok, true)
    const { ws } = opened
    ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'hi' }))
    const first = await nextFrame(ws, (frame) => frame.type === 'response.completed')
    assert.equal(first.response.id, 'resp_1')
    assert.equal(hops.length, 1)
    assert.equal(hops[0].previous_response_id, undefined)
    ws.send(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.4',
        previous_response_id: 'resp_1',
        input: 'again',
      }),
    )
    const second = await nextFrame(ws, (frame) => frame.type === 'response.completed' && frame.response.id === 'resp_2')
    assert.equal(second.response.id, 'resp_2')
    assert.equal(hops.length, 2)
    assert.equal(hops[1].previous_response_id, undefined)
    const types = hops[1].input.map((item) => item.type)
    assert.deepEqual(types, ['message', 'reasoning', 'function_call', 'message', 'message'])
    assert.equal(hops[1].input[0].content, 'hi')
    assert.equal(hops[1].input[1].id, 'rs_1')
    assert.equal(hops[1].input[2].name, 'lookup')
    assert.equal(hops[1].input[4].content, 'again')
    ws.close()
    await once(ws, 'close')
  } finally {
    await live.close()
  }
})

test('unknown previous_response_id is a recovery error with zero hop', async () => {
  const hops = []
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(req) {
      hops.push(await readJson(req))
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    assert.equal(opened.ok, true)
    opened.ws.send(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.4',
        previous_response_id: 'resp_missing',
        input: 'hi',
      }),
    )
    const frame = await nextFrame(opened.ws, (event) => event.type === 'error')
    assert.equal(frame.error.code, 'previous_response_not_found')
    assert.equal(hops.length, 0)
    opened.ws.close()
  } finally {
    await live.close()
  }
})

test('real protocol errors keep type/code and do not fabricate response.completed', async () => {
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(_req, res) {
      json(res, 400, {
        error: { type: 'invalid_request_error', code: 'model_not_found', message: 'no such model' },
      })
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    const frames = []
    opened.ws.on('message', (data) => frames.push(JSON.parse(String(data))))
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'nope', input: 'hi' }))
    const frame = await nextFrame(opened.ws, (event) => event.type === 'error')
    assert.equal(frame.status, 400)
    assert.equal(frame.error.type, 'invalid_request_error')
    assert.equal(frame.error.code, 'model_not_found')
    assert.equal(frame.error.message, 'no such model')
    assert.equal(
      frames.some((event) => event.type === 'response.completed'),
      false,
    )
    opened.ws.close()
  } finally {
    await live.close()
  }
})

test('client disconnect aborts the in-flight handleProtocol request', async () => {
  let hops = 0
  let aborted = false
  let started
  const startedP = new Promise((resolve) => {
    started = resolve
  })
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(req, res) {
      hops += 1
      started()
      await new Promise((resolve) => req.once('aborted', resolve))
      aborted = true
      if (!res.writableEnded) {
        json(res, 499, {
          error: { type: 'timeout_error', code: 'client_cancelled', message: 'client disconnected' },
        })
      }
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'hang' }))
    await startedP
    opened.ws.close()
    await once(opened.ws, 'close')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(hops, 1)
    assert.equal(aborted, true)
  } finally {
    await live.close()
  }
})

test('generate=false warmup is rejected when upstream is HTTP-only', async () => {
  const hops = []
  const live = await listen({
    routing: {
      websocket: { enabled: true },
      codex: { websocket: { enabled: true }, upstream_transport: 'http' },
    },
    requireAuth: allowAuth,
    async handleProtocol(req) {
      hops.push(await readJson(req))
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    opened.ws.send(
      JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'warmup', generate: false, store: false }),
    )
    const frame = await nextFrame(opened.ws, (event) => event.type === 'error')
    assert.equal(frame.error.code, 'unsupported_prewarm')
    assert.equal(hops.length, 0)
    assert.equal(isProtocolWarmup({ generate: false, store: false }), true)
    opened.ws.close()
  } finally {
    await live.close()
  }
})

test('unknown control events are protocol errors, not a fake completed', async () => {
  const hops = []
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(req) {
      hops.push(await readJson(req))
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    opened.ws.send(JSON.stringify({ type: 'response.steer', previous_response_id: 'resp_x', input: 'stop' }))
    const frame = await nextFrame(opened.ws, (event) => event.type === 'error')
    assert.equal(frame.error.code, 'invalid_value')
    assert.equal(hops.length, 0)
    opened.ws.close()
  } finally {
    await live.close()
  }
})

test('response.interrupt aborts the in-flight hop and returns accepted', async () => {
  let hops = 0
  let aborted = false
  let started
  const startedP = new Promise((resolve) => {
    started = resolve
  })
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(req, res) {
      hops += 1
      started()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        'data: {"type":"response.created","response":{"id":"resp_live","status":"in_progress","output":[]}}\n\n',
      )
      await new Promise((resolve) => req.once('aborted', resolve))
      aborted = true
      if (!res.writableEnded) res.end()
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'hang' }))
    await startedP
    const accepted = nextFrame(opened.ws, (frame) => frame.type === 'response.interrupt.accepted')
    opened.ws.send(
      JSON.stringify({
        type: 'response.interrupt',
        previous_response_id: 'resp_live',
        mode: 'discard_partial_items',
      }),
    )
    const frame = await accepted
    assert.equal(frame.type, 'response.interrupt.accepted')
    assert.equal(frame.previous_response_id, 'resp_live')
    assert.equal(frame.mode, 'discard_partial_items')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(hops, 1)
    assert.equal(aborted, true)
    opened.ws.close()
  } finally {
    await live.close()
  }
})

test('response.interrupt without an in-flight hop returns accepted and starts zero hops', async () => {
  let hops = 0
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol() {
      hops += 1
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    opened.ws.send(JSON.stringify({ type: 'response.interrupt', response_id: 'resp_idle' }))
    const frame = await nextFrame(opened.ws, (event) => event.type === 'response.interrupt.accepted')
    assert.equal(frame.response_id, 'resp_idle')
    assert.equal(hops, 0)
    opened.ws.close()
  } finally {
    await live.close()
  }
})

test('response.interrupt after response.completed still remembers replay for previous_response_id', async () => {
  const hops = []
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(req, res) {
      const body = await readJson(req)
      hops.push(body)
      const id = hops.length === 1 ? 'resp_done' : 'resp_done_2'
      const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output } })}\n\n`,
      )
      await new Promise((resolve) => setTimeout(resolve, 30))
      if (!res.writableEnded) res.end()
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'first' }))
    await nextFrame(opened.ws, (frame) => frame.type === 'response.completed')
    opened.ws.send(JSON.stringify({ type: 'response.interrupt', previous_response_id: 'resp_done' }))
    await nextFrame(opened.ws, (frame) => frame.type === 'response.interrupt.accepted')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const secondDone = nextFrame(
      opened.ws,
      (frame) => frame.type === 'response.completed' && frame.response?.id === 'resp_done_2',
    )
    opened.ws.send(
      JSON.stringify({
        type: 'response.create',
        model: 'gpt-5.4',
        previous_response_id: 'resp_done',
        input: 'second',
      }),
    )
    await secondDone
    assert.equal(hops.length, 2)
    assert.equal(hops[1].previous_response_id, undefined)
    assert.equal(hops[1].input.at(-1).content, 'second')
    assert.equal(hops[1].input.at(-2).content[0].text, 'done')
    opened.ws.close()
  } finally {
    await live.close()
  }
})

test('response.interrupt with a non-matching response id does not abort the in-flight hop', async () => {
  let aborted = false
  let started
  const startedP = new Promise((resolve) => {
    started = resolve
  })
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(req, res) {
      started()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      req.once('aborted', () => {
        aborted = true
      })
      res.write(
        'data: {"type":"response.created","response":{"id":"resp_live","status":"in_progress","output":[]}}\n\n',
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
      res.write(
        'data: {"type":"response.completed","response":{"id":"resp_live","status":"completed","output":[]}}\n\n',
      )
      res.end()
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'hang' }))
    await startedP
    opened.ws.send(JSON.stringify({ type: 'response.interrupt', previous_response_id: 'resp_other' }))
    await nextFrame(opened.ws, (frame) => frame.type === 'response.interrupt.accepted')
    await nextFrame(opened.ws, (frame) => frame.type === 'response.completed')
    assert.equal(aborted, false)
    opened.ws.close()
  } finally {
    await live.close()
  }
})

test('response.interrupt records a single cancelled terminal for billing, not incomplete_response', async () => {
  const billingEvents = []
  let hops = 0
  let started
  const startedP = new Promise((resolve) => {
    started = resolve
  })
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(req, res) {
      hops += 1
      started()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let finalized = false
      const finalize = (state) => {
        if (finalized) return
        finalized = true
        billingEvents.push(state)
      }
      res.write(
        'data: {"type":"response.created","response":{"id":"resp_bill","status":"in_progress","output":[]}}\n\n',
      )
      await new Promise((resolve) => {
        req.once('aborted', () => {
          finalize('cancelled')
          resolve()
        })
      })
      if (!res.writableEnded) res.end()
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    const frames = []
    opened.ws.on('message', (data) => frames.push(JSON.parse(String(data))))
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'bill' }))
    await startedP
    opened.ws.send(
      JSON.stringify({ type: 'response.interrupt', previous_response_id: 'resp_bill', mode: 'discard_partial_items' }),
    )
    await nextFrame(opened.ws, (frame) => frame.type === 'response.interrupt.accepted')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(hops, 1)
    assert.deepEqual(billingEvents, ['cancelled'])
    assert.equal(
      frames.some((frame) => frame.type === 'error' && frame.error?.code === 'incomplete_response'),
      false,
    )
    opened.ws.close()
  } finally {
    await live.close()
  }
})

test('decodeResponseInterrupt and accepted frame helpers mirror CPR envelope fields', () => {
  const decoded = decodeResponseInterrupt(
    JSON.stringify({
      type: 'response.interrupt',
      previous_response_id: 'resp_1',
      mode: 'discard_partial_items',
    }),
  )
  assert.equal(decoded.ok, true)
  assert.equal(interruptTargetResponseId(decoded.value), 'resp_1')
  assert.deepEqual(responseInterruptAcceptedFrame(decoded.value), {
    type: 'response.interrupt.accepted',
    previous_response_id: 'resp_1',
    mode: 'discard_partial_items',
  })
})

test('real handleProtocol: one in-flight interrupt yields a single cancelled finish without usage billing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-responses-ws-cancel-'))
  writeGptVm(root, 'vm-gpt-a')
  const finishCalls = []
  const usageRecords = []
  const live = await listenWithHandleProtocol(root, {
    requestLog: {
      start: () => ({ request_id: 'ws-cancel', t0: Date.now() }),
      finish(_ctx, bag) {
        finishCalls.push(bag)
      },
    },
    apiKeyStore: {
      recordUsage(_key, usage) {
        usageRecords.push(usage)
      },
      release() {},
    },
    codexOps: {
      streamCodexKernel: async ({ onEvent, signal }) => {
        await onEvent('data: {"type":"response.created","response":{"id":"resp_hp1","output":[]}}\n\n')
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 500)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          })
        })
        if (signal?.aborted) {
          return { ok: false, status: 200, committed: false, body: { error: { code: 'client_cancelled' } } }
        }
        await onEvent(
          'data: {"type":"response.completed","response":{"id":"resp_hp1","status":"completed","output":[]}}\n\n',
        )
        return { ok: true, status: 200, terminalState: 'verified' }
      },
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'bill' }))
    await nextFrame(opened.ws, (frame) => frame.type === 'response.created')
    opened.ws.send(JSON.stringify({ type: 'response.interrupt', previous_response_id: 'resp_hp1' }))
    await nextFrame(opened.ws, (frame) => frame.type === 'response.interrupt.accepted')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(finishCalls.length, 1)
    assert.equal(finishCalls[0].error_code, 'client_cancelled')
    assert.equal(usageRecords.length, 0)
    opened.ws.close()
  } finally {
    await live.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('real handleProtocol: interrupt after hop finish bills once without duplicate finish', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-responses-ws-complete-interrupt-'))
  writeGptVm(root, 'vm-gpt-a')
  const finishCalls = []
  const usageRecords = []
  const usage = { input_tokens: 12, output_tokens: 4, total_tokens: 16 }
  const live = await listenWithHandleProtocol(root, {
    requestLog: {
      start: () => ({ request_id: 'ws-complete-interrupt', t0: Date.now() }),
      finish(_ctx, bag) {
        finishCalls.push(bag)
      },
    },
    apiKeyStore: {
      recordUsage(_key, usageRow) {
        usageRecords.push(usageRow)
      },
      release() {},
    },
    codexOps: {
      streamCodexKernel: async ({ onEvent }) => {
        await onEvent(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_done_hp', status: 'completed', output: [], usage },
          })}\n\n`,
        )
        return { ok: true, status: 200, terminalState: 'verified', usage }
      },
    },
  })
  try {
    const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
    const frames = []
    opened.ws.on('message', (data) => frames.push(JSON.parse(String(data))))
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'first' }))
    const finishDeadline = Date.now() + 5000
    while (finishCalls.length < 1) {
      assert.ok(Date.now() < finishDeadline, 'requestLog.finish timeout')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    opened.ws.send(JSON.stringify({ type: 'response.interrupt', previous_response_id: 'resp_done_hp' }))
    const acceptDeadline = Date.now() + 3000
    while (!frames.some((frame) => frame.type === 'response.interrupt.accepted')) {
      assert.ok(Date.now() < acceptDeadline, 'response.interrupt.accepted timeout')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(finishCalls.length, 1)
    assert.equal(finishCalls[0].final_state, 'verified')
    assert.equal(finishCalls[0].error_code, null)
    assert.equal(finishCalls[0].input_tokens, 12)
    assert.equal(finishCalls[0].output_tokens, 4)
    assert.equal(usageRecords.length, 0)
    opened.ws.close()
  } finally {
    await live.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PUT /api/panel/routing rejects illegal websocket fields before persist', async () => {
  const response = {}
  let persisted = false
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: '/tmp' }, limits: { max_body_bytes: 4096 } },
    routingConfig: {},
    stickyRouter: { stats: () => ({}) },
    persistRoutingPatch() {
      persisted = true
    },
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => ({ websocket: { enabled: 'nope' } }),
  })
  await handlePanel({ method: 'PUT' }, {}, new URL('http://localhost/api/panel/routing'))
  assert.equal(response.status, 400)
  assert.equal(response.body?.error?.code, 'invalid_websocket')
  assert.equal(persisted, false)
})

test('unexpected handler failures do not expose internal exception details', async () => {
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol() {
      throw new Error('/private/slot/credentials.json contains secret-fixture-token')
    },
  })
  const opened = await openWs(live.url, { authorization: 'Bearer sk-test' })
  try {
    const failed = nextFrame(opened.ws, (frame) => frame.type === 'error')
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'hi' }))
    const frame = await failed
    assert.equal(frame.status, 500)
    assert.equal(frame.error.code, 'api_error')
    assert.doesNotMatch(JSON.stringify(frame), /private|credentials|secret-fixture-token/)
  } finally {
    opened.ws.close()
    await live.close()
  }
})

test('draining closes idle Responses sockets and rejects new upgrades', async () => {
  const live = await listen({ routing: ENABLED, requireAuth: allowAuth, handleProtocol: async () => {} })
  const opened = await openWs(live.url)
  try {
    const closed = once(opened.ws, 'close')
    await live.handler.drain()
    assert.equal((await closed)[0], 1001)
    const rejected = await openWs(live.url)
    assert.equal(rejected.status, 503)
    assert.equal(rejected.body.error.code, 'control_plane_draining')
  } finally {
    opened.ws.terminate()
    await live.close()
  }
})

test('draining waits for an active Responses hop and refuses the next request', async () => {
  let started
  let release
  let hops = 0
  const running = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const live = await listen({
    routing: ENABLED,
    requireAuth: allowAuth,
    async handleProtocol(_req, res) {
      hops += 1
      started()
      await gate
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"type":"response.completed","response":{"id":"drained","output":[]}}\n\n')
    },
  })
  const opened = await openWs(live.url)
  try {
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'first' }))
    await running
    let drained = false
    const pending = live.handler.drain().then(() => { drained = true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(drained, false)
    const rejected = nextFrame(opened.ws, (frame) => frame.error?.code === 'control_plane_draining')
    opened.ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: 'second' }))
    await rejected
    const completed = nextFrame(opened.ws, (frame) => frame.type === 'response.completed')
    const closed = once(opened.ws, 'close')
    release()
    assert.equal((await completed).response.id, 'drained')
    await pending
    assert.equal((await closed)[0], 1001)
    assert.equal(hops, 1)
  } finally {
    release()
    opened.ws.terminate()
    await live.close()
  }
})
