import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import {
  ArrowDown,
  ArrowUp,
  Ban,
  ChevronDown,
  ChevronRight,
  Eye,
  Layers,
  CircleCheck,
  CircleOff,
  ExternalLink,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import { credentialRegistrationOf } from '@/lib/cred-type'
import { fmtResetClock, resetCountdown } from '@/lib/fable-status'
import { fmtNum, fmtUsd } from '@/lib/format'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import {
  fmtHealthPct,
  HEALTH_FG,
  healthSummary,
  healthTone,
  SLOT_BG,
  type SlotState,
} from '@/lib/vm-health'
import { clipLabel } from '@/lib/vm-kind'
import {
  claudeTier,
  poolStatus,
  scheduleStateLabel,
  seatTitle,
  type ScheduleStateLabel,
  vmRequestingCount,
} from '@/lib/vm-status'
import { vmCostLedger, vmTodayStats, vmWeekOutcome } from '@/lib/vm-usage'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import { StatusMark } from '@/components/status-mark'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import { riskFg, RISK_SOLID, riskLevel } from '@/features/vm/usage-meter'
import { PlatformMark } from '@/features/vm/vm-account-identity'
import { VmActionMenu } from '@/features/vm/vm-action-menu'
import { useVmActions } from '@/features/vm/vm-actions-context'
import { GeminiSlotStatus } from '@/features/vm/vm-rack-blade'
import {
  emptyZoneCounts,
  GEMINI_EVIDENCE_ZONES,
  vmWindows,
  type WindowKey,
  type WindowReadout,
  ZONES,
  zoneOf,
  type VmZone,
} from '@/features/vm/vm-rack-model'
import { VmRowDetail } from '@/features/vm/vm-row-detail'
import { schedulingPriorityTextClass } from '@/features/vm/vm-type-visual'
import { windowTiming } from '@/features/vm/window-timing'

/** 行内点到这些元素时不切换展开。 */
const ROW_INTERACTIVE =
  'button, a, input, select, textarea, label, [role="switch"], [role="menuitem"], [data-row-stop]'

/**
 * 固定网格：一行 38px，主读数常显，次要信息（邮箱、代理、成功数、倒计时、
 * 菜单）悬停 / 聚焦 / 展开时才显示。槽位名和打开按钮横向滚动时固定在左边。
 */
const GRID: CSSProperties = {
  gridTemplateColumns:
    '34px minmax(240px,1.5fr) minmax(250px,1.3fr) minmax(190px,0.95fr) repeat(3,minmax(104px,0.55fr)) 48px 46px 40px 40px 80px 60px 62px 64px 56px',
}

/** 悬停才出现的次要信息。 */
const SEC =
  'group-data-[pin=true]/tbl:opacity-100 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 group-aria-expanded:opacity-100 motion-reduce:transition-none'

const NUM = 'justify-end font-mono tabular-nums'
const TERT = 'text-[color:var(--text-tertiary)]'

const STATE_STYLE: Record<
  ScheduleStateLabel,
  { cls: string; icon: typeof CircleCheck }
> = {
  开: { cls: 'text-muted-foreground font-medium', icon: CircleCheck },
  受限: { cls: 'text-[color:var(--status-warn)]', icon: TriangleAlert },
  关: { cls: TERT, icon: CircleOff },
  不可调度: { cls: 'text-[color:var(--status-bad)]', icon: Ban },
}

const STATE_ICON_FG: Partial<Record<ScheduleStateLabel, string>> = {
  开: 'text-[color:var(--status-ok)]',
}

function SchedCell({ vm }: { vm: Vm }) {
  if (vm.gemini) return <GeminiSlotStatus vm={vm} />
  const level = Number(vm.schedule_level)
  const levelOk = Number.isInteger(level) && level >= 1 && level <= 10
  const manual = vm.schedule_level_mode === 'manual'
  const label = scheduleStateLabel(vm)
  const tone = poolStatus(vm)
  const breaker = label === '受限' && tone.key === 'circuit'
  const style = STATE_STYLE[label]
  const Icon = breaker ? Zap : style.icon
  const reason =
    label === '受限' || label === '不可调度'
      ? vm.restriction_text || vm.unschedulable_text || tone.text
      : label === '关'
        ? '手动关闭'
        : null
  return (
    <>
      <SchedulableSwitch {...vmSchedulableProps(vm)} />
      <span
        className={cn(
          'inline-flex w-[72px] shrink-0 items-center gap-1 font-semibold',
          breaker ? 'text-[color:var(--status-caution)]' : style.cls
        )}
      >
        <Icon
          className={cn('size-3 shrink-0', STATE_ICON_FG[label])}
          aria-hidden
        />
        {label}
      </span>
      <span
        className={cn(
          'w-[42px] shrink-0 rounded-[3px] px-1 text-center text-[11px] leading-[1.5] font-bold tabular-nums',
          levelOk
            ? cn(
                schedulingPriorityTextClass(level),
                manual ? 'shadow-[inset_0_0_0_1px_currentColor]' : 'bg-muted'
              )
            : TERT
        )}
        title={
          levelOk
            ? `${manual ? '手动指定' : '自动分配'}的优先级，数字越大越优先`
            : '没有调度优先级'
        }
      >
        P{levelOk ? level : '—'}
        {levelOk && manual ? (
          <small className='ml-0.5 font-sans font-semibold'>手</small>
        ) : null}
      </span>
      {reason ? (
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            label === '关'
              ? TERT
              : breaker
                ? 'text-[color:var(--status-caution)]'
                : style.cls
          )}
          title={reason}
        >
          {reason}
        </span>
      ) : null}
    </>
  )
}

