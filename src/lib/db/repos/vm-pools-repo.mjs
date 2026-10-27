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
    this._get = db.prepare('SELECT * FROM vm_pools WHERE id = $1')
    this._members = db.prepare('SELECT vm_id FROM vm_pool_members WHERE pool_id = $1 ORDER BY vm_id')
    this._allMembers = db.prepare('SELECT pool_id, vm_id FROM vm_pool_members ORDER BY vm_id')
    this._insert = db.prepare(
      'INSERT INTO vm_pools (id, name, enabled, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)',
    )
    this._name = db.prepare('UPDATE vm_pools SET name = $1, updated_at = $2 WHERE id = $3')
    this._enabled = db.prepare('UPDATE vm_pools SET enabled = $1, updated_at = $2 WHERE id = $3')
    this._touch = db.prepare('UPDATE vm_pools SET updated_at = $1 WHERE id = $2')
    this._delete = db.prepare('DELETE FROM vm_pools WHERE id = $1')
    this._clearMembers = db.prepare('DELETE FROM vm_pool_members WHERE pool_id = $1')
    this._addMember = db.prepare('INSERT INTO vm_pool_members (pool_id, vm_id, created_at) VALUES ($1, $2, $3)')
    this._other = db.prepare('SELECT pool_id FROM vm_pool_members WHERE vm_id = $1 AND pool_id != $2')
    this._keyCount = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE vm_pool_id = $1 AND deleted_at IS NULL')
    this._deleteVm = db.prepare('DELETE FROM vm_pool_members WHERE vm_id = $1')
    this._memberVmIds = db.prepare('SELECT DISTINCT vm_id FROM vm_pool_members')
  }

  async _ids(poolId) {
    return (await this._members.all(poolId)).map((row) => row.vm_id)
  }

  async list() {
    const grouped = new Map()
    for (const row of await this._allMembers.all()) {
      const list = grouped.get(row.pool_id) || []
      list.push(row.vm_id)
      grouped.set(row.pool_id, list)
    }
    return (await this._list.all()).map((row) => rowToPool(row, grouped.get(row.id) || []))
  }

  async get(id) {
    const row = await this._get.get(id)
    if (!row) return null
    return rowToPool(row, await this._ids(id))
  }

  async countKeys(id) {
    return Number((await this._keyCount.get(id))?.n) || 0
  }

  async insert({ name, enabled = true }) {
    const now = nowIso()
    const id = `pool_${crypto.randomBytes(4).toString('hex')}`
    try {
      await this._insert.run(id, name, enabled ? 1 : 0, now, now)
    } catch (error) {
      throw mapConstraint(error)
    }
    return await this.get(id)
  }

  async rename(id, name) {
    try {
      const info = await this._name.run(name, nowIso(), id)
      if (!info.changes) return null
    } catch (error) {
      throw mapConstraint(error)
    }
    return await this.get(id)
  }

  async setEnabled(id, enabled) {
    const info = await this._enabled.run(enabled ? 1 : 0, nowIso(), id)
    if (!info.changes) return null
    return await this.get(id)
  }

  /**
   * Replace membership. A vm already in another pool is rejected and nothing
   * is written. Passing the same vm ids is a no-op aside from updated_at.
   */
  async setMembers(id, vmIds) {
    return withTransaction(this.db, async () => {
      await this.db.prepare('SELECT id FROM vm_pools WHERE id = $1 FOR UPDATE').get(id)

      if (!(await this._get.get(id))) return null
      const lockedIds = [...new Set([...vmIds, ...(await this._ids(id))])].sort()
      for (const vmId of lockedIds) {
        await this.db.prepare('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))').get(`vm_pool_member:${vmId}`)
      }
      for (const vmId of vmIds) {
        const other = await this._other.get(vmId, id)
        if (other) {
          throw Object.assign(new Error(`槽位 ${vmId} 已在其他账号池`), {
            code: 'vm_in_other_pool',
            vm_id: vmId,
            pool_id: other.pool_id,
          })
        }
      }
      const now = nowIso()
      await withTransaction(this.db, async () => {
        await this._clearMembers.run(id)
        for (const vmId of vmIds) await this._addMember.run(id, vmId, now)
        await this._touch.run(now, id)
      })
      return await this.get(id)
    })
  }

  async remove(id) {
    const info = await this._delete.run(id)
    return info.changes > 0
  }

  /**
   * Drop a slot from every pool. A deleted slot used to keep its membership
   * row, which the panel could neither show nor remove: every save of that
   * pool then failed with "槽位 X 不存在" even though X no longer existed.
   */
  async removeVm(vmId) {
    const info = await this._deleteVm.run(String(vmId))
    return Number(info.changes) || 0
  }

  /** Drop memberships for slots outside `knownIds`; returns the ids removed. */
  async pruneUnknown(knownIds) {
    const known = new Set([...knownIds].map(String))
    const stale = (await this._memberVmIds.all()).map((row) => row.vm_id).filter((vmId) => !known.has(vmId))
    for (const vmId of stale) await this._deleteVm.run(vmId)
    return stale
  }
}

function mapConstraint(error) {
  const message = String(error?.message || error)
  if (error?.code === '23505' && /vm_pools.*name|name.*vm_pools/i.test(error.constraint || message)) {
    return Object.assign(new Error('账号池名称已存在'), { code: 'vm_pool_name_taken' })
  }
  return error
}
