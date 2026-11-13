import { StringDecoder } from 'node:string_decoder'
import { isDeepStrictEqual } from 'node:util'
import { applyClaudeSSELineToMessage, createClaudeMessageAssembler } from './convert.mjs'
import { mergeUsage } from './openai-usage.mjs'

const RESULT_HEADER = 'x-kin-provider-result'
const MAX_METADATA_BYTES = 32 * 1024
const MAX_BUFFER_BYTES = 64 * 1024 * 1024
const STOPS = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
  'model_context_window_exceeded',
])
const PUBLIC_EVENTS = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'ping',
  'error',
])
const object = (value) => value != null && typeof value === 'object' && !Array.isArray(value)
const identity = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)
const toolBlock = (block) => block?.type === 'tool_use'

export function negotiateNativeHandoff(exec, { managedCrag, requestPath, envelope, requestContext } = {}) {
  return (
    managedCrag === true &&
    requestPath === '/internal/v1/messages' &&
    envelope?.request_context?.purpose !== 'auto_mode_classifier' &&
    requestContext?.purpose !== 'auto_mode_classifier' &&
    Array.isArray(exec?.workerStatus?.capabilities) &&
    exec.workerStatus.capabilities.includes('native_handoff_v1')
  )
}

function protocolError(code, message) {
  return Object.assign(new Error(message), { code, status: 502 })
}

function validateUsage(value, complete) {
  if (value == null) return !complete
  if (!object(value)) return false
  const valid = (item, depth = 0) => {
    if (depth > 8) return false
    if (item == null || typeof item === 'string' || typeof item === 'boolean') return true
    if (typeof item === 'number') return Number.isSafeInteger(item) && item >= 0
    if (Array.isArray(item)) return item.every((child) => valid(child, depth + 1))
    if (!object(item)) return false
    return Object.entries(item).every(
      ([key, child]) => !['__proto__', 'constructor', 'prototype'].includes(key) && valid(child, depth + 1),
    )
  }
  if (!valid(value)) return false
  for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    if (Object.hasOwn(value, key) && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return false
  }
  return (
    !complete || ['input_tokens', 'output_tokens'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
  )
}

function parseProviderResult(raw) {
  let value
  try {
    const encoded = typeof raw === 'string' ? raw : JSON.stringify(raw)
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_METADATA_BYTES) throw new Error('size')
    value = JSON.parse(encoded)
  } catch {
    throw protocolError('native_handoff_invalid', 'Invalid native provider result metadata')
  }
  const complete = value?.usage_complete === true
  if (
    !object(value) ||
    value.type !== 'kin_provider_result' ||
    typeof value.usage_complete !== 'boolean' ||
    !validateUsage(value.usage, complete) ||
    (complete
      ? !/^msg_[A-Za-z0-9_-]+$/.test(value.message_id || '') || !identity(value.model) || !STOPS.has(value.stop_reason)
      : (value.message_id != null && !/^msg_[A-Za-z0-9_-]+$/.test(value.message_id)) ||
        (value.model != null && !identity(value.model)) ||
        (value.stop_reason != null && !STOPS.has(value.stop_reason))) ||
    (value.stop_sequence != null && typeof value.stop_sequence !== 'string') ||
    (value.error != null &&
      (!object(value.error) || !identity(value.error.type) || typeof value.error.message !== 'string')) ||
    (value.http_status != null &&
      (!Number.isInteger(value.http_status) || value.http_status < 100 || value.http_status > 599)) ||
    (value.request_id != null && !identity(value.request_id))
  ) {
    throw protocolError('native_handoff_invalid', 'Invalid native provider identity, stop reason or usage')
  }
  const result = {
    type: value.type,
    message_id: value.message_id ?? null,
    model: value.model ?? null,
    stop_reason: value.stop_reason ?? null,
    stop_sequence: value.stop_sequence ?? null,
    usage: value.usage ?? null,
    usage_complete: value.usage_complete,
  }
  for (const key of ['stop_details', 'error', 'http_status', 'request_id']) {
    if (Object.hasOwn(value, key)) result[key] = value[key]
  }
  return result
}

