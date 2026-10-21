/**
 * Permanent ban of an inbound client device_id after a refusal-guard hit.
 * Empty ids are never stored. This is not the slot's outbound device.
 */
import { getDb } from '../database.mjs'

function rowToRec(row) {
  if (!row) return null
  return {
    device_id: row.device_id,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    hit_count: Number(row.hit_count) || 0,
    source_request_id: row.source_request_id,
    fingerprint: row.fingerprint,
    reason: row.reason,
  }
}

export class RefusalDeviceBlocksRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT * FROM refusal_device_blocks WHERE device_id = $1')
    this._insert = db.prepare(`
      INSERT INTO refusal_device_blocks (
        device_id, first_seen_at, last_seen_at, hit_count,
        source_request_id, fingerprint, reason
      ) VALUES ($1, $2, $3, 0, $4, $5, $6)
      ON CONFLICT(device_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        source_request_id = COALESCE(refusal_device_blocks.source_request_id, excluded.source_request_id),
        fingerprint = COALESCE(refusal_device_blocks.fingerprint, excluded.fingerprint),
        reason = COALESCE(refusal_device_blocks.reason, excluded.reason)
    `)
    this._hit = db.prepare(`
      UPDATE refusal_device_blocks SET hit_count = hit_count + 1, last_seen_at = $1
      WHERE device_id = $2
    `)
    this._list = db.prepare('SELECT * FROM refusal_device_blocks ORDER BY last_seen_at DESC, device_id LIMIT $1')
    this._count = db.prepare('SELECT COUNT(*) AS n FROM refusal_device_blocks')
    this._remove = db.prepare('DELETE FROM refusal_device_blocks WHERE device_id = $1')
    this._clear = db.prepare('DELETE FROM refusal_device_blocks')
  }

  async get(deviceId) {
    const id = String(deviceId || '').trim()
    if (!id) return null
    return rowToRec(await this._get.get(id))
  }

  async block({ deviceId, requestId = null, fingerprint = null, reason = 'refusal_guard' } = {}) {
    const id = String(deviceId || '').trim()
    if (!id) return null
    const now = new Date().toISOString()
    await this._insert.run(id, now, now, requestId, fingerprint, reason ? String(reason).slice(0, 80) : null)
    return await this.get(id)
  }

  async hit(deviceId) {
    const id = String(deviceId || '').trim()
    if (!id) return null
    await this._hit.run(new Date().toISOString(), id)
    return await this.get(id)
  }

  async list(limit = 200) {
    const n = Math.min(500, Math.max(1, Number(limit) || 200))
    return (await this._list.all(n)).map(rowToRec)
  }

  async count() {
    return Number((await this._count.get())?.n) || 0
  }

  async remove(deviceId) {
    const id = String(deviceId || '').trim()
    if (!id) return false
    return (await this._remove.run(id)).changes > 0
  }

  async clear() {
    return (await this._clear.run()).changes
  }
}
