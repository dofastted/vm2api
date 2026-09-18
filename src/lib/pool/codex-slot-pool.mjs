/**
 * GPT slot pool. Claude WRR never sees these VMs (`evaluateSlotGate`
 * returns `codex_vm`). A Codex hop picks here, then failovers on
 * quota/auth before any SSE byte is committed.
 */
import { isCodexVm } from '../vm/vm-kind.mjs'
import { extraToCodexSnapshot, normalizeCodexLimits, codexQuotaPark } from '../protocol/codex-usage.mjs'
import { isQuotaWindowReason } from './availability.mjs'

export const CODEX_FAILOVER_MAX = 4

// `stopped` is leftover Claude docker lifecycle. Codex kernel is independent.
const HARD_UNAVAILABLE = new Set(['dead', 'error', 'disabled'])

export function isCodexSlotReady(vm) {
  if (!vm || !isCodexVm(vm)) return false
  if (vm.schedulable === false) return false
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

/**
 * Same Extra 5h/7d auto-toggle as Claude `syncQuotaSchedule`:
 * spent window → 调度关 (`source:force`); window open → restore iff the
 * off reason is still a quota window (operator 调度关 stays off).
 */
export function evaluateCodexQuotaSchedule(vm, now = Date.now()) {
  if (!vm || !isCodexVm(vm)) return { action: 'keep', reason: null }
  const reason = codexQuotaWindowReason(vm, now)
  if (reason) {
    if (vm.schedulable !== false) return { action: 'disable', reason }
    return { action: 'keep', reason }
  }
  if (vm.schedulable === false && isQuotaWindowReason(vm.schedule_disabled_reason)) {
    return { action: 'enable', reason: null }
  }
  return { action: 'keep', reason: null }
}
