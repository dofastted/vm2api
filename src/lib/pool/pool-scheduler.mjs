import { EventEmitter } from 'node:events'
import { getVm, listVms, markUnschedulable, migrateVmSchedule } from '../vm/vm-registry.mjs'
import { vmCliHomePath, vmJsonPath } from '../vm/execution-context.mjs'
import {
  expiresAtToMs,
  hasRefreshPresence,
  readSlotCredentialIdentity,
  mirrorWorkerCredentialsToVm,
  markVmAuthCooldown,
  clearVmAuthCooldown,
  markVmRestriction,
  clearVmQuotaRestriction,
} from '../oauth/oauth-credentials.mjs'
import { FABLE_FAMILY_KEY, isFableModel, modelCooldownKeys } from './upstream-error-policy.mjs'
import {
  evaluateCredentialEligibility,
  evaluateSlotGate,
  evaluateProxySync,
  slotHasBoundProxy,
  isCredentialRuntimeBlocked,
  isAuthCooldownReason,
  isLeftoverGrantRevokeRuntime,
  viewRuntimeWithoutLeftoverRevoke,
} from './schedule-eligibility.mjs'
import {
  budgetHeadroom,
  evaluateAccount,
  isAccountRestrictionReason,
  isLeftoverQuotaScheduleOff,
  isQuotaWindowReason,
} from './availability.mjs'
import { listQuotaFromHeaders } from './quota-window.mjs'
import { hardBlockOf } from './rate-limit-service.mjs'
import { unitCircuit } from './unit-circuit.mjs'
import { isSlotProxyDesynced, readWorkerProxyEndpoint, readWorkerEgressMode } from '../vm/vm-runtime.mjs'
import { splitBlocksModel } from './weekly-split.mjs'
import { slotAllowsModel } from './slot-model-gate.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { detectInboundPlatform } from '../protocol/platform-detect.mjs'
import { resolveCredentialScheduleLevel } from './credential-weight.mjs'
import { PLATFORM_SCOPE, normalizeOwnerId, vmMatchesOwnerScope, vmOwnerId } from '../admin/resource-owner.mjs'
import { keyAllowsVm } from '../admin/key-scope.mjs'
import {
  kernelFaults,
  rustKernelBusy,
  rustKernelProcessUp,
  rustKernelReachable,
  supportsGatewayPolicy,
} from '../transport/rust-kernel-client.mjs'
import { resolveSessionSlots } from '../vm/slot-engine.mjs'
import { SeatPlanner, rankSeatCandidates } from './seat-planner.mjs'
import { GATE_DRAINING } from './quota-gate.mjs'
import { activeHoursOf, evaluateActiveHours } from './active-hours.mjs'
import { vmNodeReady } from '../cluster/placement.mjs'

const WAIT_TIMEOUT_MIN_MS = 1000
const WAIT_TIMEOUT_MAX_MS = 120000

export const QUEUE_MAX_MIN = 1
export const QUEUE_MAX_MAX = 999
export const SEAT_GRACE_MAX_MS = 120000
export const SEAT_BUDGET_RESERVE_MAX = 0.5
export const CIRCUIT_THRESHOLD_MAX = 20
export const CIRCUIT_OPEN_MIN_MS = 1000

/** A queued request re-reads eligibility this often, so cooldown lifts and new slots reach it. */
const QUEUE_REFRESH_MS = 2000

/** routing.pool defaults. `strategy` only places new seats; see seat-planner.mjs. */
export const DEFAULT_POOL_ROUTING = Object.freeze({
  strategy: 'balanced',
  queue_max: 50,
  seat_grace_ms: 30000,
  seat_budget_reserve_pct: 0.02,
  fallback_wait_timeout_ms: 30000,
  sticky_wait_timeout_ms: 45000,
  circuit_failure_threshold: 3,
  circuit_open_ms: 30000,
})

const DEFAULT_CONFIG = {
  ...DEFAULT_POOL_ROUTING,
  worker_health_ttl_ms: 5000,
  heartbeat_stale_ms: 15000,
  fable_max_per_account: 4,
  default_max_per_account: 2,
}

function clampNumber(value, fallback, min, max, { round = true } = {}) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const v = round ? Math.round(n) : n
  return Math.min(max, Math.max(min, v))
}

function clampWaitTimeoutMs(value, fallback) {
  return clampNumber(value, fallback, WAIT_TIMEOUT_MIN_MS, WAIT_TIMEOUT_MAX_MS)
}

/**
 * Normalize the stored `routing.pool` block. Legacy strategies (weighted
 * round-robin, round-robin, lru, fill-first) read as `balanced`; the old
 * per-account waiter cap is dropped in favor of the pool-wide `queue_max`.
 */
export function normalizePoolRouting(pool = {}) {
  const next = { ...(pool && typeof pool === 'object' ? pool : {}) }
  delete next.max_waiters_per_account
  next.strategy = next.strategy === 'fill' ? 'fill' : 'balanced'
  next.queue_max = clampNumber(next.queue_max, DEFAULT_POOL_ROUTING.queue_max, QUEUE_MAX_MIN, QUEUE_MAX_MAX)
  next.seat_grace_ms = clampNumber(next.seat_grace_ms, DEFAULT_POOL_ROUTING.seat_grace_ms, 0, SEAT_GRACE_MAX_MS)
  next.seat_budget_reserve_pct = clampNumber(
    next.seat_budget_reserve_pct,
    DEFAULT_POOL_ROUTING.seat_budget_reserve_pct,
    0,
    SEAT_BUDGET_RESERVE_MAX,
    { round: false },
  )
  next.sticky_wait_timeout_ms = clampWaitTimeoutMs(
    next.sticky_wait_timeout_ms,
    DEFAULT_POOL_ROUTING.sticky_wait_timeout_ms,
  )
  next.fallback_wait_timeout_ms = clampWaitTimeoutMs(
    next.fallback_wait_timeout_ms,
    DEFAULT_POOL_ROUTING.fallback_wait_timeout_ms,
  )
  // UnitCircuit used to read 0 / junk as its default; store that default so the
  // panel shows the value that actually runs.
  next.circuit_failure_threshold = circuitSetting(
    next.circuit_failure_threshold,
    DEFAULT_POOL_ROUTING.circuit_failure_threshold,
    1,
    CIRCUIT_THRESHOLD_MAX,
  )
  next.circuit_open_ms = circuitSetting(
    next.circuit_open_ms,
    DEFAULT_POOL_ROUTING.circuit_open_ms,
    CIRCUIT_OPEN_MIN_MS,
    Number.MAX_SAFE_INTEGER,
  )
  return next
}

function circuitSetting(value, fallback, min, max) {
  if (!Number(value)) return fallback
  return clampNumber(value, fallback, min, max)
}

function normalizePoolConfig(config = {}) {
  return { ...DEFAULT_CONFIG, ...normalizePoolRouting(config) }
}

export function formatPoolSelectionSummary(details = {}) {
  const reason = String(details.reason || '').trim()
  if (!reason) return ''
  const parts = [reason]
  const soonest = Number(details.soonest_available_ms)
  if (Number.isFinite(soonest) && soonest > 0) {
    parts.push(`soonest=${Math.round(soonest / 1000)}s`)
  }
  const eligible = Number(details.eligible)
  if (Number.isFinite(eligible)) parts.push(`eligible=${eligible}`)
  if (details.sticky_cleared) parts.push('sticky_cleared')
  return parts.join(' ')
}

function isUnboundAuthCooldown(candidate, bound, stickyCleared) {
  if (!stickyCleared || !bound) return false
  if (candidate.vmId !== bound.vmId || candidate.accountId !== bound.accountId) return false
  return candidate.waitReason === 'account_cooldown' && isAuthCooldownReason(candidate.cooldownReason)
}

/**
 * The seat book is process-wide and seat identities are client-chosen. Each
 * owner scope sees a disjoint VM inventory, so the same device under another
 * scope is another seat; otherwise one tenant's request could find the other's
 * seat "off its pool" and free it.
 */
function scopedSeatKey(seatKey, scope = PLATFORM_SCOPE) {
  const type = scope?.type || 'platform'
  const owner = type === 'user' ? `user:${normalizeOwnerId(scope.userId)}` : type
  return `${owner}|${seatKey}`
}

/** `sess:<id>` after an optional `p:anthropic:` scope. Family and device rows are not seats. */
function sessionIdFromStickyKey(key) {
  const raw = String(key || '')
  const body = raw.startsWith('p:anthropic:') ? raw.slice('p:anthropic:'.length) : raw
  if (!body.startsWith('sess:') || body.includes(':k')) return ''
  return body.slice('sess:'.length)
}

/** Machine VM, then this session's pin, then family. Empty and duplicate VMs drop out with their reason. */
function seatHomes({ deviceVm = '', sessionVm = '', familyVm = '' } = {}) {
  const homes = [
    { vmId: String(deviceVm || '').trim(), reason: 'device-affinity' },
    { vmId: String(sessionVm || '').trim(), reason: 'sticky' },
    { vmId: String(familyVm || '').trim(), reason: 'family-affinity' },
  ]
  const seen = new Set()
  return homes.filter((home) => {
    if (!home.vmId || seen.has(home.vmId)) return false
    seen.add(home.vmId)
    return true
  })
}

function byVmHas(candidates, vmId) {
  return (candidates || []).some((candidate) => candidate.vmId === vmId)
}

/**
 * Nothing eligible. An upstream cooldown on the dropped accounts names the
 * cause: any 529 overload cooldown is capacity (529), only 429 rate-limit
 * cooldowns are the provider's limit (429). Without either, nothing will come
 * back by waiting (503) — unless every slot is just inside its operator rest
 * window, whose open time rides along as retry_after.
 */
function emptyPoolFailure(candidates, now = Date.now()) {
  if ((candidates?.rejections?.quota_guard_request_too_large || 0) > 0) {
    return { reason: 'quota_guard_request_too_large', retry_after_ms: null }
  }
  const { rate_limited: limited = null, overloaded = null } = candidates?.cooldowns || {}
  if (overloaded != null) {
    const until = limited == null ? overloaded : Math.min(overloaded, limited)
    return { reason: 'pool_overload_cooldown', retry_after_ms: Math.max(0, until - now) }
  }
  if (limited != null) return { reason: 'pool_rate_limited', retry_after_ms: Math.max(0, limited - now) }
  const restUntil = Number(candidates?.rest_until) || 0
  return { reason: 'no_eligible_accounts', retry_after_ms: restUntil > now ? restUntil - now : null }
}

function selectionSnapshot(candidates = [], available = [], extras = {}) {
  const now = Date.now()
  const waitPool = extras.waitPool || candidates
  const waitReasons = [...new Set((waitPool || []).map((candidate) => candidate.waitReason).filter(Boolean))]
  const soonest = (waitPool || []).map((candidate) => Number(candidate.availableAt) || 0).filter((value) => value > now)
  return {
    reason: extras.reason,
    wait_ms: extras.waitMs ?? 0,
    soonest_available_ms: soonest.length ? Math.min(...soonest) - now : null,
    wait_reasons: waitReasons,
    eligible: (candidates || []).length,
    available: (available || []).length,
    sticky_cleared: !!extras.stickyCleared,
  }
}

export function accountIdOf(vm, projectRoot = null) {
  if (projectRoot && vm?.id) {
    const slot = readSlotCredentialIdentity(vmCliHomePath(projectRoot, vm.id))
    if (slot?.account_uuid) return slot.account_uuid
  }
  return vm?.claude?.account_uuid || vm?.id || null
}

function parseConcurrency(value, fallback) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, n)
}

function maxConcurrencyOf(vm, fallback = 2) {
  return parseConcurrency(vm?.policy?.maxConcurrency, fallback)
}

/** Seats on this VM: its `session_slots` override, else the global default; clamped 1–20 by slot-engine. */
function seatCapOf(vm, fallback = 20) {
  return resolveSessionSlots(vm, { inference: { session_slots: fallback } })
}

function vmTierOf(vm) {
  if (vm?.claude?.account_tier || vm?.account_tier) return vm.claude?.account_tier || vm.account_tier
  return vm?.claude?.has_access || vm?.has_token ? 'pro' : null
}

function priorityOf(vm, account, now) {
  return resolveCredentialScheduleLevel({ vm, unified: account?.unified || {}, now }).level
}

