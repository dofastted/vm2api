import { sanitizeAnthropicBody, messageHasTurnControls } from './sanitize.mjs'

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
    }
    if (block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) invalid(`${at}.tool_use_id`, 'is required')
      if (block.content != null) validateContent(block.content, `${at}.content`)
    }
  }
}

function canonicalRequest(body) {
  if (!object(body)) invalid('body', 'must be an object')
  if (typeof body.model !== 'string' || !body.model.trim()) invalid('model', 'is required')
  if (!Array.isArray(body.messages) || !body.messages.length) invalid('messages', 'must be a non-empty array')
  for (const [index, message] of body.messages.entries()) {
    const at = `messages[${index}]`
    if (!object(message)) invalid(at, 'must be an object')
    if (message.content == null && messageHasTurnControls(message)) continue
    validateContent(message.content, `${at}.content`)
  }
  // Keep official extension fields, history bytes and cache anchors. In particular,
  // changing tool IDs or thinking signatures here invalidates CRAG continuation hashes.
  const out = sanitizeAnthropicBody(body, { preserveContentShape: false })
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
export function prepareCragRequest(body) {
  const out = canonicalRequest(body)
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
