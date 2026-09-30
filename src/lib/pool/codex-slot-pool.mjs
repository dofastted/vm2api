/**
 * GPT slot pool. Claude WRR never sees these VMs (`evaluateSlotGate`
 * returns `codex_vm`). A Codex hop picks here, then failovers on
 * quota/auth before any SSE byte is committed.
 */
import { isCodexVm } from '../vm/vm-kind.mjs'
import { extraToCodexSnapshot, normalizeCodexLimits, codexQuotaPark } from '../protocol/codex-usage.mjs'
import { isLeftoverQuotaScheduleOff, isQuotaWindowReason } from './availability.mjs'
import { orderOpenAIAccounts } from './openai-account-selector.mjs'
import { bumpOpenAICursor, openAIRuntimeSignals, readOpenAICursor } from './openai-account-runtime.mjs'
import { modelMatchesAllowlist } from './slot-model-gate.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'

// `stopped` is leftover Claude docker lifecycle. Codex kernel is independent.
const HARD_UNAVAILABLE = new Set(['dead', 'error', 'disabled'])

export function isCodexSlotReady(vm) {
  if (!vm || !isCodexVm(vm)) return false
  if (proxyBlockedReason(vm.proxy)) return false
  if (vm.schedulable === false && !isLeftoverQuotaScheduleOff(vm)) return false
  if (!vm.has_token) return false
  const status = String(vm.status || '').toLowerCase()
  if (HARD_UNAVAILABLE.has(status)) return false
  return true
}

export function isCodexSlotParked(vm, now = Date.now()) {
  const until = Date.parse(vm?.codex_limited_until || '')
  if (Number.isFinite(until) && until > now) return true
  return extraPark(vm, now).limited
}

function extraPark(vm, now) {
  const extra = extraFromSummary(vm)
  return codexQuotaPark(extra, now)
}

function extraFromSummary(vm) {
  if (vm?.codex?.extra && typeof vm.codex.extra === 'object') return vm.codex.extra
  if (vm?.codex_extra && typeof vm.codex_extra === 'object') return vm.codex_extra
  const usage = vm?.codex_usage
  const windows = Array.isArray(usage?.windows) ? usage.windows : []
  const w5 = windows.find((w) => w?.id === '5h') || {}
  const w7 = windows.find((w) => w?.id === '7d') || {}
  const limits = usage?.limits || {}
  return {
    codex_5h_used_percent: w5.used_percent ?? limits.used_5h_percent,
    codex_7d_used_percent: w7.used_percent ?? limits.used_7d_percent,
    codex_5h_reset_at: w5.reset_at ?? limits.reset_5h_at ?? vm?.reset_5h,
    codex_7d_reset_at: w7.reset_at ?? limits.reset_7d_at ?? vm?.reset_7d,
    codex_5h_window_minutes: w5.window_minutes ?? limits.window_5h_minutes ?? 300,
    codex_7d_window_minutes: w7.window_minutes ?? limits.window_7d_minutes ?? 10080,
    codex_limited_until: vm?.codex_limited_until || null,
  }
}

function stressOf(vm) {
  const u5 = Number(vm?.utilization_5h)
  const u7 = Number(vm?.utilization_7d)
  if (!Number.isFinite(u5) && !Number.isFinite(u7)) {
    const limits = normalizeCodexLimits(extraToCodexSnapshot(extraFromSummary(vm)))
    const p5 = Number(limits.used_5h_percent)
    const p7 = Number(limits.used_7d_percent)
    const a = Number.isFinite(p5) ? p5 / 100 : 0
    const b = Number.isFinite(p7) ? p7 / 100 : 0
    return Math.max(a, b)
  }
  return Math.max(Number.isFinite(u5) ? u5 : 0, Number.isFinite(u7) ? u7 : 0)
}

function parkUntil(vm, now) {
  const until = Date.parse(vm?.codex_limited_until || '')
  if (Number.isFinite(until)) return until
  return extraPark(vm, now).until || now
}

/**
 * Ordered candidate ids. Pinned master hops stay on that slot.
 * Ready slots first (lowest 5h/7d stress), parked slots last so a
 * total-exhaust pool still has somewhere to fail instead of 503.
 */
