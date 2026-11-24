/**
 * gemini_environment_owners repository — SSOT mapping between host-managed
 * Gemini environment IDs and their tenant/supplier owner_user_id.
 *
 * Absence of a row means the environment belongs to the platform (admin) domain.
 */

import { getDb } from '../database.mjs'

function normalizeOwner(value) {
  const s = String(value || '').trim()
  return s || null
}

export class GeminiOwnersRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT env_id, owner_user_id, created_at FROM gemini_environment_owners WHERE env_id = ?')
    this._list = db.prepare('SELECT env_id, owner_user_id, created_at FROM gemini_environment_owners')
    this._listByOwner = db.prepare(
      'SELECT env_id, owner_user_id, created_at FROM gemini_environment_owners WHERE owner_user_id = ?',
    )
    this._upsert = db.prepare(`
      INSERT INTO gemini_environment_owners (env_id, owner_user_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(env_id) DO UPDATE SET owner_user_id = excluded.owner_user_id
    `)
    this._delete = db.prepare('DELETE FROM gemini_environment_owners WHERE env_id = ?')
  }

  getOwner(envId) {
    const id = String(envId || '').trim()
    if (!id) return null
    try {
      const row = this._get.get(id)
      return normalizeOwner(row?.owner_user_id)
    } catch {
      return null
    }
  }

  setOwner(envId, ownerUserId) {
    const id = String(envId || '').trim()
    if (!id) return null
    const owner = normalizeOwner(ownerUserId)
    if (!owner) {
      this._delete.run(id)
      return null
    }
    this._upsert.run(id, owner, new Date().toISOString())
    return owner
  }

  remove(envId) {
    const id = String(envId || '').trim()
    if (!id) return false
    return this._delete.run(id).changes > 0
  }

  ownerMap() {
    const out = new Map()
    try {
      for (const row of this._list.all()) {
        const owner = normalizeOwner(row?.owner_user_id)
        if (row?.env_id && owner) out.set(String(row.env_id), owner)
      }
    } catch {}
    return out
  }

  listEnvIdsByOwner(ownerUserId) {
    const owner = normalizeOwner(ownerUserId)
    if (!owner) return []
    try {
      return this._listByOwner.all(owner).map((r) => String(r.env_id))
    } catch {
      return []
    }
  }
}
