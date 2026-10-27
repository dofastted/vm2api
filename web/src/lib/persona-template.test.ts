import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_STANDING,
  DEFAULT_PERSONA_TEMPLATES,
  EMPTY_BLOCK_TEXT,
  PERSONA_PRESETS,
  PREVIEW_CALLER_AGENT,
  PREVIEW_CALLER_SYSTEM,
  agentStandingVar,
  applyPersonaEnvVars,
  dropLegacyAutoScope,
  overlayDisabledByPersona,
  personaInjectFromPreset,
  presetSeed,
  personaHideEnabled,
  presetFlagEnabled,
  previewModelSentence,
  previewSystemBlocks,
  setPersonaHide,
  setPresetFlag,
  templateSlotState,
  templateOrFollowPreset,
  validatePersonaTemplate,
} from './persona-template'

describe('persona template contract', () => {
  it('forces overlay off only for zero, and empty custom seeds official', () => {
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
    expect(validatePersonaTemplate(DEFAULT_PERSONA_TEMPLATES.zero)).toEqual([])
  })

  it('writes the three persona switches back as their own inject values', () => {
    expect(personaInjectFromPreset('official', 'rewrite')).toBe(
      'official_prompt'
    )
    expect(personaInjectFromPreset('official_full', 'rewrite')).toBe(
      'official_full'
    )
    expect(personaInjectFromPreset('zero', 'rewrite')).toBe('zero')
    expect(personaInjectFromPreset('official_303', 'rewrite')).toBe(
      'official_full'
    )
    expect(personaInjectFromPreset('custom', 'append')).toBe('append')
  })
})

