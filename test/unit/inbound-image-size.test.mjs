import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { classifyRequestError } from '../../src/lib/admin/error-class.mjs'
import { ErrorCode, IMAGE_TOO_LARGE_MESSAGE, mapUpstreamError } from '../../src/lib/core/errors.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import {
  MANY_IMAGE_MAX_DIMENSION,
  MAX_IMAGE_DIMENSION,
  parseBase64ImageDimensions,
  parseImageDimensions,
  validateImageDimensions,
} from '../../src/lib/protocol/images.mjs'
import { handleUserCountTokens } from '../../src/lib/protocol/user-count-tokens.mjs'

function makePng(width, height) {
  const buf = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function makeGif(width, height, version = 'GIF89a') {
  const buf = Buffer.alloc(10)
  buf.write(version, 0, 'ascii')
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf
}

function makeWebpVp8(width, height) {
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(22, 4)
  buf.write('WEBPVP8 ', 8, 'ascii')
  buf[23] = 0x9d
  buf[24] = 0x01
  buf[25] = 0x2a
  buf.writeUInt16LE(width & 0x3fff, 26)
  buf.writeUInt16LE(height & 0x3fff, 28)
  return buf
}

function makeWebpVp8l(width, height) {
  const buf = Buffer.alloc(25)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(17, 4)
  buf.write('WEBPVP8L', 8, 'ascii')
  buf[20] = 0x2f
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  buf.writeUInt32LE(bits >>> 0, 21)
  return buf
}

function makeWebpVp8x(width, height) {
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(22, 4)
  buf.write('WEBPVP8X', 8, 'ascii')
  const w = width - 1
  const h = height - 1
  buf[24] = w & 0xff
  buf[25] = (w >> 8) & 0xff
  buf[26] = (w >> 16) & 0xff
  buf[27] = h & 0xff
  buf[28] = (h >> 8) & 0xff
  buf[29] = (h >> 16) & 0xff
  return buf
}

function makeJpeg(width, height, { marker = 0xc0, exifPaddingBytes = 0, embedSmallThumb = false } = {}) {
  const chunks = [Buffer.from([0xff, 0xd8])]
  if (exifPaddingBytes > 0 || embedSmallThumb) {
    const payload = Buffer.alloc(Math.max(exifPaddingBytes, embedSmallThumb ? 32 : 0))
    if (embedSmallThumb) {
      // Embedded EXIF thumbnail with a tiny SOF0 that must be skipped.
      Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00]).copy(
        payload,
        8,
      )
    }
    const app1 = Buffer.alloc(4 + payload.length)
    app1[0] = 0xff
    app1[1] = 0xe1
    app1.writeUInt16BE(payload.length + 2, 2)
    payload.copy(app1, 4)
    chunks.push(app1)
  }
  const sof = Buffer.alloc(11)
  sof[0] = 0xff
  sof[1] = marker
  sof.writeUInt16BE(9, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3
  sof[10] = 1
  chunks.push(sof, Buffer.from([0xff, 0xd9]))
  return Buffer.concat(chunks)
}

function makeBmp(width, height) {
  const buf = Buffer.alloc(26)
  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(-height, 22)
  return buf
}

function pngBlock(width, height) {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: makePng(width, height).toString('base64'),
    },
  }
}

test('parseImageDimensions parses PNG, JPEG, GIF, WebP, BMP and ignores invalid buffers', () => {
  assert.deepEqual(parseImageDimensions(makePng(3200, 1800)), { width: 3200, height: 1800 })
  assert.deepEqual(parseImageDimensions(makeGif(1024, 768, 'GIF87a')), { width: 1024, height: 768 })
  assert.deepEqual(parseImageDimensions(makeGif(8001, 100, 'GIF89a')), { width: 8001, height: 100 })
  assert.deepEqual(parseImageDimensions(makeWebpVp8(3001, 2000)), { width: 3001, height: 2000 })
  assert.deepEqual(parseImageDimensions(makeWebpVp8l(4096, 2160)), { width: 4096, height: 2160 })
  assert.deepEqual(parseImageDimensions(makeWebpVp8x(9000, 3000)), { width: 9000, height: 3000 })
  assert.deepEqual(parseImageDimensions(makeJpeg(3500, 2200, { marker: 0xc2 })), { width: 3500, height: 2200 })
  assert.deepEqual(parseImageDimensions(makeBmp(2048, 4096)), { width: 2048, height: 4096 })
  assert.equal(parseImageDimensions(Buffer.from('not an image')), null)
  assert.equal(parseImageDimensions(Buffer.alloc(0)), null)
})

test('parseBase64ImageDimensions skips embedded JPEG EXIF thumbnail and handles large EXIF blocks', () => {
  const jpeg = makeJpeg(3400, 2600, { exifPaddingBytes: 2048, embedSmallThumb: true })
  assert.deepEqual(parseBase64ImageDimensions(jpeg.toString('base64')), { width: 3400, height: 2600 })
})

