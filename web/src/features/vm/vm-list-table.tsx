import { useNavigate } from '@tanstack/react-router'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import { expiresAtToMs, fmtResetClock } from '@/lib/fable-status'
import { fmtNum, fmtUsd, usedPctOf } from '@/lib/format'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import { isCodexVm, slotNameLabel } from '@/lib/vm-kind'
import {
  credentialStatus,
  fleetGroup,
  poolStatus,
  vmCircuit,
  vmCircuitTitle,
  vmCooldown,
  vmCooldownTitle,
} from '@/lib/vm-status'
import {
  vmTodayStats,
  vmWeekOutcome,
  vmWindowCosts,
  type VmWeekOutcome,
} from '@/lib/vm-usage'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { PlatformChip, SlotIdentity } from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import { OpenaiPlanBadge } from '@/features/vm/openai-plan-badge'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import {
  StatusBarOptions,
  useStatusBarShow,
  type StatusBarShow,
} from '@/features/vm/status-bar-options'
import { fableRow, riskFg, UsageMeter } from '@/features/vm/usage-meter'

const LIST_COL = {
  vm: 'min-w-[220px] flex-[1.25] pl-3',
  sched: 'min-w-[52px] flex-[0.35] px-1.5',
  group: 'min-w-[104px] flex-[0.7] px-1.5',
  pri: 'min-w-[92px] flex-[0.55] px-1.5',
  plan: 'min-w-[100px] flex-[0.6] px-1.5',
  status: 'min-w-[240px] flex-[1.9] px-1.5',
  today: 'min-w-[168px] flex-[1.15] px-1.5',
  week: 'min-w-[128px] flex-[0.85] px-1.5',
  usage: 'min-w-[280px] flex-[1.7] px-1.5',
  cost: 'min-w-[144px] flex-[1] px-1.5',
  actions: 'min-w-[96px] flex-[0.65] pr-2',
} as const

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
  const mark = <StatusMark tone={tone} variant='pill' className='text-sm' />
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

/** 冷却或熔断未关闭时显示「清冷却」；提示按实际原因给。 */
function clearableTitle(vm: Vm): string | null {
  if (vmCircuit(vm)) return vmCircuitTitle(vm)
  if (vmCooldown(vm)) return vmCooldownTitle(vm)
  return null
}

function UsageTrack({
  label,
  value,
  resetAt,
  detail,
  cost,
}: {
  label: string
  value: number
  resetAt?: string | null
  detail?: string | null
  cost?: number | null
}) {
  return (
    <div className='min-w-0 space-y-1'>
      <div className='flex items-baseline justify-between gap-1 text-base text-muted-foreground'>
        <span className='flex min-w-0 items-baseline gap-1.5'>
          <span className='truncate'>{label}</span>
          {cost != null ? (
            <span
              className='shrink-0 font-mono text-sm text-foreground/80 tabular-nums'
              title={`${label} 调用费用合计`}
            >
              {fmtUsd(cost, 2)}
            </span>
          ) : null}
        </span>
        <span className={cn('font-medium tabular-nums', riskFg(value))}>
          {value.toFixed(1)}%
        </span>
      </div>
      <UsageMeter value={value} size='sm' ticks />
      {resetAt ? (
        <div className='font-mono text-sm text-muted-foreground tabular-nums'>
          {resetAt}
        </div>
      ) : null}
      {detail ? (
        <div className='text-sm text-muted-foreground tabular-nums'>
          {detail}
        </div>
      ) : null}
    </div>
  )
}

function PriorityChip({ vm }: { vm: Vm }) {
  const level = Number(vm.schedule_level)
  const valid = Number.isInteger(level) && level >= 0
  const text = !valid ? 'P —' : level === 0 ? 'P 0' : `P +${level}`
  const mode = vm.schedule_level_mode === 'manual' ? '手动' : '自动'
  const weight = Number(vm.weight)
  const title = Number.isFinite(weight)
    ? `${mode}调度等级 · WRR ${weight}`
    : `${mode}调度等级`
  return (
    <span
      className='inline-flex rounded-md border border-border/70 px-2 py-1 font-mono text-sm font-semibold text-muted-foreground tabular-nums'
      title={title}
    >
      {text}
    </span>
  )
}

