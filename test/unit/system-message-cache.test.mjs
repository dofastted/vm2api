import assert from 'node:assert/strict'
import test from 'node:test'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import { listCacheMarkers, validateCacheBreakpoints } from '../../src/lib/protocol/cache-ttl.mjs'
import { liftMidConversationSystemMessages, normalizeAnthropicMessages } from '../../src/lib/protocol/sanitize.mjs'

const model = 'claude-opus-5-5'
const control = (ttl) => ({ type: 'ephemeral', ...(ttl ? { ttl } : {}) })
function text(value, ttl) {
  return {
    type: 'text',
    text: value,
    ...(arguments.length < 2 || ttl === null ? {} : { cache_control: control(ttl) }),
  }
}
const controls = (body) =>
  [
    ...(body.tools || []),
    ...(body.system || []),
    ...(body.messages || []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])),
  ].flatMap((block) => (block.cache_control ? [block.cache_control] : []))

function convert(protocol, messages, extra = {}) {
  const source = { model, max_tokens: 128, ...extra }
  source[protocol === 'openai.responses' ? 'input' : 'messages'] = messages
  const before = structuredClone(source)
  const { claude } = toClaudeMessages(protocol, source)
  assert.deepEqual(source, before)
  validateCacheBreakpoints(claude)
  return claude
}

for (const protocol of ['anthropic.messages', 'openai.chat', 'openai.responses']) {
  for (const role of ['system', 'developer']) {
    for (const ttl of [undefined, '5m', '1h']) {
      test(`${protocol} preserves leading ${role} blocks and ${ttl ?? 'implicit 5m'} cache`, () => {
        const blocks = [text('  first rule\n'), text('  cached rule\n', ttl), text('last rule  ')]
        blocks[1].cache_control.scope = 'global'
        const incoming = structuredClone(blocks)
        incoming[1].annotations = []
        if (protocol === 'openai.responses') incoming[1].type = 'input_text'
        const out = convert(protocol, [
          { role, content: incoming },
          { role: 'user', content: 'Hello' },
        ])
        assert.deepEqual(out.system, blocks)
        assert.deepEqual(controls(out), [blocks[1].cache_control])
      })
    }
  }

  test(`${protocol} retains separate leading system and developer cache boundaries`, () => {
    const blocks = [text('system rule', '1h'), text('developer rule', undefined)]
    const out = convert(protocol, [
      { role: 'system', content: [blocks[0]] },
      { role: 'developer', content: [blocks[1]] },
      { role: 'user', content: 'Hello' },
    ])
    assert.deepEqual(out.system, blocks)
    assert.deepEqual(
      controls(out),
      blocks.map((block) => block.cache_control),
    )
  })
}

test('leading system blocks append after existing top-level system without changing whitespace', () => {
  const system = [text('top-level rule', '1h')]
  const leading = ['  string rule\n', text('block rule', '5m')]
  const out = convert(
    'anthropic.messages',
    [
      { role: 'system', content: leading },
      { role: 'user', content: 'Hello' },
    ],
    { system },
  )
  assert.deepEqual(out.system, [...system, text(leading[0]), leading[1]])
})

test('Responses instructions precede lifted system/developer blocks', () => {
  const out = convert(
    'openai.responses',
    [
      { role: 'developer', content: [{ type: 'output_text', text: 'caller rule', cache_control: control('1h') }] },
      { role: 'user', content: 'Hello' },
    ],
    { instructions: '  top-level instructions\n' },
  )
  assert.deepEqual(out.system, [text('  top-level instructions\n'), text('caller rule', '1h')])
})

test('supported mid-conversation system retains its original blocks and controls', () => {
  const messages = [
    { role: 'user', content: [text('Hello', '1h')] },
    { role: 'system', content: [text('  mid-system rule\n', '5m')] },
    { role: 'user', content: 'Continue' },
  ]
  const out = convert('anthropic.messages', messages)
  assert.equal(out.system, undefined)
  assert.deepEqual(out.messages[1], messages[1])
})

test('lifting mid-system keeps system priority, four markers and the original TTL order', () => {
  const source = {
    model: 'claude-sonnet-5',
    tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: control('1h') }],
    system: [text('initial rule', '1h')],
    messages: [
      { role: 'user', content: [text('Hello', '1h')] },
      { role: 'system', content: [text('  mid-system rule\n', '5m')] },
      { role: 'user', content: [text('Continue')] },
    ],
  }
  const before = structuredClone(source)
  const out = liftMidConversationSystemMessages(source)
  assert.deepEqual(source, before)
  assert.deepEqual(out.system, [...source.system, text('  mid-system rule\n')])
  assert.equal(out.messages.length, 1)
  assert.deepEqual(out.messages[0].content[0], source.messages[0].content[0])
  assert.deepEqual(out.messages[0].content[1].cache_control, control('5m'))
  assert.deepEqual(out.messages[0].content.at(-1), text('Continue'))
  assert.equal(JSON.stringify(out.messages).includes('mid-system rule'), false)
  assert.deepEqual(controls(out), controls(source))
  assert.equal(listCacheMarkers(out).length, 4)
  validateCacheBreakpoints(out)
  assert.deepEqual(liftMidConversationSystemMessages(out), out)
})

