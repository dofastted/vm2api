/**
 * Slot identity rewrite for the Go worker HTTP data plane.
 *
 *   device_id     → slot (VM) device
 *   account_uuid  → real OAuth account of the slot
 *   session_id    → official Claude Code keeps the caller's session.
 *                   Unofficial hashes the caller token. With no caller
 *                   session, derive a UUID from account + client + first
 *                   user text (sub2api buildStableSessionSeed). Never
 *                   randomUUID while any of those anchors exist. A sticky
 *                   row for the same account reuses the id it already stored.
 *                   Outbound always has a session. Email never goes in
 *                   metadata.user_id (Anthropic 400 has_at).
 *
 * Client settings/env/identity fields are always dropped.
 * Pool sticky prefers metadata.user_id.device_id (parent + sub-agent family),
 * then session headers. Outbound session_id is still rewritten here and is
 * not the pool key.
 */
import crypto from 'node:crypto'
import { formatMetadataUserId } from './vm-identity.mjs'

export const IDENTITY_REPLACE = Object.freeze([
  'device_id',
  'account_uuid',
  'session_id',
  'authorization',
  'fingerprint',
  'settings',
])

export const CALLER_SESSION_HEADER_KEYS = Object.freeze([
  'x-session-id',
  'x-conversation-id',
  'x-claude-code-session-id',
  'session-id',
  'thread-id',
])

export const CALLER_SESSION_BODY_KEYS = Object.freeze([
  'conversation_id',
  'session_id',
  'thread_id',
  'prompt_cache_key',
])

export const UNOFFICIAL_SESSION_SEED = 'kin-unofficial-session:'

/** Prefix so a stable seed cannot collide with an unofficial caller hash. */
export const STABLE_SESSION_SEED = 'kin-stable-session:'

const SESSION_UA_PRODUCT = /([A-Za-z0-9._-]+)\/[A-Za-z0-9._-]+/g
const SESSION_UA_VERSION = /\bv?\d+(?:\.\d+){1,3}\b/g

/**
 * Product names only, sorted. CLI version bumps must not mint a new session.
 * Same rule as sub2api NormalizeSessionUserAgent.
 */
export function normalizeSessionUserAgent(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  const products = []
  const seen = new Set()
  for (const match of text.matchAll(SESSION_UA_PRODUCT)) {
    const product = String(match[1] || '')
      .trim()
      .toLowerCase()
    if (!product || seen.has(product)) continue
    seen.add(product)
    products.push(product)
  }
  if (!products.length) {
    return text.toLowerCase().replace(SESSION_UA_VERSION, '').replace(/\s+/g, ' ').trim()
  }
  products.sort()
  return products.join('+')
}

/** IP + normalized UA + API key. Separates clients that share a first message. */
export function sessionContextDiscriminator({ clientIp = '', userAgent = '', apiKeyId = '' } = {}) {
  const ip = String(clientIp || '').trim()
  const ua = normalizeSessionUserAgent(userAgent)
  const key = apiKeyId == null || apiKeyId === '' ? '' : String(apiKeyId).trim()
  return `${ip}:${ua}:${key}`
}

/**
 * Account + client + first user text. Appending later messages does not
 * change the seed. This is not the pool sticky key.
 */
export function buildStableSessionSeed(accountId, clientDiscriminator, firstUserText) {
  return `${String(accountId ?? '').trim()}::${String(clientDiscriminator ?? '')}::${String(firstUserText ?? '')}`
}

function stableSessionMaterial(accountId, clientDiscriminator, firstUserText) {
  if (String(accountId || '').trim()) return true
  if (String(firstUserText || '').trim()) return true
  return (
    String(clientDiscriminator || '')
      .replace(/:/g, '')
      .trim() !== ''
  )
}

/** Deterministic v4-shaped UUID. Used for unofficial outbound session_id. */
export function uuidFromSeed(seed) {
  const hex = crypto
    .createHash('sha256')
    .update(String(seed || ''))
    .digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hex.slice(18, 20),
    hex.slice(20, 32),
  ].join('-')
}

export function parseUserId(raw) {
  if (!raw) return null
  if (typeof raw === 'object') {
    return {
      device_id: raw.device_id || raw.deviceId || '',
      account_uuid: raw.account_uuid || raw.accountUuid || '',
      session_id: raw.session_id || raw.sessionId || '',
    }
  }
  const s = String(raw)
  try {
    const p = JSON.parse(s)
    if (p && typeof p === 'object') {
      return {
        device_id: p.device_id || p.deviceId || '',
        account_uuid: p.account_uuid || p.accountUuid || '',
        session_id: p.session_id || p.sessionId || '',
      }
    }
  } catch {}
  const m = /^user_(.*?)_account_(.*?)_session_(.*)$/.exec(s)
  if (m) return { device_id: m[1], account_uuid: m[2], session_id: m[3] }
  return null
}

