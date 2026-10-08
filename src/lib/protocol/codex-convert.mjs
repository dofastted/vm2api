/**
 * Convert OpenAI Chat/Completions (and optional Anthropic) bodies to Codex Responses.
 * Native openai.responses bodies pass through after identity strip.
 * Request/usage shapes follow codex-proxy-rs (system→developer, extract_usage).
 */
import { extractOpenaiUsage, openaiAnthropicUsageFromExtract, openaiChatUsageFromExtract } from './openai-usage.mjs'

const IDENTITY_KEYS = [
  'base_url',
  'custom_base_url',
  'endpoint',
  'hostname',
  'api_key',
  'authorization',
  'client_metadata',
]

export function stripCodexIdentity(body = {}) {
  if (!body || typeof body !== 'object') return {}
  const next = { ...body }
  for (const key of IDENTITY_KEYS) delete next[key]
  if (next.metadata && typeof next.metadata === 'object') {
    const metadata = { ...next.metadata }
    delete metadata.user_id
    delete metadata.device_id
    delete metadata.installation_id
    next.metadata = metadata
  }
  return next
}

function textParts(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content?.text || ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') return part.text || ''
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function imageUrlOf(part) {
  if (typeof part?.image_url === 'string') return part.image_url
  if (typeof part?.image_url?.url === 'string') return part.image_url.url
  if (typeof part?.url === 'string') return part.url
  return ''
}

function userContentParts(content) {
  if (typeof content === 'string') return content ? [{ type: 'input_text', text: content }] : []
  if (!Array.isArray(content)) {
    const text = content?.text || ''
    return text ? [{ type: 'input_text', text }] : []
  }
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) parts.push({ type: 'input_text', text: part })
      continue
    }
    if (!part || typeof part !== 'object') continue
    if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') {
      const url = imageUrlOf(part)
      if (url) parts.push({ type: 'input_image', image_url: url })
      continue
    }
    const text = part.text || ''
    if (text) parts.push({ type: 'input_text', text })
  }
  return parts
}

function toolArguments(call) {
  const raw = call?.function?.arguments ?? call?.arguments ?? '{}'
  return typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
}

/** Chat message → Responses items. Tool-only assistant turns stay function_call items, not empty text. */
function chatMessageToItems(message) {
  if (!message || typeof message !== 'object') return []
  if (message.role === 'tool') {
    const output = typeof message.content === 'string' ? message.content : textParts(message.content)
    return [
      {
        type: 'function_call_output',
        call_id: message.tool_call_id || message.id || 'call_unknown',
        output: output || '',
      },
    ]
  }
  if (message.role === 'assistant') {
    const items = []
    const text = textParts(message.content)
    if (text) {
      items.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      })
    }
    for (const call of message.tool_calls || []) {
      const name = call?.function?.name || call?.name
      if (!name) continue
      items.push({
        type: 'function_call',
        call_id: call.id || call.call_id || `call_${name}`,
        name,
        arguments: toolArguments(call),
      })
    }
    return items
  }
  const role = message.role === 'system' || message.role === 'developer' ? 'developer' : 'user'
  const parts = userContentParts(message.content)
  if (!parts.length) return []
  return [{ type: 'message', role, content: parts }]
}

const RESPONSES_CHOICE_MODES = new Set(['none', 'auto', 'required'])

