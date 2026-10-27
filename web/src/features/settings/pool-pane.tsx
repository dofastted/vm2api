import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowRightLeft,
  Armchair,
  Hourglass,
  Layers,
  Link2,
  ShieldAlert,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { fmtDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { SEAT_CAP_MAX, SeatCells } from '@/components/scheduler-viz'
import { SEAT_CAP_STEPS, withCurrent } from '@/features/vm/scheduling-steps'
import { PoolLivePanel } from './pool-live-panel'
import { ChipGroup, SliderSetting, StepperSetting } from './scheduler-controls'

type Obj = Record<string, unknown>
type PoolDialog = 'strategy' | 'seats' | 'queue' | 'retry' | 'circuit'

type PoolPaneProps = {
  pool: Obj
  failover: Obj
  inference: Obj
  onPoolChange: (patch: Obj) => void
  onFailoverChange: (patch: Obj) => void
  onInferenceChange: (patch: Obj) => void
  saving?: boolean
  pending?: boolean
}

/** 与后端 DEFAULT_POOL_ROUTING / failover-runner 默认值一致。 */
const POOL_DEFAULTS = {
  queue_max: 50,
  seat_grace_ms: 30000,
  seat_budget_reserve_pct: 0.02,
  sticky_wait_timeout_ms: 45000,
  fallback_wait_timeout_ms: 30000,
  circuit_failure_threshold: 3,
  circuit_open_ms: 30000,
}

const FAILOVER_DEFAULTS = {
  max_same_account_retries: 1,
  same_account_retry_delay_ms: 500,
  max_account_switches: 10,
  max_total_attempts: 12,
  total_retry_deadline_ms: 120000,
  oauth_401_cooldown_ms: 120000,
  same_account_retry_max_hop_ms: 10000,
  signature_repair: false,
  stream_idle_timeout_ms: 180000,
  max_request_mib: 32,
  eager_tool_streaming: true,
}

function numOf(source: Obj, key: string, fallback: number): number {
  const n = Number(source[key] ?? fallback)
  return Number.isFinite(n) ? n : fallback
}

const STRATEGIES: {
  id: 'balanced' | 'fill'
  title: string
  desc: string
  demo: number[]
  next: number
}[] = [
  {
    id: 'balanced',
    title: '平衡',
    desc: '新设备先去占用比例最低的 VM，负载摊平，单台额度消耗慢。',
    demo: [2, 1, 3],
    next: 1,
  },
  {
    id: 'fill',
    title: '填充',
    desc: '新设备先去占用比例最高、还没满的 VM，集中用满少数几台，其它保持空闲。',
    demo: [4, 3, 1],
    next: 1,
  },
]

function StrategyCards({
  value,
  onChange,
}: {
  value: 'balanced' | 'fill'
  onChange: (next: 'balanced' | 'fill') => void
}) {
  return (
    <div
      role='radiogroup'
      aria-label='开席策略'
      className='grid gap-3 sm:grid-cols-2'
    >
      {STRATEGIES.map((strategy) => {
        const selected = strategy.id === value
        return (
          <button
            key={strategy.id}
            type='button'
            role='radio'
            aria-checked={selected}
            onClick={() => onChange(strategy.id)}
            className={cn(
              'flex cursor-pointer flex-col gap-3 rounded-lg border p-3 text-left transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              selected
                ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                : 'hover:border-primary/40 hover:bg-accent/40'
            )}
          >
            <div className='flex items-center justify-between gap-2'>
              <span className='text-sm font-semibold'>{strategy.title}</span>
              <span
                aria-hidden
                className={cn(
                  'grid size-4 place-items-center rounded-full border',
                  selected ? 'border-primary' : 'border-muted-foreground/40'
                )}
              >
                {selected ? (
                  <span className='size-2 rounded-full bg-primary' />
                ) : null}
              </span>
            </div>
            <p className='text-xs leading-5 text-muted-foreground'>
              {strategy.desc}
            </p>
            <div className='grid grid-cols-3 gap-2 rounded-md bg-muted/40 p-2'>
              {strategy.demo.map((used, index) => (
                <div key={index} className='space-y-1'>
                  <div
                    className={cn(
                      'text-[10px] text-muted-foreground',
                      index === strategy.next && 'font-medium text-foreground'
                    )}
                  >
                    VM {String.fromCharCode(65 + index)}
                    {index === strategy.next ? ' ← 下一席' : ''}
                  </div>
                  <SeatCells
                    used={used}
                    max={4}
                    next={index === strategy.next}
                    size='sm'
                  />
                </div>
              ))}
            </div>
          </button>
        )
      })}
    </div>
  )
}

/** 第 k 个席位要求的余量阶梯：(已开 + 1) × 预留，超过 100% 的席位永远开不出。 */
function BudgetStairs({
  reservePct,
  cap,
}: {
  reservePct: number
  cap: number
}) {
  const reachable =
    reservePct > 0 ? Math.min(cap, Math.floor(100 / reservePct)) : cap
  return (
    <div className='space-y-1.5 rounded-md border bg-muted/30 p-2.5'>
      <div className='flex h-14 items-end gap-[3px]' aria-hidden>
        {Array.from({ length: cap }, (_, index) => {
          const need = (index + 1) * reservePct
          return (
            <div
              key={index}
              title={`第 ${index + 1} 席需余量 ≥ ${need.toFixed(1)}%`}
              className={cn(
                'flex-1 rounded-t-[2px]',
                need > 100
                  ? 'bg-[color:var(--status-bad-solid)]/70'
                  : 'bg-primary/60'
              )}
              style={{ height: `${Math.max(4, Math.min(100, need))}%` }}
            />
          )
        })}
      </div>
      <p className='text-[11px] leading-4 text-muted-foreground'>
        {reservePct > 0 ? (
          <>
            开第 1 席需 5h/7d 余量 ≥ {reservePct.toFixed(1)}%，开满 {cap} 席需 ≥{' '}
            {(cap * reservePct).toFixed(1)}%
            {reachable < cap ? (
              <span className='text-[color:var(--status-bad)]'>
                {' '}
                · 第 {reachable + 1} 席起永远开不出
              </span>
            ) : null}
            。余量未知（还没读到 /usage）时放行。
          </>
        ) : (
          '0% = 不看余量，只要席位没满就开。'
        )}
      </p>
    </div>
  )
}

function Segment({
  label,
  ms,
  total,
  className,
}: {
  label: string
  ms: number
  total: number
  className: string
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center justify-center overflow-hidden px-1 text-[10px] leading-5 font-medium whitespace-nowrap',
        className
      )}
      style={{ width: `${(ms / total) * 100}%` }}
      title={`${label} ${fmtDuration(ms)}`}
    >
      <span className='truncate'>
        {label} {fmtDuration(ms)}
      </span>
    </div>
  )
}

