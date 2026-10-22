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
import { backgroundTasksFor } from '../core/shared-background-tasks.mjs'
import { SharedVmOperations } from '../vm/shared-vm-operations.mjs'
import { physicalContainerName } from '../vm/vm-physical-target.mjs'
import { flushVmDbSync } from '../vm/vm-db-sync.mjs'
import { readWatchdogState, writeWatchdogState } from './kernel-watchdog-state.mjs'

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

export function isKernelWatchdogTarget(vm, routing = {}) {
  if (!vm?.id) return false
  if (HARD_DOWN.has(String(vm.status || '').toLowerCase())) return false
  // Effective engine, not the slot's own fields: panel-created slots omit
  // inference_engine and inherit routing.inference.engine (usually rust).
  return resolveInferenceEngine(vm, routing) === 'rust'
}

function isTelemetryHealTarget(vm) {
  if (!vm?.id) return false
  return !HARD_DOWN.has(String(vm.status || '').toLowerCase())
}

/** A node slot answers through an SSH relay across the ocean (~110ms RTT); 800ms misfires there. */
export const NODE_SLOT_HEALTH_TIMEOUT_MS = 3000

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
  ensureTelemetry = null,
  telemetryEveryMs = TELEMETRY_HEAL_MS,
  revive = null,
  healBridges = null,
  probeVm = watchdogProbeVm,
  now = () => Date.now(),
  sharedTasks,
  operations = null,
} = {}) {
  let config = normalizeKernelWatchdogConfig(initial)
  let timer = null
  let running = false
  let inTick = false
  // vmId -> { attempts: [ms], nextAt }
  const restarts = new Map()
  // vmId -> next ms a telemetry sidecar check is due
  const telemetryDue = new Map()
  // VMs under an operator power cycle: the watchdog must not restart them mid-cycle.
  const held = new Set()
  // vmId -> this tick's pending check/restart, so hold() can wait for it to settle.
  const inflight = new Map()
  let healingBridges = false
  const tasks = backgroundTasksFor(sharedTasks)
  const mutations = operations || (tasks ? new SharedVmOperations(tasks.db) : null)
  const sideEffects = new Set()
  const databaseTimes = new Map()
  const clock = (vm) => (tasks ? databaseTimes.get(vm.id) : now())

  function adoptState(vmId, state) {
    if (state.nextAt == null) restarts.delete(vmId)
    else restarts.set(vmId, { attempts: [...state.attempts], nextAt: state.nextAt })
    telemetryDue.set(vmId, state.telemetryDue)
    if (state.fault) kernelFaults.set(vmId, state.fault)
    else kernelFaults.delete(vmId)
  }

  function currentState(vmId) {
    const budget = restarts.get(vmId)
    return {
      version: 1,
      attempts: budget?.attempts || [],
      nextAt: budget?.nextAt ?? null,
      telemetryDue: telemetryDue.get(vmId) || 0,
      fault: kernelFaults.get(vmId) || null,
    }
  }

  function trackSideEffect(operation) {
    sideEffects.add(operation)
    operation.then(
      () => sideEffects.delete(operation),
      () => sideEffects.delete(operation),
    )
    return operation
  }

  function healBridgesOffPath(vms) {
    if (typeof healBridges !== 'function' || healingBridges) return
    healingBridges = true
    const work = () => healBridges(vms)
    const pending = tasks
      ? tasks.run({ taskKey: 'kernel_bridge_heal', intervalMs: config.interval_sec * 1000 }, async () => {
          const value = await work()
          return { terminal: value?.ok === true && value.vmOperationUncertain !== true, value }
        })
      : Promise.resolve().then(work)
    trackSideEffect(pending)
      .catch((error) => console.warn(`[kernel-watchdog] bridge heal failed: ${error?.message || error}`))
      .finally(() => {
        healingBridges = false
      })
  }

  async function healTelemetry(vm, at, markUnknown = () => {}) {
    if (typeof ensureTelemetry !== 'function' || at < (telemetryDue.get(vm.id) || 0)) return
    telemetryDue.set(vm.id, at + telemetryEveryMs)
    try {
      const result = await ensureTelemetry(vm)
      if (result?.action === 'started')
        console.warn(`[kernel-watchdog] ${vm.id} telemetry sidecar was missing; relaunched`)
      if (result?.ok === false)
        console.warn(`[kernel-watchdog] ${vm.id} telemetry sidecar relaunch failed: ${result.error}`)
      if (tasks && result?.ok !== true) markUnknown()
    } catch (error) {
      if (tasks) markUnknown()
      console.warn(`[kernel-watchdog] ${vm.id} telemetry sidecar check failed: ${error?.message || error}`)
    }
  }

  /** L4 gate: bounded container restarts with growing waits; spending them is L5. */
  async function admitRestart(vm, reason, at) {
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
          await onFault(vm, fault)
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

  /** One VM's check. `held` is re-read after every await: an operator cycle may start mid-check. */
  async function reviveDownContainer(vm, state, markUnknown = () => {}) {
    if (vm.status !== 'running' || typeof revive !== 'function') return
    if (!(await admitRestart(vm, `container ${state}`, clock(vm)))) return
    const revived = await revive(vm)
    if (tasks && revived?.ok !== true) markUnknown()
    if (!revived?.ok) console.warn(`[kernel-watchdog] ${vm.id} boot failed: ${revived?.error || revived?.code}`)
  }

  async function checkVm(vm, routing, markUnknown = () => {}) {
    const probed = probeVm(vm)
    if (!probed) {
      // The kernel cannot be probed without its relay; only a container that is really down is revived.
      const observed = await observeRuntime(vm)
      if (held.has(vm.id) || !['missing', 'stopped', 'restarting'].includes(observed?.state)) return
      return reviveDownContainer(vm, observed.state, markUnknown)
    }
    const exec = {
      vmId: vm.id,
      vm: probed,
      homeDir: typeof homeDirFor === 'function' ? homeDirFor(vm) : null,
    }
    const current = await health(exec, { timeoutMs: vmNodeId(vm) ? NODE_SLOT_HEALTH_TIMEOUT_MS : 800 })
    if (held.has(vm.id)) return
    // cc-node is the crag worker. Restarting a live kernel SIGKILLs it.
    if (dataplaneUsesCcNode(exec) && rustKernelProcessUp(current)) return
    if (!rustKernelNeedsRestart(current)) {
      // Healthy again after a fault means someone fixed it: start a fresh budget.
      // Plain recovery keeps past attempts so a crash loop stays bounded by the window.
      if (kernelFaults.delete(vm.id)) restarts.delete(vm.id)
      // Config convergence, not a failure: outside the restart budget.
      if (kernelSlotMismatch(exec)) {
        const observed = await observeRuntime(vm)
        if (!held.has(vm.id) && observed?.state === 'running') {
          const result = await ensure(exec, { timeoutMs: config.timeout_ms })
          if (tasks && result?.ok !== true) markUnknown()
        }
      }
      return
    }
    const reason = current?.unhealthy_reason || current?.error || 'kernel process down'
    const observed = await observeRuntime(vm)
    if (held.has(vm.id)) return
    // Permission/transport failures and deliberately paused containers never authorize recovery.
    if (!['running', 'missing', 'stopped', 'restarting'].includes(observed?.state)) return
    if (observed.state !== 'running') return reviveDownContainer(vm, observed.state, markUnknown)
    if (!(await admitRestart(vm, reason, clock(vm)))) return
    console.warn(`[kernel-watchdog] ${vm.id} restarting container: ${reason}`)
    const result = await ensure(exec, { timeoutMs: config.timeout_ms })
    if (tasks && result?.ok !== true) markUnknown()
    if (held.has(vm.id)) return
    // The container itself is gone or exited: a kernel restart cannot help, a full boot can.
    if (result?.reason === 'container_unavailable' && typeof revive === 'function' && vm.status === 'running') {
      // The container may disappear during ensure; do not mistake a daemon/permission error for absence.
      const latest = await observeRuntime(vm)
      if (held.has(vm.id) || !['missing', 'stopped', 'restarting'].includes(latest?.state)) return
      console.warn(`[kernel-watchdog] ${vm.id} container unavailable; booting slot`)
      const revived = await revive(vm).catch((error) => ({ ok: false, error: error?.message || String(error) }))
      if (tasks && revived?.ok !== true) markUnknown()
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
        // Telemetry sidecar heal is independent of kernel-restart targeting: a
        // missing sidecar costs telemetry, not inference. Off the tick's critical
        // path so a slow docker exec cannot delay container restarts. The due time
        // is set before the check runs, so a slot never has two checks in flight.
        if (!tasks && isTelemetryHealTarget(vm)) void trackSideEffect(healTelemetry(vm, now()))
        if (!isKernelWatchdogTarget(vm, routing) && !(tasks && isTelemetryHealTarget(vm))) continue
        const work = tasks
          ? tasks.run(
              { taskKey: `kernel_watchdog:${physicalContainerName(vm.id)}`, intervalMs: config.interval_sec * 1000 },
              async () => {
                let unknown = false
                try {
                  await mutations.run(
                    vm.id,
                    async () => {
                      adoptState(vm.id, await readWatchdogState(tasks.db, vm.id))
                      const at = (
                        await tasks.db.prepare('SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now').get()
                      ).now
                      databaseTimes.set(vm.id, at)
                      const markUnknown = () => {
                        unknown = true
                      }
                      try {
                        if (isTelemetryHealTarget(vm)) await healTelemetry(vm, at, markUnknown)
                        if (isKernelWatchdogTarget(vm, routing)) await checkVm(vm, routing, markUnknown)
                        await writeWatchdogState(tasks.db, vm.id, currentState(vm.id))
                        await flushVmDbSync()
                        return { vmOperationUncertain: unknown }
                      } finally {
                        databaseTimes.delete(vm.id)
                      }
                    },
                    { kind: 'kernel_watchdog' },
                  )
                } catch (error) {
                  if (['vm_execution_active', 'vm_operation_active'].includes(error.code)) error.taskNotStarted = true
                  throw error
                }
                return { terminal: !unknown }
              },
            )
          : checkVm(vm, routing)
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
    async flush() {
      while (inTick) await new Promise((resolve) => setTimeout(resolve, 10))
      while (sideEffects.size) await Promise.allSettled([...sideEffects])
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
      if (tasks)
        return mutations.run(
          vmId,
          async () => {
            const previous = await readWatchdogState(tasks.db, vmId)
            const state = { ...previous, attempts: [], nextAt: null, fault: null }
            await writeWatchdogState(tasks.db, vmId, state)
            adoptState(vmId, state)
            return { faulted: !!previous.fault }
          },
          { kind: 'watchdog_reset' },
        )
      const faulted = kernelFaults.delete(vmId)
      restarts.delete(vmId)
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
