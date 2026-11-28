/**
 * Scheduler Snapshot Cache with monotonic revision tracking and stale-while-revalidate grace.
 *
 * Modeled on sub2api's `scheduler_cache.go` + `scheduler_snapshot_service.go`:
 * - Keeps pre-decoded L1 scheduling snapshots (`{ byAccountId, byVmId, byAccountVmId,
 *   accountIdByVmId, rev, loadedAt }`) in memory for O(1) microsecond reads with
 *   0 DB / 0 Redis RTT within `freshTtlMs` (default 2s) and non-blocking SWR
 *   singleflight background refresh within `staleTtlMs` (default 10s).
 * - When Redis L2 is ready, caches compact snapshot payloads under `sched:snapshot:v1`
 *   with monotonic `sched:rev` revision tracking and Pub/Sub cross-instance invalidation.
 * - Seamlessly degrades to in-process L1 + write invalidation when Redis is absent or
 *   running against SQLite.
 * - PG `scheduler_outbox` inserts are disabled by default (0 consumers) to eliminate
 *   5-second heartbeat & quota update write amplification; opt-in via
 *   `VM2API_ENABLE_CACHE_OUTBOX=1` / `VM2API_ENABLE_SCHEDULER_OUTBOX=1`.
 */

const DOMAIN_PREFIX = 'sched:'
const PREFIX = 'sched:snap:'
export const SCHED_REV_KEY = 'sched:rev'
export const SCHED_SNAPSHOT_KEY = 'sched:snapshot:v1'

const DEFAULT_FRESH_TTL_MS = 2_000
const DEFAULT_STALE_TTL_MS = 10_000

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

function toMap(input) {
  if (input instanceof Map) return input
  const map = new Map()
  if (Array.isArray(input)) {
    for (const pair of input) {
      if (Array.isArray(pair) && pair[0] != null) map.set(String(pair[0]), pair[1])
    }
    return map
  }
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      map.set(String(k), v)
    }
  }
  return map
}

function normalizeAccountEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return { account: null, state: null, runtime: null }
  }
  const account = entry.account ?? null
  const state = entry.state ?? entry.runtime ?? null
  return { account, state, runtime: state }
}

/**
 * Normalize raw loader output into the canonical pre-decoded scheduling snapshot shape:
 * `{ byAccountId, byVmId, byAccountVmId, accountIdByVmId, authoritative, rev, loadedAt }`.
 */
export function normalizeSchedulingSnapshot(raw, { rev = 0, now = Date.now() } = {}) {
  const srcAccounts =
    raw instanceof Map ? raw : raw && typeof raw === 'object' ? (raw.byAccountId ?? raw.accounts ?? null) : null
  const srcVms = raw instanceof Map ? null : raw && typeof raw === 'object' ? (raw.byVmId ?? raw.vms ?? null) : null
  const srcAccountIdByVmId =
    raw instanceof Map ? null : raw && typeof raw === 'object' ? (raw.accountIdByVmId ?? null) : null

  const byAccountId = new Map()
  const byAccountVmId = new Map()
  for (const [key, val] of toMap(srcAccounts)) {
    if (!key) continue
    const norm = normalizeAccountEntry(val)
    byAccountId.set(String(key), norm)
    const vmId = norm.state?.vm_id ?? norm.account?.vm_id ?? null
    if (vmId && !byAccountVmId.has(String(vmId))) {
      byAccountVmId.set(String(vmId), norm)
    }
  }

  const byVmId = new Map()
  for (const [key, val] of toMap(srcVms)) {
    if (!key || !val) continue
    byVmId.set(String(key), val)
  }

  const accountIdByVmId = new Map()
  if (srcAccountIdByVmId) {
    for (const [vmId, acctId] of toMap(srcAccountIdByVmId)) {
      if (vmId && acctId) accountIdByVmId.set(String(vmId), String(acctId))
    }
  } else {
    for (const [vmId, vm] of byVmId) {
      const acctId = vm?.claude?.account_uuid || vm?.account_uuid || vmId
      if (acctId) accountIdByVmId.set(vmId, String(acctId))
    }
  }

  const loadedAt =
    raw && typeof raw === 'object' && Number.isFinite(Number(raw.loadedAt)) ? Number(raw.loadedAt) : Number(now)
  const effectiveRev =
    raw && typeof raw === 'object' && Number.isFinite(Number(raw.rev)) ? Number(raw.rev) : Number(rev) || 0

  return {
    byAccountId,
    byVmId,
    byAccountVmId,
    accountIdByVmId,
    authoritative: Boolean(raw && typeof raw === 'object' && raw.authoritative === true),
    rev: effectiveRev,
    remoteRev: raw && typeof raw === 'object' && Number.isFinite(Number(raw.remoteRev)) ? Number(raw.remoteRev) : null,
    loadedAt,
  }
}

