/**
 * redeem_codes repository — balance top-up codes (sub2api baseline shape).
 * Redeem is transactional: code flips unused→used and the user's balance is
 * credited in the same transaction (sub2api RedeemService counterpart).
 */

import crypto from 'node:crypto'
import { getDb, withTransaction } from '../database.mjs'
import { UsersRepo } from './users-repo.mjs'

function rowToRec(row) {
  if (!row) return null
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    value: Number(row.value) || 0,
    status: row.status,
    used_by: row.used_by,
    used_at: row.used_at,
    notes: row.notes,
    expires_at: row.expires_at,
    created_at: row.created_at,
  }
}

export function generateRedeemCode() {
  return 'kin-' + crypto.randomBytes(12).toString('hex')
}

export class RedeemCodesRepo {
  constructor(db = getDb()) {
    this.db = db
    this.users = new UsersRepo(db)
    this._list = db.prepare('SELECT * FROM redeem_codes ORDER BY id DESC')
    this._get = db.prepare('SELECT * FROM redeem_codes WHERE id = $1')
    this._getByCode = db.prepare('SELECT * FROM redeem_codes WHERE code = $1')
    this._insert = db.prepare(`
      INSERT INTO redeem_codes (code, type, value, status, notes, expires_at, created_at)
      VALUES ($1, 'balance', $2, 'unused', $3, $4, $5) RETURNING *
    `)
    this._markUsed = db.prepare(`
      UPDATE redeem_codes SET status = 'used', used_by = $1, used_at = $2
      WHERE id = $3 AND status = 'unused'
    `)
    this._delete = db.prepare("DELETE FROM redeem_codes WHERE id = $1 AND status = 'unused'")
  }

  async list() {
    return (await this._list.all()).map(rowToRec)
  }

  async getByCode(code) {
    return rowToRec(await this._getByCode.get(String(code || '').trim()))
  }

  async create({ value, notes = null, expires_at = null, code = null } = {}) {
    const v = Number(value)
    if (!Number.isFinite(v) || v <= 0) return null
    const c = code || generateRedeemCode()
    return rowToRec(await this._insert.get(c, v, notes, expires_at, new Date().toISOString()))
  }

  /** Unused codes only; used codes stay as the audit ledger. */
  async remove(id) {
    return (await this._delete.run(id)).changes > 0
  }

  /**
   * Redeem a code for a user: optimistic status flip + balance credit in one
   * transaction. Returns {ok, code?, error?}.
   */
  async redeem(code, userId) {
    const rec = await this.getByCode(code)
    if (!rec) return { ok: false, error: 'code_not_found' }
    if (rec.status !== 'unused') return { ok: false, error: 'code_used' }
    if (rec.expires_at && Date.parse(rec.expires_at) < Date.now()) {
      return { ok: false, error: 'code_expired' }
    }
    return await withTransaction(this.db, async () => {
      const user = await this.users.getById(userId, { forUpdate: true })
      if (!user) return { ok: false, error: 'user_not_found' }
      const info = await this._markUsed.run(userId, new Date().toISOString(), rec.id)
      if (!info.changes) return { ok: false, error: 'code_used' }
      await this.users.addBalance(userId, rec.value)
      return { ok: true, code: rowToRec(await this._get.get(rec.id)) }
    })
  }
}
