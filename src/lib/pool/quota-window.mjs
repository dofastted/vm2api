/**
 * Effective 5h / 7d windows for panel + scheduler.
 *
 * Official `/api/oauth/usage` often keeps utilization=1 + status=rejected after
 * a session rolls over, with `resets_at` already pointing at the *next* window.
 * That leftover must not mark the slot as 5h-full when this gateway has not
 * sent anything in the current window.
 */

import { zonedParts, zonedWallToMs } from '../core/timezone.mjs'

export const WINDOW_5H_MS = 5 * 3600_000
export const WINDOW_7D_MS = 7 * 24 * 3600_000

/**
 * Inclusive start of the current Extra window.
 * Future reset → [reset − duration, reset). Elapsed reset → new window started at reset.
 * Missing reset → null so the caller can fall back to a wall-clock lookback.
 */
export function extraWindowSince(reset, durationMs, now = Date.now()) {
  const resetMs = parseResetMs(reset)
  const duration = Number(durationMs)
  if (!Number.isFinite(resetMs) || !Number.isFinite(duration) || duration <= 0) return null
  return resetMs > now ? resetMs - duration : resetMs
}

export function parseResetMs(reset) {
  if (reset == null || reset === '') return NaN
  if (typeof reset === 'number' && Number.isFinite(reset)) {
    return reset < 10_000_000_000 ? reset * 1000 : reset
  }
  const str = String(reset).trim()
  if (!str) return NaN
  if (/^\d+(\.\d+)?$/.test(str)) {
    const n = Number(str)
    if (!Number.isFinite(n) || n <= 0) return NaN
    return n < 10_000_000_000 ? n * 1000 : n
  }
  const parsed = Date.parse(str)
  return Number.isFinite(parsed) ? parsed : NaN
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * Claude CLI limit text carries no header, only `resets 11am (America/New_York)`
 * or `resets Sep 25, 3pm (UTC)` (utils/format.ts formatResetTime). Returns the
 * reset as epoch ms, or null when the text has no parseable reset.
 */
export function parseLimitResetFromMessage(message, now = Date.now()) {
  const text = String(message || '')
  const m = text.match(
    /resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(?:(\d{4}),?\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*(?:\(([^)]+)\))?/i,
  )
  if (!m) return null
  const [, monName, dayRaw, yearRaw, hourRaw, minuteRaw, ampm, zoneRaw] = m
  let timeZone = String(zoneRaw || 'UTC').trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
  } catch {
    timeZone = 'UTC'
  }
  let hour = Number(hourRaw) % 12
  if (ampm.toLowerCase() === 'pm') hour += 12
  const minute = Number(minuteRaw || 0)
  const today = zonedParts(now, timeZone)
  if (monName) {
    const month = MONTHS.indexOf(monName.toLowerCase()) + 1
    if (month <= 0) return null
    let year = yearRaw ? Number(yearRaw) : today.year
    let ms = zonedWallToMs({ year, month, day: Number(dayRaw), hour, minute }, timeZone)
    if (!yearRaw && ms <= now) {
      year += 1
      ms = zonedWallToMs({ year, month, day: Number(dayRaw), hour, minute }, timeZone)
    }
    return Number.isFinite(ms) ? ms : null
  }
  let ms = zonedWallToMs({ year: today.year, month: today.month, day: today.day, hour, minute }, timeZone)
  if (ms <= now) {
    const next = zonedParts(now + 24 * 3600_000, timeZone)
    ms = zonedWallToMs({ year: next.year, month: next.month, day: next.day, hour, minute }, timeZone)
  }
  return Number.isFinite(ms) ? ms : null
}

/** Which Extra window a CLI limit text names. */
export function limitWindowFromMessage(message) {
  return /weekly|opus limit|sonnet limit|7-day|seven.day/i.test(String(message || '')) ? '7d' : '5h'
}

/** CLI plan-limit text (`You've hit your limit`, `out of extra usage`). Not `extra usage required`. */
export function isPlanLimitMessage(message) {
  const text = String(message || '')
  if (/extra usage required/i.test(text)) return false
  return /hit your (?:\w+ )?limit|out of extra usage/i.test(text)
}

/**
 * Whether a finished request proves the account's own plan window is spent.
 * A 429 the pool synthesized itself (`fable_requires_max`, `pool_rate_limited`)
 * never reached the provider, so it says nothing about the account's quota.
 */
export function isAccountQuotaExhausted(result = {}, limitText = '') {
  if (!result || result.ok) return false
  if (isPlanLimitMessage(limitText)) return true
  if (Number(result.status) !== 429 || result.via === 'pool-failover') return false
  // A 429 alone does not say which window, or whether any plan window, is spent:
  // the provider also answers a bare "Error" 429 to one request (or one model)
  // while the account keeps serving. Marking it would park a healthy account
  // until its 5h reset. Trust the classifier when it graded the hop; otherwise
  // require a rejected unified window. The usage probe every 429 asks for
  // still catches a real exhaustion that came without evidence.
  const reason = String(result.policy?.reason || '')
  if (reason) return reason === 'account_quota_exhausted'
  return hasRejectedUnifiedWindow(result.headers)
}