/** 颜色 + 高度双重编码（越高越糟），不只靠颜色。 */
const SLOT_HEIGHT: Record<SlotState, string> = {
  ok: '55%',
  slow: '78%',
  down: '100%',
  none: '2px',
}

function HealthCell({ vm }: { vm: Vm }) {
  const h = healthSummary(vm.health_24h)
  return (
    <>
      <span
        role='img'
        aria-label='近 24 小时 48 格请求健康时间线'
        className='inline-grid h-4 shrink-0 auto-cols-[2px] grid-flow-col items-end gap-0 min-[1800px]:gap-px'
      >
        {h.slots.map((s, i) => (
          <i
            key={i}
            className='block'
            style={{ height: SLOT_HEIGHT[s], backgroundColor: SLOT_BG[s] }}
          />
        ))}
      </span>
      {h.req ? (
        <>
          <b
            className={cn(
              'font-mono font-bold tabular-nums',
              HEALTH_FG[h.tone]
            )}
            title='近 24h 成功请求 ÷ 总请求'
          >
            {fmtHealthPct(h.pct)}
          </b>
          <span
            className={cn(
              'hidden font-mono text-muted-foreground tabular-nums min-[1800px]:inline',
              SEC
            )}
            title={`成功 ${fmtNum(h.ok)} / 总数 ${fmtNum(h.req)}`}
          >
            {`${h.ok}/${h.req}`}
          </span>
        </>
      ) : (
        <span className={TERT}>24h 无请求</span>
      )}
    </>
  )
}

function QuotaCell({
  vm,
  w,
  now,
}: {
  vm: Vm
  w: WindowReadout | undefined
  now: number
}) {
  if (!w) return <span className={TERT}>不适用</span>
  if (w.note)
    return (
      <span className='truncate text-[color:var(--status-warn)]' title={w.note}>
        {w.note}
      </span>
    )
  if (w.pct == null)
    return (
      <div className='grid w-full grid-cols-[auto_1fr] gap-y-1 font-mono'>
        <span className={TERT}>—</span>
        <span className={cn('text-right text-[11px]', TERT)}>未探测</span>
        <span
          className='col-span-2 h-1 rounded-full bg-[repeating-linear-gradient(135deg,var(--muted)_0_3px,transparent_3px_6px)]'
          aria-hidden
        />
      </div>
    )
  const t = windowTiming(w, now)
  const full = w.pct >= 100
  const hot = w.pct >= 90
  const left = vm.has_token ? resetCountdown(w.reset, now) : null
  const eta = full ? (left ? `${left}恢复` : '已满') : left || '未开窗'
  return (
    <div
      className='grid w-full grid-cols-[auto_1fr] items-baseline gap-y-1 font-mono tabular-nums'
      title={`${w.label} 用量 ${w.pct.toFixed(0)}%${
        t.elapsedPct != null
          ? ` · 时间已过 ${t.elapsedPct.toFixed(0)}% · ${fmtResetClock(w.reset)} 重置`
          : ''
      }`}
    >
      <span
        className={cn(
          w.pct >= 70 ? riskFg(w.pct) : 'text-foreground',
          hot ? 'font-extrabold' : 'font-medium'
        )}
      >
        {w.pct.toFixed(0)}%
      </span>
      <span
        className={cn(
          'text-right text-[11px] whitespace-nowrap',
          full
            ? 'font-semibold text-[color:var(--status-bad)]'
            : cn('text-muted-foreground', !hot && SEC)
        )}
      >
        {eta}
      </span>
      <span className='relative col-span-2 h-1 rounded-full bg-muted'>
        <i
          className='absolute inset-y-0 left-0 rounded-full'
          style={{
            width: `${Math.min(100, w.pct)}%`,
            backgroundColor: RISK_SOLID[riskLevel(w.pct)],
          }}
        />
        {t.elapsedPct != null ? (
          <b
            aria-hidden
            className='absolute -top-[3px] -bottom-[3px] w-0.5 rounded-[1px] bg-foreground'
            style={{ left: `calc(${t.elapsedPct}% - 1px)` }}
          />
        ) : null}
      </span>
    </div>
  )
}

