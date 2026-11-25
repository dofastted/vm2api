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

export const LEGACY_SKIP_TABLES = new Set([
  'accounts_legacy',
  'account_runtime_states_legacy',
  'panel_users_legacy',
  'schema_migrations',
])
export const DB_CREATED_AT_SETTING_KEY = 'usage_logs_db_created_at'

const SEEDED_OVERRIDE_TABLES = new Set(['groups', 'jev_usage_meta'])
const SERIAL_ID_TABLES = ['groups', 'account_allocations', 'redeem_codes', 'request_attempts']
const MAX_PG_PARAMS = 60_000
const MAX_BATCH_BYTES = 4 * 1024 * 1024
const PROGRESS_BYTES_STEP = 64 * 1024 * 1024

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe SQL identifier: ${name}`)
  }
  return `"${name}"`
}

export function sanitizeValue(table, col, val, counters = { nulFields: 0 }) {
  if (val === undefined || val === null) return null
  if (table === 'crag_shop_orders' && col === 'slot_limit') {
    return String(val)
  }
  if (table === 'request_attempts' && col === 'cooldown_until') {
    if (typeof val === 'bigint') return val.toString()
    if (typeof val === 'number') return Number.isFinite(val) ? Math.trunc(val) : null
    if (typeof val === 'string') {
      const trimmed = val.trim()
      if (!trimmed) return null
      if (/^-?\d+$/.test(trimmed)) return trimmed
      if (/^-?\d+\.\d+$/.test(trimmed)) {
        const n = Number(trimmed)
        return Number.isFinite(n) ? Math.trunc(n) : null
      }
      const parsed = Date.parse(trimmed)
      return Number.isFinite(parsed) ? Math.trunc(parsed) : null
    }
    return null
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
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name),
  )
}

function findUnmappedSqliteTables(existingSrc) {
  const known = new Set([...MIGRATION_TABLES, ...LEGACY_SKIP_TABLES])
  return [...existingSrc].filter((t) => !known.has(t)).sort()
}

function readSqliteOriginCreatedAt(sqlite, existingSrc) {
  if (!existingSrc.has('schema_migrations')) return null
  try {
    const row = sqlite.prepare("SELECT MIN(applied_at) AS t FROM schema_migrations WHERE version = '001'").get()
    const raw = row?.t ? String(row.t) : null
    return raw && Number.isFinite(Date.parse(raw)) ? raw : null
  } catch {
    return null
  }
}

function sqliteHasSettingKey(sqlite, existingSrc, key) {
  if (!existingSrc.has('settings')) return false
  try {
    return !!sqlite.prepare('SELECT 1 AS ok FROM settings WHERE key = ?').get(key)
  } catch {
    return false
  }
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

async function migrateTable(sqlite, pool, table, { batchSize = 500, allowPartialSchema = false, log = () => {} } = {}) {
  const startedAt = Date.now()
  const srcCols = sqliteColumns(sqlite, table)
  const dstColSet = new Set(await pgColumns(pool, table))
  const missingDstCols = srcCols.filter((c) => !dstColSet.has(c))
  if (missingDstCols.length && !allowPartialSchema) {
    throw new Error(
      `Schema mismatch on table "${table}": SQLite column(s) missing in PostgreSQL (${missingDstCols.join(', ')}). Update PostgreSQL migrations before migrating.`,
    )
  }
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
  let streamedBytes = 0
  let nextProgressBytes = PROGRESS_BYTES_STEP
  const client = await pool.connect()

  try {
    // Reconcile PG migration-seeded tables (`groups`, `jev_usage_meta`) cleanly when
    // no dependent rows exist yet, preventing name-swap collisions or stale seed rows.
    if (SEEDED_OVERRIDE_TABLES.has(table)) {
      let canReplaceSeed = true
      if (table === 'groups') {
        const refRes = await client.query('SELECT COUNT(*)::bigint AS c FROM "account_groups"')
        canReplaceSeed = Number(refRes.rows?.[0]?.c || 0) === 0
      }
      if (canReplaceSeed) {
        const allSrcRows = pageStmt.all(0, 10_000)
        await client.query('BEGIN')
        try {
          await client.query('SET LOCAL synchronous_commit = off')
          await client.query(`DELETE FROM ${quoteIdent(table)}`)
          if (allSrcRows.length) {
            const batch = allSrcRows.map((raw) => {
              sourceRows += 1
              streamedBytes += estimateRowBytes(raw, cols)
              return cols.map((c) => sanitizeValue(table, c, raw[c], counters))
            })
            insertedRows += await insertBatch(client, table, cols, batch, { upsertConflictCol })
          }
          await client.query('COMMIT')
        } catch (err) {
          try {
            await client.query('ROLLBACK')
          } catch {}
          throw err
        }
        return {
          table,
          sourceRows,
          insertedRows,
          streamedBytes,
          nulFieldsSanitized: counters.nulFields,
          durationMs: Date.now() - startedAt,
        }
      }
    }

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
        streamedBytes += rowBytes
      }

      await flushSub()

      const crossedRows = sourceRows % 25_000 < effectiveBatch && sourceRows >= 25_000
      const crossedBytes = streamedBytes >= nextProgressBytes
      if (crossedRows || crossedBytes) {
        while (streamedBytes >= nextProgressBytes) nextProgressBytes += PROGRESS_BYTES_STEP
        const mib = (streamedBytes / (1024 * 1024)).toFixed(1)
        log(`  [${table}] streamed ${sourceRows.toLocaleString()} rows (${mib} MiB)...`)
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
    streamedBytes,
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

async function verifyMigration(sqlite, pool, tables, { ignoreSyntheticOriginSetting = false } = {}) {
  const tableChecks = []
  let mismatches = 0

  for (const table of tables) {
    let srcCount
    let dstCount
    if (table === 'settings' && ignoreSyntheticOriginSetting) {
      srcCount = Number(
        sqlite.prepare('SELECT COUNT(*) AS c FROM "settings" WHERE key <> ?').get(DB_CREATED_AT_SETTING_KEY)?.c || 0,
      )
      dstCount = Number(
        (await pool.query('SELECT COUNT(*)::bigint AS c FROM "settings" WHERE key <> $1', [DB_CREATED_AT_SETTING_KEY]))
          .rows[0]?.c || 0,
      )
    } else {
      srcCount = Number(sqlite.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`).get()?.c || 0)
      dstCount = Number((await pool.query(`SELECT COUNT(*)::bigint AS c FROM ${quoteIdent(table)}`)).rows[0]?.c || 0)
    }
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

  if (tables.includes('crag_shop_orders')) {
    const sqlShop = 'SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_minor), 0) AS amount_minor FROM crag_shop_orders'
    const s = sqlite.prepare(sqlShop).get()
    const p = (await pool.query(sqlShop)).rows[0]
    const ok = Number(s.cnt) === Number(p.cnt) && Number(s.amount_minor) === Number(p.amount_minor)
    if (!ok) mismatches += 1
    aggregates.crag_shop_orders = { ok, sqlite: s, postgres: p }
  }

  if (tables.includes('vms')) {
    const sIds = sqlite
      .prepare('SELECT id FROM vms ORDER BY id')
      .all()
      .map((r) => r.id)
    const pIds = (await pool.query('SELECT id FROM vms ORDER BY id')).rows.map((r) => r.id)
    const ok = sIds.length === pIds.length && sIds.every((id, idx) => id === pIds[idx])
    if (!ok) mismatches += 1
    aggregates.vms = { ok, sqlite: sIds.length, postgres: pIds.length }
  }

  // Verify BIGSERIAL sequences sit at or above MAX(id) so subsequent inserts never collide.
  const sequences = {}
  for (const table of SERIAL_ID_TABLES) {
    if (!tables.includes(table)) continue
    const maxRes = await pool.query(`SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM ${quoteIdent(table)}`)
    const maxId = Number(maxRes.rows?.[0]?.max_id || 0)
    const seqRes = await pool.query(
      "SELECT pg_sequence_last_value(pg_get_serial_sequence($1, 'id')::regclass)::bigint AS last_val",
      [table],
    )
    const lastValRaw = seqRes.rows?.[0]?.last_val
    const lastVal = lastValRaw == null ? null : Number(lastValRaw)
    const ok = maxId === 0 ? true : lastVal != null && lastVal >= maxId
    if (!ok) mismatches += 1
    sequences[table] = { ok, maxId, lastVal }
  }

  return {
    ok: mismatches === 0,
    mismatches,
    tables: tableChecks,
    aggregates,
    sequences,
  }
}

