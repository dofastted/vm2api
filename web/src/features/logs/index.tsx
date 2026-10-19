import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { VIEW_DESCRIPTIONS, VIEW_TITLES } from '@/config/nav'
import type { ErrorCollection } from '@/types/panel-logs'
import { ChevronDown, Download, Expand, Filter, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, api, panelFetch } from '@/lib/api'
import {
  ERROR_CLASS_IDS,
  ERROR_CLASS_META,
  resolveMutedClasses,
  writeMutedClasses,
} from '@/lib/log-mute'
import { opsSince } from '@/lib/ops-window'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { meQueryOptions } from '@/features/auth/queries'
import { routingQueryOptions } from '@/features/settings/queries'
import { ActiveSessionsList } from './active-sessions-list'
import {
  readHiddenColumns,
  writeHiddenColumns,
  type LogsTableColumn,
} from './column-visibility'
import { ColumnVisibilityDropdown } from './column-visibility-dropdown'
import { ErrorCollectionPanel } from './error-collection-panel'
import { ExportDialog, type ExportOptions } from './export-dialog'
import { exportQuery } from './export-query'
import { UsageLogsFilters } from './filters/usage-logs-filters'
import {
  LogDetailDialog,
  type DetailState,
} from './log-detail/log-detail-dialog'
import { LogsFullscreen } from './logs-fullscreen'
import {
  LOGS_QUERY_KEY,
  USAGE_LOGS_QUERY_KEY,
  logStatsQueryOptions,
} from './queries'
import {
  activeFilterCount,
  filtersToApi,
  filtersToSearch,
  searchToFilters,
  type LogsFilterState,
} from './search'
import { UsageLogsStatsPanel } from './usage-logs-stats-panel'
import { VirtualizedLogsTable, type OpenDetail } from './virtualized-logs-table'

const route = getRouteApi('/_authenticated/logs')

