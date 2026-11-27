import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { createFailoverMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'
import { activateFixture, seedEncryptedPackage } from '../fixtures/crag-license.mjs'

const MESSAGE = {
  model: 'claude-haiku-4-5',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hello from the queue' }],
}

function overloaded() {
  return {
    ok: false,
    status: 529,
    terminalState: 'exhausted',
    body: {
      type: 'error',
      error: {
        type: 'overloaded_error',
        code: 'pool_overloaded',
        message: '号池负载过高，稍后再试',
        details: { reason: 'pool_deadline_exceeded' },
      },
    },
  }
}

function createResponse() {
  const chunks = []
  const res = {
    statusCode: 0,
    body: null,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    chunks,
    writeHead(status) {
      this.statusCode = status
      this.headersSent = true
    },
    write(chunk) {
      chunks.push(String(chunk))
      return true
    },
    end() {
      this.writableEnded = true
    },
    on(event, fn) {
      if (event === 'finish') this.finish = fn
    },
    once() {},
    off() {},
    setHeader() {},
  }
  return res
}

function createHandler({ root, routing, run, stream = true }) {
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: {}, failover: routing.failover || {} }))
  return createHandleProtocol({
    json(res, status, body) {
      res.statusCode = status
      res.body = body
      res.headersSent = true
      return body
    },
    writeSSEHeaders(res) {
      res.writeHead(200)
    },
    readBody: async () => ({ ...MESSAGE, stream }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: {
        max_body_bytes: 1024 * 1024,
        upstream_timeout_ms: 2000,
        stream_idle_timeout_ms: 2000,
        stream_keepalive_ms: routing.failover?.stream_keepalive_ms ?? 20,
        queue_keepalive_delay_ms: routing.failover?.queue_keepalive_delay_ms ?? 60_000,
      },
      paths: { data: root, project: root },
    },
    requestLog: {
      start: () => ({ request_id: 'queue-keepalive', mode: 'normal', t0: Date.now() }),
      finish() {},
    },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: {},
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: { run },
  })
}

async function invoke(handler, res, extraHeaders = {}) {
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: {
      authorization: 'Bearer master',
      'user-agent': 'claude-cli/2.1.187 (external, cli)',
      ...extraHeaders,
    },
    apiKeyKind: 'master',
    once() {},
    off() {},
  }
  await handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')
  res.finish?.()
}

