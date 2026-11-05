/**
 * Host watchdog for rust PID-1 slots (recovery level L4/L5).
 *
 * The kernel recovers its own CLI first (close slot, ping, restart CLI) and
 * reports `healthy:false` only after that budget is spent. Then this restarts
 * the container via ensureRustKernel, a bounded number of times with growing
 * waits; when that is spent too, the VM is marked faulted, the scheduler skips
 * it and the operator is notified. Never falls back to kin-worker hop.
 */
import fs from 'node:fs'
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
  slotContainerName,
} from './rust-kernel-supervisor.mjs'
import { resolveInferenceEngine } from '../vm/slot-engine.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { dockerRequest } from '../cluster/docker-remote.mjs'
import { clusterManager, vmNodeId } from '../cluster/placement.mjs'
import { vmTimeoutTracker } from '../pool/failover-runner.mjs'
import path from 'node:path'
import { checkCragLicense } from '../vm/crag-license.mjs'

/** A failed observation is not evidence of a dead container. Use the slot's own host, including KVM runners. */
export async function observeWatchdogContainer(
  vm,
  { hostFor = slotHost, request = dockerRequest, timeoutMs = 1500 } = {},
) {
  let timer
  try {
    const host = hostFor(vm)
    const name = slotContainerName({ vm })
    if (!name) return { state: 'unknown' }
    const observation = Promise.resolve().then(async () => {
      if (typeof host.observe === 'function') return host.observe(vm)
      const res = await request(host.dockerApi(), {
        path: `/containers/${encodeURIComponent(name)}/json`,
        timeoutMs,
      })
      if (res.status === 404) return { state: 'missing' }
      if (res.status !== 200) return { state: 'unknown' }
      const state = JSON.parse(res.body.toString('utf8'))?.State
      if (state?.Paused === true) return { state: 'paused' }
      if (state?.Restarting === true) return { state: 'restarting' }
      if (state?.Running === true) return { state: 'running' }
      if (state?.Running === false && ['created', 'exited', 'dead'].includes(state.Status)) return { state: 'stopped' }
      return { state: 'unknown' }
    })
    // Covers connector/SSH setup too, before dockerRequest's own HTTP timeout starts.
    return await Promise.race([
      observation,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ state: 'unknown' }), timeoutMs)
      }),
    ])
  } catch {
    return { state: 'unknown' }
  } finally {
    clearTimeout(timer)
  }
}

export const DEFAULT_KERNEL_WATCHDOG = Object.freeze({
  enabled: true,
  interval_sec: 20,
  timeout_ms: 15_000,
  // Wait before each recovery attempt, including the first one.
  restart_backoff_sec: Object.freeze([60, 300, 900]),
  restart_window_sec: 3600,
})

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

export function isKernelWatchdogTarget(vm, routing = {}) {
  if (!vm?.id) return false
  if (vm.migration_pending || ['running', 'needs_attention'].includes(vm.slot_migration?.status)) return false
  if (HARD_DOWN.has(String(vm.status || '').toLowerCase())) return false
  // Effective engine, not the slot's own fields: panel-created slots omit
  // inference_engine and inherit routing.inference.engine (usually rust).
  return resolveInferenceEngine(vm, routing) === 'rust'
}

/** Remote node probes cross an SSH relay; allow transport jitter beyond the previous 3s probe timeout. */
export const NODE_SLOT_HEALTH_TIMEOUT_MS = 8000
export const NODE_SLOT_FAILURES_BEFORE_RESTART = 3

function clusterRelayPaths(nodeId, vmId) {
  return clusterManager().slotRelayPaths(nodeId, vmId)
}

/**
 * A node slot's kernel is reached only through its local relay; the vms/<id>/run
 * path never holds a socket there. Null when the relay is not listening: that is
 * a bridge fault for healBridges, never evidence that the remote kernel is dead.
 */
