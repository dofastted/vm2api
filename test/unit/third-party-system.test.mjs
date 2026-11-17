import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relocateThirdPartySystem, thirdPartyRelocateEnabled } from '../../src/lib/protocol/third-party-system.mjs'
import { CRS_OFFICIAL_CLI_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'

const AGENT = 'You are OpenCode, the best coding agent on the planet.\n\nFollow the rules.'

test('moves the caller system into the first user message', () => {
  const body = {
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: AGENT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hi' }],
  }
  const r = relocateThirdPartySystem(body)
  assert.equal(r.moved, true)
  assert.deepEqual(r.body.system, [{ type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM }])
  assert.deepEqual(r.body.messages[0].content, [
    { type: 'text', text: AGENT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'hi' },
  ])
  assert.equal(body.system[0].text, AGENT, 'input is not mutated')
})

test('caller cache markers move with their blocks in order', () => {
  const hour = { type: 'ephemeral', ttl: '1h' }
  const r = relocateThirdPartySystem({
    system: [
      { type: 'text', text: AGENT, cache_control: hour },
      { type: 'text', text: 'Second', extra: 'dropped' },
      { type: 'text', text: 'Third', cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
  })
  assert.deepEqual(r.body.messages[0].content, [
    { type: 'text', text: AGENT, cache_control: hour },
    { type: 'text', text: 'Second' },
    { type: 'text', text: 'Third', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } },
  ])
  assert.equal(r.body.system[0].cache_control, undefined)
})

test('keeps array user content and later turns untouched', () => {
  const r = relocateThirdPartySystem({
    system: AGENT,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: 'b' },
    ],
  })
  assert.equal(r.body.messages[0].content.length, 2)
  assert.equal(r.body.messages[0].content[1].cache_control.type, 'ephemeral')
  assert.equal(r.body.messages[1].content, 'b')
})

test('official identity and billing blocks are not caller content', () => {
  const body = {
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.1; cc_entrypoint=cli;' },
      { type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  }
  const r = relocateThirdPartySystem(body)
  assert.equal(r.moved, false)
  assert.equal(r.body, body)
})

test('identity stays, only the extra block moves; no user turn gets one', () => {
  const r = relocateThirdPartySystem({
    system: [
      { type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM },
      { type: 'text', text: AGENT },
    ],
    messages: [{ role: 'assistant', content: 'x' }],
  })
  assert.equal(r.blocks, 1)
  assert.equal(r.body.messages[0].role, 'user')
  assert.equal(r.body.messages[1].role, 'assistant')
})

test('no system or no messages is a no-op', () => {
  assert.equal(relocateThirdPartySystem({ messages: [{ role: 'user', content: 'x' }] }).moved, false)
  assert.equal(relocateThirdPartySystem({ system: AGENT, messages: [] }).moved, false)
  assert.equal(relocateThirdPartySystem(null).moved, false)
})

test('switch: follows claude_code_only (off admits and relocates, on rejects upstream of this)', () => {
  assert.equal(thirdPartyRelocateEnabled(null), true)
  assert.equal(thirdPartyRelocateEnabled({ compatibility: {} }), true)
  assert.equal(thirdPartyRelocateEnabled({ compatibility: { claude_code_only: false } }), true)
  assert.equal(thirdPartyRelocateEnabled({ compatibility: { claude_code_only: true } }), false)
})
