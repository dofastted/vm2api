import { describe, expect, it } from 'vitest'
import {
  CLI_IDENTITY,
  DEFAULT_AGENT_STANDING,
  DEFAULT_PERSONA_TEMPLATES,
  EMPTY_BLOCK_TEXT,
  PERSONA_PRESETS,
  PREVIEW_CALLER_AGENT,
  PREVIEW_CALLER_SYSTEM,
  agentStandingVar,
  applyPersonaEnvVars,
  canonicalPersonaCompat,
  dropLegacyAutoScope,
  isPresetEnvEnabled,
  isPresetGuidanceEnabled,
  isPresetHarnessEnabled,
  normalizePersonaPreset,
  overlayDisabledByPersona,
  personaHideEnabled,
  personaInjectFromPreset,
  personaPresetFromCompat,
  presetFlagEnabled,
  presetSeed,
  previewBillingVars,
  previewModelSentence,
  previewSystemBlocks,
  selectedPreviewBlocks,
  setPersonaHide,
  setPresetFlag,
  setTemplateBlock,
  templateOrFollowPreset,
  templateSlotState,
  validatePersonaTemplate,
} from './persona-template'

describe('persona template contract', () => {
  it('forces overlay off only for zero, exposes 4 canonical presets, and canonicalizes retired official_303', () => {
    expect(PERSONA_PRESETS).toEqual([
      'official',
      'official_full',
      'zero',
      'custom',
    ])
    expect(normalizePersonaPreset('official_303')).toBe('official_full')
    expect(normalizePersonaPreset('303')).toBe('official_full')
    expect(normalizePersonaPreset('official-303')).toBe('official_full')
    expect(overlayDisabledByPersona('zero')).toBe(true)
    expect(overlayDisabledByPersona('official')).toBe(false)
    expect(presetSeed(DEFAULT_PERSONA_TEMPLATES, 'custom')).toEqual(
      DEFAULT_PERSONA_TEMPLATES.official
    )
    expect(
      templateOrFollowPreset(
        DEFAULT_PERSONA_TEMPLATES.zero,
        DEFAULT_PERSONA_TEMPLATES,
        'zero'
      )
    ).toEqual([])
    for (const preset of PERSONA_PRESETS) {
      expect(
        validatePersonaTemplate(DEFAULT_PERSONA_TEMPLATES[preset])
      ).toEqual([])
    }
    expect(
      validatePersonaTemplate([
        { id: 'bad', role: 'assistant', type: 'text', text: 'x' },
      ])
    ).toEqual(['第 1 块 role 只能是 system（环境注入）'])
  })

  it('canonicalPersonaCompat migrates retired official_303 preset, flags, and templates to official_full', () => {
    const migrated = canonicalPersonaCompat({
      persona_preset: 'official_303',
      persona_env_presets: { official_303: false },
      persona_block_presets: { official_303: { guidance: true } },
      persona_templates: {
        official_303: [{ id: 'custom', type: 'text', text: 'kept' }],
      },
    })
    expect(migrated).toEqual({
      persona_preset: 'official_full',
      persona_env_presets: { official_full: false },
      persona_block_presets: { official_full: { guidance: true } },
      persona_templates: {
        official_full: [{ id: 'custom', type: 'text', text: 'kept' }],
      },
    })
  })

  it('writes the three persona switches back as their own inject values', () => {
    expect(personaInjectFromPreset('official', 'rewrite')).toBe(
      'official_prompt'
    )
    expect(personaInjectFromPreset('official_full', 'rewrite')).toBe(
      'official_full'
    )
    expect(personaInjectFromPreset('zero', 'rewrite')).toBe('zero')
    expect(personaInjectFromPreset('custom', 'append')).toBe('append')
  })

  it('personaPresetFromCompat matches backend SSOT precedence (persona_preset > persona_inject > crag_persona_preset > default)', () => {
    expect(personaPresetFromCompat(undefined)).toBe('official_full')
    expect(personaPresetFromCompat({})).toBe('official_full')
    expect(personaPresetFromCompat({ crag_persona_preset: 'zero' })).toBe(
      'zero'
    )
    expect(personaPresetFromCompat({ crag_persona_preset: 'official' })).toBe(
      'official'
    )
    expect(
      personaPresetFromCompat({
        persona_inject: 'official_prompt',
        crag_persona_preset: 'zero',
      })
    ).toBe('official')
    expect(
      personaPresetFromCompat({
        persona_preset: 'official',
        persona_inject: 'zero',
        crag_persona_preset: 'zero',
      })
    ).toBe('official')
    expect(personaPresetFromCompat({ persona_preset: 'official_303' })).toBe(
      'official_full'
    )
  })
})

