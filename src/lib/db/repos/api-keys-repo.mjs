/**
 * api_keys repository — persistence for managed client API keys.
 * Pure SQL layer; business rules stay in lib/api-keys.mjs (ApiKeyStore).
 *
 * sub2api-shaped: user_id/group_id ownership, USD quota (quota/quota_used)
 * plus 5h/1d/7d USD rate-limit windows. The legacy request-count quota pair
 * is quota_requests / quota_requests_used. Soft delete via deleted_at.
 */

import { getDb } from '../database.mjs'

const COLUMNS = [
  'id',
  'name',
  'key',
  'status',
  'max_concurrency',
  'quota_requests',
  'quota_requests_used',
  'rpm',
  'expires_at',
  'created_at',
  'updated_at',
  'last_used_at',
  'requests',
  'tokens_in',
  'tokens_out',
  'cache_read_tokens',
  'cache_creation_tokens',
  'key_hash',
  'key_prefix',
  'key_suffix',
  'category',
  'group_type',
  'allowed_vms',
  'vm_pool_id',
  'allowed_models',
  'key_secret',
  'user_id',
  'group_id',
  'quota',
  'quota_used',
  'rate_limit_5h',
  'rate_limit_1d',
  'rate_limit_7d',
  'usage_5h',
  'usage_1d',
  'usage_7d',
  'window_5h_start',
  'window_1d_start',
  'window_7d_start',
  'ip_whitelist',
  'ip_blacklist',
  'deleted_at',
]

const WINDOWS = [
  { usage: 'usage_5h', start: 'window_5h_start', ms: 5 * 3600 * 1000 },
  { usage: 'usage_1d', start: 'window_1d_start', ms: 24 * 3600 * 1000 },
  { usage: 'usage_7d', start: 'window_7d_start', ms: 7 * 24 * 3600 * 1000 },
]

const NUMERIC_DEFAULT_0 = new Set([
  'quota_requests',
  'quota_requests_used',
  'requests',
  'tokens_in',
  'tokens_out',
  'quota',
  'quota_used',
  'rate_limit_5h',
  'rate_limit_1d',
  'rate_limit_7d',
  'usage_5h',
  'usage_1d',
  'usage_7d',
])

function rowToRec(row) {
  if (!row) return null
  return { ...row }
}

function toValue(rec, c) {
  const v = rec[c]
  if (v == null) {
    if (c === 'category') return 'oauth'
    if (c === 'group_type') return 'all'
    if (c === 'allowed_vms' || c === 'allowed_models') return '[]'
    return NUMERIC_DEFAULT_0.has(c) ? 0 : null
  }
  return v
}

export class ApiKeysRepo {
  constructor(db = getDb()) {
    this.db = db
    this._list = db.prepare('SELECT * FROM api_keys WHERE deleted_at IS NULL ORDER BY created_at')
    this._get = db.prepare('SELECT * FROM api_keys WHERE id = ? AND deleted_at IS NULL')
    this._getByKey = db.prepare('SELECT * FROM api_keys WHERE key = ? AND deleted_at IS NULL')
    this._getByHash = db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND deleted_at IS NULL')
    this._insert = db.prepare(`
      INSERT INTO api_keys (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map(() => '?').join(', ')})
    `)
    this._delete = db.prepare('DELETE FROM api_keys WHERE id = ?')
    this._recordUsage = db.prepare(`
      UPDATE api_keys SET
        requests = requests + 1,
        quota_requests_used = quota_requests_used + 1,
        tokens_in = tokens_in + ?,
        tokens_out = tokens_out + ?,
        cache_read_tokens = COALESCE(cache_read_tokens, 0) + ?,
        cache_creation_tokens = COALESCE(cache_creation_tokens, 0) + ?,
        quota_used = quota_used + ?,
        usage_5h = ?, window_5h_start = ?,
        usage_1d = ?, window_1d_start = ?,
        usage_7d = ?, window_7d_start = ?,
        last_used_at = ?,
        updated_at = ?
      WHERE id = ?
    `)
  }

  list() {
    return this._list.all().map(rowToRec)
  }

  getById(id) {
    return rowToRec(this._get.get(id))
  }

  getByKey(key) {
    return rowToRec(this._getByKey.get(key))
  }

  getByHash(hash) {
    return rowToRec(this._getByHash.get(hash))
  }

  insert(rec) {
    this._insert.run(...COLUMNS.map((c) => toValue(rec, c)))
    return this.getById(rec.id)
  }

  /** Full-row update from a record object (id immutable). */
  update(rec) {
    const cols = COLUMNS.filter((c) => c !== 'id')
    const sql = `UPDATE api_keys SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
    this.db.prepare(sql).run(...cols.map((c) => toValue(rec, c)), rec.id)
    return this.getById(rec.id)
  }

  remove(id) {
    const info = this._delete.run(id)
    return info.changes > 0
  }

  /**
   * Sub2api APIKey window semantics: a window opens at first spend; once
   * now - start >= size the window resets (usage=cost, start=now).
   */
  _rollWindow(rec, key, cost, nowMs) {
    const start = rec[key.start] ? Date.parse(rec[key.start]) : NaN
    if (!Number.isFinite(start) || nowMs - start >= key.ms) {
      return { usage: cost, start: new Date(nowMs).toISOString() }
    }
    return { usage: (Number(rec[key.usage]) || 0) + cost, start: rec[key.start] }
  }

  recordUsage(id, { tokens_in = 0, tokens_out = 0, cache_read_tokens = 0, cache_creation_tokens = 0, cost = 0 } = {}) {
    const rec = this.getById(id)
    if (!rec) return null
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    const usd = Number(cost) || 0
    const w = WINDOWS.map((win) => this._rollWindow(rec, win, usd, nowMs))
    this._recordUsage.run(
      Number(tokens_in) || 0,
      Number(tokens_out) || 0,
      Number(cache_read_tokens) || 0,
      Number(cache_creation_tokens) || 0,
      usd,
      w[0].usage,
      w[0].start,
      w[1].usage,
      w[1].start,
      w[2].usage,
      w[2].start,
      now,
      now,
      id,
    )
    return this.getById(id)
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) c FROM api_keys WHERE deleted_at IS NULL').get().c
  }
}
