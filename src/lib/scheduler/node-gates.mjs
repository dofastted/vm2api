/**
 * Per-node (model-agnostic) admission gates that v1.4.238's JS
 * `PoolScheduler.checkEligibility` applied to every Claude candidate and that
 * the M3 cutover did not carry into the Rust snapshot/telemetry.
 *
 * `buildTelemetryBatch` runs this for each Claude VM and turns a non-null
 * reason into `schedulable=false` + `unschedulable_reason`, so Rust admission
 * drops the node (`ExcludeReason::NotSchedulable`). Admin pins bypass Rust
 * admission entirely, which matches 238 where `pinned` skipped these gates.
 *
 * Order follows 238 so the reported reason is the one 238 would have named.
 */
import { vmNodeDataPath } from '../cluster/placement.mjs'
import {
  evaluateCredentialEligibility,
  evaluateProxySync,
  isCredentialRuntimeBlocked,
  slotHasBoundProxy,
} from '../pool/schedule-eligibility.mjs'
import { FABLE_FAMILY_KEY, isFableModel, modelCooldownKeys, normalizeModelKey } from '../pool/upstream-error-policy.mjs'
import { splitBlocksModel } from '../pool/weekly-split.mjs'
import { vmHasClaudeCredential } from '../vm/vm-registry.mjs'
import { rustKernelBusy, rustKernelProcessUp, rustKernelReachable } from '../transport/rust-kernel-client.mjs'

/** 238 pool-scheduler `cooldownActive`. */
function cooldownActive(until, now) {
  return Number(until) > now
}

/** 238 `directWorkerAnswered`. */
function directWorkerAnswered(value) {
  return value?.ok === true || value?.engine === 'rust' || !!value?.worker_version
}

/**
 * @param {object} p
 * @param {object} p.vm raw vm.json record
 * @param {object|null} p.account accounts row (status, unified)
 * @param {object|null} p.state account runtime row (status, cooldown_*)
 * @param {object|null|undefined} p.health last worker health (undefined = never probed / too old)
 * @param {boolean} p.unreachable last probe could not reach the worker at all
 * @param {boolean} p.kernelFaulted kernelFaults has this VM
 * @param {string|null|undefined} p.workerProxyEndpoint worker.json proxy (undefined = not readable)
 * @param {string} p.egressMode worker.json egress_mode
 * @param {number|null} p.maxConcurrency effective request concurrency (null = unknown)
 * @returns {string|null} 238 rejection reason, or null when the node may be scheduled
 */
export function claudeNodeGate({
  vm,
  account = null,
  state = null,
  health = undefined,
  unreachable = false,
  kernelFaulted = false,
  workerProxyEndpoint = undefined,
  egressMode = '',
  maxConcurrency = null,
  now = Date.now(),
} = {}) {
  if (!vm) return null
  // PS238 checkEligibility: accounts row disabled.
  if (account && account.status && account.status !== 'active') return 'account_disabled'
  // schedule-eligibility evaluateSlotGate: SOCKS is mandatory.
  if (!slotHasBoundProxy(vm)) return 'proxy_required'
  const sync = evaluateProxySync({ vm, workerProxyEndpoint, egressMode })
  if (!sync.ok) return sync.reason
  if (kernelFaulted) return 'kernel_faulted'
  const dataPath = vmNodeDataPath(vm)
  const workerStatus = health === undefined ? null : health
  const workerUnavailable =
    unreachable ||
    (workerStatus != null &&
      ((dataPath === 'direct' && !directWorkerAnswered(workerStatus)) ||
        (dataPath === 'ssh' && workerStatus?.status === 0 && workerStatus.ok !== true)))
  if (dataPath === 'offline') return 'node_offline'
  // 238 probed the worker on demand before judging credentials. Telemetry only
  // has the cached probe: with none yet and nothing in vm.json, the answer is
  // unknown, not `no_credential`.
  const credentialKnown = workerStatus != null || workerUnavailable || vmHasClaudeCredential(vm)
  if (credentialKnown) {
    const cred = evaluateCredentialEligibility({ vm, workerStatus: workerUnavailable ? null : workerStatus, now })
    if (!cred.ok) return cred.reason
  }
  if (isCredentialRuntimeBlocked(state, now, vm)) return 'credential_blocked'
  if (maxConcurrency != null && Number.isFinite(Number(maxConcurrency)) && Number(maxConcurrency) <= 0) {
    return 'concurrency_disabled'
  }
  if (workerUnavailable) return 'node_offline'
  if (
    workerStatus &&
    !rustKernelBusy(workerStatus) &&
    rustKernelProcessUp(workerStatus) &&
    !rustKernelReachable(workerStatus)
  ) {
    return 'worker_unhealthy'
  }
  return null
}

/**
 * Per-request model gates 238 applied as `markWait` (the slot is busy for
 * this model; other slots are tried): per-model cooldown keys including the
 * Fable family key, the Fable 7d_oi window, and the weekly 50/50 split.
 * Returns the 238 wait reason, or null.
 */
export function claudeModelWaitGate({
  accountId,
  account = null,
  state = null,
  model,
  accountQuota = null,
  now = Date.now(),
} = {}) {
  const modelKey = normalizeModelKey(model)
  if (!modelKey) return null
  for (const key of modelCooldownKeys(modelKey)) {
    const modelState = state?.model_states?.[key]
    if (modelState && cooldownActive(modelState.cooldown_until, now)) {
      if (modelState.reason === 'fable_rate_limited') return 'fable_quota'
      return key === FABLE_FAMILY_KEY ? 'fable_cooldown' : 'model_cooldown'
    }
  }
  if (isFableModel(modelKey) && accountQuota?.fableWindowLimited?.(accountId, now, account || undefined)) {
    return 'fable_quota'
  }
  if (accountQuota?.weeklySplitOf) {
    const reason = splitBlocksModel(accountQuota.weeklySplitOf(accountId, account || undefined), modelKey)
    if (reason) return reason
  }
  return null
}
