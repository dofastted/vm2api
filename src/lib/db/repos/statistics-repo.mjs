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
/** Dimensions a tenant may group by; user/vm would expose other tenants or the pool layout. */
export const USER_ROLE_DIMENSIONS = ['key', 'model']

const MAX_SERIES = 8
const OTHERS_ID = '__others__'
const OTHERS_NAME = '其他'
const NONE_ID = '__none__'
const NONE_NAME = '未知'
const HOUR_MS = 3_600_000
const LEADERBOARD_DEFAULT = 20
const LEADERBOARD_MAX = 100

const DIMENSION_COLUMN = { user: 'user_id', key: 'api_key_id', model: 'model', vm: 'vm_id' }

const TOKENS_SQL = TOTAL_TOKENS_SQL

/** created_at (`YYYY-MM-DDTHH:MM:SS.sssZ`) floored to its 15-minute UTC slot. */
const SLOT_SQL =
  "to_char(date_bin(interval '15 minutes', created_at::timestamptz, timestamptz '2000-01-01 00:00:00+00') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI')"

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

export class StatisticsRepo {
  constructor(db = getDb()) {
    this.db = db
  }

  _scope(sinceMs, untilMs, ownerUserId) {
    const where = ['created_at >= $1', 'created_at < $2']
    const params = [new Date(sinceMs).toISOString(), new Date(untilMs).toISOString()]
    const own = ownerPred(ownerUserId, params.length)
    if (own.sql) {
      where.push(own.sql)
      params.push(...own.params)
    }
    return { cond: `WHERE ${where.join(' AND ')}`, params }
  }

  async _totals(sinceMs, untilMs, ownerUserId) {
    const { cond, params } = this._scope(sinceMs, untilMs, ownerUserId)
    const row = await this.db
      .prepare(`
      SELECT COUNT(*) AS requests,
             COALESCE(SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END), 0) AS errors,
             COALESCE(SUM(total_cost), 0) AS cost,
             COALESCE(SUM(actual_cost), 0) AS actual_cost,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
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
      cacheHitRate: prompt > 0 ? Math.min(1, cacheRead / prompt) : 0,
      avgDurationMs: avgOrNull(row.avg_duration_ms),
      avgTtftMs: avgOrNull(row.avg_ttft_ms),
    }
  }

  async _names(dimension, ids) {
    const real = ids.filter((id) => id !== NONE_ID)
    if (dimension === 'model') return new Map(real.map((id) => [id, id]))
    const names = await lookupNames(this.db, {
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
  async statistics({ range = 'today', dimension = 'model', tz = 'UTC', owner_user_id = null, now = Date.now() } = {}) {
    const r = normalizeRange(range) || 'today'
    const dim = normalizeDimension(dimension) || 'model'
    const zone = reportTimezone(tz)
    const { since, until, resolution, buckets } = resolveWindow(r, zone, now)
    const col = DIMENSION_COLUMN[dim]
    const { cond, params } = this._scope(since, until, owner_user_id)
    const rows = await this.db
      .prepare(`
      SELECT ${col} AS sid, ${SLOT_SQL} AS slot,
             COUNT(*) AS requests,
             COALESCE(SUM(total_cost), 0) AS cost,
             COALESCE(SUM(${TOKENS_SQL}), 0) AS tokens
      FROM usage_logs ${cond}
      GROUP BY sid, slot
    `)
      .all(...params)

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
    const names = await this._names(
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

    const totals = await this._totals(since, until, owner_user_id)
    const prev = await this._totals(since - (until - since), since, owner_user_id)
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
  async leaderboard({
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
    const { cond, params } = this._scope(since, until, owner_user_id)
    const rows = await this.db
      .prepare(`
      SELECT COALESCE(${col}, '') AS sid,
             COUNT(*) AS requests,
             COALESCE(SUM(CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END), 0) AS success,
             COALESCE(SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END), 0) AS errors,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
             COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
             COALESCE(SUM(total_cost), 0) AS cost,
             COALESCE(SUM(actual_cost), 0) AS actual_cost,
             AVG(duration_ms) AS avg_duration_ms,
             AVG(first_token_ms) AS avg_ttft_ms
      FROM usage_logs ${cond}
      GROUP BY COALESCE(${col}, '')
      ORDER BY cost DESC, requests DESC
      LIMIT $${params.length + 1}
    `)
      .all(...params, n)
    const ids = rows.map((row) => (row.sid == null || row.sid === '' ? NONE_ID : String(row.sid)))
    const names = await this._names(s, ids)
    return {
      scope: s,
      range: r,
      tz: zone,
      entries: rows.map((row, i) => {
        const input = num(row.input_tokens)
        const output = num(row.output_tokens)
        const cacheRead = num(row.cache_read_tokens)
        const cacheCreation = num(row.cache_creation_tokens)
        const requests = num(row.requests)
        const prompt = num(row.prompt_tokens)
        return {
          id: ids[i],
          name: this._nameOf(names, ids[i]),
          totalRequests: requests,
          successRequests: num(row.success),
          errorRequests: num(row.errors),
          successRate: requests > 0 ? num(row.success) / requests : 0,
          totalTokens: input + output + cacheRead + cacheCreation,
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreation,
          cacheHitRate: prompt > 0 ? Math.min(1, cacheRead / prompt) : 0,
          totalCost: num(row.cost),
          totalActualCost: num(row.actual_cost),
          avgDurationMs: avgOrNull(row.avg_duration_ms),
          avgTtftMs: avgOrNull(row.avg_ttft_ms),
        }
      }),
    }
  }
}
