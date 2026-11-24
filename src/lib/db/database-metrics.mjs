/**
 * Database & cache observability snapshots for `/api/panel/database/metrics`.
 *
 * Supports both SQLite (`snapshotDatabaseMetrics` sync + async wrapper) and
 * PostgreSQL (`snapshotDatabaseMetricsAsync` querying `pg_database_size`,
 * `pg_stat_database`, `pg_stat_activity`, connection pool stats, and multi-tier
 * L1/Redis cache metrics).
 */
import fs from 'node:fs'
import { getPgPoolStats, probePgPool } from './pg/pg-pool.mjs'
import { snapshotCacheMetrics } from '../cache/index.mjs'

function numberOrNull(value) {
  if (value == null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function scalar(db, sql) {
  try {
    const row = db.prepare(sql).get()
    if (!row || typeof row !== 'object') return null
    return Object.values(row)[0] ?? null
  } catch {
    return null
  }
}

function probe(db, clock) {
  try {
    const startedAt = clock()
    db.prepare('SELECT 1 AS ok').get()
    const elapsed = numberOrNull(clock() - startedAt)
    return {
      ok: true,
      latencyMs: elapsed == null ? null : Math.round(Math.max(elapsed, 0) * 1000) / 1000,
    }
  } catch {
    return { ok: false, latencyMs: null }
  }
}

function fileSize(dbPath, suffix = '') {
  if (typeof dbPath !== 'string' || !dbPath) return null
  try {
    return fs.statSync(`${dbPath}${suffix}`).size
  } catch (error) {
    return error?.code === 'ENOENT' ? 0 : null
  }
}

function migrationMetrics(db) {
  const count = numberOrNull(scalar(db, 'SELECT COUNT(*) AS count FROM schema_migrations'))
  let latest = null
  try {
    latest = db
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1')
      .get()
  } catch {}
  return {
    migration_count: count,
    latest_migration: latest?.version == null ? null : String(latest.version),
    latest_migration_at: latest?.applied_at == null ? null : String(latest.applied_at),
  }
}

function pageMetrics(pageSize, pageCount, freelistPages) {
  if (pageCount == null || freelistPages == null) {
    return { used_pages: null, used_bytes: null, free_ratio: null }
  }
  const usedPages = Math.max(pageCount - freelistPages, 0)
  return {
    used_pages: usedPages,
    used_bytes: pageSize == null ? null : usedPages * pageSize,
    free_ratio: pageCount > 0 ? freelistPages / pageCount : null,
  }
}

function safeUsageStats(usageCache) {
  try {
    return typeof usageCache?.stats === 'function' ? usageCache.stats() : null
  } catch {
    return null
  }
}

function sampledAt(now) {
  try {
    return new Date(now()).toISOString()
  } catch {
    return null
  }
}

export function snapshotDatabaseMetrics({
  db,
  dbPath,
  usageCache,
  cacheRuntime = null,
  now = () => Date.now(),
  clock = () => performance.now(),
}) {
  if (db?.engine === 'postgres') {
    const health = probe(db, clock)
    const sizeBytes = numberOrNull(scalar(db, 'SELECT pg_database_size(current_database()) AS size_bytes'))
    const version = scalar(db, "SELECT current_setting('server_version') AS v")
    return {
      sampled_at: sampledAt(now),
      database: {
        ok: health.ok,
        engine: 'postgres',
        probe_latency_ms: health.latencyMs,
        journal_mode: 'wal',
        synchronous: 2,
        foreign_keys: true,
        busy_timeout_ms: null,
        file_size_bytes: sizeBytes,
        wal_size_bytes: null,
        shm_size_bytes: null,
        page_size_bytes: 8192,
        page_count: sizeBytes == null ? null : Math.ceil(sizeBytes / 8192),
        freelist_pages: null,
        used_pages: null,
        used_bytes: sizeBytes,
        free_ratio: null,
        pg_version: version == null ? null : String(version),
        ...migrationMetrics(db),
      },
      usage_cache: safeUsageStats(usageCache),
      cache: cacheRuntime?.stats?.() ?? snapshotCacheMetrics(),
    }
  }

  const health = probe(db, clock)
  const journalMode = scalar(db, 'PRAGMA journal_mode')
  const foreignKeys = numberOrNull(scalar(db, 'PRAGMA foreign_keys'))
  const pageSize = numberOrNull(scalar(db, 'PRAGMA page_size'))
  const pageCount = numberOrNull(scalar(db, 'PRAGMA page_count'))
  const freelistPages = numberOrNull(scalar(db, 'PRAGMA freelist_count'))

  return {
    sampled_at: sampledAt(now),
    database: {
      ok: health.ok,
      engine: 'sqlite',
      probe_latency_ms: health.latencyMs,
      journal_mode: journalMode == null ? null : String(journalMode).toLowerCase(),
      synchronous: numberOrNull(scalar(db, 'PRAGMA synchronous')),
      foreign_keys: foreignKeys == null ? null : foreignKeys !== 0,
      busy_timeout_ms: numberOrNull(scalar(db, 'PRAGMA busy_timeout')),
      file_size_bytes: fileSize(dbPath),
      wal_size_bytes: fileSize(dbPath, '-wal'),
      shm_size_bytes: fileSize(dbPath, '-shm'),
      page_size_bytes: pageSize,
      page_count: pageCount,
      freelist_pages: freelistPages,
      ...pageMetrics(pageSize, pageCount, freelistPages),
      ...migrationMetrics(db),
    },
    usage_cache: safeUsageStats(usageCache),
  }
}

/**
 * Full async database + cache metrics snapshot (preferred in server routes).
 * Queries PostgreSQL system views non-blockingly when running on PostgreSQL.
 */
export async function snapshotDatabaseMetricsAsync({
  db,
  dbPath,
  pgPool = null,
  usageCache = null,
  cacheRuntime = null,
  now = () => Date.now(),
  clock = () => performance.now(),
} = {}) {
  if (db?.engine !== 'postgres' && !pgPool) {
    const base = snapshotDatabaseMetrics({ db, dbPath, usageCache, cacheRuntime, now, clock })
    const cacheStats = cacheRuntime?.stats?.() ?? snapshotCacheMetrics()
    if (cacheStats) base.cache = cacheStats
    return base
  }

  if (!pgPool) {
    return snapshotDatabaseMetrics({ db, dbPath, usageCache, cacheRuntime, now, clock })
  }

  const health = await probePgPool(pgPool, clock)
  let serverVersion = null
  let dbName = null
  let dbSizeBytes = null
  let cacheHitRatio = null
  let activeConnections = null
  let idleConnections = null
  let totalConnections = null
  let maxConnections = null
  let deadlocks = null
  let migrationCount = null
  let latestMigration = null
  let latestMigrationAt = null

  if (health.ok) {
    const [metaRes, statRes, actRes, migCountRes, migLatestRes] = await Promise.all([
      pgPool
        .query(
          `SELECT
             current_setting('server_version') AS server_version,
             current_database() AS db_name,
             pg_database_size(current_database())::bigint AS db_size_bytes,
             current_setting('max_connections')::int AS max_connections`,
        )
        .catch(() => null),
      pgPool
        .query(
          `SELECT blks_hit, blks_read, deadlocks
           FROM pg_stat_database
           WHERE datname = current_database()`,
        )
        .catch(() => null),
      pgPool
        .query(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE state = 'active')::int AS active,
             COUNT(*) FILTER (WHERE state = 'idle')::int AS idle
           FROM pg_stat_activity
           WHERE datname = current_database()`,
        )
        .catch(() => null),
      pgPool.query('SELECT COUNT(*)::int AS count FROM schema_migrations').catch(() => null),
      pgPool
        .query('SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1')
        .catch(() => null),
    ])

    const meta = metaRes?.rows?.[0]
    if (meta) {
      serverVersion = meta.server_version == null ? null : String(meta.server_version)
      dbName = meta.db_name == null ? null : String(meta.db_name)
      dbSizeBytes = numberOrNull(meta.db_size_bytes)
      maxConnections = numberOrNull(meta.max_connections)
    }

    const st = statRes?.rows?.[0]
    if (st) {
      const hit = numberOrNull(st.blks_hit) ?? 0
      const read = numberOrNull(st.blks_read) ?? 0
      cacheHitRatio = hit + read > 0 ? Math.round((hit / (hit + read)) * 10_000) / 10_000 : null
      deadlocks = numberOrNull(st.deadlocks)
    }

    const act = actRes?.rows?.[0]
    if (act) {
      totalConnections = numberOrNull(act.total)
      activeConnections = numberOrNull(act.active)
      idleConnections = numberOrNull(act.idle)
    }

    migrationCount = numberOrNull(migCountRes?.rows?.[0]?.count)
    const latest = migLatestRes?.rows?.[0]
    if (latest) {
      latestMigration = latest.version == null ? null : String(latest.version)
      latestMigrationAt = latest.applied_at == null ? null : String(latest.applied_at)
    }
  }

  const asyncPoolStats = getPgPoolStats(pgPool)
  const syncPoolStats = typeof db?.poolStats === 'function' ? db.poolStats() : null
  const cacheStats = cacheRuntime?.stats?.() ?? snapshotCacheMetrics()
  let redisPing = null
  if (cacheRuntime?.client?.hasRedis) {
    redisPing = await cacheRuntime.client.pingRedis(clock)
  }

  return {
    sampled_at: sampledAt(now),
    database: {
      ok: health.ok,
      engine: 'postgres',
      probe_latency_ms: health.latencyMs,
      journal_mode: 'wal',
      synchronous: 2,
      foreign_keys: true,
      busy_timeout_ms: null,
      file_size_bytes: dbSizeBytes,
      wal_size_bytes: null,
      shm_size_bytes: null,
      page_size_bytes: 8192,
      page_count: dbSizeBytes == null ? null : Math.ceil(dbSizeBytes / 8192),
      freelist_pages: null,
      used_pages: null,
      used_bytes: dbSizeBytes,
      free_ratio: null,
      migration_count: migrationCount,
      latest_migration: latestMigration,
      latest_migration_at: latestMigrationAt,
      pg_version: serverVersion,
      pg_database: dbName,
      pg_cache_hit_ratio: cacheHitRatio,
      pg_connections_total: totalConnections,
      pg_connections_active: activeConnections,
      pg_connections_idle: idleConnections,
      pg_max_connections: maxConnections,
      pg_deadlocks: deadlocks,
      pg_pool: {
        async: asyncPoolStats,
        sync: syncPoolStats,
      },
    },
    usage_cache: safeUsageStats(usageCache),
    cache: cacheStats
      ? {
          ...cacheStats,
          ...(redisPing ? { redis_ping_ms: redisPing.latencyMs, redis_ping_ok: redisPing.ok } : {}),
        }
      : null,
  }
}
