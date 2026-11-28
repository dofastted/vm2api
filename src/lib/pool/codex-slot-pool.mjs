/**
 * OpenAI / Codex slot readiness, quota schedule, model gate, and failover helpers.
 *
 * M3 cutover (D4): pure stateless predicates & metadata evaluators ONLY.
 * All OpenAI/Codex slot selection, tier ranking, SWRR, sticky routing, and
 * session serialization are delegated solely to Rust `kin-scheduler`.
 */
import { isCodexVm } from '../vm/vm-kind.mjs'
import {
  extraToCodexSnapshot,
  extractCodexWindows,
  normalizeCodexLimits,
  codexQuotaPark,
  hasSpendableCodexCredits,
} from '../protocol/codex-usage.mjs'
import { isLeftoverQuotaScheduleOff, isQuotaWindowReason } from './availability.mjs'
import { resolveCredentialScheduleLevel } from './credential-weight.mjs'
import { expiresAtToMs } from '../oauth/oauth-credentials.mjs'
import { modelMatchesAllowlist } from './slot-model-gate.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'
import { activeHoursOf, evaluateActiveHours } from './active-hours.mjs'
import { effectiveOpenAIPolicy, evaluateOpenAIQuotaGate, normalizeOpenAIQuotaPolicy } from './openai-quota-policy.mjs'

// `stopped` is leftover Claude docker lifecycle. Codex kernel is independent.
const HARD_UNAVAILABLE = new Set(['dead', 'error', 'disabled'])

