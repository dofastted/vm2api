/**
 * SQLite -> PostgreSQL streaming migrator integration test.
 * Runs when `VM2API_TEST_PG_URL` is set; skips cleanly otherwise.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { RequestAttemptsRepo, normalizeCooldownUntilMs } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { createPgSyncDb } from '../../src/lib/db/pg/pg-sync-db.mjs'
import { resolvePgConfig } from '../../src/lib/db/pg/config.mjs'
import {
  DB_CREATED_AT_SETTING_KEY,
  MIGRATION_TABLES,
  migrateSqliteToPostgres,
  preflightSqliteToPostgres,
  sanitizeValue,
} from '../../scripts/migrate-sqlite-to-pg.mjs'
import { seedMockSqlite } from '../../scripts/seed-mock-sqlite.mjs'

const PG_URL = process.env.VM2API_TEST_PG_URL || ''

test('MIGRATION_TABLES and seedMockSqlite cover every active SQLite table including gemini_environment_owners', () => {
  assert.ok(MIGRATION_TABLES.includes('gemini_environment_owners'))
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-seed-check-'))
  try {
    const outPath = path.join(tmpDir, 'mock.db')
    const seeded = seedMockSqlite({ outPath, usageCount: 20 })
    const empty = Object.entries(seeded.tableCounts)
      .filter(([, count]) => count === 0)
      .map(([name]) => name)
    assert.deepEqual(empty, [])
    assert.ok(seeded.tableCounts.gemini_environment_owners >= 1)
    for (const table of Object.keys(seeded.tableCounts)) {
      if (table === 'schema_migrations') continue
      assert.ok(MIGRATION_TABLES.includes(table), `MIGRATION_TABLES missing active table: ${table}`)
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('preflightSqliteToPostgres validates clean DB and blocks unmapped tables, CI username dupes, and NULL timestamps', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-preflight-'))
  try {
    const cleanPath = path.join(tmpDir, 'clean.db')
    const cleanDb = createDatabase({ dbPath: cleanPath })
    cleanDb.close()

    const okReport = await preflightSqliteToPostgres({ sqlitePath: cleanPath })
    assert.equal(okReport.ok, true)
    assert.deepEqual(okReport.blockingIssues, [])
    assert.deepEqual(okReport.unmappedTables, [])
    assert.ok(okReport.migrations.count >= 60)

    const badPath = path.join(tmpDir, 'bad.db')
    const badDb = createDatabase({ dbPath: badPath })
    badDb.exec('CREATE TABLE unexpected_new_table (id TEXT PRIMARY KEY)')
    badDb.exec('DROP INDEX IF EXISTS idx_users_username_active')
    badDb
      .prepare(
        'INSERT INTO users (id, email, username, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('u_a', 'a@test.com', 'Alice', 'h1', 'user', 'active', '2026-01-01T00:00:00.000Z')
    badDb
      .prepare(
        'INSERT INTO users (id, email, username, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('u_b', 'b@test.com', 'alice', 'h2', 'user', 'active', '2026-01-01T00:00:00.000Z')
    badDb
      .prepare('INSERT INTO usage_logs (id, request_id, created_at, status) VALUES (?, ?, ?, ?)')
      .run('log_null_ts', 'req_null_ts', '', 200)
    badDb.close()

    const badReport = await preflightSqliteToPostgres({ sqlitePath: badPath })
    assert.equal(badReport.ok, false)
    assert.deepEqual(badReport.unmappedTables, ['unexpected_new_table'])
    assert.ok(badReport.blockingIssues.some((s) => s.includes('unexpected_new_table')))
    assert.ok(badReport.blockingIssues.some((s) => s.includes('duplicate active username')))
    assert.ok(badReport.blockingIssues.some((s) => s.includes('NULL/empty created_at')))
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('request_attempts.cooldown_until normalizes legacy ISO-8601 strings to integer epoch ms in repo and migrator', () => {
  const iso = '2026-11-25T01:30:11.033Z'
  const expectedMs = Date.parse(iso)
  assert.equal(normalizeCooldownUntilMs(iso), expectedMs)
  assert.equal(normalizeCooldownUntilMs(expectedMs + 0.7), expectedMs)
  assert.equal(normalizeCooldownUntilMs(String(expectedMs)), expectedMs)
  assert.equal(normalizeCooldownUntilMs(''), null)
  assert.equal(normalizeCooldownUntilMs('not-a-date'), null)

  assert.equal(sanitizeValue('request_attempts', 'cooldown_until', iso), expectedMs)
  assert.equal(sanitizeValue('request_attempts', 'cooldown_until', expectedMs), expectedMs)
  assert.equal(sanitizeValue('request_attempts', 'cooldown_until', ''), null)
  assert.equal(sanitizeValue('request_attempts', 'cooldown_until', 'garbage'), null)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-attempts-cooldown-'))
  try {
    const db = createDatabase({ dbPath: path.join(tmpDir, 'kin.db') })
    const repo = new RequestAttemptsRepo(db)
    repo.begin({ requestId: 'req-iso', attemptNo: 1, vmId: 'vm-1', accountId: 'acc-1', model: 'gemini-2.5-pro' })
    repo.complete('req-iso', 1, {
      upstreamStatus: 429,
      errorScope: 'quota',
      action: 'failover',
      cooldownUntil: iso,
      terminalState: 'failed_retryable',
    })
    const rows = repo.list('req-iso')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].cooldown_until, expectedMs)
    assert.equal(typeof rows[0].cooldown_until, 'number')
    db.close()
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('#1845: SQLite 069 and PostgreSQL 006 migrations add identical usage_logs and request_attempts columns', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
  const pgSql = fs.readFileSync(
    path.join(root, 'src/lib/db/pg/pg-migrations/006_log_error_details_and_hop_correlation.sql'),
    'utf8',
  )
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-069-parity-'))
  try {
    const db = createDatabase({ dbPath: path.join(tmpDir, 'kin.db') })
    const cols = (table) =>
      new Set(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => row.name),
      )
    const usageCols = cols('usage_logs')
    const attemptCols = cols('request_attempts')
    db.close()

    const expectedUsage = ['upstream_type', 'error_details']
    const expectedAttempts = [
      'error_code',
      'upstream_type',
      'error_details_json',
      'hop_request_id',
      'provider_run_id',
      'provider_turn_id',
      'provider_attempt_id',
      'provider_request_id',
    ]
    for (const col of expectedUsage) {
      assert.ok(usageCols.has(col), `SQLite usage_logs missing ${col}`)
      assert.match(pgSql, new RegExp(`ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS ${col}\\b`))
    }
    for (const col of expectedAttempts) {
      assert.ok(attemptCols.has(col), `SQLite request_attempts missing ${col}`)
      assert.match(pgSql, new RegExp(`ALTER TABLE request_attempts ADD COLUMN IF NOT EXISTS ${col}\\b`))
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('migrateSqliteToPostgres transfers tables, sanitizes NUL bytes, reconciles seeded groups, preserves origin created_at, resets sequences, verifies parity, and is idempotent', {
  skip: !PG_URL,
}, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-mig-test-'))
  const sqlitePath = path.join(tmpDir, 'kin.db')
  const schema = `vm2api_mig_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const admin = new pg.Client({ connectionString: PG_URL })
  await admin.connect()
  await admin.query(`CREATE SCHEMA "${schema}"`)
  await admin.end()

  const u = new URL(PG_URL)
  u.searchParams.set('options', `-c search_path=${schema}`)
  const schemaUrl = u.toString()

  try {
    const db = createDatabase({ dbPath: sqlitePath })
    const now = new Date().toISOString()

    // Stamp an older historical migration 001 date and customize default groups to test seed reconciliation
    const historicalOrigin = '2025-09-07T06:46:08.235Z'
    db.prepare("UPDATE schema_migrations SET applied_at = ? WHERE version = '001'").run(historicalOrigin)
    db.prepare('DELETE FROM groups WHERE id = 2').run()
    db.prepare('UPDATE groups SET name = ? WHERE id = 1').run('custom_coding')

    // Seed diverse tables including real NUL bytes (via BLOB so node:sqlite preserves embedded \x00), self-FK cluster_nodes, crag_shop_orders slot_limit, and usage_logs
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'site_title',
      Buffer.from('"hello\x00pg"'),
      now,
    )
    db.prepare(
      'INSERT INTO users (id, email, username, password_hash, role, balance, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('u1', 'u1@example.com', 'UserOne', 'h1', 'admin', 42.5, 'active', now)
    db.prepare(
      'INSERT INTO cluster_nodes (id, label, host, port, username, auth_type, host_key_alg, host_key_sha256, jump_node_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('node_child', 'Child', '10.0.0.2', 22, 'root', 'key', 'ssh-ed25519', 'abc', null, now, now)
    db.prepare(
      'INSERT INTO cluster_nodes (id, label, host, port, username, auth_type, host_key_alg, host_key_sha256, jump_node_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('node_jump', 'Jump', '10.0.0.1', 22, 'root', 'key', 'ssh-ed25519', 'def', null, now, now)
    db.prepare('UPDATE cluster_nodes SET jump_node_id = ? WHERE id = ?').run('node_jump', 'node_child')

    db.prepare(
      `INSERT INTO crag_shop_orders (order_id, owner, request_id, sku, payment_method, reserved_at, status, created_at, term, amount_minor, slot_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ord_1', 'panel:u1', 'req-1', 'pro', 'wxpay', 1700000000, 'paid', 1700000001, '1m', 9900, 5n)
    db.prepare(
      `INSERT INTO crag_shop_orders (order_id, owner, request_id, sku, payment_method, reserved_at, status, created_at, term, amount_minor, slot_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ord_2', 'panel:u1', 'req-2', 'pro', 'alipay', 1700000010, 'paid', 1700000011, '1y', 99900, 'unlimited')

    db.prepare(
      `INSERT INTO usage_logs (id, request_id, created_at, model, status, duration_ms, input_tokens, output_tokens, total_cost, actual_cost, user_id, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('log_1', 'req_1', now, 'claude-sonnet-4-5', 200, 350, 1200, 300, 0.012, 0.012, 'u1', Buffer.from('ok\x00msg'))
    db.prepare('INSERT INTO request_log_debug (request_id, ts, record_json) VALUES (?, ?, ?)').run(
      'req_1',
      now,
      Buffer.from('{"body":"clean\x00payload"}'),
    )
    db.prepare('INSERT INTO gemini_environment_owners (env_id, owner_user_id, created_at) VALUES (?, ?, ?)').run(
      'gemini-u1',
      'u1',
      now,
    )
    const legacyIsoCooldown = '2026-11-25T01:30:11.033Z'
    db.prepare(
      `INSERT INTO request_attempts (request_id, attempt_no, vm_id, account_id, model, started_at, cooldown_until, downstream_committed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('req_legacy_iso', 1, 'gemini-u1', 'gemini-u1', 'gemini-2.5-pro', now, legacyIsoCooldown, 0)
    db.close()

    // Preflight with live PG target must pass
    const pf = await preflightSqliteToPostgres({ sqlitePath, pgUrl: schemaUrl })
    assert.equal(pf.ok, true)
    assert.equal(pf.pgProbe?.ok, true)
    assert.equal(pf.pgProbe?.canCreate, true)

    // First migration run with verify + rollup
    const r1 = await migrateSqliteToPostgres({
      sqlitePath,
      pgUrl: schemaUrl,
      verify: true,
      rollup: true,
    })
    assert.equal(r1.ok, true)
    assert.equal(r1.originCreatedAt, historicalOrigin)
    assert.equal(r1.verification.ok, true)
    assert.equal(r1.verification.mismatches, 0)
    assert.equal(r1.verification.sequences.groups.ok, true)
    assert.ok(r1.totalNulSanitized >= 3)
    assert.ok(r1.rollup.hourlyBuckets >= 1)

    // Verify historical coverage start is preserved on PG via settings.usage_logs_db_created_at
    const syncDb = await createPgSyncDb(resolvePgConfig({ connectionString: schemaUrl }))
    try {
      const originRow = syncDb.prepare('SELECT value FROM settings WHERE key = ?').get(DB_CREATED_AT_SETTING_KEY)
      assert.equal(JSON.parse(originRow.value), historicalOrigin)
      const pgLogsRepo = new UsageLogsRepo(syncDb)
      assert.equal(pgLogsRepo.logCoverageStart(), historicalOrigin)
      const groups = syncDb.prepare('SELECT id, name FROM groups ORDER BY id').all()
      assert.deepEqual(groups, [{ id: 1, name: 'custom_coding' }])
      const attemptRow = syncDb
        .prepare('SELECT cooldown_until FROM request_attempts WHERE request_id = ?')
        .get('req_legacy_iso')
      assert.equal(Number(attemptRow.cooldown_until), Date.parse(legacyIsoCooldown))
    } finally {
      syncDb.close()
    }

    // Second run must be 100% idempotent (0 new inserts, still verified)
    const r2 = await migrateSqliteToPostgres({
      sqlitePath,
      pgUrl: schemaUrl,
      verify: true,
    })
    assert.equal(r2.ok, true)
    assert.equal(r2.verification.ok, true)
    assert.equal(r2.verification.mismatches, 0)
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
    const cleanup = new pg.Client({ connectionString: PG_URL })
    await cleanup.connect()
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await cleanup.end()
  }
})
