import { extraIsLiveOpen, parseResetMs } from '../pool/quota-window.mjs'
import { buildCodexUsageView, extraToCodexSnapshot, normalizeCodexLimits } from '../protocol/codex-usage.mjs'
import { isCodexSlotParked, codexQuotaWindowReason } from '../pool/codex-slot-pool.mjs'
import {
  OPENAI_QUOTA_DEFAULTS,
  evaluateOpenAIQuotaGate,
  normalizeOpenAIQuotaPolicy,
} from '../pool/openai-quota-policy.mjs'
import { normalizeCodexRouting } from '../protocol/codex-route.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { getVm } from '../vm/vm-registry.mjs'

export function unified5hFromAccount(acc) {
  return acc?.unified?.headers?.['5h'] || acc?.unified?.['5h'] || {}
}

export function unified7dFromAccount(acc) {
  return acc?.unified?.headers?.['7d'] || acc?.unified?.['7d'] || {}
}

/** Whole-second reset timestamps avoid episode-key jitter from sub-second ISO fields. */
export function truncateResetSec(reset) {
  const ms = parseResetMs(reset)
  if (!Number.isFinite(ms)) return null
  return Math.floor(ms / 1000)
}

export function codexPreheatResets(vm, { projectRoot, now = Date.now() } = {}) {
  const loaded = projectRoot && vm?.id ? getVm(projectRoot, vm.id) || vm : vm
  const snapshot = codexSnapshotForPreheat(loaded)
  const limits = normalizeCodexLimits(snapshot)
  return { reset5h: limits.reset_5h_at, reset7d: limits.reset_7d_at }
}

export function claudePreheatResets(vm, accountQuota) {
  const acc = accountQuota
    ?.snapshot?.()
    .accounts?.find((row) => row.vm_id === vm.id || row.account_id === (vm.claude?.account_uuid || vm.account_uuid))
  return {
    reset5h: unified5hFromAccount(acc).reset ?? null,
    reset7d: unified7dFromAccount(acc).reset ?? null,
  }
}

/**
 * Episode identity for auto-renew: one send per vm + account + prior 5h/7d resets.
 * Returns null when no reset anchor is available.
 */
export function preheatRenewEpisodeKey(vm, { projectRoot, accountQuota, now = Date.now() } = {}) {
  if (!vm?.id) return null
  const accountId = String(vm.claude?.account_uuid || vm.account_uuid || vm.codex?.account_id || vm.account_id || vm.id)
  const resets = isCodexVm(vm) ? codexPreheatResets(vm, { projectRoot, now }) : claudePreheatResets(vm, accountQuota)
  const reset5hSec = truncateResetSec(resets.reset5h)
  const reset7dSec = truncateResetSec(resets.reset7d)
  if (reset5hSec == null && reset7dSec == null) return null
  const key = `${vm.id}\x1e${accountId}\x1e${reset5hSec ?? ''}\x1e${reset7dSec ?? ''}`
  return { key, accountId, reset5hSec, reset7dSec }
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

/** Codex preheat gates use global routing only (Codex slots do not honor vm.policy.quota). */
export function preheatOpenAIQuotaPolicy(_vm, routingConfig = null) {
  return normalizeOpenAIQuotaPolicy(normalizeCodexRouting(routingConfig?.codex)?.quota || {})
}

export function preheatWindowStateForVm(
  vm,
  { projectRoot, accountQuota, routingConfig = null, now = Date.now() } = {},
) {
  return preheatWindowState(vm, {
    projectRoot,
    accountQuota,
    now,
    openaiQuotaPolicy: preheatOpenAIQuotaPolicy(vm, routingConfig),
  })
}

/**
 * Production vmTestSchedule `windowState` entry: read `routingConfig.codex?.quota`
 * when the callback runs (routing reload replaces the whole object).
 */
export function preheatWindowStateLikeServer(
  vm,
  getRoutingConfig,
  { projectRoot, accountQuota, now = Date.now() } = {},
) {
  const live = typeof getRoutingConfig === 'function' ? getRoutingConfig() : getRoutingConfig
  const codexQuota = live?.codex?.quota
  return preheatWindowStateForVm(vm, {
    projectRoot,
    accountQuota,
    now,
    routingConfig: { codex: { quota: codexQuota } },
  })
}

function codexPreheatBlockedReason(vm, now, openaiQuotaPolicy) {
  const policy = normalizeOpenAIQuotaPolicy(openaiQuotaPolicy ?? OPENAI_QUOTA_DEFAULTS)
  if (!isCodexSlotParked(vm, now, policy)) return null
  const hard = codexQuotaWindowReason(vm, now)
  if (hard) return hard
  const local = evaluateOpenAIQuotaGate(vm, policy, now)
  if (local.limited && local.reason) return local.reason
  return 'quota_limited'
}

export function preheatWindowState(
  vm,
  { projectRoot, accountQuota, now = Date.now(), openaiQuotaPolicy = OPENAI_QUOTA_DEFAULTS } = {},
) {
  const hasCredential = !!(vm?.has_token || vm?.claude?.has_access || vm?.codex?.has_access)
  const schedulable = vm?.schedulable !== false
  if (isCodexVm(vm)) {
    const blocked = codexPreheatBlockedReason(vm, now, openaiQuotaPolicy)
    if (blocked) {
      return { hasCredential, schedulable, windowLive: true, reason: blocked }
    }
  }
  const w5 = resolvePreheatFiveHourWindow(vm, { projectRoot, accountQuota, now })
  if (!w5.reset && w5.utilization == null) {
    return { hasCredential, schedulable, windowLive: false, reason: null }
  }
  const resetMs = parseResetMs(w5.reset)
  const windowLive =
    extraIsLiveOpen(w5, now) || (Number.isFinite(resetMs) && resetMs > now && Number(w5.utilization) > 0)
  return {
    hasCredential,
    schedulable,
    windowLive,
    reason: windowLive ? 'window_live' : null,
  }
}

export function preheatNextWindowEnd(vm, { projectRoot, accountQuota, now = Date.now() } = {}) {
  const w5 = resolvePreheatFiveHourWindow(vm, { projectRoot, accountQuota, now })
  const resetMs = parseResetMs(w5.reset)
  return Number.isFinite(resetMs) ? resetMs : null
}
