import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callGoWorker, streamGoWorker } from '../../src/lib/transport/go-worker-client.mjs'
import {
  finalizeAssembledAssistantHop,
  isCompleteAssistantMessage,
  mergeAssembledAssistantHop,
} from '../../src/lib/core/errors.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test
const MODEL = 'claude-sonnet-5'
const USAGE = { input_tokens: 47, output_tokens: 4096, cache_read_input_tokens: 100, cache_creation_input_tokens: 12 }
const requestBody = () => ({
  model: MODEL,
  max_tokens: 4096,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'medium' },
  messages: [{ role: 'user', content: 'one inference turn' }],
})
const summary = (overrides = {}) => ({
  type: 'kin_provider_result',
  message_id: 'msg_native_1',
  model: MODEL,
  stop_reason: 'max_tokens',
  stop_sequence: null,
  usage: { ...USAGE },
  usage_complete: true,
  ...overrides,
})
const message = (result = summary(), content = [{ type: 'text', text: 'truncated ✓' }]) => ({
  type: 'message',
  id: result.message_id,
  role: 'assistant',
  model: result.model,
  content,
  stop_reason: result.stop_reason,
  stop_sequence: result.stop_sequence,
  usage: result.usage,
})
const frame = (event, name = event.type) => `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`
const resultFrame = (result) =>
  `event: kin_provider_result\n${JSON.stringify(result, null, 2)
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n')}\n\n`
const start = (result) =>
  frame({
    type: 'message_start',
    message: { ...message(result, []), stop_reason: null, usage: { input_tokens: 47, output_tokens: 0 } },
  })
const textFrames = (index = 0, text = 'truncated ✓') =>
  [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index },
  ]
    .map((event) => frame(event))
    .join('')
const toolFrames = (index = 0, id = 'tool_secret', input = '{"secret":"parameters"}') =>
  [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'client_tool', input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: input } },
    { type: 'content_block_stop', index },
  ]
    .map((event) => frame(event))
    .join('')
const terminalFrames = (result, usage = { output_tokens: 1 }) =>
  frame({
    type: 'message_delta',
    delta: { stop_reason: result.stop_reason, stop_sequence: result.stop_sequence },
    usage,
  }) + frame({ type: 'message_stop' })
const eventsFrom = (lines) => lines.filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)))
function gate() {
  let release
  const ready = new Promise((resolve) => {
    release = resolve
  })
  return { ready, release }
}

async function fixture(handler, { capabilities = ['native_handoff_v1'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-nh-'))
  const socket = path.join(root, 'worker.sock')
  const token = path.join(root, 'internal.token')
  fs.writeFileSync(token, 'test-internal-token\n', { mode: 0o600 })
  const requests = []
  const errors = []
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push({ path: req.url, headers: req.headers, envelope })
      await handler(req, res, envelope, requests.length)
    } catch (error) {
      errors.push(error)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'fixture_error', message: error.message } }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  return {
    requests,
    exec: {
      homeDir: path.join(root, 'home'),
      vmId: 'native-fixture',
      workerStatus: { runtime_variant: 'crag-v2', capabilities },
      vm: { runtime: { worker_socket: socket, worker_token_file: token } },
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
      assert.deepEqual(errors, [])
    },
  }
}
function options(fx, extra = {}) {
  return {
    exec: fx.exec,
    managedCrag: true,
    cragPrint: false,
    envelope: { body: requestBody(), headers: {}, stream: true },
    timeoutMs: 3000,
    ...extra,
  }
}
function assertPrivate(result, lines = []) {
  assert.equal(result.headers['x-kin-provider-result'], undefined)
  assert.doesNotMatch(result.headers.trailer || '', /x-kin-provider-result/i)
  assert.doesNotMatch(lines.join('\n'), /kin_provider_result|x-kin-provider-result|kin_outbound_headers/)
  assert.doesNotMatch(JSON.stringify(result.body), /kin_provider_result|x-kin-provider-result/)
}
async function writeChunks(res, value) {
  const bytes = Buffer.from(value)
  for (let offset = 0; offset < bytes.length; offset += 7) {
    res.write(bytes.subarray(offset, offset + 7))
    await new Promise((resolve) => setImmediate(resolve))
  }
}

