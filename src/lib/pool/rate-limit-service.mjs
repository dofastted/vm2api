/**
 * Account scheduling state from upstream results.
 *
 * One writer for the hard columns the scheduler gates on:
 *   429 → rate_limit_reset_at (+ session_window rejected)
 *   529 → overload_until
 * An incomplete hop is a request failure. It does not park the account.
 * Passive Extra utilization stays in account-quota for the panel; it never
 * clears these columns. Only a live `5h-status=allowed` header or the reset
 * passing lifts a rate limit.
 */
import { getCacheRuntime } from '../cache/index.mjs'
import { getDb, getPgPool, isDbOpen } from '../db/database.mjs'
import { extraHeadersFromLimitError, parseResetMs, WINDOW_5H_MS } from './quota-window.mjs'

export const DEFAULT_RATE_LIMIT = Object.freeze({
  fallback_cooldown_min: 30,
  overload_cooldown_min: 10,
  empty_response_cooldown_sec: 60,
  // Account or model 429s can ask /usage, at most once per account per interval.
  usage_probe_min_interval_sec: 180,
})

export const EMPTY_RESPONSE_REASON = 'empty_response'

const SESSION_WINDOW_MIN_AGE_MS = WINDOW_5H_MS
const SESSION_WINDOW_MAX_AHEAD_MS = 7 * 24 * 3600_000
const SESSION_WINDOW_DEDUPE_MS = 60_000
const MAX_LOCAL_RPM_BUCKETS = 4096
const DEFAULT_PG_FLUSH_INTERVAL_MS = 1000
const MAX_DIRTY_WINDOW_BATCH = 64

function toIsoMs(ms) {
  if (ms == null) return null
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(Math.min(n, 8.64e15)).toISOString()
}

function positive(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function normalizeRateLimitConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    fallback_cooldown_min: positive(src.fallback_cooldown_min, DEFAULT_RATE_LIMIT.fallback_cooldown_min),
    overload_cooldown_min: positive(src.overload_cooldown_min, DEFAULT_RATE_LIMIT.overload_cooldown_min),
    empty_response_cooldown_sec: positive(
      src.empty_response_cooldown_sec,
      DEFAULT_RATE_LIMIT.empty_response_cooldown_sec,
    ),
    usage_probe_min_interval_sec: positive(
      src.usage_probe_min_interval_sec,
      DEFAULT_RATE_LIMIT.usage_probe_min_interval_sec,
    ),
  }
}

function header(headers, name) {
  const target = String(name).toLowerCase()
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value
  }
  return null
}

function bodyMessage(body) {
  if (typeof body === 'string') return body
  return String(body?.error?.message || body?.message || '')
}

function isRejected(value) {
  const s = String(value || '').toLowerCase()
  return s === 'rejected' || s === 'rate_limited'
}

function futureReset(raw, now) {
  const ms = parseResetMs(raw)
  return Number.isFinite(ms) && ms > now ? ms : null
}

/**
 * 429 reset: exhausted 7d → exhausted 5h → aggregate → soonest window → null.
 */
