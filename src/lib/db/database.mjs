/**
 * Unified database layer supporting both PostgreSQL (production default when
 * configured) and embedded SQLite (`node:sqlite` DatabaseSync, fallback for
 * isolated unit tests and legacy single-file deployments).
 *
 * Env:
 *   VM2API_DB_DRIVER    — auto | postgres | sqlite (default: auto)
 *   VM2API_DATABASE_URL / DATABASE_URL / DATABASE_HOST / PGHOST — PG connection
 *   KIN_DB_PATH         — override SQLite db file path (default <dataDir>/kin.db)
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { startPgReadPool, startSqlitePool, stopSqlitePool } from './sqlite-pool.mjs'
import { armWriteBehind, flushWrites } from './write-behind.mjs'
import { resolveDbDriver, resolvePgConfig } from './pg/config.mjs'
import { createPgPool } from './pg/pg-pool.mjs'
import { applyPgMigrations } from './pg/migrations-runner.mjs'
import { createPgSyncDb } from './pg/pg-sync-db.mjs'
import { startDashboardAggregator, stopDashboardAggregator } from './pg/dashboard-aggregator.mjs'
import { closeCacheRuntime, initCacheRuntime } from '../cache/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

let _instanceSeq = 0
export const DB_INSTANCE_ID = Symbol('vm2api.dbInstanceId')

function tagDbInstance(db, engine) {
  if (!db) return db
  try {
    if (!db[DB_INSTANCE_ID]) db[DB_INSTANCE_ID] = `${engine}:${++_instanceSeq}`
    if (!db.engine) db.engine = engine
  } catch {}
  return db
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

/** LF-canonical hash plus CRLF/raw variants so Windows-applied checksums still match. */
function migrationChecksums(sql) {
  const lf = sql.replace(/\r\n/g, '\n')
  const crlf = lf.replace(/\n/g, '\r\n')
  return {
    canonical: sha256Hex(lf),
    variants: new Set([sha256Hex(sql), sha256Hex(lf), sha256Hex(crlf)]),
  }
}

const HISTORICAL_001_PROXY_CHECKSUMS = new Set([
  '376c686118bbd8aaa6db6ea13fb2ff0afecc0c7464bc3d668743a55c9ccafdde',
  'd6769ea311718b5af91e47295f97c3bf2722ece6d26acee7e89df84b88599ae2',
])

function reconcileHistorical001ProxySchema(db, checksum) {
  if (!HISTORICAL_001_PROXY_CHECKSUMS.has(checksum)) return false
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(proxies)')
      .all()
      .map((row) => row.name),
  )
  const current = ['raw', 'enabled', 'consecutive_failures', 'last_error'].every((name) => columns.has(name))
  if (current && !columns.has('url')) return true
  const historical = ['url', 'failures', 'last_probe_ok', 'disabled_reason', 'updated_at'].every((name) =>
    columns.has(name),
  )
  if (!historical || columns.has('raw')) {
    throw new Error('historical migration 001 proxy schema is not recognized')
  }

  withTransaction(db, () => {
    db.exec(`
      ALTER TABLE proxies RENAME TO proxies_historical_001;
      CREATE TABLE proxies (
        id TEXT PRIMARY KEY,
        scheme TEXT DEFAULT 'socks5',
        host TEXT,
        port INTEGER,
        username TEXT,
        password TEXT,
        raw TEXT,
        status TEXT DEFAULT 'unknown',
        enabled INTEGER DEFAULT 1,
        bound_vm_id TEXT,
        consecutive_failures INTEGER DEFAULT 0,
        latency_ms INTEGER,
        last_probe_at TEXT,
        last_error TEXT,
        created_at TEXT
      );
      INSERT INTO proxies (
        id, scheme, host, port, username, password, raw, status, enabled,
        bound_vm_id, consecutive_failures, latency_ms, last_probe_at,
        last_error, created_at
      )
      SELECT
        id, scheme, host, port, username, password, url,
        CASE
          WHEN status IN ('unknown', 'ok', 'dead') THEN status
          WHEN last_probe_ok = 1 THEN 'ok'
          WHEN last_probe_ok = 0 THEN 'dead'
          ELSE 'unknown'
        END,
        CASE WHEN status = 'disabled' THEN 0 ELSE 1 END,
        bound_vm_id, COALESCE(failures, 0), latency_ms, last_probe_at,
        disabled_reason, created_at
      FROM proxies_historical_001;
      DROP TABLE proxies_historical_001;
    `)
  })
  return true
}

