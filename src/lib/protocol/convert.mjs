/**
 * Protocol conversion — passthrough-first.
 * Tools: OpenAI function tools ↔ Claude tools
 * Streaming: Claude SSE events → OpenAI Chat chunks / Responses events
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  appendLiftedSystemMessage,
  applyStructuredOutput,
  canonicalizeClaudeMessagesShape,
  mergeConsecutiveAnthropicMessages,
  openaiResponseFormatToOutputConfig,
  sanitizeAnthropicBody,
} from './sanitize.mjs'
import {
  defaultMaxTokensForModel,
  getCapabilities,
  hasForcedToolChoice,
  normalizeThinkingByPolicy,
} from './model-policy.mjs'
import { inboundHasOpenAIToolShape } from '../identity/crs-persona.mjs'
import { openaiReasoningToClaudeThinking, claudeThinkingToOpenAIReasoning } from './thinking.mjs'
import { openaiContentToClaudeContent, openaiImagePartToClaude } from './images.mjs'
import { remapCodexTools } from './codex-tools.mjs'
import { ensureOutputConfigSchema } from './request-rectifier.mjs'
import { CLAUDE_WEB_SEARCH_TOOL, isVersionedAnthropicServerTool, isWebSearchTool } from './web-search.mjs'
import { normalizeToolInputSchema } from './tool-input-schema.mjs'
import {
  extractOpenaiUsage,
  isOpenaiWireUsage,
  mergeUsage,
  openaiChatUsageFromExtract,
  reasoningTokensOf,
} from './openai-usage.mjs'

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

function withCacheControl(node, source) {
  const control = source?.cache_control
  if (!control || !node || typeof node !== 'object') return node
  return { ...node, cache_control: control }
}

function eagerFlagOf(source) {
  if (typeof source?.eager_input_streaming === 'boolean') return source.eager_input_streaming
  if (typeof source?.function?.eager_input_streaming === 'boolean') return source.function.eager_input_streaming
  return undefined
}

function withEagerInputStreaming(node, source) {
  const eager = eagerFlagOf(source)
  if (typeof eager !== 'boolean' || !node || typeof node !== 'object') return node
  return { ...node, eager_input_streaming: eager }
}

/** No aliases. Model must already be an official Claude id (validated upstream). */
export function mapModel(m, { allowMap = false } = {}) {
  const s = String(m || '').trim()
  if (!s) return DEFAULT_MODEL
  // Never remap third-party names
  return s
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p
        if (p?.type === 'text' || p?.type === 'input_text' || p?.type === 'output_text') return p.text || ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return content?.text || ''
}

function appendCompatibleServerTool(out, tool) {
  if (isVersionedAnthropicServerTool(tool)) {
    const defaultIndex = /^web_search_\d{8}$/.test(tool.type) ? out.indexOf(CLAUDE_WEB_SEARCH_TOOL) : -1
    if (defaultIndex < 0) out.push(tool)
    else out[defaultIndex] = tool
    return true
  }
  if (['function', 'custom'].includes(tool?.type) || !isWebSearchTool(tool)) return false
  if (!out.some(isWebSearchTool)) out.push(CLAUDE_WEB_SEARCH_TOOL)
  return true
}

/** OpenAI tools → Claude tools. Native definitions take precedence over OpenAI search aliases. */
export function openaiToolsToClaude(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined
  const out = []
  for (const t of remapCodexTools(tools)) {
    if (!t) continue
    if (appendCompatibleServerTool(out, t)) continue
    if (!(t.type === 'function' || t.function || t.name)) continue
    if (t.type === 'function' && t.function) {
      if (!t.function.name) continue
      out.push(
        withEagerInputStreaming(
          withCacheControl(
            {
              name: t.function.name,
              description: t.function.description || '',
              input_schema: t.function.parameters || { type: 'object', properties: {} },
              ...(typeof t.function.strict === 'boolean' ? { strict: t.function.strict } : {}),
            },
            t.function.cache_control ? t.function : t,
          ),
          t,
        ),
      )
      continue
    }
    if (t.name && t.input_schema) {
      out.push(t)
      continue
    }
    const name = t.name || t.function?.name
    if (!name) continue
    out.push(
      withEagerInputStreaming(
        withCacheControl(
          {
            name,
            description: t.description || '',
            input_schema: t.input_schema || t.parameters || { type: 'object', properties: {} },
            ...(typeof t.strict === 'boolean' ? { strict: t.strict } : {}),
          },
          t,
        ),
        t,
      ),
    )
  }
  return out.length ? out : undefined
}

export { applyStructuredOutput, openaiResponseFormatToOutputConfig }

export function claudeStopReasonToOpenAIFinish(stopReason) {
  const sr = String(stopReason || '')
  if (sr === 'tool_use') return 'tool_calls'
  if (sr === 'max_tokens') return 'length'
  if (sr === 'refusal') return 'content_filter'
  return 'stop'
}

export function claudeRefusalText(claude = {}) {
  const parts = []
  for (const b of claude.content || []) {
    if (b?.type === 'refusal') parts.push(b.refusal || b.text || '')
  }
  return parts.filter(Boolean).join('\n') || null
}

export function claudeHasVisibleOutput(claude = {}) {
  for (const b of claude.content || []) {
    if (b?.type === 'text' && String(b.text || '').trim()) return true
    if (b?.type === 'tool_use') return true
  }
  return false
}

export function isClaudeRefusalStop(claude = {}) {
  return String(claude.stop_reason || '') === 'refusal'
}

/** OpenAI-compat: do not leave refusal as a silent empty completion. */
export function applyOpenAIRefusalFields(message, claude) {
  const refusal = claudeRefusalText(claude)
  if (refusal) message.refusal = refusal
  if (isClaudeRefusalStop(claude) && !String(message.content || '').trim() && !message.tool_calls) {
    message.content = refusal || '[content_filter]'
    if (!message.refusal) message.refusal = message.content
  }
  return message
}

