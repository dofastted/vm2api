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

  it('never writes conflicting crag_persona_preset when saving Anthropic preset', () => {
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

  it('formats save toast using only Anthropic and Google brand labels without CRAG jargon', () => {
    const googleZero = systemPromptSaveToast('google', {
      persona_preset: 'official_full',
      craggemini_persona_preset: 'zero',
    })
    expect(googleZero).toBe('已保存 · Google · 0注入')
    expect(googleZero).not.toMatch(/crag|antigravity|agy/i)

    const googleOfficial = systemPromptSaveToast('google', {
      craggemini_persona_preset: 'official_full',
    })
    expect(googleOfficial).toBe('已保存 · Google · 官方提示词')

    const anthropicSynced = systemPromptSaveToast(
      'anthropic',
      { persona_preset: 'official_full' },
      { updated: 0 }
    )
    expect(anthropicSynced).toBe(
      '已保存 · Anthropic · 完整官方提示词 · 配置已同步'
    )
    expect(anthropicSynced).not.toMatch(/crag|kernel|跟随全局/i)

    const anthropicHot = systemPromptSaveToast(
      'anthropic',
      { persona_preset: 'official' },
      { updated: 3 }
    )
    expect(anthropicHot).toBe(
      '已保存 · Anthropic · 官方提示词 · 已热更新 3 个槽'
    )
  })

  it('exposes only Anthropic and Google brands on SystemPromptPage with zero CRAG/Antigravity/cli-node copy', () => {
    const systemPage = readFileSync(
      new URL('./index.tsx', import.meta.url),
      'utf8'
    )
    const vmEditor = readFileSync(
      new URL('../vm/persona-editor.tsx', import.meta.url),
      'utf8'
    )
    expect(systemPage).toContain("label: 'Anthropic'")
    expect(systemPage).toContain("label: 'Google'")
    expect(systemPage).not.toContain('CRAG v2 print')
    expect(systemPage).not.toContain('CragPrintPanel')
    expect(systemPage).not.toContain('CRAGGemini')
    expect(systemPage).not.toContain('Antigravity')
    expect(systemPage).not.toContain('cli-node')
    expect(systemPage).not.toContain('wrap/crag')
    expect(vmEditor).not.toContain('CRAG v2 print')
    expect(vmEditor).not.toContain('resolved_crag_print_persona')
  })
})
