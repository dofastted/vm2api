/**
 * API Key authentication cache with versioned snapshots, L1-only bounded negative caching,
 * ±10% TTL jitter, singleflight coalescing, and Pub/Sub cross-instance invalidation.
 *
 * Modeled on sub2api's `api_key_cache.go`:
 * - Keyed by HMAC/SHA-256 `key_hash` (`apikey:auth:<hash>`), never storing plaintext tokens.
 * - Positive entries wrap `{ v: version, data: record }` so schema changes auto-invalidate.
 * - Negative entries live ONLY in a dedicated bounded L1 LRU (30s default) and NEVER write
 *   to Redis L2 (deflects invalid-key brute-force without polluting Redis or evicting hot keys).
 * - PG `auth_cache_invalidation_outbox` inserts are disabled by default (0 consumers) and
 *   retained behind opt-in env `VM2API_ENABLE_CACHE_OUTBOX=1` / `VM2API_ENABLE_AUTH_OUTBOX=1`.
 */
import { BoundedLruCache } from './cache-client.mjs'

const PREFIX = 'apikey:auth:'
const DOMAIN_PREFIX = 'apikey:'
const CACHE_SCHEMA_VERSION = 1
const DEFAULT_NEG_TTL_MS = 30_000
const DEFAULT_NEG_MAX_ITEMS = 4_096

function parseBoolEnv(raw) {
  if (raw == null || raw === '') return false
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase())
}

function resolveOutboxEnabled(explicit) {
  if (typeof explicit === 'boolean') return explicit
  return parseBoolEnv(process.env.VM2API_ENABLE_AUTH_OUTBOX) || parseBoolEnv(process.env.VM2API_ENABLE_CACHE_OUTBOX)
}

export class ApiKeyCache {
  constructor(
    cacheClient,
    {
      ttlMs = 60_000,
      l1TtlMs = null,
      l2TtlMs = null,
      negTtlMs = DEFAULT_NEG_TTL_MS,
      negMaxItems = DEFAULT_NEG_MAX_ITEMS,
      version = CACHE_SCHEMA_VERSION,
      pgPool = null,
      enableOutbox,
    } = {},
  ) {
    this.cache = cacheClient
    this.ttlMs = Math.max(1_000, Number(ttlMs) || 60_000)
    this.l1TtlMs = Math.max(1_000, Number(l1TtlMs) || Math.min(this.ttlMs, 15_000))
    this.l2TtlMs = Math.max(1_000, Number(l2TtlMs) || this.ttlMs)
    this.negTtlMs = Math.max(1_000, Number(negTtlMs) || DEFAULT_NEG_TTL_MS)
    this.version = Number(version) || CACHE_SCHEMA_VERSION
    this.pgPool = pgPool
    this.enableOutbox = resolveOutboxEnabled(enableOutbox)
    this.negCache = new BoundedLruCache(negMaxItems)
    this._inflight = new Map() // keyHash -> { promise, invalidated }

    if (this.cache?.onInvalidate) {
      this._unsubscribe = this.cache.onInvalidate((payload) => {
        if (!payload) return
        if (Array.isArray(payload.keys)) {
          for (const k of payload.keys) {
            if (typeof k === 'string' && k.startsWith(PREFIX)) {
              const hash = k.slice(PREFIX.length)
              this.negCache.delete(hash)
              const inf = this._inflight.get(hash)
              if (inf) {
                inf.invalidated = true
                this._inflight.delete(hash)
              }
            }
          }
        }
        if (Array.isArray(payload.prefixes)) {
          if (payload.prefixes.some((p) => p === PREFIX || p === DOMAIN_PREFIX || PREFIX.startsWith(p))) {
            this.negCache.clear()
            for (const inf of this._inflight.values()) inf.invalidated = true
            this._inflight.clear()
          }
        }
      })
    }
  }

  setPgPool(pgPool) {
    this.pgPool = pgPool || null
  }

  _wrap(record) {
    return { v: this.version, data: record }
  }

  _unwrap(raw) {
    if (raw && typeof raw === 'object' && 'v' in raw && 'data' in raw) {
      if (raw.v !== this.version) return { valid: false, value: null }
      return { valid: true, value: raw.data }
    }
    // Backward compatibility with any unwrapped record placed in L1
    return { valid: true, value: raw }
  }

  _jitteredNegTtl() {
    if (this.cache?._applyJitter) {
      return this.cache._applyJitter(this.negTtlMs, 0, true)
    }
    return this.negTtlMs
  }

  /** Fast synchronous L1 lookup for hot-path auth middleware. */
  getSync(keyHash) {
    if (!keyHash || !this.cache?.enabled) return { hit: false, value: null }
    const key = `${PREFIX}${keyHash}`
    const res = this.cache.getL1(key)
    if (res.hit) {
      const unpacked = this._unwrap(res.value)
      if (unpacked.valid) return { hit: true, value: unpacked.value }
      this.cache.l1?.delete(key)
      return { hit: false, value: null }
    }
    const neg = this.negCache.get(String(keyHash))
    if (neg.hit) return { hit: true, value: null }
    return { hit: false, value: null }
  }

