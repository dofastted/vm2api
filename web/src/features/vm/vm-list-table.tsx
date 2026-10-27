import { useState, type KeyboardEvent, type ReactNode } from 'react'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import { GripVertical, RotateCcw } from 'lucide-react'
import { expiresAtToMs, fmtResetClock } from '@/lib/fable-status'
import { fmtNum } from '@/lib/format'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import { isCodexVm, slotNameLabel } from '@/lib/vm-kind'
import {
  credentialStatus,
  fleetGroup,
  poolStatus,
  seatTitle,
  vmCircuitTitle,
  vmCooldown,
  vmCooldownTitle,
} from '@/lib/vm-status'
import { vmTodayStats, vmWeekOutcome, type VmWeekOutcome } from '@/lib/vm-usage'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { CredLaneChip, SlotIdentity } from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import { subscriptionDateText } from '@/features/vm/claude-subscription'
import { NodeChip } from '@/features/vm/node-chip'
import { OpenaiPlanBadge } from '@/features/vm/openai-plan-badge'
import { RuntimeChip } from '@/features/vm/runtime-chip'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import {
  StatusBarOptions,
  useStatusBarShow,
  type StatusBarShow,
} from '@/features/vm/status-bar-options'
import {
  METRIC_ROW,
  VmCostLedger,
  VmUsageWindows,
} from '@/features/vm/usage-windows'
import {
  useVmColumnOrder,
  type VmColumnKey,
} from '@/features/vm/use-vm-column-order'
import { VmActionMenu } from '@/features/vm/vm-action-menu'
import { useVmActions } from '@/features/vm/vm-actions-context'
import { VmOwnerLine } from '@/features/vm/vm-owner-line'

/** 列的宽度与弹性；顺序由 `useVmColumnOrder` 决定，不写死在这里。 */
const COL_CLS: Record<VmColumnKey | 'actions', string> = {
  vm: 'min-w-[170px] flex-[1.15]',
  sched: 'min-w-[62px] flex-[0.3]',
  type: 'min-w-[120px] flex-[0.75]',
  status: 'min-w-[140px] flex-[1.1]',
  req: 'min-w-[124px] flex-[0.7]',
  usage: 'min-w-[208px] flex-[1.3]',
  cost: 'min-w-[212px] flex-[1.1]',
  actions: 'w-[44px] shrink-0 pr-2',
}

type DotTone = 'ok' | 'caution' | 'warn' | 'bad' | 'none'

const DOT_BG: Record<DotTone, string> = {
  ok: 'var(--status-ok-solid)',
  caution: 'var(--status-caution-solid)',
  warn: 'var(--status-warn-solid)',
  bad: 'var(--status-bad-solid)',
  none: 'transparent',
}

const DOT_FG: Record<DotTone, string> = {
  ok: 'text-[color:var(--status-ok)]',
  caution: 'text-[color:var(--status-caution)]',
  warn: 'text-[color:var(--status-warn)]',
  bad: 'text-[color:var(--status-bad)]',
  none: 'text-muted-foreground',
}

function credDot(cls: string): DotTone {
  if (cls === 'ok') return 'ok'
  if (cls === 'caution') return 'caution'
  if (cls === 'warn') return 'warn'
  if (cls === 'bad') return 'bad'
  return 'none'
}

