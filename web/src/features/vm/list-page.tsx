import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
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
import { Slider } from '@/components/ui/slider'
import { ChoiceTiles } from '@/components/choice-tiles'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { SlotIdentity } from '@/components/platform-chip'
import { QueryGate } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import {
  GeminiStartupStatus,
  geminiInventoryOptions,
  geminiPayloadIssue,
} from '@/features/import/gemini-environments'
import { usageQueryOptions } from '@/features/overview/queries'
import { proxiesQueryOptions } from '@/features/proxies/queries'
import { GeminiMaintenanceLink } from '@/features/settings/gemini-maintenance-link'
import { planDeleteActiveVm } from '@/features/vm/active-vm'
import { CreateVmDialog } from '@/features/vm/create-vm-dialog'
import {
  DeleteActiveVmHint,
  NodeGoneDeleteOption,
} from '@/features/vm/delete-active-hint'
import {
  completeVmDeletion,
  useNodeGone,
  vmDeletePath,
  type VmDeleteResult,
} from '@/features/vm/delete-vm'
import { FleetPulse } from '@/features/vm/fleet-pulse'
import { geminiSlot } from '@/features/vm/gemini-slot'
import { VmListSkeleton } from '@/features/vm/list-skeleton'
import { vmsListQueryOptions } from '@/features/vm/queries'
import { usePoolSeatStream } from '@/features/vm/use-pool-seat-stream'
import { VmActionsProvider } from '@/features/vm/vm-actions-provider'
import { vmPermsFor } from '@/features/vm/vm-perms'
import { VmRack } from '@/features/vm/vm-rack'
import type { RackSize } from '@/features/vm/vm-rack-blade'
import type { VmZoneFilter } from '@/features/vm/vm-rack-model'
import {
  filterVms,
  KindFilterChips,
  sortVms,
  VmTable,
  type VmKindFilter,
  type VmSortKey,
} from '@/features/vm/vm-table'
import { resetNotice } from './reset-start-copy'

const SORT_CHIPS = [
  ['status', '状态'],
  ['name', '名称'],
  ['remain', '5H 剩余'],
  ['today', '今日花费 · 北京时间'],
  ['cost7', '7 天窗口费用'],
  ['total', '总计费用'],
  ['cache', '缓存命中'],
] as const

const SIZES: [RackSize, string, string][] = [
  ['s', '小', '小卡：一屏看全队'],
  ['m', '中', '中卡：日常巡检'],
  ['l', '大', '大卡：逐台核对'],
]

const LS_VIEW = 'vm-list-view'
const LS_SIZE = 'vm-rack-size'
const LS_ZOOM = 'vm-list-zoom'
const ZOOM_MIN = 100
const ZOOM_MAX = 200

function readZoom(): number {
  try {
    const n = Number(localStorage.getItem(LS_ZOOM))
    if (Number.isInteger(n) && n >= ZOOM_MIN && n <= ZOOM_MAX) return n
  } catch {
    // 隐私模式读不到时用 100%。
  }
  return ZOOM_MIN
}

function readPref<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  try {
    const v = localStorage.getItem(key)
    return allowed.includes(v as T) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 隐私模式 / 配额满：本次会话内仍按内存状态生效。
  }
}

