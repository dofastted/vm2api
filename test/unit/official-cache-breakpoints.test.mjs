import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyCrsUnofficialPersona } from '../../src/lib/identity/crs-persona.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { finalizeWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'
import { listCacheMarkers, validateCacheBreakpoints } from '../../src/lib/protocol/cache-ttl.mjs'

const messageMarkers = (body) => listCacheMarkers(body).filter((marker) => marker.section === 'messages')
const marker = (ttl) => ({ type: 'ephemeral', ...(ttl ? { ttl } : {}) })
function shaped(controls = [marker()]) {
  return {
    model: 'claude-opus-5-5',
    system: [
      ...controls.map((cache_control) => ({ type: 'text', text: 'stable prefix', cache_control })),
      { type: 'text', text: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__' },
    ],
    messages: Array.from({ length: 5 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` })),
  }
}

for (const preset of ['official', 'official_full']) {
  for (const model of ['claude-opus-5-5', 'claude-haiku-5-5']) {
    for (const stream of [true, false]) {
      test(`${preset} ${model} stream=${stream}: growing history receives new message breakpoints`, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'official-cache-'))
        try {
          const routingFile = path.join(dir, 'routing.json')
          const routing = { compatibility: { persona_preset: preset, overlay_preset: 'off', cache_ttl: '1h' } }
          fs.writeFileSync(routingFile, JSON.stringify(routing))
          const messages = []
          let previousUser
          for (let turn = 0; turn < 3; turn++) {
            messages.push({ role: 'user', content: `Question ${turn}: ${'context '.repeat(1000)}` })
            const input = { model, max_tokens: 64, system: 'Caller instructions', messages: structuredClone(messages) }
            const rendered = applyCrsUnofficialPersona(input, {
              routingFile,
              mode: preset,
              forceConfigured: true,
              sessionId: 'same-session',
              cacheTtl: '1h',
            })
            const before = structuredClone(rendered)
            const hop = prepareCliHopBody(rendered, { cacheTtl: '1h', stream })
            const { body } = finalizeWorkerPayload({ body: hop, cliHop: true, routing, reqHeaders: {} })
            assert.deepEqual(rendered, before)
            assert.deepEqual(hop.system, rendered.system)
            assert.equal(hop.stream, stream)
            const anchors = messageMarkers(body)
            assert.ok(listCacheMarkers(body).every((marker) => marker.ttl === '1h'))
            assert.equal(anchors.length, turn === 0 ? 1 : 2)
            const lastUser = body.messages.findLastIndex((m) => m.role === 'user')
            assert.equal(anchors.at(-1).index, lastUser)
            if (previousUser) assert.deepEqual(body.messages[anchors[0].index], previousUser)
            previousUser = body.messages[lastUser]
            validateCacheBreakpoints(body)
            assert.deepEqual(prepareCliHopBody(hop, { cacheTtl: '1h', stream, repaired: true }), hop)
            messages.push({ role: 'assistant', content: `Answer ${turn}` })
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      })
    }
  }
}

for (const count of [0, 1, 2, 3, 4]) {
  test(`shaped template respects ${count} existing prefix markers`, () => {
    const input = shaped(Array.from({ length: count }, () => marker('1h')))
    const out = prepareCliHopBody(input, { cacheTtl: '1h' })
    assert.deepEqual(out.system, input.system)
    assert.equal(messageMarkers(out).length, Math.min(2, 4 - count))
    if (count < 4) assert.equal(messageMarkers(out).at(-1).index, 4)
    validateCacheBreakpoints(out)
  })
}

for (const [prefix, requested, expected] of [
  [[marker()], '1h', '5m'],
  [[marker('5m')], '1h', '5m'],
  [[marker('1h')], '1h', '1h'],
  [[marker('1h')], '5m', '5m'],
  [[marker('1h'), marker('5m')], '1h', '5m'],
]) {
  test(`shaped TTL order: ${JSON.stringify(prefix)} + ${requested}`, () => {
    const input = shaped(prefix)
    const out = prepareCliHopBody(input, { cacheTtl: requested })
    assert.deepEqual(out.system, input.system)
    assert.deepEqual(
      messageMarkers(out).map((m) => m.ttl),
      [expected, expected],
    )
    validateCacheBreakpoints(out)
  })
}

for (const ttl of [undefined, '5m', '1h']) {
  test(`shaped clears tool ${ttl} markers before budgeting message anchors after 1h system`, () => {
    const input = shaped([marker('1h'), marker('1h')])
    input.tools = [
      { name: 'Read', input_schema: { type: 'object' }, cache_control: marker(ttl), eager_input_streaming: true },
    ]
    const before = structuredClone(input)
    const out = prepareCliHopBody(input)
    assert.equal(out.tools[0].cache_control, undefined)
    assert.equal(out.tools[0].eager_input_streaming, true)
    assert.deepEqual(out.system, input.system)
    assert.deepEqual(
      messageMarkers(out).map((m) => m.ttl),
      ['1h', '1h'],
    )
    validateCacheBreakpoints(out)
    assert.deepEqual(input, before)
  })
}

test('shaped leaves caller message anchors and mixed TTLs untouched', () => {
  const input = shaped([marker('1h')])
  input.messages[0].content = [{ type: 'text', text: 'caller anchor', cache_control: marker('5m') }]
  const out = prepareCliHopBody(input)
  assert.deepEqual(out.messages[0], input.messages[0])
  assert.equal(messageMarkers(out).length, 1)
  assert.deepEqual(out.system, input.system)
  validateCacheBreakpoints(out)
})

for (const personaPreset of ['official', 'official_full']) {
  for (const ttl of ['5m', '1h']) {
    test(`${personaPreset} reserves CLI system markers when caller expansions leave three message anchors (${ttl})`, () => {
      const input = shaped([marker(ttl)])
      for (const index of [0, 1, 4]) {
        input.messages[index].content = [{ type: 'text', text: `turn ${index}`, cache_control: marker(ttl) }]
      }
      const before = structuredClone(input)
      const out = prepareCliHopBody(input, { personaPreset, cacheTtl: ttl })
      assert.deepEqual(
        messageMarkers(out).map((m) => m.index),
        [1, 4],
      )
      assert.deepEqual(input, before)
      assert.deepEqual(out.system, input.system)
      assert.deepEqual(
        out.messages.map((m) => m.content.map((b) => b.text)),
        input.messages.map((m) => (typeof m.content === 'string' ? [m.content] : m.content.map((b) => b.text))),
      )
      assert.deepEqual(prepareCliHopBody(out, { personaPreset, cacheTtl: ttl }), out)
      const wire = structuredClone(out)
      wire.system.push({ type: 'text', text: 'CLI restored system boundary', cache_control: marker(ttl) })
      validateCacheBreakpoints(wire)
    })
  }
}

for (const options of [
  { outboundShape: 'lean' },
  { preserveSystem: true },
  { requestContext: { purpose: 'auto_mode_classifier' } },
]) {
  for (const personaPreset of [null, 'official', 'official_full']) {
    test(`shaped ${personaPreset ?? 'legacy'} fallback excludes ${JSON.stringify(options)}`, () => {
      const input = shaped()
      if (personaPreset) input.system.pop()
      assert.equal(messageMarkers(prepareCliHopBody(input, { ...options, personaPreset })).length, 0)
    })
  }
}
