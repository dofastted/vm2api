/**
 * 统计页（`/statistics`）的前后端契约。
 *
 * 形状对齐 claude-code-hub 的 `UserStatisticsData` / `ChartDataItem` 与排行榜，
 * 数据由 vm2api 的 `usage_logs` 聚合（`src/lib/db/repos/statistics-repo.mjs`，
 * 路由 `/api/panel/statistics*`）。所有接口带 `tz`（IANA，浏览器时区），
 * 分桶与「今天 / 本月」边界按该时区计算。
 */

export type StatsRange = 'today' | '7days' | '30days' | 'thisMonth'

export type StatsResolution = 'hour' | 'day'

/** 面积图的一个横轴点。`date` 之外的键是 series 的 `dataKey`。 */
export type ChartDataItem = {
  /** 桶起点的 ISO-8601 瞬时（UTC `Z`）；前端按 tz 格式化。 */
  date: string
  [dataKey: string]: string | number
}

/** 一条序列。`dataKey` 是 ASCII 安全键（`s0`、`s1` …），可直接作对象键 / SVG id。 */
export type StatsSeries = {
  /** 维度实体 id；`__others__` = 前 N 之外的合并项，`__none__` = 维度值为空。 */
  id: string
  name: string
  dataKey: string
}

/** 聚合维度。user 角色允许 `key` / `model` / `vm`（vm 只含本人可用槽）；`user` 回 400。 */
export type StatsDimension = 'user' | 'key' | 'model' | 'vm'

/** 指标页签。三个指标一次性下发，切页签不重新请求。 */
export type StatsMetric = 'cost' | 'requests' | 'tokens'

/** `GET /api/panel/statistics?range=&dimension=&tz=` 的 `data`。 */
export type StatisticsData = {
  range: StatsRange
  resolution: StatsResolution
  dimension: StatsDimension
  tz: string
  /** ISO-8601 窗口边界（`until` 不含）。 */
  since: string
  until: string
  /** 按窗口内 cost 降序，最多 8 个 + 可选 `__others__`。 */
  series: StatsSeries[]
  /** 每个指标一张表，横轴点对齐、缺口补 0。 */
  metrics: Record<StatsMetric, ChartDataItem[]>
  /** 每条序列在窗口内的合计，给图例 / 列表用。 */
  seriesTotals: Record<string, Record<StatsMetric, number>>
  /** 窗口内合计。 */
  totals: {
    requests: number
    errors: number
    cost: number
    actualCost: number
    tokens: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    cacheCreation5mTokens: number
    cacheCreation1hTokens: number
    cacheHitRate: number
    avgDurationMs: number | null
    avgTtftMs: number | null
  }
  /** 与上一等长窗口相比的变化率（-1 ~ +∞），上一窗口为 0 时为 null。 */
  deltas: {
    requests: number | null
    cost: number | null
    tokens: number | null
  }
}

/** 排行榜范围。user 角色允许 `key` / `model` / `vm`（vm 只含本人可用槽）。 */
export type LeaderboardScope = 'user' | 'key' | 'model' | 'vm'

export type LeaderboardEntry = {
  id: string
  name: string
  totalRequests: number
  successRequests: number
  errorRequests: number
  /** 0-1。 */
  successRate: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cacheCreation5mTokens: number
  cacheCreation1hTokens: number
  /** cache_read / (input + cache_read)，0-1。 */
  cacheHitRate: number
  /** 官方标准价。 */
  totalCost: number
  /** 乘过分组倍率后的实收。 */
  totalActualCost: number
  avgDurationMs: number | null
  avgTtftMs: number | null
}

/** `GET /api/panel/statistics/leaderboard?range=&scope=&limit=&tz=` 的 `data`，按 totalCost 降序。 */
export type LeaderboardData = {
  scope: LeaderboardScope
  range: StatsRange
  tz: string
  entries: LeaderboardEntry[]
}
