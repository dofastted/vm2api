import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERSONA_TEMPLATES,
  PERSONA_PRESET_OPTIONS,
  PERSONA_PRESETS,
  overlayDisabledByPersona,
  presetSeed,
  templateOrFollowPreset,
  validatePersonaTemplate,
} from './persona-template'

describe('persona template contract', () => {
  it('keeps the four routing presets in PUT order', () => {
    expect([...PERSONA_PRESETS]).toEqual([
      'official',
      'official_full',
      'zero',
      'custom',
    ])
    expect(PERSONA_PRESET_OPTIONS.map(([value]) => value)).toEqual([
      ...PERSONA_PRESETS,
    ])
  })

  it('keeps official / official_full / zero slot ids and hide defaults', () => {
    expect(DEFAULT_PERSONA_TEMPLATES.official.map((block) => block.id)).toEqual(
      ['billing', 'identity', 'caller_agent', 'caller_system']
    )
    expect(
      DEFAULT_PERSONA_TEMPLATES.official_full.map((block) => block.id)
    ).toEqual([
      'billing',
      'identity',
      'agent_official',
      'env_official',
      'caller_system',
    ])
    expect(DEFAULT_PERSONA_TEMPLATES.zero.map((block) => block.id)).toEqual([
      'billing_zero',
      'identity_slot',
      'agent_slot',
      'caller_system',
    ])
    expect(DEFAULT_PERSONA_TEMPLATES.official.some((block) => block.hide)).toBe(
      false
    )
    expect(
      DEFAULT_PERSONA_TEMPLATES.official_full.some((block) => block.hide)
    ).toBe(false)
    expect(
      DEFAULT_PERSONA_TEMPLATES.zero.map((block) => block.hide === true)
    ).toEqual([true, true, true, false])
    expect(DEFAULT_PERSONA_TEMPLATES.zero[2]?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '5m',
    })
    expect(DEFAULT_PERSONA_TEMPLATES.custom).toEqual([])
  })

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
})
