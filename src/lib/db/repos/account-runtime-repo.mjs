/**
 * Account runtime state — facade over persistent and transient state tables.
 *
 * Persistent scheduling fields (priority, cooldown → temp_unschedulable_*,
 * rate_limited_at / rate_limit_reset_at / overload_until, session_window_*,
 * last_used_at, load_factor) live on `accounts` as ISO-8601 TEXT.
 * High-frequency worker transients (heartbeat, worker status, per-model
 * cooldowns, credential generation) live in the thin `account_runtime` table.
 * Callers keep the historical merged-state shape with ms-epoch numbers;
 * conversion happens here.
 */

import { getDb } from '../database.mjs'
import { rowToAccount } from './accounts-repo.mjs'

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
    const snapshot = `SELECT a.id, a.vm_id, a.email, a.name, a.platform, a.type,
      a.status, a.schedulable, a.priority, a.rate_multiplier, a.concurrency,
      a.concurrency_override, a.max_rpm, a.rpm_override, a.requests,
      a.tokens_in, a.tokens_out, a.cache_read_tokens, a.cache_creation_tokens,
      a.extra, a.updated_at, a.load_factor, a.last_used_at, a.created_at,
      a.temp_unschedulable_until, a.temp_unschedulable_reason, a.rate_limited_at,
      a.rate_limit_reset_at, a.overload_until, a.session_window_start,
      a.session_window_end, a.session_window_status,
      r.account_id AS rt_account_id, r.vm_id AS rt_vm_id, r.status AS rt_status,
      r.updated_at AS rt_updated_at, r.model_states_json, r.credential_generation,
      r.refresh_status, r.worker_heartbeat_at, r.worker_status_json
      FROM accounts a FULL JOIN account_runtime r ON r.account_id = a.id`
    this._snapshots = db.prepare(snapshot + ' WHERE COALESCE(a.id, r.account_id) IN (SELECT value FROM json_each(?))')
    this._allSnapshots = db.prepare(snapshot)
    this._heartbeat = db.prepare(`INSERT INTO account_runtime
      (account_id, vm_id, status, worker_heartbeat_at, worker_status_json,
       credential_generation, refresh_status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        status = CASE WHEN account_runtime.status IN ('disabled','cooldown','rate_limited')
          THEN account_runtime.status ELSE excluded.status END,
        worker_heartbeat_at = excluded.worker_heartbeat_at,
        worker_status_json = excluded.worker_status_json,
        credential_generation = MAX(account_runtime.credential_generation, excluded.credential_generation),
        refresh_status = excluded.refresh_status,
        updated_at = excluded.updated_at
      WHERE COALESCE(account_runtime.worker_heartbeat_at, 0) <= excluded.worker_heartbeat_at`)
    this._ensureAcc = db.prepare(`
      INSERT OR IGNORE INTO accounts (id, vm_id, name, extra, created_at, updated_at)
      VALUES (?, ?, ?, '{}', ?, ?)
    `)
    this._updateAcc = db.prepare(`
      UPDATE accounts SET
        vm_id = ?,
        priority = ?, load_factor = ?, last_used_at = ?,
        temp_unschedulable_until = ?, temp_unschedulable_reason = ?,
        rate_limited_at = ?, rate_limit_reset_at = ?, overload_until = ?,
        session_window_start = ?, session_window_end = ?, session_window_status = ?,
        updated_at = ?
      WHERE id = ?
    `)
    this._upsertRt = db.prepare(`
      INSERT INTO account_runtime (
        account_id, vm_id, status, model_states_json, credential_generation,
        refresh_status, worker_heartbeat_at, worker_status_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        vm_id = excluded.vm_id,
        status = excluded.status,
        model_states_json = excluded.model_states_json,
        credential_generation = MAX(account_runtime.credential_generation, excluded.credential_generation),
        refresh_status = CASE WHEN COALESCE(excluded.worker_heartbeat_at, 0) >= COALESCE(account_runtime.worker_heartbeat_at, 0) THEN excluded.refresh_status ELSE account_runtime.refresh_status END,
        worker_heartbeat_at = MAX(COALESCE(account_runtime.worker_heartbeat_at, 0), COALESCE(excluded.worker_heartbeat_at, 0)),
        worker_status_json = CASE WHEN COALESCE(excluded.worker_heartbeat_at, 0) >= COALESCE(account_runtime.worker_heartbeat_at, 0) THEN excluded.worker_status_json ELSE account_runtime.worker_status_json END,
        updated_at = excluded.updated_at
    `)
    this._removeRt = db.prepare('DELETE FROM account_runtime WHERE account_id = ?')
  }

  schedulingSnapshot(accountIds) {
    if (!accountIds.length) return new Map()
    return new Map(
      this._snapshots
        .all(JSON.stringify(accountIds))
        .map((row) => [row.id ?? row.rt_account_id, this.snapshotRow(row)]),
    )
  }

  snapshotRow(row) {
    const account = row.id == null ? null : row
    const runtime =
      row.rt_account_id == null
        ? null
        : {
            ...row,
            account_id: row.rt_account_id,
            vm_id: row.rt_vm_id,
            status: row.rt_status,
            updated_at: row.rt_updated_at,
          }
    return { account: rowToAccount(account), state: mergeState(runtime, account) }
  }

  get(accountId) {
    return this.schedulingSnapshot([accountId]).get(accountId)?.state || null
  }

  list() {
    return this._allSnapshots.all().map((row) => this.snapshotRow(row).state)
  }

  writeHeartbeat(input) {
    this._heartbeat.run(
      input.account_id,
      input.vm_id,
      input.status,
      input.worker_heartbeat_at,
      JSON.stringify(input.worker_status),
      input.credential_generation,
      input.refresh_status,
      new Date().toISOString(),
    )
  }

  upsert(input = {}) {
    if (!input.account_id || !input.vm_id) return null
    const current = this.get(input.account_id) || {}
    const next = {
      ...current,
      ...input,
      status: input.status ?? current.status ?? 'unknown',
      priority: Number(input.priority ?? current.priority ?? 0),
      weight: Math.max(0, Number(input.weight ?? current.weight ?? 1)),
      model_states: input.model_states ?? current.model_states ?? {},
      updated_at: new Date().toISOString(),
    }
    this._ensureAcc.run(next.account_id, next.vm_id, next.account_id, next.updated_at, next.updated_at)
    this._updateAcc.run(
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
    this._upsertRt.run(
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
    return this.get(next.account_id)
  }

  /**
   * Write through structured rate-limit and session-window fields on `accounts`
   * (rate_limited_at / rate_limit_reset_at / overload_until / session_window_*).
   * Only provided fields are updated.
   */
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
      // Mirror the protocol-level limit in the account's rate-limit fields.
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

  /** Stale-access 401 / 403 permission — not quota, Fable, or 429. */
  static AUTH_COOLDOWN = /authentication_failed_after_refresh|permission_denied/i
  /** Grant-death leftover. A later live ticket must drop this or the panel stays revoke. */
  static GRANT_REVOKE_COOLDOWN =
    /oauth_revoked|oauth_invalid_grant|invalid_grant|token has been revoked|token_revoked|invalidated oauth token|oauth_no_refresh/i

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

  /** Live login / import: drop leftover oauth_revoked disable. Quota cools stay. */
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

  /** Operator / panel: drop account + per-model cooldown leftovers. */
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

  remove(accountId) {
    return this._removeRt.run(accountId).changes > 0
  }
}
