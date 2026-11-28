import { parseAntigravityModelSpec, quotaGroupForModel, stripAntigravityPrefix } from './model-catalog.mjs'

const list = (value) => (Array.isArray(value) ? value : [])
const modelSpec = (id) =>
  parseAntigravityModelSpec(stripAntigravityPrefix(String(id || '').replace(/^models\//i, '')).toLowerCase())

function matchesModel(quotaModel, resolved) {
  if (typeof quotaModel !== 'string' || !quotaModel.trim()) return false
  const quota = modelSpec(quotaModel)
  return [resolved.upstreamModel, resolved.publicId].some((id) => {
    if (!id) return false
    const model = modelSpec(id)
    return quota.base === model.base && (!quota.impliedEffort || quota.impliedEffort === model.impliedEffort)
  })
}

/** Authoritative quota admission only: never mutate account switches or model cooldowns. */
export function evaluateGeminiQuota(account, resolved, now = Date.now()) {
  const group =
    resolved.quotaGroup || quotaGroupForModel(resolved.upstreamModel || resolved.publicId, resolved.provider)
  const applicableGroups = new Set([group])
  // The common Gemini bucket also covers Argon; its dedicated bucket is an additional limit.
  if (group === 'gemini-argon-wtu') applicableGroups.add('gemini')
  const windows = list(account?.quotas).filter((q) => q && matchesModel(q.model, resolved))
  for (const quotaGroup of list(account?.quota_groups)) {
    for (const window of list(quotaGroup?.windows)) {
      const match = /^(gemini-argon-wtu|gemini|3p)-(5h|weekly)$/.exec(window?.id)
      if (match && applicableGroups.has(match[1])) windows.push(window)
    }
  }
  const exhausted = windows.filter((window) => {
    // Missing/null/strings/invalid fractions are unknown, not evidence of exhaustion.
    if (window.remaining_fraction !== 0) return false
    const reset = typeof window.reset_at === 'string' ? Date.parse(window.reset_at) : NaN
    return !Number.isFinite(reset) || reset > now
  })
  const resets = exhausted.map((window) => (typeof window.reset_at === 'string' ? Date.parse(window.reset_at) : NaN))
  // Every exhausted window must recover before this account can serve the model.
  const resetAt = resets.length && resets.every(Number.isFinite) ? Math.max(...resets) : null
  return { exhausted: exhausted.length > 0, resetAt }
}

export function quotaRetryAfter(states, now = Date.now()) {
  const resets = states.map((state) => state.resetAt).filter((reset) => Number.isFinite(reset) && reset > now)
  return resets.length ? Math.max(1, Math.ceil((Math.min(...resets) - now) / 1000)) : null
}

// Keep the scheduler projection minimal; never forward account identity/credentials.
export function projectGeminiQuotaAccount(account) {
  const catalog = Array.isArray(account?.model_catalog)
    ? account.model_catalog
    : account?.catalogIndex instanceof Map
      ? [...account.catalogIndex].map(([id, meta]) => ({ id, ...meta }))
      : []
  return {
    quotas: list(account?.quotas)
      .filter(Boolean)
      .map(({ model, remaining_fraction, reset_at }) => ({ model, remaining_fraction, reset_at })),
    quota_groups: list(account?.quota_groups)
      .filter(Boolean)
      .map(({ windows }) => ({
        windows: list(windows)
          .filter(Boolean)
          .map(({ id, period, remaining_fraction, reset_at }) => ({ id, period, remaining_fraction, reset_at })),
      })),
    model_catalog: catalog.filter(Boolean).map(({ id, provider, quota_group }) => ({ id, provider, quota_group })),
  }
}
