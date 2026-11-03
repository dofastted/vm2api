import test from 'node:test'
import assert from 'node:assert/strict'
import { dshPruneScope, ToolResultPruneCache } from '../../src/lib/protocol/tool-result-prune-cache.mjs'

const MARKER = '\n\n[... tool result middle pruned ...]\n\n'
const SESSION_A = 'session-b13948f6-62b2-4c14-8370-a4f98001ccc7'
const SESSION_B = 'session-d9530f31-f464-4b42-83ee-93ae3baf715a'
const KEY_A = 'unit-test-key-alpha-do-not-log'
const KEY_B = 'unit-test-key-bravo-do-not-log'
const WINDOW = 1_000_000
const VERIFIED = { verified: true, inputTokens: 1000, outputTokens: 100, attemptCount: 1 }
const clone = structuredClone

function scope(apiKey = KEY_A, session = SESSION_A) {
  return dshPruneScope({
    headers: {
      'user-agent': 'deepseek-harness/0.2.1-rc.5 (+https://github.com/deepseek-ai/deepseek-harness)',
      'x-client-request-id': session,
    },
    apiKey,
  })
}
function createCache(options = {}) {
  return new ToolResultPruneCache({ headroomTokens: 0, ...options })
}
function text(label = 'a', count = 9500) {
  const prefix = `payload:${label}:`,
    suffix = `:end:${label}`
  return prefix + 'x'.repeat(count - prefix.length - suffix.length) + suffix
}
function body(contents = [text()]) {
  return {
    model: 'claude-opus-4-6',
    max_tokens: 64,
    system: [{ type: 'text', text: 'Read the requested files.' }],
    tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    thinking: { type: 'disabled' },
    output_config: { effort: 'medium' },
    tool_choice: { type: 'auto' },
    messages: [
      { role: 'user', content: 'Inspect this repository.' },
      {
        role: 'assistant',
        content: contents.map((_, i) => ({
          type: 'tool_use',
          id: `call-${i}`,
          name: 'read',
          input: { path: `file-${i}.txt` },
        })),
      },
      {
        role: 'user',
        content: contents.map((content, i) => ({ type: 'tool_result', tool_use_id: `call-${i}`, content })),
      },
    ],
  }
}
function clip(value) {
  const chars = Array.from(value)
  return chars.length > 8192 ? chars.slice(0, 4096).join('') + MARKER + chars.slice(-1024).join('') : value
}
// Array fixtures below specify independently calculated, cross-block DSH output.
function pruned(original) {
  const next = clone(original)
  for (const message of next.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content)
      if (block.type === 'tool_result' && typeof block.content === 'string') block.content = clip(block.content)
  }
  return next
}
function prepare(cache, request, options = {}) {
  return cache.prepare({ scope: scope(), body: request, contextWindow: WINDOW, ...options })
}
function seed(cache, request, options = {}, outcome = VERIFIED) {
  const tx = prepare(cache, request, options)
  assert.equal(tx.restored, 0)
  tx.commit({ ...outcome })
  return tx
}
function assertUnrestored(cache, request, options = {}) {
  const original = clone(request),
    tx = prepare(cache, request, options)
  assert.equal(tx.restored, 0)
  assert.equal(typeof tx.reason, 'string')
  assert.deepEqual(tx.body, original)
  assert.deepEqual(request, original)
  tx.rollback()
}
function assertRestored(cache, original, options = {}) {
  const request = pruned(original),
    snapshot = clone(request),
    tx = prepare(cache, request, options)
  assert.ok(tx.restored > 0)
  assert.deepEqual(tx.body, original)
  assert.deepEqual(request, snapshot, 'restoration must not mutate the incoming request')
  tx.rollback()
}

test('DSH scope is stable, isolated by authenticated key and session, and opaque', () => {
  const first = scope()
  assert.ok(first)
  assert.equal(first, scope())
  assert.notEqual(first, scope(KEY_B))
  assert.notEqual(first, scope(KEY_A, SESSION_B))
  for (const secret of [KEY_A, SESSION_A]) assert.ok(!JSON.stringify(first).includes(secret))
})

