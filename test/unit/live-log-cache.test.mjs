import test from 'node:test'
import assert from 'node:assert/strict'
import { LiveLogCache, MultiTierCacheClient } from '../../src/lib/cache/index.mjs'

/** Minimal in-memory Redis mock supporting LiveLogCache commands + Lua finish script. */
function createLiveMockRedis({ nowMs = () => Date.now(), failWrites = false } = {}) {
  const store = new Map()
  const setCalls = []

  function getEntry(key) {
    const e = store.get(key)
    if (!e) return null
    if (e.expiresAt > 0 && e.expiresAt <= nowMs()) {
      store.delete(key)
      return null
    }
    return e
  }

  const redis = {
    store,
    setCalls,
    failWrites,
    async set(key, value, ...args) {
      if (redis.failWrites) throw new Error('redis write error')
      setCalls.push({ key, value })
      let ttlMs = 0
      for (let i = 0; i < args.length; i += 1) {
        const t = String(args[i]).toUpperCase()
        if (t === 'PX') ttlMs = Number(args[++i]) || 0
        else if (t === 'EX') ttlMs = (Number(args[++i]) || 0) * 1000
      }
      store.set(key, { type: 'str', value: String(value), expiresAt: ttlMs > 0 ? nowMs() + ttlMs : 0 })
      return 'OK'
    },
    async mget(...keys) {
      if (redis.failWrites) throw new Error('redis read error')
      return keys.map((k) => {
        const e = getEntry(k)
        return e && e.type === 'str' ? e.value : null
      })
    },
    async del(...keys) {
      let n = 0
      for (const k of keys) if (store.delete(k)) n += 1
      return n
    },
    async incr(key) {
      const e = getEntry(key)
      const next = (e && e.type === 'str' ? Number(e.value) || 0 : 0) + 1
      store.set(key, { type: 'str', value: String(next), expiresAt: e?.expiresAt || 0 })
      return next
    },
    async decr(key) {
      const e = getEntry(key)
      const next = (e && e.type === 'str' ? Number(e.value) || 0 : 0) - 1
      store.set(key, { type: 'str', value: String(next), expiresAt: e?.expiresAt || 0 })
      return next
    },
    async pexpire(key, ms) {
      const e = getEntry(key)
      if (!e) return 0
      e.expiresAt = nowMs() + Number(ms)
      return 1
    },
    async expire(key, sec) {
      return this.pexpire(key, Number(sec) * 1000)
    },
    async zadd(key, score, member) {
      let e = getEntry(key)
      if (!e || e.type !== 'zset') {
        e = { type: 'zset', value: new Map(), expiresAt: 0 }
        store.set(key, e)
      }
      e.value.set(String(member), Number(score))
      return 1
    },
    async zrem(key, ...members) {
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
    async zremrangebyrank(key, start, stop) {
      const e = getEntry(key)
      if (!e || e.type !== 'zset') return 0
      const sorted = [...e.value.entries()].sort((a, b) => a[1] - b[1])
      const slice = sorted.slice(start, stop + 1)
      for (const [m] of slice) e.value.delete(m)
      return slice.length
    },
    async zrevrange(key, start, stop) {
      const e = getEntry(key)
      if (!e || e.type !== 'zset') return []
      const sorted = [...e.value.entries()].sort((a, b) => b[1] - a[1])
      return sorted.slice(start, stop + 1).map(([m]) => m)
    },
    async zrevrangebyscore(key, max, min, _limitKw, offset = 0, count = 200) {
      const e = getEntry(key)
      if (!e || e.type !== 'zset') return []
      const lo = min === '-inf' ? -Infinity : Number(min)
      const hi = max === '+inf' ? Infinity : Number(max)
      const filtered = [...e.value.entries()].filter(([, s]) => s >= lo && s <= hi).sort((a, b) => b[1] - a[1])
      return filtered.slice(Number(offset) || 0, (Number(offset) || 0) + (Number(count) || 200)).map(([m]) => m)
    },
    async eval(script, numKeys, ...rest) {
      if (redis.failWrites) throw new Error('redis lua error')
      const keys = rest.slice(0, numKeys)
      const args = rest.slice(numKeys)
      const [inflightKey, reqKey, sessConcKey, recentZsetKey, recentReqKey] = keys
      const [reqId, completedAtRaw, recentJson, recentTtlRaw, recentMaxRaw, hasSess] = args
      const completedAt = Number(completedAtRaw) || 0
      const recentTtlMs = Number(recentTtlRaw) || 15_000
      const recentMax = Number(recentMaxRaw) || 500

      const removed = await this.zrem(inflightKey, reqId)
      await this.del(reqKey)
      if (hasSess === '1' && removed === 1) {
        const next = await this.decr(sessConcKey)
        if (next <= 0) await this.del(sessConcKey)
      }
      if (recentJson) {
        await this.set(recentReqKey, recentJson, 'PX', recentTtlMs)
        await this.zadd(recentZsetKey, completedAt, reqId)
        await this.zremrangebyscore(recentZsetKey, '-inf', completedAt - recentTtlMs)
        const card = await this.zcard(recentZsetKey)
        if (card > recentMax) {
          await this.zremrangebyrank(recentZsetKey, 0, card - recentMax - 1)
        }
        await this.pexpire(recentZsetKey, recentTtlMs * 2)
      }
      return removed
    },
    pipeline() {
      const queue = []
      const pipe = {
        set: (...a) => {
          queue.push(() => redis.set(...a))
          return pipe
        },
        incr: (...a) => {
          queue.push(() => redis.incr(...a))
          return pipe
        },
        expire: (...a) => {
          queue.push(() => redis.expire(...a))
          return pipe
        },
        pexpire: (...a) => {
          queue.push(() => redis.pexpire(...a))
          return pipe
        },
        zadd: (...a) => {
          queue.push(() => redis.zadd(...a))
          return pipe
        },
        zcard: (...a) => {
          queue.push(() => redis.zcard(...a))
          return pipe
        },
        zremrangebyscore: (...a) => {
          queue.push(() => redis.zremrangebyscore(...a))
          return pipe
        },
        zrevrange: (...a) => {
          queue.push(() => redis.zrevrange(...a))
          return pipe
        },
        zrevrangebyscore: (...a) => {
          queue.push(() => redis.zrevrangebyscore(...a))
          return pipe
        },
        async exec() {
          if (redis.failWrites) throw new Error('redis pipeline error')
          const out = []
          for (const fn of queue) {
            try {
              out.push([null, await fn()])
            } catch (err) {
              out.push([err, null])
            }
          }
          return out
        },
      }
      return pipe
    },
    async quit() {},
    disconnect() {},
  }
  return redis
}

test('LiveLogCache fallback mode tracks full lifecycle, _live shape, recent bridge, orphan eviction, and sessions', async () => {
  const client = new MultiTierCacheClient({ redisConfig: null })
  const live = new LiveLogCache(client, { reqTtlMs: 300_000, recentTtlMs: 15_000, recentMaxEntries: 500 })

  const t0 = Date.now()
  await live.startRequest('req_1', {
    started_at: t0,
    user_id: 'u_1',
    api_key_id: 'k_1',
    session_id: 'sess_alpha',
    model: 'claude-sonnet-4-5',
    protocol: 'anthropic',
    path: '/v1/messages',
    method: 'POST',
    stream: true,
  })
  await live.startRequest('req_2', {
    started_at: t0 + 50,
    user_id: 'u_2',
    session_id: 'sess_beta',
    model: 'claude-opus-4',
  })

  // Non-blocking phase updates
  live.updatePhase('req_1', {
    phase: 'retrying',
    attempt_count: 1,
    vm_id: 'vm_a',
    account_id: 'acc_a',
    active_provider: 'acc_a@example.com',
  })
  live.updatePhase('req_1', { phase: 'streaming', attempt_count: 2, vm_id: 'vm_b', account_id: 'acc_b', ttft_ms: 145 })

  assert.equal(await live.getInflightCount(), 2)
  const sessCounts = await live.getActiveSessionCounts(['sess_alpha', 'sess_beta', 'sess_none'])
  assert.equal(sessCounts.get('sess_alpha'), 1)
  assert.equal(sessCounts.get('sess_beta'), 1)
  assert.equal(sessCounts.get('sess_none'), 0)

  const activeKeys = await live.getActiveSessionKeys(300_000)
  assert.equal(activeKeys.includes('sess_alpha'), true)
  assert.equal(activeKeys.includes('sess_beta'), true)

  // Verify frontend/backend aligned output fields
  const items = await live.listLiveAndRecent({ limit: 10 })
  assert.equal(items.length, 2)
  const item1 = items.find((i) => i.request_id === 'req_1')
  assert.equal(item1.in_flight, true)
  assert.deepEqual(item1._live, {
    phase: 'streaming',
    attempt_count: 2,
    started_at: t0,
    ttft_ms: 145,
    vm_id: 'vm_b',
    account_id: 'acc_b',
    active_provider: 'acc_a@example.com',
  })

  // Tenant isolation filter
  const u1Only = await live.listLiveAndRecent({ ownerUserId: 'u_1' })
  assert.equal(u1Only.length, 1)
  assert.equal(u1Only[0].request_id, 'req_1')

  // Finish req_1 -> leaves inflight, decrements sess_alpha to 0, appears in recent bridge (in_flight: false)
  await live.finishRequest('req_1', {
    status: 200,
    duration_ms: 820,
    first_token_ms: 145,
    input_tokens: 500,
    output_tokens: 120,
    total_cost: 0.012,
  })
  // Duplicate finishRequest is idempotent and does not make session count negative
  await live.finishRequest('req_1', { status: 200 })

  assert.equal(await live.getInflightCount(), 1)
  assert.equal((await live.getActiveSessionCounts(['sess_alpha'])).get('sess_alpha'), 0)

  const afterFinish = await live.listLiveAndRecent({ limit: 10 })
  const finishedItem = afterFinish.find((i) => i.request_id === 'req_1')
  assert.equal(finishedItem.in_flight, false)
  assert.equal(finishedItem.status, 200)
  assert.equal(finishedItem._live, undefined)

  // Orphan timeout eviction removes stale req_2 when now advances past maxAgeMs
  const pruned = await live.listLiveAndRecent({ maxAgeMs: 5_000, now: t0 + 20_000 })
  assert.equal(pruned.length, 0)
  assert.equal(await live.getInflightCount({ maxAgeMs: 5_000, now: t0 + 20_000 }), 0)

  await client.close()
})

test('LiveLogCache Redis mode coalesces rapid updatePhase calls in 1 microtask and handles atomic finish + Fail-Open', async () => {
  const mockRedis = createLiveMockRedis()
  const client = new MultiTierCacheClient({ redisConfig: null })
  client.redis = mockRedis
  client.redisReady = true
  const live = new LiveLogCache(client, { reqTtlMs: 300_000, recentTtlMs: 15_000, recentMaxEntries: 50 })

  const startedAt = Date.now()
  await live.startRequest('req_redis_1', {
    started_at: startedAt,
    user_id: 'u_r1',
    session_id: 'sess_r1',
    model: 'claude-sonnet-4-5',
  })
  const writesAfterStart = mockRedis.setCalls.length
  assert.equal(writesAfterStart, 1)

  // 4 synchronous updates in the same tick MUST coalesce into a SINGLE Redis SET!
  live.updatePhase('req_redis_1', { phase: 'routing', attempt_count: 1 })
  live.updatePhase('req_redis_1', { vm_id: 'vm_1', account_id: 'acc_1' })
  live.updatePhase('req_redis_1', { phase: 'streaming', ttft_ms: 90 })
  live.updatePhase('req_redis_1', { active_provider: 'acc1@demo.io' })

  await live.flushPending()
  assert.equal(
    mockRedis.setCalls.length,
    writesAfterStart + 1,
    '4 same-tick updatePhase calls must coalesce to 1 Redis SET',
  )

  // Verify Redis stored final merged _live fields
  const listed = await live.listLiveAndRecent({ limit: 10 })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].in_flight, true)
  assert.equal(listed[0]._live.phase, 'streaming')
  assert.equal(listed[0]._live.ttft_ms, 90)
  assert.equal(listed[0]._live.vm_id, 'vm_1')
  assert.equal(listed[0]._live.active_provider, 'acc1@demo.io')

  // Session concurrency incremented in Redis
  assert.equal(mockRedis.store.get('vm2api:live:sess:conc:sess_r1')?.value, '1')
  assert.equal((await live.getActiveSessionCounts(['sess_r1'])).get('sess_r1'), 1)

  // Finish atomically removes inflight, DELs zeroed session counter, writes recent
  await live.finishRequest('req_redis_1', { status: 200, duration_ms: 350, input_tokens: 100, output_tokens: 40 })
  assert.equal(mockRedis.store.has('vm2api:live:req:req_redis_1'), false)
  assert.equal(
    mockRedis.store.has('vm2api:live:sess:conc:sess_r1'),
    false,
    'zeroed session concurrency key must be DELeted',
  )
  assert.equal(await live.getInflightCount(), 0)

  const after = await live.listLiveAndRecent({ limit: 10 })
  assert.equal(after.length, 1)
  assert.equal(after[0].request_id, 'req_redis_1')
  assert.equal(after[0].in_flight, false)
  assert.equal(after[0].status, 200)

  // Fail-Open: if Redis starts failing mid-flight, start/update/finish/list degrade to local without throwing
  mockRedis.failWrites = true
  await live.startRequest('req_fo_1', { started_at: Date.now(), session_id: 'sess_fo', model: 'gpt-5' })
  live.updatePhase('req_fo_1', { phase: 'streaming', ttft_ms: 42 })
  await live.flushPending()
  const foList = await live.listLiveAndRecent({ limit: 10 })
  assert.equal(
    foList.some((x) => x.request_id === 'req_fo_1' && x.in_flight === true && x._live.ttft_ms === 42),
    true,
  )
  await live.finishRequest('req_fo_1', { status: 200, duration_ms: 120 })
  const foAfter = await live.listLiveAndRecent({ limit: 10 })
  assert.equal(
    foAfter.some((x) => x.request_id === 'req_fo_1' && x.in_flight === false),
    true,
  )

  await client.close()
})