export function VmListPage() {
  const me = useQuery(meQueryOptions())
  const vmsQ = useQuery(vmsListQueryOptions(5000))
  const isAdmin = me.data?.role === 'admin'
  const gemini = useQuery({ ...geminiInventoryOptions(), enabled: isAdmin })
  const proxies = useQuery({ ...proxiesQueryOptions(), enabled: isAdmin })
  usePoolSeatStream()
  const usage = useQuery({
    ...usageQueryOptions(5000),
    enabled: me.data?.role !== 'user',
  })
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<VmZoneFilter>('all')
  const [kind, setKind] = useState<VmKindFilter>('all')
  const [view, setViewState] = useState(() =>
    readPref(LS_VIEW, ['grid', 'list'] as const, 'grid')
  )
  const [size, setSizeState] = useState(() =>
    readPref(LS_SIZE, ['s', 'm', 'l'] as const, 'l')
  )
  const [zoom, setZoomState] = useState(readZoom)
  const setView = (next: 'grid' | 'list') => {
    setViewState(next)
    writePref(LS_VIEW, next)
  }
  const setSize = (next: RackSize) => {
    setSizeState(next)
    writePref(LS_SIZE, next)
  }
  const setZoom = (next: number) => {
    const value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next)))
    setZoomState(value)
    try {
      localStorage.setItem(LS_ZOOM, String(value))
    } catch {
      // 写不进去只影响下次打开。
    }
  }
  const [sort, setSort] = useState<VmSortKey>('status')
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const [resetTarget, setResetTarget] = useState<Vm | null>(null)
  const [resetMode, setResetMode] = useState<'keep' | 'traits'>('keep')
  const [resetInput, setResetInput] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Vm | null>(null)
  const [deleteInput, setDeleteInput] = useState('')
  const [forceDelete, setForceDelete] = useState(false)
  const nodeGone = useNodeGone(deleteTarget)
  const [createOpen, setCreateOpen] = useState(false)
  const resetVm = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: 'keep' | 'traits' }) =>
      api(`/api/panel/vms/${encodeURIComponent(id)}/reset`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
      }),
    onSuccess: async (data, { mode }) => {
      const notice = resetNotice(mode, undefined, data)
      toast[notice.level](notice.message)
      setResetTarget(null)
      setResetInput('')
      await qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const deleteVm = useMutation({
    mutationFn: async ({
      id,
      switchTo,
      force,
    }: {
      id: string
      switchTo?: string
      force?: boolean
    }) => {
      if (switchTo) {
        await api(`/api/panel/vms/${encodeURIComponent(switchTo)}/activate`, {
          method: 'POST',
        })
      }
      return api<VmDeleteResult>(vmDeletePath(id, force), {
        method: 'DELETE',
      })
    },
    onSuccess: async (data, { id, switchTo }) => {
      setDeleteTarget(null)
      setDeleteInput('')
      setForceDelete(false)
      await completeVmDeletion(
        qc,
        data,
        switchTo ? `已切换活跃到 ${switchTo} 并删除 ${id}` : '已删除'
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const vms: Vm[] = vmsQ.data?.items || []
  const geminiInventory = isAdmin ? gemini.data : undefined
  const geminiNeedsMaintenance =
    gemini.isError ||
    (geminiInventory &&
      (!geminiInventory.available ||
        !!geminiPayloadIssue(geminiInventory) ||
        !!geminiInventory.oauth_runtime_issue))
  const slots = geminiInventory?.available
    ? [
        ...vms,
        ...geminiInventory.environments.map((environment) =>
          geminiSlot(environment, geminiInventory, proxies.data?.proxies)
        ),
      ]
    : vms
  const poolQueue = vmsQ.data?.pool_queue
  const accounts = usage.data?.accounts
  const canCreate =
    me.data?.role === 'admin' ||
    (me.data?.role === 'user' && (me.data.vm_create_quota || 0) > 0)
  const perms = vmPermsFor(me.data?.role)
  const scoped = filterVms(slots, '', 'all', kind)
  const list = sortVms(filterVms(slots, q, filter, kind), sort, dir, accounts)
  const deletePlan = deleteTarget
    ? planDeleteActiveVm(deleteTarget, vms)
    : { kind: 'normal' as const }
  const deleteBlocked = deletePlan.kind === 'blocked'
  const deleteSwitchId =
    deletePlan.kind === 'switch' ? deletePlan.replacement.id : undefined

  return (
    <PageHeader
      title={VIEW_TITLES.vm}
      description='槽位和账号用量。按服务器分机架、按状态分区；未探测的额度不会冒充可用。'
      fluid
      extra={
        poolQueue || canCreate ? (
          <div className='flex flex-wrap items-center gap-3'>
            {poolQueue ? (
              <span
                className={cn(
                  'text-xs text-muted-foreground tabular-nums',
                  poolQueue.global_queue_depth > 0 &&
                    'text-[color:var(--status-warn)]'
                )}
                title='还没落到任何 VM、在等新席位的 Claude 请求数 / 允许排队数量（上限按全部排队请求计，含各 VM 上的排队，见状态列）'
              >
                全局排队 {poolQueue.global_queue_depth}/{poolQueue.queue_max}
              </span>
            ) : null}
            {isAdmin ? (
              <Button asChild variant='outline'>
                <Link to='/import' search={{ tab: 'gemini' }}>
                  导入 Gemini
                </Link>
              </Button>
            ) : null}
            {isAdmin && kind !== 'gemini' && geminiNeedsMaintenance ? (
              <GeminiMaintenanceLink />
            ) : null}
            {canCreate ? (
              <Button onClick={() => setCreateOpen(true)}>创建</Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <QueryGate
        loading={vmsQ.isLoading}
        error={vmsQ.error}
        skeleton={<VmListSkeleton />}
      >
        {isAdmin && kind === 'gemini' && gemini.isError ? (
          <div className='mb-3 space-y-1'>
            <p role='alert' className='text-sm text-destructive'>
              读取 Gemini 环境失败，可前往设置诊断宿主服务。
            </p>
            <GeminiMaintenanceLink />
          </div>
        ) : kind === 'gemini' && geminiInventory ? (
          <div className='mb-3'>
            <GeminiStartupStatus inventory={geminiInventory} />
          </div>
        ) : null}
        <FleetPulse
          className='mb-3'
          vms={scoped}
          accounts={accounts}
          filter={filter}
          onFilter={setFilter}
        />
        <div className='mb-4 flex flex-wrap items-center gap-2'>
          <KindFilterChips
            vms={slots}
            kind={kind}
            onChange={setKind}
            showGemini={isAdmin}
          />
          <Separator orientation='vertical' className='mx-1 h-5' />
          <Input
            className='h-8 w-64'
            type='search'
            name='vm-filter'
            autoComplete='off'
            data-1p-ignore
            data-lpignore='true'
            data-bwignore
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
            {view === 'grid' ? (
              <div
                role='group'
                aria-label='卡片大小'
                className='inline-flex gap-0.5 rounded-lg bg-muted p-0.5'
              >
                {SIZES.map(([key, label, title]) => (
                  <button
                    key={key}
                    type='button'
                    title={title}
                    aria-pressed={size === key}
                    onClick={() => setSize(key)}
                    className={cn(
                      'h-7 min-w-8 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground',
                      size === key &&
                        'bg-card text-foreground shadow-[0_1px_2px_oklch(0_0_0/12%),0_0_0_1px_var(--border)]'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            {view === 'list' ? (
              <div className='flex items-center gap-2'>
                <span className='text-xs text-muted-foreground'>放大</span>
                <Slider
                  className='w-28'
                  min={ZOOM_MIN}
                  max={ZOOM_MAX}
                  step={10}
                  value={[zoom]}
                  aria-label='列表放大'
                  onValueChange={(next) => setZoom(next[0] ?? ZOOM_MIN)}
                />
                <span className='w-10 text-right font-mono text-xs text-muted-foreground tabular-nums'>
                  {zoom}%
                </span>
              </div>
            ) : null}
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
        <VmActionsProvider
          accounts={accounts}
          onReset={
            perms.admin
              ? (vm) => {
                  setResetInput('')
                  setResetTarget(vm)
                }
              : undefined
          }
          onDelete={
            perms.remove
              ? (vm) => {
                  setDeleteInput('')
                  setForceDelete(false)
                  setDeleteTarget(vm)
                }
              : undefined
          }
        >
          {list.length ? (
            view === 'grid' ? (
              <VmRack
                vms={list}
                accounts={accounts}
                filter={filter}
                size={size}
                onCreate={canCreate ? () => setCreateOpen(true) : undefined}
              />
            ) : (
              <VmTable vms={list} accounts={accounts} zoom={zoom} />
            )
          ) : (
            <EmptyState
              reason='没有符合当前筛选的槽位。'
              actionLabel={canCreate ? '创建' : undefined}
              onAction={canCreate ? () => setCreateOpen(true) : undefined}
            />
          )}
        </VmActionsProvider>
      </QueryGate>
      <ConfirmDialog
        open={!!resetTarget}
        onOpenChange={(open) => {
          if (!open) {
            setResetTarget(null)
            setResetInput('')
          }
        }}
        title='重建槽位'
        desc={
          resetTarget ? (
            <>
              <p className='flex min-w-0 items-center gap-1.5'>
                <SlotIdentity vm={resetTarget} compact />
                <span className='shrink-0 text-muted-foreground'>
                  · {resetTarget.id}
                </span>
              </p>
              <p className='mt-2'>
                本地槽和集群槽都换当前 kernel、cli-node 与 Go 遥测后的容器。
              </p>
            </>
          ) : (
            ''
          )
        }
        confirmText={resetMode === 'keep' ? '保留原数据重建' : '重建新特征'}
        cancelBtnText='取消'
        destructive={resetMode === 'traits'}
        disabled={resetInput.trim() !== resetTarget?.id}
        isLoading={resetVm.isPending}
        handleConfirm={() => {
          if (resetTarget)
            resetVm.mutate({ id: resetTarget.id, mode: resetMode })
        }}
      >
        <ChoiceTiles
          label='重建方式'
          value={resetMode}
          onChange={setResetMode}
          choices={[
            {
              value: 'keep',
              title: '保留原数据重建',
              detail: '留下凭证、指纹、主机名和统计，只换容器里的服务。',
            },
            {
              value: 'traits',
              title: '重建新特征',
              detail:
                '清掉凭证和家目录，重新生成主机名、machine-id 和设备特征。',
            },
          ]}
        />
        <Input
          autoFocus
          autoComplete='off'
          spellCheck={false}
          placeholder={resetTarget?.id}
          aria-label='确认 ID'
          value={resetInput}
          onChange={(e) => setResetInput(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              resetInput.trim() === resetTarget?.id &&
              !resetVm.isPending &&
              resetTarget
            ) {
              resetVm.mutate({ id: resetTarget.id, mode: resetMode })
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
            setForceDelete(false)
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
              <DeleteActiveVmHint
                target={deleteTarget}
                vms={vms}
                force={forceDelete && !!nodeGone}
              />
            </>
          ) : (
            ''
          )
        }
        confirmText={deletePlan.kind === 'switch' ? '切换活跃并删除' : '删除'}
        cancelBtnText='取消'
        destructive
        disabled={deleteBlocked || deleteInput.trim() !== deleteTarget?.id}
        isLoading={deleteVm.isPending}
        handleConfirm={() => {
          if (deleteTarget && !deleteBlocked) {
            deleteVm.mutate({
              id: deleteTarget.id,
              switchTo: deleteSwitchId,
              force: forceDelete && !!nodeGone,
            })
          }
        }}
      >
        <NodeGoneDeleteOption
          gone={nodeGone}
          checked={forceDelete}
          onCheckedChange={setForceDelete}
        />
        <Input
          autoFocus
          autoComplete='off'
          spellCheck={false}
          placeholder={deleteTarget?.id}
          aria-label='确认 ID'
          value={deleteInput}
          onChange={(e) => setDeleteInput(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              deleteInput.trim() === deleteTarget?.id &&
              !deleteVm.isPending &&
              !deleteBlocked
            ) {
              deleteVm.mutate({
                id: deleteTarget.id,
                switchTo: deleteSwitchId,
                force: forceDelete && !!nodeGone,
              })
            }
          }}
        />
      </ConfirmDialog>
      <CreateVmDialog open={createOpen} onOpenChange={setCreateOpen} />
    </PageHeader>
  )
}
