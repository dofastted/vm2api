import { getVm, listVms, setVmSchedulable } from '../vm/vm-registry.mjs'
import { vmCliHomePath, vmJsonPath } from '../vm/execution-context.mjs'
import {
  expiresAtToMs,
  hasRefreshPresence,
  readSlotCredentialIdentity,
  mirrorWorkerCredentialsToVm,
  markVmAuthCooldown,
  clearVmAuthCooldown,
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
import { evaluateAccount, isQuotaWindowReason } from './availability.mjs'
import { listQuotaFromHeaders } from './quota-window.mjs'
import { isSlotProxyDesynced, readWorkerProxyEndpoint, readWorkerEgressMode } from '../vm/vm-runtime.mjs'
import { splitBlocksModel } from './weekly-split.mjs'
import { slotAllowsModel } from './slot-model-gate.mjs'
import { resolveCredentialScheduleLevel } from './credential-weight.mjs'
import { PLATFORM_SCOPE, vmMatchesOwnerScope } from '../admin/resource-owner.mjs'

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
  if (Number.isFinite(soonest) && soonest >= 0) {
    parts.push(`soonest=${Math.round(soonest / 1000)}s`)
  }
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

function accountIdOf(vm, projectRoot = null) {
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

/** Concurrency and RPM wait on the bound account. Cooldown / quota must rotate. */
function stickyShouldWait(waitReason) {
  return waitReason === 'concurrency_limit' || waitReason === 'fable_concurrency' || waitReason === 'rpm_limit'
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
  }

  async selectAndReserve({
    model,
    stickyKey = null,
    excluded = new Set(),
    signal,
    deadline = null,
    allowWait = true,
    pinVmId = null,
    ownerScope = PLATFORM_SCOPE,
  } = {}) {
    const startedAt = Date.now()
    const pinned = !!String(pinVmId || '').trim()
    const blocked = new Set(excluded)
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
    const finalDeadline =
      Number(deadline) ||
      startedAt + (stickyKey ? this.config.sticky_wait_timeout_ms : this.config.fallback_wait_timeout_ms)
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
      const available = candidates.filter((candidate) => !candidate.busy)
      const selected = this.pick(available, { model, stickyKey, eligible: candidates })
      if (this.lastStickyCleared) stickyCleared = true
      if (selected) {
        const reservation = this.reserve(selected, { sessionKey: stickyKey, skipQuota: pinned })
        if (reservation) {
          return {
            ...selected,
            ...reservation,
            waitMs: Date.now() - startedAt,
          }
        }
        // checkEligibility and reserve can disagree (pin skips the quota gate).
        // Never retry the same account in this turn — a tight continue starves /health.
        if (selected.accountId) blocked.add(selected.accountId)
        if (selected.vmId) blocked.add(selected.vmId)
        continue
      }
      if (candidates.length === 0) {
        return fail(isFableModel(model) ? 'fable_requires_max' : 'no_eligible_accounts', candidates, available)
      }
      const waitPool = candidates.filter((candidate) => !isUnboundAuthCooldown(candidate, boundBefore, stickyCleared))
      if (!allowWait || Date.now() >= finalDeadline) {
        return fail('all_accounts_busy', candidates, available, waitPool)
      }
      const now = Date.now()
      const wakeAts = waitPool.map((candidate) => Number(candidate.availableAt) || 0).filter((value) => value > now)
      const concurrencyWait = waitPool.some((candidate) => candidate.busy && stickyShouldWait(candidate.waitReason))
      if (wakeAts.length && Math.min(...wakeAts) >= finalDeadline && !concurrencyWait) {
        return fail('all_accounts_busy', candidates, available, waitPool)
      }
      const wakeAt = wakeAts.length ? Math.min(finalDeadline, ...wakeAts) : finalDeadline
      await this.waitForCapacity({
        signal,
        deadline: wakeAt,
        stickyKey,
      })
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
        loadRatio: inflight / maxConcurrency,
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
          cooldownUntil: state?.cooldown_until || vm.claude?.temp_unschedulable_until || null,
          cooldownReason: state?.cooldown_reason || vm.claude?.temp_unschedulable_reason || null,
          now,
        })
        this.syncQuotaSchedule(vm, account)
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
        status: value?.ok ? 'ready' : 'worker_unhealthy',
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

  pick(candidates, { model, stickyKey, eligible = candidates } = {}) {
    this.lastStickyCleared = false
    if (!candidates.length && !eligible?.length) return null
    const bound = stickyKey ? this.stickyRouter?.resolve?.(stickyKey) : null
    if (bound) {
      const match = (candidate) => candidate.vmId === bound.vmId && candidate.accountId === bound.accountId
      const amongEligible = (eligible || candidates).find(match)
      if (!amongEligible) {
        this.stickyRouter?.unbind?.(stickyKey)
        this.lastStickyCleared = true
      } else if (amongEligible.busy) {
        if (stickyShouldWait(amongEligible.waitReason)) return null
        this.stickyRouter?.unbind?.(stickyKey)
        this.lastStickyCleared = true
      } else {
        return { ...amongEligible, selectionReason: 'sticky' }
      }
    }
    if (!candidates.length) return null
    const highestPriority = Math.max(...candidates.map((candidate) => candidate.priority))
    let pool = candidates.filter((candidate) => candidate.priority === highestPriority)
    const minLoad = Math.min(...pool.map((candidate) => candidate.loadRatio))
    pool = pool.filter((candidate) => candidate.loadRatio === minLoad)
    if (pool.length === 1) return { ...pool[0], selectionReason: 'priority-load' }

    const strategy = String(this.config.strategy || 'weighted-round-robin')
    if (strategy === 'fill-first') {
      pool.sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.accountId.localeCompare(right.accountId))
      return { ...pool[0], selectionReason: 'fill-first' }
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

  reserve(candidate, { sessionKey = null, skipQuota = false } = {}) {
    const current = this.inflight.get(candidate.accountId) || 0
    if (!candidate.maxConcurrency || current >= candidate.maxConcurrency) return null
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
      sessionKey,
      skipGate: !!skipQuota,
      tier: vmTierOf(candidate.vm),
    })
    if (quotaReservation && !quotaReservation.ok) return null
    if (sessionKey) {
      try {
        this.accountQuota?.sessions?.touch?.(candidate.accountId, sessionKey)
      } catch {}
    }
    this.inflight.set(candidate.accountId, current + 1)
    this.bumpFamily(candidate.accountId, family, 1)
    let released = false
    return {
      reserved: true,
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
        this.notifyCapacity()
      },
    }
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

  waitForCapacity({ signal, deadline, stickyKey }) {
    const maxWaiters = Math.max(1, Number(this.config.max_waiters_per_account) || 32)
    if (this.waiters.size >= maxWaiters) {
      throw Object.assign(new Error('Account pool wait queue is full'), { code: 'pool_wait_queue_full' })
    }
    const id = Symbol('pool-waiter')
    return new Promise((resolve, reject) => {
      const remaining = Math.max(1, deadline - Date.now())
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, remaining)
      const onAbort = () => {
        cleanup()
        reject(makeAbortError())
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        this.waiters.delete(id)
      }
      this.waiters.set(id, () => {
        cleanup()
        const jitter = stickyKey ? Math.floor(Math.random() * 20) : 0
        if (jitter) setTimeout(resolve, jitter)
        else resolve()
      })
      if (signal?.aborted) onAbort()
      else signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

  notifyCapacity() {
    const callbacks = [...this.waiters.values()]
    this.waiters.clear()
    for (const callback of callbacks) {
      try {
        callback()
      } catch {}
    }
  }

  /**
   * Extra 5h/7d reject → 调度关. Window open again → auto-on unless the
   * operator lock reason is something else. `source:force` so a leftover
   * schedule_manual flag cannot keep a 100% Extra slot in the pool.
   */
  syncQuotaSchedule(vm, account = null) {
    if (!this.projectRoot || !vm?.id) return { action: 'keep', reason: null }
    const accountId = account?.account_id || vm.claude?.account_uuid || vm.id
    account = account || this.accountQuota?.repo?.get?.(accountId) || null
    if (!account) return { action: 'keep', reason: null }
    const now = Date.now()
    const lastUsedAt = this.lastUsed.get(accountId) || account.last_used_at || 0
    const ev = evaluateAccount({
      vm,
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
    if (!ev.accept && isQuotaWindowReason(ev.reason)) {
      if (vm.schedulable !== false) {
        setVmSchedulable(this.projectRoot, vm.id, false, ev.reason, { preserveStatus: true, source: 'force' })
        return { action: 'disable', reason: ev.reason }
      }
      return { action: 'keep', reason: ev.reason }
    }
    if (ev.accept && vm.schedulable === false && isQuotaWindowReason(vm.schedule_disabled_reason)) {
      setVmSchedulable(this.projectRoot, vm.id, true, null, { preserveStatus: true, source: 'force' })
      return { action: 'enable', reason: null }
    }
    return { action: 'keep', reason: ev.reason || null }
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
      waiters: this.waiters.size,
      health_cache: Object.fromEntries([...this.healthCache].map(([id, entry]) => [id, entry.value])),
    }
  }
}
