/**
 * Named slot pools. Membership is the schedule source for keys with vm_pool_id.
 * A vm_id can appear in only one pool (unique index).
 */
import crypto from 'node:crypto'
import { getDb, withTransaction } from '../database.mjs'

function nowIso() {
  return new Date().toISOString()
}

function rowToPool(row, vmIds) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    vm_ids: vmIds,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export class VmPoolsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._list = db.prepare('SELECT * FROM vm_pools ORDER BY created_at, id')
    this._get = db.prepare('SELECT * FROM vm_pools WHERE id = ?')
    this._members = db.prepare('SELECT vm_id FROM vm_pool_members WHERE pool_id = ? ORDER BY vm_id')
    this._allMembers = db.prepare('SELECT pool_id, vm_id FROM vm_pool_members ORDER BY vm_id')
    this._insert = db.prepare('INSERT INTO vm_pools (id, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    this._name = db.prepare('UPDATE vm_pools SET name = ?, updated_at = ? WHERE id = ?')
    this._enabled = db.prepare('UPDATE vm_pools SET enabled = ?, updated_at = ? WHERE id = ?')
    this._touch = db.prepare('UPDATE vm_pools SET updated_at = ? WHERE id = ?')
    this._delete = db.prepare('DELETE FROM vm_pools WHERE id = ?')
    this._clearMembers = db.prepare('DELETE FROM vm_pool_members WHERE pool_id = ?')
    this._addMember = db.prepare('INSERT INTO vm_pool_members (pool_id, vm_id, created_at) VALUES (?, ?, ?)')
    this._other = db.prepare('SELECT pool_id FROM vm_pool_members WHERE vm_id = ? AND pool_id != ?')
    this._keyCount = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE vm_pool_id = ? AND deleted_at IS NULL')
    this._deleteVm = db.prepare('DELETE FROM vm_pool_members WHERE vm_id = ?')
    this._memberVmIds = db.prepare('SELECT DISTINCT vm_id FROM vm_pool_members')
  }

  _ids(poolId) {
    return this._members.all(poolId).map((row) => row.vm_id)
  }

  list() {
    const grouped = new Map()
    for (const row of this._allMembers.all()) {
      const list = grouped.get(row.pool_id) || []
      list.push(row.vm_id)
      grouped.set(row.pool_id, list)
    }
    return this._list.all().map((row) => rowToPool(row, grouped.get(row.id) || []))
  }

  get(id) {
    const row = this._get.get(id)
    if (!row) return null
    return rowToPool(row, this._ids(id))
  }

  countKeys(id) {
    return Number(this._keyCount.get(id)?.n) || 0
  }

  insert({ name, enabled = true }) {
    const now = nowIso()
    const id = `pool_${crypto.randomBytes(4).toString('hex')}`
    try {
      this._insert.run(id, name, enabled ? 1 : 0, now, now)
    } catch (error) {
      throw mapConstraint(error)
    }
    return this.get(id)
  }

  rename(id, name) {
    try {
      const info = this._name.run(name, nowIso(), id)
      if (!info.changes) return null
    } catch (error) {
      throw mapConstraint(error)
    }
    return this.get(id)
  }

  setEnabled(id, enabled) {
    const info = this._enabled.run(enabled ? 1 : 0, nowIso(), id)
    if (!info.changes) return null
    return this.get(id)
  }

  /**
   * Replace membership. A vm already in another pool is rejected and nothing
   * is written. Passing the same vm ids is a no-op aside from updated_at.
   */
  setMembers(id, vmIds) {
    if (!this._get.get(id)) return null
    for (const vmId of vmIds) {
      const other = this._other.get(vmId, id)
      if (other) {
        throw Object.assign(new Error(`槽位 ${vmId} 已在其他账号池`), {
          code: 'vm_in_other_pool',
          vm_id: vmId,
          pool_id: other.pool_id,
        })
      }
    }
    const now = nowIso()
    withTransaction(this.db, () => {
      this._clearMembers.run(id)
      for (const vmId of vmIds) this._addMember.run(id, vmId, now)
      this._touch.run(now, id)
    })
    return this.get(id)
  }

  remove(id) {
    const info = this._delete.run(id)
    return info.changes > 0
  }

  /**
   * Drop a slot from every pool. A deleted slot used to keep its membership
   * row, which the panel could neither show nor remove: every save of that
   * pool then failed with "槽位 X 不存在" even though X no longer existed.
   */
  removeVm(vmId) {
    const info = this._deleteVm.run(String(vmId))
    return Number(info.changes) || 0
  }

  /** Drop memberships for slots outside `knownIds`; returns the ids removed. */
  pruneUnknown(knownIds) {
    const known = new Set([...knownIds].map(String))
    const stale = this._memberVmIds
      .all()
      .map((row) => row.vm_id)
      .filter((vmId) => !known.has(vmId))
    for (const vmId of stale) this._deleteVm.run(vmId)
    return stale
  }
}

function mapConstraint(error) {
  const message = String(error?.message || error)
  const code = String(error?.code || error?.pgCode || '')
  if (
    (code === '23505' || /UNIQUE|duplicate key/i.test(message)) &&
    /vm_pools|name/i.test(message + ' ' + String(error?.constraint || ''))
  ) {
    return Object.assign(new Error('账号池名称已存在'), { code: 'vm_pool_name_taken' })
  }
  return error
}
