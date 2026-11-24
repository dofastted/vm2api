#!/usr/bin/env node
/**
 * Full-Scale PostgreSQL Migration End-to-End Verification Orchestrator (Tiers 1, 3, 5A, 5B, 5C, 6).
 *
 * Reusable verification harness that exercises:
 *   - Phase A (Tier 1 + 5A): 33-table extreme-edge-case Mock SQLite seed -> PG migration ->
 *     field-by-field row parity check (first/mid/last of every table) -> idempotent re-run ->
 *     post-migration BIGSERIAL sequence continuity inserts.
 *   - Phase B (Tier 3): Live `node src/server.mjs` HTTP full CRUD (users, api-keys + live auth/rotate/disable
 *     L1+Redis cache invalidation, vm-pools + 409, api-endpoints + keys, proxies, pricing/reprice/routing/backups) ->
 *     online PG backup + dirty write + restore -> SIGTERM + reboot persistence check.
 *   - Phase C (Tier 6): 50-concurrency mixed HTTP + 2,000 Mock PG write burst -> Event Loop Lag p99 ->
 *     PG pool/deadlock check -> concurrent advisory-lock migration race -> transient PG container restart recovery.
 *   - Phase D (Tier 5B): Real production SQLite snapshot migration + field-by-field spot-check across all
 *     populated tables + post-migration Mock writes & incremental dashboard rollup.
 *   - Phase E (Tier 5C): Real non-dry-run `deploy/replace-db-to-pg.sh` cutover + live `/api/panel/database/metrics`
 *     verification + `--rollback` back to SQLite + byte-for-byte `kin.db` SHA-256 verification.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { seedMockSqlite, MOCK_DB_SECRET } from './seed-mock-sqlite.mjs'
import { migrateSqliteToPostgres, MIGRATION_TABLES } from './migrate-sqlite-to-pg.mjs'
import { createPgPool } from '../src/lib/db/pg/pg-pool.mjs'
import { resolvePgConfig } from '../src/lib/db/pg/config.mjs'
import { applyPgMigrations } from '../src/lib/db/pg/migrations-runner.mjs'
import { createPgSyncDb } from '../src/lib/db/pg/pg-sync-db.mjs'
import { runDashboardAggregation } from '../src/lib/db/pg/dashboard-aggregator.mjs'
import { UsersRepo } from '../src/lib/db/repos/users-repo.mjs'
import { ApiKeysRepo } from '../src/lib/db/repos/api-keys-repo.mjs'
import { RedeemCodesRepo } from '../src/lib/db/repos/redeem-codes-repo.mjs'
import { UsageLogsRepo } from '../src/lib/db/repos/usage-logs-repo.mjs'
import { RequestAttemptsRepo } from '../src/lib/db/repos/request-attempts-repo.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const opts = {
    pgUrl: process.env.VM2API_TEST_PG_URL || process.env.DATABASE_URL || '',
    redisUrl: process.env.VM2API_TEST_REDIS_URL || process.env.REDIS_URL || '',
    realDb: '',
    workDir: path.join(os.tmpdir(), 'vm2api-pg-e2e'),
    pgContainer: '',
    skipRealDb: false,
    skipCutover: false,
    skipPgRestart: false,
    stressSeconds: 12,
    stressConcurrency: 50,
    reportPath: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--pg-url') opts.pgUrl = argv[++i]
    else if (a === '--redis-url') opts.redisUrl = argv[++i]
    else if (a === '--real-db') opts.realDb = argv[++i]
    else if (a === '--work-dir') opts.workDir = argv[++i]
    else if (a === '--pg-container') opts.pgContainer = argv[++i]
    else if (a === '--stress-seconds') opts.stressSeconds = Number(argv[++i]) || 12
    else if (a === '--stress-concurrency') opts.stressConcurrency = Number(argv[++i]) || 50
    else if (a === '--report') opts.reportPath = argv[++i]
    else if (a === '--skip-real-db') opts.skipRealDb = true
    else if (a === '--skip-cutover') opts.skipCutover = true
    else if (a === '--skip-pg-restart') opts.skipPgRestart = true
  }
  return opts
}

function withSchemaUrl(baseUrl, schema) {
  const u = new URL(baseUrl)
  u.searchParams.set('options', `-c search_path=${schema}`)
  return u.toString()
}

function sha256File(filePath) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(2 * 1024 * 1024)
    let n = 0
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(n === buf.length ? buf : buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function normalizeForComparison(val) {
  if (val === undefined || val === null) return null
  if (typeof val === 'bigint') return Number(val)
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
    return Buffer.from(val).toString('utf8').replaceAll('\u0000', '')
  }
  if (typeof val === 'string') return val.replaceAll('\u0000', '')
  return val
}

function valuesEqual(aRaw, bRaw, table, col) {
  const a = normalizeForComparison(aRaw)
  const b = normalizeForComparison(bRaw)
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  if (table === 'crag_shop_orders' && col === 'slot_limit') {
    return String(a) === String(b)
  }
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      return Math.abs(na - nb) <= Math.max(1e-6, Math.abs(na) * 1e-9)
    }
  }
  return String(a) === String(b)
}

/**
 * Field-by-field spot-check of first, middle, and last row across every migrated table
 * comparing SQLite source vs PostgreSQL target directly.
 */
async function spotCheckAllTablesFieldByField(sqlitePath, pgPool) {
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true })
  const mismatches = []
  let tablesChecked = 0
  let rowsChecked = 0
  let fieldsChecked = 0

  try {
    const sqliteTables = new Set(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name),
    )

    for (const table of MIGRATION_TABLES) {
      if (!sqliteTables.has(table)) continue
      const cnt = Number(sqlite.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get()?.c || 0)
      if (cnt === 0) continue

      const pgColRes = await pgPool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      )
      const pgCols = new Set(pgColRes.rows.map((r) => r.column_name))
      const sqliteCols = sqlite
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((r) => r.name)
      const sharedCols = sqliteCols.filter((c) => pgCols.has(c))
      if (!sharedCols.length) continue

      // Determine primary key columns in PG for deterministic ordering & exact row lookup
      const pkRes = await pgPool.query(
        `SELECT a.attname AS col
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = $1::regclass AND i.indisprimary
         ORDER BY array_position(i.indkey, a.attnum)`,
        [`"${table}"`],
      )
      const pkCols = pkRes.rows.map((r) => r.col).filter((c) => sharedCols.includes(c))
      const orderCols = pkCols.length ? pkCols : [sharedCols[0]]
      const orderBy = orderCols.map((c) => `"${c}" ASC`).join(', ')
      const selectList = sharedCols.map((c) => `"${c}"`).join(', ')

      const offsets = [...new Set([0, Math.floor(cnt / 2), cnt - 1])]
      tablesChecked += 1

      for (const off of offsets) {
        const sRow = sqlite
          .prepare(`SELECT ${selectList} FROM "${table}" ORDER BY ${orderBy} LIMIT 1 OFFSET ?`)
          .get(off)
        if (!sRow) continue

        let pRow = null
        if (pkCols.length) {
          const where = pkCols.map((c, idx) => `"${c}" = $${idx + 1}`).join(' AND ')
          const vals = pkCols.map((c) => normalizeForComparison(sRow[c]))
          const res = await pgPool.query(`SELECT ${selectList} FROM "${table}" WHERE ${where} LIMIT 1`, vals)
          pRow = res.rows[0] || null
        } else {
          const res = await pgPool.query(`SELECT ${selectList} FROM "${table}" ORDER BY ${orderBy} LIMIT 1 OFFSET $1`, [
            off,
          ])
          pRow = res.rows[0] || null
        }

        rowsChecked += 1
        if (!pRow) {
          mismatches.push({ table, offset: off, reason: 'missing_in_pg', pk: pkCols.map((c) => sRow[c]) })
          continue
        }
        for (const col of sharedCols) {
          fieldsChecked += 1
          if (!valuesEqual(sRow[col], pRow[col], table, col)) {
            mismatches.push({
              table,
              offset: off,
              col,
              sqlite: String(sRow[col]).slice(0, 120),
              pg: String(pRow[col]).slice(0, 120),
            })
          }
        }
      }
    }
  } finally {
    sqlite.close()
  }

  return { ok: mismatches.length === 0, tablesChecked, rowsChecked, fieldsChecked, mismatches }
}

