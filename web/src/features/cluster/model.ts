import type {
  ClusterApiNode,
  ClusterLocalStatus,
  NodeHostStats,
} from '@/types/panel-cluster'
import type { HostStats } from '@/types/panel-overview'
import type { Vm } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import { claudeTier, isRestrictedSchedule, poolStatus } from '@/lib/vm-status'

/**
 * 链路只在真慢时才黄。量的是一次往返（SSH 开通道 / 直连握手），跨洋节点本来就
 * 三四百毫秒，不应只因一次正常的跨洋 RTT 标为异常。
 */
export const LINK_SLOW_MS = 800

const MiB = 1024 ** 2
export const GiB = 1024 ** 3
/**
 * KVM 槽在虚拟机内存之外实际多用的（qemu 进程本身）。容器上限给了 512M（`vm-runtime.mjs` 的
 * KVM_MEMORY_OVERHEAD_MIB），但那只是上限。这里按观测到的典型开销估算为 150M；
 * 「还能放」仅是容量估算，并非资源预留或创建保证。
 */
export const KVM_OVERHEAD_BYTES = 150 * MiB
/** 「还能放」按一台 2G 的 KVM 槽算。 */
export const NEW_SLOT_MEMORY_BYTES = 2 * GiB
export const NEW_SLOT_QUOTA_BYTES = NEW_SLOT_MEMORY_BYTES + KVM_OVERHEAD_BYTES

/** 通用的本机名称；部署地址单独展示。 */
export const LOCAL_MACHINE_NAME = '本机 VPS'

export type ClusterLink = 'ok' | 'caution' | 'bad' | 'none'

export const LINK_TONE: Record<ClusterLink, StatusTone> = {
  ok: { key: 'ok', cls: 'ok', text: '正常', label: '正常' },
  caution: { key: 'caution', cls: 'caution', text: '很慢', label: '很慢' },
  bad: { key: 'bad', cls: 'bad', text: '连不上', label: '连不上' },
  none: { key: 'none', cls: 'none', text: '未接入', label: '未接入' },
}

export const LINK_STATE_TEXT: Record<ClusterApiNode['link']['state'], string> =
  {
    idle: '未启动',
    connecting: '连接中',
    ready: '已连接',
    backoff: '重连等待',
    error: '已停止',
  }

export function isLiveLink(link: ClusterLink): boolean {
  return link === 'ok' || link === 'caution'
}

/** 节点标签末尾的 IP 去掉（IP 另有一栏 / 悬停提示）。 */
export function shortNodeLabel(label: string): string {
  const short = label.replace(/\s*\d{1,3}(?:\.\d{1,3}){3}$/, '').trim()
  return short || label
}

/** 两段往返：直连通道（槽的流量走它）和 SSH（管理、Docker、退路）。没连上时都为 null。 */
export function nodeLatencies(node: ClusterApiNode): {
  direct: number | null
  ssh: number | null
} {
  if (node.link.state !== 'ready') return { direct: null, ssh: null }
  const dl = node.direct_link
  return {
    direct: dl?.state === 'ok' ? (dl.latency_ms ?? null) : null,
    ssh: node.health?.latency_ms ?? null,
  }
}

/**
 * 链路轴：没连上 → 连不上 / 未接入；连上了看直连有没有退回 SSH，再看慢不慢。
 * 不再拿单次 SSH 往返和 300ms 比——跨洋节点会一直黄。
 */
export function remoteLink(node: ClusterApiNode): ClusterLink {
  const state = node.link.state
  if (state === 'backoff' || state === 'error') return 'bad'
  if (state !== 'ready') return 'none'
  if (node.direct_link?.state === 'down') return 'caution'
  const { direct, ssh } = nodeLatencies(node)
  const worst = Math.max(direct ?? 0, ssh ?? 0)
  return worst > LINK_SLOW_MS ? 'caution' : 'ok'
}

/** 状态一句话：和 remoteLink 同轴，只是把「为什么黄 / 红」说出来。 */
export function remoteLinkTone(node: ClusterApiNode): StatusTone {
  const link = remoteLink(node)
  const state = node.link.state
  let text = LINK_TONE[link].text
  if (state === 'backoff') text = '连不上，重连中'
  else if (state === 'error') text = '连不上'
  else if (state !== 'ready') text = LINK_STATE_TEXT[state] || state
  else if (node.direct_link?.state === 'down') text = '直连断了，走 SSH'
  return { ...LINK_TONE[link], text, label: text }
}

