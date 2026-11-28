import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ALL_CACHE_PREFIXES,
  ApiKeyCache,
  BillingCache,
  ConcurrencyCache,
  DashboardCache,
  EntityCache,
  MultiTierCacheClient,
  SchedulerCache,
  createSnapshotCache,
  getCacheRuntime,
  initCacheRuntime,
  closeCacheRuntime,
  invalidateAllCaches,
  notifyDbTablesMutated,
  registerLocalCacheClearer,
} from '../../src/lib/cache/index.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RefusalGuardsRepo } from '../../src/lib/db/repos/refusal-guards-repo.mjs'
import { isRoutineApiKeyUsageUpdate } from '../../src/lib/db/pg/pg-sync-db.mjs'

/**
 * Deterministic in-memory mock Redis supporting pipelines, MULTI/EXEC, TTL/PTTL,
 * hashes, sets, sorted sets, TIME, and Lua scripts used by vm2api caches.
 */
function createMockRedis({ nowMs = () => Date.now() } = {}) {
  const store = new Map() // key -> { type: 'str'|'hash'|'set'|'zset', value, expiresAt: number }
  const ops = []

  function isExpired(entry) {
    return entry && entry.expiresAt > 0 && entry.expiresAt <= nowMs()
  }

  function getEntry(key) {
    const entry = store.get(key)
    if (!entry) return null
    if (isExpired(entry)) {
      store.delete(key)
      return null
    }
    return entry
  }

  const redis = {
    store,
    ops,
    async get(key) {
      ops.push(['get', key])
      const e = getEntry(key)
      return e && e.type === 'str' ? e.value : null
    },
    async mget(...keys) {
      ops.push(['mget', ...keys])
      return keys.map((k) => {
        const e = getEntry(k)
        return e && e.type === 'str' ? e.value : null
      })
    },
    async set(key, value, ...args) {
      ops.push(['set', key, value, ...args])
      let ttlMs = 0
      let nx = false
      for (let i = 0; i < args.length; i += 1) {
        const tok = String(args[i]).toUpperCase()
        if (tok === 'PX') ttlMs = Number(args[++i]) || 0
        else if (tok === 'EX') ttlMs = (Number(args[++i]) || 0) * 1000
        else if (tok === 'NX') nx = true
      }
      if (nx && getEntry(key)) return null
      store.set(key, { type: 'str', value: String(value), expiresAt: ttlMs > 0 ? nowMs() + ttlMs : 0 })
      return 'OK'
    },
    async pttl(key) {
      ops.push(['pttl', key])
      const e = getEntry(key)
      if (!e) return -2
      if (e.expiresAt <= 0) return -1
      return Math.max(1, e.expiresAt - nowMs())
    },
    async pexpire(key, ms) {
      ops.push(['pexpire', key, ms])
      const e = getEntry(key)
      if (!e) return 0
      e.expiresAt = nowMs() + Number(ms)
      return 1
    },
    async expire(key, sec) {
      return this.pexpire(key, Number(sec) * 1000)
    },
    async del(...keys) {
      ops.push(['del', ...keys])
      let removed = 0
      for (const k of keys) {
        if (store.delete(k)) removed += 1
      }
      return removed
    },
    async incr(key) {
      ops.push(['incr', key])
      const e = getEntry(key)
      const next = (e && e.type === 'str' ? Number(e.value) || 0 : 0) + 1
      store.set(key, { type: 'str', value: String(next), expiresAt: e?.expiresAt || 0 })
      return next
    },
    async decr(key) {
      ops.push(['decr', key])
      const e = getEntry(key)
      const next = (e && e.type === 'str' ? Number(e.value) || 0 : 0) - 1
      store.set(key, { type: 'str', value: String(next), expiresAt: e?.expiresAt || 0 })
      return next
    },
    async publish(ch, msg) {
      ops.push(['publish', ch, msg])
      return 1
    },
    async time() {
      const ms = nowMs()
      return [String(Math.floor(ms / 1000)), String((ms % 1000) * 1000)]
    },
    async zadd(key, score, member) {
      ops.push(['zadd', key, score, member])
      let e = getEntry(key)
      if (!e || e.type !== 'zset') {
        e = { type: 'zset', value: new Map(), expiresAt: 0 }
        store.set(key, e)
      }
      e.value.set(String(member), Number(score))
      return 1
    },
    async zrem(key, ...members) {
      ops.push(['zrem', key, ...members])
      const e = getEntry(key)
      if (!e || e.type !== 'zset') return 0
      let n = 0
      for (const m of members) if (e.value.delete(String(m))) n += 1
      return n
    },
    async zcard(key) {
      const e = getEntry(key)
      return e && e.type === 'zset' ? e.value.size : 0
    },
    async zremrangebyscore(key, min, max) {
      const e = getEntry(key)
      if (!e || e.type !== 'zset') return 0
      const lo = min === '-inf' ? -Infinity : Number(min)
      const hi = max === '+inf' ? Infinity : Number(max)
      let n = 0
      for (const [m, s] of e.value) {
        if (s >= lo && s <= hi) {
          e.value.delete(m)
          n += 1
        }
      }
      return n
    },
    async spop(key, count = 1) {
      ops.push(['spop', key, count])
      const e = getEntry(key)
      if (!e || e.type !== 'set') return []
      const out = []
      for (const member of e.value) {
        if (out.length >= count) break
        out.push(member)
      }
      for (const m of out) e.value.delete(m)
      return out
    },
    async hgetall(key) {
      const e = getEntry(key)
      if (!e || e.type !== 'hash') return {}
      return Object.fromEntries(e.value.entries())
    },
    async eval(script, numKeys, ...rest) {
      ops.push(['eval', numKeys, ...rest.slice(0, numKeys)])
      const keys = rest.slice(0, numKeys)
      const args = rest.slice(numKeys)

      // Leader lock release
      if (script.includes("redis.call('GET', KEYS[1]) == ARGV[1]") && script.includes("redis.call('DEL'")) {
        const cur = await this.get(keys[0])
        if (cur === String(args[0])) {
          await this.del(keys[0])
          return 1
        }
        return 0
      }
      // Leader lock renew
      if (script.includes("redis.call('PEXPIRE', KEYS[1]")) {
        const cur = await this.get(keys[0])
        if (cur === String(args[0])) {
          await this.pexpire(keys[0], Number(args[1]))
          return 1
        }
        return 0
      }
      // Billing accumulate dirty usage
      if (script.includes('HINCRBYFLOAT') && script.includes('SADD')) {
        const [hashKey, dirtyKey] = keys
        let h = getEntry(hashKey)
        if (!h || h.type !== 'hash') {
          h = { type: 'hash', value: new Map(), expiresAt: 0 }
          store.set(hashKey, h)
        }
        const fields = [
          'requests',
          'quota_requests_used',
          'tokens_in',
          'tokens_out',
          'cache_read_tokens',
          'cache_creation_tokens',
          'cost',
        ]
        for (let i = 0; i < fields.length; i += 1) {
          const delta = Number(args[i]) || 0
          if (delta !== 0) {
            const cur = Number(h.value.get(fields[i]) || 0)
            h.value.set(fields[i], String(cur + delta))
          }
        }
        const lastUsedAt = String(args[7] || '')
        if (lastUsedAt) {
          const prev = h.value.get('last_used_at') || ''
          if (!prev || lastUsedAt > prev) h.value.set('last_used_at', lastUsedAt)
        }
        const ttlSec = Number(args[9]) || 86400
        h.expiresAt = nowMs() + ttlSec * 1000
        let s = getEntry(dirtyKey)
        if (!s || s.type !== 'set') {
          s = { type: 'set', value: new Set(), expiresAt: 0 }
          store.set(dirtyKey, s)
        }
        s.value.add(String(args[8]))
        s.expiresAt = nowMs() + ttlSec * 1000
        return 1
      }
      // Billing drain hash
      if (script.includes("redis.call('HGETALL', KEYS[1])")) {
        const e = getEntry(keys[0])
        if (!e || e.type !== 'hash') return []
        const flat = []
        for (const [k, v] of e.value.entries()) flat.push(k, v)
        store.delete(keys[0])
        return flat
      }
      // Billing deduct balance
      if (script.includes('tonumber(cur) - tonumber(ARGV[1])')) {
        const e = getEntry(keys[0])
        if (!e || e.type !== 'str') return null
        const next = Number(e.value) - Number(args[0])
        e.value = String(next)
        return String(next)
      }
      // Concurrency acquire/release/count
      if (script.includes('local maxSlots = tonumber(ARGV[2])')) {
        const nowSec = Math.floor(nowMs() / 1000)
        await this.zremrangebyscore(keys[0], '-inf', nowSec - Number(args[0]))
        const card = await this.zcard(keys[0])
        if (card < Number(args[1])) {
          await this.zadd(keys[0], nowSec, args[2])
          return 1
        }
        return 0
      }
      return null
    },
    pipeline() {
      const queue = []
      const pipe = {
        get: (k) => {
          queue.push(() => redis.get(k))
          return pipe
        },
        pttl: (k) => {
          queue.push(() => redis.pttl(k))
          return pipe
        },
        set: (k, v, ...a) => {
          queue.push(() => redis.set(k, v, ...a))
          return pipe
        },
        del: (...k) => {
          queue.push(() => redis.del(...k))
          return pipe
        },
        incr: (k) => {
          queue.push(() => redis.incr(k))
          return pipe
        },
        expire: (k, s) => {
          queue.push(() => redis.expire(k, s))
          return pipe
        },
        zremrangebyscore: (k, min, max) => {
          queue.push(() => redis.zremrangebyscore(k, min, max))
          return pipe
        },
        zcard: (k) => {
          queue.push(() => redis.zcard(k))
          return pipe
        },
        hgetall: (k) => {
          queue.push(() => redis.hgetall(k))
          return pipe
        },
        eval: (script, numKeys, ...rest) => {
          queue.push(() => redis.eval(script, numKeys, ...rest))
          return pipe
        },
        async exec() {
          const res = []
          for (const fn of queue) {
            try {
              res.push([null, await fn()])
            } catch (err) {
              res.push([err, null])
            }
          }
          return res
        },
      }
      return pipe
    },
    multi() {
      return this.pipeline()
    },
    async quit() {},
    disconnect() {},
  }
  return redis
}

