import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { handleCodexProtocol } from '../../src/lib/protocol/handle-codex.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createResponsesWsHandler } from '../../src/lib/protocol/responses-ws.mjs'
import { createSchedulerRuntime, formatNodeKey } from '../../src/lib/scheduler/scheduler-runtime.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { listVms } from '../../src/lib/vm/vm-registry.mjs'
import {
  codexKernelHealth,
  resetCodexKernelClientCachesForTests,
} from '../../src/lib/transport/codex-kernel-client.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')

function resolveBinary(name) {
  const pathCandidate = path.join(REPO_ROOT, 'bin', name)
  return fs.existsSync(pathCandidate) ? pathCandidate : null
}

const KERNEL_BIN = resolveBinary('kin-codex-kernel')
const SCHED_BIN = resolveBinary('kin-scheduler')
const CAN_RUN_LOOPBACK = process.platform === 'linux' && Boolean(KERNEL_BIN) && Boolean(SCHED_BIN)

function readBytes(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function spawnKernel({ binPath, configPath, healthExec }) {
  const stderrLines = []
  const proc = spawn(binPath, [configPath], { stdio: ['ignore', 'ignore', 'pipe'] })
  proc.stderr.on('data', (chunk) => {
    stderrLines.push(String(chunk))
    if (stderrLines.length > 40) stderrLines.shift()
  })
  const deadline = Date.now() + 8000
  let lastHealth = null
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`kin-codex-kernel exited early (${proc.exitCode}): ${stderrLines.join('')}`)
    }
    const health = await codexKernelHealth(healthExec, { timeoutMs: 500 })
    lastHealth = health
    if (health?.ok && health?.accounts >= 1) {
      return {
        proc,
        health,
        async stop() {
          if (proc.exitCode !== null) return
          proc.kill('SIGTERM')
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              proc.kill('SIGKILL')
              resolve()
            }, 2000)
            proc.once('exit', () => {
              clearTimeout(timer)
              resolve()
            })
          })
        },
      }
    }
    await new Promise((r) => setTimeout(r, 40))
  }
  proc.kill('SIGKILL')
  throw new Error(`kin-codex-kernel health timed out: ${JSON.stringify(lastHealth)} ${stderrLines.join('')}`)
}

async function readJson(req) {
  const buf = await readBytes(req)
  return JSON.parse(buf.toString('utf8') || '{}')
}

function nextFrame(ws, predicate = () => true, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const seen = []
    const timer = setTimeout(
      () => reject(new Error(`ws frame timeout; seen=${JSON.stringify(seen.slice(-5))}`)),
      timeoutMs,
    )
    const onMessage = (data) => {
      const frame = JSON.parse(String(data))
      seen.push(frame.type || frame)
      if (!predicate(frame)) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(frame)
    }
    ws.on('message', onMessage)
  })
}

function writeLoopbackVm(root, id, token) {
  const runDir = path.join(root, 'vms', id, 'run')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(path.join(root, 'vms', id, 'cli-home'), { recursive: true })
  fs.writeFileSync(path.join(runDir, 'internal.token'), token)
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
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
    path.join(root, 'vms', id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [
        { id: `${id}-acc`, access_token: 'loopback-at', refresh_token: 'loopback-rt', chatgpt_account_id: id },
      ],
    }),
  )
  return {
    runDir,
    socketPath: path.join(runDir, 'codex-kernel.sock'),
    configPath: path.join(runDir, 'codex-kernel.json'),
    credPath: path.join(root, 'vms', id, 'codex-credentials.json'),
    healthExec: {
      vmId: id,
      homeDir: path.join(root, 'vms', id, 'cli-home'),
      vm: { id },
    },
  }
}

let sharedRoot = null
let sharedSched = null
let activeRoot = null

