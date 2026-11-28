import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { checkAdditive, splitStatements } from '../../deploy/bluegreen/migration-guard.mjs'
import {
  MIGRATION_TABLES,
  migrateSqliteToPostgres,
  preflightSqliteToPostgres,
} from '../../scripts/migrate-sqlite-to-pg.mjs'
import { seedMockSqlite } from '../../scripts/seed-mock-sqlite.mjs'
import { applyMigrations, createDatabase } from '../../src/lib/db/database.mjs'
import { resolvePgConfig } from '../../src/lib/db/pg/config.mjs'
import { applyPgMigrations } from '../../src/lib/db/pg/migrations-runner.mjs'
import { createPgSyncDb } from '../../src/lib/db/pg/pg-sync-db.mjs'
import { splitSqlStatements, translateSqliteToPg } from '../../src/lib/db/pg/sql-compat.mjs'
import { SchedulerPoolsRepo, bootstrapSchedulerPools } from '../../src/lib/db/repos/scheduler-pools-repo.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SQLITE_MIG_DIR = path.join(ROOT, 'src/lib/db/migrations')
const SQLITE_071 = path.join(SQLITE_MIG_DIR, '071_scheduler_center.sql')
const SQLITE_072 = path.join(SQLITE_MIG_DIR, '072_scheduler_pool_prompt_default.sql')
const PG_008 = path.join(ROOT, 'src/lib/db/pg/pg-migrations/008_scheduler_center.sql')
const PG_009 = path.join(ROOT, 'src/lib/db/pg/pg-migrations/009_scheduler_pool_prompt_default.sql')
const GUARD_SCRIPT = path.join(ROOT, 'deploy/bluegreen/migration-guard.mjs')
const PG_URL = process.env.VM2API_TEST_PG_URL || ''

const NEW_TABLES = [
  'scheduler_pools',
  'scheduler_pool_members',
  'api_key_pool_bindings',
  'scheduler_sticky_bindings',
  'scheduler_node_penalties',
]

function makePre071Db(tmpDir, fileName = 'pre071.db') {
  const oldDir = path.join(tmpDir, 'migs-pre071')
  fs.mkdirSync(oldDir, { recursive: true })
  for (const f of fs.readdirSync(SQLITE_MIG_DIR)) {
    if (/^\d+.*\.sql$/.test(f) && f < '071') {
      fs.copyFileSync(path.join(SQLITE_MIG_DIR, f), path.join(oldDir, f))
    }
  }
  const dbPath = path.join(tmpDir, fileName)
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON')
  applyMigrations(db, { migrationsDir: oldDir })
  return { db, dbPath }
}

function tableColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => r.name)
}

test('SQLite 071 upgrades pre-071 DB cleanly, preserves existing api_keys, and enforces v4 locked defaults', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-m0-mig-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const { db, dbPath } = makePre071Db(tmpDir)
  const now = '2026-11-27T08:00:00.000Z'
  db.prepare('INSERT INTO api_keys (id, name, key, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'key_legacy_1',
    'Legacy Key',
    'sk-legacy-1',
    'active',
    now,
  )

  const applied = applyMigrations(db)
  assert.deepEqual(applied, ['071_scheduler_center.sql', '072_scheduler_pool_prompt_default.sql'])

  // Re-applying is idempotent
  assert.deepEqual(applyMigrations(db), [])

  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name),
  )
  for (const tbl of NEW_TABLES) {
    assert.ok(tables.has(tbl), `missing SQLite table: ${tbl}`)
  }

  // Existing api_keys row gets additive columns with exact defaults
  const legacyKey = db
    .prepare('SELECT default_pool_id, pool_binding_mode FROM api_keys WHERE id = ?')
    .get('key_legacy_1')
  assert.equal(legacyKey.default_pool_id, null)
  assert.equal(legacyKey.pool_binding_mode, 'legacy_scope')

  // Verify pruned v3/v4 columns are strictly absent
  const poolCols = new Set(tableColumns(db, 'scheduler_pools'))
  assert.equal(poolCols.has('prompt_normalization'), false)
  assert.equal(poolCols.has('serialize_same_session'), false)

  // Verify raw DDL defaults by inserting minimal row
  db.prepare('INSERT INTO scheduler_pools (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'pool_defaults',
    'defaults',
    'Defaults Pool',
    now,
    now,
  )
  const row = db.prepare('SELECT * FROM scheduler_pools WHERE id = ?').get('pool_defaults')
  assert.equal(row.description, '')
  assert.equal(row.enabled, 1)
  assert.equal(row.exclusive_members, 0) // D1 locked
  assert.equal(row.provider_scope, 'mixed')
  assert.equal(row.plan_tags_json, '[]')
  assert.equal(row.pool_role, 'standard')
  assert.equal(row.sort_order, 0)
  assert.equal(row.fallback_pool_id, null)
  assert.equal(row.allow_cross_prompt_fallback, 0)
  assert.equal(row.intra_tier_strategy, 'least_inflight_swrr')
  assert.equal(row.session_queue_max, 16)
  assert.equal(row.session_queue_timeout_ms, 60000)
  assert.equal(row.queue_wait_ms, 15000)
  assert.equal(row.queue_max, 50)
  assert.equal(row.machine_sticky_enabled, 1)
  assert.equal(row.machine_ttl_seconds, 604800) // 1 week
  assert.equal(row.session_sticky_enabled, 1)
  assert.equal(row.session_ttl_seconds, 86400) // 24h
  assert.equal(row.session_busy_wait_ms, 0) // D2 locked
  assert.equal(row.session_overflow_policy, 'spill_immediately') // D2 locked
  assert.equal(row.system_prompt_mode, 'passthrough')
  assert.equal(row.system_prompt_preset, 'official_full')
  assert.equal(row.system_prompt_text, '')
  assert.equal(row.client_system_policy, 'prepend_pool')
  assert.equal(row.jev_profile, 'inherit_global')
  assert.equal(Number(row.config_version), 1)

  db.close()

  // Fresh DB open works cleanly too
  const fresh = createDatabase({ dbPath: path.join(tmpDir, 'fresh.db') })
  assert.ok(tableColumns(fresh, 'api_keys').includes('default_pool_id'))
  assert.ok(tableColumns(fresh, 'api_keys').includes('pool_binding_mode'))
  fresh.close()
  assert.ok(fs.existsSync(dbPath))
})

