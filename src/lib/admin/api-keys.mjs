/**
 * Multi-key API key store (SQLite-backed).
 *
 * Managed keys have a name, status, expiry, spend quota and windows, an RPM
 * limit, and a per-key concurrency limit.
 *
 * Master env key KIN_API_KEY is separate and unlimited.
 * Managed keys live in the `api_keys` table (see lib/db/).
 * Transient state (inflight concurrency, RPM buckets) stays in memory.
 *
 * Auth always goes through `key_hash` (HMAC). `key_secret` is a separate
 * at-rest copy of the plaintext — encrypted with KIN_DB_SECRET when set — so
 * the panel can re-reveal a key for copying after creation.
 */

import {
  keyScopeFromRecord,
  keyTierPolicyFromRecord,
  normalizeKeyScope,
  normalizeMultiTierKeyConfig,
} from './key-scope.mjs'
import { normalizeKeyAllowedModels, parseKeyAllowedModels } from './key-models.mjs'
import { VmPoolsRepo } from '../db/repos/vm-pools-repo.mjs'
import crypto from 'node:crypto'
import { DB_INSTANCE_ID, getDb, getPgPool, isDbOpen, resolveStoreDb, withTransaction } from '../db/database.mjs'
import { ApiKeysRepo } from '../db/repos/api-keys-repo.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { maybeEncrypt, maybeDecrypt } from '../db/secure.mjs'
import { calculateCost, normalizeUsage } from './pricing.mjs'
import { UsersRepo } from '../db/repos/users-repo.mjs'
import { getCacheRuntime, notifyDbTablesMutated } from '../cache/index.mjs'
import { ErrorType, makeError } from '../core/errors.mjs'

const KEY_PREFIX = 'sk-vm-'
const HASH_MARKER = 'hmac:'
const DEFAULT_USAGE_FLUSH_INTERVAL_MS = 1_500
const DEFAULT_USAGE_FLUSH_BATCH_SIZE = 200
const DEFAULT_USAGE_FLUSH_MAX_BATCHES_PER_TICK = 16
const USAGE_FLUSH_ERROR_LOG_THROTTLE_MS = 30_000
// USD spend windows open on the first spend recorded by ApiKeysRepo.
const RATE_WINDOWS = [
  { name: '5h', limit: 'rate_limit_5h', usage: 'usage_5h', start: 'window_5h_start', ms: 5 * 3600_000 },
  { name: '1d', limit: 'rate_limit_1d', usage: 'usage_1d', start: 'window_1d_start', ms: 24 * 3600_000 },
  { name: '7d', limit: 'rate_limit_7d', usage: 'usage_7d', start: 'window_7d_start', ms: 7 * 24 * 3600_000 },
]

function rollSpendWindow(rec, win, cost, nowMs, nowIsoStr) {
  const start = rec?.[win.start] ? Date.parse(rec[win.start]) : NaN
  if (!Number.isFinite(start) || nowMs - start >= win.ms) {
    return { usage: cost, start: nowIsoStr }
  }
  return { usage: (Number(rec[win.usage]) || 0) + cost, start: rec[win.start] }
}

function attachAuthProjection(rec, { owner = null, ownerLoaded = false, groupId = 1, groupRateMultiplier = 1 } = {}) {
  if (!rec) return rec
  const clone = { ...rec }
  Object.defineProperty(clone, '_authProjection', {
    value: {
      userId: rec.user_id ?? null,
      owner: owner || null,
      ownerLoaded: Boolean(ownerLoaded),
      ownerActive: !rec.user_id || (Boolean(owner) && owner.status === 'active'),
      ownerRole: owner?.role || null,
      ownerMaxConcurrency: owner?.role === 'admin' ? 0 : Number(owner?.concurrency) || 0,
      groupId: groupId ?? 1,
      groupRateMultiplier: Number.isFinite(Number(groupRateMultiplier)) ? Number(groupRateMultiplier) : 1,
    },
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return clone
}

/** A window is open while now - start < size; a closed one counts 0 until the next spend reopens it. */
function rateWindow(rec, win, now) {
  const limit = Number(rec[win.limit]) || 0
  const start = rec[win.start] ? Date.parse(rec[win.start]) : NaN
  const open = Number.isFinite(start) && now - start < win.ms
  return { limit, open, start, used: open ? Number(rec[win.usage]) || 0 : 0 }
}

// Six decimals is below any billed unit and hides float noise (8.300000000000001).
const money = (n) => Math.round(n * 1e6) / 1e6

/** 0 means unlimited: limit / remaining read null. */
function limitView(limit, used) {
  return {
    limit: limit > 0 ? limit : null,
    used: money(used),
    remaining: limit > 0 ? money(Math.max(0, limit - used)) : null,
    exceeded: limit > 0 && used >= limit,
  }
}

function clampInt(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.floor(v)))
}

function nowIso() {
  return new Date().toISOString()
}
function storedKeyScope(scope) {
  return {
    group_type: scope.group_type,
    allowed_vms: JSON.stringify(scope.allowed_vms),
    vm_pool_id: scope.vm_pool_id || null,
  }
}

export function generateApiKey(prefix = KEY_PREFIX) {
  return prefix + crypto.randomBytes(32).toString('hex')
}

export function maskApiKey(key) {
  const s = String(key || '')
  if (s.length <= 12) return s.slice(0, 4) + '…'
  return s.slice(0, 8) + '…' + s.slice(-4)
}

/**
 * Recoverable plaintext for a stored record, or null when only the hash is
 * left (keys created before `key_secret` existed).
 */
export function plainApiKey(rec) {
  if (!rec) return null
  if (rec._plain_key) return String(rec._plain_key)
  if (rec.key_secret) {
    try {
      const plain = maybeDecrypt(rec.key_secret)
      if (plain) return String(plain)
    } catch {
      return null
    }
  }
  if (rec.key && !String(rec.key).startsWith(HASH_MARKER)) return String(rec.key)
  return null
}

export function publicKeyView(rec, { reveal = false } = {}) {
  if (!rec) return null
  const plain = plainApiKey(rec)
  const masked = plain ? maskApiKey(plain) : `${rec.key_prefix || KEY_PREFIX}…${rec.key_suffix || 'hidden'}`
  return {
    id: rec.id,
    name: rec.name,
    key: reveal && plain ? plain : masked,
    revealable: !!plain,
    key_prefix: rec.key_prefix || String(plain || KEY_PREFIX).slice(0, 10),
    status: rec.status,
    user_id: rec.user_id ?? null,
    group_id: rec.group_id ?? null,
    max_concurrency: rec.max_concurrency,
    quota_requests: rec.quota_requests,
    // panel view keeps the historical name: quota_used = request count
    quota_used: rec.quota_requests_used ?? 0,
    quota_usd: rec.quota ?? 0,
    quota_usd_used: rec.quota_used ?? 0,
    rate_limit_5h: rec.rate_limit_5h ?? 0,
    rate_limit_1d: rec.rate_limit_1d ?? 0,
    rate_limit_7d: rec.rate_limit_7d ?? 0,
    usage_5h: rec.usage_5h ?? 0,
    usage_1d: rec.usage_1d ?? 0,
    usage_7d: rec.usage_7d ?? 0,
    rpm: rec.rpm,
    expires_at: rec.expires_at,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    last_used_at: rec.last_used_at,
    requests: rec.requests || 0,
    tokens_in: rec.tokens_in || 0,
    tokens_out: rec.tokens_out || 0,
    category: rec.category === 'api' ? 'api' : rec.category === 'all' ? 'all' : 'oauth',
    api_endpoint_id: rec.category === 'api' || rec.category === 'all' ? (rec.api_endpoint_id ?? null) : null,
    permission_tier: keyTierPolicyFromRecord(rec).permission_tier,
    owner_id: keyTierPolicyFromRecord(rec).owner_id,
    allowed_endpoints: keyTierPolicyFromRecord(rec).allowed_endpoints,
    allowed_gemini_envs: keyTierPolicyFromRecord(rec).allowed_gemini_envs,
    ...keyScopeFromRecord(rec),
    allowed_models: parseKeyAllowedModels(rec.allowed_models),
    inflight: undefined, // filled by store.snapshot
  }
}

