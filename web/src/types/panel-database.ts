export type DatabaseRuntimeMetrics = {
  ok: boolean
  engine: 'postgresql'
  probe_latency_ms: number | null
  size_bytes: number | null
  pool_total: number | null
  pool_idle: number | null
  pool_waiting: number | null
  migration_count: number | null
  latest_migration: string | null
  latest_migration_at: string | null
}

export type UsageCacheMetrics = {
  since: string
  entries_total: number
  entries_fresh: number
  entries_stale: number
  inflight: number
  requests: number
  success_hits: number
  error_hits: number
  misses: number
  singleflight_joins: number
  upstream_fetches: number
  upstream_failures: number
  hit_rate: number | null
  reuse_rate: number | null
  success_ttl_ms: number
  error_ttl_ms: number
}

export type DatabaseMetricsPayload = {
  sampled_at: string | null
  database: DatabaseRuntimeMetrics
  usage_cache: UsageCacheMetrics | null
}
