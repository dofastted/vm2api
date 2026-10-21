/**
 * groups repository — fixed 2-row dictionary (coding=1 default, other=2).
 * No create/delete: the rows are seeded by migration 014. Panel may tune
 * rate_multiplier / rpm_limit / description / status.
 */

import { getDb } from '../database.mjs'

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
    this._get = db.prepare('SELECT * FROM groups WHERE id = $1 AND deleted_at IS NULL')
    this._getByName = db.prepare('SELECT * FROM groups WHERE name = $1 AND deleted_at IS NULL')
  }

  async list() {
    return (await this._list.all()).map(rowToRec)
  }

  async getById(id) {
    return rowToRec(await this._get.get(id))
  }

  async getByName(name) {
    return rowToRec(await this._getByName.get(String(name || '').trim()))
  }

  /** The coding group — where keys/accounts land unless told otherwise. */
  async getDefault() {
    return await this.getById(DEFAULT_GROUP_ID)
  }

  /** Patch editable attributes only (name/platform/id are fixed). */
  async update(id, patch = {}) {
    const cols = EDITABLE.filter((c) => patch[c] !== undefined)
    if (!cols.length) return await this.getById(id)
    const sql = `UPDATE groups SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = $${cols.length + 1} WHERE id = $${cols.length + 2} AND deleted_at IS NULL`
    await this.db.prepare(sql).run(
      ...cols.map((c) => {
        if (c === 'is_exclusive') return patch[c] ? 1 : 0
        return patch[c]
      }),
      new Date().toISOString(),
      id,
    )
    return await this.getById(id)
  }

  /** Effective billing multiplier for a group id (missing group → 1). */
  async rateMultiplier(id) {
    const g = await this.getById(id ?? DEFAULT_GROUP_ID)
    return g ? g.rate_multiplier : 1
  }
}