describe('Mode 1/2/3 defaults, toggles, and system preview', () => {
  const billingVars = previewBillingVars({}, '2.1.303')
  const vars = {
    ...billingVars,
    identity: CLI_IDENTITY,
    identity_cli: CLI_IDENTITY,
    reporting: 'REPORTING',
    dynamic_boundary: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
    harness_303: 'HARNESS',
    guidance_303: 'GUIDANCE',
    agent_official: 'AGENT',
    env_303: '# Environment\n - Platform: linux',
    env_official: 'ENV',
    env_instructions_303: 'LONG_ENV_INSTRUCTIONS',
    env_timezone: ' - Timezone: Asia/Tokyo',
    env_locale: ' - Language: en-US',
    caller_agent: '',
    caller_system: '',
  }

  it('Mode 1 (official) defaults harness, guidance, env, and all env sub-toggles to OFF and previews only billing + CLI identity', () => {
    expect(isPresetHarnessEnabled({}, 'official')).toBe(false)
    expect(isPresetGuidanceEnabled({}, 'official')).toBe(false)
    expect(isPresetEnvEnabled({}, 'official')).toBe(false)
    expect(presetFlagEnabled({}, 'persona_env_presets', 'official')).toBe(false)
    expect(presetFlagEnabled({}, 'model_env_extra_presets', 'official')).toBe(
      false
    )
    expect(
      presetFlagEnabled({}, 'persona_env_instructions_presets', 'official')
    ).toBe(false)
    expect(presetFlagEnabled({}, 'persona_timezone_presets', 'official')).toBe(
      false
    )
    expect(presetFlagEnabled({}, 'persona_locale_presets', 'official')).toBe(
      false
    )

    const blocks = previewSystemBlocks(
      selectedPreviewBlocks(DEFAULT_PERSONA_TEMPLATES.official, {}, 'official'),
      applyPersonaEnvVars(vars, {}, 'official'),
      { includeBilling: true }
    )
    expect(blocks.map((b) => b.id)).toEqual(['billing', 'identity'])
    expect(blocks[0].text).toBe(billingVars.billing)
    expect(blocks[1].text).toBe(CLI_IDENTITY)
  })

  it('Mode 1 (official) allows toggling harness, guidance, env, and env sub-toggles ON cleanly', () => {
    let compat: Record<string, unknown> = {}
    compat = setTemplateBlock(compat, 'official', 'harness', true, {})
    compat = setTemplateBlock(compat, 'official', 'guidance', true, {})
    compat = setPresetFlag(
      compat,
      'persona_guidance_presets',
      'official',
      true,
      {}
    )
    compat = setPresetFlag(compat, 'persona_env_presets', 'official', true, {})
    compat = setPresetFlag(
      compat,
      'persona_timezone_presets',
      'official',
      true,
      {}
    )
    compat = setPresetFlag(
      compat,
      'persona_locale_presets',
      'official',
      true,
      {}
    )
    compat = setPresetFlag(
      compat,
      'persona_env_instructions_presets',
      'official',
      true,
      {}
    )

    expect(isPresetHarnessEnabled(compat, 'official')).toBe(true)
    expect(isPresetGuidanceEnabled(compat, 'official')).toBe(true)
    expect(isPresetEnvEnabled(compat, 'official')).toBe(true)

    const blocks = previewSystemBlocks(
      selectedPreviewBlocks(
        DEFAULT_PERSONA_TEMPLATES.official,
        compat,
        'official'
      ),
      applyPersonaEnvVars(vars, compat, 'official'),
      { includeBilling: true }
    )
    expect(blocks.map((b) => b.id)).toEqual([
      'billing',
      'identity',
      'harness',
      'guidance',
      'env',
      'env_instructions',
      'env_timezone',
      'env_locale',
    ])
    expect(blocks.find((b) => b.id === 'env')?.role).toBe('system')
  })

  it('Mode 2 (official_full) defaults harness and env ON, guidance OFF, and previews full official CC prompt', () => {
    expect(isPresetHarnessEnabled({}, 'official_full')).toBe(true)
    expect(isPresetEnvEnabled({}, 'official_full')).toBe(true)
    expect(isPresetGuidanceEnabled({}, 'official_full')).toBe(false)

    const blocks = previewSystemBlocks(
      selectedPreviewBlocks(
        DEFAULT_PERSONA_TEMPLATES.official_full,
        {},
        'official_full'
      ),
      applyPersonaEnvVars(vars, {}, 'official_full'),
      { includeBilling: true }
    )
    expect(blocks.map((b) => b.id)).toEqual([
      'billing',
      'identity',
      'harness',
      'env',
    ])
    expect(blocks.find((b) => b.id === 'harness')).toMatchObject({
      text: 'HARNESS',
      scope: 'global',
    })
    expect(blocks.find((b) => b.id === 'env')).toMatchObject({
      text: '# Environment\n - Platform: linux',
      role: 'system',
    })
  })

  it('disabling only the env block keeps master environment and sibling sub-blocks (timezone/locale/extra) enabled', () => {
    const compat = {
      persona_block_presets: { official_full: { env: false } },
      persona_timezone_presets: { official_full: true },
    }
    expect(isPresetEnvEnabled(compat, 'official_full')).toBe(true)
    const blocks = previewSystemBlocks(
      selectedPreviewBlocks(
        DEFAULT_PERSONA_TEMPLATES.official_full,
        compat,
        'official_full'
      ),
      applyPersonaEnvVars(vars, compat, 'official_full'),
      { includeBilling: true }
    )
    expect(blocks.map((b) => b.id)).toEqual([
      'billing',
      'identity',
      'harness',
      'env_timezone',
    ])
    expect(blocks.find((b) => b.id === 'env')).toBeUndefined()
    expect(blocks.find((b) => b.id === 'env_timezone')).toMatchObject({
      text: ' - Timezone: Asia/Tokyo',
      role: 'system',
    })
  })

  it('keeps standing default off while explicit true stays enabled', () => {
    for (const key of PERSONA_PRESETS) {
      expect(presetFlagEnabled({}, 'agent_standing_presets', key)).toBe(false)
      expect(agentStandingVar({}, key)).toBe('')
    }
    expect(
      agentStandingVar(
        { agent_standing_presets: { official: true } },
        'official'
      )
    ).toBe(`${DEFAULT_AGENT_STANDING}\n`)
    expect(
      agentStandingVar({ agent_standing_presets: { official: true } }, 'zero')
    ).toBe('')
    expect(
      agentStandingVar(
        { agent_standing: '', agent_standing_presets: { official: true } },
        'official'
      )
    ).toBe('')
    expect(
      agentStandingVar({ agent_standing_presets: { zero: false } }, 'zero')
    ).toBe('')
  })

  it('keeps env default per-preset (official/zero OFF, official_full/custom ON) and standing-hide default ON', () => {
    expect(presetFlagEnabled({}, 'persona_env_presets', 'official')).toBe(false)
    expect(presetFlagEnabled({}, 'persona_env_presets', 'official_full')).toBe(
      true
    )
    expect(presetFlagEnabled({}, 'persona_env_presets', 'zero')).toBe(false)
    expect(presetFlagEnabled({}, 'persona_env_presets', 'custom')).toBe(true)
    for (const key of PERSONA_PRESETS) {
      expect(presetFlagEnabled({}, 'agent_standing_hide_presets', key)).toBe(
        true
      )
    }
  })

  it('keeps usage passthrough off by default and stores it per preset', () => {
    for (const key of PERSONA_PRESETS)
      expect(presetFlagEnabled({}, 'usage_passthrough_presets', key)).toBe(
        false
      )
    const enabled = setPresetFlag(
      {},
      'usage_passthrough_presets',
      'zero',
      true,
      {}
    )
    expect(enabled.usage_passthrough_presets).toEqual({
      official: false,
      official_full: false,
      zero: true,
      custom: false,
    })
  })

  it('zero with standing on previews standing block without billing vars', () => {
    const blocks = previewSystemBlocks(DEFAULT_PERSONA_TEMPLATES.zero, {
      ...vars,
      billing: '',
      billing_semi: '',
      agent_standing: 'Stay terse.\n',
    })
    expect(blocks.map((block) => block.id)).toEqual(['agent_standing'])
    expect(blocks[0]).toMatchObject({
      text: 'Stay terse.\n',
      placeholder: false,
    })
  })

  it('keeps required blank blocks as zero-width placeholders', () => {
    const blocks = previewSystemBlocks(
      [{ id: 'agent_slot', type: 'text', text: '{{agent_standing}}' }],
      { agent_standing: '' }
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      id: 'agent_slot',
      text: EMPTY_BLOCK_TEXT,
      placeholder: true,
    })
  })

  it('reports whether a template can switch standing / env', () => {
    const full = DEFAULT_PERSONA_TEMPLATES.official_full
    expect(templateSlotState(full, 'agent_standing')).toBe('switch')
    expect(templateSlotState(full, 'env')).toBe('switch')
    expect(templateSlotState(DEFAULT_PERSONA_TEMPLATES.official, 'env')).toBe(
      'switch'
    )
    expect(templateSlotState(DEFAULT_PERSONA_TEMPLATES.zero, 'env')).toBe(
      'absent'
    )
    expect(templateSlotState([], 'env')).toBe('absent')
    expect(
      templateSlotState(
        [{ type: 'text', text: '{{env_timezone_only}}' }],
        'env'
      )
    ).toBe('switch')
    expect(
      templateSlotState([{ type: 'text', text: '{{timezone}}' }], 'env')
    ).toBe('switch')
    expect(
      templateSlotState(
        [{ type: 'text', text: '# Environment\n - Timezone: UTC' }],
        'env'
      )
    ).toBe('absent')
  })

  it('keeps the model sentence off until both env and model_env_extra_presets are enabled', () => {
    const edited = {
      model_env_extra: {
        'claude-sonnet-5-5': 'Sonnet extra.',
        'claude-haiku-5-5': 'Haiku extra.',
      },
    }
    const on = {
      ...edited,
      model_env_extra_presets: { official_full: true },
    }
    const block = (model: string, compat: Record<string, unknown>) =>
      previewSystemBlocks(DEFAULT_PERSONA_TEMPLATES.official_full, {
        model_sentence: previewModelSentence(compat, model, 'official_full'),
      }).find((item) => item.id === 'env_extra')
    expect(block('claude-sonnet-5-5', edited)).toBeUndefined()
    expect(block('claude-sonnet-5-5', on)?.text).toBe('Sonnet extra.')
    expect(block('claude-haiku-5-5', on)?.text).toBe('Haiku extra.')
    expect(block('claude-opus-5-5', on)).toBeUndefined()
  })

  it('omits generated env when the per-preset switch is off while keeping literal env blocks', () => {
    expect(
      applyPersonaEnvVars(
        {
          env: 'E',
          env_official: 'O',
          env_303: 'E303',
          env_timezone_only: 'T',
          timezone: 'UTC',
          caller_system: PREVIEW_CALLER_SYSTEM,
          caller_agent: PREVIEW_CALLER_AGENT,
        },
        {},
        'official'
      )
    ).toMatchObject({
      env: '',
      env_official: '',
      env_303: '',
      env_timezone_only: '',
      timezone: '',
      caller_system: PREVIEW_CALLER_SYSTEM,
      caller_agent: PREVIEW_CALLER_AGENT,
    })

    const literal = previewSystemBlocks(
      [
        {
          id: 'authored',
          type: 'text',
          text: '# Environment\n - Timezone: Europe/Paris',
        },
      ],
      applyPersonaEnvVars(
        { env: 'GENERATED', timezone: 'UTC' },
        { persona_env_presets: { custom: false } },
        'custom'
      )
    )
    expect(literal).toHaveLength(1)
    expect(literal[0].text).toBe('# Environment\n - Timezone: Europe/Paris')

    const mixed = previewSystemBlocks(
      [
        {
          id: 'mix',
          type: 'text',
          text: '# Environment\n{{env_official}}',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      applyPersonaEnvVars(
        { env_official: 'ENV' },
        { persona_env_presets: { custom: false } },
        'custom'
      )
    )
    expect(mixed).toHaveLength(1)
    expect(mixed[0]).toMatchObject({
      text: '# Environment\n',
      placeholder: false,
      ttl: '1h',
    })
  })

  it('toggle map is removed only when values match each preset field default', () => {
    const off = setPresetFlag(
      {},
      'persona_env_presets',
      'official_full',
      false,
      {}
    )
    expect(off.persona_env_presets).toEqual({
      official: false,
      official_full: false,
      zero: false,
      custom: true,
    })
    const back = setPresetFlag(
      off,
      'persona_env_presets',
      'official_full',
      true,
      {}
    )
    expect('persona_env_presets' in back).toBe(false)
    const serverHad = setPresetFlag(
      off,
      'persona_env_presets',
      'official_full',
      true,
      { persona_env_presets: { official_full: false } }
    )
    expect(serverHad.persona_env_presets).toMatchObject({
      official_full: true,
    })

    const standingOn = setPresetFlag(
      {},
      'agent_standing_presets',
      'official',
      true,
      {}
    )
    expect(standingOn.agent_standing_presets).toEqual({
      official: true,
      official_full: false,
      zero: false,
      custom: false,
    })
    const standingOff = setPresetFlag(
      standingOn,
      'agent_standing_presets',
      'official',
      false,
      {}
    )
    expect('agent_standing_presets' in standingOff).toBe(false)
  })

  it('whole-preset mask: map beats legacy persona_hides beats template hide', () => {
    const zero = DEFAULT_PERSONA_TEMPLATES.zero
    const official = DEFAULT_PERSONA_TEMPLATES.official
    expect(personaHideEnabled({}, 'zero', zero)).toBe(true)
    expect(personaHideEnabled({}, 'official', official)).toBe(false)
    expect(
      personaHideEnabled({ persona_hides: true }, 'official', official)
    ).toBe(true)
    expect(
      personaHideEnabled(
        { persona_hides: true, persona_hide_presets: { official: false } },
        'official',
        official
      )
    ).toBe(false)
    const off = setPersonaHide({}, 'zero', false, zero, {})
    expect(off.persona_hide_presets).toEqual({ zero: false })
    expect(
      'persona_hide_presets' in setPersonaHide(off, 'zero', true, zero, {})
    ).toBe(false)
  })
})

describe('legacy global cache scope', () => {
  const legacy = { type: 'ephemeral', ttl: '1h', scope: 'global' }
  it('preview drops the old default scope from a saved pre-303 agent block only', () => {
    const saved = [
      ...DEFAULT_PERSONA_TEMPLATES.official_full,
      {
        id: 'agent_official',
        type: 'text',
        text: '{{agent_official}}',
        cache_control: legacy,
      },
    ]
    const blocks = previewSystemBlocks(
      dropLegacyAutoScope('official_full', saved),
      {
        identity_cli: CLI_IDENTITY,
        harness_303: 'H',
        agent_official: 'AGENT',
      }
    )
    expect(blocks[blocks.length - 1]).toMatchObject({
      id: 'agent_official',
      ttl: '1h',
      scope: '',
    })
    expect(blocks.find((block) => block.id === 'harness')?.scope).toBe('global')
  })

  it('keeps custom presets and other explicit scopes', () => {
    const custom = [
      { id: 'agent', type: 'text', text: 'x', cache_control: legacy },
    ]
    expect(dropLegacyAutoScope('custom', custom)).toEqual(custom)
    const explicit = [
      {
        id: 'agent_official',
        type: 'text',
        text: 'x',
        cache_control: { type: 'ephemeral', ttl: '5m', scope: 'global' },
      },
    ]
    expect(dropLegacyAutoScope('official_full', explicit)).toEqual(explicit)
  })
})
