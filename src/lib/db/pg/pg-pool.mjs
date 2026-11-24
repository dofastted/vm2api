/**
 * Native async PostgreSQL pool manager.
 *
 * Uses custom isolated type parsers so INT8 (COUNT/SUM/BIGINT) and NUMERIC
 * return JavaScript numbers consistent with vm2api's existing repos, while
 * preserving exact ISO-8601 UTC strings for TIMESTAMPTZ columns.
 */
import pg from 'pg'
import { redactConnectionString } from './config.mjs'

const { Pool, types } = pg

const INT8_OID = 20
const NUMERIC_OID = 1700
const DATE_OID = 1082
const TIMESTAMP_OID = 1114
const TIMESTAMPTZ_OID = 1184

function buildCustomTypes() {
  const custom = {
    getTypeParser(oid, format) {
      if (format !== 'binary') {
        if (oid === INT8_OID) {
          return (val) => {
            if (val == null) return null
            const num = Number(val)
            return Number.isSafeInteger(num) ? num : Number(val)
          }
        }
        if (oid === NUMERIC_OID) {
          return (val) => (val == null ? null : Number(val))
        }
        if (oid === DATE_OID) {
          return (val) => (val == null ? null : String(val))
        }
        if (oid === TIMESTAMPTZ_OID || oid === TIMESTAMP_OID) {
          return (val) => {
            if (val == null) return null
            const parsed = Date.parse(val)
            return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(val)
          }
        }
      }
      return types.getTypeParser(oid, format)
    },
  }
  return custom
}

export function createPgPool(pgConfig, { maxOverride } = {}) {
  if (!pgConfig) {
    throw new Error('PostgreSQL configuration is missing')
  }
  const poolOpts = {
    ...(pgConfig.connectionString
      ? { connectionString: pgConfig.connectionString }
      : {
          host: pgConfig.host,
          port: pgConfig.port,
          user: pgConfig.user,
          password: pgConfig.password,
          database: pgConfig.database,
        }),
    ssl: pgConfig.ssl ?? false,
    max: maxOverride ?? pgConfig.asyncPoolMax ?? pgConfig.max ?? 12,
    idleTimeoutMillis: pgConfig.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: pgConfig.connectionTimeoutMillis ?? 10_000,
    application_name: pgConfig.application_name || 'vm2api',
    allowExitOnIdle: pgConfig.allowExitOnIdle !== false,
    types: buildCustomTypes(),
  }

  if (pgConfig.statementTimeoutMs > 0) {
    poolOpts.statement_timeout = pgConfig.statementTimeoutMs
  }

  const pool = new Pool(poolOpts)
  pool.on('error', (err) => {
    const target = pgConfig.connectionString
      ? redactConnectionString(pgConfig.connectionString)
      : `${pgConfig.host}:${pgConfig.port}/${pgConfig.database}`
    console.warn(`[pg-pool] idle client error (${target}):`, err?.message || err)
  })
  return pool
}

/** Health probe returning { ok, latencyMs, error }. */
export async function probePgPool(pool, clock = () => performance.now()) {
  if (!pool) return { ok: false, latencyMs: null, error: 'pool_not_initialized' }
  const startedAt = clock()
  try {
    await pool.query('SELECT 1 AS ok')
    const elapsed = clock() - startedAt
    return {
      ok: true,
      latencyMs: Number.isFinite(elapsed) ? Math.round(Math.max(elapsed, 0) * 1000) / 1000 : null,
      error: null,
    }
  } catch (err) {
    return { ok: false, latencyMs: null, error: String(err?.message || err) }
  }
}

export function getPgPoolStats(pool) {
  if (!pool) return null
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    active: Math.max(0, pool.totalCount - pool.idleCount),
    max: pool.options?.max ?? null,
  }
}

/** Execute an async callback inside a PostgreSQL transaction on a dedicated client. */
export async function withPgTransaction(pool, fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    throw err
  } finally {
    client.release()
  }
}
