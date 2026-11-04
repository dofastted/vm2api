import crypto from 'node:crypto'
import {
  anthropicContentIsEmpty,
  dropEmptySystemControlTurns,
  liftMidConversationSystemMessages,
  mergeConsecutiveAnthropicMessages,
  messageHasTurnControls,
  stripIllegalContentFields,
  sanitizeAnthropicBody,
} from './sanitize.mjs'
import { isAnthropicServerTool } from './web-search.mjs'
import {
  normalizeThinkingForModel,
  ensureUnofficialAdaptiveThinking,
  ensureUnofficialEffortHigh,
  downgradeUngatedThinkingDisplay,
} from './thinking.mjs'
import {
  applyMaxTokensCap,
  applyModelRequestRules,
  getCapabilities,
  isHaiku55Model,
  isOpus55Model,
  validateBetweenToolsThinking,
} from './model-policy.mjs'
import { ensureOutputConfigSchema, rectifyUnofficialRequest } from './request-rectifier.mjs'
import { DEFAULT_CACHE_TTL, applyCacheBreakpoints, stripCacheScopeFields } from './cache-ttl.mjs'
import { normalizeImageContentBlocks } from './images.mjs'

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

function clone(value) {
  return structuredClone(value)
}

function emptyText(block) {
  return block?.type === 'text' && String(block.text || '').length === 0
}

function isZeroInjectEmptyIdentity(system, index, block) {
  if (index !== 1 || !emptyText(block)) return false
  const first = system?.[0]
  const text = typeof first === 'string' ? first : String(first?.text || '')
  return /^\s*x-anthropic-billing-header:/i.test(text)
}

function cleanContent(content, { keepEmptyIdentity = false } = {}) {
  if (!Array.isArray(content)) return content
  return stripIllegalContentFields(content)
    .map((block) => {
      if (!block || typeof block !== 'object') return block
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        return { ...block, content: cleanContent(block.content) }
      }
      return block
    })
    .filter(
      (block, index) => !emptyText(block) || (keepEmptyIdentity && isZeroInjectEmptyIdentity(content, index, block)),
    )
}

function cacheControlLocations(body) {
  const locations = []
  const add = (block, section, index) => {
    if (block?.cache_control) locations.push({ block, section, index })
  }
  for (const [index, tool] of (body.tools || []).entries()) add(tool, 'tools', index)
  for (const [index, block] of (Array.isArray(body.system) ? body.system : []).entries()) add(block, 'system', index)
  for (const [messageIndex, message] of (body.messages || []).entries()) {
    if (!Array.isArray(message?.content)) continue
    for (const [blockIndex, block] of message.content.entries()) {
      if (block?.cache_control)
        locations.push({
          block,
          section: 'messages',
          index: messageIndex,
          blockIndex,
        })
    }
  }
  return locations
}

function normalizeCacheTTL(_body) {
  // Official 2.1.241 uses ephemeral 1h. Do not coerce 1h back to 5m.
}

export function enforceCacheLimit(body, maximum = 4) {
  const locations = cacheControlLocations(body)
  // Anthropic rejects the marker on a thinking block regardless of the budget.
  for (const location of locations) {
    if (location.block?.type === 'thinking') delete location.block.cache_control
  }
  const live = locations.filter((location) => location.block?.cache_control)
  if (live.length <= maximum) return
  // Keep the message anchors: they advance the cache prefix on every turn.
  // Tools are the cheapest to sacrifice, while system breakpoints preserve the
  // stable persona prefix shared by the whole session.
  const bySection = (name) => live.filter((location) => location.section === name)
  const order = [...bySection('tools').reverse(), ...bySection('system').reverse(), ...bySection('messages')]
  for (const location of order.slice(0, live.length - maximum)) {
    delete location.block.cache_control
  }
}

const CLEAR_THINKING_EDIT = Object.freeze({
  type: 'clear_thinking_20251015',
  keep: 'all',
})

const DUMMY_THINKING_SIGNATURES = new Set(['', 'skip_thought_signature_validator'])

