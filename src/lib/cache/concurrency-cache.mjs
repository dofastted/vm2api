/**
 * Distributed Concurrency Slot, RPM Bucket, and Sticky Session Cache.
 *
 * Modeled on sub2api's `concurrency_cache.go`, `rpm_cache.go`, and `gateway_cache.go`:
 * - Uses Redis `TIME` inside Lua / MULTI-EXEC so multi-instance clock skew cannot cause ghost locks.
 * - Expired slots are pruned atomically on every acquire/count/batch read.
 * - Supports account/user/key scoped concurrency + Pipeline batch counts (`getBatchConcurrency`).
 * - Minute-bucket RPM counter (`checkAndIncrRpm`) via `MULTI/EXEC` + Redis `TIME`.
 * - Sticky Session helpers (`getSticky`/`setSticky`/`delSticky`) with 1h TTL, hit renewal, and instant delete on fault.
 * - Full Fail-Open degradation to in-process bounded Maps when Redis is unconfigured/unavailable.
 */
import { BoundedLruCache } from './cache-client.mjs'

const SLOT_PREFIX = 'conc:slot:'
const ACTIVE_INDEX_KEY = 'conc:active:scopes'
const RPM_PREFIX = 'rpm:'
const STICKY_PREFIX = 'sticky:'
const DEFAULT_TTL_SEC = 300
const DEFAULT_STICKY_TTL_MS = 3_600_000
const MAX_LOCAL_RPM_ENTRIES = 16_384
const MAX_LOCAL_STICKY_ENTRIES = 16_384

const ACQUIRE_SLOT_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1])
local ttl = tonumber(ARGV[1])
local maxSlots = tonumber(ARGV[2])
local reqId = ARGV[3]
local scope = ARGV[4]

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - ttl)
local count = redis.call('ZCARD', KEYS[1])
if count < maxSlots then
  redis.call('ZADD', KEYS[1], now, reqId)
  redis.call('EXPIRE', KEYS[1], ttl + 60)
  redis.call('SADD', KEYS[2], scope)
  return 1
end
return 0
`

const RELEASE_SLOT_LUA = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[2])
end
return 1
`

const REFRESH_SLOT_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1])
local ttl = tonumber(ARGV[1])
local reqId = ARGV[2]
if redis.call('ZSCORE', KEYS[1], reqId) then
  redis.call('ZADD', KEYS[1], now, reqId)
  redis.call('EXPIRE', KEYS[1], ttl + 60)
  return 1
end
return 0
`

const COUNT_SLOTS_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1])
local ttl = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - ttl)
return redis.call('ZCARD', KEYS[1])
`

export class ConcurrencyCache {
  constructor(cacheClient, { slotTtlSec = DEFAULT_TTL_SEC } = {}) {
    this.cache = cacheClient
    this.slotTtlSec = Math.max(10, Number(slotTtlSec) || DEFAULT_TTL_SEC)
    /** Fallback in-process slots: scope -> Map<reqId, expiresAtMs> */
    this.local = new Map()
    /** Fallback in-process RPM buckets: bucketKey -> { count, expiresAtMs } */
    this.localRpm = new Map()
    /** Fallback in-process Sticky sessions (used only when Redis is unavailable) */
    this.localSticky = new BoundedLruCache(MAX_LOCAL_STICKY_ENTRIES)
  }

  _pruneLocal(scope, now = Date.now()) {
    const map = this.local.get(scope)
    if (!map) return null
    for (const [id, exp] of map) {
      if (exp <= now) map.delete(id)
    }
    if (map.size === 0) {
      this.local.delete(scope)
      return null
    }
    return map
  }

  async _redisNowSec() {
    if (this.cache?.hasRedis && typeof this.cache.redis?.time === 'function') {
      try {
        const res = await this.cache.redis.time()
        const sec = Array.isArray(res) ? Number.parseInt(String(res[0]), 10) : Number(res)
        if (Number.isFinite(sec) && sec > 0) return sec
      } catch {
        this.cache.l2Errors += 1
      }
    }
    return Math.floor(Date.now() / 1000)
  }

