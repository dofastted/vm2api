import { extraIsLiveOpen, parseResetMs } from '../pool/quota-window.mjs'
import { summarizeCodexSlot } from '../vm/codex-slot.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'

export function unified5hFromAccount(acc) {
  return acc?.unified?.headers?.['5h'] || acc?.unified?.['5h'] || {}
}

/** Map Codex quota projection (`summarizeCodexSlot` / `usage.quota`) to Extra-style 5h window fields. */
export function fiveHourWindowFromCodexVm(projectRoot, vm) {
  const quota = summarizeCodexSlot(projectRoot, vm)?.usage?.quota || {}
  if (!quota.reset_5h && quota.utilization_5h == null) return {}
  const util = quota.utilization_5h
  const status =
    quota.status_5h === 'limited' || (util != null && Number(util) >= 1) ? 'rate_limited' : quota.status_5h || 'active'
  return {
    reset: quota.reset_5h || null,
    utilization: util ?? null,
    status,
  }
}

export function resolvePreheatFiveHourWindow(vm, { projectRoot, accountQuota } = {}) {
  if (!vm) return {}
  if (isCodexVm(vm)) return fiveHourWindowFromCodexVm(projectRoot, vm)
  const acc = accountQuota
    ?.snapshot?.()
    .accounts?.find((row) => row.vm_id === vm.id || row.account_id === (vm.claude?.account_uuid || vm.account_uuid))
  return unified5hFromAccount(acc)
}

export function preheatWindowState(vm, { projectRoot, accountQuota, now = Date.now() } = {}) {
  const hasCredential = !!(vm?.has_token || vm?.claude?.has_access || vm?.codex?.has_access)
  const schedulable = vm?.schedulable !== false
  const w5 = resolvePreheatFiveHourWindow(vm, { projectRoot, accountQuota })
  if (!w5.reset && w5.utilization == null) {
    return { hasCredential, schedulable, windowLive: false }
  }
  const resetMs = parseResetMs(w5.reset)
  const windowLive =
    extraIsLiveOpen(w5, now) || (Number.isFinite(resetMs) && resetMs > now && Number(w5.utilization) > 0)
  return { hasCredential, schedulable, windowLive }
}

export function preheatNextWindowEnd(vm, { projectRoot, accountQuota } = {}) {
  const w5 = resolvePreheatFiveHourWindow(vm, { projectRoot, accountQuota })
  const resetMs = parseResetMs(w5.reset)
  return Number.isFinite(resetMs) ? resetMs : null
}
