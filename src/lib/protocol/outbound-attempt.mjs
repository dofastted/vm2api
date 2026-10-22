/**
 * Single outbound assembly used by /v1 applyAttempt and probe-class helpers.
 * Tests compare envelopes from this module so admin paths cannot drift.
 */
import { officialMessagesBody } from './anthropic-messages.mjs'
import {
  prepareAnthropicRequest,
  rewriteToolNames,
  sanitizeAnthropicBodyForBetaTokens,
  ensureFastModeBeta,
  ensureClearThinkingContextManagement,
  stripInvalidThinkingBlocks,
  alignSamplingWithThinking,
  modelSupportsMidConversationSystem,
} from './anthropic-policy.mjs'
import { liftMidConversationSystemMessages, promoteContentToBlocks } from './sanitize.mjs'
import {
  applyThinkingDisplay,
  ensureUnofficialAdaptiveThinking,
  ensureUnofficialEffortHigh,
  normalizeThinkingForModel,
  thinkingDisplayMode,
} from './thinking.mjs'
import { ensureOutputConfigSchema } from './request-rectifier.mjs'
import {
  applyCrsIdentityReplace,
  extractCallerSession,
  resolveOutboundSessionId,
  sessionIdFromOutboundBody,
} from '../identity/identity-rewrite.mjs'
import { resolveCrsHeaders } from '../identity/crs-headers.mjs'
import { hasClaudeCode1mSuffix } from './context-1m.mjs'
import { withRequestProtocolBetas } from './claude-code-betas.mjs'
import {
  refreshOfficialSystemEnvironment,
  hasEnvironmentSection,
  stampBillingPromptId,
  collapseSystemBudgetReminders,
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
  applyMessageBreakpoints,
  DEFAULT_CACHE_TTL,
  enforceCacheTtlOrder,
  normalizeCacheTtl,
  removeCacheControlFields,
  stripIllegalCacheControlFields,
  validateCacheBreakpoints,
} from './cache-ttl.mjs'
import { apiKeyBetaHeader, setupTokenBetaHeader } from './claude-code-betas.mjs'
import { applyModelRequestRules } from './model-policy.mjs'
import { isApiKeyMode, isAnySetupTokenMode } from '../oauth/credential-mode.mjs'
import { prepareClassifierBody } from './request-purpose.mjs'

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

export function stripCliOwnedSystem(system, { preserveCallerEnvironment = false } = {}) {
  if (system == null) return undefined
  const keep = (text) => (preserveCallerEnvironment && hasEnvironmentSection(text)) || !isCliOwnedSystemText(text)
  if (typeof system === 'string') return keep(system) ? system : undefined
  if (!Array.isArray(system)) return system
  const kept = system.filter((block) => keep(systemBlockText(block)))
  return kept.length ? kept : undefined
}

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
const OFFICIAL_CACHE = Object.freeze({ type: 'ephemeral' })

function textOf(block) {
  if (typeof block === 'string') return block
  return typeof block?.text === 'string' ? block.text : ''
}

/**
 * Every cli-hop request leaves as the captured Claude Code shape: the identity
 * sentence, then the caller's own prompt. Both markers omit ttl. A request that
 * already has that identity keeps its second block; anything else is joined
 * behind a fresh identity.
 */
export function officialSystemTemplate(system, ttl = DEFAULT_CACHE_TTL) {
  const blocks = Array.isArray(system) ? system : system == null || system === '' ? [] : [system]
  const texts = blocks.map(textOf).filter((text) => text.trim())
  const identityAt = texts.findIndex((text) => text.trim() === CRS_OFFICIAL_CLI_SYSTEM)
  const body = identityAt >= 0 ? texts.slice(identityAt + 1).join('\n\n') : texts.join('\n\n')
  const marker = { type: 'ephemeral', ttl: normalizeCacheTtl(ttl) }
  const out = [{ type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM, cache_control: { ...marker } }]
  if (body.trim()) out.push({ type: 'text', text: body, cache_control: { ...marker } })
  return out
}

