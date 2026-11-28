#!/usr/bin/env node
/**
 * Open-loop constant-rate 20K RPM load generator + concurrent panel read/write load runner.
 *
 * Design goals:
 * - Zero Coordinated Omission: dispatches strictly on a monotonic performance.now() schedule
 *   independent of downstream response latency (only enforcing a safety max-inflight breaker
 *   that marks `saturated: true` without stalling the pacing clock).
 * - Zero hot-path JSON serialization: pre-encodes corpus-100k.jsonl bodies into Buffers once at
 *   startup and rotates API keys / multi-turn session chains purely via HTTP headers.
 * - Optional worker_threads fan-out so 20K RPM x 400 KB (~133 MB/s) never bottlenecks one loop.
 * - Exact upstream latency stripping (`overheadMs = max(0, totalMs - x-mock-upstream-ms)`).
 * - Concurrent admin + tenant panel read/write polling with per-endpoint latency histograms.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

const DEFAULT_TARGET_RPM = 600
const DEFAULT_DURATION_SEC = 20
const DEFAULT_MAX_INFLIGHT = 12_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_DRAIN_GRACE_MS = 30_000
const DEFAULT_PANEL_POLLERS = 20
const DEFAULT_PANEL_MIN_INTERVAL_MS = 3_000
const DEFAULT_PANEL_MAX_INTERVAL_MS = 5_000
const DEFAULT_PANEL_TIMEOUT_MS = 15_000

const ADMIN_PANEL_READS = [
  { name: 'usage-logs', method: 'GET', path: '/api/panel/usage-logs?limit=50' },
  { name: 'dashboard', method: 'GET', path: '/api/panel/dashboard' },
  { name: 'active-sessions', method: 'GET', path: '/api/panel/usage-logs/active-sessions' },
  { name: 'statistics', method: 'GET', path: '/api/panel/statistics?range=today&dimension=model' },
  { name: 'usage-logs-overview', method: 'GET', path: '/api/panel/usage-logs/overview' },
]

const TENANT_PANEL_READS = [
  { name: 'usage-logs', method: 'GET', path: '/api/panel/usage-logs?limit=50' },
  { name: 'active-sessions', method: 'GET', path: '/api/panel/usage-logs/active-sessions' },
  { name: 'statistics', method: 'GET', path: '/api/panel/statistics?range=today&dimension=model' },
  { name: 'usage-logs-overview', method: 'GET', path: '/api/panel/usage-logs/overview' },
]

const DEFAULT_ADMIN_WRITES = [
  { name: 'dashboard-refresh', method: 'GET', path: '/api/panel/dashboard?refresh=1' },
  {
    name: 'backups-config-write',
    method: 'PUT',
    path: '/api/panel/backups/config',
    body: Buffer.from(JSON.stringify({ enabled: false }), 'utf8'),
  },
]

const DEFAULT_TENANT_WRITES = [
  { name: 'overview-refresh', method: 'GET', path: '/api/panel/usage-logs/overview?refresh=1' },
]

function fnv1a32(str) {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function roundMs(val) {
  return Math.round(val * 1000) / 1000
}

/**
 * Compute exact summary statistics (count, min, p50, p95, p99, max, mean) from numeric samples.
 */
export function computeLatencyStats(samples) {
  const n = samples ? samples.length : 0
  if (n === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 }
  }
  const arr = Float64Array.from(samples)
  arr.sort()
  let sum = 0
  for (let i = 0; i < n; i++) sum += arr[i]
  const pct = (p) => {
    const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))
    return roundMs(arr[idx])
  }
  return {
    count: n,
    min: roundMs(arr[0]),
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    max: roundMs(arr[n - 1]),
    mean: roundMs(sum / n),
  }
}

/**
 * Load corpus-100k.jsonl and pre-encode every request body into a reusable UTF-8 Buffer
 * so hot-path dispatch performs zero JSON.stringify calls.
 */