/** 第二行小字：`直连 21ms · SSH 4ms`；没连上时给错误原因。 */
export function linkLatencyText(node: ClusterApiNode): string {
  if (node.link.state !== 'ready') {
    return node.link.error?.message || LINK_STATE_TEXT[node.link.state] || '—'
  }
  const { direct, ssh } = nodeLatencies(node)
  const parts: string[] = []
  const dl = node.direct_link
  if (dl) {
    if (dl.state === 'ok')
      parts.push(direct != null ? `直连 ${direct}ms` : '直连')
    else if (dl.state === 'down') parts.push('直连断开')
    else parts.push('直连待检查')
  }
  parts.push(ssh != null ? `SSH ${ssh}ms` : 'SSH')
  return parts.join(' · ')
}

/** 直连通道状态一句话；连接详情与节点面板共用。 */
export function directLinkText(link: ClusterApiNode['direct_link']): string {
  if (!link) return '未启用'
  if (link.state === 'pending') return '等待检查'
  if (link.state === 'ok') {
    return `直连中${link.latency_ms != null ? ` · ${link.latency_ms}ms` : ''}`
  }
  return `已退回 SSH${link.error ? `（${link.error}）` : ''}`
}

/** `2g` / `512m` / `1024` (MiB) → 字节；读不懂为 null。 */
export function memoryBytes(raw: unknown): number | null {
  const m = String(raw ?? '')
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*([gm])?b?$/)
  if (!m) return null
  const n = Number(m[1])
  return m[2] === 'g' ? n * GiB : n * MiB
}

/** 槽用满时在这台机器上占的内存：KVM 是虚拟机内存 + 实测 qemu 开销，Docker 槽就是它的内存上限。 */
export function slotQuotaBytes(vm: Vm): number {
  const mem = memoryBytes(vm.machine?.memory) ?? 512 * MiB
  return mem + (vm.runtime_type === 'kvm' ? KVM_OVERHEAD_BYTES : 0)
}

export type MachineCapacity = {
  total: number
  /** 此刻实际已用（不含可回收缓存）。 */
  used: number
  /** 槽都用满时占的内存合计。 */
  quota: number
  /** 槽以外的占用（系统、控制面、数据库…）= 实际已用 − 槽此刻实际用的；读不到为 null。 */
  reserve: number | null
  /** 槽都用满后还空着的内存；reserve 读不到为 null。 */
  free: number | null
  /** 还能放几台 2G KVM 槽。 */
  fit: number | null
}

/**
 * 按槽用满时算余量，不按此刻用量：虚拟机会慢慢把分到的内存用满。
 * 每台按虚拟机内存 + 实测 qemu 开销，不按容器上限。`slotsActual` 是槽此刻实际占的内存，
 * 只用来把「系统占用」从总用量里剥出来。
 */
export function machineCapacity(input: {
  total: number
  used: number
  slotsActual: number | null | undefined
  quota: number
}): MachineCapacity {
  const { total, used, quota } = input
  const reserve =
    input.slotsActual == null ? null : Math.max(0, used - input.slotsActual)
  const free = reserve == null ? null : Math.max(0, total - reserve - quota)
  return {
    total,
    used,
    quota,
    reserve,
    free,
    fit: free == null ? null : Math.floor(free / NEW_SLOT_QUOTA_BYTES),
  }
}

export type SlotBucket = 'on' | 'restricted' | 'stopped'

/** 受限 = 调度三态里的 restricted；停 = 调度关 / 不可调度 / 凭证坏；其余在接单。 */
export function slotBucket(vm: Vm): SlotBucket {
  if (isRestrictedSchedule(vm)) return 'restricted'
  const cls = poolStatus(vm).cls
  if (cls === 'off' || cls === 'bad' || cls === 'none') return 'stopped'
  return 'on'
}

/** 槽表的状态：沿用虚拟机页的判定，只把「可用 / 在池」说成「接单中」、受限带上前缀。 */
export function slotStatusTone(vm: Vm): StatusTone {
  const tone = poolStatus(vm)
  if (isRestrictedSchedule(vm)) {
    const text = `受限 · ${tone.text}`
    return { ...tone, text, label: text }
  }
  if (tone.cls === 'ok') return { ...tone, text: '接单中', label: '接单中' }
  return tone
}