function hasRejectedUnifiedWindow(headers = {}) {
  if (!headers || typeof headers !== 'object') return false
  for (const [key, value] of Object.entries(headers)) {
    if (!/^anthropic-ratelimit-unified-(5h|7d)-status$/i.test(key)) continue
    if (/^(rejected|rate_limited)$/i.test(String(value || '').trim())) return true
  }
  return false
}

/**
 * Wrap CLI often reports Extra 5h/7d as `You've hit your limit` without HTTP headers.
 * The reset comes from the text; an elapsed leftover reset must never be reused.
 */
export function extraHeadersFromLimitError(message, headers = {}, now = Date.now()) {
  const h = { ...(headers || {}) }
  if (Object.keys(h).some((key) => /ratelimit-unified-(5h|7d)-status/i.test(key))) return h
  const text = String(message || '')
  if (!isPlanLimitMessage(text)) return h
  const window = limitWindowFromMessage(text)
  h[`anthropic-ratelimit-unified-${window}-status`] = 'rejected'
  h[`anthropic-ratelimit-unified-${window}-utilization`] = '1'
  const resetMs = parseLimitResetFromMessage(text, now)
  if (resetMs) h[`anthropic-ratelimit-unified-${window}-reset`] = String(Math.floor(resetMs / 1000))
  return h
}

