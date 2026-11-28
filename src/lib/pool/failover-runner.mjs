import crypto from 'node:crypto'
import {
  classifyUpstreamResult,
  isFableModel,
  repairAnthropicRequest,
  shouldContinue,
} from './upstream-error-policy.mjs'
import { listQuotaFromHeaders } from './quota-window.mjs'
import { flattenSearchResultHistory, searchHistoryFingerprint } from '../protocol/request-rectifier.mjs'
import { MIN_THINKING_BUDGET } from '../protocol/thinking.mjs'
import {
  CLIENT_POOL_BUSY_MESSAGE,
  clientCancelledResult,
  extractErrorLogFields,
  isClientCancelledResult,
  isCompleteAssistantMessage,
  isIncompleteAssistantMessage,
  incompleteAssistantClientError,
  resolveLoggedErrorCode,
  ErrorCode,
  KERNEL_FAILURE_STATUS,
} from '../core/errors.mjs'
import { extractProviderCorrelation } from '../protocol/log-fields.mjs'
import { hasRefreshPresence, readWorkerCredentialFile } from '../oauth/oauth-credentials.mjs'
import { ensureWorkerCredential } from '../transport/go-worker-client.mjs'
import { kernelFaults } from '../transport/rust-kernel-client.mjs'
import { attachFailureDecision, AttemptCoordinator } from './unit-decision.mjs'
import { SOFT_COOLDOWN_REASONS } from './pool-scheduler.mjs'
import { PoisonRequestGuard } from './poison-request-guard.mjs'
import { inferRateLimitWindow } from './rate-limit-service.mjs'
import { PLATFORM_SCOPE } from '../admin/resource-owner.mjs'
import {
  SchedulerApiError,
  SchedulerUnavailableError,
  VIRTUAL_POOL_IDS,
  classifyErrorClass,
  formatNodeKey,
  formatSchedulerError,
  inferModelFamily,
} from '../scheduler/scheduler-runtime.mjs'

const SEARCH_REPAIR_IDLE_MS = 60 * 60 * 1000
const SEARCH_REPAIR_LIMIT = 512

// A slot whose kernel is healthy but whose inference keeps hanging trips the
// timeout circuit again right after the watchdog clears it. The first trip
// stays short (one watchdog tick) so a pool-wide upstream stall cannot park
// every slot; a repeat within the window holds the fault 15/30/60 minutes.
const TIMEOUT_TRIP_WINDOW_MS = 2 * 60 * 60_000
const TIMEOUT_HOLD_BASE_MS = 15 * 60_000
const TIMEOUT_HOLD_MAX_MS = 60 * 60_000

export const vmTimeoutTracker = {
  counts: new Map(),
  trips: new Map(),
  recordTimeout(vmId, threshold = 3) {
    if (!vmId) return false
    const entry = this.counts.get(vmId) || { count: 0, lastAt: 0 }
    entry.count += 1
    entry.lastAt = Date.now()
    this.counts.set(vmId, entry)
    return entry.count >= threshold
  },
  /** The circuit opened for this VM: remember when, for the repeat-trip hold. */
  recordTrip(vmId, now = Date.now()) {
    if (!vmId) return 0
    const recent = (this.trips.get(vmId) || []).filter((at) => now - at < TIMEOUT_TRIP_WINDOW_MS)
    recent.push(now)
    this.trips.set(vmId, recent)
    return recent.length
  },
  tripCount(vmId, now = Date.now()) {
    if (!vmId) return 0
    const recent = (this.trips.get(vmId) || []).filter((at) => now - at < TIMEOUT_TRIP_WINDOW_MS)
    if (recent.length) this.trips.set(vmId, recent)
    else this.trips.delete(vmId)
    return recent.length
  },
  faultHoldUntil(vmId, now = Date.now()) {
    const recent = (this.trips.get(vmId) || []).filter((at) => now - at < TIMEOUT_TRIP_WINDOW_MS)
    if (recent.length < 2) return 0
    const holdMs = Math.min(TIMEOUT_HOLD_MAX_MS, TIMEOUT_HOLD_BASE_MS * 2 ** (recent.length - 2))
    return recent[recent.length - 1] + holdMs
  },
  recordSuccess(vmId) {
    if (!vmId) return
    this.counts.delete(vmId)
    this.trips.delete(vmId)
  },
  reset(vmId) {
    if (vmId) this.counts.delete(vmId)
    else {
      this.counts.clear()
      this.trips.clear()
    }
  },
}

export const TIMEOUT_FAULT_PREFIX = 'consecutive_timeouts:'

const OPAQUE_429_THRESHOLD = 3
const OPAQUE_429_COOLDOWN_MS = 60_000

export const opaque429Tracker = {
  counts: new Map(),
  key(accountId, model) {
    return `${accountId || ''}\u0000${model || ''}`
  },
  record(accountId, model, threshold = OPAQUE_429_THRESHOLD) {
    if (!accountId) return false
    const key = this.key(accountId, model)
    const count = (this.counts.get(key) || 0) + 1
    this.counts.set(key, count)
    return count >= threshold
  },
  streak(accountId, model) {
    return this.counts.get(this.key(accountId, model)) || 0
  },
  clear(accountId, model) {
    if (!accountId) return
    this.counts.delete(this.key(accountId, model))
  },
  reset() {
    this.counts.clear()
  },
}