/** Responses requires tool_choice.name at the top level. Chat nests it under function.name. */
export function responsesToolChoice(choice) {
  if (choice == null || choice === false || choice === '') return undefined
  if (typeof choice === 'string') {
    const mode = choice.trim().toLowerCase()
    if (mode === 'any') return 'required'
    if (RESPONSES_CHOICE_MODES.has(mode)) return mode
    return undefined
  }
  if (typeof choice !== 'object' || Array.isArray(choice)) return undefined

  const type = String(choice.type || '').toLowerCase()
  const name = String(choice.name || choice.function?.name || '').trim()

  if (type === 'none' || type === 'auto' || type === 'required') return type
  if (type === 'any') return 'required'

  if (type === 'allowed_tools') {
    const tools = (Array.isArray(choice.tools) ? choice.tools : [])
      .map((tool) => {
        if (!tool || typeof tool !== 'object') return null
        const toolName = String(tool.name || tool.function?.name || '').trim()
        if (tool.type === 'function' || tool.function) {
          return toolName ? { type: 'function', name: toolName } : null
        }
        return tool
      })
      .filter(Boolean)
    const mode = String(choice.mode || 'auto').toLowerCase() === 'required' ? 'required' : 'auto'
    return tools.length ? { type: 'allowed_tools', mode, tools } : mode
  }

  if (type === 'function' || type === 'tool' || type === 'custom') {
    if (!name) return type === 'custom' ? undefined : 'required'
    return { type: type === 'tool' ? 'function' : type, name }
  }

  if (type === 'mcp') {
    if (!choice.server_label) return name ? { type: 'function', name } : undefined
    const out = { type: 'mcp', server_label: choice.server_label }
    if (name) out.name = name
    return out
  }

  if (name && !choice.name) return { type: type || 'function', name }
  return choice
}

function toolsToCodex(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined
  return tools.map((tool) => {
    if (tool?.type === 'function' && tool.function) {
      return {
        type: 'function',
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: tool.function.parameters || { type: 'object', properties: {} },
      }
    }
    if (tool?.name) {
      return {
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} },
      }
    }
    return tool
  })
}

export function chatToCodexResponses(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const input = messages.flatMap(chatMessageToItems)
  const out = {
    model: body.model,
    input,
    stream: body.stream !== false,
    store: false,
  }
  const tools = toolsToCodex(body.tools)
  if (tools) out.tools = tools
  const choice = responsesToolChoice(body.tool_choice)
  if (choice) out.tool_choice = choice
  if (body.reasoning) out.reasoning = body.reasoning
  if (body.reasoning_effort) out.reasoning_effort = body.reasoning_effort
  if (body.max_tokens || body.max_completion_tokens) {
    out.max_output_tokens = body.max_tokens || body.max_completion_tokens
  }
  if (body.prompt_cache_key) out.prompt_cache_key = body.prompt_cache_key
  return out
}

export function completionsToCodexResponses(body = {}) {
  const prompt = Array.isArray(body.prompt) ? body.prompt.join('\n') : String(body.prompt || '')
  const out = {
    model: body.model,
    input: codexTextInput(prompt),
    stream: body.stream !== false,
    store: false,
  }
  if (body.prompt_cache_key) out.prompt_cache_key = body.prompt_cache_key
  return out
}

/** Official Codex Responses user turn. ChatGPT Codex rejects string `input`. */
export function codexTextInput(text) {
  return [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: String(text || '') }],
    },
  ]
}

export const CODEX_REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
export const DEFAULT_CODEX_REASONING_EFFORT = 'medium'

export function normalizeCodexReasoningEffort(raw) {
  const effort = String(raw || '')
    .trim()
    .toLowerCase()
  if (!effort || effort === 'none' || effort === 'off') return ''
  if (CODEX_REASONING_EFFORTS.includes(effort)) return effort
  return DEFAULT_CODEX_REASONING_EFFORT
}

function stripUnsupportedCodexFields(body = {}) {
  const next = { ...body }
  // Official Codex wire uses `priority`. Public API alias `fast` is rejected upstream.
  if (typeof next.service_tier === 'string' && next.service_tier.trim().toLowerCase() === 'fast') {
    next.service_tier = 'priority'
  }
  delete next.max_output_tokens
  delete next.max_tokens
  delete next.temperature
  delete next.prompt_cache_retention
  const effort = normalizeCodexReasoningEffort(next.reasoning?.effort || next.reasoning_effort)
  delete next.reasoning_effort
  if (effort) {
    next.reasoning = {
      ...(next.reasoning && typeof next.reasoning === 'object' ? next.reasoning : {}),
      effort,
    }
  } else {
    delete next.reasoning
  }
  if (next.tool_choice != null) {
    const choice = responsesToolChoice(next.tool_choice)
    if (choice) next.tool_choice = choice
    else delete next.tool_choice
  }
  if (Array.isArray(next.input)) {
    next.input = next.input.map((item) => {
      if (item && typeof item === 'object' && item.type === 'message' && item.role === 'system') {
        return { ...item, role: 'developer' }
      }
      return item
    })
  }
  return next
}

