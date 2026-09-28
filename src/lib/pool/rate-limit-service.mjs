/**
 * Account scheduling state from upstream results (sub2api RateLimitService).
 *
 * One writer for the hard columns the scheduler gates on:
 *   429 → rate_limit_reset_at (+ session_window rejected)
 *   529 → overload_until
 * An incomplete hop is a request failure. It does not park the account.
 * Passive Extra utilization stays in account-quota for the panel; it never
 * clears these columns. Only a live `5h-status=allowed` header or the reset
 * passing lifts a rate limit (sub2api UpdateSessionWindow → ClearRateLimit).
 */
import { extraHeadersFromLimitError, parseResetMs, WINDOW_5H_MS } from './quota-window.mjs'

export const DEFAULT_RATE_LIMIT = Object.freeze({
  fallback_cooldown_min: 30,
  overload_cooldown_min: 10,
  empty_response_cooldown_sec: 60,
})

export const EMPTY_RESPONSE_REASON = 'empty_response'

const SESSION_WINDOW_MIN_AGE_MS = WINDOW_5H_MS
const SESSION_WINDOW_MAX_AHEAD_MS = 7 * 24 * 3600_000

function positive(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function normalizeRateLimitConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    fallback_cooldown_min: positive(src.fallback_cooldown_min, DEFAULT_RATE_LIMIT.fallback_cooldown_min),
    overload_cooldown_min: positive(src.overload_cooldown_min, DEFAULT_RATE_LIMIT.overload_cooldown_min),
    empty_response_cooldown_sec: positive(
      src.empty_response_cooldown_sec,
      DEFAULT_RATE_LIMIT.empty_response_cooldown_sec,
    ),
  }
}

function header(headers, name) {
  const target = String(name).toLowerCase()
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value
  }
  return null
}

function bodyMessage(body) {
  if (typeof body === 'string') return body
  return String(body?.error?.message || body?.message || '')
}

function isRejected(value) {
  const s = String(value || '').toLowerCase()
  return s === 'rejected' || s === 'rate_limited'
}

function futureReset(raw, now) {
  const ms = parseResetMs(raw)
  return Number.isFinite(ms) && ms > now ? ms : null
}

/**
 * 429 reset: exhausted 7d → exhausted 5h → aggregate → soonest window → null.
 * sub2api calculateAnthropic429ResetTime / selectAnthropicExhaustedWindow.
 */
