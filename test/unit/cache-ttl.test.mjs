import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCacheTtlToBody,
  applyCacheTtlToUsage,
  clearConversationCacheTtls,
  DEFAULT_CACHE_TTL,
  enforceCacheTtlOrder,
  fillMissingCacheTtl,
  validateCacheBreakpoints,
  normalizeCacheTtl,
  pinConversationCacheTtl,
  removeCacheControlFields,
  repairCacheBreakpoints,
  resolveCacheTtl,
  stripIllegalCacheControlFields,
  normalizeCacheTtlToBody,
  materializeAutomaticCache,
} from '../../src/lib/protocol/cache-ttl.mjs'
import { calculateCost } from '../../src/lib/admin/pricing.mjs'

test('cache ttl accepts only 1h or 5m output values', () => {
  assert.equal(normalizeCacheTtl(undefined), DEFAULT_CACHE_TTL)
  assert.equal(DEFAULT_CACHE_TTL, '1h')
  assert.equal(normalizeCacheTtl('5m'), '5m')
  assert.equal(normalizeCacheTtl('1h'), '1h')
  assert.equal(normalizeCacheTtl('bogus'), '1h')
})

test('header overrides routing default', () => {
  assert.equal(
    resolveCacheTtl({ headers: { 'x-kin-cache-ttl': '1h' }, routing: { compatibility: { cache_ttl: '5m' } } }),
    '1h',
  )
  assert.equal(resolveCacheTtl({ headers: {}, routing: { compatibility: { cache_ttl: '1h' } } }), '1h')
  assert.equal(resolveCacheTtl({ headers: {}, routing: { compatibility: {} } }), '1h')
  assert.equal(resolveCacheTtl({ headers: {}, routing: { compatibility: { cache_ttl: '5m' } } }), '5m')
})
test('the first explicit TTL in Anthropic wire order controls session resolution', () => {
  const body = {
    tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '5m' } }],
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'tail', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ],
  }
  assert.equal(resolveCacheTtl({ headers: {}, body, routing: { compatibility: { cache_ttl: '1h' } } }), '5m')
  const implicitFirst = {
    system: [
      { type: 'text', text: 'implicit', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'later hour', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
  }
  assert.equal(
    resolveCacheTtl({ headers: {}, body: implicitFirst, routing: { compatibility: { cache_ttl: '1h' } } }),
    '1h',
  )
})

