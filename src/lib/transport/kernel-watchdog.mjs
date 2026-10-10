/**
 * Host watchdog for rust PID-1 slots (recovery level L4/L5).
 *
 * The kernel recovers its own CLI first (close slot, ping, restart CLI) and
 * reports `healthy:false` only after that budget is spent. Then this restarts
 * the container via ensureRustKernel, a bounded number of times with growing
 * waits; when that is spent too, the VM is marked faulted, the scheduler skips
 * it and the operator is notified. Never falls back to kin-worker hop.
 */
import {
  kernelFaults,
  rustKernelHealth,
  rustKernelNeedsRestart,
  rustKernelProcessUp,
  rustKernelPaths,
} from './rust-kernel-client.mjs'
import {
  ensureRustKernel,
  readExistingKernelConfig,
  dataplaneUsesCcNode,
  WRAP_SLOT_MAX,
} from './rust-kernel-supervisor.mjs'
import { normalizeInferenceEngine } from '../vm/slot-engine.mjs'

export const DEFAULT_KERNEL_WATCHDOG = Object.freeze({
  enabled: true,
  interval_sec: 20,
  timeout_ms: 15_000,
  // Wait before each container restart, including the first one.
  restart_backoff_sec: Object.freeze([60, 300, 900]),
  restart_window_sec: 3600,
})

// A missing sidecar costs telemetry, not inference: one docker exec per slot per window is enough.
const TELEMETRY_HEAL_MS = 10 * 60 * 1000

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function normalizeKernelWatchdogConfig(raw = {}) {
  const backoff = Array.isArray(raw.restart_backoff_sec)
    ? raw.restart_backoff_sec.map((sec) => clampInt(sec, 10, 86_400, 0)).filter((sec) => sec > 0)
    : []
  return {
    enabled: raw.enabled !== false,
    interval_sec: clampInt(raw.interval_sec, 5, 300, DEFAULT_KERNEL_WATCHDOG.interval_sec),
    timeout_ms: clampInt(raw.timeout_ms, 3000, 60_000, DEFAULT_KERNEL_WATCHDOG.timeout_ms),
    restart_backoff_sec: backoff.length ? backoff : [...DEFAULT_KERNEL_WATCHDOG.restart_backoff_sec],
    restart_window_sec: clampInt(raw.restart_window_sec, 60, 86_400, DEFAULT_KERNEL_WATCHDOG.restart_window_sec),
  }
}

const HARD_DOWN = new Set(['stopped', 'dead', 'error', 'disabled'])

export function isKernelWatchdogTarget(vm) {
  if (!vm?.id) return false
  if (HARD_DOWN.has(String(vm.status || '').toLowerCase())) return false
  const configured = normalizeInferenceEngine(vm.inference_engine, { inherit: true })
  if (configured === 'rust') return true
  return String(vm.runtime?.engine || '').toLowerCase() === 'rust'
}

function isTelemetryHealTarget(vm) {
  if (!vm?.id) return false
  return !HARD_DOWN.has(String(vm.status || '').toLowerCase())
}

function kernelSlotMismatch(exec) {
  const configPath = rustKernelPaths(exec).configPath
  if (!configPath) return false
  const n = Number(readExistingKernelConfig(configPath).slots_per_worker)
  return Number.isFinite(n) && n !== WRAP_SLOT_MAX
}

