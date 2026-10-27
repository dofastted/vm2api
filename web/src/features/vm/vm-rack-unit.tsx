import { memo } from 'react'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { resetCountdown } from '@/lib/fable-status'
import { fmtNum, fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isCodexVm, slotCredentialLabel } from '@/lib/vm-kind'
import { vmCostLedger } from '@/lib/vm-usage'
import { subscriptionDateText } from '@/features/vm/claude-subscription'
import { RISK_SOLID, riskFg, riskLevel } from '@/features/vm/usage-meter'
import {
  BLADE_STATE_CLASS,
  BladeControls,
  TierBadge,
  tierStyle,
  useOpenOnKey,
  VmSeats,
} from '@/features/vm/vm-rack-blade'
import {
  bladeState,
  vmWindows,
  zoneOf,
  type WindowReadout,
} from '@/features/vm/vm-rack-model'

function MiniColumn({ w, now }: { w: WindowReadout; now: number }) {
  const reset = w.reset ? resetCountdown(w.reset, now) : null
  const tip = [
    `${w.label} ${w.pct == null ? w.note || '未探测' : `${Math.round(w.pct)}%`}`,
    reset && `${reset} 后重置`,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span className='grid justify-items-center gap-0.5' title={tip}>
      <span
        className={cn(
          'font-mono text-[10.5px] font-semibold tabular-nums',
          w.pct == null
            ? 'text-[color:var(--text-tertiary)]'
            : riskLevel(w.pct) !== 'ok' && riskFg(w.pct)
        )}
      >
        {w.pct == null ? '—' : Math.round(w.pct)}
      </span>
      <span className='relative h-9 w-2 overflow-hidden rounded-[3px] bg-[color:var(--track)]'>
        {w.pct == null ? null : (
          <i
            className='absolute inset-x-0 bottom-0 rounded-[2px]'
            style={{
              height: `${Math.max(w.pct, 3)}%`,
              backgroundColor: RISK_SOLID[riskLevel(w.pct)],
            }}
          />
        )}
      </span>
      <span className='text-[9.5px] text-[color:var(--text-tertiary)]'>
        {w.key === 'fable' ? 'F' : w.label}
      </span>
    </span>
  )
}

const NOTE: Record<string, string> = {
  dead: '无效凭证',
  vacant: '未绑定账号',
  unprobed: '额度未探测',
}

/** 小档单元：一屏看全队。重置在竖柱悬停提示里，5H / 7D / 总计成本在总计的提示里。 */
export const VmUnit = memo(function VmUnit({
  vm,
  accounts,
  now,
}: {
  vm: Vm
  accounts?: UsageAccountRow[]
  now: number
}) {
  const open = useOpenOnKey(vm)
  const state = bladeState(vm)
  const ledger = vmCostLedger(vm, accounts)
  const total = ledger[ledger.length - 1]
  const email = String(vm.email || '')
  return (
    <article
      role='button'
      tabIndex={0}
      aria-label={`查看 ${vm.id} 详情`}
      style={tierStyle(vm)}
      className={cn(
        'relative grid min-h-[136px] min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto_1fr_auto] gap-x-2 gap-y-1 rounded-[9px] px-2.5 ps-3 pt-2 pb-1.5 shadow-[inset_0_0_0_1px_var(--hairline)] transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        "before:absolute before:top-2.5 before:left-0 before:h-3.5 before:w-0.5 before:rounded-r-[2px] before:bg-[color:var(--tc,transparent)] before:content-['']",
        BLADE_STATE_CLASS[state],
        zoneOf(vm) === 'off' && 'opacity-80'
      )}
      {...open}
    >
      <div className='col-span-2 flex min-w-0 items-center gap-1.5'>
        <span className='font-mono text-[11px] text-muted-foreground'>
          {vm.id}
        </span>
        <TierBadge vm={vm} className='ms-auto h-4 px-1 text-[9.5px]' />
      </div>
      <div className='col-span-2 min-w-0'>
        <div
          title={email || undefined}
          className={cn(
            'truncate text-[12.5px] font-semibold',
            !email && 'font-medium text-muted-foreground'
          )}
        >
          {slotCredentialLabel(vm, true)}
        </div>
        {!isCodexVm(vm) ? (
          <div className='truncate text-[10.5px] text-muted-foreground'>
            {subscriptionDateText(vm.claude_subscription)}
            {vm.claude_subscription?.last_error ? ' · 待更新' : ''}
          </div>
        ) : null}
      </div>
      {state === 'live' ? (
        <span className='flex items-end gap-1.5'>
          {vmWindows(vm).map((w) => (
            <MiniColumn key={w.key} w={w} now={now} />
          ))}
        </span>
      ) : (
        <span
          className={cn(
            'self-center text-[11px] text-muted-foreground',
            state === 'dead' && 'text-[color:var(--status-bad)]',
            state === 'unprobed' && 'text-[color:var(--status-caution)]'
          )}
        >
          {NOTE[state]}
        </span>
      )}
      {total.cost ? (
        <span
          className='grid gap-px self-end border-l border-[color:color-mix(in_oklch,var(--tc,var(--border))_55%,transparent)] ps-2 text-right'
          title={ledger
            .map(
              (r) => `${r.label} ${fmtUsd(r.cost, 2)} · ${fmtNum(r.tokens)} tok`
            )
            .join('\n')}
        >
          <b className='text-[13px] font-[640] tracking-[-0.015em] text-[color:var(--tf,var(--foreground))] tabular-nums'>
            {fmtUsd(total.cost, 0)}
          </b>
          <span className='font-mono text-[10.5px] text-muted-foreground tabular-nums'>
            {fmtNum(total.tokens)}
          </span>
        </span>
      ) : null}
      <div className='hairline-t col-span-2 mt-0.5 flex items-center gap-1 pt-1 text-[10.5px] text-muted-foreground'>
        <VmSeats vm={vm} compact />
        <BladeControls vm={vm} />
      </div>
    </article>
  )
})
