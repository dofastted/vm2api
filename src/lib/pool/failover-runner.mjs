import {
  classifyUpstreamResult,
  isFableModel,
  repairAnthropicRequest,
  shouldContinue,
} from './upstream-error-policy.mjs'
import { listQuotaFromHeaders } from './quota-window.mjs'
import { flattenSearchResultHistory, searchHistoryFingerprint } from '../protocol/request-rectifier.mjs'
import {
  CLIENT_POOL_BUSY_MESSAGE,
  CLIENT_POOL_RATE_LIMITED_MESSAGE,
  clientCancelledResult,
  isClientCancelledResult,
  isCompleteAssistantMessage,
  isIncompleteAssistantMessage,
  incompleteAssistantClientError,
  KERNEL_FAILURE_STATUS,
} from '../core/errors.mjs'
import { hasRefreshPresence, readWorkerCredentialFile } from '../oauth/oauth-credentials.mjs'
import { ensureWorkerCredential } from '../transport/go-worker-client.mjs'
import { resolveOfficialCcInference } from '../vm/slot-engine.mjs'
import { AttemptCoordinator } from './unit-decision.mjs'
import { SOFT_COOLDOWN_REASONS } from './pool-scheduler.mjs'

// Seat wait for the one-shot repair hop when the rejected hop already spent the deadline.
const REPAIR_HOP_WAIT_MS = 30_000
const SEARCH_REPAIR_IDLE_MS = 60 * 60 * 1000
const SEARCH_REPAIR_LIMIT = 512

const DEFAULTS = {
  max_account_switches: 10,
  max_total_attempts: 12,
  total_retry_deadline_ms: 120000,
  // Same-session serialization waits out the previous turn. Cap a wedged tail
  // so the queue cannot sit forever. 0 disables the cap. Long enough that a
  // normal generation still runs serially; keepalive covers the Cloudflare wait.
  session_queue_timeout_ms: 900_000,
  delivery_mode: 'realtime',
  max_same_account_retries: 1,
  same_account_retry_delay_ms: 500,
  same_account_retry_max_hop_ms: 10_000,
  signature_repair: false,
}

function clone(value) {
  return structuredClone(value)
}

function searchRepairKey(stickyKey, model, selected) {
  if (!stickyKey || !selected?.accountId || !selected?.vmId) return null
  return JSON.stringify([stickyKey, selected.accountId, selected.vmId, model, credentialStamp(selected)])
}

function usageOf(result) {
  return result?.usage || result?.body?.usage || null
}

function verifiedSuccess(result) {
  return !!result?.ok && result?.terminalState === 'verified' && isCompleteAssistantMessage(result)
}

function uniqueStickyKeys(stickyKey, stickyKeys) {
  const out = []
  for (const key of [stickyKey, ...(Array.isArray(stickyKeys) ? stickyKeys : [])]) {
    if (!key || out.includes(key)) continue
    out.push(key)
  }
  return out
}

function poolError(code, message, details = {}) {
  return {
    ok: false,
    status: 503,
    via: 'pool-failover',
    terminalState: 'exhausted',
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        code,
        message,
        details,
      },
    },
  }
}

/**
 * Real capacity exhaustion: every eligible seat stayed busy until the wait ran
 * out, or the pool queue was full. Anthropic's 529 `overloaded_error`, always
 * with a Retry-After: the planner's earliest seat release, else the soonest
 * known wake (cooldown / RPM / window reset), floored at 1s.
 */
export function poolOverloadedError(details = {}) {
  const retryMs = Number(details.retry_after_ms ?? details.soonest_available_ms)
  return {
    ok: false,
    status: 529,
    via: 'pool-failover',
    terminalState: 'exhausted',
    retryAfterSec: Number.isFinite(retryMs) && retryMs > 0 ? Math.max(1, Math.ceil(retryMs / 1000)) : 1,
    body: {
      type: 'error',
      error: {
        type: 'overloaded_error',
        code: 'pool_overloaded',
        message: CLIENT_POOL_BUSY_MESSAGE,
        details,
      },
    },
  }
}

const CAPACITY_SELECTION_REASONS = new Set([
  'all_accounts_busy',
  'pool_wait_queue_full',
  'pool_queue_timeout',
  'pool_overload_cooldown',
])

/**
 * Every remaining account sits in an upstream 429 rate-limit cooldown. The
 * caller hit the provider's limit, so this is a 429 with the earliest reset.
 */
function poolRateLimitedError(details = {}) {
  const retryMs = Number(details.retry_after_ms ?? details.soonest_available_ms)
  return {
    ok: false,
    status: 429,
    via: 'pool-failover',
    terminalState: 'exhausted',
    retryAfterSec: Number.isFinite(retryMs) && retryMs > 0 ? Math.max(1, Math.ceil(retryMs / 1000)) : 1,
    body: {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        code: 'pool_rate_limited',
        message: CLIENT_POOL_RATE_LIMITED_MESSAGE,
        details,
      },
    },
  }
}

function fableRequiresMaxError(details = {}) {
  return {
    ok: false,
    status: 429,
    via: 'pool-failover',
    terminalState: 'exhausted',
    body: {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        code: 'fable_requires_max',
        message: 'Fable requires an available Max account',
        details,
      },
    },
  }
}

