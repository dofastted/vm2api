import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  checkAdditive,
  classifyStatement,
  resolveEngine,
  splitStatements,
} from '../../deploy/bluegreen/migration-guard.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GUARD = path.join(ROOT, 'deploy/bluegreen/migration-guard.mjs')
const BG_DEPLOY = path.join(ROOT, 'deploy/bluegreen/bg-deploy.sh')
const PG_CONFIG = path.join(ROOT, 'src/lib/db/pg/config.mjs')
const SQLITE_DIR = path.join(ROOT, 'src/lib/db/migrations')

const sqlite = (name, sql) => ({ engine: 'sqlite', files: [{ name, sql }] })

test('068 multi-tier key permissions is additive on a small database', () => {
  const sql = fs.readFileSync(path.join(SQLITE_DIR, '068_multi_tier_key_permissions.sql'), 'utf8')
  const v = checkAdditive({ ...sqlite('068_multi_tier_key_permissions.sql', sql), rowCount: () => 5 })
  assert.equal(v.additive, true, JSON.stringify(v.reasons))
})

test('069 log error details and hop correlation is additive even on a huge database (#1845)', () => {
  const sql = fs.readFileSync(path.join(SQLITE_DIR, '069_log_error_details_and_hop_correlation.sql'), 'utf8')
  const v = checkAdditive({
    ...sqlite('069_log_error_details_and_hop_correlation.sql', sql),
    rowCount: () => 10_000_000,
  })
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

test('indexes on tables created in the same batch skip the row count when table does not exist', () => {
  let counted = 0
  const v = checkAdditive({
    engine: 'sqlite',
    files: [
      { name: '100_a.sql', sql: 'CREATE TABLE IF NOT EXISTS "Foo" (id TEXT PRIMARY KEY, n INTEGER);' },
      { name: '101_b.sql', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_foo_n ON foo (n);' },
    ],
    tableExists: () => false,
    rowCount: () => {
      counted++
      return Infinity
    },
  })
  assert.equal(v.additive, true, JSON.stringify(v.reasons))
  assert.equal(counted, 0)
})

test('CREATE TABLE IF NOT EXISTS on an existing table cannot bypass UNIQUE INDEX or rowCount checks', () => {
  const uniqueBypass = [
    { name: '100_a.sql', sql: 'CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY);' },
    { name: '101_b.sql', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_k ON api_keys (id);' },
  ]
  // 默认 tableExists 应为 fail-closed（视为已存在）
  const def = checkAdditive({ engine: 'sqlite', files: uniqueBypass, rowCount: () => 0 })
  assert.equal(def.additive, false)
  assert.match(def.reasons[0], /UNIQUE INDEX on existing table api_keys/)

  // 已有表建普通索引不能跳过行数检查
  const largeBypass = checkAdditive({
    engine: 'sqlite',
    files: [
      {
        name: '100_a.sql',
        sql: 'CREATE TABLE IF NOT EXISTS api_keys (id TEXT); CREATE INDEX idx_k ON api_keys(id);',
      },
    ],
    tableExists: (t) => t === 'api_keys',
    rowCount: (_t, limit) => limit + 1,
    indexMaxRows: 100,
  })
  assert.equal(largeBypass.additive, false)
  assert.match(largeBypass.reasons[0], /api_keys with more than 100 rows/)
})

test('ADD COLUMN with CHECK is unsafe on existing tables while CHECK inside CREATE TABLE is allowed', () => {
  const alterSql = "ALTER TABLE api_endpoints ADD COLUMN mode TEXT NOT NULL DEFAULT 'a' CHECK (mode IN ('a', 'b'));"
  const v = checkAdditive({ ...sqlite('100_x.sql', alterSql), rowCount: () => 0 })
  assert.equal(v.additive, false)
  assert.match(v.reasons[0], /ADD COLUMN with CHECK/)

  const createSql =
    "CREATE TABLE IF NOT EXISTS new_endpoints (id TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'a' CHECK (mode IN ('a', 'b')));"
  const ok = checkAdditive({ ...sqlite('100_new.sql', createSql), tableExists: () => false })
  assert.equal(ok.additive, true, JSON.stringify(ok.reasons))
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
  ['NOT NULL DEFAULT NULL', 'ALTER TABLE vms ADD COLUMN tier TEXT NOT NULL DEFAULT NULL;'],
  ['DEFAULT NULL NOT NULL', 'ALTER TABLE vms ADD COLUMN tier TEXT DEFAULT NULL NOT NULL;'],
  ['expression DEFAULT', "ALTER TABLE vms ADD COLUMN at TEXT DEFAULT (datetime('now'));"],
  ['CURRENT_TIMESTAMP DEFAULT', 'ALTER TABLE vms ADD COLUMN at TEXT DEFAULT CURRENT_TIMESTAMP;'],
  ['ADD COLUMN with CHECK', "ALTER TABLE vms ADD COLUMN mode TEXT DEFAULT 'a' CHECK (mode IN ('a', 'b'));"],
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
    ALTER TABLE api_keys ADD COLUMN literal_null TEXT NOT NULL DEFAULT 'NULL';
    ALTER TABLE api_keys ADD COLUMN literal_check TEXT NOT NULL DEFAULT 'CHECK';
    ALTER TABLE api_keys ADD COLUMN flag INTEGER DEFAULT FALSE;
    ALTER TABLE api_keys ADD COLUMN name VARCHAR(64);
  `
  assert.equal(splitStatements(sql).length, 8)
  const v = checkAdditive({ ...sqlite('100_x.sql', sql), rowCount: () => 0 })
  assert.equal(v.additive, true, JSON.stringify(v.reasons))
})

test('checkAdditive rejects invalid indexMaxRows', () => {
  assert.throws(
    () => checkAdditive({ ...sqlite('100_x.sql', 'CREATE INDEX i ON api_keys(id);'), indexMaxRows: -2 }),
    RangeError,
  )
  assert.throws(
    () => checkAdditive({ ...sqlite('100_x.sql', 'CREATE INDEX i ON api_keys(id);'), indexMaxRows: 1.5 }),
    RangeError,
  )
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
  const baseEnv = { ...process.env }
  for (const k of [
    'VM2API_DB_DRIVER',
    'DB_DRIVER',
    'DATABASE_URL',
    'VM2API_DATABASE_URL',
    'DATABASE_HOST',
    'VM2API_PG_HOST',
    'PGHOST',
    'KIN_DB_PATH',
    'KIN_DATA_DIR',
    'BG_MIGRATION_INDEX_MAX_ROWS',
  ]) {
    delete baseEnv[k]
  }
  return spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-', ...names], {
    input: fs.readFileSync(GUARD),
    encoding: 'utf8',
    env: { ...baseEnv, BG_MIGRATION_GUARD_CLI: '1', BG_PROJECT_ROOT: root, ...env },
  })
}

function fixtureRoot(t, migrations, { withDb = true, pgConfig = null, envFile = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-mig-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'src/lib/db/migrations')
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, sql] of Object.entries(migrations)) fs.writeFileSync(path.join(dir, name), sql)
  fs.mkdirSync(path.join(root, 'data'))
  if (withDb) {
    const db = new DatabaseSync(path.join(root, 'data/kin.db'))
    db.exec('CREATE TABLE api_keys (id TEXT PRIMARY KEY)')
    const ins = db.prepare('INSERT INTO api_keys (id) VALUES (?)')
    for (let i = 0; i < 20; i++) ins.run(`k${i}`)
    db.close()
  }
  if (pgConfig !== null) {
    const pgDir = path.join(root, 'src/lib/db/pg')
    fs.mkdirSync(pgDir, { recursive: true })
    if (pgConfig === 'real') fs.copyFileSync(PG_CONFIG, path.join(pgDir, 'config.mjs'))
    else fs.writeFileSync(path.join(pgDir, 'config.mjs'), pgConfig)
  }
  if (envFile !== null) {
    fs.writeFileSync(path.join(root, '.env'), envFile)
  }
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

test('CLI checks sqlite_master so CREATE TABLE IF NOT EXISTS on an existing table cannot bypass guard', (t) => {
  const root = fixtureRoot(t, {
    '100_bypass_unique.sql':
      'CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY);\nCREATE UNIQUE INDEX idx_k ON api_keys(id);',
    '101_bypass_rows.sql':
      'CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY);\nCREATE INDEX idx_k2 ON api_keys(id);',
    '102_brand_new.sql':
      'CREATE TABLE IF NOT EXISTS brand_new (id TEXT PRIMARY KEY, n INTEGER CHECK (n >= 0));\nCREATE UNIQUE INDEX idx_bn ON brand_new(n);',
  })

  const r1 = runCli(root, ['100_bypass_unique.sql'], { VM2API_DB_DRIVER: 'sqlite' })
  assert.equal(r1.status, 3, r1.stdout + r1.stderr)
  assert.match(JSON.parse(r1.stdout).reasons[0], /UNIQUE INDEX on existing table api_keys/)

  const r2 = runCli(root, ['101_bypass_rows.sql'], { VM2API_DB_DRIVER: 'sqlite', BG_MIGRATION_INDEX_MAX_ROWS: '5' })
  assert.equal(r2.status, 3, r2.stdout + r2.stderr)
  assert.match(JSON.parse(r2.stdout).reasons[0], /more than 5 rows/)

  const r3 = runCli(root, ['102_brand_new.sql'], { VM2API_DB_DRIVER: 'sqlite', BG_MIGRATION_INDEX_MAX_ROWS: '0' })
  assert.equal(r3.status, 0, r3.stdout + r3.stderr)
  assert.equal(JSON.parse(r3.stdout).additive, true)
})

test('CLI fails closed with exit 1 when SQLite database file is missing', (t) => {
  const root = fixtureRoot(
    t,
    {
      '100_idx.sql': 'CREATE INDEX idx_k ON api_keys(id);',
      '101_col.sql': "ALTER TABLE api_keys ADD COLUMN tier TEXT NOT NULL DEFAULT 'a';",
    },
    { withDb: false },
  )
  for (const name of ['100_idx.sql', '101_col.sql']) {
    const r = runCli(root, [name], { VM2API_DB_DRIVER: 'sqlite' })
    assert.equal(r.status, 1, `${name}: ${r.stdout + r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.equal(out.additive, false)
    assert.match(out.error, /sqlite database not found/)
  }

  const existingRoot = fixtureRoot(t, { '100_idx.sql': 'CREATE INDEX idx_k ON api_keys(id);' })
  const badPath = runCli(existingRoot, ['100_idx.sql'], {
    VM2API_DB_DRIVER: 'sqlite',
    KIN_DB_PATH: path.join(existingRoot, 'data/missing.db'),
  })
  assert.equal(badPath.status, 1, badPath.stdout + badPath.stderr)
  assert.match(JSON.parse(badPath.stdout).error, /sqlite database not found/)
})

test('CLI rejects invalid BG_MIGRATION_INDEX_MAX_ROWS with exit 1', (t) => {
  const root = fixtureRoot(t, {
    '100_idx.sql': 'CREATE INDEX idx_k ON api_keys(id);',
  })
  for (const bad of ['-2', '-1', 'abc', '1.5', '   ']) {
    const r = runCli(root, ['100_idx.sql'], { VM2API_DB_DRIVER: 'sqlite', BG_MIGRATION_INDEX_MAX_ROWS: bad })
    assert.equal(r.status, 1, `bad=${JSON.stringify(bad)}: ${r.stdout + r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.equal(out.additive, false)
    assert.match(out.error, /invalid BG_MIGRATION_INDEX_MAX_ROWS/)
  }
  const zero = runCli(root, ['100_idx.sql'], { VM2API_DB_DRIVER: 'sqlite', BG_MIGRATION_INDEX_MAX_ROWS: '0' })
  assert.equal(zero.status, 3, zero.stdout + zero.stderr)
  assert.match(JSON.parse(zero.stdout).reasons[0], /more than 0 rows/)
})

test('resolveEngine does not swallow config import errors and mirrors docker-entrypoint SQLite fallback', async (t) => {
  // 1. 无 config.mjs（旧镜像）→ sqlite
  const prePg = fixtureRoot(t, {})
  assert.equal(await resolveEngine(prePg, { DATABASE_HOST: '127.0.0.1' }), 'sqlite')

  // 2. config.mjs 存在但语法/导入报错 → 必须抛错，不能静默回退 sqlite
  const broken = fixtureRoot(
    t,
    { '100_add.sql': 'ALTER TABLE api_keys ADD COLUMN x TEXT;' },
    { pgConfig: 'export const ???' },
  )
  await assert.rejects(() => resolveEngine(broken, { VM2API_DB_DRIVER: 'postgres' }))
  const brokenCli = runCli(broken, ['100_add.sql'], { VM2API_DB_DRIVER: 'postgres' })
  assert.equal(brokenCli.status, 1, brokenCli.stdout + brokenCli.stderr)
  assert.equal(JSON.parse(brokenCli.stdout).additive, false)

  // 3. 遗留 SQLite 升级回退：VM2API_DB_DRIVER 为空/auto + data/kin.db 存在 + env/.env 无显式 PG → sqlite
  const legacyRoot = fixtureRoot(
    t,
    { '100_add.sql': "ALTER TABLE api_keys ADD COLUMN tier TEXT NOT NULL DEFAULT 'a';" },
    { pgConfig: 'real', withDb: true, envFile: 'VM2API_ADMIN_USER=admin\n' },
  )
  assert.equal(await resolveEngine(legacyRoot, { DATABASE_HOST: '127.0.0.1' }), 'sqlite')
  assert.equal(await resolveEngine(legacyRoot, { VM2API_DB_DRIVER: 'auto', DATABASE_HOST: '127.0.0.1' }), 'sqlite')
  const legacyCli = runCli(legacyRoot, ['100_add.sql'], { DATABASE_HOST: '127.0.0.1' })
  assert.equal(legacyCli.status, 0, legacyCli.stdout + legacyCli.stderr)
  assert.equal(JSON.parse(legacyCli.stdout).engine, 'sqlite')

  // 4. .env 显式指定了 PG 配置（或 env 指定了 DATABASE_URL）时，不回退 SQLite
  const pgEnvFileRoot = fixtureRoot(
    t,
    { '100_add.sql': "ALTER TABLE api_keys ADD COLUMN tier TEXT NOT NULL DEFAULT 'a';" },
    { pgConfig: 'real', withDb: true, envFile: 'VM2API_DB_DRIVER=postgres\n' },
  )
  assert.equal(await resolveEngine(pgEnvFileRoot, { DATABASE_HOST: '127.0.0.1' }), 'postgres')
  const pgCli = runCli(pgEnvFileRoot, ['100_add.sql'], { DATABASE_HOST: '127.0.0.1' })
  assert.equal(pgCli.status, 3, pgCli.stdout + pgCli.stderr)
  assert.equal(JSON.parse(pgCli.stdout).engine, 'postgres')

  assert.equal(
    await resolveEngine(legacyRoot, { VM2API_DB_DRIVER: 'auto', DATABASE_URL: 'postgres://u:p@h/db' }),
    'postgres',
  )

  // 5. 无 data/kin.db 时，DATABASE_HOST 触发 postgres
  const freshPgRoot = fixtureRoot(t, {}, { pgConfig: 'real', withDb: false })
  assert.equal(await resolveEngine(freshPgRoot, { VM2API_DB_DRIVER: 'auto', DATABASE_HOST: '127.0.0.1' }), 'postgres')
})

test('bg-deploy.sh passes added migrations as a quoted array and preserves guard stderr', () => {
  const script = fs.readFileSync(BG_DEPLOY, 'utf8')
  assert.match(script, /mapfile -t added_args <<<"\$added"/)
  assert.match(script, /--input-type=module - "\$\{added_args\[@\]\}"/)
  assert.doesNotMatch(script, /--input-type=module - \$added\b/)
  assert.doesNotMatch(script, /migration-guard\.mjs"\s+2>\/dev\/null/)
  assert.match(script, /migration guard stderr:/)
})