function attachMockRedis(client, mockRedis) {
  client.redis = mockRedis
  client.redisReady = true
  client.redisSubReady = false
  return client
}

test('MultiTierCacheClient provides bounded L1 LRU, singleflight coalescing, and prefix invalidation', async () => {
  const client = new MultiTierCacheClient({
    redisConfig: null,
    cacheConfig: { disabled: false, l1MaxItems: 64, defaultTtlMs: 30_000 },
  })
  let loadCalls = 0
  const loader = async () => {
    loadCalls += 1
    await new Promise((r) => setTimeout(r, 15))
    return { answer: 42 }
  }

  // 5 concurrent misses coalesce into 1 loader call
  const results = await Promise.all(Array.from({ length: 5 }, () => client.getOrLoad('sf:key', loader)))
  assert.equal(loadCalls, 1)
  assert.equal(
    results.every((r) => r.answer === 42),
    true,
  )
  assert.equal(client.stats().singleflight_coalesced, 4)

  // Subsequent hit serves from L1 without calling loader
  const hit = await client.getOrLoad('sf:key', loader)
  assert.equal(hit.answer, 42)
  assert.equal(loadCalls, 1)

  // Prefix invalidation evicts entry
  await client.invalidate({ prefixes: ['sf:'] })
  const after = await client.get('sf:key')
  assert.equal(after.hit, false)
  await client.close()
})

