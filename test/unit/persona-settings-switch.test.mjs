/**
 * Settings page protocol switch → routing.json → unofficial /v1 outbound.
 *
 * Mirrors persistRoutingPatch (merge compatibility, write disk) and the
 * production applyCrsUnofficialPersona({ routingFile }) path. Mode is not
 * passed in — same as server.mjs.
 *
 * Console radios send only: rewrite | official_prompt | overwrite | zero | none.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyCrsUnofficialPersona,
  AGENT_EXPANSION_CACHE_CONTROL,
  CRS_AGENT_EXPANSION,
  CRS_AGENT_PROMPT_MINIMAL,
  CRS_AGENT_PROMPT_REQUIRED,
  CRS_EMPTY_IDENTITY_TEXT,
  CRS_OFFICIAL_AGENT_PROMPT,
  CRS_OFFICIAL_CLI_SYSTEM,
  CRS_OFFICIAL_SYSTEM,
  DEFAULT_CACHE_CONTROL_TTL,
  DEFAULT_PERSONA_MODE,
  normalizePersonaAgent,
  normalizePersonaMode,
  personaOptionsFromRoutingFile,
  wrapMandatoryConstraint,
} from '../../src/lib/identity/crs-persona.mjs'
import { DEFAULT_AGENT_STANDING } from '../../src/lib/identity/persona-template.mjs'

const SETTINGS_RADIOS = Object.freeze(['rewrite', 'official_prompt', 'overwrite', 'zero', 'none'])

const UNOFFICIAL = {
  model: 'claude-sonnet-5-5',
  messages: [{ role: 'user', content: 'hello from settings switch' }],
}

const SLOT = {
  timezone: 'America/Los_Angeles',
  locale: 'en_US.UTF-8',
  fingerprint: { timezone: 'America/Los_Angeles', locale: 'en_US.UTF-8' },
}

function firstUser(out) {
  const content = out.messages?.[0]?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('')
  }
  return content == null ? '' : String(content)
}

function envText(out) {
  return envTextAt(out)
}

function envTextAt(out) {
  const sys = Array.isArray(out.system) ? out.system : []
  const block = sys.find((b) => String(b?.text || '').includes('# Environment'))
  return String(block?.text || '')
}

function persistSettings(file, compatibility) {
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  const next = {
    ...current,
    compatibility: { ...(current.compatibility || {}), ...compatibility },
  }
  fs.writeFileSync(file, JSON.stringify(next, null, 2))
  return personaOptionsFromRoutingFile(file)
}

function applyFromSettings(file, body = UNOFFICIAL, extra = {}) {
  return applyCrsUnofficialPersona(body, {
    officialClient: false,
    routingFile: file,
    identity: SLOT,
    model: body.model,
    ...extra,
  })
}

function withRouting(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-settings-switch-'))
  const file = path.join(dir, 'routing.json')
  try {
    return fn(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('settings radios are the five persisted persona_inject values', () => {
  assert.deepEqual(SETTINGS_RADIOS, ['rewrite', 'official_prompt', 'overwrite', 'zero', 'none'])
  for (const radio of SETTINGS_RADIOS) {
    assert.equal(normalizePersonaMode(radio), radio)
  }
  assert.equal(DEFAULT_PERSONA_MODE, 'rewrite')
})

test('settings save rewrite/official_prompt/overwrite/zero/none hot-reads without passing mode', () => {
  withRouting((file) => {
    persistSettings(file, { persona_inject: 'rewrite', persona_park: true, persona_agent: 'default' })
    const rewrite = applyFromSettings(file)
    assert.equal(rewrite.system.length, 4)
    assert.equal(rewrite.system[0].text, CRS_OFFICIAL_SYSTEM)
    assert.equal(rewrite.system[1].text, CRS_AGENT_EXPANSION)
    assert.deepEqual(rewrite.system[1].cache_control, AGENT_EXPANSION_CACHE_CONTROL)
    assert.ok(!rewrite.system[1].text.includes('# Doing tasks'))
    assert.match(envText(rewrite), /Timezone: America\/Los_Angeles/)
    assert.ok(!envText(rewrite).includes('You have been invoked'))
    assert.ok(!envText(rewrite).includes('# Text output'))
    assert.ok(!envText(rewrite).includes('# auto memory'))
    assert.ok(!envText(rewrite).includes('# Context management'))
    assert.ok(!envText(rewrite).includes('Platform:'))
    assert.ok(!envText(rewrite).includes('OS Version:'))
    assert.match(firstUser(rewrite), /MANDATORY constraints for this turn/)

    persistSettings(file, { persona_inject: 'official_prompt', persona_park: true })
    const official = applyFromSettings(file)
    assert.equal(official.system.length, 4)
    assert.equal(official.system[1].text, CRS_OFFICIAL_CLI_SYSTEM)
    assert.equal(official.system[2].text, CRS_OFFICIAL_AGENT_PROMPT)
    assert.match(official.system[3].text, /^# Environment\n - Timezone: /)
    assert.ok(!official.system.some((b) => String(b?.text || '').includes(DEFAULT_AGENT_STANDING)))
    assert.ok(!official.system.some((b) => b?.text === CRS_AGENT_EXPANSION))
    assert.equal(envTextAt(official), '# Environment\n - Timezone: America/Los_Angeles')
    assert.match(firstUser(official), /MANDATORY constraints for this turn/)

    persistSettings(file, { persona_inject: 'overwrite' })
    const overwrite = applyFromSettings(file)
    assert.equal(overwrite.system[1].text, CRS_OFFICIAL_AGENT_PROMPT)
    assert.ok(overwrite.system[1].text.includes('# Doing tasks'))
    assert.deepEqual(overwrite.system[1].cache_control, { type: 'ephemeral', ttl: DEFAULT_CACHE_CONTROL_TTL })
    assert.match(envText(overwrite), /You have been invoked/)
    assert.match(envText(overwrite), /Timezone: America\/Los_Angeles/)
    assert.match(envText(overwrite), /OS Version: Linux 6\.8\.0-51-generic/)
    assert.match(firstUser(overwrite), /MANDATORY constraints for this turn/)

    persistSettings(file, { persona_inject: 'zero', persona_agent: 'default' })
    const zero = applyFromSettings(file)
    assert.equal(zero.system.length, 4)
    assert.match(zero.system[0].text, /x-anthropic-billing-header:/)
    assert.match(zero.system[0].text, /prompt_version=<You are Claude Code, Anthropic's official CLI for Claude\.>/)
    assert.equal(zero.system[1].text, CRS_EMPTY_IDENTITY_TEXT)
    assert.equal(zero.system[2].text, CRS_EMPTY_IDENTITY_TEXT)
    assert.equal(envTextAt(zero), '# Environment\n - Timezone: America/Los_Angeles')
    assert.ok(!zero.system.some((b) => b?.text === CRS_AGENT_EXPANSION))
    assert.ok(!firstUser(zero).includes('MANDATORY constraints for this turn'))

    persistSettings(file, { persona_inject: 'none' })
    const off = applyFromSettings(file)
    assert.equal(off.system, undefined)
    assert.equal(firstUser(off), UNOFFICIAL.messages[0].content)
    assert.ok(!firstUser(off).includes('MANDATORY constraints'))
  })
})

test('switching back to rewrite restores short expansion after overwrite', () => {
  withRouting((file) => {
    persistSettings(file, { persona_inject: 'overwrite', persona_park: true })
    assert.equal(applyFromSettings(file).system[1].text, CRS_OFFICIAL_AGENT_PROMPT)
    persistSettings(file, { persona_inject: 'rewrite' })
    const back = applyFromSettings(file)
    assert.equal(back.system[1].text, CRS_AGENT_EXPANSION)
    assert.deepEqual(back.system[1].cache_control, AGENT_EXPANSION_CACHE_CONTROL)
    assert.ok(!envText(back).includes('You have been invoked'))
  })
})

test('persona_agent does not change zero; leftover rewrite agent does not flip default config', () => {
  withRouting((file) => {
    persistSettings(file, { persona_inject: 'rewrite', persona_agent: 'rewrite' })
    const def = applyFromSettings(file)
    assert.equal(def.system[1].text, CRS_AGENT_EXPANSION)
    assert.ok(!def.system[1].text.includes('# Doing tasks'))

    persistSettings(file, { persona_inject: 'zero', persona_agent: 'default' })
    const zeroDefault = applyFromSettings(file)
    assert.equal(zeroDefault.system.length, 4)
    assert.match(zeroDefault.system[0].text, /prompt_version=</)
    assert.equal(zeroDefault.system[1].text, CRS_EMPTY_IDENTITY_TEXT)
    assert.equal(zeroDefault.system[2].text, CRS_EMPTY_IDENTITY_TEXT)

    persistSettings(file, { persona_inject: 'zero', persona_agent: 'rewrite' })
    const full = applyFromSettings(file)
    assert.equal(full.system.length, 4)
    assert.ok(!full.system.some((b) => b?.text === CRS_OFFICIAL_AGENT_PROMPT))

    persistSettings(file, { persona_inject: 'zero', persona_agent: 'minimal' })
    const min = applyFromSettings(file)
    assert.equal(min.system.length, 4)
    assert.ok(!min.system.some((b) => b?.text === CRS_AGENT_PROMPT_MINIMAL))

    persistSettings(file, { persona_inject: 'zero', persona_agent: 'required' })
    const req = applyFromSettings(file)
    assert.equal(req.system.length, 4)
    assert.ok(!req.system.some((b) => b?.text === CRS_AGENT_PROMPT_REQUIRED))
  })
})

test('persona_expansion never drops agent+env; official_tools restores 4 blocks', () => {
  withRouting((file) => {
    persistSettings(file, { persona_inject: 'rewrite', persona_expansion: 'never' })
    const two = applyFromSettings(file)
    assert.equal(two.system.length, 2)
    assert.equal(two.system[1].text, CRS_OFFICIAL_SYSTEM)
    assert.ok(!two.system.some((b) => b?.text === CRS_AGENT_EXPANSION))

    persistSettings(file, { persona_expansion: 'official_tools' })
    const four = applyFromSettings(file)
    assert.equal(four.system.length, 4)
    assert.equal(four.system[1].text, CRS_AGENT_EXPANSION)
  })
})

test('persona_park checkbox writes and is hot-read', () => {
  withRouting((file) => {
    persistSettings(file, { persona_inject: 'rewrite', persona_park: false })
    const off = applyFromSettings(file)
    assert.equal(firstUser(off), UNOFFICIAL.messages[0].content)
    persistSettings(file, { persona_park: true })
    assert.match(firstUser(applyFromSettings(file)), /MANDATORY constraints for this turn/)
  })
})

test('official Claude Code inbound is unchanged for every settings radio', () => {
  const official = {
    system: [
      {
        type: 'text',
        text: `x-anthropic-billing-header: cc_version=2.1.241.abc; cc_entrypoint=cli;\n${CRS_OFFICIAL_SYSTEM}`,
      },
    ],
    messages: [{ role: 'user', content: 'hi' }],
    metadata: { user_id: JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: 's' }) },
  }
  const headers = { 'user-agent': 'claude-cli/2.1.241 (external, cli)' }
  withRouting((file) => {
    for (const radio of SETTINGS_RADIOS) {
      persistSettings(file, { persona_inject: radio })
      const out = applyCrsUnofficialPersona(official, { routingFile: file, headers })
      assert.equal(out.system[0].text, official.system[0].text)
      assert.equal(out.system.length, 1)
    }
  })
})

test('console aliases that radios never send: append stays backend append, not rewrite', () => {
  assert.equal(normalizePersonaMode('append'), 'append')
  assert.equal(normalizePersonaMode('add'), 'append')
  assert.equal(normalizePersonaMode('attach'), 'append')
  withRouting((file) => {
    persistSettings(file, { persona_inject: 'append' })
    const out = applyFromSettings(file)
    const sys = out.system
    const text = typeof sys === 'string' ? sys : Array.isArray(sys) ? sys.map((b) => b?.text || '').join('\n') : ''
    assert.ok(text.includes(CRS_OFFICIAL_SYSTEM))
    assert.ok(!Array.isArray(sys) || sys[2]?.text !== CRS_AGENT_EXPANSION)
  })
})

test('zero agent aliases match settings radio values', () => {
  assert.equal(normalizePersonaAgent('default'), 'default')
  assert.equal(normalizePersonaAgent('rewrite'), 'rewrite')
  assert.equal(normalizePersonaAgent('overwrite'), 'rewrite')
  assert.equal(normalizePersonaAgent('minimal'), 'minimal')
  assert.equal(normalizePersonaAgent('required'), 'required')
})

test('official_prompt attaches caller agent and keeps leftover overlay', () => {
  withRouting((file) => {
    persistSettings(file, {
      persona_inject: 'official_prompt',
      persona_park: true,
      agent_standing_presets: { official: true },
    })
    const withAgent = applyFromSettings(file, {
      ...UNOFFICIAL,
      system: [{ type: 'text', text: CRS_OFFICIAL_AGENT_PROMPT }],
    })
    assert.equal(withAgent.system.length, 4)
    assert.equal(withAgent.system[2].text, `${DEFAULT_AGENT_STANDING}\n${CRS_OFFICIAL_AGENT_PROMPT}`)
    assert.deepEqual(withAgent.system[2].cache_control, { type: 'ephemeral', ttl: '1h' })
    assert.match(envTextAt(withAgent), /^# Environment\n - Timezone: /)

    const withLeftover = applyFromSettings(file, {
      ...UNOFFICIAL,
      system: '你是一个高速收费员。',
    })
    assert.equal(withLeftover.system.length, 5)
    assert.ok(!withLeftover.system.some((b) => b?.text === CRS_AGENT_EXPANSION))
    assert.equal(withLeftover.system[4].text, '你是一个高速收费员。')
    assert.ok(!withLeftover.messages.some((message) => message.role === 'system'))
    assert.match(envTextAt(withLeftover), /^# Environment/)
  })
})
