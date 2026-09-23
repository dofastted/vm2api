import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCacheTtlToBody,
  applyCacheTtlToUsage,
  clearConversationCacheTtls,
  DEFAULT_CACHE_TTL,
  enforceCacheTtlOrder,
  normalizeCacheTtl,
  pinConversationCacheTtl,
  resolveCacheTtl,
  stripIllegalCacheControlFields,
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

test('ttl-less markers (official Claude Code) take the settings menu value', () => {
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

test('tool 5m then system 1h is downgraded so Anthropic order stays legal', () => {
  const live = {
    tools: [
      { name: 'search' },
      { name: 'google_maps', cache_control: { type: 'ephemeral', ttl: '5m' } },
      { name: 'web_search' },
    ],
    system: [
      { type: 'text', text: 'billing' },
      { type: 'text', text: 'identity' },
      { type: 'text', text: 'expansion', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } },
      { type: 'text', text: 'env', cache_control: { type: 'ephemeral', ttl: '5m' } },
    ],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '5m' } }],
      },
    ],
  }
  const out = enforceCacheTtlOrder(live)
  assert.equal(out.tools[1].cache_control.ttl, '5m')
  assert.deepEqual(out.system[2].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(out.system[3].cache_control, { type: 'ephemeral', ttl: '5m' })
})

test('a leading 1h is removed when any later breakpoint is 5m', () => {
  const out = enforceCacheTtlOrder({
    system: [{ type: 'text', text: 'early', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'later', cache_control: { type: 'ephemeral' } }] }],
  })
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: 'ephemeral' })
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

test('unclassified cache_creation without ttl bills the default 1h rate', () => {
  const asDefault = calculateCost({ cache_creation_tokens: 1_000_000 }, 'claude-sonnet-5')
  const as5m = calculateCost({ cache_creation_tokens: 1_000_000, cache_ttl: '5m' }, 'claude-sonnet-5')
  const as1h = calculateCost({ cache_creation_tokens: 1_000_000, cache_ttl: '1h' }, 'claude-sonnet-5')
  assert.equal(asDefault.cache_creation_cost, 4)
  assert.equal(as5m.cache_creation_cost, 2.5)
  assert.equal(as1h.cache_creation_cost, 4)
  assert.equal(as1h.total_cost - as5m.total_cost, 1.5)
})

test('applyCacheTtlToUsage reclassifies a 5m report after we sent 1h', () => {
  const out = applyCacheTtlToUsage(
    {
      cache_creation_input_tokens: 2000,
      cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 },
    },
    '1h',
  )
  assert.equal(out.cache_creation_1h_tokens, 2000)
  assert.equal(out.cache_creation_5m_tokens, 0)
  assert.equal(out.cache_ttl, '1h')
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
