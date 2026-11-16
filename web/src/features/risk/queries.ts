import { queryOptions } from '@tanstack/react-query'
import type {
  DistillRules,
  JevInterceptConfig,
  RefusalGuardConfig,
} from '@/types/panel-routing'
import type {
  UsageLogRow,
  UsageLogsBatchResult,
} from '@/types/panel-usage-logs'
import { api } from '@/lib/api'
import { usageLogFiltersQuery } from '@/features/logs/search'

export type GateRow = {
  by: string
  label: string
  keyword: string
  rule: string
  count: number
}

/** `GET /api/panel/protocol-entry`: today's gate verdicts (Shanghai day). */
export type GateStats = {
  since: string
  /** Every inbound inference request today: the denominator for all shares. */
  total: number
  blocked: number
  passed: number
  keywords: { keyword: string; count: number }[]
  blocks?: GateRow[]
  passes?: GateRow[]
  routes?: {
    kind: 'pool' | 'endpoint' | 'model'
    target: string
    count: number
  }[]
}

const LIVE = { refetchInterval: 30_000, refetchOnWindowFocus: false } as const

export function gateStatsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'protocol-entry'] as const,
    queryFn: () => api<GateStats>('/api/panel/protocol-entry'),
    ...LIVE,
  })
}

export type RiskFeed = { rows: UsageLogRow[]; more: boolean }

export function upstream400QueryOptions(since: string | undefined) {
  return queryOptions({
    queryKey: ['panel', 'risk-upstream-400', since] as const,
    queryFn: async () => {
      const params = new URLSearchParams({
        upstream_400: '1',
        include_muted: '1',
        limit: '100',
      })
      if (since) params.set('start_time', since)
      return api<UsageLogsBatchResult>(`/api/panel/usage-logs?${params}`)
    },
    enabled: !!since,
    ...LIVE,
  })
}

/**
 * Blocked and upstream-refused requests since `since`. Gate blocks log as
 * error class `distill` or `refusal`; the upstream's own refusals share
 * `refusal`, so one feed covers both sides of the audit.
 */
export function riskFeedQueryOptions(since: string | undefined) {
  return queryOptions({
    queryKey: ['panel', 'risk-feed', since] as const,
    queryFn: async (): Promise<RiskFeed> => {
      const pull = (errorClass: string) => {
        const qs = usageLogFiltersQuery({ errorClass, startTime: since })
        qs.set('limit', '100')
        return api<UsageLogsBatchResult>(`/api/panel/usage-logs?${qs}`)
      }
      const [distill, refusal] = await Promise.all([
        pull('distill'),
        pull('refusal'),
      ])
      const rows = [...distill.logs, ...refusal.logs].sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
      )
      return { rows, more: distill.hasMore || refusal.hasMore }
    },
    enabled: !!since,
    ...LIVE,
  })
}

export function distillQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'distill'] as const,
    queryFn: () => api<DistillRules>('/api/panel/distill'),
  })
}

export function refusalGuardsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'refusal-guards'] as const,
    queryFn: () => api<RefusalGuardConfig>('/api/panel/refusal-guards'),
  })
}

export function jevInterceptQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'jev-intercept'] as const,
    queryFn: () => api<JevInterceptConfig>('/api/panel/jev-intercept'),
  })
}
