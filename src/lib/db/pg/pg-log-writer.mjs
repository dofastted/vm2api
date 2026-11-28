/**
 * True async non-blocking PostgreSQL micro-batch log writer and retention cleaner.
 *
 * Replaces main-thread synchronous `Atomics.wait` per-row RPC writes on PG with:
 * - Bounded in-memory buffers (defaults: batchSize=128, flushIntervalMs=200, maxPending=5000)
 * - Single-SQL parameterized multi-row INSERTs for `usage_logs`, `request_attempts`,
 *   and `request_log_debug` (with automatic PG 65535-param chunking)
 * - Automatic per-row fallback on batch SQL failure (poison-row isolation)
 * - Non-dropping overflow backpressure (urgent flush + direct single-row write)
 * - Graceful shutdown drain barrier (`flush()` / `close()`)
 * - Async `ctid`-batched retention cleanup (`runRetentionCleanupAsync`) preserving
 *   exact `account_lifetime_usage_archive` and `usage_logs_pruned_through` semantics.
 */

import crypto from 'node:crypto'

export const USAGE_LOG_COLUMNS = Object.freeze([
  'id',
  'request_id',
  'created_at',
  'log_mode',
  'method',
  'path',
  'protocol',
  'model',
  'stream',
  'status',
  'duration_ms',
  'api_key_kind',
  'api_key_id',
  'vm_id',
  'account_id',
  'workspace',
  'input_tokens',
  'output_tokens',
  'error_code',
  'error_message',
  'user_agent',
  'ip_address',
  'api_key_presented',
  'has_tools',
  'via',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cache_creation_5m_tokens',
  'cache_creation_1h_tokens',
  'requested_model',
  'upstream_model',
  'model_mismatch',
  'first_token_ms',
  'first_byte_ms',
  'generation_ms',
  'stop_reason',
  'attempt_count',
  'final_state',
  'final_account_id',
  'usage_account_id',
  'input_cost',
  'output_cost',
  'cache_read_cost',
  'cache_creation_cost',
  'web_search_requests',
  'web_search_cost',
  'total_cost',
  'pricing_model',
  'price_source',
  'price_version',
  'user_id',
  'group_id',
  'actual_cost',
  'rate_multiplier',
  'service_tier',
  'upstream_service_tier',
  'speed',
  'long_context',
  'session_id',
  'outbound_session_id',
  'reasoning_effort',
  'inbound_device_id',
  'upstream_status',
  'upstream_400_message',
  'intercept',
  'jev_state',
  'vm_owner_user_id',
  'image_model',
  'image_usage',
  'image_input_tokens',
  'image_output_tokens',
  'image_cost',
  'advisor_usage',
  'advisor_cost',
  'upstream_type',
  'error_details',
])

export const REQUEST_ATTEMPT_COLUMNS = Object.freeze([
  'request_id',
  'attempt_no',
  'vm_id',
  'account_id',
  'model',
  'selection_reason',
  'started_at',
  'completed_at',
  'upstream_status',
  'error_scope',
  'action',
  'cooldown_until',
  'downstream_committed',
  'terminal_state',
  'usage_json',
  'wait_ms',
  'ttft_ms',
  'latency_ms',
  'queue_wait_ms',
  'scheduling_ms',
  'error_code',
  'upstream_type',
  'error_details_json',
  'hop_request_id',
  'provider_run_id',
  'provider_turn_id',
  'provider_attempt_id',
  'provider_request_id',
])

export const REQUEST_DEBUG_COLUMNS = Object.freeze(['request_id', 'ts', 'record_json'])

const ZERO_DEFAULT_USAGE_COLUMNS = new Set([
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_5m_tokens',
  'cache_creation_1h_tokens',
  'web_search_requests',
  'image_input_tokens',
  'image_output_tokens',
])

const JSON_TEXT_USAGE_COLUMNS = new Set(['error_details', 'advisor_usage', 'image_usage'])

const DEFAULT_BATCH_SIZE = 128
const DEFAULT_FLUSH_INTERVAL_MS = 200
const DEFAULT_MAX_PENDING = 5000
const DEFAULT_MAX_DEBUG_BYTES = 512 * 1024
const DEFAULT_MAX_PARAMS_PER_QUERY = 60_000
const DEFAULT_CLEANUP_BATCH_SIZE = 5000
const DEFAULT_CLEANUP_MAX_BATCHES = 200

const RETENTION_LOCK_KEY = 'vm2api_retention_cleanup_v1'
const PRUNED_THROUGH_KEY = 'usage_logs_pruned_through'

// Matches `LIFETIME_ACCOUNT_SQL` and `TOTAL_TOKENS_SQL` in `src/lib/db/repos/usage-logs-repo.mjs`
// (using PostgreSQL-native COALESCE instead of SQLite IFNULL).
const PG_LIFETIME_ACCOUNT_SQL = `COALESCE(NULLIF(usage_account_id, ''),
  NULLIF(NULLIF(COALESCE(NULLIF(final_account_id, ''), NULLIF(account_id, '')), COALESCE(vm_id, '')), '—'))`
const PG_TOTAL_TOKENS_SQL =
  'COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)'

const USAGE_LOG_CONFLICT_SQL = 'ON CONFLICT (request_id) DO NOTHING'

