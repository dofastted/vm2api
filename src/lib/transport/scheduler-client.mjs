import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const MAX_BODY = 64 * 1024 * 1024
const MAX_STDERR_BYTES = 4096

export const DEFAULT_RECONNECT_WINDOW_MS = 300
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
export const DEFAULT_TELEMETRY_THROTTLE_MS = 200
export const DEFAULT_DRAIN_INTERVAL_MS = 1_000

export const DEFAULT_TIMEOUTS = Object.freeze({
  health: 300,
  bootstrap: 3_000,
  syncConfig: 1_000,
  pushTelemetry: 200,
  heartbeat: 200,
  commit: 200,
  release: 300,
  explain: 500,
  drainPersistence: 500,
  sticky: 500,
  unrestNode: 500,
  eventsConnect: 5_000,
  sessionQueueTimeoutMs: 60_000,
  queueWaitMs: 15_000,
  acquireHeadroomMs: 2_000,
  switchHeadroomMs: 2_000,
})

const TRANSPORT_ERROR_CODES = new Set([
  'ENOENT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_SOCKET_CLOSED',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'EAI_AGAIN',
])

export class SchedulerUnavailableError extends Error {
  constructor(message = 'scheduler unavailable', { reason = 'unavailable', details, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'SchedulerUnavailableError'
    this.status = 503
    this.code = 'scheduler_unavailable'
    this.retryAfterSec = 1
    this.reason = reason
    if (details !== undefined) this.details = details
  }

  toHttpError() {
    return {
      status: 503,
      retryAfterSec: 1,
      headers: { 'retry-after': '1' },
      body: {
        type: 'error',
        error: {
          type: 'api_error',
          code: 'scheduler_unavailable',
          message: this.message,
        },
      },
    }
  }
}

export class SchedulerApiError extends Error {
  constructor({
    status,
    code = 'scheduler_error',
    message = 'scheduler request failed',
    retryAfterSec,
    explain,
    currentEpoch,
    oldestSeq,
    latestSeq,
    endpoint,
    rawBody,
  }) {
    super(message)
    this.name = 'SchedulerApiError'
    this.status = Number(status) || 500
    this.code = String(code || 'scheduler_error')
    if (retryAfterSec != null && Number.isFinite(Number(retryAfterSec))) {
      this.retryAfterSec = Number(retryAfterSec)
    }
    if (explain !== undefined) this.explain = explain
    if (currentEpoch !== undefined) this.currentEpoch = currentEpoch
    if (oldestSeq !== undefined) this.oldestSeq = oldestSeq
    if (latestSeq !== undefined) this.latestSeq = latestSeq
    if (endpoint !== undefined) this.endpoint = endpoint
    if (rawBody !== undefined) this.rawBody = rawBody
  }
}

function makeAbortError(signal) {
  if (signal?.reason instanceof Error) {
    const err = signal.reason
    if (!err.code) err.code = 'ABORT_ERR'
    return err
  }
  const err = new Error(typeof signal?.reason === 'string' ? signal.reason : 'The operation was aborted')
  err.name = 'AbortError'
  err.code = 'ABORT_ERR'
  return err
}

function isAbortError(err, signal) {
  return Boolean(signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR')
}

function isTransportError(err) {
  if (!err) return false
  if (err.code && TRANSPORT_ERROR_CODES.has(err.code)) return true
  const msg = String(err.message || '').toLowerCase()
  return msg.includes('socket hang up') || msg.includes('connection reset') || msg.includes('broken pipe')
}

function parseHostPort(listenAddr) {
  const raw = String(listenAddr || '').trim()
  if (!raw) return { host: '127.0.0.1', port: 0 }
  const idx = raw.lastIndexOf(':')
  if (idx <= 0) return { host: raw, port: 0 }
  const host = raw.slice(0, idx).replace(/^\[|\]$/g, '') || '127.0.0.1'
  const port = Number.parseInt(raw.slice(idx + 1), 10)
  return { host, port: Number.isFinite(port) && port >= 0 ? port : 0 }
}

function sanitizeColor(raw) {
  const s = String(raw || '').trim()
  return /^[a-z0-9_-]+$/i.test(s) ? s : ''
}

export function schedulerPaths(cfg = {}, options = {}) {
  const project = options.projectDir || cfg?.paths?.project || process.cwd()
  const dataDir = options.dataDir || cfg?.paths?.data || cfg?.dataDir || path.join(project, 'data')
  const runDir = path.join(dataDir, 'run')
  const color = sanitizeColor(options.color ?? process.env.KIN_BG_COLOR ?? process.env.BG_COLOR ?? '')
  const suffix = color ? `-${color}` : ''
  const binName = process.platform === 'win32' ? 'kin-scheduler.exe' : 'kin-scheduler'
  const projectBin = path.join(project, 'bin', binName)
  const repoBin = path.join(REPO_ROOT, 'bin', binName)
  const binPath = options.binPath || process.env.KIN_SCHEDULER_BIN || (fs.existsSync(projectBin) ? projectBin : repoBin)

  const explicitListen =
    options.listenAddr ||
    (options.host || options.port != null ? `${options.host || '127.0.0.1'}:${options.port ?? 0}` : '') ||
    process.env.KIN_SCHEDULER_LISTEN ||
    ''
  const explicitSocket = options.socketPath || process.env.KIN_SCHEDULER_SOCK || ''

  let transport = options.transport
  if (!transport) {
    if (explicitListen) transport = 'tcp'
    else if (explicitSocket) transport = 'uds'
    else transport = process.platform === 'win32' ? 'tcp' : 'uds'
  }

  const listenAddr = transport === 'tcp' ? explicitListen || '127.0.0.1:0' : ''
  const { host, port } = transport === 'tcp' ? parseHostPort(listenAddr) : { host: null, port: null }

  return {
    transport,
    socketPath: transport === 'uds' ? explicitSocket || path.join(runDir, `scheduler${suffix}.sock`) : null,
    listenAddr: transport === 'tcp' ? listenAddr : null,
    host,
    port,
    tokenPath:
      options.tokenPath || process.env.KIN_SCHEDULER_TOKEN_FILE || path.join(runDir, `scheduler${suffix}.token`),
    capFile: options.capFile || process.env.KIN_SCHEDULER_CAP_FILE || path.join(runDir, `scheduler${suffix}.cap.json`),
    binPath,
  }
}

export function ensureSchedulerToken(tokenPath, explicitToken = '') {
  const fixed = String(explicitToken || process.env.KIN_SCHEDULER_TOKEN || '').trim()
  if (fixed) {
    if (tokenPath) {
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true })
      fs.writeFileSync(tokenPath, fixed, { mode: 0o600 })
      try {
        if (process.platform !== 'win32') fs.chmodSync(tokenPath, 0o600)
      } catch {}
    }
    return fixed
  }
  if (!tokenPath) {
    return crypto.randomBytes(32).toString('hex')
  }
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true })
  if (fs.existsSync(tokenPath)) {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim()
    if (existing) {
      try {
        if (process.platform !== 'win32') fs.chmodSync(tokenPath, 0o600)
      } catch {}
      return existing
    }
  }
  const token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(tokenPath, token, { mode: 0o600 })
  try {
    if (process.platform !== 'win32') fs.chmodSync(tokenPath, 0o600)
  } catch {}
  return token
}