export function parseUsedAtMs(value) {
  if (value == null || value === '') return 0
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

const OFFICIAL_SOURCES = new Set(['vm-oauth-usage', 'official-cc-usage'])

function windowHasData(window) {
  if (!window || typeof window !== 'object') return false
  return window.utilization != null || window.status || window.reset || window.resets_at
}

/** Official /usage window. Never falls back to Messages headers. */
export function officialWindow(unified = {}, key = '5h') {
  if (windowHasData(unified?.official?.[key])) return unified.official[key]
  const legacyOfficial =
    OFFICIAL_SOURCES.has(String(unified?.source || '')) ||
    OFFICIAL_SOURCES.has(String(unified?.last_probe?.source || ''))
  if (legacyOfficial && windowHasData(unified?.[key])) return unified[key]
  return { utilization: 0, reset: null, status: 'active' }
}

/** Live inference / CLI rate-limit headers (Extra). */
export function headerWindow(unified = {}, key = '5h') {
  if (windowHasData(unified?.headers?.[key])) return unified.headers[key]
  return { utilization: null, reset: null, status: null }
}

/** Header Extra for list/gate. Elapsed reset is 0 / active. */
export function headerWindowOrEmpty(unified = {}, key = '5h', { now = Date.now() } = {}) {
  const raw = headerWindow(unified, key)
  if (!windowHasData(raw)) return { utilization: null, reset: null, status: null }
  const resetMs = parseResetMs(raw.reset)
  if (Number.isFinite(resetMs) && resetMs <= now) {
    return {
      utilization: 0,
      status: 'active',
      reset: raw.reset ?? null,
      stale: true,
      stale_reason: 'reset_elapsed',
    }
  }
  return {
    utilization: raw.utilization ?? null,
    reset: raw.reset ?? null,
    status: raw.status ?? null,
  }
}

function wipeElapsedWindow(window, now) {
  if (!windowHasData(window)) return null
  const resetMs = parseResetMs(window.reset)
  if (!Number.isFinite(resetMs) || resetMs > now) return null
  return {
    utilization: 0,
    status: 'active',
    reset: window.reset ?? null,
    stale: true,
    stale_reason: 'reset_elapsed',
  }
}

export function wipeElapsedHeaderWindows(unified = {}, { now = Date.now() } = {}) {
  const headers = unified?.headers
  let changed = false
  let next = headers && typeof headers === 'object' ? { ...headers } : headers
  if (next && typeof next === 'object') {
    for (const key of ['5h', '7d', '7d_oi']) {
      const wiped = wipeElapsedWindow(next[key], now)
      if (!wiped) continue
      next[key] = wiped
      changed = true
    }
    if (changed) {
      const liveRejected = ['5h', '7d'].some((key) => {
        const s = String(next[key]?.status || '').toLowerCase()
        return s === 'rejected' || s === 'rate_limited'
      })
      if (!liveRejected) next.exhausted_at = null
    }
  }
  let oi = null
  const wipedOi = wipeElapsedWindow(unified?.['7d_oi'], now)
  if (wipedOi) {
    oi = wipedOi
    changed = true
  }
  return { headers: next, oi, changed }
}

/**
 * Extra 100% + future reset is often leftover after a rollover.
 * Clear only when last_used is before this Extra window started.
 */
export function leftoverClearHeaderWindows(unified = {}, { now = Date.now(), lastUsedAt = null } = {}) {
  const headers = unified?.headers
  if (!headers || typeof headers !== 'object') return { headers, changed: false }
  const usedAt = parseUsedAtMs(lastUsedAt)
  let changed = false
  const next = { ...headers }
  const durations = { '5h': WINDOW_5H_MS, '7d': WINDOW_7D_MS }
  for (const key of ['5h', '7d']) {
    const w = next[key]
    if (!windowHasData(w) || !isLimited(w.status, w.utilization)) continue
    const resetMs = parseResetMs(w.reset)
    if (!Number.isFinite(resetMs) || resetMs <= now) continue
    const windowStart = resetMs - durations[key]
    if (!usedAt || usedAt >= windowStart) continue
    next[key] = {
      utilization: 0,
      status: 'active',
      reset: w.reset ?? null,
      stale: true,
      stale_reason: 'header_no_in_window_usage',
    }
    changed = true
  }
  if (changed && !['5h', '7d'].some((key) => isRejectedStatus(next[key]?.status))) {
    next.exhausted_at = null
  }
  return { headers: next, changed }
}

/** List / capsule / gate numbers from Extra only. */
export function listQuotaFromHeaders(unified = {}, { now = Date.now() } = {}) {
  const wipedResult = wipeElapsedHeaderWindows(unified, { now })
  const wiped = wipedResult.headers || unified?.headers || {}
  const view = { ...unified, headers: wiped }
  const w5 = headerWindowOrEmpty(view, '5h', { now })
  const w7 = headerWindowOrEmpty(view, '7d', { now })
  const oi = wipedResult.oi ?? unified?.['7d_oi'] ?? wiped['7d_oi'] ?? {}
  return {
    utilization_5h: w5.utilization != null ? Number(w5.utilization) : null,
    utilization_7d: w7.utilization != null ? Number(w7.utilization) : null,
    status_5h: w5.status || null,
    status_7d: w7.status || null,
    reset_5h: w5.reset || null,
    reset_7d: w7.reset || null,
    utilization_7d_oi: oi.utilization != null ? Number(oi.utilization) : null,
    status_7d_oi: oi.status || null,
    reset_7d_oi: oi.reset || null,
    '5h': w5,
    '7d': w7,
  }
}

function officialSample(unified = {}, key = '5h') {
  if (windowHasData(unified?.official?.[key])) return unified.official[key]
  const officialSource =
    OFFICIAL_SOURCES.has(String(unified?.source || '')) ||
    OFFICIAL_SOURCES.has(String(unified?.last_probe?.source || ''))
  if (officialSource && windowHasData(unified?.[key])) return unified[key]
  return null
}

/** Official /usage has a real 5h/7d sample (not the empty officialWindow default). */
export function hasOfficialUsageSample(unified = {}) {
  return !!(officialSample(unified, '5h') || officialSample(unified, '7d'))
}

/** Extra 5h/7d still inside its reset — stay on headers, do not hop. */
export function hasLiveExtraSample(unified = {}, { now = Date.now() } = {}) {
  const headers = unified?.headers
  if (!headers || typeof headers !== 'object') return false
  for (const key of ['5h', '7d']) {
    const window = headers[key]
    if (!windowHasData(window)) continue
    const resetMs = parseResetMs(window.reset)
    const elapsed = window.stale_reason === 'reset_elapsed' || (Number.isFinite(resetMs) && resetMs <= now)
    if (!elapsed) return true
  }
  return false
}

/** Extra/ingest is 0–1; leftover official Settings numbers are 0–100. Never ×100 twice. */
export function toPercentUsed(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (n < 0) return 0
  if (n <= 1) return Math.round(n * 10000) / 100
  if (n > 100) return 100
  return n
}

export function publicUsageWindow(window = {}) {
  const utilization = window?.utilization != null ? toPercentUsed(window.utilization) : null
  const status = window?.status || null
  const resets_at = window?.reset || window?.resets_at || null
  if (utilization == null && !status && !resets_at) return null
  return { utilization, status, resets_at }
}

export function usageWindowsEmpty(listed = {}) {
  const five = listed['5h'] || {
    utilization: listed.utilization_5h,
    status: listed.status_5h,
    reset: listed.reset_5h,
  }
  const seven = listed['7d'] || {
    utilization: listed.utilization_7d,
    status: listed.status_7d,
    reset: listed.reset_7d,
  }
  return !publicUsageWindow(five) && !publicUsageWindow(seven)
}

export function projectRateWindows(unified = {}) {
  return {
    ...unified,
    '5h': officialWindow(unified, '5h'),
    '7d': officialWindow(unified, '7d'),
  }
}

function isRejectedStatus(status) {
  const s = String(status || '').toLowerCase()
  return s === 'rejected' || s === 'rate_limited'
}

/** Header samples are 0–1. Official Settings leftovers are 0–100. */
function utilRatio(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return n > 1.5 ? n / 100 : n
}

function isPercentReading(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 1.5
}

/** True 429 / CLI rejected on headers, until reset or official /usage clears it.
 * Percent 26 stored next to a rejected flag is 26%, not a full window.
 */
export function headerHardBlocked(unified = {}, key = '5h', now = Date.now()) {
  const h = headerWindow(unified, key)
  if (!isRejectedStatus(h.status)) return false
  const ratio = utilRatio(h.utilization)
  if (isPercentReading(h.utilization) && ratio != null && ratio < 1) return false
  const resetMs = parseResetMs(h.reset)
  if (Number.isFinite(resetMs) && resetMs <= now) return false
  return true
}

function isLimited(status, utilization) {
  const ratio = utilRatio(utilization)
  if (isPercentReading(utilization) && ratio != null && ratio < 1) return false
  const s = String(status || '').toLowerCase()
  if (s === 'rejected' || s === 'rate_limited') return true
  return ratio != null && ratio >= 1
}

/** Live Extra that is still allowed. Elapsed reset or rejected/100% is not live. */
export function extraIsLiveOpen(window = {}, now = Date.now()) {
  if (!windowHasData(window)) return false
  const resetMs = parseResetMs(window.reset)
  if (Number.isFinite(resetMs) && resetMs <= now) return false
  return !isLimited(window.status, window.utilization)
}

function cleared(window, reason) {
  return {
    utilization: 0,
    status: 'active',
    reset: window?.reset ?? null,
    stale: true,
    stale_reason: reason,
  }
}

/**
 * @param {{ utilization?: number, status?: string, reset?: string } | null} window
 * @param {{ now?: number, lastUsedAt?: number|string|null, source?: string|null, durationMs?: number }} [opts]
 */
export function effectiveRateWindow(
  window = {},
  { now = Date.now(), lastUsedAt = null, source = null, durationMs = WINDOW_5H_MS } = {},
) {
  const utilization = window?.utilization != null ? Number(window.utilization) : null
  const status = window?.status ?? null
  const resetMs = parseResetMs(window?.reset)
  if (Number.isFinite(resetMs) && resetMs <= now) {
    return cleared(window, 'reset_elapsed')
  }
  if (!isLimited(status, utilization)) {
    return {
      utilization: Number.isFinite(utilization) ? utilization : (window?.utilization ?? null),
      status,
      reset: window?.reset ?? null,
      stale: false,
    }
  }
  // Live inference headers / Claude Code rate_limit_event stay authoritative.
  // Official /usage can leave sticky 100% after a real rollover. Only clear
  // that leftover when last_used proves the current window has no gateway
  // traffic. Missing last_used used to clear a live 限制 and reschedule it.
  const fromProbe = OFFICIAL_SOURCES.has(String(source || ''))
  if (!fromProbe) {
    return {
      utilization: Number.isFinite(utilization) ? utilization : (window?.utilization ?? null),
      status,
      reset: window?.reset ?? null,
      stale: false,
    }
  }
  const usedAt = parseUsedAtMs(lastUsedAt)
  const windowStart = Number.isFinite(resetMs) ? resetMs - durationMs : NaN
  if (Number.isFinite(windowStart) && usedAt && usedAt < windowStart) {
    return cleared(window, 'probe_no_in_window_usage')
  }
  return {
    utilization: Number.isFinite(utilization) ? utilization : (window?.utilization ?? null),
    status,
    reset: window?.reset ?? null,
    stale: false,
  }
}

/** Raw official 5h/7d 限制 that has not reached its reset. */
export function isOfficialWindowLimited(window = {}, { now = Date.now() } = {}) {
  if (!isLimited(window?.status, window?.utilization)) return false
  const resetMs = parseResetMs(window?.reset)
  if (Number.isFinite(resetMs) && resetMs <= now) return false
  return true
}

export function applyEffectiveWindows(unified = {}, { now = Date.now(), lastUsedAt = null, source = null } = {}) {
  const projected = projectRateWindows(unified)
  const src = source || projected.source || null
  return {
    ...projected,
    '5h': {
      ...(projected['5h'] || {}),
      ...effectiveRateWindow(projected['5h'] || {}, {
        now,
        lastUsedAt,
        source: src,
        durationMs: WINDOW_5H_MS,
      }),
    },
    '7d': {
      ...(projected['7d'] || {}),
      ...effectiveRateWindow(projected['7d'] || {}, {
        now,
        lastUsedAt,
        source: src,
        durationMs: WINDOW_7D_MS,
      }),
    },
  }
}
