import type { UsageLogRow } from '@/types/panel-usage-logs'
import { cn } from '@/lib/utils'
import { RelativeTime } from '@/features/logs/relative-time'
import { type FeedKind, evidenceOf, feedKindOf } from './model'

const KIND_NAME: Record<FeedKind, string> = {
  distill: '蒸馏',
  'hard-regex': '硬正则',
  refusal: '拒答缓存',
  jev: '决策模型',
  upstream: '上游拒答',
}

function who(row: UsageLogRow) {
  const parts = [row.userName, row.keyName].filter(Boolean)
  return parts.length ? parts.join(' · ') : row.clientIp || '匿名'
}

/** One line per request; the whole row opens the request detail. */
export function RiskFeed({
  rows,
  loading,
  error,
  empty,
  showKind,
  onOpen,
}: {
  rows: UsageLogRow[]
  loading: boolean
  error: Error | null
  empty: string
  showKind: boolean
  onOpen: (row: UsageLogRow) => void
}) {
  if (loading) {
    return (
      <div className='space-y-2 p-4' aria-busy='true'>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className='h-10 animate-pulse rounded-md bg-muted' />
        ))}
      </div>
    )
  }
  if (error) {
    return (
      <p className='px-4 py-6 text-sm text-destructive' role='alert'>
        {error.message}
      </p>
    )
  }
  if (!rows.length) {
    return <p className='px-4 py-8 text-sm text-muted-foreground'>{empty}</p>
  }
  return (
    <ul className='divide-y'>
      {rows.map((row) => {
        const kind = feedKindOf(row)
        const evidence = evidenceOf(row)
        return (
          <li key={row.id}>
            <button
              type='button'
              onClick={() => onOpen(row)}
              className='grid w-full cursor-pointer grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none md:grid-cols-[4.5rem_auto_minmax(0,1fr)_minmax(0,11rem)]'
            >
              <RelativeTime
                date={row.createdAt}
                className='text-xs text-muted-foreground tabular-nums'
              />
              {showKind ? (
                <span
                  className={cn(
                    'w-fit rounded-md px-1.5 py-0.5 text-xs whitespace-nowrap',
                    kind === 'upstream'
                      ? 'bg-[var(--status-caution-bg)] text-[var(--status-caution)]'
                      : 'bg-muted text-foreground'
                  )}
                >
                  {KIND_NAME[kind]}
                </span>
              ) : (
                <span className='hidden md:block' />
              )}
              <span
                className='col-start-2 min-w-0 truncate font-mono text-xs md:col-start-auto'
                title={kind === 'jev' && row.jevState ? row.jevState : evidence}
              >
                <span className='block truncate'>{evidence || '—'}</span>
                {kind === 'jev' && row.jevState ? (
                  <span className='block truncate font-sans text-[11px] text-muted-foreground'>
                    审查内容：{row.jevState}
                  </span>
                ) : null}
              </span>
              <span className='col-start-2 min-w-0 truncate text-xs text-muted-foreground md:col-start-auto md:text-right'>
                {who(row)}
                {row.model ? (
                  <span className='text-muted-foreground/80'>
                    {' '}
                    · {row.model}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