const TIER_ORDER: Record<string, number> = { max: 0, pro: 1 }

/** Max 在前，同档按槽名（数字按大小）。 */
export function sortSlots(vms: Vm[]): Vm[] {
  return [...vms].sort((a, b) => {
    const ta = TIER_ORDER[claudeTier(a).key] ?? 2
    const tb = TIER_ORDER[claudeTier(b).key] ?? 2
    if (ta !== tb) return ta - tb
    return String(a.name || a.id).localeCompare(String(b.name || b.id), 'en', {
      numeric: true,
      sensitivity: 'base',
    })
  })
}

/** `2 Max · 4 Pro`；空机器写「空」。 */
export function tierSummary(vms: Vm[]): string {
  const counts = new Map<string, number>()
  for (const vm of vms) {
    const label = claudeTier(vm).label || '—'
    counts.set(label, (counts.get(label) || 0) + 1)
  }
  if (!counts.size) return '空'
  return [...counts.entries()]
    .sort(
      ([a], [b]) =>
        (TIER_ORDER[a.toLowerCase().split(' ')[0]] ?? 2) -
        (TIER_ORDER[b.toLowerCase().split(' ')[0]] ?? 2)
    )
    .map(([label, n]) => `${n} ${label}`)
    .join(' · ')
}

export type Meter = { pct: number; used: number; total: number }

export type ClusterMachine = {
  /** 本机为 `local`，节点为节点 id。 */
  id: string
  role: 'local' | 'remote'
  name: string
  address: string
  link: ClusterLink
  tone: StatusTone
  /** 连接栏第二行。 */
  linkSub: string
  cpu: {
    pct: number
    cores: number
    load: [number, number | null, number | null]
  } | null
  mem: Meter | null
  disk: Meter | null
  slots: Vm[]
  capacity: MachineCapacity | null
  todayUsd: number
  remote?: ClusterApiNode
}

function todayOf(vms: Vm[]): number {
  return vms.reduce((sum, vm) => sum + (Number(vm.today_cost) || 0), 0)
}

function diskMeter(
  d:
    | {
        disk_total?: number | null
        disk_used?: number | null
        disk_pct?: number | null
      }
    | null
    | undefined
): Meter | null {
  if (!d || d.disk_total == null || d.disk_used == null || d.disk_pct == null) {
    return null
  }
  return { pct: d.disk_pct, used: d.disk_used, total: d.disk_total }
}

function hostCpu(h: HostStats | NodeHostStats): ClusterMachine['cpu'] {
  return {
    pct: Number(h.cpu_pct) || 0,
    cores: Number(h.cpu_count) || 0,
    load: [Number(h.load1) || 0, h.load5 ?? null, h.load15 ?? null],
  }
}

/** 本机：CPU / 内存跟总览同一份（5 秒），磁盘和槽实际内存来自集群页的 30 秒观测。 */
export function buildLocalMachine(input: {
  hostname: string
  vms: Vm[]
  host: HostStats | undefined
  status: ClusterLocalStatus | undefined
  available: boolean
}): ClusterMachine {
  const slots = sortSlots(input.vms.filter((vm) => !vm.node_id))
  const h = input.available ? input.host : undefined
  const memTotal = Number(h?.mem_total) || 0
  const memUsed = Number(h?.mem_used) || 0
  const link: ClusterLink = input.available ? 'ok' : 'none'
  const text = input.available ? '控制面所在' : '读不到'
  return {
    id: 'local',
    role: 'local',
    name: LOCAL_MACHINE_NAME,
    address: input.status?.nat.public_ip || input.hostname,
    link,
    tone: { ...LINK_TONE[link], text, label: text },
    linkSub: '本机',
    cpu: h ? hostCpu(h) : null,
    mem:
      h && memTotal
        ? { pct: Number(h.mem_pct) || 0, used: memUsed, total: memTotal }
        : null,
    disk: diskMeter(input.status?.disk),
    slots,
    capacity: memTotal
      ? machineCapacity({
          total: memTotal,
          used: memUsed,
          slotsActual: input.status?.docker.slots_mem,
          quota: slots.reduce((sum, vm) => sum + slotQuotaBytes(vm), 0),
        })
      : null,
    todayUsd: todayOf(slots),
  }
}

