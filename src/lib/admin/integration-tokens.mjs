/**
 * External Integration API token store, scope registry, and network boundary guard.
 *
 * Persistence uses SettingsRepo (`integration_api_config` and `integration_api_tokens`)
 * so both SQLite and PostgreSQL work identically without extra schema migrations.
 * Plaintext tokens are never persisted: only HMAC-SHA256 hashes and masked prefixes are stored.
 */

import crypto from 'node:crypto'
import { isIP } from 'node:net'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { timingSafeEqualStr } from '../core/security.mjs'

export const INTEGRATION_TOKEN_PREFIX = 'sk-int-'
export const INTEGRATION_CONFIG_KEY = 'integration_api_config'
export const INTEGRATION_TOKENS_KEY = 'integration_api_tokens'

export const INTEGRATION_SCOPES = Object.freeze([
  'overview:read',
  'vms:read',
  'vms:write',
  'proxies:read',
  'proxies:write',
  'credentials:write',
  'endpoints:read',
  'endpoints:write',
  'keys:read',
  'keys:write',
  'keys:global',
])

export const DEFAULT_INTEGRATION_SCOPES = Object.freeze([
  'overview:read',
  'vms:read',
  'vms:write',
  'proxies:read',
  'proxies:write',
  'credentials:write',
  'endpoints:read',
  'endpoints:write',
  'keys:read',
  'keys:write',
])

const VALID_SCOPES = new Set(INTEGRATION_SCOPES)
const HEADER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i
const LAST_USED_TOUCH_INTERVAL_MS = 60_000

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  allow_remote: false,
  allowed_ips: [],
  custom_auth_header: null,
})

function envBool(raw) {
  if (raw == null || String(raw).trim() === '') return null
  const v = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  return null
}

function nowIso() {
  return new Date().toISOString()
}

export function normalizeRemoteIp(raw) {
  let addr = String(raw || '').trim()
  if (!addr) return ''
  // Strip IPv6 zone index (e.g., fe80::1%eth0)
  const zoneIdx = addr.indexOf('%')
  if (zoneIdx >= 0) addr = addr.slice(0, zoneIdx)
  if (addr.startsWith('::ffff:')) {
    const v4 = addr.slice(7)
    if (isIP(v4) === 4) return v4
  }
  return addr.toLowerCase()
}

export function isLoopbackAddress(raw) {
  const ip = normalizeRemoteIp(raw)
  if (!ip) return false
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true
  if (isIP(ip) === 4 && ip.startsWith('127.')) return true
  return false
}

export function normalizeScopes(input, { fallback = DEFAULT_INTEGRATION_SCOPES } = {}) {
  if (input == null) return [...fallback]
  const rawList = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : null
  if (!rawList) {
    throw Object.assign(new Error('scopes must be an array of scope strings'), { code: 'invalid_scopes' })
  }
  const unique = []
  const seen = new Set()
  for (const item of rawList) {
    const s = String(item || '').trim()
    if (!s) continue
    if (!VALID_SCOPES.has(s)) {
      throw Object.assign(new Error(`unsupported integration scope: ${s}`), { code: 'invalid_scopes' })
    }
    if (!seen.has(s)) {
      seen.add(s)
      unique.push(s)
    }
  }
  if (!unique.length) {
    throw Object.assign(new Error('at least one integration scope is required'), { code: 'invalid_scopes' })
  }
  return unique
}

export function normalizeAllowedIps(input) {
  if (input == null) return []
  const rawList = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : null
  if (!rawList) {
    throw Object.assign(new Error('allowed_ips must be an array of IP addresses'), { code: 'invalid_allowed_ips' })
  }
  const out = []
  const seen = new Set()
  for (const raw of rawList) {
    const ip = normalizeRemoteIp(raw)
    if (!ip) continue
    if (!isIP(ip)) {
      throw Object.assign(new Error(`invalid IP address in allowed_ips: ${raw}`), { code: 'invalid_allowed_ips' })
    }
    if (!seen.has(ip)) {
      seen.add(ip)
      out.push(ip)
    }
  }
  return out
}

export function normalizeCustomAuthHeader(value) {
  if (value == null || String(value).trim() === '') return null
  const name = String(value).trim().toLowerCase()
  if (!HEADER_NAME_RE.test(name)) {
    throw Object.assign(new Error('invalid custom_auth_header name'), { code: 'invalid_auth_header' })
  }
  const forbidden = new Set(['host', 'content-type', 'content-length', 'connection', 'cookie', 'origin', 'referer'])
  if (forbidden.has(name)) {
    throw Object.assign(new Error(`disallowed custom_auth_header: ${name}`), { code: 'invalid_auth_header' })
  }
  return name
}

