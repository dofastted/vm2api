/**
 * usage_logs + request_log_debug repository — sub2api UsageLog shape.
 * Normal summaries (always, unless mode=off) and full redacted debug records.
 *
 * DB columns follow sub2api naming (created_at, ip_address, user_id/group_id,
 * actual_cost, rate_multiplier). Records returned to callers keep the
 * historical `ts` / `ip` aliases so the panel API shape is unchanged; writers
 * may pass either name.
 */

import { getDb, withTransaction } from '../database.mjs'
import { collectErrors, enrichLogRow, excludeErrorClassSql, ingressAuthSql } from '../../admin/error-class.mjs'
import {
  costColumnsFromUsage,
  emptyCostBucket,
  shanghaiDayStartIso,
  sumCostBuckets as sumCostColumns,
  UNPRICED_MODEL,
} from '../../admin/pricing.mjs'
import { cacheHitStats } from '../../admin/cache-metrics.mjs'
import { extraWindowSince, WINDOW_5H_MS, WINDOW_7D_MS } from '../../pool/quota-window.mjs'
import {
  ERROR_PRED,
  SUCCESS_PRED,
  SLA_ERROR_PRED,
  SLA_SUCCESS_PRED,
  ownerPred,
  PROMPT_TOKENS_SQL,
  TOTAL_TOKENS_SQL,
  totalTokens,
} from './usage-log-preds.mjs'
import { collapseBlockKeywords, foldInterceptRows } from '../../protocol/intercept-stats.mjs'

/** settings key: ISO instant before which usage_logs rows may have been pruned. Monotonic. */
const PRUNED_THROUGH_KEY = 'usage_logs_pruned_through'
const BILLING_STATS_CACHE_TTL_MS = 10_000
const BILLING_BACKFILL_INTERVAL_MS = 60_000

function billingStatsCacheKey(accountWindows) {
  if (!Array.isArray(accountWindows) || accountWindows.length === 0) return 'rolling'
  const normalized = accountWindows
    .map((win) => ({
      account_id: win?.account_id || '',
      vm_id: win?.vm_id || '',
      reset_5h: win?.reset_5h || null,
      reset_7d: win?.reset_7d || null,
      reset_7d_oi: win?.reset_7d_oi || null,
    }))
    .sort((a, b) =>
      `${a.account_id}\0${a.vm_id}`.localeCompare(`${b.account_id}\0${b.vm_id}`, 'en', { sensitivity: 'case' }),
    )
  return JSON.stringify(normalized)
}

// Preserve per-row prompt denominators when aligning account quota windows.
// Do not re-apply a single Anthropic formula on the mixed SUM (homepage/usage
// billing). Database-page PromptCacheMetricsPanel still uses input+read+write.
function sumCostBuckets(rows) {
  return {
    ...sumCostColumns(rows),
    prompt_tokens: rows.reduce((sum, row) => sum + (Number(row.prompt_tokens) || 0), 0),
  }
}

const SUMMARY_COLUMNS = [
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
  'stop_reason',
  'attempt_count',
  'final_state',
  'final_account_id',
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
  'speed',
  'long_context',
  'session_id',
  'outbound_session_id',
  'reasoning_effort',
  'inbound_device_id',
  'intercept',
  'vm_owner_user_id',
]

function toRow(rec) {
  return SUMMARY_COLUMNS.map((c) => {
    if (c === 'created_at') return rec.created_at ?? rec.ts ?? null
    if (c === 'ip_address') return rec.ip_address ?? rec.ip ?? null
    if (c === 'stream') return rec.stream ? 1 : 0
    if (c === 'has_tools') return rec.has_tools == null ? null : rec.has_tools ? 1 : 0
    if (
      c === 'input_tokens' ||
      c === 'output_tokens' ||
      c === 'cache_read_tokens' ||
      c === 'cache_creation_tokens' ||
      c === 'cache_creation_5m_tokens' ||
      c === 'cache_creation_1h_tokens' ||
      c === 'web_search_requests'
    )
      return Number(rec[c]) || 0
    return rec[c] ?? null
  })
}

function fromRow(row) {
  if (!row) return null
  return {
    ...row,
    ts: row.created_at,
    ip: row.ip_address,
    stream: !!row.stream,
    has_tools: row.has_tools == null ? null : !!row.has_tools,
  }
}

