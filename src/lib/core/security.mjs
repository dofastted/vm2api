import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { isKubernetesMode } from './control-plane-mode.mjs'
import { PanelSessionsRepo } from '../db/repos/panel-sessions-repo.mjs'

export function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex')
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

export function redactSecrets(obj) {
  const s = JSON.stringify(obj)
  return s
    .replace(/sk-ant-[a-z0-9-]{8,}/gi, (m) => m.slice(0, 14) + '***REDACTED***')
    .replace(/sk-(?:kin|vm)-[a-f0-9]{8,}/gi, (m) => m.slice(0, 10) + '***REDACTED***')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***REDACTED***')
}

export function extractApiKey(req) {
  const auth = req.headers.authorization || ''
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const t = auth.slice(7).trim()
    // panel session tokens are not API keys
    if (t.startsWith('kin-panel-')) return ''
    return t
  }
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim()
  return ''
}

/** Simple token bucket per key */
export function createRateLimiter({ capacity = 60, refillPerSec = 1 } = {}) {
  const buckets = new Map()
  return function allow(key) {
    const now = Date.now()
    let b = buckets.get(key)
    if (!b) {
      b = { tokens: capacity, updated: now }
      buckets.set(key, b)
    }
    const elapsed = (now - b.updated) / 1000
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec)
    b.updated = now
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }
}

export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

/** Panel admin credentials (env override) */
export function getPanelAdmin() {
  return {
    username: process.env.VM2API_ADMIN_USER || process.env.KIN_ADMIN_USER || 'admin',
    password: process.env.VM2API_ADMIN_PASSWORD || process.env.KIN_ADMIN_PASSWORD || '',
  }
}

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000
const panelSessions = new Map() // sha256(token) -> { user, role, exp }
let _authenticateUser = null
let _lookupRole = null

/** Optional DB-backed panel users. Env admin remains a fallback. */
export function attachPanelAuth({ authenticate, lookupRole } = {}) {
  _authenticateUser = typeof authenticate === 'function' ? authenticate : null
  _lookupRole = typeof lookupRole === 'function' ? lookupRole : null
}

function panelSessionKey(token) {
  return crypto
    .createHash('sha256')
    .update(String(token || ''))
    .digest('hex')
}

function sessionFile() {
  const dir = process.env.KIN_DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(dir, 'panel-sessions.json')
}

function tightenSessionFile(file) {
  try {
    const mode = fs.statSync(file).mode & 0o777
    if (mode !== 0o600) fs.chmodSync(file, 0o600)
  } catch (err) {
    if (err?.code === 'ENOENT') return
    console.warn(`kin-security: failed to tighten panel sessions: ${err.message}`)
  }
}

function loadSessions() {
  try {
    const f = sessionFile()
    if (!fs.existsSync(f)) return
    tightenSessionFile(f)
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
    const now = Date.now()
    for (const [storedKey, s] of Object.entries(raw || {})) {
      if (s && s.exp > now) {
        const key = storedKey.startsWith('kin-panel-') ? panelSessionKey(storedKey) : storedKey
        panelSessions.set(key, { user: s.user, role: s.role || null, exp: s.exp })
      }
    }
  } catch (err) {
    console.warn(`kin-security: failed to load panel sessions: ${err.message}`)
  }
}

function saveSessions() {
  try {
    const f = sessionFile()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const obj = {}
    const now = Date.now()
    for (const [token, s] of panelSessions.entries()) {
      if (s.exp > now) obj[token] = s
    }
    atomicWriteJson(f, obj, { mode: 0o600 })
  } catch (err) {
    console.warn(`kin-security: failed to persist panel sessions: ${err.message}`)
  }
}

if (!isKubernetesMode()) loadSessions()

export async function createPanelSession(username, ttlMs = SESSION_TTL_MS, extra = {}) {
  if (ttlMs && typeof ttlMs === 'object') {
    extra = ttlMs
    ttlMs = extra.ttlMs || SESSION_TTL_MS
  }
  const token = 'kin-panel-' + crypto.randomBytes(24).toString('hex')
  const role = extra.role || (_lookupRole && (await _lookupRole(username))) || 'admin'
  if (isKubernetesMode()) {
    await new PanelSessionsRepo().create({ tokenHash: panelSessionKey(token), username, role, ttlMs })
    return token
  }
  panelSessions.set(panelSessionKey(token), {
    user: username,
    role,
    exp: Date.now() + ttlMs,
  })
  saveSessions()
  return token
}