before(async () => {
  if (!CAN_RUN_LOOPBACK) return
  sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loopback-sched-'))
  sharedSched = createSchedulerRuntime({
    cfg: { paths: { data: sharedRoot, project: sharedRoot } },
    getVms: () => (activeRoot && fs.existsSync(activeRoot) ? listVms(activeRoot) : []),
    getRoutingConfig: () => ({}),
    telemetryIntervalMs: 0,
    clientOptions: {
      binPath: SCHED_BIN,
      socketPath: path.join(sharedRoot, 'run', 'scheduler.sock'),
      tokenPath: path.join(sharedRoot, 'run', 'scheduler.token'),
      capFile: path.join(sharedRoot, 'run', 'scheduler.cap.json'),
      manageProcess: true,
    },
  })
  await sharedSched.start({ waitMs: 5000, startLoops: false })
})

after(async () => {
  resetCodexKernelClientCachesForTests()
  if (sharedSched) await sharedSched.shutdown({ drain: false, stopProcess: true })
  if (sharedRoot) fs.rmSync(sharedRoot, { recursive: true, force: true })
})

test('real bin/kin-codex-kernel loopback: HTTP zstd, UDS packed + restart 409 miss recovery, WS permessage-deflate + ws_replay + /interrupt', {
  skip: CAN_RUN_LOOPBACK ? false : 'Linux + compiled bin/kin-codex-kernel & bin/kin-scheduler required',
}, async (t) => {
  const httpSeen = []
  const wsConnections = []
  const wsReceivedMessages = []

  // Fake local OpenAI upstream supporting HTTP+zstd AND WebSocket+permessage-deflate
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/backend-api/codex/responses') {
      const raw = await readBytes(req)
      const encoding = String(req.headers['content-encoding'] || '').toLowerCase()
      const bodyBuf = encoding === 'zstd' ? zlib.zstdDecompressSync(raw) : raw
      const parsed = JSON.parse(bodyBuf.toString('utf8'))
      const idx = httpSeen.length + 1
      httpSeen.push({ encoding, parsed })

      const sse = [
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: `resp_http_${idx}`, output: [] } })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: `msg_${idx}`, output_index: 0, content_index: 0, delta: `http-${idx}` })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: `resp_http_${idx}`,
            object: 'response',
            status: 'completed',
            model: parsed.model || 'gpt-5.4',
            output: [
              {
                type: 'message',
                id: `msg_${idx}`,
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: `http-${idx}` }],
              },
            ],
            usage: { input_tokens: 10 + idx, output_tokens: 3, total_tokens: 13 + idx },
          },
        })}\n\n`,
      ].join('')

      const acceptsZstd = String(req.headers['accept-encoding'] || '').includes('zstd')
      const outHeaders = { 'content-type': 'text/event-stream; charset=utf-8' }
      let outBody = Buffer.from(sse, 'utf8')
      if (acceptsZstd) {
        outHeaders['content-encoding'] = 'zstd'
        outBody = zlib.zstdCompressSync(outBody)
      }
      res.writeHead(200, outHeaders)
      res.end(outBody)
      return
    }
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true })
  upstream.on('upgrade', (req, socket, head) => {
    if (req.url !== '/backend-api/codex/responses') {
      socket.destroy()
      return
    }
    wsConnections.push({
      url: req.url,
      ext: String(req.headers['sec-websocket-extensions'] || ''),
      sessionId: String(req.headers['session-id'] || ''),
    })
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data))
        wsReceivedMessages.push(msg)

        if (msg.type === 'response.create') {
          const turnNum = wsReceivedMessages.filter((m) => m.type === 'response.create').length
          const textInput = JSON.stringify(msg.input || [])
          if (textInput.includes('interrupt-me')) {
            const respId = 'resp_ws_interrupt'
            ws.send(JSON.stringify({ type: 'response.created', response: { id: respId, output: [] } }))
            ws.send(
              JSON.stringify({
                type: 'response.output_text.delta',
                item_id: 'msg_int',
                output_index: 0,
                content_index: 0,
                delta: 'partial-',
              }),
            )
            return
          }

          const respId = `resp_ws_${turnNum}`
          const replyText = `ws-reply-${turnNum}`
          const item = {
            type: 'message',
            id: `msg_ws_${turnNum}`,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: replyText }],
          }
          ws.send(JSON.stringify({ type: 'response.created', response: { id: respId, output: [] } }))
          ws.send(JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }))
          ws.send(
            JSON.stringify({
              type: 'response.completed',
              response: {
                id: respId,
                object: 'response',
                status: 'completed',
                model: msg.model || 'gpt-5.4',
                output: [item],
                usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
              },
            }),
          )
        } else if (msg.type === 'response.interrupt') {
          const partialItem = {
            type: 'message',
            id: 'msg_int',
            role: 'assistant',
            status: 'incomplete',
            content: [{ type: 'output_text', text: 'partial-' }],
          }
          ws.send(
            JSON.stringify({
              type: 'response.interrupt.accepted',
              previous_response_id: 'resp_ws_interrupt',
              mode: 'discard_partial_items',
            }),
          )
          ws.send(
            JSON.stringify({
              type: 'response.incomplete',
              response: {
                id: 'resp_ws_interrupt',
                object: 'response',
                status: 'incomplete',
                incomplete_details: { reason: 'interrupted' },
                model: 'gpt-5.4',
                output: [partialItem],
                usage: { input_tokens: 25, output_tokens: 2, total_tokens: 27 },
              },
            }),
          )
        }
      })
    })
  })

  const upstreamSockets = new Set()
  upstream.on('connection', (s) => {
    upstreamSockets.add(s)
    s.once('close', () => upstreamSockets.delete(s))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate()
    wss.close()
    upstream.closeAllConnections?.()
    for (const s of upstreamSockets) s.destroy()
    await Promise.race([
      new Promise((resolve) => upstream.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ])
  })
  const { port: upstreamPort } = upstream.address()
  const baseUrl = `http://127.0.0.1:${upstreamPort}/backend-api/codex`

  // Part 1: HTTP+zstd + UDS packed + real kernel-restart 409 miss recovery
  const rootHttp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loopback-http-'))
  t.after(() => fs.rmSync(rootHttp, { recursive: true, force: true }))
  const tokenHttp = 'tok-loop-http'
  const vmHttp = writeLoopbackVm(rootHttp, 'gpt-loop', tokenHttp)
  fs.writeFileSync(
    vmHttp.configPath,
    JSON.stringify({
      vm_id: 'gpt-loop',
      device_id: '0f3c2b1a-1111-4222-8333-444455556666',
      socket_path: vmHttp.socketPath,
      credential_path: vmHttp.credPath,
      proxy_url: '',
      proxy_required: false,
      internal_token: tokenHttp,
      upstream_transport: 'http',
      max_request_bytes: 33554432,
      test_endpoints: true,
      chatgpt_base_url: baseUrl,
      oauth_token_url: `${baseUrl}/oauth/token`,
    }),
  )

  let kernelHttp = await spawnKernel({
    binPath: KERNEL_BIN,
    configPath: vmHttp.configPath,
    healthExec: vmHttp.healthExec,
  })
  t.after(() => kernelHttp?.stop())

  fs.writeFileSync(
    path.join(rootHttp, 'routing.json'),
    JSON.stringify({
      pool: { fallback_wait_timeout_ms: 3000 },
      codex: {
        upstream_transport: 'http',
        clients: { openai_compatible: 'allow', official_codex: 'allow', unknown: 'allow' },
        protocols: { 'openai.responses': { enabled: true, mode: 'native' } },
      },
    }),
  )
  activeRoot = rootHttp
  await sharedSched.syncConfigNow('loopback_http')
  await sharedSched.pushTelemetryNow()
  await sharedSched.unrestNode(formatNodeKey('codex_vm', 'gpt-loop')).catch(() => {})

  const runHttpTurn = async (input) => {
    const logBag = {}
    const headerMap = {}
    const chunks = []
    const res = {
      statusCode: 0,
      headersSent: false,
      body: null,
      setHeader(k, v) {
        headerMap[String(k).toLowerCase()] = v
      },
      write(chunk) {
        chunks.push(chunk)
      },
      end() {},
    }
    await handleCodexProtocol({
      req: { headers: {}, apiKeyKind: 'master' },
      res,
      protocol: 'openai.responses',
      ctx: { body: { model: 'gpt-5.4', stream: false, input } },
      inbound: { model: 'gpt-5.4', stream: false, input },
      logBag,
      stats: { errors: 0, requests: 0, by_route: {} },
      json(_res, status, body) {
        res.statusCode = status
        res.body = body
      },
      writeSSEHeaders() {
        res.statusCode = 200
        res.headersSent = true
      },
      projectRoot: rootHttp,
      cfg: {
        limits: { upstream_timeout_ms: 5000, stream_idle_timeout_ms: 5000 },
      },
      routing: {
        codex: {
          upstream_transport: 'http',
          clients: { openai_compatible: 'allow', official_codex: 'allow', unknown: 'allow' },
          protocols: { 'openai.responses': { enabled: true, mode: 'native' } },
        },
      },
      schedulerRuntime: sharedSched,
      ops: {
        writeCodexKernelConfig() {},
        ensureCodexKernel: async () => ({
          ok: true,
          socketPath: vmHttp.socketPath,
          token: tokenHttp,
          health: kernelHttp.health,
        }),
      },
    })
    return { res, logBag, headerMap }
  }

  const baseMessages = Array.from({ length: 12 }, (_, i) => ({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: `turn-context-item-${i}-` + 'p'.repeat(30) }],
  }))

  const h1 = await runHttpTurn(baseMessages)
  assert.equal(h1.res.statusCode, 200)
  assert.equal(h1.res.body?.id, 'resp_http_1')
  assert.equal(httpSeen[0].encoding, 'zstd')
  assert.equal(
    h1.logBag.hop_meta?.codex_vm_timing?.attempts?.[0]?.uds_packed?.endpoint,
    '/internal/v1/codex/responses/packed',
  )
  assert.equal(h1.logBag.hop_meta?.codex_vm_timing?.attempts?.[0]?.uds_packed?.stored, true)
  assert.equal(h1.logBag.hop_meta?.codex_vm_timing?.attempts?.[0]?.upstream?.transport, 'http')
  assert.equal(h1.headerMap['x-tap-turn-timing'], undefined)

  const h2Messages = [
    ...baseMessages,
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'turn-2-delta' }] },
  ]
  const h2 = await runHttpTurn(h2Messages)
  assert.equal(h2.res.statusCode, 200)
  assert.equal(h2.res.body?.id, 'resp_http_2')
  assert.equal(h2.logBag.hop_meta?.codex_vm_timing?.attempts?.[0]?.uds_packed?.delta, true)

  // Kill and restart real kernel ELF so UDS base cache in kernel is wiped, while Node still remembers base!
  await kernelHttp.stop()
  kernelHttp = await spawnKernel({
    binPath: KERNEL_BIN,
    configPath: vmHttp.configPath,
    healthExec: vmHttp.healthExec,
  })

  const h3 = await runHttpTurn([
    ...h2Messages,
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'turn-3-after-restart' }] },
  ])
  assert.equal(h3.res.statusCode, 200)
  assert.equal(h3.res.body?.id, 'resp_http_3')
  assert.equal(h3.logBag.hop_meta?.codex_vm_timing?.attempts?.[0]?.uds_packed?.cacheMissRetried, true)
  assert.equal(httpSeen.length, 3, '409 UDS miss retry must happen locally without double-sending to upstream')
  await kernelHttp.stop()
  kernelHttp = null

  // Part 2: Real WebSocket permessage-deflate + ws_replay delta + live /internal/v1/interrupt + timing
  resetCodexKernelClientCachesForTests()
  const rootWs = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-loopback-ws-'))
  t.after(() => fs.rmSync(rootWs, { recursive: true, force: true }))
  const tokenWs = 'tok-loop-ws'
  const vmWs = writeLoopbackVm(rootWs, 'gpt-loop-ws', tokenWs)
  fs.writeFileSync(
    vmWs.configPath,
    JSON.stringify({
      vm_id: 'gpt-loop-ws',
      device_id: '1f3c2b1a-1111-4222-8333-444455556666',
      socket_path: vmWs.socketPath,
      credential_path: vmWs.credPath,
      proxy_url: '',
      proxy_required: false,
      internal_token: tokenWs,
      upstream_transport: 'prefer_websocket',
      max_request_bytes: 33554432,
      test_endpoints: true,
      chatgpt_base_url: baseUrl,
      oauth_token_url: `${baseUrl}/oauth/token`,
    }),
  )

  const kernelWs = await spawnKernel({
    binPath: KERNEL_BIN,
    configPath: vmWs.configPath,
    healthExec: vmWs.healthExec,
  })
  t.after(() => kernelWs.stop())

  const wsRouting = {
    websocket: { enabled: true },
    sticky: { enabled: true, outbound_session: 'passthrough' },
    pool: { fallback_wait_timeout_ms: 3000 },
    codex: {
      websocket: { enabled: true },
      upstream_transport: 'prefer_websocket',
      clients: { openai_compatible: 'allow', official_codex: 'allow', unknown: 'allow' },
      protocols: { 'openai.responses': { enabled: true, mode: 'native' } },
    },
  }
  fs.mkdirSync(path.join(rootWs, 'data'), { recursive: true })
  const stickyRouter = new StickyRouter({
    dataDir: path.join(rootWs, 'data'),
    config: wsRouting,
  })
  t.after(() => stickyRouter.db?.close?.())
  const wsRoutingPath = path.join(rootWs, 'routing.json')
  fs.writeFileSync(wsRoutingPath, JSON.stringify(wsRouting))
  activeRoot = rootWs
  await sharedSched.syncConfigNow('loopback_ws')
  await sharedSched.pushTelemetryNow()
  await sharedSched.unrestNode(formatNodeKey('codex_vm', 'gpt-loop-ws')).catch(() => {})

  const finishBags = []
  const { handleProtocol } = createHandleProtocol({
    json(res, status, body) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    },
    writeSSEHeaders(res) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
    },
    readBody: readJson,
    requireAuth(req) {
      req.apiKeyKind = 'master'
      return true
    },
    schedulerRuntime: sharedSched,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 30_000, stream_idle_timeout_ms: 30_000 },
      paths: { data: rootWs, project: rootWs },
    },
    requestLog: {
      start: () => ({ request_id: `loop-ws-${finishBags.length + 1}`, t0: Date.now() }),
      finish(_ctx, bag) {
        finishBags.push(bag)
      },
    },
    stickyRouter,
    accountQuota: { sessions: null, ingestHeaders: () => {} },
    apiKeyStore: { acquire: () => ({ ok: true }), recordUsage() {}, release() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    routingConfigPath: wsRoutingPath,
    routingConfig: wsRouting,
    groupsRepo: { rateMultiplier: () => 1 },
    codexOps: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({
        ok: true,
        socketPath: vmWs.socketPath,
        token: tokenWs,
        health: kernelWs.health,
      }),
    },
  })

  const wsHandler = createResponsesWsHandler({
    handleProtocol,
    requireAuth(req) {
      req.apiKeyKind = 'master'
      return true
    },
    json(res, status, body) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    },
    getRouting: () => wsRouting,
  })

  const gwServer = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  const gwSockets = new Set()
  gwServer.on('connection', (s) => {
    gwSockets.add(s)
    s.once('close', () => gwSockets.delete(s))
  })
  gwServer.on('upgrade', (req, socket, head) => {
    if (!wsHandler.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise((resolve) => gwServer.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    gwServer.closeAllConnections?.()
    for (const s of gwSockets) s.destroy()
    await Promise.race([
      new Promise((resolve) => gwServer.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ])
  })
  const gwPort = gwServer.address().port

  const clientWs = new WebSocket(`ws://127.0.0.1:${gwPort}/v1/responses`, {
    headers: { 'x-session-id': 'ws-loop-session-1' },
  })
  await new Promise((resolve, reject) => {
    clientWs.once('open', resolve)
    clientWs.once('error', reject)
  })
  t.after(() => clientWs.terminate())

  // WS Turn 1
  const c1Done = nextFrame(clientWs, (f) => f.type === 'response.completed')
  clientWs.send(
    JSON.stringify({
      type: 'response.create',
      model: 'gpt-5.4',
      prompt_cache_key: 'ws-loop-session-1',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ws-turn-1' }] }],
    }),
  )
  const f1 = await c1Done
  assert.equal(f1.response.id, 'resp_ws_1')
  assert.match(wsConnections[0]?.ext || '', /permessage-deflate/)

  // WS Turn 2 with previous_response_id -> kernel should send incremental previous_response_id over pooled WS!
  const c2Done = nextFrame(clientWs, (f) => f.type === 'response.completed')
  clientWs.send(
    JSON.stringify({
      type: 'response.create',
      model: 'gpt-5.4',
      previous_response_id: 'resp_ws_1',
      prompt_cache_key: 'ws-loop-session-1',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ws-turn-2' }] }],
    }),
  )
  const f2 = await c2Done
  assert.equal(f2.response.id, 'resp_ws_2')
  assert.equal(wsConnections.length, 1, 'upstream WebSocket connection must be reused across turns')
  const upstreamTurn2Msg = wsReceivedMessages.find(
    (m) => m.type === 'response.create' && m.previous_response_id === 'resp_ws_1',
  )
  assert.ok(upstreamTurn2Msg, 'kin-codex-kernel ws_replay must send incremental previous_response_id delta')
  assert.equal(upstreamTurn2Msg.input.length, 1)

  // WS Turn 3: live response.interrupt forwarded to POST /internal/v1/interrupt -> response.incomplete
  const c3Created = nextFrame(clientWs, (f) => f.type === 'response.created' && f.response?.id === 'resp_ws_interrupt')
  clientWs.send(
    JSON.stringify({
      type: 'response.create',
      model: 'gpt-5.4',
      prompt_cache_key: 'ws-loop-session-1',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'interrupt-me' }] }],
    }),
  )
  await c3Created

  const intAccepted = nextFrame(clientWs, (f) => f.type === 'response.interrupt.accepted')
  const intIncomplete = nextFrame(clientWs, (f) => f.type === 'response.incomplete')
  clientWs.send(JSON.stringify({ type: 'response.interrupt', previous_response_id: 'resp_ws_interrupt' }))
  const acc = await intAccepted
  const inc = await intIncomplete
  assert.equal(acc.previous_response_id, 'resp_ws_interrupt')
  assert.equal(inc.response?.incomplete_details?.reason, 'interrupted')
  assert.ok(
    wsReceivedMessages.some((m) => m.type === 'response.interrupt'),
    'upstream WS must receive forwarded response.interrupt from POST /internal/v1/interrupt',
  )

  await new Promise((r) => setTimeout(r, 80))
  assert.ok(finishBags.length >= 3)
  assert.equal(finishBags[0].hop_meta?.codex_vm_timing?.attempts?.[0]?.upstream?.transport, 'websocket')
})