test('DSH scope rejects absent identity, unrelated clients, and non-session request IDs', () => {
  const headers = { 'user-agent': 'deepseek-harness/0.2.1', 'x-client-request-id': SESSION_A }
  const invalid = [
    {},
    { headers },
    { headers, apiKey: '' },
    { headers: { ...headers, 'user-agent': 'other-client' }, apiKey: KEY_A },
    { headers: { 'x-client-request-id': SESSION_A }, apiKey: KEY_A },
    { headers: { 'user-agent': 'deepseek-harness/0.2.1' }, apiKey: KEY_A },
    ...[
      'request-1234',
      SESSION_A.slice(8),
      'session-not-a-uuid',
      `${SESSION_A}, ${SESSION_B}`,
      [SESSION_A, SESSION_B],
    ].map((id) => ({ headers: { ...headers, 'x-client-request-id': id }, apiKey: KEY_A })),
  ]
  for (const args of invalid) assert.ok(!dshPruneScope(args))
})

test('prepare safely bypasses missing scope, model, or messages', () => {
  const cache = createCache(),
    request = body()
  for (const args of [
    { scope: null, body: request },
    { scope: scope(), body: { ...request, model: '' } },
    { scope: scope(), body: { ...request, messages: null } },
    { scope: scope(), body: null },
  ]) {
    const tx = cache.prepare({ contextWindow: WINDOW, ...args })
    assert.equal(tx.restored, 0)
    assert.deepEqual(tx.body, args.body)
    tx.commit({ ...VERIFIED })
    tx.rollback()
  }
  assert.equal(cache.stats().entries, 0)
  assert.equal(cache.stats().pending, 0)
})

test('only a successfully committed full request can seed later restoration', () => {
  const cache = createCache(),
    original = body()
  assertUnrestored(cache, pruned(original))
  const tx = prepare(cache, original)
  assert.equal(tx.restored, 0)
  assert.equal(cache.stats().entries, 0)
  tx.commit({ ...VERIFIED })
  assert.equal(cache.stats().entries, 1)
  assertRestored(cache, original)
})

test('restores five older tool results together while preserving appended messages and caller input', () => {
  const cache = createCache(),
    original = body(Array.from({ length: 5 }, (_, i) => text(String(i))))
  seed(cache, original)
  const request = pruned(original)
  const tail = [
    { role: 'assistant', content: 'Files inspected.' },
    { role: 'user', content: 'Continue.' },
  ]
  request.messages.push(...tail)
  const snapshot = clone(request),
    tx = prepare(cache, request)
  assert.equal(tx.restored, 5)
  assert.deepEqual(tx.body, { ...original, messages: [...original.messages, ...tail] })
  assert.deepEqual(request, snapshot)
  tx.rollback()
})

test('array pruning uses one global head/tail budget, removes middle blocks, and preserves order', () => {
  const cache = createCache()
  const original = body([
    ['H'.repeat(3000), 'B'.repeat(3000), 'C'.repeat(3000), 'T'.repeat(2000)].map((value) => ({
      type: 'text',
      text: value,
    })),
  ])
  seed(cache, original)
  const request = clone(original)
  request.messages[2].content[0].content = [
    { type: 'text', text: 'H'.repeat(3000) },
    { type: 'text', text: 'B'.repeat(1096) + MARKER },
    { type: 'text', text: 'T'.repeat(1024) },
  ]
  const snapshot = clone(request),
    tx = prepare(cache, request)
  assert.ok(tx.restored > 0)
  assert.deepEqual(tx.body, original)
  assert.deepEqual(request, snapshot)
  tx.rollback()
})

test('independent per-block pruning cannot impersonate the DSH global array transform', () => {
  const cache = createCache(),
    original = body([
      [
        { type: 'text', text: text('first') },
        { type: 'text', text: text('second') },
      ],
    ])
  seed(cache, original)
  const request = clone(original)
  request.messages[2].content[0].content = original.messages[2].content[0].content.map((part) => ({
    ...part,
    text: clip(part.text),
  }))
  assertUnrestored(cache, request)
})