/** OpenAI tool_choice → Claude */
export function openaiToolChoiceToClaude(toolChoice) {
  if (toolChoice == null) return undefined
  if (toolChoice === 'auto') return { type: 'auto' }
  if (toolChoice === 'none') return { type: 'none' }
  if (toolChoice === 'required') return { type: 'any' }
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    return { type: 'tool', name: toolChoice.function?.name || toolChoice.name }
  }
  return undefined
}

/** Convert OpenAI-style messages including tool / tool_calls to Claude blocks */
function openaiMessagesToClaude(messages) {
  const systemParts = []
  const out = []

  for (const m of messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      appendLiftedSystemMessage(systemParts, out, m)
      continue
    }

    if (m.role === 'tool') {
      // tool result
      const block = withCacheControl(
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id || m.id || 'tool_unknown',
          content: contentToText(m.content),
        },
        m,
      )
      // append to last user message or create user message
      if (out.length && out[out.length - 1].role === 'user' && Array.isArray(out[out.length - 1].content)) {
        out[out.length - 1].content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }

    if (m.role === 'assistant') {
      // Keep each text/cache boundary before appending tool calls. Flattening
      // an assistant turn discards controls just as it does for system turns.
      const parts = Array.isArray(m.content) ? m.content : [m.content]
      const content = parts.flatMap((part) => {
        const text = contentToText(Array.isArray(m.content) ? [part] : part)
        return text ? [withCacheControl({ type: 'text', text }, part)] : []
      })
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          let input = {}
          try {
            input =
              typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments || '{}')
                : tc.function?.arguments || {}
          } catch {
            input = { raw: tc.function?.arguments }
          }
          content.push({
            type: 'tool_use',
            id: tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
            name: tc.function?.name || tc.name,
            input,
          })
        }
      }
      if (!content.length) content.push({ type: 'text', text: '' })
      out.push({ role: 'assistant', content })
      continue
    }

    // user (text + optional images) — always blocks so cache stamps share a hang point
    const content = openaiContentToClaudeContent(m.content)
    const role = 'user'
    const last = out[out.length - 1]
    if (last?.role === role && Array.isArray(last.content) && Array.isArray(content)) {
      last.content = last.content.concat(content)
    } else {
      out.push({ role, content })
    }
  }

  if (out.length && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '' })
  }
  return { systemParts, messages: out }
}

/** Anthropic hop is always SSE. Client stream vs JSON is decided after the worker. */
function withUpstreamStream(claude) {
  if (claude && typeof claude === 'object') claude.stream = true
  return claude
}

/**
 * Downstream SSE only when the caller asked for it.
 * Anthropic / OpenAI default: omitted `stream` is JSON. NewAPI health probes
 * omit the field (Go omitempty) and then json.Unmarshal the body — SSE
 * (`event:…`) becomes `invalid character 'e' looking for beginning of value`.
 * An omitted `stream` streams only when Accept prefers SSE over JSON. Claude
 * Code 2.1.311+ sends `Accept: application/json, text/event-stream` on its
 * non-streaming auto-mode classifier and still parses the reply as JSON.
 */
export function isClientStream(body, headers = {}) {
  if (body?.stream === false || body?.stream === 0 || body?.stream === 'false') return false
  if (body?.stream === true || body?.stream === 1 || body?.stream === 'true') return true
  const accept = String(headers?.accept || headers?.Accept || '')
  const sse = acceptQuality(accept, 'text/event-stream')
  return sse > 0 && sse > acceptQuality(accept, 'application/json')
}

/** Highest q-value an Accept header gives `type` (exact media range only); -1 when absent. */
function acceptQuality(accept, type) {
  let best = -1
  for (const part of accept.toLowerCase().split(',')) {
    const [range, ...params] = part.split(';').map((s) => s.trim())
    if (range !== type) continue
    const q = params.find((p) => p.startsWith('q='))
    const value = q ? Number(q.slice(2)) : 1
    if (Number.isFinite(value) && value > best) best = value
  }
  return best
}

/** Lift OpenAI function tools onto Anthropic Messages without treating the hop as official CC. */
export function normalizeOpenAIToolsOnMessages(body) {
  if (!body || typeof body !== 'object' || !inboundHasOpenAIToolShape(body)) return body
  const out = { ...body }
  const tools = openaiToolsToClaude(body.tools)
  if (tools) out.tools = tools
  const choice = openaiToolChoiceToClaude(body.tool_choice)
  if (choice) out.tool_choice = choice
  return out
}

export function toClaudeMessages(protocol, body, opts = { rewrite: false, model_map: true }) {
  if (protocol === 'anthropic.messages' && !opts.rewrite) {
    const normalized = normalizeOpenAIToolsOnMessages(body)
    const out = sanitizeAnthropicBody(normalized, {
      preserveContentShape: opts.preserve_content_shape === true,
      onSystemBlock: opts.onSystemBlock,
    })
    if (!out.max_tokens) out.max_tokens = defaultMaxTokensForModel(out.model)
    return { claude: withUpstreamStream(out), mode: inboundHasOpenAIToolShape(body) ? 'convert' : 'passthrough' }
  }

  if (protocol === 'anthropic.messages' && opts.rewrite) {
    return {
      claude: withUpstreamStream({
        ...normalizeOpenAIToolsOnMessages(body),
        model: mapModel(body.model || DEFAULT_MODEL, { allowMap: opts.model_map }),
        max_tokens:
          body.max_tokens ||
          defaultMaxTokensForModel(mapModel(body.model || DEFAULT_MODEL, { allowMap: opts.model_map })),
      }),
      mode: 'rewrite',
    }
  }

  if (protocol === 'openai.chat') {
    return { claude: withUpstreamStream(openaiToClaude(body, opts)), mode: opts.rewrite ? 'rewrite' : 'convert' }
  }
  if (protocol === 'openai.completions') {
    return { claude: withUpstreamStream(completionsToClaude(body, opts)), mode: opts.rewrite ? 'rewrite' : 'convert' }
  }
  if (protocol === 'openai.responses') {
    const { claude, responseTools } = responsesToClaude(body, opts)
    return { claude: withUpstreamStream(claude), responseTools, mode: opts.rewrite ? 'rewrite' : 'convert' }
  }
  throw new Error(`unsupported protocol: ${protocol}`)
}

