import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type InfiniteData,
  useInfiniteQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { RequestLogItem, RequestLogsResponse } from '@/types/panel-logs'
import type { Vm } from '@/types/panel-vm'
import { ArrowUp, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useVirtualizedInfiniteList } from '@/hooks/use-virtualized-infinite-list'
import { Button } from '@/components/ui/button'
import { TableSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import {
  LOG_STREAM_BATCH_SIZE,
  logsStreamQueryKey,
  logsStreamQueryOptions,
} from '@/features/logs/queries'
import { LogRow, LogsTableHeader, logRowId } from './logs-table'
import type { LogKindFilter } from './quick-filters-bar'

const ROW_HEIGHT = 52
const POLL_MS = 5000
const HIGHLIGHT_MS = 800

export type LogsStreamFilters = {
  kind: LogKindFilter
  errorClass: string
  muted: string[]
}

function streamFilterQs(filters: LogsStreamFilters): string {
  const qs = new URLSearchParams({ limit: String(LOG_STREAM_BATCH_SIZE) })
  if (filters.kind === 'error') qs.set('status', 'error')
  if (filters.errorClass) qs.set('error_class', filters.errorClass)
  else if (filters.muted.length) {
    qs.set('exclude_error_class', filters.muted.join(','))
  }
  return qs.toString()
}

function flattenPages(
  pages: RequestLogsResponse[] | undefined
): RequestLogItem[] {
  const seen = new Set<string>()
  const out: RequestLogItem[] = []
  for (const page of pages ?? []) {
    for (const row of page.items ?? []) {
      const id = logRowId(row)
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(row)
    }
  }
  return out
}

function keepFirstPage(
  old: InfiniteData<RequestLogsResponse, number> | undefined
): InfiniteData<RequestLogsResponse, number> | undefined {
  if (!old || old.pages.length <= 1) return old
  return {
    pages: old.pages.slice(0, 1),
    pageParams: old.pageParams.slice(0, 1),
  }
}

export function LogsStream({
  filters,
  vms,
  onOpenDetail,
  showIngress,
  pollMs = POLL_MS,
  viewportClassName = 'h-[600px]',
}: {
  filters: LogsStreamFilters
  vms?: Map<string, Vm>
  onOpenDetail: (id: string) => void
  showIngress?: boolean
  /** 轮询间隔；全屏值班模式收紧到 3s。 */
  pollMs?: number
  /** 滚动视口高度；全屏值班模式改为撑满屏幕。 */
  viewportClassName?: string
}) {
  const qc = useQueryClient()
  const filterKey = streamFilterQs(filters)
  const shouldPollRef = useRef(true)
  const queryOptions = logsStreamQueryOptions({
    filterKey,
    errorClass: filters.errorClass,
    pollMs,
    shouldPoll: () => shouldPollRef.current,
  })
  const knownIdsRef = useRef<Set<string> | null>(null)
  const [newIds, setNewIds] = useState<Set<string>>(() => new Set())

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    error,
  } = useInfiniteQuery(queryOptions)

  const allLogs = useMemo(() => flattenPages(data?.pages), [data?.pages])

  const {
    parentRef,
    rowVirtualizer,
    virtualItems,
    showScrollToTop,
    handleScroll,
    scrollToTop,
    resetScrollPosition,
  } = useVirtualizedInfiniteList({
    itemCount: allLogs.length,
    hasNextPage: !!hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    getItemKey: (index) => logRowId(allLogs[index] ?? {}) || `loader-${index}`,
  })

  shouldPollRef.current = !showScrollToTop

  useEffect(() => {
    resetScrollPosition()
    knownIdsRef.current = null
    setNewIds(new Set())
  }, [filterKey, resetScrollPosition])

  useEffect(() => {
    if (showScrollToTop) return
    qc.setQueryData<InfiniteData<RequestLogsResponse, number>>(
      logsStreamQueryKey(filterKey),
      keepFirstPage
    )
  }, [showScrollToTop, qc, filterKey])

  useEffect(() => {
    const ids = allLogs.map(logRowId).filter(Boolean)
    const prev = knownIdsRef.current
    if (!prev) {
      knownIdsRef.current = new Set(ids)
      return
    }
    if (isFetchingNextPage) {
      knownIdsRef.current = new Set(ids)
      return
    }
    const added = ids.filter((id) => !prev.has(id))
    knownIdsRef.current = new Set(ids)
    if (!added.length) return
    setNewIds(new Set(added))
    const timer = window.setTimeout(() => setNewIds(new Set()), HIGHLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [allLogs, isFetchingNextPage])

  return (
    <QueryGate
      loading={isLoading}
      error={error}
      skeleton={
        <div className='overflow-hidden rounded-lg border border-border/60 p-3'>
          <TableSkeleton rows={8} columns={7} />
        </div>
      }
    >
      <div className='relative overflow-hidden rounded-lg border border-border/60'>
        <div className='overflow-x-auto'>
          <div className='min-w-[900px]'>
            <LogsTableHeader showIngress={showIngress} />
            {allLogs.length === 0 ? (
              <div className='flex h-24 items-center justify-center text-sm text-muted-foreground'>
                没有匹配的请求
              </div>
            ) : (
              <div
                ref={parentRef}
                className={cn('overflow-auto', viewportClassName)}
                onScroll={handleScroll}
              >
                <div
                  style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                  }}
                >
                  {virtualItems.map((virtualRow) => {
                    if (virtualRow.index >= allLogs.length) {
                      return (
                        <div
                          key='loader'
                          className='flex items-center justify-center'
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: `${virtualRow.size}px`,
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          <Loader2 className='size-4 animate-spin text-muted-foreground' />
                        </div>
                      )
                    }
                    const row = allLogs[virtualRow.index]
                    const rid = logRowId(row)
                    return (
                      <div
                        key={rid}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <LogRow
                          row={row}
                          vm={
                            row.vm_id ? vms?.get(String(row.vm_id)) : undefined
                          }
                          onOpenDetail={onOpenDetail}
                          showIngress={showIngress}
                          highlighted={newIds.has(rid)}
                          className='border-b border-border/40'
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className='flex items-center justify-between border-t border-border/40 bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground'>
          <span className='tabular-nums'>已加载 {allLogs.length} 条</span>
          {isFetchingNextPage ? (
            <span className='flex items-center gap-1.5'>
              <Loader2 className='size-3 animate-spin' />
              加载更多…
            </span>
          ) : hasNextPage ? (
            <span>下滑加载更多</span>
          ) : allLogs.length ? (
            <span>已到末尾</span>
          ) : null}
        </div>
        {showScrollToTop ? (
          <Button
            variant='outline'
            size='sm'
            className='absolute right-3 bottom-10 z-20 shadow-md'
            onClick={scrollToTop}
          >
            <ArrowUp className='size-4' />
            回到顶部
          </Button>
        ) : null}
        {showScrollToTop ? null : (
          <span className='pointer-events-none absolute top-2 right-3 z-20 flex items-center gap-1.5 text-[11px] text-muted-foreground'>
            <span className='relative flex size-1.5'>
              <span className='absolute inline-flex size-full animate-ping rounded-full bg-primary/70' />
              <span className='relative inline-flex size-1.5 rounded-full bg-primary' />
            </span>
            自动刷新
          </span>
        )}
      </div>
    </QueryGate>
  )
}
