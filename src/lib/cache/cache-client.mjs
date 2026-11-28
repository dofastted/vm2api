/**
 * Multi-tier Cache Client (L1 in-process LRU+TTL + singleflight + optional L2 Redis + Pub/Sub & PG NOTIFY).
 *
 * Designed on sub2api's Redis + L1 caching patterns:
 * - L1 bounded LRU cache provides <0.01ms lookups with zero network hops.
 * - Singleflight coalesces concurrent cache misses for the same key.
 * - L2 Redis (`ioredis`) is strictly optional and fail-open: if unconfigured or
 *   temporarily unavailable, traffic continues cleanly on L1 + PostgreSQL.
 * - O(1) namespace epoch versioning ensures `invalidate({ prefixes })` immediately
 *   invalidates both L1 and Redis L2 across instances without KEYS or blocking SCAN.
 * - L2 hits backfill L1 using remaining Redis PTTL (clamped to maxL1TtlMs) so stale
 *   entries never outlive their L2 expiration.
 * - Supports SWR (`getOrSetSWR`), ±10% TTL jitter, and in-process `createSnapshotCache`.
 */
import crypto from 'node:crypto'
import Redis from 'ioredis'
import { resolveCacheConfig, resolveRedisConfig } from '../db/pg/config.mjs'

const NOTIFY_CHANNEL = 'vm2api_cache_invalidate'
const MAX_AUTO_PREFIX_DEPTH = 3
const EPOCH_SYNC_TTL_MS = 30_000

/** Deterministic JSON serialization with recursively sorted object keys. */
export function stableStringify(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (typeof value !== 'object') return JSON.stringify(value)
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
  return `{${parts.join(',')}}`
}

/** Compute quoted SHA-256 ETag for HTTP 304 conditional responses. */
export function computeEtag(value) {
  const raw = typeof value === 'string' ? value : stableStringify(value)
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)
  return `"${digest}"`
}

/** Match HTTP If-None-Match header against a computed ETag (supports weak W/ and lists). */
export function matchesEtag(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false
  const raw = String(ifNoneMatch).trim()
  if (raw === '*') return true
  const norm = (s) => s.trim().replace(/^W\//i, '')
  const target = norm(String(etag))
  return raw.split(',').some((candidate) => norm(candidate) === target)
}

export class BoundedLruCache {
  constructor(maxItems = 8192) {
    this.maxItems = Math.max(64, Number(maxItems) || 8192)
    this.map = new Map()
    this.hits = 0
    this.misses = 0
    this.sets = 0
    this.evictions = 0
  }

  get(key, now = Date.now()) {
    const entry = this.map.get(key)
    if (!entry) {
      this.misses += 1
      return { hit: false, value: undefined }
    }
    if (entry.expiresAt > 0 && entry.expiresAt <= now) {
      this.map.delete(key)
      this.misses += 1
      return { hit: false, value: undefined }
    }
    // Refresh LRU recency
    this.map.delete(key)
    this.map.set(key, entry)
    this.hits += 1
    return { hit: true, value: entry.value, expiresAt: entry.expiresAt }
  }

  set(key, value, ttlMs = 60_000, now = Date.now()) {
    const expiresAt = ttlMs > 0 ? now + ttlMs : 0
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxItems) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) {
        this.map.delete(oldest)
        this.evictions += 1
      }
    }
    this.map.set(key, { value, expiresAt })
    this.sets += 1
  }

  delete(key) {
    return this.map.delete(key)
  }

  deleteByPrefix(prefix) {
    let removed = 0
    for (const k of this.map.keys()) {
      if (k.startsWith(prefix)) {
        this.map.delete(k)
        removed += 1
      }
    }
    return removed
  }

  clear() {
    this.map.clear()
  }

  size() {
    return this.map.size
  }
}

/**
 * In-process bounded snapshot cache with singleflight coalescing and SHA-256 ETag.
 *
 * Designed for high-cardinality multi-filter panel queries so arbitrary filter
 * combinations never pollute Redis L2 memory while still absorbing concurrent
 * refreshes and enabling HTTP 304 Not Modified responses.
 */
