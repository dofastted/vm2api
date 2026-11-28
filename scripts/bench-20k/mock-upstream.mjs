#!/usr/bin/env node
/**
 * High-throughput Anthropic / vm2api slot-kernel Mock Upstream Pool.
 *
 * Designed to sustain 20,000+ RPM × 400KB request bodies (~133 MB/s) without
 * becoming a bottleneck:
 *   - Multi-worker Node.js `cluster` mode (`--workers 4` default) + HTTP/1.1 keep-alive
 *   - Serves BOTH TCP (`http://127.0.0.1:<port>`) AND per-worker Unix domain sockets
 *     (`<sock-dir>/mock-w<i>.sock`) so vm2api's real `streamRustKernel` / `workerRequest`
 *     dataplane hits this mock over authentic HTTP-over-UDS without `KIN_CRS_MOCK=1`
 *   - Consumes full request body stream (counting bytesIn, zero full-JSON deep parse)
 *   - Streams real Anthropic SSE (`message_start` -> `content_block_start/delta/stop`
 *     -> `message_delta` with usage -> `message_stop`) with realistic unified rate-limit
 *     headers and `x-mock-upstream-ms` / `x-mock-ttft-ms`
 *   - Parameterized `--ttft-ms`, `--stream-ms`, `--fault-rate` (real 429 RPM / 502)
 *   - Exposes `GET /__stats`, `POST /__reset`, `POST /__config`, `GET /health`,
 *     `GET /internal/health`, `POST /internal/v1/cancel`, `POST /internal/v1/messages`,
 *     `POST /v1/messages`
 */
import cluster from 'node:cluster'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929'
const MODEL_SNIFF_RE = /"model"\s*:\s*"([^"\\]{1,96})"/
const STREAM_FALSE_SNIFF_RE = /"stream"\s*:\s*false\b/
const DEFAULT_TEXT_CHUNKS = [
  'Bench mock response chunk 1: control-plane throughput verified. ',
  'Chunk 2: streaming SSE event pipeline active. ',
  'Chunk 3: terminal message_delta and message_stop complete.',
]

