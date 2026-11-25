/**
 * Per-tier quota + concurrency policy.
 * default / pro / max are independent. Missing keys fill product defaults.
 *
 *   default / pro: 2 conc · 5h 85% · 7d 80%
 *   max:           4 conc · 5h 95% · 7d 95%
 *
 * Canonical names: limit_5h / limit_7d. Disk may still have safety_ratio /
 * weekly_safety_ratio; both are written back so old readers keep working.
 */

import { GATE_OPEN, gateZone, quotaGateOf } from './quota-gate.mjs'
import { isOfficialWindowLimited, listQuotaFromHeaders } from './quota-window.mjs'

export const TIER_KEYS = ['default', 'pro', 'max']

export const DEFAULT_TIER_POLICIES = {
  default: {
    max_concurrency: 2,
    max_rpm: 0,
    limit_5h: 0.85,
    limit_7d: 0.8,
    safety_ratio: 0.85,
    weekly_safety_ratio: 0.8,
    warn_ratio: 0.75,
  },
  pro: {
    max_concurrency: 2,
    max_rpm: 0,
    limit_5h: 0.85,
    limit_7d: 0.8,
    safety_ratio: 0.85,
    weekly_safety_ratio: 0.8,
    warn_ratio: 0.75,
  },
  max: {
    max_concurrency: 4,
    max_rpm: 0,
    limit_5h: 0.95,
    limit_7d: 0.95,
    safety_ratio: 0.95,
    weekly_safety_ratio: 0.95,
    warn_ratio: 0.85,
  },
}

export function clampRatio(n, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(1, Math.max(0.3, v))
}

export function clampConcurrency(n, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return fallback
  return Math.min(256, Math.round(v))
}

/** 0 = unlimited. */
export function clampRpm(n, fallback = 0) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return fallback
  return Math.min(1e6, Math.round(v))
}

export function resolveTierKey(tier) {
  const k = String(tier || '').toLowerCase()
  return k === 'pro' || k === 'max' ? k : 'default'
}

export function mergeTierMaps(prev = {}, next = {}) {
  const out = { ...prev }
  if (!next || typeof next !== 'object') return out
  for (const key of TIER_KEYS) {
    if (next[key] && typeof next[key] === 'object') {
      out[key] = { ...(prev[key] || {}), ...next[key] }
    }
  }
  return out
}

function readLimit5h(t, base) {
  return clampRatio(t.limit_5h ?? t.safety_ratio, base.limit_5h)
}

function readLimit7d(t, base) {
  return clampRatio(t.limit_7d ?? t.weekly_safety_ratio ?? t.weekly_ratio, base.limit_7d)
}

export function normalizeTiers(raw = {}, _quota = {}, _concurrency = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const key of TIER_KEYS) {
    const t = src[key] && typeof src[key] === 'object' ? src[key] : {}
    const base = DEFAULT_TIER_POLICIES[key]
    const limit5 = readLimit5h(t, base)
    const limit7 = readLimit7d(t, base)
    let warn = clampRatio(t.warn_ratio, base.warn_ratio)
    if (warn > limit5) warn = limit5
    out[key] = {
      max_concurrency: clampConcurrency(t.max_concurrency, base.max_concurrency),
      max_rpm: clampRpm(t.max_rpm, base.max_rpm),
      limit_5h: limit5,
      limit_7d: limit7,
      safety_ratio: limit5,
      weekly_safety_ratio: limit7,
      warn_ratio: warn,
    }
  }
  return out
}

export function resolveTierPolicy(config = {}, tier) {
  const tiers =
    config?.tiers && typeof config.tiers === 'object'
      ? normalizeTiers(config.tiers, config.quota, config.concurrency)
      : normalizeTiers({}, config.quota, config.concurrency)
  return tiers[resolveTierKey(tier)] || tiers.default
}

export function accountTierKey(acc) {
  return resolveTierKey(acc?.unified?.account_tier || acc?.account_tier)
}

function utilRatio(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return n > 1.5 ? n / 100 : n
}

/** Draining or gated on 5h/7d (quota-gate.mjs): the account is at or near its line. */
export function isNearLimit(acc, policy, { now = Date.now() } = {}) {
  const p = policy || resolveTierPolicy({}, accountTierKey(acc))
  const limit5 = Number(p.limit_5h ?? p.safety_ratio ?? 0.85)
  const limit7 = Number(p.limit_7d ?? p.weekly_safety_ratio ?? 0.8)
  const gate = quotaGateOf(p)
  const u = acc?.unified || {}
  const listed = listQuotaFromHeaders(u, { now })
  const o5 = u.official?.['5h'] || u['5h'] || {}
  const o7 = u.official?.['7d'] || u['7d'] || {}
  const u5 = isOfficialWindowLimited(o5, { now })
    ? 1
    : listed.utilization_5h != null
      ? listed.utilization_5h
      : o5.utilization
  const u7 = isOfficialWindowLimited(o7, { now })
    ? 1
    : listed.utilization_7d != null
      ? listed.utilization_7d
      : o7.utilization
  return gateZone(utilRatio(u5), limit5, gate) !== GATE_OPEN || gateZone(utilRatio(u7), limit7, gate) !== GATE_OPEN
}
