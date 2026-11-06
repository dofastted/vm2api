import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  StatsDimension,
  StatsMetric,
  StatsRange,
  StatsSeries,
} from '@/types/panel-statistics'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatCurrency, formatTokenAmount } from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { ModelVendorIcon } from '@/components/model-vendor-icon'
import { BentoCard } from './bento'
import { statisticsQueryOptions } from './queries'
import {
  STATS_RANGES,
  formatBucketTick,
  formatBucketTitle,
  seriesColor,
} from './stats-format'

const METRIC_TABS: { id: StatsMetric; label: string }[] = [
  { id: 'cost', label: '总消耗金额' },
  { id: 'requests', label: '总API调用次数' },
  { id: 'tokens', label: '总 Token 数' },
]

const DIMENSION_LABELS: Record<StatsDimension, string> = {
  user: '用户',
  key: '密钥',
  model: '模型',
  vm: '槽位',
}

const CHART_HEIGHT_WITH_LEGEND = 240
const CHART_HEIGHT_NO_LEGEND = 280

function formatMetric(metric: StatsMetric, value: number): string {
  if (metric === 'cost') return formatCurrency(value)
  if (metric === 'tokens') return formatTokenAmount(value)
  return value.toLocaleString()
}

function seriesLabel(series: StatsSeries): string {
  if (series.id === '__others__') return '其他'
  return series.name || series.id
}

function SeriesName({
  series,
  dimension,
  className,
}: {
  series: StatsSeries
  dimension: StatsDimension
  className?: string
}) {
  const label = seriesLabel(series)
  const showIcon = dimension === 'model' && !series.id.startsWith('__')
  return (
    <>
      {showIcon ? <ModelVendorIcon modelId={series.name} /> : null}
      <span className={className} title={label}>
        {label}
      </span>
    </>
  )
}

