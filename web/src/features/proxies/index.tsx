import { useDeferredValue, useMemo, useState } from 'react'
import { useMutation, useMutationState, useQuery } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { SectionSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { ProxyEditDialog } from './proxy-edit-dialog'
import { createProxyHover } from './proxy-hover'
import { ProxyImportPanel } from './proxy-import-panel'
import { ProxyList } from './proxy-list'
import { ProxyManagePanel } from './proxy-manage-panel'
import { ProxyOverview } from './proxy-overview'
import { ProxyPanel } from './proxy-panel'
import type { ProxyRowActions } from './proxy-row'
import {
  PROXY_SORT_DEFAULT_DIR,
  type ProxyFilter,
  type ProxySortKey,
  proxyBoundIds,
  proxyLabel,
  proxyInFilter,
  proxyIsLocal,
  proxyRows,
  proxyScope,
  proxyViewId,
  proxyMatchesQuery,
  readPositive,
  sortedProxies,
} from './proxy-sort'
import { proxiesQueryOptions, useRefreshProxies } from './queries'

const PROBE_KEY = ['panel', 'proxies', 'probe'] as const
const GEO_KEY = ['panel', 'proxies', 'geo'] as const
const COPY_KEY = ['panel', 'proxies', 'reveal'] as const
const TOGGLE_KEY = ['panel', 'proxies', 'toggle'] as const

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
  const dash = useQuery(dashboardQueryOptions())
  const refresh = useRefreshProxies()
  const [hover] = useState(createProxyHover)
  const [sortKey, setSortKey] = useState<ProxySortKey>('status')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [filter, setFilter] = useState<ProxyFilter>('all')
  const [query, setQuery] = useState('')
  const [dragVm, setDragVm] = useState('')
  const [delId, setDelId] = useState('')
  const [editId, setEditId] = useState('')
  const [unbindTarget, setUnbindTarget] = useState<{
    id: string
    vmId: string
  } | null>(null)
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())

  const list = useMemo(() => proxyRows(px.data), [px.data])
  const canonicalLocal = px.data?.proxies?.find(proxyIsLocal)
  const tot = px.data?.totals || {}
  const cfg = px.data?.config || {}
  const vms: Vm[] = useMemo(() => dash.data?.vms || [], [dash.data?.vms])
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
  const rows = useMemo(
    () =>
      sorted.filter(
        (p) =>
          proxyInFilter(p, filter, bindLimit) &&
          proxyMatchesQuery(
            p,
            deferredQuery,
            (id) => vmById.get(id)?.name || ''
          )
      ),
    [sorted, filter, bindLimit, deferredQuery, vmById]
  )
  const deleting = px.data?.proxies?.find((p) => p.id === delId)
  const delBound = proxyBoundIds(deleting).length
  const editing = list.find((p) => p.id === editId) || null

  function rowRequest<T = unknown>(
    viewId: string,
    action: string,
    body: Record<string, unknown> = {}
  ): Promise<T> {
    const row = list.find((p) => proxyViewId(p) === viewId)
    if (!row?.id) return Promise.reject(new Error('出口已变化，请刷新后重试'))
    return api<T>(
      `/api/panel/proxies/${encodeURIComponent(row.id)}/${action}`,
      {
        method: 'POST',
        body: JSON.stringify({ ...body, ...proxyScope(row) }),
      }
    )
  }

  const probeOne = useMutation({
    mutationKey: PROBE_KEY,
    mutationFn: (id: string) => rowRequest(id, 'probe'),
    onSuccess: async () => {
      toast.success('探测完成')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const geoOne = useMutation({
    mutationKey: GEO_KEY,
    mutationFn: (id: string) =>
      rowRequest<{
        geo?: { timezone?: string | null; country?: string | null }
      }>(id, 'geo'),
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
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const bind = useMutation({
    mutationFn: ({ id, vmId }: { id: string; vmId: string }) =>
      rowRequest(id, 'bind', { vm_id: vmId }),
    onSuccess: async (_data, { id, vmId }) => {
      const to = list.find((p) => proxyViewId(p) === id)
      const from = ownerOf.get(vmId)
      const name = vmById.get(vmId)?.name || vmId
      toast.success(
        from && proxyViewId(from) !== id
          ? `${name} 已从 ${proxyLabel(from)} 换绑到 ${to ? proxyLabel(to) : id}`
          : `${name} 已绑定`
      )
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const unbind = useMutation({
    mutationFn: ({ id, vmId }: { id: string; vmId: string }) =>
      rowRequest(id, 'unbind', { vm_id: vmId }),
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
        toast.success('已复制 SOCKS5 地址（含账密）')
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
    onProbe: (id) => probeOne.mutate(id),
    onGeo: (id) => geoOne.mutate(id),
    onCopy: (id) => copyUri.mutate(id),
    onEdit: setEditId,
    onToggleEnabled: (item) => {
      if (!item.id) return
      setEnabled.mutate({ id: item.id, on: item.enabled === false })
    },
    onDelete: setDelId,
    onBind: (id, vmId) => bind.mutate({ id, vmId }),
    onUnbind: (id, vmId) => setUnbindTarget({ id, vmId }),
    onVmDragChange: setDragVm,
  }

  function changeSortKey(next: ProxySortKey) {
    setSortKey(next)
    setSortDir(PROXY_SORT_DEFAULT_DIR[next])
  }

  function locate(id: string) {
    // 目标被筛掉时先放开筛选，否则「点列定位」会落空。
    const target = list.find((p) => proxyViewId(p) === id)
    if (target && !rows.some((p) => proxyViewId(p) === id)) {
      setFilter('all')
      setQuery('')
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
    <PageHeader title={VIEW_TITLES.proxies}>
      <QueryGate
        loading={px.isLoading}
        error={px.error || (px.data?.error ? new Error(px.data.error) : null)}
        skeleton={
          <div className='grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[380px_minmax(0,1fr)]'>
            <div className='space-y-4'>
              <SectionSkeleton
                titleWidth='w-16'
                showDescription={false}
                rows={3}
              />
              <SectionSkeleton
                titleWidth='w-20'
                showDescription={false}
                rows={2}
              />
            </div>
            <SectionSkeleton
              titleWidth='w-40'
              showDescription={false}
              rows={8}
            />
          </div>
        }
      >
        <div className='grid items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[380px_minmax(0,1fr)]'>
          <aside
            aria-label='添加与管理代理'
            className='space-y-4 lg:sticky lg:top-20 lg:max-h-[calc(100svh-6rem)] lg:overflow-y-auto lg:overscroll-contain lg:pb-1'
          >
            <ProxyOverview
              proxies={sorted}
              vms={vms}
              ownerOf={ownerOf}
              poolLimit={bindLimit}
              slotsUsed={slotsUsed}
              slotsCap={slotsCap}
              filter={filter}
              onFilter={setFilter}
              hover={hover}
              onLocate={locate}
              onVmDragChange={setDragVm}
            />
            <ProxyImportPanel hasLocal={!!canonicalLocal} />
            {canonicalLocal?.id ? (
              <ProxyPanel title='所有节点的 local'>
                <p className='text-xs text-muted-foreground'>
                  各节点独立计算席位。以下操作作用于所有节点的 local 出口。
                </p>
                <div className='mt-3 flex gap-2'>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={setEnabled.isPending}
                    onClick={() =>
                      setEnabled.mutate({
                        id: canonicalLocal.id!,
                        on: canonicalLocal.enabled === false,
                      })
                    }
                  >
                    {canonicalLocal.enabled === false
                      ? '启用全部 local'
                      : '禁用全部 local'}
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => setDelId(canonicalLocal.id!)}
                  >
                    删除全部 local
                  </Button>
                </div>
              </ProxyPanel>
            ) : null}
            <ProxyManagePanel
              proxies={list}
              bindLimit={bindLimit}
              probeMin={probeMin}
              dnsPrimary={String(cfg.dns_primary || 'auto')}
              dnsDisableSvcbHttps={cfg.dns_disable_svcb_https === true}
              followProxyTimezone={cfg.follow_proxy_timezone !== false}
            />
          </aside>
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
            sortKey={sortKey}
            sortDir={sortDir}
            onSortKey={changeSortKey}
            onSortDir={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
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
      </QueryGate>
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
        title={
          deleting && proxyIsLocal(deleting)
            ? '删除所有节点的 local'
            : '删除代理'
        }
        desc={
          delBound
            ? `删除后${deleting && proxyIsLocal(deleting) ? '所有节点上的' : ''} ${delBound} 台虚拟机将解绑，确认？`
            : deleting && proxyIsLocal(deleting)
              ? '删除所有节点的 local 出口？'
              : '删除这条 SOCKS5？'
        }
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => {
          if (delId) remove.mutate(delId)
        }}
      />
    </PageHeader>
  )
}
