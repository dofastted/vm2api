/**
 * Billing, rate-limit window, and API-key usage dirty-set write-behind cache.
 *
 * Modeled on sub2api's `billing_cache.go` and `user_platform_quota_flusher.go`:
 * - Uses jittered TTL (`5m - rand(30s)`) to prevent synchronized cache stampedes.
 * - Atomic balance deduction & window increment via Lua (epoch-versioned keys).
 * - Dirty-Set Write-Behind for API key usage deltas (`accumulateKeyUsage`,
 *   `popDirtyKeyUsage`, `readdDirtyKeyUsage`): atomic Lua `HINCRBYFLOAT` + `SADD dirty`,
 *   `SPOP` + Pipeline atomic drain, with identical in-process Map fallback when Redis is absent.
 */

const DOMAIN_PREFIX = 'billing:'
const BALANCE_PREFIX = 'billing:bal:'
const RATE_LIMIT_PREFIX = 'billing:rl:'
const DIRTY_SET_KEY = 'billing:keyusage:dirty'
const DIRTY_HASH_PREFIX = 'billing:keyusage:delta:'
const DIRTY_TTL_SEC = 86_400
const DEFAULT_TTL_MS = 300_000
const DEFAULT_JITTER_MS = 30_000

const USAGE_NUMERIC_FIELDS = [
  'requests',
  'quota_requests_used',
  'tokens_in',
  'tokens_out',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cost',
]

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

// Atomically accumulate API key usage deltas into a hash and register keyId in the dirty set
const ACCUMULATE_KEY_USAGE_LUA = `
local hashKey = KEYS[1]
local dirtyKey = KEYS[2]
local reqs = tonumber(ARGV[1]) or 0
local quotaReqs = tonumber(ARGV[2]) or 0
local tokIn = tonumber(ARGV[3]) or 0
local tokOut = tonumber(ARGV[4]) or 0
local cacheRead = tonumber(ARGV[5]) or 0
local cacheCreate = tonumber(ARGV[6]) or 0
local cost = tonumber(ARGV[7]) or 0
local lastUsedAt = ARGV[8] or ''
local keyId = ARGV[9]
local ttlSec = tonumber(ARGV[10]) or 86400

if reqs ~= 0 then redis.call('HINCRBYFLOAT', hashKey, 'requests', reqs) end
if quotaReqs ~= 0 then redis.call('HINCRBYFLOAT', hashKey, 'quota_requests_used', quotaReqs) end
if tokIn ~= 0 then redis.call('HINCRBYFLOAT', hashKey, 'tokens_in', tokIn) end
if tokOut ~= 0 then redis.call('HINCRBYFLOAT', hashKey, 'tokens_out', tokOut) end
if cacheRead ~= 0 then redis.call('HINCRBYFLOAT', hashKey, 'cache_read_tokens', cacheRead) end
if cacheCreate ~= 0 then redis.call('HINCRBYFLOAT', hashKey, 'cache_creation_tokens', cacheCreate) end
if cost ~= 0 then redis.call('HINCRBYFLOAT', hashKey, 'cost', cost) end
if lastUsedAt ~= '' then
  local prev = redis.call('HGET', hashKey, 'last_used_at')
  if (not prev) or (lastUsedAt > prev) then
    redis.call('HSET', hashKey, 'last_used_at', lastUsedAt)
  end
end
redis.call('EXPIRE', hashKey, ttlSec)
redis.call('SADD', dirtyKey, keyId)
redis.call('EXPIRE', dirtyKey, ttlSec)
return 1
`

// Atomically snapshot and clear one key's accumulated usage hash (prevents losing concurrent increments)
const DRAIN_KEY_USAGE_HASH_LUA = `
local vals = redis.call('HGETALL', KEYS[1])
redis.call('DEL', KEYS[1])
return vals
`

function normalizeUsageDelta(delta = {}) {
  const requests = Number(delta.requests ?? 0) || 0
  const quotaRequestsUsed = delta.quota_requests_used !== undefined ? Number(delta.quota_requests_used) || 0 : requests
  return {
    requests,
    quota_requests_used: quotaRequestsUsed,
    tokens_in: Number(delta.tokens_in ?? 0) || 0,
    tokens_out: Number(delta.tokens_out ?? 0) || 0,
    cache_read_tokens: Number(delta.cache_read_tokens ?? 0) || 0,
    cache_creation_tokens: Number(delta.cache_creation_tokens ?? 0) || 0,
    cost: Number(delta.cost ?? delta.quota_used ?? 0) || 0,
    last_used_at: delta.last_used_at ? String(delta.last_used_at) : '',
  }
}

