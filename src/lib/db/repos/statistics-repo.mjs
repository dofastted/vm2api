/**
 * `/api/panel/statistics*` aggregates over `usage_logs`.
 *
 * Windows and buckets follow the caller's IANA `tz` (browser zone): "today" is
 * hourly from local midnight, other ranges are daily from local midnights, so
 * DST days are 23/25 hours long. SQL groups rows into 15-minute UTC slots
 * (every real zone offset is a multiple of 15 minutes) and JS assigns each slot
 * to its bucket — exact without a per-row Intl call.
 *
 * Shape: `web/src/types/panel-statistics.ts`.
 */

import { getDb } from '../database.mjs'
import { reportTimezone, zonedDayStartMs, zonedParts, zonedWallToMs } from '../../core/timezone.mjs'
import { ERROR_PRED, PROMPT_TOKENS_SQL, SUCCESS_PRED, TOTAL_TOKENS_SQL, ownerPred } from './usage-log-preds.mjs'
import { lookupNames } from './usage-logs-view.mjs'

export const STATS_RANGES = ['today', '7days', '30days', 'thisMonth']
export const STATS_DIMENSIONS = ['user', 'key', 'model', 'vm']
/** Tenant groupings. `user` would name other tenants. `vm` is only that tenant's own slots. */
export const USER_ROLE_DIMENSIONS = ['key', 'model', 'vm']

const MAX_SERIES = 8
const OTHERS_ID = '__others__'
const OTHERS_NAME = '其他'
const NONE_ID = '__none__'
const NONE_NAME = '未知'
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const LEADERBOARD_DEFAULT = 20
const LEADERBOARD_MAX = 100

const DIMENSION_COLUMN = { user: 'user_id', key: 'api_key_id', model: 'model', vm: 'vm_id' }

const TOKENS_SQL = TOTAL_TOKENS_SQL

/** created_at (`YYYY-MM-DDTHH:MM:SS.sssZ`) floored to its 15-minute UTC slot. */
const SLOT_SQL = "substr(created_at, 1, 14) || printf('%02d', (CAST(substr(created_at, 15, 2) AS INTEGER) / 15) * 15)"

function isWholeHourAligned(ms) {
  return Number.isFinite(ms) && ms % HOUR_MS === 0
}

function isoDateUtc(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function avgOrNull(v) {
  return v == null ? null : Math.round(Number(v))
}

export function normalizeRange(range) {
  return STATS_RANGES.includes(range) ? range : null
}

export function normalizeDimension(dimension) {
  return STATS_DIMENSIONS.includes(dimension) ? dimension : null
}

/**
 * Window `[since, until)` plus bucket start instants for `range` in `tz`.
 * @returns {{ since: number, until: number, resolution: 'hour'|'day', buckets: number[] }}
 */
export function resolveWindow(range, tz, now = Date.now()) {
  const todayStart = zonedDayStartMs(now, tz)
  if (range === 'today') {
    const buckets = []
    for (let t = todayStart; t < now; t += HOUR_MS) buckets.push(t)
    if (!buckets.length) buckets.push(todayStart)
    return { since: todayStart, until: now, resolution: 'hour', buckets }
  }
  let since
  if (range === 'thisMonth') {
    const p = zonedParts(now, tz)
    since = zonedWallToMs({ year: p.year, month: p.month, day: 1 }, tz)
  } else {
    since = zonedDayStartMs(now, tz, range === '30days' ? -29 : -6)
  }
  const buckets = []
  for (let k = 0; ; k++) {
    const t = zonedDayStartMs(since, tz, k)
    if (t >= now) break
    buckets.push(t)
  }
  if (!buckets.length) buckets.push(since)
  return { since, until: now, resolution: 'day', buckets }
}

/** Index of the last bucket starting at or before `ms`. */
function bucketIndex(buckets, ms) {
  let lo = 0
  let hi = buckets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (buckets[mid] <= ms) lo = mid
    else hi = mid - 1
  }
  return lo
}

function delta(cur, prev) {
  return prev > 0 ? (cur - prev) / prev : null
}