function serializeSnapshotForL2(snapshot, remoteRev) {
  const accounts = []
  for (const [id, entry] of snapshot.byAccountId) {
    accounts.push([id, { account: entry.account ?? null, state: entry.state ?? null }])
  }
  const vms = []
  for (const [id, vm] of snapshot.byVmId) {
    vms.push([id, vm])
  }
  const accountIdByVmId = []
  for (const [vmId, acctId] of snapshot.accountIdByVmId) {
    accountIdByVmId.push([vmId, acctId])
  }
  return JSON.stringify({
    v: 1,
    rev: snapshot.rev,
    remoteRev: Number(remoteRev) || 0,
    loadedAt: snapshot.loadedAt,
    authoritative: snapshot.authoritative,
    accounts,
    vms,
    accountIdByVmId,
  })
}

function deserializeSnapshotFromL2(raw, localRev) {
  if (!raw || typeof raw !== 'string') return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return null
  return normalizeSchedulingSnapshot(
    {
      byAccountId: parsed.accounts,
      byVmId: parsed.vms,
      accountIdByVmId: parsed.accountIdByVmId,
      authoritative: parsed.authoritative === true,
      rev: localRev,
      remoteRev: Number(parsed.remoteRev) || 0,
      loadedAt: Number(parsed.loadedAt) || Date.now(),
    },
    { rev: localRev, now: Number(parsed.loadedAt) || Date.now() },
  )
}

/**
 * SSOT In-process + Redis L2 Scheduler Snapshot Cache with SWR grace & singleflight.
 */
export class SchedulerSnapshotCache {
  constructor(
    cacheClient = null,
    {
      freshTtlMs = DEFAULT_FRESH_TTL_MS,
      staleTtlMs = DEFAULT_STALE_TTL_MS,
      getRevision = null,
      onBumpRevision = null,
    } = {},
  ) {
    this.cache = cacheClient || null
    const parsedFresh = Number(freshTtlMs)
    this.freshTtlMs = Number.isFinite(parsedFresh) && parsedFresh >= 0 ? parsedFresh : DEFAULT_FRESH_TTL_MS
    const parsedStale = Number(staleTtlMs)
    this.staleTtlMs = Math.max(
      this.freshTtlMs,
      Number.isFinite(parsedStale) && parsedStale >= 0 ? parsedStale : DEFAULT_STALE_TTL_MS,
    )
    this._getRevision = typeof getRevision === 'function' ? getRevision : null
    this._onBumpRevision = typeof onBumpRevision === 'function' ? onBumpRevision : null
    this._localRev = 0
    this._snapshot = null
    this._inflight = null // { promise, invalidated, rev }
    this._swrRefresh = null // { promise, invalidated, rev }
    this._defaultAsyncLoader = null
    this._stats = {
      l1Hits: 0,
      swrHits: 0,
      l2Hits: 0,
      misses: 0,
      refreshes: 0,
      singleflightCoalesced: 0,
      invalidations: 0,
    }
  }

  get revision() {
    return this._getRevision ? this._getRevision() : this._localRev
  }

  setDefaultAsyncLoader(fn) {
    this._defaultAsyncLoader = typeof fn === 'function' ? fn : null
  }

