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
import { isDeepStrictEqual } from 'node:util'

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
    vm_id: acc?.vm_id ?? rt?.vm_id ?? null,
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
    updated_at: acc?.updated_at ?? rt?.updated_at ?? null,
  }
}

const ACCOUNT_FIELDS = {
  vm_id: 'vm_id',
  priority: 'priority',
  weight: 'load_factor',
  last_used_at: 'last_used_at',
  cooldown_until: 'temp_unschedulable_until',
  cooldown_reason: 'temp_unschedulable_reason',
  rate_limited_at: 'rate_limited_at',
  rate_limit_reset_at: 'rate_limit_reset_at',
  overload_until: 'overload_until',
  session_window_start: 'session_window_start',
  session_window_end: 'session_window_end',
  session_window_status: 'session_window_status',
}
const RUNTIME_FIELDS = {
  vm_id: 'vm_id',
  status: 'status',
  credential_generation: 'credential_generation',
  refresh_status: 'refresh_status',
  worker_heartbeat_at: 'worker_heartbeat_at',
  worker_status: 'worker_status_json',
}
const TIMES = new Set([
  'last_used_at',
  'cooldown_until',
  'rate_limited_at',
  'rate_limit_reset_at',
  'overload_until',
  'session_window_start',
  'session_window_end',
])

function overlaps(left, right) {
  return left.slice(0, Math.min(left.length, right.length)).every((key, i) => key === right[i])
}

function accepts(versions, path, sequence) {
  // Share 008's sequence and row-locked ledger with account observations;
  // the runtime prefix keeps their field versions independent.
  return !Object.entries(versions).some(([key, value]) => overlaps(JSON.parse(key), path) && BigInt(value) > sequence)
}

export class AccountRuntimeRepo {
  constructor(db = getDb()) {
    this.db = db
  }

  async beginObservation() {
    return (await this.db.prepare("SELECT nextval('account_observation_seq') AS observation").get()).observation
  }

  async get(accountId) {
    const row = await this.db
      .prepare(`SELECT to_jsonb(r) AS runtime, to_jsonb(a) AS account
      FROM account_runtime r FULL OUTER JOIN accounts a ON a.id = r.account_id
      WHERE COALESCE(r.account_id, a.id) = $1`)
      .get(accountId)
    return row ? mergeState(row.runtime, row.account) : null
  }

  async list() {
    return (
      await this.db
        .prepare(`SELECT to_jsonb(r) AS runtime, to_jsonb(a) AS account
      FROM account_runtime r FULL OUTER JOIN accounts a ON a.id = r.account_id
      ORDER BY COALESCE(r.account_id, a.id)`)
        .all()
    ).map((row) => mergeState(row.runtime, row.account))
  }

  async lockAccount(accountId, vmId) {
    if (vmId) {
      const now = new Date().toISOString()
      await this.db
        .prepare(`INSERT INTO accounts (id, vm_id, name, extra, priority, load_factor, created_at, updated_at)
        VALUES ($1,$2,$1,'{}',0,1,$3,$3) ON CONFLICT(id) DO NOTHING`)
        .run(accountId, vmId, now)
      await this.db
        .prepare(`INSERT INTO account_groups (account_id, group_id, priority, created_at)
        VALUES ($1,1,50,$2) ON CONFLICT(account_id,group_id) DO NOTHING`)
        .run(accountId, now)
    }
    const account = await this.db.prepare('SELECT * FROM accounts WHERE id = $1 FOR UPDATE').get(accountId)
    if (account && !account.vm_id && vmId) {
      return this.db
        .prepare('UPDATE accounts SET vm_id = $2 WHERE id = $1 AND vm_id IS NULL RETURNING *')
        .get(accountId, vmId)
    }
    return account
  }

