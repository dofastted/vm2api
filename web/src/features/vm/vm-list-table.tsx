import {
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import {
  ChevronDown,
  ExternalLink,
  GripVertical,
  RotateCcw,
} from 'lucide-react'
import { fmtNum, fmtUsd } from '@/lib/format'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import {
  fmtHealthPct,
  HEALTH_FG,
  healthSummary,
  SLOT_BG,
} from '@/lib/vm-health'
import {
  fleetGroup,
  poolStatus,
  scheduleStateLabel,
  seatTitle,
  vmCircuitTitle,
  vmCooldown,
  vmCooldownTitle,
  type ScheduleStateLabel,
} from '@/lib/vm-status'
import { vmCostLedger, vmWeekOutcome } from '@/lib/vm-usage'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { StatusMark } from '@/components/status-mark'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import {
  StatusBarOptions,
  useStatusBarShow,
  type StatusBarShow,
} from '@/features/vm/status-bar-options'
import { VmUsageWindowsInline } from '@/features/vm/usage-windows'
import {
  useVmColumnOrder,
  type VmColumnKey,
} from '@/features/vm/use-vm-column-order'
import { VmAccountIdentity } from '@/features/vm/vm-account-identity'
import { VmActionMenu } from '@/features/vm/vm-action-menu'
import { useVmActions } from '@/features/vm/vm-actions-context'
import { VmRowDetail } from '@/features/vm/vm-row-detail'
import { schedulingPriorityTextClass } from '@/features/vm/vm-type-visual'

/** 行内点到这些元素时不切换展开。 */
const ROW_INTERACTIVE =
  'button, a, input, select, textarea, label, [role="switch"], [role="menuitem"], [data-row-stop]'

/** 列的宽度与弹性；顺序由 `useVmColumnOrder` 决定，不写死在这里。 */
const COL_CLS: Record<VmColumnKey | 'actions' | 'open', string> = {
  open: 'w-[36px] shrink-0 pl-1',
  vm: 'min-w-[170px] flex-[1.1]',
  sched: 'min-w-[150px] flex-[0.8]',
  status: 'min-w-[190px] flex-[1.05]',
  usage: 'min-w-[250px] flex-[1.4]',
  cost: 'min-w-[170px] flex-[0.9]',
  actions: 'w-[64px] shrink-0 pr-2',
}

function StatusReason({ vm, tone }: { vm: Vm; tone: StatusTone }) {
  const mark = <StatusMark tone={tone} variant='pill' className='text-xs' />
  const title =
    tone.key === 'circuit'
      ? vmCircuitTitle(vm)
      : vmCooldown(vm)
        ? vmCooldownTitle(vm)
        : null
  if (!title) return mark
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{mark}</span>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}

const SCHED_TEXT: Record<ScheduleStateLabel, string> = {
  开: 'text-[color:var(--status-ok)]',
  受限: 'text-[color:var(--status-warn)]',
  关: 'text-muted-foreground',
  不可调度: 'text-[color:var(--status-bad)]',
}

/** 调度 + 优先级：开关、状态字、P 值（手动带框），第二行写受限 / 不可调度原因。 */
function SchedCell({ vm }: { vm: Vm }) {
  const level = Number(vm.schedule_level)
  const levelOk = Number.isInteger(level) && level >= 1 && level <= 10
  const manual = vm.schedule_level_mode === 'manual'
  const label = scheduleStateLabel(vm)
  const tone = poolStatus(vm)
  const reason =
    label === '受限' || label === '不可调度'
      ? vm.restriction_text || vm.unschedulable_text || tone.text
      : null
  return (
    <div className='min-w-0'>
      <div className='flex items-center gap-2'>
        <SchedulableSwitch {...vmSchedulableProps(vm)} />
        <span className={cn('text-xs font-semibold', SCHED_TEXT[label])}>
          {label}
        </span>
        <span
          className={cn(
            'ml-auto rounded-md bg-muted px-1.5 py-px text-[11px] font-bold tabular-nums',
            levelOk
              ? schedulingPriorityTextClass(level)
              : 'text-muted-foreground',
            levelOk && manual && 'shadow-[inset_0_0_0_1px_currentColor]'
          )}
          title={
            levelOk
              ? `${manual ? '手动' : '自动'}调度优先级，数值越大越优先`
              : '没有调度优先级'
          }
        >
          P{levelOk ? level : '—'}
        </span>
      </div>
      {reason ? (
        <div
          className='mt-1 truncate text-[11px] text-muted-foreground'
          title={reason}
        >
          {reason}
        </div>
      ) : null}
    </div>
  )
}

/** 实时席位占用（预调度席位簿）；Codex 行没有席位。 */
function SeatTag({ vm }: { vm: Vm }) {
  if (vm.seats_max == null) return null
  const used = Number(vm.seats_used) || 0
  const queued = Number(vm.queue_depth) || 0
  if (!used && !queued) return null
  return (
    <span
      className={cn(
        'shrink-0 text-[11px] text-muted-foreground tabular-nums',
        queued > 0 && 'text-[color:var(--status-warn)]'
      )}
      title={seatTitle(vm)}
    >
      席位 {used}/{vm.seats_max}
      {queued ? ` · 排队 ${queued}` : ''}
    </span>
  )
}

function StatusCell({ vm, show }: { vm: Vm; show: StatusBarShow }) {
  const tone = poolStatus(vm)
  const inflight = Number(vm.inflight) || 0
  const health = healthSummary(vm.health_24h)
  const showInflight =
    inflight > 0 &&
    tone.cls !== 'bad' &&
    tone.cls !== 'none' &&
    tone.cls !== 'off'
  return (
    <div className='min-w-0 space-y-1'>
      {show.label ? (
        <div className='flex items-center gap-1.5'>
          <StatusReason vm={vm} tone={tone} />
          {showInflight ? (
            <span
              className='inline-flex size-5 items-center justify-center rounded-full bg-[color:var(--tier-pro-solid)] text-[11px] font-semibold text-[color:var(--tier-pro-solid-fg)] tabular-nums'
              title={`在飞 ${inflight}`}
            >
              {inflight}
            </span>
          ) : null}
          <SeatTag vm={vm} />
        </div>
      ) : null}
      {show.bar ? (
        <div className='min-w-0'>
          <div className='flex items-center gap-2'>
            <div className='flex h-3 w-[104px] shrink-0 gap-px' aria-hidden>
              {health.slots.map((slot, i) => (
                <span
                  key={i}
                  className='h-full flex-1 rounded-[1px]'
                  style={{ backgroundColor: SLOT_BG[slot] }}
                />
              ))}
            </div>
            <span
              className={cn(
                'font-mono text-xs font-bold tabular-nums',
                HEALTH_FG[health.tone]
              )}
              title='近 24h 成功请求 ÷ 总请求'
            >
              {fmtHealthPct(health.pct)}
            </span>
          </div>
          <div className='mt-0.5 font-mono text-[11px] text-muted-foreground tabular-nums'>
            {health.req
              ? `${fmtNum(health.ok)}/${fmtNum(health.req)} 成功`
              : '24h 无请求'}
          </div>
        </div>
      ) : null}
      {show.proxy ? <ProxyChip vm={vm} compact /> : null}
    </div>
  )
}

/** 行内成本：7D 花费、token、每请求成本与总计；拆分在展开区。 */
function CostCell({ vm, accounts }: { vm: Vm; accounts?: UsageAccountRow[] }) {
  const [, d7, total] = vmCostLedger(vm, accounts)
  const week = vmWeekOutcome(vm, accounts)
  const perReq = week.req > 0 && d7.cost ? d7.cost / week.req : null
  return (
    <div className='min-w-0'>
      <div className='flex items-baseline gap-2'>
        <b
          className={cn(
            'font-mono text-[13px] tabular-nums',
            !d7.cost && 'text-[color:var(--text-tertiary)]'
          )}
        >
          {d7.cost ? fmtUsd(d7.cost, 2) : '—'}
        </b>
        <span className='truncate font-mono text-[11px] text-muted-foreground tabular-nums'>
          {d7.tokens ? `${fmtNum(d7.tokens)} tok` : ''}
        </span>
      </div>
      <div className='mt-0.5 truncate font-mono text-[11px] text-muted-foreground tabular-nums'>
        {perReq == null ? '—' : `$${perReq.toFixed(3)}/req`} · 总计{' '}
        {total.cost ? fmtUsd(total.cost, 0) : '—'}
      </div>
    </div>
  )
}

function SlotCell({ vm }: { vm: Vm }) {
  return (
    <div className='min-w-0 space-y-0.5 overflow-hidden'>
      <VmAccountIdentity vm={vm} />
    </div>
  )
}

type CellCtx = {
  vm: Vm
  accounts?: UsageAccountRow[]
  now: number
  statusShow: StatusBarShow
}

const COLUMNS: Record<
  VmColumnKey,
  { label: string; cell: (ctx: CellCtx) => ReactNode }
> = {
  vm: { label: '账号', cell: ({ vm }) => <SlotCell vm={vm} /> },
  sched: {
    label: '调度 · 优先级',
    cell: ({ vm }) => <SchedCell vm={vm} />,
  },
  status: {
    label: '健康 · 24h 请求',
    cell: ({ vm, statusShow }) => <StatusCell vm={vm} show={statusShow} />,
  },
  usage: {
    label: '用量窗口',
    cell: ({ vm, now }) => <VmUsageWindowsInline vm={vm} now={now} />,
  },
  cost: {
    label: '成本 · 7D',
    cell: ({ vm, accounts }) => <CostCell vm={vm} accounts={accounts} />,
  },
}

export function VmTable({
  vms,
  accounts,
}: {
  vms: Vm[]
  accounts?: UsageAccountRow[]
}) {
  const actions = useVmActions()
  const now = useNow()
  const statusBar = useStatusBarShow()
  const columns = useVmColumnOrder()
  const [dragKey, setDragKey] = useState<VmColumnKey | null>(null)
  const [overKey, setOverKey] = useState<VmColumnKey | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const setOpen = (id: string, open: boolean) =>
    setExpanded((prev) => {
      if (prev.has(id) === open) return prev
      const next = new Set(prev)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  const toggle = (id: string) => setOpen(id, !expanded.has(id))
  // 点行任意位置展开；控件、链接和拖选文字不算。
  const onRowClick = (e: MouseEvent<HTMLDivElement>, vm: Vm) => {
    if ((e.target as HTMLElement).closest(ROW_INTERACTIVE)) return
    if (String(window.getSelection?.() ?? '')) return
    toggle(vm.id)
  }
  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, vm: Vm) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      actions.openDetail(vm)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle(vm.id)
    } else if (e.key === 'Escape') {
      setOpen(vm.id, false)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows =
        e.currentTarget.parentElement?.parentElement?.querySelectorAll<HTMLElement>(
          '[data-vm-row]'
        )
      if (!rows) return
      const list = [...rows]
      const i = list.indexOf(e.currentTarget)
      const next = list[i + (e.key === 'ArrowDown' ? 1 : -1)]
      if (next) {
        e.preventDefault()
        next.focus()
      }
    }
  }
  const endDrag = () => {
    setDragKey(null)
    setOverKey(null)
  }
  // 拖动只靠指针；Alt+←/→ 给键盘用户同样的能力。
  const onHeaderKey = (e: KeyboardEvent<HTMLDivElement>, key: VmColumnKey) => {
    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
    const i = columns.order.indexOf(key)
    const target = columns.order[i + (e.key === 'ArrowLeft' ? -1 : 1)]
    if (!target) return
    e.preventDefault()
    columns.move(key, target)
  }
  return (
    <div className='overflow-x-auto rounded-lg border border-border/60'>
      <div className='min-w-[1180px]'>
        <div className='sticky top-0 z-10 flex h-8 items-center border-b bg-muted/30 text-xs font-medium tracking-wide text-muted-foreground'>
          <div className={COL_CLS.open} aria-hidden />
          {columns.order.map((key) => {
            const dragging = dragKey === key
            const target = overKey === key && dragKey && dragKey !== key
            const forward =
              dragKey != null &&
              columns.order.indexOf(dragKey) < columns.order.indexOf(key)
            return (
              <div
                key={key}
                draggable
                tabIndex={0}
                title='拖动调整列顺序（Alt+←/→）'
                className={cn(
                  'group/col flex cursor-grab items-center gap-0.5 px-1.5 py-1 select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:cursor-grabbing',
                  COL_CLS[key],
                  dragging && 'opacity-40',
                  target &&
                    (forward
                      ? 'shadow-[inset_-2px_0_0_0_var(--ring)]'
                      : 'shadow-[inset_2px_0_0_0_var(--ring)]')
                )}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', key)
                  setDragKey(key)
                }}
                onDragOver={(e) => {
                  if (!dragKey) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (overKey !== key) setOverKey(key)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragKey) columns.move(dragKey, key)
                  endDrag()
                }}
                onDragEnd={endDrag}
                onKeyDown={(e) => onHeaderKey(e, key)}
              >
                <GripVertical
                  className='size-3 shrink-0 opacity-0 transition-opacity group-hover/col:opacity-60'
                  aria-hidden
                />
                <span className='truncate'>{COLUMNS[key].label}</span>
                {key === 'status' ? (
                  <StatusBarOptions
                    show={statusBar.show}
                    onToggle={statusBar.toggle}
                  />
                ) : null}
              </div>
            )
          })}
          <div className={cn(COL_CLS.actions, 'flex justify-end')}>
            {columns.isDefault ? null : (
              <Button
                type='button'
                size='icon'
                variant='ghost'
                className='size-6 text-muted-foreground'
                title='恢复默认列顺序'
                aria-label='恢复默认列顺序'
                onClick={columns.reset}
              >
                <RotateCcw className='size-3.5' />
              </Button>
            )}
          </div>
        </div>
        {vms.map((vm) => {
          const group = fleetGroup(vm)
          const muted = group === 'off' || group === 'none'
          const open = expanded.has(vm.id)
          const detailId = `vm-row-detail-${vm.id}`
          const ctx: CellCtx = {
            vm,
            accounts,
            now,
            statusShow: statusBar.show,
          }
          return (
            <div key={vm.id}>
              <div
                data-vm-row
                tabIndex={0}
                aria-label={`${vm.id}，Enter 展开明细，Shift+Enter 打开详情`}
                className={cn(
                  'group flex cursor-pointer items-start border-b border-border/40 py-2 transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                  // 等级色只走行首 2px，不染整行底色：行是密集数字，底色一染就没对比空间了。
                  tierVisual(vm).row || 'hover:bg-accent/40',
                  open && 'bg-accent/30'
                )}
                onClick={(e) => onRowClick(e, vm)}
                onKeyDown={(e) => onRowKey(e, vm)}
              >
                <div className={cn(COL_CLS.open, 'flex items-start pt-0.5')}>
                  <Button
                    type='button'
                    size='icon'
                    variant='ghost'
                    className='size-7 text-muted-foreground group-hover:text-foreground'
                    title='打开详情页（Shift+Enter）'
                    aria-label={`打开 ${vm.id} 详情页`}
                    onClick={() => actions.openDetail(vm)}
                  >
                    <ExternalLink className='size-4' />
                  </Button>
                </div>
                {columns.order.map((key) => (
                  <div
                    key={key}
                    className={cn(
                      'px-1.5',
                      COL_CLS[key],
                      muted && 'opacity-60'
                    )}
                  >
                    {COLUMNS[key].cell(ctx)}
                  </div>
                ))}
                <div
                  className={cn(
                    COL_CLS.actions,
                    'flex items-start justify-end gap-0.5'
                  )}
                >
                  <Button
                    type='button'
                    size='icon'
                    variant='ghost'
                    className='size-7 text-muted-foreground'
                    aria-expanded={open}
                    aria-controls={detailId}
                    aria-label={`${open ? '收起' : '展开'} ${vm.id} 明细`}
                    onClick={() => toggle(vm.id)}
                  >
                    <ChevronDown
                      className={cn(
                        'size-4 transition-transform duration-150 motion-reduce:transition-none',
                        open && 'rotate-180'
                      )}
                    />
                  </Button>
                  <VmActionMenu vm={vm} />
                </div>
              </div>
              {open ? (
                <VmRowDetail
                  id={detailId}
                  vm={vm}
                  accounts={accounts}
                  now={now}
                  onOpenDetail={() => actions.openDetail(vm)}
                />
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