function weightOf(vm, state) {
  return Math.max(0, Number(vm?.policy?.weight ?? state?.weight ?? 1) || 0)
}

function cooldownActive(until, now) {
  return Number(until) > now
}

/** Account cooldowns that do not prove the account left the pool. */
export const SOFT_COOLDOWN_REASONS = new Set(['rpm_limited', 'rate_limited_unknown'])

/** Concurrency, RPM, and kernel slot-full wait on the bound account. Cooldown / fault must rotate. */
function stickyShouldWait(waitReason, cooldownReason = null) {
  if (
    waitReason === 'concurrency_limit' ||
    waitReason === 'fable_concurrency' ||
    waitReason === 'rpm_limit' ||
    waitReason === 'slot_busy' ||
    waitReason === 'circuit_probe' ||
    waitReason === 'quota_band_inflight'
  ) {
    return true
  }
  // Upstream RPM or an unproven bare 429 is a short cooldown on the same unit,
  // not a reason to move the conversation: borrow now, return next turn.
  return waitReason === 'account_cooldown' && SOFT_COOLDOWN_REASONS.has(String(cooldownReason || ''))
}

/** Waits that reserve() re-checks live, so a queued grant may try them without a fresh eligibility read. */
const LIVE_RECHECKED_WAITS = new Set([
  'concurrency_limit',
  'fable_concurrency',
  'rpm_limit',
  'slot_busy',
  'circuit_probe',
  // Near the 5h/7d gate one call runs at a time; reserve() → tryAcquire re-reads it.
  'quota_band_inflight',
])

function grantable(candidate) {
  return !candidate.busy || LIVE_RECHECKED_WAITS.has(candidate.waitReason)
}

function platformMismatch(model, vm) {
  const detected = detectInboundPlatform(model)
  if (!detected.ok) return false
  const codex = isCodexVm(vm)
  if (detected.platform === 'openai') return !codex
  if (detected.platform === 'anthropic') return codex
  return false
}

function runtimeHealthStatus(value) {
  if (rustKernelBusy(value)) return 'busy'
  return value?.ok ? 'ready' : 'worker_unhealthy'
}

function normalizeModel(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
}

function makeAbortError(message = 'Selection cancelled') {
  return Object.assign(new Error(message), { code: 'selection_cancelled' })
}

export class PoolScheduler extends EventEmitter {
  constructor({
    projectRoot,
    stickyRouter = null,
    accountQuota = null,
    runtimeRepo = null,
    workerHealth = null,
    config = {},
  } = {}) {
    super()
    // One 'change' listener per open panel seat stream.
    this.setMaxListeners(100)
    this.projectRoot = projectRoot
    this.stickyRouter = stickyRouter
    this.accountQuota = accountQuota
    this.runtimeRepo = runtimeRepo
    this.workerHealth = workerHealth
    this.config = normalizePoolConfig(config)
    this.lastStickyCleared = false
    this.inflight = new Map()
    this.inflightFamily = new Map()
    /** vmId → live reservations; mirrors `inflight` (per account) for the panel. */
    this.vmInflight = new Map()
    this.waiters = new Map()
    this.waiterSequence = 0
    this.dueWaiterRefreshes = new Set()
    this.changePending = false
    this.healthCache = new Map()
    this.healthFlights = new Map()
    this.healthWrites = new Map()
    this.maintenanceTimer = null
    this.maintenanceFlight = null
    this.maintenanceStopped = false
    this.lastUsed = new Map()
    this.cooldownTimers = new Map()
    this.planner = new SeatPlanner({
      graceMs: 0,
      reservePct: this.config.seat_budget_reserve_pct,
      strategy: this.config.strategy,
      stickyWaitMs: () => this.config.sticky_wait_timeout_ms,
      stickyTtlMs: () => (Number(this.stickyRouter?.config?.ttl_seconds) || 86400) * 1000,
      onChange: () => this.signalChange(),
    })
    this.unitCircuit = unitCircuit
    if (runtimeRepo) this.unitCircuit.bindRepo(runtimeRepo)
    this.restoreStickySeats()
  }

  /**
   * Machine VM from the sticky row. Written inside claimSeat, before the
   * caller awaits again, so a second first session of the same machine sees
   * it. Expiry and unbind live in that row; there is no second copy.
   */
  machineHome(deviceKey) {
    const key = String(deviceKey || '').trim()
    if (!key) return ''
    return this.stickyRouter?.resolve?.(key)?.vmId || ''
  }

  rememberMachine(deviceKey, { vmId, accountId }) {
    const key = String(deviceKey || '').trim()
    const vm = String(vmId || '').trim()
    const account = String(accountId || '').trim()
    if (!key || !vm || !account || this.stickyRouter?.resolve?.(key)?.vmId) return
    const payload = { accountId: account, vmId: vm }
    if (this.stickyRouter?.bindDeviceAffinity) {
      this.stickyRouter.bindDeviceAffinity(key, payload, { countHit: false })
      return
    }
    this.stickyRouter?.bind?.(key, payload, { countHit: false })
  }

  /**
   * The seat book is live capacity. A sticky row remembers the VM until its
   * TTL, but an ended dialog must not occupy a session slot after restart.
   * Only a canonical `sess:` row whose slot handoff (`held_until`) is still in
   * the future is restored, and that hold frees unless the session queues
   * again. Device affinity and family pins never become seats.
   */
  restoreStickySeats(now = Date.now()) {
    const rows = this.stickyRouter?.repo?.all?.()
    if (!rows) return 0
    let restored = 0
    for (const [key, ent] of Object.entries(rows)) {
      const sessionId = sessionIdFromStickyKey(key)
      if (!sessionId || !ent?.vm_id || !ent?.account_id) continue
      if (ent.slot_index == null || !Number.isInteger(Number(ent.slot_index))) continue
      const heldUntil = Number(ent.held_until)
      if (!Number.isFinite(heldUntil) || now >= heldUntil) continue
      let vm = null
      try {
        vm = this.projectRoot ? getVm(this.projectRoot, ent.vm_id) : null
      } catch {
        vm = null
      }
      const owner = vmOwnerId(vm)
      const scope = owner ? { type: 'user', userId: owner } : PLATFORM_SCOPE
      const seatKey = scopedSeatKey(`seat:sess:${sessionId}`, scope)
      const seat = this.planner.restore(seatKey, {
        vmId: ent.vm_id,
        accountId: ent.account_id,
        index: Number(ent.slot_index),
        heldUntil,
        cap: vm ? seatCapOf(vm, this.config.default_session_slots) : 0,
      })
      if (seat) restored += 1
    }
    return restored
  }

  /**
   * `seatKey` is the client-session seat identity (resolveSeatIdentity).
   * Requests with one go through the seat planner; pinned diagnostics,
   * seatless probes and keyless callers keep the direct pick-and-wait path.
   * A granted seat occupies its slot only while this dialog has a request in
   * flight or queued on the VM. Request end frees the slot. Sticky VM memory
   * stays until sticky TTL, or until the home is unschedulable / an error
   * clears it.
   */
  async selectAndReserve(args = {}) {
    const pinned = !!String(args.pinVmId || '').trim()
    if (args.seatKey && !pinned && !args.skipSessionSlot) {
      return this.selectSeat({ ...args, seatKey: scopedSeatKey(args.seatKey, args.ownerScope) })
    }
    return this.selectDirect(args)
  }

  async selectDirect({
    model,
    stickyKey = null,
    excluded = new Set(),
    spilled = new Set(),
    avoid = null,
    signal,
    deadline = null,
    allowWait = true,
    pinVmId = null,
    familyVmId = null,
    deviceVmId = null,
    ownerScope = PLATFORM_SCOPE,
    keyScope = null,
    stickyKeys = null,
    quotaRequest = null,
  } = {}) {
    const startedAt = Date.now()
    let queueWaitMs = 0
    const pinned = !!String(pinVmId || '').trim()
    const blocked = new Set(excluded)
    let stickyCleared = false
    let familyGated = false
    const boundBefore = stickyKey ? this.stickyRouter?.resolve?.(stickyKey) : null
    const fail = (reason, candidates = [], available = [], waitPool = candidates) => {
      const waitMs = Date.now() - startedAt
      return {
        ok: false,
        code: 'no_available_accounts',
        waitMs,
        queueWaitMs,
        schedulingMs: Math.max(0, waitMs - queueWaitMs),
        familyGated,
        ...selectionSnapshot(candidates, available, { reason, waitMs, stickyCleared, waitPool }),
      }
    }
    const failoverDeadline = Number(deadline) || null
    const defaultPlanMs = stickyKey ? this.config.sticky_wait_timeout_ms : this.config.fallback_wait_timeout_ms
    const loopDeadline = failoverDeadline || startedAt + defaultPlanMs
    let waitStartedAt = null
    let waitCutoff = loopDeadline
    let queuedDeadline = Infinity
    const finishReserve = (selected, reservation) => ({
      ...selected,
      ...reservation,
      familyGated,
      stickyCleared,
      waitMs: Date.now() - startedAt,
      queueWaitMs,
      schedulingMs: Math.max(0, Date.now() - startedAt - queueWaitMs),
      waitPlan: this.makeWaitPlan(selected, {
        sticky: selected.selectionReason === 'sticky',
        requestDeadline: loopDeadline,
      }),
      slotWaitMs: this.remainingSlotWaitMs({
        startedAt,
        loopDeadline,
        sticky: selected.selectionReason === 'sticky',
      }),
      slotWaitDeadlineMs: this.slotWaitDeadlineMs({
        startedAt,
        loopDeadline: Math.min(loopDeadline, queuedDeadline),
        sticky: selected.selectionReason === 'sticky',
        allowWait,
      }),
    })
    for (;;) {
      if (signal?.aborted) throw makeAbortError()
      const candidates = await this.eligibleCandidates({
        model,
        excluded: blocked,
        signal,
        pinVmId,
        ownerScope,
        keyScope,
        quotaRequest,
      })
      if (signal?.aborted) throw makeAbortError()
      if ((failoverDeadline || waitStartedAt !== null) && Date.now() >= waitCutoff) {
        return fail('all_accounts_busy', candidates)
      }
      // A gated family home (quota, credential, excluded) is a migration
      // signal for the caller. Busy is not: it still yields a candidate.
      const familyVm = familyVmId ? String(familyVmId).trim() : ''
      if (familyVm && !pinned && !candidates.some((candidate) => candidate.vmId === familyVm)) familyGated = true
      const available = candidates.filter((candidate) => this.isReservable(candidate))
      const preferred = avoid?.size
        ? available.filter((candidate) => !avoid.has(candidate.accountId) && !avoid.has(candidate.vmId))
        : available
      let selected = this.pick(preferred, {
        stickyKey,
        eligible: candidates,
        spilled,
        stickyKeys,
        deviceVmId,
        familyVmId: familyGated ? null : familyVm,
      })
      if (this.lastStickyCleared) stickyCleared = true
      const reserveMisses = []
      const attempted = new Set()
      // Free capacity first: a sticky or preferred miss scans every other
      // candidate before anything waits. Borrowing never moves the durable pin.
      while (selected) {
        // A fresh scan can see capacity before an older request's refresh timer.
        if (this.waiters.size) this.notifyCapacity(selected.accountId)
        if (signal?.aborted) throw makeAbortError()
        if ((failoverDeadline || waitStartedAt !== null) && Date.now() >= waitCutoff) {
          return fail('all_accounts_busy', candidates)
        }
        const reservation = this.reserve(selected, { skipQuota: pinned, pinned })
        if (reservation) return finishReserve(selected, reservation)
        reserveMisses.push({ ...selected, busy: true, waitReason: selected.waitReason || 'concurrency_limit' })
        attempted.add(selected.accountId)
        const remaining = preferred.filter(
          (candidate) =>
            !attempted.has(candidate.accountId) && !blocked.has(candidate.accountId) && !blocked.has(candidate.vmId),
        )
        if (!remaining.length) break
        selected = this.pick(remaining, {
          stickyKey: null,
          eligible: candidates,
          deviceVmId,
          familyVmId: familyGated ? null : familyVm,
        })
      }
      const effectiveCandidates = reserveMisses.length
        ? candidates.map((candidate) => {
            const missed = reserveMisses.find((item) => item.accountId === candidate.accountId)
            return missed || candidate
          })
        : candidates
      const effectiveAvailable = reserveMisses.length
        ? available.filter((candidate) => !attempted.has(candidate.accountId))
        : available
      const waitCandidates = reserveMisses.length ? effectiveCandidates : candidates
      const waitAvailable = reserveMisses.length ? effectiveAvailable : available
      if (waitCandidates.length === 0) {
        const empty = emptyPoolFailure(candidates)
        return { ...fail(empty.reason, waitCandidates, waitAvailable), retry_after_ms: empty.retry_after_ms }
      }
      const waitPool = waitCandidates.filter(
        (candidate) => !isUnboundAuthCooldown(candidate, boundBefore, stickyCleared),
      )
      if (!allowWait || Date.now() >= loopDeadline) {
        return fail('all_accounts_busy', waitCandidates, waitAvailable, waitPool)
      }
      const now = Date.now()
      const wakeAts = waitPool.map((candidate) => Number(candidate.availableAt) || 0).filter((value) => value > now)
      // Health / quota hops are async; availableAt can expire before we slice the wait.
      const staleWindowWake =
        !wakeAts.length &&
        waitPool.some((candidate) => {
          const at = Number(candidate.availableAt) || 0
          return at > 0 && at <= now
        })
      const concurrencyWait = waitPool.some((candidate) => candidate.busy && stickyShouldWait(candidate.waitReason))
      const waitPlan = this.resolveWaitPlan({
        candidates: waitPool,
        stickyKey,
        stickyCleared,
        requestDeadline: loopDeadline,
      })
      waitStartedAt ??= now
      const waitBudget = waitPlan?.sticky ? this.config.sticky_wait_timeout_ms : this.config.fallback_wait_timeout_ms
      waitCutoff = Math.min(loopDeadline, waitStartedAt + waitBudget)
      const phaseDeadline = Math.min(
        queuedDeadline,
        this.slotWaitDeadlineMs({ startedAt, loopDeadline, sticky: waitPlan?.sticky, allowWait }),
      )
      const waitTarget = waitPool.find((candidate) => candidate.vmId === waitPlan?.vmId)
      const waitCap = supportsGatewayPolicy(waitTarget?.workerStatus) ? Math.min(waitCutoff, phaseDeadline) : waitCutoff
      if (wakeAts.length && Math.min(...wakeAts) >= waitCap && !concurrencyWait) {
        return fail('all_accounts_busy', waitCandidates, waitAvailable, waitPool)
      }
      if (!waitPlan || now >= waitCap) {
        return fail('all_accounts_busy', waitCandidates, waitAvailable, waitPool)
      }
      queuedDeadline = phaseDeadline
      const refreshAt = Math.min(waitCap, now + QUEUE_REFRESH_MS, staleWindowWake ? now + 1 : Infinity, ...wakeAts)
      const queuedAt = Date.now()
      const waited = await this.waitForCapacity({
        signal,
        deadline: waitCap,
        refreshAt,
        accountId: waitPlan.accountId,
        vmId: waitPlan.vmId,
        sticky: waitPlan.sticky,
        stickyKey,
        tryGrant: (accountId) => {
          if (accountId && !waitPool.some((candidate) => candidate.accountId === accountId)) return null
          const live = new Map()
          for (const candidate of waitPool) {
            if (!grantable(candidate)) continue
            const inflight = this.inflight.get(candidate.accountId) || 0
            live.set(candidate.accountId, {
              ...candidate,
              inflight,
              busy: false,
              loadRatio: (inflight + this.waiterCount(candidate.accountId)) / candidate.maxConcurrency,
            })
          }
          const available = [...live.values()].filter(
            (candidate) =>
              (!accountId || candidate.accountId === accountId) &&
              !avoid?.has(candidate.accountId) &&
              !avoid?.has(candidate.vmId) &&
              !blocked.has(candidate.accountId) &&
              !blocked.has(candidate.vmId),
          )
          for (let remaining = available; remaining.length; ) {
            const next = this.pick(remaining, {
              stickyKey,
              eligible: waitCandidates.map((candidate) => live.get(candidate.accountId) || candidate),
              spilled,
              stickyKeys,
              deviceVmId,
              familyVmId: familyGated ? null : familyVm,
            })
            if (this.lastStickyCleared) stickyCleared = true
            if (Date.now() >= waitCap) return null
            const reservation = this.reserve(next, { skipQuota: pinned, pinned })
            if (reservation) return { selected: next, reservation }
            remaining = remaining.filter((candidate) => candidate.accountId !== next.accountId)
          }
          return null
        },
      })
      queueWaitMs += Date.now() - queuedAt
      if (waited?.grant) {
        const { selected: next, reservation } = waited.grant
        if (signal?.aborted) {
          reservation.release()
          throw makeAbortError()
        }
        return finishReserve(next, reservation)
      }
      // Re-read asynchronously on timed refreshes and configuration/health changes.
      if (!waited?.woken && Date.now() >= waitCap) {
        return fail('all_accounts_busy', waitCandidates, waitAvailable, waitPool)
      }
    }
  }

