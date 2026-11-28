import { ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmptyNotice } from './blocks'
import { PREFLIGHT_RULES, share } from './model'
import type { GateRow } from './queries'

const REFUSAL_KEYWORDS: Record<string, string> = {
  exact: '精确指纹',
  similar: '近似正文',
  device: '封禁设备',
  session: '封禁会话',
}

const SOURCE_STYLE: Record<string, { bar: string; pill: string }> = {
  jev: {
    bar: 'bg-[var(--status-warn-bg)]',
    pill: 'bg-[var(--status-warn-bg)] text-[var(--status-warn)]',
  },
  'hard-regex': {
    bar: 'bg-[var(--status-bad-bg)]',
    pill: 'bg-[var(--status-bad-bg)] text-[var(--status-bad)]',
  },
  distill: {
    bar: 'bg-select-surface',
    pill: 'bg-select-surface text-select-fg',
  },
  refusal: {
    bar: 'bg-[var(--status-caution-bg)]',
    pill: 'bg-[var(--status-caution-bg)] text-[var(--status-caution)]',
  },
}

/**
 * Today's verdicts grouped by the word and rule that fired. The bar is the
 * row's share of this table, so a rule that fires far more than its peers
 * (the usual false-positive signature) stands out before reading numbers.
 */
export function HitTable({
  rows,
  empty,
  showSource,
  action,
}: {
  rows: GateRow[]
  empty: string
  showSource: boolean
  action?: (row: GateRow) => React.ReactNode
}) {
  if (!rows.length) {
    return <EmptyNotice icon={ShieldCheck} message={empty} />
  }
  const top = Math.max(...rows.map((row) => row.count))
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  return (
    <ul className='divide-y divide-[var(--hairline)]'>
      {rows.map((row) => {
        const tone = SOURCE_STYLE[row.by]
        return (
          <li
            key={`${row.by}:${row.keyword}:${row.rule}`}
            className='relative isolate flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-muted/35'
          >
            <span
              aria-hidden='true'
              className={cn(
                'absolute inset-y-1 left-0 -z-10 rounded-r-md opacity-70',
                tone?.bar || 'bg-[var(--track)]'
              )}
              style={{ width: `${Math.max(2, (row.count / top) * 100)}%` }}
            />
            <div className='min-w-0 flex-1'>
              <p className='flex flex-wrap items-center gap-1.5 text-sm'>
                {showSource ? (
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
                      tone?.pill || 'bg-muted text-muted-foreground'
                    )}
                  >
                    {row.by === 'jev'
                      ? 'Jev'
                      : PREFLIGHT_RULES.find((rule) => rule.id === row.by)
                          ?.name || row.label}
                  </span>
                ) : null}
                <span className='truncate font-mono text-xs'>
                  {(row.by === 'refusal' && REFUSAL_KEYWORDS[row.keyword]) ||
                    row.keyword ||
                    '—'}
                </span>
              </p>
              {row.rule ? (
                <p
                  className='mt-0.5 truncate font-mono text-xs text-muted-foreground'
                  title={row.rule}
                >
                  {row.rule}
                </p>
              ) : null}
            </div>
            <div className='shrink-0 text-right tabular-nums'>
              <span className='block text-sm font-semibold'>
                {row.count.toLocaleString()}
              </span>
              <span className='block text-[11px] text-[var(--text-tertiary)]'>
                {share(row.count, total)}
              </span>
            </div>
            {action ? action(row) : null}
          </li>
        )
      })}
    </ul>
  )
}
