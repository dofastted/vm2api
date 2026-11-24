/**
 * PostgreSQL and Redis configuration resolver.
 *
 * Pool sizing, retry backoff, and TLS defaults follow the production patterns
 * proven in sub2api (`db_pool.go`, `config.go`), while keeping SQLite available
 * when no PostgreSQL connection is configured (e.g. isolated unit tests).
 */

const DEFAULT_PG_PORT = 5432
const DEFAULT_REDIS_PORT = 6379
const DEFAULT_MAX_OPEN_CONNS = 25
const MIN_MAX_OPEN_CONNS = 4
const MAX_MAX_OPEN_CONNS = 200
const DEFAULT_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_STATEMENT_TIMEOUT_MS = 60_000

function parseIntClamped(raw, fallback, min, max) {
  if (raw == null || raw === '') return fallback
  const n = Number.parseInt(String(raw), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function parseBool(raw, fallback = false) {
  if (raw == null || raw === '') return fallback
  const v = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  return fallback
}

function resolveSslConfig(sslmode, env = process.env) {
  const mode = String(sslmode || env.DATABASE_SSLMODE || env.PGSSLMODE || 'disable')
    .trim()
    .toLowerCase()
  if (!mode || mode === 'disable' || mode === 'false' || mode === 'off') return false
  if (mode === 'require' || mode === 'prefer' || mode === 'allow' || mode === 'true') {
    return { rejectUnauthorized: false }
  }
  if (mode === 'verify-ca' || mode === 'verify-full') {
    return { rejectUnauthorized: true }
  }
  return false
}

/**
 * Determine active database driver: 'postgres' | 'sqlite'.
 * Explicit `driver` option overrides env; `auto` selects 'postgres' whenever
 * PostgreSQL connection env vars are present and falls back to 'sqlite'.
 */
export function resolveDbDriver({ driver, connectionString, env = process.env } = {}) {
  const raw = String(driver || env.VM2API_DB_DRIVER || env.DB_DRIVER || 'auto')
    .trim()
    .toLowerCase()
  if (raw === 'postgres' || raw === 'postgresql' || raw === 'pg') return 'postgres'
  if (raw === 'sqlite' || raw === 'sqlite3') return 'sqlite'
  if (connectionString) return 'postgres'
  if (env.VM2API_DATABASE_URL || env.DATABASE_URL || env.VM2API_PG_HOST || env.DATABASE_HOST || env.PGHOST) {
    return 'postgres'
  }
  return 'sqlite'
}

/**
 * Resolve PostgreSQL connection & pool settings.
 * Returns null if no PG connection details exist and driver is not forced.
 */
export function resolvePgConfig({ connectionString, pgConfig, env = process.env } = {}) {
  const explicitUrl =
    connectionString || pgConfig?.connectionString || env.VM2API_DATABASE_URL || env.DATABASE_URL || ''

  const totalMax = parseIntClamped(
    pgConfig?.max ?? env.VM2API_DB_MAX_OPEN_CONNS ?? env.DATABASE_MAX_OPEN_CONNS,
    DEFAULT_MAX_OPEN_CONNS,
    MIN_MAX_OPEN_CONNS,
    MAX_MAX_OPEN_CONNS,
  )
  const idleTimeoutMillis = parseIntClamped(
    pgConfig?.idleTimeoutMillis ?? env.VM2API_DB_IDLE_TIMEOUT_MS ?? env.DATABASE_CONN_MAX_IDLE_MS,
    DEFAULT_IDLE_TIMEOUT_MS,
    1_000,
    600_000,
  )
  const connectionTimeoutMillis = parseIntClamped(
    pgConfig?.connectionTimeoutMillis ?? env.VM2API_DB_CONNECT_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS,
    1_000,
    120_000,
  )
  const statementTimeoutMs = parseIntClamped(
    pgConfig?.statementTimeoutMs ?? env.VM2API_DB_STATEMENT_TIMEOUT_MS,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    0,
    600_000,
  )
  const applicationName = String(pgConfig?.application_name || env.VM2API_DB_APP_NAME || 'vm2api').trim()

  // Split pool budget between main async pool and sync-compat worker pool.
  const asyncPoolMax = Math.max(2, Math.floor(totalMax * 0.5))
  const syncPoolMax = Math.max(2, totalMax - asyncPoolMax)

  if (explicitUrl) {
    let parsedSslmode = null
    try {
      const u = new URL(explicitUrl)
      parsedSslmode = u.searchParams.get('sslmode')
    } catch {}
    return {
      connectionString: explicitUrl,
      ssl: pgConfig?.ssl !== undefined ? pgConfig.ssl : resolveSslConfig(parsedSslmode, env),
      max: totalMax,
      asyncPoolMax,
      syncPoolMax,
      idleTimeoutMillis,
      connectionTimeoutMillis,
      statementTimeoutMs,
      application_name: applicationName,
      allowExitOnIdle: true,
    }
  }

  const host = pgConfig?.host || env.VM2API_PG_HOST || env.DATABASE_HOST || env.PGHOST || ''
  if (!host) return null

  const port = parseIntClamped(
    pgConfig?.port ?? env.VM2API_PG_PORT ?? env.DATABASE_PORT ?? env.PGPORT,
    DEFAULT_PG_PORT,
    1,
    65535,
  )
  const user = pgConfig?.user || env.VM2API_PG_USER || env.DATABASE_USER || env.PGUSER || 'vm2api'
  const password = pgConfig?.password ?? env.VM2API_PG_PASSWORD ?? env.DATABASE_PASSWORD ?? env.PGPASSWORD ?? ''
  const database = pgConfig?.database || env.VM2API_PG_DATABASE || env.DATABASE_DBNAME || env.PGDATABASE || 'vm2api'
  const ssl = pgConfig?.ssl !== undefined ? pgConfig.ssl : resolveSslConfig(null, env)

  return {
    host,
    port,
    user,
    password: String(password),
    database,
    ssl,
    max: totalMax,
    asyncPoolMax,
    syncPoolMax,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    statementTimeoutMs,
    application_name: applicationName,
    allowExitOnIdle: true,
  }
}

/** Build a libpq/node-pg DSN from a resolved PG config object. */
export function buildPgConnectionString(cfg) {
  if (!cfg) return ''
  if (cfg.connectionString) return cfg.connectionString
  const user = encodeURIComponent(cfg.user || 'vm2api')
  const pass = cfg.password ? `:${encodeURIComponent(cfg.password)}` : ''
  const host = cfg.host || '127.0.0.1'
  const port = cfg.port || DEFAULT_PG_PORT
  const db = encodeURIComponent(cfg.database || 'vm2api')
  const sslParam = cfg.ssl ? '?sslmode=require' : '?sslmode=disable'
  return `postgresql://${user}${pass}@${host}:${port}/${db}${sslParam}`
}

/** Mask password in a PostgreSQL or Redis URL for safe logging/metrics. */
export function redactConnectionString(raw) {
  if (!raw || typeof raw !== 'string') return ''
  try {
    const u = new URL(raw)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return raw.replace(/:\/\/([^:@/]+):([^@/]+)@/, '://$1:***@')
  }
}

/**
 * Resolve optional Redis L2 cache configuration.
 * Returns null when Redis is disabled or not configured (graceful L1-only mode).
 */
export function resolveRedisConfig({ redisUrl, redisConfig, env = process.env } = {}) {
  if (parseBool(env.VM2API_REDIS_DISABLED, false)) return null
  const url = redisUrl || redisConfig?.url || env.VM2API_REDIS_URL || env.REDIS_URL || ''
  const host = redisConfig?.host || env.VM2API_REDIS_HOST || env.REDIS_HOST || ''
  if (!url && !host) return null

  const keyPrefix = String(redisConfig?.keyPrefix || env.VM2API_REDIS_KEY_PREFIX || 'vm2api:').trim()
  const connectTimeout = parseIntClamped(env.VM2API_REDIS_CONNECT_TIMEOUT_MS, 3_000, 500, 30_000)
  const commandTimeout = parseIntClamped(env.VM2API_REDIS_COMMAND_TIMEOUT_MS, 2_000, 200, 30_000)
  const maxRetriesPerRequest = parseIntClamped(env.VM2API_REDIS_MAX_RETRIES, 1, 0, 5)

  if (url) {
    return {
      url,
      keyPrefix,
      connectTimeout,
      commandTimeout,
      maxRetriesPerRequest,
      enableOfflineQueue: false,
      lazyConnect: true,
    }
  }

  return {
    host,
    port: parseIntClamped(redisConfig?.port ?? env.VM2API_REDIS_PORT ?? env.REDIS_PORT, DEFAULT_REDIS_PORT, 1, 65535),
    password: String(redisConfig?.password ?? env.VM2API_REDIS_PASSWORD ?? env.REDIS_PASSWORD ?? '') || undefined,
    db: parseIntClamped(redisConfig?.db ?? env.VM2API_REDIS_DB ?? env.REDIS_DB, 0, 0, 15),
    tls: parseBool(redisConfig?.tls ?? env.REDIS_ENABLE_TLS, false) ? {} : undefined,
    keyPrefix,
    connectTimeout,
    commandTimeout,
    maxRetriesPerRequest,
    enableOfflineQueue: false,
    lazyConnect: true,
  }
}

export function resolveCacheConfig(env = process.env) {
  return {
    disabled: parseBool(env.VM2API_CACHE_DISABLED, false),
    l1MaxItems: parseIntClamped(env.VM2API_CACHE_L1_MAX_ITEMS, 8_192, 128, 200_000),
    defaultTtlMs: parseIntClamped(env.VM2API_CACHE_TTL_MS, 60_000, 1_000, 3_600_000),
    apiKeyTtlMs: parseIntClamped(env.VM2API_APIKEY_CACHE_TTL_MS, 60_000, 1_000, 600_000),
    billingTtlMs: parseIntClamped(env.VM2API_BILLING_CACHE_TTL_MS, 300_000, 5_000, 3_600_000),
    dashboardTtlMs: parseIntClamped(env.VM2API_DASHBOARD_CACHE_TTL_MS, 15_000, 1_000, 300_000),
    schedulerTtlMs: parseIntClamped(env.VM2API_SCHEDULER_CACHE_TTL_MS, 10_000, 1_000, 120_000),
  }
}
