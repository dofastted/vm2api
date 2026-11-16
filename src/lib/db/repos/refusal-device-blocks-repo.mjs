import { createHash } from 'node:crypto'
import { getDb } from '../database.mjs'

function subjectKey(identity, kind, value = kind === 'session' ? identity.sessionId : identity.deviceId) {
  return value
    ? 'risk:' +
        createHash('sha256')
          .update(JSON.stringify([identity.principal || '', kind, value]))
          .digest('hex')
    : ''
}

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
    subject_kind: row.subject_kind,
    identity_value: row.identity_value || row.device_id,
    session_id: row.session_id,
    violations: Number(row.violations),
    expires_at: row.expires_at,
  }
}

export class RefusalDeviceBlocksRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT * FROM refusal_device_blocks WHERE device_id = ?')
    this._alias = db.prepare('SELECT device_key FROM risk_device_aliases WHERE alias_key = ?')
    this._bindAlias = db.prepare('INSERT OR IGNORE INTO risk_device_aliases (alias_key, device_key) VALUES (?, ?)')
    this._insert = db.prepare(`
      INSERT INTO refusal_device_blocks (
        device_id, first_seen_at, last_seen_at, hit_count,
        source_request_id, fingerprint, reason
      ) VALUES (?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        source_request_id = COALESCE(refusal_device_blocks.source_request_id, excluded.source_request_id),
        fingerprint = COALESCE(refusal_device_blocks.fingerprint, excluded.fingerprint),
        reason = COALESCE(refusal_device_blocks.reason, excluded.reason)
    `)
    this._hit = db.prepare(`
      UPDATE refusal_device_blocks SET hit_count = hit_count + 1, last_seen_at = ?
      WHERE device_id = ?
    `)
    this._violation = db.prepare(`
      INSERT INTO refusal_device_blocks (
        device_id, first_seen_at, last_seen_at, source_request_id, fingerprint, reason,
        subject_kind, identity_value, session_id, violations, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at, source_request_id = excluded.source_request_id,
        fingerprint = excluded.fingerprint, reason = excluded.reason, session_id = excluded.session_id,
        violations = excluded.violations, expires_at = excluded.expires_at
    `)
    this._list = db.prepare('SELECT * FROM refusal_device_blocks ORDER BY last_seen_at DESC, device_id LIMIT ?')
    this._count = db.prepare('SELECT COUNT(*) AS n FROM refusal_device_blocks')
    this._remove = db.prepare('DELETE FROM refusal_device_blocks WHERE device_id = ?')
    this._clear = db.prepare('DELETE FROM refusal_device_blocks')
  }

  get(deviceId) {
    const id = String(deviceId || '').trim()
    if (!id) return null
    return rowToRec(this._get.get(id))
  }

  findBan(identity, now = Date.now(), accepts = () => true) {
    const sessionKey = subjectKey(identity, 'session')
    const session = sessionKey && this.get(sessionKey)
    if (session?.subject_kind === 'session' && accepts(session)) return session
    for (const { key, value } of this.deviceSubjects(identity)) {
      const device = this.get(key)
      if (
        device?.subject_kind === 'device' &&
        accepts(device) &&
        (!device.expires_at || Date.parse(device.expires_at) > now)
      )
        return device
      const legacy = this._get.get(value)
      if (legacy && !legacy.identity_value && accepts(legacy)) return rowToRec(legacy)
    }
    return null
  }

  deviceSubjects(identity) {
    return [...new Set([identity.deviceId, identity.machineId].filter(Boolean))].map((value) => {
      const alias = subjectKey(identity, 'device', value)
      return { alias, key: this._alias.get(alias)?.device_key || alias, value }
    })
  }

  recordViolation(
    identity,
    { requestId = null, fingerprint = null, reason = 'refusal_guard', steps, now = Date.now(), accepts },
  ) {
    if (!identity.deviceId && !identity.machineId && !identity.sessionId) return null
    const sessionKey = subjectKey(identity, 'session')
    const at = new Date(now).toISOString()
    const why = String(reason).slice(0, 160)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.findBan(identity, now, accepts)
      const subjects = this.deviceSubjects(identity)
      const prior = subjects.map(({ key }) => this._get.get(key)).find(Boolean)
      const deviceKey =
        existing?.subject_kind === 'device' && existing.identity_value !== existing.device_id
          ? existing.device_id
          : prior?.device_id || subjects[0]?.key
      const violations = existing?.violations || (prior?.violations || 0) + 1
      const minutes = steps[Math.min(violations, steps.length) - 1]
      const expiresAt = minutes === 0 ? null : new Date(now + minutes * 60_000).toISOString()
      if (deviceKey && !existing) {
        this._violation.run(
          deviceKey,
          at,
          at,
          requestId,
          fingerprint,
          why,
          'device',
          prior?.identity_value || identity.deviceId || identity.machineId,
          identity.sessionId || null,
          violations,
          expiresAt,
        )
      }
      if (deviceKey && (!existing || existing.device_id === deviceKey)) {
        for (const { alias, key } of subjects) {
          if (alias !== deviceKey && !this._get.get(key)) this._bindAlias.run(alias, deviceKey)
        }
      }
      const priorSession = sessionKey && this._get.get(sessionKey)
      if (sessionKey && (!priorSession || (accepts && !accepts(priorSession)))) {
        this._violation.run(
          sessionKey,
          at,
          at,
          requestId,
          fingerprint,
          why,
          'session',
          identity.sessionId,
          identity.sessionId,
          violations,
          null,
        )
      }
      this.db.exec('COMMIT')
      return existing || this.get(deviceKey || sessionKey)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  block({ deviceId, requestId = null, fingerprint = null, reason = 'refusal_guard' } = {}) {
    const id = String(deviceId || '').trim()
    if (!id) return null
    const now = new Date().toISOString()
    this._insert.run(id, now, now, requestId, fingerprint, reason ? String(reason).slice(0, 80) : null)
    return this.get(id)
  }

  hit(deviceId) {
    const id = String(deviceId || '').trim()
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

  remove(deviceId) {
    const id = String(deviceId || '').trim()
    if (!id) return false
    return this._remove.run(id).changes > 0
  }

  clear() {
    return this._clear.run().changes
  }
}
