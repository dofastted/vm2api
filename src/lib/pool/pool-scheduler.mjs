import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { effectiveSlotCount } from '../vm/slot-capacity.mjs'
import { getVm, listVms, migrateVmSchedule } from '../vm/vm-registry.mjs'
import { vmCliHomePath, vmJsonPath } from '../vm/execution-context.mjs'
import { checkCragLicense } from '../vm/crag-license.mjs'
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
import { isAuthCooldownReason } from './schedule-eligibility.mjs'
import {
  evaluateAccount,
  isAccountRestrictionReason,
  isLeftoverQuotaScheduleOff,
  isQuotaWindowReason,
} from './availability.mjs'
import { listQuotaFromHeaders, noResetRejectExpired } from './quota-window.mjs'
import { hardBlockOf } from './rate-limit-service.mjs'
import { unitCircuit } from './unit-circuit.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { setResetPriorityEnabled } from './credential-weight.mjs'
import { PLATFORM_SCOPE } from '../admin/resource-owner.mjs'
import { rustKernelBusy } from '../transport/rust-kernel-client.mjs'
import { resolveSessionSlots } from '../vm/slot-engine.mjs'
import { vmNodeDataPath } from '../cluster/placement.mjs'
import { GATE_DIAL_TIMEOUT_MS } from '../cluster/direct-link.mjs'
import { KernelLeaseStats, normalizeKernelLeaseMode } from './kernel-lease.mjs'
import { HOST_PRESSURE_CRITICAL, HOST_PRESSURE_OK } from '../cluster/host-memory-pressure.mjs'
import {
  SchedulerApiError,
  SchedulerUnavailableError,
  VIRTUAL_POOL_IDS,
  formatNodeKey,
  inferModelFamily,
} from '../scheduler/scheduler-runtime.mjs'

const WAIT_TIMEOUT_MIN_MS = 1000
const WAIT_TIMEOUT_MAX_MS = 120000

export const QUEUE_MAX_MIN = 1
export const QUEUE_MAX_MAX = 999
export const SEAT_GRACE_MAX_MS = 120000
export const SEAT_BUDGET_RESERVE_MAX = 0.5
export const CIRCUIT_THRESHOLD_MAX = 20
export const CIRCUIT_OPEN_MIN_MS = 1000

