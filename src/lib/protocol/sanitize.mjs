import { defaultMaxTokensForModel } from './model-policy.mjs'

/**
 * Sanitize Anthropic Messages body for official API.
 *
 * Credential-forwarding (sub2api-style): drop client-private / OpenAI leftover
 * keys, pass through unknown official fields such as output_config.
 */
const DROP_TOP = new Set([
  'settings',
  'claude_settings',
  'env',
  'user',
  'user_id',
  'extra_body',
  'extra_headers',
  'extra',
  'n',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'functions',
  'function_call',
  'response_format',
  'seed',
  'parallel_tool_calls',
  'reasoning_effort',
  'max_completion_tokens',
  'max_output_tokens',
  'store',
  'modalities',
  'audio',
  'prediction',
  'stream_options',
  'tool_resources',
  'instructions',
  'input',
  'truncation',
  'include',
  'previous_response_id',
  'reasoning',
  'prompt',
  'suffix',
  'best_of',
  'echo',
  'workspace',
  'rewrite',
  'frequencyPenalty',
  'presencePenalty',
  'logitBias',
  'functionCall',
  'responseFormat',
  'maxCompletionTokens',
  'parallelToolCalls',
  'toolResources',
  'streamOptions',
  'previousResponseId',
  'reasoningEffort',
  'session',
  'machine_id',
  'device_id',
  'account_uuid',
  'web_search',
])

/** Copy official Anthropic fields; drop client junk / OpenAI leftovers. */
export function copyOfficialAnthropicFields(body) {
  const out = {}
  for (const [k, v] of Object.entries(body || {})) {
    if (v === undefined) continue
    if (DROP_TOP.has(k)) continue
    out[k] = v
  }
  return out
}

/** OpenAI response_format / Responses text.format → Anthropic output_config. */
export function openaiResponseFormatToOutputConfig(responseFormat) {
  if (!responseFormat || typeof responseFormat !== 'object') return null
  const type = String(responseFormat.type || '').toLowerCase()
  if (type === 'json_schema') {
    const wrapper =
      responseFormat.json_schema && typeof responseFormat.json_schema === 'object'
        ? responseFormat.json_schema
        : responseFormat
    const schema = wrapper.schema || wrapper
    if (!schema || typeof schema !== 'object') return null
    const format = { type: 'json_schema', schema }
    if (wrapper.name) format.name = wrapper.name
    if (wrapper.description) format.description = wrapper.description
    return { format }
  }
  if (type === 'json_object') {
    return { format: { type: 'json_schema', schema: { type: 'object' } } }
  }
  return null
}

/** Promote leftover OpenAI structured-output fields before they are dropped. */
export function applyStructuredOutput(out, source = {}) {
  if (!out || typeof out !== 'object') return out
  if (out.output_config && typeof out.output_config === 'object') return out
  const mapped =
    openaiResponseFormatToOutputConfig(source.response_format) ||
    openaiResponseFormatToOutputConfig(source.text?.format)
  if (mapped) out.output_config = mapped
  return out
}

/** OpenAI / client leftovers Anthropic TextBlock rejects as Extra inputs. */
const DROP_CONTENT_KEYS = new Set(['annotations'])

/** Drop content-block fields the public Messages schema rejects (annotations, …). */
export function stripIllegalContentFields(content) {
  if (!Array.isArray(content)) return content
  return content.map((block) => stripIllegalContentBlock(block))
}

function stripIllegalContentBlock(block) {
  if (!block || typeof block !== 'object') return block
  let next = block
  for (const key of DROP_CONTENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) continue
    const { [key]: _drop, ...rest } = next
    next = rest
  }
  if (next.type === 'tool_result' && Array.isArray(next.content)) {
    const nested = stripIllegalContentFields(next.content)
    if (nested !== next.content) next = { ...next, content: nested }
  }
  return next
}

export function stripIllegalBodyContentFields(body) {
  if (!body || typeof body !== 'object') return body
  if (Array.isArray(body.system)) body.system = stripIllegalContentFields(body.system)
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) => {
      if (!message || !Array.isArray(message.content)) return message
      return { ...message, content: stripIllegalContentFields(message.content) }
    })
  }
  return body
}