const QUOTA_GUARD_TOO_LARGE_MESSAGE =
  '临近额度闸线，本请求预估未命中缓存过大，未发往上游。请缩短上下文、等待窗口重置，或稍后再试。'

function quotaGuardTooLargeError(details = {}) {
  return {
    ok: false,
    status: 429,
    via: 'pool-failover',
    terminalState: 'exhausted',
    body: {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        code: 'quota_guard_request_too_large',
        message: QUOTA_GUARD_TOO_LARGE_MESSAGE,
        details: {
          ...details,
          message_en:
            'Near the quota safety line, this request looks like a large uncached prompt and was not sent upstream.',
        },
      },
    },
  }
}

function selectedHasRefresh(selected) {
  if (selected?.hasRefresh === true || selected?.hasRefresh === false) return selected.hasRefresh
  const cred = selected?.workerStatus?.credential || selected?.state?.worker_status?.credential || {}
  return hasRefreshPresence(selected?.vm?.claude) || !!selected?.vm?.has_refresh || !!cred.has_refresh
}

function credentialStamp(selected) {
  return (
    selected?.workerStatus?.credential?.generation ??
    selected?.state?.credential_generation ??
    selected?.vm?.claude?._token_version ??
    selected?.vm?.claude?.expires_at ??
    null
  )
}

function priorAuth401Stamp(selected) {
  return selected?.vm?.claude?.oauth_401_generation ?? selected?.state?.worker_status?.oauth_401_generation ?? null
}

function signatureRepairEnabled(config) {
  return config.signature_repair === true
}

function selectedUsage(selected, accountQuota = null) {
  const account = selected?.account || accountQuota?.repo?.get?.(selected?.accountId)
  const unified = account?.unified
  if (!unified) return null
  return listQuotaFromHeaders(unified)
}

function classifyAttempt(
  result,
  selected,
  { model, repaired, oauth401CooldownMs, signatureRepair },
  accountQuota = null,
) {
  return classifyUpstreamResult(result, {
    model,
    repaired,
    hasRefresh: selectedHasRefresh(selected),
    oauth401CooldownMs,
    credentialGeneration: credentialStamp(selected),
    priorAuth401Generation: priorAuth401Stamp(selected),
    signatureRepair,
    usage: selectedUsage(selected, accountQuota),
  })
}

function notifyProxyFailure(onProxyFailure, selected, policy) {
  if (policy?.reason !== 'proxy_transport_failure') return
  if (typeof onProxyFailure !== 'function') return
  try {
    onProxyFailure(selected?.vmId, policy.reason)
  } catch {
    /* control-plane disconnect is best-effort */
  }
}

function sleepWithSignal(ms, signal) {
  const delay = Number(ms) || 0
  if (delay <= 0) {
    if (signal?.aborted) {
      return Promise.reject(Object.assign(new Error('Request was cancelled'), { code: 'selection_cancelled' }))
    }
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, delay)
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('Request was cancelled'), { code: 'selection_cancelled' }))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function waitForSessionTurn(previous, signal, timeoutMs) {
  const timeout = Number(timeoutMs)
  const bounded = Number.isFinite(timeout) && timeout > 0
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error('Request was cancelled'), { code: 'request_cancelled' }))
  }
  if (!signal && !bounded) return previous.catch(() => {})
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener?.('abort', onAbort)
      if (timer) clearTimeout(timer)
      fn(value)
    }
    const onAbort = () => {
      finish(reject, Object.assign(new Error('Request was cancelled'), { code: 'request_cancelled' }))
    }
    const onTimeout = () => {
      finish(reject, Object.assign(new Error('Session queue timed out'), { code: 'session_queue_timeout' }))
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    if (bounded) {
      // Keep the timer referenced. An unref'd wait looks idle to the process,
      // and the queued request is still in flight until it times out or runs.
      timer = setTimeout(onTimeout, timeout)
    }
    previous.catch(() => {}).then(() => finish(resolve))
  })
}

/** The kernel named why the hop failed: report that, not a generic incomplete. */
function hasKernelFailureCode(result) {
  return Object.hasOwn(KERNEL_FAILURE_STATUS, String(result?.body?.error?.code || ''))
}

function isUnfinishedLastResult(result, policy) {
  if (!result) return false
  if (policy?.reason === 'incomplete_assistant') return true
  if (hasKernelFailureCode(result)) return false
  if (result.terminalState === 'incomplete') return true
  return isIncompleteAssistantMessage(result)
}

function preferLastResult(lastResult, lastPolicy, fallback, extras = {}) {
  if (isClientCancelledResult(lastResult)) {
    return { ...clientCancelledResult(lastResult), via: lastResult.via || 'pool-failover', ...extras }
  }
  if (!lastResult) return { ...fallback, ...extras }
  if (isUnfinishedLastResult(lastResult, lastPolicy)) {
    return {
      ...incompleteAssistantClientError(lastResult),
      via: lastResult.via || 'pool-failover',
      finalState: 'incomplete',
      policy: lastPolicy || lastResult.policy,
      ...extras,
    }
  }
  return {
    ...lastResult,
    via: lastResult.via || 'pool-failover',
    finalState: lastResult.finalState || lastResult.terminalState || 'exhausted',
    policy: lastPolicy || lastResult.policy,
    ...extras,
  }
}