export async function verifyPanelSession(token) {
  if (!token || !token.startsWith('kin-panel-')) return null
  const key = panelSessionKey(token)
  if (isKubernetesMode()) {
    const repo = new PanelSessionsRepo()
    const session = await repo.get(key)
    if (!session) return null
    if (session.exp - Date.now() < SESSION_TTL_MS / 2) {
      return (await repo.renew(key, { expectedExp: session.exp, ttlMs: SESSION_TTL_MS })) || (await repo.get(key))
    }
    return session
  }
  let s = panelSessions.get(key)
  if (!s) {
    // reload from disk once (multi-process / restart)
    loadSessions()
    s = panelSessions.get(key)
  }
  if (!s) return null
  if (Date.now() > s.exp) {
    panelSessions.delete(key)
    saveSessions()
    return null
  }
  if (!s.role && _lookupRole) {
    s.role = (await _lookupRole(s.user)) || null
  }
  if (!s.role) {
    const admin = getPanelAdmin()
    s.role = admin.username && s.user === admin.username ? 'admin' : 'user'
  }
  const now = Date.now()
  const remaining = s.exp - now
  if (remaining > 0 && remaining < SESSION_TTL_MS / 2) {
    s.exp = now + SESSION_TTL_MS
    saveSessions()
  }
  return s
}

export async function revokePanelSession(token) {
  if (!token) return
  if (isKubernetesMode()) return new PanelSessionsRepo().remove(panelSessionKey(token))
  panelSessions.delete(panelSessionKey(token))
  saveSessions()
}

export async function revokePanelSessionsForUser(username, { exceptToken } = {}) {
  const name = String(username || '')
  if (!name) return 0
  const exceptKey = exceptToken ? panelSessionKey(exceptToken) : null
  if (isKubernetesMode()) return new PanelSessionsRepo().removeForUser(name, { exceptHash: exceptKey })
  let n = 0
  for (const [key, s] of panelSessions.entries()) {
    if (s.user !== name) continue
    if (exceptKey && key === exceptKey) continue
    panelSessions.delete(key)
    n += 1
  }
  if (n) saveSessions()
  return n
}

/**
 * @returns {{ username: string, role: string, id?: string } | null}
 */
export async function verifyPanelLogin(username, password) {
  if (_authenticateUser) {
    const rec = await _authenticateUser(username, password)
    if (rec) return { username: rec.username, role: rec.role || 'user', id: rec.id }
    // Existing DB user (including disabled) must not fall through to env password.
    if (_lookupRole && (await _lookupRole(username))) return null
  }
  const admin = getPanelAdmin()
  if (!admin.password) return null
  if (!timingSafeEqualStr(String(username || ''), admin.username)) return null
  if (!timingSafeEqualStr(String(password || ''), admin.password)) return null
  return { username: admin.username, role: 'admin', id: null, source: 'env' }
}

function parseCookie(header) {
  const out = {}
  if (!header) return out
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

/** Extract panel session token: Bearer → x-panel-token → Cookie */
export function extractPanelToken(req) {
  const auth = req.headers.authorization || ''
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const t = auth.slice(7).trim()
    if (t.startsWith('kin-panel-')) return t
  }
  if (req.headers['x-panel-token']) {
    const t = String(req.headers['x-panel-token']).trim()
    if (t) return t
  }
  const cookies = parseCookie(req.headers.cookie)
  if (cookies.kin_panel_token) return cookies.kin_panel_token
  if (cookies.kin_console_token) return cookies.kin_console_token
  return ''
}

/** Cookie Secure follows the request (or PUBLIC_SCHEME). Default HTTP, not HTTPS. */
export function panelCookieSecure(req, env = process.env) {
  const scheme = String(env.PUBLIC_SCHEME || '')
    .trim()
    .toLowerCase()
  if (scheme === 'https') return true
  if (scheme === 'http') return false
  const xf = String(req?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  if (xf === 'https') return true
  if (xf === 'http') return false
  if (req?.socket?.encrypted) return true
  return false
}

/** Build Set-Cookie for panel session (7d) */
export function panelSessionCookie(token, { secure = true, maxAgeSec = 7 * 24 * 3600 } = {}) {
  const parts = [
    `kin_panel_token=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearPanelSessionCookie({ secure = true } = {}) {
  const parts = ['kin_panel_token=', 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
