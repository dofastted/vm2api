import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createRespond, readBody } from '../../src/lib/http/respond.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { classifyUpstreamResult } from '../../src/lib/pool/upstream-error-policy.mjs'
import { RateLimitService } from '../../src/lib/pool/rate-limit-service.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createFailoverMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'
import { consumeNativeHandoffStream, createNativeHandoffState } from '../../src/lib/protocol/native-handoff.mjs'
import {
  applyClaudeSSELineToMessage,
  claudeSSELineToResponsesEvents,
  createClaudeMessageAssembler,
  createResponsesStreamState,
} from '../../src/lib/protocol/convert.mjs'
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
      if (deliveryMode === 'verified') {
        assert.equal(committed, false)
        assert.deepEqual(lines, [])
      } else assert.equal(committed, true)
      release.release()
      const received = await pending
      if (deliveryMode === 'verified') {
        assert.equal(received.ok, true)
        assert.equal(received.stopReason, 'refusal')
        assert.equal(received.body.stop_reason, 'refusal')
        assert.deepEqual(received.body.content, [{ type: 'text', text: 'Cannot assist with that request.' }])
        assert.deepEqual(received.usage, USAGE)
        assert.doesNotMatch(
          JSON.stringify(received.body) + lines.join('\n'),
          /tool_secret|parameters|tool_use|client_tool/,
        )
        assert.deepEqual(
          eventsFrom(lines)
            .filter((event) => event.type.startsWith('content_block'))
            .map((event) => event.index),
          [0, 0, 0],
        )
      } else {
        assert.equal(received.ok, false)
        assert.equal(received.committed, true)
        assert.match(lines.join('\n'), /tool_secret/)
        assert.match(lines.join('\n'), /event: error/)
      }
      assertPrivate(received, lines)
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
        if (stream) assert.equal(received.committed, true)
        else assert.equal(received.committed ?? false, false)
        if (!stream) assert.match(received.body.error.code, /^native_handoff_(missing|invalid|conflict)$/)
        assert.equal(received.providerResult, null)
        assert.deepEqual(received.usage, { input_tokens: 47, output_tokens: stream ? 1 : 2 })
        assert.notEqual(received.usage.output_tokens, result.usage.output_tokens)
        assert.notEqual(received.usage.output_tokens, 9)
        if (stream) assert.match(lines.join('\n'), /event: error/)
        else assert.doesNotMatch(lines.join('\n'), /tool_secret|parameters|tool_use|message_stop/)
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

unixTest('realtime tool deltas arrive before terminal, verified tools stay withheld', async () => {
  for (const deliveryMode of ['realtime', 'verified']) {
    const result = summary({ stop_reason: 'tool_use', usage: { input_tokens: 47, output_tokens: 4 } })
    const observed = gate()
    const release = gate()
    const first = '{"step":'
    const second = '1}'
    const fx = await fixture(async (_req, res) => {
      res.setHeader('content-type', 'text/event-stream')
      res.write(
        start(result) +
          frame({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tool_live', name: 'client_tool', input: {} },
          }) +
          frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: first } }) +
          frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: second } }) +
          frame({ type: 'kin_outbound_headers', headers: { 'x-fixture-phase': 'tool-observed' } }),
      )
      await release.ready
      res.end(frame({ type: 'content_block_stop', index: 0 }) + resultFrame(result) + terminalFrames(result))
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
      const events = eventsFrom(lines)
      if (deliveryMode === 'realtime') {
        assert.deepEqual(
          events.filter((event) => event.delta?.type === 'input_json_delta').map((event) => event.delta.partial_json),
          [first, second],
        )
        assert.equal(events.filter((event) => event.type === 'content_block_start').length, 1)
        assert.doesNotMatch(lines.join('\n'), /message_delta|message_stop|kin_provider_result/)
      } else assert.deepEqual(lines, [])
      release.release()
      const received = await pending
      assert.equal(received.ok, true)
      const completed = eventsFrom(lines)
      const starts = completed.filter(
        (event) => event.type === 'content_block_start' && event.content_block?.type === 'tool_use',
      )
      const deltas = completed.filter((event) => event.delta?.type === 'input_json_delta')
      assert.equal(starts.length, 1)
      assert.deepEqual(
        deltas.map((event) => event.delta.partial_json),
        [first, second],
      )
      assert.equal(completed.filter((event) => event.type === 'content_block_stop').length, 1)
      assert.equal(completed.filter((event) => event.type === 'message_delta').length, 1)
      assert.equal(completed.at(-1).type, 'message_stop')
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
    assert.match(lines.join('\n'), /tool_secret/)
    assert.match(lines.join('\n'), /event: error/)
    assert.doesNotMatch(lines.join('\n'), /message_stop/)
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