function nullableFiniteNumber(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function windowMinutesOf(win) {
  if (win?.window_minutes != null) return win.window_minutes
  const match = /^(\d+)([mhd])$/i.exec(String(win?.id || '').trim())
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const unit = match[2].toLowerCase()
  if (unit === 'm') return amount
  if (unit === 'h') return amount * 60
  return amount * 1440
}

function extraFromSummary(vm) {
  if (vm?.codex?.extra && typeof vm.codex.extra === 'object') return vm.codex.extra
  if (vm?.codex_extra && typeof vm.codex_extra === 'object') return vm.codex_extra
  const usage = vm?.codex_usage
  const snap = usage?.snapshot
  if (snap && typeof snap === 'object' && Object.hasOwn(snap, 'primary_used_percent')) {
    return {
      codex_primary_used_percent: snap.primary_used_percent,
      codex_primary_reset_after_seconds: snap.primary_reset_after_seconds,
      codex_primary_window_minutes: snap.primary_window_minutes,
      codex_primary_reset_at: snap.primary_reset_at,
      codex_secondary_used_percent: snap.secondary_used_percent,
      codex_secondary_reset_after_seconds: snap.secondary_reset_after_seconds,
      codex_secondary_window_minutes: snap.secondary_window_minutes,
      codex_secondary_reset_at: snap.secondary_reset_at,
      codex_limited_until: vm?.codex_limited_until || null,
    }
  }
  const windows = Array.isArray(usage?.windows) ? usage.windows : []
  const custom = windows.filter((w) => w?.id && w.id !== '5h' && w.id !== '7d')
  if (custom.length) {
    const first = windows[0] || {}
    const second = windows[1] || {}
    return {
      codex_primary_used_percent: first.used_percent ?? null,
      codex_primary_reset_at: first.reset_at ?? null,
      codex_primary_reset_after_seconds: first.reset_after_seconds ?? null,
      codex_primary_window_minutes: windowMinutesOf(first),
      codex_secondary_used_percent: second.used_percent ?? null,
      codex_secondary_reset_at: second.reset_at ?? null,
      codex_secondary_reset_after_seconds: second.reset_after_seconds ?? null,
      codex_secondary_window_minutes: windowMinutesOf(second),
      codex_limited_until: vm?.codex_limited_until || null,
    }
  }
  const w5 = windows.find((w) => w?.id === '5h') || {}
  const w7 = windows.find((w) => w?.id === '7d') || {}
  const limits = usage?.limits || {}
  return {
    codex_5h_used_percent: w5.used_percent ?? limits.used_5h_percent ?? null,
    codex_7d_used_percent: w7.used_percent ?? limits.used_7d_percent ?? null,
    codex_5h_reset_at: w5.reset_at ?? limits.reset_5h_at ?? vm?.reset_5h ?? null,
    codex_7d_reset_at: w7.reset_at ?? limits.reset_7d_at ?? vm?.reset_7d ?? null,
    codex_5h_window_minutes: w5.window_minutes ?? limits.window_5h_minutes ?? null,
    codex_7d_window_minutes: w7.window_minutes ?? limits.window_7d_minutes ?? null,
    codex_limited_until: vm?.codex_limited_until || null,
  }
}

function extraPark(vm, now) {
  return codexQuotaPark(extraFromSummary(vm), now, { waiveWindowCaps: hasSpendableCodexCredits(vm, now) })
}

function quotaReset7dAt(vm) {
  const limits = normalizeCodexLimits(extraToCodexSnapshot(extraFromSummary(vm)))
  const ms = Date.parse(limits.reset_7d_at || vm?.reset_7d || '')
  return Number.isFinite(ms) ? ms : null
}

function stressOf(vm) {
  const u5 = nullableFiniteNumber(vm?.utilization_5h)
  const u7 = nullableFiniteNumber(vm?.utilization_7d)
  const windows = extractCodexWindows(extraToCodexSnapshot(extraFromSummary(vm)))
  const windowRatios = windows
    .map((w) => nullableFiniteNumber(w.used_percent))
    .filter((v) => v != null)
    .map((v) => v / 100)
  return Math.max(u5 ?? 0, u7 ?? 0, ...windowRatios, 0)
}

function parkUntil(vm, now) {
  const until = Date.parse(vm?.codex_limited_until || '')
  if (Number.isFinite(until)) return until
  return extraPark(vm, now).until || now
}

export function isCodexSlotReady(vm, now = Date.now()) {
  if (!vm || !isCodexVm(vm)) return false
  if (proxyBlockedReason(vm.proxy)) return false
  if (vm.schedulable === false && !isLeftoverQuotaScheduleOff(vm)) return false
  if (!vm.has_token) return false
  const expMs = expiresAtToMs(vm.expires_at || vm.codex?.expires_at)
  if (expMs && expMs <= now && !vm.has_refresh) return false
  const status = String(vm.status || '').toLowerCase()
  if (HARD_UNAVAILABLE.has(status)) return false
  return true
}

export function isCodexSlotParked(vm, now = Date.now(), policy = null) {
  const until = Date.parse(vm?.codex_limited_until || '')
  if (Number.isFinite(until) && until > now) return true
  return extraPark(vm, now).limited || evaluateOpenAIQuotaGate(vm, policy || {}, now).limited
}

export function codexScheduleLevel(vm, now = Date.now(), resetAt = quotaReset7dAt(vm)) {
  return resolveCredentialScheduleLevel({ vm, manualLevel: vm?.schedule_level_manual ?? undefined, resetAt, now })
}

export function codexAccountStatus(vm, now = Date.now(), policy = null) {
  if (!vm || !isCodexVm(vm)) return 'error'
  if (proxyBlockedReason(vm.proxy)) return 'disabled'
  if (vm.schedulable === false && !isLeftoverQuotaScheduleOff(vm)) return 'disabled'
  const status = String(vm.status || '').toLowerCase()
  if (status === 'disabled') return 'disabled'
  if (status === 'dead' || status === 'error') return 'error'
  if (!vm.has_token) return 'error'
  if (isCodexSlotParked(vm, now, policy) || codexQuotaWindowReason(vm, now)) return 'quota_exhausted'
  return 'normal'
}

/** Panel allowlist on a GPT slot. No model or no list means allowed. */
export function codexSlotAllowsModel(vm, model) {
  if (!model) return true
  return modelMatchesAllowlist(model, vm?.allowed_models ?? vm?.policy?.allowed_models)
}

/** Distinct conversation windows on a GPT slot. 0 = off. */
export function codexMaxSessions(vm, policy = null) {
  const n = effectiveOpenAIPolicy(vm, normalizeOpenAIQuotaPolicy(policy)).max_sessions
  return n > 0 ? Math.round(n) : 0
}

export function isCodexFailoverError(result) {
  if (!result || result.ok === true || result.committed === true) return false
  const status = Number(result.status) || 0
  const code = String(result.body?.error?.code || result.error_code || '')
  const message = String(result.body?.error?.message || result.error || '')
  if (
    status !== 401 &&
    /content_policy|usage_policy|refusal|guard|invalid_request|tool_arguments_mismatch|upstream_protocol_error/i.test(
      `${code} ${message}`,
    )
  )
    return false
  if (result.transportError === true || status === 0) return true
  if (status === 429 || status === 401 || status === 403) return true
  if (status === 408) return true
  if (status === 503 && (code === 'no_capacity' || code === 'overloaded' || /server_error|provider_error/i.test(code)))
    return true
  if (status === 502 && /upstream_transport|worker_transport|transport/i.test(code)) return true
  if (
    (status === 500 || status === 502 || status === 504) &&
    (code === '' || /server_error|provider_error|upstream_error|overloaded_error|internal_error/i.test(code))
  )
    return true
  return /usage_limit_reached|upstream_auth|no_credential|sticky_unavailable/.test(code)
}

export function codexQuotaWindowReason(vm, now = Date.now()) {
  const extra = extraFromSummary(vm)
  const waived = hasSpendableCodexCredits(vm, now)
  const windows = extractCodexWindows(extraToCodexSnapshot(extra))
  const isLiveCap = (win) => {
    if (waived || !win) return false
    const used = nullableFiniteNumber(win.used_percent)
    if (used == null || used < 100) return false
    const reset = Date.parse(win.reset_at || '')
    return !Number.isFinite(reset) || reset > now
  }
  if (isLiveCap(windows.find((w) => w.id === '5h'))) return 'quota_5h_header'
  if (isLiveCap(windows.find((w) => w.id === '7d'))) return 'quota_7d_header'
  const other = windows.find((w) => w.id !== '5h' && w.id !== '7d' && isLiveCap(w))
  if (other) return `quota_${other.id}_header`
  if (codexQuotaPark(extra, now, { waiveWindowCaps: waived }).limited) return 'quota_5h_header'
  return null
}

function codexRestrictionUntil(vm, now) {
  const extra = extraFromSummary(vm)
  const windows = extractCodexWindows(extraToCodexSnapshot(extra))
  const windowResets = hasSpendableCodexCredits(vm, now) ? [] : windows.map((w) => w.reset_at)
  const futures = [...windowResets, extra.codex_limited_until]
    .map((value) => Date.parse(value || ''))
    .filter((value) => Number.isFinite(value) && value > now)
  return futures.length ? Math.min(...futures) : now + 5 * 60_000
}

function hasQuotaRestriction(vm) {
  const reason = vm?.claude?.temp_unschedulable_reason || vm?.temp_unschedulable_reason
  return isQuotaWindowReason(reason)
}

/**
 * Pure quota-schedule evaluation used by `vm-registry.mjs` (`syncCodexQuotaSchedule`).
 */
export function evaluateCodexQuotaSchedule(vm, now = Date.now(), policy = null) {
  if (!vm || !isCodexVm(vm)) return { action: 'keep', reason: null }
  const hardReason = codexQuotaWindowReason(vm, now)
  const local = evaluateOpenAIQuotaGate(vm, normalizeOpenAIQuotaPolicy(policy), now)
  const reason = hardReason || (local.limited ? local.reason : null)
  const leftover = isLeftoverQuotaScheduleOff(vm)
  if (reason) {
    const until = hardReason ? codexRestrictionUntil(vm, now) : local.until
    return { action: leftover ? 'restore' : 'restrict', reason, until }
  }
  if (policy == null && /_local$/.test(vm?.claude?.temp_unschedulable_reason || vm?.temp_unschedulable_reason || '')) {
    return { action: 'keep', reason: vm?.claude?.temp_unschedulable_reason || vm?.temp_unschedulable_reason }
  }
  if (leftover) return { action: 'enable', reason: null }
  if (hasQuotaRestriction(vm)) return { action: 'clear', reason: null }
  return { action: 'keep', reason: null }
}

/**
 * Pure read-only readiness filter retained ONLY for non-dispatch inspection
 * (e.g. `GET /v1/usage?platform=openai`). Never acts as an inference scheduler.
 */
export function pickCodexSlots(vms, { pin = null, now = Date.now(), quotaPolicy = null, model = null } = {}) {
  const list = Array.isArray(vms) ? vms : []
  if (pin) {
    const vm = list.find((item) => item?.id === pin) || null
    if (!vm || !isCodexVm(vm)) return { error: 'platform_mismatch', pin, ids: [], ready: [], parked: [] }
    const blocked = proxyBlockedReason(vm.proxy)
    if (blocked) return { error: blocked, pin, ids: [], ready: [], parked: [] }
    return { ids: [vm.id], pin, ready: [vm.id], parked: [] }
  }
  const ready = []
  const parked = []
  const resting = []
  let restUntil = null
  for (const vm of list) {
    if (!isCodexSlotReady(vm, now)) continue
    const rest = evaluateActiveHours(activeHoursOf(vm), now, vm.timezone)
    if (!rest.active) {
      resting.push(vm.id)
      if (codexSlotAllowsModel(vm, model)) restUntil = restUntil == null ? rest.until : Math.min(restUntil, rest.until)
      continue
    }
    if (isCodexSlotParked(vm, now, quotaPolicy)) parked.push(vm)
    else ready.push(vm)
  }
  ready.sort((a, b) => {
    const d = codexScheduleLevel(b, now).level - codexScheduleLevel(a, now).level || stressOf(a) - stressOf(b)
    return d !== 0 ? d : String(a.id).localeCompare(String(b.id))
  })
  parked.sort((a, b) => {
    const d = parkUntil(a, now) - parkUntil(b, now)
    return d !== 0 ? d : String(a.id).localeCompare(String(b.id))
  })
  const ids = [...ready, ...parked].map((vm) => vm.id)
  if (!ids.length) {
    if (restUntil != null) return { error: 'pool_resting', retryAt: restUntil, ids: [], ready: [], parked: [], resting }
    return { error: 'no_codex_vm', ids: [], ready: [], parked: [], resting }
  }
  return {
    ids,
    ready: ready.map((vm) => vm.id),
    parked: parked.map((vm) => vm.id),
    resting,
  }
}