for (const deliveryMode of ['realtime', 'verified']) {
  unixTest(
    `native ${deliveryMode} SSE consumes chunked multiline metadata and preserves max_tokens usage`,
    async () => {
      const result = summary()
      const fx = await fixture(async (_req, res) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          trailer: 'x-kin-provider-result, x-usage, x-terminal-state',
        })
        await writeChunks(res, start(result) + textFrames() + resultFrame(result) + terminalFrames(result))
        res.addTrailers({
          'x-kin-provider-result': JSON.stringify(result),
          'x-usage': JSON.stringify(result.usage),
          'x-terminal-state': 'verified',
        })
        res.end()
      })
      const lines = []
      let commits = 0
      try {
        const received = await streamGoWorker(
          options(fx, {
            deliveryMode,
            onEvent: (line) => lines.push(line),
            onCommit: () => {
              commits++
            },
          }),
        )
        assert.equal(received.ok, true)
        assert.equal(received.nativeHandoff, true)
        assert.deepEqual(received.providerResult, result)
        assert.equal(received.body.id, result.message_id)
        assert.equal(received.stopReason, 'max_tokens')
        assert.deepEqual(received.body.usage, USAGE)
        assert.deepEqual(received.usage, USAGE)
        assert.equal(received.body.content[0].text, 'truncated ✓')
        assert.equal(commits, 1)
        const events = eventsFrom(lines)
        assert.deepEqual(events.find((event) => event.type === 'message_delta').usage, USAGE)
        assert.equal(events.at(-1).type, 'message_stop')
        assertPrivate(received, lines)
        assert.equal(fx.requests.length, 1)
        assert.equal(fx.requests[0].envelope.gateway_policy.native_handoff_v1, true)
        assert.equal(fx.requests[0].headers['x-kin-internal-token'], 'test-internal-token')
        assert.equal(fx.requests[0].envelope.body.max_tokens, 4096)
        assert.equal(fx.requests[0].envelope.body.thinking.type, 'adaptive')
        assert.equal(fx.requests[0].envelope.body.output_config.effort, 'medium')
        assert.equal(fx.requests[0].headers.te, 'trailers')
      } finally {
        await fx.close()
      }
    },
  )
}

for (const channel of ['header', 'trailer']) {
  unixTest(`native JSON ${channel} is authoritative and stripped`, async () => {
    const result = summary()
    const fx = await fixture((_req, res) => {
      res.setHeader('content-type', 'application/json')
      if (channel === 'header') res.setHeader('x-kin-provider-result', JSON.stringify(result))
      else res.setHeader('trailer', 'x-kin-provider-result')
      // The final native summary, not a stale public/CLI snapshot, owns accounting.
      res.write(JSON.stringify({ ...message(result), usage: { input_tokens: 47, output_tokens: 1 } }))
      if (channel === 'trailer') res.addTrailers({ 'x-kin-provider-result': JSON.stringify(result) })
      res.end()
    })
    try {
      const received = await callGoWorker(options(fx))
      assert.equal(received.ok, true)
      assert.equal(received.nativeHandoff, true)
      assert.deepEqual(received.providerResult, result)
      assert.deepEqual(received.body.usage, USAGE)
      assert.deepEqual(received.usage, USAGE)
      assert.equal(received.stopReason, 'max_tokens')
      assertPrivate(received)
    } finally {
      await fx.close()
    }
  })
}

for (const stream of [false, true]) {
  for (const legacy of ['old-capability', 'unmanaged', 'classifier', 'classifier-context', 'different-route']) {
    unixTest(`${legacy} ${stream ? 'SSE' : 'JSON'} stays legacy without native opt-in`, async () => {
      const result = summary({ stop_reason: 'end_turn' })
      const fx = await fixture(
        (_req, res) => {
          res.setHeader('content-type', stream ? 'text/event-stream' : 'application/json')
          if (stream) res.end(start(result) + textFrames() + terminalFrames(result))
          else res.end(JSON.stringify(message(result)))
        },
        { capabilities: legacy === 'old-capability' ? ['streaming', 'sessions'] : ['native_handoff_v1'] },
      )
      try {
        const args = options(fx, {
          managedCrag: legacy !== 'unmanaged',
          ...(legacy === 'different-route' ? { requestPath: '/internal/v1/classify' } : {}),
        })
        if (legacy === 'classifier') args.envelope.request_context = { purpose: 'auto_mode_classifier', format: 'xml' }
        if (legacy === 'classifier-context') args.requestContext = { purpose: 'auto_mode_classifier', format: 'xml' }
        const received = await (stream ? streamGoWorker(args) : callGoWorker(args))
        assert.equal(received.ok, true)
        assert.notEqual(received.nativeHandoff, true)
        assert.equal(received.providerResult ?? null, null)
        assert.equal(fx.requests[0].envelope.gateway_policy?.native_handoff_v1, undefined)
        assert.equal(received.body.id, result.message_id)
        assert.equal(received.body.stop_reason, 'end_turn')
      } finally {
        await fx.close()
      }
    })
  }
}

