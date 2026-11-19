/**
 * One GPT slot presents as one official Codex install: every upstream call it makes carries the
 * same installation UUID, client identity and workstation environment. Caller-side device data
 * is only logged locally, never forwarded.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_CODEX_USER_AGENT, normalizeCodexRouting } from './codex-route.mjs'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// macOS builds reported by real Codex Desktop clients; each slot pins one.
const MACOS_VERSIONS = Object.freeze([
  '26.3.0',
  '26.3.1',
  '26.5.0',
  '26.5.1',
  '26.5.2',
  '26.6.1',
  '26.6.2',
  '27.0.0',
  '27.0.1',
])
const ACCOUNT_NAMES = Object.freeze([
  'alex',
  'ben',
  'chris',
  'daniel',
  'emily',
  'grace',
  'henry',
  'jack',
  'james',
  'jason',
  'kevin',
  'laura',
  'lucas',
  'mark',
  'matt',
  'mike',
  'nick',
  'olivia',
  'peter',
  'ryan',
  'sam',
  'sarah',
  'tom',
  'will',
])
const MAC_OS_RE = /\(Mac OS [0-9.]+; /

/** The slot's installation UUID (`run/codex-installation-id`); minted once, never from VM or hardware data. */
export function codexInstallationId(projectRoot, vmId) {
  const runDir = path.join(projectRoot, 'vms', vmId, 'run')
  const file = path.join(runDir, 'codex-installation-id')
  let id = ''
  try {
    id = fs.readFileSync(file, 'utf8').trim()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (UUID_V4_RE.test(id)) return id.toLowerCase()
  id = crypto.randomUUID()
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${id}\n`, { mode: 0o600 })
  return id
}

function pick(list, seed, salt) {
  const n = crypto.createHash('sha256').update(`${salt}:${seed}`).digest().readUInt32BE(0)
  return list[n % list.length]
}

// Paths without the routing snapshot (quota, catalog, OAuth refresh) reuse the UA the last hop wrote.
function baseUserAgent(projectRoot, vmId, routing) {
  if (routing) return normalizeCodexRouting(routing.codex).user_agent
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'vms', vmId, 'run', 'codex-kernel.json'), 'utf8'))
    if (typeof cfg?.user_agent === 'string' && cfg.user_agent.trim()) return cfg.user_agent.trim()
  } catch {}
  return DEFAULT_CODEX_USER_AGENT
}

/**
 * Stable per-slot client identity. The macOS build in a `Mac OS` User-Agent is pinned per slot, so
 * re-deriving from an already pinned UA yields the same value.
 */
export function codexSlotIdentity(projectRoot, vm, routing = null) {
  const installationId = codexInstallationId(projectRoot, vm.id)
  const base = baseUserAgent(projectRoot, vm.id, routing)
  const mac = MAC_OS_RE.test(base)
  const userAgent = mac ? base.replace(MAC_OS_RE, `(Mac OS ${pick(MACOS_VERSIONS, installationId, 'macos')}; `) : base
  const head = /^([^/\s]+(?: [^/\s]+)*)\/(\S+)/.exec(userAgent)
  const version = head?.[2] || ''
  const account = pick(ACCOUNT_NAMES, installationId, 'account')
  return {
    installationId,
    userAgent,
    originator: head?.[1] || 'codex_cli_rs',
    version,
    clientVersion: version.split('-')[0],
    home: mac ? `/Users/${account}` : `/home/${account}`,
    shell: mac ? 'zsh' : 'bash',
    timezone: String(vm.timezone || vm.fingerprint?.timezone || 'America/New_York'),
    sandbox: mac ? 'seatbelt' : null,
  }
}

/** Time-ordered UUID v7, the shape official Codex uses for session and thread ids. */
export function codexSessionUuid(now = Date.now()) {
  const bytes = crypto.randomBytes(16)
  bytes.writeUIntBE(now, 0, 6)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function parseObject(raw) {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function remapSession(value, from, to) {
  if (typeof value !== 'string' || !from || !to || from === to) return value
  if (value === from) return to
  return value.startsWith(`${from}:`) ? `${to}${value.slice(from.length)}` : value
}

/**
 * `x-codex-turn-metadata` as the slot's install sends it: the slot UUID replaces the caller's
 * installation id, and caller session ids follow the outbound session. Without caller metadata a
 * root-turn record is built for `sessionId`; with neither, or unreadable metadata, '' (drop).
 */
export function codexTurnMetadata(raw, identity, { sessionId = '', callerSession = '' } = {}) {
  let meta = parseObject(raw)
  if (!meta) {
    if (raw || !sessionId) return ''
    meta = {
      session_id: sessionId,
      thread_id: sessionId,
      turn_id: '',
      window_id: `${sessionId}:0`,
      window_number: 0,
      request_kind: 'turn',
      thread_source: 'user',
      ...(identity.sandbox ? { sandbox: identity.sandbox } : {}),
    }
  }
  const { installation_id: _caller, ...rest } = meta
  for (const key of ['session_id', 'thread_id', 'window_id', 'parent_thread_id', 'root_thread_id']) {
    if (key in rest) rest[key] = remapSession(rest[key], callerSession, sessionId)
  }
  if (identity.sandbox && 'sandbox' in rest) rest.sandbox = identity.sandbox
  return JSON.stringify({ installation_id: identity.installationId, ...rest })
}

/** Session-scoped Codex headers renamed onto the outbound session, filled in when the caller sent none. */
export function alignCodexSessionHeaders(headers, metadata, { sessionId = '', callerSession = '' } = {}) {
  const out = { ...headers }
  for (const key of ['thread-id', 'x-codex-window-id', 'x-client-request-id', 'x-codex-parent-thread-id']) {
    if (out[key]) out[key] = remapSession(out[key], callerSession, sessionId)
  }
  const meta = parseObject(metadata) || {}
  const thread = meta.thread_id || sessionId
  if (thread && !out['thread-id']) out['thread-id'] = thread
  if (!out['x-codex-window-id'] && (meta.window_id || thread))
    out['x-codex-window-id'] = meta.window_id || `${thread}:0`
  if (thread && !out['x-client-request-id']) out['x-client-request-id'] = thread
  return out
}

function zonedDate(timezone, now) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

/** Caller home / drive paths mapped under the slot's home; other absolute paths are kept. */
function slotPath(raw, home) {
  const value = raw.trim()
  let m = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(value) || /^\/root(\/.*)?$/.exec(value)
  if (m) return home + (m[1] || '')
  m = /^[A-Za-z]:[\\/]+(?:Users[\\/]+[^\\/]+)?([\\/].*)?$/.exec(value)
  if (m) return home + (m[1] || '').replace(/\\+/g, '/')
  return raw
}

function rewriteEnvironmentText(text, identity, now) {
  if (!text.includes('<environment_context>')) return text
  return text.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, (block) =>
    block
      .replace(/<cwd>([\s\S]*?)<\/cwd>/g, (_, p) => `<cwd>${slotPath(p, identity.home)}</cwd>`)
      .replace(/<root>([\s\S]*?)<\/root>/g, (_, p) => `<root>${slotPath(p, identity.home)}</root>`)
      .replace(/<shell>[\s\S]*?<\/shell>/g, `<shell>${identity.shell}</shell>`)
      .replace(/<timezone>[\s\S]*?<\/timezone>/g, `<timezone>${identity.timezone}</timezone>`)
      .replace(
        /<current_date>[\s\S]*?<\/current_date>/g,
        `<current_date>${zonedDate(identity.timezone, now)}</current_date>`,
      ),
  )
}

/**
 * `<environment_context>` blocks in Responses input describe the slot's workstation: cwd and
 * workspace roots under the slot home, its shell, timezone and local date. Other text is untouched.
 */
export function rewriteCodexEnvironment(body, identity, now = new Date()) {
  if (!Array.isArray(body?.input)) return body
  let changed = false
  const input = body.input.map((item) => {
    if (!item || typeof item !== 'object') return item
    if (typeof item.content === 'string') {
      const text = rewriteEnvironmentText(item.content, identity, now)
      if (text === item.content) return item
      changed = true
      return { ...item, content: text }
    }
    if (!Array.isArray(item.content)) return item
    let hit = false
    const content = item.content.map((part) => {
      if (typeof part?.text !== 'string') return part
      const text = rewriteEnvironmentText(part.text, identity, now)
      if (text === part.text) return part
      hit = true
      return { ...part, text }
    })
    if (!hit) return item
    changed = true
    return { ...item, content }
  })
  return changed ? { ...body, input } : body
}

/** Caller installation id for the local request log only. */
export function inboundCodexInstallationId(headers = {}, body = {}) {
  const candidates = [
    headers['x-codex-installation-id'],
    parseObject(headers['x-codex-turn-metadata'])?.installation_id,
    body?.client_metadata?.['x-codex-installation-id'],
    parseObject(body?.client_metadata?.['x-codex-turn-metadata'])?.installation_id,
  ]
  for (const value of candidates) {
    const id = typeof value === 'string' ? value.trim() : ''
    if (UUID_RE.test(id)) return id.toLowerCase()
  }
  return ''
}