test('MultiTierCacheClient Bug #1 fix: O(1) namespace epoch invalidates Redis L2 across instances without KEYS/SCAN', async () => {
  const sharedRedis = createMockRedis()
  const clientA = attachMockRedis(new MultiTierCacheClient({ redisConfig: null }), sharedRedis)
  const clientB = attachMockRedis(new MultiTierCacheClient({ redisConfig: null }), sharedRedis)

  await clientA.set('dash:overview:k1', { v: 1 }, { ttlMs: 30_000 })
  await clientA.set('dash:stats:k2', { v: 2 }, { ttlMs: 30_000 })

  // Client B reads both from Redis L2
  assert.deepEqual((await clientB.get('dash:overview:k1')).value, { v: 1 })
  assert.deepEqual((await clientB.get('dash:stats:k2')).value, { v: 2 })

  // Client A invalidates ONLY `dash:overview:`
  await clientA.invalidate({ prefixes: ['dash:overview:'] })
  clientB.l1.clear() // Simulate cold/separate instance without Pub/Sub

  // L2 read of `dash:overview:k1` MUST miss immediately (epoch bumped), while `dash:stats:k2` still hits!
  assert.equal((await clientB.get('dash:overview:k1')).hit, false)
  const stillHit = await clientB.get('dash:stats:k2')
  assert.equal(stillHit.hit, true)
  assert.deepEqual(stillHit.value, { v: 2 })

  // Parent prefix `dash:` invalidates `dash:stats:k2` in L2 too
  await clientA.invalidate({ prefixes: ['dash:'] })
  clientB.l1.clear()
  assert.equal((await clientB.get('dash:stats:k2')).hit, false)

  // Subsequent writes under new epoch work normally across instances
  await clientA.set('dash:stats:k2', { v: 3 }, { ttlMs: 30_000 })
  const fresh = await clientB.get('dash:stats:k2')
  assert.equal(fresh.hit, true)
  assert.deepEqual(fresh.value, { v: 3 })

  await clientA.close()
  await clientB.close()
})

test('MultiTierCacheClient Bug #2 fix: L2 backfill uses remaining PTTL and self-heals corrupted JSON', async () => {
  let fakeNow = 1_700_000_000_000
  const sharedRedis = createMockRedis({ nowMs: () => fakeNow })
  const client = attachMockRedis(
    new MultiTierCacheClient({
      redisConfig: null,
      cacheConfig: { disabled: false, l1MaxItems: 64, defaultTtlMs: 60_000 },
    }),
    sharedRedis,
  )

  // Seed Redis key with 2500ms remaining TTL (much shorter than default 30_000ms L1 cap)
  await sharedRedis.set('vm2api:item:ttl', JSON.stringify({ ok: true }), 'PX', 2_500)

  const hit = await client.get('item:ttl')
  assert.equal(hit.hit, true)
  assert.equal(hit.tier, 'l2')
  assert.ok(hit.pttlMs <= 2_500 && hit.pttlMs > 0)

  // Verify L1 entry expires within remaining PTTL (~2500ms), NOT 30_000ms
  const l1Entry = client.l1.map.get('item:ttl')
  assert.ok(l1Entry)
  const l1Ttl = l1Entry.expiresAt - Date.now()
  assert.ok(l1Ttl <= 2_600, `expected L1 backfill TTL <= 2600ms, got ${l1Ttl}ms`)

  // Corrupted JSON in Redis is actively deleted and returns a clean miss
  await sharedRedis.set('vm2api:item:bad', '{not-valid-json', 'PX', 10_000)
  const badRes = await client.get('item:bad')
  assert.equal(badRes.hit, false)
  assert.equal(await sharedRedis.get('vm2api:item:bad'), null)

  // ±10% jitter produces TTL within [0.9 * base, 1.1 * base]
  for (let i = 0; i < 20; i += 1) {
    const t = client._applyJitter(10_000, 0, true)
    assert.ok(t >= 9_000 && t <= 11_000, `jittered TTL out of ±10% range: ${t}`)
  }

  await client.close()
})

test('MultiTierCacheClient getOrSetSWR returns stale immediately and coalesces background refresh', async () => {
  const client = new MultiTierCacheClient({
    redisConfig: null,
    cacheConfig: { disabled: false, l1MaxItems: 64, defaultTtlMs: 30_000 },
  })
  let calls = 0
  const loader = async () => {
    calls += 1
    await new Promise((r) => setTimeout(r, 10))
    return { gen: calls }
  }

  // Cold miss loads synchronously
  const v1 = await client.getOrSetSWR('dash:swr:1', loader, { freshTtlMs: 5_000, ttlMs: 30_000 })
  assert.deepEqual(v1, { gen: 1 })
  assert.equal(calls, 1)

  // Within fresh window -> direct return, 0 reload
  const v2 = await client.getOrSetSWR('dash:swr:1', loader, {
    freshTtlMs: 5_000,
    ttlMs: 30_000,
    now: Date.now() + 2_000,
  })
  assert.deepEqual(v2, { gen: 1 })
  assert.equal(calls, 1)

  // Past freshTtlMs (6s > 5s) but inside hard ttlMs (30s): 5 concurrent callers get stale v1 immediately
  // and trigger ONLY 1 background refresh!
  const staleNow = Date.now() + 6_000
  const staleBatch = await Promise.all(
    Array.from({ length: 5 }, () =>
      client.getOrSetSWR('dash:swr:1', loader, { freshTtlMs: 5_000, ttlMs: 30_000, now: staleNow }),
    ),
  )
  assert.ok(staleBatch.every((r) => r.gen === 1))

  // Wait for background refresh to finish
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(calls, 2)

  // Next read serves freshly refreshed value gen=2
  const v3 = await client.getOrSetSWR('dash:swr:1', loader, { freshTtlMs: 5_000, ttlMs: 30_000 })
  assert.deepEqual(v3, { gen: 2 })
  assert.equal(client.stats().swr_refreshes, 1)

  await client.close()
})

