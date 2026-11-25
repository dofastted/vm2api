import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ActiveUsageQueryResult, Vm } from '@/types/panel-vm'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  ACTIVE_USAGE_WINDOW_LABELS,
  conflictStillDivergent,
  describeActiveUsageOutcome,
  formatQuotaRatioPct,
} from './active-usage-model'
import { vmQueryOptions, vmsListQueryOptions } from './queries'
import { useVmPerms } from './vm-perms'

export function ActiveUsageAction({ vm }: { vm: Vm }) {
  const qc = useQueryClient()
  const canUse = useVmPerms().usageQuery
  const [conflict, setConflict] = useState<{
    vmId: string
    result: ActiveUsageQueryResult
  } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const query = useMutation({
    mutationKey: ['active-usage', vm.id],
    mutationFn: (opts?: { forceReconcile?: boolean }) =>
      api<ActiveUsageQueryResult>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/usage/query`,
        {
          method: 'POST',
          ...(opts?.forceReconcile
            ? { body: JSON.stringify({ force_reconcile: true }) }
            : {}),
          signal: AbortSignal.timeout(75_000),
        }
      ),
    onSuccess: async (data, variables) => {
      const forced = Boolean(variables?.forceReconcile)
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
      const outcome = describeActiveUsageOutcome(data, forced)
      if (outcome.kind === 'reconciled') {
        setConflict(null)
        setConfirmOpen(false)
        toast.success(outcome.message)
        return
      }
      setConfirmOpen(false)
      if (outcome.canForceReconcile && data) {
        setConflict({ vmId: vm.id, result: data })
        toast.warning(outcome.message, {
          action: {
            label: '按官方校准',
            onClick: () => setConfirmOpen(true),
          },
        })
        return
      }
      setConflict(null)
      toast.warning(outcome.message)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (!canUse) return null
  const unsupported = ['official-setup-token', 'apikey'].includes(
    vm.credential_mode || ''
  )
  const activeOutcome =
    conflict?.vmId === vm.id
      ? describeActiveUsageOutcome(conflict.result, false)
      : null
  const canForceReconcile = Boolean(
    activeOutcome?.canForceReconcile &&
    conflictStillDivergent(vm, activeOutcome.retainedWindows)
  )
  const retainedWindows = activeOutcome?.retainedWindows ?? []
  const forcePending =
    query.isPending && Boolean(query.variables?.forceReconcile)

  return (
    <div
      className='flex flex-wrap items-center gap-1'
      data-row-actions
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Button
        type='button'
        size='sm'
        variant='ghost'
        className='h-6 gap-1 px-1.5 text-[11px] text-muted-foreground'
        disabled={query.isPending || !vm.has_token || unsupported}
        loading={query.isPending && !forcePending}
        title={
          unsupported
            ? '当前凭证不支持官方额度查询，请导入完整 OAuth'
            : '查询官方最新额度并更新用量'
        }
        onClick={() => query.mutate(undefined)}
      >
        <RefreshCw className='size-3' />
        {query.isPending && !forcePending ? '查询中' : '主动查询'}
      </Button>
      {canForceReconcile ? (
        <Button
          type='button'
          size='sm'
          variant='outline'
          className='h-6 gap-1 border-[color:var(--status-warn)]/40 px-1.5 text-[11px] text-[color:var(--status-warn)]'
          disabled={query.isPending || !vm.has_token || unsupported}
          loading={forcePending}
          title='距上次推理不足 5 分钟，确认已在外部重置且无在途消耗后可强制同步官方读数'
          onClick={() => setConfirmOpen(true)}
        >
          {forcePending ? '校准中' : '按官方校准'}
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirmOpen && canForceReconcile}
        onOpenChange={(open) => {
          if (!open && !query.isPending) setConfirmOpen(false)
        }}
        title='确认按官方读数校准额度窗口？'
        desc={
          <div className='grid gap-2 text-xs'>
            <p className='m-0'>
              刚在推理后 5 分钟静置期内读到显著更低的官方额度（约剩{' '}
              <b className='font-semibold text-foreground tabular-nums'>
                {activeOutcome?.settleRemainingSec ?? 0}
              </b>{' '}
              秒），系统默认保留保守响应头以防上游统计延迟。
            </p>
            <div className='grid gap-1 rounded-md bg-muted/60 px-2.5 py-2'>
              {retainedWindows.map((item) => (
                <div key={item.window} className='break-words'>
                  <b className='font-semibold text-foreground'>
                    {ACTIVE_USAGE_WINDOW_LABELS[item.window] || item.window}
                  </b>
                  ：官方最新{' '}
                  <b className='font-semibold text-foreground tabular-nums'>
                    {formatQuotaRatioPct(item.official_utilization)}
                  </b>
                  （{item.official_updated_at || '未知'}） · 当前保留{' '}
                  <b className='font-semibold text-foreground tabular-nums'>
                    {formatQuotaRatioPct(item.retained_utilization)}
                  </b>
                  （{item.header_sampled_at || '未知'}）
                </div>
              ))}
            </div>
            <p className='m-0 text-muted-foreground'>
              仅当确认已在官方网页端或升级前完成额度重置时执行；校准时仍会校验无在途请求与更新响应头。
            </p>
          </div>
        }
        confirmText='确认按官方校准'
        cancelBtnText='保留保守值'
        isLoading={forcePending}
        handleConfirm={() => query.mutate({ forceReconcile: true })}
      />
    </div>
  )
}