for (const deliveryMode of ['realtime', 'verified']) {
  unixTest(`${deliveryMode} refusal never publishes buffered tool IDs, arguments or success`, async () => {
    const result = summary({ stop_reason: 'refusal' })
    const parsedTools = gate()
    const release = gate()
    const fx = await fixture(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', trailer: 'x-kin-provider-result' })
      res.write(
        start(result) +
          toolFrames() +
          frame({ type: 'kin_outbound_headers', headers: { 'x-fixture-phase': 'tool-buffered' } }),
      )
      await release.ready
      res.write(resultFrame(result) + textFrames(1, 'Cannot assist with that request.') + terminalFrames(result))
      res.addTrailers({ 'x-kin-provider-result': JSON.stringify(result) })
      res.end()
    })
    const lines = []
    let committed = false
    try {
      const pending = streamGoWorker(
        options(fx, {
          deliveryMode,
          onEvent: (line) => lines.push(line),
          onCommit: () => {
            committed = true
          },
          onOutboundHeaders: () => parsedTools.release(),
        }),
      )
      await parsedTools.ready
      assert.equal(committed, false)
      assert.deepEqual(lines, [])
      release.release()
      const received = await pending
      assert.equal(received.ok, true)
      assert.equal(received.stopReason, 'refusal')
      assert.equal(received.body.stop_reason, 'refusal')
      assert.deepEqual(received.body.content, [{ type: 'text', text: 'Cannot assist with that request.' }])
      assert.deepEqual(received.usage, USAGE)
      assert.doesNotMatch(
        JSON.stringify(received.body) + lines.join('\n'),
        /tool_secret|parameters|tool_use|client_tool/,
      )
      assertPrivate(received, lines)
      assert.deepEqual(
        eventsFrom(lines)
          .filter((event) => event.type.startsWith('content_block'))
          .map((event) => event.index),
        [0, 0, 0],
      )
    } finally {
      release.release()
      await fx.close()
    }
  })
}

unixTest('native JSON refusal suppresses tool content without replacing the raw refusal stop', async () => {
  const result = summary({ stop_reason: 'refusal' })
  const fx = await fixture((_req, res) => {
    res.setHeader('x-kin-provider-result', JSON.stringify(result))
    res.end(
      JSON.stringify(
        message(result, [
          { type: 'tool_use', id: 'tool_secret', name: 'client_tool', input: { secret: 'parameters' } },
          { type: 'refusal', refusal: 'Cannot assist.' },
        ]),
      ),
    )
  })
  try {
    const received = await callGoWorker(options(fx))
    assert.equal(received.ok, true)
    assert.equal(received.stopReason, 'refusal')
    assert.deepEqual(received.body.content, [{ type: 'refusal', refusal: 'Cannot assist.' }])
    assert.deepEqual(received.usage, USAGE)
    assertPrivate(received)
  } finally {
    await fx.close()
  }
})

for (const stream of [false, true]) {
  for (const defect of [
    'missing',
    'conflicting-trailer',
    'malformed-duplicate',
    'identity',
    'stop',
    'invalid-usage',
    'invalid-id',
    'malformed',
  ]) {
    unixTest(`native ${stream ? 'SSE' : 'JSON'} fails closed for ${defect} metadata`, async () => {
      const result = summary({ stop_reason: 'tool_use' })
      const wireResult =
        defect === 'invalid-usage'
          ? summary({ stop_reason: 'tool_use', usage: { input_tokens: 47, output_tokens: -1 } })
          : defect === 'invalid-id'
            ? summary({ stop_reason: 'tool_use', message_id: '' })
            : result
      const observed = { ...result, usage: { input_tokens: 47, output_tokens: 2 } }
      const bodyResult =
        defect === 'identity'
          ? { ...observed, message_id: 'msg_wrong_provider' }
          : defect === 'stop'
            ? { ...observed, stop_reason: 'end_turn' }
            : observed
      const fx = await fixture((_req, res) => {
        res.setHeader('content-type', stream ? 'text/event-stream' : 'application/json')
        if (defect !== 'missing')
          res.setHeader('x-kin-provider-result', defect === 'malformed' ? '{bad-json' : JSON.stringify(wireResult))
        if (['conflicting-trailer', 'malformed-duplicate'].includes(defect))
          res.setHeader('trailer', 'x-kin-provider-result')
        if (stream) res.write(start(bodyResult) + toolFrames() + terminalFrames(bodyResult))
        else
          res.write(
            JSON.stringify(
              message(bodyResult, [
                { type: 'tool_use', id: 'tool_secret', name: 'client_tool', input: { secret: 'parameters' } },
              ]),
            ),
          )
        if (defect === 'conflicting-trailer')
          res.addTrailers({
            'x-kin-provider-result': JSON.stringify({ ...result, usage: { input_tokens: 47, output_tokens: 9 } }),
          })
        if (defect === 'malformed-duplicate') res.addTrailers({ 'x-kin-provider-result': '{bad-json' })
        res.end()
      })
      const lines = []
      try {
        const args = options(fx, { onEvent: (line) => lines.push(line) })
        const received = await (stream ? streamGoWorker(args) : callGoWorker(args))
        assert.equal(received.ok, false)
        assert.equal(received.nativeHandoff, true)
        assert.equal(received.status, 502)
        assert.equal(received.committed ?? false, false)
        assert.match(received.body.error.code, /^native_handoff_(missing|invalid|conflict)$/)
        assert.equal(received.providerResult, null)
        assert.deepEqual(received.usage, { input_tokens: 47, output_tokens: stream ? 1 : 2 })
        assert.notEqual(received.usage.output_tokens, result.usage.output_tokens)
        assert.notEqual(received.usage.output_tokens, 9)
        assert.doesNotMatch(lines.join('\n'), /tool_secret|parameters|tool_use|message_stop/)
        assertPrivate(received, lines)
      } finally {
        await fx.close()
      }
    })
  }
}

