import {
  CRAG_PROVIDER_EXECUTION_NAMES,
  CRAG_PROVIDER_HISTORY_BLOCK_TYPES,
  CRAG_PROVIDER_TOOL_NAMES,
  assertNoUnrepresentableCragFields,
  sanitizeCragBodyWhitelist,
} from './crag-whitelist.mjs'
import { isSmallTextTurn, messageHasTurnControls, reusableContentBlock, sanitizeAnthropicBody } from './sanitize.mjs'
import { normalizeToolInputSchemas } from './tool-input-schema.mjs'

const INTERNAL_FIELDS = [
  'gateway_policy',
  'request_context',
  'kin_outbound_shape',
  'request_id',
  'delivery_mode',
  'prompt_spec',
]
const STRICT_PRIVATE_FIELDS = new Set([...INTERNAL_FIELDS, 'caller_cwd'])
const CRAG_ALIASES = new Set(['model', 'max_tokens', 'effort', 'cache_ttl', 'session_slots'])

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
    const name = CRAG_PROVIDER_TOOL_NAMES.get(type)
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
            (CRAG_PROVIDER_HISTORY_BLOCK_TYPES.has(block?.type) &&
              block?.type !== 'advisor_tool_result' &&
              block?.type !== 'server_tool_use') ||
            (block?.type === 'server_tool_use' && CRAG_PROVIDER_EXECUTION_NAMES.has(block.name)),
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

function canonicalRequest(body, { reuseCanonicalHistory = false, preserveConsecutiveUser = false } = {}) {
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
    preserveConsecutiveUser,
  })
  for (const key of INTERNAL_FIELDS) delete out[key]
  if (!out.messages.length) invalid('messages', 'contains no content after normalization')
  return out
}

/** Structured native_messages: the CLI owns system layout and cache policy. */
export function prepareCliNodeRequest(body, { requestContext = null } = {}) {
  if (body?.service_tier != null) {
    if (body.service_tier !== 'auto' && body.service_tier !== 'standard_only') {
      invalid('service_tier', 'must be "auto" or "standard_only"')
    }
    if (body.service_tier === 'standard_only') {
      invalid(
        'service_tier',
        'service_tier="standard_only" is not supported on the Claude VM / cli-node execution path; omit service_tier or use "auto" if default capacity is acceptable',
        'unsupported_capability',
        { field: 'service_tier', value: body.service_tier, execution_path: 'claude_vm' },
      )
    }
  }
  const out = canonicalRequest(body, {
    preserveConsecutiveUser: requestContext?.purpose === 'auto_mode_classifier',
  })
  if (
    Array.isArray(out.tools) &&
    out.tools.some((t) => String(t?.type || '').startsWith('advisor_') && Object.hasOwn(t, 'input_schema'))
  ) {
    out.tools = out.tools.map((t) => {
      if (!t || !String(t.type || '').startsWith('advisor_') || !Object.hasOwn(t, 'input_schema')) return t
      const { input_schema: _dropped, ...rest } = t
      return rest
    })
  }
  for (const key of Object.keys(out)) {
    if (key.startsWith('crag_')) delete out[key]
  }
  delete out.cache_ttl
  delete out.cacheTtl
  delete out.session_slots
  delete out.effort
  if (out.service_tier === 'auto') delete out.service_tier
  return out
}

/** Native CRAG imports history itself; PTY projection remains worker-owned. */
export function prepareCragRequest(
  body,
  health,
  { requestContext = null, strictPassthrough = false, safeguardsSanitized = false } = {},
) {
  if (strictPassthrough) {
    if (!object(body)) invalid('body', 'must be an object')
    if (typeof body.model !== 'string' || !body.model.trim()) invalid('model', 'is required')
    if (!Array.isArray(body.messages) || !body.messages.length) invalid('messages', 'must be a non-empty array')
    const out = {}
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || STRICT_PRIVATE_FIELDS.has(key)) continue
      out[key] = value
    }
    return out
  }
  assertNoUnrepresentableCragFields(body)
  const isClassifier = requestContext?.purpose === 'auto_mode_classifier'
  const reuseHistory = !isSmallTextTurn(body) && !isClassifier
  const normalized = canonicalRequest(body, {
    reuseCanonicalHistory: reuseHistory,
    preserveConsecutiveUser: isClassifier,
  })
  if (needsCragProviderCompatibility(normalized, health?.capabilities) && normalized.crag_prompt != null) {
    invalid('crag_prompt', 'provider compatibility requests must use system instead')
  }
  const { body: out } = sanitizeCragBodyWhitelist(normalized, {
    capabilities: health?.capabilities,
    health,
    preserveCanonicalHistory: reuseHistory,
    toolsNormalized: true,
    safeguardsSanitized,
  })
  if (out.crag_options != null) {
    if (!object(out.crag_options)) invalid('crag_options', 'must be an object')
    const aliases = Object.fromEntries(Object.entries(out.crag_options).filter(([key]) => CRAG_ALIASES.has(key)))
    if (Object.keys(aliases).length) out.crag_options = aliases
    else delete out.crag_options
  }
  if (!out.messages.some((message) => message.role === 'user')) invalid('messages', 'must include a user turn')
  return out
}