export function normalizeCodexResponsesInput(body = {}) {
  const next = { ...body }
  if (typeof next.input === 'string') next.input = codexTextInput(next.input)
  else if (!Array.isArray(next.input) && Array.isArray(next.messages)) {
    return stripUnsupportedCodexFields(chatToCodexResponses(next))
  }
  return stripUnsupportedCodexFields(next)
}

export function anthropicToCodexResponses(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const system = typeof body.system === 'string' ? [{ role: 'system', content: body.system }] : []
  return chatToCodexResponses({
    model: body.model,
    messages: [...system, ...messages],
    tools: body.tools,
    tool_choice: body.tool_choice,
    stream: body.stream,
    max_tokens: body.max_tokens,
  })
}

export function toCodexResponses(protocol, body, convert = {}) {
  const stripped = stripCodexIdentity(body)
  if (protocol === 'openai.responses') {
    return {
      ok: true,
      body: normalizeCodexResponsesInput(stripped),
      converted: typeof stripped.input === 'string',
    }
  }
  if (protocol === 'openai.chat' && convert.chat_to_codex !== false) {
    return { ok: true, body: stripUnsupportedCodexFields(chatToCodexResponses(stripped)), converted: true }
  }
  if (protocol === 'openai.completions' && convert.completions_to_codex !== false) {
    return { ok: true, body: stripUnsupportedCodexFields(completionsToCodexResponses(stripped)), converted: true }
  }
  if (protocol === 'anthropic.messages' && convert.anthropic_to_codex === true) {
    return { ok: true, body: stripUnsupportedCodexFields(anthropicToCodexResponses(stripped)), converted: true }
  }
  return { ok: false, code: 'protocol_not_allowed' }
}

export function createChatSseState(id = 'codex') {
  return { id, seq: 0, tools: new Map(), sawTool: false }
}