test('uses Unicode codepoints for both the head and tail boundaries', () => {
  const cache = createCache(),
    content = '😀'.repeat(4097) + 'm'.repeat(4100) + '🧪'.repeat(1025),
    original = body([content])
  seed(cache, original)
  assertRestored(cache, original)
  const invalid = pruned(original)
  invalid.messages[2].content[0].content = content.slice(0, 4096) + MARKER + content.slice(-1024)
  assertUnrestored(cache, invalid)
})

test('the 8192-codepoint threshold is exclusive', () => {
  for (const length of [8192, 8193]) {
    const cache = createCache(),
      original = body(['a'.repeat(length)])
    seed(cache, original)
    const tx = prepare(cache, pruned(original))
    assert.equal(tx.restored > 0, length === 8193)
    assert.deepEqual(tx.body, original)
    tx.rollback()
  }
})

test('a natural occurrence of the marker in the original is preserved exactly', () => {
  const cache = createCache(),
    original = body([text('natural') + MARKER + text('more')])
  seed(cache, original)
  assertRestored(cache, original)
})

test('marker-like or nearly matching text never qualifies for recovery', () => {
  const original = body(),
    compact = pruned(original).messages[2].content[0].content
  for (const changed of [
    compact + ' ',
    compact.replace('middle pruned', 'middle removed'),
    compact.replace(/^./, 'z'),
    MARKER,
    text('different').slice(0, 4096) + MARKER + text('different').slice(-1024),
  ]) {
    const cache = createCache()
    seed(cache, original)
    const request = pruned(original)
    request.messages[2].content[0].content = changed
    assertUnrestored(cache, request)
  }
})

test('a real edit after multiple pruned results prevents the entire restoration', () => {
  const cache = createCache(),
    original = body([text('one'), text('two')])
  original.messages.push(
    { role: 'assistant', content: 'Previous answer.' },
    { role: 'user', content: 'Previous follow-up.' },
  )
  seed(cache, original)
  const request = pruned(original)
  request.messages.at(-1).content = 'The user edited their previous follow-up.'
  assertUnrestored(cache, request)
})

for (const [name, change] of [
  [
    'first user text',
    (value) => {
      value.messages[0].content = 'Edited user message.'
    },
  ],
  [
    'tool call input',
    (value) => {
      value.messages[1].content[0].input.path = 'other.txt'
    },
  ],
  [
    'tool call name',
    (value) => {
      value.messages[1].content[0].name = 'other-tool'
    },
  ],
  [
    'tool result ID',
    (value) => {
      value.messages[2].content[0].tool_use_id = 'other-call'
    },
  ],
  [
    'tool result error flag',
    (value) => {
      value.messages[2].content[0].is_error = true
    },
  ],
  [
    'tool result position',
    (value) => {
      value.messages[2].content.reverse()
    },
  ],
  [
    'system',
    (value) => {
      value.system[0].text = 'Edited system.'
    },
  ],
  [
    'tools',
    (value) => {
      value.tools[0].input_schema.properties.extra = { type: 'number' }
    },
  ],
  [
    'thinking',
    (value) => {
      value.thinking = { type: 'enabled', budget_tokens: 1024 }
    },
  ],
  [
    'output config',
    (value) => {
      value.output_config.effort = 'high'
    },
  ],
  [
    'tool choice',
    (value) => {
      value.tool_choice = { type: 'any' }
    },
  ],
])
  test(`rejects historical changes to ${name}`, () => {
    const cache = createCache(),
      original = body([text('one'), text('two')])
    seed(cache, original)
    const request = pruned(original)
    change(request)
    assertUnrestored(cache, request)
  })

