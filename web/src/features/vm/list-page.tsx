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
import { cn } from '@/lib/utils'
import { fleetCounts, poolStatus } from '@/lib/vm-status'
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
import { StatusMark } from '@/components/status-mark'
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

// fleetGroup 粗分 5 档。revoke 单列：吊销要换票，过期可能自动刷回来。
// 冷却 / 额度紧被并进「在池」，单独作为异常提示补在筛选行末尾。
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
  // chips 的计数走 fleetGroup 粗分（无效凭证含 revoke，与档位口径一致）。
  // 冷却 / 额度紧在粗分里被并进「在池」，只有它们需要 poolStatus 的细分 key。
  const scoped = filterVms(vms, '', 'all', kind)
  const counts = fleetCounts(scoped)
  let cooling = 0
  let limited = 0
  for (const vm of scoped) {
    const key = poolStatus(vm).key
    if (key === 'cool') cooling += 1
    else if (key === 'quota') limited += 1
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
        <div className='mb-3 flex flex-wrap items-center gap-2'>
          <KindFilterChips vms={vms} kind={kind} onChange={setKind} />
          <Separator orientation='vertical' className='mx-1 h-5' />
          {POOL_CHIPS.map(([key, label]) => (
            <Button
              key={key}
              size='sm'
              variant={filter === key ? 'default' : 'outline'}
              aria-pressed={filter === key}
              onClick={() =>
                setFilter(filter === key && key !== 'all' ? 'all' : key)
              }
            >
              {label}
              <span
                className={cn(
                  'tabular-nums',
                  filter === key ? 'opacity-75' : 'text-muted-foreground'
                )}
              >
                {counts[key]}
              </span>
            </Button>
          ))}
          {cooling || limited ? (
            <div className='ms-auto flex items-center gap-3'>
              {cooling ? (
                <StatusMark
                  tone={{
                    cls: 'caution',
                    key: 'cool',
                    text: `冷却中 ${cooling} 台`,
                    label: `冷却 ${cooling}`,
                  }}
                />
              ) : null}
              {limited ? (
                <StatusMark
                  tone={{
                    cls: 'warn',
                    key: 'quota',
                    text: `额度紧 ${limited} 台`,
                    label: `额度紧 ${limited}`,
                  }}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        <div className='mb-4 flex flex-wrap items-center gap-2'>
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
