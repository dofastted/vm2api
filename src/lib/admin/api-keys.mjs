/**
 * Multi API-key store (sub2api-inspired, SQLite-backed).
 *
 * Fields aligned to sub2api basics:
 *   name, status, expires_at, quota (+ used), rate windows → rpm,
 *   concurrency (per-key, sub2api puts this on User).
 *
 * Master env key KIN_API_KEY is separate and unlimited.
 * Managed keys live in the `api_keys` table (see lib/db/).
 * Transient state (inflight concurrency, RPM buckets) stays in memory,
 * mirroring sub2api's Redis-transient split.
 *
 * Auth always goes through `key_hash` (HMAC). `key_secret` is a separate
 * at-rest copy of the plaintext — encrypted with KIN_DB_SECRET when set — so
 * the panel can re-reveal a key for copying after creation.
 */

import { keyScopeFromRecord, normalizeKeyScope } from './key-scope.mjs'
import { normalizeKeyAllowedModels, parseKeyAllowedModels } from './key-models.mjs'
import { VmPoolsRepo } from '../db/repos/vm-pools-repo.mjs'
import crypto from 'node:crypto'
import { resolveStoreDb } from '../db/database.mjs'
import { ApiKeysRepo } from '../db/repos/api-keys-repo.mjs'
import { maybeEncrypt, maybeDecrypt } from '../db/secure.mjs'
import { calculateCost, normalizeUsage } from './pricing.mjs'
import { UsersRepo } from '../db/repos/users-repo.mjs'