function zeroLeaderboardEntry(id, name) {
  return {
    id,
    name,
    totalRequests: 0,
    successRequests: 0,
    errorRequests: 0,
    successRate: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    cacheHitRate: 0,
    totalCost: 0,
    totalActualCost: 0,
    avgDurationMs: null,
    avgTtftMs: null,
  }
}

function leaderboardEntry(row, id, name) {
  const input = num(row.input_tokens)
  const output = num(row.output_tokens)
  const cacheRead = num(row.cache_read_tokens)
  const cacheCreation = num(row.cache_creation_tokens)
  const requests = num(row.requests)
  const prompt = num(row.prompt_tokens)
  return {
    id,
    name,
    totalRequests: requests,
    successRequests: num(row.success),
    errorRequests: num(row.errors),
    successRate: requests > 0 ? num(row.success) / requests : 0,
    totalTokens: input + output + cacheRead + cacheCreation,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    cacheCreation5mTokens: num(row.cache_creation_5m_tokens),
    cacheCreation1hTokens: num(row.cache_creation_1h_tokens),
    cacheHitRate: prompt > 0 ? Math.min(1, cacheRead / prompt) : 0,
    totalCost: num(row.cost),
    totalActualCost: num(row.actual_cost),
    avgDurationMs: avgOrNull(row.avg_duration_ms),
    avgTtftMs: avgOrNull(row.avg_ttft_ms),
  }
}

export class StatisticsRepo {
  constructor(db = getDb()) {
    this.db = db
  }

  _scope(sinceMs, untilMs, ownerUserId, extra = null) {
    const where = ['created_at >= ?', 'created_at < ?']
    const params = [new Date(sinceMs).toISOString(), new Date(untilMs).toISOString()]
    const own = ownerPred(ownerUserId)
    if (own.sql) {
      where.push(own.sql)
      params.push(...own.params)
    }
    if (extra?.sql) {
      where.push(extra.sql)
      params.push(...extra.params)
    }
    return { cond: `WHERE ${where.join(' AND ')}`, params }
  }

  /** Pool slots that merely served a tenant stay unnamed. */
  _ownedVmFilter(ownerUserId) {
    if (!ownerUserId) return null
    return { sql: 'vm_id IN (SELECT id FROM vms WHERE owner_user_id = ?)', params: [String(ownerUserId)] }
  }

  /**
   * Read the PG dashboard pre-aggregation watermark as a plain scalar so callers
   * can pass it into subsequent queries as a direct `$param` (never a CTE CROSS JOIN,
   * which defeats PostgreSQL's `created_at` B-tree range scan).
   */
  _readPreAggWatermark() {
    if (this.db?.engine !== 'postgres') return null
    try {
      const row = this.db
        .prepare('SELECT last_aggregated_at FROM usage_dashboard_aggregation_watermark WHERE id = 1')
        .get()
      const raw = String(row?.last_aggregated_at || '').trim()
      if (!raw) return null
      const wmMs = Date.parse(raw)
      if (!Number.isFinite(wmMs)) return null
      return {
        lastAggregatedAt: raw,
        wmMs,
        sealedHourMs: Math.floor(wmMs / HOUR_MS) * HOUR_MS,
      }
    } catch {
      return null
    }
  }

  /** Split a whole-hour range `[startMs, endMs)` into full UTC days plus edge UTC hours. */
  _splitDailyAndHourlyRanges(startMs, endMs) {
    const fullDayStartMs = Math.ceil(startMs / DAY_MS) * DAY_MS
    const fullDayEndMs = Math.floor(endMs / DAY_MS) * DAY_MS
    const daily =
      fullDayEndMs > fullDayStartMs
        ? { startDate: isoDateUtc(fullDayStartMs), endDate: isoDateUtc(fullDayEndMs) }
        : null
    const hourly = []
    if (daily) {
      if (startMs < fullDayStartMs) hourly.push([startMs, fullDayStartMs])
      if (fullDayEndMs < endMs) hourly.push([fullDayEndMs, endMs])
    } else if (startMs < endMs) {
      hourly.push([startMs, endMs])
    }
    return { daily, hourly }
  }

