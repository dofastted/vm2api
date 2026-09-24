import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type { Vm } from '@/types/panel-vm'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  LayoutGrid,
  List,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { SlotIdentity } from '@/components/platform-chip'
import { QueryGate } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import { usageQueryOptions } from '@/features/overview/queries'
import { clearVmRestriction } from '@/features/vm/clear-restriction'
import { CreateVmDialog } from '@/features/vm/create-vm-dialog'
import { FleetPulse } from '@/features/vm/fleet-pulse'
import { VmListSkeleton } from '@/features/vm/list-skeleton'
import { vmsListQueryOptions } from '@/features/vm/queries'
import {
  filterVms,
  KindFilterChips,
  sortVms,
  VmCards,
  VmTable,
  type VmKindFilter,
  type VmSortKey,
} from '@/features/vm/vm-table'

const SORT_CHIPS = [
  ['status', '状态'],
  ['name', '名称'],
  ['remain', '5h 剩余'],
  ['today', '今日花费'],
  ['cache', '缓存命中'],
] as const

export function VmListPage() {
  const me = useQuery(meQueryOptions())
  const vmsQ = useQuery(vmsListQueryOptions(5000))
  const usage = useQuery({
    ...usageQueryOptions(5000),
    enabled: me.data?.role !== 'user',
  })
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [kind, setKind] = useState<VmKindFilter>('all')
  const [view, setView] = useState<'grid' | 'list'>('list')
  const [sort, setSort] = useState<VmSortKey>('status')
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const [resetTarget, setResetTarget] = useState<Vm | null>(null)
  const [resetInput, setResetInput] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Vm | null>(null)
  const [deleteInput, setDeleteInput] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const resetVm = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/vms/${encodeURIComponent(id)}/reset`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: async () => {
      toast.success('已销毁并重建')
      setResetTarget(null)
      setResetInput('')
      await qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const deleteVm = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/vms/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('已删除')
      setDeleteTarget(null)
      setDeleteInput('')
      await qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const clearCooldown = useMutation({
    mutationFn: (vm: Vm) => clearVmRestriction(vm),
    onSuccess: async () => {
      toast.success('已清除冷却 / 熔断并刷新状态')
      await qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const vms: Vm[] = vmsQ.data?.items || []
  const accounts = usage.data?.accounts
  const canCreate =
    me.data?.role === 'admin' ||
    (me.data?.role === 'user' && (me.data.vm_create_quota || 0) > 0)
  const scoped = filterVms(vms, '', 'all', kind)
  const list = sortVms(filterVms(vms, q, filter, kind), sort, dir, accounts)

  return (
    <PageHeader
      title={VIEW_TITLES.vm}
      fluid
      extra={
        canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>创建</Button>
        ) : undefined
      }
    >
      <QueryGate
        loading={vmsQ.isLoading}
        error={vmsQ.error}
        skeleton={<VmListSkeleton />}
      >
        <FleetPulse
          className='mb-3'
          vms={scoped}
          accounts={accounts}
          filter={filter}
          onFilter={setFilter}
        />
        <div className='mb-4 flex flex-wrap items-center gap-2'>
          <KindFilterChips vms={vms} kind={kind} onChange={setKind} />
          <Separator orientation='vertical' className='mx-1 h-5' />
          <Input
            className='h-8 w-64'
            type='search'
            placeholder='搜索名称 / 邮箱 / 代理'
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className='ms-auto flex flex-wrap items-center gap-2'>
            <span className='text-xs text-muted-foreground'>排序</span>
            <Select
              value={sort}
              onValueChange={(next) => {
                setSort(next as VmSortKey)
                setDir(next === 'name' ? 'asc' : 'desc')
              }}
            >
              <SelectTrigger size='sm' className='w-28' aria-label='排序字段'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align='end'>
                {SORT_CHIPS.map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size='sm'
              variant='outline'
              title={dir === 'asc' ? '升序' : '降序'}
              aria-label={
                dir === 'asc' ? '当前升序，切到降序' : '当前降序，切到升序'
              }
              onClick={() => setDir(dir === 'asc' ? 'desc' : 'asc')}
            >
              {dir === 'asc' ? <ArrowUpNarrowWide /> : <ArrowDownWideNarrow />}
            </Button>
            <Separator orientation='vertical' className='mx-1 h-5' />
            <Button
              size='sm'
              variant={view === 'list' ? 'default' : 'outline'}
              aria-pressed={view === 'list'}
              aria-label='列表视图'
              title='列表'
              onClick={() => setView('list')}
            >
              <List />
            </Button>
            <Button
              size='sm'
              variant={view === 'grid' ? 'default' : 'outline'}
              aria-pressed={view === 'grid'}
              aria-label='网格视图'
              title='网格'
              onClick={() => setView('grid')}
            >
              <LayoutGrid />
            </Button>
          </div>
        </div>
        {list.length ? (
          view === 'grid' ? (
            <VmCards
              vms={list}
              accounts={accounts}
              onClearCooldown={(vm) => clearCooldown.mutate(vm)}
              onReset={(vm) => {
                setResetInput('')
                setResetTarget(vm)
              }}
              onDelete={(vm) => {
                setDeleteInput('')
                setDeleteTarget(vm)
              }}
            />
          ) : (
            <VmTable
              vms={list}
              accounts={accounts}
              onClearCooldown={(vm) => clearCooldown.mutate(vm)}
              onReset={(vm) => {
                setResetInput('')
                setResetTarget(vm)
              }}
              onDelete={(vm) => {
                setDeleteInput('')
                setDeleteTarget(vm)
              }}
            />
          )
        ) : (
          <EmptyState
            reason='没有符合当前筛选的槽位。'
            actionLabel='创建'
            onAction={() => setCreateOpen(true)}
          />
        )}
      </QueryGate>
      <ConfirmDialog
        open={!!resetTarget}
        onOpenChange={(open) => {
          if (!open) {
            setResetTarget(null)
            setResetInput('')
          }
        }}
        title='重置'
        desc={
          resetTarget ? (
            <>
              <p className='flex min-w-0 items-center gap-1.5'>
                <SlotIdentity vm={resetTarget} compact />
                <span className='shrink-0 text-muted-foreground'>
                  · {resetTarget.id}
                </span>
              </p>
              <p className='mt-2 text-destructive'>
                销毁容器与家目录，再按原槽位重新创建。保留
                ID、名称、内核、时区、代理和种子策略。凭证、指纹、统计和 guest
                家目录会清空。
              </p>
            </>
          ) : (
            ''
          )
        }
        confirmText='销毁并重建'
        cancelBtnText='取消'
        destructive
        disabled={resetInput.trim() !== resetTarget?.id}
        isLoading={resetVm.isPending}
        handleConfirm={() => {
          if (resetTarget) resetVm.mutate(resetTarget.id)
        }}
      >
        <Input
          autoFocus
          autoComplete='off'
          spellCheck={false}
          placeholder={resetTarget?.id}
          aria-label='确认 ID'
          value={resetInput}
          onChange={(e) => setResetInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && resetInput.trim() === resetTarget?.id) {
              resetVm.mutate(resetTarget.id)
            }
          }}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
            setDeleteInput('')
          }
        }}
        title='删除'
        desc={
          deleteTarget ? (
            <>
              <p className='flex min-w-0 items-center gap-1.5'>
                <SlotIdentity vm={deleteTarget} compact />
                <span className='shrink-0 text-muted-foreground'>
                  · {deleteTarget.id}
                </span>
              </p>
              <p className='mt-2 text-destructive'>
                删除槽位不可恢复：容器、家目录、凭证与代理绑定一并清除。活跃槽位需先切换活跃再删。
              </p>
            </>
          ) : (
            ''
          )
        }
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        disabled={deleteInput.trim() !== deleteTarget?.id}
        isLoading={deleteVm.isPending}
        handleConfirm={() => {
          if (deleteTarget) deleteVm.mutate(deleteTarget.id)
        }}
      >
        <Input
          autoFocus
          autoComplete='off'
          spellCheck={false}
          placeholder={deleteTarget?.id}
          aria-label='确认 ID'
          value={deleteInput}
          onChange={(e) => setDeleteInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && deleteInput.trim() === deleteTarget?.id) {
              deleteVm.mutate(deleteTarget.id)
            }
          }}
        />
      </ConfirmDialog>
      <CreateVmDialog open={createOpen} onOpenChange={setCreateOpen} />
    </PageHeader>
  )
}
