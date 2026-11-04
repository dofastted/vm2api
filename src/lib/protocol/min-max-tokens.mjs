/**
 * A caller max_tokens is the output budget and is not replaced.
 * A missing value is filled later from the model catalog.
 * Enabled thinking still needs max_tokens above budget_tokens; only that
 * invalid pair is raised, using the configured padding.
 */
export const DEFAULT_MIN_MAX_TOKENS = Object.freeze({ enabled: true, value: 128 })

export function normalizeMinMaxTokensConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const n = Math.round(Number(src.value))
  return {
    enabled: src.enabled !== false,
    value: Number.isFinite(n) && n >= 1 ? Math.min(n, 4096) : DEFAULT_MIN_MAX_TOKENS.value,
  }
}

export function applyMinMaxTokens(body, raw) {
  if (!body || typeof body !== 'object') return body
  const cfg = normalizeMinMaxTokensConfig(raw)
  if (!cfg.enabled) return body
  const current = Number(body.max_tokens)
  if (body.max_tokens == null || !Number.isFinite(current)) return body
  let next = current
  const thinking = body.thinking
  const budget = Number(thinking?.budget_tokens)
  // Upstream rejects max_tokens <= budget_tokens on enabled thinking.
  if (String(thinking?.type || '').toLowerCase() === 'enabled' && Number.isFinite(budget) && next <= budget) {
    next = budget + cfg.value
  }
  return next === current ? body : { ...body, max_tokens: next }
}