export function hasUsableThinkingSignature(signature) {
  const value = String(signature || '').trim()
  // Truncated SSE signatures look present but fail Anthropic checksum (sub2api pre-filter).
  if (!value || value.length < 24) return false
  return !DUMMY_THINKING_SIGNATURES.has(value)
}
function signedThinkingModel(model = '') {
  if (isOpus55Model(model) || isHaiku55Model(model)) return true
  const bare = String(model || '')
    .split('[')[0]
    .split('/')
    .filter(Boolean)
    .pop()
  return /^claude-sonnet-5(?:-5|\.5)(?=-|$)/i.test(bare || '')
}

/** 5.5 accepts any non-dummy signature. Length is not a checksum. */
function hasNonDummyThinkingSignature(signature) {
  const value = String(signature || '').trim()
  return value.length > 0 && !DUMMY_THINKING_SIGNATURES.has(value)
}

function dropSignedThinkingChain(messages) {
  return messages.map((message) => {
    if (!Array.isArray(message?.content)) return message
    let dropped = false
    const content = []
    for (const block of message.content) {
      const type = block?.type
      if (
        type === 'thinking' ||
        type === 'redacted_thinking' ||
        (type == null && block && Object.hasOwn(block, 'thinking'))
      ) {
        dropped = true
        continue
      }
      content.push(block)
    }
    if (!dropped) return message
    return { ...message, content }
  })
}

function thinkingModeEnabled(body) {
  const type = String(body?.thinking?.type || '').toLowerCase()
  return type === 'enabled' || type === 'adaptive'
}

/**
 * Anthropic: thinking enabled/adaptive only accepts temperature=1.
 * top_p / top_k are also rejected. Real Claude Code sends temperature: 1.
 */
export function alignSamplingWithThinking(body = {}) {
  if (!thinkingModeEnabled(body)) return body
  const out = body
  if (out.temperature !== 1) out.temperature = 1
  if (Object.prototype.hasOwnProperty.call(out, 'top_p')) delete out.top_p
  if (Object.prototype.hasOwnProperty.call(out, 'top_k')) delete out.top_k
  return out
}

/**
 * Drop history thinking blocks Anthropic would reject.
 * Opus / Sonnet / Haiku 5.5 follow sub2api: one invalid block drops the whole
 * signed chain, including later valid thinking and redacted_thinking. Turns
 * left with no content are dropped. redacted_thinking stays when it carries
 * data on 5.5, otherwise when its signature is usable. The preserve path
 * (cli-hop first hop, default HTTP hop) skips the chain rule and keeps a
 * signed block as-is, empty text and redacted_thinking included. A thinking
 * block without a usable signature (missing, empty, shorter than 24, dummy)
 * is dropped instead of forwarded with an empty signature.
 */
export function stripInvalidThinkingBlocks(body = {}, { preserveThinkingBlocks = false } = {}) {
  if (!Array.isArray(body.messages)) return body
  const betweenTools = body.thinking?.type === 'between_tools'
  const keepSigned = thinkingModeEnabled(body) || betweenTools
  const chainModel = !preserveThinkingBlocks && (betweenTools || signedThinkingModel(body.model))
  let changed = false
  let chainBroken = false
  const messages = body.messages.map((message) => {
    if (!Array.isArray(message?.content)) return message
    const content = []
    let filteredThis = false
    for (const block of message.content) {
      const type = block?.type
      if (type === 'thinking' || type === 'redacted_thinking') {
        if ((keepSigned || preserveThinkingBlocks) && message.role === 'assistant') {
          // Omitted thinking keeps empty text; redacted thinking keeps encrypted data.
          if (preserveThinkingBlocks) {
            if (type === 'redacted_thinking' || hasUsableThinkingSignature(block.signature)) {
              content.push(block)
            } else {
              changed = true
              filteredThis = true
            }
            continue
          }
          if (chainModel && chainBroken) {
            changed = true
            filteredThis = true
            continue
          }
          if (type === 'redacted_thinking' && chainModel && String(block.data || '').trim()) {
            content.push(block)
            continue
          }
          const signed = chainModel
            ? hasNonDummyThinkingSignature(block.signature)
            : hasUsableThinkingSignature(block.signature)
          if (signed) {
            content.push(block)
            continue
          }
          if (chainModel) chainBroken = true
        }
        changed = true
        filteredThis = true
        continue
      }
      if (type == null && block && Object.hasOwn(block, 'thinking')) {
        changed = true
        filteredThis = true
        if (chainModel) chainBroken = true
        continue
      }
      content.push(block)
    }
    return filteredThis ? { ...message, content } : message
  })
  const stripped = chainBroken ? dropSignedThinkingChain(messages) : messages
  if (!changed && !chainBroken) return dropEmptySystemControlTurns(body)
  const withoutEmpty = stripped.filter(
    (message) => !anthropicContentIsEmpty(message?.content) || messageHasTurnControls(message),
  )
  return dropEmptySystemControlTurns({ ...body, messages: mergeConsecutiveAnthropicMessages(withoutEmpty) })
}

