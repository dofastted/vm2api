import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasForeignSystemBlock,
  relocateThirdPartySystem,
  thirdPartyRelocateEnabled,
} from '../../src/lib/protocol/third-party-system.mjs'
import { CRS_OFFICIAL_AGENT_PROMPT, CRS_OFFICIAL_CLI_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'

const AGENT = 'You are OpenCode, the best coding agent on the planet.\n\nFollow the rules.'
const OPENCLAW =
  'You are a personal assistant running inside OpenClaw.\n\n## OpenClaw Control\nUse the configured workspace.'
const DRIFTED_AGENT = `${CRS_OFFICIAL_AGENT_PROMPT}\n\n# New Section\nVerify the result before replying.`

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

for (const [name, system] of [
  ['A: known official prompt with identity', [CRS_OFFICIAL_CLI_SYSTEM, CRS_OFFICIAL_AGENT_PROMPT]],
  ['B: drifted official prompt with identity', [CRS_OFFICIAL_CLI_SYSTEM, DRIFTED_AGENT]],
  ['C: drifted official prompt alone', [DRIFTED_AGENT]],
]) {
  test(`${name} does not open the gate`, () => {
    // What protects official traffic is the gate, not the mover: with
    // `officialTraffic` true and the gate shut, handle-protocol never calls
    // `relocateThirdPartySystem` for these bodies. The mover is deliberately
    // greedy (see splitSystem) because a third-party caller reaches it through
    // `!officialTraffic`, and everything that is not known-official boilerplate
    // has to leave `system` there. So assert the gate, not the mover.
    assert.equal(hasForeignSystemBlock(system), false)
  })
}

test('D: only the independent OpenClaw block is relocated beside an official agent prompt', () => {
  const body = {
    system: [CRS_OFFICIAL_CLI_SYSTEM, CRS_OFFICIAL_AGENT_PROMPT, OPENCLAW].map((text) => ({ type: 'text', text })),
    messages: [{ role: 'user', content: 'hi' }],
  }

  assert.equal(hasForeignSystemBlock(body.system), true)
  const r = relocateThirdPartySystem(body)
  assert.equal(r.moved, true)
  assert.deepEqual(r.body.system, [{ type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM }])
  assert.deepEqual(r.body.messages[0].content, [
    { type: 'text', text: OPENCLAW },
    { type: 'text', text: 'hi' },
  ])
})

test('a suffix inside an official agent block does not open the gate', () => {
  // Concatenation into one official-looking block is the known limitation: the
  // gate stays shut, so official traffic carrying an appended prompt inside the
  // same block falls through to the upstream 400 rather than being split on an
  // unreliable boundary. Splitting mid-block would risk cutting a genuine new
  // official section out of `system`.
  const system = `${CRS_OFFICIAL_AGENT_PROMPT}\n\n${OPENCLAW}`
  assert.equal(hasForeignSystemBlock(system), false)
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

// The gate and the mover answer different questions and must not share a
// predicate. `hasForeignSystemBlock` is strict so official traffic is never
// relocated; `splitSystem` stays greedy so a third-party caller's prompt still
// leaves `system`. A third-party agent prompt routinely carries a
// `# Environment` section or the official agent wording, and treating those as
// official in the mover would leave them in `system` and reintroduce the
// upstream 400 this module exists to prevent.
test('a third-party prompt still relocates even when it carries official-looking markers', () => {
  for (const text of [
    'You are OpenCode, a coding agent.\n\n# Environment\ncwd: /tmp',
    'You are an interactive agent that helps users with software engineering tasks. Built by Acme.',
    'You are Cline, a highly skilled software engineer.',
  ]) {
    const r = relocateThirdPartySystem({
      system: [{ type: 'text', text }],
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(r.moved, true, text.slice(0, 40))
    assert.equal(r.blocks, 1)
    assert.deepEqual(r.body.system, [{ type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM }])
    assert.deepEqual(r.body.messages[0].content, [
      { type: 'text', text },
      { type: 'text', text: 'hi' },
    ])
  }
})

// These are the shapes the gate protects: for genuine official traffic
// `officialTraffic` is true, so relocation runs only when the gate says a block
// is positively foreign. An official prompt that drifted past
// KNOWN_OFFICIAL_SYSTEM_TEXTS must not make the gate fire, or every official
// request would be relocated on the next CLI release.
test('the gate stays shut for official traffic, including a drifted official prompt', () => {
  const ident = "You are Claude Code, Anthropic's official CLI for Claude."
  const drifted = `${CRS_OFFICIAL_AGENT_PROMPT}\n\n# New Section\nA line the next CLI version added.`
  const blocks = (texts) => texts.map((text) => ({ type: 'text', text }))

  assert.equal(hasForeignSystemBlock(blocks([ident, CRS_OFFICIAL_AGENT_PROMPT])), false)
  assert.equal(hasForeignSystemBlock(blocks([ident, drifted])), false)
  // Block-count asymmetry must not change the answer: the same drifted text
  // alone has to classify the same way it does beside the identity block.
  assert.equal(hasForeignSystemBlock(blocks([drifted])), false)
})