/** 状态条只回答这张票现在能不能用，不把请求成败画成可用性。 */
function healthModel(vm: Vm): { dots: DotTone[]; text: string; tone: DotTone } {
  const cred = credentialStatus(vm)
  const tone = credDot(cred.cls)
  return {
    dots: Array.from({ length: 16 }, () => tone),
    text: cred.text || (tone === 'none' ? '无凭证' : '可用'),
    tone,
  }
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

function PriorityChip({ vm }: { vm: Vm }) {
  const level = Number(vm.schedule_level)
  const valid = Number.isInteger(level) && level >= 0
  const text = valid ? `优先级-${level}` : '优先级-—'
  const mode = vm.schedule_level_mode === 'manual' ? '手动' : '自动'
  const title = `${mode}调度等级`
  return (
    <span
      className='inline-flex rounded border border-border/70 px-1.5 py-0.5 font-mono text-[11px] leading-none font-semibold text-muted-foreground tabular-nums'
      title={title}
    >
      {text}
    </span>
  )
}

/**
 * 类型列：调用形式（console / oauth / api）+ 调度优先级，下一行是周窗口重置时刻。
 * 平台（Claude / GPT）与 pro / max 等级都在「账号」列，不在这里重复。
 */
function TypeCell({ vm, now }: { vm: Vm; now: number }) {
  const hasToken = Boolean(vm.has_token)
  const resetAt = vm.reset_7d || vm.reset_7d_oi
  const clock = hasToken ? fmtResetClock(resetAt) : null
  const resetMs = clock ? expiresAtToMs(resetAt) : 0
  const dueCls =
    resetMs > 0 && resetMs <= now
      ? 'text-[color:var(--status-bad)]'
      : 'text-muted-foreground'
  return (
    <div className='min-w-0 space-y-1'>
      <div className='flex flex-wrap items-center gap-x-1.5 gap-y-1'>
        {hasToken ? (
          <CredLaneChip vm={vm} />
        ) : (
          <span className='text-xs text-muted-foreground'>无凭证</span>
        )}
        <PriorityChip vm={vm} />
      </div>
      {clock ? (
        <div
          className={cn('font-mono text-[11px] tabular-nums', dueCls)}
          title='周窗口重置时刻'
        >
          重置 {clock.slice(0, 11)}
        </div>
      ) : null}
    </div>
  )
}

function CountPill({ tone, n }: { tone: 'ok' | 'bad'; n: number }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-7 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums',
        tone === 'ok'
          ? 'bg-[color:var(--status-ok-bg)] text-[color:var(--status-ok)]'
          : 'bg-[color:var(--status-bad-bg)] text-[color:var(--status-bad)]'
      )}
    >
      {fmtNum(n)}
    </span>
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
  const health = healthModel(vm)
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
        <div className='flex items-center gap-1.5' title={health.text}>
          <div
            className='flex h-1.5 min-w-0 flex-1 gap-px overflow-hidden rounded-full track-recessed'
            aria-hidden
          >
            {health.dots.map((dot, i) => (
              <span
                key={i}
                className='h-full flex-1'
                style={{ backgroundColor: DOT_BG[dot] }}
              />
            ))}
          </div>
          <span
            className={cn(
              'max-w-[6rem] shrink-0 truncate text-xs font-medium',
              DOT_FG[health.tone]
            )}
          >
            {health.text}
          </span>
        </div>
      ) : null}
      {show.proxy ? <ProxyChip vm={vm} compact /> : null}
    </div>
  )
}

/** 只放次数：今日请求与 7D 成功 / 失败。行高与用量窗口、成本账逐行对齐。 */
function RequestCell({
  vm,
  accounts,
  week,
}: {
  vm: Vm
  accounts?: UsageAccountRow[]
  week: VmWeekOutcome
}) {
  const s = vmTodayStats(vm, accounts)
  return (
    <div className='grid min-w-0 gap-1'>
      <div
        className={cn(
          'flex items-center gap-1.5 font-mono text-xs tabular-nums',
          METRIC_ROW
        )}
      >
        <span className='w-7 shrink-0 font-sans text-xs font-medium text-muted-foreground'>
          今日
        </span>
        {s.req > 0 ? (
          <span className='font-medium'>
            {fmtNum(s.req)}
            <span className='font-normal text-muted-foreground'> req</span>
          </span>
        ) : (
          <span className='text-[color:var(--text-tertiary)]'>—</span>
        )}
      </div>
      <div
        className={cn('flex items-center gap-1.5', METRIC_ROW)}
        title='7D 窗口：成功 / 失败'
      >
        <span className='w-7 shrink-0 text-xs font-medium text-muted-foreground'>
          7D
        </span>
        <WeekPills week={week} />
      </div>
    </div>
  )
}

function WeekPills({ week }: { week: VmWeekOutcome }) {
  if (!week.known) {
    return week.req <= 0 ? (
      <>
        <CountPill tone='ok' n={0} />
        <CountPill tone='bad' n={0} />
      </>
    ) : (
      <>
        <CountPill tone='ok' n={week.req} />
        <span className='text-xs text-muted-foreground'>失败 —</span>
      </>
    )
  }
  return (
    <>
      <CountPill tone='ok' n={week.success} />
      <CountPill tone='bad' n={week.fail} />
    </>
  )
}

/** pro / max（GPT 为套餐名）跟着账号走，放在账号名同一行。 */
function TierBadge({ vm }: { vm: Vm }) {
  if (isCodexVm(vm)) return <OpenaiPlanBadge vm={vm} />
  const skin = tierVisual(vm)
  if (
    !vm.claude_subscription?.plan &&
    skin.key !== 'pro' &&
    skin.key !== 'max' &&
    skin.key !== 'unknown'
  ) {
    return null
  }
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-bold tracking-[0.03em] uppercase',
        skin.badge
      )}
    >
      {vm.claude_subscription?.plan || skin.label}
    </span>
  )
}