test('moving cache_control markers preserves current marker placement and historical identity', () => {
  const cache = createCache(),
    original = body()
  original.system[0].cache_control = { type: 'ephemeral', ttl: '1h' }
  seed(cache, original)
  const request = pruned(original)
  delete request.system[0].cache_control
  request.messages[2].content[0].cache_control = { type: 'ephemeral', ttl: '5m' }
  const tx = prepare(cache, request),
    expected = clone(request)
  expected.messages[2].content[0].content = original.messages[2].content[0].content
  assert.ok(tx.restored > 0)
  assert.deepEqual(tx.body, expected)
  tx.rollback()
})

test('does not restore across authentication keys, sessions, or models', () => {
  const cache = createCache(),
    original = body()
  seed(cache, original)
  assertUnrestored(cache, pruned(original), { scope: scope(KEY_B) })
  assertUnrestored(cache, pruned(original), { scope: scope(KEY_A, SESSION_B) })
  assertUnrestored(cache, { ...pruned(original), model: 'claude-sonnet-4-6' })
  assertRestored(cache, original)
})

test('deleted history and successful summaries invalidate older originals', () => {
  const cache = createCache(),
    original = body()
  seed(cache, original)
  const shortened = pruned(original)
  shortened.messages.shift()
  assertUnrestored(cache, shortened)
  const summary = { ...original, messages: [{ role: 'user', content: 'Summary: files inspected.' }] }
  assertUnrestored(cache, summary)
  seed(cache, summary)
  assertUnrestored(cache, pruned(original))
})

test('the same call ID in a different successful branch cannot reuse old text', () => {
  const cache = createCache(),
    original = body()
  seed(cache, original)
  const edited = clone(original)
  edited.messages[0].content = 'A different branch with the same tool call ID.'
  seed(cache, edited)
  assertUnrestored(cache, pruned(original))
  assertRestored(cache, edited)
})

test('requires a preceding tool_use with the matching ID', () => {
  for (const modify of [
    (value) => {
      value.messages[1].content = [{ type: 'text', text: 'No tool was called.' }]
    },
    (value) => {
      value.messages[1].content[0].id = 'different-call'
    },
    (value) => {
      ;[value.messages[1], value.messages[2]] = [value.messages[2], value.messages[1]]
    },
  ]) {
    const cache = createCache(),
      original = body()
    modify(original)
    seed(cache, original)
    assertUnrestored(cache, pruned(original))
  }
})

test('does not rewrite rich content or text blocks with extra metadata', () => {
  for (const content of [
    [
      { type: 'text', text: text() },
      { type: 'image', source: { type: 'base64', data: 'AA==' } },
    ],
    [{ type: 'text', text: text(), citations: [{ title: 'A citation' }] }],
  ]) {
    const cache = createCache(),
      original = body([content])
    seed(cache, original)
    const request = clone(original)
    request.messages[2].content[0].content[0].text = clip(content[0].text)
    assertUnrestored(cache, request)
  }
})

test('failure, retries, and rollback do not replace a successful baseline', () => {
  for (const finish of [
    (tx) => tx.commit({ ...VERIFIED, verified: false }),
    (tx) => tx.commit({ ...VERIFIED, attemptCount: 2 }),
    (tx) => tx.rollback(),
  ]) {
    const cache = createCache(),
      original = body()
    seed(cache, original)
    const edited = clone(original)
    edited.messages[0].content = 'A failed new branch.'
    finish(prepare(cache, edited))
    assert.equal(cache.stats().pending, 0)
    assertRestored(cache, original)
  }
})

test('commit and rollback are mutually exclusive, one-shot, and idempotent', () => {
  const cache = createCache(),
    original = body(),
    tx = prepare(cache, original)
  tx.commit({ ...VERIFIED })
  const committed = cache.stats()
  tx.commit({ ...VERIFIED })
  tx.rollback()
  assert.deepEqual(cache.stats(), committed)
  assertRestored(cache, original)
  for (const finish of [(item) => item.rollback(), (item) => item.commit({ ...VERIFIED, verified: false })]) {
    const other = createCache(),
      item = prepare(other, original)
    finish(item)
    item.rollback()
    item.commit({ ...VERIFIED })
    assert.equal(other.stats().entries, 0)
    assert.equal(other.stats().pending, 0)
    assertUnrestored(other, pruned(original))
  }
})