  async acquire(scope, reqId, maxConcurrency, ttlSec = this.slotTtlSec) {
    const limit = Math.max(1, Number(maxConcurrency) || 1)
    const ttl = Math.max(5, Number(ttlSec) || this.slotTtlSec)
    if (this.cache?.hasRedis) {
      const res = await this.cache.evalLua(
        ACQUIRE_SLOT_LUA,
        [`${SLOT_PREFIX}${scope}`, ACTIVE_INDEX_KEY],
        [String(ttl), String(limit), String(reqId), String(scope)],
      )
      if (res != null) return Number(res) === 1
    }

    const now = Date.now()
    let map = this._pruneLocal(scope, now)
    if (!map) {
      map = new Map()
      this.local.set(scope, map)
    }
    if (map.has(reqId) || map.size < limit) {
      map.set(reqId, now + ttl * 1000)
      return true
    }
    return false
  }

  async release(scope, reqId) {
    if (this.cache?.hasRedis) {
      await this.cache.evalLua(
        RELEASE_SLOT_LUA,
        [`${SLOT_PREFIX}${scope}`, ACTIVE_INDEX_KEY],
        [String(reqId), String(scope)],
      )
    }
    const map = this.local.get(scope)
    if (map) {
      map.delete(reqId)
      if (map.size === 0) this.local.delete(scope)
    }
  }

  async refresh(scope, reqId, ttlSec = this.slotTtlSec) {
    const ttl = Math.max(5, Number(ttlSec) || this.slotTtlSec)
    if (this.cache?.hasRedis) {
      const res = await this.cache.evalLua(REFRESH_SLOT_LUA, [`${SLOT_PREFIX}${scope}`], [String(ttl), String(reqId)])
      if (res != null) return Number(res) === 1
    }
    const map = this.local.get(scope)
    if (map?.has(reqId)) {
      map.set(reqId, Date.now() + ttl * 1000)
      return true
    }
    return false
  }

  async count(scope, ttlSec = this.slotTtlSec) {
    const ttl = Math.max(5, Number(ttlSec) || this.slotTtlSec)
    if (this.cache?.hasRedis) {
      const res = await this.cache.evalLua(COUNT_SLOTS_LUA, [`${SLOT_PREFIX}${scope}`], [String(ttl)])
      if (res != null) return Number(res) || 0
    }
    const map = this._pruneLocal(scope)
    return map ? map.size : 0
  }

  // ---- Scoped User & API Key Concurrency Convenience Helpers ----

  acquireUser(userId, reqId, maxConcurrency, ttlSec = this.slotTtlSec) {
    return this.acquire(`user:${userId}`, reqId, maxConcurrency, ttlSec)
  }

  releaseUser(userId, reqId) {
    return this.release(`user:${userId}`, reqId)
  }

  refreshUser(userId, reqId, ttlSec = this.slotTtlSec) {
    return this.refresh(`user:${userId}`, reqId, ttlSec)
  }

  countUser(userId, ttlSec = this.slotTtlSec) {
    return this.count(`user:${userId}`, ttlSec)
  }

  acquireKey(keyId, reqId, maxConcurrency, ttlSec = this.slotTtlSec) {
    return this.acquire(`key:${keyId}`, reqId, maxConcurrency, ttlSec)
  }

  releaseKey(keyId, reqId) {
    return this.release(`key:${keyId}`, reqId)
  }

  countKey(keyId, ttlSec = this.slotTtlSec) {
    return this.count(`key:${keyId}`, ttlSec)
  }