/** 一行需要的数字，排序与渲染共用。 */
type RowData = {
  vm: Vm
  health: number | null
  hOk: number
  hReq: number
  win: Partial<Record<WindowKey, WindowReadout>>
  today: number
  seatsUsed: number
  seatsMax: number | null
  queue: number
  inflight: number
  spend: number
  tokens: number
  perReq: number | null
  total: number
}

function rowData(vm: Vm, accounts?: UsageAccountRow[]): RowData {
  const [, d7, total] = vmCostLedger(vm, accounts)
  const week = vmWeekOutcome(vm, accounts)
  const win: RowData['win'] = {}
  for (const w of vmWindows(vm)) win[w.key] = w
  const h = healthSummary(vm.health_24h)
  return {
    vm,
    health: h.pct,
    hOk: h.ok,
    hReq: h.req,
    win,
    today: vmTodayStats(vm, accounts).req,
    seatsUsed: Number(vm.seats_used) || 0,
    seatsMax: vm.seats_max == null ? null : Number(vm.seats_max),
    queue: Number(vm.queue_depth) || 0,
    inflight: vmRequestingCount(vm),
    spend: d7.cost,
    tokens: d7.tokens,
    perReq: week.req > 0 && d7.cost ? d7.cost / week.req : null,
    total: total.cost,
  }
}

type SortKey =
  | 'health'
  | '5h'
  | '7d'
  | 'fable'
  | 'today'
  | 'seats'
  | 'queue'
  | 'inflight'
  | 'spend'
  | 'tokens'
  | 'perReq'
  | 'total'

const SORT_VALUE: Record<SortKey, (r: RowData) => number | null> = {
  health: (r) => r.health,
  '5h': (r) => r.win['5h']?.pct ?? null,
  '7d': (r) => r.win['7d']?.pct ?? null,
  fable: (r) => r.win.fable?.pct ?? null,
  today: (r) => r.today,
  seats: (r) => (r.seatsMax ? r.seatsUsed / r.seatsMax : null),
  queue: (r) => r.queue,
  inflight: (r) => r.inflight,
  spend: (r) => r.spend,
  tokens: (r) => r.tokens,
  perReq: (r) => r.perReq,
  total: (r) => r.total,
}

/** 健康默认升序（差的在前），其余默认降序。 */
const ASC_FIRST: ReadonlySet<SortKey> = new Set(['health'])

type Col = {
  label: string
  sort?: SortKey
  num?: boolean
  dim?: boolean
  cell: (r: RowData, now: number) => ReactNode
}