test('resolveCacheTtl falls back to routingFile when routing object omits cache_ttl', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cache-ttl-file-'))
  try {
    const file = path.join(dir, 'routing.json')
    fs.writeFileSync(file, JSON.stringify({ compatibility: { cache_ttl: '5m' } }))
    assert.equal(resolveCacheTtl({ headers: {}, routing: {}, routingFile: file }), '5m')
    fs.writeFileSync(file, JSON.stringify({ compatibility: { cache_ttl: '1h' } }))
    const future = new Date(Date.now() + 2000)
    fs.utimesSync(file, future, future)
    assert.equal(resolveCacheTtl({ headers: {}, routing: {}, routingFile: file }), '1h')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ttl-less callers leave the platform default selection to the settings menu', () => {
  const body = {
    system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
  }
  assert.equal(resolveCacheTtl({ headers: {}, body, routing: { compatibility: { cache_ttl: '1h' } } }), '1h')
  assert.equal(resolveCacheTtl({ headers: {}, body, routing: { compatibility: { cache_ttl: '5m' } } }), '5m')
  const out = applyCacheTtlToBody(body, '1h')
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('an invalid caller TTL cannot override the platform default used to repair it', () => {
  const body = { system: [{ type: 'text', text: 'invalid', cache_control: { type: 'ephemeral', ttl: '2h' } }] }
  const ttl = resolveCacheTtl({ body, routing: { compatibility: { cache_ttl: '5m' } } })
  assert.equal(ttl, '5m')
  assert.deepEqual(enforceCacheTtlOrder(body, ttl).system[0].cache_control, { type: 'ephemeral', ttl: '5m' })
})

test('owned TTL completion preserves explicit mixed TTLs and scope without mutating input', () => {
  const input = {
    system: [
      { type: 'text', text: 'hour', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } },
      { type: 'text', text: 'missing', cache_control: { type: 'ephemeral', scope: 'org' } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'short', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
    ],
  }
  const before = structuredClone(input)
  const output = fillMissingCacheTtl(input, '5m')
  assert.deepEqual(
    output.system.map((block) => block.cache_control),
    [
      { type: 'ephemeral', ttl: '1h', scope: 'global' },
      { type: 'ephemeral', ttl: '5m', scope: 'org' },
    ],
  )
  assert.deepEqual(output.messages, input.messages)
  assert.deepEqual(input, before)
})

test('owned TTL completion never places a filled 1h after a shorter marker', () => {
  const marked = (text, ttl) => ({ type: 'text', text, cache_control: { type: 'ephemeral', ...(ttl ? { ttl } : {}) } })
  const output = fillMissingCacheTtl(
    {
      tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
      system: [marked('short', '5m')],
      messages: [{ role: 'user', content: [marked('tail')] }],
      cache_control: { type: 'ephemeral' },
    },
    '1h',
  )
  assert.deepEqual(output.tools[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(output.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(output.cache_control, { type: 'ephemeral', ttl: '5m' })
  validateCacheBreakpoints(output)
})

test('native validation counts automatic caching against the explicit marker budget', () => {
  const input = {
    system: Array.from({ length: 4 }, (_, index) => ({
      type: 'text',
      text: String(index),
      cache_control: { type: 'ephemeral', ttl: '1h' },
    })),
    cache_control: { type: 'ephemeral' },
  }
  assert.throws(() => validateCacheBreakpoints(input), /four breakpoints/)
})

test('a conversation keeps its first TTL until that cache would have expired', () => {
  clearConversationCacheTtls()
  const t0 = 1_000_000
  assert.equal(pinConversationCacheTtl('conv-a', '5m', t0), '5m')
  // Menu flipped to 1h mid-conversation: still 5m while the 5m cache is warm.
  assert.equal(pinConversationCacheTtl('conv-a', '1h', t0 + 4 * 60_000), '5m')
  // Each turn refreshes the window.
  assert.equal(pinConversationCacheTtl('conv-a', '1h', t0 + 8 * 60_000), '5m')
  // Idle longer than 5m: the cache is gone, so the new value applies.
  assert.equal(pinConversationCacheTtl('conv-a', '1h', t0 + 14 * 60_000), '1h')
  assert.equal(pinConversationCacheTtl('conv-b', '5m', t0), '5m', 'conversations are independent')
  assert.equal(pinConversationCacheTtl('', '5m', t0), '5m')
  assert.equal(pinConversationCacheTtl('', '1h', t0), '1h', 'no key means no pin')
  clearConversationCacheTtls()
})

test('explicit inbound 5m or 1h overrides the console default', () => {
  assert.equal(
    resolveCacheTtl({
      headers: {},
      body: { tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      routing: { compatibility: { cache_ttl: '5m' } },
    }),
    '1h',
  )
  assert.equal(
    resolveCacheTtl({
      headers: {},
      body: { tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
      routing: { compatibility: { cache_ttl: '1h' } },
    }),
    '5m',
  )
  assert.equal(
    resolveCacheTtl({
      headers: { 'x-kin-cache-ttl': '5m' },
      body: { system: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    }),
    '5m',
  )
})

test('stripIllegalCacheControlFields drops scope on system and tools', () => {
  const out = stripIllegalCacheControlFields({
    system: [
      {
        type: 'text',
        text: 'expansion',
        cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' },
      },
    ],
    tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } }],
  })
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(out.tools[0].cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('applyCacheTtlToBody default 5m overwrites leftover system 1h', () => {
  const out = applyCacheTtlToBody(
    {
      system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } }],
    },
    '5m',
  )
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '5m' })
})
test('final TTL normalization retains cache marker scope', () => {
  const input = {
    system: [{ type: 'text', text: 'cached', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } }],
  }
  const out = normalizeCacheTtlToBody(input, '5m')
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '5m', scope: 'global' })
  assert.equal(input.system[0].cache_control.ttl, '1h')
})

