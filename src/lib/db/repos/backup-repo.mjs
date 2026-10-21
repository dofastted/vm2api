/**
 * backup_records repository — ledger of local backup archives
 * (sub2api backup_records counterpart).
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
      VALUES (${COLUMNS.map((_, i) => '$' + (i + 1)).join(', ')})
    `)
    this._get = db.prepare('SELECT * FROM backup_records WHERE id = $1')
    this._list = db.prepare('SELECT * FROM backup_records ORDER BY created_at DESC LIMIT $1')
    this._remove = db.prepare('DELETE FROM backup_records WHERE id = $1')
  }

  async insert(rec) {
    await this._insert.run(
      ...COLUMNS.map((c) => {
        if (c === 'includes_json') return rec.includes ? JSON.stringify(rec.includes) : (rec.includes_json ?? null)
        return rec[c] ?? null
      }),
    )
    return await this.get(rec.id)
  }

  async get(id) {
    return fromRow(await this._get.get(id))
  }

  async list({ limit = 100 } = {}) {
    return (await this._list.all(Math.max(1, Math.min(500, Number(limit) || 100)))).map(fromRow)
  }

  async remove(id) {
    return (await this._remove.run(id)).changes > 0
  }

  async lastSuccessful({ kinds = null } = {}) {
    const rows = await this.list({ limit: 200 })
    return rows.find((r) => r.status === 'ok' && (!kinds || kinds.includes(r.kind))) || null
  }

  /** Successful non-pre_restore backups beyond `keep` newest. */
  async beyondRetention(keep) {
    const rows = (await this.list({ limit: 500 })).filter((r) => r.status === 'ok' && r.kind !== 'pre_restore')
    return rows.slice(Math.max(0, keep))
  }

  /** pre_restore backups beyond `keep` newest. */
  async preRestoreBeyond(keep = 3) {
    const rows = (await this.list({ limit: 500 })).filter((r) => r.status === 'ok' && r.kind === 'pre_restore')
    return rows.slice(Math.max(0, keep))
  }
}