/**
 * Rewrite history thinking / redacted_thinking blocks: `map(block, message)`
 * returns the block to keep it, a replacement block, or null to drop it;
 * every other block of the turn stays. A turn left empty goes and its
 * neighbours merge. Returns the body unchanged when nothing changed.
 * @returns {{ body: object, changed: number }}
 */
export function mapThinkingBlocks(body = {}, map = () => null) {
  if (!Array.isArray(body?.messages)) return { body, changed: 0 }
  let changed = 0
  const messages = body.messages.map((message) => {
    if (!Array.isArray(message?.content)) return message
    let touched = false
    const content = []
    for (const block of message.content) {
      const type = block?.type
      const next = type === 'thinking' || type === 'redacted_thinking' ? map(block, message) : block
      if (next === block) {
        content.push(block)
        continue
      }
      touched = true
      changed += 1
      if (next) content.push(next)
    }
    return touched ? { ...message, content } : message
  })
  if (!changed) return { body, changed }
  const withoutEmpty = messages.filter(
    (message) => !anthropicContentIsEmpty(message?.content) || messageHasTurnControls(message),
  )
  return { body: { ...body, messages: mergeConsecutiveAnthropicMessages(withoutEmpty) }, changed }
}
export const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27'
export const PROMPT_CACHING_SCOPE_BETA = 'prompt-caching-scope-2026-01-05'
export const MID_CONVERSATION_SYSTEM_BETA = 'mid-conversation-system-2026-04-07'

export function modelSupportsContextManagement(modelId = '') {
  const caps = getCapabilities(modelId)
  if (caps?.supports_context_management === false) return false
  const id = String(modelId || '')
  if (/haiku/i.test(id) && !/haiku-5/i.test(id)) return false
  return true
}

/**
 * Docs list: Fable 5 / 5.1, Mythos 5 / 5.1, Opus 5.5 / 5 / 4.8, Sonnet 5.5, Haiku 5.5.
 * Sonnet 5, Haiku 4.5 and other Claude 4.x reject mid-conversation `role=system` (400).
 */
export function modelSupportsMidConversationSystem(modelId = '') {
  const id = String(modelId || '')
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/i, '')
  return /^claude-(?:(?:fable|mythos)-5(?:[-.]1)?|opus-(?:5(?:[-.]5)?|4[-.]8)|(?:sonnet|haiku)-5[-.]5)(?:-|$)/.test(id)
}

/**
 * Official Claude Code request default (not the response `{ applied_edits: [] }`).
 * Third-party / unofficial: fill only when missing AND thinking is enabled/adaptive.
 * Never overwrite a caller-supplied context_management. No thinking → skip
 * (clear_thinking_20251015 400s if thinking is off). Haiku / unsupported
 * models drop the field; final beta sanitize may still strip it later.
 */
