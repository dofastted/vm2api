import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'

type QuotaPayload = {
  reset_credits?: {
    available_count?: number
    credits?: Array<{ expires_at?: string }>
  } | null
  warning?: string
}

function useOpenaiQuotaActions(vm: Vm) {
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const credits = vm.reset_credits
  const available = Math.max(0, Number(credits?.available_count) || 0)
  const expiry = credits?.credits?.[0]?.expires_at

  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
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

  return {
    available,
    confirm,
    credits,
    expiry,
    queryQuota,
    resetQuota,
    setConfirm,
    busy: queryQuota.isPending || resetQuota.isPending,
  }
}

export function OpenaiQuotaActions({
  vm,
  compact = false,
}: {
  vm: Vm
  compact?: boolean
}) {
  const {
    available,
    busy,
    confirm,
    credits,
    queryQuota,
    resetQuota,
    setConfirm,
  } = useOpenaiQuotaActions(vm)

  return (
    <div
      className={cn('flex flex-wrap items-center gap-1', !compact && 'gap-2')}
      data-row-actions
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Button
        size='sm'
        variant={compact ? 'ghost' : 'outline'}
        disabled={busy}
        title='查询上游额度与重置券次数'
        className={
          compact
            ? 'h-6 gap-1 px-1.5 text-[11px] text-muted-foreground'
            : undefined
        }
        onClick={() => queryQuota.mutate()}
      >
        <RefreshCw
          className={cn('size-3', queryQuota.isPending && 'animate-spin')}
        />
        {queryQuota.isPending
          ? '查询中'
          : compact
            ? `查询${credits ? ` ${available}` : ''}`
            : `查询重置券${credits ? ` ${available}` : ''}`}
      </Button>
      <Button
        size='sm'
        variant={compact ? 'ghost' : 'destructive'}
        disabled={busy || available < 1}
        title={
          available < 1
            ? '先查询重置券次数'
            : `消费 1 / ${available} 张上游重置券`
        }
        className={
          compact
            ? 'h-6 gap-1 px-1.5 text-[11px] text-muted-foreground disabled:text-muted-foreground/50'
            : undefined
        }
        onClick={() => setConfirm(true)}
      >
        <RotateCcw
          className={cn('size-3', resetQuota.isPending && 'animate-spin')}
        />
        {resetQuota.isPending ? '使用中' : compact ? '用券' : '使用重置券'}
      </Button>
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
