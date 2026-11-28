/**
 * Admission gates v1.4.238's JS `PoolScheduler.checkEligibility` applied and
 * the M3 cutover did not carry into the Rust snapshot/telemetry.
 */
import { FABLE_FAMILY_KEY, isFableModel, modelCooldownKeys, normalizeModelKey } from '../pool/upstream-error-policy.mjs'
import { splitBlocksModel } from '../pool/weekly-split.mjs'

/** 238 pool-scheduler `cooldownActive`. */
function cooldownActive(until, now) {
  return Number(until) > now
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
