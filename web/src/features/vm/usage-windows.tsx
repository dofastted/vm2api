import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
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
import { ActiveUsageAction } from '@/features/vm/active-usage-action'
import { ClaudeResetActions } from '@/features/vm/claude-reset-actions'
import { OpenaiQuotaActions } from '@/features/vm/openai-quota-actions'
import { riskFg, UsageMeter } from '@/features/vm/usage-meter'
import { vmWindows, type WindowReadout } from '@/features/vm/vm-rack-model'

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

/** GPT 槽：查询 / 重置券；Claude 完整 OAuth：原生限额查询 / 重置。 */
export function VmQuotaActions({ vm, now }: { vm: Vm; now: number }) {
  return isCodexVm(vm) ? (
    <OpenaiQuotaActions vm={vm} compact />
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