export function createSnapshotCache({ maxEntries = 512, defaultTtlMs = 30_000 } = {}) {
  const lru = new BoundedLruCache(Math.max(16, Number(maxEntries) || 512))
  const fallbackTtlMs = Math.max(500, Number(defaultTtlMs) || 30_000)
  const inflight = new Map() // key -> { promise, invalidated }
  let singleflightCoalesced = 0

  function normalizeKey(keyOrNamespace, params) {
    if (params !== undefined) {
      const hash = crypto.createHash('sha1').update(stableStringify(params)).digest('hex').slice(0, 16)
      return `${String(keyOrNamespace)}:${hash}`
    }
    return typeof keyOrNamespace === 'string' ? keyOrNamespace : stableStringify(keyOrNamespace)
  }

  function get(key, now = Date.now()) {
    const res = lru.get(String(key), now)
    if (!res.hit) {
      return { hit: false, value: undefined, etag: null, cachedAt: null }
    }
    const { value, etag, cachedAt } = res.value
    return { hit: true, value, etag, cachedAt }
  }

  function set(key, value, ttlMs = fallbackTtlMs, now = Date.now()) {
    const effectiveTtl = Math.max(0, Number(ttlMs ?? fallbackTtlMs) || fallbackTtlMs)
    const entry = {
      value,
      etag: computeEtag(value),
      cachedAt: now,
    }
    lru.set(String(key), entry, effectiveTtl, now)
    return entry
  }

  async function getOrLoad(key, loader, { ttlMs = fallbackTtlMs, bypass = false } = {}) {
    const k = String(key)
    if (!bypass) {
      const cached = get(k)
      if (cached.hit) {
        return {
          value: cached.value,
          etag: cached.etag,
          hit: true,
          cacheStatus: 'hit',
          cachedAt: cached.cachedAt,
        }
      }
      const existing = inflight.get(k)
      if (existing) {
        singleflightCoalesced += 1
        return existing.promise
      }
    }

    const token = { invalidated: false, promise: null }
    const promise = Promise.resolve()
      .then(() => loader())
      .then((value) => {
        const now = Date.now()
        if (!token.invalidated && value !== undefined) {
          const entry = set(k, value, ttlMs, now)
          return {
            value: entry.value,
            etag: entry.etag,
            hit: false,
            cacheStatus: bypass ? 'bypass' : 'miss',
            cachedAt: entry.cachedAt,
          }
        }
        return {
          value,
          etag: computeEtag(value),
          hit: false,
          cacheStatus: bypass ? 'bypass' : 'miss',
          cachedAt: now,
        }
      })
      .finally(() => {
        if (inflight.get(k) === token) inflight.delete(k)
      })

    token.promise = promise
    if (!bypass) inflight.set(k, token)
    return promise
  }

  function del(key) {
    const k = String(key)
    const active = inflight.get(k)
    if (active) {
      active.invalidated = true
      inflight.delete(k)
    }
    return lru.delete(k)
  }

  function invalidatePrefix(prefix) {
    const p = String(prefix || '')
    if (!p) return 0
    for (const [k, token] of inflight) {
      if (k.startsWith(p)) {
        token.invalidated = true
        inflight.delete(k)
      }
    }
    return lru.deleteByPrefix(p)
  }

  function clear() {
    for (const token of inflight.values()) token.invalidated = true
    inflight.clear()
    lru.clear()
  }

  function stats() {
    const total = lru.hits + lru.misses
    return {
      size: lru.size(),
      max_entries: lru.maxItems,
      hits: lru.hits,
      misses: lru.misses,
      hit_rate: total > 0 ? Math.round((lru.hits / total) * 10_000) / 10_000 : null,
      sets: lru.sets,
      evictions: lru.evictions,
      singleflight_coalesced: singleflightCoalesced,
    }
  }

  return {
    buildKey: normalizeKey,
    computeEtag,
    matchesEtag,
    get,
    set,
    getOrLoad,
    delete: del,
    invalidatePrefix,
    clear,
    stats,
  }
}

export class MultiTierCacheClient {
  constructor({ redisConfig = null, cacheConfig = null } = {}) {
    this.instanceId = crypto.randomBytes(6).toString('hex')
    this.cacheConfig = cacheConfig || resolveCacheConfig()
    this.redisConfig = redisConfig !== undefined ? redisConfig : resolveRedisConfig()
    this.l1 = new BoundedLruCache(this.cacheConfig.l1MaxItems)
    this.inflight = new Map() // key -> { promise, invalidated }
    this.swrRefreshing = new Map() // key -> { promise, invalidated }
    this.singleflightCoalesced = 0
    this.swrStaleHits = 0
    this.swrRefreshes = 0
    this.l2Hits = 0
    this.l2Misses = 0
    this.l2Errors = 0
    this.invalidations = 0
    this.redis = null
    this.redisSub = null
    this.redisReady = false
    this.redisSubReady = false
    this.pgNotifyClient = null
    this.pgPool = null
    this.prefix = this.redisConfig?.keyPrefix || 'vm2api:'
    this.invalidationListeners = new Set()
    this._epochs = new Map() // prefix -> { epoch: number, syncedAt: number }
    this._epochSyncTtlMs = EPOCH_SYNC_TTL_MS
    this._closed = false
  }