export function watchdogProbeVm(vm, { relayPaths = clusterRelayPaths, exists = fs.existsSync } = {}) {
  const nodeId = vmNodeId(vm)
  if (!nodeId) return vm
  let relays
  try {
    relays = relayPaths(nodeId, vm.id)
  } catch {
    return null
  }
  if (!relays?.kernel || !exists(relays.kernel)) return null
  return {
    ...vm,
    runtime: { ...(vm.runtime || {}), kernel_socket: relays.kernel, worker_socket: relays.worker },
  }
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
  getRouting = null,
  homeDirFor,
  ensure = ensureRustKernel,
  health = rustKernelHealth,
  observeRuntime = observeWatchdogContainer,
  onFault = null,
  revive = null,
  healBridges = null,
  probeVm = watchdogProbeVm,
  now = () => Date.now(),
} = {}) {
  let config = normalizeKernelWatchdogConfig(initial)
  let timer = null
  let running = false
  let inTick = false
  // vmId -> { attempts: [ms], nextAt }
  const restarts = new Map()
  // Remote transport failures can be relay/gate jitter, not a dead kernel.
  const nodeProbeFailures = new Map()
  // VMs under an operator power cycle: the watchdog must not restart them mid-cycle.
  const held = new Set()
  // vmId -> this tick's pending check/restart, so hold() can wait for it to settle.
  const inflight = new Map()
  let healingBridges = false

  function healBridgesOffPath(vms) {
    if (typeof healBridges !== 'function' || healingBridges) return
    healingBridges = true
    Promise.resolve()
      .then(() => healBridges(vms))
      .catch((error) => console.warn(`[kernel-watchdog] bridge heal failed: ${error?.message || error}`))
      .finally(() => {
        healingBridges = false
      })
  }

  function restartBudget(vm, reason, at) {
    if (kernelFaults.has(vm.id)) return false
    const state = restarts.get(vm.id) || { attempts: [], nextAt: at + config.restart_backoff_sec[0] * 1000 }
    state.attempts = state.attempts.filter((t) => at - t < config.restart_window_sec * 1000)
    restarts.set(vm.id, state)
    if (at < state.nextAt) return false
    const backoff = config.restart_backoff_sec
    if (state.attempts.length >= backoff.length) {
      const fault = `kernel unhealthy after ${state.attempts.length} recovery attempts: ${reason}`
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
    return true
  }

  function recordRestart(vm, at) {
    const state = restarts.get(vm.id)
    if (!state) return
    state.attempts.push(at)
    const nextDelay = config.restart_backoff_sec[state.attempts.length] ?? config.interval_sec
    state.nextAt = at + nextDelay * 1000
  }

  /** L4 gate for container revival, where the failed runtime state is confirmed. */
  function admitRestart(vm, reason, at) {
    if (!restartBudget(vm, reason, at)) return false
    const state = restarts.get(vm.id)
    state.attempts.push(at)
    const nextDelay = config.restart_backoff_sec[state.attempts.length] ?? config.interval_sec
    state.nextAt = at + nextDelay * 1000
    return true
  }

  /** One VM's check. `held` is re-read after every await: an operator cycle may start mid-check. */
  async function reviveDownContainer(vm, state) {
    if (vm.status !== 'running' || typeof revive !== 'function') return
    if (!admitRestart(vm, `container ${state}`, now())) return
    const revived = await revive(vm)
    if (!revived?.ok) console.warn(`[kernel-watchdog] ${vm.id} boot failed: ${revived?.error || revived?.code}`)
  }

  async function checkVm(vm, routing) {
    const home = typeof homeDirFor === 'function' ? homeDirFor(vm) : null
    const licensed = checkCragLicense(home ? path.resolve(home, '../../..') : '', vm, routing)
    if (!licensed.ok) return // Activation, not container recovery, repairs licensing failures.
    const probed = probeVm(vm)
    if (!probed) {
      // The kernel cannot be probed without its relay; only a container that is really down is revived.
      const observed = await observeRuntime(vm)
      if (held.has(vm.id) || !['missing', 'stopped', 'restarting'].includes(observed?.state)) return
      return reviveDownContainer(vm, observed.state)
    }
    const exec = {
      vmId: vm.id,
      vm: probed,
      homeDir: typeof homeDirFor === 'function' ? homeDirFor(vm) : null,
    }
    const current = await health(exec, { timeoutMs: vmNodeId(vm) ? NODE_SLOT_HEALTH_TIMEOUT_MS : 800 })
    if (held.has(vm.id)) return
    if (vmNodeId(vm) && !rustKernelProcessUp(current) && current?.healthy !== false) {
      const failures = (nodeProbeFailures.get(vm.id) || 0) + 1
      nodeProbeFailures.set(vm.id, failures)
      if (failures < NODE_SLOT_FAILURES_BEFORE_RESTART) return
    } else {
      nodeProbeFailures.delete(vm.id)
    }
    // cc-node is the crag worker. Restarting a live kernel SIGKILLs it.
    if (dataplaneUsesCcNode(exec) && rustKernelProcessUp(current)) return
    if (!rustKernelNeedsRestart(current)) {
      // Healthy again after a fault means someone fixed it: start a fresh budget.
      // Plain recovery keeps past attempts so a crash loop stays bounded by the window.
      if (kernelFaults.delete(vm.id)) {
        restarts.delete(vm.id)
        vmTimeoutTracker?.reset?.(vm.id)
      }
      // Config convergence, not a failure: outside the restart budget.
      if (kernelSlotMismatch(exec)) {
        const observed = await observeRuntime(vm)
        if (!held.has(vm.id) && observed?.state === 'running') await ensure(exec, { timeoutMs: config.timeout_ms })
      }
      return
    }
    const reason = current?.unhealthy_reason || current?.error || 'kernel process down'
    const observed = await observeRuntime(vm)
    if (held.has(vm.id)) return
    // Permission/transport failures and deliberately paused containers never authorize recovery.
    if (!['running', 'missing', 'stopped', 'restarting'].includes(observed?.state)) return
    if (observed.state !== 'running') return reviveDownContainer(vm, observed.state)
    const attemptAt = now()
    if (!restartBudget(vm, reason, attemptAt)) return
    let result
    try {
      result = await ensure(exec, {
        timeoutMs: config.timeout_ms,
        healthTimeoutMs: vmNodeId(vm) ? NODE_SLOT_HEALTH_TIMEOUT_MS : 800,
      })
    } catch (error) {
      recordRestart(vm, now())
      throw error
    }
    const resultAt = now()
    if (result?.reason === 'already_up' || result?.reason === 'busy') {
      nodeProbeFailures.delete(vm.id)
      const state = restarts.get(vm.id)
      if (state) state.nextAt = resultAt + config.interval_sec * 1000
      return
    }
    recordRestart(vm, resultAt)
    console.warn(`[kernel-watchdog] ${vm.id} recovery attempt: ${reason}`)
    if (held.has(vm.id)) return
    // The container itself is gone or exited: a kernel restart cannot help, a full boot can.
    if (result?.reason === 'container_unavailable' && typeof revive === 'function' && vm.status === 'running') {
      // The container may disappear during ensure; do not mistake a daemon/permission error for absence.
      const latest = await observeRuntime(vm)
      if (held.has(vm.id) || !['missing', 'stopped', 'restarting'].includes(latest?.state)) return
      console.warn(`[kernel-watchdog] ${vm.id} container unavailable; booting slot`)
      const revived = await revive(vm).catch((error) => ({ ok: false, error: error?.message || String(error) }))
      if (!revived?.ok) console.warn(`[kernel-watchdog] ${vm.id} boot failed: ${revived?.error || revived?.code}`)
    }
  }

  async function tick() {
    if (inTick || !config.enabled) return
    inTick = true
    try {
      const vms = (typeof listTargets === 'function' ? listTargets() || [] : []).filter((vm) => !held.has(vm?.id))
      // Bridges (kin-egress, cluster relays) are cheap host helpers, not containers: outside the restart budget.
      healBridgesOffPath(vms)
      // Panel can change routing.inference.engine without restarting this process.
      const routing = typeof getRouting === 'function' ? getRouting() || {} : {}
      for (const vm of vms) {
        if (held.has(vm.id)) continue
        if (!isKernelWatchdogTarget(vm, routing)) continue
        const work = checkVm(vm, routing)
        inflight.set(vm.id, work)
        try {
          await work
        } catch {
          // One failed probe/recovery must not starve later slots or reject an interval's promise.
          console.warn(`[kernel-watchdog] ${vm.id} check failed; skipping this tick`)
        } finally {
          if (inflight.get(vm.id) === work) inflight.delete(vm.id)
        }
      }
    } catch {
      console.warn('[kernel-watchdog] tick failed; retrying at the next interval')
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
    /** Keep the watchdog off a VM; resolves once any check/restart already running for it has settled. */
    hold(vmId) {
      held.add(vmId)
      const pending = inflight.get(vmId)
      if (!pending) return Promise.resolve()
      return pending.then(
        () => {},
        () => {},
      )
    },
    release(vmId) {
      held.delete(vmId)
    },
    /** Operator recovery: drop the L5 fault and spent budget so the next failure starts fresh. */
    reset(vmId) {
      const faulted = kernelFaults.delete(vmId)
      restarts.delete(vmId)
      vmTimeoutTracker?.reset?.(vmId)
      return { faulted }
    },
    restartsInWindow(vmId) {
      const state = restarts.get(vmId)
      if (!state) return 0
      const at = now()
      return state.attempts.filter((t) => at - t < config.restart_window_sec * 1000).length
    },
  }
}