const COLS: Col[] = [
  {
    label: '调度 · 优先级',
    cell: (r) => <SchedCell vm={r.vm} />,
  },
  {
    label: '健康 · 24h',
    sort: 'health',
    cell: (r) => <HealthCell vm={r.vm} />,
  },
  {
    label: '5H',
    sort: '5h',
    cell: (r, now) => <QuotaCell vm={r.vm} w={r.win['5h']} now={now} />,
  },
  {
    label: '7D',
    sort: '7d',
    cell: (r, now) => <QuotaCell vm={r.vm} w={r.win['7d']} now={now} />,
  },
  {
    label: 'Fable',
    sort: 'fable',
    cell: (r, now) => <QuotaCell vm={r.vm} w={r.win.fable} now={now} />,
  },
  {
    label: '今日请求数',
    sort: 'today',
    num: true,
    cell: (r) => (r.today ? fmtNum(r.today) : <span className={TERT}>0</span>),
  },
  {
    label: '席位',
    sort: 'seats',
    num: true,
    cell: (r) =>
      r.seatsMax == null ? (
        <span className={TERT}>—</span>
      ) : (
        <span
          className={cn(
            r.seatsUsed >= r.seatsMax &&
              r.seatsMax > 0 &&
              'font-semibold text-[color:var(--status-warn)]'
          )}
          title={seatTitle(r.vm)}
        >
          {r.seatsUsed}/{r.seatsMax}
        </span>
      ),
  },
  {
    label: '排队',
    sort: 'queue',
    num: true,
    cell: (r) =>
      r.queue ? (
        <b className='text-[color:var(--status-warn)]'>{r.queue}</b>
      ) : (
        <span className={TERT}>0</span>
      ),
  },
  {
    label: '请求中',
    sort: 'inflight',
    num: true,
    cell: (r) => (r.inflight ? r.inflight : <span className={TERT}>0</span>),
  },
  {
    label: '7 天窗口花费',
    sort: 'spend',
    num: true,
    cell: (r) =>
      r.spend ? <b>{fmtUsd(r.spend, 2)}</b> : <span className={TERT}>—</span>,
  },
  {
    label: 'Token',
    sort: 'tokens',
    num: true,
    dim: true,
    cell: (r) => (r.tokens ? fmtNum(r.tokens) : '—'),
  },
  {
    label: '$/请求',
    sort: 'perReq',
    num: true,
    dim: true,
    cell: (r) => (r.perReq == null ? '—' : `$${r.perReq.toFixed(3)}`),
  },
  {
    label: '总费用',
    sort: 'total',
    num: true,
    dim: true,
    cell: (r) => (r.total ? fmtUsd(r.total, 0) : '—'),
  },
]

function ProdCell({ vm }: { vm: Vm }) {
  const tier = claudeTier(vm)
  const plan = vm.gemini ? vm.gemini.account?.plan : tier.label
  const crag = (vm.resolved_dataplane ?? vm.dataplane) === 'crag'
  const registration = credentialRegistrationOf(vm)
  const node = vm.node_name || vm.node_id || 'local'
  return (
    <>
      <PlatformMark vm={vm} />
      <span
        className='min-w-0 truncate font-mono font-semibold'
        title={vm.name ? `${vm.name} · ${vm.id}` : vm.id}
      >
        {clipLabel(vm.name || vm.id, 16)}
      </span>
      {plan && plan !== '—' ? (
        <span
          className={cn(
            'shrink-0 rounded-[3px] px-1 font-mono text-[10px] leading-[1.5] font-semibold',
            tierVisual(vm).badge
          )}
        >
          {plan}
        </span>
      ) : null}
      <span
        className={cn(
          'shrink-0 rounded-[3px] px-1 font-mono text-[10px] leading-[1.5] font-semibold',
          crag
            ? 'bg-orange-200 text-orange-900 dark:bg-orange-400/20 dark:text-orange-300'
            : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-300/20 dark:text-zinc-300'
        )}
        title='当前内核'
      >
        {vm.gemini ? 'CRAGAnti' : crag ? 'crag' : '默认'}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground',
          SEC
        )}
        title={vm.email || ''}
      >
        {vm.email ? clipLabel(vm.email) : '未绑定邮箱'}
      </span>
      <span
        className={cn(
          'flex min-w-0 shrink items-center gap-1 overflow-hidden text-[11px] text-muted-foreground',
          SEC
        )}
      >
        <span>
          {vm.gemini ? '宿主机' : vm.runtime_type === 'kvm' ? 'kvm' : 'vm'}
        </span>
        <span aria-hidden>·</span>
        <span>{registration === 'none' ? '无凭证' : registration}</span>
        <span aria-hidden>·</span>
        <span className='max-w-[96px] truncate' title={node}>
          {node}
        </span>
      </span>
      <span className={cn('min-w-0 shrink overflow-hidden', SEC)}>
        <ProxyChip vm={vm} compact />
      </span>
    </>
  )
}