export function ensureClearThinkingContextManagement(body = {}) {
  // 不支持的模型（Haiku）即使没开 thinking 也要删掉调用方带的 context_management：
  // cli-hop 会先把 Haiku 的 thinking 固定为 disabled，且跳过后面的 beta 清洗，
  // 这里若提前返回，clear_thinking 就会漏到上游，导致槽内 CLI 被杀。
  if (!modelSupportsContextManagement(body.model)) {
    if (body.context_management == null) return body
    const out = { ...body }
    delete out.context_management
    return out
  }
  if (!thinkingModeEnabled(body)) return body
  if (body.context_management != null) return body
  return {
    ...body,
    context_management: { edits: [{ ...CLEAR_THINKING_EDIT }] },
  }
}

export const FAST_MODE_BETA = 'fast-mode-2026-02-01'

/** Opus 5.5 / Opus 5 / Opus 4.8 accept `speed: "fast"`; 4.7 errors, 4.6 silently runs standard. */
export function modelSupportsFastMode(model = '') {
  const m = String(model || '').toLowerCase()
  if (!m.includes('opus')) return false
  return /opus-5(?![0-9])/.test(m) || /opus-4[-.]8(?![0-9])/.test(m)
}

export function wantsFastMode(body = {}) {
  return (
    String(body?.speed ?? '')
      .trim()
      .toLowerCase() === 'fast' && modelSupportsFastMode(body?.model)
  )
}

/** Add the fast-mode beta when the body asks for fast on a supported model (mimicry drops client betas). */
export function ensureFastModeBeta(header = '', body = {}) {
  if (!wantsFastMode(body) || anthropicBetaTokensContains(header, FAST_MODE_BETA)) return header
  return header ? `${header},${FAST_MODE_BETA}` : FAST_MODE_BETA
}

export function anthropicBetaTokensContains(header, token) {
  if (!header || !token) return false
  return String(header)
    .split(',')
    .map((part) => part.trim())
    .includes(token)
}

/**
 * Keep context_management only when the beta is present.
 * Haiku (and any hop without prompt-caching-scope) must drop cache_control.scope
 * or Anthropic 400s Extra inputs.
 * Haiku / hops without mid-conversation-system must lift messages[].role=system
 * or Anthropic 400s `role 'system' is not supported on this model`.
 */
export function sanitizeAnthropicBodyForBetaTokens(body = {}, anthropicBetaHeader = '') {
  if (!body || typeof body !== 'object') return body
  let out = body
  if (
    Object.prototype.hasOwnProperty.call(out, 'context_management') &&
    !anthropicBetaTokensContains(anthropicBetaHeader, CONTEXT_MANAGEMENT_BETA)
  ) {
    out = { ...out }
    delete out.context_management
  }
  if (!anthropicBetaTokensContains(anthropicBetaHeader, PROMPT_CACHING_SCOPE_BETA)) {
    out = stripCacheScopeFields(out)
  }
  // `speed` needs the fast-mode beta; without it the request 400s instead of running standard.
  if (
    Object.prototype.hasOwnProperty.call(out, 'speed') &&
    (!anthropicBetaTokensContains(anthropicBetaHeader, FAST_MODE_BETA) || !modelSupportsFastMode(out.model))
  ) {
    out = { ...out }
    delete out.speed
  }
  const allowMidSystem =
    modelSupportsMidConversationSystem(out.model) &&
    anthropicBetaTokensContains(anthropicBetaHeader, MID_CONVERSATION_SYSTEM_BETA)
  if (
    !allowMidSystem &&
    Array.isArray(out.messages) &&
    out.messages.some((message) => {
      const role = String(message?.role || '')
        .trim()
        .toLowerCase()
      return role === 'system' || role === 'developer'
    })
  ) {
    out = liftMidConversationSystemMessages(out)
  }
  out = dropEmptySystemControlTurns(out)
  return downgradeUngatedThinkingDisplay(out, anthropicBetaHeader)
}

/** sub2api normalizeClaudeOAuthRequestBody defaults (temperature / empty tools). */
export function ensureClaudeOAuthBodyDefaults(body = {}) {
  const out = body && typeof body === 'object' ? body : {}
  if (out.temperature == null) out.temperature = 1
  if (!Array.isArray(out.tools)) out.tools = []
  if (out.tools.length === 0 && out.tool_choice) delete out.tool_choice
  return out
}

