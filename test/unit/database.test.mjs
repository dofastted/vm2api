import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  openDatabase,
  closeDatabase,
  getDb,
  isDbOpen,
  getDbPath,
  applyMigrations,
  resolveDbPath,
  vacuumInto,
  withTransaction,
} from '../../src/lib/db/database.mjs'

let tmp

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-db-test-'))
})

afterEach(() => {
  closeDatabase()
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.KIN_DB_PATH
})

test('openDatabase creates db, applies migrations, WAL enabled', () => {
  const db = openDatabase({ dataDir: tmp })
  assert.ok(isDbOpen())
  assert.equal(getDbPath(), path.join(tmp, 'kin.db'))
  const mode = db.prepare('PRAGMA journal_mode').get()
  assert.equal(String(Object.values(mode)[0]).toLowerCase(), 'wal')
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name)
  for (const t of [
    'settings',
    'api_keys',
    'accounts',
    'account_allocations',
    'sticky_sessions',
    'proxies',
    'vms',
    'usage_logs',
    'request_log_debug',
    'backup_records',
    'account_runtime',
    'request_attempts',
    'schema_migrations',
    'api_endpoints',
    'api_endpoint_keys',
    'api_endpoint_models',
    'users',
    'groups',
    'account_groups',
    'redeem_codes',
  ]) {
    assert.ok(tables.includes(t), `missing table ${t}`)
  }
  const keyCols = db
    .prepare('PRAGMA table_info(api_keys)')
    .all()
    .map((r) => r.name)
  assert.ok(keyCols.includes('category'), 'api_keys missing category')
})

test('migration 005 adds protocol usage alignment columns', () => {
  const db = openDatabase({ dataDir: tmp })
  const cols = (table) =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => r.name)
  const reqCols = cols('usage_logs')
  for (const c of [
    'cache_creation_5m_tokens',
    'cache_creation_1h_tokens',
    'requested_model',
    'upstream_model',
    'model_mismatch',
    'first_token_ms',
    'stop_reason',
    'input_cost',
    'output_cost',
    'cache_read_cost',
    'cache_creation_cost',
    'total_cost',
    'pricing_model',
    'service_tier',
    'speed',
    'long_context',
  ])
    assert.ok(reqCols.includes(c), `usage_logs missing ${c}`)
  for (const c of ['cache_read_tokens', 'cache_creation_tokens']) {
    assert.ok(cols('accounts').includes(c), `accounts missing ${c}`)
    assert.ok(cols('api_keys').includes(c), `api_keys missing ${c}`)
  }
  // scheduling window columns now live on accounts (sub2api SSOT merge)
  const accCols = cols('accounts')
  for (const c of [
    'rate_limited_at',
    'rate_limit_reset_at',
    'overload_until',
    'session_window_start',
    'session_window_end',
    'session_window_status',
    'schedulable',
    'priority',
  ])
    assert.ok(accCols.includes(c), `accounts missing ${c}`)
})

test('pre-005 database upgrades in place and keeps old rows readable', () => {
  // Build a DB with migrations 001–004 only, insert a legacy row, then upgrade.
  const migSrc = path.resolve('src/lib/db/migrations')
  const oldDir = path.join(tmp, 'old-migs')
  fs.mkdirSync(oldDir, { recursive: true })
  for (const f of fs.readdirSync(migSrc)) {
    if (f < '005') fs.copyFileSync(path.join(migSrc, f), path.join(oldDir, f))
  }
  const dbPath = path.join(tmp, 'upgrade.db')
  const legacy = new DatabaseSync(dbPath)
  applyMigrations(legacy, { migrationsDir: oldDir })
  legacy
    .prepare(`
    INSERT INTO request_logs (id, request_id, ts, protocol, model, status, input_tokens, output_tokens)
    VALUES ('log_old', 'rid_old', ?, 'anthropic.messages', 'claude-sonnet-5', 200, 7, 2)
  `)
    .run(new Date().toISOString())
  legacy.close()

  process.env.KIN_DB_PATH = dbPath
  const db = openDatabase({ dbPath })
  const row = db.prepare('SELECT * FROM usage_logs WHERE request_id = ?').get('rid_old')
  assert.equal(row.input_tokens, 7)
  // migration 017 normalizes NULL token counters to 0
  assert.equal(row.cache_creation_5m_tokens, 0)
  assert.equal(row.stop_reason, null)
  // new rows can use the new columns
  db.prepare(`
    INSERT INTO usage_logs (id, request_id, created_at, protocol, model, status, upstream_model, stop_reason, first_token_ms)
    VALUES ('log_new', 'rid_new', ?, 'anthropic.messages', 'claude-sonnet-5', 200, 'claude-sonnet-5', 'end_turn', 21)
  `).run(new Date().toISOString())
  assert.equal(
    db.prepare('SELECT stop_reason FROM usage_logs WHERE request_id = ?').get('rid_new').stop_reason,
    'end_turn',
  )
})

test('openDatabase is idempotent singleton; getDb throws when closed', () => {
  const a = openDatabase({ dataDir: tmp })
  const b = openDatabase({ dataDir: path.join(tmp, 'other') })
  assert.equal(a, b)
  closeDatabase()
  assert.throws(() => getDb(), /not opened/)
})

