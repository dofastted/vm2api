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
import { MIGRATION_TABLES, migrateSqliteToPostgres } from '../../scripts/migrate-sqlite-to-pg.mjs'
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

test('migrateSqliteToPostgres transfers tables, sanitizes NUL bytes, resets sequences, verifies parity, and is idempotent', {
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
    db.close()

    // First migration run with verify + rollup
    const r1 = await migrateSqliteToPostgres({
      sqlitePath,
      pgUrl: schemaUrl,
      verify: true,
      rollup: true,
    })
    assert.equal(r1.ok, true)
    assert.equal(r1.verification.ok, true)
    assert.equal(r1.verification.mismatches, 0)
    assert.ok(r1.totalNulSanitized >= 3)
    assert.ok(r1.rollup.hourlyBuckets >= 1)

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