/**
 * `cacheBreakpoints` is opt-in: only the outbound assembly passes it, so probe
 * and count-token helpers keep their existing byte shape. Injection must run
 * before enforceCacheLimit or a body could ship more than four markers.
 */
export function prepareAnthropicRequest(
  body = {},
  {
    cacheControlLimit = 4,
    unofficial = false,
    cacheBreakpoints = null,
    cacheTtl = DEFAULT_CACHE_TTL,
    inbound = null,
    preserveThinkingBlocks = false,
  } = {},
) {
  let out = clone(body)
  // Model-aware thinking normalize (adaptive ↔ enabled) before other policy
  normalizeThinkingForModel(out)
  out = applyModelRequestRules(out)
  applyMaxTokensCap(out)
  if (unofficial) {
    out = ensureUnofficialAdaptiveThinking(out)
    out = ensureUnofficialEffortHigh(out)
    validateBetweenToolsThinking(out)
    out = rectifyUnofficialRequest(out)
  } else out = ensureOutputConfigSchema(out)
  if (Array.isArray(out.system)) {
    out.system = cleanContent(out.system, { keepEmptyIdentity: true })
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => ({
      ...message,
      content: cleanContent(normalizeImageContentBlocks(message?.content)),
    }))
  }
  const stripped = stripInvalidThinkingBlocks(out, { preserveThinkingBlocks })
  if (stripped.messages) out.messages = stripped.messages
  out = ensureClearThinkingContextManagement(out)
  out = alignSamplingWithThinking(out)
  out = ensureClaudeOAuthBodyDefaults(out)
  if (cacheBreakpoints) {
    out = applyCacheBreakpoints(out, { ttl: cacheTtl, config: cacheBreakpoints, inbound })
  }
  normalizeCacheTTL(out)
  enforceCacheLimit(out, cacheControlLimit)
  return out
}

function allocateToolName(name, used, { rewrite = true } = {}) {
  const original = String(name || '')
  const legal = TOOL_NAME.test(original)
  if ((!rewrite || legal) && legal && !used.has(original)) {
    used.add(original)
    return original
  }
  const digest = crypto.createHash('sha256').update(original).digest('hex').slice(0, 16)
  let candidate = `kin_tool_${digest}`
  let suffix = 1
  while (used.has(candidate) || !TOOL_NAME.test(candidate)) {
    candidate = `kin_tool_${digest}_${suffix++}`
  }
  used.add(candidate)
  return candidate
}
function rejectToolNames(message) {
  const error = new Error(message)
  error.status = 400
  error.body = { type: 'error', error: { type: 'invalid_request_error', code: 'invalid_tool_name', message } }
  throw error
}

function canonicalServerTools(tools) {
  const seen = new Map()
  const kept = []
  for (const tool of tools) {
    if (!isAnthropicServerTool(tool)) {
      kept.push(tool)
      continue
    }
    const name = String(tool?.name || '')
    if (!TOOL_NAME.test(name)) rejectToolNames(`Server tool name '${name}' is not valid.`)
    const previous = seen.get(name)
    if (!previous) {
      seen.set(name, tool)
      kept.push(tool)
      continue
    }
    if (JSON.stringify(previous) !== JSON.stringify(tool)) {
      rejectToolNames(`Server tool '${name}' is declared more than once with different options.`)
    }
  }
  return kept
}

