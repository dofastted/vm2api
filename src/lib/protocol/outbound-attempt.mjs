/**
 * Single outbound assembly used by /v1 applyAttempt and probe-class helpers.
 * Tests compare envelopes from this module so admin paths cannot drift.
 */
import { officialMessagesBody } from './anthropic-messages.mjs'
import {
  prepareAnthropicRequest,
  rewriteToolNames,
  sanitizeAnthropicBodyForBetaTokens,
  ensureClearThinkingContextManagement,
  stripInvalidThinkingBlocks,
  alignSamplingWithThinking,
  enforceCacheLimit,
} from './anthropic-policy.mjs'
import { ensureUnofficialAdaptiveThinking, ensureUnofficialEffortHigh, normalizeThinkingForModel } from './thinking.mjs'
import {
  applyCrsIdentityReplace,
  extractCallerSession,
  resolveOutboundSessionId,
  sessionIdFromOutboundBody,
} from '../identity/identity-rewrite.mjs'
import { resolveCrsHeaders } from '../identity/crs-headers.mjs'
import { hasClaudeCode1mSuffix } from './context-1m.mjs'
import {
  refreshOfficialSystemEnvironment,
  CRS_OFFICIAL_SYSTEM,
  CRS_OFFICIAL_CLI_SYSTEM,
  CRS_COMPACT_IDENTITY,
} from '../identity/crs-persona.mjs'
import {
  CRS_OFFICIAL_AGENT_PROMPT,
  CRS_AGENT_EXPANSION,
  CRS_OFFICIAL_AGENT_IDENTITY,
} from '../identity/official-cc-system-2.1.241.mjs'
import {
  applyCacheTtlToBody,
  applyCacheBreakpoints,
  enforceCacheTtlOrder,
  stripIllegalCacheControlFields,
} from './cache-ttl.mjs'
import { apiKeyBetaHeader, setupTokenBetaHeader } from './claude-code-betas.mjs'
import { isApiKeyMode, isSetupTokenMode } from '../oauth/credential-mode.mjs'

export const INFERENCE_UA = 'kin-inference/1.0'

const CLI_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

function systemBlockText(block) {
  if (typeof block === 'string') return block
  return String(block?.text || '')
}

export function isCliOwnedSystemText(text) {
  const t = String(text || '').trim()
  if (!t) return true
  if (/^x-anthropic-billing-header/i.test(t)) return true
  if (t.startsWith('# Environment')) return true
  if (t === CLI_IDENTITY || t === CRS_OFFICIAL_SYSTEM || t === CRS_OFFICIAL_AGENT_IDENTITY) return true
  if (t === CRS_COMPACT_IDENTITY || t === CRS_OFFICIAL_CLI_SYSTEM) return true
  if (t.startsWith('You are Claude Code')) return true
  // Agent / expansion stay as leftover so wrap CLI identity/zero can still carry 官方完整提示词.
  return false
}

export function stripCliOwnedSystem(system) {
  if (system == null) return undefined
  if (typeof system === 'string') return isCliOwnedSystemText(system) ? undefined : system
  if (!Array.isArray(system)) return system
  const kept = system.filter((block) => !isCliOwnedSystemText(systemBlockText(block)))
  return kept.length ? kept : undefined
}

/** Wrap CLI already stamps tools + system. Extra tails here overflow the 4-breakpoint cap → 400, often surfaced as Connection error. */
export const CLI_HOP_CACHE_BREAKPOINTS = Object.freeze({
  enabled: true,
  preserve_client: true,
  system_tail: false,
  tools_tail: false,
  messages: 'rewrite',
})

function dropNodeCacheControl(node) {
  if (!node || typeof node !== 'object' || !node.cache_control) return node
  const { cache_control: _drop, ...rest } = node
  return rest
}

function dropCliOwnedBreakpoints(body) {
  const out = { ...body }
  if (Array.isArray(out.tools)) out.tools = out.tools.map(dropNodeCacheControl)
  if (Array.isArray(out.system)) out.system = out.system.map(dropNodeCacheControl)
  return out
}

/** CLI stamps the current last user. Keeping ours on the tail overflows the 4-cap. */
function dropLastMessageBreakpoint(body) {
  const messages = body?.messages
  if (!Array.isArray(messages) || messages.length === 0) return body
  const idx = messages.length - 1
  const last = messages[idx]
  if (!last || !Array.isArray(last.content)) return body
  const content = last.content.map(dropNodeCacheControl)
  const next = messages.slice()
  next[idx] = { ...last, content }
  return { ...body, messages: next }
}

/** Caller fields only. CLI owns UA / billing / metadata / layoutSystemBlocks. */
export function prepareCliHopBody(
  canonicalBody,
  {
    stream = true,
    repaired = false,
    cacheTtl = null,
    cacheBreakpoints = CLI_HOP_CACHE_BREAKPOINTS,
    cacheControlLimit = 4,
  } = {},
) {
  let body = officialMessagesBody(canonicalBody, { stream })
  delete body.metadata
  const leftover = stripCliOwnedSystem(body.system)
  if (leftover == null) delete body.system
  else body.system = leftover
  // Repair already converted thinking→text and deleted body.thinking.
  // Do not refill adaptive or clear_thinking, or the retry 400s again.
  if (!repaired) {
    body = ensureUnofficialAdaptiveThinking(body)
    normalizeThinkingForModel(body)
    body = pinHaikuCliThinking(body)
    body = ensureUnofficialEffortHigh(body)
    body = ensureClearThinkingContextManagement(body)
  }
  body = stripInvalidThinkingBlocks(body)
  body = alignSamplingWithThinking(body)
  body = stripIllegalCacheControlFields(body)
  if (cacheTtl) body = applyCacheTtlToBody(body, cacheTtl)
  if (cacheBreakpoints) {
    body = applyCacheBreakpoints(body, {
      ttl: cacheTtl || undefined,
      config: { ...cacheBreakpoints, system_tail: false, tools_tail: false },
      inbound: body,
    })
  }
  body = dropCliOwnedBreakpoints(body)
  body = dropLastMessageBreakpoint(body)
  body = enforceCacheTtlOrder(body)
  enforceCacheLimit(body, cacheControlLimit)
  return body
}