  _totalsTailRow(startMs, endMs) {
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
             COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
             COUNT(duration_ms) AS duration_count,
             COALESCE(SUM(first_token_ms), 0) AS total_ttft_ms,
             COUNT(first_token_ms) AS ttft_count
      FROM usage_logs
      WHERE created_at >= ? AND created_at < ?
    `)
      .get(new Date(startMs).toISOString(), new Date(endMs).toISOString())
  }

  _totalsFromPreAgg(sinceMs, untilMs, wm) {
    if (!wm || this.db?.engine !== 'postgres') return null
    const preStartMs = Math.ceil(sinceMs / HOUR_MS) * HOUR_MS
    const preEndMs = Math.min(Math.floor(untilMs / HOUR_MS) * HOUR_MS, wm.sealedHourMs)
    if (preEndMs <= preStartMs) return null

    try {
      const { daily, hourly } = this._splitDailyAndHourlyRanges(preStartMs, preEndMs)
      const acc = {
        requests: 0,
        errors: 0,
        cost: 0,
        actual_cost: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cache_creation_5m_tokens: 0,
        cache_creation_1h_tokens: 0,
        prompt_tokens: 0,
        total_duration_ms: 0,
        duration_count: 0,
        total_ttft_ms: 0,
        ttft_count: 0,
      }
      const addPreAgg = (row) => {
        if (!row) return
        const input = num(row.input_tokens)
        const cacheRead = num(row.cache_read_tokens)
        const cacheCreation = num(row.cache_creation_tokens)
        acc.requests += num(row.total_requests)
        acc.errors += num(row.error_requests)
        acc.cost += num(row.total_cost)
        acc.actual_cost += num(row.actual_cost)
        acc.input_tokens += input
        acc.output_tokens += num(row.output_tokens)
        acc.cache_read_tokens += cacheRead
        acc.cache_creation_tokens += cacheCreation
        acc.prompt_tokens += input + cacheRead + cacheCreation
        acc.total_duration_ms += num(row.total_duration_ms)
        acc.duration_count += num(row.duration_count)
      }
      const addTail = (row) => {
        if (!row) return
        acc.requests += num(row.requests)
        acc.errors += num(row.errors)
        acc.cost += num(row.cost)
        acc.actual_cost += num(row.actual_cost)
        acc.input_tokens += num(row.input_tokens)
        acc.output_tokens += num(row.output_tokens)
        acc.cache_read_tokens += num(row.cache_read_tokens)
        acc.cache_creation_tokens += num(row.cache_creation_tokens)
        acc.cache_creation_5m_tokens += num(row.cache_creation_5m_tokens)
        acc.cache_creation_1h_tokens += num(row.cache_creation_1h_tokens)
        acc.prompt_tokens += num(row.prompt_tokens)
        acc.total_duration_ms += num(row.total_duration_ms)
        acc.duration_count += num(row.duration_count)
        acc.total_ttft_ms += num(row.total_ttft_ms)
        acc.ttft_count += num(row.ttft_count)
      }

      if (daily) {
        addPreAgg(
          this.db
            .prepare(`
            SELECT COALESCE(SUM(total_requests), 0) AS total_requests,
                   COALESCE(SUM(error_requests), 0) AS error_requests,
                   COALESCE(SUM(total_cost), 0) AS total_cost,
                   COALESCE(SUM(actual_cost), 0) AS actual_cost,
                   COALESCE(SUM(input_tokens), 0) AS input_tokens,
                   COALESCE(SUM(output_tokens), 0) AS output_tokens,
                   COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                   COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                   COALESCE(SUM(total_duration_ms), 0) AS total_duration_ms,
                   COALESCE(SUM(duration_count), 0) AS duration_count
            FROM usage_dashboard_daily
            WHERE bucket_date >= ?::date AND bucket_date < ?::date
          `)
            .get(daily.startDate, daily.endDate),
        )
      }

      if (hourly.length) {
        const hourlyStmt = this.db.prepare(`
          SELECT COALESCE(SUM(total_requests), 0) AS total_requests,
                 COALESCE(SUM(error_requests), 0) AS error_requests,
                 COALESCE(SUM(total_cost), 0) AS total_cost,
                 COALESCE(SUM(actual_cost), 0) AS actual_cost,
                 COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens,
                 COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                 COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                 COALESCE(SUM(total_duration_ms), 0) AS total_duration_ms,
                 COALESCE(SUM(duration_count), 0) AS duration_count
          FROM usage_dashboard_hourly
          WHERE bucket_start >= ?::timestamptz AND bucket_start < ?::timestamptz
        `)
        for (const [hStart, hEnd] of hourly) {
          addPreAgg(hourlyStmt.get(new Date(hStart).toISOString(), new Date(hEnd).toISOString()))
        }
      }

      if (sinceMs < preStartMs) {
        addTail(this._totalsTailRow(sinceMs, preStartMs))
      }
      if (preEndMs < untilMs) {
        addTail(this._totalsTailRow(preEndMs, untilMs))
      }

      return {
        requests: acc.requests,
        errors: acc.errors,
        cost: acc.cost,
        actualCost: acc.actual_cost,
        tokens: acc.input_tokens + acc.output_tokens + acc.cache_read_tokens + acc.cache_creation_tokens,
        inputTokens: acc.input_tokens,
        outputTokens: acc.output_tokens,
        cacheReadTokens: acc.cache_read_tokens,
        cacheCreationTokens: acc.cache_creation_tokens,
        cacheCreation5mTokens: acc.cache_creation_5m_tokens,
        cacheCreation1hTokens: acc.cache_creation_1h_tokens,
        cacheHitRate: acc.prompt_tokens > 0 ? Math.min(1, acc.cache_read_tokens / acc.prompt_tokens) : 0,
        avgDurationMs: acc.duration_count > 0 ? Math.round(acc.total_duration_ms / acc.duration_count) : null,
        avgTtftMs: acc.ttft_count > 0 ? Math.round(acc.total_ttft_ms / acc.ttft_count) : null,
      }
    } catch {
      return null
    }
  }

  _modelSeriesFromPreAgg(sinceMs, untilMs, buckets, wm) {
    if (!wm || this.db?.engine !== 'postgres') return null
    if (!isWholeHourAligned(sinceMs) || !buckets.every(isWholeHourAligned)) return null
    const cutoffMs = Math.min(Math.floor(untilMs / HOUR_MS) * HOUR_MS, wm.sealedHourMs)
    if (cutoffMs <= sinceMs) return null

    try {
      const preRows = this.db
        .prepare(`
        SELECT CASE WHEN model = '__unknown__' THEN NULL ELSE model END AS sid,
               to_char(bucket_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS slot,
               total_requests AS requests,
               total_cost AS cost,
               (input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
        FROM usage_dashboard_hourly_models
        WHERE bucket_start >= ?::timestamptz AND bucket_start < ?::timestamptz
      `)
        .all(new Date(sinceMs).toISOString(), new Date(cutoffMs).toISOString())

      if (cutoffMs >= untilMs) return preRows

      const tailRows = this.db
        .prepare(`
        SELECT model AS sid, ${SLOT_SQL} AS slot,
               COUNT(*) AS requests,
               COALESCE(SUM(total_cost), 0) AS cost,
               COALESCE(SUM(${TOKENS_SQL}), 0) AS tokens
        FROM usage_logs
        WHERE created_at >= ? AND created_at < ?
        GROUP BY sid, slot
      `)
        .all(new Date(cutoffMs).toISOString(), new Date(untilMs).toISOString())
      return [...preRows, ...tailRows]
    } catch {
      return null
    }
  }

  _modelLeaderboardFromPreAgg(sinceMs, untilMs, limit, wm) {
    if (!wm || this.db?.engine !== 'postgres') return null
    if (!isWholeHourAligned(sinceMs)) return null
    const cutoffMs = Math.min(Math.floor(untilMs / HOUR_MS) * HOUR_MS, wm.sealedHourMs)
    if (cutoffMs <= sinceMs) return null

    try {
      const preRows = this.db
        .prepare(`
        SELECT CASE WHEN model = '__unknown__' THEN '' ELSE model END AS sid,
               COALESCE(SUM(total_requests), 0) AS requests,
               COALESCE(SUM(error_requests), 0) AS errors,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
               COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
               COALESCE(SUM(total_cost), 0) AS cost,
               COALESCE(SUM(actual_cost), 0) AS actual_cost
        FROM usage_dashboard_hourly_models
        WHERE bucket_start >= ?::timestamptz AND bucket_start < ?::timestamptz
        GROUP BY 1
      `)
        .all(new Date(sinceMs).toISOString(), new Date(cutoffMs).toISOString())

      const tailRows =
        cutoffMs < untilMs
          ? this.db
              .prepare(`
              SELECT COALESCE(model, '') AS sid,
                     COUNT(*) AS requests,
                     COALESCE(SUM(CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END), 0) AS success,
                     COALESCE(SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END), 0) AS errors,
                     COALESCE(SUM(input_tokens), 0) AS input_tokens,
                     COALESCE(SUM(output_tokens), 0) AS output_tokens,
                     COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                     COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                     COALESCE(SUM(cache_creation_5m_tokens), 0) AS cache_creation_5m_tokens,
                     COALESCE(SUM(cache_creation_1h_tokens), 0) AS cache_creation_1h_tokens,
                     COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
                     COALESCE(SUM(total_cost), 0) AS cost,
                     COALESCE(SUM(actual_cost), 0) AS actual_cost,
                     COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
                     COUNT(duration_ms) AS duration_count,
                     COALESCE(SUM(first_token_ms), 0) AS total_ttft_ms,
                     COUNT(first_token_ms) AS ttft_count
              FROM usage_logs
              WHERE created_at >= ? AND created_at < ?
              GROUP BY COALESCE(model, '')
            `)
              .all(new Date(cutoffMs).toISOString(), new Date(untilMs).toISOString())
          : []

      const merged = new Map()
      const ensure = (sid) => {
        let cur = merged.get(sid)
        if (!cur) {
          cur = {
            sid,
            requests: 0,
            success: 0,
            errors: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cache_creation_5m_tokens: 0,
            cache_creation_1h_tokens: 0,
            prompt_tokens: 0,
            cost: 0,
            actual_cost: 0,
            total_duration_ms: 0,
            duration_count: 0,
            total_ttft_ms: 0,
            ttft_count: 0,
          }
          merged.set(sid, cur)
        }
        return cur
      }

      for (const row of preRows) {
        const sid = row.sid == null ? '' : String(row.sid)
        const cur = ensure(sid)
        const reqs = num(row.requests)
        const errs = num(row.errors)
        const input = num(row.input_tokens)
        const cacheRead = num(row.cache_read_tokens)
        const cacheCreation = num(row.cache_creation_tokens)
        cur.requests += reqs
        cur.errors += errs
        cur.success += Math.max(0, reqs - errs)
        cur.input_tokens += input
        cur.output_tokens += num(row.output_tokens)
        cur.cache_read_tokens += cacheRead
        cur.cache_creation_tokens += cacheCreation
        cur.prompt_tokens += input + cacheRead + cacheCreation
        cur.cost += num(row.cost)
        cur.actual_cost += num(row.actual_cost)
      }

      for (const row of tailRows) {
        const sid = row.sid == null ? '' : String(row.sid)
        const cur = ensure(sid)
        cur.requests += num(row.requests)
        cur.success += num(row.success)
        cur.errors += num(row.errors)
        cur.input_tokens += num(row.input_tokens)
        cur.output_tokens += num(row.output_tokens)
        cur.cache_read_tokens += num(row.cache_read_tokens)
        cur.cache_creation_tokens += num(row.cache_creation_tokens)
        cur.cache_creation_5m_tokens += num(row.cache_creation_5m_tokens)
        cur.cache_creation_1h_tokens += num(row.cache_creation_1h_tokens)
        cur.prompt_tokens += num(row.prompt_tokens)
        cur.cost += num(row.cost)
        cur.actual_cost += num(row.actual_cost)
        cur.total_duration_ms += num(row.total_duration_ms)
        cur.duration_count += num(row.duration_count)
        cur.total_ttft_ms += num(row.total_ttft_ms)
        cur.ttft_count += num(row.ttft_count)
      }

      return [...merged.values()]
        .map((cur) => ({
          ...cur,
          avg_duration_ms: cur.duration_count > 0 ? cur.total_duration_ms / cur.duration_count : null,
          avg_ttft_ms: cur.ttft_count > 0 ? cur.total_ttft_ms / cur.ttft_count : null,
        }))
        .sort((a, b) => b.cost - a.cost || b.requests - a.requests || a.sid.localeCompare(b.sid))
        .slice(0, limit)
    } catch {
      return null
    }
  }

  /** Distinct active users in `[since, until)`, using PG `usage_dashboard_*_users` + parameterized tail when ready. */
  activeUsersCount({ since, until } = {}) {
    const sinceMs = typeof since === 'number' ? since : Date.parse(since)
    const untilMs = typeof until === 'number' ? until : Date.parse(until)
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs <= sinceMs) return 0
    const wm = this._readPreAggWatermark()
    if (wm) {
      const preStartMs = Math.ceil(sinceMs / HOUR_MS) * HOUR_MS
      const preEndMs = Math.min(Math.floor(untilMs / HOUR_MS) * HOUR_MS, wm.sealedHourMs)
      if (preEndMs > preStartMs) {
        try {
          const { daily, hourly } = this._splitDailyAndHourlyRanges(preStartMs, preEndMs)
          const unions = []
          const params = []
          if (daily) {
            unions.push(
              'SELECT user_id FROM usage_dashboard_daily_users WHERE bucket_date >= ?::date AND bucket_date < ?::date',
            )
            params.push(daily.startDate, daily.endDate)
          }
          for (const [hStart, hEnd] of hourly) {
            unions.push(
              'SELECT user_id FROM usage_dashboard_hourly_users WHERE bucket_start >= ?::timestamptz AND bucket_start < ?::timestamptz',
            )
            params.push(new Date(hStart).toISOString(), new Date(hEnd).toISOString())
          }
          if (sinceMs < preStartMs) {
            unions.push(
              "SELECT DISTINCT user_id FROM usage_logs WHERE created_at >= ? AND created_at < ? AND user_id IS NOT NULL AND user_id <> ''",
            )
            params.push(new Date(sinceMs).toISOString(), new Date(preStartMs).toISOString())
          }
          if (preEndMs < untilMs) {
            unions.push(
              "SELECT DISTINCT user_id FROM usage_logs WHERE created_at >= ? AND created_at < ? AND user_id IS NOT NULL AND user_id <> ''",
            )
            params.push(new Date(preEndMs).toISOString(), new Date(untilMs).toISOString())
          }
          const row = this.db.prepare(`SELECT COUNT(*) AS c FROM (${unions.join(' UNION ')}) u`).get(...params)
          return num(row?.c)
        } catch {}
      }
    }
    const row = this.db
      .prepare(
        "SELECT COUNT(DISTINCT NULLIF(user_id, '')) AS c FROM usage_logs WHERE created_at >= ? AND created_at < ?",
      )
      .get(new Date(sinceMs).toISOString(), new Date(untilMs).toISOString())
    return num(row?.c)
  }

  _totals(sinceMs, untilMs, ownerUserId, preAggWm = undefined) {
    if (!ownerUserId && this.db?.engine === 'postgres') {
      const wm = preAggWm === undefined ? this._readPreAggWatermark() : preAggWm
      const fast = this._totalsFromPreAgg(sinceMs, untilMs, wm)
      if (fast) return fast
    }
    const { cond, params } = this._scope(sinceMs, untilMs, ownerUserId)
    const row = this.db
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
             AVG(first_token_ms) AS avg_ttft_ms
      FROM usage_logs ${cond}
    `)
      .get(...params)
    const input = num(row.input_tokens)
    const output = num(row.output_tokens)
    const cacheRead = num(row.cache_read_tokens)
    const cacheCreation = num(row.cache_creation_tokens)
    const prompt = num(row.prompt_tokens)
    return {
      requests: num(row.requests),
      errors: num(row.errors),
      cost: num(row.cost),
      actualCost: num(row.actual_cost),
      tokens: input + output + cacheRead + cacheCreation,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      cacheCreation5mTokens: num(row.cache_creation_5m_tokens),
      cacheCreation1hTokens: num(row.cache_creation_1h_tokens),
      cacheHitRate: prompt > 0 ? Math.min(1, cacheRead / prompt) : 0,
      avgDurationMs: avgOrNull(row.avg_duration_ms),
      avgTtftMs: avgOrNull(row.avg_ttft_ms),
    }
  }

