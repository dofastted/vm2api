/**
 * Zero-trust strict whitelist reconstruction for the CRAG kernel boundary.
 *
 * Replaces blacklist stripping (`DROP_TOP`) with layer-by-layer object rebuilds
 * so non-standard fields, third-party metadata, leaked cache_control subfields
 * (`scope`, `evict_on_complete`), diagnostics, unknown tool schemas, and
 * unadvertised `safeguards` / `speed` / `thread` extensions never pass through
 * into CRAG or Anthropic upstream.
 */
import { CRS_OFFICIAL_CLI_SYSTEM } from '../identity/crs-persona.mjs'
import { materializeAutomaticCache } from './cache-ttl.mjs'
import { normalizeToolInputSchemas } from './tool-input-schema.mjs'

const BILLING_LINE_RE = /^x-anthropic-billing-header:/i
const VALID_TTL = new Set(['5m', '1h'])

export const CRAG_CORE_ALLOWED_TOP_KEYS = Object.freeze(
  new Set([
    'model',
    'messages',
    'system',
    'tools',
    'tool_choice',
    'max_tokens',
    'temperature',
    'top_p',
    'top_k',
    'stop_sequences',
    'thinking',
    'output_config',
    'context_management',
    'stream',
  ]),
)

export const CRAG_INTERNAL_ALLOWED_TOP_KEYS = Object.freeze(
  new Set(['crag_prompt', 'crag_options', 'crag_model', 'cache_ttl', 'cacheTtl', 'session_slots', 'effort']),
)

export const CRAG_CAPABILITY_GATED_TOP_KEYS = Object.freeze(
  new Map([
    ['safeguards', 'request_safeguards'],
    ['speed', 'request_speed'],
    ['thread', 'message_threads_beta'],
    ['service_tier', 'request_service_tier'],
  ]),
)

/**
 * Known CC-native / envelope / diagnostic / legacy client keys that are always
 * stripped cleanly on the CRAG boundary instead of 400ing the caller.
 */
export const CRAG_SILENT_STRIP_TOP_KEYS = Object.freeze(
  new Set([
    'metadata',
    'betas',
    'diagnostics',
    'auto_compact_window',
    'fallbacks',
    'fallback_credit_token',
    'caller_cwd',
    'user',
    'store',
    'stream_options',
    'gateway_policy',
    'request_context',
    'kin_outbound_shape',
    'request_id',
    'delivery_mode',
  ]),
)

const CRAG_PROVIDER_TOOL_NAMES = Object.freeze(
  new Map([
    ['web_search_20250305', 'web_search'],
    ['web_search_20260209', 'web_search'],
    ['web_fetch_20250910', 'web_fetch'],
    ['web_fetch_20260209', 'web_fetch'],
    ['code_execution_20250522', 'code_execution'],
    ['code_execution_20250825', 'code_execution'],
    ['code_execution_20260120', 'code_execution'],
    ['code_execution_20260521', 'code_execution'],
    ['tool_search_tool_regex_20251119', 'tool_search_tool_regex'],
    ['tool_search_tool_bm25_20251119', 'tool_search_tool_bm25'],
  ]),
)

const CUSTOM_TOOL_KEYS = new Set([
  'type',
  'name',
  'description',
  'input_schema',
  'strict',
  'eager_input_streaming',
  'defer_loading',
  'cache_control',
])

const ADVISOR_TOOL_KEYS = new Set(['type', 'name', 'model', 'max_uses', 'caching', 'cache_control'])

const PROVIDER_TOOL_DROP_KEYS = new Set(['annotations', 'function', 'parameters'])

const MESSAGE_ALLOWED_KEYS = new Set(['role', 'content', 'output_config', 'clear_at'])

