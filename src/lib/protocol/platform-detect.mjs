/**
 * Inbound platform from model id. Unknown models fail closed.
 * GPT = /^gpt/i minus SKIP_GPT. Claude = claude-* family. Gemini = Antigravity (no other pool serves it).
 * An `antigravity` key group sends every model to Antigravity, including IDs a Claude/GPT pool also
 * serves (`claude-opus-5-5`); other groups keep those IDs on their own platform.
 */
import { SKIP_GPT, isGptSeriesId } from './gpt-ids.mjs'
import { antigravityModelId } from './antigravity-route.mjs'

// Retired namespace: never let the last path segment send it to the Claude/GPT pool.
export function isRetiredAntigravityId(model) {
  return /(?:^|\/)antigravity(?:\/|$)/i.test(String(model || '').trim())
}

export function detectInboundPlatform(model, { groupType } = {}) {
  const raw = String(model || '').trim()
  if (!raw) {
    return {
      ok: false,
      code: 'model_required',
      message: 'model is required',
    }
  }
  if (isRetiredAntigravityId(raw)) {
    return {
      ok: false,
      code: 'model_not_supported',
      message: `model '${raw}' uses the retired antigravity/ prefix; request the official ID, e.g. gemini-4-argon`,
    }
  }
  if (groupType === 'antigravity' || /^gemini-/i.test(raw)) {
    const id = antigravityModelId(raw)
    if (!id)
      return { ok: false, code: 'model_not_supported', message: `model '${raw}' is not a valid Antigravity model` }
    return { ok: true, platform: 'antigravity', model: id }
  }
  const id = raw.split('/').filter(Boolean).pop() || raw
  const lower = id.toLowerCase()
  if (SKIP_GPT.test(lower)) {
    return {
      ok: false,
      code: 'model_not_supported',
      message: `model '${raw}' is not a GPT chat model`,
    }
  }
  if (isGptSeriesId(id)) return { ok: true, platform: 'openai', model: id }
  if (
    lower.startsWith('claude-') ||
    lower.startsWith('anthropic.claude-') ||
    /^(sonnet|opus|haiku|fable)(-|$)/i.test(lower)
  ) {
    return { ok: true, platform: 'anthropic', model: id }
  }
  return {
    ok: false,
    code: 'model_not_supported',
    message: `model '${raw}' is not recognized. No hop.`,
  }
}