export async function loadCorpusTemplates(corpusPath, { maxTemplates = 0 } = {}) {
  const resolved = path.resolve(corpusPath)
  const stream = fs.createReadStream(resolved, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const templates = []
  let lineNo = 0
  for await (const rawLine of rl) {
    lineNo++
    const line = rawLine.trim()
    if (!line) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch (err) {
      throw new Error(`Invalid JSON at ${resolved}:${lineNo}: ${err.message}`)
    }
    const bodyBuf = Buffer.isBuffer(rec.body)
      ? rec.body
      : typeof rec.body === 'string'
        ? Buffer.from(rec.body, 'utf8')
        : Buffer.from(JSON.stringify(rec.body ?? {}), 'utf8')
    templates.push({
      id: String(rec.id || `rec-${String(templates.length + 1).padStart(4, '0')}`),
      sessionKey: String(rec.session_key || rec.sessionKey || `sess-${templates.length + 1}`),
      turnIndex: Number(rec.turn_index ?? rec.turnIndex ?? 0),
      approxTokens: Number(rec.approx_tokens ?? rec.approxTokens ?? 0),
      bodyBytes: bodyBuf.length,
      model: String(rec.model || rec.body?.model || 'claude-sonnet-4-5-20250929'),
      stream: Boolean(rec.stream ?? rec.body?.stream ?? true),
      expectedUsage: rec.expected_usage || rec.expectedUsage || null,
      bodyBuffer: bodyBuf,
      contentLengthStr: String(bodyBuf.length),
    })
    if (maxTemplates > 0 && templates.length >= maxTemplates) break
  }
  if (templates.length === 0) {
    throw new Error(`Corpus file has no records: ${resolved}`)
  }
  return templates
}

function normalizeTemplates(templates) {
  return templates.map((t, idx) => {
    const bodyBuf = Buffer.isBuffer(t.bodyBuffer)
      ? t.bodyBuffer
      : t.bodyBuffer instanceof Uint8Array
        ? Buffer.from(t.bodyBuffer.buffer, t.bodyBuffer.byteOffset, t.bodyBuffer.byteLength)
        : Buffer.from(JSON.stringify(t.body ?? {}), 'utf8')
    return {
      id: String(t.id || `rec-${idx + 1}`),
      sessionKey: String(t.sessionKey || t.session_key || `sess-${idx + 1}`),
      turnIndex: Number(t.turnIndex ?? t.turn_index ?? 0),
      approxTokens: Number(t.approxTokens ?? t.approx_tokens ?? 0),
      bodyBytes: bodyBuf.length,
      model: String(t.model || 'claude-sonnet-4-5-20250929'),
      stream: Boolean(t.stream ?? true),
      expectedUsage: t.expectedUsage || t.expected_usage || null,
      bodyBuffer: bodyBuf,
      contentLengthStr: String(bodyBuf.length),
    }
  })
}

function parseEndpointTargets(sutUrls, proxyPath = '/v1/messages') {
  const urls = (Array.isArray(sutUrls) ? sutUrls : [sutUrls]).filter(Boolean)
  if (urls.length === 0) throw new Error('At least one sutUrl is required')
  return urls.map((raw) => {
    const u = new URL(proxyPath, raw)
    const isHttps = u.protocol === 'https:'
    return {
      baseUrl: new URL('/', raw).toString().replace(/\/$/, ''),
      protocol: u.protocol,
      isHttps,
      hostname: u.hostname,
      port: u.port ? Number(u.port) : isHttps ? 443 : 80,
      path: `${u.pathname}${u.search}`,
    }
  })
}

function createAgentPool(targets) {
  const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: Infinity,
    maxFreeSockets: 256,
  })
  const httpsAgent = targets.some((t) => t.isHttps)
    ? new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 30_000,
        maxSockets: Infinity,
        maxFreeSockets: 256,
      })
    : null
  return {
    httpAgent,
    httpsAgent,
    destroy() {
      httpAgent.destroy()
      httpsAgent?.destroy()
    },
  }
}

function parseNumericHeader(raw) {
  if (raw == null) return NaN
  const val = Array.isArray(raw) ? raw[0] : raw
  const n = Number(val)
  return Number.isFinite(n) ? n : NaN
}

function isInjectedFaultHeader(headers) {
  const v = headers['x-mock-injected-fault']
  if (v == null) return false
  const s = String(Array.isArray(v) ? v[0] : v)
    .trim()
    .toLowerCase()
  return s !== '' && s !== '0' && s !== 'false'
}

/**
 * Execute one open-loop proxy load generator engine (runs inside main thread or worker_thread).
 */
