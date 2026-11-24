import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectMutatedTables,
  isConstraintError,
  isUniqueConstraintError,
  sanitizePgParams,
  splitSqlStatements,
  translateSqliteToPg,
} from '../../src/lib/db/pg/sql-compat.mjs'

test('translateSqliteToPg converts positional placeholders without touching quoted strings', () => {
  const { sql } = translateSqliteToPg("SELECT '?' AS q, id FROM users WHERE id = ? AND note <> 'a?b' AND status = ?")
  assert.equal(sql, "SELECT '?' AS q, id FROM users WHERE id = $1 AND note <> 'a?b' AND status = $2")
})

test('translateSqliteToPg rewrites INSERT OR IGNORE to ON CONFLICT DO NOTHING', () => {
  const { sql } = translateSqliteToPg('INSERT OR IGNORE INTO account_groups (account_id, group_id) VALUES (?, 1)')
  assert.equal(sql, 'INSERT INTO account_groups (account_id, group_id) VALUES ($1, 1) ON CONFLICT DO NOTHING')
})

test('translateSqliteToPg appends RETURNING id for serial PK tables on run()', () => {
  const { sql, hasReturningId } = translateSqliteToPg('INSERT INTO groups (name, description) VALUES (?, ?)', {
    returningId: true,
  })
  assert.equal(hasReturningId, true)
  assert.equal(sql, 'INSERT INTO groups (name, description) VALUES ($1, $2) RETURNING id')

  const nonSerial = translateSqliteToPg('INSERT INTO settings (key, value) VALUES (?, ?)', { returningId: true })
  assert.equal(nonSerial.hasReturningId, false)
  assert.equal(nonSerial.sql, 'INSERT INTO settings (key, value) VALUES ($1, $2)')
})

test('translateSqliteToPg rewrites IFNULL, json_each, 2-arg MAX/MIN, and preserves 1-arg aggregates', () => {
  const q1 = translateSqliteToPg(
    'SELECT IFNULL(a, 0), MAX(created_at), MAX(account_runtime.credential_generation, excluded.credential_generation), MIN(x, y) FROM t WHERE id IN (SELECT value FROM json_each(?))',
  )
  assert.match(q1.sql, /COALESCE\(a, 0\)/)
  assert.match(q1.sql, /MAX\(created_at\)/)
  assert.match(q1.sql, /GREATEST\(account_runtime\.credential_generation, excluded\.credential_generation\)/)
  assert.match(q1.sql, /LEAST\(x, y\)/)
  assert.match(q1.sql, /jsonb_array_elements_text\(\(\$1\)::jsonb\) AS _je\(value\)/)
})

test('translateSqliteToPg rewrites strftime and printf patterns used in usage-logs and statistics repos', () => {
  const h = translateSqliteToPg("SELECT strftime('%Y-%m-%dT%H:00', created_at) AS bucket FROM usage_logs")
  assert.equal(h.sql, "SELECT (substr(created_at, 1, 13) || ':00') AS bucket FROM usage_logs")

  const d8 = translateSqliteToPg("SELECT strftime('%Y-%m-%d', created_at, '+8 hours') AS day FROM usage_logs")
  assert.equal(
    d8.sql,
    "SELECT to_char((created_at)::timestamptz AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day FROM usage_logs",
  )

  const slot = translateSqliteToPg(
    "SELECT substr(created_at, 1, 14) || printf('%02d', (CAST(substr(created_at, 15, 2) AS INTEGER) / 15) * 15) AS slot FROM usage_logs",
  )
  assert.equal(
    slot.sql,
    "SELECT substr(created_at, 1, 14) || lpad(((CAST(substr(created_at, 15, 2) AS INTEGER) / 15) * 15)::text, 2, '0') AS slot FROM usage_logs",
  )
})

test('translateSqliteToPg rewrites COLLATE NOCASE, BEGIN IMMEDIATE, and SQLite metadata queries', () => {
  const nocase = translateSqliteToPg('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL')
  assert.equal(nocase.sql, 'SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND deleted_at IS NULL')

  assert.equal(translateSqliteToPg('BEGIN IMMEDIATE').sql, 'BEGIN')
  assert.equal(translateSqliteToPg('PRAGMA synchronous').special?.kind, 'static')
  assert.equal(translateSqliteToPg('PRAGMA wal_checkpoint(TRUNCATE)').special?.kind, 'noop')
  assert.match(translateSqliteToPg('PRAGMA table_info(api_keys)').sql, /information_schema\.columns/)
  assert.match(
    translateSqliteToPg("SELECT name FROM sqlite_master WHERE type = 'table'").sql,
    /information_schema\.tables/,
  )
})

test('sanitizePgParams strips NUL bytes and normalizes undefined/bigint', () => {
  assert.deepEqual(sanitizePgParams(['hello\u0000world', undefined, 42n, 0, null]), ['helloworld', null, '42', 0, null])
})

test('detectMutatedTables and error helpers identify mutations and constraint codes', () => {
  assert.deepEqual(detectMutatedTables('UPDATE api_keys SET status = $1; DELETE FROM sticky_sessions WHERE key = $2'), [
    'api_keys',
    'sticky_sessions',
  ])
  assert.equal(isUniqueConstraintError({ code: '23505', message: 'duplicate key' }), true)
  assert.equal(isUniqueConstraintError({ code: 'SQLITE_CONSTRAINT_UNIQUE' }), true)
  assert.equal(isConstraintError({ code: '23514' }), true)
  assert.equal(isUniqueConstraintError({ code: '42P01' }), false)
})

test('splitSqlStatements respects $$ dollar-quoted functions and string semicolons', () => {
  const stmts = splitSqlStatements(`
    CREATE FUNCTION f() RETURNS text AS $$ SELECT 'a;b'; $$ LANGUAGE SQL;
    INSERT INTO settings VALUES ('k', 'x;y');
  `)
  assert.equal(stmts.length, 2)
  assert.match(stmts[0], /SELECT 'a;b'/)
  assert.match(stmts[1], /'x;y'/)
})