  _cacheEnabled() {
    return !this.cache || this.cache.enabled !== false
  }

  _hasRedis() {
    return Boolean(this.cache?.hasRedis)
  }

  _markActiveInvalidated() {
    if (this._inflight) {
      this._inflight.invalidated = true
      this._inflight = null
    }
    if (this._swrRefresh) {
      this._swrRefresh.invalidated = true
      this._swrRefresh = null
    }
  }

  /** Called when owner revision bumps externally (e.g. cache/index.mjs invalidation). */
  onRevisionChanged(nextRev = null) {
    if (nextRev != null && Number.isFinite(Number(nextRev))) {
      this._localRev = Number(nextRev)
    } else if (!this._getRevision) {
      this._localRev += 1
    }
    this._snapshot = null
    this._markActiveInvalidated()
    this._stats.invalidations += 1
  }

  clearLocal() {
    this._snapshot = null
    this._markActiveInvalidated()
  }

  async _readL2(localRev) {
    if (!this._hasRedis()) return { snapshot: null, remoteRev: 0 }
    try {
      const results = await this.cache.execPipeline((pipe, keyFn) => {
        pipe.get(keyFn(SCHED_REV_KEY))
        pipe.get(keyFn(SCHED_SNAPSHOT_KEY))
      })
      if (!Array.isArray(results)) return { snapshot: null, remoteRev: 0 }
      const [revErr, revRaw] = results[0] || []
      const [snapErr, snapRaw] = results[1] || []
      const remoteRev = !revErr && revRaw != null ? Math.max(0, Number.parseInt(String(revRaw), 10) || 0) : 0
      if (snapErr || !snapRaw) return { snapshot: null, remoteRev }
      const decoded = deserializeSnapshotFromL2(snapRaw, localRev)
      if (!decoded) {
        this.cache.delRaw(SCHED_SNAPSHOT_KEY).catch(() => {})
        return { snapshot: null, remoteRev }
      }
      if (remoteRev > 0 && (decoded.remoteRev ?? 0) < remoteRev) {
        return { snapshot: null, remoteRev }
      }
      return { snapshot: decoded, remoteRev }
    } catch {
      return { snapshot: null, remoteRev: 0 }
    }
  }

  async _writeL2(snapshot, expectedRemoteRev = null) {
    if (!this._hasRedis() || !snapshot) return false
    try {
      let remoteRev = expectedRemoteRev
      if (remoteRev == null) {
        const revRaw = await this.cache.getRaw(SCHED_REV_KEY)
        remoteRev = revRaw != null ? Math.max(0, Number.parseInt(String(revRaw), 10) || 0) : 0
      }
      const l2TtlMs = Math.max(this.staleTtlMs * 2, 30_000)
      const payload = serializeSnapshotForL2(snapshot, remoteRev)
      return await this.cache.setRaw(SCHED_SNAPSHOT_KEY, payload, l2TtlMs)
    } catch {
      return false
    }
  }

  _bumpRedisRevAndDeleteL2() {
    if (!this._hasRedis()) return
    this.cache
      .execPipeline((pipe, keyFn) => {
        pipe.incr(keyFn(SCHED_REV_KEY))
        pipe.del(keyFn(SCHED_SNAPSHOT_KEY))
      })
      .catch(() => {})
  }

  _startSwrRefresh(asyncLoader, rev, { writeL2 = true } = {}) {
    const loader = typeof asyncLoader === 'function' ? asyncLoader : this._defaultAsyncLoader
    if (!loader) return null
    if (this._swrRefresh && !this._swrRefresh.invalidated) {
      this._stats.singleflightCoalesced += 1
      return this._swrRefresh.promise
    }
    this._stats.refreshes += 1
    const token = { invalidated: false, rev, promise: null }
    const promise = Promise.resolve()
      .then(async () => {
        let remoteRev = null
        if (writeL2 && this._hasRedis()) {
          const revRaw = await this.cache.getRaw(SCHED_REV_KEY)
          remoteRev = revRaw != null ? Math.max(0, Number.parseInt(String(revRaw), 10) || 0) : 0
        }
        const raw = await loader()
        if (token.invalidated || this.revision !== rev || raw == null) return null
        const next = normalizeSchedulingSnapshot(raw, { rev, now: Date.now() })
        next.remoteRev = remoteRev
        this._snapshot = next
        if (writeL2 && this._hasRedis()) {
          await this._writeL2(next, remoteRev)
        }
        return next
      })
      .catch(() => null)
      .finally(() => {
        if (this._swrRefresh === token) this._swrRefresh = null
      })
    token.promise = promise
    this._swrRefresh = token
    return promise
  }