async function executeProxyEngine({
  templates,
  sutUrls,
  apiKeys,
  proxyPath = '/v1/messages',
  targetRpm = DEFAULT_TARGET_RPM,
  durationSec = DEFAULT_DURATION_SEC,
  maxInflight = DEFAULT_MAX_INFLIGHT,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  drainGraceMs = DEFAULT_DRAIN_GRACE_MS,
  routing = 'sticky',
  runId = crypto.randomBytes(4).toString('hex'),
  workerId = 0,
  extraHeaders = {},
}) {
  const normTemplates = normalizeTemplates(templates)
  const targets = parseEndpointTargets(sutUrls, proxyPath)
  const agents = createAgentPool(targets)
  const keys = (Array.isArray(apiKeys) ? apiKeys : [])
    .map((k) => (typeof k === 'string' ? { id: k, key: k } : k))
    .filter((k) => k?.key)
  if (keys.length === 0) {
    agents.destroy()
    throw new Error('At least one API key is required for proxy load generation')
  }

  const ratePerSec = targetRpm / 60
  if (!Number.isFinite(ratePerSec) || ratePerSec <= 0) {
    agents.destroy()
    throw new Error(`targetRpm must be > 0, got ${targetRpm}`)
  }
  const intervalMs = 1000 / ratePerSec
  const durationMs = Math.max(50, durationSec * 1000)

  const totalSamples = []
  const ttftSamples = []
  const overheadSamples = []
  const ttftOverheadSamples = []
  const statusCounts = {}
  const errorCodes = {}

  let scheduledCount = 0
  let dispatchedCount = 0
  let completedCount = 0
  let ok2xxCount = 0
  let client4xxCount = 0
  let server5xxCount = 0
  let transportErrors = 0
  let injectedFaultHeaderCount = 0
  let saturatedDrops = 0
  let saturated = false
  let inflight = 0
  let peakInflight = 0
  let bytesOut = 0
  let bytesIn = 0
  let maxScheduleLagMs = 0

  const activeRequests = new Set()
  let dispatchFinished = false
  let resolveDrain = null
  const drainPromise = new Promise((resolve) => {
    resolveDrain = resolve
  })

  function maybeFinishDrain() {
    if (dispatchFinished && inflight === 0 && resolveDrain) {
      const done = resolveDrain
      resolveDrain = null
      done()
    }
  }

  function incMap(map, key) {
    map[key] = (map[key] || 0) + 1
  }

  function dispatchOne(seq) {
    const templateCount = normTemplates.length
    const cycle = Math.floor(seq / templateCount)
    const tmpl = normTemplates[seq % templateCount]
    const sessionId = `bench-${runId}-w${workerId}-c${cycle}-${tmpl.sessionKey}`
    const sessionHash = fnv1a32(sessionId)
    const keyEntry = keys[sessionHash % keys.length]
    const target = routing === 'round-robin' ? targets[seq % targets.length] : targets[sessionHash % targets.length]
    const requestId = `bench-${runId}-w${workerId}-${seq}`

    const headers = {
      'content-type': 'application/json',
      'content-length': tmpl.contentLengthStr,
      'anthropic-version': '2023-06-01',
      'x-api-key': keyEntry.key,
      'x-session-id': sessionId,
      'x-request-id': requestId,
      'x-bench-corpus-id': tmpl.id,
      ...extraHeaders,
    }

    inflight++
    if (inflight > peakInflight) peakInflight = inflight
    dispatchedCount++
    bytesOut += tmpl.bodyBytes

    const sendStart = performance.now()
    const client = target.isHttps ? https : http
    let settled = false

    const req = client.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        method: 'POST',
        headers,
        agent: target.isHttps ? agents.httpsAgent : agents.httpAgent,
      },
      (res) => {
        const headersMs = performance.now() - sendStart
        let ttftMs = null
        const status = res.statusCode || 0
        const mockUpstreamMs = parseNumericHeader(res.headers['x-mock-upstream-ms'])
        const mockTtftMs = parseNumericHeader(res.headers['x-mock-ttft-ms'])
        const injectedFault = isInjectedFaultHeader(res.headers)

        res.on('data', (chunk) => {
          if (ttftMs === null) {
            ttftMs = performance.now() - sendStart
          }
          bytesIn += chunk.length
        })

        res.on('end', () => {
          if (settled) return
          settled = true
          activeRequests.delete(req)
          inflight--
          completedCount++

          const totalMs = performance.now() - sendStart
          const effectiveTtft = ttftMs === null ? headersMs : ttftMs
          totalSamples.push(totalMs)
          ttftSamples.push(effectiveTtft)
          if (Number.isFinite(mockUpstreamMs)) {
            overheadSamples.push(Math.max(0, totalMs - mockUpstreamMs))
          }
          if (Number.isFinite(mockTtftMs)) {
            ttftOverheadSamples.push(Math.max(0, effectiveTtft - mockTtftMs))
          }

          incMap(statusCounts, String(status))
          if (status >= 200 && status < 300) ok2xxCount++
          else if (status >= 400 && status < 500) client4xxCount++
          else if (status >= 500) server5xxCount++
          if (injectedFault) injectedFaultHeaderCount++

          maybeFinishDrain()
        })

        res.on('error', (err) => {
          if (settled) return
          settled = true
          activeRequests.delete(req)
          inflight--
          completedCount++
          transportErrors++
          incMap(statusCounts, '0')
          incMap(errorCodes, err?.code || 'RES_ERROR')
          maybeFinishDrain()
        })
      },
    )

    activeRequests.add(req)

    req.setTimeout(requestTimeoutMs, () => {
      const err = new Error(`Request timeout after ${requestTimeoutMs}ms`)
      err.code = 'ETIMEDOUT'
      req.destroy(err)
    })

    req.on('error', (err) => {
      if (settled) return
      settled = true
      activeRequests.delete(req)
      inflight--
      completedCount++
      transportErrors++
      incMap(statusCounts, '0')
      incMap(errorCodes, err?.code || 'REQ_ERROR')
      maybeFinishDrain()
    })

    req.end(tmpl.bodyBuffer)
  }

  const startWallIso = new Date().toISOString()
  const startPerf = performance.now()
  const endPerf = startPerf + durationMs
  let nextSeq = 0

  await new Promise((resolveSchedule) => {
    const tick = () => {
      const now = performance.now()
      while (true) {
        const dueAt = startPerf + nextSeq * intervalMs
        if (dueAt >= endPerf) {
          resolveSchedule()
          return
        }
        if (dueAt > now) break

        const lag = now - dueAt
        if (lag > maxScheduleLagMs) maxScheduleLagMs = lag

        scheduledCount++
        const seq = nextSeq++
        if (inflight >= maxInflight) {
          saturated = true
          saturatedDrops++
          continue
        }
        dispatchOne(seq)
      }

      const nextDue = startPerf + nextSeq * intervalMs
      const remaining = Math.min(nextDue, endPerf) - performance.now()
      if (remaining <= 1.5) {
        setImmediate(tick)
      } else {
        setTimeout(tick, Math.min(remaining - 0.5, 25))
      }
    }
    tick()
  })

  const dispatchEndPerf = performance.now()
  dispatchFinished = true
  maybeFinishDrain()

  // Wait for inflight requests with a bounded drain timeout
  let timedOutInflight = 0
  if (inflight > 0) {
    let graceTimer = null
    await Promise.race([
      drainPromise,
      new Promise((resolve) => {
        graceTimer = setTimeout(() => {
          timedOutInflight = activeRequests.size
          for (const req of activeRequests) {
            const err = new Error(`Drain grace timeout (${drainGraceMs}ms)`)
            err.code = 'EDRAINTIMEOUT'
            req.destroy(err)
          }
          resolve()
        }, drainGraceMs)
      }),
    ])
    if (graceTimer) clearTimeout(graceTimer)
  }

  const endPerfActual = performance.now()
  const endWallIso = new Date().toISOString()
  agents.destroy()

  return {
    startWallIso,
    endWallIso,
    dispatchDurationSec: Math.max(0.001, (dispatchEndPerf - startPerf) / 1000),
    totalDurationSec: Math.max(0.001, (endPerfActual - startPerf) / 1000),
    scheduledCount,
    dispatchedCount,
    completedCount,
    ok2xxCount,
    client4xxCount,
    server5xxCount,
    transportErrors,
    injectedFaultHeaderCount,
    saturated,
    saturatedDrops,
    peakInflight,
    timedOutInflight,
    bytesOut,
    bytesIn,
    maxScheduleLagMs: roundMs(maxScheduleLagMs),
    statusCounts,
    errorCodes,
    totalSamples: Float64Array.from(totalSamples),
    ttftSamples: Float64Array.from(ttftSamples),
    overheadSamples: Float64Array.from(overheadSamples),
    ttftOverheadSamples: Float64Array.from(ttftOverheadSamples),
  }
}