const REQUEST_ATTEMPT_CONFLICT_SQL = `ON CONFLICT (request_id, attempt_no) DO UPDATE SET
  vm_id = COALESCE(EXCLUDED.vm_id, request_attempts.vm_id),
  account_id = COALESCE(EXCLUDED.account_id, request_attempts.account_id),
  model = COALESCE(EXCLUDED.model, request_attempts.model),
  selection_reason = COALESCE(EXCLUDED.selection_reason, request_attempts.selection_reason),
  completed_at = COALESCE(EXCLUDED.completed_at, request_attempts.completed_at),
  upstream_status = COALESCE(EXCLUDED.upstream_status, request_attempts.upstream_status),
  error_scope = COALESCE(EXCLUDED.error_scope, request_attempts.error_scope),
  action = COALESCE(EXCLUDED.action, request_attempts.action),
  cooldown_until = COALESCE(EXCLUDED.cooldown_until, request_attempts.cooldown_until),
  downstream_committed = GREATEST(request_attempts.downstream_committed, EXCLUDED.downstream_committed),
  terminal_state = CASE
    WHEN EXCLUDED.terminal_state IS NOT NULL AND EXCLUDED.terminal_state <> 'started' THEN EXCLUDED.terminal_state
    ELSE COALESCE(request_attempts.terminal_state, EXCLUDED.terminal_state)
  END,
  usage_json = COALESCE(EXCLUDED.usage_json, request_attempts.usage_json),
  wait_ms = COALESCE(EXCLUDED.wait_ms, request_attempts.wait_ms),
  ttft_ms = COALESCE(EXCLUDED.ttft_ms, request_attempts.ttft_ms),
  latency_ms = COALESCE(EXCLUDED.latency_ms, request_attempts.latency_ms),
  queue_wait_ms = COALESCE(EXCLUDED.queue_wait_ms, request_attempts.queue_wait_ms),
  scheduling_ms = COALESCE(EXCLUDED.scheduling_ms, request_attempts.scheduling_ms),
  error_code = COALESCE(EXCLUDED.error_code, request_attempts.error_code),
  upstream_type = COALESCE(EXCLUDED.upstream_type, request_attempts.upstream_type),
  error_details_json = COALESCE(EXCLUDED.error_details_json, request_attempts.error_details_json),
  hop_request_id = COALESCE(EXCLUDED.hop_request_id, request_attempts.hop_request_id),
  provider_run_id = COALESCE(EXCLUDED.provider_run_id, request_attempts.provider_run_id),
  provider_turn_id = COALESCE(EXCLUDED.provider_turn_id, request_attempts.provider_turn_id),
  provider_attempt_id = COALESCE(EXCLUDED.provider_attempt_id, request_attempts.provider_attempt_id),
  provider_request_id = COALESCE(EXCLUDED.provider_request_id, request_attempts.provider_request_id)`

const REQUEST_DEBUG_CONFLICT_SQL = `ON CONFLICT (request_id) DO UPDATE SET
  ts = EXCLUDED.ts,
  record_json = EXCLUDED.record_json`

function stripNul(value) {
  if (typeof value !== 'string') return value
  return value.includes('\0') ? value.replace(/\0/g, '') : value
}

function normalizeCooldownUntilMs(value) {
  if (value == null || value === '') return null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed)
      return Number.isFinite(n) ? Math.trunc(n) : null
    }
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null
  }
  return null
}

function normalizeProviderAttemptId(value) {
  if (value == null || value === '') return null
  if (typeof value === 'bigint') {
    const n = Number(value)
    return Number.isSafeInteger(n) && n >= 0 ? n : null
  }
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim())
    return Number.isSafeInteger(n) && n >= 0 ? n : null
  }
  return null
}

function safeJsonStringify(value, fallback = '{"_error":"serialize_failed"}') {
  try {
    const seen = new WeakSet()
    const raw = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'string') return stripNul(v)
      if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : String(v)
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      return v
    })
    return stripNul(raw ?? 'null')
  } catch {
    return fallback
  }
}

function truncateUtf8ByBytes(str, maxBytes) {
  if (maxBytes <= 0 || !str) return ''
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str
  // Binary search on UTF-16 code units while avoiding trailing half-surrogates.
  let lo = 0
  let hi = Math.min(str.length, maxBytes)
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    let slice = str.slice(0, mid)
    if (slice.length > 0) {
      const last = slice.charCodeAt(slice.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) slice = slice.slice(0, -1)
    }
    if (Buffer.byteLength(slice, 'utf8') <= maxBytes) lo = mid
    else hi = mid - 1
  }
  let out = str.slice(0, lo)
  if (out.length > 0) {
    const last = out.charCodeAt(out.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  }
  return out
}

/**
 * Convert a usage log summary object to the ordered parameter array matching `USAGE_LOG_COLUMNS`.
 * Preserves full parity with `UsageLogsRepo`'s `toRow()` (including `ts` -> `created_at`,
 * `ip` -> `ip_address`, nullable `cache_creation_tokens`, and boolean -> 0/1 conversions).
 */
export function usageLogToRow(rec = {}) {
  return USAGE_LOG_COLUMNS.map((c) => {
    if (c === 'id') return stripNul(rec.id ?? rec.request_id ?? crypto.randomUUID())
    if (c === 'created_at') return stripNul(rec.created_at ?? rec.ts ?? new Date().toISOString())
    if (c === 'ip_address') return stripNul(rec.ip_address ?? rec.ip ?? null)
    if (c === 'stream') return rec.stream ? 1 : 0
    if (c === 'has_tools') return rec.has_tools == null ? null : rec.has_tools ? 1 : 0
    if (c === 'model_mismatch') return rec.model_mismatch == null ? null : rec.model_mismatch ? 1 : 0
    if (c === 'long_context') return rec.long_context == null ? null : rec.long_context ? 1 : 0
    if (JSON_TEXT_USAGE_COLUMNS.has(c)) {
      const val = rec[c]
      if (val == null || val === '') return null
      return typeof val === 'string' ? stripNul(val) : safeJsonStringify(val)
    }
    if (c === 'cache_creation_tokens') {
      return rec[c] == null ? null : Number(rec[c]) || 0
    }
    if (ZERO_DEFAULT_USAGE_COLUMNS.has(c)) {
      return Number(rec[c]) || 0
    }
    return rec[c] == null ? null : stripNul(rec[c])
  })
}

