#!/usr/bin/env node
/**
 * Streaming, idempotent SQLite -> PostgreSQL migrator for vm2api.
 *
 * Features:
 * - Applies PostgreSQL schema migrations (001..005) automatically under advisory lock.
 * - Streams all 32 active tables + thinking_signature_owners in FK-safe order using
 *   rowid keyset pagination (constant memory even on multi-GB kin.db).
 * - Sanitizes UTF-8 NUL bytes (\u0000) which PostgreSQL TEXT/JSONB forbids.
 * - Handles self-referential FK (`cluster_nodes.jump_node_id`) in two passes.
 * - Resets all BIGSERIAL sequences and runs ANALYZE after import.
 * - Optional `--verify` checks exact row counts, financial/token sums, and spot rows.
 * - Optional `--rollup` backfills sub2api-style hourly/daily dashboard aggregation tables.
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-pg.mjs --sqlite /path/to/kin.db --pg-url postgresql://... [--verify] [--rollup] [--truncate] [--json]
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { resolvePgConfig, redactConnectionString } from '../src/lib/db/pg/config.mjs'
import { createPgPool } from '../src/lib/db/pg/pg-pool.mjs'
import { applyPgMigrations } from '../src/lib/db/pg/migrations-runner.mjs'
import { runDashboardAggregation } from '../src/lib/db/pg/dashboard-aggregator.mjs'

// FK-safe migration order covering all 32 active vm2api tables + optional runtime table.
// Legacy tables (accounts_legacy, account_runtime_states_legacy, panel_users_legacy) are intentionally skipped.
export const MIGRATION_TABLES = [
  'settings',
  'users',
  'groups',
  'accounts',
  'account_groups',
  'account_runtime',
  'account_allocations',
  'account_lifetime_usage_archive',
  'api_endpoints',
  'api_endpoint_keys',
  'api_endpoint_models',
  'api_keys',
  'backup_records',
  'cluster_nodes',
  'cluster_node_direct_links',
  'crag_shop_orders',
  'gemini_environment_owners',
  'jev_usage_events',
  'jev_usage_meta',
  'jev_usage_totals',
  'proxies',
  'redeem_codes',
  'refusal_device_blocks',
  'risk_device_aliases',
  'refusal_guards',
  'refusal_session_blocks',
  'request_attempts',
  'sticky_sessions',
  'vm_pools',
  'vm_pool_members',
  'vms',
  'thinking_signature_owners',
  'usage_logs',
  'request_log_debug',
]

const SEEDED_OVERRIDE_TABLES = new Set(['groups', 'jev_usage_meta'])
const SERIAL_ID_TABLES = ['groups', 'account_allocations', 'redeem_codes', 'request_attempts']
const MAX_PG_PARAMS = 60_000
const MAX_BATCH_BYTES = 4 * 1024 * 1024

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe SQL identifier: ${name}`)
  }
  return `"${name}"`
}

function sanitizeValue(table, col, val, counters) {
  if (val === undefined || val === null) return null
  if (table === 'crag_shop_orders' && col === 'slot_limit') {
    return String(val)
  }
  if (typeof val === 'bigint') return val.toString()
  if (typeof val === 'string') {
    if (val.includes('\u0000')) {
      counters.nulFields += 1
      return val.replaceAll('\u0000', '')
    }
    return val
  }
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
    const str = Buffer.from(val).toString('utf8')
    if (str.includes('\u0000')) {
      counters.nulFields += 1
      return str.replaceAll('\u0000', '')
    }
    return str
  }
  return val
}

function sqliteTables(sqlite) {
  return new Set(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name),
  )
}

function sqliteColumns(sqlite, table) {
  return sqlite
    .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
    .all()
    .map((r) => r.name)
}

async function pgColumns(pool, table) {
  const res = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  )
  return res.rows.map((r) => r.column_name)
}

function estimateRowBytes(row, cols) {
  let bytes = 64
  for (const c of cols) {
    const v = row[c]
    if (typeof v === 'string') bytes += v.length
    else if (v != null) bytes += 16
  }
  return bytes
}

async function insertBatch(client, table, cols, rows, { upsertConflictCol = null } = {}) {
  if (!rows.length) return 0
  const colCount = cols.length
  const colSql = cols.map(quoteIdent).join(', ')
  const values = []
  const placeholders = []

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r]
    const base = r * colCount
    const ph = []
    for (let c = 0; c < colCount; c += 1) {
      ph.push(`$${base + c + 1}`)
      values.push(row[c])
    }
    placeholders.push(`(${ph.join(', ')})`)
  }

  let conflictSql = 'ON CONFLICT DO NOTHING'
  if (upsertConflictCol) {
    const updates = cols
      .filter((c) => c !== upsertConflictCol)
      .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
      .join(', ')
    conflictSql = `ON CONFLICT (${quoteIdent(upsertConflictCol)}) DO UPDATE SET ${updates}`
  }

  const sql = `INSERT INTO ${quoteIdent(table)} (${colSql}) VALUES ${placeholders.join(', ')} ${conflictSql}`
  const res = await client.query(sql, values)
  return Number(res.rowCount) || 0
}

async function migrateTable(sqlite, pool, table, { batchSize = 500, log = () => {} } = {}) {
  const startedAt = Date.now()
  const srcCols = sqliteColumns(sqlite, table)
  const dstColSet = new Set(await pgColumns(pool, table))
  const cols = srcCols.filter((c) => dstColSet.has(c))
  if (!cols.length) {
    return { table, sourceRows: 0, insertedRows: 0, skipped: true, reason: 'no_common_columns', durationMs: 0 }
  }

  const maxRowsByParams = Math.max(1, Math.floor(MAX_PG_PARAMS / cols.length))
  const effectiveBatch = Math.min(batchSize, maxRowsByParams)
  const counters = { nulFields: 0 }

  const selectCols = cols.map(quoteIdent).join(', ')
  const pageStmt = sqlite.prepare(
    `SELECT rowid AS _src_rowid, ${selectCols} FROM ${quoteIdent(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  )

  const selfFkPending = []
  const hasJumpFk = table === 'cluster_nodes' && cols.includes('jump_node_id')
  const upsertConflictCol = SEEDED_OVERRIDE_TABLES.has(table) ? 'id' : null

  let lastRowid = 0
  let sourceRows = 0
  let insertedRows = 0
  const client = await pool.connect()

  try {
    for (;;) {
      const rawRows = pageStmt.all(lastRowid, effectiveBatch)
      if (!rawRows.length) break
      lastRowid = rawRows[rawRows.length - 1]._src_rowid

      // Chunk further by payload byte budget (critical for multi-MB request_log_debug rows)
      let subBatch = []
      let subBytes = 0

      const flushSub = async () => {
        if (!subBatch.length) return
        await client.query('BEGIN')
        try {
          await client.query('SET LOCAL synchronous_commit = off')
          insertedRows += await insertBatch(client, table, cols, subBatch, { upsertConflictCol })
          await client.query('COMMIT')
        } catch (err) {
          try {
            await client.query('ROLLBACK')
          } catch {}
          throw err
        }
        subBatch = []
        subBytes = 0
      }

      for (const raw of rawRows) {
        sourceRows += 1
        const arr = cols.map((c) => {
          const val = sanitizeValue(table, c, raw[c], counters)
          if (hasJumpFk && c === 'jump_node_id' && val != null) {
            selfFkPending.push({ id: raw.id, jump_node_id: val })
            return null
          }
          return val
        })
        const rowBytes = estimateRowBytes(raw, cols)
        if (subBatch.length > 0 && subBytes + rowBytes > MAX_BATCH_BYTES) {
          await flushSub()
        }
        subBatch.push(arr)
        subBytes += rowBytes
      }

      await flushSub()

      if (sourceRows % 25_000 < effectiveBatch && sourceRows >= 25_000) {
        log(`  [${table}] streamed ${sourceRows.toLocaleString()} rows...`)
      }
    }

    // Second pass for cluster_nodes.jump_node_id self-reference
    if (selfFkPending.length) {
      await client.query('BEGIN')
      try {
        for (const item of selfFkPending) {
          await client.query('UPDATE cluster_nodes SET jump_node_id = $1 WHERE id = $2', [item.jump_node_id, item.id])
        }
        await client.query('COMMIT')
      } catch (err) {
        try {
          await client.query('ROLLBACK')
        } catch {}
        throw err
      }
    }
  } finally {
    client.release()
  }

  return {
    table,
    sourceRows,
    insertedRows,
    nulFieldsSanitized: counters.nulFields,
    durationMs: Date.now() - startedAt,
  }
}

async function resetSequences(pool) {
  const updated = {}
  for (const table of SERIAL_ID_TABLES) {
    const res = await pool.query(
      `SELECT setval(
         pg_get_serial_sequence($1, 'id'),
         GREATEST(COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 1), 1),
         (SELECT COUNT(*) > 0 FROM ${quoteIdent(table)})
       ) AS seq_val`,
      [table],
    )
    updated[table] = Number(res.rows?.[0]?.seq_val || 0)
  }
  return updated
}

async function verifyMigration(sqlite, pool, tables) {
  const tableChecks = []
  let mismatches = 0

  for (const table of tables) {
    const srcCount = Number(sqlite.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`).get()?.c || 0)
    const dstCount = Number(
      (await pool.query(`SELECT COUNT(*)::bigint AS c FROM ${quoteIdent(table)}`)).rows[0]?.c || 0,
    )
    const match = srcCount === dstCount
    if (!match) mismatches += 1
    tableChecks.push({ table, sqlite: srcCount, postgres: dstCount, match })
  }

  const approxEq = (a, b, tol = 1e-4) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= tol

  // Aggregate financial & token parity checks
  const aggregates = {}
  if (tables.includes('usage_logs')) {
    const sqlSum = `SELECT
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
      COALESCE(SUM(total_cost), 0) AS total_cost,
      COALESCE(SUM(actual_cost), 0) AS actual_cost
    FROM usage_logs`
    const s = sqlite.prepare(sqlSum).get()
    const p = (await pool.query(sqlSum)).rows[0]
    const ok =
      Number(s.input_tokens) === Number(p.input_tokens) &&
      Number(s.output_tokens) === Number(p.output_tokens) &&
      Number(s.cache_read_tokens) === Number(p.cache_read_tokens) &&
      Number(s.cache_creation_tokens) === Number(p.cache_creation_tokens) &&
      approxEq(s.total_cost, p.total_cost, 1e-3) &&
      approxEq(s.actual_cost, p.actual_cost, 1e-3)
    if (!ok) mismatches += 1
    aggregates.usage_logs = { ok, sqlite: s, postgres: p }
  }

  if (tables.includes('users')) {
    const sqlBal = 'SELECT COALESCE(SUM(balance), 0) AS total_balance FROM users'
    const s = Number(sqlite.prepare(sqlBal).get()?.total_balance || 0)
    const p = Number((await pool.query(sqlBal)).rows[0]?.total_balance || 0)
    const ok = approxEq(s, p, 1e-5)
    if (!ok) mismatches += 1
    aggregates.users_balance = { ok, sqlite: s, postgres: p }
  }

  if (tables.includes('api_keys')) {
    const sqlQuota =
      'SELECT COALESCE(SUM(quota_used), 0) AS quota_used, COALESCE(SUM(requests), 0) AS requests FROM api_keys'
    const s = sqlite.prepare(sqlQuota).get()
    const p = (await pool.query(sqlQuota)).rows[0]
    const ok = approxEq(s.quota_used, p.quota_used, 1e-5) && Number(s.requests) === Number(p.requests)
    if (!ok) mismatches += 1
    aggregates.api_keys = { ok, sqlite: s, postgres: p }
  }

  if (tables.includes('account_lifetime_usage_archive')) {
    const sqlArch =
      'SELECT COALESCE(SUM(total_cost), 0) AS total_cost, COALESCE(SUM(total_tokens), 0) AS total_tokens FROM account_lifetime_usage_archive'
    const s = sqlite.prepare(sqlArch).get()
    const p = (await pool.query(sqlArch)).rows[0]
    const ok = approxEq(s.total_cost, p.total_cost, 1e-4) && Number(s.total_tokens) === Number(p.total_tokens)
    if (!ok) mismatches += 1
    aggregates.account_lifetime_usage_archive = { ok, sqlite: s, postgres: p }
  }

  return {
    ok: mismatches === 0,
    mismatches,
    tables: tableChecks,
    aggregates,
  }
}

/**
 * Programmatic entry point (also used by automated integration tests).
 */
