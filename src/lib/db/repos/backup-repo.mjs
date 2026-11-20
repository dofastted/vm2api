/**
 * backup_records repository — ledger of local backup archives.
 */

import { getDb } from '../database.mjs'

const COLUMNS = [
  'id',
  'created_at',
  'kind',
  'status',
  'file_path',
  'file_name',
  'size_bytes',
  'sha256',
  'db_bytes',
  'includes_json',
  'error',
  'note',
]

function fromRow(row) {
  if (!row) return null
  let includes = null
  try {
    includes = row.includes_json ? JSON.parse(row.includes_json) : null
  } catch {}
  return { ...row, includes }
}

export class BackupRepo {
  constructor(db = getDb()) {
    this.db = db
    this._insert = db.prepare(`
      INSERT INTO backup_records (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map(() => '?').join(', ')})
    `)
    this._get = db.prepare('SELECT * FROM backup_records WHERE id = ?')
    this._list = db.prepare('SELECT * FROM backup_records ORDER BY created_at DESC LIMIT ?')
    this._remove = db.prepare('DELETE FROM backup_records WHERE id = ?')
  }

  insert(rec) {
    this._insert.run(
      ...COLUMNS.map((c) => {
        if (c === 'includes_json') return rec.includes ? JSON.stringify(rec.includes) : (rec.includes_json ?? null)
        return rec[c] ?? null
      }),
    )
    return this.get(rec.id)
  }

  get(id) {
    return fromRow(this._get.get(id))
  }

  list({ limit = 100 } = {}) {
    return this._list.all(Math.max(1, Math.min(500, Number(limit) || 100))).map(fromRow)
  }

  remove(id) {
    return this._remove.run(id).changes > 0
  }

  lastSuccessful({ kinds = null } = {}) {
    const rows = this.list({ limit: 200 })
    return rows.find((r) => r.status === 'ok' && (!kinds || kinds.includes(r.kind))) || null
  }

  /** Successful non-pre_restore backups beyond `keep` newest. */
  beyondRetention(keep) {
    const rows = this.list({ limit: 500 }).filter((r) => r.status === 'ok' && r.kind !== 'pre_restore')
    return rows.slice(Math.max(0, keep))
  }

  /** pre_restore backups beyond `keep` newest. */
  preRestoreBeyond(keep = 3) {
    const rows = this.list({ limit: 500 }).filter((r) => r.status === 'ok' && r.kind === 'pre_restore')
    return rows.slice(Math.max(0, keep))
  }
}
