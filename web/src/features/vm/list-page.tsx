import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fleetCounts, poolStatus } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { SlotIdentity } from '@/components/platform-chip'
import { QueryGate } from '@/components/query-gate'
import { StatCard } from '@/components/stat-card'
import { meQueryOptions } from '@/features/auth/queries'
import { usageQueryOptions } from '@/features/overview/queries'
import { CreateVmDialog } from '@/features/vm/create-vm-dialog'
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

// 与集群页 FLEET_CHIPS 共用同一套档位与标签，两页词汇必须一致。
// 早先这里是 poolStatus 的细分 7 档（冷却 / 额度紧单列），与集群页对不上，已统一。
// 细分口径没丢：顶部统计卡仍单独报「冷却 / 额度紧」。
// revoke 单列一档：吊销要换票，过期可能自动刷回来，处置方式不同。
const POOL_CHIPS = [
  ['all', '全部'],
  ['pool', '在池'],
  ['off', '关闭调用'],
  ['none', '未使用'],
  ['bad', '无效凭证'],
  ['revoke', '已吊销'],
] as const

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
  const vms: Vm[] = vmsQ.data?.items || []
  const accounts = usage.data?.accounts
  const canCreate =
    me.data?.role === 'admin' ||
    (me.data?.role === 'user' && (me.data.vm_create_quota || 0) > 0)
  // chips 走 fleetGroup 粗分（与集群页同口径）；顶部 StatCard 的前三张仍要
  // poolStatus 的细分，才能单独报「冷却 / 额度紧」—— 两套计数并存是有意的。
  // 最后一张回到 fleetCounts：无效凭证要含 revoke，与 chip 计数对得上。
  const scoped = filterVms(vms, '', 'all', kind)
  const counts = fleetCounts(scoped)
  const fine = { pool: 0, cool: 0, quota: 0, off: 0, none: 0 }
  for (const vm of scoped) {
    const key = poolStatus(vm).key as keyof typeof fine
    if (key in fine) fine[key] += 1
  }
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
        <div className='mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
          <StatCard label='在池' value={String(fine.pool)} />
          <StatCard
            label='冷却 / 额度紧'
            value={String(fine.cool + fine.quota)}
            tone={fine.cool + fine.quota > 0 ? 'caution' : 'neutral'}
          />
          <StatCard
            label='调度关'
            value={String(fine.off)}
            tone={fine.off > 0 ? 'warn' : 'neutral'}
          />
          <StatCard
            label='无效凭证 / 未使用'
            value={String(counts.bad + counts.revoke + counts.none)}
            tone={
              counts.bad + counts.revoke + counts.none > 0 ? 'bad' : 'neutral'
            }
          />
        </div>
        <div className='mb-3 flex flex-wrap gap-2'>
          <Input
            className='w-64'
            placeholder='搜索名称 / 邮箱 / 代理'
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <KindFilterChips vms={vms} kind={kind} onChange={setKind} />
          <div className='ms-auto flex gap-2'>
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
        </div>
        <div className='mb-4 flex flex-wrap items-center gap-2'>
          {POOL_CHIPS.map(([key, label]) => (
            <Button
              key={key}
              size='sm'
              variant={filter === key ? 'default' : 'outline'}
              onClick={() =>
                setFilter(filter === key && key !== 'all' ? 'all' : key)
              }
            >
              {label} {counts[key]}
            </Button>
          ))}
          <div className='ms-auto flex flex-wrap items-center gap-2'>
            <span className='text-xs text-muted-foreground'>排序</span>
            {SORT_CHIPS.map(([key, label]) => (
              <Button
                key={key}
                size='sm'
                variant={sort === key ? 'default' : 'outline'}
                aria-pressed={sort === key}
                onClick={() => {
                  if (sort === key) {
                    setDir(dir === 'asc' ? 'desc' : 'asc')
                  } else {
                    setSort(key)
                    setDir(key === 'name' ? 'asc' : 'desc')
                  }
                }}
              >
                {label}
                {sort === key ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
              </Button>
            ))}
          </div>
        </div>
        {list.length ? (
          view === 'grid' ? (
            <VmCards
              vms={list}
              onReset={(vm) => {
                setResetInput('')
                setResetTarget(vm)
              }}
            />
          ) : (
            <VmTable
              vms={list}
              accounts={accounts}
              onReset={(vm) => {
                setResetInput('')
                setResetTarget(vm)
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
      <CreateVmDialog open={createOpen} onOpenChange={setCreateOpen} />
    </PageHeader>
  )
}
