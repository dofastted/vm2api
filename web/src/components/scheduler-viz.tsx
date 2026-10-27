import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/** 内核固定预开的 native 位，也是席位上限的硬上限。 */
export const SEAT_CAP_MAX = 20

/**
 * 席位格：实心 = 请求进行中，描边浅色 = 重启交接（请求已结束、槽位尚未交还），
 * 空格 = 可开新席位。对话结束后不占格。
 */
export function SeatCells({
  used,
  grace = 0,
  max,
  next = false,
  size = 'md',
  className,
}: {
  used: number
  grace?: number
  max: number
  /** 在第一个空格上画出「下一席」标记。 */
  next?: boolean
  size?: 'sm' | 'md'
  className?: string
}) {
  const cap = Math.max(0, Math.min(SEAT_CAP_MAX, Math.round(Number(max) || 0)))
  const u = Math.max(0, Math.min(cap, Number(used) || 0))
  const g = Math.max(0, Math.min(u, Number(grace) || 0))
  const active = u - g
  const cell = size === 'sm' ? 'size-2' : 'size-2.5'
  return (
    <div
      role='img'
      aria-label={`席位 ${u}/${cap}，其中交接 ${g}`}
      className={cn('flex flex-wrap gap-[3px]', className)}
    >
      {Array.from({ length: cap }, (_, i) => {
        const kind =
          i < active
            ? 'active'
            : i < u
              ? 'grace'
              : i === u && next
                ? 'next'
                : ''
        return (
          <span
            key={i}
            className={cn(
              cell,
              'rounded-[3px] border transition-colors duration-200',
              kind === 'active' && 'border-primary bg-primary',
              kind === 'grace' && 'border-primary/70 bg-primary/25',
              kind === 'next' &&
                'border-dashed border-[color:var(--status-ok-solid)] bg-[color:var(--status-ok-bg)]',
              kind === '' && 'border-border bg-muted/60'
            )}
          />
        )
      })}
    </div>
  )
}

export function SeatLegend({ className }: { className?: string }) {
  const item = (swatch: string, text: string) => (
    <span className='inline-flex items-center gap-1'>
      <span className={cn('size-2.5 rounded-[3px] border', swatch)} />
      {text}
    </span>
  )
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground',
        className
      )}
    >
      {item('border-primary bg-primary', '进行中')}
      {item('border-primary/70 bg-primary/25', '交接')}
      {item('border-border bg-muted/60', '空闲')}
    </div>
  )
}

export type GateDot = { id: string; label: string; value: number }

function dotTone(value: number, gate: number) {
  if (value >= gate) return 'bg-[color:var(--status-bad-solid)]'
  if (value >= gate - 10) return 'bg-[color:var(--status-warn-solid)]'
  return 'bg-[color:var(--status-ok-solid)]'
}

/**
 * 用量轴 0–100%：闸线右侧是受限区（斜纹），`used` 画实际用量，
 * `dots` 把一批 VM 的当前用量撒在同一根轴上。
 */
export function GateBar({
  gate,
  used,
  dots,
  enabled = true,
  className,
}: {
  /** 闸线百分比（0–100）。 */
  gate: number
  used?: number | null
  dots?: GateDot[]
  /** 阻断关闭时闸线只做参考，受限区不着色。 */
  enabled?: boolean
  className?: string
}) {
  const g = Math.max(0, Math.min(100, gate))
  const u = used == null ? null : Math.max(0, Math.min(100, Number(used) || 0))
  return (
    <div className={cn('relative pt-4', className)}>
      <div className='relative h-2.5 overflow-hidden rounded-full bg-muted'>
        <div
          aria-hidden
          className={cn(
            'absolute inset-y-0 right-0',
            enabled
              ? 'bg-[repeating-linear-gradient(135deg,var(--status-bad-bg)_0_4px,transparent_4px_8px)]'
              : 'bg-[repeating-linear-gradient(135deg,var(--status-none-bg)_0_4px,transparent_4px_8px)]'
          )}
          style={{ left: `${g}%` }}
        />
        {u != null ? (
          <div
            aria-hidden
            className={cn(
              'absolute inset-y-0 left-0 rounded-full transition-[width] duration-300',
              enabled && u >= g
                ? 'bg-[color:var(--status-bad-solid)]'
                : enabled && u >= g - 10
                  ? 'bg-[color:var(--status-warn-solid)]'
                  : 'bg-primary'
            )}
            style={{ width: `${u}%` }}
          />
        ) : null}
      </div>
      <div
        aria-hidden
        className='absolute top-3 bottom-[-3px] w-0.5 -translate-x-1/2 rounded-full bg-foreground transition-[left] duration-200'
        style={{ left: `${g}%` }}
      />
      <span
        className={cn(
          'absolute top-0 text-[10px] leading-3 font-medium whitespace-nowrap tabular-nums',
          g > 80 ? '-translate-x-full pr-1' : 'pl-1',
          enabled ? 'text-foreground' : 'text-muted-foreground'
        )}
        style={{ left: `${g}%` }}
      >
        闸 {Math.round(g)}%
      </span>
      {dots?.map((dot) => {
        const v = Math.max(0, Math.min(100, dot.value))
        return (
          <Tooltip key={dot.id}>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                aria-label={`${dot.label} ${v.toFixed(0)}%`}
                className={cn(
                  'absolute top-[19px] size-2 -translate-x-1/2 cursor-default rounded-full ring-2 ring-background outline-none focus-visible:ring-ring',
                  dotTone(v, enabled ? g : 101)
                )}
                style={{ left: `${v}%` }}
              />
            </TooltipTrigger>
            <TooltipContent>
              {dot.label} · {v.toFixed(0)}%
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
