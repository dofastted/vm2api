import {
  type InfiniteData,
  infiniteQueryOptions,
  queryOptions,
} from '@tanstack/react-query'
import type {
  RequestLogAttemptsPayload,
  RequestLogDetailPayload,
} from '@/types/panel-logs'
import type { RequestLogStats } from '@/types/panel-overview'
import type {
  ActiveSessionsData,
  UsageLogCursor,
  UsageLogFilterOptions,
  UsageLogFilters,
  UsageLogSessionSuggestions,
  UsageLogsBatchResult,
  UsageLogsOverview,
  UsageLogsSummary,
} from '@/types/panel-usage-logs'
import { api } from '@/lib/api'
import { isInFlightLog, logRowKey } from './log-display'
import { usageLogFiltersQuery } from './search'

/** `/request-logs` 链路（错误归集、导出、调试详情）共用前缀。 */
export const LOGS_QUERY_KEY = ['panel', 'request-logs'] as const
/** 滚动日志页全部查询的前缀：屏蔽集或手动刷新时整体失效。 */
export const USAGE_LOGS_QUERY_KEY = ['panel', 'usage-logs'] as const
export const USAGE_LOGS_BATCH_SIZE = 50
const MAX_MERGED_FIRST_PAGE_LOGS = USAGE_LOGS_BATCH_SIZE * 2

export function fetchUsageLogsPage(
  filters: UsageLogFilters,
  pageParam: UsageLogCursor | null
) {
  const qs = usageLogFiltersQuery(filters)
  qs.set('limit', String(USAGE_LOGS_BATCH_SIZE))
  if (pageParam) {
    qs.set('cursor_created_at', pageParam.createdAt)
    qs.set('cursor_id', pageParam.id)
  }
  return api<UsageLogsBatchResult>(`/api/panel/usage-logs?${qs}`)
}

/**
 * 将后台静默拉取到的第 1 页（无游标）合并进已缓存的无限列表，避免多页加载后
 * 滚回顶部轮询触发全量历史页级联重拉。
 */
export function mergeFirstUsageLogsPage<TPageParam = UsageLogCursor | null>(
  prev: InfiniteData<UsageLogsBatchResult, TPageParam> | undefined,
  freshFirstPage: UsageLogsBatchResult
): InfiniteData<UsageLogsBatchResult, TPageParam> {
  if (!prev || prev.pages.length <= 1) {
    return {
      pages: [freshFirstPage],
      pageParams: [null as TPageParam],
    }
  }
  // 后端错误类后过滤命中扫描上限返回空首页时，保留已加载页避免反复触发重扫。
  if (freshFirstPage.logs.length === 0 && freshFirstPage.hasMore) {
    return prev
  }
  const prevFirst = prev.pages[0]
  const freshKeys = new Set(
    freshFirstPage.logs.map((row) => logRowKey(row)).filter(Boolean)
  )
  const prevSettledTailKeys = new Set(
    [...prevFirst.logs, ...(prev.pages[1]?.logs ?? [])]
      .filter((row) => !isInFlightLog(row))
      .map((row) => logRowKey(row))
      .filter(Boolean)
  )
  const hadSettledInFirst = prevFirst.logs.some((row) => !isInFlightLog(row))
  const hasOverlap = freshFirstPage.logs.some((row) => {
    const key = logRowKey(row)
    return key !== '' && prevSettledTailKeys.has(key)
  })
  // 新日志超过一整页、首页已与后续缓存页断档时，直接重置为最新首页避免跳行/缺行。
  if (hadSettledInFirst && !hasOverlap) {
    return {
      pages: [freshFirstPage],
      pageParams: [null as TPageParam],
    }
  }
  // 丢弃已不在最新首页中的旧在飞态（防残留），仅桥接被挤出最新 50 条的已终态旧行。
  const bumpedSettled = prevFirst.logs.filter((row) => {
    if (isInFlightLog(row)) return false
    const key = logRowKey(row)
    return !key || !freshKeys.has(key)
  })
  const mergedFirstLogs = [...freshFirstPage.logs, ...bumpedSettled]
  if (mergedFirstLogs.length > MAX_MERGED_FIRST_PAGE_LOGS) {
    return {
      pages: [freshFirstPage],
      pageParams: [null as TPageParam],
    }
  }
  return {
    pages: [
      {
        ...prevFirst,
        logs: mergedFirstLogs,
      },
      ...prev.pages.slice(1),
    ],
    pageParams: prev.pageParams,
  }
}

