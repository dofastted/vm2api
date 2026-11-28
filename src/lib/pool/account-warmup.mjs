/**
 * Account warm-up state machine.
 *
 * New subscription accounts are ramped into the pool slowly instead of being
 * handed full traffic on day one: a low rpm pin plus a graduation gate
 * (time served *and* real successful requests *and* no recent fatal errors).
 * The engine only manages state it created — any operator action on the same
 * fields wins:
 *
 *   operator clears the rpm pin      -> warm-up exits (operator override)
 *   operator changes the pin value   -> engine follows the new value
 *   slot leaves pool / unschedulable -> accumulation pauses (no credit)
 *   credentials swapped on the slot  -> caller resets via startWarmup()
 *
 * All writes happen under withVmLock by the caller; this module stays pure.
 */
import path from 'node:path'
import { withVmLock } from '../vm/vm-file.mjs'

export const DEFAULT_WARMUP = Object.freeze({
  enabled: false,
  target_rpm: 30,
  min_hours: 24,
  min_requests: 100,
  fatal_window_hours: 6,
  interval_sec: 600,
  max_events: 20,
})

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, n))
}

function asBool(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return fallback
}

export function normalizeWarmupConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: asBool(src.enabled, DEFAULT_WARMUP.enabled),
    target_rpm: clampNum(src.target_rpm, 1, 200, DEFAULT_WARMUP.target_rpm),
    min_hours: clampNum(src.min_hours, 1, 720, DEFAULT_WARMUP.min_hours),
    min_requests: clampNum(src.min_requests, 1, 1_000_000, DEFAULT_WARMUP.min_requests),
    fatal_window_hours: clampNum(src.fatal_window_hours, 1, 168, DEFAULT_WARMUP.fatal_window_hours),
    interval_sec: clampNum(src.interval_sec, 60, 3600, DEFAULT_WARMUP.interval_sec),
    max_events: clampNum(src.max_events, 1, 200, DEFAULT_WARMUP.max_events),
  }
}

/** Error classes that block graduation: credential / risk / kernel level. */
export const FATAL_ERROR_SQL = `(error_code LIKE 'upstream_auth%' OR error_code LIKE 'oauth%'
  OR error_code IN ('refusal_guard','kernel_unavailable','upstream_forbidden')
  OR error_message LIKE '%organization%')`

export function warmupOf(vm) {
  const w = vm?.policy?.warmup
  if (!w || typeof w !== 'object' || !w.started_at) return null
  return w
}

export function isWarming(vm) {
  return warmupOf(vm) !== null
}

function pushEvent(w, event, now, maxEvents) {
  w.events = Array.isArray(w.events) ? w.events : []
  w.events.push({ at: now, ...event })
  if (w.events.length > maxEvents) w.events = w.events.slice(-maxEvents)
}

/**
 * Enter (or restart) warm-up for a slot. Caller must hold the vm lock via
 * `withVmLock(vmPath)` and sync the updated policy to the scheduler runtime.
 */
export function startWarmup(
  vm,
  { targetRpm, baseSuccessRequests = 0, now = new Date().toISOString(), config = DEFAULT_WARMUP } = {},
) {
  const policy = (vm.policy = vm.policy || {})
  const target = clampNum(targetRpm ?? config.target_rpm, 1, 200, config.target_rpm)
  const restarted = warmupOf(vm) !== null
  policy.warmup = {
    started_at: now,
    target_rpm: target,
    accumulated_minutes: 0,
    base_success_requests: baseSuccessRequests,
    events: [{ at: now, kind: restarted ? 'restart' : 'start', target_rpm: target }],
  }
  policy.maxRpm = target
  policy.rpmOverride = true
  return policy.warmup
}

/** Remove the warm-up segment only (keep the pin — used on operator override exit). */
export function clearWarmup(vm, reason, now = new Date().toISOString(), config = DEFAULT_WARMUP) {
  const w = warmupOf(vm)
  if (!w) return null
  const last = { at: now, kind: 'exit', reason }
  const events = [...(Array.isArray(w.events) ? w.events : []), last].slice(-config.max_events)
  delete vm.policy.warmup
  return { exited: w, events }
}

/**
 * Graduate: clear the warm-up segment and drop the manual override flag.
 * Never writes `maxRpm = null` (which would bypass tier/default RPM limits);
 * callers pass `inheritedRpm` or immediately invoke `inheritVmScheduling(id, { rpm: true })`
 * under the same vm lock to restore the slot's tier/default RPM cap.
 */
