import { useQuery } from '@tanstack/react-query'
import type { ActiveSession } from '@/types/panel-usage-logs'
import {
  Activity,
  CheckCircle,
  Clock,
  Cpu,
  Key,
  Loader2,
  User,
  XCircle,
} from 'lucide-react'
import { formatCurrency, formatTokenAmount } from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { activeSessionsQueryOptions } from './queries'

/** 会话时长：首末次请求完成的间隔（hub 的 `Xm Ys` 口径）。 */
function formatSpan(ms: number): string {
  if (!(ms > 0)) return '-'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

function SessionListItem({
  session,
  onSelect,
}: {
  session: ActiveSession
  onSelect: (sessionId: string) => void
}) {
  const failed = session.lastStatus != null && session.lastStatus >= 400
  const StatusIcon = failed ? XCircle : CheckCircle
  const provider = session.vmName || session.providerName
  return (
    <button
      type='button'
      onClick={() => onSelect(session.sessionId)}
      title={`Session ${session.sessionId}\n点击按此 Session 筛选日志`}
      className='group block w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-muted/50'
    >
      <div className='flex items-center gap-2 text-sm'>
        <StatusIcon
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0',
            failed ? 'text-red-500' : 'text-green-500'
          )}
        />
        <div className='flex min-w-0 items-center gap-1.5'>
          <User className='h-3 w-3 flex-shrink-0 text-muted-foreground' />
          <span
            className='max-w-[100px] truncate font-medium'
            title={session.userName ?? undefined}
          >
            {session.userName || '未知'}
          </span>
        </div>
        <div className='flex min-w-0 items-center gap-1'>
          <Key className='h-3 w-3 flex-shrink-0 text-muted-foreground' />
          <span
            className='max-w-[80px] truncate font-mono text-xs text-muted-foreground'
            title={session.keyName ?? undefined}
          >
            {session.keyName || '-'}
          </span>
        </div>
        <div className='flex min-w-0 items-center gap-1'>
          <Cpu className='h-3 w-3 flex-shrink-0 text-muted-foreground' />
          <span
            className='max-w-[120px] truncate font-mono text-xs'
            title={`${session.model ?? '-'} @ ${provider ?? '-'}`}
          >
            {session.model || '-'}
            {provider ? (
              <span className='text-muted-foreground'> @ {provider}</span>
            ) : null}
          </span>
        </div>
        <div className='ml-auto flex flex-shrink-0 items-center gap-1'>
          <Clock className='h-3 w-3 text-muted-foreground' />
          <span className='font-mono text-xs text-muted-foreground'>
            {formatSpan(
              Date.parse(session.lastAt) - Date.parse(session.firstAt)
            )}
          </span>
        </div>
        <div className='flex flex-shrink-0 items-center gap-2 font-mono text-xs'>
          <span className='text-muted-foreground'>
            {session.requests} 次 · {formatTokenAmount(session.totalTokens)}
          </span>
          {session.totalCost > 0 ? (
            <span className='font-medium'>
              {formatCurrency(session.totalCost, 4)}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  )
}

/**
 * 近 5 分钟有请求的会话（hub `ActiveSessionsList`）。vm2api 请求完成才落库，
 * 没有「进行中」态，所以状态图标只区分末次成功 / 失败；点击改为按会话筛选日志。
 */
export function ActiveSessionsList({
  maxHeight = '200px',
  onSelectSession,
}: {
  maxHeight?: string
  onSelectSession: (sessionId: string) => void
}) {
  const { data, isLoading } = useQuery(activeSessionsQueryOptions())
  const sessions = data?.sessions ?? []
  return (
    <div className='rounded-lg border bg-card'>
      <div className='flex items-center justify-between border-b px-4 py-3'>
        <div className='flex items-center gap-2'>
          <Activity className='h-4 w-4 text-primary' />
          <h3 className='text-sm font-semibold'>活跃 Session</h3>
          <span className='text-xs text-muted-foreground'>
            {data?.total ?? 0} 个 Session，{data?.minutes ?? 5} 分钟内
          </span>
        </div>
      </div>
      <div style={{ maxHeight }} className='overflow-y-auto'>
        {isLoading && !sessions.length ? (
          <div
            className='flex items-center justify-center text-sm text-muted-foreground'
            style={{ height: maxHeight }}
          >
            <Loader2 className='mr-2 h-4 w-4 animate-spin' />
            加载中...
          </div>
        ) : !sessions.length ? (
          <div
            className='flex items-center justify-center text-sm text-muted-foreground'
            style={{ height: maxHeight }}
          >
            暂无活跃 Session
          </div>
        ) : (
          <div className='divide-y'>
            {sessions.map((session) => (
              <SessionListItem
                key={session.sessionId}
                session={session}
                onSelect={onSelectSession}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
