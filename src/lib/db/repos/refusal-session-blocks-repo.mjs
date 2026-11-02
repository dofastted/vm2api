/**
 * Permanent ban of an inbound client session after a refusal-guard hit.
 * Empty ids are never stored. This is the caller session, not the outbound session.
 */
import { getDb } from '../database.mjs'

function rowToRec(row) {
  if (!row) return null
  return {
    session_id: row.session_id,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    hit_count: Number(row.hit_count) || 0,
    source_request_id: row.source_request_id,
    fingerprint: row.fingerprint,
    reason: row.reason,
  }
}

export class RefusalSessionBlocksRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT * FROM refusal_session_blocks WHERE session_id = ?')
    this._insert = db.prepare(`
      INSERT INTO refusal_session_blocks (
        session_id, first_seen_at, last_seen_at, hit_count,
        source_request_id, fingerprint, reason
      ) VALUES (?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        source_request_id = COALESCE(refusal_session_blocks.source_request_id, excluded.source_request_id),
        fingerprint = COALESCE(refusal_session_blocks.fingerprint, excluded.fingerprint),
        reason = COALESCE(refusal_session_blocks.reason, excluded.reason)
    `)
    this._hit = db.prepare(`
      UPDATE refusal_session_blocks SET hit_count = hit_count + 1, last_seen_at = ?
      WHERE session_id = ?
    `)
    this._list = db.prepare('SELECT * FROM refusal_session_blocks ORDER BY last_seen_at DESC, session_id LIMIT ?')
    this._count = db.prepare('SELECT COUNT(*) AS n FROM refusal_session_blocks')
    this._remove = db.prepare('DELETE FROM refusal_session_blocks WHERE session_id = ?')
    this._clear = db.prepare('DELETE FROM refusal_session_blocks')
  }

  get(sessionId) {
    const id = String(sessionId || '').trim()
    if (!id) return null
    return rowToRec(this._get.get(id))
  }

  block({ sessionId, requestId = null, fingerprint = null, reason = 'refusal_guard' } = {}) {
    const id = String(sessionId || '').trim()
    if (!id) return null
    const now = new Date().toISOString()
    this._insert.run(id, now, now, requestId, fingerprint, reason ? String(reason).slice(0, 80) : null)
    return this.get(id)
  }

  hit(sessionId) {
    const id = String(sessionId || '').trim()
    if (!id) return null
    this._hit.run(new Date().toISOString(), id)
    return this.get(id)
  }

  list(limit = 200) {
    const n = Math.min(500, Math.max(1, Number(limit) || 200))
    return this._list.all(n).map(rowToRec)
  }

  count() {
    return Number(this._count.get()?.n) || 0
  }

  remove(sessionId) {
    const id = String(sessionId || '').trim()
    if (!id) return false
    return this._remove.run(id).changes > 0
  }

  clear() {
    return this._clear.run().changes
  }
}
