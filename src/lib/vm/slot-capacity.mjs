/**
 * Plan-based slot capacity.
 *
 * The crag-v2 kernel keeps one native Claude process per resident session until
 * `session_idle_ttl_seconds`, and never evicts an idle one to admit a new one
 * (a full kernel answers `503 runtime queue is full`). So the resident process
 * count is bounded by the kernel's `slots_per_worker`, not by gateway seats, and
 * the container must hold that many processes:
 *
 *   memory ≥ base_mib  + slots × per_session_mib
 *   pids   ≥ base_pids + slots × per_session_pids
 *
 * The plan (Pro / Max 5x / Max 20x) picks the target slot count. The slot count
 * the kernel and the seat book actually use is the target clamped to what the
 * container's recorded limits can hold, so a slot that has not been raised yet
 * stays safe instead of being OOM- or fork-killed.
 *
 * Config: routing.slot_capacity (all keys optional).
 */
import { isHeadlessBridgeCaps, KERNEL_NATIVE_SLOT_COUNT, resolveSessionSlots } from './slot-engine.mjs'
import { memoryMiB, slotMemory, VM_MEMORY_OPTIONS } from './machine-spec.mjs'
import { isCodexVm } from './vm-kind.mjs'

export const SLOT_PLAN_KEYS = Object.freeze(['pro', 'max_5x', 'max_20x', 'default'])
/** Docker's default for slot containers before this module existed. */
export const LEGACY_PIDS_LIMIT = 256
export const MAX_PIDS_LIMIT = 8192

export const HEADLESS_BRIDGE_CAPACITY_DEFAULTS = Object.freeze({
  // Option 2A Headless Official Claude Bridge: 1 persistent Bun worker (~22 MiB
  // PSS at 20 concurrent SSE) + Rust core (~25 MiB) + Drain-and-Swap headroom.
  base_mib: 96,
  per_session_mib: 12,
  base_pids: 48,
  per_session_pids: 2,
})

export const SLOT_CAPACITY_DEFAULTS = Object.freeze({
  enabled: true,
  // Measured on crag 3.0.7 / Claude Code 2.1.321: a real conversation peaks at
  // 230–260 MiB and 22–28 tasks per process; an idle kernel uses ~20 MiB / ~80 tasks.
  per_session_mib: 320,
  base_mib: 256,
  per_session_pids: 64,
  base_pids: 128,
  // Sum of slot memory limits on one host may not exceed this share of the
  // RAM left after everything that is not a slot (databases, other services).
  // Above 1 overcommits: limits are ceilings, not reservations, and slots on
  // different accounts are rarely busy together. Pair it with
  // routing.host_memory_pressure so new conversations leave a host whose
  // real free memory runs low.
  host_memory_ratio: 0.9,
  // Each plan fills its memory step: 2g holds 5 sessions, 4g holds 12, 8g 20.
  // With a 600s idle TTL, 12 slots kept 99% of a busy Max account's new
  // sessions and 5 kept 85% of a busy Pro's; the rest fail over (no circuit).
  plans: Object.freeze({ pro: 5, max_5x: 12, max_20x: 20, default: 5 }),
})

