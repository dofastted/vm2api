import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import * as panel from '../../src/lib/admin/panel-api.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { createSchedulerPoolsHandler } from '../../src/lib/admin/scheduler-pools-routes.mjs'
import { MultiTierCacheClient } from '../../src/lib/cache/cache-client.mjs'
import { DashboardCache } from '../../src/lib/cache/dashboard-cache.mjs'
import { getCacheRuntime } from '../../src/lib/cache/index.mjs'
import { closeDatabase, createDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { snapshotDatabaseMetricsAsync } from '../../src/lib/db/database-metrics.mjs'
import { runDashboardAggregation } from '../../src/lib/db/pg/dashboard-aggregator.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { StatisticsRepo } from '../../src/lib/db/repos/statistics-repo.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'

function makeReq(method, urlPath, { body = null, headers = {}, auth = {} } = {}) {
  const chunks = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = urlPath
  req.headers = { 'content-type': 'application/json', ...headers }
  req._testAuth = auth
  return req
}

function makeRes() {
  const headers = {}
  return {
    statusCode: 200,
    headers,
    body: null,
    ended: false,
    setHeader(k, v) {
      headers[String(k).toLowerCase()] = v
    },
    getHeader(k) {
      return headers[String(k).toLowerCase()]
    },
    writeHead(status, extra = {}) {
      this.statusCode = status
      for (const [k, v] of Object.entries(extra || {})) {
        headers[String(k).toLowerCase()] = v
      }
    },
    end(chunk) {
      this.ended = true
      if (chunk !== undefined) this.rawBody = chunk
    },
  }
}

test('dashboard-aggregator: acquires Redis leader lock, skips when busy, releases in finally and invalidates namespaces', async () => {
  let connectCount = 0
  const queries = []
  const fakePool = {
    async connect() {
      connectCount += 1
      return {
        async query(sql) {
          const text = String(sql)
          queries.push(text)
          if (/pg_try_advisory_lock/.test(text)) return { rows: [{ locked: true }] }
          if (/SELECT last_aggregated_at/.test(text)) {
            return { rows: [{ last_aggregated_at: '2026-06-15T00:00:00.000Z', last_aggregated_id: 'log-1' }] }
          }
          if (/ORDER BY created_at DESC, id DESC LIMIT 1/.test(text)) {
            return { rows: [{ created_at: '2026-06-15T12:00:00.000Z', id: 'log-99' }] }
          }
          return { rows: [], rowCount: 1 }
        },
        release() {},
      }
    },
  }

  // Case 1: leader lock busy -> skip without opening PG connection
  const busyRuntime = {
    dashboard: {
      async acquireLeaderLock() {
        return { acquired: false, token: null }
      },
      async releaseLeaderLock() {
        throw new Error('should not release unacquired lock')
      },
      async invalidateNamespaces() {
        throw new Error('should not invalidate when skipped')
      },
    },
  }
  const skipped = await runDashboardAggregation(fakePool, { cacheRuntime: busyRuntime })
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.reason, 'leader_lock_busy')
  assert.equal(connectCount, 0)

  // Case 2: acquired -> executes aggregation, invalidates stats/stats-filtered/overview, releases lock
  let released = 0
  const invalidated = []
  const okRuntime = {
    dashboard: {
      async acquireLeaderLock(name, ttlMs) {
        assert.equal(name, 'dashboard-agg')
        assert.equal(ttlMs, 300_000)
        return { acquired: true, token: 'tok-1' }
      },
      async releaseLeaderLock(name, handle) {
        assert.equal(name, 'dashboard-agg')
        assert.equal(handle.token, 'tok-1')
        released += 1
      },
      async invalidateNamespaces(ns) {
        invalidated.push(...ns)
      },
    },
  }
  const res = await runDashboardAggregation(fakePool, { cacheRuntime: okRuntime })
  assert.equal(res.skipped, false)
  assert.equal(connectCount, 1)
  assert.equal(released, 1)
  assert.deepEqual(invalidated, ['stats', 'stats-filtered', 'overview'])

  // Case 3: error during PG query still releases lock in finally
  let errReleased = 0
  const errPool = {
    async connect() {
      return {
        async query(sql) {
          const text = String(sql)
          if (/pg_try_advisory_lock/.test(text)) return { rows: [{ locked: true }] }
          if (/SELECT last_aggregated_at/.test(text)) {
            return { rows: [{ last_aggregated_at: '2026-06-15T00:00:00.000Z', last_aggregated_id: 'log-1' }] }
          }
          if (/ORDER BY created_at DESC, id DESC LIMIT 1/.test(text)) {
            return { rows: [{ created_at: '2026-06-15T12:00:00.000Z', id: 'log-99' }] }
          }
          if (/BEGIN|ROLLBACK|pg_advisory_unlock/.test(text)) return { rows: [] }
          throw new Error('pg_boom')
        },
        release() {},
      }
    },
  }
  const errRuntime = {
    dashboard: {
      async acquireLeaderLock() {
        return { acquired: true, token: 'tok-err' }
      },
      async releaseLeaderLock() {
        errReleased += 1
      },
      async invalidateNamespaces() {},
    },
  }
  await assert.rejects(() => runDashboardAggregation(errPool, { cacheRuntime: errRuntime }), /pg_boom/)
  assert.equal(errReleased, 1)
})

