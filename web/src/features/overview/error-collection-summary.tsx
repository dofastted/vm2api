import { Link } from '@tanstack/react-router'
import type { ErrorCollection } from '@/types/panel-logs'
import { fmtNum } from '@/lib/format'
import { resolveMutedClasses } from '@/lib/log-mute'
import { ERROR_CLASS_TONE } from '@/lib/log-tone'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { PanelCard } from '@/features/overview/panel-card'

function toneStyle(id: string): React.CSSProperties {
  const tone = ERROR_CLASS_TONE[id] || 'bad'
  return {
    color: `var(--status-${tone})`,
    backgroundColor: `var(--status-${tone}-bg)`,
    borderColor: `var(--status-${tone})`,
  }
}

/**
 * 错误集合摘要。对齐 index.html 的 `renderErrorCollection(ops, {inLogs:false})`：
 * 分类 chip 跳到日志页并带上 `error_class`（对齐 index.html `openLogErrors`）。
 */
export function ErrorCollectionSummary({
  collection,
  serverMuted,
}: {
  collection: ErrorCollection | undefined
  serverMuted?: string[]
}) {
  const bag = collection ?? null
  const classes = bag?.by_class || []
  const muted = new Set(resolveMutedClasses(serverMuted))
  const visible = classes.filter((c) => !muted.has(c.id))
  const hidden = classes.filter((c) => muted.has(c.id))
  const visibleTotal = visible.reduce((n, c) => n + (Number(c.count) || 0), 0)
  const mutedTotal = hidden.reduce((n, c) => n + (Number(c.count) || 0), 0)

  return (
    <PanelCard
      title='错误集合'
      meta={
        <span className='tabular-nums'>
          {visibleTotal ? fmtNum(visibleTotal) : null}
          {mutedTotal ? ` · 已屏蔽 ${fmtNum(mutedTotal)} 条` : null}
        </span>
      }
      action={
        <Button variant='outline' size='sm' asChild>
          <Link to='/logs' search={{ kind: 'error' }}>
            查看错误日志
          </Link>
        </Button>
      }
    >
      <div className='px-4 py-3'>
        {bag == null ? (
          <EmptyState reason='错误统计暂不可用' />
        ) : !visible.length && !hidden.length ? (
          <EmptyState reason='该窗口无错误' />
        ) : (
          <div className='flex flex-wrap gap-2'>
            {visible.length ? (
              visible.map((c) => (
                <Link
                  key={c.id}
                  to='/logs'
                  search={{ error_class: c.id, kind: 'error' }}
                  className='inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs transition-opacity hover:opacity-80'
                  style={toneStyle(c.id)}
                  title={`只看${c.label}`}
                >
                  <b className='font-semibold'>{c.label}</b>
                  <span className='tabular-nums'>{fmtNum(c.count)}</span>
                  <em className='text-[10px] not-italic opacity-70'>
                    {c.owner === 'provider'
                      ? '上游'
                      : c.owner === 'client'
                        ? '客户端'
                        : '平台'}
                  </em>
                </Link>
              ))
            ) : (
              <span className='text-xs text-muted-foreground'>
                本摘要中的错误均来自已屏蔽的错误类
              </span>
            )}
          </div>
        )}
      </div>
    </PanelCard>
  )
}
