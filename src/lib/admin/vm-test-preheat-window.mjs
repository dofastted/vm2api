import { extraIsLiveOpen, parseResetMs } from '../pool/quota-window.mjs'
import { buildCodexUsageView, extraToCodexSnapshot, normalizeCodexLimits } from '../protocol/codex-usage.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { getVm } from '../vm/vm-registry.mjs'

export function unified5hFromAccount(acc) {
  return acc?.unified?.headers?.['5h'] || acc?.unified?.['5h'] || {}
}

function codexSnapshotForPreheat(loaded) {
  const extra = loaded.codex?.extra || loaded.codex_extra || {}
  if (Object.keys(extra).length) return extraToCodexSnapshot(extra)
  const usage = loaded.codex?.usage
  if (usage && typeof usage === 'object' && Object.hasOwn(usage, 'primary_used_percent')) return usage
  if (usage?.snapshot && Object.hasOwn(usage.snapshot, 'primary_used_percent')) return usage.snapshot
  return extraToCodexSnapshot(extra)
}

/** Map Codex extra to Extra-style 5h window fields for preheat probes. */
export function fiveHourWindowFromCodexVm(projectRoot, vm, now = Date.now()) {
  const loaded = projectRoot && vm?.id ? getVm(projectRoot, vm.id) || vm : vm
  const snapshot = codexSnapshotForPreheat(loaded)
  const quota = buildCodexUsageView(snapshot, now).quota || {}
  // Panel quota nulls elapsed resets (#1920); keep-warm still needs the raw end time to arm sweeps.
  const limitsReset = normalizeCodexLimits(snapshot).reset_5h_at
  if (!limitsReset && quota.utilization_5h == null) return {}
  const util = quota.utilization_5h
  const status =
    quota.status_5h === 'limited' || (util != null && Number(util) >= 1) ? 'rate_limited' : quota.status_5h || 'active'
  return {
    reset: limitsReset || null,
    utilization: util ?? null,
    status,
  }
}

export function resolvePreheatFiveHourWindow(vm, { projectRoot, accountQuota, now = Date.now() } = {}) {
  if (!vm) return {}
  if (isCodexVm(vm)) return fiveHourWindowFromCodexVm(projectRoot, vm, now)
  const acc = accountQuota
    ?.snapshot?.()
    .accounts?.find((row) => row.vm_id === vm.id || row.account_id === (vm.claude?.account_uuid || vm.account_uuid))
  return unified5hFromAccount(acc)
}

export function preheatWindowState(vm, { projectRoot, accountQuota, now = Date.now() } = {}) {
  const hasCredential = !!(vm?.has_token || vm?.claude?.has_access || vm?.codex?.has_access)
  const schedulable = vm?.schedulable !== false
  const w5 = resolvePreheatFiveHourWindow(vm, { projectRoot, accountQuota, now })
  if (!w5.reset && w5.utilization == null) {
    return { hasCredential, schedulable, windowLive: false }
  }
  const resetMs = parseResetMs(w5.reset)
  const windowLive =
    extraIsLiveOpen(w5, now) || (Number.isFinite(resetMs) && resetMs > now && Number(w5.utilization) > 0)
  return { hasCredential, schedulable, windowLive }
}

export function preheatNextWindowEnd(vm, { projectRoot, accountQuota, now = Date.now() } = {}) {
  const w5 = resolvePreheatFiveHourWindow(vm, { projectRoot, accountQuota, now })
  const resetMs = parseResetMs(w5.reset)
  return Number.isFinite(resetMs) ? resetMs : null
}
