/**
 * api_keys repository — persistence for managed client API keys.
 * Pure SQL layer; business rules stay in lib/api-keys.mjs (ApiKeyStore).
 *
 * sub2api-shaped: user_id/group_id ownership, USD quota (quota/quota_used)
 * plus 5h/1d/7d USD rate-limit windows. The legacy request-count quota pair
 * is quota_requests / quota_requests_used. Soft delete via deleted_at.
 */

import { getDb, withTransaction } from '../database.mjs'

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
    if (c === 'allowed_vms') return '[]'
    return NUMERIC_DEFAULT_0.has(c) ? 0 : null
  }
  return v
}

export class ApiKeysRepo {
  constructor(db = getDb()) {
    this.db = db
    this._list = db.prepare('SELECT * FROM api_keys WHERE deleted_at IS NULL ORDER BY created_at')
    this._get = db.prepare('SELECT * FROM api_keys WHERE id = $1 AND deleted_at IS NULL')
    this._getByKey = db.prepare('SELECT * FROM api_keys WHERE key = $1 AND deleted_at IS NULL')
    this._getByHash = db.prepare('SELECT * FROM api_keys WHERE key_hash = $1 AND deleted_at IS NULL')
    this._insert = db.prepare(`
      INSERT INTO api_keys (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map((_, i) => '$' + (i + 1)).join(', ')})
    `)
    this._delete = db.prepare('DELETE FROM api_keys WHERE id = $1')
    this._recordUsage = db.prepare(`
      UPDATE api_keys SET
        requests = requests + 1,
        quota_requests_used = quota_requests_used + 1,
        tokens_in = tokens_in + $1,
        tokens_out = tokens_out + $2,
        cache_read_tokens = COALESCE(cache_read_tokens, 0) + $3,
        cache_creation_tokens = COALESCE(cache_creation_tokens, 0) + $4,
        quota_used = quota_used + $5,
        status = CASE WHEN status = 'active' AND quota > 0 AND quota_used + $5 >= quota THEN 'quota_exhausted' ELSE status END,
        usage_5h = $6, window_5h_start = $7,
        usage_1d = $8, window_1d_start = $9,
        usage_7d = $10, window_7d_start = $11,
        last_used_at = $12,
        updated_at = $13
      WHERE id = $14
    `)
  }

  async list() {
    return (await this._list.all()).map(rowToRec)
  }

  async getById(id, { forUpdate = false } = {}) {
    return rowToRec(
      await (forUpdate
        ? this.db.prepare('SELECT * FROM api_keys WHERE id = $1 AND deleted_at IS NULL FOR UPDATE')
        : this._get
      ).get(id),
    )
  }

  async getByKey(key) {
    return rowToRec(await this._getByKey.get(key))
  }

  async getByHash(hash) {
    return rowToRec(await this._getByHash.get(hash))
  }

  async insert(rec) {
    await this._insert.run(...COLUMNS.map((c) => toValue(rec, c)))
    return await this.getById(rec.id)
  }

  /** Full-row update from a record object (id immutable). */
  async update(rec) {
    const cols = COLUMNS.filter((c) => c !== 'id')
    const sql = `UPDATE api_keys SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`
    await this.db.prepare(sql).run(...cols.map((c) => toValue(rec, c)), rec.id)
    return await this.getById(rec.id)
  }

  async remove(id) {
    const info = await this._delete.run(id)
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

  async recordUsage(
    id,
    { tokens_in = 0, tokens_out = 0, cache_read_tokens = 0, cache_creation_tokens = 0, cost = 0 } = {},
  ) {
    return withTransaction(this.db, async () => {
      const rec = await this.getById(id, { forUpdate: true })
      if (!rec) return null
      const nowMs = Date.now()
      const now = new Date(nowMs).toISOString()
      const usd = Number(cost) || 0
      const w = WINDOWS.map((win) => this._rollWindow(rec, win, usd, nowMs))
      await this._recordUsage.run(
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
      return await this.getById(id)
    })
  }

  async count() {
    return (await this.db.prepare('SELECT COUNT(*) c FROM api_keys WHERE deleted_at IS NULL').get()).c
  }
}
