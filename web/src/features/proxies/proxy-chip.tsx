import type { Vm } from '@/types/panel-vm'
import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { proxyHostLabel, proxyNamedLabel } from '@/lib/vm-status'
import { proxyStatusLabel } from '@/features/proxies/proxy-sort'
import { proxySurfaceClass, vmProxyTone } from '@/features/proxies/proxy-tone'
import { useVpsIp } from '@/features/proxies/use-vps-ip'

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
  // 本地代理 IP 只取对应节点出口的实际探测结果。
  const vpsIp = useVpsIp(vm.node_id, vm.proxy ? [vm.proxy] : [])
  const host = proxyHostLabel(vm.proxy, vpsIp)
  const tone = vmProxyTone(vm)
  const blocked = !!vm.proxy?.blocked_reason
  const blockedLabel = blocked ? proxyStatusLabel(vm.proxy!) : ''
  const lat = blocked ? null : vm.proxy?.latency_ms
  const bound = host !== '—'
  // 芯片窄，起了名就只显示名称；完整的「名称 · 地址」放进 title。
  const named = proxyNamedLabel(vm.proxy, vpsIp)
  const label = bound
    ? vm.proxy?.label?.trim() || host
    : tone === 'danger'
      ? '缺代理'
      : '直连'
  const title = blocked
    ? `${named} · ${blockedLabel}${vm.proxy?.blocked_reason === 'ipv6_disabled' ? '（设置 → SOCKS5 开启）' : '（已有绑定保留）'}`
    : lat != null && bound
      ? `${named} · ${lat}ms`
      : bound
        ? named
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
              {blockedLabel}
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