function timingSafeEqualStr(a, b) {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  if (x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

export class ApiKeyStore {
  constructor({
    dataDir,
    db,
    hashSecret,
    writeBehindUsage,
    usageFlushIntervalMs = DEFAULT_USAGE_FLUSH_INTERVAL_MS,
    pgPool = null,
  } = {}) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new ApiKeysRepo(this.db)
    this.groups = new GroupsRepo(this.db)
    this.hashSecret = String(
      hashSecret ||
        process.env.VM2API_API_KEY_HASH_SECRET ||
        process.env.KIN_API_KEY_HASH_SECRET ||
        process.env.VM2API_DB_SECRET ||
        process.env.KIN_DB_SECRET ||
        process.env.VM2API_API_KEY ||
        process.env.KIN_API_KEY ||
        'kin-development-api-key-hash-secret',
    )
    this.inflight = new Map() // keyId → count
    this.userInflight = new Map() // userId → count (O(1), replaces repo.list() full scan)
    this.inflightOwner = new Map() // keyId → userId
    this._redisSlots = new Map() // keyId → Array<{ reqToken, userId, hasKeySlot, hasUserSlot }>
    this.rpmBuckets = new Map() // id → number[] timestamps ms
    this.users = new UsersRepo(this.db)
    this._explicitWriteBehind = typeof writeBehindUsage === 'boolean' ? writeBehindUsage : null
    this._usageFlushIntervalMs = Math.max(50, Number(usageFlushIntervalMs) || DEFAULT_USAGE_FLUSH_INTERVAL_MS)
    this._pgPool = pgPool || null
    this._usageTimer = null
    this._usageFlusherActive = false
    this._usageTickInFlight = false
    this._usageFlushFailures = 0
    this._lastUsageFlushError = null
    this._lastUsageFlushErrorAt = 0
    this._lastUsageFlushWarnAt = 0
    this._flushChain = Promise.resolve()
    this._keySnapshots = new Map() // keyId → latest known record snapshot
    this._pendingUsage = new Map() // keyId → local unflushed delta overlay
    this._batchUpdateStmt = null
    this._prepareBatchUpdate()
  }

  _prepareBatchUpdate() {
    try {
      this._batchUpdateStmt = this.db.prepare(`
        UPDATE api_keys SET
          requests = COALESCE(requests, 0) + ?,
          quota_requests_used = COALESCE(quota_requests_used, 0) + ?,
          tokens_in = COALESCE(tokens_in, 0) + ?,
          tokens_out = COALESCE(tokens_out, 0) + ?,
          cache_read_tokens = COALESCE(cache_read_tokens, 0) + ?,
          cache_creation_tokens = COALESCE(cache_creation_tokens, 0) + ?,
          quota_used = COALESCE(quota_used, 0) + ?,
          usage_5h = ?, window_5h_start = ?,
          usage_1d = ?, window_1d_start = ?,
          usage_7d = ?, window_7d_start = ?,
          status = ?,
          last_used_at = ?,
          updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `)
    } catch {
      this._batchUpdateStmt = null
    }
  }

  _isPrimaryDb() {
    return isDbOpen() && this.db === getDb()
  }

  _entityScopeKey(id) {
    if (this._isPrimaryDb()) return String(id)
    return `${this.db?.[DB_INSTANCE_ID] || 'isolated'}:${id}`
  }

  _resolvePgPool() {
    if (this._pgPool) return this._pgPool
    if (this.db?.engine === 'postgres') return getPgPool()
    return null
  }

  _isWriteBehindUsageEnabled() {
    if (this._explicitWriteBehind !== null) return this._explicitWriteBehind
    return this._usageFlusherActive || this.db?.engine === 'postgres' || getCacheRuntime().client.hasRedis
  }

  _ensureUsageFlusherStarted() {
    if (this._usageTimer) return
    if (!this._isWriteBehindUsageEnabled()) return
    this.startUsageFlusher(this._usageFlushIntervalMs)
  }

  startUsageFlusher(intervalMs = this._usageFlushIntervalMs) {
    const ms = Math.max(50, Number(intervalMs) || DEFAULT_USAGE_FLUSH_INTERVAL_MS)
    this._usageFlushIntervalMs = ms
    this._usageFlusherActive = true
    if (this._usageTimer) return
    this._usageTimer = setInterval(() => {
      this._drainUsageTick().catch(() => {})
    }, ms)
    if (typeof this._usageTimer.unref === 'function') this._usageTimer.unref()
  }

  async _drainUsageTick(maxBatches = DEFAULT_USAGE_FLUSH_MAX_BATCHES_PER_TICK) {
    if (this._usageTickInFlight) return 0
    this._usageTickInFlight = true
    let totalFlushed = 0
    try {
      const limit = Math.max(1, Number(maxBatches) || DEFAULT_USAGE_FLUSH_MAX_BATCHES_PER_TICK)
      for (let i = 0; i < limit; i += 1) {
        const res = await this.flushPendingUsage(DEFAULT_USAGE_FLUSH_BATCH_SIZE)
        totalFlushed += res.flushed
        if (res.flushed === 0 || res.failed > 0) break
      }
    } finally {
      this._usageTickInFlight = false
    }
    return totalFlushed
  }

  usageFlushStats() {
    return {
      failures: this._usageFlushFailures,
      lastError: this._lastUsageFlushError,
      lastErrorAt: this._lastUsageFlushErrorAt || null,
    }
  }

  stopUsageFlusher() {
    if (this._usageTimer) {
      clearInterval(this._usageTimer)
      this._usageTimer = null
    }
    this._usageFlusherActive = false
  }

  _loadOwnerSync(userId) {
    if (!userId) return null
    try {
      const cache = getCacheRuntime()
      if (cache?.client?.enabled) {
        return cache.entity.getPanelUserByIdSync(this._entityScopeKey(userId), () => this.users.getById(userId))
      }
      return this.users.getById(userId)
    } catch {
      return null
    }
  }

  async _loadOwnerAsync(userId) {
    if (!userId) return null
    try {
      const cache = getCacheRuntime()
      if (cache?.client?.enabled) {
        return await cache.entity.getPanelUserById(this._entityScopeKey(userId), () => this.users.getById(userId))
      }
      return this.users.getById(userId)
    } catch {
      return null
    }
  }

  _loadGroupRateSync(groupId) {
    try {
      return this.groups.rateMultiplier(groupId ?? 1)
    } catch {
      return 1
    }
  }

  async _loadGroupRateAsync(groupId) {
    try {
      return await this.groups.rateMultiplierAsync(groupId ?? 1)
    } catch {
      return 1
    }
  }

  /** Keys owned by disabled or deleted users cannot authenticate. */
  _ownerActive(rec) {
    if (!rec?.user_id) return true // legacy unowned keys keep working
    const owner = this._loadOwnerSync(rec.user_id)
    // soft-deleted owner is invisible here → key is revoked with them
    return !!owner && owner.status === 'active'
  }

  _overlayDbRecord(rec) {
    if (!rec) return null
    const pending = this._pendingUsage.get(rec.id)
    if (!pending) return rec
    const merged = {
      ...rec,
      requests: (Number(rec.requests) || 0) + (pending.requests || 0),
      quota_requests_used: (Number(rec.quota_requests_used) || 0) + (pending.quota_requests_used || 0),
      tokens_in: (Number(rec.tokens_in) || 0) + (pending.tokens_in || 0),
      tokens_out: (Number(rec.tokens_out) || 0) + (pending.tokens_out || 0),
      cache_read_tokens: (Number(rec.cache_read_tokens) || 0) + (pending.cache_read_tokens || 0),
      cache_creation_tokens: (Number(rec.cache_creation_tokens) || 0) + (pending.cache_creation_tokens || 0),
      quota_used: (Number(rec.quota_used) || 0) + (pending.cost || 0),
    }
    if (pending.last_used_at && (!merged.last_used_at || pending.last_used_at > merged.last_used_at)) {
      merged.last_used_at = pending.last_used_at
    }
    if (pending.windows) {
      for (const win of RATE_WINDOWS) {
        const w = pending.windows[win.name]
        if (w) {
          merged[win.usage] = w.usage
          merged[win.start] = w.start
        }
      }
    }
    if (merged.status === 'active' && (merged.quota ?? 0) > 0 && (merged.quota_used ?? 0) >= merged.quota) {
      merged.status = 'quota_exhausted'
    }
    return merged
  }

  _mergePendingSnapshot(rec) {
    if (!rec) return null
    if (!this._pendingUsage.has(rec.id)) return rec
    const snap = this._keySnapshots.get(rec.id)
    if (!snap) return this._overlayDbRecord(rec)
    const out = { ...rec }
    if ((Number(snap.requests) || 0) > (Number(out.requests) || 0)) out.requests = snap.requests
    if ((Number(snap.quota_requests_used) || 0) > (Number(out.quota_requests_used) || 0)) {
      out.quota_requests_used = snap.quota_requests_used
    }
    if ((Number(snap.tokens_in) || 0) > (Number(out.tokens_in) || 0)) out.tokens_in = snap.tokens_in
    if ((Number(snap.tokens_out) || 0) > (Number(out.tokens_out) || 0)) out.tokens_out = snap.tokens_out
    if ((Number(snap.cache_read_tokens) || 0) > (Number(out.cache_read_tokens) || 0)) {
      out.cache_read_tokens = snap.cache_read_tokens
    }
    if ((Number(snap.cache_creation_tokens) || 0) > (Number(out.cache_creation_tokens) || 0)) {
      out.cache_creation_tokens = snap.cache_creation_tokens
    }
    if ((Number(snap.quota_used) || 0) > (Number(out.quota_used) || 0)) out.quota_used = snap.quota_used
    if (snap.last_used_at && (!out.last_used_at || snap.last_used_at > out.last_used_at)) {
      out.last_used_at = snap.last_used_at
    }
    for (const win of RATE_WINDOWS) {
      if (snap[win.start] && (!out[win.start] || snap[win.start] >= out[win.start])) {
        if (
          snap[win.start] > (out[win.start] || '') ||
          (Number(snap[win.usage]) || 0) > (Number(out[win.usage]) || 0)
        ) {
          out[win.start] = snap[win.start]
          out[win.usage] = snap[win.usage]
        }
      }
    }
    if (out.status === 'active' && (out.quota ?? 0) > 0 && (out.quota_used ?? 0) >= out.quota) {
      out.status = 'quota_exhausted'
    }
    return out
  }

  /** Re-read from DB and clear cached auth entries. */
  reload() {
    this._keySnapshots.clear()
    getCacheRuntime()
      .apiKeys.invalidateAll()
      .catch(() => {})
  }

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    this.db = db
    this.repo = new ApiKeysRepo(db)
    this.groups = new GroupsRepo(db)
    this.users = new UsersRepo(db)
    this._keySnapshots.clear()
    this._pendingUsage.clear()
    this._prepareBatchUpdate()
    getCacheRuntime()
      .apiKeys.invalidateAll()
      .catch(() => {})
  }

  _cacheKey(hash) {
    if (!hash) return ''
    if (this._isPrimaryDb()) return hash
    return `${this.db?.[DB_INSTANCE_ID] || 'isolated'}:${hash}`
  }

  _invalidateHash(hash, reason = 'updated') {
    const ck = this._cacheKey(hash)
    if (ck)
      getCacheRuntime()
        .apiKeys.invalidateHash(ck, reason)
        .catch(() => {})
  }

  list({ reveal = false } = {}) {
    const names = new Map()
    try {
      for (const pool of new VmPoolsRepo(this.db).list()) names.set(pool.id, pool.name)
    } catch {
      // A database opened before migration 034 still lists keys.
    }
    return this.repo.list().map((raw) => {
      const k = this._overlayDbRecord(raw)
      const v = publicKeyView(k, { reveal })
      v.inflight = this.inflight.get(k.id) || 0
      if (v.vm_pool_id) v.vm_pool_name = names.get(v.vm_pool_id) || null
      return v
    })
  }

  getById(id) {
    return this._overlayDbRecord(this.repo.getById(id))
  }

  _loadByTokenOrHash(token, hash) {
    const indexed = this.repo.getByHash(hash)
    if (indexed) return this._overlayDbRecord(indexed)
    // One-time migration for legacy plaintext rows.
    for (const rec of this.repo.list()) {
      if (String(rec.key || '').startsWith(HASH_MARKER)) continue
      if (timingSafeEqualStr(token, rec.key)) {
        rec.key_hash = hash
        rec.key_prefix = String(token).slice(0, 10)
        rec.key_suffix = String(token).slice(-4)
        rec.key_secret = maybeEncrypt(token)
        rec.key = HASH_MARKER + hash
        const updated = this.repo.update(rec)
        return this._overlayDbRecord(updated)
      }
    }
    return null
  }

  authenticate(token) {
    if (!token) return { ok: false, reason: 'missing' }
    const hash = this._hash(token)
    const cacheKey = this._cacheKey(hash)
    const apiKeyCache = getCacheRuntime().apiKeys
    let rec = null
    const cached = apiKeyCache.getSync(cacheKey)
    if (cached.hit) {
      if (!cached.value) return { ok: false, reason: 'invalid' }
      rec = this._mergePendingSnapshot(cached.value)
    } else {
      rec = this._loadByTokenOrHash(token, hash)
      apiKeyCache.putSync(cacheKey, rec)
      if (!rec) return { ok: false, reason: 'invalid' }
    }
    const owner = rec.user_id ? this._loadOwnerSync(rec.user_id) : null
    if (rec.user_id && (!owner || owner.status !== 'active')) {
      return { ok: false, reason: 'user_disabled' }
    }
    const groupRate = this._loadGroupRateSync(rec.group_id)
    this._keySnapshots.set(rec.id, rec)
    return {
      ok: true,
      record: attachAuthProjection(rec, {
        owner,
        ownerLoaded: Boolean(rec.user_id),
        groupId: rec.group_id ?? 1,
        groupRateMultiplier: groupRate,
      }),
    }
  }

  /**
   * Async L1 + Redis L2 authentication with bounded 30s L1 negative caching
   * and owner/group projection via EntityCache.
   */
  async authenticateAsync(token) {
    if (!token) return { ok: false, reason: 'missing' }
    const hash = this._hash(token)
    const cacheKey = this._cacheKey(hash)
    const apiKeyCache = getCacheRuntime().apiKeys
    const rawRec = await apiKeyCache.get(cacheKey, () => this._loadByTokenOrHash(token, hash))
    if (!rawRec) return { ok: false, reason: 'invalid' }
    const rec = this._mergePendingSnapshot(rawRec)
    const owner = rec.user_id ? await this._loadOwnerAsync(rec.user_id) : null
    if (rec.user_id && (!owner || owner.status !== 'active')) {
      return { ok: false, reason: 'user_disabled' }
    }
    const groupRate = await this._loadGroupRateAsync(rec.group_id)
    this._keySnapshots.set(rec.id, rec)
    return {
      ok: true,
      record: attachAuthProjection(rec, {
        owner,
        ownerLoaded: Boolean(rec.user_id),
        groupId: rec.group_id ?? 1,
        groupRateMultiplier: groupRate,
      }),
    }
  }

  create(input = {}) {
    const name =
      String(input.name || 'default')
        .trim()
        .slice(0, 100) || 'default'
    let key = input.key ? String(input.key).trim() : generateApiKey()
    if (key.length < 16) throw Object.assign(new Error('key too short'), { code: 'key_too_short' })
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw Object.assign(new Error('key has invalid characters'), { code: 'key_invalid' })
    }
    const keyHash = this._hash(key)
    if (this.repo.getByHash(keyHash) || this.repo.getByKey(key)) {
      throw Object.assign(new Error('key already exists'), { code: 'key_exists' })
    }

    const multiTier = normalizeMultiTierKeyConfig(input, { partial: false })
    const category = multiTier.category
    const rec = {
      id: 'key_' + crypto.randomBytes(6).toString('hex'),
      name,
      key: HASH_MARKER + keyHash,
      key_hash: keyHash,
      key_prefix: key.slice(0, 10),
      key_suffix: key.slice(-4),
      key_secret: maybeEncrypt(key),
      status: 'active',
      max_concurrency: clampInt(input.max_concurrency, 0, 128, input.default_concurrency ?? 20),
      quota_requests: clampInt(input.quota_requests, 0, 1e9, 0),
      quota_requests_used: 0,
      quota: Math.max(0, Number(input.quota) || 0),
      quota_used: 0,
      rate_limit_5h: Math.max(0, Number(input.rate_limit_5h) || 0),
      rate_limit_1d: Math.max(0, Number(input.rate_limit_1d) || 0),
      rate_limit_7d: Math.max(0, Number(input.rate_limit_7d) || 0),
      user_id: input.user_id ?? null,
      group_id: input.group_id ?? 1,
      rpm: clampInt(input.rpm, 0, 1e6, 0),
      expires_at: input.expires_at ? new Date(input.expires_at).toISOString() : null,
      created_at: nowIso(),
      updated_at: nowIso(),
      last_used_at: null,
      requests: 0,
      tokens_in: 0,
      tokens_out: 0,
      category,
      permission_tier: multiTier.permission_tier,
      owner_id: multiTier.owner_id,
      allowed_endpoints: JSON.stringify(multiTier.allowed_endpoints),
      allowed_gemini_envs: JSON.stringify(multiTier.allowed_gemini_envs),
      ...storedKeyScope(
        normalizeKeyScope(
          {
            group_type: input.group_type,
            allowed_vms: input.allowed_vms,
            category,
            permission_tier: multiTier.permission_tier,
            owner_id: multiTier.owner_id,
            ...(Object.prototype.hasOwnProperty.call(input, 'vm_pool_id') ? { vm_pool_id: input.vm_pool_id } : {}),
          },
          { isApi: category === 'api' },
        ),
      ),
      api_endpoint_id: category === 'api' || category === 'all' ? (input.api_endpoint_id ?? null) : null,
      allowed_models: JSON.stringify(normalizeKeyAllowedModels(input.allowed_models)),
    }
    if (rec.expires_at && Number.isNaN(Date.parse(rec.expires_at))) {
      throw Object.assign(new Error('invalid expires_at'), { code: 'invalid_expires_at' })
    }
    const stored = this.repo.insert(rec)
    this._invalidateHash(keyHash, 'created')
    return { ...stored, key, _plain_key: key }
  }

  update(id, patch = {}) {
    const rec = this.repo.getById(id)
    if (!rec) return null
    if (patch.name != null) rec.name = String(patch.name).trim().slice(0, 100) || rec.name
    if (patch.status != null) {
      const st = String(patch.status).toLowerCase()
      if (!['active', 'disabled'].includes(st)) {
        throw Object.assign(new Error('invalid status'), { code: 'invalid_status' })
      }
      rec.status = st
    }
    if (patch.max_concurrency != null)
      rec.max_concurrency = clampInt(patch.max_concurrency, 0, 128, rec.max_concurrency)
    if (patch.quota_requests != null) rec.quota_requests = clampInt(patch.quota_requests, 0, 1e9, rec.quota_requests)
    if (patch.quota != null) rec.quota = Math.max(0, Number(patch.quota) || 0)
    if (patch.rate_limit_5h != null) rec.rate_limit_5h = Math.max(0, Number(patch.rate_limit_5h) || 0)
    if (patch.rate_limit_1d != null) rec.rate_limit_1d = Math.max(0, Number(patch.rate_limit_1d) || 0)
    if (patch.rate_limit_7d != null) rec.rate_limit_7d = Math.max(0, Number(patch.rate_limit_7d) || 0)
    if (patch.group_id != null) rec.group_id = Number(patch.group_id) || 1
    if (patch.user_id != null) rec.user_id = patch.user_id
    if (patch.rpm != null) rec.rpm = clampInt(patch.rpm, 0, 1e6, rec.rpm)
    if (patch.expires_at === null) rec.expires_at = null
    else if (patch.expires_at != null) {
      const iso = new Date(patch.expires_at).toISOString()
      if (Number.isNaN(Date.parse(iso)))
        throw Object.assign(new Error('invalid expires_at'), { code: 'invalid_expires_at' })
      rec.expires_at = iso
    }
    if (patch.reset_quota === true) {
      rec.quota_requests_used = 0
      rec.quota_used = 0
      this._pendingUsage.delete(id)
    }
    // recover from quota_exhausted whenever spend is back under the cap
    if (
      rec.status === 'quota_exhausted' &&
      !((rec.quota ?? 0) > 0 && (rec.quota_used ?? 0) >= rec.quota) &&
      !(rec.quota_requests > 0 && (rec.quota_requests_used ?? 0) >= rec.quota_requests)
    ) {
      rec.status = 'active'
    }
    const multiTier = normalizeMultiTierKeyConfig(patch, { partial: true, current: rec })
    rec.category = multiTier.category
    rec.permission_tier = multiTier.permission_tier
    rec.owner_id = multiTier.owner_id
    rec.allowed_endpoints = JSON.stringify(multiTier.allowed_endpoints)
    rec.allowed_gemini_envs = JSON.stringify(multiTier.allowed_gemini_envs)
    if (rec.category !== 'api' && rec.category !== 'all') rec.api_endpoint_id = null
    else if (Object.hasOwn(patch, 'api_endpoint_id')) rec.api_endpoint_id = patch.api_endpoint_id ?? null
    const scope = normalizeKeyScope(
      { ...patch, category: rec.category, permission_tier: rec.permission_tier, owner_id: rec.owner_id },
      { partial: true, current: rec, isApi: rec.category === 'api' },
    )
    if (scope) Object.assign(rec, storedKeyScope(scope))
    if (Object.hasOwn(patch, 'allowed_models')) {
      rec.allowed_models = JSON.stringify(normalizeKeyAllowedModels(patch.allowed_models))
    }
    rec.updated_at = nowIso()
    const updated = this.repo.update(rec)
    this._keySnapshots.delete(id)
    this._invalidateHash(rec.key_hash, 'updated')
    if (
      patch.vm_pool_id !== undefined ||
      patch.group_type !== undefined ||
      patch.allowed_vms !== undefined ||
      patch.permission_tier !== undefined ||
      patch.owner_id !== undefined
    ) {
      getCacheRuntime()
        .entity.invalidatePoolAccess(id)
        .catch(() => {})
    }
    return this._overlayDbRecord(updated)
  }

  /**
   * Plaintext of a managed key for panel copy.
   * @returns {null | { ok: false, code: string } | { ok: true, id, name, key }}
   */
  reveal(id) {
    const rec = this.repo.getById(id)
    if (!rec) return null
    const key = plainApiKey(rec)
    if (!key) return { ok: false, code: 'key_not_recoverable' }
    return { ok: true, id: rec.id, name: rec.name, key }
  }

  /** Issue a fresh plaintext on the same record; the old value stops working. */
  rotate(id) {
    const rec = this.repo.getById(id)
    if (!rec) return null
    const key = generateApiKey()
    const keyHash = this._hash(key)
    if (this.repo.getByHash(keyHash)) {
      throw Object.assign(new Error('key already exists'), { code: 'key_exists' })
    }
    const prevHash = rec.key_hash
    rec.key = HASH_MARKER + keyHash
    rec.key_hash = keyHash
    rec.key_prefix = key.slice(0, 10)
    rec.key_suffix = key.slice(-4)
    rec.key_secret = maybeEncrypt(key)
    rec.updated_at = nowIso()
    const stored = this.repo.update(rec)
    this._keySnapshots.delete(id)
    this._invalidateHash(prevHash, 'rotated')
    this._invalidateHash(keyHash, 'rotated')
    return { ...stored, key, _plain_key: key }
  }

  remove(id) {
    const prev = this.repo.getById(id)
    const removed = this.repo.remove(id)
    if (!removed) return false
    const keyInflight = this.inflight.get(id) || 0
    const ownerId = prev?.user_id || this.inflightOwner.get(id) || null
    if (keyInflight > 0 && ownerId) {
      const rem = (this.userInflight.get(ownerId) || 0) - keyInflight
      if (rem <= 0) this.userInflight.delete(ownerId)
      else this.userInflight.set(ownerId, rem)
    }
    this.inflight.delete(id)
    this.inflightOwner.delete(id)
    const slots = this._redisSlots.get(id)
    if (slots?.length) {
      const conc = getCacheRuntime().concurrency
      for (const slot of slots) {
        if (slot.hasKeySlot) conc.releaseKey(id, slot.reqToken).catch(() => {})
        if (slot.hasUserSlot && slot.userId) conc.releaseUser(slot.userId, slot.reqToken).catch(() => {})
      }
      this._redisSlots.delete(id)
    }
    this.rpmBuckets.delete(id)
    this._keySnapshots.delete(id)
    this._pendingUsage.delete(id)
    if (prev?.key_hash) this._invalidateHash(prev.key_hash, 'removed')
    const cache = getCacheRuntime()
    cache.billing.invalidateApiKey(id).catch(() => {})
    cache.entity.invalidatePoolAccess(id).catch(() => {})
    return true
  }

  _expired(rec, now = Date.now()) {
    if (!rec.expires_at) return false
    return Date.parse(rec.expires_at) <= now
  }

  _rpmState(id, now = Date.now()) {
    const windowMs = 60_000
    let arr = this.rpmBuckets.get(id) || []
    arr = arr.filter((t) => now - t < windowMs)
    this.rpmBuckets.set(id, arr)
    return { count: arr.length, timestamps: arr }
  }

  _rpmCount(id, now = Date.now()) {
    return this._rpmState(id, now).count
  }

  _checkStaticAndQuotaLimits(rec, now = Date.now()) {
    if (!rec) return { ok: false, code: 'invalid_api_key', message: 'Invalid credentials', status: 401 }
    if (rec.status !== 'active') {
      if (rec.status === 'quota_exhausted') {
        const hasUsdQuota = (rec.quota ?? 0) > 0
        const hasReqQuota = (rec.quota_requests ?? 0) > 0
        const usdExhausted = hasUsdQuota && (rec.quota_used ?? 0) >= rec.quota
        if (!usdExhausted && hasReqQuota && (rec.quota_requests_used ?? 0) >= rec.quota_requests) {
          const current = Number(rec.quota_requests_used) || 0
          const limit = rec.quota_requests
          return {
            ok: false,
            code: 'api_key_quota_exhausted',
            message: 'API key quota exhausted',
            status: 429,
            limit_type: 'requests_quota',
            current,
            limit,
            remaining: 0,
            reset_at: null,
            retry_after: null,
            detail: { quota_requests: rec.quota_requests, quota_used: rec.quota_requests_used },
          }
        }
        const current = money(Number(rec.quota_used) || 0)
        const limit = hasUsdQuota ? rec.quota : null
        const remaining = limit != null ? money(Math.max(0, limit - current)) : 0
        return {
          ok: false,
          code: 'api_key_quota_exhausted',
          message: hasUsdQuota ? 'API key USD quota exhausted' : 'API key quota exhausted',
          status: 402,
          limit_type: 'usd_quota',
          current,
          limit,
          remaining,
          reset_at: null,
          retry_after: null,
          detail: hasUsdQuota ? { quota: rec.quota, quota_used: rec.quota_used } : undefined,
        }
      }
      return { ok: false, code: 'api_key_disabled', message: 'API key is disabled', status: 403 }
    }
    if (this._expired(rec, now)) {
      return { ok: false, code: 'api_key_expired', message: 'API key has expired', status: 403 }
    }
    if (rec.quota_requests > 0 && (rec.quota_requests_used ?? 0) >= rec.quota_requests) {
      const current = Number(rec.quota_requests_used) || 0
      const limit = rec.quota_requests
      return {
        ok: false,
        code: 'api_key_quota_exhausted',
        message: 'API key quota exhausted',
        status: 429,
        limit_type: 'requests_quota',
        current,
        limit,
        remaining: 0,
        reset_at: null,
        retry_after: null,
        detail: { quota_requests: rec.quota_requests, quota_used: rec.quota_requests_used },
      }
    }
    if ((rec.quota ?? 0) > 0 && (rec.quota_used ?? 0) >= rec.quota) {
      const current = money(Number(rec.quota_used) || 0)
      const limit = rec.quota
      return {
        ok: false,
        code: 'api_key_quota_exhausted',
        message: 'API key USD quota exhausted',
        status: 402,
        limit_type: 'usd_quota',
        current,
        limit,
        remaining: 0,
        reset_at: null,
        retry_after: null,
        detail: { quota: rec.quota, quota_used: rec.quota_used },
      }
    }
    // Enforce spend limits only for open windows with a positive limit.
    for (const win of RATE_WINDOWS) {
      const w = rateWindow(rec, win, now)
      if (w.limit > 0 && w.open && w.used >= w.limit) {
        const limitType = `spend_${win.name}`
        const current = money(w.used)
        const resetMs = w.start + win.ms
        const resetAt = new Date(resetMs).toISOString()
        const retryAfter = Math.max(1, Math.ceil((resetMs - now) / 1000))
        return {
          ok: false,
          code: 'api_key_rate_limit',
          message: `API key ${win.name} spend limit exceeded`,
          status: 402,
          limit_type: limitType,
          current,
          limit: w.limit,
          remaining: 0,
          reset_at: resetAt,
          retry_after: retryAfter,
          detail: { limit: w.limit, used: w.used },
        }
      }
    }
    return { ok: true }
  }

  /**
   * Pre-flight gate for a managed key. Does not acquire concurrency.
   * Monetary limits return 402; request-count, RPM, and concurrency limits return 429.
   * Over-limit verdicts include uniform `limit_type`, `current`, `limit`, `remaining`,
   * `reset_at`, and `retry_after` (seconds) while preserving legacy `detail` keys.
   * @returns {{ ok: true } | { ok: false, code, message, status, limit_type?, current?, limit?, remaining?, reset_at?, retry_after?, detail? }}
   */
  canAccept(rec, now = Date.now()) {
    const effective = this._mergePendingSnapshot(rec)
    const baseGate = this._checkStaticAndQuotaLimits(effective, now)
    if (!baseGate.ok) return baseGate
    if (effective.rpm > 0) {
      const { count: n, timestamps } = this._rpmState(effective.id, now)
      if (n >= effective.rpm) {
        const blockingTs = timestamps[Math.max(0, timestamps.length - effective.rpm)]
        const resetMs = blockingTs != null ? blockingTs + 60_000 : now + 60_000
        const resetAt = new Date(resetMs).toISOString()
        const retryAfter = Math.max(1, Math.ceil((resetMs - now) / 1000))
        return {
          ok: false,
          code: 'api_key_rate_limit',
          message: `API key rate limit exceeded (${effective.rpm}/min)`,
          status: 429,
          limit_type: 'rpm',
          current: n,
          limit: effective.rpm,
          remaining: 0,
          reset_at: resetAt,
          retry_after: retryAfter,
          detail: { rpm: effective.rpm, current: n },
        }
      }
    }
    const inflight = this.inflight.get(effective.id) || 0
    if (effective.max_concurrency > 0 && inflight >= effective.max_concurrency) {
      return {
        ok: false,
        code: 'api_key_concurrency_limit',
        message: `API key concurrency limit (${effective.max_concurrency})`,
        status: 429,
        limit_type: 'key_concurrency',
        current: inflight,
        limit: effective.max_concurrency,
        remaining: 0,
        reset_at: null,
        retry_after: 1,
        detail: { inflight, max: effective.max_concurrency },
      }
    }
    // The user-level cap counts inflight requests across all of the owner's keys.
    // The operator (admin) is never capped: its traffic is the platform's own.
    if (effective.user_id) {
      const cap = this._userConcurrencyCap(effective.user_id, rec)
      if (cap > 0) {
        const total = this._userInflight(effective.user_id)
        if (total >= cap) {
          return {
            ok: false,
            code: 'user_concurrency_limit',
            message: `User concurrency limit (${cap})`,
            status: 429,
            limit_type: 'user_concurrency',
            current: total,
            limit: cap,
            remaining: 0,
            reset_at: null,
            retry_after: 1,
            detail: { inflight: total, max: cap },
          }
        }
      }
    }
    return { ok: true }
  }

  /** Async pre-flight gate integrating Redis ConcurrencyCache + RPM when available. */
  async canAcceptAsync(rec, now = Date.now()) {
    const effective = this._mergePendingSnapshot(rec)
    const baseGate = this._checkStaticAndQuotaLimits(effective, now)
    if (!baseGate.ok) return baseGate

    const cache = getCacheRuntime()
    const useRedis = Boolean(cache?.client?.hasRedis)

    if (effective.rpm > 0) {
      if (useRedis) {
        const n = await cache.concurrency.getRpmCount('key', effective.id, 60)
        if (n >= effective.rpm) {
          const resetMs = (Math.floor(Math.floor(now / 1000) / 60) + 1) * 60_000
          const retryAfter = Math.max(1, Math.ceil((resetMs - now) / 1000))
          return {
            ok: false,
            code: 'api_key_rate_limit',
            message: `API key rate limit exceeded (${effective.rpm}/min)`,
            status: 429,
            limit_type: 'rpm',
            current: n,
            limit: effective.rpm,
            remaining: 0,
            reset_at: new Date(resetMs).toISOString(),
            retry_after: retryAfter,
            detail: { rpm: effective.rpm, current: n },
          }
        }
      } else {
        const { count: n, timestamps } = this._rpmState(effective.id, now)
        if (n >= effective.rpm) {
          const blockingTs = timestamps[Math.max(0, timestamps.length - effective.rpm)]
          const resetMs = blockingTs != null ? blockingTs + 60_000 : now + 60_000
          const resetAt = new Date(resetMs).toISOString()
          const retryAfter = Math.max(1, Math.ceil((resetMs - now) / 1000))
          return {
            ok: false,
            code: 'api_key_rate_limit',
            message: `API key rate limit exceeded (${effective.rpm}/min)`,
            status: 429,
            limit_type: 'rpm',
            current: n,
            limit: effective.rpm,
            remaining: 0,
            reset_at: resetAt,
            retry_after: retryAfter,
            detail: { rpm: effective.rpm, current: n },
          }
        }
      }
    }

    if (effective.max_concurrency > 0) {
      const inflight = useRedis ? await cache.concurrency.countKey(effective.id) : this.inflight.get(effective.id) || 0
      if (inflight >= effective.max_concurrency) {
        return {
          ok: false,
          code: 'api_key_concurrency_limit',
          message: `API key concurrency limit (${effective.max_concurrency})`,
          status: 429,
          limit_type: 'key_concurrency',
          current: inflight,
          limit: effective.max_concurrency,
          remaining: 0,
          reset_at: null,
          retry_after: 1,
          detail: { inflight, max: effective.max_concurrency },
        }
      }
    }

    if (effective.user_id) {
      const cap = await this._userConcurrencyCapAsync(effective.user_id, rec)
      if (cap > 0) {
        const total = useRedis
          ? await cache.concurrency.countUser(effective.user_id)
          : this._userInflight(effective.user_id)
        if (total >= cap) {
          return {
            ok: false,
            code: 'user_concurrency_limit',
            message: `User concurrency limit (${cap})`,
            status: 429,
            limit_type: 'user_concurrency',
            current: total,
            limit: cap,
            remaining: 0,
            reset_at: null,
            retry_after: 1,
            detail: { inflight: total, max: cap },
          }
        }
      }
    }
    return { ok: true }
  }

  /** users.concurrency of the key owner; 0 = none. The admin operator is never capped. */
  _userConcurrencyCap(userId, rec = null) {
    const proj = rec?._authProjection
    if (proj?.ownerLoaded && proj.userId === userId) {
      return proj.ownerMaxConcurrency
    }
    const owner = this._loadOwnerSync(userId)
    return owner?.role === 'admin' ? 0 : Number(owner?.concurrency) || 0
  }

  async _userConcurrencyCapAsync(userId, rec = null) {
    const proj = rec?._authProjection
    if (proj?.ownerLoaded && proj.userId === userId) {
      return proj.ownerMaxConcurrency
    }
    const owner = await this._loadOwnerAsync(userId)
    return owner?.role === 'admin' ? 0 : Number(owner?.concurrency) || 0
  }

  /** O(1) inflight count across all keys owned by `userId` (no DB scan). */
  _userInflight(userId) {
    return this.userInflight.get(userId) || 0
  }

  /**
   * The holder's view of one key (GET /v1/me/quota): the numbers canAccept
   * reads and its verdict. Never the owner, slot, pool or other keys.
   */
  selfQuota(rec, now = Date.now()) {
    const gate = this.canAccept(rec, now)
    const windows = {}
    for (const win of RATE_WINDOWS) {
      const w = rateWindow(rec, win, now)
      windows[win.name] = {
        ...limitView(w.limit, w.used),
        window_start: w.open ? new Date(w.start).toISOString() : null,
        reset_at: w.open ? new Date(w.start + win.ms).toISOString() : null,
      }
    }
    const rpm = Number(rec.rpm) || 0
    const rpmNow = this._rpmCount(rec.id, now)
    const maxConcurrency = Number(rec.max_concurrency) || 0
    const inflight = this.inflight.get(rec.id) || 0
    let user = null
    if (rec.user_id) {
      const cap = this._userConcurrencyCap(rec.user_id)
      const total = this._userInflight(rec.user_id)
      user = { limit: cap > 0 ? cap : null, inflight: total, exceeded: cap > 0 && total >= cap }
    }
    return {
      key: {
        name: rec.name,
        masked_key: `${String(rec.key_prefix || KEY_PREFIX).slice(0, 8)}…${rec.key_suffix || ''}`,
        status: rec.status,
        expires_at: rec.expires_at || null,
        expired: this._expired(rec, now),
        created_at: rec.created_at || null,
        last_used_at: rec.last_used_at || null,
      },
      accepting: gate.ok,
      blocked_by: gate.ok
        ? null
        : gate.limit_type
          ? {
              code: gate.code,
              message: gate.message,
              status: gate.status,
              limit_type: gate.limit_type,
              current: gate.current,
              limit: gate.limit,
              remaining: gate.remaining,
              reset_at: gate.reset_at ?? null,
              retry_after: gate.retry_after ?? null,
            }
          : { code: gate.code, message: gate.message, status: gate.status },
      usd: limitView(Number(rec.quota) || 0, Number(rec.quota_used) || 0),
      windows,
      requests: limitView(Number(rec.quota_requests) || 0, Number(rec.quota_requests_used) || 0),
      rpm: { limit: rpm > 0 ? rpm : null, current: rpmNow, exceeded: rpm > 0 && rpmNow >= rpm },
      concurrency: {
        limit: maxConcurrency > 0 ? maxConcurrency : null,
        inflight,
        exceeded: maxConcurrency > 0 && inflight >= maxConcurrency,
      },
      user_concurrency: user,
    }
  }

  acquire(rec, now = Date.now()) {
    const gate = this.canAccept(rec, now)
    if (!gate.ok) return gate
    const id = rec.id
    this.inflight.set(id, (this.inflight.get(id) || 0) + 1)
    if (rec.user_id) {
      this.inflightOwner.set(id, rec.user_id)
      this.userInflight.set(rec.user_id, (this.userInflight.get(rec.user_id) || 0) + 1)
    }
    const arr = this.rpmBuckets.get(id) || []
    arr.push(now)
    this.rpmBuckets.set(id, arr)
    return { ok: true }
  }

  /**
   * Async concurrency + RPM slot acquisition integrating Redis `ConcurrencyCache`
   * when Redis is connected; falls back seamlessly to O(1) in-process Maps otherwise.
   */
  async acquireAsync(rec, now = Date.now()) {
    const effective = this._mergePendingSnapshot(rec)
    const baseGate = this._checkStaticAndQuotaLimits(effective, now)
    if (!baseGate.ok) return baseGate

    const cache = getCacheRuntime()
    if (!cache?.client?.hasRedis) {
      return this.acquire(rec, now)
    }

    const id = effective.id
    const conc = cache.concurrency

    if (effective.rpm > 0) {
      const rpmRes = await conc.checkAndIncrRpm('key', id, effective.rpm, 60)
      if (!rpmRes.allowed) {
        return {
          ok: false,
          code: 'api_key_rate_limit',
          message: `API key rate limit exceeded (${effective.rpm}/min)`,
          status: 429,
          limit_type: 'rpm',
          current: rpmRes.current,
          limit: effective.rpm,
          remaining: 0,
          reset_at: rpmRes.resetAt ? new Date(rpmRes.resetAt).toISOString() : null,
          retry_after: rpmRes.retryAfterSec || 1,
          detail: { rpm: effective.rpm, current: rpmRes.current },
        }
      }
    }

    const reqToken = `${process.pid}:${now}:${crypto.randomBytes(4).toString('hex')}`
    let hasKeySlot = false
    let hasUserSlot = false

    if (effective.max_concurrency > 0) {
      const acquired = await conc.acquireKey(id, reqToken, effective.max_concurrency)
      if (!acquired) {
        const current = await conc.countKey(id)
        return {
          ok: false,
          code: 'api_key_concurrency_limit',
          message: `API key concurrency limit (${effective.max_concurrency})`,
          status: 429,
          limit_type: 'key_concurrency',
          current: Math.max(current, effective.max_concurrency),
          limit: effective.max_concurrency,
          remaining: 0,
          reset_at: null,
          retry_after: 1,
          detail: { inflight: Math.max(current, effective.max_concurrency), max: effective.max_concurrency },
        }
      }
      hasKeySlot = true
    }

    if (effective.user_id) {
      const cap = await this._userConcurrencyCapAsync(effective.user_id, rec)
      if (cap > 0) {
        const acquired = await conc.acquireUser(effective.user_id, reqToken, cap)
        if (!acquired) {
          if (hasKeySlot) {
            await conc.releaseKey(id, reqToken).catch(() => {})
          }
          const total = await conc.countUser(effective.user_id)
          return {
            ok: false,
            code: 'user_concurrency_limit',
            message: `User concurrency limit (${cap})`,
            status: 429,
            limit_type: 'user_concurrency',
            current: Math.max(total, cap),
            limit: cap,
            remaining: 0,
            reset_at: null,
            retry_after: 1,
            detail: { inflight: Math.max(total, cap), max: cap },
          }
        }
        hasUserSlot = true
      }
    }

    this.inflight.set(id, (this.inflight.get(id) || 0) + 1)
    if (effective.user_id) {
      this.inflightOwner.set(id, effective.user_id)
      this.userInflight.set(effective.user_id, (this.userInflight.get(effective.user_id) || 0) + 1)
    }
    const arr = this.rpmBuckets.get(id) || []
    arr.push(now)
    this.rpmBuckets.set(id, arr)

    if (hasKeySlot || hasUserSlot) {
      let slots = this._redisSlots.get(id)
      if (!slots) {
        slots = []
        this._redisSlots.set(id, slots)
      }
      slots.push({ reqToken, userId: effective.user_id || null, hasKeySlot, hasUserSlot })
    }
    return { ok: true }
  }

  release(recOrId) {
    const id = typeof recOrId === 'string' ? recOrId : recOrId?.id
    if (!id) return
    const prev = this.inflight.get(id) || 0
    if (prev <= 0) return
    const n = prev - 1
    const userId = (typeof recOrId === 'object' && recOrId?.user_id) || this.inflightOwner.get(id) || null
    if (n <= 0) {
      this.inflight.delete(id)
      this.inflightOwner.delete(id)
    } else {
      this.inflight.set(id, n)
    }
    if (userId) {
      const un = (this.userInflight.get(userId) || 0) - 1
      if (un <= 0) this.userInflight.delete(userId)
      else this.userInflight.set(userId, un)
    }
    const slots = this._redisSlots.get(id)
    if (slots?.length) {
      const slot = slots.shift()
      if (!slots.length) this._redisSlots.delete(id)
      const conc = getCacheRuntime().concurrency
      if (slot.hasKeySlot) conc.releaseKey(id, slot.reqToken).catch(() => {})
      if (slot.hasUserSlot && slot.userId) conc.releaseUser(slot.userId, slot.reqToken).catch(() => {})
    }
  }

  _addLocalPendingUsage(id, delta, nextRec) {
    const cur = this._pendingUsage.get(id) || {
      requests: 0,
      quota_requests_used: 0,
      tokens_in: 0,
      tokens_out: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost: 0,
      last_used_at: null,
      windows: {},
    }
    cur.requests += delta.requests || 0
    cur.quota_requests_used += delta.quota_requests_used || 0
    cur.tokens_in += delta.tokens_in || 0
    cur.tokens_out += delta.tokens_out || 0
    cur.cache_read_tokens += delta.cache_read_tokens || 0
    cur.cache_creation_tokens += delta.cache_creation_tokens || 0
    cur.cost += delta.cost || 0
    if (delta.last_used_at && (!cur.last_used_at || delta.last_used_at > cur.last_used_at)) {
      cur.last_used_at = delta.last_used_at
    }
    if (nextRec) {
      cur.windows = {
        '5h': { usage: nextRec.usage_5h, start: nextRec.window_5h_start },
        '1d': { usage: nextRec.usage_1d, start: nextRec.window_1d_start },
        '7d': { usage: nextRec.usage_7d, start: nextRec.window_7d_start },
      }
    }
    this._pendingUsage.set(id, cur)
  }

  _subtractLocalPendingUsage(entry) {
    const cur = this._pendingUsage.get(entry.keyId)
    if (!cur) return
    cur.requests = Math.max(0, cur.requests - (Number(entry.requests) || 0))
    cur.quota_requests_used = Math.max(0, cur.quota_requests_used - (Number(entry.quota_requests_used) || 0))
    cur.tokens_in = Math.max(0, cur.tokens_in - (Number(entry.tokens_in) || 0))
    cur.tokens_out = Math.max(0, cur.tokens_out - (Number(entry.tokens_out) || 0))
    cur.cache_read_tokens = Math.max(0, cur.cache_read_tokens - (Number(entry.cache_read_tokens) || 0))
    cur.cache_creation_tokens = Math.max(0, cur.cache_creation_tokens - (Number(entry.cache_creation_tokens) || 0))
    cur.cost = Math.max(0, cur.cost - (Number(entry.cost) || 0))
    if (
      cur.requests <= 0 &&
      cur.quota_requests_used <= 0 &&
      cur.tokens_in <= 0 &&
      cur.tokens_out <= 0 &&
      cur.cache_read_tokens <= 0 &&
      cur.cache_creation_tokens <= 0 &&
      cur.cost <= 1e-12
    ) {
      this._pendingUsage.delete(entry.keyId)
    }
  }

  _applyDeltaSyncImmediate(id, delta, { forceExhausted = false } = {}) {
    const rec = this.repo.recordUsage(id, {
      tokens_in: delta.tokens_in,
      tokens_out: delta.tokens_out,
      cache_read_tokens: delta.cache_read_tokens,
      cache_creation_tokens: delta.cache_creation_tokens,
      cost: delta.cost,
    })
    let finalRec = rec
    if (
      rec &&
      rec.status === 'active' &&
      (forceExhausted || ((rec.quota ?? 0) > 0 && (rec.quota_used ?? 0) >= rec.quota))
    ) {
      finalRec = this.repo.update({ ...rec, status: 'quota_exhausted', updated_at: nowIso() })
    }
    return finalRec
  }

  recordUsage(recOrId, usage = {}, { model = null, rateMultiplier = 1, officialCost } = {}) {
    const id = typeof recOrId === 'string' ? recOrId : recOrId?.id
    if (!id) return null
    const normalized = normalizeUsage(usage)
    let billed = officialCost
    if (billed == null) billed = usage.total_cost
    if (billed == null && model) {
      try {
        const c = calculateCost(normalized, model)
        if (c?.known) billed = c.total_cost
      } catch {}
    }
    if (billed == null) billed = Number(usage.cost ?? usage.actual_cost) || 0
    // Key quotas and spend windows track the cost after applying the group rate.
    const rate = Number.isFinite(Number(rateMultiplier)) ? Number(rateMultiplier) : 1
    const cost = billed * rate
    const tokens_in = Number(normalized.input_tokens) || Number(normalized.tokens_in) || 0
    const tokens_out = Number(normalized.output_tokens) || Number(normalized.tokens_out) || 0
    const cache_read_tokens = Number(normalized.cache_read_input_tokens ?? normalized.cache_read_tokens) || 0
    const cache_creation_tokens =
      Number(normalized.cache_creation_input_tokens ?? normalized.cache_creation_tokens) || 0

    const cache = getCacheRuntime()
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()

    // Direct write-through mode (standalone SQLite without flusher/Redis)
    if (!this._isWriteBehindUsageEnabled()) {
      if (!this.repo.getById(id)) return null
      const finalRec = this._applyDeltaSyncImmediate(id, {
        tokens_in,
        tokens_out,
        cache_read_tokens,
        cache_creation_tokens,
        cost,
      })
      if (finalRec) {
        this._keySnapshots.set(id, finalRec)
        if (finalRec.key_hash) {
          const ck = this._cacheKey(finalRec.key_hash)
          if (cache.apiKeys.getSync(ck).hit) {
            cache.apiKeys.putSync(ck, finalRec)
          }
        }
      }
      if (cost > 0) {
        for (const win of RATE_WINDOWS) {
          if ((finalRec?.[win.limit] ?? 0) > 0) {
            cache.billing.recordKeyWindowUsage(id, win.name, cost, win.ms).catch(() => {})
          }
        }
      }
      return finalRec
    }

    // Dirty-Set Write-Behind hot path (0 sync DB RPCs for steady-state requests)
    const baseRec =
      this._keySnapshots.get(id) ||
      (typeof recOrId === 'object' && recOrId?.id === id ? this._mergePendingSnapshot(recOrId) : null) ||
      this.getById(id)
    if (!baseRec) return null

    const nextRec = {
      ...baseRec,
      requests: (Number(baseRec.requests) || 0) + 1,
      quota_requests_used: (Number(baseRec.quota_requests_used) || 0) + 1,
      tokens_in: (Number(baseRec.tokens_in) || 0) + tokens_in,
      tokens_out: (Number(baseRec.tokens_out) || 0) + tokens_out,
      cache_read_tokens: (Number(baseRec.cache_read_tokens) || 0) + cache_read_tokens,
      cache_creation_tokens: (Number(baseRec.cache_creation_tokens) || 0) + cache_creation_tokens,
      quota_used: (Number(baseRec.quota_used) || 0) + cost,
      last_used_at: now,
      updated_at: now,
    }
    for (const win of RATE_WINDOWS) {
      const rolled = rollSpendWindow(baseRec, win, cost, nowMs, now)
      nextRec[win.usage] = rolled.usage
      nextRec[win.start] = rolled.start
    }

    const usdHit = (nextRec.quota ?? 0) > 0 && (nextRec.quota_used ?? 0) >= nextRec.quota
    const reqHit = (nextRec.quota_requests ?? 0) > 0 && (nextRec.quota_requests_used ?? 0) >= nextRec.quota_requests
    const winHit = RATE_WINDOWS.some(
      (win) => (Number(nextRec[win.limit]) || 0) > 0 && (Number(nextRec[win.usage]) || 0) >= Number(nextRec[win.limit]),
    )
    const statusFlipped = usdHit && nextRec.status === 'active'
    if (statusFlipped) nextRec.status = 'quota_exhausted'

    const delta = {
      requests: 1,
      quota_requests_used: 1,
      tokens_in,
      tokens_out,
      cache_read_tokens,
      cache_creation_tokens,
      cost,
      last_used_at: now,
    }

    // Safety floor: when quota or spend window is reached/exceeded, flush immediately
    // so concurrent requests and sibling instances cannot overdraw.
    if (usdHit || reqHit || winHit) {
      const hadPending = this._pendingUsage.has(id)
      const persisted = this._applyDeltaSyncImmediate(id, delta, { forceExhausted: usdHit })
      const authoritative = hadPending ? nextRec : persisted || nextRec
      this._keySnapshots.set(id, authoritative)
      if (authoritative?.key_hash) {
        const ck = this._cacheKey(authoritative.key_hash)
        const wasCached = cache.apiKeys.getSync(ck).hit
        if (statusFlipped) {
          this._invalidateHash(authoritative.key_hash, 'quota_exhausted')
        }
        if (wasCached) {
          cache.apiKeys.putSync(ck, authoritative)
        }
      }
      if (hadPending) {
        this.flushPendingUsage().catch(() => {})
      }
      if (cost > 0) {
        for (const win of RATE_WINDOWS) {
          if ((authoritative?.[win.limit] ?? 0) > 0) {
            cache.billing.recordKeyWindowUsage(id, win.name, cost, win.ms).catch(() => {})
          }
        }
      }
      return authoritative
    }

    // Normal hot path: update L1/snapshot in-place and accumulate into dirty set
    this._keySnapshots.set(id, nextRec)
    this._addLocalPendingUsage(id, delta, nextRec)
    if (nextRec.key_hash) {
      const ck = this._cacheKey(nextRec.key_hash)
      if (cache.apiKeys.getSync(ck).hit) {
        cache.apiKeys.putSync(ck, nextRec)
      }
    }
    cache.billing.accumulateKeyUsage(id, delta).catch(() => {})
    if (cost > 0) {
      for (const win of RATE_WINDOWS) {
        if ((nextRec?.[win.limit] ?? 0) > 0) {
          cache.billing.recordKeyWindowUsage(id, win.name, cost, win.ms).catch(() => {})
        }
      }
    }
    this._ensureUsageFlusherStarted()
    return nextRec
  }

  async _applyUsageBatchToPg(pgPool, entries, nowIsoStr) {
    const params = [nowIsoStr]
    const tuples = []
    for (const entry of entries) {
      const base = params.length + 1
      params.push(
        String(entry.keyId),
        Math.round(Number(entry.requests) || 0),
        Math.round(Number(entry.quota_requests_used) || 0),
        Math.round(Number(entry.tokens_in) || 0),
        Math.round(Number(entry.tokens_out) || 0),
        Math.round(Number(entry.cache_read_tokens) || 0),
        Math.round(Number(entry.cache_creation_tokens) || 0),
        Number(entry.cost) || 0,
        entry.last_used_at ? String(entry.last_used_at) : nowIsoStr,
      )
      tuples.push(
        `($${base}::text, $${base + 1}::bigint, $${base + 2}::bigint, $${base + 3}::bigint, $${base + 4}::bigint, $${base + 5}::bigint, $${base + 6}::bigint, $${base + 7}::double precision, $${base + 8}::text)`,
      )
    }
    const sql = `
      UPDATE api_keys AS k
      SET
        requests = COALESCE(k.requests, 0) + v.requests,
        quota_requests_used = COALESCE(k.quota_requests_used, 0) + v.quota_requests_used,
        tokens_in = COALESCE(k.tokens_in, 0) + v.tokens_in,
        tokens_out = COALESCE(k.tokens_out, 0) + v.tokens_out,
        cache_read_tokens = COALESCE(k.cache_read_tokens, 0) + v.cache_read_tokens,
        cache_creation_tokens = COALESCE(k.cache_creation_tokens, 0) + v.cache_creation_tokens,
        quota_used = COALESCE(k.quota_used, 0) + v.cost,
        usage_5h = CASE
          WHEN k.window_5h_start IS NULL OR k.window_5h_start = ''
            OR (EXTRACT(EPOCH FROM (($1::text)::timestamptz - NULLIF(k.window_5h_start, '')::timestamptz)) * 1000) >= 18000000
          THEN v.cost
          ELSE COALESCE(k.usage_5h, 0) + v.cost
        END,
        window_5h_start = CASE
          WHEN k.window_5h_start IS NULL OR k.window_5h_start = ''
            OR (EXTRACT(EPOCH FROM (($1::text)::timestamptz - NULLIF(k.window_5h_start, '')::timestamptz)) * 1000) >= 18000000
          THEN $1::text
          ELSE k.window_5h_start
        END,
        usage_1d = CASE
          WHEN k.window_1d_start IS NULL OR k.window_1d_start = ''
            OR (EXTRACT(EPOCH FROM (($1::text)::timestamptz - NULLIF(k.window_1d_start, '')::timestamptz)) * 1000) >= 86400000
          THEN v.cost
          ELSE COALESCE(k.usage_1d, 0) + v.cost
        END,
        window_1d_start = CASE
          WHEN k.window_1d_start IS NULL OR k.window_1d_start = ''
            OR (EXTRACT(EPOCH FROM (($1::text)::timestamptz - NULLIF(k.window_1d_start, '')::timestamptz)) * 1000) >= 86400000
          THEN $1::text
          ELSE k.window_1d_start
        END,
        usage_7d = CASE
          WHEN k.window_7d_start IS NULL OR k.window_7d_start = ''
            OR (EXTRACT(EPOCH FROM (($1::text)::timestamptz - NULLIF(k.window_7d_start, '')::timestamptz)) * 1000) >= 604800000
          THEN v.cost
          ELSE COALESCE(k.usage_7d, 0) + v.cost
        END,
        window_7d_start = CASE
          WHEN k.window_7d_start IS NULL OR k.window_7d_start = ''
            OR (EXTRACT(EPOCH FROM (($1::text)::timestamptz - NULLIF(k.window_7d_start, '')::timestamptz)) * 1000) >= 604800000
          THEN $1::text
          ELSE k.window_7d_start
        END,
        status = CASE
          WHEN k.status = 'active' AND COALESCE(k.quota, 0) > 0 AND (COALESCE(k.quota_used, 0) + v.cost) >= k.quota
          THEN 'quota_exhausted'
          ELSE k.status
        END,
        last_used_at = CASE
          WHEN v.last_used_at IS NOT NULL AND v.last_used_at <> '' AND (k.last_used_at IS NULL OR v.last_used_at > k.last_used_at)
          THEN v.last_used_at
          ELSE COALESCE(k.last_used_at, $1::text)
        END,
        updated_at = $1::text
      FROM (VALUES ${tuples.join(', ')}) AS v(id, requests, quota_requests_used, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, cost, last_used_at)
      WHERE k.id = v.id AND k.deleted_at IS NULL
      RETURNING k.*
    `
    const res = await pgPool.query(sql, params)
    return Array.isArray(res?.rows) ? res.rows : []
  }

  _applyUsageBatchToSqlite(entries, nowMs, nowIsoStr) {
    if (!this._batchUpdateStmt) this._prepareBatchUpdate()
    const updatedRows = []
    withTransaction(this.db, () => {
      for (const entry of entries) {
        const current = this.repo.getById(entry.keyId)
        if (!current) continue
        const usd = Number(entry.cost) || 0
        const w5 = rollSpendWindow(current, RATE_WINDOWS[0], usd, nowMs, nowIsoStr)
        const w1d = rollSpendWindow(current, RATE_WINDOWS[1], usd, nowMs, nowIsoStr)
        const w7d = rollSpendWindow(current, RATE_WINDOWS[2], usd, nowMs, nowIsoStr)
        const nextQuotaUsed = (Number(current.quota_used) || 0) + usd
        const nextStatus =
          current.status === 'active' && (current.quota ?? 0) > 0 && nextQuotaUsed >= current.quota
            ? 'quota_exhausted'
            : current.status
        const lastUsed =
          entry.last_used_at && (!current.last_used_at || entry.last_used_at > current.last_used_at)
            ? entry.last_used_at
            : current.last_used_at || nowIsoStr
        this._batchUpdateStmt.run(
          Math.round(Number(entry.requests) || 0),
          Math.round(Number(entry.quota_requests_used) || 0),
          Math.round(Number(entry.tokens_in) || 0),
          Math.round(Number(entry.tokens_out) || 0),
          Math.round(Number(entry.cache_read_tokens) || 0),
          Math.round(Number(entry.cache_creation_tokens) || 0),
          usd,
          w5.usage,
          w5.start,
          w1d.usage,
          w1d.start,
          w7d.usage,
          w7d.start,
          nextStatus,
          lastUsed,
          nowIsoStr,
          entry.keyId,
        )
        const refreshed = this.repo.getById(entry.keyId)
        if (refreshed) updatedRows.push(refreshed)
      }
    })
    return updatedRows
  }

  /**
   * Drain up to `batchSize` dirty API key usage deltas and persist in a single batch.
   * Re-adds entries back to the dirty set on failure so zero usage is lost.
   */
  flushPendingUsage(batchSize = DEFAULT_USAGE_FLUSH_BATCH_SIZE) {
    const run = async () => {
      const cache = getCacheRuntime()
      const entries = await cache.billing.popDirtyKeyUsage(batchSize)
      if (!entries.length) return { flushed: 0, failed: 0 }

      const nowMs = Date.now()
      const nowIsoStr = new Date(nowMs).toISOString()
      const pgPool = this._resolvePgPool()
      try {
        const rows =
          pgPool && typeof pgPool.query === 'function'
            ? await this._applyUsageBatchToPg(pgPool, entries, nowIsoStr)
            : this._applyUsageBatchToSqlite(entries, nowMs, nowIsoStr)

        for (const entry of entries) {
          this._subtractLocalPendingUsage(entry)
        }
        for (const row of rows) {
          const prevSnap = this._keySnapshots.get(row.id)
          const merged = this._overlayDbRecord(row)
          this._keySnapshots.set(row.id, merged)
          if (merged?.key_hash) {
            if (prevSnap?.status === 'active' && merged.status === 'quota_exhausted') {
              this._invalidateHash(merged.key_hash, 'quota_exhausted')
            }
            cache.apiKeys.putSync(this._cacheKey(merged.key_hash), merged)
          }
        }
        if (this._isPrimaryDb()) {
          notifyDbTablesMutated(['api_keys:usage'])
        }
        return { flushed: entries.length, failed: 0 }
      } catch (err) {
        const errMsg = err?.message ? String(err.message) : String(err || 'unknown error')
        const failedAt = Date.now()
        this._usageFlushFailures += 1
        this._lastUsageFlushError = errMsg
        this._lastUsageFlushErrorAt = failedAt
        if (failedAt - this._lastUsageFlushWarnAt >= USAGE_FLUSH_ERROR_LOG_THROTTLE_MS) {
          this._lastUsageFlushWarnAt = failedAt
          console.error(
            `[api-keys] usage batch flush failed (${entries.length} keys, failures=${this._usageFlushFailures}):`,
            errMsg,
          )
        }
        await cache.billing.readdDirtyKeyUsage(entries).catch(() => {})
        return { flushed: 0, failed: entries.length, error: errMsg }
      }
    }
    const next = this._flushChain.then(run, run)
    this._flushChain = next.catch(() => {})
    return next
  }

  /** Drain all pending dirty usage batches until empty (or on DB failure). */
  async flushUsage() {
    let totalFlushed = 0
    for (let i = 0; i < 64; i += 1) {
      const res = await this.flushPendingUsage(DEFAULT_USAGE_FLUSH_BATCH_SIZE)
      totalFlushed += res.flushed
      if (res.flushed === 0 || res.failed > 0) break
    }
    return totalFlushed
  }

  /** Stop the background usage flusher and flush all remaining dirty deltas. */
  async close() {
    this.stopUsageFlusher()
    await this.flushUsage()
  }

  snapshot() {
    const keys = this.list({ reveal: false })
    return {
      total: keys.length,
      active: keys.filter((k) => k.status === 'active').length,
      keys,
    }
  }

  _hash(token) {
    return crypto
      .createHmac('sha256', this.hashSecret)
      .update(String(token || ''))
      .digest('hex')
  }
}

