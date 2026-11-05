import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import { officialMessagesBody } from '../../src/lib/protocol/anthropic-messages.mjs'
import { prepareAnthropicRequest } from '../../src/lib/protocol/anthropic-policy.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { validateToolChoice } from '../../src/lib/protocol/model-policy.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

openDatabase({ dbPath: ':memory:' })
after(() => closeDatabase())
const schema = { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] }
const tools = [
  { name: 'chosen', input_schema: schema },
  { name: 'other', input_schema: schema },
]
const messages = [{ role: 'user', content: 'Use the supplied tool.' }]
const fixture = () => ({
  model: 'claude-haiku-5-5',
  max_tokens: 256,
  thinking: { type: 'disabled' },
  messages,
  tools: structuredClone(tools),
  tool_choice: { type: 'tool', name: 'chosen' },
})

function protocolRequest(protocol, model) {
  if (protocol === 'anthropic.messages') return { ...fixture(), model }
  const definitions = tools.map((tool) => ({ type: 'function', name: tool.name, parameters: tool.input_schema }))
  if (protocol === 'openai.responses')
    return {
      model,
      max_output_tokens: 256,
      input: 'Use the supplied tool.',
      tools: definitions,
      tool_choice: { type: 'function', name: 'chosen' },
    }
  return {
    model,
    max_tokens: 256,
    messages,
    tools: definitions.map(({ type, ...fn }) => ({ type, function: fn })),
    tool_choice: { type: 'function', function: { name: 'chosen' } },
  }
}

test('supported forced choices survive API and CLI assembly without adding strict', () => {
  for (const choice of [{ type: 'tool', name: 'chosen' }, { type: 'any' }]) {
    for (const strict of [undefined, false, true]) {
      const body = fixture()
      body.tool_choice = choice
      if (strict !== undefined) body.tools[0].strict = strict
      const before = structuredClone(body)
      assert.doesNotThrow(() => validateToolChoice(body))
      for (const out of [prepareAnthropicRequest(body), prepareCliHopBody(body)]) {
        assert.deepEqual(out.tool_choice, choice)
        assert.equal(out.tools[0].strict, strict)
        assert.deepEqual(out.tools[0].input_schema, schema)
      }
      assert.deepEqual(body, before)
    }
  }
})

test('unsupported thinking and malformed choices fail explicitly', () => {
  for (const model of ['claude-opus-5-5', 'claude-opus-5.5', 'claude-sonnet-5-5']) {
    const input = { ...fixture(), model }
    const before = structuredClone(input)
    assert.throws(
      () => validateToolChoice(input),
      (e) => e.status === 400 && e.body.error.code === 'tool_choice_incompatible',
    )
    assert.deepEqual(input, before)
  }
  for (const thinking of [{ type: 'enabled', budget_tokens: 1024 }, { type: 'adaptive' }]) {
    assert.throws(() => validateToolChoice({ ...fixture(), thinking }), /cannot be combined/)
  }
  assert.throws(
    () => validateToolChoice({ ...fixture(), tool_choice: { type: 'tool', name: 'missing' } }),
    /supplied tool/,
  )
  assert.throws(() => validateToolChoice({ ...fixture(), tool_choice: 'required' }), /tool_choice.type/)
  assert.doesNotThrow(() =>
    validateToolChoice({ ...fixture(), model: 'claude-opus-5-5', tool_choice: { type: 'auto' } }),
  )
  assert.doesNotThrow(() => validateToolChoice({ ...fixture(), tools: [], tool_choice: { type: 'none' } }))
})

for (const protocol of ['anthropic.messages', 'openai.chat', 'openai.responses']) {
  test(`${protocol} keeps forced choice when tools are missing so validation can reject it`, () => {
    const input = protocolRequest(protocol, 'claude-haiku-5-5')
    input.tools = []
    const converted = toClaudeMessages(protocol, input).claude
    const shaped = officialMessagesBody(converted)
    assert.deepEqual(shaped.tool_choice, { type: 'tool', name: 'chosen' })
    assert.throws(
      () => validateToolChoice(shaped),
      (e) => e.status === 400 && e.body.error.code === 'invalid_tool_choice',
    )
  })

  test(`${protocol} OAuth rejects unsupported requests before admission or upstream selection`, async () => {
    const input = protocolRequest(protocol, 'claude-sonnet-5-5')
    let admissions = 0
    let selections = 0
    const response = { headersSent: false, on() {}, once() {}, off() {}, write() {}, end() {} }
    const handler = createHandleProtocol({
      json: (_res, status, body) => {
        response.status = status
        response.body = body
      },
      writeSSEHeaders() {},
      readBody: async () => input,
      requireAuth: () => true,
      cfg: {
        rewrite: { enabled: false },
        intercept: { rules: [] },
        distill: { enabled: false },
        limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
        paths: { data: os.tmpdir(), project: os.tmpdir() },
      },
      requestLog: { start: () => ({ request_id: 'forced-choice-test' }), finish() {} },
      stickyRouter: {},
      accountQuota: {},
      apiKeyStore: {
        acquire: () => {
          admissions++
          return { ok: true }
        },
        release() {},
        users: { getById: () => ({ role: 'admin' }) },
      },
      apiScheduler: {
        pick: () => {
          selections++
          return { ok: false }
        },
      },
      apiEndpointStore: {},
      stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
      routingConfig: { failover: {} },
      groupsRepo: { rateMultiplier: () => 1 },
    })
    const req = {
      method: 'POST',
      url: '/v1/messages',
      headers: { 'user-agent': 'test-client' },
      apiKeyKind: 'managed',
      apiKeyRecord: { category: 'oauth', user_id: 'admin' },
      once() {},
      off() {},
    }
    await handler.handleProtocol(req, response, protocol, '/v1/messages')
    assert.equal(response.status, 400)
    assert.equal(
      response.body.error.code,
      protocol === 'openai.responses' ? 'protocol_not_allowed' : 'tool_choice_incompatible',
    )
    assert.equal(admissions, 0)
    assert.equal(selections, 0)
  })
}
