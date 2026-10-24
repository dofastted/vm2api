import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearCachePrefixSessions,
  describeCacheContinuity,
  DROPPED_IMAGE_TEXT,
  messageImageCount,
  firstHistoryDiff,
  peekCachePrefix,
  prepareCachePrefix,
} from '../../src/lib/protocol/cache-prefix.mjs'

function track(key, value, now) {
  const { body: _sent, ...prefix } = prepareCachePrefix(key, value, now)
  return prefix
}

const body = (system, ...texts) => ({
  tools: [{ name: 'Read' }],
  system: [{ type: 'text', text: system }],
  messages: texts.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', content: text })),
})

test('a growing conversation keeps its prefix', () => {
  clearCachePrefixSessions()
  assert.deepEqual(track('s', body('p', 'u1'), 0), { turn: 1, break: null })
  assert.deepEqual(track('s', body('p', 'u1', 'a1', 'u2'), 1), { turn: 2, break: null })
})

test('moving cache markers is not a history break', () => {
  clearCachePrefixSessions()
  const first = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ],
  }
  const second = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'u2', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ],
  }
  track('s', first, 0)
  assert.equal(track('s', second, 1).break, null)
})

test('the first changed section is reported', () => {
  clearCachePrefixSessions()
  track('s', body('p', 'u1', 'a1', 'u2'), 0)
  const system = track('s', body('p2', 'u1', 'a1', 'u2', 'a2', 'u3'), 1).break
  assert.equal(system.section, 'system')
  assert.equal(system.kind, 'text')
  const edited = track('s', body('p2', 'u1', 'edited', 'u2', 'a2', 'u3'), 2).break
  assert.equal(edited.section, 'messages')
  assert.equal(edited.index, 1)
  assert.equal(edited.kind, 'text')
  assert.equal(edited.diff.reason, 'part')
  assert.equal(edited.diff.fields.change, 'length')
  const shorter = track('s', body('p2', 'u1'), 3).break
  assert.equal(shorter.section, 'messages')
  assert.equal(shorter.index, 1)
  assert.equal(shorter.kind, 'structure')
  assert.equal(shorter.diff.reason, 'missing')
})

test('an idle session past the longest TTL starts over', () => {
  clearCachePrefixSessions()
  track('s', body('p', 'u1'), 0)
  assert.deepEqual(track('s', body('other', 'u1'), 60 * 60_000), { turn: 1, break: null })
})

test('inbound to outbound image edits are classified without storing bytes', () => {
  const inbound = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaa'.repeat(40) } }],
      },
    ],
  }
  const outbound = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'bbb'.repeat(40) } }],
      },
    ],
  }
  const imageDiff = firstHistoryDiff(inbound, outbound)
  assert.equal(imageDiff.section, 'messages')
  assert.equal(imageDiff.index, 0)
  assert.equal(imageDiff.kind, 'image')
  assert.equal(JSON.stringify(imageDiff).includes('aaa'), false)
  assert.equal(JSON.stringify(imageDiff).includes('bbb'), false)
  const summary = JSON.stringify(
    describeCacheContinuity({
      inbound,
      outbound,
      layer: 'node_object',
      ttl: '1h',
      sessionId: 'sess',
      vmId: 'vm-01',
      accountId: 'acc',
      requestId: 'req',
    }),
  )
  assert.equal(summary.includes('aaa'), false)
  assert.equal(summary.includes('bbb'), false)
  const described = describeCacheContinuity({
    inbound,
    outbound,
    layer: 'node_object',
    ttl: '1h',
    sessionId: 'sess',
    vmId: 'vm-01',
    accountId: 'acc',
    requestId: 'req',
  })
  assert.equal(described.layer, 'node_object')
  assert.equal(described.wire_observed, false)
  assert.equal(described.ttl, '1h')
  assert.equal(described.session_id, 'sess')
  assert.equal(described.vm_id, 'vm-01')
  assert.equal(described.account_id, 'acc')
})

test('structure names the changed tool_result field and does not keep its text', () => {
  clearCachePrefixSessions()
  const tool = (content) => ({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] }],
  })
  track('s', tool('file contents alpha'), 0)
  const broke = track('s', tool('file contents beta and more'), 1).break
  assert.equal(broke.kind, 'structure')
  assert.equal(broke.diff.reason, 'part')
  assert.equal(broke.diff.type, 'tool_result')
  assert.equal(broke.diff.fields.changed[0].key, 'content')
  assert.equal(broke.diff.fields.changed[0].change, 'length')
  const encoded = JSON.stringify(broke)
  assert.equal(encoded.includes('alpha'), false)
  assert.equal(encoded.includes('beta'), false)
})

