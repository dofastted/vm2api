import { isSmallTextTurn, messageHasTurnControls, reusableContentBlock, sanitizeAnthropicBody } from './sanitize.mjs'
import { normalizeToolInputSchemas } from './tool-input-schema.mjs'

const INTERNAL_FIELDS = ['gateway_policy', 'request_context', 'kin_outbound_shape', 'request_id', 'delivery_mode']
const CRAG_ALIASES = new Set(['model', 'max_tokens', 'effort', 'cache_ttl', 'session_slots'])
const CRAG_PROVIDER_TOOLS = new Map([
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
])
const CRAG_PROVIDER_HISTORY = new Set([
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  'container_upload',
])
const CRAG_PROVIDER_NAMES = new Set([
  ...CRAG_PROVIDER_TOOLS.values(),
  'bash_code_execution',
  'text_editor_code_execution',
])

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

export function needsCragProviderCompatibility(body, capabilities) {
  const native = capabilities?.includes('generation_controls_v3') === true
  const providerTools = capabilities?.includes('provider_managed_tools_v1') === true
  let usesProviderTools = false
  for (const [index, tool] of (Array.isArray(body?.tools) ? body.tools : []).entries()) {
    const type = tool?.type
    if (type == null || type === 'custom' || type === 'advisor_20260301') continue
    const name = CRAG_PROVIDER_TOOLS.get(type)
    if ((native || name) && (!providerTools || !name)) {
      invalid(`tools[${index}].type`, 'this CRAG runtime does not support this provider-managed tool')
    }
    if (name) {
      if (tool.name !== name) invalid(`tools[${index}].name`, `must be ${name} for this provider-managed tool`)
      usesProviderTools = true
    }
  }
  if (body?.thread != null && capabilities?.includes('message_threads_beta')) return true
  if (usesProviderTools) return true
  const history =
    Array.isArray(body?.messages) &&
    body.messages.some(
      (message) =>
        Array.isArray(message?.content) &&
        message.content.some(
          (block) =>
            CRAG_PROVIDER_HISTORY.has(block?.type) ||
            (block?.type === 'server_tool_use' && CRAG_PROVIDER_NAMES.has(block.name)),
        ),
    )
  if (history && native && !providerTools)
    invalid('messages', 'this CRAG runtime does not support provider-managed tool history')
  return providerTools && history
}

function validateContent(content, param, checkReuse) {
  if (typeof content === 'string') return false
  if (!Array.isArray(content)) invalid(param, 'must be text or an array of content blocks')
  let reusable = checkReuse
  for (const [index, block] of content.entries()) {
    if (typeof block === 'string') {
      reusable = false
      continue
    }
    if (!object(block) || typeof block.type !== 'string' || !block.type)
      invalid(`${param}[${index}]`, 'must be a typed content block')
    if (block.type === 'text' && typeof block.text !== 'string') invalid(`${param}[${index}].text`, 'must be a string')
    reusable &&= reusableContentBlock(block)
    if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || !block.id) invalid(`${param}[${index}].id`, 'is required')
      if (typeof block.name !== 'string' || !block.name) invalid(`${param}[${index}].name`, 'is required')
      if (!object(block.input)) invalid(`${param}[${index}].input`, 'must be an object')
    }
    if (block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string' || !block.tool_use_id)
        invalid(`${param}[${index}].tool_use_id`, 'is required')
      if (block.content != null) {
        const nested = validateContent(block.content, `${param}[${index}].content`, reusable)
        if (Array.isArray(block.content)) reusable &&= nested
      }
    }
  }
  return reusable
}

function validateMessages(messages, checkReuse = false) {
  if (!Array.isArray(messages) || !messages.length) invalid('messages', 'must be a non-empty array')
  let reusable = checkReuse
  let previousRole = 'assistant'
  for (const [index, message] of messages.entries()) {
    const at = `messages[${index}]`
    if (!object(message)) invalid(at, 'must be an object')
    const { role, content } = message
    reusable &&=
      (role === 'user' || role === 'assistant') && role !== previousRole && Array.isArray(content) && !!content.length
    previousRole = role
    if (content == null && messageHasTurnControls(message)) continue
    reusable = validateContent(content, `${at}.content`, reusable)
  }
  return reusable
}

function canonicalRequest(body, { reuseCanonicalHistory = false } = {}) {
  if (!object(body)) invalid('body', 'must be an object')
  const tools = normalizeToolInputSchemas(body.tools, invalid)
  if (tools !== body.tools) body = { ...body, tools }
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
  if (!reuseCanonicalHistory) validateMessages(body.messages)
  // Keep official extension fields, history bytes and cache anchors. In particular,
  // changing tool IDs or thinking signatures here invalidates CRAG continuation hashes.
  const out = sanitizeAnthropicBody(body, {
    reuseCanonicalHistory: reuseCanonicalHistory && ((messages) => validateMessages(messages, true)),
  })
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
  if (needsCragProviderCompatibility(out, health?.capabilities) && out.crag_prompt != null) {
    invalid('crag_prompt', 'provider compatibility requests must use system instead')
  }
  delete out.auto_compact_window
  // Claude Code 2.1.325+ sends `diagnostics: { previous_message_id }` (cache-diagnosis beta) on every turn.
  // CRAG's bundled Claude Code predates it and rejects the whole request with 400
  // "unsupported request field: diagnostics"; the field only asks for optional cache diagnostics.
  delete out.diagnostics
  if (out.crag_options != null) {
    if (!object(out.crag_options)) invalid('crag_options', 'must be an object')
    const aliases = Object.fromEntries(Object.entries(out.crag_options).filter(([key]) => CRAG_ALIASES.has(key)))
    if (Object.keys(aliases).length) out.crag_options = aliases
    else delete out.crag_options
  }
  if (!out.messages.some((message) => message.role === 'user')) invalid('messages', 'must include a user turn')
  return out
}