  get enabled() {
    return !this.cacheConfig.disabled
  }

  get hasRedis() {
    return !!(this.redis && this.redisReady)
  }

  isRedisReady() {
    return this.hasRedis
  }

  getRedisClient() {
    return this.hasRedis ? this.redis : null
  }

  redisKey(key) {
    return this._redisKey(key)
  }

  onInvalidate(fn) {
    if (typeof fn === 'function') this.invalidationListeners.add(fn)
    return () => this.invalidationListeners.delete(fn)
  }

  async connect({ pgPool = null } = {}) {
    this.pgPool = pgPool || null
    if (!this.enabled) return

    if (this.redisConfig) {
      await this._connectRedis()
      if (!this.hasRedis && this.pgPool && !this.pgNotifyClient) {
        await this._connectPgNotify()
      }
    } else if (this.pgPool && !this.pgNotifyClient) {
      await this._connectPgNotify()
    }
  }

  _resetEpochSyncTimestamps() {
    for (const entry of this._epochs.values()) {
      entry.syncedAt = 0
    }
  }

  async _connectRedis() {
    try {
      const opts = {
        connectTimeout: this.redisConfig.connectTimeout ?? 3_000,
        commandTimeout: this.redisConfig.commandTimeout ?? 2_000,
        maxRetriesPerRequest: this.redisConfig.maxRetriesPerRequest ?? 1,
        enableOfflineQueue: false,
        lazyConnect: true,
        retryStrategy: (times) => Math.min(times * 500, 15_000),
      }
      const client = this.redisConfig.url
        ? new Redis(this.redisConfig.url, opts)
        : new Redis({
            host: this.redisConfig.host,
            port: this.redisConfig.port,
            password: this.redisConfig.password,
            db: this.redisConfig.db,
            tls: this.redisConfig.tls,
            ...opts,
          })

      client.on('ready', () => {
        this.redisReady = true
        this._resetEpochSyncTimestamps()
      })
      client.on('close', () => {
        this.redisReady = false
      })
      client.on('end', () => {
        this.redisReady = false
      })
      client.on('error', (err) => {
        this.l2Errors += 1
        this.redisReady = false
        if (!this._closed) {
          console.warn('[cache:redis]', err?.message || err)
        }
      })

      this.redis = client
      await client.connect()
      this.redisReady = true
      this._resetEpochSyncTimestamps()

      // Dedicated Pub/Sub subscriber for cross-instance invalidation
      const sub = client.duplicate({ lazyConnect: true, enableOfflineQueue: true })
      sub.on('ready', () => {
        this.redisSubReady = true
        this._resetEpochSyncTimestamps()
      })
      sub.on('close', () => {
        this.redisSubReady = false
      })
      sub.on('end', () => {
        this.redisSubReady = false
      })
      sub.on('error', () => {
        this.redisSubReady = false
      })
      sub.on('message', (_channel, raw) => {
        this._handleRemoteInvalidation(raw)
      })
      this.redisSub = sub
      await sub.connect()
      await sub.subscribe(`${this.prefix}invalidation`)
      this.redisSubReady = true
    } catch (err) {
      this.redisReady = false
      this.redisSubReady = false
      this.l2Errors += 1
      console.warn('[cache:redis] unavailable, running in L1-only mode:', err?.message || err)
    }
  }

  async _connectPgNotify() {
    if (!this.pgPool) return
    try {
      const client = await this.pgPool.connect()
      client.on('error', () => {
        this.pgNotifyClient = null
      })
      client.on('notification', (msg) => {
        if (msg?.channel === NOTIFY_CHANNEL && msg.payload) {
          this._handleRemoteInvalidation(msg.payload)
        }
      })
      await client.query(`LISTEN ${NOTIFY_CHANNEL}`)
      this.pgNotifyClient = client
    } catch (err) {
      console.warn('[cache:pg-notify] listener unavailable:', err?.message || err)
    }
  }

