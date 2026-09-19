import { Link } from '@tanstack/react-router'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { credTypeLabel, credTypeOf } from '@/lib/cred-type'
import { fableState, resetCountdown } from '@/lib/fable-status'
import { fmtNum, fmtUsd, usedPctOf } from '@/lib/format'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import { isCodexVm, platformLabel } from '@/lib/vm-kind'
import {
  claudeTier,
  credentialStatus,
  fleetGroup,
  vmCooldown,
  vmCooldownTitle,
  vmCredDead,
  vmFailedAt,
} from '@/lib/vm-status'
import { vmCacheHitPct } from '@/lib/vm-usage'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  CredLaneChip,
  PlatformChip,
  SlotIdentity,
} from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import { SchedulableSwitch } from '@/features/vm/schedulable-switch'

/** 用量条统一朝一个方向：值越高越危险。四档对应状态轴，用 solid 变体
    （非文本图形，允许比文字版更亮更艳）。 */
const RISK_BAR = (risk: number) =>
  risk >= 100
    ? 'bg-[color:var(--status-bad-solid)]'
    : risk >= 85
      ? 'bg-[color:var(--status-warn-solid)]'
      : risk >= 70
        ? 'bg-[color:var(--status-caution-solid)]'
        : 'bg-[color:var(--status-ok-solid)]'

function UtilBar({
  label,
  value,
  sub,
  mutedClass,
  className,
}: {
  label: string
  /** 用量百分比（越高越危险）。 */
  value: number
  /** 窗口重置倒计时（分钟精度），null/undefined 不占位。 */
  sub?: string | null
  mutedClass?: string
  className?: string
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div
        className={cn(
          'flex items-baseline justify-between text-[11px] tracking-[-0.005em]',
          mutedClass ?? 'text-muted-foreground'
        )}
      >
        <span className='truncate'>{label}</span>
        <span className='flex shrink-0 items-baseline gap-1.5'>
          {sub ? <span className='opacity-75'>{sub}</span> : null}
          <span className='font-medium tabular-nums'>{value.toFixed(0)}%</span>
        </span>
      </div>
      <Progress
        // 非零但极小的值给 1.5% 底宽，否则 1% 的条渲染成看不见的一根线，
        // 和真正的 0% 无法区分。
        value={value > 0 ? Math.min(100, Math.max(1.5, value)) : 0}
        className='h-[3px] track-recessed'
        indicatorClassName={cn(RISK_BAR(value), 'rounded-full')}
      />
    </div>
  )
}

/**
 * 网格卡片。三段式：**是谁**（名称 / 邮箱 / 等级）→ **还剩多少**（用量条 + 消耗）
 * → **能不能用**（左下有效性 + 右下调度开关）。
 *
 * 卡面底色即等级：Pro 蓝 / Max 紫 / 无凭证中性。代理主机、缓存命中、凭证类型
 * 这些诊断字段留在列表视图与详情页——卡片是分诊面，不是明细面。
 */
export function VmCards({
  vms,
  onReset,
  onDelete,
  onClearCooldown,
}: {
  vms: Vm[]
  /** 未传时不渲染对应按钮 —— cluster 页/vm 页按需传入，行为不受影响。 */
  onReset?: (vm: Vm) => void
  onDelete?: (vm: Vm) => void
  onClearCooldown?: (vm: Vm) => void
}) {
  return (
    <div className='grid min-w-0 gap-2.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4'>
      {vms.map((vm) => (
        <VmCard
          key={vm.id}
          vm={vm}
          onReset={onReset}
          onDelete={onDelete}
          onClearCooldown={onClearCooldown}
        />
      ))}
    </div>
  )
}

/**
 * Max 账号的 Fable 额度。Pro 没有这个窗口，返回 null 时不占位。
 *
 * 「拒 / 满」这些态没有百分比，此时返回 `note` 走文案而不是画满格条——
 * 满格红条在一个 5h/7d 都是 0% 的号上会被误读成「烧满了」，
 * 而实际含义是「这个号根本用不了 Fable」。
 */
function fableRow(
  vm: Vm
): { kind: 'bar'; pct: number } | { kind: 'note'; text: string } | null {
  const tier = claudeTier(vm)
  if (tier.key !== 'max') return null
  const st = fableState(vm, tier.key)
  if (st.usedPct != null) return { kind: 'bar', pct: st.usedPct }
  if (st.tone.key === 'none') return null
  return { kind: 'note', text: st.tone.text }
}