/**
 * Zero-downtime, read-only preflight audit of a SQLite database (and optional target PG).
 * Checks integrity, unmapped tables, PG constraint hazards, table row counts, and PG privileges.
 */
export async function preflightSqliteToPostgres({
  sqlitePath,
  pgUrl,
  pgConfig,
  skipIntegrityCheck = false,
  log = () => {},
} = {}) {
  if (!sqlitePath || !fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database not found: ${sqlitePath}`)
  }

  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true })
  const blockingIssues = []
  const warnings = []

  try {
    sqlite.exec('PRAGMA query_only = ON')

    let quickCheck = 'skipped'
    if (!skipIntegrityCheck) {
      const check = sqlite.prepare('PRAGMA quick_check').get()
      quickCheck = String(Object.values(check || {})[0] || 'unknown')
      if (quickCheck !== 'ok') {
        blockingIssues.push(`SQLite PRAGMA quick_check failed: ${quickCheck}`)
      }
    }

    const existingSrc = sqliteTables(sqlite)
    const unmappedTables = findUnmappedSqliteTables(existingSrc)
    if (unmappedTables.length) {
      blockingIssues.push(`Unmapped non-legacy SQLite table(s): ${unmappedTables.join(', ')}`)
    }

    const tableCounts = {}
    let totalRows = 0
    for (const t of MIGRATION_TABLES) {
      if (!existingSrc.has(t)) continue
      const c = Number(sqlite.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(t)}`).get()?.c || 0)
      tableCounts[t] = c
      totalRows += c
    }

    let migrations = { count: 0, firstVersion: null, firstAppliedAt: null, lastVersion: null, lastAppliedAt: null }
    if (existingSrc.has('schema_migrations')) {
      const rows = sqlite.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all()
      migrations = {
        count: rows.length,
        firstVersion: rows[0]?.version ?? null,
        firstAppliedAt: rows[0]?.applied_at ?? null,
        lastVersion: rows.at(-1)?.version ?? null,
        lastAppliedAt: rows.at(-1)?.applied_at ?? null,
      }
    }

    const hazards = {}
    if (existingSrc.has('usage_logs')) {
      hazards.usageLogsNullCreatedAt = Number(
        sqlite.prepare("SELECT COUNT(*) AS c FROM usage_logs WHERE created_at IS NULL OR created_at = ''").get()?.c ||
          0,
      )
      if (hazards.usageLogsNullCreatedAt > 0) {
        blockingIssues.push(`usage_logs has ${hazards.usageLogsNullCreatedAt} row(s) with NULL/empty created_at`)
      }
    }
    if (existingSrc.has('users')) {
      hazards.usersCiDuplicateUsernames = sqlite
        .prepare(
          'SELECT LOWER(username) AS username, COUNT(*) AS c FROM users WHERE deleted_at IS NULL GROUP BY LOWER(username) HAVING c > 1',
        )
        .all()
      if (hazards.usersCiDuplicateUsernames.length > 0) {
        blockingIssues.push(
          `users has case-insensitive duplicate active username(s): ${hazards.usersCiDuplicateUsernames.map((r) => r.username).join(', ')}`,
        )
      }
      hazards.usersDuplicateEmails = sqlite
        .prepare('SELECT email, COUNT(*) AS c FROM users WHERE deleted_at IS NULL GROUP BY email HAVING c > 1')
        .all()
      if (hazards.usersDuplicateEmails.length > 0) {
        blockingIssues.push(
          `users has duplicate active email(s): ${hazards.usersDuplicateEmails.map((r) => r.email).join(', ')}`,
        )
      }
    }
    if (existingSrc.has('groups')) {
      hazards.groupsDuplicateActiveNames = sqlite
        .prepare('SELECT name, COUNT(*) AS c FROM groups WHERE deleted_at IS NULL GROUP BY name HAVING c > 1')
        .all()
      if (hazards.groupsDuplicateActiveNames.length > 0) {
        blockingIssues.push(
          `groups has duplicate active name(s): ${hazards.groupsDuplicateActiveNames.map((r) => r.name).join(', ')}`,
        )
      }
    }

    // Foreign-key orphan checks for tables enforced with FOREIGN KEY in PG 001_init.sql
    const fkChecks = [
      ['account_groups', 'account_id', 'accounts', 'id'],
      ['account_groups', 'group_id', 'groups', 'id'],
      ['api_endpoint_keys', 'endpoint_id', 'api_endpoints', 'id'],
      ['api_endpoint_models', 'endpoint_id', 'api_endpoints', 'id'],
      ['cluster_node_direct_links', 'node_id', 'cluster_nodes', 'id'],
      ['risk_device_aliases', 'device_key', 'refusal_device_blocks', 'device_id'],
      ['vm_pool_members', 'pool_id', 'vm_pools', 'id'],
    ]
    hazards.fkOrphans = {}
    for (const [child, childCol, parent, parentCol] of fkChecks) {
      if (!existingSrc.has(child) || !existingSrc.has(parent)) continue
      const c = Number(
        sqlite
          .prepare(
            `SELECT COUNT(*) AS c FROM ${quoteIdent(child)} WHERE ${quoteIdent(childCol)} IS NOT NULL AND ${quoteIdent(childCol)} NOT IN (SELECT ${quoteIdent(parentCol)} FROM ${quoteIdent(parent)})`,
          )
          .get()?.c || 0,
      )
      if (c > 0) {
        hazards.fkOrphans[`${child}.${childCol}`] = c
        blockingIssues.push(`FK orphan rows in ${child}.${childCol} missing in ${parent}.${parentCol}: ${c}`)
      }
    }
    if (existingSrc.has('cluster_nodes')) {
      const c = Number(
        sqlite
          .prepare(
            'SELECT COUNT(*) AS c FROM cluster_nodes WHERE jump_node_id IS NOT NULL AND jump_node_id NOT IN (SELECT id FROM cluster_nodes)',
          )
          .get()?.c || 0,
      )
      if (c > 0) {
        hazards.fkOrphans['cluster_nodes.jump_node_id'] = c
        blockingIssues.push(`Self-FK orphan rows in cluster_nodes.jump_node_id: ${c}`)
      }
    }

    const sqliteSizeBytes = fs.statSync(sqlitePath).size
    const walPath = `${sqlitePath}-wal`
    const walSizeBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0

    let pgProbe = null
    const resolvedPg = pgUrl || pgConfig ? resolvePgConfig({ connectionString: pgUrl, pgConfig }) : null
    if (resolvedPg) {
      const pool = createPgPool(resolvedPg, { maxOverride: 2 })
      try {
        const meta = (
          await pool.query(
            `SELECT current_database() AS db, current_user AS usr, current_schema() AS schema,
                    current_setting('server_version') AS version,
                    has_schema_privilege(current_schema(), 'CREATE') AS can_create`,
          )
        ).rows[0]
        let existingUsageLogs = null
        try {
          existingUsageLogs = Number((await pool.query('SELECT COUNT(*)::bigint AS c FROM usage_logs')).rows[0]?.c || 0)
        } catch {}
        pgProbe = {
          ok: true,
          database: meta.db,
          user: meta.usr,
          schema: meta.schema,
          version: meta.version,
          canCreate: Boolean(meta.can_create),
          existingUsageLogs,
        }
        if (!pgProbe.canCreate) {
          blockingIssues.push(`PostgreSQL user "${pgProbe.user}" lacks CREATE privilege on schema "${pgProbe.schema}"`)
        }
        if (existingUsageLogs != null && existingUsageLogs > 0) {
          warnings.push(
            `Target PostgreSQL usage_logs already contains ${existingUsageLogs.toLocaleString()} row(s) (pass --truncate for a clean replace)`,
          )
        }
      } catch (err) {
        pgProbe = { ok: false, error: String(err?.message || err) }
        blockingIssues.push(`PostgreSQL preflight connection failed: ${pgProbe.error}`)
      } finally {
        await pool.end().catch(() => {})
      }
    }

    const ok = blockingIssues.length === 0
    log(
      `Preflight ${ok ? 'PASSED' : 'FAILED'}: ${Object.keys(tableCounts).length} active tables, ${totalRows.toLocaleString()} rows, SQLite ${(sqliteSizeBytes / 1048576).toFixed(1)} MiB (WAL ${(walSizeBytes / 1048576).toFixed(1)} MiB), schema=${migrations.firstVersion || '?'}..${migrations.lastVersion || '?'}`,
    )
    for (const w of warnings) log(`  [warn] ${w}`)
    for (const b of blockingIssues) log(`  [BLOCK] ${b}`)

    return {
      ok,
      blockingIssues,
      warnings,
      quickCheck,
      sqlitePath,
      sqliteSizeBytes,
      walSizeBytes,
      migrations,
      tableCounts,
      totalRows,
      unmappedTables,
      hazards,
      pgProbe,
    }
  } finally {
    try {
      sqlite.close()
    } catch {}
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
  allowPartialSchema = false,
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

    const existingSrc = sqliteTables(sqlite)
    const unmappedTables = findUnmappedSqliteTables(existingSrc)
    if (unmappedTables.length && !allowPartialSchema) {
      throw new Error(
        `SQLite contains unmapped non-legacy table(s): ${unmappedTables.join(', ')}. Update MIGRATION_TABLES before migrating.`,
      )
    }

    log(`Applying PostgreSQL schema migrations to ${redactConnectionString(pgUrl || resolvedPg.host || 'postgres')}...`)
    const appliedMigrations = await applyPgMigrations(pool)
    if (appliedMigrations.length) {
      log(`Applied migrations: ${appliedMigrations.join(', ')}`)
    }

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
      const stat = await migrateTable(sqlite, pool, table, { batchSize: perTableBatch, allowPartialSchema, log })
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

    // Preserve original SQLite DB creation timestamp so UsageLogsRepo.logCoverageStart() stays accurate on PG.
    const originCreatedAt = readSqliteOriginCreatedAt(sqlite, existingSrc)
    const srcHadOriginSetting = sqliteHasSettingKey(sqlite, existingSrc, DB_CREATED_AT_SETTING_KEY)
    if (originCreatedAt && activeTables.includes('settings')) {
      await pool.query(
        'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING',
        [DB_CREATED_AT_SETTING_KEY, JSON.stringify(originCreatedAt), new Date().toISOString()],
      )
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
      log('Verifying row counts, sequences, and aggregate parity...')
      verification = await verifyMigration(sqlite, pool, activeTables, {
        ignoreSyntheticOriginSetting: Boolean(originCreatedAt) && !srcHadOriginSetting,
      })
      if (!verification.ok) {
        throw Object.assign(new Error(`Migration verification failed with ${verification.mismatches} mismatch(es)`), {
          verification,
        })
      }
      log(
        `  [ok] verified ${verification.tables.length} tables + sequences + financial/token aggregates (0 mismatches)`,
      )
    }

    const durationMs = Date.now() - startedAt
    const peakRssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10
    return {
      ok: true,
      sqlitePath,
      sqliteSizeBytes: fs.statSync(sqlitePath).size,
      appliedMigrations,
      originCreatedAt,
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
      preflight: { type: 'boolean', default: false },
      truncate: { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      rollup: { type: 'boolean', default: false },
      'skip-debug': { type: 'boolean', default: false },
      'skip-integrity-check': { type: 'boolean', default: false },
      'allow-partial-schema': { type: 'boolean', default: false },
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
  --preflight              Zero-downtime read-only schema, hazard & optional PG privilege check
  --truncate               Truncate target tables before importing
  --verify                 Verify exact row counts, sequences & token/cost sums after import
  --rollup                 Backfill usage_dashboard_hourly/daily aggregation tables
  --skip-debug             Skip migrating request_log_debug payloads
  --skip-integrity-check   Skip SQLite PRAGMA quick_check pre-flight
  --allow-partial-schema   Allow migrating when SQLite has extra columns/tables not in PG
  --json                   Output machine-readable JSON report
  -h, --help               Show this help`)
    process.exit(0)
  }

  const sqlitePath = values.sqlite || process.env.KIN_DB_PATH || path.join(process.cwd(), 'data', 'kin.db')
  const pgUrl = values['pg-url'] || process.env.VM2API_DATABASE_URL || process.env.DATABASE_URL || ''
  const batchSize = Math.max(10, Math.min(5000, Number.parseInt(values['batch-size'] || '500', 10) || 500))
  const log = values.json ? () => {} : (line) => console.error(line)

  if (values.preflight) {
    preflightSqliteToPostgres({
      sqlitePath,
      pgUrl: pgUrl || undefined,
      skipIntegrityCheck: values['skip-integrity-check'],
      log,
    })
      .then((report) => {
        if (values.json) {
          console.log(JSON.stringify(report, null, 2))
        }
        if (!report.ok) process.exit(1)
      })
      .catch((err) => {
        if (values.json) {
          console.log(JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2))
        } else {
          console.error(`[migrate-sqlite-to-pg] PREFLIGHT ERROR: ${err?.message || err}`)
        }
        process.exit(1)
      })
  } else {
    migrateSqliteToPostgres({
      sqlitePath,
      pgUrl,
      batchSize,
      truncate: values.truncate,
      verify: values.verify,
      rollup: values.rollup,
      skipDebug: values['skip-debug'],
      skipIntegrityCheck: values['skip-integrity-check'],
      allowPartialSchema: values['allow-partial-schema'],
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
}