const BLOCK_KEYS_BY_TYPE = Object.freeze({
  text: new Set(['type', 'text', 'cache_control']),
  image: new Set(['type', 'source', 'cache_control']),
  document: new Set(['type', 'source', 'title', 'context', 'citations', 'cache_control']),
  tool_use: new Set(['type', 'id', 'name', 'input', 'caller', 'cache_control']),
  tool_result: new Set(['type', 'tool_use_id', 'content', 'is_error', 'cache_control']),
  thinking: new Set(['type', 'thinking', 'signature']),
  redacted_thinking: new Set(['type', 'data']),
  tool_reference: new Set(['type', 'tool_name', 'cache_control']),
})

const PROVIDER_HISTORY_BLOCK_TYPES = new Set([
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  'container_upload',
  'advisor_tool_result',
])

const THINKING_KEYS = new Set(['type', 'budget_tokens', 'display'])
const TOOL_CHOICE_KEYS = new Set(['type', 'name', 'disable_parallel_tool_use'])
const OUTPUT_CONFIG_KEYS = new Set(['effort', 'format', 'task_budget'])
const CONTEXT_MANAGEMENT_KEYS = new Set(['edits'])

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(param, reason, code = 'invalid_kernel_request', details = null) {
  const message = `${param}: ${reason}`
  const error = new Error(message)
  error.status = 400
  error.code = code
  error.body = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      code,
      message,
      param,
      details: { retryable: false, ...(details || {}) },
    },
  }
  throw error
}

function pickKeys(source, allowedSet) {
  const out = {}
  for (const key of allowedSet) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) out[key] = source[key]
  }
  return out
}

function hasOnlyAllowedKeys(source, allowedSet) {
  for (const key of Object.keys(source)) {
    if (!allowedSet.has(key)) return false
  }
  return true
}

/** Strict whitelist rebuild of cache_control: only `{ type: 'ephemeral', ttl?: '5m'|'1h' }`. */
export function sanitizeCragCacheControl(control, param = 'cache_control') {
  if (control == null) return undefined
  if (!isPlainObject(control)) invalid(param, 'must be an object', 'invalid_cache_control')
  if (control.type !== 'ephemeral') {
    invalid(param, 'must use type "ephemeral"', 'invalid_cache_control')
  }
  const out = { type: 'ephemeral' }
  if (control.ttl != null && String(control.ttl).trim() !== '') {
    if (!VALID_TTL.has(control.ttl)) {
      invalid(`${param}.ttl`, 'must be "5m" or "1h"', 'invalid_cache_control')
    }
    out.ttl = control.ttl
  }
  return out
}

function isCleanCacheControl(control) {
  if (control == null) return true
  if (!isPlainObject(control) || control.type !== 'ephemeral') return false
  for (const key of Object.keys(control)) {
    if (key !== 'type' && key !== 'ttl') return false
  }
  if (control.ttl != null && !VALID_TTL.has(control.ttl)) return false
  return true
}

/** True when system only carries the placeholder CLI identity left by third-party relocation. */
export function isOnlyOfficialCliIdentitySystem(system) {
  if (system == null) return false
  const blocks =
    typeof system === 'string' ? [{ type: 'text', text: system }] : Array.isArray(system) ? system : [system]
  const texts = []
  for (const block of blocks) {
    const raw =
      typeof block === 'string' ? block : block?.type === 'text' && typeof block.text === 'string' ? block.text : null
    if (raw == null) return false
    const cleaned = raw
      .split('\n')
      .filter((line) => !BILLING_LINE_RE.test(line.trim()))
      .join('\n')
      .trim()
    if (cleaned) texts.push(cleaned)
  }
  return texts.length === 1 && texts[0] === CRS_OFFICIAL_CLI_SYSTEM
}

function stripBillingLines(text) {
  if (!BILLING_LINE_RE.test(text) && !text.includes('x-anthropic-billing-header:')) return text
  return text
    .split('\n')
    .filter((line) => !BILLING_LINE_RE.test(line.trim()))
    .join('\n')
}

