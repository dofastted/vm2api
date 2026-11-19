/** Structured public API adapters. No history, system instruction or tool is flattened into a prompt. */
import crypto from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { claudeStopReasonToOpenAIFinish } from './convert.mjs'

const PROTOCOLS = new Set(['anthropic.messages', 'openai.chat', 'openai.responses', 'openai.completions'])
const NAME = /^[a-zA-Z0-9_-]{1,200}$/
const TOOL_ID = /^[a-zA-Z0-9_.:-]{1,200}$/
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const uid = (prefix) => prefix + crypto.randomUUID().replaceAll('-', '')

function invalid(message, param, code = 'invalid_request') {
  throw Object.assign(new Error(message), { status: 400, code, param })
}

function unsupported(message, param) {
  invalid(message, param, 'antigravity_feature_not_supported')
}

function text(value, param) {
  if (typeof value !== 'string') invalid(`${param} must be a string`, param)
  return value
}

function id(value, param) {
  if (typeof value !== 'string' || !TOOL_ID.test(value)) invalid(`${param} is invalid`, param)
  return value
}

function name(value, param) {
  if (typeof value !== 'string' || !NAME.test(value)) invalid(`${param} is invalid`, param)
  return value
}

function opaqueSignature(value, param) {
  if (typeof value !== 'string' || !value.length || value.length > 256 * 1024 || /[^\x20-\x7e]/.test(value)) {
    invalid(`${param} must be a bounded opaque signature string`, param)
  }
  return value
}

function argumentsOf(value, param) {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      invalid(`${param} must contain valid JSON`, param, 'invalid_tool_arguments')
    }
  }
  if (!object(parsed)) invalid(`${param} must be a JSON object`, param, 'invalid_tool_arguments')
  return structuredClone(parsed)
}

function imageSource(value, param) {
  if (!object(value)) invalid(`${param} must be an image source`, param)
  if (value.type === 'base64') {
    if (!IMAGE_TYPES.has(value.media_type) || typeof value.data !== 'string' || !value.data.length) {
      invalid(`${param} must contain a supported image media type and base64 data`, param)
    }
    if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(value.data) || value.data.length % 4 === 1) {
      invalid(`${param} contains invalid base64 data`, param)
    }
    return { type: 'base64', media_type: value.media_type, data: value.data }
  }
  if (value.type === 'url') {
    let url
    try {
      url = new URL(value.url)
    } catch {
      invalid(`${param} must contain an absolute HTTP image URL`, param)
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      invalid(`${param} must contain an HTTP image URL without credentials`, param)
    }
    return { type: 'url', url: url.href }
  }
  unsupported(`Unsupported image source type: ${String(value.type)}`, param)
}

function imageFromUrl(value, param) {
  const url = typeof value === 'string' ? value : value?.url
  if (typeof url !== 'string') invalid(`${param} must contain an image URL`, param)
  if (url.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]+)$/.exec(url)
    if (!match) invalid(`${param} must contain a supported base64 image`, param)
    return imageSource({ type: 'base64', media_type: match[1], data: match[2] }, param)
  }
  return imageSource({ type: 'url', url }, param)
}

function contentOf(value, role, param, { result = false } = {}) {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (value == null && role === 'assistant') return []
  if (!Array.isArray(value)) invalid(`${param} must be text or a content array`, param)
  return value
    .map((part, index) => {
      const at = `${param}.${index}`
      if (!object(part)) invalid(`${at} must be a content object`, at)
      if (['text', 'input_text', 'output_text'].includes(part.type)) {
        return { type: 'text', text: text(part.text, `${at}.text`) }
      }
      if (part.type === 'image' || part.type === 'image_url' || part.type === 'input_image') {
        if (role !== 'user') invalid('Images are only supported in user messages or tool results', at)
        const source =
          part.type === 'image' ? imageSource(part.source, `${at}.source`) : imageFromUrl(part.image_url, at)
        return { type: 'image', source, ...(part.detail ? { detail: part.detail } : {}) }
      }
      if (result) unsupported(`Tool result content type is not supported: ${String(part.type)}`, at)
      if (part.type === 'tool_use') {
        if (role !== 'assistant') invalid('tool_use requires an assistant message', at)
        return {
          type: 'tool_use',
          id: id(part.id, `${at}.id`),
          name: name(part.name, `${at}.name`),
          input: argumentsOf(part.input, `${at}.input`),
          ...(part.thought_signature
            ? { thought_signature: text(part.thought_signature, `${at}.thought_signature`) }
            : {}),
        }
      }
      if (part.type === 'tool_result') {
        if (role !== 'user') invalid('tool_result requires a user message', at)
        return {
          type: 'tool_result',
          tool_use_id: id(part.tool_use_id, `${at}.tool_use_id`),
          content: contentOf(part.content ?? '', 'user', `${at}.content`, { result: true }),
          ...(part.is_error === true ? { is_error: true } : {}),
        }
      }
      if (part.type === 'thinking') {
        if (role !== 'assistant') invalid('thinking requires an assistant message', at)
        return {
          type: 'thinking',
          thinking: text(part.thinking, `${at}.thinking`),
          ...(part.signature ? { signature: opaqueSignature(part.signature, `${at}.signature`) } : {}),
        }
      }
      if (part.type === 'redacted_thinking' && role === 'assistant') {
        return { type: 'redacted_thinking', data: text(part.data, `${at}.data`) }
      }
      if (part.type === 'refusal' && role === 'assistant') {
        return { type: 'refusal', refusal: text(part.refusal, `${at}.refusal`) }
      }
      unsupported(`Content type is not supported: ${String(part.type)}`, at)
    })
    .map((block, index) => {
      const signature = value[index].thought_signature ?? value[index].thoughtSignature
      return signature == null
        ? block
        : { ...block, thought_signature: opaqueSignature(signature, `${param}.${index}.thought_signature`) }
    })
}