unixTest('realtime text is delivered before native terminal, verified text is withheld', async () => {
  for (const deliveryMode of ['realtime', 'verified']) {
    const result = summary()
    const observed = gate()
    const release = gate()
    const fx = await fixture(async (_req, res) => {
      res.setHeader('content-type', 'text/event-stream')
      res.write(
        start(result) +
          textFrames() +
          frame({ type: 'kin_outbound_headers', headers: { 'x-fixture-phase': 'text-observed' } }),
      )
      await release.ready
      res.end(resultFrame(result) + terminalFrames(result))
    })
    const lines = []
    try {
      const pending = streamGoWorker(
        options(fx, {
          deliveryMode,
          onEvent: (line) => lines.push(line),
          onOutboundHeaders: () => observed.release(),
        }),
      )
      await observed.ready
      if (deliveryMode === 'realtime') assert.match(lines.join('\n'), /truncated ✓/)
      else assert.deepEqual(lines, [])
      assert.doesNotMatch(lines.join('\n'), /message_delta|message_stop/)
      release.release()
      const received = await pending
      assert.equal(received.ok, true)
      assertPrivate(received, lines)
    } finally {
      release.release()
      await fx.close()
    }
  }
})

unixTest('real provider error and partial observed usage survive late CLI rows without tool grants', async () => {
  const providerError = {
    type: 'api_error',
    code: 'upstream_stream_interrupted',
    message: 'provider connection closed',
    details: { retryable: false },
  }
  const result = summary({
    stop_reason: null,
    usage: { input_tokens: 47, output_tokens: 3 },
    usage_complete: false,
    http_status: 502,
    error: providerError,
    request_id: 'req_actual_provider',
  })
  const fx = await fixture((_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.end(
      start(result) +
        textFrames() +
        toolFrames(1) +
        resultFrame(result) +
        frame({ type: 'error', error: { type: 'cli_error', message: 'late CLI diagnostic' } }),
    )
  })
  const lines = []
  try {
    const received = await streamGoWorker(options(fx, { onEvent: (line) => lines.push(line) }))
    assert.equal(received.ok, false)
    assert.equal(received.nativeHandoff, true)
    assert.equal(received.status, 502)
    assert.equal(received.committed, true)
    assert.deepEqual(received.providerResult, result)
    assert.deepEqual(received.body.error, providerError)
    assert.equal(received.body.request_id, 'req_actual_provider')
    assert.deepEqual(received.usage, { input_tokens: 47, output_tokens: 3 })
    assert.doesNotMatch(lines.join('\n'), /tool_secret|parameters|message_stop/)
    assertPrivate(received, lines)
  } finally {
    await fx.close()
  }
})

for (const stream of [false, true]) {
  unixTest(`native ${stream ? 'SSE' : 'JSON'} actual HTTP error is never converted into completion`, async () => {
    const error = {
      type: 'rate_limit_error',
      code: 'upstream_rate_limit',
      message: 'real limit',
      details: { retryable: false },
    }
    const result = summary({
      message_id: null,
      model: null,
      stop_reason: null,
      usage: null,
      usage_complete: false,
      error,
      http_status: 429,
      request_id: 'req_limit',
    })
    const fx = await fixture((_req, res) => {
      res.writeHead(429, {
        'content-type': 'application/json',
        'x-kin-provider-result': JSON.stringify(result),
        'retry-after': '7',
      })
      res.end(JSON.stringify({ type: 'error', error, request_id: 'req_limit' }))
    })
    try {
      const received = await (stream ? streamGoWorker(options(fx)) : callGoWorker(options(fx)))
      assert.equal(received.ok, false)
      assert.equal(received.nativeHandoff, true)
      assert.equal(received.status, 429)
      assert.deepEqual(received.body.error, error)
      assert.deepEqual(received.providerResult, result)
      assert.equal(received.usage, null)
      assert.equal(received.headers['retry-after'], '7')
      assertPrivate(received)
    } finally {
      await fx.close()
    }
  })
}