function isNonEmptyUsageDelta(d) {
  if (!d) return false
  if (d.last_used_at) return true
  return USAGE_NUMERIC_FIELDS.some((f) => (Number(d[f]) || 0) !== 0)
}

function mergeUsageDeltas(target, addition) {
  for (const f of USAGE_NUMERIC_FIELDS) {
    target[f] = (Number(target[f]) || 0) + (Number(addition[f]) || 0)
  }
  if (addition.last_used_at && (!target.last_used_at || addition.last_used_at > target.last_used_at)) {
    target.last_used_at = addition.last_used_at
  }
  return target
}

function parseRedisHashReply(raw) {
  if (!raw) return null
  const obj = {}
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null
    for (let i = 0; i + 1 < raw.length; i += 2) {
      obj[String(raw[i])] = raw[i + 1]
    }
  } else if (typeof raw === 'object') {
    const keys = Object.keys(raw)
    if (keys.length === 0) return null
    Object.assign(obj, raw)
  } else {
    return null
  }
  return {
    requests: Number(obj.requests) || 0,
    quota_requests_used: Number(obj.quota_requests_used) || 0,
    tokens_in: Number(obj.tokens_in) || 0,
    tokens_out: Number(obj.tokens_out) || 0,
    cache_read_tokens: Number(obj.cache_read_tokens) || 0,
    cache_creation_tokens: Number(obj.cache_creation_tokens) || 0,
    cost: Number(obj.cost) || 0,
    last_used_at: obj.last_used_at ? String(obj.last_used_at) : null,
  }
}

export class BillingCache {
  constructor(cacheClient, { ttlMs = DEFAULT_TTL_MS, jitterMs = DEFAULT_JITTER_MS } = {}) {
    this.cache = cacheClient
    this.ttlMs = Math.max(5_000, Number(ttlMs) || DEFAULT_TTL_MS)
    this.jitterMs = Math.max(0, Number(jitterMs) || DEFAULT_JITTER_MS)
    /** Fallback in-process dirty set when Redis is unavailable: keyId -> normalized delta */
    this._localDirtyUsage = new Map()
  }

  async getUserBalance(userId, loader) {
    if (!userId) return 0
    if (!this.cache?.enabled) return loader()
    return this.cache.getOrLoad(`${BALANCE_PREFIX}${userId}`, loader, {
      ttlMs: this.ttlMs,
      jitterMs: this.jitterMs,
      prefixes: [DOMAIN_PREFIX, BALANCE_PREFIX],
    })
  }

  async setUserBalance(userId, balance) {
    if (!userId || !this.cache?.enabled) return
    await this.cache.set(`${BALANCE_PREFIX}${userId}`, Number(balance) || 0, {
      ttlMs: this.ttlMs,
      jitterMs: this.jitterMs,
      prefixes: [DOMAIN_PREFIX, BALANCE_PREFIX],
    })
  }

