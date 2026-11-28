import { PREVIEW_CALLER_SYSTEM } from '@/lib/persona-template'

type Compat = Record<string, unknown>
export type CragGeminiPersona = 'official_full' | 'zero'

export const CRAGGEMINI_SYSTEM_PROMPT_MAX = 32_768

export function cragGeminiPersonaFromCompat(
  compat: Compat | undefined
): CragGeminiPersona {
  return compat?.craggemini_persona_preset === 'zero' ? 'zero' : 'official_full'
}

export function cragGeminiGlobalPromptFromCompat(
  compat: Compat | undefined
): string {
  return typeof compat?.craggemini_system_prompt === 'string'
    ? compat.craggemini_system_prompt
    : ''
}

export function cragGeminiPromptProblem(
  compat: Compat | undefined
): string | null {
  return cragGeminiGlobalPromptFromCompat(compat).length >
    CRAGGEMINI_SYSTEM_PROMPT_MAX
    ? `Google 全局系统提示词超过 ${CRAGGEMINI_SYSTEM_PROMPT_MAX} 字符`
    : null
}

export function buildGoogleRawJsonPayload(
  mode: CragGeminiPersona,
  globalPrompt: string,
  withCaller: boolean
) {
  const trimmedGlobal = globalPrompt.trim()
  return {
    provider: 'google',
    mode,
    system_prompt: {
      official_base:
        mode === 'official_full'
          ? '<Google 官方系统提示词与工作区规则（锁定原样）>'
          : null,
      ...(trimmedGlobal ? { global_prompt: globalPrompt } : {}),
      ...(withCaller ? { caller_system: PREVIEW_CALLER_SYSTEM } : {}),
    },
  }
}