unixTest('transport catch keeps validated partial provider metadata and never invents final usage', async () => {
  const result = summary({ stop_reason: null, usage: { input_tokens: 47, output_tokens: 2 }, usage_complete: false })
  const observed = gate()
  const release = gate()
  const fx = await fixture(async (_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.write(
      start(result) +
        textFrames() +
        resultFrame(result) +
        frame({ type: 'kin_outbound_headers', headers: { 'x-fixture-phase': 'metadata-observed' } }),
    )
    await release.ready
    res.destroy()
  })
  try {
    const pending = streamGoWorker(options(fx, { onOutboundHeaders: () => observed.release() }))
    await observed.ready
    release.release()
    const received = await pending
    assert.equal(received.ok, false)
    assert.equal(received.nativeHandoff, true)
    assert.equal(received.committed, true)
    assert.deepEqual(received.providerResult, result)
    assert.deepEqual(received.usage, { input_tokens: 47, output_tokens: 2 })
    assert.equal(received.providerResult.usage_complete, false)
    assertPrivate(received)
  } finally {
    release.release()
    await fx.close()
  }
})

unixTest('missing provider terminal retains only observed SSE usage on a failed partial stream', async () => {
  const result = summary()
  const fx = await fixture((_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.end(start(result) + textFrames() + frame({ type: 'message_delta', delta: {}, usage: { output_tokens: 2 } }))
  })
  const lines = []
  try {
    const received = await streamGoWorker(options(fx, { onEvent: (line) => lines.push(line) }))
    assert.equal(received.ok, false)
    assert.equal(received.nativeHandoff, true)
    assert.equal(received.providerResult, null)
    assert.equal(received.body.error.code, 'native_handoff_missing')
    assert.deepEqual(received.usage, { input_tokens: 47, output_tokens: 2 })
    assert.doesNotMatch(lines.join('\n'), /message_delta|message_stop/)
  } finally {
    await fx.close()
  }
})

unixTest('genuine native tools pass unchanged through two independent turns without a Node ledger', async () => {
  const first = summary({
    message_id: 'msg_native_turn1',
    stop_reason: 'tool_use',
    usage: { input_tokens: 7, output_tokens: 3 },
  })
  const second = summary({
    message_id: 'msg_native_turn2',
    stop_reason: 'tool_use',
    usage: { input_tokens: 11, output_tokens: 5 },
  })
  const fx = await fixture((_req, res, _envelope, turn) => {
    const result = turn === 1 ? first : second
    res.setHeader('content-type', 'text/event-stream')
    res.end(
      start(result) +
        toolFrames(0, `native_tool_${turn}`, `{"turn":${turn}}`) +
        resultFrame(result) +
        terminalFrames(result),
    )
  })
  try {
    const firstLines = []
    const received1 = await streamGoWorker(options(fx, { onEvent: (line) => firstLines.push(line) }))
    assert.equal(received1.ok, true)
    assert.equal(received1.body.id, first.message_id)
    assert.deepEqual(received1.body.content, [
      { type: 'tool_use', id: 'native_tool_1', name: 'client_tool', input: { turn: 1 } },
    ])
    const history = [
      { role: 'user', content: 'one inference turn' },
      { role: 'assistant', content: received1.body.content },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'native_tool_1', content: 'actual client result' }],
      },
    ]
    const secondArgs = options(fx, { deliveryMode: 'verified' })
    secondArgs.envelope.body.messages = history
    const received2 = await streamGoWorker(secondArgs)
    assert.equal(received2.ok, true)
    assert.equal(received2.body.id, second.message_id)
    assert.deepEqual(received2.body.content, [
      { type: 'tool_use', id: 'native_tool_2', name: 'client_tool', input: { turn: 2 } },
    ])
    assert.equal(fx.requests.length, 2)
    assert.deepEqual(fx.requests[1].envelope.body.messages.slice(1), history.slice(1))
    assert.notEqual(fx.requests[0].envelope.request_id, fx.requests[1].envelope.request_id)
    assert.match(firstLines.join('\n'), /native_tool_1/)
    assertPrivate(received1, firstLines)
    assertPrivate(received2)
  } finally {
    await fx.close()
  }
})

