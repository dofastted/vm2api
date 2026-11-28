/**
 * groups repository — fixed 2-row dictionary (coding=1 default, other=2).
 * No create/delete: the rows are seeded by migration 014. Panel may tune
 * rate_multiplier / rpm_limit / description / status.
 */

import { DB_INSTANCE_ID, getDb, isDbOpen } from '../database.mjs'
import { getCacheRuntime, notifyDbTablesMutated } from '../../cache/index.mjs'

export const DEFAULT_GROUP_ID = 1

const EDITABLE = ['description', 'rate_multiplier', 'is_exclusive', 'rpm_limit', 'sort_order', 'status']

function rowToRec(row) {
  if (!row) return null
  const rateMultiplier = Number(row.rate_multiplier)
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rate_multiplier: Number.isFinite(rateMultiplier) ? rateMultiplier : 1,
    is_exclusive: !!row.is_exclusive,
    platform: row.platform,
    rpm_limit: Number(row.rpm_limit) || 0,
    sort_order: Number(row.sort_order) || 0,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export class GroupsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._list = db.prepare('SELECT * FROM groups WHERE deleted_at IS NULL ORDER BY sort_order, id')
    this._get = db.prepare('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL')
    this._getByName = db.prepare('SELECT * FROM groups WHERE name = ? AND deleted_at IS NULL')
  }

  list() {
    return this._list.all().map(rowToRec)
  }

  getById(id) {
    return rowToRec(this._get.get(id))
  }

  getByName(name) {
    return rowToRec(this._getByName.get(String(name || '').trim()))
  }

  /** The coding group — where keys/accounts land unless told otherwise. */
  getDefault() {
    return this.getById(DEFAULT_GROUP_ID)
  }

  _groupCacheKey(id) {
    const gid = id ?? DEFAULT_GROUP_ID
    if (isDbOpen() && this.db === getDb()) return String(gid)
    return `${this.db?.[DB_INSTANCE_ID] || 'isolated'}:${gid}`
  }

  /** Patch editable attributes only (name/platform/id are fixed). */
  update(id, patch = {}) {
    const cols = EDITABLE.filter((c) => patch[c] !== undefined)
    if (!cols.length) return this.getById(id)
    const sql = `UPDATE groups SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND deleted_at IS NULL`
    this.db.prepare(sql).run(
      ...cols.map((c) => {
        if (c === 'is_exclusive') return patch[c] ? 1 : 0
        return patch[c]
      }),
      new Date().toISOString(),
      id,
    )
    const cacheKey = this._groupCacheKey(id)
    getCacheRuntime()
      .entity.invalidateGroup(cacheKey)
      .catch(() => {})
    if (isDbOpen() && this.db === getDb()) {
      notifyDbTablesMutated(['groups'])
    }
    return this.getById(id)
  }

  /** Effective billing multiplier for a group id (missing group → 1; explicit 0 preserved). */
  rateMultiplier(id) {
    const gid = id ?? DEFAULT_GROUP_ID
    const cache = getCacheRuntime()
    if (!cache?.client?.enabled) {
      const g = this.getById(gid)
      return g ? g.rate_multiplier : 1
    }
    const cacheKey = this._groupCacheKey(gid)
    return cache.entity.getGroupRateMultiplierSync(cacheKey, () => {
      const g = this.getById(gid)
      return g ? g.rate_multiplier : 1
    })
  }

  /** Async L1+Redis L2 billing multiplier lookup for request hot path. */
  async rateMultiplierAsync(id) {
    const gid = id ?? DEFAULT_GROUP_ID
    const cache = getCacheRuntime()
    if (!cache?.client?.enabled) {
      const g = this.getById(gid)
      return g ? g.rate_multiplier : 1
    }
    const cacheKey = this._groupCacheKey(gid)
    return await cache.entity.getGroupRateMultiplier(cacheKey, () => {
      const g = this.getById(gid)
      return g ? g.rate_multiplier : 1
    })
  }
}