test('an official token counter inside a tool result is labeled without rewriting it', () => {
  clearCachePrefixSessions()
  const tool = (n) => ({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: `note <total_tokens>${n} tokens left</total_tokens>` },
        ],
      },
    ],
  })
  track('s', tool(100), 0)
  const broke = track('s', tool(90), 1).break
  assert.equal(broke.diff.fields.change, 'counter_only')
  assert.equal(JSON.stringify(broke).includes('tokens left'), false)
})

test('extra message fields and key order are not called a block-shape change', () => {
  clearCachePrefixSessions()
  track('s', { messages: [{ role: 'user', content: 'u1' }] }, 0)
  const extra = track('s', { messages: [{ role: 'user', content: 'u1', extra: 1 }] }, 1).break
  assert.equal(extra.kind, 'structure')
  assert.equal(extra.diff.reason, 'message_fields')
  assert.deepEqual(extra.diff.added, ['extra'])
  const ordered = {
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'same' }] }],
  }
  const reordered = {
    messages: [{ role: 'user', content: [{ content: 'same', tool_use_id: 't1', type: 'tool_result' }] }],
  }
  clearCachePrefixSessions()
  track('s', ordered, 0)
  const order = track('s', reordered, 1).break
  assert.equal(order.diff.fields.key_order, true)
})

test('a counter nested in tool_result.content[] is counter_only', () => {
  clearCachePrefixSessions()
  const tool = (n) => ({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: `<total_tokens>${n} tokens left</total_tokens>` }],
          },
        ],
      },
    ],
  })
  track('s', tool(100), 0)
  const broke = track('s', tool(90), 1).break
  assert.equal(broke.diff.fields.change, 'counter_only')
  assert.equal(broke.diff.fields.changed, undefined)
  assert.equal(JSON.stringify(broke).includes('tokens left'), false)
})

test('a tools difference does not hide a message difference', () => {
  const inbound = {
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'u1' }],
  }
  const outbound = {
    tools: [{ name: 'Read', input_schema: { type: 'object', required: ['path'] } }],
    messages: [{ role: 'user', content: 'u1 changed' }],
  }
  const diff = firstHistoryDiff(inbound, outbound)
  assert.equal(diff.section, 'tools')
  assert.deepEqual(
    diff.sections.map((item) => item.section),
    ['tools', 'messages'],
  )
  assert.equal(diff.sections[1].index, 0)
  assert.equal(diff.sections[1].diff.reason, 'part')
  assert.equal(JSON.stringify(diff).includes('u1 changed'), false)
})

test('a sampled counter plus an unsampled tool body change is not counter_only', () => {
  clearCachePrefixSessions()
  const tool = (n, tail) => ({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: `<total_tokens>${n} tokens left</total_tokens>` },
              { type: 'text', text: 'b' },
              { type: 'text', text: 'c' },
              { type: 'text', text: 'd' },
              { type: 'text', text: 'e' },
              { type: 'text', text: 'f' },
              { type: 'text', text: tail },
            ],
          },
        ],
      },
    ],
  })
  track('s', tool(100, 'alpha'), 0)
  const broke = track('s', tool(90, 'beta changed'), 1).break
  const encoded = JSON.stringify(broke)
  assert.notEqual(broke.diff.fields.change, 'counter_only')
  assert.equal(encoded.includes('"change":"unknown"'), true)
  assert.equal(encoded.includes('"capped":true'), true)
  assert.equal(JSON.stringify(broke).includes('beta'), false)
})

test('a depth-capped object difference stays unknown instead of disappearing', () => {
  clearCachePrefixSessions()
  const tool = (note) => ({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: 'same', source: { meta: { note } } }],
          },
        ],
      },
    ],
  })
  track('s', tool('alpha'), 0)
  const broke = track('s', tool('beta'), 1).break
  assert.notEqual(broke.diff.fields.change, 'counter_only')
  assert.equal(JSON.stringify(broke).includes('"change":"unknown"'), true)
  assert.equal(JSON.stringify(broke).includes('"capped":true'), true)
  assert.equal(JSON.stringify(broke).includes('alpha'), false)
  assert.equal(JSON.stringify(broke).includes('beta'), false)
})

const MARK = { type: 'ephemeral', ttl: '1h' }

function markTail(message) {
  const content = message.content.slice()
  content[content.length - 1] = { ...content[content.length - 1], cache_control: { ...MARK } }
  return { ...message, content }
}

// Node's cli-hop layout: two system markers plus the last two user turns.
function marked(messages) {
  const users = messages.flatMap((message, i) => (message.role === 'user' ? [i] : [])).slice(-2)
  return {
    system: [
      { type: 'text', text: 'identity', cache_control: { ...MARK } },
      { type: 'text', text: 'prompt', cache_control: { ...MARK } },
    ],
    tools: [{ name: 'shot' }],
    messages: messages.map((message, i) => (users.includes(i) ? markTail(message) : message)),
  }
}

