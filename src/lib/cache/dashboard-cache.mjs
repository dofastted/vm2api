/**
 * Dashboard & Statistics Response Cache (L1 + L2 Redis + SWR + SnapshotCache + Leader Lock).
 *
 * Modeled on sub2api's `dashboard_cache.go`, `snapshot_cache.go`, and `leader_lock_cache.go`:
 * - SWR (`getOrSetSWR`) absorbs repeated dashboard/statistics refreshes without thundering herds.
 * - O(1) namespace invalidation covers `overview`, `stats`, `panel`, `filter-options`,
 *   `active-sessions`, and `metrics`.
 * - Built-in in-process `snapshotCache` (singleflight + SHA-256 ETag) caches high-cardinality
 *   multi-filter queries without polluting Redis memory.
 * - Distributed leader lock (`SET NX PX` + Lua owner-checked release) coordinates single-instance
 *   background aggregation, degrading seamlessly to local single-node acquisition without Redis.
 */
import crypto from 'node:crypto'
import { createSnapshotCache, matchesEtag, stableStringify } from './cache-client.mjs'

const PREFIX = 'dash:'
const LOCK_PREFIX = 'leader:lock:'

const NAMESPACE_ALIASES = {
  overview: ['overview', 'usage-overview'],
  stats: ['stats', 'statistics', 'statistics-leaderboard'],
  panel: ['panel'],
  'filter-options': ['filter-options'],
  'active-sessions': ['active-sessions'],
  metrics: ['metrics'],
}

const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