/** One marker, on the last text of the current tail, stamped with the session TTL. */
function officialMessageMarker(messages, ttl = DEFAULT_CACHE_TTL) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  const next = messages.map((message) => {
    if (!message || typeof message !== 'object') return message
    if (typeof message.content === 'string') {
      if (!message.cache_control) return message
      const copy = { ...message }
      delete copy.cache_control
      return copy
    }
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((block) => {
      if (!block?.cache_control) return block
      changed = true
      const copy = { ...block }
      delete copy.cache_control
      return copy
    })
    return changed ? { ...message, content } : message
  })
  let tail = -1
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]?.role !== 'user') continue
    const content = next[i].content
    if (typeof content === 'string' ? content : Array.isArray(content) && content.length) {
      tail = i
      break
    }
  }
  if (tail < 0) return next
  const message = next[tail]
  if (typeof message.content === 'string') {
    next[tail] = {
      ...message,
      content: [
        { type: 'text', text: message.content, cache_control: { type: 'ephemeral', ttl: normalizeCacheTtl(ttl) } },
      ],
    }
    return next
  }
  const content = message.content.slice()
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i]?.type === 'thinking' || content[i]?.type === 'redacted_thinking') continue
    content[i] = { ...content[i], cache_control: { type: 'ephemeral', ttl: normalizeCacheTtl(ttl) } }
    next[tail] = { ...message, content }
    return next
  }
  return next
}
/** Official Claude Code omits eager streaming and tool cache markers. A caller TTL here makes CLI fill the omitted system and message markers. */
function stripEagerInputStreaming(tools) {
  if (!Array.isArray(tools)) return tools
  let changed = false
  const next = tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool
    const hasOwn = Object.prototype.hasOwnProperty.call(tool, 'eager_input_streaming')
    const hasCache = Object.prototype.hasOwnProperty.call(tool, 'cache_control')
    const fn = tool.function
    const fnHas = fn && typeof fn === 'object' && Object.prototype.hasOwnProperty.call(fn, 'eager_input_streaming')
    if (!hasOwn && !hasCache && !fnHas) return tool
    changed = true
    const copy = { ...tool }
    delete copy.eager_input_streaming
    delete copy.cache_control
    if (fnHas) {
      copy.function = { ...fn }
      delete copy.function.eager_input_streaming
    }
    return copy
  })
  return changed ? next : tools
}

/**
 * Caller fields plus Node-owned message breakpoints.
 * CLI owns persona layout and system/tools markers; kernel only forwards.
 *
 * role=system turns stay where the caller put them, including a trailing one:
 * Claude Code ends most turns with a reminder (SessionStart context, then
 * `<total_tokens>`). Moving it into system[] puts a different text in the
 * cached system block whenever the reminder changes, so the whole prefix
 * misses. In place, it is history on the next turn and the prefix only grows.
 * This must not depend on client classification: relays strip the billing
 * block and rewrite the UA, so relayed Claude Code looks third-party.
 */
