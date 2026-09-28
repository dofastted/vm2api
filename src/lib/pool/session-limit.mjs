/**
 * Per-account sticky-session cap (sub2api-style, in-memory).
 * Existing keys renew; a new key is refused once active >= max.
 * max_sessions = 0 means off.
 *
 * Occupancy is a conversation window: PoolScheduler.reserve() touches,
 * release() drops inflight refs but keeps the key until idle prune.
 * A window with live refs is never idle: a long stream must not lose its
 * window mid-flight. Every touch hands back a generation; drop() retires it
 * so a late release from the old placement cannot decrement a new one.
 */

let generationSeq = 0

function lastSeenOf(entry) {
  if (entry == null) return 0
  if (typeof entry === 'object') return Number(entry.lastSeen) || 0
  return Number(entry) || 0
}

function refsOf(entry) {
  if (entry == null) return 0
  if (typeof entry === 'object') {
    const n = Number(entry.refs)
    return Number.isFinite(n) && n >= 0 ? n : 1
  }
  return 1
}

export class SessionLimitRegistry {
  constructor() {
    this.byAccount = new Map()
  }

  _bucket(accountId) {
    const id = String(accountId || '')
    if (!id) return null
    let bag = this.byAccount.get(id)
    if (!bag) {
      bag = new Map()
      this.byAccount.set(id, bag)
    }
    return bag
  }

  prune(accountId, idleMs, now = Date.now()) {
    const bag = this.byAccount.get(String(accountId || ''))
    if (!bag) return 0
    const cutoff = now - Math.max(0, Number(idleMs) || 0)
    for (const [key, entry] of bag) {
      if (refsOf(entry) > 0) continue
      if (lastSeenOf(entry) < cutoff) bag.delete(key)
    }
    if (!bag.size) this.byAccount.delete(String(accountId))
    return bag.size
  }

  snapshot(accountId, { max = 0, idleMin = 5, now = Date.now() } = {}) {
    const idleMs = Math.max(1, Number(idleMin) || 5) * 60_000
    const active = this.prune(accountId, idleMs, now)
    const cap = Number(max)
    return {
      active,
      max: Number.isFinite(cap) && cap > 0 ? cap : 0,
      idle_min: Math.max(1, Number(idleMin) || 5),
    }
  }

  has(accountId, sessionKey, { idleMin = 5, now = Date.now() } = {}) {
    const key = String(sessionKey || '')
    if (!key) return false
    const idleMs = Math.max(1, Number(idleMin) || 5) * 60_000
    this.prune(accountId, idleMs, now)
    const bag = this.byAccount.get(String(accountId || ''))
    return !!(bag && bag.has(key))
  }

  /**
   * @returns {{ ok: true, existing?: boolean } | { ok: false, reason: string, detail: object }}
   */
  canAccept(accountId, sessionKey, { max = 0, idleMin = 5, now = Date.now() } = {}) {
    const cap = Number(max)
    if (!Number.isFinite(cap) || cap <= 0) return { ok: true }
    const key = String(sessionKey || '')
    if (!key) return { ok: true }
    const snap = this.snapshot(accountId, { max: cap, idleMin, now })
    if (this.has(accountId, key, { idleMin, now })) {
      return { ok: true, existing: true, detail: snap }
    }
    if (snap.active >= cap) {
      return {
        ok: false,
        reason: 'session_limit',
        detail: { ...snap, session_key: key, retry_at: this.nextIdleAt(accountId, { idleMin, now }) },
      }
    }
    return { ok: true, existing: false, detail: snap }
  }

  /** @returns {number|null} generation the caller passes back to release(). */
  touch(accountId, sessionKey, now = Date.now()) {
    const key = String(sessionKey || '')
    if (!accountId || !key) return null
    const bag = this._bucket(accountId)
    const prev = bag.get(key)
    const gen = prev?.gen ?? ++generationSeq
    bag.set(key, { lastSeen: now, refs: prev == null ? 1 : refsOf(prev) + 1, gen })
    return gen
  }

  /** When the oldest idle session frees its window. Live windows never do. */
  nextIdleAt(accountId, { idleMin = 5, now = Date.now() } = {}) {
    const idleMs = Math.max(1, Number(idleMin) || 5) * 60_000
    this.prune(accountId, idleMs, now)
    const bag = this.byAccount.get(String(accountId || ''))
    if (!bag || !bag.size) return now
    let soonest = null
    for (const entry of bag.values()) {
      if (refsOf(entry) > 0) continue
      const freeAt = lastSeenOf(entry) + idleMs
      if (soonest == null || freeAt < soonest) soonest = freeAt
    }
    return soonest || null
  }

  /**
   * Drop one inflight ref. The key stays until idle prune: max_sessions is a
   * conversation cap, not a concurrent-request cap. The idle clock starts
   * when the last ref leaves, not when the first request arrived.
   */
  release(accountId, sessionKey, { gen = null, now = Date.now() } = {}) {
    const id = String(accountId || '')
    const key = String(sessionKey || '')
    if (!id || !key) return 0
    const bag = this.byAccount.get(id)
    if (!bag) return 0
    const prev = bag.get(key)
    if (prev == null) return bag.size
    if (gen != null && prev.gen != null && prev.gen !== gen) return bag.size
    bag.set(key, { lastSeen: Math.max(lastSeenOf(prev), now), refs: Math.max(0, refsOf(prev) - 1), gen: prev.gen })
    return bag.size
  }

  /** Conversation left this account. The window is free for a new session. */
  drop(accountId, sessionKey) {
    const id = String(accountId || '')
    const key = String(sessionKey || '')
    if (!id || !key) return 0
    const bag = this.byAccount.get(id)
    if (!bag) return 0
    bag.delete(key)
    if (bag.size === 0) this.byAccount.delete(id)
    return bag.size
  }

  reset(accountId = null) {
    if (accountId == null) {
      this.byAccount.clear()
      return
    }
    this.byAccount.delete(String(accountId))
  }
}

export const sessionLimit = new SessionLimitRegistry()
