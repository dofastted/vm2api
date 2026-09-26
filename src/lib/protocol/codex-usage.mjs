/**
 * Codex usage contract aligned with sub2api OpenAICodexUsageSnapshot.
 *
 * extra keys (direct used %, never inverted):
 *   codex_5h_used_percent / codex_7d_used_percent
 *   codex_primary_* (7d by default) / codex_secondary_* (5h by default)
 * Normalize() maps primary/secondary by window_minutes like sub2api.
 */

function num(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function int(value) {
  const n = num(value)
  return n == null ? null : Math.trunc(n)
}

/**
 * Live `x-codex-*` rate-limit headers -> extra keys.
 *
 * The ChatGPT Codex backend stamps the metered windows on every Responses
 * reply (the 429 included). `-reset-at` is absolute unix seconds; older
 * builds only send the relative `-reset-after-seconds`, so both are read and
 * the absolute form wins. Window lengths are never assumed: `window_minutes`
 * decides which side is the 5h and which is the 7d window.
 */
export function extraFromCodexHeaders(headers = {}, now = Date.now()) {
  const h = lowerHeaders(headers)
  if (!h) return null
  const extra = {}
  let seen = false
  for (const role of ['primary', 'secondary']) {
    const used = num(h[`x-codex-${role}-used-percent`])
    const minutes = int(h[`x-codex-${role}-window-minutes`])
    const resetAtEpoch = int(h[`x-codex-${role}-reset-at`])
    const resetAfter = int(h[`x-codex-${role}-reset-after-seconds`])
    if (used == null && minutes == null && resetAtEpoch == null && resetAfter == null) continue
    seen = true
    const resetMs =
      resetAtEpoch != null && resetAtEpoch > 0
        ? resetAtEpoch * 1000
        : resetAfter != null
          ? now + resetAfter * 1000
          : null
    extra[`codex_${role}_used_percent`] = used
    extra[`codex_${role}_window_minutes`] = minutes
    extra[`codex_${role}_reset_at`] = resetMs == null ? null : new Date(resetMs).toISOString()
    extra[`codex_${role}_reset_after_seconds`] =
      resetAfter != null ? resetAfter : resetMs == null ? null : Math.max(0, Math.round((resetMs - now) / 1000))
  }
  if (!seen) return null
  const overSecondary = num(h['x-codex-primary-over-secondary-limit-percent'])
  if (overSecondary != null) extra.codex_primary_over_secondary_percent = overSecondary
  const reached = String(h['x-codex-rate-limit-reached-type'] || '').trim()
  extra.codex_rate_limit_reached_type = reached || null
  extra.codex_usage_updated_at = new Date(now).toISOString()
  return extra
}

/** Fallback park when upstream says "spent" but ships no reset clock. */
export const CODEX_DEFAULT_PARK_MS = 60_000

/**
 * Park verdict for a slot: a window at its cap with a future reset, or an
 * explicit `usage_limit_reached`, means the credential is spent until the
 * soonest window reset.
 */
export function codexQuotaPark(extra = {}, now = Date.now()) {
  const limits = normalizeCodexLimits(extraToCodexSnapshot(extra))
  let until = null
  let liveCap = false
  for (const key of ['5h', '7d']) {
    const used = num(limits[`used_${key}_percent`])
    const resetMs = Date.parse(limits[`reset_${key}_at`] || '')
    if (used == null || used < 100) continue
    if (Number.isFinite(resetMs) && resetMs <= now) continue
    liveCap = true
    if (Number.isFinite(resetMs) && resetMs > now && (until == null || resetMs < until)) until = resetMs
  }
  const manual = Date.parse(extra?.codex_limited_until || '')
  const manualLive = Number.isFinite(manual) && manual > now
  if (manualLive && (until == null || manual < until)) until = manual
  if (liveCap && until == null && !Number.isFinite(manual)) until = now + CODEX_DEFAULT_PARK_MS
  return { limited: until != null, until }
}

function lowerHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue
    out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value)
  }
  return out
}

export function extraToCodexSnapshot(extra = {}) {
  if (!extra || typeof extra !== 'object') return emptySnapshot()
  return {
    primary_used_percent: num(extra.codex_primary_used_percent ?? extra.codex_7d_used_percent),
    primary_reset_after_seconds: int(extra.codex_primary_reset_after_seconds ?? extra.codex_7d_reset_after_seconds),
    primary_window_minutes: int(extra.codex_primary_window_minutes ?? extra.codex_7d_window_minutes),
    primary_reset_at: extra.codex_primary_reset_at || extra.codex_7d_reset_at || null,
    secondary_used_percent: num(extra.codex_secondary_used_percent ?? extra.codex_5h_used_percent),
    secondary_reset_after_seconds: int(extra.codex_secondary_reset_after_seconds ?? extra.codex_5h_reset_after_seconds),
    secondary_window_minutes: int(extra.codex_secondary_window_minutes ?? extra.codex_5h_window_minutes),
    secondary_reset_at: extra.codex_secondary_reset_at || extra.codex_5h_reset_at || null,
    primary_over_secondary_percent: num(extra.codex_primary_over_secondary_percent),
    updated_at: extra.codex_usage_updated_at || extra.updated_at || null,
  }
}

