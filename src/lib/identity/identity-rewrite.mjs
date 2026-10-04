/**
 * Slot identity rewrite for the Go worker HTTP data plane.
 *
 *   device_id     → slot (VM) device
 *   account_uuid  → real OAuth account of the slot
 *   session_id    → rebuild (default): mint from inbound identity + epoch;
 *                   reuse sticky session_id while the VM is unchanged.
 *                   passthrough: official Claude Code keeps the caller
 *                   session; unofficial hashes the caller token. With no
 *                   caller session, derive a UUID from account + client +
 *                   first user content (sub2api buildStableSessionSeed).
 *                   Callers pass the full first-user content fingerprint as
 *                   firstUserIdentity; firstUserText stays billing-only.
 *                   Never randomUUID while any of those anchors exist. A
 *                   sticky row for the same VM reuses the id it already stored.
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

/** Prefix so rebuild values cannot collide with unofficial / stable hashes. */
export const REBUILD_SESSION_SEED = 'kin-rebuild-session:'

/** Prefix so a sub-agent session cannot collide with any other derived id. */
export const AGENT_SESSION_SEED = 'kin-claude-code-agent:'

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

const FIRST_USER_TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text'])

/** Whitespace inside one content block never acts as a block boundary. */
function normalizeFirstUserText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Stable JSON for multimodal blocks: key order cannot change the hash, and
 * cache hints are transport state, not content.
 */
function canonicalFirstUserJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalFirstUserJson).join(',')}]`
  const keys = Object.keys(value)
    .filter((key) => key !== 'cache_control')
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalFirstUserJson(value[key])}`).join(',')}}`
}

/** One typed content block; text blocks compare by text, every other block by its full shape. */
function canonicalFirstUserPart(part) {
  if (typeof part === 'string') return ['text', normalizeFirstUserText(part)]
  if (!part || typeof part !== 'object') return ['raw', String(part)]
  const type = String(part.type || '').toLowerCase()
  if (typeof part.text === 'string' && (!type || FIRST_USER_TEXT_PART_TYPES.has(type))) {
    return ['text', normalizeFirstUserText(part.text)]
  }
  return ['part', canonicalFirstUserJson(part)]
}

/** First user message of messages / Codex input / legacy prompt bodies. */
function firstUserMessageContent(body = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : null
  if (messages && messages.length) {
    const user = messages.find((m) => String(m?.role || m?.type || '').toLowerCase() === 'user') || messages[0]
    return user?.content ?? user?.text ?? user?.input ?? null
  }
  if (typeof body?.input === 'string') return body.input
  if (Array.isArray(body?.input) && body.input.length) {
    const user = body.input.find((m) => String(m?.role || m?.type || '').toLowerCase() === 'user') || body.input[0]
    if (typeof user === 'string') return user
    return user?.content ?? user?.text ?? null
  }
  if (typeof body?.prompt === 'string') return body.prompt
  return null
}

/**
 * Deterministic identity of the first user message: full typed, ordered
 * content of every block, no length truncation. A leading system-reminder or
 * date preamble shared by different openers cannot collide, while an unchanged
 * opener stays stable across turns. Later messages never change the
 * fingerprint. Returns '' when the request has no usable first-user content.
 */
export function firstUserContentFingerprint(body = {}) {
  const content = firstUserMessageContent(body)
  if (content == null) return ''
  const parts = (Array.isArray(content) ? content.filter((part) => part != null) : [content]).map(
    canonicalFirstUserPart,
  )
  if (!parts.length) return ''
  if (parts.every((part) => part[0] === 'text' && part[1] === '')) return ''
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** Marks first-user content fingerprints inside stable session seeds. */
export const FIRST_USER_CONTENT_SEED_PREFIX = 'first-user-content:'

/**
 * Session seed material: the caller's first-user content fingerprint when
 * given (see firstUserContentFingerprint), otherwise legacy raw text for
 * callers that have not migrated yet. firstUserText itself stays billing-only.
 */
function stableFirstUserMaterial(opts = {}) {
  const identity = String(opts.firstUserIdentity || '').trim()
  if (identity) return FIRST_USER_CONTENT_SEED_PREFIX + identity
  return String(opts.firstUserText || '')
}

/**
 * Account + client + first user identity material. Appending later messages
 * does not change the material. This is not the pool sticky key.
 */
export function buildStableSessionSeed(accountId, clientDiscriminator, firstUserMaterial) {
  return `${String(accountId ?? '').trim()}::${String(clientDiscriminator ?? '')}::${String(firstUserMaterial ?? '')}`
}

function stableSessionMaterial(accountId, clientDiscriminator, firstUserMaterial) {
  if (String(accountId || '').trim()) return true
  if (String(firstUserMaterial || '').trim()) return true
  return (
    String(clientDiscriminator || '')
      .replace(/:/g, '')
      .trim() !== ''
  )
}

/** Deterministic v4-shaped UUID. Used for unofficial / rebuild outbound session_id. */
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
      parent_session_id: raw.parent_session_id || raw.parentSessionId || '',
      root_session_id: raw.root_session_id || raw.rootSessionId || '',
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
        parent_session_id: p.parent_session_id || p.parentSessionId || '',
        root_session_id: p.root_session_id || p.rootSessionId || '',
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

function cleanIdentityValue(value) {
  return String(value || '').trim()
}

/**
 * Trusted inbound identity for pool routing. Priority:
 * metadata.user_id.session_id/device_id > explicit inbound device_id field/header.
 * Never falls back to API key, IP, UA, or content fingerprint.
 * @returns {{ sessionId: string, deviceId: string, source: 'metadata'|'explicit-device'|'none' }}
 */
export function resolveInboundIdentity({ inbound = {}, body = {}, headers = {} } = {}) {
  let sessionId = ''
  let deviceId = ''
  for (const raw of [inbound?.metadata?.user_id, body?.metadata?.user_id]) {
    const parsed = parseUserId(raw)
    if (!parsed) continue
    if (!sessionId) sessionId = cleanIdentityValue(parsed.session_id)
    if (!deviceId) deviceId = cleanIdentityValue(parsed.device_id)
    if (sessionId && deviceId) break
  }
  // A sub-agent hop keeps the main session_id; it is its own session.
  sessionId = agentSessionId(sessionId, claudeCodeAgentId(headers))
  if (deviceId) return { sessionId, deviceId, source: 'metadata' }

  const explicitDevice =
    cleanIdentityValue(inbound?.device_id) ||
    cleanIdentityValue(body?.device_id) ||
    headerValue(headers, 'x-kin-device-id').trim()
  if (explicitDevice) return { sessionId, deviceId: explicitDevice, source: 'explicit-device' }
  // A metadata session_id without any device still pins its own session.
  if (sessionId) return { sessionId, deviceId: '', source: 'metadata' }
  return { sessionId: '', deviceId: '', source: 'none' }
}

/**
 * Claude Code (>= 2.1.139) sends the main session_id on every hop and marks
 * sub-agent hops with x-claude-code-agent-id (nested agents add
 * x-claude-code-parent-agent-id). Main-thread hops carry neither.
 */
export function claudeCodeAgentId(headers = {}) {
  return headerValue(headers, 'x-claude-code-agent-id').trim()
}

/**
 * One CLI session per sub-agent, stable for the agent's lifetime. Without an
 * agent id the root session is the session. UUID-shaped because official
 * passthrough sends it upstream as metadata.user_id.session_id.
 */
export function agentSessionId(rootSessionId, agentId) {
  const root = String(rootSessionId || '').trim()
  const agent = String(agentId || '').trim()
  if (!root || !agent) return root
  return uuidFromSeed(`${AGENT_SESSION_SEED}${root}#${agent}`)
}