function opaque429Setting(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

const CIRCUIT_DEDUPE_TTL_MS = 10 * 60_000
const CIRCUIT_DEDUPE_MAX_ENTRIES = 5000

export const sessionCircuitDedupe = {
  seen: new Map(),
  key(sessionKey, accountId) {
    return `${sessionKey}\u0000${accountId}`
  },
  shouldCount(sessionKey, accountId, now = Date.now()) {
    if (!sessionKey || !accountId) return true
    const key = this.key(sessionKey, accountId)
    const last = this.seen.get(key)
    if (last != null && now - last < CIRCUIT_DEDUPE_TTL_MS) return false
    this.prune(now)
    this.seen.set(key, now)
    return true
  },
  clear(sessionKey, accountId) {
    if (!sessionKey || !accountId) return
    this.seen.delete(this.key(sessionKey, accountId))
  },
  prune(now = Date.now()) {
    if (this.seen.size < CIRCUIT_DEDUPE_MAX_ENTRIES / 2) return
    for (const [key, at] of this.seen) {
      if (now - at >= CIRCUIT_DEDUPE_TTL_MS) this.seen.delete(key)
    }
    if (this.seen.size >= CIRCUIT_DEDUPE_MAX_ENTRIES) this.seen.clear()
  },
  reset() {
    this.seen.clear()
  },
}

function countsTowardCircuit(policy, sessionKey, accountId) {
  if (policy?.scope !== 'request' || policy?.action !== 'stop') return true
  return sessionCircuitDedupe.shouldCount(sessionKey, accountId)
}

const KERNEL_CAPABILITY_400_CODES = new Set([
  'invalid_kernel_request',
  'unsupported_capability',
  'thinking_incompatible',
  'crag_prompt_too_large',
])

function isKernelCapabilityRejection(result) {
  if (result?.via !== 'kernel-preflight' || result?.status !== 400) return false
  return KERNEL_CAPABILITY_400_CODES.has(result?.body?.error?.code)
}

const DEFAULTS = {
  max_account_switches: 3,
  max_total_attempts: 12,
  max_accounts_per_request: 0,
  total_retry_deadline_ms: 120000,
  session_queue_timeout_ms: 900_000,
  poison_request_threshold: 2,
  poison_request_window_ms: 30 * 60_000,
  poison_request_quarantine_ms: 10 * 60_000,
  poison_request_vm_sessions: 2,
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

function totalTokensOf(result) {
  const u = usageOf(result)
  if (!u || typeof u !== 'object') return null
  const total =
    Number(u.input_tokens || 0) +
    Number(u.output_tokens || 0) +
    Number(u.cache_read_input_tokens || u.cache_read_tokens || 0) +
    Number(u.cache_creation_input_tokens || u.cache_creation_tokens || 0)
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null
}

function attemptDiagnostics(result, { includeError = true } = {}) {
  const corr = extractProviderCorrelation(result)
  const errFields = includeError && result && !result.ok ? extractErrorLogFields(result) : null
  const errorCode =
    includeError && result && !result.ok
      ? resolveLoggedErrorCode({
          explicitCode: result?.body?.error?.code,
          upstreamType: errFields?.upstream_type,
        })
      : null
  return {
    errorCode,
    upstreamType: errFields?.upstream_type ?? null,
    errorDetails: errFields?.error_details ?? null,
    hopRequestId: corr.hop_request_id,
    providerRunId: corr.run_id,
    providerTurnId: corr.turn_id,
    providerAttemptId: corr.attempt_id,
    providerRequestId: corr.request_id,
  }
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

export function poolOverloadedError(details = {}) {
  const retryMs = Number(details.retry_after_ms ?? details.soonest_available_ms)
  return {
    ok: false,
    status: 529,
    via: 'pool-failover',
    terminalState: 'exhausted',
    ...(details.reason === 'subagent_limit' && { poolReason: details.reason }),
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

function schedulerUnavailableResult(err = null, extras = {}) {
  return {
    ok: false,
    status: 503,
    retryAfterSec: 1,
    via: 'rust-scheduler',
    terminalState: 'scheduler_unavailable',
    finalState: 'scheduler_unavailable',
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        code: 'scheduler_unavailable',
        message: err?.message || 'Rust scheduler sidecar is unavailable',
      },
    },
    ...extras,
  }
}

const TERMINAL_SWITCH_ERROR_CODES = new Set([
  'poison_abort',
  'pool_forbidden',
  'session_in_flight',
  'session_queue_full',
  'session_queue_timeout',
  'session_node_busy',
  'fable_requires_max',
  'pool_rate_limited',
])

function isTerminalSwitchApiError(err) {
  if (!(err instanceof SchedulerApiError)) return false
  if (err.status === 422 || err.status === 403 || err.status === 429) return true
  const code = String(err.code || '').trim()
  const reason = String(err.explain?.reason || '').trim()
  return TERMINAL_SWITCH_ERROR_CODES.has(code) || TERMINAL_SWITCH_ERROR_CODES.has(reason)
}

function schedulerApiErrorResult(err, { extras = {}, lastResult = null, lastPolicy = null } = {}) {
  const formatted = formatSchedulerError(err)
  const retryAfterSec = formatted.retryAfterSec != null ? formatted.retryAfterSec : undefined
  // Security: NEVER expose `err.explain` (`node_key`, `order`, `excluded`, `prompt_policy.text`)
  // in public client `body.error` or `body.error.details`; keep it ONLY on the top-level
  // internal `explain` property for server-side logging.
  const explainField = formatted.explain && typeof formatted.explain === 'object' ? { explain: formatted.explain } : {}
  const body = formatted.body
    ? {
        ...formatted.body,
        error: {
          ...(formatted.body.error || {}),
          ...(formatted.status === 529 ? { type: 'overloaded_error' } : {}),
        },
      }
    : formatted.body
  if (err?.code === 'poison_abort' || formatted.status === 422) {
    return {
      ok: false,
      status: 422,
      via: 'rust-scheduler',
      terminalState: 'poison_abort',
      finalState: 'poison_abort',
      body,
      ...explainField,
      ...extras,
    }
  }
  if (formatted.status === 403) {
    return {
      ok: false,
      status: 403,
      via: 'rust-scheduler',
      terminalState: 'rejected',
      finalState: 'rejected',
      body,
      ...explainField,
      ...extras,
    }
  }
  if (formatted.status === 429) {
    return {
      ok: false,
      status: 429,
      retryAfterSec: retryAfterSec ?? 1,
      via: 'rust-scheduler',
      terminalState: 'exhausted',
      finalState: 'exhausted',
      body,
      ...explainField,
      ...extras,
    }
  }
  const fallback = {
    ok: false,
    status: formatted.status || 503,
    ...(retryAfterSec != null ? { retryAfterSec } : {}),
    via: 'rust-scheduler',
    terminalState: 'exhausted',
    finalState: 'exhausted',
    body,
    ...explainField,
  }
  return preferLastResult(lastResult, lastPolicy, fallback, extras)
}

function buildRustFailureReport(result, policy, error = null) {
  const httpStatus = Number(result?.status ?? error?.status ?? 0) || 0
  const rawCode = String(result?.body?.error?.code || policy?.reason || error?.code || '').trim()
  const rawMsg = String(result?.body?.error?.message || error?.message || '').trim()
  const isTimeout =
    policy?.reason === 'worker_timeout' ||
    policy?.reason === 'provider_timeout' ||
    httpStatus === 504 ||
    httpStatus === 408
  const isTransport = Boolean(result?.transportError) || httpStatus === 0
  let errorClass
  if (isCredentialDeath(policy)) {
    errorClass = 'permanent_ban'
  } else if (policy?.reason === 'account_quota_exhausted' || policy?.reason === 'fable_rate_limited') {
    errorClass = 'quota_exhausted'
  } else if (httpStatus === 529 || policy?.reason === 'provider_overloaded') {
    errorClass = 'overloaded529'
  } else if (
    policy?.reason === 'content_filter_refusal' ||
    policy?.reason === 'usage_policy_refusal' ||
    policy?.reason === 'content_policy_refusal'
  ) {
    errorClass = 'refusal'
  } else {
    errorClass = classifyErrorClass({
      status: httpStatus,
      errorCode: rawCode,
      reason: policy?.reason || '',
      upstreamType: result?.body?.error?.type || '',
      isTimeout,
      isTransport,
    })
  }
  let retryAfterSec = null
  if (Number.isFinite(policy?.cooldownUntil) && policy.cooldownUntil > Date.now() && policy.cooldownUntil < 1e15) {
    retryAfterSec = Math.max(1, Math.ceil((policy.cooldownUntil - Date.now()) / 1000))
  } else if (Number.isFinite(Number(result?.retryAfterSec)) && Number(result.retryAfterSec) > 0) {
    retryAfterSec = Math.max(1, Math.ceil(Number(result.retryAfterSec)))
  } else {
    const hdr = result?.headers?.['retry-after'] ?? result?.headers?.['Retry-After']
    const parsedHdr = Number(hdr)
    if (Number.isFinite(parsedHdr) && parsedHdr > 0) retryAfterSec = Math.max(1, Math.ceil(parsedHdr))
  }
  return {
    http_status: httpStatus,
    error_class: errorClass,
    ...(rawCode ? { error_signature: rawCode.slice(0, 128) } : {}),
    ...(rawMsg ? { error_message: rawMsg.slice(0, 300) } : {}),
    ...(retryAfterSec != null ? { retry_after_sec: retryAfterSec } : {}),
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
  { model, requestBody, repaired, oauth401CooldownMs, signatureRepair, disableRequestRepair = false },
  accountQuota = null,
) {
  return classifyUpstreamResult(result, {
    model,
    requestBody,
    repaired,
    hasRefresh: selectedHasRefresh(selected),
    oauth401CooldownMs,
    credentialGeneration: credentialStamp(selected),
    priorAuth401Generation: priorAuth401Stamp(selected),
    signatureRepair,
    disableRequestRepair,
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

function hasKernelFailureCode(result) {
  return Object.hasOwn(KERNEL_FAILURE_STATUS, String(result?.body?.error?.code || ''))
}

function isUncommittedRateLimitAnswer(result) {
  if (result.committed || Number(result.status) !== 429) return false
  return result.body?.type === 'error' || !!result.body?.error
}

function isUnfinishedLastResult(result, policy) {
  if (!result) return false
  if (policy?.reason === 'incomplete_assistant') return true
  if (isUncommittedRateLimitAnswer(result)) return false
  if (policy?.reason === 'fable_credits_required' || policy?.reason === 'fable_plan_denied') return false
  if (hasKernelFailureCode(result)) return false
  if (result.terminalState === 'incomplete') return true
  return isIncompleteAssistantMessage(result)
}

function preferLastResult(lastResult, lastPolicy, fallback, extras = {}) {
  if (isClientCancelledResult(lastResult)) {
    return { ...clientCancelledResult(lastResult), via: lastResult.via || 'rust-scheduler', ...extras }
  }
  if (!lastResult) return { ...fallback, ...extras }
  if (isUnfinishedLastResult(lastResult, lastPolicy)) {
    return {
      ...incompleteAssistantClientError(lastResult),
      via: lastResult.via || 'rust-scheduler',
      finalState: 'incomplete',
      policy: lastPolicy || lastResult.policy,
      ...extras,
    }
  }
  return {
    ...lastResult,
    via: lastResult.via || 'rust-scheduler',
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

function isSilentCliTimeout(policy, result) {
  if ((policy?.reason !== 'provider_timeout' && policy?.reason !== 'worker_timeout') || result?.committed) return false
  const text = `${result?.error?.message || ''} ${result?.body?.error?.message || ''} ${result?.message || ''}`
  return /no CLI frame/i.test(text)
}

function quarantinedResult({ failures, retryAfterSec }) {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60))
  return {
    ok: false,
    status: 400,
    via: 'pool-failover',
    terminalState: 'rejected',
    finalState: 'rejected',
    attemptCount: 0,
    body: {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: ErrorCode.REQUEST_QUARANTINED,
        message:
          `This conversation's last request made the worker go silent ${failures} times in a row (no output for 180s), ` +
          `so it is refused for about ${minutes} min instead of waiting again. ` +
          'Rewind to before the last tool result (Esc Esc or /rewind) or start a new session. ' +
          `此对话的最近一次请求已让 worker 连续 ${failures} 次无输出（180 秒），约 ${minutes} 分钟内不再重试；` +
          '请回退到上一次工具调用之前（Esc Esc 或 /rewind），或新开会话。',
        details: { failures },
      },
    },
  }
}

const kb = (bytes) => Math.round(bytes / 1024)

function oversizeForSlotResult({ requestBytes, ceilingBytes, retryAfterSec }) {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60))
  return {
    ok: false,
    status: 400,
    via: 'rust-scheduler',
    terminalState: 'rejected',
    finalState: 'rejected',
    attemptCount: 0,
    body: {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: ErrorCode.REQUEST_TOO_LARGE_FOR_SLOT,
        message:
          `Requests of this size (about ${kb(requestBytes)} KB) are currently not answered by the worker that serves this key: ` +
          `smaller ones were, larger ones went silent for 180s. It will be tried again in about ${minutes} min. ` +
          'Rewind to an earlier point (Esc Esc or /rewind) or start a new session; /compact sends the whole conversation, so it is refused too. ' +
          `当前为此 key 服务的 worker 不应答这个体积（约 ${kb(requestBytes)} KB）的请求：更小的请求正常，更大的会静默 180 秒。` +
          `约 ${minutes} 分钟后再试；请回退到更早的位置（Esc Esc 或 /rewind）或新开会话，/compact 会发送整段对话，同样会被拒绝。`,
        details: { request_kb: kb(requestBytes), silent_from_kb: kb(ceilingBytes), retry_after_sec: retryAfterSec },
      },
    },
  }
}

function isRetryableEmptyHop(policy) {
  return policy?.reason === 'incomplete_assistant' || policy?.reason === 'empty_response'
}

function emptyHopReleased(result) {
  if (!result || result.committed) return false
  if (result.transportError === true) return false
  if (result.jobHeld === true || result.executionReleased === false) return false
  return true
}

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

export function adoptProviderResponseHeaders(result) {
  if (!result || result.ok) return result
  const provider = result.providerResult?.response_headers
  if (!provider || typeof provider !== 'object') return result
  const own = result.headers && typeof result.headers === 'object' ? result.headers : {}
  const ownKeys = new Set(Object.keys(own).map((key) => key.toLowerCase()))
  const merged = { ...own }
  for (const [key, value] of Object.entries(provider)) {
    if (!ownKeys.has(String(key).toLowerCase())) merged[key] = value
  }
  result.headers = merged
  return result
}

function applyCooldown(scheduler, selected, policy, model, { diagnosticPin = false } = {}) {
  if (!scheduler?.markCooldown) return
  if (policy?.action !== 'continue-and-cooldown' && policy?.action !== 'disable' && policy?.action !== 'pause') return
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
  if (policy.scope === 'account' && policy.action !== 'pause' && !SOFT_COOLDOWN_REASONS.has(policy.reason)) {
    scheduler.releaseAccountSessions?.({ accountId: selected?.accountId, vmId: selected?.vmId })
  }
}

function isAbortErr(error, signal) {
  return Boolean(
    signal?.aborted ||
      error?.name === 'AbortError' ||
      error?.code === 'ABORT_ERR' ||
      error?.code === 'selection_cancelled' ||
      error?.code === 'request_cancelled',
  )
}

/**
 * Anthropic / Claude VM FailoverRunner backed solely by Rust `kin-scheduler` (M3 / D4).
 *
 * - Same-session concurrency=1 FIFO serialization is owned exclusively by Rust `SessionGate`.
 * - Initial acquisition calls `/internal/v1/schedule/acquire`.
 * - Pre-commit node switches call atomic `/internal/v1/schedule/switch` without dropping `SessionGate`.
 * - First emitted downstream byte invokes idempotent `/internal/v1/schedule/commit`.
 * - Every code path guarantees `/internal/v1/schedule/release` in `finally`.
 * - Strictly Fail-Closed HTTP 503 (`scheduler_unavailable`, `Retry-After: 1`) when Rust is unavailable.
 */
export class FailoverRunner {
  constructor({
    scheduler,
    schedulerRuntime = null,
    getSchedulerRuntime = null,
    stickyRouter = null,
    attemptsRepo = null,
    rateLimitService = null,
    config = {},
    onProxyFailure = null,
    onCredentialFailure = null,
    onFablePlanDenied = null,
    onFableSuccess = null,
    onSchedulePause = null,
  } = {}) {
    this.scheduler = scheduler
    this.schedulerRuntime = schedulerRuntime || null
    this._getSchedulerRuntime = typeof getSchedulerRuntime === 'function' ? getSchedulerRuntime : null
    this.stickyRouter = stickyRouter
    this.attemptsRepo = attemptsRepo
    this.rateLimitService = rateLimitService
    this.config = { ...DEFAULTS, ...(config || {}) }
    this.onProxyFailure = onProxyFailure
    this.onCredentialFailure = onCredentialFailure
    this.onFablePlanDenied = onFablePlanDenied
    this.onFableSuccess = onFableSuccess
    this.onSchedulePause = onSchedulePause
    this.searchRepairs = new Map()
    this.poisonGuard = new PoisonRequestGuard()
    this.applyPoisonConfig()
  }

  setSchedulerRuntime(rt) {
    this.schedulerRuntime = rt || null
  }

  getSchedulerRuntime(override = null) {
    return (
      override ||
      this.schedulerRuntime ||
      (this._getSchedulerRuntime ? this._getSchedulerRuntime() : null) ||
      this.scheduler?.schedulerRuntime ||
      null
    )
  }

  reloadConfig(config = {}) {
    this.config = { ...DEFAULTS, ...(config || {}) }
    this.applyPoisonConfig()
  }

  applyPoisonConfig() {
    this.poisonGuard.threshold = Number(this.config.poison_request_threshold) || 0
    this.poisonGuard.windowMs = Number(this.config.poison_request_window_ms) || 0
    this.poisonGuard.quarantineMs = Number(this.config.poison_request_quarantine_ms) || 0
    this.poisonGuard.vmSessions = Math.max(1, Number(this.config.poison_request_vm_sessions) || 2)
  }

  noteSilentTimeout(stickyKey, canonicalBody, selected, policy, result) {
    if (!stickyKey || !isSilentCliTimeout(policy, result)) return
    this.poisonGuard.recordSilentTimeout(stickyKey, canonicalBody, {
      vm_id: selected?.vmId,
      account_id: selected?.accountId,
    })
  }

  noteUnitHealth(selected, policy, result, { sessionKey = null } = {}) {
    const circuit = this.scheduler?.unitCircuit
    if (circuit && selected?.accountId) {
      if (policy?.circuit) {
        if (countsTowardCircuit(policy, sessionKey, selected.accountId)) circuit.recordFailure(selected.accountId)
      } else if (verifiedSuccess(result)) {
        sessionCircuitDedupe.clear(sessionKey, selected.accountId)
        circuit.recordSuccess(selected.accountId)
      } else circuit.releaseProbe?.(selected.accountId)
    }

    const vmId = selected?.vmId
    if (vmId && result?.clusterDeliveryUnconfirmed !== true) {
      if (verifiedSuccess(result)) {
        vmTimeoutTracker.recordSuccess(vmId)
      } else {
        const isTimeout =
          policy?.reason === 'worker_timeout' ||
          policy?.reason === 'provider_timeout' ||
          result?.status === 504 ||
          result?.upstream_status === 504 ||
          /no CLI frame|timed out|timeout/i.test(String(result?.error?.message || result?.message || ''))
        const ttft = result?.ttft_ms ?? result?.meta?.ttft_ms
        if (isTimeout && ttft == null) {
          const tripped = vmTimeoutTracker.recordTimeout(vmId, 3)
          if (tripped) {
            const trips = kernelFaults.has(vmId) ? vmTimeoutTracker.tripCount(vmId) : vmTimeoutTracker.recordTrip(vmId)
            const holdUntil = vmTimeoutTracker.faultHoldUntil(vmId)
            const fault = `${TIMEOUT_FAULT_PREFIX} VM ${vmId} had 3 consecutive silent inference timeouts`
            const hold = holdUntil ? `, trip ${trips} in 2h, held until ${new Date(holdUntil).toISOString()}` : ''
            console.error(`[vm-circuit] ${fault}; marking kernel fault to prevent routing${hold}`)
            kernelFaults.set(vmId, fault)
          }
        }
      }
    }
  }

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
    const grantDead = /invalid_grant|token has been revoked|token_revoked|invalidated oauth token|oauth_revoked/i.test(
      blob,
    )
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
      this.scheduler?.releaseSticky?.(selected, null, sessionKeys)
    } else {
      this.scheduler?.releaseAccountSessions?.({ accountId: selected?.accountId, vmId: selected?.vmId })
    }
    if (typeof this.onCredentialFailure === 'function') {
      try {
        this.onCredentialFailure({ selected, policy })
      } catch {}
    }
  }

  pauseUnit(selected, policy, result) {
    this.scheduler?.releaseAccountSessions?.({ accountId: selected?.accountId, vmId: selected?.vmId })
    if (typeof this.onSchedulePause === 'function') {
      try {
        this.onSchedulePause({ selected, policy, result })
      } catch {}
    }
  }

  #resolveSelected(acquired, { model, quotaRequest }) {
    if (typeof this.scheduler?.resolveCandidateForNode === 'function') {
      return this.scheduler.resolveCandidateForNode(acquired.selected_node, {
        model,
        resolvedPoolId: acquired.resolved_pool_id,
        promptPolicy: acquired.prompt_policy,
        leaseId: acquired.lease_id,
        leaseTtlMs: acquired.lease_ttl_ms,
        stoodIn: acquired.stood_in,
        preserveMachineHome: acquired.preserve_machine_home,
        sessionGateWaitMs: acquired.session_gate_wait_ms,
        explain: acquired.explain,
        quotaRequest,
      })
    }
    const vmId = String(acquired?.selected_node?.node_id || '')
    return {
      ok: true,
      vmId,
      accountId: vmId,
      vm: null,
      exec: null,
      state: null,
      workerStatus: null,
      model,
      nodeKey: acquired?.selected_node?.node_key || formatNodeKey('claude_vm', vmId),
      leaseId: acquired?.lease_id || null,
      leaseTtlMs: acquired?.lease_ttl_ms || null,
      resolvedPoolId: acquired?.resolved_pool_id || null,
      promptPolicy: acquired?.prompt_policy || null,
      stoodIn: acquired?.stood_in === true,
      preserveMachineHome: acquired?.preserve_machine_home === true,
      explain: acquired?.explain || null,
      selectionReason: acquired?.explain?.affinity?.why || 'rust-scheduler',
      waitMs: Number(acquired?.session_gate_wait_ms) || 0,
      queueWaitMs: Number(acquired?.session_gate_wait_ms) || 0,
      schedulingMs: 0,
      quotaRequest,
      release: () => {},
    }
  }

  async run(args = {}) {
    const sessionKey = String(args.inboundIdentity?.sessionId || args.stickyKey || '')
    const quarantined = args.pinVmId ? null : this.poisonGuard.check(sessionKey, args.canonicalBody)
    if (quarantined) return quarantinedResult(quarantined)
    // Same-session concurrency=1 FIFO serialization is owned solely by Rust `SessionGate`.
    return this.runOnce(args)
  }

  async runOnce({
    requestId,
    canonicalBody,
    model,
    stickyKey = null,
    stickyKeys = null,
    batchMember = false,
    stickyDeviceId = null,
    inboundIdentity = null,
    stream = false,
    deliveryMode = null,
    signal,
    applyAttempt,
    callAttempt,
    onAttempt = null,
    onUpstreamRisk = null,
    pinVmId = null,
    isAdminDiagnostic = undefined,
    familyKey = null,
    rootSessionId = null,
    deviceKey = null,
    skipSessionSeat = false,
    isEphemeralProbe = false,
    ownerScope = null,
    keyScope = null,
    apiKeyScope = null,
    apiKeyRecord = null,
    apiKeyKind = null,
    poolAccess = null,
    originPoolId = null,
    jevDowngradePoolId = null,
    allowedNodeKeys = null,
    protocol = 'anthropic.messages',
    countUsage = true,
    quotaRequest = null,
    allowQueue = true,
    schedulerRuntime = null,
  } = {}) {
    if (typeof callAttempt !== 'function') throw new Error('FailoverRunner requires callAttempt')

    const rt = this.getSchedulerRuntime(schedulerRuntime)
    if (!rt) {
      return schedulerUnavailableResult(new Error('Rust scheduler runtime is unavailable'), { attemptCount: 0 })
    }

    if (signal?.aborted) {
      return { ...clientCancelledResult(), via: 'rust-scheduler', attemptCount: 0 }
    }

    const startedAt = Date.now()
    const maxSameUnitRetries = Number(this.config.max_same_account_retries ?? DEFAULTS.max_same_account_retries)
    const maxUnitSwitches = Number(this.config.max_account_switches ?? DEFAULTS.max_account_switches)
    const maxTotalAttempts = Number(this.config.max_total_attempts ?? DEFAULTS.max_total_attempts)
    const budget = new AttemptCoordinator({
      maxSameUnitRetries,
      maxUnitSwitches,
      maxTotalAttempts,
      deadlineMs: Number(this.config.total_retry_deadline_ms || DEFAULTS.total_retry_deadline_ms),
      startedAt,
    })
    const deadline = budget.deadline
    const accountCap = Number(this.config.max_accounts_per_request)
    const bare429Accounts = new Set()
    const bindKeys = uniqueStickyKeys(stickyKey, stickyKeys)
    const reqId = String(requestId || '').trim() || `req_${crypto.randomBytes(8).toString('hex')}`
    // Security: NEVER pass client-controlled X-Request-Id (`reqId`) as Rust scheduler's
    // idempotency `request_id`; mint an unpredictable per-run UUIDv4 for Rust scheduling.
    const schedulerRequestId = crypto.randomUUID()

    const sizeRefused = pinVmId ? [] : this.poisonGuard.refusedVms(canonicalBody)
    const excludedNodeKeys = new Set(sizeRefused.map((r) => formatNodeKey('claude_vm', r.vmId)).filter(Boolean))

    const resolvedOriginPoolId =
      originPoolId ||
      poolAccess?.originPool?.id ||
      poolAccess?.effectivePool?.id ||
      keyScope?.vm_pool_id ||
      VIRTUAL_POOL_IDS.claude
    const resolvedSessionId = inboundIdentity?.sessionId || (stickyKey ? String(stickyKey) : '') || crypto.randomUUID()
    const resolvedMachineId = inboundIdentity?.machineId || stickyDeviceId || deviceKey || null
    const isManagedPool = Boolean(poolAccess && poolAccess.legacy === false)
    const resolvedAllowedKeys = Array.isArray(allowedNodeKeys)
      ? allowedNodeKeys
      : !isManagedPool && Array.isArray(keyScope?.allowed_vms) && keyScope.allowed_vms.length > 0
        ? keyScope.allowed_vms.map((id) => formatNodeKey('claude_vm', id))
        : undefined
    const resolvedAdminDiagnostic = isAdminDiagnostic !== undefined ? Boolean(isAdminDiagnostic) : Boolean(pinVmId)

    const baseAcquireParams = {
      requestId: schedulerRequestId,
      originPoolId: resolvedOriginPoolId,
      jevDowngradePoolId: jevDowngradePoolId || null,
      apiKeyScope: apiKeyScope || undefined,
      apiKeyRecord: apiKeyRecord || null,
      apiKeyKind: apiKeyKind || null,
      poolAccess: poolAccess || null,
      ownerScope: ownerScope || PLATFORM_SCOPE,
      allowedNodeKeys: resolvedAllowedKeys,
      nodeTypes: ['claude_vm'],
      model: String(model || ''),
      modelFamily: inferModelFamily(model, 'anthropic'),
      protocol: protocol || 'anthropic.messages',
      machineId: resolvedMachineId,
      sessionId: resolvedSessionId,
      sessionIdSource: inboundIdentity?.sessionSource || null,
      parentSessionId: inboundIdentity?.parentSessionId || rootSessionId || null,
      isEphemeralProbe: Boolean(
        isEphemeralProbe || skipSessionSeat || batchMember === true || inboundIdentity?.isEphemeralProbe,
      ),
      noQueue: allowQueue === false,
      isAdminDiagnostic: resolvedAdminDiagnostic,
      pinNodeKey: pinVmId ? formatNodeKey('claude_vm', pinVmId) : null,
    }

    let lastSelected = null
    let lastResult = null
    let lastPolicy = null
    let repaired = false
    let repairPolicy = null
    let repairPending = false
    let freshSlot = false
    let kernelMismatchRetried = false
    let requestBody = clone(canonicalBody)
    let searchRepair = null
    let searchFingerprint
    const fingerprint = () => {
      if (searchFingerprint === undefined) searchFingerprint = searchHistoryFingerprint(canonicalBody)
      return searchFingerprint
    }
    const attribution = () => ({
      accountId: lastSelected?.accountId,
      vmId: lastSelected?.vmId,
      resolvedPoolId: lastSelected?.resolvedPoolId || null,
      stoodIn: lastSelected?.stoodIn === true,
      attemptCount: budget.hops,
    })

    // Step 1: Acquire initial lease from Rust `kin-scheduler` (acquires SessionGate + node slot).
    let acquired
    try {
      acquired = await rt.acquireNode(
        { ...baseAcquireParams, attemptNo: 1, excludeNodes: [...excludedNodeKeys] },
        { signal },
      )
    } catch (err) {
      if (isAbortErr(err, signal)) {
        return { ...clientCancelledResult(), via: 'rust-scheduler', ...attribution() }
      }
      if (err instanceof SchedulerUnavailableError || err?.code === 'scheduler_unavailable') {
        return schedulerUnavailableResult(err, attribution())
      }
      if (err instanceof SchedulerApiError) {
        if (
          sizeRefused.length > 0 &&
          err.status !== 529 &&
          err.status !== 429 &&
          err.status !== 403 &&
          err.status !== 422
        ) {
          return { ...oversizeForSlotResult(sizeRefused[0]), ...attribution() }
        }
        return schedulerApiErrorResult(err, { extras: attribution() })
      }
      return schedulerUnavailableResult(err, attribution())
    }

    let activeLeaseId = acquired.lease_id
    let activeSelected = this.#resolveSelected(acquired, { model, quotaRequest })
    let activeCommitted = false
    let commitPromise = null
    let activeInflightCounted = false
    let finalReleasePayload = null

    const markInflight = (sel) => {
      if (activeInflightCounted || !sel) return
      activeInflightCounted = true
      this.scheduler?.bumpInflight?.(sel.accountId, sel.vmId, 1)
    }
    const clearInflight = (sel) => {
      if (!activeInflightCounted || !sel) return
      activeInflightCounted = false
      this.scheduler?.bumpInflight?.(sel.accountId, sel.vmId, -1)
    }

    markInflight(activeSelected)

    const releaseActiveLeaseNow = async (payload) => {
      const lid = activeLeaseId
      const sel = activeSelected
      activeLeaseId = null
      clearInflight(sel)
      if (!lid) return
      try {
        await rt.releaseLease(lid, payload)
      } catch {}
    }

    const advanceOrRetrySame = async ({ selected, policy, failureReport, hopMs, committedNow }) => {
      const canSameUnit =
        !committedNow &&
        budget.allowSameUnit(selected.accountId, policy, hopMs, this.config.same_account_retry_max_hop_ms) &&
        budget.hops < maxTotalAttempts &&
        Date.now() < deadline

      // Pinned VM or freshly refreshed OAuth credential stays on the current lease directly.
      if (canSameUnit && (pinVmId || policy?.reason === 'oauth_refresh_required')) {
        budget.noteSameUnit(selected.accountId)
        try {
          await sleepWithSignal(this.config.same_account_retry_delay_ms, signal)
        } catch {
          await releaseActiveLeaseNow({ outcome: 'aborted' })
          return { done: true, result: { ...clientCancelledResult(), via: 'rust-scheduler', ...attribution() } }
        }
        return { done: false }
      }

      // Past total/switch caps only untried units stay reachable (via excludedNodeKeys).
      const canSwitch = !committedNow && !pinVmId && Date.now() < deadline
      if (!canSwitch) {
        await releaseActiveLeaseNow({
          outcome: failureReport.error_class === 'timeout' ? 'timeout' : 'error',
          http_status: failureReport.http_status || undefined,
          error_class: failureReport.error_class,
          error_signature: failureReport.error_signature,
          error_message: failureReport.error_message,
          retry_after_sec: failureReport.retry_after_sec,
        })
        return { done: true, result: preferLastResult(lastResult, lastPolicy, null, attribution()) }
      }

      const currentNodeKey = selected.nodeKey || formatNodeKey('claude_vm', selected.vmId)
      const switchExclude = new Set(excludedNodeKeys)
      switchExclude.add(currentNodeKey)
      const prevLeaseId = activeLeaseId
      activeLeaseId = null
      clearInflight(selected)

      let switched
      try {
        switched = await rt.switchNode(
          {
            release_lease_id: prevLeaseId,
            failure: failureReport,
            next_attempt: {
              ...baseAcquireParams,
              attemptNo: budget.hops + 1,
              excludeNodes: [...switchExclude],
            },
          },
          { signal },
        )
      } catch (switchErr) {
        if (isAbortErr(switchErr, signal)) {
          return { done: true, result: { ...clientCancelledResult(), via: 'rust-scheduler', ...attribution() } }
        }
        if (switchErr instanceof SchedulerUnavailableError || switchErr?.code === 'scheduler_unavailable') {
          return { done: true, result: schedulerUnavailableResult(switchErr, attribution()) }
        }
        if (switchErr instanceof SchedulerApiError && canSameUnit && !isTerminalSwitchApiError(switchErr)) {
          // No other free VM is available: fall back to a bounded same-unit retry on this VM.
          budget.noteSameUnit(selected.accountId)
          try {
            await sleepWithSignal(this.config.same_account_retry_delay_ms, signal)
          } catch {
            return { done: true, result: { ...clientCancelledResult(), via: 'rust-scheduler', ...attribution() } }
          }
          let reacquired
          try {
            reacquired = await rt.acquireNode(
              {
                ...baseAcquireParams,
                attemptNo: budget.hops + 1,
                excludeNodes: [...excludedNodeKeys],
              },
              { signal },
            )
          } catch (reErr) {
            if (isAbortErr(reErr, signal)) {
              return { done: true, result: { ...clientCancelledResult(), via: 'rust-scheduler', ...attribution() } }
            }
            if (reErr instanceof SchedulerUnavailableError || reErr?.code === 'scheduler_unavailable') {
              return { done: true, result: schedulerUnavailableResult(reErr, attribution()) }
            }
            if (reErr instanceof SchedulerApiError) {
              return {
                done: true,
                result: schedulerApiErrorResult(reErr, {
                  extras: attribution(),
                  lastResult,
                  lastPolicy,
                }),
              }
            }
            return { done: true, result: schedulerUnavailableResult(reErr, attribution()) }
          }
          activeLeaseId = reacquired.lease_id
          activeSelected = this.#resolveSelected(reacquired, { model, quotaRequest })
          activeCommitted = false
          commitPromise = null
          markInflight(activeSelected)
          return { done: false }
        }
        if (switchErr instanceof SchedulerApiError) {
          return {
            done: true,
            result: schedulerApiErrorResult(switchErr, {
              extras: attribution(),
              lastResult,
              lastPolicy,
            }),
          }
        }
        return { done: true, result: schedulerUnavailableResult(switchErr, attribution()) }
      }

      excludedNodeKeys.add(currentNodeKey)
      budget.noteSwitch(selected.accountId, selected.vmId, { spill: policy?.reason === 'slot_busy' })
      activeLeaseId = switched.lease_id
      activeSelected = this.#resolveSelected(switched, { model, quotaRequest })
      activeCommitted = false
      commitPromise = null
      markInflight(activeSelected)
      return { done: false }
    }

    try {
      for (;;) {
        const attemptNo = budget.hops + 1
        const selected = activeSelected
        lastSelected = selected

        if (signal?.aborted || isClientCancelledResult(lastResult)) {
          finalReleasePayload = { outcome: 'aborted' }
          return { ...clientCancelledResult(lastResult || {}), via: 'rust-scheduler', ...attribution() }
        }
        if (!repairPending && Date.now() >= deadline) {
          finalReleasePayload = { outcome: 'timeout' }
          return preferLastResult(
            lastResult,
            lastPolicy,
            poolOverloadedError({
              reason: 'pool_deadline_exceeded',
              attempt_count: budget.hops,
              last_scope: lastPolicy?.scope || null,
            }),
            attribution(),
          )
        }
        if (
          Number.isSafeInteger(accountCap) &&
          accountCap > 0 &&
          budget.executions.size >= accountCap &&
          !budget.executions.has(selected.accountId)
        ) {
          finalReleasePayload = { outcome: 'error' }
          return preferLastResult(lastResult, lastPolicy, null, { ...attribution(), account_cap: accountCap })
        }

        repairPending = false
        let attemptStarted
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
          const started = Date.now()
          this.attemptsRepo?.begin?.({
            requestId: reqId,
            attemptNo,
            vmId: selected.vmId,
            accountId: selected.accountId,
            model,
            selectionReason: selected.selectionReason,
            waitMs: selected.waitMs,
            queueWaitMs: selected.queueWaitMs,
            schedulingMs: selected.schedulingMs,
          })
          attemptStarted = started
          const attemptResetGenerations = this.scheduler?.accountQuota?.resetGenerations?.(selected.accountId) || null
          const repairKey = searchRepairKey(stickyKey || resolvedSessionId, model, selected)
          const hint = repairKey ? this.searchRepairs.get(repairKey) : null
          if (hint && hint.expiresAt <= Date.now()) this.searchRepairs.delete(repairKey)
          const knownSearchRepair = hint && hint.expiresAt > Date.now() && hint.fingerprint === fingerprint()
          const attemptBody = knownSearchRepair ? flattenSearchResultHistory(requestBody) : requestBody

          const primaryStickyKey = stickyKey || bindKeys[0] || null
          const attemptStickyBound =
            primaryStickyKey && typeof this.stickyRouter?.resolve === 'function'
              ? this.stickyRouter.resolve(primaryStickyKey)
              : null

          const prepared =
            typeof applyAttempt === 'function'
              ? await applyAttempt(clone(attemptBody), selected, {
                  attemptNo,
                  repaired,
                  repairs: [
                    ...(knownSearchRepair ? [{ action: 'repair-and-retry', reason: 'search_repairable' }] : []),
                    ...(repairPolicy ? [repairPolicy] : []),
                  ],
                  attemptStartedAt: attemptStarted,
                  freshSlot,
                  stickyBound: attemptStickyBound,
                })
              : clone(attemptBody)

          if (signal?.aborted) {
            noteHop({ upstreamExecutions: 0 })
            throw Object.assign(new Error('Request cancelled'), { code: 'request_cancelled' })
          }

          const wrappedAttempt =
            prepared &&
            typeof prepared === 'object' &&
            Object.prototype.hasOwnProperty.call(prepared, 'body') &&
            Object.prototype.hasOwnProperty.call(prepared, 'meta')
          const body = wrappedAttempt ? prepared.body : prepared
          const attemptMeta = wrappedAttempt ? prepared.meta : null

          // Outbound session_id ledger only (Rust kin-scheduler owns inbound routing & SessionGate).
          // Borrowed hops and slot_busy spills never overwrite the pinned home's outbound session.
          if (
            attemptMeta?.sessionId &&
            bindKeys.length > 0 &&
            selected?.stickyBorrowed !== true &&
            typeof this.stickyRouter?.bind === 'function'
          ) {
            const outboundSessionId = String(attemptMeta.sessionId)
            const followCache = this.scheduler?.config?.session_affinity_first === true
            const replaceSession =
              freshSlot || Boolean(attemptStickyBound?.vmId && attemptStickyBound.vmId !== selected.vmId)
            for (const key of bindKeys) {
              const prev = this.stickyRouter.resolve?.(key) || null
              if (
                prev?.accountId &&
                prev.accountId !== selected.accountId &&
                !followCache &&
                budget.spilled.has(prev.accountId)
              ) {
                continue
              }
              this.stickyRouter.bind(
                key,
                {
                  accountId: selected.accountId,
                  vmId: selected.vmId,
                  sessionId: outboundSessionId,
                  ...(stickyDeviceId ? { deviceId: stickyDeviceId } : {}),
                },
                {
                  countHit: false,
                  ...(prev ? { ifGeneration: prev.generation || 0 } : {}),
                  replaceSession,
                  allowMove: true,
                },
              )
            }
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
              activeCommitted = true
              if (activeLeaseId && !commitPromise) {
                const lid = activeLeaseId
                commitPromise = rt.commitLease(lid).catch(() => {})
              }
            },
          })
          noteHop(result)
          if (result) {
            result.committed = result.committed || committed
            if (result.attemptStartedAt == null) result.attemptStartedAt = attemptStarted
            if (result.attemptResetGenerations == null && attemptResetGenerations) {
              result.attemptResetGenerations = attemptResetGenerations
            }
          }
          adoptProviderResponseHeaders(result)

          if (signal?.aborted || isClientCancelledResult(result)) {
            this.attemptsRepo?.complete?.(reqId, attemptNo, {
              upstreamStatus: result?.status ?? null,
              errorScope: 'request',
              action: 'stop',
              downstreamCommitted: !!(result?.committed || committed),
              terminalState: 'cancelled',
              latencyMs: Date.now() - attemptStarted,
              ...attemptDiagnostics(result, { includeError: false }),
            })
            await releaseActiveLeaseNow({ outcome: 'aborted' })
            return { ...clientCancelledResult(result), via: result?.via || 'rust-scheduler', ...attribution() }
          }

          const audited = onUpstreamRisk?.(result)
          policy = audited
            ? { scope: 'request', action: 'stop', reason: 'usage_policy_refusal' }
            : classifyAttempt(
                result,
                selected,
                {
                  model,
                  requestBody,
                  repaired,
                  oauth401CooldownMs: this.config.oauth_401_cooldown_ms,
                  signatureRepair: signatureRepairEnabled(this.config) || attemptMeta?.foreignThinking === true,
                  disableRequestRepair: attemptMeta?.strictPassthrough === true,
                },
                this.scheduler?.accountQuota,
              )

          if (
            policy.reason === 'thinking_incompatible' &&
            !result?.committed &&
            attemptMeta?.strictPassthrough !== true
          ) {
            const upstreamMessage = String(result?.body?.error?.message || '').trim()
            const detail = `thinking.budget_tokens must be at least ${MIN_THINKING_BUDGET} and less than max_tokens (got max_tokens=${requestBody?.max_tokens})`
            const message = upstreamMessage ? `${upstreamMessage}; ${detail}` : detail
            result = {
              ...result,
              ok: false,
              status: 400,
              body: {
                type: 'error',
                error: {
                  ...(result?.body?.error || {}),
                  type: 'invalid_request_error',
                  code: 'thinking_incompatible',
                  param: 'max_tokens',
                  message,
                  details: { ...(result?.body?.error?.details || {}), retryable: false },
                },
              },
            }
          }

          if (
            !pinVmId &&
            selected.accountId &&
            policy.reason === 'rate_limited_unknown' &&
            policy.action === 'continue' &&
            executionsOf(result) > 0
          ) {
            bare429Accounts.add(selected.accountId)
            if (bare429Accounts.size >= 2) {
              policy = attachFailureDecision({ scope: 'request', action: 'stop', reason: 'rate_limited_request' })
            }
          }

          if (knownSearchRepair && policy.reason === 'search_repairable') {
            this.searchRepairs.delete(repairKey)
            policy = { ...policy, action: 'stop', circuit: true }
          }

          const hardBlock =
            !result?.committed && !pinVmId
              ? this.rateLimitService?.handleUpstreamError?.({
                  accountId: selected.accountId,
                  vmId: selected.vmId,
                  result,
                  policy,
                  requestStartedAt: attemptStarted,
                  resetGenerations: attemptResetGenerations,
                }) || null
              : null
          let preResetRateLimitIgnored = hardBlock?.ignored === true
          if (
            !preResetRateLimitIgnored &&
            !this.rateLimitService &&
            !result?.committed &&
            !pinVmId &&
            policy.action === 'continue-and-cooldown' &&
            (policy.reason === 'account_quota_exhausted' || policy.reason === 'fable_rate_limited') &&
            this.scheduler?.accountQuota?.isPreResetResponse
          ) {
            const targetWindow =
              policy.reason === 'fable_rate_limited' ? '7d_oi' : inferRateLimitWindow(result, Date.now())
            preResetRateLimitIgnored = !!this.scheduler.accountQuota.isPreResetResponse(
              selected.accountId,
              targetWindow,
              {
                requestStartedAt: attemptStarted,
                resetGenerations: attemptResetGenerations,
              },
            )
          }
          if (preResetRateLimitIgnored && policy.action === 'continue-and-cooldown') {
            policy = { ...policy, action: 'continue', cooldownUntil: null }
          } else if (hardBlock?.until && policy.action === 'continue-and-cooldown' && policy.scope === 'account') {
            policy = { ...policy, cooldownUntil: hardBlock.until }
          }

          if (policy.reason === 'crag_opaque_429') {
            const threshold = opaque429Setting(this.config.crag_opaque_429_threshold, OPAQUE_429_THRESHOLD, 2, 10)
            if (opaque429Tracker.record(selected.accountId, model, threshold)) {
              opaque429Tracker.clear(selected.accountId, model)
              policy = attachFailureDecision({
                ...policy,
                decision: undefined,
                scope: 'model',
                action: 'continue-and-cooldown',
                reason: 'crag_opaque_429_model_cooldown',
                retrySameAccount: false,
                cooldownUntil:
                  Date.now() +
                  opaque429Setting(
                    this.config.crag_opaque_429_cooldown_ms,
                    OPAQUE_429_COOLDOWN_MS,
                    10_000,
                    10 * 60_000,
                  ),
              })
            }
          } else if (verifiedSuccess(result)) {
            opaque429Tracker.clear(selected.accountId, model)
          }

          lastResult = result
          lastPolicy = policy
          this.noteUnitHealth(selected, policy, result, { sessionKey: stickyKey || resolvedSessionId })
          this.noteSilentTimeout(stickyKey || resolvedSessionId, canonicalBody, selected, policy, result)
          notifyProxyFailure(this.onProxyFailure, selected, policy)
          if (
            (policy.reason === 'fable_plan_denied' || policy.reason === 'fable_credits_required') &&
            typeof this.onFablePlanDenied === 'function'
          ) {
            try {
              this.onFablePlanDenied({ selected, policy })
            } catch {}
          }

          const terminalState = result?.terminalState || (result?.ok ? 'unknown' : 'error')
          this.attemptsRepo?.complete?.(reqId, attemptNo, {
            upstreamStatus: result?.status ?? null,
            errorScope: policy.scope,
            action: policy.action,
            cooldownUntil: policy.cooldownUntil,
            downstreamCommitted: result?.committed || committed,
            terminalState,
            usage: usageOf(result),
            ttftMs: result?.ttftMs ?? null,
            latencyMs: Date.now() - attemptStarted,
            ...attemptDiagnostics(result, { includeError: !result?.ok }),
          })
          if (typeof onAttempt === 'function') {
            await onAttempt({ attemptNo, selected, result, policy })
          }

          if (
            policy.reason === 'content_filter_refusal' ||
            policy.reason === 'usage_policy_refusal' ||
            policy.reason === 'content_policy_refusal' ||
            policy.reason === 'third_party_client'
          ) {
            if (activeLeaseId) {
              await (commitPromise || rt.commitLease(activeLeaseId).catch(() => {}))
            }
            const ttftMs = Number.isFinite(result?.ttftMs) ? Math.max(0, Math.round(result.ttftMs)) : undefined
            const tokensUsed = totalTokensOf(result)
            await releaseActiveLeaseNow({
              outcome: 'ok',
              http_status: Number(result?.status) || 200,
              ...(ttftMs != null ? { ttft_ms: ttftMs } : {}),
              ...(tokensUsed != null ? { tokens_used: tokensUsed } : {}),
            })
            this.scheduler?.markSuccess?.(selected, { workerStatus: result.workerStatus || null, countUsage })
            return {
              ...result,
              ...attribution(),
              finalState: policy.reason === 'content_filter_refusal' ? 'content_filter' : 'rejected',
              policy,
            }
          }

          if (verifiedSuccess(result)) {
            this.poisonGuard.recordSuccess(stickyKey || resolvedSessionId, {
              vmId: selected.vmId,
              body: canonicalBody,
            })
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
            if (activeLeaseId) {
              await (commitPromise || rt.commitLease(activeLeaseId).catch(() => {}))
            }
            const ttftMs = Number.isFinite(result?.ttftMs) ? Math.max(0, Math.round(result.ttftMs)) : undefined
            const tokensUsed = totalTokensOf(result)
            await releaseActiveLeaseNow({
              outcome: 'ok',
              http_status: Number(result?.status) || 200,
              ...(ttftMs != null ? { ttft_ms: ttftMs } : {}),
              ...(tokensUsed != null ? { tokens_used: tokensUsed } : {}),
            })
            this.scheduler?.markSuccess?.(selected, { workerStatus: result.workerStatus || null, countUsage })
            if (isFableModel(model) && typeof this.onFableSuccess === 'function') {
              try {
                this.onFableSuccess({ selected, model })
              } catch {}
            }
            return { ...result, ...attribution(), finalState: 'verified' }
          }

          // One-shot body repair stays on the currently held Rust lease & SessionGate.
          if (policy.action === 'repair-and-retry' && !repaired && !result?.committed) {
            let nextBody
            try {
              nextBody = repairAnthropicRequest(requestBody, policy)
            } catch (repairError) {
              if (repairError?.status === 400 && repairError?.body?.error) {
                await releaseActiveLeaseNow({ outcome: 'error', http_status: 400, error_class: 'client4xx' })
                return {
                  ...result,
                  ok: false,
                  status: 400,
                  body: repairError.body,
                  ...attribution(),
                  finalState: 'invalid_request',
                  policy: attachFailureDecision({
                    scope: 'request',
                    action: 'stop',
                    reason: repairError.body.error.code || 'invalid_request',
                    cooldownUntil: null,
                  }),
                }
              }
              throw repairError
            }
            repaired = true
            repairPolicy = { action: policy.action, reason: policy.reason }
            repairPending = true
            if (policy.reason === 'search_repairable' && repairKey && fingerprint()) {
              searchRepair = { key: repairKey }
            }
            requestBody = nextBody
            continue
          }

          applyCooldown(this.scheduler, selected, policy, model, { diagnosticPin: !!pinVmId })
          if (policy.pauseSchedule) this.pauseUnit(selected, policy, result)
          if (!pinVmId && isCredentialDeath(policy)) {
            this.forgetCredential(selected, policy, { familyKey, sessionKeys: bindKeys })
          }

          const failureReport = buildRustFailureReport(result, policy)
          const kernelCapabilityHop =
            !shouldContinue(policy) && !kernelMismatchRetried && isKernelCapabilityRejection(result)
          if (kernelCapabilityHop) {
            kernelMismatchRetried = true
            for (const key of bindKeys) this.stickyRouter?.unbind?.(key)
            if (typeof rt.deleteSticky === 'function') {
              await rt.deleteSticky({ scope_kind: 'session', session_id: resolvedSessionId }).catch(() => {})
            }
          }

          if (!shouldContinue(policy) && !kernelCapabilityHop) {
            await releaseActiveLeaseNow({
              outcome: failureReport.error_class === 'timeout' ? 'timeout' : 'error',
              http_status: failureReport.http_status || undefined,
              error_class: failureReport.error_class,
              error_signature: failureReport.error_signature,
              error_message: failureReport.error_message,
              retry_after_sec: failureReport.retry_after_sec,
            })
            return { ...result, ...attribution(), finalState: result?.terminalState || 'rejected', policy }
          }

          policy = await this.recoverCredential(selected, policy)
          const hopMs = Date.now() - attemptStarted
          if (isRetryableEmptyHop(policy)) {
            if (!emptyHopReleased(result) || pinVmId) {
              await releaseActiveLeaseNow({
                outcome: 'error',
                http_status: failureReport.http_status || undefined,
                error_class: failureReport.error_class,
                error_signature: failureReport.error_signature,
                error_message: failureReport.error_message,
              })
              return incompleteHopResult(result, policy, attribution())
            }
            this.retireOutboundSession(selected, bindKeys)
            freshSlot = true
          }

          const nextStep = await advanceOrRetrySame({
            selected,
            policy,
            failureReport,
            hopMs,
            committedNow: Boolean(result?.committed || committed),
          })
          if (nextStep.done) return nextStep.result
        } catch (error) {
          if (attemptStarted === undefined) throw error
          const invalidRequest =
            error?.status === 400 &&
            [
              'invalid_cache_control',
              'crag_prompt_too_large',
              'image_too_large',
              'invalid_image_url',
              'invalid_kernel_request',
              'unsupported_capability',
              'invalid_tool_schema',
              'thinking_incompatible',
            ].includes(error.body?.error?.code)
          noteHop(invalidRequest ? { upstreamExecutions: 0 } : null)
          if (error?.code === 'response_sent') {
            this.attemptsRepo?.complete?.(reqId, attemptNo, {
              upstreamStatus: 403,
              errorScope: 'request',
              action: 'stop',
              downstreamCommitted: true,
              terminalState: 'policy_block',
              latencyMs: Date.now() - attemptStarted,
            })
            await releaseActiveLeaseNow({ outcome: 'error', http_status: 403, error_class: 'client4xx' })
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
          if (invalidRequest) {
            this.attemptsRepo?.complete?.(reqId, attemptNo, {
              upstreamStatus: 0,
              errorScope: 'request',
              action: 'stop',
              downstreamCommitted: false,
              terminalState: 'invalid_request',
              latencyMs: Date.now() - attemptStarted,
              ...attemptDiagnostics({ ok: false, status: 400, body: error.body }),
            })
            await releaseActiveLeaseNow({
              outcome: 'error',
              http_status: 400,
              error_class: 'client4xx',
              error_signature: error.body?.error?.code,
              error_message: error.body?.error?.message,
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
          if (isAbortErr(error, signal)) {
            this.attemptsRepo?.complete?.(reqId, attemptNo, {
              upstreamStatus: 0,
              errorScope: 'request',
              action: 'stop',
              downstreamCommitted: !!committed,
              terminalState: 'cancelled',
              latencyMs: Date.now() - attemptStarted,
            })
            await releaseActiveLeaseNow({ outcome: 'aborted' })
            return { ...clientCancelledResult({ committed }), via: 'rust-scheduler', ...attribution() }
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
          this.noteUnitHealth(selected, policy, result, { sessionKey: stickyKey || resolvedSessionId })
          this.noteSilentTimeout(stickyKey || resolvedSessionId, canonicalBody, selected, policy, result)
          notifyProxyFailure(this.onProxyFailure, selected, policy)
          this.attemptsRepo?.complete?.(reqId, attemptNo, {
            upstreamStatus: 0,
            errorScope: policy.scope,
            action: policy.action,
            cooldownUntil: policy.cooldownUntil,
            downstreamCommitted: committed,
            terminalState: result.terminalState,
            latencyMs: Date.now() - attemptStarted,
            ...attemptDiagnostics(result),
          })

          const failureReport = buildRustFailureReport(result, policy, error)
          if (committed || !shouldContinue(policy)) {
            await releaseActiveLeaseNow({
              outcome: failureReport.error_class === 'timeout' ? 'timeout' : 'error',
              http_status: failureReport.http_status || undefined,
              error_class: failureReport.error_class,
              error_signature: failureReport.error_signature,
              error_message: failureReport.error_message,
            })
            return { ...result, ...attribution(), finalState: result.terminalState, policy }
          }
          applyCooldown(this.scheduler, selected, policy, model, { diagnosticPin: !!pinVmId })
          if (!pinVmId && isCredentialDeath(policy)) {
            this.forgetCredential(selected, policy, { familyKey, sessionKeys: bindKeys })
          }
          policy = await this.recoverCredential(selected, policy)
          const hopMs = Date.now() - attemptStarted
          const nextStep = await advanceOrRetrySame({
            selected,
            policy,
            failureReport,
            hopMs,
            committedNow: Boolean(committed),
          })
          if (nextStep.done) return nextStep.result
        }
      }
    } finally {
      if (activeLeaseId) {
        await releaseActiveLeaseNow(
          finalReleasePayload || {
            outcome: signal?.aborted ? 'aborted' : activeCommitted ? 'ok' : 'error',
          },
        )
      } else {
        clearInflight(activeSelected)
      }
    }
  }
}