test('caller mutations after commit cannot change a saved snapshot', () => {
  const cache = createCache(),
    original = body(),
    expected = clone(original)
  seed(cache, original)
  original.messages[0].content = 'Mutated after successful commit.'
  original.messages[2].content[0].content = 'Other result.'
  assertRestored(cache, expected)
})

test('concurrent same-namespace prepare bypasses and cannot commit over the owner', () => {
  const cache = createCache(),
    original = body(),
    owner = prepare(cache, original),
    competing = prepare(cache, original)
  assert.equal(competing.restored, 0)
  assert.equal(cache.stats().pending, 1)
  competing.commit({ ...VERIFIED })
  assert.equal(cache.stats().entries, 0)
  assert.equal(cache.stats().pending, 1)
  owner.commit({ ...VERIFIED })
  competing.rollback()
  assert.equal(cache.stats().pending, 0)
  assertRestored(cache, original)
})

test('different namespaces can settle out of order without interfering', () => {
  const cache = createCache(),
    original = body(),
    first = prepare(cache, original),
    second = prepare(cache, original, { scope: scope(KEY_B) })
  assert.equal(cache.stats().pending, 2)
  second.commit({ ...VERIFIED })
  first.commit({ ...VERIFIED })
  assert.equal(cache.stats().pending, 0)
  assertRestored(cache, original)
  assertRestored(cache, original, { scope: scope(KEY_B) })
})

test('pending transactions count toward byte usage and rollback releases the reservation', () => {
  const cache = createCache(),
    tx = prepare(cache, body()),
    pending = cache.stats()
  assert.equal(pending.entries, 0)
  assert.equal(pending.pending, 1)
  assert.ok(pending.bytes > 0)
  tx.rollback()
  assert.equal(cache.stats().pending, 0)
  assert.equal(cache.stats().bytes, 0)
})

test('global pending limit bypasses extra requests without creating a baseline', () => {
  const cache = createCache({ maxPending: 1 }),
    original = body(),
    first = prepare(cache, original),
    overflow = prepare(cache, original, { scope: scope(KEY_B) })
  assert.equal(cache.stats().pending, 1)
  overflow.commit({ ...VERIFIED })
  first.rollback()
  assert.equal(cache.stats().entries, 0)
  assert.equal(cache.stats().pending, 0)
  assertUnrestored(cache, pruned(original), { scope: scope(KEY_B) })
})

test('prepare and failed attempts do not extend TTL', () => {
  let now = 1000
  const cache = createCache({ ttlMs: 100, clock: () => now }),
    original = body()
  seed(cache, original)
  now = 1090
  const failed = prepare(cache, pruned(original))
  assert.ok(failed.restored > 0)
  failed.commit({ ...VERIFIED, verified: false })
  now = 1100
  assertUnrestored(cache, pruned(original))
})

test('success renews TTL, while expired baselines release stored bytes', () => {
  let now = 1000
  const cache = createCache({ ttlMs: 100, clock: () => now }),
    original = body()
  seed(cache, original)
  now = 1090
  const success = prepare(cache, pruned(original))
  assert.ok(success.restored > 0)
  success.commit({ ...VERIFIED })
  now = 1150
  assertRestored(cache, original)
  now = 1190
  assertUnrestored(cache, pruned(original))
  assert.equal(cache.stats().entries, 0)
  assert.equal(cache.stats().bytes, 0)
})

test('session limits evict old baselines and preserve the latest successful one', () => {
  const cache = createCache({ maxSessions: 2 }),
    original = body()
  for (const key of ['old', 'middle', 'new']) seed(cache, original, { scope: scope(key) })
  assert.ok(cache.stats().entries <= 2)
  assertUnrestored(cache, pruned(original), { scope: scope('old') })
  assertRestored(cache, original, { scope: scope('new') })
})