export function pickCodexSlots(vms, { pin = null, now = Date.now() } = {}) {
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
  for (const vm of list) {
    if (!isCodexSlotReady(vm)) continue
    if (isCodexSlotParked(vm, now)) parked.push(vm)
    else ready.push(vm)
  }
  ready.sort((a, b) => {
    const d = stressOf(a) - stressOf(b)
    return d !== 0 ? d : String(a.id).localeCompare(String(b.id))
  })
  parked.sort((a, b) => {
    const d = parkUntil(a, now) - parkUntil(b, now)
    return d !== 0 ? d : String(a.id).localeCompare(String(b.id))
  })
  const ids = [...ready, ...parked].map((vm) => vm.id)
  if (!ids.length) return { error: 'no_codex_vm', ids: [], ready: [], parked: [] }
  return {
    ids,
    ready: ready.map((vm) => vm.id),
    parked: parked.map((vm) => vm.id),
  }
}

function quotaRemainingRank(vm) {
  const u5 = Number(vm?.utilization_5h)
  const u7 = Number(vm?.utilization_7d)
  let used = null
  if (Number.isFinite(u5) || Number.isFinite(u7)) {
    used = Math.max(Number.isFinite(u5) ? u5 : 0, Number.isFinite(u7) ? u7 : 0)
  } else {
    const limits = normalizeCodexLimits(extraToCodexSnapshot(extraFromSummary(vm)))
    const p5 = Number(limits.used_5h_percent)
    const p7 = Number(limits.used_7d_percent)
    if (Number.isFinite(p5) || Number.isFinite(p7)) {
      used = Math.max(Number.isFinite(p5) ? p5 / 100 : 0, Number.isFinite(p7) ? p7 / 100 : 0)
    }
  }
  if (used == null) return null
  return Math.round((1 - Math.min(1, Math.max(0, used))) * 10_000)
}

function quotaResetAt(vm) {
  const extra = extraFromSummary(vm)
  const limits = normalizeCodexLimits(extraToCodexSnapshot(extra))
  const resets = [limits.reset_5h_at, limits.reset_7d_at, vm?.reset_5h, vm?.reset_7d]
    .map((value) => Date.parse(value || ''))
    .filter((value) => Number.isFinite(value))
  if (!resets.length) return null
  return Math.min(...resets)
}

export function codexAccountStatus(vm, now = Date.now()) {
  if (!vm || !isCodexVm(vm)) return 'error'
  if (proxyBlockedReason(vm.proxy)) return 'disabled'
  if (vm.schedulable === false && !isLeftoverQuotaScheduleOff(vm)) return 'disabled'
  const status = String(vm.status || '').toLowerCase()
  if (status === 'disabled') return 'disabled'
  if (status === 'dead' || status === 'error') return 'error'
  if (!vm.has_token) return 'error'
  if (isCodexSlotParked(vm, now) || codexQuotaWindowReason(vm, now)) return 'quota_exhausted'
  return 'normal'
}

/** listVms() hands out summaries (`max_concurrency`); getVm() hands out raw records (`policy`). */
function policyNumber(vm, summaryKey, policyKey) {
  const n = Number(vm?.[summaryKey] ?? vm?.policy?.[policyKey])
  return Number.isFinite(n) ? n : null
}

/** Panel allowlist on a GPT slot. No model or no list means allowed. */
export function codexSlotAllowsModel(vm, model) {
  if (!model) return true
  return modelMatchesAllowlist(model, vm?.allowed_models ?? vm?.policy?.allowed_models)
}

export function codexAccountCandidate(vm, now = Date.now(), signals = null) {
  const runtime = signals || openAIRuntimeSignals(vm?.id, now)
  const concurrency = policyNumber(vm, 'max_concurrency', 'maxConcurrency')
  const maxRpm = policyNumber(vm, 'max_rpm', 'maxRpm')
  return {
    id: vm.id,
    weight: Number(vm?.policy?.weight ?? vm?.weight ?? 1) || 1,
    concurrency: concurrency > 0 ? concurrency : 2,
    maxRpm: maxRpm > 0 ? maxRpm : 0,
    rpmCount: runtime.rpmCount || 0,
    rpmResetAt: runtime.rpmResetAt ?? null,
    status: codexAccountStatus(vm, now),
    inFlight: runtime.inFlight || 0,
    lastStartedAt: runtime.lastStartedAt ?? null,
    quotaResetAt: quotaResetAt(vm),
    quotaRemainingRank: quotaRemainingRank(vm),
    failureRateBps: runtime.failureRateBps || 0,
    firstOutputLatencyMs: runtime.firstOutputLatencyMs ?? null,
  }
}