test('createSnapshotCache provides bounded in-process LRU, singleflight, and SHA-256 ETag matching', async () => {
  const snap = createSnapshotCache({ maxEntries: 16, defaultTtlMs: 10_000 })
  const k1 = snap.buildKey('stats', { b: 2, a: 1 })
  const k2 = snap.buildKey('stats', { a: 1, b: 2 })
  assert.equal(k1, k2)

  let loads = 0
  const [r1, r2] = await Promise.all([
    snap.getOrLoad(k1, async () => {
      loads += 1
      await new Promise((r) => setTimeout(r, 10))
      return { total: 100 }
    }),
    snap.getOrLoad(k2, async () => {
      loads += 1
      return { total: 999 }
    }),
  ])
  assert.equal(loads, 1)
  assert.deepEqual(r1.value, { total: 100 })
  assert.equal(r1.etag, r2.etag)
  assert.equal(snap.matchesEtag(r1.etag, r1.etag), true)
  assert.equal(snap.matchesEtag(`W/${r1.etag}`, r1.etag), true)
  assert.equal(snap.matchesEtag('"other"', r1.etag), false)

  const hit = await snap.getOrLoad(k1, async () => ({ total: 555 }))
  assert.equal(hit.hit, true)
  assert.equal(hit.cacheStatus, 'hit')

  snap.invalidatePrefix('stats:')
  assert.equal(snap.get(k1).hit, false)
})

test('ApiKeyCache supports async L1+L2 get, L1-only bounded negative cache, version bump, and disabled-by-default outbox', async () => {
  const sharedRedis = createMockRedis()
  const pgQueries = []
  const fakePgPool = {
    async query(sql, params) {
      pgQueries.push({ sql, params })
      return { rows: [] }
    },
  }
  const client = attachMockRedis(new MultiTierCacheClient({ redisConfig: null }), sharedRedis)
  const cache = new ApiKeyCache(client, { ttlMs: 30_000, pgPool: fakePgPool })

  // Sync positive/negative backward compat
  cache.putSync('hash1', { id: 'key_1', status: 'active' })
  assert.deepEqual(cache.getSync('hash1'), { hit: true, value: { id: 'key_1', status: 'active' } })

  cache.putSync('missing_hash', null)
  assert.deepEqual(cache.getSync('missing_hash'), { hit: true, value: null })
  // Negative cache MUST NOT be written to Redis!
  assert.equal(await sharedRedis.get('vm2api:apikey:auth:missing_hash'), null)

  // Async get() coalesces misses, caches positive in L1+L2, negative ONLY in L1
  let missingLoads = 0
  const missRes = await cache.get('bad_key_hash', async () => {
    missingLoads += 1
    return null
  })
  assert.equal(missRes, null)
  assert.equal(await cache.get('bad_key_hash', async () => ({ id: 'should_not_run' })), null)
  assert.equal(missingLoads, 1)
  assert.equal(await sharedRedis.get('vm2api:apikey:auth:bad_key_hash'), null)

  let posLoads = 0
  const [a1, a2] = await Promise.all([
    cache.get('good_hash', async () => {
      posLoads += 1
      await new Promise((r) => setTimeout(r, 10))
      return { id: 'k_good', status: 'active' }
    }),
    cache.get('good_hash', async () => {
      posLoads += 1
      return { id: 'k_good', status: 'active' }
    }),
  ])
  assert.equal(posLoads, 1)
  assert.equal(a1.id, 'k_good')
  assert.equal(a2.id, 'k_good')

  // Version mismatch invalidates old Redis entry automatically
  const cacheV2 = new ApiKeyCache(client, { ttlMs: 30_000, version: 2 })
  client.l1.clear()
  const reloaded = await cacheV2.get('good_hash', async () => ({ id: 'k_good_v2', status: 'active' }))
  assert.equal(reloaded.id, 'k_good_v2')

  // invalidateHash evicts L1+L2 and does NOT write to auth_cache_invalidation_outbox by default
  await cache.invalidateHash('hash1', 'revoked')
  assert.deepEqual(cache.getSync('hash1'), { hit: false, value: null })
  assert.equal(pgQueries.length, 0)

  // Explicit opt-in enables outbox writes
  const outboxCache = new ApiKeyCache(client, { ttlMs: 30_000, pgPool: fakePgPool, enableOutbox: true })
  await outboxCache.invalidateHash('hash1', 'revoked')
  assert.equal(pgQueries.length, 1)
  assert.match(pgQueries[0].sql, /auth_cache_invalidation_outbox/)

  await client.close()
})

