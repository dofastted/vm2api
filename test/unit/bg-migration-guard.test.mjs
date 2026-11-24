import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkAdditive, classifyStatement, splitStatements } from '../../deploy/bluegreen/migration-guard.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GUARD = path.join(ROOT, 'deploy/bluegreen/migration-guard.mjs')
const SQLITE_DIR = path.join(ROOT, 'src/lib/db/migrations')

const sqlite = (name, sql) => ({ engine: 'sqlite', files: [{ name, sql }] })

test('068 multi-tier key permissions is additive on a small database', () => {
  const sql = fs.readFileSync(path.join(SQLITE_DIR, '068_multi_tier_key_permissions.sql'), 'utf8')
  const v = checkAdditive({ ...sqlite('068_multi_tier_key_permissions.sql', sql), rowCount: () => 5 })
  assert.equal(v.additive, true, JSON.stringify(v.reasons))
})

test('an index on an existing table above the row limit needs a restart', () => {
  const v = checkAdditive({
    ...sqlite('100_x.sql', 'CREATE INDEX IF NOT EXISTS idx_logs_x ON request_attempts(model);'),
    rowCount: (_t, limit) => limit + 1,
    indexMaxRows: 1000,
  })
  assert.equal(v.additive, false)
  assert.match(v.reasons[0], /request_attempts with more than 1000 rows/)
})

test('indexes on tables created in the same batch skip the row count', () => {
  let counted = 0
  const v = checkAdditive({
    engine: 'sqlite',
    files: [
      { name: '100_a.sql', sql: 'CREATE TABLE IF NOT EXISTS "Foo" (id TEXT PRIMARY KEY, n INTEGER);' },
      { name: '101_b.sql', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_foo_n ON foo (n);' },
    ],
    rowCount: () => {
      counted++
      return Infinity
    },
  })
  assert.equal(v.additive, true, JSON.stringify(v.reasons))
  assert.equal(counted, 0)
})

test('a CHECK column scans existing rows, so it follows the index row limit', () => {
  const sql = "ALTER TABLE api_endpoints ADD COLUMN mode TEXT NOT NULL DEFAULT 'a' CHECK (mode IN ('a', 'b'));"
  assert.equal(checkAdditive({ ...sqlite('100_x.sql', sql), rowCount: () => 3 }).additive, true)
  const big = checkAdditive({ ...sqlite('100_x.sql', sql), rowCount: (_t, limit) => limit + 1 })
  assert.equal(big.additive, false)
  assert.match(big.reasons[0], /CHECK column on api_endpoints/)
})

test('a unique index on an existing table needs a restart even when small', () => {
  const v = checkAdditive({ ...sqlite('100_x.sql', 'CREATE UNIQUE INDEX i ON api_keys(name);'), rowCount: () => 1 })
  assert.equal(v.additive, false)
})

for (const [label, sql] of [
  ['DROP COLUMN', 'ALTER TABLE api_keys DROP COLUMN owner_id;'],
  ['RENAME COLUMN', 'ALTER TABLE api_keys RENAME COLUMN owner_id TO owner;'],
  ['RENAME TABLE', 'ALTER TABLE api_keys RENAME TO keys;'],
  ['DROP TABLE', 'DROP TABLE IF EXISTS old_stuff;'],
  ['backfill UPDATE', "ALTER TABLE vms ADD COLUMN tier TEXT; UPDATE vms SET tier = 'a';"],
  ['seed INSERT', "INSERT INTO settings (k, v) VALUES ('a', 'b');"],
  ['NOT NULL without DEFAULT', 'ALTER TABLE vms ADD COLUMN tier TEXT NOT NULL;'],
  ['expression DEFAULT', "ALTER TABLE vms ADD COLUMN at TEXT DEFAULT (datetime('now'));"],
  ['CURRENT_TIMESTAMP DEFAULT', 'ALTER TABLE vms ADD COLUMN at TEXT DEFAULT CURRENT_TIMESTAMP;'],
  [
    'CHECK followed by another constraint',
    'ALTER TABLE vms ADD COLUMN n INTEGER DEFAULT 0 CHECK (n >= 0) REFERENCES p(id);',
  ],
  ['REFERENCES column', 'ALTER TABLE vms ADD COLUMN pool_id TEXT REFERENCES pools(id);'],
  ['generated column', 'ALTER TABLE vms ADD COLUMN n2 INTEGER GENERATED ALWAYS AS (n * 2) VIRTUAL;'],
  ['table rebuild', 'CREATE TABLE vms_new (id TEXT); INSERT INTO vms_new SELECT id FROM vms; DROP TABLE vms;'],
  ['CREATE TABLE AS SELECT', 'CREATE TABLE copy AS SELECT * FROM vms;'],
  ['trigger', 'CREATE TRIGGER t AFTER INSERT ON vms BEGIN UPDATE vms SET n = 1; END;'],
  ['view', 'CREATE VIEW v AS SELECT 1;'],
  ['PRAGMA', 'PRAGMA foreign_keys = OFF;'],
]) {
  test(`${label} needs a restart`, () => {
    const v = checkAdditive({ ...sqlite('100_x.sql', sql), rowCount: () => 0 })
    assert.equal(v.additive, false, label)
  })
}

test('literal defaults, quoted identifiers and comments are accepted', () => {
  const sql = `
    -- comment; with a semicolon
    /* block; comment */
    ALTER TABLE "api_keys" ADD COLUMN "label" TEXT NOT NULL DEFAULT 'a;b';
    ALTER TABLE api_keys ADD retries INTEGER NOT NULL DEFAULT -1;
    ALTER TABLE api_keys ADD COLUMN ratio REAL DEFAULT 0.5;
    ALTER TABLE api_keys ADD COLUMN note TEXT DEFAULT NULL;
    ALTER TABLE api_keys ADD COLUMN flag INTEGER DEFAULT FALSE;
    ALTER TABLE api_keys ADD COLUMN name VARCHAR(64);
  `
  assert.equal(splitStatements(sql).length, 6)
  const v = checkAdditive({ ...sqlite('100_x.sql', sql), rowCount: () => 0 })
  assert.equal(v.additive, true, JSON.stringify(v.reasons))
})

test('postgres deployments always restart', () => {
  const v = checkAdditive({ engine: 'postgres', files: [{ name: '005_x.sql', sql: 'CREATE TABLE t (id TEXT);' }] })
  assert.equal(v.additive, false)
  assert.match(v.reasons[0], /postgres/)
})

test('every shipped SQLite migration classifies without throwing', () => {
  const files = fs.readdirSync(SQLITE_DIR).filter((f) => /^\d+.*\.sql$/.test(f))
  assert.ok(files.length > 10)
  for (const f of files) {
    for (const stmt of splitStatements(fs.readFileSync(path.join(SQLITE_DIR, f), 'utf8'))) {
      const c = classifyStatement(stmt)
      assert.ok(['create_table', 'add_column', 'create_index', 'unsafe'].includes(c.kind), `${f}: ${stmt}`)
    }
  }
})

// bg-deploy.sh 的调用方式：脚本经 stdin 交给 node，迁移文件名作参数
function runCli(root, names, env = {}) {
  return spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-', ...names], {
    input: fs.readFileSync(GUARD),
    encoding: 'utf8',
    env: { ...process.env, BG_MIGRATION_GUARD_CLI: '1', BG_PROJECT_ROOT: root, ...env },
  })
}

