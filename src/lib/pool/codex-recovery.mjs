/**
 * Codex post-recovery cooldown + temporary effective P1 overlay (#1874 item ③).
 * Persisted in SettingsRepo; hot path uses a TTL-backed in-memory cache.
 */
import { getVm } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'
import { evaluateOpenAIQuotaGate, normalizeOpenAIQuotaPolicy } from './openai-quota-policy.mjs'
import { isCodexSlotReady, isCodexSlotParked } from './codex-slot-pool.mjs'
import { resolveCredentialScheduleLevel } from './credential-weight.mjs'
import { fiveHourWindowFromCodexVm } from '../admin/vm-test-preheat-window.mjs'
import { buildCodexUsageView, extraToCodexSnapshot, normalizeCodexLimits } from '../protocol/codex-usage.mjs'

export const CODEX_RECOVERY_STATE_KEY = 'codex_recovery_state'
export const CODEX_RECOVERY_DEFAULTS_KEY = 'codex_recovery_defaults'
export const RECOVERY_MINUTES_DEFAULT = 15
export const RECOVERY_LEVEL = 1
export const RECOVERY_MINUTES_MAX = 1440
/** Total recovery window (base + extensions) may not exceed this multiple of configured minutes. */
export const RECOVERY_EXTEND_MAX_MULTIPLIER = 4
export const RECOVERY_CACHE_TTL_MS = 2_000
export const RECOVERY_WRITE_THROTTLE_MS = 5_000
/** Usage snapshot must be at least this fresh to arm cooldown after preheat. */
export const RECOVERY_SNAPSHOT_FRESH_MS = 15 * 60_000

let activeStore = null

export function setCodexRecoveryStore(store) {
  activeStore = store
}

export function getCodexRecoveryStore() {
  return activeStore
}

export function parseRecoveryCooldownMinutesStrict(value) {
  if (value == null || value === '') return { ok: true, value: null }
  if (typeof value === 'boolean' || Array.isArray(value) || typeof value === 'object') {
    return { ok: false, value: null }
  }
  if (typeof value === 'string') {
    if (value !== value.trim()) return { ok: false, value: null }
    if (!/^\d+$/.test(value)) return { ok: false, value: null }
    const n = Number(value)
    if (!Number.isInteger(n) || n < 0 || n > RECOVERY_MINUTES_MAX) return { ok: false, value: null }
    return { ok: true, value: n }
  }
  if (!Number.isInteger(value) || value < 0 || value > RECOVERY_MINUTES_MAX) return { ok: false, value: null }
  return { ok: true, value }
}