/** Wrap CLI process is spawned as sonnet-5/adaptive. Haiku rejects thinking. */
export function pinHaikuCliThinking(body = {}) {
  if (!body || typeof body !== 'object') return body
  if (!/haiku/i.test(String(body.model || ''))) return body
  return { ...body, thinking: { type: 'disabled' } }
}

export function prepareOutboundAttempt({
  canonicalBody,
  inbound = {},
  identity,
  unofficial,
  stream = true,
  cacheControlLimit = 4,
  toolNameRewrite = true,
  cacheTtl = null,
  cacheBreakpoints = null,
  reqHeaders = {},
  officialClient,
  sessionId: sessionIdOverride,
  authScheme,
  credentialMode,
} = {}) {
  const inferenceOnly = isSetupTokenMode(credentialMode) || isApiKeyMode(credentialMode)
  const keepCallerSession = officialClient === true || (officialClient == null && !unofficial)
  const sessionId =
    String(sessionIdOverride || '').trim() ||
    resolveOutboundSessionId(extractCallerSession({ inbound, body: canonicalBody, headers: reqHeaders }), {
      officialClient: keepCallerSession,
    })
  let identified = applyCrsIdentityReplace(
    officialMessagesBody(canonicalBody, { stream }),
    identity,
    inbound,
    reqHeaders,
    { officialClient: keepCallerSession, sessionId },
  )
  const callerSessionId = sessionIdFromOutboundBody(identified)
  if (identity && callerSessionId) identity.callerSessionId = callerSessionId
  if (identity) {
    identified = refreshOfficialSystemEnvironment(identified, identity, identified.model)
  }
  // Official Claude Code places its own breakpoints; adding ours would shift the
  // prefix it already caches.
  let cleaned = prepareAnthropicRequest(identified, {
    cacheControlLimit,
    unofficial: !!unofficial && !inferenceOnly,
    cacheBreakpoints: keepCallerSession ? null : cacheBreakpoints,
    cacheTtl: cacheTtl || undefined,
    inbound,
  })
  cleaned = stripIllegalCacheControlFields(cleaned)
  if (cacheTtl) cleaned = applyCacheTtlToBody(cleaned, cacheTtl)
  cleaned = enforceCacheTtlOrder(cleaned)
  const tools = rewriteToolNames(cleaned, { enabled: toolNameRewrite !== false })
  return { body: tools.body, toolNames: tools.reverse }
}

export function prepareOutboundHeaders(reqHeaders, homeDir, identity, model, { credentialMode, want1m } = {}) {
  if (isSetupTokenMode(credentialMode) || isApiKeyMode(credentialMode)) {
    return {
      'user-agent': INFERENCE_UA,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': isApiKeyMode(credentialMode) ? apiKeyBetaHeader('') : setupTokenBetaHeader(model),
    }
  }
  return resolveCrsHeaders(reqHeaders, homeDir, identity, model, { want1m: want1m === true })
}

/** Body + headers after the context_management ↔ context-management beta gate. */
export function prepareOutboundEnvelope({
  canonicalBody,
  inbound = {},
  identity,
  unofficial,
  stream = true,
  cacheControlLimit = 4,
  toolNameRewrite = true,
  cacheTtl = null,
  cacheBreakpoints = null,
  reqHeaders = {},
  homeDir = '',
  officialClient,
  sessionId,
  authScheme,
  credentialMode,
  want1m,
} = {}) {
  const prepared = prepareOutboundAttempt({
    canonicalBody,
    inbound,
    identity,
    unofficial,
    stream,
    cacheControlLimit,
    toolNameRewrite,
    cacheTtl,
    cacheBreakpoints,
    reqHeaders,
    officialClient,
    sessionId,
    authScheme,
    credentialMode,
  })
  const headers = {
    ...prepareOutboundHeaders(
      reqHeaders,
      homeDir,
      identity,
      prepared.body?.model || inbound?.model || canonicalBody?.model,
      {
        credentialMode,
        want1m: want1m === true || hasClaudeCode1mSuffix(inbound?.model) || hasClaudeCode1mSuffix(canonicalBody?.model),
      },
    ),
  }
  if (String(authScheme || '').toLowerCase() === 'apikey' || isApiKeyMode(credentialMode)) {
    headers['anthropic-beta'] = apiKeyBetaHeader(headers['anthropic-beta'] || '')
    delete headers.authorization
    delete headers.Authorization
  }
  if (stream) headers.accept = 'text/event-stream'
  const body = sanitizeAnthropicBodyForBetaTokens(prepared.body, headers?.['anthropic-beta'] || '')
  return { body, headers, toolNames: prepared.toolNames }
}
