/**
 * CRAGGemini (Antigravity CLI / agy 1.5.9) system prompt policy facade.
 *
 * Modes stored in `routing.compatibility.craggemini_persona_preset`:
 * - `official_full` (default): lock official `agy` system prompt intact; append
 *   incoming caller `system` / `systemInstruction` as additional system prompt
 *   inside `libagy_bridge.so` (`Hook::ModelGenerate` -> `ModelRequest.SystemPrompt`).
 * - `zero`: replace `agy`'s official `ModelRequest.SystemPrompt` with incoming
 *   caller `system` / `systemInstruction` (or empty string if none is supplied).
 *
 * Optional `routing.compatibility.craggemini_system_prompt` provides a global
 * system prompt merged before caller system instructions (or used as fallback
 * when the caller sends none).
 *
 * Optional `routing.compatibility.craggemini_prompt_normalization` controls the
 * unified multi-CLI normalization engine (`auto` default | `strict` | `off`).
 */

import {
  CRAGGEMINI_PROMPT_NORMALIZATION_MODES,
  normalizeGeminiOutboundPrompt,
  normalizePromptNormalizationMode,
  normalizeSystemText,
} from './prompt-normalizer.mjs'

export const CRAGGEMINI_PERSONA_PRESETS = ['official_full', 'zero']
export const CRAGGEMINI_SYSTEM_PROMPT_MAX = 32_768
export { CRAGGEMINI_PROMPT_NORMALIZATION_MODES, normalizePromptNormalizationMode }

export function normalizeCragGeminiPersonaPreset(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
  if (raw === 'zero' || raw === '0' || raw === 'replace' || raw === '0-inject') return 'zero'
  return 'official_full'
}

export function resolveCragGeminiPromptPolicy(routing = {}) {
  const compat = routing?.compatibility && typeof routing.compatibility === 'object' ? routing.compatibility : {}
  const preset = normalizeCragGeminiPersonaPreset(compat.craggemini_persona_preset)
  const rawGlobal = typeof compat.craggemini_system_prompt === 'string' ? compat.craggemini_system_prompt.trim() : ''
  const normalization = normalizePromptNormalizationMode(compat.craggemini_prompt_normalization)
  return {
    preset,
    globalPrompt: rawGlobal.slice(0, CRAGGEMINI_SYSTEM_PROMPT_MAX),
    normalization,
  }
}

/**
 * Normalize third-party CLI fingerprint strings and stock dual-use security tool
 * enumerations in outbound CRAGGemini system text while preserving fenced code
 * blocks, underlying safety guidance, and non-conflicting factual references.
 */
export function sanitizeCragGeminiSystemText(text, opts = {}) {
  if (typeof text !== 'string' || !text) return text
  return normalizeSystemText(text, {
    mode: opts.mode ?? 'auto',
    preset: opts.preset ?? 'official_full',
    deconflictHostTags: opts.deconflictHostTags === true,
  })
}

/**
 * Apply CRAGGemini prompt mode, optional global system prompt, and unified CLI
 * prompt normalization to an outbound Gemini-shaped request body destined for
 * the native `antigravity` / CRAGGemini worker.
 */
export function applyCragGeminiPromptPolicy(body, policy = {}, ctx = {}) {
  return normalizeGeminiOutboundPrompt(body, {
    target: 'antigravity',
    policy,
    headers: ctx?.headers,
  }).body
}
