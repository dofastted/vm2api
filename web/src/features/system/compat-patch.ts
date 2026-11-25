import {
  personaInjectFromPreset,
  personaPresetFromCompat,
  protocolPersonaSaveToast,
} from '@/lib/persona-template'
import { cragPersonaFromCompat } from './crag-print-panel'
import { cragGeminiPersonaFromCompat } from './craggemini-panel'

type Compat = Record<string, unknown>
export type SystemPromptKernelSet = 'cli-node' | 'crag' | 'craggemini'

export function systemPromptSaveToast(
  kernelSet: SystemPromptKernelSet,
  compat: Compat | undefined,
  inherited: number,
  kernel?: { updated?: number } | null
): string {
  if (kernelSet === 'craggemini') {
    const label =
      cragGeminiPersonaFromCompat(compat) === 'zero' ? '0提示词' : '官方提示词'
    return `已保存 · CRAGGemini · ${label}`
  }
  if (kernelSet === 'crag') {
    const label =
      cragPersonaFromCompat(compat) === 'zero' ? '0注入' : '官方完整'
    return `已保存 · CRAG v2 print · ${label}`
  }
  return protocolPersonaSaveToast(compat, inherited, kernel)
}

/**
 * 系统提示词页保存体：只发 `compatibility` 里改过的键。PUT /routing 按段合并、
 * compatibility 内再浅合并，整份回写会把别处（设置页、其它标签）改过的值回滚。
 * persona_preset / persona_inject 照旧每次都带，后端据此重推内核人设。
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
  const out: Compat = {}
  for (const [key, value] of Object.entries(full)) {
    if (JSON.stringify(value) !== JSON.stringify(server?.[key]))
      out[key] = value
  }
  out.persona_preset = full.persona_preset
  out.persona_inject = full.persona_inject
  return { compatibility: out }
}