export function prepareCliHopBody(
  canonicalBody,
  {
    stream = true,
    repaired = false,
    cacheTtl = DEFAULT_CACHE_TTL,
    requestContext = null,
    preserveSystem = false,
    preserveThinkingBlocks = false,
    preserveCallerEnvironment = false,
    autoCompactWindow = null,
    routing = null,
  } = {},
) {
  if (requestContext?.purpose === 'auto_mode_classifier') return prepareClassifierBody(canonicalBody, { stream })
  if (preserveSystem) validateCacheBreakpoints(canonicalBody)
  let body = officialMessagesBody(canonicalBody, { stream, preserveContentShape: true })
  const windowTokens = Number(autoCompactWindow)
  if (Number.isInteger(windowTokens) && windowTokens >= 100_000 && windowTokens <= 1_000_000) {
    body.auto_compact_window = windowTokens
  }
  delete body.metadata
  // Official family keeps the inbound system and its markers. Rewriting them
  // into the persona template (billing / reporting / 1h) is what diverges from
  // the captured Claude Code body: two ephemeral blocks, TTL omitted.
  if (!preserveSystem) {
    const leftover = stripCliOwnedSystem(body.system, { preserveCallerEnvironment })
    if (leftover == null) delete body.system
    else body.system = leftover
    body = stabilizeSystemBudget(body)
    body = stabilizeMessageBudgets(body)
  }
  // cli-node sends mid-conversation-system. Only models that reject the role need the lift.
  if (!modelSupportsMidConversationSystem(body.model)) body = liftMidConversationSystemMessages(body)
  if (!preserveSystem) body = collapseSystemBudgetReminders(body)

  if (!repaired) {
    normalizeThinkingForModel(body)
    body = pinHaikuCliThinking(body)
    body = ensureUnofficialEffortHigh(body)
  }
  body = applyThinkingDisplay(body, thinkingDisplayMode(routing))
  body = stripInvalidThinkingBlocks(body, { preserveThinkingBlocks })
  body = applyModelRequestRules(body)
  body = ensureOutputConfigSchema(body)
  if (Object.prototype.hasOwnProperty.call(body, 'temperature')) delete body.temperature
  if (Object.prototype.hasOwnProperty.call(body, 'top_p')) delete body.top_p
  if (Object.prototype.hasOwnProperty.call(body, 'top_k')) delete body.top_k
  if (Object.prototype.hasOwnProperty.call(body, 'context_management')) delete body.context_management
  if (Object.prototype.hasOwnProperty.call(body, 'cache_control')) delete body.cache_control
  if (!requestContext) {
    body = { ...body, system: officialSystemTemplate(body.system, cacheTtl) }
    body.messages = officialMessageMarker(body.messages, cacheTtl)
    if (Array.isArray(body.tools)) body = { ...body, tools: stripEagerInputStreaming(body.tools) }
  }
  return body
}
/** Only legacy Haiku rejects thinking; Haiku 5.5 supports adaptive thinking. */
export function pinHaikuCliThinking(body = {}) {
  if (!body || typeof body !== 'object') return body
  const model = String(body.model || '')
  if (!/haiku/i.test(model) || /haiku-5/i.test(model)) return body
  return { ...body, thinking: { type: 'disabled' } }
}

