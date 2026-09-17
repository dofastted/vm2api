import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { BillingAccountRow, BillingSnapshot } from '@/types/panel-overview'
import type { Vm } from '@/types/panel-vm'
import { fmtUsd } from '@/lib/format'
import { indexVms, isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { SlotIdentity } from '@/components/platform-chip'
import { billingQueryOptions } from '@/features/billing/queries'
import { PanelCard, StatCell } from '@/features/overview/panel-card'

/** 计费面板。对齐 index.html 的 `renderBillingStrip(src)`。 */
export function BillingStrip({
  billing,
  vms,
  fallbackToday,
  fallbackTotal,
}: {
  billing: BillingSnapshot | undefined
  vms?: Vm[]
  fallbackToday?: number
  fallbackTotal?: number
}) {
  const owned = useQuery(billingQueryOptions('vm'))
  const today = billing?.today?.total_cost ?? fallbackToday ?? 0
  const total = billing?.total?.total_cost ?? fallbackTotal ?? 0
  const byId = indexVms(vms)
  let claudeCost = 0
  let gptCost = 0
  for (const item of owned.data?.items || []) {
    const vm = item.vm_id ? byId.get(item.vm_id) : undefined
    if (isCodexVm(vm)) gptCost += Number(item.cost_usd || 0)
    else claudeCost += Number(item.cost_usd || 0)
  }
  if (!owned.data?.items?.length) {
    for (const vm of vms || []) {
      const cost = Number(vm.total_cost || 0)
      if (isCodexVm(vm)) gptCost += cost
      else claudeCost += cost
    }
  }
  const rows: BillingAccountRow[] = (billing?.accounts || [])
    .filter((a) => Number(a.total_cost) > 0)
    .slice(0, 8)

  return (
    <PanelCard
      title='计费'
      meta='上海日切 · Claude / GPT'
      action={
        <Button variant='outline' size='sm' asChild>
          <Link to='/billing'>计费详情</Link>
        </Button>
      }
    >
      <div className='grid gap-px bg-border/60 sm:grid-cols-4'>
        <StatCell
          label='今日费用'
          value={fmtUsd(today)}
          valueClassName='text-[color:var(--status-ok)]'
        />
        <StatCell
          label='累计费用'
          value={fmtUsd(total)}
          hint='日志窗口内全部请求'
        />
        <StatCell
          label='Claude'
          value={fmtUsd(claudeCost)}
          hint='Anthropic 官方价 · 累计'
        />
        <StatCell
          label='GPT'
          value={fmtUsd(gptCost)}
          hint='OpenAI 官方价 · 累计'
        />
      </div>
      {rows.length ? (
        <div className='flex flex-wrap gap-2 border-t bg-card px-4 py-3'>
          {rows.map((row) => {
            const vm = row.vm_id ? byId.get(row.vm_id) : undefined
            const chipContent = (
              <>
                <SlotIdentity vm={vm} vmId={row.vm_id} email={row.email} />
                <b className='font-semibold tabular-nums'>
                  {fmtUsd(row.today_cost || 0)}
                </b>
                <em className='text-muted-foreground not-italic'>
                  / {fmtUsd(row.total_cost || 0)}
                </em>
              </>
            )
            const chipClass =
              'inline-flex items-center gap-2 rounded-full border bg-card px-2.5 py-1.5 text-xs transition-colors'
            return row.vm_id ? (
              <Link
                key={row.vm_id || row.account_id || row.email}
                to='/vm/$id'
                params={{ id: String(row.vm_id) }}
                className={`${chipClass} hover:bg-accent/50`}
              >
                {chipContent}
              </Link>
            ) : (
              <span key={row.account_id || row.email} className={chipClass}>
                {chipContent}
              </span>
            )
          })}
        </div>
      ) : null}
    </PanelCard>
  )
}
