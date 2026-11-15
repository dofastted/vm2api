/**
 * Keeps every running Docker Claude slot sized for its plan (slot-capacity.mjs).
 *
 * Each tick, per slot:
 *   1. Raise memory / pids to the plan target (live, raise-only, recorded in vm.machine).
 *   2. Pressure: the cgroup reported a new OOM kill → one memory step above the
 *      current limit; a new pids-limit hit → double the pids limit.
 *   3. Memory raises respect a per-host budget: the sum of slot memory limits
 *      may not exceed (host RAM − memory used outside slots) × host_memory_ratio,
 *      so every slot can fill at once without exhausting the host (a ratio
 *      above 1 overcommits on purpose; live admission then guards). Cluster
 *      nodes get the same budget from their health probe (`nodeMemory`); a
 *      node whose figures are missing or stale raises nothing until they
 *      return. Over budget
 *      the slot keeps its limits; its slot count (and seats) stay clamped to
 *      what they hold, and an event asks for another machine.
 *
 * The kernel slot count follows the recorded limits through wrapSlotCount();
 * the kernel watchdog applies a changed count with an idle reload.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isKvmRuntime } from './runtime-kind.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { memoryMiB, slotMemory, VM_MEMORY_OPTIONS } from './machine-spec.mjs'
import { withVmLock } from './vm-file.mjs'
import { getVm } from './vm-registry.mjs'
import {
  formatDockerMemoryBytes,
  raiseDockerSlotMemory,
  raiseDockerSlotPids,
  readSlotCgroupStats,
} from './docker-slot-memory.mjs'
import {
  configureSlotCapacity,
  MAX_PIDS_LIMIT,
  nextMemoryOption,
  recordedPidsLimit,
  slotCapacityConfig,
  slotCapacityTarget,
} from './slot-capacity.mjs'
import { vmNodeId } from '../cluster/placement.mjs'

export const SLOT_CAPACITY_INTERVAL_MS = 30_000
const MiB = 1024 ** 2

/** This host's RAM: total and available (page cache counts as available). */
export function readLocalHostMemory() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8')
    const kb = (key) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)?.[1])
    const total = kb('MemTotal')
    const available = kb('MemAvailable')
    if (total > 0 && available >= 0) return { totalBytes: total * 1024, availableBytes: available * 1024 }
  } catch {}
  return { totalBytes: os.totalmem(), availableBytes: os.freemem() }
}
const EVENT_REPEAT_MS = 60 * 60 * 1000
/** Node memory older than this (a missed health probe or two) is not trusted for a raise. */
export const NODE_MEMORY_STALE_MS = 120_000

function reconcilable(vm) {
  if (!vm?.id || isCodexVm(vm) || isKvmRuntime(vm)) return false
  if (vm.status && vm.status !== 'running') return false
  return true
}

function hostKey(vm) {
  return vmNodeId(vm) || 'local'
}

/** A live cgroup limit as a standard memory option, or null when it is not one. */
function liveMemoryOption(bytes) {
  const text = formatDockerMemoryBytes(bytes)
  return text && VM_MEMORY_OPTIONS.includes(text) ? text : null
}

function maxMemory(a, b) {
  return memoryMiB(a) >= memoryMiB(b) ? a : b
}