const png = (n) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `png-${n}` } })

// oh-my-pi's Anthropic wire: an image-only result is labeled while the image is
// there and becomes DROPPED_IMAGE_TEXT once its image budget drops it.
function ompResult(n, kept, tag = 't') {
  const imageOnly = n % 3 === 0
  let content
  if (imageOnly)
    content = kept
      ? [{ type: 'text', text: '(see attached image)' }, png(n)]
      : [{ type: 'text', text: DROPPED_IMAGE_TEXT }]
  else content = kept ? [{ type: 'text', text: `shot ${n}` }, png(n)] : [{ type: 'text', text: `shot ${n}` }]
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${tag}${n}`, content }] }
}

function ompBody(shots, budget, tag = 't') {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'take screenshots' }] }]
  for (let n = 1; n <= shots; n++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `${tag}${n}`, name: 'shot', input: {} }] })
    messages.push(ompResult(n, n > shots - budget, tag))
  }
  return marked(messages)
}

const sentImages = (body) => body.messages.reduce((sum, message) => sum + messageImageCount(message), 0)

test('oh-my-pi dropping its oldest image breaks the prefix once per half budget, not every turn', () => {
  clearCachePrefixSessions()
  const budget = 4
  const breaks = []
  for (let shots = 1; shots <= 24; shots++) {
    const inbound = ompBody(shots, budget)
    const peeked = peekCachePrefix('omp', inbound, shots)
    const { body: sent, ...prefix } = prepareCachePrefix('omp', inbound, shots)
    assert.equal(peeked.break === null, prefix.break === null, `peek and send disagree at ${shots}`)
    assert.equal(messageImageCount(sent.messages.at(-1)), 1, 'the newest screenshot is always sent')
    assert.ok(sentImages(sent) <= budget)
    if (shots >= budget) assert.ok(sentImages(sent) >= budget / 2)
    if (!prefix.break) continue
    breaks.push(shots)
    assert.ok(prefix.anchor < prefix.break.index, 'a marker is moved in front of the break')
    const markers = describeCacheContinuity({ outbound: sent }).markers
    assert.equal(markers.length, 4)
    assert.ok(markers.every((marker) => marker.ttl === '1h'))
    assert.deepEqual(
      markers.filter((marker) => marker.section === 'messages').map((marker) => marker.index),
      [prefix.anchor, sent.messages.length - 1],
    )
  }
  // Without the floor every turn from the fifth would break: 20 rewrites.
  assert.deepEqual(breaks, [5, 8, 11, 14, 17, 20, 23])
})

test('a client that never drops an image is sent unchanged', () => {
  clearCachePrefixSessions()
  for (let shots = 1; shots <= 6; shots++) {
    const inbound = ompBody(shots, Number.POSITIVE_INFINITY)
    const { body: sent, ...prefix } = prepareCachePrefix('keep', inbound, shots)
    assert.equal(sent, inbound)
    assert.equal(prefix.break, null)
    assert.equal(prefix.image_floor, undefined)
  }
})

test('a rewind to a same-length history drops the image floor and keeps every new image', () => {
  clearCachePrefixSessions()
  for (let shots = 1; shots <= 8; shots++) prepareCachePrefix('rewind', ompBody(shots, 4), shots)
  assert.ok(prepareCachePrefix('rewind', ompBody(8, 4), 9).image_floor > 0, 'the floor is active before the rewind')
  // Same first prompt, then different turns: same length, every image present.
  const replaced = ompBody(8, Number.POSITIVE_INFINITY, 'r')
  const { body: sent, ...prefix } = prepareCachePrefix('rewind', replaced, 10)
  assert.equal(prefix.image_floor, undefined)
  assert.equal(sentImages(sent), 8)
  assert.equal(sentImages(prepareCachePrefix('rewind', ompBody(9, Number.POSITIVE_INFINITY, 'r'), 11).body), 9)
})

test('a history edit behind both message markers anchors the last user turn before it', () => {
  clearCachePrefixSessions()
  const texts = (edited) =>
    Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: [{ type: 'text', text: i === 3 && edited ? 'edited' : `m${i}` }],
    }))
  prepareCachePrefix('edit', marked(texts(false)), 0)
  const { body: sent, ...prefix } = prepareCachePrefix('edit', marked(texts(true)), 1)
  assert.equal(prefix.break.index, 3)
  assert.equal(prefix.anchor, 2)
  const markers = describeCacheContinuity({ outbound: sent }).markers.filter((marker) => marker.section === 'messages')
  assert.deepEqual(
    markers.map((marker) => [marker.index, marker.ttl]),
    [
      [2, '1h'],
      [8, '1h'],
    ],
  )
})