function sanitizeSystem(system) {
  if (system == null) return undefined
  if (typeof system === 'string') {
    const cleaned = stripBillingLines(system)
    return cleaned.trim() ? cleaned : undefined
  }
  const list = Array.isArray(system) ? system : [system]
  const out = []
  for (const [index, entry] of list.entries()) {
    const param = Array.isArray(system) ? `system[${index}]` : 'system'
    if (typeof entry === 'string') {
      const cleaned = stripBillingLines(entry)
      if (cleaned.trim()) out.push({ type: 'text', text: cleaned })
      continue
    }
    if (!isPlainObject(entry) || (entry.type != null && entry.type !== 'text') || typeof entry.text !== 'string') {
      invalid(param, 'must be a text block with a string text field', 'invalid_system_block')
    }
    const cleaned = stripBillingLines(entry.text)
    if (!cleaned.trim()) continue
    const block = { type: 'text', text: cleaned }
    if (entry.cache_control != null) {
      block.cache_control = sanitizeCragCacheControl(entry.cache_control, `${param}.cache_control`)
    }
    out.push(block)
  }
  return out.length ? out : undefined
}

function isCleanBlock(block) {
  if (!isPlainObject(block) || typeof block.type !== 'string' || !block.type) return false
  if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    if (Object.hasOwn(block, 'cache_control')) return false
    return hasOnlyAllowedKeys(block, BLOCK_KEYS_BY_TYPE[block.type])
  }
  const allowed = BLOCK_KEYS_BY_TYPE[block.type]
  if (allowed) {
    if (!hasOnlyAllowedKeys(block, allowed)) return false
    if (!isCleanCacheControl(block.cache_control)) return false
    if (block.type === 'text' && typeof block.text !== 'string') return false
    if (block.type === 'tool_use') {
      if (
        typeof block.id !== 'string' ||
        !block.id ||
        typeof block.name !== 'string' ||
        !block.name ||
        !isPlainObject(block.input)
      ) {
        return false
      }
    }
    if (block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) return false
      if (Array.isArray(block.content) && !block.content.every(isCleanBlock)) return false
    }
    return true
  }
  if (PROVIDER_HISTORY_BLOCK_TYPES.has(block.type)) {
    return !Object.hasOwn(block, 'annotations') && isCleanCacheControl(block.cache_control)
  }
  return false
}

function isCleanMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return false
  for (const message of messages) {
    if (!isPlainObject(message) || !hasOnlyAllowedKeys(message, MESSAGE_ALLOWED_KEYS)) return false
    if (!['user', 'assistant', 'system'].includes(message.role)) return false
    if (typeof message.content === 'string') continue
    if (!Array.isArray(message.content)) return false
    if (!message.content.every(isCleanBlock)) return false
  }
  return true
}

