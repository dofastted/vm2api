import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { Activity, Eye, Radio } from 'lucide-react'
import { usedPctOf } from '@/lib/format'
import { cn } from '@/lib/utils'
import { scheduleStateLabel, seatTitle } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { SeatCells, SeatLegend } from '@/components/scheduler-viz'
import { vmsListQueryOptions } from '@/features/vm/queries'
import { usePoolSeatStream } from '@/features/vm/use-pool-seat-stream'
import { PaneSection } from './scheduler-controls'

type SeatRow = {
  vm: Vm
  used: number
  grace: number
  max: number
  queued: number
  concWaiting: number
  /** 开新席位的预估名次；null = 满了或不在池。 */
  rank: number | null
  why: string | null
}

/** min(5h 闸 − 已用, 7d 闸 − 已用)，与后端 budgetHeadroom 同口径；没有闸配置时视为未知。 */
function headroomOf(vm: Vm): number | null {
  const policy = vm.quota_policy
  if (!policy) return null
  return Math.min(
    policy.limit_5h * 100 - usedPctOf(vm, '5h'),
    policy.limit_7d * 100 - usedPctOf(vm, '7d')
  )
}

/**
 * 按草稿策略复现 rankSeatCandidates 的顺序：调度等级降序 → 占用比例
 * （平衡升序 / 填充降序）→ 余量降序 → id。并发、RPM 和预算闸不在这里判，
 * 所以只是预估。
 */
export function predictSeatOrder(vms: Vm[], strategy: string): SeatRow[] {
  const fill = strategy === 'fill'
  const rows: SeatRow[] = vms
    .filter((vm) => vm.seats_max != null)
    .map((vm) => {
      const used = Number(vm.seats_used) || 0
      const max = Number(vm.seats_max) || 0
      const inPool = scheduleStateLabel(vm) === '开'
      const full = used >= max
      return {
        vm,
        used,
        grace: Number(vm.seats_grace) || 0,
        max,
        queued: Number(vm.queue_depth) || 0,
        concWaiting: Number(vm.conc_waiting) || 0,
        rank: null,
        why: !inPool ? `调度${scheduleStateLabel(vm)}` : full ? '已满' : null,
      }
    })
  const open = rows
    .filter((row) => row.why == null)
    .sort((a, b) => {
      const priority =
        (Number(b.vm.schedule_level) || 0) - (Number(a.vm.schedule_level) || 0)
      if (priority) return priority
      const occ = a.used / a.max - b.used / b.max
      if (occ) return fill ? -occ : occ
      const room =
        (headroomOf(b.vm) ?? Number.POSITIVE_INFINITY) -
        (headroomOf(a.vm) ?? Number.POSITIVE_INFINITY)
      if (room && Number.isFinite(room)) return room
      return a.vm.id.localeCompare(b.vm.id)
    })
  open.forEach((row, i) => {
    row.rank = i + 1
  })
  const rest = rows
    .filter((row) => row.why != null)
    .sort((a, b) => a.vm.id.localeCompare(b.vm.id))
  return [...open, ...rest]
}

function Kpi({
  label,
  value,
  hint,
  tone,
  children,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  tone?: 'warn' | 'bad'
  children?: React.ReactNode
}) {
  return (
    <div className='min-w-0 rounded-lg border bg-background/60 px-3 py-2.5'>
      <div className='text-[11px] text-muted-foreground'>{label}</div>
      <div
        className={cn(
          'mt-0.5 text-xl leading-7 font-semibold tabular-nums',
          tone === 'warn' && 'text-[color:var(--status-warn)]',
          tone === 'bad' && 'text-[color:var(--status-bad)]'
        )}
      >
        {value}
      </div>
      {children}
      {hint ? (
        <div className='mt-1 text-[11px] leading-4 text-muted-foreground'>
          {hint}
        </div>
      ) : null}
    </div>
  )
}

