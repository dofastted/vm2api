/**
 * refusal_guards — persisted AUP fingerprints. Lookup before hop; remember after refusal.
 * signature is the user-text MinHash used for the 90% near-duplicate check.
 *
 * Maintains a per-DB in-process revision snapshot (pre-decoded MinHash signatures)
 * invalidated on local writes and cross-instance `risk:guards:` broadcasts so
 * `get()` and `nearest()` never full-scan `refusal_guards` on the request hot path.
 */
import { decodeSignature, REFUSAL_SIMILARITY, signatureSimilarity } from '../../core/refusal-similarity.mjs'
import { getCacheRuntime, registerLocalCacheClearer } from '../../cache/index.mjs'
import { getDb, isDbOpen } from '../database.mjs'

const GUARD_CACHE_PREFIX = 'risk:guards:'
const SNAPSHOT_TTL_MS = 60_000

let dbSnapshots = new WeakMap() // db -> { revision, loadedAt, byFingerprint, signatures }
const hookedClients = new WeakSet()

function ensureGuardInvalidationHook(cache) {
  const client = cache?.client
  if (!client || typeof client.onInvalidate !== 'function' || hookedClients.has(client)) return
  hookedClients.add(client)
  client.onInvalidate((payload) => {
    if (!payload) return
    const matchPrefix =
      Array.isArray(payload.prefixes) &&
      payload.prefixes.some((p) => p === GUARD_CACHE_PREFIX || GUARD_CACHE_PREFIX.startsWith(p))
    if (matchPrefix) {
      invalidateRefusalGuardsSnapshot()
    }
  })
}

export function invalidateRefusalGuardsSnapshot(db = null) {
  if (db) {
    dbSnapshots.delete(db)
  } else {
    dbSnapshots = new WeakMap()
  }
}

registerLocalCacheClearer(({ db = null } = {}) => {
  invalidateRefusalGuardsSnapshot(db)
})

function rowToRec(row) {
  if (!row) return null
  return {
    fingerprint: row.fingerprint,
    model: row.model,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    hit_count: Number(row.hit_count) || 0,
    source_request_id: row.source_request_id,
    error_message: row.error_message,
    preview: row.preview,
    expires_at: row.expires_at || null,
  }
}