  /**
   * Seat path. A seated session rides its seat and waits for VM concurrency
   * in that VM's FIFO, never on another VM. A new session takes a free seat
   * (sticky VM first, then strategy) or queues in arrival order: on its
   * sticky VM until `sticky_wait_timeout_ms`, then globally until
   * `fallback_wait_timeout_ms`. A seated session's concurrency wait times out
   * after `sticky_wait_timeout_ms`. Timeouts are `pool_queue_timeout`.
   * Sticky VM memory outlives the last request's live seat.
   */
  async selectSeat({
    model,
    seatKey,
    stickyKey = null,
    stickyKeys = null,
    excluded = new Set(),
    spilled = new Set(),
    avoid = null,
    signal,
    deadline = null,
    allowWait = true,
    familyVmId = null,
    deviceVmId = null,
    deviceKey = null,
    ownerScope = PLATFORM_SCOPE,
    keyScope = null,
    quotaRequest = null,
  } = {}) {
    const startedAt = Date.now()
    const failoverDeadline = Number(deadline) || Number.POSITIVE_INFINITY
    const familyVm = familyVmId ? String(familyVmId).trim() : ''
    const machineKey = String(deviceKey || '').trim()
    const deviceVmOf = () => this.machineHome(machineKey) || String(deviceVmId || '').trim()
    const avoided = (candidate) => !!avoid?.size && (avoid.has(candidate.accountId) || avoid.has(candidate.vmId))
    let stickyCleared = false
    let familyGated = false
    let seatMoved = false
    let candidates = []
    let ticket = null
    let consumed = false
    const timings = () => {
      const waitMs = Date.now() - startedAt
      const queueWaitMs = ticket ? Math.max(0, (ticket.grantedAt || Date.now()) - ticket.enqueuedAt) : 0
      return { waitMs, queueWaitMs, schedulingMs: Math.max(0, waitMs - queueWaitMs) }
    }
    const fail = (reason) => {
      const waitMs = Date.now() - startedAt
      const available = candidates.filter((candidate) => this.isReservable(candidate))
      return {
        ok: false,
        code: 'no_available_accounts',
        ...timings(),
        familyGated,
        retry_after_ms: this.planner.retryAfterMs(candidates.map((candidate) => candidate.vmId)),
        ...selectionSnapshot(candidates, available, { reason, waitMs, stickyCleared }),
      }
    }
    let pendingGrant = null
    const finish = (granted) => {
      pendingGrant = granted
      if (signal?.aborted) throw makeAbortError()
      // Keep the granting phase across rehome; legacy workers retain the relative wait.
      const phaseDeadline = ticket?.grantedDeadline
      const sticky = ['seat-held', 'sticky', 'device-affinity', 'family-affinity'].includes(granted.selectionReason)
      const result = {
        ...granted.candidate,
        ...granted.reservation,
        selectionReason: granted.selectionReason,
        seatKey,
        seatMoved: seatMoved && granted.seatOpened,
        familyGated,
        stickyCleared,
        ...timings(),
        slotWaitMs: this.remainingSlotWaitMs({ startedAt: Date.now(), loopDeadline: failoverDeadline, sticky: true }),
        slotWaitDeadlineMs:
          allowWait && phaseDeadline != null
            ? Math.min(failoverDeadline, phaseDeadline)
            : this.slotWaitDeadlineMs({ startedAt, loopDeadline: failoverDeadline, sticky, allowWait }),
      }
      consumed = true
      return result
    }
    try {
      for (;;) {
        if (signal?.aborted) throw makeAbortError()
        if (ticket?.granted) return finish(ticket.granted)
        const held = this.planner.seatOf(seatKey)
        let checkedHomeOnly = false
        if (held && !avoid?.has(held.vmId) && !avoid?.has(held.accountId)) {
          candidates = await this.eligibleCandidates({
            model,
            excluded,
            signal,
            ownerScope,
            keyScope,
            quotaRequest,
            onlyVmIds: new Set([held.vmId]),
          })
          const home = candidates[0]
          checkedHomeOnly = !!home && (!home.busy || stickyShouldWait(home.waitReason, home.cooldownReason))
        }
        if (!checkedHomeOnly) {
          candidates = await this.eligibleCandidates({ model, excluded, signal, ownerScope, keyScope, quotaRequest })
        }
        if (signal?.aborted) throw makeAbortError()
        const now = Date.now()
        // A grant can land while eligibility was being re-read.
        if (ticket?.granted) return finish(ticket.granted)
        if (now >= failoverDeadline || (ticket && ticket.kind !== 'seat' && now >= ticket.deadline)) {
          return fail('pool_queue_timeout')
        }
        if (!checkedHomeOnly && familyVm && !candidates.some((candidate) => candidate.vmId === familyVm))
          familyGated = true
        const byVm = new Map(candidates.map((candidate) => [candidate.vmId, candidate]))
        if (ticket) ticket.candidates = byVm
        // Home left the pool (circuit open, unschedulable, hard cooldown, removed).
        // A full home is still a candidate, so that wait keeps its sticky clock.
        if (ticket?.kind === 'seat' && (now >= ticket.stickyUntil || !byVm.has(ticket.vmId))) {
          ticket.deadline = Math.min(failoverDeadline, now + this.config.fallback_wait_timeout_ms)
          this.planner.toGlobal(ticket)
        }
        let seat = this.planner.seatOf(seatKey)
        if (seat) {
          const home = byVm.get(seat.vmId)
          const homeUsable = !!home && (!home.busy || stickyShouldWait(home.waitReason, home.cooldownReason))
          // A home that left the pool (quota, credential, failover exclusion) or a
          // same-unit retry with a free seat elsewhere moves the device now, without grace.
          const steerAway = homeUsable && avoided(home) && this.openableCandidates(candidates, avoided).length > 0
          if (!homeUsable || steerAway) {
            this.planner.free(seat)
            seatMoved = true
            seat = null
          } else if (avoided(home) && !allowWait) {
            return fail('all_accounts_busy')
          }
        }
        // A surviving seat fixes this turn's VM; family affinity cannot move
        // it. An ended dialog has no seat, and its sticky VM memory stays
        // until TTL even when the family home is a different VM.
        const sticky = this.reconcileSticky({
          stickyKey,
          stickyKeys,
          eligible: candidates,
          spilled,
          familyVmId: null,
        })
        if (sticky.cleared) stickyCleared = true
        if (seat) {
          if (!ticket) {
            if (!this.planner.hasConcWaiters(seat.vmId)) {
              const granted = this.claimSeat(seatKey, byVm.get(seat.vmId), 'seat-held')
              if (granted) return finish(granted)
            }
            if (!allowWait || now >= failoverDeadline) return fail('all_accounts_busy')
            ticket = this.enqueueTicket({
              seatKey,
              signal,
              kind: 'conc',
              requestDeadline: failoverDeadline,
              vmId: seat.vmId,
              candidates: byVm,
              deadline: Math.min(failoverDeadline, now + this.config.sticky_wait_timeout_ms),
            })
          } else if (ticket.kind !== 'conc' || ticket.vmId !== seat.vmId) {
            this.planner.place(ticket, { kind: 'conc', vmId: seat.vmId })
          }
          this.planner.pump(seat.vmId)
        } else {
          // Machine/device home first, then the session's own pin, then family.
          // A new session of a machine that already has a VM takes a free slot
          // there before any other VM. A full home is waited, not skipped.
          const homes = seatHomes({
            deviceVm: deviceVmOf(),
            sessionVm: sticky.vmId || '',
            familyVm: familyGated ? '' : familyVm,
          })

          if (!ticket) {
            const granted = this.openNewSeat(seatKey, candidates, { avoided, homes, deviceKey: machineKey })
            if (granted) return finish(granted)
            if (!candidates.length) {
              const empty = emptyPoolFailure(candidates)
              return { ...fail(empty.reason), retry_after_ms: empty.retry_after_ms }
            }
            if (!allowWait || now >= failoverDeadline) return fail('all_accounts_busy')
            let home = null
            for (const entry of homes) {
              const candidate = byVm.get(entry.vmId)
              if (candidate && (!candidate.busy || stickyShouldWait(candidate.waitReason))) {
                home = candidate
                break
              }
            }
            ticket = home
              ? this.enqueueTicket({
                  seatKey,
                  signal,
                  kind: 'seat',
                  requestDeadline: failoverDeadline,
                  vmId: home.vmId,
                  candidates: byVm,

                  stickyUntil: Math.min(failoverDeadline, now + this.config.sticky_wait_timeout_ms),
                  deadline: failoverDeadline,
                })
              : this.enqueueTicket({
                  seatKey,
                  signal,
                  kind: 'global',
                  requestDeadline: failoverDeadline,
                  vmId: null,
                  candidates: byVm,
                  deadline: Math.min(failoverDeadline, now + this.config.fallback_wait_timeout_ms),
                })
          } else if (ticket.kind === 'conc') {
            // Its seat moved away: wait for a new seat on the same terms as a new device.
            this.planner.place(ticket, { kind: 'global', vmId: null })
            ticket.deadline = Math.min(failoverDeadline, now + this.config.fallback_wait_timeout_ms)
          }
          for (const vmId of ticket.vmId ? [ticket.vmId] : byVm.keys()) this.planner.pump(vmId)
        }
        if (ticket.granted) return finish(ticket.granted)
        if (Date.now() >= failoverDeadline) return fail('pool_queue_timeout')
        const until = ticket.kind === 'seat' ? ticket.stickyUntil : ticket.deadline
        await this.waitTicket(ticket, { signal, until: Math.min(until, Date.now() + QUEUE_REFRESH_MS) })
        if (ticket.granted) return finish(ticket.granted)
        const after = Date.now()
        if (after >= failoverDeadline) return fail('pool_queue_timeout')
        if (ticket.kind === 'seat' && after >= ticket.stickyUntil) continue
        if (after >= ticket.deadline) return fail('pool_queue_timeout')
      }
    } finally {
      this.planner.forgetGranted(ticket)
      this.planner.remove(ticket)
      // Granted while the caller went away: hand the seat and the slot back.
      if (!consumed) (pendingGrant ?? ticket?.granted)?.reservation.release()
    }
  }

