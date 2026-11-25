import { describe, expect, it } from 'vitest'
import { compatibilityPatch, systemPromptSaveToast } from './compat-patch'

describe('system prompt save body', () => {
  it('sends only compatibility, never other routing sections', () => {
    const body = compatibilityPatch({ persona_preset: 'zero' }, {})
    expect(Object.keys(body)).toEqual(['compatibility'])
  })

  it('leaves untouched compatibility keys out so other pages are not rolled back', () => {
    const server = {
      persona_preset: 'zero',
      persona_inject: 'zero',
      cache_ttl: '1h',
      persona_templates: { a: 1 },
    }
    const body = compatibilityPatch(
      { ...server, persona_templates: { a: 2 } },
      server
    )
    expect(body.compatibility).toEqual({
      persona_templates: { a: 2 },
      persona_preset: 'zero',
      persona_inject: 'zero',
    })
  })

  it('formats save toast for the active kernel tab instead of always reporting cli-node preset', () => {
    expect(
      systemPromptSaveToast(
        'craggemini',
        { persona_preset: 'official_full', craggemini_persona_preset: 'zero' },
        0
      )
    ).toBe('已保存 · CRAGGemini · 0提示词')
    expect(
      systemPromptSaveToast(
        'crag',
        { persona_preset: 'official_full', crag_persona_preset: 'zero' },
        0
      )
    ).toBe('已保存 · CRAG v2 print · 0注入')
    expect(
      systemPromptSaveToast(
        'cli-node',
        { persona_preset: 'official_full' },
        0,
        { updated: 0 }
      )
    ).toContain('官方完整提示词')
  })
})
