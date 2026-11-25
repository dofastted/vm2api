import { useQueryClient } from '@tanstack/react-query'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { Download, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import {
  expiresAtToMs,
  fmtResetClock,
  resetCountdown,
} from '@/lib/fable-status'
import { fmtNum, fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { vmCostLedger } from '@/lib/vm-usage'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import type { GeminiEnvironment } from '@/features/import/gemini-environments'
import {
  geminiResource,
  syncGeminiEnvironment,
  useGeminiBusy,
  useGeminiMutation,
} from '@/features/import/gemini-operations'
import { ActiveUsageAction } from '@/features/vm/active-usage-action'
import { ClaudeResetActions } from '@/features/vm/claude-reset-actions'
import { OpenaiQuotaActions } from '@/features/vm/openai-quota-actions'
import { riskFg, UsageMeter } from '@/features/vm/usage-meter'
import { vmWindows, type WindowReadout } from '@/features/vm/vm-rack-model'
import { windowTiming, type WindowTiming } from '@/features/vm/window-timing'

/**
 * 请求 / 用量窗口 / 成本三块共用的行高。列表里三列并排时，
 * 5H、7D 与第三行（Fable / 总计）逐行落在同一条基线上。
 */
export const METRIC_ROW = 'h-5'

const MUTED_NUM = 'text-[color:var(--text-tertiary)]'

const WINDOW_GRID =
  'grid grid-cols-[2.25rem_minmax(2.5rem,1fr)_2.25rem_3.25rem] items-center gap-x-1'

function WindowRow({
  w,
  now,
  hasToken,
  quiet,
}: {
  w: WindowReadout
  now: number
  hasToken: boolean
  quiet: boolean
}) {
  // 无凭证槽没有窗口，倒计时无意义；有票才算。
  const reset = hasToken ? resetCountdown(w.reset, now) : null
  const clock =
    hasToken && expiresAtToMs(w.reset)
      ? `重置于 ${fmtResetClock(w.reset)}`
      : undefined
  const pct = w.pct
  return (
    <div className={cn(WINDOW_GRID, METRIC_ROW)}>
      <span className='text-xs font-medium text-muted-foreground'>
        {w.label}
      </span>
      {w.note ? (
        <span
          className='col-span-2 truncate text-xs font-medium text-[color:var(--status-warn)]'
          title={w.note}
        >
          {w.note}
        </span>
      ) : (
        <>
          {pct == null ? (
            <div
              className='h-[5px] w-full rounded-full track-recessed'
              aria-hidden='true'
            />
          ) : (
            <UsageMeter value={pct} size='sm' ticks={false} />
          )}
          <span
            className={cn(
              'text-right font-mono text-xs font-medium tabular-nums',
              pct == null
                ? MUTED_NUM
                : // 分诊面上绿色数字铺满一屏是噪声，颜色只留给越过 70% 的档。
                  (!quiet || pct >= 70) && riskFg(pct)
            )}
            title={pct == null ? '未探测' : undefined}
          >
            {pct == null ? '—' : `${pct.toFixed(0)}%`}
          </span>
        </>
      )}
      <span
        className='truncate text-right font-mono text-[11px] text-muted-foreground tabular-nums'
        title={clock}
      >
        {reset ?? ''}
      </span>
    </div>
  )
}

function observationPercent(value: number | null | undefined) {
  return value == null || !Number.isFinite(value)
    ? '未知'
    : `${(value * 100).toFixed(0)}%`
}

/** Mutable stored state, not raw query receipts; shown only on divergence or staleness. */
export function ClaudeQuotaObservations({ vm, now }: { vm: Vm; now: number }) {
  const observations = vm.quota_observations
  const official = observations?.official
  if (isCodexVm(vm) || !official) return null
  const windows = ['5h', '7d'] as const
  const isStale = (
    sample: { reset?: string | null; stale?: boolean } | null | undefined
  ) => {
    const reset = expiresAtToMs(sample?.reset)
    return Boolean(
      sample?.stale || (reset != null && reset > 0 && reset <= now)
    )
  }
  const different = windows.some((key) => {
    const measured = official[key]?.utilization
    const displayed = key === '5h' ? vm.utilization_5h : vm.utilization_7d
    return measured != null && displayed != null && measured !== displayed
  })
  const hasStale = windows.some((key) => isStale(official[key]))
  if (!different && !hasStale) return null
  return (
    <details
      className='min-w-0 text-[11px] text-muted-foreground'
      data-row-actions
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <summary className='cursor-pointer'>
        官方侧存储：5H {observationPercent(official['5h']?.utilization)} · 7D{' '}
        {observationPercent(official['7d']?.utilization)}
        {different ? ' · 与当前展示不同' : ''}
      </summary>
      <div className='mt-1 grid gap-1 break-words'>
        {windows.map((key) => (
          <div key={key}>
            {key.toUpperCase()}
            {(
              [
                ['官方侧存储', official[key]],
                ['保守合并记录', observations.passive[key]],
              ] as const
            ).map(([label, sample]) => {
              const stale = isStale(sample)
              return (
                <p key={label}>
                  {label}：{observationPercent(sample?.utilization)}
                  {stale ? '（陈旧）' : ''} · 状态 {sample?.status || '未知'} ·
                  重置 {sample?.reset || '未知'} ·{' '}
                  {sample?.sampled_at || '窗口采样时间未知'}
                </p>
              )
            })}
          </div>
        ))}
        <p>
          官方侧保留时间：{official.updated_at || '未知'}
          （不保证对应单窗口采样；重置后可能被响应头校正，并非官方查询原始回执，不改变保守调度规则）。
        </p>
      </div>
    </details>
  )
}

function GeminiQuotaActions({ vm }: { vm: Vm }) {
  const qc = useQueryClient()
  const busy = useGeminiBusy()
  const env = vm.gemini
  const action = useGeminiMutation({
    mutationFn: (kind: 'refresh' | 'models') =>
      api<GeminiEnvironment>(`${geminiResource(vm.id)}/${kind}`, {
        method: 'POST',
      }),
    onSuccess: async (updated, kind) => {
      await syncGeminiEnvironment(qc, updated)
      toast.success(
        kind === 'refresh' ? '已刷新 Gemini 账号与额度' : '已拉取可用模型'
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })
  if (!env) return null
  const canRefresh =
    (env.auth_state === 'authorized' || env.auth_state === 'reauth_required') &&
    env.proxy_ready !== false
  const canModels = env.auth_state === 'authorized' && env.proxy_ready !== false
  return (
    <div
      data-row-actions
      className='flex flex-wrap items-center gap-1'
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Button
        type='button'
        size='sm'
        variant='ghost'
        className='h-6 gap-1 px-1.5 text-[11px] text-muted-foreground'
        disabled={busy || !canRefresh}
        loading={action.isPending && action.variables === 'refresh'}
        title='刷新上游账号状态与配额窗口'
        onClick={() => action.mutate('refresh')}
      >
        <RefreshCw className='size-3' />
        刷新数据
      </Button>
      <Button
        type='button'
        size='sm'
        variant='ghost'
        className='h-6 gap-1 px-1.5 text-[11px] text-muted-foreground'
        disabled={busy || !canModels}
        loading={action.isPending && action.variables === 'models'}
        title='从上游重新拉取可调用模型列表'
        onClick={() => action.mutate('models')}
      >
        <Download className='size-3' />
        拉取模型
      </Button>
    </div>
  )
}

/** GPT 槽：刷新额度和积分 / 使用重置券；Claude 完整 OAuth：原生限额查询 / 重置；Gemini：刷新数据 / 拉取模型。 */
export function VmQuotaActions({ vm, now }: { vm: Vm; now: number }) {
  if (vm.gemini) return <GeminiQuotaActions vm={vm} />
  return isCodexVm(vm) ? (
    <OpenaiQuotaActions vm={vm} compact now={now} />
  ) : (
    <div className='flex flex-wrap items-center gap-1'>
      <ActiveUsageAction vm={vm} />
      <ClaudeResetActions vm={vm} compact now={now} />
    </div>
  )
}

/**
 * 额度窗口：标签 | 占用条 | 百分比 | 重置倒计时。只回答「还能用多少」，
 * 费用与 token 一律在 `VmCostLedger`。未探测画「—」，不画 0% 冒充还很空。
 */
export function VmUsageWindows({
  vm,
  now,
  quiet = false,
  quotaActions = false,
  className,
}: {
  vm: Vm
  /** 调用方持有时钟：机架与列表整页共用一个，不在每行各起计时器。 */
  now: number
  quiet?: boolean
  quotaActions?: boolean
  className?: string
}) {
  const hasToken = Boolean(vm.has_token)
  return (
    <div className={cn('grid min-w-0 gap-1', className)}>
      {vmWindows(vm).map((w) => (
        <WindowRow
          key={w.key}
          w={w}
          now={now}
          hasToken={hasToken}
          quiet={quiet}
        />
      ))}
      {quotaActions ? <VmQuotaActions vm={vm} now={now} /> : null}
    </div>
  )
}

// 数值列保持完整；金额与 token 靠右成组，不随容器宽度分散。
const LEDGER_GRID =
  'grid grid-cols-[2.25rem_minmax(max-content,1fr)_max-content] items-center gap-x-2 gap-y-1'

/**
 * 成本账：5H / 7D / 总计 × 费用 · token。整页每台槽位的费用与 token
 * 只在这里出现一次，官方价口径。
 */
export function VmCostLedger({
  vm,
  accounts,
  className,
}: {
  vm: Vm
  accounts?: UsageAccountRow[]
  className?: string
}) {
  return (
    <div className={cn(LEDGER_GRID, 'min-w-0', className)}>
      {vmCostLedger(vm, accounts).map((r) => {
        const total = r.key === 'total'
        return (
          <div
            key={r.key}
            className={cn(
              'col-span-3 grid grid-cols-subgrid items-center',
              METRIC_ROW,
              total && 'shadow-[inset_0_1px_0_var(--hairline)]'
            )}
          >
            <span
              title={r.note}
              className={cn(
                'text-xs font-medium',
                total ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {r.label}
            </span>
            <span
              className={cn(
                'text-right font-mono text-xs whitespace-nowrap tabular-nums',
                !r.cost
                  ? MUTED_NUM
                  : total
                    ? 'font-semibold text-foreground'
                    : 'text-foreground/80'
              )}
            >
              {fmtUsd(r.cost, 2)}
            </span>
            <span
              className={cn(
                'text-right font-mono text-xs whitespace-nowrap tabular-nums',
                r.tokens ? 'text-muted-foreground' : MUTED_NUM
              )}
            >
              {fmtNum(r.tokens)}
              <span className={MUTED_NUM}> tok</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

const PANEL_HEAD =
  'mb-1.5 flex items-baseline justify-between gap-2 text-xs font-medium text-muted-foreground'

/** 弹窗里的用量块：左额度窗口，右成本账，行与行对齐，和列表同一套组件。 */
export function VmUsagePanel({
  vm,
  accounts,
}: {
  vm: Vm
  accounts?: UsageAccountRow[]
}) {
  const now = useNow()
  return (
    <div className='grid gap-x-5 gap-y-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]'>
      <div className='min-w-0'>
        <h3 className={PANEL_HEAD}>用量窗口</h3>
        <VmUsageWindows vm={vm} now={now} quotaActions />
      </div>
      <div className='min-w-0 sm:border-s sm:border-[color:var(--hairline)] sm:ps-5'>
        <h3 className={PANEL_HEAD}>
          成本
          <span className='text-[11px] font-normal text-[color:var(--text-tertiary)]'>
            官方价
          </span>
        </h3>
        <VmCostLedger vm={vm} accounts={accounts} />
      </div>
    </div>
  )
}

function TimeTick({ pct }: { pct: number | null }) {
  if (pct == null) return null
  return (
    <span
      aria-hidden
      className='pointer-events-none absolute -top-0.5 -bottom-0.5 w-0.5 rounded-full bg-foreground/55'
      style={{ left: `calc(${pct}% - 1px)` }}
    />
  )
}

/** 带时间进度竖线的用量条；竖线在填充左边 = 用得比时间快。 */
export function WindowBar({
  w,
  timing,
  size = 'sm',
}: {
  w: WindowReadout
  timing: WindowTiming
  size?: 'sm' | 'md'
}) {
  return (
    <div className='relative'>
      {w.pct == null ? (
        <div
          className={cn(
            'w-full rounded-full track-recessed',
            size === 'sm' ? 'h-[5px]' : 'h-2'
          )}
          aria-hidden
        />
      ) : (
        <UsageMeter value={w.pct} size={size} ticks={false} />
      )}
      <TimeTick pct={timing.elapsedPct} />
    </div>
  )
}

/** 列表行内：5H / 7D / Fable 横排，每格 百分比 + 条 + 倒计时。 */
export function VmUsageWindowsInline({ vm, now }: { vm: Vm; now: number }) {
  const hasToken = Boolean(vm.has_token)
  return (
    <div className='grid min-w-0 grid-cols-3 gap-2.5'>
      {vmWindows(vm).map((w) => {
        const timing = windowTiming(w, now)
        const left = hasToken ? resetCountdown(w.reset, now) : null
        const full = w.pct != null && w.pct >= 100
        return (
          <div
            key={w.key}
            className='min-w-0'
            title={
              hasToken && expiresAtToMs(w.reset)
                ? `重置于 ${fmtResetClock(w.reset)}`
                : undefined
            }
          >
            <div className='flex items-baseline justify-between gap-1 text-[11px]'>
              <span className='font-medium text-muted-foreground'>
                {w.label}
              </span>
              {w.note ? null : (
                <span
                  className={cn(
                    'font-mono font-semibold tabular-nums',
                    w.pct == null ? MUTED_NUM : w.pct >= 70 && riskFg(w.pct)
                  )}
                >
                  {w.pct == null ? '—' : `${w.pct.toFixed(0)}%`}
                </span>
              )}
            </div>
            {w.note ? (
              <div
                className='mt-0.5 truncate text-[11px] font-medium text-[color:var(--status-warn)]'
                title={w.note}
              >
                {w.note}
              </div>
            ) : (
              <>
                <div className='mt-1'>
                  <WindowBar w={w} timing={timing} />
                </div>
                <div
                  className={cn(
                    'mt-0.5 truncate font-mono text-[10.5px] tabular-nums',
                    full
                      ? 'text-[color:var(--status-bad)]'
                      : 'text-muted-foreground'
                  )}
                >
                  {w.pct == null
                    ? '未探测'
                    : left
                      ? full
                        ? `${left}后恢复`
                        : left
                      : '未开窗'}
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