function PlanCell({ vm, now }: { vm: Vm; now: number }) {
  const skin = tierVisual(vm)
  const hasToken = Boolean(vm.has_token)
  const resetAt = vm.reset_7d || vm.reset_7d_oi
  const clock = hasToken ? fmtResetClock(resetAt) : null
  const resetMs = clock ? expiresAtToMs(resetAt) : 0
  const due = clock
    ? {
        text: clock,
        cls:
          resetMs > 0 && resetMs <= now
            ? 'text-[color:var(--status-bad)]'
            : 'text-muted-foreground',
      }
    : null
  if (isCodexVm(vm)) {
    return (
      <div className='flex flex-col items-start gap-1'>
        <OpenaiPlanBadge vm={vm} />
        {due ? (
          <span className={cn('font-mono text-sm tabular-nums', due.cls)}>
            {due.text}
          </span>
        ) : null}
      </div>
    )
  }
  const label = skin.key === 'pro' || skin.key === 'max' ? skin.label : null
  return (
    <div className='flex flex-col items-start gap-1'>
      {label ? (
        <span
          className={cn(
            'rounded-md px-2 py-1 text-sm leading-none font-bold tracking-[0.03em] uppercase',
            skin.badge
          )}
        >
          {label}
        </span>
      ) : (
        <span className='text-muted-foreground'>—</span>
      )}
      {due ? (
        <span className={cn('font-mono text-sm tabular-nums', due.cls)}>
          {due.text}
        </span>
      ) : null}
    </div>
  )
}

function CountPill({ tone, n }: { tone: 'ok' | 'bad'; n: number }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-9 items-center justify-center rounded-full px-2 py-1 text-sm font-semibold tabular-nums',
        tone === 'ok'
          ? 'bg-[color:var(--status-ok-bg)] text-[color:var(--status-ok)]'
          : 'bg-[color:var(--status-bad-bg)] text-[color:var(--status-bad)]'
      )}
    >
      {fmtNum(n)}
    </span>
  )
}

