/**
 * OpenAI image_url content parts → Claude image content blocks
 */
import { ErrorCode, ErrorType, IMAGE_TOO_LARGE_MESSAGE } from '../core/errors.mjs'

export const MAX_IMAGE_DIMENSION = 8000
export const MANY_IMAGE_THRESHOLD = 20
export const MANY_IMAGE_MAX_DIMENSION = 3000

const HEADER_PROBE_B64_CHARS = 128
const JPEG_PROBE_B64_CHARS = 131_072
const DATA_URL_BASE64_RE = /^data:[^,]*;base64,(.+)$/is

function parseJpegDimensions(buf) {
  let offset = 2
  while (offset + 1 < buf.length) {
    if (buf[offset] !== 0xff) return null
    while (offset < buf.length && buf[offset] === 0xff) offset++
    if (offset >= buf.length) return { needMore: true }
    const marker = buf[offset++]
    if (marker === 0xd9 || marker === 0xda) return null
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (offset + 2 > buf.length) return { needMore: true }
    const len = buf.readUInt16BE(offset)
    if (len < 2) return null
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 7 > buf.length) return { needMore: true }
      const height = buf.readUInt16BE(offset + 3)
      const width = buf.readUInt16BE(offset + 5)
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (offset + len > buf.length) return { needMore: true }
    offset += len
  }
  return { needMore: true }
}

function parseImageBufferDimensions(buf) {
  if (!buf || buf.length < 10) return null
  // PNG: 8-byte signature + IHDR chunk
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a &&
    buf.toString('ascii', 12, 16) === 'IHDR'
  ) {
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    return width > 0 && height > 0 ? { width, height } : null
  }
  // GIF87a / GIF89a
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    const width = buf.readUInt16LE(6)
    const height = buf.readUInt16LE(8)
    return width > 0 && height > 0 ? { width, height } : null
  }
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X
  if (buf.length >= 25 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16)
    if (chunk === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      const width = buf.readUInt16LE(26) & 0x3fff
      const height = buf.readUInt16LE(28) & 0x3fff
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21)
      const width = (bits & 0x3fff) + 1
      const height = ((bits >> 14) & 0x3fff) + 1
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (chunk === 'VP8X' && buf.length >= 30) {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      return width > 0 && height > 0 ? { width, height } : null
    }
    return null
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return parseJpegDimensions(buf)
  }
  // BMP
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    const dibSize = buf.readUInt32LE(14)
    const width = dibSize === 12 ? buf.readUInt16LE(18) : Math.abs(buf.readInt32LE(18))
    const height = dibSize === 12 ? buf.readUInt16LE(20) : Math.abs(buf.readInt32LE(22))
    return width > 0 && height > 0 ? { width, height } : null
  }
  return null
}

/** Parse pixel dimensions from a PNG / JPEG / GIF / WebP / BMP buffer. */
export function parseImageDimensions(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : buf instanceof Uint8Array ? Buffer.from(buf) : null
  const dims = parseImageBufferDimensions(bytes)
  return dims && !dims.needMore ? dims : null
}

function decodeBase64Prefix(raw, maxChars) {
  const truncated = raw.length > maxChars
  const slice = truncated ? raw.slice(0, maxChars) : raw
  const clean = /\s/.test(slice) ? slice.replace(/\s+/g, '') : slice
  if (!clean) return null
  if (!truncated) return Buffer.from(clean, 'base64')
  const usable = clean.length - (clean.length % 4)
  if (usable < 4) return null
  return Buffer.from(clean.slice(0, usable), 'base64')
}

/** Fast base64 image dimension probe: decodes only header bytes unless JPEG SOF sits behind large metadata. */
export function parseBase64ImageDimensions(data) {
  if (typeof data !== 'string' || !data) return null
  const head = decodeBase64Prefix(data, HEADER_PROBE_B64_CHARS)
  const first = parseImageBufferDimensions(head)
  if (!first) return null
  if (!first.needMore) return first
  if (data.length > HEADER_PROBE_B64_CHARS) {
    const medium = decodeBase64Prefix(data, JPEG_PROBE_B64_CHARS)
    const second = parseImageBufferDimensions(medium)
    if (!second) return null
    if (!second.needMore) return second
  }
  if (data.length > JPEG_PROBE_B64_CHARS) {
    const full = parseImageBufferDimensions(Buffer.from(data, 'base64'))
    return full && !full.needMore ? full : null
  }
  return null
}

function base64FromDataUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null
  const match = url.match(DATA_URL_BASE64_RE)
  return match ? match[1] : null
}

