import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'

const MAX_BODY = 64 * 1024 * 1024

export function apiKernelPaths(cfg = {}) {
  const dataDir = cfg.paths?.data || cfg.dataDir || path.join(process.cwd(), 'data')
  const project = cfg.paths?.project || process.cwd()
  return {
    socketPath: process.env.KIN_API_KERNEL_SOCK || path.join(dataDir, 'run', 'api-kernel.sock'),
    tokenPath: process.env.KIN_API_KERNEL_TOKEN || path.join(dataDir, 'run', 'api-kernel.token'),
    binPath: process.env.KIN_API_KERNEL_BIN || path.join(project, 'bin', 'kin-api-kernel'),
  }
}

function readToken(tokenPath) {
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim()
  } catch {
    return ''
  }
}

export function ensureApiKernelToken(tokenPath) {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true })
  if (fs.existsSync(tokenPath)) return readToken(tokenPath)
  const token = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(tokenPath, token, { mode: 0o600 })
  return token
}

export function startApiKernelProcess(cfg) {
  const { socketPath, tokenPath, binPath } = apiKernelPaths(cfg)
  if (!fs.existsSync(binPath)) return { ok: false, reason: 'bin_missing', binPath }
  const token = ensureApiKernelToken(tokenPath)
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  try {
    fs.rmSync(socketPath, { force: true })
  } catch {}
  const child = spawn(binPath, ['-socket', socketPath, '-token', token], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return { ok: true, pid: child.pid, socketPath }
}

export function apiKernelHealth(cfg, { timeoutMs = 500 } = {}) {
  const { socketPath, tokenPath } = apiKernelPaths(cfg)
  const token = readToken(tokenPath)
  return new Promise((resolve) => {
    const headers = {}
    if (token) {
      headers['x-kin-internal-token'] = token
      headers['x-internal-token'] = token
    }
    const req = http.request(
      {
        socketPath,
        path: '/internal/health',
        method: 'GET',
        headers,
      },
      (res) => {
        resolve({ ok: res.statusCode === 200, status: res.statusCode })
      },
    )
    req.setTimeout(Math.max(1, timeoutMs), () => {
      req.destroy()
      resolve({ ok: false, reason: 'health_timeout' })
    })
    req.on('error', (err) => resolve({ ok: false, reason: 'health_error', error: err.message, code: err.code }))
    req.end()
  })
}

/** Spawn kin-api-kernel and wait until its unix socket answers /internal/health. */
export async function bootApiKernel(cfg, { waitMs = 8000 } = {}) {
  if (process.env.KIN_CRS_MOCK === '1') {
    ensureApiKernelToken(apiKernelPaths(cfg).tokenPath)
    return { ok: true, skipped: 'mock' }
  }
  ensureApiKernelToken(apiKernelPaths(cfg).tokenPath)
  const started = startApiKernelProcess(cfg)
  if (!started.ok) {
    console.error(`[api-kernel] boot failed: ${started.reason}${started.binPath ? ` (${started.binPath})` : ''}`)
    process.exit(1)
  }
  const deadline = Date.now() + Math.max(200, Number(waitMs) || 8000)
  let last = { ok: false, reason: 'not_ready' }
  while (Date.now() < deadline) {
    last = await apiKernelHealth(cfg)
    if (last.ok) return { ok: true, ...started }
    await new Promise((r) => setTimeout(r, 100))
  }
  console.error('[api-kernel] health timeout', last)
  process.exit(1)
}

export function apiKernelSnapshot(cfg) {
  const { socketPath, binPath } = apiKernelPaths(cfg)
  return {
    bin: fs.existsSync(binPath),
    socket: fs.existsSync(socketPath),
  }
}

export async function forwardApi({
  cfg,
  method = 'POST',
  url,
  headers = {},
  body,
  proxyUrl = '',
  signal,
  timeoutMs = 300_000,
  requestId = crypto.randomUUID(),
  onExecutionStart,
} = {}) {
  const execution = { requestId, started: false, ended: true, reason: 'not_started' }
  if (signal?.aborted) {
    throw Object.assign(new Error('API request aborted before forwarding'), { code: 'ABORT_ERR', execution })
  }
  await onExecutionStart?.({ requestId })
  return new Promise((resolve, reject) => {
    const { socketPath, tokenPath } = apiKernelPaths(cfg)
    const token = readToken(tokenPath)
    const envelope = JSON.stringify({
      method,
      url,
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
      proxy_url: proxyUrl || '',
      request_id: requestId,
    })
    const payload = Buffer.from(envelope)
    const reqHeaders = {
      'content-type': 'application/json',
      'content-length': String(payload.length),
    }
    if (token) {
      reqHeaders['x-kin-internal-token'] = token
      reqHeaders['x-internal-token'] = token
    }
    const started = Date.now()
    const attempt = (left) => {
      let connected = false
      Object.assign(execution, { ended: false, reason: 'connecting' })
      const req = http.request(
        {
          socketPath,
          path: '/internal/forward',
          method: 'POST',
          headers: reqHeaders,
          signal,
        },
        (res) => {
          res.execution = execution
          res.once('aborted', () => {
            if (execution.reason !== 'timeout')
              execution.reason = signal?.aborted ? 'client_aborted' : 'transport_error'
          })
          resolve(res)
        },
      )
      req.once('socket', (socket) => {
        const onConnect = () => {
          connected = true
          Object.assign(execution, { started: true, ended: false, reason: 'in_progress' })
        }
        if (socket.connecting) socket.once('connect', onConnect)
        else if (!socket.destroyed) onConnect()
      })
      const timer = setTimeout(
        () => {
          req.destroy(
            Object.assign(new Error(`api kernel timeout after ${timeoutMs}ms`), { code: 'api_kernel_timeout' }),
          )
        },
        Math.max(1, timeoutMs - (Date.now() - started)),
      )
      timer.unref?.()
      req.once('close', () => clearTimeout(timer))
      req.once('error', (err) => {
        clearTimeout(timer)
        const retryable = !connected && (err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED')
        if (retryable && left > 0 && !signal?.aborted) {
          setTimeout(() => attempt(left - 1), 80)
          return
        }
        Object.assign(
          execution,
          retryable
            ? { started: false, ended: true, reason: 'not_started' }
            : {
                ended: false,
                reason: signal?.aborted
                  ? 'client_aborted'
                  : err?.code === 'api_kernel_timeout'
                    ? 'timeout'
                    : 'transport_error',
              },
        )
        err.execution = execution
        reject(err)
      })
      req.write(payload)
      req.end()
    }
    attempt(15)
  })
}

export async function readApiJson(stream, limit = MAX_BODY) {
  const chunks = []
  let size = 0
  for await (const c of stream) {
    size += c.length
    if (size > limit) throw new Error('api kernel body too large')
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
