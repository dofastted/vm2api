/**
 * Dashboard & Statistics Response Cache (L1 + L2 Redis + Singleflight).
 *
 * Modeled on sub2api's `dashboard_cache.go`: absorbs repeated dashboard/statistics
 * refreshes across multiple admin panel tabs without rescanning `usage_logs`.
 */
import crypto from 'node:crypto'

const PREFIX = 'dash:'

function stableKey(namespace, params) {
  const raw = JSON.stringify(params ?? {})
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)
  return `${PREFIX}${namespace}:${hash}`
}

export class DashboardCache {
  constructor(cacheClient, { ttlMs = 15_000 } = {}) {
    this.cache = cacheClient
    this.ttlMs = Math.max(1_000, Number(ttlMs) || 15_000)
  }

  async getOrLoad(namespace, params, loader, { ttlMs = this.ttlMs, bypass = false } = {}) {
    if (bypass || !this.cache?.enabled) return loader()
    const key = stableKey(namespace, params)
    return this.cache.getOrLoad(key, loader, {
      ttlMs,
      jitterMs: Math.min(3_000, Math.floor(ttlMs * 0.2)),
    })
  }

  async invalidateAll() {
    if (!this.cache) return
    await this.cache.invalidate({ prefixes: [PREFIX] })
  }
}
