import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callGoWorker, streamGoWorker } from '../../src/lib/transport/go-worker-client.mjs'
import { callCodexKernel, streamCodexKernel } from '../../src/lib/transport/codex-kernel-client.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test
function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(t, handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-exec-'))
  const socket = path.join(root, 'worker.sock')
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { vmId: 'vm-execution', vm: { runtime: { worker_socket: socket, codex_kernel_socket: socket } } }
}

const envelope = { body: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] }, headers: {} }

for (const [name, invoke] of [
  ['HTTP', callGoWorker],
  ['SSE', streamGoWorker],
  ['Codex HTTP', callCodexKernel],
  ['Codex SSE', streamCodexKernel],
]) {
  for (const message of [
    'provider error: client disconnected',
    "provider error: client disconnected; You've hit your limit (429)",
    'provider error: internal transport timeout',
    'provider error: failed to read CLI response',
  ]) {
    unixTest(`${name} complete kernel error '${message}' does not prove execution end`, async (t) => {
      const exec = await fixture(t, (_req, res) => {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ ok: false, error: { type: 'worker_error', code: 'provider_error', message, status: 502 } }),
        )
      })
      const result = await invoke({ exec, envelope })
      assert.equal(result.execution.started, true)
      assert.equal(result.execution.ended, false)
      assert.equal(result.execution.reason, 'kernel_execution_unconfirmed')
      assert.equal(result.transportError, false, 'the HTTP response itself completed')
    })
  }
  unixTest(`${name} recognized provider rejection still permits EOF completion`, async (t) => {
    const exec = await fixture(t, (_req, res) => {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: { type: 'worker_error', code: 'provider_error', message: "provider error: You've hit your limit" },
        }),
      )
    })
    const result = await invoke({ exec, envelope })
    assert.equal(result.status, 429)
    assert.equal(result.execution.ended, true)
    assert.equal(result.execution.reason, 'eof')
  })
  unixTest(`${name} ordinary explicit provider rejection retains EOF completion`, async (t) => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 529]) {
      const exec = await fixture(t, (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: { type: 'worker_error', code: 'provider_error', message: 'provider rejected the request', status },
          }),
        )
      })
      const result = await invoke({ exec, envelope })
      assert.equal(result.execution.ended, true, `ordinary ${status} rejection is complete`)
    }
  })
}