function nonNegativeMs(val, fallback) {
  if (val == null || val === '') return fallback
  const n = Number(val)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function computeAcquireTimeoutMs(opts = {}) {
  if (opts.timeoutMs != null) {
    return Math.max(50, nonNegativeMs(opts.timeoutMs, DEFAULT_TIMEOUTS.acquireHeadroomMs))
  }
  if (opts.no_queue || opts.noQueue) {
    return DEFAULT_TIMEOUTS.acquireHeadroomMs
  }
  const sessionQueueMs = nonNegativeMs(
    opts.sessionQueueTimeoutMs ?? opts.session_queue_timeout_ms,
    DEFAULT_TIMEOUTS.sessionQueueTimeoutMs,
  )
  const sessionBusyMs = nonNegativeMs(opts.sessionBusyWaitMs ?? opts.session_busy_wait_ms, 0)
  const queueWaitMs = nonNegativeMs(opts.queueWaitMs ?? opts.queue_wait_ms, DEFAULT_TIMEOUTS.queueWaitMs)
  const waitBudget = sessionQueueMs + Math.max(sessionBusyMs, queueWaitMs)
  const minBudget = Math.max(sessionQueueMs, queueWaitMs) + 1_000
  return Math.max(minBudget, waitBudget + DEFAULT_TIMEOUTS.acquireHeadroomMs)
}

export function computeSwitchTimeoutMs(opts = {}) {
  if (opts.timeoutMs != null) {
    return Math.max(50, nonNegativeMs(opts.timeoutMs, DEFAULT_TIMEOUTS.switchHeadroomMs))
  }
  if (opts.no_queue || opts.noQueue) {
    return DEFAULT_TIMEOUTS.switchHeadroomMs
  }
  const sessionBusyMs = nonNegativeMs(opts.sessionBusyWaitMs ?? opts.session_busy_wait_ms, 0)
  const queueWaitMs = nonNegativeMs(opts.queueWaitMs ?? opts.queue_wait_ms, DEFAULT_TIMEOUTS.queueWaitMs)
  return Math.max(sessionBusyMs, queueWaitMs) + DEFAULT_TIMEOUTS.switchHeadroomMs
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(makeAbortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(makeAbortError(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function raceWithDeadline(promise, ms, signal) {
  if (signal?.aborted) return Promise.reject(makeAbortError(signal))
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(makeAbortError(signal))
    }
    const timer = setTimeout(
      () => {
        if (settled) return
        settled = true
        cleanup()
        reject(
          new SchedulerUnavailableError(`scheduler unavailable: recovery exceeded ${ms}ms window`, {
            reason: 'reconnect_timeout',
          }),
        )
      },
      Math.max(1, ms),
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (val) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(val)
      },
      (err) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      },
    )
  })
}

function parseApiError(status, text, headers, endpoint) {
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {}
  const errObj =
    parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object'
      ? parsed.error
      : parsed && typeof parsed === 'object'
        ? parsed
        : null
  const headerRetryAfter = headers?.['retry-after']
  const parsedHeaderRetry = headerRetryAfter != null ? Number(headerRetryAfter) : undefined
  const retryAfterSec =
    errObj?.retry_after_sec != null
      ? Number(errObj.retry_after_sec)
      : Number.isFinite(parsedHeaderRetry)
        ? parsedHeaderRetry
        : undefined
  return new SchedulerApiError({
    status,
    code: errObj?.code || `http_${status}`,
    message: errObj?.message || text?.slice(0, 200) || `scheduler HTTP ${status}`,
    retryAfterSec,
    explain: errObj?.explain,
    currentEpoch: errObj?.current_epoch,
    oldestSeq: errObj?.oldest_seq,
    latestSeq: errObj?.latest_seq,
    endpoint,
    rawBody: parsed ?? text?.slice(0, 512),
  })
}

function telemetryNodeKey(item) {
  if (!item || typeof item !== 'object') return ''
  if (item.node_key) return String(item.node_key)
  if (item.node_type && item.node_id) return `${item.node_type}:${item.node_id}`
  return ''
}

function buildQueryString(params = {}) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue
    qs.set(k, String(v))
  }
  const str = qs.toString()
  return str ? `?${str}` : ''
}

function hasDrainItems(batch) {
  if (!batch || typeof batch !== 'object') return false
  return Boolean(
    batch.sticky_upserts?.length ||
      batch.sticky_deletes?.length ||
      batch.penalty_upserts?.length ||
      batch.penalty_deletes?.length,
  )
}

export class SchedulerClient {
  #cfg
  #paths
  #token
  #manageProcess
  #autoRestart
  #detached
  #role
  #epochPrefix
  #epochSeq = 0
  #controllerEpoch
  #reconnectWindowMs
  #leaseTtlMs
  #reapIntervalMs
  #heartbeatIntervalMs
  #telemetryThrottleMs
  #drainIntervalMs
  #autoTrackLeases
  #onBootstrap
  #onDrain
  #onError

  #agent
  #child = null
  #childStderr = ''
  #resolvedHost = null
  #resolvedPort = null
  #bootCount = 0
  #bootstrapped = false
  #everBootstrapped = false
  #stopping = false
  #recoveryPromise = null
  #respawnTimer = null
  #crashTimestamps = []
  #exitHook = null

  #activeLeases = new Set()
  #heartbeatTimer = null
  #heartbeatInFlight = false

  #pendingTelemetry = new Map()
  #telemetryTimer = null
  #telemetryInFlight = null

  #drainTimer = null
  #drainInFlight = null

  constructor(options = {}) {
    this.#cfg = options.cfg || {}
    this.#paths = schedulerPaths(this.#cfg, options)
    this.#token = String(options.token || '').trim()
    this.#manageProcess = options.manageProcess !== undefined ? Boolean(options.manageProcess) : true
    this.#autoRestart = options.autoRestart !== undefined ? Boolean(options.autoRestart) : this.#manageProcess
    this.#detached = Boolean(options.detached)

    const isStandby =
      options.isStandby !== undefined
        ? Boolean(options.isStandby)
        : options.role === 'standby' ||
          (process.env.KIN_STANDBY === '1' &&
            !(process.env.KIN_STANDBY_ACTIVE_FILE && fs.existsSync(process.env.KIN_STANDBY_ACTIVE_FILE)))
    this.#role = isStandby ? 'standby' : 'leader'

    this.#epochPrefix = String(options.epochPrefix || `node-${process.pid}`)
    if (options.controllerEpoch) {
      this.#controllerEpoch = String(options.controllerEpoch)
    } else {
      this.#epochSeq = 1
      this.#controllerEpoch = `${this.#epochPrefix}-1`
    }

    const reqWin = Number(options.reconnectWindowMs)
    this.#reconnectWindowMs =
      Number.isFinite(reqWin) && reqWin > 0
        ? Math.min(reqWin, DEFAULT_RECONNECT_WINDOW_MS)
        : DEFAULT_RECONNECT_WINDOW_MS

    this.#leaseTtlMs = options.leaseTtlMs != null ? Number(options.leaseTtlMs) : null
    this.#reapIntervalMs = options.reapIntervalMs != null ? Number(options.reapIntervalMs) : null
    this.#heartbeatIntervalMs = nonNegativeMs(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS)
    this.#telemetryThrottleMs = nonNegativeMs(options.telemetryThrottleMs, DEFAULT_TELEMETRY_THROTTLE_MS)
    this.#drainIntervalMs = nonNegativeMs(options.drainIntervalMs, DEFAULT_DRAIN_INTERVAL_MS)
    this.#autoTrackLeases = options.autoTrackLeases !== false

    this.#onBootstrap = typeof options.onBootstrap === 'function' ? options.onBootstrap : null
    this.#onDrain = typeof options.onDrain === 'function' ? options.onDrain : null
    this.#onError = typeof options.onError === 'function' ? options.onError : null

    if (this.#paths.transport === 'tcp' && this.#paths.port > 0) {
      this.#resolvedHost = this.#paths.host
      this.#resolvedPort = this.#paths.port
    }

    this.#agent = this.#createAgent()
  }

