/**
 * Codex post-recovery cooldown + temporary effective P1 overlay (#1874 item ③).
 * Persists in SettingsRepo; hot path uses an in-memory cache with write-through.
 */
import { getVm } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'
import { evaluateOpenAIQuotaGate, normalizeOpenAIQuotaPolicy } from './openai-quota-policy.mjs'
import { isCodexSlotReady, isCodexSlotParked } from './codex-slot-pool.mjs'
import { resolveCredentialScheduleLevel } from './credential-weight.mjs'
import { fiveHourWindowFromCodexVm } from '../admin/vm-test-preheat-window.mjs'
import { normalizeCodexLimits, extraToCodexSnapshot } from '../protocol/codex-usage.mjs'
import { isCodexVmTestTerminalSuccess } from '../admin/vm-test-terminal.mjs'

export const CODEX_RECOVERY_STATE_KEY = 'codex_recovery_state'
export const CODEX_RECOVERY_DEFAULTS_KEY = 'codex_recovery_defaults'
export const RECOVERY_MINUTES_DEFAULT = 15
export const RECOVERY_LEVEL = 1
export const RECOVERY_MINUTES_MAX = 1440

let activeStore = null

export function setCodexRecoveryStore(store) {
  activeStore = store
}

export function getCodexRecoveryStore() {
  return activeStore
}

export function normalizeRecoveryCooldownMinutes(value, { fallback = RECOVERY_MINUTES_DEFAULT } = {}) {
  if (value == null || value === '') return fallback
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number(value)
  if (!Number.isInteger(n) || n < 0 || n > RECOVERY_MINUTES_MAX) return fallback
  return n
}

function resetEpochMs(value) {
  if (value == null || value === '') return null
  const ms = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(ms) ? Math.floor(ms / 1000) * 1000 : null
}

function snapshotResets(vm) {
  const w5 = fiveHourWindowFromCodexVm(null, vm)
  const limits = normalizeCodexLimits(extraToCodexSnapshot(vm?.codex?.extra || vm?.codex_extra || {}))
  return {
    reset5h: resetEpochMs(w5.reset || limits.reset_5h_at || vm?.reset_5h),
    reset7d: resetEpochMs(limits.reset_7d_at || vm?.reset_7d),
  }
}

function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const until = Number(raw.until)
  if (!Number.isFinite(until) || until <= 0) return null
  return {
    until,
    started_at: Number.isFinite(Number(raw.started_at)) ? Number(raw.started_at) : null,
    minutes: normalizeRecoveryCooldownMinutes(raw.minutes),
    reset5h_at: resetEpochMs(raw.reset5h_at),
    reset7d_at: resetEpochMs(raw.reset7d_at),
    base_level: Number.isInteger(raw.base_level) ? raw.base_level : null,
    base_mode: typeof raw.base_mode === 'string' ? raw.base_mode : null,
    rate_limited: raw.rate_limited === true,
    extended: Number.isInteger(raw.extended) ? raw.extended : 0,
  }
}

