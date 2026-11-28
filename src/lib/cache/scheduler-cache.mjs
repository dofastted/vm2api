/**
 * Scheduler Snapshot Cache with monotonic revision tracking and stale-while-revalidate grace.
 *
 * Modeled on sub2api's `scheduler_cache.go`:
 * - Keeps hot account/pool scheduling state in memory for microsecond reads while
 *   invalidating L1 + Redis L2 immediately on account/runtime/vm/pool mutations.
 * - PG `scheduler_outbox` inserts are disabled by default (0 consumers) to eliminate
 *   5-second heartbeat & quota update write amplification; opt-in via
 *   `VM2API_ENABLE_CACHE_OUTBOX=1` / `VM2API_ENABLE_SCHEDULER_OUTBOX=1`.
 */

const DOMAIN_PREFIX = 'sched:'
const PREFIX = 'sched:snap:'

function parseBoolEnv(raw) {
  if (raw == null || raw === '') return false
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase())
}

function resolveOutboxEnabled(explicit) {
  if (typeof explicit === 'boolean') return explicit
  return (
    parseBoolEnv(process.env.VM2API_ENABLE_SCHEDULER_OUTBOX) || parseBoolEnv(process.env.VM2API_ENABLE_CACHE_OUTBOX)
  )
}

export class SchedulerCache {
  constructor(cacheClient, { ttlMs = 10_000, staleGraceMs = 5_000, pgPool = null, enableOutbox } = {}) {
    this.cache = cacheClient
    this.ttlMs = Math.max(1_000, Number(ttlMs) || 10_000)
    this.staleGraceMs = Math.max(0, Number(staleGraceMs) || 5_000)
    this.pgPool = pgPool
    this.enableOutbox = resolveOutboxEnabled(enableOutbox)
    this.revision = 0
    this.snapshots = new Map()
  }

  setPgPool(pgPool) {
    this.pgPool = pgPool || null
  }

  /**
   * Synchronous snapshot getter with stale-while-revalidate support.
   * Returns cached value if fresh, or reloads synchronously via `loader`.
   */
  getOrBuildSync(key, loader, now = Date.now()) {
    if (!this.cache?.enabled) return loader()
    const entry = this.snapshots.get(key)
    if (entry && entry.revision === this.revision && now < entry.freshUntil) {
      return entry.value
    }
    const value = loader()
    this.snapshots.set(key, {
      value,
      revision: this.revision,
      freshUntil: now + this.ttlMs,
      staleUntil: now + this.ttlMs + this.staleGraceMs,
    })
    return value
  }

  /** Async snapshot loader backed by L1 + L2 singleflight. */
  async getOrLoad(key, loader) {
    if (!this.cache?.enabled) return loader()
    return this.cache.getOrLoad(`${PREFIX}${key}`, loader, {
      ttlMs: this.ttlMs,
      prefixes: [DOMAIN_PREFIX, PREFIX],
    })
  }

  bumpRevision({ eventType = 'scheduler_changed', accountId = null, groupId = null, payload = {} } = {}) {
    this.revision += 1
    this.snapshots.clear()
    this.cache?.invalidate({ prefixes: [PREFIX] }).catch(() => {})
    if (this.enableOutbox && this.pgPool) {
      this.pgPool
        .query(
          'INSERT INTO scheduler_outbox (event_type, account_id, group_id, payload) VALUES ($1, $2, $3, $4::jsonb)',
          [String(eventType), accountId ? String(accountId) : null, groupId ?? null, JSON.stringify(payload || {})],
        )
        .catch(() => {})
    }
  }
}