test('SQLite 071 and PG 008 are pure additive DDL (zero DML), have zero pruned columns, and match column-for-column', (t) => {
  const sqliteSql = fs.readFileSync(SQLITE_071, 'utf8')
  const pgSql = fs.readFileSync(PG_008, 'utf8')

  for (const [label, sql] of [
    ['071_scheduler_center.sql', sqliteSql],
    ['008_scheduler_center.sql', pgSql],
  ]) {
    assert.doesNotMatch(sql, /\bprompt_normalization\b/i, `${label} must not contain prompt_normalization`)
    assert.doesNotMatch(sql, /\bserialize_same_session\b/i, `${label} must not contain serialize_same_session`)
    const stmts = splitSqlStatements(sql)
    assert.ok(stmts.length >= 13, `${label} expected >= 13 DDL statements`)
    for (const stmt of stmts) {
      assert.doesNotMatch(
        stmt,
        /^\s*(INSERT|UPDATE|DELETE|DROP|TRUNCATE|RENAME)\b/i,
        `${label} must be pure additive DDL, found: ${stmt.slice(0, 80)}`,
      )
    }
  }

  // Verify PG 008 uses idempotent ADD COLUMN IF NOT EXISTS
  assert.match(pgSql, /ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS default_pool_id TEXT/i)
  assert.match(
    pgSql,
    /ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS pool_binding_mode TEXT NOT NULL DEFAULT 'legacy_scope'/i,
  )

  // Verify exact column-for-column parity between SQLite created tables and PG 008 DDL
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-m0-parity-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createDatabase({ dbPath: path.join(tmpDir, 'kin.db') })
  try {
    for (const tbl of NEW_TABLES) {
      const cols = tableColumns(db, tbl)
      const createMatch = pgSql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tbl}\\s*\\(([\\s\\S]*?)\\);`, 'i'))
      assert.ok(createMatch, `PG 008 missing CREATE TABLE ${tbl}`)
      const body = createMatch[1]
      for (const col of cols) {
        assert.match(body, new RegExp(`\\b${col}\\b`), `PG 008 table ${tbl} missing column ${col}`)
      }
    }
  } finally {
    db.close()
  }

  // Verify all expected indexes exist in both files
  for (const idx of [
    'idx_sched_pools_slug',
    'idx_sched_pools_name',
    'idx_sched_pool_members_node',
    'idx_key_pool_bindings_pool',
    'idx_sched_sticky_expires',
    'idx_sched_sticky_node',
  ]) {
    assert.match(sqliteSql, new RegExp(`INDEX IF NOT EXISTS ${idx}\\b`, 'i'))
    assert.match(pgSql, new RegExp(`INDEX IF NOT EXISTS ${idx}\\b`, 'i'))
  }
})

test('071_scheduler_center.sql passes blue-green migration-guard both via API and real CLI on pre-071 DB', (t) => {
  const sql = fs.readFileSync(SQLITE_071, 'utf8')
  const stmts = splitStatements(sql)
  assert.ok(stmts.length > 0)

  // 1. Direct checkAdditive on a huge database (10M existing rows)
  const verdict = checkAdditive({
    engine: 'sqlite',
    files: [{ name: '071_scheduler_center.sql', sql }],
    tableExists: (tbl) => tbl === 'api_keys',
    rowCount: () => 10_000_000,
  })
  assert.equal(verdict.additive, true, JSON.stringify(verdict.reasons))

  // 2. Real CLI execution via stdin (exact bg-deploy.sh invocation) against a pre-071 SQLite DB
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-m0-bg-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const migDir = path.join(root, 'src/lib/db/migrations')
  fs.mkdirSync(migDir, { recursive: true })
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.copyFileSync(SQLITE_071, path.join(migDir, '071_scheduler_center.sql'))

  const { db } = makePre071Db(root, path.join('data', 'kin.db'))
  db.close()

  const env = { ...process.env }
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
  ]) {
    delete env[k]
  }
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-', '071_scheduler_center.sql'], {
    input: fs.readFileSync(GUARD_SCRIPT),
    encoding: 'utf8',
    env: {
      ...env,
      BG_MIGRATION_GUARD_CLI: '1',
      BG_PROJECT_ROOT: root,
      VM2API_DB_DRIVER: 'sqlite',
    },
  })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  const parsed = JSON.parse(run.stdout)
  assert.equal(parsed.additive, true, run.stdout)
  assert.equal(parsed.engine, 'sqlite')
})

test('migrate-sqlite-to-pg MIGRATION_TABLES, preflight FK checks, and seedMockSqlite cover all 5 new tables', async (t) => {
  for (const tbl of NEW_TABLES) {
    assert.ok(MIGRATION_TABLES.includes(tbl), `MIGRATION_TABLES missing ${tbl}`)
  }
  // FK-safe ordering: scheduler_pools must precede children
  const idxPools = MIGRATION_TABLES.indexOf('scheduler_pools')
  assert.ok(idxPools < MIGRATION_TABLES.indexOf('scheduler_pool_members'))
  assert.ok(idxPools < MIGRATION_TABLES.indexOf('api_key_pool_bindings'))
  assert.ok(MIGRATION_TABLES.indexOf('api_keys') < MIGRATION_TABLES.indexOf('api_key_pool_bindings'))

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-m0-preflight-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const mockPath = path.join(tmpDir, 'mock.db')
  const seeded = seedMockSqlite({ outPath: mockPath, usageCount: 20 })
  for (const tbl of NEW_TABLES) {
    assert.ok(seeded.tableCounts[tbl] >= 1, `seedMockSqlite should seed ${tbl}`)
  }
  const okReport = await preflightSqliteToPostgres({ sqlitePath: mockPath })
  assert.equal(okReport.ok, true, JSON.stringify(okReport.blockingIssues))
  assert.deepEqual(okReport.unmappedTables, [])

  // Preflight must catch FK orphan rows in scheduler_pool_members and api_key_pool_bindings
  const orphanPath = path.join(tmpDir, 'orphan.db')
  const db = createDatabase({ dbPath: orphanPath })
  db.exec('PRAGMA foreign_keys = OFF')
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO scheduler_pool_members (pool_id, node_type, node_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('pool_missing', 'claude_vm', 'vm-99', now, now)
  db.prepare('INSERT INTO api_key_pool_bindings (api_key_id, pool_id, is_default, created_at) VALUES (?, ?, ?, ?)').run(
    'key_x',
    'pool_missing',
    1,
    now,
  )
  db.close()

  const badReport = await preflightSqliteToPostgres({ sqlitePath: orphanPath })
  assert.equal(badReport.ok, false)
  assert.equal(badReport.hazards.fkOrphans['scheduler_pool_members.pool_id'], 1)
  assert.equal(badReport.hazards.fkOrphans['api_key_pool_bindings.pool_id'], 1)
})

test('SchedulerPoolsRepo CRUD, multi-pool membership (D1), prompt provider guard, bindings, sticky & penalties', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-m0-repo-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const db = createDatabase({ dbPath: path.join(tmpDir, 'kin.db') })
  t.after(() => db.close())
  const repo = new SchedulerPoolsRepo(db)

  // OpenAI & Google (including 'gemini' alias) lock system_prompt_mode to 'passthrough'
  assert.throws(
    () => repo.insert({ name: 'Bad OpenAI', provider_scope: 'openai', system_prompt_mode: 'official' }),
    (err) => err.code === 'pool_prompt_unsupported_provider',
  )
  assert.throws(
    () => repo.insert({ name: 'Bad Gemini', provider_scope: 'gemini', system_prompt_mode: 'zero_inject' }),
    (err) => err.code === 'pool_prompt_unsupported_provider',
  )

  const gPool = repo.insert({ name: 'Gemini Ultra Pool', provider_scope: 'gemini', plan_tags: ['gemini_ultra'] })
  assert.equal(gPool.provider_scope, 'google')
  assert.equal(gPool.system_prompt_mode, 'passthrough')
  assert.deepEqual(gPool.plan_tags, ['gemini_ultra'])
  assert.equal(gPool.exclusive_members, false)
  assert.equal(gPool.session_overflow_policy, 'spill_immediately')
  assert.equal(gPool.session_busy_wait_ms, 0)

  const oPool = repo.insert({ name: 'Codex Default Pool', provider_scope: 'openai' })
  assert.equal(oPool.provider_scope, 'openai')
  assert.equal(oPool.system_prompt_mode, 'passthrough')

  const aDefault = repo.insert({ name: 'Anthropic Default Pool', provider_scope: 'anthropic' })
  assert.equal(aDefault.system_prompt_mode, 'inherit_global')
  const mDefault = repo.insert({ name: 'Mixed Default Pool' })
  assert.equal(mDefault.provider_scope, 'mixed')
  assert.equal(mDefault.system_prompt_mode, 'inherit_global')
  const apiDefault = repo.insert({ name: 'API Default Pool', provider_scope: 'api' })
  assert.equal(apiDefault.system_prompt_mode, 'inherit_global')
  const aExplicitPassthrough = repo.insert({
    name: 'Anthropic Explicit Passthrough',
    provider_scope: 'anthropic',
    system_prompt_mode: 'passthrough',
  })
  assert.equal(aExplicitPassthrough.system_prompt_mode, 'passthrough')

  const aOfficial = repo.insert({
    name: 'Anthropic Official',
    provider_scope: 'anthropic',
    system_prompt_mode: 'official',
    pool_role: 'primary',
  })
  const aZero = repo.insert({
    name: 'Anthropic Zero',
    provider_scope: 'anthropic',
    system_prompt_mode: 'zero_inject',
  })

  // Case-insensitive slug & name uniqueness
  assert.throws(
    () => repo.insert({ name: 'anthropic official', slug: 'other-slug' }),
    (err) => err.code === 'scheduler_pool_name_taken',
  )
  assert.throws(
    () => repo.insert({ name: 'Other Name', slug: aOfficial.slug.toUpperCase() }),
    (err) => err.code === 'scheduler_pool_slug_taken',
  )

  // Update bumps config_version
  const updated = repo.update(aOfficial.id, { machine_ttl_seconds: 1_209_600 })
  assert.equal(updated.machine_ttl_seconds, 1_209_600)
  assert.equal(updated.config_version, 2)
  assert.equal(repo.getBySlug(aOfficial.slug).id, aOfficial.id)

  // D1: Same Anthropic CRAG VM can join both Official and Zero pools (no UNIQUE(vm_id) lock)
  repo.setMembers(aOfficial.id, [{ node_type: 'claude_vm', node_id: 'vm-01', weight_tier_override: 9 }])
  repo.setMembers(aZero.id, [{ node_type: 'claude_vm', node_id: 'vm-01', weight_tier_override: 5 }])
  assert.equal(repo.get(aOfficial.id).members.length, 1)
  assert.equal(repo.get(aZero.id).members.length, 1)
  assert.equal(repo.get(aOfficial.id).members[0].weight_tier_override, 9)

  // API key bindings + ON DELETE RESTRICT
  const now = new Date().toISOString()
  db.prepare('INSERT INTO api_keys (id, name, key, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'key_1',
    'Key 1',
    'sk-key-1',
    'active',
    now,
  )
  repo.setKeyBindings('key_1', [aOfficial.id, aZero.id], {
    defaultPoolId: aOfficial.id,
    bindingMode: 'strict_pool',
  })
  assert.equal(repo.countKeys(aOfficial.id), 1)
  assert.equal(repo.listBindingsByKey('key_1').length, 2)
  const kRow = db.prepare('SELECT default_pool_id, pool_binding_mode FROM api_keys WHERE id = ?').get('key_1')
  assert.equal(kRow.default_pool_id, aOfficial.id)
  assert.equal(kRow.pool_binding_mode, 'strict_pool')

  // Deleting pool with bound key fails (ON DELETE RESTRICT)
  assert.throws(
    () => repo.remove(aOfficial.id),
    (err) => err.code === 'scheduler_pool_in_use',
  )

  // Clearing bindings allows deletion and cascades members
  repo.setKeyBindings('key_1', [])
  assert.equal(repo.remove(aOfficial.id), true)
  assert.equal(repo.get(aOfficial.id), null)
  assert.equal(repo.listMembers(aOfficial.id).length, 0)
  // vm-01 remains in aZero
  assert.equal(repo.listMembers(aZero.id).length, 1)

  // Sticky bindings round-trip + purge
  const baseMs = 1_760_000_000_000
  repo.upsertStickyBinding({
    scope_kind: 'machine',
    pool_id: aZero.id,
    model_family: 'claude',
    identity_id: 'mach-1',
    node_type: 'claude_vm',
    node_id: 'vm-01',
    machine_id: 'mach-1',
    bound_at_ms: baseMs,
    last_seen_ms: baseMs + 1000,
    expires_at_ms: baseMs + 604_800_000,
    hits: 3,
    generation: 2,
  })
  repo.upsertStickyBinding({
    scope_kind: 'session',
    pool_id: aZero.id,
    model_family: 'claude',
    identity_id: '22222222-2222-4222-8222-222222222222',
    node_type: 'claude_vm',
    node_id: 'vm-01',
    bound_at_ms: baseMs - 10_000,
    last_seen_ms: baseMs - 5_000,
    expires_at_ms: baseMs - 1,
    hits: 1,
  })
  const liveSticky = repo.listLiveStickyBindings(baseMs)
  assert.equal(liveSticky.length, 1)
  assert.equal(liveSticky[0].identity_id, 'mach-1')
  assert.equal(liveSticky[0].expires_at_ms, baseMs + 604_800_000)
  assert.equal(repo.purgeExpiredStickyBindings(baseMs), 1)

  // Node penalties round-trip + purge
  repo.upsertNodePenalty({
    node_type: 'claude_vm',
    node_id: 'vm-01',
    model_scope: 'claude-opus-4-5',
    reason: 'quota_5h',
    cooldown_until_ms: baseMs + 300_000,
    ladder_step: 2,
  })
  repo.upsertNodePenalty({
    node_type: 'gemini_env',
    node_id: 'gem-1',
    model_scope: '*',
    reason: 'expired_429',
    cooldown_until_ms: baseMs - 10,
    ladder_step: 1,
  })
  const activePenalties = repo.listActiveNodePenalties(baseMs)
  assert.equal(activePenalties.length, 1)
  assert.equal(activePenalties[0].reason, 'quota_5h')
  assert.equal(repo.purgeExpiredNodePenalties(baseMs), 1)
})

test('bootstrapSchedulerPools skips strictly with zero DB access when isStandby=true, backfills legacy data, and is idempotent without overwriting manual edits', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-m0-boot-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  // 1. Standby guard must execute ZERO DB statements
  const trapDb = {
    prepare() {
      throw new Error('standby must not prepare SQL')
    },
    exec() {
      throw new Error('standby must not exec SQL')
    },
  }
  const skipped = bootstrapSchedulerPools({ db: trapDb, isStandby: true })
  assert.deepEqual(skipped, {
    skipped: true,
    reason: 'standby',
    pools: 0,
    members: 0,
    bindings: 0,
    apiKeysUpdated: 0,
  })

  // 2. Seed legacy vm_pools, vm_pool_members, and api_keys
  const db = createDatabase({ dbPath: path.join(tmpDir, 'kin.db') })
  t.after(() => db.close())
  const now = '2026-11-27T08:00:00.000Z'

  db.prepare('INSERT INTO vm_pools (id, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'pool_a1b2c3d4',
    'Alpha Pool',
    1,
    now,
    now,
  )
  db.prepare('INSERT INTO vm_pools (id, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'pool_slug_dup',
    'Alpha-Pool',
    1,
    now,
    now,
  )
  db.prepare('INSERT INTO vm_pools (id, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'pool_zh01',
    '官方提示词池',
    0,
    now,
    now,
  )

  db.prepare('INSERT INTO vm_pool_members (pool_id, vm_id, created_at) VALUES (?, ?, ?)').run(
    'pool_a1b2c3d4',
    'vm-01',
    now,
  )
  db.prepare('INSERT INTO vm_pool_members (pool_id, vm_id, created_at) VALUES (?, ?, ?)').run(
    'pool_a1b2c3d4',
    'vm-02',
    now,
  )
  db.prepare('INSERT INTO vm_pool_members (pool_id, vm_id, created_at) VALUES (?, ?, ?)').run('pool_zh01', 'vm-03', now)

  const insKey = db.prepare(
    'INSERT INTO api_keys (id, name, key, status, vm_pool_id, default_pool_id, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  insKey.run('key_active', 'Active Bound', 'sk-a', 'active', 'pool_a1b2c3d4', null, now, null)
  insKey.run('key_deleted', 'Deleted Bound', 'sk-d', 'disabled', 'pool_a1b2c3d4', null, now, now)
  insKey.run('key_dangling', 'Dangling Pool', 'sk-x', 'active', 'pool_deleted_999', null, now, null)
  insKey.run('key_unbound', 'Unbound', 'sk-u', 'active', null, null, now, null)

  // Standby run against real DB must still leave everything untouched
  const standbyReal = bootstrapSchedulerPools({ db, isStandby: true })
  assert.equal(standbyReal.skipped, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduler_pools').get().n, 0)
  assert.equal(db.prepare('SELECT default_pool_id FROM api_keys WHERE id = ?').get('key_active').default_pool_id, null)

  // 3. First Leader bootstrap
  const r1 = bootstrapSchedulerPools({ db, isStandby: false })
  assert.deepEqual(r1, {
    skipped: false,
    reason: null,
    pools: 3,
    members: 3,
    bindings: 1,
    apiKeysUpdated: 1,
  })

  const repo = new SchedulerPoolsRepo(db)
  const pAlpha = repo.get('pool_a1b2c3d4')
  assert.equal(pAlpha.provider_scope, 'anthropic')
  assert.equal(pAlpha.system_prompt_mode, 'inherit_global')
  assert.equal(pAlpha.slug, 'alpha-pool')
  assert.equal(pAlpha.enabled, true)
  assert.equal(pAlpha.exclusive_members, false)
  assert.equal(pAlpha.session_overflow_policy, 'spill_immediately')
  assert.equal(pAlpha.session_busy_wait_ms, 0)
  assert.equal(pAlpha.machine_ttl_seconds, 604800)
  assert.equal(pAlpha.session_ttl_seconds, 86400)
  assert.deepEqual(
    pAlpha.members.map((m) => [m.node_type, m.node_id]),
    [
      ['claude_vm', 'vm-01'],
      ['claude_vm', 'vm-02'],
    ],
  )

  const pDup = repo.get('pool_slug_dup')
  assert.notEqual(pDup.slug, pAlpha.slug)
  assert.equal(pDup.provider_scope, 'anthropic')
  assert.equal(pDup.system_prompt_mode, 'inherit_global')

  const pZh = repo.get('pool_zh01')
  assert.equal(pZh.enabled, false)
  assert.equal(pZh.slug, 'pool_zh01')
  assert.equal(pZh.provider_scope, 'anthropic')
  assert.equal(pZh.system_prompt_mode, 'inherit_global')

  // Only active key with valid pool is backfilled
  const kActive = db.prepare('SELECT default_pool_id, pool_binding_mode FROM api_keys WHERE id = ?').get('key_active')
  assert.equal(kActive.default_pool_id, 'pool_a1b2c3d4')
  assert.equal(kActive.pool_binding_mode, 'legacy_scope')
  assert.equal(repo.listBindingsByKey('key_active').length, 1)
  assert.equal(repo.listBindingsByKey('key_active')[0].is_default, true)
  assert.equal(repo.listBindingsByKey('key_deleted').length, 0)
  assert.equal(repo.listBindingsByKey('key_dangling').length, 0)
  assert.equal(
    db.prepare('SELECT default_pool_id FROM api_keys WHERE id = ?').get('key_dangling').default_pool_id,
    null,
  )

  // 4. Re-running bootstrap is a pure no-op
  const r2 = bootstrapSchedulerPools({ db, isStandby: false })
  assert.deepEqual(r2, {
    skipped: false,
    reason: null,
    pools: 0,
    members: 0,
    bindings: 0,
    apiKeysUpdated: 0,
  })

  // 5. Operator manually edits backfilled records -> subsequent bootstrap MUST NOT overwrite manual values
  repo.update('pool_a1b2c3d4', {
    name: 'Alpha Renamed',
    system_prompt_mode: 'zero_inject',
    machine_ttl_seconds: 1_209_600,
  })
  db.prepare(
    "UPDATE scheduler_pool_members SET weight_tier_override = 10 WHERE pool_id = 'pool_a1b2c3d4' AND node_id = 'vm-01'",
  ).run()
  const manualPool = repo.insert({ name: 'Manual Pool', provider_scope: 'anthropic' })
  repo.setKeyBindings('key_active', [manualPool.id], { defaultPoolId: manualPool.id })

  const r3 = bootstrapSchedulerPools({ db, isStandby: false })
  assert.deepEqual(r3, {
    skipped: false,
    reason: null,
    pools: 0,
    members: 0,
    bindings: 0,
    apiKeysUpdated: 0,
  })

  const afterPool = repo.get('pool_a1b2c3d4')
  assert.equal(afterPool.name, 'Alpha Renamed')
  assert.equal(afterPool.system_prompt_mode, 'zero_inject')
  assert.equal(afterPool.machine_ttl_seconds, 1_209_600)
  assert.equal(afterPool.members.find((m) => m.node_id === 'vm-01').weight_tier_override, 10)
  assert.equal(
    db.prepare('SELECT default_pool_id FROM api_keys WHERE id = ?').get('key_active').default_pool_id,
    manualPool.id,
  )
  assert.deepEqual(
    repo.listBindingsByKey('key_active').map((b) => b.pool_id),
    [manualPool.id],
  )
})

test('SQL translation for SchedulerPoolsRepo queries produces valid PostgreSQL SQL and server.mjs wires Leader-only bootstrap', () => {
  const sampleQueries = [
    'SELECT * FROM scheduler_pools WHERE LOWER(slug) = LOWER(?)',
    `INSERT INTO scheduler_pools (id, slug, name, enabled, provider_scope, system_prompt_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'anthropic', 'inherit_global', ?, ?) ON CONFLICT (id) DO NOTHING`,
    `UPDATE api_keys SET default_pool_id = ? WHERE id = ? AND (default_pool_id IS NULL OR TRIM(default_pool_id) = '')`,
  ]
  for (const q of sampleQueries) {
    const { sql } = translateSqliteToPg(q)
    assert.doesNotMatch(sql, /\?/)
    assert.doesNotMatch(sql, /COLLATE\s+NOCASE/i)
  }

  const serverSrc = fs.readFileSync(path.join(ROOT, 'src/server.mjs'), 'utf8')
  assert.match(
    serverSrc,
    /import\s*\{\s*bootstrapSchedulerPools\s*\}\s*from\s*'\.\/lib\/db\/repos\/scheduler-pools-repo\.mjs'/,
  )
  assert.match(
    serverSrc,
    /runAtActivation\(\s*'scheduler-pools-bootstrap'[\s\S]*?bootstrapSchedulerPools\(\{\s*db:\s*getDb\(\),\s*isStandby:\s*!standbyActive\s*\}\)/,
  )
})

test('072 SQLite / 009 PG migrations safely repair untouched legacy vm_pools backfill rows without clobbering manual passthrough pools', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-m0-072-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  // Build DB through 071 only (simulating pre-072 upgraded host)
  const upTo071Dir = path.join(tmpDir, 'migs-071')
  fs.mkdirSync(upTo071Dir, { recursive: true })
  for (const f of fs.readdirSync(SQLITE_MIG_DIR)) {
    if (/^\d+.*\.sql$/.test(f) && f <= '071_scheduler_center.sql') {
      fs.copyFileSync(path.join(SQLITE_MIG_DIR, f), path.join(upTo071Dir, f))
    }
  }
  const dbPath = path.join(tmpDir, 'kin.db')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON')
  t.after(() => db.close())
  applyMigrations(db, { migrationsDir: upTo071Dir })

  const now = '2026-11-27T08:00:00.000Z'
  // 1. Untouched legacy vm_pool backfilled under old 071 default (config_version=1, passthrough) -> SHOULD become inherit_global
  db.prepare('INSERT INTO vm_pools (id, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'pool_legacy_auto',
    'Legacy Auto',
    1,
    now,
    now,
  )
  db.prepare(
    "INSERT INTO scheduler_pools (id, slug, name, enabled, provider_scope, system_prompt_mode, config_version, created_at, updated_at) VALUES (?, ?, ?, 1, 'anthropic', 'passthrough', 1, ?, ?)",
  ).run('pool_legacy_auto', 'legacy-auto', 'Legacy Auto', now, now)

  // 2. Legacy vm_pool manually edited back to passthrough (config_version=2) -> MUST stay passthrough
  db.prepare('INSERT INTO vm_pools (id, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    'pool_legacy_manual',
    'Legacy Manual',
    1,
    now,
    now,
  )
  db.prepare(
    "INSERT INTO scheduler_pools (id, slug, name, enabled, provider_scope, system_prompt_mode, config_version, created_at, updated_at) VALUES (?, ?, ?, 1, 'anthropic', 'passthrough', 2, ?, ?)",
  ).run('pool_legacy_manual', 'legacy-manual', 'Legacy Manual', now, now)

  // 3. Direct scheduler_pool explicitly created with passthrough (not in vm_pools) -> MUST stay passthrough
  db.prepare(
    "INSERT INTO scheduler_pools (id, slug, name, enabled, provider_scope, system_prompt_mode, config_version, created_at, updated_at) VALUES (?, ?, ?, 1, 'anthropic', 'passthrough', 1, ?, ?)",
  ).run('pool_direct_pt', 'direct-pt', 'Direct Passthrough', now, now)

  // 4. OpenAI pool -> MUST stay passthrough
  db.prepare(
    "INSERT INTO scheduler_pools (id, slug, name, enabled, provider_scope, system_prompt_mode, config_version, created_at, updated_at) VALUES (?, ?, ?, 1, 'openai', 'passthrough', 1, ?, ?)",
  ).run('pool_openai_pt', 'openai-pt', 'OpenAI Pool', now, now)

  const applied = applyMigrations(db)
  assert.deepEqual(applied, ['072_scheduler_pool_prompt_default.sql'])

  const modeOf = (id) =>
    db.prepare('SELECT system_prompt_mode FROM scheduler_pools WHERE id = ?').get(id).system_prompt_mode
  assert.equal(modeOf('pool_legacy_auto'), 'inherit_global')
  assert.equal(modeOf('pool_legacy_manual'), 'passthrough')
  assert.equal(modeOf('pool_direct_pt'), 'passthrough')
  assert.equal(modeOf('pool_openai_pt'), 'passthrough')

  // Verify PG 009 updates DDL default and carries the same safe backfill repair
  const pg009Sql = fs.readFileSync(PG_009, 'utf8')
  const sqlite072Sql = fs.readFileSync(SQLITE_072, 'utf8')
  assert.match(
    pg009Sql,
    /ALTER TABLE scheduler_pools[\s\S]*ALTER COLUMN system_prompt_mode SET DEFAULT 'inherit_global'/i,
  )
  assert.match(pg009Sql, /SET system_prompt_mode = 'inherit_global'/i)
  assert.match(pg009Sql, /config_version = 1/i)
  assert.match(sqlite072Sql, /SET system_prompt_mode = 'inherit_global'/i)
})

test('PostgreSQL 008 migration, SchedulerPoolsRepo, bootstrapSchedulerPools, and sqlite-to-pg --verify parity', {
  skip: !PG_URL,
}, async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-m0-pg-'))
  const schema = `vm2api_m0_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const admin = new pg.Client({ connectionString: PG_URL })
  await admin.connect()
  await admin.query(`CREATE SCHEMA "${schema}"`)
  await admin.end()

  const u = new URL(PG_URL)
  u.searchParams.set('options', `-c search_path=${schema}`)
  const schemaUrl = u.toString()

  t.after(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    const cleanup = new pg.Client({ connectionString: PG_URL })
    await cleanup.connect()
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await cleanup.end()
  })

  // Seed SQLite with all tables including 071 scheduler tables and migrate with --verify
  const sqlitePath = path.join(tmpDir, 'mock.db')
  seedMockSqlite({ outPath: sqlitePath, usageCount: 20 })
  const migResult = await migrateSqliteToPostgres({ sqlitePath, pgUrl: schemaUrl, verify: true })
  assert.equal(migResult.ok, true)
  assert.equal(migResult.verification.ok, true)
  assert.equal(migResult.verification.mismatches, 0)
  assert.equal(migResult.verification.aggregates.scheduler_pools.ok, true)

  // Verify SchedulerPoolsRepo + bootstrapSchedulerPools directly on PgSyncDb
  const syncDb = await createPgSyncDb(resolvePgConfig({ connectionString: schemaUrl }))
  try {
    const repo = new SchedulerPoolsRepo(syncDb)
    assert.ok(repo.list().length >= 2)
    const created = repo.insert({ name: 'PG Pool', provider_scope: 'anthropic', system_prompt_mode: 'zero_inject' })
    assert.equal(created.exclusive_members, false)
    assert.equal(created.session_overflow_policy, 'spill_immediately')
    assert.equal(created.session_busy_wait_ms, 0)
    const boot = bootstrapSchedulerPools({ db: syncDb, isStandby: false })
    assert.equal(boot.skipped, false)
  } finally {
    syncDb.close()
  }

  // Re-applying PG migrations is idempotent
  const pool = new pg.Pool({ connectionString: schemaUrl })
  try {
    const again = await applyPgMigrations(pool)
    assert.deepEqual(again, [])
  } finally {
    await pool.end()
  }
})
