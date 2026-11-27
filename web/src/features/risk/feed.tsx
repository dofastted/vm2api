import type { UsageLogRow } from '@/types/panel-usage-logs'
import { ChevronRight, Inbox } from 'lucide-react'
import { cn } from '@/lib/utils'
import { RelativeTime } from '@/features/logs/relative-time'
import { EmptyNotice } from './blocks'
import { type FeedKind, evidenceOf, feedKindOf } from './model'

const KIND_NAME: Record<FeedKind, string> = {
  distill: '蒸馏',
  'hard-regex': '硬正则',
  refusal: '拒答与封禁',
  jev: 'Jev',
  upstream: '上游拒答',
}

const KIND_BADGE_CLASS: Record<FeedKind, string> = {
  distill: 'bg-select-surface text-select-fg',
  'hard-regex': 'bg-[var(--status-bad-bg)] text-[var(--status-bad)]',
  refusal: 'bg-[var(--status-none-bg)] text-[var(--status-none)]',
  jev: 'bg-[var(--status-warn-bg)] text-[var(--status-warn)]',
  upstream: 'bg-[var(--status-caution-bg)] text-[var(--status-caution)]',
}

function who(row: UsageLogRow) {
  const parts = [row.userName, row.keyName].filter(Boolean)
  return parts.length ? parts.join(' · ') : row.userId || '未标识账号'
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
          <div key={i} className='h-11 animate-pulse rounded-lg bg-muted/60' />
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
    return <EmptyNotice icon={Inbox} message={empty} />
  }
  return (
    <ul className='divide-y divide-[var(--hairline)]'>
      {rows.map((row) => {
        const kind = feedKindOf(row)
        const evidence = row.upstream400Message || evidenceOf(row)
        const hasUpstream4xx =
          row.upstreamStatus != null &&
          [400, 401, 403, 422].includes(row.upstreamStatus)
        const disguised429 =
          row.statusCode === 429 && (kind === 'jev' || kind === 'refusal')
        const showIdentity =
          hasUpstream4xx || !!row.inboundDeviceId || !!row.clientSessionId
        return (
          <li key={row.id}>
            <button
              type='button'
              onClick={() => onOpen(row)}
              className='group grid w-full cursor-pointer grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1.5 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-muted/45 focus-visible:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset md:grid-cols-[4.5rem_auto_minmax(0,1fr)_minmax(0,11rem)_auto]'
            >
              <RelativeTime
                date={row.createdAt}
                className='text-xs text-[var(--text-tertiary)] tabular-nums'
              />
              {showKind ? (
                <span className='flex flex-wrap items-center gap-1'>
                  <span
                    className={cn(
                      'w-fit rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
                      hasUpstream4xx
                        ? 'bg-[var(--status-caution-bg)] text-[var(--status-caution)]'
                        : KIND_BADGE_CLASS[kind]
                    )}
                  >
                    {hasUpstream4xx
                      ? `上游 ${row.upstreamStatus}`
                      : KIND_NAME[kind]}
                  </span>
                  {disguised429 ? (
                    <span className='w-fit rounded-md bg-[var(--status-warn-bg)] px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-[var(--status-warn)]'>
                      429 伪装
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className='hidden md:block' />
              )}
              <span
                className='col-start-2 min-w-0 truncate font-mono text-xs text-foreground md:col-start-auto'
                title={evidence}
              >
                {evidence || '—'}
              </span>
              <span className='col-start-2 min-w-0 truncate text-xs text-muted-foreground md:col-start-auto md:text-right'>
                {who(row)}
                {row.model ? (
                  <span className='text-[var(--text-tertiary)]'>
                    {' '}
                    · {row.model}
                  </span>
                ) : null}
              </span>
              <ChevronRight
                aria-hidden='true'
                className='row-span-2 size-3.5 self-center text-muted-foreground/40 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground'
              />
              {showIdentity ? (
                <dl className='col-start-2 grid gap-x-4 gap-y-0.5 text-[11px] text-[var(--text-tertiary)] sm:grid-cols-2 md:col-span-2 md:col-start-3'>
                  <div className='min-w-0 truncate'>
                    <dt className='inline'>设备：</dt>
                    <dd
                      className='inline font-mono text-muted-foreground'
                      title={row.inboundDeviceId || undefined}
                    >
                      {row.inboundDeviceId || '未提供'}
                    </dd>
                  </div>
                  <div className='min-w-0 truncate'>
                    <dt className='inline'>会话：</dt>
                    <dd
                      className='inline font-mono text-muted-foreground'
                      title={row.clientSessionId || undefined}
                    >
                      {row.clientSessionId || '未提供'}
                    </dd>
                  </div>
                </dl>
              ) : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
