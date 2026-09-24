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
import { PLATFORM_SCOPE, vmMatchesOwnerScope } from '../admin/resource-owner.mjs'
import { rustKernelBusy, rustKernelProcessUp, rustKernelReachable } from '../transport/rust-kernel-client.mjs'
import { resolveSessionSlots } from '../vm/slot-engine.mjs'

const WAIT_TIMEOUT_MIN_MS = 1000
const WAIT_TIMEOUT_MAX_MS = 120000

const DEFAULT_CONFIG = {
  strategy: 'weighted-round-robin',
  max_waiters_per_account: 32,
  fallback_wait_timeout_ms: 30000,
  sticky_wait_timeout_ms: 45000,
  worker_health_ttl_ms: 5000,
  heartbeat_stale_ms: 15000,
  fable_max_per_account: 4,
  default_max_per_account: 2,
}

function clampWaitTimeoutMs(value, fallback) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(WAIT_TIMEOUT_MAX_MS, Math.max(WAIT_TIMEOUT_MIN_MS, Math.round(n)))
}

function normalizePoolConfig(config = {}) {
  const next = { ...DEFAULT_CONFIG, ...(config || {}) }
  next.sticky_wait_timeout_ms = clampWaitTimeoutMs(next.sticky_wait_timeout_ms, DEFAULT_CONFIG.sticky_wait_timeout_ms)
  next.fallback_wait_timeout_ms = clampWaitTimeoutMs(
    next.fallback_wait_timeout_ms,
    DEFAULT_CONFIG.fallback_wait_timeout_ms,
  )
  return next
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

function sessionSlotsOf(vm, fallback = 20) {
  return resolveSessionSlots(vm, { inference: { session_slots: fallback } })
}

/** Distinct conversation window. 0 = off. Not the native seat cap. */
function maxSessionsOf(vm, accountQuota, account) {
  const fromVm = Number(vm?.policy?.maxSessions)
  if (Number.isFinite(fromVm) && fromVm > 0) return Math.round(fromVm)
  try {
    const policy = accountQuota?.policyFor?.(account, { tier: vmTierOf(vm) })
    const configured = Number(policy?.max_sessions ?? account?.max_sessions)
    if (Number.isFinite(configured) && configured > 0) return Math.round(configured)
  } catch {}
  return 0
}

function vmTierOf(vm) {
  return vm?.claude?.account_tier || vm?.account_tier || null
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

/** Concurrency, RPM, and kernel slot-full wait on the bound account. Cooldown / fault must rotate. */
function stickyShouldWait(waitReason, cooldownReason = null) {
  if (
    waitReason === 'concurrency_limit' ||
    waitReason === 'fable_concurrency' ||
    waitReason === 'rpm_limit' ||
    waitReason === 'slot_busy' ||
    waitReason === 'session_slots_full' ||
    waitReason === 'circuit_probe'
  ) {
    return true
  }
  // Upstream RPM cooldown is the same queue, not a reason to open another session.
  return waitReason === 'account_cooldown' && String(cooldownReason || '') === 'rate_limited'
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

export class PoolScheduler {
  constructor({
    projectRoot,
    stickyRouter = null,
    accountQuota = null,
    runtimeRepo = null,
    workerHealth = null,
    config = {},
  } = {}) {
    this.projectRoot = projectRoot
    this.stickyRouter = stickyRouter
    this.accountQuota = accountQuota
    this.runtimeRepo = runtimeRepo
    this.workerHealth = workerHealth
    this.config = normalizePoolConfig(config)
    this.lastStickyCleared = false
    this.inflight = new Map()
    this.inflightFamily = new Map()
    this.waiters = new Map()
    this.healthCache = new Map()
    this.smooth = new Map()
    this.lastUsed = new Map()
    this.cooldownTimers = new Map()
    this.vmSlots = new Map()
    this.unitCircuit = unitCircuit
    if (runtimeRepo) this.unitCircuit.bindRepo(runtimeRepo)
  }

  async selectAndReserve({
    model,
    stickyKey = null,
    excluded = new Set(),
    spilled = new Set(),
    signal,
    deadline = null,
    allowWait = true,
    pinVmId = null,
    ownerScope = PLATFORM_SCOPE,
    stickyKeys = null,
  } = {}) {
    const startedAt = Date.now()
    const pinned = !!String(pinVmId || '').trim()
    const blocked = new Set(excluded)
    const spill = new Set(spilled)
    let stickyCleared = false
    const boundBefore = stickyKey ? this.stickyRouter?.resolve?.(stickyKey) : null
    const fail = (reason, candidates = [], available = [], waitPool = candidates) => {
      const waitMs = Date.now() - startedAt
      return {
        ok: false,
        code: 'no_available_accounts',
        waitMs,
        ...selectionSnapshot(candidates, available, { reason, waitMs, stickyCleared, waitPool }),
      }
    }
    const failoverDeadline = Number(deadline) || null
    const defaultPlanMs = stickyKey ? this.config.sticky_wait_timeout_ms : this.config.fallback_wait_timeout_ms
    const loopDeadline = failoverDeadline || startedAt + defaultPlanMs
    const finishReserve = (selected, reservation) => ({
      ...selected,
      ...reservation,
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
        sessionKey: stickyKey,
        ownerScope,
      })
      const available = candidates.filter((candidate) => this.isReservable(candidate))
      let selected = this.pick(available, { model, stickyKey, eligible: candidates, spilled: spill, stickyKeys })
      if (this.lastStickyCleared) stickyCleared = true
      const reserveMisses = []
      const attempted = new Set()
      while (selected) {
        const reservation = this.reserve(selected, { sessionKey: stickyKey, skipQuota: pinned, pinned })
        if (reservation) return finishReserve(selected, reservation)
        // A sticky hit that loses the race stays on that account and waits.
        // Dropping the key here is how one conversation lands on a second session.
        reserveMisses.push({ ...selected, busy: true, waitReason: selected.waitReason || 'concurrency_limit' })
        attempted.add(selected.accountId)
        if (selected.selectionReason === 'sticky') break
        const remaining = available.filter(
          (candidate) =>
            !attempted.has(candidate.accountId) && !blocked.has(candidate.accountId) && !blocked.has(candidate.vmId),
        )
        if (!remaining.length) break
        selected = this.pick(remaining, { model, stickyKey: null, eligible: candidates })
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
        return fail(isFableModel(model) ? 'fable_requires_max' : 'no_eligible_accounts', waitCandidates, waitAvailable)
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
      if (waitPlan?.queueFull && waitPlan.sticky) {
        // Queue full on the bound account: this one request spills (sub2api
        // Layer 1 spillover). The durable pin stays so the next turn returns.
        stickyCleared = true
        if (waitPlan.accountId) {
          blocked.add(waitPlan.accountId)
          spill.add(waitPlan.accountId)
        }
        continue
      }
      const waitDeadline = waitPlan?.deadline || loopDeadline
      if (wakeAts.length && Math.min(...wakeAts) >= waitDeadline && !concurrencyWait) {
        return fail('all_accounts_busy', waitCandidates, waitAvailable, waitPool)
      }
      if (!waitPlan || waitPlan.timeoutMs <= 0) {
        return fail('all_accounts_busy', waitCandidates, waitAvailable, waitPool)
      }
      if (waitPlan.queueFull) {
        throw Object.assign(new Error('Account pool wait queue is full'), { code: 'pool_wait_queue_full' })
      }
      const waitCap = Math.min(waitDeadline, loopDeadline)
      const sliceDeadline = wakeAts.length ? Math.min(waitCap, ...wakeAts) : waitCap
      let woken = false
      try {
        const waited = await this.waitForCapacity({
          signal,
          deadline: sliceDeadline,
          accountId: waitPlan.accountId,
          sticky: waitPlan.sticky,
          stickyKey,
        })
        woken = !!waited?.woken
      } catch (error) {
        if (error?.code === 'pool_wait_queue_full' && waitPlan.sticky) continue
        throw error
      }
      // Notify continues the loop. availableAt-sliced timers also recheck.
      // Only a wait-plan / failover deadline timeout is all_accounts_busy.
      if (!woken && sliceDeadline >= waitCap) {
        return fail('all_accounts_busy', waitCandidates, waitAvailable, waitPool)
      }
    }
  }

  async eligibleCandidates({
    model,
    excluded = new Set(),
    signal,
    pinVmId = null,
    sessionKey = null,
    ownerScope = PLATFORM_SCOPE,
  } = {}) {
    const now = Date.now()
    this.runtimeRepo?.clearExpired?.(now)
    const summaries = listVms(this.projectRoot)
    const candidates = []
    const pin = pinVmId ? String(pinVmId).trim() : ''
    for (const summary of summaries) {
      if (signal?.aborted) throw makeAbortError()
      if (pin && summary.id !== pin) continue
      const vm = getVm(this.projectRoot, summary.id)
      if (!vm) continue
      if (!pin && platformMismatch(model, vm)) continue
      if (!vmMatchesOwnerScope(vm, ownerScope)) continue
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
        sessionKey,
      })
      if (!eligibility.ok) continue
      const maxConcurrency = this.effectiveMaxConcurrency(
        vm,
        eligibility.account,
        parseConcurrency(this.config.default_max_per_account, 2),
      )
      const inflight = this.inflight.get(accountId) || 0
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
        sessionSlots: sessionSlotsOf(vm, this.config.default_session_slots),
        slotHeld: this.assignedSlot(summary.id, sessionKey),
        slotHeldBusy: this.slotInflight(summary.id, this.assignedSlot(summary.id, sessionKey)),
        usedSlots: this.usedSlotCount(summary.id),
        loadRatio: (inflight + this.waiterCount(accountId)) / maxConcurrency,
        lastUsedAt: this.lastUsed.get(accountId) || state?.last_used_at || 0,
        workerStatus: eligibility.workerStatus,
        busy: !!eligibility.busy,
        availableAt: eligibility.availableAt || null,
        waitReason: eligibility.waitReason || null,
        cooldownReason: state?.cooldown_reason || null,
        exec: this.executionContext(vm, accountId),
      })
    }
    return candidates
  }

  async checkEligibility({ vm, accountId, state, model, now, signal, pinned = false, sessionKey = null }) {
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
    if (!pinned) {
      try {
        account = this.accountQuota?.repo?.get?.(accountId) || null
      } catch {}
      const modelGate = slotAllowsModel({ vm, account, model })
      if (!modelGate.ok) return modelGate
      if (account) {
        this.syncQuotaSchedule(vm, account)
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
          quota: account.unified
            ? {
                ...listQuotaFromHeaders(account.unified, { now }),
                last_used_at: lastUsedAt,
                last_probe: account.last_probe || account.unified.last_probe,
                probe_source: account.unified.source,
              }
            : {},
          policy,
          sessionKey,
          sessionLimit: this.accountQuota?.sessions,
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
      }
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
    const inflight = this.inflight.get(accountId) || 0
    const sessionSlots = sessionSlotsOf(vm, this.config.default_session_slots)
    if (sessionKey && !pinned && this.accountQuota?.sessions?.canAccept) {
      let idleMin = 5
      try {
        const policy = this.accountQuota.policyFor?.(account, { tier: vmTierOf(vm) })
        const configured = Number(policy?.session_idle_min)
        if (Number.isFinite(configured) && configured > 0) idleMin = configured
      } catch {}
      const maxSessions = maxSessionsOf(vm, this.accountQuota, account)
      if (maxSessions > 0) {
        const windowGate = this.accountQuota.sessions.canAccept(accountId, sessionKey, {
          max: maxSessions,
          idleMin,
        })
        if (!windowGate.ok) return { ok: false, reason: 'session_limit' }
      }
    }

    if (circuitProbeUntil) markWait('circuit_probe', circuitProbeUntil)
    if (this.usedSlotCount(vm.id) >= sessionSlots) markWait('session_slots_full')
    if (inflight >= maxConcurrency) markWait('concurrency_limit')
    const fableCap = Number(this.config.fable_max_per_account)
    if (isFableModel(modelKey) && Number.isFinite(fableCap) && fableCap > 0) {
      const familyInflight = this.familyInflight(accountId, FABLE_FAMILY_KEY)
      if (familyInflight >= fableCap) markWait('fable_concurrency')
    }
    if (this.accountQuota && !pinned) {
      const quotaGate = this.accountQuota.canAccept(accountId, { sessionKey, tier: vmTierOf(vm) })
      if (!quotaGate.ok) {
        if (quotaGate.reason === 'concurrency_limit') markWait('concurrency_limit')
        else if (quotaGate.reason === 'rpm_limit') markWait('rpm_limit', quotaGate.detail?.reset_at)
        else return { ok: false, reason: quotaGate.reason || 'quota_gate' }
      }
    }
    if (rustKernelBusy(workerStatus)) {
      markWait('slot_busy')
    } else if (workerStatus && rustKernelProcessUp(workerStatus) && !rustKernelReachable(workerStatus)) {
      return { ok: false, reason: 'worker_unhealthy' }
    }
    return { ok: true, account, workerStatus, busy, availableAt, waitReason }
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
      this.runtimeRepo.upsert({
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

  /** Session leaves this VM: drop alias keys and the slot that session was pinned to. */
  releaseSticky(bound, stickyKey, stickyKeys) {
    const keys = Array.isArray(stickyKeys) && stickyKeys.length ? stickyKeys : stickyKey ? [stickyKey] : []
    for (const key of keys) {
      this.dropSessionSlot(bound?.vmId, key)
      this.stickyRouter?.unbind?.(key)
      try {
        this.accountQuota?.sessions?.drop?.(bound?.accountId, key)
      } catch {}
    }
  }

  /**
   * `spilled`: accounts this request skipped only for capacity (wait queue
   * full, kernel slot_busy). The session pin survives; the next turn returns.
   */
  pick(candidates, { model, stickyKey, eligible = candidates, spilled = null, stickyKeys = null } = {}) {
    this.lastStickyCleared = false
    if (!candidates.length && !eligible?.length) return null
    const bound = stickyKey ? this.stickyRouter?.resolve?.(stickyKey) : null
    if (bound) {
      const match = (candidate) => candidate.vmId === bound.vmId && candidate.accountId === bound.accountId
      const amongEligible = (eligible || candidates).find(match)
      if (!amongEligible) {
        if (!spilled?.has(bound.accountId)) this.releaseSticky(bound, stickyKey, stickyKeys)
        this.lastStickyCleared = true
      } else if (this.isReservable(amongEligible)) {
        return { ...amongEligible, selectionReason: 'sticky' }
      } else if (amongEligible.busy && stickyShouldWait(amongEligible.waitReason, amongEligible.cooldownReason)) {
        if (this.waiterCount(amongEligible.accountId) < this.maxWaiters()) return null
        this.lastStickyCleared = true
      } else {
        this.releaseSticky(bound, stickyKey, stickyKeys)
        this.lastStickyCleared = true
      }
    }
    if (!candidates.length) return null
    const highestPriority = Math.max(...candidates.map((candidate) => candidate.priority))
    let pool = candidates.filter((candidate) => candidate.priority === highestPriority)
    const minLoad = Math.min(...pool.map((candidate) => candidate.loadRatio))
    pool = pool.filter((candidate) => candidate.loadRatio === minLoad)
    if (pool.length === 1) return { ...pool[0], selectionReason: 'priority-load' }

    const strategy = String(this.config.strategy || 'weighted-round-robin')
    if (strategy === 'lru' || strategy === 'fill-first') {
      pool.sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.accountId.localeCompare(right.accountId))
      return { ...pool[0], selectionReason: strategy }
    }
    if (strategy === 'round-robin') {
      const key = `rr:${normalizeModel(model)}`
      const cursor = Number(this.smooth.get(key) || 0)
      const sorted = [...pool].sort((left, right) => left.accountId.localeCompare(right.accountId))
      const selected = sorted[cursor % sorted.length]
      this.smooth.set(key, cursor + 1)
      return { ...selected, selectionReason: 'round-robin' }
    }
    return { ...this.pickSmoothWeighted(pool, model), selectionReason: 'weighted-round-robin' }
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

  /** Read-only current account. Never bind, unbind, reserve, or mutate WRR. */
  async peekAccount({ model, stickyKey = null, signal, ownerScope = PLATFORM_SCOPE } = {}) {
    const candidates = await this.eligibleCandidates({ model, sessionKey: stickyKey, signal, ownerScope })
    if (!candidates.length) {
      return { ok: false, code: isFableModel(model) ? 'fable_requires_max' : 'no_eligible_accounts' }
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

  pickSmoothWeighted(candidates, model) {
    const key = `wrr:${normalizeModel(model)}`
    let state = this.smooth.get(key)
    if (!state || !(state instanceof Map)) {
      state = new Map()
      this.smooth.set(key, state)
    }
    const active = new Set(candidates.map((candidate) => candidate.accountId))
    for (const id of state.keys()) {
      if (!active.has(id)) state.delete(id)
    }
    let selected = null
    let selectedCurrent = -Infinity
    let total = 0
    for (const candidate of [...candidates].sort(
      (left, right) => left.lastUsedAt - right.lastUsedAt || left.accountId.localeCompare(right.accountId),
    )) {
      if (candidate.weight <= 0) continue
      total += candidate.weight
      const current = (state.get(candidate.accountId) || 0) + candidate.weight
      state.set(candidate.accountId, current)
      if (!selected || current > selectedCurrent) {
        selected = candidate
        selectedCurrent = current
      }
    }
    if (!selected) {
      return [...candidates].sort((left, right) => left.accountId.localeCompare(right.accountId))[0]
    }
    state.set(selected.accountId, (state.get(selected.accountId) || 0) - total)
    return selected
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
  }

  reserve(candidate, { sessionKey = null, skipQuota = false, pinned = false } = {}) {
    const requestInflight = this.inflight.get(candidate.accountId) || 0
    if (!candidate.maxConcurrency || requestInflight >= candidate.maxConcurrency) return null
    const slot = this.acquireSlot(candidate.vmId, sessionKey, candidate.sessionSlots)
    if (candidate.sessionSlots > 0 && !slot) return null
    const family = isFableModel(candidate.model) ? FABLE_FAMILY_KEY : null
    const fableCap = Number(this.config.fable_max_per_account)
    if (
      family &&
      Number.isFinite(fableCap) &&
      fableCap > 0 &&
      this.familyInflight(candidate.accountId, family) >= fableCap
    ) {
      if (slot?.created) this.releaseSlotHold(candidate.vmId, slot.holdKey)
      return null
    }
    const quotaReservation = this.accountQuota?.tryAcquire?.(candidate.accountId, {
      sessionKey,
      skipGate: !!skipQuota,
      tier: vmTierOf(candidate.vm),
    })
    if (quotaReservation && !quotaReservation.ok) {
      if (slot?.created) this.releaseSlotHold(candidate.vmId, slot.holdKey)
      return null
    }
    if (sessionKey) {
      try {
        this.accountQuota?.sessions?.touch?.(candidate.accountId, sessionKey)
      } catch {}
    }
    // A pin is an operator diagnostic: it reaches the slot without taking the probe.
    const circuitHold = pinned ? null : this.unitCircuit?.admit?.(candidate.accountId)
    if (circuitHold && !circuitHold.ok) {
      if (slot?.created) this.releaseSlotHold(candidate.vmId, slot.holdKey)
      if (sessionKey) {
        try {
          this.accountQuota?.sessions?.release?.(candidate.accountId, sessionKey)
        } catch {}
      }
      this.accountQuota?.release?.(candidate.accountId)
      return null
    }
    this.inflight.set(candidate.accountId, requestInflight + 1)
    this.bumpFamily(candidate.accountId, family, 1)
    let released = false
    return {
      reserved: true,
      slotIndex: slot?.index ?? null,
      release: () => {
        if (released) return
        released = true
        const next = Math.max(0, (this.inflight.get(candidate.accountId) || 1) - 1)
        if (next === 0) this.inflight.delete(candidate.accountId)
        else this.inflight.set(candidate.accountId, next)
        this.bumpFamily(candidate.accountId, family, -1)
        if (sessionKey) {
          try {
            this.accountQuota?.sessions?.release?.(candidate.accountId, sessionKey)
          } catch {}
        }
        this.accountQuota?.release?.(candidate.accountId)
        if (circuitHold?.probe) this.unitCircuit?.releaseProbe?.(candidate.accountId)
        if (slot?.ephemeral) this.releaseSlotHold(candidate.vmId, slot.holdKey)
        this.notifyCapacity(candidate.accountId)
      },
    }
  }

  _slotBook(vmId) {
    const id = String(vmId || '')
    let book = this.vmSlots.get(id)
    if (!book) {
      book = { preferred: new Map(), inflight: new Map() }
      this.vmSlots.set(id, book)
    }
    return book
  }

  assignedSlot(vmId, sessionKey) {
    if (!sessionKey) return null
    const index = this.vmSlots.get(String(vmId || ''))?.preferred?.get(String(sessionKey))
    return Number.isInteger(index) ? index : null
  }

  slotInflight(vmId, index) {
    if (index == null) return false
    const inflight = this.vmSlots.get(String(vmId || ''))?.inflight
    if (!inflight) return false
    for (const held of inflight.values()) {
      if (held === index) return true
    }
    return false
  }

  usedSlotCount(vmId) {
    return this.vmSlots.get(String(vmId || ''))?.inflight?.size || 0
  }

  /**
   * VM is the callable atom. session_slots are seats inside that VM.
   * A session keeps its seat index as the next decision, and that seat
   * still counts as busy while a request holds it.
   */
  acquireSlot(vmId, sessionKey, cap) {
    const limit = Number(cap) || 0
    if (limit <= 0) return null
    const book = this._slotBook(vmId)
    if (book.inflight.size >= limit) return null
    const key = String(sessionKey || '')
    const preferred = key ? book.preferred.get(key) : null
    let index = Number.isInteger(preferred) ? preferred : null
    if (index == null) {
      const taken = new Set([...book.preferred.values(), ...book.inflight.values()])
      index = 0
      while (taken.has(index)) index += 1
      if (index >= limit) index = 0
      if (key) book.preferred.set(key, index)
    }
    const holdKey = `live:${key || 'anon'}:${index}:${Date.now()}:${Math.random().toString(16).slice(2)}`
    book.inflight.set(holdKey, index)
    return { index, holdKey, ephemeral: true, created: !Number.isInteger(preferred) }
  }

  dropSessionSlot(vmId, sessionKey) {
    const book = this.vmSlots.get(String(vmId || ''))
    const key = String(sessionKey || '')
    if (!book || !key) return
    const index = book.preferred.get(key)
    book.preferred.delete(key)
    if (!Number.isInteger(index)) return
    for (const [hold, held] of book.inflight) {
      if (held === index && String(hold).startsWith(`live:${key}:`)) book.inflight.delete(hold)
    }
    if (!book.inflight.size && !book.preferred.size) this.vmSlots.delete(String(vmId || ''))
  }

  releaseSlotHold(vmId, holdKey) {
    const id = String(vmId || '')
    const book = this.vmSlots.get(id)
    if (!book || !holdKey) return
    book.inflight.delete(String(holdKey))
    if (!book.inflight.size && !book.preferred.size) this.vmSlots.delete(id)
  }

  markSuccess(candidate, { workerStatus = null, countUsage = true } = {}) {
    const now = Date.now()
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

  maxWaiters() {
    return Math.max(1, Number(this.config.max_waiters_per_account) || 32)
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
    const seats = Number(candidate.sessionSlots) || 0
    const conc = Number(candidate.maxConcurrency) || 0
    const usedSlots = Number(candidate.usedSlots) || 0
    if (seats > 0 && usedSlots >= seats) return false
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
      maxWaiting: this.maxWaiters(),
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
        if (this.waiterCount(match.accountId) < this.maxWaiters()) {
          return this.makeWaitPlan(match, { sticky: true, requestDeadline })
        }
        return { queueFull: true, sticky: true, accountId: match.accountId }
      }
    }
    const waitable = candidates.filter((candidate) => candidate.busy && !this.isReservable(candidate))
    const peek = this.peekRank(waitable)
    const ranked = [...waitable].sort(
      (left, right) =>
        left.lastUsedAt - right.lastUsedAt || String(left.accountId).localeCompare(String(right.accountId)),
    )
    const order = peek ? [peek, ...ranked.filter((candidate) => candidate.accountId !== peek.accountId)] : ranked
    for (const candidate of order) {
      if (this.waiterCount(candidate.accountId) < this.maxWaiters()) {
        return this.makeWaitPlan(candidate, { sticky: false, requestDeadline })
      }
    }
    if (waitable.length) return { queueFull: true }
    return null
  }

  waitForCapacity({ signal, deadline, stickyKey, accountId = null, sticky = false } = {}) {
    const bucketId = String(accountId || stickyKey || '_pool')
    if (this.waiterCount(bucketId) >= this.maxWaiters()) {
      throw Object.assign(new Error('Account pool wait queue is full'), {
        code: 'pool_wait_queue_full',
        accountId: bucketId,
      })
    }
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
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        const live = this.waiters.get(bucketId)
        live?.delete(id)
        if (live && live.size === 0) this.waiters.delete(bucketId)
      }
      bucket.set(id, {
        sticky: !!sticky,
        wake: () => {
          cleanup()
          const jitter = stickyKey ? Math.floor(Math.random() * 20) : 0
          if (jitter) setTimeout(() => finish(true), jitter)
          else finish(true)
        },
      })
      if (signal?.aborted) onAbort()
      else signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

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
      this.clearQuotaRestriction(vm, accountId, file)
      if (leftover) {
        setVmSchedulable(this.projectRoot, vm.id, true, null, { preserveStatus: true, source: 'force' })
        vm.schedulable = true
        vm.schedule_disabled_reason = null
        return { action: 'enable', reason: null }
      }
      return { action: 'clear', reason: null }
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
    return {
      strategy: this.config.strategy,
      fable_max_per_account: this.config.fable_max_per_account,
      inflight: Object.fromEntries(this.inflight),
      inflight_family: family,
      waiters: this.waiterSnapshot(),
      health_cache: Object.fromEntries([...this.healthCache].map(([id, entry]) => [id, entry.value])),
    }
  }
}