export function sanitizeAnthropicBody(body, { strictPassthrough = false } = {}) {
  if (!body || typeof body !== 'object') return body
  if (strictPassthrough) {
    const out = { ...body }
    normalizeStop(out)
    return out
  }

  const out = copyOfficialAnthropicFields(body)
  applyStructuredOutput(out, body)

  if (Array.isArray(out.system)) {
    const blocks = out.system
      .map((b) => {
        if (typeof b === 'string') return { type: 'text', text: b }
        if (b && typeof b.text === 'string') {
          const block = { type: 'text', text: b.text }
          if (b.cache_control) block.cache_control = b.cache_control
          return block
        }
        return b && typeof b === 'object' ? b : null
      })
      .filter(Boolean)
    out.system = blocks
  }

  normalizeAnthropicMessages(out)
  stripIllegalBodyContentFields(out)

  if (Array.isArray(out.tools) && out.tools.length === 0) delete out.tools
  // Do not overwrite caller max_tokens (thinking budget). Only fill if missing.
  if (!out.max_tokens) out.max_tokens = defaultMaxTokensForModel(out.model)
  if (out.tool_choice && !out.tools) delete out.tool_choice
  normalizeStop(out)
  return out
}

/**
 * Sub2API-style Messages repair before the Anthropic hop:
 *   - leading system / developer turns (before the first user) lift into top-level system
 *   - mid-conversation role:system after a user turn is kept when the model/beta allow it
 *   - unknown roles (admin, tool, function, …) become user
 *   - empty content is dropped
 *   - consecutive same-role turns are merged (Anthropic requires alternation)
 *   - the first remaining turn must be user
 */
export function normalizeAnthropicMessages(body, { keepMidConversationSystem = true } = {}) {
  if (!body || !Array.isArray(body.messages)) return body

  const systemParts = []
  const mapped = []
  let seenUser = false
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') continue
    const role = String(message.role || '')
      .trim()
      .toLowerCase()
    if (role === 'system' || role === 'developer') {
      if (!seenUser || !keepMidConversationSystem) {
        const text = contentToPlainText(message.content)
        if (text) systemParts.push(text)
        continue
      }
      if (anthropicContentIsEmpty(message.content)) continue
      mapped.push({ ...message, role: 'system' })
      continue
    }
    if (anthropicContentIsEmpty(message.content)) continue
    const nextRole = role === 'assistant' ? 'assistant' : 'user'
    if (nextRole === 'user') seenUser = true
    mapped.push({
      ...message,
      role: nextRole,
    })
  }

  const merged = mergeConsecutiveAnthropicMessages(mapped)
  if (merged.length && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: '.' })
  }

  body.messages = merged
  if (systemParts.length) body.system = appendSystemParts(body.system, systemParts)
  return body
}

/** Haiku / hops without mid-conversation-system: lift leftover role=system into top-level system. */
export function liftMidConversationSystemMessages(body) {
  if (!body || !Array.isArray(body.messages)) return body
  return normalizeAnthropicMessages({ ...body, messages: body.messages.slice() }, { keepMidConversationSystem: false })
}

function contentToPlainText(content) {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') {
          return part.text || ''
        }
        return ''
      })
      .filter((text) => String(text).trim())
      .join('\n')
      .trim()
  }
  return String(content?.text || '').trim()
}

function anthropicContentIsEmpty(content) {
  if (content == null) return true
  if (typeof content === 'string') return !content.trim()
  if (!Array.isArray(content)) return false
  if (!content.length) return true
  return content.every((block) => {
    if (typeof block === 'string') return !block.trim()
    if (!block || typeof block !== 'object') return true
    if (block.type === 'text' || block.type == null) return !String(block.text || '').trim()
    return false
  })
}

function mergeConsecutiveAnthropicMessages(messages) {
  const out = []
  for (const message of messages) {
    const last = out[out.length - 1]
    if (!last || last.role !== message.role) {
      out.push({ ...message })
      continue
    }
    last.content = mergeAnthropicContent(last.content, message.content)
  }
  return out
}

function mergeAnthropicContent(left, right) {
  if (typeof left === 'string' && typeof right === 'string') return `${left}\n${right}`
  return [...asContentBlocks(left), ...asContentBlocks(right)]
}

function asContentBlocks(content) {
  if (content == null) return []
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content : []
}

function appendSystemParts(existing, parts) {
  const extra = parts.filter(Boolean)
  if (!extra.length) return existing
  const joined = extra.join('\n\n')
  if (existing == null || existing === '') return joined
  if (typeof existing === 'string') return `${existing}\n\n${joined}`
  if (Array.isArray(existing)) {
    return [...existing, ...extra.map((text) => ({ type: 'text', text }))]
  }
  return existing
}

function normalizeStop(out) {
  if (out.stop_sequences) {
    delete out.stop
    return
  }
  if (out.stop == null) return
  out.stop_sequences = Array.isArray(out.stop) ? out.stop : [out.stop]
  delete out.stop
}
