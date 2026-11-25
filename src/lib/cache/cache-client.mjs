/**
 * Multi-tier Cache Client (L1 in-process LRU+TTL + singleflight + optional L2 Redis + Pub/Sub & PG NOTIFY).
 *
 * Designed on sub2api's Redis + L1 caching patterns:
 * - L1 bounded LRU cache provides <0.01ms lookups with zero network hops.
 * - Singleflight coalesces concurrent cache misses for the same key.
 * - L2 Redis (`ioredis`) is strictly optional and fail-open: if unconfigured or
 *   temporarily unavailable, traffic continues cleanly on L1 + PostgreSQL.
 * - Cross-instance cache invalidation uses Redis Pub/Sub when Redis is enabled,
 *   and falls back to PostgreSQL LISTEN/NOTIFY when sharing a PG database without Redis.
 */
import crypto from 'node:crypto'
import Redis from 'ioredis'
import { resolveCacheConfig, resolveRedisConfig } from '../db/pg/config.mjs'

const NOTIFY_CHANNEL = 'vm2api_cache_invalidate'

class BoundedLruCache {
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
    return { hit: true, value: entry.value }
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

export class MultiTierCacheClient {
  constructor({ redisConfig = null, cacheConfig = null } = {}) {
    this.instanceId = crypto.randomBytes(6).toString('hex')
    this.cacheConfig = cacheConfig || resolveCacheConfig()
    this.redisConfig = redisConfig !== undefined ? redisConfig : resolveRedisConfig()
    this.l1 = new BoundedLruCache(this.cacheConfig.l1MaxItems)
    this.inflight = new Map()
    this.singleflightCoalesced = 0
    this.l2Hits = 0
    this.l2Misses = 0
    this.l2Errors = 0
    this.invalidations = 0
    this.redis = null
    this.redisSub = null
    this.redisReady = false
    this.pgNotifyClient = null
    this.pgPool = null
    this.prefix = this.redisConfig?.keyPrefix || 'vm2api:'
    this.invalidationListeners = new Set()
    this._closed = false
  }

  get enabled() {
    return !this.cacheConfig.disabled
  }

  get hasRedis() {
    return !!(this.redis && this.redisReady)
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

      // Dedicated Pub/Sub subscriber for cross-instance invalidation
      const sub = client.duplicate({ lazyConnect: true, enableOfflineQueue: true })
      sub.on('error', () => {})
      sub.on('message', (_channel, raw) => {
        this._handleRemoteInvalidation(raw)
      })
      this.redisSub = sub
      await sub.connect()
      await sub.subscribe(`${this.prefix}invalidation`)
    } catch (err) {
      this.redisReady = false
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

  _handleRemoteInvalidation(raw) {
    try {
      const payload = JSON.parse(raw)
      if (!payload || payload.origin === this.instanceId) return
      if (Array.isArray(payload.keys)) {
        for (const k of payload.keys) this.l1.delete(k)
      }
      if (Array.isArray(payload.prefixes)) {
        for (const p of payload.prefixes) this.l1.deleteByPrefix(p)
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

  _applyJitter(ttlMs, jitterMs = 0) {
    const base = Math.max(0, Number(ttlMs) || 0)
    const j = Math.max(0, Math.min(Number(jitterMs) || 0, Math.floor(base * 0.5)))
    if (j <= 0) return base
    return Math.max(500, base - Math.floor(Math.random() * j))
  }

  getL1(key) {
    if (!this.enabled) return { hit: false, value: undefined }
    return this.l1.get(key)
  }

  setL1(key, value, ttlMs = this.cacheConfig.defaultTtlMs, jitterMs = 0) {
    if (!this.enabled) return
    this.l1.set(key, value, this._applyJitter(ttlMs, jitterMs))
  }

  async get(key, { useL2 = true } = {}) {
    if (!this.enabled) return { hit: false, value: undefined, tier: null }
    const l1Res = this.l1.get(key)
    if (l1Res.hit) return { hit: true, value: l1Res.value, tier: 'l1' }

    if (useL2 && this.hasRedis) {
      try {
        const raw = await this.redis.get(this._redisKey(key))
        if (raw != null) {
          const parsed = JSON.parse(raw)
          this.l2Hits += 1
          this.l1.set(key, parsed, Math.min(this.cacheConfig.defaultTtlMs, 30_000))
          return { hit: true, value: parsed, tier: 'l2' }
        }
        this.l2Misses += 1
      } catch {
        this.l2Errors += 1
      }
    }
    return { hit: false, value: undefined, tier: null }
  }

  async set(key, value, { ttlMs = this.cacheConfig.defaultTtlMs, jitterMs = 0, useL2 = true } = {}) {
    if (!this.enabled) return
    const effectiveTtl = this._applyJitter(ttlMs, jitterMs)
    this.l1.set(key, value, effectiveTtl)
    if (useL2 && this.hasRedis && effectiveTtl > 0) {
      try {
        await this.redis.set(this._redisKey(key), JSON.stringify(value), 'PX', effectiveTtl)
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
      return existing
    }

    const promise = Promise.resolve()
      .then(() => loader())
      .then(async (value) => {
        if (value !== undefined || opts.cacheUndefined) {
          await this.set(key, value, opts)
        }
        return value
      })
      .finally(() => {
        this.inflight.delete(key)
      })

    this.inflight.set(key, promise)
    return promise
  }

  /** Delete keys and/or prefixes locally + in Redis + broadcast cross-instance invalidation. */
  async invalidate({ keys = [], prefixes = [], broadcast = true } = {}) {
    const cleanKeys = keys.filter(Boolean)
    const cleanPrefixes = prefixes.filter(Boolean)
    for (const k of cleanKeys) this.l1.delete(k)
    for (const p of cleanPrefixes) this.l1.deleteByPrefix(p)
    this.invalidations += 1

    for (const listener of this.invalidationListeners) {
      try {
        listener({ origin: this.instanceId, keys: cleanKeys, prefixes: cleanPrefixes })
      } catch {}
    }

    if (this.hasRedis && cleanKeys.length) {
      try {
        await this.redis.del(...cleanKeys.map((k) => this._redisKey(k)))
      } catch {
        this.l2Errors += 1
      }
    }

    if (broadcast && (cleanKeys.length || cleanPrefixes.length)) {
      const msg = JSON.stringify({ origin: this.instanceId, keys: cleanKeys, prefixes: cleanPrefixes })
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
      invalidations: this.invalidations,
    }
  }

  async close() {
    this._closed = true
    this.l1.clear()
    this.inflight.clear()
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