function VmCard({
  vm,
  onReset,
  onDelete,
  onClearCooldown,
}: {
  vm: Vm
  onReset?: (vm: Vm) => void
  onDelete?: (vm: Vm) => void
  onClearCooldown?: (vm: Vm) => void
}) {
  const skin = tierVisual(vm)
  const now = useNow()
  const u5 = usedPctOf(vm, '5h')
  const u7 = usedPctOf(vm, '7d')
  const fable = isCodexVm(vm) ? null : fableRow(vm)
  const hasToken = Boolean(vm.has_token)
  // 无凭证槽没有窗口，倒计时无意义；有票才算。
  const cd5 = hasToken ? resetCountdown(vm.reset_5h, now) : null
  const cd7 = hasToken ? resetCountdown(vm.reset_7d, now) : null
  const cdFable = hasToken ? resetCountdown(vm.reset_7d_oi, now) : null
  const cooling = Boolean(vmCooldown(vm))
  const hasActions = Boolean(onClearCooldown || onReset || onDelete)
  const fiveLabel = '5h 用量'
  const sevenLabel = '7d 用量'

  return (
    <div
      className={cn(
        'group flex h-full min-w-0 flex-col overflow-hidden rounded-[10px] border p-3.5 transition-[background-color,border-color] duration-150 ease-out',
        skin.card
      )}
    >
      <div className='flex min-w-0 flex-1 flex-col'>
        <Link
          to='/vm/$id'
          params={{ id: vm.id }}
          className='flex min-w-0 flex-1 flex-col gap-3.5 rounded-[5px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
        >
          <div className='flex min-w-0 items-start justify-between gap-2'>
            <div className='min-w-0 flex-1 overflow-hidden'>
              <div className='flex min-w-0 items-center gap-1.5'>
                <SlotIdentity
                  vm={vm}
                  compact
                  className='min-w-0 flex-1 font-[590]'
                />
                <CredLaneChip vm={vm} />
              </div>
              <p
                className={cn(
                  'truncate text-[11px] leading-[1.45] tracking-[-0.003em]',
                  skin.muted
                )}
              >
                {vm.email ? vm.name || vm.id : '未绑定账号'}
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

          <ProxyChip vm={vm} className='w-full' />

          {/* 5h 与 Fable 并排：两者都是「当下还能不能打」的短窗口，并置便于
              比较；7d 是周配额、另一个时间尺度，独占一行。Pro 没有 Fable，
              5h 自然占满整行。 */}
          <div className='space-y-2.5'>
            <div className='grid grid-cols-2 gap-3'>
              <UtilBar
                label={fiveLabel}
                value={u5}
                sub={cd5}
                mutedClass={skin.muted}
                className='min-w-0'
              />
              {fable?.kind === 'bar' ? (
                <UtilBar
                  label='Fable'
                  value={fable.pct}
                  sub={cdFable}
                  mutedClass={skin.muted}
                  className='min-w-0'
                />
              ) : fable?.kind === 'note' ? (
                <div className='min-w-0 space-y-1.5'>
                  <div
                    className={cn(
                      'flex items-baseline justify-between gap-1 text-[11px] tracking-[-0.005em]',
                      skin.muted
                    )}
                  >
                    <span>Fable</span>
                    <span className='truncate font-medium text-[color:var(--status-warn)]'>
                      {fable.text}
                    </span>
                  </div>
                  {/* 占位与 UtilBar 的条等高，否则同一行里两列基线不齐 */}
                  <div className='h-[3px]' aria-hidden='true' />
                </div>
              ) : null}
            </div>
            <UtilBar
              label={sevenLabel}
              value={u7}
              sub={cd7}
              mutedClass={skin.muted}
            />
          </div>

          {/* 层级靠尺寸与字重建立，不靠颜色：累计是决策数字，今日是参考值。 */}
          <div className='mt-auto flex items-end justify-between gap-3 pt-1'>
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
                  'mt-1 truncate text-[19px] leading-none font-[590] tracking-[-0.02em] tabular-nums',
                  skin.accent
                )}
              >
                {fmtUsd(vm.total_cost, 2)}
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
        </Link>

        <div className='hairline-t mt-3 flex items-center justify-between gap-2 pt-2'>
          <StatusMark tone={credentialStatus(vm)} variant='pill' />
          <div className='flex items-center gap-1'>
            {hasActions ? (
              <div className='hidden items-center gap-0.5 transition-opacity md:flex md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100'>
                {onClearCooldown && cooling ? (
                  <Button
                    size='sm'
                    variant='ghost'
                    title={vmCooldownTitle(vm)}
                    className={cn('h-6 px-1.5 text-[11px]', skin.muted)}
                    onClick={() => onClearCooldown(vm)}
                  >
                    清冷却
                  </Button>
                ) : null}
                {onReset ? (
                  <Button
                    size='sm'
                    variant='ghost'
                    className={cn('h-6 px-1.5 text-[11px]', skin.muted)}
                    onClick={() => onReset(vm)}
                  >
                    重置
                  </Button>
                ) : null}
                {onDelete ? (
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-6 px-1.5 text-[11px] text-destructive'
                    onClick={() => onDelete(vm)}
                  >
                    删除
                  </Button>
                ) : null}
              </div>
            ) : null}
            <SchedulableSwitch
              vmId={vm.id}
              schedulable={vm.schedulable !== false}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export { VmTable } from './vm-list-table'

export type VmSortKey = 'name' | 'today' | 'cache' | 'remain' | 'status'

/**
 * 状态优先级：在池 → 关闭调用 → 未使用 → 无效凭证 → revoke。
 * cool / quota 与 pool 同级（都还在池里可被调度到），与 `fleetGroup` 的归并口径一致。
 */
function statusRank(vm: Vm): number {
  return { pool: 0, off: 1, none: 2, bad: 3, revoke: 4 }[fleetGroup(vm)] ?? 5
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
  for (const vm of vms) {
    if (!isCodexVm(vm)) claude += 1
  }
  const chips = [['claude', 'claude', claude]] as const
  return (
    <>
      {chips.map(([key, chipKind, n]) => (
        <Button
          key={key}
          size='sm'
          variant={kind === key ? 'default' : 'outline'}
          aria-pressed={kind === key}
          className='gap-1.5'
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