  /**
   * VMs that can take a brand-new seat right now without passing anyone
   * queued for it. A VM near its 5h/7d gate (draining) is a last resort: it
   * only takes a new device when no open VM can.
   */
  openableCandidates(candidates, avoided = () => false) {
    const openable = candidates.filter(
      (candidate) =>
        !avoided(candidate) &&
        this.isReservable(candidate) &&
        this.planner.canOpen(candidate.vmId, candidate.seatCap, candidate.headroom) &&
        !this.planner.hasSeatWaiters(candidate.vmId),
    )
    const open = openable.filter((candidate) => !candidate.draining)
    return open.length ? open : openable
  }

  /**
   * Preferred homes first, but only a home with a free slot. A full machine
   * VM is not skipped for another VM here; the caller queues on it. Homes
   * with no free slot drop out, then the configured strategy fills the rest.
   */
  openNewSeat(seatKey, candidates, { avoided, homes = [], deviceKey = '' }) {
    const openable = this.openableCandidates(candidates, avoided)
    if (!openable.length) return null
    for (const home of homes) {
      const match = openable.find((candidate) => candidate.vmId === home.vmId)
      const granted = match ? this.claimSeat(seatKey, match, home.reason, deviceKey) : null
      if (granted) return granted
    }
    const reserved = new Set(homes.map((home) => home.vmId))
    const elsewhere = openable.filter((candidate) => !reserved.has(candidate.vmId))
    const homeFull = homes.some((home) => {
      let cap = 0
      let present = false
      for (const item of candidates) {
        if (item?.vmId !== home.vmId) continue
        present = true
        cap = Number(item.seatCap) || 0
      }
      return present && cap > 0 && this.planner.openCount(home.vmId) >= cap
    })
    if (homeFull) return null
    for (const candidate of this.planner.rank(elsewhere.length ? elsewhere : openable)) {
      const granted = this.claimSeat(seatKey, candidate, this.planner.strategy, deviceKey)
      if (granted) return granted
    }
    return null
  }

  /**
   * Synchronous claim: the reservation (concurrency, quota/RPM, circuit) and
   * the seat land together or not at all. The session's existing seat must be
   * on this VM; otherwise a new one opens only under cap and budget.
   */
  claimSeat(seatKey, candidate, selectionReason, deviceKey = '') {
    if (!candidate || !grantable(candidate)) return null
    const current = this.planner.seatOf(seatKey)
    if (current && current.vmId !== candidate.vmId) return null
    if (!current && !this.planner.canOpen(candidate.vmId, candidate.seatCap, candidate.headroom)) return null
    const reservation = this.reserve(candidate)
    if (!reservation) return null
    let seat
    try {
      this.rememberMachine(deviceKey, { vmId: candidate.vmId, accountId: candidate.accountId })
      seat =
        current ||
        this.planner.open(seatKey, { vmId: candidate.vmId, accountId: candidate.accountId, cap: candidate.seatCap })
      this.planner.hold(seat)
    } catch (error) {
      reservation.release()
      throw error
    }
    const releaseRequest = reservation.release
    let released = false
    return {
      candidate,
      selectionReason,
      seatOpened: !current,
      reservation: {
        ...reservation,
        slotIndex: seat.index,
        release: () => {
          if (released) return
          released = true
          releaseRequest(() => this.planner.release(seat))
        },
      },
    }
  }

  enqueueTicket({ signal, seatKey, kind, vmId, candidates, deadline, stickyUntil = null, requestDeadline }) {
    if (this.queuedTotal() >= this.config.queue_max) throw this.queueFullError([...candidates.keys()])
    const ticket = {
      seatKey,
      kind,
      vmId,
      candidates,
      deadline,
      stickyUntil,
      requestDeadline,
      expired: () => signal?.aborted || Date.now() >= (ticket.kind === 'seat' ? ticket.stickyUntil : ticket.deadline),
      enqueuedAt: Date.now(),
      queued: false,
      granted: null,
      wake: null,
      accepts: (id) => ticket.kind === 'global' && ticket.candidates.has(id),
      vmIds: () => [...ticket.candidates.keys()],
      tryGrant: (id) => {
        if (ticket.expired()) return false
        // Opening a seat can rehome the ticket during claimSeat. Capture
        // the granting phase before its deadline is replaced.
        const grantingDeadline = ticket.kind === 'seat' ? ticket.stickyUntil : ticket.deadline
        const granted = this.claimSeat(ticket.seatKey, ticket.candidates.get(id), 'queued')
        if (!granted) return false
        ticket.granted = granted
        ticket.grantedDeadline = grantingDeadline
        ticket.grantedAt = Date.now()
        return true
      },
    }
    this.planner.enqueue(ticket)
    return ticket
  }

  waitTicket(ticket, { signal, until }) {
    if (ticket.granted) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        ticket.wake = null
      }
      const done = () => {
        cleanup()
        resolve()
      }
      const onAbort = () => {
        cleanup()
        reject(makeAbortError())
      }
      const timer = setTimeout(done, Math.max(1, until - Date.now()))
      ticket.wake = done
      if (signal?.aborted) onAbort()
      else signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

  /** Every Claude request waiting right now: seat queues plus cooldown / RPM / concurrency waiters. */
  queuedTotal() {
    return this.planner.pending() + this.totalWaiters()
  }

  queueFullError(vmIds = null) {
    return Object.assign(new Error('Claude pool queue is full'), {
      code: 'pool_wait_queue_full',
      retryAfterMs: this.planner.retryAfterMs(vmIds),
    })
  }

  /**
   * The session pin as pick() treats it: a bound home that left the pool, or
   * sits in a cooldown that must rotate, releases the pin; capacity keeps it.
   * `spilled` homes keep their pin. Returns the VM the pin still points at.
   */
  reconcileSticky({ stickyKey = null, stickyKeys = null, eligible = [], spilled = null, familyVmId = null } = {}) {
    const bound = stickyKey ? this.stickyRouter?.resolve?.(stickyKey) : null
    if (!bound) return { cleared: false, vmId: null, match: null }
    const familyVm = familyVmId ? String(familyVmId).trim() : ''
    if (familyVm && bound.vmId !== familyVm && eligible.some((candidate) => candidate.vmId === familyVm)) {
      // The family home moved: this session follows it instead of keeping a stale pin.
      this.releaseSticky(bound, stickyKey, stickyKeys)
      return { cleared: true, vmId: null, match: null }
    }
    const match = eligible.find((candidate) => candidate.vmId === bound.vmId && candidate.accountId === bound.accountId)
    if (!match) {
      if (!spilled?.has(bound.accountId)) this.releaseSticky(bound, stickyKey, stickyKeys)
      return { cleared: true, vmId: null, match: null }
    }
    if (match.busy && !stickyShouldWait(match.waitReason, match.cooldownReason)) {
      // Auth / quota / pause cooldown: the conversation moves.
      this.releaseSticky(bound, stickyKey, stickyKeys)
      return { cleared: true, vmId: null, match: null }
    }
    return { cleared: false, vmId: bound.vmId, match }
  }