function sanitizeContentBlock(block, param) {
  if (typeof block === 'string') return { type: 'text', text: block }
  if (!isPlainObject(block) || typeof block.type !== 'string' || !block.type) {
    invalid(param, 'must be a typed content block')
  }
  const { type } = block
  if (type === 'text') {
    if (typeof block.text !== 'string') invalid(`${param}.text`, 'must be a string')
    const out = { type: 'text', text: block.text }
    if (block.cache_control != null) {
      out.cache_control = sanitizeCragCacheControl(block.cache_control, `${param}.cache_control`)
    }
    return out
  }
  if (type === 'image') {
    const out = pickKeys(block, BLOCK_KEYS_BY_TYPE.image)
    if (out.cache_control != null) {
      out.cache_control = sanitizeCragCacheControl(out.cache_control, `${param}.cache_control`)
    }
    return out
  }
  if (type === 'document') {
    const out = pickKeys(block, BLOCK_KEYS_BY_TYPE.document)
    if (out.cache_control != null) {
      out.cache_control = sanitizeCragCacheControl(out.cache_control, `${param}.cache_control`)
    }
    return out
  }
  if (type === 'tool_use') {
    if (typeof block.id !== 'string' || !block.id) invalid(`${param}.id`, 'is required')
    if (typeof block.name !== 'string' || !block.name) invalid(`${param}.name`, 'is required')
    if (!isPlainObject(block.input)) invalid(`${param}.input`, 'must be an object')
    const out = pickKeys(block, BLOCK_KEYS_BY_TYPE.tool_use)
    if (out.cache_control != null) {
      out.cache_control = sanitizeCragCacheControl(out.cache_control, `${param}.cache_control`)
    }
    return out
  }
  if (type === 'tool_result') {
    if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) invalid(`${param}.tool_use_id`, 'is required')
    const out = { type: 'tool_result', tool_use_id: block.tool_use_id }
    if (block.is_error !== undefined) out.is_error = Boolean(block.is_error)
    if (block.content !== undefined) {
      if (typeof block.content === 'string') {
        out.content = block.content
      } else if (Array.isArray(block.content)) {
        out.content = block.content.map((child, i) => sanitizeContentBlock(child, `${param}.content[${i}]`))
      } else if (block.content !== null) {
        invalid(`${param}.content`, 'must be text or an array of content blocks')
      }
    }
    if (block.cache_control != null) {
      out.cache_control = sanitizeCragCacheControl(block.cache_control, `${param}.cache_control`)
    }
    return out
  }
  if (type === 'thinking') {
    // Thinking blocks never accept cache_control.
    const out = { type: 'thinking', thinking: typeof block.thinking === 'string' ? block.thinking : '' }
    if (block.signature !== undefined) out.signature = block.signature
    return out
  }
  if (type === 'redacted_thinking') {
    return { type: 'redacted_thinking', data: block.data }
  }
  if (type === 'tool_reference') {
    const out = pickKeys(block, BLOCK_KEYS_BY_TYPE.tool_reference)
    if (out.cache_control != null) {
      out.cache_control = sanitizeCragCacheControl(out.cache_control, `${param}.cache_control`)
    }
    return out
  }
  if (PROVIDER_HISTORY_BLOCK_TYPES.has(type)) {
    const out = {}
    for (const [k, v] of Object.entries(block)) {
      if (v === undefined || k === 'annotations') continue
      out[k] = k === 'cache_control' ? sanitizeCragCacheControl(v, `${param}.cache_control`) : v
    }
    return out
  }
  invalid(param, `unsupported content block type "${type}"`)
}

function sanitizeMessages(messages, { preserveCanonicalHistory = false } = {}) {
  if (!Array.isArray(messages) || !messages.length) invalid('messages', 'must be a non-empty array')
  if (preserveCanonicalHistory && isCleanMessages(messages)) return messages
  return messages.map((message, index) => {
    const param = `messages[${index}]`
    if (!isPlainObject(message)) invalid(param, 'must be an object')
    const out = { role: message.role }
    if (typeof message.content === 'string') {
      out.content = message.content
    } else if (Array.isArray(message.content)) {
      out.content = message.content.map((block, blockIndex) =>
        sanitizeContentBlock(block, `${param}.content[${blockIndex}]`),
      )
    } else if (message.content == null && (message.output_config != null || message.clear_at != null)) {
      out.content = []
    } else {
      invalid(`${param}.content`, 'must be text or an array of content blocks')
    }
    if (message.output_config != null && isPlainObject(message.output_config)) {
      out.output_config = pickKeys(message.output_config, OUTPUT_CONFIG_KEYS)
    }
    if (message.clear_at != null) out.clear_at = message.clear_at
    return out
  })
}

