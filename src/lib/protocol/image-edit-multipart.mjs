/**
 * `/v1/images/edits` multipart upload → native Images JSON, field for field like
 * codex-proxy-rs `gateway-api/src/openai/images/request.rs`. No I/O beyond parsing the buffer.
 */

const NUMERIC_FIELDS = new Set(['n', 'output_compression', 'partial_images'])

export function isMultipartFormData(contentType) {
  return (
    String(contentType || '')
      .split(';')[0]
      .trim()
      .toLowerCase() === 'multipart/form-data'
  )
}

function imageReference(bytes) {
  // Same as the official Original path: keep PNG / JPEG / WebP bytes; ignore file name and upload MIME.
  let mime = null
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mime = 'image/png'
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'image/jpeg'
  else if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP')
    mime = 'image/webp'
  if (!mime) throw new TypeError('Image edit uploads must be PNG, JPEG or WebP')
  return { image_url: `data:${mime};base64,${bytes.toString('base64')}` }
}

function scalarField(name, text) {
  if (NUMERIC_FIELDS.has(name)) {
    let value
    try {
      value = JSON.parse(text)
    } catch {}
    if (typeof value !== 'number') throw new TypeError('Image edit numeric fields must contain JSON numbers')
    return value
  }
  if (name === 'stream') {
    let value
    try {
      value = JSON.parse(text)
    } catch {}
    if (typeof value !== 'boolean') throw new TypeError('Image edit stream field must contain a JSON boolean')
    return value
  }
  // Other form fields keep their name and text; unknown fields are not dropped or rejected.
  return text
}

/**
 * @returns {Promise<{ ok: true, body: object } | { ok: false, message: string }>}
 */
export async function normalizeImageEditBody(buffer, contentType) {
  let form
  try {
    form = await new Request('http://local/', {
      method: 'POST',
      headers: { 'content-type': String(contentType) },
      body: buffer,
    }).formData()
  } catch {
    return { ok: false, message: 'Image edit multipart body is invalid' }
  }
  const body = {}
  const images = []
  try {
    for (const [name, value] of form.entries()) {
      const isFile = typeof value !== 'string'
      const bytes = isFile ? Buffer.from(await value.arrayBuffer()) : Buffer.from(value, 'utf8')
      if (name === 'image' || name === 'image[]') {
        // Upload order is part of the edit semantics.
        images.push(imageReference(bytes))
        continue
      }
      if (name === 'mask') {
        body.mask = imageReference(bytes)
        continue
      }
      if (isFile) throw new TypeError('Only image, image[] and mask may contain image files')
      body[name] = scalarField(name, value)
    }
  } catch (error) {
    return { ok: false, message: error.message }
  }
  if (!images.length) return { ok: false, message: 'Image edit multipart requires an image or image[] upload' }
  body.images = images
  return { ok: true, body }
}
