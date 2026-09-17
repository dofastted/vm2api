import { useCallback, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { ErrorCollection, RequestLogItem } from '@/types/panel-logs'
import { ChevronDown, Download, Expand, Filter, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, api, panelFetch } from '@/lib/api'
import {
  ERROR_CLASS_IDS,
  ERROR_CLASS_META,
  hasApproximateCount,
  resolveMutedClasses,
  writeMutedClasses,
} from '@/lib/log-mute'
import { opsSince } from '@/lib/ops-window'
import { cn } from '@/lib/utils'
import { useVmIndex } from '@/hooks/use-vm-index'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { TableSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import {
  LOGS_QUERY_KEY,
  logStatsQueryOptions,
  logsQueryOptions,
  requestLogQueryOptions,
} from '@/features/logs/queries'
import { routingQueryOptions } from '@/features/settings/queries'
import { ErrorCollectionPanel } from './error-collection-panel'
import {
  ExportDialog,
  type ExportOptions,
  type ExportWindow,
} from './export-dialog'
import { LogDetailSheet } from './log-detail-sheet'
import { LogPager } from './log-pager'
import { LogsFullscreen } from './logs-fullscreen'
import { LogsStream } from './logs-stream'
import { LogsTable } from './logs-table'
import {
  QuickFiltersBar,
  type LogKindFilter,
  type LogModeFilter,
} from './quick-filters-bar'

const ERROR_CLASSES = ['', ...ERROR_CLASS_IDS]

export function LogsPage() {
  const qc = useQueryClient()
  const me = useQuery(meQueryOptions())
  const { vms } = useVmIndex()
  const navigate = useNavigate()
  const search = useRouterState({
    select: (s) => {
      const raw = s.location.search as {
        error_class?: unknown
        kind?: unknown
      }
      return {
        error_class: typeof raw.error_class === 'string' ? raw.error_class : '',
        kind: raw.kind === 'error' ? 'error' : '',
      }
    },
  })
  const rawClass = search.error_class
  const errorClass = ERROR_CLASS_IDS.includes(rawClass) ? rawClass : ''
  const kind: LogKindFilter = search.kind === 'error' ? 'error' : 'all'
  const [mode, setMode] = useState<LogModeFilter>('normal')
  const [openId, setOpenId] = useState('')
  const [isFilterOpen, setIsFilterOpen] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [exportOpen, setExportOpen] = useState(false)
  const [mutedOverride, setMutedOverride] = useState<string[] | null>(null)
  const [viewMode, setViewMode] = useState<'stream' | 'pager'>('stream')
  const [isFullscreen, setIsFullscreen] = useState(false)

  // 切筛选/模式后旧页码可能越界，回到第一页。
  useEffect(() => {
    setPage(1)
  }, [kind, errorClass, mode, pageSize])

  const isDebug = mode === 'debug'
  const usePager = isDebug || viewMode === 'pager'
  const since = opsSince('1h')
  const stats = useQuery(logStatsQueryOptions(since))
  // 服务端屏蔽列表读 stats 响应，**不读 `GET /routing`** ——
  // panel-acl 只给 admin 放行 routing（非 admin 会吃 403），
  // 而 request-logs/stats 对 user 角色也开放，同样带这个字段。
  const serverMuted = stats.data?.muted_error_classes
  const muted = mutedOverride ?? resolveMutedClasses(serverMuted)
  const qs = new URLSearchParams({ limit: String(pageSize) })
  // debug 模式后端不读 offset，也不返回 total —— 不分页。
  if (!isDebug && page > 1) qs.set('offset', String((page - 1) * pageSize))
  if (kind === 'error') qs.set('status', 'error')
  if (errorClass) qs.set('error_class', errorClass)
  // 传了 error_class 时后端会丢弃 exclude（分支 1），不必也不该同时发。
  else if (muted.length) qs.set('exclude_error_class', muted.join(','))
  if (isDebug) qs.set('mode', 'debug')
  const logs = useQuery(logsQueryOptions(qs.toString(), usePager))
  const detail = useQuery(requestLogQueryOptions(openId, !!openId))
  const items = logs.data?.items || []
  const total = Number(logs.data?.total ?? 0)
  const window_ = stats.data?.window
  const errorCollection = (window_?.error_collection || {}) as ErrorCollection
  const isAdmin = me.data?.role === 'admin'
  const activeFilterCount =
    (kind === 'error' ? 1 : 0) +
    (errorClass ? 1 : 0) +
    (mode === 'debug' ? 1 : 0)

  const saveMuted = useMutation({
    mutationFn: (next: string[]) =>
      api('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify({ logging: { muted_error_classes: next } }),
      }),
    onSuccess: () => {
      toast.success('屏蔽设置已保存')
      qc.invalidateQueries({ queryKey: routingQueryOptions().queryKey })
    },
    onError: (error: Error) => toast.error(error.message || '保存失败'),
  })

  function setErrorClass(next: string) {
    void navigate({
      to: '/logs',
      replace: true,
      search: {
        ...(next ? { error_class: next } : {}),
        ...(kind === 'error' ? { kind: 'error' } : {}),
      },
    })
  }

  function setKind(next: LogKindFilter) {
    void navigate({
      to: '/logs',
      replace: true,
      search: {
        ...(errorClass ? { error_class: errorClass } : {}),
        ...(next === 'error' ? { kind: 'error' } : {}),
      },
    })
  }

  function handleToggleMute(id: string) {
    const next = muted.includes(id)
      ? muted.filter((m) => m !== id)
      : [...muted, id]
    setMutedOverride(next)
    writeMutedClasses(next)
    // 屏蔽当前正在下钻的类时，drill-down 会与屏蔽态自相矛盾 —— 退回全部类。
    if (!muted.includes(id) && errorClass === id) setErrorClass('')
    setPage(1)
    // 非 admin 只存本地，不触发 PUT（后端 ACL 只放行 GET）。
    if (isAdmin) saveMuted.mutate(next)
    // 走前缀键：屏蔽集变了以后每一种分页/筛选组合的缓存都过时了。
    qc.invalidateQueries({ queryKey: LOGS_QUERY_KEY })
    qc.invalidateQueries({ queryKey: logStatsQueryOptions(since).queryKey })
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await Promise.all([
      qc.invalidateQueries({ queryKey: LOGS_QUERY_KEY }),
      qc.invalidateQueries({ queryKey: logStatsQueryOptions(since).queryKey }),
    ])
    setTimeout(() => setIsRefreshing(false), 400)
  }

  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false)
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    }
  }, [])

  const enterFullscreen = async () => {
    setIsFullscreen(true)
    // 原生全屏被拒绝也没关系：覆盖层照样铺满视口。
    try {
      await document.documentElement.requestFullscreen()
    } catch {
      /* noop */
    }
  }

  // 浏览器 ESC 退出原生全屏时同步收掉覆盖层。
  useEffect(() => {
    if (!isFullscreen) return
    const onChange = () => {
      if (!document.fullscreenElement) setIsFullscreen(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [isFullscreen])

  /** 导出窗口起点。`opsSince` 只认 1h/6h/24h，7d 在这里补。 */
  function exportSince(window: ExportWindow): string | null {
    if (!window) return null
    if (window === '7d') {
      const t = Date.now() - 7 * 86400_000
      return new Date(t - (t % 60_000)).toISOString()
    }
    return opsSince(window)
  }

  async function handleExport(opts: ExportOptions) {
    try {
      const exportQs = new URLSearchParams({
        format: opts.format,
        limit: String(opts.limit),
      })
      // 后端 `_mutedExclude` 分支序：error_class > include_muted > exclude > 服务端默认。
      // 「全部日志」必须带 include_muted=1，否则服务端默认屏蔽仍会吃掉数据。
      if (opts.scope === 'all') {
        exportQs.set('include_muted', '1')
      } else {
        const cls = opts.scope === 'errors' ? opts.errorClass : errorClass
        if (opts.scope === 'errors' || kind === 'error')
          exportQs.set('status', 'error')
        if (cls) exportQs.set('error_class', cls)
        else if (opts.includeMuted) exportQs.set('include_muted', '1')
        else if (muted.length)
          exportQs.set('exclude_error_class', muted.join(','))
      }
      const since = exportSince(opts.window)
      if (since) exportQs.set('since', since)
      const res = await panelFetch(
        `/api/panel/request-logs/export?${exportQs.toString()}`
      )
      if (!res.ok) throw new ApiError('导出失败', res.status)
      // 三个头未列入 Access-Control-Expose-Headers，跨域代理下会是 null。
      const count = Number(res.headers.get('x-kin-export-count') ?? NaN)
      const exportTotal = Number(res.headers.get('x-kin-export-total') ?? NaN)
      const truncated = res.headers.get('x-kin-export-truncated') === '1'
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `vm2api-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.${opts.format}`
      a.click()
      URL.revokeObjectURL(url)
      if (truncated && Number.isFinite(count) && Number.isFinite(exportTotal)) {
        toast.success(
          `已下载 ${count} 条，共匹配 ${exportTotal} 条，超过 ${opts.limit} 已截断`
        )
      } else if (Number.isFinite(count)) {
        toast.success(`已下载 ${count} 条`)
      } else {
        toast.success('已下载')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
      throw error
    }
  }

  const currentSummary = [
    kind === 'error' ? '仅错误' : '全部种类',
    errorClass
      ? `错误类 ${ERROR_CLASS_META[errorClass]?.label || errorClass}`
      : null,
    !errorClass && muted.length ? `不含 ${muted.length} 个已屏蔽类` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <PageHeader title={VIEW_TITLES.logs} fluid>
      <div className='mb-3'>
        <ErrorCollectionPanel
          collection={errorCollection}
          muted={muted}
          activeClass={errorClass}
          onToggleMute={handleToggleMute}
          onSelectClass={(id) => setErrorClass(id === errorClass ? '' : id)}
        />
      </div>
      <Collapsible
        open={isFilterOpen}
        onOpenChange={setIsFilterOpen}
        className='mb-3'
      >
        <div className='flex flex-wrap items-center justify-between gap-x-3 gap-y-2'>
          <CollapsibleTrigger asChild>
            <button
              type='button'
              className='inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border/60 bg-card px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors select-none hover:border-border hover:text-foreground'
            >
              <Filter className='size-3.5' />
              <span>筛选</span>
              {activeFilterCount > 0 ? (
                <Badge
                  variant='secondary'
                  className='h-4.5 min-w-[18px] rounded-full bg-primary/10 px-1 text-[10px] text-primary'
                >
                  {activeFilterCount}
                </Badge>
              ) : null}
              <ChevronDown
                className={cn(
                  'size-3.5 text-muted-foreground/50 transition-transform duration-200',
                  isFilterOpen && 'rotate-180'
                )}
              />
            </button>
          </CollapsibleTrigger>
          <div className='flex items-center gap-1'>
            <Button
              variant='outline'
              size='sm'
              className='h-8 gap-1.5 text-xs'
              onClick={() => setExportOpen(true)}
            >
              <Download className='size-3.5' />
              导出
            </Button>
            <Button
              variant='ghost'
              size='icon'
              onClick={handleRefresh}
              className='size-8'
              aria-label='刷新'
            >
              <RefreshCw
                className={cn('size-3.5', isRefreshing && 'animate-spin')}
              />
            </Button>
            {isDebug ? null : (
              <Button
                variant='ghost'
                size='icon'
                onClick={() => void enterFullscreen()}
                className='size-8'
                aria-label='全屏实时日志'
              >
                <Expand className='size-3.5' />
              </Button>
            )}
            {isDebug ? null : (
              <div className='ml-1 flex items-center gap-1.5 border-l border-border/40 pl-2'>
                <Switch
                  checked={viewMode === 'stream'}
                  onCheckedChange={(on) => setViewMode(on ? 'stream' : 'pager')}
                  aria-label='流式自动刷新'
                />
                <span className='text-xs text-muted-foreground'>
                  {viewMode === 'stream' ? '流式' : '分页'}
                </span>
              </div>
            )}
          </div>
        </div>
        <CollapsibleContent
          forceMount
          className={cn(!isFilterOpen && 'hidden')}
        >
          <div className='mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-card p-4'>
            <QuickFiltersBar
              kind={kind}
              onKindChange={setKind}
              mode={mode}
              onModeChange={setMode}
            />
            <Select
              value={errorClass || 'none'}
              onValueChange={(v) => setErrorClass(v === 'none' ? '' : v)}
            >
              <SelectTrigger className='w-40'>
                <SelectValue placeholder='错误类' />
              </SelectTrigger>
              <SelectContent>
                {ERROR_CLASSES.map((c) => (
                  <SelectItem key={c || 'none'} value={c || 'none'}>
                    {c ? `${ERROR_CLASS_META[c].label}（${c}）` : '全部类'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CollapsibleContent>
      </Collapsible>
      {usePager ? (
        <QueryGate
          loading={logs.isLoading}
          error={logs.error}
          skeleton={
            <div className='overflow-hidden rounded-lg border border-border/60 p-3'>
              <TableSkeleton rows={8} columns={7} />
            </div>
          }
        >
          <div className='overflow-hidden rounded-lg border border-border/60'>
            <LogsTable
              items={items}
              vms={vms}
              onOpenDetail={setOpenId}
              showIngress={errorClass === 'auth'}
            />
            {isDebug ? null : (
              <div className='border-t border-border/60 bg-muted/20'>
                <LogPager
                  page={page}
                  pageSize={pageSize}
                  total={total}
                  shown={items.length}
                  approximate={errorClass ? true : hasApproximateCount(muted)}
                  onPageChange={setPage}
                  onPageSizeChange={setPageSize}
                />
              </div>
            )}
          </div>
        </QueryGate>
      ) : (
        <LogsStream
          filters={{ kind, errorClass, muted }}
          vms={vms}
          onOpenDetail={setOpenId}
          showIngress={errorClass === 'auth'}
        />
      )}
      <LogDetailSheet
        open={!!openId}
        requestId={openId}
        item={detail.data?.item as RequestLogItem | undefined}
        attempts={detail.data?.attempts || []}
        vms={vms}
        loading={detail.isLoading}
        error={detail.error}
        onOpenChange={(open) => {
          if (!open) setOpenId('')
        }}
      />
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        currentSummary={currentSummary}
        onExport={handleExport}
      />
      {isFullscreen ? (
        <LogsFullscreen
          filters={{ kind, errorClass, muted }}
          vms={vms}
          showIngress={errorClass === 'auth'}
          onOpenDetail={setOpenId}
          onExit={exitFullscreen}
        />
      ) : null}
    </PageHeader>
  )
}
