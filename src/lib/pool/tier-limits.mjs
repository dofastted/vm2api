/**
 * Per-tier concurrency + quota thresholds.
 *
 * Account tier comes from official /usage Fable presence (see inferClaudeTier):
 * a plan that lists a Fable model is `max`; no Fable after a successful usage
 * probe is `pro`. Anything not yet probed (`unknown` / `none`) falls back to
 * the `default` tier.
 *
 * Resolution order for every field: tier entry → `default` entry → legacy
 * single-value config (quota.safety_ratio / concurrency.default_max_per_account).
 */

export const TIER_KEYS = ['default', 'pro', 'max']

/**
 * Is this slot's concurrency pinned by hand, or does it follow its tier?
 *
 * `true`  — pinned from the VM panel.
 * `false` — explicitly released; the old global-apply wrote this on every slot
 *           it touched, so those materialised copies must not shadow the tier.
 * absent  — a slot predating the flag. Its value may be a deliberate choice made
 *           at creation time, so it is honoured until a routing save releases it.
 */
export function isConcurrencyPinned(policy) {
  if (policy?.concurrencyOverride === true) return true
  if (policy?.concurrencyOverride === false) return false
  return policy?.maxConcurrency != null
}

const FALLBACK = { max_concurrency: 20, safety_ratio: 0.95, warn_ratio: 0.85 }

/** pro | max for probed accounts; everything else shares the default tier. */
export function normalizeTier(tier) {
  const key = String(tier || '').toLowerCase()
  return key === 'pro' || key === 'max' ? key : 'default'
}

function pickNumber(...values) {
  for (const v of values) {
    if (v == null || v === '') continue
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return null
}

/**
 * @param {object} routingConfig full routing config (reads `tiers`, `quota`, `concurrency`)
 * @param {string} tier raw account tier
 * @returns {{ max_concurrency: number, safety_ratio: number, warn_ratio: number }}
 */
export function tierLimits(routingConfig, tier) {
  const tiers = routingConfig?.tiers || {}
  const base = tiers.default || {}
  const entry = tiers[normalizeTier(tier)] || {}
  const quota = routingConfig?.quota || {}
  const concurrency = routingConfig?.concurrency || {}

  const safety =
    pickNumber(entry.limit_5h, entry.safety_ratio, base.limit_5h, base.safety_ratio, quota.safety_ratio) ??
    FALLBACK.safety_ratio
  const weekly =
    pickNumber(
      entry.limit_7d,
      entry.weekly_safety_ratio,
      base.limit_7d,
      base.weekly_safety_ratio,
      quota.weekly_safety_ratio,
    ) ?? safety
  const warn = pickNumber(entry.warn_ratio, base.warn_ratio, quota.warn_ratio) ?? FALLBACK.warn_ratio
  return {
    max_concurrency:
      pickNumber(
        entry.max_concurrency,
        base.max_concurrency,
        concurrency.default_max_per_account,
        concurrency.default_key_concurrency,
      ) ?? FALLBACK.max_concurrency,
    max_rpm: pickNumber(entry.max_rpm, base.max_rpm, concurrency.default_max_rpm) ?? 0,
    limit_5h: safety,
    limit_7d: weekly,
    max_sessions: pickNumber(entry.max_sessions, base.max_sessions) ?? 0,
    session_idle_min: pickNumber(entry.session_idle_min, base.session_idle_min) ?? 5,
    safety_ratio: safety,
    weekly_safety_ratio: weekly,
    warn_ratio: Math.min(warn, safety),
  }
}

/** Clamp a panel-submitted tier block; drops unknown tiers and out-of-range values. */
export function normalizeTiersConfig(input) {
  const out = {}
  for (const key of TIER_KEYS) {
    const entry = input?.[key]
    if (!entry || typeof entry !== 'object') continue
    const safety = clampRatio(entry.limit_5h ?? entry.safety_ratio)
    const weekly = clampRatio(entry.limit_7d ?? entry.weekly_safety_ratio)
    const warn = clampRatio(entry.warn_ratio)
    const conc = pickNumber(entry.max_concurrency)
    const rpm = pickNumber(entry.max_rpm)
    const sess = pickNumber(entry.max_sessions)
    const idle = pickNumber(entry.session_idle_min)
    const next = {}
    if (conc != null) next.max_concurrency = Math.min(256, Math.round(conc))
    if (rpm != null) next.max_rpm = Math.min(1e6, Math.round(rpm))
    if (safety != null) {
      next.limit_5h = safety
      next.safety_ratio = safety
    }
    if (weekly != null) {
      next.limit_7d = weekly
      next.weekly_safety_ratio = weekly
    }
    if (warn != null) next.warn_ratio = safety != null ? Math.min(warn, safety) : warn
    if (sess != null) next.max_sessions = Math.min(256, Math.round(sess))
    if (idle != null) next.session_idle_min = Math.min(1440, Math.max(1, Math.round(idle)))
    if (Object.keys(next).length) out[key] = next
  }
  return out
}

function clampRatio(value) {
  const n = pickNumber(value)
  if (n == null) return null
  return Math.min(1, Math.max(0.3, n))
}
