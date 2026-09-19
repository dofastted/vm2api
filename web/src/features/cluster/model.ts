import type { Dashboard } from '@/types/panel-overview'
import type { UsagePayload } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import { accountUsable } from '@/lib/vm-status'

/** 与代理页同一条 300ms 线：超过就从「已连接」降到「延迟高」。 */
export const LINK_LATENCY_WARN_MS = 300

export type ClusterLink = 'ok' | 'caution' | 'bad' | 'none'

export type ClusterNode = {
  id: string
  role: 'local' | 'remote'
  label: string
  host: string
  link: ClusterLink
  latencyMs: number | null
  vmCount: number | null
  credCount: number | null
  onlineCredCount: number | null
  spendUsd: number | null
  /** 控制面未接入前的示意行，刷新即丢。 */
  synthetic?: boolean
}

export type ClusterTotals = {
  nodes: number
  reachable: number
  unreachable: number
  vms: number
  creds: number
  online: number
  spend: number
}

export const LINK_TONE: Record<ClusterLink, StatusTone> = {
  ok: { key: 'ok', cls: 'ok', text: '已连接', label: '已连接' },
  caution: { key: 'caution', cls: 'caution', text: '延迟高', label: '延迟高' },
  bad: { key: 'bad', cls: 'bad', text: '不可达', label: '不可达' },
  none: { key: 'none', cls: 'none', text: '未接入', label: '未接入' },
}

export function isLiveLink(link: ClusterLink): boolean {
  return link === 'ok' || link === 'caution'
}

export function formatNodeMetric(
  node: Pick<ClusterNode, 'link'> & { [key: string]: unknown },
  value: number | null,
  format: (n: number) => string
): string {
  if (!isLiveLink(node.link) || value == null || !Number.isFinite(value)) {
    return '—'
  }
  return format(value)
}

export function clusterTotals(nodes: ClusterNode[]): ClusterTotals {
  const live = nodes.filter((node) => isLiveLink(node.link))
  const add = (key: 'vmCount' | 'credCount' | 'onlineCredCount' | 'spendUsd') =>
    live.reduce((sum, node) => sum + (Number(node[key]) || 0), 0)
  return {
    nodes: nodes.length,
    reachable: live.length,
    unreachable: nodes.filter((node) => node.link === 'bad').length,
    vms: add('vmCount'),
    creds: add('credCount'),
    online: add('onlineCredCount'),
    spend: add('spendUsd'),
  }
}

export function localSpendUsd(
  dash: Dashboard | undefined,
  usage: UsagePayload | undefined
): number {
  return Number(
    dash?.billing?.total?.total_cost ??
      usage?.billing?.total?.total_cost ??
      usage?.totals?.total_cost ??
      dash?.summary?.total_cost ??
      0
  )
}

export function buildLocalNode(input: {
  host: string
  vms: Vm[] | undefined
  spendUsd: number
  available: boolean
}): ClusterNode {
  if (!input.available) {
    return {
      id: 'local',
      role: 'local',
      label: '本机',
      host: input.host,
      link: 'none',
      latencyMs: null,
      vmCount: null,
      credCount: null,
      onlineCredCount: null,
      spendUsd: null,
    }
  }
  const vms = input.vms || []
  return {
    id: 'local',
    role: 'local',
    label: '本机',
    host: input.host,
    link: 'ok',
    latencyMs: 0,
    vmCount: vms.length,
    credCount: vms.filter((vm) => vm.has_token).length,
    onlineCredCount: vms.filter((vm) => accountUsable(vm)).length,
    spendUsd: input.spendUsd,
  }
}

/**
 * 只要主机名或 IP，可带端口。拒绝协议、路径、user:pass@host。
 * 集群接入还不存在鉴权通道，输入栏不能变成凭证口。
 */
export function parseNodeHost(raw: string): string | null {
  const host = raw.trim()
  if (!host || host.length > 253) return null
  if (/[\s/@\\]/.test(host)) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) return null
  const HOST_RE =
    /^(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?$/i
  if (!HOST_RE.test(host)) return null
  const port = host.includes(':')
    ? Number(host.slice(host.lastIndexOf(':') + 1))
    : null
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return null
  }
  return host
}
