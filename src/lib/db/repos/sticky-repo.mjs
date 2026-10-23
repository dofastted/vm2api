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
    this._get = db.prepare('SELECT * FROM sticky_sessions WHERE key = ?')
    this._upsert = db.prepare(`
      INSERT INTO sticky_sessions (key, account_id, vm_id, session_id, device_id, bound_at, expires_at, hits, generation, slot_index, assignment_root)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        account_id = excluded.account_id,
        vm_id = excluded.vm_id,
        session_id = excluded.session_id,
        device_id = COALESCE(excluded.device_id, sticky_sessions.device_id),
        bound_at = excluded.bound_at,
        expires_at = excluded.expires_at,
        hits = excluded.hits,
        generation = excluded.generation,
        slot_index = excluded.slot_index,
        assignment_root = MAX(sticky_sessions.assignment_root, excluded.assignment_root)
    `)
    this._markRoot = db.prepare('UPDATE sticky_sessions SET assignment_root = 1 WHERE key = ? AND assignment_root = 0')
    this._rootCounts = db.prepare(`
      SELECT account_id, COUNT(*) AS roots FROM sticky_sessions
      WHERE assignment_root = 1 AND expires_at >= ? AND account_id IS NOT NULL AND vm_id IS NOT NULL
      GROUP BY account_id
    `)
    this._delete = db.prepare('DELETE FROM sticky_sessions WHERE key = ?')
    this._deleteByAccount = db.prepare('DELETE FROM sticky_sessions WHERE account_id = ? OR vm_id = ?')
    this._purge = db.prepare('DELETE FROM sticky_sessions WHERE expires_at < ?')
    this._dropAlias = db.prepare(`
      DELETE FROM sticky_sessions
      WHERE key = 'envelope'
        OR key LIKE 'ch:%'
        OR key LIKE 'dev:%'
        OR key LIKE '%:envelope'
        OR key LIKE '%:ch:%'
        OR key LIKE '%:dev:%'
    `)
    this._all = db.prepare('SELECT * FROM sticky_sessions')
    this._count = db.prepare('SELECT COUNT(*) c FROM sticky_sessions')
  }

  get(key) {
    return rowToEntry(this._get.get(key))
  }

  upsert(key, ent) {
    this._upsert.run(
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
      ent.assignment_root ? 1 : 0,
    )
  }

  markRootAssignment(key) {
    return this._markRoot.run(key).changes
  }

  rootAssignmentCounts(now = Date.now()) {
    return new Map(this._rootCounts.all(now).map((row) => [row.account_id, row.roots]))
  }

  remove(key) {
    this._delete.run(key)
  }

  removeByAccount({ accountId = null, vmId = null } = {}) {
    if (!accountId && !vmId) return 0
    return this._deleteByAccount.run(accountId || '', vmId || '').changes
  }

  purgeExpired(now = Date.now()) {
    return this._purge.run(now).changes
  }

  /** Content fingerprints and device aliases are not conversation slots. */
  dropAliasKeys() {
    return this._dropAlias.run().changes
  }

  all() {
    const out = {}
    for (const row of this._all.all()) out[row.key] = rowToEntry(row)
    return out
  }

  count() {
    return this._count.get().c
  }
}
