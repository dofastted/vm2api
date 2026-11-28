/**
 * Keyset-paginated camelCase view over `usage_logs` for the scrolling log page
 * and its side panels (`GET /api/panel/usage-logs*`).
 *
 * Kept apart from `usage-logs-repo.mjs`: that module serves the offset +
 * snake_case `/request-logs` surface (error collection, export). Nothing here
 * runs COUNT(*) or an unbounded scan — the table grows without bound.
 *
 * Shape: `web/src/types/panel-usage-logs.ts`.
 */

import { getDb, isDbOpen } from '../database.mjs'
import { getCacheRuntime } from '../../cache/index.mjs'
import {
  DEFAULT_MUTED_ERROR_CLASSES,
  enrichLogRow,
  excludeErrorClassSql,
  isErrorRow,
} from '../../admin/error-class.mjs'
import { reportTimezone, zonedDayStartMs } from '../../core/timezone.mjs'
import { THIRD_PARTY_CLIENT_SESSION_ID, modelMismatch } from '../../protocol/log-fields.mjs'
import {
  ERROR_PRED,
  PROMPT_TOKENS_SQL,
  SUCCESS_PRED,
  ownerPred,
  totalTokens as rowTotalTokens,
} from './usage-log-preds.mjs'

const LIST_LIMIT_DEFAULT = 50
const LIST_LIMIT_MAX = 100
/** Rows read per round trip when classes must be filtered in JS. */
const SCAN_CHUNK = 500
/** Rows one list call may read before handing the cursor back to the client. */
const SCAN_CAP = 2000
/** Most recent rows a JS-classified summary aggregates. */
const SUMMARY_SCAN_CAP = 5000
/** Recent rows mined for distinct filter values / empty-prefix session suggestions. */
const RECENT_SCAN = 5000
/** One conversation = the caller's session id; rows without one (or tagged as third-party) fall back to the outbound id. */
const CONVERSATION_KEY_SQL = `COALESCE(NULLIF(NULLIF(session_id, ''), '${THIRD_PARTY_CLIENT_SESSION_ID}'), outbound_session_id)`
const OPTION_LIMIT = 200
const EXPORT_LIMIT_DEFAULT = 2000
const EXPORT_LIMIT_MAX = 5000
/** Newest rows an export reads when classes must be filtered in JS. */
const EXPORT_SCAN_CAP = 10000
const DEFAULT_VIA = 'go-worker-pool'
const FAILED_ONLY_PRED = `((status IS NULL OR status < 200 OR status >= 300) OR (final_state IS NOT NULL AND final_state != '' AND final_state != 'verified') OR ${ERROR_PRED})`
const ENTITY_NAMES_TTL_MS = 60_000
const ACTIVE_SESSIONS_FRESH_TTL_MS = 5_000
const ACTIVE_SESSIONS_HARD_TTL_MS = 15_000
const OVERVIEW_FRESH_TTL_MS = 5_000
const OVERVIEW_HARD_TTL_MS = 15_000
const FILTER_OPTIONS_FRESH_TTL_MS = 60_000
const FILTER_OPTIONS_HARD_TTL_MS = 180_000
const UPSTREAM_RISK_STATUSES = new Set([400, 401, 403, 422])
const GENERIC_LIVE_PROVIDERS = new Set(['claude', 'anthropic', 'openai', 'codex', 'gemini'])