function systemOf(value, param) {
  if (value == null) return []
  const blocks = contentOf(value, 'user', param)
  if (blocks.some((block) => block.type !== 'text')) unsupported('System instructions must contain text', param)
  return blocks
}

function toolsOf(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 256) invalid('tools must be an array with at most 256 entries', 'tools')
  const seen = new Set()
  return value.map((raw, index) => {
    const at = `tools.${index}`
    if (!object(raw)) invalid('Each tool must be an object', at)
    if (raw.type && !['function', 'custom'].includes(raw.type))
      unsupported('Only caller function tools are supported', at)
    if (raw.type === 'custom' || raw.format) unsupported('Custom free-form tools are not supported', at)
    const tool = raw.function || raw
    const toolName = name(tool.name, `${at}.name`)
    if (seen.has(toolName)) invalid(`Duplicate tool name: ${toolName}`, `${at}.name`)
    seen.add(toolName)
    const schema = tool.input_schema ?? tool.parameters ?? { type: 'object', properties: {} }
    if (!object(schema)) invalid('Tool parameters must be a JSON Schema object', at)
    return {
      name: toolName,
      description: tool.description == null ? '' : text(tool.description, `${at}.description`),
      input_schema: structuredClone(schema),
      ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
    }
  })
}

function choiceOf(value, tools, parallel) {
  if (value == null) return undefined
  let choice
  if (typeof value === 'string') {
    const type = value === 'required' ? 'any' : value
    if (!['auto', 'none', 'any'].includes(type)) invalid('Invalid tool_choice', 'tool_choice')
    choice = { type }
  } else if (object(value)) {
    const type = value.type === 'required' ? 'any' : value.type === 'function' ? 'tool' : value.type
    if (!['auto', 'none', 'any', 'tool'].includes(type)) unsupported('Unsupported tool_choice mode', 'tool_choice')
    choice = { type }
    if (type === 'tool') choice.name = name(value.name || value.function?.name, 'tool_choice.name')
    if (value.disable_parallel_tool_use === true) choice.disable_parallel_tool_use = true
  } else invalid('Invalid tool_choice', 'tool_choice')
  if (choice.type !== 'none' && !tools.length) invalid('tool_choice requires tool definitions', 'tool_choice')
  if (choice.type === 'tool' && !tools.some((tool) => tool.name === choice.name)) {
    invalid('tool_choice references an undefined tool', 'tool_choice.name')
  }
  if (parallel === false) choice.disable_parallel_tool_use = true
  return choice
}

function checkToolHistory(messages) {
  const outstanding = new Set()
  const used = new Set()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        if (used.has(block.id)) invalid('Tool call IDs must be unique', 'messages', 'invalid_tool_history')
        outstanding.add(block.id)
        used.add(block.id)
      } else if (block.type === 'tool_result') {
        if (!outstanding.delete(block.tool_use_id)) {
          invalid('Tool result has no preceding matching tool call', 'messages', 'invalid_tool_history')
        }
      }
    }
  }
}

function append(messages, role, content) {
  const last = messages.at(-1)
  if (last?.role === role) last.content.push(...content)
  else messages.push({ role, content })
}

