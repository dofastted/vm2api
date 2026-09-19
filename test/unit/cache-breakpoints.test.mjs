/**
 * Outbound cache_control breakpoint injection (sub2api parity).
 *
 * cache_ttl only retimes markers that already exist, so a caller that sends no
 * cache_control at all used to reach Anthropic with zero breakpoints and pay
 * full input price every turn.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_CACHE_BREAKPOINTS,
  DEFAULT_MIN_CACHEABLE_TOKENS,
  applyCacheBreakpoints,
  applyMessageBreakpoints,
  callerSystemCacheControl,
  highestInboundCacheTtl,
  injectSystemTailBreakpoint,
  injectToolsTailBreakpoint,
  minCacheableTokens,
  normalizeCacheBreakpoints,
  normalizeMessagesBreakpointMode,
} from '../../src/lib/protocol/cache-ttl.mjs'
import { prepareAnthropicRequest } from '../../src/lib/protocol/anthropic-policy.mjs'
import { prepareOutboundEnvelope } from '../../src/lib/protocol/outbound-attempt.mjs'
import {
  applyCrsUnofficialPersona,
  detectProxiedOfficialCcFromRouting,
  isProxiedOfficialClaudeCode,
} from '../../src/lib/identity/crs-persona.mjs'

const OFFICIAL_USER_ID = JSON.stringify({
  device_id: 'd'.repeat(64),
  session_id: '11111111-2222-4333-8444-555555555555',
})

const IDENTITY = {
  vmId: 'vm-01',
  deviceId: 'd'.repeat(64),
  accountUuid: '11111111-1111-4111-8111-111111111111',
  timezone: 'America/Los_Angeles',
  userAgent: 'claude-cli/2.1.241 (external, sdk-cli)',
  fingerprint: { locale: 'en_US.UTF-8', timezone: 'America/Los_Angeles' },
}

function breakpoints(body) {
  const hits = []
  const add = (node, where) => {
    if (node?.cache_control) hits.push({ where, ...node.cache_control })
  }
  for (const [i, tool] of (body.tools || []).entries()) add(tool, `tools[${i}]`)
  for (const [i, block] of (Array.isArray(body.system) ? body.system : []).entries()) add(block, `system[${i}]`)
  for (const [i, message] of (body.messages || []).entries()) {
    if (!Array.isArray(message?.content)) continue
    for (const [j, block] of message.content.entries()) add(block, `messages[${i}][${j}]`)
  }
  return hits
}

function withRoutingFile(compatibility, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bp-'))
  const file = path.join(dir, 'routing.json')
  fs.writeFileSync(file, JSON.stringify({ compatibility }))
  try {
    return fn(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('defaults are on, and messages mode aliases normalize', () => {
  assert.deepEqual(normalizeCacheBreakpoints(undefined), { ...DEFAULT_CACHE_BREAKPOINTS })
  assert.equal(DEFAULT_CACHE_BREAKPOINTS.messages, 'rewrite')
  assert.equal(normalizeMessagesBreakpointMode('auto'), 'rewrite')
  assert.equal(normalizeMessagesBreakpointMode('disabled'), 'off')
  assert.equal(normalizeMessagesBreakpointMode('restamp'), 'rewrite')
  assert.equal(normalizeMessagesBreakpointMode('nonsense'), 'rewrite')
  assert.equal(normalizeMessagesBreakpointMode('fill'), 'fill')
  assert.equal(normalizeCacheBreakpoints({ enabled: false }).enabled, false)
})

test('the model minimum table keeps the opus 4 point releases apart', () => {
  assert.equal(minCacheableTokens('claude-opus-5'), 512)
  assert.equal(minCacheableTokens('claude-fable-5'), 512)
  assert.equal(minCacheableTokens('claude-sonnet-5'), 1024)
  assert.equal(minCacheableTokens('claude-sonnet-5[1m]'), 1024)
  assert.equal(minCacheableTokens('claude-sonnet-4-6'), 1024)
  assert.equal(minCacheableTokens('claude-opus-4-8'), 1024)
  assert.equal(minCacheableTokens('claude-opus-4-7'), 2048)
  assert.equal(minCacheableTokens('claude-opus-4-6'), 4096)
  assert.equal(minCacheableTokens('claude-haiku-4-5-20251001'), 4096)
  assert.equal(minCacheableTokens('claude-opus-4'), 1024)
  assert.equal(minCacheableTokens('claude-3-5-haiku-20241022'), 2048)
  assert.equal(minCacheableTokens('claude-something-new'), DEFAULT_MIN_CACHEABLE_TOKENS)
})

test('a system below the model minimum is left unmarked', () => {
  const out = applyCacheBreakpoints(
    {
      model: 'claude-opus-4-6',
      system: [
        { type: 'text', text: 'billing' },
        { type: 'text', text: 'caller system' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    },
    { config: DEFAULT_CACHE_BREAKPOINTS },
  )
  assert.deepEqual(
    breakpoints(out).map((h) => h.where),
    ['messages[0][0]'],
  )
})

test('a system long enough to be cached gets the tail breakpoint', () => {
  const out = applyCacheBreakpoints(
    {
      model: 'claude-opus-5',
      system: [
        { type: 'text', text: 'billing' },
        { type: 'text', text: 'x'.repeat(2100) },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    },
    { config: DEFAULT_CACHE_BREAKPOINTS },
  )
  const hits = breakpoints(out)
  assert.deepEqual(
    hits.map((h) => h.where),
    ['system[1]', 'messages[0][0]'],
  )
  assert.ok(hits.every((h) => h.type === 'ephemeral' && h.ttl === '5m'))
})

test('the official four-block system keeps its own boundary on the agent slot', () => {
  const out = applyCacheBreakpoints(
    {
      model: 'claude-opus-5',
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.241.abc;' },
        { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
        { type: 'text', text: 'agent '.repeat(700), cache_control: { type: 'ephemeral', ttl: '5m' } },
        { type: 'text', text: 'caller --system leftover' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    },
    { config: DEFAULT_CACHE_BREAKPOINTS },
  )
  assert.deepEqual(
    breakpoints(out).map((h) => h.where),
    ['system[2]', 'messages[0][0]'],
  )
})

test('the tail block is chosen so the caller system stays inside the cached prefix', () => {
  const out = injectSystemTailBreakpoint({
    system: [
      { type: 'text', text: 'billing' },
      { type: 'text', text: 'identity' },
      { type: 'text', text: 'caller leftover' },
    ],
  })
  assert.equal(out.system[0].cache_control, undefined)
  assert.equal(out.system[1].cache_control, undefined)
  assert.deepEqual(out.system[2].cache_control, { type: 'ephemeral', ttl: '5m' })
})

test('an existing ttl is never overwritten', () => {
  const body = { system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }] }
  assert.equal(injectSystemTailBreakpoint(body, '5m'), body)
})

test('an existing 5m is not overwritten when injecting 1h', () => {
  const body = {
    tools: [{ name: 'Write', input_schema: {}, cache_control: { type: 'ephemeral', ttl: '5m' } }],
  }
  assert.equal(injectToolsTailBreakpoint(body, '1h'), body)
})

test('a cache_control without ttl is filled in place', () => {
  const out = injectSystemTailBreakpoint({
    system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
  })
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '5m' })
})

test('tools tail skips server tools and deferred tools', () => {
  const out = injectToolsTailBreakpoint({
    tools: [
      { name: 'Read', input_schema: {} },
      { name: 'Write', input_schema: {} },
      { type: 'web_search_20250305', name: 'web_search' },
    ],
  })
  assert.equal(out.tools[0].cache_control, undefined)
  assert.deepEqual(out.tools[1].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.equal(out.tools[2].cache_control, undefined)
})

test('a deferred tool loses the marker Anthropic rejects', () => {
  const out = injectToolsTailBreakpoint({
    tools: [
      { name: 'Read', input_schema: {} },
      { name: 'Lazy', input_schema: {}, defer_loading: true, cache_control: { type: 'ephemeral', ttl: '5m' } },
    ],
  })
  assert.deepEqual(out.tools[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.equal(out.tools[1].cache_control, undefined)
})

test('fill leaves a body that already carries caller message breakpoints alone', () => {
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    ],
  }
  assert.equal(applyMessageBreakpoints(body, '5m', 'fill'), body)
})

test('fill marks the last message and the penultimate user when length >= 4', () => {
  const out = applyMessageBreakpoints(
    {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'u1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: [{ type: 'text', text: 'u2' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      ],
    },
    '5m',
    'fill',
  )
  assert.deepEqual(
    breakpoints(out).map((h) => h.where),
    ['messages[0][0]', 'messages[3][0]'],
  )
})

test('a short conversation only gets the tail marker', () => {
  const out = applyMessageBreakpoints(
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'only' }] }] },
    '5m',
    'fill',
  )
  assert.equal(breakpoints(out).length, 1)
})

test('rewrite drops caller markers before re-marking the stable positions', () => {
  const out = applyMessageBreakpoints(
    {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'u1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: [{ type: 'text', text: 'u2', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      ],
    },
    '5m',
    'rewrite',
  )
  assert.deepEqual(
    breakpoints(out).map((h) => h.where),
    ['messages[0][0]', 'messages[3][0]'],
  )
})

test('off leaves messages untouched', () => {
  const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }
  assert.equal(applyMessageBreakpoints(body, '5m', 'off'), body)
})

test('a string content block is promoted so the marker has somewhere to live', () => {
  const out = applyMessageBreakpoints({ messages: [{ role: 'user', content: 'plain' }] }, '5m', 'fill')
  assert.deepEqual(out.messages[0].content, [
    { type: 'text', text: 'plain', cache_control: { type: 'ephemeral', ttl: '5m' } },
  ])
})

test('an inbound 1h request is injected at 1h so enforceCacheTtlOrder cannot downgrade it', () => {
  const inbound = {
    system: [{ type: 'text', text: 'caller', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  assert.equal(highestInboundCacheTtl(inbound, '5m'), '1h')
  const out = applyCacheBreakpoints(
    { system: [{ type: 'text', text: 'billing' }], messages: inbound.messages },
    { ttl: '5m', config: DEFAULT_CACHE_BREAKPOINTS, inbound },
  )
  assert.equal(breakpoints(out)[0].ttl, '1h')
})

test('the caller system breakpoint survives even with system_tail off', () => {
  const inbound = {
    system: [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'last', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
  }
  assert.deepEqual(callerSystemCacheControl(inbound), { type: 'ephemeral', ttl: '1h' })
  const out = applyCacheBreakpoints(
    {
      system: [
        { type: 'text', text: 'rebuilt billing' },
        { type: 'text', text: 'rebuilt leftover' },
      ],
    },
    { ttl: '5m', config: { system_tail: false, tools_tail: false, messages: 'off' }, inbound },
  )
  assert.deepEqual(breakpoints(out), [{ where: 'system[1]', type: 'ephemeral', ttl: '1h' }])
})

test('disabled config injects nothing', () => {
  const body = { system: [{ type: 'text', text: 'x' }], messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(applyCacheBreakpoints(body, { config: { enabled: false } }), body)
})

test('a thinking block never keeps cache_control', () => {
  const out = prepareAnthropicRequest({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig', cache_control: { type: 'ephemeral', ttl: '5m' } },
          { type: 'text', text: 'answer' },
        ],
      },
    ],
  })
  assert.equal(breakpoints(out).length, 0)
})

test('over the four-breakpoint budget, tools are sacrificed and system is kept', () => {
  const mark = { type: 'ephemeral', ttl: '5m' }
  const out = prepareAnthropicRequest({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    tools: [
      { name: 'a', input_schema: {}, cache_control: { ...mark } },
      { name: 'b', input_schema: {}, cache_control: { ...mark } },
    ],
    system: [
      { type: 'text', text: 's1', cache_control: { ...mark } },
      { type: 'text', text: 's2', cache_control: { ...mark } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1', cache_control: { ...mark } }] },
      { role: 'user', content: [{ type: 'text', text: 'u2', cache_control: { ...mark } }] },
    ],
  })
  assert.deepEqual(
    breakpoints(out).map((h) => h.where),
    ['system[0]', 'system[1]', 'messages[0][0]', 'messages[1][0]'],
  )
})

/** The live regression: persona rebuilds system from a template, so a caller's own
    breakpoint used to vanish and every turn re-created the cache. */