/** 一次请求最长能排多久：有家设备先守原 VM，再进全局；整体被总重试时限截断。 */
function QueueTimeline({
  sticky,
  fallback,
  deadline,
}: {
  sticky: number
  fallback: number
  deadline: number
}) {
  const total = Math.max(sticky + fallback, deadline, 1)
  const lanes: { title: string; segments: [string, number, string][] }[] = [
    {
      title: '回头设备（已有家 VM）',
      segments: [
        ['守原 VM', sticky, 'bg-primary/80 text-primary-foreground'],
        [
          '全局排队',
          fallback,
          'bg-[color:var(--status-caution-solid)] text-white',
        ],
      ],
    },
    {
      title: '新设备',
      segments: [
        [
          '全局排队',
          fallback,
          'bg-[color:var(--status-caution-solid)] text-white',
        ],
      ],
    },
  ]
  return (
    <div className='space-y-2 rounded-md border bg-muted/30 p-2.5'>
      {lanes.map((lane) => (
        <div key={lane.title} className='space-y-1'>
          <div className='text-[11px] text-muted-foreground'>{lane.title}</div>
          <div className='relative flex h-5 overflow-hidden rounded bg-muted'>
            {lane.segments.map(([label, ms, className]) => (
              <Segment
                key={label}
                label={label}
                ms={ms}
                total={total}
                className={className}
              />
            ))}
            <span className='ml-1 self-center text-[10px] font-semibold text-[color:var(--status-bad)]'>
              529
            </span>
            <div
              aria-hidden
              className='absolute inset-y-0 w-0.5 bg-[color:var(--status-bad-solid)]'
              style={{ left: `${Math.min(100, (deadline / total) * 100)}%` }}
            />
          </div>
        </div>
      ))}
      <p className='text-[11px] leading-4 text-muted-foreground'>
        红线 = 总重试时限 {fmtDuration(deadline)}
        ，任何等待都不会越过它；超时返回 529 <code>
          pool_queue_timeout
        </code>{' '}
        并带 retry-after。
      </p>
    </div>
  )
}