/** routing.pool defaults (shared by panel & routing-runtime normalization). */
export const DEFAULT_POOL_ROUTING = Object.freeze({
  strategy: 'balanced',
  max_primary_sessions: null,
  max_subagents_per_session: null,
  queue_max: 50,
  seat_grace_ms: 30000,
  seat_budget_reserve_pct: 0.02,
  fallback_wait_timeout_ms: 30000,
  sticky_wait_timeout_ms: 45000,
  circuit_failure_threshold: 3,
  circuit_open_ms: 30000,
  session_affinity_first: false,
  fresh_account_isolation_ms: 0,
  kernel_lease_queue_grace_ms: 5000,
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

function sessionLimit(value, min) {
  return Number.isInteger(value) && value >= min && value <= 20 ? value : null
}

function circuitSetting(value, fallback, min, max) {
  if (!Number(value)) return fallback
  return clampNumber(value, fallback, min, max)
}

export function normalizePoolRouting(pool = {}) {
  const next = { ...(pool && typeof pool === 'object' ? pool : {}) }
  delete next.max_waiters_per_account
  next.strategy = next.strategy === 'fill' ? 'fill' : 'balanced'
  next.max_primary_sessions = sessionLimit(next.max_primary_sessions, 1)
  next.max_subagents_per_session = sessionLimit(next.max_subagents_per_session, 0)
  next.session_affinity_first = next.session_affinity_first === true
  next.fresh_account_isolation_ms = clampNumber(
    next.fresh_account_isolation_ms,
    DEFAULT_POOL_ROUTING.fresh_account_isolation_ms,
    0,
    Number.MAX_SAFE_INTEGER,
  )
  next.fable_requires_max = next.fable_requires_max === true
  next.family_affinity_first = next.family_affinity_first === true
  next.keep_pin_on_model_gate = next.keep_pin_on_model_gate === true
  next.reset_priority = next.reset_priority !== false
  next.kernel_lease = normalizeKernelLeaseMode(next.kernel_lease)
  next.kernel_lease_queue_grace_ms = clampNumber(
    next.kernel_lease_queue_grace_ms,
    DEFAULT_POOL_ROUTING.kernel_lease_queue_grace_ms,
    0,
    WAIT_TIMEOUT_MAX_MS,
  )
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

function normalizePoolConfig(config = {}) {
  const next = { ...DEFAULT_CONFIG, ...normalizePoolRouting(config) }
  setResetPriorityEnabled(next.reset_priority)
  return next
}

export function formatPoolSelectionSummary(details = {}) {
  const reason = String(details.reason || '').trim()
  if (!reason) return ''
  const parts = [reason]
  if (details.selection_reason === 'subagent-fallback') parts.push(details.selection_reason)
  const soonest = Number(details.soonest_available_ms)
  if (Number.isFinite(soonest) && soonest > 0) {
    parts.push(`soonest=${Math.round(soonest / 1000)}s`)
  }
  const eligible = Number(details.eligible)
  if (Number.isFinite(eligible)) parts.push(`eligible=${eligible}`)
  if (details.sticky_cleared) parts.push('sticky_cleared')
  return parts.join(' ')
}

/** Soft affinity order helper for display/tests (actual affinity lives in Rust `kin-scheduler`). */
export function seatHomes({ deviceVm = '', familyVm = '', familyFirst = false } = {}) {
  const device = { vmId: String(deviceVm || '').trim(), reason: 'device-affinity' }
  const family = { vmId: String(familyVm || '').trim(), reason: 'family-affinity' }
  const homes = familyFirst ? [family, device] : [device, family]
  const seen = new Set()
  return homes.filter((home) => {
    if (!home.vmId || seen.has(home.vmId)) return false
    seen.add(home.vmId)
    return true
  })
}

function hostAdmits(candidate, strict) {
  const level = candidate?.hostPressure || HOST_PRESSURE_OK
  if (level === HOST_PRESSURE_OK) return true
  return !strict && level !== HOST_PRESSURE_CRITICAL
}

export function filterByHostMemory(candidates, stickyVmId = '') {
  const keep = (strict) =>
    candidates.filter((candidate) => candidate.vmId === stickyVmId || hostAdmits(candidate, strict))
  const strict = keep(true)
  return strict.some((candidate) => candidate.vmId !== stickyVmId) ? strict : keep(false)
}

export const QUOTA_GUARD_DEFAULTS = { new_session_ratio: 0.85, stop_ratio: 0.95 }

function quotaValidationError(message) {
  const error = new TypeError(message)
  error.code = 'invalid_quota_config'
  return error
}

export function validateQuotaRoutingPatch(body = {}, currentQuota = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return
  if (!Object.prototype.hasOwnProperty.call(body, 'quota')) return
  const quota = body.quota
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) {
    throw quotaValidationError('quota 必须是对象')
  }
  const hasNew = Object.prototype.hasOwnProperty.call(quota, 'exhaustion_guard_new_session')
  const hasStop = Object.prototype.hasOwnProperty.call(quota, 'exhaustion_guard_stop')
  if (!hasNew && !hasStop) return
  const parseRatio = (raw, field) => {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > 1) {
      throw quotaValidationError(`${field} 必须是 (0, 1] 之间的数字`)
    }
    return raw
  }
  const fallbackRatio = (raw, fallback) => {
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback
  }
  const newSession = hasNew
    ? parseRatio(quota.exhaustion_guard_new_session, 'quota.exhaustion_guard_new_session')
    : fallbackRatio(currentQuota?.exhaustion_guard_new_session, QUOTA_GUARD_DEFAULTS.new_session_ratio)
  const stop = hasStop
    ? parseRatio(quota.exhaustion_guard_stop, 'quota.exhaustion_guard_stop')
    : fallbackRatio(currentQuota?.exhaustion_guard_stop, QUOTA_GUARD_DEFAULTS.stop_ratio)
  if (newSession > stop) {
    throw quotaValidationError('quota.exhaustion_guard_new_session 不能大于 quota.exhaustion_guard_stop')
  }
}

export function quotaGuardConfigOf(quota = {}) {
  const ratio = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback
  }
  const stop = ratio(quota?.exhaustion_guard_stop, QUOTA_GUARD_DEFAULTS.stop_ratio)
  const fresh = Math.min(stop, ratio(quota?.exhaustion_guard_new_session, QUOTA_GUARD_DEFAULTS.new_session_ratio))
  return { enabled: quota?.exhaustion_guard === true, new_session_ratio: fresh, stop_ratio: stop }
}