function chatMessages(value, system) {
  if (!Array.isArray(value)) invalid('messages must be an array', 'messages')
  const messages = []
  for (let index = 0; index < value.length; index++) {
    const raw = value[index]
    const at = `messages.${index}`
    if (!object(raw)) invalid('Messages must be objects', at)
    if (raw.role === 'system' || raw.role === 'developer') {
      system.push(...systemOf(raw.content, `${at}.content`))
      continue
    }
    if (raw.role === 'tool') {
      append(messages, 'user', [
        {
          type: 'tool_result',
          tool_use_id: id(raw.tool_call_id, `${at}.tool_call_id`),
          content: contentOf(raw.content ?? '', 'user', `${at}.content`, { result: true }),
        },
      ])
      continue
    }
    if (!['user', 'assistant'].includes(raw.role))
      unsupported(`Unsupported message role: ${String(raw.role)}`, `${at}.role`)
    const content = contentOf(raw.content, raw.role, `${at}.content`)
    if (raw.function_call) unsupported('Legacy function_call is not supported; use tool_calls', `${at}.function_call`)
    if (raw.tool_calls != null) {
      if (raw.role !== 'assistant' || !Array.isArray(raw.tool_calls))
        invalid('tool_calls requires an assistant message and an array', `${at}.tool_calls`)
      for (let n = 0; n < raw.tool_calls.length; n++) {
        const call = raw.tool_calls[n]
        if (call?.type !== 'function' || !object(call.function))
          unsupported('Only function tool calls are supported', `${at}.tool_calls.${n}`)
        content.push({
          type: 'tool_use',
          id: id(call.id, `${at}.tool_calls.${n}.id`),
          name: name(call.function.name, `${at}.tool_calls.${n}.function.name`),
          input: argumentsOf(call.function.arguments, `${at}.tool_calls.${n}.function.arguments`),
          ...(call.thought_signature
            ? { thought_signature: opaqueSignature(call.thought_signature, `${at}.tool_calls.${n}.thought_signature`) }
            : {}),
        })
      }
    }
    if (raw.reasoning_content != null)
      content.unshift({
        type: 'thinking',
        thinking: text(raw.reasoning_content, `${at}.reasoning_content`),
        ...(raw.reasoning_signature
          ? { signature: opaqueSignature(raw.reasoning_signature, `${at}.reasoning_signature`) }
          : {}),
      })
    append(messages, raw.role, content)
  }
  return messages
}

function responsesMessages(value, system) {
  if (typeof value === 'string') return [{ role: 'user', content: [{ type: 'text', text: value }] }]
  if (!Array.isArray(value)) invalid('input must be a string or array', 'input')
  const messages = []
  for (let index = 0; index < value.length; index++) {
    const item = value[index]
    const at = `input.${index}`
    if (!object(item)) invalid('Responses input items must be objects', at)
    if (item.type === 'function_call') {
      append(messages, 'assistant', [
        {
          type: 'tool_use',
          id: id(item.call_id, `${at}.call_id`),
          name: name(item.name, `${at}.name`),
          input: argumentsOf(item.arguments, `${at}.arguments`),
          ...(item.thought_signature
            ? { thought_signature: opaqueSignature(item.thought_signature, `${at}.thought_signature`) }
            : {}),
        },
      ])
    } else if (item.type === 'function_call_output') {
      append(messages, 'user', [
        {
          type: 'tool_result',
          tool_use_id: id(item.call_id, `${at}.call_id`),
          content: contentOf(item.output, 'user', `${at}.output`, { result: true }),
        },
      ])
    } else if (item.type === 'reasoning') {
      if (item.encrypted_content)
        unsupported('Opaque Responses reasoning cannot be imported by Antigravity', `${at}.encrypted_content`)
      if (!Array.isArray(item.summary)) invalid('reasoning.summary must be an array', `${at}.summary`)
      const parts = item.summary.map((part, n) => {
        if (part?.type !== 'summary_text') unsupported('Unsupported reasoning summary part', `${at}.summary.${n}`)
        return text(part.text, `${at}.summary.${n}.text`)
      })
      append(messages, 'assistant', [
        {
          type: 'thinking',
          thinking: parts.join('\n'),
          ...(item.signature ? { signature: opaqueSignature(item.signature, `${at}.signature`) } : {}),
          ...(item.thought_signature
            ? { thought_signature: opaqueSignature(item.thought_signature, `${at}.thought_signature`) }
            : {}),
        },
      ])
    } else if (!item.type || item.type === 'message') {
      if (item.role === 'system' || item.role === 'developer') system.push(...systemOf(item.content, `${at}.content`))
      else {
        if (!['user', 'assistant'].includes(item.role)) invalid('Unsupported Responses message role', `${at}.role`)
        append(messages, item.role, contentOf(item.content, item.role, `${at}.content`))
      }
    } else unsupported(`Unsupported Responses input item: ${String(item.type)}`, at)
  }
  return messages
}