export function rewriteToolNames(body = {}, { enabled = true } = {}) {
  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    return { body, reverse: {} }
  }
  const out = clone(body)
  const used = new Set()
  out.tools = canonicalServerTools(out.tools)
  for (const tool of out.tools) {
    if (isAnthropicServerTool(tool)) used.add(String(tool.name))
  }
  const reverse = {}
  const declarations = new Map()
  out.tools = out.tools.map((tool) => {
    if (isAnthropicServerTool(tool)) return tool
    const original = String(tool?.name || '')
    const rewritten = allocateToolName(original, used, { rewrite: enabled })
    const queue = declarations.get(original) || []
    queue.push(rewritten)
    declarations.set(original, queue)
    reverse[rewritten] = original
    return { ...tool, name: rewritten }
  })
  const canonical = new Map([...declarations].map(([original, names]) => [original, names[0]]))
  if (out.tool_choice?.name && canonical.has(out.tool_choice.name)) {
    out.tool_choice = { ...out.tool_choice, name: canonical.get(out.tool_choice.name) }
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      return {
        ...message,
        content: message.content.map((block) => {
          if (block?.type === 'tool_use' && canonical.has(block.name)) {
            return { ...block, name: canonical.get(block.name) }
          }
          return block
        }),
      }
    })
  }
  return { body: out, reverse }
}

export function restoreToolNames(response, reverse = {}) {
  if (!response || typeof response !== 'object' || Object.keys(reverse).length === 0) return response
  const out = clone(response)
  const restoreBlocks = (content) => {
    if (!Array.isArray(content)) return content
    return content.map((block) =>
      block?.type === 'tool_use' && reverse[block.name] ? { ...block, name: reverse[block.name] } : block,
    )
  }
  out.content = restoreBlocks(out.content)
  if (out.message) out.message.content = restoreBlocks(out.message.content)
  return out
}

export function restoreToolNamesInSSELine(line, reverse = {}) {
  if (!String(line).startsWith('data:') || Object.keys(reverse).length === 0) return line
  const prefix = String(line).slice(0, String(line).indexOf('data:') + 5)
  const raw = String(line)
    .slice(String(line).indexOf('data:') + 5)
    .trim()
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return line
  }
  if (payload?.content_block?.type === 'tool_use' && reverse[payload.content_block.name]) {
    payload.content_block.name = reverse[payload.content_block.name]
  }
  if (payload?.delta?.type === 'tool_use' && reverse[payload.delta.name]) {
    payload.delta.name = reverse[payload.delta.name]
  }
  if (payload?.message) payload.message = restoreToolNames(payload.message, reverse)
  return `${prefix} ${JSON.stringify(payload)}`
}

const CLIENT_PROSE = [
  ['Hermes Agent', 'Claude Code'],
  ['Hermes agent', 'Claude Code'],
  ['Nous Research', 'Anthropic'],
]
const CLIENT_SLUG = /(?<![\w./:@'"`-])hermes-agent(?![\w/@-]|\.\w)/g

function scrubClientProse(text) {
  let out = String(text ?? '')
  for (const [from, to] of CLIENT_PROSE) {
    if (out.includes(from)) out = out.split(from).join(to)
  }
  return out.replace(CLIENT_SLUG, 'claude-code')
}

/** Third-party tool names Anthropic bills as extra usage. Official CC names stay. */
export function wireToolName(name, { official = false, rewriteTools = true } = {}) {
  const raw = String(name || '')
  if (!raw || raw.startsWith('mcp__')) return raw
  if (raw.startsWith('mcp_')) return `mcp__${raw.slice(4)}`
  if (official || rewriteTools === false) return raw
  return `mcp__${raw}`
}

/**
 * Hermes calls this gateway as a third-party Messages client and does not apply
 * its own OAuth identity transform. Rewrite the outbound body before either hop:
 * product strings leave system and tool text, and tool names land on mcp__.
 * Official Claude Code keeps its own tool names; a stray mcp_ name is still fixed.
 */
export function scrubUpstreamClientBody(body, { official = false, rewriteTools = true } = {}) {
  if (!body || typeof body !== 'object') return { body, reverse: {} }
  const out = clone(body)
  const reverse = {}
  const used = new Set()
  const assigned = new Map()
  const rename = (name) => {
    if (assigned.has(name)) return assigned.get(name)
    let wire = wireToolName(name, { official, rewriteTools })
    if (!wire) return name
    if (wire !== name) {
      const base = wireToolName(name, { official, rewriteTools })
      let suffix = 2
      while (used.has(wire)) wire = `${base}_${suffix++}`
      reverse[wire] = name
    }
    used.add(wire)
    assigned.set(name, wire)
    return wire
  }
  if (typeof out.system === 'string') out.system = scrubClientProse(out.system)
  else if (Array.isArray(out.system)) out.system = out.system.map((block) => scrubTextBlock(block))
  if (Array.isArray(out.tools)) {
    out.tools = out.tools.map((tool) => {
      if (!tool || typeof tool !== 'object' || isAnthropicServerTool(tool)) return tool
      const next = { ...tool }
      if (typeof next.name === 'string') next.name = rename(next.name)
      if (typeof next.description === 'string') next.description = scrubClientProse(next.description)
      return next
    })
  }
  if (out.tool_choice && typeof out.tool_choice === 'object' && typeof out.tool_choice.name === 'string') {
    const name = rename(out.tool_choice.name)
    if (name !== out.tool_choice.name) out.tool_choice = { ...out.tool_choice, name }
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => scrubMessage(message, rename))
  }
  return { body: out, reverse }
}

function scrubTextBlock(block) {
  if (typeof block === 'string') {
    const text = scrubClientProse(block)
    return text === block ? block : text
  }
  if (!block || typeof block !== 'object' || typeof block.text !== 'string') return block
  const text = scrubClientProse(block.text)
  return text === block.text ? block : { ...block, text }
}

function scrubMessage(message, rename) {
  if (!message || typeof message !== 'object') return message
  const systemTurn = message.role === 'system'
  if (typeof message.content === 'string') {
    if (!systemTurn) return message
    const content = scrubClientProse(message.content)
    return content === message.content ? message : { ...message, content }
  }
  if (!Array.isArray(message.content)) return message
  let changed = false
  const content = message.content.map((block) => {
    if (!block || typeof block !== 'object') return block
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      const name = rename(block.name)
      if (name !== block.name) {
        changed = true
        return { ...block, name }
      }
    }
    if (systemTurn) {
      const next = scrubTextBlock(block)
      if (next !== block) changed = true
      return next
    }
    return block
  })
  return changed ? { ...message, content } : message
}