function guardResetMs(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

function guardWindowReading(window, now) {
  if (!window || typeof window !== 'object') return null
  const until = guardResetMs(window.reset)
  if (until != null && until <= now) return null
  const status = String(window.status || '').toLowerCase()
  const raw = Number(window.utilization)
  const hasRatio = window.utilization != null && window.utilization !== '' && Number.isFinite(raw)
  const percent = hasRatio && raw > 1.5
  const ratio = hasRatio ? (percent ? raw / 100 : raw) : null
  if (status === 'rejected' || status === 'rate_limited') {
    if (percent && ratio < 1) return { ratio, until, rejected: false }
    return { ratio: 1, until, rejected: true }
  }
  if (!hasRatio) return null
  return { ratio, until, rejected: false }
}

export function quotaGuardUsage(unified = {}, now = Date.now()) {
  let worst = null
  for (const key of ['5h', '7d']) {
    const headerSample = noResetRejectExpired(unified, key, now) ? null : unified?.headers?.[key]
    for (const sample of [headerSample, unified?.official?.[key], unified?.[key]]) {
      const reading = guardWindowReading(sample, now)
      if (!reading) continue
      const better =
        !worst ||
        reading.ratio > worst.ratio ||
        (reading.ratio === worst.ratio && (reading.until || 0) > (worst.until || 0))
      if (better) worst = { ...reading, window: key }
    }
  }
  return worst
}

export function quotaGuardLevel(unified, config, now = Date.now()) {
  const usage = quotaGuardUsage(unified, now)
  if (!usage) return { level: 'open', usage: null }
  const overageOpen = String(unified?.overage_status || '').toLowerCase() === 'allowed'
  if (usage.rejected && !overageOpen) return { level: 'stop', usage }
  if (!config?.enabled) return { level: 'open', usage }
  if (usage.ratio >= config.stop_ratio) return { level: 'stop', usage }
  if (usage.ratio >= config.new_session_ratio) return { level: 'continuing', usage }
  return { level: 'open', usage }
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

function seatCapOf(vm, fallback = 20) {
  return Math.min(resolveSessionSlots(vm, { inference: { session_slots: fallback } }), effectiveSlotCount(vm))
}

export function familyLimitsOf(vm, pool = {}, physical = seatCapOf(vm, pool.default_session_slots)) {
  const primaryOverride = vm?.policy?.maxPrimarySessionsOverride ?? vm?.max_primary_sessions_override
  const childOverride = vm?.policy?.maxSubagentsPerSessionOverride ?? vm?.max_subagents_per_session_override
  const inheritedPrimary = sessionLimit(pool.max_primary_sessions, 1) ?? physical
  const inheritedSubagents = sessionLimit(pool.max_subagents_per_session, 0)
  const primary =
    (primaryOverride ? sessionLimit(vm?.policy?.maxPrimarySessions ?? vm?.max_primary_sessions, 1) : null) ??
    inheritedPrimary
  const subagents =
    (childOverride ? sessionLimit(vm?.policy?.maxSubagentsPerSession ?? vm?.max_subagents_per_session, 0) : null) ??
    inheritedSubagents
  return {
    primary,
    subagents,
    physical,
    seats: subagents == null ? physical : primary,
    inheritedPrimary,
    inheritedSubagents,
  }
}

function vmTierOf(vm) {
  if (vm?.claude?.account_tier || vm?.account_tier) return vm.claude?.account_tier || vm.account_tier
  return vm?.claude?.has_access || vm?.has_token ? 'pro' : null
}

export const MODEL_GATE_REASONS = new Set([
  'fable_requires_max',
  'model_not_supported',
  'model_not_allowed',
  'model_fast_unavailable',
])

export const MODEL_WAIT_REASONS = new Set(['model_cooldown', 'fable_cooldown', 'fable_quota', 'fable_split'])

export const SOFT_COOLDOWN_REASONS = new Set(['rpm_limited', 'rate_limited_unknown'])

function directWorkerAnswered(value) {
  return value?.ok === true || value?.engine === 'rust' || !!value?.worker_version
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

function allowedClaudeNodeKeysFromScope(keyScope) {
  if (!keyScope || typeof keyScope !== 'object') return undefined
  if (Array.isArray(keyScope.allowed_vms) && keyScope.allowed_vms.length > 0) {
    return keyScope.allowed_vms.map((id) => formatNodeKey('claude_vm', id))
  }
  return undefined
}

/**
 * Claude VM runtime facade backed solely by Rust `kin-scheduler`.
 *
 * M3 cutover (D4): ALL legacy Node selection, SeatPlanner, local waiter queues,
 * local sticky reconciliation, and round-robin/priority ranking state machines
 * have been deleted. This class retains only:
 * 1. Strict Rust `acquireNode` / `explainDispatch` delegation (Fail-Closed 503).
 * 2. VM execution context resolution (`executionContext`, `resolveCandidateForNode`).
 * 3. Background worker health probing & quota/cooldown telemetry reporting to Rust.
 * 4. Lightweight in-flight observability gauges (`vmInflight`, `snapshot`, `seatSnapshot`).
 */
export class PoolScheduler extends EventEmitter {
  constructor({
    projectRoot,
    stickyRouter = null,
    accountQuota = null,
    runtimeRepo = null,
    workerHealth = null,
    getRouting = () => ({}),
    config = {},
    schedulerRuntime = null,
  } = {}) {
    super()
    this.setMaxListeners(100)
    this.projectRoot = projectRoot
    this.stickyRouter = stickyRouter
    this.accountQuota = accountQuota
    this.runtimeRepo = runtimeRepo
    this.workerHealth = workerHealth
    this.getRouting = getRouting
    this.config = normalizePoolConfig(config)
    this.schedulerRuntime = schedulerRuntime || null
    // Observability gauges only (panel live stream & graceful drain check).
    this.inflight = new Map()
    this.vmInflight = new Map()
    this.kernelLeaseStats = new KernelLeaseStats()
    this.changePending = false
    this.healthCache = new Map()
    this.healthFlights = new Map()
    this.healthWrites = new Map()
    this.maintenanceTimer = null
    this.maintenanceFlight = null
    this.maintenanceStopped = false
    this.lastUsed = new Map()
    this.unitCircuit = unitCircuit
    if (runtimeRepo) this.unitCircuit.bindRepo(runtimeRepo)
  }

  setSchedulerRuntime(rt) {
    this.schedulerRuntime = rt || null
  }

  requireSchedulerRuntime(override = null) {
    const rt = override || this.schedulerRuntime
    if (!rt) {
      throw new SchedulerUnavailableError('Rust scheduler runtime is unavailable', {
        reason: 'runtime_missing',
      })
    }
    return rt
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

  /**
   * Materialize a Node execution candidate object from a Rust `SelectedNodeInfo` response.
   */
  resolveCandidateForNode(
    selectedNode,
    {
      model = '',
      resolvedPoolId = null,
      promptPolicy = null,
      leaseId = null,
      leaseTtlMs = null,
      stoodIn = false,
      preserveMachineHome = false,
      sessionGateWaitMs = 0,
      explain = null,
      quotaRequest = null,
      release = null,
    } = {},
  ) {
    const vmId = String(selectedNode?.node_id || '')
    let vm = null
    if (this.projectRoot && vmId) {
      try {
        vm = getVm(this.projectRoot, vmId)
      } catch {
        vm = null
      }
    }
    const accountId = vm ? accountIdOf(vm, this.projectRoot) : vmId
    const exec = vm && this.projectRoot ? this.executionContext(vm, accountId) : null
    const state = accountId ? this.runtimeRepo?.get?.(accountId) || null : null
    const workerStatus = this.healthCache.get(vmId)?.value || state?.worker_status || null
    const schedulingMs = Number.isFinite(Number(explain?.decide_us)) ? Math.round(Number(explain.decide_us) / 1000) : 0
    return {
      ok: true,
      vmId,
      accountId,
      vm,
      exec,
      state,
      workerStatus,
      model,
      nodeKey: selectedNode?.node_key || formatNodeKey('claude_vm', vmId),
      leaseId,
      leaseTtlMs,
      resolvedPoolId,
      promptPolicy,
      stoodIn: stoodIn === true,
      preserveMachineHome: preserveMachineHome === true,
      explain,
      selectionReason: explain?.affinity?.why || 'rust-scheduler',
      waitMs: Number(sessionGateWaitMs) || 0,
      queueWaitMs: Number(sessionGateWaitMs) || 0,
      schedulingMs,
      quotaRequest,
      release: typeof release === 'function' ? release : () => {},
    }
  }

  /**
   * Acquire a Claude VM slot strictly via Rust `kin-scheduler` (Fail-Closed 503 on outage).
   */
  async selectAndReserve(args = {}) {
    const rt = this.requireSchedulerRuntime(args.schedulerRuntime)
    const excludedKeys = []
    if (args.excluded) {
      for (const item of args.excluded) {
        const s = String(item || '').trim()
        if (!s) continue
        excludedKeys.push(s.includes(':') ? s : formatNodeKey('claude_vm', s))
      }
    }
    const originPoolId =
      args.originPoolId || args.poolAccess?.effectivePool?.id || args.keyScope?.vm_pool_id || VIRTUAL_POOL_IDS.claude
    const sessionId =
      args.inboundIdentity?.sessionId || (args.stickyKey ? String(args.stickyKey) : '') || crypto.randomUUID()
    const isManagedPool = Boolean(args.poolAccess && args.poolAccess.legacy === false)
    const acquireParams = {
      requestId: args.requestId || crypto.randomUUID(),
      attemptNo: Number(args.attemptNo) || 1,
      originPoolId,
      jevDowngradePoolId: args.jevDowngradePoolId || null,
      apiKeyScope: args.apiKeyScope || undefined,
      apiKeyRecord: args.apiKeyRecord || null,
      apiKeyKind: args.apiKeyKind || null,
      poolAccess: args.poolAccess || null,
      ownerScope: args.ownerScope || PLATFORM_SCOPE,
      allowedNodeKeys: isManagedPool ? undefined : allowedClaudeNodeKeysFromScope(args.keyScope),
      nodeTypes: ['claude_vm'],
      model: String(args.model || ''),
      modelFamily: inferModelFamily(args.model, 'anthropic'),
      protocol: args.protocol || 'anthropic.messages',
      machineId: args.inboundIdentity?.machineId || args.stickyDeviceId || null,
      sessionId,
      sessionIdSource: args.inboundIdentity?.sessionSource || null,
      parentSessionId: args.inboundIdentity?.parentSessionId || args.rootSessionId || null,
      isEphemeralProbe: Boolean(
        args.isEphemeralProbe || args.skipSessionSlot || args.inboundIdentity?.isEphemeralProbe,
      ),
      noQueue: args.allowWait === false || args.noQueue === true,
      isAdminDiagnostic: Boolean(args.isAdminDiagnostic || args.pinVmId),
      pinNodeKey: args.pinVmId ? formatNodeKey('claude_vm', args.pinVmId) : null,
      excludeNodes: excludedKeys,
    }
    let acquired
    try {
      acquired = await rt.acquireNode(acquireParams, { signal: args.signal })
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || args.signal?.aborted) {
        throw makeAbortError()
      }
      if (err instanceof SchedulerUnavailableError || err?.code === 'scheduler_unavailable') {
        throw err
      }
      if (err instanceof SchedulerApiError) {
        return {
          ok: false,
          reason: err.code,
          status: err.status,
          message: err.message,
          retry_after_ms: err.retryAfterSec != null ? err.retryAfterSec * 1000 : null,
          explain: err.explain || null,
        }
      }
      throw err
    }

    const vmId = acquired.selected_node.node_id
    let vm = null
    if (this.projectRoot && vmId) {
      try {
        vm = getVm(this.projectRoot, vmId)
      } catch {
        vm = null
      }
    }
    const accountId = vm ? accountIdOf(vm, this.projectRoot) : vmId
    this.bumpInflight(accountId, vmId, 1)
    let released = false
    const release = (payload = { outcome: 'ok' }) => {
      if (released) return
      released = true
      this.bumpInflight(accountId, vmId, -1)
      void rt.releaseLease(acquired.lease_id, payload).catch(() => {})
    }
    return this.resolveCandidateForNode(acquired.selected_node, {
      model: args.model,
      resolvedPoolId: acquired.resolved_pool_id,
      promptPolicy: acquired.prompt_policy,
      leaseId: acquired.lease_id,
      leaseTtlMs: acquired.lease_ttl_ms,
      stoodIn: acquired.stood_in,
      preserveMachineHome: acquired.preserve_machine_home,
      sessionGateWaitMs: acquired.session_gate_wait_ms,
      explain: acquired.explain,
      quotaRequest: args.quotaRequest,
      release,
    })
  }

  /**
   * Pure read-only dry-run account peek strictly via Rust `/internal/v1/schedule/explain`.
   * Never reserves slots and never blocks `SessionGate`.
   */
  async peekAccount({
    model = '',
    stickyKey = null,
    inboundIdentity = null,
    originPoolId = null,
    signal,
    ownerScope = PLATFORM_SCOPE,
    keyScope = null,
    apiKeyRecord = null,
    apiKeyKind = null,
    poolAccess = null,
    schedulerRuntime = null,
  } = {}) {
    const rt = this.requireSchedulerRuntime(schedulerRuntime)
    const resolvedOriginPoolId =
      originPoolId || poolAccess?.effectivePool?.id || keyScope?.vm_pool_id || VIRTUAL_POOL_IDS.claude
    const explainRes = await rt.explainDispatch(
      {
        requestId: `peek_${crypto.randomBytes(6).toString('hex')}`,
        originPoolId: resolvedOriginPoolId,
        apiKeyRecord,
        apiKeyKind,
        poolAccess,
        ownerScope,
        allowedNodeKeys:
          poolAccess && poolAccess.legacy === false ? undefined : allowedClaudeNodeKeysFromScope(keyScope),
        nodeTypes: ['claude_vm'],
        model: String(model || ''),
        modelFamily: inferModelFamily(model, 'anthropic'),
        protocol: 'anthropic.messages',
        machineId: inboundIdentity?.machineId || null,
        sessionId: inboundIdentity?.sessionId || (stickyKey ? String(stickyKey) : crypto.randomUUID()),
        isEphemeralProbe: true,
        noQueue: true,
      },
      { signal },
    )
    if (!explainRes?.ok || !explainRes.selected_node) {
      return {
        ok: false,
        code: explainRes?.error_code || 'no_eligible_accounts',
        retry_after_ms: null,
        explain: explainRes?.explain || null,
      }
    }
    return this.resolveCandidateForNode(explainRes.selected_node, {
      model,
      resolvedPoolId: explainRes.resolved_pool_id,
      promptPolicy: explainRes.prompt_policy,
      stoodIn: explainRes.stood_in,
      preserveMachineHome: explainRes.preserve_machine_home,
      explain: explainRes.explain,
    })
  }

  async getWorkerHealth(exec, { signal = undefined, state = null, dataPath = vmNodeDataPath(exec.vm) } = {}) {
    if (signal?.aborted) throw makeAbortError()
    if (typeof this.workerHealth !== 'function') {
      return dataPath === 'direct' ? null : { ok: true, source: 'scheduler-no-health-provider' }
    }
    const cached = this.healthCache.get(exec.vmId)
    if (
      cached &&
      cached.dataPath === dataPath &&
      cached.accountId === exec.accountId &&
      Number(state?.credential_generation || 0) <= cached.generation &&
      Date.now() - cached.at < this.config.worker_health_ttl_ms
    ) {
      return cached.value
    }
    const flightKey = `${exec.vmId}:${exec.accountId}:${dataPath}`
    let flight = this.healthFlights.get(flightKey)
    if (!flight) {
      flight = this.refreshWorkerHealth(exec, state, dataPath).finally(() => {
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

  async refreshWorkerHealth(exec, state, dataPath = vmNodeDataPath(exec.vm)) {
    const now = Date.now()
    let value
    try {
      value = await this.workerHealth(exec, dataPath === 'direct' ? { timeoutMs: GATE_DIAL_TIMEOUT_MS + 1500 } : {})
    } catch (error) {
      value = { ok: false, error: String(error.message || error) }
    }
    if (dataPath !== vmNodeDataPath(exec.vm)) return value
    if (
      (dataPath === 'direct' && !directWorkerAnswered(value)) ||
      (dataPath === 'ssh' && value?.status === 0 && value.ok !== true)
    ) {
      if (this.healthCache.get(exec.vmId)?.dataPath === dataPath) this.healthCache.delete(exec.vmId)
      this.schedulerRuntime?.enqueueTelemetry?.([
        {
          node_key: formatNodeKey('claude_vm', exec.vmId),
          schedulable: false,
          unschedulable_reason: 'worker_unhealthy',
        },
      ])
      return value
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
      dataPath,
      accountId: exec.accountId,
      generation: Math.max(Number(state?.credential_generation) || 0, Number(value?.credential?.generation) || 0),
    })
    this.schedulerRuntime?.enqueueTelemetry?.([
      {
        node_key: formatNodeKey('claude_vm', exec.vmId),
        schedulable: Boolean(value?.ok || rustKernelBusy(value)),
        unschedulable_reason: value?.ok || rustKernelBusy(value) ? null : 'worker_unhealthy',
      },
    ])
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
    if (this.maintenanceStopped || !this.runtimeRepo) return
    for (const [accountId, update] of this.healthWrites) {
      await this.runtimeRepo.writeHeartbeat(update)
      if (this.healthWrites.get(accountId) === update) this.healthWrites.delete(accountId)
    }
  }

  async maintain() {
    const now = Date.now()
    const cleanupDue = !this.lastCleanupAt || now - this.lastCleanupAt >= 30000
    await this.flushHealthWrites()
    if (cleanupDue) {
      await this.runtimeRepo?.clearExpired?.(now)
      await this.stickyRouter?.repo?.purgeExpired?.(now)
      this.lastCleanupAt = now
    }
    if (!this.projectRoot) return
    const vms = listVms(this.projectRoot)
      .map((summary) => getVm(this.projectRoot, summary.id))
      .filter((vm) => vm && vm.schedulable !== false && vm.status === 'running' && !isCodexVm(vm))
    const snapshots =
      (await this.runtimeRepo?.schedulingSnapshot?.(vms.map((vm) => accountIdOf(vm, this.projectRoot)))) || new Map()
    await Promise.allSettled(
      vms.map((vm) => {
        if (this.maintenanceStopped || vmNodeDataPath(vm) === 'offline') return null
        const accountId = accountIdOf(vm, this.projectRoot)
        return this.getWorkerHealth(this.executionContext(vm, accountId), { state: snapshots.get(accountId)?.state })
      }),
    )
    if (this.maintenanceStopped) return
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
      if (vmId && this.schedulerRuntime?.unrestNode) {
        void this.schedulerRuntime.unrestNode(formatNodeKey('claude_vm', vmId)).catch(() => {})
      }
      this.notifyCapacity()
    }
    return cleared
  }

  clearGrantRevokeCooldownFor(vmId, accountId = null) {
    const ids = [...new Set([accountId, vmId].filter(Boolean))]
    let cleared = false
    for (const id of ids) {
      try {
        if (this.runtimeRepo?.clearGrantRevokeCooldown?.(id, { vmId })) cleared = true
      } catch {}
    }
    if (cleared) {
      if (vmId && this.schedulerRuntime?.unrestNode) {
        void this.schedulerRuntime.unrestNode(formatNodeKey('claude_vm', vmId)).catch(() => {})
      }
      this.notifyCapacity()
    }
    return cleared
  }

  releaseSticky(bound, stickyKey, stickyKeys) {
    const keys = Array.isArray(stickyKeys) && stickyKeys.length ? stickyKeys : stickyKey ? [stickyKey] : []
    for (const key of keys) this.stickyRouter?.unbind?.(key)
    if (bound?.vmId && this.schedulerRuntime?.deleteSticky) {
      void this.schedulerRuntime.deleteSticky({ node_key: formatNodeKey('claude_vm', bound.vmId) }).catch(() => {})
    }
  }

  releaseAccountSessions({ accountId = null, vmId = null } = {}) {
    if (!accountId && !vmId) return 0
    if (vmId && this.schedulerRuntime?.deleteSticky) {
      void this.schedulerRuntime.deleteSticky({ node_key: formatNodeKey('claude_vm', vmId) }).catch(() => {})
    }
    return this.stickyRouter?.unbindByAccount?.({ accountId, vmId }) || 0
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
    const previous = this.config
    this.config = normalizePoolConfig(config)
    this.notifyCapacity()
    if (this.schedulerRuntime?.syncConfigNow) {
      void this.schedulerRuntime.syncConfigNow('pool_reload_config').catch(() => {})
    }
    if (
      previous.max_primary_sessions !== this.config.max_primary_sessions ||
      previous.max_subagents_per_session !== this.config.max_subagents_per_session
    ) {
      this.signalChange()
    }
  }

  cragSeatOverQuota(vm, health) {
    if (!this.projectRoot) return false
    const liveCrag = health?.runtime_variant === 'crag-v2' || (!health?.runtime_variant && health?.dataplane === 'crag')
    const target = liveCrag ? { ...vm, dataplane: 'crag' } : vm
    return checkCragLicense(this.projectRoot, target, this.getRouting()).code === 'license_crag_host_over_quota'
  }

  noteKernelSlotBusy(selected) {
    const lease = selected?.kernelLease
    if (!lease) return
    this.kernelLeaseStats.noteSlotBusy({ ...lease, vmId: selected.vmId })
  }

  kernelLeaseSnapshot() {
    return { mode: this.config.kernel_lease || 'off', ...this.kernelLeaseStats.snapshot() }
  }

  bumpInflight(accountId, vmId, delta) {
    if (accountId) {
      const nextAcc = Math.max(0, (this.inflight.get(accountId) || 0) + delta)
      if (nextAcc === 0) this.inflight.delete(accountId)
      else this.inflight.set(accountId, nextAcc)
    }
    this.bumpVmInflight(vmId, delta)
  }

  bumpVmInflight(vmId, delta) {
    if (!vmId) return
    const id = String(vmId)
    const next = Math.max(0, (this.vmInflight.get(id) || 0) + delta)
    if (next === 0) this.vmInflight.delete(id)
    else this.vmInflight.set(id, next)
    this.signalChange()
  }

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
  }

  notifyCapacity() {
    if (this.schedulerRuntime?.pushTelemetryNow) {
      void this.schedulerRuntime.pushTelemetryNow().catch(() => {})
    }
    this.signalChange()
  }

  syncQuotaSchedule(vm, account = null, state = undefined) {
    if (!this.projectRoot || !vm?.id) return { action: 'keep', reason: null }
    const accountId = account?.account_id || vm.claude?.account_uuid || vm.id
    account = account || this.accountQuota?.repo?.get?.(accountId) || null
    if (!account) return { action: 'keep', reason: null }
    const now = Date.now()
    const lastUsedAt = this.lastUsed.get(accountId) || account.last_used_at || 0
    const runtimeWorkerStatus = state?.worker_status || account.worker_status || null
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
      workerLastError: runtimeWorkerStatus?.last_error || vm.claude?.refresh_error,
      refreshError: vm.claude?.refresh_error,
      expiresAt: vm.claude?.expires_at || vm.expires_at || null,
      refreshedAt: vm.claude?.refreshed_at || vm.refreshed_at || null,
      workerCredential: state?.worker_status?.credential || account.worker_status?.credential || null,
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
    this.schedulerRuntime?.enqueueTelemetry?.([
      {
        node_key: formatNodeKey('claude_vm', vm.id),
        schedulable: false,
        unschedulable_reason: reason || 'quota_restricted',
      },
    ])
  }

  clearQuotaRestriction(vm, accountId, file, state = undefined) {
    if (state === undefined) state = this.runtimeRepo?.get?.(accountId)
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
    this.schedulerRuntime?.enqueueTelemetry?.([
      {
        node_key: formatNodeKey('claude_vm', vm.id),
        schedulable: true,
        unschedulable_reason: null,
      },
    ])
    return true
  }

  snapshot() {
    const seat = this.seatSnapshot()
    return {
      engine: 'rust',
      strategy: this.config.strategy,
      fable_max_per_account: this.config.fable_max_per_account,
      inflight: Object.fromEntries(this.inflight),
      inflight_family: {},
      waiters: {},
      health_cache: Object.fromEntries([...this.healthCache].map(([id, entry]) => [id, entry.value])),
      seats: seat.seats,
      pool_queue: { global_queue_depth: seat.global_queue_depth, queue_max: seat.queue_max },
    }
  }

  seatSnapshot() {
    const seats = {}
    for (const [vmId, count] of this.vmInflight) {
      let limits = null
      try {
        const vm = this.projectRoot ? getVm(this.projectRoot, vmId) : null
        limits = vm ? familyLimitsOf(vm, this.config) : null
      } catch {}
      seats[vmId] = {
        seats_used: count,
        seats_max: limits?.seats ?? 0,
        seats_grace: 0,
        queue_depth: 0,
        conc_waiting: 0,
        inflight: count,
        sessions: [],
      }
    }
    return { seats, global_queue_depth: 0, queue_max: this.config.queue_max }
  }
}
