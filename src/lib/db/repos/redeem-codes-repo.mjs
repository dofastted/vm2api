/**
 * redeem_codes repository — balance top-up codes.
 * Redeem is transactional: code flips unused→used and the user's balance is
 * credited in the same transaction.
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
    this._get = db.prepare('SELECT * FROM redeem_codes WHERE id = ?')
    this._getByCode = db.prepare('SELECT * FROM redeem_codes WHERE code = ?')
    this._insert = db.prepare(`
      INSERT INTO redeem_codes (code, type, value, status, notes, expires_at, created_at)
      VALUES (?, 'balance', ?, 'unused', ?, ?, ?)
    `)
    this._markUsed = db.prepare(`
      UPDATE redeem_codes SET status = 'used', used_by = ?, used_at = ?
      WHERE id = ? AND status = 'unused'
    `)
    this._delete = db.prepare("DELETE FROM redeem_codes WHERE id = ? AND status = 'unused'")
  }

  list() {
    return this._list.all().map(rowToRec)
  }

  getByCode(code) {
    return rowToRec(this._getByCode.get(String(code || '').trim()))
  }

  create({ value, notes = null, expires_at = null, code = null } = {}) {
    const v = Number(value)
    if (!Number.isFinite(v) || v <= 0) return null
    const c = code || generateRedeemCode()
    const info = this._insert.run(c, v, notes, expires_at, new Date().toISOString())
    return rowToRec(this._get.get(info.lastInsertRowid))
  }

  /** Unused codes only; used codes stay as the audit ledger. */
  remove(id) {
    return this._delete.run(id).changes > 0
  }

  /**
   * Redeem a code for a user: optimistic status flip + balance credit in one
   * transaction. Returns {ok, code?, error?}.
   */
  redeem(code, userId) {
    const rec = this.getByCode(code)
    if (!rec) return { ok: false, error: 'code_not_found' }
    if (rec.status !== 'unused') return { ok: false, error: 'code_used' }
    if (rec.expires_at && Date.parse(rec.expires_at) < Date.now()) {
      return { ok: false, error: 'code_expired' }
    }
    const user = this.users.getById(userId)
    if (!user) return { ok: false, error: 'user_not_found' }
    return withTransaction(this.db, () => {
      const info = this._markUsed.run(userId, new Date().toISOString(), rec.id)
      if (!info.changes) return { ok: false, error: 'code_used' }
      this.users.addBalance(userId, rec.value)
      return { ok: true, code: rowToRec(this._get.get(rec.id)) }
    })
  }
}
