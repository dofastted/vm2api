/**
 * Redis Live Request & Active Session Bridge (`LiveLogCache`).
 *
 * Bridges real-time in-flight request visibility with zero hot-path PostgreSQL INSERTs
 * and micro-batched Redis Pipelining (50ms window or 64-op immediate flush):
 *
 * Key layout (under cacheClient keyPrefix, default `vm2api:`):
 * - `live:req:{id}`             String JSON (TTL 300s) — in-flight request snapshot + `_live`
 * - `live:inflight`             ZSET (score = started_at ms, member = requestId)
 * - `live:sess:conc:{session}`  String counter (INCR / atomic DECR->DEL when <=0, TTL 600s)
 * - `live:sess:active`          ZSET (score = last_seen ms, member = sessionKey, TTL 3600s)
 * - `live:recent`               ZSET (score = completed_at ms, member = requestId, periodically trimmed to 2000)
 * - `live:recent:req:{id}`      String JSON (TTL 15s) — bridges 200ms async write-behind flush window
 *
 * High-concurrency protection (`highConcurrencyMode`):
 * - Enabled via `VM2API_HIGH_CONCURRENCY=1` or automatically when local in-flight requests >= 1000.
 * - Skips per-phase `updatePhase()` `live:req:*` Redis writes and samples homepage live/recent payloads
 *   while preserving exact session concurrency counters (`live:sess:conc:*`).
 *
 * Degrades cleanly to bounded in-process Maps when Redis is unconfigured or unavailable (Fail-Open).
 */

const REQ_PREFIX = 'live:req:'
const INFLIGHT_ZSET = 'live:inflight'
const SESS_CONC_PREFIX = 'live:sess:conc:'
const SESS_ACTIVE_ZSET = 'live:sess:active'
const RECENT_ZSET = 'live:recent'
const RECENT_REQ_PREFIX = 'live:recent:req:'

const DEFAULT_REQ_TTL_MS = 300_000
const DEFAULT_RECENT_TTL_MS = 15_000
const DEFAULT_RECENT_MAX_ENTRIES = 2_000
const DEFAULT_MAX_LOCAL_INFLIGHT = 15_000
const DEFAULT_SESS_CONC_TTL_SEC = 600
const DEFAULT_SESS_ACTIVE_TTL_SEC = 3_600
const DEFAULT_FLUSH_INTERVAL_MS = 50
const DEFAULT_BATCH_SIZE = 64
const DEFAULT_RECENT_TRIM_INTERVAL_MS = 5_000
const DEFAULT_HIGH_CONCURRENCY_THRESHOLD = 1_000
const DEFAULT_HIGH_CONCURRENCY_SAMPLE_RATE = 10
const MAX_FINISHED_GUARD = 32_768

// Atomically remove request from inflight, decrement session concurrency (DEL if <=0, idempotent via ZREM),
// and record completed summary in `live:recent`. Periodic rank/score trimming runs outside this hot script
// (every 5s / batch threshold) instead of executing ZREMRANGEBYRANK on every single request finish.
const FINISH_REQUEST_LUA = `
local inflightKey = KEYS[1]
local reqKey = KEYS[2]
local sessConcKey = KEYS[3]
local recentZsetKey = KEYS[4]
local recentReqKey = KEYS[5]

local reqId = ARGV[1]
local completedAt = tonumber(ARGV[2]) or 0
local recentJson = ARGV[3] or ''
local recentTtlMs = tonumber(ARGV[4]) or 15000
local hasSess = ARGV[5] == '1'

local removed = redis.call('ZREM', inflightKey, reqId)
redis.call('DEL', reqKey)

if hasSess and removed == 1 then
  local next = redis.call('DECR', sessConcKey)
  if next <= 0 then
    redis.call('DEL', sessConcKey)
  end
end

if recentJson ~= '' then
  redis.call('SET', recentReqKey, recentJson, 'PX', recentTtlMs)
  redis.call('ZADD', recentZsetKey, completedAt, reqId)
end

return removed
`

// Lightweight session concurrency decrement for unsampled requests in highConcurrencyMode
// (which were never inserted into live:inflight / live:req:*).
const DECR_SESSION_CONC_LUA = `
local sessConcKey = KEYS[1]
local next = redis.call('DECR', sessConcKey)
if next <= 0 then
  redis.call('DEL', sessConcKey)
  return 0
end
return next
`

function envFlagTruthy(val) {
  const s = String(val ?? '')
    .trim()
    .toLowerCase()
  return s === '1' || s === 'true' || s === 'on' || s === 'yes'
}

function resolveSessionKey(entry) {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry.sessionKey || entry.session_key || entry.session_id || entry.outbound_session_id || null
  if (raw == null) return null
  const s = String(raw).trim()
  return s || null
}