function controlsOf(body, request) {
  const max = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens
  if (max != null) {
    if (!Number.isSafeInteger(max) || max <= 0) invalid('Output token limit must be a positive integer', 'max_tokens')
    request.max_tokens = max
  }
  for (const field of ['temperature', 'top_p', 'top_k']) {
    if (body[field] == null) continue
    if (typeof body[field] !== 'number' || !Number.isFinite(body[field]))
      invalid(`${field} must be a finite number`, field)
    request[field] = body[field]
  }
  if (request.temperature != null && (request.temperature < 0 || request.temperature > 2))
    invalid('temperature must be between 0 and 2', 'temperature')
  if (request.top_p != null && (request.top_p < 0 || request.top_p > 1))
    invalid('top_p must be between 0 and 1', 'top_p')
  if (request.top_k != null && (!Number.isSafeInteger(request.top_k) || request.top_k < 1))
    invalid('top_k must be a positive integer', 'top_k')
  const stop = body.stop_sequences ?? body.stop
  if (stop != null) {
    const stops = typeof stop === 'string' ? [stop] : stop
    if (!Array.isArray(stops) || stops.length > 16 || stops.some((item) => typeof item !== 'string' || !item))
      invalid('Stop sequences must be nonempty strings', 'stop')
    request.stop_sequences = [...stops]
  }
  if (body.thinking != null) {
    if (!object(body.thinking)) invalid('thinking must be an object', 'thinking')
    request.thinking = structuredClone(body.thinking)
  }
  const reasoning = body.reasoning ?? (body.reasoning_effort ? { effort: body.reasoning_effort } : undefined)
  if (reasoning != null) {
    if (!object(reasoning)) invalid('reasoning must be an object', 'reasoning')
    request.reasoning = structuredClone(reasoning)
  }
  const format = body.response_format ?? body.text?.format ?? body.output_config?.format
  if (format != null) {
    if (!object(format) || !['text', 'json_object', 'json_schema'].includes(format.type))
      unsupported('Unsupported output format', 'response_format')
    if (format.type === 'json_schema') {
      const definition = format.json_schema || format
      if (!object(definition.schema)) invalid('JSON schema output requires a schema object', 'response_format.schema')
      if (definition.strict != null && typeof definition.strict !== 'boolean')
        invalid('JSON schema strict must be boolean', 'response_format.strict')
      request.response_format = {
        type: 'json_schema',
        schema: structuredClone(definition.schema),
        ...(definition.name ? { name: name(definition.name, 'response_format.name') } : {}),
        ...(definition.strict != null ? { strict: definition.strict } : {}),
      }
    } else request.response_format = { type: format.type }
  }
  if (body.output_config?.effort != null)
    request.reasoning = { ...(request.reasoning || {}), effort: body.output_config.effort }
  for (const field of [
    'seed',
    'frequency_penalty',
    'presence_penalty',
    'logit_bias',
    'logprobs',
    'top_logprobs',
    'suffix',
    'echo',
    'best_of',
    'functions',
    'function_call',
    'prediction',
    'audio',
    'modalities',
    'conversation',
    'max_tool_calls',
  ]) {
    if (body[field] != null && body[field] !== false) unsupported(`${field} is not supported by Antigravity`, field)
  }
  if (body.n != null && body.n !== 1) unsupported('Only one completion is supported', 'n')
  if (body.background === true) unsupported('Background Responses are not supported', 'background')
  // Reasoning items already carry summary + signature; no encrypted_content is ever emitted.
  const include = Array.isArray(body.include) ? body.include.filter((v) => v !== 'reasoning.encrypted_content') : []
  if (include.length) unsupported(`Responses include ${include.join(', ')} is not supported`, 'include')
  if (body.truncation && body.truncation !== 'disabled')
    unsupported('Automatic input truncation is not supported', 'truncation')
  if (body.parallel_tool_calls != null && typeof body.parallel_tool_calls !== 'boolean')
    invalid('parallel_tool_calls must be boolean', 'parallel_tool_calls')
  if (body.parallel_tool_calls != null) request.parallel_tool_calls = body.parallel_tool_calls
}

/** previousMessages must be resolved and tenant-authorized by the caller before use. */
export function normalizeAntigravityRequest(protocol, body, { previousMessages } = {}) {
  try {
    if (!PROTOCOLS.has(protocol)) unsupported(`Unsupported protocol: ${String(protocol)}`, 'protocol')
    if (!object(body)) invalid('A request object is required', 'body')
    if (Buffer.byteLength(JSON.stringify(body)) > 20 * 1024 * 1024)
      invalid('Request exceeds 20 MiB', 'body', 'request_too_large')
    if (typeof body.model !== 'string' || !body.model.trim()) invalid('model is required', 'model')
    if (body.previous_response_id && !Array.isArray(previousMessages))
      invalid(
        'Previous response was not found or is unavailable',
        'previous_response_id',
        'previous_response_not_found',
      )
    const system = systemOf(protocol === 'openai.responses' ? body.instructions : body.system, 'system')
    let messages
    if (protocol === 'anthropic.messages') {
      if (!Array.isArray(body.messages)) invalid('messages must be an array', 'messages')
      messages = body.messages.map((message, index) => {
        if (!object(message) || !['user', 'assistant'].includes(message.role))
          invalid('Anthropic messages require user or assistant roles', `messages.${index}`)
        return { role: message.role, content: contentOf(message.content, message.role, `messages.${index}.content`) }
      })
    } else if (protocol === 'openai.responses') messages = responsesMessages(body.input ?? [], system)
    else if (protocol === 'openai.chat') messages = chatMessages(body.messages, system)
    else {
      if (typeof body.prompt !== 'string') unsupported('Legacy completions accepts one text prompt', 'prompt')
      messages = [{ role: 'user', content: [{ type: 'text', text: body.prompt }] }]
    }
    if (Array.isArray(previousMessages)) {
      const prior = previousMessages.map((message, index) => {
        if (!object(message) || !['user', 'assistant'].includes(message.role))
          invalid('Invalid resolved history', `previousMessages.${index}`)
        return {
          role: message.role,
          content: contentOf(message.content, message.role, `previousMessages.${index}.content`),
        }
      })
      messages = [...prior, ...messages]
    }
    if (!messages.length || messages.length > 4096 || !messages.some((message) => message.content.length))
      invalid('At least one nonempty conversation message is required (maximum 4096 messages)', 'messages')
    checkToolHistory(messages)
    const tools = toolsOf(body.tools)
    if (protocol === 'openai.completions' && tools.length)
      unsupported('Legacy completions cannot return tool calls', 'tools')
    const request = { model: body.model.trim(), system, messages, tools }
    const choice = choiceOf(body.tool_choice, tools, body.parallel_tool_calls)
    if (choice) request.tool_choice = choice
    else if (body.parallel_tool_calls === false && tools.length)
      request.tool_choice = { type: 'auto', disable_parallel_tool_use: true }
    controlsOf(body, request)
    return { ok: true, request }
  } catch (error) {
    if (!error.code || !error.status) throw error
    return { ok: false, status: error.status, code: error.code, message: error.message, param: error.param }
  }
}

function usageValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Canonical input token count excludes cache reads/writes, as in Anthropic Messages. */
export function antigravityUsageForProtocol(protocol, value) {
  if (!object(value)) return null
  const input = usageValue(value.input_tokens)
  const output = usageValue(value.output_tokens)
  const cached = usageValue(value.cache_read_input_tokens ?? value.cache_read_tokens)
  const written = usageValue(value.cache_creation_input_tokens ?? value.cache_write_tokens)
  const thinking = usageValue(value.thinking_tokens)
  if (input == null && output == null) return null
  if (protocol === 'anthropic.messages')
    return {
      ...(input != null ? { input_tokens: input } : {}),
      ...(output != null ? { output_tokens: output } : {}),
      ...(cached != null ? { cache_read_input_tokens: cached } : {}),
      ...(written != null ? { cache_creation_input_tokens: written } : {}),
    }
  const totalInput = input == null ? undefined : input + (cached || 0) + (written || 0)
  const promptDetails =
    cached != null || written != null
      ? {
          ...(cached != null ? { cached_tokens: cached } : {}),
          ...(written != null ? { cache_creation_tokens: written } : {}),
        }
      : undefined
  if (protocol === 'openai.responses')
    return {
      ...(totalInput != null ? { input_tokens: totalInput } : {}),
      ...(output != null ? { output_tokens: output } : {}),
      ...(totalInput != null && output != null ? { total_tokens: totalInput + output } : {}),
      ...(promptDetails ? { input_tokens_details: promptDetails } : {}),
      ...(thinking != null ? { output_tokens_details: { reasoning_tokens: thinking } } : {}),
    }
  return {
    ...(totalInput != null ? { prompt_tokens: totalInput } : {}),
    ...(output != null ? { completion_tokens: output } : {}),
    ...(totalInput != null && output != null ? { total_tokens: totalInput + output } : {}),
    ...(promptDetails ? { prompt_tokens_details: promptDetails } : {}),
    ...(thinking != null ? { completion_tokens_details: { reasoning_tokens: thinking } } : {}),
  }
}

function resultContent(result) {
  if (Array.isArray(result?.content)) return structuredClone(result.content)
  if (typeof result?.response === 'string') return [{ type: 'text', text: result.response }]
  if (typeof result?.text === 'string') return [{ type: 'text', text: result.text }]
  return []
}

function stopped(result, content) {
  return result.stop_reason || (content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn')
}

function publicError(error) {
  return {
    type: error?.type || 'api_error',
    code: error?.code || 'antigravity_upstream_error',
    message: error?.message || 'Antigravity request failed',
    ...(error?.param ? { param: error.param } : {}),
  }
}

function responseItems(content, responseId) {
  return content
    .map((block, index) => {
      const itemId = `${responseId}_item_${index}`
      if (block.type === 'tool_use')
        return {
          id: itemId,
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
          status: 'completed',
          ...(block.thought_signature ? { thought_signature: block.thought_signature } : {}),
        }
      if (block.type === 'thinking')
        return {
          id: itemId,
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: block.thinking || '' }],
          status: 'completed',
          ...(block.signature ? { signature: block.signature } : {}),
          ...(block.thought_signature ? { thought_signature: block.thought_signature } : {}),
        }
      if (block.type === 'refusal')
        return {
          id: itemId,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: block.refusal || '' }],
          status: 'completed',
        }
      if (block.type === 'text')
        return {
          id: itemId,
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: block.text || '',
              annotations: [],
              logprobs: [],
              ...(block.thought_signature ? { thought_signature: block.thought_signature } : {}),
            },
          ],
          status: 'completed',
        }
      return null
    })
    .filter(Boolean)
}

