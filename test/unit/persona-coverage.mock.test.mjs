import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  CRS_OFFICIAL_AGENT_PROMPT,
  CRS_OFFICIAL_CLI_SYSTEM,
  applyCrsUnofficialPersona,
} from '../../src/lib/identity/crs-persona.mjs'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import { detectInboundPlatform } from '../../src/lib/protocol/platform-detect.mjs'

const HI = 'coverage-user-hi'

function withRouting(compat, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-persona-coverage-'))
  const file = path.join(dir, 'routing.json')
  fs.writeFileSync(file, JSON.stringify({ compatibility: compat }))
  try {
    fn(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function texts(body) {
  return (Array.isArray(body.system) ? body.system : []).map((block) => String(block?.text || ''))
}

function userText(body) {
  return JSON.stringify(body.messages || [])
}

function assertOfficial(body, { caller = '' } = {}) {
  const blocks = texts(body)
  assert.match(blocks[0], /^x-anthropic-billing-header: /)
  assert.equal(blocks[1], CRS_OFFICIAL_CLI_SYSTEM)
  assert.ok(blocks[2].includes(CRS_OFFICIAL_AGENT_PROMPT.slice(0, 48)))
  assert.match(blocks[3], /^# Environment\n/)
  if (caller) assert.equal(blocks.at(-1), caller)
  else assert.equal(blocks.length, 4)
  assert.match(userText(body), new RegExp(HI))
}

function assertZero(body, { caller = '' } = {}) {
  const blocks = texts(body)
  assert.match(blocks[0], /x-anthropic-billing-header:/)
  assert.match(blocks[0], /prompt_version=<You are Claude Code, Anthropic's official CLI for Claude\.>/)
  assert.equal(blocks[1], '\u200b')
  assert.equal(blocks[2], '\u200b')
  assert.match(blocks[3], /^# Environment\n/)
  assert.ok(!blocks.some((text) => text.includes(CRS_OFFICIAL_AGENT_PROMPT.slice(0, 48))))
  if (caller) assert.equal(blocks.at(-1), caller)
  assert.match(userText(body), new RegExp(HI))
}

const SHAPES = [
  ['no system field', { messages: [{ role: 'user', content: HI }] }],
  ['empty string system', { system: '', messages: [{ role: 'user', content: HI }] }],
  ['empty array system', { system: [], messages: [{ role: 'user', content: HI }] }],
  ['blank text block', { system: [{ type: 'text', text: '   ' }], messages: [{ role: 'user', content: HI }] }],
  ['caller leftover', { system: 'keep-this-caller', messages: [{ role: 'user', content: HI }] }],
]

test('official preset appends the configured prompt on every empty-system shape', () => {
  withRouting({ persona_preset: 'official', overlay_preset: 'off' }, (file) => {
    for (const [name, body] of SHAPES) {
      const out = applyCrsUnofficialPersona(structuredClone(body), { routingFile: file })
      assertOfficial(out, { caller: name === 'caller leftover' ? 'keep-this-caller' : '' })
    }
  })
})

test('official-looking traffic still gets the configured prompt when force-configured', () => {
  withRouting({ persona_preset: 'official', overlay_preset: 'off' }, (file) => {
    const headers = { 'user-agent': 'claude-cli/2.1.293 (external, cli)' }
    const body = {
      model: 'claude-sonnet-5-5',
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.280.096; cc_entrypoint=cli; cch=bdff0;' },
      ],
      messages: [{ role: 'user', content: HI }],
      metadata: { user_id: JSON.stringify({ device_id: 'dev-1', account_uuid: 'acc-1', session_id: 'sess-1' }) },
    }
    const skipped = applyCrsUnofficialPersona(structuredClone(body), { routingFile: file, headers })
    assert.match(skipped.system[0].text, /cc_entrypoint=cli/)
    const out = applyCrsUnofficialPersona(structuredClone(body), {
      routingFile: file,
      headers,
      officialClient: false,
      forceConfigured: true,
    })
    assertOfficial(out)
  })
})

test('zero preset stays zero-inject and does not grow the official prompt', () => {
  withRouting({ persona_preset: 'zero', overlay_preset: 'off' }, (file) => {
    for (const [name, body] of SHAPES) {
      const out = applyCrsUnofficialPersona(structuredClone(body), { routingFile: file })
      assertZero(out, { caller: name === 'caller leftover' ? 'keep-this-caller' : '' })
    }
  })
})

test('openai chat keeps its user text and tools while the Claude body gets the configured prompt', () => {
  withRouting({ persona_preset: 'official', overlay_preset: 'off' }, (file) => {
    const inbound = {
      model: 'claude-sonnet-5-5',
      messages: [
        { role: 'system', content: 'you are a linter' },
        { role: 'user', content: HI },
      ],
      tools: [{ type: 'function', function: { name: 'lint_file', parameters: { type: 'object' } } }],
    }
    const { claude } = toClaudeMessages('openai.chat', inbound)
    const out = applyCrsUnofficialPersona(claude, { routingFile: file })
    assertOfficial(out, { caller: 'you are a linter' })
    assert.equal(out.tools[0].name, 'lint_file')
    assert.equal(out.model, 'claude-sonnet-5-5')
  })
})

test('openai platform requests are not given the Claude system prompt', () => {
  const inbound = {
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: HI }],
  }
  const detected = detectInboundPlatform(inbound.model)
  assert.equal(detected.platform, 'openai')
  const untouched = structuredClone(inbound)
  assert.equal(untouched.system, undefined)
  assert.equal(untouched.messages[0].content, HI)
  assert.equal(untouched.model, 'gpt-5.5')
})
