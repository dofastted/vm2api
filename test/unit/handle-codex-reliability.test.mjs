import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleCodexProtocol } from '../../src/lib/protocol/handle-codex.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { SchedulerApiError } from '../../src/lib/transport/scheduler-client.mjs'

beforeEach(() => resetOpenAIAccountRuntime())

const rejectedToolSchema = {
  ok: false,
  status: 400,
  committed: false,
  body: {
    error: {
      code: 'invalid_json_schema',
      message:
        "Invalid schema for 'tools[0].parameters': Unsatisfiable schema: required property 'id' is unsatisfiable.",
    },
  },
}

const toolParameters = {
  type: 'object',
  properties: { id: { $ref: '#/$defs/id' } },
  required: ['id'],
  $defs: { id: { type: 'string' } },
}

test('Codex schema recovery retries the same session once with the full tool set', async (t) => {
  const tools = [
    { type: 'function', function: { name: 'nested', parameters: toolParameters } },
    { type: 'function', name: 'flat', parameters: toolParameters },
    { type: 'function', name: 'explicit', parameters: toolParameters, strict: true },
    { type: 'web_search' },
  ]
  const seen = []
  const fx = fixture(t, {
    body: { tools },
    hop: async ({ body, exec, envelope, onEvent }) => {
      seen.push({ body, slot: exec.vmId, session: envelope.session.session_id })
      assert.equal(envelope.body, body)
      if (seen.length === 1) return rejectedToolSchema
      await onEvent(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)
      return { ok: true, status: 200, body: response, usage: response.usage, terminalState: 'verified' }
    },
  })
  fx.args.captureOutbound = true
  await handleCodexProtocol(fx.args)
  assert.equal(fx.res.statusCode, 200)
  assert.equal(seen.length, 2)
  assert.equal(seen[0].slot, seen[1].slot)
  assert.equal(seen[0].session, seen[1].session)
  assert.deepEqual(seen[0].body.tools, tools)
  assert.deepEqual(seen[1].body, {
    ...seen[0].body,
    tools: [
      { type: 'function', ...tools[0].function, strict: false },
      { ...tools[1], strict: false },
      tools[2],
      tools[3],
    ],
  })
  assert.equal(fx.args.logBag.attempt_count, 2)
  assert.equal(fx.args.logBag.outbound_body, seen[1].body)
  assert.equal(fx.args.logBag.codex_failed_over, undefined)
})

test('Codex schema recovery returns the upstream error after one compatibility attempt', async (t) => {
  let hops = 0
  const fx = fixture(t, {
    body: { tools: [{ type: 'function', name: 'implicit', parameters: toolParameters }] },
    hop: async () => {
      hops += 1
      return rejectedToolSchema
    },
  })
  await handleCodexProtocol(fx.args)
  assert.equal(hops, 2)
  assert.equal(fx.res.statusCode, 400)
  assert.deepEqual(fx.res.body, rejectedToolSchema.body)
})

test('Codex failover counts the schema recovery attempt', async (t) => {
  const slots = []
  const fx = fixture(t, {
    body: { tools: [{ type: 'function', name: 'implicit', parameters: toolParameters }] },
    hop: async ({ body, exec }) => {
      slots.push(exec.vmId)
      if (slots.length === 1) return rejectedToolSchema
      assert.equal(body.tools[0].strict, false)
      if (slots.length === 2) {
        return { ok: false, status: 503, body: { error: { code: 'no_capacity', message: 'credential busy' } } }
      }
      return { ok: true, status: 200, body: response }
    },
  })
  await handleCodexProtocol(fx.args)
  assert.equal(fx.res.statusCode, 200)
  assert.equal(slots.length, 3)
  assert.equal(slots[0], slots[1])
  assert.notEqual(slots[1], slots[2])
  assert.equal(fx.args.logBag.attempt_count, 3)
})

test('Codex Responses accepts a messages body while preserving explicit tool strictness', async (t) => {
  const tools = [
    { type: 'function', function: { name: 'implicit', parameters: toolParameters } },
    { type: 'function', function: { name: 'strict', parameters: toolParameters, strict: true } },
    { type: 'function', name: 'non_strict', parameters: toolParameters, strict: false },
  ]
  const sent = []
  const fx = fixture(t, {
    body: { input: undefined, messages: [{ role: 'user', content: 'hello' }], tools },
    hop: async ({ body }) => {
      sent.push(body)
      return sent.length === 1 ? rejectedToolSchema : { ok: true, status: 200, body: response }
    },
  })
  await handleCodexProtocol(fx.args)
  assert.equal(fx.res.statusCode, 200)
  assert.deepEqual(
    sent.map((body) => body.tools.map((tool) => tool.strict)),
    [
      [undefined, true, false],
      [false, true, false],
    ],
  )
  assert.deepEqual(sent[1].input, sent[0].input)
  assert.ok(sent[1].tools.every((tool) => tool.parameters === toolParameters))
})