function SlotCell({ vm }: { vm: Vm }) {
  const name = slotNameLabel(vm)
  const email = String(vm.email || '').trim()
  return (
    <div className='min-w-0 space-y-0.5 overflow-hidden'>
      <SlotIdentity vm={vm} compact className='text-sm font-medium' />
      <div className='flex min-w-0 items-center gap-1.5'>
        <TierBadge vm={vm} />
        <RuntimeChip vm={vm} />
        <NodeChip nodeId={vm.node_id} />
        <span
          className='min-w-0 truncate text-[11px] text-muted-foreground'
          title={email ? name : undefined}
        >
          {name}
        </span>
      </div>
      <VmOwnerLine
        vm={vm}
        className='truncate text-[10.5px] text-muted-foreground'
      />
      {!isCodexVm(vm) ? (
        <div
          className='truncate text-[10.5px] text-muted-foreground'
          title={
            vm.claude_subscription?.last_error
              ? '最近查询失败，显示上次成功查询结果'
              : undefined
          }
        >
          {subscriptionDateText(vm.claude_subscription)}
          {vm.claude_subscription?.last_error ? ' · 待更新' : ''}
        </div>
      ) : null}
    </div>
  )
}

type CellCtx = {
  vm: Vm
  accounts?: UsageAccountRow[]
  now: number
  week: VmWeekOutcome
  statusShow: StatusBarShow
}

const COLUMNS: Record<
  VmColumnKey,
  { label: string; cell: (ctx: CellCtx) => ReactNode }
> = {
  vm: { label: '账号', cell: ({ vm }) => <SlotCell vm={vm} /> },
  sched: {
    label: '调度',
    cell: ({ vm }) => (
      <div onClick={(e) => e.stopPropagation()}>
        <SchedulableSwitch {...vmSchedulableProps(vm)} />
      </div>
    ),
  },
  type: {
    label: '类型',
    cell: ({ vm, now }) => <TypeCell vm={vm} now={now} />,
  },
  status: {
    label: '状态',
    cell: ({ vm, statusShow }) => <StatusCell vm={vm} show={statusShow} />,
  },
  req: {
    label: '今日 / 7D 请求',
    cell: ({ vm, accounts, week }) => (
      <RequestCell vm={vm} accounts={accounts} week={week} />
    ),
  },
  usage: {
    label: '用量窗口',
    cell: ({ vm, now }) => (
      <VmUsageWindows vm={vm} now={now} quiet quotaActions />
    ),
  },
  cost: {
    label: '成本',
    cell: ({ vm, accounts }) => <VmCostLedger vm={vm} accounts={accounts} />,
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
  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, vm: Vm) => {
    if (e.target !== e.currentTarget) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    actions.openDetail(vm)
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
        <div className='sticky top-0 z-10 flex h-8 items-center border-b bg-muted/30 pl-1.5 text-xs font-medium tracking-wide text-muted-foreground'>
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
          const week = vmWeekOutcome(vm, accounts)
          const group = fleetGroup(vm)
          const muted = group === 'off' || group === 'none'
          const ctx: CellCtx = {
            vm,
            accounts,
            now,
            week,
            statusShow: statusBar.show,
          }
          return (
            <div
              key={vm.id}
              role='button'
              tabIndex={0}
              aria-label={`查看 ${vm.id} 详情`}
              className={cn(
                'group flex cursor-pointer items-start border-b border-border/40 py-2 pl-1.5 transition-colors duration-150 last:border-b-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                // 等级色只走行首 2px，不染整行底色：行是密集数字，底色一染就没对比空间了。
                tierVisual(vm).row || 'hover:bg-accent/40',
                muted && 'opacity-60'
              )}
              onClick={() => actions.openDetail(vm)}
              onKeyDown={(e) => onRowKey(e, vm)}
            >
              {columns.order.map((key) => (
                <div key={key} className={cn('px-1.5', COL_CLS[key])}>
                  {COLUMNS[key].cell(ctx)}
                </div>
              ))}
              <div
                className={cn(COL_CLS.actions, 'flex justify-end')}
                onClick={(e) => e.stopPropagation()}
              >
                <VmActionMenu vm={vm} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
