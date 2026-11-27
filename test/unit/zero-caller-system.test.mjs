import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { applyCrsUnofficialPersona } from '../../src/lib/identity/crs-persona.mjs'
import { DEFAULT_PERSONA_TEMPLATES } from '../../src/lib/identity/persona-template.mjs'
import { validateCacheBreakpoints } from '../../src/lib/protocol/cache-ttl.mjs'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'

const base = {
  model: 'claude-opus-5-5',
  max_tokens: 128,
  messages: [{ role: 'user', content: 'Hello' }],
}
const options = {
  mode: 'zero',
  forceConfigured: true,
  sessionId: 'zero-system-fixture',
  cliVersion: '2.1.303',
  identity: { timezone: 'UTC' },
  cacheTtl: '1h',
}

function render(system, overrides = {}) {
  return applyCrsUnofficialPersona({ ...base, system }, { ...options, ...overrides })
}

function routingFile(t, compatibility) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-system-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'routing.json')
  fs.writeFileSync(file, JSON.stringify({ compatibility }))
  return file
}

test('zero retains caller system text and whitespace at system priority', () => {
  const text = '  Only answer in Chinese.\n\nKeep this indentation.\n'
  const out = render(text)
  assert.match(out.system[0].text, /^x-anthropic-billing-header:/)
  assert.deepEqual(out.system.slice(1), [{ type: 'text', text }])
  assert.deepEqual(out.messages, base.messages)
})