  _names(dimension, ids) {
    const real = ids.filter((id) => id !== NONE_ID)
    if (dimension === 'model') return new Map(real.map((id) => [id, id]))
    const names = lookupNames(this.db, {
      userIds: dimension === 'user' ? real : [],
      keyIds: dimension === 'key' ? real : [],
      vmIds: dimension === 'vm' ? real : [],
    })
    return { user: names.users, key: names.keys, vm: names.vms }[dimension]
  }

  _nameOf(names, id) {
    return id === NONE_ID ? NONE_NAME : (names.get(id) ?? id)
  }

  /** Stacked-area series (top 8 by cost + others), window totals, and deltas vs the previous equal window. */
  statistics({ range = 'today', dimension = 'model', tz = 'UTC', owner_user_id = null, now = Date.now() } = {}) {
    const r = normalizeRange(range) || 'today'
    const dim = normalizeDimension(dimension) || 'model'
    const zone = reportTimezone(tz)
    const { since, until, resolution, buckets } = resolveWindow(r, zone, now)
    const col = DIMENSION_COLUMN[dim]
    const extra = dim === 'vm' ? this._ownedVmFilter(owner_user_id) : null
    const preAggWm = !owner_user_id ? this._readPreAggWatermark() : null
    let rows = dim === 'model' && !owner_user_id ? this._modelSeriesFromPreAgg(since, until, buckets, preAggWm) : null
    if (!rows) {
      const { cond, params } = this._scope(since, until, owner_user_id, extra)
      rows = this.db
        .prepare(`
        SELECT ${col} AS sid, ${SLOT_SQL} AS slot,
               COUNT(*) AS requests,
               COALESCE(SUM(total_cost), 0) AS cost,
               COALESCE(SUM(${TOKENS_SQL}), 0) AS tokens
        FROM usage_logs ${cond}
        GROUP BY sid, slot
      `)
        .all(...params)
    }

    const volume = new Map()
    for (const row of rows) {
      const id = row.sid == null || row.sid === '' ? NONE_ID : String(row.sid)
      row.id = id
      const cur = volume.get(id) || { id, cost: 0, requests: 0, tokens: 0 }
      cur.cost += num(row.cost)
      cur.requests += num(row.requests)
      cur.tokens += num(row.tokens)
      volume.set(id, cur)
    }
    const ranked = [...volume.values()].sort(
      (a, b) => b.cost - a.cost || b.requests - a.requests || a.id.localeCompare(b.id),
    )
    const kept = ranked.slice(0, MAX_SERIES)
    const names = this._names(
      dim,
      kept.map((s) => s.id),
    )
    const series = kept.map((s, i) => ({ id: s.id, name: this._nameOf(names, s.id), dataKey: `s${i}` }))
    if (ranked.length > MAX_SERIES) series.push({ id: OTHERS_ID, name: OTHERS_NAME, dataKey: `s${series.length}` })
    const keyOf = new Map(series.map((s) => [s.id, s.dataKey]))
    const othersKey = keyOf.get(OTHERS_ID) || null

    const metricNames = ['cost', 'requests', 'tokens']
    const metrics = {}
    for (const m of metricNames) {
      metrics[m] = buckets.map((t) => {
        const point = { date: new Date(t).toISOString() }
        for (const s of series) point[s.dataKey] = 0
        return point
      })
    }
    const seriesTotals = {}
    for (const s of series) seriesTotals[s.dataKey] = { cost: 0, requests: 0, tokens: 0 }
    for (const row of rows) {
      const dataKey = keyOf.get(row.id) || othersKey
      if (!dataKey) continue
      const idx = bucketIndex(buckets, Date.parse(`${row.slot}:00.000Z`))
      for (const m of metricNames) {
        const v = num(row[m])
        metrics[m][idx][dataKey] += v
        seriesTotals[dataKey][m] += v
      }
    }

    const totals = this._totals(since, until, owner_user_id, preAggWm)
    const prev = this._totals(since - (until - since), since, owner_user_id, preAggWm)
    return {
      range: r,
      resolution,
      dimension: dim,
      tz: zone,
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
      series,
      metrics,
      seriesTotals,
      totals,
      deltas: {
        requests: delta(totals.requests, prev.requests),
        cost: delta(totals.cost, prev.cost),
        tokens: delta(totals.tokens, prev.tokens),
      },
    }
  }