/** One response's authenticated observations only; never a continuation/history ledger. */
export function createNativeHandoffState() {
  let providerResult = null
  let failure = null
  let observedUsage = null
  let observedModel = null
  let observedStop = null
  let observedError = null
  const messageIds = new Set()
  const models = new Set()
  const stops = new Set()
  const stopSequences = new Set()
  const checkIdentity = () => {
    if (!providerResult) return
    if (
      [...messageIds].some((id) => providerResult.message_id != null && id !== providerResult.message_id) ||
      [...models].some((model) => providerResult.model != null && model !== providerResult.model) ||
      [...stops].some((stop) => providerResult.stop_reason != null && stop !== providerResult.stop_reason) ||
      [...stopSequences].some((sequence) => sequence !== providerResult.stop_sequence)
    ) {
      throw protocolError('native_handoff_conflict', 'Native provider result conflicts with the delivered message')
    }
  }
  return {
    get providerResult() {
      return failure ? null : providerResult
    },
    get errorBody() {
      if (!failure && providerResult?.error)
        return {
          type: 'error',
          error: providerResult.error,
          ...(providerResult.request_id ? { request_id: providerResult.request_id } : {}),
        }
      return observedError
    },
    observeError(body) {
      if (body?.type === 'error') observedError = body
      else if (body?.error)
        observedError = {
          type: 'error',
          error: body.error,
          ...(body.request_id ? { request_id: body.request_id } : {}),
        }
    },
    get metadata() {
      const validated = this.providerResult
      return {
        nativeHandoff: true,
        providerResult: validated,
        usage: validated?.usage_complete ? validated.usage : mergeUsage(observedUsage, validated?.usage),
        model: validated?.model ?? observedModel,
        stopReason: validated?.stop_reason ?? observedStop,
      }
    },
    observeResult(raw) {
      try {
        const next = parseProviderResult(raw)
        if (providerResult && !isDeepStrictEqual(providerResult, next)) {
          throw protocolError('native_handoff_conflict', 'Conflicting native provider result metadata')
        }
        providerResult = next
        checkIdentity()
      } catch (error) {
        failure ||= error
      }
    },
    observeHeaders(headers = {}) {
      if (Object.hasOwn(headers, RESULT_HEADER)) this.observeResult(headers[RESULT_HEADER])
    },
    observeMessage(message) {
      if (!object(message)) return
      if (message.id != null) messageIds.add(message.id)
      if (message.model != null) {
        models.add(message.model)
        if (identity(message.model)) observedModel = message.model
      }
      if (message.stop_reason != null) {
        stops.add(message.stop_reason)
        if (STOPS.has(message.stop_reason)) observedStop = message.stop_reason
      }
      if (message.stop_sequence != null) stopSequences.add(message.stop_sequence)
      if (message.usage != null) {
        if (validateUsage(message.usage, false)) observedUsage = mergeUsage(observedUsage, message.usage)
        else failure ||= protocolError('native_handoff_invalid', 'Invalid observed native usage')
      }
      try {
        checkIdentity()
      } catch (error) {
        failure ||= error
      }
    },
    finish(body, { stream = false, sawMessageStop = false } = {}) {
      this.observeError(body)
      this.observeMessage(body?.type === 'error' ? null : body)
      if (this.errorBody) return this.errorBody
      if (failure) throw failure
      if (!providerResult) throw protocolError('native_handoff_missing', 'Native provider result metadata is missing')
      if (providerResult.error || !providerResult.usage_complete) {
        const error = providerResult.error || {
          type: 'api_error',
          code: 'native_handoff_incomplete',
          message: 'Native provider response is incomplete',
        }
        return { type: 'error', error, ...(providerResult.request_id ? { request_id: providerResult.request_id } : {}) }
      }
      if (body?.type === 'error' || body?.error) return body
      if (
        !object(body) ||
        body.type !== 'message' ||
        !Array.isArray(body.content) ||
        !body.id ||
        (stream && !sawMessageStop)
      ) {
        throw protocolError('native_handoff_incomplete', 'Native provider response ended before its message terminal')
      }
      const content =
        providerResult.stop_reason === 'tool_use' ? body.content : body.content.filter((block) => !toolBlock(block))
      if (providerResult.stop_reason === 'tool_use' && !content.some(toolBlock)) {
        throw protocolError('native_handoff_conflict', 'Native tool_use stop has no complete tool batch')
      }
      if (
        providerResult.stop_reason === 'tool_use' &&
        content.some(
          (block) =>
            toolBlock(block) &&
            (!identity(block.id) ||
              !identity(block.name) ||
              !object(block.input) ||
              Object.hasOwn(block, '_inputJson')),
        )
      ) {
        throw protocolError('native_handoff_invalid', 'Native tool batch has invalid identity or arguments')
      }
      return {
        ...body,
        content,
        model: providerResult.model,
        stop_reason: providerResult.stop_reason,
        stop_sequence: providerResult.stop_sequence,
        usage: providerResult.usage,
        ...(Object.hasOwn(providerResult, 'stop_details') ? { stop_details: providerResult.stop_details } : {}),
      }
    },
  }
}