function emptySnapshot() {
  return {
    primary_used_percent: null,
    primary_reset_after_seconds: null,
    primary_window_minutes: null,
    primary_reset_at: null,
    secondary_used_percent: null,
    secondary_reset_after_seconds: null,
    secondary_window_minutes: null,
    secondary_reset_at: null,
    primary_over_secondary_percent: null,
    updated_at: null,
  }
}

export function normalizeCodexLimits(snapshot = {}) {
  const primaryMins = num(snapshot.primary_window_minutes)
  const secondaryMins = num(snapshot.secondary_window_minutes)
  const hasPrimary = primaryMins != null
  const hasSecondary = secondaryMins != null
  let fiveFromPrimary = false
  let sevenFromPrimary = false
  if (hasPrimary && hasSecondary) {
    if (primaryMins < secondaryMins) fiveFromPrimary = true
    else sevenFromPrimary = true
  } else if (hasPrimary) {
    if (primaryMins <= 360) fiveFromPrimary = true
    else sevenFromPrimary = true
  } else if (hasSecondary) {
    if (secondaryMins <= 360) sevenFromPrimary = true
    else fiveFromPrimary = true
  } else {
    sevenFromPrimary = true
  }
  if (fiveFromPrimary) {
    return {
      used_5h_percent: snapshot.primary_used_percent,
      reset_5h_seconds: snapshot.primary_reset_after_seconds,
      window_5h_minutes: snapshot.primary_window_minutes ?? 300,
      reset_5h_at: snapshot.primary_reset_at,
      used_7d_percent: snapshot.secondary_used_percent,
      reset_7d_seconds: snapshot.secondary_reset_after_seconds,
      window_7d_minutes: snapshot.secondary_window_minutes ?? 10080,
      reset_7d_at: snapshot.secondary_reset_at,
    }
  }
  return {
    used_5h_percent: snapshot.secondary_used_percent,
    reset_5h_seconds: snapshot.secondary_reset_after_seconds,
    window_5h_minutes: snapshot.secondary_window_minutes ?? 300,
    reset_5h_at: snapshot.secondary_reset_at,
    used_7d_percent: snapshot.primary_used_percent,
    reset_7d_seconds: snapshot.primary_reset_after_seconds,
    window_7d_minutes: snapshot.primary_window_minutes ?? 10080,
    reset_7d_at: snapshot.primary_reset_at,
  }
}

function pctToRatio(percent) {
  if (percent == null) return null
  return Math.max(0, Math.min(1, Number(percent) / 100))
}

export function codexLimitsToQuota(limits = {}) {
  return {
    utilization_5h: pctToRatio(limits.used_5h_percent),
    utilization_7d: pctToRatio(limits.used_7d_percent),
    reset_5h: limits.reset_5h_at || null,
    reset_7d: limits.reset_7d_at || null,
    status_5h: statusFromPercent(limits.used_5h_percent),
    status_7d: statusFromPercent(limits.used_7d_percent),
  }
}

function statusFromPercent(percent) {
  if (percent == null) return null
  if (percent >= 100) return 'limited'
  if (percent >= 90) return 'warn'
  if (percent >= 75) return 'caution'
  return 'ok'
}

function isCodexSnapshot(value) {
  return !!value && typeof value === 'object' && Object.hasOwn(value, 'primary_used_percent')
}

/** Accepts extra, a snapshot, or a previously built view (`{ snapshot, ... }`). */
export function buildCodexUsageView(extraOrSnapshot = {}) {
  const input = extraOrSnapshot && typeof extraOrSnapshot === 'object' ? extraOrSnapshot : {}
  const snapshot = isCodexSnapshot(input)
    ? input
    : isCodexSnapshot(input.snapshot)
      ? input.snapshot
      : extraToCodexSnapshot(input)
  const limits = normalizeCodexLimits(snapshot)
  const quota = codexLimitsToQuota(limits)
  return {
    snapshot,
    limits,
    quota,
    unit: 'percent_used',
    windows: [
      {
        id: '5h',
        label: '5h',
        used_percent: limits.used_5h_percent,
        reset_at: limits.reset_5h_at,
        reset_after_seconds: limits.reset_5h_seconds,
        window_minutes: limits.window_5h_minutes,
      },
      {
        id: '7d',
        label: '7d',
        used_percent: limits.used_7d_percent,
        reset_at: limits.reset_7d_at,
        reset_after_seconds: limits.reset_7d_seconds,
        window_minutes: limits.window_7d_minutes,
      },
    ],
  }
}