  /** Atomically deduct amount from cached balance in L2 Redis + update L1. */
  async deductUserBalance(userId, amount) {
    if (!userId || !this.cache?.enabled) return null
    const delta = Number(amount) || 0
    if (delta === 0) return null
    const key = `${BALANCE_PREFIX}${userId}`

    if (this.cache.hasRedis) {
      const evalFn = this.cache.evalLuaVersioned || this.cache.evalLua
      const luaRes = await evalFn.call(this.cache, DEDUCT_BALANCE_LUA, [key], [String(delta), String(this.ttlMs)], {
        prefixes: [DOMAIN_PREFIX, BALANCE_PREFIX],
      })
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
      const evalFn = this.cache.evalLuaVersioned || this.cache.evalLua
      const res = await evalFn.call(this.cache, INCR_WINDOW_LUA, [key], [String(delta), String(ttl)], {
        prefixes: [DOMAIN_PREFIX, RATE_LIMIT_PREFIX, `${RATE_LIMIT_PREFIX}${apiKeyId}:`],
      })
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

  _accumulateLocalDirty(keyId, delta) {
    const id = String(keyId)
    const existing = this._localDirtyUsage.get(id)
    if (existing) {
      mergeUsageDeltas(existing, delta)
    } else {
      this._localDirtyUsage.set(id, { ...delta })
    }
  }

  /**
   * Accumulate API key usage delta into the Redis dirty set (atomic Lua HINCRBYFLOAT + SADD)
   * or in-process Map when Redis is unavailable.
   */
  async accumulateKeyUsage(keyId, delta = {}) {
    if (!keyId) return false
    const id = String(keyId)
    const norm = normalizeUsageDelta(delta)
    if (!isNonEmptyUsageDelta(norm)) return false

    if (this.cache?.hasRedis) {
      const res = await this.cache.evalLua(
        ACCUMULATE_KEY_USAGE_LUA,
        [`${DIRTY_HASH_PREFIX}${id}`, DIRTY_SET_KEY],
        [
          String(norm.requests),
          String(norm.quota_requests_used),
          String(norm.tokens_in),
          String(norm.tokens_out),
          String(norm.cache_read_tokens),
          String(norm.cache_creation_tokens),
          String(norm.cost),
          norm.last_used_at,
          id,
          String(DIRTY_TTL_SEC),
        ],
      )
      if (res != null) return true
    }

    this._accumulateLocalDirty(id, norm)
    return true
  }

  /**
   * Pop up to `batchSize` dirty API key usage entries for asynchronous DB write-behind flush.
   * Uses `SPOP` + Pipeline atomic `HGETALL`+`DEL` on Redis and merges any local fallback entries.
   */
  async popDirtyKeyUsage(batchSize = 200) {
    const limit = Math.max(1, Math.min(5_000, Number(batchSize) || 200))
    const merged = new Map()

    if (this.cache?.hasRedis) {
      try {
        const dirtyRedisKey = this.cache.redisKey(DIRTY_SET_KEY)
        const popped = await this.cache.redis.spop(dirtyRedisKey, limit)
        const keyIds = Array.isArray(popped) ? popped.filter(Boolean).map(String) : popped ? [String(popped)] : []

        if (keyIds.length > 0) {
          const pipe = this.cache.redis.pipeline()
          const canPipeEval = typeof pipe.eval === 'function'
          for (const keyId of keyIds) {
            const hKey = this.cache.redisKey(`${DIRTY_HASH_PREFIX}${keyId}`)
            if (canPipeEval) {
              pipe.eval(DRAIN_KEY_USAGE_HASH_LUA, 1, hKey)
            } else {
              pipe.hgetall(hKey)
              pipe.del(hKey)
            }
          }
          const results = await pipe.exec()
          if (Array.isArray(results)) {
            for (let i = 0; i < keyIds.length; i += 1) {
              const idx = canPipeEval ? i : i * 2
              const [err, raw] = results[idx] || []
              if (err) continue
              const parsed = parseRedisHashReply(raw)
              if (parsed && isNonEmptyUsageDelta(parsed)) {
                merged.set(keyIds[i], { keyId: keyIds[i], ...parsed })
              }
            }
          }
        }
      } catch {
        this.cache.l2Errors += 1
      }
    }

    // Drain any locally buffered dirty entries (no-Redis mode or transient Redis blip)
    if (this._localDirtyUsage.size > 0 && merged.size < limit) {
      const toRemove = []
      for (const [keyId, delta] of this._localDirtyUsage) {
        if (merged.size >= limit && !merged.has(keyId)) break
        toRemove.push(keyId)
        const existing = merged.get(keyId)
        if (existing) {
          mergeUsageDeltas(existing, delta)
        } else if (isNonEmptyUsageDelta(delta)) {
          merged.set(keyId, {
            keyId,
            ...delta,
            last_used_at: delta.last_used_at || null,
          })
        }
      }
      for (const id of toRemove) this._localDirtyUsage.delete(id)
    }

    return [...merged.values()]
  }

  /**
   * Re-add failed flush entries back into the dirty set (additive merge so newer deltas are never lost).
   */
  async readdDirtyKeyUsage(entries) {
    const list = Array.isArray(entries) ? entries : entries ? [entries] : []
    if (!list.length) return 0
    let count = 0
    for (const entry of list) {
      const keyId = entry?.keyId || entry?.api_key_id || entry?.id
      if (!keyId) continue
      const ok = await this.accumulateKeyUsage(keyId, entry)
      if (ok) count += 1
    }
    return count
  }

  pendingLocalDirtyCount() {
    return this._localDirtyUsage.size
  }
}
