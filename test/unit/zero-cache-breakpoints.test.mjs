import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyCrsUnofficialPersona } from '../../src/lib/identity/crs-persona.mjs'
import assert from 'node:assert/strict'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { validateCacheBreakpoints } from '../../src/lib/protocol/cache-ttl.mjs'

function fixture(turns = 5, model = 'claude-haiku-5-5') {
  return {
    model,
    max_tokens: 64,
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.303; prompt_version=<fixture>;' }],
    messages: Array.from({ length: turns }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `fixture ${i}`,
    })),
  }
}

function markers(body) {
  const nodes = [...(body.tools || []), ...(body.system || [])]
  for (const message of body.messages || []) {
    if (Array.isArray(message.content)) nodes.push(...message.content)
  }
  return nodes.filter((node) => node.cache_control).map((node) => node.cache_control)
}

for (const model of ['claude-haiku-5-5', 'claude-opus-5-5']) {
  for (const turns of [1, 5]) {
    for (const ttl of [undefined, '5m', '1h']) {
      test(`zero adds message breakpoints without system injection: ${model}, ${turns} turns, ${ttl}`, () => {
        const input = fixture(turns, model)
        const before = structuredClone(input)
        const out = prepareCliHopBody(input, { cacheTtl: ttl })
        assert.deepEqual(out.system, input.system)
        assert.deepEqual(markers(out), Array(turns === 1 ? 1 : 2).fill({ type: 'ephemeral', ttl: ttl || '1h' }))
        assert.ok(out.messages.at(-1).content.at(-1).cache_control)
        if (turns === 5) assert.ok(out.messages[2].content.at(-1).cache_control)
        validateCacheBreakpoints(out)
        assert.deepEqual(input, before)
        assert.deepEqual(prepareCliHopBody(out, { cacheTtl: ttl, repaired: true }), out)
      })
    }
  }
}

for (const location of ['system', 'tools', 'messages']) {
  test(`zero preserves caller ${location} breakpoints and TTL instead of adding new ones`, () => {
    const input = fixture()
    const block = { type: 'text', text: 'caller anchor', cache_control: { type: 'ephemeral', ttl: '5m' } }
    if (location === 'system') input.system.push(block)
    if (location === 'tools')
      input.tools = [{ name: 'Read', input_schema: { type: 'object' }, cache_control: block.cache_control }]
    if (location === 'messages') input.messages[0].content = [block]
    const out = prepareCliHopBody(input, { cacheTtl: '1h' })
    assert.deepEqual(markers(out), [block.cache_control])
    if (location === 'messages') assert.deepEqual(out.messages[0], input.messages[0])
    else assert.deepEqual(out[location], input[location])
    validateCacheBreakpoints(out)
  })
}

test('zero leaves a full caller breakpoint budget intact', () => {
  const input = fixture()
  input.system.push(
    ...Array.from({ length: 4 }, () => ({ type: 'text', text: 'anchor', cache_control: { type: 'ephemeral' } })),
  )
  const out = prepareCliHopBody(input)
  assert.deepEqual(out.system, input.system)
  assert.equal(markers({ messages: out.messages }).length, 0)
  validateCacheBreakpoints(out)
})

test('zero does not place a breakpoint on thinking blocks', () => {
  const input = fixture(1)
  input.messages[0].content = [
    { type: 'text', text: 'hello' },
    { type: 'thinking', thinking: 'private', signature: 'signed-fixture' },
  ]
  const out = prepareCliHopBody(input, { preserveThinkingBlocks: true })
  assert.ok(out.messages[0].content[0].cache_control)
  for (const block of out.messages[0].content.filter((block) => block.type === 'thinking'))
    assert.equal(block.cache_control, undefined)
  validateCacheBreakpoints(out)
})