export function generateIntegrationToken() {
  return INTEGRATION_TOKEN_PREFIX + crypto.randomBytes(32).toString('hex')
}

export function publicIntegrationTokenView(rec) {
  if (!rec) return null
  return {
    id: rec.id,
    name: rec.name,
    prefix: rec.token_prefix || INTEGRATION_TOKEN_PREFIX,
    masked: `${rec.token_prefix || INTEGRATION_TOKEN_PREFIX}…${rec.token_suffix || '****'}`,
    scopes: Array.isArray(rec.scopes) ? rec.scopes.slice() : [],
    enabled: rec.enabled !== false,
    expires_at: rec.expires_at || null,
    created_at: rec.created_at || null,
    updated_at: rec.updated_at || null,
    last_used_at: rec.last_used_at || null,
    source: rec.source || 'db',
  }
}

export function extractIntegrationToken(req, { customHeader = null } = {}) {
  const headers = req?.headers || {}
  if (customHeader) {
    const customVal = headers[String(customHeader).toLowerCase()]
    if (typeof customVal === 'string' && customVal.trim()) {
      const v = customVal.trim()
      return v.toLowerCase().startsWith('bearer ') ? v.slice(7).trim() : v
    }
  }
  const explicit = headers['x-integration-token']
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim()
  }
  const auth = headers.authorization || ''
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const t = auth.slice(7).trim()
    if (t) return t
  }
  const xApiKey = headers['x-api-key']
  if (typeof xApiKey === 'string' && xApiKey.trim()) {
    return xApiKey.trim()
  }
  return ''
}

export class IntegrationTokenStore {
  constructor({ db = null, settings = null, hashSecret = null, env = process.env } = {}) {
    this._settings = settings || null
    this._db = db || null
    this.env = env || process.env
    this.hashSecret = String(
      hashSecret ||
        this.env.VM2API_INTEGRATION_HASH_SECRET ||
        this.env.VM2API_API_KEY_HASH_SECRET ||
        this.env.KIN_API_KEY_HASH_SECRET ||
        this.env.VM2API_DB_SECRET ||
        this.env.KIN_DB_SECRET ||
        this.env.VM2API_API_KEY ||
        this.env.KIN_API_KEY ||
        'vm2api-integration-token-hash-secret',
    )
    this._lastTouchMs = new Map()
  }

  _repo() {
    if (this._settings) return this._settings
    return this._db ? new SettingsRepo(this._db) : new SettingsRepo()
  }

  _hash(token) {
    return crypto
      .createHmac('sha256', this.hashSecret)
      .update(String(token || ''))
      .digest('hex')
  }

  _envTokenRecord() {
    const raw = String(this.env?.VM2API_INTEGRATION_TOKEN || '').trim()
    if (!raw || raw.length < 24) return null
    let scopes = [...DEFAULT_INTEGRATION_SCOPES]
    if (this.env?.VM2API_INTEGRATION_SCOPES) {
      try {
        scopes = normalizeScopes(this.env.VM2API_INTEGRATION_SCOPES)
      } catch {
        scopes = [...DEFAULT_INTEGRATION_SCOPES]
      }
    }
    return {
      id: 'itok_env_default',
      name: 'env-token',
      raw,
      token_prefix: raw.slice(0, 10),
      token_suffix: raw.slice(-4),
      scopes,
      enabled: true,
      expires_at: null,
      created_at: null,
      updated_at: null,
      last_used_at: null,
      source: 'env',
    }
  }

  getConfig() {
    let stored = null
    try {
      stored = this._repo().get(INTEGRATION_CONFIG_KEY, null)
    } catch {
      stored = null
    }
    const base = {
      ...DEFAULT_CONFIG,
      ...(stored && typeof stored === 'object' ? stored : {}),
    }
    const envEnabled = envBool(this.env?.VM2API_INTEGRATION_ENABLED)
    const envAllowRemote = envBool(this.env?.VM2API_INTEGRATION_ALLOW_REMOTE)
    const envIpsRaw = String(this.env?.VM2API_INTEGRATION_ALLOWED_IPS || '').trim()
    const envCustomHeader = String(this.env?.VM2API_INTEGRATION_AUTH_HEADER || '').trim()

    let allowedIps = Array.isArray(base.allowed_ips) ? base.allowed_ips : []
    if (envIpsRaw) {
      try {
        allowedIps = normalizeAllowedIps(envIpsRaw)
      } catch {}
    }

    let customHeader = base.custom_auth_header || null
    if (envCustomHeader) {
      try {
        customHeader = normalizeCustomAuthHeader(envCustomHeader)
      } catch {}
    }

    return {
      enabled: envEnabled !== null ? envEnabled : base.enabled !== false,
      allow_remote: envAllowRemote !== null ? envAllowRemote : base.allow_remote === true,
      allowed_ips: allowedIps,
      custom_auth_header: customHeader,
      env_token_configured: Boolean(this._envTokenRecord()),
      available_scopes: [...INTEGRATION_SCOPES],
    }
  }

