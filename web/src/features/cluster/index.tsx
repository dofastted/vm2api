import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fleetCounts } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { CardGridSkeleton } from '@/components/page-skeletons'
import { SlotIdentity } from '@/components/platform-chip'
import { QueryGate } from '@/components/query-gate'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { CreateVmDialog } from '@/features/vm/create-vm-dialog'
import {
  filterVms,
  KindFilterChips,
  sortVmsByStatus,
  VmCards,
  VmTable,
  type VmKindFilter,
} from '@/features/vm/vm-table'

// 与虚拟机页 POOL_CHIPS 共用同一套档位：fleetGroup 粗分 5 档。
// 「在池」含冷却 / 额度紧（fleetGroup 把它们并进 pool）—— 这两种槽位仍在池中
// 可被调度到，只是暂时受限，所以不单列一档。要看细分去虚拟机页顶部的统计卡。
// revoke 从「无效凭证」里拆出来单列：吊销要换票，过期可能自动刷回来，
// 处置方式不同，混在一档里看不出该先动哪些。
const FLEET_CHIPS = [
  ['all', '全部'],
  ['pool', '在池'],
  ['off', '关闭调用'],
  ['none', '未使用'],
  ['bad', '无效凭证'],
  ['revoke', '已吊销'],
] as const

