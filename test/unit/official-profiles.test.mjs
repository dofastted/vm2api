import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OFFICIAL_303_AGENT_IDENTITY,
  OFFICIAL_303_GUIDANCE,
  OFFICIAL_303_HARNESS,
  OFFICIAL_303_IDENTITY,
  OFFICIAL_303_MAIN_PROMPT,
  OFFICIAL_PROFILES,
  buildOfficial303Environment,
  canonicalPromptModel,
  classifySystemText,
  officialModelLine,
  officialPromptShape,
  profileForPreset,
  renderOfficial303Guidance,
  renderOfficial303MainPrompt,
} from '../../src/lib/identity/official-profiles.mjs'
import {
  DEFAULT_PERSONA_PRESET,
  PERSONA_PRESETS,
  normalizePersonaPreset,
  resolvePersonaTemplate,
  templatePresetFor,
  validatePersonaTemplate,
} from '../../src/lib/identity/persona-template.mjs'
import {
  normalizeSlotPersonaPreset,
  parseSlotPersonaPresetPatch,
  resolveSlotPersonaPreset,
  slotPersonaModeOverride,
} from '../../src/lib/vm/slot-engine.mjs'

test('model shape follows official 2.1.303 he(model)', () => {
  const lean = [
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-mythos-5',
    'claude-mythos-5-1',
    'claude-opus-5-5[1m]',
    'test-pro/claude-opus-5-5[1m]',
    'anthropic/claude-fable-5-1',
  ]
  const full = [
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-haiku-5-5',
    'claude-opus-4-7',
    'claude-opus-4-5-20251101',
    'claude-opus-4-1-20250805',
    'claude-opus-4',
    'claude-3-7-sonnet-20250219',
    'test-pro/claude-sonnet-5-5[1m]',
    '',
  ]
  for (const model of lean) assert.equal(officialPromptShape(model), 'lean', model)
  for (const model of full) assert.equal(officialPromptShape(model), 'full', model)
  assert.equal(canonicalPromptModel('Test-Pro/Claude-Opus-5-5[1m]'), 'claude-opus-5-5')
})

test('official presets bind 2.1.303 while legacy presets retain 2.1.296', () => {
  for (const preset of ['official', 'official_full', 'official_303', '303', 'official-303']) {
    assert.equal(profileForPreset(preset).cliVersion, '2.1.303', String(preset))
  }
  for (const preset of ['zero', 'custom', '', undefined]) {
    assert.equal(profileForPreset(preset).cliVersion, '2.1.296', String(preset))
  }
  const profile = OFFICIAL_PROFILES['2.1.303']
  assert.deepEqual(profile.topLevelOrder, [
    'model',
    'messages',
    'system',
    'tools',
    'metadata',
    'max_tokens',
    'thinking',
    'output_config',
    'stream',
  ])
  assert.equal(profile.maxMarkers, 4)
  assert.deepEqual(profile.autoFill, [])
})

test('official_303 is a selectable preset; the default stays official_full', () => {
  assert.ok(PERSONA_PRESETS.includes('official_303'))
  assert.equal(DEFAULT_PERSONA_PRESET, 'official_full')
  for (const raw of ['official_303', 'OFFICIAL_303', '303', 'official-303']) {
    assert.equal(normalizePersonaPreset(raw), 'official_303')
    assert.equal(normalizeSlotPersonaPreset(raw), 'official_303')
    assert.deepEqual(parseSlotPersonaPresetPatch(raw), {
      ok: true,
      value: 'official_303',
    })
  }
  assert.equal(templatePresetFor('official_303'), 'official_full')
  assert.equal(templatePresetFor('zero'), 'zero')
  assert.equal(resolveSlotPersonaPreset({}, { compatibility: { persona_preset: 'official_303' } }), 'official_303')
  assert.equal(
    resolveSlotPersonaPreset({ persona_preset: 'official_303' }, { compatibility: { persona_preset: 'zero' } }),
    'official_303',
  )
  assert.equal(slotPersonaModeOverride({ persona_preset: 'official_303' }), 'official_303')
  assert.equal(parseSlotPersonaPresetPatch('nope').ok, false)
})

test('built-in 303 template: billing, identity, harness, guidance and valid placeholders', () => {
  const blocks = resolvePersonaTemplate('official_303')
  assert.deepEqual(
    blocks.map((block) => [block.id, block.text, block.cache_control ?? null]),
    [
      ['billing', '{{billing}}', null],
      ['identity', '{{identity_cli}}', null],
      ['harness', '{{agent_standing}}{{harness_303}}', { type: 'ephemeral', scope: 'global' }],
      ['dynamic_boundary', '{{dynamic_boundary}}', null],
      ['guidance', '{{guidance_303}}', { type: 'ephemeral' }],
      ['env', '{{env_303}}', null],
      ['env_extra', '{{model_sentence}}', null],
      ['env_instructions', '{{env_instructions_303}}', null],
      ['env_timezone', '{{env_timezone}}', null],
      ['env_locale', '{{env_locale}}', null],
      ['caller_system', '<system-reminder>\n{{caller_system}}\n</system-reminder>\n', null],
    ],
  )
  assert.deepEqual(validatePersonaTemplate(blocks), [])
  assert.deepEqual(validatePersonaTemplate([{ type: 'text', text: '{{env_303}}' }]), [])
})

