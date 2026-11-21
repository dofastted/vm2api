import { useMemo } from 'react'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { fmtNum, fmtUsd, usedPctOf } from '@/lib/format'
import { cn } from '@/lib/utils'
import { vmTodayStats, vmWeekOutcome } from '@/lib/vm-usage'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  ZONES,
  zoneOf,
  type VmZone,
  type VmZoneFilter,
} from '@/features/vm/vm-rack-model'

/** 7d 余量直方图的档位。越靠左越危险，和用量条的风险轴同向。 */
const HEADROOM_BUCKETS: { label: string; color: string }[] = [
  { label: '0', color: 'var(--status-bad-solid)' },
  { label: '20', color: 'var(--status-warn-solid)' },
  { label: '40', color: 'var(--status-caution-solid)' },
  { label: '60', color: 'var(--status-ok-solid)' },
  { label: '80', color: 'var(--status-ok-solid)' },
]

type Pulse = {
  total: number
  counts: Record<VmZone, number>
  /** 有票槽位的 7d 余量，按 20% 一档分桶。 */
  headroom: number[]
  headroomMedian: number | null
  todayCost: number
  todayReq: number
  todayTok: number
  weekCost: number
  /** 今日花得最多的槽位，null 表示全队今天都没花钱。 */
  topBurner: { name: string; cost: number } | null
  weekKnown: boolean
  weekSuccess: number
  weekFail: number
}

function computePulse(vms: Vm[], accounts?: UsageAccountRow[]): Pulse {
  const counts: Record<VmZone, number> = {
    pool: 0,
    restricted: 0,
    off: 0,
    none: 0,
    dead: 0,
  }
  const headroom = [0, 0, 0, 0, 0]
  const remains: number[] = []
  let todayCost = 0
  let todayReq = 0
  let todayTok = 0
  let weekCost = 0
  let weekSuccess = 0
  let weekFail = 0
  let weekKnown = false
  let topBurner: { name: string; cost: number } | null = null

  for (const vm of vms) {
    counts[zoneOf(vm)] += 1
    if (vm.gemini) continue
    if (vm.has_token) {
      const remain = Math.max(0, 100 - usedPctOf(vm, '7d'))
      remains.push(remain)
      headroom[Math.min(4, Math.floor(remain / 20))] += 1
    }
    const today = vmTodayStats(vm, accounts)
    todayCost += today.today
    todayReq += today.req
    todayTok += today.tok
    if (today.today > 0 && today.today > (topBurner?.cost ?? 0)) {
      topBurner = { name: vm.name || vm.id, cost: today.today }
    }
    const week = vmWeekOutcome(vm, accounts)
    weekCost += week.cost
    if (week.known) {
      weekKnown = true
      weekSuccess += week.success
      weekFail += week.fail
    }
  }

  remains.sort((a, b) => a - b)
  const mid = remains.length >> 1
  const headroomMedian = !remains.length
    ? null
    : remains.length % 2
      ? remains[mid]
      : (remains[mid - 1] + remains[mid]) / 2

  return {
    total: vms.length,
    counts,
    headroom,
    headroomMedian,
    todayCost,
    todayReq,
    todayTok,
    weekCost,
    topBurner,
    weekKnown,
    weekSuccess,
    weekFail,
  }
}

function Cell({
  title,
  meta,
  className,
  children,
}: {
  title: string
  meta?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-2.5 bg-card p-3.5', className)}
    >
      <div className='flex items-baseline justify-between gap-2'>
        <h3 className='text-[11.5px] font-medium tracking-wide text-muted-foreground'>
          {title}
        </h3>
        {meta}
      </div>
      {children}
    </div>
  )
}

/**
 * 舰队脉搏。列表上方的总览，回答运维打开这一页时的四个问题：
 * 现在有多少能打（分区）· 还剩多少余量（余量分布）· 今天烧了多少（消耗）
 * · 打出去的成了没有（成败）。
 *
 * 分区段同时是筛选入口：宽度给「多不多」，数字给「多少」，点击给「只看这区」。
 * 分区与机架内的分段同一套定义（`ZONES`），吊销并入无效凭证。
 */