  /**
   * Pipeline-batched active concurrency count for multiple IDs under `scope`
   * (e.g. scope='account'|'user'|'key', or '' if ids are already full scopes).
   * @returns {Promise<Map<string, number>>}
   */
  async getBatchConcurrency(scope, ids, ttlSec = this.slotTtlSec) {
    const out = new Map()
    if (!Array.isArray(ids) || !ids.length) return out
    const uniqueIds = [...new Set(ids.filter((id) => id != null && id !== '').map(String))]
    if (!uniqueIds.length) return out

    const ttl = Math.max(5, Number(ttlSec) || this.slotTtlSec)
    const prefix = scope ? `${scope}:` : ''

    if (this.cache?.hasRedis) {
      try {
        const nowSec = await this._redisNowSec()
        const cutoff = nowSec - ttl
        const pipe = this.cache.redis.pipeline()
        for (const id of uniqueIds) {
          const rKey = this.cache.redisKey(`${SLOT_PREFIX}${prefix}${id}`)
          pipe.zremrangebyscore(rKey, '-inf', cutoff)
          pipe.zcard(rKey)
        }
        const results = await pipe.exec()
        if (Array.isArray(results)) {
          for (let i = 0; i < uniqueIds.length; i += 1) {
            const [cardErr, cardVal] = results[i * 2 + 1] || []
            out.set(uniqueIds[i], !cardErr ? Number(cardVal) || 0 : 0)
          }
          return out
        }
      } catch {
        this.cache.l2Errors += 1
      }
    }

    const now = Date.now()
    for (const id of uniqueIds) {
      const map = this._pruneLocal(`${prefix}${id}`, now)
      out.set(id, map ? map.size : 0)
    }
    return out
  }

  // ---- Minute-Bucket RPM Counter (MULTI/EXEC + Redis TIME, Fail-Open) ----

  _pruneLocalRpm(nowMs) {
    if (this.localRpm.size < MAX_LOCAL_RPM_ENTRIES) return
    for (const [k, v] of this.localRpm) {
      if (v.expiresAtMs <= nowMs) this.localRpm.delete(k)
    }
    while (this.localRpm.size >= MAX_LOCAL_RPM_ENTRIES) {
      const oldest = this.localRpm.keys().next().value
      if (oldest === undefined) break
      this.localRpm.delete(oldest)
    }
  }

  /**
   * Check and increment a fixed-window RPM counter using Redis `TIME` + `MULTI/EXEC`.
   * Rejects without inflating the counter when `current > limit`.
   * Falls back to an in-process window bucket when Redis is unavailable.
   *
   * @returns {Promise<{ allowed: boolean, current: number, limit: number, remaining: number | null, retryAfterSec: number, resetAt: number }>}
   */
  async checkAndIncrRpm(scope, id, limit, windowSec = 60) {
    const cap = Number(limit) || 0
    const win = Math.max(1, Math.floor(Number(windowSec) || 60))
    if (cap <= 0 || !id) {
      return { allowed: true, current: 0, limit: 0, remaining: null, retryAfterSec: 0, resetAt: 0 }
    }

    const cleanScope = String(scope || 'key')
    const cleanId = String(id)

    if (this.cache?.hasRedis) {
      try {
        const nowSec = await this._redisNowSec()
        const bucket = Math.floor(nowSec / win)
        const resetSec = (bucket + 1) * win
        const retryAfterSec = Math.max(1, resetSec - nowSec)
        const rKey = this.cache.redisKey(`${RPM_PREFIX}${cleanScope}:${cleanId}:${bucket}`)

        const tx = this.cache.redis.multi()
        tx.incr(rKey)
        tx.expire(rKey, win * 2)
        const results = await tx.exec()
        const [incrErr, rawCount] = results?.[0] || []
        if (!incrErr && rawCount != null) {
          const count = Number(rawCount) || 0
          if (count > cap) {
            // Undo increment for rejected requests so counters stay accurate
            if (typeof this.cache.redis.decr === 'function') {
              this.cache.redis.decr(rKey).catch(() => {})
            }
            const effective = Math.max(cap, count - 1)
            return {
              allowed: false,
              current: effective,
              limit: cap,
              remaining: 0,
              retryAfterSec,
              resetAt: resetSec * 1000,
            }
          }
          return {
            allowed: true,
            current: count,
            limit: cap,
            remaining: Math.max(0, cap - count),
            retryAfterSec: 0,
            resetAt: resetSec * 1000,
          }
        }
      } catch {
        this.cache.l2Errors += 1
      }
    }

    // Local fallback (no Redis or Redis error -> Fail-Open with local enforcement)
    const nowMs = Date.now()
    const nowSec = Math.floor(nowMs / 1000)
    const bucket = Math.floor(nowSec / win)
    const resetSec = (bucket + 1) * win
    const retryAfterSec = Math.max(1, resetSec - nowSec)
    const localKey = `${cleanScope}:${cleanId}:${bucket}`
    this._pruneLocalRpm(nowMs)

    const existing = this.localRpm.get(localKey)
    const current = existing && existing.expiresAtMs > nowMs ? existing.count : 0
    if (current >= cap) {
      return {
        allowed: false,
        current,
        limit: cap,
        remaining: 0,
        retryAfterSec,
        resetAt: resetSec * 1000,
      }
    }
    const next = current + 1
    this.localRpm.set(localKey, { count: next, expiresAtMs: (resetSec + win) * 1000 })
    return {
      allowed: true,
      current: next,
      limit: cap,
      remaining: Math.max(0, cap - next),
      retryAfterSec: 0,
      resetAt: resetSec * 1000,
    }
  }