export function createSlotCapacityReconciler({
  projectRoot,
  listTargets,
  getRouting = () => ({}),
  intervalMs = SLOT_CAPACITY_INTERVAL_MS,
  readStats = readSlotCgroupStats,
  raiseMemory = raiseDockerSlotMemory,
  raisePids = raiseDockerSlotPids,
  /** (nodeId) => { totalBytes, availableBytes, at } from the node's last health probe, or null. */
  nodeMemory = () => null,
  /** { totalBytes, availableBytes, at? } for a host key ('local' or a node id), or null. */
  hostMemory = (key) => (key === 'local' ? readLocalHostMemory() : nodeMemory(key)),
  onEvent = null,
  now = Date.now,
  log = console,
} = {}) {
  const counters = new Map()
  const lastEvent = new Map()
  let timer = null
  let running = false

  function emit(kind, vm, detail = {}, { repeatKey = null } = {}) {
    if (repeatKey) {
      const key = `${kind}:${vm.id}:${repeatKey}`
      const at = lastEvent.get(key) || 0
      if (now() - at < EVENT_REPEAT_MS) return
      lastEvent.set(key, now())
    }
    const event = { kind, vm_id: vm.id, at: new Date(now()).toISOString(), ...detail }
    try {
      log?.warn?.(`[slot-capacity] ${kind} ${vm.id} ${JSON.stringify(detail)}`)
    } catch {}
    try {
      onEvent?.(event)
    } catch {}
  }

  async function reconcileVm(vm, routing, budget, stats) {
    if (!stats) return { vm_id: vm.id, skipped: 'stats_unreadable' }
    const prev = counters.get(vm.id)
    counters.set(vm.id, stats)
    const oomGrew = !!prev && stats.oomKills > prev.oomKills
    const pidsGrew = !!prev && stats.pidsMaxHits > prev.pidsMaxHits
    const target = slotCapacityTarget(vm, routing)
    const out = { vm_id: vm.id, plan: target.plan, slots: target.slots }

    const currentMem = slotMemory(vm, routing)
    // A container already above its record (raised by hand) is adopted, never lowered.
    const liveMem = liveMemoryOption(stats.memoryBytes)
    const baseMem = liveMem ? maxMemory(currentMem, liveMem) : currentMem
    let wantMem = maxMemory(target.memory, baseMem)
    if (oomGrew) wantMem = maxMemory(wantMem, nextMemoryOption(baseMem) || baseMem)
    if (memoryMiB(wantMem) > memoryMiB(currentMem)) {
      const key = hostKey(vm)
      const deltaMiB = memoryMiB(wantMem) - memoryMiB(currentMem)
      const entry = budget.get(key)
      if (entry?.unknown) {
        // A node with no fresh memory figures: wait for its next health probe.
        out.memory = 'host_memory_unknown'
      } else if (entry && entry.limitMiB != null && entry.usedMiB + deltaMiB > entry.limitMiB) {
        out.memory = 'host_budget_exhausted'
        emit(
          'host_memory_exhausted',
          vm,
          {
            host: key,
            want: wantMem,
            current: currentMem,
            used_mib: entry.usedMiB,
            limit_mib: entry.limitMiB,
            non_slot_mib: entry.nonSlotMiB,
          },
          { repeatKey: wantMem },
        )
      } else {
        const result = await withVmLock(path.join(projectRoot, 'vms', `${vm.id}.json`), async () => {
          const fresh = getVm(projectRoot, vm.id) || vm
          return raiseMemory(projectRoot, fresh, wantMem, { routing })
        })
        if (result?.ok) {
          if (entry) entry.usedMiB += deltaMiB
          out.memory = wantMem
          const reason = oomGrew
            ? 'oom_kill'
            : memoryMiB(wantMem) > memoryMiB(target.memory)
              ? 'adopt_live'
              : 'plan_target'
          emit('memory_raised', vm, { from: currentMem, to: wantMem, reason })
        } else {
          out.memory = result?.code || 'raise_failed'
          emit('memory_raise_failed', vm, { want: wantMem, code: result?.code }, { repeatKey: result?.code || 'x' })
        }
      }
    }

    const currentPids = Math.max(recordedPidsLimit(vm), Number(stats.pidsLimit) || 0)
    let wantPids = Math.max(target.pids, currentPids)
    if (pidsGrew) wantPids = Math.max(wantPids, Math.min(MAX_PIDS_LIMIT, currentPids * 2))
    if (wantPids > recordedPidsLimit(vm)) {
      const result = await withVmLock(path.join(projectRoot, 'vms', `${vm.id}.json`), async () => {
        const fresh = getVm(projectRoot, vm.id) || vm
        return raisePids(projectRoot, fresh, wantPids)
      })
      if (result?.ok) {
        out.pids = result.pids_limit
        emit('pids_raised', vm, {
          from: recordedPidsLimit(vm),
          to: result.pids_limit,
          reason: pidsGrew ? 'pids_limit_hit' : wantPids > target.pids ? 'adopt_live' : 'plan_target',
        })
      } else {
        out.pids = result?.code || 'raise_failed'
        emit('pids_raise_failed', vm, { want: wantPids, code: result?.code }, { repeatKey: result?.code || 'x' })
      }
    }
    return out
  }

  async function tick() {
    if (running) return { ok: false, reason: 'running' }
    const routing = getRouting() || {}
    // Keep the module default (used where no routing is passed) in step with routing.json.
    configureSlotCapacity(routing.slot_capacity)
    const cfg = slotCapacityConfig(routing)
    if (!cfg.enabled) return { ok: true, skipped: 'disabled' }
    running = true
    try {
      const all = (listTargets() || []).filter((vm) => vm?.id && !isKvmRuntime(vm))
      // Every running Docker slot's cgroup, Claude or not: their live use is
      // what separates slot memory from the rest of the host.
      const stats = new Map()
      for (const vm of all) {
        if (vm.status && vm.status !== 'running') continue
        stats.set(vm.id, await Promise.resolve(readStats(vm)).catch(() => null))
      }
      const hosts = new Map()
      for (const vm of all) {
        const key = hostKey(vm)
        if (!hosts.has(key)) hosts.set(key, { usedMiB: 0, slotCurrentMiB: 0 })
        const h = hosts.get(key)
        h.usedMiB += memoryMiB(slotMemory(vm, routing))
        const current = Number(stats.get(vm.id)?.memoryCurrentBytes)
        if (Number.isFinite(current) && current > 0) h.slotCurrentMiB += current / MiB
      }
      const budget = new Map()
      for (const [key, h] of hosts) {
        const mem = hostMemory(key)
        const at = Number(mem?.at)
        const fresh = !(at > 0) || now() - at <= NODE_MEMORY_STALE_MS
        const totalMiB = Number(mem?.totalBytes) / MiB
        const availableMiB = Number(mem?.availableBytes) / MiB
        let limitMiB = null
        let nonSlotMiB = null
        if (fresh && totalMiB > 0 && availableMiB >= 0) {
          nonSlotMiB = Math.max(0, Math.round(totalMiB - availableMiB - h.slotCurrentMiB))
          limitMiB = Math.floor(Math.max(0, totalMiB - nonSlotMiB) * cfg.host_memory_ratio)
        }
        // This host is always readable; a node without fresh figures must not grow unbounded.
        const unknown = key !== 'local' && limitMiB == null
        budget.set(key, { usedMiB: h.usedMiB, limitMiB, nonSlotMiB, unknown })
      }
      const results = []
      for (const vm of all.filter(reconcilable)) {
        try {
          results.push(await reconcileVm(vm, routing, budget, stats.get(vm.id)))
        } catch (error) {
          results.push({ vm_id: vm.id, error: String(error?.message || error) })
        }
      }
      return { ok: true, results }
    } finally {
      running = false
    }
  }

  return {
    tick,
    start({ immediate = false } = {}) {
      if (timer) return
      timer = setInterval(() => void tick(), intervalMs)
      timer.unref?.()
      if (immediate) void tick()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
