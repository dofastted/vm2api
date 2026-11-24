/**
 * OpenAI/Codex scheduling policy.
 *
 * This module is deliberately independent from Claude tier policy.  The
 * resolver is used by config, admission, persistence and panel projections so
 * a value cannot silently acquire a different meaning at another boundary.
 */
import { buildCodexUsageView, hasSpendableCodexCredits } from '../protocol/codex-usage.mjs'

export const OPENAI_QUOTA_DEFAULTS = Object.freeze({
  limit_5h: 1,
  limit_7d: 1,
  max_concurrency: 2,
  max_rpm: 0,
  max_sessions: 0,
})

export const OPENAI_QUOTA_LIMITS = Object.freeze({
  limit_5h: { min: 0.3, max: 1 },
  limit_7d: { min: 0.3, max: 1 },
  max_concurrency: { min: 1, max: 256 },
  max_rpm: { min: 0, max: 1_000_000 },
  max_sessions: { min: 0, max: 256 },
})

const FIELDS = Object.keys(OPENAI_QUOTA_DEFAULTS)

function finite(value) {
  if (value == null || value === '' || typeof value !== 'number') return null
  return Number.isFinite(value) ? value : null
}

function integer(value) {
  const n = finite(value)
  return n != null && Number.isInteger(n) ? n : null
}

function normalizedValue(key, value, { strict = false } = {}) {
  const limits = OPENAI_QUOTA_LIMITS[key]
  const n = key === 'limit_5h' || key === 'limit_7d' ? finite(value) : integer(value)
  if (n == null) {
    if (strict)
      throw new TypeError(`codex.quota.${key} must be ${key.startsWith('limit_') ? 'a number' : 'an integer'}`)
    return OPENAI_QUOTA_DEFAULTS[key]
  }
  if (n < limits.min || n > limits.max) {
    if (strict) {
      throw new RangeError(`codex.quota.${key} must be between ${limits.min} and ${limits.max}`)
    }
    return Math.min(limits.max, Math.max(limits.min, n))
  }
  return n
}

export function normalizeOpenAIQuotaPolicy(raw = {}, { strict = false } = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  for (const key of FIELDS) {
    if (strict && Object.prototype.hasOwnProperty.call(source, key))
      out[key] = normalizedValue(key, source[key], { strict })
    else out[key] = normalizedValue(key, source[key] ?? OPENAI_QUOTA_DEFAULTS[key], { strict: false })
  }
  return out
}

export function validateOpenAIQuotaPatch(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('codex.quota must be an object')
  }
  const out = {}
  for (const key of Object.keys(raw)) {
    if (!FIELDS.includes(key)) throw new TypeError(`codex.quota.${key} is not supported`)
    out[key] = normalizedValue(key, raw[key], { strict: true })
  }
  return out
}

export function mergeOpenAIQuotaPolicy(current, patch) {
  return normalizeOpenAIQuotaPolicy({
    ...normalizeOpenAIQuotaPolicy(current),
    ...validateOpenAIQuotaPatch(patch),
  })
}

export function openAIConcurrencyOf(vm, policy = OPENAI_QUOTA_DEFAULTS) {
  const raw = vm?.policy?.maxConcurrency ?? vm?.max_concurrency
  const own = vm?.policy?.concurrencyOverride ?? vm?.concurrency_override ?? vm?.max_concurrency_override
  if (own !== false && Number.isInteger(raw) && raw >= 0) return raw || 2
  return normalizeOpenAIQuotaPolicy(policy).max_concurrency
}

export function openAIRpmOf(vm, policy = OPENAI_QUOTA_DEFAULTS) {
  const raw = vm?.policy?.maxRpm ?? vm?.max_rpm
  const own = vm?.policy?.rpmOverride ?? vm?.rpm_override ?? vm?.max_rpm_override
  if (own !== false && Number.isInteger(raw) && raw >= 0) return raw
  return normalizeOpenAIQuotaPolicy(policy).max_rpm
}