test('a caller breakpoint on system reaches the wire through the official persona preset', () => {
  withRoutingFile({ persona_preset: 'official', overlay_preset: 'off' }, (routingFile) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bp-home-'))
    const inbound = {
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: [{ type: 'text', text: 'You are our internal docs bot.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    }
    const persona = applyCrsUnofficialPersona(structuredClone(inbound), {
      officialClient: false,
      routingFile,
      sessionId: '11111111-2222-4333-8444-555555555555',
      identity: IDENTITY,
      model: inbound.model,
    })
    assert.equal(breakpoints(persona).length, 0, 'persona still drops the caller marker')
    const envelope = prepareOutboundEnvelope({
      canonicalBody: persona,
      inbound,
      identity: IDENTITY,
      unofficial: true,
      stream: true,
      cacheTtl: '5m',
      cacheBreakpoints: DEFAULT_CACHE_BREAKPOINTS,
      reqHeaders: { 'user-agent': 'Go-http-client/2.0' },
      homeDir: dir,
    })
    const hits = breakpoints(envelope.body)
    assert.ok(hits.length >= 1, 'outbound body must carry at least one breakpoint')
    assert.ok(
      hits.some((h) => h.where.startsWith('system[')),
      'the system prefix must be cacheable',
    )
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

test('official Claude Code traffic keeps its own breakpoints and gets none from us', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bp-official-'))
  const body = {
    model: 'claude-sonnet-5',
    max_tokens: 128000,
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_entrypoint=cli;' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  const envelope = prepareOutboundEnvelope({
    canonicalBody: body,
    inbound: body,
    identity: IDENTITY,
    unofficial: false,
    officialClient: true,
    stream: true,
    cacheTtl: '5m',
    cacheBreakpoints: DEFAULT_CACHE_BREAKPOINTS,
    reqHeaders: { 'user-agent': 'claude-cli/2.1.241 (external, cli)' },
    homeDir: dir,
  })
  assert.equal(breakpoints(envelope.body).length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('proxied-official-CC detection is on unless explicitly disabled', () => {
  assert.equal(detectProxiedOfficialCcFromRouting({}), true)
  assert.equal(detectProxiedOfficialCcFromRouting({ compatibility: {} }), true)
  assert.equal(detectProxiedOfficialCcFromRouting({ compatibility: { detect_proxied_official_cc: false } }), false)
})

test('a real Claude Code body behind a rewritten UA is claimed', () => {
  assert.equal(
    isProxiedOfficialClaudeCode({
      model: 'claude-sonnet-5',
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.241.9; cc_entrypoint=cli; cch=ab; cc_prompt_id=x;',
        },
        { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      ],
      metadata: { user_id: OFFICIAL_USER_ID },
      messages: [{ role: 'user', content: 'hi' }],
    }),
    true,
  )
})

/** The shape 95% of live third-party traffic actually has: a fictional-chat
    system prompt as a bare string, and no metadata at all. */
test('a fictional-chat third-party body is never claimed', () => {
  assert.equal(
    isProxiedOfficialClaudeCode({
      model: 'claude-fable-5',
      system: "Write X's next reply in a fictional chat between X and the user.",
      messages: [{ role: 'user', content: 'continue' }],
    }),
    false,
  )
})

test('a body that only borrows the identity line is not enough', () => {
  assert.equal(
    isProxiedOfficialClaudeCode({
      model: 'claude-sonnet-5',
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      metadata: { user_id: OFFICIAL_USER_ID },
      messages: [{ role: 'user', content: 'hi' }],
    }),
    false,
  )
})

test('the local-agent stealth prefix stays unofficial even with a billing block', () => {
  assert.equal(
    isProxiedOfficialClaudeCode({
      model: 'claude-fable-5',
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.237.217; cc_entrypoint=local-agent;' },
        { type: 'text', text: 'You are Claude, an AI assistant.' },
      ],
      metadata: { user_id: OFFICIAL_USER_ID },
      messages: [{ role: 'user', content: 'hi' }],
    }),
    false,
  )
})

test('a claimed body reaches the wire with its own breakpoints and none from us', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bp-proxied-'))
  const body = {
    model: 'claude-sonnet-5',
    max_tokens: 128000,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.241.9; cc_entrypoint=cli;' },
      { type: 'text', text: 'caller prompt', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    metadata: { user_id: OFFICIAL_USER_ID },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  assert.equal(isProxiedOfficialClaudeCode(body), true)
  const envelope = prepareOutboundEnvelope({
    canonicalBody: body,
    inbound: body,
    identity: IDENTITY,
    unofficial: false,
    officialClient: true,
    stream: true,
    cacheTtl: '1h',
    cacheBreakpoints: DEFAULT_CACHE_BREAKPOINTS,
    reqHeaders: { 'user-agent': 'Go-http-client/2.0' },
    homeDir: dir,
  })
  assert.deepEqual(breakpoints(envelope.body), [{ where: 'system[1]', type: 'ephemeral', ttl: '1h' }])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('probe and admin paths that pass no config are unchanged', () => {
  const out = prepareAnthropicRequest({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    system: [{ type: 'text', text: 'billing' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.equal(breakpoints(out).length, 0)
})
