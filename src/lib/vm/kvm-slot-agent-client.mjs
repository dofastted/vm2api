/**
 * Host-side authenticated RPC client for the guest-resident root `kin-slot-agent`.
 *
 * Wire contract (SSOT shared with `docker/kin-kvm/guest/kin-slot-agent`):
 *   - Transport: newline-delimited JSON (`\n`) over Unix Domain Socket (compatible with
 *     both `socat` host vsock forward `/slot/kvm/agent.sock` and `virtio-serial` chardev).
 *   - Request:  {"id":"<req_id>","token":"<64-hex>","op":"<op>","params":{...}}\n
 *   - Response: {"id":"<req_id>","ok":true,"result":{...}}\n
 *            or {"id":"<req_id>","ok":false,"error":"<code>","message":"<msg>"}\n
 *   - Limits: max single JSON line 2 MiB; max decoded payload content 1 MiB.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export const AGENT_MAX_LINE_BYTES = 2 * 1024 * 1024
export const AGENT_MAX_CONTENT_BYTES = 1 * 1024 * 1024
export const AGENT_DEFAULT_TIMEOUT_MS = 10_000

const TOKEN_RE = /^[a-f0-9]{64}$/
const SHA256_RE = /^[a-f0-9]{64}$/
const SAFE_PRESET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/
const SAFE_REL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const RESERVED_PUBLISH_NAMES = new Set(['sync-pending', 'managed', 'lock'])
const SYNC_TARGETS = new Set(['credentials', 'kernel_config', 'worker_config', 'managed_preset'])
const DEFAULT_SLOT_SYNC_TARGETS = Object.freeze(['kernel_config', 'worker_config', 'credentials', 'managed_preset'])
const PUBLISH_SCOPES = new Set(['license', 'host'])
const MUTATE_SCOPES = new Set(['license', 'host', 'all'])

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function encodeContentEntry({ content, contentB64, content_b64, sha256 }) {
  const b64Input = contentB64 ?? content_b64
  let rawBytes
  if (content !== undefined) {
    rawBytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
  } else if (typeof b64Input === 'string') {
    rawBytes = Buffer.from(b64Input, 'base64')
  } else {
    throw new Error('content or content_b64 is required')
  }
  if (rawBytes.length > AGENT_MAX_CONTENT_BYTES) {
    throw new Error(`payload exceeds ${AGENT_MAX_CONTENT_BYTES} byte limit (${rawBytes.length} bytes)`)
  }
  const computedSha = sha256Hex(rawBytes)
  if (sha256 !== undefined && sha256 !== null && sha256 !== '') {
    const expected = String(sha256).trim().toLowerCase()
    if (!SHA256_RE.test(expected) || expected !== computedSha) {
      throw new Error(`payload sha256 mismatch: expected ${expected}, computed ${computedSha}`)
    }
  }
  return {
    content_b64: rawBytes.toString('base64'),
    sha256: computedSha,
  }
}

function normalizePublishFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('files must be a non-empty array')
  }
  return files.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('file entry must be an object')
    const rel = String(entry.rel || '').trim()
    if (!SAFE_REL_NAME_RE.test(rel) || RESERVED_PUBLISH_NAMES.has(rel.toLowerCase())) {
      throw new Error(`unsafe relative file name: ${rel}`)
    }
    const encoded = encodeContentEntry(entry)
    return { rel, ...encoded }
  })
}

export function readSlotAgentToken(kvmDir) {
  if (!kvmDir) return ''
  try {
    const raw = fs.readFileSync(path.join(kvmDir, '.agent-token'), 'utf8').trim().toLowerCase()
    return TOKEN_RE.test(raw) ? raw : ''
  } catch {
    return ''
  }
}

/**
 * Create or load the per-slot 64-hex `0600` authentication token shared between the host
 * control plane and the guest `kin-slot-agent` (stored under `<kvmDir>/.agent-token`).
 */
