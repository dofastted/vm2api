import type { WindowEstimate } from '@/types/panel-pricing'
import type { VmUsageStatsDay, VmWindowProjection } from '@/types/panel-vm'
import { ESTIMATE_STATUS_ZH } from '@/lib/vm-usage'

const DAY_MS = 86_400_000

/** 上海时区当天 `YYYY-MM-DD`，与后端 `+8 hours` 分桶同一天界。 */
export function shanghaiDay(now: number): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10)
}

export type StatsDayPoint = VmUsageStatsDay & {
  /** `MM-DD`，图表横轴。 */
  label: string
  /** 当天平均响应；没有带耗时的请求时为 null。 */
  avg_ms: number | null
}

export type VmStatsSummary = {
  days: number
  activeDays: number
  cost: number
  requests: number
  errors: number
  tokens: number
  avgDailyCost: number
  avgDailyRequests: number
  avgDailyTokens: number
  avgMs: number | null
  today: StatsDayPoint
  highestCost: StatsDayPoint | null
  highestRequests: StatsDayPoint | null
}

/**
 * 把后端的稀疏日桶补成连续 N 天。日均只按「有请求的天」算，
 * 与 sub2api 的 `actual_days_used` 同一口径——空闲天不稀释均值。
 */
export function summarizeUsageStats(
  stats: { days: number; history: VmUsageStatsDay[] } | null | undefined,
  now = Date.now()
): { points: StatsDayPoint[]; summary: VmStatsSummary } | null {
  if (!stats) return null
  const byDay = new Map(stats.history.map((row) => [row.day, row]))
  const end = Date.parse(`${shanghaiDay(now)}T00:00:00Z`)
  const points: StatsDayPoint[] = []
  for (let i = stats.days - 1; i >= 0; i -= 1) {
    const day = new Date(end - i * DAY_MS).toISOString().slice(0, 10)
    const row = byDay.get(day) ?? {
      day,
      requests: 0,
      errors: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost: 0,
      duration_ms_sum: 0,
      duration_n: 0,
    }
    points.push({
      ...row,
      label: day.slice(5),
      avg_ms: row.duration_n > 0 ? row.duration_ms_sum / row.duration_n : null,
    })
  }
  const active = points.filter((p) => p.requests > 0)
  const sum = (pick: (p: StatsDayPoint) => number) =>
    points.reduce((n, p) => n + pick(p), 0)
  const durN = sum((p) => p.duration_n)
  const cost = sum((p) => p.total_cost)
  const requests = sum((p) => p.requests)
  const tokens = sum((p) => p.input_tokens + p.output_tokens)
  const div = Math.max(1, active.length)
  const best = (pick: (p: StatsDayPoint) => number) =>
    active.reduce<StatsDayPoint | null>(
      (top, p) => (top == null || pick(p) > pick(top) ? p : top),
      null
    )
  return {
    points,
    summary: {
      days: stats.days,
      activeDays: active.length,
      cost,
      requests,
      errors: sum((p) => p.errors),
      tokens,
      avgDailyCost: cost / div,
      avgDailyRequests: requests / div,
      avgDailyTokens: tokens / div,
      avgMs: durN > 0 ? sum((p) => p.duration_ms_sum) / durN : null,
      today: points[points.length - 1],
      highestCost: best((p) => p.total_cost),
      highestRequests: best((p) => p.requests),
    },
  }
}

export type ProjectionView = {
  remaining: number | null
  total: number | null
  /** 总额度按哪个窗口推算；算不出时说明原因。 */
  basis: string
}

/** 预计剩余 5H：后端给数时说清推算依据，给不出时把两条路各自为何不通讲明白。 */
export function projectionView(
  p: VmWindowProjection | null | undefined,
  live: WindowEstimate | null | undefined,
  hasPrev: boolean
): ProjectionView {
  if (p?.source && p.remaining_usd != null) {
    return {
      remaining: p.remaining_usd,
      total: p.total_usd,
      basis:
        p.source === 'current'
          ? '按本窗口用量推算'
          : '本窗口用量太少，按上个窗口容量推算',
    }
  }
  const why = live ? ESTIMATE_STATUS_ZH[live.status] : '本窗口暂无估算'
  return {
    remaining: null,
    total: null,
    basis: `${why}；${hasPrev ? '上个窗口数据不足以推算' : '上个窗口暂无记录'}`,
  }
}
