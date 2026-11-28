/**
 * Zero-intrusion in-process SUT probe loaded via:
 *   NODE_OPTIONS="--import /path/to/scripts/bench-20k/sut-probe-preload.mjs"
 *
 * Activates ONLY on the Node.js main thread when `VM2API_BENCH_PROBE_PORT` is set
 * (never interferes with `worker_threads` like `pg-sync-worker.mjs` or normal runs).
 *
 * Collects:
 *   - Event loop delay (p50/p95/p99/max/mean) via `monitorEventLoopDelay({ resolution: 10 })`
 *   - `Atomics.wait` invocation count & blocking duration (quantifies `PgSyncDb` main-thread stalls)
 *   - Process RSS / heap memory & CPU usage deltas
 *
 * Exposes local read-only HTTP server on `127.0.0.1:<VM2API_BENCH_PROBE_PORT>`:
 *   - `GET /metrics` — JSON snapshot
 *   - `GET /health`  — `{ ok: true, pid }`
 *   - `POST /reset`  — resets period counters (event loop histogram, Atomics.wait delta, CPU baseline)
 */
import http from 'node:http'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { isMainThread } from 'node:worker_threads'

const NS_PER_MS = 1_000_000
const NS_PER_US = 1_000

let activeHandle = null

function round3(n) {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 1000) / 1000
}

function nsToMs(ns) {
  const n = Number(ns)
  if (!Number.isFinite(n) || n <= 0) return 0
  return round3(n / NS_PER_MS)
}

function createAtomicsWaitState() {
  return {
    count: 0,
    totalNs: 0n,
    maxNs: 0n,
    okCount: 0,
    notEqualCount: 0,
    timedOutCount: 0,
  }
}

function formatAtomicsWait(state) {
  const totalMs = round3(Number(state.totalNs) / NS_PER_MS)
  const totalUs = Math.round(Number(state.totalNs) / NS_PER_US)
  const maxMs = round3(Number(state.maxNs) / NS_PER_MS)
  const avgMs = state.count > 0 ? round3(totalMs / state.count) : 0
  return {
    count: state.count,
    totalMs,
    totalUs,
    maxMs,
    avgMs,
    okCount: state.okCount,
    notEqualCount: state.notEqualCount,
    timedOutCount: state.timedOutCount,
  }
}

/**
 * Install the in-process probe and bind the local metrics HTTP server.
 * Safe to call directly from tests; returns `{ port, url, metricsUrl, snapshot, reset, close }`.
 */
