import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyCrsUnofficialPersona, stripSubagentBilling } from '../../src/lib/identity/crs-persona.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'

test('a literal after the billing header line keeps cc_is_subagent', () => {
  const note = '\nDocument the field cc_is_subagent=true; do not send it.'
  const body = {
    system: [
      { type: 'text', text: `x-anthropic-billing-header: cc_version=2.1.303.abc; cc_is_subagent=true;${note}` },
      { type: 'text', text: `later block cc_is_subagent=true;${note}` },
    ],
  }
  const out = stripSubagentBilling(body)
  assert.equal(out.system[0].text.startsWith('x-anthropic-billing-header: cc_version=2.1.303.abc;'), true)
  assert.equal(out.system[0].text.split('\n')[0].includes('cc_is_subagent'), false)
  assert.equal(out.system[0].text.endsWith(note), true)
  assert.equal(out.system[1].text, body.system[1].text)
  assert.equal(body.system[0].text.includes('cc_is_subagent=true;'), true)
})
test('official_full Environment adds only the editable extra for the current model', () => {
  // e358143c moved env_extra into the role=system Environment; the live persona path renders it there.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-303-extra-'))
  const file = path.join(dir, 'routing.json')
  const environment = (model, compat = {}) => {
    fs.writeFileSync(
      file,
      JSON.stringify({ compatibility: { persona_preset: 'official_full', overlay_preset: 'off', ...compat } }),
    )
    const out = applyCrsUnofficialPersona({ model, messages: [{ role: 'user', content: 'hi' }] }, { routingFile: file })
    assert.equal(
      out.system.some((block) => /Sonnet extra\.|Haiku extra\./.test(String(block.text))),
      false,
    )
    return out.messages
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content))
      .join('\n')
  }
  try {
    const empty = environment('claude-opus-5-5')
    assert.match(empty, /^# Environment/)
    assert.equal(empty.includes('Sonnet extra.'), false)
    assert.equal(empty.includes('Haiku extra.'), false)
    const compat = {
      model_env_extra_presets: { official_full: true },
      model_env_extra: {
        'claude-sonnet-5-5': 'Sonnet extra.',
        'claude-haiku-5-5': 'Haiku extra.',
      },
    }
    assert.equal(
      environment('claude-sonnet-5-5', { model_env_extra: compat.model_env_extra }).includes('Sonnet extra.'),
      false,
    )
    const sonnet = environment('claude-sonnet-5-5', compat)
    const haiku = environment('claude-haiku-5-5', compat)
    assert.equal(sonnet.includes('Sonnet extra.'), true)
    assert.equal(sonnet.includes('Haiku extra.'), false)
    assert.equal(haiku.includes('Haiku extra.'), true)
    assert.equal(haiku.includes('Sonnet extra.'), false)
    // Saved official_303 switches are canonicalized onto official_full.
    assert.equal(
      environment('claude-sonnet-5-5', { ...compat, model_env_extra_presets: { official_303: true } }).includes(
        'Sonnet extra.',
      ),
      true,
    )
    const cleared = environment('claude-sonnet-5-5', {
      ...compat,
      persona_block_presets: { official_full: { env_extra: false } },
    })
    assert.equal(cleared.includes('Sonnet extra.'), false)
    assert.equal(cleared.includes('Haiku extra.'), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('kernel.json cli_version follows the slot profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-303-cfg-'))
  const read = (vm, routing) =>
    JSON.parse(fs.readFileSync(writeKernelConfig(root, vm, { token: 't', routing }).configPath, 'utf8'))
  try {
    assert.equal(read({ id: 'vm-01' }, { compatibility: { persona_preset: 'official_303' } }).cli_version, '2.1.321')
    assert.equal(read({ id: 'vm-02' }, { compatibility: { persona_preset: 'official_full' } }).cli_version, '2.1.321')
    assert.equal(read({ id: 'vm-03' }, {}).cli_version, '2.1.321')
    assert.equal(
      read({ id: 'vm-04', persona_preset: 'official_303' }, { compatibility: { persona_preset: 'zero' } }).cli_version,
      '2.1.321',
    )
    const slot = read({ id: 'vm-05', persona_preset: 'official_303' }, {})
    assert.equal(slot.persona_preset, 'official_303')
    assert.equal(slot.system_layout, 'identity')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