/** 实时态势：席位、排队与「下一席位落点」。数据来自 VM 列表 + 席位 SSE。 */
export function PoolLivePanel({
  strategy,
  queueMax,
}: {
  /** 草稿策略，用来预估开席顺序。 */
  strategy: string
  /** 草稿 queue_max；与运行值不同时提示保存后生效。 */
  queueMax: number
}) {
  const list = useQuery(vmsListQueryOptions(5000))
  usePoolSeatStream()
  const rows = useMemo(
    () => predictSeatOrder(list.data?.items || [], strategy),
    [list.data?.items, strategy]
  )
  const poolQueue = list.data?.pool_queue
  const totals = rows.reduce(
    (acc, row) => ({
      used: acc.used + row.used,
      grace: acc.grace + row.grace,
      max: acc.max + row.max,
      queued: acc.queued + row.queued,
      conc: acc.conc + row.concWaiting,
    }),
    { used: 0, grace: 0, max: 0, queued: 0, conc: 0 }
  )
  const outOfPool = rows.filter((row) => row.why !== null && row.why !== '已满')
  const globalDepth = poolQueue?.global_queue_depth ?? 0
  const runningMax = poolQueue?.queue_max ?? 0
  const queuedAll = totals.queued + globalDepth
  const queueFill = runningMax
    ? Math.min(100, (queuedAll / runningMax) * 100)
    : 0
  const seatFill = totals.max ? (totals.used / totals.max) * 100 : 0
  const [detailsOpen, setDetailsOpen] = useState(false)

  return (
    <PaneSection
      icon={Activity}
      title='实时态势'
      desc='Claude 预调度：一个 client session 在请求进行中占一个席位，对话结束即释放；粘性 TTL 只记住用过的 VM，不占席位。同 session 的并发请求共用席位。席位满了按到达顺序排队。'
      aside={
        <span className='inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground'>
          <Radio
            className='size-3 text-[color:var(--status-ok-solid)] motion-safe:animate-pulse'
            aria-hidden
          />
          实时
        </span>
      }
    >
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs'>
          <span className='font-medium'>
            席位 {totals.used}/{totals.max}
          </span>
          <span
            className={cn(
              totals.queued > 0 && 'text-[color:var(--status-warn)]'
            )}
          >
            排队 {queuedAll}/{runningMax || '—'}
          </span>
          <span className='text-muted-foreground'>
            在池 {rows.length - outOfPool.length}/{rows.length} 台
          </span>
        </div>
        <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
          <DialogTrigger asChild>
            <Button type='button' variant='outline' size='sm'>
              <Eye className='size-4' aria-hidden />
              查看运行详情
            </Button>
          </DialogTrigger>
          <DialogContent className='flex max-h-[90dvh] max-w-5xl flex-col overflow-hidden'>
            <DialogHeader>
              <DialogTitle>实时席位与排队</DialogTitle>
              <DialogDescription>
                这是当前运行态势；页面中的设置草稿只会在全局保存后生效。
              </DialogDescription>
            </DialogHeader>
            <div className='min-h-0 flex-1 space-y-4 overflow-y-auto pr-1'>
              <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                <Kpi
                  label='席位占用'
                  value={
                    <>
                      {totals.used}
                      <span className='text-sm font-normal text-muted-foreground'>
                        /{totals.max}
                      </span>
                    </>
                  }
                  hint={`交接 ${totals.grace} · 在池 ${rows.length - outOfPool.length}/${rows.length} 台`}
                >
                  <div className='mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted'>
                    <div
                      className='h-full rounded-full bg-primary transition-[width] duration-300'
                      style={{ width: `${seatFill}%` }}
                    />
                  </div>
                </Kpi>
                <Kpi
                  label='VM 上排队'
                  value={totals.queued}
                  tone={totals.queued ? 'warn' : undefined}
                  hint={`其中已有席位、只等并发 ${totals.conc}`}
                />
                <Kpi
                  label='全局排队'
                  value={globalDepth}
                  tone={globalDepth ? 'warn' : undefined}
                  hint='还没落到任何 VM、在等新席位的设备'
                />
                <Kpi
                  label='排队总量 / 上限'
                  value={
                    <>
                      {queuedAll}
                      <span className='text-sm font-normal text-muted-foreground'>
                        /{runningMax || '—'}
                      </span>
                    </>
                  }
                  tone={
                    queueFill >= 100
                      ? 'bad'
                      : queueFill >= 80
                        ? 'warn'
                        : undefined
                  }
                  hint={
                    !runningMax
                      ? '运行上限读取中'
                      : runningMax !== queueMax
                        ? `运行上限 ${runningMax} · 保存后改为 ${queueMax}`
                        : '满了新请求直接 529'
                  }
                >
                  <div className='mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted'>
                    <div
                      className={cn(
                        'h-full rounded-full transition-[width] duration-300',
                        queueFill >= 80
                          ? 'bg-[color:var(--status-warn-solid)]'
                          : 'bg-primary'
                      )}
                      style={{ width: `${queueFill}%` }}
                    />
                  </div>
                </Kpi>
              </div>
              <div className='space-y-2'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <div className='text-xs font-medium'>各 VM 席位</div>
                  <SeatLegend />
                </div>
                {list.isError ? (
                  <p className='rounded-lg border border-[color:var(--status-bad)]/40 px-3 py-6 text-center text-xs text-[color:var(--status-bad)]'>
                    运行详情读取失败，请稍后重试。
                  </p>
                ) : rows.length ? (
                  <ul className='grid gap-2 sm:grid-cols-2 xl:grid-cols-3'>
                    {rows.map((row) => (
                      <li key={row.vm.id}>
                        <Link
                          to='/vm/$id'
                          params={{ id: row.vm.id }}
                          title={seatTitle(row.vm)}
                          className={cn(
                            'flex h-full items-center gap-3 rounded-lg border px-3 py-2 hover:border-primary/50 hover:bg-accent/40',
                            row.why && row.why !== '已满' && 'opacity-60'
                          )}
                        >
                          <span className='grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold tabular-nums'>
                            {row.rank ?? '—'}
                          </span>
                          <div className='min-w-0 flex-1 space-y-1'>
                            <div className='flex items-baseline justify-between gap-2'>
                              <span className='truncate text-xs font-medium'>
                                {row.vm.name || row.vm.id}
                              </span>
                              <span className='shrink-0 text-[11px] text-muted-foreground tabular-nums'>
                                {row.why ? `${row.why} · ` : ''}
                                {row.used}/{row.max}
                                {row.queued ? ` · 排队 ${row.queued}` : ''}
                              </span>
                            </div>
                            <SeatCells
                              used={row.used}
                              grace={row.grace}
                              max={row.max}
                              next={row.rank === 1}
                              size='sm'
                            />
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className='rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground'>
                    {list.isLoading ? '读取中…' : '还没有 Claude VM'}
                  </p>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                className='min-h-11'
                onClick={() => setDetailsOpen(false)}
              >
                关闭
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </PaneSection>
  )
}