test('global bytes remain bounded while old raw text is evicted', () => {
  const original = body(),
    probe = createCache()
  seed(probe, original)
  const oneEntry = probe.stats().bytes,
    limit = Math.ceil(oneEntry * 2.6)
  assert.ok(oneEntry > 0)
  const cache = createCache({ maxBytes: limit, maxEntryBytes: oneEntry * 2 })
  for (const key of ['one', 'two', 'three', 'four']) {
    seed(cache, original, { scope: scope(key) })
    assert.ok(cache.stats().bytes <= limit)
  }
  assert.ok(cache.stats().entries < 4)
  assertUnrestored(cache, pruned(original), { scope: scope('one') })
  assertRestored(cache, original, { scope: scope('four') })
  assert.ok(cache.stats().bytes <= limit)
})

test('per-entry byte limits reject oversized baselines', () => {
  const cache = createCache({ maxEntryBytes: 1024 }),
    original = body()
  seed(cache, original)
  assert.equal(cache.stats().entries, 0)
  assert.equal(cache.stats().pending, 0)
  assertUnrestored(cache, pruned(original))
})

test('maxTextBytes counts UTF-8 bytes, including astral characters', () => {
  const cache = createCache({ maxTextBytes: 20_000 }),
    ascii = body(['a'.repeat(9000)]),
    unicode = body(['😀'.repeat(9000)])
  seed(cache, ascii)
  assertRestored(cache, ascii)
  seed(cache, unicode, { scope: scope(KEY_B) })
  assertUnrestored(cache, pruned(unicode), { scope: scope(KEY_B) })
})

test('stats expose counts without raw text, credentials, or session headers', () => {
  const cache = createCache(),
    original = body([text('private-sentinel')])
  seed(cache, original)
  const stats = cache.stats()
  for (const key of ['entries', 'bytes', 'pending']) assert.equal(typeof stats[key], 'number')
  for (const secret of ['private-sentinel', KEY_A, SESSION_A, original.messages[0].content])
    assert.ok(!JSON.stringify(stats).includes(secret))
})

test('unknown successful usage or context window disables restoration', () => {
  const original = body()
  for (const usage of [
    { verified: true, attemptCount: 1 },
    { ...VERIFIED, inputTokens: NaN },
    { ...VERIFIED, inputTokens: -1 },
  ]) {
    const cache = createCache()
    seed(cache, original, {}, usage)
    assertUnrestored(cache, pruned(original))
  }
  const cache = createCache()
  seed(cache, original)
  for (const contextWindow of [null, 0, NaN, undefined]) assertUnrestored(cache, pruned(original), { contextWindow })
})

test('context budgeting includes previous usage and the new output ceiling', () => {
  const cache = createCache(),
    original = body([text('one'), text('two')])
  seed(cache, original)
  assertUnrestored(cache, pruned(original), { contextWindow: 1100 })
  assertRestored(cache, original, { contextWindow: 2000 })
  assertUnrestored(cache, { ...pruned(original), max_tokens: 1500 }, { contextWindow: 2000 })
})

test('configured headroom is reserved before restoration', () => {
  const cache = createCache({ headroomTokens: 1000 }),
    original = body()
  seed(cache, original)
  assertUnrestored(cache, pruned(original), { contextWindow: 2000 })
  assertRestored(cache, original, { contextWindow: 3000 })
})

test('new tail growth uses UTF-8 bytes and an oversized candidate is rejected atomically', () => {
  const cache = createCache(),
    original = body([text('one'), text('two')])
  seed(cache, original)
  for (const [content, fits] of [
    ['a'.repeat(500), true],
    ['中'.repeat(500), false],
  ]) {
    const request = pruned(original)
    request.messages.push({ role: 'assistant', content: 'Done.' }, { role: 'user', content })
    const tx = prepare(cache, request, { contextWindow: 2000 })
    assert.equal(tx.restored > 0, fits)
    assert.deepEqual(
      tx.body,
      fits ? { ...original, messages: [...original.messages, ...request.messages.slice(3)] } : request,
    )
    tx.rollback()
  }
})

test('new image input with unknown vision cost disables restoration', () => {
  const cache = createCache(),
    original = body()
  seed(cache, original)
  const request = pruned(original)
  request.messages.push(
    { role: 'assistant', content: 'Done.' },
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] },
  )
  assertUnrestored(cache, request)
})

