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
 *                   first user identity text (first non-reminder block).
 *                   Never use a random UUID while any of those anchors exist. A sticky
 *                   row for the same VM reuses the id it already stored.
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
import { isShortProbeRequest } from '../pool/sticky-router.mjs'

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

/** Prefix so multi-turn headless scheduler sessions stay isolated from other derived ids. */
export const SCHEDULER_SESSION_SEED = 'kin-scheduler-session:'

/** Precedence order for inbound machine_id headers (never forged from IP/UA). */
export const MACHINE_ID_HEADER_KEYS = Object.freeze(['x-machine-id', 'x-kin-machine-id', 'x-kin-device-id'])

/** Transient per-request headers that must never act as a session_id. */
const EPHEMERAL_SESSION_HEADER_KEYS = new Set(['x-request-id', 'x-client-request-id'])

const SESSION_UA_PRODUCT = /([A-Za-z0-9._-]+)\/[A-Za-z0-9._-]+/g
const SESSION_UA_VERSION = /\bv?\d+(?:\.\d+){1,3}\b/g

/**
 * Product names only, sorted. CLI version bumps must not mint a new session.
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

const SYSTEM_REMINDER_BLOCK_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi

/** Nothing but <system-reminder> blocks: client-injected context (date, cwd, rules), not the conversation. */
export function isSystemReminderOnly(text) {
  const t = String(text ?? '').trim()
  return t !== '' && t.replace(SYSTEM_REMINDER_BLOCK_RE, '').trim() === ''
}

/**
 * Session identity of the first user message, from its ordered text blocks:
 * the first block that is not pure <system-reminder>. Clients that lead with a
 * verbatim date/cwd reminder would otherwise merge every conversation opened
 * that day in that directory. Blocks after the chosen one change per turn on
 * some clients, so they never join the identity. All-reminder messages fall
 * back to the first block.
 */
export function firstUserIdentityText(texts = []) {
  const blocks = texts.filter((t) => typeof t === 'string' && t.trim())
  return blocks.find((t) => !isSystemReminderOnly(t)) ?? blocks[0] ?? ''
}

/** `firstUserIdentityText` of the first `role: user` message (Anthropic / Chat shape). */
export function extractFirstUserIdentity(messages) {
  if (!Array.isArray(messages)) return ''
  const user = messages.find((m) => m?.role === 'user')
  const content = user?.content
  if (typeof content === 'string') return firstUserIdentityText([content])
  if (!Array.isArray(content)) return ''
  return firstUserIdentityText(
    content.map((block) =>
      typeof block === 'string' ? block : block?.type === 'text' && typeof block.text === 'string' ? block.text : '',
    ),
  )
}

/**
 * Account + client + first user identity text. Appending later messages does
 * not change the seed. This is not the pool sticky key.
 */
export function buildStableSessionSeed(accountId, clientDiscriminator, firstUserIdentity) {
  return `${String(accountId ?? '').trim()}::${String(clientDiscriminator ?? '')}::${String(firstUserIdentity ?? '')}`
}

