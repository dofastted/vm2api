import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleCodexProtocol } from '../../src/lib/protocol/handle-codex.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

beforeEach(() => resetOpenAIAccountRuntime())

const response = {
  id: 'resp_test',
  object: 'response',
  model: 'gpt-5.5',
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
}

function fixture(t, { body = {}, headers = {}, protocol = 'openai.responses', hop } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relay-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const id of ['gpt-a', 'gpt-b']) {
    fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({
        id,
        platform: 'openai',
        family: 'codex',
        schedulable: true,
        status: 'running',
        has_token: true,
      }),
    )
    fs.writeFileSync(
      path.join(root, 'vms', id, 'codex-credentials.json'),
      JSON.stringify({
        accounts: [{ id, access_token: 'test-only', refresh_token: 'test-only', chatgpt_account_id: id }],
      }),
    )
  }
  const inbound = { model: 'gpt-5.5', input: 'hi', ...body }
  const chunks = []
  const res = {
    headersSent: false,
    statusCode: 0,
    body: null,
    write(chunk) {
      chunks.push(chunk)
    },
    end() {},
  }
  const args = {
    req: { headers, apiKeyKind: 'user' },
    res,
    protocol,
    ctx: { body: inbound },
    inbound,
    logBag: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    json(_res, status, value) {
      res.statusCode = status
      res.body = value
    },
    writeSSEHeaders() {
      res.statusCode = 200
      res.headersSent = true
    },
    projectRoot: root,
    routing: {},
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel:
        hop ||
        (async ({ onEvent }) => {
          await onEvent(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)
          return { ok: true, status: 200, body: response, usage: response.usage, terminalState: 'verified' }
        }),
    },
  }
  return { args, res, chunks }
}

for (const [name, body, headers, streamed] of [
  ['omitted stream', {}, {}, false],
  ['explicit false', { stream: false }, {}, false],
  ['explicit true', { stream: true }, {}, true],
  ['Accept SSE', {}, { accept: 'text/event-stream' }, true],
  ['false overrides Accept', { stream: false }, { accept: 'text/event-stream' }, false],
]) {
  test(`Codex Responses respects ${name}`, async (t) => {
    const fx = fixture(t, { body, headers })
    await handleCodexProtocol(fx.args)
    assert.equal(fx.res.statusCode, 200)
    if (streamed) {
      assert.equal(fx.res.body, null)
      assert.match(fx.chunks.join(''), /event: response.completed/)
    } else {
      assert.deepEqual(fx.chunks, [])
      assert.equal(fx.res.body.object, 'response')
      assert.equal(fx.res.body.output[0].content[0].text, 'hello')
      assert.equal(fx.res.body.usage.total_tokens, 12)
    }
  })
}

test('non-stream Codex Chat returns Chat content, tool calls and usage', async (t) => {
  const result = {
    ...response,
    output: [
      ...response.output,
      {
        type: 'function_call',
        call_id: 'call_test',
        name: 'lookup',
        arguments: '{"q":"hello"}',
      },
    ],
  }
  const fx = fixture(t, {
    protocol: 'openai.chat',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    hop: async ({ onEvent, envelope }) => {
      assert.equal(envelope.stream, true)
      await onEvent(`data: ${JSON.stringify({ type: 'response.completed', response: result })}\n\n`)
      return { ok: true, status: 200, usage: result.usage, body: result }
    },
  })
  await handleCodexProtocol(fx.args)
  assert.deepEqual(fx.chunks, [])
  assert.equal(fx.res.body.object, 'chat.completion')
  const choice = fx.res.body.choices[0]
  assert.equal(choice.message.content, 'hello')
  assert.deepEqual(choice.message.tool_calls, [
    {
      id: 'call_test',
      type: 'function',
      function: { name: 'lookup', arguments: '{"q":"hello"}' },
    },
  ])
  assert.equal(choice.finish_reason, 'tool_calls')
  assert.equal(fx.res.body.usage.total_tokens, 12)
})

for (const [code, status, committed, expectedHops] of [
  ['no_capacity', 503, false, 2],
  ['no_capacity', 503, true, 1],
  ['body_too_large', 413, false, 1],
  ['invalid_request', 400, false, 1],
]) {
  test(`Codex failover: ${status} ${code}, committed=${committed}`, async (t) => {
    const seen = []
    const fx = fixture(t, {
      hop: async ({ exec }) => {
        seen.push(exec.vmId)
        return seen.length === 1
          ? {
              ok: false,
              status,
              committed,
              body: { error: { type: 'api_error', code, message: code === 'no_capacity' ? 'credential busy' : code } },
            }
          : { ok: true, status: 200, body: response, usage: response.usage }
      },
    })
    await handleCodexProtocol(fx.args)
    assert.equal(seen.length, expectedHops)
    assert.equal(fx.args.logBag.attempt_count, expectedHops)
    if (expectedHops === 2) {
      assert.notEqual(seen[0], seen[1])
      assert.equal(fx.res.statusCode, 200)
    } else assert.equal(fx.res.statusCode, status)
  })
}

test('busy failover respects the attempt budget and preserves the last error', async (t) => {
  let hops = 0
  const fx = fixture(t, {
    hop: async () => {
      hops++
      return { ok: false, status: 503, body: { error: { code: 'no_capacity', message: 'credential busy' } } }
    },
  })
  fx.args.routing = { failover: { max_total_attempts: 1 } }
  await handleCodexProtocol(fx.args)
  assert.equal(hops, 1)
  assert.equal(fx.res.statusCode, 503)
  assert.equal(fx.res.body.error.code, 'no_capacity')
})

for (const [name, cfg, routing, expected] of [
  ['defaults', null, {}, [600_000, 180_000]],
  [
    'configured limits',
    { limits: { upstream_timeout_ms: 45_000, stream_idle_timeout_ms: 70_000 } },
    {},
    [45_000, 70_000],
  ],
  [
    'panel idle override',
    { limits: { upstream_timeout_ms: 45_000, stream_idle_timeout_ms: 70_000 } },
    { failover: { stream_idle_timeout_ms: 90_000 } },
    [45_000, 90_000],
  ],
]) {
  test(`Codex passes ${name} to every kernel hop`, async (t) => {
    let calls = 0
    const fx = fixture(t, {
      hop: async ({ timeoutMs, idleTimeoutMs, routing: forwarded }) => {
        calls++
        assert.deepEqual([timeoutMs, idleTimeoutMs], expected)
        assert.equal(forwarded, routing)
        if (calls === 1)
          return { ok: false, status: 0, transportError: true, body: { error: { code: 'worker_timeout' } } }
        return { ok: true, status: 200, body: response, usage: response.usage }
      },
    })
    fx.args.cfg = cfg
    fx.args.routing = routing
    await handleCodexProtocol(fx.args)
    assert.equal(calls, 2)
    assert.equal(fx.res.statusCode, 200)
  })
}