function clampNum(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function clampInt(value, fallback, min, max) {
  return Math.round(clampNum(value, fallback, min, max))
}

function round2(n) {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultWorkerCount() {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
  return Math.max(1, Math.min(4, cpus || 2))
}

export function parseMockArgs(argv = []) {
  const opts = {
    host: '127.0.0.1',
    port: 19100,
    workers: defaultWorkerCount(),
    nodes: 200,
    ttftMs: 10,
    streamMs: 20,
    faultRate: 0.02,
    sockDir: '',
    readyFile: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--host') opts.host = String(argv[++i] || '127.0.0.1')
    else if (a === '--port') opts.port = clampInt(argv[++i], 19100, 0, 65535)
    else if (a === '--workers') opts.workers = clampInt(argv[++i], defaultWorkerCount(), 1, 32)
    else if (a === '--nodes') opts.nodes = clampInt(argv[++i], 200, 1, 2000)
    else if (a === '--ttft-ms') opts.ttftMs = clampNum(argv[++i], 10, 0, 60_000)
    else if (a === '--stream-ms') opts.streamMs = clampNum(argv[++i], 20, 0, 120_000)
    else if (a === '--fault-rate') opts.faultRate = clampNum(argv[++i], 0.02, 0, 1)
    else if (a === '--sock-dir') opts.sockDir = String(argv[++i] || '')
    else if (a === '--ready-file') opts.readyFile = String(argv[++i] || '')
  }
  return opts
}

/** Deterministic, realistic Anthropic token usage derived from request byte size (no JSON parse). */
function synthesizeUsage(bytesIn) {
  if (bytesIn >= 50_000) {
    const approxTokens = Math.max(10_000, Math.round(bytesIn / 4))
    const cacheRead = Math.round(approxTokens * 0.85)
    const cacheCreate = Math.round(approxTokens * 0.05)
    const inputTokens = Math.max(100, approxTokens - cacheRead - cacheCreate)
    return {
      input_tokens: inputTokens,
      cache_creation_input_tokens: cacheCreate,
      cache_read_input_tokens: cacheRead,
      output_tokens: 128,
      cache_creation: {
        ephemeral_5m_input_tokens: cacheCreate,
        ephemeral_1h_input_tokens: 0,
      },
    }
  }
  const inputTokens = Math.max(16, Math.round(bytesIn / 4))
  return {
    input_tokens: inputTokens,
    cache_creation_input_tokens: 8,
    cache_read_input_tokens: 16,
    output_tokens: 48,
    cache_creation: {
      ephemeral_5m_input_tokens: 8,
      ephemeral_1h_input_tokens: 0,
    },
  }
}

function buildRateLimitHeaders(nodeIdx, totalNodes, nowSec) {
  const frac = (nodeIdx % Math.max(1, totalNodes)) / Math.max(1, totalNodes)
  const util5h = (0.08 + frac * 0.42).toFixed(2)
  const util7d = (0.05 + frac * 0.3).toFixed(2)
  const reset5h = String(nowSec + 4 * 3600 + (nodeIdx % 600))
  const reset7d = String(nowSec + 5 * 86400 + (nodeIdx % 3600))
  return {
    'anthropic-ratelimit-unified-5h-utilization': util5h,
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-reset': reset5h,
    'anthropic-ratelimit-unified-7d-utilization': util7d,
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-reset': reset7d,
    'anthropic-ratelimit-requests-remaining': '999',
  }
}

function createStatsBucket() {
  return {
    requests: 0,
    active: 0,
    completed: 0,
    injected429: 0,
    injected502: 0,
    bytesIn: 0,
    bytesOut: 0,
    totalUpstreamMs: 0,
    totalTtftMs: 0,
  }
}

function mergeStatsBuckets(buckets) {
  const out = createStatsBucket()
  for (const b of buckets) {
    if (!b) continue
    out.requests += b.requests || 0
    out.active += b.active || 0
    out.completed += b.completed || 0
    out.injected429 += b.injected429 || 0
    out.injected502 += b.injected502 || 0
    out.bytesIn += b.bytesIn || 0
    out.bytesOut += b.bytesOut || 0
    out.totalUpstreamMs += b.totalUpstreamMs || 0
    out.totalTtftMs += b.totalTtftMs || 0
  }
  return out
}

function readSmallBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= maxBytes) chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Drain an arbitrarily large request body stream without full JSON parsing.
 * Captures only the first 4 KiB to cheaply sniff `"model"` and `"stream":false`.
 */
function drainRequestStream(req) {
  return new Promise((resolve, reject) => {
    let bytesIn = 0
    const headChunks = []
    let headBytes = 0
    const HEAD_LIMIT = 4096

    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytesIn += buf.length
      if (headBytes < HEAD_LIMIT) {
        const take = Math.min(buf.length, HEAD_LIMIT - headBytes)
        headChunks.push(take === buf.length ? buf : buf.subarray(0, take))
        headBytes += take
      }
    })
    req.on('end', () => {
      const head = headChunks.length ? Buffer.concat(headChunks, headBytes).toString('utf8') : ''
      resolve({ bytesIn, head })
    })
    req.on('error', reject)
  })
}

/**
 * Create a self-contained mock upstream HTTP handler + state controller.
 * Used directly by single-process tests and inside every cluster worker.
 */