describe('agent standing + system preview', () => {
  const vars = {
    identity: 'ID',
    identity_cli: 'ID',
    reporting: 'REPORTING',
    dynamic_boundary: 'BOUNDARY',
    agent_official: 'AGENT',
    env_official: 'ENV',
    caller_agent: '',
    caller_system: '',
  }

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

  it('keeps env and standing-hide flags default on', () => {
    for (const key of PERSONA_PRESETS) {
      expect(presetFlagEnabled({}, 'persona_env_presets', key)).toBe(true)
      expect(presetFlagEnabled({}, 'agent_standing_hide_presets', key)).toBe(
        true
      )
    }
  })

  it('drops billing blocks and keeps a blank zero agent slot as zero-width', () => {
    const zero = previewSystemBlocks(DEFAULT_PERSONA_TEMPLATES.zero, {
      ...vars,
      agent_standing: '',
    })
    expect(zero.map((block) => block.id)).toEqual([
      'identity_slot',
      'agent_slot',
    ])
    expect(zero[1]?.text).toBe(EMPTY_BLOCK_TEXT)
    expect(zero[1]?.placeholder).toBe(true)

    const officialDefault = previewSystemBlocks(
      DEFAULT_PERSONA_TEMPLATES.official,
      {
        ...vars,
        agent_standing: agentStandingVar({}, 'official'),
        env: '# Environment\n - Timezone: Asia/Tokyo',
      }
    )
    expect(officialDefault.map((block) => block.text)).toEqual([
      'ID',
      '# Environment\n - Timezone: Asia/Tokyo',
    ])

    const officialEnabled = previewSystemBlocks(
      DEFAULT_PERSONA_TEMPLATES.official,
      {
        ...vars,
        agent_standing: agentStandingVar(
          { agent_standing_presets: { official: true } },
          'official'
        ),
        env: '# Environment\n - Timezone: Asia/Tokyo',
      }
    )
    expect(officialEnabled.map((block) => block.text)).toEqual([
      'ID',
      `${DEFAULT_AGENT_STANDING}\n`,
      '# Environment\n - Timezone: Asia/Tokyo',
    ])
  })

  it('keeps a nonempty optional agent slot in the zero preset', () => {
    const blocks = previewSystemBlocks(DEFAULT_PERSONA_TEMPLATES.zero, {
      ...vars,
      agent_standing: 'Stay terse.\n',
    })
    expect(blocks.map((block) => block.id)).toEqual([
      'identity_slot',
      'agent_slot',
    ])
    expect(blocks[1]).toMatchObject({
      text: 'Stay terse.\n',
      placeholder: false,
      ttl: '1h',
      hide: true,
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
    expect(templateSlotState(DEFAULT_PERSONA_TEMPLATES.zero, 'env')).toBe(
      'switch'
    )
    expect(templateSlotState([], 'env')).toBe('absent')
    expect(templateSlotState(DEFAULT_PERSONA_TEMPLATES.official, 'env')).toBe(
      'switch'
    )
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
  it('keeps the model sentence off until the preset switch is enabled', () => {
    const edited = {
      model_env_extra: {
        'claude-sonnet-5-5': 'Sonnet extra.',
        'claude-haiku-5-5': 'Haiku extra.',
      },
    }
    const on = {
      ...edited,
      model_env_extra_presets: { official_303: true },
    }
    const block = (model: string, compat: Record<string, unknown>) =>
      previewSystemBlocks(DEFAULT_PERSONA_TEMPLATES.official_303, {
        model_sentence: previewModelSentence(compat, model, 'official_303'),
      }).find((item) => item.id === 'env_extra')
    expect(block('claude-sonnet-5-5', edited)).toBeUndefined()
    expect(block('claude-sonnet-5-5', on)?.text).toBe('Sonnet extra.')
    expect(block('claude-haiku-5-5', on)?.text).toBe('Haiku extra.')
    expect(block('claude-opus-5-5', on)).toBeUndefined()
  })

  it('omits generated env when the per-preset switch is off', () => {
    const isolated = {
      persona_env_presets: {
        official: true,
        official_full: false,
        zero: false,
        custom: true,
      },
    }
    const tokyo = '# Environment\n - Timezone: Asia/Tokyo'
    expect(
      applyPersonaEnvVars(
        { env_official: 'ENV', timezone: 'UTC' },
        {},
        'official_full'
      )
    ).toEqual({ env_official: 'ENV', timezone: 'UTC' })

    const fullOn = previewSystemBlocks(
      DEFAULT_PERSONA_TEMPLATES.official_full,
      {
        ...vars,
        env_official: 'ENV',
      }
    )
    expect(fullOn.map((block) => block.id)).toEqual([
      'identity',
      'agent_official',
      'env_official',
    ])
    expect(fullOn[1]).toMatchObject({
      text: 'AGENT',
      placeholder: false,
      ttl: '1h',
      scope: '',
    })
    expect(fullOn[2]).toMatchObject({
      text: 'ENV',
      placeholder: false,
      ttl: '1h',
      scope: '',
    })

    const fullOff = previewSystemBlocks(
      DEFAULT_PERSONA_TEMPLATES.official_full,
      applyPersonaEnvVars(
        { ...vars, env_official: 'ENV', timezone: 'Asia/Tokyo' },
        isolated,
        'official_full'
      )
    )
    expect(fullOff.map((block) => block.id)).toEqual([
      'identity',
      'agent_official',
    ])
    expect(
      fullOff.find((block) => block.id === 'agent_official')
    ).toMatchObject({
      placeholder: false,
    })
    expect(fullOff.some((block) => block.id === 'env_official')).toBe(false)

    const selected = previewSystemBlocks(
      [
        ...DEFAULT_PERSONA_TEMPLATES.official_full.filter(
          (block) => block.id !== 'env_official'
        ),
        {
          id: 'env_timezone_only',
          type: 'text',
          text: '{{env_timezone_only}}',
        },
      ],
      { ...vars, env_timezone_only: tokyo }
    )
    expect(selected[selected.length - 1]?.text).toBe(tokyo)
    expect(
      previewSystemBlocks(
        DEFAULT_PERSONA_TEMPLATES.official,
        applyPersonaEnvVars({ ...vars, env: tokyo }, isolated, 'official')
      ).map((block) => block.text)
    ).toEqual(['ID', tokyo])

    expect(
      previewSystemBlocks(
        DEFAULT_PERSONA_TEMPLATES.zero,
        applyPersonaEnvVars(
          { ...vars, agent_standing: '', env: tokyo },
          isolated,
          'zero'
        )
      ).map((block) => block.id)
    ).toEqual(['identity_slot', 'agent_slot'])

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

    expect(
      previewSystemBlocks(
        [
          {
            id: 'tz',
            type: 'text',
            text: '{{env_timezone_only}}',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
          {
            id: 'timezone-scalar',
            type: 'text',
            text: '{{timezone}}',
          },
        ],
        applyPersonaEnvVars(
          { env_timezone_only: tokyo },
          { persona_env_presets: { official: false } },
          'official'
        )
      )
    ).toEqual([])

    expect(
      previewSystemBlocks(
        [{ id: 'line', type: 'text', text: 'tz={{timezone}} cwd={{cwd}}' }],
        applyPersonaEnvVars(
          { timezone: 'UTC', cwd: '/tmp' },
          { persona_env_presets: { custom: false } },
          'custom'
        )
      )[0]?.text
    ).toBe('tz= cwd=/tmp')

    expect(
      applyPersonaEnvVars(
        {
          env: 'E',
          env_official: 'O',
          env_timezone_only: 'T',
          timezone: 'UTC',
          caller_system: PREVIEW_CALLER_SYSTEM,
          caller_agent: PREVIEW_CALLER_AGENT,
        },
        { persona_env_presets: { official: false } },
        'official'
      )
    ).toMatchObject({
      env: '',
      env_official: '',
      env_timezone_only: '',
      timezone: '',
      caller_system: PREVIEW_CALLER_SYSTEM,
      caller_agent: PREVIEW_CALLER_AGENT,
    })
  })

  it('preview keeps builtin 1h cache without scope and retains custom explicit scope', () => {
    const builtin = previewSystemBlocks(
      DEFAULT_PERSONA_TEMPLATES.official_full,
      {
        ...vars,
        env_official: 'ENV',
      }
    )
    expect(
      builtin.find((block) => block.id === 'agent_official')
    ).toMatchObject({
      text: 'AGENT',
      ttl: '1h',
      scope: '',
    })
    const custom = previewSystemBlocks(
      [
        {
          id: 'scoped',
          type: 'text',
          text: 'custom-scoped',
          cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' },
        },
      ],
      vars
    )
    expect(custom).toEqual([
      {
        id: 'scoped',
        text: 'custom-scoped',
        hide: false,
        ttl: '1h',
        scope: 'global',
        placeholder: false,
      },
    ])
  })
  it('toggle map is removed only when values match the field default', () => {
    const off = setPresetFlag({}, 'persona_env_presets', 'zero', false, {})
    expect(off.persona_env_presets).toEqual({
      official: true,
      official_full: true,
      zero: false,
      custom: true,
      official_303: true,
    })
    const back = setPresetFlag(off, 'persona_env_presets', 'zero', true, {})
    expect('persona_env_presets' in back).toBe(false)
    const serverHad = setPresetFlag(off, 'persona_env_presets', 'zero', true, {
      persona_env_presets: { zero: false },
    })
    expect(serverHad.persona_env_presets).toMatchObject({ zero: true })

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
      official_303: false,
    })
    expect(agentStandingVar(standingOn, 'official')).toBe(
      `${DEFAULT_AGENT_STANDING}\n`
    )
    expect(agentStandingVar(standingOn, 'zero')).toBe('')
    const standingOff = setPresetFlag(
      standingOn,
      'agent_standing_presets',
      'official',
      false,
      {}
    )
    expect('agent_standing_presets' in standingOff).toBe(false)

    const serverStanding = setPresetFlag(
      {},
      'agent_standing_presets',
      'official',
      false,
      { agent_standing_presets: { official: true } }
    )
    expect(serverStanding.agent_standing_presets).toEqual({
      official: false,
      official_full: false,
      zero: false,
      custom: false,
      official_303: false,
    })
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
  it('preview drops the old default scope from saved built-in agent blocks only', () => {
    const saved = DEFAULT_PERSONA_TEMPLATES.official_full.map((block) =>
      block.id === 'agent_official'
        ? { ...block, cache_control: legacy }
        : { ...block }
    )
    const blocks = previewSystemBlocks(
      dropLegacyAutoScope('official_full', saved),
      { agent_official: 'AGENT', env_official: 'ENV' }
    )
    expect(blocks.some((block) => block.scope)).toBe(false)
    expect(blocks.find((block) => block.id === 'agent_official')?.ttl).toBe(
      '1h'
    )
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
