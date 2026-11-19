import assert from 'node:assert/strict'
import test from 'node:test'
import { createIssuedToolReplay } from '../../src/lib/protocol/issued-tool-replay.mjs'
import { createIssuedToolStream } from '../../src/lib/protocol/issued-tool-stream.mjs'

const prefix = [{ role: 'user', content: 'hello' }]
const call = (id, input = { a: 1, b: 2 }) => ({ type: 'tool_use', id, name: 'lookup', input })
const answer = (calls) => [
  { role: 'assistant', content: calls },
  {
    role: 'user',
    content: calls.map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: 'ok', is_error: true })),
  },
]

test('renamed calls require one matching issued batch and unambiguous result links', () => {
  const book = createIssuedToolReplay()
  book.remember('scope', prefix, [call('a')])
  const messages = [...prefix, ...answer([call('client', { b: 2, a: 1 })])]
  const restored = book.restore('scope', { messages })
  assert.deepEqual(restored.messages, [...prefix, ...answer([call('a')])])
  assert.equal(messages[1].content[0].id, 'client')
  for (const history of [
    messages.slice(0, -1),
    [{ role: 'user', content: 'different' }, ...messages.slice(1)],
    [...prefix, ...answer([call('client', { a: 0 })])],
    [...messages, ...answer([call('a')])],
    [...prefix, ...answer([call('client'), call('client')])],
  ]) {
    const body = { messages: history }
    assert.equal(book.restore('scope', body), body)
  }
  book.remember('scope', prefix, [call('b')])
  const ambiguous = { messages }
  assert.equal(book.restore('scope', ambiguous), ambiguous)
})

test('exact IDs restore only when the next user turn answers the entire batch once', () => {
  const book = createIssuedToolReplay()
  const issued = [call('a'), call('b')]
  book.remember('scope', prefix, issued)
  const [assistant, user] = answer(issued.map((b) => ({ ...b, input: { changed: true } })))
  const [a, b] = user.content
  for (const tail of [
    [],
    [{ ...user, content: [a] }],
    [{ ...user, content: [a, a] }],
    [{ ...user, content: [a, { ...b, tool_use_id: 'other' }] }],
    [{ role: 'user', content: 'not results' }, user],
    [user, { ...user, content: [b] }],
  ]) {
    const body = { messages: [...prefix, assistant, ...tail] }
    assert.equal(book.restore('scope', body), body)
  }
  // Parallel results may arrive out of order: their references, not their positions, pair them.
  const reversed = { ...user, content: [b, a] }
  const restored = book.restore('scope', { messages: [...prefix, assistant, reversed] })
  assert.deepEqual(restored.messages.at(-2).content, issued)
  assert.equal(restored.messages.at(-1), reversed)
})

test('moving a cache breakpoint between turns preserves replay and the current cache placement', () => {
  const book = createIssuedToolReplay()
  const marker = { type: 'ephemeral', ttl: '1h' }
  const text = { type: 'text', text: 'hello' }
  const prior = answer([call('prior', { cache_control: 'business policy' })])
  const issued = { ...call('issued'), caller: { type: 'direct' } }
  book.remember('scope', [...prior, { role: 'user', content: [{ ...text, cache_control: marker }] }], [issued])
  const body = {
    messages: [...prior, { role: 'user', content: [text] }, ...answer([{ ...call('issued'), cache_control: marker }])],
  }
  const restored = book.restore('scope', body)
  assert.deepEqual(restored.messages.at(-2).content, [{ ...issued, cache_control: marker }])
  assert.deepEqual(restored.messages.at(-3).content, [text])
  const different = structuredClone(body)
  different.messages[0].content[0].input.cache_control = 'different business policy'
  assert.equal(book.restore('scope', different), different)
})

test('later tool turns match the actual public prefix, even if earlier IDs were aliases', () => {
  const book = createIssuedToolReplay()
  book.remember('scope', prefix, [call('first')])
  const publicTurn = [...prefix, ...answer([call('x')])]
  const second = { ...call('second'), extension: { kept: true } }
  book.remember('scope', publicTurn, [second])
  const body = {
    messages: [...publicTurn, ...answer([{ ...call('second'), name: 'typo', input: {}, extension: null }])],
  }
  assert.deepEqual(book.restore('scope', body).messages, [...prefix, ...answer([call('first')]), ...answer([second])])
  assert.equal(book.restore('other', body), body)
})

test('interleaved SSE calls are exposed in index order, not stop order', () => {
  const stream = createIssuedToolStream()
  const emit = (e) => stream.observe(`data: ${JSON.stringify(e)}`)
  emit({ type: 'message_start', message: { content: [] } })
  for (const index of [1, 0]) emit({ type: 'content_block_start', index, content_block: call(String(index), {}) })
  for (const index of [1, 0]) {
    emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: `{"n":${index}}` } })
    emit({ type: 'content_block_stop', index })
  }
  assert.equal(stream.completedContent(), null)
  emit({ type: 'message_stop' })
  assert.deepEqual(stream.completedContent(), [call('0', { n: 0 }), call('1', { n: 1 })])
})

test('incomplete, errored or unparseable streams cannot supply replay evidence', () => {
  const start = { type: 'message_start', message: { content: [] } }
  const open = { type: 'content_block_start', index: 0, content_block: call('t', {}) }
  const stop = { type: 'content_block_stop', index: 0 },
    end = { type: 'message_stop' }
  for (const events of [
    [start, open, stop],
    [start, open, end],
    [start, open, { type: 'error' }, stop, end],
    [start, open, open, stop, end],
    [
      start,
      open,
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } },
      stop,
      end,
    ],
  ]) {
    const stream = createIssuedToolStream()
    for (const event of events) stream.observe(`data: ${JSON.stringify(event)}`)
    assert.equal(stream.completedContent(), null)
  }
})