export function createMockUpstreamController(options = {}) {
  const config = {
    nodes: clampInt(options.nodes, 200, 1, 2000),
    ttftMs: clampNum(options.ttftMs, 10, 0, 60_000),
    streamMs: clampNum(options.streamMs, 20, 0, 120_000),
    faultRate: clampNum(options.faultRate, 0.02, 0, 1),
    workerId: clampInt(options.workerId, 0, 0, 1024),
    workers: clampInt(options.workers, 1, 1, 64),
  }

  let stats = createStatsBucket()
  let seq = 0
  let forcedFaultQueue = Array.isArray(options.forceNextFaults) ? [...options.forceNextFaults] : []

  const getAggregatedStats = typeof options.getAggregatedStats === 'function' ? options.getAggregatedStats : null
  const onGlobalReset = typeof options.onGlobalReset === 'function' ? options.onGlobalReset : null
  const onGlobalConfig = typeof options.onGlobalConfig === 'function' ? options.onGlobalConfig : null

  function localStats() {
    return { ...stats }
  }

  function resetLocal() {
    stats = createStatsBucket()
    forcedFaultQueue = []
  }

  function applyConfigPatch(patch = {}) {
    if (patch.ttftMs != null) config.ttftMs = clampNum(patch.ttftMs, config.ttftMs, 0, 60_000)
    if (patch.streamMs != null) config.streamMs = clampNum(patch.streamMs, config.streamMs, 0, 120_000)
    if (patch.faultRate != null) config.faultRate = clampNum(patch.faultRate, config.faultRate, 0, 1)
    if (patch.nodes != null) config.nodes = clampInt(patch.nodes, config.nodes, 1, 2000)
    if (Array.isArray(patch.forceNextFaults)) {
      forcedFaultQueue = patch.forceNextFaults
        .map((code) => Number(code))
        .filter((code) => code === 429 || code === 502)
    }
    return { ...config }
  }

  function formatPublicStats(bucket) {
    const completed = bucket.completed || 0
    return {
      requests: bucket.requests,
      active: bucket.active,
      completed,
      injected429: bucket.injected429,
      injected502: bucket.injected502,
      bytesIn: bucket.bytesIn,
      bytesOut: bucket.bytesOut,
      workers: config.workers,
      nodes: config.nodes,
      avgUpstreamMs: completed > 0 ? round2(bucket.totalUpstreamMs / completed) : 0,
      avgTtftMs: completed > 0 ? round2(bucket.totalTtftMs / completed) : 0,
      config: {
        ttftMs: config.ttftMs,
        streamMs: config.streamMs,
        faultRate: config.faultRate,
      },
    }
  }

  function decideFault(reqHeaders) {
    const headerForce = Number(reqHeaders['x-mock-force-status'] || 0)
    if (headerForce === 429 || headerForce === 502) return headerForce
    if (forcedFaultQueue.length > 0) return forcedFaultQueue.shift()
    if (!(config.faultRate > 0)) return 0
    const r = Math.random()
    if (r >= config.faultRate) return 0
    return r < config.faultRate * 0.5 ? 429 : 502
  }

  function writeJson(res, status, obj, extraHeaders = {}) {
    const raw = JSON.stringify(obj)
    const byteLen = Buffer.byteLength(raw)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': byteLen,
      ...extraHeaders,
    })
    res.end(raw)
    return byteLen
  }

  async function handleInference(req, res, isInternalKernelPath) {
    const tStart = performance.now()
    const reqNum = ++seq
    const nodeIdx = (config.workerId * 97 + reqNum) % config.nodes
    stats.requests += 1
    stats.active += 1

    let aborted = false
    const onClose = () => {
      aborted = true
    }
    req.once('aborted', onClose)
    res.once('close', onClose)

    try {
      const { bytesIn, head } = await drainRequestStream(req)
      stats.bytesIn += bytesIn
      if (aborted || res.destroyed) return

      const modelMatch = MODEL_SNIFF_RE.exec(head)
      const model = modelMatch ? modelMatch[1] : DEFAULT_MODEL
      const explicitNonStream =
        !isInternalKernelPath &&
        (req.headers['x-mock-stream'] === '0' || (bytesIn < 8192 && STREAM_FALSE_SNIFF_RE.test(head)))

      const ttftTarget = config.ttftMs
      const streamTarget = explicitNonStream ? 0 : config.streamMs
      if (ttftTarget > 0) {
        await sleep(ttftTarget)
        if (aborted || res.destroyed) return
      }

      const nowSec = Math.floor(Date.now() / 1000)
      const ttftActual = round2(performance.now() - tStart)
      const rateHeaders = buildRateLimitHeaders(nodeIdx, config.nodes, nowSec)
      const fault = decideFault(req.headers)

      if (fault === 429) {
        stats.injected429 += 1
        const upstreamMs = round2(performance.now() - tStart)
        const bytesOut = writeJson(
          res,
          429,
          {
            type: 'error',
            error: {
              type: 'rate_limit_error',
              message: 'Rate limit exceeded (per-minute RPM limit, mock injected 429)',
            },
          },
          {
            ...rateHeaders,
            'retry-after': '2',
            'anthropic-ratelimit-requests-remaining': '0',
            'request-id': `req_mock_${config.workerId}_${reqNum}`,
            'x-mock-node-id': `node-${nodeIdx}`,
            'x-mock-ttft-ms': String(ttftActual),
            'x-mock-upstream-ms': String(upstreamMs),
          },
        )
        stats.bytesOut += bytesOut
        stats.totalTtftMs += ttftActual
        stats.totalUpstreamMs += upstreamMs
        stats.completed += 1
        return
      }

      if (fault === 502) {
        stats.injected502 += 1
        const upstreamMs = round2(performance.now() - tStart)
        const bytesOut = writeJson(
          res,
          502,
          {
            type: 'error',
            error: {
              type: 'api_error',
              code: 'upstream_overloaded',
              message: 'Upstream bad gateway (mock injected 502)',
            },
          },
          {
            'request-id': `req_mock_${config.workerId}_${reqNum}`,
            'x-mock-node-id': `node-${nodeIdx}`,
            'x-mock-ttft-ms': String(ttftActual),
            'x-mock-upstream-ms': String(upstreamMs),
          },
        )
        stats.bytesOut += bytesOut
        stats.totalTtftMs += ttftActual
        stats.totalUpstreamMs += upstreamMs
        stats.completed += 1
        return
      }

      const usage = synthesizeUsage(bytesIn)
      const msgId = `msg_mock_${config.workerId}_${reqNum}`
      const requestId = `req_mock_${config.workerId}_${reqNum}`

      if (explicitNonStream) {
        const upstreamMs = round2(performance.now() - tStart)
        const payload = {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: DEFAULT_TEXT_CHUNKS.join('') }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage,
        }
        const bytesOut = writeJson(res, 200, payload, {
          ...rateHeaders,
          'request-id': requestId,
          'x-mock-node-id': `node-${nodeIdx}`,
          'x-mock-ttft-ms': String(ttftActual),
          'x-mock-upstream-ms': String(upstreamMs),
        })
        stats.bytesOut += bytesOut
        stats.totalTtftMs += ttftActual
        stats.totalUpstreamMs += upstreamMs
        stats.completed += 1
        return
      }

      // Streaming Anthropic SSE response (used by both /internal/v1/messages and /v1/messages)
      const advertisedTotalMs = round2(ttftActual + streamTarget)
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        ...rateHeaders,
        'request-id': requestId,
        'x-mock-node-id': `node-${nodeIdx}`,
        'x-mock-ttft-ms': String(ttftActual),
        'x-mock-upstream-ms': String(advertisedTotalMs),
      })

      let bytesOut = 0
      const sendFrame = (event, dataObj) => {
        if (aborted || res.destroyed || res.writableEnded) return false
        const frame = `event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`
        bytesOut += Buffer.byteLength(frame)
        res.write(frame)
        return true
      }

      const okStart =
        sendFrame('message_start', {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: usage.input_tokens,
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens,
              output_tokens: 1,
            },
          },
        }) &&
        sendFrame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })

      if (!okStart) return

      const chunkGap = streamTarget > 0 ? streamTarget / DEFAULT_TEXT_CHUNKS.length : 0
      for (let i = 0; i < DEFAULT_TEXT_CHUNKS.length; i += 1) {
        if (i > 0 && chunkGap > 0) {
          await sleep(chunkGap)
          if (aborted || res.destroyed) return
        }
        if (
          !sendFrame('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: DEFAULT_TEXT_CHUNKS[i] },
          })
        ) {
          return
        }
      }

      if (chunkGap > 0) {
        await sleep(chunkGap)
        if (aborted || res.destroyed) return
      }

      sendFrame('content_block_stop', { type: 'content_block_stop', index: 0 })
      sendFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage,
      })
      sendFrame('message_stop', { type: 'message_stop' })

      if (!res.writableEnded && !res.destroyed) res.end()

      const finalUpstreamMs = round2(performance.now() - tStart)
      stats.bytesOut += bytesOut
      stats.totalTtftMs += ttftActual
      stats.totalUpstreamMs += finalUpstreamMs
      stats.completed += 1
    } catch {
      if (!res.headersSent && !res.destroyed) {
        try {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end('{"type":"error","error":{"type":"api_error","message":"mock internal error"}}')
        } catch {}
      } else if (!res.writableEnded && !res.destroyed) {
        try {
          res.end()
        } catch {}
      }
    } finally {
      req.off('aborted', onClose)
      res.off('close', onClose)
      stats.active = Math.max(0, stats.active - 1)
    }
  }

  async function handler(req, res) {
    const pathname = String(req.url || '/').split('?', 1)[0]

    if (req.method === 'GET' && pathname === '/internal/health') {
      writeJson(res, 200, {
        ok: true,
        status: 200,
        ready: true,
        healthy: true,
        ready_slots: 20,
        active: stats.active,
        engine: 'rust',
        worker_version: 'mock-upstream-1.0',
        credential: {
          has_access: true,
          has_refresh: true,
          generation: 1,
          needs_refresh: false,
          expires_at: Math.floor(Date.now() / 1000) + 30 * 86400,
        },
      })
      return
    }

    if (req.method === 'POST' && pathname === '/internal/v1/cancel') {
      req.resume()
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'GET' && pathname === '/health') {
      writeJson(res, 200, { ok: true, workerId: config.workerId, workers: config.workers })
      return
    }

    if (req.method === 'GET' && pathname === '/__stats') {
      const bucket = getAggregatedStats ? await getAggregatedStats() : localStats()
      writeJson(res, 200, formatPublicStats(bucket))
      return
    }

    if (req.method === 'POST' && pathname === '/__reset') {
      req.resume()
      if (onGlobalReset) await onGlobalReset()
      else resetLocal()
      writeJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && pathname === '/__config') {
      const raw = await readSmallBody(req)
      let patch = {}
      try {
        patch = raw ? JSON.parse(raw) : {}
      } catch {
        writeJson(res, 400, { ok: false, error: 'invalid_json' })
        return
      }
      const next = onGlobalConfig ? await onGlobalConfig(patch) : applyConfigPatch(patch)
      writeJson(res, 200, { ok: true, config: next })
      return
    }

    if (req.method === 'POST' && pathname === '/internal/v1/messages') {
      await handleInference(req, res, true)
      return
    }

    if (req.method === 'POST' && (pathname === '/v1/messages' || pathname === '/messages')) {
      await handleInference(req, res, false)
      return
    }

    req.resume()
    writeJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `unknown path ${pathname}` } })
  }

  return {
    config,
    handler,
    localStats,
    resetLocal,
    applyConfigPatch,
    formatPublicStats,
  }
}