function permanentOAuthRevoke(policy) {
  return {
    ...policy,
    scope: 'account',
    action: 'continue-and-cooldown',
    reason: 'oauth_revoked',
    cooldownUntil: Number.MAX_SAFE_INTEGER,
    retrySameAccount: false,
  }
}

function isCredentialDeath(policy) {
  return policy?.action === 'disable' || policy?.reason === 'oauth_no_refresh' || policy?.reason === 'oauth_revoked'
}

/** Empty / thinking-only hop: replayable on another seat. Never a restart signal. */
function isRetryableEmptyHop(policy) {
  return policy?.reason === 'incomplete_assistant' || policy?.reason === 'empty_response'
}

/** The kernel said this job is still held: replaying would run it twice. */
function emptyHopReleased(result) {
  if (!result || result.committed) return false
  if (result.transportError === true) return false
  if (result.jobHeld === true || result.executionReleased === false) return false
  return true
}

/** Hidden transport / credential retries inside one hop still spend that unit's budget. */
function executionsOf(result) {
  if (result?.upstreamExecutions === 0) return 0
  return 1 + (result?.rust_transport_retried ? 1 : 0) + (result?.credential_retried ? 1 : 0)
}

function incompleteHopResult(result, policy, extras = {}) {
  const failed = hasKernelFailureCode(result) ? { ...result, ok: false } : incompleteAssistantClientError(result)
  return {
    ...failed,
    via: result?.via || 'pool-failover',
    finalState: 'incomplete',
    policy,
    ...extras,
  }
}

/** Selection found no seat. Busy until the wait ran out is capacity; nothing eligible is not. */
function selectionFailure(selected, { excluded, lastPolicy, lastResult, hops }) {
  const reason = selected?.reason || 'no_eligible_accounts'
  const details = {
    excluded_accounts: [...excluded],
    reason,
    wait_ms: selected?.waitMs ?? selected?.wait_ms ?? 0,
    soonest_available_ms: selected?.soonest_available_ms ?? null,
    retry_after_ms: selected?.retry_after_ms ?? null,
    wait_reasons: selected?.wait_reasons || [],
    eligible: selected?.eligible ?? 0,
    available: selected?.available ?? 0,
    sticky_cleared: !!selected?.sticky_cleared,
    attempt_count: hops,
    last_reason: lastPolicy?.reason || null,
    last_status: lastResult?.status ?? null,
  }
  if (CAPACITY_SELECTION_REASONS.has(reason)) return poolOverloadedError(details)
  if (reason === 'pool_rate_limited') return poolRateLimitedError(details)
  if (reason === 'quota_guard_request_too_large') return quotaGuardTooLargeError(details)
  const failed = poolError('account_pool_exhausted', 'No eligible Claude accounts remain', details)
  // An all-rest pool knows when the first working window opens.
  const retryMs = Number(details.retry_after_ms)
  if (retryMs > 0) failed.retryAfterSec = Math.max(1, Math.ceil(retryMs / 1000))
  return failed
}

function applyCooldown(scheduler, selected, policy, model, { diagnosticPin = false } = {}) {
  if (policy?.action !== 'continue-and-cooldown' && policy?.action !== 'disable' && policy?.action !== 'pause') return
  // VM / master pin is a diagnostic. A 401 from the wrong inbound class
  // must not forever-park a Setup Token that has no refresh by design.
  if (diagnosticPin && (policy.reason === 'oauth_no_refresh' || policy.reason === 'oauth_revoked')) {
    return
  }
  scheduler.markCooldown(selected, {
    until:
      policy.action === 'disable' || policy.reason === 'oauth_no_refresh' || policy.reason === 'oauth_revoked'
        ? Number.MAX_SAFE_INTEGER
        : policy.cooldownUntil,
    reason: policy.reason,
    model: policy.scope === 'model' ? policy.model || model : null,
    status:
      policy.action === 'disable' || policy.reason === 'oauth_no_refresh' || policy.reason === 'oauth_revoked'
        ? 'disabled'
        : 'cooldown',
  })
  // A 5xx pause, an RPM cooldown, or an unproven bare 429 keeps the
  // conversation pin: other seats absorb this turn. Quota and auth move
  // every conversation off the unit, windows included (#163).
  if (policy.scope === 'account' && policy.action !== 'pause' && !SOFT_COOLDOWN_REASONS.has(policy.reason)) {
    scheduler.releaseAccountSessions?.({ accountId: selected?.accountId, vmId: selected?.vmId })
  }
}