function openaiToClaude(body, opts) {
  const { systemParts, messages } = openaiMessagesToClaude(body.messages || [])
  const out = {
    model: mapModel(body.model, { allowMap: opts.model_map !== false }),
    max_tokens: body.max_tokens || body.max_completion_tokens || defaultMaxTokensForModel(body.model),
    messages,
  }
  if (systemParts.length) out.system = systemParts
  if (body.temperature != null) out.temperature = body.temperature
  if (body.top_p != null) out.top_p = body.top_p
  if (body.stop != null) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop]
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop_sequences = body.stop_sequences
  const tools = openaiToolsToClaude(body.tools)
  if (tools?.length) out.tools = tools
  const tc = openaiToolChoiceToClaude(body.tool_choice)
  if (tc) out.tool_choice = tc
  const thinking = openaiReasoningToClaudeThinking(body)
  if (thinking) out.thinking = thinking
  applyStructuredOutput(out, body)
  if (body.stream) out.stream = true
  return canonicalizeClaudeMessagesShape(out)
}

/** Legacy OpenAI /v1/completions (prompt, not messages). */
function completionsToClaude(body, opts) {
  const prompt = Array.isArray(body.prompt)
    ? body.prompt.map((p) => (typeof p === 'string' ? p : String(p ?? ''))).join('\n')
    : body.prompt == null
      ? ''
      : String(body.prompt)
  const suffix = body.suffix ? String(body.suffix) : ''
  const user = suffix ? `${prompt}${suffix}` : prompt
  return openaiToClaude(
    {
      ...body,
      messages: [{ role: 'user', content: user || 'Hello' }],
    },
    opts,
  )
}

const RESPONSES_THINKING_PREFIX = 'anthropic-thinking-v1:'

function responsesThinkingBlock(block) {
  if (
    block?.type === 'thinking' &&
    typeof block.thinking === 'string' &&
    typeof block.signature === 'string' &&
    block.signature
  ) {
    return { type: 'thinking', thinking: block.thinking, signature: block.signature }
  }
  if (block?.type === 'redacted_thinking' && typeof block.data === 'string' && block.data) {
    return { type: 'redacted_thinking', data: block.data }
  }
  return null
}

function decodeResponsesThinking(value, param) {
  if (typeof value !== 'string' || !value.startsWith(RESPONSES_THINKING_PREFIX)) return null
  let block
  try {
    block = responsesThinkingBlock(
      JSON.parse(Buffer.from(value.slice(RESPONSES_THINKING_PREFIX.length), 'base64').toString('utf8')),
    )
  } catch {
    invalidResponses(param, 'invalid Anthropic thinking envelope')
  }
  if (!block) invalidResponses(param, 'invalid Anthropic thinking block')
  return block
}

function invalidResponses(param, reason) {
  const message = `${param}: ${reason}`
  const code = 'invalid_responses_conversion'
  throw Object.assign(new Error(message), {
    status: 400,
    code,
    body: { type: 'error', error: { type: 'invalid_request_error', code, param, message } },
  })
}

function responsesContent(content, param) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) invalidResponses(param, 'must be text or content blocks')
  return content.flatMap((part, index) => {
    if (typeof part === 'string') return part ? [{ type: 'text', text: part }] : []
    if (['input_text', 'output_text', 'text', 'refusal'].includes(part?.type)) {
      const text = part.text ?? part.refusal
      if (typeof text === 'string') return text ? [withCacheControl({ type: 'text', text }, part)] : []
    }
    if (part?.type === 'input_image') {
      const image = openaiImagePartToClaude({ type: 'image_url', image_url: part.image_url })
      if (image) return [withCacheControl(image, part)]
    }
    return invalidResponses(`${param}[${index}]`, 'unsupported content for Claude')
  })
}

function responsesToolName(tool) {
  const name = tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name
  if (typeof name !== 'string' || !name) return name
  if (/^[A-Za-z0-9_-]{1,59}$/.test(name) && !/_[0-9a-f]{12}$/.test(name)) return name
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 12)
  return `${name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 46)}_${hash}`
}