/**
 * OpenAI pool order. Session affinity is a preferred account.
 * Remaining ids are the same decision with that account excluded.
 * Quota-exhausted slots stay out of the hop list.
 *
 * `home` is the live bound slot. Only it (or any slot when there is none)
 * owes the conversation a `max_sessions` window; any other slot lends this
 * one request its execution seat. `session_slots` is not a window cap.
 * `boundState` is `gone` only when the bound slot left the pool for good
 * (quota, credential, operator, model); a busy home is still `live`.
 */
export function orderCodexSessionSlots(
  vms,
  {
    pin = null,
    boundVmId = null,
    sessionKey = null,
    sessionLimit = null,
    idleMin = 5,
    now = Date.now(),
    strategy = 'smart',
    requestIntervalMs = 0,
    roundRobinCursor = null,
    model = null,
    excluded = null,
  } = {},
) {
  const list = Array.isArray(vms) ? vms : []
  const byId = new Map(list.map((vm) => [vm.id, vm]))
  const found = pickCodexSlots(vms, { pin, now })
  const picked = found.error ? found : withModelAllowed(found, byId, model)
  if (picked.error) return { ...picked, sticky: false, candidates: [] }
  const pool = picked.ids.filter((id) => !excluded?.has(id))
  if (!pool.length)
    return { error: 'candidates_exhausted', ids: [], ready: [], parked: [], sticky: false, candidates: [] }
  if (pin) {
    return {
      ...picked,
      ids: pool,
      sticky: false,
      candidates: pool.map((id) => codexAccountCandidate(byId.get(id), now)),
    }
  }
  const home =
    boundVmId && pool.includes(boundVmId) && codexAccountStatus(byId.get(boundVmId), now) === 'normal'
      ? boundVmId
      : null
  const boundState = boundVmId ? (home ? 'live' : excluded?.has(boundVmId) ? 'excluded' : 'gone') : null
  const claimsWindow = (id) => !!sessionKey && (!home || id === home)
  const accepts = (id) => {
    if (!claimsWindow(id) || typeof sessionLimit?.canAccept !== 'function') return true
    const cap = codexMaxSessions(byId.get(id))
    if (!cap) return true
    return sessionLimit.canAccept(id, sessionKey, { max: cap, idleMin, now }).ok !== false
  }
  const ids = pool.filter(accepts)
  if (!ids.length) {
    return { error: 'session_window_full', ids: [], ready: [], parked: [], sticky: false, boundState, candidates: [] }
  }
  const cursor = roundRobinCursor == null ? readOpenAICursor() : roundRobinCursor
  const candidates = ids.map((id) => codexAccountCandidate(byId.get(id), now))
  const ordered = orderOpenAIAccounts(candidates, {
    strategy,
    now,
    requestIntervalMs,
    preferredAccountId: home && ids.includes(home) ? home : null,
    preferredOverridesWeight: true,
    roundRobinCursor: cursor,
  })
  if (!ordered.ids.length) {
    const statuses = ids.map((id) => codexAccountStatus(byId.get(id), now))
    const quotaExhausted = statuses.length > 0 && statuses.every((status) => status === 'quota_exhausted')
    return {
      error: quotaExhausted ? 'quota_exhausted' : 'capacity_unavailable',
      retryAt: quotaExhausted ? null : rpmRetryAt(candidates, now),
      ids: [],
      ready: [],
      parked: picked.parked || [],
      sticky: false,
      boundState,
      home,
      candidates: [],
    }
  }
  if (roundRobinCursor == null) bumpOpenAICursor()
  const sticky = ordered.preferred === 'hit' && ordered.ids[0] === boundVmId
  return {
    ...picked,
    ids: ordered.ids,
    ready: ordered.ids.filter((id) => (picked.ready || []).includes(id)),
    parked: (picked.parked || []).filter((id) => ordered.ids.includes(id)),
    sticky,
    strategy,
    boundState,
    home,
    candidates: ordered.ids.map((id) => candidates.find((candidate) => candidate.id === id)),
  }
}