export function startSutProbe({ port, host = '127.0.0.1', resolution = 10 } = {}) {
  const parsedPort = Number(port)
  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    throw new Error(`Invalid probe port: ${port}`)
  }

  const eld = monitorEventLoopDelay({ resolution })
  eld.enable()

  let periodAtomics = createAtomicsWaitState()
  const cumulativeAtomics = createAtomicsWaitState()
  let cpuBase = process.cpuUsage()
  let windowStartNs = process.hrtime.bigint()
  let resetAtIso = new Date().toISOString()

  const originalWait = Atomics.wait
  const wrappedWait = function benchProbeAtomicsWait(typedArray, index, value, timeout) {
    const t0 = process.hrtime.bigint()
    let outcome
    try {
      outcome = originalWait.call(Atomics, typedArray, index, value, timeout)
      return outcome
    } finally {
      const elapsed = process.hrtime.bigint() - t0
      periodAtomics.count += 1
      periodAtomics.totalNs += elapsed
      if (elapsed > periodAtomics.maxNs) periodAtomics.maxNs = elapsed

      cumulativeAtomics.count += 1
      cumulativeAtomics.totalNs += elapsed
      if (elapsed > cumulativeAtomics.maxNs) cumulativeAtomics.maxNs = elapsed

      if (outcome === 'ok') {
        periodAtomics.okCount += 1
        cumulativeAtomics.okCount += 1
      } else if (outcome === 'not-equal') {
        periodAtomics.notEqualCount += 1
        cumulativeAtomics.notEqualCount += 1
      } else if (outcome === 'timed-out') {
        periodAtomics.timedOutCount += 1
        cumulativeAtomics.timedOutCount += 1
      }
    }
  }
  Atomics.wait = wrappedWait

  function snapshot() {
    const mem = process.memoryUsage()
    const cpuDelta = process.cpuUsage(cpuBase)
    const cpuTotal = process.cpuUsage()
    const wallNs = process.hrtime.bigint() - windowStartNs
    const wallUs = Math.max(1, Number(wallNs) / NS_PER_US)
    const cpuDeltaTotalUs = cpuDelta.user + cpuDelta.system
    const hasSamples = eld.count > 0

    const periodFmt = formatAtomicsWait(periodAtomics)
    const cumFmt = formatAtomicsWait(cumulativeAtomics)

    return {
      pid: process.pid,
      ts: new Date().toISOString(),
      uptimeSec: round3(process.uptime()),
      windowSec: round3(Number(wallNs) / 1e9),
      resetAt: resetAtIso,
      eventLoopDelayMs: {
        p50: hasSamples ? nsToMs(eld.percentile(50)) : 0,
        p95: hasSamples ? nsToMs(eld.percentile(95)) : 0,
        p99: hasSamples ? nsToMs(eld.percentile(99)) : 0,
        max: hasSamples ? nsToMs(eld.max) : 0,
        mean: hasSamples ? nsToMs(eld.mean) : 0,
        min: hasSamples ? nsToMs(eld.min) : 0,
        samples: eld.count,
      },
      atomicsWait: {
        ...periodFmt,
        cumulative: {
          count: cumFmt.count,
          totalMs: cumFmt.totalMs,
          totalUs: cumFmt.totalUs,
          maxMs: cumFmt.maxMs,
          avgMs: cumFmt.avgMs,
        },
      },
      memory: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
        rssMb: round3(mem.rss / (1024 * 1024)),
        heapUsedMb: round3(mem.heapUsed / (1024 * 1024)),
      },
      cpuUsage: {
        userUs: cpuDelta.user,
        systemUs: cpuDelta.system,
        totalUs: cpuDeltaTotalUs,
        pct: round3((cpuDeltaTotalUs / wallUs) * 100),
        cumulativeUserUs: cpuTotal.user,
        cumulativeSystemUs: cpuTotal.system,
      },
    }
  }

  function reset() {
    eld.reset()
    periodAtomics = createAtomicsWaitState()
    cpuBase = process.cpuUsage()
    windowStartNs = process.hrtime.bigint()
    resetAtIso = new Date().toISOString()
    return { ok: true, pid: process.pid, resetAt: resetAtIso }
  }

  const server = http.createServer((req, res) => {
    const pathname = String(req.url || '/').split('?', 1)[0]
    if (req.method === 'GET' && pathname === '/metrics') {
      const payload = JSON.stringify(snapshot())
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
      })
      res.end(payload)
      return
    }
    if (req.method === 'GET' && pathname === '/health') {
      const payload = JSON.stringify({ ok: true, pid: process.pid })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
      return
    }
    if (req.method === 'POST' && pathname === '/reset') {
      req.resume()
      const payload = JSON.stringify(reset())
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end('{"error":"not_found"}')
  })

  server.keepAliveTimeout = 30_000
  server.unref()

  let closed = false
  let boundPort = parsedPort

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(parsedPort, host, () => {
      server.off('error', reject)
      const addr = server.address()
      boundPort = typeof addr === 'object' && addr ? addr.port : parsedPort
      resolve(boundPort)
    })
  })

  async function close() {
    if (closed) return
    closed = true
    if (Atomics.wait === wrappedWait) {
      Atomics.wait = originalWait
    }
    try {
      eld.disable()
    } catch {}
    await new Promise((resolve) => {
      try {
        server.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  return {
    ready,
    get port() {
      return boundPort
    },
    get url() {
      return `http://${host}:${boundPort}`
    },
    get metricsUrl() {
      return `http://${host}:${boundPort}/metrics`
    },
    snapshot,
    reset,
    close,
  }
}

// Auto-install only when preloaded on the main thread with VM2API_BENCH_PROBE_PORT set.
const rawEnvPort = String(process.env.VM2API_BENCH_PROBE_PORT || '').trim()
if (isMainThread && rawEnvPort) {
  const envPort = Number.parseInt(rawEnvPort, 10)
  if (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535 && !activeHandle) {
    const envHost = String(process.env.VM2API_BENCH_PROBE_HOST || '127.0.0.1').trim() || '127.0.0.1'
    activeHandle = startSutProbe({ port: envPort, host: envHost })
    activeHandle.ready.catch((err) => {
      console.error(`[sut-probe-preload] failed to bind ${envHost}:${envPort}: ${err?.message || err}`)
    })
  }
}