function intIn(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export const HOST_MEMORY_RATIO_MAX = 3

function ratioIn(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(HOST_MEMORY_RATIO_MAX, Math.max(0.3, n))
}

export function isHeadlessBridgeSlot(vm = null, options = null) {
  if (options?.headlessBridge === true) return true
  if (isHeadlessBridgeCaps(options?.capabilities)) return true
  if (!vm || typeof vm !== 'object') return false
  if (
    isHeadlessBridgeCaps(vm.capabilities) ||
    isHeadlessBridgeCaps(vm.runtime?.capabilities) ||
    isHeadlessBridgeCaps(vm.workerStatus?.capabilities) ||
    isHeadlessBridgeCaps(vm.worker_status?.capabilities) ||
    isHeadlessBridgeCaps(vm.kernel_installation?.capabilities)
  ) {
    return true
  }
  return vm.workerStatus?.transport === 'headless_bridge' || vm.runtime?.transport === 'headless_bridge'
}

export function normalizeSlotCapacityConfig(raw, { headlessBridge = false } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const d = SLOT_CAPACITY_DEFAULTS
  const plansSrc = src.plans && typeof src.plans === 'object' ? src.plans : {}
  const plans = {}
  for (const key of SLOT_PLAN_KEYS) plans[key] = intIn(plansSrc[key], 1, KERNEL_NATIVE_SLOT_COUNT, d.plans[key])
  if (headlessBridge) {
    const h = HEADLESS_BRIDGE_CAPACITY_DEFAULTS
    const hSrc = src.headless && typeof src.headless === 'object' && !Array.isArray(src.headless) ? src.headless : {}
    return {
      enabled: typeof src.enabled === 'boolean' ? src.enabled : d.enabled,
      per_session_mib: intIn(hSrc.per_session_mib, 4, 4096, h.per_session_mib),
      base_mib: intIn(hSrc.base_mib, 32, 4096, h.base_mib),
      per_session_pids: intIn(hSrc.per_session_pids, 1, 512, h.per_session_pids),
      base_pids: intIn(hSrc.base_pids, 16, 2048, h.base_pids),
      host_memory_ratio: ratioIn(src.host_memory_ratio, d.host_memory_ratio),
      plans,
    }
  }
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : d.enabled,
    per_session_mib: intIn(src.per_session_mib, 64, 4096, d.per_session_mib),
    base_mib: intIn(src.base_mib, 64, 4096, d.base_mib),
    per_session_pids: intIn(src.per_session_pids, 8, 512, d.per_session_pids),
    base_pids: intIn(src.base_pids, 32, 2048, d.base_pids),
    host_memory_ratio: ratioIn(src.host_memory_ratio, d.host_memory_ratio),
    plans,
  }
}

let activeRaw = null
let active = normalizeSlotCapacityConfig()

/** Called when routing loads or saves; callers that get no routing read this. */
export function configureSlotCapacity(raw) {
  activeRaw = raw ?? null
  active = normalizeSlotCapacityConfig(raw)
  return active
}

export function slotCapacityConfig(routing, options = null) {
  const headless = isHeadlessBridgeSlot(options?.vm, options)
  if (headless) {
    return normalizeSlotCapacityConfig(routing?.slot_capacity ?? activeRaw, { headlessBridge: true })
  }
  return routing?.slot_capacity ? normalizeSlotCapacityConfig(routing.slot_capacity) : active
}

/**
 * Plan from the account's OAuth rate-limit tier, then the scheduling tier.
 * A Max account without a 5x/20x marker counts as Max 5x (the smaller one).
 */
export function slotPlanOf(vm = {}) {
  const c = vm?.claude || {}
  const rlt = String(c.rate_limit_tier || vm?.rate_limit_tier || '')
    .trim()
    .toLowerCase()
  if (/max_20x|20x/.test(rlt)) return 'max_20x'
  if (/max_5x|5x/.test(rlt)) return 'max_5x'
  if (rlt === 'default_claude_ai') return 'pro'
  const tier = String(c.account_tier || vm?.account_tier || '')
    .trim()
    .toLowerCase()
  if (tier === 'max') return 'max_5x'
  if (tier === 'pro') return 'pro'
  return 'default'
}

/**
 * Session target the container is sized for. A seat count set on the VM is the
 * operator's decision and wins outright; otherwise the plan table applies, but
 * never above the global seat setting — a slot is not sized for sessions the
 * seat book will never admit.
 */
export function planSlots(vm, routing) {
  const cfg = slotCapacityConfig(routing)
  const plan = cfg.plans[slotPlanOf(vm)] ?? cfg.plans.default
  const override = vm?.policy?.sessionSlotsOverride ?? vm?.session_slots_override
  const configured = resolveSessionSlots(override === true ? vm : {}, routing || {})
  return override === true ? configured : Math.min(plan, configured)
}