function responsesToClaude(body, opts) {
  if (body.previous_response_id != null || body.conversation != null) {
    invalidResponses('input', 'provide full input history instead of a remote response or conversation reference')
  }
  const responseTools = new Map()
  const tools = []
  const addTool = (tool, namespace, path, discovered) => {
    if (appendCompatibleServerTool(tools, tool)) return
    const search = tool?.type === 'tool_search' && tool.execution === 'client'
    const definition = search
      ? { ...tool, name: 'tool_search' }
      : tool?.type === 'function'
        ? (tool.function ?? tool)
        : tool
    const scope = namespace ?? definition?.namespace
    const name = typeof definition?.name === 'string' && responsesToolName({ name: definition.name, namespace: scope })
    if (!name || (!search && !['function', 'custom'].includes(tool?.type))) {
      invalidResponses('tools', 'expected unique function or custom tools with Claude-compatible names')
    }
    const previous = responseTools.get(name)
    if (previous) {
      if (
        discovered &&
        previous.type === tool.type &&
        previous.name === definition.name &&
        previous.namespace === scope
      )
        return name
      invalidResponses('tools', 'duplicate tool name')
    }
    let description = typeof definition.description === 'string' ? definition.description : ''
    if (tool.type === 'custom') {
      const format = tool.format
      if (format?.type && !['text', 'grammar'].includes(format.type))
        invalidResponses('tools.format', 'unsupported custom tool format')
      description = [description, 'Provide the complete free-form tool input in the input string.', format?.definition]
        .filter(Boolean)
        .join('\n\n')
    }
    const schema =
      tool.type === 'custom'
        ? {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
            additionalProperties: false,
          }
        : normalizeToolInputSchema(definition.parameters ?? { type: 'object' })
    if (!schema) {
      const param = definition === tool.function ? `${path}.function.parameters` : `${path}.parameters`
      invalidResponses(param, 'must be an object schema without unsupported root combinations')
    }
    responseTools.set(name, { type: tool.type, name: definition.name, namespace: scope })
    tools.push(
      withEagerInputStreaming(
        withCacheControl(
          {
            name,
            description,
            input_schema: schema,
            ...(typeof definition.strict === 'boolean' ? { strict: definition.strict } : {}),
          },
          definition.cache_control ? definition : tool,
        ),
        tool,
      ),
    )
    return name
  }
  const addTools = (source, path, discovered = false) => {
    if (!Array.isArray(source)) invalidResponses(path, 'must be an array')
    return source
      .flatMap((tool, index) => {
        const toolPath = `${path}[${index}]`
        if (tool?.type !== 'namespace') return [addTool(tool, undefined, toolPath, discovered)]
        if (typeof tool.name !== 'string' || !tool.name || !Array.isArray(tool.tools)) {
          invalidResponses('tools', 'namespace must have a name and tools')
        }
        return tool.tools.map((child, childIndex) =>
          addTool(child, tool.name, `${toolPath}.tools[${childIndex}]`, discovered),
        )
      })
      .filter(Boolean)
  }
  if (body.tools != null) addTools(body.tools, 'tools')
  if (body.instructions != null && typeof body.instructions !== 'string') {
    invalidResponses('instructions', 'must be text')
  }
  const systemParts = body.instructions ? [{ type: 'text', text: body.instructions }] : []
  const messages = []
  const input = body.input ?? body.messages
  const items = typeof input === 'string' ? [input] : input
  if (!Array.isArray(items) || !items.length) invalidResponses('input', 'must contain conversation history')
  let requestedEffort = body.reasoning?.effort ?? body.reasoning_effort
  let replied = false
  for (const [index, raw] of items.entries()) {
    const param = `input[${index}]`
    const item = typeof raw === 'string' ? { role: 'user', content: raw } : raw
    if (!item || typeof item !== 'object') invalidResponses(param, 'must be a conversation item')
    if (item.type === 'reasoning') {
      replied = true
      const block = decodeResponsesThinking(item.encrypted_content, param)
      if (block) messages.push({ role: 'assistant', content: [block] })
      continue
    }
    if (item.type === 'configuration_update') {
      if (item.reasoning?.effort != null) requestedEffort = item.reasoning.effort
      continue
    }
    if (['function_call', 'custom_tool_call', 'tool_search_call'].includes(item.type)) {
      replied = true
      if (item.encrypted_function_args?.length) invalidResponses(param, 'encrypted tool arguments cannot be replayed')
      const name =
        item.type === 'tool_search_call' ? 'tool_search' : typeof item.name === 'string' && responsesToolName(item)
      const id = item.call_id
      if (!/^[A-Za-z0-9_-]+$/.test(typeof id === 'string' ? id : '') || !/^[A-Za-z0-9_-]{1,64}$/.test(name || '')) {
        invalidResponses(param, 'tool call requires a valid call_id and name')
      }
      let args
      if (item.type === 'custom_tool_call' && typeof item.input === 'string') args = { input: item.input }
      if (item.type !== 'custom_tool_call') {
        try {
          args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments
        } catch {
          invalidResponses(`${param}.arguments`, 'must be a JSON object')
        }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) invalidResponses(param, 'invalid tool arguments')
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: args }] })
      continue
    }
    if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(item.type)) {
      const content =
        item.type === 'tool_search_output'
          ? [
              {
                type: 'text',
                text: `Tools now available: ${addTools(item.tools ?? [], `${param}.tools`, true).join(', ') || '(none)'}`,
              },
            ]
          : responsesContent(item.output, `${param}.output`)
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: item.call_id, content }] })
      continue
    }
    const role = item.type === 'agent_message' ? 'user' : item.role
    if (
      (item.type && !['message', 'agent_message'].includes(item.type)) ||
      !['system', 'developer', 'user', 'assistant'].includes(role)
    ) {
      invalidResponses(param, 'unsupported Responses item for Claude')
    }
    const content = responsesContent(item.content, `${param}.content`)
    if (!content.length) continue
    if (item.cache_control && !content.at(-1).cache_control) content.push(withCacheControl(content.pop(), item))
    if (role === 'system' || role === 'developer') {
      if (content.some((block) => block.type !== 'text')) invalidResponses(param, 'instructions must be text')
      if (!replied) appendLiftedSystemMessage(systemParts, messages, { content })
      else
        messages.push({
          role: 'user',
          content: content.map((block) => ({ ...block, text: `<system-reminder>\n${block.text}\n</system-reminder>` })),
        })
    } else {
      if (role === 'assistant') replied = true
      messages.push({ role, content })
    }
  }
  const history = mergeConsecutiveAnthropicMessages(messages)
  const ids = new Set()
  let pending = new Set()
  for (const message of history) {
    const next = new Set()
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        if (ids.has(block.id)) invalidResponses('input', 'duplicate tool call_id')
        next.add(block.id)
        ids.add(block.id)
      }
      if (block.type === 'tool_result' && !pending.delete(block.tool_use_id)) {
        invalidResponses('input', 'tool result has no matching call in the preceding assistant turn')
      }
    }
    if (pending.size) invalidResponses('input', 'tool call is missing its result')
    pending = next
    if (message.content.some((block) => block.type === 'tool_result')) {
      message.content = [
        ...message.content.filter((block) => block.type === 'tool_result'),
        ...message.content.filter((block) => block.type !== 'tool_result'),
      ]
    }
  }
  if (pending.size) invalidResponses('input', 'tool call is missing its result')
  if (
    !history.some(
      (message) =>
        message.role === 'user' && message.content.some((block) => block.type !== 'text' || block.text.trim()),
    )
  ) {
    invalidResponses('input', 'must include a non-empty user turn')
  }
  const out = {
    model: mapModel(body.model, { allowMap: opts.model_map !== false }),
    max_tokens: body.max_output_tokens ?? body.max_tokens ?? defaultMaxTokensForModel(body.model),
    messages: history,
  }
  if (!Number.isSafeInteger(out.max_tokens) || out.max_tokens < 1)
    invalidResponses('max_output_tokens', 'must be a positive integer')
  if (systemParts.length) out.system = systemParts
  if (tools.length) out.tools = tools
  const choice = body.tool_choice
  const tc = ['function', 'custom'].includes(choice?.type)
    ? { type: 'tool', name: responsesToolName(choice.function ?? choice) }
    : openaiToolChoiceToClaude(choice)
  if (choice != null && !tc) invalidResponses('tool_choice', 'unsupported choice for Claude')
  if (tc) out.tool_choice = tc
  if (body.parallel_tool_calls === false && tc?.type !== 'none' && tools.length) {
    out.tool_choice = { ...(tc || { type: 'auto' }), disable_parallel_tool_use: true }
  }
  const caps = getCapabilities(out.model)
  const effort = requestedEffort === 'minimal' ? 'low' : requestedEffort
  if (effort != null && !['none', 'off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    invalidResponses('reasoning.effort', 'unsupported reasoning effort')
  }
  const thinking = openaiReasoningToClaudeThinking({ reasoning_effort: effort })
  if (thinking) out.thinking = thinking
  applyStructuredOutput(out, body)
  if (thinking?.type === 'disabled' && caps.supports_between_tools && !hasForcedToolChoice(out)) {
    out.thinking = { type: 'between_tools' }
    out.output_config = { ...out.output_config, effort: 'low' }
  } else if (
    effort &&
    caps.supports_adaptive &&
    caps.supports_effort &&
    thinking?.type === 'enabled' &&
    !hasForcedToolChoice(out)
  ) {
    out.thinking = { type: 'adaptive' }
    out.output_config = { ...out.output_config, effort }
  }
  if (body.stream) out.stream = true
  normalizeThinkingByPolicy(out)
  for (const key of ['temperature', 'top_p']) {
    if (body[key] == null) continue
    if (typeof body[key] !== 'number' || !(body[key] >= 0 && body[key] <= 1))
      invalidResponses(key, 'must be between 0 and 1 for Claude')
    if (['adaptive', 'enabled'].includes(out.thinking?.type)) {
      if (body[key] !== 1 && !(key === 'top_p' && body[key] === 0.99))
        invalidResponses(key, 'non-default sampling is not supported with Claude thinking')
      if (key === 'top_p') continue
    }
    out[key] = body[key]
  }
  return { claude: ensureOutputConfigSchema(sanitizeAnthropicBody(out)), responseTools }
}

