import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { DashboardCache, EntityCache, LiveLogCache, MultiTierCacheClient } from '../../src/lib/cache/index.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { PgLogWriter, getPgLogWriter, setPgLogWriter } from '../../src/lib/db/pg/pg-log-writer.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { UsageLogsView, lookupNamesAsync } from '../../src/lib/db/repos/usage-logs-view.mjs'

function createIsolatedCache() {
  const client = new MultiTierCacheClient({ redisConfig: null, cacheConfig: { enabled: true } })
  return {
    client,
    dashboard: new DashboardCache(client),
    entity: new EntityCache(client),
    liveLogs: new LiveLogCache(client),
  }
}

function createFixtureDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-rt-merge-'))
  const db = createDatabase({ dbPath: path.join(dir, 'logs.db') })
  db.exec(`
    INSERT INTO users (id, email, username, password_hash) VALUES
      ('u1', 'a@x', 'alice', 'x'),
      ('u2', 'b@x', 'bob', 'x');
    INSERT INTO api_keys (id, name, key, user_id) VALUES
      ('k1', 'alice-key', 'sk-1', 'u1'),
      ('k2', 'bob-key', 'sk-2', 'u2');
    INSERT INTO vms (id, name, vm_json, owner_user_id) VALUES
      ('vm-a', 'Slot A', '{}', 'u1'),
      ('vm-b', 'Slot B', '{}', 'u2');
    INSERT INTO accounts (id, vm_id, email, name) VALUES
      ('acc-a', 'vm-a', 'a@pool', 'A'),
      ('acc-b', 'vm-b', NULL, 'Bee');
  `)
  t.after(() => {
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, db }
}

function seedUsageRows(db, rows) {
  const repo = new UsageLogsRepo(db)
  const out = []
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]
    const rec = {
      id: r.id || `log_seed_${String(i + 1).padStart(4, '0')}`,
      request_id: r.request_id || `req-seed-${i + 1}`,
      created_at: r.created_at || new Date(Date.UTC(2026, 5, 1, 12, 0, i)).toISOString(),
      log_mode: 'normal',
      method: 'POST',
      path: '/v1/messages',
      protocol: 'anthropic.messages',
      model: 'claude-sonnet-4-6',
      status: 200,
      vm_id: 'vm-a',
      account_id: 'acc-a',
      user_id: 'u1',
      api_key_id: 'k1',
      ...r,
    }
    repo.insertSummary(rec)
    out.push(rec)
  }
  return out
}

function createSpyPgPool() {
  const queries = []
  const pool = {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params })
      if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 }
      if (/pg_advisory_unlock/i.test(sql)) return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 }
      if (/pg_class/i.test(sql)) return { rows: [{ est: 42 }], rowCount: 1 }
      if (/WITH doomed AS/i.test(sql)) {
        // First pass deletes 3 rows (< batchSize), loop terminates
        return { rows: [{ deleted_count: '3', archived_accounts: '1' }], rowCount: 1 }
      }
      if (/SELECT value FROM settings/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/DELETE FROM request_log_debug/i.test(sql)) return { rows: [], rowCount: 1 }
      if (/OCTET_LENGTH/i.test(sql)) return { rows: [{ used_bytes: '0', total_count: '0' }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    },
    async connect() {
      return {
        query: (sql, params) => pool.query(sql, params),
        release() {},
      }
    },
  }
  return pool
}

