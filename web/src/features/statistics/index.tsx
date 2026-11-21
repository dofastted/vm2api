import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { VIEW_DESCRIPTIONS, VIEW_TITLES } from '@/config/nav'
import type { LeaderboardScope, StatsDimension } from '@/types/panel-statistics'
import { Activity, Clock, DollarSign, TrendingUp } from 'lucide-react'
import { formatCurrency, formatDuration } from '@/lib/usage-format'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import { BentoGrid } from './bento'
import { LeaderboardCard } from './leaderboard-card'
import { LeaderboardSection } from './leaderboard-section'
import { LiveSessionsPanel } from './live-sessions-panel'
import { BentoMetricCard } from './metric-card'
import { usageOverviewQueryOptions } from './queries'
import { StatisticsChartCard } from './statistics-chart-card'
import { browserTimeZone, percentChange } from './stats-format'
import { TenantUsage } from './tenant-usage'

const ADMIN_DIMENSIONS: StatsDimension[] = ['user', 'key', 'model', 'vm']
const USER_DIMENSIONS: StatsDimension[] = ['vm', 'key', 'model']

const ADMIN_CARDS: { scope: LeaderboardScope; title: string }[] = [
  { scope: 'user', title: '用户排行' },
  { scope: 'vm', title: '虚拟机排行' },
  { scope: 'model', title: '模型排行' },
]
const USER_CARDS: { scope: LeaderboardScope; title: string }[] = [
  { scope: 'vm', title: '可用 VM' },
  { scope: 'key', title: '密钥排行' },
  { scope: 'model', title: '模型排行' },
]
const TENANT_SCOPE_LABELS = { vm: '可用 VM' } as const
const CARD_ACCENTS = ['primary', 'purple', 'blue'] as const

export function StatisticsPage() {
  const me = useQuery(meQueryOptions())
  return (
    <PageHeader
      title={VIEW_TITLES.statistics}
      description={VIEW_DESCRIPTIONS.statistics}
    >
      <QueryGate loading={me.isLoading} error={me.error}>
        <StatisticsDashboard isUser={me.data?.role === 'user'} />
      </QueryGate>
    </PageHeader>
  )
}

function StatisticsDashboard({ isUser }: { isUser: boolean }) {
  const [tz] = useState(browserTimeZone)
  const dimensions = isUser ? USER_DIMENSIONS : ADMIN_DIMENSIONS
  const cards = isUser ? USER_CARDS : ADMIN_CARDS
  const boardScopes = cards.map((card) => card.scope)
  const [boardScope, setBoardScope] = useState<LeaderboardScope>(boardScopes[0])
  const boardRef = useRef<HTMLDivElement>(null)
  const overviewQuery = useQuery(usageOverviewQueryOptions(tz))
  const overview = overviewQuery.data

  const openBoard = (scope: LeaderboardScope) => {
    setBoardScope(scope)
    boardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const vsYesterday = (value: number | null) =>
    value == null ? undefined : [{ value, label: '较昨日同期' }]
  const durationChange = percentChange(
    overview?.todayAvgDurationMs,
    overview?.yesterdayAvgDurationMs
  )

  return (
    <div className='space-y-6'>
      <BentoGrid>
        <BentoMetricCard
          title='活跃 Session'
          value={overview ? overview.activeSessions : null}
          formatter={(v) => Math.round(v).toLocaleString()}
          icon={Activity}
          accentColor='emerald'
          className='min-h-[120px]'
          comparisons={
            overview?.rpm == null
              ? undefined
              : [{ value: overview.rpm, label: 'RPM', isPercentage: false }]
          }
        />
        <BentoMetricCard
          title='今日请求'
          value={overview ? overview.todayRequests : null}
          formatter={(v) => Math.round(v).toLocaleString()}
          icon={TrendingUp}
          accentColor='blue'
          className='min-h-[120px]'
          comparisons={vsYesterday(
            percentChange(overview?.todayRequests, overview?.yesterdayRequests)
          )}
        />
        <BentoMetricCard
          title='今日消费 · 官方价'
          value={overview ? overview.todayCost : null}
          formatter={(v) => formatCurrency(v)}
          icon={DollarSign}
          accentColor='amber'
          className='min-h-[120px]'
          comparisons={vsYesterday(
            percentChange(overview?.todayCost, overview?.yesterdayCost)
          )}
        />
        <BentoMetricCard
          title='平均响应时间'
          value={overview?.todayAvgDurationMs ?? null}
          formatter={(v) => formatDuration(Math.round(v))}
          icon={Clock}
          accentColor='purple'
          className='min-h-[120px]'
          // 响应时间变短是好事：保留下降箭头，只把颜色反过来。
          comparisons={vsYesterday(durationChange)}
          invertSentiment
        />
      </BentoGrid>

      {isUser ? <TenantUsage tz={tz} /> : null}

      <StatisticsChartCard
        dimensions={dimensions}
        dimensionLabels={isUser ? TENANT_SCOPE_LABELS : undefined}
        tz={tz}
      />

      <div className='grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_280px]'>
        {cards.map((card, index) => (
          <LeaderboardCard
            key={card.scope}
            title={card.title}
            scope={card.scope}
            tz={tz}
            accentColor={CARD_ACCENTS[index]}
            onViewAll={() => openBoard(card.scope)}
          />
        ))}
        <LiveSessionsPanel className='min-h-[280px]' />
      </div>

      <div ref={boardRef} className='scroll-mt-20'>
        <LeaderboardSection
          scopes={boardScopes}
          tz={tz}
          scope={boardScope}
          onScopeChange={setBoardScope}
          scopeLabels={isUser ? TENANT_SCOPE_LABELS : undefined}
          entryLimit={isUser ? 100 : undefined}
        />
      </div>
    </div>
  )
}