function sanitizeTools(rawTools, capabilities) {
  if (rawTools == null) return undefined
  const normalized = normalizeToolInputSchemas(rawTools, invalid)
  if (!Array.isArray(normalized)) invalid('tools', 'must be an array')
  if (!normalized.length) return undefined
  const names = new Set()
  const out = []
  for (const [index, tool] of normalized.entries()) {
    const param = `tools[${index}]`
    if (!isPlainObject(tool) || typeof tool.name !== 'string' || !tool.name || names.has(tool.name)) {
      invalid(param, 'must have a unique tool name')
    }
    if (tool.type === 'function' || Object.hasOwn(tool, 'function') || Object.hasOwn(tool, 'parameters')) {
      invalid(param, 'must use a Claude tool definition')
    }
    if (tool.type === 'advisor_20260301') {
      if (
        tool.name !== 'advisor' ||
        typeof tool.model !== 'string' ||
        !tool.model.trim() ||
        tool.input_schema !== undefined
      ) {
        invalid(param, 'invalid native advisor tool definition')
      }
      const clean = pickKeys(tool, ADVISOR_TOOL_KEYS)
      if (clean.cache_control != null) {
        clean.cache_control = sanitizeCragCacheControl(clean.cache_control, `${param}.cache_control`)
      }
      names.add(tool.name)
      out.push(clean)
      continue
    }
    if (tool.type != null && tool.type !== 'custom') {
      const expectedName = CRAG_PROVIDER_TOOL_NAMES.get(tool.type)
      const hasCap = Array.isArray(capabilities) && capabilities.includes('provider_managed_tools_v1')
      if (!expectedName || (Array.isArray(capabilities) && !hasCap)) {
        invalid(`${param}.type`, 'this CRAG runtime does not support this provider-managed tool')
      }
      if (tool.name !== expectedName) {
        invalid(`${param}.name`, `must be ${expectedName} for this provider-managed tool`)
      }
      if (tool.input_schema !== undefined) {
        invalid(`${param}.input_schema`, 'is not allowed on provider-managed tools')
      }
      const clean = {}
      for (const [k, v] of Object.entries(tool)) {
        if (v === undefined || PROVIDER_TOOL_DROP_KEYS.has(k)) continue
        clean[k] = k === 'cache_control' ? sanitizeCragCacheControl(v, `${param}.cache_control`) : v
      }
      names.add(tool.name)
      out.push(clean)
      continue
    }
    if (!isPlainObject(tool.input_schema) || tool.input_schema.type !== 'object') {
      invalid(`${param}.input_schema`, 'must be an object schema')
    }
    const clean = pickKeys(tool, CUSTOM_TOOL_KEYS)
    if (clean.cache_control != null) {
      clean.cache_control = sanitizeCragCacheControl(clean.cache_control, `${param}.cache_control`)
    }
    names.add(tool.name)
    out.push(clean)
  }
  return out
}

/**
 * Capability-gated strict validation & rebuild for Anthropic `safeguards`.
 * When `capabilities` is an array without `request_safeguards`, strips cleanly
 * so older CRAG binaries do not 400 with "unknown field: safeguards".
 */
export function sanitizeSafeguardsForCrag(safeguards, capabilities) {
  if (safeguards == null) return { value: undefined, stripped: false }
  if (Array.isArray(capabilities)) {
    if (!capabilities.includes('generation_controls_v3')) {
      return { value: safeguards, stripped: false }
    }
    if (!capabilities.includes('request_safeguards')) {
      return { value: undefined, stripped: true }
    }
  }
  if (!Array.isArray(safeguards)) invalid('safeguards', 'must be an array')
  const out = []
  for (const [index, entry] of safeguards.entries()) {
    const param = `safeguards[${index}]`
    if (!isPlainObject(entry)) invalid(param, 'must be an object')
    if (entry.type == null) invalid(`${param}.type`, 'is required')
    if (entry.type !== 'dangerous_tool_use') {
      invalid(`${param}.type`, `unsupported safeguard type "${entry.type}"`, 'unsupported_capability')
    }
    if (!isPlainObject(entry.classifier_context)) {
      invalid(`${param}.classifier_context`, 'must be an object')
    }
    out.push({
      type: 'dangerous_tool_use',
      classifier_context: entry.classifier_context,
    })
  }
  return { value: out.length ? out : undefined, stripped: false }
}