function CircuitFlow({
  threshold,
  openMs,
}: {
  threshold: number
  openMs: number
}) {
  const step = (icon: ReactNode, title: string, sub: string) => (
    <div className='flex min-w-0 flex-1 flex-col items-center gap-1 text-center'>
      <div className='flex h-6 items-center'>{icon}</div>
      <div className='text-[11px] font-medium'>{title}</div>
      <div className='text-[10px] leading-3 text-muted-foreground'>{sub}</div>
    </div>
  )
  const arrow = (
    <span aria-hidden className='mt-2 text-muted-foreground'>
      →
    </span>
  )
  return (
    <div className='flex items-start gap-1 rounded-md border bg-muted/30 p-2.5'>
      {step(
        <span className='flex flex-wrap justify-center gap-0.5'>
          {Array.from({ length: Math.min(threshold, 10) }, (_, index) => (
            <span
              key={index}
              className='size-2 rounded-full bg-[color:var(--status-bad-solid)]'
            />
          ))}
          {threshold > 10 ? (
            <span className='text-[10px]'>+{threshold - 10}</span>
          ) : null}
        </span>,
        `连续 ${threshold} 次 5xx`,
        '529 / 401 不计'
      )}
      {arrow}
      {step(
        <ShieldAlert className='size-5 text-[color:var(--status-bad)]' />,
        `熔断 ${fmtDuration(openMs)}`,
        '这台 VM 退出可选集'
      )}
      {arrow}
      {step(
        <Zap className='size-5 text-[color:var(--status-caution)]' />,
        '放行 1 个探测',
        '成功即恢复，失败再熔断'
      )}
    </div>
  )
}

function SummaryButton({
  icon: Icon,
  title,
  value,
  desc,
  pending,
  onClick,
  buttonRef,
  disabled,
}: {
  icon: LucideIcon
  title: string
  value: string
  desc: string
  pending: boolean
  onClick: () => void
  buttonRef: (node: HTMLButtonElement | null) => void
  disabled: boolean
}) {
  return (
    <Button
      ref={buttonRef}
      type='button'
      variant='outline'
      disabled={disabled}
      className='h-auto min-h-24 min-w-0 justify-start gap-3 px-3 py-3 text-left'
      onClick={onClick}
    >
      <span className='grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary'>
        <Icon className='size-4' aria-hidden />
      </span>
      <span className='min-w-0'>
        <span className='flex items-center gap-2 text-xs text-muted-foreground'>
          <span className='truncate'>{title}</span>
          {pending ? (
            <span className='shrink-0 rounded bg-[color:var(--status-caution)]/15 px-1.5 py-0.5 text-[10px] text-[color:var(--status-caution)]'>
              待保存
            </span>
          ) : null}
        </span>
        <span className='block truncate text-sm font-semibold'>{value}</span>
        <span className='block truncate text-xs font-normal text-muted-foreground'>
          {desc}
        </span>
      </span>
    </Button>
  )
}