for (const [name, invoke] of [
  ['SSE', streamGoWorker],
  ['Codex SSE', streamCodexKernel],
]) {
  unixTest(`${name} kernel error event followed by EOF keeps termination unknown`, async (t) => {
    const exec = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: {
            type: 'worker_error',
            code: 'provider_error',
            message: 'provider error: client disconnected',
          },
        })}\n\n`,
      )
    })
    const result = await invoke({ exec, envelope })
    assert.equal(result.execution.ended, false)
    assert.equal(result.execution.reason, 'kernel_execution_unconfirmed')
  })
}

for (const [name, invoke] of [
  ['HTTP', callGoWorker],
  ['SSE', streamGoWorker],
]) {
  unixTest(
    `${name} exposes the actual hop ID and awaits durable binding before submitting`,
    { timeout: 2000 },
    async (t) => {
      let calls = 0
      let wireId
      const entered = deferred()
      const bound = deferred()
      const exec = await fixture(t, async (req, res) => {
        calls++
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        wireId = JSON.parse(Buffer.concat(chunks).toString()).request_id
        if (name === 'HTTP') res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'ok' }] }))
        else {
          res.setHeader('content-type', 'text/event-stream')
          res.end('data: {"type":"message_stop"}\n\n')
        }
      })
      let callbackId
      const pending = invoke({
        exec,
        envelope,
        requestId: `hop-${name}`,
        onExecutionStart: async ({ requestId }) => {
          callbackId = requestId
          entered.resolve()
          await bound.promise
        },
      })
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('request finished without invoking durable binding')
          }),
        ])
        assert.equal(calls, 0)
        bound.resolve()
        const result = await pending
        assert.equal(callbackId, `hop-${name}`)
        assert.equal(wireId, callbackId)
        assert.deepEqual(result.execution, { requestId: wireId, started: true, ended: true, reason: 'eof' })
        assert.equal(result.body.execution, undefined)
      } finally {
        bound.resolve()
        await pending
      }
    },
  )

  unixTest(`${name} pre-aborted requests are proven not started`, async (t) => {
    let calls = 0
    const exec = await fixture(t, (_req, res) => {
      calls++
      res.end('{}')
    })
    const signal = AbortSignal.abort()
    const result = await invoke({
      exec,
      envelope,
      signal,
      requestId: 'pre-aborted',
      onExecutionStart: () => {
        calls++
      },
    })
    assert.deepEqual(result.execution, { requestId: 'pre-aborted', started: false, ended: true, reason: 'not_started' })
    assert.equal(calls, 0)
  })

  unixTest(`${name} binding failure prevents execution`, async (t) => {
    let calls = 0
    const exec = await fixture(t, (_req, res) => {
      calls++
      res.end('{}')
    })
    const result = await invoke({
      exec,
      envelope,
      requestId: 'binding-failed',
      onExecutionStart: () => {
        throw new Error('cannot persist the attempt')
      },
    })
    assert.deepEqual(result.execution, {
      requestId: 'binding-failed',
      started: false,
      ended: true,
      reason: 'not_started',
    })
    assert.equal(calls, 0)
    assert.equal(result.ok, false)
  })

  unixTest(`${name} generates a recoverable hop ID when none is provided`, async (t) => {
    let wireId
    let boundId
    const exec = await fixture(t, async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      wireId = JSON.parse(Buffer.concat(chunks).toString()).request_id
      res.end('{}')
    })
    const result = await invoke({
      exec,
      envelope,
      onExecutionStart: ({ requestId }) => {
        boundId = requestId
      },
    })
    assert.match(boundId, /^[a-f0-9-]{36}$/)
    assert.equal(result.execution.requestId, wireId)
    assert.equal(wireId, boundId)
    assert.equal(result.execution.ended, true)
  })

  unixTest(`${name} aborting during durable binding prevents submission`, async (t) => {
    let calls = 0
    const controller = new AbortController()
    const exec = await fixture(t, (_req, res) => {
      calls++
      res.end('{}')
    })
    const result = await invoke({
      exec,
      envelope,
      signal: controller.signal,
      requestId: 'abort-during-bind',
      onExecutionStart: async () => {
        await Promise.resolve()
        controller.abort()
      },
    })
    assert.deepEqual(result.execution, {
      requestId: 'abort-during-bind',
      started: false,
      ended: true,
      reason: 'not_started',
    })
    assert.equal(calls, 0)
  })

  unixTest(`${name} request timeouts do not prove the kernel task ended`, async (t) => {
    const exec = await fixture(t, async (req) => {
      for await (const _chunk of req) {
      }
    })
    const result = await invoke({ exec, envelope, requestId: 'timed-out', timeoutMs: 25 })
    assert.deepEqual(result.execution, { requestId: 'timed-out', started: true, ended: false, reason: 'timeout' })
    assert.equal(result.transportError, true)
  })

  unixTest(`${name} truncated response bodies preserve execution uncertainty`, async (t) => {
    const exec = await fixture(t, async (req, res) => {
      for await (const _chunk of req) {
      }
      res.writeHead(200, { 'content-length': '1000' })
      res.write('{"type":"message"')
      setImmediate(() => res.destroy())
    })
    const result = await invoke({ exec, envelope, requestId: 'truncated' })
    assert.deepEqual(result.execution, {
      requestId: 'truncated',
      started: true,
      ended: false,
      reason: 'transport_error',
    })
  })
}

unixTest(
  'an abort returns before a delayed cancel response and never treats cancelled:true as termination',
  { timeout: 2000 },
  async (t) => {
    const started = deferred()
    const sawCancel = deferred()
    const respondCancel = deferred()
    const cancelCompleted = deferred()
    let cancelResponded = false
    let wireId
    const exec = await fixture(t, async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (req.url === '/internal/v1/cancel') {
        sawCancel.resolve(body.request_id)
        await respondCancel.promise
        cancelResponded = true
        res.end('{"ok":true,"cancelled":true}')
        cancelCompleted.resolve()
        return
      }
      wireId = body.request_id
      res.setHeader('content-type', 'text/event-stream')
      res.write('data: {"type":"message_start","message":{}}\n\n')
      started.resolve()
    })
    const controller = new AbortController()
    const pending = streamGoWorker({ exec, envelope, signal: controller.signal, requestId: 'cancelled-hop' })
    try {
      await started.promise
      controller.abort()
      const result = await pending
      assert.equal(await sawCancel.promise, wireId)
      assert.equal(cancelResponded, false)
      assert.deepEqual(result.execution, { requestId: wireId, started: true, ended: false, reason: 'client_aborted' })
      respondCancel.resolve()
      await cancelCompleted.promise
      assert.equal(cancelResponded, true)
      assert.equal(result.execution.ended, false)
    } finally {
      respondCancel.resolve()
    }
  },
)

unixTest('message_stop does not establish execution end before HTTP EOF', { timeout: 2000 }, async (t) => {
  const eof = deferred()
  const sawStop = deferred()
  const exec = await fixture(t, async (req, res) => {
    for await (const _chunk of req) {
    }
    res.setHeader('content-type', 'text/event-stream')
    res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n')
    res.write('data: {"type":"message_stop"}\n\n')
    await eof.promise
    res.end()
  })
  let returned = false
  const pending = streamGoWorker({
    exec,
    envelope,
    requestId: 'delayed-eof',
    onEvent(line) {
      if (line.includes('message_stop')) sawStop.resolve()
    },
  }).then((result) => {
    returned = true
    return result
  })
  try {
    await sawStop.promise
    assert.equal(returned, false)
    eof.resolve()
    assert.deepEqual((await pending).execution, { requestId: 'delayed-eof', started: true, ended: true, reason: 'eof' })
  } finally {
    eof.resolve()
  }
})

test('synthetic mock results are ended even when their assistant response is incomplete', async () => {
  const before = { mock: process.env.KIN_CRS_MOCK, scenarios: process.env.KIN_MOCK_ACCOUNT_SCENARIOS }
  process.env.KIN_CRS_MOCK = '1'
  process.env.KIN_MOCK_ACCOUNT_SCENARIOS = JSON.stringify({ 'vm-mock': 'incomplete_stream' })
  try {
    for (const scenario of ['text', 'error', 'rate_limit', 'incomplete_stream']) {
      process.env.KIN_MOCK_ACCOUNT_SCENARIOS = JSON.stringify({ 'vm-mock': scenario })
      for (const invoke of [callGoWorker, streamGoWorker]) {
        const result = await invoke({ exec: { vmId: 'vm-mock' }, body: envelope.body, requestId: 'mock-hop' })
        assert.deepEqual(result.execution, { requestId: 'mock-hop', started: false, ended: true, reason: 'mock' })
      }
    }
  } finally {
    if (before.mock === undefined) delete process.env.KIN_CRS_MOCK
    else process.env.KIN_CRS_MOCK = before.mock
    if (before.scenarios === undefined) delete process.env.KIN_MOCK_ACCOUNT_SCENARIOS
    else process.env.KIN_MOCK_ACCOUNT_SCENARIOS = before.scenarios
  }
})
