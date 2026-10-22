/** Offline SQLite compatibility for source snapshots and historical migration fixtures only. */
/**
 * SQLite database layer — sub2api data-layer inspired, on node:sqlite.
 *
 * - Single-process gateway → embedded SQLite (WAL) instead of sub2api's
 *   PostgreSQL+Redis. Same patterns: versioned SQL migrations with SHA-256
 *   checksum verification (sub2api migrations_runner), repository modules,
 *   settings table, backup records.
 * - Zero new dependencies: uses the built-in `node:sqlite` DatabaseSync.
 *
 * Env:
 *   KIN_DB_PATH — override db file path (default <dataDir>/kin.db)
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

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

// 001 was published briefly before the proxy pool switched to its persisted
// record shape. Its checksum cannot be treated as the current 001: migration
// 018 assumes the newer columns and otherwise fails after accepting the hash.
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
let _db = null
let _dbPath = null

export function resolveDbPath({ dataDir, dbPath } = {}) {
  if (dbPath) return dbPath
  if (process.env.KIN_DB_PATH) return process.env.KIN_DB_PATH
  const dir = dataDir || path.join(process.cwd(), 'data')
  return path.join(dir, 'kin.db')
}

/**
 * Standalone (non-singleton) open: PRAGMAs + migrations applied.
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
  return db
}

/**
 * Open (or return the already-open) singleton database.
 * @returns {DatabaseSync}
 */
export function openDatabase({ dataDir, dbPath, migrationsDir } = {}) {
  if (_db) return _db
  _db = createDatabase({ dataDir, dbPath, migrationsDir })
  _dbPath = resolveDbPath({ dataDir, dbPath })
  return _db
}

/**
 * Resolve the db a store should use: explicit db → global singleton →
 * standalone connection rooted at dataDir (test isolation path).
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

export function closeDatabase() {
  if (_db) {
    try {
      _db.close()
    } catch {}
  }
  _db = null
  _dbPath = null
}

/**
 * Versioned SQL migrations with checksum verification (sub2api-style).
 * Files: migrations/NNN_name.sql, applied in filename order inside a
 * transaction each. `schema_migrations` records version+checksum; a
 * checksum mismatch on an already-applied migration is a hard error.
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

/** Run fn inside a transaction (nested calls just run inline). */
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
 * Online-consistent snapshot of the live database (WAL-safe).
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
