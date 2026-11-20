/**
 * Repository for console user records.
 *
 * Superset of the old PanelUsersRepo contract: console operators are now
 * first-class users with balance/concurrency. `enabled` is projected from
 * status ('active' ↔ enabled) so panel-users.mjs keeps its record shape.
 * Soft delete: rows with deleted_at are invisible to every query here.
 */

const COLUMNS = [
  'id',
  'email',
  'username',
  'password_hash',
  'role',
  'balance',
  'concurrency',
  'vm_create_quota',
  'status',
  'notes',
  'last_login_at',
  'last_active_at',
  'created_at',
  'updated_at',
  'deleted_at',
]

function rowToRec(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    password_hash: row.password_hash,
    role: row.role,
    balance: Number(row.balance) || 0,
    concurrency: Number(row.concurrency) || 0,
    vm_create_quota: Number(row.vm_create_quota) || 0,
    status: row.status,
    enabled: row.status === 'active',
    notes: row.notes ?? '',
    last_login_at: row.last_login_at,
    last_active_at: row.last_active_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function statusOf(rec) {
  // explicit boolean `enabled` wins over a stale status carried on the record
  if (typeof rec.enabled === 'boolean') return rec.enabled ? 'active' : 'disabled'
  return rec.status ?? 'active'
}

export class UsersRepo {
  constructor(db) {
    this.db = db
    this._list = db.prepare('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at, username')
    this._get = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL')
    this._getByName = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL')
    this._insert = db.prepare(`
      INSERT INTO users (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map(() => '?').join(', ')})
    `)
    this._softDelete = db.prepare('UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    this._countRole = db.prepare(
      "SELECT COUNT(*) AS c FROM users WHERE role = ? AND status = 'active' AND deleted_at IS NULL",
    )
    this._addBalance = db.prepare(
      'UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    )
  }

  list() {
    return this._list.all().map(rowToRec)
  }

  getById(id) {
    return rowToRec(this._get.get(id))
  }

  getByUsername(username) {
    return rowToRec(this._getByName.get(String(username || '').trim()))
  }

  insert(rec) {
    this._insert.run(
      ...COLUMNS.map((c) => {
        if (c === 'email') return rec.email ?? `${rec.username}@panel.local`
        if (c === 'status') return statusOf(rec)
        if (c === 'balance') return rec.balance ?? 0
        if (c === 'concurrency') return rec.concurrency ?? 5
        if (c === 'vm_create_quota') return rec.vm_create_quota ?? 0
        if (c === 'notes') return rec.notes ?? ''
        if (c === 'deleted_at') return null
        return rec[c] ?? null
      }),
    )
    return this.getById(rec.id)
  }

  update(rec) {
    const cols = COLUMNS.filter((c) => c !== 'id' && c !== 'deleted_at')
    const sql = `UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND deleted_at IS NULL`
    this.db.prepare(sql).run(
      ...cols.map((c) => {
        if (c === 'email') return rec.email ?? `${rec.username}@panel.local`
        if (c === 'status') return statusOf(rec)
        if (c === 'balance') return rec.balance ?? 0
        if (c === 'concurrency') return rec.concurrency ?? 5
        if (c === 'vm_create_quota') return rec.vm_create_quota ?? 0
        if (c === 'notes') return rec.notes ?? ''
        return rec[c] ?? null
      }),
      rec.id,
    )
    return this.getById(rec.id)
  }

  /** Soft-delete the user by setting `deleted_at`. */
  remove(id) {
    const now = new Date().toISOString()
    return this._softDelete.run(now, now, id).changes > 0
  }

  countEnabledRole(role) {
    const row = this._countRole.get(role)
    return Number(row?.c || 0)
  }

  /** Atomic balance credit/debit (redeem, billing). Negative delta = charge. */
  addBalance(id, delta) {
    this._addBalance.run(Number(delta) || 0, new Date().toISOString(), id)
    return this.getById(id)
  }
}