export function renderAntigravityResponse(
  protocol,
  result,
  { id: suppliedId, model, created = Math.floor(Date.now() / 1000) } = {},
) {
  const content = resultContent(result)
  const stop = stopped(result, content)
  const usage = antigravityUsageForProtocol(protocol, result.usage)
  if (result.ok === false)
    return protocol === 'anthropic.messages'
      ? { type: 'error', error: publicError(result) }
      : { error: publicError(result) }
  if (protocol === 'anthropic.messages')
    return {
      id: suppliedId || uid('msg_'),
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stop,
      stop_sequence: result.stop_sequence ?? null,
      usage,
    }
  const visible = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('')
  if (protocol === 'openai.responses') {
    const responseId = suppliedId || uid('resp_')
    const incomplete = stop === 'max_tokens' || stop === 'refusal'
    return {
      id: responseId,
      object: 'response',
      created_at: created,
      status: incomplete ? 'incomplete' : 'completed',
      error: null,
      incomplete_details: incomplete
        ? { reason: stop === 'max_tokens' ? 'max_output_tokens' : 'content_filter' }
        : null,
      model,
      output: responseItems(content, responseId),
      output_text: visible,
      parallel_tool_calls: true,
      usage,
    }
  }
  if (protocol === 'openai.completions')
    return {
      id: suppliedId || uid('cmpl-'),
      object: 'text_completion',
      created,
      model,
      choices: [{ index: 0, text: visible, finish_reason: claudeStopReasonToOpenAIFinish(stop), logprobs: null }],
      usage,
    }
  const calls = content
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      ...(block.thought_signature ? { thought_signature: block.thought_signature } : {}),
    }))
  const reasoning = content
    .filter((block) => block.type === 'thinking')
    .map((block) => block.thinking || '')
    .join('')
  const reasoningBlocks = content.filter((block) => block.type === 'thinking')
  const refusal = content
    .filter((block) => block.type === 'refusal')
    .map((block) => block.refusal || '')
    .join('')
  return {
    id: suppliedId || uid('chatcmpl-'),
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: visible || null,
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(reasoningBlocks.length === 1 && reasoningBlocks[0].signature
            ? { reasoning_signature: reasoningBlocks[0].signature }
            : {}),
          ...(refusal ? { refusal } : {}),
        },
        finish_reason: claudeStopReasonToOpenAIFinish(stop),
      },
    ],
    usage,
  }
}

