import { EventEmitter } from 'node:events'
import { getVm, listVms, setVmSchedulable } from '../vm/vm-registry.mjs'
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
import { PLATFORM_SCOPE, normalizeOwnerId, vmMatchesOwnerScope } from '../admin/resource-owner.mjs'
import { keyAllowsVm } from '../admin/key-scope.mjs'
import {
  kernelFaults,
  rustKernelBusy,
  rustKernelProcessUp,
  rustKernelReachable,
} from '../transport/rust-kernel-client.mjs'
import { resolveSessionSlots } from '../vm/slot-engine.mjs'
import { SeatPlanner, rankSeatCandidates } from './seat-planner.mjs'
import { GATE_DRAINING } from './quota-gate.mjs'
import { activeHoursOf, evaluateActiveHours } from './active-hours.mjs'
import { vmNodeReady } from '../cluster/placement.mjs'
import { isKubernetesMode } from '../core/control-plane-mode.mjs'
import { getDb } from '../db/database.mjs'
import { SharedExecutionAdmissions } from './shared-execution-admissions.mjs'

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

/**
 * Nothing eligible. Fable keeps its Max gate; otherwise an upstream cooldown on
 * the dropped accounts names the cause: any 529 overload cooldown is capacity
 * (529), only 429 rate-limit cooldowns are the provider's limit (429). Without
 * either, nothing will come back by waiting (503) — unless every slot is just
 * inside its operator rest window, whose open time rides along as retry_after.
 */
