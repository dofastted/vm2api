import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  copyOfficialAnthropicFields,
  openaiResponseFormatToOutputConfig,
  applyStructuredOutput,
  stripIllegalContentFields,
  stripIllegalBodyContentFields,
  promoteContentToBlocks,
  promoteSystemToBlocks,
  canonicalizeClaudeMessagesShape,
  isSmallTextTurn,
  sanitizeAnthropicBody,
} from '../../src/lib/protocol/sanitize.mjs'

test('small single-turn text uses the ordinary path, not the heavier history fast path', () => {
  const short = { messages: [{ role: 'user', content: 'short prompt' }] }
  assert.equal(isSmallTextTurn(short), true)
  assert.equal(isSmallTextTurn(canonicalizeClaudeMessagesShape(short)), true)
  assert.equal(isSmallTextTurn({ ...short, tools: [{ name: 'lookup' }] }), false)
  assert.equal(isSmallTextTurn({ messages: [...short.messages, { role: 'assistant', content: 'reply' }] }), false)
  assert.equal(isSmallTextTurn({ messages: [{ role: 'user', content: 'x'.repeat(4097) }] }), false)
  assert.equal(isSmallTextTurn({ messages: [{ role: 'user', content: [{ type: 'image' }] }] }), false)
})

test('native history fast path preserves typed blocks without rebuilding them', () => {
  const body = {
    model: 'claude-haiku-4-5',
    system: 'caller guidance',
    settings: { unused: true },
    stop: 'stop',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'keep spacing  ', cache_control: { type: 'ephemeral' } }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'signed', signature: 'signature' },
          { type: 'tool_use', id: 'toolu_pair', name: 'lookup', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_pair', content: [{ type: 'text', text: 'result' }] }],
      },
    ],
  }
  const output = sanitizeAnthropicBody(body, { reuseCanonicalHistory: true })
  assert.equal(output.messages, body.messages)
  assert.deepEqual(output, sanitizeAnthropicBody(structuredClone(body)))
  assert.deepEqual(output.stop_sequences, ['stop'])
  assert.equal(Object.hasOwn(output, 'settings'), false)
})

test('native history fast path falls back for real normalization without modifying shared history', () => {
  const text = { type: 'text', text: 'keep' }
  const cases = [
    [{ role: 'user', content: ['string block'] }],
    [{ role: 'user', content: [text, { type: 'text', text: '  ' }] }],
    [{ role: 'user', content: [{ ...text, annotations: ['strip'] }] }],
    [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_pair', content: [{ ...text, annotations: ['strip'] }] }],
      },
    ],
    [{ role: 'user', content: [{ ...text, text: 'Auto mode still active (reported by harness).' }] }],
    [
      { role: 'developer', content: [text] },
      { role: 'user', content: [text] },
    ],
    [{ role: 'assistant', content: [text] }],
    [
      { role: 'user', content: [text] },
      { role: 'user', content: [text] },
    ],
  ]
  for (const messages of cases) {
    const body = { model: 'claude-haiku-4-5', messages }
    const original = structuredClone(body)
    const output = sanitizeAnthropicBody(body, { reuseCanonicalHistory: true })
    assert.notEqual(output.messages, messages)
    assert.deepEqual(body, original)
    assert.deepEqual(output, sanitizeAnthropicBody(original))
  }
})

test('copyOfficialAnthropicFields keeps official keys and drops client junk', () => {
  const out = copyOfficialAnthropicFields({
    model: 'claude-sonnet-5',
    messages: [],
    max_tokens: 1024,
    temperature: 1,
    system: 'hi',
    tools: [],
    // dropped keys
    settings: { foo: 1 },
    env: { BAR: 'baz' },
    user: 'u1',
    extra_body: {},
    response_format: {},
    seed: 42,
    parallel_tool_calls: true,
    reasoning_effort: 'high',
    stream_options: {},
    previous_response_id: 'r_1',
    machine_id: 'm',
    account_uuid: 'a',
  })
  assert.deepEqual(Object.keys(out).sort(), ['max_tokens', 'messages', 'model', 'system', 'temperature', 'tools'])
})

test('copyOfficialAnthropicFields drops undefined values', () => {
  const out = copyOfficialAnthropicFields({ model: 'x', temperature: undefined })
  assert.deepEqual(out, { model: 'x' })
})

test('copyOfficialAnthropicFields handles null/undefined body', () => {
  assert.deepEqual(copyOfficialAnthropicFields(null), {})
  assert.deepEqual(copyOfficialAnthropicFields(undefined), {})
})