  /** Read current window RPM count without incrementing. */
  async getRpmCount(scope, id, windowSec = 60) {
    if (!id) return 0
    const win = Math.max(1, Math.floor(Number(windowSec) || 60))
    const cleanScope = String(scope || 'key')
    const cleanId = String(id)

    if (this.cache?.hasRedis) {
      try {
        const nowSec = await this._redisNowSec()
        const bucket = Math.floor(nowSec / win)
        const rKey = this.cache.redisKey(`${RPM_PREFIX}${cleanScope}:${cleanId}:${bucket}`)
        const raw = await this.cache.redis.get(rKey)
        return Math.max(0, Number.parseInt(String(raw ?? '0'), 10) || 0)
      } catch {
        this.cache.l2Errors += 1
      }
    }

    const nowMs = Date.now()
    const bucket = Math.floor(Math.floor(nowMs / 1000) / win)
    const entry = this.localRpm.get(`${cleanScope}:${cleanId}:${bucket}`)
    return entry && entry.expiresAtMs > nowMs ? entry.count : 0
  }

  // ---- Sticky Session Redis Helpers (1h TTL + Hit Renewal + Instant Delete on Fault) ----

  /**
   * Read a sticky session binding; automatically renews TTL on hit.
   * Returns parsed value (string or object) or null. Fail-Open on Redis errors.
   */
  async getSticky(key, { renewTtlMs = DEFAULT_STICKY_TTL_MS } = {}) {
    if (!key) return null
    const cleanKey = String(key)
    const renew = Math.max(0, Number(renewTtlMs) || 0)

    if (this.cache?.hasRedis) {
      try {
        const rKey = this.cache.redisKey(`${STICKY_PREFIX}${cleanKey}`)
        const raw = await this.cache.redis.get(rKey)
        if (raw == null) return null
        if (renew > 0 && typeof this.cache.redis.pexpire === 'function') {
          this.cache.redis.pexpire(rKey, renew).catch(() => {})
        }
        try {
          return JSON.parse(raw)
        } catch {
          return raw
        }
      } catch {
        this.cache.l2Errors += 1
      }
    }

    const local = this.localSticky.get(cleanKey)
    if (!local.hit) return null
    if (renew > 0) {
      this.localSticky.set(cleanKey, local.value, renew)
    }
    return local.value
  }

  /** Store a sticky session binding with 1h default TTL. */
  async setSticky(key, value, { ttlMs = DEFAULT_STICKY_TTL_MS } = {}) {
    if (!key || value === undefined || value === null) return false
    const cleanKey = String(key)
    const ttl = Math.max(1_000, Number(ttlMs) || DEFAULT_STICKY_TTL_MS)

    if (this.cache?.hasRedis) {
      try {
        const rKey = this.cache.redisKey(`${STICKY_PREFIX}${cleanKey}`)
        await this.cache.redis.set(rKey, JSON.stringify(value), 'PX', ttl)
        return true
      } catch {
        this.cache.l2Errors += 1
      }
    }

    this.localSticky.set(cleanKey, value, ttl)
    return true
  }

  /** Immediately delete a sticky session binding (e.g. on account fault / cooldown). */
  async delSticky(key) {
    if (!key) return false
    const cleanKey = String(key)
    const localDeleted = this.localSticky.delete(cleanKey)
    if (this.cache?.hasRedis) {
      try {
        const deleted = await this.cache.redis.del(this.cache.redisKey(`${STICKY_PREFIX}${cleanKey}`))
        return Number(deleted) > 0 || localDeleted
      } catch {
        this.cache.l2Errors += 1
      }
    }
    return localDeleted
  }
}
