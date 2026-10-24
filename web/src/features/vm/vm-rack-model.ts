import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { usedPctOf } from '@/lib/format'
import { windowProbed } from '@/lib/pool-quota'
import { fleetGroup, type FleetGroup } from '@/lib/vm-status'
import { vmCostLedger, type VmLedgerRow } from '@/lib/vm-usage'
import { fableRow } from '@/features/vm/usage-meter'

/**
 * 状态分区。机架内按它分段，顶部构成条用它筛选。
 * `bad`、`revoke` 与其余「不可调度」合成一区：都要人工处理后再调度开，
 * 分开只会让运维多扫一段。
 */
export type VmZone = 'pool' | 'restricted' | 'off' | 'none' | 'dead'
export type VmZoneFilter = VmZone | 'all'

export type ZoneDef = {
  key: VmZone
  label: string
  hint: string
  /** StatusMark 的形状档。 */
  tone: 'ok' | 'warn' | 'off' | 'none' | 'bad'
  color: string
}

export const ZONES: readonly ZoneDef[] = [
  {
    key: 'pool',
    label: '在池',
    hint: '正在接单',
    tone: 'ok',
    color: 'var(--status-ok-solid)',
  },
  {
    key: 'restricted',
    label: '受限',
    hint: '冷却、熔断或窗口将满，自动出池',
    tone: 'warn',
    color: 'var(--status-warn-solid)',
  },
  {
    key: 'off',
    label: '关闭调用',
    hint: '人工关掉了调度',
    tone: 'off',
    color: 'var(--status-none)',
  },
  {
    key: 'none',
    label: '未使用',
    hint: '无凭证',
    tone: 'none',
    color: 'color-mix(in oklch, var(--status-none) 55%, transparent)',
  },
  {
    key: 'dead',
    label: '不可调度',
    hint: '凭证失效、组织禁用或配置错误，需人工处理；最近坏的在前',
    tone: 'bad',
    color: 'var(--status-bad-solid)',
  },
]

export function zoneOfGroup(group: FleetGroup): VmZone {
  return group === 'bad' || group === 'revoke' || group === 'unschedulable'
    ? 'dead'
    : group
}

export function zoneOf(vm: Vm): VmZone {
  return zoneOfGroup(fleetGroup(vm))
}

export function zoneCounts(vms: Vm[]): Record<VmZone, number> {
  const c: Record<VmZone, number> = {
    pool: 0,
    restricted: 0,
    off: 0,
    none: 0,
    dead: 0,
  }
  for (const vm of vms) c[zoneOf(vm)] += 1
  return c
}

// ---------- 单台额度窗口 ----------

export type WindowKey = '5h' | '7d' | 'fable'

/** 只描述额度占用；费用与 token 走 `vmCostLedger`，两处不重复。 */
export type WindowReadout = {
  key: WindowKey
  label: string
  /** null = 未探测（或无凭证）；note 非空时也为 null（Fable 拒 / 满）。 */
  pct: number | null
  note: string | null
  reset: unknown
}

/** 5H → 7D → Fable。Fable 只在 Max 且有读数或明确态时出现。 */
export function vmWindows(vm: Vm): WindowReadout[] {
  const probed = (w: '5h' | '7d') =>
    vm.has_token && windowProbed(vm, w) ? usedPctOf(vm, w) : null
  const windows: WindowReadout[] = [
    {
      key: '5h',
      label: '5H',
      pct: probed('5h'),
      note: null,
      reset: vm.reset_5h,
    },
    {
      key: '7d',
      label: '7D',
      pct: probed('7d'),
      note: null,
      reset: vm.reset_7d,
    },
  ]
  const fable = fableRow(vm)
  if (fable) {
    windows.push({
      key: 'fable',
      label: 'Fable',
      pct: fable.kind === 'bar' ? fable.pct : null,
      note: fable.kind === 'note' ? fable.text : null,
      reset: vm.reset_7d_oi,
    })
  }
  return windows
}

/**
 * 刀片主体画什么：读数表，或一句说明加一步动作。
 * `unprobed` = 有凭证但 5h / 7d 都没有实测值——画 0% 会冒充「还很空」。
 */
export type BladeState = 'live' | 'dead' | 'vacant' | 'unprobed'

export function bladeState(vm: Vm): BladeState {
  const zone = zoneOf(vm)
  if (zone === 'dead') return 'dead'
  if (zone === 'none' || !vm.has_token) return 'vacant'
  if (!windowProbed(vm, '5h') && !windowProbed(vm, '7d')) return 'unprobed'
  return 'live'
}

// ---------- 机架 ----------

export type RackZone = { zone: ZoneDef; vms: Vm[] }

export type Rack = {
  /** 节点 id；本机为 null。 */
  nodeId: string | null
  label: string
  zones: RackZone[]
  /** 本机架内当前可见的槽位（已应用分区筛选）。 */
  vms: Vm[]
}

/**
 * 按节点分机架，机架内按分区分段。入参应已排好序（`sortVms`），
 * 段内保持原顺序。本机架排第一，其余按标签。空机架不返回。
 */
export function buildRacks(vms: Vm[], filter: VmZoneFilter = 'all'): Rack[] {
  const byNode = new Map<string | null, Vm[]>()
  for (const vm of vms) {
    if (filter !== 'all' && zoneOf(vm) !== filter) continue
    const id = vm.node_id || null
    const list = byNode.get(id)
    if (list) list.push(vm)
    else byNode.set(id, [vm])
  }
  const racks: Rack[] = []
  for (const [nodeId, list] of byNode) {
    racks.push({
      nodeId,
      label: nodeId
        ? list.find((vm) => vm.node_name)?.node_name || nodeId
        : '本机',
      zones: ZONES.map((zone) => ({
        zone,
        vms: list.filter((vm) => zoneOf(vm) === zone.key),
      })).filter((z) => z.vms.length),
      vms: list,
    })
  }
  return racks.sort((a, b) =>
    a.nodeId === null
      ? -1
      : b.nodeId === null
        ? 1
        : a.label.localeCompare(b.label)
  )
}

export type RackTotals = {
  groups: Record<FleetGroup, number>
  seatsUsed: number
  seatsMax: number
  /** 5H / 7D / 总计，逐行与单台 `vmCostLedger` 同口径相加。 */
  ledger: VmLedgerRow[]
}

export function rackTotals(
  vms: Vm[],
  accounts?: UsageAccountRow[]
): RackTotals {
  const t: RackTotals = {
    groups: {
      pool: 0,
      restricted: 0,
      off: 0,
      none: 0,
      bad: 0,
      revoke: 0,
      unschedulable: 0,
    },
    seatsUsed: 0,
    seatsMax: 0,
    ledger: [],
  }
  for (const vm of vms) {
    t.groups[fleetGroup(vm)] += 1
    if (vm.seats_max != null) {
      t.seatsUsed += Number(vm.seats_used) || 0
      t.seatsMax += Number(vm.seats_max) || 0
    }
    const rows = vmCostLedger(vm, accounts)
    t.ledger = t.ledger.length
      ? t.ledger.map((r, i) => ({
          ...r,
          cost: r.cost + rows[i].cost,
          tokens: r.tokens + rows[i].tokens,
        }))
      : rows
  }
  return t
}