test('BillingCache caches balances, updates deterministically, and supports Dirty-Set Write-Behind (local + Redis)', async () => {
  // 1. Local fallback (no Redis)
  const client = new MultiTierCacheClient({ redisConfig: null })
  const billing = new BillingCache(client, { ttlMs: 60_000, jitterMs: 5_000 })

  let reads = 0
  const bal = await billing.getUserBalance('u1', async () => {
    reads += 1
    return 100
  })
  assert.equal(bal, 100)
  assert.equal(reads, 1)

  const afterDeduct = await billing.deductUserBalance('u1', 12.5)
  assert.equal(afterDeduct, 87.5)

  const cachedBal = await billing.getUserBalance('u1', async () => {
    reads += 1
    return 999
  })
  assert.equal(cachedBal, 87.5)
  assert.equal(reads, 1)

  const win1 = await billing.recordKeyWindowUsage('k1', '5h', 1.25, 3_600_000)
  const win2 = await billing.recordKeyWindowUsage('k1', '5h', 0.75, 3_600_000)
  assert.equal(win1, 1.25)
  assert.equal(win2, 2.0)

  // Dirty-Set write-behind in local fallback mode
  await billing.accumulateKeyUsage('k1', {
    requests: 1,
    tokens_in: 100,
    tokens_out: 50,
    cost: 0.25,
    last_used_at: '2026-11-28T10:00:00.000Z',
  })
  await billing.accumulateKeyUsage('k1', {
    requests: 2,
    tokens_in: 200,
    tokens_out: 80,
    cost: 0.5,
    last_used_at: '2026-11-28T10:01:00.000Z',
  })
  await billing.accumulateKeyUsage('k2', { requests: 1, cost: 0.1 })

  const popped = await billing.popDirtyKeyUsage(10)
  assert.equal(popped.length, 2)
  const k1Entry = popped.find((e) => e.keyId === 'k1')
  assert.equal(k1Entry.requests, 3)
  assert.equal(k1Entry.tokens_in, 300)
  assert.equal(k1Entry.tokens_out, 130)
  assert.ok(Math.abs(k1Entry.cost - 0.75) < 1e-9)
  assert.equal(k1Entry.last_used_at, '2026-11-28T10:01:00.000Z')
  assert.equal((await billing.popDirtyKeyUsage(10)).length, 0)

  // Failure readd merges additively with any new incoming delta
  await billing.accumulateKeyUsage('k1', { requests: 1, cost: 0.1 })
  await billing.readdDirtyKeyUsage([k1Entry])
  const rePopped = await billing.popDirtyKeyUsage(10)
  assert.equal(rePopped.length, 1)
  assert.equal(rePopped[0].requests, 4)
  assert.ok(Math.abs(rePopped[0].cost - 0.85) < 1e-9)
  await client.close()

  // 2. Redis mode Dirty-Set Write-Behind (atomic Lua HINCRBYFLOAT + SADD, SPOP + Pipeline drain)
  const sharedRedis = createMockRedis()
  const rClient = attachMockRedis(new MultiTierCacheClient({ redisConfig: null }), sharedRedis)
  const rBilling = new BillingCache(rClient)
  await rBilling.accumulateKeyUsage('rk1', {
    requests: 1,
    tokens_in: 50,
    cost: 0.15,
    last_used_at: '2026-11-28T12:00:00.000Z',
  })
  await rBilling.accumulateKeyUsage('rk1', {
    requests: 1,
    tokens_in: 70,
    cost: 0.35,
    last_used_at: '2026-11-28T12:05:00.000Z',
  })
  const rPopped = await rBilling.popDirtyKeyUsage(10)
  assert.equal(rPopped.length, 1)
  assert.equal(rPopped[0].requests, 2)
  assert.equal(rPopped[0].tokens_in, 120)
  assert.ok(Math.abs(rPopped[0].cost - 0.5) < 1e-9)
  assert.equal(rPopped[0].last_used_at, '2026-11-28T12:05:00.000Z')

  await rBilling.readdDirtyKeyUsage(rPopped)
  const rRePopped = await rBilling.popDirtyKeyUsage(10)
  assert.equal(rRePopped.length, 1)
  assert.equal(rRePopped[0].requests, 2)
  await rClient.close()
})

test('ConcurrencyCache enforces slot limits, batch counts, RPM buckets, and Sticky Sessions (local + Redis)', async () => {
  // Local fallback
  const client = new MultiTierCacheClient({ redisConfig: null })
  const conc = new ConcurrencyCache(client, { slotTtlSec: 30 })

  assert.equal(await conc.acquire('acct:1', 'req-a', 2), true)
  assert.equal(await conc.acquire('acct:1', 'req-b', 2), true)
  assert.equal(await conc.acquire('acct:1', 'req-c', 2), false)
  assert.equal(await conc.count('acct:1'), 2)

  await conc.release('acct:1', 'req-a')
  assert.equal(await conc.count('acct:1'), 1)
  assert.equal(await conc.acquire('acct:1', 'req-c', 2), true)

  // User-level concurrency + batch query
  assert.equal(await conc.acquireUser('u1', 'req-1', 2), true)
  assert.equal(await conc.acquireUser('u1', 'req-2', 2), true)
  assert.equal(await conc.acquireUser('u1', 'req-3', 2), false)
  const batch = await conc.getBatchConcurrency('user', ['u1', 'u2'])
  assert.equal(batch.get('u1'), 2)
  assert.equal(batch.get('u2'), 0)

  // Minute-bucket RPM enforcement
  const rpm1 = await conc.checkAndIncrRpm('key', 'k1', 2, 60)
  const rpm2 = await conc.checkAndIncrRpm('key', 'k1', 2, 60)
  const rpm3 = await conc.checkAndIncrRpm('key', 'k1', 2, 60)
  assert.equal(rpm1.allowed, true)
  assert.equal(rpm2.allowed, true)
  assert.equal(rpm3.allowed, false)
  assert.equal(await conc.getRpmCount('key', 'k1', 60), 2)

  // Sticky session helpers
  await conc.setSticky('g1:sessA', { accountId: 'acc1', vmId: 'vm1' }, { ttlMs: 30_000 })
  assert.deepEqual(await conc.getSticky('g1:sessA'), { accountId: 'acc1', vmId: 'vm1' })
  await conc.delSticky('g1:sessA')
  assert.equal(await conc.getSticky('g1:sessA'), null)
  await client.close()

  // Redis mode: Pipeline batch concurrency + MULTI/EXEC RPM + Sticky renewal
  const sharedRedis = createMockRedis()
  const rClient = attachMockRedis(new MultiTierCacheClient({ redisConfig: null }), sharedRedis)
  const rConc = new ConcurrencyCache(rClient, { slotTtlSec: 30 })

  await rConc.acquire('account:a1', 'r1', 3)
  await rConc.acquire('account:a1', 'r2', 3)
  await rConc.acquire('account:a2', 'r3', 3)
  const rBatch = await rConc.getBatchConcurrency('account', ['a1', 'a2', 'a3'])
  assert.equal(rBatch.get('a1'), 2)
  assert.equal(rBatch.get('a2'), 1)
  assert.equal(rBatch.get('a3'), 0)

  const rr1 = await rConc.checkAndIncrRpm('key', 'rk1', 2, 60)
  const rr2 = await rConc.checkAndIncrRpm('key', 'rk1', 2, 60)
  const rr3 = await rConc.checkAndIncrRpm('key', 'rk1', 2, 60)
  assert.equal(rr1.allowed, true)
  assert.equal(rr2.allowed, true)
  assert.equal(rr3.allowed, false)
  assert.equal(await rConc.getRpmCount('key', 'rk1', 60), 2)

  await rConc.setSticky('g1:sessB', 'acc_sticky_1', { ttlMs: 5_000 })
  assert.equal(await rConc.getSticky('g1:sessB', { renewTtlMs: 60_000 }), 'acc_sticky_1')
  const renewedTtl = await sharedRedis.pttl('vm2api:sticky:g1:sessB')
  assert.ok(renewedTtl > 10_000, `expected sticky TTL renewed to ~60s, got ${renewedTtl}ms`)
  await rConc.delSticky('g1:sessB')
  assert.equal(await rConc.getSticky('g1:sessB'), null)
  await rClient.close()
})

