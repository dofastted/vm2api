import { useCallback, useDeferredValue, useMemo, useState } from 'react'
import { useMutation, useMutationState, useQuery } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type { VmProxySnap } from '@/types/panel-vm'
import { Plus, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useVmIndex } from '@/hooks/use-vm-index'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { SectionSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import { ProxyBulkActions } from './proxy-bulk-actions'
import { ProxyEditDialog } from './proxy-edit-dialog'
import { createProxyHover } from './proxy-hover'
import { ProxyImportPanel } from './proxy-import-panel'
import { ProxyList } from './proxy-list'
import { ProxyManagePanel } from './proxy-manage-panel'
import { ProxyOverview } from './proxy-overview'
import {
  type ProxyRegionFilter,
  REGION_ANY,
  proxyInRegion,
  regionGroups,
  regionLabel,
} from './proxy-region'
import { ProxyRegionRail } from './proxy-region-rail'
import {
  bindOutcome,
  deleteConfirmText,
  disableConfirmText,
} from './proxy-results'
import type { ProxyRowActions } from './proxy-row'
import {
  PROXY_SORT_DEFAULT_DIR,
  type ProxyFilter,
  type ProxySortKey,
  proxyBoundIds,
  proxyLabel,
  proxyInFilter,
  proxyIsControlLocal,
  proxyMatchesQuery,
  readPositive,
  sortedProxies,
} from './proxy-sort'
import { proxiesQueryOptions, useRefreshProxies } from './queries'

const PROBE_KEY = ['panel', 'proxies', 'probe'] as const
const GEO_KEY = ['panel', 'proxies', 'geo'] as const
const COPY_KEY = ['panel', 'proxies', 'reveal'] as const
const TOGGLE_KEY = ['panel', 'proxies', 'toggle'] as const
const LS_RAIL_COLLAPSED = 'kin_proxy_region_rail_collapsed'

function readRailCollapsed(): boolean {
  try {
    return localStorage.getItem(LS_RAIL_COLLAPSED) === '1'
  } catch {
    return false
  }
}

function writeRailCollapsed(next: boolean) {
  try {
    localStorage.setItem(LS_RAIL_COLLAPSED, next ? '1' : '0')
  } catch {
    // 隐私模式 / 配额满：本次会话内仍按内存状态生效。
  }
}

/** 某类单条操作当前在哪些代理上进行中。支持多行同时转圈。 */
function usePendingIds(mutationKey: readonly string[]): Set<string> {
  const ids = useMutationState({
    filters: { mutationKey, status: 'pending' },
    select: (m) => {
      const v = m.state.variables
      if (typeof v === 'string') return v
      if (v && typeof v === 'object' && 'id' in v) return String(v.id)
      return ''
    },
  })
  return new Set(ids)
}

function firstOf(set: Set<string>): string {
  for (const id of set) return id
  return ''
}

export function ProxiesPage() {
  const px = useQuery(proxiesQueryOptions())
  const me = useQuery(meQueryOptions())
  // 租户只能增删改自己的代理；测通、测地理、启停、绑定、池设置都是管理员接口。
  const canManage = me.data?.role === 'admin'
  const { list: vms } = useVmIndex()
  const refresh = useRefreshProxies()
  const [hover] = useState(createProxyHover)
  const [sortKey, setSortKey] = useState<ProxySortKey>('status')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [filter, setFilter] = useState<ProxyFilter>('all')
  const [query, setQuery] = useState('')
  const [region, setRegion] = useState<ProxyRegionFilter>(REGION_ANY)
  const [railCollapsed, setRailCollapsed] = useState(readRailCollapsed)
  // 关闭时只收 open，内容保持到滑出动画结束，不会在关的那一刻闪成另一个面板。
  const [drawer, setDrawer] = useState<{
    open: boolean
    kind: 'import' | 'settings'
  }>({ open: false, kind: 'import' })
  const [dragVm, setDragVm] = useState('')
  const [delId, setDelId] = useState('')
  const [disableId, setDisableId] = useState('')
  const [editId, setEditId] = useState('')
  const [unbindTarget, setUnbindTarget] = useState<{
    id: string
    vmId: string
  } | null>(null)
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())

  const list = useMemo(() => px.data?.proxies || [], [px.data?.proxies])
  const tot = px.data?.totals || {}
  const cfg = px.data?.config || {}
  // 回落序对齐 index.html:7756 的 proxyBindLimit()：totals 先于 config。
  const bindLimit = readPositive(
    tot,
    'bind_limit',
    readPositive(cfg, 'bind_limit', 5)
  )
  const probeMin = readPositive(cfg, 'probe_interval_min', 10)
  const total = Number(tot.total ?? list.length)
  const slotsUsed = Number(tot.slots_used ?? tot.bound ?? 0)
  const slotsCap = Number(tot.slots_cap ?? total * bindLimit)

  const sorted = useMemo(
    () => sortedProxies(list, sortKey, sortDir),
    [list, sortKey, sortDir]
  )
  const vmById = useMemo(() => new Map(vms.map((v) => [v.id, v])), [vms])
  const ownerOf = useMemo(() => {
    const out = new Map<string, VmProxySnap>()
    for (const p of list) for (const id of proxyBoundIds(p)) out.set(id, p)
    return out
  }, [list])
  // 输入即「挑可用节点」：有关键词时只留可绑且有空位的，空关键词仍看全集。
  // 地区之外的全部筛选；地区栏的计数也按它算，所以单独留一个谓词。
  const matchesOthers = useCallback(
    (p: VmProxySnap) =>
      proxyInFilter(p, filter, bindLimit) &&
      (!deferredQuery || proxyInFilter(p, 'open', bindLimit)) &&
      proxyMatchesQuery(p, deferredQuery, (id) => vmById.get(id)?.name || ''),
    [filter, bindLimit, deferredQuery, vmById]
  )
  const matches = useCallback(
    (p: VmProxySnap) => proxyInRegion(p, region) && matchesOthers(p),
    [region, matchesOthers]
  )
  const rows = useMemo(() => sorted.filter(matches), [sorted, matches])
  const regions = useMemo(
    () => regionGroups(list, bindLimit, matchesOthers),
    [list, bindLimit, matchesOthers]
  )
  const regionTotals = regions.reduce(
    (acc, g) => ({ count: acc.count + g.count, free: acc.free + g.free }),
    { count: 0, free: 0 }
  )
  const regionText = region.country
    ? [regionLabel(region.country), region.city].filter(Boolean).join(' · ')
    : ''
  const deleting = list.find((p) => p.id === delId)
  const delBound = proxyBoundIds(deleting).length
  const disabling = list.find((p) => p.id === disableId)
  const editing = list.find((p) => p.id === editId) || null

  const probeOne = useMutation({
    mutationKey: PROBE_KEY,
    mutationFn: (id: string) =>
      api(`/api/panel/proxies/${encodeURIComponent(id)}/probe`, {
        method: 'POST',
      }),
    onSuccess: async () => {
      toast.success('探测完成')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const geoOne = useMutation({
    mutationKey: GEO_KEY,
    mutationFn: (id: string) =>
      api<{ geo?: { timezone?: string | null; country?: string | null } }>(
        `/api/panel/proxies/${encodeURIComponent(id)}/geo`,
        { method: 'POST' }
      ),
    onSuccess: async (data) => {
      const where = [data.geo?.country, data.geo?.timezone]
        .filter(Boolean)
        .join(' · ')
      toast.success(where ? `出口位置 ${where}` : '已检测')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/proxies/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      toast.success('已删除')
      setDelId('')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const setEnabled = useMutation({
    mutationKey: TOGGLE_KEY,
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      api(
        `/api/panel/proxies/${encodeURIComponent(id)}/${on ? 'enable' : 'disable'}`,
        { method: 'POST' }
      ),
    onSuccess: async (_data, { on }) => {
      toast.success(on ? '已启用' : '已禁用')
      setDisableId('')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const bind = useMutation({
    mutationFn: ({ id, vmId }: { id: string; vmId: string }) =>
      api<{ worker?: { ok?: boolean; error?: unknown } | null }>(
        `/api/panel/proxies/${encodeURIComponent(id)}/bind`,
        {
          method: 'POST',
          body: JSON.stringify({ vm_id: vmId }),
        }
      ),
    onSuccess: async (data, { id, vmId }) => {
      const to = list.find((p) => p.id === id)
      const from = ownerOf.get(vmId)
      const name = vmById.get(vmId)?.name || vmId
      const out = bindOutcome(
        from && from.id !== id
          ? `${name} 已从 ${proxyLabel(from)} 换绑到 ${to ? proxyLabel(to) : id}`
          : `${name} 已绑定`,
        data?.worker
      )
      toast[out.level](out.text)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const unbind = useMutation({
    mutationFn: ({ id, vmId }: { id: string; vmId: string }) =>
      api(`/api/panel/proxies/${encodeURIComponent(id)}/unbind`, {
        method: 'POST',
        body: JSON.stringify({ vm_id: vmId }),
      }),
    onSuccess: async () => {
      toast.success('已解绑')
      setUnbindTarget(null)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  /**
   * 取回含账密的 SOCKS5 地址并写入剪贴板。
   *
   * URI 只在这个回调里存活，不进 state、不渲染 —— 复制到剪贴板与显示在页面上
   * 是两个风险级别，后者会进 DOM、DevTools 和截图。见 api-contract.md。
   */
  const copyUri = useMutation({
    mutationKey: COPY_KEY,
    mutationFn: (id: string) =>
      api<{ uri?: string }>(
        `/api/panel/proxies/${encodeURIComponent(id)}/reveal`,
        { method: 'POST' }
      ),
    onSuccess: async (data) => {
      const uri = data.uri || ''
      if (!uri) {
        toast.error('未取到地址')
        return
      }
      try {
        await navigator.clipboard.writeText(uri)
        toast.success('已复制代理地址（含账密）')
      } catch {
        // 剪贴板 API 需要安全上下文（HTTPS 或 localhost），失败要说明白，
        // 而不是静默什么都没发生。这里也不把 uri 兜底渲染出来。
        toast.error('浏览器拒绝了剪贴板写入，请检查是否在 HTTPS 下访问')
      }
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const probing = usePendingIds(PROBE_KEY)
  const geoing = usePendingIds(GEO_KEY)
  const copying = usePendingIds(COPY_KEY)
  const toggling = usePendingIds(TOGGLE_KEY)

  const actions: ProxyRowActions = {
    onCopy: (id) => copyUri.mutate(id),
    onEdit: setEditId,
    onDelete: setDelId,
    onVmDragChange: setDragVm,
    ...(canManage
      ? {
          onProbe: (id: string) => probeOne.mutate(id),
          onGeo: (id: string) => geoOne.mutate(id),
          onToggleEnabled: (item: VmProxySnap) => {
            if (!item.id) return
            // 禁用会让绑在上面的槽位全部停调度，先确认；启用直接生效。
            if (item.enabled === false) {
              setEnabled.mutate({ id: item.id, on: true })
            } else {
              setDisableId(item.id)
            }
          },
          onBind: (id: string, vmId: string) => bind.mutate({ id, vmId }),
          onUnbind: (id: string, vmId: string) => setUnbindTarget({ id, vmId }),
        }
      : {}),
  }

  function changeSortKey(next: ProxySortKey) {
    setSortKey(next)
    setSortDir(PROXY_SORT_DEFAULT_DIR[next])
  }

  function sortBy(key: ProxySortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else changeSortKey(key)
  }

  function locate(id: string) {
    // 目标被筛掉时先放开筛选，否则「点列定位」会落空。
    const target = list.find((p) => p.id === id)
    if (target && !rows.some((p) => p.id === id)) {
      setFilter('all')
      setQuery('')
      setRegion(REGION_ANY)
    }
    requestAnimationFrame(() => {
      const el = document.getElementById(`proxy-row-${id}`)
      if (!el) return
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
      el.scrollIntoView({
        block: 'center',
        behavior: reduce.matches ? 'auto' : 'smooth',
      })
      hover.set(id)
    })
  }

  return (
    <PageHeader
      title={VIEW_TITLES.proxies}
      extra={
        <div className='flex flex-wrap items-center gap-2'>
          {canManage ? (
            <>
              <ProxyBulkActions empty={!list.length} />
              <Button
                variant='outline'
                size='sm'
                onClick={() => setDrawer({ open: true, kind: 'settings' })}
              >
                <Settings2 aria-hidden='true' />
                池设置
              </Button>
            </>
          ) : null}
          <Button
            size='sm'
            onClick={() => setDrawer({ open: true, kind: 'import' })}
          >
            <Plus aria-hidden='true' />
            添加代理
          </Button>
        </div>
      }
    >
      <QueryGate
        loading={px.isLoading}
        error={px.error || (px.data?.error ? new Error(px.data.error) : null)}
        skeleton={
          <div className='space-y-4'>
            <SectionSkeleton
              titleWidth='w-16'
              showDescription={false}
              rows={2}
            />
            <div className='grid gap-4 2xl:grid-cols-[208px_minmax(0,1fr)]'>
              <SectionSkeleton
                titleWidth='w-10'
                showDescription={false}
                rows={6}
              />
              <SectionSkeleton
                titleWidth='w-40'
                showDescription={false}
                rows={8}
              />
            </div>
          </div>
        }
      >
        <div className='space-y-4'>
          <ProxyOverview
            proxies={sorted}
            vms={vms}
            ownerOf={ownerOf}
            poolLimit={bindLimit}
            slotsUsed={slotsUsed}
            slotsCap={slotsCap}
            probeMin={probeMin}
            filter={filter}
            onFilter={setFilter}
            regions={regions}
            region={region}
            onRegion={setRegion}
            hover={hover}
            visible={matches}
            onLocate={locate}
            onVmDragChange={setDragVm}
            canBind={canManage}
          />
          <div
            className={cn(
              'grid items-start gap-3 2xl:gap-4',
              railCollapsed
                ? '2xl:grid-cols-[60px_minmax(0,1fr)]'
                : '2xl:grid-cols-[208px_minmax(0,1fr)]'
            )}
          >
            <ProxyRegionRail
              groups={regions}
              value={region}
              onChange={setRegion}
              totalCount={regionTotals.count}
              totalFree={regionTotals.free}
              collapsed={railCollapsed}
              onCollapsedChange={(next) => {
                setRailCollapsed(next)
                writeRailCollapsed(next)
              }}
            />
            <ProxyList
              all={sorted}
              rows={rows}
              vms={vms}
              vmById={vmById}
              ownerOf={ownerOf}
              poolLimit={bindLimit}
              query={query}
              onQuery={setQuery}
              filter={filter}
              onFilter={setFilter}
              regionText={regionText}
              onClearRegion={() => setRegion(REGION_ANY)}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={sortBy}
              onSortKey={changeSortKey}
              onSortDir={() =>
                setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
              }
              hover={hover}
              dragVm={dragVm}
              pending={{
                probe: firstOf(probing),
                geo: firstOf(geoing),
                copy: firstOf(copying),
                toggle: firstOf(toggling),
                binding: bind.isPending || unbind.isPending,
              }}
              actions={actions}
            />
          </div>
        </div>
      </QueryGate>
      <Sheet
        open={drawer.open}
        onOpenChange={(open) => {
          if (!open) setDrawer((d) => ({ ...d, open: false }))
        }}
      >
        <SheetContent
          side='right'
          className='w-[95vw] gap-0 overflow-y-auto sm:max-w-[420px]'
        >
          <SheetHeader className='border-b'>
            <SheetTitle>
              {drawer.kind === 'settings' ? '池设置' : '添加代理'}
            </SheetTitle>
            <SheetDescription className='text-xs'>
              {drawer.kind === 'settings'
                ? '绑定上限、自动探测、出口 DNS 与时区跟随，对整个代理池生效。'
                : '粘贴 SOCKS5、HTTP 或 HTTPS 地址批量导入，或添加走所在 VPS 出口的本地代理。'}
            </SheetDescription>
          </SheetHeader>
          <div className='p-4'>
            {drawer.kind === 'settings' ? (
              <ProxyManagePanel
                proxies={list}
                bindLimit={bindLimit}
                probeMin={probeMin}
                dnsPrimary={String(cfg.dns_primary || 'auto')}
                dnsDisableSvcbHttps={cfg.dns_disable_svcb_https === true}
                followProxyTimezone={cfg.follow_proxy_timezone !== false}
              />
            ) : (
              <ProxyImportPanel hasLocal={list.some(proxyIsControlLocal)} />
            )}
          </div>
        </SheetContent>
      </Sheet>
      <ProxyEditDialog
        proxy={editing}
        onOpenChange={(open) => !open && setEditId('')}
      />
      <ConfirmDialog
        open={!!unbindTarget}
        onOpenChange={() => setUnbindTarget(null)}
        title='解绑代理'
        desc={`解绑后 ${
          vmById.get(unbindTarget?.vmId || '')?.name || unbindTarget?.vmId || ''
        } 将无法转发，确认？`}
        confirmText='解绑'
        cancelBtnText='取消'
        destructive
        isLoading={unbind.isPending}
        handleConfirm={() => {
          if (unbindTarget) unbind.mutate(unbindTarget)
        }}
      />
      <ConfirmDialog
        open={!!delId}
        onOpenChange={() => setDelId('')}
        title='删除代理'
        desc={deleteConfirmText(delBound)}
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => {
          if (delId) remove.mutate(delId)
        }}
      />
      <ConfirmDialog
        open={!!disableId}
        onOpenChange={() => setDisableId('')}
        title='禁用代理'
        desc={disableConfirmText(proxyBoundIds(disabling).length)}
        confirmText='禁用'
        cancelBtnText='取消'
        destructive
        isLoading={setEnabled.isPending}
        handleConfirm={() => {
          if (disableId) setEnabled.mutate({ id: disableId, on: false })
        }}
      />
    </PageHeader>
  )
}