/** Distinct conversation windows on a GPT slot. 0 = off. */
export function codexMaxSessions(vm) {
  const n = policyNumber(vm, 'max_sessions', 'maxSessions')
  return n > 0 ? Math.round(n) : 0
}

/** Earliest RPM window opening among normal slots capped only by RPM. */
function rpmRetryAt(candidates, now) {
  const times = candidates
    .filter((c) => c.status === 'normal' && c.maxRpm > 0 && c.rpmCount >= c.maxRpm && c.inFlight < c.concurrency)
    .map((c) => Number(c.rpmResetAt))
    .filter((t) => Number.isFinite(t) && t > now)
  return times.length ? Math.min(...times) : null
}

function withModelAllowed(picked, byId, model) {
  if (!model) return picked
  const keep = (id) => codexSlotAllowsModel(byId.get(id), model)
  const ids = picked.ids.filter(keep)
  if (!ids.length) return { error: 'model_not_allowed', ids: [], ready: [], parked: [] }
  return {
    ...picked,
    ids,
    ready: (picked.ready || []).filter(keep),
    parked: (picked.parked || []).filter(keep),
  }
}

export function isCodexFailoverError(result) {
  if (!result || result.ok === true || result.committed === true) return false
  const status = Number(result.status) || 0
  const code = String(result.body?.error?.code || result.error_code || '')
  if (status === 429 || status === 401 || status === 403) return true
  return /usage_limit_reached|upstream_auth|no_credential|sticky_unavailable/.test(code)
}

export function codexQuotaWindowReason(vm, now = Date.now()) {
  const extra = extraFromSummary(vm)
  const limits = normalizeCodexLimits(extraToCodexSnapshot(extra))
  const used5 = Number(limits.used_5h_percent)
  const used7 = Number(limits.used_7d_percent)
  const reset5 = Date.parse(limits.reset_5h_at || '')
  const reset7 = Date.parse(limits.reset_7d_at || '')
  const live5 = Number.isFinite(used5) && used5 >= 100 && (!Number.isFinite(reset5) || reset5 > now)
  const live7 = Number.isFinite(used7) && used7 >= 100 && (!Number.isFinite(reset7) || reset7 > now)
  if (live5) return 'quota_5h_header'
  if (live7) return 'quota_7d_header'
  if (codexQuotaPark(extra, now).limited) return 'quota_5h_header'
  return null
}

function codexRestrictionUntil(vm, now) {
  const extra = extraFromSummary(vm)
  const limits = normalizeCodexLimits(extraToCodexSnapshot(extra))
  const reset5 = Date.parse(limits.reset_5h_at || '')
  const reset7 = Date.parse(limits.reset_7d_at || '')
  const park = Date.parse(extra.codex_limited_until || '')
  const futures = [reset5, reset7, park].filter((value) => Number.isFinite(value) && value > now)
  return futures.length ? Math.min(...futures) : now + 5 * 60_000
}

function hasQuotaRestriction(vm) {
  const reason = vm?.claude?.temp_unschedulable_reason || vm?.temp_unschedulable_reason
  return isQuotaWindowReason(reason)
}

/**
 * Extra 5h/7d writes restriction, not 调度关. Leftover quota-off
 * (not schedule_manual) restores the operator switch.
 */
export function evaluateCodexQuotaSchedule(vm, now = Date.now()) {
  if (!vm || !isCodexVm(vm)) return { action: 'keep', reason: null }
  const reason = codexQuotaWindowReason(vm, now)
  const leftover = isLeftoverQuotaScheduleOff(vm)
  if (reason) {
    const until = codexRestrictionUntil(vm, now)
    return { action: leftover ? 'restore' : 'restrict', reason, until }
  }
  if (leftover) return { action: 'enable', reason: null }
  if (hasQuotaRestriction(vm)) return { action: 'clear', reason: null }
  return { action: 'keep', reason: null }
}
