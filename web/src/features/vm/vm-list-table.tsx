import { useNavigate } from '@tanstack/react-router'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import { fableState, fmtResetClock } from '@/lib/fable-status'
import { fmtNum, fmtUsd, remainPct, usedPctOf } from '@/lib/format'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import {
  claudeTier,
  credExpiry,
  fleetGroup,
  poolStatus,
  vmCooldown,
  vmCooldownTitle,
  windowLimited,
} from '@/lib/vm-status'
import { vmTodayStats, vmWeekOutcome, type VmWeekOutcome } from '@/lib/vm-usage'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { PlatformChip, SlotIdentity } from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import { OpenaiPlanBadge } from '@/features/vm/openai-plan-badge'
import { SchedulableSwitch } from '@/features/vm/schedulable-switch'
import {
  StatusBarOptions,
  useStatusBarShow,
  type StatusBarShow,
} from '@/features/vm/status-bar-options'

const RISK_BAR = (risk: number) =>
  risk >= 100
    ? 'bg-[color:var(--status-bad-solid)]'
    : risk >= 85
      ? 'bg-[color:var(--status-warn-solid)]'
      : risk >= 70
        ? 'bg-[color:var(--status-caution-solid)]'
        : 'bg-[color:var(--status-ok-solid)]'

const RISK_FG = (risk: number) =>
  risk >= 100
    ? 'text-[color:var(--status-bad)]'
    : risk >= 85
      ? 'text-[color:var(--status-warn)]'
      : risk >= 70
        ? 'text-[color:var(--status-caution)]'
        : 'text-[color:var(--status-ok)]'

const LIST_COL = {
  vm: 'min-w-[220px] flex-[1.25] pl-3',
  sched: 'min-w-[52px] flex-[0.35] px-1.5',
  group: 'min-w-[104px] flex-[0.7] px-1.5',
  pri: 'min-w-[92px] flex-[0.55] px-1.5',
  plan: 'min-w-[100px] flex-[0.6] px-1.5',
  status: 'min-w-[240px] flex-[1.9] px-1.5',
  today: 'min-w-[168px] flex-[1.15] px-1.5',
  week: 'min-w-[128px] flex-[0.85] px-1.5',
  usage: 'min-w-[228px] flex-[1.6] px-1.5',
  cost: 'min-w-[144px] flex-[1] px-1.5',
  actions: 'min-w-[96px] flex-[0.65] pr-2',
} as const

type DotTone = 'ok' | 'caution' | 'warn' | 'bad' | 'none'

const DOT_BG: Record<DotTone, string> = {
  ok: 'bg-[color:var(--status-ok-solid)]',
  caution: 'bg-[color:var(--status-caution-solid)]',
  warn: 'bg-[color:var(--status-warn-solid)]',
  bad: 'bg-[color:var(--status-bad-solid)]',
  none: 'bg-[color:var(--track)]',
}

const DOT_FG: Record<DotTone, string> = {
  ok: 'text-[color:var(--status-ok)]',
  caution: 'text-[color:var(--status-caution)]',
  warn: 'text-[color:var(--status-warn)]',
  bad: 'text-[color:var(--status-bad)]',
  none: 'text-muted-foreground',
}

function fableRow(
  vm: Vm
): { kind: 'bar'; pct: number } | { kind: 'note'; text: string } | null {
  const tier = claudeTier(vm)
  if (tier.key !== 'max') return null
  const st = fableState(vm, tier.key)
  if (st.usedPct != null) return { kind: 'bar', pct: st.usedPct }
  if (st.tone.key === 'none') return null
  return { kind: 'note', text: st.tone.text }
}

function utilDotTone(
  status: unknown,
  util: number,
  hasWindow: boolean
): DotTone {
  if (!hasWindow) return 'none'
  if (windowLimited(status, util)) return 'bad'
  if (util >= 85) return 'caution'
  if (util >= 70) return 'warn'
  return 'ok'
}

