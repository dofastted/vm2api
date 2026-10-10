import type { KeyboardEvent } from 'react'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { credTypeLabel, credTypeOf } from '@/lib/cred-type'
import { fmtNum, fmtUsd, usedPctOf } from '@/lib/format'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import { isCodexVm, platformLabel, slotNameLabel } from '@/lib/vm-kind'
import {
  claudeTier,
  credentialStatus,
  fleetGroup,
  vmCredDead,
  vmFailedAt,
} from '@/lib/vm-status'
import { vmCacheHitPct, vmTotalCost } from '@/lib/vm-usage'
import { Button } from '@/components/ui/button'
import {
  CredLaneChip,
  PlatformChip,
  SlotIdentity,
} from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import { NodeChip } from '@/features/vm/node-chip'
import { RuntimeChip } from '@/features/vm/runtime-chip'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import { VmUsageWindows } from '@/features/vm/usage-windows'
import { VmActionMenu } from '@/features/vm/vm-action-menu'
import { useVmActions } from '@/features/vm/vm-actions-context'

/**
 * 网格卡片。三段式：**是谁**（名称 / 邮箱 / 等级）→ **还剩多少**（统一用量窗口）
 * → **能不能用**（左下有效性 + 右下调度开关与扩展菜单）。
 *
 * 卡面底色即等级：Pro 蓝 / Max 紫 / 无凭证中性。点击卡片弹出详情卡；
 * 诊断字段留在详情卡与详情页——卡片是分诊面，不是明细面。
 */
export function VmCards({
  vms,
  accounts,
}: {
  vms: Vm[]
  accounts?: UsageAccountRow[]
}) {
  return (
    <div className='grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4'>
      {vms.map((vm) => (
        <VmCard key={vm.id} vm={vm} accounts={accounts} />
      ))}
    </div>
  )
}

function VmCard({ vm, accounts }: { vm: Vm; accounts?: UsageAccountRow[] }) {
  const actions = useVmActions()
  const skin = tierVisual(vm)
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    actions.openDetail(vm)
  }

  return (
    <div
      role='button'
      tabIndex={0}
      aria-label={`查看 ${vm.id} 详情`}
      className={cn(
        'group flex h-full min-w-0 cursor-pointer flex-col gap-2 overflow-hidden rounded-[10px] border p-3 transition-[background-color,border-color] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        skin.card
      )}
      onClick={() => actions.openDetail(vm)}
      onKeyDown={onKey}
    >
      <div className='flex min-w-0 items-start justify-between gap-2'>
        <div className='min-w-0 flex-1 overflow-hidden'>
          <div className='flex min-w-0 items-center gap-1.5'>
            <SlotIdentity
              vm={vm}
              compact
              className='min-w-0 flex-1 font-[590]'
            />
            <RuntimeChip vm={vm} />
            <NodeChip nodeId={vm.node_id} />
            <CredLaneChip vm={vm} />
          </div>
          <p
            className={cn(
              'truncate text-[11px] leading-[1.45] tracking-[-0.003em]',
              skin.muted
            )}
          >
            {slotNameLabel(vm)}
          </p>
        </div>
        {skin.key === 'none' ? null : (
          <span
            className={cn(
              'shrink-0 rounded-[5px] px-2 py-0.5 text-[10px] leading-none font-bold tracking-[0.03em] uppercase',
              skin.badge
            )}
          >
            {skin.label}
          </span>
        )}
      </div>

      <ProxyChip vm={vm} className='w-full' compact />

      <VmUsageWindows vm={vm} accounts={accounts} quiet quotaActions />

      {/* 层级靠尺寸与字重建立，不靠颜色：累计是决策数字，今日是参考值。 */}
      <div className='mt-auto flex items-end justify-between gap-3'>
        <div className='min-w-0'>
          <div
            className={cn(
              'text-[10.5px] leading-none',
              skin.key === 'none'
                ? 'text-[color:var(--text-tertiary)]'
                : skin.muted
            )}
          >
            累计消耗
          </div>
          <div
            className={cn(
              'mt-1 truncate text-[17px] leading-none font-[590] tracking-[-0.02em] tabular-nums',
              skin.accent
            )}
          >
            {fmtUsd(vmTotalCost(vm, accounts), 2)}
          </div>
        </div>
        <div className='shrink-0 text-right'>
          <div
            className={cn(
              'text-[10.5px] leading-none',
              skin.key === 'none'
                ? 'text-[color:var(--text-tertiary)]'
                : skin.muted
            )}
          >
            今日
          </div>
          <div className='mt-1 text-[13px] leading-none tracking-[-0.01em] tabular-nums'>
            {fmtUsd(vm.today_cost, 2)}
          </div>
        </div>
      </div>

      <div className='hairline-t flex items-center justify-between gap-2 pt-1.5'>
        <div className='flex min-w-0 items-center gap-1.5'>
          <StatusMark tone={credentialStatus(vm)} variant='pill' />
        </div>
        <div
          className='flex items-center gap-1'
          onClick={(e) => e.stopPropagation()}
        >
          <SchedulableSwitch {...vmSchedulableProps(vm)} />
          <VmActionMenu vm={vm} className={skin.muted} />
        </div>
      </div>
    </div>
  )
}

export { VmTable } from './vm-list-table'

export type VmSortKey = 'name' | 'today' | 'cache' | 'remain' | 'status'

/**
 * 状态优先级：在池 → 受限 → 关闭调用 → 未使用 → 无效凭证 → revoke。
 * cool / quota 是受限，不与在池同级。
 */
function statusRank(vm: Vm): number {
  return (
    { pool: 0, restricted: 1, off: 2, none: 3, bad: 4, revoke: 5 }[
      fleetGroup(vm)
    ] ?? 6
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
 * 按 fleetGroup 粗分档位筛选 + 全文搜索。
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
  filter: string,
  kind: VmKindFilter = 'all'
) {
  const needle = q.trim().toLowerCase()
  return vms.filter((vm) => {
    if (!matchesKind(vm, kind)) return false
    if (filter !== 'all' && fleetGroup(vm) !== filter) return false
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

export { fmtNum }
