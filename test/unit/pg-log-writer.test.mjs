import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import pg from 'pg'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { applyPgMigrations, PG_MIGRATIONS_DIR } from '../../src/lib/db/pg/migrations-runner.mjs'
import {
  buildMultiRowInsert,
  createPgLogWriter,
  flushPgLogWriter,
  getPgLogWriter,
  normalizeAttemptRecord,
  normalizeDebugRecord,
  PgLogWriter,
  REQUEST_ATTEMPT_COLUMNS,
  REQUEST_DEBUG_COLUMNS,
  runRetentionCleanupAsync,
  startPgLogWriter,
  stopPgLogWriter,
  USAGE_LOG_COLUMNS,
  usageLogToRow,
} from '../../src/lib/db/pg/pg-log-writer.mjs'

const PG_URL = process.env.VM2API_TEST_PG_URL || ''

function createMockPool(handler) {
  const calls = []
  const pool = {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (handler) return handler(sql, params, calls.length)
      return { rows: [], rowCount: 0 }
    },
  }
  return pool
}

test('PG migration 011 drops only verified duplicate usage_logs indexes and runs idempotently', async () => {
  const migFile = '011_drop_duplicate_usage_logs_indexes.sql'
  const migPath = path.join(PG_MIGRATIONS_DIR, migFile)
  assert.equal(fs.existsSync(migPath), true, `expected ${migPath} to exist`)

  const sql = fs.readFileSync(migPath, 'utf8')
  assert.match(sql, /DROP INDEX IF EXISTS idx_reqlog_cost_ts;/i)
  assert.match(sql, /DROP INDEX IF EXISTS idx_usage_logs_request_id;/i)
  assert.doesNotMatch(sql, /DROP INDEX[^\n]*idx_reqlog_reqid/i, 'must preserve UNIQUE idx_reqlog_reqid')
  assert.doesNotMatch(sql, /DROP INDEX[^\n]*idx_reqlog_ts\b/i, 'must preserve idx_reqlog_ts')

  // Verify applyPgMigrations loads and applies 011 cleanly and idempotently via mock client
  const appliedVersions = new Map()
  const executedSql = []
  const client = {
    async query(text, params = []) {
      const s = String(text).trim()
      if (s === 'SELECT 1') return { rows: [{ '?column?': 1 }] }
      if (s.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ locked: true }] }
      if (s.startsWith('SELECT pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] }
      if (s.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) return { rows: [] }
      if (s.startsWith('SELECT version, checksum FROM schema_migrations')) {
        return { rows: [...appliedVersions.entries()].map(([version, checksum]) => ({ version, checksum })) }
      }
      if (s.startsWith('INSERT INTO schema_migrations')) {
        appliedVersions.set(String(params[0]), String(params[2]))
        return { rows: [], rowCount: 1 }
      }
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] }
      executedSql.push(s)
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }
  const mockPool = { connect: async () => client }

  const first = await applyPgMigrations(mockPool)
  assert.equal(first.at(-1), migFile)
  assert.ok(executedSql.some((s) => s.includes('DROP INDEX IF EXISTS idx_reqlog_cost_ts')))

  const second = await applyPgMigrations(mockPool)
  assert.deepEqual(second, [])
})