export class FailoverRunner {
  constructor({
    scheduler,
    stickyRouter = null,
    attemptsRepo = null,
    rateLimitService = null,
    config = {},
    onProxyFailure = null,
    onCredentialFailure = null,
    onFablePlanDenied = null,
    onFableSuccess = null,
  } = {}) {
    this.scheduler = scheduler
    this.stickyRouter = stickyRouter
    this.attemptsRepo = attemptsRepo
    this.rateLimitService = rateLimitService
    this.config = { ...DEFAULTS, ...(config || {}) }
    this.onProxyFailure = onProxyFailure
    this.onCredentialFailure = onCredentialFailure
    this.onFablePlanDenied = onFablePlanDenied
    this.onFableSuccess = onFableSuccess
    this.sessionTails = new Map()
    this.searchRepairs = new Map()
  }

  reloadConfig(config = {}) {
    this.config = { ...DEFAULTS, ...(config || {}) }
  }

  noteUnitHealth(selected, policy, result) {
    const circuit = this.scheduler?.unitCircuit
    if (!circuit || !selected?.accountId) return
    if (policy?.circuit) circuit.recordFailure(selected.accountId)
    else if (verifiedSuccess(result)) circuit.recordSuccess(selected.accountId)
    else circuit.releaseProbe?.(selected.accountId)
  }

  /**
   * An empty hop leaves the outbound session behind for a fresh-session retry.
   * Client cancellation only ends its job; kernel cancel_ack fences slot reuse.
   * Planner seat indexes are not kernel native slots.
   */
  retireOutboundSession(selected, bindKeys) {
    if (!selected?.vmId) return
    for (const key of bindKeys || []) {
      const bound = this.stickyRouter?.resolve?.(key)
      if (bound?.accountId !== selected.accountId) continue
      this.stickyRouter?.bind?.(
        key,
        { accountId: selected.accountId, vmId: selected.vmId },
        { countHit: false, replaceSession: true, clearSlot: true },
      )
    }
  }

  async recoverCredential(selected, policy) {
    if (policy?.reason !== 'oauth_refresh_required') return policy
    const exec = selected?.exec
    if (!exec?.homeDir) return permanentOAuthRevoke(policy)
    const before = readWorkerCredentialFile(exec.homeDir)
    const beforeRefresh = String(before?.refresh_token || '')
    let refreshed
    try {
      refreshed = await ensureWorkerCredential(exec, { force: true })
    } catch (error) {
      refreshed = { ok: false, error: { message: String(error?.message || error) } }
    }
    const after = readWorkerCredentialFile(exec.homeDir)
    const afterRefresh = String(after?.refresh_token || '')
    const blob = `${refreshed?.error?.code || ''} ${refreshed?.error?.message || ''} ${refreshed?.refresh_class || ''}`
    const grantDead = /invalid_grant|token has been revoked|oauth_revoked/i.test(blob)
    if (!refreshed?.ok && grantDead && afterRefresh === beforeRefresh) return permanentOAuthRevoke(policy)
    if (refreshed?.ok || (beforeRefresh && afterRefresh && afterRefresh !== beforeRefresh)) {
      return { ...policy, retrySameAccount: true, action: 'continue', cooldownUntil: null }
    }
    return {
      ...policy,
      retrySameAccount: false,
      action: 'continue',
      reason: 'oauth_refresh_failed',
      cooldownUntil: null,
    }
  }

  forgetCredential(selected, policy, { familyKey = null, sessionKeys = [] } = {}) {
    if (familyKey) {
      this.scheduler.releaseSticky?.(selected, null, sessionKeys)
    } else {
      this.scheduler.releaseAccountSessions?.({ accountId: selected?.accountId, vmId: selected?.vmId })
    }
    if (typeof this.onCredentialFailure === 'function') {
      try {
        this.onCredentialFailure({ selected, policy })
      } catch {}
    }
  }

  async run(args = {}) {
    const sessionKey = String(args.stickyKey || '')
    if (!sessionKey) return this.runOnce(args)
    const previous = this.sessionTails.get(sessionKey) || Promise.resolve()
    let releaseTurn
    const turn = new Promise((resolve) => {
      releaseTurn = resolve
    })
    const tail = previous.catch(() => {}).then(() => turn)
    this.sessionTails.set(sessionKey, tail)
    try {
      await waitForSessionTurn(previous, args.signal, this.config.session_queue_timeout_ms)
      return await this.runOnce(args)
    } catch (error) {
      if (error?.code === 'request_cancelled') return clientCancelledResult()
      if (error?.code === 'session_queue_timeout') {
        const retryMs = Number(this.config.session_queue_timeout_ms)
        return poolOverloadedError({
          reason: 'session_queue_timeout',
          retry_after_ms: Number.isFinite(retryMs) && retryMs > 0 ? retryMs : 1000,
        })
      }
      throw error
    } finally {
      releaseTurn()
      // Drop the chain only after this tail settles. A timeout or cancel
      // releases our turn early, while the holder is still running; deleting
      // immediately would let the next request overlap that holder.
      const drop = () => {
        if (this.sessionTails.get(sessionKey) === tail) this.sessionTails.delete(sessionKey)
      }
      tail.then(drop, drop)
    }
  }

