import http from 'node:http'
import path from 'node:path'

const MAX_REQUEST_BYTES = 256 * 1024
const MODEL = /^[a-z0-9][a-z0-9._-]{0,99}$/
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function unsupported() {
  throw Object.assign(new Error('The native Antigravity bridge accepts one new plain-text streaming turn.'), {
    status: 400,
    code: 'gemini_unsupported_turn',
  })
}

function only(value, fields) {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => fields.includes(key))
  )
}

function singleton(value) {
  return Array.isArray(value) && value.length === 1 ? value[0] : null
}

function textParts(parts, type) {
  if (!Array.isArray(parts)) unsupported()
  return parts
    .map((part) => {
      if (
        !only(part, type ? ['type', 'text'] : ['text']) ||
        (type && part.type !== type) ||
        typeof part.text !== 'string'
      ) {
        unsupported()
      }
      return part.text
    })
    .join('')
}

export function prepareGeminiNativeTurn({ protocol, body, model, requestId, stream }) {
  if (
    typeof model !== 'string' ||
    !MODEL.test(model) ||
    typeof requestId !== 'string' ||
    !REQUEST_ID.test(requestId) ||
    (stream !== undefined && stream !== true)
  ) {
    unsupported()
  }
  let text
  if (protocol === 'gemini') {
    if (stream !== true || !only(body, ['model', 'stream', 'contents'])) unsupported()
    if (
      (Object.hasOwn(body, 'stream') && body.stream !== true) ||
      (Object.hasOwn(body, 'model') && body.model !== model)
    ) {
      unsupported()
    }
    const message = singleton(body.contents)
    if (!only(message, ['role', 'parts']) || (Object.hasOwn(message, 'role') && message.role !== 'user')) unsupported()
    text = textParts(message.parts)
  } else if (protocol === 'anthropic' || protocol === 'openai-chat' || protocol === 'openai-responses') {
    const responses = protocol === 'openai-responses'
    const field = responses ? 'input' : 'messages'
    if (!only(body, ['model', 'stream', field]) || body.stream !== true || body.model !== model) unsupported()
    if (responses && typeof body.input === 'string') {
      text = body.input
    } else {
      const message = singleton(body[field])
      if (!only(message, responses ? ['type', 'role', 'content'] : ['role', 'content']) || message.role !== 'user') {
        unsupported()
      }
      if (responses && Object.hasOwn(message, 'type') && message.type !== 'message') unsupported()
      text =
        typeof message.content === 'string'
          ? message.content
          : textParts(message.content, responses ? 'input_text' : 'text')
    }
  } else {
    unsupported()
  }
  if (
    !/[^\p{White_Space}]/u.test(text) ||
    /(?:^|\p{White_Space})\//u.test(text) ||
    /[^\P{Cc}\n\r\t]/u.test(text) ||
    !text.isWellFormed()
  ) {
    unsupported()
  }
  const envelope = {
    request_id: requestId,
    stream: true,
    body: { model, contents: [{ role: 'user', parts: [{ text }] }] },
  }
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_REQUEST_BYTES) {
    throw Object.assign(new Error('The native Antigravity request exceeds 256 KiB.'), {
      status: 413,
      code: 'request_too_large',
    })
  }
  return envelope
}
export async function dispatchGeminiNativeTurn({ socketPath, internalToken, signal, ...turn }) {
  if (
    typeof socketPath !== 'string' ||
    !path.isAbsolute(socketPath) ||
    typeof internalToken !== 'string' ||
    !/^[!-~]{24,4096}$/.test(internalToken)
  ) {
    throw Object.assign(new Error('A trusted Antigravity worker socket is required.'), {
      status: 503,
      code: 'gemini_worker_unavailable',
    })
  }
  const body = JSON.stringify(prepareGeminiNativeTurn(turn))
  const deadline = AbortSignal.timeout(1_210_000)
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        method: 'POST',
        path: '/internal/v1/messages',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Kin-Internal-Token': internalToken,
        },
        signal: requestSignal,
      },
      resolve,
    )
    request.once('error', (error) => {
      if (signal?.aborted) return reject(error)
      if (deadline.aborted) {
        return reject(
          Object.assign(new Error('The Antigravity worker timed out.'), { status: 504, code: 'gemini_worker_timeout' }),
        )
      }
      reject(
        Object.assign(new Error('The Antigravity worker connection failed.'), {
          status: 502,
          code: 'gemini_worker_unavailable',
        }),
      )
    })
    request.end(body)
  })
}
