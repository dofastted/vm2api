import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { isMainThread } from 'node:worker_threads'
import { callGoWorker, streamGoWorker } from '../../src/lib/transport/go-worker-client.mjs'
import { callRustKernel } from '../../src/lib/transport/rust-kernel-client.mjs'
import { callCodexKernel } from '../../src/lib/transport/codex-kernel-client.mjs'
import { inferenceCodec } from '../../src/lib/transport/inference-codec.mjs'

async function fixture(t, handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codec-'))
  const socket = path.join(root, 'worker.sock')
  const token = path.join(root, 'internal.token')
  fs.writeFileSync(token, 'codec-test-token\n')
  const server = http.createServer((req, res) => {
    res.shouldKeepAlive = false
    return handler(req, res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve)
    })
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    vmId: 'codec-slot',
    vm: {
      runtime: {
        worker_socket: socket,
        kernel_socket: socket,
        codex_kernel_socket: socket,
        worker_token_file: token,
        worker_run_dir: root,
      },
    },
  }
}

async function requestBytes(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const text = '你好🧪\\\n"'.repeat(40000)
const largeEnvelope = { body: { input: text }, headers: { 'session-id': 'codec-session' }, stream: false }

test('bounded codec on the real slot Unix-socket inference path', {
  skip: process.platform === 'win32',
  timeout: 30000,
}, async (t) => {
  const createWorker = inferenceCodec.createWorker
  const operations = []
  let crashOperation = null
  let abortEncode = null
  inferenceCodec.createWorker = () => {
    const worker = createWorker()
    const postMessage = worker.postMessage.bind(worker)
    worker.postMessage = (job, transfer) => {
      operations.push(job.operation)
      if (crashOperation === job.operation) {
        crashOperation = null
        void worker.terminate()
        return
      }
      const result = postMessage(job, transfer)
      if (job.operation === 'encode' && abortEncode) {
        const controller = abortEncode
        abortEncode = null
        controller.abort()
      }
      return result
    }
    return worker
  }
  t.after(async () => {
    inferenceCodec.createWorker = createWorker
    await inferenceCodec.close()
  })

  for (const call of [callGoWorker, callRustKernel, callCodexKernel]) {
    await t.test(`${call.name} preserves envelope bytes, auth, route and buffered JSON`, async (t) => {
      const before = operations.length
      let requests = 0
      const response = { type: 'message', model: 'codec-test', content: [{ type: 'text', text }] }
      const exec = await fixture(t, async (req, res) => {
        requests++
        const raw = await requestBytes(req)
        const received = JSON.parse(raw)
        assert.deepEqual(raw, Buffer.from(JSON.stringify({ ...largeEnvelope, request_id: received.request_id })))
        assert.equal(req.headers['content-length'], String(raw.length))
        assert.equal(req.headers['x-kin-internal-token'], 'codec-test-token')
        assert.equal(req.headers['x-internal-token'], 'codec-test-token')
        assert.equal(req.url, call === callCodexKernel ? '/internal/v1/codex/responses' : '/internal/v1/messages')
        res.end(JSON.stringify(response))
      })
      const result = await call({ exec, envelope: largeEnvelope })
      assert.equal(result.ok, true)
      assert.deepEqual(result.body, response)
      assert.equal(requests, 1)
      assert.deepEqual(operations.slice(before), ['encode', 'decode'])
    })
  }

  await t.test('normal prepared inference bodies also use the codec', async (t) => {
    const before = operations.length
    const exec = await fixture(t, async (req, res) => {
      const received = JSON.parse(await requestBytes(req))
      assert.equal(received.body.model, 'claude-test')
      assert.ok(JSON.stringify(received.body.messages).includes('你好🧪'))
      assert.equal(typeof received.request_id, 'string')
      res.end('{"type":"message","content":[]}')
    })
    const result = await callGoWorker({
      exec,
      body: { model: 'claude-test', messages: [{ role: 'user', content: text }] },
    })
    assert.equal(result.ok, true)
    assert.deepEqual(operations.slice(before), ['encode'])
  })

  await t.test('SSE framing, callback ordering, commit and trailers stay on main', async (t) => {
    const before = operations.length
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg-codec', type: 'message', role: 'assistant', model: 'codec-test', content: [] },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    const wire = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    const exec = await fixture(t, async (req, res) => {
      await requestBytes(req)
      assert.equal(req.headers.te, 'trailers')
      res.writeHead(200, { 'content-type': 'text/event-stream', trailer: 'x-terminal-state, x-usage' })
      for (let offset = 0; offset < wire.length; offset += 17) res.write(wire.slice(offset, offset + 17))
      res.addTrailers({ 'x-terminal-state': 'verified', 'x-usage': '{"input_tokens":3,"output_tokens":1}' })
      res.end()
    })
    const timeline = []
    const result = await streamGoWorker({
      exec,
      envelope: { ...largeEnvelope, stream: true },
      onCommit() {
        assert.equal(isMainThread, true)
        timeline.push('commit')
      },
      async onEvent(line) {
        assert.equal(isMainThread, true)
        await Promise.resolve()
        timeline.push(line)
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.committed, true)
    assert.equal(result.terminalState, 'verified')
    assert.equal(result.body.content[0].text, 'hello')
    assert.equal(result.usage.input_tokens, 3)
    assert.equal(timeline[0], 'commit')
    assert.equal(timeline.filter((item) => item === 'commit').length, 1)
    assert.deepEqual(
      timeline.filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5))),
      events,
    )
    assert.deepEqual(operations.slice(before), ['encode'])
  })

  for (const call of [callGoWorker, streamGoWorker]) {
    await t.test(`${call.name} enforces exact large UTF-8 413 limits before sending`, async (t) => {
      let requests = 0
      const exec = await fixture(t, async (req, res) => {
        requests++
        await requestBytes(req)
        res.writeHead(413)
        res.end('plain text kernel limit')
      })
      const bytes = Buffer.byteLength(JSON.stringify({ ...largeEnvelope, request_id: 'x'.repeat(36) }))
      const rejected = await call({ exec, envelope: largeEnvelope, maxRequestBytes: bytes - 1 })
      assert.equal(rejected.status, 413)
      assert.equal(rejected.transportError, false)
      assert.equal(rejected.body.error.code, 'body_too_large')
      assert.equal(rejected.body.error.details.retryable, false)
      assert.equal(requests, 0)
      const reached = await call({ exec, envelope: largeEnvelope, maxRequestBytes: bytes })
      assert.equal(reached.status, 413)
      assert.equal(reached.body.error.code, 'body_too_large')
      assert.equal(requests, 1)
    })

    await t.test(`${call.name} retains the main-thread HTTP timeout with a threaded envelope`, async (t) => {
      let requests = 0
      const exec = await fixture(t, async (req) => {
        requests++
        await requestBytes(req)
      })
      const result = await call({ exec, envelope: largeEnvelope, timeoutMs: 200 })
      assert.equal(result.ok, false)
      assert.equal(result.body.error.code, 'worker_timeout')
      assert.equal(requests, 1)
    })
  }

  await t.test('streaming HTTP errors decode large buffered JSON without changing structured 413', async (t) => {
    const before = operations.length
    const response = { error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: text } }
    const exec = await fixture(t, async (req, res) => {
      await requestBytes(req)
      res.writeHead(413, { 'content-type': 'application/json' })
      res.end(JSON.stringify(response))
    })
    const result = await streamGoWorker({ exec, envelope: largeEnvelope })
    assert.equal(result.status, 413)
    assert.equal(result.committed, false)
    assert.equal(result.transportError, false)
    assert.deepEqual(result.body, response)
    assert.deepEqual(operations.slice(before), ['encode', 'decode'])
  })

  for (const operation of ['encode', 'decode']) {
    await t.test(`${operation} worker exit never retries the HTTP request`, async (t) => {
      inferenceCodec.restartAt = 0
      let requests = 0
      const exec = await fixture(t, async (req, res) => {
        requests++
        await requestBytes(req)
        res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text }] }))
      })
      crashOperation = operation
      const result = await callGoWorker({ exec, envelope: largeEnvelope })
      assert.equal(crashOperation, null)
      assert.equal(result.ok, true)
      assert.equal(result.body.content[0].text, text)
      assert.equal(requests, 1)
    })
  }

  await t.test('aborted pre-send work never emits an inference or cancel RPC', async (t) => {
    inferenceCodec.restartAt = 0
    let requests = 0
    const exec = await fixture(t, (req, res) => {
      requests++
      req.resume()
      res.end('{}')
    })
    const early = new AbortController()
    early.abort()
    const preAborted = await streamGoWorker({ exec, envelope: largeEnvelope, signal: early.signal })
    assert.equal(preAborted.body.error.code, 'client_cancelled')
    const controller = new AbortController()
    abortEncode = controller
    const result = await streamGoWorker({ exec, envelope: largeEnvelope, signal: controller.signal })
    assert.equal(abortEncode, null)
    assert.equal(result.body.error.code, 'client_cancelled')
    assert.equal(result.committed, false)
    assert.equal(requests, 0)
  })

  await t.test(
    'abort after send names exactly the sent inference job for cancellation',
    { timeout: 5000 },
    async (t) => {
      let requestId
      let started
      let cancelled
      const sawRequest = new Promise((resolve) => {
        started = resolve
      })
      const sawCancel = new Promise((resolve) => {
        cancelled = resolve
      })
      const exec = await fixture(t, async (req, res) => {
        const payload = JSON.parse(await requestBytes(req))
        if (req.url === '/internal/v1/cancel') {
          assert.equal(payload.request_id, requestId)
          res.end('{}', cancelled)
          return
        }
        requestId = payload.request_id
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.flushHeaders()
        started()
      })
      const controller = new AbortController()
      const pending = streamGoWorker({ exec, envelope: largeEnvelope, signal: controller.signal })
      await sawRequest
      controller.abort()
      const result = await pending
      await sawCancel
      assert.equal(result.body.error.code, 'client_cancelled')
      assert.equal(result.committed, false)
    },
  )
})
