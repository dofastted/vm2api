import type { VmProxySnap } from './panel-vm'

export type ProxyPoolPayload = {
  proxies?: VmProxySnap[]
  /** 每台 VPS 的 local 出口；真实代理 ID 仍为 px-local。 */
  local_exits?: VmProxySnap[]
  totals?: Record<string, unknown>
  config?: Record<string, unknown>
  error?: string
}