function stableSessionMaterial(accountId, clientDiscriminator, firstUserIdentity) {
  if (String(accountId || '').trim()) return true
  if (String(firstUserIdentity || '').trim()) return true
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
    const machineId =
      cleanIdentityValue(raw.machine_id) ||
      cleanIdentityValue(raw.machineId) ||
      cleanIdentityValue(raw.meachine_id) ||
      cleanIdentityValue(raw.meachineId)
    return {
      device_id: raw.device_id || raw.deviceId || '',
      ...(machineId ? { machine_id: machineId } : {}),
      account_uuid: raw.account_uuid || raw.accountUuid || '',
      session_id: raw.session_id || raw.sessionId || '',
      parent_session_id: raw.parent_session_id || raw.parentSessionId || '',
      root_session_id: raw.root_session_id || raw.rootSessionId || '',
    }
  }
  const s = String(raw)
  try {
    const p = JSON.parse(s)
    if (p && typeof p === 'object') return parseUserId(p)
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

function firstMachineField(obj) {
  if (!obj || typeof obj !== 'object') return ''
  return (
    cleanIdentityValue(obj.machine_id) ||
    cleanIdentityValue(obj.machineId) ||
    cleanIdentityValue(obj.meachine_id) ||
    cleanIdentityValue(obj.meachineId)
  )
}

function firstDeviceField(obj) {
  if (!obj || typeof obj !== 'object') return ''
  return cleanIdentityValue(obj.device_id) || cleanIdentityValue(obj.deviceId)
}

/**
 * Extract inbound machine_id in strict priority order (never forged from IP/UA/API key):
 * 1. HTTP Headers: x-machine-id > x-kin-machine-id > x-kin-device-id
 * 2. metadata.user_id (via parseUserId): machine_id/machineId/meachine_id > device_id/deviceId
 *    (followed by direct metadata.{machine_id,...} > metadata.{device_id,...})
 * 3. Top-level body: machine_id/machineId/meachine_id > device_id/deviceId
 * @returns {{ machineId: string, machineSource: string }}
 */
export function extractMachineIdentity({ inbound = {}, body = {}, headers = {} } = {}) {
  for (const key of MACHINE_ID_HEADER_KEYS) {
    const value = cleanIdentityValue(headerValue(headers, key))
    if (value) return { machineId: value, machineSource: `header:${key}` }
  }

  const parsedUserIds = [inbound?.metadata?.user_id, body?.metadata?.user_id]
    .map((raw) => parseUserId(raw))
    .filter(Boolean)
  for (const parsed of parsedUserIds) {
    const mid = cleanIdentityValue(parsed.machine_id)
    if (mid) return { machineId: mid, machineSource: 'metadata:machine_id' }
  }
  for (const parsed of parsedUserIds) {
    const did = cleanIdentityValue(parsed.device_id)
    if (did) return { machineId: did, machineSource: 'metadata:device_id' }
  }

  const metadataSources = [inbound?.metadata, body?.metadata]
  for (const meta of metadataSources) {
    const mid = firstMachineField(meta)
    if (mid) return { machineId: mid, machineSource: 'metadata:machine_id' }
  }
  for (const meta of metadataSources) {
    const did = firstDeviceField(meta)
    if (did) return { machineId: did, machineSource: 'metadata:device_id' }
  }

  const bodySources = [inbound, body]
  for (const src of bodySources) {
    const mid = firstMachineField(src)
    if (mid) return { machineId: mid, machineSource: 'body:machine_id' }
  }
  for (const src of bodySources) {
    const did = firstDeviceField(src)
    if (did) return { machineId: did, machineSource: 'body:device_id' }
  }

  return { machineId: '', machineSource: 'none' }
}

function attachMachineIdentity(base, machineId, machineSource) {
  // Defined non-enumerably so legacy strict deepEqual checks on
  // { sessionId, deviceId, source } remain 100% compatible while callers
  // directly read or destructure .machineId and .machineSource.
  return Object.defineProperties(base, {
    machineId: { value: machineId, enumerable: false, configurable: true },
    machineSource: { value: machineSource, enumerable: false, configurable: true },
  })
}

/**
 * Trusted inbound identity for pool routing. Priority:
 * metadata.user_id.session_id/device_id > explicit inbound device_id field/header.
 * Also attaches non-enumerable machineId & machineSource (header > metadata > body).
 * Never falls back to API key, IP, UA, or content fingerprint.
 * @returns {{ sessionId: string, deviceId: string, source: 'metadata'|'explicit-device'|'none', machineId: string, machineSource: string }}
 */
export function resolveInboundIdentity({ inbound = {}, body = {}, headers = {} } = {}) {
  const { machineId, machineSource } = extractMachineIdentity({ inbound, body, headers })
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
  if (deviceId) return attachMachineIdentity({ sessionId, deviceId, source: 'metadata' }, machineId, machineSource)

  const explicitDevice =
    cleanIdentityValue(inbound?.device_id) ||
    cleanIdentityValue(body?.device_id) ||
    headerValue(headers, 'x-kin-device-id').trim()
  if (explicitDevice) {
    return attachMachineIdentity(
      { sessionId, deviceId: explicitDevice, source: 'explicit-device' },
      machineId,
      machineSource,
    )
  }
  // A metadata session_id without any device still pins its own session.
  if (sessionId) return attachMachineIdentity({ sessionId, deviceId: '', source: 'metadata' }, machineId, machineSource)
  return attachMachineIdentity({ sessionId: '', deviceId: '', source: 'none' }, machineId, machineSource)
}

function seatHash(parts) {
  const hash = crypto.createHash('sha256')
  for (const part of parts) hash.update(`${String(part ?? '')}\u0000`)
  return hash.digest('hex')
}

function blockText(block) {
  if (typeof block === 'string') return block
  if (block?.type === 'text' && typeof block.text === 'string') return block.text
  return ''
}

function contentBlocks(content) {
  if (Array.isArray(content)) return content
  return content == null ? [] : [content]
}

function systemText(system) {
  return contentBlocks(system).map(blockText).filter(Boolean).join('\n')
}

/** Text of every system / message block the client marked `cache_control: { type: 'ephemeral' }`. */
function ephemeralCacheText(body = {}) {
  const marked = (block) =>
    block && typeof block === 'object' && String(block.cache_control?.type || '') === 'ephemeral'
  const parts = []
  for (const block of contentBlocks(body?.system)) if (marked(block)) parts.push(blockText(block))
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    for (const block of contentBlocks(message?.content)) if (marked(block)) parts.push(blockText(block))
  }
  return parts.filter(Boolean).join('\n')
}