unixTest(
  'CRAG cache policy rejection triggers one-shot cache_control repair-and-retry without exposing diagnostics',
  async (t) => {
    const rejection = { type: 'error', error: { type: 'api_error', message: 'Kernel rejected the request' } }
    const facts = {
      type: 'kin_provider_result',
      schema_version: 2,
      source: 'crag',
      provider_complete: false,
      usage_complete: false,
      public_status: 502,
      error: rejection.error,
      observation: { policy_blocked: true, exception: { code: 'CRAG_CACHE_CONTROL', message: 'private observation' } },
    }
    const fx = await fixture(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(resultFrame(facts) + frame(rejection))
      },
      { capabilities: ['native_handoff_v1', 'provider_result_v2'] },
    )
    t.after(() => fx.close())
    const body = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hello' }] }
    const result = await streamGoWorker(options(fx, { envelope: { body, headers: {}, stream: true } }))
    assert.equal(result.terminalState, 'rejected')
    assert.equal(result.cragCacheControlBlocked, true)
    assert.equal(result.body.error.code, 'crag_policy_blocked')
    assert.equal(result.body.error.details.retryable, false)
    assert.doesNotMatch(JSON.stringify(result.body), /private observation/)

    // First attempt before dispatch: repair-and-retry on same account without cooldown.
    const firstPolicy = classifyUpstreamResult(result, { repaired: false })
    assert.equal(firstPolicy.action, 'repair-and-retry')
    assert.equal(firstPolicy.reason, 'cache_control_repairable')
    assert.equal(firstPolicy.retrySameAccount, true)
    assert.equal(firstPolicy.cooldownUntil, null)
    assert.equal(firstPolicy.scope, 'request')

    // If still rejected after repair, stop cleanly without looping or cooling down the account.
    const secondPolicy = classifyUpstreamResult(result, { repaired: true })
    assert.equal(secondPolicy.action, 'stop')
    assert.equal(secondPolicy.reason, 'crag_policy_blocked')
    assert.equal(secondPolicy.cooldownUntil, null)
    assert.equal(secondPolicy.scope, 'request')

    // End-to-end FailoverRunner: first attempt rejects with CRAG_CACHE_CONTROL,
    // second attempt strips broken caller cache_control and succeeds on the same slot.
    const seenBodies = []
    let selections = 0
    const scheduler = {
      async selectAndReserve() {
        selections++
        return { ok: true, vmId: 'vm-01', accountId: 'acc-1', vm: { id: 'vm-01' }, release() {} }
      },
      markRateLimited() {
        throw new Error('must not cool down account on CRAG_CACHE_CONTROL repair')
      },
    }
    const runner = new FailoverRunner({
      scheduler,
      schedulerRuntime: createFailoverMockSchedulerRuntime({ scheduler }),
    })
    const runResult = await runner.run({
      canonicalBody: {
        model: 'claude-opus-5-5',
        system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        ],
      },
      model: 'claude-opus-5-5',
      callAttempt: async ({ body: attemptBody }) => {
        seenBodies.push(structuredClone(attemptBody))
        if (seenBodies.length === 1) return result
        return { ok: true, status: 200, committed: true, terminalState: 'verified', body: { id: 'msg_ok' } }
      },
    })
    assert.equal(runResult.ok, true)
    assert.equal(seenBodies.length, 2)
    assert.equal(selections, 1, 'one-shot body repair stays on the held Rust lease')
    assert.deepEqual(seenBodies[0].system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
    assert.equal(seenBodies[1].system[0].cache_control, undefined)
    assert.equal(seenBodies[1].messages[0].content[0].cache_control, undefined)
  },
)

