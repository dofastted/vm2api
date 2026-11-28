import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveGlobalUnifiedPreset } from '../identity/system-prompt-spec.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const MAX_BODY = 64 * 1024 * 1024

const keepAliveAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
  maxFreeSockets: 16,
})

// Track lazily-started sidecars keyed by socketPath so concurrent requests share one process.
const managedProcesses = new Map()
const readyPromises = new Map()
const tokenCache = new Map()
let exitHookInstalled = false

export function protoFrontMode() {
  const raw = String(process.env.KIN_PROTO_FRONT || 'node')
    .trim()
    .toLowerCase()
  if (raw === 'go' || raw === 'shadow') return raw
  return 'node'
}

export function isProtoFrontEnabled() {
  return protoFrontMode() !== 'node'
}

export function protoFrontPaths(cfg = {}) {
  const project = cfg?.paths?.project || process.cwd()
  const dataDir = cfg?.paths?.data || cfg?.dataDir || path.join(project, 'data')
  const projectBin = path.join(project, 'bin', 'kin-proto-front')
  const repoBin = path.join(REPO_ROOT, 'bin', 'kin-proto-front')
  const binPath = process.env.KIN_PROTO_FRONT_BIN || (fs.existsSync(projectBin) ? projectBin : repoBin)
  return {
    socketPath: process.env.KIN_PROTO_FRONT_SOCK || path.join(dataDir, 'run', 'proto-front.sock'),
    tokenPath: process.env.KIN_PROTO_FRONT_TOKEN || path.join(dataDir, 'run', 'proto-front.token'),
    binPath,
  }
}

function readToken(tokenPath) {
  if (tokenCache.has(tokenPath)) return tokenCache.get(tokenPath)
  try {
    const tok = fs.readFileSync(tokenPath, 'utf8').trim()
    if (tok) tokenCache.set(tokenPath, tok)
    return tok
  } catch {
    return ''
  }
}

export function ensureProtoFrontToken(tokenPath) {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true })
  if (fs.existsSync(tokenPath)) return readToken(tokenPath)
  const token = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(tokenPath, token, { mode: 0o600 })
  tokenCache.set(tokenPath, token)
  return token
}

function installExitCleanup() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const entry of managedProcesses.values()) {
      try {
        entry.child?.kill('SIGTERM')
      } catch {}
      try {
        if (entry.socketPath) fs.rmSync(entry.socketPath, { force: true })
      } catch {}
    }
    managedProcesses.clear()
  })
}

export function startProtoFrontProcess(cfg, { detached = false } = {}) {
  const { socketPath, tokenPath, binPath } = protoFrontPaths(cfg)
  if (!fs.existsSync(binPath)) return { ok: false, reason: 'bin_missing', binPath }
  const token = ensureProtoFrontToken(tokenPath)
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  try {
    fs.rmSync(socketPath, { force: true })
  } catch {}
  const child = spawn(binPath, ['-socket', socketPath, '-token', token], {
    detached,
    stdio: 'ignore',
    windowsHide: true,
  })
  if (detached) {
    child.unref()
  } else {
    installExitCleanup()
    child.unref()
    managedProcesses.set(socketPath, { child, socketPath })
    child.once('exit', () => {
      if (managedProcesses.get(socketPath)?.child === child) {
        managedProcesses.delete(socketPath)
        readyPromises.delete(socketPath)
      }
    })
  }
  return { ok: true, pid: child.pid, socketPath }
}

