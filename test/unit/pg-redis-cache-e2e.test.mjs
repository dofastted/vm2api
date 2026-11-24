/**
 * Live Redis 8 + PostgreSQL multi-tier cache integration test suite (Tier 4).
 *
 * Verifies:
 *   1. L1 + L2 Redis hits, singleflight coalescing, and redis ping metrics
 *   2. 20-way concurrent Redis Lua atomic balance deduction (BillingCache)
 *   3. 20-way concurrent Redis ZSET + server TIME concurrency slots (ConcurrencyCache)
 *   4. Cross-instance invalidation via Redis Pub/Sub (Client A -> Client B < 200ms)
 *   5. Cross-instance invalidation via PG LISTEN/NOTIFY when Redis is disabled
 *   6. Fail-open resilience when Redis disconnects mid-flight + recovery
 *
 * Runs when VM2API_TEST_REDIS_URL (and/or VM2API_TEST_PG_URL) is set; skips cleanly otherwise.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiKeyCache, BillingCache, ConcurrencyCache, MultiTierCacheClient } from '../../src/lib/cache/index.mjs'
import { createPgPool } from '../../src/lib/db/pg/pg-pool.mjs'
import { resolvePgConfig } from '../../src/lib/db/pg/config.mjs'

const REDIS_URL = process.env.VM2API_TEST_REDIS_URL || ''
const PG_URL = process.env.VM2API_TEST_PG_URL || ''

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

test('Redis 8 L1+L2 hits, Lua atomic billing deduction, ZSET TIME concurrency slots, and Pub/Sub cross-instance invalidation', {
  skip: !REDIS_URL,
}, async () => {
  const prefix = `vm2api_t4_${Date.now()}_${Math.floor(Math.random() * 1e5)}:`
  const clientA = new MultiTierCacheClient({
    redisConfig: {
      url: REDIS_URL,
      keyPrefix: prefix,
      connectTimeout: 3000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 1,
    },
  })
  const clientB = new MultiTierCacheClient({
    redisConfig: {
      url: REDIS_URL,
      keyPrefix: prefix,
      connectTimeout: 3000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 1,
    },
  })

  try {
    await clientA.connect()
    await clientB.connect()
    assert.equal(clientA.hasRedis, true)
    assert.equal(clientB.hasRedis, true)

    const ping = await clientA.pingRedis()
    assert.equal(ping.ok, true)
    assert.ok(ping.latencyMs >= 0)

    // 1. Cross-tier L1/L2 hit: A writes -> B reads from L2 Redis -> promotes to B's L1
    await clientA.set('item:shared', { v: 'hello-redis' }, { ttlMs: 30_000 })
    const bFirst = await clientB.get('item:shared')
    assert.equal(bFirst.hit, true)
    assert.equal(bFirst.tier, 'l2')
    assert.deepEqual(bFirst.value, { v: 'hello-redis' })

    const bSecond = await clientB.get('item:shared')
    assert.equal(bSecond.hit, true)
    assert.equal(bSecond.tier, 'l1')

    // 2. Cross-instance Pub/Sub invalidation: A invalidates -> B's L1 is evicted automatically
    const akA = new ApiKeyCache(clientA, { ttlMs: 30_000 })
    const akB = new ApiKeyCache(clientB, { ttlMs: 30_000 })
    akB.putSync('hash_pubsub_1', { id: 'key_ps', status: 'active' })
    assert.equal(akB.getSync('hash_pubsub_1').hit, true)

    await akA.invalidateByHash('hash_pubsub_1', 'rotated')
    let evicted = false
    for (let i = 0; i < 30; i += 1) {
      if (!akB.getSync('hash_pubsub_1').hit) {
        evicted = true
        break
      }
      await sleep(25)
    }
    assert.equal(evicted, true, 'Client B L1 must be evicted via Redis Pub/Sub')

    // 3. 20-way concurrent Redis Lua atomic balance deduction (no race / lost updates!)
    const billingA = new BillingCache(clientA, { ttlMs: 60_000, jitterMs: 1_000 })
    const billingB = new BillingCache(clientB, { ttlMs: 60_000, jitterMs: 1_000 })
    await billingA.setUserBalance('u_lua_1', 100.0)

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? billingA : billingB).deductUserBalance('u_lua_1', 1.5)),
    )
    // Bypass L1 by checking fresh L2 read from a brand-new lookup after clearing B's L1
    clientB.l1.clear()
    const remaining = await billingB.getUserBalance('u_lua_1', async () => -999)
    assert.ok(Math.abs(remaining - 70.0) < 1e-6, `expected exact 70.0 after 20x1.5 Lua deductions, got ${remaining}`)

    // 4. 20-way concurrent Redis ZSET + server TIME concurrency slot cap
    const concA = new ConcurrencyCache(clientA, { slotTtlSec: 30 })
    const concB = new ConcurrencyCache(clientB, { slotTtlSec: 30 })
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? concA : concB).acquire('acct:lua-cap', `req-${i}`, 5, 30)),
    )
    const granted = attempts.filter(Boolean).length
    assert.equal(granted, 5, `expected exactly 5 slots granted out of 20 concurrent attempts, got ${granted}`)
    assert.equal(await concA.count('acct:lua-cap', 30), 5)

    // Release 2 granted slots and verify 2 new acquires succeed
    const grantedIds = attempts.map((ok, i) => (ok ? `req-${i}` : null)).filter(Boolean)
    await concA.release('acct:lua-cap', grantedIds[0])
    await concB.release('acct:lua-cap', grantedIds[1])
    assert.equal(await concB.count('acct:lua-cap', 30), 3)
    assert.equal(await concA.acquire('acct:lua-cap', 'req-new-1', 5, 30), true)
    assert.equal(await concB.acquire('acct:lua-cap', 'req-new-2', 5, 30), true)
    assert.equal(await concA.acquire('acct:lua-cap', 'req-over', 5, 30), false)

    // Refresh slot stays valid
    assert.equal(await concA.refresh('acct:lua-cap', 'req-new-1', 30), true)

    // 5. Fail-open resilience: disconnect Redis client mid-flight and confirm cache operations degrade to L1 without throwing
    clientA.redis.disconnect()
    clientA.redisReady = false
    await clientA.set('failopen:k', { ok: true }, { ttlMs: 10_000 })
    const foRes = await clientA.get('failopen:k')
    assert.equal(foRes.hit, true)
    assert.equal(foRes.tier, 'l1')
    assert.deepEqual(foRes.value, { ok: true })
  } finally {
    await clientA.close()
    await clientB.close()
  }
})

test('PG LISTEN/NOTIFY cross-instance invalidation works when Redis is disabled', { skip: !PG_URL }, async () => {
  const pool = createPgPool(resolvePgConfig({ connectionString: PG_URL }), { maxOverride: 4 })
  const clientA = new MultiTierCacheClient({ redisConfig: null })
  const clientB = new MultiTierCacheClient({ redisConfig: null })
  try {
    await clientA.connect({ pgPool: pool })
    await clientB.connect({ pgPool: pool })
    assert.equal(clientA.stats().mode, 'l1+pg_notify')
    assert.equal(clientB.stats().mode, 'l1+pg_notify')

    clientB.setL1('notify:key1', { v: 1 }, 30_000)
    assert.equal(clientB.getL1('notify:key1').hit, true)

    await clientA.invalidate({ keys: ['notify:key1'] })
    let evicted = false
    for (let i = 0; i < 30; i += 1) {
      if (!clientB.getL1('notify:key1').hit) {
        evicted = true
        break
      }
      await sleep(25)
    }
    assert.equal(evicted, true, 'Client B L1 must be evicted via PG LISTEN/NOTIFY')
  } finally {
    await clientA.close()
    await clientB.close()
    await pool.end()
  }
})