test('RequestLogStore start -> updatePhase -> finish bridges live in-flight, 15s recent, and PG dedup seamlessly', async (t) => {
  const { dir, db } = createFixtureDb(t)
  const cache = createIsolatedCache()
  const pool = createSpyPgPool()
  const pgWriter = new PgLogWriter(pool, { batchSize: 64, flushIntervalMs: 60_000 })
  t.after(async () => {
    await pgWriter.close()
  })

  // Tag db as postgres only on a wrapper so SQLite fixture still serves reads while writes route to PgLogWriter.
  const pgStore = new RequestLogStore({
    dataDir: dir,
    db,
    mode: 'normal',
    cache,
    pgLogWriter: pgWriter,
  })
  const view = new UsageLogsView(db, { cache })

  const baseNow = Date.now()
  seedUsageRows(db, [
    {
      id: 'log_old_1',
      request_id: 'req-db-1',
      created_at: new Date(baseNow - 5_000).toISOString(),
      model: 'claude-sonnet-4-6',
      status: 200,
      user_id: 'u1',
      api_key_id: 'k1',
      vm_id: 'vm-a',
      account_id: 'acc-a',
    },
  ])

  // 1. start(): registers in LiveLogCache with zero DB writes.
  const ctx = pgStore.start(
    {
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-request-id': 'req-live-1', 'user-agent': 'claude-cli/2.1' },
      socket: { remoteAddress: '10.0.0.1' },
      apiKeyRecord: { id: 'k1', user_id: 'u1' },
    },
    {
      protocol: 'anthropic.messages',
      pathName: '/v1/messages',
      model: 'claude-opus-4-6',
      session_id: 'sess-live-1',
    },
  )
  assert.equal(ctx.request_id, 'req-live-1')
  assert.equal(pgWriter.pending(), 0)

  // 2. updatePhase(): transitions routing -> retrying -> streaming without blocking.
  pgStore.updatePhase(ctx.request_id, {
    phase: 'retrying',
    attempt_count: 1,
    vm_id: 'vm-a',
    account_id: 'acc-a',
  })
  pgStore.updatePhase(ctx.request_id, {
    phase: 'streaming',
    attempt_count: 2,
    vm_id: 'vm-a',
    account_id: 'acc-a',
    ttft_ms: 145,
  })

  const pageWhileInflight = await view.listBatchAsync({ limit: 10 }, { now: baseNow + 300 })
  assert.equal(pageWhileInflight.logs.length, 2)
  const liveRow = pageWhileInflight.logs[0]
  assert.equal(liveRow.requestId, 'req-live-1')
  assert.equal(liveRow.in_flight, true)
  assert.equal(liveRow.inFlight, true)
  assert.equal(liveRow.statusCode, null)
  assert.equal(liveRow.userName, 'alice')
  assert.equal(liveRow.keyName, 'alice-key')
  assert.equal(liveRow.vmName, 'Slot A')
  assert.equal(liveRow.providerName, 'a@pool')
  assert.equal(liveRow._live?.phase, 'streaming')
  assert.equal(liveRow._live?.attempt_count, 2)
  assert.equal(liveRow._live?.ttft_ms, 145)
  assert.equal(liveRow._live?.vm_id, 'vm-a')
  assert.equal(liveRow._live?.account_id, 'acc-a')
  assert.equal(liveRow._live?.active_provider, 'Slot A')

  // 3. finish(): moves to 15s live:recent bridge + enqueues to PgLogWriter (DB not flushed yet!).
  const summary = pgStore.finish(ctx, {
    status: 200,
    model: 'claude-opus-4-6',
    user_id: 'u1',
    api_key_id: 'k1',
    vm_id: 'vm-a',
    account_id: 'acc-a',
    session_id: 'sess-live-1',
    outbound_session_id: 'out-live-1',
    input_tokens: 120,
    output_tokens: 45,
    first_token_ms: 145,
    attempt_count: 2,
    final_state: 'verified',
  })
  assert.equal(summary.vm_owner_user_id, 'u1')
  assert.equal(pgWriter.pending(), 1)
  // Still not in SQLite table (since PgLogWriter intercepted the write)
  assert.equal(pgStore.repo.getByRequestId('req-live-1'), null)

  // Immediate poll sees the completed row via live:recent bridge (in_flight=false, statusCode=200)!
  const pageInBridgeWindow = await view.listBatchAsync({ limit: 10 }, { now: baseNow + 400 })
  assert.equal(pageInBridgeWindow.logs.length, 2)
  const recentRow = pageInBridgeWindow.logs[0]
  assert.equal(recentRow.requestId, 'req-live-1')
  assert.equal(recentRow.in_flight, false)
  assert.equal(recentRow._live, undefined)
  assert.equal(recentRow.statusCode, 200)
  assert.equal(recentRow.inputTokens, 120)
  assert.equal(recentRow.outputTokens, 45)
  assert.equal(recentRow.vmName, 'Slot A')

  // 4. Once persisted in DB, DB row wins over Redis recent row on request_id dedup (zero duplicates).
  pgStore.repo.insertSummary({ ...summary, id: 'log_persisted_real' })
  const pageAfterFlush = await view.listBatchAsync({ limit: 10 }, { now: baseNow + 500 })
  assert.equal(pageAfterFlush.logs.length, 2)
  const persisted = pageAfterFlush.logs.find((r) => r.requestId === 'req-live-1')
  assert.equal(persisted.id, 'log_persisted_real')
  assert.equal(persisted.in_flight, false)

  // Flush PgLogWriter and verify multi-row PG SQL was issued asynchronously.
  await pgWriter.flush()
  assert.equal(pgWriter.pending(), 0)
  assert.equal(pool.queries.length, 1)
  assert.match(pool.queries[0].sql, /^INSERT INTO usage_logs \(/)
})

test('skip_log, merge_into_request_id, and mode=off never leak orphan in-flight entries', async (t) => {
  const { dir, db } = createFixtureDb(t)
  const cache = createIsolatedCache()
  const store = new RequestLogStore({ dataDir: dir, db, mode: 'normal', cache })

  const ctxSkip = store.start(
    { method: 'POST', url: '/v1/messages', headers: { 'x-request-id': 'req-skip' }, socket: {} },
    { pathName: '/v1/messages' },
  )
  assert.equal(await cache.liveLogs.getInflightCount(), 1)
  assert.equal(store.finish(ctxSkip, { skip_log: true }), null)
  assert.equal(await cache.liveLogs.getInflightCount(), 0)

  const ctxParent = store.start(
    { method: 'POST', url: '/v1/messages', headers: { 'x-request-id': 'req-parent' }, socket: {} },
    { pathName: '/v1/messages' },
  )
  store.finish(ctxParent, { status: 200 })
  const ctxChild = store.start(
    { method: 'POST', url: '/v1/messages', headers: { 'x-request-id': 'req-child' }, socket: {} },
    { pathName: '/v1/messages' },
  )
  assert.equal(await cache.liveLogs.getInflightCount(), 1)
  store.finish(ctxChild, { merge_into_request_id: 'req-parent' })
  assert.equal(await cache.liveLogs.getInflightCount(), 0)

  const offStore = new RequestLogStore({ dataDir: dir, db, mode: 'off', cache })
  offStore.start(
    { method: 'POST', url: '/v1/messages', headers: { 'x-request-id': 'req-off' }, socket: {} },
    { pathName: '/v1/messages' },
  )
  assert.equal(await cache.liveLogs.getInflightCount(), 0)
})

test('EntityCache getVmOwnerSync eliminates repeated vmOwner lookups and PG snapshot/cleanup stay non-blocking', async (t) => {
  const { dir, db } = createFixtureDb(t)
  const cache = createIsolatedCache()
  const pool = createSpyPgPool()
  const pgWriter = new PgLogWriter(pool, { batchSize: 64, flushIntervalMs: 60_000 })
  t.after(async () => {
    await pgWriter.close()
  })

  // Create a PG-tagged wrapper around SQLite db to exercise PG branches deterministically.
  const pgDb = new Proxy(db, {
    get(target, prop) {
      if (prop === 'engine') return 'postgres'
      const v = Reflect.get(target, prop)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })

  const store = new RequestLogStore({
    dataDir: dir,
    db: pgDb,
    mode: 'debug',
    cache,
    pgLogWriter: pgWriter,
    pgPool: pool,
  })

  let vmOwnerQueries = 0
  const origVmOwnerOf = store.repo.vmOwnerOf.bind(store.repo)
  store.repo.vmOwnerOf = (vmId) => {
    vmOwnerQueries += 1
    return origVmOwnerOf(vmId)
  }

  let syncCountCalls = 0
  store.repo.count = () => {
    syncCountCalls += 1
    return 999
  }

  // Two finishes for same vm_id should query vmOwnerOf ONLY once thanks to EntityCache.getVmOwnerSync.
  for (let i = 0; i < 2; i += 1) {
    const ctx = store.start(
      { method: 'POST', url: '/v1/messages', headers: { 'x-request-id': `req-pg-owner-${i}` }, socket: {} },
      { pathName: '/v1/messages' },
    )
    const sum = store.finish(ctx, {
      status: 200,
      vm_id: 'vm-a',
      model: 'claude-sonnet-4-6',
      inbound_body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(sum.vm_owner_user_id, 'u1')
  }
  assert.equal(vmOwnerQueries, 1)
  // Both summary + debug records queued to PgLogWriter (2 summaries + 2 debugs = 4 items).
  assert.equal(pgWriter.stats().queues.usageLogs, 2)
  assert.equal(pgWriter.stats().queues.debugRecords, 2)

  // snapshot() on PG must NOT call synchronous repo.count(), attaches pg_log_writer stats & inflight_count.
  const snap1 = store.snapshot()
  assert.equal(syncCountCalls, 0)
  assert.equal(snap1.backend, 'postgres')
  assert.equal(snap1.total_rows, null)
  assert.equal(snap1.pg_log_writer?.queues?.usageLogs, 2)
  assert.equal(snap1.inflight_count, 0)

  // Let background reltuples async estimate settle; next snapshot returns cached estimate (42).
  await new Promise((r) => setImmediate(r))
  const snap2 = store.snapshot()
  assert.equal(syncCountCalls, 0)
  assert.equal(snap2.total_rows, 42)

  // Seed dashboard cache, then run async PG cleanup and verify cache invalidation + runRetentionCleanupAsync.
  await cache.dashboard.getOrSetSWR('overview', { tz: 'UTC' }, async () => ({ stale: true }), {
    freshTtlMs: 60_000,
    ttlMs: 120_000,
  })
  const cleanupRes = await store.cleanup()
  assert.equal(cleanupRes.skipped, false)
  assert.equal(cleanupRes.usage_logs, 3)
  assert.ok(pool.queries.some((q) => /WITH doomed AS/i.test(q.sql)))

  let reloadedOverview = false
  await cache.dashboard.getOrSetSWR(
    'overview',
    { tz: 'UTC' },
    async () => {
      reloadedOverview = true
      return { stale: false }
    },
    { freshTtlMs: 60_000, ttlMs: 120_000 },
  )
  assert.equal(reloadedOverview, true, 'PG cleanup must invalidate DashboardCache namespaces')
})

test('RequestAttemptsRepo routes PG writes to PgLogWriter and keeps SQLite direct writes unchanged', async (t) => {
  const { db } = createFixtureDb(t)
  const pool = createSpyPgPool()
  const pgWriter = new PgLogWriter(pool, { batchSize: 64, flushIntervalMs: 60_000 })
  const prevWriter = getPgLogWriter()
  setPgLogWriter(pgWriter)
  t.after(async () => {
    setPgLogWriter(prevWriter)
    await pgWriter.close()
  })

  // 1. SQLite repo ignores singleton PgLogWriter and writes synchronously to SQLite.
  const sqliteAttempts = new RequestAttemptsRepo(db)
  sqliteAttempts.begin({
    requestId: 'req-sqlite-att',
    attemptNo: 1,
    vmId: 'vm-a',
    accountId: 'acc-a',
    model: 'claude-sonnet-4-6',
    selectionReason: 'sticky',
  })
  sqliteAttempts.complete('req-sqlite-att', 1, {
    upstreamStatus: 200,
    downstreamCommitted: true,
    terminalState: 'verified',
    ttftMs: 50,
    latencyMs: 200,
  })
  assert.equal(pgWriter.pending(), 0)
  assert.equal(sqliteAttempts.list('req-sqlite-att').length, 1)
  assert.equal(sqliteAttempts.list('req-sqlite-att')[0].terminal_state, 'verified')

  // 2. PG repo routes begin/complete/record into PgLogWriter and merges same-batch begin+complete.
  const pgDb = new Proxy(db, {
    get(target, prop) {
      if (prop === 'engine') return 'postgres'
      const v = Reflect.get(target, prop)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  const pgAttempts = new RequestAttemptsRepo(pgDb)
  pgAttempts.begin({
    requestId: 'req-pg-att',
    attemptNo: 1,
    vmId: 'vm-a',
    accountId: 'acc-a',
    model: 'claude-sonnet-4-6',
    selectionReason: 'balanced',
    waitMs: 12,
  })
  pgAttempts.complete('req-pg-att', 1, {
    upstreamStatus: 200,
    downstreamCommitted: true,
    terminalState: 'verified',
    ttftMs: 80,
    latencyMs: 310,
  })
  pgAttempts.record({
    requestId: 'req-pg-att',
    attemptNo: 2,
    vmId: 'vm-b',
    accountId: 'acc-b',
    model: 'claude-sonnet-4-6',
    upstreamStatus: 503,
    terminalState: 'rejected',
  })
  // Nothing written synchronously to SQLite table
  assert.equal(sqliteAttempts.list('req-pg-att').length, 0)
  assert.equal(pgWriter.stats().queues.attempts, 3)

  await pgWriter.flush()
  assert.equal(pool.queries.length, 1)
  const { sql, params } = pool.queries[0]
  assert.match(sql, /^INSERT INTO request_attempts \(/)
  assert.match(sql, /ON CONFLICT \(request_id, attempt_no\) DO UPDATE/)
  // begin + complete for attempt 1 merged into 1 row + attempt 2 = 2 rows total (2 * 28 = 56 params)
  assert.equal(params.length, 56)
})

test('listBatchAsync enforces strict tenant isolation, filter matching, and page 1 -> page 2 cursor continuity', async (t) => {
  const { db } = createFixtureDb(t)
  const cache = createIsolatedCache()
  const now = Date.now()

  seedUsageRows(db, [
    {
      id: 'log_01',
      request_id: 'req-db-1',
      created_at: new Date(now - 30_000).toISOString(),
      user_id: 'u1',
      api_key_id: 'k1',
      vm_id: 'vm-a',
      account_id: 'acc-a',
      model: 'claude-sonnet-4-6',
      status: 200,
    },
    {
      id: 'log_02',
      request_id: 'req-db-2',
      created_at: new Date(now - 20_000).toISOString(),
      user_id: 'u1',
      api_key_id: 'k1',
      vm_id: 'vm-a',
      account_id: 'acc-a',
      model: 'claude-sonnet-4-6',
      status: 200,
    },
    {
      id: 'log_03',
      request_id: 'req-db-3',
      created_at: new Date(now - 10_000).toISOString(),
      user_id: 'u2',
      api_key_id: 'k2',
      vm_id: 'vm-b',
      account_id: 'acc-b',
      model: 'claude-opus-4-6',
      status: 200,
    },
  ])

  // Start one in-flight for alice (u1) and one for bob (u2)
  await cache.liveLogs.startRequest('req-live-u1', {
    started_at: now - 2_000,
    created_at: new Date(now - 2_000).toISOString(),
    user_id: 'u1',
    owner_user_id: 'u1',
    api_key_id: 'k1',
    vm_id: 'vm-a',
    account_id: 'acc-a',
    model: 'claude-sonnet-4-6',
    path: '/v1/messages',
    protocol: 'anthropic.messages',
    phase: 'streaming',
    attempt_count: 1,
  })
  await cache.liveLogs.startRequest('req-live-u2', {
    started_at: now - 1_000,
    created_at: new Date(now - 1_000).toISOString(),
    user_id: 'u2',
    owner_user_id: 'u2',
    api_key_id: 'k2',
    vm_id: 'vm-b',
    account_id: 'acc-b',
    model: 'claude-opus-4-6',
    path: '/v1/messages',
    protocol: 'anthropic.messages',
    phase: 'routing',
    attempt_count: 2,
  })
  // Add a recent completed error for u1 (not in DB yet)
  await cache.liveLogs.finishRequest('req-recent-err-u1', {
    id: 'log_recent_err',
    request_id: 'req-recent-err-u1',
    created_at: new Date(now - 1_500).toISOString(),
    completed_at: now - 1_500,
    user_id: 'u1',
    owner_user_id: 'u1',
    api_key_id: 'k1',
    vm_id: 'vm-a',
    account_id: 'acc-a',
    model: 'claude-sonnet-4-6',
    path: '/v1/messages',
    status: 504,
    error_code: 'upstream_timeout',
    duration_ms: 1200,
    attempt_count: 2,
  })

  const view = new UsageLogsView(db, { cache })

  // 1. Tenant isolation: u1 sees ONLY u1 rows (never u2's in-flight or DB rows).
  const u1Page = await view.listBatchAsync({ owner_user_id: 'u1', limit: 20 }, { now })
  assert.deepEqual(
    u1Page.logs.map((r) => r.requestId),
    ['req-recent-err-u1', 'req-live-u1', 'req-db-2', 'req-db-1'],
  )
  assert.ok(u1Page.logs.every((r) => r.userId === 'u1'))

  // Defense-in-depth: even if a buggy/mock liveLogs returned cross-tenant entries, view still strips them.
  const leakyCache = {
    ...cache,
    liveLogs: {
      async listLiveAndRecent() {
        return [
          {
            request_id: 'req-leaked-u2',
            user_id: 'u2',
            api_key_id: 'k2',
            created_at: new Date(now).toISOString(),
            in_flight: true,
            _live: { phase: 'routing', attempt_count: 1, started_at: now },
          },
        ]
      },
    },
  }
  const u1Safe = await view.listBatchAsync({ owner_user_id: 'u1', limit: 20 }, { cache: leakyCache, now })
  assert.ok(!u1Safe.logs.some((r) => r.requestId === 'req-leaked-u2'))

  // 2. Filters incompatible with in-flight exclude in-flight entries automatically.
  const status200 = await view.listBatchAsync({ status_code: '200', limit: 20 }, { now })
  assert.ok(status200.logs.every((r) => !r.in_flight && r.statusCode === 200))

  const minLatency = await view.listBatchAsync({ min_latency: 500, limit: 20 }, { now })
  assert.ok(!minLatency.logs.some((r) => r.in_flight))
  assert.ok(minLatency.logs.some((r) => r.requestId === 'req-recent-err-u1'))

  const timeoutOnly = await view.listBatchAsync({ error_class: 'timeout', limit: 20 }, { now })
  assert.deepEqual(
    timeoutOnly.logs.map((r) => r.requestId),
    ['req-recent-err-u1'],
  )

  const retriedOnly = await view.listBatchAsync({ min_attempt_count: '2', limit: 20 }, { now })
  assert.deepEqual(
    retriedOnly.logs.map((r) => r.requestId),
    ['req-live-u2', 'req-recent-err-u1'],
  )

  const modelFilter = await view.listBatchAsync({ model: 'claude-opus-4-6', limit: 20 }, { now })
  assert.deepEqual(
    modelFilter.logs.map((r) => r.requestId),
    ['req-live-u2', 'req-db-3'],
  )

  // 3. Page 1 -> Page 2 cursor pagination: no displaced DB row skipped, no live rows duplicated on Page 2.
  const page1 = await view.listBatchAsync({ owner_user_id: 'u1', limit: 3 }, { now })
  assert.deepEqual(
    page1.logs.map((r) => r.requestId),
    ['req-recent-err-u1', 'req-live-u1', 'req-db-2'],
  )
  assert.equal(page1.hasMore, true)
  assert.equal(page1.nextCursor?.id, 'log_02')

  const page2 = await view.listBatchAsync(
    {
      owner_user_id: 'u1',
      limit: 3,
      cursor_created_at: page1.nextCursor.createdAt,
      cursor_id: page1.nextCursor.id,
    },
    { now },
  )
  assert.deepEqual(
    page2.logs.map((r) => r.requestId),
    ['req-db-1'],
  )
  assert.equal(page2.hasMore, false)
})

test('EntityCache lookupNamesAsync eliminates repeat entity SQL queries on 5s polling', async (t) => {
  const { db } = createFixtureDb(t)
  const cache = createIsolatedCache()
  seedUsageRows(db, [{ request_id: 'req-name-1', user_id: 'u1', api_key_id: 'k1', vm_id: 'vm-a', account_id: 'acc-a' }])

  const entitySqlCalls = []
  const spyDb = {
    prepare(sql) {
      if (/FROM (users|api_keys|vms|accounts)\b/i.test(sql)) {
        entitySqlCalls.push(sql)
      }
      return db.prepare(sql)
    },
  }
  const view = new UsageLogsView(spyDb, { cache })

  const p1 = await view.listBatchAsync({ limit: 10 })
  assert.equal(p1.logs[0].userName, 'alice')
  assert.equal(p1.logs[0].vmName, 'Slot A')
  assert.equal(entitySqlCalls.length, 4)

  // Second poll hits EntityCache L1 -> ZERO entity SQL queries!
  const p2 = await view.listBatchAsync({ limit: 10 })
  assert.equal(p2.logs[0].userName, 'alice')
  assert.equal(p2.logs[0].vmName, 'Slot A')
  assert.equal(entitySqlCalls.length, 4)

  // Updating vms + invalidating names refreshes Slot A -> Slot A2 on next lookup.
  db.prepare("UPDATE vms SET name = 'Slot A2' WHERE id = 'vm-a'").run()
  await cache.entity.invalidateNames('vms', ['vm-a'])
  const names = await lookupNamesAsync(spyDb, { vmIds: ['vm-a'] }, { cache })
  assert.equal(names.vms.get('vm-a'), 'Slot A2')
  assert.equal(entitySqlCalls.length, 5)
})

test('activeSessionsAsync, overviewAsync, and filterOptionsAsync combine SWR cache with live real-time overlay and tenant isolation', async (t) => {
  const { db } = createFixtureDb(t)
  const cache = createIsolatedCache()
  const now = Date.now()

  seedUsageRows(db, [
    {
      id: 'log_s1',
      request_id: 'req-s1',
      created_at: new Date(now - 30_000).toISOString(),
      user_id: 'u1',
      api_key_id: 'k1',
      vm_id: 'vm-a',
      account_id: 'acc-a',
      session_id: 'shared-sess',
      outbound_session_id: 'out-u1',
      has_tools: 1,
    },
    {
      id: 'log_s2',
      request_id: 'req-s2',
      created_at: new Date(now - 25_000).toISOString(),
      user_id: 'u2',
      api_key_id: 'k2',
      vm_id: 'vm-b',
      account_id: 'acc-b',
      session_id: 'shared-sess',
      outbound_session_id: 'out-u2',
      has_tools: 1,
    },
  ])

  let activeBaseCalls = 0
  let overviewBaseCalls = 0
  let filterBaseCalls = 0
  const view = new UsageLogsView(db, { cache })

  // Prime SWR caches while zero requests are in-flight.
  const active1 = await view.activeSessionsAsync(
    { minutes: 5, limit: 20, owner_user_id: 'u1', now },
    {
      baseLoader: (opts) => {
        activeBaseCalls += 1
        return view.activeSessions(opts)
      },
    },
  )
  assert.equal(activeBaseCalls, 1)
  assert.equal(active1.total, 1)
  assert.equal(active1.sessions[0].in_progress, false)
  assert.equal(active1.sessions[0].inflight_count, 0)

  const ov1 = await view.overviewAsync(
    { tz: 'UTC', owner_user_id: null, now },
    {
      baseLoader: (opts) => {
        overviewBaseCalls += 1
        return view.overview(opts)
      },
    },
  )
  assert.equal(overviewBaseCalls, 1)
  assert.equal(ov1.inflightCount, 0)

  // Now start:
  // (a) an in-flight request for u2 on 'shared-sess' (must NOT leak into u1's activeSessions or u1's overview!)
  // (b) a live-only new session for u1 ('live-only-u1')
  await cache.liveLogs.startRequest('req-in-u2-shared', {
    started_at: now - 1_000,
    user_id: 'u2',
    api_key_id: 'k2',
    vm_id: 'vm-b',
    account_id: 'acc-b',
    model: 'claude-opus-4-6',
    session_id: 'shared-sess',
  })
  await cache.liveLogs.startRequest('req-in-u1-new', {
    started_at: now - 500,
    user_id: 'u1',
    api_key_id: 'k1',
    vm_id: 'vm-a',
    account_id: 'acc-a',
    model: 'claude-sonnet-4-6',
    session_id: 'live-only-u1',
  })

  // Second call hits SWR cache (activeBaseCalls stays 1!) yet overlays real-time state accurately!
  const active2U1 = await view.activeSessionsAsync(
    { minutes: 5, limit: 20, owner_user_id: 'u1', now },
    {
      baseLoader: (opts) => {
        activeBaseCalls += 1
        return view.activeSessions(opts)
      },
    },
  )
  assert.equal(activeBaseCalls, 1, 'SWR cache should serve base activeSessions without re-querying DB')
  assert.equal(active2U1.total, 2)
  const sharedForU1 = active2U1.sessions.find((s) => s.sessionId === 'shared-sess')
  assert.equal(sharedForU1.in_progress, false, 'u2 concurrency on shared-sess must never leak to u1')
  assert.equal(sharedForU1.inflight_count, 0)
  const liveOnlyU1 = active2U1.sessions.find((s) => s.sessionId === 'live-only-u1')
  assert.ok(liveOnlyU1)
  assert.equal(liveOnlyU1.in_progress, true)
  assert.equal(liveOnlyU1.inProgress, true)
  assert.equal(liveOnlyU1.inflight_count, 1)
  assert.equal(liveOnlyU1.inflightCount, 1)
  assert.equal(liveOnlyU1.userName, 'alice')
  assert.equal(liveOnlyU1.vmName, 'Slot A')

  // Admin overview hits SWR cache (overviewBaseCalls stays 1!) yet overlays real-time inflightCount=2.
  const ov2Admin = await view.overviewAsync(
    { tz: 'UTC', owner_user_id: null, now },
    {
      baseLoader: (opts) => {
        overviewBaseCalls += 1
        return view.overview(opts)
      },
    },
  )
  assert.equal(overviewBaseCalls, 1)
  assert.equal(ov2Admin.inflightCount, 2)

  // Tenant overview sees ONLY own inflightCount=1 (not admin's 2).
  const ovU1 = await view.overviewAsync({ tz: 'UTC', owner_user_id: 'u1', now })
  assert.equal(ovU1.inflightCount, 1)

  // filterOptionsAsync caches per owner scope (60s/180s SWR).
  const fAdmin1 = await view.filterOptionsAsync(
    { owner_user_id: null },
    {
      baseLoader: (opts) => {
        filterBaseCalls += 1
        return view.filterOptions(opts)
      },
    },
  )
  const fAdmin2 = await view.filterOptionsAsync(
    { owner_user_id: null },
    {
      baseLoader: (opts) => {
        filterBaseCalls += 1
        return view.filterOptions(opts)
      },
    },
  )
  assert.equal(filterBaseCalls, 1)
  assert.equal(fAdmin1.users.length, 2)
  assert.deepEqual(fAdmin2.users, fAdmin1.users)

  const fU1 = await view.filterOptionsAsync(
    { owner_user_id: 'u1' },
    {
      baseLoader: (opts) => {
        filterBaseCalls += 1
        return view.filterOptions(opts)
      },
    },
  )
  assert.equal(filterBaseCalls, 2, 'Tenant filterOptions must use isolated cache key')
  assert.deepEqual(fU1.users, [{ id: 'u1', name: 'alice' }])
})

test('Fail-Open: broken LiveLogCache never breaks listBatchAsync, activeSessionsAsync, or overviewAsync', async (t) => {
  const { db } = createFixtureDb(t)
  seedUsageRows(db, [{ request_id: 'req-db-ok', session_id: 's-ok', outbound_session_id: 'out-ok' }])

  const brokenCache = {
    client: null,
    dashboard: null,
    entity: null,
    liveLogs: {
      async listLiveAndRecent() {
        throw new Error('redis down')
      },
      async getActiveSessionCounts() {
        throw new Error('redis down')
      },
      async getInflightCount() {
        throw new Error('redis down')
      },
    },
  }
  const view = new UsageLogsView(db, { cache: brokenCache })

  const batch = await view.listBatchAsync({ limit: 10 })
  assert.equal(batch.logs.length, 1)
  assert.equal(batch.logs[0].requestId, 'req-db-ok')

  const sessions = await view.activeSessionsAsync({
    minutes: 5,
    limit: 10,
    now: Date.parse('2026-06-01T12:01:00.000Z'),
  })
  assert.equal(sessions.total, 1)
  assert.equal(sessions.sessions[0].in_progress, false)

  const ov = await view.overviewAsync({ tz: 'UTC', now: Date.parse('2026-06-01T12:01:00.000Z') })
  assert.equal(ov.inflightCount, 0)
})

test('listBatchAsync advances cleanly to page 2 without infinite loop when live entries fill page 1 (>= limit)', async (t) => {
  const { db } = createFixtureDb(t)
  const cache = createIsolatedCache()
  const now = Date.now()

  seedUsageRows(db, [
    {
      id: 'log_db_old',
      request_id: 'req-db-old',
      created_at: new Date(now - 20_000).toISOString(),
      user_id: 'u1',
      api_key_id: 'k1',
    },
    {
      id: 'log_db_new',
      request_id: 'req-db-new',
      created_at: new Date(now - 10_000).toISOString(),
      user_id: 'u1',
      api_key_id: 'k1',
    },
  ])

  // 3 in-flight live requests completely fill page 1 when limit = 2.
  for (let i = 1; i <= 3; i += 1) {
    await cache.liveLogs.startRequest(`req-live-full-${i}`, {
      started_at: now - (4 - i) * 1000,
      created_at: new Date(now - (4 - i) * 1000).toISOString(),
      user_id: 'u1',
      api_key_id: 'k1',
      vm_id: 'vm-a',
      account_id: 'acc-a',
      model: 'claude-sonnet-4-6',
      phase: 'streaming',
    })
  }

  const view = new UsageLogsView(db, { cache })
  const page1 = await view.listBatchAsync({ limit: 2 }, { now })
  assert.deepEqual(
    page1.logs.map((r) => r.requestId),
    ['req-live-full-3', 'req-live-full-2'],
  )
  assert.equal(page1.hasMore, true)
  assert.ok(page1.nextCursor?.createdAt, 'nextCursor.createdAt must be populated')
  assert.ok(
    typeof page1.nextCursor?.id === 'string' && page1.nextCursor.id.length > 0,
    'nextCursor.id must be non-empty so usageLogFilters preserves cursor_id',
  )

  // Simulate panel-routes query string normalization (empty string -> null).
  const page2 = await view.listBatchAsync(
    {
      limit: 2,
      cursor_created_at: page1.nextCursor.createdAt || null,
      cursor_id: page1.nextCursor.id || null,
    },
    { now },
  )
  assert.deepEqual(
    page2.logs.map((r) => r.requestId),
    ['req-db-new', 'req-db-old'],
  )
  assert.ok(page2.logs.every((r) => !r.in_flight))
  assert.equal(page2.hasMore, false)
})

test('tenant VM-owner and API-key-owner live logs stay visible while other tenants remain strictly isolated', async (t) => {
  const { dir, db } = createFixtureDb(t)
  const cache = createIsolatedCache()
  const now = Date.now()
  const store = new RequestLogStore({ dataDir: dir, db, mode: 'normal', cache })
  const view = new UsageLogsView(db, { cache })

  // 1. Master/test-chat request routed onto Alice's VM (vm-a has owner_user_id = 'u1', no user_id on request).
  const vmOwnedCtx = store.start(
    { method: 'POST', url: '/v1/messages', headers: { 'x-request-id': 'req-vm-owned' }, socket: {} },
    { protocol: 'anthropic.messages', pathName: '/v1/messages', model: 'claude-sonnet-4-6', session_id: 'sess-vm-own' },
  )
  // updatePhase with vm_id auto-enriches vm_owner_user_id='u1' and generic active_provider='claude' resolves to VM name.
  store.updatePhase(vmOwnedCtx.request_id, {
    phase: 'streaming',
    attempt_count: 1,
    vm_id: 'vm-a',
    account_id: 'acc-a',
    active_provider: 'claude',
  })

  // 2. Legacy key-owned request: user_id is null, owned strictly via api_key_id='k1' (belongs to u1).
  await cache.liveLogs.startRequest('req-key-owned', {
    started_at: now - 500,
    created_at: new Date(now - 500).toISOString(),
    user_id: null,
    api_key_id: 'k1',
    vm_id: null,
    model: 'claude-sonnet-4-6',
    session_id: 'sess-key-own',
    phase: 'routing',
  })

  // 3. Another tenant's request (Bob u2 / k2 / vm-b) must never leak to Alice (u1).
  await cache.liveLogs.startRequest('req-other-u2', {
    started_at: now - 200,
    created_at: new Date(now - 200).toISOString(),
    user_id: 'u2',
    api_key_id: 'k2',
    vm_id: 'vm-b',
    vm_owner_user_id: 'u2',
    model: 'claude-opus-4-6',
    session_id: 'sess-bob',
    phase: 'streaming',
  })

  const u1List = await view.listBatchAsync({ owner_user_id: 'u1', limit: 20 }, { now: now + 100 })
  const u1ReqIds = u1List.logs.map((r) => r.requestId).sort()
  assert.deepEqual(u1ReqIds, ['req-key-owned', 'req-vm-owned'])
  const vmOwnedRow = u1List.logs.find((r) => r.requestId === 'req-vm-owned')
  assert.equal(vmOwnedRow._live?.active_provider, 'Slot A', 'generic provider family should yield to resolved VM name')

  const u1Sessions = await view.activeSessionsAsync({ owner_user_id: 'u1', minutes: 5, limit: 20, now: now + 100 })
  assert.deepEqual(u1Sessions.sessions.map((s) => s.sessionId).sort(), ['sess-key-own', 'sess-vm-own'])

  const u1Overview = await view.overviewAsync({ owner_user_id: 'u1', tz: 'UTC', now: now + 100 })
  assert.equal(u1Overview.inflightCount, 2)

  const u2List = await view.listBatchAsync({ owner_user_id: 'u2', limit: 20 }, { now: now + 100 })
  assert.deepEqual(
    u2List.logs.map((r) => r.requestId),
    ['req-other-u2'],
  )
  const u2Overview = await view.overviewAsync({ owner_user_id: 'u2', tz: 'UTC', now: now + 100 })
  assert.equal(u2Overview.inflightCount, 1)
})

test('merge_into_request_id flushes pending PgLogWriter queue before merging continuation', async (t) => {
  const { dir, db } = createFixtureDb(t)
  const cache = createIsolatedCache()
  const events = []
  const pool = {
    async query(sql, params) {
      events.push({ kind: 'pg_flush', sql, params })
      return { rows: [], rowCount: 1 }
    },
  }
  const pgWriter = new PgLogWriter(pool, { batchSize: 64, flushIntervalMs: 60_000 })
  t.after(async () => {
    await pgWriter.close()
  })

  const store = new RequestLogStore({ dataDir: dir, db, mode: 'normal', cache, pgLogWriter: pgWriter })
  store.repo.mergeToolContinuation = (parentId, opts) => {
    events.push({ kind: 'merge', parentId, durationMs: opts.durationMs })
    return true
  }

  const parentCtx = store.start(
    { method: 'POST', url: '/v1/messages', headers: { 'x-request-id': 'req-pg-parent' }, socket: {} },
    { pathName: '/v1/messages' },
  )
  store.finish(parentCtx, { status: 200, model: 'claude-sonnet-4-6' })
  assert.equal(pgWriter.pending(), 1)

  const childCtx = store.start(
    { method: 'POST', url: '/v1/messages', headers: { 'x-request-id': 'req-pg-child' }, socket: {} },
    { pathName: '/v1/messages' },
  )
  store.finish(childCtx, { merge_into_request_id: 'req-pg-parent' })

  // Allow microtask / flush promise chain to settle
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(pgWriter.pending(), 0)
  assert.deepEqual(
    events.map((e) => e.kind),
    ['pg_flush', 'merge'],
  )
  assert.equal(events[1].parentId, 'req-pg-parent')
})