test('multiple lifted mid-system markers do not overwrite a preceding user marker', () => {
  const out = liftMidConversationSystemMessages({
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: [text('Hello', '1h')] },
      { role: 'developer', content: [text('first rule', '1h'), text('second rule', undefined)] },
      { role: 'system', content: [text('third rule', '5m')] },
      { role: 'user', content: 'Continue' },
    ],
  })
  assert.deepEqual(
    out.system,
    ['first rule', 'second rule', 'third rule'].map((value) => text(value)),
  )
  assert.deepEqual(controls(out), [control('1h'), control('1h'), control(), control('5m')])
  assert.equal(out.messages[0].content.at(-1).text, 'Continue')
  validateCacheBreakpoints(out)
})

test('lifting at a tool boundary leaves tool results first and thinking blocks untouched', () => {
  const thinking = { type: 'thinking', thinking: 'reasoning', signature: 'fixture' }
  const toolUse = { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} }
  const toolResult = { type: 'tool_result', tool_use_id: 'tool_1', content: 'done' }
  const source = {
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [thinking, toolUse] },
      { role: 'system', content: [text('tool boundary rule', '5m')] },
      { role: 'user', content: [toolResult] },
    ],
  }
  const before = structuredClone(source)
  const out = liftMidConversationSystemMessages(source)
  assert.deepEqual(out.system, [text('tool boundary rule')])
  assert.deepEqual(out.messages[1].content.slice(0, 2), [thinking, toolUse])
  assert.deepEqual(out.messages[1].content.at(-1).cache_control, control('5m'))
  assert.deepEqual(out.messages[2].content, [toolResult])
  assert.deepEqual(source, before)
})

test('projected cache anchors do not turn an empty effort control into instruction content', () => {
  const effort = { role: 'system', content: [], output_config: { effort: 'low' } }
  const out = liftMidConversationSystemMessages({
    model,
    messages: [
      { role: 'user', content: 'Hello' },
      effort,
      { role: 'system', content: [text('mid rule', '5m')] },
      { role: 'user', content: 'Continue' },
    ],
  })
  assert.deepEqual(out.messages[1], effort)
  assert.deepEqual(out.messages[0].content.at(-1).cache_control, control('5m'))
  assert.deepEqual(normalizeAnthropicMessages(structuredClone(out)), out)
})

test('a leading effort control stays empty when a later leading system block is lifted', () => {
  const effort = { role: 'system', content: [], output_config: { effort: 'low' } }
  const block = text('leading rule', '1h')
  const out = convert('anthropic.messages', [
    effort,
    { role: 'system', content: [block] },
    { role: 'user', content: 'Hi' },
  ])
  assert.deepEqual(out.system, [block])
  assert.deepEqual(out.messages[0], effort)
})

test('normalizing an assistant-first history does not move a later 5m cache before its 1h cache', () => {
  const out = convert('anthropic.messages', [
    { role: 'assistant', content: [text('previous answer', '1h')] },
    { role: 'system', content: [text('subsequent rule', '5m')] },
    { role: 'user', content: 'Continue' },
  ])
  assert.equal(out.messages[0].role, 'user')
  assert.deepEqual(out.system, [text('subsequent rule')])
  assert.deepEqual(controls(out), [control('1h'), control('5m')])
})

for (const protocol of ['openai.chat', 'openai.responses']) {
  test(`${protocol} projects a mid-system cache after the preceding user cache`, () => {
    const user =
      protocol === 'openai.responses'
        ? { role: 'user', content: 'Hello', cache_control: control('1h') }
        : { role: 'user', content: [text('Hello', '1h')] }
    const out = convert(protocol, [
      user,
      { role: 'developer', content: [text('  mid rule\n', undefined)] },
      { role: 'user', content: 'Continue' },
    ])
    assert.deepEqual(out.system, [text('  mid rule\n')])
    assert.deepEqual(controls(out), [control('1h'), control()])
    assert.deepEqual(out.messages[0].content[1].cache_control, control())
    assert.equal(out.messages[0].content.at(-1).text, 'Continue')
  })
}

test('OpenAI Responses keeps a lifted developer cache behind a block-level 1h user cache', () => {
  const out = convert('openai.responses', [
    { role: 'user', content: [{ type: 'input_text', text: 'Hello', cache_control: control('1h') }] },
    { role: 'developer', content: [{ type: 'input_text', text: 'mid rule', cache_control: control() }] },
    { role: 'user', content: 'Continue' },
  ])
  assert.deepEqual(out.system, [text('mid rule')])
  assert.deepEqual(controls(out), [control('1h'), control()])
})

test('OpenAI Chat tool results remain adjacent after a cached system message is lifted', () => {
  const out = convert('openai.chat', [
    { role: 'user', content: 'Hello' },
    {
      role: 'assistant',
      tool_calls: [{ id: 'tool_1', type: 'function', function: { name: 'Read', arguments: '{}' } }],
    },
    { role: 'system', content: [text('tool boundary rule', '5m')] },
    { role: 'tool', tool_call_id: 'tool_1', content: 'done' },
  ])
  assert.equal(out.messages[1].content[0].type, 'tool_use')
  assert.deepEqual(out.messages[1].content.at(-1).cache_control, control('5m'))
  assert.equal(out.messages[2].content[0].type, 'tool_result')
  assert.deepEqual(out.system, [text('tool boundary rule')])
})