  _markInflightInvalidated(keys, prefixes) {
    const markMap = (map, removeActive) => {
      for (const k of keys) {
        const entry = map.get(k)
        if (entry) {
          entry.invalidated = true
          if (removeActive) map.delete(k)
        }
      }
      if (prefixes.length) {
        for (const [k, entry] of map) {
          if (prefixes.some((p) => k.startsWith(p))) {
            entry.invalidated = true
            if (removeActive) map.delete(k)
          }
        }
      }
    }
    markMap(this.inflight, true)
    markMap(this.swrRefreshing, false)
  }

  _handleRemoteInvalidation(raw) {
    try {
      const payload = JSON.parse(raw)
      if (!payload || payload.origin === this.instanceId) return
      const cleanKeys = Array.isArray(payload.keys) ? payload.keys.filter(Boolean) : []
      const cleanPrefixes = Array.isArray(payload.prefixes) ? payload.prefixes.filter(Boolean) : []
      for (const k of cleanKeys) this.l1.delete(k)
      for (const p of cleanPrefixes) this.l1.deleteByPrefix(p)
      this._markInflightInvalidated(cleanKeys, cleanPrefixes)

      const now = Date.now()
      if (payload.epochs && typeof payload.epochs === 'object') {
        for (const [p, ep] of Object.entries(payload.epochs)) {
          const n = Math.max(0, Number(ep) || 0)
          const cur = this._epochs.get(p)?.epoch || 0
          if (n >= cur) {
            this._epochs.set(p, { epoch: n, syncedAt: now })
          }
        }
      } else {
        for (const p of cleanPrefixes) {
          const cur = this._epochs.get(p)
          if (cur) cur.syncedAt = 0
        }
      }

      this.invalidations += 1
      for (const listener of this.invalidationListeners) {
        try {
          listener(payload)
        } catch {}
      }
    } catch {}
  }

  _redisKey(key) {
    return `${this.prefix}${key}`
  }

  _epochRedisKey(prefix) {
    return `${this.prefix}epoch:${prefix}`
  }

  /** Extract hierarchical colon-delimited prefixes (up to depth 3) plus explicit prefixes. */
  _extractKeyPrefixes(key, extraPrefixes = null) {
    const out = new Set()
    const str = String(key || '')
    let idx = str.indexOf(':')
    let depth = 0
    while (idx !== -1 && depth < MAX_AUTO_PREFIX_DEPTH) {
      out.add(str.slice(0, idx + 1))
      depth += 1
      idx = str.indexOf(':', idx + 1)
    }
    if (Array.isArray(extraPrefixes)) {
      for (const p of extraPrefixes) {
        if (p) out.add(String(p))
      }
    }
    return [...out].sort()
  }

  async _syncEpochsFromRedis(prefixes) {
    if (!this.hasRedis || !prefixes.length) return
    const now = Date.now()
    const syncTtl = this.redisSubReady ? this._epochSyncTtlMs : 0
    const stale = []
    for (const p of prefixes) {
      const entry = this._epochs.get(p)
      if (!entry || syncTtl === 0 || now - entry.syncedAt >= syncTtl) {
        stale.push(p)
      }
    }
    if (!stale.length) return
    try {
      const rKeys = stale.map((p) => this._epochRedisKey(p))
      const vals = await this.redis.mget(...rKeys)
      const fetchedAt = Date.now()
      for (let i = 0; i < stale.length; i += 1) {
        const p = stale[i]
        const raw = Array.isArray(vals) ? vals[i] : null
        const ep = Math.max(0, Number.parseInt(String(raw ?? '0'), 10) || 0)
        this._epochs.set(p, { epoch: ep, syncedAt: fetchedAt })
      }
    } catch {
      this.l2Errors += 1
    }
  }

  async _computeEpochTag(key, extraPrefixes = null) {
    const prefixes = this._extractKeyPrefixes(key, extraPrefixes)
    if (!prefixes.length) return ''
    await this._syncEpochsFromRedis(prefixes)
    const active = []
    for (const p of prefixes) {
      const ep = this._epochs.get(p)?.epoch || 0
      if (ep > 0) active.push(`${p}=${ep}`)
    }
    if (!active.length) return ''
    return crypto.createHash('sha1').update(active.join('|')).digest('hex').slice(0, 10)
  }

  /** Resolve the epoch-versioned Redis key for a logical cache key. */
  async resolveRedisKey(key, extraPrefixes = null) {
    const tag = await this._computeEpochTag(key, extraPrefixes)
    return tag ? `${this.prefix}v:${tag}:${key}` : `${this.prefix}${key}`
  }

