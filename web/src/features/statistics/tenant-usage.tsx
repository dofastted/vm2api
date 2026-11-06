import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { StatisticsData, StatsRange } from '@/types/panel-statistics'
import type { UsageLogsOverview } from '@/types/panel-usage-logs'
import {
  formatCurrency,
  formatDuration,
  formatTokenAmount,
} from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { BentoCard } from './bento'
import { statisticsQueryOptions, usageOverviewQueryOptions } from './queries'

type HistoryRange = Exclude<StatsRange, 'today'>

const HISTORY_RANGES: { id: HistoryRange; label: string }[] = [
  { id: '7days', label: '7天' },
  { id: '30days', label: '30天' },
  { id: 'thisMonth', label: '本月' },
]

type UsageSnapshot = {
  requests: number
  errors: number
  cost: number
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheCreation5mTokens: number
  cacheCreation1hTokens: number
  cacheReadTokens: number
  cacheHitRate: number
  avgDurationMs: number | null
  avgTtftMs: number | null
}

function hitClass(pct: number) {
  if (pct >= 85) return 'text-green-600 dark:text-green-400'
  if (pct >= 60) return 'text-yellow-600 dark:text-yellow-400'
  return 'text-orange-600 dark:text-orange-400'
}

function ttft(ms: number | null) {
  return ms && ms > 0 ? `${Math.round(ms).toLocaleString()} ms` : '-'
}

function parameterRows(snapshot: UsageSnapshot) {
  const hit = snapshot.cacheHitRate * 100
  return [
    { label: '请求', value: snapshot.requests.toLocaleString() },
    { label: '失败', value: snapshot.errors.toLocaleString() },
    { label: '费用', value: formatCurrency(snapshot.cost) },
    { label: '总 Token', value: formatTokenAmount(snapshot.tokens) },
    { label: '输入', value: formatTokenAmount(snapshot.inputTokens) },
    { label: '输出', value: formatTokenAmount(snapshot.outputTokens) },
    {
      label: '缓存写入',
      value: formatTokenAmount(snapshot.cacheCreationTokens),
    },
    {
      label: '缓存写入 5m',
      value: formatTokenAmount(snapshot.cacheCreation5mTokens),
    },
    {
      label: '缓存写入 1h',
      value: formatTokenAmount(snapshot.cacheCreation1hTokens),
    },
    { label: '缓存读取', value: formatTokenAmount(snapshot.cacheReadTokens) },
    {
      label: '缓存命中率',
      value: `${hit.toFixed(1)}%`,
      className: hitClass(hit),
    },
    { label: '平均响应', value: formatDuration(snapshot.avgDurationMs) },
    { label: '平均 TTFT', value: ttft(snapshot.avgTtftMs) },
  ]
}

function fromOverview(overview: UsageLogsOverview): UsageSnapshot {
  return {
    requests: overview.todayRequests,
    errors: overview.todayErrors,
    cost: overview.todayCost,
    tokens: overview.todayTokens,
    inputTokens: overview.todayInputTokens,
    outputTokens: overview.todayOutputTokens,
    cacheCreationTokens: overview.todayCacheCreationTokens,
    cacheCreation5mTokens: overview.todayCacheCreation5mTokens,
    cacheCreation1hTokens: overview.todayCacheCreation1hTokens,
    cacheReadTokens: overview.todayCacheReadTokens,
    cacheHitRate: overview.todayCacheHitRate,
    avgDurationMs: overview.todayAvgDurationMs,
    avgTtftMs: overview.todayAvgTtftMs,
  }
}

function fromTotals(totals: StatisticsData['totals']): UsageSnapshot {
  return {
    requests: totals.requests,
    errors: totals.errors,
    cost: totals.cost,
    tokens: totals.tokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheCreationTokens: totals.cacheCreationTokens,
    cacheCreation5mTokens: totals.cacheCreation5mTokens,
    cacheCreation1hTokens: totals.cacheCreation1hTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheHitRate: totals.cacheHitRate,
    avgDurationMs: totals.avgDurationMs,
    avgTtftMs: totals.avgTtftMs,
  }
}

function ParameterGrid({ snapshot }: { snapshot: UsageSnapshot }) {
  return (
    <dl className='grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3'>
      {parameterRows(snapshot).map((row) => (
        <div key={row.label} className='min-w-0'>
          <dt className='text-xs text-muted-foreground'>{row.label}</dt>
          <dd
            className={cn(
              'truncate font-mono text-sm font-medium tabular-nums',
              row.className
            )}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function LoadingGrid() {
  return (
    <div className='grid grid-cols-2 gap-3 sm:grid-cols-3'>
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className='h-10' />
      ))}
    </div>
  )
}

/** 租户统计：今日明细，以及 7 天 / 30 天 / 本月的同一组参数。 */
export function TenantUsage({ tz }: { tz: string }) {
  const [history, setHistory] = useState<HistoryRange>('7days')
  const overview = useQuery(usageOverviewQueryOptions(tz))
  const past = useQuery(statisticsQueryOptions(history, 'model', tz))
  const today = overview.data ? fromOverview(overview.data) : null
  const historySnapshot = past.data ? fromTotals(past.data.totals) : null

  return (
    <div className='grid gap-6 lg:grid-cols-2'>
      <BentoCard>
        <div className='mb-3'>
          <h3 className='text-sm font-semibold'>今日用量</h3>
          <p className='text-xs text-muted-foreground'>按浏览器时区的自然日</p>
        </div>
        {today ? (
          <ParameterGrid snapshot={today} />
        ) : overview.isError ? (
          <p className='text-sm text-muted-foreground'>今日用量加载失败</p>
        ) : (
          <LoadingGrid />
        )}
      </BentoCard>
      <BentoCard>
        <div className='mb-3 flex flex-wrap items-start justify-between gap-2'>
          <div>
            <h3 className='text-sm font-semibold'>历史用量</h3>
            <p className='text-xs text-muted-foreground'>
              同一组参数，按所选窗口合计
            </p>
          </div>
          <div className='inline-flex rounded-md border bg-muted/30 p-0.5'>
            {HISTORY_RANGES.map((item) => (
              <button
                key={item.id}
                type='button'
                aria-pressed={history === item.id}
                onClick={() => setHistory(item.id)}
                className={cn(
                  'cursor-pointer rounded px-2 py-1 text-xs font-medium',
                  history === item.id
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        {historySnapshot ? (
          <ParameterGrid snapshot={historySnapshot} />
        ) : past.isError ? (
          <p className='text-sm text-muted-foreground'>历史用量加载失败</p>
        ) : (
          <LoadingGrid />
        )}
      </BentoCard>
    </div>
  )
}
