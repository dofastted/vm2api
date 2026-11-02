import type { ClusterApiNode, ClusterLocalStatus } from '@/types/panel-cluster'
import type { HostStats } from '@/types/panel-overview'
import { fmtBytes } from '@/lib/format'
import { LINK_STATE_TEXT } from '@/features/cluster/model'

/** 连接详情一行：`tone` 有值时前面画状态点，`hint` 是灰色小字。 */
export type DetailRow = {
  label: string
  value: string
  tone?: 'ok' | 'caution' | 'bad'
  hint?: string
}

function ago(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000))
  if (min < 60) return `${min} 分钟`
  const hr = Math.floor(min / 60)
  if (hr < 48) return `${hr} 小时`
  return `${Math.floor(hr / 24)} 天`
}

/** `09:19 连上，已 10 小时`（浏览器本地时间）。 */
export function connectedText(
  iso: string | null | undefined,
  now = Date.now()
): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  const hm = new Date(t).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return `${hm} 连上，已 ${ago(now - t)}`
}

function ipv4Prefix24(ip: string): string | null {
  const m = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/)
  return m ? m[1] : null
}

/** 本机和节点同一个 /24 的地址 = 连节点用的内网口。 */
export function internalAddresses(
  localIps: string[],
  nodes: ClusterApiNode[]
): string[] {
  const nodeNets = new Set(
    nodes.map((n) => ipv4Prefix24(n.host)).filter(Boolean)
  )
  return localIps.filter((ip) => {
    const net = ipv4Prefix24(ip)
    return !!net && nodeNets.has(net) && !nodes.some((n) => n.host === ip)
  })
}

function controlText(c: ClusterLocalStatus['control']): string {
  const listen = `监听 ${c.listen_host ?? '—'}:${c.listen_port ?? '—'}`
  if (c.mode === 'process') return `本机进程 · 宿主网络 · ${listen}`
  const net = c.network_mode || '未知网络'
  const kind =
    net === 'host' ? 'host 网络' : net === 'bridge' ? 'bridge（NAT）' : net
  return `容器 ${c.container || ''} · ${kind} · ${listen}`
}

function inboundRow(s: ClusterLocalStatus): DetailRow {
  const { nat, control } = s
  const ip = nat.public_ip || '—'
  const via = nat.observed_via
    ? `由 ${nat.observed_via.label} 回连测得`
    : nat.note
  const natHint =
    nat.behind_nat === true
      ? '在 NAT 后：只影响别人连进来，不影响接入节点'
      : undefined
  const hint = [via, natHint].filter(Boolean).join('；') || undefined
  switch (nat.inbound) {
    case 'closed':
      return {
        label: '公网',
        value: `${ip} · 外网连不进 ${control.listen_port}（正常）`,
        tone: 'ok',
        hint,
      }
    case 'loopback':
      return {
        label: '公网',
        value: `${ip} · 面板只监听本机（正常）`,
        tone: 'ok',
        hint,
      }
    case 'open':
      return {
        label: '公网',
        value: `${ip} · 外网能直接连 ${control.listen_port}`,
        tone: 'caution',
        hint: `建议只监听内网或加防火墙${hint ? `；${hint}` : ''}`,
      }
    default:
      return { label: '公网', value: ip, hint }
  }
}

export function localDetailRows(input: {
  status: ClusterLocalStatus
  host: HostStats | undefined
  nodes: ClusterApiNode[]
}): DetailRow[] {
  const { status, host, nodes } = input
  const { docker, kvm } = status
  const rows: DetailRow[] = [
    { label: '控制面', value: controlText(status.control) },
    inboundRow(status),
  ]
  const internal = internalAddresses(status.nat.local_ips || [], nodes)
  if (internal.length) {
    rows.push({ label: '内网', value: `${internal.join('、')}（连集群节点）` })
  }
  rows.push(
    docker.ok
      ? {
          label: 'Docker',
          value: `${docker.version ?? '—'} · ${docker.containers ?? '—'} 个容器，${docker.running ?? '—'} 个在跑，其中槽 ${docker.slots ?? '—'} 个`,
          tone: 'ok',
        }
      : {
          label: 'Docker',
          value: '不可用',
          tone: 'bad',
          hint: docker.error || undefined,
        }
  )
  if (kvm) {
    rows.push(
      kvm.ok && kvm.accel === 'kvm'
        ? { label: 'KVM', value: '可用（硬件加速）', tone: 'ok' }
        : kvm.ok
          ? { label: 'KVM', value: '只有软件模拟（很慢）', tone: 'caution' }
          : {
              label: 'KVM',
              value: '不可用',
              tone: 'bad',
              hint: kvm.error || undefined,
            }
    )
  }
  if (host?.rss) {
    const up = Number(host.proc_uptime) || 0
    rows.push({
      label: '控制面进程',
      value: `内存 ${fmtBytes(host.rss)} · 已运行 ${ago(up * 1000)}`,
    })
  }
  const ready = nodes.filter((n) => n.link.state === 'ready').length
  if (nodes.length) {
    rows.push({
      label: '集群出站',
      value: `${ready} / ${nodes.length} 个节点已连上`,
      tone: ready === nodes.length ? 'ok' : 'caution',
    })
  }
  return rows
}