function tuneHttpServer(server) {
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 70_000
  server.requestTimeout = 0
  server.maxRequestsPerSocket = 0
  return server
}

function listenServer(server, listenArg) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    const onListening = () => {
      server.off('error', reject)
      resolve(server.address())
    }
    if (typeof listenArg === 'string') {
      server.listen(listenArg, onListening)
    } else {
      server.listen(listenArg.port, listenArg.host, onListening)
    }
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve()
    try {
      server.closeAllConnections?.()
      server.close(() => resolve())
    } catch {
      resolve()
    }
  })
}

/**
 * Start a single-process mock upstream server (TCP + optional Unix domain socket).
 * For multi-worker cluster execution, launch this file as a CLI process with `--workers N`.
 */
export async function startMockUpstream(options = {}) {
  const host = options.host || '127.0.0.1'
  const port = options.port ?? 0
  const sockPath = options.socketPath || (options.sockDir ? path.join(options.sockDir, 'mock-w0.sock') : '')

  const ctrl = createMockUpstreamController({ ...options, workers: 1, workerId: 0 })
  const tcpServer = tuneHttpServer(http.createServer((req, res) => void ctrl.handler(req, res)))
  const addr = await listenServer(tcpServer, { host, port })
  const boundPort = typeof addr === 'object' && addr ? addr.port : port

  let udsServer = null
  const socketPaths = []
  if (sockPath) {
    fs.mkdirSync(path.dirname(sockPath), { recursive: true })
    try {
      fs.rmSync(sockPath, { force: true })
    } catch {}
    udsServer = tuneHttpServer(http.createServer((req, res) => void ctrl.handler(req, res)))
    await listenServer(udsServer, sockPath)
    socketPaths.push(sockPath)
  }

  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    socketPaths,
    workers: 1,
    pid: process.pid,
    stats: () => ctrl.formatPublicStats(ctrl.localStats()),
    resetStats: () => ctrl.resetLocal(),
    setConfig: (patch) => ctrl.applyConfigPatch(patch),
    async close() {
      await Promise.all([closeServer(tcpServer), closeServer(udsServer)])
      for (const s of socketPaths) {
        try {
          fs.rmSync(s, { force: true })
        } catch {}
      }
    },
  }
}