export function requestLogQueryOptions(id: string, enabled = true) {
  return queryOptions({
    queryKey: ['panel', 'request-log', id] as const,
    queryFn: async () => {
      const item = await api<RequestLogDetailPayload>(
        `/api/panel/request-logs/${encodeURIComponent(id)}`
      )
      const attempts = await api<RequestLogAttemptsPayload>(
        `/api/panel/request-logs/${encodeURIComponent(id)}/attempts`
      ).catch(() => ({ attempts: [] }))
      return { item: item.item || item, attempts: attempts.attempts || [] }
    },
    enabled,
  })
}

export function logStatsQueryOptions(
  since: string,
  refetchInterval?: number,
  bucket: 'hour' | 'day' = 'hour'
) {
  return queryOptions({
    queryKey: ['panel', 'request-logs-stats', bucket, since] as const,
    queryFn: () =>
      api<RequestLogStats>(
        `/api/panel/request-logs/stats?bucket=${bucket}&since=${encodeURIComponent(since)}`
      ),
    ...(refetchInterval
      ? {
          refetchInterval,
          refetchIntervalInBackground: false,
          refetchOnWindowFocus: false,
        }
      : {}),
  })
}

/**
 * 键集游标无限列表。`shouldPoll` 由表格按滚动位置给出：用户往下翻时停止轮询；
 * 仅在单页状态下由 TanStack Query 原生 `refetchInterval` 驱动，已翻多页（`pages.length > 1`）
 * 滚回顶部时由表格只静默拉取第 1 页并原地合并，避免串行重拉全部历史页。
 */
export function usageLogsBatchQueryOptions({
  filters,
  pollMs,
  shouldPoll,
}: {
  filters: UsageLogFilters
  pollMs: number
  shouldPoll: () => boolean
}) {
  return infiniteQueryOptions({
    queryKey: [...USAGE_LOGS_QUERY_KEY, 'batch', filters] as const,
    queryFn: ({ pageParam }) => fetchUsageLogsPage(filters, pageParam),
    initialPageParam: null as UsageLogCursor | null,
    getNextPageParam: (last) =>
      last.hasMore && last.nextCursor ? last.nextCursor : undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => {
      if (!shouldPoll() || query.state.fetchStatus !== 'idle') return false
      const pageCount = query.state.data?.pages.length ?? 0
      return pageCount <= 1 ? pollMs : false
    },
  })
}

/** 筛选统计汇总：与 5s 列表轮询严格解耦，仅在筛选变化或手动刷新时重算。 */
export function usageLogsSummaryQueryOptions(filters: UsageLogFilters) {
  return queryOptions({
    queryKey: [...USAGE_LOGS_QUERY_KEY, 'summary', filters] as const,
    queryFn: () =>
      api<UsageLogsSummary>(
        `/api/panel/usage-logs/summary?${usageLogFiltersQuery(filters)}`
      ),
    refetchInterval: false,
    refetchOnWindowFocus: false,
  })
}

export function usageLogFilterOptionsQueryOptions(enabled = true) {
  return queryOptions({
    queryKey: [...USAGE_LOGS_QUERY_KEY, 'filter-options'] as const,
    queryFn: () =>
      api<UsageLogFilterOptions>('/api/panel/usage-logs/filter-options'),
    staleTime: 5 * 60_000,
    enabled,
  })
}

export function usageLogSessionSuggestionsQueryOptions(q: string) {
  return queryOptions({
    queryKey: [...USAGE_LOGS_QUERY_KEY, 'session-suggestions', q] as const,
    queryFn: () =>
      api<UsageLogSessionSuggestions>(
        `/api/panel/usage-logs/session-suggestions?q=${encodeURIComponent(q)}&limit=20`
      ),
    enabled: q.length >= 2,
    staleTime: 30_000,
  })
}

export function activeSessionsQueryOptions(
  autoRefreshEnabled = true,
  pollMs = 5000
) {
  return queryOptions({
    queryKey: [...USAGE_LOGS_QUERY_KEY, 'active-sessions'] as const,
    queryFn: () =>
      api<ActiveSessionsData>(
        '/api/panel/usage-logs/active-sessions?minutes=5&limit=50'
      ),
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
    refetchInterval: autoRefreshEnabled
      ? (query) => (query.state.fetchStatus === 'idle' ? pollMs : false)
      : false,
  })
}

export function usageLogsOverviewQueryOptions(
  tz: string,
  refetchInterval: number | false = false
) {
  return queryOptions({
    queryKey: [...USAGE_LOGS_QUERY_KEY, 'overview', tz] as const,
    queryFn: () =>
      api<UsageLogsOverview>(
        `/api/panel/usage-logs/overview?tz=${encodeURIComponent(tz)}`
      ),
    refetchIntervalInBackground: false,
    refetchInterval:
      typeof refetchInterval === 'number'
        ? (query) =>
            query.state.fetchStatus === 'idle' ? refetchInterval : false
        : false,
    refetchOnWindowFocus: false,
  })
}