  async runOnce({
    requestId,
    canonicalBody,
    model,
    stickyKey = null,
    stickyKeys = null,
    seatKey = null,
    stickyDeviceId = null,
    stream = false,
    deliveryMode = null,
    signal,
    applyAttempt,
    callAttempt,
    onAttempt = null,
    pinVmId = null,
    familyKey = null,
    familyVmId = null,
    deviceKey = null,
    skipSessionSeat = false,
    ownerScope = null,
    keyScope = null,
    countUsage = true,
    quotaRequest = null,
  } = {}) {
    if (!this.scheduler) throw new Error('FailoverRunner requires a scheduler')
    if (typeof callAttempt !== 'function') throw new Error('FailoverRunner requires callAttempt')
    const startedAt = Date.now()
    const budget = new AttemptCoordinator({
      maxSameUnitRetries: Number(this.config.max_same_account_retries ?? 1),
      maxUnitSwitches: Number(this.config.max_account_switches ?? 10),
      maxTotalAttempts: Number(this.config.max_total_attempts ?? 12),
      deadlineMs: Number(this.config.total_retry_deadline_ms || 120000),
      startedAt,
    })
    const deadline = budget.deadline
    const excluded = budget.excluded
    // Accounts left only because the kernel had no free slot; their pins stay.
    const spilled = budget.spilled
    const bindKeys = uniqueStickyKeys(stickyKey, stickyKeys)
    const pinKeys = familyKey ? [...bindKeys, familyKey] : bindKeys
    // Pins as this request last saw them. A pin moved by someone else since
    // (quota migration, credential death) is never written back by a late hop.
    const pinBaseline = new Map()
    const snapshotPins = () => {
      for (const key of pinKeys) pinBaseline.set(key, this.stickyRouter?.resolve?.(key) || null)
    }
    const pinMoved = (key) => {
      const base = pinBaseline.get(key)
      if (!base) return false
      const now = this.stickyRouter?.resolve?.(key)
      return !now || now.accountId !== base.accountId || (now.generation || 0) !== (base.generation || 0)
    }
    let freshSlot = false
    // The seat moved VMs on failover: device affinity follows it.
    let seatMovedTo = null
    let outboundSessionId = ''
    let outboundSessionAccountId = ''
    let currentDeviceVmId = null
    let pinnedSlot = null
    let lastSelected = null
    const attribution = () => ({
      accountId: lastSelected?.accountId,
      vmId: lastSelected?.vmId,
      attemptCount: budget.hops,
    })
    const bindAll = (account, opts) => {
      if (!this.stickyRouter || !account) return
      const sessionId = account.sessionId || (account.accountId === outboundSessionAccountId ? outboundSessionId : '')
      const payload = { accountId: account.accountId, vmId: account.vmId }
      const slotIndex = account.slotIndex != null ? account.slotIndex : pinnedSlot
      if (slotIndex != null) payload.slotIndex = slotIndex
      if (sessionId) payload.sessionId = sessionId
      if (stickyDeviceId) payload.deviceId = stickyDeviceId
      if (this.stickyRouter.bind) {
        for (const key of bindKeys) {
          if (pinMoved(key)) continue
          const prev = this.stickyRouter.resolve?.(key)
          // A live pin on another account means this request only borrowed
          // capacity. Rewriting it would move the whole session off its home.
          if (prev?.accountId && prev.accountId !== account.accountId) continue
          let guard = opts
          if (prev) guard = { ...opts, ifGeneration: prev.generation || 0 }
          if (freshSlot || opts?.replaceSession) guard = { ...guard, replaceSession: true }
          this.stickyRouter.bind(key, payload, guard)
          pinBaseline.set(key, this.stickyRouter.resolve?.(key) || null)
        }
      }
      if (familyKey && account.vmId && !pinMoved(familyKey)) {
        this.stickyRouter.bind?.(familyKey, { accountId: account.accountId, vmId: account.vmId }, { countHit: false })
        pinBaseline.set(familyKey, this.stickyRouter.resolve?.(familyKey) || null)
      }
      if (
        deviceKey &&
        account.vmId &&
        (!currentDeviceVmId || currentDeviceVmId === account.vmId || seatMovedTo === account.vmId)
      ) {
        const devicePayload = { accountId: account.accountId, vmId: account.vmId }
        if (this.stickyRouter.bindDeviceAffinity) {
          this.stickyRouter.bindDeviceAffinity(deviceKey, devicePayload, { countHit: false })
        } else {
          this.stickyRouter.bind?.(deviceKey, devicePayload, { countHit: false })
        }
      }
    }
    let lastResult = null
    let lastPolicy = null
    let repaired = false
    // The repaired body is the known fix and has not been sent yet; a slow
    // rejected hop (a 400 can take minutes on a long transcript) must not
    // turn it into the client's error. Bounded: repair is one-shot.
    let repairPending = false
    let requestBody = clone(canonicalBody)
    let searchRepair = null
    let searchFingerprint
    const fingerprint = () => {
      if (searchFingerprint === undefined) searchFingerprint = searchHistoryFingerprint(canonicalBody)
      return searchFingerprint
    }
    // A unit that just failed replayably waits behind every other free seat.
    let avoid = null

    for (;;) {
      const attemptNo = budget.hops + 1
      if (signal?.aborted || isClientCancelledResult(lastResult)) {
        return { ...clientCancelledResult(lastResult || {}), via: 'pool-failover', ...attribution() }
      }
      if (!repairPending && Date.now() >= deadline) {
        return preferLastResult(
          lastResult,
          lastPolicy,
          // With no hop yet the whole budget went to waiting for a seat: capacity.
          poolOverloadedError({
            reason: 'pool_deadline_exceeded',
            attempt_count: budget.hops,
            last_scope: lastPolicy?.scope || null,
          }),
          attribution(),
        )
      }
      let selected = null
      try {
        currentDeviceVmId = deviceKey ? this.stickyRouter?.resolve?.(deviceKey)?.vmId || null : null
        const selectArgs = {
          model,
          stickyKey,
          stickyKeys: bindKeys,
          seatKey,
          excluded,
          spilled,
          signal,
          deadline: repairPending ? Math.max(deadline, Date.now() + REPAIR_HOP_WAIT_MS) : deadline,
          pinVmId,
          familyVmId,
          deviceVmId: currentDeviceVmId,
          skipSessionSlot: skipSessionSeat,
          ownerScope,
          keyScope,
          quotaRequest: {
            body: requestBody,
            sessionId: outboundSessionId || quotaRequest?.sessionId || stickyKey,
          },
        }
        if (avoid) {
          const elsewhere = await this.scheduler.selectAndReserve({ ...selectArgs, avoid, allowWait: false })
          avoid = null
          if (elsewhere?.ok) selected = elsewhere
          else await sleepWithSignal(this.config.same_account_retry_delay_ms, signal)
        }
        if (!selected) selected = await this.scheduler.selectAndReserve({ ...selectArgs, allowWait: true })
      } catch (error) {
        if (error?.code === 'selection_cancelled') {
          return { ...clientCancelledResult(), via: 'pool-failover', ...attribution() }
        }
        if (error?.code === 'pool_wait_queue_full') {
          return preferLastResult(
            lastResult,
            lastPolicy,
            poolOverloadedError({
              reason: 'pool_wait_queue_full',
              attempt_count: budget.hops,
              retry_after_ms: error.retryAfterMs ?? null,
            }),
            attribution(),
          )
        }
        throw error
      }
      if (selected?.familyGated && familyKey && familyVmId) {
        // The family home left the pool (quota, credential): the family moves
        // with the next bind. An exclusion this request made itself is not proof.
        const home = this.stickyRouter?.resolve?.(familyKey)
        const ownExclusion =
          !!home && (budget.tried.has(home.accountId) || budget.tried.has(home.vmId) || spilled.has(home.accountId))
        if (!ownExclusion) this.stickyRouter?.unbind?.(familyKey)
        familyVmId = null
      }
      if (!selected?.ok && selected?.reason === 'fable_requires_max') {
        return {
          ...fableRequiresMaxError({
            wait_ms: selected?.waitMs ?? selected?.wait_ms ?? 0,
            eligible: selected?.eligible ?? 0,
            available: selected?.available ?? 0,
            attempt_count: budget.hops,
          }),
          ...attribution(),
        }
      }
      if (!selected?.ok) {
        const exhausted = selectionFailure(selected, { excluded, lastPolicy, lastResult, hops: budget.hops })
        return preferLastResult(lastResult, lastPolicy, exhausted, attribution())
      }
      repairPending = false
      snapshotPins()
      const attemptStickyBound = pinBaseline.get(stickyKey) || null
      lastSelected = selected
      pinnedSlot = selected.slotIndex ?? null
      if (selected.seatMoved) seatMovedTo = selected.vmId
      bindAll({ accountId: selected.accountId, vmId: selected.vmId, slotIndex: pinnedSlot }, { countHit: false })
      const attemptStarted = Date.now()
      this.attemptsRepo?.begin?.({
        requestId,
        attemptNo,
        vmId: selected.vmId,
        accountId: selected.accountId,
        model,
        selectionReason: selected.selectionReason,
        waitMs: selected.waitMs,
      })
      let result
      let policy
      let committed = false
      let hopNoted = false
      const noteHop = (value) => {
        if (hopNoted) return
        hopNoted = true
        const executions = executionsOf(value)
        if (executions > 0) budget.noteHop(selected.accountId, selected.vmId, executions)
      }
      try {
        const repairKey = searchRepairKey(stickyKey, model, selected)
        const hint = this.searchRepairs.get(repairKey)
        if (hint && hint.expiresAt <= Date.now()) this.searchRepairs.delete(repairKey)
        const knownSearchRepair = hint && hint.expiresAt > Date.now() && hint.fingerprint === fingerprint()
        const attemptBody = knownSearchRepair ? flattenSearchResultHistory(requestBody) : requestBody
        const prepared =
          typeof applyAttempt === 'function'
            ? await applyAttempt(clone(attemptBody), selected, {
                attemptNo,
                repaired,
                attemptStartedAt: attemptStarted,
                freshSlot,
                stickyBound: attemptStickyBound,
              })
            : clone(attemptBody)
        const wrappedAttempt =
          prepared &&
          typeof prepared === 'object' &&
          Object.prototype.hasOwnProperty.call(prepared, 'body') &&
          Object.prototype.hasOwnProperty.call(prepared, 'meta')
        const body = wrappedAttempt ? prepared.body : prepared
        const attemptMeta = wrappedAttempt ? prepared.meta : null
        if (attemptMeta?.sessionId) {
          outboundSessionId = String(attemptMeta.sessionId)
          outboundSessionAccountId = selected.accountId
          bindAll(
            { accountId: selected.accountId, vmId: selected.vmId, sessionId: outboundSessionId },
            {
              countHit: false,
              // Prebinding moved the VM already; replace the previous VM's session.
              replaceSession: !!attemptStickyBound?.vmId && attemptStickyBound.vmId !== selected.vmId,
            },
          )
        }
        result = await callAttempt({
          candidate: selected,
          body,
          attemptMeta,
          attemptNo,
          stream,
          deliveryMode: deliveryMode || this.config.delivery_mode,
          signal,
          onCommit: () => {
            committed = true
          },
        })
        noteHop(result)
        if (result) result.committed = result.committed || committed
        if (signal?.aborted || isClientCancelledResult(result)) {
          this.attemptsRepo?.complete?.(requestId, attemptNo, {
            upstreamStatus: result?.status ?? null,
            errorScope: 'request',
            action: 'stop',
            downstreamCommitted: !!(result?.committed || committed),
            terminalState: 'cancelled',
            latencyMs: Date.now() - attemptStarted,
          })
          return { ...clientCancelledResult(result), via: result?.via || 'pool-failover', ...attribution() }
        }
        policy = classifyAttempt(
          result,
          selected,
          {
            model,
            repaired,
            oauth401CooldownMs: this.config.oauth_401_cooldown_ms,
            signatureRepair: signatureRepairEnabled(this.config),
          },
          this.scheduler?.accountQuota,
        )
        if (knownSearchRepair && policy.reason === 'search_repairable') {
          // Repeating the identical flatten cannot fix a second rejection.
          this.searchRepairs.delete(repairKey)
          policy = { ...policy, action: 'stop' }
        }
        // One writer for rate_limit_reset_at / overload_until (sub2api HandleUpstreamError).
        const hardBlock =
          !result?.committed && !pinVmId
            ? this.rateLimitService?.handleUpstreamError?.({
                accountId: selected.accountId,
                vmId: selected.vmId,
                result,
                policy,
              }) || null
            : null
        if (hardBlock?.until && policy.action === 'continue-and-cooldown' && policy.scope === 'account') {
          policy = { ...policy, cooldownUntil: hardBlock.until }
        }

        lastResult = result
        lastPolicy = policy
        this.noteUnitHealth(selected, policy, result)
        notifyProxyFailure(this.onProxyFailure, selected, policy)
        if (policy.reason === 'fable_plan_denied' && typeof this.onFablePlanDenied === 'function') {
          try {
            this.onFablePlanDenied({ selected, policy })
          } catch {}
        }
        const terminalState = result?.terminalState || (result?.ok ? 'unknown' : 'error')
        this.attemptsRepo?.complete?.(requestId, attemptNo, {
          upstreamStatus: result?.status ?? null,
          errorScope: policy.scope,
          action: policy.action,
          cooldownUntil: policy.cooldownUntil,
          downstreamCommitted: result?.committed || committed,
          terminalState,
          usage: usageOf(result),
          ttftMs: result?.ttftMs ?? null,
          latencyMs: Date.now() - attemptStarted,
        })
        if (typeof onAttempt === 'function') {
          await onAttempt({ attemptNo, selected, result, policy })
        }
        if (policy.reason === 'content_filter_refusal' || policy.reason === 'usage_policy_refusal') {
          this.scheduler.markSuccess(selected, { workerStatus: result.workerStatus || null, countUsage })
          bindAll({ accountId: selected.accountId, vmId: selected.vmId })
          return {
            ...result,
            ...attribution(),
            finalState: policy.reason === 'usage_policy_refusal' ? 'rejected' : 'content_filter',
            policy,
          }
        }
        if (verifiedSuccess(result)) {
          if (repairKey && (knownSearchRepair || searchRepair?.key === repairKey)) {
            this.searchRepairs.delete(repairKey)
            while (this.searchRepairs.size >= SEARCH_REPAIR_LIMIT) {
              this.searchRepairs.delete(this.searchRepairs.keys().next().value)
            }
            this.searchRepairs.set(repairKey, {
              fingerprint: fingerprint(),
              expiresAt: Date.now() + SEARCH_REPAIR_IDLE_MS,
            })
          }
          this.scheduler.markSuccess(selected, { workerStatus: result.workerStatus || null, countUsage })
          if (isFableModel(model) && typeof this.onFableSuccess === 'function') {
            try {
              this.onFableSuccess({ selected, model })
            } catch {}
          }
          bindAll({ accountId: selected.accountId, vmId: selected.vmId })
          return { ...result, ...attribution(), finalState: 'verified' }
        }
        if (policy.action === 'repair-and-retry' && !repaired && !result?.committed) {
          repaired = true
          repairPending = true
          if (policy.reason === 'search_repairable' && repairKey && fingerprint()) {
            searchRepair = { key: repairKey }
          }
          requestBody = repairAnthropicRequest(requestBody, policy)
          continue
        }
        applyCooldown(this.scheduler, selected, policy, model, { diagnosticPin: !!pinVmId })
        if (!pinVmId && isCredentialDeath(policy)) {
          this.forgetCredential(selected, policy, { familyKey, sessionKeys: bindKeys })
          if (familyKey) {
            return { ...result, ...attribution(), finalState: result?.terminalState || 'rejected', policy }
          }
        }
        if (!shouldContinue(policy)) {
          return { ...result, ...attribution(), finalState: result?.terminalState || 'rejected', policy }
        }
        policy = await this.recoverCredential(selected, policy)
        const hopMs = Date.now() - attemptStarted
        if (isRetryableEmptyHop(policy)) {
          if (!emptyHopReleased(result) || pinVmId) return incompleteHopResult(result, policy, attribution())
          this.retireOutboundSession(selected, bindKeys)
          freshSlot = true
        }
        if (budget.allowSameUnit(selected.accountId, policy, hopMs, this.config.same_account_retry_max_hop_ms)) {
          budget.noteSameUnit(selected.accountId)
          avoid = new Set([selected.accountId, selected.vmId])
          continue
        }
        budget.noteSwitch(selected.accountId, selected.vmId, { spill: policy.reason === 'slot_busy' })
      } catch (error) {
        const invalidCache = error?.status === 400 && error.body?.error?.code === 'invalid_cache_control'
        noteHop(invalidCache ? { upstreamExecutions: 0 } : null)
        if (error?.code === 'response_sent') {
          this.attemptsRepo?.complete?.(requestId, attemptNo, {
            upstreamStatus: 403,
            errorScope: 'request',
            action: 'stop',
            downstreamCommitted: true,
            terminalState: 'policy_block',
            latencyMs: Date.now() - attemptStarted,
          })
          return {
            ok: false,
            responseSent: true,
            status: 403,
            via: 'account-scope',
            vmId: selected.vmId,
            accountId: selected.accountId,
            attemptCount: attemptNo,
            finalState: 'policy_block',
          }
        }
        if (invalidCache) {
          this.attemptsRepo?.complete?.(requestId, attemptNo, {
            upstreamStatus: 0,
            errorScope: 'request',
            action: 'stop',
            downstreamCommitted: false,
            terminalState: 'invalid_request',
            latencyMs: Date.now() - attemptStarted,
          })
          return {
            ok: false,
            status: 400,
            body: error.body,
            terminalState: 'invalid_request',
            finalState: 'invalid_request',
            ...attribution(),
          }
        }
        if (signal?.aborted || error?.code === 'selection_cancelled' || error?.code === 'request_cancelled') {
          this.attemptsRepo?.complete?.(requestId, attemptNo, {
            upstreamStatus: 0,
            errorScope: 'request',
            action: 'stop',
            downstreamCommitted: !!committed,
            terminalState: 'cancelled',
            latencyMs: Date.now() - attemptStarted,
          })
          return { ...clientCancelledResult({ committed }), via: 'pool-failover', ...attribution() }
        }
        result = {
          ok: false,
          status: 0,
          transportError: true,
          committed,
          terminalState: committed ? 'incomplete' : 'transport_error',
          body: {
            type: 'error',
            error: {
              type: 'worker_error',
              code: error.code || 'attempt_failed',
              message: String(error.message || error).slice(0, 300),
            },
          },
        }
        policy = classifyAttempt(
          result,
          selected,
          {
            model,
            repaired,
            oauth401CooldownMs: this.config.oauth_401_cooldown_ms,
            signatureRepair: signatureRepairEnabled(this.config),
          },
          this.scheduler?.accountQuota,
        )
        lastResult = result
        lastPolicy = policy
        this.noteUnitHealth(selected, policy, result)
        notifyProxyFailure(this.onProxyFailure, selected, policy)
        this.attemptsRepo?.complete?.(requestId, attemptNo, {
          upstreamStatus: 0,
          errorScope: policy.scope,
          action: policy.action,
          cooldownUntil: policy.cooldownUntil,
          downstreamCommitted: committed,
          terminalState: result.terminalState,
          latencyMs: Date.now() - attemptStarted,
        })
        if (committed || !shouldContinue(policy)) {
          return { ...result, ...attribution(), finalState: result.terminalState, policy }
        }
        applyCooldown(this.scheduler, selected, policy, model, { diagnosticPin: !!pinVmId })
        if (!pinVmId && isCredentialDeath(policy)) {
          this.forgetCredential(selected, policy, { familyKey, sessionKeys: bindKeys })
          if (familyKey) {
            return { ...result, ...attribution(), finalState: result.terminalState, policy }
          }
        }
        policy = await this.recoverCredential(selected, policy)
        const hopMs = Date.now() - attemptStarted
        if (budget.allowSameUnit(selected.accountId, policy, hopMs, this.config.same_account_retry_max_hop_ms)) {
          budget.noteSameUnit(selected.accountId)
          avoid = new Set([selected.accountId, selected.vmId])
          continue
        }
        budget.noteSwitch(selected.accountId, selected.vmId, { spill: policy.reason === 'slot_busy' })
      } finally {
        selected.release?.()
      }
    }
  }
}