/**
 * Normalize a `request_attempts` record (accepting both snake_case and camelCase inputs).
 */
export function normalizeAttemptRecord(rec = {}) {
  const requestId = stripNul(rec.request_id ?? rec.requestId ?? null)
  const attemptNoRaw = rec.attempt_no ?? rec.attemptNo
  const attemptNo = attemptNoRaw == null ? null : Number(attemptNoRaw)

  let usageJson = null
  if (rec.usage_json !== undefined) {
    usageJson =
      rec.usage_json == null
        ? null
        : typeof rec.usage_json === 'string'
          ? stripNul(rec.usage_json)
          : safeJsonStringify(rec.usage_json)
  } else if (rec.usage !== undefined) {
    usageJson = rec.usage == null ? null : safeJsonStringify(rec.usage)
  }

  let errorDetailsJson = null
  if (rec.error_details_json !== undefined) {
    errorDetailsJson =
      rec.error_details_json == null
        ? null
        : typeof rec.error_details_json === 'string'
          ? stripNul(rec.error_details_json)
          : safeJsonStringify(rec.error_details_json)
  } else {
    const rawErrDetails = rec.error_details ?? rec.errorDetails
    if (rawErrDetails != null) {
      errorDetailsJson = typeof rawErrDetails === 'string' ? stripNul(rawErrDetails) : safeJsonStringify(rawErrDetails)
    }
  }

  const rawCommitted = rec.downstream_committed ?? rec.downstreamCommitted
  const rawTurnId = rec.provider_turn_id ?? rec.providerTurnId
  const providerTurnId =
    typeof rawTurnId === 'number' && Number.isSafeInteger(rawTurnId) && rawTurnId >= 0
      ? String(rawTurnId)
      : rawTurnId == null
        ? null
        : stripNul(String(rawTurnId))

  return {
    request_id: requestId,
    attempt_no: attemptNo,
    vm_id: stripNul(rec.vm_id ?? rec.vmId ?? null),
    account_id: stripNul(rec.account_id ?? rec.accountId ?? null),
    model: stripNul(rec.model ?? null),
    selection_reason: stripNul(rec.selection_reason ?? rec.selectionReason ?? null),
    started_at: stripNul(rec.started_at ?? rec.startedAt ?? null),
    completed_at: stripNul(rec.completed_at ?? rec.completedAt ?? null),
    upstream_status: rec.upstream_status ?? rec.upstreamStatus ?? null,
    error_scope: stripNul(rec.error_scope ?? rec.errorScope ?? null),
    action: stripNul(rec.action ?? null),
    cooldown_until: normalizeCooldownUntilMs(rec.cooldown_until ?? rec.cooldownUntil),
    downstream_committed: rawCommitted ? 1 : 0,
    terminal_state: stripNul(rec.terminal_state ?? rec.terminalState ?? null),
    usage_json: usageJson,
    wait_ms: rec.wait_ms ?? rec.waitMs ?? null,
    ttft_ms: rec.ttft_ms ?? rec.ttftMs ?? null,
    latency_ms: rec.latency_ms ?? rec.latencyMs ?? null,
    queue_wait_ms: rec.queue_wait_ms ?? rec.queueWaitMs ?? null,
    scheduling_ms: rec.scheduling_ms ?? rec.schedulingMs ?? null,
    error_code: stripNul(rec.error_code ?? rec.errorCode ?? null),
    upstream_type: stripNul(rec.upstream_type ?? rec.upstreamType ?? null),
    error_details_json: errorDetailsJson,
    hop_request_id: stripNul(rec.hop_request_id ?? rec.hopRequestId ?? null),
    provider_run_id: stripNul(rec.provider_run_id ?? rec.providerRunId ?? null),
    provider_turn_id: providerTurnId,
    provider_attempt_id: normalizeProviderAttemptId(rec.provider_attempt_id ?? rec.providerAttemptId),
    provider_request_id: stripNul(rec.provider_request_id ?? rec.providerRequestId ?? null),
  }
}

function mergeAttemptRecords(prev, next) {
  const out = { ...prev }
  out.started_at = prev.started_at || next.started_at || null
  out.downstream_committed = Math.max(prev.downstream_committed ? 1 : 0, next.downstream_committed ? 1 : 0)
  out.terminal_state =
    next.terminal_state != null && next.terminal_state !== 'started'
      ? next.terminal_state
      : (prev.terminal_state ?? next.terminal_state ?? null)

  for (const col of REQUEST_ATTEMPT_COLUMNS) {
    if (
      col === 'request_id' ||
      col === 'attempt_no' ||
      col === 'started_at' ||
      col === 'downstream_committed' ||
      col === 'terminal_state'
    ) {
      continue
    }
    out[col] = next[col] != null ? next[col] : (prev[col] ?? null)
  }
  return out
}

function attemptToRow(norm) {
  const startedAt = norm.started_at || norm.completed_at || new Date().toISOString()
  return REQUEST_ATTEMPT_COLUMNS.map((c) => {
    if (c === 'started_at') return startedAt
    if (c === 'downstream_committed') return norm.downstream_committed ? 1 : 0
    return norm[c] ?? null
  })
}

