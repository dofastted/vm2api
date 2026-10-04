/**
 * Configurable sticky / conversation-continuity routing (SQLite-backed).
 * Binds conversation key → account/VM for the TTL window.
 */

import crypto from 'node:crypto'
import { ENVELOPE_NEEDLES, extractPrompt } from '../core/distill-detect.mjs'
import { resolveStoreDb } from '../db/database.mjs'
import { StickyRepo } from '../db/repos/sticky-repo.mjs'
import {
  claudeCodeAgentRootSession,
  extractCallerSession,
  firstUserContentFingerprint,
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

/**
 * Session-slot fingerprint: canonical full content of the first user message
 * (typed, ordered, no length truncation). Later messages never participate, so
 * a growing transcript keeps its slot, while a leading block shared by
 * different openers (date/system-reminder preamble) cannot merge two
 * conversations. An explicit session id is the only stable key when a client
 * rewrites its first message.
 */
export function firstUserFingerprint(body = {}) {
  return firstUserContentFingerprint(body).slice(0, 24)
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
 * One-shot test calls: sub2api account test, new-api channel test, verify
 * scripts. One short text user turn, no tools, any max_tokens. They carry no
 * conversation, so they must not hold a session seat or move a sticky pin.
 */
export function isShortProbeRequest(body = {}) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  if (msgs.length !== 1 || String(msgs[0]?.role || '').toLowerCase() !== 'user') return false
  const tools = body?.tools
  if (Array.isArray(tools) ? tools.length > 0 : !!tools) return false
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
  constructor({ dataDir, db, config }) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new StickyRepo(this.db)
    this.config = mergeStickyConfig(config)
    this.repo.dropAliasKeys()
  }

  /** Kept for API compat + post-restore hook (state lives in DB). */
  reload() {}

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    this.db = db
    this.repo = new StickyRepo(db)
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
    this._purge()
    const ent = this.repo.get(key)
    if (!ent) return null
    if (Date.now() > ent.expires_at) {
      this.repo.remove(key)
      return null
    }
    return {
      accountId: ent.account_id,
      vmId: ent.vm_id,
      sessionId: ent.session_id || null,
      generation: Number(ent.generation) || 0,
      slotIndex: ent.slot_index == null ? null : Number(ent.slot_index),
      key,
    }
  }

  bind(
    key,
    { accountId, vmId, sessionId = null, deviceId = null, slotIndex = null } = {},
    { countHit = true, ifGeneration = null, replaceSession = false, clearSlot = false } = {},
  ) {
    if (!key || !this.config.enabled) return false
    const ttl = (this.config.ttl_seconds || 86400) * 1000
    const prev = this.repo.get(key) || {}
    const prevGeneration = Number(prev.generation) || 0
    if (ifGeneration != null && prevGeneration !== Number(ifGeneration)) return false
    const vmChanged = !!(prev.vm_id && vmId && prev.vm_id !== vmId)
    const accountChanged = !!(prev.account_id && accountId && prev.account_id !== accountId)
    const locked = vmChanged && accountChanged
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
    const device = String(deviceId || '').trim()
    this.repo.upsert(key, {
      account_id: nextAccount,
      vm_id: nextVm,
      session_id: nextSessionId,
      device_id: device || null,
      bound_at: Date.now(),
      expires_at: Date.now() + ttl,
      hits: (prev.hits || 0) + (countHit ? 1 : 0),
      generation,
      slot_index: nextSlot,
    })
    return true
  }

  /** Move an entire family together. Session rows stay until their next turn. */
  rebindFamily(key, { accountId, vmId } = {}) {
    if (!key || !this.config.enabled || !accountId || !vmId) return null
    const ttl = (this.config.ttl_seconds || 86400) * 1000
    const prev = this.repo.get(key) || {}
    const generation = (Number(prev.generation) || 0) + 1
    this.repo.upsert(key, {
      account_id: accountId,
      vm_id: vmId,
      session_id: null,
      device_id: prev.device_id || null,
      bound_at: Date.now(),
      expires_at: Date.now() + ttl,
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
    const prev = this.repo.get(key) || {}
    const changed = !!(prev.vm_id && (prev.account_id !== accountId || prev.vm_id !== vmId))
    const prevGeneration = Number(prev.generation) || 0
    const generation = prev.vm_id ? (changed ? prevGeneration + 1 : prevGeneration || 1) : 1
    this.repo.upsert(key, {
      account_id: accountId,
      vm_id: vmId,
      session_id: null,
      device_id: prev.device_id || null,
      bound_at: Date.now(),
      expires_at: Date.now() + ttl,
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

  unbind(key) {
    if (!key) return
    this.repo.remove(key)
  }

  unbindByAccount({ accountId = null, vmId = null } = {}) {
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

  _purge() {
    this.repo.purgeExpired(Date.now())
  }

  stats() {
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
