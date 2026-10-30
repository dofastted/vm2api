import { repairAutoModeReminders } from './auto-mode-reminder.mjs'
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
  const config = out.output_config && typeof out.output_config === 'object' ? out.output_config : source.output_config
  if (config?.format) {
    out.output_config = config
    return out
  }
  const mapped =
    openaiResponseFormatToOutputConfig(source.response_format) ||
    openaiResponseFormatToOutputConfig(source.text?.format)
  if (mapped || config) out.output_config = { ...config, ...mapped }
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

/** Hang cache_control on a text block. Bare strings have nowhere to put it. */
export function promoteContentToBlocks(content) {
  if (content == null) return content
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return content
  return content.map((part) => (typeof part === 'string' ? { type: 'text', text: part } : part))
}

export function promoteSystemToBlocks(system) {
  if (system == null || system === '') return system
  if (typeof system === 'string') return [{ type: 'text', text: system }]
  if (!Array.isArray(system)) return system
  return system.map((block) => (typeof block === 'string' ? { type: 'text', text: block } : block))
}

/**
 * OpenAI chat / completions / responses collapse to strings; Anthropic keeps
 * blocks. Kernel restamp and applyCacheBreakpoints only hang markers on blocks,
 * so every inbound protocol must leave this shape before persona / hop.
 */
export function canonicalizeClaudeMessagesShape(body, { preserveContentShape = false } = {}) {
  if (!body || typeof body !== 'object') return body
  const out = { ...body }
  if (preserveContentShape) {
    if (Array.isArray(out.messages)) {
      out.messages = out.messages.map((message) => {
        if (!message || message.role === 'system' || typeof message.content !== 'string') return message
        return { ...message, content: [{ type: 'text', text: message.content }] }
      })
    }
    return out
  }
  if (out.system != null) out.system = promoteSystemToBlocks(out.system)
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!message || typeof message !== 'object') return message
      return { ...message, content: promoteContentToBlocks(message.content) }
    })
  }
  return out
}

export function sanitizeAnthropicBody(body, { strictPassthrough = false, preserveContentShape = false } = {}) {
  if (!body || typeof body !== 'object') return body
  if (strictPassthrough) {
    const out = { ...body }
    normalizeStop(out)
    return out
  }

  const out = copyOfficialAnthropicFields(body)
  applyStructuredOutput(out, body)

  if (!preserveContentShape && Array.isArray(out.system)) {
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
  normalizeStop(out)
  return canonicalizeClaudeMessagesShape(out, { preserveContentShape })
}

/**
 * Sub2API-style Messages repair before the Anthropic hop:
 *   - leading system / developer turns (before the first user) lift into top-level system
 *   - mid-conversation role:system after a user turn is kept when the model/beta allow it
 *   - unknown roles (admin, tool, function, …) become user
 *   - empty content is dropped
 *   - empty system / developer turns with `output_config.effort` stay in place on
 *     models that accept per-message effort (Opus 5.5 / 5, Sonnet 5.5, Haiku 5.5,
 *     Fable 5.1, Mythos 5.1). Lifting that value to top-level `output_config.effort`
 *     rewrites the cached prefix. Historical and trailing controls both stay;
 *     top-level effort is unchanged. Other models still drop the empty turn and
 *     copy only a trailing effort to the top-level field so they do not 400.
 *   - empty `clear_at` / no-control system turns are still dropped
 *   - consecutive same-role turns are merged (Anthropic requires alternation),
 *     except turns that still carry per-turn controls
 *   - the first remaining turn must be user, except a leading effort-only system
 *     control which the per-message effort beta allows as the first entry
 *   - a system turn that cannot be kept still contributes its effort the same way
 */
export function normalizeAnthropicMessages(body, { keepMidConversationSystem = true } = {}) {
  if (!body || !Array.isArray(body.messages)) return body
  repairAutoModeReminders(body)

  const keepMessageEffort = modelSupportsPerMessageEffort(body.model)
  const systemParts = []
  const mapped = []
  let seenUser = false
  let liftedContentEffort = null
  let trailingEmptyEffort = null
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') continue
    const role = String(message.role || '')
      .trim()
      .toLowerCase()
    const effort = messageOutputConfigEffort(message)
    if (role === 'system' || role === 'developer') {
      if (anthropicContentIsEmpty(message.content)) {
        if (keepMessageEffort && effort) {
          trailingEmptyEffort = null
          mapped.push(keptAnthropicMessage(message, 'system'))
          continue
        }
        if (effort) trailingEmptyEffort = effort
        continue
      }
      if (!seenUser || !keepMidConversationSystem) {
        appendLiftedSystemMessage(systemParts, mapped, message)
        if (effort) liftedContentEffort = effort
        continue
      }
      if (effort) {
        liftedContentEffort = null
        trailingEmptyEffort = null
      }
      mapped.push(keptAnthropicMessage(message, 'system'))
      continue
    }
    if (anthropicContentIsEmpty(message.content) && !messageHasTurnControls(message)) continue
    const nextRole = role === 'assistant' ? 'assistant' : 'user'
    if (nextRole === 'user') seenUser = true
    if (!keepMessageEffort) trailingEmptyEffort = null
    mapped.push(keptAnthropicMessage(message, nextRole))
  }

  const merged = mergeConsecutiveAnthropicMessages(mapped)
  if (merged.length && merged[0].role !== 'user' && !isEmptyEffortControl(merged[0])) {
    merged.unshift({ role: 'user', content: '.' })
  }

  body.messages = merged
  repairAutoModeReminders(body)
  if (systemParts.length) body.system = appendSystemParts(body.system, systemParts)
  if (!keepMessageEffort && (trailingEmptyEffort || liftedContentEffort)) {
    applyLiftedEffort(body, trailingEmptyEffort || liftedContentEffort)
  }
  return body
}

