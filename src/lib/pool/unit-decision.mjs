/**
 * Unit scheduling decisions for one VM credential.
 * A unit is (vmId, accountId): one credential, one provider, one account.
 *
 * FailureDecision shape follows the scheduler review. Legacy policy fields
 * (scope/action/reason/cooldownUntil/retrySameAccount) stay authoritative
 * for callers that have not switched over.
 */

const ORIGIN_BY_SCOPE = {
  client_lifecycle: 'client',
  success: 'upstream',
  request: 'upstream',
  stream: 'upstream',
  account: 'upstream',
  credential: 'upstream',
  model: 'upstream',
  provider: 'upstream',
  proxy: 'transport',
  worker: 'local',
}

export function decisionAction(policy = {}) {
  if (policy.action === 'repair-and-retry') return 'repair'
  if (policy.retrySameAccount && (policy.action === 'continue' || policy.action === 'continue-and-cooldown')) {
    return 'retry_same'
  }
  if (policy.action === 'continue' || policy.action === 'continue-and-cooldown') return 'next_unit'
  return 'return'
}

export function decisionScope(policy = {}) {
  if (policy.circuit) return 'unit'
  if (policy.scope === 'credential' || policy.reason === 'oauth_refresh_required') return 'credential'
  if (policy.scope === 'provider') return 'unit'
  if (policy.scope === 'client_lifecycle') return 'request'
  return policy.scope || 'request'
}

export function decisionOrigin(policy = {}) {
  if (policy.reason === 'content_filter_refusal' || policy.reason === 'client_cancelled') return 'client'
  if (policy.reason === 'pool_wait_queue_full' || (policy.scope === 'worker' && policy.reason === 'slot_busy')) {
    return 'local'
  }
  if (policy.scope === 'proxy' || policy.reason === 'worker_transport_failure' || policy.reason === 'worker_timeout') {
    return 'transport'
  }
  return ORIGIN_BY_SCOPE[policy.scope] || 'upstream'
}

/** Stamp origin/scope/action without changing legacy failover fields. */
export function attachFailureDecision(policy) {
  if (!policy || policy.decision) return policy
  const decision = {
    origin: decisionOrigin(policy),
    scope: decisionScope(policy),
    action: decisionAction(policy),
    cooldownUntilMs: policy.cooldownUntil ?? null,
    credentialRefreshNeeded: policy.reason === 'oauth_refresh_required',
  }
  return { ...policy, decision }
}

/** Real executions one unit may take for one request, hidden transport retries included. */
export const MAX_EXECUTIONS_PER_UNIT = 3

/**
 * Per-unit execution budget, unit switches, and the shared request deadline.
 * Admission misses never count. Past the total/switch caps only units this
 * request has not tried stay reachable, so a large pool is never starved.
 * Selection exhaustion does not clear the exclusion set.
 */
export class AttemptCoordinator {
  constructor({
    maxSameUnitRetries = 1,
    maxUnitSwitches = 10,
    maxTotalAttempts = 12,
    maxExecutionsPerUnit = MAX_EXECUTIONS_PER_UNIT,
    deadlineMs = 120_000,
    startedAt = Date.now(),
  } = {}) {
    this.maxSameUnitRetries = maxSameUnitRetries
    this.maxUnitSwitches = maxUnitSwitches
    this.maxTotalAttempts = maxTotalAttempts
    this.maxExecutionsPerUnit = maxExecutionsPerUnit
    this.deadline = startedAt + deadlineMs
    this.sameUnitRetries = new Map()
    this.executions = new Map()
    this.unitSwitches = 0
    this.hops = 0
    this.tried = new Set()
    this.excluded = new Set()
    this.spilled = new Set()
  }

  get deadlineLeft() {
    return this.deadline - Date.now()
  }

  /** Total/switch caps spent: untried units only, no more same-unit repeats. */
  get untriedOnly() {
    return this.hops >= this.maxTotalAttempts || this.unitSwitches > this.maxUnitSwitches
  }

  sameUnitUsed(accountId) {
    return this.sameUnitRetries.get(accountId) || 0
  }

  executionsLeft(accountId) {
    return Math.max(0, this.maxExecutionsPerUnit - (this.executions.get(accountId) || 0))
  }

  noteHop(accountId, vmId, executions = 1) {
    this.hops += 1
    if (accountId) {
      this.tried.add(accountId)
      this.executions.set(accountId, (this.executions.get(accountId) || 0) + Math.max(1, Number(executions) || 1))
    }
    if (vmId) this.tried.add(vmId)
    if (this.untriedOnly) for (const id of this.tried) this.excluded.add(id)
  }

  allowSameUnit(accountId, policy, hopMs, maxHopMs = 10_000) {
    if (this.untriedOnly || this.executionsLeft(accountId) <= 0) return false
    if (policy?.reason === 'incomplete_assistant' || policy?.reason === 'empty_response') return true
    if (!policy?.retrySameAccount && policy?.decision?.action !== 'retry_same') return false
    if (policy?.decision && policy.decision.action !== 'retry_same' && !policy.retrySameAccount) return false
    if (this.sameUnitUsed(accountId) >= this.maxSameUnitRetries) return false
    if (policy.reason === 'oauth_refresh_required') return true
    return hopMs < maxHopMs
  }

  noteSameUnit(accountId) {
    this.sameUnitRetries.set(accountId, this.sameUnitUsed(accountId) + 1)
  }

  noteSwitch(accountId, vmId, { spill = false } = {}) {
    if (accountId) this.excluded.add(accountId)
    if (vmId) this.excluded.add(vmId)
    if (spill && accountId) this.spilled.add(accountId)
    this.unitSwitches += 1
    if (this.untriedOnly) for (const id of this.tried) this.excluded.add(id)
  }
}