type Agg = {
  n: number
  gemini: number
  ok: number
  req: number
  today: number
  spend: number
  used: number
  cap: number
  queue: number
  queued: number
  by: Record<VmZone, number>
  top: RowData | null
}

function aggregate(rows: RowData[]): Agg {
  const a: Agg = {
    n: rows.length,
    gemini: 0,
    ok: 0,
    req: 0,
    today: 0,
    spend: 0,
    used: 0,
    cap: 0,
    queue: 0,
    queued: 0,
    by: emptyZoneCounts(),
    top: null,
  }
  for (const r of rows) {
    if (r.vm.gemini) a.gemini++
    a.ok += r.hOk
    a.req += r.hReq
    a.today += r.today
    a.spend += r.spend
    a.used += r.seatsUsed
    a.cap += r.seatsMax ?? 0
    a.queue += r.queue
    if (r.queue) a.queued++
    a.by[zoneOf(r.vm)]++
    if (r.spend && (!a.top || r.spend > a.top.spend)) a.top = r
  }
  return a
}

const aggPct = (a: Agg) => (a.req ? (a.ok / a.req) * 100 : null)

/** 本机记住的列表开关。 */
function useFlag(key: string, initial: boolean) {
  const [on, setOn] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw == null ? initial : raw === '1'
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, on ? '1' : '0')
    } catch {
      /* 隐私模式下写不进去，只影响下次默认值 */
    }
  }, [key, on])
  return [on, setOn] as const
}

function Kpi({
  k,
  v,
  x,
  tone,
}: {
  k: string
  v: ReactNode
  x: ReactNode
  tone?: string
}) {
  return (
    <div className='min-w-0 flex-1 border-l px-3 first:border-l-0'>
      <div className='text-[11px] text-muted-foreground'>{k}</div>
      <div className='flex items-baseline gap-2 whitespace-nowrap'>
        <b className={cn('font-mono text-[15px] tabular-nums', tone)}>{v}</b>
        <span className='truncate text-[11px] text-muted-foreground'>{x}</span>
      </div>
    </div>
  )
}

