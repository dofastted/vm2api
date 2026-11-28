import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'

import { closeDatabaseAsync, createDatabase, getPgPool, openDatabaseAsync } from '../../src/lib/db/database.mjs'
import { armWriteBehind, flushWrites, pendingWrites } from '../../src/lib/db/write-behind.mjs'
import {
  closeCacheRuntime,
  getCacheRuntime,
  initCacheRuntime,
  notifyDbTablesMutated,
} from '../../src/lib/cache/index.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { SchedulerPoolsRepo } from '../../src/lib/db/repos/scheduler-pools-repo.mjs'
import { RefusalGuardsRepo, invalidateRefusalGuardsSnapshot } from '../../src/lib/db/repos/refusal-guards-repo.mjs'
import { RefusalDeviceBlocksRepo } from '../../src/lib/db/repos/refusal-device-blocks-repo.mjs'
import { RefusalSessionBlocksRepo } from '../../src/lib/db/repos/refusal-session-blocks-repo.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { ownerScopeFromRequest, pinnedVmIdFromRequest } from '../../src/lib/admin/resource-owner.mjs'
import { resolvePoolAccessForKey } from '../../src/lib/admin/key-scope.mjs'
import { evaluateProtocolIntercept, invalidateRiskBanCache } from '../../src/lib/protocol/intercept-gate.mjs'
import { encodeSignature, refusalSignature } from '../../src/lib/core/refusal-similarity.mjs'
import { ThinkingOwnerStore } from '../../src/lib/pool/thinking-owner.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { RateLimitService } from '../../src/lib/pool/rate-limit-service.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'

function makeTmpDb(prefix = 'kin-req-opt-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const db = createDatabase({ dataDir: dir })
  return { dir, db }
}

/** Minimal in-memory ioredis-compatible mock for testing L2 / Lua / Multi / Pipeline paths. */
function createMockRedis() {
  const kv = new Map() // key -> string
  const hashes = new Map() // key -> Map<field, string>
  const sets = new Map() // key -> Set<string>
  const zsets = new Map() // key -> Map<member, score>
  const ops = []

  function execCommand(cmd, args) {
    ops.push({ cmd, args })
    if (cmd === 'get') return kv.has(args[0]) ? kv.get(args[0]) : null
    if (cmd === 'set') {
      kv.set(args[0], String(args[1]))
      return 'OK'
    }
    if (cmd === 'del') {
      let n = 0
      for (const k of args) {
        if (kv.delete(k)) n += 1
        if (hashes.delete(k)) n += 1
        if (sets.delete(k)) n += 1
        if (zsets.delete(k)) n += 1
      }
      return n
    }
    if (cmd === 'pexpire' || cmd === 'expire') return kv.has(args[0]) || hashes.has(args[0]) ? 1 : 0
    if (cmd === 'pttl') return kv.has(args[0]) || hashes.has(args[0]) ? 60_000 : -2
    if (cmd === 'mget') return args.map((k) => (kv.has(k) ? kv.get(k) : null))
    if (cmd === 'incr') {
      const next = (Number.parseInt(kv.get(args[0]) || '0', 10) || 0) + 1
      kv.set(args[0], String(next))
      return next
    }
    if (cmd === 'decr') {
      const next = (Number.parseInt(kv.get(args[0]) || '0', 10) || 0) - 1
      kv.set(args[0], String(next))
      return next
    }
    if (cmd === 'spop') {
      const [key, count] = args
      const s = sets.get(key)
      if (!s || !s.size) return []
      const out = []
      for (const item of s) {
        out.push(item)
        s.delete(item)
        if (out.length >= (Number(count) || 1)) break
      }
      return out
    }
    if (cmd === 'hgetall') {
      const h = hashes.get(args[0])
      if (!h || !h.size) return {}
      return Object.fromEntries(h.entries())
    }
    if (cmd === 'eval') {
      const [script, numKeys, ...rest] = args
      const keys = rest.slice(0, numKeys)
      const argv = rest.slice(numKeys)
      if (script.includes('HINCRBYFLOAT')) {
        const [hashKey, dirtyKey] = keys
        let h = hashes.get(hashKey)
        if (!h) {
          h = new Map()
          hashes.set(hashKey, h)
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
          const v = Number(argv[i]) || 0
          if (v !== 0) h.set(fields[i], String((Number(h.get(fields[i])) || 0) + v))
        }
        if (argv[7]) {
          const prev = h.get('last_used_at')
          if (!prev || argv[7] > prev) h.set('last_used_at', argv[7])
        }
        let s = sets.get(dirtyKey)
        if (!s) {
          s = new Set()
          sets.set(dirtyKey, s)
        }
        s.add(argv[8])
        return 1
      }
      if (script.includes("redis.call('HGETALL'")) {
        const h = hashes.get(keys[0])
        hashes.delete(keys[0])
        if (!h || !h.size) return []
        const flat = []
        for (const [k, v] of h) flat.push(k, v)
        return flat
      }
      if (script.includes('ZCARD') && script.includes('ZADD') && script.includes('maxSlots')) {
        const [slotKey] = keys
        const ttl = Number(argv[0]) || 300
        const maxSlots = Number(argv[1]) || 1
        const reqId = String(argv[2])
        const nowSec = Math.floor(Date.now() / 1000)
        let z = zsets.get(slotKey)
        if (!z) {
          z = new Map()
          zsets.set(slotKey, z)
        }
        for (const [m, sc] of z) if (sc <= nowSec - ttl) z.delete(m)
        if (z.size < maxSlots) {
          z.set(reqId, nowSec)
          return 1
        }
        return 0
      }
      if (script.includes("'ZREM'")) {
        const z = zsets.get(keys[0])
        if (z) {
          z.delete(String(argv[0]))
          if (!z.size) zsets.delete(keys[0])
        }
        return 1
      }
      if (script.includes('ZCARD') && !script.includes('ZADD')) {
        const z = zsets.get(keys[0])
        return z ? z.size : 0
      }
      return 1
    }
    return null
  }

  function makeChain() {
    const queue = []
    const chain = {
      get: (...a) => (queue.push(['get', a]), chain),
      pttl: (...a) => (queue.push(['pttl', a]), chain),
      set: (...a) => (queue.push(['set', a]), chain),
      del: (...a) => (queue.push(['del', a]), chain),
      incr: (...a) => (queue.push(['incr', a]), chain),
      expire: (...a) => (queue.push(['expire', a]), chain),
      hgetall: (...a) => (queue.push(['hgetall', a]), chain),
      eval: (...a) => (queue.push(['eval', a]), chain),
      exec: async () => queue.map(([c, a]) => [null, execCommand(c, a)]),
    }
    return chain
  }

  return {
    kv,
    hashes,
    sets,
    zsets,
    ops,
    get: async (...a) => execCommand('get', a),
    set: async (...a) => execCommand('set', a),
    del: async (...a) => execCommand('del', a),
    pexpire: async (...a) => execCommand('pexpire', a),
    pttl: async (...a) => execCommand('pttl', a),
    mget: async (...a) => execCommand('mget', a),
    incr: async (...a) => execCommand('incr', a),
    decr: async (...a) => execCommand('decr', a),
    spop: async (...a) => execCommand('spop', a),
    eval: async (...a) => execCommand('eval', a),
    time: async () => [String(Math.floor(Date.now() / 1000)), '0'],
    publish: async () => 0,
    multi: () => makeChain(),
    pipeline: () => makeChain(),
    quit: async () => 'OK',
  }
}

