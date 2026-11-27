/**
 * Unified Multi-Tier Cache Runtime for vm2api.
 *
 * Exposes singleton accessors for L1+Redis cache client, ApiKeyCache,
 * BillingCache, ConcurrencyCache, SchedulerCache, and DashboardCache, plus
 * table-level mutation invalidation routing.
 */
import { resolveCacheConfig, resolveRedisConfig } from '../db/pg/config.mjs'
import { MultiTierCacheClient } from './cache-client.mjs'
import { ApiKeyCache } from './api-key-cache.mjs'
import { BillingCache } from './billing-cache.mjs'
import { ConcurrencyCache } from './concurrency-cache.mjs'
import { SchedulerCache } from './scheduler-cache.mjs'
import { DashboardCache } from './dashboard-cache.mjs'

let runtime = null

function createRuntime({ redisConfig, cacheConfig, pgPool = null } = {}) {
  const cfg = cacheConfig || resolveCacheConfig()
  const rCfg = redisConfig !== undefined ? redisConfig : resolveRedisConfig()
  const client = new MultiTierCacheClient({ redisConfig: rCfg, cacheConfig: cfg })
  const apiKeys = new ApiKeyCache(client, { ttlMs: cfg.apiKeyTtlMs, pgPool })
  const billing = new BillingCache(client, { ttlMs: cfg.billingTtlMs })
  const concurrency = new ConcurrencyCache(client)
  const scheduler = new SchedulerCache(client, { ttlMs: cfg.schedulerTtlMs, pgPool })
  const dashboard = new DashboardCache(client, { ttlMs: cfg.dashboardTtlMs })

  // Keep local scheduler revision coherent when another instance broadcasts invalidation
  client.onInvalidate((payload) => {
    if (payload?.prefixes?.some((p) => p.startsWith('sched:'))) {
      scheduler.revision += 1
      scheduler.snapshots.clear()
    }
  })

  return {
    client,
    apiKeys,
    billing,
    concurrency,
    scheduler,
    dashboard,
    /** Route DB table mutations to exact cache domain invalidations. */
    onDbTablesMutated(tables) {
      if (!Array.isArray(tables) || !tables.length) return
      const set = new Set(tables)
      if (set.has('api_keys')) {
        apiKeys.invalidateAll().catch(() => {})
        billing.invalidateAll().catch(() => {})
      } else if (set.has('api_key_pool_bindings')) {
        apiKeys.invalidateAll().catch(() => {})
      }
      if (set.has('users') || set.has('redeem_codes')) {
        billing.invalidateAll().catch(() => {})
      }
      if (
        set.has('accounts') ||
        set.has('account_runtime') ||
        set.has('account_groups') ||
        set.has('groups') ||
        set.has('vms') ||
        set.has('vm_pools') ||
        set.has('vm_pool_members') ||
        set.has('scheduler_pools') ||
        set.has('scheduler_pool_members') ||
        set.has('api_key_pool_bindings') ||
        set.has('proxies')
      ) {
        scheduler.bumpRevision({ eventType: `tables:${[...set].join(',')}` })
      }
      if (
        set.has('usage_dashboard_hourly') ||
        set.has('usage_dashboard_daily') ||
        set.has('account_lifetime_usage_archive')
      ) {
        dashboard.invalidateAll().catch(() => {})
      }
    },
    stats() {
      return client.stats()
    },
  }
}

export function getCacheRuntime() {
  if (!runtime) {
    runtime = createRuntime()
  }
  return runtime
}

export async function initCacheRuntime({ pgPool = null, redisConfig, cacheConfig } = {}) {
  if (runtime) {
    runtime.apiKeys.setPgPool(pgPool)
    runtime.scheduler.setPgPool(pgPool)
    if (pgPool && !runtime.client.pgPool) {
      await runtime.client.connect({ pgPool })
    }
    return runtime
  }
  runtime = createRuntime({ redisConfig, cacheConfig, pgPool })
  await runtime.client.connect({ pgPool })
  return runtime
}

export async function closeCacheRuntime() {
  if (!runtime) return
  const closing = runtime
  runtime = null
  await closing.client.close()
}

export function snapshotCacheMetrics() {
  if (!runtime) return null
  return runtime.stats()
}

export { MultiTierCacheClient, ApiKeyCache, BillingCache, ConcurrencyCache, SchedulerCache, DashboardCache }