function collectImageBlocks(blocks, prefix, out) {
  if (!Array.isArray(blocks)) return
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block || typeof block !== 'object') continue
    const at = `${prefix}.${i}`
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      collectImageBlocks(block.content, `${at}.content`, out)
      continue
    }
    if (block.type === 'image') {
      const source = block.source
      if (source?.type === 'base64' && typeof source.data === 'string') {
        out.push({ data: source.data, param: `${at}.image.source.base64.data` })
      } else if (source?.type === 'url' && typeof source.url === 'string') {
        out.push({ data: base64FromDataUrl(source.url), param: `${at}.image.source.url` })
      } else {
        out.push({ data: null, param: `${at}.image` })
      }
      continue
    }
    if (block.type === 'image_url' || block.type === 'input_image') {
      const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url || block.url
      out.push({ data: base64FromDataUrl(url), param: `${at}.${block.type}` })
    }
  }
}

function collectRequestImages(body) {
  const images = []
  if (Array.isArray(body?.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i]
      if (Array.isArray(msg?.content)) collectImageBlocks(msg.content, `messages.${i}.content`, images)
    }
  }
  if (Array.isArray(body?.input)) {
    for (let i = 0; i < body.input.length; i++) {
      const item = body.input[i]
      if (!item || typeof item !== 'object') continue
      if (item.type === 'image' || item.type === 'image_url' || item.type === 'input_image') {
        collectImageBlocks([item], 'input', images)
        images[images.length - 1].param = images[images.length - 1].param.replace(/^input\.0/, `input.${i}`)
        continue
      }
      if (Array.isArray(item.content)) collectImageBlocks(item.content, `input.${i}.content`, images)
      if (Array.isArray(item.output)) collectImageBlocks(item.output, `input.${i}.output`, images)
    }
  }
  return images
}

function imageTooLargeError({ param, width, height, maxDimension, imageCount }) {
  const code = ErrorCode.IMAGE_TOO_LARGE
  const message = IMAGE_TOO_LARGE_MESSAGE
  return Object.assign(new Error(message), {
    status: 400,
    code,
    body: {
      type: 'error',
      error: {
        type: ErrorType.INVALID_REQUEST,
        code,
        message,
        param,
        details: {
          retryable: false,
          width,
          height,
          max_dimension: maxDimension,
          image_count: imageCount,
        },
      },
    },
  })
}

/**
 * Anthropic rejects images wider/taller than 8000px, and lowers the cap to
 * 3000px when a request carries more than 20 images across history/tool_result.
 * Intercept at protocol inbound before burning a slot or hitting upstream.
 */
export function validateImageDimensions(
  body,
  {
    maxDimension = MAX_IMAGE_DIMENSION,
    manyImageThreshold = MANY_IMAGE_THRESHOLD,
    manyImageMaxDimension = MANY_IMAGE_MAX_DIMENSION,
  } = {},
) {
  if (!body || typeof body !== 'object') return
  const images = collectRequestImages(body)
  if (!images.length) return
  const limit = images.length > manyImageThreshold ? manyImageMaxDimension : maxDimension
  for (const entry of images) {
    if (!entry.data) continue
    const dims = parseBase64ImageDimensions(entry.data)
    if (!dims) continue
    if (dims.width > limit || dims.height > limit) {
      throw imageTooLargeError({
        param: entry.param,
        width: dims.width,
        height: dims.height,
        maxDimension: limit,
        imageCount: images.length,
      })
    }
  }
}

export function openaiImagePartToClaude(part) {
  // OpenAI: { type: 'image_url', image_url: { url: 'data:image/png;base64,...' | 'https://...' } }
  if (!part || part.type !== 'image_url') return null
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
  if (!url) return null

  if (url.startsWith('data:')) {
    const m = url.match(/^data:([^;]+);base64,(.+)$/s)
    if (!m) return null
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: m[1] || 'image/png',
        data: m[2],
      },
    }
  }

  // remote URL — Claude supports type:url on some endpoints
  return {
    type: 'image',
    source: {
      type: 'url',
      url,
    },
  }
}

/** Convert OpenAI message content (string | array) to Claude content blocks. */
export function openaiContentToClaudeContent(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) {
    const text = String(content ?? '')
    return text ? [{ type: 'text', text }] : []
  }

  const blocks = []
  for (const p of content) {
    if (typeof p === 'string') {
      if (p) blocks.push({ type: 'text', text: p })
      continue
    }
    if (p?.type === 'text' || p?.type === 'input_text') {
      const block = { type: 'text', text: p.text || '' }
      if (p.cache_control) block.cache_control = p.cache_control
      blocks.push(block)
      continue
    }
    if (p?.type === 'image_url') {
      const img = openaiImagePartToClaude(p)
      if (img) blocks.push(p.cache_control ? { ...img, cache_control: p.cache_control } : img)
      continue
    }
  }

  return blocks
}

