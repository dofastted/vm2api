/**
 * Unified Multi-Tier Cache Runtime for vm2api.
 *
 * Exposes singleton accessors for L1+Redis cache client, ApiKeyCache,
 * BillingCache, ConcurrencyCache, SchedulerCache, DashboardCache, EntityCache,
 * and LiveLogCache, plus table-level mutation invalidation routing that works
 * consistently across both PostgreSQL (`PgSyncDb` hook) and SQLite (explicit
 * `notifyDbTablesMutated()` entry).
 */
import { resolveCacheConfig, resolveRedisConfig } from '../db/pg/config.mjs'
import { MultiTierCacheClient, createSnapshotCache } from './cache-client.mjs'
import { ApiKeyCache } from './api-key-cache.mjs'
import { BillingCache } from './billing-cache.mjs'
import { ConcurrencyCache } from './concurrency-cache.mjs'
import { SchedulerCache } from './scheduler-cache.mjs'
import { DashboardCache } from './dashboard-cache.mjs'
import { EntityCache } from './entity-cache.mjs'
import { LiveLogCache } from './live-log-cache.mjs'

let runtime = null

function createRuntime({ redisConfig, cacheConfig, pgPool = null } = {}) {
  const cfg = cacheConfig || resolveCacheConfig()
  const rCfg = redisConfig !== undefined ? redisConfig : resolveRedisConfig()
  const client = new MultiTierCacheClient({ redisConfig: rCfg, cacheConfig: cfg })
  const apiKeys = new ApiKeyCache(client, {
    ttlMs: cfg.apiKeyTtlMs,
    l1TtlMs: Math.min(cfg.apiKeyTtlMs, 15_000),
    l2TtlMs: Math.max(cfg.apiKeyTtlMs, 300_000),
    pgPool,
  })
  const billing = new BillingCache(client, { ttlMs: cfg.billingTtlMs })
  const concurrency = new ConcurrencyCache(client)
  const scheduler = new SchedulerCache(client, { ttlMs: cfg.schedulerTtlMs, pgPool })
  const dashboard = new DashboardCache(client, { ttlMs: cfg.dashboardTtlMs })
  const entity = new EntityCache(client)
  const liveLogs = new LiveLogCache(client)

  // Keep local scheduler revision coherent when another instance broadcasts invalidation
  client.onInvalidate((payload) => {
    if (payload?.prefixes?.some((p) => p.startsWith('sched:'))) {
      scheduler.revision += 1
      scheduler.snapshots.clear()
    }
  })

  function onDbTablesMutated(tables) {
    const list = Array.isArray(tables) ? tables : tables ? [tables] : []
    if (!list.length) return
    const set = new Set(list.filter(Boolean).map((t) => String(t).toLowerCase()))
    if (!set.size) return

    const panelNamespaces = new Set()

    // Structural api_keys mutations invalidate auth + billing + display names + panel.
    // Routine per-request usage increments emit `api_keys:usage` and deliberately skip
    // cluster-wide `apiKeys.invalidateAll()` L1 eviction storms.
    if (set.has('api_keys')) {
      apiKeys.invalidateAll().catch(() => {})
      billing.invalidateAll().catch(() => {})
      entity.invalidateNames('api_keys').catch(() => {})
      panelNamespaces.add('panel')
      panelNamespaces.add('filter-options')
    } else if (set.has('api_key_pool_bindings')) {
      apiKeys.invalidateAll().catch(() => {})
    }

    if (set.has('api_key_pool_bindings') || set.has('scheduler_pools') || set.has('scheduler_pool_members')) {
      entity.invalidatePoolAccess().catch(() => {})
      panelNamespaces.add('panel')
    }

    if (set.has('users')) {
      billing.invalidateAll().catch(() => {})
      entity.invalidateUsers().catch(() => {})
      entity.invalidateNames('users').catch(() => {})
      panelNamespaces.add('panel')
      panelNamespaces.add('filter-options')
    } else if (set.has('redeem_codes')) {
      billing.invalidateAll().catch(() => {})
    }

    if (set.has('groups') || set.has('account_groups')) {
      entity.invalidateGroups().catch(() => {})
      panelNamespaces.add('panel')
      panelNamespaces.add('filter-options')
    }

    if (set.has('settings')) {
      entity.invalidateSettings().catch(() => {})
      panelNamespaces.add('panel')
    }

    if (set.has('vms') || set.has('vm_pools') || set.has('vm_pool_members')) {
      entity.invalidateVmOwners().catch(() => {})
      entity.invalidateNames('vms').catch(() => {})
      panelNamespaces.add('panel')
      panelNamespaces.add('filter-options')
    }

    if (set.has('proxies')) {
      panelNamespaces.add('panel')
    }

    if (set.has('accounts')) {
      entity.invalidateNames('accounts').catch(() => {})
      panelNamespaces.add('panel')
      panelNamespaces.add('filter-options')
    }

    if (set.has('refusal_session_blocks')) {
      client.invalidate({ prefixes: ['risk:bans:session:'] }).catch(() => {})
    }
    if (set.has('refusal_device_blocks') || set.has('risk_device_aliases')) {
      client.invalidate({ prefixes: ['risk:bans:device:'] }).catch(() => {})
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
    } else if (panelNamespaces.size > 0) {
      dashboard.invalidateNamespaces([...panelNamespaces]).catch(() => {})
    }
  }

  return {
    client,
    apiKeys,
    billing,
    concurrency,
    scheduler,
    dashboard,
    entity,
    liveLogs,
    /** Route DB table mutations to exact cache domain invalidations. */
    onDbTablesMutated,
    /** Explicit invalidation entry (consistent across PostgreSQL and SQLite modes). */
    notifyTablesMutated: onDbTablesMutated,
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
  closing.liveLogs?.clearLocal()
  await closing.client.close()
}

export function snapshotCacheMetrics() {
  if (!runtime) return null
  return runtime.stats()
}

/**
 * Explicit table-mutation cache invalidation entry for callers in SQLite mode
 * (where PgSyncDb's automatic DML hook is absent) or manual PG workflows.
 */
export function notifyDbTablesMutated(tables) {
  if (!runtime) return
  runtime.onDbTablesMutated(tables)
}

export {
  MultiTierCacheClient,
  createSnapshotCache,
  ApiKeyCache,
  BillingCache,
  ConcurrencyCache,
  SchedulerCache,
  DashboardCache,
  EntityCache,
  LiveLogCache,
}