/**
 * Haiku / hops without mid-conversation-system: lift leftover role=system into top-level system.
 * Effort-only empty system turns stay when the model accepts per-message effort.
 * Other models drop them; a trailing one's effort is copied to top-level
 * `output_config.effort`; historical markers are not.
 */
export function liftMidConversationSystemMessages(body) {
  if (!body || !Array.isArray(body.messages)) return body
  return normalizeAnthropicMessages({ ...body, messages: body.messages.slice() }, { keepMidConversationSystem: false })
}

/**
 * Append lifted instructions to local output arrays without flattening blocks.
 * A leading system keeps its cache controls. For instructions lifted from the
 * middle of a conversation, keep their controls at the preceding history
 * boundary: moving a 5m control into system can put it before a message's 1h
 * control and make an otherwise valid request fail. Dedicated text anchors
 * preserve every control without overwriting existing markers or attaching one
 * to thinking. Instruction text still belongs to system, and tool results stay
 * first in the following user message. Empty per-turn controls remain untouched.
 */
export function appendLiftedSystemMessage(systemParts, messages, message) {
  const content = message.content
  const parts = Array.isArray(content) ? content : [content]
  const blocks = parts.flatMap((part) => {
    if (typeof part === 'string') return part ? [{ type: 'text', text: part }] : []
    if (!part || typeof part !== 'object' || typeof part.text !== 'string' || !part.text) return []
    if (part.type != null && !['text', 'input_text', 'output_text'].includes(part.type)) return []
    return [stripIllegalContentBlock({ ...part, type: 'text' })]
  })
  const previousIndex = messages.findLastIndex((item) => item.role === 'user' || item.role === 'assistant')
  const anchors = []
  for (const block of blocks) {
    if (previousIndex < 0 || !block.cache_control) {
      systemParts.push(block)
      continue
    }
    const { cache_control, ...instruction } = block
    systemParts.push(instruction)
    anchors.push({ type: 'text', text: '\u200b', cache_control })
  }
  if (anchors.length) {
    const previous = messages[previousIndex]
    messages[previousIndex] = { ...previous, content: [...asContentBlocks(previous.content), ...anchors] }
  }
}

function keptAnthropicMessage(message, role) {
  const next = { ...message, role }
  if (anthropicContentIsEmpty(next.content)) next.content = []
  return next
}

function messageOutputConfigEffort(message) {
  const effort = message?.output_config?.effort
  return typeof effort === 'string' && effort.trim() ? effort : null
}

function isEmptyEffortControl(message) {
  const role = String(message?.role || '')
    .trim()
    .toLowerCase()
  return (
    (role === 'system' || role === 'developer') &&
    anthropicContentIsEmpty(message?.content) &&
    !!messageOutputConfigEffort(message)
  )
}

/**
 * Claude API / Google Cloud per-message effort (beta mid-conversation-output-config-2026-07-01):
 * Fable 5.1, Mythos 5.1, Opus 5.5, Opus 5, Sonnet 5.5, Haiku 5.5.
 * Fable 5 and other models 400 if an empty system `output_config` is forwarded.
 */
function modelSupportsPerMessageEffort(modelId = '') {
  const id = String(modelId || '')
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/i, '')
  return /^claude-(?:(?:fable|mythos)-5[-.]1|opus-5(?:[-.]5)?|(?:sonnet|haiku)-5[-.]5)(?:-|$)/.test(id)
}

function applyLiftedEffort(body, effort) {
  if (body.output_config && typeof body.output_config === 'object') {
    body.output_config = { ...body.output_config, effort }
    return
  }
  body.output_config = { effort }
}

/**
 * Drop content-less system / developer turns that survived an earlier pass.
 * Effort-only empty turns stay on models that accept per-message effort.
 * Other models keep the trailing-effort lift: a later user/assistant turn
 * discards the marker; a trailing one replaces top-level effort.
 */
export function dropEmptySystemControlTurns(body) {
  if (!body || !Array.isArray(body.messages)) return body
  const keepMessageEffort = modelSupportsPerMessageEffort(body.model)
  const messages = []
  let effort = null
  let changed = false
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') {
      messages.push(message)
      continue
    }
    const role = String(message.role || '')
      .trim()
      .toLowerCase()
    if ((role === 'system' || role === 'developer') && anthropicContentIsEmpty(message.content)) {
      if (keepMessageEffort && messageOutputConfigEffort(message)) {
        effort = null
        messages.push(keptAnthropicMessage(message, 'system'))
        continue
      }
      changed = true
      const next = messageOutputConfigEffort(message)
      if (next) effort = next
      continue
    }
    if (role === 'user' || role === 'assistant') effort = null
    else if (messageOutputConfigEffort(message)) effort = null
    messages.push(message)
  }
  if (!changed) return body
  const out = { ...body, messages: mergeConsecutiveAnthropicMessages(messages) }
  if (!keepMessageEffort && effort) applyLiftedEffort(out, effort)
  return out
}

/** `output_config` / `clear_at` are per-turn controls, not content. */
export function messageHasTurnControls(message) {
  if (!message || typeof message !== 'object') return false
  if (message.clear_at != null) return true
  return message.output_config != null && typeof message.output_config === 'object'
}

export function anthropicContentIsEmpty(content) {
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

export function mergeConsecutiveAnthropicMessages(messages) {
  const out = []
  for (const message of messages) {
    const last = out[out.length - 1]
    if (!last || last.role !== message.role || messageHasTurnControls(last) || messageHasTurnControls(message)) {
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
  if (!parts.length) return existing
  if (existing == null || existing === '') return parts
  return [...promoteSystemToBlocks(existing), ...parts]
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