const RENEW_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 0
`

function stableHash(params) {
  const raw = typeof params === 'string' ? params : stableStringify(params ?? {})
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)
}

function stableKey(namespace, params) {
  return `${PREFIX}${namespace}:${stableHash(params)}`
}

function expandNamespacePrefixes(ns) {
  const clean = String(ns || '').trim()
  if (!clean) return []
  const targets = NAMESPACE_ALIASES[clean] || [clean]
  return targets.map((name) => `${PREFIX}${name}:`)
}

function expandSnapshotPrefixes(ns) {
  const clean = String(ns || '').trim()
  if (!clean) return []
  const targets = NAMESPACE_ALIASES[clean] || [clean]
  return targets.map((name) => `${name}:`)
}

export class DashboardCache {
  constructor(cacheClient, { ttlMs = 15_000, snapshotMaxEntries = 512, snapshotTtlMs = 30_000 } = {}) {
    this.cache = cacheClient
    this.ttlMs = Math.max(1_000, Number(ttlMs) || 15_000)
    this.snapshotCache = createSnapshotCache({
      maxEntries: snapshotMaxEntries,
      defaultTtlMs: snapshotTtlMs,
    })
    /** Single-node fallback leader locks: name -> { token, expiresAt } */
    this._localLocks = new Map()
  }

  /** Backward-compatible read-through with singleflight and ±10% jitter. */
  async getOrLoad(namespace, params, loader, { ttlMs = this.ttlMs, bypass = false } = {}) {
    if (bypass || !this.cache?.enabled) return loader()
    const key = stableKey(namespace, params)
    return this.cache.getOrLoad(key, loader, {
      ttlMs,
      jitter: true,
      prefixes: [PREFIX, `${PREFIX}${namespace}:`],
    })
  }

  /**
   * Stale-While-Revalidate read-through for dashboard/panel endpoints.
   * Serves stale value immediately within hard `ttlMs` and triggers 1 background refresh.
   */
  async getOrSetSWR(
    ns,
    keyOrParams,
    loader,
    { freshTtlMs = null, ttlMs = this.ttlMs, jitter = true, bypass = false, now } = {},
  ) {
    if (!this.cache?.enabled) return loader()
    const key = stableKey(ns, keyOrParams)
    return this.cache.getOrSetSWR(key, loader, {
      freshTtlMs,
      ttlMs,
      prefixes: [PREFIX, `${PREFIX}${ns}:`],
      jitter,
      bypass,
      ...(now !== undefined ? { now } : {}),
    })
  }

  /**
   * High-cardinality multi-filter in-process snapshot cache (never writes Redis).
   * Returns `{ value, etag, hit, cacheStatus, cachedAt }`.
   */
  async getOrLoadSnapshot(ns, params, loader, opts = {}) {
    const key = this.snapshotCache.buildKey(ns, params)
    return this.snapshotCache.getOrLoad(key, loader, opts)
  }

  matchesEtag(ifNoneMatch, etag) {
    return matchesEtag(ifNoneMatch, etag)
  }

  async invalidateNamespace(ns) {
    await this.invalidateNamespaces([ns])
  }

  async invalidateNamespaces(namespaces = []) {
    const list = Array.isArray(namespaces) ? namespaces : [namespaces]
    const cachePrefixes = new Set()
    for (const ns of list) {
      for (const p of expandNamespacePrefixes(ns)) cachePrefixes.add(p)
      for (const sp of expandSnapshotPrefixes(ns)) this.snapshotCache.invalidatePrefix(sp)
    }
    if (this.cache && cachePrefixes.size > 0) {
      await this.cache.invalidate({ prefixes: [...cachePrefixes] })
    }
  }

  async invalidateAll() {
    this.snapshotCache.clear()
    if (!this.cache) return
    await this.cache.invalidate({ prefixes: [PREFIX] })
  }

  _acquireLocalLock(name, ttlMs) {
    const now = Date.now()
    const existing = this._localLocks.get(name)
    if (existing && existing.expiresAt > now) {
      return { acquired: false, token: null }
    }
    const token = `${this.cache?.instanceId || 'local'}:${crypto.randomBytes(8).toString('hex')}`
    this._localLocks.set(name, { token, expiresAt: now + ttlMs })
    return { acquired: true, token }
  }

  /**
   * Acquire a distributed leader lock (`SET NX PX`).
   * Without Redis (or on Redis failure), falls back cleanly to single-node acquisition.
   * @returns {Promise<{ acquired: boolean, token: string | null }>}
   */
  async acquireLeaderLock(name, ttlMs = 300_000) {
    const cleanName = String(name || '').trim()
    if (!cleanName) return { acquired: false, token: null }
    const ttl = Math.max(1_000, Number(ttlMs) || 300_000)

    if (this.cache?.hasRedis) {
      const token = `${this.cache.instanceId}:${crypto.randomBytes(8).toString('hex')}`
      try {
        const rKey = this.cache.redisKey(`${LOCK_PREFIX}${cleanName}`)
        const res = await this.cache.redis.set(rKey, token, 'PX', ttl, 'NX')
        if (res === 'OK') {
          this._localLocks.set(cleanName, { token, expiresAt: Date.now() + ttl })
          return { acquired: true, token }
        }
        return { acquired: false, token: null }
      } catch {
        this.cache.l2Errors += 1
        // Fail-Open: fall back to single-node lock when Redis errors
      }
    }

    return this._acquireLocalLock(cleanName, ttl)
  }

  /**
   * Release a distributed leader lock only if owned by `token` (atomic Lua check).
   * Accepts either the raw token string or the `{ token }` object returned by `acquireLeaderLock`.
   */
  async releaseLeaderLock(name, tokenOrLock) {
    const cleanName = String(name || '').trim()
    const token = typeof tokenOrLock === 'string' ? tokenOrLock : tokenOrLock?.token
    if (!cleanName || !token) return false

    const local = this._localLocks.get(cleanName)
    let localReleased = false
    if (local && local.token === token) {
      this._localLocks.delete(cleanName)
      localReleased = true
    }

    if (this.cache?.hasRedis) {
      const res = await this.cache.evalLua(RELEASE_LOCK_LUA, [`${LOCK_PREFIX}${cleanName}`], [String(token)])
      if (res != null) return Number(res) === 1
    }

    return localReleased
  }

  /** Extend TTL of a held leader lock if still owned by `token`. */
  async renewLeaderLock(name, tokenOrLock, ttlMs = 300_000) {
    const cleanName = String(name || '').trim()
    const token = typeof tokenOrLock === 'string' ? tokenOrLock : tokenOrLock?.token
    if (!cleanName || !token) return false
    const ttl = Math.max(1_000, Number(ttlMs) || 300_000)

    if (this.cache?.hasRedis) {
      const res = await this.cache.evalLua(RENEW_LOCK_LUA, [`${LOCK_PREFIX}${cleanName}`], [String(token), String(ttl)])
      if (res != null) {
        const ok = Number(res) === 1
        if (ok) this._localLocks.set(cleanName, { token, expiresAt: Date.now() + ttl })
        return ok
      }
    }

    const local = this._localLocks.get(cleanName)
    if (local && local.token === token && local.expiresAt > Date.now()) {
      local.expiresAt = Date.now() + ttl
      return true
    }
    return false
  }
}
