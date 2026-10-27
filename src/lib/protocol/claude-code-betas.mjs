/**
 * Claude Code OAuth beta sets, aligned with sub2api claude/constants.go.
 *
 * KIN only overwrites VM identity (device / account / stainless).
 * Protocol betas follow sub2api:
 *   official + client beta → passthrough (plus oauth if missing, minus 1M by matrix)
 *   official + empty       → DefaultBetaHeader / HaikuBetaHeader
 *   unofficial / mimic     → FullClaudeCodeMimicryBetas (Haiku: HAIKU_BETA_HEADER), never context-1m
 */
export const BETA_OAUTH = 'oauth-2025-04-20'
export const BETA_CLAUDE_CODE = 'claude-code-20250219'
export const BETA_INTERLEAVED = 'interleaved-thinking-2025-05-14'
export const BETA_THINKING_TOKEN_COUNT = 'thinking-token-count-2026-05-13'
export const BETA_PROMPT_CACHING_SCOPE = 'prompt-caching-scope-2026-01-05'
export const BETA_MID_CONVERSATION_SYSTEM = 'mid-conversation-system-2026-04-07'
export const BETA_MID_CONVERSATION_SYSTEM_CLEAR_AT = 'mid-conversation-system-clear-at-2026-08-21'
export const BETA_MID_CONVERSATION_TOOL_CHANGES = 'mid-conversation-tool-changes-2026-07-01'
export const BETA_MID_CONVERSATION_OUTPUT_CONFIG = 'mid-conversation-output-config-2026-07-01'
export const BETA_ADVANCED_TOOL_USE = 'advanced-tool-use-2025-11-20'
export const BETA_THINKING_BINDING_CONTROLS = 'thinking-binding-controls-2026-08-01'
export const BETA_EFFORT = 'effort-2025-11-24'
export const BETA_EXTENDED_CACHE_TTL = 'extended-cache-ttl-2025-04-11'
export const BETA_CACHE_DIAGNOSIS = 'cache-diagnosis-2026-04-07'
export const BETA_CONTEXT_MANAGEMENT = 'context-management-2025-06-27'
export const BETA_FALLBACK_CREDIT = 'fallback-credit-2026-06-01'
export const BETA_CONTEXT_1M = 'context-1m-2025-08-07'
/** Request gates must be applied by the final HTTP wire owner. */
export const BETA_THINKING_DISPLAY_UPDATES = 'thinking-display-updates-2026-08-18'
export const BETA_DANGEROUS_TOOL_USE = 'dangerous-tool-use-2026-09-03'

const PER_TURN_MODELS = {
  'claude-haiku-5-5': true,
  'claude-sonnet-5-5': true,
  'claude-opus-5-5': true,
  'claude-fable-5-1': true,
}
const MID_TOOL_CHANGE_MODELS = {
  'claude-haiku-5-5': true,
  'claude-sonnet-5-5': true,
  'claude-opus-4-8': true,
  'claude-opus-5': true,
  'claude-opus-5-5': true,
  'claude-fable-5': true,
  'claude-fable-5-1': true,
  'claude-mythos-5-1': true,
}
const FAST_MODE_MODELS = {
  'claude-opus-4-8': true,
  'claude-opus-5': true,
  'claude-opus-5-5': true,
}
const MID_OUTPUT_CONFIG_MODELS = {
  'claude-haiku-5-5': true,
  'claude-sonnet-5-5': true,
  'claude-opus-5': true,
  'claude-opus-5-5': true,
  'claude-fable-5-1': true,
  'claude-mythos-5-1': true,
}

function hasHourCache(node) {
  if (Array.isArray(node)) return node.some(hasHourCache)
  if (!node || typeof node !== 'object') return false
  return node.cache_control?.ttl === '1h' || hasHourCache(node.content)
}

function hasCacheScope(node) {
  if (Array.isArray(node)) return node.some(hasCacheScope)
  if (!node || typeof node !== 'object') return false
  return node.cache_control?.scope != null || hasCacheScope(node.content)
}