  async patch(accountId, fields, { vmId, observation, modelPatch, clearModels = false, expected, condition } = {}) {
    const sequence = BigInt(await (observation ?? this.beginObservation()))
    return withTransaction(this.db, async () => {
      const account = await this.lockAccount(accountId, vmId)
      if (!account) return null
      const runtime = await this.db.prepare('SELECT * FROM account_runtime WHERE account_id = $1').get(accountId)
      const current = mergeState(runtime, account)
      if (!current.vm_id && !vmId && !fields.vm_id) return null
      if (condition && !condition(current)) return null
      if (expected && Object.entries(expected).some(([key, value]) => !isDeepStrictEqual(current[key], value)))
        return null
      const versions = account.observation_versions || {}
      const acc = {}
      const rt = {}
      let accepted = false
      for (const [field, value] of Object.entries(fields)) {
        if (value === undefined || (!Object.hasOwn(ACCOUNT_FIELDS, field) && !Object.hasOwn(RUNTIME_FIELDS, field)))
          continue
        const path = ['runtime', field]
        if (!accepts(versions, path, sequence)) continue
        versions[JSON.stringify(path)] = sequence.toString()
        accepted = true
        if (Object.hasOwn(ACCOUNT_FIELDS, field)) acc[ACCOUNT_FIELDS[field]] = TIMES.has(field) ? toIso(value) : value
        if (Object.hasOwn(RUNTIME_FIELDS, field))
          rt[RUNTIME_FIELDS[field]] = field === 'worker_status' && value != null ? JSON.stringify(value) : value
      }
      let models = { ...(current.model_states || {}) }
      let modelsChanged = false
      if (clearModels && accepts(versions, ['runtime', 'model_states'], sequence)) {
        models = {}
        versions[JSON.stringify(['runtime', 'model_states'])] = sequence.toString()
        modelsChanged = true
      }
      for (const [model, value] of Object.entries(modelPatch || {})) {
        const path = ['runtime', 'model_states', model]
        if (!accepts(versions, path, sequence)) continue
        if (value == null) delete models[model]
        else Object.defineProperty(models, model, { value, enumerable: true, writable: true, configurable: true })
        versions[JSON.stringify(path)] = sequence.toString()
        modelsChanged = true
      }
      if (modelsChanged) {
        rt.model_states_json = JSON.stringify(models)
        accepted = true
      }
      if (!accepted) return current
      const now = new Date().toISOString()
      await this.db
        .prepare(`INSERT INTO account_runtime (account_id, vm_id, updated_at)
        VALUES ($1,$2,$3) ON CONFLICT(account_id) DO NOTHING`)
        .run(accountId, current.vm_id || vmId, now)
      if (Object.keys(rt).length) {
        const values = Object.values(rt)
        const assignments = Object.keys(rt).map((key, i) => `${key} = $${i + 1}`)
        values.push(now, accountId)
        await this.db
          .prepare(`UPDATE account_runtime SET ${assignments.join(', ')}, updated_at = $${values.length - 1}
          WHERE account_id = $${values.length}`)
          .run(...values)
      }
      const values = [...Object.values(acc), JSON.stringify(versions), now, accountId]
      const assignments = Object.keys(acc).map((key, i) => `${key} = $${i + 1}`)
      assignments.push(`observation_versions = $${values.length - 2}::jsonb`, `updated_at = $${values.length - 1}`)
      await this.db.prepare(`UPDATE accounts SET ${assignments.join(', ')} WHERE id = $${values.length}`).run(...values)
      return this.get(accountId)
    })
  }

  async upsert(input = {}, options = {}) {
    if (!input.account_id || (input.vm_id !== undefined && !input.vm_id)) return null
    const fields = { ...input }
    if (input.priority !== undefined) fields.priority = Number(input.priority) || 0
    if (input.weight !== undefined) fields.weight = Math.max(0, Number(input.weight) || 0)
    if (input.credential_generation !== undefined)
      fields.credential_generation = Number(input.credential_generation) || 0
    return this.patch(input.account_id, fields, { vmId: input.vm_id, modelPatch: input.model_states, ...options })
  }

  async updateWindow(accountId, { vmId = null, observation, ...input } = {}) {
    const fields = {}
    for (const [key, field] of Object.entries({
      rateLimitedAt: 'rate_limited_at',
      rateLimitResetAt: 'rate_limit_reset_at',
      overloadUntil: 'overload_until',
      sessionWindowStart: 'session_window_start',
      sessionWindowEnd: 'session_window_end',
      sessionWindowStatus: 'session_window_status',
    })) {
      if (input[key] !== undefined) fields[field] = input[key]
    }
    return this.patch(accountId, fields, { vmId, observation })
  }

