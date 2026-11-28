import { readFileSync } from 'node:fs'
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

  it('never writes conflicting crag_persona_preset when saving unified Claude preset', () => {
    const body = compatibilityPatch(
      { persona_preset: 'official', crag_persona_preset: 'zero' },
      {}
    )
    expect(body.compatibility).toEqual({
      persona_preset: 'official',
      persona_inject: 'official_prompt',
    })
    expect('crag_persona_preset' in body.compatibility).toBe(false)
  })

  it('formats save toast for the active kernel tab (unified Claude vs CRAGGemini)', () => {
    expect(
      systemPromptSaveToast('craggemini', {
        persona_preset: 'official_full',
        craggemini_persona_preset: 'zero',
      })
    ).toBe('已保存 · CRAGGemini · 0提示词')
    const claude = systemPromptSaveToast(
      'claude',
      { persona_preset: 'official_full' },
      { updated: 0 }
    )
    expect(claude).toContain('官方完整提示词')
    expect(claude).not.toContain('跟随全局')
    expect(claude).not.toContain('CRAG v2 print')
  })

  it('removes CRAG v2 print tab and legacy split from SystemPromptPage and VmPersonaEditor', () => {
    const systemPage = readFileSync(
      new URL('./index.tsx', import.meta.url),
      'utf8'
    )
    const vmEditor = readFileSync(
      new URL('../vm/persona-editor.tsx', import.meta.url),
      'utf8'
    )
    expect(systemPage).not.toContain('CRAG v2 print')
    expect(systemPage).not.toContain('CragPrintPanel')
    expect(systemPage).toContain('Claude 系统提示词')
    expect(systemPage).toContain('CRAGGemini')
    expect(vmEditor).not.toContain('CRAG v2 print')
    expect(vmEditor).not.toContain('resolved_crag_print_persona')
  })
})