/**
 * Normalize and size-cap a `request_log_debug` record to `maxDebugBytes` UTF-8 bytes.
 * Always produces valid JSON so `UsageLogsRepo.getDebug()` can parse truncated rows cleanly.
 */
export function normalizeDebugRecord(requestIdOrObj, ts, record, maxDebugBytes = DEFAULT_MAX_DEBUG_BYTES) {
  let reqId
  let timestamp
  let rawRecord
  if (requestIdOrObj && typeof requestIdOrObj === 'object') {
    reqId = requestIdOrObj.request_id ?? requestIdOrObj.requestId ?? requestIdOrObj.id ?? null
    timestamp = requestIdOrObj.ts ?? requestIdOrObj.created_at ?? null
    rawRecord =
      requestIdOrObj.record_json !== undefined
        ? requestIdOrObj.record_json
        : requestIdOrObj.record !== undefined
          ? requestIdOrObj.record
          : requestIdOrObj
  } else {
    reqId = requestIdOrObj
    timestamp = ts
    rawRecord = record
  }

  const request_id = stripNul(reqId == null ? '' : String(reqId))
  const finalTs = stripNul(timestamp || new Date().toISOString())
  let recordJson = typeof rawRecord === 'string' ? stripNul(rawRecord) : safeJsonStringify(rawRecord ?? {})

  const cap = Number.isFinite(Number(maxDebugBytes))
    ? Math.max(0, Math.trunc(Number(maxDebugBytes)))
    : DEFAULT_MAX_DEBUG_BYTES
  const byteLen = Buffer.byteLength(recordJson, 'utf8')

  if (cap > 0 && byteLen > cap) {
    const base = {
      _truncated: true,
      _original_bytes: byteLen,
      _max_bytes: cap,
    }
    if (rawRecord && typeof rawRecord === 'object' && !Array.isArray(rawRecord)) {
      for (const k of ['id', 'request_id', 'ts', 'status', 'model', 'path', 'method', 'error_code']) {
        if (rawRecord[k] != null && typeof rawRecord[k] !== 'object') {
          base[k] = stripNul(rawRecord[k])
        }
      }
    }
    const baseJson = safeJsonStringify({ ...base, preview: '' })
    const baseBytes = Buffer.byteLength(baseJson, 'utf8')
    if (baseBytes < cap) {
      // Reserve extra headroom for JSON string escaping (quotes/backslashes/newlines).
      const room = cap - baseBytes
      let preview = truncateUtf8ByBytes(recordJson, room)
      let candidate = safeJsonStringify({ ...base, preview })
      while (Buffer.byteLength(candidate, 'utf8') > cap && preview.length > 0) {
        preview = preview.slice(0, Math.floor(preview.length * 0.75))
        if (preview.length > 0) {
          const last = preview.charCodeAt(preview.length - 1)
          if (last >= 0xd800 && last <= 0xdbff) preview = preview.slice(0, -1)
        }
        candidate = safeJsonStringify({ ...base, preview })
      }
      recordJson = candidate
    } else {
      const minimal = safeJsonStringify({ _truncated: true, _original_bytes: byteLen })
      recordJson = Buffer.byteLength(minimal, 'utf8') <= cap ? minimal : '{"_truncated":true}'
    }
  }

  return {
    request_id,
    ts: finalTs,
    record_json: recordJson,
  }
}

/**
 * Build a single parameterized multi-row PostgreSQL `INSERT` statement.
 * @returns {{ sql: string, params: any[] }}
 */