function healthModel(
  vm: Vm,
  week: VmWeekOutcome
): { dots: DotTone[]; rate: number | null; label: string } {
  const pool = poolStatus(vm)
  if (pool.cls === 'bad') {
    return {
      dots: Array.from({ length: 16 }, () => 'bad' as const),
      rate: null,
      label: pool.text,
    }
  }
  if (pool.cls === 'none' || pool.cls === 'off') {
    return {
      dots: Array.from({ length: 16 }, () => 'none' as const),
      rate: null,
      label: pool.text,
    }
  }
  const total = week.success + week.fail
  if (week.known && total > 0) {
    const rate = (week.success / total) * 100
    const okN = Math.round((week.success / total) * 16)
    return {
      dots: Array.from({ length: 16 }, (_, i) => (i < okN ? 'ok' : 'bad')),
      rate,
      label: '7D 成功率',
    }
  }
  const has = Boolean(vm.has_token)
  const t5 = utilDotTone(vm.status_5h, usedPctOf(vm, '5h'), has)
  const t7 = utilDotTone(vm.status_7d, usedPctOf(vm, '7d'), has)
  const fable = isCodexVm(vm) ? null : fableRow(vm)
  const tf: DotTone = !fable
    ? t5
    : fable.kind === 'bar'
      ? utilDotTone(null, fable.pct, true)
      : 'warn'
  if (isCodexVm(vm)) {
    return {
      dots: [
        ...Array.from({ length: 8 }, () => t5),
        ...Array.from({ length: 8 }, () => t7),
      ],
      rate: has ? remainPct(vm.utilization_7d) : null,
      label: '7D 剩余',
    }
  }
  return {
    dots: [
      ...Array.from({ length: 6 }, () => t5),
      ...Array.from({ length: 6 }, () => t7),
      ...Array.from({ length: 4 }, () => tf),
    ],
    rate: has ? remainPct(vm.utilization_7d) : null,
    label: '7D 剩余',
  }
}

function StatusReason({ vm, tone }: { vm: Vm; tone: StatusTone }) {
  const mark = <StatusMark tone={tone} variant='pill' className='text-sm' />
  if (!vmCooldown(vm)) return mark
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{mark}</span>
      </TooltipTrigger>
      <TooltipContent>{vmCooldownTitle(vm)}</TooltipContent>
    </Tooltip>
  )
}