function chatChunk(id, delta, finish, extra = {}) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    ...extra,
  })}\n\n`
}

function bindTool(state, keys, fields = {}) {
  const names = keys.filter((key) => key != null && key !== '').map(String)
  const existing = names.map((key) => state.tools.get(key)).find(Boolean)
  const slot = existing || { index: state.seq++, id: '', name: '', header: false, args: '' }
  if (fields.id) slot.id = fields.id
  if (fields.name) slot.name = fields.name
  for (const key of names) state.tools.set(key, slot)
  state.sawTool = true
  return slot
}

function toolHeaderDelta(slot) {
  if (slot.header) return null
  slot.header = true
  return {
    index: slot.index,
    id: slot.id,
    type: 'function',
    function: { name: slot.name, arguments: '' },
  }
}

function toolArgsDelta(slot, full) {
  if (typeof full !== 'string' || full.length <= slot.args.length || !full.startsWith(slot.args)) return null
  const piece = full.slice(slot.args.length)
  slot.args = full
  return { index: slot.index, function: { arguments: piece } }
}

function toolDoneChunk(session, slot, full) {
  const calls = []
  const header = toolHeaderDelta(slot)
  if (header) calls.push(header)
  const piece = toolArgsDelta(slot, full)
  if (piece) calls.push(piece)
  return calls.length ? chatChunk(session.id, { tool_calls: calls }) : null
}

export function responsesSseToChatChunk(line, id = 'codex', state = null) {
  const session = state || createChatSseState(id)
  if (!state && id) session.id = id
  const trimmed = String(line || '').trim()
  if (!trimmed.startsWith('data:')) return null
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return 'data: [DONE]\n\n'
  let event
  try {
    event = JSON.parse(data)
  } catch {
    return null
  }
  const type = event.type || ''
  if (
    type === 'response.output_item.added' &&
    (event.item?.type === 'function_call' || event.item?.type === 'custom_tool_call')
  ) {
    const slot = bindTool(session, [event.output_index, event.item_id, event.item.call_id, event.item.id], {
      id: event.item.call_id || event.item.id,
      name: event.item.name,
    })
    const header = toolHeaderDelta(slot)
    return header ? chatChunk(session.id, { tool_calls: [header] }) : null
  }
  if (type === 'response.function_call_arguments.delta' || type === 'response.custom_tool_call_input.delta') {
    const slot = bindTool(session, [event.output_index, event.item_id])
    const pieces = []
    const header = toolHeaderDelta(slot)
    if (header) pieces.push(header)
    const args = typeof event.delta === 'string' ? event.delta : ''
    if (args) {
      slot.args += args
      pieces.push({ index: slot.index, function: { arguments: args } })
    }
    return pieces.length ? chatChunk(session.id, { tool_calls: pieces }) : null
  }
  if (type === 'response.function_call_arguments.done' || type === 'response.custom_tool_call_input.done') {
    const slot = bindTool(session, [event.output_index, event.item_id], { name: event.name })
    return toolDoneChunk(session, slot, event.arguments || event.input)
  }
  if (
    type === 'response.output_item.done' &&
    (event.item?.type === 'function_call' || event.item?.type === 'custom_tool_call')
  ) {
    const keys = [event.output_index, event.item_id, event.item.call_id, event.item.id]
    const known = keys.some((key) => key != null && key !== '' && session.tools.has(String(key)))
    if (!known) return null
    const slot = bindTool(session, keys, { id: event.item.call_id || event.item.id, name: event.item.name })
    return toolDoneChunk(session, slot, event.item.arguments || event.item.input)
  }
  if (type.startsWith('response.reasoning_') && typeof event.delta === 'string' && event.delta) {
    return chatChunk(session.id, { reasoning_content: event.delta })
  }
  if (
    type === 'response.output_text.delta' ||
    (typeof event.delta === 'string' && event.delta && type !== 'response.completed' && type !== 'response.done')
  ) {
    return chatChunk(session.id, { content: event.delta || event.text || '' })
  }
  if (type === 'response.completed' || type === 'response.done') {
    const usage = openaiChatUsageFromExtract(extractOpenaiUsage(event.response?.usage || event.usage))
    const finish = session.sawTool ? 'tool_calls' : 'stop'
    return `${chatChunk(session.id, {}, finish, usage ? { usage } : {})}data: [DONE]\n\n`
  }
  return null
}

function parseSseData(line) {
  const trimmed = String(line || '').trim()
  if (!trimmed.startsWith('data:')) return { skip: true }
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return { done: true }
  try {
    return { event: JSON.parse(data) }
  } catch {
    return { skip: true }
  }
}

/**
 * kin-codex-kernel labels every Responses SSE frame `event: response`. OpenAI names each
 * frame after its payload (`event: response.created`, `event: response.output_text.delta`,
 * ...), and relays such as claude-code-hub classify frames by that name, so a kernel stream
 * reads to them as one with no content and no completion. Returns a per-stream mapper from
 * one raw kernel line to the text to write: the kernel's event line is held and re-emitted
 * as `event: <data.type>` in front of its data line ('' while held).
 */
export function createResponsesSseEventNamer() {
  let held = null
  return (line) => {
    const raw = String(line ?? '')
    if (raw.startsWith('event:')) {
      held = raw
      return ''
    }
    if (!raw.startsWith('data:')) return `${raw}\n`
    const type = parseSseData(raw).event?.type
    const name = typeof type === 'string' && type ? `event: ${type}` : held
    held = null
    return name ? `${name}\n${raw}\n` : `${raw}\n`
  }
}

function outputTextFromCodex(body = {}) {
  const resp = body.response && typeof body.response === 'object' ? body.response : body
  const chunks = []
  const walk = (node) => {
    if (!node) return
    if (typeof node === 'string') {
      chunks.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node !== 'object') return
    if (typeof node.text === 'string') chunks.push(node.text)
    if (typeof node.output_text === 'string') chunks.push(node.output_text)
    walk(node.content)
    walk(node.output)
  }
  walk(resp.output)
  if (!chunks.length && typeof resp.output_text === 'string') chunks.push(resp.output_text)
  return chunks.join('')
}

export function createAnthropicSseState() {
  return { started: false, id: 'msg_codex', model: '', text: '' }
}

function anthropicEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
}

export function responsesSseToAnthropicEvents(line, state = createAnthropicSseState()) {
  const parsed = parseSseData(line)
  if (parsed.skip) return null
  const event = parsed.event || {}
  const type = event.type || ''
  if (event.response?.id) state.id = event.response.id
  if (event.response?.model) state.model = event.response.model
  const frames = []
  const ensureStart = () => {
    if (state.started) return
    state.started = true
    frames.push(
      anthropicEvent('message_start', {
        message: {
          id: state.id,
          type: 'message',
          role: 'assistant',
          model: state.model || 'gpt',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    )
    frames.push(
      anthropicEvent('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    )
  }
  if (
    type === 'response.output_text.delta' ||
    (event.delta && type !== 'response.completed' && type !== 'response.done')
  ) {
    const content = event.delta || event.text || ''
    if (!content) return null
    ensureStart()
    state.text += content
    frames.push(
      anthropicEvent('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: content },
      }),
    )
    return frames.join('')
  }
  if (type === 'response.completed' || type === 'response.done' || parsed.done) {
    ensureStart()
    const mapped = openaiAnthropicUsageFromExtract(extractOpenaiUsage(event.response?.usage || event.usage))
    frames.push(anthropicEvent('content_block_stop', { index: 0 }))
    frames.push(
      anthropicEvent('message_delta', {
        delta: { stop_reason: 'end_turn' },
        usage: mapped,
      }),
    )
    frames.push(anthropicEvent('message_stop', {}))
    return frames.join('')
  }
  return null
}

export function assembleCodexBodyFromSse(chunks = [], fallback = {}) {
  let text = outputTextFromCodex(fallback)
  let usage = fallback.usage || fallback.response?.usage || {}
  let id = fallback.id || fallback.response?.id
  let model = fallback.model || fallback.response?.model
  const deltas = []
  for (const line of chunks) {
    const parsed = parseSseData(line)
    if (parsed.skip || !parsed.event) continue
    const ev = parsed.event
    if (ev.response?.id) id = ev.response.id
    if (ev.response?.model) model = ev.response.model
    if (
      ev.type === 'response.output_text.delta' ||
      (ev.delta && ev.type !== 'response.completed' && ev.type !== 'response.done')
    ) {
      const piece = ev.delta || ev.text || ''
      if (piece) deltas.push(piece)
    }
    if (ev.response?.usage || ev.usage) usage = ev.response?.usage || ev.usage
  }
  if (deltas.length) text = deltas.join('')
  return {
    ...fallback,
    id: id || fallback.id,
    model: model || fallback.model,
    output: [{ content: [{ type: 'output_text', text }] }],
    usage,
  }
}

export function codexBodyToAnthropicMessage(body = {}, model = '') {
  const resp = body?.response && typeof body.response === 'object' ? body.response : body
  const usage = openaiAnthropicUsageFromExtract(extractOpenaiUsage(resp?.usage || body?.usage || {}))
  return {
    id: resp?.id || 'msg_codex',
    type: 'message',
    role: 'assistant',
    model: resp?.model || model || 'gpt',
    content: [{ type: 'text', text: outputTextFromCodex(resp) }],
    stop_reason: 'end_turn',
    usage,
  }
}