export function normalizeRecoveryCooldownMinutes(value, { fallback = RECOVERY_MINUTES_DEFAULT } = {}) {
  const parsed = parseRecoveryCooldownMinutesStrict(value)
  if (!parsed.ok) return fallback
  if (parsed.value == null) return fallback
  return parsed.value
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

export function codexQuotaSnapshotFresh(vm, at = Date.now(), maxAgeMs = RECOVERY_SNAPSHOT_FRESH_MS) {
  const extra = vm?.codex?.extra || vm?.codex_extra || {}
  const view = buildCodexUsageView(extraToCodexSnapshot(extra))
  const updated = Date.parse(view.snapshot?.updated_at || extra.codex_usage_updated_at || '')
  if (!Number.isFinite(updated)) return false
  return at - updated >= 0 && at - updated <= maxAgeMs
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

function maxCooldownUntil(state) {
  const started = Number.isFinite(state.started_at) ? state.started_at : state.until - state.minutes * 60_000
  return started + state.minutes * 60_000 * RECOVERY_EXTEND_MAX_MULTIPLIER
}

function clampUntil(state, proposedUntil) {
  return Math.min(proposedUntil, maxCooldownUntil(state))
}

export function createCodexRecoveryStore({ settingsRepo = null, now = () => Date.now() } = {}) {
  let memoryFallback = {}
  let cacheSnapshot = null
  let cacheAt = 0
  const lastWrite = new Map()

  function readAll(force = false) {
    const at = now()
    if (!force && cacheSnapshot && at - cacheAt < RECOVERY_CACHE_TTL_MS) return { ...cacheSnapshot }
    if (!settingsRepo?.get) return { ...memoryFallback }
    try {
      const raw = settingsRepo.get(CODEX_RECOVERY_STATE_KEY, {})
      const next = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
      cacheSnapshot = next
      cacheAt = at
      memoryFallback = { ...next }
      return { ...next }
    } catch {
      if (cacheSnapshot) return { ...cacheSnapshot }
      return { ...memoryFallback }
    }
  }

  function writeAll(next, { force = false } = {}) {
    memoryFallback = { ...next }
    cacheSnapshot = { ...next }
    cacheAt = now()
    if (!settingsRepo?.set) return
    if (!force) return
    settingsRepo.set(CODEX_RECOVERY_STATE_KEY, next)
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
    if (scheduleMinutes != null) {
      const parsed = parseRecoveryCooldownMinutesStrict(scheduleMinutes)
      if (parsed.ok && parsed.value != null) return parsed.value
    }
    return getDefaults().recovery_cooldown_minutes
  }

  function viewForState(state, at) {
    if (!state) return { active: false, state: null, remaining_ms: 0, expired: false }
    if (state.until > at) {
      return { active: true, state, remaining_ms: state.until - at, expired: false }
    }
    return { active: false, state, remaining_ms: 0, expired: true }
  }

  function get(vmId, at = now()) {
    if (!vmId) return { active: false, state: null, remaining_ms: 0, expired: false }
    const state = sanitizeState(readAll()[vmId])
    return viewForState(state, at)
  }

  function persistVm(vmId, state, { force = false } = {}) {
    if (!vmId) return null
    const store = readAll(true)
    if (!state) {
      delete store[vmId]
      lastWrite.delete(vmId)
      writeAll(store, { force: true })
      return null
    }
    const at = now()
    const prev = lastWrite.get(vmId)
    const memoryOnly =
      !force &&
      prev &&
      at - prev.at < RECOVERY_WRITE_THROTTLE_MS &&
      prev.until === state.until &&
      prev.rate_limited === state.rate_limited
    store[vmId] = state
    writeAll(store, { force: !memoryOnly })
    if (!memoryOnly) lastWrite.set(vmId, { at, until: state.until, rate_limited: state.rate_limited })
    return state
  }

  function put(vmId, state, opts = {}) {
    return persistVm(vmId, state, opts)
  }

  function clear(vmId) {
    return persistVm(vmId, null, { force: true })
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

  function resetsRefreshed(vm, before, at, policy) {
    const after = snapshotResets(vm)
    const next5 = after.reset5h
    const prev5 = resetEpochMs(before?.reset5h)
    if (!Number.isFinite(next5) || next5 <= at) return false
    if (Number.isFinite(prev5) && prev5 === next5) return false
    return quotaBelowSoft(vm, normalizeOpenAIQuotaPolicy(policy), at)
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
    if (!result?.ok) return { started: false, reason: 'not_ok' }
    const vm = vmOverride && isCodexVm(vmOverride) ? vmOverride : projectRoot ? getVm(projectRoot, vmId) : null
    if (!vm || !isCodexVm(vm)) return { started: false, reason: 'not_codex' }
    if (!codexQuotaSnapshotFresh(vm, at)) return { started: false, reason: 'stale_snapshot' }
    if (!resetsRefreshed(vm, beforeResets, at, quotaPolicy)) return { started: false, reason: 'reset_not_refreshed' }
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
    put(vmId, state, { force: true })
    return { started: true, state }
  }

  function canClear(vm, policy, at) {
    if (!schedulableHealthy(vm, at)) return false
    if (!codexQuotaSnapshotFresh(vm, at)) return false
    if (!quotaBelowSoft(vm, policy, at)) return false
    return true
  }

  function extendCooldown(state, at, { rateLimited = false } = {}) {
    const nextUntil = clampUntil(state, at + state.minutes * 60_000)
    if (nextUntil <= at) return null
    return {
      ...state,
      until: nextUntil,
      rate_limited: rateLimited,
      extended: (state.extended || 0) + 1,
    }
  }

  function maybeExpire(vmId, { projectRoot, quotaPolicy, vm: directVm } = {}) {
    const at = now()
    const state = sanitizeState(readAll()[vmId])
    if (!state) return { active: false, state: null, remaining_ms: 0, expired: false }
    if (state.until > at) return viewForState(state, at)
    const vm = directVm || (projectRoot ? getVm(projectRoot, vmId) : null)
    const policy = normalizeOpenAIQuotaPolicy(quotaPolicy)

    if (state.rate_limited) {
      const next = extendCooldown({ ...state, rate_limited: true }, at)
      if (!next) {
        clear(vmId)
        return { active: false, state: null, remaining_ms: 0, expired: false }
      }
      put(vmId, { ...next, rate_limited: false }, { force: true })
      return get(vmId, at)
    }

    if (vm && canClear(vm, policy, at)) {
      clear(vmId)
      return { active: false, state: null, remaining_ms: 0, expired: false }
    }

    const next = extendCooldown(state, at)
    if (!next) {
      clear(vmId)
      return { active: false, state: null, remaining_ms: 0, expired: false }
    }
    put(vmId, next, { force: true })
    return get(vmId, at)
  }

  function recordRateLimit(vmId, at = now()) {
    const entry = get(vmId, at)
    if (!entry.state) return false
    const activeOrExpired = entry.active || entry.expired
    if (!activeOrExpired) return false
    const prevWrite = lastWrite.get(vmId)
    if (prevWrite && at - prevWrite.at < RECOVERY_WRITE_THROTTLE_MS && entry.state.rate_limited === true) {
      return true
    }
    const bumpedUntil = clampUntil(entry.state, Math.max(entry.state.until, at + entry.state.minutes * 60_000))
    if (bumpedUntil <= at) return false
    const next = {
      ...entry.state,
      until: bumpedUntil,
      rate_limited: true,
      extended: (entry.state.extended || 0) + 1,
    }
    const shouldPersist = !prevWrite || entry.state.rate_limited !== true || at - prevWrite.at >= RECOVERY_WRITE_THROTTLE_MS
    put(vmId, next, { force: shouldPersist })
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
    setDefaults(value) {
      if (!settingsRepo?.set) return getDefaults()
      settingsRepo.set(CODEX_RECOVERY_DEFAULTS_KEY, value)
      return getDefaults()
    },
    resolvedMinutes,
    tryStartAfterPreheat,
    maybeExpire,
    recordRateLimit,
    overlayFor,
    snapshotResets,
    /** test hook */
    _readAll: readAll,
    _flushCache: () => {
      cacheSnapshot = null
      cacheAt = 0
    },
  }
}

export function codexRecoveryOverlay(vmId, at = Date.now(), opts = {}) {
  const store = activeStore
  if (!store) return null
  store.maybeExpire(vmId, opts)
  return store.overlayFor(vmId, at)
}
