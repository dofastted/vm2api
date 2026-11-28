/**
 * Configurable sticky / conversation-continuity routing (SQLite-backed).
 * Binds conversation key → account/VM for the TTL window.
 */

import crypto from 'node:crypto'
import { ENVELOPE_NEEDLES, extractPrompt } from '../core/distill-detect.mjs'
import { DB_INSTANCE_ID, getDb, getPgPool, isDbOpen, resolveStoreDb } from '../db/database.mjs'
import { enqueueWrite, writeBehindArmed } from '../db/write-behind.mjs'
import { getCacheRuntime } from '../cache/index.mjs'
import { StickyRepo } from '../db/repos/sticky-repo.mjs'

const STICKY_REDIS_TTL_MS = 3_600_000
const STICKY_L1_MAX = 16_384
const STICKY_L1_NEG_MAX = 16_384
const STICKY_L1_NEG_TTL_MS = 15_000
const STICKY_RENEW_MIN_GAP_MS = 60_000
const STICKY_STATS_TTL_MS = 5_000
const STICKY_STATS_SESSIONS_LIMIT = 500
const STICKY_STATS_REDIS_PREFIX = 'dash:sticky:stats:'

function rowToStickyEntry(row) {
  if (!row) return null
  return {
    account_id: row.account_id,
    vm_id: row.vm_id,
    session_id: row.session_id,
    device_id: row.device_id || null,
    bound_at: row.bound_at == null ? null : Number(row.bound_at),
    expires_at: row.expires_at == null ? null : Number(row.expires_at),
    hits: Number(row.hits) || 0,
    generation: Number(row.generation) || 0,
    slot_index: row.slot_index == null ? null : Number(row.slot_index),
  }
}
import {
  claudeCodeAgentRootSession,
  extractCallerSession,
  firstUserIdentityText,
  parseUserId,
} from '../identity/identity-rewrite.mjs'

export const DEFAULT_STICKY_HEADER_KEYS = [
  'x-session-id',
  'x-conversation-id',
  'x-claude-code-session-id',
  'session-id',
  'thread-id',
]

export const DEFAULT_STICKY_BODY_KEYS = ['conversation_id', 'session_id', 'thread_id', 'prompt_cache_key']

/** Per-request ids — never use as a conversation key. */
export const EPHEMERAL_STICKY_KEYS = new Set(['x-client-request-id', 'x-request-id'])

export function normalizeStickyPlatform(platform) {
  const value = String(platform || '')
    .trim()
    .toLowerCase()
  if (value === 'openai' || value === 'gpt' || value === 'codex') return 'openai'
  if (value === 'anthropic' || value === 'claude') return 'anthropic'
  if (value === 'gemini' || value === 'antigravity') return 'gemini'
  return ''
}

/** Platform pools do not share a sticky row. Omitted platform keeps the legacy key. */
export function scopeStickyKey(key, platform) {
  const raw = String(key || '')
  if (!raw) return null
  const name = normalizeStickyPlatform(platform)
  if (!name) return raw
  const prefix = `p:${name}:`
  return raw.startsWith(prefix) ? raw : `${prefix}${raw}`
}

export function mergeStickyConfig(config) {
  const sticky = config?.sticky || {}
  const headerKeys = (
    Array.isArray(sticky.header_keys) && sticky.header_keys.length ? sticky.header_keys : DEFAULT_STICKY_HEADER_KEYS
  ).filter((k) => !EPHEMERAL_STICKY_KEYS.has(String(k).toLowerCase()))
  const outboundSession =
    String(sticky.outbound_session || '')
      .trim()
      .toLowerCase() === 'passthrough'
      ? 'passthrough'
      : 'rebuild'
  return {
    enabled: sticky.enabled !== false,
    mode: sticky.mode || 'conversation',
    ttl_seconds: sticky.ttl_seconds || 86400,
    header_keys: headerKeys,
    body_keys: Array.isArray(sticky.body_keys) && sticky.body_keys.length ? sticky.body_keys : DEFAULT_STICKY_BODY_KEYS,
    outbound_session: outboundSession,
  }
}

export function clientIp(req) {
  const headers = req?.headers || {}
  const xf = String(headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '')
    .split(',')[0]
    .trim()
  const raw = xf || req?.socket?.remoteAddress || req?.ip || ''
  return String(raw)
    .replace(/^::ffff:/, '')
    .slice(0, 45)
}

export function isPersistableEnvelope(body = {}, inbound = null) {
  const hay = extractPrompt(inbound || body, body).joined.toLowerCase()
  return ENVELOPE_NEEDLES.some((item) => hay.includes(String(item).toLowerCase()))
}

/** One block of the first user message, chosen by firstUserIdentityText: the
 * first one that is not pure <system-reminder>. Later blocks of the same user
 * message change every turn and must not open another VM session slot. The
 * outbound session seed picks the same block (extractFirstUserIdentity).
 */
export function firstUserFingerprint(body = {}) {
  const msgs = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : []
  let text = ''
  if (msgs.length) {
    const user = msgs.find((m) => String(m?.role || m?.type || '').toLowerCase() === 'user') || msgs[0]
    if (user) {
      const c = user.content ?? user.text ?? user.input
      if (typeof c === 'string') text = firstUserIdentityText([c])
      else if (Array.isArray(c)) {
        text = firstUserIdentityText(
          c.map((part) =>
            typeof part === 'string'
              ? part
              : (part?.type === 'text' || part?.type === 'input_text') && typeof part.text === 'string'
                ? part.text
                : '',
          ),
        )
      }
    }
  } else if (Array.isArray(body?.contents) && body.contents.length) {
    const user =
      body.contents.find((item) => {
        if (typeof item === 'string') return true
        if (!item || typeof item !== 'object') return false
        const role = String(item.role || '')
          .trim()
          .toLowerCase()
        return !role || role === 'user'
      }) || body.contents[0]
    if (typeof user === 'string') {
      text = firstUserIdentityText([user])
    } else if (Array.isArray(user?.parts)) {
      text = firstUserIdentityText(
        user.parts.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')),
      )
    } else if (typeof user?.text === 'string') {
      text = firstUserIdentityText([user.text])
    }
  } else if (typeof body?.input === 'string') {
    text = firstUserIdentityText([body.input])
  } else if (typeof body?.prompt === 'string') {
    text = firstUserIdentityText([body.prompt])
  }
  text = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)
}

/** Side queries spawned by a live parent turn. Not a new conversation. */
export const COMPANION_PARENT_MS = 120_000

function systemText(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system.map((block) => (typeof block === 'string' ? block : block?.text || '')).join('\n')
}

function firstUserText(body = {}) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  const user = msgs.find((m) => String(m?.role || '').toLowerCase() === 'user')
  const content = user?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  for (const part of content) {
    if (typeof part === 'string' && part.trim()) return part.trim()
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) return part.text.trim()
  }
  return ''
}