test('StatisticsRepo PG pre-agg: reads usage_dashboard_* + parameterized tail without CROSS JOIN and falls back for filtered/non-hour tz', () => {
  const executed = []
  const now = Date.parse('2026-06-15T12:30:00.000Z')
  const watermarkIso = '2026-06-15T10:00:00.000Z'

  const mockPgDb = {
    engine: 'postgres',
    prepare(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      const handle = (params) => {
        executed.push({ sql: normalized, params })
        if (normalized.includes('FROM usage_dashboard_aggregation_watermark')) {
          return [{ last_aggregated_at: watermarkIso }]
        }
        if (normalized.includes('SELECT COUNT(*) AS c FROM (') && normalized.includes('usage_dashboard_daily_users')) {
          return [{ c: 4 }]
        }
        if (normalized.includes('FROM usage_dashboard_daily')) {
          return [
            {
              total_requests: 100,
              error_requests: 2,
              input_tokens: 1000,
              output_tokens: 500,
              cache_read_tokens: 200,
              cache_creation_tokens: 100,
              total_cost: 5.5,
              actual_cost: 6.0,
              total_duration_ms: 10000,
              duration_count: 100,
            },
          ]
        }
        if (normalized.includes('FROM usage_dashboard_hourly_models')) {
          if (normalized.includes("to_char(bucket_start AT TIME ZONE 'UTC'")) {
            return [
              {
                sid: 'claude-sonnet-4-5',
                slot: '2026-06-15T09:00',
                requests: 10,
                cost: 0.5,
                tokens: 180,
              },
            ]
          }
          return [
            {
              sid: 'claude-sonnet-4-5',
              requests: 10,
              errors: 1,
              input_tokens: 100,
              output_tokens: 50,
              cache_read_tokens: 20,
              cache_creation_tokens: 10,
              cost: 0.5,
              actual_cost: 0.6,
            },
          ]
        }
        if (normalized.includes('FROM usage_dashboard_hourly')) {
          return [
            {
              total_requests: 20,
              error_requests: 1,
              input_tokens: 200,
              output_tokens: 100,
              cache_read_tokens: 40,
              cache_creation_tokens: 20,
              total_cost: 1.0,
              actual_cost: 1.2,
              total_duration_ms: 2000,
              duration_count: 20,
            },
          ]
        }
        if (normalized.includes('FROM usage_logs')) {
          if (normalized.includes('GROUP BY sid, slot')) {
            return [
              {
                sid: 'claude-sonnet-4-5',
                slot: '2026-06-15T11:00',
                requests: 1,
                cost: 0.25,
                tokens: 90,
              },
            ]
          }
          if (normalized.includes("GROUP BY COALESCE(model, '')")) {
            return [
              {
                sid: 'claude-sonnet-4-5',
                requests: 5,
                success: 5,
                errors: 0,
                input_tokens: 50,
                output_tokens: 25,
                cache_read_tokens: 10,
                cache_creation_tokens: 5,
                cache_creation_5m_tokens: 0,
                cache_creation_1h_tokens: 0,
                prompt_tokens: 65,
                cost: 0.25,
                actual_cost: 0.3,
                total_duration_ms: 500,
                duration_count: 5,
                total_ttft_ms: 0,
                ttft_count: 0,
              },
            ]
          }
          return [
            {
              requests: 5,
              errors: 0,
              cost: 0.25,
              actual_cost: 0.3,
              input_tokens: 50,
              output_tokens: 25,
              cache_read_tokens: 10,
              cache_creation_tokens: 5,
              cache_creation_5m_tokens: 0,
              cache_creation_1h_tokens: 0,
              prompt_tokens: 65,
              total_duration_ms: 500,
              duration_count: 5,
              total_ttft_ms: 0,
              ttft_count: 0,
              avg_duration_ms: 100,
              avg_ttft_ms: null,
            },
          ]
        }
        return []
      }
      return {
        get: (...params) => handle(params)[0] || null,
        all: (...params) => handle(params),
      }
    },
  }

  const repo = new StatisticsRepo(mockPgDb)
  const stat = repo.statistics({ range: '7days', dimension: 'model', tz: 'UTC', now })
  assert.equal(stat.totals.requests, 125)
  assert.equal(stat.totals.errors, 3)
  assert.equal(stat.totals.cost, 6.75)
  assert.equal(stat.totals.actualCost, 7.5)
  assert.equal(stat.series.length, 1)
  assert.equal(stat.series[0].id, 'claude-sonnet-4-5')
  assert.equal(stat.seriesTotals.s0.requests, 11)
  assert.equal(
    executed.some((q) => q.sql.includes('usage_dashboard_daily')),
    true,
  )
  assert.equal(
    executed.some((q) => q.sql.includes('usage_dashboard_hourly_models')),
    true,
  )
  assert.equal(
    executed.some((q) => /CROSS\s+JOIN/i.test(q.sql)),
    false,
    'must never CROSS JOIN watermark table in CTE/SQL',
  )

  const lb = repo.leaderboard({ range: '7days', scope: 'model', tz: 'UTC', now })
  assert.equal(lb.entries.length, 1)
  assert.equal(lb.entries[0].id, 'claude-sonnet-4-5')
  assert.equal(lb.entries[0].totalRequests, 15)
  assert.equal(lb.entries[0].totalCost, 0.75)

  executed.length = 0
  const activeUsers = repo.activeUsersCount({
    since: '2026-06-13T00:00:00.000Z',
    until: '2026-06-15T12:30:00.000Z',
  })
  assert.equal(activeUsers, 4)
  assert.equal(
    executed.some(
      (q) =>
        q.sql.includes('usage_dashboard_daily_users') &&
        q.sql.includes('usage_dashboard_hourly_users') &&
        q.sql.includes('FROM usage_logs'),
    ),
    true,
  )

  // Non-hour timezone (Asia/Kolkata = UTC+5:30) or owner_user_id must bypass pre-agg model series safely
  executed.length = 0
  repo.statistics({ range: 'today', dimension: 'model', tz: 'Asia/Kolkata', now })
  assert.equal(
    executed.some((q) => q.sql.includes('usage_dashboard_hourly_models')),
    false,
  )

  executed.length = 0
  repo.statistics({ range: '7days', dimension: 'model', tz: 'UTC', owner_user_id: 'u-1', now })
  assert.equal(
    executed.some((q) => q.sql.includes('usage_dashboard_daily')),
    false,
  )
  assert.equal(
    executed.some((q) => q.sql.includes('usage_dashboard_hourly_models')),
    false,
  )
})

