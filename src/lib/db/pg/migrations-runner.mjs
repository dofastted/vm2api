/**
 * PostgreSQL versioned migration runner with advisory locking, transient
 * startup retry backoff, SHA-256 checksum verification, and `*_notx.sql` support.
 *
 * Modeled on sub2api's `migrations_runner.go` and `ent.go`.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { splitSqlStatements } from './sql-compat.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PG_MIGRATIONS_DIR = path.join(__dirname, 'pg-migrations')

const MIGRATION_LOCK_KEY = 'vm2api_schema_migrations_v1'
const TRANSIENT_PG_CODES = new Set(['57P03', '57P01', '57P02', '08001', '08003', '08006', '53300'])
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'])

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

function migrationChecksums(sql) {
  const lf = sql.replace(/\r\n/g, '\n')
  const crlf = lf.replace(/\n/g, '\r\n')
  return {
    canonical: sha256Hex(lf),
    variants: new Set([sha256Hex(sql), sha256Hex(lf), sha256Hex(crlf)]),
  }
}

function isTransientConnectError(err) {
  if (!err) return false
  if (TRANSIENT_PG_CODES.has(err.code)) return true
  if (TRANSIENT_NODE_CODES.has(err.code)) return true
  const msg = String(err.message || '')
  return /starting up|recovery mode|connection terminated|ECONNREFUSED|timeout expired/i.test(msg)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function connectWithRetry(pool, { maxAttempts = 10, baseDelayMs = 300 } = {}) {
  let lastErr = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const client = await pool.connect()
      await client.query('SELECT 1')
      return client
    } catch (err) {
      lastErr = err
      if (!isTransientConnectError(err) || attempt === maxAttempts) {
        throw err
      }
      const delay = Math.min(5_000, baseDelayMs * 2 ** (attempt - 1))
      await sleep(delay)
    }
  }
  throw lastErr
}

async function acquireAdvisoryLock(client, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [MIGRATION_LOCK_KEY])
    if (res.rows?.[0]?.locked) return true
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for PostgreSQL schema migration advisory lock')
    }
    await sleep(250)
  }
}

async function releaseAdvisoryLock(client) {
  try {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_KEY])
  } catch {}
}

/**
 * Apply all pending PostgreSQL migrations in filename order.
 * Files ending with `_notx.sql` execute statement-by-statement outside a transaction
 * (required for `CREATE INDEX CONCURRENTLY`).
 */
export async function applyPgMigrations(pool, { migrationsDir = PG_MIGRATIONS_DIR, maxAttempts = 10 } = {}) {
  const client = await connectWithRetry(pool, { maxAttempts })
  try {
    await acquireAdvisoryLock(client)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT,
        checksum TEXT,
        applied_at TEXT
      )
    `)

    const files = fs.existsSync(migrationsDir)
      ? fs
          .readdirSync(migrationsDir)
          .filter((f) => /^\d+.*\.sql$/.test(f))
          .sort()
      : []

    const existingRes = await client.query('SELECT version, checksum FROM schema_migrations')
    const applied = new Map(existingRes.rows.map((r) => [String(r.version), String(r.checksum || '')]))

    const results = []
    for (const file of files) {
      const version = file.split('_')[0]
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      const { canonical: checksum, variants } = migrationChecksums(sql)

      if (applied.has(version)) {
        const stored = applied.get(version)
        if (stored && !variants.has(stored)) {
          throw new Error(`pg migration checksum mismatch for ${file}: applied=${stored} current=${checksum}`)
        }
        if (stored !== checksum) {
          await client.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [checksum, version])
        }
        continue
      }

      const noTx = file.endsWith('_notx.sql')
      const appliedAt = new Date().toISOString()

      if (noTx) {
        const stmts = splitSqlStatements(sql)
        for (const stmt of stmts) {
          await client.query(stmt)
        }
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)',
          [version, file, checksum, appliedAt],
        )
      } else {
        await client.query('BEGIN')
        try {
          await client.query(sql)
          await client.query(
            'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)',
            [version, file, checksum, appliedAt],
          )
          await client.query('COMMIT')
        } catch (err) {
          try {
            await client.query('ROLLBACK')
          } catch {}
          throw new Error(`pg migration ${file} failed: ${err?.message || err}`)
        }
      }

      results.push(file)
    }

    return results
  } finally {
    await releaseAdvisoryLock(client)
    client.release()
  }
}
