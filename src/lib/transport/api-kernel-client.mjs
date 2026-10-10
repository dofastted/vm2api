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

export function apiKernelSnapshot(cfg) {
  const { socketPath, binPath } = apiKernelPaths(cfg)
  return {
    bin: fs.existsSync(binPath),
    socket: fs.existsSync(socketPath),
  }
}

export function forwardApi({
  cfg,
  method = 'POST',
  url,
  headers = {},
  body,
  proxyUrl = '',
  signal,
  timeoutMs = 300_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const { socketPath, tokenPath } = apiKernelPaths(cfg)
    const token = readToken(tokenPath)
    const envelope = JSON.stringify({
      method,
      url,
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
      proxy_url: proxyUrl || '',
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
      const req = http.request(
        {
          socketPath,
          path: '/internal/forward',
          method: 'POST',
          headers: reqHeaders,
          signal,
        },
        (res) => resolve(res),
      )
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
        const retryable = err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED'
        if (retryable && left > 0 && !signal?.aborted) {
          setTimeout(() => attempt(left - 1), 80)
          return
        }
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
