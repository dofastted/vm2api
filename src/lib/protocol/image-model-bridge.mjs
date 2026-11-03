/**
 * Image models (`gpt-image-*`) named directly on Chat Completions or Responses. They are not
 * chat models, so the turn is served by the gateway's own Images endpoint
 * (`/v1/images/generations`, or `/v1/images/edits` when the last user message carries images)
 * and the result is answered in the caller's protocol. No I/O.
 */
import { randomBytes } from 'node:crypto'

export const IMAGE_MODEL_PROTOCOLS = Object.freeze(['openai.chat', 'openai.responses'])

// Images request options a chat client may set next to `model`; everything else is chat-only.
const IMAGE_OPTION_FIELDS = Object.freeze([
  'size',
  'quality',
  'background',
  'output_format',
  'output_compression',
  'moderation',
  'n',
  'input_fidelity',
])

const MIME_BY_FORMAT = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' })

function invalid(code, message, param = null) {
  return { ok: false, code, message, param }
}

function lastUserTurn(items) {
  if (!Array.isArray(items)) return null
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item && typeof item === 'object' && item.role === 'user' && (item.type == null || item.type === 'message')) {
      return item
    }
  }
  return null
}

/** Text and image references from one user message (Chat `image_url` or Responses `input_image`). */
function readUserContent(content) {
  if (typeof content === 'string') return { texts: [content], images: [] }
  const texts = []
  const images = []
  for (const part of Array.isArray(content) ? content : []) {
    if (!part || typeof part !== 'object') continue
    if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') texts.push(part.text)
    if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url === 'string' && url.trim()) images.push({ image_url: url.trim() })
    }
    if (part.type === 'input_image') {
      if (typeof part.image_url === 'string' && part.image_url.trim()) images.push({ image_url: part.image_url.trim() })
      else if (typeof part.file_id === 'string' && part.file_id.trim()) images.push({ file_id: part.file_id.trim() })
    }
  }
  return { texts, images }
}

function userContentOf(protocol, body) {
  if (protocol === 'openai.chat') return lastUserTurn(body.messages)?.content
  if (typeof body.input === 'string') return body.input
  return lastUserTurn(body.input)?.content
}

/**
 * Images request for an image-model turn: `{ ok, kind: 'generations'|'edits', body }`.
 * The prompt is the text of the last user message; its images make the call an edit.
 */
export function imagesRequestFromTurn(protocol, body) {
  if (!IMAGE_MODEL_PROTOCOLS.includes(protocol)) {
    return invalid(
      'model_not_supported',
      `model '${body?.model}' is an image model; use /v1/chat/completions, /v1/responses or /v1/images/generations`,
      'model',
    )
  }
  const { texts, images } = readUserContent(userContentOf(protocol, body))
  const prompt = texts
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n')
  if (!prompt) {
    return invalid(
      'prompt_required',
      `image model '${body.model}' needs a text prompt in the last user message`,
      protocol === 'openai.chat' ? 'messages' : 'input',
    )
  }
  const out = { model: body.model, prompt }
  for (const field of IMAGE_OPTION_FIELDS) {
    if (body[field] != null) out[field] = body[field]
  }
  if (images.length) out.images = images
  return { ok: true, kind: images.length ? 'edits' : 'generations', body: out }
}

function randomId(prefix) {
  return `${prefix}${randomBytes(12).toString('hex')}`
}

function generatedImages(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  return rows.filter((row) => row && (typeof row.b64_json === 'string' || typeof row.url === 'string'))
}

function chatUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const prompt = Number(usage.input_tokens) || 0
  const completion = Number(usage.output_tokens) || 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || prompt + completion,
  }
}

function responsesUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const input = Number(usage.input_tokens) || 0
  const output = Number(usage.output_tokens) || 0
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0, ...(usage.input_tokens_details || {}) },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0, ...(usage.output_tokens_details || {}) },
    total_tokens: Number(usage.total_tokens) || input + output,
  }
}

