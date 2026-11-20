/**
 * Claude Code 1M context selection for OAuth requests.
 *
 * [1m] is a client-side suffix (not an upstream model id).
 * Official Claude Code passes context-1m-2025-08-07 when:
 *   1. models[id].betas.pass_context_1m is an explicit boolean, or
 *   2. that flag is unset and the id matches defaults.context_1m_whitelist
 *      (fallback for dated / not-yet-in-matrix ids).
 * Inbound `claude-sonnet-5[1m]` (trailing suffix) is an explicit 1M opt-in:
 * inject the beta when the matrix allows it, including unofficial callers.
 * Bare unofficial / mimic still never injects or replays this beta.
 * supports_1m is the native window, not this header.
 */

export const CONTEXT_1M_BETA = 'context-1m-2025-08-07'
export const CLAUDE_CODE_1M_SUFFIX = '[1m]'

/** Seed / reset default: exact Sonnet 5 ID plus dated and thinking variants. */
export const DEFAULT_CONTEXT_1M_WHITELIST = Object.freeze(['claude-sonnet-5', 'claude-sonnet-5-*'])

export function stripClaudeCode1mSuffix(model = '') {
  let out = String(model || '')
  while (
    out.length > CLAUDE_CODE_1M_SUFFIX.length &&
    out.slice(-CLAUDE_CODE_1M_SUFFIX.length).toLowerCase() === CLAUDE_CODE_1M_SUFFIX
  ) {
    out = out.slice(0, -CLAUDE_CODE_1M_SUFFIX.length)
  }
  return out
}

export function hasClaudeCode1mSuffix(model = '') {
  return stripClaudeCode1mSuffix(model) !== String(model || '')
}

/** Prepend context-1m-2025-08-07 when missing. */
export function ensureContext1mBeta(header = '') {
  const parts = String(header || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.includes(CONTEXT_1M_BETA)) return parts.join(',')
  return [CONTEXT_1M_BETA, ...parts].join(',')
}

export function normalizeContext1mWhitelist(raw, fallback = DEFAULT_CONTEXT_1M_WHITELIST) {
  if (!Array.isArray(raw)) return [...fallback]
  return [...new Set(raw.map((s) => String(s || '').trim()).filter(Boolean))]
}

/** Exact id, or trailing * prefix (claude-sonnet-5-* ≠ claude-sonnet-50). */
export function matchContext1mPattern(pattern, model = '') {
  const p = String(pattern || '')
    .trim()
    .toLowerCase()
  if (!p) return false
  const raw = String(model || '').trim()
  if (!raw) return false
  const bare = stripClaudeCode1mSuffix(raw.split('/').filter(Boolean).pop() || raw).toLowerCase()
  if (p.endsWith('*')) return bare.startsWith(p.slice(0, -1))
  return bare === p
}

export function shouldPassContext1m(model = '', whitelist = DEFAULT_CONTEXT_1M_WHITELIST) {
  const patterns = normalizeContext1mWhitelist(whitelist, DEFAULT_CONTEXT_1M_WHITELIST)
  return patterns.some((pattern) => matchContext1mPattern(pattern, model))
}

/** Official path: strip 1M beta unless the model is on the whitelist. */
export function shouldStripContext1m(model = '', whitelist = DEFAULT_CONTEXT_1M_WHITELIST) {
  return !shouldPassContext1m(model, whitelist)
}