function headerValue(headers, key) {
  if (!headers || typeof headers !== 'object') return ''
  const want = String(key).toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() !== want) continue
    if (v == null || v === '') continue
    return String(Array.isArray(v) ? v[0] : v)
  }
  return ''
}

/**
 * Caller session, in official order: metadata.user_id → sticky headers → body keys.
 */
export function extractCallerSession({ inbound = {}, body = {}, headers = {} } = {}) {
  const raw = inbound?.metadata?.user_id || body?.metadata?.user_id
  const parsed = parseUserId(raw) || {}
  if (parsed.session_id) return String(parsed.session_id)
  for (const key of CALLER_SESSION_HEADER_KEYS) {
    const v = headerValue(headers, key)
    if (v) return v
  }
  const src = inbound && typeof inbound === 'object' && Object.keys(inbound).length ? inbound : body
  for (const key of CALLER_SESSION_BODY_KEYS) {
    if (src?.[key]) return String(src[key])
  }
  return ''
}

export function sessionIdFromOutboundBody(body = {}) {
  return parseUserId(body?.metadata?.user_id)?.session_id || ''
}

/**
 * Official Claude Code: keep the caller's session.
 * Unofficial: hash the caller token so the raw value never goes upstream.
 * No caller session: reuse the sticky row's outbound id for this account,
 * otherwise a deterministic UUID. randomUUID only when nothing identifies
 * the conversation.
 */
export function resolveOutboundSessionId(callerSession, opts = {}) {
  const caller = String(callerSession || '').trim()
  const officialClient = opts.officialClient === true
  if (officialClient && caller) return caller
  if (!officialClient && caller) return uuidFromSeed(UNOFFICIAL_SESSION_SEED + caller)

  const accountId = String(opts.accountId || '').trim()
  const boundAccountId = String(opts.boundAccountId || '').trim()
  const boundSessionId = String(opts.boundSessionId || '').trim()
  const sameAccount = !boundAccountId || !accountId || boundAccountId === accountId
  if (boundSessionId && sameAccount) return boundSessionId

  const discriminator =
    opts.clientDiscriminator != null
      ? String(opts.clientDiscriminator)
      : sessionContextDiscriminator({
          clientIp: opts.clientIp,
          userAgent: opts.userAgent,
          apiKeyId: opts.apiKeyId,
        })
  const firstUserText = String(opts.firstUserText || '')
  if (stableSessionMaterial(accountId, discriminator, firstUserText)) {
    return uuidFromSeed(STABLE_SESSION_SEED + buildStableSessionSeed(accountId, discriminator, firstUserText))
  }
  return crypto.randomUUID()
}

/**
 * Slot device + credential account + resolved outbound session.
 */
export function applyCrsIdentityReplace(body, identity, inbound = {}, reqHeaders = {}, opts = {}) {
  const out = { ...(body || {}) }
  delete out.settings
  delete out.claude_settings
  delete out.env
  delete out.user
  delete out.user_id

  const raw = inbound?.metadata?.user_id || body?.metadata?.user_id
  const parsed = parseUserId(raw) || {}
  const deviceId = identity.deviceId || identity.machineId || ''
  const accountUuid = identity.accountUuid || parsed.account_uuid || ''
  const officialClient = opts.officialClient === true
  const sessionId =
    String(opts.sessionId || '').trim() ||
    resolveOutboundSessionId(extractCallerSession({ inbound, body, headers: reqHeaders }), {
      officialClient,
      accountId: opts.accountId || identity?.accountId || identity?.vmId || '',
      boundSessionId: opts.boundSessionId,
      boundAccountId: opts.boundAccountId,
      clientDiscriminator: opts.clientDiscriminator,
      clientIp: opts.clientIp,
      userAgent: opts.userAgent || headerValue(reqHeaders, 'user-agent'),
      apiKeyId: opts.apiKeyId,
      firstUserText: opts.firstUserText,
    })

  const md = {}
  if (out.metadata && typeof out.metadata === 'object') {
    for (const [k, v] of Object.entries(out.metadata)) {
      if (/user|machine|device|host|tz|timezone|locale|setting|session_source|email/i.test(k)) continue
      md[k] = v
    }
  }
  md.user_id = formatMetadataUserId({
    deviceId,
    accountUuid,
    sessionId,
  })
  out.metadata = md
  return out
}