  async _bumpPrefixEpochs(prefixes) {
    const bumped = {}
    if (!prefixes.length) return bumped
    const now = Date.now()
    for (const p of prefixes) {
      const next = (this._epochs.get(p)?.epoch || 0) + 1
      this._epochs.set(p, { epoch: next, syncedAt: now })
      bumped[p] = next
    }
    if (this.hasRedis) {
      try {
        if (typeof this.redis.pipeline === 'function') {
          const pipe = this.redis.pipeline()
          for (const p of prefixes) pipe.incr(this._epochRedisKey(p))
          const results = await pipe.exec()
          if (Array.isArray(results)) {
            for (let i = 0; i < prefixes.length; i += 1) {
              const [err, val] = results[i] || []
              if (!err && val != null) {
                const ep = Math.max(1, Number(val) || bumped[prefixes[i]])
                this._epochs.set(prefixes[i], { epoch: ep, syncedAt: Date.now() })
                bumped[prefixes[i]] = ep
              }
            }
          }
        } else if (typeof this.redis.incr === 'function') {
          for (const p of prefixes) {
            const val = await this.redis.incr(this._epochRedisKey(p))
            const ep = Math.max(1, Number(val) || bumped[p])
            this._epochs.set(p, { epoch: ep, syncedAt: Date.now() })
            bumped[p] = ep
          }
        }
      } catch {
        this.l2Errors += 1
      }
    }
    return bumped
  }

  _applyJitter(ttlMs, jitterMs = 0, jitter = false) {
    const base = Math.max(0, Number(ttlMs) || 0)
    if (base <= 0) return 0
    if (jitter) {
      const ratio = typeof jitter === 'number' && Number.isFinite(jitter) ? Math.min(0.5, Math.max(0, jitter)) : 0.1
      if (ratio <= 0) return base
      const delta = Math.round((Math.random() * 2 - 1) * base * ratio)
      return Math.max(500, base + delta)
    }
    const j = Math.max(0, Math.min(Number(jitterMs) || 0, Math.floor(base * 0.5)))
    if (j <= 0) return base
    return Math.max(500, base - Math.floor(Math.random() * j))
  }

  getL1(key) {
    if (!this.enabled) return { hit: false, value: undefined }
    return this.l1.get(key)
  }

  setL1(key, value, ttlMs = this.cacheConfig.defaultTtlMs, jitterMs = 0, jitter = false) {
    if (!this.enabled) return
    this.l1.set(key, value, this._applyJitter(ttlMs, jitterMs, jitter))
  }

  async _readL2WithPttl(rKey) {
    if (typeof this.redis.pipeline === 'function') {
      const pipe = this.redis.pipeline()
      pipe.get(rKey)
      pipe.pttl(rKey)
      const results = await pipe.exec()
      const [getErr, raw] = results?.[0] || []
      const [pttlErr, pttl] = results?.[1] || []
      if (getErr) throw getErr
      return { raw: raw ?? null, pttl: !pttlErr && typeof pttl === 'number' ? pttl : -1 }
    }
    const raw = await this.redis.get(rKey)
    let pttl = -1
    if (raw != null && typeof this.redis.pttl === 'function') {
      pttl = await this.redis.pttl(rKey)
    }
    return { raw: raw ?? null, pttl: typeof pttl === 'number' ? pttl : -1 }
  }

  async get(key, { useL2 = true, prefixes = null, maxL1TtlMs = null } = {}) {
    if (!this.enabled) return { hit: false, value: undefined, tier: null }
    const l1Res = this.l1.get(key)
    if (l1Res.hit) return { hit: true, value: l1Res.value, tier: 'l1' }

    if (useL2 && this.hasRedis) {
      let rKey = null
      try {
        rKey = await this.resolveRedisKey(key, prefixes)
        const { raw, pttl } = await this._readL2WithPttl(rKey)
        if (raw != null) {
          let parsed
          try {
            parsed = JSON.parse(raw)
          } catch {
            // Active self-heal on corrupted JSON in Redis
            this.l2Errors += 1
            this.redis.del(rKey).catch(() => {})
            return { hit: false, value: undefined, tier: null }
          }
          this.l2Hits += 1
          const cap = Math.max(500, Number(maxL1TtlMs) || Math.min(this.cacheConfig.defaultTtlMs, 30_000))
          if (pttl !== -2) {
            const backfillTtl = pttl > 0 ? Math.min(pttl, cap) : cap
            this.l1.set(key, parsed, backfillTtl)
          }
          return { hit: true, value: parsed, tier: 'l2', pttlMs: pttl > 0 ? pttl : null }
        }
        this.l2Misses += 1
      } catch {
        this.l2Errors += 1
      }
    }
    return { hit: false, value: undefined, tier: null }
  }

