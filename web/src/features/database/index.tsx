import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import { opsSince } from '@/lib/ops-window'
import { PageHeader } from '@/components/page-header'
import { CardGridSkeleton, SectionSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { logStatsQueryOptions } from '@/features/logs/queries'
import { DatabaseOverview } from './database-overview'
import {
  PromptCacheMetricsPanel,
  type PromptCacheWindow,
} from './prompt-cache-metrics'
import {
  DATABASE_METRICS_REFETCH_MS,
  databaseMetricsQueryOptions,
} from './queries'
import { UsageCacheMetricsPanel } from './usage-cache-metrics'

function DatabasePageSkeleton() {
  return (
    <div className='space-y-3'>
      <CardGridSkeleton
        cards={6}
        className='grid-cols-2 sm:grid-cols-3 xl:grid-cols-6'
      />
      <SectionSkeleton rows={4} />
      <SectionSkeleton rows={5} showActions />
    </div>
  )
}

export function DatabasePage() {
  const [window, setWindow] = useState<PromptCacheWindow>('1h')
  const since = useMemo(() => opsSince(window), [window])
  const metrics = useQuery(databaseMetricsQueryOptions())
  const prompt = useQuery(
    logStatsQueryOptions(since, DATABASE_METRICS_REFETCH_MS)
  )

  return (
    <PageHeader title={VIEW_TITLES.database}>
      <QueryGate
        loading={metrics.isLoading}
        error={metrics.error}
        skeleton={<DatabasePageSkeleton />}
      >
        {metrics.data ? (
          <div className='space-y-3'>
            <DatabaseOverview
              metrics={metrics.data.database}
              cache={metrics.data.cache}
              sampledAt={metrics.data.sampled_at}
            />
            <UsageCacheMetricsPanel metrics={metrics.data.usage_cache} />
            <PromptCacheMetricsPanel
              stats={prompt.data}
              loading={prompt.isLoading}
              error={prompt.error}
              window={window}
              onWindowChange={setWindow}
            />
          </div>
        ) : null}
      </QueryGate>
    </PageHeader>
  )
}
