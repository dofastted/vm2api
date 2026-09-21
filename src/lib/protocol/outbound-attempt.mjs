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
  stampBillingPromptId,
  CRS_OFFICIAL_SYSTEM,
  CRS_OFFICIAL_CLI_SYSTEM,
  CRS_COMPACT_IDENTITY,
} from '../identity/crs-persona.mjs'
import { sealClaudeCodeCch } from '../identity/cch.mjs'
import {
  CRS_OFFICIAL_AGENT_PROMPT,
  CRS_AGENT_EXPANSION,
  CRS_OFFICIAL_AGENT_IDENTITY,
} from '../identity/official-cc-system-2.1.241.mjs'
import {
  applyCacheTtlToBody,
  applyCacheBreakpoints,
  enforceCacheTtlOrder,
  forceEphemeralCacheTtl,
  normalizeCacheBreakpoints,
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

/** Wrap CLI owns tools + system + current tail; Node owns the stable previous-user boundary. */
export const CLI_HOP_CACHE_BREAKPOINTS = Object.freeze({
  enabled: true,
  preserve_client: true,
  system_tail: false,
  tools_tail: false,
  messages: 'rewrite',
})

/** Wrap CLI tools/system omit ttl, which Anthropic treats as 5m and processes first.
 * A later message 1h is the messages.N 400, so the hop wire value is 5m. */
export const CLI_HOP_CACHE_TTL = '5m'

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

/** Kernel restamps the current tail, so keep only Node's stable previous-user marker. */
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

/** A CLI hop must end on a conversational user/assistant turn. Preserve older
 * role=system leftovers in place, but lift only a trailing run to system[]. */
function liftTrailingSystemMessages(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  let firstTrailing = messages.length
  while (firstTrailing > 0 && messages[firstTrailing - 1]?.role === 'system') firstTrailing--
  if (firstTrailing === messages.length) return body
  const lifted = messages.slice(firstTrailing).flatMap((message) => {
    const content = message?.content
    if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
    if (!Array.isArray(content)) return []
    return content
      .map((block) => (typeof block === 'string' ? { type: 'text', text: block } : block))
      .filter((block) => block?.type === 'text' && String(block.text || '').trim())
  })
  if (!lifted.length) return { ...body, messages: messages.slice(0, firstTrailing) }
  const system = Array.isArray(body.system)
    ? body.system
    : body.system == null
      ? []
      : [{ type: 'text', text: String(body.system) }]
  return { ...body, system: [...system, ...lifted], messages: messages.slice(0, firstTrailing) }
}

/** Caller fields only. CLI owns UA / billing / metadata / layoutSystemBlocks. */
export function prepareCliHopBody(
  canonicalBody,
  {
    stream = true,
    repaired = false,
    cacheBreakpoints = CLI_HOP_CACHE_BREAKPOINTS,
    cacheControlLimit = 4,
    cacheTtl = CLI_HOP_CACHE_TTL,
    unofficial: _unofficial = false,
  } = {},
) {
  let body = officialMessagesBody(canonicalBody, { stream })
  delete body.metadata
  const leftover = stripCliOwnedSystem(body.system)
  if (leftover == null) delete body.system
  else body.system = leftover
  body = liftTrailingSystemMessages(body)

  if (!repaired) {
    body = ensureUnofficialAdaptiveThinking(body)
    normalizeThinkingForModel(body)
    body = pinHaikuCliThinking(body)
    body = ensureUnofficialEffortHigh(body)
    body = ensureClearThinkingContextManagement(body)
  }
  body = stripInvalidThinkingBlocks(body)
  body = alignSamplingWithThinking(body)
  const ttl = CLI_HOP_CACHE_TTL
  if (cacheTtl == null) return forceEphemeralCacheTtl(body, ttl)
  body = stripIllegalCacheControlFields(body)
  // Node owns the stable previous-user boundary; the kernel receives the same
  // resolved TTL and owns the current tail plus wrap-owned markers.
  if (cacheBreakpoints) {
    const cfg = normalizeCacheBreakpoints(cacheBreakpoints)
    body = applyCacheBreakpoints(body, {
      ttl,
      config: {
        enabled: cfg.enabled,
        preserve_client: cfg.preserve_client,
        system_tail: false,
        tools_tail: false,
        messages: cfg.enabled ? 'rewrite' : 'off',
      },
      inbound: body,
    })
  }
  body = dropCliOwnedBreakpoints(body)
  body = dropLastMessageBreakpoint(body)
  body = forceEphemeralCacheTtl(enforceCacheTtlOrder(body), ttl)
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
  accountId = '',
  boundSessionId = '',
  boundAccountId = '',
  clientDiscriminator = undefined,
  clientIp = '',
  userAgent = '',
  apiKeyId = '',
  firstUserText = '',
  authScheme,
  credentialMode,
} = {}) {
  const inferenceOnly = isSetupTokenMode(credentialMode) || isApiKeyMode(credentialMode)
  const keepCallerSession = officialClient === true || (officialClient == null && !unofficial)
  const sessionContext = {
    officialClient: keepCallerSession,
    accountId,
    boundSessionId,
    boundAccountId,
    clientDiscriminator,
    clientIp,
    userAgent: userAgent || reqHeaders?.['user-agent'] || '',
    apiKeyId,
    firstUserText,
  }
  const sessionId =
    String(sessionIdOverride || '').trim() ||
    resolveOutboundSessionId(
      extractCallerSession({ inbound, body: canonicalBody, headers: reqHeaders }),
      sessionContext,
    )
  let identified = applyCrsIdentityReplace(
    officialMessagesBody(canonicalBody, { stream }),
    identity,
    inbound,
    reqHeaders,
    { officialClient: keepCallerSession, sessionId, ...sessionContext },
  )
  const callerSessionId = sessionIdFromOutboundBody(identified)
  if (identity && callerSessionId) identity.callerSessionId = callerSessionId
  if (identity) {
    identified = refreshOfficialSystemEnvironment(identified, identity, identified.model)
  }
  if (!keepCallerSession && String(sessionIdOverride || '').trim()) {
    identified = stampBillingPromptId(identified, sessionId, firstUserText)
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
  accountId = '',
  boundSessionId = '',
  boundAccountId = '',
  clientDiscriminator,
  clientIp = '',
  userAgent = '',
  apiKeyId = '',
  firstUserText = '',
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
    accountId,
    boundSessionId,
    boundAccountId,
    clientDiscriminator,
    clientIp,
    userAgent,
    apiKeyId,
    firstUserText,
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
  const body = sealClaudeCodeCch(sanitizeAnthropicBodyForBetaTokens(prepared.body, headers?.['anthropic-beta'] || ''))
  return { body, headers, toolNames: prepared.toolNames }
}