  async set(
    key,
    value,
    {
      ttlMs = this.cacheConfig.defaultTtlMs,
      l1TtlMs = null,
      jitterMs = 0,
      jitter = false,
      useL2 = true,
      prefixes = null,
    } = {},
  ) {
    if (!this.enabled) return
    const effectiveTtl = this._applyJitter(ttlMs, jitterMs, jitter)
    const effectiveL1Ttl =
      l1TtlMs != null
        ? Math.min(effectiveTtl > 0 ? effectiveTtl : Infinity, this._applyJitter(l1TtlMs, 0, jitter))
        : effectiveTtl
    this.l1.set(key, value, effectiveL1Ttl)
    if (useL2 && this.hasRedis && effectiveTtl > 0) {
      try {
        const rKey = await this.resolveRedisKey(key, prefixes)
        await this.redis.set(rKey, JSON.stringify(value), 'PX', effectiveTtl)
      } catch {
        this.l2Errors += 1
      }
    }
  }

  /**
   * Read-through with singleflight coalescing across concurrent callers.
   */
  async getOrLoad(key, loader, opts = {}) {
    if (!this.enabled) return loader()
    const cached = await this.get(key, opts)
    if (cached.hit) return cached.value

    const existing = this.inflight.get(key)
    if (existing) {
      this.singleflightCoalesced += 1
      return existing.promise
    }

    const token = { invalidated: false, promise: null }
    const promise = Promise.resolve()
      .then(() => loader())
      .then(async (value) => {
        if (!token.invalidated && (value !== undefined || opts.cacheUndefined)) {
          await this.set(key, value, opts)
        }
        return value
      })
      .finally(() => {
        if (this.inflight.get(key) === token) this.inflight.delete(key)
      })

    token.promise = promise
    this.inflight.set(key, token)
    return promise
  }

  /**
   * Stale-While-Revalidate cache read-through (sub2api pattern).
   *
   * Stores `{ v, ts }` in L1+L2:
   * - Within `freshTtlMs`: returns immediately with zero refresh.
   * - Between `freshTtlMs` and hard `ttlMs`: returns stale value immediately and
   *   triggers at most 1 singleflight background refresh.
   * - Beyond `ttlMs` or corrupted payload: deletes bad entry and loads synchronously
   *   with singleflight coalescing.
   */
  async getOrSetSWR(
    key,
    loader,
    {
      freshTtlMs = null,
      ttlMs = this.cacheConfig.defaultTtlMs,
      prefixes = null,
      jitter = true,
      useL2 = true,
      maxL1TtlMs = null,
      bypass = false,
      cacheUndefined = false,
      now = Date.now(),
    } = {},
  ) {
    if (!this.enabled) return loader()
    const hardTtl = Math.max(1_000, Number(ttlMs) || this.cacheConfig.defaultTtlMs)
    const freshWindow = Math.min(hardTtl, Math.max(250, Number(freshTtlMs) || Math.floor(hardTtl / 2)))
    const l1Cap = maxL1TtlMs != null ? maxL1TtlMs : hardTtl

    if (!bypass) {
      const cached = await this.get(key, { useL2, prefixes, maxL1TtlMs: l1Cap })
      if (cached.hit) {
        const env = cached.value
        const validEnvelope = env && typeof env === 'object' && 'v' in env && typeof env.ts === 'number'
        if (!validEnvelope) {
          // Corrupted or non-SWR envelope: actively evict and fall through to loader
          this.l1.delete(key)
          if (useL2 && this.hasRedis) {
            this.resolveRedisKey(key, prefixes)
              .then((rKey) => this.redis.del(rKey))
              .catch(() => {})
          }
        } else {
          const age = Math.max(0, now - env.ts)
          if (age <= freshWindow) {
            return env.v
          }
          if (age <= hardTtl) {
            this.swrStaleHits += 1
            if (!this.swrRefreshing.has(key)) {
              this.swrRefreshes += 1
              const bgToken = { invalidated: false, promise: null }
              const bg = Promise.resolve()
                .then(() => loader())
                .then(async (freshVal) => {
                  if (!bgToken.invalidated && (freshVal !== undefined || cacheUndefined)) {
                    await this.set(
                      key,
                      { v: freshVal, ts: Date.now() },
                      { ttlMs: hardTtl, l1TtlMs: l1Cap, jitter, useL2, prefixes },
                    )
                  }
                })
                .catch(() => {})
                .finally(() => {
                  if (this.swrRefreshing.get(key) === bgToken) this.swrRefreshing.delete(key)
                })
              bgToken.promise = bg
              this.swrRefreshing.set(key, bgToken)
            }
            return env.v
          }
        }
      }

      const existing = this.inflight.get(key)
      if (existing) {
        this.singleflightCoalesced += 1
        return existing.promise
      }
    }

    const token = { invalidated: false, promise: null }
    const promise = Promise.resolve()
      .then(() => loader())
      .then(async (value) => {
        if (!token.invalidated && (value !== undefined || cacheUndefined)) {
          await this.set(key, { v: value, ts: Date.now() }, { ttlMs: hardTtl, l1TtlMs: l1Cap, jitter, useL2, prefixes })
        }
        return value
      })
      .finally(() => {
        if (this.inflight.get(key) === token) this.inflight.delete(key)
      })

    token.promise = promise
    if (!bypass) this.inflight.set(key, token)
    return promise
  }

