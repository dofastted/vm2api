import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERSONA_TEMPLATES,
  stringifyPersonaTemplate,
} from '@/lib/persona-template'
import {
  personaDraftStoresEmpty,
  personaSchemeSummary,
  personaTemplatesPayload,
  seedPersonaDrafts,
} from './persona-drafts'

describe('persona drafts payload', () => {
  it('stores empty arrays when drafts still match built-in presets', () => {
    const drafts = seedPersonaDrafts({
      persona_preset: 'official',
      persona_templates: {},
    })
    expect(personaTemplatesPayload(drafts)).toEqual({
      official: [],
      official_full: [],
      zero: [],
      custom: [],
      official_303: [],
    })
  })

  it('only materializes the scheme that actually changed', () => {
    const drafts = seedPersonaDrafts({ persona_templates: {} })
    drafts.official = stringifyPersonaTemplate([
      { id: 'billing', type: 'text', text: '{{billing}} edited' },
    ])
    const payload = personaTemplatesPayload(drafts)
    expect(payload.official).toEqual([
      { id: 'billing', type: 'text', text: '{{billing}} edited' },
    ])
    expect(payload.official_full).toEqual([])
    expect(payload.zero).toEqual([])
    expect(payload.custom).toEqual([])
  })

  it('keeps per-scheme buckets so switching radio does not drop other drafts', () => {
    const drafts = seedPersonaDrafts({
      persona_templates: {
        zero: DEFAULT_PERSONA_TEMPLATES.zero,
        custom: [{ id: 'only', type: 'text', text: 'keep-me' }],
      },
    })
    expect(drafts.zero).toBe(
      stringifyPersonaTemplate(DEFAULT_PERSONA_TEMPLATES.zero)
    )
    expect(personaTemplatesPayload(drafts).custom).toEqual([
      { id: 'only', type: 'text', text: 'keep-me' },
    ])
    expect(personaTemplatesPayload(drafts).zero).toEqual([])
  })

  it('warns that empty custom still falls back to official', () => {
    const drafts = seedPersonaDrafts({ persona_templates: {} })
    expect(personaDraftStoresEmpty(drafts.custom, 'custom')).toBe(true)
    expect(personaDraftStoresEmpty(drafts.official, 'official')).toBe(true)
    expect(personaSchemeSummary(drafts.custom, 'custom')).toContain('回落官方')
    expect(personaSchemeSummary(drafts.zero, 'zero')).toBe('内置')
  })
})