test('UsersRepo & PanelUserStore: caches getByUsername/getById and invalidates on write/rename/balance/remove', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-users-cache-'))
  const db = createDatabase({ dbPath: path.join(dir, 'app.db') })
  try {
    const repo = new UsersRepo(db)
    const store = new PanelUserStore({ db })
    const created = store.create({ username: 'alice', password: 'secret-password-1', role: 'user' })
    // Clear L1 entry warmed by insert() so we can measure cold miss -> warm hit on both keys
    repo.invalidateUser({ id: created.id, username: 'alice' }, { notifyTable: false })

    let byNameCalls = 0
    let byIdCalls = 0
    const origByName = repo._getByName.get.bind(repo._getByName)
    const origById = repo._get.get.bind(repo._get)
    repo._getByName.get = (...args) => {
      byNameCalls += 1
      return origByName(...args)
    }
    repo._get.get = (...args) => {
      byIdCalls += 1
      return origById(...args)
    }

    // First lookup misses L1 and populates cache; subsequent sync/async lookups hit L1 with 0 DB calls
    assert.equal(repo.getByUsername('alice')?.id, created.id)
    assert.equal(repo.getByUsername('alice')?.id, created.id)
    assert.equal((await repo.getByUsernameAsync('alice'))?.id, created.id)
    assert.equal(byNameCalls, 1)

    assert.equal(repo.getById(created.id)?.username, 'alice')
    assert.equal(repo.getById(created.id)?.username, 'alice')
    assert.equal((await repo.getByIdAsync(created.id))?.username, 'alice')
    assert.equal(byIdCalls, 1)

    // Balance mutation invalidates cache immediately
    repo.addBalance(created.id, 12.5)
    const afterBal = repo.getById(created.id)
    assert.equal(afterBal.balance, 12.5)
    assert.equal(byIdCalls, 2)

    // Username rename invalidates BOTH old and new username keys
    repo.update({ ...afterBal, username: 'alice2', role: 'admin' })
    assert.equal(repo.getByUsername('alice'), null)
    const renamed = repo.getByUsername('alice2')
    assert.equal(renamed?.id, created.id)
    assert.equal(renamed?.role, 'admin')

    // Removal invalidates cache
    repo.remove(created.id)
    assert.equal(repo.getById(created.id), null)
    assert.equal(repo.getByUsername('alice2'), null)
  } finally {
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AccountRuntimeRepo.getMany matches get() and panel-api buildVmList/buildDashboard eliminates N+1 runtime queries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-runtime-batch-'))
  const vmsDir = path.join(dir, 'vms')
  fs.mkdirSync(vmsDir, { recursive: true })
  const db = createDatabase({ dbPath: path.join(dir, 'app.db') })
  try {
    const repo = new AccountRuntimeRepo(db)
    db.prepare(
      `INSERT INTO accounts (id, name, platform, type, status, created_at, updated_at)
       VALUES (?, ?, 'claude', 'oauth', 'active', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
    ).run('vm-1', 'Slot 1')
    db.prepare(
      `INSERT INTO accounts (id, name, platform, type, status, created_at, updated_at)
       VALUES (?, ?, 'claude', 'oauth', 'active', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
    ).run('vm-2', 'Slot 2')
    repo.upsert({ account_id: 'vm-1', vm_id: 'vm-1', status: 'ready', priority: 10, weight: 2 })
    repo.writeHeartbeat({
      account_id: 'vm-only-rt',
      vm_id: 'vm-only-rt',
      status: 'ready',
      worker_heartbeat_at: Date.now(),
      worker_status: { ok: true },
      credential_generation: 3,
      refresh_status: 'ok',
    })

    const batch = repo.getMany(['vm-1', 'vm-2', 'vm-only-rt', 'vm-missing'])
    assert.equal(batch.size, 3)
    assert.deepEqual(batch.get('vm-1'), repo.get('vm-1'))
    assert.deepEqual(batch.get('vm-2'), repo.get('vm-2'))
    assert.deepEqual(batch.get('vm-only-rt'), repo.get('vm-only-rt'))
    assert.equal(batch.has('vm-missing'), false)

    // Write 4 VMs and verify buildVmList + buildDashboard call getMany() once and get() 0 times
    for (let i = 1; i <= 4; i += 1) {
      fs.writeFileSync(
        path.join(vmsDir, `vm-${i}.json`),
        JSON.stringify({ id: `vm-${i}`, name: `Slot ${i}`, status: 'running', platform: 'anthropic' }),
      )
    }
    let getCalls = 0
    let getManyCalls = 0
    const spyRuntimeRepo = {
      get(id) {
        getCalls += 1
        return repo.get(id)
      },
      getMany(ids) {
        getManyCalls += 1
        return repo.getMany(ids)
      },
    }
    const accountQuota = {
      runtimeRepo: spyRuntimeRepo,
      snapshot: () => ({ accounts: [] }),
    }
    const vmList = await panel.buildVmList({
      cfg: { paths: { project: dir, data: dir } },
      accountQuota,
      routingConfig: {},
      role: 'admin',
    })
    assert.equal(vmList.ok, true)
    assert.equal(vmList.data.items.length, 4)
    assert.equal(getCalls, 0, 'buildVmList must not call runtimeRepo.get in a loop')
    assert.equal(getManyCalls, 1, 'buildVmList should prefetch runtime in one batch call')

    const dash = await panel.buildDashboard({
      cfg: { paths: { project: dir, data: dir } },
      accountQuota,
      stickyRouter: { stats: () => ({}) },
      routingConfig: {},
    })
    assert.equal(dash.ok, true)
    assert.equal(getCalls, 0, 'buildDashboard must not call runtimeRepo.get in a loop')
    assert.equal(getManyCalls, 2)
  } finally {
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('UsageLogsRepo: billingStatsAsync/ownerBillingAsync parity, singleflight SWR, and cleanup/reprice invalidation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-billing-opt-'))
  const db = createDatabase({ dbPath: path.join(dir, 'app.db') })
  try {
    const repo = new UsageLogsRepo(db)
    const nowIso = new Date().toISOString()
    const oldIso = new Date(Date.now() - 20 * 86400_000).toISOString()
    repo.insertSummary({
      request_id: 'req-1',
      created_at: nowIso,
      vm_id: 'vm-1',
      account_id: 'acc-1',
      user_id: 'u-1',
      api_key_id: 'k-1',
      model: 'claude-sonnet-4-5',
      status: 200,
      input_tokens: 1000,
      output_tokens: 500,
      total_cost: 0.015,
      actual_cost: 0.02,
      pricing_model: 'claude-sonnet-4-5',
    })
    repo.insertSummary({
      request_id: 'req-old',
      created_at: oldIso,
      vm_id: 'vm-2',
      account_id: 'acc-2',
      user_id: 'u-2',
      api_key_id: 'k-2',
      model: 'claude-sonnet-4-5',
      status: 200,
      input_tokens: 2000,
      output_tokens: 1000,
      total_cost: 0.03,
      actual_cost: 0.04,
      pricing_model: 'claude-sonnet-4-5',
    })

    const syncStats = repo.billingStats()
    let computeCount = 0
    const origCompute = repo._computeBillingStatsAsync.bind(repo)
    repo._computeBillingStatsAsync = async (...args) => {
      computeCount += 1
      return origCompute(...args)
    }

    const [a1, a2] = await Promise.all([repo.billingStatsAsync(), repo.billingStatsAsync()])
    assert.equal(computeCount, 1, 'concurrent billingStatsAsync calls should coalesce via singleflight')
    assert.equal(a1.total.requests, syncStats.total.requests)
    assert.equal(a1.total.total_cost, syncStats.total.total_cost)
    assert.equal(a2.accounts.length, syncStats.accounts.length)

    // ownerBillingAsync parity and tenant isolation
    const obU1Sync = repo.ownerBilling({ ownerUserId: 'u-1', groupBy: 'vm' })
    const obU1Async = await repo.ownerBillingAsync({ ownerUserId: 'u-1', groupBy: 'vm' })
    const obU2Async = await repo.ownerBillingAsync({ ownerUserId: 'u-2', groupBy: 'vm' })
    assert.deepEqual(obU1Async, obU1Sync)
    assert.equal(obU1Async.totals.requests, 1)
    assert.equal(obU2Async.totals.requests, 1)
    assert.equal(obU1Async.items[0].vm_id, 'vm-1')
    assert.equal(obU2Async.items[0].vm_id, 'vm-2')

    // cleanup prunes old row and invalidates billing cache
    const pruned = repo.cleanup({ retainDays: 7 })
    assert.equal(pruned.usage_logs, 1)
    const afterCleanup = await repo.billingStatsAsync()
    assert.equal(computeCount, 2, 'cleanup must invalidate billing SWR cache')
    assert.equal(afterCleanup.total.requests, 1)

    // repriceRange invalidates billing cache
    repo.repriceRange({
      since: new Date(Date.now() - 86400_000).toISOString(),
      until: new Date(Date.now() + 60_000).toISOString(),
    })
    await repo.billingStatsAsync()
    assert.equal(computeCount, 3, 'repriceRange must invalidate billing SWR cache')
  } finally {
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('database-metrics: SWR + singleflight coalesces concurrent snapshots and honors bypass', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-db-metrics-opt-'))
  const dbPath = path.join(dir, 'app.db')
  const db = createDatabase({ dbPath })
  const client = new MultiTierCacheClient({ cacheConfig: { enabled: true } })
  const cacheRuntime = {
    client,
    dashboard: new DashboardCache(client),
    close: () => client.close(),
  }
  try {
    let calls = 0
    const origGetOrSetSWR = cacheRuntime.dashboard.getOrSetSWR.bind(cacheRuntime.dashboard)
    cacheRuntime.dashboard.getOrSetSWR = (ns, key, loader, opts) =>
      origGetOrSetSWR(
        ns,
        key,
        async () => {
          calls += 1
          return loader()
        },
        opts,
      )

    const [m1, m2] = await Promise.all([
      snapshotDatabaseMetricsAsync({ db, dbPath, cacheRuntime }),
      snapshotDatabaseMetricsAsync({ db, dbPath, cacheRuntime }),
    ])
    assert.equal(calls, 1)
    assert.equal(m1.database.engine, 'sqlite')
    assert.equal(m2.database.engine, 'sqlite')

    const m3 = await snapshotDatabaseMetricsAsync({ db, dbPath, cacheRuntime })
    assert.equal(calls, 1)
    assert.equal(m3.sampled_at, m1.sampled_at)

    await snapshotDatabaseMetricsAsync({ db, dbPath, cacheRuntime, bypass: true })
    assert.equal(calls, 2)
  } finally {
    await cacheRuntime.close()
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('panel-routes & scheduler-pools-routes: ETag/304, single api-keys scan, tenant ACL cache isolation, stats-filtered routing, and write invalidation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-redis-opt-'))
  const vmsDir = path.join(dir, 'vms')
  fs.mkdirSync(vmsDir, { recursive: true })
  const dbPath = path.join(dir, 'app.db')
  closeDatabase()
  const db = openDatabase({ dbPath })
  try {
    // Seed 2 VMs owned by u-a and u-b, plus 1 platform VM
    fs.writeFileSync(
      path.join(vmsDir, 'vm-a.json'),
      JSON.stringify({ id: 'vm-a', name: 'VM A', status: 'running', platform: 'anthropic', owner_user_id: 'u-a' }),
    )
    fs.writeFileSync(
      path.join(vmsDir, 'vm-b.json'),
      JSON.stringify({ id: 'vm-b', name: 'VM B', status: 'running', platform: 'anthropic', owner_user_id: 'u-b' }),
    )
    fs.writeFileSync(
      path.join(vmsDir, 'vm-plat.json'),
      JSON.stringify({ id: 'vm-plat', name: 'VM Plat', status: 'running', platform: 'anthropic' }),
    )

    const panelUsers = new PanelUserStore({ db })
    const apiKeyStore = new ApiKeyStore({ dataDir: dir, db })
    const requestLog = new RequestLogStore({ dataDir: dir, db })

    // Create keys for u-a, u-b, and platform master
    apiKeyStore.create({ name: 'key-a', user_id: 'u-a', category: 'oauth', group_type: 'all' })
    apiKeyStore.create({ name: 'key-b', user_id: 'u-b', category: 'oauth', group_type: 'all' })
    apiKeyStore.create({ name: 'key-master', user_id: null, category: 'oauth', group_type: 'all' })

    // Seed usage logs for u-a and u-b
    const nowIso = new Date().toISOString()
    requestLog.repo.insertSummary({
      request_id: 'r-a-1',
      created_at: nowIso,
      vm_id: 'vm-a',
      account_id: 'vm-a',
      user_id: 'u-a',
      api_key_id: 'ka',
      model: 'claude-sonnet-4-5',
      status: 200,
      input_tokens: 100,
      output_tokens: 50,
      total_cost: 0.01,
      actual_cost: 0.01,
      pricing_model: 'claude-sonnet-4-5',
    })
    requestLog.repo.insertSummary({
      request_id: 'r-b-1',
      created_at: nowIso,
      vm_id: 'vm-b',
      account_id: 'vm-b',
      user_id: 'u-b',
      api_key_id: 'kb',
      model: 'claude-opus-4-1',
      status: 200,
      input_tokens: 500,
      output_tokens: 250,
      total_cost: 0.09,
      actual_cost: 0.09,
      pricing_model: 'claude-opus-4-1',
    })

    const handler = createPanelHandler({
      cfg: { paths: { project: dir, data: dir }, limits: { max_body_bytes: 1024 * 1024 } },
      getDb: () => db,
      apiKeyStore,
      panelUsers,
      requestLog,
      stickyRouter: { stats: () => ({}) },
      accountQuota: { snapshot: () => ({ accounts: [] }) },
      routingConfig: { concurrency: { default_key_concurrency: 20 } },
      readBody,
      requireAuth(req) {
        const a = req._testAuth || { role: 'admin', user: 'admin', userId: 'u-admin', apiKeyKind: 'master' }
        req.panelRole = a.role
        req.panelUser = a.user
        req.panelUserId = a.userId ?? null
        req.apiKeyKind = a.apiKeyKind ?? null
        return true
      },
      json(res, status, payload) {
        res.statusCode = status
        res.body = payload
        return true
      },
    })

    const call = async (method, urlPath, { body = null, headers = {}, auth = {} } = {}) => {
      const req = makeReq(method, urlPath, { body, headers, auth })
      const res = makeRes()
      const u = new URL(`http://localhost${urlPath}`)
      await handler(req, res, u)
      return res
    }

    const adminAuth = { role: 'admin', user: 'admin', userId: null, apiKeyKind: 'master' }
    const userAAuth = { role: 'user', user: 'userA', userId: 'u-a', apiKeyKind: null }
    const userBAuth = { role: 'user', user: 'userB', userId: 'u-b', apiKeyKind: null }

    // 1. GET /api/panel/api-keys: single repo.list() scan (no double scan) + SWR hit + write invalidation
    let repoListCalls = 0
    const origRepoList = apiKeyStore.repo.list.bind(apiKeyStore.repo)
    apiKeyStore.repo.list = (...args) => {
      repoListCalls += 1
      return origRepoList(...args)
    }

    const kAdmin1 = await call('GET', '/api/panel/api-keys', { auth: adminAuth })
    assert.equal(kAdmin1.statusCode, 200)
    assert.equal(repoListCalls, 1, 'GET /api/panel/api-keys must scan repo.list() once, not twice')
    assert.deepEqual(
      kAdmin1.body.keys.map((k) => k.name),
      ['key-master'],
    )
    assert.ok(kAdmin1.getHeader('etag'))

    // Second call hits SWR cache (repoListCalls stays 1) and honors If-None-Match -> 304
    const kAdmin304 = await call('GET', '/api/panel/api-keys', {
      auth: adminAuth,
      headers: { 'if-none-match': kAdmin1.getHeader('etag') },
    })
    assert.equal(kAdmin304.statusCode, 304)
    assert.equal(repoListCalls, 1)

    // Tenant ACL cache isolation: user A and user B see ONLY their own keys
    const kUserA = await call('GET', '/api/panel/api-keys', { auth: userAAuth })
    const kUserB = await call('GET', '/api/panel/api-keys', { auth: userBAuth })
    assert.deepEqual(
      kUserA.body.keys.map((k) => k.name),
      ['key-a'],
    )
    assert.deepEqual(
      kUserB.body.keys.map((k) => k.name),
      ['key-b'],
    )

    // POST /api/panel/api-keys invalidates cache immediately
    const createdKey = await call('POST', '/api/panel/api-keys', {
      auth: adminAuth,
      body: { name: 'key-master-2', category: 'oauth', group_type: 'all' },
    })
    assert.equal(createdKey.statusCode, 201)
    const kAdminAfter = await call('GET', '/api/panel/api-keys', {
      auth: adminAuth,
      headers: { 'if-none-match': kAdmin1.getHeader('etag') },
    })
    assert.equal(kAdminAfter.statusCode, 200, 'stale ETag after mutation must return 200 with fresh data')
    assert.equal(kAdminAfter.body.total, 2)

    // 2. Tenant ACL cache isolation on /vms, /billing, /statistics, /usage-logs/summary
    const vmsAdmin = await call('GET', '/api/panel/vms', { auth: adminAuth })
    const vmsA = await call('GET', '/api/panel/vms', { auth: userAAuth })
    const vmsB = await call('GET', '/api/panel/vms', { auth: userBAuth })
    assert.equal(vmsAdmin.body.data.items.length, 3)
    assert.deepEqual(
      vmsA.body.data.items.map((v) => v.id),
      ['vm-a'],
    )
    assert.deepEqual(
      vmsB.body.data.items.map((v) => v.id),
      ['vm-b'],
    )
    const vms304 = await call('GET', '/api/panel/vms', {
      auth: adminAuth,
      headers: { 'if-none-match': vmsAdmin.getHeader('etag') },
    })
    assert.equal(vms304.statusCode, 304)

    const billA = await call('GET', '/api/panel/billing', { auth: userAAuth })
    const billB = await call('GET', '/api/panel/billing', { auth: userBAuth })
    assert.equal(billA.body.data.totals.cost_usd, 0.01)
    assert.equal(billB.body.data.totals.cost_usd, 0.09)

    // 3. Statistics global SWR vs high-cardinality stats-filtered SnapshotCache + ETag/304
    const dashCache = getCacheRuntime().dashboard
    const swrCalls = []
    const snapCalls = []
    const origSwr = dashCache.getOrSetSWR.bind(dashCache)
    const origSnap = dashCache.getOrLoadSnapshot.bind(dashCache)
    dashCache.getOrSetSWR = (ns, ...rest) => {
      swrCalls.push(ns)
      return origSwr(ns, ...rest)
    }
    dashCache.getOrLoadSnapshot = (ns, ...rest) => {
      snapCalls.push(ns)
      return origSnap(ns, ...rest)
    }
    try {
      const stGlobal = await call('GET', '/api/panel/statistics?range=today&dimension=model', { auth: adminAuth })
      assert.equal(stGlobal.statusCode, 200)
      assert.equal(stGlobal.body.data.totals.requests, 2)
      assert.equal(swrCalls.includes('stats'), true)

      const stFilteredA = await call('GET', '/api/panel/statistics?range=today&dimension=model', { auth: userAAuth })
      const stFilteredB = await call('GET', '/api/panel/statistics?range=today&dimension=model', { auth: userBAuth })
      assert.equal(stFilteredA.body.data.totals.requests, 1)
      assert.equal(stFilteredA.body.data.totals.cost, 0.01)
      assert.equal(stFilteredA.getHeader('x-snapshot-cache'), 'miss')
      assert.equal(stFilteredB.body.data.totals.cost, 0.09)
      assert.equal(snapCalls.includes('stats-filtered'), true)

      const stFilteredA304 = await call('GET', '/api/panel/statistics?range=today&dimension=model', {
        auth: userAAuth,
        headers: { 'if-none-match': stFilteredA.getHeader('etag') },
      })
      assert.equal(stFilteredA304.statusCode, 304)
      assert.equal(stFilteredA304.getHeader('x-snapshot-cache'), 'hit')

      // /usage-logs/summary uses in-process logs-summary snapshot cache + ETag/304 + tenant isolation
      const sumA = await call('GET', '/api/panel/usage-logs/summary', { auth: userAAuth })
      const sumB = await call('GET', '/api/panel/usage-logs/summary', { auth: userBAuth })
      assert.equal(sumA.statusCode, 200)
      assert.equal(sumA.body.data.totalRequests, 1)
      assert.equal(sumA.body.data.totalCost, 0.01)
      assert.equal(sumA.getHeader('x-snapshot-cache'), 'miss')
      assert.equal(sumB.body.data.totalCost, 0.09)
      assert.equal(snapCalls.includes('logs-summary'), true)
      const sumA304 = await call('GET', '/api/panel/usage-logs/summary', {
        auth: userAAuth,
        headers: { 'if-none-match': sumA.getHeader('etag') },
      })
      assert.equal(sumA304.statusCode, 304)
      assert.equal(sumA304.getHeader('x-snapshot-cache'), 'hit')
    } finally {
      dashCache.getOrSetSWR = origSwr
      dashCache.getOrLoadSnapshot = origSnap
    }

    // 4. GET /api/panel/pools SWR + ETag/304 + POST /api/panel/pools invalidation
    const poolsHandler = createSchedulerPoolsHandler({
      getDb: () => db,
      getVms: () => [],
      apiKeyStore,
      json: (res, status, payload) => {
        res.statusCode = status
        res.body = payload
        return true
      },
      readBody,
    })
    const callPools = async (method, urlPath, { body = null, headers = {} } = {}) => {
      const req = makeReq(method, urlPath, { body, headers, auth: adminAuth })
      req.panelRole = 'admin'
      req.panelUser = 'admin'
      const res = makeRes()
      const u = new URL(`http://localhost${urlPath}`)
      await poolsHandler(req, res, u.pathname, u)
      return res
    }

    const p1 = await callPools('GET', '/api/panel/pools')
    assert.equal(p1.statusCode, 200)
    assert.ok(p1.getHeader('etag'))
    const p304 = await callPools('GET', '/api/panel/pools', { headers: { 'if-none-match': p1.getHeader('etag') } })
    assert.equal(p304.statusCode, 304)

    const pCreate = await callPools('POST', '/api/panel/pools', {
      body: { name: 'Alpha Pool', provider_scope: 'anthropic' },
    })
    assert.equal(pCreate.statusCode, 201)
    const pAfter = await callPools('GET', '/api/panel/pools', {
      headers: { 'if-none-match': p1.getHeader('etag') },
    })
    assert.equal(pAfter.statusCode, 200)
    assert.equal(
      pAfter.body.data.pools.some((x) => x.name === 'Alpha Pool'),
      true,
    )

    // 5. GET /api/panel/dashboard & /api/panel/usage ETag/304
    const dash1 = await call('GET', '/api/panel/dashboard', { auth: adminAuth })
    assert.equal(dash1.statusCode, 200)
    const dash304 = await call('GET', '/api/panel/dashboard', {
      auth: adminAuth,
      headers: { 'if-none-match': dash1.getHeader('etag') },
    })
    assert.equal(dash304.statusCode, 304)

    const usage1 = await call('GET', '/api/panel/usage', { auth: adminAuth })
    assert.equal(usage1.statusCode, 200)
    const usage304 = await call('GET', '/api/panel/usage', {
      auth: adminAuth,
      headers: { 'if-none-match': usage1.getHeader('etag') },
    })
    assert.equal(usage304.statusCode, 304)

    // 6. ?refresh=1 forwards bypass: true all the way into billingStatsAsync
    const bypassSeen = []
    const origBillingAsync = requestLog.repo.billingStatsAsync.bind(requestLog.repo)
    requestLog.repo.billingStatsAsync = async (opts = {}) => {
      bypassSeen.push(Boolean(opts?.bypass))
      return origBillingAsync(opts)
    }
    try {
      await call('GET', '/api/panel/dashboard?refresh=1', { auth: adminAuth })
      await call('GET', '/api/panel/vms?refresh=1', { auth: adminAuth })
      await call('GET', '/api/panel/usage?refresh=1', { auth: adminAuth })
      assert.deepEqual(bypassSeen, [true, true, true])
    } finally {
      requestLog.repo.billingStatsAsync = origBillingAsync
    }

    // 7. DELETE /api/panel/refusal-session-blocks & /refusal-device-blocks immediately invalidate risk ban cache
    const cacheClient = getCacheRuntime().client
    await cacheClient.set('risk:bans:session:sess-1', { blocked: true }, { ttlMs: 15_000 })
    await cacheClient.set('risk:bans:device:dev-1', { blocked: true }, { ttlMs: 15_000 })
    assert.equal((await cacheClient.get('risk:bans:session:sess-1')).hit, true)
    assert.equal((await cacheClient.get('risk:bans:device:dev-1')).hit, true)

    const delSess = await call('DELETE', '/api/panel/refusal-session-blocks', {
      auth: adminAuth,
      body: { confirm: true },
    })
    assert.equal(delSess.statusCode, 200)
    assert.equal((await cacheClient.get('risk:bans:session:sess-1')).hit, false)
    assert.equal((await cacheClient.get('risk:bans:device:dev-1')).hit, true)

    await cacheClient.set('risk:bans:session:sess-2', { blocked: true }, { ttlMs: 15_000 })
    const delDev = await call('DELETE', '/api/panel/refusal-device-blocks', {
      auth: adminAuth,
      body: { confirm: true },
    })
    assert.equal(delDev.statusCode, 200)
    assert.equal((await cacheClient.get('risk:bans:device:dev-1')).hit, false)
    assert.equal((await cacheClient.get('risk:bans:session:sess-2')).hit, false)
  } finally {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