test('zero automatic caching skips a trailing thinking block and keeps the original implicit TTL', () => {
  const input = fixture(1, 'claude-opus-5-5')
  input.cache_control = { type: 'ephemeral' }
  input.messages.push({
    role: 'assistant',
    content: [
      { type: 'text', text: 'Answer' },
      { type: 'thinking', thinking: 'private', signature: 'signed-fixture-01234567890123456789' },
    ],
  })
  const before = structuredClone(input)
  const out = prepareCliHopBody(input, { personaPreset: 'zero', preserveThinkingBlocks: true, cacheTtl: '1h' })
  assert.deepEqual(out.messages[1].content[0].cache_control, input.cache_control)
  assert.equal(out.messages[1].content[1].type, 'thinking')
  assert.equal(out.messages[1].content[1].cache_control, undefined)
  assert.equal(out.cache_control, undefined)
  assert.deepEqual(input, before)
  validateCacheBreakpoints(out)
})

for (const marked of [false, true]) {
  test(`zero automatic caching accounts for trailing system content, marked=${marked}`, () => {
    const input = fixture(1, 'claude-opus-5-5')
    input.cache_control = { type: 'ephemeral', ttl: '5m' }
    const block = {
      type: 'text',
      text: 'Trailing caller rule',
      ...(marked ? { cache_control: { type: 'ephemeral', ttl: '1h' } } : {}),
    }
    input.messages.push({ role: 'system', content: [block] })
    const out = prepareCliHopBody(input, { personaPreset: 'zero' })
    assert.deepEqual(out.messages.at(-1).content[0], marked ? block : { ...block, cache_control: input.cache_control })
    assert.equal(markers(out).length, 1)
    validateCacheBreakpoints(out)
  })
}

test('zero automatic caching reaches the final tool result without changing earlier markers', () => {
  const input = fixture(1)
  input.cache_control = { type: 'ephemeral', ttl: '5m' }
  input.system.push({ type: 'text', text: 'Caller prefix', cache_control: { type: 'ephemeral', ttl: '1h' } })
  input.messages.push(
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Result' }] },
  )
  const out = prepareCliHopBody(input, { personaPreset: 'zero', cacheTtl: '1h' })
  assert.deepEqual(out.system, input.system)
  assert.deepEqual(out.messages.at(-1).content[0], {
    ...input.messages.at(-1).content[0],
    cache_control: input.cache_control,
  })
  assert.deepEqual(prepareCliHopBody(out, { personaPreset: 'zero', cacheTtl: '1h' }), out)
  validateCacheBreakpoints(out)
})

for (const options of [{ preserveSystem: true }, { requestContext: { purpose: 'auto_mode_classifier' } }]) {
  test(`zero fallback does not take over another assembly path: ${JSON.stringify(options)}`, () => {
    assert.equal(markers(prepareCliHopBody(fixture(), options)).length, 0)
  })
}

test('shaped template receives message fallback while keeping its system layout', () => {
  const input = fixture()
  input.system.push({ type: 'text', text: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__' })
  const out = prepareCliHopBody(input)
  assert.deepEqual(out.system, input.system)
  assert.equal(markers(out).length, 2)
})

test('configured zero persona reaches cli-hop with cacheable messages for streaming and JSON requests', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-cache-'))
  try {
    const routingFile = path.join(dir, 'routing.json')
    fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { persona_preset: 'zero', overlay_preset: 'off' } }))
    for (const stream of [true, false]) {
      const input = fixture()
      input.system = [{ type: 'text', text: 'Caller instructions' }]
      const rendered = applyCrsUnofficialPersona(input, {
        routingFile,
        mode: 'zero',
        forceConfigured: true,
        sessionId: 'fixture-session',
      })
      const out = prepareCliHopBody(rendered, { stream, cacheTtl: '1h' })
      assert.deepEqual(out.system, rendered.system)
      assert.deepEqual(out.system.slice(1), input.system)
      assert.equal(out.stream, stream)
      assert.equal(markers(out).length, 2)
      validateCacheBreakpoints(out)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