  async eligibleCandidates({
    model = null,
    excluded = new Set(),
    signal = undefined,
    pinVmId = null,
    ownerScope = /** @type {import('../admin/resource-owner.mjs').OwnerScope} */ (PLATFORM_SCOPE),
    keyScope = null,
    quotaRequest = null,
    onlyVmIds = null,
  } = {}) {
    const now = Date.now()
    const summaries = listVms(this.projectRoot)
    const candidates = Object.assign([], {
      cooldowns: { rate_limited: /** @type {number|null} */ (null), overloaded: /** @type {number|null} */ (null) },
      rejections: { quota_guard_request_too_large: 0 },
      rest_until: /** @type {number|null} */ (null),
    })
    const pin = pinVmId ? String(pinVmId).trim() : ''
    const entries = []
    for (const summary of summaries) {
      if (onlyVmIds && !onlyVmIds.has(summary.id)) continue
      if (signal?.aborted) throw makeAbortError()
      if (pin && summary.id !== pin) continue
      const vm = getVm(this.projectRoot, summary.id)
      if (!vm) continue
      if (!pin && platformMismatch(model, vm)) continue
      if (!vmMatchesOwnerScope(vm, ownerScope)) continue
      if (!keyAllowsVm(keyScope, vm)) continue
      const accountId = accountIdOf(vm, this.projectRoot)
      if (!accountId || excluded.has(accountId) || excluded.has(vm.id)) continue
      entries.push({ vm, accountId })
    }
    const snapshots = this.runtimeRepo
      ? this.runtimeRepo.schedulingSnapshot(entries.map((entry) => entry.accountId))
      : new Map()
    for (const { vm, accountId } of entries) {
      if (signal?.aborted) throw makeAbortError()
      const snapshot = snapshots.get(accountId)
      const state = snapshot?.state || null
      const account = snapshot?.account || null
      const eligibility = await this.checkEligibility({
        vm,
        accountId,
        state,
        account,
        model,
        now,
        signal,
        pinned: !!pin,
        quotaRequest,
      })
      if (!eligibility.ok) {
        const kind = eligibility.reason
        if (kind === 'rate_limited' || kind === 'overloaded') {
          const until = Number(eligibility.until) || 0
          const prev = candidates.cooldowns[kind]
          candidates.cooldowns[kind] = prev == null ? until : Math.min(prev, until)
        } else if (kind === 'quota_guard_request_too_large') {
          candidates.rejections.quota_guard_request_too_large += 1
        } else if (kind === 'rest_period') {
          const until = Number(eligibility.until) || 0
          candidates.rest_until = candidates.rest_until == null ? until : Math.min(candidates.rest_until, until)
        }
        continue
      }
      const maxConcurrency = this.effectiveMaxConcurrency(
        vm,
        eligibility.account,
        parseConcurrency(this.config.default_max_per_account, 2),
      )
      const inflight = this.inflight.get(accountId) || 0
      const seatCap = seatCapOf(vm, this.config.default_session_slots)
      this.planner.noteCap(vm.id, seatCap)
      candidates.push({
        ok: true,
        vmId: vm.id,
        accountId,
        vm,
        state,
        model: normalizeModel(model),
        priority: priorityOf(vm, eligibility.account, now),
        weight: weightOf(vm, state),
        inflight,
        maxConcurrency,
        seatCap,
        headroom: eligibility.headroom ?? null,
        draining: eligibility.gateZone === GATE_DRAINING,
        account: eligibility.account || null,
        loadRatio: (inflight + this.waiterCount(accountId)) / maxConcurrency,
        lastUsedAt: this.lastUsed.get(accountId) || state?.last_used_at || 0,
        workerStatus: eligibility.workerStatus,
        busy: !!eligibility.busy,
        availableAt: eligibility.availableAt || null,
        waitReason: eligibility.waitReason || null,
        cooldownReason: state?.cooldown_reason || null,
        quotaRequest,
        signal,
        ownerScope,
        keyScope,
        exec: this.executionContext(vm, accountId),
      })
    }
    return candidates
  }
  async checkEligibility({
    vm,
    accountId,
    state,
    account,
    model,
    now,
    signal,
    pinned = false,
    quotaRequest = null,
    workerStatus: knownHealth = undefined,
    admission = false,
  }) {
    // sub2api IsSchedulable: rate_limit_reset_at / overload_until gate before any
    // passive Extra reading or health hop. Pins are diagnostics and still reach the slot.
    const hardBlock = pinned ? null : hardBlockOf(state, now)
    if (hardBlock) return { ok: false, reason: hardBlock.reason, until: hardBlock.until }
    let circuitProbeUntil = null
    if (!pinned) {
      const circuit = await this.unitCircuit?.inspect?.(accountId, now)
      if (circuit?.reason === 'circuit_open') return { ok: false, reason: circuit.reason, until: circuit.until }
      if (circuit?.reason === 'circuit_probe') circuitProbeUntil = circuit.until
    }
    const gate = await evaluateSlotGate(vm)
    if (!gate.ok && gate.reason !== 'no_credential') {
      // Master pin may test a slot taken out of the pool, but SOCKS is still mandatory.
      if (!(pinned && gate.reason === 'vm_unschedulable')) return gate
    }
    if (!slotHasBoundProxy(vm)) return { ok: false, reason: 'proxy_required' }
    const workerProxyEndpoint = this.projectRoot ? readWorkerProxyEndpoint(this.projectRoot, vm.id) : undefined
    const egressMode = this.projectRoot ? readWorkerEgressMode(this.projectRoot, vm.id) : ''
    const proxySync = evaluateProxySync({ vm, workerProxyEndpoint, egressMode })
    if (!proxySync.ok) {
      if (
        this.projectRoot &&
        isSlotProxyDesynced(vm, this.projectRoot) &&
        vm.unschedulable?.reason !== 'proxy_desynced'
      ) {
        await markUnschedulable(this.projectRoot, vm.id, 'proxy_desynced')
      }
      return proxySync
    }
    let headroom = null
    if (!pinned) {
      // Panel switch is vm.schedulable (evaluateSlotGate). accounts.schedulable
      // is a legacy column nothing writes; a leftover 0 must not hide a slot
      // the panel still shows as participating.
      if (account && account.status !== 'active') {
        return { ok: false, reason: 'account_disabled' }
      }
      const modelGate = await slotAllowsModel({ vm, account, model })
      if (!modelGate.ok) return modelGate
      if (account) {
        // Only repair an actual stale projection. A healthy candidate must not
        // write account/filesystem state as a side effect of being considered.
        if (
          !admission &&
          (isLeftoverQuotaScheduleOff(vm) ||
            state?.cooldown_reason ||
            vm.claude?.temp_unschedulable_reason ||
            vm.temp_unschedulable_reason)
        ) {
          await this.syncQuotaSchedule(vm, account, state)
          state = await this.runtimeRepo.get(accountId)
        }
        if (this.projectRoot) {
          const live = getVm(this.projectRoot, vm.id)
          if (live) {
            vm.schedulable = live.schedulable
            vm.schedule_disabled_reason = live.schedule_disabled_reason
            vm.schedule_manual = live.schedule_manual
            vm.schedule_off = live.schedule_off
            vm.unschedulable = live.unschedulable
            vm.schedule_hold = live.schedule_hold
            vm.claude = live.claude || vm.claude
            vm.temp_unschedulable_until = live.temp_unschedulable_until
            vm.temp_unschedulable_reason = live.temp_unschedulable_reason
          }
        }
        const policy = this.accountQuota?.policyFor?.(account, { tier: vmTierOf(vm) }) || null
        const lastUsedAt = this.lastUsed.get(accountId) || state?.last_used_at || null
        const quota = account.unified
          ? {
              ...listQuotaFromHeaders(account.unified, { now }),
              last_used_at: lastUsedAt,
              last_probe: account.last_probe || account.unified.last_probe,
              probe_source: account.unified.source,
            }
          : {}
        const ev = evaluateAccount({
          vm,
          account: { ...account, last_used_at: lastUsedAt },
          hasToken: !!(vm?.claude?.has_access || vm?.has_token),
          hasRefresh: hasRefreshPresence(vm?.claude) || !!vm?.has_refresh,
          schedulable: vm.schedulable !== false,
          scheduleDisabledReason: vm.schedule_disabled_reason || null,
          lastProbe: account.last_probe || account.unified?.last_probe || null,
          probeSource: account.unified?.source || account.last_probe?.source || null,
          workerLastError: account.worker_status?.last_error || vm.claude?.refresh_error,
          refreshError: vm.claude?.refresh_error,
          expiresAt: vm.claude?.expires_at || vm.expires_at || null,
          refreshedAt: vm.claude?.refreshed_at || vm.refreshed_at || null,
          workerCredential: account.worker_status?.credential || null,
          quota,
          policy,
          cooldownUntil:
            state?.cooldown_until || vm.claude?.temp_unschedulable_until || vm.temp_unschedulable_until || null,
          cooldownReason:
            state?.cooldown_reason || vm.claude?.temp_unschedulable_reason || vm.temp_unschedulable_reason || null,
          now,
        })
        if (!ev.accept) {
          if (ev.key === 'cool') {
            // cooldown is a wait, not a hard skip — handled below
          } else {
            return { ok: false, reason: ev.reason || ev.key || 'account_gated' }
          }
        }
        headroom = budgetHeadroom({ account: { ...account, last_used_at: lastUsedAt }, quota, policy, now })
      }
      // Operator-set working window: outside it the slot simply is not a
      // candidate. Checked after the model / account gates so only a slot that
      // would otherwise serve feeds the pool's rest_until (Retry-After), and
      // before the worker health hop. Pins are diagnostics and still reach the slot.
      const rest = evaluateActiveHours(activeHoursOf(vm), now, vm.timezone)
      if (!rest.active) return { ok: false, reason: 'rest_period', until: rest.until }
    }
    const workerStatus =
      knownHealth === undefined
        ? await this.getWorkerHealth(this.executionContext(vm, accountId), { signal, state })
        : knownHealth
    // Health probing is asynchronous. Re-read time before applying cooldown
    // and credential gates, otherwise a cooldown that expired during the hop
    // can be re-enqueued with an already-past wakeup and lose its notification.
    const eligibilityNow = Date.now()
    const cred = evaluateCredentialEligibility({ vm, workerStatus, now: eligibilityNow })
    if (!cred.ok) return cred
    if (isLeftoverGrantRevokeRuntime(state, vm)) {
      try {
        await this.runtimeRepo?.clearGrantRevokeCooldown?.(accountId, { vmId: vm.id })
      } catch {}
      state = viewRuntimeWithoutLeftoverRevoke(state, vm)
    }
    // Setup Token has no refresh by design. A prior pin/test 401 parks
    // oauth_no_refresh forever; master pin must still be able to retry.
    const leftoverNoRefreshPark = pinned && String(state?.cooldown_reason || '') === 'oauth_no_refresh'
    if (leftoverNoRefreshPark) {
      try {
        await this.runtimeRepo?.clearGrantRevokeCooldown?.(accountId, { vmId: vm.id })
      } catch {}
      state = {
        ...state,
        status: 'ready',
        cooldown_until: null,
        cooldown_reason: null,
      }
    }
    if (isCredentialRuntimeBlocked(state, eligibilityNow, vm)) return { ok: false, reason: 'credential_blocked' }
    const fallbackCap = parseConcurrency(this.config.default_max_per_account, 2)
    const maxConcurrency = this.effectiveMaxConcurrency(vm, account, fallbackCap)
    if (maxConcurrency <= 0) return { ok: false, reason: 'concurrency_disabled' }
    let busy = false
    let availableAt = null
    let waitReason = null
    const markWait = (reason, until = null) => {
      busy = true
      waitReason = waitReason || reason
      const next = Number(until) || 0
      if (next > eligibilityNow) availableAt = availableAt ? Math.min(availableAt, next) : next
    }
    if (state && cooldownActive(state.cooldown_until, eligibilityNow) && !leftoverNoRefreshPark) {
      markWait('account_cooldown', state.cooldown_until)
    }
    const modelKey = normalizeModel(model)
    for (const key of modelCooldownKeys(modelKey)) {
      const modelState = state?.model_states?.[key]
      if (modelState && cooldownActive(modelState.cooldown_until, eligibilityNow)) {
        markWait(key === FABLE_FAMILY_KEY ? 'fable_cooldown' : 'model_cooldown', modelState.cooldown_until)
      }
    }
    if (isFableModel(modelKey) && this.accountQuota?.fableWindowLimited?.(accountId, eligibilityNow, account)) {
      const until = this.accountQuota.fableWindowResetAt?.(accountId, account)
      markWait('fable_quota', until)
    }
    if (this.accountQuota?.weeklySplitOf) {
      const split = this.accountQuota.weeklySplitOf(accountId, account)
      const reason = splitBlocksModel(split, modelKey)
      if (reason) {
        const until = this.accountQuota.weeklySplitResetAt?.(
          accountId,
          reason === 'fable_split' ? 'fable' : 'regular',
          account,
        )
        markWait(reason, until)
      }
    }
    const inflight = this.inflight.get(accountId) || 0
    if (circuitProbeUntil) markWait('circuit_probe', circuitProbeUntil)
    if (inflight >= maxConcurrency) markWait('concurrency_limit')
    const fableCap = Number(this.config.fable_max_per_account)
    if (isFableModel(modelKey) && Number.isFinite(fableCap) && fableCap > 0) {
      const familyInflight = this.familyInflight(accountId, FABLE_FAMILY_KEY)
      if (familyInflight >= fableCap) markWait('fable_concurrency')
    }
    let gateZone = null
    if (this.accountQuota && !pinned) {
      const quotaGate = this.accountQuota.canAccept(accountId, { tier: vmTierOf(vm), quotaRequest, account })
      if (!quotaGate.ok) {
        if (quotaGate.reason === 'concurrency_limit') markWait('concurrency_limit')
        else if (quotaGate.reason === 'rpm_limit') markWait('rpm_limit', quotaGate.detail?.reset_at)
        else if (quotaGate.reason === 'quota_band_inflight') markWait('quota_band_inflight')
        else return { ok: false, reason: quotaGate.reason || 'quota_gate' }
      }
      gateZone = this.accountQuota.gateZoneOf?.(accountId, { tier: vmTierOf(vm), account }) || null
    }
    // A sticky preference must not bypass exhausted kernel recovery.
    if (kernelFaults.has(vm.id)) return { ok: false, reason: 'kernel_faulted' }
    // Node offline or asleep: the relay has no link behind it, a pick would only fail. Back on reconnect.
    if (!vmNodeReady(vm)) return { ok: false, reason: 'node_offline' }
    if (rustKernelBusy(workerStatus)) {
      markWait('slot_busy')
    } else if (workerStatus && rustKernelProcessUp(workerStatus) && !rustKernelReachable(workerStatus)) {
      return { ok: false, reason: 'worker_unhealthy' }
    }
    return { ok: true, account, workerStatus, busy, availableAt, waitReason, headroom, gateZone }
  }