/**
 * Pool seat identity: one key per client session. A session that lands on a
 * VM keeps that slot until sticky TTL, or until the home is unschedulable /
 * an error moves it. Precedence: caller session (metadata.user_id, then
 * `x-session-id` and the other caller session headers/body keys) → device id
 * (no session) → short one-shot probe (no seat) → hash of
 * `cache_control: ephemeral` content → hash of client IP + normalized UA +
 * system + first user turn. The API key never takes part. Two sessions on
 * the same device are two seats.
 * @returns {{ key: string|null, source: 'session'|'device'|'probe'|'cache'|'fingerprint' }}
 */
export function resolveSeatIdentity({ inbound = {}, body = {}, headers = {}, clientIp = '' } = {}) {
  const sessionId = cleanIdentityValue(extractCallerSession({ inbound, body, headers }))
  if (sessionId) return { key: `seat:sess:${sessionId}`, source: 'session' }
  const identity = resolveInboundIdentity({ inbound, body, headers })
  if (identity.deviceId) return { key: `seat:dev:${identity.deviceId}`, source: 'device' }
  if (isShortProbeRequest(inbound)) return { key: null, source: 'probe' }
  const cached = ephemeralCacheText(inbound)
  if (cached) return { key: `seat:h:${seatHash(['cache', cached])}`, source: 'cache' }
  const fingerprint = seatHash([
    'fingerprint',
    String(clientIp || '').trim(),
    normalizeSessionUserAgent(headerValue(headers, 'user-agent')),
    systemText(inbound?.system),
    extractFirstUserIdentity(inbound?.messages),
  ])
  return { key: `seat:h:${fingerprint}`, source: 'fingerprint' }
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

/** Agents use the same root as their derived session; an unmarked summary carries its root in metadata. */
export function subagentRootSession(body, headers, summary = false) {
  const metadata = body?.metadata
  const agentRoot = cleanIdentityValue(claudeCodeAgentRootSession({ inbound: body, headers }))
  if (agentRoot) return agentRoot
  if (summary) return cleanIdentityValue(parseUserId(metadata?.user_id)?.session_id) || null
  return cleanIdentityValue(metadata?.root_session_id || headerValue(headers, 'x-kin-root-session')) || null
}

/**
 * Caller session, in official order: metadata.user_id → sticky headers → body keys.
 * A Claude Code sub-agent hop gets its own session under that root.
 */
export function extractCallerSession({ inbound = {}, body = {}, headers = {} } = {}) {
  return agentSessionId(rootCallerSession({ inbound, body, headers }), claudeCodeAgentId(headers))
}

function rootCallerSession({ inbound, body, headers }) {
  for (const raw of [inbound?.metadata?.user_id, body?.metadata?.user_id]) {
    const parsed = parseUserId(raw)
    const sid = cleanIdentityValue(parsed?.session_id)
    if (sid) return sid
  }
  for (const key of CALLER_SESSION_HEADER_KEYS) {
    if (EPHEMERAL_SESSION_HEADER_KEYS.has(String(key).toLowerCase())) continue
    const v = cleanIdentityValue(headerValue(headers, key))
    if (v) return v
  }
  const src = inbound && typeof inbound === 'object' && Object.keys(inbound).length ? inbound : body
  for (const key of CALLER_SESSION_BODY_KEYS) {
    const v = cleanIdentityValue(src?.[key])
    if (v) return v
  }
  return ''
}

function extractFirstUserIdentityFromInput(input) {
  if (!Array.isArray(input)) return ''
  const user = input.find((item) => typeof item === 'string' || String(item?.role || '').toLowerCase() === 'user')
  if (!user) return ''
  if (typeof user === 'string') return firstUserIdentityText([user])
  const content = user.content ?? user.text
  if (typeof content === 'string') return firstUserIdentityText([content])
  if (!Array.isArray(content)) return ''
  return firstUserIdentityText(
    content.map((part) => {
      if (typeof part === 'string') return part
      if ((part?.type === 'text' || part?.type === 'input_text') && typeof part.text === 'string') return part.text
      return ''
    }),
  )
}

function extractFirstUserIdentityFromGemini(contents) {
  if (!Array.isArray(contents)) return ''
  const user = contents.find((item) => {
    if (typeof item === 'string') return true
    if (!item || typeof item !== 'object') return false
    const role = String(item.role || '')
      .trim()
      .toLowerCase()
    return !role || role === 'user'
  })
  if (!user) return ''
  if (typeof user === 'string') return firstUserIdentityText([user])
  if (Array.isArray(user.parts)) {
    return firstUserIdentityText(
      user.parts.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')),
    )
  }
  if (typeof user.text === 'string') return firstUserIdentityText([user.text])
  return ''
}

function extractMultiTurnFirstUserAnchor(src) {
  if (!src || typeof src !== 'object') return { isMultiTurn: false, anchor: '' }
  let isMultiTurn = false
  let raw = ''
  if (Array.isArray(src.messages) && src.messages.length > 0) {
    isMultiTurn = src.messages.length >= 2
    if (isMultiTurn) raw = extractFirstUserIdentity(src.messages)
  } else if (Array.isArray(src.input) && src.input.length > 0) {
    isMultiTurn = src.input.length >= 2
    if (isMultiTurn) raw = extractFirstUserIdentityFromInput(src.input)
  } else if (Array.isArray(src.contents) && src.contents.length > 0) {
    isMultiTurn = src.contents.length >= 2
    if (isMultiTurn) raw = extractFirstUserIdentityFromGemini(src.contents)
  }
  const anchor = cleanIdentityValue(raw)
  if (!anchor || isSystemReminderOnly(anchor)) return { isMultiTurn, anchor: '' }
  return { isMultiTurn, anchor }
}

function extractExplicitParentSession({ inbound = {}, body = {}, headers = {} } = {}) {
  for (const raw of [inbound?.metadata?.user_id, body?.metadata?.user_id]) {
    const parsed = parseUserId(raw)
    const parent = cleanIdentityValue(parsed?.root_session_id || parsed?.parent_session_id)
    if (parent) return parent
  }
  for (const meta of [inbound?.metadata, body?.metadata]) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue
    const parent = cleanIdentityValue(meta.root_session_id || meta.parent_session_id)
    if (parent) return parent
  }
  return cleanIdentityValue(headerValue(headers, 'x-kin-root-session') || headerValue(headers, 'x-kin-parent-session'))
}