const sse = (value, event) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`

/** Returns strings for the caller to write; no HTTP or session state is owned here. */
export function createAntigravityProtocolStream(
  protocol,
  { id: suppliedId, model, includeUsage = false, created = Math.floor(Date.now() / 1000) } = {},
) {
  const responseId =
    suppliedId ||
    uid(protocol === 'openai.responses' ? 'resp_' : protocol === 'anthropic.messages' ? 'msg_' : 'chatcmpl-')
  const blocks = new Map()
  let started = false
  let ended = false
  let sequence = 0
  let toolCount = 0
  const encode = (event) =>
    sse(
      protocol === 'openai.responses' ? { ...event, sequence_number: sequence++ } : event,
      protocol === 'anthropic.messages' || protocol === 'openai.responses' ? event.type : undefined,
    )
  const chunk = (delta, finish = null, usage) =>
    sse({
      id: responseId,
      object: protocol === 'openai.completions' ? 'text_completion' : 'chat.completion.chunk',
      created,
      model,
      choices:
        protocol === 'openai.completions'
          ? [{ index: 0, text: delta.content || '', finish_reason: finish, logprobs: null }]
          : [{ index: 0, delta, finish_reason: finish }],
      ...(usage !== undefined ? { usage } : {}),
    })
  function start() {
    if (started || ended) return ''
    started = true
    if (protocol === 'anthropic.messages')
      return encode({
        type: 'message_start',
        message: {
          id: responseId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      })
    if (protocol === 'openai.responses') {
      const response = {
        id: responseId,
        object: 'response',
        created_at: created,
        model,
        status: 'in_progress',
        output: [],
        error: null,
        usage: null,
      }
      return encode({ type: 'response.created', response }) + encode({ type: 'response.in_progress', response })
    }
    return chunk({ role: 'assistant', content: '' })
  }
  function begin(index, block) {
    if (!Number.isSafeInteger(index) || index < 0 || index > 4095)
      throw new Error('Invalid Antigravity content block index')
    if (blocks.has(index)) throw new Error('Duplicate Antigravity content block index')
    const content = structuredClone(block)
    if (content.type === 'text') content.text = ''
    if (content.type === 'thinking') content.thinking = ''
    if (content.type === 'refusal') content.refusal = ''
    if (content.type === 'tool_use') content.input = {}
    const entry = {
      content,
      done: false,
      arguments: '',
      toolIndex: content.type === 'tool_use' ? toolCount++ : undefined,
    }
    blocks.set(index, entry)
    let output = start()
    if (protocol === 'anthropic.messages')
      return output + encode({ type: 'content_block_start', index, content_block: content }) + seed(index, block)
    if (protocol === 'openai.responses') {
      const item = responseItems([content], responseId)[0]
      if (!item) return output
      item.id = `${responseId}_item_${index}`
      entry.item = item
      const added = {
        ...item,
        status: 'in_progress',
        ...(item.type === 'message' ? { content: [] } : {}),
        ...(item.type === 'function_call' ? { arguments: '' } : {}),
        ...(item.type === 'reasoning' ? { summary: [] } : {}),
      }
      output += encode({ type: 'response.output_item.added', output_index: index, item: added })
      if (item.type === 'message')
        output += encode({
          type: 'response.content_part.added',
          item_id: item.id,
          output_index: index,
          content_index: 0,
          part: { ...item.content[0], ...(content.type === 'refusal' ? { refusal: '' } : { text: '' }) },
        })
      if (item.type === 'reasoning')
        output += encode({
          type: 'response.reasoning_summary_part.added',
          item_id: item.id,
          output_index: index,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        })
      return output + seed(index, block)
    }
    if (content.type === 'tool_use')
      output += chunk({
        tool_calls: [
          {
            index: entry.toolIndex,
            id: content.id,
            type: 'function',
            function: { name: content.name, arguments: '' },
            ...(content.thought_signature ? { thought_signature: content.thought_signature } : {}),
          },
        ],
      })
    return output + seed(index, block)
  }
  function seed(index, block) {
    if (block.type === 'text' && block.text) return delta(index, { type: 'text_delta', text: block.text })
    if (block.type === 'thinking' && block.thinking)
      return delta(index, { type: 'thinking_delta', thinking: block.thinking })
    if (block.type === 'refusal' && block.refusal)
      return delta(index, { type: 'refusal_delta', refusal: block.refusal })
    if (block.type === 'tool_use' && block.input && Object.keys(block.input).length)
      return delta(index, { type: 'input_json_delta', partial_json: JSON.stringify(block.input) })
    return ''
  }
  function delta(index, change) {
    const entry = blocks.get(index)
    if (!entry || entry.done) throw new Error('Antigravity delta references a missing or closed content block')
    const content = entry.content
    let chatDelta
    let event
    if (change.type === 'text_delta' && content.type === 'text') {
      const value = text(change.text ?? '', 'delta.text')
      content.text = (content.text || '') + value
      chatDelta = { content: value }
      event = { type: 'response.output_text.delta', delta: value, content_index: 0 }
    } else if (change.type === 'thinking_delta' && content.type === 'thinking') {
      const value = text(change.thinking ?? '', 'delta.thinking')
      content.thinking = (content.thinking || '') + value
      chatDelta = { reasoning_content: value }
      event = { type: 'response.reasoning_summary_text.delta', delta: value, summary_index: 0 }
    } else if (change.type === 'input_json_delta' && content.type === 'tool_use') {
      const value = text(change.partial_json ?? '', 'delta.partial_json')
      entry.arguments += value
      chatDelta = { tool_calls: [{ index: entry.toolIndex, function: { arguments: value } }] }
      event = { type: 'response.function_call_arguments.delta', delta: value }
    } else if (change.type === 'signature_delta' && content.type === 'thinking') {
      content.signature = (content.signature || '') + text(change.signature ?? '', 'delta.signature')
      chatDelta = { reasoning_signature: change.signature }
    } else if (change.type === 'refusal_delta' && content.type === 'refusal') {
      const value = text(change.refusal ?? '', 'delta.refusal')
      content.refusal = (content.refusal || '') + value
      chatDelta = { refusal: value }
      event = { type: 'response.refusal.delta', delta: value, content_index: 0 }
    } else throw new Error('Antigravity content block and delta types do not match')
    if (protocol === 'anthropic.messages') return encode({ type: 'content_block_delta', index, delta: change })
    if (protocol === 'openai.responses')
      return event ? encode({ ...event, item_id: entry.item.id, output_index: index }) : ''
    return chunk(chatDelta)
  }
  function stop(index) {
    const entry = blocks.get(index)
    if (!entry || entry.done) return ''
    if (entry.content.type === 'tool_use' && entry.arguments)
      entry.content.input = argumentsOf(entry.arguments, 'tool.arguments')
    entry.done = true
    if (protocol === 'anthropic.messages') return encode({ type: 'content_block_stop', index })
    if (protocol !== 'openai.responses' || !entry.item) return ''
    const item = responseItems([entry.content], responseId)[0]
    item.id = entry.item.id
    const common = { item_id: item.id, output_index: index }
    let output = ''
    if (item.type === 'function_call')
      output += encode({
        type: 'response.function_call_arguments.done',
        ...common,
        arguments: item.arguments,
        name: item.name,
      })
    else if (item.type === 'reasoning') {
      output += encode({
        type: 'response.reasoning_summary_text.done',
        ...common,
        summary_index: 0,
        text: entry.content.thinking || '',
      })
      output += encode({
        type: 'response.reasoning_summary_part.done',
        ...common,
        summary_index: 0,
        part: item.summary[0],
      })
    } else {
      output += encode({
        type: item.content[0].type === 'refusal' ? 'response.refusal.done' : 'response.output_text.done',
        ...common,
        content_index: 0,
        ...(item.content[0].type === 'refusal'
          ? { refusal: entry.content.refusal || '' }
          : { text: entry.content.text || '' }),
      })
      output += encode({ type: 'response.content_part.done', ...common, content_index: 0, part: item.content[0] })
    }
    return output + encode({ type: 'response.output_item.done', output_index: index, item })
  }
  function push(event) {
    if (ended) return ''
    if (!object(event)) throw new Error('Invalid Antigravity stream event')
    const type = event.type || event.event
    if (type === 'thought_signature') {
      const entry = blocks.get(event.index)
      if (!entry) throw new Error('Antigravity signature references a missing content block')
      const signature = opaqueSignature(event.signature, 'thought_signature')
      const field = entry.content.type === 'thinking' ? 'signature' : 'thought_signature'
      if (entry.content[field] === signature) return ''
      if (entry.content[field]) throw new Error('Antigravity content block has conflicting thought signatures')
      entry.content[field] = signature
      if (protocol === 'anthropic.messages') {
        if (entry.content.type === 'thinking' && !entry.done)
          return encode({
            type: 'content_block_delta',
            index: event.index,
            delta: { type: 'signature_delta', signature },
          })
        // Provider metadata uses its own event; never send an invalid Anthropic
        // signature_delta on a text/tool block or after content_block_stop.
        return encode({ type: 'antigravity.thought_signature', index: event.index, signature })
      }
      if (protocol === 'openai.responses')
        return encode({
          type: 'response.thought_signature.delta',
          item_id: entry.item?.id,
          output_index: event.index,
          signature,
        })
      if (entry.content.type === 'tool_use')
        return chunk({ tool_calls: [{ index: entry.toolIndex, thought_signature: signature }] })
      return chunk(
        entry.content.type === 'thinking'
          ? { reasoning_signature: signature }
          : { thought_signature: signature, content_index: event.index },
      )
    }
    if (type === 'content_block_start') return begin(event.index, event.content_block)
    if (type === 'content_block_delta') return delta(event.index, event.delta)
    if (type === 'content_block_stop') return stop(event.index)
    if (type === 'text_delta' || type === 'thinking_delta') {
      const blockType = type === 'text_delta' ? 'text' : 'thinking'
      let index = [...blocks.entries()].findLast(([, entry]) => !entry.done && entry.content.type === blockType)?.[0]
      let output = ''
      if (index == null) {
        for (const [oldIndex, entry] of blocks) if (!entry.done) output += stop(oldIndex)
        index = blocks.size
        output += begin(index, blockType === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' })
      }
      return (
        output +
        delta(index, {
          type,
          ...(blockType === 'text'
            ? { text: event.text ?? event.delta ?? '' }
            : { thinking: event.thinking ?? event.text ?? event.delta ?? '' }),
        })
      )
    }
    if (type === 'tool_use') {
      let output = ''
      for (const [oldIndex, entry] of blocks) if (!entry.done) output += stop(oldIndex)
      const index = blocks.size
      const block = {
        type: 'tool_use',
        id: event.id,
        name: event.name,
        input: {},
        ...(event.thought_signature ? { thought_signature: event.thought_signature } : {}),
      }
      output += begin(index, block)
      output += delta(index, { type: 'input_json_delta', partial_json: JSON.stringify(event.input || {}) })
      return output + stop(index)
    }
    if (type === 'ping' || type === 'usage') return ''
    throw new Error(`Unsupported Antigravity stream event: ${String(type)}`)
  }
  function finish(result) {
    if (ended) return ''
    if (result.ok === false) return fail(result)
    let output = start()
    const content = resultContent(result)
    if (!blocks.size) {
      for (const block of content) {
        if (block.type === 'text') output += push({ type: 'text_delta', text: block.text || '' })
        else if (block.type === 'thinking') output += push({ type: 'thinking_delta', thinking: block.thinking || '' })
        else if (block.type === 'tool_use') output += push(block)
        else {
          const index = blocks.size
          output += begin(index, block)
          output += stop(index)
        }
      }
    }
    for (const [index, entry] of blocks) if (!entry.done) output += stop(index)
    const assembled = [...blocks.values()].map((entry) => entry.content)
    if (!isDeepStrictEqual(assembled, content)) {
      // Caller must not turn a partial or inconsistent upstream stream into a success.
      throw Object.assign(new Error('Final Antigravity content does not match its stream'), {
        code: 'antigravity_stream_mismatch',
      })
    }
    const stopReason = stopped(result, content)
    const usage = antigravityUsageForProtocol(protocol, result.usage)
    if (protocol === 'anthropic.messages')
      output +=
        encode({
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: result.stop_sequence ?? null },
          usage: usage || {},
        }) + encode({ type: 'message_stop' })
    else if (protocol === 'openai.responses') {
      const response = renderAntigravityResponse(protocol, result, { id: responseId, model, created })
      output += encode({
        type: response.status === 'incomplete' ? 'response.incomplete' : 'response.completed',
        response,
      })
    } else {
      output += chunk({}, claudeStopReasonToOpenAIFinish(stopReason))
      if (includeUsage)
        output += sse({
          id: responseId,
          object: protocol === 'openai.completions' ? 'text_completion' : 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage,
        })
      output += 'data: [DONE]\n\n'
    }
    ended = true
    return output
  }
  function fail(error) {
    if (ended) return ''
    ended = true
    const safe = publicError(error)
    if (protocol === 'anthropic.messages') return encode({ type: 'error', error: safe })
    if (protocol === 'openai.responses')
      return encode({
        type: 'response.failed',
        response: {
          id: responseId,
          object: 'response',
          created_at: created,
          model,
          status: 'failed',
          output: [],
          error: safe,
          usage: null,
        },
      })
    return sse({ error: safe })
  }
  return { id: responseId, start, push, finish, error: fail }
}