function concatFloat64(arrays) {
  let total = 0
  for (const a of arrays) total += a.length
  const out = new Float64Array(total)
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}

function mergeCountMaps(maps) {
  const out = {}
  for (const m of maps) {
    if (!m) continue
    for (const [k, v] of Object.entries(m)) {
      out[k] = (out[k] || 0) + v
    }
  }
  return out
}

function summarizeWorkerResults(results, { targetRpm, durationSec, maxInflight, workers }) {
  const dispatchDurationSec = Math.max(0.001, ...results.map((r) => r.dispatchDurationSec))
  const totalDurationSec = Math.max(0.001, ...results.map((r) => r.totalDurationSec))
  const scheduledCount = results.reduce((s, r) => s + r.scheduledCount, 0)
  const dispatchedCount = results.reduce((s, r) => s + r.dispatchedCount, 0)
  const completedCount = results.reduce((s, r) => s + r.completedCount, 0)
  const ok2xxCount = results.reduce((s, r) => s + r.ok2xxCount, 0)
  const client4xxCount = results.reduce((s, r) => s + r.client4xxCount, 0)
  const server5xxCount = results.reduce((s, r) => s + r.server5xxCount, 0)
  const transportErrors = results.reduce((s, r) => s + r.transportErrors, 0)
  const injectedFaultHeaderCount = results.reduce((s, r) => s + r.injectedFaultHeaderCount, 0)
  const saturated = results.some((r) => r.saturated)
  const saturatedDrops = results.reduce((s, r) => s + r.saturatedDrops, 0)
  const peakInflight = results.reduce((s, r) => s + r.peakInflight, 0)
  const timedOutInflight = results.reduce((s, r) => s + r.timedOutInflight, 0)
  const bytesOut = results.reduce((s, r) => s + r.bytesOut, 0)
  const bytesIn = results.reduce((s, r) => s + r.bytesIn, 0)
  const maxScheduleLagMs = Math.max(...results.map((r) => r.maxScheduleLagMs))

  const statusCounts = mergeCountMaps(results.map((r) => r.statusCounts))
  const errorCodes = mergeCountMaps(results.map((r) => r.errorCodes))
  const totalSamples = concatFloat64(results.map((r) => r.totalSamples))
  const ttftSamples = concatFloat64(results.map((r) => r.ttftSamples))
  const overheadSamples = concatFloat64(results.map((r) => r.overheadSamples))
  const ttftOverheadSamples = concatFloat64(results.map((r) => r.ttftOverheadSamples))

  const non2xxCount = Math.max(0, completedCount - ok2xxCount)
  const nonInjectedErrors = Math.max(0, non2xxCount - injectedFaultHeaderCount)
  const nonInjectedErrorRate = completedCount > 0 ? nonInjectedErrors / completedCount : 0
  const achievedRpm = roundMs((completedCount / totalDurationSec) * 60)
  const dispatchedRpm = roundMs((dispatchedCount / dispatchDurationSec) * 60)
  const throughputOutMBps = roundMs(bytesOut / (1024 * 1024) / totalDurationSec)
  const throughputInMBps = roundMs(bytesIn / (1024 * 1024) / totalDurationSec)

  return {
    startWallIso: results[0]?.startWallIso || new Date().toISOString(),
    endWallIso: results[results.length - 1]?.endWallIso || new Date().toISOString(),
    targetRpm,
    durationSec,
    maxInflight,
    workers,
    dispatchDurationSec: roundMs(dispatchDurationSec),
    totalDurationSec: roundMs(totalDurationSec),
    scheduledCount,
    dispatchedCount,
    completedCount,
    ok2xxCount,
    client4xxCount,
    server5xxCount,
    transportErrors,
    injectedFaultHeaderCount,
    nonInjectedErrors,
    nonInjectedErrorRate: Number(nonInjectedErrorRate.toFixed(6)),
    achievedRpm,
    dispatchedRpm,
    achievedRatio: targetRpm > 0 ? Number((achievedRpm / targetRpm).toFixed(4)) : 0,
    saturated,
    saturatedDrops,
    peakInflight,
    timedOutInflight,
    maxScheduleLagMs: roundMs(maxScheduleLagMs),
    bytesOut,
    bytesIn,
    throughputOutMBps,
    throughputInMBps,
    throughputTotalMBps: roundMs(throughputOutMBps + throughputInMBps),
    statusCounts,
    errorCodes,
    totalMs: computeLatencyStats(totalSamples),
    ttftMs: computeLatencyStats(ttftSamples),
    overheadMs: overheadSamples.length > 0 ? computeLatencyStats(overheadSamples) : null,
    ttftOverheadMs: ttftOverheadSamples.length > 0 ? computeLatencyStats(ttftOverheadSamples) : null,
  }
}