/** Markdown image list: what chat clients render for an assistant image. */
function chatContent(rows, format) {
  const mime = MIME_BY_FORMAT[String(format || 'png').toLowerCase()] || 'image/png'
  return rows
    .map((row, i) => `![image ${i + 1}](${row.b64_json ? `data:${mime};base64,${row.b64_json}` : row.url})`)
    .join('\n\n')
}

function sseData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function chatAnswer(payload, rows, { model, stream, includeUsage }) {
  const id = randomId('chatcmpl-')
  const created = Number(payload.created) || Math.floor(Date.now() / 1000)
  const content = chatContent(rows, payload.output_format)
  const usage = chatUsage(payload.usage)
  if (!stream) {
    return {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content, refusal: null },
          logprobs: null,
          finish_reason: 'stop',
        },
      ],
      ...(usage ? { usage } : {}),
    }
  }
  const chunk = (choices, extra = {}) =>
    sseData({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })
  return [
    chunk([{ index: 0, delta: { role: 'assistant', content }, logprobs: null, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }]),
    includeUsage && usage ? chunk([], { usage }) : '',
    'data: [DONE]\n\n',
  ].join('')
}

function responsesAnswer(payload, rows, { model, stream }) {
  const created = Number(payload.created) || Math.floor(Date.now() / 1000)
  const items = rows.map((row) => ({
    type: 'image_generation_call',
    id: randomId('ig_'),
    status: 'completed',
    result: row.b64_json ?? row.url,
    ...(typeof row.revised_prompt === 'string' ? { revised_prompt: row.revised_prompt } : {}),
    ...(payload.output_format ? { output_format: payload.output_format } : {}),
    ...(payload.size ? { size: payload.size } : {}),
    ...(payload.quality ? { quality: payload.quality } : {}),
    ...(payload.background ? { background: payload.background } : {}),
  }))
  const usage = responsesUsage(payload.usage)
  const response = {
    id: randomId('resp_'),
    object: 'response',
    created_at: created,
    status: 'completed',
    model,
    output: items,
    ...(usage ? { usage } : {}),
  }
  if (!stream) return response
  let sequence = 0
  const event = (type, data) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`
  const pending = { ...response, status: 'in_progress', output: [] }
  delete pending.usage
  const out = [event('response.created', { response: pending }), event('response.in_progress', { response: pending })]
  items.forEach((item, index) => {
    out.push(
      event('response.output_item.added', {
        output_index: index,
        item: { type: item.type, id: item.id, status: 'in_progress' },
      }),
      event('response.image_generation_call.completed', { output_index: index, item_id: item.id }),
      event('response.output_item.done', { output_index: index, item }),
    )
  })
  out.push(event('response.completed', { response }))
  return out.join('')
}

/**
 * Successful Images payload → the caller's protocol. `{ ok, body }` (JSON) or `{ ok, sse }`;
 * a payload without any image is `{ ok: false }`.
 */
export function imageModelAnswer(protocol, payload, { model, stream = false, includeUsage = false } = {}) {
  const rows = generatedImages(payload)
  if (!rows.length) return { ok: false, code: 'upstream_invalid_body', message: 'Images upstream returned no image' }
  const answer =
    protocol === 'openai.chat'
      ? chatAnswer(payload, rows, { model, stream, includeUsage })
      : responsesAnswer(payload, rows, { model, stream })
  return stream ? { ok: true, sse: answer } : { ok: true, body: answer }
}

/** In-stream error once SSE headers are committed. */
export function imageModelStreamError(protocol, payload) {
  const error = payload?.error && typeof payload.error === 'object' ? payload.error : {}
  const body = {
    type: error.type || 'api_error',
    code: error.code || 'upstream_error',
    message: error.message || 'Image generation failed',
  }
  if (protocol === 'openai.chat') return sseData({ error: body })
  return `event: error\ndata: ${JSON.stringify({ type: 'error', code: body.code, message: body.message, param: null })}\n\n`
}