test('SchedulerCache disables outbox by default and DashboardCache supports SWR, namespaces, snapshotCache, and Leader Lock', async () => {
  const pgQueries = []
  const fakePgPool = {
    async query(sql, params) {
      pgQueries.push({ sql, params })
      return { rows: [] }
    },
  }
  const sharedRedis = createMockRedis()
  const client = attachMockRedis(new MultiTierCacheClient({ redisConfig: null }), sharedRedis)
  const sched = new SchedulerCache(client, { ttlMs: 30_000, pgPool: fakePgPool })
  const dash = new DashboardCache(client, { ttlMs: 30_000 })

  let builds = 0
  const v1 = sched.getOrBuildSync('pool', () => ({ n: ++builds }))
  const v2 = sched.getOrBuildSync('pool', () => ({ n: ++builds }))
  assert.equal(v1.n, 1)
  assert.equal(v2.n, 1)

  sched.bumpRevision({ eventType: 'accounts_updated' })
  const v3 = sched.getOrBuildSync('pool', () => ({ n: ++builds }))
  assert.equal(v3.n, 2)
  // Default outbox disabled -> zero PG writes!
  assert.equal(pgQueries.length, 0)

  // Dashboard getOrLoad + bypass + SWR + namespace invalidation
  let dashCalls = 0
  const d1 = await dash.getOrLoad('stats', { range: 'today' }, async () => ({ calls: ++dashCalls }))
  const d2 = await dash.getOrLoad('stats', { range: 'today' }, async () => ({ calls: ++dashCalls }))
  const d3 = await dash.getOrLoad('stats', { range: 'today' }, async () => ({ calls: ++dashCalls }), { bypass: true })
  assert.equal(d1.calls, 1)
  assert.equal(d2.calls, 1)
  assert.equal(d3.calls, 2)

  let panelCalls = 0
  let overviewCalls = 0
  await dash.getOrSetSWR('panel', { view: 'vms' }, async () => ({ c: ++panelCalls }), {
    freshTtlMs: 5_000,
    ttlMs: 20_000,
  })
  await dash.getOrSetSWR('overview', { tz: 'UTC' }, async () => ({ c: ++overviewCalls }), {
    freshTtlMs: 5_000,
    ttlMs: 20_000,
  })
  await dash.invalidateNamespace('panel')
  client.l1.clear()
  // panel invalidated across L1 & L2, overview untouched!
  const pReload = await dash.getOrSetSWR('panel', { view: 'vms' }, async () => ({ c: ++panelCalls }))
  const oStillCached = await dash.getOrSetSWR('overview', { tz: 'UTC' }, async () => ({ c: ++overviewCalls }))
  assert.equal(pReload.c, 2)
  assert.equal(oStillCached.c, 1)

  // Distributed leader lock (Redis SET NX PX + owner check release)
  const lock1 = await dash.acquireLeaderLock('dashboard-agg', 10_000)
  assert.equal(lock1.acquired, true)
  assert.ok(lock1.token)
  const lock2 = await dash.acquireLeaderLock('dashboard-agg', 10_000)
  assert.equal(lock2.acquired, false)
  // Wrong token cannot release
  assert.equal(await dash.releaseLeaderLock('dashboard-agg', 'wrong-token'), false)
  // Right token releases cleanly
  assert.equal(await dash.releaseLeaderLock('dashboard-agg', lock1.token), true)
  const lock3 = await dash.acquireLeaderLock('dashboard-agg', 10_000)
  assert.equal(lock3.acquired, true)
  await dash.releaseLeaderLock('dashboard-agg', lock3)

  await client.close()

  // Single-node leader lock without Redis acquires immediately
  const localClient = new MultiTierCacheClient({ redisConfig: null })
  const localDash = new DashboardCache(localClient)
  const localLock = await localDash.acquireLeaderLock('agg-local', 10_000)
  assert.equal(localLock.acquired, true)
  assert.equal(await localDash.releaseLeaderLock('agg-local', localLock.token), true)
  await localClient.close()
})