export function withRequestProtocolBetas(tokens = [], body = {}) {
  const betas = [...new Set(tokens.filter(Boolean))]
  const add = (token, before) => {
    if (betas.includes(token)) return
    const at = before ? betas.indexOf(before) : -1
    if (at === -1) betas.push(token)
    else betas.splice(at, 0, token)
  }
  // Catalog capabilities do not imply opt-in timing/thread/diagnostic fields.
  const model = String(body.model || '')
    .split('/')
    .pop()
    .replace(/\[1m\]/gi, '')
    .replace(/-\d{8}$/, '')
  if (Object.hasOwn(PER_TURN_MODELS, model)) add('per-turn-control-2026-07-01', BETA_MID_CONVERSATION_TOOL_CHANGES)
  if (Object.hasOwn(MID_TOOL_CHANGE_MODELS, model) || model === 'auto') add(BETA_MID_CONVERSATION_TOOL_CHANGES)
  if (body.thread != null && Object.hasOwn(MID_OUTPUT_CONFIG_MODELS, model)) add(BETA_MID_CONVERSATION_OUTPUT_CONFIG)
  if (body.output_config?.effort != null) add(BETA_EFFORT)
  if (body.thinking?.display === 'updates') add(BETA_THINKING_DISPLAY_UPDATES)
  if (Array.isArray(body.safeguards) && body.safeguards.some((item) => item?.type === 'dangerous_tool_use'))
    add(BETA_DANGEROUS_TOOL_USE)
  if (body.output_config?.format) add('structured-outputs-2025-12-15')
  if (body.output_config?.task_budget) add('task-budgets-2026-03-13')
  if (body.context_management) add(BETA_CONTEXT_MANAGEMENT)
  if (body.speed === 'fast' && Object.hasOwn(FAST_MODE_MODELS, model)) add('fast-mode-2026-02-01')
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool?.strict === true) add('structured-outputs-2025-12-15')
      if (tool?.defer_loading || String(tool?.type || '').startsWith('tool_search_tool_')) add(BETA_ADVANCED_TOOL_USE)
    }
  }
  if (body.thinking?.block_binding) add(BETA_THINKING_BINDING_CONTROLS)
  if (body.thread != null) add('message-threads-2026-08-12')
  if (body.diagnostics != null) add(BETA_CACHE_DIAGNOSIS)
  if (body.fallbacks === 'default') add('server-side-fallback-2026-07-01')
  else if (Array.isArray(body.fallbacks) && body.fallbacks.length > 0) add('server-side-fallback-2026-06-01')
  if (
    typeof body.fallback_credit_token === 'string' &&
    body.fallback_credit_token.length > 0 &&
    body.fallback_credit_token.length <= 2048
  )
    add(BETA_FALLBACK_CREDIT)
  if (body.cache_control?.evict_on_complete) add('prompt-caching-evict-2026-05-12')
  if (hasHourCache(body) || hasHourCache(body.system) || hasHourCache(body.tools) || hasHourCache(body.messages))
    add(BETA_EXTENDED_CACHE_TTL)
  if (hasCacheScope(body) || hasCacheScope(body.system) || hasCacheScope(body.tools) || hasCacheScope(body.messages))
    add(BETA_PROMPT_CACHING_SCOPE)
  if (Array.isArray(body.messages)) {
    let hasClearAt = false
    let hasMessageOutputConfig = false
    let hasMessageEffort = false
    let hasMessageFormat = false
    let hasMessageTaskBudget = false
    for (const message of body.messages) {
      if (!message || typeof message !== 'object') continue
      if (message.clear_at != null) hasClearAt = true
      const config = message.output_config
      if (!config || typeof config !== 'object') continue
      hasMessageOutputConfig = true
      if (config.effort != null) hasMessageEffort = true
      if (config.format) hasMessageFormat = true
      if (config.task_budget) hasMessageTaskBudget = true
    }
    if (hasClearAt) add(BETA_MID_CONVERSATION_SYSTEM_CLEAR_AT)
    if (hasMessageOutputConfig) add(BETA_MID_CONVERSATION_OUTPUT_CONFIG)
    if (hasMessageEffort) add(BETA_EFFORT)
    if (hasMessageFormat) add('structured-outputs-2025-12-15')
    if (hasMessageTaskBudget) add('task-budgets-2026-03-13')
  }
  return betas
}

export const HAIKU_BETA_HEADER = `${BETA_OAUTH},${BETA_INTERLEAVED}`

/** Official 2.1.303 `--print` prefix. Field-gated tokens stay after it. */
export function fullClaudeCodeMimicryBetas() {
  return [
    BETA_CLAUDE_CODE,
    BETA_OAUTH,
    BETA_INTERLEAVED,
    BETA_THINKING_TOKEN_COUNT,
    BETA_CONTEXT_MANAGEMENT,
    BETA_PROMPT_CACHING_SCOPE,
    'per-turn-control-2026-07-01',
    BETA_MID_CONVERSATION_TOOL_CHANGES,
    BETA_ADVANCED_TOOL_USE,
    BETA_MID_CONVERSATION_SYSTEM_CLEAR_AT,
    BETA_EFFORT,
    BETA_THINKING_BINDING_CONTROLS,
    BETA_EXTENDED_CACHE_TTL,
    BETA_CACHE_DIAGNOSIS,
  ]
}

export const DEFAULT_BETA_HEADER = fullClaudeCodeMimicryBetas().join(',')

function isLegacyHaiku(modelId = '') {
  const id = String(modelId || '')
  return /haiku/i.test(id) && !/haiku-5/i.test(id)
}

export function defaultOfficialBetaHeader(modelId = '') {
  return isLegacyHaiku(modelId) ? HAIKU_BETA_HEADER : DEFAULT_BETA_HEADER
}

export function joinBetas(tokens = []) {
  return [...tokens].filter(Boolean).join(',')
}

export const API_KEY_BETAS = [BETA_CLAUDE_CODE, BETA_INTERLEAVED]

export function stripOauthBeta(header = '') {
  return String(header || '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && p !== BETA_OAUTH)
    .join(',')
}

export function apiKeyBetaHeader(header = '') {
  const stripped = stripOauthBeta(header)
  return stripped || API_KEY_BETAS.join(',')
}

/** Setup Token runtime uses the inference-compatible beta set. Claude Code session betas 401 it. */
export function setupTokenBetaHeader(modelId = '') {
  if (isLegacyHaiku(modelId)) return HAIKU_BETA_HEADER
  return joinBetas([BETA_OAUTH, BETA_INTERLEAVED, BETA_CONTEXT_MANAGEMENT])
}

/** Merge required mimicry tokens into an existing beta header, preserving order. */
export function ensureMimicryBetas(header = '', required = DEFAULT_BETA_HEADER) {
  const have = String(header || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const seen = new Set(have)
  for (const token of String(required || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!seen.has(token)) {
      have.push(token)
      seen.add(token)
    }
  }
  return have.join(',')
}

/** sub2api getBetaHeader: official client list must contain oauth-2025-04-20. */
export function ensureOauthBeta(header = '') {
  const parts = String(header || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return header
  if (parts.includes(BETA_OAUTH)) return parts.join(',')
  const idx = parts.indexOf(BETA_CLAUDE_CODE)
  if (idx >= 0) {
    parts.splice(idx + 1, 0, BETA_OAUTH)
    return parts.join(',')
  }
  return [BETA_OAUTH, ...parts].join(',')
}