/** Start `src/server.mjs` and wait for `/health` === 200. */
async function startServer({ port, projectRoot, pgUrl, redisUrl, masterKey }) {
  fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'config'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'vms'), { recursive: true })
  const dstSrcConfig = path.join(projectRoot, 'src', 'config')
  if (!fs.existsSync(dstSrcConfig)) {
    fs.cpSync(path.join(REPO_ROOT, 'src', 'config'), dstSrcConfig, { recursive: true })
  }

  const logs = []
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'src', 'server.mjs')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      KIN_PROJECT_ROOT: projectRoot,
      VM2API_DB_DRIVER: 'postgres',
      DATABASE_URL: pgUrl,
      ...(redisUrl
        ? { REDIS_URL: redisUrl, VM2API_REDIS_DISABLED: '0' }
        : { VM2API_REDIS_DISABLED: '1', REDIS_URL: '' }),
      VM2API_API_KEY: masterKey,
      KIN_API_KEY: masterKey,
      VM2API_ADMIN_PASSWORD: 'E2eAdminPassword!2026',
      VM2API_DB_SECRET: MOCK_DB_SECRET,
      KIN_CRS_MOCK: '1',
      KIN_BACKUP_DISABLED: '1',
      NO_PROXY: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => {
    const s = d.toString()
    if (logs.length < 200) logs.push(s)
  })
  child.stderr.on('data', (d) => {
    const s = d.toString()
    if (logs.length < 200) logs.push('[stderr] ' + s)
  })

  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}:\n${logs.join('')}`)
    }
    try {
      const r = await fetch(`${baseUrl}/health`)
      if (r.status === 200) return { child, baseUrl, logs }
    } catch {}
    await sleep(250)
  }
  child.kill('SIGKILL')
  throw new Error(`server did not become healthy on ${baseUrl}:\n${logs.join('')}`)
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return { code: child?.exitCode ?? 0 }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, 10_000)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
    child.kill('SIGTERM')
  })
}

async function apiReq(baseUrl, method, p, { token = '', body = undefined } = {}) {
  const headers = { connection: 'close' }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return Math.round(sorted[idx] * 100) / 100
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.pgUrl) {
    console.error('Missing --pg-url (or VM2API_TEST_PG_URL)')
    process.exit(2)
  }

  fs.mkdirSync(opts.workDir, { recursive: true })
  const report = {
    startedAt: new Date().toISOString(),
    phases: {},
  }

  const adminPool = createPgPool(resolvePgConfig({ connectionString: opts.pgUrl }), { maxOverride: 4 })
  const schemasToDrop = []
  const runId = `${Date.now()}`

  try {
    // =========================================================================
    // PHASE A (Tier 1 + Tier 5A): Mock 33-table seed -> PG migration ->
    // Field-by-field parity -> Idempotent re-run -> Sequence continuity
    // =========================================================================
    console.log(
      '\n[Phase A] Tier 1 + 5A: 33-table Mock Seed -> PG Migration -> Field-by-Field Check -> Sequence Continuity',
    )
    const mockDbPath = path.join(opts.workDir, `mock-kin-${runId}.db`)
    const seedRes = seedMockSqlite({ outPath: mockDbPath, usageCount: 400 })
    const emptyTables = Object.entries(seedRes.tableCounts)
      .filter(([, c]) => c === 0)
      .map(([t]) => t)
    const seededTableCount = Object.keys(seedRes.tableCounts).length
    assert.equal(emptyTables.length, 0, `Mock SQLite must have 0 empty tables, got: ${emptyTables}`)

    const mockSchema = `e2e_mock_${runId}`
    schemasToDrop.push(mockSchema)
    await adminPool.query(`CREATE SCHEMA "${mockSchema}"`)
    const mockPgUrl = withSchemaUrl(opts.pgUrl, mockSchema)

    const mig1 = await migrateSqliteToPostgres({
      sqlitePath: mockDbPath,
      pgUrl: mockPgUrl,
      truncate: true,
      verify: true,
      rollup: true,
    })
    assert.equal(mig1.verification?.ok, true, `Mock migration verify failed: ${JSON.stringify(mig1.verification)}`)
    assert.ok(mig1.totalNulSanitized > 0, `Expected NUL sanitization > 0, got ${mig1.totalNulSanitized}`)
    assert.ok(
      (mig1.rollup?.hourlyBuckets || 0) > 0 && (mig1.rollup?.dailyBuckets || 0) > 0,
      'Expected non-zero dashboard rollups',
    )

    const mockPool = createPgPool(resolvePgConfig({ connectionString: mockPgUrl }), { maxOverride: 8 })
    try {
      const spotA = await spotCheckAllTablesFieldByField(mockDbPath, mockPool)
      assert.equal(
        spotA.ok,
        true,
        `Mock field-by-field parity mismatches: ${JSON.stringify(spotA.mismatches.slice(0, 10))}`,
      )

      // Idempotent re-run without --truncate
      const mig2 = await migrateSqliteToPostgres({
        sqlitePath: mockDbPath,
        pgUrl: mockPgUrl,
        truncate: false,
        verify: true,
        rollup: true,
      })
      assert.equal(mig2.verification?.ok, true, 'Idempotent re-run verification failed')
      const nonSeedInserted = (mig2.tableStats || [])
        .filter((s) => s.table !== 'groups' && s.table !== 'jev_usage_meta')
        .reduce((acc, s) => acc + (s.insertedRows || 0), 0)
      assert.equal(
        nonSeedInserted,
        0,
        `Expected 0 newly inserted rows on non-seeded tables on idempotent re-run, got ${nonSeedInserted}`,
      )

      // Sequence continuity inserts on every BIGSERIAL table
      const seqChecks = {}
      const serialSpecs = [
        {
          table: 'groups',
          insertSql: `INSERT INTO groups (name, description, created_at, updated_at) VALUES ('seq_check_grp', 'ok', '2026-06-15T00:00:00.000Z', '2026-06-15T00:00:00.000Z') RETURNING id`,
          cleanupSql: `DELETE FROM groups WHERE id = $1`,
        },
        {
          table: 'account_allocations',
          insertSql: `INSERT INTO account_allocations (account_id, at, source) VALUES ('acc-mock-1', '2026-06-15T00:00:00.000Z', 'seq_check') RETURNING id`,
          cleanupSql: `DELETE FROM account_allocations WHERE id = $1`,
        },
        {
          table: 'redeem_codes',
          insertSql: `INSERT INTO redeem_codes (code, type, value, status, created_at) VALUES ('kin-seq-check-1', 'balance', 1.0, 'unused', '2026-06-15T00:00:00.000Z') RETURNING id`,
          cleanupSql: `DELETE FROM redeem_codes WHERE id = $1`,
        },
        {
          table: 'request_attempts',
          insertSql: `INSERT INTO request_attempts (request_id, attempt_no, started_at) VALUES ('req_seq_check', 1, '2026-06-15T00:00:00.000Z') RETURNING id`,
          cleanupSql: `DELETE FROM request_attempts WHERE id = $1`,
        },
      ]
      for (const spec of serialSpecs) {
        const prevMax = Number(
          (await mockPool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM "${spec.table}"`)).rows[0].m,
        )
        const ins = await mockPool.query(spec.insertSql)
        const nextId = Number(ins.rows[0].id)
        assert.ok(nextId > prevMax, `${spec.table}: expected new BIGSERIAL id (${nextId}) > prevMax (${prevMax})`)
        await mockPool.query(spec.cleanupSql, [nextId])
        seqChecks[spec.table] = { prevMax, nextId }
      }

      report.phases.phaseA_mockMigration = {
        ok: true,
        seededTables: seededTableCount,
        seededRows: seedRes.totalRows,
        migratedRows: mig1.totalInserted,
        nulSanitized: mig1.totalNulSanitized,
        spotCheck: {
          tablesChecked: spotA.tablesChecked,
          rowsChecked: spotA.rowsChecked,
          fieldsChecked: spotA.fieldsChecked,
        },
        idempotentReRunInserted: mig2.totalInserted,
        sequenceContinuity: seqChecks,
        rollup: mig1.rollup,
      }
      console.log(
        `  PASS: ${spotA.tablesChecked} tables, ${spotA.rowsChecked} rows, ${spotA.fieldsChecked} fields verified (0 mismatches), NUL sanitized=${mig1.totalNulSanitized}, idempotent=0, BIGSERIAL ok`,
      )
    } finally {
      await mockPool.end()
    }

    // =========================================================================
    // PHASE B (Tier 3): Live `src/server.mjs` Full HTTP CRUD + Auth Cache +
    // Online PG Backup/Restore + Restart Persistence
    // =========================================================================
    console.log(
      '\n[Phase B] Tier 3: Live PG+Redis Server Full HTTP CRUD, Auth Cache Invalidation, Online Backup/Restore & Restart Persistence',
    )
    const serverRoot = path.join(opts.workDir, `server-root-${runId}`)
    const masterKey = 'sk-e2e-master-verify-key-9999'
    const serverPort = 18799
    let srv = await startServer({
      port: serverPort,
      projectRoot: serverRoot,
      pgUrl: mockPgUrl,
      redisUrl: opts.redisUrl,
      masterKey,
    })

    let persistKeyPlain = ''
    let persistUserId = ''

    try {
      // 1. Database & cache metrics
      const met = await apiReq(srv.baseUrl, 'GET', '/api/panel/database/metrics', { token: masterKey })
      assert.equal(met.status, 200, `database/metrics failed: ${met.text}`)
      assert.equal(met.json?.data?.database?.engine, 'postgres')
      assert.equal(met.json?.data?.database?.ok, true)
      if (opts.redisUrl) {
        assert.equal(met.json?.data?.cache?.mode, 'l1+redis')
        assert.equal(met.json?.data?.cache?.l2_redis?.connected, true)
        assert.equal(met.json?.data?.cache?.redis_ping_ok, true)
      }

      // 2. Read-heavy migrated panel endpoints
      const readPaths = [
        '/api/panel/dashboard',
        '/api/panel/usage-logs?limit=20',
        '/api/panel/usage-logs/summary',
        '/api/panel/usage-logs/filter-options',
        '/api/panel/usage-logs/overview',
        '/api/panel/statistics?range=7days&dimension=model',
        '/api/panel/statistics/leaderboard?range=7days&scope=model',
        '/api/panel/billing',
        '/api/panel/pricing',
        '/api/panel/routing',
        '/api/panel/proxies',
      ]
      for (const rp of readPaths) {
        const r = await apiReq(srv.baseUrl, 'GET', rp, { token: masterKey })
        assert.equal(r.status, 200, `GET ${rp} failed with ${r.status}: ${r.text.slice(0, 200)}`)
      }

      // 3. Users CRUD + 409 duplicate
      const uCreate = await apiReq(srv.baseUrl, 'POST', '/api/panel/users', {
        token: masterKey,
        body: { username: 'e2e_crud_user', password: 'StrongPassword123!', role: 'user', concurrency: 6 },
      })
      assert.equal(uCreate.status, 201, `POST /users failed: ${uCreate.text}`)
      const uId = uCreate.json?.data?.item?.id
      assert.ok(uId)
      const uDup = await apiReq(srv.baseUrl, 'POST', '/api/panel/users', {
        token: masterKey,
        body: { username: 'e2e_crud_user', password: 'StrongPassword123!', role: 'user' },
      })
      assert.equal(uDup.status, 409, 'Duplicate username must return 409')
      const uPatch = await apiReq(srv.baseUrl, 'PATCH', `/api/panel/users/${uId}`, {
        token: masterKey,
        body: { concurrency: 12 },
      })
      assert.equal(uPatch.status, 200)
      const uDel = await apiReq(srv.baseUrl, 'DELETE', `/api/panel/users/${uId}`, { token: masterKey })
      assert.equal(uDel.status, 200)

      // 4. API Keys CRUD + Live Auth + Rotate/Disable Cache Invalidation
      const kCreate = await apiReq(srv.baseUrl, 'POST', '/api/panel/api-keys', {
        token: masterKey,
        body: { name: 'E2E Cache Key', quota: 25, max_concurrency: 5 },
      })
      assert.equal(kCreate.status, 201, `POST /api-keys failed: ${kCreate.text}`)
      const kId = kCreate.json?.item?.id
      const kPlain1 = kCreate.json?.item?.key
      assert.ok(kId && kPlain1)

      const kReveal = await apiReq(srv.baseUrl, 'POST', `/api/panel/api-keys/${kId}/reveal`, { token: masterKey })
      assert.equal(kReveal.status, 200)
      assert.equal(kReveal.json?.key, kPlain1)

      // Hit /v1/me/quota twice (populates L1+L2 Redis cache)
      const q1 = await apiReq(srv.baseUrl, 'GET', '/v1/me/quota', { token: kPlain1 })
      assert.equal(q1.status, 200, `/v1/me/quota with key1 failed: ${q1.text}`)
      const q2 = await apiReq(srv.baseUrl, 'GET', '/v1/me/quota', { token: kPlain1 })
      assert.equal(q2.status, 200)
      const m1 = await apiReq(srv.baseUrl, 'GET', '/v1/models', { token: kPlain1 })
      assert.equal(m1.status, 200)

      // Rotate key -> old key MUST immediately fail (401), new key MUST immediately succeed (200)
      const kRot = await apiReq(srv.baseUrl, 'POST', `/api/panel/api-keys/${kId}/rotate`, { token: masterKey })
      assert.equal(kRot.status, 200, `rotate failed: ${kRot.text}`)
      const kPlain2 = kRot.json?.item?.key
      assert.ok(kPlain2 && kPlain2 !== kPlain1)

      const qOldAfterRot = await apiReq(srv.baseUrl, 'GET', '/v1/me/quota', { token: kPlain1 })
      assert.equal(qOldAfterRot.status, 401, `Old rotated key must be 401 immediately, got ${qOldAfterRot.status}`)
      const qNewAfterRot = await apiReq(srv.baseUrl, 'GET', '/v1/me/quota', { token: kPlain2 })
      assert.equal(qNewAfterRot.status, 200, `New rotated key must be 200 immediately, got ${qNewAfterRot.status}`)

      // Disable key -> MUST immediately fail (401/403)
      const kDis = await apiReq(srv.baseUrl, 'PATCH', `/api/panel/api-keys/${kId}`, {
        token: masterKey,
        body: { status: 'disabled' },
      })
      assert.equal(kDis.status, 200)
      const qWhileDis = await apiReq(srv.baseUrl, 'GET', '/v1/me/quota', { token: kPlain2 })
      assert.ok(
        qWhileDis.status === 401 || qWhileDis.status === 403,
        `Disabled key must be rejected, got ${qWhileDis.status}`,
      )

      // Re-enable + reset-quota + delete
      assert.equal(
        (
          await apiReq(srv.baseUrl, 'PATCH', `/api/panel/api-keys/${kId}`, {
            token: masterKey,
            body: { status: 'active' },
          })
        ).status,
        200,
      )
      assert.equal((await apiReq(srv.baseUrl, 'GET', '/v1/me/quota', { token: kPlain2 })).status, 200)
      assert.equal(
        (await apiReq(srv.baseUrl, 'POST', `/api/panel/api-keys/${kId}/reset-quota`, { token: masterKey })).status,
        200,
      )
      assert.equal(
        (await apiReq(srv.baseUrl, 'DELETE', `/api/panel/api-keys/${kId}`, { token: masterKey })).status,
        200,
      )
      assert.equal((await apiReq(srv.baseUrl, 'GET', '/v1/me/quota', { token: kPlain2 })).status, 401)

      // 5. VM Pools CRUD + 409 duplicate
      const pCreate = await apiReq(srv.baseUrl, 'POST', '/api/panel/vm-pools', {
        token: masterKey,
        body: { name: 'E2E Pool Alpha', vm_ids: [] },
      })
      assert.equal(pCreate.status, 201, `POST /vm-pools failed: ${pCreate.text}`)
      const poolId = pCreate.json?.data?.pool?.id
      assert.ok(poolId)
      const pDup = await apiReq(srv.baseUrl, 'POST', '/api/panel/vm-pools', {
        token: masterKey,
        body: { name: 'E2E Pool Alpha', vm_ids: [] },
      })
      assert.equal(pDup.status, 409, 'Duplicate vm-pool name must return 409')
      assert.equal(
        (
          await apiReq(srv.baseUrl, 'PATCH', `/api/panel/vm-pools/${poolId}`, {
            token: masterKey,
            body: { name: 'E2E Pool Beta' },
          })
        ).status,
        200,
      )
      assert.equal(
        (await apiReq(srv.baseUrl, 'DELETE', `/api/panel/vm-pools/${poolId}`, { token: masterKey })).status,
        200,
      )

      // 6. API Endpoints + Keys CRUD
      const epCreate = await apiReq(srv.baseUrl, 'POST', '/api/panel/api-endpoints', {
        token: masterKey,
        body: {
          name: 'E2E Upstream',
          base_url: 'https://e2e-upstream.invalid',
          protocol: 'anthropic',
          api_key_entries: [{ api_key: 'sk-upstream-e2e-1111' }],
        },
      })
      assert.equal(epCreate.status, 201, `POST /api-endpoints failed: ${epCreate.text}`)
      const epId = epCreate.json?.item?.id
      assert.ok(epId)
      const epKeyAdd = await apiReq(srv.baseUrl, 'POST', `/api/panel/api-endpoints/${epId}/keys`, {
        token: masterKey,
        body: { api_key: 'sk-upstream-e2e-2222' },
      })
      assert.equal(epKeyAdd.status, 201, `POST /api-endpoints/:id/keys failed: ${epKeyAdd.text}`)
      const epKeyId = epKeyAdd.json?.item?.id
      assert.equal(
        (
          await apiReq(srv.baseUrl, 'PATCH', `/api/panel/api-endpoints/${epId}/keys/${epKeyId}`, {
            token: masterKey,
            body: { disabled: true },
          })
        ).status,
        200,
      )
      assert.equal(
        (await apiReq(srv.baseUrl, 'DELETE', `/api/panel/api-endpoints/${epId}/keys/${epKeyId}`, { token: masterKey }))
          .status,
        200,
      )
      assert.equal(
        (await apiReq(srv.baseUrl, 'DELETE', `/api/panel/api-endpoints/${epId}`, { token: masterKey })).status,
        200,
      )

      // 7. Proxies import / disable / enable / delete
      const prxImp = await apiReq(srv.baseUrl, 'POST', '/api/panel/proxies/import', {
        token: masterKey,
        body: { text: 'socks5://198.51.100.77:1080' },
      })
      assert.equal(prxImp.status, 200, `POST /proxies/import failed: ${prxImp.text}`)
      const prxId = prxImp.json?.data?.items?.[0]?.id || prxImp.json?.items?.[0]?.id
      assert.ok(prxId, `Expected imported proxy id from ${prxImp.text}`)
      assert.equal(
        (await apiReq(srv.baseUrl, 'POST', `/api/panel/proxies/${prxId}/disable`, { token: masterKey })).status,
        200,
      )
      assert.equal(
        (await apiReq(srv.baseUrl, 'POST', `/api/panel/proxies/${prxId}/enable`, { token: masterKey })).status,
        200,
      )
      assert.equal(
        (await apiReq(srv.baseUrl, 'DELETE', `/api/panel/proxies/${prxId}`, { token: masterKey })).status,
        200,
      )

      // 8. Config, pricing override & reprice
      assert.equal(
        (await apiReq(srv.baseUrl, 'PUT', '/api/panel/backups/config', { token: masterKey, body: { retention: 9 } }))
          .status,
        200,
      )
      assert.equal(
        (
          await apiReq(srv.baseUrl, 'POST', '/api/panel/pricing/reprice', {
            token: masterKey,
            body: { since: '2020-01-01T00:00:00.000Z', until: '2030-01-01T00:00:00.000Z' },
          })
        ).status,
        200,
      )

      // 9. Online PG Backup -> Dirty Data -> Online Restore
      const bakCreate = await apiReq(srv.baseUrl, 'POST', '/api/panel/backups', { token: masterKey })
      assert.equal(bakCreate.status, 201, `POST /backups failed: ${bakCreate.text}`)
      const backupId = bakCreate.json?.item?.id
      assert.ok(backupId)

      const dirtyUser = await apiReq(srv.baseUrl, 'POST', '/api/panel/users', {
        token: masterKey,
        body: { username: 'dirty_before_restore', password: 'StrongPassword123!', role: 'user' },
      })
      assert.equal(dirtyUser.status, 201)
      const dirtyKeyRes = await apiReq(srv.baseUrl, 'POST', '/api/panel/api-keys', {
        token: masterKey,
        body: { name: 'Dirty Key Before Restore' },
      })
      assert.equal(dirtyKeyRes.status, 201)
      const dirtyKeyPlain = dirtyKeyRes.json?.item?.key
      assert.equal((await apiReq(srv.baseUrl, 'GET', '/v1/me/quota', { token: dirtyKeyPlain })).status, 200)

      const bakRestore = await apiReq(srv.baseUrl, 'POST', `/api/panel/backups/${backupId}/restore`, {
        token: masterKey,
        body: { confirm: true },
      })
      assert.equal(bakRestore.status, 200, `POST /backups/:id/restore failed: ${bakRestore.text}`)
      const usersAfterRestore = await apiReq(srv.baseUrl, 'GET', '/api/panel/users', { token: masterKey })
      assert.equal(
        usersAfterRestore.json?.data?.items?.some((u) => u.username === 'dirty_before_restore'),
        false,
        'Dirty user must disappear after PG backup restore',
      )
      assert.equal(
        (await apiReq(srv.baseUrl, 'GET', '/v1/me/quota', { token: dirtyKeyPlain })).status,
        401,
        'Dirty API key must immediately return 401 after PG backup restore + cache invalidation',
      )

      // 10. Create persistent marker data -> SIGTERM -> Reboot -> Verify 100% persistence
      const pu = await apiReq(srv.baseUrl, 'POST', '/api/panel/users', {
        token: masterKey,
        body: { username: 'persist_marker_e2e', password: 'StrongPassword123!', role: 'user' },
      })
      assert.equal(pu.status, 201)
      persistUserId = pu.json?.data?.item?.id
      const pk = await apiReq(srv.baseUrl, 'POST', '/api/panel/api-keys', {
        token: masterKey,
        body: { name: 'Persist Stress Key', quota: 100 },
      })
      assert.equal(pk.status, 201)
      persistKeyPlain = pk.json?.item?.key

      const stopRes = await stopServer(srv.child)
      assert.equal(stopRes.code, 0, `Expected graceful SIGTERM exit code 0, got ${JSON.stringify(stopRes)}`)

      // Reboot server against same PG + Redis
      srv = await startServer({
        port: serverPort,
        projectRoot: serverRoot,
        pgUrl: mockPgUrl,
        redisUrl: opts.redisUrl,
        masterKey,
      })
      const usersAfterReboot = await apiReq(srv.baseUrl, 'GET', '/api/panel/users', { token: masterKey })
      assert.equal(
        usersAfterReboot.json?.data?.items?.some((u) => u.id === persistUserId && u.username === 'persist_marker_e2e'),
        true,
        'Persistent marker user must survive server restart',
      )
      assert.equal(
        (await apiReq(srv.baseUrl, 'GET', '/v1/me/quota', { token: persistKeyPlain })).status,
        200,
        'Persistent API key must survive server restart',
      )

      report.phases.phaseB_liveServerCrud = {
        ok: true,
        engine: met.json?.data?.database?.engine,
        cacheMode: met.json?.data?.cache?.mode,
        redisPingMs: met.json?.data?.cache?.redis_ping_ms ?? null,
        readEndpointsPassed: readPaths.length,
        crudVerified: [
          'users',
          'api-keys+cache-invalidation',
          'vm-pools',
          'api-endpoints+keys',
          'proxies',
          'pricing/reprice',
          'backups-online-restore',
          'sigterm-restart-persistence',
        ],
      }
      console.log(
        `  PASS: Full HTTP CRUD + Auth/Rotate/Disable Cache Invalidation + PG Online Backup/Restore + SIGTERM Restart Persistence`,
      )

      // =========================================================================
      // PHASE C (Tier 6): 50-Concurrency Mixed HTTP + 2,000 Mock PG Writes +
      // Event Loop Lag + Pool/Deadlock + Advisory Lock + PG Restart Recovery
      // =========================================================================
      console.log(
        `\n[Phase C] Tier 6: ${opts.stressConcurrency}-Concurrency Stress (${opts.stressSeconds}s) + 2,000 Mock Writes + Advisory Lock + PG Restart Resilience`,
      )
      const statBefore = await adminPool.query(
        `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`,
      )
      const deadlocksBefore = Number(statBefore.rows[0]?.deadlocks || 0)

      const eld = monitorEventLoopDelay({ resolution: 10 })
      eld.enable()

      const stressEndpoints = [
        { p: '/api/panel/usage-logs?limit=20', token: masterKey },
        { p: '/api/panel/statistics?range=7days&dimension=model', token: masterKey },
        { p: '/api/panel/statistics/leaderboard?range=7days&scope=model', token: masterKey },
        { p: '/api/panel/usage-logs/overview', token: masterKey },
        { p: '/api/panel/database/metrics', token: masterKey },
        { p: '/v1/me/quota', token: persistKeyPlain },
      ]

      const latencies = []
      let totalReqs = 0
      let http5xx = 0
      let netErrors = 0
      const stopAt = Date.now() + opts.stressSeconds * 1000
      const stressStart = performance.now()

      const httpWorkers = Array.from({ length: opts.stressConcurrency }, (_, wid) =>
        (async () => {
          let seq = wid
          while (Date.now() < stopAt) {
            const ep = stressEndpoints[seq % stressEndpoints.length]
            seq += 1
            const t0 = performance.now()
            try {
              const r = await fetch(`${srv.baseUrl}${ep.p}`, {
                headers: { authorization: `Bearer ${ep.token}` },
              })
              await r.arrayBuffer()
              const dt = performance.now() - t0
              latencies.push(dt)
              totalReqs += 1
              if (r.status >= 500) http5xx += 1
            } catch {
              netErrors += 1
            }
          }
        })(),
      )

      // Concurrent 2,000-row Mock write burst into PG (`usage_logs` + `request_attempts`)
      const writeBurstPool = createPgPool(resolvePgConfig({ connectionString: mockPgUrl }), { maxOverride: 8 })
      const writeBurstPromise = (async () => {
        const batchSize = 100
        let writtenUsage = 0
        let writtenAttempts = 0
        for (let b = 0; b < 20; b += 1) {
          const client = await writeBurstPool.connect()
          try {
            await client.query('BEGIN')
            for (let i = 0; i < batchSize; i += 1) {
              const idx = b * batchSize + i
              const rid = `req_stress_${runId}_${idx}`
              const ts = new Date(Date.now() - (idx % 3600) * 1000).toISOString()
              await client.query(
                `INSERT INTO usage_logs (
                  id, request_id, created_at, method, path, protocol, api_key_id,
                  vm_id, account_id, model, status, duration_ms, input_tokens, output_tokens, total_cost, actual_cost
                ) VALUES ($1,$1,$2,'POST','/v1/messages','anthropic','key-mock-1','vm-mock-1','acc-mock-1','claude-sonnet-4-5',200,250,500,200,0.0045,0.0045)
                ON CONFLICT (id) DO NOTHING`,
                [rid, ts],
              )
              writtenUsage += 1
              if (i < 25) {
                await client.query(
                  `INSERT INTO request_attempts (request_id, attempt_no, vm_id, account_id, model, started_at, upstream_status, terminal_state)
                   VALUES ($1, 1, 'vm-mock-1', 'acc-mock-1', 'claude-sonnet-4-5', $2, 200, 'ok')`,
                  [rid, ts],
                )
                writtenAttempts += 1
              }
            }
            await client.query('COMMIT')
          } finally {
            client.release()
          }
        }
        return { writtenUsage, writtenAttempts }
      })()

      const [, writeRes] = await Promise.all([Promise.all(httpWorkers), writeBurstPromise])
      const stressElapsedSec = (performance.now() - stressStart) / 1000
      eld.disable()
      await writeBurstPool.end()

      latencies.sort((a, b) => a - b)
      const eldP99Ms = Math.round((eld.percentile(99) / 1e6) * 100) / 100
      const statAfter = await adminPool.query(
        `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`,
      )
      const deadlocksDelta = Number(statAfter.rows[0]?.deadlocks || 0) - deadlocksBefore

      // Verify pool has 0 waiting after drain
      await sleep(300)
      const postMetrics = await apiReq(srv.baseUrl, 'GET', '/api/panel/database/metrics', { token: masterKey })
      const poolWaiting =
        (postMetrics.json?.data?.database?.pg_pool?.async?.waiting ?? 0) +
        (postMetrics.json?.data?.database?.pg_pool?.sync?.waiting ?? 0)

      assert.equal(http5xx, 0, `Stress test had ${http5xx} HTTP 5xx errors!`)
      assert.equal(netErrors, 0, `Stress test had ${netErrors} network errors!`)
      assert.equal(deadlocksDelta, 0, `PG reported ${deadlocksDelta} deadlocks!`)
      assert.equal(poolWaiting, 0, `PG pool still had ${poolWaiting} waiting queries after drain!`)

      // Stop server before advisory lock & PG restart tests
      await stopServer(srv.child)
      srv = null

      // Concurrent advisory-lock migration race (2 parallel instances on brand-new schema)
      const advSchema = `e2e_advlock_${runId}`
      schemasToDrop.push(advSchema)
      await adminPool.query(`CREATE SCHEMA "${advSchema}"`)
      const advUrl = withSchemaUrl(opts.pgUrl, advSchema)
      const advPoolA = createPgPool(resolvePgConfig({ connectionString: advUrl }), { maxOverride: 2 })
      const advPoolB = createPgPool(resolvePgConfig({ connectionString: advUrl }), { maxOverride: 2 })
      try {
        await Promise.all([applyPgMigrations(advPoolA), applyPgMigrations(advPoolB)])
        const migCount = Number((await advPoolA.query('SELECT COUNT(*) AS c FROM schema_migrations')).rows[0].c)
        assert.ok(migCount >= 4, `Expected >= 4 PG migrations applied, got ${migCount}`)
      } finally {
        await advPoolA.end()
        await advPoolB.end()
      }

      // Transient PG container restart recovery
      let pgRestartRecovered = 'skipped'
      if (!opts.skipPgRestart && opts.pgContainer) {
        const resPool = createPgPool(resolvePgConfig({ connectionString: opts.pgUrl }), { maxOverride: 2 })
        try {
          assert.equal((await resPool.query('SELECT 1 AS ok')).rows[0].ok, 1)
          const rRestart = spawnSync('docker', ['restart', opts.pgContainer], { stdio: 'pipe' })
          assert.equal(rRestart.status, 0, `docker restart ${opts.pgContainer} failed: ${rRestart.stderr}`)
          let ready = false
          for (let i = 0; i < 120; i += 1) {
            const p = spawnSync('docker', ['exec', opts.pgContainer, 'pg_isready', '-U', 'vm2api', '-d', 'vm2api'], {
              stdio: 'ignore',
            })
            if (p.status === 0) {
              ready = true
              break
            }
            await sleep(500)
          }
          assert.equal(ready, true, 'PG container did not become ready after restart')
          // Existing pool must self-heal on next query
          let healed = false
          for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
              const q = await resPool.query('SELECT 1 AS ok')
              if (q.rows[0]?.ok === 1) {
                healed = true
                break
              }
            } catch {
              await sleep(300)
            }
          }
          assert.equal(healed, true, 'Existing PG pool failed to self-heal after PG restart')
          pgRestartRecovered = true
        } finally {
          await resPool.end()
        }
      }

      report.phases.phaseC_stressAndResilience = {
        ok: true,
        concurrency: opts.stressConcurrency,
        durationSec: Math.round(stressElapsedSec * 100) / 100,
        totalHttpRequests: totalReqs,
        rps: Math.round((totalReqs / stressElapsedSec) * 10) / 10,
        http5xx,
        netErrors,
        latencyMs: {
          p50: percentile(latencies, 0.5),
          p95: percentile(latencies, 0.95),
          p99: percentile(latencies, 0.99),
        },
        eventLoopLagP99Ms: eldP99Ms,
        concurrentMockWrites: writeRes,
        pgDeadlocksDelta: deadlocksDelta,
        poolWaitingAfterDrain: poolWaiting,
        advisoryLockRaceOk: true,
        pgRestartRecovered,
      }
      console.log(
        `  PASS: ${totalReqs} HTTP reqs (${report.phases.phaseC_stressAndResilience.rps} req/s, p99=${report.phases.phaseC_stressAndResilience.latencyMs.p99}ms, 5xx=0), +${writeRes.writtenUsage} usage_logs +${writeRes.writtenAttempts} attempts, deadlocks=0, adv-lock=OK, pg-restart=${pgRestartRecovered}`,
      )
    } finally {
      if (srv) await stopServer(srv.child)
    }

    // =========================================================================
    // PHASE D (Tier 5B): Real Production SQLite Snapshot Migration +
    // Field-by-Field Spot-Check + Post-Migration Mock Writes & Incremental Rollup
    // =========================================================================
    if (!opts.skipRealDb && opts.realDb && fs.existsSync(opts.realDb)) {
      console.log(
        `\n[Phase D] Tier 5B: Real SQLite Snapshot Migration (${opts.realDb}) + Field Spot-Check + Post-Migration Writes`,
      )
      const hdSchema = `e2e_realdb_${runId}`
      schemasToDrop.push(hdSchema)
      await adminPool.query(`CREATE SCHEMA "${hdSchema}"`)
      const hdPgUrl = withSchemaUrl(opts.pgUrl, hdSchema)

      const t0 = performance.now()
      const hdMig = await migrateSqliteToPostgres({
        sqlitePath: opts.realDb,
        pgUrl: hdPgUrl,
        truncate: true,
        verify: true,
        rollup: true,
      })
      const hdElapsedSec = Math.round(((performance.now() - t0) / 1000) * 100) / 100
      assert.equal(hdMig.verification?.ok, true, `realDb verify failed: ${JSON.stringify(hdMig.verification)}`)

      const hdCfg = resolvePgConfig({ connectionString: hdPgUrl })
      const hdPool = createPgPool(hdCfg, { maxOverride: 6 })
      const hdSync = await createPgSyncDb(hdCfg)
      try {
        const spotHd = await spotCheckAllTablesFieldByField(opts.realDb, hdPool)
        assert.equal(
          spotHd.ok,
          true,
          `realDb field-by-field mismatches: ${JSON.stringify(spotHd.mismatches.slice(0, 10))}`,
        )

        // Post-migration Mock writes directly on top of migrated production data!
        const nowIso = new Date().toISOString()
        const uRepo = new UsersRepo(hdSync)
        uRepo.insert({
          id: `usr_postmig_${runId}`,
          username: `postmig_user_${runId}`,
          password_hash: 'h_postmig',
          role: 'user',
          status: 'active',
          balance: 50,
          created_at: nowIso,
          updated_at: nowIso,
        })
        const kRepo = new ApiKeysRepo(hdSync)
        const postKey = `sk-postmig-${runId}`
        kRepo.insert({
          id: `key_postmig_${runId}`,
          name: 'Post-Migration Key',
          key: postKey,
          key_hash: crypto.createHash('sha256').update(postKey).digest('hex'),
          key_prefix: postKey.slice(0, 12),
          status: 'active',
          user_id: `usr_postmig_${runId}`,
          created_at: nowIso,
          updated_at: nowIso,
        })
        const rRepo = new RedeemCodesRepo(hdSync)
        const postRc = rRepo.create({ value: 12.5, code: `kin-postmig-${runId}` })
        assert.ok(postRc && postRc.id > 0, 'Post-migration BIGSERIAL redeem_code insert failed')

        const ulRepo = new UsageLogsRepo(hdSync)
        const raRepo = new RequestAttemptsRepo(hdSync)
        const preCount = ulRepo.count()
        for (let i = 0; i < 20; i += 1) {
          const rid = `req_postmig_${runId}_${i}`
          ulRepo.insertSummary({
            request_id: rid,
            ts: nowIso,
            method: 'POST',
            path: '/v1/messages',
            protocol: 'anthropic',
            api_key_id: `key_postmig_${runId}`,
            owner_user_id: `usr_postmig_${runId}`,
            model: 'claude-sonnet-4-5',
            status: 200,
            duration_ms: 210,
            input_tokens: 1000,
            output_tokens: 500,
            total_cost: 0.012,
            actual_cost: 0.012,
          })
          if (i < 10) {
            raRepo.begin({ requestId: rid, attemptNo: 1, model: 'claude-sonnet-4-5', selectionReason: 'postmig' })
          }
        }
        assert.equal(ulRepo.count(), preCount + 20)

        // Run incremental dashboard aggregation and confirm new bucket reflects post-migration writes
        const incRollup = await runDashboardAggregation(hdPool, { fullBackfill: false })
        assert.ok(
          (incRollup.hourlyBuckets || 0) >= 1 && (incRollup.dailyBuckets || 0) >= 1,
          'Incremental rollup after post-migration writes must cover new rows',
        )

        report.phases.phaseD_realDb = {
          ok: true,
          elapsedSec: hdElapsedSec,
          migratedRows: hdMig.totalInserted,
          nulSanitized: hdMig.totalNulSanitized,
          spotCheck: {
            tablesChecked: spotHd.tablesChecked,
            rowsChecked: spotHd.rowsChecked,
            fieldsChecked: spotHd.fieldsChecked,
          },
          postMigrationWrites: { users: 1, apiKeys: 1, redeemCodeId: postRc.id, usageLogs: 20, requestAttempts: 10 },
          initialRollup: hdMig.rollup,
          incrementalRollup: incRollup,
        }
        console.log(
          `  PASS: ${hdMig.totalInserted} real rows migrated in ${hdElapsedSec}s, ${spotHd.tablesChecked} tables / ${spotHd.fieldsChecked} fields verified (0 mismatches), post-migration Mock writes & incremental rollup OK`,
        )
      } finally {
        hdSync.close()
        await hdPool.end()
      }
    } else {
      report.phases.phaseD_realDb = { skipped: true }
    }

    // =========================================================================
    // PHASE E (Tier 5C): Real Non-Dry-Run `deploy/replace-db-to-pg.sh`
    // Cutover + Live Verification + `--rollback` + Byte-for-Byte SQLite Integrity
    // =========================================================================
    if (!opts.skipCutover) {
      console.log('\n[Phase E] Tier 5C: Real Non-Dry-Run deploy/replace-db-to-pg.sh Cutover + --rollback E2E')
      const cutDir = path.join(opts.workDir, `e2e-cutover-${runId}`)
      const shimBin = path.join(cutDir, 'shim-bin')
      const dropinDir = path.join(cutDir, 'systemd-dropin')
      const cutPort = 18801
      const cutMasterKey = 'sk-cutover-e2e-verify-7777'
      fs.mkdirSync(path.join(cutDir, 'data'), { recursive: true })
      fs.mkdirSync(path.join(cutDir, 'config'), { recursive: true })
      fs.mkdirSync(path.join(cutDir, 'vms'), { recursive: true })
      fs.cpSync(path.join(REPO_ROOT, 'src', 'config'), path.join(cutDir, 'src', 'config'), { recursive: true })
      fs.mkdirSync(shimBin, { recursive: true })
      fs.mkdirSync(dropinDir, { recursive: true })

      // Copy Mock SQLite & link scripts/node_modules so host node migrator runs verbatim
      const cutSqlite = path.join(cutDir, 'data', 'kin.db')
      fs.copyFileSync(mockDbPath, cutSqlite)
      const origSqliteSha = sha256File(cutSqlite)
      fs.symlinkSync(path.join(REPO_ROOT, 'scripts'), path.join(cutDir, 'scripts'))
      fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(cutDir, 'node_modules'))

      // Initial SQLite .env
      fs.writeFileSync(
        path.join(cutDir, '.env'),
        [
          `PORT=${cutPort}`,
          'HOST=127.0.0.1',
          'VM2API_DB_DRIVER=sqlite',
          `VM2API_API_KEY=${cutMasterKey}`,
          'VM2API_ADMIN_PASSWORD=E2eAdminPassword!2026',
          `VM2API_DB_SECRET=${MOCK_DB_SECRET}`,
          'KIN_CRS_MOCK=1',
          'KIN_BACKUP_DISABLED=1',
          '',
        ].join('\n'),
        { mode: 0o600 },
      )

      // Fake `systemctl` shim that actually launches/stops `node src/server.mjs` with `.env` + drop-in!
      const pidFile = path.join(cutDir, 'vm2api.pid')
      const srvLog = path.join(cutDir, 'vm2api.log')
      const shimScript = `#!/usr/bin/env bash
set -euo pipefail
CMD="\${1:-}"
ENV_FILE="${cutDir}/.env"
DROPIN="${dropinDir}/20-postgres.conf"
PID_FILE="${pidFile}"
case "$CMD" in
  list-unit-files|is-enabled|cat)
    exit 0
    ;;
  daemon-reload)
    exit 0
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      PID="$(cat "$PID_FILE" || true)"
      if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        kill -TERM "$PID" || true
        for _ in $(seq 1 40); do
          kill -0 "$PID" 2>/dev/null || break
          sleep 0.25
        done
        kill -KILL "$PID" 2>/dev/null || true
      fi
      rm -f "$PID_FILE"
    fi
    exit 0
    ;;
  start)
    if [ -f "$PID_FILE" ]; then
      PID="$(cat "$PID_FILE" || true)"
      if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        exit 0
      fi
    fi
    (
      set -a
      unset VM2API_DB_DRIVER DATABASE_URL REDIS_URL VM2API_REDIS_DISABLED VM2API_DATABASE_URL VM2API_REDIS_URL
      [ -f "$ENV_FILE" ] && source "$ENV_FILE"
      if [ -f "$DROPIN" ]; then
        while IFS= read -r line; do
          case "$line" in
            Environment=*)
              kv="\${line#Environment=}"
              export "$kv"
              ;;
          esac
        done < "$DROPIN"
      fi
      export KIN_PROJECT_ROOT="${cutDir}"
      export NO_PROXY="127.0.0.1,localhost"
      set +a
      nohup node "${REPO_ROOT}/src/server.mjs" >"${srvLog}" 2>&1 </dev/null &
      echo $! > "$PID_FILE"
    )
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`
      const shimPath = path.join(shimBin, 'systemctl')
      fs.writeFileSync(shimPath, shimScript, { mode: 0o755 })

      const cutSchema = `e2e_cutover_${runId}`
      schemasToDrop.push(cutSchema)
      await adminPool.query(`CREATE SCHEMA "${cutSchema}"`)
      const cutPgUrl = withSchemaUrl(opts.pgUrl, cutSchema)

      const cutEnv = {
        ...process.env,
        PATH: `${shimBin}:${process.env.PATH}`,
        VM2API_SYSTEMD_DROPIN_DIR: dropinDir,
        NO_PROXY: '127.0.0.1,localhost',
      }

      try {
        // Boot initial SQLite instance via shim
        assert.equal(spawnSync(shimPath, ['start'], { env: cutEnv }).status, 0)
        let bootedSqlite = false
        for (let i = 0; i < 120; i += 1) {
          try {
            const r = await fetch(`http://127.0.0.1:${cutPort}/health`, { headers: { connection: 'close' } })
            if (r.status === 200) {
              bootedSqlite = true
              break
            }
          } catch {}
          await sleep(250)
        }
        assert.equal(bootedSqlite, true, 'Initial SQLite server in cutover sandbox did not boot')
        const preMet = await apiReq(`http://127.0.0.1:${cutPort}`, 'GET', '/api/panel/database/metrics', {
          token: cutMasterKey,
        })
        assert.equal(preMet.json?.data?.database?.engine, 'sqlite')

        // Run REAL non-dry-run cutover script!
        const cutArgs = [
          path.join(REPO_ROOT, 'deploy', 'replace-db-to-pg.sh'),
          '--mode',
          'systemd',
          '--dir',
          cutDir,
          '--database-url',
          cutPgUrl,
          '--skip-disk-check',
          '--yes',
        ]
        if (opts.redisUrl) cutArgs.push('--redis-url', opts.redisUrl)
        else cutArgs.push('--no-redis')

        const cutRun = spawnSync('bash', cutArgs, { env: cutEnv, encoding: 'utf8' })
        assert.equal(
          cutRun.status,
          0,
          `replace-db-to-pg.sh cutover failed (exit ${cutRun.status}):\nSTDOUT:\n${cutRun.stdout}\nSTDERR:\n${cutRun.stderr}`,
        )

        // Verify drop-in syntax is valid systemd (every non-comment line after [Service] starts with Environment=)
        const dropinText = fs.readFileSync(path.join(dropinDir, '20-postgres.conf'), 'utf8')
        const badDropinLines = dropinText
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#') && l !== '[Service]' && !l.startsWith('Environment='))
        assert.deepEqual(badDropinLines, [], `Malformed systemd drop-in lines: ${JSON.stringify(badDropinLines)}`)

        // Verify live cutover server is running on PG + Redis!
        const postCutMet = await apiReq(`http://127.0.0.1:${cutPort}`, 'GET', '/api/panel/database/metrics', {
          token: cutMasterKey,
        })
        assert.equal(postCutMet.status, 200)
        assert.equal(postCutMet.json?.data?.database?.engine, 'postgres')
        assert.equal(postCutMet.json?.data?.database?.ok, true)

        // Verify backup snapshot created before cutover
        const backupDirs = fs
          .readdirSync(path.join(cutDir, 'data', 'backups'))
          .filter((d) => d.startsWith('pre-pg-migration-'))
        assert.ok(backupDirs.length >= 1, 'Expected pre-pg-migration backup directory')

        // Now execute REAL --rollback back to SQLite!
        const rbRun = spawnSync(
          'bash',
          [path.join(REPO_ROOT, 'deploy', 'replace-db-to-pg.sh'), '--mode', 'systemd', '--dir', cutDir, '--rollback'],
          { env: cutEnv, encoding: 'utf8' },
        )
        assert.equal(
          rbRun.status,
          0,
          `replace-db-to-pg.sh --rollback failed (exit ${rbRun.status}):\nSTDOUT:\n${rbRun.stdout}\nSTDERR:\n${rbRun.stderr}`,
        )
        assert.equal(
          fs.existsSync(path.join(dropinDir, '20-postgres.conf')),
          false,
          'Drop-in must be removed on rollback',
        )

        const postRbMet = await apiReq(`http://127.0.0.1:${cutPort}`, 'GET', '/api/panel/database/metrics', {
          token: cutMasterKey,
        })
        assert.equal(postRbMet.status, 200)
        assert.equal(postRbMet.json?.data?.database?.engine, 'sqlite')

        // Stop SQLite server cleanly before computing SHA-256 of kin.db
        spawnSync(shimPath, ['stop'], { env: cutEnv })
        const backupDbSha = sha256File(path.join(cutDir, 'data', 'backups', backupDirs[0], 'kin.db'))
        assert.equal(
          backupDbSha,
          origSqliteSha,
          'Pre-migration SQLite backup SHA-256 must match source kin.db byte-for-byte',
        )

        report.phases.phaseE_cutoverAndRollback = {
          ok: true,
          preEngine: 'sqlite',
          postCutoverEngine: postCutMet.json?.data?.database?.engine,
          postCutoverCacheMode: postCutMet.json?.data?.cache?.mode,
          postRollbackEngine: postRbMet.json?.data?.database?.engine,
          dropinValidated: true,
          backupSqliteSha256Matched: true,
        }
        console.log(
          `  PASS: Non-dry-run cutover (sqlite -> postgres/${postCutMet.json?.data?.cache?.mode}) + valid systemd drop-in + --rollback (postgres -> sqlite) + backup kin.db SHA-256 exact match`,
        )
      } finally {
        spawnSync(shimPath, ['stop'], { env: cutEnv })
      }
    } else {
      report.phases.phaseE_cutoverAndRollback = { skipped: true }
    }

    report.finishedAt = new Date().toISOString()
    report.ok = true
    if (opts.reportPath) {
      fs.writeFileSync(opts.reportPath, JSON.stringify(report, null, 2))
    }
    console.log('\nALL E2E VERIFICATION PHASES PASSED!')
  } finally {
    for (const sc of schemasToDrop) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${sc}" CASCADE`).catch(() => {})
    }
    await adminPool.end().catch(() => {})
  }
}

main().catch((err) => {
  console.error('\nE2E VERIFICATION FAILED:', err)
  process.exit(1)
})