  /**
   * Non-blocking L1 inspection.
   * Returns `{ hit, stale, snapshot }`. When inside the SWR grace window,
   * returns the stale snapshot immediately and triggers singleflight async refresh.
   */
  peekSchedulingSnapshot({ now = Date.now(), asyncRefresher = null } = {}) {
    if (!this._cacheEnabled()) {
      return { hit: false, stale: false, snapshot: null }
    }
    const entry = this._snapshot
    const curRev = this.revision
    if (!entry || entry.rev !== curRev) {
      return { hit: false, stale: false, snapshot: null }
    }
    const age = Math.max(0, now - entry.loadedAt)
    if (age < this.freshTtlMs) {
      this._stats.l1Hits += 1
      return { hit: true, stale: false, snapshot: entry }
    }
    if (age < this.staleTtlMs) {
      this._stats.swrHits += 1
      this._startSwrRefresh(asyncRefresher, curRev)
      return { hit: true, stale: true, snapshot: entry }
    }
    return { hit: false, stale: false, snapshot: null }
  }

  /**
   * Synchronous L1 snapshot getter with SWR grace.
   * - Fresh (< freshTtlMs): O(1) pure memory hit (0 DB, 0 Redis RTT).
   * - Stale (freshTtlMs..staleTtlMs): O(1) stale hit + background singleflight async refresh.
   * - Cold / invalidated / hard-expired: calls `syncLoader()` once and populates L1.
   */
  getSchedulingSnapshotSync(syncLoader, { now = Date.now(), asyncRefresher = null, forceRefresh = false } = {}) {
    if (!this._cacheEnabled()) {
      if (typeof syncLoader !== 'function') return null
      return normalizeSchedulingSnapshot(syncLoader(), { rev: this.revision, now })
    }
    if (!forceRefresh) {
      const peek = this.peekSchedulingSnapshot({ now, asyncRefresher })
      if (peek.hit) return peek.snapshot
    }
    this._stats.misses += 1
    if (typeof syncLoader !== 'function') return null
    const curRev = this.revision
    const raw = syncLoader()
    if (raw == null) return null
    const snap = normalizeSchedulingSnapshot(raw, { rev: curRev, now })
    this._snapshot = snap
    if (this._hasRedis()) {
      this._writeL2(snap).catch(() => {})
    }
    return snap
  }