/** 节点：宿主读数来自控制面每 30 秒的 SSH 体检；槽按 `node_id` 归属。 */
export function buildRemoteMachine(
  node: ClusterApiNode,
  vms: Vm[]
): ClusterMachine {
  const link = remoteLink(node)
  const live = isLiveLink(link)
  const slots = sortSlots(vms.filter((vm) => vm.node_id === node.id))
  const h = live ? node.health?.host : null
  return {
    id: node.id,
    role: 'remote',
    name: shortNodeLabel(node.label || node.host),
    address: node.port === 22 ? node.host : `${node.host}:${node.port}`,
    link,
    tone: remoteLinkTone(node),
    linkSub: linkLatencyText(node),
    cpu: h ? hostCpu(h) : null,
    mem: h ? { pct: h.mem_pct, used: h.mem_used, total: h.mem_total } : null,
    disk: diskMeter(h),
    slots,
    capacity: h
      ? machineCapacity({
          total: h.mem_total,
          used: h.mem_used,
          slotsActual: h.containers_mem,
          quota: slots.reduce((sum, vm) => sum + slotQuotaBytes(vm), 0),
        })
      : null,
    todayUsd: todayOf(slots),
    remote: node,
  }
}

/** 本机永远第一；节点按槽多到少，再按名字。 */
export function buildMachines(input: {
  hostname: string
  vms: Vm[]
  nodes: ClusterApiNode[]
  host: HostStats | undefined
  status: ClusterLocalStatus | undefined
  available: boolean
}): ClusterMachine[] {
  const local = buildLocalMachine(input)
  const remotes = input.nodes
    .map((node) => buildRemoteMachine(node, input.vms))
    .sort(
      (a, b) =>
        b.slots.length - a.slots.length ||
        a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
    )
  return [local, ...remotes]
}

export type ClusterSummary = {
  machines: number
  online: number
  offline: number
  slots: number
  on: number
  restricted: number
  stopped: number
  /** 各机器「还能放」之和；一台都算不出来为 null。 */
  fit: number | null
  fitBy: { name: string; fit: number }[]
}

export function clusterSummary(machines: ClusterMachine[]): ClusterSummary {
  const all = machines.flatMap((m) => m.slots)
  const buckets = { on: 0, restricted: 0, stopped: 0 }
  for (const vm of all) buckets[slotBucket(vm)] += 1
  const fits = machines.filter((m) => m.capacity?.fit != null)
  return {
    machines: machines.length,
    online: machines.filter((m) => isLiveLink(m.link)).length,
    offline: machines.filter((m) => m.link === 'bad').length,
    slots: all.length,
    ...buckets,
    fit: fits.length
      ? fits.reduce((sum, m) => sum + (m.capacity?.fit || 0), 0)
      : null,
    fitBy: fits
      .filter((m) => (m.capacity?.fit || 0) > 0)
      .map((m) => ({ name: m.name, fit: m.capacity?.fit || 0 })),
  }
}

/** `14.1`（GiB，一位小数）。 */
export function gib(bytes: number | null | undefined, digits = 1): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—'
  return (bytes / GiB).toFixed(digits)
}

/** 余量向下取一位小数：2.47G 写 2.4，免得看着够放却放不下。 */
export function gibFloor(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—'
  return (Math.floor((bytes / GiB) * 10) / 10).toFixed(1)
}

/** 同总览宿主列的分档：≥85 黄、≥95 橙、≥100 红。 */
export function meterColor(pct: number): string {
  if (pct >= 100) return 'var(--status-bad)'
  if (pct >= 95) return 'var(--status-warn)'
  if (pct >= 85) return 'var(--status-caution)'
  return 'var(--status-ok)'
}

export const HOT_PCT = 85

/** 「还能放」的悬停说明：怎么算出来的。 */
export function capacityTitle(m: ClusterMachine): string | undefined {
  const c = m.capacity
  if (!c) return undefined
  const slot = `一台 2G 槽按 ${gib(NEW_SLOT_QUOTA_BYTES, 2)}G 算（虚拟机 2G + qemu 实测约 0.15G）`
  if (c.reserve == null) {
    return `槽用满 ${gib(c.quota)}G / 共 ${gib(c.total)}G；槽此刻实际用了多少没读到，算不出余量`
  }
  return `共 ${gib(c.total)}G − 系统 ${gib(c.reserve)}G − 槽用满 ${gib(c.quota)}G = 剩 ${gibFloor(c.free)}G；${slot}。此刻实际已用 ${gib(c.used)}G`
}
