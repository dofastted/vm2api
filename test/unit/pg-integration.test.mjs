/**
 * Live PostgreSQL integration test suite.
 * Runs automatically when `VM2API_TEST_PG_URL` is provided; skips cleanly in SQLite-only runs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import {
  closeDatabaseAsync,
  getDb,
  getDbEngine,
  getPgPool,
  openDatabaseAsync,
  withTransaction,
} from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { VmPoolsRepo } from '../../src/lib/db/repos/vm-pools-repo.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'
import { StatisticsRepo } from '../../src/lib/db/repos/statistics-repo.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { ThinkingOwnerStore } from '../../src/lib/pool/thinking-owner.mjs'
import { snapshotDatabaseMetricsAsync } from '../../src/lib/db/database-metrics.mjs'
import { runDashboardAggregation } from '../../src/lib/db/pg/dashboard-aggregator.mjs'
import { readAll, usagePoolEnabled, usageRead } from '../../src/lib/db/sqlite-pool.mjs'
import { enqueueWrite, flushWrites } from '../../src/lib/db/write-behind.mjs'
import { buildPgToolInvocation } from '../../src/lib/admin/backup-core.mjs'
import { MultiTierCacheClient, getCacheRuntime } from '../../src/lib/cache/index.mjs'

const PG_URL = process.env.VM2API_TEST_PG_URL || ''

async function withTestSchema(baseUrl, fn) {
  const schema = `vm2api_it_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const admin = new pg.Client({ connectionString: baseUrl })
  await admin.connect()
  await admin.query(`CREATE SCHEMA "${schema}"`)
  await admin.end()

  const u = new URL(baseUrl)
  u.searchParams.set('options', `-c search_path=${schema}`)
  const schemaUrl = u.toString()

  try {
    await fn(schemaUrl, schema)
  } finally {
    await closeDatabaseAsync()
    const cleanup = new pg.Client({ connectionString: baseUrl })
    await cleanup.connect()
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await cleanup.end()
  }
}

test('PostgreSQL end-to-end engine, repos, read pool, metrics, aggregation, and cache', { skip: !PG_URL }, async () => {
  await withTestSchema(PG_URL, async (schemaUrl) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-pg-it-'))
    try {
      await openDatabaseAsync({
        dataDir: tmpDir,
        driver: 'postgres',
        connectionString: schemaUrl,
        pooled: true,
        enableAggregator: false,
      })

      assert.equal(getDbEngine(), 'postgres')
      assert.equal(usagePoolEnabled(), true)
      const db = getDb()
      const pool = getPgPool()

      // 1. Settings + Transactions + Rollback
      const settings = new SettingsRepo(db)
      settings.set('pg_test_key', { hello: 'world' })
      assert.deepEqual(settings.get('pg_test_key'), { hello: 'world' })

      assert.throws(() => {
        withTransaction(db, () => {
          settings.set('rolled_back_key', 'should_not_exist')
          throw new Error('force rollback')
        })
      }, /force rollback/)
      assert.equal(settings.get('rolled_back_key', null), null)

      // 2. Users (case-insensitive username) + ApiKeyStore (with ApiKeyCache)
      const users = new UsersRepo(db)
      users.insert({
        id: 'u_pg_1',
        username: 'AlicePG',
        email: 'alice@example.com',
        password_hash: 'hash',
        role: 'admin',
        balance: 50,
      })
      assert.equal(users.getByUsername('alicepg')?.id, 'u_pg_1')

      const keyStore = new ApiKeyStore({ db })
      const created = keyStore.create({ name: 'pg-key', user_id: 'u_pg_1', quota: 100 })
      const auth1 = keyStore.authenticate(created.key)
      assert.equal(auth1.ok, true)
      assert.equal(auth1.record.id, created.id)
      // Second call hits L1 ApiKeyCache
      const auth2 = keyStore.authenticate(created.key)
      assert.equal(auth2.ok, true)
      assert.ok(getCacheRuntime().stats().l1.hits >= 1)

      // 3. VmPools unique constraint (PG 23505 -> vm_pool_name_taken)
      const pools = new VmPoolsRepo(db)
      pools.insert({ name: 'AlphaPool' })
      assert.throws(
        () => pools.insert({ name: 'alphapool' }),
        (e) => e.code === 'vm_pool_name_taken',
      )

      // 4. AccountRuntimeRepo (json_each + GREATEST + INSERT OR IGNORE)
      const rtRepo = new AccountRuntimeRepo(db)
      rtRepo.writeHeartbeat({
        account_id: 'acct_1',
        vm_id: 'vm_1',
        status: 'healthy',
        credential_generation: 3,
        worker_heartbeat_at: Date.now(),
        worker_status: { ok: true },
        refresh_status: 'ok',
      })
      rtRepo.writeHeartbeat({
        account_id: 'acct_1',
        vm_id: 'vm_1',
        status: 'healthy',
        credential_generation: 1,
        worker_heartbeat_at: Date.now() + 10,
        worker_status: { ok: true },
        refresh_status: 'ok',
      })
      const snaps = rtRepo.schedulingSnapshot(['acct_1'])
      assert.equal(snaps.size, 1)
      assert.equal(snaps.get('acct_1').state.credential_generation, 3)

      // 5. ThinkingOwnerStore (BIGINT created_at + json_each + INSERT OR IGNORE)
      const thinking = new ThinkingOwnerStore({ db })
      thinking.record(['sig_key_1', 'sig_key_2'], 'acct_1', Date.now())
      const owners = thinking.ownersOf(['sig_key_1', 'sig_key_2'])
      assert.equal(owners.get('sig_key_1'), 'acct_1')

      // 6. UsageLogsRepo + UsageLogsView + StatisticsRepo + off-thread pg-read-worker
      const logs = new UsageLogsRepo(db)
      const now = new Date().toISOString()
      logs.insertSummary({
        id: 'log_pg_1',
        request_id: 'req_pg_1',
        ts: now,
        model: 'claude-sonnet-4-5',
        status: 200,
        duration_ms: 420,
        first_token_ms: 120,
        input_tokens: 1000,
        output_tokens: 250,
        cache_read_tokens: 500,
        total_cost: 0.015,
        actual_cost: 0.015,
        user_id: 'u_pg_1',
        api_key_id: created.id,
        vm_id: 'vm_1',
        account_id: 'acct_1',
      })

      const viewRes = await usageRead({ kind: 'view', method: 'listBatch', args: [{ limit: 10 }] })
      assert.equal(viewRes.logs.length, 1)
      assert.equal(viewRes.logs[0].requestId, 'req_pg_1')

      const statsRes = await usageRead({
        kind: 'stats',
        method: 'statistics',
        args: [{ range: 'today', dimension: 'model', tz: 'UTC' }],
      })
      assert.equal(statsRes.totals.requests, 1)

      const asyncRows = await readAll('SELECT COUNT(*) AS c FROM usage_logs')
      assert.equal(Number(asyncRows[0].c), 1)

      // 7. Write-behind savepoint isolation: a failing callback must NOT poison the batch (25P02)
      enqueueWrite(() => {
        // Trigger a PG SQL error (duplicate PK on settings with invalid syntax / constraint violation)
        db.prepare('INSERT INTO users (id, email, username, password_hash) VALUES (?, ?, ?, ?)').run(
          'u_pg_1',
          'dup@example.com',
          'AlicePG',
          'h',
        )
      })
      enqueueWrite(() => {
        settings.set('write_behind_survived', { ok: true })
      })
      flushWrites()
      assert.deepEqual(settings.get('write_behind_survived'), { ok: true })

      // 8. Case-insensitive LIKE search parity across UsageLogsRepo and UsageLogsView
      logs.insertSummary({
        id: 'log_pg_case',
        request_id: 'REQ_UPPER_CASE_99',
        ts: now,
        path: '/v1/Messages',
        model: 'claude-sonnet-4-5',
        status: 500,
        error_code: 'UPSTREAM_ERROR',
        error_message: 'Anthropic Overload Notice',
        user_id: 'u_pg_1',
        api_key_id: created.id,
      })
      logs.insertSummary({
        id: 'log_pg_cancel',
        request_id: 'req_pg_cancel_1',
        ts: now,
        model: 'claude-sonnet-4-5',
        status: 200,
        error_code: 'client_aborted',
        user_id: 'u_pg_1',
        api_key_id: created.id,
      })
      assert.equal(logs.query({ q: 'anthropic overload' }).items.length, 1)
      assert.equal(logs.query({ q: 'req_upper_case' }).items.length, 1)
      const viewSearch = new UsageLogsView(db).listBatch({ q: 'ANTHROPIC OVERLOAD' })
      assert.equal(viewSearch.logs.length, 1)
      assert.equal(viewSearch.logs[0].requestId, 'REQ_UPPER_CASE_99')

      // 9. Dashboard aggregation rollup (ignores client_aborted in error_requests & prunes stale outbox >24h)
      await pool.query(
        "INSERT INTO scheduler_outbox (event_type, created_at) VALUES ('stale_ev', NOW() - INTERVAL '48 hours')",
      )
      await pool.query(
        "INSERT INTO auth_cache_invalidation_outbox (key_hash, reason, created_at) VALUES ('old_hash', 'rotated', NOW() - INTERVAL '48 hours')",
      )
      const agg = await runDashboardAggregation(pool, { fullBackfill: true })
      assert.equal(agg.skipped, false)
      assert.ok(agg.hourlyBuckets >= 1)
      assert.ok(agg.dailyBuckets >= 1)
      assert.ok(agg.outboxPruned >= 2)
      const hourlyErrors = Number(
        (await pool.query('SELECT COALESCE(SUM(error_requests), 0)::bigint AS e FROM usage_dashboard_hourly')).rows[0]
          ?.e || 0,
      )
      assert.equal(hourlyErrors, 1, 'client_aborted must not be counted as an error in dashboard rollup')

      // 10. CacheClient falls back to PG LISTEN/NOTIFY when configured Redis is unreachable
      const fallbackCache = new MultiTierCacheClient({
        redisConfig: {
          url: 'redis://127.0.0.1:1',
          connectTimeout: 300,
          commandTimeout: 300,
          maxRetriesPerRequest: 0,
        },
      })
      try {
        await fallbackCache.connect({ pgPool: pool })
        assert.equal(fallbackCache.stats().mode, 'l1+pg_notify')
      } finally {
        await fallbackCache.close()
      }

      // 11. Database metrics async snapshot includes vm2api_table_sizes() and aggregation watermark
      const metrics = await snapshotDatabaseMetricsAsync({
        db,
        pgPool: pool,
        cacheRuntime: getCacheRuntime(),
      })
      assert.equal(metrics.database.ok, true)
      assert.equal(metrics.database.engine, 'postgres')
      assert.ok(metrics.database.file_size_bytes > 0)
      assert.ok(metrics.database.migration_count >= 4)
      assert.ok(metrics.database.pg_version)
      assert.ok(Array.isArray(metrics.database.pg_top_tables) && metrics.database.pg_top_tables.length >= 1)
      assert.ok(metrics.database.pg_dashboard_watermark?.last_aggregated_at)
      assert.ok(metrics.cache)

      // 12. PG tool invocation helper strips password from URI and passes via PGPASSWORD env
      const inv = buildPgToolInvocation('postgresql://vm2api:s%40cret%2Fpw@127.0.0.1:5432/vm2api?sslmode=disable')
      assert.equal(inv.env.PGPASSWORD, 's@cret/pw')
      assert.doesNotMatch(inv.uri, /s%40cret/)
      assert.doesNotMatch(inv.uri, /s@cret/)
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 })
      } catch {}
    }
  })
})