export function StatisticsChartCard({
  dimensions,
  tz,
  className,
  dimensionLabels,
}: {
  /** 当前角色可用的维度，第一个为默认值。 */
  dimensions: StatsDimension[]
  tz: string
  className?: string
  dimensionLabels?: Partial<Record<StatsDimension, string>>
}) {
  const [range, setRange] = useState<StatsRange>('today')
  const [dimension, setDimension] = useState<StatsDimension>(dimensions[0])
  const [metric, setMetric] = useState<StatsMetric>('cost')
  const [chartMode, setChartMode] = useState<'overlay' | 'stacked'>('overlay')
  // 记被隐藏的序列 id（而非已选）：5s 轮询带来的新序列默认可见，且 id 跨刷新稳定。
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const activeDimension = dimensions.includes(dimension)
    ? dimension
    : dimensions[0]

  const stats = useQuery(statisticsQueryOptions(range, activeDimension, tz))
  const data = stats.data
  const series = useMemo(() => data?.series ?? [], [data])
  const totalsOf = (s: StatsSeries) => data?.seriesTotals[s.dataKey]
  const hasUsage = (s: StatsSeries) => {
    const totals = totalsOf(s)
    return Boolean(
      totals && (totals.cost > 0 || totals.requests > 0 || totals.tokens > 0)
    )
  }

  const enableFilter = series.length > 1
  const visible = enableFilter
    ? series.filter((s) => !hidden.has(s.id))
    : series
  const visibleTotal = (data?.metrics[metric] ?? []).reduce(
    (sum, row) =>
      sum + visible.reduce((acc, s) => acc + (Number(row[s.dataKey]) || 0), 0),
    0
  )
  const tabTotals = Object.fromEntries(
    METRIC_TABS.map((tab) => [
      tab.id,
      visible.reduce((sum, s) => sum + (totalsOf(s)?.[tab.id] ?? 0), 0),
    ])
  ) as Record<StatsMetric, number>
  // overlay 时把总量大的画在最底层，避免小序列被盖住。
  const drawOrder =
    chartMode === 'overlay'
      ? [...visible].sort(
          (a, b) => (totalsOf(b)?.[metric] ?? 0) - (totalsOf(a)?.[metric] ?? 0)
        )
      : visible
  const byDataKey = new Map(series.map((s, index) => [s.dataKey, { s, index }]))

  const changeRange = (next: StatsRange) => {
    setRange(next)
    setHidden(new Set())
  }
  const changeDimension = (next: StatsDimension) => {
    setDimension(next)
    setHidden(new Set())
  }
  const toggleSeries = (id: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        return next
      }
      // 至少保留一条可见；hidden 可能残留已不在当前序列里的 id，按当前序列计数。
      if (series.filter((s) => !next.has(s.id)).length > 1) next.add(id)
      return next
    })
  }
  const keepFirstWithUsage = () => {
    const keep = (series.find(hasUsage) ?? series[0])?.id
    if (keep == null) return
    setHidden(new Set(series.filter((s) => s.id !== keep).map((s) => s.id)))
  }

  const chartWrapperRef = useRef<HTMLDivElement>(null)
  const tooltipScrollRef = useRef<HTMLDivElement>(null)
  // 序列多时 tooltip 会出现滚动条；鼠标停在图上时把滚轮转交给 tooltip。
  useEffect(() => {
    const wrapper = chartWrapperRef.current
    if (!wrapper) return
    const onWheel = (event: WheelEvent) => {
      const box = tooltipScrollRef.current
      if (!box) return
      const max = box.scrollHeight - box.clientHeight
      if (max <= 0) return
      const delta =
        event.deltaMode === 1
          ? event.deltaY * 16
          : event.deltaMode === 2
            ? event.deltaY * 240
            : event.deltaY
      if (!Number.isFinite(delta) || delta === 0) return
      const next = Math.min(max, Math.max(0, box.scrollTop + delta))
      if (next === box.scrollTop) return
      box.scrollTop = next
      event.preventDefault()
    }
    wrapper.addEventListener('wheel', onWheel, { passive: false })
    return () => wrapper.removeEventListener('wheel', onWheel)
  }, [])

  const resolution = data?.resolution ?? 'hour'
  const chartHeight = enableFilter
    ? CHART_HEIGHT_WITH_LEGEND
    : CHART_HEIGHT_NO_LEGEND
  const failed = Boolean(stats.error) && !data
  const allVisible = hidden.size === 0
  const oneVisible = visible.length <= 1

  return (
    <BentoCard
      className={cn(
        'min-h-[300px] overflow-visible p-0 hover:z-20 md:p-1',
        className
      )}
    >
      <div className='flex flex-wrap items-center justify-between border-b border-border/50 dark:border-white/[0.06]'>
        <div className='flex flex-wrap items-center gap-4 px-4 py-2'>
          <h4 className='text-sm font-semibold'>使用统计</h4>
          {dimensions.length > 1 ? (
            <div className='inline-flex rounded-md border bg-muted/30 p-0.5'>
              {dimensions.map((dim) => (
                <ToggleChip
                  key={dim}
                  active={activeDimension === dim}
                  onClick={() => changeDimension(dim)}
                >
                  {dimensionLabels?.[dim] ?? DIMENSION_LABELS[dim]}
                </ToggleChip>
              ))}
            </div>
          ) : null}
          {visible.length > 1 ? (
            <div className='inline-flex rounded-md border bg-muted/30 p-0.5'>
              <ToggleChip
                active={chartMode === 'overlay'}
                onClick={() => setChartMode('overlay')}
              >
                对比
              </ToggleChip>
              <ToggleChip
                active={chartMode === 'stacked'}
                onClick={() => setChartMode('stacked')}
              >
                堆叠
              </ToggleChip>
            </div>
          ) : null}
        </div>
        <div className='flex items-center border-l border-border/50 dark:border-white/[0.06]'>
          {STATS_RANGES.map((option) => (
            <button
              key={option.id}
              type='button'
              data-active={range === option.id}
              aria-pressed={range === option.id}
              onClick={() => changeRange(option.id)}
              className={cn(
                'cursor-pointer px-3 py-1.5 text-xs font-medium transition-colors',
                'border-l border-border/50 first:border-l-0 dark:border-white/[0.06]',
                'hover:bg-muted/50 dark:hover:bg-white/[0.03]',
                'data-[active=true]:bg-primary/10 data-[active=true]:text-primary'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className='flex border-b border-border/50 dark:border-white/[0.06]'>
        {METRIC_TABS.map((tab) => (
          <button
            key={tab.id}
            type='button'
            data-active={metric === tab.id}
            aria-pressed={metric === tab.id}
            onClick={() => setMetric(tab.id)}
            className={cn(
              'flex flex-1 cursor-pointer flex-col items-start gap-0.5 px-4 py-2 transition-colors',
              'border-r border-border/50 last:border-r-0 dark:border-white/[0.06]',
              'hover:bg-muted/30 dark:hover:bg-white/[0.02]',
              'data-[active=true]:bg-muted/50 dark:data-[active=true]:bg-white/[0.04]'
            )}
          >
            <span className='text-[10px] tracking-wide text-muted-foreground uppercase'>
              {tab.label}
            </span>
            <span className='text-base font-bold tabular-nums'>
              {formatMetric(tab.id, tabTotals[tab.id])}
            </span>
          </button>
        ))}
      </div>

      <div ref={chartWrapperRef} className='px-4 py-2'>
        {stats.isLoading && !data ? (
          <Skeleton className='w-full' style={{ height: chartHeight }} />
        ) : failed ? (
          <div
            className='grid place-items-center text-sm text-destructive'
            style={{ height: chartHeight }}
          >
            获取统计数据失败
          </div>
        ) : series.length === 0 || visibleTotal === 0 ? (
          <div
            className='grid place-items-center text-sm text-muted-foreground'
            style={{ height: chartHeight }}
          >
            暂无统计数据
          </div>
        ) : (
          <ResponsiveContainer width='100%' height={chartHeight}>
            <AreaChart
              data={data?.metrics[metric] ?? []}
              margin={{ left: 8, right: 8, top: 8, bottom: 0 }}
            >
              <defs>
                {series.map((s, index) => (
                  <linearGradient
                    key={s.dataKey}
                    id={`fill-stats-${s.dataKey}`}
                    x1='0'
                    y1='0'
                    x2='0'
                    y2='1'
                  >
                    <stop
                      offset='5%'
                      stopColor={seriesColor(index)}
                      stopOpacity={0.8}
                    />
                    <stop
                      offset='95%'
                      stopColor={seriesColor(index)}
                      stopOpacity={0.1}
                    />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid
                vertical={false}
                strokeDasharray='3 3'
                className='stroke-border/30 dark:stroke-white/[0.06]'
              />
              <XAxis
                dataKey='date'
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={(value: string) =>
                  formatBucketTick(value, resolution, tz)
                }
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={56}
                domain={[0, 'dataMax']}
                tickFormatter={(value: number) => formatMetric(metric, value)}
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
              />
              <Tooltip
                cursor={{
                  stroke: 'var(--primary)',
                  strokeWidth: 1,
                  strokeDasharray: '4 4',
                }}
                reverseDirection={{ x: false, y: true }}
                wrapperStyle={{ zIndex: 1000 }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  const rows = payload
                    .map((entry) => ({
                      entry,
                      value: Number(entry.value ?? 0),
                      meta: byDataKey.get(String(entry.dataKey ?? '')),
                    }))
                    .filter(
                      (row) => !Number.isNaN(row.value) && row.value !== 0
                    )
                    .sort((a, b) => b.value - a.value)
                  if (!rows.length) return null
                  return (
                    <div
                      ref={tooltipScrollRef}
                      className='min-w-[180px] overflow-y-auto rounded-lg border bg-background shadow-sm'
                      style={{ maxHeight: 'min(80vh, 720px)' }}
                    >
                      <div className='sticky top-0 z-10 border-b border-border/50 bg-background px-3 py-2 text-center text-xs font-medium'>
                        {formatBucketTitle(String(label ?? ''), resolution, tz)}
                      </div>
                      <div className='space-y-1.5 p-3'>
                        {rows.map(({ entry, value, meta }) => (
                          <div
                            key={String(entry.dataKey)}
                            className='flex items-center justify-between gap-3 text-xs'
                          >
                            <div className='flex min-w-0 items-center gap-2'>
                              <div
                                className='h-2 w-2 flex-shrink-0 rounded-full'
                                style={{ backgroundColor: entry.color }}
                              />
                              {meta ? (
                                <SeriesName
                                  series={meta.s}
                                  dimension={activeDimension}
                                  className='truncate'
                                />
                              ) : (
                                <span className='truncate'>
                                  {String(entry.dataKey)}
                                </span>
                              )}
                            </div>
                            <span className='font-mono font-medium'>
                              {formatMetric(metric, value)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                }}
              />
              {drawOrder.map((s) => {
                const index = byDataKey.get(s.dataKey)?.index ?? 0
                return (
                  <Area
                    key={s.dataKey}
                    dataKey={s.dataKey}
                    name={seriesLabel(s)}
                    type='monotone'
                    fill={`url(#fill-stats-${s.dataKey})`}
                    stroke={seriesColor(index)}
                    strokeWidth={2}
                    stackId={chartMode === 'stacked' ? 'a' : undefined}
                    isAnimationActive={false}
                  />
                )
              })}
            </AreaChart>
          </ResponsiveContainer>
        )}
        {stats.error && data ? (
          <p className='pt-2 text-xs text-destructive'>获取统计数据失败</p>
        ) : null}
      </div>

      {enableFilter ? (
        <div className='relative min-h-[20px] px-4 pb-2'>
          <div className='absolute top-0.5 right-4 z-10 flex w-auto flex-nowrap justify-end gap-x-2 gap-y-0.5'>
            <LegendAction
              disabled={allVisible}
              onClick={() => setHidden(new Set())}
            >
              全选
            </LegendAction>
            <LegendAction disabled={oneVisible} onClick={keepFirstWithUsage}>
              清空
            </LegendAction>
          </div>
          <div className='max-h-[72px] overflow-y-auto pr-36'>
            <div className='flex flex-wrap justify-center gap-1.5'>
              {series.map((s, index) => {
                if (!hasUsage(s)) return null
                const selected = !hidden.has(s.id)
                return (
                  <button
                    key={s.id}
                    type='button'
                    aria-pressed={selected}
                    onClick={() => toggleSeries(s.id)}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-all',
                      selected
                        ? 'bg-muted/50 ring-1 ring-border'
                        : 'bg-muted/10 opacity-50 hover:opacity-75'
                    )}
                  >
                    <div
                      className='h-2 w-2 flex-shrink-0 rounded-full'
                      style={{ backgroundColor: seriesColor(index) }}
                    />
                    <SeriesName
                      series={s}
                      dimension={activeDimension}
                      className='max-w-[80px] truncate font-medium'
                    />
                    <span className='text-muted-foreground'>
                      {formatMetric(metric, totalsOf(s)?.[metric] ?? 0)}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      ) : null}
    </BentoCard>
  )
}

function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type='button'
      data-active={active}
      aria-pressed={active}
      onClick={onClick}
      className='cursor-pointer rounded px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:shadow-sm'
    >
      {children}
    </button>
  )
}

function LegendAction({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type='button'
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'cursor-pointer rounded px-2 py-0.5 text-[10px] whitespace-nowrap transition-colors',
        disabled
          ? 'cursor-not-allowed text-muted-foreground/50'
          : 'text-primary hover:bg-primary/10 hover:text-primary/80'
      )}
    >
      {children}
    </button>
  )
}