function timeCond(since, until) {
  const where = []
  const params = []
  if (since) {
    where.push(`created_at >= $${params.length + 1}`)
    params.push(new Date(since).toISOString())
  }
  if (until) {
    where.push(`created_at <= $${params.length + 1}`)
    params.push(new Date(until).toISOString())
  }
  return { cond: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

function accountEventKey(row) {
  return `${row?.account_id || ''}\0${row?.vm_id || ''}`
}

function resolveAccountWindow(windows, row) {
  const list = Array.isArray(windows) ? windows : []
  return (
    list.find((w) => w.account_id === row.account_id && (w.vm_id || null) === (row.vm_id || null)) ||
    list.find((w) => w.account_id && w.account_id === row.account_id) ||
    list.find((w) => w.vm_id && w.vm_id === row.vm_id) ||
    null
  )
}

function groupCostEvents(rows = []) {
  const map = new Map()
  for (const row of rows) {
    const key = accountEventKey(row)
    const list = map.get(key) || []
    list.push(row)
    map.set(key, list)
  }
  return map
}

function isFableRow(row) {
  const upstream = String(row?.upstream_model ?? '').trim()
  const model = String(row?.model ?? '').trim()
  return (upstream || model).toLowerCase().includes('fable')
}

function unpricedWithTokens(row) {
  return row?.pricing_model === UNPRICED_MODEL && totalTokens(row) > 0
}

function bucketEventsSince(rows = [], sinceMs) {
  const since = Number(sinceMs)
  const picked = rows.filter((row) => {
    const at = Date.parse(row.created_at)
    return Number.isFinite(at) && (!Number.isFinite(since) || at >= since)
  })
  if (!picked.length) return { ...emptyCostBucket(), unpriced: 0 }
  return {
    ...sumCostBuckets(
      picked.map((row) => ({
        requests: 1,
        success: Number(row.success || 0),
        errors: Number(row.errors || 0),
        input_tokens: Number(row.input_tokens || 0),
        output_tokens: Number(row.output_tokens || 0),
        cache_read_tokens: Number(row.cache_read_tokens || 0),
        cache_creation_tokens: Number(row.cache_creation_tokens || 0),
        prompt_tokens: Number(row.prompt_tokens || 0),
        input_cost: Number(row.input_cost || 0),
        output_cost: Number(row.output_cost || 0),
        cache_read_cost: Number(row.cache_read_cost || 0),
        cache_creation_cost: Number(row.cache_creation_cost || 0),
        total_cost: Number(row.total_cost || 0),
      })),
    ),
    unpriced: picked.filter(unpricedWithTokens).length,
  }
}

function filterCond({ since = null, until = null, vmId = null, accountId = null, apiKeyId = null } = {}) {
  const { cond, params } = timeCond(since, until)
  const parts = cond ? [cond.replace(/^WHERE /, '')] : []
  if (vmId) {
    parts.push(`vm_id = $${params.length + 1}`)
    params.push(vmId)
  }
  if (apiKeyId) {
    parts.push(`api_key_id = $${params.length + 1}`)
    params.push(apiKeyId)
  }
  if (accountId) {
    parts.push(`(account_id = $${params.length + 1} OR final_account_id = $${params.length + 2})`)
    params.push(accountId, accountId)
  }
  return { cond: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params }
}

/** Same percentile pick as sub2api ops cards. */
export function percentile(sorted, p) {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[i]
}

export function summarizeLatency(values) {
  const s = (values || [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b)
  if (!s.length) {
    return { samples: 0, p50_ms: null, p90_ms: null, p95_ms: null, p99_ms: null, avg_ms: null, max_ms: null }
  }
  return {
    samples: s.length,
    p50_ms: percentile(s, 0.5),
    p90_ms: percentile(s, 0.9),
    p95_ms: percentile(s, 0.95),
    p99_ms: percentile(s, 0.99),
    avg_ms: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
    max_ms: s[s.length - 1],
  }
}

export class UsageLogsRepo {
  constructor(db = getDb()) {
    this.db = db
    // Panel endpoints request the same expensive billing snapshot several times
    // during one refresh. Keep this cache repository-local so it never affects
    // request accounting or persists across processes.
    this._billingStatsCache = new Map()
    this._billingBackfillAt = 0
    this._insert = db.prepare(`
      INSERT INTO usage_logs (${SUMMARY_COLUMNS.join(', ')})
      VALUES (${SUMMARY_COLUMNS.map((_, i) => '$' + (i + 1)).join(', ')})
    `)
    this._insertIfAbsent = db.prepare(`
      INSERT INTO usage_logs (${SUMMARY_COLUMNS.join(', ')})
      VALUES (${SUMMARY_COLUMNS.map((_, i) => '$' + (i + 1)).join(', ')})
      ON CONFLICT(request_id) DO NOTHING
    `)
    this._insertDebug = db.prepare(`
      INSERT INTO request_log_debug (request_id, ts, record_json) VALUES ($1, $2, $3)
      ON CONFLICT(request_id) DO UPDATE SET ts = excluded.ts, record_json = excluded.record_json
    `)
    this._insertDebugIfAbsent = db.prepare(`
      INSERT INTO request_log_debug (request_id, ts, record_json) VALUES ($1, $2, $3)
      ON CONFLICT(request_id) DO NOTHING
    `)
    this._getDebug = db.prepare('SELECT record_json FROM request_log_debug WHERE request_id = $1')
    this._vmOwner = db.prepare('SELECT owner_user_id FROM vms WHERE id = $1')
    this._listDebug = db.prepare('SELECT record_json FROM request_log_debug ORDER BY ts DESC LIMIT $1')
    this._getByRequestId = db.prepare('SELECT * FROM usage_logs WHERE request_id = $1')
    // OCTET_LENGTH counts encoded bytes rather than characters.
    this._debugBytes = db.prepare('SELECT COALESCE(SUM(OCTET_LENGTH(record_json)), 0) AS n FROM request_log_debug')
    this._debugCount = db.prepare('SELECT COUNT(*) AS n FROM request_log_debug')
    this._deleteOldUsage = db.prepare('DELETE FROM usage_logs WHERE created_at < $1')
    this._deleteOldDebug = db.prepare('DELETE FROM request_log_debug WHERE ts < $1')
    this._deleteOldestDebug = db.prepare(`
      DELETE FROM request_log_debug WHERE request_id IN (
        SELECT request_id FROM request_log_debug ORDER BY ts ASC LIMIT $1
      )
    `)
  }

  /** Cheap EXISTS: ≥1 2xx row visible to the caller (same ownerPred as request-log stats). */
  async hasSuccessfulRequest({ owner_user_id = null } = {}) {
    const own = ownerPred(owner_user_id)
    const where = own.sql ? `AND ${own.sql}` : ''
    const row = await this.db
      .prepare(`SELECT 1 AS ok FROM usage_logs WHERE status >= 200 AND status < 300 ${where} LIMIT 1`)
      .get(...own.params)
    return !!row
  }

  async belongsToOwner(requestId, ownerUserId) {
    if (!requestId) return false
    if (!ownerUserId) return true
    const own = ownerPred(ownerUserId, 1)
    const row = await this.db
      .prepare(`SELECT 1 AS ok FROM usage_logs WHERE request_id = $1 AND ${own.sql} LIMIT 1`)
      .get(requestId, ...own.params)
    return !!row
  }

  async getByRequestId(requestId) {
    if (!requestId) return null
    const row = await this._getByRequestId.get(requestId)
    return row ? enrichLogRow(fromRow(row)) : null
  }

  async insertSummary(rec) {
    await this._insert.run(...toRow(rec))
    return rec
  }

  async vmOwnerOf(vmId) {
    if (!vmId) return null
    return (await this._vmOwner.get(String(vmId)))?.owner_user_id || null
  }

  /** Idempotent insert for legacy imports. @returns true when inserted */
  async insertSummaryIfAbsent(rec) {
    return (await this._insertIfAbsent.run(...toRow(rec))).changes > 0
  }

  async insertDebug(requestId, ts, record) {
    await this._insertDebug.run(requestId, ts || new Date().toISOString(), JSON.stringify(record))
  }

  async insertDebugIfAbsent(requestId, ts, record) {
    return (
      (await this._insertDebugIfAbsent.run(requestId, ts || new Date().toISOString(), JSON.stringify(record))).changes >
      0
    )
  }

  async getDebug(requestId) {
    const row = await this._getDebug.get(requestId)
    if (!row) return null
    try {
      return enrichLogRow(JSON.parse(row.record_json))
    } catch {
      return null
    }
  }

  async listDebug({ limit = 20, owner_user_id = null } = {}) {
    const n = Math.max(1, Math.min(100, Number(limit) || 20))
    const own = ownerPred(owner_user_id)
    if (!own.sql) {
      return (await this._listDebug.all(n))
        .map((r) => {
          try {
            return enrichLogRow(JSON.parse(r.record_json))
          } catch {
            return null
          }
        })
        .filter(Boolean)
    }
    return (
      await this.db
        .prepare(`
      SELECT d.record_json
      FROM request_log_debug d
      JOIN usage_logs u ON u.request_id = d.request_id
      WHERE ${own.sql}
      ORDER BY d.ts DESC
      LIMIT $${own.params.length + 1}
    `)
        .all(...own.params, n)
    )
      .map((r) => {
        try {
          return enrichLogRow(JSON.parse(r.record_json))
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }

  /**
   * Filtered, paginated query over summaries (newest first).
   * @returns {{ items: object[], total: number }}
   */
  async query({
    limit = 50,
    offset = 0,
    api_key_id = null,
    vm_id = null,
    account_id = null,
    model = null,
    status = null,
    protocol = null,
    since = null,
    until = null,
    q = null,
    error_class = null,
    exclude_error_class = null,
    maxLimit = 500,
    owner_user_id = null,
  } = {}) {
    const where = []
    const params = []
    const own = ownerPred(owner_user_id)
    if (own.sql) {
      where.push(own.sql)
      params.push(...own.params)
    }
    if (api_key_id) {
      where.push(`api_key_id = $${params.length + 1}`)
      params.push(api_key_id)
    }
    if (vm_id) {
      where.push(`vm_id = $${params.length + 1}`)
      params.push(vm_id)
    }
    if (account_id) {
      where.push(`account_id = $${params.length + 1}`)
      params.push(account_id)
    }
    if (model) {
      where.push(`model = $${params.length + 1}`)
      params.push(model)
    }
    if (protocol) {
      where.push(`protocol = $${params.length + 1}`)
      params.push(protocol)
    }
    if (error_class && (status == null || status === '')) status = 'error'
    if (status != null && status !== '') {
      if (String(status) === 'error') where.push(ERROR_PRED)
      else if (String(status) === 'ok') where.push('(status < 400 AND status IS NOT NULL)')
      else {
        where.push(`status = $${params.length + 1}`)
        params.push(Number(status))
      }
    }
    if (!error_class && exclude_error_class) {
      const excludeSql = excludeErrorClassSql(exclude_error_class)
      if (excludeSql) where.push(excludeSql)
    }
    if (since) {
      where.push(`created_at >= $${params.length + 1}`)
      params.push(new Date(since).toISOString())
    }
    if (until) {
      where.push(`created_at <= $${params.length + 1}`)
      params.push(new Date(until).toISOString())
    }
    if (q) {
      where.push(
        `(ascii_fold(path) LIKE ascii_fold($${params.length + 1}) ESCAPE '' OR ascii_fold(error_code) LIKE ascii_fold($${params.length + 2}) ESCAPE '' OR ascii_fold(error_message) LIKE ascii_fold($${params.length + 3}) ESCAPE '' OR ascii_fold(request_id) LIKE ascii_fold($${params.length + 4}) ESCAPE '')`,
      )
      const like = `%${String(q).slice(0, 100)}%`
      params.push(like, like, like, like)
    }
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const cap = Math.max(1, Math.min(5000, Number(maxLimit) || 500))
    const n = Math.max(1, Math.min(cap, Number(limit) || 50))
    const off = Math.max(0, Number(offset) || 0)
    if (error_class) {
      const scan = Math.min(5000, Math.max(n + off, 2000))
      const rows = (
        await this.db
          .prepare(`SELECT * FROM usage_logs ${cond} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1}`)
          .all(...params, scan)
      )
        .map(fromRow)
        .map(enrichLogRow)
        .filter((row) => row.error_class === error_class)
      return { items: rows.slice(off, off + n), total: rows.length }
    }
    const total = (await this.db.prepare(`SELECT COUNT(*) c FROM usage_logs ${cond}`).get(...params)).c
    const items = (
      await this.db
        .prepare(
          `SELECT * FROM usage_logs ${cond} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        )
        .all(...params, n, off)
    )
      .map(fromRow)
      .map(enrichLogRow)
    return { items, total }
  }

  /**
   * Aggregate stats bucketed by day or hour (dashboard/usage charts).
   * @returns {Array<{bucket, requests, errors, input_tokens, output_tokens, avg_duration_ms}>}
   */
  async aggregate({ since = null, until = null, bucket = 'day', owner_user_id = null } = {}) {
    const fmt = bucket === 'hour' ? 'YYYY-MM-DD\"T\"HH24:00' : 'YYYY-MM-DD'
    const { cond, params } = timeCond(since, until)
    const own = ownerPred(owner_user_id, params.length)
    let where = cond
    const allParams = [...params]
    if (own.sql) {
      where = where ? `${where} AND ${own.sql}` : `WHERE ${own.sql}`
      allParams.push(...own.params)
    }
    return await this.db
      .prepare(`
      SELECT to_char(created_at::timestamptz AT TIME ZONE 'UTC', '${fmt}') AS bucket,
             COUNT(*) AS requests,
             SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
             COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
             COALESCE(SUM(total_cost), 0) AS total_cost,
             TRUNC(AVG(duration_ms))::bigint AS avg_duration_ms,
             TRUNC(AVG(first_token_ms))::bigint AS avg_first_token_ms
      FROM usage_logs ${where}
      GROUP BY bucket ORDER BY bucket
    `)
      .all(...allParams)
  }

  /** Grand totals (dashboard db_totals). */
  async totals() {
    const row = await this.db
      .prepare(`
      SELECT COUNT(*) AS requests,
             SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
             COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
             COALESCE(SUM(input_cost), 0) AS input_cost,
             COALESCE(SUM(output_cost), 0) AS output_cost,
             COALESCE(SUM(cache_read_cost), 0) AS cache_read_cost,
             COALESCE(SUM(cache_creation_cost), 0) AS cache_creation_cost,
             COALESCE(SUM(total_cost), 0) AS total_cost
      FROM usage_logs
    `)
      .get()
    return { ...row, ...cacheHitStats(row) }
  }

  _usageForPrice(row) {
    return {
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_creation_tokens: row.cache_creation_tokens,
      cache_creation_5m_tokens: row.cache_creation_5m_tokens,
      cache_creation_1h_tokens: row.cache_creation_1h_tokens,
      web_search_requests: row.web_search_requests,
      service_tier: row.service_tier,
      speed: row.speed,
    }
  }

  async _repriceRows(rows, { writeActualCost = false } = {}) {
    if (!rows.length) return { rows: 0, changed: 0, still_unpriced: 0, delta_usd: 0 }
    const upd = writeActualCost
      ? this.db.prepare(`
      UPDATE usage_logs
         SET input_cost = $1, output_cost = $2, cache_read_cost = $3,
             cache_creation_cost = $4, web_search_cost = $5, total_cost = $6,
             actual_cost = $7, pricing_model = $8, price_source = $9, price_version = $10,
             long_context = $11
       WHERE id = $12
    `)
      : this.db.prepare(`
      UPDATE usage_logs
         SET input_cost = $1, output_cost = $2, cache_read_cost = $3,
             cache_creation_cost = $4, web_search_cost = $5, total_cost = $6,
             pricing_model = $7, price_source = $8, price_version = $9, long_context = $10
       WHERE id = $11
    `)
    let changed = 0
    let still_unpriced = 0
    let delta_usd = 0
    await withTransaction(this.db, async () => {
      for (const r of rows) {
        const model = r.upstream_model || r.model || r.requested_model
        const priced = costColumnsFromUsage(this._usageForPrice(r), model)
        const same =
          (r.input_cost ?? null) === (priced.input_cost ?? null) &&
          (r.output_cost ?? null) === (priced.output_cost ?? null) &&
          (r.cache_read_cost ?? null) === (priced.cache_read_cost ?? null) &&
          (r.cache_creation_cost ?? null) === (priced.cache_creation_cost ?? null) &&
          (r.web_search_cost ?? null) === (priced.web_search_cost ?? null) &&
          (r.total_cost ?? null) === (priced.total_cost ?? null) &&
          (r.pricing_model ?? null) === (priced.pricing_model ?? null) &&
          (r.price_source ?? null) === (priced.price_source ?? null) &&
          (r.price_version ?? null) === (priced.price_version ?? null) &&
          (r.long_context ?? null) === (priced.long_context ?? null)
        if (priced.pricing_model === UNPRICED_MODEL || priced.total_cost == null) still_unpriced += 1
        if (!same) {
          changed += 1
          delta_usd +=
            (Number(priced.total_cost) || 0) - (Number.isFinite(Number(r.total_cost)) ? Number(r.total_cost) : 0)
        }
        if (writeActualCost) {
          const parsedRate = r.rate_multiplier == null ? 1 : Number(r.rate_multiplier)
          const rate = Number.isFinite(parsedRate) ? parsedRate : 1
          const actual = priced.total_cost == null ? null : priced.total_cost * rate
          await upd.run(
            priced.input_cost ?? null,
            priced.output_cost ?? null,
            priced.cache_read_cost ?? null,
            priced.cache_creation_cost ?? null,
            priced.web_search_cost ?? null,
            priced.total_cost ?? null,
            actual,
            priced.pricing_model ?? UNPRICED_MODEL,
            priced.price_source ?? null,
            priced.price_version ?? null,
            priced.long_context ?? null,
            r.id,
          )
        } else {
          await upd.run(
            priced.input_cost ?? null,
            priced.output_cost ?? null,
            priced.cache_read_cost ?? null,
            priced.cache_creation_cost ?? null,
            priced.web_search_cost ?? null,
            priced.total_cost ?? null,
            priced.pricing_model ?? UNPRICED_MODEL,
            priced.price_source ?? null,
            priced.price_version ?? null,
            priced.long_context ?? null,
            r.id,
          )
        }
      }
    })
    return { rows: rows.length, changed, still_unpriced, delta_usd }
  }

  /**
   * Fill official cost on rows that predate the billing columns, re-pricing with the
   * stored service_tier / speed. Rows the pricer cannot price are marked 'unpriced'
   * (cost stays NULL) so they are never guessed at standard rates. Idempotent.
   * Only `pricing_model IS NULL` rows; those set actual_cost = total_cost × rate_multiplier.
   */
  async backfillMissingCosts({ limit = 4000 } = {}) {
    const rows = await this.db
      .prepare(`
      SELECT id, model, upstream_model, requested_model,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             cache_creation_5m_tokens, cache_creation_1h_tokens, web_search_requests,
             rate_multiplier, service_tier, speed,
             input_cost, output_cost, cache_read_cost, cache_creation_cost, web_search_cost,
             total_cost, pricing_model, price_source, price_version, long_context
      FROM usage_logs
      WHERE pricing_model IS NULL
      LIMIT $1
    `)
      .all(Math.max(1, Math.min(20000, Number(limit) || 4000)))
    return (await this._repriceRows(rows, { writeActualCost: true })).rows
  }

  /** Rewrite cost columns in [since, until]; never actual_cost / rate_multiplier. */
  async repriceRange({ since, until } = {}) {
    const { cond, params } = timeCond(since, until)
    const where = `${cond || 'WHERE 1 = 1'} AND id > $${params.length + 1}`
    // Keyset pages keep a month-long range from loading every row at once.
    const page = this.db.prepare(`
      SELECT id, model, upstream_model, requested_model,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             cache_creation_5m_tokens, cache_creation_1h_tokens, web_search_requests,
             rate_multiplier, service_tier, speed,
             input_cost, output_cost, cache_read_cost, cache_creation_cost, web_search_cost,
             total_cost, pricing_model, price_source, price_version, long_context
      FROM usage_logs ${where}
      ORDER BY id
      LIMIT 2000
    `)
    const out = { rows: 0, changed: 0, still_unpriced: 0, delta_usd: 0 }
    let after = ''
    for (;;) {
      const rows = await page.all(...params, after)
      if (!rows.length) break
      const part = await this._repriceRows(rows, { writeActualCost: false })
      out.rows += part.rows
      out.changed += part.changed
      out.still_unpriced += part.still_unpriced
      out.delta_usd += part.delta_usd
      after = rows.at(-1).id
    }
    out.delta_usd = Math.round(out.delta_usd * 1e8) / 1e8
    return out
  }

  async unpricedModels({ since } = {}) {
    const where = [`pricing_model = '${UNPRICED_MODEL}'`]
    const params = []
    if (since) {
      where.push(`created_at >= $${params.length + 1}`)
      params.push(new Date(since).toISOString())
    }
    return (
      await this.db
        .prepare(`
      SELECT COALESCE(NULLIF(upstream_model, ''), NULLIF(model, ''), NULLIF(requested_model, ''), '') AS model,
             COUNT(*) AS requests,
             MAX(created_at) AS last_seen
      FROM usage_logs
      WHERE ${where.join(' AND ')}
      GROUP BY 1
      ORDER BY requests DESC, last_seen DESC
    `)
        .all(...params)
    ).map((r) => ({
      model: r.model,
      requests: Number(r.requests || 0),
      last_seen: r.last_seen || null,
    }))
  }

  async _costSelect(cond, params) {
    const row = await this.db
      .prepare(`
      SELECT
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
        COALESCE(SUM(input_cost), 0) AS input_cost,
        COALESCE(SUM(output_cost), 0) AS output_cost,
        COALESCE(SUM(cache_read_cost), 0) AS cache_read_cost,
        COALESCE(SUM(cache_creation_cost), 0) AS cache_creation_cost,
        COALESCE(SUM(total_cost), 0) AS total_cost,
        COALESCE(SUM(CASE WHEN pricing_model = '${UNPRICED_MODEL}' AND (${TOTAL_TOKENS_SQL}) > 0 THEN 1 ELSE 0 END), 0) AS unpriced
      FROM usage_logs ${cond}
    `)
      .get(...params)
    const out = {
      requests: Number(row?.requests || 0),
      input_tokens: Number(row?.input_tokens || 0),
      output_tokens: Number(row?.output_tokens || 0),
      cache_read_tokens: Number(row?.cache_read_tokens || 0),
      cache_creation_tokens: Number(row?.cache_creation_tokens || 0),
      prompt_tokens: Number(row?.prompt_tokens || 0),
      input_cost: Number(row?.input_cost || 0),
      output_cost: Number(row?.output_cost || 0),
      cache_read_cost: Number(row?.cache_read_cost || 0),
      cache_creation_cost: Number(row?.cache_creation_cost || 0),
      total_cost: Number(row?.total_cost || 0),
      unpriced: Number(row?.unpriced || 0),
    }
    return { ...out, ...cacheHitStats(out) }
  }

  async costByAccount({ since = null, until = null } = {}) {
    const { cond, params } = timeCond(since, until)
    const rows = await this.db
      .prepare(`
      SELECT
        COALESCE(NULLIF(final_account_id, ''), NULLIF(account_id, ''), vm_id, '—') AS account_id,
        vm_id,
        COUNT(*) AS requests,
        SUM(CASE WHEN ${SLA_SUCCESS_PRED} THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
        COALESCE(SUM(input_cost), 0) AS input_cost,
        COALESCE(SUM(output_cost), 0) AS output_cost,
        COALESCE(SUM(cache_read_cost), 0) AS cache_read_cost,
        COALESCE(SUM(cache_creation_cost), 0) AS cache_creation_cost,
        COALESCE(SUM(total_cost), 0) AS total_cost,
        COALESCE(SUM(CASE WHEN pricing_model = '${UNPRICED_MODEL}' AND (${TOTAL_TOKENS_SQL}) > 0 THEN 1 ELSE 0 END), 0) AS unpriced
      FROM usage_logs ${cond}
      GROUP BY 1, vm_id
      ORDER BY total_cost DESC
    `)
      .all(...params)
    return rows.map((r) => ({
      account_id: r.account_id,
      vm_id: r.vm_id || null,
      requests: Number(r.requests || 0),
      success: Number(r.success || 0),
      errors: Number(r.errors || 0),
      input_tokens: Number(r.input_tokens || 0),
      output_tokens: Number(r.output_tokens || 0),
      cache_read_tokens: Number(r.cache_read_tokens || 0),
      cache_creation_tokens: Number(r.cache_creation_tokens || 0),
      prompt_tokens: Number(r.prompt_tokens || 0),
      input_cost: Number(r.input_cost || 0),
      output_cost: Number(r.output_cost || 0),
      cache_read_cost: Number(r.cache_read_cost || 0),
      cache_creation_cost: Number(r.cache_creation_cost || 0),
      total_cost: Number(r.total_cost || 0),
      unpriced: Number(r.unpriced || 0),
    }))
  }

  /**
   * Official cost grouped by upstream model and billing band for one credential / slot.
   * service_tier is folded to fast / flex / other-raw (standard aliases → NULL);
   * speed is 'fast' or NULL. unpriced_requests counts rows left without an estimate.
   */
  async costByModel({ vmId = null, accountId = null, since = null, until = null } = {}) {
    const { cond, params } = filterCond({ since, until, vmId, accountId })
    const rows = await this.db
      .prepare(`
      SELECT COALESCE(NULLIF(upstream_model, ''), NULLIF(model, ''), NULLIF(requested_model, ''), '—') AS model,
             CASE
               WHEN service_tier IS NULL OR service_tier IN ('', 'default', 'auto', 'standard') THEN NULL
               WHEN service_tier IN ('priority', 'fast') THEN 'fast'
               ELSE service_tier
             END AS service_tier,
             CASE WHEN speed = 'fast' THEN 'fast' ELSE NULL END AS speed,
             COALESCE(long_context, 0) AS long_context,
             COUNT(*) AS requests,
             SUM(CASE WHEN pricing_model = '${UNPRICED_MODEL}' THEN 1 ELSE 0 END) AS unpriced_requests,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
             COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
             COALESCE(SUM(input_cost), 0) AS input_cost,
             COALESCE(SUM(output_cost), 0) AS output_cost,
             COALESCE(SUM(cache_read_cost), 0) AS cache_read_cost,
             COALESCE(SUM(cache_creation_cost), 0) AS cache_creation_cost,
             COALESCE(SUM(total_cost), 0) AS total_cost
      FROM usage_logs ${cond}
      GROUP BY 1, 2, 3, 4
      ORDER BY total_cost DESC, requests DESC
      LIMIT 24
    `)
      .all(...params)
    return rows.map((r) => ({
      model: r.model,
      service_tier: r.service_tier || null,
      speed: r.speed || null,
      long_context: Number(r.long_context || 0),
      requests: Number(r.requests || 0),
      unpriced_requests: Number(r.unpriced_requests || 0),
      input_tokens: Number(r.input_tokens || 0),
      output_tokens: Number(r.output_tokens || 0),
      cache_read_tokens: Number(r.cache_read_tokens || 0),
      cache_creation_tokens: Number(r.cache_creation_tokens || 0),
      prompt_tokens: Number(r.prompt_tokens || 0),
      input_cost: Number(r.input_cost || 0),
      output_cost: Number(r.output_cost || 0),
      cache_read_cost: Number(r.cache_read_cost || 0),
      cache_creation_cost: Number(r.cache_creation_cost || 0),
      total_cost: Number(r.total_cost || 0),
    }))
  }

  /**
   * Per-slot usage over the last `days` Shanghai calendar days (stats dialog).
   * Buckets are Shanghai days so the last bucket lines up with billingStats().today.
   * `models` / `endpoints` are ranked by request count and capped; `endpoints`
   * is the inbound request path (usage_logs keeps no separate upstream endpoint).
   */
  async vmUsageStats({ vmId, days = 30 } = {}) {
    return await this._usageWindow({
      vmId,
      days,
      rankExpr: "COALESCE(NULLIF(path, ''), '—')",
      rankKey: 'endpoints',
      rankLimit: 8,
    })
  }

  /** Same window as vmUsageStats, isolated to one managed key. Third rank is the VM. */
  async keyUsageStats({ apiKeyId, days = 30 } = {}) {
    return await this._usageWindow({
      apiKeyId,
      days,
      rankExpr: "COALESCE(NULLIF(vm_id, ''), '—')",
      rankKey: 'vms',
      rankLimit: 12,
    })
  }

  async _usageWindow({ vmId = null, apiKeyId = null, days = 30, rankExpr, rankKey, rankLimit = 8 } = {}) {
    const empty = { days: 0, since: null, history: [], models: [], [rankKey]: [] }
    if (!vmId && !apiKeyId) return empty
    const span = Math.max(1, Math.min(90, Math.floor(Number(days)) || 30))
    const since = new Date(Date.parse(shanghaiDayStartIso()) - (span - 1) * 86400_000).toISOString()
    const { cond, params } = filterCond({ since, vmId, apiKeyId })
    const history = (
      await this.db
        .prepare(`
      SELECT to_char(created_at::timestamptz AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day,
             COUNT(*) AS requests,
             SUM(CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
             COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
             COALESCE(SUM(total_cost), 0) AS total_cost,
             COALESCE(SUM(duration_ms), 0) AS duration_ms_sum,
             SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END) AS duration_n
      FROM usage_logs ${cond}
      GROUP BY day ORDER BY day
    `)
        .all(...params)
    ).map((r) => ({
      day: r.day,
      requests: Number(r.requests || 0),
      errors: Number(r.errors || 0),
      input_tokens: Number(r.input_tokens || 0),
      output_tokens: Number(r.output_tokens || 0),
      cache_read_tokens: Number(r.cache_read_tokens || 0),
      cache_creation_tokens: Number(r.cache_creation_tokens || 0),
      prompt_tokens: Number(r.prompt_tokens || 0),
      total_cost: Number(r.total_cost || 0),
      duration_ms_sum: Number(r.duration_ms_sum || 0),
      duration_n: Number(r.duration_n || 0),
    }))
    const group = async (expr, limit) =>
      (
        await this.db
          .prepare(`
      SELECT ${expr} AS name,
             COUNT(*) AS requests,
             COALESCE(SUM(${TOTAL_TOKENS_SQL}), 0) AS tokens,
             COALESCE(SUM(total_cost), 0) AS total_cost
      FROM usage_logs ${cond}
      GROUP BY name ORDER BY requests DESC, total_cost DESC LIMIT ${limit}
    `)
          .all(...params)
      ).map((r) => ({
        name: r.name,
        requests: Number(r.requests || 0),
        tokens: Number(r.tokens || 0),
        total_cost: Number(r.total_cost || 0),
      }))
    return {
      days: span,
      since,
      history,
      models: await group(
        "COALESCE(NULLIF(upstream_model, ''), NULLIF(model, ''), NULLIF(requested_model, ''), '—')",
        12,
      ),
      [rankKey]: await group(rankExpr, rankLimit),
    }
  }

  /**
   * Shanghai-day protocol gate: blocks, passes, and the words that blocked.
   * `total` is every inbound inference request (warmup answers included) plus
   * gate blocks on other paths, so each stage's share uses one denominator.
   */
  async protocolEntryStats({ since = shanghaiDayStartIso() } = {}) {
    // COALESCE: a bare `col = x` on NULL yields NULL, and `NOT NULL` drops the row.
    const block = `(
      COALESCE(error_code, '') = 'policy_blocked'
      OR COALESCE(via, '') IN ('hard-regex', 'jev', 'distill-detect', 'refusal-guard')
      OR COALESCE(final_state, '') IN ('policy_blocked', 'distill_blocked', 'refusal_guard', 'refusal_similar', 'refusal_device')
    )`
    const inference = `path IN ('/v1/messages', '/v1/responses', '/v1/chat/completions')`
    const row = await this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN ${inference} OR ${block} THEN 1 ELSE 0 END) AS total,
           SUM(CASE WHEN ${block} THEN 1 ELSE 0 END) AS blocked,
           SUM(CASE WHEN ${inference}
                     AND NOT ${block}
                     AND COALESCE(via, '') != 'warmup-intercept'
                THEN 1 ELSE 0 END) AS passed
         FROM usage_logs
         WHERE created_at >= $1`,
      )
      .get(since)
    const keywords = await this.db
      .prepare(
        `SELECT error_message AS message, COUNT(*) AS count
         FROM usage_logs
         WHERE created_at >= $1
           AND ${block}
           AND error_message IS NOT NULL
           AND error_message != ''
         GROUP BY error_message
         ORDER BY count DESC
         LIMIT 50`,
      )
      .all(since)
    const grouped = await this.db
      .prepare(
        `SELECT intercept, via, error_message AS message,
                CASE WHEN ${block} THEN 1 ELSE 0 END AS blocked,
                COUNT(*) AS count
         FROM usage_logs
         WHERE created_at >= $1
           AND (
             ${block}
             OR (${inference} AND COALESCE(via, '') != 'warmup-intercept')
           )
         GROUP BY intercept, via, error_message, blocked`,
      )
      .all(since)
    const folded = foldInterceptRows(grouped)
    return {
      since,
      total: Number(row?.total || 0),
      blocked: Number(row?.blocked || 0),
      passed: Number(row?.passed || 0),
      keywords: collapseBlockKeywords(keywords),
      blocks: folded.blocks,
      passes: folded.passes,
    }
  }

  /** Official-standard totals: all-time + Shanghai calendar today + per account. */
  async billingStats(opts = {}) {
    const { accountWindows = null, now = Date.now() } = opts
    const cacheable = !Object.hasOwn(opts, 'now')
    const cacheNow = Date.now()
    const key = billingStatsCacheKey(accountWindows)
    const cached = cacheable ? this._billingStatsCache.get(key) : null
    if (cached && cached.expires_at > cacheNow) return cached.value

    // Historical cost repair is maintenance, not part of rendering a panel.
    // Limit it independently so several panel endpoints cannot repeat the same
    // synchronous scan in a single refresh.
    if (cacheNow - this._billingBackfillAt >= BILLING_BACKFILL_INTERVAL_MS) {
      this._billingBackfillAt = cacheNow
      try {
        await this.backfillMissingCosts()
      } catch {}
    }

    const value = await this._computeBillingStats({ accountWindows, now })
    if (this._billingStatsCache.size > 32) {
      for (const [cacheKey, entry] of this._billingStatsCache) {
        if (entry.expires_at <= cacheNow) this._billingStatsCache.delete(cacheKey)
      }
    }
    // Start the TTL after the expensive synchronous aggregation completes. On
    // large databases the computation itself can exceed the TTL; anchoring the
    // expiry at cache lookup time would make a freshly computed entry already
    // stale and every refresh would scan the table again.
    if (cacheable) this._billingStatsCache.set(key, { value, expires_at: Date.now() + BILLING_STATS_CACHE_TTL_MS })
    return value
  }

  async _computeBillingStats({ accountWindows = null, now = Date.now() } = {}) {
    const todayStart = shanghaiDayStartIso()
    const fiveHStart = new Date(now - WINDOW_5H_MS).toISOString()
    const sevenDStart = new Date(now - WINDOW_7D_MS).toISOString()
    const accountsTotal = await this.costByAccount()
    const accountsToday = await this.costByAccount({ since: todayStart })
    // The per-account queries already cover every row. Re-sum them for the
    // global buckets instead of scanning the entire usage table two more times.
    // This matters on multi-GB databases where each synchronous full scan also
    // blocks unrelated HTTP requests on the Node event loop.
    const totalBucket = sumCostBuckets(accountsTotal)
    const todayBucket = sumCostBuckets(accountsToday)
    const total = { ...totalBucket, ...cacheHitStats(totalBucket) }
    const today = { ...todayBucket, ...cacheHitStats(todayBucket) }
    const keyOf = (a) => a.account_id + '\0' + (a.vm_id || '')
    const todayById = new Map(accountsToday.map((a) => [keyOf(a), a]))
    const aligned = Array.isArray(accountWindows) && accountWindows.length > 0
    let eventsSince = sevenDStart
    if (aligned) {
      let earliest = Date.parse(sevenDStart)
      for (const win of accountWindows) {
        for (const [reset, dur] of [
          [win.reset_5h, WINDOW_5H_MS],
          [win.reset_7d, WINDOW_7D_MS],
          [win.reset_7d_oi, WINDOW_7D_MS],
        ]) {
          const start = extraWindowSince(reset, dur, now)
          if (start != null && start < earliest) earliest = start
        }
      }
      eventsSince = new Date(earliest).toISOString()
    }
    const events = aligned ? await this._costEventsSince(eventsSince) : null
    const fiveById = aligned
      ? null
      : new Map((await this.costByAccount({ since: fiveHStart })).map((a) => [keyOf(a), a]))
    const sevenById = aligned
      ? null
      : new Map((await this.costByAccount({ since: sevenDStart })).map((a) => [keyOf(a), a]))
    const eventsByKey = aligned ? groupCostEvents(events) : null
    const accounts = accountsTotal.map((a) => {
      const t = todayById.get(keyOf(a)) || emptyCostBucket()
      const win = aligned ? resolveAccountWindow(accountWindows, a) : null
      const since5 = aligned ? (extraWindowSince(win?.reset_5h, WINDOW_5H_MS, now) ?? Date.parse(fiveHStart)) : null
      const since7 = aligned ? (extraWindowSince(win?.reset_7d, WINDOW_7D_MS, now) ?? Date.parse(sevenDStart)) : null
      const w = aligned
        ? bucketEventsSince(eventsByKey.get(keyOf(a)) || [], since5)
        : fiveById.get(keyOf(a)) || emptyCostBucket()
      const w7 = aligned
        ? bucketEventsSince(eventsByKey.get(keyOf(a)) || [], since7)
        : sevenById.get(keyOf(a)) || emptyCostBucket()
      let window_fable = null
      if (aligned && win?.reset_7d_oi) {
        const sinceFable = extraWindowSince(win.reset_7d_oi, WINDOW_7D_MS, now) ?? Date.parse(sevenDStart)
        const fable = bucketEventsSince((eventsByKey.get(keyOf(a)) || []).filter(isFableRow), sinceFable)
        window_fable = {
          cost: Number(fable.total_cost || 0),
          tokens: totalTokens(fable),
          requests: Number(fable.requests || 0),
          unpriced: Number(fable.unpriced || 0),
          start: new Date(sinceFable).toISOString(),
        }
      }
      return {
        ...a,
        today: { ...t },
        window_5h: { ...w },
        window_7d: { ...w7 },
        today_cost: Number(t.total_cost || 0),
        today_requests: Number(t.requests || 0),
        today_input_tokens: Number(t.input_tokens || 0),
        today_output_tokens: Number(t.output_tokens || 0),
        today_cache_read_tokens: Number(t.cache_read_tokens || 0),
        today_cache_creation_tokens: Number(t.cache_creation_tokens || 0),
        today_input_cost: Number(t.input_cost || 0),
        today_output_cost: Number(t.output_cost || 0),
        today_cache_cost: Number(t.cache_read_cost || 0) + Number(t.cache_creation_cost || 0),
        window_5h_cost: Number(w.total_cost || 0),
        window_5h_requests: Number(w.requests || 0),
        window_5h_tokens: totalTokens(w),
        window_5h_unpriced: Number(w.unpriced || 0),
        window_5h_input_tokens: Number(w.input_tokens || 0),
        window_5h_output_tokens: Number(w.output_tokens || 0),
        window_5h_cache_read_tokens: Number(w.cache_read_tokens || 0),
        window_5h_cache_creation_tokens: Number(w.cache_creation_tokens || 0),
        window_5h_input_cost: Number(w.input_cost || 0),
        window_5h_output_cost: Number(w.output_cost || 0),
        window_5h_cache_cost: Number(w.cache_read_cost || 0) + Number(w.cache_creation_cost || 0),
        window_5h_start: aligned ? new Date(since5).toISOString() : fiveHStart,
        window_7d_cost: Number(w7.total_cost || 0),
        window_7d_requests: Number(w7.requests || 0),
        window_7d_success: Number(w7.success || 0),
        window_7d_errors: Number(w7.errors || 0),
        window_7d_tokens: totalTokens(w7),
        window_7d_unpriced: Number(w7.unpriced || 0),
        window_7d_start: aligned ? new Date(since7).toISOString() : sevenDStart,
        window_fable,
      }
    })
    const window5h = aligned
      ? {
          ...sumCostBuckets(accounts.map((a) => a.window_5h)),
          ...cacheHitStats(sumCostBuckets(accounts.map((a) => a.window_5h))),
        }
      : await this._costSelect('WHERE created_at >= $1', [fiveHStart])
    const window7d = aligned
      ? {
          ...sumCostBuckets(accounts.map((a) => a.window_7d)),
          ...cacheHitStats(sumCostBuckets(accounts.map((a) => a.window_7d))),
        }
      : await this._costSelect('WHERE created_at >= $1', [sevenDStart])
    const coverage = await this.logCoverageStart()
    return {
      source: 'anthropic-official',
      currency: 'USD',
      today_start: todayStart,
      log_coverage_start: coverage,
      window_5h_start: aligned
        ? accounts.reduce((min, a) => (!min || a.window_5h_start < min ? a.window_5h_start : min), fiveHStart)
        : fiveHStart,
      window_7d_start: aligned
        ? accounts.reduce((min, a) => (!min || a.window_7d_start < min ? a.window_7d_start : min), sevenDStart)
        : sevenDStart,
      today,
      window_5h: window5h,
      window_7d: window7d,
      total,
      accounts,
    }
  }

  /**
   * Earliest instant whose traffic is still fully in usage_logs: the later of the DB's
   * creation (first migration) and the recorded prune boundary. Neither the oldest
   * surviving row (a quiet hour looks like a gap) nor the current retain_days (raising
   * it does not bring deleted rows back) can stand in for that boundary.
   */
  async logCoverageStart() {
    const created = Date.parse(
      (await this.db.prepare("SELECT MIN(applied_at) AS t FROM schema_migrations WHERE version = '001'").get())?.t ||
        '',
    )
    const pruned = Date.parse((await this._prunedThrough()) || '')
    const start = Math.max(Number.isFinite(created) ? created : -Infinity, Number.isFinite(pruned) ? pruned : -Infinity)
    return Number.isFinite(start) ? new Date(start).toISOString() : null
  }

  async _prunedThrough() {
    const row = await this.db.prepare(`SELECT value FROM settings WHERE key = '${PRUNED_THROUGH_KEY}'`).get()
    try {
      return row ? JSON.parse(row.value) : null
    } catch {
      return null
    }
  }

  async _costEventsSince(since) {
    return await this.db
      .prepare(
        `
      SELECT
        COALESCE(NULLIF(final_account_id, ''), NULLIF(account_id, ''), vm_id, '—') AS account_id,
        vm_id,
        created_at,
        model,
        upstream_model,
        pricing_model,
        CASE WHEN ${SLA_SUCCESS_PRED} THEN 1 ELSE 0 END AS success,
        CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END AS errors,
        COALESCE(input_tokens, 0) AS input_tokens,
        COALESCE(output_tokens, 0) AS output_tokens,
        COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
        COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens,
        (${PROMPT_TOKENS_SQL}) AS prompt_tokens,
        COALESCE(input_cost, 0) AS input_cost,
        COALESCE(output_cost, 0) AS output_cost,
        COALESCE(cache_read_cost, 0) AS cache_read_cost,
        COALESCE(cache_creation_cost, 0) AS cache_creation_cost,
        COALESCE(total_cost, 0) AS total_cost
      FROM usage_logs
      WHERE created_at >= $1
    `,
      )
      .all(since)
  }

  async ownerBilling({ ownerUserId = null, since = null, until = null, groupBy = 'vm' } = {}) {
    const where = []
    const params = []
    const own = ownerPred(ownerUserId)
    if (own.sql) {
      where.push(own.sql)
      params.push(...own.params)
    }
    if (since) {
      where.push(`created_at >= $${params.length + 1}`)
      params.push(new Date(since).toISOString())
    }
    if (until) {
      where.push(`created_at <= $${params.length + 1}`)
      params.push(new Date(until).toISOString())
    }
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const grouped = groupBy === 'key' ? 'key' : 'vm'
    const groupCol = grouped === 'key' ? 'api_key_id' : 'vm_id'
    const totals = await this.db
      .prepare(`
      SELECT COUNT(*) AS requests,
             SUM(CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END) AS ok,
             SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END) AS fail,
             COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS tokens_in,
             COALESCE(SUM(output_tokens), 0) AS tokens_out,
             COALESCE(SUM(COALESCE(actual_cost, total_cost, 0)), 0) AS cost_usd,
             COALESCE(SUM(COALESCE(total_cost, 0)), 0) AS official_cost_usd
      FROM usage_logs ${cond}
    `)
      .get(...params)
    const items = await this.db
      .prepare(`
      SELECT ${groupCol} AS id,
             COUNT(*) AS requests,
             SUM(CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END) AS ok,
             SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END) AS fail,
             COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS tokens_in,
             COALESCE(SUM(output_tokens), 0) AS tokens_out,
             COALESCE(SUM(COALESCE(actual_cost, total_cost, 0)), 0) AS cost_usd,
             COALESCE(SUM(COALESCE(total_cost, 0)), 0) AS official_cost_usd
      FROM usage_logs ${cond}
      GROUP BY ${groupCol}
      ORDER BY cost_usd DESC
    `)
      .all(...params)
    const num = (row, key) => Number(row?.[key] || 0)
    return {
      group_by: grouped,
      since: since ? new Date(since).toISOString() : null,
      until: until ? new Date(until).toISOString() : null,
      totals: {
        requests: num(totals, 'requests'),
        ok: num(totals, 'ok'),
        fail: num(totals, 'fail'),
        tokens_in: num(totals, 'tokens_in'),
        tokens_out: num(totals, 'tokens_out'),
        cost_usd: num(totals, 'cost_usd'),
        official_cost_usd: num(totals, 'official_cost_usd'),
      },
      items: items.map((row) => ({
        vm_id: grouped === 'vm' ? row.id || null : undefined,
        api_key_id: grouped === 'key' ? row.id || null : undefined,
        requests: num(row, 'requests'),
        ok: num(row, 'ok'),
        fail: num(row, 'fail'),
        tokens_in: num(row, 'tokens_in'),
        tokens_out: num(row, 'tokens_out'),
        cost_usd: num(row, 'cost_usd'),
        official_cost_usd: num(row, 'official_cost_usd'),
      })),
    }
  }

  /**
   * Windowed ops snapshot aligned with sub2api overview cards:
   * SLA / error / 429 / 503, QPS·TPS, duration + first_token percentiles, per-model.
   */
  async windowStats({ since = null, until = null, owner_user_id = null } = {}) {
    const { cond, params } = timeCond(since, until)
    const own = ownerPred(owner_user_id, params.length)
    let where = cond
    const allParams = [...params]
    if (own.sql) {
      where = where ? `${where} AND ${own.sql}` : `WHERE ${own.sql}`
      allParams.push(...own.params)
    }
    const counts = await this.db
      .prepare(`
      SELECT
        COUNT(*) AS requests,
        SUM(CASE WHEN ${SLA_SUCCESS_PRED} THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END) AS status_429,
        SUM(CASE WHEN status = 529 THEN 1 ELSE 0 END) AS status_529,
        SUM(CASE WHEN status = 503 THEN 1 ELSE 0 END) AS status_503,
        SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END) AS stream_requests,
        SUM(CASE WHEN first_token_ms IS NOT NULL THEN 1 ELSE 0 END) AS ttft_samples,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
        COALESCE(SUM(total_cost), 0) AS total_cost
      FROM usage_logs ${where}
    `)
      .get(...allParams)
    const requests = Number(counts?.requests || 0)
    const success = Number(counts?.success || 0)
    const errors = Number(counts?.errors || 0)
    const inputTokens = Number(counts?.input_tokens || 0)
    const outputTokens = Number(counts?.output_tokens || 0)
    const cacheRead = Number(counts?.cache_read_tokens || 0)
    const cacheWrite = Number(counts?.cache_creation_tokens || 0)
    const cache = cacheHitStats({
      input_tokens: inputTokens,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheWrite,
      prompt_tokens: Number(counts?.prompt_tokens || 0),
    })
    const tokens = inputTokens + outputTokens + cacheRead + cacheWrite

    const startMs = since ? Date.parse(since) : null
    const endMs = until ? Date.parse(until) : Date.now()
    const windowSeconds =
      Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(1, (endMs - startMs) / 1000) : Math.max(1, requests)

    const minuteRows = await this.db
      .prepare(`
      SELECT to_char(created_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI') AS minute,
             COUNT(*) AS requests,
             COALESCE(SUM(${TOTAL_TOKENS_SQL}), 0) AS tokens
      FROM usage_logs ${where}
      GROUP BY minute
    `)
      .all(...allParams)
    const peakReq = minuteRows.reduce((m, r) => Math.max(m, Number(r.requests || 0)), 0)
    const peakTok = minuteRows.reduce((m, r) => Math.max(m, Number(r.tokens || 0)), 0)
    const lastMinute = minuteRows.length ? minuteRows[minuteRows.length - 1] : null

    const ttftWhere = where ? `${where} AND first_token_ms IS NOT NULL` : 'WHERE first_token_ms IS NOT NULL'
    const durWhere = where ? `${where} AND duration_ms IS NOT NULL` : 'WHERE duration_ms IS NOT NULL'
    const ttfts = (
      await this.db.prepare(`SELECT first_token_ms AS v FROM usage_logs ${ttftWhere}`).all(...allParams)
    ).map((r) => r.v)
    const durs = (await this.db.prepare(`SELECT duration_ms AS v FROM usage_logs ${durWhere}`).all(...allParams)).map(
      (r) => r.v,
    )

    const byModel = await this.db
      .prepare(`
      SELECT COALESCE(NULLIF(upstream_model, ''), NULLIF(model, ''), '—') AS model,
             COUNT(*) AS requests,
             SUM(CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN first_token_ms IS NOT NULL THEN 1 ELSE 0 END) AS ttft_samples,
             TRUNC(AVG(first_token_ms))::bigint AS avg_first_token_ms,
             TRUNC(AVG(duration_ms))::bigint AS avg_duration_ms
      FROM usage_logs ${where}
      GROUP BY 1
      ORDER BY requests DESC
      LIMIT 12
    `)
      .all(...allParams)

    return {
      since: since ? new Date(since).toISOString() : null,
      until: until ? new Date(until).toISOString() : new Date().toISOString(),
      window_seconds: Math.round(windowSeconds),
      requests,
      success,
      errors,
      sla: requests ? success / requests : 1,
      error_rate: requests ? errors / requests : 0,
      status_429: Number(counts?.status_429 || 0),
      status_529: Number(counts?.status_529 || 0),
      status_503: Number(counts?.status_503 || 0),
      stream_requests: Number(counts?.stream_requests || 0),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheWrite,
      prompt_tokens: cache.prompt_tokens,
      cache_hit_rate: cache.cache_hit_rate,
      sticky: await this._stickyWindow({ since, until, owner_user_id }),
      total_cost: Number(counts?.total_cost || 0),
      qps: {
        current: lastMinute ? Number(lastMinute.requests || 0) / 60 : 0,
        peak: peakReq / 60,
        avg: requests / windowSeconds,
      },
      tps: {
        current: lastMinute ? Number(lastMinute.tokens || 0) / 60 : 0,
        peak: peakTok / 60,
        avg: tokens / windowSeconds,
      },
      duration: summarizeLatency(durs),
      ttft: summarizeLatency(ttfts),
      by_model: byModel.map((r) => ({
        model: r.model,
        requests: Number(r.requests || 0),
        errors: Number(r.errors || 0),
        ttft_samples: Number(r.ttft_samples || 0),
        avg_first_token_ms: r.avg_first_token_ms ?? null,
        avg_duration_ms: r.avg_duration_ms ?? null,
      })),
      error_collection: await this.errorCollection({ since, until, owner_user_id }),
    }
  }

  async _stickyWindow({ since = null, until = null, owner_user_id = null } = {}) {
    const empty = { selections: 0, hits: 0, rate: null }
    try {
      const parts = []
      const params = []
      if (since) {
        parts.push(`started_at >= $${params.length + 1}`)
        params.push(since)
      }
      if (until) {
        parts.push(`started_at <= $${params.length + 1}`)
        params.push(until)
      }
      const own = ownerPred(owner_user_id, params.length)
      if (own.sql) {
        parts.push(`request_id IN (SELECT request_id FROM usage_logs WHERE ${own.sql})`)
        params.push(...own.params)
      }
      const where = parts.length ? `WHERE ${parts.join(' AND ')}` : ''
      const rows = await this.db
        .prepare(`
        SELECT selection_reason, COUNT(*) AS n
        FROM request_attempts ${where}
        GROUP BY 1
      `)
        .all(...params)
      let selections = 0
      let hits = 0
      for (const row of rows) {
        const n = Number(row.n || 0)
        selections += n
        if (String(row.selection_reason || '') === 'sticky') hits += n
      }
      return {
        selections,
        hits,
        rate: selections > 0 ? hits / selections : null,
      }
    } catch {
      return empty
    }
  }

  async errorCollection({ since = null, until = null, owner_user_id = null } = {}) {
    const { cond, params } = timeCond(since, until)
    const own = ownerPred(owner_user_id, params.length)
    const errCond = `${cond ? `${cond} AND ` : 'WHERE '}${ERROR_PRED}${own.sql ? ` AND ${own.sql}` : ''}`
    const rows = await this.db
      .prepare(`
      SELECT created_at AS ts, request_id, status, error_code, error_message, model, upstream_model, vm_id, ip_address AS ip, api_key_presented
      FROM usage_logs ${errCond}
      ORDER BY created_at DESC, id DESC
      LIMIT 2000
    `)
      .all(...params, ...own.params)
    return {
      ...collectErrors(rows),
      ingress_hits: await this.ingressHits({ since, until, owner_user_id }),
    }
  }

  /** Invalid-key 401s grouped by presented token + IP (still counted when muted). */
  async ingressHits({ since = null, until = null, owner_user_id = null } = {}) {
    const { cond, params } = timeCond(since, until)
    const own = ownerPred(owner_user_id, params.length)
    const authPred = own.sql ? `${ingressAuthSql()} AND ${own.sql}` : ingressAuthSql()
    const where = cond ? `${cond} AND ${authPred}` : `WHERE ${authPred}`
    try {
      return (
        await this.db
          .prepare(`
        SELECT
          COALESCE(api_key_presented, '') AS api_key_presented,
          COALESCE(ip_address, '') AS ip,
          COUNT(*) AS count,
          MAX(created_at) AS last_ts,
          MAX(error_code) AS error_code
        FROM usage_logs
        ${where}
        GROUP BY 1, 2
        ORDER BY count DESC
        LIMIT 40
      `)
          .all(...params, ...own.params)
      ).map((row) => ({
        api_key_presented: row.api_key_presented || '',
        ip: row.ip || '',
        count: Number(row.count || 0),
        last_ts: row.last_ts || null,
        error_code: row.error_code || null,
      }))
    } catch {
      return []
    }
  }

  /**
   * Age out summaries/debug independently, then trim debug blobs to maxBytes.
   * Number form `cleanup(7)` keeps the old retainDays-only call.
   */
  async cleanup(opts = {}) {
    const cfg = this._cleanupOpts(opts)
    const usage_logs = await this._pruneUsage(cfg.usageCutoff)
    const debug_by_age = (await this._deleteOldDebug.run(cfg.debugCutoff)).changes
    const debug_by_size = await this.trimDebugToMaxBytes(cfg.maxBytes)
    return {
      usage_logs,
      request_log_debug: debug_by_age + debug_by_size,
      debug_by_age,
      debug_by_size,
    }
  }

  /** Delete summaries before `cutoff` and advance the prune boundary in one transaction. */
  async _pruneUsage(cutoff) {
    return withTransaction(this.db, async () => {
      const deleted = (await this._deleteOldUsage.run(cutoff)).changes
      if (deleted > 0) {
        await this.db
          .prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('${PRUNED_THROUGH_KEY}', $1, $2)
          ON CONFLICT(key) DO UPDATE SET value = GREATEST(settings.value, excluded.value), updated_at = excluded.updated_at`)
          .run(JSON.stringify(cutoff), new Date().toISOString())
      }
      return deleted
    })
  }

  _cleanupOpts(opts) {
    const raw = typeof opts === 'number' ? { retainDays: opts } : opts || {}
    const retainDays = Math.max(1, Number(raw.retainDays) || 7)
    let debugDays = Math.max(1, Number(raw.debugRetainDays) || 3)
    if (debugDays > retainDays) debugDays = retainDays
    return {
      usageCutoff: new Date(Date.now() - retainDays * 86400_000).toISOString(),
      debugCutoff: new Date(Date.now() - debugDays * 86400_000).toISOString(),
      maxBytes: Math.max(0, Number(raw.maxBytes) || 0),
    }
  }

  async debugBytes() {
    return Number((await this._debugBytes.get()).n || 0)
  }

  async countDebug() {
    return Number((await this._debugCount.get()).n || 0)
  }

  /** Delete oldest debug rows until the stored JSON bytes fit maxBytes. */
  async trimDebugToMaxBytes(maxBytes) {
    const cap = Math.max(0, Number(maxBytes) || 0)
    if (cap <= 0) return 0
    let deleted = 0
    for (let i = 0; i < 8; i++) {
      const used = await this.debugBytes()
      if (used <= cap) return deleted
      const count = await this.countDebug()
      if (!count) return deleted
      const avg = Math.max(1, Math.floor(used / count))
      const need = Math.min(count, Math.max(1, Math.ceil((used - cap) / avg) + 1))
      const n = (await this._deleteOldestDebug.run(need)).changes
      if (!n) return deleted
      deleted += n
    }
    return deleted
  }

  async count() {
    return (await this.db.prepare('SELECT COUNT(*) c FROM usage_logs').get()).c
  }
}

/** Transitional alias while callers migrate to the sub2api name. */
export { UsageLogsRepo as RequestLogsRepo }