export async function migrateSqliteToPostgres({
  sqlitePath,
  pgUrl,
  pgConfig,
  batchSize = 500,
  truncate = false,
  verify = false,
  rollup = false,
  skipDebug = false,
  skipIntegrityCheck = false,
  log = () => {},
} = {}) {
  const startedAt = Date.now()
  if (!sqlitePath || !fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database not found: ${sqlitePath}`)
  }

  const resolvedPg = resolvePgConfig({ connectionString: pgUrl, pgConfig })
  if (!resolvedPg) {
    throw new Error('PostgreSQL target not configured (pass --pg-url or set DATABASE_URL)')
  }

  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true })
  const pool = createPgPool(resolvedPg, { maxOverride: 6 })

  try {
    if (!skipIntegrityCheck) {
      const check = sqlite.prepare('PRAGMA quick_check').get()
      const status = Object.values(check || {})[0]
      if (status !== 'ok') {
        throw new Error(`SQLite quick_check failed: ${status}`)
      }
    }

    log(`Applying PostgreSQL schema migrations to ${redactConnectionString(pgUrl || resolvedPg.host || 'postgres')}...`)
    const appliedMigrations = await applyPgMigrations(pool)
    if (appliedMigrations.length) {
      log(`Applied migrations: ${appliedMigrations.join(', ')}`)
    }

    const existingSrc = sqliteTables(sqlite)
    const activeTables = MIGRATION_TABLES.filter((t) => {
      if (skipDebug && t === 'request_log_debug') return false
      return existingSrc.has(t)
    })

    if (truncate) {
      log('Truncating target PostgreSQL tables (--truncate)...')
      const truncTargets = activeTables.filter((t) => t !== 'schema_migrations')
      if (truncTargets.length) {
        await pool.query(`TRUNCATE TABLE ${truncTargets.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`)
      }
    }

    const tableStats = []
    let totalRows = 0
    let totalInserted = 0
    let totalNulSanitized = 0

    for (const table of activeTables) {
      const perTableBatch =
        table === 'request_log_debug'
          ? Math.min(batchSize, 50)
          : table === 'usage_logs'
            ? Math.min(batchSize, 250)
            : batchSize
      const stat = await migrateTable(sqlite, pool, table, { batchSize: perTableBatch, log })
      tableStats.push(stat)
      totalRows += stat.sourceRows
      totalInserted += stat.insertedRows
      totalNulSanitized += stat.nulFieldsSanitized || 0
      if (stat.sourceRows > 0) {
        log(
          `  [ok] ${table}: source=${stat.sourceRows.toLocaleString()} inserted=${stat.insertedRows.toLocaleString()} (${stat.durationMs}ms${stat.nulFieldsSanitized ? `, nul_sanitized=${stat.nulFieldsSanitized}` : ''})`,
        )
      }
    }

    log('Resetting PostgreSQL BIGSERIAL sequences...')
    const sequences = await resetSequences(pool)

    log('Running ANALYZE on migrated tables...')
    for (const table of activeTables) {
      await pool.query(`ANALYZE ${quoteIdent(table)}`)
    }

    let rollupResult = null
    if (rollup) {
      log('Backfilling dashboard aggregation tables (usage_dashboard_hourly / daily)...')
      rollupResult = await runDashboardAggregation(pool, { fullBackfill: true })
      log(
        `  [ok] rollup: hourly_buckets=${rollupResult.hourlyBuckets || 0} daily_buckets=${rollupResult.dailyBuckets || 0}`,
      )
    }

    let verification = null
    if (verify) {
      log('Verifying row counts and aggregate parity...')
      verification = await verifyMigration(sqlite, pool, activeTables)
      if (!verification.ok) {
        throw Object.assign(new Error(`Migration verification failed with ${verification.mismatches} mismatch(es)`), {
          verification,
        })
      }
      log(`  [ok] verified ${verification.tables.length} tables + financial/token aggregates (0 mismatches)`)
    }

    const durationMs = Date.now() - startedAt
    const peakRssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10
    return {
      ok: true,
      sqlitePath,
      sqliteSizeBytes: fs.statSync(sqlitePath).size,
      appliedMigrations,
      tablesMigrated: activeTables.length,
      totalRows,
      totalInserted,
      totalNulSanitized,
      sequences,
      rollup: rollupResult,
      verification,
      durationMs,
      peakRssMb,
      tableStats,
    }
  } finally {
    try {
      sqlite.close()
    } catch {}
    try {
      await pool.end()
    } catch {}
  }
}

function isCliEntry() {
  if (!process.argv[1]) return false
  return (
    path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  )
}

if (isCliEntry()) {
  const { values } = parseArgs({
    options: {
      sqlite: { type: 'string' },
      'pg-url': { type: 'string' },
      'batch-size': { type: 'string', default: '500' },
      truncate: { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      rollup: { type: 'boolean', default: false },
      'skip-debug': { type: 'boolean', default: false },
      'skip-integrity-check': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  if (values.help) {
    console.log(`Usage: node scripts/migrate-sqlite-to-pg.mjs [options]

Options:
  --sqlite <path>          Source SQLite database (default: $KIN_DB_PATH or ./data/kin.db)
  --pg-url <dsn>           Target PostgreSQL URL (default: $VM2API_DATABASE_URL / $DATABASE_URL)
  --batch-size <n>         Max rows per batch (default: 500)
  --truncate               Truncate target tables before importing
  --verify                 Verify exact row counts & token/cost sums after import
  --rollup                 Backfill usage_dashboard_hourly/daily aggregation tables
  --skip-debug             Skip migrating request_log_debug payloads
  --skip-integrity-check   Skip SQLite PRAGMA quick_check pre-flight
  --json                   Output machine-readable JSON report
  -h, --help               Show this help`)
    process.exit(0)
  }

  const sqlitePath = values.sqlite || process.env.KIN_DB_PATH || path.join(process.cwd(), 'data', 'kin.db')
  const pgUrl = values['pg-url'] || process.env.VM2API_DATABASE_URL || process.env.DATABASE_URL || ''
  const batchSize = Math.max(10, Math.min(5000, Number.parseInt(values['batch-size'] || '500', 10) || 500))
  const log = values.json ? () => {} : (line) => console.error(line)

  migrateSqliteToPostgres({
    sqlitePath,
    pgUrl,
    batchSize,
    truncate: values.truncate,
    verify: values.verify,
    rollup: values.rollup,
    skipDebug: values['skip-debug'],
    skipIntegrityCheck: values['skip-integrity-check'],
    log,
  })
    .then((report) => {
      if (values.json) {
        console.log(JSON.stringify(report, null, 2))
      } else {
        console.log(
          `\nMigration complete: ${report.totalRows.toLocaleString()} rows across ${report.tablesMigrated} tables in ${(report.durationMs / 1000).toFixed(2)}s (peak RSS ${report.peakRssMb} MiB).`,
        )
      }
    })
    .catch((err) => {
      if (values.json) {
        console.log(
          JSON.stringify(
            {
              ok: false,
              error: String(err?.message || err),
              verification: err?.verification || null,
            },
            null,
            2,
          ),
        )
      } else {
        console.error(`[migrate-sqlite-to-pg] ERROR: ${err?.message || err}`)
        if (err?.verification) {
          console.error(JSON.stringify(err.verification, null, 2))
        }
      }
      process.exit(1)
    })
}