export function anthropic429Reset(headers = {}, now = Date.now()) {
  const reset5h = futureReset(header(headers, 'anthropic-ratelimit-unified-5h-reset'), now)
  const reset7d = futureReset(header(headers, 'anthropic-ratelimit-unified-7d-reset'), now)
  const hit7d = isRejected(header(headers, 'anthropic-ratelimit-unified-7d-status'))
  const hit5h = isRejected(header(headers, 'anthropic-ratelimit-unified-5h-status'))
  if (hit7d && reset7d) return { resetAt: reset7d, window: '7d', fiveHourReset: reset5h }
  if (hit5h && reset5h) return { resetAt: reset5h, window: '5h', fiveHourReset: reset5h }
  const aggregate = futureReset(header(headers, 'anthropic-ratelimit-unified-reset'), now)
  if (aggregate) return { resetAt: aggregate, window: null, fiveHourReset: reset5h }
  const retryAfter = Number(header(headers, 'retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return { resetAt: now + retryAfter * 1000, window: null, fiveHourReset: reset5h }
  }
  return null
}

export function infer429Window(headers = {}, parsed = null) {
  if (parsed?.window) return parsed.window
  if (isRejected(header(headers, 'anthropic-ratelimit-unified-7d-status'))) return '7d'
  const claim = String(header(headers, 'anthropic-ratelimit-unified-representative-claim') || '').toLowerCase()
  if (/seven_day_overage_included|7d_oi/.test(claim)) return '7d_oi'
  if (/seven_day|7d/.test(claim)) return '7d'
  return '5h'
}

export function inferRateLimitWindow(result = {}, now = Date.now()) {
  const headers = extraHeadersFromLimitError(bodyMessage(result?.body), result?.headers || {}, now)
  const parsed = anthropic429Reset(headers, now)
  return infer429Window(headers, parsed)
}

export class RateLimitService {
  constructor({
    runtimeRepo = null,
    accountQuota = null,
    config = {},
    onUsageProbe = null,
    pgPool = null,
    flushIntervalMs = DEFAULT_PG_FLUSH_INTERVAL_MS,
  } = {}) {
    this.runtimeRepo = runtimeRepo
    this.accountQuota = accountQuota
    this.config = normalizeRateLimitConfig(config)
    this.onUsageProbe = onUsageProbe
    this._explicitPgPool = pgPool || null
    this._flushIntervalMs = Math.max(25, Number(flushIntervalMs) || DEFAULT_PG_FLUSH_INTERVAL_MS)
    this.localRpmBuckets = new Map() // `${scope}:${id}:${bucket}` -> { count, expiresAtMs }
    this._lastWindowPatch = new Map() // accountId -> { vmId, status, start, end, at }
    this._l1WindowState = new Map() // accountId -> merged L1 window/hard-block state (PG async mode)
    this._dirtyWindows = new Map() // accountId -> merged pending PG patch
    this._flushTimer = null
    this._flushChain = Promise.resolve()
  }

  _resolvePgPool() {
    if (this._explicitPgPool && typeof this._explicitPgPool.query === 'function') {
      return this._explicitPgPool
    }
    const db = this.runtimeRepo?.db
    if (db?.engine === 'postgres' && isDbOpen() && db === getDb()) {
      const pool = getPgPool()
      if (pool && typeof pool.query === 'function') return pool
    }
    return null
  }

  /** Read merged L1 window / hard-block state without blocking on sync DB RPCs. */
  getL1WindowState(accountId) {
    if (!accountId) return null
    const local = this._l1WindowState.get(accountId) || null
    let snapState = null
    try {
      const peek = getCacheRuntime()?.scheduler?.peekSchedulingSnapshot?.()
      snapState = peek?.snapshot?.byAccountId?.get?.(accountId)?.state || null
    } catch {}
    if (local && snapState) {
      const snapUpdatedMs = snapState.updated_at ? Date.parse(snapState.updated_at) : 0
      const merged = { ...snapState, ...local }
      // If another instance recorded a newer 429 after our local clear, honor the remote block.
      if (
        local.rate_limit_reset_at === null &&
        Number(snapState.rate_limit_reset_at) > 0 &&
        Number.isFinite(snapUpdatedMs) &&
        snapUpdatedMs > (local._at || 0)
      ) {
        merged.rate_limit_reset_at = snapState.rate_limit_reset_at
        merged.rate_limited_at = snapState.rate_limited_at
      }
      return merged
    }
    return local || snapState || null
  }

  _applyL1WindowPatch(accountId, patch, now = Date.now()) {
    const prev = this._l1WindowState.get(accountId) || { account_id: accountId }
    const next = { ...prev, _at: now }
    if (patch.vmId) next.vm_id = patch.vmId
    if (patch.rateLimitedAt !== undefined) next.rate_limited_at = patch.rateLimitedAt
    if (patch.rateLimitResetAt !== undefined) next.rate_limit_reset_at = patch.rateLimitResetAt
    if (patch.overloadUntil !== undefined) next.overload_until = patch.overloadUntil
    if (patch.sessionWindowStart !== undefined) next.session_window_start = patch.sessionWindowStart
    if (patch.sessionWindowEnd !== undefined) next.session_window_end = patch.sessionWindowEnd
    if (patch.sessionWindowStatus !== undefined) next.session_window_status = patch.sessionWindowStatus
    this._l1WindowState.set(accountId, next)

    // Keep warm L1 SchedulerSnapshotCache coherent in-process immediately.
    try {
      const peek = getCacheRuntime()?.scheduler?.peekSchedulingSnapshot?.()
      const snapEntry = peek?.snapshot?.byAccountId?.get?.(accountId)
      if (snapEntry?.state && typeof snapEntry.state === 'object') {
        if (patch.vmId && !snapEntry.state.vm_id) snapEntry.state.vm_id = patch.vmId
        if (patch.rateLimitedAt !== undefined) snapEntry.state.rate_limited_at = patch.rateLimitedAt
        if (patch.rateLimitResetAt !== undefined) snapEntry.state.rate_limit_reset_at = patch.rateLimitResetAt
        if (patch.overloadUntil !== undefined) snapEntry.state.overload_until = patch.overloadUntil
        if (patch.sessionWindowStart !== undefined) snapEntry.state.session_window_start = patch.sessionWindowStart
        if (patch.sessionWindowEnd !== undefined) snapEntry.state.session_window_end = patch.sessionWindowEnd
        if (patch.sessionWindowStatus !== undefined) snapEntry.state.session_window_status = patch.sessionWindowStatus
      }
    } catch {}
    return next
  }

  _mergeDirtyWindowPatch(accountId, patch, now = Date.now()) {
    const prev = this._dirtyWindows.get(accountId) || { accountId }
    const merged = { ...prev, accountId, updatedAt: new Date(now).toISOString() }
    if (patch.vmId) merged.vmId = patch.vmId
    if (patch.rateLimitedAt !== undefined) merged.rateLimitedAt = patch.rateLimitedAt
    if (patch.rateLimitResetAt !== undefined) merged.rateLimitResetAt = patch.rateLimitResetAt
    if (patch.overloadUntil !== undefined) merged.overloadUntil = patch.overloadUntil
    if (patch.sessionWindowStart !== undefined) merged.sessionWindowStart = patch.sessionWindowStart
    if (patch.sessionWindowEnd !== undefined) merged.sessionWindowEnd = patch.sessionWindowEnd
    if (patch.sessionWindowStatus !== undefined) merged.sessionWindowStatus = patch.sessionWindowStatus
    this._dirtyWindows.set(accountId, merged)
  }

  _scheduleWindowFlush() {
    if (this._dirtyWindows.size >= MAX_DIRTY_WINDOW_BATCH) {
      if (this._flushTimer) {
        clearTimeout(this._flushTimer)
        this._flushTimer = null
      }
      void this.flushWindowWrites().catch(() => {})
      return
    }
    if (this._flushTimer) return
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null
      void this.flushWindowWrites().catch(() => {})
    }, this._flushIntervalMs)
    if (typeof this._flushTimer.unref === 'function') this._flushTimer.unref()
  }

  _enqueueWindowPatchPg(accountId, patch, { now = Date.now(), immediate = false, eventType = null } = {}) {
    this._applyL1WindowPatch(accountId, patch, now)
    this._mergeDirtyWindowPatch(accountId, patch, now)
    if (immediate) {
      if (eventType) {
        try {
          getCacheRuntime()?.scheduler?.bumpRevision?.({ eventType, accountId })
        } catch {}
      }
      if (this._flushTimer) {
        clearTimeout(this._flushTimer)
        this._flushTimer = null
      }
      void this.flushWindowWrites().catch(() => {})
    } else {
      this._scheduleWindowFlush()
    }
  }

  async _applyWindowBatchToPg(pgPool, batch) {
    if (!batch.length) return 0
    const nowIso = new Date().toISOString()
    const ids = []
    const vmIds = []
    const setRlAt = []
    const rlAts = []
    const setRlReset = []
    const rlResets = []
    const setOverload = []
    const overloads = []
    const setWinStart = []
    const winStarts = []
    const setWinEnd = []
    const winEnds = []
    const setWinStatus = []
    const winStatuses = []
    const updatedAts = []
    const rtIds = []
    const rtVmIds = []
    const rtUpdated = []

    for (const w of batch) {
      const id = String(w.accountId)
      const vmId = w.vmId ? String(w.vmId) : null
      const upd = w.updatedAt || nowIso
      ids.push(id)
      vmIds.push(vmId)
      setRlAt.push(w.rateLimitedAt !== undefined)
      rlAts.push(w.rateLimitedAt !== undefined ? toIsoMs(w.rateLimitedAt) : null)
      setRlReset.push(w.rateLimitResetAt !== undefined)
      rlResets.push(w.rateLimitResetAt !== undefined ? toIsoMs(w.rateLimitResetAt) : null)
      setOverload.push(w.overloadUntil !== undefined)
      overloads.push(w.overloadUntil !== undefined ? toIsoMs(w.overloadUntil) : null)
      setWinStart.push(w.sessionWindowStart !== undefined)
      winStarts.push(w.sessionWindowStart !== undefined ? toIsoMs(w.sessionWindowStart) : null)
      setWinEnd.push(w.sessionWindowEnd !== undefined)
      winEnds.push(w.sessionWindowEnd !== undefined ? toIsoMs(w.sessionWindowEnd) : null)
      setWinStatus.push(w.sessionWindowStatus !== undefined)
      winStatuses.push(w.sessionWindowStatus !== undefined ? (w.sessionWindowStatus ?? null) : null)
      updatedAts.push(upd)
      if (vmId) {
        rtIds.push(id)
        rtVmIds.push(vmId)
        rtUpdated.push(upd)
      }
    }

    await pgPool.query(
      `INSERT INTO accounts (id, vm_id, name, extra, created_at, updated_at)
      SELECT v.id, v.vm_id, v.id, '{}', v.updated_at, v.updated_at
      FROM UNNEST($1::text[], $2::text[], $3::text[]) AS v(id, vm_id, updated_at)
      ON CONFLICT (id) DO NOTHING`,
      [ids, vmIds, updatedAts],
    )
    await pgPool.query(
      `UPDATE accounts AS a
      SET
        vm_id = COALESCE(v.vm_id, a.vm_id),
        rate_limited_at = CASE WHEN v.set_rl_at THEN v.rate_limited_at ELSE a.rate_limited_at END,
        rate_limit_reset_at = CASE WHEN v.set_rl_reset THEN v.rate_limit_reset_at ELSE a.rate_limit_reset_at END,
        overload_until = CASE WHEN v.set_overload THEN v.overload_until ELSE a.overload_until END,
        session_window_start = CASE WHEN v.set_win_start THEN v.session_window_start ELSE a.session_window_start END,
        session_window_end = CASE WHEN v.set_win_end THEN v.session_window_end ELSE a.session_window_end END,
        session_window_status = CASE WHEN v.set_win_status THEN v.session_window_status ELSE a.session_window_status END,
        updated_at = v.updated_at
      FROM UNNEST(
        $1::text[], $2::text[],
        $3::boolean[], $4::text[],
        $5::boolean[], $6::text[],
        $7::boolean[], $8::text[],
        $9::boolean[], $10::text[],
        $11::boolean[], $12::text[],
        $13::boolean[], $14::text[],
        $15::text[]
      ) AS v(
        id, vm_id,
        set_rl_at, rate_limited_at,
        set_rl_reset, rate_limit_reset_at,
        set_overload, overload_until,
        set_win_start, session_window_start,
        set_win_end, session_window_end,
        set_win_status, session_window_status,
        updated_at
      )
      WHERE a.id = v.id`,
      [
        ids,
        vmIds,
        setRlAt,
        rlAts,
        setRlReset,
        rlResets,
        setOverload,
        overloads,
        setWinStart,
        winStarts,
        setWinEnd,
        winEnds,
        setWinStatus,
        winStatuses,
        updatedAts,
      ],
    )
    if (rtIds.length > 0) {
      await pgPool.query(
        `INSERT INTO account_runtime (account_id, vm_id, status, model_states_json, credential_generation, updated_at)
        SELECT v.account_id, v.vm_id, 'unknown', '{}', 0, v.updated_at
        FROM UNNEST($1::text[], $2::text[], $3::text[]) AS v(account_id, vm_id, updated_at)
        ON CONFLICT (account_id) DO UPDATE SET
          vm_id = COALESCE(EXCLUDED.vm_id, account_runtime.vm_id),
          updated_at = EXCLUDED.updated_at`,
        [rtIds, rtVmIds, rtUpdated],
      )
    }
    return batch.length
  }

  /** Drain all pending async PG window/rate-limit writes (serialized, fault-tolerant). */
  flushWindowWrites() {
    const run = async () => {
      const pgPool = this._resolvePgPool()
      if (!pgPool) {
        this._dirtyWindows.clear()
        return { flushed: 0, failed: 0 }
      }
      let flushed = 0
      for (let round = 0; round < 16; round += 1) {
        if (this._dirtyWindows.size === 0) break
        const entries = [...this._dirtyWindows.entries()]
        this._dirtyWindows.clear()
        const batch = entries.map(([, w]) => w)
        try {
          flushed += await this._applyWindowBatchToPg(pgPool, batch)
        } catch (err) {
          // Re-queue un-overwritten fields so transient PG glitches lose zero updates
          for (const [id, oldPatch] of entries) {
            const newer = this._dirtyWindows.get(id)
            this._dirtyWindows.set(id, newer ? { ...oldPatch, ...newer } : oldPatch)
          }
          return { flushed, failed: batch.length, error: err?.message ? String(err.message) : String(err) }
        }
      }
      return { flushed, failed: 0 }
    }
    const next = this._flushChain.then(run, run)
    this._flushChain = next.catch(() => {})
    return next
  }

  /** Stop debounce timer and drain pending PG window writes before shutdown. */
  async close() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    return await this.flushWindowWrites()
  }

  /**
   * Synchronous local fixed-window RPM check & increment (fallback when Redis is unavailable).
   */
  checkRpm(scope, id, limit, { windowSec = 60, now = Date.now() } = {}) {
    const cap = Number(limit) || 0
    const win = Math.max(1, Math.floor(Number(windowSec) || 60))
    if (cap <= 0 || !id) {
      return { allowed: true, current: 0, limit: 0, remaining: null, retryAfterSec: 0, resetAt: 0 }
    }
    const nowSec = Math.floor(now / 1000)
    const bucket = Math.floor(nowSec / win)
    const resetSec = (bucket + 1) * win
    const retryAfterSec = Math.max(1, resetSec - nowSec)
    const key = `${String(scope || 'account')}:${String(id)}:${bucket}`
    if (this.localRpmBuckets.size >= MAX_LOCAL_RPM_BUCKETS) {
      for (const [k, v] of this.localRpmBuckets) {
        if (v.expiresAtMs <= now) this.localRpmBuckets.delete(k)
      }
    }
    const cur = this.localRpmBuckets.get(key)
    const count = cur && cur.expiresAtMs > now ? cur.count : 0
    if (count >= cap) {
      return {
        allowed: false,
        current: count,
        limit: cap,
        remaining: 0,
        retryAfterSec,
        resetAt: resetSec * 1000,
      }
    }
    const next = count + 1
    this.localRpmBuckets.set(key, { count: next, expiresAtMs: (resetSec + win) * 1000 })
    return {
      allowed: true,
      current: next,
      limit: cap,
      remaining: Math.max(0, cap - next),
      retryAfterSec: 0,
      resetAt: resetSec * 1000,
    }
  }

  /**
   * Cross-instance RPM check & increment backed by Redis `ConcurrencyCache.checkAndIncrRpm`
   * when Redis is ready; Fail-Opens seamlessly to local Map `checkRpm()` when Redis is absent.
   */
  async checkRpmAsync(scope, id, limit, { windowSec = 60, now = Date.now() } = {}) {
    const cap = Number(limit) || 0
    const win = Math.max(1, Math.floor(Number(windowSec) || 60))
    if (cap <= 0 || !id) {
      return { allowed: true, current: 0, limit: 0, remaining: null, retryAfterSec: 0, resetAt: 0 }
    }
    const cache = getCacheRuntime()
    if (cache?.client?.hasRedis) {
      return cache.concurrency.checkAndIncrRpm(String(scope || 'account'), String(id), cap, win)
    }
    return this.checkRpm(scope, id, cap, { windowSec: win, now })
  }

  /** Read current window RPM count (Redis when ready, local Map fallback). */
  async getRpmCountAsync(scope, id, { windowSec = 60, now = Date.now() } = {}) {
    if (!id) return 0
    const win = Math.max(1, Math.floor(Number(windowSec) || 60))
    const cache = getCacheRuntime()
    if (cache?.client?.hasRedis) {
      return cache.concurrency.getRpmCount(String(scope || 'account'), String(id), win)
    }
    const bucket = Math.floor(Math.floor(now / 1000) / win)
    const entry = this.localRpmBuckets.get(`${String(scope || 'account')}:${String(id)}:${bucket}`)
    return entry && entry.expiresAtMs > now ? entry.count : 0
  }

  setConfig(config = {}) {
    this.config = normalizeRateLimitConfig(config)
  }

  /**
   * Write the hard scheduling column for this failure. Return the block, or null.
   * The classifier decides the scope; a model / Fable / RPM 429 stays a short cooldown.
   * An unknown bare 429 writes no hard block: the scope is unproven.
   * A 429 not scoped to the request asks the official usage probe (throttled per account)
   * which window is spent: a `rejected` window then keeps the scheduler off the
   * account until its reset, a short limit just passes. Retry-After alone
   * never proves a plan window.
   */
  handleUpstreamError({
    accountId,
    vmId,
    result = {},
    policy = null,
    now = Date.now(),
    requestStartedAt = null,
    resetGenerations = null,
  } = {}) {
    if (!accountId || (!this.runtimeRepo && !this._resolvePgPool()) || result?.committed || policy?.scope === 'request')
      return null
    const reason = String(policy?.reason || '')
    if (reason === 'fable_rate_limited') {
      if (
        this.accountQuota?.isPreResetResponse?.(accountId, '7d_oi', {
          requestStartedAt,
          resetGenerations,
        })
      ) {
        return { kind: 'pre_reset_ignored', ignored: true, window: '7d_oi' }
      }
      if (Number(result?.status) === 429) {
        this.requestUsageProbe({ accountId, vmId, now })
      }
      return null
    }
    if (policy?.scope === 'account' && reason === 'account_quota_exhausted') {
      const headers = extraHeadersFromLimitError(bodyMessage(result.body), result.headers || {}, now)
      const parsed = anthropic429Reset(headers, now)
      const targetWindow = infer429Window(headers, parsed)
      if (
        this.accountQuota?.isPreResetResponse?.(accountId, targetWindow, {
          requestStartedAt,
          resetGenerations,
        })
      ) {
        return { kind: 'pre_reset_ignored', ignored: true, window: targetWindow }
      }
      if (Number(result?.status) === 429) {
        this.requestUsageProbe({ accountId, vmId, now })
      }
      return this.handle429({ accountId, vmId, result, now, requestStartedAt, resetGenerations })
    }
    if (Number(result?.status) === 429) {
      this.requestUsageProbe({ accountId, vmId, now })
    }
    if (reason === 'rate_limited_unknown') return null
    if (reason === 'provider_overloaded' && Number(result?.status) === 529) {
      return this.handle529({ accountId, vmId, now })
    }
    return null
  }

  /** One usage probe per account per `usage_probe_min_interval_sec`. Returns whether it asked. */
  requestUsageProbe({ accountId, vmId, now = Date.now() }) {
    if (typeof this.onUsageProbe !== 'function') return false
    const key = String(accountId || vmId || '')
    if (!key) return false
    if (!this.probeAskedAt) this.probeAskedAt = new Map()
    const gapMs = Number(this.config.usage_probe_min_interval_sec) * 1000
    const last = this.probeAskedAt.get(key)
    if (last != null && now - last < gapMs) return false
    this.probeAskedAt.set(key, now)
    if (this.probeAskedAt.size > 1000) {
      for (const [id, at] of this.probeAskedAt) if (now - at >= gapMs) this.probeAskedAt.delete(id)
    }
    try {
      this.onUsageProbe({ accountId, vmId })
    } catch {}
    return true
  }

  /** Redis-shared throttled usage probe (falls back to local Map when Redis is absent). */
  async requestUsageProbeAsync({ accountId, vmId, now = Date.now() }) {
    if (typeof this.onUsageProbe !== 'function') return false
    const key = String(accountId || vmId || '')
    if (!key) return false
    const gapSec = Math.max(1, Math.round(Number(this.config.usage_probe_min_interval_sec) || 180))
    const cache = getCacheRuntime()
    if (cache?.client?.hasRedis) {
      const verdict = await cache.concurrency.checkAndIncrRpm('usage_probe', key, 1, gapSec)
      if (!verdict.allowed) return false
      if (!this.probeAskedAt) this.probeAskedAt = new Map()
      this.probeAskedAt.set(key, now)
      try {
        this.onUsageProbe({ accountId, vmId })
      } catch {}
      return true
    }
    return this.requestUsageProbe({ accountId, vmId, now })
  }

  handle429({ accountId, vmId, result = {}, now = Date.now(), requestStartedAt = null, resetGenerations = null }) {
    const headers = extraHeadersFromLimitError(bodyMessage(result.body), result.headers || {}, now)
    const parsed = anthropic429Reset(headers, now)
    const targetWindow = infer429Window(headers, parsed)
    if (
      this.accountQuota?.isPreResetResponse?.(accountId, targetWindow, {
        requestStartedAt,
        resetGenerations,
      })
    ) {
      return null
    }
    const fallback = !parsed
    const resetAt = parsed?.resetAt || now + this.config.fallback_cooldown_min * 60_000
    const windowEnd = parsed?.fiveHourReset || (parsed?.window === '7d' ? null : resetAt)
    const patch = {
      vmId,
      rateLimitedAt: now,
      rateLimitResetAt: resetAt,
      ...(windowEnd ? { sessionWindowStart: windowEnd - WINDOW_5H_MS, sessionWindowEnd: windowEnd } : {}),
      sessionWindowStatus: 'rejected',
    }
    this._lastWindowPatch.delete(accountId)
    if (this._resolvePgPool()) {
      this._enqueueWindowPatchPg(accountId, patch, { now, immediate: true, eventType: 'rate_limit_429' })
    } else {
      this.runtimeRepo.updateWindow?.(accountId, patch)
    }
    try {
      this.accountQuota?.ingestHeaders?.(accountId, headers, null, {
        exhausted: true,
        status: 429,
        countRequest: false,
        now,
        ...(requestStartedAt != null ? { requestStartedAt } : {}),
        ...(resetGenerations ? { resetGenerations } : {}),
      })
    } catch {}
    if (fallback) this.requestUsageProbe({ accountId, vmId, now })
    return { kind: 'rate_limited', until: resetAt, window: parsed?.window || null, fallback }
  }

  handle529({ accountId, vmId, now = Date.now() }) {
    const until = now + this.config.overload_cooldown_min * 60_000
    const patch = { vmId, overloadUntil: until }
    this._lastWindowPatch.delete(accountId)
    if (this._resolvePgPool()) {
      this._enqueueWindowPatchPg(accountId, patch, { now, immediate: true, eventType: 'overload_529' })
    } else {
      this.runtimeRepo.updateWindow?.(accountId, patch)
    }
    return { kind: 'overloaded', until }
  }

  /**
   * Update the session window on every response with live headers.
   * An out-of-range reset is ignored. `allowed` is the only early unblock.
   */
  updateSessionWindow({
    accountId,
    vmId = null,
    headers = {},
    now = Date.now(),
    requestStartedAt = null,
    resetGenerations = null,
  } = {}) {
    const pgPool = this._resolvePgPool()
    if (!accountId || (!this.runtimeRepo && !pgPool)) return false
    if (
      this.accountQuota?.isPreResetResponse?.(accountId, '5h', {
        requestStartedAt,
        resetGenerations,
      })
    ) {
      return false
    }
    const status = String(header(headers, 'anthropic-ratelimit-unified-5h-status') || '').toLowerCase()
    if (!status) return false
    const patch = { vmId, sessionWindowStatus: status }
    const resetMs = parseResetMs(header(headers, 'anthropic-ratelimit-unified-5h-reset'))
    if (
      Number.isFinite(resetMs) &&
      resetMs >= now - SESSION_WINDOW_MIN_AGE_MS &&
      resetMs <= now + SESSION_WINDOW_MAX_AHEAD_MS
    ) {
      patch.sessionWindowStart = resetMs - WINDOW_5H_MS
      patch.sessionWindowEnd = resetMs
    }
    const current = pgPool ? this.getL1WindowState(accountId) : this.runtimeRepo.get?.(accountId) || null
    const limited = Number(current?.rate_limit_reset_at) > now
    const sevenDayOpen = !isRejected(header(headers, 'anthropic-ratelimit-unified-7d-status'))
    if (status === 'allowed' && sevenDayOpen && limited) {
      patch.rateLimitResetAt = null
    }
    const shouldDedupe = Boolean((pgPool || this.runtimeRepo?.db) && patch.rateLimitResetAt !== null)
    if (shouldDedupe) {
      const prev = this._lastWindowPatch.get(accountId)
      if (
        prev &&
        prev.vmId === (vmId || null) &&
        prev.status === status &&
        prev.start === (patch.sessionWindowStart ?? null) &&
        prev.end === (patch.sessionWindowEnd ?? null) &&
        now - prev.at < SESSION_WINDOW_DEDUPE_MS
      ) {
        return false
      }
      this._lastWindowPatch.set(accountId, {
        vmId: vmId || null,
        status,
        start: patch.sessionWindowStart ?? null,
        end: patch.sessionWindowEnd ?? null,
        at: now,
      })
    } else if (patch.rateLimitResetAt === null) {
      this._lastWindowPatch.delete(accountId)
    }
    if (pgPool) {
      const lifting = patch.rateLimitResetAt === null
      this._enqueueWindowPatchPg(accountId, patch, {
        now,
        immediate: lifting,
        eventType: lifting ? 'rate_limit_lifted' : null,
      })
    } else {
      this.runtimeRepo.updateWindow?.(accountId, patch)
    }
    return patch.rateLimitResetAt === null
  }
}

/** Hard scheduling block from runtime columns. */
export function hardBlockOf(state = null, now = Date.now()) {
  if (!state) return null
  const rateLimit = Number(state.rate_limit_reset_at) || 0
  if (rateLimit > now) return { reason: 'rate_limited', until: rateLimit }
  const overload = Number(state.overload_until) || 0
  if (overload > now) return { reason: 'overloaded', until: overload }
  return null
}