  /**
   * Async snapshot getter with L1 fresh hit, SWR background refresh, L2 Redis
   * (`sched:snapshot:v1` + `sched:rev`), and singleflight coalescing.
   */
  async getSchedulingSnapshotAsync(asyncLoader, { now = Date.now(), forceRefresh = false } = {}) {
    const loader = typeof asyncLoader === 'function' ? asyncLoader : this._defaultAsyncLoader
    if (!this._cacheEnabled()) {
      if (!loader) return null
      return normalizeSchedulingSnapshot(await loader(), { rev: this.revision, now })
    }
    if (!forceRefresh) {
      const peek = this.peekSchedulingSnapshot({ now, asyncRefresher: loader })
      if (peek.hit) return peek.snapshot
    }
    if (!forceRefresh && this._inflight && !this._inflight.invalidated) {
      this._stats.singleflightCoalesced += 1
      return this._inflight.promise
    }

    this._stats.misses += 1
    const startRev = this.revision
    const token = { invalidated: false, rev: startRev, promise: null }
    const promise = (async () => {
      let remoteRev = null
      if (!forceRefresh && this._hasRedis()) {
        const l2 = await this._readL2(startRev)
        remoteRev = l2.remoteRev
        if (l2.snapshot) {
          const l2Age = Math.max(0, Date.now() - l2.snapshot.loadedAt)
          if (l2Age < this.staleTtlMs) {
            this._stats.l2Hits += 1
            if (!token.invalidated && this.revision === startRev) {
              this._snapshot = l2.snapshot
              if (l2Age >= this.freshTtlMs && loader) {
                this._startSwrRefresh(loader, startRev)
              }
            }
            return l2.snapshot
          }
        }
      }
      if (!loader) return null
      if (remoteRev == null && this._hasRedis()) {
        const revRaw = await this.cache.getRaw(SCHED_REV_KEY)
        remoteRev = revRaw != null ? Math.max(0, Number.parseInt(String(revRaw), 10) || 0) : 0
      }
      const raw = await loader()
      if (raw == null) return null
      const loadedAt = Date.now()
      const snap = normalizeSchedulingSnapshot(raw, { rev: startRev, now: loadedAt })
      snap.remoteRev = remoteRev
      if (!token.invalidated && this.revision === startRev) {
        this._snapshot = snap
        if (this._hasRedis()) {
          await this._writeL2(snap, remoteRev)
        }
      }
      return snap
    })().finally(() => {
      if (this._inflight === token) this._inflight = null
    })

    token.promise = promise
    if (!forceRefresh) this._inflight = token
    return promise
  }

  /** Pre-populate L1 (and optionally Redis L2) with an already-built snapshot. */
  primeSchedulingSnapshot(snapshot, { now = Date.now(), writeL2 = false } = {}) {
    if (snapshot == null) return null
    const curRev = this.revision
    const snap = normalizeSchedulingSnapshot(snapshot, { rev: curRev, now })
    this._snapshot = snap
    if (writeL2 && this._hasRedis()) {
      this._writeL2(snap).catch(() => {})
    }
    return snap
  }

  /** Invalidate local L1 snapshot (and optionally broadcast cross-instance invalidation). */
  invalidateSchedulingSnapshot({ broadcast = false, eventType = 'scheduler_snapshot_invalidated' } = {}) {
    if (this._onBumpRevision) {
      this._onBumpRevision({ broadcast, eventType })
      return
    }
    this._localRev += 1
    this._snapshot = null
    this._markActiveInvalidated()
    this._stats.invalidations += 1
    if (broadcast) {
      this._bumpRedisRevAndDeleteL2()
      this.cache?.invalidate({ prefixes: [DOMAIN_PREFIX, PREFIX] }).catch(() => {})
    }
  }

  stats() {
    return {
      ...this._stats,
      rev: this.revision,
      fresh_ttl_ms: this.freshTtlMs,
      stale_ttl_ms: this.staleTtlMs,
      warm: this._snapshot != null && this._snapshot.rev === this.revision,
      loaded_at: this._snapshot?.loadedAt ?? null,
      accounts_cached: this._snapshot?.byAccountId?.size ?? 0,
      vms_cached: this._snapshot?.byVmId?.size ?? 0,
    }
  }
}