export function fromClaudeToOpenAIChat(claude, requestedModel, vmId, mode = 'convert') {
  const textParts = []
  const toolCalls = []
  for (const b of claude.content || []) {
    if (b.type === 'text') textParts.push(b.text || '')
    if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input || {}),
        },
      })
    }
  }
  const message = { role: 'assistant', content: textParts.join('') || null }
  const reasoning = claudeThinkingToOpenAIReasoning(claude)
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) {
    message.tool_calls = toolCalls
    if (!textParts.length) message.content = null
  }
  applyOpenAIRefusalFields(message, claude)
  const finish = claudeStopReasonToOpenAIFinish(claude.stop_reason)

  return {
    id: 'chatcmpl-' + (claude.id || 'kin'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || claude.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: chatUsage(claude.usage),
  }
}

/**
 * Claude usage → OpenAI Chat usage with cache detail
 * (sub2api apicompat ChatTokenDetails counterpart: cached_tokens / cache_creation_tokens).
 * Anthropic input is uncached; details are added to form inclusive prompt_tokens.
 * OpenAI-inclusive usage is passed through without adding cache again.
 * reasoning_tokens is a subset of completion_tokens and is never added to it.
 */
function chatUsage(usage) {
  if (isOpenaiWireUsage(usage)) {
    return (
      openaiChatUsageFromExtract(extractOpenaiUsage(usage)) || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      }
    )
  }
  const uncached = Number(usage?.input_tokens || 0)
  const cached = cacheReadTokens(usage)
  const created = cacheCreationTokens(usage)
  const prompt = uncached + cached + created
  const completion = Number(usage?.output_tokens || 0)
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  }
  const details = promptTokensDetails(usage)
  if (details) out.prompt_tokens_details = details
  const reasoning = reasoningTokensOf(usage)
  if (reasoning != null) out.completion_tokens_details = { reasoning_tokens: reasoning }
  return out
}

function cacheReadTokens(usage) {
  return Number(usage?.cache_read_input_tokens ?? usage?.cache_read_tokens) || 0
}

function cacheCreationTokens(usage) {
  return Number(usage?.cache_creation_input_tokens ?? usage?.cache_creation_tokens) || 0
}

function promptTokensDetails(usage) {
  const cached = cacheReadTokens(usage)
  const created = cacheCreationTokens(usage)
  if (!cached && !created) return null
  const details = {}
  if (cached) details.cached_tokens = cached
  if (created) details.cache_creation_tokens = created
  return details
}

