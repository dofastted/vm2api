import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOutboundProfile } from '../../src/lib/admin/outbound-profile.mjs'
import { validatePersonaRoutingPatch } from '../../src/lib/admin/panel-api.mjs'
import { personaPreviewVars } from '../../src/lib/identity/crs-persona.mjs'

test('outbound reference follows 303 official presets and legacy presets', () => {
  for (const routing of [
    { compatibility: { persona_preset: 'official_303' } },
    { compatibility: { persona_preset: 'official_full' } },
    { compatibility: { persona_preset: 'official' } },
    { compatibility: { persona_inject: 'official_prompt' } },
    {},
  ]) {
    const profile = buildOutboundProfile(routing)
    assert.equal(profile.cli_version, '2.1.303', JSON.stringify(routing))
    assert.match(profile.user_agent, /^claude-cli\/2\.1\.303 \(external, sdk-cli\)$/)
  }
  const legacy = buildOutboundProfile({
    compatibility: { persona_preset: 'zero' },
  })
  assert.equal(legacy.cli_version, '2.1.296')
  assert.equal(legacy.user_agent, 'claude-cli/2.1.296 (external, sdk-cli)')
  assert.match(
    buildOutboundProfile({ compatibility: { persona_preset: 'official_303' } }).anthropic_beta,
    /oauth-2025-04-20/,
  )
  assert.equal(
    buildOutboundProfile({
      compatibility: { persona_inject: 'official_prompt' },
    }).preset,
    'official',
  )
})

test('routing PUT accepts official_303 for the preset, templates and per-preset switches', () => {
  assert.deepEqual(
    validatePersonaRoutingPatch({
      compatibility: {
        persona_preset: 'official_303',
        persona_env_presets: { official_303: true },
        agent_standing_presets: { official_303: false },
        persona_templates: {
          official_303: [
            {
              id: 'main',
              type: 'text',
              text: '{{agent_standing}}{{main_prompt_303}}',
            },
          ],
        },
      },
    }),
    [],
  )
  assert.notDeepEqual(
    validatePersonaRoutingPatch({
      compatibility: { persona_preset: 'official_304' },
    }),
    [],
  )
})

test('preview vars carry the 2.1.303 main prompt and Environment', () => {
  const vars = personaPreviewVars({
    timezone: 'UTC',
    model: 'claude-opus-5-5',
  })
  assert.match(vars.agent_official, /^You are an interactive agent that helps users according to your "Output Style"/)
  assert.doesNotMatch(vars.agent_official, /helps users with software engineering tasks/)
  assert.match(vars.main_prompt_303, /^\nYou are an agent working with the user/)
  assert.match(vars.env_303, /^# Environment\nYou have been invoked in the following environment: /)
})