function UsageTrack({
  label,
  value,
  resetAt,
  detail,
}: {
  label: string
  value: number
  resetAt?: string | null
  detail?: string | null
}) {
  return (
    <div className='min-w-0 space-y-1'>
      <div className='flex items-baseline justify-between gap-1 text-base text-muted-foreground'>
        <span className='truncate'>{label}</span>
        <span className={cn('font-medium tabular-nums', RISK_FG(value))}>
          {value.toFixed(1)}%
        </span>
      </div>
      <Progress
        value={value > 0 ? Math.min(100, Math.max(1.5, value)) : 0}
        className='h-1.5 track-recessed'
        indicatorClassName={cn(RISK_BAR(value), 'rounded-full')}
      />
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
  const exp = credExpiry(vm)
  const left = exp.ms != null ? exp.ms - now : null
  const due =
    left != null && left <= 0
      ? { text: '已过期', cls: 'text-[color:var(--status-bad)]' }
      : left != null && left < 7 * 86400000
        ? { text: '7d到期', cls: 'text-[color:var(--status-caution)]' }
        : null
  if (isCodexVm(vm)) {
    return (
      <div className='flex flex-col items-start gap-1'>
        <OpenaiPlanBadge vm={vm} />
        {due ? (
          <span className={cn('text-sm font-medium', due.cls)}>{due.text}</span>
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
        <span className={cn('text-sm font-medium', due.cls)}>{due.text}</span>
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

function StatusCell({
  vm,
  week,
  show,
}: {
  vm: Vm
  week: VmWeekOutcome
  show: StatusBarShow
}) {
  const tone = poolStatus(vm)
  const inflight = Number(vm.inflight) || Number(vm.session_active) || 0
  const health = healthModel(vm, week)
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
        <div
          className='flex items-center gap-1.5'
          title={`${health.label}${health.rate != null ? ` ${health.rate.toFixed(1)}%` : ''}`}
        >
          <div className='flex items-end gap-px' aria-hidden>
            {health.dots.map((dot, i) => (
              <span
                key={i}
                className={cn(
                  'inline-block h-3 w-1.5 rounded-[1px]',
                  DOT_BG[dot]
                )}
              />
            ))}
          </div>
          <span
            className={cn(
              'text-base font-medium tabular-nums',
              health.rate == null
                ? 'text-muted-foreground'
                : health.label === '7D 成功率'
                  ? health.rate >= 95
                    ? DOT_FG.ok
                    : health.rate >= 80
                      ? DOT_FG.caution
                      : DOT_FG.bad
                  : health.rate >= 40
                    ? DOT_FG.ok
                    : health.rate >= 15
                      ? DOT_FG.caution
                      : DOT_FG.bad
            )}
          >
            {health.rate == null ? '—' : `${health.rate.toFixed(1)}%`}
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

function UsageCell({ vm, week }: { vm: Vm; week: VmWeekOutcome }) {
  const hasToken = Boolean(vm.has_token)
  const u5 = usedPctOf(vm, '5h')
  const u7 = usedPctOf(vm, '7d')
  const fable = isCodexVm(vm) ? null : fableRow(vm)
  const reset5 = hasToken ? fmtResetClock(vm.reset_5h) : null
  const reset7 = hasToken ? fmtResetClock(vm.reset_7d) : null
  const resetFable = hasToken ? fmtResetClock(vm.reset_7d_oi) : null
  const weekDetail =
    week.req > 0 || week.tok > 0
      ? `${fmtNum(week.req)} req / ${fmtNum(week.tok)} tok`
      : null
  return (
    <div className='space-y-1.5'>
      <div className='grid grid-cols-2 gap-2'>
        <UsageTrack label='5h' value={u5} resetAt={reset5} />
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
          />
        )}
      </div>
      {fable ? (
        <UsageTrack
          label='7d'
          value={u7}
          resetAt={reset7}
          detail={weekDetail}
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
  const name = vm.name || vm.id
  const email = String(vm.email || '').trim()
  return (
    <div className={cn(LIST_COL.vm, 'min-w-0 overflow-hidden')}>
      <SlotIdentity vm={vm} compact className='font-medium' />
      <div
        className='truncate text-[12px] text-muted-foreground'
        title={email ? name : undefined}
      >
        {email ? name : '未绑定账号'}
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
      <div className='min-w-[1600px]'>
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
                'group flex cursor-pointer items-start border-b border-border/40 py-3.5 text-base hover:bg-accent/40',
                muted && 'opacity-60'
              )}
              onClick={() => navigate({ to: '/vm/$id', params: { id: vm.id } })}
            >
              <SlotCell vm={vm} />
              <div className={LIST_COL.sched}>
                <SchedulableSwitch
                  vmId={vm.id}
                  schedulable={vm.schedulable !== false}
                />
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
                <StatusCell vm={vm} week={week} show={statusBar.show} />
              </div>
              <div className={LIST_COL.today}>
                <TodayCell vm={vm} accounts={accounts} />
              </div>
              <div className={LIST_COL.week}>
                <WeekReqCell week={week} />
              </div>
              <div className={LIST_COL.usage}>
                <UsageCell vm={vm} week={week} />
              </div>
              <div className={LIST_COL.cost}>
                <CostCell vm={vm} week={week} />
              </div>
              <div className={LIST_COL.actions}>
                <div className='flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100'>
                  {onClearCooldown && vmCooldown(vm) ? (
                    <Button
                      size='sm'
                      variant='ghost'
                      title={vmCooldownTitle(vm)}
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
