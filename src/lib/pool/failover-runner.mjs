import { classifyUpstreamResult, repairAnthropicRequest, shouldContinue } from './upstream-error-policy.mjs'
import { listQuotaFromHeaders } from './quota-window.mjs'
import {
  isCompleteAssistantMessage,
  isIncompleteAssistantMessage,
  incompleteAssistantClientError,
} from '../core/errors.mjs'
import { hasRefreshPresence } from '../oauth/oauth-credentials.mjs'
import { resolveOfficialCcInference } from '../vm/slot-engine.mjs'

const DEFAULTS = {
  max_account_switches: 10,
  max_total_attempts: 12,
  total_retry_deadline_ms: 120000,
  delivery_mode: 'realtime',
  max_same_account_retries: 1,
  same_account_retry_delay_ms: 500,
  same_account_retry_max_hop_ms: 10_000,
  signature_repair: false,
}

function clone(value) {
  return structuredClone(value)
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

function signatureRepairEnabled(config, selected) {
  if (config.signature_repair === true) return true
  return resolveOfficialCcInference(selected?.vm) === 'cli-hop'
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

function isUnfinishedLastResult(result, policy) {
  if (!result) return false
  if (policy?.reason === 'incomplete_assistant') return true
  if (result.terminalState === 'incomplete') return true
  return isIncompleteAssistantMessage(result)
}

function preferLastResult(lastResult, lastPolicy, fallback, extras = {}) {
  if (!lastResult) return fallback
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

function canRetrySameAccount(policy, used, config, hopMs) {
  const maxRetries = Number(config.max_same_account_retries ?? 0)
  const maxHopMs = Number(config.same_account_retry_max_hop_ms ?? 10_000)
  if (!policy?.retrySameAccount || used >= maxRetries) return false
  if (policy.reason === 'incomplete_assistant') return true
  return hopMs < maxHopMs
}

function applyCooldown(scheduler, selected, policy, model, stickyRouter = null, { diagnosticPin = false } = {}) {
  if (policy?.action !== 'continue-and-cooldown' && policy?.action !== 'disable') return
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
  // Account-level cooldown must drop every conversation pin, otherwise the
  // next request waits on the cooling slot and never rotates.
  if (policy.scope === 'account') {
    stickyRouter?.unbindByAccount?.({
      accountId: selected?.accountId,
      vmId: selected?.vmId,
    })
  }
}

export class FailoverRunner {
  constructor({
    scheduler,
    stickyRouter = null,
    attemptsRepo = null,
    config = {},
    onProxyFailure = null,
    onCredentialFailure = null,
    onFablePlanDenied = null,
  } = {}) {
    this.scheduler = scheduler
    this.stickyRouter = stickyRouter
    this.attemptsRepo = attemptsRepo
    this.config = { ...DEFAULTS, ...(config || {}) }
    this.onProxyFailure = onProxyFailure
    this.onCredentialFailure = onCredentialFailure
    this.onFablePlanDenied = onFablePlanDenied
  }

  forgetCredential(selected, policy) {
    this.stickyRouter?.unbindByAccount?.({
      accountId: selected?.accountId,
      vmId: selected?.vmId,
    })
    if (typeof this.onCredentialFailure === 'function') {
      try {
        this.onCredentialFailure({ selected, policy })
      } catch {}
    }
  }

  async run({
    requestId,
    canonicalBody,
    model,
    stickyKey = null,
    stickyKeys = null,
    stream = false,
    deliveryMode = null,
    signal,
    applyAttempt,
    callAttempt,
    onAttempt = null,
    pinVmId = null,
    ownerScope = null,
    countUsage = true,
  } = {}) {
    if (!this.scheduler) throw new Error('FailoverRunner requires a scheduler')
    if (typeof callAttempt !== 'function') throw new Error('FailoverRunner requires callAttempt')
    const startedAt = Date.now()
    const deadline = startedAt + Number(this.config.total_retry_deadline_ms || 120000)
    const excluded = new Set()
    const sameAccountRetries = new Map()
    const bindKeys = uniqueStickyKeys(stickyKey, stickyKeys)
    const bindAll = (account, opts) => {
      if (!this.stickyRouter?.bind || !account) return
      for (const key of bindKeys) {
        this.stickyRouter.bind(key, account, opts)
      }
    }
    let lastResult = null
    let lastPolicy = null
    let accountSwitches = 0
    let repaired = false
    let requestBody = clone(canonicalBody)

    for (let attemptNo = 1; attemptNo <= this.config.max_total_attempts; attemptNo++) {
      if (signal?.aborted) {
        return poolError('request_cancelled', 'Request was cancelled', { attempt_count: attemptNo - 1 })
      }
      if (Date.now() >= deadline) {
        return preferLastResult(
          lastResult,
          lastPolicy,
          poolError('pool_deadline_exceeded', 'Account pool retry deadline exceeded', {
            attempt_count: attemptNo - 1,
            last_scope: lastPolicy?.scope || null,
          }),
          { attemptCount: attemptNo - 1 },
        )
      }
      let selected
      try {
        selected = await this.scheduler.selectAndReserve({
          model,
          stickyKey,
          excluded,
          signal,
          deadline,
          allowWait: true,
          pinVmId,
          ownerScope,
        })
      } catch (error) {
        if (error?.code === 'selection_cancelled') {
          return poolError('request_cancelled', 'Request was cancelled', { attempt_count: attemptNo - 1 })
        }
        if (error?.code === 'pool_wait_queue_full') {
          return poolError('pool_wait_queue_full', 'Account pool wait queue is full', {
            reason: 'pool_wait_queue_full',
            attempt_count: attemptNo - 1,
          })
        }
        throw error
      }
      if (!selected?.ok) {
        return preferLastResult(
          lastResult,
          lastPolicy,
          poolError('account_pool_exhausted', 'No eligible Claude accounts remain', {
            excluded_accounts: [...excluded],
            reason: selected?.reason || 'no_eligible_accounts',
            wait_ms: selected?.waitMs ?? selected?.wait_ms ?? 0,
            soonest_available_ms: selected?.soonest_available_ms ?? null,
            wait_reasons: selected?.wait_reasons || [],
            eligible: selected?.eligible ?? 0,
            available: selected?.available ?? 0,
            sticky_cleared: !!selected?.sticky_cleared,
            attempt_count: attemptNo - 1,
          }),
          { attemptCount: attemptNo - 1 },
        )
      }
      bindAll(
        {
          accountId: selected.accountId,
          vmId: selected.vmId,
        },
        { countHit: false },
      )
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
      try {
        const prepared =
          typeof applyAttempt === 'function'
            ? await applyAttempt(clone(requestBody), selected, { attemptNo, repaired })
            : clone(requestBody)
        const wrappedAttempt =
          prepared &&
          typeof prepared === 'object' &&
          Object.prototype.hasOwnProperty.call(prepared, 'body') &&
          Object.prototype.hasOwnProperty.call(prepared, 'meta')
        const body = wrappedAttempt ? prepared.body : prepared
        const attemptMeta = wrappedAttempt ? prepared.meta : null
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
        if (result) result.committed = result.committed || committed
        policy = classifyAttempt(
          result,
          selected,
          {
            model,
            repaired,
            oauth401CooldownMs: this.config.oauth_401_cooldown_ms,
            signatureRepair: signatureRepairEnabled(this.config, selected),
          },
          this.scheduler?.accountQuota,
        )
        lastResult = result
        lastPolicy = policy
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
        if (policy.reason === 'content_filter_refusal') {
          this.scheduler.markSuccess(selected, { workerStatus: result.workerStatus || null, countUsage })
          bindAll({
            accountId: selected.accountId,
            vmId: selected.vmId,
          })
          return {
            ...result,
            accountId: selected.accountId,
            vmId: selected.vmId,
            attemptCount: attemptNo,
            finalState: 'content_filter',
            policy,
          }
        }
        if (verifiedSuccess(result)) {
          this.scheduler.markSuccess(selected, { workerStatus: result.workerStatus || null, countUsage })
          bindAll({
            accountId: selected.accountId,
            vmId: selected.vmId,
          })
          return {
            ...result,
            accountId: selected.accountId,
            vmId: selected.vmId,
            attemptCount: attemptNo,
            finalState: 'verified',
          }
        }
        if (policy.action === 'repair-and-retry' && !repaired && !result?.committed) {
          repaired = true
          requestBody = repairAnthropicRequest(requestBody, policy)
          continue
        }
        applyCooldown(this.scheduler, selected, policy, model, this.stickyRouter, { diagnosticPin: !!pinVmId })
        if (
          !pinVmId &&
          (policy.scope === 'credential' ||
            policy.action === 'disable' ||
            policy.reason === 'oauth_no_refresh' ||
            policy.reason === 'oauth_revoked')
        ) {
          this.forgetCredential(selected, policy)
        }
        if (!shouldContinue(policy)) {
          return {
            ...result,
            accountId: selected.accountId,
            vmId: selected.vmId,
            attemptCount: attemptNo,
            finalState: result?.terminalState || 'rejected',
            policy,
          }
        }
        const hopMs = Date.now() - attemptStarted
        const used = sameAccountRetries.get(selected.accountId) || 0
        if (canRetrySameAccount(policy, used, this.config, hopMs)) {
          sameAccountRetries.set(selected.accountId, used + 1)
          try {
            await sleepWithSignal(this.config.same_account_retry_delay_ms, signal)
          } catch {
            return poolError('request_cancelled', 'Request was cancelled', { attempt_count: attemptNo })
          }
          continue
        }
        excluded.add(selected.accountId)
        excluded.add(selected.vmId)
        accountSwitches++
        if (accountSwitches > this.config.max_account_switches) {
          return preferLastResult(
            result,
            policy,
            poolError('max_account_switches_exceeded', 'Maximum account switches exceeded', {
              attempt_count: attemptNo,
              last_scope: policy.scope,
            }),
            {
              accountId: selected.accountId,
              vmId: selected.vmId,
              attemptCount: attemptNo,
            },
          )
        }
      } catch (error) {
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
            signatureRepair: signatureRepairEnabled(this.config, selected),
          },
          this.scheduler?.accountQuota,
        )
        lastResult = result
        lastPolicy = policy
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
          return {
            ...result,
            accountId: selected.accountId,
            vmId: selected.vmId,
            attemptCount: attemptNo,
            finalState: result.terminalState,
            policy,
          }
        }
        applyCooldown(this.scheduler, selected, policy, model, this.stickyRouter, { diagnosticPin: !!pinVmId })
        if (
          !pinVmId &&
          (policy.scope === 'credential' ||
            policy.action === 'disable' ||
            policy.reason === 'oauth_no_refresh' ||
            policy.reason === 'oauth_revoked')
        ) {
          this.forgetCredential(selected, policy)
        }
        const hopMs = Date.now() - attemptStarted
        const used = sameAccountRetries.get(selected.accountId) || 0
        if (canRetrySameAccount(policy, used, this.config, hopMs)) {
          sameAccountRetries.set(selected.accountId, used + 1)
          try {
            await sleepWithSignal(this.config.same_account_retry_delay_ms, signal)
          } catch {
            return poolError('request_cancelled', 'Request was cancelled', { attempt_count: attemptNo })
          }
          continue
        }
        excluded.add(selected.accountId)
        excluded.add(selected.vmId)
        accountSwitches++
      } finally {
        selected.release?.()
      }
    }
    return preferLastResult(
      lastResult,
      lastPolicy,
      poolError('attempts_exhausted', 'Maximum account attempts exhausted', {
        max_attempts: this.config.max_total_attempts,
      }),
    )
  }
}