test('validateImageDimensions enforces 8000px for <=20 images and 3000px for >20 images', () => {
  assert.doesNotThrow(() =>
    validateImageDimensions({
      messages: [{ role: 'user', content: [pngBlock(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION)] }],
    }),
  )

  assert.throws(
    () =>
      validateImageDimensions({
        messages: [{ role: 'user', content: [pngBlock(MAX_IMAGE_DIMENSION + 1, 500)] }],
      }),
    (err) =>
      err.status === 400 &&
      err.code === ErrorCode.IMAGE_TOO_LARGE &&
      err.body.error.message === IMAGE_TOO_LARGE_MESSAGE &&
      err.body.error.param === 'messages.0.content.0.image.source.base64.data' &&
      err.body.error.details.retryable === false &&
      err.body.error.details.max_dimension === MAX_IMAGE_DIMENSION,
  )

  // Exactly 20 images still uses the 8000px limit.
  const twenty = Array.from({ length: 19 }, () => pngBlock(500, 500))
  twenty.push(pngBlock(4000, 2000))
  assert.doesNotThrow(() => validateImageDimensions({ messages: [{ role: 'user', content: twenty }] }))

  // 21 images (including nested tool_result and remote URLs) lowers the cap to 3000px.
  const manyMessages = Array.from({ length: 19 }, (_, idx) => ({
    role: 'user',
    content: [
      idx === 0
        ? { type: 'tool_result', tool_use_id: 't1', content: [pngBlock(600, 600)] }
        : { type: 'image', source: { type: 'url', url: `https://example.com/${idx}.png` } },
    ],
  }))
  manyMessages.push({ role: 'user', content: [pngBlock(MANY_IMAGE_MAX_DIMENSION, MANY_IMAGE_MAX_DIMENSION)] })
  manyMessages.push({ role: 'user', content: [pngBlock(3001, 1000)] })

  assert.throws(
    () => validateImageDimensions({ messages: manyMessages }),
    (err) =>
      err.status === 400 &&
      err.code === ErrorCode.IMAGE_TOO_LARGE &&
      err.body.error.message === IMAGE_TOO_LARGE_MESSAGE &&
      err.body.error.param === 'messages.20.content.0.image.source.base64.data' &&
      err.body.error.details.max_dimension === MANY_IMAGE_MAX_DIMENSION &&
      err.body.error.details.image_count === 21 &&
      err.body.error.details.width === 3001 &&
      err.body.error.details.height === 1000,
  )
})

test('validateImageDimensions covers OpenAI image_url and Responses input_image data URLs', () => {
  const bigDataUrl = `data:image/png;base64,${makePng(8001, 100).toString('base64')}`

  assert.throws(
    () =>
      validateImageDimensions({
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: bigDataUrl } }] }],
      }),
    (err) =>
      err.status === 400 &&
      err.body.error.code === ErrorCode.IMAGE_TOO_LARGE &&
      err.body.error.message === IMAGE_TOO_LARGE_MESSAGE,
  )

  assert.throws(
    () =>
      validateImageDimensions({
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: [{ type: 'input_image', image_url: bigDataUrl }],
          },
        ],
      }),
    (err) =>
      err.status === 400 &&
      err.body.error.code === ErrorCode.IMAGE_TOO_LARGE &&
      err.body.error.message === IMAGE_TOO_LARGE_MESSAGE &&
      err.body.error.param === 'input.0.output.0.input_image',
  )
})

async function createProtocolFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-image-size-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routing = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: { persona_preset: 'official_full', overlay_preset: 'off' },
  }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const logged = []
  let failoverCalls = 0
  let codexCalls = 0
  const handler = createHandleProtocol({
    json(res, status, body) {
      res.statusCode = status
      res.body = body
      res.emit('finish')
      return body
    },
    writeSSEHeaders() {},
    readBody: async (req) => structuredClone(req.body),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 10 * 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: {
      start: () => ({ request_id: 'req-img-1' }),
      finish: (_ctx, row) => logged.push(row),
    },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      async run() {
        failoverCalls++
        return { ok: true, status: 200, body: { type: 'message', role: 'assistant', content: [] } }
      },
    },
    codexOps: {
      streamCodexKernel: async () => {
        codexCalls++
        return { ok: true, status: 200, body: {} }
      },
    },
  })
  return {
    handler,
    logged,
    getFailoverCalls: () => failoverCalls,
    getCodexCalls: () => codexCalls,
  }
}

function fakeReqRes(body) {
  const req = Object.assign(new EventEmitter(), { headers: {}, body })
  const res = Object.assign(new EventEmitter(), { statusCode: 0, body: null, headersSent: false })
  return { req, res }
}