async function runCli() {
  const opts = parseMockArgs(process.argv.slice(2))

  // Single-worker fast path (no cluster fork needed)
  if (opts.workers <= 1) {
    const handle = await startMockUpstream({
      host: opts.host,
      port: opts.port,
      nodes: opts.nodes,
      ttftMs: opts.ttftMs,
      streamMs: opts.streamMs,
      faultRate: opts.faultRate,
      sockDir: opts.sockDir,
    })
    const info = {
      ok: true,
      url: handle.url,
      host: handle.host,
      port: handle.port,
      workers: 1,
      nodes: opts.nodes,
      socketPaths: handle.socketPaths,
      pid: process.pid,
    }
    if (opts.readyFile) {
      fs.mkdirSync(path.dirname(opts.readyFile), { recursive: true })
      fs.writeFileSync(opts.readyFile, JSON.stringify(info, null, 2))
    }
    console.log(JSON.stringify({ event: 'mock-upstream-ready', ...info }))
    const shutdown = async () => {
      await handle.close()
      process.exit(0)
    }
    process.once('SIGTERM', () => void shutdown())
    process.once('SIGINT', () => void shutdown())
    return
  }

  // Multi-worker cluster mode
  if (cluster.isPrimary) {
    if (opts.sockDir) {
      fs.mkdirSync(opts.sockDir, { recursive: true })
    }
    const expectedSockets = opts.sockDir
      ? Array.from({ length: opts.workers }, (_, i) => path.join(opts.sockDir, `mock-w${i}.sock`))
      : []

    let reqSeq = 0
    const pendingAgg = new Map() // aggId -> { resolve, replies: Map<wid, data>, timer, expected }
    const readyWorkers = new Map()
    let boundPort = opts.port
    let announced = false

    const liveWorkers = () => Object.values(cluster.workers || {}).filter((w) => w && !w.isDead())

    function broadcastAndGather(kind, payload = {}) {
      const workers = liveWorkers()
      if (!workers.length) return Promise.resolve([])
      const aggId = ++reqSeq
      return new Promise((resolve) => {
        const entry = {
          resolve,
          replies: [],
          expected: workers.length,
          timer: setTimeout(() => {
            pendingAgg.delete(aggId)
            resolve(entry.replies)
          }, 1500),
        }
        entry.timer.unref?.()
        pendingAgg.set(aggId, entry)
        for (const w of workers) {
          try {
            w.send({ type: kind, aggId, payload })
          } catch {
            entry.expected -= 1
          }
        }
        if (entry.expected <= 0) {
          clearTimeout(entry.timer)
          pendingAgg.delete(aggId)
          resolve([])
        }
      })
    }

    function attachWorker(worker, workerIdx) {
      worker.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return
        if (msg.type === 'worker_ready') {
          if (msg.port) boundPort = msg.port
          readyWorkers.set(workerIdx, msg)
          if (!announced && readyWorkers.size >= opts.workers) {
            announced = true
            const info = {
              ok: true,
              url: `http://${opts.host}:${boundPort}`,
              host: opts.host,
              port: boundPort,
              workers: opts.workers,
              nodes: opts.nodes,
              socketPaths: expectedSockets,
              pid: process.pid,
            }
            if (opts.readyFile) {
              fs.mkdirSync(path.dirname(opts.readyFile), { recursive: true })
              fs.writeFileSync(opts.readyFile, JSON.stringify(info, null, 2))
            }
            console.log(JSON.stringify({ event: 'mock-upstream-ready', ...info }))
          }
          return
        }
        if (msg.type === 'agg_reply') {
          const entry = pendingAgg.get(msg.aggId)
          if (!entry) return
          entry.replies.push(msg.data)
          if (entry.replies.length >= entry.expected) {
            clearTimeout(entry.timer)
            pendingAgg.delete(msg.aggId)
            entry.resolve(entry.replies)
          }
          return
        }
        if (msg.type === 'stats_req') {
          void broadcastAndGather('collect_stats').then((buckets) => {
            try {
              worker.send({ type: 'stats_res', id: msg.id, data: mergeStatsBuckets(buckets) })
            } catch {}
          })
          return
        }
        if (msg.type === 'reset_req') {
          void broadcastAndGather('do_reset').then(() => {
            try {
              worker.send({ type: 'reset_res', id: msg.id })
            } catch {}
          })
          return
        }
        if (msg.type === 'config_req') {
          const patch = msg.patch || {}
          // Split forceNextFaults so deterministic forced faults trigger exact total count across workers.
          const workers = liveWorkers()
          const forceList = Array.isArray(patch.forceNextFaults) ? patch.forceNextFaults : null
          const basePatch = { ...patch }
          delete basePatch.forceNextFaults
          const aggId = ++reqSeq
          const promises = workers.map((w, idx) => {
            const perWorkerPatch =
              forceList && idx === 0
                ? { ...basePatch, forceNextFaults: forceList }
                : forceList
                  ? { ...basePatch, forceNextFaults: [] }
                  : basePatch
            return new Promise((resolve) => {
              const subId = `${aggId}:${idx}`
              const timer = setTimeout(() => {
                pendingAgg.delete(subId)
                resolve(null)
              }, 1500)
              timer.unref?.()
              pendingAgg.set(subId, { resolve: (r) => resolve(r[0] || null), replies: [], expected: 1, timer })
              try {
                w.send({ type: 'do_config', aggId: subId, payload: perWorkerPatch })
              } catch {
                clearTimeout(timer)
                pendingAgg.delete(subId)
                resolve(null)
              }
            })
          })
          void Promise.all(promises).then((cfgs) => {
            try {
              worker.send({ type: 'config_res', id: msg.id, data: cfgs.find(Boolean) || basePatch })
            } catch {}
          })
        }
      })
    }

    for (let i = 0; i < opts.workers; i += 1) {
      const sockPath = expectedSockets[i] || ''
      const w = cluster.fork({
        MOCK_WORKER_IDX: String(i),
        MOCK_WORKER_SOCK: sockPath,
      })
      attachWorker(w, i)
    }

    let shuttingDown = false
    const shutdown = () => {
      if (shuttingDown) return
      shuttingDown = true
      for (const w of liveWorkers()) {
        try {
          w.kill('SIGTERM')
        } catch {}
      }
      for (const s of expectedSockets) {
        try {
          fs.rmSync(s, { force: true })
        } catch {}
      }
      setTimeout(() => process.exit(0), 150).unref?.()
    }
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
    return
  }

  // Cluster worker
  const workerIdx = clampInt(process.env.MOCK_WORKER_IDX, 0, 0, 1024)
  const sockPath = String(process.env.MOCK_WORKER_SOCK || '')
  let ipcSeq = 0
  const ipcWaiters = new Map()

  function askPrimary(type, extra = {}) {
    const id = ++ipcSeq
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ipcWaiters.delete(id)
        resolve(null)
      }, 2000)
      timer.unref?.()
      ipcWaiters.set(id, { resolve, timer })
      process.send({ type, id, ...extra })
    })
  }

  const ctrl = createMockUpstreamController({
    nodes: opts.nodes,
    ttftMs: opts.ttftMs,
    streamMs: opts.streamMs,
    faultRate: opts.faultRate,
    workerId: workerIdx,
    workers: opts.workers,
    getAggregatedStats: async () => (await askPrimary('stats_req')) || ctrl.localStats(),
    onGlobalReset: async () => {
      await askPrimary('reset_req')
    },
    onGlobalConfig: async (patch) => (await askPrimary('config_req', { patch })) || ctrl.applyConfigPatch(patch),
  })

  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'collect_stats') {
      process.send({ type: 'agg_reply', aggId: msg.aggId, data: ctrl.localStats() })
      return
    }
    if (msg.type === 'do_reset') {
      ctrl.resetLocal()
      process.send({ type: 'agg_reply', aggId: msg.aggId, data: { ok: true } })
      return
    }
    if (msg.type === 'do_config') {
      const next = ctrl.applyConfigPatch(msg.payload)
      process.send({ type: 'agg_reply', aggId: msg.aggId, data: next })
      return
    }
    if (msg.type === 'stats_res' || msg.type === 'reset_res' || msg.type === 'config_res') {
      const w = ipcWaiters.get(msg.id)
      if (!w) return
      clearTimeout(w.timer)
      ipcWaiters.delete(msg.id)
      w.resolve(msg.data)
    }
  })

  const tcpServer = tuneHttpServer(http.createServer((req, res) => void ctrl.handler(req, res)))
  const addr = await listenServer(tcpServer, { host: opts.host, port: opts.port })
  const boundPort = typeof addr === 'object' && addr ? addr.port : opts.port

  let udsServer = null
  if (sockPath) {
    fs.mkdirSync(path.dirname(sockPath), { recursive: true })
    try {
      fs.rmSync(sockPath, { force: true })
    } catch {}
    udsServer = tuneHttpServer(http.createServer((req, res) => void ctrl.handler(req, res)))
    await listenServer(udsServer, sockPath)
  }

  process.send({ type: 'worker_ready', workerIdx, port: boundPort, sockPath })

  const shutdown = async () => {
    await Promise.all([closeServer(tcpServer), closeServer(udsServer)])
    if (sockPath) {
      try {
        fs.rmSync(sockPath, { force: true })
      } catch {}
    }
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown())
  process.once('SIGINT', () => void shutdown())
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  runCli().catch((err) => {
    console.error('[mock-upstream] fatal:', err)
    process.exit(1)
  })
}
