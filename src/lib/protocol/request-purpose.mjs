import { findClaudeSecurityMonitorPrompt } from '../identity/crs-persona.mjs'
import { getModelEntry, validateBetweenToolsThinking } from './model-policy.mjs'
import { officialMessagesBody } from './anthropic-messages.mjs'
import { stripIllegalCacheControlFields } from './cache-ttl.mjs'

function textOf(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((b) => (b?.type === 'text' ? b.text : '')).join('') : ''
}

const TRANSCRIPT_OPEN = '<transcript>'
const TRANSCRIPT_CLOSE = '</transcript>'
// The action is a compact tool record (plain or JSONL), never a user turn.
const ACTION_RE = /^(?:(?!User:)[A-Za-z][\w.:-]* [^\n]+|\{(?!"user":)"[^"\n]+":)/

function isClassifyResultContract(body) {
  const schema = body.tools?.find((t) => t?.name === 'classify_result')?.input_schema
  return (
    body.tool_choice?.type === 'tool' &&
    body.tool_choice.name === 'classify_result' &&
    schema?.type === 'object' &&
    schema.properties?.shouldBlock?.type === 'boolean' &&
    ['thinking', 'reason'].every((k) => schema.properties?.[k]?.type === 'string') &&
    ['thinking', 'reason', 'shouldBlock'].every((k) => schema.required?.includes(k))
  )
}

// Diagnostic label only; the client's suffix text is flag-controlled, so stage
// comes from wire parameters: only two-stage stage 1 sets a stop sequence.
function xmlStage(body, suffix) {
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) return 'xml_s1'
  if (suffix.includes('<thinking>')) return 'xml_s2'
  return suffix.trim() ? 'fast' : undefined
}

/**
 * Purpose is derived from the original contract, never from a public header/context.
 * Recognition uses the classifier rule sections only. The verdict format
 * (`<block>`, `<severity>`, …) changes with client version and server flags and
 * only decides how the body is relayed: forced classify_result is `tool`,
 * anything else wrapped in `<transcript>` is a text verdict (`xml`).
 */
export function classifyClaudeRequestPurpose(body, { officialTraffic = false } = {}) {
  if (!officialTraffic) return null
  if (!findClaudeSecurityMonitorPrompt(body?.system)) return null
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (messages.at(-1)?.role !== 'user') return null
  // Clients may send each transcript block as its own user message.
  const content = messages.map((m) => textOf(m?.content)).join('')
  const close = content.lastIndexOf(TRANSCRIPT_CLOSE)
  const open = close < 0 ? -1 : content.lastIndexOf(TRANSCRIPT_OPEN, close)
  const transcript = open < 0 ? content : content.slice(open + TRANSCRIPT_OPEN.length, close)
  if (!ACTION_RE.test(transcript.trim().split('\n').at(-1) || '')) return null
  if (body.tool_choice !== undefined) {
    return isClassifyResultContract(body) ? { purpose: 'auto_mode_classifier', format: 'tool' } : null
  }
  if (open < 0) return null
  const context = { purpose: 'auto_mode_classifier', format: 'xml' }
  const stage = xmlStage(body, content.slice(close + TRANSCRIPT_CLOSE.length))
  if (stage) context.stage = stage
  return context
}

function incompatible(message, code = 'classifier_model_incompatible') {
  const error = new Error(message)
  error.status = 400
  error.body = { type: 'error', error: { type: 'invalid_request_error', code, message } }
  throw error
}

/** Both transports use this policy; repeated assembly never adds headroom twice. */
export function prepareClassifierBody(input, { stream = true } = {}) {
  const entry = getModelEntry(input.model)
  if (entry._heuristic) incompatible('Classifier model capabilities are unknown; specify a supported model explicitly.')
  if (input.max_tokens != null && (!Number.isInteger(input.max_tokens) || input.max_tokens <= 0))
    incompatible('Classifier max_tokens must be a positive integer.')
  let body = officialMessagesBody(input, { stream })
  body.model = entry.id
  const alwaysOn = entry.capabilities.requires_adaptive === true
  if (body.thinking && !['disabled', 'adaptive', 'enabled', 'between_tools'].includes(body.thinking.type))
    incompatible('Invalid classifier thinking configuration.')
  validateBetweenToolsThinking(body, { code: 'classifier_model_incompatible' })
  if (body.thinking?.type === 'adaptive' && !entry.capabilities.supports_adaptive)
    incompatible('The selected classifier model does not support adaptive thinking.')
  if (
    body.thinking?.type === 'enabled' &&
    (!Number.isInteger(body.thinking.budget_tokens) ||
      body.thinking.budget_tokens < 1024 ||
      body.thinking.budget_tokens >= body.max_tokens)
  )
    incompatible('Classifier thinking budget must be at least 1024 and below max_tokens.')
  if (body.output_config?.effort != null && !entry.capabilities.supports_effort)
    incompatible('The selected classifier model does not support output effort.')
  if (alwaysOn && ['tool', 'any', 'required'].includes(body.tool_choice?.type)) {
    incompatible('The selected classifier model requires thinking and cannot honor forced classify_result tool choice.')
  }
  const cap = Number(entry.params.max_tokens_cap)
  if (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0 || body.max_tokens > cap)
    incompatible('Classifier max_tokens exceeds the selected model budget.')
  if (alwaysOn && body.thinking?.type === 'disabled') {
    if (body.max_tokens + 2048 > cap) incompatible('Classifier thinking headroom exceeds the selected model budget.')
    body.thinking = { type: 'adaptive' }
    body.max_tokens += 2048
  }
  if (alwaysOn && body.thinking?.type === 'enabled')
    incompatible('The selected classifier model requires adaptive thinking.')
  if (alwaysOn || ['enabled', 'adaptive'].includes(body.thinking?.type)) {
    delete body.temperature
    delete body.top_p
    delete body.top_k
    if (body.tool_choice?.type === 'tool')
      incompatible('Forced classifier tool choice cannot be combined with thinking.')
  }
  const blocks = [
    ...(body.tools || []),
    ...(Array.isArray(body.system) ? body.system : []),
    ...(body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
  ]
  let markers = body.cache_control ? 1 : 0
  let short = false
  for (const block of blocks) {
    if (!block.cache_control) continue
    if (['thinking', 'redacted_thinking'].includes(block.type)) {
      delete block.cache_control
      continue
    }
    const { type, ttl } = block.cache_control
    if (type !== 'ephemeral' || (ttl != null && !['5m', '1h'].includes(ttl)))
      incompatible('Invalid classifier cache control.', 'classifier_invalid_cache')
    if (short && ttl === '1h') incompatible('Classifier cache TTL must place 1h before 5m.', 'classifier_invalid_cache')
    if (ttl !== '1h') short = true
    markers++
  }
  if (markers > 4) incompatible('Classifier cache control exceeds four breakpoints.', 'classifier_invalid_cache')
  body = stripIllegalCacheControlFields(body)
  return body
}

export function classifierRequestSummary(input, output, context) {
  const fields = (body) => ({
    model: body.model,
    max_tokens: body.max_tokens,
    thinking: body.thinking?.type || 'absent',
    temperature: body.temperature ?? null,
    tool_choice: body.tool_choice?.type || null,
  })
  return {
    ...context,
    layer: 'node_object',
    wire_observed: false,
    before: fields(input),
    after: fields(output),
    reason:
      input.thinking?.type === 'disabled' && output.thinking?.type === 'adaptive'
        ? 'model_requires_adaptive_headroom_2048'
        : 'preserve_classifier_contract',
  }
}
