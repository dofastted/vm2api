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
  modelSupportsMidConversationSystem,
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
  enforceCacheTtlOrder,
  injectToolsTailBreakpoint,
  normalizeCacheTtl,
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

/** sub2api default: keep the caller's system and message anchors. Node only
 * fills the last non-deferred tool, which is the stable tools prefix. */
export const CLI_HOP_CACHE_BREAKPOINTS = Object.freeze({
  enabled: true,
  preserve_client: true,
  system_tail: false,
  tools_tail: true,
  messages: 'off',
})

/** Official Claude Code 2.1.278 context block. A live counter here changes the cached prefix. */
const OFFICIAL_CONTEXT_BUDGET = '<total_tokens>15000000 tokens left</total_tokens>'
const VOLATILE_CONTEXT_BUDGET = /<total_tokens>\d+ tokens left<\/total_tokens>/g

function stabilizeOfficialContextBudget(text) {
  const raw = String(text ?? '')
  if (!raw.includes('<total_tokens>')) return raw
  return raw.replace(VOLATILE_CONTEXT_BUDGET, OFFICIAL_CONTEXT_BUDGET)
}

/** system[] is before every message breakpoint. A per-turn token counter there
 * makes the next turn rewrite the whole prefix instead of reading it. */
function stabilizeSystemBudget(body) {
  if (!body || body.system == null) return body
  if (typeof body.system === 'string') {
    const text = stabilizeOfficialContextBudget(body.system)
    return text === body.system ? body : { ...body, system: text }
  }
  if (!Array.isArray(body.system)) return body
  let changed = false
  const system = body.system.map((block) => {
    if (typeof block === 'string') {
      const text = stabilizeOfficialContextBudget(block)
      if (text === block) return block
      changed = true
      return text
    }
    if (!block || typeof block !== 'object' || typeof block.text !== 'string') return block
    const text = stabilizeOfficialContextBudget(block.text)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? { ...body, system } : body
}

function stabilizeBlockBudget(block) {
  if (typeof block === 'string') return stabilizeOfficialContextBudget(block)
  if (!block || typeof block !== 'object') return block
  let next = block
  if (typeof block.text === 'string') {
    const text = stabilizeOfficialContextBudget(block.text)
    if (text !== block.text) next = { ...next, text }
  }
  if (typeof block.content === 'string') {
    const content = stabilizeOfficialContextBudget(block.content)
    if (content !== block.content) next = { ...next, content }
  }
  return next
}

/** Historical role=system reminders sit inside the next lookup prefix. */
function stabilizeMessageBudgets(body) {
  if (!Array.isArray(body?.messages)) return body
  let changed = false
  const messages = body.messages.map((message) => {
    const content = message?.content
    if (typeof content === 'string') {
      const text = stabilizeOfficialContextBudget(content)
      if (text === content) return message
      changed = true
      return { ...message, content: text }
    }
    if (!Array.isArray(content)) return message
    let touched = false
    const next = content.map((block) => {
      const stabilized = stabilizeBlockBudget(block)
      if (stabilized !== block) touched = true
      return stabilized
    })
    if (!touched) return message
    changed = true
    return { ...message, content: next }
  })
  return changed ? { ...body, messages } : body
}

/** A CLI hop must end on a conversational user/assistant turn. Preserve older
 * role=system leftovers in place, but lift only a trailing run to system[]. */
function liftTrailingSystemMessages(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  let firstTrailing = messages.length
  while (firstTrailing > 0 && messages[firstTrailing - 1]?.role === 'system') firstTrailing--
  if (firstTrailing === messages.length) return stabilizeSystemBudget(body)
  const lifted = messages.slice(firstTrailing).flatMap((message) => {
    const content = message?.content
    if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
    if (!Array.isArray(content)) return []
    return content
      .map((block) => (typeof block === 'string' ? { type: 'text', text: block } : block))
      .filter((block) => block?.type === 'text' && String(block.text || '').trim())
  })
  if (!lifted.length) {
    return stabilizeSystemBudget({ ...body, messages: messages.slice(0, firstTrailing) })
  }
  const system = Array.isArray(body.system)
    ? body.system
    : body.system == null
      ? []
      : [{ type: 'text', text: String(body.system) }]
  return stabilizeSystemBudget({
    ...body,
    system: [...system, ...lifted],
    messages: messages.slice(0, firstTrailing),
  })
}

/** Fold every role=system message into the message before it, as an extra text
 * block. Official Claude Code presents reminders inside user content; a hop
 * that cannot end on role=system still has to move it into the conversational
 * turn it belongs to. Folding is deterministic, so replayed history folds
 * identically and every earlier request stays a prefix of the next one. */
function systemMessageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim() ? content : ''
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      typeof block === 'string' ? block : block?.type === 'text' ? String(block.text || '') : '',
    )
    .filter((text) => text.trim())
    .join('\n\n')
}

