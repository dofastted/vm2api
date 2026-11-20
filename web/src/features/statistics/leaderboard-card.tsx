import { useQuery } from '@tanstack/react-query'
import type {
  LeaderboardEntry,
  LeaderboardScope,
} from '@/types/panel-statistics'
import { Award, ChevronRight, Medal, Trophy } from 'lucide-react'
import { formatCurrency, formatTokenAmount } from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { ModelVendorIcon } from '@/components/model-vendor-icon'
import { BentoCard } from './bento'
import { leaderboardQueryOptions } from './queries'

type Accent = 'primary' | 'purple' | 'blue'

const BAR_CLASS: Record<Accent, string> = {
  primary: 'bg-primary',
  purple: 'bg-purple-500',
  blue: 'bg-blue-500',
}

const RANKS = [
  {
    icon: Trophy,
    iconColor: 'text-amber-500',
    box: 'bg-amber-500/10 dark:bg-amber-500/20 border-amber-500/20',
  },
  {
    icon: Medal,
    iconColor: 'text-slate-400',
    box: 'bg-slate-400/10 dark:bg-slate-400/20 border-slate-400/20',
  },
  {
    icon: Award,
    iconColor: 'text-orange-600',
    box: 'bg-orange-600/10 dark:bg-orange-600/20 border-orange-600/20',
  },
]

// 后端按 totalCost 降序返回，第 1 名即满格参照，前 3 条就够。
const MAX_ITEMS = 3

function RankBadge({ rank }: { rank: number }) {
  const config = RANKS[rank - 1]
  if (!config) {
    return (
      <div className='flex h-7 w-7 items-center justify-center rounded-md bg-muted/50 text-xs font-medium text-muted-foreground'>
        #{rank}
      </div>
    )
  }
  const Icon = config.icon
  return (
    <div
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md border',
        config.box
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', config.iconColor)} />
    </div>
  )
}

export function EntryName({
  entry,
  scope,
  className,
}: {
  entry: LeaderboardEntry
  scope: LeaderboardScope
  className?: string
}) {
  const label = entry.name || entry.id
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {scope === 'model' ? <ModelVendorIcon modelId={label} /> : null}
      <span className='truncate' title={label}>
        {label}
      </span>
    </span>
  )
}

export function LeaderboardCard({
  title,
  scope,
  tz,
  accentColor = 'primary',
  onViewAll,
  className,
}: {
  title: string
  scope: LeaderboardScope
  tz: string
  accentColor?: Accent
  onViewAll?: () => void
  className?: string
}) {
  const board = useQuery(leaderboardQueryOptions('today', scope, MAX_ITEMS, tz))
  const entries = board.data?.entries ?? []
  const maxCost = Math.max(0, ...entries.map((e) => e.totalCost))

  return (
    <BentoCard className={cn('min-h-[280px]', className)}>
      <div className='mb-3 flex items-center justify-between'>
        <h4 className='text-sm font-semibold'>{title}</h4>
        {onViewAll ? (
          <button
            type='button'
            onClick={onViewAll}
            className='flex cursor-pointer items-center gap-0.5 text-xs font-medium text-primary transition-colors hover:text-primary/80'
          >
            <span>查看排行榜</span>
            <ChevronRight className='h-3 w-3' />
          </button>
        ) : null}
      </div>

      <div className='flex flex-1 flex-col gap-1'>
        {board.isLoading ? (
          Array.from({ length: MAX_ITEMS }).map((_, idx) => (
            <div key={idx} className='flex items-center gap-3 p-2'>
              <div className='h-7 w-7 animate-pulse rounded-md bg-muted/50' />
              <div className='flex-1 space-y-2'>
                <div className='h-3 w-3/4 animate-pulse rounded bg-muted/50' />
                <div className='h-1.5 animate-pulse rounded bg-muted/50' />
              </div>
            </div>
          ))
        ) : board.error && !board.data ? (
          <div className='flex flex-1 items-center justify-center text-sm text-destructive'>
            获取排行榜数据失败
          </div>
        ) : entries.length === 0 ? (
          <div className='flex flex-1 items-center justify-center text-sm text-muted-foreground'>
            今日暂无数据
          </div>
        ) : (
          entries.slice(0, MAX_ITEMS).map((entry, idx) => {
            const pct = maxCost > 0 ? (entry.totalCost / maxCost) * 100 : 0
            return (
              <div
                key={entry.id}
                className='flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-muted/30 dark:hover:bg-white/[0.03]'
              >
                <RankBadge rank={idx + 1} />
                <div className='min-w-0 flex-1'>
                  <div className='mb-1.5 flex items-center justify-between'>
                    <EntryName
                      entry={entry}
                      scope={scope}
                      className='text-sm font-medium'
                    />
                    <span className='ml-2 text-sm font-semibold tabular-nums'>
                      {formatCurrency(entry.totalCost)}
                    </span>
                  </div>
                  <div className='h-1.5 w-full overflow-hidden rounded-full bg-muted/40 dark:bg-white/10'>
                    <div
                      className={cn(
                        'h-full rounded-full transition-all duration-500',
                        BAR_CLASS[accentColor]
                      )}
                      style={{ width: `${Math.min(pct, 100)}%` }}
                    />
                  </div>
                  <div className='mt-1 flex items-center justify-between'>
                    <span className='text-[10px] text-muted-foreground'>
                      {entry.totalRequests.toLocaleString()} 请求
                    </span>
                    <span className='text-[10px] text-muted-foreground'>
                      {formatTokenAmount(entry.totalTokens)} Token
                    </span>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </BentoCard>
  )
}
