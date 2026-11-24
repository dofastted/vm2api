/**
 * Scheduler Snapshot Cache with monotonic revision tracking and stale-while-revalidate grace.
 *
 * Modeled on sub2api's `scheduler_cache.go` + `scheduler_outbox`:
 * keeps hot account/pool scheduling state in memory for microsecond reads while
 * invalidating immediately on account/runtime/vm/pool mutations.
 */

const PREFIX = 'sched:snap:'

export class SchedulerCache {
  constructor(cacheClient, { ttlMs = 10_000, staleGraceMs = 5_000, pgPool = null } = {}) {
    this.cache = cacheClient
    this.ttlMs = Math.max(1_000, Number(ttlMs) || 10_000)
    this.staleGraceMs = Math.max(0, Number(staleGraceMs) || 5_000)
    this.pgPool = pgPool
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
    return this.cache.getOrLoad(`${PREFIX}${key}`, loader, { ttlMs: this.ttlMs })
  }

  bumpRevision({ eventType = 'scheduler_changed', accountId = null, groupId = null, payload = {} } = {}) {
    this.revision += 1
    this.snapshots.clear()
    this.cache?.invalidate({ prefixes: [PREFIX] }).catch(() => {})
    if (this.pgPool) {
      this.pgPool
        .query(
          'INSERT INTO scheduler_outbox (event_type, account_id, group_id, payload) VALUES ($1, $2, $3, $4::jsonb)',
          [String(eventType), accountId ? String(accountId) : null, groupId ?? null, JSON.stringify(payload || {})],
        )
        .catch(() => {})
    }
  }
}