test('openaiResponseFormatToOutputConfig converts json_schema', () => {
  const result = openaiResponseFormatToOutputConfig({
    type: 'json_schema',
    json_schema: { name: 'task', schema: { type: 'object' } },
  })
  assert.deepEqual(result, {
    format: {
      type: 'json_schema',
      schema: { type: 'object' },
      name: 'task',
    },
  })
})

test('openaiResponseFormatToOutputConfig converts json_object', () => {
  const result = openaiResponseFormatToOutputConfig({ type: 'json_object' })
  assert.deepEqual(result, {
    format: { type: 'json_schema', schema: { type: 'object' } },
  })
})

test('openaiResponseFormatToOutputConfig returns null for unknown type', () => {
  assert.equal(openaiResponseFormatToOutputConfig({ type: 'text' }), null)
  assert.equal(openaiResponseFormatToOutputConfig(null), null)
  assert.equal(openaiResponseFormatToOutputConfig(undefined), null)
})

test('stripIllegalContentFields removes annotations from text blocks', () => {
  const content = [
    { type: 'text', text: 'hello', annotations: [{ type: 'cite' }] },
    { type: 'text', text: 'world' },
  ]
  const result = stripIllegalContentFields(content)
  assert.equal(result[0].annotations, undefined)
  assert.equal(result[1].annotations, undefined)
  assert.equal(result[0].text, 'hello')
})

test('stripIllegalContentFields recurses into tool_result blocks', () => {
  const content = [
    {
      type: 'tool_result',
      tool_use_id: 't1',
      content: [{ type: 'text', text: 'ok', annotations: [{ type: 'cite' }] }],
    },
  ]
  const result = stripIllegalContentFields(content)
  assert.equal(result[0].content[0].annotations, undefined)
})

test('stripIllegalContentFields returns non-array as-is', () => {
  assert.equal(stripIllegalContentFields('hello'), 'hello')
  assert.equal(stripIllegalContentFields(null), null)
})

test('stripIllegalBodyContentFields cleans messages and system', () => {
  const body = {
    system: [{ type: 'text', text: 'sys', annotations: [] }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', annotations: [] }] }],
  }
  const result = stripIllegalBodyContentFields(body)
  assert.equal(result.system[0].annotations, undefined)
  assert.equal(result.messages[0].content[0].annotations, undefined)
})

test('promoteContentToBlocks converts string to text block array', () => {
  assert.deepEqual(promoteContentToBlocks('hello'), [{ type: 'text', text: 'hello' }])
  assert.deepEqual(promoteContentToBlocks(''), [])
  assert.equal(promoteContentToBlocks(null), null)
  assert.deepEqual(promoteContentToBlocks([{ type: 'text', text: 'a' }]), [{ type: 'text', text: 'a' }])
  assert.deepEqual(promoteContentToBlocks(['str', { type: 'text', text: 'b' }]), [
    { type: 'text', text: 'str' },
    { type: 'text', text: 'b' },
  ])
})

test('promoteSystemToBlocks converts string to text block array', () => {
  assert.deepEqual(promoteSystemToBlocks('sys'), [{ type: 'text', text: 'sys' }])
  assert.equal(promoteSystemToBlocks(null), null)
  assert.equal(promoteSystemToBlocks(''), '')
  assert.deepEqual(promoteSystemToBlocks(['str', { type: 'text', text: 'b' }]), [
    { type: 'text', text: 'str' },
    { type: 'text', text: 'b' },
  ])
})

test('canonicalizeClaudeMessagesShape promotes strings to blocks', () => {
  const body = {
    model: 'x',
    system: 'You are a bot',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ],
  }
  const result = canonicalizeClaudeMessagesShape(body)
  assert.deepEqual(result.system, [{ type: 'text', text: 'You are a bot' }])
  assert.deepEqual(result.messages[0].content, [{ type: 'text', text: 'hello' }])
  assert.deepEqual(result.messages[1].content, [{ type: 'text', text: 'hi' }])
})

test('canonicalizeClaudeMessagesShape handles null/undefined body', () => {
  assert.equal(canonicalizeClaudeMessagesShape(null), null)
  assert.equal(canonicalizeClaudeMessagesShape(undefined), undefined)
})

test('applyStructuredOutput promotes response_format before drop', () => {
  const out = { model: 'x' }
  const source = { response_format: { type: 'json_object' } }
  const result = applyStructuredOutput({ ...out }, source)
  assert.ok(result.output_config)
  assert.equal(result.output_config.format.type, 'json_schema')
})