test('USAGE_LOG_COLUMNS and REQUEST_ATTEMPT_COLUMNS stay in 100% parity with live schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-pg-log-cols-'))
  const db = createDatabase({ dbPath: path.join(dir, 'kin.db') })
  try {
    const usageCols = db
      .prepare('PRAGMA table_info(usage_logs)')
      .all()
      .map((r) => r.name)
      .sort()
    assert.deepEqual([...USAGE_LOG_COLUMNS].sort(), usageCols)

    const attemptCols = db
      .prepare('PRAGMA table_info(request_attempts)')
      .all()
      .map((r) => r.name)
      .filter((name) => name !== 'id')
      .sort()
    assert.deepEqual([...REQUEST_ATTEMPT_COLUMNS].sort(), attemptCols)

    const debugCols = db
      .prepare('PRAGMA table_info(request_log_debug)')
      .all()
      .map((r) => r.name)
      .sort()
    assert.deepEqual([...REQUEST_DEBUG_COLUMNS].sort(), debugCols)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('usageLogToRow preserves field aliases, nullability, JSON serialization, and strips NUL bytes', () => {
  const row = usageLogToRow({
    id: 'log_1',
    request_id: 'req_1',
    ts: '2026-11-28T10:00:00.000Z',
    ip: '10.0.0.1',
    stream: true,
    has_tools: false,
    input_tokens: 100,
    output_tokens: 25,
    cache_creation_tokens: null,
    error_message: 'bad\x00byte',
    error_details: { upstream_type: 'overloaded', code: 'x\x00y' },
    advisor_usage: [{ model: 'haiku', tokens: 10 }],
  })
  const byCol = Object.fromEntries(USAGE_LOG_COLUMNS.map((c, i) => [c, row[i]]))
  assert.equal(byCol.id, 'log_1')
  assert.equal(byCol.request_id, 'req_1')
  assert.equal(byCol.created_at, '2026-11-28T10:00:00.000Z')
  assert.equal(byCol.ip_address, '10.0.0.1')
  assert.equal(byCol.stream, 1)
  assert.equal(byCol.has_tools, 0)
  assert.equal(byCol.input_tokens, 100)
  assert.equal(byCol.output_tokens, 25)
  assert.equal(byCol.cache_read_tokens, 0)
  assert.equal(byCol.cache_creation_tokens, null)
  assert.equal(byCol.error_message, 'badbyte')
  assert.equal(byCol.error_details, JSON.stringify({ upstream_type: 'overloaded', code: 'xy' }))
  assert.equal(byCol.advisor_usage, JSON.stringify([{ model: 'haiku', tokens: 10 }]))
})

test('PgLogWriter batches usage_logs into a single parameterized multi-row INSERT', async () => {
  const pool = createMockPool()
  const writer = createPgLogWriter(pool, { batchSize: 128, flushIntervalMs: 5000 })

  writer.enqueueUsageLog({ id: 'log_a', request_id: 'req_a', ts: '2026-11-28T10:00:00.000Z', status: 200, model: 'm1' })
  writer.enqueueUsageLog({ id: 'log_b', request_id: 'req_b', ts: '2026-11-28T10:00:01.000Z', status: 201, model: 'm2' })
  // Duplicate request_id within the same batch collapses cleanly to keep first row
  writer.enqueueUsageLog({ id: 'log_a_dup', request_id: 'req_a', ts: '2026-11-28T10:00:02.000Z', status: 500 })

  assert.equal(writer.pending(), 3)
  assert.equal(pool.calls.length, 0)

  const st = await writer.flush()
  assert.equal(pool.calls.length, 1)
  assert.match(
    pool.calls[0].sql,
    /^INSERT INTO usage_logs \(id, request_id, .*\) VALUES \(.*\), \(.*\) ON CONFLICT \(request_id\) DO NOTHING$/,
  )
  assert.equal(pool.calls[0].params.length, USAGE_LOG_COLUMNS.length * 2)
  assert.equal(pool.calls[0].params[0], 'log_a')
  assert.equal(pool.calls[0].params[USAGE_LOG_COLUMNS.length], 'log_b')
  assert.equal(st.queued, 0)
  assert.equal(st.enqueued, 3)
  assert.equal(st.flushed, 3)
  assert.equal(st.batches, 1)
  assert.equal(st.fallbacks, 0)
  assert.equal(st.dropped, 0)
  assert.equal(st.errors, 0)
  assert.equal(typeof st.lastFlushMs, 'number')

  await writer.close()
})

test('PgLogWriter auto-flushes on batchSize threshold and on flushIntervalMs timer', async () => {
  const pool = createMockPool()
  const writer = createPgLogWriter(pool, { batchSize: 2, flushIntervalMs: 25 })

  // Reaching batchSize triggers immediate microtask flush without waiting for timer
  writer.enqueueUsageLog({ id: 'l1', request_id: 'r1', ts: '2026-11-28T10:00:00.000Z' })
  writer.enqueueUsageLog({ id: 'l2', request_id: 'r2', ts: '2026-11-28T10:00:01.000Z' })
  await new Promise((r) => setImmediate(r))
  assert.equal(pool.calls.length, 1)
  assert.equal(writer.stats().flushed, 2)

  // Below batchSize flushes automatically on interval timer
  writer.enqueueUsageLog({ id: 'l3', request_id: 'r3', ts: '2026-11-28T10:00:02.000Z' })
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(pool.calls.length, 2)
  assert.equal(writer.stats().flushed, 3)
  assert.equal(writer.pending(), 0)

  await writer.close()
})

test('PgLogWriter chunks multi-row INSERTs to stay below maxParamsPerQuery', async () => {
  const pool = createMockPool()
  // 76 cols * 3 rows = 228 <= 256, so 5 rows with maxParamsPerQuery=256 splits into 3 + 2
  const writer = createPgLogWriter(pool, { batchSize: 10, maxParamsPerQuery: 256, flushIntervalMs: 5000 })
  for (let i = 0; i < 5; i += 1) {
    writer.enqueueUsageLog({ id: `l${i}`, request_id: `r${i}`, ts: '2026-11-28T10:00:00.000Z' })
  }
  await writer.flush()
  assert.equal(pool.calls.length, 2)
  assert.equal(pool.calls[0].params.length, USAGE_LOG_COLUMNS.length * 3)
  assert.equal(pool.calls[1].params.length, USAGE_LOG_COLUMNS.length * 2)
  assert.equal(writer.stats().flushed, 5)
  await writer.close()
})

test('PgLogWriter coalesces same-batch begin+complete request_attempts and upserts idempotently', async () => {
  const pool = createMockPool()
  const writer = createPgLogWriter(pool, { batchSize: 128, flushIntervalMs: 5000 })
  const isoCooldown = '2026-11-28T12:00:00.000Z'

  writer.enqueueAttempt({
    requestId: 'req_att_1',
    attemptNo: 1,
    vmId: 'vm-1',
    accountId: 'acc-1',
    model: 'claude-sonnet-4-5',
    selectionReason: 'sticky',
    startedAt: '2026-11-28T10:00:00.000Z',
    terminalState: 'started',
    waitMs: 12,
    queueWaitMs: 4,
    schedulingMs: 3,
  })
  writer.enqueueAttempt({
    requestId: 'req_att_1',
    attemptNo: 1,
    completedAt: '2026-11-28T10:00:01.500Z',
    upstreamStatus: 429,
    errorScope: 'quota',
    action: 'failover',
    cooldownUntil: isoCooldown,
    downstreamCommitted: true,
    terminalState: 'failed_retryable',
    usage: { input_tokens: 50 },
    ttftMs: 120,
    latencyMs: 1500,
    errorCode: 'rate_limit',
    providerTurnId: 7,
    providerAttemptId: '2',
  })
  writer.enqueueAttempt({
    request_id: 'req_att_1',
    attempt_no: 2,
    vm_id: 'vm-2',
    account_id: 'acc-2',
    started_at: '2026-11-28T10:00:01.600Z',
    terminal_state: 'succeeded',
    upstream_status: 200,
  })

  const st = await writer.flush()
  assert.equal(pool.calls.length, 1)
  assert.match(
    pool.calls[0].sql,
    /INSERT INTO request_attempts .* ON CONFLICT \(request_id, attempt_no\) DO UPDATE SET/s,
  )
  // 3 enqueued events collapsed into 2 distinct (request_id, attempt_no) tuples
  assert.equal(pool.calls[0].params.length, REQUEST_ATTEMPT_COLUMNS.length * 2)

  const row1 = Object.fromEntries(REQUEST_ATTEMPT_COLUMNS.map((c, i) => [c, pool.calls[0].params[i]]))
  assert.equal(row1.request_id, 'req_att_1')
  assert.equal(row1.attempt_no, 1)
  assert.equal(row1.vm_id, 'vm-1')
  assert.equal(row1.account_id, 'acc-1')
  assert.equal(row1.started_at, '2026-11-28T10:00:00.000Z')
  assert.equal(row1.completed_at, '2026-11-28T10:00:01.500Z')
  assert.equal(row1.upstream_status, 429)
  assert.equal(row1.cooldown_until, Date.parse(isoCooldown))
  assert.equal(row1.downstream_committed, 1)
  assert.equal(row1.terminal_state, 'failed_retryable')
  assert.equal(row1.usage_json, JSON.stringify({ input_tokens: 50 }))
  assert.equal(row1.provider_turn_id, '7')
  assert.equal(row1.provider_attempt_id, 2)

  assert.equal(st.enqueued, 3)
  assert.equal(st.flushed, 3)
  assert.equal(st.dropped, 0)
  await writer.close()
})

test('PgLogWriter truncates oversized UTF-8 debug records to valid JSON and isolates debug failures from usage_logs', async () => {
  const maxDebugBytes = 256
  const oversized = normalizeDebugRecord(
    'req_dbg_1',
    '2026-11-28T10:00:00.000Z',
    {
      request_id: 'req_dbg_1',
      status: 200,
      model: 'claude-sonnet-4-5',
      inbound_body: '中文测试🙂'.repeat(200),
    },
    maxDebugBytes,
  )
  assert.ok(Buffer.byteLength(oversized.record_json, 'utf8') <= maxDebugBytes)
  const parsed = JSON.parse(oversized.record_json)
  assert.equal(parsed._truncated, true)
  assert.equal(parsed.request_id, 'req_dbg_1')
  assert.equal(parsed.status, 200)
  assert.ok(parsed._original_bytes > maxDebugBytes)

  // Now simulate debug table failing while usage_logs succeeds in the same flush cycle
  const errors = []
  const pool = createMockPool((sql) => {
    if (sql.includes('INSERT INTO request_log_debug')) {
      throw new Error('debug_disk_full')
    }
    return { rows: [], rowCount: 1 }
  })
  const writer = createPgLogWriter(pool, {
    maxDebugBytes,
    flushIntervalMs: 5000,
    onError: (err, ctx) => errors.push({ msg: err.message, ctx }),
  })

  writer.enqueueUsageLog(
    { id: 'log_main_1', request_id: 'req_iso_1', ts: '2026-11-28T10:00:00.000Z', status: 200 },
    { request_id: 'req_iso_1', body: 'x'.repeat(2000) },
  )
  const st = await writer.flush()

  // Main usage_logs succeeded; debug failed + fell back + dropped without harming usage_logs
  const usageCalls = pool.calls.filter((c) => c.sql.includes('INSERT INTO usage_logs'))
  assert.equal(usageCalls.length, 1)
  assert.equal(st.flushed, 1)
  assert.equal(st.dropped, 1)
  assert.equal(st.fallbacks, 1)
  assert.ok(errors.some((e) => e.ctx.table === 'request_log_debug'))
  await writer.close()
})

test('PgLogWriter falls back row-by-row on batch SQL failure to isolate poison rows', async () => {
  const persisted = []
  const reported = []
  const pool = createMockPool((sql, params) => {
    const rowCount = params.length / USAGE_LOG_COLUMNS.length
    // Reject any query containing poison request_id 'req_poison'
    if (params.includes('req_poison')) {
      throw new Error(`constraint violation on ${rowCount}-row insert`)
    }
    for (let i = 0; i < rowCount; i += 1) {
      persisted.push(params[i * USAGE_LOG_COLUMNS.length + 1])
    }
    return { rows: [], rowCount }
  })

  const writer = createPgLogWriter(pool, {
    batchSize: 10,
    flushIntervalMs: 5000,
    onError: (err, ctx) => reported.push({ err: err.message, ctx }),
  })

  for (const reqId of ['req_ok_1', 'req_poison', 'req_ok_2', 'req_ok_3']) {
    writer.enqueueUsageLog({ id: `id_${reqId}`, request_id: reqId, ts: '2026-11-28T10:00:00.000Z', status: 200 })
  }

  const st = await writer.flush()
  assert.deepEqual(persisted, ['req_ok_1', 'req_ok_2', 'req_ok_3'])
  assert.equal(st.enqueued, 4)
  assert.equal(st.flushed, 3)
  assert.equal(st.dropped, 1)
  assert.equal(st.fallbacks, 1)
  assert.equal(st.errors, 2) // 1 batch error + 1 single-row error
  assert.equal(reported.length, 2)
  assert.equal(reported[0].ctx.phase, 'batch')
  assert.equal(reported[1].ctx.phase, 'fallback_row')
  assert.equal(reported[1].ctx.requestId, 'req_poison')

  await writer.close()
})

test('PgLogWriter protects against maxPending overflow via urgent flush + direct write without dropping logs', async () => {
  const persisted = []
  const pool = createMockPool(async (_sql, params) => {
    // Small async delay to simulate slow PG under spike
    await new Promise((r) => setTimeout(r, 5))
    const count = params.length / USAGE_LOG_COLUMNS.length
    for (let i = 0; i < count; i += 1) {
      persisted.push(params[i * USAGE_LOG_COLUMNS.length + 1])
    }
    return { rows: [], rowCount: count }
  })

  const writer = createPgLogWriter(pool, {
    batchSize: 10,
    maxPending: 3,
    flushIntervalMs: 5000,
  })

  for (let i = 1; i <= 6; i += 1) {
    assert.equal(
      writer.enqueueUsageLog({ id: `id_${i}`, request_id: `req_${i}`, ts: '2026-11-28T10:00:00.000Z' }),
      true,
    )
  }

  // Queue itself stayed strictly <= maxPending while overflow items wrote directly
  assert.ok(writer.pending() <= 3)
  assert.equal(writer.stats().overflowDirect, 3)

  const st = await writer.close()
  assert.equal(st.closed, true)
  assert.equal(st.queued, 0)
  assert.equal(st.enqueued, 6)
  assert.equal(st.flushed, 6)
  assert.equal(st.dropped, 0)
  assert.deepEqual(persisted.sort(), ['req_1', 'req_2', 'req_3', 'req_4', 'req_5', 'req_6'])

  // Post-close enqueue returns false and records drop instead of reviving timers
  assert.equal(writer.enqueueUsageLog({ id: 'after', request_id: 'req_after' }), false)
  assert.equal(writer.stats().dropped, 1)
  // Repeat close is idempotent
  await writer.close()
})

test('PgLogWriter flush() drain barrier waits for in-flight batches and items enqueued mid-flush', async () => {
  let releaseFirstBatch
  const firstBatchGate = new Promise((resolve) => {
    releaseFirstBatch = resolve
  })
  let callNo = 0
  const persisted = []

  const pool = createMockPool(async (_sql, params) => {
    callNo += 1
    if (callNo === 1) await firstBatchGate
    const count = params.length / USAGE_LOG_COLUMNS.length
    for (let i = 0; i < count; i += 1) {
      persisted.push(params[i * USAGE_LOG_COLUMNS.length + 1])
    }
    return { rows: [], rowCount: count }
  })

  const writer = createPgLogWriter(pool, { batchSize: 2, flushIntervalMs: 5000 })
  writer.enqueueUsageLog({ id: '1', request_id: 'r1', ts: '2026-11-28T10:00:00.000Z' })
  writer.enqueueUsageLog({ id: '2', request_id: 'r2', ts: '2026-11-28T10:00:01.000Z' })

  const flushA = writer.flush()
  // Wait a microtask so batch 1 is in flight on pool.query
  await Promise.resolve()
  // Enqueue item 3 while batch 1 is still in flight, then call flush() concurrently
  writer.enqueueUsageLog({ id: '3', request_id: 'r3', ts: '2026-11-28T10:00:02.000Z' })
  const flushB = writer.flush()

  releaseFirstBatch()
  const [stA, stB] = await Promise.all([flushA, flushB])
  assert.equal(stA.queued, 0)
  assert.equal(stB.queued, 0)
  assert.deepEqual(persisted.sort(), ['r1', 'r2', 'r3'])
  await writer.close()
})

test('PgLogWriter singleton lifecycle helpers start, flush, and stop cleanly', async () => {
  assert.equal(getPgLogWriter(), null)
  const pool = createMockPool()
  const started = startPgLogWriter(pool, { flushIntervalMs: 5000 })
  assert.equal(getPgLogWriter(), started)
  started.enqueueUsageLog({ id: 's1', request_id: 'sr1', ts: '2026-11-28T10:00:00.000Z' })
  const flushed = await flushPgLogWriter()
  assert.equal(flushed.flushed, 1)
  const closed = await stopPgLogWriter()
  assert.equal(closed.closed, true)
  assert.equal(getPgLogWriter(), null)
  assert.equal(await flushPgLogWriter(), null)
  assert.equal(await stopPgLogWriter(), null)
})

test('runRetentionCleanupAsync performs ctid batched archive+delete, monotonic pruned_through, debug age+size trim, and advisory lock', async () => {
  // 1. Advisory lock busy -> skips cleanly
  const busyClient = {
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }] }
      throw new Error(`unexpected query while lock busy: ${sql}`)
    },
    release() {},
  }
  const skipped = await runRetentionCleanupAsync({ query: async () => ({}), connect: async () => busyClient })
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.reason, 'lock_busy')

  // 2. Multi-batch usage_logs + monotonic settings + debug age + debug size trim
  const usageBatchCounts = [5000, 5000, 1200]
  const debugAgeCounts = [5000, 300]
  const debugSizeSteps = [
    { used_bytes: 10_000, total_count: 10 },
    { used_bytes: 5_000, total_count: 5 },
    { used_bytes: 2_000, total_count: 2 },
  ]
  let usageCallIdx = 0
  let debugAgeIdx = 0
  let debugSizeIdx = 0
  let unlocked = false
  let released = false
  let savedPrunedThrough = null
  const seenSql = []

  const client = {
    async query(sql, params = []) {
      seenSql.push({ sql, params })
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] }
      if (sql.includes('pg_advisory_unlock')) {
        unlocked = true
        return { rows: [{ pg_advisory_unlock: true }] }
      }
      if (sql.includes('WITH doomed AS') && sql.includes('account_lifetime_usage_archive')) {
        const n = usageBatchCounts[usageCallIdx] ?? 0
        usageCallIdx += 1
        assert.equal(params[1], 5000)
        return { rows: [{ deleted_count: String(n), archived_accounts: '2' }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT value FROM settings WHERE key = $1')) {
        return { rows: [{ value: JSON.stringify('2026-10-01T00:00:00.000Z') }] }
      }
      if (sql.startsWith('INSERT INTO settings')) {
        savedPrunedThrough = JSON.parse(params[1])
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('DELETE FROM request_log_debug') && sql.includes('WHERE ts < $1')) {
        const n = debugAgeCounts[debugAgeIdx] ?? 0
        debugAgeIdx += 1
        return { rows: [], rowCount: n }
      }
      if (sql.includes('SUM(OCTET_LENGTH(record_json))')) {
        const step = debugSizeSteps[debugSizeIdx] ?? { used_bytes: 0, total_count: 0 }
        debugSizeIdx += 1
        return { rows: [step] }
      }
      if (sql.includes('ORDER BY ts ASC LIMIT $1')) {
        return { rows: [], rowCount: Math.min(5, Number(params[0])) }
      }
      throw new Error(`unexpected SQL in mock: ${sql}`)
    },
    release() {
      released = true
    },
  }

  const now = Date.parse('2026-11-28T12:00:00.000Z')
  const res = await runRetentionCleanupAsync(
    { query: async () => ({}), connect: async () => client },
    { retainDays: 7, debugRetainDays: 3, maxBytes: 3000, now },
  )

  assert.equal(res.skipped, false)
  assert.equal(res.usage_logs, 11_200)
  assert.equal(res.usage_batches, 3)
  assert.equal(res.debug_by_age, 5_300)
  // Pass 1: need=8 (capped by mock 5 -> 5), Pass 2: need=3 (-> 3), Pass 3: 2000 <= 3000 stop
  assert.equal(res.debug_by_size, 8)
  assert.equal(res.request_log_debug, 5_308)
  assert.equal(savedPrunedThrough, new Date(now - 7 * 86400_000).toISOString())
  assert.equal(unlocked, true)
  assert.equal(released, true)

  // Verify constructor validation and pure helpers explicitly
  assert.throws(() => new PgLogWriter(null), TypeError)
  const built = buildMultiRowInsert(
    't',
    ['a', 'b'],
    [
      [1, 2],
      [3, 4],
    ],
    'ON CONFLICT DO NOTHING',
  )
  assert.equal(built.sql, 'INSERT INTO t (a, b) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING')
  assert.deepEqual(built.params, [1, 2, 3, 4])
  const normAtt = normalizeAttemptRecord({ requestId: 'r\x001', attemptNo: 1, cooldownUntil: '1700000000000' })
  assert.equal(normAtt.request_id, 'r1')
  assert.equal(normAtt.cooldown_until, 1700000000000)

  // 3. Monotonic guard: when existing pruned_through is NEWER than cutoff, do NOT overwrite
  let updatedSettings = false
  const monoPool = createMockPool((sql) => {
    if (sql.includes('WITH doomed AS')) return { rows: [{ deleted_count: 1, archived_accounts: 1 }] }
    if (sql.startsWith('SELECT value FROM settings')) {
      return { rows: [{ value: JSON.stringify('2099-01-01T00:00:00.000Z') }] }
    }
    if (sql.startsWith('INSERT INTO settings')) {
      updatedSettings = true
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  const monoRes = await runRetentionCleanupAsync(monoPool, { retainDays: 7, now, advisoryLock: false })
  assert.equal(monoRes.usage_logs, 1)
  assert.equal(updatedSettings, false)
})

test('Live PostgreSQL end-to-end: migration 011, PgLogWriter multi-row writes, and runRetentionCleanupAsync', {
  skip: !PG_URL,
}, async () => {
  const schema = `vm2api_pglog_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const admin = new pg.Client({ connectionString: PG_URL })
  await admin.connect()
  await admin.query(`CREATE SCHEMA "${schema}"`)
  await admin.end()

  const u = new URL(PG_URL)
  u.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new pg.Pool({ connectionString: u.toString() })

  try {
    await applyPgMigrations(pool)

    // Verify duplicate indexes are absent while unique idx_reqlog_reqid and idx_reqlog_ts remain
    const idxRes = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'usage_logs'`,
      [schema],
    )
    const names = new Set(idxRes.rows.map((r) => r.indexname))
    assert.equal(names.has('idx_reqlog_cost_ts'), false)
    assert.equal(names.has('idx_usage_logs_request_id'), false)
    assert.equal(names.has('idx_reqlog_reqid'), true)
    assert.equal(names.has('idx_reqlog_ts'), true)

    const writer = createPgLogWriter(pool, { batchSize: 16, flushIntervalMs: 5000 })
    const oldTs = '2026-10-01T00:00:00.000Z'
    const newTs = '2026-11-28T10:00:00.000Z'

    writer.enqueueUsageLog(
      {
        id: 'log_old_1',
        request_id: 'req_old_1',
        created_at: oldTs,
        vm_id: 'vm-1',
        final_account_id: 'acc-live',
        status: 200,
        input_tokens: 100,
        output_tokens: 50,
        total_cost: 0.25,
      },
      { request_id: 'req_old_1', body: 'old debug payload' },
    )
    writer.enqueueUsageLog(
      {
        id: 'log_new_1',
        request_id: 'req_new_1',
        created_at: newTs,
        vm_id: 'vm-1',
        account_id: 'acc-live',
        status: 200,
        input_tokens: 20,
        output_tokens: 10,
        total_cost: 0.05,
      },
      { request_id: 'req_new_1', body: 'new debug payload' },
    )
    writer.enqueueAttempt({
      requestId: 'req_new_1',
      attemptNo: 1,
      vmId: 'vm-1',
      accountId: 'acc-live',
      startedAt: newTs,
      terminalState: 'started',
    })
    await writer.flush()

    // Second batch updates existing attempt via ON CONFLICT (request_id, attempt_no) DO UPDATE
    // and tests ON CONFLICT (request_id) DO NOTHING on usage_logs
    writer.enqueueUsageLog({
      id: 'log_new_1_dup',
      request_id: 'req_new_1',
      created_at: newTs,
      status: 500,
    })
    writer.enqueueAttempt({
      requestId: 'req_new_1',
      attemptNo: 1,
      completedAt: '2026-11-28T10:00:02.000Z',
      upstreamStatus: 200,
      downstreamCommitted: true,
      terminalState: 'succeeded',
    })
    await writer.close()

    const usageRows = (await pool.query('SELECT id, request_id, status FROM usage_logs ORDER BY created_at')).rows
    assert.equal(usageRows.length, 2)
    assert.equal(usageRows[1].status, 200)

    const attRows = (await pool.query('SELECT * FROM request_attempts WHERE request_id = $1', ['req_new_1'])).rows
    assert.equal(attRows.length, 1)
    assert.equal(attRows[0].vm_id, 'vm-1')
    assert.equal(attRows[0].terminal_state, 'succeeded')
    assert.equal(Number(attRows[0].downstream_committed), 1)

    const clean = await runRetentionCleanupAsync(pool, {
      retainDays: 7,
      debugRetainDays: 3,
      batchSize: 1,
      now: Date.parse('2026-11-28T12:00:00.000Z'),
    })
    assert.equal(clean.usage_logs, 1)
    assert.equal(clean.debug_by_age, 1)

    const arch = (await pool.query('SELECT account_id, total_cost, total_tokens FROM account_lifetime_usage_archive'))
      .rows
    assert.deepEqual(arch, [{ account_id: 'acc-live', total_cost: 0.25, total_tokens: '150' }])
  } finally {
    await pool.end()
    const cleanup = new pg.Client({ connectionString: PG_URL })
    await cleanup.connect()
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await cleanup.end()
  }
})