export function protoFrontHealth(cfg, { timeoutMs = 500 } = {}) {
  const { socketPath, tokenPath } = protoFrontPaths(cfg)
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
        agent: keepAliveAgent,
      },
      (res) => {
        res.resume()
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

export async function bootProtoFront(cfg, { waitMs = 5000, detached = true, fatal = false } = {}) {
  if (!isProtoFrontEnabled()) return { ok: true, skipped: 'mode_node' }
  const { socketPath, tokenPath } = protoFrontPaths(cfg)
  ensureProtoFrontToken(tokenPath)
  const existing = await protoFrontHealth(cfg, { timeoutMs: 250 })
  if (existing.ok) return { ok: true, reused: true, socketPath }

  const started = startProtoFrontProcess(cfg, { detached })
  if (!started.ok) {
    if (fatal) {
      console.error(`[proto-front] boot failed: ${started.reason}${started.binPath ? ` (${started.binPath})` : ''}`)
      process.exit(1)
    }
    return started
  }
  const deadline = Date.now() + Math.max(200, Number(waitMs) || 5000)
  let last = { ok: false, reason: 'not_ready' }
  while (Date.now() < deadline) {
    last = await protoFrontHealth(cfg, { timeoutMs: 300 })
    if (last.ok) return { ok: true, ...started }
    await new Promise((r) => setTimeout(r, 40))
  }
  if (fatal) {
    console.error('[proto-front] health timeout', last)
    process.exit(1)
  }
  return { ok: false, reason: 'health_timeout', last }
}

export async function ensureProtoFront(cfg) {
  const { socketPath } = protoFrontPaths(cfg)
  let pending = readyPromises.get(socketPath)
  if (!pending) {
    pending = bootProtoFront(cfg, { waitMs: 5000, detached: false, fatal: false }).then((res) => {
      if (!res.ok) readyPromises.delete(socketPath)
      return res
    })
    readyPromises.set(socketPath, pending)
  }
  return pending
}

export function shutdownProtoFront(socketPath = null) {
  for (const [sock, entry] of managedProcesses.entries()) {
    if (socketPath && sock !== socketPath) continue
    try {
      entry.child?.kill('SIGTERM')
    } catch {}
    try {
      fs.rmSync(sock, { force: true })
    } catch {}
    managedProcesses.delete(sock)
    readyPromises.delete(sock)
  }
}

export function protoFrontSnapshot(cfg) {
  const { socketPath, binPath } = protoFrontPaths(cfg)
  return {
    mode: protoFrontMode(),
    bin: fs.existsSync(binPath),
    socket: fs.existsSync(socketPath),
  }
}

function normalizeHeadersMap(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (v == null || v === '') continue
    out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v)
  }
  return out
}

function normalizeRoutingForGo(routing = {}, endpointBodyPolicy = '') {
  const compat = routing?.compatibility || {}
  const codex = routing?.codex || {}
  const gemini = routing?.gemini || {}
  const sticky = routing?.sticky || {}
  const unifiedPreset = resolveGlobalUnifiedPreset(routing)
  return {
    compatibility: {
      official_cc_passthrough: compat.official_cc_passthrough === true,
      ...(typeof compat.detect_proxied_official_cc === 'boolean'
        ? { detect_proxied_official_cc: compat.detect_proxied_official_cc }
        : {}),
      claude_code_only: compat.claude_code_only === true,
      crag_persona_preset: unifiedPreset,
      persona_preset: unifiedPreset,
      craggemini_persona_preset: String(compat.craggemini_persona_preset || ''),
      craggemini_system_prompt: String(compat.craggemini_system_prompt || ''),
      craggemini_prompt_normalization: String(compat.craggemini_prompt_normalization || ''),
      cache_ttl: String(compat.cache_ttl || ''),
      ...(typeof compat.crag_fold_history_system === 'boolean'
        ? { crag_fold_history_system: compat.crag_fold_history_system }
        : {}),
    },
    codex: {
      ...(typeof codex.enabled === 'boolean' ? { enabled: codex.enabled } : {}),
      ...(typeof codex.official_passthrough === 'boolean' ? { official_passthrough: codex.official_passthrough } : {}),
      ...(codex.protocols && typeof codex.protocols === 'object' ? { protocols: codex.protocols } : {}),
      ...(codex.clients && typeof codex.clients === 'object' ? { clients: codex.clients } : {}),
    },
    gemini: {
      ...(typeof gemini.enabled === 'boolean' ? { enabled: gemini.enabled } : {}),
      ...(typeof gemini.official_passthrough === 'boolean'
        ? { official_passthrough: gemini.official_passthrough }
        : {}),
      ...(gemini.protocols && typeof gemini.protocols === 'object' ? { protocols: gemini.protocols } : {}),
    },
    sticky: {
      outbound_session: String(sticky.outbound_session || ''),
    },
    endpoint_body_policy: String(endpointBodyPolicy || ''),
  }
}