test('a 5m tool marker normalizes all later cache markers to 5m', () => {
  const live = {
    tools: [
      { name: 'search' },
      { name: 'google_maps', cache_control: { type: 'ephemeral', ttl: '5m' } },
      { name: 'web_search' },
    ],
    system: [
      { type: 'text', text: 'expansion', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } },
      { type: 'text', text: 'env', cache_control: { type: 'ephemeral', ttl: '5m' } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ],
  }
  const out = enforceCacheTtlOrder(live)
  assert.equal(out.tools[1].cache_control.ttl, '5m')
  assert.equal(out.system[0].cache_control.ttl, '5m')
  assert.equal(out.system[1].cache_control.ttl, '5m')
  assert.equal(out.messages[0].content[0].cache_control.ttl, '5m')
  assert.equal(live.system[0].cache_control.ttl, '1h')
})

test('a legal 1h then 5m sequence stays unchanged', () => {
  const out = enforceCacheTtlOrder({
    system: [{ type: 'text', text: 'first', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'later', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
    ],
  })
  assert.equal(out.system[0].cache_control.ttl, '1h')
  assert.equal(out.messages[0].content[0].cache_control.ttl, '5m')
})

test('a caller omission retains the implicit 5m after a 1h marker', () => {
  const out = enforceCacheTtlOrder({
    system: [{ type: 'text', text: 'early', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'later', cache_control: { type: 'ephemeral' } }] }],
  })
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: 'ephemeral' })
})

test('TTL validation leaves legal caller markers intact regardless of the platform default', () => {
  for (const controls of [
    [{ type: 'ephemeral', ttl: '1h' }],
    [{ type: 'ephemeral', ttl: '5m' }],
    [{ type: 'ephemeral' }],
    [
      { type: 'ephemeral', ttl: '1h', scope: 'global' },
      { type: 'ephemeral', ttl: '5m' },
    ],
  ]) {
    const body = {
      system: controls.map((cache_control) => ({ type: 'text', text: 'cached', cache_control })),
      messages: [{ role: 'user', content: 'hello' }],
    }
    const before = structuredClone(body)
    for (const ttl of ['5m', '1h']) assert.equal(enforceCacheTtlOrder(body, ttl), body)
    assert.deepEqual(body, before)
    validateCacheBreakpoints(body)
  }
})

test('TTL rectification changes only invalid values and later hours after a short marker', () => {
  const input = {
    cache_control: { type: 'ephemeral', ttl: '1h' },
    tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    system: [
      { type: 'text', text: 'short', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'invalid', cache_control: { type: 'ephemeral', ttl: '2h', scope: 'global' } },
    ],
    messages: [{ role: 'user', content: 'hello' }],
  }
  const before = structuredClone(input)
  const out = enforceCacheTtlOrder(input, '1h')
  assert.equal(out.tools[0], input.tools[0])
  assert.equal(out.system[0], input.system[0])
  assert.deepEqual(out.system[1].cache_control, { type: 'ephemeral', ttl: '5m', scope: 'global' })
  assert.deepEqual(out.cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(input, before)
  assert.equal(enforceCacheTtlOrder(out), out)
  validateCacheBreakpoints(out)
})

test('applyCacheTtlToBody rewrites every cache marker to selected 5m', () => {
  const out = applyCacheTtlToBody(
    {
      cache_control: { type: 'ephemeral', ttl: '1h' },
      system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } }],
      tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      ],
    },
    '5m',
  )
  assert.equal(out.cache_control.ttl, '5m')
  assert.equal(out.system[0].cache_control.ttl, '5m')
  assert.equal(out.tools[0].cache_control.ttl, '5m')
  assert.equal(out.messages[0].content[0].cache_control.ttl, '5m')
})

test('applyCacheTtlToBody rewrites every cache marker to selected 1h', () => {
  const out = applyCacheTtlToBody(
    {
      system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '5m', scope: 'global' } }],
      tools: [{ name: 'Read', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
      ],
    },
    '1h',
  )
  assert.equal(out.system[0].cache_control.ttl, '1h')
  assert.equal(out.tools[0].cache_control.ttl, '1h')
  assert.equal(out.messages[0].content[0].cache_control.ttl, '1h')
})