function reconcileCragShopMigrationVersions(db, dir, files) {
  if (!files.includes('055_account_lifetime_usage.sql')) return
  const get = db.prepare('SELECT name, checksum FROM schema_migrations WHERE version = ?')
  if (get.get('055')?.name !== '055_crag_shop_orders.sql') return

  withTransaction(db, () => {
    const move = db.prepare('UPDATE schema_migrations SET version = ?, name = ?, checksum = ? WHERE version = ?')
    for (const [from, to, suffix] of [
      ['057', '058', 'crag_shop_activation.sql'],
      ['056', '057', 'crag_shop_commerce.sql'],
      ['055', '056', 'crag_shop_orders.sql'],
    ]) {
      const row = get.get(from)
      if (!row) continue
      const file = `${to}_${suffix}`
      if (row.name !== `${from}_${suffix}` || !files.includes(file)) {
        throw new Error(`unexpected CRAG shop migration history at ${from}`)
      }
      const { canonical, variants } = migrationChecksums(fs.readFileSync(path.join(dir, file), 'utf8'))
      if (!variants.has(row.checksum)) {
        throw new Error(`migration checksum mismatch for ${row.name}: applied=${row.checksum} current=${canonical}`)
      }
      move.run(to, file, canonical, from)
    }
  })
}

let _db = null
let _dbPath = null
let _engine = 'sqlite'
let _pgPool = null
let _pgConfig = null
let poolWanted = false

export function resolveDbPath({ dataDir, dbPath } = {}) {
  if (dbPath) return dbPath
  if (process.env.KIN_DB_PATH) return process.env.KIN_DB_PATH
  const dir = dataDir || path.join(process.cwd(), 'data')
  return path.join(dir, 'kin.db')
}

/**
 * Standalone (non-singleton) SQLite open: PRAGMAs + migrations applied.
 * Used by unit tests and by stores constructed without a global db.
 * @returns {DatabaseSync}
 */
export function createDatabase({ dataDir, dbPath, migrationsDir } = {}) {
  const file = resolveDbPath({ dataDir, dbPath })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {}
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  applyMigrations(db, { migrationsDir })
  return tagDbInstance(db, 'sqlite')
}

/**
 * Open (or return the already-open) singleton database synchronously (SQLite).
 * For PostgreSQL startup, call `await openDatabaseAsync(...)` during boot.
 * @returns {DatabaseSync|import('./pg/pg-sync-db.mjs').PgSyncDb}
 */
export function openDatabase({ dataDir, dbPath, migrationsDir, pooled = false } = {}) {
  if (pooled) poolWanted = true
  if (_db) {
    if (poolWanted && _engine === 'sqlite') {
      startSqlitePool(_dbPath)
      armWriteBehind(_db)
    }
    return _db
  }
  _db = createDatabase({ dataDir, dbPath, migrationsDir })
  _dbPath = resolveDbPath({ dataDir, dbPath })
  _engine = 'sqlite'
  if (poolWanted) {
    startSqlitePool(_dbPath)
    armWriteBehind(_db)
  }
  return _db
}

/**
 * Async singleton database opener supporting both PostgreSQL and SQLite.
 * Automatically selects PostgreSQL when `VM2API_DB_DRIVER=postgres` or PG env
 * vars (`DATABASE_URL`, `VM2API_DATABASE_URL`, `DATABASE_HOST`, `PGHOST`) exist.
 */
export async function openDatabaseAsync({
  dataDir,
  dbPath,
  migrationsDir,
  pgMigrationsDir,
  pooled = false,
  driver,
  connectionString,
  pgConfig,
  enableAggregator = true,
} = {}) {
  if (pooled) poolWanted = true
  const resolvedDriver = resolveDbDriver({ driver, connectionString })

  if (_db) {
    if (_engine === 'postgres' && poolWanted) {
      startPgReadPool(_db, _pgPool)
      armWriteBehind(_db)
    } else if (_engine === 'sqlite' && poolWanted) {
      startSqlitePool(_dbPath)
      armWriteBehind(_db)
    }
    return _db
  }

  if (resolvedDriver === 'postgres') {
    const resolvedPg = resolvePgConfig({ connectionString, pgConfig })
    if (!resolvedPg) {
      throw new Error(
        'VM2API_DB_DRIVER=postgres requested but no PostgreSQL connection details configured (set DATABASE_URL or DATABASE_HOST)',
      )
    }
    const pool = createPgPool(resolvedPg)
    try {
      await applyPgMigrations(pool, pgMigrationsDir ? { migrationsDir: pgMigrationsDir } : undefined)
      const cacheRt = await initCacheRuntime({ pgPool: pool })
      const syncDb = await createPgSyncDb(resolvedPg, {
        onMutation: (tables) => cacheRt.onDbTablesMutated(tables),
      })
      tagDbInstance(syncDb, 'postgres')
      _db = syncDb
      _pgPool = pool
      _pgConfig = resolvedPg
      _dbPath = null
      _engine = 'postgres'

      if (poolWanted) {
        startPgReadPool(syncDb, pool)
        armWriteBehind(syncDb)
      }
      if (enableAggregator && process.env.VM2API_DASHBOARD_AGGREGATOR_DISABLED !== '1') {
        startDashboardAggregator(pool)
      }
      return _db
    } catch (err) {
      try {
        await pool.end()
      } catch {}
      throw err
    }
  }

  const db = openDatabase({ dataDir, dbPath, migrationsDir, pooled })
  await initCacheRuntime().catch(() => {})
  return db
}