/** Frame-level parser keeps internal metadata and ungranted tool arguments off the public stream. */
export async function consumeNativeHandoffStream(
  response,
  {
    state,
    deliveryMode,
    onEvent,
    onCommit,
    onObserve,
    onOutboundHeaders,
    restoreEvent,
    isCommitEvent,
    onProviderResult,
  } = {},
) {
  const decoder = new StringDecoder('utf8')
  const assembler = createClaudeMessageAssembler()
  const pending = []
  const publicPending = []
  const tools = new Set()
  const openBlocks = new Set()
  const toolJson = new Map()
  const publicIndices = new Map()
  let buffer = ''
  let frame = []
  let frameBytes = 0
  let bufferedBytes = 0
  let holding = deliveryMode === 'verified'
  let committed = false
  let sawMessageStop = false
  let lastError = null
  let headers = {}
  state.observeHeaders(response.headers)
  const dispatch = async (event) => {
    if (!onEvent) return
    await onEvent(`event: ${event.type}`)
    await onEvent(`data: ${JSON.stringify(event)}`)
    await onEvent('')
  }
  const commit = async () => {
    if (committed) return
    committed = true
    onCommit?.()
    for (const event of publicPending) await dispatch(event)
    publicPending.length = 0
  }
  const emit = async (event) => {
    let output = event
    if (Number.isInteger(event.index)) {
      if (!publicIndices.has(event.index)) publicIndices.set(event.index, publicIndices.size)
      output = { ...event, index: publicIndices.get(event.index) }
    }
    if (!committed) {
      publicPending.push(output)
      if (isCommitEvent?.(output)) await commit()
    } else await dispatch(output)
  }
  const acceptFrame = async () => {
    if (!frame.length) return
    const lines = frame
    frame = []
    frameBytes = 0
    const name = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim()
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) return
    let event
    try {
      event = JSON.parse(data)
    } catch {
      throw protocolError('native_handoff_invalid', 'Malformed native SSE frame')
    }
    if (name === 'kin_provider_result' || event?.type === 'kin_provider_result') {
      state.observeResult(event)
      if (state.providerResult) onProviderResult?.(state.providerResult)
      return
    }
    if (name === 'kin_outbound_headers' || event?.type === 'kin_outbound_headers') {
      onOutboundHeaders?.(event)
      return
    }
    if (!object(event) || !identity(event.type) || (name && name !== event.type)) {
      throw protocolError('native_handoff_invalid', 'Invalid native SSE event')
    }
    if (!PUBLIC_EVENTS.has(event.type) && event.type !== 'response_headers') {
      throw protocolError('native_handoff_invalid', 'Unexpected native Messages event')
    }
    if (restoreEvent) event = await restoreEvent(event)
    onObserve?.(event)
    if (event.type === 'response_headers') {
      if (object(event.headers)) {
        state.observeHeaders(event.headers)
        headers = { ...headers, ...event.headers }
      }
      return
    }
    if (event.type === 'message_start') {
      state.observeMessage(event.message)
      if (event.message?.content?.some(toolBlock)) holding = true
    }
    if (event.type === 'message_delta') state.observeMessage({ ...event.delta, usage: event.usage })
    if (event.type === 'content_block_start') {
      if (!Number.isInteger(event.index) || event.index < 0 || openBlocks.has(event.index))
        throw protocolError('native_handoff_invalid', 'Invalid native content block')
      openBlocks.add(event.index)
      if (toolBlock(event.content_block)) {
        tools.add(event.index)
        toolJson.set(event.index, '')
        holding = true
      }
    }
    if (event.type === 'content_block_delta' && (!Number.isInteger(event.index) || !openBlocks.has(event.index))) {
      throw protocolError('native_handoff_invalid', 'Native content delta has no open block')
    }
    if (event.type === 'content_block_delta' && tools.has(event.index) && event.delta?.type === 'input_json_delta') {
      toolJson.set(event.index, toolJson.get(event.index) + (event.delta.partial_json || ''))
    }
    if (event.type === 'content_block_stop') openBlocks.delete(event.index)
    if (event.type === 'error') {
      lastError = event
      state.observeError(event)
    }
    if (event.type === 'message_stop') sawMessageStop = true
    for (const line of [`data: ${JSON.stringify(event)}`, '']) applyClaudeSSELineToMessage(line, assembler)
    if (holding || ['message_start', 'message_delta', 'message_stop', 'error'].includes(event.type)) {
      pending.push(event)
      bufferedBytes += Buffer.byteLength(data)
      if (bufferedBytes > MAX_BUFFER_BYTES)
        throw protocolError('worker_response_too_large', 'Native stream buffer exceeds limit')
    } else {
      // Start must precede the first visible text frame, but never expose embedded tools.
      while (pending[0]?.type === 'message_start') await emit(pending.shift())
      await emit(event)
    }
  }
  for await (const chunk of response) {
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (Buffer.byteLength(buffer) > MAX_BUFFER_BYTES)
      throw protocolError('worker_response_too_large', 'Native SSE frame exceeds limit')
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line === '') await acceptFrame()
      else {
        frame.push(line)
        frameBytes += Buffer.byteLength(line)
        if (frameBytes > MAX_BUFFER_BYTES)
          throw protocolError('worker_response_too_large', 'Native SSE frame exceeds limit')
      }
    }
  }
  buffer += decoder.end()
  if (buffer) frame.push(buffer.replace(/\r$/, ''))
  await acceptFrame()
  state.observeHeaders(response.trailers)
  const body = state.finish(lastError || assembler.message, { stream: true, sawMessageStop })
  if (body.type !== 'error' && !body.error) {
    if (openBlocks.size && state.providerResult.stop_reason === 'tool_use')
      throw protocolError('native_handoff_incomplete', 'Native tool batch is incomplete')
    if (state.providerResult.stop_reason === 'tool_use') {
      for (const text of toolJson.values()) {
        if (!text) continue
        try {
          if (!object(JSON.parse(text))) throw new Error('tool input')
        } catch {
          throw protocolError('native_handoff_invalid', 'Native tool arguments are not a complete JSON object')
        }
      }
    }
    if (!pending.some((event) => event.type === 'message_delta')) {
      throw protocolError('native_handoff_incomplete', 'Native stream has no terminal message_delta')
    }
    for (const event of pending) {
      if (Number.isInteger(event.index) && tools.has(event.index) && state.providerResult.stop_reason !== 'tool_use')
        continue
      if (event.type === 'message_start') {
        await emit({
          ...event,
          message: {
            ...event.message,
            content: (event.message.content || []).filter(
              (block) => state.providerResult.stop_reason === 'tool_use' || !toolBlock(block),
            ),
          },
        })
      } else if (event.type === 'message_delta') {
        await emit({
          ...event,
          delta: { ...event.delta, stop_reason: body.stop_reason, stop_sequence: body.stop_sequence },
          usage: body.usage,
        })
      } else await emit(event)
    }
    await commit()
  }
  return { body, headers, sawMessageStop, committed }
}