test('stripIllegalCacheControlFields drops ephemeral.scope', () => {
  const out = stripIllegalCacheControlFields({
    system: [
      {
        type: 'text',
        text: 'agent',
        cache_control: { type: 'ephemeral', ttl: '5m', scope: 'global' },
      },
    ],
    tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '5m', scope: 'global' } }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '5m', scope: 'global' } }],
      },
    ],
  })
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(out.tools[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '5m' })
})

test('unclassified cache_creation without ttl bills the 5m rate', () => {
  const asDefault = calculateCost({ cache_creation_tokens: 1_000_000 }, 'claude-sonnet-5')
  const as5m = calculateCost({ cache_creation_tokens: 1_000_000, cache_ttl: '5m' }, 'claude-sonnet-5')
  const as1h = calculateCost({ cache_creation_tokens: 1_000_000, cache_ttl: '1h' }, 'claude-sonnet-5')
  assert.equal(asDefault.cache_creation_cost, 2.5)
  assert.equal(as5m.cache_creation_cost, 2.5)
  assert.equal(as1h.cache_creation_cost, 4)
  assert.equal(as1h.total_cost - as5m.total_cost, 1.5)
})

test('applyCacheTtlToUsage preserves the reported TTL bucket despite the platform default', () => {
  const out = applyCacheTtlToUsage(
    {
      cache_creation_input_tokens: 2000,
      cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 },
    },
    '1h',
  )
  assert.equal(out.cache_creation_1h_tokens, 0)
  assert.equal(out.cache_creation_5m_tokens, 2000)
  assert.equal(out.cache_ttl, '1h')
})

test('mixed cache writes retain both upstream billing buckets', () => {
  const usage = {
    cache_creation_input_tokens: 3000,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
  }
  const before = structuredClone(usage)
  for (const ttl of ['5m', '1h']) {
    const out = applyCacheTtlToUsage(usage, ttl)
    assert.equal(out.cache_creation_5m_tokens, 1000)
    assert.equal(out.cache_creation_1h_tokens, 2000)
    assert.deepEqual(out.cache_creation, usage.cache_creation)
    assert.equal(calculateCost(out, 'claude-sonnet-5').cache_creation_cost, 0.0105)
  }
  assert.deepEqual(usage, before)
})

test('applyCacheTtlToUsage keeps a message_delta total above the stale start split (#678)', () => {
  const out = applyCacheTtlToUsage(
    {
      cache_creation_input_tokens: 14890,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 119 },
    },
    '1h',
  )
  assert.equal(out.cache_creation_1h_tokens, 14890)
  assert.equal(out.cache_creation_5m_tokens, 0)
  assert.equal(out.cache_creation.ephemeral_1h_input_tokens, 14890)
})

test('default 5m usage stays in the 1.25x bucket', () => {
  const out = applyCacheTtlToUsage(
    {
      cache_creation_input_tokens: 2000,
      cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 },
    },
    '5m',
  )
  assert.equal(out.cache_creation_5m_tokens, 2000)
  assert.equal(out.cache_creation_1h_tokens, 0)
  assert.equal(out.cache_ttl, '5m')
  const billed = calculateCost(out, 'claude-sonnet-5')
  assert.equal(billed.cache_creation_cost, 0.005)
})

test('materializeAutomaticCache leaves a body without the field alone', () => {
  // Hops call it unconditionally, so a body with no automatic cache policy must
  // come back untouched rather than gaining an empty marker.
  const body = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }] }
  assert.equal(materializeAutomaticCache(body), body)
  const nulled = { ...body, cache_control: null }
  const out = materializeAutomaticCache(nulled)
  assert.equal('cache_control' in out, false)
  assert.equal(out.messages[0].content[0].cache_control, undefined)
})

