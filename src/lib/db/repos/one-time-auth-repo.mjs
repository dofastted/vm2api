import crypto from 'node:crypto'
import { getDb, withTransaction } from '../database.mjs'
import { encryptString, decryptString, encryptionEnabled, isEncrypted } from '../secure.mjs'

function fail(code) {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { code })
}

export function authTokenHash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
}

function requireEncryption() {
  if (!encryptionEnabled()) throw fail('oauth_session_encryption_required')
}

function sessionFrom(row) {
  requireEncryption()
  try {
    if (!isEncrypted(row.encrypted_session)) throw new Error('invalid session')
    return JSON.parse(decryptString(row.encrypted_session))
  } catch {
    throw fail('oauth_session_invalid')
  }
}

/** One-time browser authentication state. No connection lock is held across provider I/O. */
export class OneTimeAuthRepo {
  constructor(db = getDb()) {
    this.db = db
  }

  async issuePkce(kind, id, session, ttlMs) {
    requireEncryption()
    const encrypted = encryptString(JSON.stringify(session))
    await this.db.prepare('DELETE FROM oauth_pkce_sessions WHERE expires_at<=clock_timestamp()').run()
    const row = await this.db
      .prepare(`INSERT INTO oauth_pkce_sessions
      (kind, id_hash, resource_id, encrypted_session, expires_at)
      VALUES ($1,$2,$3,$4,clock_timestamp()+$5::bigint*interval '1 millisecond') RETURNING expires_at`)
      .get(kind, authTokenHash(id), session.vmId, encrypted, ttlMs)
    return { expiresAt: row.expires_at.getTime() }
  }

  async peekPkce(kind, id) {
    const row = await this.db
      .prepare(`SELECT * FROM oauth_pkce_sessions
      WHERE kind=$1 AND id_hash=$2 AND expires_at>clock_timestamp()`)
      .get(kind, authTokenHash(id))
    return row ? sessionFrom(row) : null
  }

  async claimPkce(kind, id, validate) {
    return withTransaction(this.db, async () => {
      const row = await this.db
        .prepare(`SELECT * FROM oauth_pkce_sessions
        WHERE kind=$1 AND id_hash=$2 AND expires_at>clock_timestamp() FOR UPDATE`)
        .get(kind, authTokenHash(id))
      if (!row) throw fail('session_expired')
      const session = sessionFrom(row)
      validate(session)
      if (row.claim_id) throw fail('session_in_use')
      const claimId = crypto.randomUUID()
      const claimed = await this.db
        .prepare(`UPDATE oauth_pkce_sessions SET claim_id=$3
          WHERE kind=$1 AND id_hash=$2 AND expires_at>clock_timestamp()`)
        .run(kind, authTokenHash(id), claimId)
      if (claimed.changes !== 1) throw fail('session_expired')
      return { session, claimId }
    })
  }

  async finishPkce(kind, id, claimId, consume) {
    const result = consume
      ? await this.db
          .prepare('DELETE FROM oauth_pkce_sessions WHERE kind=$1 AND id_hash=$2 AND claim_id=$3')
          .run(kind, authTokenHash(id), claimId)
      : await this.db
          .prepare('UPDATE oauth_pkce_sessions SET claim_id=NULL WHERE kind=$1 AND id_hash=$2 AND claim_id=$3')
          .run(kind, authTokenHash(id), claimId)
    if (result.changes !== 1) throw fail('oauth_session_claim_lost')
  }

  async issueShell(purpose, resourceId, { scope = 'ops', ttlMs = 30_000, maxTickets = 0 } = {}) {
    const ticket = crypto.randomBytes(24).toString('base64url')
    return withTransaction(this.db, async () => {
      await this.db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [
        `vm2api:auth:${this.db.schema}`,
        `shell:${purpose}`,
      ])
      await this.db.prepare('DELETE FROM shell_tickets WHERE expires_at<=clock_timestamp()').run()
      if (maxTickets) {
        const row = await this.db.prepare('SELECT count(*) AS count FROM shell_tickets WHERE purpose=$1').get(purpose)
        if (row.count >= maxTickets) throw fail('shell_limit')
      }
      await this.db
        .prepare(`INSERT INTO shell_tickets (purpose,ticket_hash,resource_id,scope,expires_at)
        VALUES ($1,$2,$3,$4,clock_timestamp()+$5::bigint*interval '1 millisecond')`)
        .run(purpose, authTokenHash(ticket), resourceId, scope, ttlMs)
      return { ticket, expires_in: ttlMs / 1000 }
    })
  }

  async consumeShell(purpose, ticket, resourceId, { scope = 'ops' } = {}) {
    return withTransaction(this.db, async () => {
      const row = await this.db
        .prepare(`SELECT * FROM shell_tickets WHERE purpose=$1 AND ticket_hash=$2
        AND resource_id=$3 AND expires_at>clock_timestamp() FOR UPDATE`)
        .get(purpose, authTokenHash(ticket), resourceId)
      if (!row) return null
      if (row.scope !== scope) throw fail('shell_ticket_scope_mismatch')
      const consumed = await this.db
        .prepare('DELETE FROM shell_tickets WHERE purpose=$1 AND ticket_hash=$2 AND expires_at>clock_timestamp()')
        .run(purpose, authTokenHash(ticket))
      if (consumed.changes !== 1) return null
      return { resourceId: row.resource_id, scope: row.scope }
    })
  }

  async revokeShell(purpose, resourceId) {
    await this.db.prepare('DELETE FROM shell_tickets WHERE purpose=$1 AND resource_id=$2').run(purpose, resourceId)
  }
}
