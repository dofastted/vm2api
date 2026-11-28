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
  buildUnnestInsert,
  createPgLogWriter,
  flushPgLogWriter,
  getPgLogWriter,
  normalizeAttemptRecord,
  normalizeDebugRecord,
  PgLogWriter,
  REQUEST_ATTEMPT_COLUMN_TYPES,
  REQUEST_ATTEMPT_COLUMNS,
  REQUEST_DEBUG_COLUMN_TYPES,
  REQUEST_DEBUG_COLUMNS,
  runRetentionCleanupAsync,
  startPgLogWriter,
  stopPgLogWriter,
  USAGE_LOG_COLUMN_TYPES,
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

function createTransactionalMockPool(handler) {
  const calls = []
  let activeClients = 0
  let maxConcurrentClients = 0
  let releasedClients = 0
  const pool = {
    calls,
    get activeClients() {
      return activeClients
    },
    get maxConcurrentClients() {
      return maxConcurrentClients
    },
    get releasedClients() {
      return releasedClients
    },
    async query(sql, params = []) {
      calls.push({ via: 'pool', sql, params })
      if (handler) return handler(sql, params, calls.length)
      return { rows: [], rowCount: 0 }
    },
    async connect() {
      activeClients += 1
      if (activeClients > maxConcurrentClients) maxConcurrentClients = activeClients
      return {
        async query(sql, params = []) {
          calls.push({ via: 'client', sql, params })
          if (handler) return handler(sql, params, calls.length)
          return { rows: [], rowCount: 0 }
        },
        release() {
          activeClients -= 1
          releasedClients += 1
        },
      }
    },
  }
  return pool
}

