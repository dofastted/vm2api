import test from 'node:test'
import assert from 'node:assert/strict'
import { isMultipartFormData, normalizeImageEditBody } from '../../src/lib/protocol/image-edit-multipart.mjs'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')])

async function encode(fields) {
  const form = new FormData()
  for (const [name, value, filename] of fields) {
    if (Buffer.isBuffer(value)) form.append(name, new Blob([value]), filename || 'upload.bin')
    else form.append(name, value)
  }
  const req = new Request('http://local/', { method: 'POST', body: form })
  return { buffer: Buffer.from(await req.arrayBuffer()), contentType: req.headers.get('content-type') }
}

const dataUrl = (mime, bytes) => `data:${mime};base64,${bytes.toString('base64')}`

test('isMultipartFormData checks the media type only', () => {
  assert.equal(isMultipartFormData('multipart/form-data; boundary=x'), true)
  assert.equal(isMultipartFormData(' Multipart/Form-Data '), true)
  assert.equal(isMultipartFormData('application/json'), false)
  assert.equal(isMultipartFormData(undefined), false)
})

test('images keep upload order; mask, numbers, booleans and text map like codex-proxy-rs', async () => {
  const { buffer, contentType } = await encode([
    ['model', 'gpt-image-2.5-sunburst'],
    ['image[]', PNG, 'a.txt'],
    ['prompt', '把天空改成黄昏'],
    ['image[]', JPEG],
    ['image', WEBP],
    ['mask', PNG],
    ['n', '2'],
    ['output_compression', '80'],
    ['stream', 'false'],
    ['quality', 'high'],
  ])
  const out = await normalizeImageEditBody(buffer, contentType)
  assert.equal(out.ok, true)
  assert.deepEqual(out.body, {
    model: 'gpt-image-2.5-sunburst',
    prompt: '把天空改成黄昏',
    mask: { image_url: dataUrl('image/png', PNG) },
    n: 2,
    output_compression: 80,
    stream: false,
    quality: 'high',
    images: [
      { image_url: dataUrl('image/png', PNG) },
      { image_url: dataUrl('image/jpeg', JPEG) },
      { image_url: dataUrl('image/webp', WEBP) },
    ],
  })
})

test('rejects bad uploads with the codex-proxy-rs messages', async () => {
  const cases = [
    [[['image', Buffer.from('GIF89a')]], /PNG, JPEG or WebP/],
    [
      [
        ['image', PNG],
        ['n', 'two'],
      ],
      /numeric fields/,
    ],
    [
      [
        ['image', PNG],
        ['stream', 'yes'],
      ],
      /JSON boolean/,
    ],
    [
      [
        ['image', PNG],
        ['prompt', PNG],
      ],
      /Only image, image\[\] and mask/,
    ],
    [[['prompt', 'no image']], /requires an image/],
  ]
  for (const [fields, message] of cases) {
    const { buffer, contentType } = await encode(fields)
    const out = await normalizeImageEditBody(buffer, contentType)
    assert.equal(out.ok, false)
    assert.match(out.message, message)
  }
})

test('a broken multipart body is a request error', async () => {
  const out = await normalizeImageEditBody(Buffer.from('not multipart'), 'multipart/form-data; boundary=zzz')
  assert.deepEqual(out, { ok: false, message: 'Image edit multipart body is invalid' })
})
