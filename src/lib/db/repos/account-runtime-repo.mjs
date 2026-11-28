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

import { getDb, getPgPool } from '../database.mjs'
import { maybeDecrypt } from '../secure.mjs'
import { rowToAccount } from './accounts-repo.mjs'

const ACCOUNT_SNAPSHOT_COLS = `id, vm_id, email, name, platform, type,
  status, schedulable, priority, rate_multiplier, concurrency,
  concurrency_override, max_rpm, rpm_override, requests,
  tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens,
  extra, updated_at, load_factor, last_used_at, created_at,
  temp_unschedulable_until, temp_unschedulable_reason, rate_limited_at,
  rate_limit_reset_at, overload_until, session_window_start,
  session_window_end, session_window_status`

const RUNTIME_SNAPSHOT_COLS = `account_id, vm_id, status, updated_at,
  model_states_json, credential_generation, refresh_status,
  worker_heartbeat_at, worker_status_json`

const SNAPSHOT_SELECT_CLAUSE = `SELECT a.id, a.vm_id, a.email, a.name, a.platform, a.type,
  a.status, a.schedulable, a.priority, a.rate_multiplier, a.concurrency,
  a.concurrency_override, a.max_rpm, a.rpm_override, a.requests,
  a.tokens_in, a.tokens_out, a.cache_read_tokens, a.cache_creation_tokens,
  a.extra, a.updated_at, a.load_factor, a.last_used_at, a.created_at,
  a.temp_unschedulable_until, a.temp_unschedulable_reason, a.rate_limited_at,
  a.rate_limit_reset_at, a.overload_until, a.session_window_start,
  a.session_window_end, a.session_window_status,
  r.account_id AS rt_account_id, r.vm_id AS rt_vm_id, r.status AS rt_status,
  r.updated_at AS rt_updated_at, r.model_states_json, r.credential_generation,
  r.refresh_status, r.worker_heartbeat_at, r.worker_status_json`

const ALL_SNAPSHOTS_SQL = `${SNAPSHOT_SELECT_CLAUSE}
  FROM accounts a FULL JOIN account_runtime r ON r.account_id = a.id`

const ALL_VMS_SQL = `SELECT id, name, status, schedulable, email, account_uuid, org_uuid,
  oauth_expires_at, oauth_source, proxy_id, claude_code_version,
  timezone, locale, vm_json, encrypted, file_mtime_ms, synced_at,
  created_at, updated_at, owner_user_id, origin
  FROM vms ORDER BY id`

const SNAPSHOT_BATCH_CHUNK = 500

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

function normalizeAccountIds(accountIds) {
  const unique = []
  const seen = new Set()
  for (const raw of accountIds || []) {
    if (raw == null || raw === '') continue
    const id = String(raw)
    if (!seen.has(id)) {
      seen.add(id)
      unique.push(id)
    }
  }
  return unique
}

