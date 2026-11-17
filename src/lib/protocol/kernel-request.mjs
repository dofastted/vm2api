import { isSmallTextTurn, sanitizeAnthropicBody, messageHasTurnControls } from './sanitize.mjs'

const INTERNAL_FIELDS = ['gateway_policy', 'request_context', 'kin_outbound_shape', 'request_id', 'delivery_mode']
const CRAG_ALIASES = new Set(['model', 'max_tokens', 'effort', 'cache_ttl', 'session_slots'])

function invalid(param, reason) {
  const message = `${param}: ${reason}`
  const error = new Error(message)
  error.status = 400
  error.code = 'invalid_kernel_request'
  error.body = {
    type: 'error',
    error: { type: 'invalid_request_error', code: error.code, message, param, details: { retryable: false } },
  }
  throw error
}

function object(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function validateContent(content, param) {
  if (typeof content === 'string') return
  if (!Array.isArray(content)) invalid(param, 'must be text or an array of content blocks')
  for (const [index, block] of content.entries()) {
    const at = `${param}[${index}]`
    if (typeof block === 'string') continue
    if (!object(block) || typeof block.type !== 'string' || !block.type) invalid(at, 'must be a typed content block')
    if (block.type === 'text' && typeof block.text !== 'string') invalid(`${at}.text`, 'must be a string')
    if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || !block.id) invalid(`${at}.id`, 'is required')
      if (typeof block.name !== 'string' || !block.name) invalid(`${at}.name`, 'is required')
      if (!object(block.input)) invalid(`${at}.input`, 'must be an object')
    }
    if (block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) invalid(`${at}.tool_use_id`, 'is required')
      if (block.content != null) validateContent(block.content, `${at}.content`)
    }
  }
}

function canonicalRequest(body, { reuseCanonicalHistory = false } = {}) {
  if (!object(body)) invalid('body', 'must be an object')
  if (typeof body.model !== 'string' || !body.model.trim()) invalid('model', 'is required')
  if (body.max_tokens != null && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1)) {
    invalid('max_tokens', 'must be a positive integer')
  }
  if (body.tools != null) {
    if (!Array.isArray(body.tools)) invalid('tools', 'must be an array')
    const names = new Set()
    for (const [index, tool] of body.tools.entries()) {
      const at = `tools[${index}]`
      if (!object(tool) || typeof tool.name !== 'string' || !tool.name || names.has(tool.name)) {
        invalid(at, 'must have a unique tool name')
      }
      if (tool.type === 'function' || Object.hasOwn(tool, 'function') || Object.hasOwn(tool, 'parameters')) {
        invalid(at, 'must use a Claude tool definition')
      }
      if (
        (tool.type == null || tool.type === 'custom') &&
        (!object(tool.input_schema) || tool.input_schema.type !== 'object')
      ) {
        invalid(`${at}.input_schema`, 'must be an object schema')
      }
      names.add(tool.name)
    }
    if (body.tool_choice?.type === 'tool' && !names.has(body.tool_choice.name)) {
      invalid('tool_choice.name', 'must identify a supplied tool')
    }
  }
  if (!Array.isArray(body.messages) || !body.messages.length) invalid('messages', 'must be a non-empty array')
  for (const [index, message] of body.messages.entries()) {
    const at = `messages[${index}]`
    if (!object(message)) invalid(at, 'must be an object')
    if (message.content == null && messageHasTurnControls(message)) continue
    validateContent(message.content, `${at}.content`)
  }
  // Keep official extension fields, history bytes and cache anchors. In particular,
  // changing tool IDs or thinking signatures here invalidates CRAG continuation hashes.
  const out = sanitizeAnthropicBody(body, { reuseCanonicalHistory })
  for (const key of INTERNAL_FIELDS) delete out[key]
  if (!out.messages.length) invalid('messages', 'contains no content after normalization')
  return out
}

/** Structured native_messages: the CLI owns system layout and cache policy. */
export function prepareCliNodeRequest(body) {
  const out = canonicalRequest(body)
  for (const key of Object.keys(out)) {
    if (key.startsWith('crag_')) delete out[key]
  }
  delete out.cache_ttl
  delete out.cacheTtl
  delete out.session_slots
  delete out.effort
  return out
}

/** Native CRAG imports history itself; PTY projection remains worker-owned. */
export function prepareCragRequest(body, health) {
  const out = canonicalRequest(body, { reuseCanonicalHistory: !isSmallTextTurn(body) })
  if (health?.capabilities?.includes('generation_controls_v3')) {
    for (const [index, tool] of (out.tools || []).entries()) {
      if (tool.type != null && !['custom', 'advisor_20260301'].includes(tool.type)) {
        invalid(`tools[${index}].type`, 'this CRAG runtime does not support this provider-managed tool')
      }
    }
  }
  delete out.auto_compact_window
  if (out.crag_options != null) {
    if (!object(out.crag_options)) invalid('crag_options', 'must be an object')
    const aliases = Object.fromEntries(Object.entries(out.crag_options).filter(([key]) => CRAG_ALIASES.has(key)))
    if (Object.keys(aliases).length) out.crag_options = aliases
    else delete out.crag_options
  }
  if (!out.messages.some((message) => message.role === 'user')) invalid('messages', 'must include a user turn')
  return out
}
