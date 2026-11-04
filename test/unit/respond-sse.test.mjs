import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { applySseSocketTuning, createRespond, parseRequestUrl, readBody } from '../../src/lib/http/respond.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

test('applySseSocketTuning flushes headers and enables TCP_NODELAY', () => {
  let flushed = false
  let nodelay = null
  const res = {
    flushHeaders() {
      flushed = true
    },
    socket: {
      setNoDelay(v) {
        nodelay = v
      },
    },
  }
  applySseSocketTuning(res, { tcpNodelay: true })
  assert.equal(flushed, true)
  assert.equal(nodelay, true)
})

test('parseRequestUrl keeps the path when Host is an unbracketed IPv6 or non-ASCII name', () => {
  assert.equal(parseRequestUrl({ url: '/cc', headers: { host: '::1' } }).pathname, '/cc')
  assert.equal(parseRequestUrl({ url: '/cc#/login', headers: { host: '用户.local' } }).pathname, '/cc')
  assert.equal(parseRequestUrl({ url: '/health', headers: { host: '127.0.0.1:8787' } }).pathname, '/health')
  assert.equal(parseRequestUrl({ url: 'http://[', headers: { host: '127.0.0.1' } }), null)
  assert.equal(parseRequestUrl({ url: '/cc', headers: {} }).pathname, '/cc')
})

test('writeSSEHeaders uses optional tcpNodelay getter', () => {
  let nodelay = null
  const { writeSSEHeaders } = createRespond({ rewrite: { enabled: false } }, { tcpNodelay: () => false })
  const res = {
    writeHead() {},
    flushHeaders() {},
    socket: {
      setNoDelay(v) {
        nodelay = v
      },
    },
  }
  writeSSEHeaders(res)
  assert.equal(nodelay, null)
})

test('json marks non-retryable policy errors for clients', () => {
  const { json } = createRespond({ rewrite: { enabled: false } })
  let status = null
  let headers = null
  let body = null
  const res = {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus
      headers = nextHeaders
    },
    end(nextBody) {
      body = JSON.parse(nextBody)
    },
  }
  json(res, 400, { error: { code: 'refusal_guard', details: { retryable: false } } })
  assert.equal(status, 400)
  assert.equal(headers['x-should-retry'], 'false')
  assert.deepEqual(body.error.details, { retryable: false })
})

test('default max body fallback is 128MB', () => {
  const src = fs.readFileSync(new URL('../../src/lib/core/config.mjs', import.meta.url), 'utf8')
  assert.match(src, /KIN_MAX_BODY \|\| 128 \* 1024 \* 1024/)
})

test('oversized protocol body returns 413 before scheduling', async () => {
  let scheduled = false
  const { handleProtocol } = createHandleProtocol({
    cfg: { limits: { max_body_bytes: 8 }, rewrite: { enabled: false } },
    json(res, status, body) {
      res.statusCode = status
      res.body = body
    },
    readBody,
    requireAuth: () => true,
    requestLog: {
      start: () => ({ request_id: 'req-413' }),
      finish() {},
    },
    stats: { errors: 0 },
    groupsRepo: { rateMultiplier: () => 1 },
    getFailoverRunner() {
      scheduled = true
      throw new Error('scheduler called')
    },
  })
  const req = Readable.from([
    Buffer.from('{"model":"claude-sonnet-5","messages":[{"role":"user","content":"hello hello"}]}'),
  ])
  req.headers = {}
  const res = new EventEmitter()
  res.statusCode = 0
  res.body = null
  await handleProtocol(req, res, 'anthropic.messages', '/v1/messages')
  assert.equal(scheduled, false)
  assert.equal(res.statusCode, 413)
  assert.equal(res.body.error.code, 'body_too_large')
})