function SummaryBar({ a }: { a: Agg }) {
  const pct = aggPct(a)
  const geminiZones = GEMINI_EVIDENCE_ZONES.filter((z) => a.by[z.key] > 0)
  return (
    <section
      aria-label='全局汇总'
      className='flex flex-wrap gap-y-2 rounded-lg border border-border/60 bg-card py-2'
    >
      <Kpi
        k={a.gemini ? '账号总数' : '在池'}
        v={
          a.gemini ? (
            a.n
          ) : (
            <>
              {a.by.pool}
              <span className='text-muted-foreground'>/{a.n}</span>
            </>
          )
        }
        x={
          a.gemini
            ? `Gemini ${a.gemini} · 普通槽 ${a.n - a.gemini}`
            : `受限 ${a.by.restricted} · 关闭 ${a.by.off} · 未使用 ${a.by.none} · 不可调度 ${a.by.dead}`
        }
      />
      <Kpi
        k={a.gemini ? '普通槽 24h 成功率' : '24h 成功率'}
        v={fmtHealthPct(pct)}
        x={`失败 ${fmtNum(a.req - a.ok)}`}
        tone={HEALTH_FG[healthTone(pct)]}
      />
      <Kpi
        k={a.gemini ? '普通槽近 24h 请求' : '近 24h 请求'}
        v={fmtNum(a.req)}
        x={`北京时间今日 ${fmtNum(a.today)}`}
      />
      <Kpi
        k={a.gemini ? '普通槽 7 天花费' : '7 天窗口花费'}
        v={a.spend ? fmtUsd(a.spend, 2) : '—'}
        x={a.top ? `最高 ${a.top.vm.id} ${fmtUsd(a.top.spend, 0)}` : ''}
      />
      <Kpi
        k={a.gemini ? '普通槽席位占用' : '席位占用'}
        v={
          <>
            {a.used}
            <span className='text-muted-foreground'>/{a.cap}</span>
          </>
        }
        x={a.cap ? `${Math.round((a.used / a.cap) * 100)}%` : ''}
      />
      <Kpi
        k={a.gemini ? '普通槽排队' : '排队'}
        v={a.queue}
        x={a.queued ? `${a.queued} 台有排队` : '无排队'}
        tone={a.queue ? 'text-[color:var(--status-warn)]' : undefined}
      />
      {geminiZones.length > 0 ? (
        <div className='flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 pt-2 text-xs'>
          {geminiZones.map(({ key, label, tone, hint }) => (
            <span
              key={key}
              title={hint}
              className='inline-flex items-center gap-1.5'
            >
              <StatusMark tone={{ key, text: label, cls: tone }} />
              <b className='font-mono tabular-nums'>{a.by[key]}</b>
            </span>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function ToggleBtn({
  on,
  onClick,
  icon: Icon,
  children,
}: {
  on: boolean
  onClick: () => void
  icon: typeof Eye
  children: ReactNode
}) {
  return (
    <Button
      type='button'
      size='sm'
      variant={on ? 'default' : 'outline'}
      aria-pressed={on}
      className='h-7 gap-1 px-2 text-xs'
      onClick={onClick}
    >
      <Icon className='size-3.5' />
      {children}
    </Button>
  )
}

export function VmTable({
  vms,
  accounts,
  zoom = 100,
}: {
  vms: Vm[]
  accounts?: UsageAccountRow[]
  /** 列表放大，100–200。100 为原尺寸。 */
  zoom?: number
}) {
  const actions = useVmActions()
  const now = useNow()
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [grouped, setGrouped] = useFlag('kin.vm.list-group', false)
  const [pinSec, setPinSec] = useFlag('kin.vm.list-pin-sec', false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<VmZone>>(
    () => new Set<VmZone>(['off', 'none', 'dead'])
  )
  const toggleGroup = (k: VmZone) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  const rows = useMemo(() => {
    const list = vms.map((vm) => rowData(vm, accounts))
    if (!sort) return list
    const f = SORT_VALUE[sort.key]
    // 无数据永远排在最后，不随方向翻转。
    return list
      .map((r, i) => ({ r, i, v: f(r) }))
      .sort((a, b) => {
        if (a.v == null || b.v == null)
          return a.v == null && b.v == null ? a.i - b.i : a.v == null ? 1 : -1
        return sort.dir * (a.v - b.v) || a.i - b.i
      })
      .map((x) => x.r)
  }, [vms, accounts, sort])

  const total = useMemo(() => aggregate(rows), [rows])
  const sections = grouped
    ? ZONES.map(({ key: k }) => {
        const list = rows.filter((r) => zoneOf(r.vm) === k)
        return { key: k, rows: list, agg: aggregate(list), head: true }
      }).filter((g) => g.rows.length)
    : [{ key: 'all' as const, rows, agg: total, head: false }]

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev?.key === key
        ? prev.dir === (ASC_FIRST.has(key) ? 1 : -1)
          ? { key, dir: ASC_FIRST.has(key) ? -1 : 1 }
          : null
        : { key, dir: ASC_FIRST.has(key) ? 1 : -1 }
    )

  const setOpen = (id: string, open: boolean) =>
    setExpanded((prev) => {
      if (prev.has(id) === open) return prev
      const next = new Set(prev)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  const toggle = (id: string) => setOpen(id, !expanded.has(id))
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
      const list = [
        ...(e.currentTarget
          .closest('[data-vm-table]')
          ?.querySelectorAll<HTMLElement>('[data-vm-row]') ?? []),
      ]
      const next =
        list[list.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]
      if (next) {
        e.preventDefault()
        next.focus()
      }
    }
  }

  const stickyLeft = 'sticky z-[2] bg-[var(--row-bg)]'
  return (
    <div className='space-y-2'>
      <SummaryBar a={total} />
      <div className='flex items-center justify-end gap-1.5'>
        <ToggleBtn
          on={grouped}
          icon={Layers}
          onClick={() => setGrouped(!grouped)}
        >
          按状态分组
        </ToggleBtn>
        <ToggleBtn on={pinSec} icon={Eye} onClick={() => setPinSec(!pinSec)}>
          次要信息常显
        </ToggleBtn>
      </div>
      <div
        data-vm-table
        data-pin={pinSec}
        className='group/tbl overflow-x-auto rounded-lg border border-border/60 bg-card text-[12.5px]'
      >
        <div
          className='min-w-[1408px]'
          role='table'
          aria-label='槽位列表'
          style={zoom === 100 ? undefined : { zoom: zoom / 100 }}
        >
          <div
            role='row'
            className='sticky top-0 z-[6] grid h-8 border-b bg-muted/40 text-[11.5px] text-muted-foreground [--row-bg:var(--card)]'
            style={GRID}
          >
            <div role='columnheader' className={cn(stickyLeft, 'left-0')}>
              <span className='sr-only'>详情页</span>
            </div>
            <div
              role='columnheader'
              className={cn(stickyLeft, 'left-[34px] flex items-center px-2')}
            >
              槽位
            </div>
            {COLS.map((c, i) => {
              const active = sort && c.sort === sort.key
              return (
                <div
                  key={c.label}
                  role='columnheader'
                  aria-sort={
                    active
                      ? sort.dir > 0
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                  className={cn(
                    'flex min-w-0 items-center px-2 whitespace-nowrap',
                    c.num && 'justify-end',
                    active && 'font-semibold text-foreground'
                  )}
                >
                  {c.sort ? (
                    <button
                      type='button'
                      className='inline-flex items-center gap-0.5 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
                      title='点击排序'
                      onClick={() => onSort(c.sort!)}
                    >
                      {c.label}
                      {active ? (
                        sort.dir > 0 ? (
                          <ArrowUp className='size-2.5' />
                        ) : (
                          <ArrowDown className='size-2.5' />
                        )
                      ) : null}
                    </button>
                  ) : i === 0 && total.gemini > 0 ? (
                    total.gemini === total.n ? (
                      'Gemini 状态'
                    ) : (
                      '调度 · 优先级 / Gemini 状态'
                    )
                  ) : (
                    c.label
                  )}
                </div>
              )
            })}
            <div role='columnheader'>
              <span className='sr-only'>操作</span>
            </div>
          </div>
          {sections.map((sec) => {
            const isCol = sec.head && collapsed.has(sec.key as VmZone)
            const pct = aggPct(sec.agg)
            return (
              <Fragment key={sec.key}>
                {sec.head ? (
                  <div className='border-b bg-muted/50'>
                    <div className='sticky left-0 flex h-8 w-max items-center gap-4 px-2.5 text-[11.5px] whitespace-nowrap text-muted-foreground'>
                      <button
                        type='button'
                        aria-expanded={!isCol}
                        className='inline-flex items-center gap-1.5 rounded-sm font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
                        onClick={() => toggleGroup(sec.key as VmZone)}
                      >
                        <ChevronRight
                          className={cn(
                            'size-3 transition-transform motion-reduce:transition-none',
                            !isCol && 'rotate-90'
                          )}
                        />
                        {ZONES.find((z) => z.key === sec.key)?.label}
                        <span className='font-mono font-normal text-muted-foreground'>
                          {sec.rows.length} 台
                        </span>
                      </button>
                      <span>
                        成功率{' '}
                        <b className='font-mono text-foreground'>
                          {fmtHealthPct(pct)}
                        </b>
                      </span>
                      <span>
                        近 24h 请求{' '}
                        <b className='font-mono text-foreground'>
                          {fmtNum(sec.agg.req)}
                        </b>
                      </span>
                      <span>
                        7 天窗口花费{' '}
                        <b className='font-mono text-foreground'>
                          {sec.agg.spend ? fmtUsd(sec.agg.spend, 2) : '—'}
                        </b>
                      </span>
                      <span>
                        席位{' '}
                        <b className='font-mono text-foreground'>
                          {sec.agg.used}/{sec.agg.cap}
                        </b>
                      </span>
                      {isCol ? (
                        <span className='text-[color:var(--text-tertiary)]'>
                          已折叠
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {isCol
                  ? null
                  : sec.rows.map((r) => {
                      const vm = r.vm
                      const open = expanded.has(vm.id)
                      const label = vm.gemini
                        ? poolStatus(vm).text
                        : scheduleStateLabel(vm)
                      const dim = vm.gemini
                        ? vm.gemini.auth_state === 'disabled'
                        : label === '关'
                      const detailId = `vm-row-detail-${vm.id}`
                      const max = claudeTier(vm).key === 'max'
                      return (
                        <div key={vm.id} role='rowgroup'>
                          <div
                            data-vm-row
                            role='row'
                            tabIndex={0}
                            aria-expanded={open}
                            aria-label={`${vm.id}，${label}。Enter 展开明细，Shift+Enter 打开详情`}
                            className={cn(
                              'group relative grid cursor-pointer border-b border-[color:var(--hairline)] bg-[var(--row-bg)] outline-none [--row-bg:var(--card)] hover:[--row-bg:color-mix(in_oklab,var(--muted)_55%,var(--card))] focus-visible:after:pointer-events-none focus-visible:after:absolute focus-visible:after:inset-0 focus-visible:after:z-[4] focus-visible:after:border-2 focus-visible:after:border-ring',
                              vm.gemini ? 'min-h-[38px]' : 'h-[38px]',
                              open &&
                                '[--row-bg:color-mix(in_oklab,var(--muted)_75%,var(--card))]'
                            )}
                            style={GRID}
                            onClick={(e) => onRowClick(e, vm)}
                            onKeyDown={(e) => onRowKey(e, vm)}
                          >
                            <div
                              role='cell'
                              className={cn(
                                stickyLeft,
                                'left-0 flex items-center justify-center',
                                max &&
                                  'shadow-[inset_2px_0_0_var(--tier-max-border)]'
                              )}
                            >
                              <Button
                                type='button'
                                size='icon'
                                variant='ghost'
                                className='size-6 text-muted-foreground hover:text-foreground'
                                title='打开详情页（Shift+Enter）'
                                aria-label={`打开 ${vm.id} 详情页`}
                                onClick={() => actions.openDetail(vm)}
                              >
                                <ExternalLink className='size-3.5' />
                              </Button>
                            </div>
                            <div
                              role='cell'
                              className={cn(
                                stickyLeft,
                                'left-[34px] flex min-w-0 items-center gap-1.5 overflow-hidden px-2 whitespace-nowrap',
                                dim && 'opacity-50'
                              )}
                            >
                              <ProdCell vm={vm} />
                            </div>
                            {COLS.map((c, i) => (
                              <div
                                key={c.label}
                                role='cell'
                                className={cn(
                                  'flex min-w-0 items-center gap-[7px] overflow-hidden px-2 whitespace-nowrap',
                                  vm.gemini && i === 0 && 'py-1.5',
                                  c.num && NUM,
                                  c.dim && 'text-muted-foreground',
                                  // 调度列（第一列）保持可读，其余在关闭时淡出。
                                  dim && i > 0 && 'opacity-50'
                                )}
                              >
                                {vm.gemini && i > 0 ? (
                                  <span className={TERT}>—</span>
                                ) : (
                                  c.cell(r, now)
                                )}
                              </div>
                            ))}
                            <div
                              role='cell'
                              className='flex items-center justify-end gap-px pr-1'
                            >
                              <Button
                                type='button'
                                size='icon'
                                variant='ghost'
                                className='size-6 text-muted-foreground'
                                aria-expanded={open}
                                aria-controls={detailId}
                                aria-label={`${open ? '收起' : '展开'} ${vm.id} 明细`}
                                title='展开明细（Enter）'
                                onClick={() => toggle(vm.id)}
                              >
                                <ChevronDown
                                  className={cn(
                                    'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
                                    open && 'rotate-180'
                                  )}
                                />
                              </Button>
                              <span className={SEC}>
                                <VmActionMenu vm={vm} />
                              </span>
                            </div>
                          </div>
                          {open && vm.gemini ? (
                            <div
                              id={detailId}
                              className='flex items-center gap-3 border-b px-4 py-2 text-xs text-muted-foreground'
                            >
                              <span>{vm.email || '未提供邮箱'}</span>
                              <span>
                                {vm.gemini.account?.plan || '未提供订阅'}
                              </span>
                              <ProxyChip vm={vm} compact />
                              <Button
                                type='button'
                                size='sm'
                                variant='ghost'
                                onClick={() => actions.openDetail(vm)}
                              >
                                管理 Gemini 凭证
                              </Button>
                            </div>
                          ) : open ? (
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
              </Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}