test('handleProtocol intercepts oversized images at inbound for Anthropic Messages, OpenAI Chat, and Responses', async (t) => {
  const fx = await createProtocolFixture(t)

  // 1. Anthropic Messages with 21 images where one exceeds 3000px
  const messages = Array.from({ length: 20 }, () => ({ role: 'user', content: [pngBlock(800, 600)] }))
  messages.push({ role: 'user', content: [pngBlock(3001, 1200)] })
  const r1 = fakeReqRes({ model: 'claude-sonnet-4-6', max_tokens: 128, messages })
  await fx.handler.handleProtocol(r1.req, r1.res, 'anthropic.messages', '/v1/messages')
  assert.equal(r1.res.statusCode, 400)
  assert.equal(r1.res.body.error.code, ErrorCode.IMAGE_TOO_LARGE)
  assert.equal(r1.res.body.error.message, IMAGE_TOO_LARGE_MESSAGE)
  assert.equal(r1.res.body.error.details.retryable, false)
  assert.equal(fx.getFailoverCalls(), 0)
  assert.equal(fx.logged.at(-1).error_code, ErrorCode.IMAGE_TOO_LARGE)
  assert.equal(fx.logged.at(-1).error_message, IMAGE_TOO_LARGE_MESSAGE)

  // 2. OpenAI Chat targeting Claude with oversized image_url
  const bigDataUrl = `data:image/png;base64,${makePng(9000, 1000).toString('base64')}`
  const r2 = fakeReqRes({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: bigDataUrl } }] }],
  })
  await fx.handler.handleProtocol(r2.req, r2.res, 'openai.chat', '/v1/chat/completions')
  assert.equal(r2.res.statusCode, 400)
  assert.equal(r2.res.body.error.code, ErrorCode.IMAGE_TOO_LARGE)
  assert.equal(r2.res.body.error.message, IMAGE_TOO_LARGE_MESSAGE)
  assert.equal(fx.getFailoverCalls(), 0)

  // 3. OpenAI Responses targeting Claude with oversized input_image
  const r3 = fakeReqRes({
    model: 'claude-sonnet-4-6',
    input: [{ role: 'user', content: [{ type: 'input_image', image_url: bigDataUrl }] }],
  })
  await fx.handler.handleProtocol(r3.req, r3.res, 'openai.responses', '/v1/responses')
  assert.equal(r3.res.statusCode, 400)
  assert.equal(r3.res.body.error.code, ErrorCode.IMAGE_TOO_LARGE)
  assert.equal(r3.res.body.error.message, IMAGE_TOO_LARGE_MESSAGE)
  assert.equal(fx.getFailoverCalls(), 0)
  // 4. OpenAI/Codex model is not blocked by Anthropic's pixel cap
  const manyOpenai = Array.from({ length: 21 }, () => ({
    type: 'input_image',
    image_url: `data:image/png;base64,${makePng(3500, 1200).toString('base64')}`,
  }))
  const r4 = fakeReqRes({
    model: 'gpt-5.4',
    input: [{ role: 'user', content: manyOpenai }],
  })
  await fx.handler.handleProtocol(r4.req, r4.res, 'openai.responses', '/v1/responses')
  assert.notEqual(r4.res.body?.error?.code, ErrorCode.IMAGE_TOO_LARGE)
})

test('handleUserCountTokens intercepts oversized images before pool lookup', async () => {
  let poolLookups = 0
  const req = { headers: {} }
  const res = { statusCode: 0, body: null }
  await handleUserCountTokens(req, res, {
    requireAuth: () => true,
    json: (r, status, body) => {
      r.statusCode = status
      r.body = body
    },
    readBody: async () => ({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [pngBlock(8001, 500)] }],
    }),
    cfg: { limits: { max_body_bytes: 1024 * 1024 } },
    getPoolScheduler: () => {
      poolLookups++
      return null
    },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, ErrorCode.IMAGE_TOO_LARGE)
  assert.equal(res.body.error.message, IMAGE_TOO_LARGE_MESSAGE)
  assert.equal(poolLookups, 0)
})

test('mapUpstreamError normalizes upstream Anthropic image dimension errors and error-class classifies them as request', () => {
  const mapped = mapUpstreamError(400, {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message:
        'messages.409.content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels',
    },
  })
  assert.equal(mapped.status, 400)
  assert.equal(mapped.body.error.code, ErrorCode.IMAGE_TOO_LARGE)
  assert.equal(mapped.body.error.message, IMAGE_TOO_LARGE_MESSAGE)
  assert.equal(mapped.body.error.details.retryable, false)

  const classified = classifyRequestError({
    status: 400,
    error_code: ErrorCode.IMAGE_TOO_LARGE,
    error_message: IMAGE_TOO_LARGE_MESSAGE,
  })
  assert.equal(classified?.error_class, 'request')
  assert.equal(classified?.error_owner, 'client')
})