function fixtureRoot(t, migrations) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-mig-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'src/lib/db/migrations')
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, sql] of Object.entries(migrations)) fs.writeFileSync(path.join(dir, name), sql)
  fs.mkdirSync(path.join(root, 'data'))
  const db = new DatabaseSync(path.join(root, 'data/kin.db'))
  db.exec('CREATE TABLE api_keys (id TEXT PRIMARY KEY)')
  const ins = db.prepare('INSERT INTO api_keys (id) VALUES (?)')
  for (let i = 0; i < 20; i++) ins.run(`k${i}`)
  db.close()
  return root
}

test('CLI reports additive migrations with exit 0 and counts rows from the live database', (t) => {
  const root = fixtureRoot(t, {
    '100_add.sql':
      "ALTER TABLE api_keys ADD COLUMN tier TEXT NOT NULL DEFAULT 'platform';\nCREATE INDEX i ON api_keys(tier);",
  })
  const r = runCli(root, ['/opt/vm2api/src/lib/db/migrations:', '100_add.sql', '005_pg_only.sql'], {
    VM2API_DB_DRIVER: 'sqlite',
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const v = JSON.parse(r.stdout)
  assert.equal(v.additive, true)
  assert.equal(v.engine, 'sqlite')
  assert.deepEqual(v.ignored, ['005_pg_only.sql'])

  const tight = runCli(root, ['100_add.sql'], { VM2API_DB_DRIVER: 'sqlite', BG_MIGRATION_INDEX_MAX_ROWS: '10' })
  assert.equal(tight.status, 3, tight.stdout + tight.stderr)
  assert.match(JSON.parse(tight.stdout).reasons[0], /more than 10 rows/)
})

test('CLI refuses a destructive migration with exit 3', (t) => {
  const root = fixtureRoot(t, { '100_drop.sql': 'ALTER TABLE api_keys DROP COLUMN id;' })
  const r = runCli(root, ['100_drop.sql'], { VM2API_DB_DRIVER: 'sqlite' })
  assert.equal(r.status, 3, r.stdout + r.stderr)
  assert.equal(JSON.parse(r.stdout).additive, false)
})
