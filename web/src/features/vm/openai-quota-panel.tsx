import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { formatWindowSpend } from '@/lib/vm-usage'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { Meter, ResetAt } from '@/features/vm/detail-section-primitives'
import {
  describeCodexCredits,
  formatOpenaiQuotaRefreshToast,
  type CodexCreditsStatusKey,
  type OpenaiQuotaPayload,
} from '@/features/vm/openai-credits'
import { vmQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

function creditStatusTone(statusKey: CodexCreditsStatusKey): string {
  switch (statusKey) {
    case 'spendable':
      return 'text-[color:var(--status-ok)]'
    case 'stale':
      return 'text-[color:var(--status-warn)]'
    case 'rate_limited':
      return 'text-[color:var(--status-bad)]'
    default:
      return 'text-muted-foreground'
  }
}

export function OpenaiQuotaPanel({
  vm,
  u5,
  u7,
  now,
  cost5 = 0,
  cost7 = 0,
}: {
  vm: Vm
  u5: number
  u7: number
  now: number
  cost5?: number
  cost7?: number
}) {
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const canUse = useVmPerms().credential
  const resetCredits = vm.reset_credits
  const available = Math.max(0, Number(resetCredits?.available_count) || 0)
  const expiry = resetCredits?.credits?.[0]?.expires_at
  const creditView = describeCodexCredits(vm, now)

  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  }

  const queryQuota = useMutation({
    mutationFn: () =>
      api<OpenaiQuotaPayload>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/openai-quota/refresh`,
        { method: 'POST' }
      ),
    onSuccess: async (data) => {
      await refreshAll()
      toast.success(formatOpenaiQuotaRefreshToast(data))
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const resetQuota = useMutation({
    mutationFn: () =>
      api<OpenaiQuotaPayload>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/openai-quota/reset`,
        { method: 'POST', signal: AbortSignal.timeout(90_000) }
      ),
    onSuccess: async (data) => {
      setConfirm(false)
      await refreshAll()
      if (data?.warning === 'reset_credit_cache_refresh_failed') {
        toast.warning('重置券已消费，但回读额度失败，请再点刷新')
        return
      }
      toast.success('已使用一张重置券')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const busy = queryQuota.isPending || resetQuota.isPending

  return (
    <div className='grid gap-3'>
      <p className='m-0 text-xs text-muted-foreground'>Codex 额度 · 短时窗口</p>
      <Meter
        label='5 小时已用'
        value={u5}
        hint={quotaHint(vm.status_5h, cost5, vm.estimate_5h)}
      />
      <div className='text-[11px] text-muted-foreground'>
        5h 重置 <ResetAt value={vm.reset_5h} now={now} />
      </div>
      <Meter
        label='7 天已用'
        value={u7}
        hint={quotaHint(vm.status_7d, cost7, vm.estimate_7d)}
      />
      <div className='text-[11px] text-muted-foreground'>
        7d 重置 <ResetAt value={vm.reset_7d} now={now} />
      </div>

      <div className='grid gap-1.5 rounded-md border bg-muted/20 px-3 py-2 text-xs'>
        <div className='flex flex-wrap items-baseline justify-between gap-2'>
          <span className='text-muted-foreground'>Codex 积分余额</span>
          <span className='font-mono font-semibold tabular-nums'>
            {creditView.balanceText}
          </span>
        </div>
        <div className='flex flex-wrap items-baseline justify-between gap-2 text-[11px]'>
          <span className='text-muted-foreground'>积分状态</span>
          <span
            className={cn(
              'font-medium',
              creditStatusTone(creditView.statusKey)
            )}
            title={
              creditView.fetchedAtMs != null
                ? `查询时间 ${new Date(creditView.fetchedAtMs).toLocaleString()}`
                : undefined
            }
          >
            {creditView.statusText}
            {creditView.statusKey === 'stale' ? '（上次查询余额，待刷新）' : ''}
            {creditView.fetchedAtMs != null ? (
              <span className='ml-1.5 font-normal text-muted-foreground tabular-nums'>
                · {new Date(creditView.fetchedAtMs).toLocaleString()}
                {creditView.agoText ? `（${creditView.agoText}）` : ''}
              </span>
            ) : null}
          </span>
        </div>
        <div className='flex flex-wrap items-baseline justify-between gap-2 border-t pt-1.5 text-[11px]'>
          <span className='text-muted-foreground'>重置券</span>
          <span className='font-mono tabular-nums'>
            {resetCredits ? `${available} 张` : '未查询'}
          </span>
        </div>
        {expiry ? (
          <p className='m-0 text-[11px] text-muted-foreground'>
            最近一张到期 <ResetAt value={expiry} now={now} />
          </p>
        ) : null}
      </div>

      {canUse ? (
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            disabled={busy}
            onClick={() => queryQuota.mutate()}
          >
            {queryQuota.isPending ? '刷新中…' : '刷新额度和积分'}
          </Button>
          <Button
            size='sm'
            variant='destructive'
            disabled={busy || available < 1}
            onClick={() => setConfirm(true)}
          >
            {resetQuota.isPending ? '使用中…' : '使用重置券'}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title='使用一张重置券'
        desc={`将消费 1 / ${available} 张上游重置券，不可退回。`}
        confirmText='确认使用'
        destructive
        isLoading={resetQuota.isPending}
        handleConfirm={() => resetQuota.mutate()}
      />
    </div>
  )
}

function quotaHint(
  status: unknown,
  cost: number,
  est: Vm['estimate_5h']
): string {
  const bits: string[] = []
  const text = String(status || '').trim()
  if (text) bits.push(text)
  const spend = formatWindowSpend(cost, est)
  if (spend.costText) bits.push(spend.costText)
  if (spend.remainText) bits.push(spend.remainText)
  if (!spend.costText) bits.push(`合计 ${fmtUsd(cost, 2)}`)
  return bits.join(' · ')
}
