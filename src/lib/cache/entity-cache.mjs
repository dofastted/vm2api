/**
 * Short-TTL Multi-Tier Entity Cache (L1 + Redis L2 + Write Invalidation).
 *
 * Eliminates repetitive synchronous hot-path PostgreSQL lookups for low-churn
 * entities while guaranteeing prompt cross-instance invalidation on mutations:
 * - `panelUser` (by id or case-insensitive username)
 * - `groupRateMultiplier` (by groupId)
 * - `setting` (by setting key)
 * - `poolAccess` (by apiKeyId)
 * - `vmOwner` (by vmId)
 * - `entityNames` (batched MGET + minimal DB backfill for `users`, `api_keys`, `vms`, `accounts`)
 *
 * Every domain offers both async L1+L2 singleflight methods and sync L1 helpers
 * (with async fire-and-forget L2 write) for incremental adoption in sync call sites.
 */

const DOMAIN_PREFIX = 'entity:'
const USER_PREFIX = 'entity:user:'
const USER_ID_PREFIX = 'entity:user:id:'
const USER_NAME_PREFIX = 'entity:user:name:'
const GROUP_PREFIX = 'entity:group:'
const GROUP_RATE_PREFIX = 'entity:group:rate:'
const SETTING_PREFIX = 'entity:setting:'
const POOL_PREFIX = 'entity:pool:'
const POOL_ACCESS_PREFIX = 'entity:pool:access:'
const VM_PREFIX = 'entity:vm:'
const VM_OWNER_PREFIX = 'entity:vm:owner:'
const NAMES_PREFIX = 'entity:names:'

const DEFAULT_SHORT_TTL_MS = 30_000
const DEFAULT_LONG_TTL_MS = 60_000
const DEFAULT_L1_CAP_MS = 15_000

function normUsername(username) {
  return String(username || '')
    .trim()
    .toLowerCase()
}