function StatusCell({ vm, show }: { vm: Vm; show: StatusBarShow }) {
  const tone = poolStatus(vm)
  const inflight = Number(vm.inflight) || Number(vm.session_active) || 0
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
              className='inline-flex size-7 items-center justify-center rounded-full bg-[color:var(--tier-pro-solid)] text-sm font-semibold text-[color:var(--tier-pro-solid-fg)] tabular-nums'
              title={`在飞 ${inflight}`}
            >
              {inflight}
            </span>
          ) : null}
        </div>
      ) : null}
      {show.bar ? (
        <div className='flex items-center gap-2' title={health.text}>
          <div
            className='flex h-2.5 min-w-0 flex-1 gap-px overflow-hidden rounded-full track-recessed'
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
              'max-w-[7.5rem] shrink-0 truncate text-sm font-medium',
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
function TodayCell({ vm, accounts }: { vm: Vm; accounts?: UsageAccountRow[] }) {
  const s = vmTodayStats(vm, accounts)
  if (s.req <= 0 && s.tok <= 0 && s.today <= 0) {
    return <span className='text-xs text-muted-foreground'>—</span>
  }
  return (
    <div className='space-y-0.5 font-mono text-xs tabular-nums'>
      <div className='flex flex-wrap gap-x-2 text-muted-foreground'>
        <span>{fmtNum(s.req)} req</span>
        <span>{fmtNum(s.tok)} tok</span>
      </div>
      <div className='text-sm font-medium text-[color:var(--status-ok)]'>
        {fmtUsd(s.today, 2)}
      </div>
    </div>
  )
}

function WeekReqCell({ week }: { week: VmWeekOutcome }) {
  if (!week.known) {
    if (week.req <= 0) {
      return (
        <div className='flex items-center gap-1'>
          <CountPill tone='ok' n={0} />
          <CountPill tone='bad' n={0} />
        </div>
      )
    }
    return (
      <div className='space-y-0.5'>
        <CountPill tone='ok' n={week.req} />
        <div className='text-sm text-muted-foreground'>失败 —</div>
      </div>
    )
  }
  return (
    <div className='flex items-center gap-1'>
      <CountPill tone='ok' n={week.success} />
      <CountPill tone='bad' n={week.fail} />
    </div>
  )
}

function UsageCell({
  vm,
  week,
  accounts,
}: {
  vm: Vm
  week: VmWeekOutcome
  accounts?: UsageAccountRow[]
}) {
  const hasToken = Boolean(vm.has_token)
  const u5 = usedPctOf(vm, '5h')
  const u7 = usedPctOf(vm, '7d')
  const fable = isCodexVm(vm) ? null : fableRow(vm)
  const reset5 = hasToken ? fmtResetClock(vm.reset_5h) : null
  const reset7 = hasToken ? fmtResetClock(vm.reset_7d) : null
  const resetFable = hasToken ? fmtResetClock(vm.reset_7d_oi) : null
  const costs = vmWindowCosts(vm, accounts)
  const weekDetail =
    week.req > 0 || week.tok > 0
      ? `${fmtNum(week.req)} req / ${fmtNum(week.tok)} tok`
      : null
  return (
    <div className='space-y-1.5'>
      <div className='grid grid-cols-2 gap-2'>
        <UsageTrack label='5h' value={u5} resetAt={reset5} cost={costs.h5} />
        {fable?.kind === 'bar' ? (
          <UsageTrack label='Fable' value={fable.pct} resetAt={resetFable} />
        ) : fable?.kind === 'note' ? (
          <div className='min-w-0 space-y-0.5'>
            <div className='flex items-baseline justify-between gap-1 text-base text-muted-foreground'>
              <span>Fable</span>
              <span className='truncate text-[color:var(--status-warn)]'>
                {fable.text}
              </span>
            </div>
            <div className='h-1' aria-hidden />
          </div>
        ) : (
          <UsageTrack
            label='7d'
            value={u7}
            resetAt={reset7}
            detail={weekDetail}
            cost={costs.d7}
          />
        )}
      </div>
      {fable ? (
        <UsageTrack
          label='7d'
          value={u7}
          resetAt={reset7}
          detail={weekDetail}
          cost={costs.d7}
        />
      ) : null}
    </div>
  )
}

function CostCell({ vm, week }: { vm: Vm; week: VmWeekOutcome }) {
  return (
    <div className='space-y-1'>
      <div className='font-mono text-base tabular-nums'>
        <div>7d {fmtUsd(week.cost, 2)}</div>
        <div className='text-muted-foreground'>
          Σ {fmtUsd(vm.total_cost, 2)}
        </div>
      </div>
      <span className='inline-flex rounded-md border border-[color:var(--status-caution)]/45 px-2 py-1 text-sm font-medium text-[color:var(--status-caution)]'>
        官方结
      </span>
    </div>
  )
}

function SlotCell({ vm }: { vm: Vm }) {
  const name = slotNameLabel(vm)
  const email = String(vm.email || '').trim()
  return (
    <div className={cn(LIST_COL.vm, 'min-w-0 overflow-hidden')}>
      <SlotIdentity vm={vm} compact className='font-medium' />
      <div
        className='truncate text-[12px] text-muted-foreground'
        title={email ? name : undefined}
      >
        {name}
      </div>
    </div>
  )
}

export function VmTable({
  vms,
  accounts,
  onReset,
  onDelete,
  onClearCooldown,
}: {
  vms: Vm[]
  accounts?: UsageAccountRow[]
  onReset?: (vm: Vm) => void
  onDelete?: (vm: Vm) => void
  onClearCooldown?: (vm: Vm) => void
}) {
  const navigate = useNavigate()
  const now = useNow()
  const statusBar = useStatusBarShow()
  return (
    <div className='overflow-x-auto rounded-lg border border-border/60'>
      <div className='min-w-[1680px]'>
        <div className='sticky top-0 z-10 flex h-10 items-center border-b bg-muted/30 text-sm font-medium tracking-wide text-muted-foreground'>
          <div className={LIST_COL.vm}>账号</div>
          <div className={LIST_COL.sched}>调度</div>
          <div className={LIST_COL.group}>平台</div>
          <div className={LIST_COL.pri}>调度优先级</div>
          <div className={LIST_COL.plan}>等级</div>
          <div className={`${LIST_COL.status} flex items-center gap-1`}>
            状态
            <StatusBarOptions
              show={statusBar.show}
              onToggle={statusBar.toggle}
            />
          </div>
          <div className={LIST_COL.today}>今日统计</div>
          <div className={LIST_COL.week}>请求(7D)</div>
          <div className={LIST_COL.usage}>用量</div>
          <div className={LIST_COL.cost}>成本</div>
          <div className={LIST_COL.actions} />
        </div>
        {vms.map((vm) => {
          const week = vmWeekOutcome(vm, accounts)
          const group = fleetGroup(vm)
          const muted = group === 'off' || group === 'none'
          return (
            <div
              key={vm.id}
              className={cn(
                'group flex cursor-pointer items-start border-b border-border/40 py-3.5 text-base transition-colors duration-150',
                // 等级色条只走行首 2px，不染整行底色：行是密集数字区，
                // 底色一染，状态色（真正要被扫到的信号）就没对比空间了。
                tierVisual(vm).row || 'hover:bg-accent/40',
                muted && 'opacity-60'
              )}
              onClick={() => navigate({ to: '/vm/$id', params: { id: vm.id } })}
            >
              <SlotCell vm={vm} />
              <div className={LIST_COL.sched}>
                <SchedulableSwitch {...vmSchedulableProps(vm)} />
              </div>
              <div className={LIST_COL.group}>
                <PlatformChip vm={vm} className='px-2 py-1 text-sm' />
              </div>
              <div className={LIST_COL.pri}>
                <PriorityChip vm={vm} />
              </div>
              <div className={LIST_COL.plan}>
                <PlanCell vm={vm} now={now} />
              </div>
              <div className={LIST_COL.status}>
                <StatusCell vm={vm} show={statusBar.show} />
              </div>
              <div className={LIST_COL.today}>
                <TodayCell vm={vm} accounts={accounts} />
              </div>
              <div className={LIST_COL.week}>
                <WeekReqCell week={week} />
              </div>
              <div className={LIST_COL.usage}>
                <UsageCell vm={vm} week={week} accounts={accounts} />
              </div>
              <div className={LIST_COL.cost}>
                <CostCell vm={vm} week={week} />
              </div>
              <div className={LIST_COL.actions}>
                <div className='flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100'>
                  {onClearCooldown && clearableTitle(vm) ? (
                    <Button
                      size='sm'
                      variant='ghost'
                      title={clearableTitle(vm) || undefined}
                      className='h-8 px-2 text-sm text-muted-foreground'
                      data-row-actions
                      onClick={(e) => {
                        e.stopPropagation()
                        onClearCooldown(vm)
                      }}
                    >
                      清冷却
                    </Button>
                  ) : null}
                  {onReset ? (
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-8 px-2 text-sm text-muted-foreground'
                      data-row-actions
                      onClick={(e) => {
                        e.stopPropagation()
                        onReset(vm)
                      }}
                    >
                      重置
                    </Button>
                  ) : null}
                  {onDelete ? (
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-8 px-2 text-sm text-destructive'
                      data-row-actions
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete(vm)
                      }}
                    >
                      删除
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
