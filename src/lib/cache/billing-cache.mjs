/**
 * Billing & rate-limit window cache with jittered TTL and atomic Redis Lua scripts.
 *
 * Modeled on sub2api's `billing_cache.go`:
 * - Uses jittered TTL (`5m - rand(30s)`) to prevent synchronized cache stampedes.
 * - Atomic balance deduction via Lua when Redis is active (no read-modify-write race).
 * - Sliding/fixed window rate-limit accounting (5h / 1d / 7d) with graceful L1 fallback.
 */

const BALANCE_PREFIX = 'billing:bal:'
const RATE_LIMIT_PREFIX = 'billing:rl:'
const DEFAULT_TTL_MS = 300_000
const DEFAULT_JITTER_MS = 30_000

// Atomically subtract cost from cached balance only if key exists (avoids resurrecting evicted keys)
const DEDUCT_BALANCE_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then
  return nil
end
local next = tonumber(cur) - tonumber(ARGV[1])
local pttl = redis.call('PTTL', KEYS[1])
if pttl > 0 then
  redis.call('SET', KEYS[1], tostring(next), 'PX', pttl)
else
  redis.call('SET', KEYS[1], tostring(next), 'PX', tonumber(ARGV[2]))
end
return tostring(next)
`

// Atomically increment a rate-limit usage counter with expiry
const INCR_WINDOW_LUA = `
local cur = redis.call('GET', KEYS[1])
local delta = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local next = (tonumber(cur) or 0) + delta
if cur then
  local pttl = redis.call('PTTL', KEYS[1])
  if pttl > 0 then
    redis.call('SET', KEYS[1], tostring(next), 'PX', pttl)
  else
    redis.call('SET', KEYS[1], tostring(next), 'PX', ttl)
  end
else
  redis.call('SET', KEYS[1], tostring(next), 'PX', ttl)
end
return tostring(next)
`

export class BillingCache {
  constructor(cacheClient, { ttlMs = DEFAULT_TTL_MS, jitterMs = DEFAULT_JITTER_MS } = {}) {
    this.cache = cacheClient
    this.ttlMs = Math.max(5_000, Number(ttlMs) || DEFAULT_TTL_MS)
    this.jitterMs = Math.max(0, Number(jitterMs) || DEFAULT_JITTER_MS)
  }

  async getUserBalance(userId, loader) {
    if (!userId) return 0
    if (!this.cache?.enabled) return loader()
    return this.cache.getOrLoad(`${BALANCE_PREFIX}${userId}`, loader, {
      ttlMs: this.ttlMs,
      jitterMs: this.jitterMs,
    })
  }

  async setUserBalance(userId, balance) {
    if (!userId || !this.cache?.enabled) return
    await this.cache.set(`${BALANCE_PREFIX}${userId}`, Number(balance) || 0, {
      ttlMs: this.ttlMs,
      jitterMs: this.jitterMs,
    })
  }

  /** Atomically deduct amount from cached balance in L2 Redis + update L1. */
  async deductUserBalance(userId, amount) {
    if (!userId || !this.cache?.enabled) return null
    const delta = Number(amount) || 0
    if (delta === 0) return null
    const key = `${BALANCE_PREFIX}${userId}`

    if (this.cache.hasRedis) {
      const luaRes = await this.cache.evalLua(DEDUCT_BALANCE_LUA, [key], [String(delta), String(this.ttlMs)])
      if (luaRes != null) {
        const next = Number(luaRes)
        if (Number.isFinite(next)) {
          this.cache.setL1(key, next, this.ttlMs, this.jitterMs)
          return next
        }
      }
    }

    const l1 = this.cache.getL1(key)
    if (l1.hit && Number.isFinite(Number(l1.value))) {
      const next = Number(l1.value) - delta
      this.cache.setL1(key, next, this.ttlMs, this.jitterMs)
      return next
    }
    return null
  }

  async invalidateUserBalance(userId) {
    if (!userId || !this.cache) return
    await this.cache.invalidate({ keys: [`${BALANCE_PREFIX}${userId}`] })
  }

  async recordKeyWindowUsage(apiKeyId, windowName, costDelta, windowTtlMs) {
    if (!apiKeyId || !windowName || !this.cache?.enabled) return null
    const delta = Number(costDelta) || 0
    const ttl = Math.max(1_000, Number(windowTtlMs) || 3_600_000)
    const key = `${RATE_LIMIT_PREFIX}${apiKeyId}:${windowName}`

    if (this.cache.hasRedis) {
      const res = await this.cache.evalLua(INCR_WINDOW_LUA, [key], [String(delta), String(ttl)])
      if (res != null && Number.isFinite(Number(res))) {
        const next = Number(res)
        this.cache.setL1(key, next, Math.min(ttl, 30_000))
        return next
      }
    }

    const cur = this.cache.getL1(key)
    const next = (cur.hit ? Number(cur.value) || 0 : 0) + delta
    this.cache.setL1(key, next, ttl)
    return next
  }

  async invalidateApiKey(apiKeyId) {
    if (!apiKeyId || !this.cache) return
    await this.cache.invalidate({ prefixes: [`${RATE_LIMIT_PREFIX}${apiKeyId}:`] })
  }

  async invalidateAll() {
    if (!this.cache) return
    await this.cache.invalidate({ prefixes: [BALANCE_PREFIX, RATE_LIMIT_PREFIX] })
  }
}