/** Main session a Claude Code sub-agent hop belongs to; '' on main-thread hops. */
export function claudeCodeAgentRootSession({ inbound = {}, body = {}, headers = {} } = {}) {
  if (!claudeCodeAgentId(headers)) return ''
  return rootCallerSession({ inbound, body, headers })
}

/**
 * Caller session, in official order: metadata.user_id → sticky headers → body keys.
 * A Claude Code sub-agent hop gets its own session under that root.
 */
export function extractCallerSession({ inbound = {}, body = {}, headers = {} } = {}) {
  return agentSessionId(rootCallerSession({ inbound, body, headers }), claudeCodeAgentId(headers))
}

function rootCallerSession({ inbound, body, headers }) {
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

export function outboundSessionMode(routing) {
  const raw = String(routing?.sticky?.outbound_session || '')
    .trim()
    .toLowerCase()
  return raw === 'passthrough' ? 'passthrough' : 'rebuild'
}

/** Deterministic outbound session for one identity + bind-generation epoch. */
export function rebuildOutboundSession({ identity, epoch } = {}) {
  return uuidFromSeed(`${REBUILD_SESSION_SEED}${String(identity ?? '')}#${epoch}`)
}

function resolvePassthroughOutboundSessionId(caller, opts) {
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
  const firstUserMaterial = stableFirstUserMaterial(opts)
  if (stableSessionMaterial(accountId, discriminator, firstUserMaterial)) {
    return uuidFromSeed(STABLE_SESSION_SEED + buildStableSessionSeed(accountId, discriminator, firstUserMaterial))
  }
  return crypto.randomUUID()
}

/**
 * rebuild (default): same VM reuses the sticky outbound id; otherwise mint
 * from inbound A (or the stable seed) + epoch. passthrough keeps the old
 * official-keeps-A / unofficial-hash behavior.
 */
export function resolveOutboundSessionId(callerSession, opts = {}) {
  const caller = String(callerSession || '').trim()
  const mode = opts.mode || outboundSessionMode(opts.routing)
  if (mode === 'passthrough') return resolvePassthroughOutboundSessionId(caller, opts)

  const boundSessionId = String(opts.boundSessionId || '').trim()
  const boundVmId = String(opts.boundVmId || '').trim()
  const vmId = String(opts.vmId || '').trim()
  const sameVm = Boolean(boundVmId && vmId && boundVmId === vmId)
  if (boundSessionId && sameVm) return boundSessionId

  const accountId = String(opts.accountId || '').trim()
  const discriminator =
    opts.clientDiscriminator != null
      ? String(opts.clientDiscriminator)
      : sessionContextDiscriminator({
          clientIp: opts.clientIp,
          userAgent: opts.userAgent,
          apiKeyId: opts.apiKeyId,
        })
  const firstUserMaterial = stableFirstUserMaterial(opts)
  const identity = caller || buildStableSessionSeed(accountId, discriminator, firstUserMaterial)
  if (caller || stableSessionMaterial(accountId, discriminator, firstUserMaterial)) {
    return rebuildOutboundSession({ identity, epoch: opts.epoch ?? 'pending' })
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
      mode: opts.mode,
      routing: opts.routing,
      accountId: opts.accountId || identity?.accountId || identity?.vmId || '',
      boundSessionId: opts.boundSessionId,
      boundAccountId: opts.boundAccountId,
      boundVmId: opts.boundVmId,
      vmId: opts.vmId || identity?.vmId || '',
      epoch: opts.epoch,
      clientDiscriminator: opts.clientDiscriminator,
      clientIp: opts.clientIp,
      userAgent: opts.userAgent || headerValue(reqHeaders, 'user-agent'),
      apiKeyId: opts.apiKeyId,
      firstUserText: opts.firstUserText,
      firstUserIdentity: opts.firstUserIdentity,
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