function decodeSnapshotRow(row) {
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

function decodeVmRow(row) {
  if (!row?.id) return null
  let parsed = null
  if (row.vm_json) {
    try {
      const json = row.encrypted ? maybeDecrypt(row.vm_json) : row.vm_json
      parsed = JSON.parse(json)
    } catch {
      parsed = null
    }
  }
  if (parsed && typeof parsed === 'object') {
    return {
      ...parsed,
      id: parsed.id || row.id,
      ...(parsed.status == null && row.status != null ? { status: row.status } : {}),
      ...(parsed.schedulable === undefined && row.schedulable != null ? { schedulable: Boolean(row.schedulable) } : {}),
      ...(parsed.owner_user_id === undefined && row.owner_user_id != null ? { owner_user_id: row.owner_user_id } : {}),
      ...(parsed.origin === undefined && row.origin != null ? { origin: row.origin } : {}),
    }
  }
  return {
    id: row.id,
    name: row.name ?? null,
    status: row.status ?? 'unknown',
    schedulable: row.schedulable == null ? true : Boolean(row.schedulable),
    email: row.email ?? null,
    account_uuid: row.account_uuid ?? null,
    org_uuid: row.org_uuid ?? null,
    proxy_id: row.proxy_id ?? null,
    timezone: row.timezone ?? null,
    locale: row.locale ?? null,
    owner_user_id: row.owner_user_id ?? null,
    origin: row.origin ?? 'platform',
    claude: {
      email: row.email ?? null,
      account_uuid: row.account_uuid ?? null,
      org_uuid: row.org_uuid ?? null,
      expires_at: row.oauth_expires_at ?? null,
      source: row.oauth_source ?? null,
    },
  }
}

function buildFilteredSnapshotSql(placeholderExpr) {
  return `${SNAPSHOT_SELECT_CLAUSE}
    FROM (SELECT ${ACCOUNT_SNAPSHOT_COLS} FROM accounts WHERE id ${placeholderExpr}) a
    FULL JOIN (SELECT ${RUNTIME_SNAPSHOT_COLS} FROM account_runtime WHERE account_id ${placeholderExpr}) r
      ON r.account_id = a.id`
}

/**
 * Async PostgreSQL full scheduling snapshot loader (`accounts FULL JOIN account_runtime`).
 * Runs directly on `pgPool` off the main thread — 0 `Atomics.wait`.
 * @param {import('pg').Pool|null} pgPool
 * @returns {Promise<Map<string, { account: object|null, state: object|null, runtime: object|null }>>}
 */
export async function listAllSnapshotsAsync(pgPool) {
  const result = new Map()
  if (!pgPool || typeof pgPool.query !== 'function') return result
  const res = await pgPool.query(ALL_SNAPSHOTS_SQL)
  for (const row of res?.rows || []) {
    const key = row.id ?? row.rt_account_id
    if (key == null) continue
    const decoded = decodeSnapshotRow(row)
    result.set(String(key), { ...decoded, runtime: decoded.state })
  }
  return result
}

/**
 * Async PostgreSQL credential-free VM metadata snapshot loader (`vms` table).
 * Runs directly on `pgPool` off the main thread — 0 `Atomics.wait`.
 * @param {import('pg').Pool|null} pgPool
 * @returns {Promise<Map<string, object>>}
 */
export async function listAllVmsAsync(pgPool) {
  const result = new Map()
  if (!pgPool || typeof pgPool.query !== 'function') return result
  const res = await pgPool.query(ALL_VMS_SQL)
  for (const row of res?.rows || []) {
    const vm = decodeVmRow(row)
    if (vm?.id) result.set(String(vm.id), vm)
  }
  return result
}

export class AccountRuntimeRepo {
  constructor(db = getDb()) {
    this.db = db
    // Index-friendly PK subqueries on both `accounts` and `account_runtime` (0 seq_scan in PG 18).
    this._snapshotOne = db.prepare(buildFilteredSnapshotSql('= ?'))
    this._allSnapshots = db.prepare(ALL_SNAPSHOTS_SQL)
    try {
      this._allVms = db.prepare(ALL_VMS_SQL)
    } catch {
      this._allVms = null
    }
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
    const unique = normalizeAccountIds(accountIds)
    const result = new Map()
    if (!unique.length) return result
    if (unique.length === 1) {
      const id = unique[0]
      for (const row of this._snapshotOne.all(id, id)) {
        const key = row.id ?? row.rt_account_id
        if (key != null) result.set(String(key), this.snapshotRow(row))
      }
      return result
    }
    for (let i = 0; i < unique.length; i += SNAPSHOT_BATCH_CHUNK) {
      const chunk = unique.slice(i, i + SNAPSHOT_BATCH_CHUNK)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = this.db.prepare(buildFilteredSnapshotSql(`IN (${placeholders})`)).all(...chunk, ...chunk)
      for (const row of rows) {
        const key = row.id ?? row.rt_account_id
        if (key != null) result.set(String(key), this.snapshotRow(row))
      }
    }
    return result
  }

  /**
   * Async PK-indexed batch scheduling snapshot for specific account IDs.
   * Uses `= ANY($1::text[])` on `pgPool` (0 `Atomics.wait`, 0 `seq_scan`),
   * falling back to `schedulingSnapshot()` on SQLite.
   */
  async schedulingSnapshotAsync(accountIds, pgPool = null) {
    const unique = normalizeAccountIds(accountIds)
    if (!unique.length) return new Map()
    const pool = pgPool || (this.db?.engine === 'postgres' ? getPgPool() : null)
    if (!pool || typeof pool.query !== 'function') {
      return this.schedulingSnapshot(unique)
    }
    const result = new Map()
    const sql = buildFilteredSnapshotSql('= ANY($1::text[])')
    for (let i = 0; i < unique.length; i += SNAPSHOT_BATCH_CHUNK) {
      const chunk = unique.slice(i, i + SNAPSHOT_BATCH_CHUNK)
      const res = await pool.query(sql, [chunk])
      for (const row of res?.rows || []) {
        const key = row.id ?? row.rt_account_id
        if (key != null) result.set(String(key), this.snapshotRow(row))
      }
    }
    return result
  }

  /** Synchronous full scheduling snapshot (`accounts FULL JOIN account_runtime`). */
  listAllSnapshots() {
    const result = new Map()
    for (const row of this._allSnapshots.all()) {
      const key = row.id ?? row.rt_account_id
      if (key == null) continue
      const decoded = this.snapshotRow(row)
      result.set(String(key), { ...decoded, runtime: decoded.state })
    }
    return result
  }

  /**
   * Async full scheduling snapshot: runs directly on `pgPool` in PostgreSQL mode
   * (0 `Atomics.wait`), or falls back to SQLite `listAllSnapshots()`.
   */
  async listAllSnapshotsAsync(pgPool = null) {
    const pool = pgPool || (this.db?.engine === 'postgres' ? getPgPool() : null)
    if (pool && typeof pool.query === 'function') {
      return listAllSnapshotsAsync(pool)
    }
    return this.listAllSnapshots()
  }

  /**
   * Async credential-free VM metadata snapshot: runs directly on `pgPool` in
   * PostgreSQL mode (0 `Atomics.wait`), or decodes from SQLite `vms` table.
   */
  async listAllVmsAsync(pgPool = null) {
    const pool = pgPool || (this.db?.engine === 'postgres' ? getPgPool() : null)
    if (pool && typeof pool.query === 'function') {
      return listAllVmsAsync(pool)
    }
    const result = new Map()
    if (!this._allVms) return result
    for (const row of this._allVms.all()) {
      const vm = decodeVmRow(row)
      if (vm?.id) result.set(String(vm.id), vm)
    }
    return result
  }

  snapshotRow(row) {
    return decodeSnapshotRow(row)
  }

  get(accountId) {
    return this.schedulingSnapshot([accountId]).get(accountId)?.state || null
  }

  /**
   * Batch-read merged runtime state for many account IDs using index-friendly
   * PK `IN (...)` subqueries on both `accounts` and `account_runtime` (1 RPC per chunk).
   * @param {Iterable<string>} accountIds
   * @returns {Map<string, object>}
   */
  getMany(accountIds) {
    const unique = []
    const seen = new Set()
    for (const raw of accountIds || []) {
      if (raw == null || raw === '') continue
      const id = String(raw)
      if (!seen.has(id)) {
        seen.add(id)
        unique.push(id)
      }
    }
    const result = new Map()
    if (!unique.length) return result
    const CHUNK = 500
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = this.db
        .prepare(`
          SELECT a.id, a.vm_id, a.priority, a.load_factor, a.last_used_at,
                 a.temp_unschedulable_until, a.temp_unschedulable_reason,
                 a.rate_limited_at, a.rate_limit_reset_at, a.overload_until,
                 a.session_window_start, a.session_window_end, a.session_window_status,
                 a.updated_at,
                 r.account_id AS rt_account_id, r.vm_id AS rt_vm_id, r.status AS rt_status,
                 r.updated_at AS rt_updated_at, r.model_states_json, r.credential_generation,
                 r.refresh_status, r.worker_heartbeat_at, r.worker_status_json
          FROM (
            SELECT id, vm_id, priority, load_factor, last_used_at,
                   temp_unschedulable_until, temp_unschedulable_reason,
                   rate_limited_at, rate_limit_reset_at, overload_until,
                   session_window_start, session_window_end, session_window_status,
                   updated_at
            FROM accounts WHERE id IN (${placeholders})
          ) a
          FULL JOIN (
            SELECT account_id, vm_id, status, updated_at, model_states_json,
                   credential_generation, refresh_status, worker_heartbeat_at,
                   worker_status_json
            FROM account_runtime WHERE account_id IN (${placeholders})
          ) r ON r.account_id = a.id
        `)
        .all(...chunk, ...chunk)
      for (const row of rows) {
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
        const state = mergeState(runtime, account)
        if (state?.account_id) result.set(state.account_id, state)
      }
    }
    return result
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