export function prepareOutboundAttempt({
  requestContext = null,
  canonicalBody,
  inbound = {},
  identity,
  unofficial,
  stream = true,
  cacheControlLimit = 4,
  toolNameRewrite = true,
  cacheTtl = null,
  cacheBreakpoints = null,
  preserveThinkingBlocks = false,
  preserveCallerEnvironment = false,
  reqHeaders = {},
  officialClient,
  sessionId: sessionIdOverride,
  accountId = '',
  boundSessionId = '',
  boundAccountId = '',
  boundVmId = '',
  vmId = '',
  epoch,
  mode,
  routing,
  clientDiscriminator = undefined,
  clientIp = '',
  userAgent = '',
  apiKeyId = '',
  firstUserText = '',
  firstUserIdentity = '',
  authScheme,
  credentialMode,
} = {}) {
  const inferenceOnly = isAnySetupTokenMode(credentialMode) || isApiKeyMode(credentialMode)
  const keepCallerSession = officialClient === true || (officialClient == null && !unofficial)
  const sessionContext = {
    officialClient: keepCallerSession,
    accountId,
    boundSessionId,
    boundAccountId,
    boundVmId,
    vmId,
    epoch,
    mode,
    routing,
    clientDiscriminator,
    clientIp,
    userAgent: userAgent || reqHeaders?.['user-agent'] || '',
    apiKeyId,
    firstUserIdentity,
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
  if (identity && !requestContext && !preserveCallerEnvironment) {
    identified = refreshOfficialSystemEnvironment(identified, identity, identified.model)
  }
  const stampOwnedBilling = String(sessionIdOverride || '').trim() && (mode !== 'passthrough' || !keepCallerSession)
  if (stampOwnedBilling) {
    identified = stampBillingPromptId(identified, sessionId, firstUserText)
  }
  if (requestContext?.purpose === 'auto_mode_classifier')
    return { body: prepareClassifierBody(identified, { stream }), toolNames: {} }
  // Official Claude Code places its own breakpoints; adding ours would shift the
  // prefix it already caches.
  let cleaned = prepareAnthropicRequest(identified, {
    cacheControlLimit,
    unofficial: !!unofficial && !inferenceOnly,
    cacheBreakpoints: keepCallerSession ? null : cacheBreakpoints,
    cacheTtl: cacheTtl || undefined,
    inbound,
    preserveThinkingBlocks,
  })
  cleaned = stripIllegalCacheControlFields(cleaned)
  if (cacheTtl) cleaned = applyCacheTtlToBody(cleaned, cacheTtl)
  cleaned = enforceCacheTtlOrder(cleaned)
  const tools = rewriteToolNames(cleaned, { enabled: toolNameRewrite !== false })
  return { body: tools.body, toolNames: tools.reverse }
}

export function prepareOutboundHeaders(reqHeaders, homeDir, identity, model, { credentialMode, want1m } = {}) {
  if (isAnySetupTokenMode(credentialMode) || isApiKeyMode(credentialMode)) {
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
  requestContext = null,
  canonicalBody,
  inbound = {},
  identity,
  unofficial,
  stream = true,
  cacheControlLimit = 4,
  toolNameRewrite = true,
  cacheTtl = null,
  cacheBreakpoints = null,
  preserveThinkingBlocks = false,
  preserveCallerEnvironment = false,
  reqHeaders = {},
  homeDir = '',
  officialClient,
  sessionId,
  accountId = '',
  boundSessionId = '',
  boundAccountId = '',
  boundVmId = '',
  vmId = '',
  epoch,
  mode,
  routing,
  clientDiscriminator,
  clientIp = '',
  userAgent = '',
  apiKeyId = '',
  firstUserText = '',
  firstUserIdentity = '',
  authScheme,
  credentialMode,
  want1m,
} = {}) {
  const prepared = prepareOutboundAttempt({
    requestContext,
    canonicalBody,
    inbound,
    identity,
    unofficial,
    stream,
    cacheControlLimit,
    toolNameRewrite,
    cacheTtl,
    cacheBreakpoints,
    preserveThinkingBlocks,
    preserveCallerEnvironment,
    reqHeaders,
    officialClient,
    sessionId,
    accountId,
    boundSessionId,
    boundAccountId,
    boundVmId,
    vmId,
    epoch,
    mode,
    routing,
    clientDiscriminator,
    clientIp,
    userAgent,
    apiKeyId,
    firstUserText,
    firstUserIdentity,
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
  if (!isAnySetupTokenMode(credentialMode)) {
    const beta = ensureFastModeBeta(headers['anthropic-beta'] || '', prepared.body)
    if (beta) headers['anthropic-beta'] = beta
  }
  const displayed =
    requestContext?.purpose === 'auto_mode_classifier'
      ? prepared.body
      : applyThinkingDisplay(prepared.body, thinkingDisplayMode(routing))
  headers['anthropic-beta'] = withRequestProtocolBetas(
    String(headers['anthropic-beta'] || '').split(','),
    displayed,
  ).join(',')
  const body = sealClaudeCodeCch(sanitizeAnthropicBodyForBetaTokens(displayed, headers?.['anthropic-beta'] || ''), {
    enabled: routing?.compatibility?.cch_enabled !== false,
  })
  return { body, headers, toolNames: prepared.toolNames }
}