export function openAISessionsOf(vm, policy = OPENAI_QUOTA_DEFAULTS) {
  const raw = vm?.policy?.maxSessions ?? vm?.max_sessions
  const own = vm?.policy?.sessionsOverride ?? vm?.max_sessions_override
  if (own !== false && Number.isInteger(raw) && raw >= 0) return raw
  return normalizeOpenAIQuotaPolicy(policy).max_sessions
}

function usageFraction(value, { percent = false } = {}) {
  const n = finite(value)
  if (n == null) return null
  return percent ? n / 100 : n
}

function resetIsLive(value, now) {
  if (value == null || value === '') return null
  const at = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(at) ? at > now : null
}

const OPEN_GATE = Object.freeze({ limited: false, reason: null, window: null, used: null, limit: null, until: null })

export function evaluateOpenAIQuotaGate(vm, policy = OPENAI_QUOTA_DEFAULTS, now = Date.now()) {
  if (hasSpendableCodexCredits(vm, now)) return OPEN_GATE
  const effective = normalizeOpenAIQuotaPolicy(policy)
  const extra = vm?.codex?.extra || vm?.codex_extra || {}
  const hasExtra = Object.keys(extra).length > 0
  const view = hasExtra ? buildCodexUsageView(extra) : vm?.codex_usage || vm?.codex?.usage || null
  const usage = view?.quota || {}
  const windows = Array.isArray(view?.windows) ? view.windows : []
  let first = null
  let until = null
  for (const key of ['5h', '7d']) {
    const win = windows.find((row) => row?.id === key) || null
    const percent = win?.used_percent
    const normalized = hasExtra
      ? usage[`utilization_${key}`]
      : (usage[`utilization_${key}`] ?? vm?.[`utilization_${key}`])
    const used = percent == null ? usageFraction(normalized) : usageFraction(percent, { percent: true })
    const reset = hasExtra
      ? (win?.reset_at ?? usage[`reset_${key}`])
      : (win?.reset_at ?? usage[`reset_${key}`] ?? vm?.[`reset_${key}`])
    if (used == null || resetIsLive(reset, now) === false || used < effective[`limit_${key}`]) continue
    const at = typeof reset === 'number' ? reset : Date.parse(reset || '')
    if (Number.isFinite(at) && at > now) until = until == null ? at : Math.min(until, at)
    first ||= { limited: true, reason: `quota_${key}_local`, window: key, used, limit: effective[`limit_${key}`] }
  }
  return first ? { ...first, until } : OPEN_GATE
}

export function effectiveOpenAIPolicy(vm, globalPolicy = OPENAI_QUOTA_DEFAULTS) {
  const policy = normalizeOpenAIQuotaPolicy(globalPolicy)
  return {
    max_concurrency: openAIConcurrencyOf(vm, policy),
    max_rpm: openAIRpmOf(vm, policy),
    max_sessions: openAISessionsOf(vm, policy),
    concurrency_override:
      vm?.policy?.concurrencyOverride === true ||
      vm?.max_concurrency_override === true ||
      vm?.concurrency_override === true ||
      (vm?.policy?.concurrencyOverride == null &&
        Number.isInteger(vm?.policy?.maxConcurrency) &&
        vm.policy.maxConcurrency > 0 &&
        vm.policy.maxConcurrency !== policy.max_concurrency),
    rpm_override:
      vm?.policy?.rpmOverride === true ||
      vm?.max_rpm_override === true ||
      vm?.rpm_override === true ||
      (vm?.policy?.rpmOverride == null && Number.isInteger(vm?.policy?.maxRpm) && vm.policy.maxRpm !== policy.max_rpm),
    sessions_override:
      vm?.policy?.sessionsOverride === true ||
      vm?.max_sessions_override === true ||
      (vm?.policy?.sessionsOverride == null && Number.isInteger(vm?.policy?.maxSessions) && vm.policy.maxSessions > 0),
  }
}