unixTest('a complete-looking public stream cannot override a real native error or missing terminal', async () => {
  const result = summary()
  for (const failure of ['late-error', 'no-message-stop', 'no-message-delta', 'invalid-tool-json']) {
    const stop = failure === 'invalid-tool-json' ? summary({ stop_reason: 'tool_use' }) : result
    const fx = await fixture((_req, res) => {
      res.setHeader('content-type', 'text/event-stream')
      const content = failure === 'invalid-tool-json' ? toolFrames(0, 'tool_secret', '{broken') : textFrames()
      const terminal =
        failure === 'no-message-stop'
          ? frame({ type: 'message_delta', delta: { stop_reason: stop.stop_reason }, usage: stop.usage })
          : failure === 'no-message-delta'
            ? frame({ type: 'message_stop' })
            : terminalFrames(stop)
      const error =
        failure === 'late-error'
          ? frame({
              type: 'error',
              error: { type: 'api_error', code: 'actual_provider_error', message: 'not a completion' },
            })
          : ''
      res.end(start(stop) + content + resultFrame(stop) + terminal + error)
    })
    const lines = []
    try {
      const received = await streamGoWorker(
        options(fx, { deliveryMode: 'verified', onEvent: (line) => lines.push(line) }),
      )
      assert.equal(received.ok, false)
      assert.equal(received.nativeHandoff, true)
      assert.equal(received.body.type, 'error')
      assert.equal(
        received.body.error.code,
        failure === 'late-error'
          ? 'actual_provider_error'
          : failure === 'invalid-tool-json'
            ? 'native_handoff_invalid'
            : 'native_handoff_incomplete',
      )
      assert.deepEqual(lines, [])
    } finally {
      await fx.close()
    }
  }
})

test('outer assistant assembly preserves authoritative native result, refusal tools and failure state', () => {
  const providerResult = summary({ stop_reason: 'refusal' })
  const received = {
    ok: true,
    nativeHandoff: true,
    providerResult,
    body: message(providerResult, [{ type: 'refusal', refusal: 'No.' }]),
    usage: USAGE,
    stopReason: 'refusal',
  }
  const stale = {
    ...message(providerResult),
    usage: { input_tokens: 1, output_tokens: 0 },
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'unsafe', name: 'unsafe', input: {} }],
  }
  assert.equal(mergeAssembledAssistantHop(received, stale), received)
  assert.equal(finalizeAssembledAssistantHop(received), received)
  assert.equal(isCompleteAssistantMessage(received), true)
  const failed = { ...received, ok: false, terminalState: 'incomplete' }
  assert.equal(isCompleteAssistantMessage(failed), false)
  assert.equal(finalizeAssembledAssistantHop(failed), failed)
  assert.equal(mergeAssembledAssistantHop(failed, stale), failed)
})

unixTest('new native SSE can use only the authenticated result header without leaking it', async () => {
  const result = summary()
  const fx = await fixture((_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('x-kin-provider-result', JSON.stringify(result))
    res.end(start(result) + textFrames() + terminalFrames(result))
  })
  const lines = []
  try {
    const received = await streamGoWorker(options(fx, { onEvent: (line) => lines.push(line) }))
    assert.equal(received.ok, true)
    assert.deepEqual(received.providerResult, result)
    assert.deepEqual(received.usage, USAGE)
    assertPrivate(received, lines)
  } finally {
    await fx.close()
  }
})

unixTest('old capability path strips unsolicited internal result controls but keeps legacy completion', async () => {
  const result = summary({ stop_reason: 'end_turn' })
  const fx = await fixture(
    (_req, res) => {
      res.setHeader('content-type', 'text/event-stream')
      res.setHeader('x-kin-provider-result', JSON.stringify(result))
      res.end(start(result) + resultFrame(result) + textFrames() + terminalFrames(result))
    },
    { capabilities: ['streaming'] },
  )
  const lines = []
  try {
    const received = await streamGoWorker(options(fx, { onEvent: (line) => lines.push(line) }))
    assert.equal(received.ok, true)
    assert.notEqual(received.nativeHandoff, true)
    assert.equal(received.providerResult ?? null, null)
    assert.equal(fx.requests[0].envelope.gateway_policy.native_handoff_v1, undefined)
    assert.equal(received.stopReason, 'end_turn')
    assertPrivate(received, lines)
  } finally {
    await fx.close()
  }
})

unixTest('JSON provider failure preserves partial real usage without marking it complete', async () => {
  const error = { type: 'api_error', code: 'upstream_stream_interrupted', message: 'provider cut off', status: 502 }
  const result = summary({
    stop_reason: null,
    usage: { input_tokens: 47 },
    usage_complete: false,
    error,
    http_status: 502,
  })
  const fx = await fixture((_req, res) => {
    res.setHeader('x-kin-provider-result', JSON.stringify(result))
    res.end(JSON.stringify({ type: 'error', error }))
  })
  try {
    const received = await callGoWorker(options(fx))
    assert.equal(received.ok, false)
    assert.equal(received.nativeHandoff, true)
    assert.equal(received.status, 502)
    assert.deepEqual(received.usage, { input_tokens: 47 })
    assert.equal(Object.hasOwn(received.usage, 'output_tokens'), false)
    assert.equal(received.providerResult.usage_complete, false)
    assert.deepEqual(received.body.error, error)
    assertPrivate(received)
  } finally {
    await fx.close()
  }
})