unixTest('#1139: opaque CRAG 429 returns once without restricting the account', async (t) => {
  const error = { type: 'rate_limit_error', message: 'Error' }
  const rejection = { type: 'error', error, request_id: 'req_compact_fixture' }
  const facts = {
    type: 'kin_provider_result',
    schema_version: 2,
    provider_complete: true,
    usage_complete: false,
    source: 'provider_http',
    http_status: 429,
    public_status: 429,
    request_id: rejection.request_id,
    response_headers: { 'content-type': 'application/json', 'request-id': rejection.request_id },
    error,
  }
  const fx = await fixture(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(resultFrame(facts) + frame(rejection))
    },
    { capabilities: ['native_handoff_v1', 'provider_result_v2'] },
  )
  t.after(() => fx.close())

  let seats = 1
  let selections = 0
  let releases = 0
  const restrictions = []
  const quotaSamples = []
  const scheduler = {
    async selectAndReserve({ excluded }) {
      selections++
      for (let i = 1; i <= seats; i++) {
        const vmId = `vm-0${i}`
        if (excluded.has(vmId)) continue
        return { ok: true, vmId, accountId: vmId, vm: { id: vmId }, release: () => releases++ }
      }
      return { ok: false, reason: 'pool_queue_timeout' }
    },
    markCooldown: (_candidate, update) => restrictions.push(update),
  }
  const runner = new FailoverRunner({
    scheduler,
    schedulerRuntime: createFailoverMockSchedulerRuntime({ scheduler }),
    onSchedulePause: (update) => restrictions.push(update),
    rateLimitService: new RateLimitService({
      runtimeRepo: { updateWindow: (...args) => restrictions.push(args) },
      onUsageProbe: (...args) => restrictions.push(args),
    }),
  })
  const root = path.dirname(fx.exec.homeDir)
  const cfg = {
    rewrite: { enabled: false },
    intercept: { rules: [] },
    distill: { enabled: false },
    limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
    paths: { project: root, data: root },
  }
  const routing = { failover: { stream_keepalive_ms: 0 } }
  const handler = createHandleProtocol({
    ...createRespond(cfg),
    readBody,
    cfg,
    requireAuth: () => true,
    requestLog: { start: () => ({ request_id: `compact-${selections}` }), finish() {} },
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    groupsRepo: { rateMultiplier: () => 1 },
    routingConfigPath: path.join(root, 'routing.json'),
    routingConfig: routing,
    getRoutingConfig: () => routing,
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    apiKeyStore: {},
    accountQuota: { ingestHeaders: (...args) => quotaSamples.push(args) },
    failoverRunner: {
      run(opts) {
        return runner.run({
          ...opts,
          applyAttempt: null,
          callAttempt: ({ body, signal, onCommit }) =>
            streamGoWorker(options(fx, { envelope: { body, headers: {}, stream: true }, signal, onCommit })),
        })
      },
    },
  })
  const gateway = http.createServer((req, res) => {
    req.apiKeyKind = 'master'
    handler.handleProtocol(req, res, 'anthropic.messages', req.url).catch((error) => {
      res.writeHead(500)
      res.end(String(error.stack))
    })
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    gateway.closeAllConnections()
    await new Promise((resolve) => gateway.close(resolve))
  })

  for (const [model, stream, poolSize] of [
    ['claude-sonnet-5-5', false, 1],
    ['claude-fable-5-2', true, 3],
    ['claude-fable-5-2', false, 3],
  ]) {
    seats = poolSize
    const previous = selections
    const response = await fetch(`http://127.0.0.1:${gateway.address().port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Create a detailed summary of the conversation so far.' }],
      }),
    })
    const text = await response.text()
    assert.equal(response.status, 429, text)
    const body = JSON.parse(text)
    assert.equal(body.error.type, error.type)
    assert.equal(body.error.message, error.message)
    assert.equal(body.error.request_id, rejection.request_id)
    assert.equal(response.headers.get('retry-after'), null)
    assert.equal(selections - previous, 1)
  }
  assert.equal(fx.requests.length, 3)
  assert.equal(releases, 3)
  assert.deepEqual(restrictions, [])
  assert.deepEqual(quotaSamples, [])
})

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
    assert.equal(received.committed, true)
    assert.match(lines.join('\n'), /tool_secret/)
    assert.match(lines.join('\n'), /event: error/)
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
          assert.equal(received.ok, !(stream && stopReason === 'refusal'))
          assert.equal(received.nativeHandoff, true)
          if (!(stream && stopReason === 'refusal')) {
            assert.equal(received.stopReason, stopReason)
            assert.deepEqual(received.providerResult, result)
            assert.deepEqual(received.body.content, serverContent)
          } else {
            assert.equal(received.committed, true)
            assert.match(lines.join('\n'), /client_secret/)
            assert.match(lines.join('\n'), /event: error/)
          }
          assert.deepEqual(received.usage, USAGE)
          if (stream && stopReason !== 'refusal') {
            assert.deepEqual(
              eventsFrom(lines)
                .filter((event) => event.type === 'content_block_start')
                .map((event) => event.content_block),
              serverContent,
            )
          }
          assertPrivate(received, lines)
        } finally {
          await fx.close()
        }
      },
    )
  }
}

for (const deliveryMode of ['realtime', 'verified']) {
  unixTest(`thinking-only max_tokens 502 is recovered after a ${deliveryMode} commit`, async () => {
    const facts = {
      schema_version: 2,
      type: 'kin_provider_result',
      source: 'crag',
      http_status: 200,
      public_status: 502,
      provider_complete: true,
      usage_complete: true,
      response_valid: false,
      delivery_error: { status: 502, type: 'api_error' },
      validation_error: { type: 'api_error', message: 'native request completed without response content' },
      message_id: 'msg_native_thinking_only',
      model: MODEL,
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: { input_tokens: 196, output_tokens: 64, cache_read_input_tokens: 49109, cache_creation_input_tokens: 0 },
    }
    const fx = await fixture(
      async (req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(start({ ...summary(), message_id: facts.message_id }))
        res.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))
        res.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }))
        res.write(
          frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
        )
        res.write(frame({ type: 'error', error: { type: 'api_error', message: facts.validation_error.message } }))
        res.write(resultFrame(facts))
        res.end()
      },
      { capabilities: ['native_handoff_v1', 'provider_result_v2'] },
    )
    try {
      const lines = []
      let commits = 0
      const result = await streamGoWorker({
        ...options(fx),
        deliveryMode,
        onCommit: () => commits++,
        onEvent: async (line) => lines.push(line),
      })
      assert.equal(result.ok, true)
      assert.equal(result.status, 200)
      assert.equal(result.recoveredEmptyContent, true)
      assert.equal(commits, 1)
      const types = eventsFrom(lines).map((event) => event.type)
      assert.equal(types.filter((type) => type === 'message_start').length, 1)
      assert.ok(!types.includes('error'))
      assert.deepEqual(types.slice(-2), ['message_delta', 'message_stop'])
      const open = new Set()
      for (const event of eventsFrom(lines)) {
        if (event.type === 'content_block_start') open.add(event.index)
        if (event.type === 'content_block_stop') open.delete(event.index)
      }
      assert.equal(open.size, 0)
    } finally {
      await fx.close()
    }
  })
}

test('realtime native handoff completes real max_tokens cut inside tool_use without native_handoff_conflict', async () => {
  for (const closeToolBlock of [true, false]) {
    const result = summary({ stop_reason: 'max_tokens' })
    const toolStream = [
      frame({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_cut', name: 'Write', input: {} },
      }),
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"filePath":"/tmp/a' },
      }),
      ...(closeToolBlock ? [frame({ type: 'content_block_stop', index: 0 })] : []),
    ].join('')
    const sse = start(result) + toolStream + resultFrame(result) + terminalFrames(result)
    const response = Readable.from([Buffer.from(sse)])
    response.headers = { 'content-type': 'text/event-stream' }
    response.trailers = {}

    const state = createNativeHandoffState({ nativeHandoff: true })
    const lines = []
    let commits = 0
    const received = await consumeNativeHandoffStream(response, {
      state,
      deliveryMode: 'realtime',
      isCommitEvent: (event) => event.type === 'content_block_start',
      onCommit: () => commits++,
      onEvent: (line) => lines.push(line),
    })

    assert.equal(commits, 1)
    assert.equal(received.committed, true)
    assert.equal(received.body.type, 'message')
    assert.equal(received.body.stop_reason, 'max_tokens')
    assert.deepEqual(received.body.usage, USAGE)
    const events = eventsFrom(lines)
    assert.ok(!events.some((event) => event.type === 'error'))
    assert.equal(events.filter((event) => event.type === 'content_block_stop' && event.index === 0).length, 1)
    assert.equal(events.at(-2).type, 'message_delta')
    assert.equal(events.at(-2).delta.stop_reason, 'max_tokens')
    assert.equal(events.at(-1).type, 'message_stop')
  }
})

test('realtime native handoff still fails committed tool_use on refusal stop', async () => {
  const result = summary({ stop_reason: 'refusal' })
  const sse = start(result) + toolFrames(0, 'toolu_refused') + resultFrame(result) + terminalFrames(result)
  const response = Readable.from([Buffer.from(sse)])
  response.headers = { 'content-type': 'text/event-stream' }
  response.trailers = {}

  const state = createNativeHandoffState({ nativeHandoff: true })
  const lines = []
  const received = await consumeNativeHandoffStream(response, {
    state,
    deliveryMode: 'realtime',
    isCommitEvent: (event) => event.type === 'content_block_start',
    onEvent: (line) => lines.push(line),
  })
  assert.equal(received.body.type, 'error')
  assert.equal(received.body.error.code, 'native_handoff_conflict')
  assert.ok(eventsFrom(lines).some((event) => event.type === 'error'))
})

test('multi-chunk signature_delta appends instead of overwriting', () => {
  const assembler = createClaudeMessageAssembler()
  const lines = [
    'data: {"type":"message_start","message":{"id":"msg_sig","model":"claude-opus-5","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"abc"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"part1-"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"part2"}}',
    'data: {"type":"content_block_stop","index":0}',
  ]
  for (const line of lines) applyClaudeSSELineToMessage(line, assembler)
  assert.equal(assembler.message.content[0].signature, 'part1-part2')

  const respState = createResponsesStreamState('claude-opus-5', 'vm-test', [])
  for (const line of lines) claudeSSELineToResponsesEvents(line, respState)
  const encoded = respState.output[0].encrypted_content.replace(/^anthropic-thinking-v1:/, '')
  assert.equal(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')).signature, 'part1-part2')
})

unixTest(
  '#1845: protocol handler persists hop_request_id, providerResult correlation IDs, #1705 error_details, and writeHead headers',
  async (t) => {
    const providerSuccess = summary({
      schema_version: 2,
      provider_complete: true,
      handoff_complete: true,
      delivery_complete: true,
      response_valid: true,
      source: 'provider_http',
      http_status: 200,
      public_status: 200,
      stop_reason: 'end_turn',
      run_id: 'run_1845_ok',
      turn_id: 'turn_1845_ok',
      attempt_id: 2,
      request_id: 'req_anthropic_ok',
    })
    const provider409 = {
      type: 'kin_provider_result',
      schema_version: 2,
      provider_complete: false,
      usage_complete: false,
      source: 'crag',
      http_status: 409,
      public_status: 409,
      run_id: 'run_1845_409',
      turn_id: 'turn_1845_409',
      attempt_id: 3,
      request_id: 'req_anthropic_409',
      error: {
        type: 'partial_provider_output_nonretryable',
        message: 'Provider output for this continuation was interrupted and cannot be replayed immediately.',
        details: {
          retryable: true,
          prior_reason: 'client_cancelled',
          interrupted_at: 1795495209,
          retry_after_sec: 20,
          recovery_attempts: 1,
          max_recoveries: 2,
          recovery_exhausted: false,
          internal_secret: 'sk-ant-oat01-must-not-leak',
        },
      },
    }

    let mode = 'ok'
    const fx = await fixture(
      async (_req, res) => {
        if (mode === '409') {
          res.writeHead(409, {
            'content-type': 'application/json',
            'x-kin-provider-result': JSON.stringify(provider409),
            'retry-after': '20',
          })
          res.end(JSON.stringify({ type: 'error', error: provider409.error, _kin_provider_result: provider409 }))
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          trailer: 'x-kin-provider-result',
        })
        res.write(
          start(providerSuccess) +
            textFrames(0, 'done') +
            resultFrame(providerSuccess) +
            terminalFrames(providerSuccess),
        )
        res.addTrailers({ 'x-kin-provider-result': JSON.stringify(providerSuccess) })
        res.end()
      },
      { capabilities: ['native_handoff_v1', 'provider_result_v2'] },
    )
    t.after(() => fx.close())

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-nh-1845-'))
    const logStore = new RequestLogStore({ dataDir, mode: 'debug' })
    const attemptsRepo = new RequestAttemptsRepo(logStore.db)
    t.after(() => {
      logStore.db.close()
      fs.rmSync(dataDir, { recursive: true, force: true })
    })

    const scheduler = {
      async selectAndReserve() {
        return {
          ok: true,
          vmId: 'vm-11',
          accountId: 'acc-11',
          vm: { id: 'vm-11' },
          selectionReason: 'sticky',
          release() {},
        }
      },
      markSuccess() {},
      markCooldown() {},
    }
    const runner = new FailoverRunner({
      attemptsRepo,
      scheduler,
      schedulerRuntime: createFailoverMockSchedulerRuntime({ scheduler }),
    })

    const cfg = {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { project: dataDir, data: dataDir },
    }
    const routing = { failover: { stream_keepalive_ms: 0 } }
    const handler = createHandleProtocol({
      ...createRespond(cfg),
      readBody,
      cfg,
      requireAuth: () => true,
      requestLog: logStore,
      stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
      groupsRepo: { rateMultiplier: () => 1 },
      routingConfigPath: path.join(dataDir, 'routing.json'),
      routingConfig: routing,
      getRoutingConfig: () => routing,
      stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
      apiKeyStore: {},
      accountQuota: { ingestHeaders() {} },
      failoverRunner: {
        run(opts) {
          return runner.run({
            ...opts,
            applyAttempt: null,
            callAttempt: ({ body, signal, onCommit }) =>
              streamGoWorker(
                options(fx, {
                  envelope: { body, headers: {}, stream: true },
                  gatewayRequestId: opts.requestId,
                  signal,
                  onCommit,
                }),
              ),
          })
        },
      },
    })

    const gateway = http.createServer((req, res) => {
      req.apiKeyKind = 'master'
      handler.handleProtocol(req, res, 'anthropic.messages', req.url).catch((error) => {
        if (!res.headersSent) res.writeHead(500)
        res.end(String(error.stack))
      })
    })
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    t.after(async () => {
      gateway.closeAllConnections()
      await new Promise((resolve) => gateway.close(resolve))
    })

    const base = `http://127.0.0.1:${gateway.address().port}`
    const okResp = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'gw-1845-ok' },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    assert.equal(okResp.status, 200)
    await okResp.json()

    mode = '409'
    const errResp = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'gw-1845-409' },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    assert.equal(errResp.status, 409)
    assert.equal(errResp.headers.get('x-request-id'), 'gw-1845-409')
    assert.equal(errResp.headers.get('x-should-retry'), 'false')
    await errResp.json()
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(fx.requests.length, 2)
    assert.equal(fx.requests[0].headers['x-gateway-request-id'], 'gw-1845-ok')
    assert.equal(fx.requests[1].headers['x-gateway-request-id'], 'gw-1845-409')
    const hopIdOk = fx.requests[0].envelope.request_id
    const hopId409 = fx.requests[1].envelope.request_id
    assert.ok(hopIdOk && hopId409 && hopIdOk !== hopId409)

    // Debug hop_meta + response headers verification
    const dbgOk = logStore.getDebug('gw-1845-ok')
    assert.equal(dbgOk.hop_meta.hop_request_id, hopIdOk)
    assert.equal(dbgOk.hop_meta.native_handoff.hop_request_id, hopIdOk)
    assert.equal(dbgOk.hop_meta.native_handoff.run_id, 'run_1845_ok')
    assert.equal(dbgOk.hop_meta.native_handoff.turn_id, 'turn_1845_ok')
    assert.equal(dbgOk.hop_meta.native_handoff.attempt_id, 2)
    assert.equal(dbgOk.hop_meta.native_handoff.request_id, 'req_anthropic_ok')

    const dbg409 = logStore.getDebug('gw-1845-409')
    assert.equal(dbg409.response.headers['x-request-id'], 'gw-1845-409')
    assert.equal(dbg409.response.headers['x-should-retry'], 'false')
    assert.equal(dbg409.hop_meta.hop_request_id, hopId409)
    assert.equal(dbg409.hop_meta.native_handoff.run_id, 'run_1845_409')
    assert.equal(dbg409.hop_meta.native_handoff.turn_id, 'turn_1845_409')
    assert.equal(dbg409.hop_meta.native_handoff.attempt_id, 3)
    assert.equal(dbg409.hop_meta.native_handoff.request_id, 'req_anthropic_409')

    // Normal usage_logs + request_attempts + UsageLogsView verification
    const view = new UsageLogsView(logStore.db)
    const rowOk = view.listBatch({ request_id: 'gw-1845-ok' }).logs[0]
    assert.equal(rowOk.providerChain.length, 1)
    assert.equal(rowOk.providerChain[0].hopRequestId, hopIdOk)
    assert.equal(rowOk.providerChain[0].providerRunId, 'run_1845_ok')
    assert.equal(rowOk.providerChain[0].providerTurnId, 'turn_1845_ok')
    assert.equal(rowOk.providerChain[0].providerAttemptId, 2)
    assert.equal(rowOk.providerChain[0].providerRequestId, 'req_anthropic_ok')

    const row409 = view.listBatch({ request_id: 'gw-1845-409' }).logs[0]
    assert.equal(row409.statusCode, 409)
    assert.equal(row409.errorCode, 'partial_provider_output_nonretryable')
    assert.equal(row409.upstreamType, 'partial_provider_output_nonretryable')
    assert.deepEqual(row409.errorDetails, {
      upstream_type: 'partial_provider_output_nonretryable',
      retryable: false,
      prior_reason: 'client_cancelled',
      interrupted_at: 1795495209,
      retry_after_sec: 20,
      recovery_attempts: 1,
      max_recoveries: 2,
      recovery_exhausted: false,
    })
    assert.equal(row409.providerChain.length, 1)
    assert.equal(row409.providerChain[0].upstreamType, 'partial_provider_output_nonretryable')
    assert.equal(row409.providerChain[0].errorDetails.prior_reason, 'client_cancelled')
    assert.equal(row409.providerChain[0].hopRequestId, hopId409)
    assert.equal(row409.providerChain[0].providerRunId, 'run_1845_409')
    assert.equal(row409.providerChain[0].providerTurnId, 'turn_1845_409')
    assert.equal(row409.providerChain[0].providerAttemptId, 3)
    assert.equal(row409.providerChain[0].providerRequestId, 'req_anthropic_409')
  },
)
