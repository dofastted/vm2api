/** Read-only PostgreSQL and application-cache metrics; never expose connection details. */
function numberOrNull(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : null
}

export async function snapshotDatabaseMetrics({
  db,
  usageCache,
  now = () => Date.now(),
  clock = () => performance.now(),
}) {
  let ok = false
  let latency = null
  try {
    const started = clock()
    await db.prepare('SELECT 1 AS ok').get()
    ok = true
    latency = Math.round(Math.max(clock() - started, 0) * 1000) / 1000
  } catch {}
  let size = null
  let migrations = null
  let latest = null
  try {
    size = numberOrNull((await db.prepare('SELECT pg_database_size(current_database()) AS bytes').get())?.bytes)
  } catch {}
  try {
    migrations = numberOrNull((await db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get())?.count)
  } catch {}
  try {
    latest = await db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1').get()
  } catch {}
  let usage = null
  try {
    usage = typeof usageCache?.stats === 'function' ? usageCache.stats() : null
  } catch {}
  return {
    sampled_at: new Date(now()).toISOString(),
    database: {
      ok,
      engine: 'postgresql',
      probe_latency_ms: latency,
      size_bytes: size,
      pool_total: numberOrNull(db.pool?.totalCount),
      pool_idle: numberOrNull(db.pool?.idleCount),
      pool_waiting: numberOrNull(db.pool?.waitingCount),
      migration_count: migrations,
      latest_migration: latest?.version == null ? null : String(latest.version),
      latest_migration_at: latest?.applied_at == null ? null : String(latest.applied_at),
    },
    usage_cache: usage,
  }
}