  /** Per-entity totals over the same window, by official cost. */
  leaderboard({
    range = 'today',
    scope = 'model',
    limit = LEADERBOARD_DEFAULT,
    tz = 'UTC',
    owner_user_id = null,
    now = Date.now(),
  } = {}) {
    const r = normalizeRange(range) || 'today'
    const s = normalizeDimension(scope) || 'model'
    const zone = reportTimezone(tz)
    const n = Math.min(LEADERBOARD_MAX, Math.max(1, Math.trunc(Number(limit)) || LEADERBOARD_DEFAULT))
    const { since, until } = resolveWindow(r, zone, now)
    const col = DIMENSION_COLUMN[s]
    const listOwned = s === 'vm' && !!owner_user_id
    const extra = listOwned ? this._ownedVmFilter(owner_user_id) : null
    const preAggWm = s === 'model' && !owner_user_id ? this._readPreAggWatermark() : null
    let rows = preAggWm ? this._modelLeaderboardFromPreAgg(since, until, n, preAggWm) : null
    if (!rows) {
      const { cond, params } = this._scope(since, until, owner_user_id, extra)
      rows = this.db
        .prepare(`
        SELECT COALESCE(${col}, '') AS sid,
               COUNT(*) AS requests,
               COALESCE(SUM(CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END), 0) AS success,
               COALESCE(SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END), 0) AS errors,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
               COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
               COALESCE(SUM(cache_creation_5m_tokens), 0) AS cache_creation_5m_tokens,
               COALESCE(SUM(cache_creation_1h_tokens), 0) AS cache_creation_1h_tokens,
               COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
               COALESCE(SUM(total_cost), 0) AS cost,
               COALESCE(SUM(actual_cost), 0) AS actual_cost,
               AVG(duration_ms) AS avg_duration_ms,
               AVG(first_token_ms) AS avg_ttft_ms
        FROM usage_logs ${cond}
        GROUP BY COALESCE(${col}, '')
        ORDER BY cost DESC, requests DESC
        ${listOwned ? '' : 'LIMIT ?'}
      `)
        .all(...params, ...(listOwned ? [] : [n]))
    }
    const ids = rows.map((row) => (row.sid == null || row.sid === '' ? NONE_ID : String(row.sid)))
    const names = this._names(s, ids)
    let entries = rows.map((row, i) => leaderboardEntry(row, ids[i], this._nameOf(names, ids[i])))
    if (listOwned) {
      const present = new Set(entries.map((entry) => entry.id))
      const owned = this.db
        .prepare('SELECT id, name FROM vms WHERE owner_user_id = ? ORDER BY name, id')
        .all(String(owner_user_id))
      for (const vm of owned) {
        const id = String(vm.id)
        if (!present.has(id)) entries.push(zeroLeaderboardEntry(id, vm.name || id))
      }
      entries.sort(
        (a, b) =>
          b.totalCost - a.totalCost ||
          b.totalRequests - a.totalRequests ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      )
      entries = entries.slice(0, n)
    }
    return { scope: s, range: r, tz: zone, entries }
  }
}