export function LogsPage() {
  const qc = useQueryClient()
  const navigate = route.useNavigate()
  const search = route.useSearch()
  const me = useQuery(meQueryOptions())
  const role = me.data?.role
  const isAdmin = role === 'admin' || role === 'super'
  const user = me.data?.user ?? ''

  const filters = useMemo(() => searchToFilters(search), [search])
  const errorClass =
    filters.errorClass && ERROR_CLASS_IDS.includes(filters.errorClass)
      ? filters.errorClass
      : ''

  const [isFilterOpen, setIsFilterOpen] = useState(
    () => activeFilterCount(filters) > 0
  )
  const [isAutoRefresh, setIsAutoRefresh] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [detail, setDetail] = useState<DetailState | null>(null)
  const [mutedOverride, setMutedOverride] = useState<string[] | null>(null)
  const [hiddenColumns, setHiddenColumns] = useState<LogsTableColumn[]>([])
  useEffect(() => {
    if (user) setHiddenColumns(readHiddenColumns(user))
  }, [user])

  // 屏蔽集来自 stats 响应而非 `GET /routing`：后者只对 admin 放行。
  const since = opsSince('1h')
  const stats = useQuery(logStatsQueryOptions(since))
  const muted =
    mutedOverride ?? resolveMutedClasses(stats.data?.muted_error_classes)
  const errorCollection = (stats.data?.window?.error_collection ||
    {}) as ErrorCollection

  const apiFilters = useMemo(
    () => filtersToApi(filters, muted),
    [filters, muted]
  )
  const filterCount = activeFilterCount(filters)

  const applyFilters = useCallback(
    (next: LogsFilterState) => {
      void navigate({ search: filtersToSearch(next) })
    },
    [navigate]
  )

  const saveMuted = useMutation({
    mutationFn: (next: string[]) =>
      api('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify({ logging: { muted_error_classes: next } }),
      }),
    onSuccess: () => {
      toast.success('屏蔽设置已保存')
      void qc.invalidateQueries({ queryKey: routingQueryOptions().queryKey })
    },
    onError: (error: Error) => toast.error(error.message || '保存失败'),
  })

  function handleToggleMute(id: string) {
    const willMute = !muted.includes(id)
    const next = willMute ? [...muted, id] : muted.filter((m) => m !== id)
    setMutedOverride(next)
    writeMutedClasses(next)
    // 屏蔽当前正在下钻的类时，钻取会与屏蔽态自相矛盾 —— 退回全部类。
    if (willMute && errorClass === id)
      applyFilters({ ...filters, errorClass: undefined })
    // 非 admin 只存本地，不触发 PUT（后端 ACL 只放行 GET）。
    if (role === 'admin') saveMuted.mutate(next)
    void qc.invalidateQueries({ queryKey: USAGE_LOGS_QUERY_KEY })
    void qc.invalidateQueries({ queryKey: LOGS_QUERY_KEY })
  }

  async function handleRefresh() {
    setIsRefreshing(true)
    await Promise.all([
      qc.invalidateQueries({ queryKey: USAGE_LOGS_QUERY_KEY }),
      qc.invalidateQueries({ queryKey: logStatsQueryOptions(since).queryKey }),
    ])
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false)
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    }
  }, [])

  async function enterFullscreen() {
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

  const openDetail: OpenDetail = useCallback((row, opts) => {
    setDetail({
      row,
      tab: opts?.tab,
      chainIndex: opts?.chainIndex,
      scrollToRedirect: opts?.scrollToRedirect,
    })
  }, [])

  async function handleExport(opts: ExportOptions) {
    try {
      const qs = exportQuery(opts, filters, muted)
      const res = await panelFetch(`/api/panel/request-logs/export?${qs}`)
      if (!res.ok) throw new ApiError('导出失败', res.status)
      // 只有受信 Origin 能读到这三个头；其余跨域场景为 null，下方按缺失处理。
      const count = Number(res.headers.get('x-kin-export-count') ?? NaN)
      const total = Number(res.headers.get('x-kin-export-total') ?? NaN)
      const truncated = res.headers.get('x-kin-export-truncated') === '1'
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `vm2api-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.${opts.format}`
      a.click()
      URL.revokeObjectURL(url)
      if (truncated && Number.isFinite(count) && Number.isFinite(total)) {
        toast.success(
          `已下载 ${count} 条，共匹配 ${total} 条，超过 ${opts.limit} 已截断`
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
    filters.statusCode != null
      ? `状态码 ${filters.statusCode}`
      : filters.excludeStatus200
        ? '仅非 2xx'
        : '全部状态',
    errorClass
      ? `错误类 ${ERROR_CLASS_META[errorClass]?.label || errorClass}`
      : null,
    !errorClass && muted.length ? `不含 ${muted.length} 个已屏蔽类` : null,
    filters.model ? `模型 ${filters.model}` : null,
    filters.sessionId ? `会话 ${filters.sessionId}` : null,
    filters.endpoint ? `端点 ${filters.endpoint}` : null,
    filterCount > 0 ? `共 ${filterCount} 项筛选` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <PageHeader
      title={VIEW_TITLES.logs}
      description={VIEW_DESCRIPTIONS.logs}
      fluid
    >
      <div className='space-y-3'>
        <ActiveSessionsList
          maxHeight='200px'
          onSelectSession={(sessionId) => {
            applyFilters({ ...filters, sessionId })
            setIsFilterOpen(true)
          }}
        />
        <ErrorCollectionPanel
          collection={errorCollection}
          muted={muted}
          activeClass={errorClass}
          onToggleMute={handleToggleMute}
          onSelectClass={(id) =>
            applyFilters({
              ...filters,
              errorClass: id === errorClass ? undefined : id,
            })
          }
        />
        {filterCount > 0 ? <UsageLogsStatsPanel filters={apiFilters} /> : null}
        <Collapsible open={isFilterOpen} onOpenChange={setIsFilterOpen}>
          <div className='flex items-center justify-between gap-3'>
            <CollapsibleTrigger asChild>
              <button
                type='button'
                className='inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border/60 bg-card px-3 py-1.5 text-sm text-muted-foreground transition-colors select-none hover:border-border hover:text-foreground'
              >
                <Filter className='h-3.5 w-3.5' />
                <span>筛选条件</span>
                {filterCount > 0 ? (
                  <Badge
                    variant='secondary'
                    className='h-4.5 min-w-[18px] rounded-full bg-primary/10 px-1 text-[10px] text-primary'
                  >
                    {filterCount}
                  </Badge>
                ) : null}
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 text-muted-foreground/50 transition-transform duration-200',
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
                <Download className='h-3.5 w-3.5' />
                导出
              </Button>
              <ColumnVisibilityDropdown
                hidden={hiddenColumns}
                onChange={(next) => {
                  setHiddenColumns(next)
                  if (user) writeHiddenColumns(user, next)
                }}
              />
              <Button
                variant='ghost'
                size='icon'
                onClick={() => void enterFullscreen()}
                className='h-8 w-8'
                aria-label='全屏显示'
              >
                <Expand className='h-3.5 w-3.5' />
              </Button>
              <Button
                variant='ghost'
                size='icon'
                onClick={() => void handleRefresh()}
                className='h-8 w-8'
                disabled={isFullscreen}
                aria-label='刷新'
              >
                <RefreshCw
                  className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')}
                />
              </Button>
              <div className='ml-1 flex items-center gap-1.5 border-l border-border/40 pl-2'>
                {isAutoRefresh ? (
                  <span className='relative flex h-1.5 w-1.5'>
                    <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75' />
                    <span className='relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500' />
                  </span>
                ) : null}
                <Switch
                  checked={isAutoRefresh}
                  onCheckedChange={setIsAutoRefresh}
                  disabled={isFullscreen}
                  aria-label={isAutoRefresh ? '停止自动刷新' : '开启自动刷新'}
                />
              </div>
            </div>
          </div>
          <CollapsibleContent
            forceMount
            className={cn(!isFilterOpen && 'hidden')}
          >
            <div className='mt-3 rounded-lg border border-border/60 bg-card p-4'>
              <UsageLogsFilters
                isAdmin={isAdmin}
                filters={filters}
                onApply={applyFilters}
                onReset={() => void navigate({ search: {} })}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
        <div className='overflow-hidden rounded-lg border border-border/60'>
          <VirtualizedLogsTable
            filters={apiFilters}
            autoRefreshEnabled={!isFullscreen && isAutoRefresh}
            hiddenColumns={hiddenColumns}
            onOpenDetail={openDetail}
          />
        </div>
      </div>
      <LogDetailDialog state={detail} onClose={() => setDetail(null)} />
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        currentSummary={currentSummary}
        onExport={handleExport}
      />
      {isFullscreen ? (
        <LogsFullscreen
          title={VIEW_TITLES.logs}
          filters={apiFilters}
          onOpenDetail={openDetail}
          onExit={exitFullscreen}
        />
      ) : null}
    </PageHeader>
  )
}