for (const boundary of ['explicit strict', 'event', 'committed', 'attempt budget']) {
  test(`Codex schema recovery skips retry with ${boundary}`, async (t) => {
    let hops = 0
    const fx = fixture(t, {
      body: {
        stream: true,
        tools: [
          {
            type: 'function',
            name: 'tool',
            parameters: toolParameters,
            ...(boundary === 'explicit strict' && { strict: true }),
          },
        ],
      },
      hop: async ({ onEvent }) => {
        hops += 1
        if (boundary === 'event') await onEvent('data: {"type":"response.created"}\n\n')
        return { ...rejectedToolSchema, committed: boundary === 'committed' }
      },
    })
    if (boundary === 'attempt budget') fx.args.routing.failover = { max_total_attempts: 1 }
    await handleCodexProtocol(fx.args)
    assert.equal(hops, 1)
  })
}

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
  let leaseSeq = 0
  const slotIds = ['gpt-a', 'gpt-b']
  const mockSchedulerRuntime = {
    async acquireNode(params) {
      const excluded = new Set(params.excludeNodes || [])
      const picked = slotIds.find((id) => !excluded.has(`codex_vm:${id}`) && !excluded.has(id))
      if (!picked) {
        throw new SchedulerApiError({ status: 503, code: 'pool_exhausted', message: 'No codex slot available' })
      }
      return {
        lease_id: `codex-lease-${++leaseSeq}`,
        lease_ttl_ms: 30_000,
        resolved_pool_id: params.originPoolId || '__default_codex__',
        selected_node: { node_type: 'codex_vm', node_id: picked, node_key: `codex_vm:${picked}` },
      }
    },
    async switchNode(body) {
      return this.acquireNode(body.next_attempt || {})
    },
    async commitLease() {},
    async releaseLease() {},
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
    schedulerRuntime: mockSchedulerRuntime,
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
  ['Accept JSON and SSE', {}, { accept: 'application/json, text/event-stream' }, false],
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

for (const stream of [true, false]) {
  test(`Codex 6.2 preserves a large tool catalog and the incomplete terminal (stream=${stream})`, async (t) => {
    const members = Array.from({ length: 150 }, (_, index) => ({
      type: 'function',
      name: `lookup_${index}`,
      description: `Tool description ${'long '.repeat(240)}`,
      parameters: { type: 'object', properties: { max_output_tokens: { type: 'integer' } } },
    }))
    const tools = [
      { type: 'namespace', name: 'catalog', tools: members },
      { type: 'tool_search', execution: 'client' },
    ]
    const toolChoice = { type: 'function', namespace: 'catalog', name: members.at(-1).name }
    const terminal = {
      ...response,
      model: 'gpt-6.2-sol',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
      usage: { input_tokens: 20000, output_tokens: 0 },
    }
    const event = { type: 'response.incomplete', response: terminal }
    let attempts = 0
    const fx = fixture(t, {
      body: { model: terminal.model, stream, tools, tool_choice: toolChoice, max_completion_tokens: 10 },
      hop: async ({ envelope, onEvent }) => {
        attempts++
        assert.deepEqual(envelope.body.tools, tools)
        assert.deepEqual(envelope.body.tool_choice, toolChoice)
        assert.equal(Object.hasOwn(envelope.body, 'max_completion_tokens'), false)
        await onEvent(`data: ${JSON.stringify(event)}`)
        await onEvent('')
        return { ok: true, status: 200, body: terminal, terminalState: 'incomplete' }
      },
    })
    await handleCodexProtocol(fx.args)
    assert.equal(attempts, 1)
    assert.equal(fx.res.statusCode, 200)
    assert.equal(fx.args.logBag.final_state, 'incomplete')
    assert.equal(fx.args.logBag.stop_reason, 'max_output_tokens')
    assert.equal(fx.args.logBag.input_tokens, 20000)
    if (stream) assert.equal(fx.chunks.join(''), `event: response.incomplete\ndata: ${JSON.stringify(event)}\n\n`)
    else assert.deepEqual(fx.res.body, terminal)
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