function parsePgTableColumnTypes(tableName) {
  const typeMap = new Map()
  const files = ['001_init.sql', '006_log_error_details_and_hop_correlation.sql', '007_usage_logs_advisor_billing.sql']
  for (const f of files) {
    const sql = fs.readFileSync(path.join(PG_MIGRATIONS_DIR, f), 'utf8')
    const createRe = new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}\\s*\\(([\\s\\S]*?)\\);`, 'i')
    const m = sql.match(createRe)
    if (m) {
      for (const rawLine of m[1].split('\n')) {
        const line = rawLine.trim().replace(/,$/, '')
        if (!line || line.startsWith('--') || /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(line)) continue
        const colMatch = line.match(/^([a-z0-9_]+)\s+(DOUBLE PRECISION|BIGSERIAL|BIGINT|INTEGER|TEXT|BOOLEAN)\b/i)
        if (colMatch) {
          typeMap.set(colMatch[1], colMatch[2].toLowerCase())
        }
      }
    }
    const alterRe = new RegExp(
      `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ([a-z0-9_]+)\\s+(DOUBLE PRECISION|BIGINT|INTEGER|TEXT|BOOLEAN)\\b`,
      'gi',
    )
    for (const am of sql.matchAll(alterRe)) {
      typeMap.set(am[1], am[2].toLowerCase())
    }
  }
  return typeMap
}

test('PG migrations 011 and 012 optimize usage_logs/request_attempts/account_allocations indexes idempotently', async () => {
  const mig011 = '011_drop_duplicate_usage_logs_indexes.sql'
  const mig012 = '012_optimize_usage_logs_and_attempts_indexes.sql'
  const sql011 = fs.readFileSync(path.join(PG_MIGRATIONS_DIR, mig011), 'utf8')
  const sql012 = fs.readFileSync(path.join(PG_MIGRATIONS_DIR, mig012), 'utf8')

  assert.match(sql011, /DROP INDEX IF EXISTS idx_reqlog_cost_ts;/i)
  assert.match(sql011, /DROP INDEX IF EXISTS idx_usage_logs_request_id;/i)
  assert.doesNotMatch(sql011, /DROP INDEX[^\n]*idx_reqlog_reqid/i, '011 must preserve UNIQUE idx_reqlog_reqid')

  // 012 drops verified duplicate & low-value indexes and adds account_allocations composite index
  for (const idx of [
    'idx_request_attempt_request',
    'idx_reqlog_ts',
    'idx_reqlog_requested_model',
    'idx_reqlog_status',
    'idx_usage_logs_group_created',
    'idx_usage_logs_inbound_device',
    'idx_usage_logs_api_key_status_created',
    'idx_usage_logs_model_created',
    'idx_usage_logs_session_created',
    'idx_reqlog_account',
  ]) {
    assert.match(sql012, new RegExp(`DROP INDEX IF EXISTS ${idx};`, 'i'), `012 must drop ${idx}`)
  }
  for (const keep of [
    'idx_reqlog_reqid',
    'idx_usage_logs_created_id',
    'idx_reqlog_key',
    'idx_usage_logs_user_created',
    'idx_usage_logs_vm_owner',
    'idx_reqlog_vm',
    'idx_usage_logs_outbound_session_created',
    'idx_usage_logs_upstream_400',
    'idx_usage_logs_pricing_null',
    'idx_request_attempt_unique',
    'idx_request_attempt_account',
  ]) {
    assert.doesNotMatch(sql012, new RegExp(`DROP INDEX[^;]*\\b${keep}\\b`, 'i'), `012 must preserve ${keep}`)
  }
  assert.match(
    sql012,
    /CREATE INDEX IF NOT EXISTS idx_alloc_account_id_desc\s+ON account_allocations \(account_id, id DESC\);/i,
  )

  // Verify applyPgMigrations loads and applies 011 & 012 cleanly and idempotently via mock client
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
  assert.equal(first.at(-1), mig012)
  assert.ok(executedSql.some((s) => s.includes('DROP INDEX IF EXISTS idx_reqlog_cost_ts')))
  assert.ok(executedSql.some((s) => s.includes('DROP INDEX IF EXISTS idx_request_attempt_request')))
  assert.ok(executedSql.some((s) => s.includes('idx_alloc_account_id_desc')))

  const second = await applyPgMigrations(mockPool)
  assert.deepEqual(second, [])
})

test('USAGE_LOG_COLUMNS, REQUEST_ATTEMPT_COLUMNS, and PG UNNEST types stay in 100% parity with live schema & DDL', () => {
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

  // Exact column-by-column PG DDL type verification (prevents PG 18 UNNEST cast mismatches)
  assert.equal(USAGE_LOG_COLUMNS.length, 76)
  assert.equal(USAGE_LOG_COLUMN_TYPES.length, 76)
  const usageDdlTypes = parsePgTableColumnTypes('usage_logs')
  for (let i = 0; i < USAGE_LOG_COLUMNS.length; i += 1) {
    const col = USAGE_LOG_COLUMNS[i]
    assert.equal(USAGE_LOG_COLUMN_TYPES[i], usageDdlTypes.get(col), `usage_logs.${col} UNNEST type must match PG DDL`)
  }

  assert.equal(REQUEST_ATTEMPT_COLUMNS.length, 28)
  assert.equal(REQUEST_ATTEMPT_COLUMN_TYPES.length, 28)
  const attemptDdlTypes = parsePgTableColumnTypes('request_attempts')
  for (let i = 0; i < REQUEST_ATTEMPT_COLUMNS.length; i += 1) {
    const col = REQUEST_ATTEMPT_COLUMNS[i]
    assert.equal(
      REQUEST_ATTEMPT_COLUMN_TYPES[i],
      attemptDdlTypes.get(col),
      `request_attempts.${col} UNNEST type must match PG DDL`,
    )
  }

  assert.equal(REQUEST_DEBUG_COLUMNS.length, 3)
  assert.deepEqual([...REQUEST_DEBUG_COLUMN_TYPES], ['text', 'text', 'text'])
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

test('PgLogWriter batches usage_logs via fixed-76-param UNNEST INSERT with scalable defaults', async () => {
  const pool = createMockPool()
  const writer = createPgLogWriter(pool, { flushIntervalMs: 5000 })
  assert.equal(writer.batchSize, 256)
  assert.equal(writer.maxPending, 20_000)
  assert.equal(writer.concurrency, 2)
  assert.equal(writer.synchronousCommit, false)

  writer.enqueueUsageLog({
    id: 'log_a',
    request_id: 'req_a',
    ts: '2026-11-28T10:00:00.000Z',
    status: 200,
    duration_ms: 123.8,
    model: 'm1',
    total_cost: 0.015,
  })
  writer.enqueueUsageLog({
    id: 'log_b',
    request_id: 'req_b',
    ts: '2026-11-28T10:00:01.000Z',
    status: 201,
    duration_ms: '',
    model: 'm2',
    total_cost: null,
  })
  // Duplicate request_id within the same batch collapses cleanly to keep first row
  writer.enqueueUsageLog({ id: 'log_a_dup', request_id: 'req_a', ts: '2026-11-28T10:00:02.000Z', status: 500 })

  assert.equal(writer.pending(), 3)
  assert.equal(pool.calls.length, 0)

  const st = await writer.flush()
  assert.equal(pool.calls.length, 1)
  assert.match(
    pool.calls[0].sql,
    /^INSERT INTO usage_logs \(id, request_id, .*\) SELECT \* FROM UNNEST\(\$1::text\[\], \$2::text\[\], .*\$76::text\[\]\) ON CONFLICT \(request_id\) DO NOTHING$/,
  )
  // Fixed 76 array parameters regardless of row count
  assert.equal(pool.calls[0].params.length, USAGE_LOG_COLUMNS.length)
  assert.deepEqual(pool.calls[0].params[0], ['log_a', 'log_b'])
  assert.deepEqual(pool.calls[0].params[1], ['req_a', 'req_b'])
  // Float duration_ms truncated to integer for bigint[] and empty string coerced to null
  const durIdx = USAGE_LOG_COLUMNS.indexOf('duration_ms')
  assert.deepEqual(pool.calls[0].params[durIdx], [123, null])
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

test('PgLogWriter UNNEST breaks the 65535 PG bind-parameter limit (1000 usage_logs rows = 76 params in 1 SQL)', async () => {
  const pool = createMockPool()
  const writer = createPgLogWriter(pool, { batchSize: 1000, flushIntervalMs: 5000 })
  for (let i = 0; i < 1000; i += 1) {
    writer.enqueueUsageLog({ id: `l_${i}`, request_id: `r_${i}`, ts: '2026-11-28T10:00:00.000Z', status: 200 })
  }
  const st = await writer.flush()
  // 1000 * 76 = 76,000 VALUES params (>65,535 PG limit), yet UNNEST needs only 76 params in 1 query!
  assert.equal(pool.calls.length, 1)
  assert.equal(pool.calls[0].params.length, 76)
  assert.equal(pool.calls[0].params[0].length, 1000)
  assert.equal(st.flushed, 1000)
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

test('PgLogWriter legacy VALUES mode chunks multi-row INSERTs below maxParamsPerQuery and buildUnnestInsert validates types', async () => {
  const pool = createMockPool()
  // 76 cols * 3 rows = 228 <= 256, so 5 rows with maxParamsPerQuery=256 splits into 3 + 2
  const writer = createPgLogWriter(pool, {
    useUnnest: false,
    batchSize: 10,
    maxParamsPerQuery: 256,
    flushIntervalMs: 5000,
  })
  for (let i = 0; i < 5; i += 1) {
    writer.enqueueUsageLog({ id: `l${i}`, request_id: `r${i}`, ts: '2026-11-28T10:00:00.000Z' })
  }
  await writer.flush()
  assert.equal(pool.calls.length, 2)
  assert.equal(pool.calls[0].params.length, USAGE_LOG_COLUMNS.length * 3)
  assert.equal(pool.calls[1].params.length, USAGE_LOG_COLUMNS.length * 2)
  assert.equal(writer.stats().flushed, 5)
  await writer.close()

  assert.throws(() => buildUnnestInsert('t', ['a', 'b'], ['text'], [['x', 'y']]), TypeError)
})

test('PgLogWriter coalesces same-batch begin+complete request_attempts into fixed-28-param UNNEST upsert', async () => {
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
    /^INSERT INTO request_attempts \(.*\) SELECT \* FROM UNNEST\(\$1::text\[\], \$2::integer\[\], .*\$28::text\[\]\) ON CONFLICT \(request_id, attempt_no\) DO UPDATE SET/s,
  )
  // Fixed 28 column arrays, each holding 2 coalesced rows
  assert.equal(pool.calls[0].params.length, REQUEST_ATTEMPT_COLUMNS.length)
  assert.equal(pool.calls[0].params[0].length, 2)

  const row1 = Object.fromEntries(REQUEST_ATTEMPT_COLUMNS.map((c, i) => [c, pool.calls[0].params[i][0]]))
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

test('PgLogWriter runs SET LOCAL synchronous_commit = off in dedicated tx by default and honors VM2API_LOG_SYNC_COMMIT=on', async () => {
  // 1. Default (synchronousCommit = false) wraps batch write in BEGIN -> SET LOCAL -> INSERT -> COMMIT
  const txPool = createTransactionalMockPool()
  const writerOff = createPgLogWriter(txPool, { batchSize: 16, flushIntervalMs: 5000 })
  writerOff.enqueueUsageLog({ id: 'sync_1', request_id: 'req_sync_1', ts: '2026-11-28T10:00:00.000Z' })
  await writerOff.flush()

  assert.deepEqual(
    txPool.calls.map((c) => (c.sql.startsWith('INSERT INTO') ? 'INSERT' : c.sql)),
    ['BEGIN', 'SET LOCAL synchronous_commit = off', 'INSERT', 'COMMIT'],
  )
  assert.equal(txPool.activeClients, 0)
  assert.equal(txPool.releasedClients, 1)
  await writerOff.close()

  // 2. Env VM2API_LOG_SYNC_COMMIT=on skips SET LOCAL tx and issues direct pool.query
  const prevEnv = process.env.VM2API_LOG_SYNC_COMMIT
  process.env.VM2API_LOG_SYNC_COMMIT = 'on'
  try {
    const syncPool = createTransactionalMockPool()
    const writerOn = createPgLogWriter(syncPool, { batchSize: 16, flushIntervalMs: 5000 })
    assert.equal(writerOn.synchronousCommit, true)
    writerOn.enqueueUsageLog({ id: 'sync_2', request_id: 'req_sync_2', ts: '2026-11-28T10:00:00.000Z' })
    await writerOn.flush()

    assert.equal(syncPool.calls.length, 1)
    assert.equal(syncPool.calls[0].via, 'pool')
    assert.match(syncPool.calls[0].sql, /^INSERT INTO usage_logs/)
    assert.equal(syncPool.releasedClients, 0)
    await writerOn.close()
  } finally {
    if (prevEnv === undefined) delete process.env.VM2API_LOG_SYNC_COMMIT
    else process.env.VM2API_LOG_SYNC_COMMIT = prevEnv
  }

  // 3. Batch failure inside SET LOCAL tx executes ROLLBACK, releases client, and falls back row-by-row
  const errPool = createTransactionalMockPool((sql, params) => {
    if (sql.startsWith('INSERT INTO') && Array.isArray(params[1]) && params[1].includes('req_bad_tx')) {
      throw new Error('bad row in tx')
    }
    return { rows: [], rowCount: 1 }
  })
  const writerErr = createPgLogWriter(errPool, {
    batchSize: 16,
    flushIntervalMs: 5000,
    onError: () => {},
  })
  writerErr.enqueueUsageLog({ id: 'tx_ok', request_id: 'req_ok_tx', ts: '2026-11-28T10:00:00.000Z' })
  writerErr.enqueueUsageLog({ id: 'tx_bad', request_id: 'req_bad_tx', ts: '2026-11-28T10:00:00.000Z' })
  const st = await writerErr.flush()
  assert.equal(st.flushed, 1)
  assert.equal(st.dropped, 1)
  assert.equal(errPool.activeClients, 0, 'all checked-out clients must be released after rollback')
  assert.ok(errPool.calls.some((c) => c.sql === 'ROLLBACK'))
  await writerErr.close()
})

test('PgLogWriter runs up to configured concurrency channels in parallel and flush()/close() drain all channels', async () => {
  let inFlightInserts = 0
  let maxParallelInserts = 0
  const persisted = []

  const pool = createTransactionalMockPool(async (sql, params) => {
    if (sql.startsWith('INSERT INTO usage_logs')) {
      inFlightInserts += 1
      if (inFlightInserts > maxParallelInserts) maxParallelInserts = inFlightInserts
      await new Promise((r) => setTimeout(r, 20))
      for (const reqId of params[1]) persisted.push(reqId)
      inFlightInserts -= 1
    }
    return { rows: [], rowCount: 1 }
  })

  const writer = createPgLogWriter(pool, {
    concurrency: 3,
    batchSize: 2,
    flushIntervalMs: 5000,
  })
  assert.equal(writer.concurrency, 3)

  for (let i = 1; i <= 8; i += 1) {
    writer.enqueueUsageLog({ id: `c_${i}`, request_id: `req_c_${i}`, ts: '2026-11-28T10:00:00.000Z' })
  }

  const st = await writer.close()
  assert.equal(maxParallelInserts, 3, '3 writer channels must execute batches concurrently')
  assert.equal(st.closed, true)
  assert.equal(st.queued, 0)
  assert.equal(st.activeChannels, 0)
  assert.equal(st.flushed, 8)
  assert.equal(st.dropped, 0)
  assert.equal(pool.activeClients, 0)
  assert.deepEqual(persisted.sort(), [
    'req_c_1',
    'req_c_2',
    'req_c_3',
    'req_c_4',
    'req_c_5',
    'req_c_6',
    'req_c_7',
    'req_c_8',
  ])
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
  const pool = createMockPool((_sql, params) => {
    const reqIds = params[1]
    // Reject any query containing poison request_id 'req_poison'
    if (reqIds.includes('req_poison')) {
      throw new Error(`constraint violation on ${reqIds.length}-row insert`)
    }
    for (const reqId of reqIds) {
      persisted.push(reqId)
    }
    return { rows: [], rowCount: reqIds.length }
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
    const reqIds = params[1]
    for (const reqId of reqIds) {
      persisted.push(reqId)
    }
    return { rows: [], rowCount: reqIds.length }
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
    const reqIds = params[1]
    for (const reqId of reqIds) {
      persisted.push(reqId)
    }
    return { rows: [], rowCount: reqIds.length }
  })

  const writer = createPgLogWriter(pool, { batchSize: 2, concurrency: 1, flushIntervalMs: 5000 })
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

test('Live PostgreSQL end-to-end: migrations 011+012, UNNEST PgLogWriter, and runRetentionCleanupAsync', {
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

    // Verify 011 + 012 dropped redundant indexes while preserving required indexes
    const idxRes = await pool.query(
      `SELECT tablename, indexname FROM pg_indexes WHERE schemaname = $1 AND tablename IN ('usage_logs', 'request_attempts', 'account_allocations')`,
      [schema],
    )
    const usageNames = new Set(idxRes.rows.filter((r) => r.tablename === 'usage_logs').map((r) => r.indexname))
    for (const gone of [
      'idx_reqlog_cost_ts',
      'idx_usage_logs_request_id',
      'idx_reqlog_ts',
      'idx_reqlog_requested_model',
      'idx_reqlog_status',
      'idx_usage_logs_group_created',
      'idx_usage_logs_inbound_device',
      'idx_usage_logs_api_key_status_created',
      'idx_usage_logs_model_created',
      'idx_usage_logs_session_created',
      'idx_reqlog_account',
    ]) {
      assert.equal(usageNames.has(gone), false, `expected ${gone} dropped`)
    }
    for (const kept of [
      'usage_logs_pkey',
      'idx_reqlog_reqid',
      'idx_usage_logs_created_id',
      'idx_reqlog_key',
      'idx_usage_logs_user_created',
      'idx_usage_logs_vm_owner',
      'idx_reqlog_vm',
      'idx_usage_logs_outbound_session_created',
      'idx_usage_logs_upstream_400',
      'idx_usage_logs_pricing_null',
    ]) {
      assert.equal(usageNames.has(kept), true, `expected ${kept} preserved`)
    }
    const attemptNames = new Set(idxRes.rows.filter((r) => r.tablename === 'request_attempts').map((r) => r.indexname))
    assert.equal(attemptNames.has('idx_request_attempt_request'), false)
    assert.equal(attemptNames.has('idx_request_attempt_unique'), true)

    const allocNames = new Set(idxRes.rows.filter((r) => r.tablename === 'account_allocations').map((r) => r.indexname))
    assert.equal(allocNames.has('idx_alloc_account_id_desc'), true)

    const writer = createPgLogWriter(pool, { batchSize: 16, concurrency: 2, flushIntervalMs: 5000 })
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