function uniqueCleanIds(ids) {
  if (!Array.isArray(ids)) return []
  const out = []
  const seen = new Set()
  for (const raw of ids) {
    if (raw == null || raw === '') continue
    const id = String(raw)
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

function wrapValue(val) {
  return { v: val === undefined ? null : val }
}

function unwrapValue(raw) {
  if (raw && typeof raw === 'object' && 'v' in raw) return raw.v
  return raw
}

export class EntityCache {
  constructor(
    cacheClient,
    {
      userTtlMs = DEFAULT_SHORT_TTL_MS,
      groupTtlMs = DEFAULT_LONG_TTL_MS,
      settingTtlMs = DEFAULT_SHORT_TTL_MS,
      poolAccessTtlMs = DEFAULT_SHORT_TTL_MS,
      vmOwnerTtlMs = DEFAULT_LONG_TTL_MS,
      namesTtlMs = DEFAULT_LONG_TTL_MS,
      l1TtlMs = DEFAULT_L1_CAP_MS,
    } = {},
  ) {
    this.cache = cacheClient
    this.userTtlMs = Math.max(1_000, Number(userTtlMs) || DEFAULT_SHORT_TTL_MS)
    this.groupTtlMs = Math.max(1_000, Number(groupTtlMs) || DEFAULT_LONG_TTL_MS)
    this.settingTtlMs = Math.max(1_000, Number(settingTtlMs) || DEFAULT_SHORT_TTL_MS)
    this.poolAccessTtlMs = Math.max(1_000, Number(poolAccessTtlMs) || DEFAULT_SHORT_TTL_MS)
    this.vmOwnerTtlMs = Math.max(1_000, Number(vmOwnerTtlMs) || DEFAULT_LONG_TTL_MS)
    this.namesTtlMs = Math.max(1_000, Number(namesTtlMs) || DEFAULT_LONG_TTL_MS)
    this.l1TtlMs = Math.max(1_000, Number(l1TtlMs) || DEFAULT_L1_CAP_MS)
  }

  async _getOrLoadWrapped(key, loader, { ttlMs, l1TtlMs = this.l1TtlMs, prefixes, bypass = false } = {}) {
    if (bypass || !this.cache?.enabled) {
      return typeof loader === 'function' ? loader() : null
    }
    if (typeof loader !== 'function') {
      const hit = await this.cache.get(key, { prefixes, maxL1TtlMs: Math.min(ttlMs, l1TtlMs) })
      return hit.hit ? unwrapValue(hit.value) : null
    }
    const env = await this.cache.getOrLoad(key, async () => wrapValue(await loader()), {
      ttlMs,
      l1TtlMs: Math.min(ttlMs, l1TtlMs),
      jitter: true,
      prefixes,
      maxL1TtlMs: Math.min(ttlMs, l1TtlMs),
    })
    return unwrapValue(env)
  }

  _getOrLoadWrappedSync(key, loader, { ttlMs, l1TtlMs = this.l1TtlMs, prefixes, bypass = false } = {}) {
    if (bypass || !this.cache?.enabled) {
      return typeof loader === 'function' ? loader() : null
    }
    const l1 = this.cache.getL1(key)
    if (l1.hit) return unwrapValue(l1.value)
    if (typeof loader !== 'function') return null
    const val = loader()
    const wrapped = wrapValue(val)
    const effectiveL1 = Math.min(ttlMs, l1TtlMs)
    this.cache.setL1(key, wrapped, effectiveL1, 0, true)
    if (this.cache.hasRedis) {
      this.cache.set(key, wrapped, { ttlMs, l1TtlMs: effectiveL1, jitter: true, prefixes }).catch(() => {})
    }
    return val
  }

  // ---- Panel Users (by id / username) ----

  async getPanelUserById(userId, loader, opts = {}) {
    if (!userId) return null
    return this._getOrLoadWrapped(`${USER_ID_PREFIX}${String(userId)}`, loader, {
      ttlMs: opts.ttlMs ?? this.userTtlMs,
      prefixes: [DOMAIN_PREFIX, USER_PREFIX, USER_ID_PREFIX],
      bypass: opts.bypass,
    })
  }

  getPanelUserByIdSync(userId, loader, opts = {}) {
    if (!userId) return null
    return this._getOrLoadWrappedSync(`${USER_ID_PREFIX}${String(userId)}`, loader, {
      ttlMs: opts.ttlMs ?? this.userTtlMs,
      prefixes: [DOMAIN_PREFIX, USER_PREFIX, USER_ID_PREFIX],
      bypass: opts.bypass,
    })
  }

  async getPanelUserByUsername(username, loader, opts = {}) {
    const norm = normUsername(username)
    if (!norm) return null
    return this._getOrLoadWrapped(`${USER_NAME_PREFIX}${norm}`, loader, {
      ttlMs: opts.ttlMs ?? this.userTtlMs,
      prefixes: [DOMAIN_PREFIX, USER_PREFIX, USER_NAME_PREFIX],
      bypass: opts.bypass,
    })
  }

  getPanelUserByUsernameSync(username, loader, opts = {}) {
    const norm = normUsername(username)
    if (!norm) return null
    return this._getOrLoadWrappedSync(`${USER_NAME_PREFIX}${norm}`, loader, {
      ttlMs: opts.ttlMs ?? this.userTtlMs,
      prefixes: [DOMAIN_PREFIX, USER_PREFIX, USER_NAME_PREFIX],
      bypass: opts.bypass,
    })
  }

  /** Convenience dispatcher accepting `{ id }` or `{ username }`. */
  async panelUser({ id = null, username = null } = {}, loader, opts = {}) {
    if (id) return this.getPanelUserById(id, loader, opts)
    if (username) return this.getPanelUserByUsername(username, loader, opts)
    return null
  }

  async invalidateUser({ id = null, username = null } = {}) {
    if (!this.cache) return
    const keys = []
    if (id) keys.push(`${USER_ID_PREFIX}${String(id)}`)
    const norm = normUsername(username)
    if (norm) keys.push(`${USER_NAME_PREFIX}${norm}`)
    if (keys.length) {
      await this.cache.invalidate({ keys })
    } else {
      await this.invalidateUsers()
    }
  }

  async invalidateUsers() {
    if (!this.cache) return
    await this.cache.invalidate({ prefixes: [USER_PREFIX] })
  }

  // ---- Group Rate Multiplier ----

  _parseRateMultiplier(raw) {
    if (raw == null || raw === '') return 1
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : 1
  }

  async getGroupRateMultiplier(groupId, loader, opts = {}) {
    if (groupId == null || groupId === '') return 1
    const val = await this._getOrLoadWrapped(
      `${GROUP_RATE_PREFIX}${String(groupId)}`,
      async () => {
        const raw = typeof loader === 'function' ? await loader() : 1
        return this._parseRateMultiplier(raw)
      },
      {
        ttlMs: opts.ttlMs ?? this.groupTtlMs,
        l1TtlMs: Math.min(opts.ttlMs ?? this.groupTtlMs, 30_000),
        prefixes: [DOMAIN_PREFIX, GROUP_PREFIX, GROUP_RATE_PREFIX],
        bypass: opts.bypass,
      },
    )
    return this._parseRateMultiplier(val)
  }

  getGroupRateMultiplierSync(groupId, loader, opts = {}) {
    if (groupId == null || groupId === '') return 1
    const val = this._getOrLoadWrappedSync(
      `${GROUP_RATE_PREFIX}${String(groupId)}`,
      () => {
        const raw = typeof loader === 'function' ? loader() : 1
        return this._parseRateMultiplier(raw)
      },
      {
        ttlMs: opts.ttlMs ?? this.groupTtlMs,
        l1TtlMs: Math.min(opts.ttlMs ?? this.groupTtlMs, 30_000),
        prefixes: [DOMAIN_PREFIX, GROUP_PREFIX, GROUP_RATE_PREFIX],
        bypass: opts.bypass,
      },
    )
    return this._parseRateMultiplier(val)
  }

  groupRateMultiplier(groupId, loader, opts = {}) {
    return this.getGroupRateMultiplier(groupId, loader, opts)
  }

  async invalidateGroup(groupId) {
    if (!this.cache) return
    if (groupId == null || groupId === '') {
      await this.invalidateGroups()
      return
    }
    await this.cache.invalidate({ keys: [`${GROUP_RATE_PREFIX}${String(groupId)}`] })
  }

  async invalidateGroups() {
    if (!this.cache) return
    await this.cache.invalidate({ prefixes: [GROUP_PREFIX] })
  }

  // ---- Settings ----

  async getSetting(settingKey, loader, opts = {}) {
    if (!settingKey) return null
    return this._getOrLoadWrapped(`${SETTING_PREFIX}${String(settingKey)}`, loader, {
      ttlMs: opts.ttlMs ?? this.settingTtlMs,
      prefixes: [DOMAIN_PREFIX, SETTING_PREFIX],
      bypass: opts.bypass,
    })
  }

  getSettingSync(settingKey, loader, opts = {}) {
    if (!settingKey) return null
    return this._getOrLoadWrappedSync(`${SETTING_PREFIX}${String(settingKey)}`, loader, {
      ttlMs: opts.ttlMs ?? this.settingTtlMs,
      prefixes: [DOMAIN_PREFIX, SETTING_PREFIX],
      bypass: opts.bypass,
    })
  }

  setting(settingKey, loader, opts = {}) {
    return this.getSetting(settingKey, loader, opts)
  }

  async invalidateSetting(settingKey) {
    if (!this.cache) return
    if (!settingKey) {
      await this.invalidateSettings()
      return
    }
    await this.cache.invalidate({ keys: [`${SETTING_PREFIX}${String(settingKey)}`] })
  }

  async invalidateSettings() {
    if (!this.cache) return
    await this.cache.invalidate({ prefixes: [SETTING_PREFIX] })
  }

  // ---- Scheduler Pool Access (per API key) ----

  async getPoolAccess(apiKeyId, loader, opts = {}) {
    if (!apiKeyId) return null
    return this._getOrLoadWrapped(`${POOL_ACCESS_PREFIX}${String(apiKeyId)}`, loader, {
      ttlMs: opts.ttlMs ?? this.poolAccessTtlMs,
      prefixes: [DOMAIN_PREFIX, POOL_PREFIX, POOL_ACCESS_PREFIX],
      bypass: opts.bypass,
    })
  }

  getPoolAccessSync(apiKeyId, loader, opts = {}) {
    if (!apiKeyId) return null
    return this._getOrLoadWrappedSync(`${POOL_ACCESS_PREFIX}${String(apiKeyId)}`, loader, {
      ttlMs: opts.ttlMs ?? this.poolAccessTtlMs,
      prefixes: [DOMAIN_PREFIX, POOL_PREFIX, POOL_ACCESS_PREFIX],
      bypass: opts.bypass,
    })
  }

  poolAccess(apiKeyId, loader, opts = {}) {
    return this.getPoolAccess(apiKeyId, loader, opts)
  }

  async invalidatePoolAccess(apiKeyId = null) {
    if (!this.cache) return
    if (apiKeyId) {
      await this.cache.invalidate({ keys: [`${POOL_ACCESS_PREFIX}${String(apiKeyId)}`] })
    } else {
      await this.cache.invalidate({ prefixes: [POOL_ACCESS_PREFIX] })
    }
  }

  // ---- VM Owner ----

  async getVmOwner(vmId, loader, opts = {}) {
    if (!vmId) return null
    return this._getOrLoadWrapped(`${VM_OWNER_PREFIX}${String(vmId)}`, loader, {
      ttlMs: opts.ttlMs ?? this.vmOwnerTtlMs,
      l1TtlMs: Math.min(opts.ttlMs ?? this.vmOwnerTtlMs, 30_000),
      prefixes: [DOMAIN_PREFIX, VM_PREFIX, VM_OWNER_PREFIX],
      bypass: opts.bypass,
    })
  }

  getVmOwnerSync(vmId, loader, opts = {}) {
    if (!vmId) return null
    return this._getOrLoadWrappedSync(`${VM_OWNER_PREFIX}${String(vmId)}`, loader, {
      ttlMs: opts.ttlMs ?? this.vmOwnerTtlMs,
      l1TtlMs: Math.min(opts.ttlMs ?? this.vmOwnerTtlMs, 30_000),
      prefixes: [DOMAIN_PREFIX, VM_PREFIX, VM_OWNER_PREFIX],
      bypass: opts.bypass,
    })
  }

  vmOwner(vmId, loader, opts = {}) {
    return this.getVmOwner(vmId, loader, opts)
  }

  async invalidateVmOwner(vmId) {
    if (!this.cache) return
    if (!vmId) {
      await this.invalidateVmOwners()
      return
    }
    await this.cache.invalidate({ keys: [`${VM_OWNER_PREFIX}${String(vmId)}`] })
  }

  async invalidateVmOwners() {
    if (!this.cache) return
    await this.cache.invalidate({ prefixes: [VM_OWNER_PREFIX] })
  }

  // ---- Batched Entity Display Names (`users` | `api_keys` | `vms` | `accounts`) ----

  _ingestLoadedNames(loaded, tablePrefix, prefixes, result, ttlMs, l1TtlMs) {
    if (!loaded) return []
    const entries = loaded instanceof Map ? [...loaded.entries()] : Object.entries(loaded)
    const toPersist = []
    for (const [rawId, rawName] of entries) {
      if (rawId == null || rawName == null) continue
      const id = String(rawId)
      const name = String(rawName)
      result.set(id, name)
      const key = `${tablePrefix}${id}`
      const wrapped = wrapValue(name)
      this.cache?.setL1(key, wrapped, l1TtlMs, 0, true)
      toPersist.push([key, wrapped])
    }
    return toPersist
  }

  async _persistNamesBatchToRedis(items, prefixes, ttlMs) {
    if (!this.cache?.hasRedis || !items.length) return
    try {
      const resolved = await Promise.all(
        items.map(async ([key, wrapped]) => [await this.cache.resolveRedisKey(key, prefixes), wrapped]),
      )
      const pipe = this.cache.redis.pipeline()
      for (const [rKey, wrapped] of resolved) {
        const effTtl = this.cache._applyJitter(ttlMs, 0, true)
        if (effTtl > 0) pipe.set(rKey, JSON.stringify(wrapped), 'PX', effTtl)
      }
      await pipe.exec()
    } catch {
      this.cache.l2Errors += 1
    }
  }

  /**
   * Batch-resolve display names for `table` (`users` | `api_keys` | `vms` | `accounts`).
   * Checks L1 -> Redis L2 MGET -> calls `batchLoader(missingIds)` ONLY for misses ->
   * backfills L1 and Redis L2 in one pipeline.
   *
   * @param {string} table
   * @param {Array<string|number>} ids
   * @param {(missingIds: string[]) => Promise<Map<string,string>|Record<string,string>> | Map<string,string> | Record<string,string>} [batchLoader]
   * @returns {Promise<Map<string, string>>}
   */
  async getEntityNames(table, ids, batchLoader = null, { ttlMs = this.namesTtlMs, bypass = false } = {}) {
    const result = new Map()
    const cleanTable = String(table || '')
      .trim()
      .toLowerCase()
    const list = uniqueCleanIds(ids)
    if (!cleanTable || !list.length) return result

    if (bypass || !this.cache?.enabled) {
      if (typeof batchLoader === 'function') {
        const loaded = await batchLoader(list)
        if (loaded instanceof Map) {
          for (const [k, v] of loaded) if (v != null) result.set(String(k), String(v))
        } else if (loaded && typeof loaded === 'object') {
          for (const [k, v] of Object.entries(loaded)) if (v != null) result.set(String(k), String(v))
        }
      }
      return result
    }

    const tablePrefix = `${NAMES_PREFIX}${cleanTable}:`
    const prefixes = [DOMAIN_PREFIX, NAMES_PREFIX, tablePrefix]
    const l1Cap = Math.min(ttlMs, Math.max(this.l1TtlMs, 30_000))

    // 1. L1 pass
    const missingL1 = []
    for (const id of list) {
      const hit = this.cache.getL1(`${tablePrefix}${id}`)
      if (hit.hit) {
        const val = unwrapValue(hit.value)
        if (val != null) result.set(id, String(val))
      } else {
        missingL1.push(id)
      }
    }
    if (!missingL1.length) return result

    // 2. Redis L2 batched MGET pass
    let missingL2 = missingL1
    if (this.cache.hasRedis) {
      const l2Keys = missingL1.map((id) => `${tablePrefix}${id}`)
      const l2Vals = await this.cache.mget(l2Keys, { prefixes })
      if (Array.isArray(l2Vals)) {
        missingL2 = []
        for (let i = 0; i < missingL1.length; i += 1) {
          const id = missingL1[i]
          const raw = l2Vals[i]
          if (raw != null) {
            const val = unwrapValue(raw)
            if (val != null) {
              result.set(id, String(val))
              this.cache.setL1(l2Keys[i], wrapValue(String(val)), l1Cap, 0, true)
              continue
            }
          }
          missingL2.push(id)
        }
      }
    }
    if (!missingL2.length || typeof batchLoader !== 'function') return result

    // 3. Minimal DB backfill for remaining misses
    const loaded = await batchLoader(missingL2)
    const toPersist = this._ingestLoadedNames(loaded, tablePrefix, prefixes, result, ttlMs, l1Cap)
    if (toPersist.length && this.cache.hasRedis) {
      await this._persistNamesBatchToRedis(toPersist, prefixes, ttlMs)
    }
    return result
  }

  /** Alias for `getEntityNames(table, ids, batchLoader, opts)`. */
  entityNames(table, ids, batchLoader = null, opts = {}) {
    return this.getEntityNames(table, ids, batchLoader, opts)
  }

  /** Synchronous L1-first batch name resolver (for sync repos; backfills L2 asynchronously). */
  getEntityNamesSync(table, ids, batchLoader = null, { ttlMs = this.namesTtlMs, bypass = false } = {}) {
    const result = new Map()
    const cleanTable = String(table || '')
      .trim()
      .toLowerCase()
    const list = uniqueCleanIds(ids)
    if (!cleanTable || !list.length) return result

    if (bypass || !this.cache?.enabled) {
      if (typeof batchLoader === 'function') {
        const loaded = batchLoader(list)
        if (loaded instanceof Map) {
          for (const [k, v] of loaded) if (v != null) result.set(String(k), String(v))
        } else if (loaded && typeof loaded === 'object') {
          for (const [k, v] of Object.entries(loaded)) if (v != null) result.set(String(k), String(v))
        }
      }
      return result
    }

    const tablePrefix = `${NAMES_PREFIX}${cleanTable}:`
    const prefixes = [DOMAIN_PREFIX, NAMES_PREFIX, tablePrefix]
    const l1Cap = Math.min(ttlMs, Math.max(this.l1TtlMs, 30_000))

    const missing = []
    for (const id of list) {
      const hit = this.cache.getL1(`${tablePrefix}${id}`)
      if (hit.hit) {
        const val = unwrapValue(hit.value)
        if (val != null) result.set(id, String(val))
      } else {
        missing.push(id)
      }
    }
    if (!missing.length || typeof batchLoader !== 'function') return result

    const loaded = batchLoader(missing)
    const toPersist = this._ingestLoadedNames(loaded, tablePrefix, prefixes, result, ttlMs, l1Cap)
    if (toPersist.length && this.cache.hasRedis) {
      this._persistNamesBatchToRedis(toPersist, prefixes, ttlMs).catch(() => {})
    }
    return result
  }

  async invalidateNames(table = null, ids = null) {
    if (!this.cache) return
    if (!table) {
      await this.cache.invalidate({ prefixes: [NAMES_PREFIX] })
      return
    }
    const cleanTable = String(table).trim().toLowerCase()
    const tablePrefix = `${NAMES_PREFIX}${cleanTable}:`
    const list = uniqueCleanIds(ids)
    if (list.length) {
      await this.cache.invalidate({ keys: list.map((id) => `${tablePrefix}${id}`) })
    } else {
      await this.cache.invalidate({ prefixes: [tablePrefix] })
    }
  }

  async invalidateAll() {
    if (!this.cache) return
    await this.cache.invalidate({ prefixes: [DOMAIN_PREFIX] })
  }
}