/**
 * Native Messages callers still send OpenAI-shaped `image_url` parts, which
 * Anthropic rejects with `Input tag 'image_url' … does not match any of the
 * expected tags`. Only `convert.mjs` used to fix that, so the /v1/messages hop
 * passed them straight through.
 *
 * Parts carrying no usable url stay untouched: the upstream 400 should keep
 * naming the real defect instead of silently dropping the caller's image.
 */
export function normalizeImageContentBlocks(content, { inlineOnly = false } = {}) {
  if (!Array.isArray(content)) return content
  let changed = false
  const blocks = content.map((block) => {
    if (!block || typeof block !== 'object') return block
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const nested = normalizeImageContentBlocks(block.content, { inlineOnly })
      if (nested === block.content) return block
      changed = true
      return { ...block, content: nested }
    }
    if (block.type !== 'image_url') return block
    if (inlineOnly) {
      const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) return block
      if (typeof url !== 'string') throw invalidInlineImageUrl()
    }
    const image = openaiImagePartToClaude(block)
    if (inlineOnly) {
      const mediaType = image?.source.media_type?.toLowerCase()
      const data = image?.source.data
      const detail = block.image_url?.detail
      if (
        !/^image\/(jpeg|jpg|png|gif|webp)$/.test(mediaType || '') ||
        !data ||
        data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data) ||
        (detail !== undefined && detail !== 'auto')
      ) {
        throw invalidInlineImageUrl()
      }
      image.source.media_type = mediaType === 'image/jpg' ? 'image/jpeg' : mediaType
    }
    if (!image) return block
    changed = true
    return block.cache_control ? { ...image, cache_control: block.cache_control } : image
  })
  return changed ? blocks : content
}

function invalidInlineImageUrl() {
  const message = 'image_url must contain a supported base64 image data URL without a non-default detail'
  const code = 'invalid_image_url'
  return Object.assign(new Error(message), {
    status: 400,
    code,
    body: { type: 'error', error: { type: 'invalid_request_error', code, message, param: 'image_url' } },
  })
}

const IMAGE_FETCH_MS = 20_000
const IMAGE_FETCH_MAX = 8 * 1024 * 1024

function mediaTypeFrom(contentType, url) {
  const raw = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (raw.startsWith('image/')) return raw
  const ext = String(url || '')
    .split('?')[0]
    .split('.')
    .pop()
    ?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'png') return 'image/png'
  return 'image/png'
}

async function fetchImageAsBase64(url, fetchImpl) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), IMAGE_FETCH_MS)
  try {
    const res = await fetchImpl(url, { signal: ac.signal, redirect: 'follow' })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > IMAGE_FETCH_MAX) return null
    return {
      type: 'base64',
      media_type: mediaTypeFrom(res.headers.get('content-type'), url),
      data: buf.toString('base64'),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function remoteImageUrl(block) {
  if (!block || typeof block !== 'object') return ''
  const url =
    block.type === 'image' && block.source?.type === 'url'
      ? String(block.source.url || '')
      : block.type === 'image_url'
        ? typeof block.image_url === 'string'
          ? block.image_url
          : String(block.image_url?.url || '')
        : ''
  return /^https?:\/\//i.test(url) ? url : ''
}

function hasRemoteImage(block) {
  return block?.type === 'tool_result' && Array.isArray(block.content)
    ? block.content.some(hasRemoteImage)
    : !!remoteImageUrl(block)
}

async function materializeBlock(block, fetchImpl) {
  if (block?.type === 'tool_result' && Array.isArray(block.content)) {
    const nested = []
    for (const child of block.content) nested.push(await materializeBlock(child, fetchImpl))
    return { ...block, content: nested }
  }
  const url = remoteImageUrl(block)
  if (!url) return block
  const source = await fetchImageAsBase64(url, fetchImpl)
  if (!source) return block
  const image = { type: 'image', source }
  return block.cache_control ? { ...image, cache_control: block.cache_control } : image
}

/** Wrap CLI / SDK often reject `image.source.type=url`. Fetch to base64; leave URL if fetch fails. */
export async function materializeRemoteImageSources(body, { fetchImpl = fetch } = {}) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return body
  if (!body.messages.some((message) => Array.isArray(message?.content) && message.content.some(hasRemoteImage)))
    return body
  let changed = false
  const messages = []
  for (const msg of body.messages) {
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) {
      messages.push(msg)
      continue
    }
    const content = []
    for (const block of msg.content) {
      const next = await materializeBlock(block, fetchImpl)
      if (next !== block) changed = true
      content.push(next)
    }
    messages.push({ ...msg, content })
  }
  return changed ? { ...body, messages } : body
}