function validateBreakpointOrderAndBudget(body) {
  let count = 0
  let short = false
  const visit = (node, param) => {
    const control = node?.cache_control
    if (control == null) return
    if (control.type !== 'ephemeral' || (control.ttl != null && !VALID_TTL.has(control.ttl))) {
      invalid(param, 'Cache control must be ephemeral with an optional 5m or 1h TTL.', 'invalid_cache_control')
    }
    if (short && control.ttl === '1h') {
      invalid(param, 'Cache TTL must place 1h before 5m (including missing TTL).', 'invalid_cache_control')
    }
    if (control.ttl !== '1h') short = true
    if (++count > 4) {
      invalid(param, 'Cache control exceeds four breakpoints.', 'invalid_cache_control')
    }
  }
  for (const [i, tool] of (body.tools || []).entries()) visit(tool, `tools[${i}].cache_control`)
  if (Array.isArray(body.system)) {
    for (const [i, block] of body.system.entries()) visit(block, `system[${i}].cache_control`)
  }
  for (const [i, msg] of (body.messages || []).entries()) {
    if (!Array.isArray(msg?.content)) continue
    for (const [j, block] of msg.content.entries()) visit(block, `messages[${i}].content[${j}].cache_control`)
  }
}

/**
 * Rebuild a CRAG kernel request body strictly from whitelisted layers.
 *
 * @param {object} input
 * @param {{
 *   capabilities?: string[],
 *   preserveCanonicalHistory?: boolean,
 *   rejectUnknownTopKeys?: boolean,
 *   validateCacheBudget?: boolean,
 * }} [options]
 * @returns {{ body: object, strippedFields: string[], strippedSafeguards: boolean }}
 */
const UNREPRESENTABLE_CRAG_TOP_KEYS = Object.freeze(
  new Set([
    'seed',
    'logprobs',
    'top_logprobs',
    'logit_bias',
    'presence_penalty',
    'frequency_penalty',
    'audio',
    'prediction',
  ]),
)

/**
 * Fail closed before legacy `DROP_TOP` stripping can silently discard
 * unrepresentable sampling/multi-candidate controls on the CRAG boundary.
 */
export function assertNoUnrepresentableCragFields(body) {
  if (!isPlainObject(body)) return
  if (body.n != null && body.n !== 1) {
    invalid('n', 'multi-candidate generation (n > 1) is not supported by CRAG')
  }
  for (const key of UNREPRESENTABLE_CRAG_TOP_KEYS) {
    if (body[key] != null) {
      invalid(key, 'unsupported request field for CRAG kernel')
    }
  }
}