export function ensureSlotAgentToken(kvmDir) {
  if (!kvmDir) throw new Error('kvmDir is required')
  fs.mkdirSync(kvmDir, { recursive: true, mode: 0o700 })
  const tokenPath = path.join(kvmDir, '.agent-token')
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim().toLowerCase()
    if (TOKEN_RE.test(existing)) {
      if (process.platform !== 'win32') fs.chmodSync(tokenPath, 0o600)
      return existing
    }
  } catch {}
  const token = crypto.randomBytes(32).toString('hex')
  const tmp = `${tokenPath}.tmp.${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, tokenPath)
  return token
}

export function callAgentRpc({
  socketPath,
  token,
  op,
  params = {},
  id = crypto.randomUUID(),
  timeoutMs = AGENT_DEFAULT_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    const sockPath = String(socketPath || '').trim()
    const cleanToken = String(token || '')
      .trim()
      .toLowerCase()
    const cleanOp = String(op || '').trim()
    const reqId = String(id || '').trim()

    if (!sockPath) {
      return resolve({ ok: false, id: reqId, error: 'invalid_socket', message: 'socketPath is required' })
    }
    if (!TOKEN_RE.test(cleanToken)) {
      return resolve({ ok: false, id: reqId, error: 'invalid_token', message: 'token must be 64 lowercase hex chars' })
    }
    if (!cleanOp || !reqId) {
      return resolve({ ok: false, id: reqId, error: 'invalid_request', message: 'op and id are required' })
    }

    const line = `${JSON.stringify({ id: reqId, token: cleanToken, op: cleanOp, params })}\n`
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (lineBytes > AGENT_MAX_LINE_BYTES) {
      return resolve({
        ok: false,
        id: reqId,
        error: 'request_too_large',
        message: `RPC line exceeds ${AGENT_MAX_LINE_BYTES} bytes (${lineBytes})`,
      })
    }

    let settled = false
    let rxChunks = []
    let rxBytes = 0
    const sock = net.createConnection({ path: sockPath })

    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.removeAllListeners()
      try {
        sock.destroy()
      } catch {}
      resolve(outcome)
    }

    const timer = setTimeout(
      () => {
        finish({
          ok: false,
          id: reqId,
          error: 'agent_timeout',
          message: `kin-slot-agent RPC '${cleanOp}' timed out after ${timeoutMs}ms`,
        })
      },
      Math.max(10, Number(timeoutMs) || AGENT_DEFAULT_TIMEOUT_MS),
    )
    timer.unref?.()

    sock.on('connect', () => {
      sock.write(line, 'utf8')
    })

    sock.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      rxBytes += buf.length
      if (rxBytes > AGENT_MAX_LINE_BYTES) {
        return finish({
          ok: false,
          id: reqId,
          error: 'response_too_large',
          message: `kin-slot-agent response exceeded ${AGENT_MAX_LINE_BYTES} bytes`,
        })
      }
      rxChunks.push(buf)
      const nlIdx = buf.indexOf(0x0a)
      if (nlIdx === -1) return

      const full = Buffer.concat(rxChunks, rxBytes)
      const firstNl = full.indexOf(0x0a)
      const rawLine = full.subarray(0, firstNl).toString('utf8').replace(/\r$/, '')
      let parsed
      try {
        parsed = JSON.parse(rawLine)
      } catch (err) {
        return finish({
          ok: false,
          id: reqId,
          error: 'invalid_response_json',
          message: `failed to parse agent response: ${err?.message || err}`,
        })
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return finish({ ok: false, id: reqId, error: 'invalid_response', message: 'agent response is not an object' })
      }
      if (parsed.id !== reqId) {
        return finish({
          ok: false,
          id: reqId,
          error: 'agent_id_mismatch',
          message: `response id '${parsed.id}' does not match request id '${reqId}'`,
        })
      }
      if (parsed.ok === true) {
        return finish({ ok: true, id: reqId, result: parsed.result ?? {} })
      }
      return finish({
        ok: false,
        id: reqId,
        error: String(parsed.error || 'agent_error'),
        message: String(parsed.message || ''),
      })
    })

    sock.on('error', (err) => {
      finish({
        ok: false,
        id: reqId,
        error: err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED' ? 'agent_unreachable' : 'agent_transport_error',
        message: String(err?.message || err),
      })
    })

    sock.on('end', () => {
      if (!settled) {
        finish({
          ok: false,
          id: reqId,
          error: 'agent_eof',
          message: 'kin-slot-agent closed connection before sending response line',
        })
      }
    })
  })
}

export function createKvmSlotAgentClient({ socketPath, token, timeoutMs = AGENT_DEFAULT_TIMEOUT_MS }) {
  const invoke = (op, params, opts = {}) =>
    callAgentRpc({
      socketPath,
      token,
      op,
      params,
      id: opts.id,
      timeoutMs: opts.timeoutMs ?? timeoutMs,
    })

  return {
    syncFile({ target, name, content, contentB64, content_b64, sha256 } = {}, opts = {}) {
      const cleanTarget = String(target || '').trim()
      if (!SYNC_TARGETS.has(cleanTarget)) {
        return Promise.resolve({
          ok: false,
          error: 'invalid_target',
          message: `unsupported sync_file target: ${cleanTarget}`,
        })
      }
      const params = { target: cleanTarget }
      if (cleanTarget === 'managed_preset') {
        const cleanName = String(name || '').trim()
        if (!SAFE_PRESET_NAME_RE.test(cleanName)) {
          return Promise.resolve({
            ok: false,
            error: 'invalid_preset_name',
            message: `unsafe managed_preset filename: ${cleanName}`,
          })
        }
        params.name = cleanName
      } else if (name != null && name !== '') {
        params.name = String(name).trim()
      }
      try {
        Object.assign(params, encodeContentEntry({ content, contentB64, content_b64, sha256 }))
      } catch (err) {
        return Promise.resolve({ ok: false, error: 'invalid_payload', message: String(err?.message || err) })
      }
      return invoke('sync_file', params, opts)
    },

    publishSubscription({ scope = 'license', files } = {}, opts = {}) {
      const cleanScope = String(scope || '').trim()
      if (!PUBLISH_SCOPES.has(cleanScope)) {
        return Promise.resolve({ ok: false, error: 'invalid_scope', message: `invalid publish scope: ${cleanScope}` })
      }
      let normalized
      try {
        normalized = normalizePublishFiles(files)
      } catch (err) {
        return Promise.resolve({ ok: false, error: 'invalid_payload', message: String(err?.message || err) })
      }
      return invoke('publish', { scope: cleanScope, files: normalized }, opts)
    },

    publishUniversal({ scope = 'license', files } = {}, opts = {}) {
      const cleanScope = String(scope || 'license').trim()
      if (!PUBLISH_SCOPES.has(cleanScope)) {
        return Promise.resolve({
          ok: false,
          error: 'invalid_scope',
          message: `invalid publish_universal scope: ${cleanScope}`,
        })
      }
      let normalized
      try {
        normalized = normalizePublishFiles(files)
      } catch (err) {
        return Promise.resolve({ ok: false, error: 'invalid_payload', message: String(err?.message || err) })
      }
      return invoke('publish_universal', { scope: cleanScope, files: normalized }, opts)
    },

    blockSubscription({ scope = 'all', reason = '' } = {}, opts = {}) {
      const cleanScope = String(scope || 'all').trim()
      if (!MUTATE_SCOPES.has(cleanScope)) {
        return Promise.resolve({ ok: false, error: 'invalid_scope', message: `invalid block scope: ${cleanScope}` })
      }
      const params = { scope: cleanScope }
      if (reason) params.reason = String(reason)
      return invoke('block', params, opts)
    },

    clearSubscription({ scope = 'all' } = {}, opts = {}) {
      const cleanScope = String(scope || 'all').trim()
      if (!MUTATE_SCOPES.has(cleanScope)) {
        return Promise.resolve({ ok: false, error: 'invalid_scope', message: `invalid clear scope: ${cleanScope}` })
      }
      return invoke('clear', { scope: cleanScope }, opts)
    },

    status(opts = {}) {
      return invoke('status', {}, opts)
    },

    restartCrag(opts = {}) {
      return invoke('restart_crag', {}, opts)
    },

    coreCheck({ expectedSha256 } = {}, opts = {}) {
      const params = {}
      if (expectedSha256 != null && expectedSha256 !== '') {
        const cleanSha = String(expectedSha256).trim().toLowerCase()
        if (!SHA256_RE.test(cleanSha)) {
          return Promise.resolve({
            ok: false,
            error: 'invalid_sha256',
            message: 'expected_sha256 must be 64 lowercase hex chars',
          })
        }
        params.expected_sha256 = cleanSha
      }
      return invoke('core_check', params, opts)
    },
  }
}

function readRegularFileBytes(filePath) {
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile()) return null
    return fs.readFileSync(filePath)
  } catch {
    return null
  }
}

export function resolveSlotAgentConnection(projectRoot, vm, opts = {}) {
  const vmId = String(vm?.id || vm?.vmId || '').trim()
  const kvmDir = opts.kvmDir || (projectRoot && vmId ? path.join(projectRoot, 'vms', vmId, 'kvm') : '')
  const socketPath = String(opts.socketPath || (kvmDir ? path.join(kvmDir, 'agent.sock') : '')).trim()
  const token = String(opts.token || (kvmDir ? readSlotAgentToken(kvmDir) : ''))
    .trim()
    .toLowerCase()
  return { kvmDir, socketPath, token }
}

/**
 * Push host-authored slot files (`kernel.json`, `worker.json`, `.claude/credentials.json`,
 * `managed-settings.d/*.json`) atomically to the guest `kin-slot-agent` over `agent.sock`.
 * Missing optional host files are skipped cleanly; any RPC rejection fails closed.
 */