async function activeAttemptFailure({ block, delta, clusterDisconnect = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-active-keepalive-'))
  const socketPath = path.join(root, 'kernel.sock')
  const tokenPath = path.join(root, 'internal.token')
  fs.writeFileSync(tokenPath, 'offline-active-keepalive-token')
  const failure = {
    type: 'error',
    error: { type: 'overloaded_error', message: 'first loopback attempt failed before completion' },
  }
  const start = (id) => ({
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: MESSAGE.model,
      content: [],
      usage: { input_tokens: 2, output_tokens: 0 },
    },
  })
  const firstEvents = [start('msg_failed_attempt')]
  if (block) {
    firstEvents.push(
      { type: 'content_block_start', index: 0, content_block: block },
      { type: 'content_block_delta', index: 0, delta },
    )
  }
  const successEvents = [
    start('msg_retry_success'),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'only the retry succeeded' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
  const writeEvents = (response, events) => {
    for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  let upstreamRequests = 0
  let firstAttemptActive = false
  let sawActivePing = false
  let pingTimer = null
  let failFirstAttempt = null
  const sockets = new Set()
  const server = http.createServer((req, response) => {
    req.resume()
    req.on('end', () => {
      upstreamRequests++
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (upstreamRequests !== 1) {
        writeEvents(response, successEvents)
        response.end()
        return
      }
      // Keep a real upstream request open until a downstream ping is observed.
      // The queue delay is much longer, so a queue ping cannot satisfy this gate.
      firstAttemptActive = true
      failFirstAttempt = () => {
        clearTimeout(pingTimer)
        firstAttemptActive = false
        if (clusterDisconnect) return response.destroy()
        writeEvents(response, [failure])
        response.end()
      }
      writeEvents(response, firstEvents)
      pingTimer = setTimeout(failFirstAttempt, 1000)
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const res = createResponse()
  const write = res.write.bind(res)
  res.write = (chunk) => {
    const written = write(chunk)
    if (firstAttemptActive && String(chunk).includes('event: ping')) {
      sawActivePing = true
      if (!clusterDisconnect) failFirstAttempt()
    }
    if (firstAttemptActive && clusterDisconnect && String(chunk).includes('already delivered text')) failFirstAttempt()
    return written
  }
  const candidates = [1, 2].map((number) => {
    const vm = {
      id: `active-keepalive-${number}`,
      ...(clusterDisconnect ? { node_id: 'cluster-node' } : {}),
      runtime: { kernel_socket: socketPath, worker_run_dir: root, worker_token_file: tokenPath },
    }
    return {
      vmId: vm.id,
      accountId: `account-${number}`,
      exec: { projectRoot: root, homeDir: path.join(root, `cli-home-${number}`), vm },
    }
  })
  const released = []
  const scheduler = {
    candidates,
    async selectAndReserve({ excluded, avoid }) {
      const selected = candidates.find(
        (candidate) =>
          !excluded.has(candidate.accountId) &&
          !excluded.has(candidate.vmId) &&
          !avoid?.has(candidate.accountId) &&
          !avoid?.has(candidate.vmId),
      )
      return selected
        ? { ...selected, ok: true, release: () => released.push(selected.accountId) }
        : { ok: false, reason: 'no_eligible_accounts' }
    },
    markCooldown() {},
    markSuccess() {},
  }
  const runner = new FailoverRunner({
    scheduler,
    schedulerRuntime: createFailoverMockSchedulerRuntime({ scheduler }),
    config: {
      max_same_account_retries: 0,
      max_account_switches: 1,
      max_total_attempts: 2,
      total_retry_deadline_ms: 4000,
    },
  })
  let result
  const handler = createHandler({
    root,
    routing: { compatibility: {}, failover: { stream_keepalive_ms: 20, queue_keepalive_delay_ms: 60_000 } },
    run: async (opts) => {
      result = await runner.run({
        ...opts,
        // Only discovery and outbound preparation are fixtures. Keep the real
        // handler's callAttempt, socket transport, SSE buffering and runner policy.
        applyAttempt: (body) => ({
          body,
          meta: {
            cliHop: true,
            cragPrint: false,
            preparedHop: { decision: { wanted: 'rust', blocked: false }, ready: { ok: true, health: { ok: true } } },
          },
        }),
      })
      return result
    },
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    await invoke(handler, res)
    const events = res.chunks
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5).trim()))
    return { res, result, events, firstEvents, successEvents, failure, upstreamRequests, sawActivePing, released }
  } finally {
    clearTimeout(pingTimer)
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

for (const kind of ['metadata-only', 'text', 'thinking']) {
  const prelude = kind === 'metadata-only' ? kind : `empty ${kind}`
  test(`an active ping and ${prelude} prelude do not prevent real failover`, { timeout: 10_000 }, async () => {
    const h = await activeAttemptFailure(
      kind === 'metadata-only'
        ? {}
        : {
            block: { type: kind, [kind]: '' },
            delta: { type: `${kind}_delta`, [kind]: '' },
          },
    )
    assert.equal(h.sawActivePing, true, 'the first upstream must still be active when the caller receives a ping')
    assert.equal(h.upstreamRequests, 2)
    assert.equal(h.result.attemptCount, 2)
    assert.equal(h.result.accountId, 'account-2')
    assert.equal(h.result.ok, true)
    assert.equal(h.result.status, 200)
    assert.equal(h.result.finalState, 'verified')
    assert.equal(h.result.body.id, 'msg_retry_success')
    assert.deepEqual(h.result.body.content, [{ type: 'text', text: 'only the retry succeeded' }])
    assert.deepEqual(h.released, ['account-1', 'account-2'])
    assert.equal(h.res.statusCode, 200)
    assert.equal(h.res.writableEnded, true)
    assert.equal(h.events[0].type, 'ping')
    // No failed attempt metadata, empty block or error may be replayed as success.
    assert.deepEqual(
      h.events.filter((event) => event.type !== 'ping'),
      h.successEvents,
    )
  })
}

for (const scenario of [
  { name: 'text', block: { type: 'text', text: '' }, delta: { type: 'text_delta', text: 'already delivered text' } },
  {
    name: 'tool call',
    block: { type: 'tool_use', id: 'toolu_delivered', name: 'Read', input: {} },
    delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/example.txt"}' },
  },
]) {
  test(`substantive ${scenario.name} followed by failure never dispatches the retry`, { timeout: 10_000 }, async () => {
    const h = await activeAttemptFailure(scenario)
    assert.equal(h.sawActivePing, true)
    assert.equal(h.upstreamRequests, 1)
    assert.equal(h.result.attemptCount, 1)
    assert.equal(h.result.accountId, 'account-1')
    assert.equal(h.result.ok, false)
    assert.equal(h.result.committed, true)
    assert.equal(h.result.finalState, 'incomplete')
    assert.deepEqual(h.result.body, h.failure)
    assert.deepEqual(h.released, ['account-1'])
    assert.equal(h.res.statusCode, 200)
    assert.equal(h.res.writableEnded, true)
    const output = h.events.filter((event) => event.type !== 'ping')
    assert.deepEqual(output.slice(0, -1), h.firstEvents)
    assert.equal(output.at(-1).type, 'error')
    assert.equal(output.at(-1).error.type, 'overloaded_error')
    assert.equal(output.at(-1).error.code, 'upstream_overloaded')
    assert.equal(output.at(-1).error.message, h.failure.error.message)
    assert.equal(
      h.events.some((event) => event.type === 'message_stop'),
      false,
    )
  })
}

test('a cluster disconnect after visible SSE output reports delivery uncertainty without replay', async () => {
  const h = await activeAttemptFailure({
    block: { type: 'text', text: '' },
    delta: { type: 'text_delta', text: 'already delivered text' },
    clusterDisconnect: true,
  })
  assert.equal(h.upstreamRequests, 1)
  assert.equal(h.result.committed, true)
  assert.equal(h.result.status, 502)
  assert.deepEqual(h.released, ['account-1'])
  assert.equal(h.res.statusCode, 200)
  assert.equal(h.res.writableEnded, true)
  const output = h.events.filter((event) => event.type !== 'ping')
  assert.deepEqual(output.slice(0, -1), h.firstEvents)
  assert.equal(output.at(-1).type, 'error')
  assert.equal(output.at(-1).error.code, 'cluster_delivery_unconfirmed')
})

test('a Claude stream pings during the queue and reports a later failure as SSE error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-queue-keepalive-'))
  const res = createResponse()
  let sawPingBeforeReturn = false
  const handler = createHandler({
    root,
    routing: {
      compatibility: {},
      failover: { stream_keepalive_ms: 20, queue_keepalive_delay_ms: 30 },
    },
    run: async () => {
      const started = Date.now()
      while (Date.now() - started < 400) {
        if (res.chunks.some((chunk) => chunk.includes('event: ping'))) {
          sawPingBeforeReturn = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return overloaded()
    },
  })
  try {
    await invoke(handler, res)
    assert.equal(sawPingBeforeReturn, true)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headersSent, true)
    const body = res.chunks.join('')
    assert.match(body, /event: ping/)
    assert.match(body, /event: error/)
    const errorLine = body.split('\n').find((line) => line.startsWith('data:') && line.includes('overloaded_error'))
    const payload = JSON.parse(errorLine.slice(5).trim())
    assert.equal(payload.type, 'error')
    assert.equal(payload.error.type, 'overloaded_error')
    assert.equal(payload.error.details, undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a Claude stream that fails before the queue delay keeps the HTTP status', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-queue-keepalive-fast-'))
  const res = createResponse()
  const handler = createHandler({
    root,
    routing: {
      compatibility: {},
      failover: { stream_keepalive_ms: 1000, queue_keepalive_delay_ms: 5_000 },
    },
    run: async () => overloaded(),
  })
  try {
    await invoke(handler, res)
    assert.equal(res.chunks.length, 0)
    assert.equal(res.statusCode, 529)
    assert.equal(res.body.error.type, 'overloaded_error')
    assert.equal(res.body.error.code, 'pool_overloaded')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('x-kin-queue: off reaches the runner as allowQueue:false; without it the request may queue', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-queue-hint-'))
  const seen = []
  const handler = createHandler({
    root,
    routing: { compatibility: {}, failover: { stream_keepalive_ms: 1000, queue_keepalive_delay_ms: 5_000 } },
    run: async (opts) => {
      seen.push(opts.allowQueue)
      return overloaded()
    },
  })
  try {
    const off = createResponse()
    await invoke(handler, off, { 'x-kin-queue': 'off' })
    assert.equal(off.statusCode, 529)
    assert.equal(off.body.error.code, 'pool_overloaded')
    assert.equal(off.chunks.length, 0)
    await invoke(handler, createResponse())
    assert.deepEqual(seen, [false, true])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('zero-execution session_home_slot_busy 529 logs attribution without ingesting quota or billing key requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-home-slot-busy-no-bill-'))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: {}, failover: {} }))
  let ingested = 0
  let recorded = 0
  let finished = null
  const handler = createHandleProtocol({
    json(res, status, body) {
      res.statusCode = status
      res.body = body
      res.headersSent = true
      return body
    },
    writeSSEHeaders(res) {
      res.writeHead(200)
    },
    readBody: async () => ({ ...MESSAGE, stream: false }),
    requireAuth(req) {
      req.apiKeyKind = 'managed'
      req.apiKeyRecord = { id: 'key_1', group_id: 1, group_type: 'all' }
      return true
    },
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: {
      start: () => ({ request_id: 'home-slot-busy', mode: 'normal', t0: Date.now() }),
      finish(_ctx, bag) {
        finished = bag
      },
    },
    stickyRouter: {},
    accountQuota: {
      ingestHeaders() {
        ingested++
      },
    },
    apiKeyStore: {
      acquire: () => ({ ok: true }),
      release() {},
      recordUsage() {
        recorded++
      },
    },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility: {}, failover: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      run: async () => ({
        ok: false,
        status: 529,
        via: 'pool-failover',
        terminalState: 'exhausted',
        retryAfterSec: 1,
        accountId: 'account-1',
        vmId: 'vm-01',
        attemptCount: 0,
        body: {
          type: 'error',
          error: {
            type: 'overloaded_error',
            code: 'pool_overloaded',
            message: '号池负载过高，稍后再试',
            details: { reason: 'session_home_slot_busy', attempt_count: 0 },
          },
        },
      }),
    },
  })
  try {
    const res = createResponse()
    await invoke(handler, res, { 'x-kin-queue': 'off' })
    assert.equal(res.statusCode, 529)
    assert.equal(res.body.error.code, 'pool_overloaded')
    assert.equal(ingested, 0)
    assert.equal(recorded, 0)
    assert.equal(finished.account_id, 'account-1')
    assert.equal(finished.vm_id, 'vm-01')
    assert.equal(finished.attempt_count, 0)
    assert.equal(finished.upstream_status, null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a non-stream Claude request does not emit queue pings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-queue-keepalive-json-'))
  const res = createResponse()
  const handler = createHandler({
    root,
    stream: false,
    routing: {
      compatibility: {},
      failover: { stream_keepalive_ms: 20, queue_keepalive_delay_ms: 20 },
    },
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      return overloaded()
    },
  })
  try {
    await invoke(handler, res)
    assert.equal(res.chunks.length, 0)
    assert.equal(res.statusCode, 529)
    assert.equal(res.body.error.type, 'overloaded_error')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an incomplete native handoff never becomes a successful output-limit terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-native-terminal-'))
  const socketPath = path.join(root, 'kernel.sock')
  const tokenPath = path.join(root, 'internal.token')
  fs.writeFileSync(tokenPath, 'offline-native-handoff-token')
  let upstreamRequests = 0
  const server = http.createServer(async (req, response) => {
    for await (const _chunk of req) {
    }
    upstreamRequests++
    response.writeHead(200, { 'content-type': 'text/event-stream', trailer: 'x-terminal-state' })
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'native-cut',
          type: 'message',
          role: 'assistant',
          model: MESSAGE.model,
          content: [],
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial native output' } },
    ]
    for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.addTrailers({ 'x-terminal-state': 'error' })
    response.end()
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  const health = { ok: true, runtime_variant: 'crag-v2', gateway_policy_v1: true, capabilities: ['native_handoff_v1'] }
  const exec = {
    projectRoot: root,
    homeDir: path.join(root, 'cli-home'),
    vm: {
      id: 'native-test',
      runtime: { kernel_socket: socketPath, worker_run_dir: root, worker_token_file: tokenPath },
    },
  }
  // Live CRAG health is license-checked before the inference POST.
  seedEncryptedPackage(root)
  activateFixture(root, exec.vm)
  const res = createResponse()
  const handler = createHandler({
    root,
    routing: { compatibility: {}, failover: { stream_keepalive_ms: 1000, queue_keepalive_delay_ms: 5000 } },
    run: async ({ callAttempt }) =>
      callAttempt({
        candidate: { exec, vmId: 'native-test' },
        body: { ...MESSAGE, stream: true },
        attemptMeta: {
          cliHop: true,
          cragPrint: true,
          preparedHop: { decision: { wanted: 'rust', blocked: false }, ready: { ok: true, health } },
        },
        deliveryMode: 'realtime',
        onCommit() {},
      }),
  })
  try {
    await invoke(handler, res)
    const body = res.chunks.join('')
    assert.equal(upstreamRequests, 1)
    assert.doesNotMatch(body, /"stop_reason":"max_tokens"|event: message_stop/)
    if (res.statusCode === 200) assert.match(body, /event: error/)
    else assert.equal(res.statusCode, 502)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('SSE stream preserves deltas containing literal response_headers and multi-byte UTF-8 across chunks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sse-response-headers-'))
  const socketPath = path.join(root, 'kernel.sock')
  const tokenPath = path.join(root, 'internal.token')
  fs.writeFileSync(tokenPath, 'offline-sse-filter-token')
  const server = http.createServer(async (req, response) => {
    for await (const _chunk of req) {
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const raw = [
      'event: response_headers\ndata: {"type":"response_headers","headers":{"x-request-id":"req_internal"}}\n\n',
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_response_headers_text',
          type: 'message',
          role: 'assistant',
          model: MESSAGE.model,
          content: [],
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      })}\n\n`,
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"check response_headers 字段"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    const buf = Buffer.from(raw, 'utf8')
    // Split directly inside the multi-byte UTF-8 sequence for "字".
    const splitAt = buf.indexOf(Buffer.from('字', 'utf8')) + 1
    response.write(buf.subarray(0, splitAt))
    await new Promise((resolve) => setTimeout(resolve, 10))
    response.end(buf.subarray(splitAt))
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  const exec = {
    projectRoot: root,
    homeDir: path.join(root, 'cli-home'),
    vm: {
      id: 'sse-filter-test',
      runtime: { kernel_socket: socketPath, worker_run_dir: root, worker_token_file: tokenPath },
    },
  }
  const res = createResponse()
  const handler = createHandler({
    root,
    routing: { compatibility: {}, failover: { stream_keepalive_ms: 1000, queue_keepalive_delay_ms: 5000 } },
    run: async ({ callAttempt }) =>
      callAttempt({
        candidate: { exec, vmId: 'sse-filter-test' },
        body: { ...MESSAGE, stream: true },
        attemptMeta: {
          cliHop: true,
          cragPrint: false,
          preparedHop: { decision: { wanted: 'rust', blocked: false }, ready: { ok: true, health: { ok: true } } },
        },
        deliveryMode: 'realtime',
        onCommit() {},
      }),
  })
  try {
    await invoke(handler, res)
    const rawOut = res.chunks.join('')
    const frames = rawOut
      .split(/\r?\n\r?\n/)
      .map((frame) => frame.trim())
      .filter(Boolean)
    const parsed = frames.map((frame) => {
      const eventLine = frame.split('\n').find((line) => line.startsWith('event:'))
      const dataLines = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
      assert.ok(eventLine, `expected event line in frame: ${frame}`)
      assert.ok(dataLines.length > 0, `expected non-empty data line in frame: ${frame}`)
      return { event: eventLine.slice(6).trim(), data: JSON.parse(dataLines.join('\n')) }
    })
    assert.equal(
      parsed.some((f) => f.event === 'response_headers' || f.data.type === 'response_headers'),
      false,
    )
    const delta = parsed.find((f) => f.event === 'content_block_delta')
    assert.equal(delta?.data?.delta?.text, 'check response_headers 字段')
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