unixTest('internal provider metadata alone cannot start TTFT or fabricate a public message', async () => {
  const result = summary()
  const fx = await fixture((_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.end(resultFrame(result))
  })
  const lines = []
  try {
    const received = await streamGoWorker(options(fx, { onEvent: (line) => lines.push(line) }))
    assert.equal(received.ok, false)
    assert.equal(received.body.error.code, 'native_handoff_incomplete')
    assert.equal(received.ttftMs, null)
    assert.equal(received.firstTokenAt, null)
    assert.equal(received.firstByteAt, null)
    assert.deepEqual(lines, [])
  } finally {
    await fx.close()
  }
})

for (const variant of ['orphan-arguments', 'alternate-tool-event']) {
  unixTest(`native ${variant} cannot evade authoritative tool-stop buffering`, async () => {
    const result = summary({ stop_reason: 'refusal' })
    const event =
      variant === 'orphan-arguments'
        ? {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"secret":"parameters"}' },
          }
        : {
            type: 'response.output_item.added',
            item: {
              type: 'function_call',
              call_id: 'tool_secret',
              name: 'client_tool',
              arguments: '{"secret":"parameters"}',
            },
          }
    const fx = await fixture((_req, res) => {
      res.setHeader('content-type', 'text/event-stream')
      res.end(start(result) + frame(event) + resultFrame(result) + terminalFrames(result))
    })
    const lines = []
    try {
      const received = await streamGoWorker(options(fx, { onEvent: (line) => lines.push(line) }))
      assert.equal(received.ok, false)
      assert.equal(received.body.error.code, 'native_handoff_invalid')
      assert.equal(received.transportError, false)
      assert.deepEqual(lines, [])
    } finally {
      await fx.close()
    }
  })
}

for (const stream of [false, true]) {
  unixTest(`expired continuation ${stream ? 'SSE' : 'JSON'} stays a real 410, never an inferred refusal`, async () => {
    const error = {
      type: 'invalid_request_error',
      code: 'tool_turn_expired',
      message: 'tool turn expired',
      details: { retryable: false },
    }
    const fx = await fixture((_req, res) => {
      res.writeHead(410, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error }))
    })
    try {
      const received = await (stream ? streamGoWorker(options(fx)) : callGoWorker(options(fx)))
      assert.equal(received.ok, false)
      assert.equal(received.nativeHandoff, true)
      assert.equal(received.status, 410)
      assert.equal(received.providerResult, null)
      assert.equal(received.stopReason ?? null, null)
      assert.deepEqual(received.body.error, error)
      assertPrivate(received)
    } finally {
      await fx.close()
    }
  })
}

unixTest('native stop arrival freezes an observed generation window before delayed public terminal work', async () => {
  const result = summary()
  const sawText = gate()
  const sawNativeStop = gate()
  const releaseTail = gate()
  const fx = await fixture(async (_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.write(start(result) + textFrames())
    await sawText.ready
    await new Promise((resolve) => setTimeout(resolve, 10))
    res.write(
      resultFrame(result) +
        frame({ type: 'kin_outbound_headers', headers: { 'x-fixture-phase': 'native-stop-observed' } }),
    )
    await releaseTail.ready
    res.end(terminalFrames(result))
  })
  try {
    const pending = streamGoWorker(
      options(fx, {
        onEvent: (line) => {
          if (line.includes('text_delta')) sawText.release()
        },
        onOutboundHeaders: () => sawNativeStop.release(Date.now()),
      }),
    )
    const nativeStopObservedAt = await sawNativeStop.ready
    await new Promise((resolve) => setTimeout(resolve, 30))
    releaseTail.release()
    const received = await pending
    assert.equal(received.ok, true)
    assert.equal(typeof received.ttftMs, 'number')
    assert.ok(received.generationMs > 0)
    assert.ok(received.generationMs <= nativeStopObservedAt - received.firstByteAt)
    assert.ok(received.generationMs < Date.now() - received.firstByteAt - 20)
  } finally {
    sawText.release()
    releaseTail.release()
    await fx.close()
  }
})

unixTest('native Unix SSE preserves recursively validated usage iteration arrays', async () => {
  const usage = {
    ...USAGE,
    iterations: [
      { type: 'message', model: MODEL, input_tokens: 47, output_tokens: 4096 },
      { type: 'message', model: MODEL, input_tokens: 0, output_tokens: 0 },
    ],
  }
  const result = summary({ usage })
  const fx = await fixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', trailer: 'x-kin-provider-result' })
    res.write(start(result) + textFrames() + resultFrame(result) + terminalFrames(result))
    res.addTrailers({ 'x-kin-provider-result': JSON.stringify(result) })
    res.end()
  })
  const lines = []
  try {
    const received = await streamGoWorker(options(fx, { onEvent: (line) => lines.push(line) }))
    assert.equal(received.ok, true)
    assert.equal(received.nativeHandoff, true)
    assert.deepEqual(received.providerResult.usage, usage)
    assert.deepEqual(received.usage, usage)
    assert.deepEqual(received.body.usage, usage)
    assert.deepEqual(eventsFrom(lines).find((event) => event.type === 'message_delta').usage, usage)
    assertPrivate(received, lines)
  } finally {
    await fx.close()
  }
})

