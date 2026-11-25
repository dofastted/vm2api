/**
 * CRAGGemini (Antigravity CLI / agy 1.5.9) system prompt policy.
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
 */

import { stripIllegalControlChars } from '../protocol/gemini-convert.mjs'

export const CRAGGEMINI_PERSONA_PRESETS = ['official_full', 'zero']
export const CRAGGEMINI_SYSTEM_PROMPT_MAX = 32_768

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
  return {
    preset,
    globalPrompt: rawGlobal.slice(0, CRAGGEMINI_SYSTEM_PROMPT_MAX),
  }
}

const CONFLICTING_CLI_IDENTITY_RE = /\bYou\s+are\s+(?:Claude\s+Code|OpenCode)\b/gi

/**
 * Normalize third-party CLI identity declarations in outbound CRAGGemini
 * `systemInstruction` (e.g. `You are Claude Code` / `You are OpenCode`) that
 * conflict with the target Gemini runtime and cause Google Antigravity upstream
 * to reject healthy accounts with HTTP 429 RESOURCE_EXHAUSTED.
 */
export function sanitizeCragGeminiSystemText(text) {
  if (typeof text !== 'string' || !text) return text
  return text.replace(CONFLICTING_CLI_IDENTITY_RE, 'You are a coding assistant')
}

function sanitizeSystemInstruction(systemInstruction) {
  if (!systemInstruction) return systemInstruction
  if (typeof systemInstruction === 'string') {
    return sanitizeCragGeminiSystemText(systemInstruction)
  }
  if (typeof systemInstruction === 'object' && Array.isArray(systemInstruction.parts)) {
    let changed = false
    const nextParts = systemInstruction.parts.map((part) => {
      if (part && typeof part.text === 'string') {
        const sanitized = sanitizeCragGeminiSystemText(part.text)
        if (sanitized !== part.text) {
          changed = true
          return { ...part, text: sanitized }
        }
      }
      return part
    })
    return changed ? { ...systemInstruction, parts: nextParts } : systemInstruction
  }
  return systemInstruction
}

function extractSystemText(systemInstruction) {
  if (!systemInstruction) return ''
  if (typeof systemInstruction === 'string') return systemInstruction.trim()
  if (typeof systemInstruction === 'object' && Array.isArray(systemInstruction.parts)) {
    return systemInstruction.parts
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return ''
}

/**
 * Apply CRAGGemini prompt mode & optional global system prompt to an outbound
 * Gemini-shaped request body destined for the native `antigravity` / CRAGGemini worker.
 */
export function applyCragGeminiPromptPolicy(body, policy = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const preset = normalizeCragGeminiPersonaPreset(policy?.preset)
  const globalPrompt =
    typeof policy?.globalPrompt === 'string' ? stripIllegalControlChars(policy.globalPrompt).trim() : ''
  const out = { ...body }

  if (globalPrompt) {
    const existing = extractSystemText(out.systemInstruction)
    const merged = existing ? `${globalPrompt}\n\n${existing}` : globalPrompt
    out.systemInstruction = { parts: [{ text: sanitizeCragGeminiSystemText(merged) }] }
  } else if (out.systemInstruction != null) {
    out.systemInstruction = sanitizeSystemInstruction(out.systemInstruction)
  }

  out.system_prompt_mode = preset
  return out
}