/**
 * Resolve the db a store should use: explicit db → global singleton →
 * standalone SQLite connection rooted at dataDir (test isolation path).
 */
export function resolveStoreDb({ db, dataDir } = {}) {
  if (db) return db
  if (_db) return _db
  return createDatabase({ dataDir })
}

/** Current db instance (throws when not opened). */
export function getDb() {
  if (!_db) throw new Error('database not opened — call openDatabase() first')
  return _db
}

export function isDbOpen() {
  return !!_db
}

export function getDbPath() {
  return _dbPath
}

export function getDbEngine() {
  return _engine
}

export function getPgPool() {
  return _pgPool
}

export function getPgConfig() {
  return _pgConfig
}

export function closeDatabase() {
  flushWrites()
  armWriteBehind(null)
  stopDashboardAggregator()
  stopSqlitePool()
  if (_db) {
    try {
      _db.close()
    } catch {}
  }
  if (_pgPool) {
    const pool = _pgPool
    _pgPool = null
    pool.end().catch(() => {})
  }
  _db = null
  _dbPath = null
  _pgConfig = null
  _engine = 'sqlite'
  poolWanted = false
}

export async function closeDatabaseAsync() {
  flushWrites()
  armWriteBehind(null)
  stopDashboardAggregator()
  stopSqlitePool()
  await closeCacheRuntime().catch(() => {})
  if (_db) {
    try {
      _db.close()
    } catch {}
  }
  if (_pgPool) {
    const pool = _pgPool
    _pgPool = null
    try {
      await pool.end()
    } catch {}
  }
  _db = null
  _dbPath = null
  _pgConfig = null
  _engine = 'sqlite'
  poolWanted = false
}

/**
 * Versioned SQLite SQL migrations with SHA-256 checksum verification.
 */
export function applyMigrations(db, { migrationsDir } = {}) {
  const dir = migrationsDir || MIGRATIONS_DIR
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT,
    checksum TEXT,
    applied_at TEXT
  )`)

  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /^\d+.*\.sql$/.test(f))
        .sort()
    : []

  reconcileCragShopMigrationVersions(db, dir, files)

  const appliedRows = db.prepare('SELECT version, checksum FROM schema_migrations').all()
  const applied = new Map(appliedRows.map((r) => [r.version, r.checksum]))
  const historical001Accepted = reconcileHistorical001ProxySchema(db, applied.get('001'))
  const insert = db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')

  const results = []
  for (const file of files) {
    const version = file.split('_')[0]
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    const { canonical: checksum, variants } = migrationChecksums(sql)
    if (applied.has(version)) {
      const stored = applied.get(version)
      const historicalAccepted =
        version === '001' && historical001Accepted && HISTORICAL_001_PROXY_CHECKSUMS.has(stored)
      if (!variants.has(stored) && !historicalAccepted) {
        throw new Error(`migration checksum mismatch for ${file}: applied=${stored} current=${checksum}`)
      }
      if (stored !== checksum) {
        db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(checksum, version)
      }
      continue
    }
    db.exec('BEGIN')
    try {
      db.exec(sql)
      insert.run(version, file, checksum, new Date().toISOString())
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {}
      throw new Error(`migration ${file} failed: ${e.message}`)
    }
    results.push(file)
  }
  return results
}

/** Run fn inside a transaction (nested calls just run inline). Works on SQLite and PgSyncDb. */
export function withTransaction(db, fn) {
  if (db.isTransaction) return fn()
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch {}
    }
    throw e
  }
}

/**
 * Online-consistent snapshot of the live SQLite database (WAL-safe).
 * @returns {string} destination path
 */
export function vacuumInto(db, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  try {
    fs.rmSync(destPath, { force: true })
  } catch {}
  const esc = String(destPath).replace(/'/g, "''")
  db.exec(`VACUUM INTO '${esc}'`)
  try {
    fs.chmodSync(destPath, 0o600)
  } catch {}
  return destPath
}
