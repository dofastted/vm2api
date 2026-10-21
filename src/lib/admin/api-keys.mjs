/**
 * Multi API-key store (sub2api-inspired, PostgreSQL-backed).
 *
 * Fields aligned to sub2api basics:
 *   name, status, expires_at, quota (+ used), rate windows → rpm,
 *   concurrency (per-key, sub2api puts this on User).
 *
 * Master env key KIN_API_KEY is separate and unlimited.
 * Managed keys live in the `api_keys` table (see lib/db/).
 * Standalone state (inflight concurrency, RPM buckets) stays in memory.
 * Kubernetes admissions use PostgreSQL for cross-replica limits and quotas.
 *
 * Auth always goes through `key_hash` (HMAC). `key_secret` is a separate
 * at-rest copy of the plaintext — encrypted with KIN_DB_SECRET when set — so
 * the panel can re-reveal a key for copying after creation.
 */

import { keyScopeFromRecord, normalizeKeyScope } from './key-scope.mjs'
import { VmPoolsRepo } from '../db/repos/vm-pools-repo.mjs'
import crypto from 'node:crypto'
import { resolveStoreDb, withTransaction } from '../db/database.mjs'
import { integerValue } from '../db/integers.mjs'
import { ApiKeysRepo } from '../db/repos/api-keys-repo.mjs'
import { maybeEncrypt, maybeDecrypt } from '../db/secure.mjs'
import { calculateCost, normalizeUsage } from './pricing.mjs'
import { UsersRepo } from '../db/repos/users-repo.mjs'
import { ApiKeyAdmissionsRepo } from '../db/repos/api-key-admissions-repo.mjs'
import { isKubernetesMode } from '../core/control-plane-mode.mjs'

