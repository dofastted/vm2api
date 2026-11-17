/**
 * OpenAI image_url content parts → Claude image content blocks
 */

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