test('LiveLogCache caps recent entries at recentMaxEntries', async () => {
  const client = new MultiTierCacheClient({ redisConfig: null })
  const live = new LiveLogCache(client, { recentMaxEntries: 12, recentTtlMs: 30_000 })
  const base = Date.now()
  for (let i = 0; i < 20; i += 1) {
    await live.startRequest(`r_${i}`, { started_at: base + i })
    await live.finishRequest(`r_${i}`, { status: 200, completed_at: base + i + 1 })
  }
  const items = await live.listLiveAndRecent({ limit: 100 })
  assert.equal(items.length, 12)
  assert.equal(items[0].request_id, 'r_19')
  assert.equal(items[11].request_id, 'r_8')
  await client.close()
})

test('LiveLogCache owner filtering matches user_id, owner_user_id, vm_owner_user_id, and ownerKeyIds across inflight and recent', async () => {
  const mockRedis = createLiveMockRedis()
  const client = new MultiTierCacheClient({ redisConfig: null })
  client.redis = mockRedis
  client.redisReady = true
  const live = new LiveLogCache(client, { reqTtlMs: 300_000, recentTtlMs: 15_000 })
  const base = Date.now()

  // 1. Direct user_id match (in-flight)
  await live.startRequest('own_by_user', { started_at: base + 1, user_id: 'u_t1', model: 'claude' })
  // 2. VM owner match where caller is a different user (in-flight -> updatePhase adds vm_owner_user_id)
  await live.startRequest('own_by_vm', { started_at: base + 2, user_id: 'u_other', vm_id: 'vm_t1', model: 'claude' })
  live.updatePhase('own_by_vm', { phase: 'streaming', vm_owner_user_id: 'u_t1' })
  await live.flushPending()
  // 3. owner_user_id match (finished -> recent)
  await live.startRequest('own_by_owner_field', { started_at: base + 3, owner_user_id: 'u_t1', model: 'claude' })
  await live.finishRequest('own_by_owner_field', { status: 200, completed_at: base + 4 })
  // 4. Key owner match via ownerKeyIds (in-flight)
  await live.startRequest('own_by_key', { started_at: base + 5, user_id: null, api_key_id: 'key_t1', model: 'claude' })
  // 5. Completely unrelated tenant (must be excluded)
  await live.startRequest('other_tenant', {
    started_at: base + 6,
    user_id: 'u_stranger',
    owner_user_id: 'u_stranger',
    vm_owner_user_id: 'u_stranger',
    api_key_id: 'key_stranger',
  })

  const withoutKeys = await live.listLiveAndRecent({ ownerUserId: 'u_t1', limit: 20 })
  const idsWithoutKeys = withoutKeys.map((x) => x.request_id).sort()
  assert.deepEqual(idsWithoutKeys, ['own_by_owner_field', 'own_by_user', 'own_by_vm'])
  assert.equal(withoutKeys.find((x) => x.request_id === 'own_by_vm')?.vm_owner_user_id, 'u_t1')
  assert.equal(withoutKeys.find((x) => x.request_id === 'own_by_owner_field')?.owner_user_id, 'u_t1')

  const withKeys = await live.listLiveAndRecent({ ownerUserId: 'u_t1', ownerKeyIds: ['key_t1'], limit: 20 })
  const idsWithKeys = withKeys.map((x) => x.request_id).sort()
  assert.deepEqual(idsWithKeys, ['own_by_key', 'own_by_owner_field', 'own_by_user', 'own_by_vm'])

  await client.close()
})