/** 折叠时那一行摘要。 */
export function localDetailSummary(status: ClusterLocalStatus): string {
  const parts: string[] = []
  const net = status.control.network_mode
  parts.push(
    status.control.mode === 'process'
      ? '控制面本机进程'
      : `控制面 ${net === 'host' ? 'host 网络' : net || '容器'}`
  )
  if (status.nat.inbound === 'closed' || status.nat.inbound === 'loopback') {
    parts.push('外网连不进')
  } else if (status.nat.inbound === 'open') parts.push('外网能直接连')
  parts.push(status.docker.ok ? 'Docker 正常' : 'Docker 不可用')
  if (status.kvm)
    parts.push(
      status.kvm.ok && status.kvm.accel === 'kvm' ? 'KVM 可用' : 'KVM 不可用'
    )
  return parts.join(' · ')
}

export function remoteDetailRows(
  node: ClusterApiNode,
  now = Date.now()
): DetailRow[] {
  const ready = node.link.state === 'ready'
  const rows: DetailRow[] = [
    ready
      ? {
          label: 'SSH',
          value: `${node.username}@${node.host}:${node.port} · ${connectedText(node.link.connected_at, now) || '已连接'}`,
          tone: 'ok',
        }
      : {
          label: 'SSH',
          value: `${node.username}@${node.host}:${node.port} · ${LINK_STATE_TEXT[node.link.state]}`,
          tone:
            node.link.state === 'backoff' || node.link.state === 'error'
              ? 'bad'
              : undefined,
          hint: node.link.error
            ? `${node.link.error.code} · ${node.link.error.message}`
            : undefined,
        },
  ]
  const dl = node.direct_link
  if (!dl) {
    rows.push({ label: '直连通道', value: '未启用（槽的流量走 SSH）' })
  } else {
    const where = `${dl.address}:${dl.port}`
    rows.push(
      dl.state === 'ok'
        ? {
            label: '直连通道',
            value: `${where} · 正常${dl.latency_ms != null ? ` ${dl.latency_ms}ms` : ''}`,
            tone: 'ok',
            hint: '槽的流量走这条；断了自动退回 SSH',
          }
        : dl.state === 'down'
          ? {
              label: '直连通道',
              value: `${where} · 断了，槽的流量暂时走 SSH`,
              tone: 'caution',
              hint:
                [dl.error, dl.gate_error].filter(Boolean).join('；') ||
                undefined,
            }
          : { label: '直连通道', value: `${where} · 等待检查` }
    )
  }
  const health = node.health
  if (node.platform === 'darwin') {
    rows.push({
      label: '运行方式',
      value: 'macOS 原生（槽是 launchd 服务，不用 Docker）',
    })
  } else if (health) {
    const c = health.containers
    rows.push(
      health.docker.ok
        ? {
            label: 'Docker',
            value:
              c && c.total != null
                ? `${c.total} 个容器，${c.running ?? '—'} 个在跑`
                : '可用',
            tone: 'ok',
          }
        : {
            label: 'Docker',
            value: '不可用',
            tone: 'bad',
            hint: health.docker.error || undefined,
          }
    )
  }
  const h = health?.host
  if (ready && h) {
    rows.push({
      label: '宿主',
      value: `${h.cpu_count} 核 · load ${[h.load1, h.load5, h.load15].map((n) => (n == null ? '—' : n.toFixed(2))).join(' / ')}`,
    })
  }
  rows.push({
    label: '主机指纹',
    value: `${node.host_key_alg} ${node.host_key_sha256}`,
  })
  return rows
}

export function remoteDetailSummary(node: ClusterApiNode): string {
  if (node.link.state !== 'ready')
    return `SSH ${LINK_STATE_TEXT[node.link.state]}`
  const parts = ['SSH 正常']
  const dl = node.direct_link
  if (dl)
    parts.push(
      dl.state === 'ok'
        ? '直连正常'
        : dl.state === 'down'
          ? '直连断了'
          : '直连待检查'
    )
  const c = node.health?.containers
  if (node.platform !== 'darwin' && c?.total != null) {
    parts.push(
      c.running === c.total
        ? `${c.total} 个容器全在跑`
        : `${c.running ?? '—'} / ${c.total} 个容器在跑`
    )
  }
  return parts.join(' · ')
}