test('EntityCache caches panelUser, groupRateMultiplier, setting, poolAccess, vmOwner, and batched entityNames', async () => {
  const sharedRedis = createMockRedis()
  const client = attachMockRedis(new MultiTierCacheClient({ redisConfig: null }), sharedRedis)
  const entity = new EntityCache(client)

  // panelUser by username (case-insensitive) & id
  let userLoads = 0
  const u1 = await entity.getPanelUserByUsername('Alice', async () => {
    userLoads += 1
    return { id: 'u_1', username: 'Alice', status: 'active' }
  })
  const u2 = await entity.getPanelUserByUsername('alice', async () => {
    userLoads += 1
    return null
  })
  assert.equal(userLoads, 1)
  assert.equal(u1.id, 'u_1')
  assert.equal(u2.id, 'u_1')

  // groupRateMultiplier (including 0 for free groups across L1 + Redis L2, and safe default 1 for null/negative)
  assert.equal(await entity.getGroupRateMultiplier(1, async () => 1.5), 1.5)
  assert.equal(await entity.getGroupRateMultiplier('free_g', async () => 0), 0)
  // Simulate cold instance / L1 clear reading `0` back from Redis L2
  client.l1.clear()
  let zeroReloads = 0
  assert.equal(
    await entity.getGroupRateMultiplier('free_g', async () => {
      zeroReloads += 1
      return 9
    }),
    0,
  )
  assert.equal(zeroReloads, 0, 'rate_multiplier = 0 must hit Redis L2 without coercing to 1')
  assert.equal(
    entity.getGroupRateMultiplierSync('free_sync', () => 0),
    0,
  )
  assert.equal(
    entity.getGroupRateMultiplierSync('free_sync', () => 5),
    0,
  )
  assert.equal(await entity.getGroupRateMultiplier('null_g', async () => null), 1)
  assert.equal(await entity.getGroupRateMultiplier('neg_g', async () => -2), 1)
  assert.equal(
    await entity.getSetting('refusal_policy', async () => ({ strict: true })),
    await entity.getSetting('refusal_policy'),
  )
  assert.deepEqual(await entity.getPoolAccess('k1', async () => ({ pools: ['p1'] })), { pools: ['p1'] })
  assert.equal(await entity.getVmOwner('vm_1', async () => null), null) // caches null cleanly

  // Batched entityNames: L1 hit + L2 MGET hit + minimal DB backfill for missing only
  const fetchedBatches = []
  const names1 = await entity.getEntityNames('users', ['u1', 'u2'], async (missing) => {
    fetchedBatches.push(missing)
    return new Map(missing.map((id) => [id, `name_${id}`]))
  })
  assert.deepEqual(fetchedBatches, [['u1', 'u2']])
  assert.equal(names1.get('u1'), 'name_u1')
  assert.equal(names1.get('u2'), 'name_u2')

  // Clear L1 -> u2 comes from Redis L2 MGET, ONLY u3 hits batchLoader!
  client.l1.clear()
  const names2 = await entity.getEntityNames('users', ['u2', 'u3'], async (missing) => {
    fetchedBatches.push(missing)
    return { u3: 'name_u3' }
  })
  assert.deepEqual(fetchedBatches[1], ['u3'])
  assert.equal(names2.get('u2'), 'name_u2')
  assert.equal(names2.get('u3'), 'name_u3')

  // Targeted table invalidation evicts both L1 & L2
  await entity.invalidateNames('users')
  client.l1.clear()
  const names3 = await entity.getEntityNames('users', ['u2'], async (missing) => ({ u2: 'renamed_u2' }))
  assert.equal(names3.get('u2'), 'renamed_u2')

  await client.close()
})

test('isRoutineApiKeyUsageUpdate and onDbTablesMutated prevent L1 invalidation storms while mapping panel/entity tables', async () => {
  // Exact SQL from ApiKeysRepo._recordUsage
  const recordUsageSql = `
    UPDATE api_keys SET
      requests = requests + 1,
      quota_requests_used = quota_requests_used + 1,
      tokens_in = tokens_in + ?,
      tokens_out = tokens_out + ?,
      cache_read_tokens = COALESCE(cache_read_tokens, 0) + ?,
      cache_creation_tokens = COALESCE(cache_creation_tokens, 0) + ?,
      quota_used = quota_used + ?,
      usage_5h = ?, window_5h_start = ?,
      usage_1d = ?, window_1d_start = ?,
      usage_7d = ?, window_7d_start = ?,
      last_used_at = ?,
      updated_at = ?
    WHERE id = ?
  `
  assert.equal(isRoutineApiKeyUsageUpdate(recordUsageSql), true)
  assert.equal(isRoutineApiKeyUsageUpdate('UPDATE api_keys SET last_used_at = ? WHERE id = ?'), true)
  assert.equal(
    isRoutineApiKeyUsageUpdate(
      'UPDATE api_keys AS k SET requests = k.requests + v.r, quota_used = k.quota_used + v.c FROM (VALUES ($1, $2, $3)) AS v(id, r, c) WHERE k.id = v.id',
    ),
    true,
  )

  // Structural mutations MUST NOT be classified as routine usage updates
  assert.equal(
    isRoutineApiKeyUsageUpdate("UPDATE api_keys SET status = 'quota_exhausted', updated_at = ? WHERE id = ?"),
    false,
  )
  assert.equal(isRoutineApiKeyUsageUpdate('UPDATE api_keys SET name = ?, quota = ? WHERE id = ?'), false)
  assert.equal(isRoutineApiKeyUsageUpdate('INSERT INTO api_keys (id, name) VALUES (?, ?)'), false)
  assert.equal(isRoutineApiKeyUsageUpdate('DELETE FROM api_keys WHERE id = ?'), false)

  // Verify runtime routing: `api_keys:usage` keeps ApiKeyCache L1 warm, while `vms`/`settings`/`users` invalidate panel & entity caches
  await closeCacheRuntime()
  const rt = await initCacheRuntime({ redisConfig: null })
  try {
    rt.apiKeys.putSync('k_hot_hash', { id: 'k_hot', status: 'active' })
    rt.onDbTablesMutated(['api_keys:usage'])
    assert.equal(rt.apiKeys.getSync('k_hot_hash').hit, true, 'routine usage update must NOT nuke ApiKeyCache L1')

    // Structural api_keys mutation DOES invalidate ApiKeyCache
    rt.onDbTablesMutated(['api_keys'])
    assert.equal(rt.apiKeys.getSync('k_hot_hash').hit, false)

    // SQLite / explicit table mutation entry invalidates panel + entity namespaces
    let vmPanelCalls = 0
    await rt.dashboard.getOrSetSWR('panel', { page: 'vms' }, async () => ({ v: ++vmPanelCalls }))
    await rt.entity.getVmOwner('vm1', async () => 'owner1')
    notifyDbTablesMutated(['vms'])
    assert.equal((await rt.dashboard.getOrSetSWR('panel', { page: 'vms' }, async () => ({ v: ++vmPanelCalls }))).v, 2)
    assert.equal(await rt.entity.getVmOwner('vm1', async () => 'owner2'), 'owner2')

    // Settings mutation invalidates entity.setting and panel
    await rt.entity.getSetting('policy', async () => ({ a: 1 }))
    notifyDbTablesMutated('settings')
    assert.deepEqual(await rt.entity.getSetting('policy', async () => ({ a: 2 })), { a: 2 })

    // Risk ban tables invalidate risk:bans:session: and risk:bans:device: caches
    await rt.client.set('risk:bans:session:s1', { blocked: true }, { ttlMs: 15_000 })
    await rt.client.set('risk:bans:device:d1', { blocked: true }, { ttlMs: 15_000 })
    notifyDbTablesMutated(['refusal_session_blocks'])
    assert.equal((await rt.client.get('risk:bans:session:s1')).hit, false)
    assert.equal((await rt.client.get('risk:bans:device:d1')).hit, true)
    notifyDbTablesMutated(['refusal_device_blocks'])
    assert.equal((await rt.client.get('risk:bans:device:d1')).hit, false)
  } finally {
    await closeCacheRuntime()
  }
})