async function postProtoFront(cfg, endpoint, bodyObj, { timeoutMs = 15_000, signal } = {}) {
  const ready = await ensureProtoFront(cfg)
  if (!ready.ok) {
    throw Object.assign(new Error(`proto-front unavailable: ${ready.reason || 'boot_failed'}`), {
      code: 'proto_front_unavailable',
      details: ready,
    })
  }
  const { socketPath, tokenPath } = protoFrontPaths(cfg)
  const token = readToken(tokenPath)
  const payload = Buffer.from(JSON.stringify(bodyObj))
  const reqHeaders = {
    'content-type': 'application/json',
    'content-length': String(payload.length),
  }
  if (token) {
    reqHeaders['x-kin-internal-token'] = token
    reqHeaders['x-internal-token'] = token
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: endpoint,
        method: 'POST',
        headers: reqHeaders,
        agent: keepAliveAgent,
        signal,
      },
      (res) => {
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > MAX_BODY) {
            req.destroy(new Error('proto-front response too large'))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve(JSON.parse(text))
          } catch (err) {
            reject(Object.assign(new Error(`proto-front invalid JSON: ${err.message}`), { raw: text.slice(0, 200) }))
          }
        })
      },
    )
    const timer = setTimeout(
      () => {
        req.destroy(
          Object.assign(new Error(`proto-front timeout after ${timeoutMs}ms`), { code: 'proto_front_timeout' }),
        )
      },
      Math.max(100, timeoutMs),
    )
    timer.unref?.()
    req.once('close', () => clearTimeout(timer))
    req.once('error', (err) => {
      clearTimeout(timer)
      if (err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED') {
        readyPromises.delete(socketPath)
      }
      reject(err)
    })
    req.write(payload)
    req.end()
  })
}

export async function compileWithProtoFront({
  cfg,
  inboundProtocol,
  targetFamily,
  handoffMode = '',
  reqPath = '',
  headers = {},
  body = {},
  routing = {},
  endpointBodyPolicy = '',
  slotCapabilities = [],
  outboundSessionId = '',
  routeModel = '',
  routeStream = undefined,
  timeoutMs = 15_000,
  signal,
} = {}) {
  return postProtoFront(
    cfg,
    '/internal/v1/compile',
    {
      inbound_protocol: inboundProtocol,
      target_family: targetFamily,
      ...(handoffMode ? { handoff_mode: handoffMode } : {}),
      path: reqPath,
      headers: normalizeHeadersMap(headers),
      body,
      routing: normalizeRoutingForGo(routing, endpointBodyPolicy),
      ...(slotCapabilities?.length ? { slot_capabilities: slotCapabilities } : {}),
      ...(outboundSessionId ? { outbound_session_id: outboundSessionId } : {}),
      ...(routeModel ? { route_model: routeModel } : {}),
      ...(typeof routeStream === 'boolean' ? { route_stream: routeStream } : {}),
    },
    { timeoutMs, signal },
  )
}

export async function transcodeWithProtoFront({
  cfg,
  upstreamProtocol,
  inboundProtocol,
  model = '',
  stream = false,
  payload = '',
  restoreContext = undefined,
  timeoutMs = 15_000,
  signal,
} = {}) {
  return postProtoFront(
    cfg,
    '/internal/v1/transcode',
    {
      upstream_protocol: upstreamProtocol,
      inbound_protocol: inboundProtocol,
      model,
      stream: Boolean(stream),
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}),
      ...(restoreContext ? { restore_context: restoreContext } : {}),
    },
    { timeoutMs, signal },
  )
}