  /** Populate L1 (+ async L2 fire-and-forget for positive entries only; negative stays L1-only). */
  putSync(keyHash, record) {
    if (!keyHash || !this.cache?.enabled) return
    const hash = String(keyHash)
    const key = `${PREFIX}${hash}`
    if (!record) {
      this.cache.l1?.delete(key)
      this.negCache.set(hash, true, this._jitteredNegTtl())
      return
    }
    this.negCache.delete(hash)
    const wrapped = this._wrap(record)
    this.cache.setL1(key, wrapped, this.l1TtlMs, 0, true)
    this.cache
      .set(key, wrapped, {
        ttlMs: this.l2TtlMs,
        l1TtlMs: this.l1TtlMs,
        jitter: true,
        prefixes: [DOMAIN_PREFIX, PREFIX],
      })
      .catch(() => {})
  }

  /**
   * Full async L1 -> bounded L1 negCache -> Redis L2 -> singleflight loader read-through.
   * Negative results are cached ONLY in bounded L1 (`negTtlMs`) and never written to Redis.
   */
  async get(keyHash, loader = null) {
    if (!keyHash) return null
    const hash = String(keyHash)
    if (!this.cache?.enabled) {
      return typeof loader === 'function' ? loader() : null
    }

    // 1. Positive L1
    const key = `${PREFIX}${hash}`
    const l1Res = this.cache.getL1(key)
    if (l1Res.hit) {
      const unpacked = this._unwrap(l1Res.value)
      if (unpacked.valid) return unpacked.value
      this.cache.l1?.delete(key)
    }

    // 2. Negative L1 (bounded, never hits Redis)
    if (this.negCache.get(hash).hit) return null

    // 3. Redis L2 (when available)
    if (this.cache.hasRedis) {
      const l2Res = await this.cache.get(key, {
        useL2: true,
        prefixes: [DOMAIN_PREFIX, PREFIX],
        maxL1TtlMs: this.l1TtlMs,
      })
      if (l2Res.hit) {
        const unpacked = this._unwrap(l2Res.value)
        if (unpacked.valid) return unpacked.value
        // Version mismatch: evict stale entry and reload
        await this.cache.invalidate({ keys: [key], broadcast: false })
      }
    }

    if (typeof loader !== 'function') return null

    // 4. Singleflight DB load
    const existing = this._inflight.get(hash)
    if (existing) {
      this.cache.singleflightCoalesced += 1
      return existing.promise
    }

    const token = { invalidated: false, promise: null }
    const promise = Promise.resolve()
      .then(() => loader())
      .then(async (rec) => {
        if (!token.invalidated) {
          if (!rec) {
            this.cache.l1?.delete(key)
            this.negCache.set(hash, true, this._jitteredNegTtl())
            return null
          }
          this.negCache.delete(hash)
          await this.cache.set(key, this._wrap(rec), {
            ttlMs: this.l2TtlMs,
            l1TtlMs: this.l1TtlMs,
            jitter: true,
            prefixes: [DOMAIN_PREFIX, PREFIX],
          })
        }
        return rec || null
      })
      .finally(() => {
        if (this._inflight.get(hash) === token) this._inflight.delete(hash)
      })

    token.promise = promise
    this._inflight.set(hash, token)
    return promise
  }

  /** Backward-compatible alias for `get(keyHash, loader)`. */
  async getOrLoad(keyHash, loader) {
    return this.get(keyHash, loader)
  }

  /** Precisely evict one key hash from L1 + L2 and broadcast cross-instance invalidation. */
  async invalidateHash(keyHash, reason = 'updated') {
    if (!keyHash || !this.cache) return
    const hash = String(keyHash)
    this.negCache.delete(hash)
    const inf = this._inflight.get(hash)
    if (inf) {
      inf.invalidated = true
      this._inflight.delete(hash)
    }
    await this.cache.invalidate({ keys: [`${PREFIX}${hash}`] })
    if (this.enableOutbox && this.pgPool) {
      this.pgPool
        .query('INSERT INTO auth_cache_invalidation_outbox (key_hash, reason) VALUES ($1, $2)', [hash, String(reason)])
        .catch(() => {})
    }
  }

  /** Backward-compatible alias for `invalidateHash`. */
  async invalidateByHash(keyHash, reason = 'updated') {
    return this.invalidateHash(keyHash, reason)
  }

  async invalidateAll() {
    this.negCache.clear()
    for (const inf of this._inflight.values()) inf.invalidated = true
    this._inflight.clear()
    if (!this.cache) return
    await this.cache.invalidate({ prefixes: [PREFIX] })
  }
}