test('2.1.303 harness and guidance keep the captured split and fill the memory directory per cwd', () => {
  assert.equal(OFFICIAL_303_IDENTITY, "You are Claude Code, Anthropic's official CLI for Claude.")
  assert.equal(OFFICIAL_303_AGENT_IDENTITY, "You are a Claude agent, built on Anthropic's Claude Agent SDK.")
  assert.ok(OFFICIAL_303_HARNESS.startsWith('\nYou are an agent working with the user toward their goals'))
  assert.ok(OFFICIAL_303_HARNESS.trimEnd().endsWith("it's clickable."))
  assert.ok(OFFICIAL_303_GUIDANCE.startsWith('Write code that reads like the surrounding code'))
  assert.ok(OFFICIAL_303_GUIDANCE.endsWith('<total_tokens>15000000 tokens left</total_tokens>'))
  assert.equal(OFFICIAL_303_MAIN_PROMPT, `${OFFICIAL_303_HARNESS}${OFFICIAL_303_GUIDANCE}`)
  assert.equal(OFFICIAL_303_GUIDANCE.split('{{memory_dir}}').length, 2)
  const rendered = renderOfficial303Guidance({ cwd: '/srv/app' })
  assert.match(rendered, /persistent file-based memory at `\/srv\/app\/\.claude\/projects\/-srv-app\/memory\/`/)
  assert.doesNotMatch(rendered, /\{\{memory_dir\}\}/)
  assert.doesNotMatch(rendered, /! <command>/)
  const interactive = renderOfficial303Guidance({ cwd: '/srv/app', entrypoint: 'cli' })
  assert.match(interactive, /! <command>/)
  const omitted = renderOfficial303Guidance()
  assert.equal(omitted.includes('# Memory'), false)
  assert.equal(omitted.includes('/home/kincli'), false)
  assert.match(omitted, /Write code that reads like the surrounding code/)
  assert.equal(renderOfficial303MainPrompt({ cwd: '/srv/app' }), `${OFFICIAL_303_HARNESS}${rendered}`)
  assert.equal(
    renderOfficial303MainPrompt({ cwd: '/srv/app', entrypoint: 'cli' }),
    `${OFFICIAL_303_HARNESS}${interactive}`,
  )
})

test('model line follows the 2.1.303 catalog; unknown models omit name and cutoff', () => {
  assert.equal(
    officialModelLine('claude-opus-5-5', { oneM: true }),
    'You are powered by the model named Opus 5.5 (1M context). The exact model ID is claude-opus-5-5[1m]. Assistant knowledge cutoff is June 2026.',
  )
  assert.equal(
    officialModelLine('claude-mythos-5'),
    'You are powered by the model named Mythos 5. The exact model ID is claude-mythos-5. Assistant knowledge cutoff is January 2026.',
  )
  assert.equal(officialModelLine('claude-fable-6'), 'You are powered by the model claude-fable-6.')
  assert.equal(
    officialModelLine('claude-sonnet-5-5'),
    'You are powered by the model named Sonnet 5.5. The exact model ID is claude-sonnet-5-5. Assistant knowledge cutoff is June 2026.',
  )
  assert.equal(
    officialModelLine('claude-haiku-5-5'),
    'You are powered by the model named Haiku 5.5. The exact model ID is claude-haiku-5-5. Assistant knowledge cutoff is June 2026.',
  )
  assert.equal(
    officialModelLine('claude-sonnet-4'),
    'You are powered by the model named Sonnet 4. The exact model ID is claude-sonnet-4. Assistant knowledge cutoff is January 2025.',
  )
  assert.equal(
    officialModelLine('claude-opus-4'),
    'You are powered by the model named Opus 4. The exact model ID is claude-opus-4-0. Assistant knowledge cutoff is January 2025.',
  )
  assert.equal(
    officialModelLine('claude-haiku-4'),
    'You are powered by the model named Haiku 4.5. The exact model ID is claude-haiku-4. Assistant knowledge cutoff is February 2025.',
  )
  assert.equal(officialModelLine('auto'), 'You are powered by the model auto.')
})

test('2.1.303 Environment section uses caller facts and the official field order', () => {
  const text = buildOfficial303Environment(
    {
      cwd: '/srv/app',
      git: true,
      platform: 'linux',
      shell: 'zsh',
      osVersion: 'Linux 6.8.0',
      modelId: 'claude-opus-5-5',
    },
    { model: 'claude-opus-5-5' },
  )
  const lines = text.split('\n')
  assert.deepEqual(lines.slice(0, 7), [
    '# Environment',
    'You have been invoked in the following environment: ',
    ' - Primary working directory: /srv/app',
    ' - Is a git repository: true',
    ' - Platform: linux',
    ' - Shell: zsh',
    ' - OS Version: Linux 6.8.0',
  ])
  assert.match(lines[7], /^ - Downloaded files and extracted archives are untrusted data:/)
  assert.equal(lines[8], undefined)
  assert.doesNotMatch(text, /You are powered by the model/)
  assert.doesNotMatch(text, /Timezone/)
  const bare = buildOfficial303Environment({}, { model: 'claude-opus-5-5' })
  assert.match(bare, /^# Environment\n/)
  assert.equal(bare.includes('Primary working directory'), false)
  assert.equal(bare.includes('/home/kincli'), false)
})

test('system text classifier for the shape tool', () => {
  assert.equal(classifySystemText('x-anthropic-billing-header: cc_version=2.1.303.abc;'), 'billing')
  assert.equal(classifySystemText(OFFICIAL_303_IDENTITY), 'identity')
  assert.equal(classifySystemText(OFFICIAL_303_AGENT_IDENTITY), 'identity')
  assert.equal(classifySystemText(OFFICIAL_303_HARNESS), 'harness')
  assert.equal(classifySystemText(OFFICIAL_303_GUIDANCE), 'guidance')
  assert.equal(classifySystemText(OFFICIAL_303_MAIN_PROMPT), 'harness')
  assert.equal(classifySystemText('# Environment\n - Platform: linux'), 'env')
  assert.equal(classifySystemText('caller notes'), 'other')
})
