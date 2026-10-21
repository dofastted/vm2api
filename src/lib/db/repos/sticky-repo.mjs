/**
 * sticky_sessions repository — conversation key → account/VM bindings.
 */

import { getDb } from '../database.mjs'

function rowToEntry(row) {
  if (!row) return null
  return {
    account_id: row.account_id,
    vm_id: row.vm_id,
    session_id: row.session_id,
    device_id: row.device_id || null,
    bound_at: row.bound_at,
    expires_at: row.expires_at,
    hits: row.hits || 0,
    generation: Number(row.generation) || 0,
    slot_index: row.slot_index == null ? null : Number(row.slot_index),
  }
}

export class StickyRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT * FROM sticky_sessions WHERE key = $1')
    this._upsert = db.prepare(`
      INSERT INTO sticky_sessions (key, account_id, vm_id, session_id, device_id, bound_at, expires_at, hits, generation, slot_index)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT(key) DO UPDATE SET
        account_id = excluded.account_id,
        vm_id = excluded.vm_id,
        session_id = excluded.session_id,
        device_id = COALESCE(excluded.device_id, sticky_sessions.device_id),
        bound_at = excluded.bound_at,
        expires_at = excluded.expires_at,
        hits = excluded.hits,
        generation = excluded.generation,
        slot_index = excluded.slot_index
    `)
    this._delete = db.prepare('DELETE FROM sticky_sessions WHERE key = $1')
    this._deleteByAccount = db.prepare('DELETE FROM sticky_sessions WHERE account_id = $1 OR vm_id = $2')
    this._purge = db.prepare('DELETE FROM sticky_sessions WHERE expires_at < $1')
    this._dropAlias = db.prepare(`
      DELETE FROM sticky_sessions
      WHERE key = 'envelope'
        OR ascii_fold(key) LIKE 'ch:%'
        OR ascii_fold(key) LIKE 'dev:%'
        OR ascii_fold(key) LIKE '%:envelope'
        OR ascii_fold(key) LIKE '%:ch:%'
        OR ascii_fold(key) LIKE '%:dev:%'
    `)
    this._all = db.prepare('SELECT * FROM sticky_sessions')
    this._count = db.prepare('SELECT COUNT(*) c FROM sticky_sessions')
  }

  async get(key) {
    return rowToEntry(await this._get.get(key))
  }

  async upsert(key, ent) {
    await this._upsert.run(
      key,
      ent.account_id ?? null,
      ent.vm_id ?? null,
      ent.session_id ?? null,
      ent.device_id ?? null,
      ent.bound_at ?? Date.now(),
      ent.expires_at ?? null,
      ent.hits ?? 0,
      Number(ent.generation) || 0,
      ent.slot_index == null ? null : Number(ent.slot_index),
    )
  }

  async remove(key) {
    await this._delete.run(key)
  }

  async removeByAccount({ accountId = null, vmId = null } = {}) {
    if (!accountId && !vmId) return 0
    return (await this._deleteByAccount.run(accountId || '', vmId || '')).changes
  }

  async purgeExpired(now = Date.now()) {
    return (await this._purge.run(now)).changes
  }

  /** Content fingerprints and device aliases are not conversation slots. */
  async dropAliasKeys() {
    return (await this._dropAlias.run()).changes
  }

  async all() {
    const out = {}
    for (const row of await this._all.all()) out[row.key] = rowToEntry(row)
    return out
  }

  async count() {
    return (await this._count.get()).c
  }
}