test('migrations are idempotent across reopen', () => {
  openDatabase({ dataDir: tmp })
  closeDatabase()
  const db = openDatabase({ dataDir: tmp })
  const rows = db.prepare('SELECT version FROM schema_migrations').all()
  assert.equal(rows.length, new Set(rows.map((r) => r.version)).size)
})

test('checksum mismatch on applied migration throws', () => {
  const migDir = path.join(tmp, 'migs')
  fs.mkdirSync(migDir, { recursive: true })
  fs.writeFileSync(path.join(migDir, '001_a.sql'), 'CREATE TABLE t1 (a TEXT);')
  const db = new DatabaseSync(path.join(tmp, 'x.db'))
  applyMigrations(db, { migrationsDir: migDir })
  fs.writeFileSync(path.join(migDir, '001_a.sql'), 'CREATE TABLE t1 (a TEXT, b TEXT);')
  assert.throws(() => applyMigrations(db, { migrationsDir: migDir }), /checksum mismatch/)
  db.close()
})

test('CRLF-applied checksum of the same SQL is accepted and rewritten', () => {
  const migDir = path.join(tmp, 'migs')
  fs.mkdirSync(migDir, { recursive: true })
  const lf = 'CREATE TABLE t1 (a TEXT);\n'
  const crlf = lf.replace(/\n/g, '\r\n')
  fs.writeFileSync(path.join(migDir, '001_a.sql'), lf)
  const db = new DatabaseSync(path.join(tmp, 'x.db'))
  applyMigrations(db, { migrationsDir: migDir })
  const crlfHash = crypto.createHash('sha256').update(crlf).digest('hex')
  db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(crlfHash, '001')
  assert.doesNotThrow(() => applyMigrations(db, { migrationsDir: migDir }))
  const stored = db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get('001').checksum
  assert.notEqual(stored, crlfHash)
  assert.equal(stored.length, 64)
  db.close()
})

test('new migration files apply in order and record checksums', () => {
  const migDir = path.join(tmp, 'migs')
  fs.mkdirSync(migDir, { recursive: true })
  fs.writeFileSync(path.join(migDir, '001_a.sql'), 'CREATE TABLE t1 (a TEXT);')
  const db = new DatabaseSync(path.join(tmp, 'x.db'))
  let applied = applyMigrations(db, { migrationsDir: migDir })
  assert.deepEqual(applied, ['001_a.sql'])
  fs.writeFileSync(path.join(migDir, '002_b.sql'), 'ALTER TABLE t1 ADD COLUMN b TEXT;')
  applied = applyMigrations(db, { migrationsDir: migDir })
  assert.deepEqual(applied, ['002_b.sql'])
  const rows = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum)))
  db.close()
})

test('failed migration rolls back and is not recorded', () => {
  const migDir = path.join(tmp, 'migs')
  fs.mkdirSync(migDir, { recursive: true })
  fs.writeFileSync(path.join(migDir, '001_bad.sql'), 'CREATE TABLE ok1 (a TEXT); THIS IS NOT SQL;')
  const db = new DatabaseSync(path.join(tmp, 'x.db'))
  assert.throws(() => applyMigrations(db, { migrationsDir: migDir }), /001_bad\.sql failed/)
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name)
  assert.ok(!tables.includes('ok1'), 'rollback should drop partial table')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c, 0)
  db.close()
})

test('KIN_DB_PATH env overrides path', () => {
  const custom = path.join(tmp, 'custom', 'my.db')
  process.env.KIN_DB_PATH = custom
  assert.equal(resolveDbPath({ dataDir: tmp }), custom)
  openDatabase({ dataDir: tmp })
  assert.equal(getDbPath(), custom)
  assert.ok(fs.existsSync(custom))
})

test('vacuumInto produces a consistent snapshot', () => {
  const db = openDatabase({ dataDir: tmp })
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'k1',
    '"v1"',
    new Date().toISOString(),
  )
  const dest = path.join(tmp, 'backup', 'snap.db')
  vacuumInto(db, dest)
  const snap = new DatabaseSync(dest)
  const row = snap.prepare('SELECT value FROM settings WHERE key = ?').get('k1')
  assert.equal(row.value, '"v1"')
  snap.close()
})

test('withTransaction commits and rolls back', () => {
  const db = openDatabase({ dataDir: tmp })
  withTransaction(db, () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('a', '1')").run()
  })
  assert.ok(db.prepare("SELECT * FROM settings WHERE key='a'").get())
  assert.throws(
    () =>
      withTransaction(db, () => {
        db.prepare("INSERT INTO settings (key, value) VALUES ('b', '2')").run()
        throw new Error('boom')
      }),
    /boom/,
  )
  assert.equal(db.prepare("SELECT * FROM settings WHERE key='b'").get(), undefined)
})

test('withTransaction only runs inline for a real outer transaction', () => {
  const db = openDatabase({ dataDir: tmp })
  db.exec('BEGIN')
  withTransaction(db, () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('nested', '1')").run()
  })
  assert.equal(db.isTransaction, true)
  db.exec('ROLLBACK')
  assert.equal(db.prepare("SELECT * FROM settings WHERE key='nested'").get(), undefined)

  const closed = new DatabaseSync(':memory:')
  closed.close()
  let called = false
  assert.throws(
    () =>
      withTransaction(closed, () => {
        called = true
      }),
    /not open|closed/i,
  )
  assert.equal(called, false)
})