function buildLivePayload(entry) {
  const live = entry._live || {}
  const startedAt = Number(entry.started_at ?? live.started_at) || Date.now()
  const attemptCount = Number(live.attempt_count ?? entry.attempt_count ?? 0) || 0
  const ttftMs = live.ttft_ms !== undefined ? live.ttft_ms : (entry.ttft_ms ?? entry.first_token_ms ?? null)
  const vmId = live.vm_id !== undefined ? live.vm_id : (entry.vm_id ?? null)
  const accountId = live.account_id !== undefined ? live.account_id : (entry.account_id ?? null)
  const activeProvider = live.active_provider !== undefined ? live.active_provider : (entry.active_provider ?? null)
  const phase = String(live.phase || entry.phase || 'routing')

  return {
    phase,
    attempt_count: attemptCount,
    started_at: startedAt,
    ttft_ms: ttftMs == null ? null : Number(ttftMs),
    vm_id: vmId == null ? null : String(vmId),
    account_id: accountId == null ? null : String(accountId),
    active_provider: activeProvider == null ? null : String(activeProvider),
  }
}

function formatInflightEntry(raw, now) {
  if (!raw || typeof raw !== 'object') return null
  const live = buildLivePayload(raw)
  const startedAt = live.started_at
  const out = {
    ...raw,
    request_id: String(raw.request_id),
    started_at: startedAt,
    created_at: raw.created_at || new Date(startedAt).toISOString(),
    vm_id: live.vm_id,
    account_id: live.account_id,
    attempt_count: live.attempt_count,
    first_token_ms: live.ttft_ms,
    duration_ms: Math.max(0, now - startedAt),
    status: null,
    in_flight: true,
    _live: live,
  }
  delete out._sessionKey
  delete out._redisSampled
  return out
}

function formatRecentEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {
    ...raw,
    request_id: String(raw.request_id),
    in_flight: false,
  }
  delete out._live
  delete out._sessionKey
  delete out._redisSampled
  return out
}

export class LiveLogCache {
  constructor(
    cacheClient = null,
    {
      reqTtlMs = DEFAULT_REQ_TTL_MS,
      recentTtlMs = DEFAULT_RECENT_TTL_MS,
      recentMaxEntries = DEFAULT_RECENT_MAX_ENTRIES,
      maxLocalInflight = DEFAULT_MAX_LOCAL_INFLIGHT,
      sessionConcTtlSec = DEFAULT_SESS_CONC_TTL_SEC,
      sessionActiveTtlSec = DEFAULT_SESS_ACTIVE_TTL_SEC,
      flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
      batchSize = DEFAULT_BATCH_SIZE,
      recentTrimIntervalMs = DEFAULT_RECENT_TRIM_INTERVAL_MS,
      highConcurrencyMode = null,
      highConcurrencyThreshold = DEFAULT_HIGH_CONCURRENCY_THRESHOLD,
      highConcurrencySampleRate = DEFAULT_HIGH_CONCURRENCY_SAMPLE_RATE,
    } = {},
  ) {
    this.cache = cacheClient
    this.reqTtlMs = Math.max(5_000, Number(reqTtlMs) || DEFAULT_REQ_TTL_MS)
    this.recentTtlMs = Math.max(1_000, Number(recentTtlMs) || DEFAULT_RECENT_TTL_MS)
    this.recentMaxEntries = Math.max(10, Number(recentMaxEntries) || DEFAULT_RECENT_MAX_ENTRIES)
    this.maxLocalInflight = Math.max(64, Number(maxLocalInflight) || DEFAULT_MAX_LOCAL_INFLIGHT)
    this.sessionConcTtlSec = Math.max(30, Number(sessionConcTtlSec) || DEFAULT_SESS_CONC_TTL_SEC)
    this.sessionActiveTtlSec = Math.max(60, Number(sessionActiveTtlSec) || DEFAULT_SESS_ACTIVE_TTL_SEC)
    this.flushIntervalMs = Math.max(5, Math.min(5_000, Number(flushIntervalMs) || DEFAULT_FLUSH_INTERVAL_MS))
    this.batchSize = Math.max(1, Math.min(4_096, Math.trunc(Number(batchSize) || DEFAULT_BATCH_SIZE)))
    this.recentTrimIntervalMs = Math.max(100, Number(recentTrimIntervalMs) || DEFAULT_RECENT_TRIM_INTERVAL_MS)
    this._forcedHighConcurrency = typeof highConcurrencyMode === 'boolean' ? highConcurrencyMode : null
    this.highConcurrencyThreshold = Math.max(
      1,
      Math.trunc(Number(highConcurrencyThreshold) || DEFAULT_HIGH_CONCURRENCY_THRESHOLD),
    )
    this.highConcurrencySampleRate = Math.max(
      1,
      Math.trunc(Number(highConcurrencySampleRate) || DEFAULT_HIGH_CONCURRENCY_SAMPLE_RATE),
    )

    /** In-flight requests started by this process (also serves as bounded local fallback). */
    this._localInflight = new Map() // requestId -> normalized entry
    /** Completed recent requests for fallback when Redis is unavailable. */
    this._localRecent = new Map() // requestId -> { entry, completedAt }
    /** Local session concurrency counts & active timestamps for fallback. */
    this._localSessionConc = new Map() // sessionKey -> count
    this._localActiveSessions = new Map() // sessionKey -> lastSeenMs

    /** Micro-batch Redis pipeline state (coalesced per requestId within 50ms / 64-op window). */
    this._pendingOps = new Map() // requestId -> op descriptor
    this._flushTimer = null
    this._activeFlushPromises = new Set()
    this._finishedGuard = new Set() // recently finished requestIds to block stale writes

    /** Periodic `live:recent` trimming state (avoids ZREMRANGEBYRANK on every finishRequest). */
    this._lastRecentTrimAt = 0
    this._recentWritesSinceTrim = 0
    this._sampleCounter = 0

    this._stats = {
      batchesFlushed: 0,
      pipelinedOps: 0,
      skippedPhaseWrites: 0,
      sampledOutStarts: 0,
      periodicTrims: 0,
    }
  }