export function FleetPulse({
  vms,
  accounts,
  filter,
  onFilter,
  className,
}: {
  /** 已按凭证面（Claude / GPT）筛过、但未经搜索与分组筛选的全集。 */
  vms: Vm[]
  accounts?: UsageAccountRow[]
  filter: VmZoneFilter
  onFilter: (next: VmZoneFilter) => void
  className?: string
}) {
  const pulse = useMemo(() => computePulse(vms, accounts), [vms, accounts])
  const segments = ZONES.filter((z) => pulse.counts[z.key] > 0)
  const focused = filter !== 'all'
  const headroomMax = Math.max(...pulse.headroom, 1)
  const weekTotal = pulse.weekSuccess + pulse.weekFail
  const weekRate = weekTotal > 0 ? (pulse.weekSuccess / weekTotal) * 100 : null

  return (
    <div
      className={cn(
        'grid gap-px overflow-hidden rounded-xl border bg-border/60 sm:grid-cols-2 xl:grid-cols-10',
        className
      )}
    >
      <Cell
        title='状态分区'
        className='sm:col-span-2 xl:col-span-4'
        meta={
          <button
            type='button'
            aria-pressed={filter === 'all'}
            onClick={() => onFilter('all')}
            className={cn(
              'rounded-md px-1.5 py-0.5 text-[12px] leading-none transition-colors hover:bg-accent/60',
              focused ? 'text-muted-foreground' : 'font-medium text-foreground'
            )}
          >
            全部 <span className='tabular-nums'>{pulse.total}</span>
          </button>
        }
      >
        <div
          role='group'
          aria-label='按状态分区筛选'
          className='flex min-h-8 flex-wrap gap-[3px]'
        >
          {segments.map((z) => (
            <Tooltip key={z.key}>
              <TooltipTrigger asChild>
                <button
                  type='button'
                  aria-pressed={filter === z.key}
                  onClick={() => onFilter(filter === z.key ? 'all' : z.key)}
                  className={cn(
                    "flex h-8 min-w-max items-center gap-1.5 overflow-hidden rounded-[7px] px-2.5 text-xs font-semibold whitespace-nowrap before:h-3.5 before:w-[3px] before:shrink-0 before:rounded-[2px] before:bg-[color:var(--zc)] before:content-[''] motion-safe:transition-[flex-grow,opacity] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]",
                    'bg-[color:color-mix(in_oklch,var(--zc)_20%,var(--card))] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--zc)_40%,transparent)]',
                    focused && filter !== z.key && 'opacity-35'
                  )}
                  style={
                    {
                      flexGrow: pulse.counts[z.key],
                      flexBasis: 'auto',
                      '--zc': z.color,
                    } as React.CSSProperties
                  }
                >
                  <span className='tabular-nums'>{pulse.counts[z.key]}</span>
                  <span className='font-medium text-muted-foreground'>
                    {z.label}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent>{z.hint}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </Cell>

      <Cell
        title='7 天窗口余量'
        className='xl:col-span-2'
        meta={
          <span className='text-[13px] leading-none font-[590] tracking-[-0.01em] tabular-nums'>
            {pulse.headroomMedian == null ? (
              <span className='text-muted-foreground'>—</span>
            ) : (
              <>
                {pulse.headroomMedian.toFixed(0)}%
                <span className='text-muted-foreground'> 中位</span>
              </>
            )}
          </span>
        }
      >
        <div className='flex h-[46px] items-end gap-1.5'>
          {HEADROOM_BUCKETS.map((bucket, i) => (
            <Tooltip key={bucket.label}>
              <TooltipTrigger asChild>
                <button
                  type='button'
                  aria-label={`余量 ${bucket.label}–${Number(bucket.label) + 20}% ${pulse.headroom[i]} 台`}
                  className='flex h-full flex-1 cursor-default flex-col justify-end gap-1'
                >
                  <span className='text-center text-[10px] leading-none text-muted-foreground tabular-nums'>
                    {pulse.headroom[i] || ''}
                  </span>
                  <span
                    className='w-full rounded-[3px] motion-safe:transition-[height] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]'
                    style={{
                      height: pulse.headroom[i]
                        ? `${Math.max(8, (pulse.headroom[i] / headroomMax) * 100)}%`
                        : '2px',
                      backgroundColor: pulse.headroom[i]
                        ? bucket.color
                        : 'var(--track)',
                    }}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                余量 {bucket.label}–{Number(bucket.label) + 20}% ·{' '}
                {pulse.headroom[i]} 台
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        <div className='flex justify-between font-mono text-[10px] leading-none text-muted-foreground tabular-nums'>
          {HEADROOM_BUCKETS.map((bucket) => (
            <span key={bucket.label} className='flex-1 text-center'>
              {bucket.label}
            </span>
          ))}
        </div>
      </Cell>

      <Cell
        title='今日消耗 · 北京时间'
        className='xl:col-span-2'
        meta={
          <span className='text-[11px] text-muted-foreground tabular-nums'>
            7 天窗口 {fmtUsd(pulse.weekCost, 2)}
          </span>
        }
      >
        <div className='text-[26px] leading-none font-[590] tracking-[-0.02em] tabular-nums'>
          {fmtUsd(pulse.todayCost, 2)}
        </div>
        <div className='flex flex-col gap-1'>
          <div className='font-mono text-[11px] text-muted-foreground tabular-nums'>
            {fmtNum(pulse.todayReq)} req · {fmtNum(pulse.todayTok)} tok
          </div>
          {pulse.topBurner ? (
            <div className='truncate text-[11px] text-muted-foreground'>
              最高{' '}
              <span className='text-foreground'>{pulse.topBurner.name}</span>{' '}
              <span className='tabular-nums'>
                {fmtUsd(pulse.topBurner.cost, 2)}
              </span>
            </div>
          ) : null}
        </div>
      </Cell>

      <Cell
        title='7 天窗口成败'
        className='sm:col-span-2 xl:col-span-2'
        meta={
          <span className='text-[11px] text-muted-foreground tabular-nums'>
            {weekTotal > 0 ? `${fmtNum(weekTotal)} 次` : ''}
          </span>
        }
      >
        <div
          className={cn(
            'text-[26px] leading-none font-[590] tracking-[-0.02em] tabular-nums',
            weekRate == null
              ? 'text-muted-foreground'
              : weekRate >= 95
                ? 'text-[color:var(--status-ok)]'
                : weekRate >= 80
                  ? 'text-[color:var(--status-caution)]'
                  : 'text-[color:var(--status-bad)]'
          )}
        >
          {weekRate == null ? '—' : `${weekRate.toFixed(1)}%`}
        </div>
        <div className='flex flex-col gap-1.5'>
          <div className='flex h-1.5 w-full gap-px overflow-hidden rounded-full track-recessed'>
            {weekTotal > 0 ? (
              <>
                <span
                  className='h-full motion-safe:transition-[flex-grow] motion-safe:duration-500'
                  style={{
                    flexGrow: pulse.weekSuccess,
                    flexBasis: 0,
                    backgroundColor: 'var(--status-ok-solid)',
                  }}
                />
                {pulse.weekFail > 0 ? (
                  <span
                    className='h-full min-w-[3px]'
                    style={{
                      flexGrow: pulse.weekFail,
                      flexBasis: 0,
                      backgroundColor: 'var(--status-bad-solid)',
                    }}
                  />
                ) : null}
              </>
            ) : null}
          </div>
          <div className='font-mono text-[11px] text-muted-foreground tabular-nums'>
            {pulse.weekKnown
              ? `${fmtNum(pulse.weekSuccess)} 成 · ${fmtNum(pulse.weekFail)} 败`
              : '网关未上报成败'}
          </div>
        </div>
      </Cell>
    </div>
  )
}