function sleepAbortable(ms, signal) {
  if (signal?.aborted || ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function sendPanelRequest({ target, agent, op, cookie, timeoutMs, signal }) {
  return new Promise((resolve) => {
    const start = performance.now()
    const client = target.isHttps ? https : http
    const headers = {}
    if (cookie) headers.cookie = cookie
    if (op.body) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(op.body.length)
    }
    let settled = false
    const finish = (status, errCode = null) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve({ status, errCode, latencyMs: performance.now() - start })
    }

    const req = client.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: op.path,
        method: op.method || 'GET',
        headers,
        agent,
      },
      (res) => {
        res.resume()
        res.on('end', () => finish(res.statusCode || 0))
        res.on('error', (err) => finish(0, err?.code || 'RES_ERROR'))
      },
    )

    function onAbort() {
      const err = new Error('Panel poller stopped')
      err.code = 'ABORT_ERR'
      req.destroy(err)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    req.setTimeout(timeoutMs, () => {
      const err = new Error(`Panel request timeout (${timeoutMs}ms)`)
      err.code = 'ETIMEDOUT'
      req.destroy(err)
    })

    req.on('error', (err) => finish(0, err?.code || 'REQ_ERROR'))
    if (op.body) req.end(op.body)
    else req.end()
  })
}

/**
 * Start concurrent admin + tenant panel read/write pollers until the returned handle's `stop()`
 * is called (or `signal` aborts). Returns per-endpoint latency percentiles and error counts.
 */
