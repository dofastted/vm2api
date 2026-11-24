import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ApiKeyCache,
  BillingCache,
  ConcurrencyCache,
  DashboardCache,
  MultiTierCacheClient,
  SchedulerCache,
} from '../../src/lib/cache/index.mjs'

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

test('ApiKeyCache supports positive, negative, and invalidation paths', async () => {
  const client = new MultiTierCacheClient({ redisConfig: null })
  const cache = new ApiKeyCache(client, { ttlMs: 30_000 })

  cache.putSync('hash1', { id: 'key_1', status: 'active' })
  assert.deepEqual(cache.getSync('hash1'), { hit: true, value: { id: 'key_1', status: 'active' } })

  cache.putSync('missing_hash', null)
  assert.deepEqual(cache.getSync('missing_hash'), { hit: true, value: null })

  await cache.invalidateByHash('hash1', 'revoked')
  assert.deepEqual(cache.getSync('hash1'), { hit: false, value: null })
  await client.close()
})

test('BillingCache caches balances and updates deterministically on deduction', async () => {
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

  await client.close()
})

test('ConcurrencyCache enforces slot limits and release cleanly in fallback mode', async () => {
  const client = new MultiTierCacheClient({ redisConfig: null })
  const conc = new ConcurrencyCache(client, { slotTtlSec: 30 })

  assert.equal(await conc.acquire('acct:1', 'req-a', 2), true)
  assert.equal(await conc.acquire('acct:1', 'req-b', 2), true)
  assert.equal(await conc.acquire('acct:1', 'req-c', 2), false)
  assert.equal(await conc.count('acct:1'), 2)

  await conc.release('acct:1', 'req-a')
  assert.equal(await conc.count('acct:1'), 1)
  assert.equal(await conc.acquire('acct:1', 'req-c', 2), true)
  await client.close()
})

test('SchedulerCache invalidates on revision bump and DashboardCache supports bypass', async () => {
  const client = new MultiTierCacheClient({ redisConfig: null })
  const sched = new SchedulerCache(client, { ttlMs: 30_000 })
  const dash = new DashboardCache(client, { ttlMs: 30_000 })

  let builds = 0
  const v1 = sched.getOrBuildSync('pool', () => ({ n: ++builds }))
  const v2 = sched.getOrBuildSync('pool', () => ({ n: ++builds }))
  assert.equal(v1.n, 1)
  assert.equal(v2.n, 1)

  sched.bumpRevision({ eventType: 'accounts_updated' })
  const v3 = sched.getOrBuildSync('pool', () => ({ n: ++builds }))
  assert.equal(v3.n, 2)

  let dashCalls = 0
  const d1 = await dash.getOrLoad('stats', { range: 'today' }, async () => ({ calls: ++dashCalls }))
  const d2 = await dash.getOrLoad('stats', { range: 'today' }, async () => ({ calls: ++dashCalls }))
  const d3 = await dash.getOrLoad('stats', { range: 'today' }, async () => ({ calls: ++dashCalls }), { bypass: true })
  assert.equal(d1.calls, 1)
  assert.equal(d2.calls, 1)
  assert.equal(d3.calls, 2)
  await client.close()
})