test('invalidateAllCaches clears all domain prefixes, L2 epochs, dashboard.snapshotCache, liveLogs, and RefusalGuardsRepo snapshots', async () => {
  await closeCacheRuntime()
  const sharedRedis = createMockRedis()
  const rt = await initCacheRuntime({ redisConfig: null })
  attachMockRedis(rt.client, sharedRedis)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-inv-all-'))
  const db = createDatabase({ dataDir: tmpDir })
  let customClearCalls = 0
  const unregister = registerLocalCacheClearer(() => {
    customClearCalls += 1
  })

  try {
    // Seed every single domain prefix in L1 + mock Redis L2
    const samples = [
      ['apikey:auth:h1', { id: 'k1' }],
      ['billing:bal:u1', 42],
      ['sched:snap:pool1', { rev: 1 }],
      ['dash:panel:vms', { count: 3 }],
      ['entity:user:id:usr_dirty_only', { v: { id: 'usr_dirty_only', username: 'DirtyGhost' } }],
      ['risk:bans:session:s1', { blocked: true }],
      ['live:req:r1', { request_id: 'r1' }],
    ]
    for (const [k, v] of samples) {
      await rt.client.set(k, v, { ttlMs: 60_000 })
    }
    rt.apiKeys.putSync('missing_hash', null)
    rt.scheduler.getOrBuildSync('sched-local', () => ({ ok: true }))
    rt.dashboard.snapshotCache.set('panel:snap:1', { rows: [1, 2] }, 60_000)
    await rt.liveLogs.startRequest('req-live-clear', { started_at: Date.now(), session_id: 'sess-clear' })

    // Seed RefusalGuardsRepo in-process snapshot and then mutate DB directly underneath it
    const guards = new RefusalGuardsRepo(db)
    guards.remember({ fingerprint: 'fp_dirty_guard', model: 'claude-sonnet-4-6', preview: 'blocked' })
    assert.ok(guards.get('fp_dirty_guard'), 'guard snapshot must be warm before restore')
    db.prepare('DELETE FROM refusal_guards WHERE fingerprint = ?').run('fp_dirty_guard')
    assert.ok(guards.get('fp_dirty_guard'), 'without invalidation, stale in-process snapshot still returns old row')

    assert.equal(rt.dashboard.snapshotCache.get('panel:snap:1').hit, true)
    assert.equal(rt.liveLogs._localInflight.size, 1)
    assert.equal(rt.apiKeys.getSync('missing_hash').hit, true)
    assert.equal(rt.scheduler.snapshots.size, 1)

    await invalidateAllCaches()

    // Every single prefix must be evicted from both L1 and L2 (epochs bumped)
    for (const prefix of ALL_CACHE_PREFIXES) {
      const epochRaw = await sharedRedis.get(`vm2api:epoch:${prefix}`)
      assert.ok(Number(epochRaw) >= 1, `expected Redis epoch bumped for ${prefix}`)
    }
    for (const [k] of samples) {
      assert.equal(rt.client.getL1(k).hit, false, `L1 entry ${k} must be evicted`)
      assert.equal((await rt.client.get(k)).hit, false, `L2 entry ${k} must be invalidated via epoch bump`)
    }
    assert.equal(rt.dashboard.snapshotCache.get('panel:snap:1').hit, false)
    assert.equal(rt.liveLogs._localInflight.size, 0)
    assert.equal(rt.apiKeys.getSync('missing_hash').hit, false)
    assert.equal(rt.scheduler.snapshots.size, 0)
    assert.ok(customClearCalls >= 1, 'registered local cache clearer must run')
    assert.equal(
      guards.get('fp_dirty_guard'),
      null,
      'RefusalGuardsRepo snapshot must reload cleanly after invalidateAllCaches',
    )
  } finally {
    unregister()
    try {
      db.close()
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true })
    await closeCacheRuntime()
  }
})
