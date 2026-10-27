/**
 * Subscription window capacity estimate (magpie window_holds): the vendor
 * reports only used%, so the whole window ≈ official spend logged in it ÷ used%.
 * Every input must cover the same window, otherwise the ratio is meaningless
 * and the status says why instead of showing a number.
 */
import { parseResetMs, toPercentUsed } from '../pool/quota-window.mjs'

/** Below this the vendor's rounding dominates the ratio (magpie HoldsFloor). */
export const ESTIMATE_MIN_USED_RATIO = 0.05

function round(v, digits) {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

export function usedRatioOf(value) {
  const pct = toPercentUsed(value)
  return pct == null ? null : pct / 100
}

/**
 * @param {{ spentUsd?: number, tokens?: number, usedRatio?: number|null, reset?: string|number|null,
 *   windowStart?: string|null, coveredSince?: string|null, unpricedRequests?: number, now?: number }} input
 * `coveredSince`: earliest instant whose traffic is still fully logged.
 */
export function estimateWindow({
  spentUsd = 0,
  tokens = 0,
  usedRatio = null,
  reset = null,
  windowStart = null,
  coveredSince = null,
  unpricedRequests = 0,
  now = Date.now(),
} = {}) {
  const spent = Number(spentUsd) || 0
  const base = {
    spent_usd: round(spent, 6),
    total_usd: null,
    remaining_usd: null,
    total_tokens: null,
    used_ratio: null,
  }
  if (usedRatio == null || !Number.isFinite(Number(usedRatio))) return { status: 'no_data', ...base }
  const ratio = Math.min(1, Math.max(0, Number(usedRatio)))
  base.used_ratio = round(ratio, 4)
  const resetMs = parseResetMs(reset)
  if (!Number.isFinite(resetMs) || resetMs <= now) return { status: 'no_reset', ...base }
  const startMs = Date.parse(windowStart || '')
  const coveredMs = Date.parse(coveredSince || '')
  if (!Number.isFinite(startMs) || !Number.isFinite(coveredMs) || coveredMs > startMs) {
    return { status: 'log_gap', ...base }
  }
  if (ratio < ESTIMATE_MIN_USED_RATIO) return { status: 'low_usage', ...base }
  if (Number(unpricedRequests) > 0) return { status: 'unpriced', ...base }
  // Used% moved but nothing was billed here: the window was spent outside the gateway.
  if (spent <= 0) return { status: 'log_gap', ...base }
  const total = spent / ratio
  return {
    status: 'ok',
    ...base,
    total_usd: round(total, 6),
    remaining_usd: round(Math.max(total - spent, 0), 6),
    total_tokens: Math.round((Number(tokens) || 0) / ratio),
  }
}

/**
 * Remaining spend in the live window. The live estimate wins; while it has no
 * number (fresh window, used% under the floor) the last closed window's
 * spend ÷ final used% stands in for capacity. `closed` carries `start`,
 * `used_ratio`, `total_cost`, `unpriced`.
 */
export function projectWindowRemaining({ live = null, closed = null, spentUsd = 0, coveredSince = null } = {}) {
  if (live?.status === 'ok' && live.total_usd != null) {
    return { source: 'current', total_usd: live.total_usd, remaining_usd: live.remaining_usd }
  }
  const none = { source: null, total_usd: null, remaining_usd: null }
  const ratio = Number(closed?.used_ratio)
  const cost = Number(closed?.total_cost)
  if (!Number.isFinite(ratio) || ratio < ESTIMATE_MIN_USED_RATIO || !(cost > 0)) return none
  if (Number(closed.unpriced) > 0) return none
  const startMs = Date.parse(closed.start || '')
  const coveredMs = Date.parse(coveredSince || '')
  if (!Number.isFinite(startMs) || !Number.isFinite(coveredMs) || coveredMs > startMs) return none
  const total = cost / Math.min(1, ratio)
  return {
    source: 'previous',
    total_usd: round(total, 6),
    remaining_usd: round(Math.max(total - (Number(spentUsd) || 0), 0), 6),
  }
}