function foldTextIntoMessage(message, text) {
  const content = message?.content
  if (typeof content === 'string') {
    return [...(content ? [{ type: 'text', text: content }] : []), { type: 'text', text }]
  }
  if (Array.isArray(content)) return [...content, { type: 'text', text }]
  return [{ type: 'text', text }]
}

function foldSystemMessages(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  let changed = false
  const out = []
  for (const message of messages) {
    if (message?.role !== 'system') {
      out.push(message)
      continue
    }
    changed = true
    const text = systemMessageText(message)
    if (!text) continue
    const prev = out[out.length - 1]
    if (prev && typeof prev === 'object' && prev.role !== 'system') {
      out[out.length - 1] = { ...prev, content: foldTextIntoMessage(prev, text) }
    } else {
      out.push({ role: 'user', content: [{ type: 'text', text }] })
    }
  }
  if (!changed) return body
  return { ...body, messages: out }
}

/** KIN_CLI_HOP_SYSTEM_MODE: official (default) | lift | fold. */
export function cliHopSystemMode() {
  const raw = String(process.env.KIN_CLI_HOP_SYSTEM_MODE || '')
    .trim()
    .toLowerCase()
  return raw === 'lift' || raw === 'fold' || raw === 'official' ? raw : 'official'
}

/** Caller fields only. CLI owns UA / billing / metadata / layoutSystemBlocks. */
export function prepareCliHopBody(
  canonicalBody,
  {
    stream = true,
    repaired = false,
    cacheBreakpoints = CLI_HOP_CACHE_BREAKPOINTS,
    cacheControlLimit = 4,
    cacheTtl = null,
    unofficial: _unofficial = false,
  } = {},
) {
  let body = officialMessagesBody(canonicalBody, { stream })
  delete body.metadata
  // Wrap CLI (Claude Code) throws a fatal "max_output_tokens" error if response reaches max_tokens.
  // Probes, ping tests, and third-party UI connection checks send max_tokens: 1 (or small numbers).
  // Ensure a safe minimum for cli-hop so output finishes with end_turn rather than hitting max_tokens.
  if (body.max_tokens != null && Number(body.max_tokens) < 64) {
    body.max_tokens = 1024
  }
  const leftover = stripCliOwnedSystem(body.system)
  if (leftover == null) delete body.system
  else body.system = leftover
  const systemMode = cliHopSystemMode()
  if (systemMode === 'fold') {
    body = foldSystemMessages(body)
  } else if (systemMode === 'official' && modelSupportsMidConversationSystem(body.model)) {
    // Official Claude Code keeps mid-conversation role=system turns and lands
    // the current one at the tail of messages. A live counter there sits behind
    // the read boundary instead of ahead of every message, so it cannot shift
    // the cached prefix. Haiku has no such beta and still needs lift+pin.
    body = stabilizeSystemBudget(body)
  } else {
    body = liftTrailingSystemMessages(body)
  }
  body = stabilizeMessageBudgets(body)

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
  // Menu cache_ttl (default 1h). Do not pin a second value here.
  const ttl = normalizeCacheTtl(cacheTtl)
  if (cacheBreakpoints?.enabled !== false) {
    body = injectToolsTailBreakpoint(body, ttl)
    body = applyCacheTtlToBody(body, ttl)
  }
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