export function createKernelWatchdog({
  config: initial = {},
  listTargets,
  homeDirFor,
  ensure = ensureRustKernel,
  health = rustKernelHealth,
  onFault = null,
  ensureTelemetry = null,
  telemetryEveryMs = TELEMETRY_HEAL_MS,
  now = () => Date.now(),
} = {}) {
  let config = normalizeKernelWatchdogConfig(initial)
  let timer = null
  let running = false
  let inTick = false
  // vmId -> { attempts: [ms], nextAt }
  const restarts = new Map()
  // vmId -> next ms a telemetry sidecar check is due
  const telemetryDue = new Map()

  async function healTelemetry(vm, at) {
    if (typeof ensureTelemetry !== 'function' || at < (telemetryDue.get(vm.id) || 0)) return
    telemetryDue.set(vm.id, at + telemetryEveryMs)
    try {
      const result = await ensureTelemetry(vm)
      if (result?.action === 'started')
        console.warn(`[kernel-watchdog] ${vm.id} telemetry sidecar was missing; relaunched`)
      if (result?.ok === false)
        console.warn(`[kernel-watchdog] ${vm.id} telemetry sidecar relaunch failed: ${result.error}`)
    } catch (error) {
      console.warn(`[kernel-watchdog] ${vm.id} telemetry sidecar check failed: ${error?.message || error}`)
    }
  }

  /** L4 gate: bounded container restarts with growing waits; spending them is L5. */
  function admitRestart(vm, reason, at) {
    if (kernelFaults.has(vm.id)) return false
    const state = restarts.get(vm.id) || { attempts: [], nextAt: at + config.restart_backoff_sec[0] * 1000 }
    state.attempts = state.attempts.filter((t) => at - t < config.restart_window_sec * 1000)
    restarts.set(vm.id, state)
    if (at < state.nextAt) return false
    const backoff = config.restart_backoff_sec
    if (state.attempts.length >= backoff.length) {
      const fault = `kernel unhealthy after ${state.attempts.length} container restarts: ${reason}`
      kernelFaults.set(vm.id, fault)
      console.error(`[kernel-watchdog] ${vm.id} faulted; scheduling skips it: ${fault}`)
      if (typeof onFault === 'function') {
        try {
          onFault(vm, fault)
        } catch (error) {
          console.warn(`[kernel-watchdog] fault notify failed: ${error?.message || error}`)
        }
      }
      return false
    }
    state.attempts.push(at)
    const nextDelay = backoff[state.attempts.length] ?? config.interval_sec
    state.nextAt = at + nextDelay * 1000
    return true
  }

  async function tick() {
    if (inTick || !config.enabled) return
    inTick = true
    try {
      const vms = typeof listTargets === 'function' ? listTargets() || [] : []
      for (const vm of vms) {
        // Every running slot, not only kernel-restart targets: live slots carry no
        // inference_engine / runtime.engine, so the target filter would skip them all.
        // Off the tick's critical path: a slow docker exec must not delay kernel restarts.
        // The due time is set before the check runs, so a slot never has two checks in flight.
        if (isTelemetryHealTarget(vm)) void healTelemetry(vm, now())
        if (!isKernelWatchdogTarget(vm)) continue
        const exec = {
          vmId: vm.id,
          vm,
          homeDir: typeof homeDirFor === 'function' ? homeDirFor(vm) : null,
        }
        const current = await health(exec, { timeoutMs: 800 })
        // cc-node is the crag worker. Restarting a live kernel SIGKILLs it.
        if (dataplaneUsesCcNode(exec) && rustKernelProcessUp(current)) continue
        if (!rustKernelNeedsRestart(current)) {
          // Healthy again after a fault means someone fixed it: start a fresh budget.
          // Plain recovery keeps past attempts so a crash loop stays bounded by the window.
          if (kernelFaults.delete(vm.id)) restarts.delete(vm.id)
          // Config convergence, not a failure: outside the restart budget.
          if (kernelSlotMismatch(exec)) await ensure(exec, { timeoutMs: config.timeout_ms })
          continue
        }
        const reason = current?.unhealthy_reason || current?.error || 'kernel process down'
        if (!admitRestart(vm, reason, now())) continue
        console.warn(`[kernel-watchdog] ${vm.id} restarting container: ${reason}`)
        await ensure(exec, { timeoutMs: config.timeout_ms })
      }
    } finally {
      inTick = false
    }
  }

  return {
    setConfig(next) {
      config = normalizeKernelWatchdogConfig(next || {})
    },
    start({ immediate = true } = {}) {
      if (running) return
      running = true
      if (immediate) void tick()
      timer = setInterval(() => void tick(), config.interval_sec * 1000)
      timer.unref?.()
    },
    stop() {
      running = false
      clearInterval(timer)
      timer = null
    },
    tick,
  }
}
