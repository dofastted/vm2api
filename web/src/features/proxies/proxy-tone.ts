import type { Vm, VmProxySnap } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import {
  PROXY_HEALTH_LABEL,
  type ProxyHealthKey,
  proxyHealthKey,
  proxyIsInvalid,
} from '@/features/proxies/proxy-sort'

/** 高延迟阈值。超过就用警告黄，即使探测状态仍是 ok。 */
export const PROXY_LATENCY_WARN_MS = 300

export type ProxyFieldTone = 'ok' | 'caution' | 'danger' | 'none'

export function proxyLatencyTone(proxy: VmProxySnap): ProxyFieldTone {
  if (proxy.blocked_reason) return 'none'
  if (proxyIsInvalid(proxy)) return 'danger'
  if (proxy.latency_ms != null && proxy.latency_ms > PROXY_LATENCY_WARN_MS) {
    return 'caution'
  }
  if (proxy.status === 'ok') return 'ok'
  return 'none'
}

/** 槽位上的代理底色：有票无代理是 fail closed，不是「直连」。 */
export function vmProxyTone(
  vm: Pick<Vm, 'has_token' | 'proxy' | 'proxy_id'>
): ProxyFieldTone {
  if (!vm.proxy?.host && !vm.proxy_id) {
    return vm.has_token ? 'danger' : 'none'
  }
  return proxyLatencyTone(vm.proxy ?? {})
}

export function proxyFieldClass(tone: ProxyFieldTone): string {
  switch (tone) {
    case 'ok':
      return 'text-ok-3'
    case 'caution':
      return 'text-caution-3'
    case 'danger':
      return 'text-red-3'
    default:
      return 'text-muted-foreground'
  }
}

export function proxySurfaceClass(tone: ProxyFieldTone): string {
  switch (tone) {
    case 'ok':
      return 'bg-ok-1 text-ok-5'
    case 'caution':
      return 'bg-caution-1 text-caution-5'
    case 'danger':
      return 'bg-red-1 text-red-5'
    default:
      return 'text-muted-foreground'
  }
}

/**
 * 健康档 → 图形色（席位格、分段条）。用 solid 变体：非文本图形 3:1 即可。
 * 未测走中性灰，禁用也走灰 —— 它们不是故障，不该占红色。
 */
export const PROXY_HEALTH_SOLID: Record<ProxyHealthKey, string> = {
  ok: 'var(--status-ok-solid)',
  unknown: 'color-mix(in oklch, var(--status-none) 70%, transparent)',
  fail: 'var(--status-warn-solid)',
  dead: 'var(--status-bad-solid)',
  off: 'var(--status-none)',
}

const HEALTH_MARK: Record<ProxyHealthKey, string> = {
  ok: 'ok',
  unknown: 'none',
  fail: 'warn',
  dead: 'bad',
  off: 'off',
}

/** StatusMark 的形状编码：未测是虚线环，禁用是方块，不和故障混成一档。 */
export function proxyStatusTone(proxy: VmProxySnap): StatusTone {
  const key = proxyHealthKey(proxy)
  return {
    key,
    text:
      proxy.blocked_reason === 'ipv6_disabled'
        ? 'IPv6 已关闭'
        : PROXY_HEALTH_LABEL[key],
    cls: HEALTH_MARK[key],
  }
}

/** 延迟信号格数：≤150ms 三格，≤告警阈值两格，更慢一格，失效或未测零格。 */
export function proxySignalBars(proxy: VmProxySnap): number {
  if (proxyIsInvalid(proxy) || proxy.latency_ms == null) return 0
  if (proxy.latency_ms <= 150) return 3
  if (proxy.latency_ms <= PROXY_LATENCY_WARN_MS) return 2
  return 1
}