async function withMockRedis(fn) {
  await closeCacheRuntime()
  const rt = await initCacheRuntime({ redisConfig: null })
  const mock = createMockRedis()
  rt.client.redis = mock
  rt.client.redisReady = true
  try {
    return await fn(rt, mock)
  } finally {
    rt.client.redis = null
    rt.client.redisReady = false
    await closeCacheRuntime()
  }
}

test('ApiKeyStore.authenticateAsync caches L1+L2, bounded L1 negCache (never writes Redis), projects owner/group, and _userInflight is O(1)', async (t) => {
  const { dir, db } = makeTmpDb('kin-auth-opt-')
  t.after(() => {
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await withMockRedis(async (rt, mock) => {
    const store = new ApiKeyStore({ db, writeBehindUsage: false })
    const now = new Date().toISOString()
    store.users.insert({
      id: 'u-tenant-1',
      username: 'tenant1',
      password_hash: 'h',
      role: 'user',
      concurrency: 1,
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    store.groups.update(1, { rate_multiplier: 1.5 })
    const key1 = store.create({ name: 'k1', user_id: 'u-tenant-1', group_id: 1, max_concurrency: 5, rpm: 3 })
    const key2 = store.create({ name: 'k2', user_id: 'u-tenant-1', group_id: 1, max_concurrency: 5, rpm: 3 })

    let hashCalls = 0
    let listCalls = 0
    const origGetByHash = store.repo.getByHash.bind(store.repo)
    const origList = store.repo.list.bind(store.repo)
    store.repo.getByHash = (...a) => {
      hashCalls += 1
      return origGetByHash(...a)
    }
    store.repo.list = (...a) => {
      listCalls += 1
      return origList(...a)
    }

    // 1. Cold authenticateAsync populates L1 + Redis L2 + _authProjection
    const a1 = await store.authenticateAsync(key1.key)
    assert.equal(a1.ok, true)
    assert.equal(hashCalls, 1)
    assert.equal(a1.record._authProjection.ownerActive, true)
    assert.equal(a1.record._authProjection.ownerMaxConcurrency, 1)
    assert.equal(a1.record._authProjection.groupRateMultiplier, 1.5)
    assert.equal(Object.keys(a1.record).includes('_authProjection'), false, '_authProjection must stay non-enumerable')

    // 2. Second authenticateAsync hits L1 -> 0 DB calls
    const a2 = await store.authenticateAsync(key1.key)
    assert.equal(a2.ok, true)
    assert.equal(hashCalls, 1)

    // 3. Clearing L1 only -> hits Redis L2 -> still 0 DB calls
    rt.client.l1.clear()
    const a3 = await store.authenticateAsync(key1.key)
    assert.equal(a3.ok, true)
    assert.equal(hashCalls, 1)

    // 4. Negative auth cached in bounded L1 only, NEVER written to Redis
    const kvSizeBeforeNeg = mock.kv.size
    const bad1 = await store.authenticateAsync('sk-vm-nonexistent-token-00000001')
    assert.equal(bad1.ok, false)
    assert.equal(bad1.reason, 'invalid')
    assert.equal(hashCalls, 2)
    assert.equal(mock.kv.size, kvSizeBeforeNeg, 'negative auth entries must never be written to Redis')
    const bad2 = await store.authenticateAsync('sk-vm-nonexistent-token-00000001')
    assert.equal(bad2.ok, false)
    assert.equal(hashCalls, 2, 'second invalid token attempt must hit bounded L1 negCache')

    // 5. O(1) user concurrency across multiple keys + Redis ConcurrencyCache + rollback
    listCalls = 0
    const acq1 = await store.acquireAsync(a1.record)
    assert.equal(acq1.ok, true)
    const aKey2 = await store.authenticateAsync(key2.key)
    const acq2 = await store.acquireAsync(aKey2.record)
    assert.equal(acq2.ok, false)
    assert.equal(acq2.code, 'user_concurrency_limit')
    assert.equal(listCalls, 0, '_userInflight must never full-scan api_keys via repo.list()')
    // Key2's Redis slot must have been rolled back when user concurrency rejected it
    assert.equal(await rt.concurrency.countKey(key2.id), 0)

    store.release(a1.record)
    assert.equal(store._userInflight('u-tenant-1'), 0)
  })
})

test('ApiKeyStore Dirty-Set Write-Behind batches usage, enforces Safety Floor on quota hit, and supports PG VALUES batch + re-add on failure', async (t) => {
  const { dir, db } = makeTmpDb('kin-billing-wb-')
  t.after(async () => {
    await closeCacheRuntime()
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await closeCacheRuntime()
  await initCacheRuntime({ redisConfig: null })

  // 1. SQLite write-behind batch + immediate overlay + Safety Floor
  const store = new ApiKeyStore({ db, writeBehindUsage: true, usageFlushIntervalMs: 60_000 })
  const rec = store.create({ name: 'wb-key', quota: 1.0, quota_requests: 10 })

  store.recordUsage(rec, { input_tokens: 100, output_tokens: 50, total_cost: 0.3 })
  store.recordUsage(rec, { input_tokens: 200, output_tokens: 100, total_cost: 0.25 })

  // DB has not been written yet (0 sync DB writes), but in-process reads immediately see overlay
  assert.equal(store.repo.getById(rec.id).requests, 0)
  assert.equal(store.getById(rec.id).requests, 2)
  assert.equal(store.getById(rec.id).tokens_in, 300)
  assert.ok(Math.abs(store.getById(rec.id).quota_used - 0.55) < 1e-9)

  // Safety floor: next spend pushes total to 1.15 >= quota 1.0 -> immediate flush + quota_exhausted
  store.recordUsage(rec, { input_tokens: 10, output_tokens: 5, total_cost: 0.6 })
  assert.equal(
    store.repo.getById(rec.id).status,
    'quota_exhausted',
    'Safety floor must persist quota_exhausted immediately',
  )
  const gate = store.canAccept(store.getById(rec.id))
  assert.equal(gate.ok, false)
  assert.equal(gate.status, 402)
  assert.equal(gate.limit_type, 'usd_quota')

  // Drain remaining buffered deltas and verify exact totals (no double-counting!)
  await store.close()
  const persisted = store.repo.getById(rec.id)
  assert.equal(persisted.requests, 3)
  assert.equal(persisted.quota_requests_used, 3)
  assert.equal(persisted.tokens_in, 310)
  assert.equal(persisted.tokens_out, 155)
  assert.ok(Math.abs(persisted.quota_used - 1.15) < 1e-9)

  // 2. PG async pgPool VALUES batch + failure readdDirtyKeyUsage
  let failOnce = true
  const pgQueries = []
  const mockPgPool = {
    query: async (sql, params) => {
      pgQueries.push({ sql, params })
      if (failOnce) {
        failOnce = false
        throw new Error('transient pg error')
      }
      return { rows: [] }
    },
  }
  const pgStore = new ApiKeyStore({ db, writeBehindUsage: true, usageFlushIntervalMs: 60_000, pgPool: mockPgPool })
  const kA = pgStore.create({ name: 'pg-a' })
  const kB = pgStore.create({ name: 'pg-b' })
  pgStore.recordUsage(kA, { input_tokens: 10, output_tokens: 2, total_cost: 0.05 })
  pgStore.recordUsage(kB, { input_tokens: 20, output_tokens: 4, total_cost: 0.1 })

  const failedRes = await pgStore.flushPendingUsage()
  assert.equal(failedRes.flushed, 0)
  assert.equal(failedRes.failed, 2)
  assert.match(failedRes.error, /transient pg error/)
  assert.equal(pgStore.usageFlushStats().failures, 1)
  assert.match(pgStore.usageFlushStats().lastError, /transient pg error/)
  assert.equal(getCacheRuntime().billing.pendingLocalDirtyCount(), 2, 'failed batch must re-add entries to dirty set')

  const okRes = await pgStore.flushPendingUsage()
  assert.equal(okRes.flushed, 2)
  assert.equal(okRes.failed, 0)
  const batchSql = pgQueries[1].sql
  assert.match(batchSql, /UPDATE api_keys AS k[\s\S]*FROM \(VALUES/)
  assert.match(batchSql, /\(\$1::text\)::timestamptz/)
  assert.match(batchSql, /NULLIF\(k\.window_5h_start, ''\)::timestamptz/)
  assert.match(batchSql, /NULLIF\(k\.window_1d_start, ''\)::timestamptz/)
  assert.match(batchSql, /NULLIF\(k\.window_7d_start, ''\)::timestamptz/)
  assert.match(batchSql, /THEN \$1::text/)
  assert.match(batchSql, /updated_at = \$1::text/)
  assert.doesNotMatch(batchSql, /[^)]\$1::timestamptz/, 'must never cast raw $1 directly to timestamptz')
  assert.doesNotMatch(batchSql, /k\.window_(?:5h|1d|7d)_start::timestamptz/, 'must guard empty string with NULLIF')
  await pgStore.close()
})

test('ApiKeyStore usage flusher drains multiple batches per tick, logs throttled errors on failure, and persists cleanly on real PG 18', async (t) => {
  const { dir, db } = makeTmpDb('kin-billing-tick-')
  t.after(async () => {
    await closeCacheRuntime()
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await closeCacheRuntime()
  await initCacheRuntime({ redisConfig: null })

  // 1. Multi-batch tick draining (>200 dirty keys drained in one tick, not capped at 1 batch)
  const seenBatches = []
  const batchPgPool = {
    query: async (_sql, params) => {
      seenBatches.push((params.length - 1) / 9)
      return { rows: [] }
    },
  }
  const tickStore = new ApiKeyStore({ db, writeBehindUsage: true, usageFlushIntervalMs: 60_000, pgPool: batchPgPool })
  const billing = getCacheRuntime().billing
  for (let i = 0; i < 250; i += 1) {
    await billing.accumulateKeyUsage(`key_tick_${i}`, {
      requests: 1,
      quota_requests_used: 1,
      tokens_in: 10,
      tokens_out: 5,
      cost: 0.01,
    })
  }
  const drained = await tickStore._drainUsageTick()
  assert.equal(drained, 250, 'single tick must drain across multiple 200-key batches until empty')
  assert.deepEqual(seenBatches, [200, 50])
  await tickStore.close()

  // 2. Throttled console.error observability on repeated flush failures (without swallowing errors)
  const errorLogs = []
  const origConsoleError = console.error
  console.error = (...args) => errorLogs.push(args.join(' '))
  try {
    const failingPool = {
      query: async () => {
        throw new Error('PG18 synthetic failure')
      },
    }
    const errStore = new ApiKeyStore({ db, writeBehindUsage: true, usageFlushIntervalMs: 60_000, pgPool: failingPool })
    await billing.accumulateKeyUsage('key_err_1', { requests: 1, cost: 0.02 })
    const r1 = await errStore.flushPendingUsage()
    const r2 = await errStore.flushPendingUsage()
    assert.equal(r1.failed, 1)
    assert.equal(r2.failed, 1)
    assert.equal(errStore.usageFlushStats().failures, 2)
    assert.match(errStore.usageFlushStats().lastError, /PG18 synthetic failure/)
    assert.equal(errorLogs.length, 1, 'consecutive failures within throttle window must emit 1 console.error alert')
    assert.match(errorLogs[0], /PG18 synthetic failure/)
    // Clean up re-added dirty entry so subsequent tests start clean
    await billing.popDirtyKeyUsage(10)
    await errStore.close()
  } finally {
    console.error = origConsoleError
  }

  // 3. Real PG 18 execution branch (when VM2API_TEST_PG_URL is configured)
  const pgUrl = process.env.VM2API_TEST_PG_URL || ''
  if (pgUrl) {
    const schema = `vm2api_usage_pg18_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    const admin = new pg.Client({ connectionString: pgUrl })
    await admin.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.end()

    const u = new URL(pgUrl)
    u.searchParams.set('options', `-c search_path=${schema}`)
    const pgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-pg18-usage-'))
    try {
      const pgDb = await openDatabaseAsync({
        dataDir: pgDir,
        driver: 'postgres',
        connectionString: u.toString(),
        pooled: true,
        enableAggregator: false,
      })
      const pool = getPgPool()
      const liveStore = new ApiKeyStore({
        db: pgDb,
        writeBehindUsage: true,
        usageFlushIntervalMs: 60_000,
        pgPool: pool,
      })
      const kNull = liveStore.create({ name: 'pg18-null-win' })
      const kEmpty = liveStore.create({ name: 'pg18-empty-win' })
      const kActive = liveStore.create({ name: 'pg18-active-win' })

      const activeWinStart = new Date(Date.now() - 60_000).toISOString()
      await pool.query(
        "UPDATE api_keys SET window_5h_start = '', window_1d_start = '', window_7d_start = '' WHERE id = $1",
        [kEmpty.id],
      )
      await pool.query(
        'UPDATE api_keys SET window_5h_start = $2, usage_5h = 0.25, window_1d_start = $2, usage_1d = 0.25, window_7d_start = $2, usage_7d = 0.25 WHERE id = $1',
        [kActive.id, activeWinStart],
      )

      const nowIso = new Date().toISOString()
      const updatedRows = await liveStore._applyUsageBatchToPg(
        pool,
        [
          {
            keyId: kNull.id,
            requests: 2,
            quota_requests_used: 2,
            tokens_in: 120,
            tokens_out: 30,
            cache_read_tokens: 10,
            cache_creation_tokens: 5,
            cost: 0.4,
            last_used_at: nowIso,
          },
          {
            keyId: kEmpty.id,
            requests: 3,
            quota_requests_used: 3,
            tokens_in: 300,
            tokens_out: 90,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cost: 0.75,
            last_used_at: nowIso,
          },
          {
            keyId: kActive.id,
            requests: 1,
            quota_requests_used: 1,
            tokens_in: 50,
            tokens_out: 20,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cost: 0.15,
            last_used_at: nowIso,
          },
        ],
        nowIso,
      )
      assert.equal(
        updatedRows.length,
        3,
        'real PG 18 batch update must succeed for NULL, empty-string, and ISO windows',
      )
      const byId = new Map(updatedRows.map((r) => [r.id, r]))
      assert.equal(Number(byId.get(kNull.id).requests), 2)
      assert.equal(byId.get(kNull.id).window_5h_start, nowIso)
      assert.equal(Number(byId.get(kEmpty.id).requests), 3)
      assert.equal(Number(byId.get(kEmpty.id).tokens_in), 300)
      assert.ok(Math.abs(Number(byId.get(kEmpty.id).usage_5h) - 0.75) < 1e-9)
      assert.equal(byId.get(kEmpty.id).window_5h_start, nowIso)
      assert.ok(Math.abs(Number(byId.get(kActive.id).usage_5h) - 0.4) < 1e-9)
      assert.equal(byId.get(kActive.id).window_5h_start, activeWinStart)
      await liveStore.close()
    } finally {
      await closeDatabaseAsync().catch(() => {})
      const cleanup = new pg.Client({ connectionString: pgUrl })
      await cleanup.connect()
      await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
      await cleanup.end()
      fs.rmSync(pgDir, { recursive: true, force: true })
    }
  }
})

test('GroupsRepo caches rateMultiplier including 0 and invalidates on update; resource-owner reuses _authProjection and EntityCache', async (t) => {
  const { dir, db } = makeTmpDb('kin-grp-owner-')
  t.after(async () => {
    await closeCacheRuntime()
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await closeCacheRuntime()
  await initCacheRuntime({ redisConfig: null })

  const groups = new GroupsRepo(db)
  let groupReads = 0
  const origGetById = groups.getById.bind(groups)
  groups.getById = (...a) => {
    groupReads += 1
    return origGetById(...a)
  }

  assert.equal(groups.rateMultiplier(1), 1)
  assert.equal(groups.rateMultiplier(1), 1)
  assert.equal(groupReads, 1, 'second rateMultiplier read must hit L1 EntityCache')

  groups.update(1, { rate_multiplier: 0 })
  groupReads = 0
  assert.equal(groups.rateMultiplier(1), 0, 'explicit 0 multiplier must not be coerced to 1')
  assert.equal(groups.rateMultiplier(1), 0)
  assert.equal(groupReads, 1)

  // Verify rate_multiplier = 0 flows through Redis L2 SSOT across L1 evictions (multi-instance safe)
  await withMockRedis(async (rt) => {
    let l2Reads = 0
    groups.getById = (...a) => {
      l2Reads += 1
      return origGetById(...a)
    }
    assert.equal(await groups.rateMultiplierAsync(1), 0)
    assert.equal(l2Reads, 1)
    rt.client.l1.clear()
    assert.equal(await groups.rateMultiplierAsync(1), 0, 'Redis L2 hit must preserve rate_multiplier = 0')
    assert.equal(l2Reads, 1, 'L2 hit after L1 clear must not query DB')
  })
  await initCacheRuntime({ redisConfig: null })
  groups.getById = (...a) => {
    groupReads += 1
    return origGetById(...a)
  }

  groups.update(1, { rate_multiplier: 2.25 })
  assert.equal(groups.rateMultiplier(1), 2.25)

  // resource-owner reuses _authProjection with 0 usersRepo DB reads
  const users = new UsersRepo(db)
  const now = new Date().toISOString()
  users.insert({
    id: 'u-adm',
    username: 'adm',
    password_hash: 'x',
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  await getCacheRuntime().entity.invalidateUsers()
  let userReads = 0
  const origUserGet = users.getById.bind(users)
  users.getById = (...a) => {
    userReads += 1
    return origUserGet(...a)
  }

  const recWithProj = { id: 'k1', user_id: 'u-adm' }
  Object.defineProperty(recWithProj, '_authProjection', {
    value: { userId: 'u-adm', owner: { id: 'u-adm', role: 'admin', status: 'active' }, ownerLoaded: true },
    enumerable: false,
  })
  const reqProj = { apiKeyKind: 'managed', apiKeyRecord: recWithProj, headers: { 'x-kin-vm': 'vm-01' } }
  assert.equal(ownerScopeFromRequest(reqProj, users).type, 'platform')
  assert.equal(pinnedVmIdFromRequest(reqProj, users), 'vm-01')
  assert.equal(userReads, 0, '_authProjection must eliminate usersRepo.getById calls')

  // Without _authProjection, request memo + EntityCache deduplicate multiple lookups in the same request
  const reqNoProj = {
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'k2', user_id: 'u-adm' },
    headers: { 'x-kin-vm': 'vm-02' },
  }
  assert.equal(ownerScopeFromRequest(reqNoProj, users).type, 'platform')
  assert.equal(pinnedVmIdFromRequest(reqNoProj, users), 'vm-02')
  assert.equal(userReads, 1)
})

test('resolvePoolAccessForKey caches bindings and pool records via EntityCache and honors invalidation', async (t) => {
  const { dir, db } = makeTmpDb('kin-pool-access-')
  t.after(async () => {
    await closeCacheRuntime()
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await closeCacheRuntime()
  await initCacheRuntime({ redisConfig: null })

  const pools = new SchedulerPoolsRepo(db)
  const pool = pools.insert({ id: 'pool_cache_01', name: 'Cache Pool', provider_scope: 'anthropic' })
  pools.setMembers(pool.id, [{ node_type: 'claude_vm', node_id: 'vm-01' }])
  pools.setKeyBindings('key_c1', [pool.id], { defaultPoolId: pool.id })

  let bindCalls = 0
  let getCalls = 0
  const origBind = pools.listBindingsByKey.bind(pools)
  const origGet = pools.get.bind(pools)
  pools.listBindingsByKey = (...a) => {
    bindCalls += 1
    return origBind(...a)
  }
  pools.get = (...a) => {
    getCalls += 1
    return origGet(...a)
  }

  const key = { id: 'key_c1', pool_binding_mode: 'strict_pool', default_pool_id: pool.id }
  const r1 = resolvePoolAccessForKey({ key, apiKeyKind: 'managed', poolsRepo: pools, useCache: true })
  const r2 = resolvePoolAccessForKey({ key, apiKeyKind: 'managed', poolsRepo: pools, useCache: true })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(bindCalls, 1)
  assert.equal(getCalls, 1)

  notifyDbTablesMutated(['scheduler_pools'])
  const r3 = resolvePoolAccessForKey({ key, apiKeyKind: 'managed', poolsRepo: pools, useCache: true })
  assert.equal(r3.ok, true)
  assert.equal(getCalls, 2)
})

test('RefusalGuardsRepo snapshot eliminates nearest() DB full scans and intercept-gate caches session/device bans with write invalidation', async (t) => {
  const { dir, db } = makeTmpDb('kin-risk-opt-')
  t.after(async () => {
    await closeCacheRuntime()
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await closeCacheRuntime()
  await initCacheRuntime({ redisConfig: null })

  const guards = new RefusalGuardsRepo(db)
  const text =
    'this is a sufficiently long test prompt used to compute a deterministic minhash signature for refusal guard testing '.repeat(
      6,
    )
  const sig = refusalSignature(text)
  assert.ok(sig)
  guards.remember({
    fingerprint: 'fp-1',
    model: 'claude-sonnet-4-6',
    errorMessage: 'upstream refused',
    signature: encodeSignature(sig),
  })
  invalidateRefusalGuardsSnapshot(db)

  let allActiveCalls = 0
  const origAll = guards._allActive.all.bind(guards._allActive)
  guards._allActive.all = (...a) => {
    allActiveCalls += 1
    return origAll(...a)
  }

  const m1 = guards.nearest(sig, 0.8)
  const m2 = guards.nearest(sig, 0.8)
  const g1 = guards.get('fp-1')
  assert.equal(m1?.fingerprint, 'fp-1')
  assert.equal(m2?.fingerprint, 'fp-1')
  assert.equal(g1?.fingerprint, 'fp-1')
  assert.equal(allActiveCalls, 1, 'repeated get() and nearest() must reuse in-process revision snapshot')

  guards.remove('fp-1')
  assert.equal(guards.nearest(sig, 0.8), null, 'remove() must invalidate snapshot immediately')

  // intercept-gate session & device ban short-TTL cache + write/unban invalidation
  const sessions = new RefusalSessionBlocksRepo(db)
  const devices = new RefusalDeviceBlocksRepo(db)
  let sessGets = 0
  let devFinds = 0
  const origSessGet = sessions.get.bind(sessions)
  const origDevFind = devices.findBan.bind(devices)
  sessions.get = (...a) => {
    sessGets += 1
    return origSessGet(...a)
  }
  devices.findBan = (...a) => {
    devFinds += 1
    return origDevFind(...a)
  }

  const baseArgs = {
    inbound: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello world' }] },
    headers: { 'x-claude-code-session-id': 'sess-cache-1' },
    identity: { principal: 'key:k1', deviceId: 'dev-cache-1', sessionId: 'sess-cache-1' },
    policy: { enabled: true, session_block_enabled: true, device_block_enabled: true },
    jev: { enabled: false },
    repo: guards,
    devices,
    sessions,
    requestId: 'req-gate-1',
    mandatoryOnly: true,
  }

  const p1 = await evaluateProtocolIntercept(baseArgs)
  const p2 = await evaluateProtocolIntercept(baseArgs)
  assert.equal(p1.action, 'pass')
  assert.equal(p2.action, 'pass')
  assert.equal(sessGets, 1, 'session ban lookup must hit L1 cache')
  assert.equal(devFinds, 1, 'device ban lookup must hit L1 cache')

  // Blocking session invalidates cache immediately
  sessions.block({ sessionId: 'sess-cache-1', requestId: 'req-gate-1', reason: 'upstream_refusal' })
  const b1 = await evaluateProtocolIntercept(baseArgs)
  assert.equal(b1.action, 'block')
  assert.equal(b1.kind, 'session')

  // Removing session ban via a separate repo instance (like panel DELETE route) invalidates cache immediately
  const panelSessions = new RefusalSessionBlocksRepo(db)
  panelSessions.remove('sess-cache-1')
  const p3 = await evaluateProtocolIntercept(baseArgs)
  assert.equal(p3.action, 'pass')

  // Explicit invalidateRiskBanCache() clears cached bans (including cold-instance panel invalidation)
  sessions.block({ sessionId: 'sess-cache-1', requestId: 'req-gate-2', reason: 'upstream_refusal' })
  assert.equal((await evaluateProtocolIntercept(baseArgs)).action, 'block')
  db.prepare('DELETE FROM refusal_session_blocks WHERE session_id = ?').run('sess-cache-1')
  await invalidateRiskBanCache({ kind: 'session', db })
  assert.equal((await evaluateProtocolIntercept(baseArgs)).action, 'pass')
})

test('ThinkingOwnerStore caches owners in L1 and batches record() asynchronously via enqueueWrite', async (t) => {
  const { dir, db } = makeTmpDb('kin-think-opt-')
  t.after(async () => {
    armWriteBehind(null)
    await closeCacheRuntime()
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await closeCacheRuntime()
  await initCacheRuntime({ redisConfig: null })
  armWriteBehind(db)

  const store = new ThinkingOwnerStore({ db, writeBehind: true })
  store.record(['sig-a', 'sig-b', 'sig-c'], 'acc-1')
  // First-writer-wins: second account cannot overwrite L1
  store.record(['sig-a'], 'acc-2')

  assert.ok(pendingWrites() > 0, 'record() must enqueue batched write via write-behind')

  // Reads resolve from L1 with 0 DB queries even before flush
  let dbOwnerCalls = 0
  const origOwnersAll = store.sql.owners.all.bind(store.sql.owners)
  store.sql.owners.all = (...a) => {
    dbOwnerCalls += 1
    return origOwnersAll(...a)
  }
  const owners = store.ownersOf(['sig-a', 'sig-b', 'sig-c'])
  assert.equal(owners.get('sig-a'), 'acc-1')
  assert.equal(owners.get('sig-b'), 'acc-1')
  assert.equal(owners.get('sig-c'), 'acc-1')
  assert.equal(dbOwnerCalls, 0)

  flushWrites()
  const rows = db.prepare('SELECT key, account_id FROM thinking_signature_owners ORDER BY key').all()
  assert.equal(rows.length, 3)
  assert.equal(rows[0].account_id, 'acc-1')
})

test('StickyRouter uses Redis-first getSticky/setSticky/delSticky, enqueueWrite, and indexed latestParentPoolKey', async (t) => {
  const { dir, db } = makeTmpDb('kin-sticky-opt-')
  t.after(() => {
    armWriteBehind(null)
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await withMockRedis(async (_rt, mock) => {
    armWriteBehind(db)
    const router = new StickyRouter({ db, config: { sticky: { enabled: true, ttl_seconds: 3600 } }, writeBehind: true })
    const key = 'p:anthropic:kkey_1:sess-parent-1'
    router.bind(key, { accountId: 'acc-1', vmId: 'vm-01', deviceId: 'dev-xyz' })
    assert.ok(pendingWrites() > 0, 'sticky bind must use enqueueWrite when write-behind is active')
    flushWrites()

    // Cold L1 -> resolveAsync reads from Redis without hitting DB repo.get
    router._l1.clear()
    let dbGetCalls = 0
    const origGet = router.repo.get.bind(router.repo)
    router.repo.get = (...a) => {
      dbGetCalls += 1
      return origGet(...a)
    }
    const resolved = await router.resolveAsync(key)
    assert.equal(resolved?.accountId, 'acc-1')
    assert.equal(resolved?.vmId, 'vm-01')
    assert.equal(dbGetCalls, 0, 'resolveAsync must hit Redis sticky before DB')

    // latestParentPoolKey must never call repo.all() full-table scan
    let repoAllCalls = 0
    const origAll = router.repo.all.bind(router.repo)
    router.repo.all = (...a) => {
      repoAllCalls += 1
      return origAll(...a)
    }
    router._latestByDevice.clear()
    const parentKey = router.latestParentPoolKey(
      { apiKeyRecord: { id: 'key_1' } },
      { platform: 'anthropic', deviceId: 'dev-xyz' },
    )
    assert.equal(parentKey, key)
    assert.equal(repoAllCalls, 0, 'latestParentPoolKey must use indexed SQL query, not repo.all()')

    // unbind immediately deletes Redis sticky key
    router.unbind(key)
    flushWrites()
    assert.equal(await router.resolveAsync(key), null)
    assert.ok(mock.ops.some((op) => op.cmd === 'del'))
  })
})

test('AccountQuota eliminates snapshot() N+1 queries, throttles resetGenerations(), and deduplicates steady-state window writes', (t) => {
  const { dir, db } = makeTmpDb('kin-quota-opt-')
  t.after(() => {
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const runtimeRepo = new AccountRuntimeRepo(db)
  const quota = new AccountQuota({ db, config: {} })
  quota.attachRuntimeRepo(runtimeRepo)

  const resetIso = new Date(Date.now() + 3 * 3600_000).toISOString()
  for (let i = 1; i <= 12; i += 1) {
    const accId = `acc-${i}`
    quota.ensure({ account_id: accId, vm_id: `vm-${i}` })
    quota.ingestHeaders(accId, {
      'anthropic-ratelimit-unified-5h-utilization': '0.2',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-reset': resetIso,
    })
  }

  // 1. snapshot() must perform 0 per-account N+1 calls
  let rtGetCalls = 0
  let recentAllocCalls = 0
  const origRtGet = runtimeRepo.get.bind(runtimeRepo)
  const origRecent = quota.repo.recentAllocations.bind(quota.repo)
  runtimeRepo.get = (...a) => {
    rtGetCalls += 1
    return origRtGet(...a)
  }
  quota.repo.recentAllocations = (...a) => {
    recentAllocCalls += 1
    return origRecent(...a)
  }

  const snap = quota.snapshot()
  assert.equal(snap.accounts.length, 12)
  assert.equal(rtGetCalls, 0, 'snapshot() must not call runtimeRepo.get() in N+1 loop')
  assert.equal(recentAllocCalls, 0, 'snapshot() must not call recentAllocations() in N+1 loop')
  assert.ok(snap.accounts.every((a) => a.recent_allocations.length === 1))

  // 2. resetGenerations() is throttled and invalidated immediately on recordQuotaReset()
  let repoGetCalls = 0
  const origRepoGet = quota.repo.get.bind(quota.repo)
  quota.repo.get = (...a) => {
    repoGetCalls += 1
    return origRepoGet(...a)
  }
  const g1 = quota.resetGenerations('acc-1')
  const g2 = quota.resetGenerations('acc-1')
  assert.deepEqual(g1, { '5h': 0, '7d': 0, '7d_oi': 0 })
  assert.deepEqual(g2, { '5h': 0, '7d': 0, '7d_oi': 0 })
  assert.equal(repoGetCalls, 1)

  quota.recordQuotaReset('acc-1', { cleared: ['5h'] })
  const g3 = quota.resetGenerations('acc-1')
  assert.equal(g3['5h'], 1)

  // 3. Steady-state identical session window writes are deduplicated for real DB-backed runtimeRepo
  let updateWinCalls = 0
  const origUpdateWin = runtimeRepo.updateWindow.bind(runtimeRepo)
  runtimeRepo.updateWindow = (...a) => {
    updateWinCalls += 1
    return origUpdateWin(...a)
  }
  const steadyHeaders = {
    'anthropic-ratelimit-unified-5h-utilization': '0.35',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-reset': resetIso,
  }
  quota.ingestHeaders('acc-2', steadyHeaders)
  quota.ingestHeaders('acc-2', steadyHeaders)
  assert.equal(updateWinCalls, 0, 'unchanged 5h window already persisted must skip redundant runtimeRepo.updateWindow')
})

test('RateLimitService integrates Redis checkAndIncrRpm with local Fail-Open fallback and skips redundant session window writes', async (t) => {
  const { dir, db } = makeTmpDb('kin-rl-opt-')
  t.after(() => {
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // 1. Fail-Open local Map RPM without Redis
  await closeCacheRuntime()
  await initCacheRuntime({ redisConfig: null })
  const runtimeRepo = new AccountRuntimeRepo(db)
  const svc = new RateLimitService({ runtimeRepo })
  assert.equal((await svc.checkRpmAsync('acc', 'a1', 2)).allowed, true)
  assert.equal((await svc.checkRpmAsync('acc', 'a1', 2)).allowed, true)
  assert.equal((await svc.checkRpmAsync('acc', 'a1', 2)).allowed, false)

  // 2. Redis-shared checkAndIncrRpm when Redis is connected
  await withMockRedis(async (_rt, mock) => {
    const r1 = await svc.checkRpmAsync('acc', 'a2', 1)
    const r2 = await svc.checkRpmAsync('acc', 'a2', 1)
    assert.equal(r1.allowed, true)
    assert.equal(r2.allowed, false)
    assert.ok(mock.ops.some((op) => op.cmd === 'incr'))
  })

  // 3. Deduplicate redundant updateSessionWindow writes on real DB-backed runtimeRepo
  let winWrites = 0
  const origUpdate = runtimeRepo.updateWindow.bind(runtimeRepo)
  runtimeRepo.updateWindow = (...a) => {
    winWrites += 1
    return origUpdate(...a)
  }
  const resetIso = new Date(Date.now() + 2 * 3600_000).toISOString()
  const hdrs = {
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-reset': resetIso,
  }
  svc.updateSessionWindow({ accountId: 'acc-rl', vmId: 'vm-1', headers: hdrs })
  svc.updateSessionWindow({ accountId: 'acc-rl', vmId: 'vm-1', headers: hdrs })
  assert.equal(winWrites, 1, 'identical steady-state updateSessionWindow should write once within quiet window')
})

test('PoolScheduler suppresses redundant 5s heartbeat writes within 15s quiet window and flushes immediately on change', async () => {
  const writes = []
  const runtimeRepo = {
    writeHeartbeat: async (u) => {
      writes.push(u)
    },
  }
  const scheduler = new PoolScheduler({ runtimeRepo, config: { heartbeat_quiet_window_ms: 15_000 } })
  const t0 = 1_700_000_000_000
  const baseUpdate = {
    account_id: 'acc-hb',
    vm_id: 'vm-01',
    status: 'ready',
    worker_heartbeat_at: t0,
    worker_status: { ok: true, engine: 'rust', worker_version: '1.0', credential: { has_access: true, generation: 1 } },
    credential_generation: 1,
    refresh_status: 'fresh',
  }

  scheduler.healthWrites.set('acc-hb', { ...baseUpdate, worker_heartbeat_at: t0 })
  await scheduler.flushHealthWrites()
  assert.equal(writes.length, 1)

  // Identical payload 5s later -> suppressed
  scheduler.healthWrites.set('acc-hb', { ...baseUpdate, worker_heartbeat_at: t0 + 5_000 })
  await scheduler.flushHealthWrites()
  assert.equal(writes.length, 1, 'unchanged heartbeat within 15s quiet window must be skipped')

  // Status changed at +10s -> flushed immediately
  scheduler.healthWrites.set('acc-hb', { ...baseUpdate, status: 'busy', worker_heartbeat_at: t0 + 10_000 })
  await scheduler.flushHealthWrites()
  assert.equal(writes.length, 2, 'substantive status change must flush immediately')

  // Same payload past quiet window (+26s > +10s + 15s) -> flushed
  scheduler.healthWrites.set('acc-hb', { ...baseUpdate, status: 'busy', worker_heartbeat_at: t0 + 26_000 })
  await scheduler.flushHealthWrites()
  assert.equal(writes.length, 3, 'heartbeat past 15s quiet window must flush')
})

test('FailoverRunner emits non-blocking requestLog.updatePhase transitions (routing -> retrying -> streaming)', async () => {
  const phases = []
  const fakeLog = {
    updatePhase: (reqId, patch) => {
      phases.push({ reqId, ...patch })
    },
  }
  let leaseSeq = 0
  const fakeRuntime = {
    acquireNode: async () => ({
      lease_id: `lease-${++leaseSeq}`,
      selected_node: { node_key: 'claude_vm:vm-a', node_id: 'vm-a' },
      resolved_pool_id: 'pool-1',
    }),
    switchNode: async () => ({
      lease_id: `lease-${++leaseSeq}`,
      selected_node: { node_key: 'claude_vm:vm-b', node_id: 'vm-b' },
      resolved_pool_id: 'pool-1',
    }),
    commitLease: async () => ({}),
    releaseLease: async () => ({}),
  }
  const runner = new FailoverRunner({
    scheduler: null,
    schedulerRuntime: fakeRuntime,
    requestLog: fakeLog,
    config: { max_same_account_retries: 0, max_account_switches: 2, total_retry_deadline_ms: 5000 },
  })

  let attempt = 0
  const res = await runner.run({
    requestId: 'req-phase-1',
    model: 'claude-sonnet-4-6',
    canonicalBody: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
    callAttempt: async ({ candidate, onCommit }) => {
      attempt += 1
      if (attempt === 1) {
        return {
          ok: false,
          status: 500,
          committed: false,
          body: { type: 'error', error: { type: 'api_error', code: 'overloaded', message: 'fail' } },
        }
      }
      onCommit()
      return {
        ok: true,
        status: 200,
        committed: true,
        terminalState: 'verified',
        body: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }
    },
  })

  assert.equal(res.ok, true)
  assert.deepEqual(
    phases.map((p) => p.phase),
    ['routing', 'retrying', 'streaming'],
  )
  assert.equal(phases[0].vm_id, 'vm-a')
  assert.equal(phases[1].vm_id, 'vm-b')
  assert.equal(phases[1].attempt_count, 2)
  assert.equal(phases[2].vm_id, 'vm-b')
  assert.equal(typeof phases[2].ttft_ms, 'number')
  assert.equal(
    phases.every((p) => p.active_provider == null),
    true,
    'OAuth VM phases must not pass literal active_provider="claude" that shadows VM names in UI',
  )
})
