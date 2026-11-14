import { cn } from '@/lib/utils'
import type { ProxyScheme } from './proxy-scheme'

const OPTIONS: { value: ProxyScheme; label: string }[] = [
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'http', label: 'HTTP' },
]

/** 代理协议切换：SOCKS5 / HTTP 分段按钮。 */
export function ProxySchemeToggle({
  value,
  onChange,
  disabled,
  className,
  label = '代理协议',
}: {
  value: ProxyScheme
  onChange: (value: ProxyScheme) => void
  disabled?: boolean
  className?: string
  label?: string
}) {
  return (
    <div
      role='group'
      aria-label={label}
      className={cn(
        'inline-grid grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1',
        className
      )}
    >
      {OPTIONS.map((opt) => {
        const on = opt.value === value
        return (
          <button
            key={opt.value}
            type='button'
            aria-pressed={on}
            disabled={disabled}
            onClick={() => !on && onChange(opt.value)}
            className={cn(
              'h-7 rounded-md px-3 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
              on
                ? 'bg-background font-semibold text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
