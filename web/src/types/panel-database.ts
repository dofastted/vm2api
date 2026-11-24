export type PgPoolStats = {
  total: number
  idle: number
  waiting: number
  active: number
  max: number | null
}

export type DatabaseRuntimeMetrics = {
  ok: boolean
  engine: 'sqlite' | 'postgres'
  probe_latency_ms: number | null
  journal_mode: string | null
  synchronous: number | null
  foreign_keys: boolean | null
  busy_timeout_ms: number | null
  file_size_bytes: number | null
  wal_size_bytes: number | null
  shm_size_bytes: number | null
  page_size_bytes: number | null
  page_count: number | null
  freelist_pages: number | null
  used_pages: number | null
  used_bytes: number | null
  free_ratio: number | null
  migration_count: number | null
  latest_migration: string | null
  latest_migration_at: string | null
  pg_version?: string | null
  pg_database?: string | null
  pg_cache_hit_ratio?: number | null
  pg_connections_total?: number | null
  pg_connections_active?: number | null
  pg_connections_idle?: number | null
  pg_max_connections?: number | null
  pg_deadlocks?: number | null
  pg_pool?: {
    async: PgPoolStats | null
    sync: PgPoolStats | null
  } | null
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

export type MultiTierCacheMetrics = {
  enabled: boolean
  mode: 'l1' | 'l1+redis' | 'l1+pg_notify' | string
  l1: {
    size: number
    max_items: number
    hits: number
    misses: number
    hit_rate: number | null
    sets: number
    evictions: number
  }
  l2_redis: {
    configured: boolean
    connected: boolean
    hits: number
    misses: number
    hit_rate: number | null
    errors: number
  }
  singleflight_coalesced: number
  invalidations: number
  redis_ping_ms?: number | null
  redis_ping_ok?: boolean
}

export type DatabaseMetricsPayload = {
  sampled_at: string | null
  database: DatabaseRuntimeMetrics
  usage_cache: UsageCacheMetrics | null
  cache?: MultiTierCacheMetrics | null
}