/**
 * Unified scheduler inbound identity (PRD v4 §4.2 / D3):
 * - Extracts machine_id with strict priority (header > metadata > body), never forged from IP/UA.
 * - Extracts official Claude Code session_id via parseUserId / extractCallerSession,
 *   excluding transient headers (x-request-id, x-client-request-id).
 * - Derives sub-agent session via agentSessionId(root, agentId) (pure RFC-4122 UUIDv4)
 *   and returns parentSessionId = root.
 * - When absent, generates a pure RFC-4122 UUIDv4 internally: deterministic seed
 *   mixing poolId/apiKeyId/machineId/firstUserAnchor for multi-turn conversations
 *   (Anthropic/OpenAI messages, Responses input, Gemini contents), or crypto.randomUUID()
 *   for single-turn / anchorless requests. Zero custom prefixes/suffixes or response headers.
 * - Flags ephemeral short probes via isShortProbeRequest.
 */
export function resolveSchedulerIdentity({ inbound = {}, body = {}, headers = {}, poolId = '', apiKeyId = '' } = {}) {
  const primaryBody = inbound && typeof inbound === 'object' && Object.keys(inbound).length ? inbound : body
  const { machineId: rawMachineId, machineSource } = extractMachineIdentity({ inbound, body, headers })
  const machineId = rawMachineId || null
  const baseInbound = resolveInboundIdentity({ inbound, body, headers })
  const deviceId = baseInbound.deviceId || null

  const agentId = claudeCodeAgentId(headers) || null
  const explicitRoot =
    rootCallerSession({ inbound, body, headers }) ||
    cleanIdentityValue(primaryBody?.previous_response_id) ||
    cleanIdentityValue(body?.previous_response_id)

  let sessionId = ''
  let parentSessionId = null
  let sessionSource = 'generated_random'
  let generated = false

  if (explicitRoot) {
    if (agentId) {
      sessionId = agentSessionId(explicitRoot, agentId)
      parentSessionId = explicitRoot
      sessionSource = 'subagent'
    } else {
      sessionId = explicitRoot
      const explicitParent = extractExplicitParentSession({ inbound, body, headers })
      parentSessionId = explicitParent && explicitParent !== sessionId ? explicitParent : null
      sessionSource = 'explicit'
    }
  } else {
    generated = true
    const { isMultiTurn, anchor } = extractMultiTurnFirstUserAnchor(primaryBody)
    let baseSession = ''
    if (isMultiTurn && anchor) {
      const seed = [
        SCHEDULER_SESSION_SEED,
        cleanIdentityValue(poolId),
        cleanIdentityValue(apiKeyId),
        machineId || '',
        anchor,
      ].join('\u0000')
      baseSession = uuidFromSeed(seed)
      sessionSource = 'derived_multi_turn'
    } else {
      baseSession = crypto.randomUUID()
      sessionSource = 'generated_random'
    }
    if (agentId) {
      sessionId = agentSessionId(baseSession, agentId)
      parentSessionId = isMultiTurn && anchor ? baseSession : null
      sessionSource = 'subagent'
    } else {
      sessionId = baseSession
    }
  }

  const isEphemeralProbe = isShortProbeRequest(primaryBody)

  return Object.freeze({
    sessionId,
    parentSessionId,
    sessionSource,
    generated,
    machineId,
    machineSource,
    deviceId,
    agentId,
    isEphemeralProbe,
  })
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
  const firstUserIdentity = String(opts.firstUserIdentity || '')
  if (stableSessionMaterial(accountId, discriminator, firstUserIdentity)) {
    return uuidFromSeed(STABLE_SESSION_SEED + buildStableSessionSeed(accountId, discriminator, firstUserIdentity))
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
  const firstUserIdentity = String(opts.firstUserIdentity || '')
  const identity = caller || buildStableSessionSeed(accountId, discriminator, firstUserIdentity)
  if (caller || stableSessionMaterial(accountId, discriminator, firstUserIdentity)) {
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
  delete out.machine_id
  delete out.machineId
  delete out.meachine_id
  delete out.meachineId
  delete out.device_id
  delete out.deviceId

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
      firstUserIdentity: opts.firstUserIdentity,
    })

  const md = {}
  if (out.metadata && typeof out.metadata === 'object') {
    for (const [k, v] of Object.entries(out.metadata)) {
      if (/user|me?achine|device|host|tz|timezone|locale|setting|session_source|email/i.test(k)) continue
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