/**
 * Claude Code skill-routing / short Haiku hops.
 * They carry a fresh session_id but belong to the parent turn that just ran.
 */
export function isParentSessionCompanion(body = {}) {
  const model = String(body?.model || '').toLowerCase()
  if (!model.includes('haiku')) return false
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  if (msgs.length !== 1 || String(msgs[0]?.role || '').toLowerCase() !== 'user') return false
  const tools = body?.tools
  if (Array.isArray(tools) ? tools.length > 0 : !!tools) return false
  if (firstUserText(body).startsWith('Compress into one routing hint')) return true
  const system = systemText(body?.system)
  if (!system || system.length > 800) return false
  return /x-anthropic-billing-header/i.test(system) && /you are claude code/i.test(system)
}

export const SHORT_PROBE_MAX_CHARS = 64

/**
 * One-shot account tests, channel tests, and verification scripts use one short
 * user text turn and no tools, regardless of max_tokens. Because they carry no
 * conversation, they must not hold a session seat or move a sticky pin.
 */
export function isShortProbeRequest(body = {}) {
  const tools = body?.tools
  if (Array.isArray(tools) ? tools.length > 0 : !!tools) return false
  if (Array.isArray(body?.messages)) {
    const msgs = body.messages
    if (msgs.length !== 1 || String(msgs[0]?.role || '').toLowerCase() !== 'user') return false
    const content = msgs[0].content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') text += part
        else if (part?.type === 'text' && typeof part.text === 'string') text += part.text
        else return false
      }
    } else return false
    text = text.trim()
    return text.length > 0 && text.length <= SHORT_PROBE_MAX_CHARS
  }
  if (Array.isArray(body?.contents)) {
    const contents = body.contents
    if (contents.length !== 1) return false
    const first = contents[0]
    if (!first || typeof first !== 'object') {
      if (typeof first === 'string') {
        const t = first.trim()
        return t.length > 0 && t.length <= SHORT_PROBE_MAX_CHARS
      }
      return false
    }
    const role = String(first.role || 'user')
      .trim()
      .toLowerCase()
    if (role !== 'user') return false
    const parts = first.parts
    if (!Array.isArray(parts) || parts.length === 0) return false
    let text = ''
    for (const part of parts) {
      if (typeof part === 'string') {
        text += part
      } else if (
        part &&
        typeof part === 'object' &&
        typeof part.text === 'string' &&
        !part.functionCall &&
        !part.function_call &&
        !part.functionResponse &&
        !part.function_response &&
        !part.inlineData &&
        !part.inline_data &&
        !part.fileData &&
        !part.file_data
      ) {
        text += part.text
      } else {
        return false
      }
    }
    text = text.trim()
    return text.length > 0 && text.length <= SHORT_PROBE_MAX_CHARS
  }
  return false
}

export function explicitParentSessionId(body = {}, headers = {}) {
  const parsed = parseUserId(body?.metadata?.user_id) || {}
  const meta = body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {}
  return String(
    parsed.root_session_id ||
      parsed.parent_session_id ||
      meta.root_session_id ||
      meta.parent_session_id ||
      headers?.['x-kin-root-session'] ||
      headers?.['x-kin-parent-session'] ||
      claudeCodeAgentRootSession({ inbound: body, body, headers }) ||
      '',
  ).trim()
}

export function childDeclaredWithoutParent(body = {}, headers = {}) {
  const meta = body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {}
  const declared = meta.kin_child === true || String(meta.kin_child || headers?.['x-kin-child'] || '') === '1'
  return declared && !explicitParentSessionId(body, headers)
}