test('restored body byte limits are checked before replacing any text', () => {
  const cache = createCache(),
    original = body([text('one'), text('two')])
  seed(cache, original)
  const request = pruned(original),
    shortBytes = Buffer.byteLength(JSON.stringify(request))
  assertUnrestored(cache, request, { maxBodyBytes: shortBytes + 50 })
  assertRestored(cache, original, { maxBodyBytes: Buffer.byteLength(JSON.stringify(original)) + 100 })
})

test('a compact request that succeeds after budget bypass replaces the full baseline', () => {
  const cache = createCache(),
    original = body()
  seed(cache, original)
  const compact = pruned(original),
    tx = prepare(cache, compact, { contextWindow: 1100 })
  assert.equal(tx.restored, 0)
  assert.deepEqual(tx.body, compact)
  tx.commit({ ...VERIFIED, inputTokens: 200, outputTokens: 10 })
  assertUnrestored(cache, compact)
})

test('pending new namespaces reserve the session limit before concurrent commits', () => {
  const cache = createCache({ maxSessions: 1 })
  const a = prepare(cache, body())
  const b = cache.prepare({ scope: scope(KEY_B), body: body(), contextWindow: WINDOW })
  assert.equal(cache.stats().pending, 1)
  b.commit(VERIFIED)
  a.commit(VERIFIED)
  assert.equal(cache.stats().entries, 1)
  assert.equal(cache.stats().pending, 0)
})

test('a context-management policy change cannot reuse the old input-token budget', () => {
  const cache = createCache()
  const original = body()
  original.context_management = { edits: [{ type: 'clear_tool_uses_20250919' }] }
  seed(cache, original)
  const request = pruned(original)
  request.context_management = { edits: [] }
  assertUnrestored(cache, request)
})

test('business cache_control fields in tool input are part of the prefix', () => {
  const cache = createCache()
  const original = body()
  original.messages[1].content[0].input.cache_control = { action: 'original' }
  seed(cache, original)
  const request = pruned(original)
  request.messages[1].content[0].input.cache_control.action = 'edited'
  assertUnrestored(cache, request)
})

test('business cache_control property schemas are part of the tool declarations', () => {
  const cache = createCache()
  const original = body()
  original.tools[0].input_schema.properties.cache_control = { type: 'string' }
  seed(cache, original)
  const request = pruned(original)
  request.tools[0].input_schema.properties.cache_control.type = 'object'
  assertUnrestored(cache, request)
})

for (const attachment of [
  { type: 'document', source: { type: 'url', url: 'https://example.invalid/large.pdf' } },
  { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
  { type: 'input_file', file_id: 'uploaded-file' },
  { type: 'audio', source: { data: 'compressed-audio' } },
]) {
  test(`unknown expanded ${attachment.type} input disables restoration`, () => {
    const cache = createCache()
    const original = body()
    seed(cache, original)
    const request = pruned(original)
    request.messages.push({ role: 'assistant', content: 'Done.' }, { role: 'user', content: [attachment] })
    assertUnrestored(cache, request)
  })
}

test('new text cache markers are metadata, not expanded attachments', () => {
  const cache = createCache()
  const original = body()
  seed(cache, original)
  const request = pruned(original)
  request.messages.push({
    role: 'user',
    content: [{ type: 'text', text: 'Continue.', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  })
  const tx = prepare(cache, request)
  assert.equal(tx.restored, 1)
  assert.deepEqual(tx.body.messages.at(-1), request.messages.at(-1))
  tx.rollback()
})

test('new tool input business type fields do not masquerade as content blocks', () => {
  const cache = createCache()
  const original = body()
  seed(cache, original)
  const request = pruned(original)
  request.messages.push({
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'new-call',
        name: 'read',
        input: { type: 'module', cache_control: { type: 'business-value' } },
      },
    ],
  })
  const tx = prepare(cache, request)
  assert.equal(tx.restored, 1)
  tx.rollback()
})
