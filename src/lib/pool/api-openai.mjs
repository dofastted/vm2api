import { chatMessageToItems, responsesToolChoice } from '../protocol/codex-convert.mjs'

function flattenSystem(system) {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return String(system)
  return system
    .map((block) => {
      if (typeof block === 'string') return block
      return block?.text || ''
    })
    .filter(Boolean)
    .join('\n')
}

function contentToOpenAI(content) {
  if (typeof content === 'string') return { text: content, toolCalls: [], toolResults: [] }
  const texts = []
  const toolCalls = []
  const toolResults = []
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') texts.push(block.text || '')
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      })
    } else if (block.type === 'tool_result') {
      const raw = block.content
      toolResults.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''),
      })
    }
  }
  return { text: texts.join('\n'), toolCalls, toolResults }
}

export function claudeToOpenAIResponsesRequest(claude = {}) {
  const chat = claudeToOpenAIChatRequest(claude)
  // Reuse chatMessageToItems so multi-turn tool loops survive the conversion:
  // assistant tool_calls become function_call items and role=tool messages become
  // function_call_output items. The previous plain-text map silently dropped
  // both, so a Claude-protocol caller looping tools against an OpenAI endpoint
  // re-issued the same call forever (the model never saw the tool output).
  const input = (chat.messages || []).flatMap(chatMessageToItems)
  const out = {
    model: chat.model,
    input,
    stream: true,
    store: false,
  }
  if (Array.isArray(chat.tools) && chat.tools.length) {
    out.tools = chat.tools.map((tool) => {
      if (tool?.type === 'function' && tool.function) {
        return {
          type: 'function',
          name: tool.function.name,
          description: tool.function.description || '',
          parameters: tool.function.parameters || { type: 'object', properties: {} },
        }
      }
      return tool
    })
  }
  const choice = responsesToolChoice(claude.tool_choice)
  if (choice) out.tool_choice = choice
  if (chat.max_tokens) out.max_output_tokens = chat.max_tokens
  if (chat.temperature != null) out.temperature = chat.temperature
  if (chat.top_p != null) out.top_p = chat.top_p
  return out
}

export function claudeToOpenAIChatRequest(claude = {}) {
  const messages = []
  const system = flattenSystem(claude.system)
  if (system) messages.push({ role: 'system', content: system })
  for (const msg of claude.messages || []) {
    const role = msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user'
    const { text, toolCalls, toolResults } = contentToOpenAI(msg.content)
    if (toolResults.length) messages.push(...toolResults)
    if (role === 'assistant' && toolCalls.length) {
      messages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls })
    } else if (text || role === 'user') {
      messages.push({ role, content: text })
    }
  }
  const out = { model: claude.model, messages, stream: true }
  if (claude.max_tokens) out.max_tokens = claude.max_tokens
  if (claude.temperature != null) out.temperature = claude.temperature
  if (claude.top_p != null) out.top_p = claude.top_p
  if (Array.isArray(claude.tools) && claude.tools.length) {
    out.tools = claude.tools
      .filter((t) => t?.name)
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      }))
  }
  return out
}

export function openaiChatToClaudeMessage(chat = {}) {
  const choice = chat.choices?.[0] || {}
  const msg = choice.message || {}
  const content = []
  if (msg.reasoning_content) content.push({ type: 'thinking', thinking: msg.reasoning_content })
  if (msg.content) content.push({ type: 'text', text: msg.content })
  for (const tc of msg.tool_calls || []) {
    let input = {}
    try {
      input = JSON.parse(tc.function?.arguments || '{}')
    } catch {
      input = {}
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input })
  }
  const finish = choice.finish_reason
  return {
    type: 'message',
    id: chat.id,
    role: 'assistant',
    model: chat.model,
    content,
    stop_reason: finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn',
    usage: {
      input_tokens: chat.usage?.prompt_tokens || 0,
      output_tokens: chat.usage?.completion_tokens || 0,
    },
  }
}

export function createOpenAIChatAssembler() {
  return { id: '', model: '', text: '', reasoning: '', finish: '', usage: null, done: false }
}

export function applyOpenAIChatSSELine(line, state) {
  const raw = String(line || '').trim()
  if (!raw.startsWith('data:')) return null
  const data = raw.slice(5).trim()
  if (!data || data === '[DONE]') {
    state.done = true
    return { done: true }
  }
  let evt
  try {
    evt = JSON.parse(data)
  } catch {
    return null
  }
  const delta = evt.choices?.[0]?.delta || {}
  if (evt.id) state.id = evt.id
  if (evt.model) state.model = evt.model
  if (delta.content) state.text += delta.content
  if (delta.reasoning_content) state.reasoning += delta.reasoning_content
  if (evt.choices?.[0]?.finish_reason) state.finish = evt.choices[0].finish_reason
  if (evt.usage) state.usage = evt.usage
  return delta
}

export function openAIAssemblerToClaude(state) {
  return openaiChatToClaudeMessage({
    id: state.id,
    model: state.model,
    choices: [
      {
        message: {
          content: state.text || null,
          reasoning_content: state.reasoning || undefined,
        },
        finish_reason: state.finish || 'stop',
      },
    ],
    usage: state.usage,
  })
}

export function claudeSSEFromOpenAIDelta(delta, state, flags) {
  const chunks = []
  if (!flags.started) {
    flags.started = true
    chunks.push({
      type: 'message_start',
      message: { id: state.id || 'msg_api', type: 'message', role: 'assistant', content: [] },
    })
    chunks.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  }
  if (delta?.content) {
    chunks.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } })
  }
  if (state.done || state.finish) {
    if (!flags.closed) {
      flags.closed = true
      chunks.push({ type: 'content_block_stop', index: 0 })
      chunks.push({
        type: 'message_delta',
        delta: {
          stop_reason:
            state.finish === 'tool_calls' ? 'tool_use' : state.finish === 'length' ? 'max_tokens' : 'end_turn',
        },
      })
      chunks.push({ type: 'message_stop' })
    }
  }
  return chunks
}
