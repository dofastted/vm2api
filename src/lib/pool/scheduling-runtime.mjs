/** Loaded scheduling state keeps eligibility checks and reservations synchronous. */
import { AccountRuntimeRepo } from '../db/repos/account-runtime-repo.mjs'
import { WriteQueue } from './write-queue.mjs'

export class SchedulingRuntime {
  constructor(db) {
    this.persistence = new AccountRuntimeRepo(db)
    this.rows = new Map()
    this.writes = this.persistence.db.schedulingWriteQueue ||= new WriteQueue(this.persistence.db)
  }

  async init() {
    await this.flush()
    this.rows = new Map((await this.persistence.list()).map((row) => [row.account_id, row]))
    return this
  }

  flush() {
    return this.writes.flush()
  }

  get(id) {
    return structuredClone(this.rows.get(id) || null)
  }

  list() {
    return [...this.rows.values()].map((row) => structuredClone(row))
  }

  upsert(input = {}) {
    if (!input.account_id || !input.vm_id) return null
    const current = this.get(input.account_id) || {}
    const next = {
      cooldown_until: null,
      cooldown_reason: null,
      last_used_at: null,
      credential_generation: 0,
      refresh_status: null,
      worker_heartbeat_at: null,
      worker_status: null,
      rate_limited_at: null,
      rate_limit_reset_at: null,
      overload_until: null,
      session_window_start: null,
      session_window_end: null,
      session_window_status: null,
      ...current,
      ...structuredClone(input),
      status: input.status ?? current.status ?? 'unknown',
      priority: Number(input.priority ?? current.priority ?? 0),
      weight: Math.max(0, Number(input.weight ?? current.weight ?? 1)),
      model_states: structuredClone(input.model_states ?? current.model_states ?? {}),
      updated_at: new Date().toISOString(),
    }
    this.rows.set(next.account_id, next)
    this.writes.enqueue(() => this.persistence.upsert(next))
    return structuredClone(next)
  }

  remove(id) {
    const removed = this.rows.delete(id)
    this.writes.enqueue(() => this.persistence.remove(id))
    return removed
  }

  updateWindow(
    accountId,
    {
      vmId = null,
      rateLimitedAt,
      rateLimitResetAt,
      overloadUntil,
      sessionWindowStart,
      sessionWindowEnd,
      sessionWindowStatus,
    } = {},
  ) {
    const current = this.get(accountId) || {
      account_id: accountId,
      vm_id: vmId,
      model_states: {},
    }
    if (!current.vm_id && vmId) current.vm_id = vmId
    if (!current.vm_id) return null
    if (rateLimitedAt !== undefined) current.rate_limited_at = rateLimitedAt
    if (rateLimitResetAt !== undefined) current.rate_limit_reset_at = rateLimitResetAt
    if (overloadUntil !== undefined) current.overload_until = overloadUntil
    if (sessionWindowStart !== undefined) current.session_window_start = sessionWindowStart
    if (sessionWindowEnd !== undefined) current.session_window_end = sessionWindowEnd
    if (sessionWindowStatus !== undefined) current.session_window_status = sessionWindowStatus
    return this.upsert(current)
  }

  markCooldown(accountId, { vmId, until, reason, model = null, status = 'cooldown' } = {}) {
    const current = this.get(accountId) || {
      account_id: accountId,
      vm_id: vmId,
      model_states: {},
    }
    if (model) {
      current.model_states = { ...(current.model_states || {}) }
      current.model_states[model] = {
        status,
        cooldown_until: Number(until) || null,
        reason: reason || null,
        updated_at: new Date().toISOString(),
      }
    } else {
      current.status = status
      current.cooldown_until = Number(until) || null
      current.cooldown_reason = reason || null
      // Structured mirror of the protocol-level limit (sub2api account columns).
      // overload_until is only the 529 hard column (RateLimitService.handle529).
      // A 502 failover also uses reason provider_overloaded for 15s; writing it
      // here paints every hopped VM as 过载冷却 and removes them from the pool.
      if (/rate_limited|quota_exhausted/i.test(String(reason || ''))) {
        current.rate_limited_at = Date.now()
        current.rate_limit_reset_at = Number(until) || null
      }
    }
    return this.upsert(current)
  }

  static AUTH_COOLDOWN = /authentication_failed_after_refresh|permission_denied/i

  static GRANT_REVOKE_COOLDOWN =
    /oauth_revoked|oauth_invalid_grant|invalid_grant|token has been revoked|oauth_no_refresh/i

  isAuthCooldown(state) {
    return SchedulingRuntime.AUTH_COOLDOWN.test(String(state?.cooldown_reason || ''))
  }

  isGrantRevokeCooldown(state) {
    return (
      SchedulingRuntime.GRANT_REVOKE_COOLDOWN.test(String(state?.cooldown_reason || '')) ||
      (String(state?.status || '') === 'disabled' &&
        SchedulingRuntime.GRANT_REVOKE_COOLDOWN.test(String(state?.cooldown_reason || state?.status || '')))
    )
  }

  clearAuthCooldown(accountId, { vmId = null } = {}) {
    const current = this.get(accountId)
    if (!current || !this.isAuthCooldown(current)) return false
    return !!this.upsert({
      ...current,
      vm_id: current.vm_id || vmId,
      status: 'ready',
      cooldown_until: null,
      cooldown_reason: null,
    })
  }

  clearGrantRevokeCooldown(accountId, { vmId = null } = {}) {
    const current = this.get(accountId)
    if (!current || !this.isGrantRevokeCooldown(current)) return false
    return !!this.upsert({
      ...current,
      vm_id: current.vm_id || vmId,
      status: 'ready',
      cooldown_until: null,
      cooldown_reason: null,
    })
  }

  clearAccountCooldown(accountId, { vmId = null } = {}) {
    const current = this.get(accountId)
    if (!current) return false
    return !!this.upsert({
      ...current,
      vm_id: current.vm_id || vmId,
      status: 'ready',
      cooldown_until: null,
      cooldown_reason: null,
      rate_limit_reset_at: null,
      overload_until: null,
      model_states: {},
    })
  }

  clearExpired(now = Date.now()) {
    for (const state of this.list()) {
      if (!state.vm_id) continue
      let changed = false
      if (state.cooldown_until && state.cooldown_until <= now) {
        state.status = 'ready'
        state.cooldown_until = null
        state.cooldown_reason = null
        changed = true
      }
      if (state.rate_limit_reset_at && state.rate_limit_reset_at <= now) {
        state.rate_limit_reset_at = null
        changed = true
      }
      if (state.overload_until && state.overload_until <= now) {
        state.overload_until = null
        changed = true
      }
      const models = { ...(state.model_states || {}) }
      for (const [model, modelState] of Object.entries(models)) {
        if (modelState?.cooldown_until && Number(modelState.cooldown_until) <= now) {
          delete models[model]
          changed = true
        }
      }
      if (changed) this.upsert({ ...state, model_states: models })
    }
  }
}