function responsesOutputItem(block, tools, id = randomUUID().replaceAll('-', '')) {
  if (block.type === 'text' || block.type === 'refusal') {
    const part =
      block.type === 'text'
        ? { type: 'output_text', text: block.text || '', annotations: [] }
        : { type: 'refusal', refusal: block.refusal || block.text || '' }
    return { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [part] }
  }
  if (block.type === 'tool_use') {
    const tool = tools?.get(block.name)
    const fields = { call_id: block.id, name: tool?.name ?? block.name, status: 'completed' }
    if (tool?.namespace) fields.namespace = tool.namespace
    if (tool?.type === 'tool_search') {
      return {
        type: 'tool_search_call',
        id: `tsc_${id}`,
        call_id: block.id,
        execution: 'client',
        arguments: block.input ?? {},
        status: 'completed',
      }
    }
    if (tool?.type === 'custom') {
      return { type: 'custom_tool_call', id: `ctc_${id}`, ...fields, input: block.input?.input ?? '' }
    }
    return {
      type: 'function_call',
      id: `fc_${id}`,
      ...fields,
      arguments: JSON.stringify(block.input ?? {}),
      ...(tool?.namespace ? { encrypted_function_args: [] } : {}),
    }
  }
  const thinking = responsesThinkingBlock(block)
  if (thinking) {
    return {
      type: 'reasoning',
      id: `rs_${id}`,
      summary: [],
      encrypted_content:
        RESPONSES_THINKING_PREFIX + Buffer.from(JSON.stringify(thinking)).toString('base64').replace(/=+$/, ''),
    }
  }
  return null
}

