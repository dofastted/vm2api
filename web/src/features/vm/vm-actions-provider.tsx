import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { meQueryOptions } from '@/features/auth/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { clearVmRestriction } from '@/features/vm/clear-restriction'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import {
  VmActionsContext,
  type VmActions,
} from '@/features/vm/vm-actions-context'
import { VmAssignOwnerDialog } from '@/features/vm/vm-assign-owner-dialog'
import { VmDetailCard } from '@/features/vm/vm-detail-card'
import { canReclaimVm, patchVmOwner } from '@/features/vm/vm-owner'
import { VmReauthDialog } from '@/features/vm/vm-reauth-dialog'
import { VmRecoveryDialog } from '@/features/vm/vm-recovery-dialog'
import { VmStatsDialog } from '@/features/vm/vm-stats-dialog'
import { VmTestDialog } from '@/features/vm/vm-test-dialog'

/**
 * 持有详情卡与测试 / 统计 / 重新授权 / 恢复服务弹窗的开关，行与卡片只发「打开哪台」。
 * 弹窗内的 Vm 始终从列表缓存里按 id 取，轮询刷新后卡面数据同步更新。
 */
export function VmActionsProvider({
  accounts,
  onReset,
  onDelete,
  children,
}: {
  accounts?: UsageAccountRow[]
  onReset?: (vm: Vm) => void
  onDelete?: (vm: Vm) => void
  children: React.ReactNode
}) {
  const qc = useQueryClient()
  const me = useQuery(meQueryOptions())
  const isAdmin = me.data?.role === 'admin'
  const list = useQuery(vmsListQueryOptions())
  const [detailId, setDetailId] = useState<string | null>(null)
  const [testId, setTestId] = useState<string | null>(null)
  const [statsId, setStatsId] = useState<string | null>(null)
  const [reauthId, setReauthId] = useState<string | null>(null)
  const [recoveryId, setRecoveryId] = useState<string | null>(null)
  const [assignId, setAssignId] = useState<string | null>(null)
  const [reclaimTarget, setReclaimTarget] = useState<Vm | null>(null)
  const items = list.data?.items
  const byId = (id: string | null) =>
    (id && items?.find((vm) => vm.id === id)) || null

  const invalidate = (vm: Vm) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])

  const {
    mutate: refreshToken,
    isPending: refreshPending,
    variables: refreshVars,
  } = useMutation({
    mutationFn: (vm: Vm) =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/refresh`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: async (_data, vm) => {
      toast.success(`已刷新令牌 ${vm.id}`)
      await invalidate(vm)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const {
    mutate: recoverState,
    isPending: recoverPending,
    variables: recoverVars,
  } = useMutation({
    mutationFn: (vm: Vm) => clearVmRestriction(vm),
    onSuccess: async (_data, vm) => {
      toast.success('已清除冷却 / 熔断并刷新状态')
      await invalidate(vm)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const {
    mutate: activateVm,
    isPending: activatePending,
    variables: activateVars,
  } = useMutation({
    mutationFn: (vm: Vm) =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}/activate`, {
        method: 'POST',
      }),
    onSuccess: async (_data, vm) => {
      toast.success(`已设为活跃槽 ${vm.id}`)
      await invalidate(vm)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const {
    mutate: setOwner,
    isPending: ownerPending,
    variables: ownerVars,
  } = useMutation({
    mutationFn: ({ vm, user_id }: { vm: Vm; user_id: string | null }) =>
      patchVmOwner(vm.id, user_id),
    onSuccess: async (_data, { vm, user_id }) => {
      toast.success(user_id ? '已分配给租户' : '已收回进平台池')
      setAssignId(null)
      setReclaimTarget(null)
      await invalidate(vm)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const ownerBusyId = ownerPending ? (ownerVars?.vm.id ?? null) : null

  const actions = useMemo<VmActions>(
    () => ({
      openDetail: (vm) => setDetailId(vm.id),
      openTest: (vm) => setTestId(vm.id),
      openStats: (vm) => setStatsId(vm.id),
      openReauth: (vm) => setReauthId(vm.id),
      openRecovery: (vm) => setRecoveryId(vm.id),
      refreshToken,
      recover: recoverState,
      refreshingId: refreshPending ? (refreshVars?.id ?? null) : null,
      recoveringId: recoverPending ? (recoverVars?.id ?? null) : null,
      reset: onReset,
      remove: onDelete,
      activate: activateVm,
      activatingId: activatePending ? (activateVars?.id ?? null) : null,
      ...(isAdmin
        ? {
            openAssignOwner: (vm: Vm) => setAssignId(vm.id),
            reclaimOwner: (vm: Vm) => setReclaimTarget(vm),
            ownerBusyId,
          }
        : {}),
    }),
    [
      refreshToken,
      recoverState,
      refreshPending,
      refreshVars,
      recoverPending,
      recoverVars,
      onReset,
      onDelete,
      activateVm,
      activatePending,
      activateVars,
      isAdmin,
      ownerBusyId,
    ]
  )

  return (
    <VmActionsContext.Provider value={actions}>
      {children}
      <VmDetailCard
        vm={byId(detailId)}
        accounts={accounts}
        onOpenChange={(open) => !open && setDetailId(null)}
      />
      <VmTestDialog
        vm={byId(testId)}
        onOpenChange={(open) => !open && setTestId(null)}
      />
      <VmStatsDialog
        vm={byId(statsId)}
        accounts={accounts}
        onOpenChange={(open) => !open && setStatsId(null)}
      />
      <VmReauthDialog
        vm={byId(reauthId)}
        onOpenChange={(open) => !open && setReauthId(null)}
      />
      <VmRecoveryDialog
        vm={byId(recoveryId)}
        open={recoveryId != null}
        onOpenChange={(open) => !open && setRecoveryId(null)}
      />
      {isAdmin ? (
        <>
          <VmAssignOwnerDialog
            vm={byId(assignId)}
            open={assignId != null}
            pending={ownerPending && ownerVars?.user_id != null}
            onOpenChange={(open) => !open && setAssignId(null)}
            onConfirm={(userId) => {
              const vm = byId(assignId)
              if (vm) setOwner({ vm, user_id: userId })
            }}
          />
          <ConfirmDialog
            open={reclaimTarget != null}
            onOpenChange={(open) => !open && setReclaimTarget(null)}
            title='收回槽位'
            desc={
              reclaimTarget ? (
                <>
                  将把 <span className='font-mono'>{reclaimTarget.id}</span>{' '}
                  收回平台池，当前租户将不再看到该槽。自建 VM
                  不能收回，请使用删除。
                </>
              ) : (
                ''
              )
            }
            cancelBtnText='取消'
            confirmText='确认收回'
            destructive
            isLoading={ownerPending && ownerVars?.user_id === null}
            disabled={reclaimTarget != null && !canReclaimVm(reclaimTarget)}
            handleConfirm={() => {
              if (reclaimTarget && canReclaimVm(reclaimTarget)) {
                setOwner({ vm: reclaimTarget, user_id: null })
              }
            }}
          />
        </>
      ) : null}
    </VmActionsContext.Provider>
  )
}