export function anthropic429Reset(headers = {}, now = Date.now()) {
  const reset5h = futureReset(header(headers, 'anthropic-ratelimit-unified-5h-reset'), now)
  const reset7d = futureReset(header(headers, 'anthropic-ratelimit-unified-7d-reset'), now)
  const hit7d = isRejected(header(headers, 'anthropic-ratelimit-unified-7d-status'))
  const hit5h = isRejected(header(headers, 'anthropic-ratelimit-unified-5h-status'))
  if (hit7d && reset7d) return { resetAt: reset7d, window: '7d', fiveHourReset: reset5h }
  if (hit5h && reset5h) return { resetAt: reset5h, window: '5h', fiveHourReset: reset5h }
  const aggregate = futureReset(header(headers, 'anthropic-ratelimit-unified-reset'), now)
  if (aggregate) return { resetAt: aggregate, window: null, fiveHourReset: reset5h }
  const retryAfter = Number(header(headers, 'retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return { resetAt: now + retryAfter * 1000, window: null, fiveHourReset: reset5h }
  }
  return null
}

export class RateLimitService {
  constructor({ runtimeRepo = null, accountQuota = null, config = {}, onUsageProbe = null } = {}) {
    this.runtimeRepo = runtimeRepo
    this.accountQuota = accountQuota
    this.config = normalizeRateLimitConfig(config)
    this.onUsageProbe = onUsageProbe
  }

  setConfig(config = {}) {
    this.config = normalizeRateLimitConfig(config)
  }

  /**
   * sub2api HandleUpstreamError: writes the hard column for this failure. Returns the block, or null.
   * The classifier decides the scope; a model / Fable / RPM 429 stays a short cooldown.
   * An unknown bare 429 writes no hard block: the scope is unproven, so one
   * bounded usage probe decides whether the account window is really spent.
   */
  handleUpstreamError({ accountId, vmId, result = {}, policy = null, now = Date.now() } = {}) {
    if (!accountId || !this.runtimeRepo || result?.committed) return null
    const reason = String(policy?.reason || '')
    if (policy?.scope === 'account' && reason === 'account_quota_exhausted') {
      return this.handle429({ accountId, vmId, result, now })
    }
    if (reason === 'rate_limited_unknown') {
      this.requestUsageProbe({ accountId, vmId })
      return null
    }
    if (reason === 'provider_overloaded' && Number(result?.status) === 529) {
      return this.handle529({ accountId, vmId, now })
    }
    return null
  }

  requestUsageProbe({ accountId, vmId }) {
    if (typeof this.onUsageProbe !== 'function') return
    try {
      this.onUsageProbe({ accountId, vmId })
    } catch {}
  }

  handle429({ accountId, vmId, result = {}, now = Date.now() }) {
    const headers = extraHeadersFromLimitError(bodyMessage(result.body), result.headers || {}, now)
    const parsed = anthropic429Reset(headers, now)
    const fallback = !parsed
    const resetAt = parsed?.resetAt || now + this.config.fallback_cooldown_min * 60_000
    const windowEnd = parsed?.fiveHourReset || (parsed?.window === '7d' ? null : resetAt)
    this.runtimeRepo.updateWindow?.(accountId, {
      vmId,
      rateLimitedAt: now,
      rateLimitResetAt: resetAt,
      ...(windowEnd ? { sessionWindowStart: windowEnd - WINDOW_5H_MS, sessionWindowEnd: windowEnd } : {}),
      sessionWindowStatus: 'rejected',
    })
    try {
      this.accountQuota?.ingestHeaders?.(accountId, headers, null, {
        exhausted: true,
        status: 429,
        countRequest: false,
      })
    } catch {}
    if (fallback) this.requestUsageProbe({ accountId, vmId })
    return { kind: 'rate_limited', until: resetAt, window: parsed?.window || null, fallback }
  }

  handle529({ accountId, vmId, now = Date.now() }) {
    const until = now + this.config.overload_cooldown_min * 60_000
    this.runtimeRepo.updateWindow?.(accountId, { vmId, overloadUntil: until })
    return { kind: 'overloaded', until }
  }

  /**
   * sub2api UpdateSessionWindow: every response with live headers.
   * An out-of-range reset is ignored. `allowed` is the only early unblock.
   */
  updateSessionWindow({ accountId, vmId = null, headers = {}, now = Date.now() } = {}) {
    if (!accountId || !this.runtimeRepo) return false
    const status = String(header(headers, 'anthropic-ratelimit-unified-5h-status') || '').toLowerCase()
    if (!status) return false
    const patch = { vmId, sessionWindowStatus: status }
    const resetMs = parseResetMs(header(headers, 'anthropic-ratelimit-unified-5h-reset'))
    if (
      Number.isFinite(resetMs) &&
      resetMs >= now - SESSION_WINDOW_MIN_AGE_MS &&
      resetMs <= now + SESSION_WINDOW_MAX_AHEAD_MS
    ) {
      patch.sessionWindowStart = resetMs - WINDOW_5H_MS
      patch.sessionWindowEnd = resetMs
    }
    const current = this.runtimeRepo.get?.(accountId) || null
    const limited = Number(current?.rate_limit_reset_at) > now
    const sevenDayOpen = !isRejected(header(headers, 'anthropic-ratelimit-unified-7d-status'))
    if (status === 'allowed' && sevenDayOpen && limited) {
      patch.rateLimitResetAt = null
    }
    this.runtimeRepo.updateWindow?.(accountId, patch)
    return patch.rateLimitResetAt === null
  }
}

/** Hard scheduling block from runtime columns (sub2api Account.IsSchedulable). */
export function hardBlockOf(state = null, now = Date.now()) {
  if (!state) return null
  const rateLimit = Number(state.rate_limit_reset_at) || 0
  if (rateLimit > now) return { reason: 'rate_limited', until: rateLimit }
  const overload = Number(state.overload_until) || 0
  if (overload > now) return { reason: 'overloaded', until: overload }
  return null
}