export function ClusterPage() {
  const dash = useQuery(dashboardQueryOptions(5000))
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [kind, setKind] = useState<VmKindFilter>('all')
  const [view, setView] = useState<'grid' | 'list'>('list')
  const [open, setOpen] = useState(false)
  const [delTarget, setDelTarget] = useState<Vm | null>(null)
  const [delInput, setDelInput] = useState('')
  const [delSwitchTo, setDelSwitchTo] = useState('')
  const vms: Vm[] = dash.data?.vms || []
  const filtered = sortVmsByStatus(filterVms(vms, q, filter, kind))
  const counts = fleetCounts(filterVms(vms, '', 'all', kind))
  const fableHat = fableCap(dash.data?.routing, dash.data?.summary)
  const fableInflight = vms.reduce(
    (n, vm) => n + (Number(vm.fable_inflight) || 0),
    0
  )
  const activeVmId = String(dash.data?.summary?.active_vm ?? '')
  const isActiveVm = (id: string) =>
    !!vms.find((v) => v.id === id)?.active || activeVmId === id
  const otherVms = delTarget ? vms.filter((v) => v.id !== delTarget.id) : []
  const clearCooldown = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/vms/${encodeURIComponent(id)}/cooldown/clear`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: async () => {
      toast.success('冷却已清理，已重新入池')
      await qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const deleteVm = useMutation({
    mutationFn: async (vm: Vm) => {
      if (isActiveVm(vm.id)) {
        if (!delSwitchTo) throw new Error('先切换活跃')
        await api(
          `/api/panel/vms/${encodeURIComponent(delSwitchTo)}/activate`,
          {
            method: 'POST',
          }
        )
      }
      await api(`/api/panel/vms/${encodeURIComponent(vm.id)}`, {
        method: 'DELETE',
      })
    },
    onSuccess: async (_data, vm) => {
      toast.success(`已删除 ${vm.id}`)
      setDelTarget(null)
      setDelInput('')
      setDelSwitchTo('')
      await qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <PageHeader
      title={VIEW_TITLES.cluster}
      fluid
      extra={<Button onClick={() => setOpen(true)}>创建</Button>}
    >
      <QueryGate
        loading={dash.isLoading}
        error={
          dash.error || (dash.data?.error ? new Error(dash.data.error) : null)
        }
        skeleton={
          <div>
            <div className='mb-4 flex flex-wrap items-center gap-2'>
              <Skeleton className='h-9 w-48' />
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className='h-8 w-16 rounded-md' />
              ))}
              <Skeleton className='h-8 w-8' />
              <Skeleton className='h-8 w-8' />
            </div>
            <CardGridSkeleton cards={6} />
          </div>
        }
      >
        <p className='mb-3 text-sm text-muted-foreground'>
          共 {vms.length} 槽 · Fable 帽 {fableHat} · 在飞 {fableInflight}
        </p>
        <div className='mb-4 flex flex-wrap items-center gap-2'>
          <Input
            className='w-56'
            placeholder='搜索'
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <KindFilterChips vms={vms} kind={kind} onChange={setKind} />
          {FLEET_CHIPS.map(([key, label]) => (
            <Button
              key={key}
              size='sm'
              variant={filter === key ? 'default' : 'outline'}
              aria-pressed={filter === key}
              onClick={() =>
                setFilter(filter === key && key !== 'all' ? 'all' : key)
              }
            >
              {label} {counts[key]}
            </Button>
          ))}
          <Button
            size='sm'
            variant={view === 'list' ? 'default' : 'outline'}
            onClick={() => setView('list')}
          >
            列表
          </Button>
          <Button
            size='sm'
            variant={view === 'grid' ? 'default' : 'outline'}
            onClick={() => setView('grid')}
          >
            网格
          </Button>
        </div>
        {filtered.length === 0 ? (
          <EmptyState
            reason='没有符合当前筛选的槽位。改筛选或先创建一台。'
            actionLabel='创建'
            onAction={() => setOpen(true)}
          />
        ) : view === 'grid' ? (
          <VmCards
            vms={filtered}
            onClearCooldown={(vm) => clearCooldown.mutate(vm.id)}
            onDelete={(vm) => {
              setDelInput('')
              setDelSwitchTo('')
              setDelTarget(vm)
            }}
          />
        ) : (
          <VmTable
            vms={filtered}
            onClearCooldown={(vm) => clearCooldown.mutate(vm.id)}
            onDelete={(vm) => {
              setDelInput('')
              setDelSwitchTo('')
              setDelTarget(vm)
            }}
          />
        )}
      </QueryGate>
      <CreateVmDialog open={open} onOpenChange={setOpen} />
      <ConfirmDialog
        open={!!delTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDelTarget(null)
            setDelInput('')
            setDelSwitchTo('')
          }
        }}
        title='删除'
        desc={
          delTarget ? (
            <>
              <p className='flex min-w-0 items-center gap-1.5'>
                <SlotIdentity vm={delTarget} compact />
                <span className='shrink-0 text-muted-foreground'>
                  · {delTarget.id}
                </span>
              </p>
              <p className='mt-2 text-destructive'>删除槽位不可恢复。</p>
            </>
          ) : (
            ''
          )
        }
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        disabled={
          delInput.trim() !== delTarget?.id ||
          (!!delTarget &&
            isActiveVm(delTarget.id) &&
            otherVms.length > 0 &&
            !delSwitchTo)
        }
        isLoading={deleteVm.isPending}
        handleConfirm={() => {
          if (delTarget) deleteVm.mutate(delTarget)
        }}
      >
        {delTarget && isActiveVm(delTarget.id) ? (
          <div className='space-y-1'>
            <Label>活跃切到</Label>
            <Select
              value={delSwitchTo}
              onValueChange={setDelSwitchTo}
              disabled={!otherVms.length}
            >
              <SelectTrigger>
                <SelectValue placeholder='选择' />
              </SelectTrigger>
              <SelectContent>
                {otherVms.map((v) => (
                  <SelectItem key={v.id} value={v.id} className='max-w-[280px]'>
                    <SlotIdentity vm={v} compact />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <Input
          autoFocus
          autoComplete='off'
          spellCheck={false}
          placeholder={delTarget?.id}
          aria-label='确认 ID'
          value={delInput}
          onChange={(e) => setDelInput(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              delInput.trim() === delTarget?.id &&
              delTarget
            ) {
              deleteVm.mutate(delTarget)
            }
          }}
        />
      </ConfirmDialog>
    </PageHeader>
  )
}

function fableCap(
  routing: { [key: string]: unknown } | undefined,
  summary: Record<string, unknown> | undefined
): number {
  const raw = routing?.concurrency
  const conc =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const n = Number(conc.fable_max_per_account ?? summary?.fable_max_per_account)
  return Number.isFinite(n) && n > 0 ? n : 4
}