test('materializeAutomaticCache defers to an explicit tail marker', () => {
  const explicit = { type: 'ephemeral', ttl: '1h' }
  const out = materializeAutomaticCache({
    cache_control: { type: 'ephemeral' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a', cache_control: explicit }] }],
  })
  // The tail already caches the whole eligible prefix; the root marker just goes.
  assert.equal('cache_control' in out, false)
  assert.deepEqual(out.messages[0].content[0].cache_control, explicit)
})

test('repairCacheBreakpoints is a zero-copy no-op on already valid bodies', () => {
  const valid = {
    model: 'claude-opus-5-5',
    tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
    ],
  }
  assert.strictEqual(repairCacheBreakpoints(valid), valid)
})

test('repairCacheBreakpoints strips thinking/malformed markers, trims >4 keeping active anchors, and fixes TTL order', () => {
  const input = {
    model: 'claude-opus-5-5',
    tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '5m' } }],
    system: [
      { type: 'text', text: 's1', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 's2', cache_control: { type: 'bogus' } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'old1', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 't', signature: 'sig', cache_control: { type: 'ephemeral' } },
          { type: 'redacted_thinking', data: 'r', cache_control: { type: 'ephemeral' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'old2', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      { role: 'user', content: [{ type: 'text', text: 'mid', cache_control: { type: 'ephemeral', ttl: 'bad' } }] },
      { role: 'user', content: [{ type: 'text', text: 'tail', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ],
  }
  const before = structuredClone(input)
  const out = repairCacheBreakpoints(input, { limit: 4, fallbackTtl: '1h' })
  assert.deepEqual(input, before)
  assert.doesNotThrow(() => validateCacheBreakpoints(out))
  assert.equal(out.system[1].cache_control, undefined)
  assert.equal(out.messages[1].content[0].cache_control, undefined)
  assert.equal(out.messages[1].content[1].cache_control, undefined)
  // Stale old1 and old2 dropped first; tools[0], system[0], mid, tail survive (4 total), all <= 5m after tools[0]=5m.
  assert.equal(out.messages[0].content[0].cache_control, undefined)
  assert.equal(out.messages[2].content[0].cache_control, undefined)
  assert.deepEqual(out.tools[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(out.messages[3].content[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(out.messages[4].content[0].cache_control, { type: 'ephemeral', ttl: '5m' })
})

test('removeCacheControlFields strips nested tool_result.content and crag_prompt.blocks markers', () => {
  const input = {
    cache_control: { type: 'ephemeral' },
    tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    crag_prompt: {
      mode: 'replace',
      text: 'sys',
      blocks: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            cache_control: { type: 'ephemeral', ttl: '5m' },
            content: [{ type: 'text', text: 'nested', cache_control: { type: 'ephemeral', ttl: '1h' } }],
          },
        ],
      },
    ],
  }
  const cleared = removeCacheControlFields(input)
  assert.equal(cleared.cache_control, undefined)
  assert.equal(cleared.tools[0].cache_control, undefined)
  assert.equal(cleared.system[0].cache_control, undefined)
  assert.equal(cleared.crag_prompt.blocks[0].cache_control, undefined)
  assert.equal(cleared.messages[0].content[0].cache_control, undefined)
  assert.equal(cleared.messages[0].content[0].content[0].cache_control, undefined)
})

test('normalizeCacheTtl honors custom fallback and stripIllegalCacheControlFields covers nested tool_result & crag_prompt', () => {
  assert.equal(normalizeCacheTtl('bogus', '5m'), '5m')
  assert.equal(normalizeCacheTtl('', '5m'), '5m')
  assert.equal(normalizeCacheTtl('60m', '5m'), '1h')
  const stripped = stripIllegalCacheControlFields({
    crag_prompt: {
      mode: 'replace',
      blocks: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } }],
    },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_nested',
            content: [
              { type: 'text', text: 'nested', cache_control: { type: 'ephemeral', ttl: '5m', scope: 'global' } },
            ],
          },
        ],
      },
    ],
  })
  assert.deepEqual(stripped.crag_prompt.blocks[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(stripped.messages[0].content[0].content[0].cache_control, { type: 'ephemeral', ttl: '5m' })
})