  updateConfig(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw Object.assign(new Error('config patch must be an object'), { code: 'invalid_config' })
    }
    let stored = null
    try {
      stored = this._repo().get(INTEGRATION_CONFIG_KEY, null)
    } catch {
      stored = null
    }
    const next = {
      ...DEFAULT_CONFIG,
      ...(stored && typeof stored === 'object' ? stored : {}),
    }
    if (Object.hasOwn(patch, 'enabled')) {
      if (typeof patch.enabled !== 'boolean') {
        throw Object.assign(new Error('enabled must be boolean'), { code: 'invalid_config' })
      }
      next.enabled = patch.enabled
    }
    if (Object.hasOwn(patch, 'allow_remote')) {
      if (typeof patch.allow_remote !== 'boolean') {
        throw Object.assign(new Error('allow_remote must be boolean'), { code: 'invalid_config' })
      }
      next.allow_remote = patch.allow_remote
    }
    if (Object.hasOwn(patch, 'allowed_ips')) {
      next.allowed_ips = normalizeAllowedIps(patch.allowed_ips)
    }
    if (Object.hasOwn(patch, 'custom_auth_header')) {
      next.custom_auth_header = normalizeCustomAuthHeader(patch.custom_auth_header)
    }
    this._repo().set(INTEGRATION_CONFIG_KEY, next)
    return this.getConfig()
  }

  _readRecords() {
    try {
      const list = this._repo().get(INTEGRATION_TOKENS_KEY, [])
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  _writeRecords(records) {
    this._repo().set(INTEGRATION_TOKENS_KEY, records)
  }

  hasAnyActiveToken() {
    if (this._envTokenRecord()) return true
    const now = Date.now()
    return this._readRecords().some((rec) => {
      if (!rec || rec.enabled === false) return false
      if (rec.expires_at && Date.parse(rec.expires_at) <= now) return false
      return true
    })
  }

  listTokens() {
    const items = this._readRecords().map(publicIntegrationTokenView)
    const envRec = this._envTokenRecord()
    if (envRec) {
      items.unshift(publicIntegrationTokenView(envRec))
    }
    return items
  }

  createToken(input = {}) {
    const name = String(input?.name || '')
      .trim()
      .slice(0, 80)
    if (!name) {
      throw Object.assign(new Error('token name is required'), { code: 'invalid_token_name' })
    }
    const scopes = normalizeScopes(input?.scopes, { fallback: DEFAULT_INTEGRATION_SCOPES })
    let expiresAt = null
    if (input?.expires_at != null && String(input.expires_at).trim() !== '') {
      const ts = Date.parse(String(input.expires_at))
      if (!Number.isFinite(ts) || ts <= Date.now()) {
        throw Object.assign(new Error('expires_at must be a valid future ISO timestamp'), {
          code: 'invalid_expires_at',
        })
      }
      expiresAt = new Date(ts).toISOString()
    } else if (input?.expires_in_days != null && Number(input.expires_in_days) > 0) {
      const days = Number(input.expires_in_days)
      if (!Number.isFinite(days) || days > 3650) {
        throw Object.assign(new Error('expires_in_days must be between 1 and 3650'), { code: 'invalid_expires_at' })
      }
      expiresAt = new Date(Date.now() + days * 86400_000).toISOString()
    }

    const plaintext = generateIntegrationToken()
    const tokenHash = this._hash(plaintext)
    const now = nowIso()
    const rec = {
      id: 'itok_' + crypto.randomBytes(6).toString('hex'),
      name,
      token_hash: tokenHash,
      token_prefix: plaintext.slice(0, 12),
      token_suffix: plaintext.slice(-4),
      scopes,
      enabled: input?.enabled !== false,
      expires_at: expiresAt,
      created_at: now,
      updated_at: now,
      last_used_at: null,
      source: 'db',
    }
    const records = this._readRecords()
    records.push(rec)
    this._writeRecords(records)
    return {
      item: publicIntegrationTokenView(rec),
      token: plaintext,
    }
  }

  updateToken(id, patch = {}) {
    if (!id || id === 'itok_env_default') {
      throw Object.assign(new Error('env token cannot be edited via API'), { code: 'env_token_immutable' })
    }
    const records = this._readRecords()
    const idx = records.findIndex((r) => r?.id === id)
    if (idx < 0) return null
    const rec = { ...records[idx] }
    if (Object.hasOwn(patch, 'name')) {
      const name = String(patch.name || '')
        .trim()
        .slice(0, 80)
      if (!name) throw Object.assign(new Error('token name is required'), { code: 'invalid_token_name' })
      rec.name = name
    }
    if (Object.hasOwn(patch, 'scopes')) {
      rec.scopes = normalizeScopes(patch.scopes)
    }
    if (Object.hasOwn(patch, 'enabled')) {
      if (typeof patch.enabled !== 'boolean') {
        throw Object.assign(new Error('enabled must be boolean'), { code: 'invalid_enabled' })
      }
      rec.enabled = patch.enabled
    }
    if (Object.hasOwn(patch, 'expires_at')) {
      if (patch.expires_at === null || patch.expires_at === '') {
        rec.expires_at = null
      } else {
        const ts = Date.parse(String(patch.expires_at))
        if (!Number.isFinite(ts)) {
          throw Object.assign(new Error('invalid expires_at'), { code: 'invalid_expires_at' })
        }
        rec.expires_at = new Date(ts).toISOString()
      }
    }
    rec.updated_at = nowIso()
    records[idx] = rec
    this._writeRecords(records)
    return publicIntegrationTokenView(rec)
  }

  deleteToken(id) {
    if (!id || id === 'itok_env_default') {
      throw Object.assign(new Error('env token cannot be deleted via API'), { code: 'env_token_immutable' })
    }
    const records = this._readRecords()
    const next = records.filter((r) => r?.id !== id)
    if (next.length === records.length) return false
    this._writeRecords(next)
    this._lastTouchMs.delete(id)
    return true
  }

  /**
   * Check network access boundary using direct socket remoteAddress only
   * (never trusts X-Forwarded-For to bypass loopback protection).
   */
  checkNetworkAccess(req) {
    const cfg = this.getConfig()
    if (!cfg.enabled) {
      return { ok: false, status: 404, code: 'integration_disabled', message: 'Integration API is disabled' }
    }
    const remoteIp = normalizeRemoteIp(req?.socket?.remoteAddress || req?.connection?.remoteAddress || '')
    if (isLoopbackAddress(remoteIp)) {
      return { ok: true, config: cfg, remoteIp }
    }
    if (!cfg.allow_remote) {
      return {
        ok: false,
        status: 403,
        code: 'loopback_only',
        message: 'Integration API only accepts loopback connections unless allow_remote is enabled',
      }
    }
    if (cfg.allowed_ips.length > 0 && !cfg.allowed_ips.includes(remoteIp)) {
      return {
        ok: false,
        status: 403,
        code: 'ip_not_allowed',
        message: 'Caller IP is not in the integration API allowlist',
      }
    }
    return { ok: true, config: cfg, remoteIp }
  }

  authenticate(req) {
    const net = this.checkNetworkAccess(req)
    if (!net.ok) return net

    if (!this.hasAnyActiveToken()) {
      return {
        ok: false,
        status: 503,
        code: 'integration_unconfigured',
        message: 'No active integration token configured',
      }
    }

    const presented = extractIntegrationToken(req, { customHeader: net.config.custom_auth_header })
    if (!presented) {
      return {
        ok: false,
        status: 401,
        code: 'missing_integration_token',
        message: 'Missing integration token',
      }
    }

    const envRec = this._envTokenRecord()
    if (envRec && timingSafeEqualStr(presented, envRec.raw)) {
      return {
        ok: true,
        config: net.config,
        token: publicIntegrationTokenView(envRec),
      }
    }

    const presentedHash = this._hash(presented)
    const records = this._readRecords()
    const match = records.find((r) => r?.token_hash && timingSafeEqualStr(presentedHash, r.token_hash))
    if (!match) {
      return {
        ok: false,
        status: 401,
        code: 'invalid_integration_token',
        message: 'Invalid integration token',
      }
    }
    if (match.enabled === false) {
      return {
        ok: false,
        status: 403,
        code: 'integration_token_disabled',
        message: 'Integration token is disabled',
      }
    }
    if (match.expires_at && Date.parse(match.expires_at) <= Date.now()) {
      return {
        ok: false,
        status: 403,
        code: 'integration_token_expired',
        message: 'Integration token has expired',
      }
    }

    const nowMs = Date.now()
    const prevTouch = this._lastTouchMs.get(match.id) || 0
    if (nowMs - prevTouch >= LAST_USED_TOUCH_INTERVAL_MS) {
      this._lastTouchMs.set(match.id, nowMs)
      try {
        match.last_used_at = new Date(nowMs).toISOString()
        this._writeRecords(records)
      } catch {}
    }

    return {
      ok: true,
      config: net.config,
      token: publicIntegrationTokenView(match),
    }
  }
}

export function hasIntegrationScope(token, scope) {
  if (!token || !Array.isArray(token.scopes)) return false
  return token.scopes.includes(scope)
}
