import { PREFLIGHT_RULES } from './model'
import type { GateRow } from './queries'

const REFUSAL_KEYWORDS: Record<string, string> = {
  exact: '精确指纹',
  similar: '近似正文',
  device: '封禁 device',
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
    return <p className='px-4 py-8 text-sm text-muted-foreground'>{empty}</p>
  }
  const top = Math.max(...rows.map((row) => row.count))
  return (
    <ul className='divide-y'>
      {rows.map((row) => (
        <li
          key={`${row.by}:${row.keyword}:${row.rule}`}
          className='relative isolate flex items-center gap-3 px-4 py-2.5'
        >
          <span
            aria-hidden='true'
            className='absolute inset-y-1 left-0 -z-10 rounded-r-md bg-muted'
            style={{ width: `${Math.max(2, (row.count / top) * 100)}%` }}
          />
          <div className='min-w-0 flex-1'>
            <p className='truncate text-sm'>
              {showSource ? (
                <span className='mr-2 text-xs text-muted-foreground'>
                  {row.by === 'jev'
                    ? 'Jev'
                    : PREFLIGHT_RULES.find((rule) => rule.id === row.by)
                        ?.name || row.label}
                </span>
              ) : null}
              <span className='font-mono text-xs'>
                {(row.by === 'refusal' && REFUSAL_KEYWORDS[row.keyword]) ||
                  row.keyword ||
                  '—'}
              </span>
            </p>
            {row.rule ? (
              <p
                className='truncate font-mono text-xs text-muted-foreground'
                title={row.rule}
              >
                {row.rule}
              </p>
            ) : null}
          </div>
          <span className='shrink-0 text-sm font-medium tabular-nums'>
            {row.count.toLocaleString()}
          </span>
          {action ? action(row) : null}
        </li>
      ))}
    </ul>
  )
}