  async markCooldown(accountId, { vmId, until, reason, model = null, status = 'cooldown', observation } = {}) {
    const cooldown = Number(until) || null
    if (model)
      return this.patch(
        accountId,
        {},
        {
          vmId,
          observation,
          modelPatch: {
            [model]: { status, cooldown_until: cooldown, reason: reason || null, updated_at: new Date().toISOString() },
          },
        },
      )
    return this.patch(
      accountId,
      {
        status,
        cooldown_until: cooldown,
        cooldown_reason: reason || null,
        ...(/rate_limited|quota_exhausted/i.test(String(reason || ''))
          ? { rate_limited_at: Date.now(), rate_limit_reset_at: cooldown }
          : {}),
      },
      { vmId, observation },
    )
  }

  static AUTH_COOLDOWN = /authentication_failed_after_refresh|permission_denied/i
  static GRANT_REVOKE_COOLDOWN =
    /oauth_revoked|oauth_invalid_grant|invalid_grant|token has been revoked|oauth_no_refresh/i

  isAuthCooldown(state) {
    return AccountRuntimeRepo.AUTH_COOLDOWN.test(String(state?.cooldown_reason || ''))
  }
  isGrantRevokeCooldown(state) {
    return AccountRuntimeRepo.GRANT_REVOKE_COOLDOWN.test(String(state?.cooldown_reason || ''))
  }
  isQuotaCooldown(state, now = Date.now()) {
    return (
      !(Number(state?.rate_limit_reset_at) > now || Number(state?.overload_until) > now) &&
      (!state?.cooldown_reason || /quota|account_quota_exhausted|rate_limited/i.test(String(state.cooldown_reason))) &&
      !!(state?.cooldown_until || state?.cooldown_reason)
    )
  }

  async clearAuthCooldown(accountId, { vmId, observation, expected } = {}) {
    return !!(await this.patch(
      accountId,
      { status: 'ready', cooldown_until: null, cooldown_reason: null },
      { vmId, observation, expected, condition: (state) => this.isAuthCooldown(state) },
    ))
  }

  async clearGrantRevokeCooldown(accountId, { vmId, observation, expected } = {}) {
    return !!(await this.patch(
      accountId,
      { status: 'ready', cooldown_until: null, cooldown_reason: null },
      { vmId, observation, expected, condition: (state) => this.isGrantRevokeCooldown(state) },
    ))
  }

  async clearAccountCooldown(accountId, { vmId, observation } = {}) {
    return !!(await this.patch(
      accountId,
      { status: 'ready', cooldown_until: null, cooldown_reason: null, rate_limit_reset_at: null, overload_until: null },
      { vmId, observation, clearModels: true },
    ))
  }

  async clearQuotaCooldown(accountId, { vmId, observation, expected } = {}) {
    return !!(await this.patch(
      accountId,
      { status: 'ready', cooldown_until: null, cooldown_reason: null, rate_limit_reset_at: null },
      { vmId, observation, expected, condition: (state) => this.isQuotaCooldown(state) },
    ))
  }

  async clearExpired(now = Date.now()) {
    for (const row of await this.list()) {
      await withTransaction(this.db, async () => {
        const account = await this.lockAccount(row.account_id)
        if (!account) return
        const current = await this.get(row.account_id)
        const fields = {}
        const expected = {}
        if (current.cooldown_until && current.cooldown_until <= now) {
          Object.assign(fields, { status: 'ready', cooldown_until: null, cooldown_reason: null })
          expected.cooldown_until = current.cooldown_until
          expected.cooldown_reason = current.cooldown_reason
        }
        for (const field of ['rate_limit_reset_at', 'overload_until']) {
          if (current[field] && current[field] <= now) {
            fields[field] = null
            expected[field] = current[field]
          }
        }
        const modelPatch = {}
        for (const [model, state] of Object.entries(current.model_states || {})) {
          if (state?.cooldown_until && Number(state.cooldown_until) <= now) modelPatch[model] = null
        }
        if (Object.keys(fields).length || Object.keys(modelPatch).length) {
          await this.patch(row.account_id, fields, { expected, modelPatch })
        }
      })
    }
  }

  async remove(accountId) {
    return (await this.db.prepare('DELETE FROM account_runtime WHERE account_id = $1').run(accountId)).changes > 0
  }
}
