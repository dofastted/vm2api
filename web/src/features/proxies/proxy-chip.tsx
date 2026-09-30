import type { Vm } from '@/types/panel-vm'
import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { proxyHostLabel } from '@/lib/vm-status'
import { proxySurfaceClass, vmProxyTone } from '@/features/proxies/proxy-tone'

function latencyDigits(ms: number): string {
  const n = Math.round(ms)
  if (n > 999) return '999+'
  return String(n)
}

export function ProxyChip({
  vm,
  className,
  compact = false,
}: {
  vm: Vm
  className?: string
  compact?: boolean
}) {
  const host = proxyHostLabel(vm.proxy)
  const tone = vmProxyTone(vm)
  const blocked = vm.proxy?.blocked_reason === 'ipv6_disabled'
  const lat = blocked ? null : vm.proxy?.latency_ms
  const bound = host !== '—'
  const label = bound ? host : tone === 'danger' ? '缺代理' : '直连'
  const title = blocked
    ? `${host} · IPv6 已关闭（设置 → SOCKS5 开启）`
    : lat != null && bound
      ? `${host} · ${lat}ms`
      : label

  return (
    <div
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5',
        proxySurfaceClass(tone),
        !bound &&
          tone === 'none' &&
          'border border-dashed border-border/80 bg-transparent',
        className
      )}
      title={title}
    >
      {bound ? (
        <>
          <Globe className='size-3 shrink-0' aria-hidden />
          {compact ? null : (
            <span className='field-host truncate text-xs'>{host}</span>
          )}
          {blocked ? (
            <span className='shrink-0 text-[11px] text-muted-foreground'>
              IPv6 已关闭
            </span>
          ) : null}
          {lat != null ? (
            <span className='field-metric shrink-0 text-[11px] tabular-nums'>
              {latencyDigits(lat)}
            </span>
          ) : compact && !blocked ? (
            <span className='text-[11px]'>{tone === 'ok' ? '通' : '未测'}</span>
          ) : null}
        </>
      ) : (
        <span className='text-[11px]'>
          {compact ? (tone === 'danger' ? '缺' : '直') : label}
        </span>
      )}
    </div>
  )
}
