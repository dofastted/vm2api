import { useQuery } from '@tanstack/react-query'
import type { ApiKeyItem } from '@/types/panel-keys'
import type { Vm, VmUsageStatsRank } from '@/types/panel-vm'
import {
  Boxes,
  Calculator,
  ClipboardList,
  Clock,
  Coins,
  Flame,
  Gauge,
  TrendingUp,
  Zap,
} from 'lucide-react'
import { fmtMs, fmtNum, fmtUsd } from '@/lib/format'
import { cacheHitPct } from '@/lib/vm-usage'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { keyStatsQueryOptions } from '@/features/keys/queries'
import {
  ChartCard,
  DistributionChart,
  EndpointBars,
  fmtTokens,
  InfoCard,
  MetricCard,
  TrendChart,
} from '@/features/vm/vm-stats-dialog'
import { summarizeUsageStats } from '@/features/vm/vm-stats-model'

/** 一把密钥近 30 天的用量。版式跟虚拟机「查看统计」相同，数据只含这把 key。 */
export function KeyStatsDialog({
  item,
  vms,
  onOpenChange,
}: {
  item: ApiKeyItem | null
  vms: Vm[]
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={item != null} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[92vh] flex-col gap-3 sm:max-w-4xl'>
        <DialogHeader>
          <DialogTitle className='text-base'>
            查看统计
            {item ? (
              <span className='ms-2 font-normal'>{item.name || item.id}</span>
            ) : null}
          </DialogTitle>
          <DialogDescription className='sr-only'>
            近 30 天该密钥的用量、费用与分布
          </DialogDescription>
        </DialogHeader>
        <div className='-me-3 min-h-0 flex-1 overflow-y-auto pe-3'>
          {item ? <StatsBody key={item.id} item={item} vms={vms} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StatsBody({ item, vms }: { item: ApiKeyItem; vms: Vm[] }) {
  const q = useQuery(keyStatsQueryOptions(item.id))
  const usage = q.data?.usage_stats ?? null
  const view = summarizeUsageStats(usage)
  const today = view?.summary.today
  const names = new Map(vms.map((vm) => [vm.id, vm.name || vm.email || vm.id]))
  const vmRows: VmUsageStatsRank[] = (usage?.vms ?? []).map((row) => ({
    ...row,
    name: names.get(row.name) || row.name,
  }))

  return (
    <div className='space-y-3 pb-1'>
      <div className='text-xs text-muted-foreground'>
        {item.group_type === 'anthropic'
          ? 'Anthropic'
          : item.group_type === 'openai'
            ? 'OpenAI'
            : item.group_type === 'gemini'
              ? 'Gemini'
              : '全局'}
        {' · '}近 {usage?.days ?? 30} 天 · 官方价
      </div>
      {q.isLoading ? (
        <div className='space-y-3'>
          <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className='h-24 rounded-xl' />
            ))}
          </div>
          <Skeleton className='h-64 rounded-xl' />
        </div>
      ) : q.isError && !view ? (
        <div className='grid h-40 place-items-center rounded-xl border text-sm text-destructive'>
          密钥统计加载失败
        </div>
      ) : !view ? (
        <div className='grid h-40 place-items-center rounded-xl border text-sm text-muted-foreground'>
          暂无统计数据
        </div>
      ) : (
        <>
          <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
            <MetricCard
              accent='emerald'
              icon={<Coins />}
              label={`${view.summary.days} 天费用`}
              value={fmtUsd(view.summary.cost, 2)}
              hint='该密钥'
            />
            <MetricCard
              accent='blue'
              icon={<Zap />}
              label={`${view.summary.days} 天请求`}
              value={fmtNum(view.summary.requests)}
              hint={
                view.summary.requests === 0
                  ? '此期间无请求'
                  : view.summary.errors > 0
                    ? `含 ${fmtNum(view.summary.errors)} 次失败`
                    : '全部成功'
              }
            />
            <MetricCard
              accent='amber'
              icon={<Calculator />}
              label='日均费用'
              value={fmtUsd(view.summary.avgDailyCost, 2)}
              hint={`按 ${view.summary.activeDays} 个活跃天`}
            />
            <MetricCard
              accent='purple'
              icon={<TrendingUp />}
              label='日均请求'
              value={fmtNum(Math.round(view.summary.avgDailyRequests))}
              hint='活跃天平均'
            />
          </div>
          <div className='grid gap-3 lg:grid-cols-3'>
            <InfoCard
              tone='bg-cyan-500/15 text-cyan-600 dark:text-cyan-400'
              icon={<Clock />}
              title='今日概览'
              rows={[
                { label: '费用', value: fmtUsd(today?.total_cost ?? 0, 2) },
                { label: '请求', value: fmtNum(today?.requests ?? 0) },
                {
                  label: 'Tokens',
                  value: fmtTokens(
                    (today?.input_tokens ?? 0) + (today?.output_tokens ?? 0)
                  ),
                },
                {
                  label: '缓存命中',
                  value: fmtCache(today),
                },
              ]}
            />
            <InfoCard
              tone='bg-orange-500/15 text-orange-600 dark:text-orange-400'
              icon={<Flame />}
              title='花费最高的一天'
              rows={[
                { label: '日期', value: view.summary.highestCost?.day ?? '-' },
                {
                  label: '费用',
                  value: fmtUsd(view.summary.highestCost?.total_cost ?? 0, 2),
                  strong: 'text-orange-600 dark:text-orange-400',
                },
                {
                  label: '请求',
                  value: fmtNum(view.summary.highestCost?.requests ?? 0),
                },
              ]}
            />
            <InfoCard
              tone='bg-indigo-500/15 text-indigo-600 dark:text-indigo-400'
              icon={<TrendingUp />}
              title='请求最多的一天'
              rows={[
                {
                  label: '日期',
                  value: view.summary.highestRequests?.day ?? '-',
                },
                {
                  label: '请求',
                  value: fmtNum(view.summary.highestRequests?.requests ?? 0),
                  strong: 'text-indigo-600 dark:text-indigo-400',
                },
                {
                  label: '费用',
                  value: fmtUsd(
                    view.summary.highestRequests?.total_cost ?? 0,
                    2
                  ),
                },
              ]}
            />
          </div>
          <div className='grid gap-3 lg:grid-cols-3'>
            <InfoCard
              tone='bg-teal-500/15 text-teal-600 dark:text-teal-400'
              icon={<Boxes />}
              title='累计 Tokens'
              rows={[
                { label: '总量', value: fmtTokens(view.summary.tokens) },
                {
                  label: '日均',
                  value: fmtTokens(Math.round(view.summary.avgDailyTokens)),
                },
              ]}
            />
            <InfoCard
              tone='bg-rose-500/15 text-rose-600 dark:text-rose-400'
              icon={<Gauge />}
              title='性能'
              rows={[
                {
                  label: '平均响应',
                  value:
                    view.summary.avgMs == null
                      ? '—'
                      : fmtMs(view.summary.avgMs),
                },
                {
                  label: '活跃天数',
                  value: `${view.summary.activeDays} / ${view.summary.days}`,
                },
              ]}
            />
            <InfoCard
              tone='bg-lime-500/15 text-lime-600 dark:text-lime-400'
              icon={<ClipboardList />}
              title='7 天结果'
              rows={[
                {
                  label: '成功',
                  value: fmtNum(
                    view.points
                      .slice(-7)
                      .reduce((n, p) => n + p.requests - p.errors, 0)
                  ),
                  strong: 'text-[color:var(--status-ok)]',
                },
                {
                  label: '失败',
                  value: fmtNum(
                    view.points.slice(-7).reduce((n, p) => n + p.errors, 0)
                  ),
                  strong: 'text-[color:var(--status-bad)]',
                },
              ]}
            />
          </div>
          <ChartCard
            title='用量趋势'
            meta={`近 ${view.summary.days} 天 · 按上海自然日`}
          >
            <TrendChart points={view.points} />
          </ChartCard>
          <ChartCard title='模型分布' meta='按请求数 · 上游模型'>
            <DistributionChart
              rows={usage?.models ?? []}
              empty='近期没有请求'
            />
          </ChartCard>
          <ChartCard title='VM 分布' meta='按请求数'>
            <EndpointBars rows={vmRows} />
          </ChartCard>
        </>
      )}
    </div>
  )
}

function fmtCache(
  today:
    | {
        input_tokens: number
        cache_read_tokens: number
        cache_creation_tokens: number
      }
    | undefined
): string {
  if (!today) return '—'
  const pct = cacheHitPct(
    today.input_tokens,
    today.cache_read_tokens,
    today.cache_creation_tokens
  )
  if (pct == null) return '—'
  return `${pct.toFixed(pct >= 10 ? 1 : 2)}%`
}