export function createCodexRecoveryStore({ settingsRepo = null, now = () => Date.now() } = {}) {
  let memory = {}

  function readAll() {
    if (!settingsRepo?.get) return { ...memory }
    try {
      const raw = settingsRepo.get(CODEX_RECOVERY_STATE_KEY, {})
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      return { ...raw }
    } catch {
      return { ...memory }
    }
  }

  function writeAll(next) {
    memory = { ...next }
    settingsRepo?.set?.(CODEX_RECOVERY_STATE_KEY, next)
  }

  function getDefaults() {
    if (!settingsRepo?.get) return { recovery_cooldown_minutes: RECOVERY_MINUTES_DEFAULT }
    try {
      const raw = settingsRepo.get(CODEX_RECOVERY_DEFAULTS_KEY, {})
      return {
        recovery_cooldown_minutes: normalizeRecoveryCooldownMinutes(raw?.recovery_cooldown_minutes),
      }
    } catch {
      return { recovery_cooldown_minutes: RECOVERY_MINUTES_DEFAULT }
    }
  }

  function resolvedMinutes(scheduleMinutes) {
    const fromSchedule =
      scheduleMinutes == null ? null : normalizeRecoveryCooldownMinutes(scheduleMinutes, { fallback: -1 })
    if (fromSchedule != null && fromSchedule >= 0 && scheduleMinutes != null) return fromSchedule
    return getDefaults().recovery_cooldown_minutes
  }

  function get(vmId, at = now()) {
    if (!vmId) return { active: false, state: null, remaining_ms: 0 }
    const state = sanitizeState(readAll()[vmId])
    if (!state || state.until <= at) return { active: false, state, remaining_ms: 0 }
    return { active: true, state, remaining_ms: state.until - at }
  }

  function put(vmId, state) {
    if (!vmId) return null
    const store = readAll()
    if (!state) {
      delete store[vmId]
      writeAll(store)
      return null
    }
    store[vmId] = state
    writeAll(store)
    return state
  }

  function clear(vmId) {
    return put(vmId, null)
  }

  function quotaBelowSoft(vm, policy, at) {
    return !evaluateOpenAIQuotaGate(vm, policy, at).limited && !isCodexSlotParked(vm, at, policy)
  }

  function schedulableHealthy(vm, at) {
    if (!isCodexVm(vm)) return false
    if (proxyBlockedReason(vm.proxy)) return false
    if (!isCodexSlotReady(vm, at)) return false
    if (vm.schedulable === false) return false
    return !!(vm.has_token || vm.has_refresh)
  }

  function resetsRefreshed(vm, before, at) {
    const after = snapshotResets(vm)
    const next5 = after.reset5h
    const prev5 = resetEpochMs(before?.reset5h)
    if (!Number.isFinite(next5) || next5 <= at) return false
    if (Number.isFinite(prev5) && prev5 === next5) return false
    return quotaBelowSoft(vm, normalizeOpenAIQuotaPolicy(), at)
  }

  function tryStartAfterPreheat({
    projectRoot,
    vmId,
    result,
    schedule,
    beforeResets,
    quotaPolicy = null,
    vm: vmOverride = null,
    at = now(),
  } = {}) {
    if (schedule?.mode !== 'preheat') return { started: false, reason: 'not_preheat' }
    const minutes = resolvedMinutes(schedule?.recovery_cooldown_minutes)
    if (minutes === 0) return { started: false, reason: 'cooldown_disabled' }
    if (!isCodexVmTestTerminalSuccess(result)) return { started: false, reason: 'no_terminal' }
    const vm = vmOverride && isCodexVm(vmOverride) ? vmOverride : projectRoot ? getVm(projectRoot, vmId) : null
    if (!vm || !isCodexVm(vm)) return { started: false, reason: 'not_codex' }
    if (!resetsRefreshed(vm, beforeResets, at)) return { started: false, reason: 'reset_not_refreshed' }
    const policy = normalizeOpenAIQuotaPolicy(quotaPolicy)
    if (!quotaBelowSoft(vm, policy, at)) return { started: false, reason: 'above_soft_limit' }
    if (!schedulableHealthy(vm, at)) return { started: false, reason: 'not_schedulable' }
    const base = resolveCredentialScheduleLevel({
      vm,
      manualLevel: vm?.schedule_level_manual ?? undefined,
      now: at,
    })
    const resets = snapshotResets(vm)
    const state = {
      until: at + minutes * 60_000,
      started_at: at,
      minutes,
      reset5h_at: resets.reset5h,
      reset7d_at: resets.reset7d,
      base_level: base.level,
      base_mode: base.mode,
      rate_limited: false,
      extended: 0,
    }
    put(vmId, state)
    return { started: true, state }
  }

  function canClear(vm, policy, at) {
    if (!schedulableHealthy(vm, at)) return false
    if (!quotaBelowSoft(vm, policy, at)) return false
    return true
  }

  function maybeExpire(vmId, { projectRoot, quotaPolicy, vm: directVm } = {}) {
    const at = now()
    const entry = get(vmId, at)
    if (!entry.active || !entry.state) return entry
    if (entry.state.until > at) return entry
    const vm = directVm || (projectRoot ? getVm(projectRoot, vmId) : null)
    if (!vm) return entry
    const policy = normalizeOpenAIQuotaPolicy(quotaPolicy)
    if (entry.state.rate_limited) {
      const extended = {
        ...entry.state,
        until: at + entry.state.minutes * 60_000,
        rate_limited: false,
        extended: (entry.state.extended || 0) + 1,
      }
      put(vmId, extended)
      return get(vmId, at)
    }
    if (canClear(vm, policy, at)) {
      clear(vmId)
      return { active: false, state: null, remaining_ms: 0 }
    }
    const extended = {
      ...entry.state,
      until: at + entry.state.minutes * 60_000,
      extended: (entry.state.extended || 0) + 1,
    }
    put(vmId, extended)
    return get(vmId, at)
  }

  function recordRateLimit(vmId, at = now()) {
    const entry = get(vmId, at)
    if (!entry.active || !entry.state) return false
    const extended = {
      ...entry.state,
      until: Math.max(entry.state.until, at + entry.state.minutes * 60_000),
      rate_limited: true,
      extended: (entry.state.extended || 0) + 1,
    }
    put(vmId, extended)
    return true
  }

  function overlayFor(vmId, at = now()) {
    const entry = get(vmId, at)
    if (!entry.active) return null
    return {
      until: entry.state.until,
      remaining_ms: entry.remaining_ms,
      base_level: entry.state.base_level,
      base_mode: entry.state.base_mode,
    }
  }

  return {
    get,
    put,
    clear,
    getDefaults,
    resolvedMinutes,
    tryStartAfterPreheat,
    maybeExpire,
    recordRateLimit,
    overlayFor,
    snapshotResets,
  }
}

export function codexRecoveryOverlay(vmId, at = Date.now()) {
  const store = activeStore
  if (!store) return null
  store.maybeExpire(vmId, {})
  return store.overlayFor(vmId, at)
}