  executionContext(vm, accountId) {
    const homeDir = vmCliHomePath(this.projectRoot, vm.id)
    const slot = readSlotCredentialIdentity(homeDir)
    return {
      vmId: vm.id,
      accountId,
      vm,
      vmPath: vmJsonPath(this.projectRoot, vm.id),
      homeDir,
      oauth: {
        email: slot?.email || vm.claude?.email || null,
        account_uuid: slot?.account_uuid || accountId || vm.claude?.account_uuid || null,
        org_uuid: slot?.org_uuid || vm.claude?.org_uuid || null,
        expires_at: slot?.expires_at || vm.claude?.expires_at || null,
      },
      proxyUrl: vm.proxy?.url || null,
      timezone: vm.timezone || 'UTC',
      locale: vm.locale || 'en_US.UTF-8',
      kernel: vm.kernel || null,
    }
  }

  async getWorkerHealth(exec, { signal = undefined, state = null } = {}) {
    if (signal?.aborted) throw makeAbortError()
    if (typeof this.workerHealth !== 'function') return { ok: true, source: 'scheduler-no-health-provider' }
    const cached = this.healthCache.get(exec.vmId)
    if (
      cached &&
      cached.accountId === exec.accountId &&
      Number(state?.credential_generation || 0) <= cached.generation &&
      Date.now() - cached.at < this.config.worker_health_ttl_ms
    )
      return cached.value
    const flightKey = `${exec.vmId}:${exec.accountId}`
    let flight = this.healthFlights.get(flightKey)
    if (!flight) {
      flight = this.refreshWorkerHealth(exec, state).finally(() => {
        if (this.healthFlights.get(flightKey) === flight) this.healthFlights.delete(flightKey)
      })
      this.healthFlights.set(flightKey, flight)
    }
    if (!signal) return await flight
    return await new Promise((resolve, reject) => {
      const onAbort = () => reject(makeAbortError())
      signal.addEventListener('abort', onAbort, { once: true })
      flight
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort))
        .catch(reject)
      if (signal.aborted) onAbort()
    })
  }

  async refreshWorkerHealth(exec, state) {
    const now = Date.now()
    let value
    try {
      value = await this.workerHealth(exec, {})
    } catch (error) {
      value = { ok: false, error: String(error.message || error) }
    }
    if (this.runtimeRepo && exec.accountId) {
      const prev = state
      const prevGen = Number(prev?.credential_generation) || 0
      const nextGen = Number(value?.credential?.generation) || 0
      const effectiveGen = Math.max(prevGen, nextGen)
      this.healthWrites.set(exec.accountId, {
        account_id: exec.accountId,
        vm_id: exec.vmId,
        status: runtimeHealthStatus(value),
        worker_heartbeat_at: now,
        worker_status: value,
        credential_generation: effectiveGen,
        refresh_status: value?.credential?.credential_state || (value?.credential?.needs_refresh ? 'needed' : 'fresh'),
      })
      const liveMs = expiresAtToMs(value?.credential?.expires_at)
      const prevMs = expiresAtToMs(prev?.worker_status?.credential?.expires_at)
      if (
        value?.ok &&
        (value?.credential?.has_access || value?.credential?.has_refresh) &&
        exec.homeDir &&
        exec.vmId &&
        (nextGen > prevGen || (liveMs && liveMs > (prevMs || 0) + 2000))
      ) {
        try {
          const vmPath = String(exec.homeDir).replace(/\/cli-home\/?$/, '.json')
          const mirrored = await mirrorWorkerCredentialsToVm(vmPath, exec.homeDir)
          const uuid = mirrored?.claude?.account_uuid || exec.accountId
          if (uuid && uuid !== exec.vmId) {
            await this.accountQuota?.rebindToVm?.(uuid, exec.vmId, { email: mirrored?.claude?.email })
          }
        } catch {}
      }
      if (value?.ok && (value?.credential?.has_access || value?.credential?.has_refresh) && exec.vmId) {
        // A live worker ticket does not reopen 不可调度: only an operator action does.
        // Leftover TTL must not wipe a 401 park. Only a newer generation is a rotation.
        if (prevGen > 0 && nextGen > prevGen) {
          await this.clearAuthCooldownFor(exec.vmId, exec.accountId)
          try {
            await clearVmAuthCooldown(vmJsonPath(this.projectRoot, exec.vmId))
          } catch {}
        }
      }
    }
    this.healthCache.set(exec.vmId, {
      at: Date.now(),
      value,
      accountId: exec.accountId,
      generation: Math.max(Number(state?.credential_generation) || 0, Number(value?.credential?.generation) || 0),
    })
    return value
  }

  startMaintenance() {
    if (this.maintenanceTimer) return
    this.maintenanceStopped = false
    const tick = () => {
      if (this.maintenanceFlight) return
      this.maintenanceFlight = this.maintain()
        .catch((error) => {
          console.error('[pool-maintenance]', error.message)
        })
        .finally(() => {
          this.maintenanceFlight = null
        })
    }
    this.maintenanceTimer = setInterval(tick, Math.max(1000, this.config.worker_health_ttl_ms))
    this.maintenanceTimer.unref()
    tick()
  }

  stopMaintenance() {
    clearInterval(this.maintenanceTimer)
    this.maintenanceTimer = null
    this.maintenanceStopped = true
  }

  async flushHealthWrites() {
    if (this.maintenanceStopped) return
    for (const [accountId, update] of this.healthWrites) {
      await this.runtimeRepo.writeHeartbeat(update)
      if (this.healthWrites.get(accountId) === update) this.healthWrites.delete(accountId)
    }
  }

  async maintain() {
    await this.flushHealthWrites()
    const now = Date.now()
    if (!this.lastCleanupAt || now - this.lastCleanupAt >= 30000) {
      await this.runtimeRepo.clearExpired(now)
      await this.stickyRouter?.repo?.purgeExpired(now)
      this.lastCleanupAt = now
    }
    const vms = listVms(this.projectRoot)
      .map((summary) => getVm(this.projectRoot, summary.id))
      .filter((vm) => vm && vm.schedulable !== false && vm.status === 'running' && !isCodexVm(vm))
    const snapshots = await this.runtimeRepo.schedulingSnapshot(vms.map((vm) => accountIdOf(vm, this.projectRoot)))
    for (const vm of vms) {
      if (this.maintenanceStopped) return
      const accountId = accountIdOf(vm, this.projectRoot)
      await this.getWorkerHealth(this.executionContext(vm, accountId), { state: snapshots.get(accountId)?.state })
    }
    await this.flushHealthWrites()
  }

  clearAuthCooldownFor(vmId, accountId = null) {
    const ids = [...new Set([accountId, vmId].filter(Boolean))]
    let cleared = false
    for (const id of ids) {
      try {
        if (this.runtimeRepo?.clearAuthCooldown?.(id, { vmId })) cleared = true
      } catch {}
    }
    if (cleared) {
      try {
        this.notifyCapacity()
      } catch {}
    }
    return cleared
  }

  /** Live ticket after import/login: drop leftover oauth_revoked park. */
  clearGrantRevokeCooldownFor(vmId, accountId = null) {
    const ids = [...new Set([accountId, vmId].filter(Boolean))]
    let cleared = false
    for (const id of ids) {
      try {
        if (this.runtimeRepo?.clearGrantRevokeCooldown?.(id, { vmId })) cleared = true
      } catch {}
    }
    if (cleared) {
      try {
        this.notifyCapacity()
      } catch {}
    }
    return cleared
  }

  /** Session leaves this VM: drop its alias keys. A device seat lives in the planner, not here. */
  releaseSticky(bound, stickyKey, stickyKeys) {
    const keys = Array.isArray(stickyKeys) && stickyKeys.length ? stickyKeys : stickyKey ? [stickyKey] : []
    for (const key of keys) this.stickyRouter?.unbind?.(key)
  }

  /**
   * The account left the pool for a hard reason (quota, credential): every
   * conversation pinned to it moves. In-flight leases keep their own release;
   * seats on it move with the device's next request.
   */
  releaseAccountSessions({ accountId = null, vmId = null } = {}) {
    if (!accountId && !vmId) return 0
    return this.stickyRouter?.unbindByAccount?.({ accountId, vmId }) || 0
  }

  /**
   * Direct path (pins, seatless probes). Sticky, family, and device are
   * preferences, never filters. A busy home lends this one request to another
   * free unit; the durable pin survives. `spilled`: accounts this request
   * skipped only for capacity (kernel slot_busy). Their pin survives; the next
   * turn returns. Ties inside one priority/load level use the balanced order.
   */
  pick(
    candidates,
    { stickyKey, eligible = candidates, spilled = null, stickyKeys = null, deviceVmId = null, familyVmId = null } = {},
  ) {
    this.lastStickyCleared = false
    if (!candidates.length && !eligible?.length) return null
    const sticky = this.reconcileSticky({
      stickyKey,
      stickyKeys,
      eligible: eligible || candidates,
      spilled,
      familyVmId,
    })
    this.lastStickyCleared = sticky.cleared
    let borrowed = false
    if (sticky.match) {
      const inPool = candidates.some(
        (candidate) => candidate.vmId === sticky.match.vmId && candidate.accountId === sticky.match.accountId,
      )
      if (inPool && this.isReservable(sticky.match)) return { ...sticky.match, selectionReason: 'sticky' }
      // Capacity, or a replay steering around this unit: borrow, keep the pin.
      borrowed = true
    }
    if (!candidates.length) return null
    const reasonFor = (reason) => (borrowed ? 'sticky-spill' : reason)
    const familyVm = familyVmId ? String(familyVmId).trim() : ''
    if (familyVm) {
      const home = candidates.find((candidate) => candidate.vmId === familyVm && this.isReservable(candidate))
      if (home) return { ...home, selectionReason: reasonFor('family-affinity') }
    }
    const deviceVm = deviceVmId ? String(deviceVmId).trim() : ''
    if (deviceVm) {
      const preferred = candidates.find((candidate) => candidate.vmId === deviceVm && this.isReservable(candidate))
      if (preferred) return { ...preferred, selectionReason: reasonFor('device-affinity') }
    }
    const highestPriority = Math.max(...candidates.map((candidate) => candidate.priority))
    let pool = candidates.filter((candidate) => candidate.priority === highestPriority)
    const minLoad = Math.min(...pool.map((candidate) => candidate.loadRatio))
    pool = pool.filter((candidate) => candidate.loadRatio === minLoad)
    if (pool.length === 1) return { ...pool[0], selectionReason: reasonFor('priority-load') }
    const [balanced] = rankSeatCandidates(pool, {
      strategy: 'balanced',
      openOf: (vmId) => this.planner.openCount(vmId),
    })
    return { ...balanced, selectionReason: reasonFor('balanced') }
  }

  peekRank(candidates = []) {
    if (!candidates.length) return null
    const highestPriority = Math.max(...candidates.map((candidate) => candidate.priority))
    let pool = candidates.filter((candidate) => candidate.priority === highestPriority)
    const minLoad = Math.min(...pool.map((candidate) => candidate.loadRatio))
    pool = pool.filter((candidate) => candidate.loadRatio === minLoad)
    pool.sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.accountId.localeCompare(right.accountId))
    return { ...pool[0], selectionReason: pool.length === 1 ? 'priority-load' : 'peek' }
  }

  /** Read-only current account. Never bind, unbind, or reserve. */
  async peekAccount({ model, stickyKey = null, signal, ownerScope = PLATFORM_SCOPE, keyScope = null } = {}) {
    const candidates = await this.eligibleCandidates({ model, signal, ownerScope, keyScope })
    if (!candidates.length) {
      const empty = emptyPoolFailure(candidates)
      return { ok: false, code: empty.reason, retry_after_ms: empty.retry_after_ms }
    }
    const bound = stickyKey ? this.stickyRouter?.resolve?.(stickyKey) : null
    if (bound) {
      const match = candidates.find(
        (candidate) => candidate.vmId === bound.vmId && candidate.accountId === bound.accountId,
      )
      if (match) return { ok: true, ...match, selectionReason: 'sticky' }
    }
    const idle = candidates.filter((candidate) => !candidate.busy)
    const selected = this.peekRank(idle.length ? idle : candidates)
    if (!selected) return { ok: false, code: 'no_eligible_accounts' }
    return { ok: true, ...selected }
  }

  familyInflight(accountId, family) {
    return this.inflightFamily.get(accountId)?.get(family) || 0
  }

  bumpFamily(accountId, family, delta) {
    if (!family) return
    let byFamily = this.inflightFamily.get(accountId)
    if (!byFamily) {
      byFamily = new Map()
      this.inflightFamily.set(accountId, byFamily)
    }
    const next = Math.max(0, (byFamily.get(family) || 0) + delta)
    if (next === 0) byFamily.delete(family)
    else byFamily.set(family, next)
    if (byFamily.size === 0) this.inflightFamily.delete(accountId)
  }

  effectiveMaxConcurrency(vm, account, fallback = 2) {
    if (vm?.policy?.concurrencyOverride) return maxConcurrencyOf(vm, fallback)
    const fromQuota = this.accountQuota?.limitFor?.(
      account,
      this.accountQuota?.policyFor?.(account, { tier: vmTierOf(vm) }),
    )
    if (fromQuota != null && Number.isFinite(Number(fromQuota))) return Math.max(0, Number(fromQuota))
    return maxConcurrencyOf(vm, fallback)
  }

  reloadConfig(config = {}) {
    this.config = normalizePoolConfig(config)
    this.planner.configure({
      graceMs: this.config.seat_grace_ms,
      reservePct: this.config.seat_budget_reserve_pct,
      strategy: this.config.strategy,
    })
    this.notifyCapacity()
  }

  /** Revalidate the live account/VM state before a request claims execution capacity. */
  admissionSnapshot(candidate, { pinned = false } = {}) {
    if (candidate.signal?.aborted) throw makeAbortError()
    const vm = getVm(this.projectRoot, candidate.vmId)
    if (
      !vm ||
      accountIdOf(vm, this.projectRoot) !== candidate.accountId ||
      !vmMatchesOwnerScope(vm, candidate.ownerScope || PLATFORM_SCOPE) ||
      !keyAllowsVm(candidate.keyScope, vm)
    )
      return null
    const gate = evaluateSlotGate(vm)
    if (!gate.ok && gate.reason !== 'no_credential' && !(pinned && gate.reason === 'vm_unschedulable')) return null
    if (!slotHasBoundProxy(vm) || kernelFaults.has(vm.id) || !vmNodeReady(vm)) return null
    const proxySync = evaluateProxySync({
      vm,
      workerProxyEndpoint: readWorkerProxyEndpoint(this.projectRoot, vm.id),
      egressMode: readWorkerEgressMode(this.projectRoot, vm.id),
    })
    if (!proxySync.ok) return null
    const now = Date.now()
    const snapshot = this.runtimeRepo?.schedulingSnapshot([candidate.accountId]).get(candidate.accountId)
    let state = snapshot?.state || null
    const account = snapshot?.account
    const cached = this.healthCache.get(vm.id)
    if (
      typeof this.workerHealth === 'function' &&
      (!cached ||
        cached.accountId !== candidate.accountId ||
        now - cached.at >= this.config.worker_health_ttl_ms ||
        Number(state?.credential_generation || 0) > cached.generation)
    )
      return null
    const health = cached?.value || candidate.workerStatus
    if (!evaluateCredentialEligibility({ vm, workerStatus: health, now }).ok) return null
    if (!rustKernelBusy(health) && rustKernelProcessUp(health) && !rustKernelReachable(health)) return null
    state = viewRuntimeWithoutLeftoverRevoke(state, vm)
    const noRefreshPin = pinned && state?.cooldown_reason === 'oauth_no_refresh'
    if (!noRefreshPin && isCredentialRuntimeBlocked(state, now, vm)) return null
    if (!pinned) {
      if (hardBlockOf(state, now)) return null
      if (account && account.status !== 'active') return null
      if (account) {
        const availability = evaluateAccount({
          vm,
          account,
          hasToken: !!(vm.claude?.has_access || vm.has_token),
          hasRefresh: hasRefreshPresence(vm.claude) || !!vm.has_refresh,
          schedulable: vm.schedulable !== false,
          scheduleDisabledReason: vm.schedule_disabled_reason,
          lastProbe: account.last_probe || account.unified?.last_probe,
          probeSource: account.unified?.source,
          refreshError: vm.claude?.refresh_error,
          expiresAt: vm.claude?.expires_at || vm.expires_at,
          refreshedAt: vm.claude?.refreshed_at,
          workerCredential: health?.credential,
          quota: account.unified ? listQuotaFromHeaders(account.unified, { now }) : {},
          policy: this.accountQuota?.policyFor?.(account, { tier: vmTierOf(vm) }),
          cooldownUntil: state?.cooldown_until,
          cooldownReason: state?.cooldown_reason,
          now,
        })
        if (!availability.accept && availability.key !== 'cool') return null
      }
      if (!slotAllowsModel({ vm, account, model: candidate.model }).ok) return null
      if (!evaluateActiveHours(activeHoursOf(vm), now, vm.timezone).active) return null
      if (cooldownActive(state?.cooldown_until, now)) return null
      if (isFableModel(candidate.model) && this.accountQuota?.fableWindowLimited?.(candidate.accountId, now, account))
        return null
      if (
        this.accountQuota?.weeklySplitOf &&
        splitBlocksModel(this.accountQuota.weeklySplitOf(candidate.accountId, account), candidate.model)
      )
        return null
    }
    for (const key of modelCooldownKeys(candidate.model)) {
      if (cooldownActive(state?.model_states?.[key]?.cooldown_until, now)) return null
    }
    candidate.vm = vm
    candidate.maxConcurrency = this.effectiveMaxConcurrency(vm, account, 2)
    return { account }
  }

  /** Synchronous request permit; affinity seats and transport workers never own the counters. */
  reserve(candidate, { skipQuota = false, pinned = false } = {}) {
    const { accountId, vmId } = candidate
    const snapshot = candidate.exec ? this.admissionSnapshot(candidate, { pinned }) : {}
    if (!snapshot) return null
    const requestInflight = this.inflight.get(candidate.accountId) || 0
    if (!candidate.maxConcurrency || requestInflight >= candidate.maxConcurrency) return null
    const family = isFableModel(candidate.model) ? FABLE_FAMILY_KEY : null
    const fableCap = Number(this.config.fable_max_per_account)
    if (
      family &&
      Number.isFinite(fableCap) &&
      fableCap > 0 &&
      this.familyInflight(candidate.accountId, family) >= fableCap
    ) {
      return null
    }
    const quotaReservation = this.accountQuota?.tryAcquire?.(accountId, {
      skipGate: !!skipQuota,
      tier: vmTierOf(candidate.vm),
      quotaRequest: candidate.quotaRequest,
      account: snapshot.account,
    })
    if (quotaReservation && !quotaReservation.ok) return null
    const releaseQuota = () => {
      if (quotaReservation?.release) quotaReservation.release()
      else if (quotaReservation) this.accountQuota?.release?.(accountId)
    }
    // A pin is an operator diagnostic: it reaches the slot without taking the probe.
    const circuitHold = pinned ? null : this.unitCircuit?.admit?.(accountId)
    if (circuitHold && !circuitHold.ok) {
      releaseQuota()
      return null
    }
    // Admission hooks may release an existing reservation. Use the live count
    // rather than restoring occupancy from before those hooks ran.
    this.inflight.set(accountId, (this.inflight.get(accountId) || 0) + 1)
    this.bumpFamily(accountId, family, 1)
    this.bumpVmInflight(vmId, 1)
    let released = false
    return {
      reserved: true,
      slotIndex: null,
      quotaToken: quotaReservation?.token,
      release: (releaseSeat) => {
        if (released) return
        released = true
        const next = this.inflight.get(accountId) - 1
        if (next === 0) this.inflight.delete(accountId)
        else this.inflight.set(accountId, next)
        this.bumpFamily(accountId, family, -1)
        this.bumpVmInflight(vmId, -1)
        releaseQuota()
        if (circuitHold?.probe) this.unitCircuit?.releaseProbe?.(accountId)
        if (releaseSeat) releaseSeat()
        else this.planner.pump(vmId)
        this.notifyCapacity(accountId)
      },
    }
  }

  /** Live request count per VM for the panel seat stream; every change pushes a frame. */
  bumpVmInflight(vmId, delta) {
    if (!vmId) return
    const id = String(vmId)
    const next = Math.max(0, (this.vmInflight.get(id) || 0) + delta)
    if (next === 0) this.vmInflight.delete(id)
    else this.vmInflight.set(id, next)
    this.signalChange()
  }

  /** Observers must not run in the middle of a seat/permit transition. */
  signalChange() {
    if (this.changePending) return
    this.changePending = true
    queueMicrotask(() => {
      this.changePending = false
      this.emit('change')
    })
  }

  markSuccess(candidate, { workerStatus = null, countUsage = true } = {}) {
    const now = Date.now()
    if (countUsage !== false) this.accountQuota?.noteBandSettled?.(candidate.accountId, candidate.quotaToken)
    const prev = this.runtimeRepo?.get?.(candidate.accountId)
    if (countUsage !== false) this.lastUsed.set(candidate.accountId, now)
    this.runtimeRepo?.upsert?.({
      account_id: candidate.accountId,
      vm_id: candidate.vmId,
      status: 'ready',
      priority: candidate.priority,
      weight: candidate.weight,
      cooldown_until: null,
      cooldown_reason: null,
      last_used_at: countUsage === false ? prev?.last_used_at || this.lastUsed.get(candidate.accountId) || null : now,
      worker_heartbeat_at: workerStatus ? now : candidate.state?.worker_heartbeat_at,
      worker_status: workerStatus || candidate.state?.worker_status || null,
    })
    if (this.projectRoot && candidate.vmId) {
      try {
        clearVmAuthCooldown(vmJsonPath(this.projectRoot, candidate.vmId))
      } catch {}
    }
  }

  markCooldown(candidate, { until, reason, model = null, status = 'cooldown' } = {}) {
    this.runtimeRepo?.markCooldown?.(candidate.accountId, {
      vmId: candidate.vmId,
      until,
      reason,
      model: model ? normalizeModel(model) : null,
      status,
    })
    if (isAuthCooldownReason(reason) && this.projectRoot && candidate.vmId) {
      try {
        markVmAuthCooldown(vmJsonPath(this.projectRoot, candidate.vmId), {
          until,
          reason,
          generation:
            candidate.workerStatus?.credential?.generation ??
            candidate.state?.credential_generation ??
            candidate.vm?.claude?._token_version ??
            candidate.vm?.claude?.expires_at ??
            null,
        })
      } catch {}
    } else if (!model && isAccountRestrictionReason(reason) && this.projectRoot && candidate.vmId) {
      try {
        markVmRestriction(vmJsonPath(this.projectRoot, candidate.vmId), { until, reason })
      } catch {}
    }
    this.healthCache.delete(candidate.vmId)
    this.scheduleCooldownWake(candidate.accountId, until)
  }

  scheduleCooldownWake(accountId, until) {
    const prev = this.cooldownTimers.get(accountId)
    if (prev) clearTimeout(prev)
    const delay = Math.max(1, Number(until) - Date.now())
    if (!Number.isFinite(delay) || delay > 24 * 60 * 60 * 1000) return
    const timer = setTimeout(() => {
      this.cooldownTimers.delete(accountId)
      this.notifyCapacity()
    }, delay)
    timer.unref?.()
    this.cooldownTimers.set(accountId, timer)
  }

  waiterCount(accountId) {
    if (!accountId) return 0
    return this.waiters.get(accountId)?.size || 0
  }

  totalWaiters() {
    let total = 0
    for (const bucket of this.waiters.values()) total += bucket.size
    return total
  }

  waiterSnapshot() {
    const perAccount = {}
    for (const [accountId, bucket] of this.waiters) {
      perAccount[accountId] = bucket.size
    }
    return { ...perAccount, total: this.totalWaiters() }
  }

  isReservable(candidate) {
    if (!candidate) return false
    const inflight = candidate.inflight || 0
    const conc = Number(candidate.maxConcurrency) || 0
    if (conc > 0 && inflight >= conc) return false
    if (!candidate.busy) return true
    return candidate.waitReason === 'slot_busy'
  }

  makeWaitPlan(candidate, { sticky = false, requestDeadline = null } = {}) {
    const now = Date.now()
    const base = sticky ? this.config.sticky_wait_timeout_ms : this.config.fallback_wait_timeout_ms
    const failoverLeft = Number.isFinite(requestDeadline) ? requestDeadline - now : Infinity
    const timeoutMs = Math.max(0, Math.min(base, failoverLeft))
    return {
      accountId: candidate?.accountId || null,
      vmId: candidate?.vmId || null,
      reason: candidate?.waitReason || null,
      timeoutMs,
      sticky: !!sticky,
      deadline: now + timeoutMs,
      availableAt: candidate?.availableAt || null,
    }
  }

  remainingSlotWaitMs({ startedAt, loopDeadline, sticky = false } = {}) {
    const now = Date.now()
    const base = sticky ? this.config.sticky_wait_timeout_ms : this.config.fallback_wait_timeout_ms
    const failoverLeft = Number.isFinite(loopDeadline) ? loopDeadline - now : Infinity
    const planLeft = base - (now - Number(startedAt || now))
    return Math.max(0, Math.min(base, failoverLeft, planLeft))
  }

  slotWaitDeadlineMs({ startedAt, loopDeadline, sticky, allowWait }) {
    if (!allowWait) return Date.now()
    const base = sticky ? this.config.sticky_wait_timeout_ms : this.config.fallback_wait_timeout_ms
    return Math.min(loopDeadline, startedAt + base)
  }

  resolveWaitPlan({ candidates = [], stickyKey = null, stickyCleared = false, requestDeadline = null } = {}) {
    const bound = !stickyCleared && stickyKey ? this.stickyRouter?.resolve?.(stickyKey) : null
    if (bound) {
      const match = candidates.find(
        (candidate) => candidate.vmId === bound.vmId && candidate.accountId === bound.accountId,
      )
      if (
        match &&
        match.busy &&
        stickyShouldWait(match.waitReason, match.cooldownReason) &&
        !this.isReservable(match)
      ) {
        return this.makeWaitPlan(match, { sticky: true, requestDeadline })
      }
    }
    const waitable = candidates.filter((candidate) => candidate.busy && !this.isReservable(candidate))
    const peek = this.peekRank(waitable)
    return peek ? this.makeWaitPlan(peek, { sticky: false, requestDeadline }) : null
  }

  /** Direct waiters can receive a permit, not just a notification to try again. */
  waitForCapacity({
    signal,
    deadline,
    refreshAt,
    stickyKey,
    accountId = null,
    vmId = null,
    sticky = false,
    tryGrant,
  } = {}) {
    const bucketId = String(accountId || stickyKey || '_pool')
    if (this.queuedTotal() >= this.config.queue_max) throw this.queueFullError(vmId ? [vmId] : null)
    const id = Symbol('pool-waiter')
    let bucket = this.waiters.get(bucketId)
    if (!bucket) {
      bucket = new Map()
      this.waiters.set(bucketId, bucket)
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (!bucket.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (!bucket.size) this.waiters.delete(bucketId)
        this.signalChange()
      }
      const finish = (result) => {
        cleanup()
        resolve(result)
      }
      const onAbort = () => {
        cleanup()
        reject(makeAbortError())
      }
      const refresh = () => {
        if (bucket.has(id)) finish({ woken: Date.now() < deadline })
      }
      const timer = setTimeout(
        () => {
          if (Date.now() >= deadline) return refresh()
          this.dueWaiterRefreshes.add(refresh)
          if (this.dueWaiterRefreshes.size === 1) {
            setImmediate(() => {
              const due = this.dueWaiterRefreshes
              this.dueWaiterRefreshes = new Set()
              // Keep tickets queued for one ordered grant sweep before refreshing snapshots.
              this.notifyCapacity(null, { refresh: false })
              for (const wake of due) wake()
            })
          }
        },
        Math.max(1, (refreshAt ?? deadline) - Date.now()),
      )
      let granting = false
      bucket.set(id, {
        sequence: ++this.waiterSequence,
        sticky: !!sticky,
        vmId: vmId ? String(vmId) : null,
        wake: (releasedAccount, refresh) => {
          if (granting || !bucket.has(id)) return
          if (signal?.aborted) return onAbort()
          if (Date.now() >= deadline) return finish({ woken: false })
          granting = true
          try {
            const grant = tryGrant?.(releasedAccount)
            if (signal?.aborted && grant) {
              grant.reservation.release()
              return
            }
            if (grant || refresh) finish({ woken: true, grant })
            return !!grant
          } catch (error) {
            cleanup()
            reject(error)
          } finally {
            granting = false
          }
        },
      })
      this.signalChange()
      if (signal?.aborted) onAbort()
      else signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

  /** On release, claim before waking; on a broad state change also refresh stale candidates. */
  notifyCapacity(accountId = null, { refresh = !accountId } = {}) {
    if (!accountId) this.planner.pumpAll()
    const local = accountId ? [...(this.waiters.get(accountId)?.values() || [])] : []
    for (const entry of local) if (entry.wake(accountId)) return
    const pending = []
    for (const [id, bucket] of this.waiters) {
      if (id === accountId) continue
      for (const entry of bucket.values()) {
        if (!accountId || !entry.sticky) pending.push(entry)
      }
    }
    pending.sort((a, b) => a.sequence - b.sequence)
    for (const entry of pending) {
      if (entry.wake(accountId, refresh) && accountId) return
    }
  }

  /**
   * Extra 5h/7d reject → restriction (temp_unschedulable_* + runtime cooldown).
   * Never flips the operator switch. Leftover quota-off that is not
   * schedule_manual is restored to on + restriction.
   */
  syncQuotaSchedule(vm, account = null, state = undefined) {
    if (!this.projectRoot || !vm?.id) return { action: 'keep', reason: null }
    const accountId = account?.account_id || vm.claude?.account_uuid || vm.id
    account = account || this.accountQuota?.repo?.get?.(accountId) || null
    if (!account) return { action: 'keep', reason: null }
    const now = Date.now()
    const lastUsedAt = this.lastUsed.get(accountId) || account.last_used_at || 0
    const ev = evaluateAccount({
      vm: {
        ...vm,
        claude: {
          ...(vm.claude || {}),
          temp_unschedulable_until: undefined,
          temp_unschedulable_reason: undefined,
        },
        temp_unschedulable_until: undefined,
        temp_unschedulable_reason: undefined,
      },
      account: { ...account, last_used_at: lastUsedAt },
      hasToken: !!(vm?.claude?.has_access || vm?.has_token),
      hasRefresh: hasRefreshPresence(vm?.claude) || !!vm?.has_refresh,
      schedulable: true,
      scheduleDisabledReason: null,
      lastProbe: account.last_probe || account.unified?.last_probe || null,
      probeSource: account.unified?.source || account.last_probe?.source || null,
      workerLastError: account.worker_status?.last_error || vm.claude?.refresh_error,
      refreshError: vm.claude?.refresh_error,
      expiresAt: vm.claude?.expires_at || vm.expires_at || null,
      refreshedAt: vm.claude?.refreshed_at || vm.refreshed_at || null,
      workerCredential: account.worker_status?.credential || null,
      quota: account.unified
        ? {
            ...listQuotaFromHeaders(account.unified, { now }),
            last_used_at: lastUsedAt,
            last_probe: account.last_probe || account.unified.last_probe,
            probe_source: account.unified.source,
          }
        : {},
      policy: this.accountQuota?.policyFor?.(account, { tier: vmTierOf(vm) }) || null,
      now,
    })
    const leftover = isLeftoverQuotaScheduleOff(vm)
    const file = vmJsonPath(this.projectRoot, vm.id)
    if (!ev.accept && isQuotaWindowReason(ev.reason)) {
      const until = Number(ev.until) || now + 5 * 60_000
      this.applyQuotaRestriction(vm, accountId, { until, reason: ev.reason, file })
      if (leftover) {
        migrateVmSchedule(this.projectRoot, vm.id)
        vm.schedulable = true
        vm.schedule_disabled_reason = null
        return { action: 'restore', reason: ev.reason, until }
      }
      return { action: 'restrict', reason: ev.reason, until }
    }
    if (ev.accept) {
      this.clearQuotaRestriction(vm, accountId, file, state)
      if (leftover) {
        migrateVmSchedule(this.projectRoot, vm.id)
        vm.schedulable = true
        vm.schedule_disabled_reason = null
        return { action: 'enable', reason: null }
      }
      return { action: 'clear', reason: null }
    }
    if (leftover) {
      migrateVmSchedule(this.projectRoot, vm.id)
      vm.schedulable = true
      vm.schedule_disabled_reason = null
      return { action: 'restore', reason: ev.reason || null }
    }
    return { action: 'keep', reason: ev.reason || null }
  }

  applyQuotaRestriction(vm, accountId, { until, reason, file }) {
    this.runtimeRepo?.markCooldown?.(accountId, {
      vmId: vm.id,
      until,
      reason,
      status: 'cooldown',
    })
    const next = markVmRestriction(file, { until, reason })
    if (next) {
      vm.claude = next.claude || vm.claude
      vm.temp_unschedulable_until = next.temp_unschedulable_until
      vm.temp_unschedulable_reason = next.temp_unschedulable_reason
    }
    this.scheduleCooldownWake(accountId, until)
  }

  clearQuotaRestriction(vm, accountId, file, state = undefined) {
    if (state === undefined) state = this.runtimeRepo?.get?.(accountId)
    // A live 429 block lifts only on its reset or an `allowed` header, never
    // from a passive Extra re-read (sub2api ClearRateLimit via UpdateSessionWindow).
    if (hardBlockOf(state)) return false
    const reason = state?.cooldown_reason || vm.claude?.temp_unschedulable_reason || vm.temp_unschedulable_reason
    if (reason && !isAccountRestrictionReason(reason) && !isQuotaWindowReason(reason)) return false
    if (isAuthCooldownReason(reason)) return false
    if (state && isAccountRestrictionReason(state.cooldown_reason)) {
      this.runtimeRepo?.upsert?.({
        account_id: accountId,
        vm_id: vm.id,
        cooldown_until: null,
        cooldown_reason: null,
        status: 'ready',
      })
    }
    const next = clearVmQuotaRestriction(file)
    if (next) {
      vm.claude = next.claude || vm.claude
      delete vm.temp_unschedulable_until
      delete vm.temp_unschedulable_reason
    }
    return true
  }

  snapshot() {
    const family = {}
    for (const [accountId, byFamily] of this.inflightFamily) {
      family[accountId] = Object.fromEntries(byFamily)
    }
    const seat = this.seatSnapshot()
    return {
      strategy: this.config.strategy,
      fable_max_per_account: this.config.fable_max_per_account,
      inflight: Object.fromEntries(this.inflight),
      inflight_family: family,
      waiters: this.waiterSnapshot(),
      health_cache: Object.fromEntries([...this.healthCache].map(([id, entry]) => [id, entry.value])),
      seats: seat.seats,
      pool_queue: { global_queue_depth: seat.global_queue_depth, queue_max: seat.queue_max },
    }
  }

  /**
   * Seats, queues and live requests per VM for panel rows and the seat stream.
   * `seats_used` is sessions holding a slot (in flight or held until sticky
   * TTL). `sessions` lists those occupants. `queue_depth` counts every request
   * waiting on that VM (seat, concurrency, cooldown/RPM); `conc_waiting` is
   * the concurrency share of it; `inflight` is requests holding a reservation
   * on it right now (seatless and pinned too).
   */
  seatSnapshot() {
    const { seats, global_queue_depth } = this.planner.snapshot()
    const row = (vmId) =>
      (seats[vmId] ||= {
        seats_used: 0,
        seats_max: this.planner.caps.get(vmId) || 0,
        seats_grace: 0,
        queue_depth: 0,
        conc_waiting: 0,
        sessions: [],
      })
    for (const bucket of this.waiters.values()) {
      for (const entry of bucket.values()) {
        if (entry?.vmId) row(entry.vmId).queue_depth += 1
      }
    }
    for (const entry of Object.values(seats)) {
      entry.inflight = 0
      if (!Array.isArray(entry.sessions)) entry.sessions = []
    }
    for (const [vmId, count] of this.vmInflight) row(vmId).inflight = count
    return { seats, global_queue_depth, queue_max: this.config.queue_max }
  }
}
