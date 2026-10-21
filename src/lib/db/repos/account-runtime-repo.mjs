/**
 * Account runtime state — facade over two tables (sub2api SSOT split).
 *
 * Persistent scheduling fields (priority, cooldown → temp_unschedulable_*,
 * rate_limited_at / rate_limit_reset_at / overload_until, session_window_*,
 * last_used_at, load_factor) live on `accounts` as ISO-8601 TEXT, matching
 * the sub2api Account columns. High-frequency worker transients (heartbeat,
 * worker status, per-model cooldowns, credential generation) live in the thin
 * `account_runtime` table. Callers keep the historical merged-state shape
 * with ms-epoch numbers; conversion happens here.
 */

import { getDb, withTransaction } from '../database.mjs'

function parse(value, fallback = null) {
  if (value == null) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function toMs(iso) {
  if (iso == null) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function toIso(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return null
  // MAX_SAFE_INTEGER is used as a "forever" sentinel — clamp to the ISO range
  return new Date(Math.min(n, 8.64e15)).toISOString()
}

function mergeState(rt, acc) {
  if (!rt && !acc) return null
  return {
    account_id: rt?.account_id ?? acc?.id,
    vm_id: rt?.vm_id ?? acc?.vm_id ?? null,
    status: rt?.status || 'unknown',
    priority: Number(acc?.priority) || 0,
    weight: Math.max(0, Number(acc?.load_factor) || 0),
    cooldown_until: toMs(acc?.temp_unschedulable_until),
    cooldown_reason: acc?.temp_unschedulable_reason || null,
    model_states: parse(rt?.model_states_json, {}),
    last_used_at: toMs(acc?.last_used_at),
    credential_generation: Number(rt?.credential_generation) || 0,
    refresh_status: rt?.refresh_status || null,
    worker_heartbeat_at: rt?.worker_heartbeat_at == null ? null : Number(rt.worker_heartbeat_at),
    worker_status: parse(rt?.worker_status_json),
    rate_limited_at: toMs(acc?.rate_limited_at),
    rate_limit_reset_at: toMs(acc?.rate_limit_reset_at),
    overload_until: toMs(acc?.overload_until),
    session_window_start: toMs(acc?.session_window_start),
    session_window_end: toMs(acc?.session_window_end),
    session_window_status: acc?.session_window_status || null,
    updated_at: rt?.updated_at ?? acc?.updated_at ?? null,
  }
}

export class AccountRuntimeRepo {
  constructor(db = getDb()) {
    this.db = db
    this._getRt = db.prepare('SELECT * FROM account_runtime WHERE account_id = $1')
    this._getAcc = db.prepare(`
      SELECT id, vm_id, priority, load_factor, last_used_at,
             temp_unschedulable_until, temp_unschedulable_reason,
             rate_limited_at, rate_limit_reset_at, overload_until,
             session_window_start, session_window_end, session_window_status,
             updated_at
      FROM accounts WHERE id = $1
    `)
    this._listIds = db.prepare(`
      SELECT account_id FROM account_runtime
      UNION SELECT id FROM accounts
      ORDER BY 1
    `)
    this._ensureAcc = db.prepare(`
      INSERT INTO accounts (id, vm_id, name, extra, created_at, updated_at)
      VALUES ($1, $2, $3, '{}', $4, $5)
      ON CONFLICT(id) DO NOTHING
    `)
    this._linkDefaultGroup = db.prepare(`
      INSERT INTO account_groups (account_id, group_id, priority, created_at)
      VALUES ($1, 1, 50, $2)
      ON CONFLICT(account_id, group_id) DO NOTHING
    `)
    this._updateAcc = db.prepare(`
      UPDATE accounts SET
        vm_id = $1,
        priority = $2, load_factor = $3, last_used_at = $4,
        temp_unschedulable_until = $5, temp_unschedulable_reason = $6,
        rate_limited_at = $7, rate_limit_reset_at = $8, overload_until = $9,
        session_window_start = $10, session_window_end = $11, session_window_status = $12,
        updated_at = $13
      WHERE id = $14
    `)
    this._upsertRt = db.prepare(`
      INSERT INTO account_runtime (
        account_id, vm_id, status, model_states_json, credential_generation,
        refresh_status, worker_heartbeat_at, worker_status_json, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT(account_id) DO UPDATE SET
        vm_id = excluded.vm_id,
        status = excluded.status,
        model_states_json = excluded.model_states_json,
        credential_generation = excluded.credential_generation,
        refresh_status = excluded.refresh_status,
        worker_heartbeat_at = excluded.worker_heartbeat_at,
        worker_status_json = excluded.worker_status_json,
        updated_at = excluded.updated_at
    `)
    this._removeRt = db.prepare('DELETE FROM account_runtime WHERE account_id = $1')
  }

  async get(accountId) {
    const rt = await this._getRt.get(accountId)
    const acc = await this._getAcc.get(accountId)
    if (!rt && !acc) return null
    return mergeState(rt, acc)
  }

  async list() {
    const ids = await this._listIds.all()
    return (await Promise.all(ids.map((r) => this.get(r.account_id ?? r.id)))).filter(Boolean)
  }

  async upsert(input = {}) {
    return withTransaction(this.db, async () => {
      await this.db.prepare('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))').get(String(input.account_id))

      if (!input.account_id || !input.vm_id) return null
      const current = (await this.get(input.account_id)) || {}
      const next = {
        ...current,
        ...input,
        status: input.status ?? current.status ?? 'unknown',
        priority: Number(input.priority ?? current.priority ?? 0),
        weight: Math.max(0, Number(input.weight ?? current.weight ?? 1)),
        model_states: input.model_states ?? current.model_states ?? {},
        updated_at: new Date().toISOString(),
      }
      await this._ensureAcc.run(next.account_id, next.vm_id, next.account_id, next.updated_at, next.updated_at)
      await this._linkDefaultGroup.run(next.account_id, next.updated_at)
      await this._updateAcc.run(
        next.vm_id,
        next.priority,
        next.weight,
        toIso(next.last_used_at),
        toIso(next.cooldown_until),
        next.cooldown_reason ?? null,
        toIso(next.rate_limited_at),
        toIso(next.rate_limit_reset_at),
        toIso(next.overload_until),
        toIso(next.session_window_start),
        toIso(next.session_window_end),
        next.session_window_status ?? null,
        next.updated_at,
        next.account_id,
      )
      await this._upsertRt.run(
        next.account_id,
        next.vm_id,
        next.status,
        JSON.stringify(next.model_states || {}),
        next.credential_generation ?? 0,
        next.refresh_status ?? null,
        next.worker_heartbeat_at ?? null,
        next.worker_status != null ? JSON.stringify(next.worker_status) : null,
        next.updated_at,
      )
      return await this.get(next.account_id)
    })
  }

  /**
   * Structured rate-limit / session-window write-through
   * (sub2api account.rate_limited_at / rate_limit_reset_at / overload_until /
   *  session_window_* counterpart). Only provided fields are updated.
   */
  async updateWindow(
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
    return withTransaction(this.db, async () => {
      await this.db.prepare('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))').get(String(accountId))

      const current = (await this.get(accountId)) || {
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
      return await this.upsert(current)
    })
  }

  async markCooldown(accountId, { vmId, until, reason, model = null, status = 'cooldown' } = {}) {
    return withTransaction(this.db, async () => {
      await this.db.prepare('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))').get(String(accountId))

      const current = (await this.get(accountId)) || {
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
      return await this.upsert(current)
    })
  }

  /** Stale-access 401 / 403 permission — not quota, Fable, or 429. */
  static AUTH_COOLDOWN = /authentication_failed_after_refresh|permission_denied/i
  /** Grant-death leftover. A later live ticket must drop this or the panel stays revoke. */
  static GRANT_REVOKE_COOLDOWN =
    /oauth_revoked|oauth_invalid_grant|invalid_grant|token has been revoked|oauth_no_refresh/i

  isAuthCooldown(state) {
    return AccountRuntimeRepo.AUTH_COOLDOWN.test(String(state?.cooldown_reason || ''))
  }

  isGrantRevokeCooldown(state) {
    return (
      AccountRuntimeRepo.GRANT_REVOKE_COOLDOWN.test(String(state?.cooldown_reason || '')) ||
      (String(state?.status || '') === 'disabled' &&
        AccountRuntimeRepo.GRANT_REVOKE_COOLDOWN.test(String(state?.cooldown_reason || state?.status || '')))
    )
  }

  /** Worker fresh / refresh success: drop only auth leftover so quota cools stay. */
  async clearAuthCooldown(accountId, { vmId = null } = {}) {
    return withTransaction(this.db, async () => {
      await this.db.prepare('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))').get(String(accountId))

      const current = await this.get(accountId)
      if (!current || !this.isAuthCooldown(current)) return false
      return !!(await this.upsert({
        ...current,
        vm_id: current.vm_id || vmId,
        status: 'ready',
        cooldown_until: null,
        cooldown_reason: null,
      }))
    })
  }

  /** Live login / import: drop leftover oauth_revoked disable. Quota cools stay. */
  async clearGrantRevokeCooldown(accountId, { vmId = null } = {}) {
    return withTransaction(this.db, async () => {
      await this.db.prepare('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))').get(String(accountId))

      const current = await this.get(accountId)
      if (!current || !this.isGrantRevokeCooldown(current)) return false
      return !!(await this.upsert({
        ...current,
        vm_id: current.vm_id || vmId,
        status: 'ready',
        cooldown_until: null,
        cooldown_reason: null,
      }))
    })
  }

  /** Operator / panel: drop account + per-model cooldown leftovers. */
  async clearAccountCooldown(accountId, { vmId = null } = {}) {
    return withTransaction(this.db, async () => {
      await this.db.prepare('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))').get(String(accountId))

      const current = await this.get(accountId)
      if (!current) return false
      return !!(await this.upsert({
        ...current,
        vm_id: current.vm_id || vmId,
        status: 'ready',
        cooldown_until: null,
        cooldown_reason: null,
        rate_limit_reset_at: null,
        overload_until: null,
        model_states: {},
      }))
    })
  }

  async clearExpired(now = Date.now()) {
    for (const id of await this._listIds.all()) {
      await withTransaction(this.db, async () => {
        const accountId = id.account_id ?? id.id
        await this.db.prepare('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))').get(String(accountId))
        const state = await this.get(accountId)
        if (!state?.vm_id) return
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
        if (changed) await this.upsert({ ...state, model_states: models })
      })
    }
  }

  async remove(accountId) {
    return (await this._removeRt.run(accountId)).changes > 0
  }
}
