/**
 * Codex usage and rate-limit windows.
 *
 * extra keys (direct used %, never inverted):
 *   codex_5h_used_percent / codex_7d_used_percent
 *   codex_primary_* (7d fallback without minutes) / codex_secondary_* (5h fallback without minutes)
 * Normalization classifies windows by their actual positive `window_minutes`
 * (`300` -> `5h`, `1440` -> `24h`, `10080` -> `7d`, etc.) and ignores non-positive records.
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
 * soonest window reset. `waiveWindowCaps` (spendable credits) ignores the
 * window caps; an explicit park still holds.
 */
export function codexQuotaPark(extra = {}, now = Date.now(), { waiveWindowCaps = false } = {}) {
  const windows = waiveWindowCaps ? [] : extractCodexWindows(extraToCodexSnapshot(extra))
  let until = null
  let liveCap = false
  for (const win of windows) {
    const used = num(win.used_percent)
    const resetMs = Date.parse(win.reset_at || '')
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

/**
 * How long a credits reading may waive the window caps. Each Responses reply
 * refreshes it, so only an idle or parked slot ages out.
 */
export const CODEX_CREDITS_TTL_MS = 10 * 60_000

function flag(value) {
  if (typeof value === 'boolean') return value
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
  if (text === 'true' || text === '1') return true
  if (text === 'false' || text === '0') return false
  return null
}

function creditBalance(value) {
  if (typeof value === 'string') return value.trim() || null
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

/**
 * ChatGPT credits (`/wham/usage` `credits`, or `x-codex-credits-*` headers).
 * Both flags are required, as in the Codex CLI. `balance` stays a string so a
 * long decimal is never rounded through a float.
 */
export function normalizeCodexCredits(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null
  const hasCredits = flag(raw.has_credits ?? raw.hasCredits)
  const unlimited = flag(raw.unlimited)
  if (hasCredits == null || unlimited == null) return null
  return {
    has_credits: hasCredits,
    unlimited,
    balance: creditBalance(raw.balance),
    fetched_at: new Date(now).toISOString(),
  }
}

export function codexCreditsFromHeaders(headers = {}, now = Date.now()) {
  const h = lowerHeaders(headers)
  if (!h) return null
  return normalizeCodexCredits(
    {
      has_credits: h['x-codex-credits-has-credits'],
      unlimited: h['x-codex-credits-unlimited'],
      balance: h['x-codex-credits-balance'],
    },
    now,
  )
}

/**
 * A fresh reading that says the account can still buy past its 5h/7d windows.
 * It only earns the slot another try; the upstream 429 stays the authority.
 */
export function hasSpendableCodexCredits(vm, now = Date.now()) {
  const credits = vm?.codex?.credits ?? vm?.codex_credits
  const fetchedAt = Date.parse(credits?.fetched_at || '')
  if (!Number.isFinite(fetchedAt) || now - fetchedAt > CODEX_CREDITS_TTL_MS) return false
  return credits.unlimited === true || credits.has_credits === true
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

function ownDefined(obj, key) {
  return Object.hasOwn(obj, key) && obj[key] !== undefined
}

export function extraToCodexSnapshot(extra = {}) {
  if (!extra || typeof extra !== 'object') return emptySnapshot()
  const primaryWindow = ownDefined(extra, 'codex_primary_window_minutes')
    ? extra.codex_primary_window_minutes
    : extra.codex_7d_window_minutes
  const secondaryWindow = ownDefined(extra, 'codex_secondary_window_minutes')
    ? extra.codex_secondary_window_minutes
    : extra.codex_5h_window_minutes
  return {
    primary_used_percent: num(
      ownDefined(extra, 'codex_primary_used_percent') ? extra.codex_primary_used_percent : extra.codex_7d_used_percent,
    ),
    primary_reset_after_seconds: int(
      ownDefined(extra, 'codex_primary_reset_after_seconds')
        ? extra.codex_primary_reset_after_seconds
        : extra.codex_7d_reset_after_seconds,
    ),
    primary_window_minutes: int(primaryWindow),
    primary_reset_at:
      (ownDefined(extra, 'codex_primary_reset_at') ? extra.codex_primary_reset_at : extra.codex_7d_reset_at) || null,
    secondary_used_percent: num(
      ownDefined(extra, 'codex_secondary_used_percent')
        ? extra.codex_secondary_used_percent
        : extra.codex_5h_used_percent,
    ),
    secondary_reset_after_seconds: int(
      ownDefined(extra, 'codex_secondary_reset_after_seconds')
        ? extra.codex_secondary_reset_after_seconds
        : extra.codex_5h_reset_after_seconds,
    ),
    secondary_window_minutes: int(secondaryWindow),
    secondary_reset_at:
      (ownDefined(extra, 'codex_secondary_reset_at') ? extra.codex_secondary_reset_at : extra.codex_5h_reset_at) ||
      null,
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

export function codexWindowIdFromMinutes(minutes) {
  const mins = int(minutes)
  if (mins == null || mins <= 0) return null
  if (mins === 300) return '5h'
  if (mins === 10080) return '7d'
  if (mins === 1440) return '24h'
  if (mins > 1440 && mins % 1440 === 0) return `${mins / 1440}d`
  if (mins % 60 === 0) return `${mins / 60}h`
  return `${mins}m`
}

function rawWindowSlot(snapshot, role) {
  const minutes = int(snapshot[`${role}_window_minutes`])
  const used = num(snapshot[`${role}_used_percent`])
  const resetAfter = int(snapshot[`${role}_reset_after_seconds`])
  const resetAt = snapshot[`${role}_reset_at`] || null
  return {
    role,
    minutes,
    used,
    resetAfter,
    resetAt,
    hasData: used != null || resetAfter != null || resetAt != null,
  }
}

/**
 * Extract valid rate-limit windows classified by actual duration.
 * Records with `window_minutes <= 0` are ignored instead of being bucketed
 * into `5h` or `7d`. Legacy snapshots without `window_minutes` keep the
 * historical fallback (`primary` -> `7d`, `secondary` -> `5h`) when populated.
 */
export function extractCodexWindows(snapshot = {}) {
  const slots = [rawWindowSlot(snapshot, 'primary'), rawWindowSlot(snapshot, 'secondary')]
  const explicitIds = new Set(
    slots.map((slot) => (slot.minutes != null && slot.minutes > 0 ? codexWindowIdFromMinutes(slot.minutes) : null)),
  )
  const byId = new Map()
  for (const slot of slots) {
    if (slot.minutes != null && slot.minutes <= 0) continue
    let id = null
    let windowMinutes = slot.minutes
    if (slot.minutes != null) {
      id = codexWindowIdFromMinutes(slot.minutes)
    } else if (slot.hasData) {
      if (slot.role === 'primary') {
        id = explicitIds.has('7d') && !explicitIds.has('5h') ? '5h' : '7d'
      } else {
        id = explicitIds.has('5h') && !explicitIds.has('7d') ? '7d' : '5h'
      }
      windowMinutes = id === '5h' ? 300 : 10080
    } else {
      continue
    }
    if (!id) continue
    const entry = {
      id,
      label: id,
      used_percent: slot.used,
      reset_at: slot.resetAt,
      reset_after_seconds: slot.resetAfter,
      window_minutes: windowMinutes,
    }
    const prev = byId.get(id)
    if (!prev || (prev.used_percent == null && entry.used_percent != null)) {
      byId.set(id, entry)
    }
  }
  return [...byId.values()].sort((a, b) => (a.window_minutes ?? Infinity) - (b.window_minutes ?? Infinity))
}

export function normalizeCodexLimits(snapshot = {}) {
  const windows = extractCodexWindows(snapshot)
  const w5 = windows.find((w) => w.id === '5h') || null
  const w7 = windows.find((w) => w.id === '7d') || null
  return {
    used_5h_percent: w5?.used_percent ?? null,
    reset_5h_seconds: w5?.reset_after_seconds ?? null,
    window_5h_minutes: w5?.window_minutes ?? null,
    reset_5h_at: w5?.reset_at ?? null,
    used_7d_percent: w7?.used_percent ?? null,
    reset_7d_seconds: w7?.reset_after_seconds ?? null,
    window_7d_minutes: w7?.window_minutes ?? null,
    reset_7d_at: w7?.reset_at ?? null,
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
  const extracted = extractCodexWindows(snapshot)
  const limits = normalizeCodexLimits(snapshot)
  const quota = codexLimitsToQuota(limits)
  const hasNonStandardWindow = extracted.some((w) => w.id !== '5h' && w.id !== '7d')
  const windows = hasNonStandardWindow
    ? extracted
    : [
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
      ]
  return {
    snapshot,
    limits,
    quota,
    unit: 'percent_used',
    windows,
  }
}
