import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import { applyCacheBreakpoints, DEFAULT_CACHE_TTL } from '../../src/lib/protocol/cache-ttl.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'

const MODEL = 'claude-sonnet-5'

test('Chat assistant cache boundaries survive alongside tool calls without mutating input', () => {
  const control = { type: 'ephemeral', scope: 'global' }
  const input = {
    model: MODEL,
    messages: [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [
          'prefix ',
          { type: 'output_text', text: '  cached answer\n', annotations: [], cache_control: control },
        ],
        tool_calls: [{ id: 'tool_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } }],
      },
      { role: 'tool', tool_call_id: 'tool_1', content: 'done' },
    ],
  }
  const before = structuredClone(input)
  const out = toClaudeMessages('openai.chat', input).claude
  assert.deepEqual(out.messages[1].content, [
    { type: 'text', text: 'prefix ' },
    { type: 'text', text: '  cached answer\n', cache_control: control },
    { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: 'a' } },
  ])
  assert.equal(out.messages[2].content[0].tool_use_id, 'tool_1')
  assert.deepEqual(input, before)
})

function stampMap(body) {
  const hits = []
  for (const [i, block] of (body.system || []).entries()) {
    if (block?.cache_control) hits.push(`system[${i}]`)
  }
  for (const [i, tool] of (body.tools || []).entries()) {
    if (tool?.cache_control) hits.push(`tools[${i}]`)
  }
  for (const [i, message] of (body.messages || []).entries()) {
    if (!Array.isArray(message?.content)) continue
    for (const [j, block] of message.content.entries()) {
      if (block?.cache_control) hits.push(`messages[${i}].content[${j}]`)
    }
  }
  return hits
}

function rewriteStamps(body) {
  return stampMap(
    applyCacheBreakpoints(structuredClone(body), {
      ttl: DEFAULT_CACHE_TTL,
      config: { enabled: true, preserve_client: true, system_tail: false, tools_tail: false, messages: 'rewrite' },
    }),
  )
}

test('openai.chat / messages / responses convert to blocks and retain caller cache boundaries', () => {
  const chat = toClaudeMessages('openai.chat', {
    model: MODEL,
    max_tokens: 256,
    messages: [
      { role: 'system', content: 'you are a docs bot' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: [{ type: 'text', text: 'u2', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'Read',
          parameters: { type: 'object', properties: {} },
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      },
    ],
  }).claude

  const messages = toClaudeMessages('anthropic.messages', {
    model: MODEL,
    max_tokens: 256,
    system: [{ type: 'text', text: 'you are a docs bot' }],
    messages: [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: [{ type: 'text', text: 'u2', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ],
    tools: [
      {
        name: 'Read',
        input_schema: { type: 'object', properties: {} },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
  }).claude

  const responses = toClaudeMessages('openai.responses', {
    model: MODEL,
    max_output_tokens: 256,
    instructions: 'you are a docs bot',
    input: [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'Read',
          parameters: { type: 'object', properties: {} },
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      },
    ],
  }).claude

  for (const body of [chat, messages, responses]) {
    assert.equal(Array.isArray(body.system), true, 'system must be blocks')
    assert.equal(body.system[0].type, 'text')
    assert.equal(body.system[0].text, 'you are a docs bot')
    for (const message of body.messages) {
      assert.equal(Array.isArray(message.content), true, 'message content must be blocks')
    }
    assert.equal(body.tools[0].name, 'Read')
    assert.deepEqual(body.tools[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  }

  const callerStamps = ['tools[0]', 'messages[2].content[0]']
  assert.deepEqual(rewriteStamps(chat), callerStamps)
  assert.deepEqual(rewriteStamps(messages), callerStamps)
  assert.deepEqual(rewriteStamps(responses), [...callerStamps, 'messages[4].content[0]'])
})

test('unofficial cli-hop converts openai.chat and messages to the same marked shape', () => {
  const turns = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
  ]
  const fromChat = prepareCliHopBody(
    toClaudeMessages('openai.chat', { model: MODEL, max_tokens: 256, messages: turns }).claude,
    { unofficial: true, cacheTtl: '1h' },
  )
  const fromMessages = prepareCliHopBody(
    toClaudeMessages('anthropic.messages', { model: MODEL, max_tokens: 256, messages: turns }).claude,
    { unofficial: true, cacheTtl: '1h' },
  )
  assert.deepEqual(stampMap(fromChat), ['system[0]', 'messages[2].content[0]', 'messages[4].content[0]'])
  assert.deepEqual(stampMap(fromMessages), stampMap(fromChat))
  assert.deepEqual(
    fromChat.messages.map((message) => message.role),
    fromMessages.messages.map((message) => message.role),
  )
})

test('openai.chat multi-turn cli-hop marks last and penultimate user', () => {
  const chat = toClaudeMessages('openai.chat', {
    model: MODEL,
    max_tokens: 256,
    messages: [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ],
  }).claude
  const body = prepareCliHopBody(chat, { unofficial: true, cacheTtl: '1h' })
  assert.deepEqual(body.messages[2].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(body.messages[4].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(body.messages[0].content[0].cache_control, undefined)
})