export async function syncCustomKvmSlotFiles(projectRoot, vm, opts = {}) {
  const vmId = String(vm?.id || vm?.vmId || '').trim()
  let agent = opts.client || null
  if (!agent) {
    const conn = resolveSlotAgentConnection(projectRoot, vm, opts)
    if (!conn.socketPath) {
      return {
        ok: false,
        error: 'agent_socket_missing',
        message: 'KVM slot agent socket path is unavailable',
        synced: [],
      }
    }
    if (!TOKEN_RE.test(conn.token)) {
      return {
        ok: false,
        error: 'agent_token_missing',
        message: 'KVM slot agent token is missing or invalid',
        synced: [],
      }
    }
    agent = createKvmSlotAgentClient({
      socketPath: conn.socketPath,
      token: conn.token,
      timeoutMs: opts.timeoutMs ?? AGENT_DEFAULT_TIMEOUT_MS,
    })
  }

  const slotBase = projectRoot && vmId ? path.join(projectRoot, 'vms', vmId) : ''
  const runDir = opts.runDir || (slotBase ? path.join(slotBase, 'run') : '')
  const homeDir = opts.homeDir || (slotBase ? path.join(slotBase, 'cli-home') : '')
  const computerDir = opts.computerDir || (slotBase ? path.join(slotBase, 'kvm', 'fingerprint') : '')
  const targetList = Array.isArray(opts.targets) && opts.targets.length ? opts.targets : DEFAULT_SLOT_SYNC_TARGETS
  const required = new Set(Array.isArray(opts.requiredTargets) ? opts.requiredTargets : [])
  const rpcOpts = opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}
  const synced = []

  for (const target of targetList) {
    if (target === 'kernel_config') {
      const content = runDir ? readRegularFileBytes(path.join(runDir, 'kernel.json')) : null
      if (content && content.length > 0) {
        const res = await agent.syncFile({ target: 'kernel_config', content }, rpcOpts)
        if (!res.ok) return { ok: false, target, error: res.error, message: res.message, synced }
        synced.push('kernel_config')
      } else if (required.has(target)) {
        return {
          ok: false,
          target,
          error: `${target}_missing`,
          message: 'Required host kernel.json is missing or empty',
          synced,
        }
      }
      continue
    }
    if (target === 'worker_config') {
      const content = runDir ? readRegularFileBytes(path.join(runDir, 'worker.json')) : null
      if (content && content.length > 0) {
        const res = await agent.syncFile({ target: 'worker_config', content }, rpcOpts)
        if (!res.ok) return { ok: false, target, error: res.error, message: res.message, synced }
        synced.push('worker_config')
      } else if (required.has(target)) {
        return {
          ok: false,
          target,
          error: `${target}_missing`,
          message: 'Required host worker.json is missing or empty',
          synced,
        }
      }
      continue
    }
    if (target === 'credentials') {
      const claudeDir = homeDir ? path.join(homeDir, '.claude') : ''
      const content = claudeDir
        ? readRegularFileBytes(path.join(claudeDir, 'credentials.json')) ||
          readRegularFileBytes(path.join(claudeDir, '.credentials.json'))
        : null
      if (content && content.length > 0) {
        const res = await agent.syncFile({ target: 'credentials', content }, rpcOpts)
        if (!res.ok) return { ok: false, target, error: res.error, message: res.message, synced }
        synced.push('credentials')
      } else if (required.has(target)) {
        return {
          ok: false,
          target,
          error: `${target}_missing`,
          message: 'Required host credentials.json is missing or empty',
          synced,
        }
      }
      continue
    }
    if (target === 'managed_preset') {
      const presetDir = computerDir ? path.join(computerDir, 'system', 'etc', 'claude-code', 'managed-settings.d') : ''
      let names = []
      if (presetDir) {
        try {
          const st = fs.lstatSync(presetDir)
          if (!st.isSymbolicLink() && st.isDirectory()) {
            names = fs.readdirSync(presetDir).sort()
          }
        } catch {}
      }
      let pushedPresets = 0
      for (const name of names) {
        if (!SAFE_PRESET_NAME_RE.test(name)) continue
        const content = readRegularFileBytes(path.join(presetDir, name))
        if (!content || content.length === 0) continue
        const res = await agent.syncFile({ target: 'managed_preset', name, content }, rpcOpts)
        if (!res.ok)
          return { ok: false, target: `managed_preset:${name}`, error: res.error, message: res.message, synced }
        synced.push(`managed_preset:${name}`)
        pushedPresets += 1
      }
      if (pushedPresets === 0 && required.has(target)) {
        return {
          ok: false,
          target,
          error: `${target}_missing`,
          message: 'Required host managed_preset files are missing or empty',
          synced,
        }
      }
    }
  }

  return { ok: true, synced }
}