const KEY_PREFIX = 'sk-vm-'
const HASH_MARKER = 'hmac:'
// sub2api USD rate windows; ApiKeysRepo opens one at the first spend.
const RATE_WINDOWS = [
  { name: '5h', limit: 'rate_limit_5h', usage: 'usage_5h', start: 'window_5h_start', ms: 5 * 3600_000 },
  { name: '1d', limit: 'rate_limit_1d', usage: 'usage_1d', start: 'window_1d_start', ms: 24 * 3600_000 },
  { name: '7d', limit: 'rate_limit_7d', usage: 'usage_7d', start: 'window_7d_start', ms: 7 * 24 * 3600_000 },
]

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
    category: rec.category === 'api' ? 'api' : 'oauth',
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
  constructor({ dataDir, db, hashSecret } = {}) {
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
  }

  /** sub2api: an api key of a disabled/deleted user must not authenticate. */
  _ownerActive(rec) {
    if (!rec?.user_id) return true // legacy unowned keys keep working
    try {
      const owner = this.users.getById(rec.user_id)
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
  }

  list({ reveal = false } = {}) {
    const names = new Map()
    try {
      for (const pool of new VmPoolsRepo(this.db).list()) names.set(pool.id, pool.name)
    } catch {
      // A database opened before migration 034 still lists keys.
    }
    return this.repo.list().map((k) => {
      const v = publicKeyView(k, { reveal })
      v.inflight = this.inflight.get(k.id) || 0
      if (v.vm_pool_id) v.vm_pool_name = names.get(v.vm_pool_id) || null
      return v
    })
  }

  getById(id) {
    return this.repo.getById(id)
  }

  authenticate(token) {
    if (!token) return { ok: false, reason: 'missing' }
    const hash = this._hash(token)
    const indexed = this.repo.getByHash(hash)
    if (indexed) {
      if (!this._ownerActive(indexed)) return { ok: false, reason: 'user_disabled' }
      return { ok: true, record: indexed }
    }
    // One-time migration for legacy plaintext rows.
    for (const rec of this.repo.list()) {
      if (String(rec.key || '').startsWith(HASH_MARKER)) continue
      if (timingSafeEqualStr(token, rec.key)) {
        rec.key_hash = hash
        rec.key_prefix = String(token).slice(0, 10)
        rec.key_suffix = String(token).slice(-4)
        rec.key_secret = maybeEncrypt(token)
        rec.key = HASH_MARKER + hash
        return { ok: true, record: this.repo.update(rec) }
      }
    }
    return { ok: false, reason: 'invalid' }
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
        normalizeKeyScope(
          {
            group_type: input.group_type,
            allowed_vms: input.allowed_vms,
            category: String(input.category || 'oauth').toLowerCase() === 'api' ? 'api' : 'oauth',
            ...(Object.prototype.hasOwnProperty.call(input, 'vm_pool_id') ? { vm_pool_id: input.vm_pool_id } : {}),
          },
          { isApi: String(input.category || 'oauth').toLowerCase() === 'api' },
        ),
      ),
      allowed_models: JSON.stringify(normalizeKeyAllowedModels(input.allowed_models)),
    }
    if (rec.expires_at && Number.isNaN(Date.parse(rec.expires_at))) {
      throw Object.assign(new Error('invalid expires_at'), { code: 'invalid_expires_at' })
    }
    const stored = this.repo.insert(rec)
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
    }
    // recover from quota_exhausted whenever spend is back under the cap
    if (
      rec.status === 'quota_exhausted' &&
      !((rec.quota ?? 0) > 0 && (rec.quota_used ?? 0) >= rec.quota) &&
      !(rec.quota_requests > 0 && (rec.quota_requests_used ?? 0) >= rec.quota_requests)
    ) {
      rec.status = 'active'
    }
    if (patch.category != null) {
      rec.category = String(patch.category).toLowerCase() === 'api' ? 'api' : 'oauth'
    }
    const scope = normalizeKeyScope(patch, { partial: true, current: rec, isApi: rec.category === 'api' })
    if (scope) Object.assign(rec, storedKeyScope(scope))
    if (Object.hasOwn(patch, 'allowed_models')) {
      rec.allowed_models = JSON.stringify(normalizeKeyAllowedModels(patch.allowed_models))
    }
    rec.updated_at = nowIso()
    return this.repo.update(rec)
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
    rec.key = HASH_MARKER + keyHash
    rec.key_hash = keyHash
    rec.key_prefix = key.slice(0, 10)
    rec.key_suffix = key.slice(-4)
    rec.key_secret = maybeEncrypt(key)
    rec.updated_at = nowIso()
    const stored = this.repo.update(rec)
    return { ...stored, key, _plain_key: key }
  }

  remove(id) {
    const removed = this.repo.remove(id)
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
  canAccept(rec, now = Date.now()) {
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
    if (rec.quota_requests > 0 && (rec.quota_requests_used ?? 0) >= rec.quota_requests) {
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
    for (const win of RATE_WINDOWS) {
      const w = rateWindow(rec, win, now)
      if (w.limit > 0 && w.open && w.used >= w.limit) {
        return {
          ok: false,
          code: 'api_key_rate_limit',
          message: `API key ${win.name} spend limit exceeded`,
          status: 429,
          detail: { limit: w.limit, used: w.used },
        }
      }
    }
    if (rec.rpm > 0) {
      const n = this._rpmCount(rec.id, now)
      if (n >= rec.rpm) {
        return {
          ok: false,
          code: 'api_key_rate_limit',
          message: `API key rate limit exceeded (${rec.rpm}/min)`,
          status: 429,
          detail: { rpm: rec.rpm, current: n },
        }
      }
    }
    const inflight = this.inflight.get(rec.id) || 0
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
      const cap = this._userConcurrencyCap(rec.user_id)
      if (cap > 0) {
        const total = this._userInflight(rec.user_id)
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
    return { ok: true }
  }

  /** users.concurrency of the key owner; 0 = none. The admin operator is never capped. */
  _userConcurrencyCap(userId) {
    let owner = null
    try {
      owner = this.users.getById(userId)
    } catch {
      return 0
    }
    return owner?.role === 'admin' ? 0 : Number(owner?.concurrency) || 0
  }

  _userInflight(userId) {
    let total = 0
    for (const k of this.repo.list()) {
      if (k.user_id === userId) total += this.inflight.get(k.id) || 0
    }
    return total
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
      blocked_by: gate.ok ? null : { code: gate.code, message: gate.message, status: gate.status },
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
    const arr = this.rpmBuckets.get(id) || []
    arr.push(now)
    this.rpmBuckets.set(id, arr)
    return { ok: true }
  }

  release(recOrId) {
    const id = typeof recOrId === 'string' ? recOrId : recOrId?.id
    if (!id) return
    const n = (this.inflight.get(id) || 0) - 1
    if (n <= 0) this.inflight.delete(id)
    else this.inflight.set(id, n)
  }

  recordUsage(recOrId, usage = {}, { model = null, rateMultiplier = 1, officialCost } = {}) {
    const id = typeof recOrId === 'string' ? recOrId : recOrId?.id
    if (!this.repo.getById(id)) return null
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
    const rec = this.repo.recordUsage(id, {
      tokens_in: Number(normalized.input_tokens) || Number(normalized.tokens_in) || 0,
      tokens_out: Number(normalized.output_tokens) || Number(normalized.tokens_out) || 0,
      cache_read_tokens: Number(normalized.cache_read_input_tokens ?? normalized.cache_read_tokens) || 0,
      cache_creation_tokens: Number(normalized.cache_creation_input_tokens ?? normalized.cache_creation_tokens) || 0,
      cost,
    })
    // sub2api: the billing write flips the key when the USD quota runs out
    if (rec && rec.status === 'active' && (rec.quota ?? 0) > 0 && (rec.quota_used ?? 0) >= rec.quota) {
      this.repo.update({ ...rec, status: 'quota_exhausted', updated_at: nowIso() })
    }
    return rec
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