function completedResponse(state, output, stopReason, usage) {
  const reason = stopReason === 'max_tokens' ? 'max_output_tokens' : stopReason === 'refusal' ? 'content_filter' : null
  return {
    id: state.id,
    object: 'response',
    created_at: state.createdAt,
    status: reason ? 'incomplete' : 'completed',
    incomplete_details: reason ? { reason } : null,
    model: state.model,
    output,
    output_text: output
      .flatMap((item) => item.content || [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text)
      .join(''),
    usage: responsesUsage(usage),
  }
}

export function fromClaudeToResponses(claude, requestedModel, vmId, _mode = 'convert', tools) {
  const state = createResponsesStreamState(requestedModel || claude.model, vmId, tools)
  const output = (claude.content || []).map((block) => responsesOutputItem(block, tools)).filter(Boolean)
  if (isClaudeRefusalStop(claude) && !output.length) {
    output.push(responsesOutputItem({ type: 'refusal', refusal: claudeRefusalText(claude) }))
  }
  return completedResponse(state, output, claude.stop_reason, claude.usage)
}

/** Claude usage → OpenAI Responses usage with input_tokens_details cache breakdown. */
function responsesUsage(usage) {
  if (isOpenaiWireUsage(usage)) {
    const extracted = extractOpenaiUsage(usage)
    const input = extracted?.input_tokens || 0
    const output = extracted?.output_tokens || 0
    const out = {
      input_tokens: input,
      output_tokens: output,
      total_tokens: extracted?.total_tokens ?? input + output,
    }
    if (extracted?.cached_tokens != null || extracted?.cache_write_tokens != null) {
      out.input_tokens_details = {}
      if (extracted.cached_tokens != null) out.input_tokens_details.cached_tokens = extracted.cached_tokens
      if (extracted.cache_write_tokens != null) {
        out.input_tokens_details.cache_creation_tokens = extracted.cache_write_tokens
      }
    }
    if (extracted?.reasoning_tokens != null) {
      out.output_tokens_details = { reasoning_tokens: extracted.reasoning_tokens }
    }
    return out
  }
  const uncached = Number(usage?.input_tokens || 0)
  const cached = cacheReadTokens(usage)
  const created = cacheCreationTokens(usage)
  const input = uncached + cached + created
  const output = Number(usage?.output_tokens || 0)
  const out = {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
  }
  const details = promptTokensDetails(usage)
  if (details) out.input_tokens_details = details
  const reasoning = reasoningTokensOf(usage)
  if (reasoning != null) out.output_tokens_details = { reasoning_tokens: reasoning }
  return out
}

// ---------- Streaming: Claude SSE → OpenAI Chat chunks ----------
export function createOpenAIChatStreamState(model, vmId) {
  return {
    id: 'chatcmpl-' + Math.random().toString(36).slice(2, 12),
    model,
    vmId,
    toolIndex: 0,
    toolMap: new Map(), // block index → tool call index
    sentRole: false,
    dataBuf: '',
  }
}

/** Reassemble Anthropic SSE JSON that may be split across lines. */
export function consumeClaudeSSEData(line, state) {
  if (!state || typeof state !== 'object') return null
  if (typeof state.dataBuf !== 'string') state.dataBuf = ''
  const raw = String(line ?? '').replace(/\r$/, '')

  if (raw.startsWith('event:') || raw.startsWith(':')) return null

  if (raw.startsWith('data:')) {
    const piece = raw.slice(5).trim()
    if (!piece || piece === '[DONE]') {
      state.dataBuf = ''
      return null
    }
    state.dataBuf = state.dataBuf ? `${state.dataBuf}\n${piece}` : piece
    return takeParsedSseData(state)
  }

  if (raw === '') {
    if (!state.dataBuf) return null
    const evt = takeParsedSseData(state)
    state.dataBuf = ''
    return evt
  }

  if (state.dataBuf) {
    state.dataBuf = `${state.dataBuf}\n${raw}`
    return takeParsedSseData(state)
  }
  return null
}

function takeParsedSseData(state) {
  try {
    const evt = JSON.parse(state.dataBuf)
    if (evt && typeof evt === 'object') {
      state.dataBuf = ''
      return evt
    }
  } catch {}
  return null
}

export function createClaudeMessageAssembler() {
  return { message: null, dataBuf: '' }
}

function ensureAssemblerMessage(state) {
  if (!state.message || typeof state.message !== 'object') {
    state.message = { type: 'message', role: 'assistant', content: [] }
  }
  if (!Array.isArray(state.message.content)) state.message.content = []
  return state.message
}

/** Fold Anthropic SSE into one Messages JSON for non-stream clients. */
export function applyClaudeSSELineToMessage(line, state) {
  const evt = consumeClaudeSSEData(line, state)
  if (!evt) return state.message

  if (evt.type === 'message_start' && evt.message) {
    const started = evt.message
    state.message = {
      ...started,
      type: started.type || 'message',
      role: started.role || 'assistant',
      content: Array.isArray(started.content) ? started.content.map((block) => ({ ...block })) : [],
    }
    return state.message
  }

  const message = ensureAssemblerMessage(state)

  if (evt.type === 'content_block_start' && evt.content_block) {
    const block = { ...evt.content_block }
    if (block.type === 'text' && block.text == null) block.text = ''
    if (block.type === 'thinking' && block.thinking == null) block.thinking = ''
    if (block.type === 'refusal' && block.refusal == null) block.refusal = ''
    const idx = Number.isInteger(evt.index) ? evt.index : message.content.length
    message.content[idx] = block
    return message
  }

  if (evt.type === 'content_block_delta' && evt.delta) {
    const idx = Number.isInteger(evt.index) ? evt.index : 0
    const block = message.content[idx]
    if (!block) return message
    if (evt.delta.type === 'text_delta') {
      block.text = (block.text || '') + (evt.delta.text || '')
    } else if (evt.delta.type === 'thinking_delta') {
      block.thinking = (block.thinking || '') + (evt.delta.thinking || '')
    } else if (evt.delta.type === 'signature_delta' && evt.delta.signature) {
      block.signature = evt.delta.signature
    } else if (evt.delta.type === 'input_json_delta') {
      block._inputJson = (block._inputJson || '') + (evt.delta.partial_json || '')
    } else if (evt.delta.type === 'refusal_delta') {
      block.refusal = (block.refusal || '') + (evt.delta.refusal || evt.delta.text || '')
    }
    return message
  }

  if (evt.type === 'content_block_stop') {
    const idx = Number.isInteger(evt.index) ? evt.index : 0
    const block = message.content[idx]
    if (block && typeof block._inputJson === 'string' && block._inputJson) {
      try {
        block.input = JSON.parse(block._inputJson)
      } catch {
        block.input = block.input || {}
      }
      delete block._inputJson
    }
    return message
  }

  if (evt.type === 'message_delta') {
    if (evt.delta?.stop_reason) message.stop_reason = evt.delta.stop_reason
    if (evt.delta && Object.prototype.hasOwnProperty.call(evt.delta, 'stop_sequence')) {
      message.stop_sequence = evt.delta.stop_sequence
    }
    if (evt.delta && Object.prototype.hasOwnProperty.call(evt.delta, 'stop_details')) {
      message.stop_details = evt.delta.stop_details
    }
    if (evt.delta && Object.prototype.hasOwnProperty.call(evt.delta, 'safeguard_results')) {
      message.safeguard_results = evt.delta.safeguard_results
    }
    if (evt.delta && Object.prototype.hasOwnProperty.call(evt.delta, 'diagnostics')) {
      message.diagnostics = evt.delta.diagnostics
    }
    if (evt.usage) message.usage = mergeUsage(message.usage, evt.usage)
  }
  return message
}

export function claudeSSELineToOpenAIChatChunks(line, state) {
  const evt = consumeClaudeSSEData(line, state)
  if (!evt) return []

  const chunks = []
  const base = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model,
  }

  if (evt.type === 'message_start') {
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    })
    state.sentRole = true
  }

  if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
    const idx = state.toolIndex++
    state.toolMap.set(evt.index, idx)
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: idx,
                id: evt.content_block.id,
                type: 'function',
                function: { name: evt.content_block.name, arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
  }

  if (
    evt.type === 'content_block_start' &&
    (evt.content_block?.type === 'thinking' || evt.content_block?.type === 'redacted_thinking')
  ) {
    // OpenAI-compat: announce reasoning channel
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { reasoning_content: '' }, finish_reason: null }],
    })
  }

  if (evt.type === 'content_block_delta') {
    if (evt.delta?.type === 'text_delta') {
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { content: evt.delta.text || '' }, finish_reason: null }],
      })
    }
    // Claude thinking → OpenAI-compat reasoning_content (原样文本)
    if (evt.delta?.type === 'thinking_delta') {
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { reasoning_content: evt.delta.thinking || '' }, finish_reason: null }],
      })
    }
    // signature kept as opaque delta for clients that want full fidelity
    if (evt.delta?.type === 'signature_delta' && evt.delta.signature) {
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { reasoning_signature: evt.delta.signature }, finish_reason: null }],
      })
    }
    if (evt.delta?.type === 'input_json_delta') {
      const idx = state.toolMap.get(evt.index) ?? 0
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: idx, function: { arguments: evt.delta.partial_json || '' } }] },
            finish_reason: null,
          },
        ],
      })
    }
    if (evt.delta?.type === 'refusal_delta') {
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: { refusal: evt.delta.refusal || evt.delta.text || '' },
            finish_reason: null,
          },
        ],
      })
    }
  }

  if (evt.type === 'content_block_start' && evt.content_block?.type === 'refusal') {
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: { refusal: evt.content_block.refusal || '' },
          finish_reason: null,
        },
      ],
    })
  }

  if (evt.type === 'message_delta') {
    const finish = claudeStopReasonToOpenAIFinish(evt.delta?.stop_reason)
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: evt.usage ? chatUsage(evt.usage) : undefined,
    })
  }

  return chunks
}

// ---------- Streaming: Claude SSE → OpenAI Responses-like events ----------
export function createResponsesStreamState(model, vmId, tools) {
  return {
    id: 'resp_' + randomUUID().replaceAll('-', ''),
    createdAt: Math.floor(Date.now() / 1000),
    model,
    vmId,
    tools,
    blocks: new Map(),
    output: [],
    sequence: 0,
    dataBuf: '',
  }
}