export class SchedulerCache {
  constructor(
    cacheClient,
    {
      ttlMs = 10_000,
      staleGraceMs = 5_000,
      freshTtlMs = DEFAULT_FRESH_TTL_MS,
      staleTtlMs = DEFAULT_STALE_TTL_MS,
      pgPool = null,
      enableOutbox,
    } = {},
  ) {
    this.cache = cacheClient
    this.ttlMs = Math.max(1_000, Number(ttlMs) || 10_000)
    this.staleGraceMs = Math.max(0, Number(staleGraceMs) || 5_000)
    this.pgPool = pgPool
    this.enableOutbox = resolveOutboxEnabled(enableOutbox)
    this._revision = 0
    this.snapshots = new Map()
    this._selfInvalidations = 0
    this.snapshotCache = new SchedulerSnapshotCache(cacheClient, {
      freshTtlMs,
      staleTtlMs,
      getRevision: () => this._revision,
      onBumpRevision: ({ broadcast = false, eventType = 'scheduler_snapshot_invalidated' } = {}) => {
        if (broadcast) {
          this.bumpRevision({ eventType })
        } else {
          this._revision += 1
          this.snapshotCache.onRevisionChanged(this._revision)
        }
      },
    })

    // Sync local snapshot invalidation on remote Pub/Sub or direct `client.invalidate({ prefixes: ['sched:'] })`.
    this._unsubInvalidate = this.cache?.onInvalidate?.((payload) => {
      const prefixes = Array.isArray(payload?.prefixes) ? payload.prefixes : []
      if (!prefixes.some((p) => p.startsWith(DOMAIN_PREFIX) || DOMAIN_PREFIX.startsWith(p))) return
      if (payload?.origin === this.cache?.instanceId && this._selfInvalidations > 0) {
        this._selfInvalidations -= 1
        return
      }
      this._revision += 1
      this.snapshots.clear()
      this.snapshotCache.onRevisionChanged(this._revision)
    })
  }

  get revision() {
    return this._revision
  }

  set revision(val) {
    const next = Number(val) || 0
    if (next !== this._revision) {
      this._revision = next
      this.snapshotCache.onRevisionChanged(next)
    }
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
    if (entry && entry.revision === this._revision && now < entry.freshUntil) {
      return entry.value
    }
    const value = loader()
    this.snapshots.set(key, {
      value,
      revision: this._revision,
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

  /** Non-blocking peek of the unified L1 scheduling snapshot (with SWR refresh trigger). */
  peekSchedulingSnapshot(opts) {
    return this.snapshotCache.peekSchedulingSnapshot(opts)
  }

  /** Shared L1+SWR sync accessor for scheduler-runtime & pool-scheduler. */
  getSchedulingSnapshotSync(syncLoader, opts) {
    return this.snapshotCache.getSchedulingSnapshotSync(syncLoader, opts)
  }

  /** Shared L1+L2+SWR+singleflight async accessor for scheduler-runtime & pool-scheduler. */
  getSchedulingSnapshotAsync(asyncLoader, opts) {
    return this.snapshotCache.getSchedulingSnapshotAsync(asyncLoader, opts)
  }

  /** Pre-populate the unified L1 (and optional L2) scheduling snapshot. */
  primeSchedulingSnapshot(snapshot, opts) {
    return this.snapshotCache.primeSchedulingSnapshot(snapshot, opts)
  }

  /** Invalidate the unified scheduling snapshot (local, or cross-instance when `broadcast: true`). */
  invalidateSchedulingSnapshot(opts) {
    this.snapshotCache.invalidateSchedulingSnapshot(opts)
  }

  /** Synchronously clear all local snapshots and invalidate Redis L2 scheduling keys. */
  invalidateAll({ broadcast = true } = {}) {
    this._revision += 1
    this.snapshots.clear()
    this.snapshotCache.onRevisionChanged(this._revision)
    this.snapshotCache._bumpRedisRevAndDeleteL2()
    if (this.cache?.invalidate) {
      this._selfInvalidations += 1
      this.cache.invalidate({ prefixes: [DOMAIN_PREFIX, PREFIX], broadcast }).catch(() => {
        if (this._selfInvalidations > 0) this._selfInvalidations -= 1
      })
    }
  }

  bumpRevision({ eventType = 'scheduler_changed', accountId = null, groupId = null, payload = {} } = {}) {
    this._revision += 1
    this.snapshots.clear()
    this.snapshotCache.onRevisionChanged(this._revision)
    this.snapshotCache._bumpRedisRevAndDeleteL2()
    if (this.cache?.invalidate) {
      this._selfInvalidations += 1
      this.cache.invalidate({ prefixes: [PREFIX, DOMAIN_PREFIX] }).catch(() => {
        if (this._selfInvalidations > 0) this._selfInvalidations -= 1
      })
    }
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
