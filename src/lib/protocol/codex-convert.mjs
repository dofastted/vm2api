/**
 * Convert OpenAI Chat/Completions (and optional Anthropic) bodies to Codex Responses.
 * Native openai.responses bodies pass through after identity strip.
 */

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

function chatMessageToInput(message) {
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user'
  const text = textParts(message.content)
  if (role === 'system') {
    return { type: 'message', role: 'user', content: [{ type: 'input_text', text: `System:\n${text}` }] }
  }
  return {
    type: 'message',
    role: role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  }
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
  const input = messages.map(chatMessageToInput)
  const out = {
    model: body.model,
    input,
    stream: body.stream !== false,
    store: false,
  }
  const tools = toolsToCodex(body.tools)
  if (tools) out.tools = tools
  if (body.tool_choice) out.tool_choice = body.tool_choice
  if (body.reasoning) out.reasoning = body.reasoning
  if (body.max_tokens || body.max_completion_tokens) {
    out.max_output_tokens = body.max_tokens || body.max_completion_tokens
  }
  return out
}

export function completionsToCodexResponses(body = {}) {
  const prompt = Array.isArray(body.prompt) ? body.prompt.join('\n') : String(body.prompt || '')
  return {
    model: body.model,
    input: codexTextInput(prompt),
    stream: body.stream !== false,
    store: false,
  }
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
  delete next.max_output_tokens
  delete next.max_tokens
  delete next.temperature
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

export function responsesSseToChatChunk(line, id = 'codex') {
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
    type === 'response.output_text.delta' ||
    (event.delta && type !== 'response.completed' && type !== 'response.done')
  ) {
    const content = event.delta || event.text || ''
    return `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`
  }
  if (type === 'response.completed' || type === 'response.done') {
    const usage = openaiChatUsage(event.response?.usage || event.usage)
    return `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      ...(usage ? { usage } : {}),
    })}\n\ndata: [DONE]\n\n`
  }
  return null
}

function openaiChatUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const prompt = Number(usage.input_tokens ?? usage.prompt_tokens)
  const completion = Number(usage.output_tokens ?? usage.completion_tokens)
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null
  const p = Number.isFinite(prompt) ? prompt : 0
  const c = Number.isFinite(completion) ? completion : 0
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c }
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
    const usage = event.response?.usage || event.usage || {}
    const output = Number(usage.output_tokens ?? usage.completion_tokens) || 0
    frames.push(anthropicEvent('content_block_stop', { index: 0 }))
    frames.push(
      anthropicEvent('message_delta', {
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: output },
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
  const usage = resp?.usage || body?.usage || {}
  const input = Number(usage.input_tokens ?? usage.prompt_tokens) || 0
  const output = Number(usage.output_tokens ?? usage.completion_tokens) || 0
  return {
    id: resp?.id || 'msg_codex',
    type: 'message',
    role: 'assistant',
    model: resp?.model || model || 'gpt',
    content: [{ type: 'text', text: outputTextFromCodex(resp) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: input, output_tokens: output },
  }
}
