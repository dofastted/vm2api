import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { Meter, ResetAt } from '@/features/vm/detail-section-primitives'
import { vmQueryOptions } from '@/features/vm/queries'

type QuotaPayload = {
  reset_credits?: {
    available_count?: number
    credits?: Array<{ expires_at?: string }>
    fetched_at?: string
  } | null
  warning?: string
}

export function OpenaiQuotaPanel({
  vm,
  u5,
  u7,
  now,
}: {
  vm: Vm
  u5: number
  u7: number
  now: number
}) {
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const credits = vm.reset_credits
  const available = Math.max(0, Number(credits?.available_count) || 0)
  const expiry = credits?.credits?.[0]?.expires_at

  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  }

  const queryQuota = useMutation({
    mutationFn: () =>
      api<QuotaPayload>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/openai-quota/refresh`,
        { method: 'POST' }
      ),
    onSuccess: async (data) => {
      await refreshAll()
      const count = Number(data?.reset_credits?.available_count)
      toast.success(
        Number.isFinite(count)
          ? `已查询，可用重置券 ${count} 张`
          : '已刷新 GPT 额度'
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const resetQuota = useMutation({
    mutationFn: () =>
      api<QuotaPayload>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/openai-quota/reset`,
        { method: 'POST', signal: AbortSignal.timeout(90_000) }
      ),
    onSuccess: async (data) => {
      setConfirm(false)
      await refreshAll()
      if (data?.warning === 'reset_credit_cache_refresh_failed') {
        toast.warning('重置券已消费，但回读额度失败，请再点查询')
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
        hint={vm.status_5h ? String(vm.status_5h) : undefined}
      />
      <div className='text-[11px] text-muted-foreground'>
        5h 重置 <ResetAt value={vm.reset_5h} now={now} />
      </div>
      <Meter
        label='7 天已用'
        value={u7}
        hint={vm.status_7d ? String(vm.status_7d) : undefined}
      />
      <div className='text-[11px] text-muted-foreground'>
        7d 重置 <ResetAt value={vm.reset_7d} now={now} />
      </div>
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          variant='outline'
          disabled={busy}
          onClick={() => queryQuota.mutate()}
        >
          {queryQuota.isPending
            ? '查询中…'
            : `查询重置券${credits ? ` ${available}` : ''}`}
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
      {expiry ? (
        <p className='m-0 text-[11px] text-muted-foreground'>
          最近一张到期 <ResetAt value={expiry} now={now} />
        </p>
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