function emptyPoolFailure(model, candidates, now = Date.now()) {
  if (isFableModel(model)) return { reason: 'fable_requires_max', retry_after_ms: null }
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
    waitReason === 'vm_concurrency_limit' ||
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
  'vm_concurrency_limit',
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
    executionAdmissions = null,
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
    this.shared = isKubernetesMode()
    this.executionAdmissions = this.shared
      ? executionAdmissions || new SharedExecutionAdmissions(accountQuota?.db || getDb())
      : null
    this.tasks = new Set()
    this.failure = null
    this.config = normalizePoolConfig(config)
    this.lastStickyCleared = false
    this.inflight = new Map()
    this.inflightFamily = new Map()
    /** vmId → live reservations; mirrors `inflight` (per account) for the panel. */
    this.vmInflight = new Map()
    this.waiters = new Map()
    this.healthCache = new Map()
    this.lastUsed = new Map()
    this.cooldownTimers = new Map()
    this.planner = new SeatPlanner({
      graceMs: this.config.seat_grace_ms,
      reservePct: this.config.seat_budget_reserve_pct,
      strategy: this.config.strategy,
      stickyWaitMs: () => this.config.sticky_wait_timeout_ms,
      onChange: () => this.emit('change'),
      asyncGrants: this.shared,
    })
    this.unitCircuit = unitCircuit
    if (runtimeRepo) this.unitCircuit.bindRepo(runtimeRepo)
  }

  /**
   * `seatKey` is the device seat identity (resolveSeatIdentity). Requests with
   * one go through the seat planner; pinned diagnostics, seatless probes and
   * keyless callers keep the direct pick-and-wait path.
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
        familyGated,
        ...selectionSnapshot(candidates, available, { reason, waitMs, stickyCleared, waitPool }),
      }
    }
    const failoverDeadline = Number(deadline) || null
    const defaultPlanMs = stickyKey ? this.config.sticky_wait_timeout_ms : this.config.fallback_wait_timeout_ms
    const loopDeadline = failoverDeadline || startedAt + defaultPlanMs
    const finishReserve = (selected, reservation) => ({
      ...selected,
      ...reservation,
      familyGated,
      stickyCleared,
      waitMs: Date.now() - startedAt,
      waitPlan: this.makeWaitPlan(selected, {
        sticky: selected.selectionReason === 'sticky',
        requestDeadline: loopDeadline,
      }),
      slotWaitMs: this.remainingSlotWaitMs({
        startedAt,
        loopDeadline,
        sticky: selected.selectionReason === 'sticky',
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
      // A gated family home (quota, credential, excluded) is a migration
      // signal for the caller. Busy is not: it still yields a candidate.
      const familyVm = familyVmId ? String(familyVmId).trim() : ''
      if (familyVm && !pinned && !candidates.some((candidate) => candidate.vmId === familyVm)) familyGated = true
      const available = candidates.filter((candidate) => this.isReservable(candidate))
      const preferred = avoid?.size
        ? available.filter((candidate) => !avoid.has(candidate.accountId) && !avoid.has(candidate.vmId))
        : available
      const stickySnapshot = this.stickyRouter?.shared
        ? await this.reconcileStickyShared({
            stickyKey,
            stickyKeys,
            eligible: candidates,
            spilled,
            familyVmId: familyGated ? null : familyVm,
          })
        : null
      let selected = this.pick(preferred, {
        stickyKey,
        stickySnapshot,
        eligible: candidates,
        spilled,
        stickyKeys,
        deviceVmId,
        familyVmId: familyGated ? null : familyVm,
      })
      if (this.lastStickyCleared) stickyCleared = true
      const reserveMisses = []
      const attempted = new Set()
      const attemptKey = (candidate) => (this.shared ? candidate.vmId : candidate.accountId)
      // Free capacity first: a sticky or preferred miss scans every other
      // candidate before anything waits. Borrowing never moves the durable pin.
      while (selected) {
        const reservation = await this.reserve(selected, { skipQuota: pinned, pinned })
        if (reservation) {
          if (signal?.aborted) {
            await reservation.release()
            throw makeAbortError()
          }
          return finishReserve(selected, reservation)
        }
        reserveMisses.push({ ...selected, busy: true, waitReason: selected.waitReason || 'concurrency_limit' })
        attempted.add(attemptKey(selected))
        const remaining = preferred.filter(
          (candidate) =>
            !attempted.has(attemptKey(candidate)) && !blocked.has(candidate.accountId) && !blocked.has(candidate.vmId),
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
            const missed = reserveMisses.find((item) => attemptKey(item) === attemptKey(candidate))
            return missed || candidate
          })
        : candidates
      const effectiveAvailable = reserveMisses.length
        ? available.filter((candidate) => !attempted.has(attemptKey(candidate)))
        : available
      const waitCandidates = reserveMisses.length ? effectiveCandidates : candidates
      const waitAvailable = reserveMisses.length ? effectiveAvailable : available
      if (waitCandidates.length === 0) {
        const empty = emptyPoolFailure(model, candidates)
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
      const concurrencyWait = waitPool.some((candidate) => candidate.busy && stickyShouldWait(candidate.waitReason))
      const waitPlan = this.resolveWaitPlan({
        candidates: waitPool,
        stickyKey,
        stickyCleared,
        requestDeadline: loopDeadline,
      })
      const waitDeadline = waitPlan?.deadline || loopDeadline
      if (wakeAts.length && Math.min(...wakeAts) >= waitDeadline && !concurrencyWait) {
        return fail('all_accounts_busy', waitCandidates, waitAvailable, waitPool)
      }
      if (!waitPlan || waitPlan.timeoutMs <= 0) {
        return fail('all_accounts_busy', waitCandidates, waitAvailable, waitPool)
      }
      const waitCap = Math.min(waitDeadline, loopDeadline)
      const sliceDeadline = Math.min(
        wakeAts.length ? Math.min(waitCap, ...wakeAts) : waitCap,
        this.shared ? Date.now() + QUEUE_REFRESH_MS : Infinity,
      )
      const waited = await this.waitForCapacity({
        signal,
        deadline: sliceDeadline,
        accountId: waitPlan.accountId,
        vmId: waitPlan.vmId,
        sticky: waitPlan.sticky,
        stickyKey,
      })
      // Notify continues the loop and re-reads eligibility from scratch.
      // Only a wait-plan / failover deadline timeout is all_accounts_busy.
      if (!waited?.woken && sliceDeadline >= waitCap) {
        return fail('all_accounts_busy', waitCandidates, waitAvailable, waitPool)
      }
    }
  }

  /**
   * Seat path (R1–R7). A seated device rides its seat and waits for VM
   * concurrency in that VM's FIFO, never on another VM. A new device takes a
   * free seat (sticky VM first, then strategy) or queues in arrival order:
   * on its sticky VM until `sticky_wait_timeout_ms`, then globally until
   * `fallback_wait_timeout_ms`. A seated device's concurrency wait times out
   * after `sticky_wait_timeout_ms`. Timeouts are `pool_queue_timeout`.
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
    ownerScope = PLATFORM_SCOPE,
    keyScope = null,
    quotaRequest = null,
  } = {}) {
    const startedAt = Date.now()
    const failoverDeadline = Number(deadline) || Number.POSITIVE_INFINITY
    const familyVm = familyVmId ? String(familyVmId).trim() : ''
    const deviceVm = deviceVmId ? String(deviceVmId).trim() : ''
    const avoided = (candidate) => !!avoid?.size && (avoid.has(candidate.accountId) || avoid.has(candidate.vmId))
    let stickyCleared = false
    let familyGated = false
    let seatMoved = false
    let candidates = []
    let ticket = null
    let consumed = false
    const fail = (reason) => {
      const waitMs = Date.now() - startedAt
      const available = candidates.filter((candidate) => this.isReservable(candidate))
      return {
        ok: false,
        code: 'no_available_accounts',
        waitMs,
        familyGated,
        retry_after_ms: this.planner.retryAfterMs(candidates.map((candidate) => candidate.vmId)),
        ...selectionSnapshot(candidates, available, { reason, waitMs, stickyCleared }),
      }
    }
    const finish = (granted) => {
      if (signal?.aborted) throw makeAbortError()
      consumed = true
      return {
        ...granted.candidate,
        ...granted.reservation,
        selectionReason: granted.selectionReason,
        seatKey,
        seatMoved: seatMoved && granted.seatOpened,
        familyGated,
        stickyCleared,
        waitMs: Date.now() - startedAt,
        slotWaitMs: this.remainingSlotWaitMs({ startedAt: Date.now(), loopDeadline: failoverDeadline, sticky: true }),
      }
    }
    try {
      for (;;) {
        if (signal?.aborted) throw makeAbortError()
        if (ticket?.error) throw ticket.error
        if (ticket?.granted) return finish(ticket.granted)
        candidates = await this.eligibleCandidates({ model, excluded, signal, ownerScope, keyScope, quotaRequest })
        // A grant can land while eligibility was being re-read.
        if (ticket?.granted) return finish(ticket.granted)
        if (familyVm && !candidates.some((candidate) => candidate.vmId === familyVm)) familyGated = true
        const sticky = await (this.stickyRouter?.shared ? this.reconcileStickyShared : this.reconcileSticky).call(
          this,
          {
            stickyKey,
            stickyKeys,
            eligible: candidates,
            spilled,
            familyVmId: familyGated ? null : familyVm,
          },
        )
        if (sticky.cleared) stickyCleared = true
        const byVm = new Map(candidates.map((candidate) => [candidate.vmId, candidate]))
        if (ticket) ticket.candidates = byVm
        const now = Date.now()
        // Home left the pool (circuit open, unschedulable, hard cooldown, removed).
        // A full home is still a candidate, so that wait keeps its sticky clock.
        if (ticket?.kind === 'seat' && ticket.vmId && !byVm.has(ticket.vmId)) {
          this.planner.toGlobal(ticket)
          ticket.deadline = Math.min(failoverDeadline, now + this.config.fallback_wait_timeout_ms)
        }
        let moveSeat = false
        let seat = this.shared ? await this.executionAdmissions.getSeat(seatKey) : this.planner.seatOf(seatKey)
        if (seat) {
          const home = byVm.get(seat.vmId)
          const homeUsable = !!home && (!home.busy || stickyShouldWait(home.waitReason, home.cooldownReason))
          // A home that left the pool (quota, credential, failover exclusion) or a
          // same-unit retry with a free seat elsewhere moves the device now, without grace.
          const steerAway = homeUsable && avoided(home) && this.openableCandidates(candidates, avoided).length > 0
          if (!homeUsable || steerAway) {
            if (this.shared) moveSeat = true
            else this.planner.free(seat)
            seatMoved = true
            seat = null
          } else if (avoided(home) && !allowWait) {
            return fail('all_accounts_busy')
          }
        }
        if (seat) {
          if (!ticket) {
            if (!this.planner.hasConcWaiters(seat.vmId)) {
              const granted = await this.claimSeat(seatKey, byVm.get(seat.vmId), 'seat-held')
              if (granted) {
                if (signal?.aborted) {
                  await granted.reservation.release()
                  throw makeAbortError()
                }
                return finish(granted)
              }
            }
            if (!allowWait || now >= failoverDeadline) return fail('all_accounts_busy')
            ticket = this.enqueueTicket({
              seatKey,
              kind: 'conc',
              vmId: seat.vmId,
              candidates: byVm,
              deadline: Math.min(failoverDeadline, now + this.config.sticky_wait_timeout_ms),
            })
          } else if (ticket.kind !== 'conc' || ticket.vmId !== seat.vmId) {
            this.planner.place(ticket, { kind: 'conc', vmId: seat.vmId })
          }
          this.planner.pump(seat.vmId)
        } else {
          const stickyVms = [familyGated ? '' : familyVm, deviceVm, sticky.vmId || ''].filter(Boolean)
          if (!ticket) {
            const granted = await this.openNewSeat(seatKey, candidates, { avoided, stickyVms, moveSeat })
            if (granted) {
              if (signal?.aborted) {
                await granted.reservation.release()
                throw makeAbortError()
              }
              return finish(granted)
            }
            if (!candidates.length) {
              const empty = emptyPoolFailure(model, candidates)
              return { ...fail(empty.reason), retry_after_ms: empty.retry_after_ms }
            }
            if (!allowWait || now >= failoverDeadline) return fail('all_accounts_busy')
            const home = stickyVms
              .map((vmId) => byVm.get(vmId))
              .find((candidate) => candidate && (!candidate.busy || stickyShouldWait(candidate.waitReason)))
            ticket = home
              ? this.enqueueTicket({
                  seatKey,
                  kind: 'seat',
                  vmId: home.vmId,
                  candidates: byVm,
                  stickyUntil: Math.min(failoverDeadline, now + this.config.sticky_wait_timeout_ms),
                  deadline: failoverDeadline,
                })
              : this.enqueueTicket({
                  seatKey,
                  kind: 'global',
                  vmId: null,
                  candidates: byVm,
                  deadline: Math.min(failoverDeadline, now + this.config.fallback_wait_timeout_ms),
                })
          } else if (ticket.kind === 'conc') {
            // Its seat moved away: wait for a new seat on the same terms as a new device.
            this.planner.place(ticket, { kind: 'global', vmId: null })
            ticket.deadline = Math.min(failoverDeadline, now + this.config.fallback_wait_timeout_ms)
          }
          ticket.moveSeat = moveSeat
          for (const vmId of ticket.vmId ? [ticket.vmId] : byVm.keys()) {
            this.planner.pump(vmId)
          }
        }
        if (ticket.granted) return finish(ticket.granted)
        const until = ticket.kind === 'seat' ? ticket.stickyUntil : ticket.deadline
        await this.waitTicket(ticket, { signal, until: Math.min(until, Date.now() + QUEUE_REFRESH_MS) })
        if (ticket.granted) return finish(ticket.granted)
        const after = Date.now()
        if (ticket.kind === 'seat' && after >= ticket.stickyUntil) {
          this.planner.toGlobal(ticket)
          ticket.deadline = Math.min(failoverDeadline, after + this.config.fallback_wait_timeout_ms)
          continue
        }
        if (after >= ticket.deadline) return fail('pool_queue_timeout')
      }
    } finally {
      this.planner.remove(ticket)
      // Granted while the caller went away: hand the seat and the slot back.
      if (ticket?.granted && !consumed) await ticket.granted.reservation.release()
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
        (this.shared || this.planner.canOpen(candidate.vmId, candidate.seatCap, candidate.headroom)) &&
        !this.planner.hasSeatWaiters(candidate.vmId),
    )
    const open = openable.filter((candidate) => !candidate.draining)
    return open.length ? open : openable
  }

  /** Sticky VMs first (family, device, session), then the configured strategy. */
  openNewSeat(seatKey, candidates, { avoided, stickyVms = [], moveSeat = false }) {
    if (this.shared) return this.openNewSeatShared(seatKey, candidates, { avoided, stickyVms, moveSeat })
    const openable = this.openableCandidates(candidates, avoided)
    if (!openable.length) return null
    for (const vmId of stickyVms) {
      const home = openable.find((candidate) => candidate.vmId === vmId)
      const granted = home ? this.claimSeat(seatKey, home, 'sticky') : null
      if (granted) return granted
    }
    for (const candidate of this.planner.rank(openable)) {
      const granted = this.claimSeat(seatKey, candidate, this.planner.strategy)
      if (granted) return granted
    }
    return null
  }

  async openNewSeatShared(seatKey, candidates, { avoided, stickyVms, moveSeat }) {
    const openable = this.openableCandidates(candidates, avoided)
    const preferred = stickyVms.map((vmId) => openable.find((candidate) => candidate.vmId === vmId)).filter(Boolean)
    const ordered = [...preferred, ...this.planner.rank(openable).filter((candidate) => !preferred.includes(candidate))]
    for (const candidate of ordered) {
      const granted = await this.claimSeatShared(
        seatKey,
        candidate,
        preferred.includes(candidate) ? 'sticky' : this.planner.strategy,
        { moveSeat },
      )
      if (granted) return granted
    }
    return null
  }

  async claimSeatShared(seatKey, candidate, selectionReason, { moveSeat = false } = {}) {
    if (!candidate) return null
    const reservation = await this.reserve(candidate, {
      seatKey,
      seatCap: candidate.seatCap,
      seatHeadroom: candidate.headroom,
      seatGraceMs: this.config.seat_grace_ms,
      seatReservePct: this.config.seat_budget_reserve_pct,
      moveSeat,
    })
    if (!reservation) return null
    let seat = this.planner.seatOf(seatKey)
    if (
      seat &&
      (seat.vmId !== candidate.vmId ||
        seat.index !== reservation.slotIndex ||
        seat.generation !== reservation.seatGeneration)
    ) {
      this.planner.detachSeat(seat)
      seat = null
    }
    const opened = !seat
    seat ||= this.planner.open(seatKey, {
      vmId: candidate.vmId,
      accountId: candidate.accountId,
      cap: candidate.seatCap,
      index: reservation.slotIndex,
    })
    seat.generation = reservation.seatGeneration
    this.planner.hold(seat)
    const releaseRequest = reservation.release
    let released = false
    return {
      candidate,
      selectionReason,
      seatOpened: opened,
      reservation: {
        ...reservation,
        release: (options) =>
          this.track(
            (async () => {
              const result = await releaseRequest(options)
              if (released || reservation.uncertain || result?.released === false) return result
              released = true
              this.planner.release(seat)
              return result
            })(),
          ),
      },
    }
  }

  /**
   * Synchronous claim: the reservation (concurrency, quota/RPM, circuit) and
   * the seat land together or not at all. The device's existing seat must be
   * on this VM; otherwise a new one opens only under cap and budget.
   */
  claimSeat(seatKey, candidate, selectionReason) {
    if (this.shared) return this.claimSeatShared(seatKey, candidate, selectionReason)
    if (!candidate || !grantable(candidate)) return null
    const current = this.planner.seatOf(seatKey)
    if (current && current.vmId !== candidate.vmId) return null
    if (!current && !this.planner.canOpen(candidate.vmId, candidate.seatCap, candidate.headroom)) return null
    const reservation = this.reserve(candidate)
    if (!reservation) return null
    const seat =
      current ||
      this.planner.open(seatKey, { vmId: candidate.vmId, accountId: candidate.accountId, cap: candidate.seatCap })
    this.planner.hold(seat)
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
          releaseRequest()
          this.planner.release(seat)
        },
      },
    }
  }

  enqueueTicket({ seatKey, kind, vmId, candidates, deadline, stickyUntil = null }) {
    if (this.queuedTotal() >= this.config.queue_max) throw this.queueFullError([...candidates.keys()])
    const ticket = {
      seatKey,
      kind,
      vmId,
      candidates,
      deadline,
      stickyUntil,
      enqueuedAt: Date.now(),
      queued: false,
      granted: null,
      wake: null,
      accepts: (id) => ticket.kind === 'global' && ticket.candidates.has(id),
      vmIds: () => [...ticket.candidates.keys()],
      tryGrant: (id) => {
        if (this.shared) {
          return this.claimSeatShared(ticket.seatKey, ticket.candidates.get(id), 'queued', {
            moveSeat: !!ticket.moveSeat,
          })
        }
        const granted = this.claimSeat(ticket.seatKey, ticket.candidates.get(id), 'queued')
        if (!granted) return false
        ticket.granted = granted
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
        if (ticket.error) reject(ticket.error)
        else resolve()
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
    if (stickyKey && this.stickyRouter?.shared)
      throw Object.assign(new Error('Shared sticky reconciliation requires the asynchronous API'), {
        code: 'shared_sticky_async_required',
      })
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

  async reconcileStickyShared({
    stickyKey = null,
    stickyKeys = null,
    eligible = [],
    spilled = null,
    familyVmId = null,
  } = {}) {
    if (!stickyKey || !this.stickyRouter) return { cleared: false, vmId: null, match: null }
    await this.stickyRouter.refresh()
    const bound = this.stickyRouter.resolve(stickyKey)
    if (!bound) return { cleared: false, vmId: null, match: null }
    const matchFor = (pin) =>
      eligible.find((candidate) => candidate.vmId === pin?.vmId && candidate.accountId === pin?.accountId) || null
    const match = matchFor(bound)
    const familyMoved =
      familyVmId && bound.vmId !== familyVmId && eligible.some((candidate) => candidate.vmId === familyVmId)
    const clear =
      familyMoved ||
      (!match && !spilled?.has(bound.accountId)) ||
      (match?.busy && !stickyShouldWait(match.waitReason, match.cooldownReason))
    if (!clear) return { cleared: !match, vmId: match ? bound.vmId : null, match }
    const results = await this.releaseSticky(bound, stickyKey, stickyKeys)
    const primary = results.find((result) => result.key === stickyKey)
    if (primary?.applied) return { cleared: true, vmId: null, match: null }
    const current = this.stickyRouter.resolve(stickyKey)
    return { cleared: false, vmId: current?.vmId || null, match: matchFor(current) }
  }

  async eligibleCandidates({
    model,
    excluded = new Set(),
    signal,
    pinVmId = null,
    ownerScope = PLATFORM_SCOPE,
    keyScope = null,
    quotaRequest = null,
  } = {}) {
    const now = Date.now()
    this.runtimeRepo?.clearExpired?.(now)
    const summaries = listVms(this.projectRoot)
    const candidates = []
    // Accounts dropped by an upstream 429 / 529 cooldown; an empty pool reports
    // that cause (pool_rate_limited / pool_overload_cooldown) instead of 503.
    candidates.cooldowns = { rate_limited: null, overloaded: null }
    candidates.rejections = { quota_guard_request_too_large: 0 }
    // Soonest working-window open across resting slots; an all-rest pool
    // reports it as retry_after so the client can time the next attempt.
    candidates.rest_until = null
    const pin = pinVmId ? String(pinVmId).trim() : ''
    for (const summary of summaries) {
      if (signal?.aborted) throw makeAbortError()
      if (pin && summary.id !== pin) continue
      const vm = getVm(this.projectRoot, summary.id)
      if (!vm) continue
      if (!pin && platformMismatch(model, vm)) continue
      if (!vmMatchesOwnerScope(vm, ownerScope)) continue
      if (!keyAllowsVm(keyScope, vm)) continue
      const accountId = accountIdOf(vm, this.projectRoot)
      if (!accountId || excluded.has(accountId) || excluded.has(vm.id)) continue
      const state = this.runtimeRepo?.get?.(accountId) || null
      const eligibility = await this.checkEligibility({
        vm,
        accountId,
        state,
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
      const inflight = this.shared ? eligibility.sharedCounts.accountInflight : this.inflight.get(accountId) || 0
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
        sharedCounts: eligibility.sharedCounts,
        exec: this.executionContext(vm, accountId),
      })
    }
    return candidates
  }
  async checkEligibility({ vm, accountId, state, model, now, signal, pinned = false, quotaRequest = null }) {
    // sub2api IsSchedulable: rate_limit_reset_at / overload_until gate before any
    // passive Extra reading or health hop. Pins are diagnostics and still reach the slot.
    const hardBlock = pinned ? null : hardBlockOf(state, now)
    if (hardBlock) return { ok: false, reason: hardBlock.reason, until: hardBlock.until }
    let circuitProbeUntil = null
    if (!pinned) {
      const circuit = this.unitCircuit?.inspect?.(accountId, now)
      if (circuit?.reason === 'circuit_open') return { ok: false, reason: circuit.reason, until: circuit.until }
      if (circuit?.reason === 'circuit_probe') circuitProbeUntil = circuit.until
    }
    const gate = evaluateSlotGate(vm)
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
        vm.schedule_disabled_reason !== 'proxy_desynced'
      ) {
        setVmSchedulable(this.projectRoot, vm.id, false, 'proxy_desynced')
      }
      return proxySync
    }
    let account = null
    let headroom = null
    if (!pinned) {
      try {
        account = this.accountQuota?.repo?.get?.(accountId) || null
      } catch {}
      const modelGate = slotAllowsModel({ vm, account, model })
      if (!modelGate.ok) return modelGate
      if (account) {
        await this.syncQuotaSchedule(vm, account)
        if (this.projectRoot) {
          const live = getVm(this.projectRoot, vm.id)
          if (live) {
            vm.schedulable = live.schedulable
            vm.schedule_disabled_reason = live.schedule_disabled_reason
            vm.schedule_manual = live.schedule_manual
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
          if (
            this.projectRoot &&
            vm.schedulable !== false &&
            ev.reason === 'quota_refresh_failed' &&
            vm.schedule_disabled_reason !== 'disabled'
          ) {
            setVmSchedulable(this.projectRoot, vm.id, false, 'quota_refresh_failed', { preserveStatus: true })
          }
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
    const workerStatus = await this.getWorkerHealth(this.executionContext(vm, accountId), { signal })
    const cred = evaluateCredentialEligibility({ vm, workerStatus, now })
    if (!cred.ok) return cred
    state = this.runtimeRepo?.get?.(accountId) || state
    if (isLeftoverGrantRevokeRuntime(state, vm)) {
      try {
        this.runtimeRepo?.clearGrantRevokeCooldown?.(accountId, { vmId: vm.id })
      } catch {}
      state = viewRuntimeWithoutLeftoverRevoke(state, vm)
    }
    // Setup Token has no refresh by design. A prior pin/test 401 parks
    // oauth_no_refresh forever; master pin must still be able to retry.
    const leftoverNoRefreshPark = pinned && String(state?.cooldown_reason || '') === 'oauth_no_refresh'
    if (leftoverNoRefreshPark) {
      try {
        this.runtimeRepo?.clearGrantRevokeCooldown?.(accountId, { vmId: vm.id })
      } catch {}
      state = {
        ...state,
        status: 'ready',
        cooldown_until: null,
        cooldown_reason: null,
      }
    }
    if (isCredentialRuntimeBlocked(state, now, vm)) return { ok: false, reason: 'credential_blocked' }
    const fallbackCap = parseConcurrency(this.config.default_max_per_account, 2)
    const maxConcurrency = this.effectiveMaxConcurrency(vm, account, fallbackCap)
    if (maxConcurrency <= 0) return { ok: false, reason: 'concurrency_disabled' }
    const sharedCounts = this.shared ? await this.executionAdmissions.getCounts(accountId, vm.id) : null
    const sharedLimits = this.shared ? this.executionLimits({ vm, account, maxConcurrency, model }) : null
    let busy = false
    let availableAt = null
    let waitReason = null
    const markWait = (reason, until = null) => {
      busy = true
      waitReason = waitReason || reason
      const next = Number(until) || 0
      if (next > now) availableAt = availableAt ? Math.min(availableAt, next) : next
    }
    if (state && cooldownActive(state.cooldown_until, now) && !leftoverNoRefreshPark) {
      markWait('account_cooldown', state.cooldown_until)
    }
    const modelKey = normalizeModel(model)
    for (const key of modelCooldownKeys(modelKey)) {
      const modelState = state?.model_states?.[key]
      if (modelState && cooldownActive(modelState.cooldown_until, now)) {
        markWait(key === FABLE_FAMILY_KEY ? 'fable_cooldown' : 'model_cooldown', modelState.cooldown_until)
      }
    }
    if (isFableModel(modelKey) && this.accountQuota?.fableWindowLimited?.(accountId)) {
      const until = this.accountQuota.fableWindowResetAt?.(accountId)
      markWait('fable_quota', until)
    }
    if (this.accountQuota?.weeklySplitOf) {
      const split = this.accountQuota.weeklySplitOf(accountId)
      const reason = splitBlocksModel(split, modelKey)
      if (reason) {
        const until = this.accountQuota.weeklySplitResetAt?.(accountId, reason === 'fable_split' ? 'fable' : 'regular')
        markWait(reason, until)
      }
    }
    const inflight = this.shared ? sharedCounts.accountInflight : this.inflight.get(accountId) || 0
    if (circuitProbeUntil) markWait('circuit_probe', circuitProbeUntil)
    if (inflight >= (sharedLimits?.accountLimit ?? maxConcurrency)) markWait('concurrency_limit')
    if (this.shared && sharedCounts.vmInflight >= sharedLimits.vmLimit) markWait('vm_concurrency_limit')
    const fableCap = Number(this.config.fable_max_per_account)
    if (isFableModel(modelKey) && Number.isFinite(fableCap) && fableCap > 0) {
      const familyInflight = this.shared ? sharedCounts.fableInflight : this.familyInflight(accountId, FABLE_FAMILY_KEY)
      if (familyInflight >= fableCap) markWait('fable_concurrency')
    }
    let gateZone = null
    if (this.accountQuota && !pinned) {
      const quotaGate = this.accountQuota.canAccept(accountId, { tier: vmTierOf(vm), quotaRequest })
      const localCapacityGate =
        this.shared && ['concurrency_limit', 'rpm_limit', 'quota_band_inflight'].includes(quotaGate.reason)
      if (!quotaGate.ok && !localCapacityGate) {
        if (quotaGate.reason === 'concurrency_limit') markWait('concurrency_limit')
        else if (quotaGate.reason === 'rpm_limit') markWait('rpm_limit', quotaGate.detail?.reset_at)
        else if (quotaGate.reason === 'quota_band_inflight') markWait('quota_band_inflight')
        else return { ok: false, reason: quotaGate.reason || 'quota_gate' }
      }
      gateZone = this.accountQuota.gateZoneOf?.(accountId, { tier: vmTierOf(vm) }) || null
    }
    if (this.shared && sharedLimits.rpmLimit > 0 && sharedCounts.rpmCount >= sharedLimits.rpmLimit) {
      markWait('rpm_limit', sharedCounts.rpmResetAt)
    }
    if (this.shared && gateZone === GATE_DRAINING && inflight > 0) markWait('quota_band_inflight')
    // A sticky preference must not bypass exhausted kernel recovery.
    if (kernelFaults.has(vm.id)) return { ok: false, reason: 'kernel_faulted' }
    // Node offline or asleep: the relay has no link behind it, a pick would only fail. Back on reconnect.
    if (!vmNodeReady(vm)) return { ok: false, reason: 'node_offline' }
    if (rustKernelBusy(workerStatus)) {
      markWait('slot_busy')
    } else if (workerStatus && rustKernelProcessUp(workerStatus) && !rustKernelReachable(workerStatus)) {
      return { ok: false, reason: 'worker_unhealthy' }
    }
    return { ok: true, account, workerStatus, busy, availableAt, waitReason, headroom, gateZone, sharedCounts }
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

  async getWorkerHealth(exec, { signal } = {}) {
    if (typeof this.workerHealth !== 'function') {
      return { ok: true, source: 'scheduler-no-health-provider' }
    }
    const now = Date.now()
    const cached = this.healthCache.get(exec.vmId)
    if (cached && now - cached.at < this.config.worker_health_ttl_ms) {
      return cached.value
    }
    const observation = await this.runtimeRepo?.beginObservation?.()
    let value
    try {
      value = await this.workerHealth(exec, { signal })
    } catch (error) {
      value = { ok: false, error: String(error.message || error) }
    }
    this.healthCache.set(exec.vmId, { at: now, value })
    if (this.runtimeRepo && exec.accountId) {
      const prev = this.runtimeRepo.get?.(exec.accountId)
      const prevGen = Number(prev?.credential_generation) || 0
      const nextGen = Number(value?.credential?.generation) || 0
      const effectiveGen = Math.max(prevGen, nextGen)
      this.runtimeRepo.upsert(
        {
          account_id: exec.accountId,
          status: runtimeHealthStatus(value),
          worker_heartbeat_at: now,
          worker_status: value,
          credential_generation: effectiveGen,
          refresh_status:
            value?.credential?.credential_state || (value?.credential?.needs_refresh ? 'needed' : 'fresh'),
        },
        { vmId: exec.vmId, observation },
      )
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
          const mirrored = mirrorWorkerCredentialsToVm(vmPath, exec.homeDir)
          const uuid = mirrored?.claude?.account_uuid || exec.accountId
          if (uuid && uuid !== exec.vmId) {
            this.accountQuota?.rebindToVm?.(uuid, exec.vmId, { email: mirrored?.claude?.email })
          }
        } catch {}
      }
      if (value?.ok && (value?.credential?.has_access || value?.credential?.has_refresh) && exec.vmId) {
        try {
          const live = getVm(this.projectRoot, exec.vmId)
          const leftoverOff =
            live?.schedule_disabled_reason === 'oauth_cleared' || live?.schedule_disabled_reason === 'oauth_no_refresh'
          if (leftoverOff && value.credential?.has_access && !live.claude?.refresh_error) {
            setVmSchedulable(this.projectRoot, exec.vmId, true)
          }
        } catch {}
        // Leftover TTL must not wipe a 401 park. Only a newer generation is a rotation.
        if (prevGen > 0 && nextGen > prevGen) {
          this.clearAuthCooldownFor(exec.vmId, exec.accountId)
          try {
            clearVmAuthCooldown(vmJsonPath(this.projectRoot, exec.vmId))
          } catch {}
        }
      }
    }
    return value
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
  releaseSticky(bound, stickyKey, stickyKeys, versions = null) {
    const keys = [...new Set([stickyKey, ...(Array.isArray(stickyKeys) ? stickyKeys : [])].filter(Boolean))]
    if (this.stickyRouter?.shared) {
      const snapshots = keys.map((key) => ({
        key,
        record: this.stickyRouter.resolve(key),
        generation: versions?.get(key) ?? this.stickyRouter.versionOf(key),
      }))
      return Promise.all(
        snapshots.map(async ({ key, record, generation }) => {
          if (record && bound?.accountId && (record.accountId !== bound.accountId || record.vmId !== bound.vmId))
            return { key, applied: false }
          return { key, ...(await this.stickyRouter.unbindShared(key, { ifGeneration: generation })) }
        }),
      )
    }
    for (const key of keys) this.stickyRouter?.unbind?.(key)
  }

  /**
   * The account left the pool for a hard reason (quota, credential): every
   * conversation pinned to it moves. In-flight leases keep their own release;
   * seats on it move with the device's next request.
   */
  releaseAccountSessions({ accountId = null, vmId = null } = {}) {
    if (!accountId && !vmId) return 0
    if (this.stickyRouter?.shared) return this.stickyRouter.unbindByAccountShared({ accountId, vmId })
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
    {
      stickyKey,
      stickySnapshot = null,
      eligible = candidates,
      spilled = null,
      stickyKeys = null,
      deviceVmId = null,
      familyVmId = null,
    } = {},
  ) {
    this.lastStickyCleared = false
    if (!candidates.length && !eligible?.length) return null
    const sticky =
      stickySnapshot ||
      this.reconcileSticky({
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
      const empty = emptyPoolFailure(model, candidates)
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
    // A larger queue_max or a new strategy can admit waiters right away.
    this.planner.pumpAll()
  }

  /**
   * One atomic claim: concurrency, Fable cap, quota/RPM, then circuit. Any
   * refusal hands back exactly what this call took, in reverse order.
   * release() is idempotent and hands freed concurrency to the VM's queue.
   * Seats are layered on top by claimSeat().
   */
  reserve(candidate, options = {}) {
    if (this.shared) return this.track(this.reserveShared(candidate, options))
    const { skipQuota = false, pinned = false } = options
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
    const quotaReservation = this.accountQuota?.tryAcquire?.(candidate.accountId, {
      skipGate: !!skipQuota,
      tier: vmTierOf(candidate.vm),
      quotaRequest: candidate.quotaRequest,
    })
    if (quotaReservation && !quotaReservation.ok) return null
    // A pin is an operator diagnostic: it reaches the slot without taking the probe.
    const circuitHold = pinned ? null : this.unitCircuit?.admit?.(candidate.accountId)
    if (circuitHold && !circuitHold.ok) {
      if (quotaReservation) this.accountQuota?.release?.(candidate.accountId)
      return null
    }
    this.inflight.set(candidate.accountId, requestInflight + 1)
    this.bumpFamily(candidate.accountId, family, 1)
    this.bumpVmInflight(candidate.vmId, 1)
    let released = false
    return {
      reserved: true,
      slotIndex: null,
      release: () => {
        if (released) return
        released = true
        const next = Math.max(0, (this.inflight.get(candidate.accountId) || 1) - 1)
        if (next === 0) this.inflight.delete(candidate.accountId)
        else this.inflight.set(candidate.accountId, next)
        this.bumpFamily(candidate.accountId, family, -1)
        this.bumpVmInflight(candidate.vmId, -1)
        this.accountQuota?.release?.(candidate.accountId)
        if (circuitHold?.probe) this.unitCircuit?.releaseProbe?.(candidate.accountId)
        this.planner.pump(candidate.vmId)
        this.notifyCapacity(candidate.accountId)
      },
    }
  }

  executionLimits(candidate) {
    const policy = this.accountQuota?.policyFor?.(candidate.account, { tier: vmTierOf(candidate.vm) })
    let accountLimit = Number(this.accountQuota?.limitFor?.(candidate.account, policy) ?? candidate.maxConcurrency)
    if (candidate.draining) accountLimit = Math.min(accountLimit, 1)
    return {
      accountLimit,
      vmLimit: maxConcurrencyOf(candidate.vm, candidate.maxConcurrency),
      rpmLimit: Number(this.accountQuota?.rpmLimitFor?.(candidate.account, policy) ?? candidate.account?.max_rpm ?? 0),
      fableLimit: Number(this.config.fable_max_per_account) || 0,
      family: isFableModel(candidate.model) ? FABLE_FAMILY_KEY : null,
    }
  }

  async reserveShared(candidate, options) {
    if (!options.skipQuota) {
      const gate = this.accountQuota?.canAccept?.(candidate.accountId, {
        tier: vmTierOf(candidate.vm),
        quotaRequest: candidate.quotaRequest,
      })
      if (gate && !gate.ok && !['concurrency_limit', 'rpm_limit', 'quota_band_inflight'].includes(gate.reason))
        return null
    }
    const circuitHold = options.pinned ? null : this.unitCircuit?.admit?.(candidate.accountId)
    if (circuitHold && !circuitHold.ok) return null
    const limits = this.executionLimits(candidate)
    let lease
    try {
      lease = await this.executionAdmissions.tryReserve({
        accountId: candidate.accountId,
        vmId: candidate.vmId,
        ...limits,
        ...options,
      })
    } catch (error) {
      if (circuitHold?.probe) this.unitCircuit?.releaseProbe?.(candidate.accountId)
      throw error
    }
    if (!lease.ok) {
      if (circuitHold?.probe) this.unitCircuit?.releaseProbe?.(candidate.accountId)
      candidate.busy = true
      candidate.waitReason = lease.code
      if (lease.retry_after_ms) candidate.availableAt = Date.now() + lease.retry_after_ms
      return null
    }
    this.inflight.set(candidate.accountId, (this.inflight.get(candidate.accountId) || 0) + 1)
    this.bumpFamily(candidate.accountId, limits.family, 1)
    this.bumpVmInflight(candidate.vmId, 1)
    let released = false
    let releasing = null
    let marking = null
    const reservation = {
      ...lease,
      reserved: true,
      slotIndex: lease.slotIndex ?? null,
      uncertain: false,
      markUncertain: () => {
        if (released) return Promise.resolve({ uncertain: false })
        // Stop ordinary release immediately, including while persistence is pending.
        reservation.uncertain = true
        if (marking) return marking
        const task = this.track(Promise.resolve().then(() => lease.markUncertain()))
        marking = task
        task.then(
          (result) => {
            if (result?.uncertain === false && marking === task) marking = null
          },
          () => {
            if (marking === task) marking = null
          },
        )
        return task
      },
      release: (releaseOptions) => {
        if (releaseOptions?.uncertain) return reservation.markUncertain()
        if (released) return Promise.resolve({ released: false })
        if (reservation.uncertain) return reservation.markUncertain()
        if (releasing) return releasing
        const task = this.track(
          (async () => {
            const result = await lease.release(releaseOptions)
            if (result?.released === false) return result
            released = true
            const next = Math.max(0, (this.inflight.get(candidate.accountId) || 1) - 1)
            if (next) this.inflight.set(candidate.accountId, next)
            else this.inflight.delete(candidate.accountId)
            this.bumpFamily(candidate.accountId, limits.family, -1)
            this.bumpVmInflight(candidate.vmId, -1)
            if (circuitHold?.probe) this.unitCircuit?.releaseProbe?.(candidate.accountId)
            this.planner.pump(candidate.vmId)
            this.notifyCapacity(candidate.accountId)
            return result
          })(),
        )
        releasing = task
        task.then(
          () => {
            if (!released && releasing === task) releasing = null
          },
          () => {
            if (releasing === task) releasing = null
          },
        )
        return task
      },
    }
    return reservation
  }

  track(operation) {
    const task = Promise.resolve(operation)
    this.tasks.add(task)
    task.then(
      () => this.tasks.delete(task),
      (error) => {
        this.failure ||= error
        this.tasks.delete(task)
      },
    )
    return task
  }

  async flush() {
    while (this.tasks.size || this.planner.tasks.size) {
      await Promise.allSettled([...this.tasks])
      await this.planner.flush()
    }
    await this.planner.flush()
    await this.executionAdmissions?.flush?.()
    if (this.failure) throw this.failure
  }

  /** Live request count per VM for the panel seat stream; every change pushes a frame. */
  bumpVmInflight(vmId, delta) {
    if (!vmId) return
    const id = String(vmId)
    const next = Math.max(0, (this.vmInflight.get(id) || 0) + delta)
    if (next === 0) this.vmInflight.delete(id)
    else this.vmInflight.set(id, next)
    this.emit('change')
  }

  markSuccess(candidate, { workerStatus = null, countUsage = true, observation } = {}) {
    const now = Date.now()
    if (countUsage !== false) this.accountQuota?.noteBandSettled?.(candidate.accountId)
    if (countUsage !== false) this.lastUsed.set(candidate.accountId, now)
    this.runtimeRepo?.upsert?.(
      {
        account_id: candidate.accountId,
        ...(!this.shared
          ? {
              status: 'ready',
              priority: candidate.priority,
              weight: candidate.weight,
              cooldown_until: null,
              cooldown_reason: null,
            }
          : {}),
        ...(countUsage === false ? {} : { last_used_at: now }),
        ...(workerStatus ? { worker_heartbeat_at: now, worker_status: workerStatus } : {}),
      },
      { vmId: candidate.vmId, observation },
    )
    if (!this.shared && this.projectRoot && candidate.vmId) {
      try {
        clearVmAuthCooldown(vmJsonPath(this.projectRoot, candidate.vmId))
      } catch {}
    }
  }

  markCooldown(candidate, { until, reason, model = null, status = 'cooldown', observation } = {}) {
    this.runtimeRepo?.markCooldown?.(candidate.accountId, {
      vmId: candidate.vmId,
      until,
      reason,
      model: model ? normalizeModel(model) : null,
      status,
      observation,
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
    if (this.shared) return grantable(candidate)
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

  /** Direct-path wait (cooldown / RPM / concurrency); it counts against the pool-wide `queue_max`. */
  waitForCapacity({ signal, deadline, stickyKey, accountId = null, vmId = null, sticky = false } = {}) {
    const bucketId = String(accountId || stickyKey || '_pool')
    if (this.queuedTotal() >= this.config.queue_max) throw this.queueFullError(vmId ? [vmId] : null)
    const id = Symbol('pool-waiter')
    let bucket = this.waiters.get(bucketId)
    if (!bucket) {
      bucket = new Map()
      this.waiters.set(bucketId, bucket)
    }
    return new Promise((resolve, reject) => {
      const remaining = Math.max(1, deadline - Date.now())
      const finish = (woken) => resolve({ woken: !!woken })
      const timer = setTimeout(() => {
        cleanup()
        finish(false)
      }, remaining)
      const onAbort = () => {
        cleanup()
        reject(makeAbortError())
      }
      let left = false
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        const live = this.waiters.get(bucketId)
        live?.delete(id)
        if (live && live.size === 0) this.waiters.delete(bucketId)
        // notifyCapacity() detaches entries before waking them; count the exit once.
        if (left) return
        left = true
        this.emit('change')
      }
      bucket.set(id, {
        sticky: !!sticky,
        vmId: vmId ? String(vmId) : null,
        wake: () => {
          cleanup()
          const jitter = stickyKey ? Math.floor(Math.random() * 20) : 0
          if (jitter) setTimeout(() => finish(true), jitter)
          else finish(true)
        },
      })
      this.emit('change')
      if (signal?.aborted) onAbort()
      else signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

  /** Cooldown lifted, credential back, or a direct release: wake direct waiters and re-pump seat queues. */
  notifyCapacity(accountId = null) {
    const wakeEntry = (entry) => {
      try {
        const wake = typeof entry === 'function' ? entry : entry?.wake
        wake?.()
      } catch {}
    }
    if (accountId) {
      const bucket = this.waiters.get(accountId)
      if (bucket) {
        this.waiters.delete(accountId)
        for (const entry of bucket.values()) wakeEntry(entry)
      }
      for (const [id, other] of [...this.waiters]) {
        if (id === accountId) continue
        for (const [token, entry] of [...other]) {
          if (entry?.sticky) continue
          other.delete(token)
          wakeEntry(entry)
        }
        if (other.size === 0) this.waiters.delete(id)
      }
      return
    }
    const buckets = [...this.waiters.values()]
    this.waiters.clear()
    for (const bucket of buckets) {
      for (const entry of bucket.values()) wakeEntry(entry)
    }
    this.planner.pumpAll()
  }

  /**
   * Extra 5h/7d reject → restriction (temp_unschedulable_* + runtime cooldown).
   * Never flips the operator switch. Leftover quota-off that is not
   * schedule_manual is restored to on + restriction.
   */
  syncQuotaSchedule(vm, account = null) {
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
        setVmSchedulable(this.projectRoot, vm.id, true, null, { preserveStatus: true, source: 'force' })
        vm.schedulable = true
        vm.schedule_disabled_reason = null
        return { action: 'restore', reason: ev.reason, until }
      }
      return { action: 'restrict', reason: ev.reason, until }
    }
    if (ev.accept) {
      const finish = (cleared) => {
        if (cleared === false) return { action: 'keep', reason: 'quota_state_changed' }
        if (leftover) {
          setVmSchedulable(this.projectRoot, vm.id, true, null, { preserveStatus: true, source: 'force' })
          vm.schedulable = true
          vm.schedule_disabled_reason = null
          return { action: 'enable', reason: null }
        }
        return { action: 'clear', reason: null }
      }
      const cleared = this.clearQuotaRestriction(vm, accountId, file)
      return cleared?.then ? cleared.then(finish) : finish(cleared)
    }
    if (leftover) {
      setVmSchedulable(this.projectRoot, vm.id, true, null, { preserveStatus: true, source: 'force' })
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

  clearQuotaRestriction(vm, accountId, file) {
    const state = this.runtimeRepo?.get?.(accountId)
    // A live 429 block lifts only on its reset or an `allowed` header, never
    // from a passive Extra re-read (sub2api ClearRateLimit via UpdateSessionWindow).
    if (hardBlockOf(state)) return false
    const reason = state?.cooldown_reason || vm.claude?.temp_unschedulable_reason || vm.temp_unschedulable_reason
    if (reason && !isAccountRestrictionReason(reason) && !isQuotaWindowReason(reason)) return false
    if (isAuthCooldownReason(reason)) return false
    const apply = () => {
      const next = clearVmQuotaRestriction(file)
      if (next) {
        vm.claude = next.claude || vm.claude
        delete vm.temp_unschedulable_until
        delete vm.temp_unschedulable_reason
      }
      return true
    }
    if (state && (isAccountRestrictionReason(state.cooldown_reason) || isQuotaWindowReason(state.cooldown_reason))) {
      if (this.shared) {
        return this.runtimeRepo
          .clearQuotaCooldownCommitted(accountId, { vmId: vm.id })
          .then((applied) => (applied ? apply() : false))
      }
      this.runtimeRepo?.upsert?.({
        account_id: accountId,
        vm_id: vm.id,
        cooldown_until: null,
        cooldown_reason: null,
        status: 'ready',
      })
    }
    return apply()
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
   * `queue_depth` counts every request waiting on that VM (seat, concurrency,
   * cooldown/RPM); `conc_waiting` is the concurrency share of it; `inflight`
   * is requests holding a reservation on it right now (seatless and pinned too).
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
      })
    for (const bucket of this.waiters.values()) {
      for (const entry of bucket.values()) {
        if (entry?.vmId) row(entry.vmId).queue_depth += 1
      }
    }
    for (const entry of Object.values(seats)) entry.inflight = 0
    for (const [vmId, count] of this.vmInflight) row(vmId).inflight = count
    return { seats, global_queue_depth, queue_max: this.config.queue_max }
  }
}