export function PoolPane({
  pool,
  failover,
  inference,
  onPoolChange,
  onFailoverChange,
  onInferenceChange,
  saving = false,
  pending = false,
}: PoolPaneProps) {
  const strategy = pool.strategy === 'fill' ? 'fill' : 'balanced'
  const seatCap = Math.min(
    SEAT_CAP_MAX,
    Math.max(1, numOf(inference, 'session_slots', SEAT_CAP_MAX))
  )
  const queueMax = numOf(pool, 'queue_max', POOL_DEFAULTS.queue_max)
  const reservePct =
    Math.round(
      numOf(
        pool,
        'seat_budget_reserve_pct',
        POOL_DEFAULTS.seat_budget_reserve_pct
      ) * 1000
    ) / 10
  const sticky = numOf(
    pool,
    'sticky_wait_timeout_ms',
    POOL_DEFAULTS.sticky_wait_timeout_ms
  )
  const fallbackWait = numOf(
    pool,
    'fallback_wait_timeout_ms',
    POOL_DEFAULTS.fallback_wait_timeout_ms
  )
  const deadline = numOf(
    failover,
    'total_retry_deadline_ms',
    FAILOVER_DEFAULTS.total_retry_deadline_ms
  )
  const [open, setOpen] = useState<PoolDialog | null>(null)
  const [drafts, setDrafts] = useState<{
    pool: Obj
    failover: Obj
    inference: Obj
  }>({ pool: {}, failover: {}, inference: {} })
  const triggerRefs = useRef<
    Partial<Record<PoolDialog, HTMLButtonElement | null>>
  >({})
  const previousOpen = useRef<PoolDialog | null>(null)

  useEffect(() => {
    if (previousOpen.current && !open) {
      triggerRefs.current[previousOpen.current]?.focus()
    }
    previousOpen.current = open
  }, [open])

  const begin = (kind: PoolDialog) => {
    setDrafts({
      pool: { ...pool },
      failover: { ...failover },
      inference: { ...inference },
    })
    setOpen(kind)
  }
  const close = () => {
    if (!saving) setOpen(null)
  }
  const updateDraft = (key: 'pool' | 'failover' | 'inference', patch: Obj) => {
    setDrafts((current) => ({
      ...current,
      [key]: { ...current[key], ...patch },
    }))
  }
  const apply = () => {
    if (!open || saving) return
    const poolDraft = drafts.pool
    const failoverDraft = drafts.failover
    const inferenceDraft = drafts.inference
    if (open === 'strategy') {
      onPoolChange({
        strategy: poolDraft.strategy,
      })
    } else if (open === 'seats') {
      onInferenceChange({ session_slots: inferenceDraft.session_slots })
      onPoolChange({
        seat_grace_ms: poolDraft.seat_grace_ms,
        seat_budget_reserve_pct: poolDraft.seat_budget_reserve_pct,
      })
    } else if (open === 'queue') {
      onPoolChange({
        queue_max: poolDraft.queue_max,
        sticky_wait_timeout_ms: poolDraft.sticky_wait_timeout_ms,
        fallback_wait_timeout_ms: poolDraft.fallback_wait_timeout_ms,
      })
    } else if (open === 'retry') {
      onFailoverChange({
        max_same_account_retries: failoverDraft.max_same_account_retries,
        same_account_retry_delay_ms: failoverDraft.same_account_retry_delay_ms,
        max_account_switches: failoverDraft.max_account_switches,
        max_total_attempts: failoverDraft.max_total_attempts,
        total_retry_deadline_ms: failoverDraft.total_retry_deadline_ms,
        oauth_401_cooldown_ms: failoverDraft.oauth_401_cooldown_ms,
        same_account_retry_max_hop_ms:
          failoverDraft.same_account_retry_max_hop_ms,
        signature_repair: failoverDraft.signature_repair,
        delivery_mode: failoverDraft.delivery_mode,
        stream_idle_timeout_ms: failoverDraft.stream_idle_timeout_ms,
        ...(Number.isFinite(Number(failoverDraft.max_request_mib))
          ? {
              max_request_mib: numOf(
                failoverDraft,
                'max_request_mib',
                FAILOVER_DEFAULTS.max_request_mib
              ),
            }
          : {}),
        eager_tool_streaming: failoverDraft.eager_tool_streaming !== false,
      })
    } else {
      onPoolChange({
        circuit_failure_threshold: poolDraft.circuit_failure_threshold,
        circuit_open_ms: poolDraft.circuit_open_ms,
      })
    }
    setOpen(null)
  }

  const poolDraft = drafts.pool
  const failoverDraft = drafts.failover
  const inferenceDraft = drafts.inference
  const dialogTitle =
    open === 'strategy'
      ? '开席策略'
      : open === 'seats'
        ? '席位容量'
        : open === 'queue'
          ? '排队等待'
          : open === 'retry'
            ? '重试与切号'
            : '故障保护'

  return (
    <div className='space-y-4'>
      <PoolLivePanel strategy={strategy} queueMax={queueMax} />
      <div className='grid grid-cols-1 gap-3 lg:grid-cols-3'>
        <SummaryButton
          icon={Layers}
          title='分配策略'
          value={strategy === 'fill' ? '填充' : '平衡'}
          desc='Claude 新 session 开席的优先顺序'
          pending={pending}
          disabled={saving}
          buttonRef={(node) => {
            triggerRefs.current.strategy = node
          }}
          onClick={() => begin('strategy')}
        />
        <SummaryButton
          icon={Armchair}
          title='席位容量'
          value={`${seatCap} 席 / VM`}
          desc={`对话结束即释放 · 预算预留 ${reservePct}%`}
          pending={pending}
          disabled={saving}
          buttonRef={(node) => {
            triggerRefs.current.seats = node
          }}
          onClick={() => begin('seats')}
        />
        <SummaryButton
          icon={Hourglass}
          title='排队等待'
          value={`${queueMax} 个 · ${fmtDuration(Math.max(sticky, fallbackWait))}`}
          desc={`粘性 ${fmtDuration(sticky)} · 全局 ${fmtDuration(fallbackWait)}`}
          pending={pending}
          disabled={saving}
          buttonRef={(node) => {
            triggerRefs.current.queue = node
          }}
          onClick={() => begin('queue')}
        />
      </div>
      <div className='flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3 py-2 text-xs'>
        <span className='font-medium'>辅助设置</span>
        <button
          type='button'
          disabled={saving}
          ref={(node) => {
            triggerRefs.current.retry = node
          }}
          className='inline-flex min-h-11 items-center gap-1 text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50'
          onClick={() => begin('retry')}
        >
          <ArrowRightLeft className='size-3.5' aria-hidden /> 重试与切号
        </button>
        <button
          type='button'
          disabled={saving}
          ref={(node) => {
            triggerRefs.current.circuit = node
          }}
          className='inline-flex min-h-11 items-center gap-1 text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50'
          onClick={() => begin('circuit')}
        >
          <ShieldAlert className='size-3.5' aria-hidden /> 故障保护
        </button>
        <a
          className='inline-flex min-h-11 items-center gap-1 text-primary hover:underline'
          href='/console/#/vm'
        >
          <Link2 className='size-3.5' aria-hidden /> 账号优先级 · VM 调度
        </a>
        <a
          className='inline-flex min-h-11 items-center gap-1 text-primary hover:underline'
          href='/console/#/settings/sticky'
        >
          <Link2 className='size-3.5' aria-hidden /> 粘性设置
        </a>
      </div>
      <Dialog
        open={open !== null}
        onOpenChange={(next) => {
          if (!next && !saving) close()
        }}
      >
        <DialogContent
          showCloseButton={!saving}
          className='flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl'
        >
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>
              应用到草稿后，点击页面底部保存才会写入运行配置。
            </DialogDescription>
          </DialogHeader>
          <fieldset
            disabled={saving}
            className='min-h-0 flex-1 space-y-4 overflow-y-auto pr-1'
          >
            {open === 'strategy' ? (
              <>
                <StrategyCards
                  value={poolDraft.strategy === 'fill' ? 'fill' : 'balanced'}
                  onChange={(next) => updateDraft('pool', { strategy: next })}
                />
              </>
            ) : null}
            {open === 'seats' ? (
              <>
                <div className='space-y-2'>
                  <Label>每台 VM 席位上限</Label>
                  <ChipGroup
                    label='每台 VM 席位上限'
                    value={Math.min(
                      SEAT_CAP_MAX,
                      Math.max(
                        1,
                        numOf(inferenceDraft, 'session_slots', SEAT_CAP_MAX)
                      )
                    )}
                    options={withCurrent(
                      SEAT_CAP_STEPS.map((value): [number, string] => [
                        value,
                        String(value),
                      ]),
                      seatCap
                    )}
                    onChange={(value) =>
                      updateDraft('inference', { session_slots: value })
                    }
                  />
                  <SeatCells
                    used={0}
                    max={Math.min(
                      SEAT_CAP_MAX,
                      Math.max(
                        1,
                        numOf(inferenceDraft, 'session_slots', SEAT_CAP_MAX)
                      )
                    )}
                  />
                </div>
                <SliderSetting
                  id='pool-seat-grace'
                  label='旧席位宽限（不再释放槽位）'
                  value={numOf(
                    poolDraft,
                    'seat_grace_ms',
                    POOL_DEFAULTS.seat_grace_ms
                  )}
                  min={0}
                  max={120000}
                  step={5000}
                  format={(ms) => (ms ? fmtDuration(ms) : '不保留')}
                  fallback={POOL_DEFAULTS.seat_grace_ms}
                  presets={[0, 10000, 30000, 60000, 120000]}
                  onChange={(ms) => updateDraft('pool', { seat_grace_ms: ms })}
                />
                <SliderSetting
                  id='pool-seat-reserve'
                  label='每席位预算预留'
                  value={
                    numOf(
                      poolDraft,
                      'seat_budget_reserve_pct',
                      POOL_DEFAULTS.seat_budget_reserve_pct
                    ) * 100
                  }
                  min={0}
                  max={50}
                  step={0.5}
                  format={(value) => `${value}%`}
                  fallback={POOL_DEFAULTS.seat_budget_reserve_pct * 100}
                  presets={[0, 1, 2, 5, 10]}
                  onChange={(value) =>
                    updateDraft('pool', {
                      seat_budget_reserve_pct: Math.round(value * 10) / 1000,
                    })
                  }
                />
                <BudgetStairs
                  reservePct={
                    numOf(
                      poolDraft,
                      'seat_budget_reserve_pct',
                      POOL_DEFAULTS.seat_budget_reserve_pct
                    ) * 100
                  }
                  cap={Math.min(
                    SEAT_CAP_MAX,
                    Math.max(
                      1,
                      numOf(inferenceDraft, 'session_slots', SEAT_CAP_MAX)
                    )
                  )}
                />
              </>
            ) : null}
            {open === 'queue' ? (
              <>
                <SliderSetting
                  id='pool-queue-max'
                  label='允许排队数量'
                  value={numOf(poolDraft, 'queue_max', POOL_DEFAULTS.queue_max)}
                  min={1}
                  max={999}
                  format={(value) => `${value} 个`}
                  fallback={POOL_DEFAULTS.queue_max}
                  presets={[10, 20, 50, 100, 200, 500]}
                  onChange={(value) =>
                    updateDraft('pool', { queue_max: value })
                  }
                />
                <SliderSetting
                  id='pool-sticky-wait'
                  label='粘性等待'
                  value={numOf(
                    poolDraft,
                    'sticky_wait_timeout_ms',
                    POOL_DEFAULTS.sticky_wait_timeout_ms
                  )}
                  min={1000}
                  max={120000}
                  step={1000}
                  format={fmtDuration}
                  fallback={POOL_DEFAULTS.sticky_wait_timeout_ms}
                  presets={[15000, 30000, 45000, 60000, 120000]}
                  onChange={(value) =>
                    updateDraft('pool', {
                      sticky_wait_timeout_ms: value,
                    })
                  }
                />
                <SliderSetting
                  id='pool-fallback-wait'
                  label='全局等待'
                  value={numOf(
                    poolDraft,
                    'fallback_wait_timeout_ms',
                    POOL_DEFAULTS.fallback_wait_timeout_ms
                  )}
                  min={1000}
                  max={120000}
                  step={1000}
                  format={fmtDuration}
                  fallback={POOL_DEFAULTS.fallback_wait_timeout_ms}
                  presets={[10000, 30000, 60000, 120000]}
                  onChange={(value) =>
                    updateDraft('pool', {
                      fallback_wait_timeout_ms: value,
                    })
                  }
                />
                <QueueTimeline
                  sticky={numOf(
                    poolDraft,
                    'sticky_wait_timeout_ms',
                    POOL_DEFAULTS.sticky_wait_timeout_ms
                  )}
                  fallback={numOf(
                    poolDraft,
                    'fallback_wait_timeout_ms',
                    POOL_DEFAULTS.fallback_wait_timeout_ms
                  )}
                  deadline={deadline}
                />
              </>
            ) : null}
            {open === 'retry' ? (
              <>
                <SliderSetting
                  id='failover-total-deadline'
                  label='总重试时限'
                  value={numOf(
                    failoverDraft,
                    'total_retry_deadline_ms',
                    FAILOVER_DEFAULTS.total_retry_deadline_ms
                  )}
                  min={10000}
                  max={600000}
                  step={5000}
                  format={fmtDuration}
                  fallback={FAILOVER_DEFAULTS.total_retry_deadline_ms}
                  presets={[60000, 120000, 300000, 600000]}
                  onChange={(value) =>
                    updateDraft('failover', {
                      total_retry_deadline_ms: value,
                    })
                  }
                />
                <SliderSetting
                  id='failover-stream-idle'
                  label='流空闲超时'
                  desc='上游流连续无事件超过此时长即断开；大文件 Write 会被上游整段缓冲，过短会误断。未在面板设置时可用控制面环境变量 KIN_STREAM_IDLE_TIMEOUT（毫秒）。保存后各槽 kernel 会在没有请求时自动重启以应用新值。'
                  value={numOf(
                    failoverDraft,
                    'stream_idle_timeout_ms',
                    FAILOVER_DEFAULTS.stream_idle_timeout_ms
                  )}
                  min={30000}
                  max={3600000}
                  step={30000}
                  format={fmtDuration}
                  fallback={FAILOVER_DEFAULTS.stream_idle_timeout_ms}
                  presets={[180000, 300000, 600000, 900000, 1800000]}
                  onChange={(value) =>
                    updateDraft('failover', {
                      stream_idle_timeout_ms: value,
                    })
                  }
                />
                <SliderSetting
                  id='failover-max-request'
                  label='请求体上限'
                  desc='入站请求超过此大小返回 413。未设置时槽内 kernel 仍是 32 MiB；保存后各槽 kernel 会在没有请求时自动重启以应用新值。网关不会放行超过 KIN_MAX_BODY 的请求。'
                  value={numOf(
                    failoverDraft,
                    'max_request_mib',
                    FAILOVER_DEFAULTS.max_request_mib
                  )}
                  min={8}
                  max={128}
                  step={8}
                  format={(value) => `${value} MiB`}
                  fallback={FAILOVER_DEFAULTS.max_request_mib}
                  presets={[32, 64, 128]}
                  onChange={(value) =>
                    updateDraft('failover', { max_request_mib: value })
                  }
                />
                <div className='flex items-center justify-between gap-4 rounded-md border px-3 py-2.5'>
                  <div>
                    <Label htmlFor='failover-eager-tool-streaming'>
                      工具参数流式下发
                    </Label>
                    <p className='text-xs leading-5 text-muted-foreground'>
                      默认开启。给所有自定义工具加 eager_input_streaming（官方
                      Claude Code
                      直连官方地址并开启细粒度工具流式时的形态），大文件 Write
                      内容边生成边下发，避免经中转时长静默触发空闲超时。显式关闭后恢复整段缓冲；客户端自带的布尔值优先。
                    </p>
                  </div>
                  <Switch
                    id='failover-eager-tool-streaming'
                    checked={failoverDraft.eager_tool_streaming !== false}
                    onCheckedChange={(value) =>
                      updateDraft('failover', { eager_tool_streaming: value })
                    }
                  />
                </div>
                <SliderSetting
                  id='failover-oauth-cooldown'
                  label='OAuth 401 冷却'
                  value={numOf(
                    failoverDraft,
                    'oauth_401_cooldown_ms',
                    FAILOVER_DEFAULTS.oauth_401_cooldown_ms
                  )}
                  min={5000}
                  max={600000}
                  step={5000}
                  format={fmtDuration}
                  fallback={FAILOVER_DEFAULTS.oauth_401_cooldown_ms}
                  presets={[30000, 60000, 120000, 300000, 600000]}
                  onChange={(value) =>
                    updateDraft('failover', {
                      oauth_401_cooldown_ms: value,
                    })
                  }
                />
                <StepperSetting
                  id='failover-same-retries'
                  label='同 VM 重试'
                  value={numOf(
                    failoverDraft,
                    'max_same_account_retries',
                    FAILOVER_DEFAULTS.max_same_account_retries
                  )}
                  min={0}
                  max={5}
                  unit='次'
                  fallback={FAILOVER_DEFAULTS.max_same_account_retries}
                  onChange={(value) =>
                    updateDraft('failover', {
                      max_same_account_retries: value,
                    })
                  }
                />
                <SliderSetting
                  id='failover-same-delay'
                  label='同 VM 重试间隔'
                  value={numOf(
                    failoverDraft,
                    'same_account_retry_delay_ms',
                    FAILOVER_DEFAULTS.same_account_retry_delay_ms
                  )}
                  min={0}
                  max={5000}
                  step={100}
                  format={(ms) => (ms ? fmtDuration(ms) : '立即')}
                  fallback={FAILOVER_DEFAULTS.same_account_retry_delay_ms}
                  presets={[0, 250, 500, 1000, 2000]}
                  onChange={(value) =>
                    updateDraft('failover', {
                      same_account_retry_delay_ms: value,
                    })
                  }
                />
                <SliderSetting
                  id='failover-same-hop'
                  label='同 VM 单次重试最长占用'
                  value={numOf(
                    failoverDraft,
                    'same_account_retry_max_hop_ms',
                    FAILOVER_DEFAULTS.same_account_retry_max_hop_ms
                  )}
                  min={0}
                  max={30000}
                  step={500}
                  format={(ms) => (ms ? fmtDuration(ms) : '不限')}
                  fallback={FAILOVER_DEFAULTS.same_account_retry_max_hop_ms}
                  presets={[0, 5000, 10000, 20000, 30000]}
                  onChange={(value) =>
                    updateDraft('failover', {
                      same_account_retry_max_hop_ms: value,
                    })
                  }
                />
                <StepperSetting
                  id='failover-switches'
                  label='切号上限'
                  value={numOf(
                    failoverDraft,
                    'max_account_switches',
                    FAILOVER_DEFAULTS.max_account_switches
                  )}
                  min={0}
                  max={50}
                  unit='次'
                  fallback={FAILOVER_DEFAULTS.max_account_switches}
                  onChange={(value) =>
                    updateDraft('failover', {
                      max_account_switches: value,
                    })
                  }
                />
                <StepperSetting
                  id='failover-total'
                  label='总尝试'
                  value={numOf(
                    failoverDraft,
                    'max_total_attempts',
                    FAILOVER_DEFAULTS.max_total_attempts
                  )}
                  min={1}
                  max={50}
                  unit='次'
                  fallback={FAILOVER_DEFAULTS.max_total_attempts}
                  onChange={(value) =>
                    updateDraft('failover', {
                      max_total_attempts: value,
                    })
                  }
                />
                <ChipGroup
                  label='流式交付'
                  value={
                    failoverDraft.delivery_mode === 'verified'
                      ? 'verified'
                      : 'realtime'
                  }
                  options={
                    [
                      ['realtime', 'realtime · 实时'],
                      ['verified', 'verified · 校验后'],
                    ] as ['realtime' | 'verified', string][]
                  }
                  onChange={(value) =>
                    updateDraft('failover', { delivery_mode: value })
                  }
                />
                <div className='flex items-center justify-between gap-4 rounded-md border px-3 py-2.5'>
                  <div>
                    <Label htmlFor='failover-signature-repair'>
                      启用签名修复
                    </Label>
                    <p className='text-xs leading-5 text-muted-foreground'>
                      仅对可修复的签名错误执行一次修复跳转。
                    </p>
                  </div>
                  <Switch
                    id='failover-signature-repair'
                    checked={failoverDraft.signature_repair === true}
                    onCheckedChange={(value) =>
                      updateDraft('failover', { signature_repair: value })
                    }
                  />
                </div>
              </>
            ) : null}
            {open === 'circuit' ? (
              <>
                <StepperSetting
                  id='pool-circuit-threshold'
                  label='熔断失败次数'
                  value={numOf(
                    poolDraft,
                    'circuit_failure_threshold',
                    POOL_DEFAULTS.circuit_failure_threshold
                  )}
                  min={1}
                  max={20}
                  unit='次'
                  fallback={POOL_DEFAULTS.circuit_failure_threshold}
                  onChange={(value) =>
                    updateDraft('pool', {
                      circuit_failure_threshold: value,
                    })
                  }
                />
                <SliderSetting
                  id='pool-circuit-open'
                  label='熔断打开时长'
                  value={numOf(
                    poolDraft,
                    'circuit_open_ms',
                    POOL_DEFAULTS.circuit_open_ms
                  )}
                  min={1000}
                  max={600000}
                  step={1000}
                  format={fmtDuration}
                  fallback={POOL_DEFAULTS.circuit_open_ms}
                  presets={[10000, 30000, 60000, 120000, 300000]}
                  onChange={(value) =>
                    updateDraft('pool', { circuit_open_ms: value })
                  }
                />
                <CircuitFlow
                  threshold={numOf(
                    poolDraft,
                    'circuit_failure_threshold',
                    POOL_DEFAULTS.circuit_failure_threshold
                  )}
                  openMs={numOf(
                    poolDraft,
                    'circuit_open_ms',
                    POOL_DEFAULTS.circuit_open_ms
                  )}
                />
              </>
            ) : null}
          </fieldset>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={saving}
              className='min-h-11'
              onClick={close}
            >
              取消
            </Button>
            <Button
              type='button'
              disabled={saving}
              className='min-h-11'
              onClick={apply}
            >
              应用到草稿
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
