import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyCrsUnofficialPersona } from '../../src/lib/identity/crs-persona.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import {
  resolveCacheTtl,
  pinConversationCacheTtl,
  clearConversationCacheTtls,
  listCacheMarkers,
  validateCacheBreakpoints,
} from '../../src/lib/protocol/cache-ttl.mjs'

function fixture() {
  return {
    model: 'claude-opus-5-5',
    max_tokens: 64,
    system: 'Caller instructions',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'third' },
    ],
  }
}

function render(t, { preset = 'official', ttl = '1h', headers = {}, input = fixture(), templates, cacheTtl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-cache-ttl-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const routingFile = path.join(dir, 'routing.json')
  const routing = {
    compatibility: { persona_preset: preset, overlay_preset: 'off', cache_ttl: ttl, persona_templates: templates },
  }
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const resolved = cacheTtl ?? resolveCacheTtl({ headers, body: input, routingFile })
  const rendered = applyCrsUnofficialPersona(input, {
    routingFile,
    mode: preset,
    forceConfigured: true,
    cacheTtl: resolved,
  })
  const out = prepareCliHopBody(rendered, { cacheTtl: resolved })
  return { rendered, out }
}

for (const preset of ['official', 'official_full']) {
  for (const ttl of ['5m', '1h']) {
    test(`${preset} fills template and message TTL from ${ttl} setting`, (t) => {
      const { rendered, out } = render(t, { preset, ttl })
      const markers = listCacheMarkers(out)
      // Mode 1 (`official`) default emits only [billing, CLI_IDENTITY] (no harness marker);
      // Mode 2 (`official_full`) includes the cached harness block in system[].
      if (preset === 'official_full') assert.ok(markers.some((m) => m.section === 'system'))
      else
        assert.equal(
          markers.some((m) => m.section === 'system'),
          false,
        )
      assert.equal(markers.filter((m) => m.section === 'messages').length, 2)
      assert.ok(markers.every((m) => m.ttl === ttl))
      assert.deepEqual(out.system, rendered.system)
      validateCacheBreakpoints(out)
    })
  }
}

test('request TTL header overrides the default for both template and message anchors', (t) => {
  const { out } = render(t, { ttl: '1h', headers: { 'x-kin-cache-ttl': '5m' } })
  assert.ok(listCacheMarkers(out).every((m) => m.ttl === '5m'))
})

for (const ttl of [undefined, '5m', '1h']) {
  test(`caller message marker with ${ttl} TTL keeps explicit TTL and fills omitted TTL from config`, (t) => {
    const input = fixture()
    input.messages[0].content = [
      { type: 'text', text: 'anchor', cache_control: { type: 'ephemeral', ...(ttl ? { ttl } : {}) } },
    ]
    const before = structuredClone(input)
    const { out } = render(t, { input, ttl: '1h' })
    const expectedTtl = ttl || '1h'
    assert.deepEqual(out.messages[0], {
      ...input.messages[0],
      content: [
        { type: 'text', text: `<system-reminder>\n${input.system}\n</system-reminder>\n` },
        { type: 'text', text: 'anchor', cache_control: { type: 'ephemeral', ttl: expectedTtl } },
      ],
    })
    assert.deepEqual(input, before)
    const messages = listCacheMarkers(out).filter((m) => m.section === 'messages')
    assert.equal(messages.length, 1)
    assert.equal(messages[0].ttl, expectedTtl)
    validateCacheBreakpoints(out)
  })
}

function template(controls) {
  return [
    ...controls.map((cache_control, i) => ({ id: `anchor${i}`, type: 'text', text: `system ${i}`, cache_control })),
    { id: 'dynamic_boundary', type: 'text', text: '{{dynamic_boundary}}' },
  ]
}
const control = (ttl) => ({ type: 'ephemeral', ...(ttl ? { ttl } : {}) })

for (const [controls, requested, expected] of [
  [[control('5m'), control()], '1h', ['5m', '5m']],
  [[control(), control('1h')], '5m', ['1h', '1h']],
  [[control('1h'), control()], '5m', ['1h', '5m']],
]) {
  test(`edited official template retains explicit TTL and fills a legal order: ${JSON.stringify(expected)}`, (t) => {
    const { out } = render(t, {
      ttl: requested,
      preset: 'official_full',
      templates: { official_full: template(controls) },
    })
    assert.deepEqual(
      listCacheMarkers(out)
        .filter((m) => m.section === 'system')
        .map((m) => m.ttl),
      expected,
    )
    validateCacheBreakpoints(out)
  })
}

test('caller 1h message anchor is not invalidated by a default 5m template fill', (t) => {
  const input = fixture()
  input.messages[0].content = [{ type: 'text', text: 'anchor', cache_control: control('1h') }]
  const { out } = render(t, { input, headers: { 'x-kin-cache-ttl': '5m' } })
  assert.deepEqual(out.messages[0], {
    ...input.messages[0],
    content: [
      { type: 'text', text: `<system-reminder>\n${input.system}\n</system-reminder>\n` },
      ...input.messages[0].content,
    ],
  })
  assert.ok(listCacheMarkers(out).every((m) => m.ttl === '1h'))
  validateCacheBreakpoints(out)
})

test('template uses pinned conversation TTL after the setting changes', (t) => {
  clearConversationCacheTtls()
  t.after(clearConversationCacheTtls)
  assert.equal(pinConversationCacheTtl('fixture', '1h', 1000), '1h')
  const cacheTtl = pinConversationCacheTtl('fixture', '5m', 2000)
  const { out } = render(t, { ttl: '5m', cacheTtl })
  assert.ok(listCacheMarkers(out).every((m) => m.ttl === '1h'))
})

test('official caller system markers without TTL are not treated as gateway template markers', () => {
  const input = fixture()
  input.system = [{ type: 'text', text: 'caller owned', cache_control: control() }]
  const out = applyCrsUnofficialPersona(input, { officialClient: true, cacheTtl: '1h' })
  assert.deepEqual(out, input)
  assert.equal(out.system[0].cache_control.ttl, undefined)
})

for (const ttl of ['5m', '1h']) {
  test(`gateway-inserted agent breakpoint also uses ${ttl} instead of a hard-coded hour`, (t) => {
    const { out } = render(t, { ttl, templates: { official: template([control()]) } })
    const system = listCacheMarkers(out).filter((m) => m.section === 'system')
    assert.equal(system.length, 2)
    assert.ok(listCacheMarkers(out).every((m) => m.ttl === ttl))
    validateCacheBreakpoints(out)
  })
}