const KEY_PREFIX = 'sk-vm-'
const HASH_MARKER = 'hmac:'

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
    category: rec.category === 'api' ? 'api' : 'oauth',
    ...keyScopeFromRecord(rec),
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
  constructor({ dataDir, db, hashSecret, sharedAdmission = isKubernetesMode() } = {}) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new ApiKeysRepo(this.db)
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
    this.inflight = new Map() // id → count
    this.rpmBuckets = new Map() // id → number[] timestamps ms
    this.users = new UsersRepo(this.db)
    this.sharedAdmission = sharedAdmission
    this.admissionOwnerId = 'controller_' + crypto.randomUUID()
    this.admissions = new ApiKeyAdmissionsRepo(this.db)
  }

  /** sub2api: an api key of a disabled/deleted user must not authenticate. */
  async _ownerActive(rec) {
    if (!rec?.user_id) return true // legacy unowned keys keep working
    try {
      const owner = await this.users.getById(rec.user_id)
      // soft-deleted owner is invisible here → key is revoked with them
      return !!owner && owner.status === 'active'
    } catch {
      return false
    }
  }

  /** Re-read from DB (no-op cache-wise; kept for API compat + post-restore). */
  reload() {}

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    this.db = db
    this.repo = new ApiKeysRepo(db)
    this.users = new UsersRepo(db)
    this.admissions = new ApiKeyAdmissionsRepo(db)
  }

  async list({ reveal = false } = {}) {
    const names = new Map()
    const inflight = this.sharedAdmission ? await this.admissions.inflight() : this.inflight
    try {
      for (const pool of await new VmPoolsRepo(this.db).list()) names.set(pool.id, pool.name)
    } catch {
      // A database opened before migration 034 still lists keys.
    }
    return (await this.repo.list()).map((k) => {
      const v = publicKeyView(k, { reveal })
      v.inflight = inflight.get(k.id) || 0
      if (v.vm_pool_id) v.vm_pool_name = names.get(v.vm_pool_id) || null
      return v
    })
  }

  async getById(id) {
    return await this.repo.getById(id)
  }

  async authenticate(token) {
    if (!token) return { ok: false, reason: 'missing' }
    const hash = this._hash(token)
    const indexed = await this.repo.getByHash(hash)
    if (indexed) {
      if (!(await this._ownerActive(indexed))) return { ok: false, reason: 'user_disabled' }
      return { ok: true, record: indexed }
    }
    // One-time migration for legacy plaintext rows.
    for (const rec of await this.repo.list()) {
      if (String(rec.key || '').startsWith(HASH_MARKER)) continue
      if (timingSafeEqualStr(token, rec.key)) {
        return withTransaction(this.db, async () => {
          const current = await this.repo.getById(rec.id, { forUpdate: true })
          if (!current || !timingSafeEqualStr(token, current.key)) return { ok: false, reason: 'invalid' }
          current.key_hash = hash
          current.key_prefix = String(token).slice(0, 10)
          current.key_suffix = String(token).slice(-4)
          current.key_secret = maybeEncrypt(token)
          current.key = HASH_MARKER + hash
          return { ok: true, record: await this.repo.update(current) }
        })
      }
    }
    return { ok: false, reason: 'invalid' }
  }

  async create(input = {}) {
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
    if ((await this.repo.getByHash(keyHash)) || (await this.repo.getByKey(key))) {
      throw Object.assign(new Error('key already exists'), { code: 'key_exists' })
    }

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
      category: String(input.category || 'oauth').toLowerCase() === 'api' ? 'api' : 'oauth',
      ...storedKeyScope(
        normalizeKeyScope({
          group_type: input.group_type,
          allowed_vms: input.allowed_vms,
          ...(Object.prototype.hasOwnProperty.call(input, 'vm_pool_id') ? { vm_pool_id: input.vm_pool_id } : {}),
        }),
      ),
    }
    if (rec.expires_at && Number.isNaN(Date.parse(rec.expires_at))) {
      throw Object.assign(new Error('invalid expires_at'), { code: 'invalid_expires_at' })
    }
    const stored = await this.repo.insert(rec)
    return { ...stored, key, _plain_key: key }
  }

  async update(id, patch = {}) {
    return withTransaction(this.db, async () => {
      const rec = await this.repo.getById(id, { forUpdate: true })
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
      }
      // recover from quota_exhausted whenever spend is back under the cap
      if (
        rec.status === 'quota_exhausted' &&
        !((rec.quota ?? 0) > 0 && (rec.quota_used ?? 0) >= rec.quota) &&
        !(rec.quota_requests > 0 && BigInt(rec.quota_requests_used ?? 0) >= BigInt(rec.quota_requests))
      ) {
        rec.status = 'active'
      }
      if (patch.category != null) {
        rec.category = String(patch.category).toLowerCase() === 'api' ? 'api' : 'oauth'
      }
      const scope = normalizeKeyScope(patch, { partial: true, current: rec })
      if (scope) Object.assign(rec, storedKeyScope(scope))
      rec.updated_at = nowIso()
      return await this.repo.update(rec)
    })
  }

  /**
   * Plaintext of a managed key for panel copy.
   * @returns {null | { ok: false, code: string } | { ok: true, id, name, key }}
   */
  async reveal(id) {
    const rec = await this.repo.getById(id, { forUpdate: true })
    if (!rec) return null
    const key = plainApiKey(rec)
    if (!key) return { ok: false, code: 'key_not_recoverable' }
    return { ok: true, id: rec.id, name: rec.name, key }
  }

  /** Issue a fresh plaintext on the same record; the old value stops working. */
  async rotate(id) {
    return withTransaction(this.db, async () => {
      const rec = await this.repo.getById(id, { forUpdate: true })
      if (!rec) return null
      const key = generateApiKey()
      const keyHash = this._hash(key)
      if (await this.repo.getByHash(keyHash)) {
        throw Object.assign(new Error('key already exists'), { code: 'key_exists' })
      }
      rec.key = HASH_MARKER + keyHash
      rec.key_hash = keyHash
      rec.key_prefix = key.slice(0, 10)
      rec.key_suffix = key.slice(-4)
      rec.key_secret = maybeEncrypt(key)
      rec.updated_at = nowIso()
      const stored = await this.repo.update(rec)
      return { ...stored, key, _plain_key: key }
    })
  }

  async remove(id) {
    const removed = await this.repo.remove(id)
    if (!removed) return false
    this.inflight.delete(id)
    this.rpmBuckets.delete(id)
    return true
  }

  _expired(rec, now = Date.now()) {
    if (!rec.expires_at) return false
    return Date.parse(rec.expires_at) <= now
  }

  _rpmCount(id, now = Date.now()) {
    const windowMs = 60_000
    let arr = this.rpmBuckets.get(id) || []
    arr = arr.filter((t) => now - t < windowMs)
    this.rpmBuckets.set(id, arr)
    return arr.length
  }

  /**
   * Pre-flight gate for a managed key. Does not acquire concurrency.
   * @returns {{ ok: true } | { ok: false, code, message, status }}
   */
  async canAccept(rec, now = Date.now(), { reserve = false, state = null } = {}) {
    const owner = state ? state.owner : rec?.user_id ? await this.users.getById(rec.user_id) : null
    const ownedKeys = !state && rec?.user_id ? await this.repo.list() : []
    if (!rec) return { ok: false, code: 'invalid_api_key', message: 'Invalid credentials', status: 401 }
    if (rec.status !== 'active') {
      if (rec.status === 'quota_exhausted') {
        return { ok: false, code: 'api_key_quota_exhausted', message: 'API key quota exhausted', status: 429 }
      }
      return { ok: false, code: 'api_key_disabled', message: 'API key is disabled', status: 403 }
    }
    if (this._expired(rec, now)) {
      return { ok: false, code: 'api_key_expired', message: 'API key has expired', status: 403 }
    }
    if (rec.user_id && (!owner || owner.status !== 'active')) {
      return { ok: false, code: 'user_disabled', message: 'API key owner is disabled', status: 403 }
    }
    if (
      rec.quota_requests > 0 &&
      BigInt(rec.quota_requests_used ?? 0) + BigInt(state?.pendingRequests ?? 0) >= BigInt(rec.quota_requests)
    ) {
      return {
        ok: false,
        code: 'api_key_quota_exhausted',
        message: 'API key quota exhausted',
        status: 429,
        detail: { quota_requests: rec.quota_requests, quota_used: rec.quota_requests_used },
      }
    }
    if ((rec.quota ?? 0) > 0 && (rec.quota_used ?? 0) >= rec.quota) {
      return {
        ok: false,
        code: 'api_key_quota_exhausted',
        message: 'API key USD quota exhausted',
        status: 429,
        detail: { quota: rec.quota, quota_used: rec.quota_used },
      }
    }
    // sub2api rate windows: limit > 0 and the current window is still open
    for (const [limitKey, usageKey, startKey, ms] of [
      ['rate_limit_5h', 'usage_5h', 'window_5h_start', 5 * 3600_000],
      ['rate_limit_1d', 'usage_1d', 'window_1d_start', 24 * 3600_000],
      ['rate_limit_7d', 'usage_7d', 'window_7d_start', 7 * 24 * 3600_000],
    ]) {
      const limit = Number(rec[limitKey]) || 0
      if (limit <= 0) continue
      const start = rec[startKey] ? Date.parse(rec[startKey]) : NaN
      const windowOpen = Number.isFinite(start) && now - start < ms
      if (windowOpen && (Number(rec[usageKey]) || 0) >= limit) {
        return {
          ok: false,
          code: 'api_key_rate_limit',
          message: `API key ${limitKey.replace('rate_limit_', '')} spend limit exceeded`,
          status: 429,
          detail: { limit, used: Number(rec[usageKey]) || 0 },
        }
      }
    }
    if (rec.rpm > 0) {
      const n = state ? state.rpmCount : this._rpmCount(rec.id, now)
      if (n >= rec.rpm) {
        return {
          ok: false,
          code: 'api_key_rate_limit',
          message: `API key rate limit exceeded (${rec.rpm}/min)`,
          status: 429,
          detail: { rpm: rec.rpm, current: n },
          ...(state?.retryAfterMs ? { retry_after_ms: state.retryAfterMs } : {}),
        }
      }
    }
    const inflight = state ? state.inflight : this.inflight.get(rec.id) || 0
    if (rec.max_concurrency > 0 && inflight >= rec.max_concurrency) {
      return {
        ok: false,
        code: 'api_key_concurrency_limit',
        message: `API key concurrency limit (${rec.max_concurrency})`,
        status: 429,
        detail: { inflight, max: rec.max_concurrency },
      }
    }
    // sub2api user-level cap: sum of inflight across all of the owner's keys.
    // The operator (admin) is never capped: its traffic is the platform's own.
    if (rec.user_id) {
      const cap = owner?.role === 'admin' ? 0 : Number(owner?.concurrency) || 0
      if (cap > 0) {
        let total = state ? state.userInflight : 0
        if (!state)
          for (const k of ownedKeys) {
            if (k.user_id === rec.user_id) total += this.inflight.get(k.id) || 0
          }
        if (total >= cap) {
          return {
            ok: false,
            code: 'user_concurrency_limit',
            message: `User concurrency limit (${cap})`,
            status: 429,
            detail: { inflight: total, max: cap },
          }
        }
      }
    }
    if (reserve) {
      this.inflight.set(rec.id, (this.inflight.get(rec.id) || 0) + 1)
      const arr = this.rpmBuckets.get(rec.id) || []
      arr.push(now)
      this.rpmBuckets.set(rec.id, arr)
    }
    return { ok: true }
  }

  async acquire(rec, now = Date.now()) {
    return this.canAccept(rec, now, { reserve: true })
  }

  /**
   * Reserve before starting work, settle billable usage with { reservation },
   * then await release in the request's outer finally. A failed settlement
   * must retain its reservation until a fenced recovery can reconcile it.
   */
  async reserve(rec) {
    if (!this.sharedAdmission) {
      const gate = await this.acquire(rec)
      if (!gate.ok) return gate
      let released = false
      return {
        ok: true,
        shared: false,
        record: rec,
        release: async () => {
          if (released) return
          released = true
          this.release(rec)
        },
      }
    }
    const admissions = this.admissions
    const gate = await admissions.reserve(rec?.id, this.admissionOwnerId, (current, state) => {
      if (current && rec.key_hash !== current.key_hash) {
        return { ok: false, code: 'invalid_api_key', message: 'Invalid credentials', status: 401 }
      }
      // Scope checks happen before this gate. Require authentication again
      // if an operator changed the policy while this request was prepared.
      if (
        current &&
        ['category', 'group_type', 'allowed_vms', 'vm_pool_id', 'user_id', 'group_id'].some(
          (field) => (rec[field] ?? null) !== (current[field] ?? null),
        )
      ) {
        return { ok: false, code: 'api_key_changed', message: 'API key policy changed; retry the request', status: 403 }
      }
      return this.canAccept(current, state.now, { state })
    })
    if (!gate.ok) return gate
    let settled = false
    return {
      ...gate,
      shared: true,
      get settled() {
        return settled
      },
      _markSettled() {
        settled = true
      },
      release: () => admissions.release(gate),
    }
  }

  release(recOrId) {
    const id = typeof recOrId === 'string' ? recOrId : recOrId?.id
    if (!id) return
    const n = (this.inflight.get(id) || 0) - 1
    if (n <= 0) this.inflight.delete(id)
    else this.inflight.set(id, n)
  }

  async recordUsage(recOrId, usage = {}, { model = null, rateMultiplier = 1, officialCost, reservation } = {}) {
    const id = typeof recOrId === 'string' ? recOrId : recOrId?.id
    if (!(await this.repo.getById(id))) return null
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
    // key quota/windows track actual (group-rated) spend, sub2api-style
    const rate = Number.isFinite(Number(rateMultiplier)) ? Number(rateMultiplier) : 1
    const cost = billed * rate
    const write = () =>
      this.repo.recordUsage(id, {
        tokens_in: integerValue(normalized.input_tokens ?? normalized.tokens_in),
        tokens_out: integerValue(normalized.output_tokens ?? normalized.tokens_out),
        cache_read_tokens: integerValue(normalized.cache_read_input_tokens ?? normalized.cache_read_tokens),
        cache_creation_tokens: integerValue(normalized.cache_creation_input_tokens ?? normalized.cache_creation_tokens),
        cost,
      })
    if (reservation?.shared) {
      const rec = await this.admissions.settle(id, reservation, write)
      if (rec) reservation._markSettled?.()
      return rec
    }
    return write()
  }

  async snapshot() {
    const keys = await this.list({ reveal: false })
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
