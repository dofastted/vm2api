/**
 * users repository — sub2api-shaped users table.
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
    this._get = db.prepare('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL')
    this._getByName = db.prepare(
      'SELECT * FROM users WHERE ascii_fold(username) = ascii_fold($1) AND deleted_at IS NULL',
    )
    this._insert = db.prepare(`
      INSERT INTO users (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map((_, i) => '$' + (i + 1)).join(', ')})
    `)
    this._softDelete = db.prepare(
      'UPDATE users SET deleted_at = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL',
    )
    this._countRole = db.prepare(
      "SELECT COUNT(*) AS c FROM users WHERE role = $1 AND status = 'active' AND deleted_at IS NULL",
    )
    this._addBalance = db.prepare(
      'UPDATE users SET balance = balance + $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL',
    )
  }

  async list() {
    return (await this._list.all()).map(rowToRec)
  }

  async getById(id, { forUpdate = false } = {}) {
    return rowToRec(
      await (forUpdate
        ? this.db.prepare('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE')
        : this._get
      ).get(id),
    )
  }

  async getByUsername(username) {
    return rowToRec(await this._getByName.get(String(username || '').trim()))
  }

  async insert(rec) {
    await this._insert.run(
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
    return await this.getById(rec.id)
  }

  async update(rec) {
    const cols = COLUMNS.filter((c) => c !== 'id' && c !== 'deleted_at')
    const sql = `UPDATE users SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1} AND deleted_at IS NULL`
    await this.db.prepare(sql).run(
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
    return await this.getById(rec.id)
  }

  /** Soft delete (sub2api SoftDeleteMixin semantics). */
  async remove(id) {
    const now = new Date().toISOString()
    return (await this._softDelete.run(now, now, id)).changes > 0
  }

  async countEnabledRole(role) {
    const row = await this._countRole.get(role)
    return Number(row?.c || 0)
  }

  async touchLogin(id, at) {
    await this.db.prepare('UPDATE users SET last_login_at = $1 WHERE id = $2 AND deleted_at IS NULL').run(at, id)
  }

  /** Atomic balance credit/debit (redeem, billing). Negative delta = charge. */
  async addBalance(id, delta) {
    await this._addBalance.run(Number(delta) || 0, new Date().toISOString(), id)
    return await this.getById(id)
  }
}