export function startPanelLoaders({
  sutUrls,
  adminCookie = '',
  tenantCookies = [],
  pollers = DEFAULT_PANEL_POLLERS,
  minIntervalMs = DEFAULT_PANEL_MIN_INTERVAL_MS,
  maxIntervalMs = DEFAULT_PANEL_MAX_INTERVAL_MS,
  enableWrites = true,
  writeEveryN = 5,
  adminWriteOps = DEFAULT_ADMIN_WRITES,
  tenantWriteOps = DEFAULT_TENANT_WRITES,
  timeoutMs = DEFAULT_PANEL_TIMEOUT_MS,
  stagger = true,
} = {}) {
  const count = Math.max(0, Number(pollers) || 0)
  if (count === 0 || (!adminCookie && (!tenantCookies || tenantCookies.length === 0))) {
    return {
      async stop() {
        return {
          pollers: 0,
          totalRequests: 0,
          totalErrors: 0,
          errorRate: 0,
          overallLatencyMs: computeLatencyStats([]),
          byEndpoint: {},
        }
      },
    }
  }

  const targets = parseEndpointTargets(sutUrls, '/')
  const agents = createAgentPool(targets)
  const controller = new AbortController()
  const { signal } = controller
  const tenants = Array.isArray(tenantCookies) ? tenantCookies.filter(Boolean) : []

  // Allocate ~25% (at least 1 when adminCookie is available) to admin pollers, rest to tenant pollers
  const adminPollerCount = adminCookie ? (tenants.length > 0 ? Math.max(1, Math.round(count * 0.25)) : count) : 0

  const endpointStats = new Map()
  const allLatencies = []
  let totalRequests = 0
  let totalErrors = 0

  function getBucket(key, role, method, reqPath) {
    let b = endpointStats.get(key)
    if (!b) {
      b = { role, method, path: reqPath, requests: 0, errors: 0, statusCounts: {}, samples: [] }
      endpointStats.set(key, b)
    }
    return b
  }

  const pollerTasks = []
  for (let i = 0; i < count; i++) {
    const isAdmin = i < adminPollerCount
    const role = isAdmin ? 'admin' : 'tenant'
    const cookie = isAdmin ? adminCookie : tenants[(i - adminPollerCount) % tenants.length]
    const reads = isAdmin ? ADMIN_PANEL_READS : TENANT_PANEL_READS
    const writes = isAdmin ? adminWriteOps : tenantWriteOps
    const lo = Math.max(10, Math.min(minIntervalMs, maxIntervalMs))
    const hi = Math.max(lo, maxIntervalMs)

    pollerTasks.push(
      (async () => {
        if (stagger && lo > 0) {
          const initialDelay = Math.floor(((i + 0.5) / count) * lo)
          await sleepAbortable(initialDelay, signal)
        }
        let step = 0
        let writeIdx = 0
        while (!signal.aborted) {
          const doWrite = enableWrites && writes.length > 0 && writeEveryN > 0 && step > 0 && step % writeEveryN === 0
          const op = doWrite ? writes[writeIdx++ % writes.length] : reads[step % reads.length]
          step++
          const target = targets[(i + step) % targets.length]
          const res = await sendPanelRequest({
            target,
            agent: target.isHttps ? agents.httpsAgent : agents.httpAgent,
            op,
            cookie,
            timeoutMs,
            signal,
          })
          // Ignore requests cancelled purely due to stop() shutdown
          if (signal.aborted && res.errCode === 'ABORT_ERR') break

          const key = `${role}:${op.method}:${op.name}`
          const bucket = getBucket(key, role, op.method, op.path)
          bucket.requests++
          totalRequests++
          bucket.statusCounts[String(res.status)] = (bucket.statusCounts[String(res.status)] || 0) + 1
          const isOk = res.status >= 200 && res.status < 400
          if (!isOk) {
            bucket.errors++
            totalErrors++
          }
          bucket.samples.push(res.latencyMs)
          allLatencies.push(res.latencyMs)

          if (signal.aborted) break
          const waitMs = lo + Math.floor(Math.random() * (hi - lo + 1))
          await sleepAbortable(waitMs, signal)
        }
      })(),
    )
  }

  return {
    async stop() {
      controller.abort()
      await Promise.allSettled(pollerTasks)
      agents.destroy()
      const byEndpoint = {}
      for (const [key, b] of endpointStats.entries()) {
        byEndpoint[key] = {
          role: b.role,
          method: b.method,
          path: b.path,
          requests: b.requests,
          errors: b.errors,
          statusCounts: b.statusCounts,
          latencyMs: computeLatencyStats(b.samples),
        }
      }
      return {
        pollers: count,
        adminPollers: adminPollerCount,
        tenantPollers: count - adminPollerCount,
        totalRequests,
        totalErrors,
        errorRate: totalRequests > 0 ? Number((totalErrors / totalRequests).toFixed(6)) : 0,
        overallLatencyMs: computeLatencyStats(allLatencies),
        byEndpoint,
      }
    },
  }
}

