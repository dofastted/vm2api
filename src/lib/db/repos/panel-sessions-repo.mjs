/** Shared panel sessions. Callers provide only SHA-256 token hashes. */
import { getDb } from '../database.mjs'

const NOW_MS = 'floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint'

function session(row) {
  return row ? { user: row.username, role: row.role, exp: row.expires_at } : null
}

function ttl(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('session ttlMs must be a positive safe integer')
  return value
}

export class PanelSessionsRepo {
  constructor(db = getDb()) {
    this.db = db
  }

  async create({ tokenHash, username, role, ttlMs }) {
    return session(
      await this.db
        .prepare(`
      INSERT INTO panel_sessions (token_hash, username, role, expires_at)
      VALUES ($1, $2, $3, ${NOW_MS} + $4::bigint)
      RETURNING username, role, expires_at
    `)
        .get(tokenHash, username, role, ttl(ttlMs)),
    )
  }

  async get(tokenHash) {
    return session(
      await this.db
        .prepare(`
      SELECT username, role, expires_at FROM panel_sessions
      WHERE token_hash = $1 AND expires_at > ${NOW_MS}
    `)
        .get(tokenHash),
    )
  }

  async renew(tokenHash, { expectedExp, ttlMs }) {
    return session(
      await this.db
        .prepare(`
      UPDATE panel_sessions SET expires_at = ${NOW_MS} + $3::bigint
      WHERE token_hash = $1 AND expires_at = $2 AND expires_at > ${NOW_MS}
      RETURNING username, role, expires_at
    `)
        .get(tokenHash, expectedExp, ttl(ttlMs)),
    )
  }

  async remove(tokenHash) {
    return (await this.db.prepare('DELETE FROM panel_sessions WHERE token_hash = $1').run(tokenHash)).changes > 0
  }

  async removeForUser(username, { exceptHash = null } = {}) {
    return (
      await this.db
        .prepare(`
      DELETE FROM panel_sessions WHERE username = $1 AND ($2::text IS NULL OR token_hash <> $2)
    `)
        .run(username, exceptHash)
    ).changes
  }
}
