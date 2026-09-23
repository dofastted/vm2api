import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import { applyCacheBreakpoints, DEFAULT_CACHE_TTL } from '../../src/lib/protocol/cache-ttl.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'

const MODEL = 'claude-sonnet-5'

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

test('openai.chat / messages / responses convert to the same cacheable block shape', () => {
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

  assert.deepEqual(rewriteStamps(chat), rewriteStamps(messages))
  assert.deepEqual(rewriteStamps(responses), rewriteStamps(messages))
})

test('unofficial cli-hop keeps converted openai.chat and messages shapes marker-free', () => {
  const turns = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
  ]
  const fromChat = prepareCliHopBody(
    toClaudeMessages('openai.chat', { model: MODEL, max_tokens: 256, messages: turns }).claude,
    { unofficial: true },
  )
  const fromMessages = prepareCliHopBody(
    toClaudeMessages('anthropic.messages', { model: MODEL, max_tokens: 256, messages: turns }).claude,
    { unofficial: true },
  )
  assert.deepEqual(stampMap(fromChat), [])
  assert.deepEqual(stampMap(fromMessages), [])
  assert.deepEqual(
    fromChat.messages.map((message) => message.role),
    fromMessages.messages.map((message) => message.role),
  )
})

test('openai.chat multi-turn cli-hop leaves current-tail boundary to native CLI', () => {
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
  const body = prepareCliHopBody(chat, { unofficial: true })
  assert.equal(body.messages[2].content[0].cache_control, undefined)
  assert.equal(body.messages[4].content[0].cache_control, undefined)
})