async function runWorkerEngines(opts) {
  const { workers = 1, corpusPath, templates, targetRpm, maxInflight } = opts
  const numWorkers = Math.max(1, Number(workers) || 1)
  if (numWorkers === 1) {
    const loadedTemplates = templates || (await loadCorpusTemplates(corpusPath))
    const single = await executeProxyEngine({ ...opts, templates: loadedTemplates, workerId: 0 })
    return [single]
  }

  // Spawn worker_threads running this same module so 20K RPM never saturates a single event loop.
  const workerFile = fileURLToPath(import.meta.url)
  const workerRpm = targetRpm / numWorkers
  const workerMaxInflight = Math.max(1, Math.floor(maxInflight / numWorkers))

  // If caller passed in-memory templates without corpusPath, serialize lightweight Uint8Arrays once.
  const serializableTemplates = corpusPath
    ? null
    : normalizeTemplates(templates).map((t) => ({
        id: t.id,
        sessionKey: t.sessionKey,
        turnIndex: t.turnIndex,
        approxTokens: t.approxTokens,
        bodyBytes: t.bodyBytes,
        model: t.model,
        stream: t.stream,
        bodyBuffer: new Uint8Array(t.bodyBuffer),
      }))

  const workerPromises = []
  for (let w = 0; w < numWorkers; w++) {
    workerPromises.push(
      new Promise((resolve, reject) => {
        const worker = new Worker(workerFile, {
          workerData: {
            kind: 'proxy-load-worker',
            corpusPath: corpusPath || null,
            templates: serializableTemplates,
            sutUrls: opts.sutUrls,
            apiKeys: opts.apiKeys,
            proxyPath: opts.proxyPath,
            targetRpm: workerRpm,
            durationSec: opts.durationSec,
            maxInflight: workerMaxInflight,
            requestTimeoutMs: opts.requestTimeoutMs,
            drainGraceMs: opts.drainGraceMs,
            routing: opts.routing,
            runId: opts.runId,
            workerId: w,
            extraHeaders: opts.extraHeaders || {},
          },
        })
        let settled = false
        worker.on('message', (msg) => {
          settled = true
          if (msg?.ok) resolve(msg.result)
          else reject(new Error(msg?.error || `Worker ${w} failed`))
        })
        worker.on('error', (err) => {
          if (!settled) {
            settled = true
            reject(err)
          }
        })
        worker.on('exit', (code) => {
          if (!settled) {
            settled = true
            reject(new Error(`Worker ${w} exited unexpectedly with code ${code}`))
          }
        })
      }),
    )
  }
  return Promise.all(workerPromises)
}

/**
 * Run a single open-loop proxy load step, optionally overlaid with concurrent panel read/write pollers.
 */
export async function runLoadStep(options = {}) {
  const {
    corpusPath,
    templates,
    sutUrls,
    apiKeys,
    proxyPath = '/v1/messages',
    targetRpm = DEFAULT_TARGET_RPM,
    durationSec = DEFAULT_DURATION_SEC,
    maxInflight = DEFAULT_MAX_INFLIGHT,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    drainGraceMs = DEFAULT_DRAIN_GRACE_MS,
    routing = 'sticky',
    workers = 1,
    runId = crypto.randomBytes(4).toString('hex'),
    extraHeaders = {},
    panelPollers = DEFAULT_PANEL_POLLERS,
    adminCookie = '',
    tenantCookies = [],
    panelMinIntervalMs = DEFAULT_PANEL_MIN_INTERVAL_MS,
    panelMaxIntervalMs = DEFAULT_PANEL_MAX_INTERVAL_MS,
    panelEnableWrites = true,
    panelWriteEveryN = 5,
    panelAdminWriteOps = DEFAULT_ADMIN_WRITES,
    panelTenantWriteOps = DEFAULT_TENANT_WRITES,
    panelTimeoutMs = DEFAULT_PANEL_TIMEOUT_MS,
    panelStagger = true,
  } = options

  if (!corpusPath && (!templates || templates.length === 0)) {
    throw new Error('Either corpusPath or non-empty templates must be provided')
  }

  const panelHandle = startPanelLoaders({
    sutUrls,
    adminCookie,
    tenantCookies,
    pollers: panelPollers,
    minIntervalMs: panelMinIntervalMs,
    maxIntervalMs: panelMaxIntervalMs,
    enableWrites: panelEnableWrites,
    writeEveryN: panelWriteEveryN,
    adminWriteOps: panelAdminWriteOps,
    tenantWriteOps: panelTenantWriteOps,
    timeoutMs: panelTimeoutMs,
    stagger: panelStagger,
  })

  let workerResults
  let panelStats
  try {
    workerResults = await runWorkerEngines({
      corpusPath,
      templates,
      sutUrls,
      apiKeys,
      proxyPath,
      targetRpm,
      durationSec,
      maxInflight,
      requestTimeoutMs,
      drainGraceMs,
      routing,
      workers,
      runId,
      extraHeaders,
    })
  } finally {
    panelStats = await panelHandle.stop()
  }
  const summary = summarizeWorkerResults(workerResults, {
    targetRpm,
    durationSec,
    maxInflight,
    workers: Math.max(1, Number(workers) || 1),
  })

  return {
    ...summary,
    runId,
    routing,
    panel: panelStats,
  }
}