const BLOCKED_STATES = {
  distill_blocked: 'distill',
  refusal_guard: 'refusal_guard',
  refusal_similar: 'refusal_guard',
  refusal_device: 'refusal_guard',
  refusal_session: 'refusal_guard',
  policy_blocked: 'policy',
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function nullableNum(v) {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function clampInt(v, min, max, fallback) {
  const n = Math.trunc(Number(v))
  if (v == null || v === '' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function isoOrNull(v) {
  if (v == null || v === '') return null
  const ms = Date.parse(String(v))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function uniq(values) {
  return [...new Set(values.filter((v) => v != null && v !== ''))]
}

function placeholders(list) {
  return list.map(() => '?').join(', ')
}

const NAME_TABLE_QUERIES = {
  users: {
    sql: 'SELECT id, username, email FROM users WHERE id IN ($IN)',
    nameOf: (r) => r.username || r.email || r.id,
  },
  api_keys: {
    sql: 'SELECT id, name FROM api_keys WHERE id IN ($IN)',
    nameOf: (r) => r.name || r.id,
  },
  vms: {
    sql: 'SELECT id, name FROM vms WHERE id IN ($IN)',
    nameOf: (r) => r.name || r.id,
  },
  accounts: {
    sql: 'SELECT id, email, name FROM accounts WHERE id IN ($IN)',
    nameOf: (r) => r.email || r.name || r.id,
  },
}

function resolveCacheRuntime(explicitCache = null) {
  if (explicitCache) return explicitCache
  try {
    return getCacheRuntime()
  } catch {
    return null
  }
}

/**
 * Only share the process-global L1/L2 cache for the live singleton DB (or PG)
 * or an explicitly injected cache runtime — prevents isolated unit-test DBs
 * with identical fixture IDs (`u1`/`k1`/`vm-a`) from cross-polluting each other.
 */
function shouldUseSharedCache(db, explicitCache = null) {
  if (explicitCache) return true
  if (!db) return false
  if (db.engine === 'postgres') return true
  return isDbOpen() && db === getDb()
}

function dbLoadEntityNames(db, table, ids) {
  const cfg = NAME_TABLE_QUERIES[table]
  const map = new Map()
  const list = uniq(ids)
  if (!cfg || !list.length || !db?.prepare) return map
  for (const r of db.prepare(cfg.sql.replace('$IN', placeholders(list))).all(...list)) {
    map.set(String(r.id), cfg.nameOf(r))
  }
  return map
}

/**
 * Batched display names for one page / one aggregate. Uses `EntityCache` L1
 * (60s TTL, auto-invalidated on table mutations) when backed by the shared DB
 * or an explicit cache runtime, falling back to one IN query per missing entity kind.
 */
export function lookupNames(
  db,
  { userIds = [], keyIds = [], vmIds = [], accountIds = [] } = {},
  { cache = null, bypass = false } = {},
) {
  const useCache = !bypass && shouldUseSharedCache(db, cache)
  const entity = useCache ? resolveCacheRuntime(cache)?.entity : null
  const resolve = (table, ids) => {
    const list = uniq(ids)
    if (!list.length) return new Map()
    if (entity && typeof entity.getEntityNamesSync === 'function') {
      return entity.getEntityNamesSync(table, list, (missing) => dbLoadEntityNames(db, table, missing), {
        ttlMs: ENTITY_NAMES_TTL_MS,
      })
    }
    return dbLoadEntityNames(db, table, list)
  }
  return {
    users: resolve('users', userIds),
    keys: resolve('api_keys', keyIds),
    vms: resolve('vms', vmIds),
    accounts: resolve('accounts', accountIds),
  }
}

/**
 * Async L1 + Redis L2 batched entity name resolver (`EntityCache.getEntityNames`).
 * Collapses repeated 5s log polling name lookups from 4 PG queries down to 0 on cache hits.
 */
export async function lookupNamesAsync(
  db,
  { userIds = [], keyIds = [], vmIds = [], accountIds = [] } = {},
  { cache = null, bypass = false } = {},
) {
  const useCache = !bypass && shouldUseSharedCache(db, cache)
  const entity = useCache ? resolveCacheRuntime(cache)?.entity : null
  const resolve = async (table, ids) => {
    const list = uniq(ids)
    if (!list.length) return new Map()
    if (entity && typeof entity.getEntityNames === 'function') {
      return entity.getEntityNames(table, list, (missing) => dbLoadEntityNames(db, table, missing), {
        ttlMs: ENTITY_NAMES_TTL_MS,
      })
    }
    return dbLoadEntityNames(db, table, list)
  }
  const [users, keys, vms, accounts] = await Promise.all([
    resolve('users', userIds),
    resolve('api_keys', keyIds),
    resolve('vms', vmIds),
    resolve('accounts', accountIds),
  ])
  return { users, keys, vms, accounts }
}

function cacheTtlApplied(row) {
  const short = num(row.cache_creation_5m_tokens)
  const long = num(row.cache_creation_1h_tokens)
  if (short > 0 && long > 0) return 'mixed'
  if (long > 0) return '1h'
  if (short > 0) return '5m'
  return null
}

function costBreakdown(row) {
  if (
    [row.input_cost, row.output_cost, row.cache_read_cost, row.cache_creation_cost, row.total_cost].every(
      (v) => v == null,
    )
  )
    return null
  return {
    input: nullableNum(row.input_cost),
    output: nullableNum(row.output_cost),
    cacheRead: nullableNum(row.cache_read_cost),
    cacheCreation: nullableNum(row.cache_creation_cost),
    baseTotal: nullableNum(row.total_cost),
    groupMultiplier: nullableNum(row.rate_multiplier),
    pricingModel: row.pricing_model ?? null,
  }
}

/** Re-evaluate stored mismatch=1 rows so legacy Gemini tier-suffix rows do not falsely flag as redirected. */
function effectiveModelMismatch(row) {
  if (row.model_mismatch == null) return null
  const stored = Number(row.model_mismatch)
  if (stored !== 1) return stored
  const requested = row.requested_model || row.model
  const upstream = row.upstream_model
  if (requested && upstream && modelMismatch(requested, upstream) === 0) return 0
  return stored
}

/** Switches that changed how this request was served. Fixed order; the UI does not sort. */
function specialSettings(row) {
  const out = []
  if (row.stream) out.push({ key: 'stream', label: '流式' })
  if (row.has_tools) out.push({ key: 'tools', label: '工具调用' })
  if (row.log_mode === 'debug') out.push({ key: 'debug', label: '调试采样' })
  if (effectiveModelMismatch(row) === 1)
    out.push({ key: 'mismatch', label: '模型重定向', value: `${row.requested_model} → ${row.upstream_model}` })
  if (row.speed === 'fast') out.push({ key: 'fast', label: 'Fast 模式', value: row.speed })
  if (row.service_tier === 'priority') out.push({ key: 'priority', label: 'Priority', value: row.service_tier })
  if (row.service_tier === 'ultrafast') out.push({ key: 'ultrafast', label: 'Ultrafast', value: row.service_tier })
  if (['priority', 'fast', 'ultrafast'].includes(row.service_tier) && row.upstream_service_tier)
    out.push({ key: 'upstream_service_tier', label: '上游档位回显', value: row.upstream_service_tier })
  if (row.long_context === 1) out.push({ key: 'context1m', label: '1M 上下文' })
  if (row.via && row.via !== DEFAULT_VIA) out.push({ key: 'via', label: '路由', value: row.via })
  return out
}

function blockedBy(row) {
  if (BLOCKED_STATES[row.final_state]) return BLOCKED_STATES[row.final_state]
  if (row.error_class === 'distill') return 'distill'
  return null
}

function parseErrorDetails(value) {
  if (value == null || value === '') return null
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Raw `usage_logs` row (already `enrichLogRow`-ed) + batched names → `UsageLogRow`. */
export function toUsageLogRow(row, names, chain = []) {
  const accountId = row.final_account_id || row.account_id || null
  const inputTokens = num(row.input_tokens)
  const outputTokens = num(row.output_tokens)
  const cacheCreation = nullableNum(row.cache_creation_tokens)
  const cacheRead = num(row.cache_read_tokens)
  const blocked = blockedBy(row)
  const errorDetails = parseErrorDetails(row.error_details)
  return {
    id: row.id,
    requestId: row.request_id ?? null,
    createdAt: row.created_at,
    userId: row.user_id ?? null,
    userName: row.user_id ? (names.users.get(row.user_id) ?? null) : null,
    keyId: row.api_key_id ?? null,
    keyName: row.api_key_id ? (names.keys.get(row.api_key_id) ?? null) : null,
    sessionId: row.outbound_session_id ?? null,
    /** What the caller sent; differs from sessionId whenever the gateway rebuilt it. */
    clientSessionId: row.session_id ?? null,
    providerName: accountId ? (names.accounts.get(accountId) ?? accountId) : null,
    accountId,
    vmId: row.vm_id ?? null,
    vmName: row.vm_id ? (names.vms.get(row.vm_id) ?? row.vm_id) : null,
    model: row.model ?? null,
    originalModel: row.requested_model ?? null,
    actualResponseModel: row.upstream_model ?? null,
    modelMismatch: effectiveModelMismatch(row),
    endpoint: row.path ?? null,
    protocol: row.protocol ?? null,
    method: row.method ?? null,
    statusCode: nullableNum(row.status),
    logMode: row.log_mode === 'debug' || row.log_mode === 'normal' ? row.log_mode : null,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    cacheCreation5mInputTokens: num(row.cache_creation_5m_tokens),
    cacheCreation1hInputTokens: num(row.cache_creation_1h_tokens),
    cacheTtlApplied: cacheTtlApplied(row),
    totalTokens: rowTotalTokens(row),
    costUsd: nullableNum(row.total_cost),
    actualCostUsd: nullableNum(row.actual_cost),
    groupCostMultiplier: nullableNum(row.rate_multiplier),
    costBreakdown: costBreakdown(row),
    durationMs: nullableNum(row.duration_ms),
    ttftMs: nullableNum(row.first_token_ms),
    firstByteMs: nullableNum(row.first_byte_ms),
    generationMs: nullableNum(row.generation_ms),
    stopReason: row.stop_reason ?? null,
    attemptCount: nullableNum(row.attempt_count),
    finalState: row.final_state ?? null,
    via: row.via ?? null,
    stream: row.stream == null ? null : !!row.stream,
    hasTools: row.has_tools == null ? null : !!row.has_tools,
    serviceTier: row.service_tier ?? null,
    /** `response.service_tier` the upstream echoed; billing uses serviceTier (the sent tier). */
    upstreamServiceTier: row.upstream_service_tier ?? null,
    speed: row.speed ?? null,
    context1mApplied: row.long_context == null ? null : row.long_context === 1,
    reasoningEffort: row.reasoning_effort ?? null,
    inboundDeviceId: row.inbound_device_id ?? null,
    upstreamStatus: nullableNum(row.upstream_status),
    upstream400Message: row.upstream_400_message ?? null,
    intercept: parseErrorDetails(row.intercept),
    jevState: row.jev_state || null,
    errorClass: row.error_class ?? null,
    errorLabel: row.error_label ?? null,
    errorOwner: row.error_owner ?? null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    upstreamType: row.upstream_type ?? errorDetails?.upstream_type ?? null,
    errorDetails,
    blockedBy: blocked,
    blockedReason: blocked ? row.error_message || row.error_label || null : null,
    userAgent: row.user_agent || null,
    clientIp: row.ip_address || null,
    apiKeyPresented: row.api_key_presented || null,
    specialSettings: specialSettings(row),
    providerChain: chain,
  }
}

const ATTEMPT_CLOCK_SLACK_MS = 1000

/**
 * request_id can come from the client's `x-request-id`, so an id can be reused
 * across requests (and tenants) once one side's rows are purged. Only attach
 * attempts that started inside this row's own request lifetime:
 * [created_at - duration_ms, created_at], created_at being completion time.
 */
function attemptWithinRow(attempt, row) {
  const started = Date.parse(attempt.started_at)
  const finished = Date.parse(row.created_at)
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return false
  if (started > finished + ATTEMPT_CLOCK_SLACK_MS) return false
  const duration = Number(row.duration_ms)
  if (row.duration_ms == null || !Number.isFinite(duration)) return true
  return started >= finished - duration - ATTEMPT_CLOCK_SLACK_MS
}

function toProviderChainItem(r, names) {
  const errorDetails = parseErrorDetails(r.error_details_json)
  return {
    attemptNumber: num(r.attempt_no),
    vmId: r.vm_id ?? null,
    vmName: r.vm_id ? (names.vms.get(r.vm_id) ?? r.vm_id) : null,
    accountId: r.account_id ?? null,
    providerName: r.account_id ? (names.accounts.get(r.account_id) ?? r.account_id) : null,
    model: r.model ?? null,
    selectionReason: r.selection_reason ?? null,
    upstreamStatus: nullableNum(r.upstream_status),
    errorScope: r.error_scope ?? null,
    errorCode: r.error_code ?? null,
    upstreamType: r.upstream_type ?? errorDetails?.upstream_type ?? null,
    errorDetails,
    terminalState: r.terminal_state ?? null,
    action: r.action ?? null,
    downstreamCommitted: !!r.downstream_committed,
    hopRequestId: r.hop_request_id ?? null,
    providerRunId: r.provider_run_id ?? null,
    providerTurnId: r.provider_turn_id ?? null,
    providerAttemptId: nullableNum(r.provider_attempt_id),
    providerRequestId: r.provider_request_id ?? null,
    waitMs: nullableNum(r.wait_ms),
    queueWaitMs: nullableNum(r.queue_wait_ms),
    schedulingMs: nullableNum(r.scheduling_ms),
    ttftMs: nullableNum(r.ttft_ms),
    latencyMs: nullableNum(r.latency_ms),
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
  }
}

function splitClasses(raw) {
  return uniq(
    String(raw || '')
      .split(',')
      .map((s) => s.trim()),
  )
}

/**
 * Same muting rules as `RequestLogStore._mutedExclude`: an explicit error_class
 * or include_muted disables muting; an explicit exclude list replaces the
 * settings default; otherwise the settings default applies.
 */
function mutedClasses(filters, defaults) {
  if (filters.error_class || filters.include_muted) return []
  const explicit = splitClasses(filters.exclude_error_class)
  return explicit.length ? explicit : defaults.slice()
}

/**
 * Query-string filters (snake_case, see `UsageLogFilters`) → SQL fragment +
 * the JS predicate for what SQL cannot express (read-time error classes).
 */
function buildFilter(filters, defaultMuted) {
  const where = []
  const params = []
  const own = ownerPred(filters.owner_user_id)
  if (own.sql) {
    where.push(own.sql)
    params.push(...own.params)
  }
  const eq = (col, val) => {
    if (val == null || val === '') return
    where.push(`${col} = ?`)
    params.push(String(val))
  }
  eq('user_id', filters.user_id)
  eq('api_key_id', filters.key_id)
  eq('vm_id', filters.vm_id)
  if (filters.session_id) {
    // Either side of the mapping finds the conversation.
    where.push('(outbound_session_id = ? OR session_id = ?)')
    params.push(String(filters.session_id), String(filters.session_id))
  }
  eq('path', filters.endpoint)
  eq('protocol', filters.protocol)
  eq('via', filters.via)
  eq('final_state', filters.final_state)
  if (filters.upstream_risk_errors) where.push('upstream_status IN (400, 401, 403, 422)')
  else if (filters.upstream_400) where.push('upstream_status = 400')
  eq('request_id', filters.request_id)
  if (filters.account_id) {
    where.push('(account_id = ? OR final_account_id = ?)')
    params.push(filters.account_id, filters.account_id)
  }
  if (filters.model) {
    where.push('(model = ? OR requested_model = ?)')
    params.push(filters.model, filters.model)
  }
  const statusCode = clampInt(filters.status_code, 0, 999, null)
  if (statusCode != null) {
    where.push('status = ?')
    params.push(statusCode)
  } else if (filters.exclude_status_200) {
    where.push('(status IS NULL OR status < 200 OR status >= 300)')
  }
  if (filters.model_mismatch) where.push('model_mismatch = 1')
  const minAttempts = clampInt(filters.min_attempt_count, 0, 1000, null)
  if (minAttempts != null) {
    where.push('IFNULL(attempt_count, 0) >= ?')
    params.push(minAttempts)
  }
  if (filters.debug_only) where.push("log_mode = 'debug'")
  // Legacy export `status=error`: the error predicate without picking a class.
  if (filters.errors_only) where.push(ERROR_PRED)
  if (filters.failed_only) where.push(FAILED_ONLY_PRED)
  const start = isoOrNull(filters.start_time)
  if (start) {
    where.push('created_at >= ?')
    params.push(start)
  }
  const end = isoOrNull(filters.end_time)
  if (end) {
    where.push('created_at < ?')
    params.push(end)
  }
  if (filters.q) {
    where.push(
      '(LOWER(path) LIKE ? OR LOWER(error_code) LIKE ? OR LOWER(error_message) LIKE ? OR LOWER(request_id) LIKE ? OR LOWER(upstream_type) LIKE ?)',
    )
    const like = `%${String(filters.q).slice(0, 100).toLowerCase()}%`
    params.push(like, like, like, like, like)
  }
  const errorClass = filters.error_class ? String(filters.error_class) : null
  if (errorClass) where.push(ERROR_PRED)
  const muted = mutedClasses(filters, defaultMuted)
  // SQL can only pre-drop ingress auth; every other class is decided per row.
  const excludeSql = excludeErrorClassSql(muted)
  if (excludeSql) where.push(excludeSql)
  const blocked = new Set(muted)
  const predicates = []
  if (errorClass) predicates.push((row) => row.error_class === errorClass)
  else if (blocked.size) predicates.push((row) => !row.error_class || !blocked.has(row.error_class))
  if (filters.model_mismatch) predicates.push((row) => effectiveModelMismatch(row) === 1)
  const keep = predicates.length ? (row) => predicates.every((fn) => fn(row)) : null
  return {
    where,
    params,
    keep,
    sqlOnlySummary: !errorClass && !filters.model_mismatch && muted.every((c) => c === 'auth'),
  }
}

function exportRow(raw) {
  return enrichLogRow({
    ...raw,
    model_mismatch: effectiveModelMismatch(raw),
    ts: raw.created_at,
    ip: raw.ip_address,
    stream: !!raw.stream,
    has_tools: raw.has_tools == null ? null : !!raw.has_tools,
    upstream_type: raw.upstream_type ?? null,
    error_details: parseErrorDetails(raw.error_details),
  })
}

function whereSql(where) {
  return where.length ? `WHERE ${where.join(' AND ')}` : ''
}

function conversationKeyOf(entry) {
  const clientSess = entry?.session_id != null ? String(entry.session_id).trim() : ''
  if (clientSess && clientSess !== THIRD_PARTY_CLIENT_SESSION_ID) return clientSess
  const outSess = entry?.outbound_session_id != null ? String(entry.outbound_session_id).trim() : ''
  if (outSess) return outSess
  const fallback = entry?.session_key != null ? String(entry.session_key).trim() : ''
  if (fallback && fallback !== THIRD_PARTY_CLIENT_SESSION_ID) return fallback
  return null
}

function loadOwnerKeyIds(db, ownerUserId) {
  const set = new Set()
  if (!ownerUserId || !db?.prepare) return set
  try {
    const rows = db.prepare('SELECT id FROM api_keys WHERE user_id = ? AND deleted_at IS NULL').all(String(ownerUserId))
    for (const r of rows) {
      if (r?.id != null) set.add(String(r.id))
    }
  } catch {}
  return set
}

function entryBelongsToOwner(entry, ownerUserId, getOwnerKeyIds) {
  if (!ownerUserId) return true
  const owner = String(ownerUserId).trim()
  if (!owner) return true
  if (!entry || typeof entry !== 'object') return false
  if (entry.user_id != null && String(entry.user_id) === owner) return true
  if (entry.owner_user_id != null && String(entry.owner_user_id) === owner) return true
  if (entry.vm_owner_user_id != null && String(entry.vm_owner_user_id) === owner) return true
  if (entry.api_key_id != null && entry.api_key_id !== '') {
    const keyIds = typeof getOwnerKeyIds === 'function' ? getOwnerKeyIds() : null
    if (keyIds && keyIds.has(String(entry.api_key_id))) return true
  }
  return false
}

function normalizeLiveRawEntry(entry, now) {
  const live = entry?._live && typeof entry._live === 'object' ? entry._live : null
  const inFlight = entry?.in_flight === true
  const startedAtMs =
    Number(live?.started_at ?? entry?.started_at) ||
    (entry?.created_at && Number.isFinite(Date.parse(entry.created_at)) ? Date.parse(entry.created_at) : now)
  const createdAt =
    entry?.created_at ||
    entry?.ts ||
    (inFlight ? new Date(startedAtMs).toISOString() : new Date(Number(entry?.completed_at) || now).toISOString())
  const vmId = live?.vm_id !== undefined ? live.vm_id : (entry?.vm_id ?? null)
  const accountId = live?.account_id !== undefined ? live.account_id : (entry?.account_id ?? null)
  const attemptCount = live?.attempt_count !== undefined ? live.attempt_count : (entry?.attempt_count ?? null)
  const firstTokenMs = live?.ttft_ms !== undefined ? live.ttft_ms : (entry?.first_token_ms ?? entry?.ttft_ms ?? null)
  const pathVal = entry?.path ?? entry?.endpoint ?? null
  const ipVal = entry?.ip_address ?? entry?.ip ?? entry?.client_ip ?? null
  const sessionId = entry?.session_id ?? entry?.session_key ?? null
  const outboundSessionId = entry?.outbound_session_id ?? null

  const base = {
    ...entry,
    id: entry?.id || `live_${entry?.request_id || ''}`,
    request_id: entry?.request_id != null ? String(entry.request_id) : null,
    created_at: createdAt,
    path: pathVal,
    ip_address: ipVal,
    vm_id: vmId,
    account_id: accountId,
    final_account_id: entry?.final_account_id ?? accountId,
    attempt_count: attemptCount,
    first_token_ms: firstTokenMs,
    session_id: sessionId,
    outbound_session_id: outboundSessionId,
    duration_ms: inFlight ? Math.max(0, now - startedAtMs) : (entry?.duration_ms ?? null),
    status: inFlight ? null : (entry?.status ?? null),
  }
  return inFlight ? { ...base, error_class: null, error_owner: null, error_label: null } : enrichLogRow(base)
}

/**
 * Apply tenant isolation and active query filters to a Redis/local live or recent entry.
 * Filters that only make sense for completed responses (status_code, error_class,
 * failed_only, min_latency, upstream_400, etc.) automatically exclude in-flight entries.
 */
function matchesLiveEntry(rawEntry, filters, defaultMuted, { now = Date.now(), getOwnerKeyIds = null } = {}) {
  if (!rawEntry || typeof rawEntry !== 'object' || !rawEntry.request_id) return false
  if (!entryBelongsToOwner(rawEntry, filters.owner_user_id, getOwnerKeyIds)) return false

  const inFlight = rawEntry.in_flight === true
  const row = normalizeLiveRawEntry(rawEntry, now)

  if (filters.user_id && String(row.user_id || '') !== String(filters.user_id)) return false
  const keyFilter = filters.key_id ?? filters.api_key_id
  if (keyFilter && String(row.api_key_id || '') !== String(keyFilter)) return false
  if (filters.vm_id && String(row.vm_id || '') !== String(filters.vm_id)) return false
  if (filters.account_id) {
    const targetAcc = String(filters.account_id)
    if (String(row.account_id || '') !== targetAcc && String(row.final_account_id || '') !== targetAcc) return false
  }
  const sessionFilter = filters.session_id ?? filters.session_key
  if (sessionFilter) {
    const targetSess = String(sessionFilter)
    if (
      String(row.outbound_session_id || '') !== targetSess &&
      String(row.session_id || '') !== targetSess &&
      String(rawEntry.session_key || '') !== targetSess
    ) {
      return false
    }
  }
  if (filters.endpoint && String(row.path || '') !== String(filters.endpoint)) return false
  if (filters.protocol && String(row.protocol || '') !== String(filters.protocol)) return false
  if (filters.via && String(row.via || '') !== String(filters.via)) return false
  if (filters.final_state) {
    if (inFlight || String(row.final_state || '') !== String(filters.final_state)) return false
  }
  if (filters.request_id && String(row.request_id || '') !== String(filters.request_id)) return false
  if (filters.model) {
    const targetModel = String(filters.model)
    if (String(row.model || '') !== targetModel && String(row.requested_model || '') !== targetModel) return false
  }

  const statusCode = clampInt(filters.status_code ?? filters.statusCode, 0, 999, null)
  if (statusCode != null) {
    if (inFlight || row.status == null || Number(row.status) !== statusCode) return false
  } else if (filters.status != null && filters.status !== '') {
    const rawStatus = String(filters.status).trim().toLowerCase()
    if (rawStatus === 'in_flight' || rawStatus === 'inflight') {
      if (!inFlight) return false
    } else if (rawStatus === 'ok' || rawStatus === 'success') {
      if (inFlight || row.status == null || Number(row.status) < 200 || Number(row.status) >= 400 || isErrorRow(row)) {
        return false
      }
    } else if (rawStatus === 'error') {
      if (inFlight || !isErrorRow(row)) return false
    } else if (/^\d+$/.test(rawStatus)) {
      if (inFlight || row.status == null || Number(row.status) !== Number(rawStatus)) return false
    }
  } else if (filters.exclude_status_200) {
    if (inFlight) return false
    if (row.status != null && Number(row.status) >= 200 && Number(row.status) < 300) return false
  }

  if (filters.upstream_risk_errors) {
    if (inFlight || !UPSTREAM_RISK_STATUSES.has(Number(row.upstream_status))) return false
  } else if (filters.upstream_400) {
    if (inFlight || Number(row.upstream_status) !== 400) return false
  }

  if (filters.model_mismatch) {
    if (inFlight || effectiveModelMismatch(row) !== 1) return false
  }

  const minAttempts = clampInt(filters.min_attempt_count, 0, 1000, null)
  if (minAttempts != null) {
    if ((Number(row.attempt_count) || 0) < minAttempts) return false
  }

  const rawMinLatency = filters.min_latency ?? filters.minLatency ?? filters.min_duration_ms
  if (rawMinLatency != null && rawMinLatency !== '') {
    const minLatency = Number(rawMinLatency)
    if (Number.isFinite(minLatency) && minLatency > 0) {
      if (inFlight || row.duration_ms == null || Number(row.duration_ms) < minLatency) return false
    }
  }

  if (filters.debug_only && row.log_mode !== 'debug') return false
  if (filters.errors_only && (inFlight || !isErrorRow(row))) return false
  if (filters.failed_only) {
    if (inFlight) return false
    const non2xx = row.status == null || Number(row.status) < 200 || Number(row.status) >= 300
    const badFinal = row.final_state != null && row.final_state !== '' && row.final_state !== 'verified'
    if (!non2xx && !badFinal && !isErrorRow(row)) return false
  }

  const start = isoOrNull(filters.start_time)
  const end = isoOrNull(filters.end_time)
  if (start || end) {
    const entryMs = Date.parse(row.created_at)
    if (!Number.isFinite(entryMs)) return false
    if (start && entryMs < Date.parse(start)) return false
    if (end && entryMs >= Date.parse(end)) return false
  }

  if (filters.q) {
    const needle = String(filters.q).slice(0, 100).toLowerCase()
    const hay = [row.path, row.error_code, row.error_message, row.request_id, row.upstream_type]
      .filter((v) => v != null && v !== '')
      .map((v) => String(v).toLowerCase())
    if (!hay.some((s) => s.includes(needle))) return false
  }

  const errorClass = filters.error_class ? String(filters.error_class) : null
  if (errorClass) {
    if (inFlight || row.error_class !== errorClass) return false
  } else {
    const muted = mutedClasses(filters, defaultMuted)
    if (muted.length && !inFlight && row.error_class && muted.includes(row.error_class)) return false
  }

  return true
}

function liveEntryToUsageLogRow(rawEntry, names, now = Date.now()) {
  const inFlight = rawEntry.in_flight === true
  const row = normalizeLiveRawEntry(rawEntry, now)
  const viewRow = toUsageLogRow(row, names, [])
  if (inFlight) {
    const live = rawEntry._live && typeof rawEntry._live === 'object' ? rawEntry._live : {}
    const startedAtMs =
      Number(live.started_at ?? rawEntry.started_at) ||
      (Number.isFinite(Date.parse(viewRow.createdAt)) ? Date.parse(viewRow.createdAt) : now)
    const liveVmId = live.vm_id ?? viewRow.vmId ?? null
    const liveAccountId = live.account_id ?? viewRow.accountId ?? null
    const resolvedSlotOrAccount =
      (liveVmId ? (names.vms.get(liveVmId) ?? null) : null) ||
      (liveAccountId ? (names.accounts.get(liveAccountId) ?? null) : null) ||
      null
    const rawActiveProvider = live.active_provider != null ? String(live.active_provider).trim() : ''
    const isGenericProvider = rawActiveProvider !== '' && GENERIC_LIVE_PROVIDERS.has(rawActiveProvider.toLowerCase())
    const activeProvider =
      (rawActiveProvider && !isGenericProvider ? rawActiveProvider : null) ||
      resolvedSlotOrAccount ||
      rawActiveProvider ||
      null
    const attemptCount = num(live.attempt_count ?? viewRow.attemptCount ?? 0)
    const ttftMs = nullableNum(live.ttft_ms ?? viewRow.ttftMs)
    viewRow.statusCode = null
    viewRow.durationMs = Math.max(0, now - startedAtMs)
    viewRow.attemptCount = attemptCount
    viewRow.ttftMs = ttftMs
    viewRow.vmId = liveVmId
    viewRow.vmName = liveVmId ? (names.vms.get(liveVmId) ?? liveVmId) : null
    viewRow.accountId = liveAccountId
    viewRow.providerName = liveAccountId ? (names.accounts.get(liveAccountId) ?? liveAccountId) : null
    viewRow.in_flight = true
    viewRow.inFlight = true
    viewRow._live = {
      phase: String(live.phase || rawEntry.phase || 'routing'),
      attempt_count: attemptCount,
      started_at: startedAtMs,
      ttft_ms: ttftMs,
      vm_id: liveVmId,
      account_id: liveAccountId,
      active_provider: activeProvider,
    }
    return viewRow
  }
  viewRow.in_flight = false
  viewRow.inFlight = false
  return viewRow
}

function mapRawActiveSessionRow(r, names) {
  return {
    sessionId: r.sid,
    oneOff: r.one_off === 1,
    clientSessionId: r.client_session_id ?? null,
    userName: r.user_id ? (names.users.get(r.user_id) ?? null) : null,
    keyName: r.api_key_id ? (names.keys.get(r.api_key_id) ?? null) : null,
    providerName: r.account ? (names.accounts.get(r.account) ?? r.account) : null,
    vmId: r.vm_id ?? null,
    vmName: r.vm_id ? (names.vms.get(r.vm_id) ?? r.vm_id) : null,
    model: r.model ?? null,
    firstAt: r.first_at,
    lastAt: r.last_at,
    requests: num(r.requests),
    lastStatus: nullableNum(r.status),
    lastDurationMs: nullableNum(r.duration_ms),
    totalTokens: num(r.tokens),
    totalCost: num(r.cost),
  }
}

export class UsageLogsView {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{ mutedErrorClasses?: string[], cache?: any }} [opts] settings default mute list
   */
  constructor(db = getDb(), { mutedErrorClasses = DEFAULT_MUTED_ERROR_CLASSES, cache = null } = {}) {
    this.db = db
    this.mutedErrorClasses = Array.isArray(mutedErrorClasses) ? mutedErrorClasses.slice() : []
    this._cache = cache
  }

  /**
   * One page, newest first, keyset on `(created_at DESC, id DESC)`.
   * When classes are filtered in JS the scan reads at most SCAN_CAP rows; if
   * that cap is hit before `limit` matches, the cursor points at the last
   * scanned row and `hasMore` stays true so the client keeps paging.
   */
  listBatch(filters = {}) {
    const limit = clampInt(filters.limit, 1, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT)
    const { where, params, keep } = buildFilter(filters, this.mutedErrorClasses)
    let cursor =
      filters.cursor_created_at && filters.cursor_id
        ? { createdAt: String(filters.cursor_created_at), id: String(filters.cursor_id) }
        : null
    const matches = []
    let scanned = 0
    let lastScanned = null
    let exhausted = false
    while (matches.length <= limit) {
      const want = keep ? SCAN_CHUNK : limit + 1 - matches.length
      const w = where.slice()
      const p = params.slice()
      if (cursor) {
        w.push('(created_at < ? OR (created_at = ? AND id < ?))')
        p.push(cursor.createdAt, cursor.createdAt, cursor.id)
      }
      const rows = this.db
        .prepare(`SELECT * FROM usage_logs ${whereSql(w)} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...p, want)
      for (const raw of rows) {
        scanned++
        lastScanned = raw
        const row = enrichLogRow(raw)
        if (keep && !keep(row)) continue
        matches.push(row)
        if (matches.length > limit) break
      }
      if (matches.length > limit) break
      if (rows.length < want) {
        exhausted = true
        break
      }
      if (scanned >= SCAN_CAP) break
      cursor = { createdAt: lastScanned.created_at, id: lastScanned.id }
    }

    let page
    let next
    let hasMore
    if (matches.length > limit) {
      page = matches.slice(0, limit)
      next = page[page.length - 1]
      hasMore = true
    } else if (exhausted) {
      page = matches
      next = null
      hasMore = false
    } else {
      page = matches
      next = lastScanned
      hasMore = true
    }
    const nextCursor = next ? { createdAt: next.created_at, id: next.id } : null
    if (filters._rawRows === true) {
      const requestIds = uniq(page.map((r) => r.request_id))
      const attempts = requestIds.length
        ? this.db
            .prepare(
              `SELECT * FROM request_attempts WHERE request_id IN (${placeholders(requestIds)}) ORDER BY request_id, attempt_no`,
            )
            .all(...requestIds)
        : []
      return {
        _rawRows: true,
        rows: page,
        attempts,
        nextCursor,
        hasMore,
      }
    }
    return {
      logs: this._hydrate(page),
      nextCursor,
      hasMore,
    }
  }

  /**
   * Async list endpoint powering `GET /api/panel/usage-logs`:
   * - Page 1 (no cursor): merges Redis/local `LiveLogCache` in-flight + 15s recent
   *   bridge entries with PG/DB page 1 (PG wins on `request_id` dedup), applying
   *   strict tenant isolation and active filter predicates.
   * - Page 2+ (with cursor): pure DB keyset pagination with zero cross-source drift.
   * - Resolves display names via `EntityCache.getEntityNames` (L1 + Redis L2, 60s TTL),
   *   collapsing 5s polling from 6+ PG queries down to 1–2.
   */
  async listBatchAsync(filters = {}, { baseLoader = null, cache = this._cache, now = Date.now() } = {}) {
    const limit = clampInt(filters.limit, 1, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT)
    const hasCursor = Boolean(filters.cursor_created_at && filters.cursor_id)
    const ownerUserId = filters.owner_user_id ? String(filters.owner_user_id).trim() : null
    const runtime = resolveCacheRuntime(cache)
    const liveLogs = runtime?.liveLogs

    const loadBase = async () => {
      const rawFilters = { ...filters, _rawRows: true }
      if (typeof baseLoader === 'function') return baseLoader(rawFilters)
      return this.listBatch(rawFilters)
    }

    const loadLive = async () => {
      if (hasCursor || !liveLogs || typeof liveLogs.listLiveAndRecent !== 'function') return []
      try {
        // Fetch unscoped live/recent rows and apply authoritative 4-way tenant isolation
        // (`user_id` / `owner_user_id` / `vm_owner_user_id` / `ownerKeyIds`) below so
        // tenant VM-owner and key-owner entries are never dropped by Redis pre-filtering.
        const fetchLimit = ownerUserId
          ? Math.min(500, Math.max(limit * 4, 200))
          : Math.min(500, Math.max(limit * 2, 50))
        const entries = await liveLogs.listLiveAndRecent({
          limit: fetchLimit,
          ownerUserId: null,
          includeRecent: true,
          now,
        })
        return Array.isArray(entries) ? entries : []
      } catch {
        return []
      }
    }

    const [baseRes, rawLiveEntries] = await Promise.all([loadBase(), loadLive()])

    let ownerKeyIdsLoaded = false
    let ownerKeyIds = null
    const getOwnerKeyIds = () => {
      if (!ownerKeyIdsLoaded) {
        ownerKeyIdsLoaded = true
        ownerKeyIds = loadOwnerKeyIds(this.db, ownerUserId)
      }
      return ownerKeyIds
    }

    const filteredLive = hasCursor
      ? []
      : rawLiveEntries.filter((entry) =>
          matchesLiveEntry(entry, filters, this.mutedErrorClasses, { now, getOwnerKeyIds }),
        )

    // Hydrate DB rows + filtered live/recent entries using ONE batched EntityCache lookup.
    let pgLogs
    if (baseRes && baseRes._rawRows === true) {
      const rows = Array.isArray(baseRes.rows) ? baseRes.rows : []
      const attempts = Array.isArray(baseRes.attempts) ? baseRes.attempts : []
      const names = await lookupNamesAsync(
        this.db,
        {
          userIds: [...rows.map((r) => r.user_id), ...filteredLive.map((e) => e.user_id)],
          keyIds: [...rows.map((r) => r.api_key_id), ...filteredLive.map((e) => e.api_key_id)],
          vmIds: [
            ...rows.map((r) => r.vm_id),
            ...attempts.map((a) => a.vm_id),
            ...filteredLive.map((e) => e._live?.vm_id ?? e.vm_id),
          ],
          accountIds: [
            ...rows.map((r) => r.final_account_id || r.account_id),
            ...attempts.map((a) => a.account_id),
            ...filteredLive.map((e) => e._live?.account_id ?? e.final_account_id ?? e.account_id),
          ],
        },
        { cache },
      )
      pgLogs = this._hydrateWithNames(rows, attempts, names).map((row) => ({
        ...row,
        in_flight: false,
        inFlight: false,
      }))
      if (!filteredLive.length) {
        return {
          logs: pgLogs,
          nextCursor: baseRes.nextCursor ?? null,
          hasMore: Boolean(baseRes.hasMore),
        }
      }
      return this._mergeFirstPageWithLive({
        pgLogs,
        filteredLive,
        names,
        limit,
        baseRes,
        now,
      })
    }

    // Fallback path when a custom baseLoader returned already-hydrated `{ logs, nextCursor, hasMore }`.
    pgLogs = (Array.isArray(baseRes?.logs) ? baseRes.logs : []).map((row) => ({
      ...row,
      in_flight: row.in_flight === true,
      inFlight: row.in_flight === true || row.inFlight === true,
    }))
    if (!filteredLive.length) {
      return {
        logs: pgLogs,
        nextCursor: baseRes?.nextCursor ?? null,
        hasMore: Boolean(baseRes?.hasMore),
      }
    }
    const liveNames = await lookupNamesAsync(
      this.db,
      {
        userIds: filteredLive.map((e) => e.user_id),
        keyIds: filteredLive.map((e) => e.api_key_id),
        vmIds: filteredLive.map((e) => e._live?.vm_id ?? e.vm_id),
        accountIds: filteredLive.map((e) => e._live?.account_id ?? e.final_account_id ?? e.account_id),
      },
      { cache },
    )
    return this._mergeFirstPageWithLive({
      pgLogs,
      filteredLive,
      names: liveNames,
      limit,
      baseRes,
      now,
    })
  }

  _mergeFirstPageWithLive({ pgLogs, filteredLive, names, limit, baseRes, now }) {
    // PG persisted rows ALWAYS win over Redis recent/in_flight rows for the same request_id.
    const pgRequestIds = new Set(pgLogs.map((r) => r.requestId).filter(Boolean))
    const liveRows = []
    const seenLive = new Set()
    for (const entry of filteredLive) {
      const reqId = String(entry.request_id || '')
      if (!reqId || pgRequestIds.has(reqId) || seenLive.has(reqId)) continue
      seenLive.add(reqId)
      liveRows.push(liveEntryToUsageLogRow(entry, names, now))
    }

    if (!liveRows.length) {
      return {
        logs: pgLogs,
        nextCursor: baseRes?.nextCursor ?? null,
        hasMore: Boolean(baseRes?.hasMore),
      }
    }

    const tagged = [...liveRows.map((row) => ({ row, fromDb: false })), ...pgLogs.map((row) => ({ row, fromDb: true }))]
    tagged.sort((a, b) => {
      const ta = Date.parse(a.row.createdAt || '') || 0
      const tb = Date.parse(b.row.createdAt || '') || 0
      if (tb !== ta) return tb - ta
      const fa = a.row.in_flight ? 1 : 0
      const fb = b.row.in_flight ? 1 : 0
      if (fb !== fa) return fb - fa
      return String(b.row.id || '').localeCompare(String(a.row.id || ''))
    })

    const sliced = tagged.slice(0, limit)
    const keptDb = sliced.filter((item) => item.fromDb)
    const droppedDbCount = pgLogs.length - keptDb.length

    let nextCursor = baseRes?.nextCursor ?? null
    let hasMore = Boolean(baseRes?.hasMore)
    if (droppedDbCount > 0) {
      hasMore = true
      if (keptDb.length > 0) {
        const lastDb = keptDb[keptDb.length - 1].row
        nextCursor = { createdAt: lastDb.createdAt, id: lastDb.id }
      } else if (pgLogs.length > 0) {
        // All page-1 slots were filled by live Redis rows; point cursor just above the first PG row
        // with a non-empty `id` so `usageLogFilters` preserves `cursor_id` and page 2 advances cleanly.
        const firstDbMs = Date.parse(pgLogs[0].createdAt)
        const fallbackId = String(pgLogs[0].id || 'z')
        nextCursor = Number.isFinite(firstDbMs)
          ? { createdAt: new Date(firstDbMs + 1).toISOString(), id: fallbackId }
          : { createdAt: pgLogs[0].createdAt, id: `${fallbackId}\uffff` }
      }
    }

    return {
      logs: sliced.map((item) => item.row),
      nextCursor,
      hasMore,
    }
  }

  _hydrateWithNames(rows, attempts, names) {
    if (!rows.length) return []
    const chains = new Map()
    for (const a of attempts) {
      const list = chains.get(a.request_id) || []
      list.push(a)
      chains.set(a.request_id, list)
    }
    return rows.map((row) => {
      const own = (row.request_id && chains.get(row.request_id)) || []
      const chain = own.filter((a) => attemptWithinRow(a, row)).map((a) => toProviderChainItem(a, names))
      return toUsageLogRow(row, names, chain)
    })
  }

  /** Names + provider chains for a whole page: one attempts query, one lookup per entity kind. */
  _hydrate(rows) {
    if (!rows.length) return []
    const requestIds = uniq(rows.map((r) => r.request_id))
    const attempts = requestIds.length
      ? this.db
          .prepare(
            `SELECT * FROM request_attempts WHERE request_id IN (${placeholders(requestIds)}) ORDER BY request_id, attempt_no`,
          )
          .all(...requestIds)
      : []
    const names = lookupNames(
      this.db,
      {
        userIds: rows.map((r) => r.user_id),
        keyIds: rows.map((r) => r.api_key_id),
        vmIds: [...rows.map((r) => r.vm_id), ...attempts.map((a) => a.vm_id)],
        accountIds: [...rows.map((r) => r.final_account_id || r.account_id), ...attempts.map((a) => a.account_id)],
      },
      { cache: this._cache },
    )
    return this._hydrateWithNames(rows, attempts, names)
  }

  /**
   * Totals for the current filters. SQL-only when muting is limited to the
   * SQL-expressible `auth` class; otherwise aggregates the newest
   * SUMMARY_SCAN_CAP rows after JS classification.
   */
  summary(filters = {}) {
    const { where, params, keep, sqlOnlySummary } = buildFilter(filters, this.mutedErrorClasses)
    const cond = whereSql(where)
    if (sqlOnlySummary) {
      const row = this.db
        .prepare(`
        SELECT COUNT(*) AS requests,
               COALESCE(SUM(CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END), 0) AS success,
               COALESCE(SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END), 0) AS errors,
               COALESCE(SUM(total_cost), 0) AS cost,
               COALESCE(SUM(actual_cost), 0) AS actual_cost,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
               COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
               COALESCE(SUM(cache_creation_5m_tokens), 0) AS cache_creation_5m_tokens,
               COALESCE(SUM(cache_creation_1h_tokens), 0) AS cache_creation_1h_tokens,
               COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
               AVG(duration_ms) AS avg_duration_ms,
               AVG(first_token_ms) AS avg_ttft_ms
        FROM usage_logs ${cond}
      `)
        .get(...params)
      return toSummary(row)
    }
    const rows = this.db
      .prepare(
        `SELECT *, (${PROMPT_TOKENS_SQL}) AS prompt_tokens FROM usage_logs ${cond} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, SUMMARY_SCAN_CAP)
      .map(enrichLogRow)
      .filter(keep)
    const acc = {
      requests: rows.length,
      success: 0,
      errors: 0,
      cost: 0,
      actual_cost: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      prompt_tokens: 0,
    }
    let durSum = 0
    let durN = 0
    let ttftSum = 0
    let ttftN = 0
    for (const r of rows) {
      if (r.error_class) acc.errors++
      else if (r.status != null && r.status < 400) acc.success++
      acc.cost += num(r.total_cost)
      acc.actual_cost += num(r.actual_cost)
      for (const k of [
        'input_tokens',
        'output_tokens',
        'cache_creation_tokens',
        'cache_read_tokens',
        'cache_creation_5m_tokens',
        'cache_creation_1h_tokens',
        'prompt_tokens',
      ])
        acc[k] += num(r[k])
      if (r.duration_ms != null) {
        durSum += num(r.duration_ms)
        durN++
      }
      if (r.first_token_ms != null) {
        ttftSum += num(r.first_token_ms)
        ttftN++
      }
    }
    return toSummary({
      ...acc,
      avg_duration_ms: durN ? durSum / durN : null,
      avg_ttft_ms: ttftN ? ttftSum / ttftN : null,
    })
  }

  /**
   * Export rows under the same filters as the list, in the snake_case
   * `/request-logs` shape. Muting beyond `auth` is decided per row: then at
   * most EXPORT_SCAN_CAP newest rows are read and `capped` says the scan ended
   * before the table did.
   */
  exportRows(filters = {}) {
    const limit = clampInt(filters.limit, 1, EXPORT_LIMIT_MAX, EXPORT_LIMIT_DEFAULT)
    const { where, params, keep, sqlOnlySummary } = buildFilter(filters, this.mutedErrorClasses)
    const cond = whereSql(where)
    const select = `SELECT * FROM usage_logs ${cond} ORDER BY created_at DESC, id DESC LIMIT ?`
    if (!keep || sqlOnlySummary) {
      const total = this.db.prepare(`SELECT COUNT(*) AS c FROM usage_logs ${cond}`).get(...params).c
      return {
        items: this.db
          .prepare(select)
          .all(...params, limit)
          .map(exportRow),
        total,
        capped: false,
      }
    }
    const scanned = this.db.prepare(select).all(...params, EXPORT_SCAN_CAP)
    const matched = scanned.map(exportRow).filter(keep)
    return {
      items: matched.slice(0, limit),
      total: matched.length,
      capped: scanned.length >= EXPORT_SCAN_CAP,
    }
  }

  /** Lazy dropdown values. Entity lists come from their tables; free-form columns from recent rows. */
  filterOptions({ owner_user_id = null, _rawRows = false } = {}) {
    const own = ownerPred(owner_user_id)
    const recentWhere = own.sql ? `WHERE ${own.sql}` : ''
    const recent = `(SELECT * FROM usage_logs ${recentWhere} ORDER BY created_at DESC LIMIT ${RECENT_SCAN}) _recent`
    const distinct = (col, { numeric = false } = {}) =>
      this.db
        .prepare(
          `SELECT ${col} AS v FROM ${recent} WHERE ${col} IS NOT NULL${numeric ? '' : ` AND ${col} != ''`} GROUP BY ${col} ORDER BY MAX(created_at) DESC LIMIT ${OPTION_LIMIT}`,
        )
        .all(...own.params)
        .map((r) => r.v)
    const named = (ids, map) => ids.map((id) => ({ id: String(id), name: map.get(id) ?? String(id) }))

    let users
    let keys
    let vmIds
    let accountIds
    if (owner_user_id) {
      users = this.db.prepare('SELECT id, username, email FROM users WHERE id = ?').all(String(owner_user_id))
      keys = this.db
        .prepare('SELECT id, name, user_id FROM api_keys WHERE user_id = ? AND deleted_at IS NULL ORDER BY name')
        .all(String(owner_user_id))
      // Pool slots that served this tenant appear in its rows even when not owned.
      vmIds = uniq([
        ...this.db
          .prepare('SELECT id FROM vms WHERE owner_user_id = ?')
          .all(String(owner_user_id))
          .map((r) => r.id),
        ...distinct('vm_id'),
      ])
      accountIds = uniq([...distinct('final_account_id'), ...distinct('account_id')])
    } else {
      users = this.db.prepare('SELECT id, username, email FROM users WHERE deleted_at IS NULL ORDER BY username').all()
      keys = this.db.prepare('SELECT id, name, user_id FROM api_keys WHERE deleted_at IS NULL ORDER BY name').all()
      vmIds = this.db
        .prepare('SELECT id FROM vms ORDER BY id')
        .all()
        .map((r) => r.id)
      accountIds = this.db
        .prepare('SELECT id FROM accounts WHERE deleted_at IS NULL ORDER BY id')
        .all()
        .map((r) => r.id)
    }
    const base = {
      users: users.map((u) => ({ id: String(u.id), name: u.username || u.email || String(u.id) })),
      keys: keys.map((k) => ({ id: String(k.id), name: k.name || String(k.id), userId: k.user_id ?? null })),
      models: uniq([...distinct('model'), ...distinct('requested_model')]).sort(),
      protocols: distinct('protocol').sort(),
      endpoints: distinct('path').sort(),
      statusCodes: distinct('status', { numeric: true })
        .map(Number)
        .sort((a, b) => a - b),
    }
    if (_rawRows === true) {
      return { _rawRows: true, ...base, vmIds, accountIds }
    }
    const names = lookupNames(this.db, { vmIds, accountIds }, { cache: this._cache })
    return {
      ...base,
      vms: named(vmIds, names.vms),
      accounts: named(accountIds, names.accounts),
    }
  }

  /**
   * Cached dropdown options (60s fresh / 180s hard SWR TTL, scoped by owner).
   * Eliminates 6×5000-row subqueries + 4 table scans on every page open.
   */
  async filterOptionsAsync(
    { owner_user_id = null, bypass = false } = {},
    { baseLoader = null, cache = this._cache } = {},
  ) {
    const ownerId = owner_user_id ? String(owner_user_id).trim() : null
    const useCache = !bypass && shouldUseSharedCache(this.db, cache)
    const dashboard = useCache ? resolveCacheRuntime(cache)?.dashboard : null

    const load = async () => {
      const opts = { owner_user_id: ownerId, _rawRows: true }
      const raw = typeof baseLoader === 'function' ? await baseLoader(opts) : this.filterOptions(opts)
      if (raw && raw._rawRows === true) {
        const names = await lookupNamesAsync(
          this.db,
          { vmIds: raw.vmIds || [], accountIds: raw.accountIds || [] },
          { cache },
        )
        const named = (ids, map) =>
          (ids || []).map((id) => ({ id: String(id), name: map.get(String(id)) ?? String(id) }))
        return {
          users: raw.users,
          keys: raw.keys,
          vms: named(raw.vmIds, names.vms),
          accounts: named(raw.accountIds, names.accounts),
          models: raw.models,
          protocols: raw.protocols,
          endpoints: raw.endpoints,
          statusCodes: raw.statusCodes,
        }
      }
      return raw
    }

    if (dashboard && typeof dashboard.getOrSetSWR === 'function') {
      return dashboard.getOrSetSWR('filter-options', { owner: ownerId || '__all__' }, load, {
        freshTtlMs: FILTER_OPTIONS_FRESH_TTL_MS,
        ttlMs: FILTER_OPTIONS_HARD_TTL_MS,
        bypass,
      })
    }
    return load()
  }

  /** Outbound session ids starting with `q`, most recently used first (index range scan). */
  sessionSuggestions({ q = '', limit = 20, owner_user_id = null } = {}) {
    const n = clampInt(limit, 1, 50, 20)
    const own = ownerPred(owner_user_id)
    const prefix = String(q || '').trim()
    if (prefix) {
      const where = ['outbound_session_id >= ?', 'outbound_session_id < ?']
      const params = [prefix, `${prefix}\uffff`]
      if (own.sql) {
        where.push(own.sql)
        params.push(...own.params)
      }
      return this.db
        .prepare(
          `SELECT outbound_session_id AS sid FROM usage_logs WHERE ${where.join(' AND ')} GROUP BY outbound_session_id ORDER BY MAX(created_at) DESC LIMIT ?`,
        )
        .all(...params, n)
        .map((r) => r.sid)
    }
    const where = ['outbound_session_id IS NOT NULL']
    if (own.sql) where.push(own.sql)
    return this.db
      .prepare(
        `SELECT sid FROM (SELECT outbound_session_id AS sid, created_at FROM usage_logs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${RECENT_SCAN}) _recent GROUP BY sid ORDER BY MAX(created_at) DESC LIMIT ?`,
      )
      .all(...own.params, n)
      .map((r) => r.sid)
  }

  /**
   * Conversations with a completed request in the last `minutes`, grouped by the
   * caller's session_id (falling back to the outbound id). Grouping by outbound id
   * splits one conversation into many: side requests (title / topic / suggestion
   * forks) mint their own session id while sharing the main prompt cache.
   */
  activeSessions({ minutes = 5, limit = 50, owner_user_id = null, now = Date.now(), _rawRows = false } = {}) {
    const mins = clampInt(minutes, 1, 1440, 5)
    const n = clampInt(limit, 1, 200, 50)
    const where = ['created_at >= ?', 'outbound_session_id IS NOT NULL']
    const params = [new Date(now - mins * 60_000).toISOString()]
    const own = ownerPred(owner_user_id)
    if (own.sql) {
      where.push(own.sql)
      params.push(...own.params)
    }
    const cond = `WHERE ${where.join(' AND ')}`
    // "One-off" = a conversation key seen once with no tools: side requests (title /
    // topic forks) that mint their own session id. Counted apart, never merged.
    const counts = this.db
      .prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN c.requests = 1 AND c.tools = 0 THEN 1 ELSE 0 END), 0) AS one_off
      FROM (
        SELECT COUNT(*) AS requests, SUM(IFNULL(has_tools, 0)) AS tools
        FROM usage_logs ${cond}
        GROUP BY ${CONVERSATION_KEY_SQL}
      ) c
    `)
      .get(...params)
    const total = counts.total
    // Aggregate first, then pull the newest row per session by id; SQLite's
    // bare-column-with-MAX shortcut is undefined once MIN() is also present.
    const rows = this.db
      .prepare(`
      WITH s AS (
        SELECT ${CONVERSATION_KEY_SQL} AS sid,
               MAX(created_at) AS last_at,
               MIN(created_at) AS first_at,
               COUNT(*) AS requests,
               SUM(IFNULL(input_tokens, 0) + IFNULL(output_tokens, 0) + IFNULL(cache_read_tokens, 0) + IFNULL(cache_creation_tokens, 0)) AS tokens,
               COALESCE(SUM(total_cost), 0) AS cost,
               CASE WHEN COUNT(*) = 1 AND SUM(IFNULL(has_tools, 0)) = 0 THEN 1 ELSE 0 END AS one_off
        FROM usage_logs ${cond}
        GROUP BY ${CONVERSATION_KEY_SQL}
        ORDER BY one_off ASC, last_at DESC
        LIMIT ?
      )
      SELECT s.*, l.session_id AS client_session_id, l.user_id, l.api_key_id, l.vm_id, l.model, l.status, l.duration_ms,
             COALESCE(l.final_account_id, l.account_id) AS account
      FROM s
      JOIN usage_logs l ON l.id = (
        SELECT id FROM usage_logs
        WHERE ${CONVERSATION_KEY_SQL} = s.sid AND created_at = s.last_at${own.sql ? ` AND ${own.sql}` : ''}
        ORDER BY id DESC LIMIT 1
      )
      ORDER BY s.one_off ASC, s.last_at DESC
    `)
      .all(...params, n, ...own.params)
    if (_rawRows === true) {
      return {
        _rawRows: true,
        minutes: mins,
        total: num(total),
        oneOffTotal: num(counts.one_off),
        rows,
      }
    }
    const names = lookupNames(
      this.db,
      {
        userIds: rows.map((r) => r.user_id),
        keyIds: rows.map((r) => r.api_key_id),
        vmIds: rows.map((r) => r.vm_id),
        accountIds: rows.map((r) => r.account),
      },
      { cache: this._cache },
    )
    return {
      minutes: mins,
      total: num(total),
      oneOffTotal: num(counts.one_off),
      sessions: rows.map((r) => mapRawActiveSessionRow(r, names)),
    }
  }

  /**
   * Active sessions backed by DashboardCache SWR (5s fresh / 15s hard TTL) +
   * real-time `LiveLogCache` overlay (`in_progress`, `inflight_count`, and live-only
   * sessions not yet persisted to PG). Strictly enforces tenant isolation.
   */
  async activeSessionsAsync(
    { minutes = 5, limit = 50, owner_user_id = null, now = Date.now(), bypass = false } = {},
    { baseLoader = null, cache = this._cache } = {},
  ) {
    const mins = clampInt(minutes, 1, 1440, 5)
    const n = clampInt(limit, 1, 200, 50)
    const ownerId = owner_user_id ? String(owner_user_id).trim() : null
    const runtime = resolveCacheRuntime(cache)
    const useCache = !bypass && shouldUseSharedCache(this.db, cache)
    const dashboard = useCache ? runtime?.dashboard : null
    const liveLogs = runtime?.liveLogs

    const loadBase = async () => {
      const opts = { minutes: mins, limit: n, owner_user_id: ownerId, now, _rawRows: true }
      const raw = typeof baseLoader === 'function' ? await baseLoader(opts) : this.activeSessions(opts)
      if (raw && raw._rawRows === true) {
        const rows = Array.isArray(raw.rows) ? raw.rows : []
        const names = await lookupNamesAsync(
          this.db,
          {
            userIds: rows.map((r) => r.user_id),
            keyIds: rows.map((r) => r.api_key_id),
            vmIds: rows.map((r) => r.vm_id),
            accountIds: rows.map((r) => r.account),
          },
          { cache },
        )
        return {
          minutes: raw.minutes ?? mins,
          total: num(raw.total),
          oneOffTotal: num(raw.oneOffTotal),
          sessions: rows.map((r) => mapRawActiveSessionRow(r, names)),
        }
      }
      return raw || { minutes: mins, total: 0, oneOffTotal: 0, sessions: [] }
    }

    const base =
      dashboard && typeof dashboard.getOrSetSWR === 'function'
        ? await dashboard.getOrSetSWR(
            'active-sessions',
            { minutes: mins, limit: n, owner: ownerId || '__all__' },
            loadBase,
            { freshTtlMs: ACTIVE_SESSIONS_FRESH_TTL_MS, ttlMs: ACTIVE_SESSIONS_HARD_TTL_MS, bypass },
          )
        : await loadBase()

    const baseSessions = Array.isArray(base?.sessions) ? base.sessions : []
    const sessionKeys = uniq(baseSessions.flatMap((s) => [s.sessionId, s.clientSessionId]))

    let concMap = new Map()
    let rawLiveInflight = []
    if (liveLogs) {
      const [countsRes, liveRes] = await Promise.all([
        !ownerId && sessionKeys.length && typeof liveLogs.getActiveSessionCounts === 'function'
          ? liveLogs.getActiveSessionCounts(sessionKeys).catch(() => new Map())
          : Promise.resolve(new Map()),
        typeof liveLogs.listLiveAndRecent === 'function'
          ? liveLogs
              .listLiveAndRecent({
                limit: Math.min(500, Math.max(n * 4, 200)),
                ownerUserId: null,
                includeRecent: false,
                now,
              })
              .catch(() => [])
          : Promise.resolve([]),
      ])
      if (countsRes instanceof Map) concMap = countsRes
      if (Array.isArray(liveRes)) rawLiveInflight = liveRes
    }

    let ownerKeyIdsLoaded = false
    let ownerKeyIds = null
    const getOwnerKeyIds = () => {
      if (!ownerKeyIdsLoaded) {
        ownerKeyIdsLoaded = true
        ownerKeyIds = loadOwnerKeyIds(this.db, ownerId)
      }
      return ownerKeyIds
    }

    const liveBySession = new Map()
    const windowCutoff = now - mins * 60_000
    for (const entry of rawLiveInflight) {
      if (entry?.in_flight !== true) continue
      if (!entryBelongsToOwner(entry, ownerId, getOwnerKeyIds)) continue
      const sid = conversationKeyOf(entry)
      if (!sid) continue
      const startedMs = Number(entry._live?.started_at ?? entry.started_at) || Date.parse(entry.created_at || '') || now
      if (startedMs < windowCutoff) continue
      const list = liveBySession.get(sid) || []
      list.push(entry)
      liveBySession.set(sid, list)
    }

    const existingIds = new Set()
    const overlaid = baseSessions.map((s) => {
      existingIds.add(s.sessionId)
      if (s.clientSessionId) existingIds.add(s.clientSessionId)
      const liveGroup =
        liveBySession.get(s.sessionId) || (s.clientSessionId ? liveBySession.get(s.clientSessionId) : null) || []
      const liveCount = ownerId
        ? liveGroup.length
        : Math.max(
            concMap.get(s.sessionId) || 0,
            s.clientSessionId ? concMap.get(s.clientSessionId) || 0 : 0,
            liveGroup.length,
          )
      let lastAt = s.lastAt
      if (liveGroup.length) {
        for (const e of liveGroup) {
          const ms = Number(e._live?.started_at ?? e.started_at) || Date.parse(e.created_at || '') || 0
          const iso = ms > 0 ? new Date(ms).toISOString() : null
          if (iso && (!lastAt || iso > lastAt)) lastAt = iso
        }
      }
      const inProgress = liveCount > 0
      return {
        ...s,
        lastAt,
        in_progress: inProgress,
        inProgress,
        inflight_count: liveCount,
        inflightCount: liveCount,
      }
    })

    // Synthesize live-only active sessions that have no completed PG row yet.
    const liveOnlyGroups = []
    for (const [sid, group] of liveBySession) {
      if (existingIds.has(sid)) continue
      liveOnlyGroups.push([sid, group])
    }

    let addedCount = 0
    if (liveOnlyGroups.length) {
      const flat = liveOnlyGroups.flatMap(([, g]) => g)
      const liveNames = await lookupNamesAsync(
        this.db,
        {
          userIds: flat.map((e) => e.user_id),
          keyIds: flat.map((e) => e.api_key_id),
          vmIds: flat.map((e) => e._live?.vm_id ?? e.vm_id),
          accountIds: flat.map((e) => e._live?.account_id ?? e.final_account_id ?? e.account_id),
        },
        { cache },
      )
      for (const [sid, group] of liveOnlyGroups) {
        let earliestMs = Infinity
        let latestMs = 0
        let newest = group[0]
        for (const e of group) {
          const ms = Number(e._live?.started_at ?? e.started_at) || Date.parse(e.created_at || '') || now
          if (ms < earliestMs) earliestMs = ms
          if (ms >= latestMs) {
            latestMs = ms
            newest = e
          }
        }
        const vmId = newest._live?.vm_id ?? newest.vm_id ?? null
        const accountId = newest._live?.account_id ?? newest.final_account_id ?? newest.account_id ?? null
        const count = group.length
        overlaid.push({
          sessionId: sid,
          oneOff: false,
          clientSessionId: newest.session_id ?? null,
          userName: newest.user_id ? (liveNames.users.get(String(newest.user_id)) ?? null) : null,
          keyName: newest.api_key_id ? (liveNames.keys.get(String(newest.api_key_id)) ?? null) : null,
          providerName: accountId ? (liveNames.accounts.get(String(accountId)) ?? String(accountId)) : null,
          vmId,
          vmName: vmId ? (liveNames.vms.get(String(vmId)) ?? String(vmId)) : null,
          model: newest.model ?? newest.requested_model ?? null,
          firstAt: new Date(Number.isFinite(earliestMs) ? earliestMs : now).toISOString(),
          lastAt: new Date(latestMs > 0 ? latestMs : now).toISOString(),
          requests: count,
          lastStatus: null,
          lastDurationMs: Math.max(0, now - (latestMs > 0 ? latestMs : now)),
          totalTokens: 0,
          totalCost: 0,
          in_progress: true,
          inProgress: true,
          inflight_count: count,
          inflightCount: count,
        })
        addedCount += 1
      }
    }

    overlaid.sort((a, b) => {
      const oa = a.oneOff ? 1 : 0
      const ob = b.oneOff ? 1 : 0
      if (oa !== ob) return oa - ob
      const pa = a.in_progress ? 1 : 0
      const pb = b.in_progress ? 1 : 0
      if (pb !== pa) return pb - pa
      return String(b.lastAt || '').localeCompare(String(a.lastAt || ''))
    })

    return {
      minutes: base?.minutes ?? mins,
      total: num(base?.total) + addedCount,
      oneOffTotal: num(base?.oneOffTotal),
      sessions: overlaid.slice(0, n),
    }
  }

  /**
   * Header cards. "Today" = local midnight in `tz` → now; "yesterday" = the
   * same elapsed span starting at yesterday's local midnight.
   */
  overview({ tz = 'UTC', owner_user_id = null, now = Date.now() } = {}) {
    const zone = reportTimezone(tz)
    const own = ownerPred(owner_user_id)
    const todayStart = zonedDayStartMs(now, zone)
    const yesterdayStart = zonedDayStartMs(now, zone, -1)
    const yesterdayEnd = Math.min(todayStart, yesterdayStart + (now - todayStart))
    const agg = (sinceMs, untilMs) => {
      const where = ['created_at >= ?', 'created_at < ?']
      const params = [new Date(sinceMs).toISOString(), new Date(untilMs).toISOString()]
      if (own.sql) {
        where.push(own.sql)
        params.push(...own.params)
      }
      return this.db
        .prepare(`
        SELECT COUNT(*) AS requests,
               COALESCE(SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END), 0) AS errors,
               COALESCE(SUM(total_cost), 0) AS cost,
               COALESCE(SUM(actual_cost), 0) AS actual_cost,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
               COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
               COALESCE(SUM(cache_creation_5m_tokens), 0) AS cache_creation_5m_tokens,
               COALESCE(SUM(cache_creation_1h_tokens), 0) AS cache_creation_1h_tokens,
               COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
               AVG(duration_ms) AS avg_duration_ms,
               AVG(first_token_ms) AS avg_ttft_ms,
               COUNT(DISTINCT CASE WHEN outbound_session_id IS NOT NULL THEN ${CONVERSATION_KEY_SQL} END) AS sessions
        FROM usage_logs WHERE ${where.join(' AND ')}
      `)
        .get(...params)
    }
    // +1ms so a row stamped exactly `now` still counts.
    const today = agg(todayStart, now + 1)
    const yesterday = agg(yesterdayStart, yesterdayEnd)
    const active = agg(now - 5 * 60_000, now + 1)
    const lastMinute = agg(now - 60_000, now + 1)
    const avg = (v) => (v == null ? null : Math.round(Number(v)))
    const input = num(today.input_tokens)
    const output = num(today.output_tokens)
    const cacheRead = num(today.cache_read_tokens)
    const cacheCreation = num(today.cache_creation_tokens)
    const prompt = num(today.prompt_tokens)
    return {
      activeSessions: num(active.sessions),
      rpm: num(lastMinute.requests),
      todayRequests: num(today.requests),
      todayCost: num(today.cost),
      todayActualCost: num(today.actual_cost),
      todayErrors: num(today.errors),
      todayTokens: input + output + cacheRead + cacheCreation,
      todayInputTokens: input,
      todayOutputTokens: output,
      todayCacheReadTokens: cacheRead,
      todayCacheCreationTokens: cacheCreation,
      todayCacheCreation5mTokens: num(today.cache_creation_5m_tokens),
      todayCacheCreation1hTokens: num(today.cache_creation_1h_tokens),
      todayCacheHitRate: prompt > 0 ? Math.min(1, cacheRead / prompt) : 0,
      todayAvgDurationMs: avg(today.avg_duration_ms),
      todayAvgTtftMs: avg(today.avg_ttft_ms),
      yesterdayRequests: num(yesterday.requests),
      yesterdayCost: num(yesterday.cost),
      yesterdayAvgDurationMs: avg(yesterday.avg_duration_ms),
    }
  }

  /**
   * Overview cards backed by DashboardCache SWR (5s fresh / 15s hard TTL, scoped by
   * tz + owner) with real-time `LiveLogCache` in-flight count overlaid on every read.
   */
  async overviewAsync(
    { tz = 'UTC', owner_user_id = null, now = Date.now(), bypass = false } = {},
    { baseLoader = null, cache = this._cache } = {},
  ) {
    const zone = reportTimezone(tz)
    const ownerId = owner_user_id ? String(owner_user_id).trim() : null
    const runtime = resolveCacheRuntime(cache)
    const useCache = !bypass && shouldUseSharedCache(this.db, cache)
    const dashboard = useCache ? runtime?.dashboard : null
    const liveLogs = runtime?.liveLogs

    const loadBase = async () => {
      const opts = { tz: zone, owner_user_id: ownerId, now }
      if (typeof baseLoader === 'function') return baseLoader(opts)
      return this.overview(opts)
    }

    const loadInflight = async () => {
      if (!liveLogs) return 0
      try {
        if (!ownerId && typeof liveLogs.getInflightCount === 'function') {
          return Math.max(0, Number(await liveLogs.getInflightCount({ now })) || 0)
        }
        if (typeof liveLogs.listLiveAndRecent === 'function') {
          const entries = await liveLogs.listLiveAndRecent({
            limit: 500,
            ownerUserId: null,
            includeRecent: false,
            now,
          })
          let ownerKeyIdsLoaded = false
          let ownerKeyIds = null
          const getOwnerKeyIds = () => {
            if (!ownerKeyIdsLoaded) {
              ownerKeyIdsLoaded = true
              ownerKeyIds = loadOwnerKeyIds(this.db, ownerId)
            }
            return ownerKeyIds
          }
          let count = 0
          for (const e of entries || []) {
            if (e?.in_flight === true && entryBelongsToOwner(e, ownerId, getOwnerKeyIds)) count += 1
          }
          return count
        }
      } catch {
        return 0
      }
      return 0
    }

    const [base, inflightCount] = await Promise.all([
      dashboard && typeof dashboard.getOrSetSWR === 'function'
        ? dashboard.getOrSetSWR('overview', { tz: zone, owner: ownerId || '__all__' }, loadBase, {
            freshTtlMs: OVERVIEW_FRESH_TTL_MS,
            ttlMs: OVERVIEW_HARD_TTL_MS,
            bypass,
          })
        : loadBase(),
      loadInflight(),
    ])

    return {
      ...base,
      inflightCount,
      inflight_count: inflightCount,
    }
  }
}

function toSummary(row) {
  const input = num(row.input_tokens)
  const output = num(row.output_tokens)
  const cacheCreation = num(row.cache_creation_tokens)
  const cacheRead = num(row.cache_read_tokens)
  const prompt = num(row.prompt_tokens)
  return {
    totalRequests: num(row.requests),
    successRequests: num(row.success),
    errorRequests: num(row.errors),
    totalCost: num(row.cost),
    totalActualCost: num(row.actual_cost),
    totalTokens: rowTotalTokens(row),
    totalInputTokens: input,
    totalOutputTokens: output,
    totalCacheCreationTokens: cacheCreation,
    totalCacheReadTokens: cacheRead,
    totalCacheCreation5mTokens: num(row.cache_creation_5m_tokens),
    totalCacheCreation1hTokens: num(row.cache_creation_1h_tokens),
    cacheHitRate: prompt > 0 ? Math.min(1, cacheRead / prompt) : 0,
    avgDurationMs: row.avg_duration_ms == null ? null : Math.round(Number(row.avg_duration_ms)),
    avgTtftMs: row.avg_ttft_ms == null ? null : Math.round(Number(row.avg_ttft_ms)),
  }
}