export function graduateWarmup(vm, now = new Date().toISOString(), { inheritedRpm } = {}) {
  const w = warmupOf(vm)
  if (!w) return null
  const record = {
    graduated_at: now,
    started_at: w.started_at,
    accumulated_minutes: w.accumulated_minutes || 0,
    target_rpm: w.target_rpm,
  }
  delete vm.policy.warmup
  if (inheritedRpm != null && Number.isFinite(Number(inheritedRpm))) {
    vm.policy.maxRpm = Math.max(0, Math.min(1e6, Number(inheritedRpm) || 0))
  } else {
    delete vm.policy.maxRpm
  }
  vm.policy.rpmOverride = false
  return record
}

/**
 * Pure decision step. `snapshot` describes the world outside vm.json:
 *
 *   pinnedRpm   number|null  effective manual pin (null when unpinned)
 *   schedulable boolean
 *   inPool      boolean
 *   recentFatal number       fatal errors inside the fatal window
 *   successRequests number    successful requests since base_success_requests
 *
 * Returns the action the monitor should apply under the vm lock.
 */
export function evaluateWarmup(vm, snapshot, config = DEFAULT_WARMUP) {
  const w = warmupOf(vm)
  if (!w) return { action: 'none' }
  const { pinnedRpm = null, schedulable = true, inPool = true, recentFatal = 0, successRequests = 0 } = snapshot || {}

  // Operator cleared the pin entirely -> operator override, engine exits.
  if (pinnedRpm == null) return { action: 'exit', reason: 'operator_override' }

  // Operator retuned the pin -> follow, never write back over a human.
  if (Number(pinnedRpm) !== Number(w.target_rpm)) {
    return { action: 'follow', targetRpm: Number(pinnedRpm) }
  }

  if (!schedulable || !inPool) return { action: 'pause' }

  if (recentFatal > 0) return { action: 'hold_fatal', recentFatal }

  const minutes = Number(w.accumulated_minutes) || 0
  if (minutes >= config.min_hours * 60 && successRequests >= config.min_requests) {
    return { action: 'graduate' }
  }
  return { action: 'accumulate' }
}

/** Panel-facing phase label. */
export function warmupPhase(vm, { schedulable = true, recentFatal = 0 } = {}) {
  const w = warmupOf(vm)
  if (!w) return null
  if (recentFatal > 0) return 'abnormal'
  if (!schedulable) return 'paused'
  return 'warming'
}

/**
 * Apply a monitor decision under the vm path lock (`withVmLock(vmPath)`).
 * `save` persists vm.json; `onGraduate` runs inside the same lock after saving
 * so inherited tier RPM restoration stays atomic with clearing `policy.warmup`.
 */
export async function applyWarmupAction(
  vmPath,
  decision,
  { vmId = null, load, save, onGraduate = null, intervalMinutes, now, config } = {},
) {
  const lockKey = String(vmPath || '')
  const id = vmId || path.basename(lockKey, '.json')
  return withVmLock(lockKey, async () => {
    const vm = await load(id)
    if (!vm) return { applied: 'skip_missing' }
    const w = warmupOf(vm)
    if (!w) return { applied: 'skip_gone' }
    const stamp = now || new Date().toISOString()

    switch (decision.action) {
      case 'accumulate':
        w.accumulated_minutes = (Number(w.accumulated_minutes) || 0) + (intervalMinutes || 0)
        await save(vm)
        return { applied: 'accumulate', accumulated_minutes: w.accumulated_minutes }

      case 'follow':
        w.target_rpm = decision.targetRpm
        pushEvent(w, { kind: 'follow_pin', target_rpm: decision.targetRpm }, stamp, config?.max_events)
        await save(vm)
        return { applied: 'follow', target_rpm: w.target_rpm }

      case 'exit': {
        const cleared = clearWarmup(vm, decision.reason, stamp, config)
        await save(vm)
        return { applied: 'exit', reason: decision.reason, events: cleared?.events }
      }

      case 'graduate': {
        const record = graduateWarmup(vm, stamp)
        await save(vm)
        if (typeof onGraduate === 'function') {
          await onGraduate(vm, record)
        }
        return { applied: 'graduate', record }
      }

      case 'pause':
      case 'hold_fatal':
        return { applied: decision.action }

      default:
        return { applied: decision.action }
    }
  })
}
