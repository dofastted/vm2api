import { useMutation, useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Globe } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  localProxyOptsFromProxy,
  proxyHostLabel,
  proxyNamedLabel,
} from '@/lib/vm-status'
import { meQueryOptions } from '@/features/auth/queries'
import { proxyIsLocal } from '@/features/proxies/proxy-sort'
import { proxySurfaceClass, vmProxyTone } from '@/features/proxies/proxy-tone'
import { useRefreshProxies } from '@/features/proxies/queries'
import { useLocalProxyLabelOpts } from '@/features/proxies/use-vps-ip'

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
  const fallback = useLocalProxyLabelOpts(vm.node_id)
  const opts = localProxyOptsFromProxy(vm.proxy, fallback)
  const host = proxyHostLabel(vm.proxy, opts)
  const tone = vmProxyTone(vm)
  const blocked = vm.proxy?.blocked_reason === 'ipv6_disabled'
  const nodeLocal = !!(vm.proxy && proxyIsLocal(vm.proxy) && vm.node_id)
  const lat = blocked || nodeLocal ? null : vm.proxy?.latency_ms
  const bound = host !== '—'
  const named = proxyNamedLabel(vm.proxy, opts)
  const me = useQuery(meQueryOptions())
  const refresh = useRefreshProxies()
  // 点击芯片 = 探测这个槽位自己的出口：SOCKS5 走代理，local 走它所在 VPS 那条本地代理
  // （集群槽经节点本机出网），返回真实的出口 IP 与地理。接口只对 admin 开放；
  // 未绑定或被策略封禁的槽位没有可测的出口。
  const canProbe =
    !vm.gemini &&
    me.data?.role === 'admin' &&
    bound &&
    !vm.proxy?.blocked_reason
  const probe = useMutation({
    onMutate: () => toast.loading('正在探测出口…'),
    mutationFn: () =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}/exit-probe`, {
        method: 'POST',
      }) as Promise<{
        // api() 已拆掉 { ok, data } 外壳。
        geo?: { ip?: string; country?: string; city?: string; isp?: string }
      }>,
    onSuccess: (res, _vars, toastId) => {
      const geo = res?.geo || {}
      const where = [geo.country, geo.city].filter(Boolean).join(' · ')
      toast.success(
        `出口 ${geo.ip || '未知'}${where ? ` · ${where}` : ''}${geo.isp ? ` · ${geo.isp}` : ''}`,
        { id: toastId }
      )
      // 本地代理的结果写回那台 VPS 的代理行，代理池页同步刷新。
      void refresh()
    },
    onError: (error: Error, _vars, toastId) =>
      toast.error(error.message, { id: toastId }),
  })
  const runProbe = () => {
    if (canProbe && !probe.isPending) probe.mutate()
  }
  const label = bound
    ? vm.proxy?.label?.trim() || host
    : tone === 'danger'
      ? '缺代理'
      : '直连'
  const title = blocked
    ? `${named} · IPv6 已关闭（设置 → SOCKS5 开启）`
    : nodeLocal
      ? `${named} · 出口为该节点本机`
      : lat != null && bound
        ? `${named} · ${lat}ms`
        : bound
          ? named
          : label

  if (vm.gemini) {
    return (
      <span
        className={cn(
          'inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground',
          className
        )}
        title={`绑定的 SOCKS5 代理 · ${vm.gemini.proxy_id}`}
      >
        <Globe className='size-3 shrink-0' aria-hidden />
        <span className='truncate'>{vm.gemini.proxy_id}</span>
      </span>
    )
  }

  return (
    <div
      role={canProbe ? 'button' : undefined}
      tabIndex={canProbe ? 0 : undefined}
      aria-busy={probe.isPending || undefined}
      onClick={
        canProbe
          ? (e) => {
              e.stopPropagation()
              runProbe()
            }
          : undefined
      }
      onKeyDown={
        canProbe
          ? (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              e.stopPropagation()
              runProbe()
            }
          : undefined
      }
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5',
        canProbe && 'cursor-pointer',
        probe.isPending && 'opacity-60',
        proxySurfaceClass(tone),
        !bound &&
          tone === 'none' &&
          'border border-dashed border-border/80 bg-transparent',
        className
      )}
      title={canProbe ? `${title} · 点击探测出口` : title}
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
          {compact && !blocked && vm.proxy && proxyIsLocal(vm.proxy) ? (
            // local 出口只有一条共用记录：必须写明是哪台 VPS 的本机出口。
            <span className='truncate text-[11px]'>{host}</span>
          ) : null}
          {lat != null ? (
            <span className='field-metric shrink-0 text-[11px] tabular-nums'>
              {latencyDigits(lat)}
            </span>
          ) : compact && !blocked && !(vm.proxy && proxyIsLocal(vm.proxy)) ? (
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