unixTest('a conflicted summary cannot supply the error cause or final usage over observed SSE', async () => {
  const unrelatedError = { type: 'rate_limit_error', code: 'unrelated_summary_error', message: 'not this response' }
  const result = summary({ usage_complete: false, error: unrelatedError, http_status: 429 })
  const observed = summary({ message_id: 'msg_observed_response', stop_reason: null })
  const actualError = { type: 'api_error', code: 'kernel_unavailable', status: 503, message: 'actual observed failure' }
  const fx = await fixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-kin-provider-result': JSON.stringify(result) })
    res.end(start(observed) + toolFrames() + frame({ type: 'error', error: actualError }))
  })
  const lines = []
  try {
    const received = await streamGoWorker(options(fx, { onEvent: (line) => lines.push(line) }))
    assert.equal(received.ok, false)
    assert.equal(received.nativeHandoff, true)
    assert.equal(received.providerResult, null)
    assert.equal(received.status, 503)
    assert.deepEqual(received.body.error, actualError)
    assert.deepEqual(received.usage, { input_tokens: 47, output_tokens: 0 })
    assert.deepEqual(lines, [])
    assertPrivate(received)
  } finally {
    await fx.close()
  }
})

unixTest('transport EOF retains an associated valid final summary and actual generated usage', async () => {
  const result = summary()
  const observed = gate()
  const release = gate()
  const fx = await fixture(async (_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.write(
      start(result) +
        textFrames() +
        resultFrame(result) +
        frame({ type: 'kin_outbound_headers', headers: { 'x-fixture-phase': 'valid-final-summary-observed' } }),
    )
    await release.ready
    res.destroy()
  })
  try {
    const pending = streamGoWorker(options(fx, { onOutboundHeaders: () => observed.release() }))
    await observed.ready
    release.release()
    const received = await pending
    assert.equal(received.ok, false)
    assert.equal(received.nativeHandoff, true)
    assert.deepEqual(received.providerResult, result)
    assert.equal(received.providerResult.usage_complete, true)
    assert.deepEqual(received.usage, USAGE)
    assertPrivate(received)
  } finally {
    release.release()
    await fx.close()
  }
})

for (const stream of [false, true]) {
  for (const stopReason of ['end_turn', 'refusal']) {
    unixTest(
      `native ${stream ? 'SSE' : 'JSON'} ${stopReason} preserves server tool records without granting client tools`,
      async () => {
        const result = summary({ stop_reason: stopReason })
        const serverContent = [
          { type: 'server_tool_use', id: 'srvtoolu_fixture', name: 'web_search', input: { query: 'fixture query' } },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_fixture',
            content: [
              {
                type: 'web_search_result',
                url: 'https://example.test/result',
                title: 'Fixture result',
                encrypted_content: 'fixture-opaque-content',
              },
            ],
          },
        ]
        const fx = await fixture((_req, res) => {
          res.setHeader('content-type', stream ? 'text/event-stream' : 'application/json')
          res.setHeader('x-kin-provider-result', JSON.stringify(result))
          if (stream) {
            const serverFrames = serverContent
              .map(
                (block, index) =>
                  frame({ type: 'content_block_start', index, content_block: block }) +
                  frame({ type: 'content_block_stop', index }),
              )
              .join('')
            const clientFrames = stopReason === 'refusal' ? toolFrames(2, 'client_secret') : ''
            res.end(start(result) + serverFrames + clientFrames + resultFrame(result) + terminalFrames(result))
          } else {
            const clientContent =
              stopReason === 'refusal'
                ? [{ type: 'tool_use', id: 'client_secret', name: 'client_tool', input: { secret: 'parameters' } }]
                : []
            res.end(JSON.stringify(message(result, [...serverContent, ...clientContent])))
          }
        })
        const lines = []
        try {
          const args = options(fx, { onEvent: (line) => lines.push(line) })
          const received = await (stream ? streamGoWorker(args) : callGoWorker(args))
          assert.equal(received.ok, true)
          assert.equal(received.nativeHandoff, true)
          assert.equal(received.stopReason, stopReason)
          assert.deepEqual(received.providerResult, result)
          assert.deepEqual(received.body.content, serverContent)
          assert.deepEqual(received.usage, USAGE)
          if (stream) {
            assert.deepEqual(
              eventsFrom(lines)
                .filter((event) => event.type === 'content_block_start')
                .map((event) => event.content_block),
              serverContent,
            )
          }
          assert.doesNotMatch(JSON.stringify(received.body) + lines.join('\n'), /client_secret|client_tool|parameters/)
          assertPrivate(received, lines)
        } finally {
          await fx.close()
        }
      },
    )
  }
}