test('zero preserves system block order, metadata and explicit or implicit cache TTL', () => {
  const system = [
    { type: 'text', text: 'First rule.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: 'Second rule.', cache_control: { type: 'ephemeral', ttl: '5m' } },
    { type: 'text', text: 'Third rule.', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Last rule.' },
  ]
  const before = structuredClone(system)
  const out = prepareCliHopBody(render(system), { cacheTtl: '1h' })
  assert.deepEqual(out.system.slice(1), before)
  assert.deepEqual(system, before)
  assert.deepEqual(out.messages, [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }])
  validateCacheBreakpoints(out)
})

test('zero normalizes accepted system text shapes without losing text', () => {
  const block = { type: 'text', text: 'Keep this rule.' }
  for (const system of [block, [block], [block.text]]) {
    assert.deepEqual(render(system).system.slice(1), [block])
  }
})

test('zero does not filter caller instructions mentioning client names or official headings', () => {
  const text = [
    'Explain how the Claude Agent SDK uses cc_entrypoint=sdk-cli.',
    '# Doing tasks\nPreserve all instructions.',
    '# Tone and style\nBe concise.',
    '# Environment\nUse the caller-provided environment.',
    '# Text output (does not apply to tool calls)\nReturn JSON.',
  ].join('\n\n')
  assert.equal(render(text).system[1].text, text)
})

test('zero replaces billing lines while retaining adjacent instructions and cache metadata', () => {
  const system = [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=old; cc_entrypoint=cli;' },
    {
      type: 'text',
      text: 'Keep this rule.\r\n  X-Anthropic-Billing-Header: stale;\r\nAnd this rule.\r\n',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    },
  ]
  const before = structuredClone(system)
  const out = render(system, { entrypoint: 'sdk-cli' })
  assert.equal(out.system.length, 2)
  assert.match(out.system[0].text, /cc_entrypoint=sdk-cli/)
  assert.deepEqual(out.system[1], { ...system[1], text: 'Keep this rule.\r\nAnd this rule.\r\n' })
  assert.deepEqual(system, before)
  const repeated = applyCrsUnofficialPersona(out, { ...options, entrypoint: 'sdk-cli' })
  assert.deepEqual(repeated, out)
})

test('zero with no caller instructions stays billing-only', () => {
  for (const system of [undefined, null, '', ' \n ', [], [{ type: 'text', text: '' }]]) {
    const out = render(system)
    assert.equal(out.system.length, 1)
    assert.match(out.system[0].text, /^x-anthropic-billing-header:/)
    assert.deepEqual(out.messages, base.messages)
  }
})

test('saved billing-only zero templates retain caller blocks without a settings migration', (t) => {
  const file = routingFile(t, {
    persona_preset: 'zero',
    overlay_preset: 'official',
    persona_templates: { zero: DEFAULT_PERSONA_TEMPLATES.zero },
  })
  const out = render('Saved settings must not swallow this rule.', { routingFile: file, mode: undefined })
  assert.equal(out.system[1].text, 'Saved settings must not swallow this rule.')
  assert.deepEqual(out.messages, base.messages)
})

test('a zero slot override preserves system even when the global preset is official', (t) => {
  const file = routingFile(t, { persona_preset: 'official' })
  assert.equal(render('Slot-specific rule.', { routingFile: file }).system[1].text, 'Slot-specific rule.')
})

for (const id of ['instructions', 'caller_system']) {
  test(`zero respects an explicit caller_system template placement (${id}) without duplicating it`, (t) => {
    const file = routingFile(t, {
      persona_preset: 'zero',
      persona_templates: {
        zero: [
          ...DEFAULT_PERSONA_TEMPLATES.zero,
          { id, type: 'text', text: 'Configured placement: {{caller_system}}' },
        ],
      },
    })
    const text = 'CUSTOM_CALLER_RULE_8c9f'
    const out = render(text, { routingFile: file })
    assert.equal(JSON.stringify(out).split(text).length - 1, 1)
    if (id === 'instructions') {
      assert.equal(out.system[1].text, `Configured placement: ${text}`)
      assert.deepEqual(out.messages, base.messages)
    } else {
      assert.equal(out.system.length, 1)
      assert.match(JSON.stringify(out.messages), /Configured placement: CUSTOM_CALLER_RULE_8c9f/)
    }
  })
}

const rules = ['CALLER_SYSTEM_RULE_2aa1', 'CALLER_DEVELOPER_RULE_1bf2']
const protocolCases = [
  ['Anthropic string', 'anthropic.messages', { ...base, system: rules[0] }, [rules[0]]],
  ['Anthropic blocks', 'anthropic.messages', { ...base, system: rules.map((text) => ({ type: 'text', text })) }, rules],
  [
    'Chat system and developer',
    'openai.chat',
    {
      ...base,
      messages: [{ role: 'system', content: rules[0] }, { role: 'developer', content: rules[1] }, ...base.messages],
    },
    rules,
  ],
  [
    'Responses instructions',
    'openai.responses',
    { model: base.model, instructions: rules[0], input: 'Hello' },
    [rules[0]],
  ],
  [
    'Responses system',
    'openai.responses',
    { model: base.model, input: [{ role: 'system', content: rules[0] }, ...base.messages] },
    [rules[0]],
  ],
  [
    'Anthropic leading system message',
    'anthropic.messages',
    { ...base, messages: [{ role: 'system', content: rules[0] }, ...base.messages] },
    [rules[0]],
  ],
]

for (const entrypoint of ['cli', 'sdk-cli']) {
  for (const [name, protocol, input, expected] of protocolCases) {
    test(`zero keeps ${name} through conversion, persona and ${entrypoint} hop preparation`, () => {
      const original = structuredClone(input)
      const converted = toClaudeMessages(protocol, input, {
        rewrite: false,
        model_map: false,
        preserve_content_shape: true,
      }).claude
      const rendered = applyCrsUnofficialPersona(converted, { ...options, entrypoint })
      const out = prepareCliHopBody(rendered, { cacheTtl: '1h' })
      const system = out.system.map((block) => block.text).join('\n\n')
      for (const text of expected) {
        assert.ok(system.includes(text), `${text} must reach top-level system`)
        assert.equal(JSON.stringify(out).split(text).length - 1, 1)
      }
      assert.match(out.system[0].text, new RegExp(`cc_entrypoint=${entrypoint}`))
      assert.deepEqual(out.system, rendered.system)
      assert.deepEqual(input, original)
      assert.deepEqual(out.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' })
      validateCacheBreakpoints(out)
    })
  }
}

test('zero preserves both top-level and supported mid-conversation system messages', () => {
  const mid = { role: 'system', content: 'MID_CONVERSATION_RULE_3abc' }
  const input = { ...base, system: rules[0], messages: [...base.messages, mid, { role: 'user', content: 'Continue' }] }
  const out = prepareCliHopBody(applyCrsUnofficialPersona(input, options), { cacheTtl: '1h' })
  assert.equal(out.system[1].text, rules[0])
  assert.ok(out.messages.some((message) => message.role === 'system' && message.content === mid.content))
})

import {
  withM3SchedulerDeps,
  ensureApiSchedulerM3,
  makeStubSchedulerRuntime,
  makeMockGeminiRuntime,
  makeMockCodexRuntimeFor,
  withM3FailoverRunner,
} from '../fixtures/scheduler-runtime-mock.mjs'