export class RefusalGuardsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT * FROM refusal_guards WHERE fingerprint = ?')
    this._allActive = db.prepare(
      `SELECT fingerprint, model, first_seen_at, last_seen_at, hit_count,
              source_request_id, error_message, preview, expires_at, signature
       FROM refusal_guards
       WHERE expires_at IS NULL OR expires_at > ?`,
    )
    this._insert = db.prepare(`
      INSERT INTO refusal_guards (
        fingerprint, model, first_seen_at, last_seen_at, hit_count,
        source_request_id, error_message, preview, expires_at, signature
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        error_message = COALESCE(excluded.error_message, refusal_guards.error_message),
        preview = COALESCE(excluded.preview, refusal_guards.preview),
        signature = COALESCE(excluded.signature, refusal_guards.signature),
        expires_at = CASE
          WHEN refusal_guards.expires_at IS NULL THEN NULL
          WHEN excluded.expires_at IS NULL THEN NULL
          ELSE excluded.expires_at
        END
    `)
    this._hit = db.prepare(`
      UPDATE refusal_guards SET hit_count = hit_count + 1, last_seen_at = ?
      WHERE fingerprint = ?
    `)
    this._list = db.prepare(
      `SELECT fingerprint, model, first_seen_at, last_seen_at, hit_count,
              source_request_id, error_message, preview, expires_at
       FROM refusal_guards ORDER BY last_seen_at DESC, fingerprint LIMIT ?`,
    )
    this._signatures = db.prepare(
      `SELECT fingerprint, signature FROM refusal_guards
       WHERE signature IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    this._count = db.prepare('SELECT COUNT(*) AS n FROM refusal_guards')
    this._remove = db.prepare('DELETE FROM refusal_guards WHERE fingerprint = ?')
    this._clear = db.prepare('DELETE FROM refusal_guards')
  }

  _invalidateSnapshot(broadcast = true) {
    dbSnapshots.delete(this.db)
    if (broadcast && isDbOpen() && this.db === getDb()) {
      const client = getCacheRuntime()?.client
      client?.invalidate?.({ prefixes: [GUARD_CACHE_PREFIX] }).catch(() => {})
    }
  }

  _ensureSnapshot(now = Date.now()) {
    ensureGuardInvalidationHook(getCacheRuntime())
    const existing = dbSnapshots.get(this.db)
    if (existing && now - existing.loadedAt < SNAPSHOT_TTL_MS) {
      return existing
    }
    const rows = this._allActive.all(new Date(now).toISOString())
    const byFingerprint = new Map()
    const signatures = []
    for (const row of rows) {
      const rec = rowToRec(row)
      if (!rec) continue
      const expiresAtMs = rec.expires_at ? Date.parse(rec.expires_at) : null
      if (expiresAtMs != null && Number.isFinite(expiresAtMs) && expiresAtMs <= now) continue
      byFingerprint.set(rec.fingerprint, { rec, expiresAtMs })
      if (row.signature != null) {
        const decoded = decodeSignature(row.signature)
        if (decoded) {
          signatures.push({ fingerprint: rec.fingerprint, sig: decoded, expiresAtMs })
        }
      }
    }
    const snap = {
      revision: (existing?.revision || 0) + 1,
      loadedAt: now,
      byFingerprint,
      signatures,
    }
    dbSnapshots.set(this.db, snap)
    return snap
  }

  get(fingerprint) {
    const fp = String(fingerprint || '')
    if (!fp) return null
    const now = Date.now()
    const snap = this._ensureSnapshot(now)
    const entry = snap.byFingerprint.get(fp)
    if (!entry) return null
    if (entry.expiresAtMs != null && Number.isFinite(entry.expiresAtMs) && entry.expiresAtMs <= now) {
      this.remove(fp)
      return null
    }
    return { ...entry.rec }
  }

  remember({
    fingerprint,
    model = '',
    requestId = null,
    errorMessage = null,
    preview = null,
    expiresAt = null,
    signature = null,
  } = {}) {
    const fp = String(fingerprint || '').trim()
    if (!fp) return null
    const now = new Date().toISOString()
    this._insert.run(
      fp,
      String(model || ''),
      now,
      now,
      requestId,
      errorMessage ? String(errorMessage).slice(0, 500) : null,
      preview ? String(preview).slice(0, 240) : null,
      expiresAt || null,
      signature || null,
    )
    this._invalidateSnapshot(true)
    return this.get(fp)
  }

  hit(fingerprint) {
    const fp = String(fingerprint || '').trim()
    if (!fp) return null
    const nowIsoStr = new Date().toISOString()
    this._hit.run(nowIsoStr, fp)
    const snap = dbSnapshots.get(this.db)
    const entry = snap?.byFingerprint?.get(fp)
    if (entry) {
      entry.rec.hit_count = (Number(entry.rec.hit_count) || 0) + 1
      entry.rec.last_seen_at = nowIsoStr
      return { ...entry.rec }
    }
    return this.get(fp)
  }

  /** Highest stored user-text signature at or above the threshold (served from in-memory snapshot). */
  nearest(signature, threshold = REFUSAL_SIMILARITY) {
    const query = Array.isArray(signature) ? signature : decodeSignature(signature)
    if (!query) return null
    const now = Date.now()
    const snap = this._ensureSnapshot(now)
    let best = null
    for (const item of snap.signatures) {
      if (item.expiresAtMs != null && Number.isFinite(item.expiresAtMs) && item.expiresAtMs <= now) continue
      const score = signatureSimilarity(query, item.sig)
      if (score < threshold) continue
      if (!best || score > best.score) best = { fingerprint: item.fingerprint, score }
      if (score === 1) break
    }
    if (!best) return null
    const rec = this.get(best.fingerprint)
    if (!rec) return null
    return { ...rec, score: best.score }
  }

  list(limit = 200) {
    const n = Math.min(500, Math.max(1, Number(limit) || 200))
    const now = Date.now()
    return this._list
      .all(n)
      .map(rowToRec)
      .filter((rec) => !rec.expires_at || Date.parse(rec.expires_at) > now)
  }

  count() {
    return Number(this._count.get()?.n) || 0
  }

  remove(fingerprint) {
    const fp = String(fingerprint || '').trim()
    if (!fp) return false
    const removed = this._remove.run(fp).changes > 0
    if (removed) this._invalidateSnapshot(true)
    return removed
  }

  clear() {
    const changes = this._clear.run().changes
    this._invalidateSnapshot(true)
    return changes
  }
}
