import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Activity, AlertCircle, Circle, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { BentoCard } from './bento'
import { activeSessionsQueryOptions } from './queries'
import { sessionDisplay } from './stats-format'

const PING_COLOR: Record<string, string> = {
  FAIL: 'bg-rose-500',
  LIVE: 'bg-emerald-500',
}

const NAME_COLOR: Record<string, string> = {
  FAIL: 'text-rose-500 dark:text-rose-400',
  LIVE: 'text-blue-500 dark:text-blue-400',
  IDLE: 'text-muted-foreground',
}

/** 终端风格的近 5 分钟活跃会话（hub LiveSessionsPanel）。点一行跳到按该会话过滤的日志。 */
export function LiveSessionsPanel({ className }: { className?: string }) {
  const navigate = useNavigate()
  const query = useQuery(activeSessionsQueryOptions(5, 12))
  const sessions = query.data?.sessions ?? []
  const total = query.data?.total ?? sessions.length
  const now = query.dataUpdatedAt || Date.now()

  return (
    <BentoCard
      className={cn(
        'flex flex-col overflow-hidden p-0 md:p-0',
        'bg-slate-50 dark:bg-[#0a0a0c]',
        'border-slate-200 dark:border-white/[0.06]',
        className
      )}
    >
      <div
        className='pointer-events-none absolute inset-0 z-10 opacity-0 dark:opacity-[0.03]'
        style={{
          background:
            'linear-gradient(to bottom, rgba(255,255,255,0), rgba(255,255,255,0) 50%, rgba(0,0,0,0.1) 50%, rgba(0,0,0,0.1))',
          backgroundSize: '100% 4px',
        }}
      />

      <div className='flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-100/50 p-3 dark:border-white/[0.06] dark:bg-white/[0.02]'>
        <div className='min-w-0'>
          <div className='flex items-center gap-2'>
            <Activity className='h-3.5 w-3.5 text-slate-500 dark:text-muted-foreground' />
            <span className='font-mono text-xs font-medium tracking-wider text-slate-700 uppercase dark:text-foreground/80'>
              活跃 Session
            </span>
          </div>
          {query.data ? (
            <p className='mt-1 font-mono text-xs font-medium text-primary'>
              近 5 分钟 · 共 {total} 个
              {total > sessions.length ? ` · 显示 ${sessions.length} 个` : ''}
            </p>
          ) : null}
        </div>
        <div className='flex shrink-0 gap-1.5'>
          <div className='h-2 w-2 rounded-full bg-rose-400/30 dark:bg-rose-500/20' />
          <div className='h-2 w-2 rounded-full bg-amber-400/30 dark:bg-amber-500/20' />
          <div className='h-2 w-2 rounded-full bg-emerald-400/30 dark:bg-emerald-500/20' />
        </div>
      </div>

      <div className='flex-1 space-y-0.5 overflow-y-auto p-2 font-mono text-xs'>
        {query.isLoading ? (
          <div className='flex h-full items-center justify-center text-muted-foreground'>
            <div className='flex items-center gap-2'>
              <div className='h-2 w-2 animate-pulse rounded-full bg-primary' />
              <span>加载中...</span>
            </div>
          </div>
        ) : query.error && !query.data ? (
          <div className='flex h-full items-center justify-center text-destructive'>
            加载失败
          </div>
        ) : sessions.length === 0 ? (
          <div className='flex h-full flex-col items-center justify-center gap-2 text-muted-foreground'>
            <AlertCircle className='h-5 w-5 opacity-50' />
            <span className='text-xs'>暂无活跃 Session</span>
          </div>
        ) : (
          <TooltipProvider delayDuration={300}>
            {sessions.map((session) => {
              const status = sessionDisplay(session, now)
              const StatusIcon = status.label === 'FAIL' ? XCircle : Circle
              return (
                <button
                  key={session.sessionId}
                  type='button'
                  title={session.sessionId}
                  onClick={() =>
                    navigate({
                      to: '/logs',
                      search: { sessionId: session.sessionId },
                    })
                  }
                  className='group flex w-full cursor-pointer items-center gap-3 rounded-md p-2 text-left transition-colors hover:bg-muted/50 dark:hover:bg-white/5'
                >
                  <div className='relative flex-shrink-0'>
                    {status.pulse ? (
                      <span
                        className={cn(
                          'absolute inset-0 animate-ping rounded-full opacity-75',
                          PING_COLOR[status.label]
                        )}
                        style={{ animationDuration: '1.5s' }}
                      />
                    ) : null}
                    <StatusIcon
                      className={cn('relative h-2.5 w-2.5', status.color)}
                      fill='currentColor'
                    />
                  </div>
                  <span className='text-xs text-muted-foreground'>
                    #{session.sessionId.slice(-6)}
                  </span>
                  <span
                    className={cn(
                      'truncate text-xs font-medium',
                      NAME_COLOR[status.label]
                    )}
                  >
                    {session.userName || session.keyName || '未知'}
                  </span>
                  <span className='mx-1 flex-1 border-b border-dashed border-border/50 dark:border-white/10' />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          'cursor-help text-xs font-bold tracking-wide',
                          status.color,
                          status.label === 'IDLE' && 'font-normal'
                        )}
                      >
                        {status.label}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side='left' className='max-w-[200px]'>
                      <p className='text-xs'>{status.tooltip}</p>
                    </TooltipContent>
                  </Tooltip>
                </button>
              )
            })}
          </TooltipProvider>
        )}
      </div>

      {sessions.length > 0 ? (
        <button
          type='button'
          onClick={() => navigate({ to: '/logs' })}
          className='flex cursor-pointer items-center justify-center gap-1 border-t border-slate-200 bg-slate-100/50 p-2 text-xs text-slate-600 transition-colors hover:text-slate-900 dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-muted-foreground dark:hover:text-foreground'
        >
          <span>查看请求日志</span>
        </button>
      ) : null}
    </BentoCard>
  )
}