  #createAgent() {
    return new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 30_000,
      maxSockets: 64,
      maxFreeSockets: 16,
    })
  }

  #resetAgent() {
    const old = this.#agent
    this.#agent = this.#createAgent()
    try {
      old?.destroy()
    } catch {}
  }

  get paths() {
    return {
      ...this.#paths,
      host: this.#resolvedHost ?? this.#paths.host,
      port: this.#resolvedPort ?? this.#paths.port,
    }
  }

  get controllerEpoch() {
    return this.#controllerEpoch
  }

  get role() {
    return this.#role
  }

  get isStandby() {
    return this.#role === 'standby'
  }

  get pid() {
    return this.#child?.pid ?? null
  }

  get bootCount() {
    return this.#bootCount
  }

  get activeLeaseCount() {
    return this.#activeLeases.size
  }

  get stopped() {
    return this.#stopping
  }

  #nextEpoch() {
    this.#epochSeq += 1
    this.#controllerEpoch = `${this.#epochPrefix}-${this.#epochSeq}`
    return this.#controllerEpoch
  }

  #resolveToken() {
    if (this.#token) return this.#token
    this.#token = ensureSchedulerToken(this.#paths.tokenPath)
    return this.#token
  }

  #readCapFile(expectedPid = null) {
    if (!this.#paths.capFile) return null
    try {
      const raw = fs.readFileSync(this.#paths.capFile, 'utf8').trim()
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (expectedPid != null && parsed.pid != null && Number(parsed.pid) !== Number(expectedPid)) {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }

  #buildConnectionOptions(endpointPath, method, headers, { useAgent = true, signal } = {}) {
    const base = {
      path: endpointPath,
      method,
      headers,
      agent: useAgent ? this.#agent : false,
      ...(signal ? { signal } : {}),
    }
    if (this.#paths.transport === 'uds') {
      return { ...base, socketPath: this.#paths.socketPath }
    }
    let host = this.#resolvedHost || this.#paths.host || '127.0.0.1'
    let port = this.#resolvedPort || this.#paths.port
    if (!port) {
      const cap = this.#readCapFile()
      if (cap) {
        if (cap.port) {
          host = cap.host || host
          port = Number(cap.port)
        } else if (cap.addr) {
          const parsed = parseHostPort(cap.addr)
          host = parsed.host || host
          port = parsed.port
        }
        if (port) {
          this.#resolvedHost = host
          this.#resolvedPort = port
        }
        if (!this.#token && cap.token) {
          this.#token = String(cap.token).trim()
        }
      }
    }
    if (!port) {
      throw new SchedulerUnavailableError('scheduler TCP endpoint port is not resolved yet', {
        reason: 'endpoint_unresolved',
      })
    }
    return { ...base, host, port }
  }

  #rawRequest(method, endpointPath, bodyObj, { timeoutMs = 1_000, signal, tokenOverride } = {}) {
    if (signal?.aborted) {
      return Promise.reject(makeAbortError(signal))
    }
    const token = tokenOverride !== undefined ? String(tokenOverride || '') : this.#resolveToken()
    const hasBody = bodyObj !== undefined && bodyObj !== null
    const payload = hasBody ? Buffer.from(JSON.stringify(bodyObj)) : null
    const headers = {}
    if (token) headers['x-kin-internal-token'] = token
    if (hasBody) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }

    let reqOpts
    try {
      reqOpts = this.#buildConnectionOptions(endpointPath, method, headers, { useAgent: true, signal })
    } catch (err) {
      return Promise.reject(err)
    }

    return new Promise((resolve, reject) => {
      let settled = false
      let resReceived = false
      const done = (fn, val) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(val)
      }

      const req = http.request(reqOpts, (res) => {
        resReceived = true
        const chunks = []
        let size = 0
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_BODY) {
            req.destroy(new Error('scheduler response exceeded MAX_BODY'))
            return
          }
          chunks.push(chunk)
        })
        res.on('aborted', () => {
          if (signal?.aborted) {
            done(reject, makeAbortError(signal))
          } else {
            done(reject, Object.assign(new Error('scheduler response aborted'), { code: 'ECONNRESET' }))
          }
        })
        res.once('error', (err) => {
          if (isAbortError(err, signal)) {
            done(reject, makeAbortError(signal))
            return
          }
          done(reject, err)
        })
        res.once('close', () => {
          if (settled) return
          if (signal?.aborted) {
            done(reject, makeAbortError(signal))
          } else if (!res.complete) {
            done(reject, Object.assign(new Error('scheduler response closed prematurely'), { code: 'ECONNRESET' }))
          }
        })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const status = res.statusCode || 0
          if (status >= 200 && status < 300) {
            if (!text) return done(resolve, { ok: true })
            try {
              done(resolve, JSON.parse(text))
            } catch (err) {
              done(
                reject,
                new SchedulerApiError({
                  status,
                  code: 'invalid_json',
                  message: `scheduler invalid JSON: ${err.message}`,
                  endpoint: endpointPath,
                  rawBody: text.slice(0, 200),
                }),
              )
            }
          } else {
            done(reject, parseApiError(status, text, res.headers, endpointPath))
          }
        })
      })

      const effectiveTimeout = Math.max(50, Number(timeoutMs) || 1_000)
      const timer = setTimeout(() => {
        const err = new SchedulerUnavailableError(`scheduler request timeout after ${effectiveTimeout}ms`, {
          reason: 'timeout',
          details: { endpoint: endpointPath, timeoutMs: effectiveTimeout },
        })
        req.destroy(err)
      }, effectiveTimeout)

      req.once('error', (err) => {
        if (isAbortError(err, signal)) {
          done(reject, makeAbortError(signal))
          return
        }
        done(reject, err)
      })
      req.once('close', () => {
        if (settled || resReceived) return
        if (signal?.aborted) {
          done(reject, makeAbortError(signal))
        } else {
          done(reject, Object.assign(new Error('scheduler request closed before response'), { code: 'ECONNRESET' }))
        }
      })

      if (payload) req.write(payload)
      req.end()
    })
  }

  #installExitHook() {
    if (this.#exitHook || this.#detached) return
    this.#exitHook = () => {
      if (this.#child) {
        try {
          this.#child.kill('SIGTERM')
        } catch {}
      }
      if (this.#paths.transport === 'uds' && this.#paths.socketPath) {
        try {
          fs.rmSync(this.#paths.socketPath, { force: true })
        } catch {}
      }
      if (this.#paths.capFile) {
        try {
          fs.rmSync(this.#paths.capFile, { force: true })
        } catch {}
      }
    }
    process.once('exit', this.#exitHook)
  }

  #removeExitHook() {
    if (!this.#exitHook) return
    process.removeListener('exit', this.#exitHook)
    this.#exitHook = null
  }

  #spawnChild() {
    const binPath = this.#paths.binPath
    if (!binPath || !fs.existsSync(binPath)) {
      throw new SchedulerUnavailableError(`scheduler binary missing: ${binPath}`, {
        reason: 'bin_missing',
        details: { binPath },
      })
    }

    const token = ensureSchedulerToken(this.#paths.tokenPath, this.#token)
    this.#token = token

    const args = ['--token-file', this.#paths.tokenPath, '--cap-file', this.#paths.capFile]
    fs.mkdirSync(path.dirname(this.#paths.capFile), { recursive: true })
    try {
      fs.rmSync(this.#paths.capFile, { force: true })
    } catch {}

    if (this.#paths.transport === 'uds') {
      fs.mkdirSync(path.dirname(this.#paths.socketPath), { recursive: true })
      try {
        fs.rmSync(this.#paths.socketPath, { force: true })
      } catch {}
      args.unshift('--socket', this.#paths.socketPath)
    } else {
      const listen = this.#paths.listenAddr || '127.0.0.1:0'
      args.unshift('--listen', listen)
      if (this.#paths.port === 0) {
        this.#resolvedHost = null
        this.#resolvedPort = null
      }
    }

    if (this.#leaseTtlMs != null && Number.isFinite(this.#leaseTtlMs) && this.#leaseTtlMs > 0) {
      args.push('--lease-ttl-ms', String(Math.floor(this.#leaseTtlMs)))
    }
    if (this.#reapIntervalMs != null && Number.isFinite(this.#reapIntervalMs) && this.#reapIntervalMs > 0) {
      args.push('--reap-interval-ms', String(Math.floor(this.#reapIntervalMs)))
    }

    this.#childStderr = ''
    const child = spawn(binPath, args, {
      detached: this.#detached,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })

    child.stderr?.on('data', (chunk) => {
      const next = this.#childStderr + chunk.toString('utf8')
      this.#childStderr = next.length > MAX_STDERR_BYTES ? next.slice(-MAX_STDERR_BYTES) : next
    })
    child.unref?.()
    this.#child = child
    this.#bootCount += 1
    this.#bootstrapped = false
    this.#installExitHook()

    child.once('exit', (code, sig) => {
      if (this.#child !== child) return
      this.#child = null
      this.#bootstrapped = false
      if (this.#paths.transport === 'tcp' && this.#paths.port === 0) {
        this.#resolvedPort = null
      }
      this.#resetAgent()
      if (!this.#stopping && this.#autoRestart) {
        this.#scheduleCrashRespawn(code, sig)
      }
    })

    return child
  }

  #scheduleCrashRespawn(code, sig) {
    if (this.#stopping || !this.#autoRestart || this.#respawnTimer) return
    const now = Date.now()
    this.#crashTimestamps = this.#crashTimestamps.filter((ts) => now - ts < 2_000)
    this.#crashTimestamps.push(now)
    // First crash respawns almost immediately (<10ms) to achieve <100ms recovery; rapid loops apply modest cap.
    const delayMs = this.#crashTimestamps.length <= 1 ? 5 : Math.min(80, 15 * this.#crashTimestamps.length)
    this.#respawnTimer = setTimeout(() => {
      this.#respawnTimer = null
      if (this.#stopping || !this.#autoRestart) return
      this.#ensureBootedInternal({ waitMs: 2_000, forceEpochIncrement: true }).catch((err) => {
        this.#onError?.(err, { phase: 'respawn', code, signal: sig })
      })
    }, delayMs)
    this.#respawnTimer.unref?.()
  }

  async #waitForListenerReady(child, waitMs) {
    const deadline = Date.now() + Math.max(50, waitMs)
    let lastError = null
    while (Date.now() < deadline) {
      if (this.#stopping) {
        throw new SchedulerUnavailableError('scheduler client stopped', { reason: 'client_stopped' })
      }
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new SchedulerUnavailableError(
          `scheduler exited during startup (code=${child.exitCode}, signal=${child.signalCode})`,
          {
            reason: 'process_exited',
            details: { exitCode: child.exitCode, signal: child.signalCode, stderr: this.#childStderr.trim() },
          },
        )
      }
      if (this.#paths.transport === 'tcp' && (!this.#resolvedPort || this.#paths.port === 0)) {
        const cap = this.#readCapFile(child?.pid)
        const capPort = cap?.port ? Number(cap.port) : cap?.addr ? parseHostPort(cap.addr).port : 0
        if (capPort > 0) {
          this.#resolvedHost = cap?.host || (cap?.addr ? parseHostPort(cap.addr).host : '127.0.0.1')
          this.#resolvedPort = capPort
          if (!this.#token && cap?.token) {
            this.#token = String(cap.token).trim()
          }
        } else {
          await sleep(10)
          continue
        }
      }
      try {
        const res = await this.#rawRequest('GET', '/internal/v1/health', null, {
          timeoutMs: Math.min(DEFAULT_TIMEOUTS.health, Math.max(50, deadline - Date.now())),
        })
        if (res?.ok) return res
      } catch (err) {
        lastError = err
      }
      await sleep(10)
    }
    throw new SchedulerUnavailableError('scheduler health check timed out during startup', {
      reason: 'health_timeout',
      cause: lastError,
      details: { stderr: this.#childStderr.trim() || undefined },
    })
  }

  async #runBootstrapHook() {
    if (!this.#onBootstrap) {
      this.#bootstrapped = true
      return null
    }
    const payload = await this.#onBootstrap({
      controllerEpoch: this.#controllerEpoch,
      role: this.#role,
      client: this,
    })
    if (payload && typeof payload === 'object' && payload.handled !== true) {
      const body = {
        controller_epoch: String(payload.controller_epoch || this.#controllerEpoch),
        role: payload.role || this.#role,
        ...(payload.config_version != null ? { config_version: payload.config_version } : {}),
        config_snapshot: payload.config_snapshot,
        ...(payload.active_sticky_bindings ? { active_sticky_bindings: payload.active_sticky_bindings } : {}),
        ...(payload.active_penalties ? { active_penalties: payload.active_penalties } : {}),
        ...(payload.initial_telemetry ? { initial_telemetry: payload.initial_telemetry } : {}),
      }
      const res = await this.#rawRequest('POST', '/internal/v1/bootstrap', body, {
        timeoutMs: DEFAULT_TIMEOUTS.bootstrap,
      })
      this.#bootstrapped = true
      this.#everBootstrapped = true
      return res
    }
    this.#bootstrapped = true
    this.#everBootstrapped = true
    return payload
  }

  #ensureBootedInternal({ waitMs = 5_000, forceEpochIncrement = false } = {}) {
    if (this.#stopping) {
      return Promise.reject(new SchedulerUnavailableError('scheduler client stopped', { reason: 'client_stopped' }))
    }
    if (this.#recoveryPromise) {
      return this.#recoveryPromise
    }

    const work = (async () => {
      if (this.#respawnTimer) {
        clearTimeout(this.#respawnTimer)
        this.#respawnTimer = null
      }

      const bumpEpochForBootstrap = () => {
        if (forceEpochIncrement || this.#everBootstrapped || this.#bootCount > 0) {
          this.#nextEpoch()
        }
      }

      if (this.#manageProcess) {
        const childAlive = this.#child && this.#child.exitCode === null && this.#child.signalCode === null
        if (!childAlive) {
          bumpEpochForBootstrap()
          this.#resetAgent()
          const child = this.#spawnChild()
          await this.#waitForListenerReady(child, waitMs)
          await this.#runBootstrapHook()
          return { ok: true, pid: child.pid, epoch: this.#controllerEpoch }
        }
        // Child exists: verify health & bootstrap state without bumping epoch if already live & bootstrapped.
        try {
          const h = await this.#rawRequest('GET', '/internal/v1/health', null, {
            timeoutMs: DEFAULT_TIMEOUTS.health,
          })
          if (h?.ok) {
            if (!h.bootstrapped && this.#onBootstrap) {
              bumpEpochForBootstrap()
              await this.#runBootstrapHook()
            } else {
              this.#bootstrapped = Boolean(h.bootstrapped || !this.#onBootstrap)
              if (h.bootstrapped) this.#everBootstrapped = true
            }
            return { ok: true, pid: this.#child?.pid ?? null, epoch: this.#controllerEpoch }
          }
        } catch {}
        // Child wedged, unhealthy, or exiting; respawn cleanly with a new epoch and re-bootstrap.
        const old = this.#child
        this.#child = null
        try {
          old?.kill('SIGKILL')
        } catch {}
        this.#resetAgent()
        this.#nextEpoch()
        const child = this.#spawnChild()
        await this.#waitForListenerReady(child, waitMs)
        await this.#runBootstrapHook()
        return { ok: true, pid: child.pid, epoch: this.#controllerEpoch }
      }

      // External sidecar: only advance epoch if it actually requires re-bootstrap.
      const h = await this.#waitForListenerReady(null, waitMs)
      if (!h.bootstrapped && this.#onBootstrap) {
        bumpEpochForBootstrap()
        await this.#runBootstrapHook()
      } else {
        this.#bootstrapped = true
        if (h.bootstrapped) this.#everBootstrapped = true
      }
      return { ok: true, pid: null, epoch: this.#controllerEpoch }
    })()

    let tracked
    tracked = work.finally(() => {
      if (this.#recoveryPromise === tracked) {
        this.#recoveryPromise = null
      }
    })
    this.#recoveryPromise = tracked
    return tracked
  }

  async start({ waitMs = 5_000, startLoops = false } = {}) {
    this.#stopping = false
    const result = await this.#ensureBootedInternal({ waitMs, forceEpochIncrement: false })
    if (startLoops) {
      this.startHeartbeatLoop()
      if (!this.isStandby && this.#onDrain) {
        this.startDrainLoop()
      }
    }
    return result
  }

  boot(options) {
    return this.start(options)
  }

  async ensureReady({ timeoutMs = 5_000, signal } = {}) {
    if (this.#stopping) {
      throw new SchedulerUnavailableError('scheduler client stopped', { reason: 'client_stopped' })
    }
    if (this.#bootstrapped && (!this.#manageProcess || (this.#child && this.#child.exitCode === null))) {
      return { ok: true, pid: this.#child?.pid ?? null, epoch: this.#controllerEpoch }
    }
    return raceWithDeadline(this.#ensureBootedInternal({ waitMs: timeoutMs }), timeoutMs, signal)
  }

  async restart({ waitMs = 5_000 } = {}) {
    if (this.#stopping) {
      throw new SchedulerUnavailableError('scheduler client stopped', { reason: 'client_stopped' })
    }
    if (this.#child) {
      const old = this.#child
      this.#child = null
      try {
        old.kill('SIGTERM')
      } catch {}
    }
    this.#bootstrapped = false
    this.#resetAgent()
    return this.#ensureBootedInternal({ waitMs, forceEpochIncrement: true })
  }

  async #requestWithReconnect(method, endpointPath, bodyObj, { timeoutMs, signal, allowRetry = true } = {}) {
    if (signal?.aborted) throw makeAbortError(signal)
    if (this.#stopping) {
      throw new SchedulerUnavailableError('scheduler client stopped', { reason: 'client_stopped' })
    }

    // If a managed sidecar has not booted or is mid-recovery, bound wait strictly by <=300ms short window.
    if (this.#recoveryPromise || (this.#manageProcess && !this.#child)) {
      if (!this.#autoRestart && this.#bootCount > 0) {
        throw new SchedulerUnavailableError('scheduler sidecar stopped and auto-restart disabled', {
          reason: 'sidecar_down',
        })
      }
      try {
        await raceWithDeadline(
          this.#ensureBootedInternal({ waitMs: this.#reconnectWindowMs, forceEpochIncrement: this.#bootCount > 0 }),
          this.#reconnectWindowMs,
          signal,
        )
      } catch (err) {
        if (isAbortError(err, signal)) throw makeAbortError(signal)
        if (err instanceof SchedulerUnavailableError) throw err
        throw new SchedulerUnavailableError(`scheduler unavailable: ${err.message}`, {
          reason: 'reconnect_failed',
          cause: err,
        })
      }
    }

    try {
      return await this.#rawRequest(method, endpointPath, bodyObj, { timeoutMs, signal })
    } catch (err) {
      if (isAbortError(err, signal)) throw makeAbortError(signal)

      const unbootstrappedRecoverable =
        err instanceof SchedulerApiError &&
        err.status === 503 &&
        err.code === 'scheduler_not_bootstrapped' &&
        Boolean(this.#onBootstrap)
      const transportFailure =
        isTransportError(err) || (err instanceof SchedulerUnavailableError && err.reason === 'endpoint_unresolved')

      if (!allowRetry || (!transportFailure && !unbootstrappedRecoverable)) {
        if (err instanceof SchedulerApiError || err instanceof SchedulerUnavailableError) throw err
        throw new SchedulerUnavailableError(`scheduler unavailable: ${err.message}`, {
          reason: 'transport_error',
          cause: err,
        })
      }

      if (transportFailure) {
        this.#resetAgent()
      }

      const deadline = Date.now() + this.#reconnectWindowMs
      try {
        if (this.#manageProcess) {
          if (!this.#autoRestart && !this.#child) {
            throw new SchedulerUnavailableError('scheduler sidecar exited and auto-restart disabled', {
              reason: 'sidecar_down',
              cause: err,
            })
          }
          await raceWithDeadline(
            this.#ensureBootedInternal({
              waitMs: Math.max(10, deadline - Date.now()),
              forceEpochIncrement: false,
            }),
            Math.max(1, deadline - Date.now()),
            signal,
          )
        } else if (unbootstrappedRecoverable) {
          if (this.#everBootstrapped) this.#nextEpoch()
          await raceWithDeadline(this.#runBootstrapHook(), Math.max(1, deadline - Date.now()), signal)
        } else {
          // External sidecar transient connect failure: short pause then 1 reconnect attempt within <=300ms (epoch unchanged).
          await sleep(Math.min(50, Math.max(10, deadline - Date.now())), signal)
        }
      } catch (recErr) {
        if (isAbortError(recErr, signal)) throw makeAbortError(signal)
        if (recErr instanceof SchedulerUnavailableError) throw recErr
        throw new SchedulerUnavailableError(`scheduler unavailable: ${recErr.message}`, {
          reason: 'reconnect_failed',
          cause: recErr,
        })
      }

      if (signal?.aborted) throw makeAbortError(signal)
      if (Date.now() > deadline) {
        throw new SchedulerUnavailableError(
          `scheduler unavailable: exceeded ${this.#reconnectWindowMs}ms reconnect window`,
          {
            reason: 'reconnect_timeout',
            cause: err,
          },
        )
      }

      // Update controller_epoch on retried acquire/switch/heartbeat/bootstrap if respawn bumped epoch
      let retryBody = bodyObj
      if (retryBody && typeof retryBody === 'object') {
        if (endpointPath === '/internal/v1/schedule/acquire' && retryBody.controller_epoch) {
          retryBody = { ...retryBody, controller_epoch: this.#controllerEpoch }
        } else if (endpointPath === '/internal/v1/schedule/switch' && retryBody.next_attempt?.controller_epoch) {
          retryBody = {
            ...retryBody,
            next_attempt: { ...retryBody.next_attempt, controller_epoch: this.#controllerEpoch },
          }
        } else if (endpointPath === '/internal/v1/schedule/heartbeat' && retryBody.controller_epoch) {
          retryBody = { ...retryBody, controller_epoch: this.#controllerEpoch }
        }
      }

      try {
        return await this.#rawRequest(method, endpointPath, retryBody, { timeoutMs, signal })
      } catch (retryErr) {
        if (isAbortError(retryErr, signal)) throw makeAbortError(signal)
        if (retryErr instanceof SchedulerApiError) {
          if (retryErr.status === 503 && retryErr.code === 'scheduler_not_bootstrapped' && this.#onBootstrap) {
            throw new SchedulerUnavailableError(`scheduler unavailable: ${retryErr.message}`, {
              reason: 'not_bootstrapped',
              cause: retryErr,
            })
          }
          throw retryErr
        }
        if (retryErr instanceof SchedulerUnavailableError) throw retryErr
        throw new SchedulerUnavailableError(`scheduler unavailable: ${retryErr.message}`, {
          reason: 'reconnect_failed',
          cause: retryErr,
        })
      }
    }
  }

  // ==================== 14 /internal/v1/* IPC APIs ====================

  async health({ timeoutMs = DEFAULT_TIMEOUTS.health, signal, tokenOverride } = {}) {
    try {
      return await this.#rawRequest('GET', '/internal/v1/health', null, { timeoutMs, signal, tokenOverride })
    } catch (err) {
      if (isAbortError(err, signal)) throw makeAbortError(signal)
      if (err instanceof SchedulerApiError || err instanceof SchedulerUnavailableError) throw err
      throw new SchedulerUnavailableError(`scheduler health check failed: ${err.message}`, {
        reason: 'health_failed',
        cause: err,
      })
    }
  }

  async bootstrap(payload = {}, { timeoutMs = DEFAULT_TIMEOUTS.bootstrap, signal } = {}) {
    const body = {
      controller_epoch: String(payload.controller_epoch || this.#controllerEpoch),
      role: payload.role || this.#role,
      ...(payload.config_version != null ? { config_version: payload.config_version } : {}),
      config_snapshot: payload.config_snapshot || { pools: [], nodes: [] },
      ...(payload.active_sticky_bindings ? { active_sticky_bindings: payload.active_sticky_bindings } : {}),
      ...(payload.active_penalties ? { active_penalties: payload.active_penalties } : {}),
      ...(payload.initial_telemetry ? { initial_telemetry: payload.initial_telemetry } : {}),
    }
    const res = await this.#requestWithReconnect('POST', '/internal/v1/bootstrap', body, {
      timeoutMs,
      signal,
      allowRetry: true,
    })
    this.#bootstrapped = true
    this.#everBootstrapped = true
    return res
  }

  async syncConfig(payload, { timeoutMs = DEFAULT_TIMEOUTS.syncConfig, signal } = {}) {
    return this.#requestWithReconnect('POST', '/internal/v1/config/sync', payload, {
      timeoutMs,
      signal,
      allowRetry: true,
    })
  }

  async pushTelemetry(nodesOrPayload, { timeoutMs = DEFAULT_TIMEOUTS.pushTelemetry, signal } = {}) {
    const body = Array.isArray(nodesOrPayload)
      ? { nodes: nodesOrPayload }
      : { nodes: Array.isArray(nodesOrPayload?.nodes) ? nodesOrPayload.nodes : [] }
    return this.#requestWithReconnect('POST', '/internal/v1/nodes/telemetry', body, {
      timeoutMs,
      signal,
      allowRetry: true,
    })
  }

  // Note on AbortSignal race: if `signal` aborts while queued in Rust SessionGate, dropping the HTTP
  // socket cancels the Axum handler and fires SessionWaitGuard::drop immediately. In the narrow window
  // where Rust has already reserved a lease and written the response just as `signal` fires before Node
  // reads it, Rust's lease_ttl_ms reaper (120s) bounds recovery and releases both the slot and SessionGate.
  async acquire(request, options = {}) {
    const body = {
      ...request,
      controller_epoch: String(request?.controller_epoch || this.#controllerEpoch),
    }
    const timeoutMs = computeAcquireTimeoutMs({
      timeoutMs: options.timeoutMs,
      no_queue: request?.no_queue,
      sessionQueueTimeoutMs: options.sessionQueueTimeoutMs ?? options.session_queue_timeout_ms,
      sessionBusyWaitMs: options.sessionBusyWaitMs ?? options.session_busy_wait_ms,
      queueWaitMs: options.queueWaitMs ?? options.queue_wait_ms,
    })
    const res = await this.#requestWithReconnect('POST', '/internal/v1/schedule/acquire', body, {
      timeoutMs,
      signal: options.signal,
      allowRetry: true,
    })
    if (this.#autoTrackLeases && res?.lease_id) {
      this.#activeLeases.add(res.lease_id)
    }
    return res
  }

  async switchLease(request, options = {}) {
    const releaseLeaseId = request?.release_lease_id
    const body = {
      ...request,
      next_attempt: request?.next_attempt
        ? {
            ...request.next_attempt,
            controller_epoch: String(request.next_attempt.controller_epoch || this.#controllerEpoch),
          }
        : request?.next_attempt,
    }
    const timeoutMs = computeSwitchTimeoutMs({
      timeoutMs: options.timeoutMs,
      no_queue: request?.next_attempt?.no_queue,
      sessionBusyWaitMs: options.sessionBusyWaitMs ?? options.session_busy_wait_ms,
      queueWaitMs: options.queueWaitMs ?? options.queue_wait_ms,
    })
    try {
      const res = await this.#requestWithReconnect('POST', '/internal/v1/schedule/switch', body, {
        timeoutMs,
        signal: options.signal,
        allowRetry: true,
      })
      if (this.#autoTrackLeases) {
        if (releaseLeaseId) this.#activeLeases.delete(releaseLeaseId)
        if (res?.lease_id) this.#activeLeases.add(res.lease_id)
      }
      return res
    } catch (err) {
      if (this.#autoTrackLeases && releaseLeaseId && err instanceof SchedulerApiError) {
        this.#activeLeases.delete(releaseLeaseId)
      }
      throw err
    }
  }

  async heartbeat(leaseIdsOrPayload, { timeoutMs = DEFAULT_TIMEOUTS.heartbeat, signal } = {}) {
    const body = Array.isArray(leaseIdsOrPayload)
      ? { controller_epoch: this.#controllerEpoch, lease_ids: leaseIdsOrPayload }
      : {
          controller_epoch: String(leaseIdsOrPayload?.controller_epoch || this.#controllerEpoch),
          lease_ids: Array.isArray(leaseIdsOrPayload?.lease_ids) ? leaseIdsOrPayload.lease_ids : [],
        }
    const res = await this.#requestWithReconnect('POST', '/internal/v1/schedule/heartbeat', body, {
      timeoutMs,
      signal,
      allowRetry: true,
    })
    if (Array.isArray(res?.missing)) {
      for (const id of res.missing) this.#activeLeases.delete(id)
    }
    return res
  }

  async commit(leaseIdOrPayload, { timeoutMs = DEFAULT_TIMEOUTS.commit, signal } = {}) {
    const body = typeof leaseIdOrPayload === 'string' ? { lease_id: leaseIdOrPayload } : leaseIdOrPayload
    return this.#requestWithReconnect('POST', '/internal/v1/schedule/commit', body, {
      timeoutMs,
      signal,
      allowRetry: true,
    })
  }

  async release(payloadOrLeaseId, outcomeOrOptions = {}, maybeOptions = {}) {
    let body
    let opts
    if (typeof payloadOrLeaseId === 'string') {
      if (typeof outcomeOrOptions === 'string') {
        body = { lease_id: payloadOrLeaseId, outcome: outcomeOrOptions }
        opts = maybeOptions || {}
      } else {
        body = { lease_id: payloadOrLeaseId, ...(outcomeOrOptions || {}) }
        opts = maybeOptions || {}
      }
    } else {
      body = payloadOrLeaseId || {}
      opts = outcomeOrOptions || {}
    }
    const leaseId = body.lease_id
    try {
      return await this.#requestWithReconnect('POST', '/internal/v1/schedule/release', body, {
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUTS.release,
        signal: opts.signal,
        allowRetry: true,
      })
    } finally {
      if (this.#autoTrackLeases && leaseId) {
        this.#activeLeases.delete(leaseId)
      }
    }
  }

  async explain(request, { timeoutMs = DEFAULT_TIMEOUTS.explain, signal } = {}) {
    const body = {
      ...request,
      controller_epoch: String(request?.controller_epoch || this.#controllerEpoch),
    }
    return this.#requestWithReconnect('POST', '/internal/v1/schedule/explain', body, {
      timeoutMs,
      signal,
      allowRetry: true,
    })
  }

  async drainPersistence(params = {}, { timeoutMs = DEFAULT_TIMEOUTS.drainPersistence, signal } = {}) {
    if (this.isStandby) {
      throw new SchedulerApiError({
        status: 403,
        code: 'standby_drain_forbidden',
        message: 'persistence drain is forbidden in standby role',
        endpoint: '/internal/v1/persistence/drain',
      })
    }
    return this.#requestWithReconnect('POST', '/internal/v1/persistence/drain', params || {}, {
      timeoutMs,
      signal,
      allowRetry: true,
    })
  }

  async querySticky(filter = {}, { timeoutMs = DEFAULT_TIMEOUTS.sticky, signal } = {}) {
    const qs = buildQueryString(filter)
    return this.#requestWithReconnect('GET', `/internal/v1/sticky${qs}`, null, {
      timeoutMs,
      signal,
      allowRetry: true,
    })
  }

  async deleteSticky(filter = {}, { timeoutMs = DEFAULT_TIMEOUTS.sticky, signal } = {}) {
    return this.#requestWithReconnect('DELETE', '/internal/v1/sticky', filter || {}, {
      timeoutMs,
      signal,
      allowRetry: true,
    })
  }

  async unrestNode(nodeKeyOrPayload, { timeoutMs = DEFAULT_TIMEOUTS.unrestNode, signal } = {}) {
    const body = typeof nodeKeyOrPayload === 'string' ? { node_key: nodeKeyOrPayload } : nodeKeyOrPayload
    return this.#requestWithReconnect('POST', '/internal/v1/admin/unrest', body, {
      timeoutMs,
      signal,
      allowRetry: true,
    })
  }

  subscribeEvents({ after, signal, onEvent, onError, onOpen, connectTimeoutMs = DEFAULT_TIMEOUTS.eventsConnect } = {}) {
    const qs = buildQueryString(after ? { after } : {})
    const endpointPath = `/internal/v1/events${qs}`
    const token = this.#resolveToken()
    const headers = {
      accept: 'text/event-stream',
      'cache-control': 'no-cache',
    }
    if (token) headers['x-kin-internal-token'] = token

    let closed = false
    let req = null
    let resRef = null
    let connectTimer = null
    let lastCursor = after ? String(after) : null
    const queue = []
    let waiter = null
    let streamError = null

    let resolveReady
    let rejectReady
    const ready = new Promise((res, rej) => {
      resolveReady = res
      rejectReady = rej
    })
    // Prevent unhandled rejection when caller consumes via AsyncIterator or onError instead of awaiting ready.
    ready.catch(() => {})

    const wakeWaiter = () => {
      if (!waiter) return
      const w = waiter
      waiter = null
      if (queue.length > 0) {
        w.resolve({ value: queue.shift(), done: false })
      } else if (streamError) {
        const err = streamError
        streamError = null
        w.reject(err)
      } else if (closed) {
        w.resolve({ value: undefined, done: true })
      } else {
        waiter = w
      }
    }

    const pushEvent = (ev) => {
      if (ev.id) lastCursor = ev.id
      else if (ev.data && typeof ev.data === 'object' && ev.data.cursor) lastCursor = String(ev.data.cursor)
      try {
        onEvent?.(ev)
      } catch (err) {
        this.#onError?.(err, { phase: 'sse_onEvent' })
      }
      if (!onEvent) {
        queue.push(ev)
        wakeWaiter()
      }
    }

    const clearConnectTimer = () => {
      if (!connectTimer) return
      clearTimeout(connectTimer)
      connectTimer = null
    }

    const fail = (err) => {
      if (closed) return
      closed = true
      clearConnectTimer()
      signal?.removeEventListener('abort', onAbort)
      streamError = err
      rejectReady(err)
      onError?.(err)
      wakeWaiter()
    }

    const close = () => {
      if (closed) return
      closed = true
      clearConnectTimer()
      signal?.removeEventListener('abort', onAbort)
      try {
        resRef?.destroy()
      } catch {}
      try {
        req?.destroy()
      } catch {}
      wakeWaiter()
    }

    const onAbort = () => {
      close()
    }
    if (signal?.aborted) {
      closed = true
      rejectReady(makeAbortError(signal))
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
      let reqOpts
      try {
        reqOpts = this.#buildConnectionOptions(endpointPath, 'GET', headers, { useAgent: false })
      } catch (err) {
        fail(err)
      }
      if (reqOpts && !closed) {
        connectTimer = setTimeout(
          () => {
            connectTimer = null
            const err = new SchedulerUnavailableError(`scheduler SSE connect timeout after ${connectTimeoutMs}ms`, {
              reason: 'sse_timeout',
            })
            try {
              req?.destroy(err)
            } catch {}
            fail(err)
          },
          Math.max(100, connectTimeoutMs),
        )

        req = http.request(reqOpts, (res) => {
          clearConnectTimer()
          resRef = res
          const status = res.statusCode || 0
          if (status !== 200) {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8')
              fail(parseApiError(status, text, res.headers, endpointPath))
            })
            return
          }

          resolveReady({ status, headers: res.headers })
          onOpen?.({ status, headers: res.headers })

          let buf = ''
          let evId = ''
          let evName = 'message'
          let dataLines = []

          const dispatch = () => {
            if (dataLines.length === 0) {
              evId = ''
              evName = 'message'
              return
            }
            const rawData = dataLines.join('\n')
            let parsed = rawData
            if (rawData.startsWith('{') || rawData.startsWith('[')) {
              try {
                parsed = JSON.parse(rawData)
              } catch {}
            }
            pushEvent({
              id: evId || null,
              event: evName || 'message',
              data: parsed,
              rawData,
            })
            evId = ''
            evName = 'message'
            dataLines = []
          }

          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            buf += chunk
            let nlIdx
            while ((nlIdx = buf.indexOf('\n')) !== -1) {
              let line = buf.slice(0, nlIdx)
              buf = buf.slice(nlIdx + 1)
              if (line.endsWith('\r')) line = line.slice(0, -1)
              if (line === '') {
                dispatch()
              } else if (line.startsWith(':')) {
                // SSE heartbeat/comment line — ignored.
              } else if (line.startsWith('id:')) {
                evId = line.slice(3).trim()
              } else if (line.startsWith('event:')) {
                evName = line.slice(6).trim()
              } else if (line.startsWith('data:')) {
                const val = line.slice(5)
                dataLines.push(val.startsWith(' ') ? val.slice(1) : val)
              }
            }
          })
          res.on('end', () => {
            if (dataLines.length > 0) dispatch()
            close()
          })
          res.on('error', (err) => {
            if (closed) return
            fail(
              new SchedulerUnavailableError(`scheduler SSE stream error: ${err.message}`, {
                reason: 'sse_error',
                cause: err,
              }),
            )
          })
        })

        req.once('error', (err) => {
          if (connectTimer) {
            clearTimeout(connectTimer)
            connectTimer = null
          }
          if (closed) return
          if (err instanceof SchedulerUnavailableError || err instanceof SchedulerApiError) {
            fail(err)
          } else {
            fail(
              new SchedulerUnavailableError(`scheduler SSE connection failed: ${err.message}`, {
                reason: 'sse_connect_failed',
                cause: err,
              }),
            )
          }
        })
        req.end()
      }
    }

    return {
      ready,
      close,
      get lastCursor() {
        return lastCursor
      },
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift(), done: false })
            }
            if (streamError) {
              const err = streamError
              streamError = null
              return Promise.reject(err)
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true })
            }
            return new Promise((resolve, reject) => {
              waiter = { resolve, reject }
            })
          },
          return() {
            close()
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    }
  }

  // ==================== Batch Heartbeat Manager (30s) ====================

  trackLease(leaseId) {
    if (leaseId) this.#activeLeases.add(String(leaseId))
  }

  untrackLease(leaseId) {
    if (leaseId) this.#activeLeases.delete(String(leaseId))
  }

  clearTrackedLeases() {
    this.#activeLeases.clear()
  }

  async flushHeartbeat() {
    if (this.#stopping || this.#heartbeatInFlight || this.#activeLeases.size === 0) {
      return { ok: true, skipped: true, renewed: 0 }
    }
    this.#heartbeatInFlight = true
    try {
      return await this.heartbeat([...this.#activeLeases])
    } finally {
      this.#heartbeatInFlight = false
    }
  }

  startHeartbeatLoop(intervalMs = this.#heartbeatIntervalMs) {
    this.stopHeartbeatLoop()
    const ms = Math.max(50, nonNegativeMs(intervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS))
    this.#heartbeatTimer = setInterval(() => {
      if (this.#stopping || this.#activeLeases.size === 0) return
      this.flushHeartbeat().catch((err) => {
        this.#onError?.(err, { phase: 'heartbeat' })
      })
    }, ms)
    this.#heartbeatTimer.unref?.()
  }

  stopHeartbeatLoop() {
    if (!this.#heartbeatTimer) return
    clearInterval(this.#heartbeatTimer)
    this.#heartbeatTimer = null
  }

  // ==================== Throttled /nodes/telemetry Pusher ====================

  enqueueTelemetry(nodeOrNodes) {
    const list = Array.isArray(nodeOrNodes) ? nodeOrNodes : nodeOrNodes ? [nodeOrNodes] : []
    for (const item of list) {
      const key = telemetryNodeKey(item)
      if (!key) continue
      const prev = this.#pendingTelemetry.get(key)
      this.#pendingTelemetry.set(key, prev ? { ...prev, ...item, node_key: key } : { ...item, node_key: key })
    }
    if (this.#pendingTelemetry.size === 0 || this.#stopping) return
    if (!this.#telemetryTimer) {
      this.#telemetryTimer = setTimeout(() => {
        this.#telemetryTimer = null
        this.flushTelemetry().catch((err) => {
          this.#onError?.(err, { phase: 'telemetry' })
        })
      }, this.#telemetryThrottleMs)
      this.#telemetryTimer.unref?.()
    }
  }

  async flushTelemetry() {
    if (this.#telemetryTimer) {
      clearTimeout(this.#telemetryTimer)
      this.#telemetryTimer = null
    }
    if (this.#telemetryInFlight) {
      await this.#telemetryInFlight.catch(() => {})
    }
    if (this.#pendingTelemetry.size === 0) {
      return { ok: true, updated: 0 }
    }
    const batch = [...this.#pendingTelemetry.values()]
    this.#pendingTelemetry.clear()
    const p = this.pushTelemetry(batch)
    this.#telemetryInFlight = p
    try {
      return await p
    } finally {
      if (this.#telemetryInFlight === p) this.#telemetryInFlight = null
      if (this.#pendingTelemetry.size > 0 && !this.#stopping && !this.#telemetryTimer) {
        this.#telemetryTimer = setTimeout(() => {
          this.#telemetryTimer = null
          this.flushTelemetry().catch((err) => {
            this.#onError?.(err, { phase: 'telemetry' })
          })
        }, this.#telemetryThrottleMs)
        this.#telemetryTimer.unref?.()
      }
    }
  }

  stopTelemetryTimer() {
    if (!this.#telemetryTimer) return
    clearTimeout(this.#telemetryTimer)
    this.#telemetryTimer = null
  }

  // ==================== Leader 1s /persistence/drain Loop ====================

  async runDrainTick({ onDrain = this.#onDrain, maxItems = 500 } = {}) {
    if (this.isStandby) {
      return { skipped: 'standby', batches: 0, drained: false }
    }
    if (this.#drainInFlight) {
      return this.#drainInFlight
    }
    const work = (async () => {
      const batch = await this.drainPersistence({ max_items: maxItems })
      const dirty = hasDrainItems(batch)
      if (!dirty) {
        return { drained: false, batches: 0, remaining: Number(batch?.remaining) || 0 }
      }
      if (typeof onDrain === 'function') {
        await onDrain(batch)
      }
      if (batch.batch_id != null) {
        await this.drainPersistence({ ack_batch_id: batch.batch_id, ack_only: true })
      }
      return { drained: true, batches: 1, batchId: batch.batch_id ?? null, remaining: Number(batch?.remaining) || 0 }
    })()
    let tracked
    tracked = work.finally(() => {
      if (this.#drainInFlight === tracked) this.#drainInFlight = null
    })
    this.#drainInFlight = tracked
    return tracked
  }

  async drainAll({ onDrain = this.#onDrain, maxItems = 500, maxBatches = 32 } = {}) {
    if (this.isStandby) {
      return { skipped: 'standby', batches: 0, remaining: 0 }
    }
    let totalBatches = 0
    let remaining = 0
    for (let i = 0; i < maxBatches; i++) {
      const res = await this.runDrainTick({ onDrain, maxItems })
      remaining = res.remaining || 0
      if (!res.drained) break
      totalBatches += res.batches
      if (remaining <= 0) break
    }
    return { batches: totalBatches, remaining }
  }

  startDrainLoop({ onDrain, intervalMs = this.#drainIntervalMs, maxItems = 500 } = {}) {
    if (typeof onDrain === 'function') {
      this.#onDrain = onDrain
    }
    this.stopDrainLoop()
    if (this.isStandby) {
      return false
    }
    const ms = Math.max(50, nonNegativeMs(intervalMs, DEFAULT_DRAIN_INTERVAL_MS))
    this.#drainTimer = setInterval(() => {
      if (this.#stopping || this.isStandby) return
      this.drainAll({ onDrain: this.#onDrain, maxItems, maxBatches: 8 }).catch((err) => {
        this.#onError?.(err, { phase: 'drain' })
      })
    }, ms)
    this.#drainTimer.unref?.()
    return true
  }

  stopDrainLoop() {
    if (!this.#drainTimer) return
    clearInterval(this.#drainTimer)
    this.#drainTimer = null
  }

  async promoteToLeader({ rebootstrap = true, startDrain = true } = {}) {
    this.#role = 'leader'
    if (rebootstrap && this.#onBootstrap) {
      await this.#runBootstrapHook()
    }
    if (startDrain && this.#onDrain) {
      this.startDrainLoop()
    }
  }

  demoteToStandby() {
    this.stopDrainLoop()
    this.#role = 'standby'
  }

  // ==================== Graceful Shutdown ====================

  async shutdown({ drain = true, stopProcess = true, timeoutMs = 2_000 } = {}) {
    this.stopHeartbeatLoop()
    this.stopTelemetryTimer()
    this.stopDrainLoop()
    if (this.#respawnTimer) {
      clearTimeout(this.#respawnTimer)
      this.#respawnTimer = null
    }

    let drainResult = null
    if (drain && !this.isStandby && this.#onDrain && !this.#stopping) {
      try {
        drainResult = await this.drainAll({ onDrain: this.#onDrain })
      } catch (err) {
        this.#onError?.(err, { phase: 'shutdown_drain' })
      }
    }

    this.#stopping = true
    this.#bootstrapped = false
    this.#activeLeases.clear()
    this.#pendingTelemetry.clear()
    this.#removeExitHook()

    // Destroy pooled Keep-Alive sockets BEFORE signalling the sidecar so graceful HTTP/1.1 servers
    // (Axum/Hyper or Node http.Server) do not block waiting on our own idle connections to close.
    try {
      this.#agent?.destroy()
    } catch {}

    const child = this.#child
    this.#child = null
    if (stopProcess && child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        let done = false
        let killTimer = null
        const finish = () => {
          if (done) return
          done = true
          if (killTimer) clearTimeout(killTimer)
          child.removeListener('exit', finish)
          try {
            child.stderr?.destroy()
          } catch {}
          child.unref?.()
          resolve()
        }
        // Keep the event loop referenced while explicitly awaiting managed child exit.
        child.ref?.()
        child.once('exit', finish)
        try {
          child.kill('SIGTERM')
        } catch {
          finish()
          return
        }
        killTimer = setTimeout(
          () => {
            try {
              child.kill('SIGKILL')
            } catch {}
            finish()
          },
          Math.max(100, timeoutMs),
        )
      })
    }

    if (stopProcess && this.#manageProcess) {
      if (this.#paths.transport === 'uds' && this.#paths.socketPath) {
        try {
          fs.rmSync(this.#paths.socketPath, { force: true })
        } catch {}
      }
      if (this.#paths.capFile) {
        try {
          fs.rmSync(this.#paths.capFile, { force: true })
        } catch {}
      }
    }

    return { ok: true, drainResult }
  }

  close(options) {
    return this.shutdown(options)
  }
}

export function createSchedulerClient(options = {}) {
  return new SchedulerClient(options)
}
