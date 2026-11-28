import {
  personaInjectFromPreset,
  personaPresetFromCompat,
} from '@/lib/persona-template'
import { cragGeminiPersonaFromCompat } from './google-prompt'
import { anthropicPresetLabel } from './prompt-presentation'

type Compat = Record<string, unknown>
export type SystemPromptBrand = 'anthropic' | 'google'

export function systemPromptSaveToast(
  brand: SystemPromptBrand,
  compat: Compat | undefined,
  sync?: { updated?: number } | null
): string {
  if (brand === 'google') {
    const label =
      cragGeminiPersonaFromCompat(compat) === 'zero' ? '0注入' : '官方提示词'
    return `已保存 · Google · ${label}`
  }
  const label = anthropicPresetLabel(personaPresetFromCompat(compat))
  if (sync && typeof sync.updated === 'number') {
    const detail =
      sync.updated > 0 ? `已热更新 ${sync.updated} 个槽` : '配置已同步'
    return `已保存 · Anthropic · ${label} · ${detail}`
  }
  return `已保存 · Anthropic · ${label}`
}

/**
 * 系统提示词页保存体：只发 `compatibility` 里改过的键。PUT /routing 按段合并、
 * compatibility 内再浅合并，整份回写会把别处（设置页、其它标签）改过的值回滚。
 * persona_preset / persona_inject 照旧每次都带，后端据此统一同步到各运行节点。
 */
export function compatibilityPatch(
  draft: Compat,
  server: Compat | undefined
): { compatibility: Compat } {
  const preset = personaPresetFromCompat(draft)
  const full: Compat = {
    ...draft,
    persona_preset: preset,
    persona_inject: personaInjectFromPreset(preset, draft.persona_inject),
  }
  delete full.crag_persona_preset
  const out: Compat = {}
  for (const [key, value] of Object.entries(full)) {
    if (JSON.stringify(value) !== JSON.stringify(server?.[key]))
      out[key] = value
  }
  out.persona_preset = full.persona_preset
  out.persona_inject = full.persona_inject
  return { compatibility: out }
}
