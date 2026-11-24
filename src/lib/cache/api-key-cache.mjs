/**
 * API Key authentication cache with negative caching and outbox/PubSub invalidation.
 *
 * Modeled on sub2api's `api_key_cache.go`:
 * - Keyed by SHA-256 `key_hash` (`apikey:auth:<hash>`), never storing plaintext tokens in cache keys.
 * - Negative sentinel caches unknown hashes briefly (10s) to deflect brute-force DB load.
 * - Mutations invalidate L1 + L2 and broadcast cross-instance eviction.
 */

const PREFIX = 'apikey:auth:'
const NEG_SENTINEL = '__neg__'
const NEG_TTL_MS = 10_000

export class ApiKeyCache {
  constructor(cacheClient, { ttlMs = 60_000, pgPool = null } = {}) {
    this.cache = cacheClient
    this.ttlMs = Math.max(1_000, Number(ttlMs) || 60_000)
    this.pgPool = pgPool
  }

  setPgPool(pgPool) {
    this.pgPool = pgPool || null
  }

  /** Fast synchronous L1 lookup for hot-path auth middleware. */
  getSync(keyHash) {
    if (!keyHash || !this.cache?.enabled) return { hit: false, value: null }
    const res = this.cache.getL1(`${PREFIX}${keyHash}`)
    if (!res.hit) return { hit: false, value: null }
    if (res.value === NEG_SENTINEL) return { hit: true, value: null }
    return { hit: true, value: res.value }
  }

  /** Populate L1 (+ async L2 fire-and-forget) after a DB lookup. */
  putSync(keyHash, record) {
    if (!keyHash || !this.cache?.enabled) return
    const key = `${PREFIX}${keyHash}`
    if (!record) {
      this.cache.setL1(key, NEG_SENTINEL, NEG_TTL_MS)
      this.cache.set(key, NEG_SENTINEL, { ttlMs: NEG_TTL_MS }).catch(() => {})
      return
    }
    this.cache.setL1(key, record, this.ttlMs, Math.min(5_000, Math.floor(this.ttlMs * 0.15)))
    this.cache
      .set(key, record, { ttlMs: this.ttlMs, jitterMs: Math.min(5_000, Math.floor(this.ttlMs * 0.15)) })
      .catch(() => {})
  }

  /** Full async L1 + L2 read-through with singleflight coalescing. */
  async getOrLoad(keyHash, loader) {
    if (!keyHash) return null
    if (!this.cache?.enabled) return loader()
    const val = await this.cache.getOrLoad(
      `${PREFIX}${keyHash}`,
      async () => {
        const rec = await loader()
        return rec || NEG_SENTINEL
      },
      { ttlMs: this.ttlMs, jitterMs: Math.min(5_000, Math.floor(this.ttlMs * 0.15)) },
    )
    return val === NEG_SENTINEL ? null : val
  }

  async invalidateByHash(keyHash, reason = 'updated') {
    if (!keyHash || !this.cache) return
    await this.cache.invalidate({ keys: [`${PREFIX}${keyHash}`] })
    if (this.pgPool) {
      this.pgPool
        .query('INSERT INTO auth_cache_invalidation_outbox (key_hash, reason) VALUES ($1, $2)', [
          String(keyHash),
          String(reason),
        ])
        .catch(() => {})
    }
  }

  async invalidateAll() {
    if (!this.cache) return
    await this.cache.invalidate({ prefixes: [PREFIX] })
  }
}