export function claudeSSELineToResponsesEvents(line, state) {
  const evt = consumeClaudeSSEData(line, state)
  if (!evt) return []
  const out = []
  const emit = (type, fields) => out.push({ type: `response.${type}`, sequence_number: state.sequence++, ...fields })
  if (evt.type === 'message_start') {
    state.usage = evt.message?.usage
    const response = { ...completedResponse(state, [], null), status: 'in_progress', usage: null }
    emit('created', { response })
    emit('in_progress', { response })
  } else if (evt.type === 'content_block_start' && evt.content_block) {
    const block = { ...evt.content_block }
    const id = randomUUID().replaceAll('-', '')
    const item = responsesOutputItem(block, state.tools, id)
    const entry = { block, id, arguments: '' }
    state.blocks.set(evt.index, entry)
    if (item && !['reasoning', 'tool_search_call'].includes(item.type)) {
      entry.index = state.output.push(null) - 1
      entry.itemId = item.id
      const started = { ...item, status: 'in_progress' }
      if (item.type === 'message') started.content = []
      if (item.type === 'function_call') started.arguments = ''
      if (item.type === 'custom_tool_call') started.input = ''
      emit('output_item.added', { output_index: entry.index, item: started })
      if (item.type === 'message') {
        emit('content_part.added', {
          output_index: entry.index,
          item_id: item.id,
          content_index: 0,
          part: item.content[0],
        })
      }
    }
  } else if (evt.type === 'content_block_delta') {
    const entry = state.blocks.get(evt.index)
    if (!entry) return out
    const { block } = entry
    const fields = { output_index: entry.index, item_id: entry.itemId }
    const delta = evt.delta
    if (delta?.type === 'input_json_delta') {
      entry.arguments += delta.partial_json || ''
      if (entry.itemId && state.tools?.get(block.name)?.type !== 'custom') {
        emit('function_call_arguments.delta', { ...fields, delta: delta.partial_json || '' })
      }
    } else if (delta?.type === 'text_delta' || delta?.type === 'refusal_delta') {
      const refusal = delta.type === 'refusal_delta'
      const key = refusal ? 'refusal' : 'text'
      const text = delta[key] || delta.text || ''
      block[key] = (block[key] || '') + text
      emit(`${refusal ? 'refusal' : 'output_text'}.delta`, { ...fields, content_index: 0, delta: text })
    } else if (delta?.type === 'thinking_delta') {
      block.thinking = (block.thinking || '') + (delta.thinking || '')
    } else if (delta?.type === 'signature_delta') {
      block.signature = delta.signature
    }
  } else if (evt.type === 'content_block_stop') {
    const entry = state.blocks.get(evt.index)
    if (!entry) return out
    state.blocks.delete(evt.index)
    const item = responsesOutputItem(entry.block, state.tools, entry.id)
    if (!item) return out
    const output_index = entry.index ?? state.output.length
    const fields = { output_index, item_id: item.id }
    if (item.type === 'message') {
      const [part] = item.content
      const key = part.type === 'refusal' ? 'refusal' : 'text'
      emit(`${part.type}.done`, { ...fields, content_index: 0, [key]: part[key] })
      emit('content_part.done', { ...fields, content_index: 0, part })
    } else if (item.type === 'function_call') {
      if (entry.arguments) item.arguments = entry.arguments
      else emit('function_call_arguments.delta', { ...fields, delta: item.arguments })
      emit('function_call_arguments.done', { ...fields, arguments: item.arguments })
    } else if (item.type === 'custom_tool_call') {
      if (entry.arguments) {
        try {
          const parsed = JSON.parse(entry.arguments)
          item.input = typeof parsed?.input === 'string' ? parsed.input : entry.arguments
        } catch {
          item.input = entry.arguments
        }
      }
      emit('custom_tool_call_input.delta', { ...fields, delta: item.input })
      emit('custom_tool_call_input.done', { ...fields, input: item.input })
    } else if (item.type === 'tool_search_call') {
      if (entry.arguments) {
        try {
          item.arguments = JSON.parse(entry.arguments)
        } catch {
          item.arguments = entry.arguments
        }
      }
      emit('output_item.added', { output_index, item: { ...item, status: 'in_progress' } })
    } else {
      emit('output_item.added', { output_index, item: { type: item.type, id: item.id, summary: [] } })
    }
    state.output[output_index] = item
    emit('output_item.done', { output_index, item })
  } else if (evt.type === 'message_delta') {
    state.stopReason = evt.delta?.stop_reason || state.stopReason
    if (evt.usage) state.usage = mergeUsage(state.usage, evt.usage)
  } else if (evt.type === 'message_stop') {
    const response = completedResponse(state, state.output.filter(Boolean), state.stopReason, state.usage)
    emit(response.status, { response })
  }
  return out
}

export function fromClaudeToOpenAICompletions(claude, requestedModel) {
  let text = (claude.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text || '')
    .join('')
  if (isClaudeRefusalStop(claude) && !String(text).trim()) {
    text = claudeRefusalText(claude) || '[content_filter]'
  }
  const finish = claudeStopReasonToOpenAIFinish(claude.stop_reason)
  return {
    id: 'cmpl-' + (claude.id || 'kin'),
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || claude.model,
    choices: [{ text, index: 0, finish_reason: finish, logprobs: null }],
    usage: chatUsage(claude.usage),
  }
}

export function createOpenAICompletionStreamState(model, vmId) {
  return {
    id: 'cmpl-' + Math.random().toString(36).slice(2, 12),
    model,
    vmId,
    chat: createOpenAIChatStreamState(model, vmId),
  }
}

export function claudeSSELineToOpenAICompletionChunks(line, state) {
  const chats = claudeSSELineToOpenAIChatChunks(line, state.chat)
  return chats
    .map((c) => ({
      id: state.id,
      object: 'text_completion',
      created: c.created,
      model: state.model,
      choices: [
        {
          text: c.choices?.[0]?.delta?.content || '',
          index: 0,
          finish_reason: c.choices?.[0]?.finish_reason ?? null,
          logprobs: null,
        },
      ],
    }))
    .filter((c) => c.choices[0].text || c.choices[0].finish_reason)
}
