import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { credTypeLabel, credTypeOf } from '@/lib/cred-type'
import { usedPctOf } from '@/lib/format'
import { isCodexVm, platformLabel } from '@/lib/vm-kind'
import { claudeTier, fleetGroup, vmCredDead, vmFailedAt } from '@/lib/vm-status'
import { vmCacheHitPct, vmTotalCost, vmWindowCosts } from '@/lib/vm-usage'
import { Button } from '@/components/ui/button'
import { PlatformChip } from '@/components/platform-chip'
import { zoneOf, type VmZoneFilter } from '@/features/vm/vm-rack-model'

export { VmTable } from './vm-list-table'

export type VmSortKey =
  'name' | 'today' | 'cache' | 'remain' | 'status' | 'cost7' | 'total'

/**
 * 状态优先级：在池 → 受限 → 关闭调用 → 未使用 → 无效凭证 → revoke。
 * cool / quota 是受限，不与在池同级。
 */
function statusRank(vm: Vm): number {
  return (
    {
      pool: 0,
      restricted: 1,
      off: 2,
      none: 3,
      unschedulable: 4,
      bad: 4,
      revoke: 5,
    }[fleetGroup(vm)] ?? 6
  )
}

/**
 * 无效凭证组内的次序：最近坏掉的排最前。
 *
 * 这一组不按 vm-01/vm-02 的命名排 —— 名字顺序对「哪台刚出事」毫无信息量，
 * 运维盯着这组就是要先处理刚坏的那台。`vmFailedAt` 大的在前。
 */
function deadCmp(a: Vm, b: Vm): number {
  const d = vmFailedAt(b) - vmFailedAt(a)
  if (d) return d
  return String(a.name || a.id || '')
    .toLowerCase()
    .localeCompare(String(b.name || b.id || '').toLowerCase())
}

/**
 * 按状态优先级排序，同级内按名称（无效凭证组例外，见 `deadCmp`）。
 * 默认顺序让运维先看到还能用的槽位，坏的沉到底部。
 */
export function sortVmsByStatus(vms: Vm[]): Vm[] {
  return vms.slice().sort((a, b) => {
    const d = statusRank(a) - statusRank(b)
    if (d) return d
    if (vmCredDead(a) && vmCredDead(b)) return deadCmp(a, b)
    return String(a.name || a.id || '')
      .toLowerCase()
      .localeCompare(String(b.name || b.id || '').toLowerCase())
  })
}

export function sortVms(
  vms: Vm[],
  key: VmSortKey,
  dir: 'asc' | 'desc',
  accounts?: UsageAccountRow[]
): Vm[] {
  const sign = dir === 'asc' ? 1 : -1
  const val = (vm: Vm): number | string => {
    switch (key) {
      case 'today':
        return Number(vm.today_cost || 0)
      case 'cost7':
        return vmWindowCosts(vm, accounts).d7
      case 'total':
        return vmTotalCost(vm, accounts)
      // null (no prompt tokens) sorts below a real 0% hit rate
      case 'cache':
        return vmCacheHitPct(vm, accounts) ?? -1
      case 'remain':
        return 100 - usedPctOf(vm, '5h')
      case 'status':
        return statusRank(vm)
      default:
        return String(vm.name || vm.id || '').toLowerCase()
    }
  }
  return vms.slice().sort((a, b) => {
    // 无效凭证恒后置，不受排序键与方向影响。按「今日花费」倒序时一台已吊销
    // 的高消耗槽本来会窜到第一行 —— 它已经不能用了，占着头部只会误导。
    // 组内按失效时间排（最近坏的在前），同样不看排序键。
    const da = vmCredDead(a)
    const db = vmCredDead(b)
    if (da !== db) return da ? 1 : -1
    if (da && db) return deadCmp(a, b)
    const av = val(a)
    const bv = val(b)
    if (typeof av === 'string' || typeof bv === 'string') {
      return sign * String(av).localeCompare(String(bv))
    }
    return sign * (av - bv)
  })
}

/**
 * 按状态分区筛选 + 全文搜索。
 * 等级与凭证类型仍参与全文搜索（可以直接搜 "Max" / "OAuth"）。
 * `kind` 切 Claude / GPT 凭证面，默认全部。
 */
export type VmKindFilter = 'all' | 'claude' | 'gpt'

export function matchesKind(vm: Vm, kind: VmKindFilter): boolean {
  if (kind === 'all') return true
  return isCodexVm(vm) ? kind === 'gpt' : kind === 'claude'
}

export function KindFilterChips({
  vms,
  kind,
  onChange,
}: {
  vms: Vm[]
  kind: VmKindFilter
  onChange: (kind: VmKindFilter) => void
}) {
  let claude = 0
  let openai = 0
  for (const vm of vms) {
    if (isCodexVm(vm)) openai += 1
    else claude += 1
  }
  const chips = [
    ['claude', 'claude', claude, '筛选 Claude'],
    ['gpt', 'codex', openai, '筛选 OpenAI'],
  ] as const
  return (
    <>
      {chips.map(([key, chipKind, n, label]) => (
        <Button
          key={key}
          size='sm'
          variant={kind === key ? 'default' : 'outline'}
          aria-pressed={kind === key}
          aria-label={label}
          title={label}
          className='cursor-pointer gap-1.5 transition-colors duration-200'
          onClick={() => onChange(kind === key ? 'all' : key)}
        >
          <PlatformChip kind={chipKind} />
          <span className='tabular-nums'>{n}</span>
        </Button>
      ))}
    </>
  )
}

export function filterVms(
  vms: Vm[],
  q: string,
  filter: VmZoneFilter,
  kind: VmKindFilter = 'all'
) {
  const needle = q.trim().toLowerCase()
  return vms.filter((vm) => {
    if (!matchesKind(vm, kind)) return false
    if (filter !== 'all' && zoneOf(vm) !== filter) return false
    if (!needle) return true
    const hay = [
      vm.name,
      vm.id,
      vm.email,
      vm.region,
      vm.zone,
      vm.kernel,
      vm.proxy_id,
      claudeTier(vm).label,
      platformLabel(vm),
      credTypeLabel(credTypeOf(vm)),
    ]
      .map((x) => String(x || '').toLowerCase())
      .join(' ')
    return hay.includes(needle)
  })
}
