/**
 * Distributed Concurrency Slot Cache using Redis Sorted Sets + server TIME Lua scripts.
 *
 * Modeled on sub2api's `concurrency_cache.go`:
 * - Uses Redis `TIME` inside Lua so multi-instance clock skew cannot cause ghost locks.
 * - Expired slots are pruned atomically on every acquire/count.
 * - Falls back cleanly to an in-process Map when Redis is unconfigured/unavailable.
 */

const SLOT_PREFIX = 'conc:slot:'
const ACTIVE_INDEX_KEY = 'conc:active:scopes'
const DEFAULT_TTL_SEC = 300

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
}