export class StickyRouter {
  constructor({ dataDir, db, config, writeBehind = null, pgPool = null }) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new StickyRepo(this.db)
    this.config = mergeStickyConfig(config)
    this._explicitWriteBehind = typeof writeBehind === 'boolean' ? writeBehind : null
    this._explicitPgPool = pgPool || null
    this._l1 = new Map() // key -> { ent, renewedAt }
    this._l1Neg = new Map() // key -> expiresAtMs
    this._latestByDevice = new Map() // `${prefix}\0${device}` -> { key, bound_at, expires_at }
    this._pendingPgWrites = new Set()
    this._statsCache = null
    this._statsRefreshPromises = null
    this._stmtLatestByDevice = null
    this._prepareAuxStatements()
    const resolvedPg = this._resolvePgPool()
    if (resolvedPg && typeof resolvedPg.query === 'function') {
      this._trackPgWrite(this._dropAliasKeysPgAsync(resolvedPg))
    } else {
      this.repo.dropAliasKeys()
    }
  }

  _prepareAuxStatements() {
    try {
      this._stmtLatestByDevice = this.db.prepare(
        `SELECT key, device_id, bound_at, expires_at
         FROM sticky_sessions
         WHERE device_id = ? AND expires_at > ? AND bound_at >= ?
         ORDER BY bound_at DESC
         LIMIT 50`,
      )
    } catch {
      this._stmtLatestByDevice = null
    }
  }

  _isPrimaryDb() {
    return isDbOpen() && this.db === getDb()
  }

  _resolvePgPool() {
    if (this._explicitPgPool !== null) return this._explicitPgPool
    if (this.db?.engine === 'postgres' && this._isPrimaryDb()) return getPgPool()
    return null
  }

  _trackPgWrite(promise) {
    if (!promise || typeof promise.then !== 'function') return
    const p = promise
      .catch(() => {})
      .finally(() => {
        this._pendingPgWrites.delete(p)
      })
    this._pendingPgWrites.add(p)
  }

  /** Wait for all in-flight async PG sticky write-backs to finish (graceful shutdown & tests). */
  async flushPendingWrites() {
    while (this._pendingPgWrites.size > 0) {
      await Promise.allSettled([...this._pendingPgWrites])
    }
  }

  async _dropAliasKeysPgAsync(pgPool) {
    await pgPool.query(
      `DELETE FROM sticky_sessions
       WHERE key = 'envelope'
         OR key LIKE 'ch:%'
         OR key LIKE 'dev:%'
         OR key LIKE '%:envelope'
         OR key LIKE '%:ch:%'
         OR key LIKE '%:dev:%'`,
    )
  }

  async _getFromPgAsync(pgPool, key) {
    try {
      const res = await pgPool.query('SELECT * FROM sticky_sessions WHERE key = $1', [key])
      return rowToStickyEntry(res?.rows?.[0] || null)
    } catch {
      return null
    }
  }

  async _getManyFromPgAsync(pgPool, keys) {
    const out = new Map()
    if (!keys?.length) return out
    try {
      const res = await pgPool.query('SELECT * FROM sticky_sessions WHERE key = ANY($1::text[])', [keys])
      for (const row of res?.rows || []) {
        const ent = rowToStickyEntry(row)
        if (ent && row.key) out.set(row.key, ent)
      }
    } catch {}
    return out
  }

  async _upsertPgAsync(pgPool, key, ent) {
    await pgPool.query(
      `INSERT INTO sticky_sessions (key, account_id, vm_id, session_id, device_id, bound_at, expires_at, hits, generation, slot_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (key) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         vm_id = EXCLUDED.vm_id,
         session_id = EXCLUDED.session_id,
         device_id = COALESCE(EXCLUDED.device_id, sticky_sessions.device_id),
         bound_at = EXCLUDED.bound_at,
         expires_at = EXCLUDED.expires_at,
         hits = EXCLUDED.hits,
         generation = EXCLUDED.generation,
         slot_index = EXCLUDED.slot_index`,
      [
        key,
        ent.account_id ?? null,
        ent.vm_id ?? null,
        ent.session_id ?? null,
        ent.device_id ?? null,
        ent.bound_at != null ? Math.trunc(Number(ent.bound_at) || Date.now()) : Date.now(),
        ent.expires_at != null ? Math.trunc(Number(ent.expires_at) || 0) : null,
        Math.trunc(Number(ent.hits) || 0),
        Math.trunc(Number(ent.generation) || 0),
        ent.slot_index == null ? null : Math.trunc(Number(ent.slot_index) || 0),
      ],
    )
  }

  _redisStickyKey(key) {
    if (!key) return ''
    if (this._isPrimaryDb()) return String(key)
    return `iso:${this.db?.[DB_INSTANCE_ID] || 'isolated'}:${key}`
  }

  _shouldWriteBehind() {
    if (this._explicitWriteBehind !== null) return this._explicitWriteBehind
    return writeBehindArmed() && this._isPrimaryDb()
  }

  _putL1(key, ent, now = Date.now()) {
    if (!key || !ent) return
    this._l1Neg.delete(key)
    if (this._l1.has(key)) this._l1.delete(key)
    while (this._l1.size >= STICKY_L1_MAX) {
      const oldest = this._l1.keys().next().value
      if (oldest === undefined) break
      this._l1.delete(oldest)
    }
    this._l1.set(key, { ent: { ...ent }, renewedAt: now })
    this._indexLatestParent(key, ent)
  }

  _putL1Neg(key, now = Date.now()) {
    if (!key) return
    if (this._l1Neg.has(key)) this._l1Neg.delete(key)
    while (this._l1Neg.size >= STICKY_L1_NEG_MAX) {
      const oldest = this._l1Neg.keys().next().value
      if (oldest === undefined) break
      this._l1Neg.delete(oldest)
    }
    this._l1Neg.set(key, now + STICKY_L1_NEG_TTL_MS)
  }

  _isL1Neg(key, now = Date.now()) {
    const exp = this._l1Neg.get(key)
    if (exp === undefined) return false
    if (exp <= now) {
      this._l1Neg.delete(key)
      return false
    }
    return true
  }

  _indexLatestParent(key, ent) {
    const device = String(ent?.device_id || '').trim()
    if (!device || !key) return
    const m = String(key).match(/^((?:p:[a-z]+:)?k[^:]+:)(.+)$/)
    if (!m) return
    const [, prefix, rest] = m
    if (!rest || /^(fam:|ch:|dev:|envelope$|login$)/.test(rest)) return
    const mapKey = `${prefix}\0${device}`
    const prev = this._latestByDevice.get(mapKey)
    const boundAt = Number(ent.bound_at) || 0
    if (!prev || boundAt >= prev.bound_at) {
      if (this._latestByDevice.size > 4096) this._latestByDevice.clear()
      this._latestByDevice.set(mapKey, {
        key,
        bound_at: boundAt,
        expires_at: Number(ent.expires_at) || 0,
      })
    }
  }

  _getEntrySync(key) {
    const cached = this._l1.get(key)
    if (cached) return cached.ent
    if (this._isL1Neg(key)) return null
    if (this._resolvePgPool()) return null
    const fromDb = this.repo.get(key)
    if (fromDb) this._putL1(key, fromDb)
    return fromDb || null
  }

  _formatBinding(key, ent) {
    return {
      accountId: ent.account_id,
      vmId: ent.vm_id,
      sessionId: ent.session_id || null,
      generation: Number(ent.generation) || 0,
      slotIndex: ent.slot_index == null ? null : Number(ent.slot_index),
      key,
    }
  }

  /** Kept for API compat + post-restore hook (state lives in DB). */
  reload() {
    this._l1.clear()
    this._l1Neg.clear()
    this._latestByDevice.clear()
  }

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    this.db = db
    this.repo = new StickyRepo(db)
    this._l1.clear()
    this._l1Neg.clear()
    this._latestByDevice.clear()
    this._prepareAuxStatements()
  }

  isolateKey(raw, req = null) {
    const id = req?.apiKeyRecord?.id
    if (id == null || id === '') return String(raw)
    return `k${id}:${raw}`
  }

  extractKey(req, body = {}) {
    if (!this.config.enabled) return null
    const mode = this.config.mode || 'conversation'

    if (mode === 'ip') {
      const ip = clientIp(req)
      return ip ? this.isolateKey(`ip:${ip}`, req) : null
    }
    if (mode === 'session') {
      const id = req?.apiKeyRecord?.id
      if (id != null && id !== '') return `k${id}:login`
      const auth = String(req?.headers?.authorization || req?.headers?.['x-api-key'] || '').trim()
      if (auth) {
        return this.isolateKey(`login:${crypto.createHash('sha256').update(auth).digest('hex').slice(0, 24)}`, req)
      }
      const ip = clientIp(req)
      return ip ? this.isolateKey(`ip:${ip}`, req) : null
    }

    if (isPersistableEnvelope(body)) {
      const id = req?.apiKeyRecord?.id
      if (id != null && id !== '') return `k${id}:envelope`
    }

    const caller = extractCallerSession({ inbound: body, body, headers: req?.headers || {} })
    if (caller && !EPHEMERAL_STICKY_KEYS.has(String(caller).toLowerCase())) {
      return this.isolateKey(caller, req)
    }
    for (const k of this.config.header_keys || []) {
      const key = String(k).toLowerCase()
      if (EPHEMERAL_STICKY_KEYS.has(key)) continue
      const v = req?.headers?.[key] || req?.headers?.[k]
      if (v) return this.isolateKey(String(v), req)
    }
    for (const k of this.config.body_keys || []) {
      if (body?.[k]) return this.isolateKey(String(body[k]), req)
    }
    const fp = firstUserFingerprint(body)
    if (fp) return this.isolateKey(`ch:${fp}`, req)
    return null
  }

  /**
   * Official Claude Code parent + child hops share metadata.user_id.device_id
   * even when the child mints a new session_id. Bind the family to one account.
   *
   * Agent / local-agent sub-agents are classified unofficial for persona
   * (oh-my-pi stealth), but they still send the parent device_id. Pool
   * sticky must use this key regardless of officialTraffic.
   */
  extractOfficialFamilyKey(req, body = {}) {
    if (!this.config.enabled) return null
    const parsed = parseUserId(body?.metadata?.user_id)
    const device = String(parsed?.device_id || '').trim()
    if (!device) return null
    return this.isolateKey(`dev:${device}`, req)
  }

  /** Ordered aliases for one logical conversation. Each caller session keeps its own key.
   * A child does not reuse the parent key or a device-wide fam slot.
   */
  collectPoolKeys(req, body = {}, opts = {}) {
    if (!this.config.enabled) return []
    const keys = []
    const platform = normalizeStickyPlatform(opts?.platform)
    const add = (key) => {
      const scoped = scopeStickyKey(key, platform)
      if (scoped && !keys.includes(scoped)) keys.push(scoped)
    }
    const caller = extractCallerSession({ inbound: body, body, headers: req?.headers || {} })
    if (caller && !EPHEMERAL_STICKY_KEYS.has(String(caller).toLowerCase())) {
      add(this.isolateKey(caller, req))
      return keys
    }
    const mode = this.config.mode || 'conversation'
    if (mode === 'conversation' && isPersistableEnvelope(body)) {
      const id = req?.apiKeyRecord?.id
      if (id != null && id !== '') add(`k${id}:envelope`)
      if (keys.length) return keys
    }
    const fingerprint = firstUserFingerprint(body)
    if (fingerprint) add(this.isolateKey(`ch:${fingerprint}`, req))
    return keys
  }

  /** Live parent for this device_id. Companions must not inherit fam:/alias rows
   * or another device's session on the same API key.
   */
  latestParentPoolKey(
    req,
    { platform = 'anthropic', now = Date.now(), withinMs = COMPANION_PARENT_MS, deviceId = '' } = {},
  ) {
    const device = String(deviceId || '').trim()
    if (!device) return null
    const id = req?.apiKeyRecord?.id
    if (id == null || id === '') return null
    const prefix = scopeStickyKey(this.isolateKey('', req), platform)
    if (!prefix) return null
    const mapKey = `${prefix}\0${device}`
    const memo = this._latestByDevice.get(mapKey)
    if (memo) {
      if (memo.expires_at > now && now - memo.bound_at <= withinMs) {
        return memo.key
      }
      if (memo.expires_at <= now) this._latestByDevice.delete(mapKey)
    }

    const pgPool = this._resolvePgPool()
    if (pgPool && typeof pgPool.query === 'function') {
      // Non-blocking PG backfill of _latestByDevice; never block main thread with PgSyncDb
      void pgPool
        .query(
          `SELECT key, device_id, bound_at, expires_at
           FROM sticky_sessions
           WHERE device_id = $1 AND expires_at > $2 AND bound_at >= $3
           ORDER BY bound_at DESC
           LIMIT 50`,
          [device, now, now - withinMs],
        )
        .then((res) => {
          for (const row of res?.rows || []) {
            const key = String(row.key || '')
            if (!key.startsWith(prefix)) continue
            const rest = key.slice(prefix.length)
            if (!rest || /^(fam:|ch:|dev:|envelope$|login$)/.test(rest)) continue
            this._latestByDevice.set(mapKey, {
              key,
              bound_at: Number(row.bound_at) || 0,
              expires_at: Number(row.expires_at) || 0,
            })
            break
          }
        })
        .catch(() => {})
      return null
    }

    if (this._stmtLatestByDevice) {
      try {
        const rows = this._stmtLatestByDevice.all(device, now, now - withinMs)
        for (const row of rows) {
          const key = String(row.key || '')
          if (!key.startsWith(prefix)) continue
          const rest = key.slice(prefix.length)
          if (!rest || /^(fam:|ch:|dev:|envelope$|login$)/.test(rest)) continue
          this._latestByDevice.set(mapKey, {
            key,
            bound_at: Number(row.bound_at) || 0,
            expires_at: Number(row.expires_at) || 0,
          })
          return key
        }
        return null
      } catch {}
    }

    let best = null
    let bestAt = 0
    for (const [key, ent] of Object.entries(this.repo.all())) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      if (!rest || /^(fam:|ch:|dev:|envelope$|login$)/.test(rest)) continue
      if (String(ent?.device_id || '') !== device) continue
      if (!ent?.expires_at || now > ent.expires_at) continue
      const at = Number(ent.bound_at) || 0
      if (now - at > withinMs) continue
      if (at < bestAt) continue
      bestAt = at
      best = key
    }
    return best
  }

  /**
   * One conversation, one pool key. An already-bound alias wins so a new
   * per-hop session id cannot open a second VM session.
   */
  extractPoolKey(req, body = {}, opts = {}) {
    const keys = this.collectPoolKeys(req, body, opts)
    const bound = keys.find((key) => this.resolve(key))
    if (bound) return bound
    if (normalizeStickyPlatform(opts?.platform) === 'anthropic') {
      const legacy = this.collectPoolKeys(req, body).find((key) => this.resolve(key))
      if (legacy) return legacy
    }
    return keys[0] || null
  }

  familyKey(req, sessionId, platform = '') {
    const id = String(sessionId || '').trim()
    if (!id || !this.config.enabled) return null
    return scopeStickyKey(this.isolateKey(`family:${id}`, req), platform)
  }

  /** Canonical session identity — exact sticky, never scoped to an API key. */
  canonicalSessionKey(sessionId) {
    const id = String(sessionId || '').trim()
    return id ? `sess:${id}` : null
  }

  /** Canonical device identity — VM affinity, never scoped to an API key. */
  canonicalDeviceKey(deviceId) {
    const id = String(deviceId || '').trim()
    return id ? `dev2:${id}` : null
  }

  /** Canonical family identity — parent/root session, never scoped to an API key. */
  canonicalFamilyKey(sessionId) {
    const id = String(sessionId || '').trim()
    return id ? `family2:${id}` : null
  }

  /**
   * Anthropic session sticky keys. A trusted inbound session_id maps to one
   * canonical key across API keys; a still-live legacy API-key-scoped row is
   * copied onto it once. Without a trusted session_id the legacy aliases stay.
   * @returns {{ stickyKey: string|null, stickyKeys: string[] }}
   */
  sessionPoolKeys(req, body = {}, { sessionId = '', deviceId = '', migrate = true } = {}) {
    if (!this.config.enabled) return { stickyKey: null, stickyKeys: [] }
    const canonical = this.canonicalSessionKey(sessionId)
    if (!canonical) {
      return {
        stickyKey: this.extractPoolKey(req, body, { platform: 'anthropic' }),
        stickyKeys: this.collectPoolKeys(req, body, { platform: 'anthropic' }),
      }
    }
    // Live legacy rows ride along as aliases so a credential failure unbinds
    // them too; otherwise the next turn would copy a dead pin back.
    const legacy = [
      ...new Set([...this.collectPoolKeys(req, body, { platform: 'anthropic' }), ...this.collectPoolKeys(req, body)]),
    ].filter((key) => key !== canonical && this.resolve(key))
    if (!this.resolve(canonical) && legacy.length) {
      if (!migrate) return { stickyKey: legacy[0], stickyKeys: legacy }
      this.migrateLegacyIdentity(legacy[0], { sessionId, deviceId })
    }
    return { stickyKey: canonical, stickyKeys: [canonical, ...legacy] }
  }

  /**
   * Family lock key. Trusted parent/root ids use the canonical key; a live
   * legacy family row is copied onto it once so an in-flight family stays put.
   */
  familyPoolKey(req, sessionId, { trusted = false } = {}) {
    const legacy = this.familyKey(req, sessionId, 'anthropic')
    if (!trusted || !legacy) return legacy
    const canonical = this.canonicalFamilyKey(sessionId)
    if (!this.resolve(canonical)) {
      const prev = this.resolve(legacy)
      if (prev?.accountId && prev?.vmId) {
        this.bind(canonical, { accountId: prev.accountId, vmId: prev.vmId }, { countHit: false })
      }
    }
    return canonical
  }

  /** @returns {{ accountId: string, vmId: string } | null } */
  resolve(key) {
    if (!key || !this.config.enabled) return null
    const now = Date.now()
    const cache = getCacheRuntime()
    const hasRedis = Boolean(cache?.client?.hasRedis)
    const cached = this._l1.get(key)
    if (cached) {
      const ent = cached.ent
      if (now > ent.expires_at) {
        this._l1.delete(key)
        return null
      }
      if (hasRedis && now - cached.renewedAt >= STICKY_RENEW_MIN_GAP_MS) {
        cached.renewedAt = now
        const renewTtl = Math.min(STICKY_REDIS_TTL_MS, Math.max(1_000, ent.expires_at - now))
        cache.concurrency.getSticky(this._redisStickyKey(key), { renewTtlMs: renewTtl }).catch(() => {})
      }
      return this._formatBinding(key, ent)
    }

    if (this._isL1Neg(key, now)) return null

    // In PG mode, never block the main thread with synchronous PgSyncDb Atomics.wait;
    // hot paths prewarm via `prewarmKeys()` / `resolveAsync()` (Redis -> async pgPool).
    const pgPool = this._resolvePgPool()
    if (pgPool && typeof pgPool.query === 'function') {
      void this.resolveAsync(key).catch(() => {})
      return null
    }

    const ent = this.repo.get(key)
    if (!ent) return null
    if (now > ent.expires_at) {
      return null
    }
    this._putL1(key, ent, now)
    if (hasRedis) {
      const ttlMs = Math.min(STICKY_REDIS_TTL_MS, Math.max(1_000, ent.expires_at - now))
      cache.concurrency.setSticky(this._redisStickyKey(key), ent, { ttlMs }).catch(() => {})
    }
    return this._formatBinding(key, ent)
  }

  /**
   * Async Redis-first sticky lookup: L1 -> Redis `getSticky` (auto-renews 1h TTL) -> async pgPool / SQLite backfill.
   */
  async resolveAsync(key) {
    if (!key || !this.config.enabled) return null
    const now = Date.now()
    const cache = getCacheRuntime()
    const hasRedis = Boolean(cache?.client?.hasRedis)
    const cached = this._l1.get(key)
    if (cached) {
      if (now > cached.ent.expires_at) {
        this._l1.delete(key)
      } else {
        if (hasRedis && now - cached.renewedAt >= STICKY_RENEW_MIN_GAP_MS) {
          cached.renewedAt = now
          const renewTtl = Math.min(STICKY_REDIS_TTL_MS, Math.max(1_000, cached.ent.expires_at - now))
          cache.concurrency.getSticky(this._redisStickyKey(key), { renewTtlMs: renewTtl }).catch(() => {})
        }
        return this._formatBinding(key, cached.ent)
      }
    }

    if (hasRedis) {
      const fromRedis = await cache.concurrency.getSticky(this._redisStickyKey(key), {
        renewTtlMs: STICKY_REDIS_TTL_MS,
      })
      if (fromRedis && typeof fromRedis === 'object' && fromRedis.account_id && fromRedis.vm_id) {
        if (!fromRedis.expires_at || now <= Number(fromRedis.expires_at)) {
          this._putL1(key, fromRedis, now)
          return this._formatBinding(key, fromRedis)
        }
      }
    }

    const pgPool = this._resolvePgPool()
    if (pgPool && typeof pgPool.query === 'function') {
      const fromPg = await this._getFromPgAsync(pgPool, key)
      if (fromPg && (!fromPg.expires_at || now <= Number(fromPg.expires_at))) {
        this._putL1(key, fromPg, now)
        if (hasRedis) {
          const ttlMs = Math.min(
            STICKY_REDIS_TTL_MS,
            Math.max(1_000, Number(fromPg.expires_at || now + STICKY_REDIS_TTL_MS) - now),
          )
          cache.concurrency.setSticky(this._redisStickyKey(key), fromPg, { ttlMs }).catch(() => {})
        }
        return this._formatBinding(key, fromPg)
      }
      this._putL1Neg(key, now)
      return null
    }

    return this.resolve(key)
  }

  /** Prewarm candidate sticky keys from Redis + batched async PG into L1 (0 Atomics.wait in PG mode). */
  async prewarmKeys(keys) {
    if (!this.config.enabled || !Array.isArray(keys) || !keys.length) return
    const cache = getCacheRuntime()
    const hasRedis = Boolean(cache?.client?.hasRedis)
    const pgPool = this._resolvePgPool()
    if (!hasRedis && !pgPool) return
    const now = Date.now()
    const unique = [...new Set(keys.filter((k) => k && !this._l1.has(k) && !this._isL1Neg(k, now)))]
    if (!unique.length) return

    let misses = unique
    if (hasRedis) {
      const redisResults = await Promise.all(
        unique.map(async (k) => {
          try {
            const ent = await cache.concurrency.getSticky(this._redisStickyKey(k), {
              renewTtlMs: STICKY_REDIS_TTL_MS,
            })
            return { k, ent }
          } catch {
            return { k, ent: null }
          }
        }),
      )
      misses = []
      for (const { k, ent } of redisResults) {
        if (
          ent &&
          typeof ent === 'object' &&
          ent.account_id &&
          ent.vm_id &&
          (!ent.expires_at || now <= Number(ent.expires_at))
        ) {
          this._putL1(k, ent, now)
        } else {
          misses.push(k)
        }
      }
    }

    if (!misses.length) return
    if (pgPool && typeof pgPool.query === 'function') {
      const fromPg = await this._getManyFromPgAsync(pgPool, misses)
      for (const k of misses) {
        const ent = fromPg.get(k)
        if (ent && (!ent.expires_at || now <= Number(ent.expires_at))) {
          this._putL1(k, ent, now)
          if (hasRedis) {
            const ttlMs = Math.min(
              STICKY_REDIS_TTL_MS,
              Math.max(1_000, Number(ent.expires_at || now + STICKY_REDIS_TTL_MS) - now),
            )
            cache.concurrency.setSticky(this._redisStickyKey(k), ent, { ttlMs }).catch(() => {})
          }
        } else {
          this._putL1Neg(k, now)
        }
      }
      return
    }
    for (const k of misses) {
      this.resolve(k)
    }
  }

  _persistUpsert(key, entry) {
    const cache = getCacheRuntime()
    if (cache?.client?.hasRedis) {
      const ttlMs = Math.min(STICKY_REDIS_TTL_MS, Math.max(1_000, (Number(entry.expires_at) || 0) - Date.now()))
      cache.concurrency.setSticky(this._redisStickyKey(key), entry, { ttlMs }).catch(() => {})
    }
    this._putL1(key, entry)
    const pgPool = this._resolvePgPool()
    if (pgPool && typeof pgPool.query === 'function') {
      const snapshot = { ...entry }
      this._trackPgWrite(this._upsertPgAsync(pgPool, key, snapshot))
      return
    }
    if (this._shouldWriteBehind()) {
      const snapshot = { ...entry }
      enqueueWrite(() => this.repo.upsert(key, snapshot))
    } else {
      this.repo.upsert(key, entry)
    }
  }

  bind(
    key,
    { accountId, vmId, sessionId = null, deviceId = null, slotIndex = null } = {},
    {
      countHit = true,
      ifGeneration = null,
      replaceSession = false,
      clearSlot = false,
      allowMove = false,
      keepExpiry = false,
    } = {},
  ) {
    if (!key || !this.config.enabled) return false
    const ttl = (this.config.ttl_seconds || 86400) * 1000
    const prev = this._getEntrySync(key) || {}
    const prevGeneration = Number(prev.generation) || 0
    if (ifGeneration != null && prevGeneration !== Number(ifGeneration)) return false
    const vmChanged = !!(prev.vm_id && vmId && prev.vm_id !== vmId)
    const accountChanged = !!(prev.account_id && accountId && prev.account_id !== accountId)
    const locked = vmChanged && accountChanged && !allowMove
    const nextAccount = locked ? prev.account_id : accountId
    const nextVm = locked ? prev.vm_id : vmId
    const nextSlot = locked
      ? (prev.slot_index ?? null)
      : clearSlot
        ? null
        : slotIndex == null
          ? (prev.slot_index ?? null)
          : Number(slotIndex)
    const changed = !!(
      prev.vm_id &&
      !clearSlot &&
      (nextAccount !== prev.account_id || nextVm !== prev.vm_id || (slotIndex != null && nextSlot !== prev.slot_index))
    )
    const generation = prev.vm_id ? (changed ? prevGeneration + 1 : prevGeneration || 1) : 1
    const sameVm = !!(prev.vm_id && nextVm && prev.vm_id === nextVm)
    const nextSessionId = locked
      ? prev.session_id || sessionId || null
      : replaceSession
        ? sessionId || null
        : sameVm
          ? prev.session_id || sessionId || null
          : sessionId || prev.session_id || null
    const device = deviceId == null ? prev.device_id || null : String(deviceId).trim() || null
    const now = Date.now()
    const nextEntry = {
      account_id: nextAccount,
      vm_id: nextVm,
      session_id: nextSessionId,
      device_id: device || null,
      bound_at: keepExpiry && Number(prev.bound_at) ? Number(prev.bound_at) : now,
      expires_at: keepExpiry && Number(prev.expires_at) > now ? Number(prev.expires_at) : now + ttl,
      hits: (prev.hits || 0) + (countHit ? 1 : 0),
      generation,
      slot_index: nextSlot,
    }
    this._persistUpsert(key, nextEntry)
    return true
  }

  /** Move an entire family together. Session rows stay until their next turn. */
  rebindFamily(key, { accountId, vmId } = {}) {
    if (!key || !this.config.enabled || !accountId || !vmId) return null
    const ttl = (this.config.ttl_seconds || 86400) * 1000
    const prev = this._getEntrySync(key) || {}
    const generation = (Number(prev.generation) || 0) + 1
    const now = Date.now()
    this._persistUpsert(key, {
      account_id: accountId,
      vm_id: vmId,
      session_id: null,
      device_id: prev.device_id || null,
      bound_at: now,
      expires_at: now + ttl,
      hits: prev.hits || 0,
      generation,
      slot_index: null,
    })
    return { generation, vmId, accountId }
  }

  /** Device VM affinity is a soft VM preference, not a session seat binding. */
  bindDeviceAffinity(key, { accountId, vmId } = {}, { countHit = false } = {}) {
    if (!key || !this.config.enabled || !accountId || !vmId) return null
    const ttl = (this.config.ttl_seconds || 86400) * 1000
    const prev = this._getEntrySync(key) || {}
    const changed = !!(prev.vm_id && (prev.account_id !== accountId || prev.vm_id !== vmId))
    const prevGeneration = Number(prev.generation) || 0
    const generation = prev.vm_id ? (changed ? prevGeneration + 1 : prevGeneration || 1) : 1
    const now = Date.now()
    this._persistUpsert(key, {
      account_id: accountId,
      vm_id: vmId,
      session_id: null,
      device_id: prev.device_id || null,
      bound_at: now,
      expires_at: now + ttl,
      hits: (prev.hits || 0) + (countHit ? 1 : 0),
      generation,
      slot_index: null,
    })
    return { generation, vmId, accountId }
  }

  /**
   * A4: bridge a legacy (API-key-scoped) sticky hit to the canonical,
   * key-less identity keys from A1. Call only when a request resolves
   * through an existing legacy key *and* carries a trusted session_id /
   * device_id (e.g. from resolveInboundIdentity/metadata.user_id) — this
   * never guesses an identity and never runs as a batch migration.
   *
   * Session canonical key reuses bind()'s locked/generation semantics:
   * a row is locked only when both VM and account differ, so a stale
   * legacy hit cannot silently merge onto another session's home.
   * Same-account VM moves still write the new outbound session. Device
   * canonical key reuses bindDeviceAffinity()'s existing soft-preference
   * semantics (A2), which is allowed to move — that is its documented
   * behavior already.
   *
   * The legacy row itself, and any unrelated row, is never modified or
   * deleted here.
   *
   * @returns {{ sessionKey: string|null, deviceKey: string|null }}
   */
  migrateLegacyIdentity(legacyKey, { sessionId = '', deviceId = '' } = {}) {
    const result = { sessionKey: null, deviceKey: null }
    if (!this.config.enabled || !legacyKey) return result
    const bound = this.resolve(legacyKey)
    if (!bound || !bound.accountId || !bound.vmId) return result

    const sessionKey = this.canonicalSessionKey(sessionId)
    if (sessionKey && sessionKey !== legacyKey) {
      this.bind(
        sessionKey,
        { accountId: bound.accountId, vmId: bound.vmId, sessionId: bound.sessionId || sessionId, deviceId },
        { countHit: false },
      )
      result.sessionKey = sessionKey
    }

    // A live device affinity is the principal's home VM; a legacy session hit
    // must not move it.
    const deviceKey = this.canonicalDeviceKey(deviceId)
    if (deviceKey && !this.resolve(deviceKey)) {
      this.bindDeviceAffinity(deviceKey, { accountId: bound.accountId, vmId: bound.vmId }, { countHit: false })
      result.deviceKey = deviceKey
    }

    return result
  }

  clear(key) {
    return this.unbind(key)
  }

  unbind(key) {
    if (!key) return
    this._l1.delete(key)
    this._putL1Neg(key)
    for (const [mk, rec] of this._latestByDevice) {
      if (rec.key === key) this._latestByDevice.delete(mk)
    }
    const cache = getCacheRuntime()
    if (cache?.client?.hasRedis) {
      cache.concurrency.delSticky(this._redisStickyKey(key)).catch(() => {})
    }
    const pgPool = this._resolvePgPool()
    if (pgPool && typeof pgPool.query === 'function') {
      this._trackPgWrite(pgPool.query('DELETE FROM sticky_sessions WHERE key = $1', [key]))
      return
    }
    if (this._shouldWriteBehind()) {
      enqueueWrite(() => this.repo.remove(key))
    } else {
      this.repo.remove(key)
    }
  }

  unbindByAccount({ accountId = null, vmId = null } = {}) {
    if (!accountId && !vmId) return 0
    const keysToDelete = new Set()
    for (const [k, { ent }] of this._l1) {
      if ((accountId && ent?.account_id === accountId) || (vmId && ent?.vm_id === vmId)) {
        keysToDelete.add(k)
        this._l1.delete(k)
        this._putL1Neg(k)
      }
    }
    for (const [mk, rec] of this._latestByDevice) {
      if (keysToDelete.has(rec.key)) this._latestByDevice.delete(mk)
    }
    const cache = getCacheRuntime()
    const hasRedis = Boolean(cache?.client?.hasRedis)
    const pgPool = this._resolvePgPool()
    if (pgPool && typeof pgPool.query === 'function') {
      if (hasRedis) {
        for (const k of keysToDelete) {
          cache.concurrency.delSticky(this._redisStickyKey(k)).catch(() => {})
        }
      }
      this._trackPgWrite(
        pgPool
          .query('DELETE FROM sticky_sessions WHERE account_id = $1 OR vm_id = $2 RETURNING key', [
            accountId || '',
            vmId || '',
          ])
          .then((res) => {
            if (!hasRedis) return
            for (const row of res?.rows || []) {
              if (row?.key && !keysToDelete.has(row.key)) {
                this._putL1Neg(row.key)
                cache.concurrency.delSticky(this._redisStickyKey(row.key)).catch(() => {})
              }
            }
          }),
      )
      return keysToDelete.size
    }
    if (hasRedis) {
      try {
        for (const [k, ent] of Object.entries(this.repo.all() || {})) {
          if ((accountId && ent?.account_id === accountId) || (vmId && ent?.vm_id === vmId)) {
            keysToDelete.add(k)
          }
        }
      } catch {}
      for (const k of keysToDelete) {
        cache.concurrency.delSticky(this._redisStickyKey(k)).catch(() => {})
      }
    }
    return this.repo.removeByAccount({ accountId, vmId })
  }

  /** Live keys pinned to this account or VM, so their windows leave with them. */
  boundKeys({ accountId = null, vmId = null } = {}) {
    if (!accountId && !vmId) return []
    this._purge()
    return Object.entries(this.repo.all() || {})
      .filter(([, ent]) => (accountId && ent?.account_id === accountId) || (vmId && ent?.vm_id === vmId))
      .map(([key, ent]) => ({ key, accountId: ent.account_id, vmId: ent.vm_id }))
  }

  _pruneLocalExpired(now = Date.now()) {
    for (const [k, { ent }] of this._l1) {
      if (ent?.expires_at && now > ent.expires_at) this._l1.delete(k)
    }
    for (const [k, exp] of this._l1Neg) {
      if (exp <= now) this._l1Neg.delete(k)
    }
    for (const [mk, rec] of this._latestByDevice) {
      if (rec?.expires_at && now > rec.expires_at) this._latestByDevice.delete(mk)
    }
  }

  async purgeExpiredAsync(now = Date.now()) {
    this._pruneLocalExpired(now)
    const pgPool = this._resolvePgPool()
    if (pgPool && typeof pgPool.query === 'function') {
      const res = await pgPool.query('DELETE FROM sticky_sessions WHERE expires_at < $1', [now])
      return Number(res?.rowCount) || 0
    }
    return this.repo.purgeExpired(now)
  }

  purgeExpired(now = Date.now()) {
    this._pruneLocalExpired(now)
    const pgPool = this._resolvePgPool()
    if (pgPool && typeof pgPool.query === 'function') {
      this._trackPgWrite(this.purgeExpiredAsync(now))
      return 0
    }
    return this.repo.purgeExpired(now)
  }

  _purge() {
    this.purgeExpired(Date.now())
  }

  _statsFromL1(now = Date.now(), { includeSessions = false } = {}) {
    this._pruneLocalExpired(now)
    let activeSessions = 0
    let totalHits = 0
    const sessions = {}
    for (const [key, { ent }] of this._l1) {
      if (!ent) continue
      if (ent.expires_at && now > ent.expires_at) continue
      activeSessions += 1
      totalHits += Number(ent.hits) || 0
      if (includeSessions && activeSessions <= STICKY_STATS_SESSIONS_LIMIT) {
        sessions[key] = { ...ent }
      }
    }
    return {
      enabled: !!this.config.enabled,
      mode: this.config.mode,
      active_sessions: activeSessions,
      total_hits: totalHits,
      sessions,
    }
  }

  _statsCacheBucket(includeSessions) {
    return includeSessions ? 'full' : 'counts'
  }

  _getCachedStatsL1(includeSessions, now = Date.now()) {
    const store = this._statsCache
    if (!store) return null
    const entry = store[this._statsCacheBucket(includeSessions)] || (!includeSessions ? store.full : null)
    if (!entry || now - entry.at >= STICKY_STATS_TTL_MS) return null
    return {
      ...entry.value,
      enabled: !!this.config.enabled,
      mode: this.config.mode,
      sessions: includeSessions ? entry.value.sessions || {} : {},
    }
  }

  _setCachedStatsL1(includeSessions, value, now = Date.now()) {
    if (!this._statsCache) this._statsCache = { counts: null, full: null }
    const bucket = this._statsCacheBucket(includeSessions)
    this._statsCache[bucket] = { value, at: now }
    if (includeSessions) {
      this._statsCache.counts = {
        value: {
          enabled: value.enabled,
          mode: value.mode,
          active_sessions: value.active_sessions,
          total_hits: value.total_hits,
          sessions: {},
        },
        at: now,
      }
    }
  }

  /**
   * Async sticky session statistics.
   * - PostgreSQL mode: runs off-main-thread `pgPool` aggregate COUNT/SUM (+ optional
   *   bounded rows when `includeSessions` is true) with 5s L1/Redis cache, avoiding
   *   synchronous `DELETE` + full-table `SELECT * FROM sticky_sessions`.
   * - SQLite mode: preserves original synchronous `purgeExpired` + `repo.all()` semantics.
   */
  async statsAsync({ includeSessions = false, bypass = false, now = Date.now() } = {}) {
    const pgPool = this._resolvePgPool()
    if (!pgPool || typeof pgPool.query !== 'function') {
      return this.stats({ includeSessions, now })
    }

    if (!bypass) {
      const l1 = this._getCachedStatsL1(includeSessions, now)
      if (l1) return l1
    }

    const bucket = this._statsCacheBucket(includeSessions)
    const cache = getCacheRuntime()
    const useRedis = !bypass && this._isPrimaryDb() && Boolean(cache?.client?.hasRedis)
    const redisKey = `${STICKY_STATS_REDIS_PREFIX}${bucket}`
    if (useRedis) {
      try {
        const hit = await cache.client.get(redisKey, {
          useL2: true,
          prefixes: ['dash:', STICKY_STATS_REDIS_PREFIX],
          maxL1TtlMs: STICKY_STATS_TTL_MS,
        })
        if (hit?.hit && hit.value && typeof hit.value === 'object') {
          const hydrated = {
            enabled: !!this.config.enabled,
            mode: this.config.mode,
            active_sessions: Number(hit.value.active_sessions) || 0,
            total_hits: Number(hit.value.total_hits) || 0,
            sessions: includeSessions && hit.value.sessions ? hit.value.sessions : {},
          }
          this._setCachedStatsL1(includeSessions, hydrated, Date.now())
          return hydrated
        }
      } catch {}
    }

    if (!this._statsRefreshPromises) this._statsRefreshPromises = { counts: null, full: null }
    if (!bypass && this._statsRefreshPromises[bucket]) {
      return this._statsRefreshPromises[bucket]
    }

    const loadPromise = (async () => {
      try {
        const queryNow = Date.now()
        const aggPromise = pgPool.query(
          `SELECT COUNT(*)::bigint AS active_sessions,
                  COALESCE(SUM(hits), 0)::bigint AS total_hits
           FROM sticky_sessions
           WHERE expires_at IS NULL OR expires_at >= $1`,
          [queryNow],
        )
        const rowsPromise = includeSessions
          ? pgPool.query(
              `SELECT *
               FROM sticky_sessions
               WHERE expires_at IS NULL OR expires_at >= $1
               ORDER BY bound_at DESC NULLS LAST
               LIMIT $2`,
              [queryNow, STICKY_STATS_SESSIONS_LIMIT],
            )
          : null

        const [aggRes, rowsRes] = await Promise.all([aggPromise, rowsPromise])
        const aggRow = aggRes?.rows?.[0] || {}
        const sessions = {}
        if (includeSessions && rowsRes?.rows) {
          for (const row of rowsRes.rows) {
            if (!row?.key) continue
            const ent = rowToStickyEntry(row)
            if (ent) sessions[row.key] = ent
          }
        }
        const value = {
          enabled: !!this.config.enabled,
          mode: this.config.mode,
          active_sessions: Math.max(0, Number(aggRow.active_sessions) || 0),
          total_hits: Math.max(0, Number(aggRow.total_hits) || 0),
          sessions,
        }
        this._setCachedStatsL1(includeSessions, value, Date.now())
        if (this._isPrimaryDb() && cache?.client?.hasRedis) {
          cache.client
            .set(redisKey, value, {
              ttlMs: STICKY_STATS_TTL_MS,
              l1TtlMs: STICKY_STATS_TTL_MS,
              prefixes: ['dash:', STICKY_STATS_REDIS_PREFIX],
            })
            .catch(() => {})
        }
        return value
      } catch {
        return this._statsFromL1(now, { includeSessions })
      } finally {
        if (this._statsRefreshPromises?.[bucket] === loadPromise) {
          this._statsRefreshPromises[bucket] = null
        }
      }
    })()

    if (!bypass) this._statsRefreshPromises[bucket] = loadPromise
    return loadPromise
  }

  stats({ includeSessions = false, now = Date.now() } = {}) {
    const pgPool = this._resolvePgPool()
    if (pgPool && typeof pgPool.query === 'function') {
      const cached = this._getCachedStatsL1(includeSessions, now)
      if (cached) return cached
      // Non-blocking background refresh; never block the main thread with sync repo.all() in PG mode.
      void this.statsAsync({ includeSessions, now }).catch(() => {})
      const bucket = this._statsCacheBucket(includeSessions)
      const stale = this._statsCache?.[bucket]?.value || (!includeSessions ? this._statsCache?.full?.value : null)
      if (stale) {
        return {
          ...stale,
          enabled: !!this.config.enabled,
          mode: this.config.mode,
          sessions: includeSessions ? stale.sessions || {} : {},
        }
      }
      return this._statsFromL1(now, { includeSessions })
    }
    this._purge()
    const sessions = this.repo.all()
    const list = Object.values(sessions || {})
    return {
      enabled: !!this.config.enabled,
      mode: this.config.mode,
      active_sessions: Object.keys(sessions).length,
      total_hits: list.reduce((n, s) => n + (Number(s.hits) || 0), 0),
      sessions,
    }
  }

  reloadConfig(config) {
    this.config = mergeStickyConfig(config)
  }
}