/** Map a hop tool-name table through the front rewrite so the client still sees its names. */
export function composeToolNames(front = {}, hop = {}) {
  const out = { ...front }
  for (const [wire, mid] of Object.entries(hop || {})) {
    if (!wire || wire === mid) continue
    const client = front[mid] || mid
    if (client !== wire) out[wire] = client
    delete out[mid]
  }
  for (const [wire, client] of Object.entries(out)) {
    if (client === wire) delete out[wire]
  }
  return out
}

/**
 * Front gate: every non-classifier Messages body becomes standard Anthropic
 * blocks before persona or either hop. Caller billing is removed here unless
 * official passthrough is on; the project template writes its own.
 */
export function toStandardAnthropicBody(body, { official = false, rewriteTools = true } = {}) {
  const shaped = sanitizeAnthropicBody(stripCallerBilling(body), { preserveContentShape: false })
  return scrubUpstreamClientBody(shaped, { official, rewriteTools })
}

function stripBillingText(text) {
  return String(text || '').replace(/^[ \t]*x-anthropic-billing-header:[^\n]*(?:\n|$)/gim, '')
}

function stripCallerBilling(body) {
  if (!body || typeof body !== 'object' || body.system == null) return body
  const keep = (block) => {
    const raw = typeof block === 'string' ? block : block?.text
    if (typeof raw !== 'string' || !/x-anthropic-billing-header:/i.test(raw)) return block
    const text = stripBillingText(raw)
    if (!text) return null
    if (text === raw) return block
    return typeof block === 'string' ? text : { ...block, text }
  }
  if (typeof body.system === 'string') {
    const text = keep(body.system)
    if (text === body.system) return body
    const next = { ...body }
    if (text) next.system = text
    else delete next.system
    return next
  }
  if (!Array.isArray(body.system)) return body
  const system = body.system.map(keep).filter((block) => block != null)
  if (system.length === body.system.length && system.every((block, index) => block === body.system[index])) return body
  const next = { ...body }
  if (system.length) next.system = system
  else delete next.system
  return next
}
