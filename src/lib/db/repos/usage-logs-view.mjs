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

import { getDb } from '../database.mjs'
import { DEFAULT_MUTED_ERROR_CLASSES, enrichLogRow, excludeErrorClassSql } from '../../admin/error-class.mjs'
import { reportTimezone, zonedDayStartMs } from '../../core/timezone.mjs'
import { ERROR_PRED, SUCCESS_PRED, ownerPred } from './usage-log-preds.mjs'

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
const OPTION_LIMIT = 200
const DEFAULT_VIA = 'go-worker-pool'

const BLOCKED_STATES = { distill_blocked: 'distill', refusal_guard: 'refusal_guard' }

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

/**
 * Batched display names for one page / one aggregate. One IN query per entity
 * kind so a page of 100 rows costs at most four lookups.
 */
export function lookupNames(db, { userIds = [], keyIds = [], vmIds = [], accountIds = [] } = {}) {
  const pick = (sql, ids, nameOf) => {
    const list = uniq(ids)
    const map = new Map()
    if (!list.length) return map
    for (const r of db.prepare(sql.replace('$IN', placeholders(list))).all(...list)) map.set(r.id, nameOf(r))
    return map
  }
  return {
    users: pick(
      'SELECT id, username, email FROM users WHERE id IN ($IN)',
      userIds,
      (r) => r.username || r.email || r.id,
    ),
    keys: pick('SELECT id, name FROM api_keys WHERE id IN ($IN)', keyIds, (r) => r.name || r.id),
    vms: pick('SELECT id, name FROM vms WHERE id IN ($IN)', vmIds, (r) => r.name || r.id),
    accounts: pick(
      'SELECT id, email, name FROM accounts WHERE id IN ($IN)',
      accountIds,
      (r) => r.email || r.name || r.id,
    ),
  }
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

/** Switches that changed how this request was served. Fixed order; the UI does not sort. */
function specialSettings(row) {
  const out = []
  if (row.stream) out.push({ key: 'stream', label: '流式' })
  if (row.has_tools) out.push({ key: 'tools', label: '工具调用' })
  if (row.log_mode === 'debug') out.push({ key: 'debug', label: '调试采样' })
  if (row.model_mismatch === 1)
    out.push({ key: 'mismatch', label: '模型重定向', value: `${row.requested_model} → ${row.upstream_model}` })
  if (row.speed === 'fast') out.push({ key: 'fast', label: 'Fast 模式', value: row.speed })
  if (row.service_tier === 'priority') out.push({ key: 'priority', label: 'Priority', value: row.service_tier })
  if (row.long_context === 1) out.push({ key: 'context1m', label: '1M 上下文' })
  if (row.via && row.via !== DEFAULT_VIA) out.push({ key: 'via', label: '路由', value: row.via })
  return out
}

function blockedBy(row) {
  if (BLOCKED_STATES[row.final_state]) return BLOCKED_STATES[row.final_state]
  if (row.error_class === 'distill') return 'distill'
  return null
}

/** Raw `usage_logs` row (already `enrichLogRow`-ed) + batched names → `UsageLogRow`. */
export function toUsageLogRow(row, names, chain = []) {
  const accountId = row.final_account_id || row.account_id || null
  const inputTokens = num(row.input_tokens)
  const outputTokens = num(row.output_tokens)
  const cacheCreation = num(row.cache_creation_tokens)
  const cacheRead = num(row.cache_read_tokens)
  const blocked = blockedBy(row)
  return {
    id: row.id,
    requestId: row.request_id ?? null,
    createdAt: row.created_at,
    userId: row.user_id ?? null,
    userName: row.user_id ? (names.users.get(row.user_id) ?? null) : null,
    keyId: row.api_key_id ?? null,
    keyName: row.api_key_id ? (names.keys.get(row.api_key_id) ?? null) : null,
    sessionId: row.session_id ?? null,
    providerName: accountId ? (names.accounts.get(accountId) ?? accountId) : null,
    accountId,
    vmId: row.vm_id ?? null,
    vmName: row.vm_id ? (names.vms.get(row.vm_id) ?? row.vm_id) : null,
    model: row.model ?? null,
    originalModel: row.requested_model ?? null,
    actualResponseModel: row.upstream_model ?? null,
    modelMismatch: row.model_mismatch == null ? null : Number(row.model_mismatch),
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
    totalTokens: inputTokens + outputTokens + cacheCreation + cacheRead,
    costUsd: nullableNum(row.total_cost),
    actualCostUsd: nullableNum(row.actual_cost),
    groupCostMultiplier: nullableNum(row.rate_multiplier),
    costBreakdown: costBreakdown(row),
    durationMs: nullableNum(row.duration_ms),
    ttftMs: nullableNum(row.first_token_ms),
    stopReason: row.stop_reason ?? null,
    attemptCount: nullableNum(row.attempt_count),
    finalState: row.final_state ?? null,
    via: row.via ?? null,
    stream: row.stream == null ? null : !!row.stream,
    hasTools: row.has_tools == null ? null : !!row.has_tools,
    serviceTier: row.service_tier ?? null,
    speed: row.speed ?? null,
    context1mApplied: row.long_context == null ? null : row.long_context === 1,
    reasoningEffort: row.reasoning_effort ?? null,
    errorClass: row.error_class ?? null,
    errorLabel: row.error_label ?? null,
    errorOwner: row.error_owner ?? null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
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
    terminalState: r.terminal_state ?? null,
    action: r.action ?? null,
    downstreamCommitted: !!r.downstream_committed,
    waitMs: nullableNum(r.wait_ms),
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
  eq('session_id', filters.session_id)
  eq('path', filters.endpoint)
  eq('protocol', filters.protocol)
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
    where.push('(path LIKE ? OR error_code LIKE ? OR error_message LIKE ? OR request_id LIKE ?)')
    const like = `%${String(filters.q).slice(0, 100)}%`
    params.push(like, like, like, like)
  }
  const errorClass = filters.error_class ? String(filters.error_class) : null
  if (errorClass) where.push(ERROR_PRED)
  const muted = mutedClasses(filters, defaultMuted)
  // SQL can only pre-drop ingress auth; every other class is decided per row.
  const excludeSql = excludeErrorClassSql(muted)
  if (excludeSql) where.push(excludeSql)
  const blocked = new Set(muted)
  let keep = null
  if (errorClass) keep = (row) => row.error_class === errorClass
  else if (blocked.size) keep = (row) => !row.error_class || !blocked.has(row.error_class)
  return { where, params, keep, sqlOnlySummary: !errorClass && muted.every((c) => c === 'auth') }
}

function whereSql(where) {
  return where.length ? `WHERE ${where.join(' AND ')}` : ''
}

export class UsageLogsView {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{ mutedErrorClasses?: string[] }} [opts] settings default mute list
   */
  constructor(db = getDb(), { mutedErrorClasses = DEFAULT_MUTED_ERROR_CLASSES } = {}) {
    this.db = db
    this.mutedErrorClasses = Array.isArray(mutedErrorClasses) ? mutedErrorClasses.slice() : []
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
    return {
      logs: this._hydrate(page),
      nextCursor: next ? { createdAt: next.created_at, id: next.id } : null,
      hasMore,
    }
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
    const names = lookupNames(this.db, {
      userIds: rows.map((r) => r.user_id),
      keyIds: rows.map((r) => r.api_key_id),
      vmIds: [...rows.map((r) => r.vm_id), ...attempts.map((a) => a.vm_id)],
      accountIds: [...rows.map((r) => r.final_account_id || r.account_id), ...attempts.map((a) => a.account_id)],
    })
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
               AVG(duration_ms) AS avg_duration_ms,
               AVG(first_token_ms) AS avg_ttft_ms
        FROM usage_logs ${cond}
      `)
        .get(...params)
      return toSummary(row)
    }
    const rows = this.db
      .prepare(`SELECT * FROM usage_logs ${cond} ORDER BY created_at DESC, id DESC LIMIT ?`)
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

  /** Lazy dropdown values. Entity lists come from their tables; free-form columns from recent rows. */
  filterOptions({ owner_user_id = null } = {}) {
    const own = ownerPred(owner_user_id)
    const recentWhere = own.sql ? `WHERE ${own.sql}` : ''
    const recent = `(SELECT * FROM usage_logs ${recentWhere} ORDER BY created_at DESC LIMIT ${RECENT_SCAN})`
    const distinct = (col) =>
      this.db
        .prepare(
          `SELECT ${col} AS v FROM ${recent} WHERE ${col} IS NOT NULL AND ${col} != '' GROUP BY ${col} ORDER BY MAX(created_at) DESC LIMIT ${OPTION_LIMIT}`,
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
    const names = lookupNames(this.db, { vmIds, accountIds })
    return {
      users: users.map((u) => ({ id: String(u.id), name: u.username || u.email || String(u.id) })),
      keys: keys.map((k) => ({ id: String(k.id), name: k.name || String(k.id), userId: k.user_id ?? null })),
      vms: named(vmIds, names.vms),
      accounts: named(accountIds, names.accounts),
      models: uniq([...distinct('model'), ...distinct('requested_model')]).sort(),
      protocols: distinct('protocol').sort(),
      endpoints: distinct('path').sort(),
      statusCodes: distinct('status')
        .map(Number)
        .sort((a, b) => a - b),
    }
  }

  /** Session ids starting with `q`, most recently used first (index range scan on session_id). */
  sessionSuggestions({ q = '', limit = 20, owner_user_id = null } = {}) {
    const n = clampInt(limit, 1, 50, 20)
    const own = ownerPred(owner_user_id)
    const prefix = String(q || '').trim()
    if (prefix) {
      const where = ['session_id >= ?', 'session_id < ?']
      const params = [prefix, `${prefix}\uffff`]
      if (own.sql) {
        where.push(own.sql)
        params.push(...own.params)
      }
      return this.db
        .prepare(
          `SELECT session_id FROM usage_logs WHERE ${where.join(' AND ')} GROUP BY session_id ORDER BY MAX(created_at) DESC LIMIT ?`,
        )
        .all(...params, n)
        .map((r) => r.session_id)
    }
    const where = ['session_id IS NOT NULL']
    if (own.sql) where.push(own.sql)
    return this.db
      .prepare(
        `SELECT session_id FROM (SELECT session_id, created_at FROM usage_logs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${RECENT_SCAN}) GROUP BY session_id ORDER BY MAX(created_at) DESC LIMIT ?`,
      )
      .all(...own.params, n)
      .map((r) => r.session_id)
  }

  /** Sessions with a completed request in the last `minutes`; last-row fields via SQLite's bare-column MAX(). */
  activeSessions({ minutes = 5, limit = 50, owner_user_id = null, now = Date.now() } = {}) {
    const mins = clampInt(minutes, 1, 1440, 5)
    const n = clampInt(limit, 1, 200, 50)
    const where = ['created_at >= ?', 'session_id IS NOT NULL']
    const params = [new Date(now - mins * 60_000).toISOString()]
    const own = ownerPred(owner_user_id)
    if (own.sql) {
      where.push(own.sql)
      params.push(...own.params)
    }
    const cond = `WHERE ${where.join(' AND ')}`
    const total = this.db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM usage_logs ${cond}`).get(...params).n
    // Aggregate first, then pull the newest row per session by id; SQLite's
    // bare-column-with-MAX shortcut is undefined once MIN() is also present.
    const rows = this.db
      .prepare(`
      WITH s AS (
        SELECT session_id,
               MAX(created_at) AS last_at,
               MIN(created_at) AS first_at,
               COUNT(*) AS requests,
               SUM(IFNULL(input_tokens, 0) + IFNULL(output_tokens, 0) + IFNULL(cache_read_tokens, 0) + IFNULL(cache_creation_tokens, 0)) AS tokens,
               COALESCE(SUM(total_cost), 0) AS cost
        FROM usage_logs ${cond}
        GROUP BY session_id
        ORDER BY last_at DESC
        LIMIT ?
      )
      SELECT s.*, l.user_id, l.api_key_id, l.vm_id, l.model, l.status, l.duration_ms,
             COALESCE(l.final_account_id, l.account_id) AS account
      FROM s
      JOIN usage_logs l ON l.id = (
        SELECT id FROM usage_logs
        WHERE session_id = s.session_id AND created_at = s.last_at${own.sql ? ` AND ${own.sql}` : ''}
        ORDER BY id DESC LIMIT 1
      )
      ORDER BY s.last_at DESC
    `)
      .all(...params, n, ...own.params)
    const names = lookupNames(this.db, {
      userIds: rows.map((r) => r.user_id),
      keyIds: rows.map((r) => r.api_key_id),
      vmIds: rows.map((r) => r.vm_id),
      accountIds: rows.map((r) => r.account),
    })
    return {
      minutes: mins,
      total: num(total),
      sessions: rows.map((r) => ({
        sessionId: r.session_id,
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
      })),
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
               AVG(duration_ms) AS avg_duration_ms,
               COUNT(DISTINCT session_id) AS sessions
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
    return {
      activeSessions: num(active.sessions),
      rpm: num(lastMinute.requests),
      todayRequests: num(today.requests),
      todayCost: num(today.cost),
      todayActualCost: num(today.actual_cost),
      todayErrors: num(today.errors),
      todayAvgDurationMs: avg(today.avg_duration_ms),
      yesterdayRequests: num(yesterday.requests),
      yesterdayCost: num(yesterday.cost),
      yesterdayAvgDurationMs: avg(yesterday.avg_duration_ms),
    }
  }
}

function toSummary(row) {
  const input = num(row.input_tokens)
  const output = num(row.output_tokens)
  const cacheCreation = num(row.cache_creation_tokens)
  const cacheRead = num(row.cache_read_tokens)
  const lookups = input + cacheRead
  return {
    totalRequests: num(row.requests),
    successRequests: num(row.success),
    errorRequests: num(row.errors),
    totalCost: num(row.cost),
    totalActualCost: num(row.actual_cost),
    totalTokens: input + output + cacheCreation + cacheRead,
    totalInputTokens: input,
    totalOutputTokens: output,
    totalCacheCreationTokens: cacheCreation,
    totalCacheReadTokens: cacheRead,
    totalCacheCreation5mTokens: num(row.cache_creation_5m_tokens),
    totalCacheCreation1hTokens: num(row.cache_creation_1h_tokens),
    cacheHitRate: lookups > 0 ? cacheRead / lookups : 0,
    avgDurationMs: row.avg_duration_ms == null ? null : Math.round(Number(row.avg_duration_ms)),
    avgTtftMs: row.avg_ttft_ms == null ? null : Math.round(Number(row.avg_ttft_ms)),
  }
}