export function buildMultiRowInsert(table, columns, rows, conflictClause = '') {
  const colCount = columns.length
  const params = new Array(rows.length * colCount)
  const tuplePlaceholders = new Array(rows.length)
  let p = 0

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r]
    const placeholders = new Array(colCount)
    for (let c = 0; c < colCount; c += 1) {
      params[p] = row[c]
      p += 1
      placeholders[c] = `$${p}`
    }
    tuplePlaceholders[r] = `(${placeholders.join(', ')})`
  }

  const suffix = conflictClause ? ` ${conflictClause}` : ''
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuplePlaceholders.join(', ')}${suffix}`
  return { sql, params }
}

function clampPositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export class PgLogWriter {
  constructor(pool, opts = {}) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError('PgLogWriter requires a pg pool with a query() method')
    }
    this.pool = pool
    this.batchSize = clampPositiveInt(opts.batchSize, DEFAULT_BATCH_SIZE, 1, 10_000)
    this.flushIntervalMs = clampPositiveInt(opts.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS, 5, 60_000)
    this.maxPending = clampPositiveInt(opts.maxPending, DEFAULT_MAX_PENDING, 1, 500_000)
    this.maxDebugBytes = clampPositiveInt(
      opts.maxDebugBytes ?? opts.maxDebugRecordBytes,
      DEFAULT_MAX_DEBUG_BYTES,
      0,
      50 * 1024 * 1024,
    )
    this.maxParamsPerQuery = clampPositiveInt(opts.maxParamsPerQuery, DEFAULT_MAX_PARAMS_PER_QUERY, 256, 65_535)
    this.onFlushed = typeof opts.onFlushed === 'function' ? opts.onFlushed : null
    this.onError =
      typeof opts.onError === 'function'
        ? opts.onError
        : (err, ctx) => {
            console.warn(`[pg-log-writer] ${ctx?.table || 'write'} ${ctx?.phase || 'error'}:`, err?.message || err)
          }

    this._usageQueue = []
    this._attemptQueue = []
    this._debugQueue = []

    this._timer = null
    this._urgentScheduled = false
    this._flushPromise = null
    this._directInFlight = new Set()
    this._closing = false
    this._closed = false

    this._stats = {
      enqueued: 0,
      flushed: 0,
      batches: 0,
      fallbacks: 0,
      overflowDirect: 0,
      dropped: 0,
      errors: 0,
      lastFlushMs: 0,
      lastFlushAt: null,
    }
  }

  pending() {
    return this._usageQueue.length + this._attemptQueue.length + this._debugQueue.length
  }

  stats() {
    return {
      queued: this.pending(),
      enqueued: this._stats.enqueued,
      flushed: this._stats.flushed,
      batches: this._stats.batches,
      fallbacks: this._stats.fallbacks,
      overflowDirect: this._stats.overflowDirect,
      dropped: this._stats.dropped,
      errors: this._stats.errors,
      lastFlushMs: this._stats.lastFlushMs,
      lastFlushAt: this._stats.lastFlushAt,
      queues: {
        usageLogs: this._usageQueue.length,
        attempts: this._attemptQueue.length,
        debugRecords: this._debugQueue.length,
      },
      closed: this._closed,
    }
  }

  /**
   * Enqueue a `usage_logs` summary row (and optional paired `request_log_debug` record).
   * Never silently drops: overflows trigger urgent flush + direct async write.
   */
  enqueueUsageLog(record, debugRecord = null) {
    if (!record || typeof record !== 'object') return false
    const okMain = this._enqueueItem('usage_logs', record)
    if (debugRecord != null) {
      const reqId = record.request_id || record.id
      const ts = record.created_at || record.ts || new Date().toISOString()
      this._enqueueItem('request_log_debug', normalizeDebugRecord(reqId, ts, debugRecord, this.maxDebugBytes))
    }
    return okMain
  }

  /**
   * Enqueue a `request_attempts` row (supports begin, complete, or full attempt upsert).
   */
  enqueueAttempt(attempt) {
    if (!attempt || typeof attempt !== 'object') return false
    return this._enqueueItem('request_attempts', normalizeAttemptRecord(attempt))
  }

  /**
   * Enqueue a `request_log_debug` row (truncated if exceeding `maxDebugBytes`).
   */
  enqueueDebug(requestIdOrObj, ts, record) {
    if (requestIdOrObj == null) return false
    const norm = normalizeDebugRecord(requestIdOrObj, ts, record, this.maxDebugBytes)
    if (!norm.request_id) return false
    return this._enqueueItem('request_log_debug', norm)
  }

  /** Generic envelope dispatch: `{ kind: 'usage_log' | 'attempt' | 'debug', ... }`. */
  enqueue(entry) {
    if (!entry || typeof entry !== 'object') return false
    if (entry.kind === 'usage_log') return this.enqueueUsageLog(entry.record ?? entry.summary, entry.debug ?? null)
    if (entry.kind === 'attempt') return this.enqueueAttempt(entry.record ?? entry.attempt ?? entry)
    if (entry.kind === 'debug') return this.enqueueDebug(entry.request_id ?? entry.requestId, entry.ts, entry.record)
    return false
  }

  _enqueueItem(table, item) {
    if (this._closed) {
      this._stats.dropped += 1
      return false
    }
    this._stats.enqueued += 1

    // Overflow protection: never silently drop logs; trigger urgent flush + direct write.
    if (this.pending() >= this.maxPending) {
      this._stats.overflowDirect += 1
      this._triggerUrgentFlush()
      this._dispatchDirectWrite(table, item)
      return true
    }

    if (table === 'usage_logs') this._usageQueue.push(item)
    else if (table === 'request_attempts') this._attemptQueue.push(item)
    else this._debugQueue.push(item)

    if (this.pending() >= this.batchSize) {
      this._triggerUrgentFlush()
    } else if (!this._closing) {
      this._armTimer()
    }
    return true
  }

  _armTimer() {
    if (this._timer || this._closing || this._closed || this.pending() === 0) return
    this._timer = setTimeout(() => {
      this._timer = null
      void this._runOneFlushCycle()
    }, this.flushIntervalMs)
    this._timer.unref?.()
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }

  _triggerUrgentFlush() {
    this._clearTimer()
    if (this._urgentScheduled || this._closed) return
    this._urgentScheduled = true
    queueMicrotask(() => {
      this._urgentScheduled = false
      if (this._closed || this.pending() === 0) return
      void this._runOneFlushCycle()
    })
  }

  _dispatchDirectWrite(table, item) {
    const p = (async () => {
      try {
        if (table === 'usage_logs') {
          const { sql, params } = buildMultiRowInsert(
            'usage_logs',
            USAGE_LOG_COLUMNS,
            [usageLogToRow(item)],
            USAGE_LOG_CONFLICT_SQL,
          )
          await this.pool.query(sql, params)
          this._stats.flushed += 1
          this._notifyFlushed({ usageLogs: 1, attempts: 0, debugRecords: 0 })
        } else if (table === 'request_attempts') {
          const { sql, params } = buildMultiRowInsert(
            'request_attempts',
            REQUEST_ATTEMPT_COLUMNS,
            [attemptToRow(item)],
            REQUEST_ATTEMPT_CONFLICT_SQL,
          )
          await this.pool.query(sql, params)
          this._stats.flushed += 1
          this._notifyFlushed({ usageLogs: 0, attempts: 1, debugRecords: 0 })
        } else {
          const { sql, params } = buildMultiRowInsert(
            'request_log_debug',
            REQUEST_DEBUG_COLUMNS,
            [[item.request_id, item.ts, item.record_json]],
            REQUEST_DEBUG_CONFLICT_SQL,
          )
          await this.pool.query(sql, params)
          this._stats.flushed += 1
          this._notifyFlushed({ usageLogs: 0, attempts: 0, debugRecords: 1 })
        }
      } catch (err) {
        this._stats.errors += 1
        this._stats.dropped += 1
        this._reportError(err, { table, phase: 'overflow_direct', requestId: item?.request_id ?? null })
      }
    })()

    this._directInFlight.add(p)
    p.finally(() => {
      this._directInFlight.delete(p)
    })
    return p
  }

  _reportError(err, ctx) {
    try {
      this.onError(err, ctx)
    } catch {}
  }

  _notifyFlushed(summary) {
    if (!this.onFlushed) return
    try {
      this.onFlushed(summary)
    } catch {}
  }

  async _runOneFlushCycle() {
    if (this._flushPromise) return this._flushPromise
    if (this.pending() === 0) return this.stats()

    this._clearTimer()
    const run = (async () => {
      const started = performance.now()
      const usageItems = this._usageQueue.splice(0, this.batchSize)
      const attemptItems = this._attemptQueue.splice(0, this.batchSize)
      const debugItems = this._debugQueue.splice(0, this.batchSize)

      let usageFlushed = 0
      let attemptsFlushed = 0
      let debugFlushed = 0

      if (usageItems.length > 0) {
        usageFlushed = await this._flushUsageBatch(usageItems)
      }
      if (attemptItems.length > 0) {
        attemptsFlushed = await this._flushAttemptBatch(attemptItems)
      }
      // Debug records execute independently so any failure never affects main logs.
      if (debugItems.length > 0) {
        debugFlushed = await this._flushDebugBatch(debugItems)
      }

      this._stats.batches += 1
      this._stats.lastFlushMs = Math.round(Math.max(0, performance.now() - started) * 1000) / 1000
      this._stats.lastFlushAt = new Date().toISOString()

      if (usageFlushed + attemptsFlushed + debugFlushed > 0) {
        this._notifyFlushed({
          usageLogs: usageFlushed,
          attempts: attemptsFlushed,
          debugRecords: debugFlushed,
        })
      }
    })()

    this._flushPromise = run
    try {
      await run
    } finally {
      this._flushPromise = null
      if (!this._closing && !this._closed && this.pending() > 0) {
        if (this.pending() >= this.batchSize) this._triggerUrgentFlush()
        else this._armTimer()
      }
    }
    return this.stats()
  }

  async _flushUsageBatch(items) {
    // Deduplicate identical non-null request_id within the same batch (keep first, matching DO NOTHING).
    const deduped = []
    const byReqId = new Map()
    for (const item of items) {
      const reqId = item.request_id != null && item.request_id !== '' ? String(item.request_id) : null
      if (reqId && byReqId.has(reqId)) {
        byReqId.get(reqId).count += 1
        continue
      }
      const entry = { row: usageLogToRow(item), count: 1, requestId: reqId }
      if (reqId) byReqId.set(reqId, entry)
      deduped.push(entry)
    }

    return this._executeChunkedBatch('usage_logs', USAGE_LOG_COLUMNS, deduped, USAGE_LOG_CONFLICT_SQL)
  }

  async _flushAttemptBatch(items) {
    // Merge same (request_id, attempt_no) within the batch to avoid PG 21000
    // ("ON CONFLICT DO UPDATE command cannot affect row a second time") when
    // begin() and complete() land in the same micro-batch.
    const merged = []
    const byKey = new Map()
    for (const item of items) {
      const key = `${item.request_id ?? ''}\0${item.attempt_no ?? ''}`
      if (item.request_id && item.attempt_no != null && byKey.has(key)) {
        const existing = byKey.get(key)
        existing.norm = mergeAttemptRecords(existing.norm, item)
        existing.count += 1
        continue
      }
      const entry = { norm: item, count: 1, requestId: item.request_id ?? null }
      if (item.request_id && item.attempt_no != null) byKey.set(key, entry)
      merged.push(entry)
    }

    const entries = merged.map((e) => ({
      row: attemptToRow(e.norm),
      count: e.count,
      requestId: e.requestId,
    }))
    return this._executeChunkedBatch('request_attempts', REQUEST_ATTEMPT_COLUMNS, entries, REQUEST_ATTEMPT_CONFLICT_SQL)
  }

  async _flushDebugBatch(items) {
    // Deduplicate same request_id within batch (keep latest, matching ON CONFLICT DO UPDATE).
    const byReqId = new Map()
    for (const item of items) {
      const existing = byReqId.get(item.request_id)
      if (existing) {
        existing.item = item
        existing.count += 1
      } else {
        byReqId.set(item.request_id, { item, count: 1, requestId: item.request_id })
      }
    }
    const entries = [...byReqId.values()].map((e) => ({
      row: [e.item.request_id, e.item.ts, e.item.record_json],
      count: e.count,
      requestId: e.requestId,
    }))
    return this._executeChunkedBatch('request_log_debug', REQUEST_DEBUG_COLUMNS, entries, REQUEST_DEBUG_CONFLICT_SQL)
  }

  async _executeChunkedBatch(table, columns, entries, conflictClause) {
    const maxRows = Math.max(1, Math.floor(this.maxParamsPerQuery / columns.length))
    let totalFlushed = 0

    for (let offset = 0; offset < entries.length; offset += maxRows) {
      const chunk = entries.slice(offset, offset + maxRows)
      const rows = chunk.map((e) => e.row)
      const { sql, params } = buildMultiRowInsert(table, columns, rows, conflictClause)

      try {
        await this.pool.query(sql, params)
        const chunkCount = chunk.reduce((sum, e) => sum + e.count, 0)
        this._stats.flushed += chunkCount
        totalFlushed += chunkCount
      } catch (batchErr) {
        this._stats.errors += 1
        this._stats.fallbacks += 1
        this._reportError(batchErr, { table, phase: 'batch', count: chunk.length })

        // Isolate dirty rows by replaying the failed chunk row-by-row.
        for (const entry of chunk) {
          const single = buildMultiRowInsert(table, columns, [entry.row], conflictClause)
          try {
            await this.pool.query(single.sql, single.params)
            this._stats.flushed += entry.count
            totalFlushed += entry.count
          } catch (rowErr) {
            this._stats.errors += 1
            this._stats.dropped += entry.count
            this._reportError(rowErr, { table, phase: 'fallback_row', requestId: entry.requestId })
          }
        }
      }
    }

    return totalFlushed
  }

  /**
   * Drain barrier: flush all currently queued items (and wait for any in-flight
   * batches or overflow direct writes) until queues are completely empty.
   */
  async flush() {
    this._clearTimer()
    for (;;) {
      if (this._flushPromise) {
        await this._flushPromise
      }
      if (this.pending() === 0) {
        if (this._directInFlight.size > 0) {
          await Promise.allSettled([...this._directInFlight])
          continue
        }
        return this.stats()
      }
      await this._runOneFlushCycle()
    }
  }

  /**
   * Graceful shutdown barrier: stop scheduling new periodic flushes, drain all
   * pending items and in-flight overflow writes, then mark the writer closed.
   */
  async close() {
    if (this._closed) return this.stats()
    this._closing = true
    this._clearTimer()
    try {
      await this.flush()
    } finally {
      this._closed = true
      this._closing = false
      this._clearTimer()
    }
    return this.stats()
  }
}

export function createPgLogWriter(pool, opts = {}) {
  return new PgLogWriter(pool, opts)
}

// ---------------------------------------------------------------------------
// Module-level singleton lifecycle helpers (for database.mjs / server.mjs)
// ---------------------------------------------------------------------------

let _singletonWriter = null

export function getPgLogWriter() {
  return _singletonWriter
}

export function setPgLogWriter(writer) {
  _singletonWriter = writer || null
  return _singletonWriter
}

export function startPgLogWriter(pool, opts = {}) {
  if (!pool) return null
  _singletonWriter = new PgLogWriter(pool, opts)
  return _singletonWriter
}

export async function flushPgLogWriter() {
  if (!_singletonWriter) return null
  return _singletonWriter.flush()
}

export async function stopPgLogWriter() {
  const writer = _singletonWriter
  _singletonWriter = null
  if (!writer) return null
  return writer.close()
}

// ---------------------------------------------------------------------------
// Async ctid-batched retention cleanup (100% parity with UsageLogsRepo.cleanup)
// ---------------------------------------------------------------------------

function resolveCleanupOptions(opts) {
  const raw = typeof opts === 'number' ? { retainDays: opts } : opts || {}
  const retainDays = Math.max(1, Number(raw.retainDays) || 7)
  let debugDays = Math.max(1, Number(raw.debugRetainDays) || 3)
  if (debugDays > retainDays) debugDays = retainDays
  const nowMs = Number.isFinite(Number(raw.now)) ? Number(raw.now) : Date.now()
  return {
    usageCutoff: raw.usageCutoff || new Date(nowMs - retainDays * 86400_000).toISOString(),
    debugCutoff: raw.debugCutoff || new Date(nowMs - debugDays * 86400_000).toISOString(),
    maxBytes: Math.max(0, Number(raw.maxBytes) || 0),
    batchSize: clampPositiveInt(raw.batchSize, DEFAULT_CLEANUP_BATCH_SIZE, 1, 50_000),
    maxBatches: clampPositiveInt(raw.maxBatches, DEFAULT_CLEANUP_MAX_BATCHES, 1, 10_000),
    advisoryLock: raw.advisoryLock !== false,
  }
}

const CTID_ARCHIVE_AND_DELETE_USAGE_SQL = `
WITH doomed AS (
  SELECT ctid
  FROM usage_logs
  WHERE created_at < $1
  LIMIT $2
),
deleted AS (
  DELETE FROM usage_logs
  WHERE ctid IN (SELECT ctid FROM doomed)
  RETURNING
    usage_account_id,
    final_account_id,
    account_id,
    vm_id,
    total_cost,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_creation_tokens
),
archived AS (
  INSERT INTO account_lifetime_usage_archive (account_id, total_cost, total_tokens)
  SELECT
    ${PG_LIFETIME_ACCOUNT_SQL} AS acc_id,
    COALESCE(SUM(total_cost), 0)::double precision AS total_cost,
    COALESCE(SUM(${PG_TOTAL_TOKENS_SQL}), 0)::bigint AS total_tokens
  FROM deleted
  WHERE (${PG_LIFETIME_ACCOUNT_SQL}) IS NOT NULL
  GROUP BY 1
  ON CONFLICT (account_id) DO UPDATE SET
    total_cost = account_lifetime_usage_archive.total_cost + EXCLUDED.total_cost,
    total_tokens = account_lifetime_usage_archive.total_tokens + EXCLUDED.total_tokens
  RETURNING 1
)
SELECT
  (SELECT COUNT(*)::bigint FROM deleted) AS deleted_count,
  (SELECT COUNT(*)::bigint FROM archived) AS archived_accounts
