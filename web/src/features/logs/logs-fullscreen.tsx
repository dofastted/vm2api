import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UsageLogFilters } from '@/types/panel-usage-logs'
import { Minimize2 } from 'lucide-react'
import { formatCurrency } from '@/lib/usage-format'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { usageLogsOverviewQueryOptions } from './queries'
import { VirtualizedLogsTable, type OpenDetail } from './virtualized-logs-table'

const MS_FORMAT = new Intl.NumberFormat('zh-CN', {
  style: 'unit',
  unit: 'millisecond',
  unitDisplay: 'narrow',
  maximumFractionDigits: 0,
})

/** <1s 用毫秒，否则 1 位小数秒（hub `formatResponseTime`）。 */
function formatResponseTime(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '-'
  if (ms < 1000) return MS_FORMAT.format(ms)
  return `${(ms / 1000).toFixed(1)}s`
}

function Metric({
  label,
  value,
  last,
}: {
  label: string
  value: string | number
  last?: boolean
}) {
  return (
    <div className={`flex flex-col justify-center ${last ? 'pl-5' : 'px-5'}`}>
      <div className='text-[10px] font-semibold tracking-wider text-muted-foreground uppercase'>
        {label}
      </div>
      <div className='font-mono text-xl leading-none font-bold tabular-nums'>
        {value}
      </div>
    </div>
  )
}

export function LogsFullscreen({
  title,
  filters,
  onOpenDetail,
  onExit,
}: {
  title: string
  filters: UsageLogFilters
  onOpenDetail: OpenDetail
  onExit: () => void
}) {
  const [hideProvider, setHideProvider] = useState(false)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const overview = useQuery(usageLogsOverviewQueryOptions(tz, 3000))
  const data = overview.data

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === 'Escape') onExit()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onExit])

  return (
    <div
      className='fixed inset-0 z-[70] flex flex-col bg-background'
      role='dialog'
      aria-modal='true'
    >
      <div className='flex h-14 items-center justify-between gap-4 border-b bg-background/95 px-6 backdrop-blur supports-[backdrop-filter]:bg-background/70'>
        <div className='min-w-0'>
          <div className='truncate text-base font-semibold tracking-tight'>
            {title}
          </div>
        </div>
        <div className='flex items-center gap-4'>
          <Button
            variant='outline'
            size='sm'
            onClick={onExit}
            className='gap-2'
          >
            <Minimize2 className='h-4 w-4' />
            退出全屏
          </Button>
          <div className='hidden h-full items-stretch divide-x divide-border/50 md:flex'>
            <Metric
              label='活跃 Session 数'
              value={
                overview.isError && !data
                  ? '概览加载失败'
                  : data
                    ? data.activeSessions
                    : '—'
              }
            />
            <Metric
              label='今日请求'
              value={
                overview.isError && !data
                  ? '概览加载失败'
                  : data
                    ? data.todayRequests
                    : '—'
              }
            />
            <Metric
              label='今日消费 · 实际计费'
              value={
                overview.isError && !data
                  ? '概览加载失败'
                  : data
                    ? formatCurrency(data.todayActualCost ?? 0, 2)
                    : '—'
              }
            />
            <Metric
              label='平均响应时间'
              value={formatResponseTime(data?.todayAvgDurationMs ?? null)}
              last
            />
          </div>
        </div>
      </div>

      <div className='group fixed top-20 right-0 z-[80] flex translate-x-[calc(100%-6px)] items-start transition-transform duration-300 focus-within:translate-x-0 hover:translate-x-0'>
        <div className='mt-4 h-16 w-1.5 rounded-l-sm bg-primary/20 group-hover:bg-primary/50' />
        <div className='flex w-72 flex-col gap-3 rounded-l-lg border border-r-0 bg-popover p-4 shadow-xl'>
          <div className='flex items-center justify-between gap-3'>
            <div className='text-sm font-medium'>隐藏虚拟机列</div>
            <Switch
              checked={hideProvider}
              onCheckedChange={setHideProvider}
              aria-label='隐藏虚拟机列'
            />
          </div>
        </div>
      </div>

      <div className='flex-1 p-4'>
        <VirtualizedLogsTable
          filters={filters}
          autoRefreshEnabled
          autoRefreshIntervalMs={3000}
          hideStatusBar
          hideScrollToTop
          hiddenColumns={hideProvider ? ['provider'] : undefined}
          bodyClassName='h-[calc(100dvh_-_56px_-_32px_-_40px)]'
          onOpenDetail={onOpenDetail}
        />
      </div>
    </div>
  )
}