export function parseLoadRunnerArgs(argv = process.argv.slice(2)) {
  const args = {
    session: '',
    corpus: '',
    sutUrls: [],
    apiKeys: [],
    targetRpm: DEFAULT_TARGET_RPM,
    durationSec: DEFAULT_DURATION_SEC,
    maxInflight: DEFAULT_MAX_INFLIGHT,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    drainGraceMs: DEFAULT_DRAIN_GRACE_MS,
    workers: Math.min(4, Math.max(1, Math.floor(os.cpus().length / 2))),
    routing: 'sticky',
    proxyPath: '/v1/messages',
    panelPollers: DEFAULT_PANEL_POLLERS,
    panelMinIntervalMs: DEFAULT_PANEL_MIN_INTERVAL_MS,
    panelMaxIntervalMs: DEFAULT_PANEL_MAX_INTERVAL_MS,
    panelWrites: true,
    out: '',
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = () => argv[++i]
    if (flag === '--session') args.session = next()
    else if (flag === '--corpus') args.corpus = next()
    else if (flag === '--sut-urls') args.sutUrls = next().split(',').filter(Boolean)
    else if (flag === '--api-keys') args.apiKeys = next().split(',').filter(Boolean)
    else if (flag === '--target-rpm') args.targetRpm = Number(next())
    else if (flag === '--duration-sec') args.durationSec = Number(next())
    else if (flag === '--max-inflight') args.maxInflight = Number(next())
    else if (flag === '--request-timeout-ms') args.requestTimeoutMs = Number(next())
    else if (flag === '--drain-grace-ms') args.drainGraceMs = Number(next())
    else if (flag === '--workers') args.workers = Number(next())
    else if (flag === '--routing') args.routing = next()
    else if (flag === '--proxy-path') args.proxyPath = next()
    else if (flag === '--panel-pollers') args.panelPollers = Number(next())
    else if (flag === '--panel-min-ms') args.panelMinIntervalMs = Number(next())
    else if (flag === '--panel-max-ms') args.panelMaxIntervalMs = Number(next())
    else if (flag === '--no-panel-writes') args.panelWrites = false
    else if (flag === '--out') args.out = next()
  }
  return args
}

// Worker thread entrypoint
if (!isMainThread && workerData?.kind === 'proxy-load-worker') {
  ;(async () => {
    try {
      const templates = workerData.corpusPath ? await loadCorpusTemplates(workerData.corpusPath) : workerData.templates
      const result = await executeProxyEngine({ ...workerData, templates })
      parentPort.postMessage({ ok: true, result }, [
        result.totalSamples.buffer,
        result.ttftSamples.buffer,
        result.overheadSamples.buffer,
        result.ttftOverheadSamples.buffer,
      ])
    } catch (err) {
      parentPort.postMessage({ ok: false, error: err?.stack || err?.message || String(err) })
    }
  })()
}

// CLI entrypoint
const isDirectCli = isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectCli) {
  ;(async () => {
    const args = parseLoadRunnerArgs()
    let session = {}
    if (args.session) {
      session = JSON.parse(fs.readFileSync(path.resolve(args.session), 'utf8'))
    }
    const sutUrls = args.sutUrls.length > 0 ? args.sutUrls : session.sutUrls || []
    const apiKeys = args.apiKeys.length > 0 ? args.apiKeys : session.apiKeys || []
    const result = await runLoadStep({
      corpusPath: args.corpus,
      sutUrls,
      apiKeys,
      proxyPath: args.proxyPath,
      targetRpm: args.targetRpm,
      durationSec: args.durationSec,
      maxInflight: args.maxInflight,
      requestTimeoutMs: args.requestTimeoutMs,
      drainGraceMs: args.drainGraceMs,
      workers: args.workers,
      routing: args.routing,
      panelPollers: args.panelPollers,
      adminCookie: session.adminCookie || '',
      tenantCookies: session.tenantCookies || [],
      panelMinIntervalMs: args.panelMinIntervalMs,
      panelMaxIntervalMs: args.panelMaxIntervalMs,
      panelEnableWrites: args.panelWrites,
    })
    const output = JSON.stringify(result, null, 2)
    if (args.out) {
      fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
      fs.writeFileSync(path.resolve(args.out), output, 'utf8')
    }
    process.stdout.write(`${output}\n`)
  })().catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`)
    process.exitCode = 1
  })
}