`

const CTID_DELETE_OLD_DEBUG_SQL = `
DELETE FROM request_log_debug
WHERE ctid IN (
  SELECT ctid FROM request_log_debug WHERE ts < $1 LIMIT $2
)
`

const DEBUG_SIZE_STATS_SQL = `
SELECT
  COALESCE(SUM(OCTET_LENGTH(record_json)), 0)::bigint AS used_bytes,
  COUNT(*)::bigint AS total_count
FROM request_log_debug
`

const DELETE_OLDEST_DEBUG_SQL = `
DELETE FROM request_log_debug
WHERE request_id IN (
  SELECT request_id FROM request_log_debug ORDER BY ts ASC LIMIT $1
)
`

/**
 * Async batched PostgreSQL retention cleanup for `usage_logs` and `request_log_debug`.
 *
 * Behaviorally equivalent to `UsageLogsRepo.cleanup()` (lines 1962-2060), without
 * blocking the Node.js event loop or holding a long table-wide delete transaction:
 * 1. Deletes expired `usage_logs` in `ctid` batches (`LIMIT 5000`), atomically
 *    archiving each deleted batch into `account_lifetime_usage_archive`.
 * 2. Monotonically advances `settings.usage_logs_pruned_through` when rows were pruned.
 * 3. Deletes expired `request_log_debug` in `ctid` batches (`LIMIT 5000`).
 * 4. Trims oldest `request_log_debug` rows until `SUM(OCTET_LENGTH(record_json)) <= maxBytes`.
 */
export async function runRetentionCleanupAsync(pool, opts = {}) {
  const empty = {
    skipped: false,
    usage_logs: 0,
    request_log_debug: 0,
    debug_by_age: 0,
    debug_by_size: 0,
    usage_batches: 0,
    debug_batches: 0,
  }
  if (!pool || typeof pool.query !== 'function') {
    return { ...empty, skipped: true, reason: 'no_pool' }
  }

  const cfg = resolveCleanupOptions(opts)
  const useClient = cfg.advisoryLock && typeof pool.connect === 'function'
  const runner = useClient ? await pool.connect() : pool
  let locked = false

  try {
    if (useClient) {
      const lockRes = await runner.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [RETENTION_LOCK_KEY])
      locked = Boolean(lockRes.rows?.[0]?.locked)
      if (!locked) {
        return { ...empty, skipped: true, reason: 'lock_busy' }
      }
    }

    // 1. Archive & delete expired usage_logs in ctid-bounded atomic batches.
    let usageDeleted = 0
    let usageBatches = 0
    for (let i = 0; i < cfg.maxBatches; i += 1) {
      const res = await runner.query(CTID_ARCHIVE_AND_DELETE_USAGE_SQL, [cfg.usageCutoff, cfg.batchSize])
      const n = Number(res.rows?.[0]?.deleted_count ?? res.rowCount ?? 0)
      if (n <= 0) break
      usageDeleted += n
      usageBatches += 1
      if (n < cfg.batchSize) break
    }

    // 2. Monotonically advance `settings.usage_logs_pruned_through` when rows were pruned.
    if (usageDeleted > 0) {
      const prevRes = await runner.query('SELECT value FROM settings WHERE key = $1', [PRUNED_THROUGH_KEY])
      let prev = null
      const rawPrev = prevRes.rows?.[0]?.value
      if (rawPrev != null) {
        try {
          prev = JSON.parse(rawPrev)
        } catch {
          prev = null
        }
      }
      if (!prev || prev < cfg.usageCutoff) {
        await runner.query(
          `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [PRUNED_THROUGH_KEY, JSON.stringify(cfg.usageCutoff), new Date().toISOString()],
        )
      }
    }

    // 3. Delete expired request_log_debug rows in ctid-bounded batches.
    let debugByAge = 0
    let debugBatches = 0
    for (let i = 0; i < cfg.maxBatches; i += 1) {
      const res = await runner.query(CTID_DELETE_OLD_DEBUG_SQL, [cfg.debugCutoff, cfg.batchSize])
      const n = Number(res.rowCount ?? 0)
      if (n <= 0) break
      debugByAge += n
      debugBatches += 1
      if (n < cfg.batchSize) break
    }

    // 4. Trim oldest request_log_debug rows until stored bytes fit maxBytes.
    let debugBySize = 0
    if (cfg.maxBytes > 0) {
      const maxTrimPasses = Math.max(8, Math.min(cfg.maxBatches, 64))
      for (let i = 0; i < maxTrimPasses; i += 1) {
        const statRes = await runner.query(DEBUG_SIZE_STATS_SQL)
        const used = Number(statRes.rows?.[0]?.used_bytes ?? 0)
        const count = Number(statRes.rows?.[0]?.total_count ?? 0)
        if (used <= cfg.maxBytes || count <= 0) break
        const avg = Math.max(1, Math.floor(used / count))
        const need = Math.min(count, cfg.batchSize, Math.max(1, Math.ceil((used - cfg.maxBytes) / avg) + 1))
        const delRes = await runner.query(DELETE_OLDEST_DEBUG_SQL, [need])
        const n = Number(delRes.rowCount ?? 0)
        if (n <= 0) break
        debugBySize += n
        debugBatches += 1
      }
    }

    return {
      skipped: false,
      usage_logs: usageDeleted,
      request_log_debug: debugByAge + debugBySize,
      debug_by_age: debugByAge,
      debug_by_size: debugBySize,
      usage_batches: usageBatches,
      debug_batches: debugBatches,
    }
  } finally {
    if (useClient) {
      if (locked) {
        try {
          await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [RETENTION_LOCK_KEY])
        } catch {}
      }
      runner.release()
    }
  }
}
