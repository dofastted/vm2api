/**
 * compatibility.min_max_tokens: optional floor raise, model-default fill happens
 * elsewhere, and thinking padding when budget_tokens would violate upstream rules.
 */
export const DEFAULT_MIN_MAX_TOKENS = Object.freeze({
  enabled: true,
  value: 128,
  mode: 'floor',
})

const PRESERVE_MODES = new Set(['不改', 'preserve', 'unchanged'])

export function normalizeMinMaxTokensMode(src = {}) {
  const explicit = String(src.mode ?? src.tier ?? '').trim()
  if (PRESERVE_MODES.has(explicit)) return 'preserve'
  if (explicit === 'floor' || explicit === 'default' || explicit === 'raise') return 'floor'
  if (src.no_raise === true || src.raise === false) return 'preserve'
  return 'floor'
}

export function normalizeMinMaxTokensConfig(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const value = Math.min(Math.max(1, Math.round(raw)), 4096)
    return { enabled: true, value, mode: 'floor' }
  }
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const n = Math.round(Number(src.value))
  return {
    enabled: src.enabled !== false,
    value: Number.isFinite(n) && n >= 1 ? Math.min(n, 4096) : DEFAULT_MIN_MAX_TOKENS.value,
    mode: normalizeMinMaxTokensMode(src),
  }
}

export function applyMinMaxTokens(body, raw) {
  if (!body || typeof body !== 'object') return body
  const cfg = normalizeMinMaxTokensConfig(raw)
  if (!cfg.enabled) return body
  const current = Number(body.max_tokens)
  if (body.max_tokens == null || !Number.isFinite(current)) return body
  let next = current
  if (cfg.mode !== 'preserve') {
    next = Math.max(current, cfg.value)
  }
  const thinking = body.thinking
  const budget = Number(thinking?.budget_tokens)
  // Upstream rejects max_tokens <= budget_tokens on enabled thinking.
  if (String(thinking?.type || '').toLowerCase() === 'enabled' && Number.isFinite(budget) && next <= budget) {
    next = budget + cfg.value
  }
  return next === current ? body : { ...body, max_tokens: next }
}