export function sanitizeCragBodyWhitelist(
  input,
  { capabilities, preserveCanonicalHistory = false, rejectUnknownTopKeys = true, validateCacheBudget = true } = {},
) {
  if (!isPlainObject(input)) invalid('body', 'must be an object')
  const materialized = materializeAutomaticCache(input)
  const caps = Array.isArray(capabilities) ? capabilities : null
  const strippedFields = []
  let strippedSafeguards = false

  for (const key of Object.keys(materialized)) {
    if (materialized[key] === undefined) continue
    if (CRAG_CORE_ALLOWED_TOP_KEYS.has(key) || CRAG_INTERNAL_ALLOWED_TOP_KEYS.has(key)) continue
    if (CRAG_CAPABILITY_GATED_TOP_KEYS.has(key)) continue
    if (CRAG_SILENT_STRIP_TOP_KEYS.has(key)) {
      strippedFields.push(key)
      continue
    }
    if (rejectUnknownTopKeys) {
      invalid(key, 'unsupported request field for CRAG kernel')
    }
    strippedFields.push(key)
  }

  const out = {}

  if (typeof materialized.model !== 'string' || !materialized.model.trim()) {
    invalid('model', 'is required')
  }
  out.model = materialized.model

  out.messages = sanitizeMessages(materialized.messages, { preserveCanonicalHistory })

  const system = sanitizeSystem(materialized.system)
  if (system !== undefined) out.system = system

  const tools = sanitizeTools(materialized.tools, caps)
  if (tools !== undefined) out.tools = tools

  if (materialized.tool_choice != null) {
    if (!isPlainObject(materialized.tool_choice)) invalid('tool_choice', 'must be an object')
    out.tool_choice = pickKeys(materialized.tool_choice, TOOL_CHOICE_KEYS)
    if (out.tool_choice.type === 'tool' && (!out.tools || !out.tools.some((t) => t.name === out.tool_choice.name))) {
      invalid('tool_choice.name', 'must identify a supplied tool')
    }
  }

  if (materialized.max_tokens != null) {
    if (!Number.isSafeInteger(materialized.max_tokens) || materialized.max_tokens < 1) {
      invalid('max_tokens', 'must be a positive integer')
    }
    out.max_tokens = materialized.max_tokens
  }

  for (const key of ['temperature', 'top_p']) {
    if (materialized[key] != null) {
      if (
        typeof materialized[key] !== 'number' ||
        !Number.isFinite(materialized[key]) ||
        materialized[key] < 0 ||
        materialized[key] > 1
      ) {
        invalid(key, 'must be a number between 0 and 1')
      }
      out[key] = materialized[key]
    }
  }

  if (materialized.top_k != null) {
    if (!Number.isSafeInteger(materialized.top_k) || materialized.top_k < 1) {
      invalid('top_k', 'must be a positive integer')
    }
    out.top_k = materialized.top_k
  }

  if (materialized.stop_sequences != null) {
    if (!Array.isArray(materialized.stop_sequences) || materialized.stop_sequences.some((s) => typeof s !== 'string')) {
      invalid('stop_sequences', 'must be an array of strings')
    }
    if (materialized.stop_sequences.length) out.stop_sequences = materialized.stop_sequences.slice()
  }

  if (materialized.thinking != null) {
    if (!isPlainObject(materialized.thinking)) invalid('thinking', 'must be an object')
    out.thinking = pickKeys(materialized.thinking, THINKING_KEYS)
  }

  if (materialized.output_config != null) {
    if (!isPlainObject(materialized.output_config)) invalid('output_config', 'must be an object')
    const cfg = pickKeys(materialized.output_config, OUTPUT_CONFIG_KEYS)
    if (Object.keys(cfg).length) out.output_config = cfg
  }

  if (materialized.context_management != null) {
    if (!isPlainObject(materialized.context_management)) invalid('context_management', 'must be an object')
    const cm = pickKeys(materialized.context_management, CONTEXT_MANAGEMENT_KEYS)
    if (Object.keys(cm).length) out.context_management = cm
  }

  if (materialized.stream !== undefined) out.stream = Boolean(materialized.stream)

  // Capability-gated official extensions
  if (materialized.safeguards != null) {
    const sg = sanitizeSafeguardsForCrag(materialized.safeguards, caps)
    if (sg.stripped) {
      strippedSafeguards = true
      strippedFields.push('safeguards')
    } else if (sg.value !== undefined) {
      out.safeguards = sg.value
    }
  }

  if (materialized.speed != null) {
    if (caps && !caps.includes('request_speed')) {
      strippedFields.push('speed')
    } else {
      if (materialized.speed !== 'standard' && materialized.speed !== 'fast') {
        invalid('speed', 'must be "standard" or "fast"')
      }
      out.speed = materialized.speed
    }
  }

  if (materialized.thread != null) {
    if (caps && !caps.includes('message_threads_beta')) {
      strippedFields.push('thread')
    } else {
      out.thread = materialized.thread
    }
  }

  if (materialized.service_tier != null) {
    if (materialized.service_tier !== 'auto' && materialized.service_tier !== 'standard_only') {
      invalid('service_tier', 'must be "auto" or "standard_only"')
    }
    if (caps?.includes('request_service_tier')) {
      out.service_tier = materialized.service_tier
    } else if (materialized.service_tier === 'auto') {
      strippedFields.push('service_tier')
    } else {
      invalid(
        'service_tier',
        'service_tier="standard_only" is not supported on the Claude VM / CRAG execution path; omit service_tier or use "auto" if default capacity is acceptable',
        'unsupported_capability',
        { field: 'service_tier', value: materialized.service_tier, execution_path: 'crag' },
      )
    }
  }

  // Controlled CRAG internal fields
  for (const key of CRAG_INTERNAL_ALLOWED_TOP_KEYS) {
    if (materialized[key] !== undefined) out[key] = materialized[key]
  }

  if (validateCacheBudget) validateBreakpointOrderAndBudget(out)

  return { body: out, strippedFields, strippedSafeguards }
}