/**
 * Build a uniform gateway error payload (+ optional `Retry-After` header) from
 * an `ApiKeyStore.canAccept` / `acquire` rejection while preserving legacy `error.type`.
 */
export function apiKeyGateDetails(gate = {}) {
  const base = gate.detail && typeof gate.detail === 'object' ? { ...gate.detail } : {}
  if (gate.limit_type) {
    base.limit_type = gate.limit_type
    base.current = gate.current ?? null
    base.limit = gate.limit ?? null
    base.remaining = gate.remaining ?? 0
    base.reset_at = gate.reset_at ?? null
    if (gate.retry_after != null) base.retry_after = gate.retry_after
  }
  return Object.keys(base).length ? base : undefined
}

export function makeApiKeyGateError(gate = {}) {
  const code = gate.code || 'invalid_api_key'
  const status = gate.status || 401
  let type = ErrorType.PERMISSION
  if (status === 401 || code === 'invalid_api_key') {
    type = ErrorType.AUTH
  } else if (code === 'api_key_quota_exhausted') {
    type = ErrorType.QUOTA
  } else if (
    code === 'api_key_rate_limit' ||
    code === 'api_key_concurrency_limit' ||
    code === 'user_concurrency_limit' ||
    status === 429
  ) {
    type = ErrorType.RATE_LIMIT
  }
  const err = makeError({
    type,
    code,
    message: gate.message || code,
    status,
    details: apiKeyGateDetails(gate),
  })
  const retryAfter = Number(gate.retry_after)
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    err.headers = { 'Retry-After': String(Math.max(1, Math.ceil(retryAfter))) }
  }
  return err
}