  /** Delete keys and/or prefixes locally + in Redis (via O(1) namespace epoch) + broadcast cross-instance invalidation. */
  async invalidate({ keys = [], prefixes = [], broadcast = true } = {}) {
    const cleanKeys = keys.filter(Boolean).map(String)
    const cleanPrefixes = prefixes.filter(Boolean).map(String)
    for (const k of cleanKeys) this.l1.delete(k)
    for (const p of cleanPrefixes) this.l1.deleteByPrefix(p)
    this._markInflightInvalidated(cleanKeys, cleanPrefixes)
    this.invalidations += 1

    const bumpedEpochs = cleanPrefixes.length ? await this._bumpPrefixEpochs(cleanPrefixes) : {}

    if (this.hasRedis && cleanKeys.length) {
      try {
        const redisKeysToDel = new Set()
        for (const k of cleanKeys) {
          redisKeysToDel.add(this._redisKey(k))
          const versioned = await this.resolveRedisKey(k)
          redisKeysToDel.add(versioned)
        }
        await this.redis.del(...redisKeysToDel)
      } catch {
        this.l2Errors += 1
      }
    }

    const event = {
      origin: this.instanceId,
      keys: cleanKeys,
      prefixes: cleanPrefixes,
      ...(Object.keys(bumpedEpochs).length ? { epochs: bumpedEpochs } : {}),
    }

    for (const listener of this.invalidationListeners) {
      try {
        listener(event)
      } catch {}
    }

    if (broadcast && (cleanKeys.length || cleanPrefixes.length)) {
      const msg = JSON.stringify(event)
      if (this.hasRedis) {
        try {
          await this.redis.publish(`${this.prefix}invalidation`, msg)
        } catch {
          this.l2Errors += 1
        }
      } else if (this.pgPool && msg.length < 7_500) {
        this.pgPool.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, msg]).catch(() => {})
      }
    }
  }

  /** Safe Redis pipeline helper (Fail-Open: returns null when Redis is unavailable or errors). */
  async execPipeline(buildFn) {
    if (!this.hasRedis || typeof buildFn !== 'function') return null
    try {
      const pipe = this.redis.pipeline()
      buildFn(pipe, (k) => this._redisKey(k))
      return await pipe.exec()
    } catch {
      this.l2Errors += 1
      return null
    }
  }

  /** Safe batched L2 MGET for logical keys with epoch resolution (Fail-Open: returns null if Redis unavailable). */
  async mget(keys, { prefixes = null } = {}) {
    if (!this.enabled || !this.hasRedis || !Array.isArray(keys) || !keys.length) return null
    try {
      const rKeys = await Promise.all(keys.map((k) => this.resolveRedisKey(k, prefixes)))
      const rawList = await this.redis.mget(...rKeys)
      if (!Array.isArray(rawList)) return null
      return rawList.map((raw, idx) => {
        if (raw == null) return null
        try {
          return JSON.parse(raw)
        } catch {
          this.l2Errors += 1
          this.redis.del(rKeys[idx]).catch(() => {})
          return null
        }
      })
    } catch {
      this.l2Errors += 1
      return null
    }
  }

  /** Safe raw string GET on prefixed key (no epoch versioning, Fail-Open). */
  async getRaw(key) {
    if (!this.hasRedis) return null
    try {
      return await this.redis.get(this._redisKey(key))
    } catch {
      this.l2Errors += 1
      return null
    }
  }

  /** Safe raw string SET on prefixed key with optional PX TTL (no epoch versioning, Fail-Open). */
  async setRaw(key, value, ttlMs = 0) {
    if (!this.hasRedis) return false
    try {
      const rKey = this._redisKey(key)
      if (ttlMs > 0) {
        await this.redis.set(rKey, String(value), 'PX', Math.max(1, Math.floor(ttlMs)))
      } else {
        await this.redis.set(rKey, String(value))
      }
      return true
    } catch {
      this.l2Errors += 1
      return false
    }
  }

  /** Safe raw DEL on prefixed keys (no epoch versioning, Fail-Open). */
  async delRaw(keys) {
    if (!this.hasRedis) return 0
    const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean)
    if (!list.length) return 0
    try {
      return Number(await this.redis.del(...list.map((k) => this._redisKey(k)))) || 0
    } catch {
      this.l2Errors += 1
      return 0
    }
  }

  /** Execute a Redis Lua script when Redis is ready; returns null when Redis is unavailable. */
  async evalLua(script, keys = [], args = []) {
    if (!this.hasRedis) return null
    try {
      const prefixed = keys.map((k) => this._redisKey(k))
      return await this.redis.eval(script, prefixed.length, ...prefixed, ...args)
    } catch {
      this.l2Errors += 1
      return null
    }
  }

  /** Execute a Redis Lua script with epoch-versioned keys so prefix invalidation applies to Lua-managed keys. */
  async evalLuaVersioned(script, keys = [], args = [], { prefixes = null } = {}) {
    if (!this.hasRedis) return null
    try {
      const resolved = await Promise.all(keys.map((k) => this.resolveRedisKey(k, prefixes)))
      return await this.redis.eval(script, resolved.length, ...resolved, ...args)
    } catch {
      this.l2Errors += 1
      return null
    }
  }

  async pingRedis(clock = () => performance.now()) {
    if (!this.hasRedis) return { ok: false, latencyMs: null }
    const t0 = clock()
    try {
      const res = await this.redis.ping()
      const dt = clock() - t0
      return {
        ok: res === 'PONG',
        latencyMs: Number.isFinite(dt) ? Math.round(Math.max(dt, 0) * 1000) / 1000 : null,
      }
    } catch {
      this.l2Errors += 1
      return { ok: false, latencyMs: null }
    }
  }

  stats() {
    const l1Total = this.l1.hits + this.l1.misses
    const l2Total = this.l2Hits + this.l2Misses
    return {
      enabled: this.enabled,
      mode: this.hasRedis ? 'l1+redis' : this.pgNotifyClient ? 'l1+pg_notify' : 'l1',
      l1: {
        size: this.l1.size(),
        max_items: this.l1.maxItems,
        hits: this.l1.hits,
        misses: this.l1.misses,
        hit_rate: l1Total > 0 ? Math.round((this.l1.hits / l1Total) * 10_000) / 10_000 : null,
        sets: this.l1.sets,
        evictions: this.l1.evictions,
      },
      l2_redis: {
        configured: !!this.redisConfig,
        connected: this.hasRedis,
        hits: this.l2Hits,
        misses: this.l2Misses,
        hit_rate: l2Total > 0 ? Math.round((this.l2Hits / l2Total) * 10_000) / 10_000 : null,
        errors: this.l2Errors,
      },
      singleflight_coalesced: this.singleflightCoalesced,
      swr_stale_hits: this.swrStaleHits,
      swr_refreshes: this.swrRefreshes,
      invalidations: this.invalidations,
    }
  }

  async close() {
    this._closed = true
    this.l1.clear()
    this.inflight.clear()
    this.swrRefreshing.clear()
    this._epochs.clear()
    if (this.redisSub) {
      try {
        await this.redisSub.quit()
      } catch {
        try {
          this.redisSub.disconnect()
        } catch {}
      }
      this.redisSub = null
    }
    this.redisSubReady = false
    if (this.redis) {
      try {
        await this.redis.quit()
      } catch {
        try {
          this.redis.disconnect()
        } catch {}
      }
      this.redis = null
    }
    this.redisReady = false
    if (this.pgNotifyClient) {
      try {
        await this.pgNotifyClient.query(`UNLISTEN ${NOTIFY_CHANNEL}`)
      } catch {}
      try {
        this.pgNotifyClient.release()
      } catch {}
      this.pgNotifyClient = null
    }
  }
}
