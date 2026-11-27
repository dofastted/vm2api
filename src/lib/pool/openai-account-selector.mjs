/**
 * OpenAI / Codex account blocker diagnostics (stateless).
 *
 * M3 cutover (D4): all OpenAI/Codex account selection, tiering, SWRR, sticky
 * affinity, cooldowns, and session serialization live solely in the Rust
 * `kin-scheduler` engine. Legacy Node scoring/sorting selectors were removed.
 */
import { isCodexSlotParked } from './codex-slot-pool.mjs'

/**
 * Pure diagnostic blocker label for an OpenAI/Codex slot (used by panel views
 * and telemetry builders; never performs Node-side scheduling selection).
 */
export function schedulingBlocker(candidate, context = {}) {
  if (!candidate || typeof candidate !== 'object') return 'invalid_candidate'
  if (candidate.status === 'disabled') return 'disabled'
  if (candidate.status === 'credential_failed') return 'credential_failed'
  if (candidate.status === 'missing_token') return 'missing_token'
  if (candidate.status === 'not_running') return 'not_running'
  if (candidate.status === 'unschedulable') return 'unschedulable'
  if (candidate.activeHoursBlocked === true) return 'active_hours'
  if (candidate.modelAllowed === false) return 'model_not_allowed'
  const now = Number(context.now) || Date.now()
  if (candidate.vm && isCodexSlotParked(candidate.vm, now, context.quotaPolicy || null)) {
    return 'quota_exhausted'
  }
  return null
}