  /**
   * True when `VM2API_HIGH_CONCURRENCY=1` is set, explicitly enabled in options,
   * or in-flight local requests exceed `highConcurrencyThreshold` (default 1000).
   */
  get highConcurrencyMode() {
    return this.isHighConcurrencyMode()
  }

  isHighConcurrencyMode() {
    if (this._forcedHighConcurrency !== null) return this._forcedHighConcurrency
    if (envFlagTruthy(process.env.VM2API_HIGH_CONCURRENCY)) return true
    return this._localInflight.size >= this.highConcurrencyThreshold
  }

  stats() {
    return {
      pendingOps: this._pendingOps.size,
      localInflight: this._localInflight.size,
      localRecent: this._localRecent.size,
      highConcurrencyMode: this.isHighConcurrencyMode(),
      batchesFlushed: this._stats.batchesFlushed,
      pipelinedOps: this._stats.pipelinedOps,
      skippedPhaseWrites: this._stats.skippedPhaseWrites,
      sampledOutStarts: this._stats.sampledOutStarts,
      periodicTrims: this._stats.periodicTrims,
    }
  }

  _rememberFinished(requestId) {
    this._finishedGuard.add(requestId)
    if (this._finishedGuard.size > MAX_FINISHED_GUARD) {
      const oldest = this._finishedGuard.values().next().value
      if (oldest !== undefined) this._finishedGuard.delete(oldest)
    }
  }

  _pruneLocalInflight(maxAgeMs = this.reqTtlMs, now = Date.now()) {
    const cutoff = now - maxAgeMs
    for (const [id, entry] of this._localInflight) {
      const started = Number(entry.started_at) || 0
      if (started < cutoff) {
        this._localInflight.delete(id)
        if (entry._sessionKey) this._decrLocalSessionConc(entry._sessionKey)
      }
    }
    while (this._localInflight.size > this.maxLocalInflight) {
      const oldest = this._localInflight.keys().next().value
      if (oldest === undefined) break
      const evicted = this._localInflight.get(oldest)
      this._localInflight.delete(oldest)
      if (evicted?._sessionKey) this._decrLocalSessionConc(evicted._sessionKey)
    }
  }

  _pruneLocalRecent(now = Date.now()) {
    const cutoff = now - this.recentTtlMs
    for (const [id, item] of this._localRecent) {
      if (item.completedAt < cutoff) this._localRecent.delete(id)
    }
    while (this._localRecent.size > this.recentMaxEntries) {
      const oldest = this._localRecent.keys().next().value
      if (oldest === undefined) break
      this._localRecent.delete(oldest)
    }
  }

  _decrLocalSessionConc(sessionKey) {
    if (!sessionKey) return
    const next = (this._localSessionConc.get(sessionKey) || 0) - 1
    if (next <= 0) this._localSessionConc.delete(sessionKey)
    else this._localSessionConc.set(sessionKey, next)
  }

  _storeLocalRecent(requestId, entry, completedAt) {
    this._localRecent.delete(requestId)
    this._localRecent.set(requestId, { entry, completedAt })
    this._pruneLocalRecent(completedAt)
  }