/** Smallest standard memory option that holds `slots` sessions. */
export function resourcesForSlots(slots, routing, options = null) {
  const cfg = slotCapacityConfig(routing, options)
  const n = intIn(slots, 1, KERNEL_NATIVE_SLOT_COUNT, 1)
  const needMiB = cfg.base_mib + n * cfg.per_session_mib
  const memory = VM_MEMORY_OPTIONS.find((opt) => memoryMiB(opt) >= needMiB) || VM_MEMORY_OPTIONS.at(-1)
  const pids = Math.min(MAX_PIDS_LIMIT, cfg.base_pids + n * cfg.per_session_pids)
  return { slots: n, memory, memoryMiB: memoryMiB(memory), pids }
}

/** Next standard memory option above `memory`, or null at the top. */
export function nextMemoryOption(memory) {
  const mib = memoryMiB(memory)
  return VM_MEMORY_OPTIONS.find((opt) => memoryMiB(opt) > mib) || null
}

export function recordedPidsLimit(vm) {
  const n = Number(vm?.machine?.pids_limit)
  return Number.isInteger(n) && n > 0 ? n : LEGACY_PIDS_LIMIT
}

/** Sessions the recorded container limits can hold (0 when not even one fits). */
export function slotsForLimits({ memoryMiB: mib, pids }, routing, options = null) {
  const cfg = slotCapacityConfig(routing, options)
  const byMemory = Math.floor((Number(mib) - cfg.base_mib) / cfg.per_session_mib)
  const byPids = Math.floor((Number(pids) - cfg.base_pids) / cfg.per_session_pids)
  return Math.max(0, Math.min(byMemory, byPids))
}

/**
 * Slot count the kernel and the seat book use for this VM: the plan target,
 * clamped to what the recorded limits hold. Never below 1, never above the
 * kernel maximum. With capacity disabled it is the kernel maximum (legacy).
 */
export function effectiveSlotCount(vm, routing, options = null) {
  const resolvedOptions = options ? { vm, ...options } : { vm }
  const cfg = slotCapacityConfig(routing, resolvedOptions)
  if (!cfg.enabled) return KERNEL_NATIVE_SLOT_COUNT
  const target = planSlots(vm, routing)
  const fits = slotsForLimits(
    { memoryMiB: memoryMiB(slotMemory(vm, routing)), pids: recordedPidsLimit(vm) },
    routing,
    resolvedOptions,
  )
  return Math.min(KERNEL_NATIVE_SLOT_COUNT, Math.max(1, Math.min(target, fits)))
}

/** What the reconciler should raise this VM's container to. */
export function slotCapacityTarget(vm, routing, options = null) {
  const resolvedOptions = options ? { vm, ...options } : { vm }
  const plan = slotPlanOf(vm)
  return { plan, ...resourcesForSlots(planSlots(vm, routing), routing, resolvedOptions) }
}

/**
 * Limits for a new Docker container: never below the recorded spec, and for a
 * Claude slot never below its plan target, so a fresh slot starts able to hold
 * its sessions. The reconciler persists the raise into vm.machine afterwards.
 */
export function slotCreationLimits(vm, routing, options = null) {
  const resolvedOptions = options ? { vm, ...options } : { vm }
  const recorded = slotMemory(vm, routing)
  const pids = recordedPidsLimit(vm)
  const cfg = slotCapacityConfig(routing, resolvedOptions)
  if (!cfg.enabled || isCodexVm(vm)) return { memory: recorded, pids }
  const target = slotCapacityTarget(vm, routing, resolvedOptions)
  return {
    memory: memoryMiB(target.memory) > memoryMiB(recorded) ? target.memory : recorded,
    pids: Math.max(pids, target.pids),
  }
}
