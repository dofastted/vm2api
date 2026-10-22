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

test('migration 037 normalizes OpenAI input including NULL route fields; SUM(prompt) holds', () => {
  const migSrc = path.resolve('src/lib/db/migrations')
  const oldDir = path.join(tmp, 'pre-037')
  fs.mkdirSync(oldDir, { recursive: true })
  for (const f of fs.readdirSync(migSrc)) {
    if (f < '037') fs.copyFileSync(path.join(migSrc, f), path.join(oldDir, f))
  }
  const dbPath = path.join(tmp, 'bill037.db')
  const db = new DatabaseSync(dbPath)
  applyMigrations(db, { migrationsDir: oldDir })

  const cacheModel = `LOWER(TRIM(COALESCE(
    NULLIF(NULLIF(pricing_model, ''), 'unpriced'), NULLIF(upstream_model, ''),
    NULLIF(model, ''), requested_model, ''
  )))`
  const openaiIds = [
    'gpt-6-astra',
    'gpt-6.1-sol',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.6',
    'gpt-5.5-pro',
    'gpt-5.5',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.4-pro',
    'gpt-5.4',
    'gpt-5.3-codex',
    'gpt-5.2-pro',
    'gpt-5.2',
    'gpt-5.1',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-5-pro',
    'gpt-5',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'gpt-4.1',
    'gpt-4o-2024-05-13',
    'gpt-4o-mini',
    'gpt-4o',
    'o1-pro',
    'o1',
    'o3-pro',
    'o3-mini',
    'o3',
    'o4-mini',
    'gpt-4-turbo',
    'gpt-4',
    'gpt-3.5-turbo-instruct',
    'gpt-3.5-turbo-1106',
    'gpt-3.5-turbo',
    'gpt-5.1-codex-mini',
    'gpt-5.3-chat-latest',
    'gpt-5.6-cyber',
    'gpt-5.5-cyber',
    'chat-latest',
    'gpt-5-codex',
    'gpt-5.1-codex',
    'gpt-5.1-codex-max',
    'gpt-5-chat-latest',
    'gpt-5.1-chat-latest',
    'gpt-5.2-codex',
    'gpt-5.2-chat-latest',
  ]
    .map((id) => `'${id}'`)
    .join(', ')
  const oldPrompt = `CASE
    WHEN via = 'api-kernel' AND protocol = 'anthropic.messages' AND stream = 0
    THEN IFNULL(input_tokens, 0) + IFNULL(cache_read_tokens, 0) + IFNULL(cache_creation_tokens, 0)
    WHEN via LIKE 'codex-%'
      OR (${cacheModel} LIKE 'gpt%' AND ${cacheModel} NOT LIKE 'gpt-image%')
      OR ${cacheModel} LIKE 'codex-%'
      OR ${cacheModel} IN (${openaiIds})
    THEN IFNULL(input_tokens, 0)
    ELSE IFNULL(input_tokens, 0) + IFNULL(cache_read_tokens, 0) + IFNULL(cache_creation_tokens, 0)
  END`
  const newPrompt = 'IFNULL(input_tokens, 0) + IFNULL(cache_read_tokens, 0) + IFNULL(cache_creation_tokens, 0)'

  const ins = db.prepare(`
    INSERT INTO usage_logs (
      id, request_id, created_at, model, protocol, stream, via,
      input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, upstream_model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const at = '2026-09-01T00:00:00.000Z'
  ins.run('n-via', 'r-via', at, 'gpt-5.4', 'anthropic.messages', 0, null, 100, 80, 0, 2, null)
  ins.run('n-proto', 'r-proto', at, 'gpt-5.4', null, 0, 'go-worker-pool', 100, 80, 0, 2, null)
  ins.run('n-stream', 'r-stream', at, 'gpt-5.4', 'anthropic.messages', null, 'go-worker-pool', 100, 80, 0, 2, null)
  ins.run('n-all', 'r-all', at, 'gpt-5.4', null, null, null, 100, 80, 0, 2, null)
  ins.run('keep-api', 'r-api', at, 'gpt-5.4', 'anthropic.messages', 0, 'api-kernel', 20, 80, 0, 2, 'gpt-5.4')
  ins.run('keep-claude', 'r-claude', at, 'claude-sonnet-5', 'anthropic.messages', 0, null, 20, 80, 0, 2, null)
  ins.run('codex', 'r-codex', at, 'gpt-5.4', 'openai.responses', 1, 'codex-kernel', 100000, 80000, 0, 2000, null)

  const before = db.prepare(`SELECT SUM(${oldPrompt}) AS n FROM usage_logs`).get().n
  applyMigrations(db, { migrationsDir: migSrc })
  const after = db.prepare(`SELECT SUM(${newPrompt}) AS n FROM usage_logs`).get().n
  assert.equal(after, before)

  const cols = db
    .prepare('PRAGMA table_info(usage_logs)')
    .all()
    .map((r) => r.name)
  for (const c of ['web_search_requests', 'web_search_cost', 'price_source', 'price_version']) {
    assert.ok(cols.includes(c), `missing ${c}`)
  }

  const get = (id) => db.prepare('SELECT input_tokens, cache_read_tokens FROM usage_logs WHERE id = ?').get(id)
  assert.equal(get('n-via').input_tokens, 20)
  assert.equal(get('n-proto').input_tokens, 20)
  assert.equal(get('n-stream').input_tokens, 20)
  assert.equal(get('n-all').input_tokens, 20)
  assert.equal(get('keep-api').input_tokens, 20)
  assert.equal(get('keep-claude').input_tokens, 20)
  assert.equal(get('codex').input_tokens, 20000)
  // Earlier prunes were never recorded; existing rows only vouch for history from the oldest one.
  const pruned = db.prepare("SELECT value FROM settings WHERE key = 'usage_logs_pruned_through'").get()
  assert.equal(JSON.parse(pruned.value), at)
  db.close()
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

test('migration 042 adds image generation columns; old rows and prompt totals stay the same', () => {
  const src = path.join(process.cwd(), 'src/lib/db/migrations')
  const migSrc = path.join(tmp, 'mig042')
  fs.mkdirSync(migSrc, { recursive: true })
  for (const f of fs.readdirSync(src)) {
    if (f.endsWith('.sql') && f < '042') fs.copyFileSync(path.join(src, f), path.join(migSrc, f))
  }
  const db = new DatabaseSync(path.join(tmp, 'mig042.db'))
  applyMigrations(db, { migrationsDir: migSrc })
  db.prepare(`
    INSERT INTO usage_logs (id, request_id, created_at, model, input_tokens, cache_read_tokens, output_tokens, total_cost)
    VALUES ('old', 'r-old', '2026-10-01T00:00:00.000Z', 'gpt-6-luna', 100, 20, 5, 0.5)
  `).run()
  const prompt =
    'SELECT SUM(IFNULL(input_tokens, 0) + IFNULL(cache_read_tokens, 0) + IFNULL(cache_creation_tokens, 0)) AS n FROM usage_logs'
  const before = db.prepare(prompt).get().n
  fs.copyFileSync(
    path.join(src, '042_usage_logs_image_generation.sql'),
    path.join(migSrc, '042_usage_logs_image_generation.sql'),
  )
  applyMigrations(db, { migrationsDir: migSrc })
  assert.equal(db.prepare(prompt).get().n, before)
  const row = db
    .prepare(
      'SELECT image_model, image_usage, image_input_tokens, image_output_tokens, image_cost, total_cost FROM usage_logs WHERE id = ?',
    )
    .get('old')
  assert.deepEqual(
    { ...row },
    {
      image_model: null,
      image_usage: null,
      image_input_tokens: 0,
      image_output_tokens: 0,
      image_cost: null,
      total_cost: 0.5,
    },
  )
  db.close()
})