  _clearFlushTimer() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
  }

  _scheduleMicroBatchFlush() {
    if (!this.cache?.hasRedis || this._pendingOps.size === 0) return
    if (this._pendingOps.size >= this.batchSize) {
      this._clearFlushTimer()
      this._dispatchPendingBatch()
      return
    }
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null
        this._dispatchPendingBatch()
      }, this.flushIntervalMs)
      this._flushTimer.unref?.()
    }
  }

  _dispatchPendingBatch() {
    if (this._pendingOps.size === 0) return null
    const ops = [...this._pendingOps.values()]
    this._pendingOps.clear()
    this._clearFlushTimer()

    if (!this.cache?.hasRedis) return null

    const flushPromise = this._executePipelineBatch(ops).finally(() => {
      this._activeFlushPromises.delete(flushPromise)
    })
    this._activeFlushPromises.add(flushPromise)
    return flushPromise
  }

  async _executePipelineBatch(ops) {
    if (!ops.length || !this.cache?.hasRedis) return
    const now = Date.now()
    const redis = this.cache.redis
    const inflightKey = this.cache.redisKey(INFLIGHT_ZSET)
    const activeKey = this.cache.redisKey(SESS_ACTIVE_ZSET)
    const recentZsetKey = this.cache.redisKey(RECENT_ZSET)

    let hasInflightWrite = false
    let hasSessionActiveWrite = false
    let recentWritesInBatch = 0
    const deferredLuaFinishes = []
    const deferredSessDecrs = []

    try {
      const pipe = redis.pipeline()
      const pipeSupportsEval = typeof pipe.eval === 'function'
      let queuedCommands = 0

      for (const op of ops) {
        if (op.kind === 'start') {
          const current = this._localInflight.get(op.id)
          if (!current || this._finishedGuard.has(op.id)) continue

          if (op.sampled) {
            const reqKey = this.cache.redisKey(`${REQ_PREFIX}${op.id}`)
            const serialized = JSON.stringify(formatInflightEntry(current, op.startedAt))
            pipe.set(reqKey, serialized, 'PX', this.reqTtlMs)
            pipe.zadd(inflightKey, op.startedAt, op.id)
            hasInflightWrite = true
            queuedCommands += 2
          }

          if (op.sessionKey) {
            const concKey = this.cache.redisKey(`${SESS_CONC_PREFIX}${op.sessionKey}`)
            pipe.incr(concKey)
            pipe.expire(concKey, this.sessionConcTtlSec)
            pipe.zadd(activeKey, op.now, op.sessionKey)
            hasSessionActiveWrite = true
            queuedCommands += 3
          }
        } else if (op.kind === 'phase') {
          if (this._finishedGuard.has(op.id)) continue
          const current = this._localInflight.get(op.id)
          if (!current || current._redisSampled === false) continue

          const reqKey = this.cache.redisKey(`${REQ_PREFIX}${op.id}`)
          const payload = JSON.stringify(formatInflightEntry(current, now))
          pipe.set(reqKey, payload, 'PX', this.reqTtlMs)
          queuedCommands += 1
        } else if (op.kind === 'finish_unflushed') {
          // Request started and finished within the same 50ms micro-batch: skip
          // inflight ZADD/ZREM & sess INCR/DECR churn; only persist recent bridge + session activity.
          if (op.sampled && op.recentEntry) {
            const recentReqKey = this.cache.redisKey(`${RECENT_REQ_PREFIX}${op.id}`)
            pipe.set(recentReqKey, JSON.stringify(op.recentEntry), 'PX', this.recentTtlMs)
            pipe.zadd(recentZsetKey, op.completedAt, op.id)
            recentWritesInBatch += 1
            queuedCommands += 2
          }
          if (op.sessionKey) {
            pipe.zadd(activeKey, op.completedAt, op.sessionKey)
            hasSessionActiveWrite = true
            queuedCommands += 1
          }
        } else if (op.kind === 'finish') {
          if (op.sampled === false) {
            // Unsampled in highConcurrencyMode: never inserted into live:inflight / live:req:*,
            // only atomically decrement session concurrency counter when present.
            if (op.sessionKey) {
              const concKey = this.cache.redisKey(`${SESS_CONC_PREFIX}${op.sessionKey}`)
              if (pipeSupportsEval) {
                pipe.eval(DECR_SESSION_CONC_LUA, 1, concKey)
                queuedCommands += 1
              } else {
                deferredSessDecrs.push(`${SESS_CONC_PREFIX}${op.sessionKey}`)
              }
            }
          } else {
            const recentJson = op.recentEntry ? JSON.stringify(op.recentEntry) : ''
            const sessConcLogical = op.sessionKey
              ? `${SESS_CONC_PREFIX}${op.sessionKey}`
              : `${SESS_CONC_PREFIX}__none__`
            const keys = [
              inflightKey,
              this.cache.redisKey(`${REQ_PREFIX}${op.id}`),
              this.cache.redisKey(sessConcLogical),
              recentZsetKey,
              this.cache.redisKey(`${RECENT_REQ_PREFIX}${op.id}`),
            ]
            const args = [
              op.id,
              String(op.completedAt),
              recentJson,
              String(this.recentTtlMs),
              op.sessionKey ? '1' : '0',
            ]
            if (recentJson) recentWritesInBatch += 1
            if (pipeSupportsEval) {
              pipe.eval(FINISH_REQUEST_LUA, 5, ...keys, ...args)
              queuedCommands += 1
            } else {
              deferredLuaFinishes.push({
                logicalKeys: [
                  INFLIGHT_ZSET,
                  `${REQ_PREFIX}${op.id}`,
                  sessConcLogical,
                  RECENT_ZSET,
                  `${RECENT_REQ_PREFIX}${op.id}`,
                ],
                args,
              })
            }
          }
        }
      }

      if (hasInflightWrite) {
        pipe.pexpire(inflightKey, this.reqTtlMs * 2)
        queuedCommands += 1
      }
      if (hasSessionActiveWrite) {
        pipe.expire(activeKey, this.sessionActiveTtlSec)
        queuedCommands += 1
      }

      if (recentWritesInBatch > 0) {
        this._recentWritesSinceTrim += recentWritesInBatch
        const trimDue =
          this._lastRecentTrimAt === 0 ||
          now - this._lastRecentTrimAt >= this.recentTrimIntervalMs ||
          this._recentWritesSinceTrim >= this.recentMaxEntries
        if (trimDue) {
          this._lastRecentTrimAt = now
          this._recentWritesSinceTrim = 0
          pipe.zremrangebyscore(recentZsetKey, '-inf', now - this.recentTtlMs)
          pipe.zremrangebyrank(recentZsetKey, 0, -(this.recentMaxEntries + 1))
          pipe.pexpire(recentZsetKey, this.recentTtlMs * 2)
          this._stats.periodicTrims += 1
          queuedCommands += 3
        }
      }

      if (queuedCommands > 0) {
        await pipe.exec()
        this._stats.batchesFlushed += 1
        this._stats.pipelinedOps += ops.length
      }

      for (const item of deferredLuaFinishes) {
        await this.cache.evalLua(FINISH_REQUEST_LUA, item.logicalKeys, item.args)
      }
      for (const sessKey of deferredSessDecrs) {
        await this.cache.evalLua(DECR_SESSION_CONC_LUA, [sessKey], [])
      }
    } catch {
      this.cache.l2Errors += 1
    }
  }

  /**
   * Register a newly started in-flight request.
   * Updates local state synchronously and enqueues into the 50ms / 64-op Redis micro-batch pipeline.
   */
  async startRequest(requestId, entry = {}) {
    if (!requestId) return false
    const id = String(requestId)
    this._finishedGuard.delete(id)

    const now = Date.now()
    const startedAt = Number(entry.started_at ?? entry.t0) || now
    const sessionKey = resolveSessionKey(entry)

    const live = buildLivePayload({
      ...entry,
      started_at: startedAt,
      phase: entry.phase || 'routing',
      attempt_count: entry.attempt_count ?? 0,
    })

    const highConc = this.isHighConcurrencyMode()
    let sampled = true
    if (highConc) {
      this._sampleCounter += 1
      sampled = this.highConcurrencySampleRate <= 1 || this._sampleCounter % this.highConcurrencySampleRate === 1
      if (!sampled) this._stats.sampledOutStarts += 1
    }

    const stored = {
      ...entry,
      request_id: id,
      user_id: entry.user_id ?? null,
      owner_user_id: entry.owner_user_id ?? null,
      vm_owner_user_id: entry.vm_owner_user_id ?? null,
      api_key_id: entry.api_key_id ?? null,
      started_at: startedAt,
      created_at: entry.created_at || new Date(startedAt).toISOString(),
      vm_id: live.vm_id,
      account_id: live.account_id,
      attempt_count: live.attempt_count,
      ttft_ms: live.ttft_ms,
      active_provider: live.active_provider,
      phase: live.phase,
      in_flight: true,
      _live: live,
      _sessionKey: sessionKey,
      _redisSampled: sampled,
    }

    // Track locally (used for coalescing + Fail-Open fallback)
    const existedLocally = this._localInflight.has(id)
    this._localInflight.delete(id)
    this._localInflight.set(id, stored)
    if (sessionKey && !existedLocally) {
      this._localSessionConc.set(sessionKey, (this._localSessionConc.get(sessionKey) || 0) + 1)
      this._localActiveSessions.set(sessionKey, now)
    }
    this._pruneLocalInflight(this.reqTtlMs, now)

    if (this.cache?.hasRedis && (sampled || sessionKey)) {
      this._pendingOps.set(id, {
        kind: 'start',
        id,
        startedAt,
        now,
        sessionKey,
        sampled,
      })
      this._scheduleMicroBatchFlush()
    }

    return true
  }

  /**
   * Non-blocking phase/attempt/TTFT update coalesced into the 50ms micro-batch pipeline.
   * Automatically skips `live:req:*` Redis writes when `highConcurrencyMode` is active.
   */
  updatePhase(requestId, patch = {}) {
    if (!requestId || !patch || typeof patch !== 'object') return
    const id = String(requestId)
    if (this._finishedGuard.has(id)) return

    const existing = this._localInflight.get(id)
    if (!existing) return

    // Merge top-level metadata and _live fields
    const nextLive = {
      ...existing._live,
      ...(patch.phase !== undefined ? { phase: String(patch.phase) } : {}),
      ...(patch.attempt_count !== undefined ? { attempt_count: Number(patch.attempt_count) || 0 } : {}),
      ...(patch.ttft_ms !== undefined
        ? { ttft_ms: patch.ttft_ms == null ? null : Number(patch.ttft_ms) }
        : patch.first_token_ms !== undefined
          ? { ttft_ms: patch.first_token_ms == null ? null : Number(patch.first_token_ms) }
          : {}),
      ...(patch.vm_id !== undefined ? { vm_id: patch.vm_id == null ? null : String(patch.vm_id) } : {}),
      ...(patch.account_id !== undefined
        ? { account_id: patch.account_id == null ? null : String(patch.account_id) }
        : {}),
      ...(patch.active_provider !== undefined
        ? { active_provider: patch.active_provider == null ? null : String(patch.active_provider) }
        : {}),
    }

    const next = {
      ...existing,
      ...patch,
      request_id: id,
      user_id: patch.user_id !== undefined ? patch.user_id : (existing.user_id ?? null),
      owner_user_id: patch.owner_user_id !== undefined ? patch.owner_user_id : (existing.owner_user_id ?? null),
      vm_owner_user_id:
        patch.vm_owner_user_id !== undefined ? patch.vm_owner_user_id : (existing.vm_owner_user_id ?? null),
      api_key_id: patch.api_key_id !== undefined ? patch.api_key_id : (existing.api_key_id ?? null),
      started_at: existing.started_at,
      vm_id: nextLive.vm_id,
      account_id: nextLive.account_id,
      attempt_count: nextLive.attempt_count,
      ttft_ms: nextLive.ttft_ms,
      active_provider: nextLive.active_provider,
      phase: nextLive.phase,
      in_flight: true,
      _live: nextLive,
      _sessionKey: existing._sessionKey,
      _redisSampled: existing._redisSampled,
    }
    this._localInflight.set(id, next)

    if (!this.cache?.hasRedis) return
    if (this.isHighConcurrencyMode() || existing._redisSampled === false) {
      this._stats.skippedPhaseWrites += 1
      return
    }

    // If a start or phase op for this requestId is already queued in the current
    // micro-batch, the flush reads the latest `_localInflight.get(id)` automatically.
    const queued = this._pendingOps.get(id)
    if (queued) return

    this._pendingOps.set(id, { kind: 'phase', id })
    this._scheduleMicroBatchFlush()
  }

  /**
   * Mark a request finished:
   * - Updates local inflight/session/recent maps immediately
   * - Coalesces into the 50ms / 64-op Redis micro-batch pipeline (canceling inflight
   *   churn when start+finish land in the same window; periodic `live:recent` trimming
   *   runs every 5s instead of per-finish ZREMRANGEBYRANK)
   */
  async finishRequest(requestId, completedSummary = null) {
    if (!requestId) return false
    const id = String(requestId)
    const alreadyFinished = this._finishedGuard.has(id)
    this._rememberFinished(id)

    const prev = this._localInflight.get(id) || null
    if (prev) {
      this._localInflight.delete(id)
      if (prev._sessionKey) this._decrLocalSessionConc(prev._sessionKey)
    }

    const now = Date.now()
    const sessionKey = prev?._sessionKey || resolveSessionKey(completedSummary)
    const sampled = prev ? prev._redisSampled !== false : true
    let recentEntry = null
    if (completedSummary && typeof completedSummary === 'object') {
      const completedAt = Number(completedSummary.completed_at) || now
      recentEntry = formatRecentEntry({
        ...(prev || {}),
        ...completedSummary,
        request_id: id,
        user_id: completedSummary.user_id ?? prev?.user_id ?? null,
        owner_user_id: completedSummary.owner_user_id ?? prev?.owner_user_id ?? null,
        vm_owner_user_id: completedSummary.vm_owner_user_id ?? prev?.vm_owner_user_id ?? null,
        api_key_id: completedSummary.api_key_id ?? prev?.api_key_id ?? null,
        started_at: prev?.started_at ?? completedSummary.started_at ?? completedAt,
        completed_at: completedAt,
        created_at: completedSummary.created_at || new Date(completedAt).toISOString(),
      })
      if (sessionKey) {
        this._localActiveSessions.set(sessionKey, completedAt)
      }
      // Always maintain bounded local recent buffer for immediate Fail-Open resilience.
      this._storeLocalRecent(id, recentEntry, completedAt)
    }

    if (this.cache?.hasRedis) {
      const completedAt = recentEntry?.completed_at || now
      const prevPending = this._pendingOps.get(id)
      if (prevPending?.kind === 'start') {
        // Start was not flushed to Redis yet: collapse start+finish to eliminate
        // live:inflight and sess:conc INCR/DECR round-trips completely.
        if ((prevPending.sampled && recentEntry) || sessionKey) {
          this._pendingOps.set(id, {
            kind: 'finish_unflushed',
            id,
            completedAt,
            recentEntry: prevPending.sampled ? recentEntry : null,
            sessionKey,
            sampled: prevPending.sampled,
          })
          this._scheduleMicroBatchFlush()
        } else {
          this._pendingOps.delete(id)
        }
      } else if (sampled === false && alreadyFinished) {
        // Idempotent guard for duplicate finish on unsampled high-concurrency request.
      } else {
        this._pendingOps.set(id, {
          kind: 'finish',
          id,
          completedAt,
          recentEntry: sampled ? recentEntry : null,
          sessionKey,
          sampled,
        })
        this._scheduleMicroBatchFlush()
      }
    }

    return true
  }

  /**
   * Synchronously drain all queued micro-batch Redis operations and await all
   * in-flight pipeline flushes (guarantees determinism for tests & graceful shutdown).
   */
  async flushPending() {
    this._clearFlushTimer()
    for (;;) {
      if (this._pendingOps.size > 0) {
        this._dispatchPendingBatch()
      }
      if (this._activeFlushPromises.size > 0) {
        await Promise.allSettled([...this._activeFlushPromises])
        continue
      }
      if (this._pendingOps.size === 0) break
    }
  }

  /**
   * Return merged in-flight (`in_flight: true` + `_live`) and recently completed
   * (`in_flight: false`) requests, deduplicated by `request_id` (completed wins),
   * sorted newest-first, with stale orphan pruning.
   */
  async listLiveAndRecent({
    limit = 50,
    maxAgeMs = this.reqTtlMs,
    ownerUserId = null,
    ownerKeyIds = null,
    includeRecent = true,
    now = Date.now(),
  } = {}) {
    const cap = Math.max(1, Math.min(500, Number(limit) || 50))
    const ageLimit = Math.max(1_000, Number(maxAgeMs) || this.reqTtlMs)
    const ownerFilter = ownerUserId != null && ownerUserId !== '' ? String(ownerUserId).trim() || null : null
    const ownerKeySet =
      ownerKeyIds instanceof Set
        ? ownerKeyIds
        : Array.isArray(ownerKeyIds) && ownerKeyIds.length
          ? new Set(ownerKeyIds.map(String))
          : null
    const fetchCap = ownerFilter ? Math.min(500, cap * 4) : cap

    if (this.cache?.hasRedis && this._pendingOps.size > 0) {
      await this.flushPending()
    }

    let inflightItems = null
    let recentItems = null

    if (this.cache?.hasRedis) {
      try {
        const inflightKey = this.cache.redisKey(INFLIGHT_ZSET)
        const recentKey = this.cache.redisKey(RECENT_ZSET)
        const inflightCutoff = now - ageLimit
        const recentCutoff = now - this.recentTtlMs

        const pipe = this.cache.redis.pipeline()
        pipe.zremrangebyscore(inflightKey, '-inf', inflightCutoff)
        pipe.zrevrange(inflightKey, 0, fetchCap - 1)
        if (includeRecent) {
          pipe.zremrangebyscore(recentKey, '-inf', recentCutoff)
          pipe.zrevrange(recentKey, 0, fetchCap - 1)
        }
        const results = await pipe.exec()

        const inflightIds = !results?.[1]?.[0] && Array.isArray(results?.[1]?.[1]) ? results[1][1] : []
        const recentIds = includeRecent && !results?.[3]?.[0] && Array.isArray(results?.[3]?.[1]) ? results[3][1] : []

        const allKeys = [
          ...inflightIds.map((id) => this.cache.redisKey(`${REQ_PREFIX}${id}`)),
          ...recentIds.map((id) => this.cache.redisKey(`${RECENT_REQ_PREFIX}${id}`)),
        ]

        const rawValues = allKeys.length ? await this.cache.redis.mget(...allKeys) : []
        inflightItems = []
        recentItems = []

        const orphanInflightIds = []
        for (let i = 0; i < inflightIds.length; i += 1) {
          const raw = rawValues[i]
          if (!raw) {
            orphanInflightIds.push(inflightIds[i])
            continue
          }
          try {
            const parsed = JSON.parse(raw)
            const started = Number(parsed.started_at ?? parsed._live?.started_at) || 0
            if (started < inflightCutoff) {
              orphanInflightIds.push(inflightIds[i])
              continue
            }
            const formatted = formatInflightEntry(parsed, now)
            if (formatted) inflightItems.push(formatted)
          } catch {
            orphanInflightIds.push(inflightIds[i])
          }
        }
        if (orphanInflightIds.length) {
          this.cache.redis.zrem(inflightKey, ...orphanInflightIds).catch(() => {})
        }

        const offset = inflightIds.length
        for (let i = 0; i < recentIds.length; i += 1) {
          const raw = rawValues[offset + i]
          if (!raw) continue
          try {
            const parsed = JSON.parse(raw)
            const completedAt = Number(parsed.completed_at) || Date.parse(parsed.created_at) || 0
            if (completedAt < recentCutoff) continue
            const formatted = formatRecentEntry(parsed)
            if (formatted) recentItems.push(formatted)
          } catch {}
        }
      } catch {
        this.cache.l2Errors += 1
        inflightItems = null
        recentItems = null
      }
    }

    // Local fallback when Redis is unconfigured or errored
    if (inflightItems === null) {
      this._pruneLocalInflight(ageLimit, now)
      inflightItems = []
      for (const entry of this._localInflight.values()) {
        if (now - (Number(entry.started_at) || 0) <= ageLimit) {
          const formatted = formatInflightEntry(entry, now)
          if (formatted) inflightItems.push(formatted)
        }
      }
      this._pruneLocalRecent(now)
      recentItems = []
      if (includeRecent) {
        for (const item of this._localRecent.values()) {
          if (now - item.completedAt <= this.recentTtlMs) {
            const formatted = formatRecentEntry(item.entry)
            if (formatted) recentItems.push(formatted)
          }
        }
      }
    }

    const matchesOwner = (item) => {
      if (!ownerFilter) return true
      if (!item || typeof item !== 'object') return false
      if (item.user_id != null && String(item.user_id) === ownerFilter) return true
      if (item.owner_user_id != null && String(item.owner_user_id) === ownerFilter) return true
      if (item.vm_owner_user_id != null && String(item.vm_owner_user_id) === ownerFilter) return true
      if (
        ownerKeySet &&
        item.api_key_id != null &&
        item.api_key_id !== '' &&
        ownerKeySet.has(String(item.api_key_id))
      ) {
        return true
      }
      return false
    }

    // Deduplicate by request_id (recent completed wins over in-flight on race)
    const byId = new Map()
    for (const item of inflightItems) {
      if (!matchesOwner(item)) continue
      byId.set(item.request_id, item)
    }
    for (const item of recentItems || []) {
      if (!matchesOwner(item)) continue
      byId.set(item.request_id, item)
    }

    const merged = [...byId.values()]
    merged.sort((a, b) => {
      const ta = Number(a.completed_at ?? a.started_at) || Date.parse(a.created_at || '') || 0
      const tb = Number(b.completed_at ?? b.started_at) || Date.parse(b.created_at || '') || 0
      return tb - ta
    })
    return merged.slice(0, cap)
  }

  /** Total currently in-flight requests (after pruning timed-out orphans). */
  async getInflightCount({ maxAgeMs = this.reqTtlMs, now = Date.now() } = {}) {
    const ageLimit = Math.max(1_000, Number(maxAgeMs) || this.reqTtlMs)
    if (this.cache?.hasRedis && this._pendingOps.size > 0) {
      await this.flushPending()
    }
    if (this.cache?.hasRedis) {
      try {
        const inflightKey = this.cache.redisKey(INFLIGHT_ZSET)
        const pipe = this.cache.redis.pipeline()
        pipe.zremrangebyscore(inflightKey, '-inf', now - ageLimit)
        pipe.zcard(inflightKey)
        const results = await pipe.exec()
        const [err, card] = results?.[1] || []
        if (!err && card != null) {
          const redisCount = Math.max(0, Number(card) || 0)
          if (this.isHighConcurrencyMode()) {
            this._pruneLocalInflight(ageLimit, now)
            return Math.max(redisCount, this._localInflight.size)
          }
          return redisCount
        }
      } catch {
        this.cache.l2Errors += 1
      }
    }
    this._pruneLocalInflight(ageLimit, now)
    return this._localInflight.size
  }

  /**
   * Batched in-flight concurrency counts per sessionKey.
   * @returns {Promise<Map<string, number>>}
   */
  async getActiveSessionCounts(sessionKeys) {
    const out = new Map()
    if (!Array.isArray(sessionKeys) || !sessionKeys.length) return out
    const unique = [...new Set(sessionKeys.filter((k) => k != null && k !== '').map(String))]
    if (!unique.length) return out

    if (this.cache?.hasRedis && this._pendingOps.size > 0) {
      await this.flushPending()
    }

    if (this.cache?.hasRedis) {
      try {
        const rKeys = unique.map((k) => this.cache.redisKey(`${SESS_CONC_PREFIX}${k}`))
        const vals = await this.cache.redis.mget(...rKeys)
        if (Array.isArray(vals)) {
          for (let i = 0; i < unique.length; i += 1) {
            const n = Number.parseInt(String(vals[i] ?? '0'), 10)
            out.set(unique[i], Number.isFinite(n) && n > 0 ? n : 0)
          }
          return out
        }
      } catch {
        this.cache.l2Errors += 1
      }
    }

    for (const k of unique) {
      out.set(k, Math.max(0, this._localSessionConc.get(k) || 0))
    }
    return out
  }

  /**
   * Return session keys active within `windowMs`, ordered most-recent first.
   * @returns {Promise<string[]>}
   */
  async getActiveSessionKeys(windowMs = 300_000, { limit = 200, now = Date.now() } = {}) {
    const win = Math.max(1_000, Number(windowMs) || 300_000)
    const cap = Math.max(1, Math.min(1_000, Number(limit) || 200))
    const minScore = now - win

    if (this.cache?.hasRedis && this._pendingOps.size > 0) {
      await this.flushPending()
    }

    if (this.cache?.hasRedis) {
      try {
        const activeKey = this.cache.redisKey(SESS_ACTIVE_ZSET)
        const pruneBefore = now - Math.max(win, this.sessionActiveTtlSec * 1000)
        const pipe = this.cache.redis.pipeline()
        pipe.zremrangebyscore(activeKey, '-inf', pruneBefore)
        pipe.zrevrangebyscore(activeKey, '+inf', minScore, 'LIMIT', 0, cap)
        const results = await pipe.exec()
        const [err, keys] = results?.[1] || []
        if (!err && Array.isArray(keys)) {
          return keys.map(String)
        }
      } catch {
        this.cache.l2Errors += 1
      }
    }

    const pruneBefore = now - Math.max(win, this.sessionActiveTtlSec * 1000)
    const active = []
    for (const [k, ts] of this._localActiveSessions) {
      if (ts < pruneBefore) {
        this._localActiveSessions.delete(k)
      } else if (ts >= minScore) {
        active.push([k, ts])
      }
    }
    active.sort((a, b) => b[1] - a[1])
    return active.slice(0, cap).map(([k]) => k)
  }

  clearLocal() {
    this._clearFlushTimer()
    this._pendingOps.clear()
    this._localInflight.clear()
    this._localRecent.clear()
    this._localSessionConc.clear()
    this._localActiveSessions.clear()
    this._finishedGuard.clear()
    this._lastRecentTrimAt = 0
    this._recentWritesSinceTrim = 0
  }
}
