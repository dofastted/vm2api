import type { Vm } from '@/types/panel-vm'
import { expiresAtToMs, fableUsedOf, fableWeeklyFull } from '@/lib/fable-status'
import { pct, usedPctOf } from '@/lib/format'
import { accountUsable, claudeTier, fablePlanDenied } from '@/lib/vm-status'

/**
 * 号池三窗口（5h / 7d / Fable）的池级额度聚合。
 *
 * 口径（与总览「号池额度」卡一致，改动前先对齐产品约定）：
 * - 只统计「凭证可用」的槽：`has_token` 且 `accountUsable`（凭证有效即可用）。
 *   无效、已过期、被吊销（revoke）一律不计入容量，也不计入消耗。
 *   调度关（off）、冷却、警告、限制中的凭证额度仍然真实存在，照常计入。
 * - 容量按「账号数」计：每张可用凭证贡献 1 个满窗口。
 * - 消耗为各凭证已用比例之和（账号当量）。未探测的凭证计容量、消耗按 0，
 *   在分段图里以虚线空段标出，不冒充「确认可用」。
 * - Fable 容量只含 Max 档且未被拒 Fable 权限、未被 Fable 封禁的凭证——
 *   Pro 号没有 Fable 窗口，计入只会稀释这个数。
 */
export type PoolQuotaSeg = {
  id: string
  name: string
  /** 已用 0-100，超量截断到 100（单凭证消耗不可能超过自身窗口）。 */
  usedPct: number
  /** false = 该窗口没有任何实测数据（未探测），消耗按 0 计。 */
  probed: boolean
  /** 该窗口的重置时刻 ms；未知为 0。倒计时由渲染层按当前时间算。 */
  resetAt: number
}

export type PoolWindow = {
  key: '5h' | '7d' | 'fable'
  label: string
  /** 按已用降序——最烫的凭证排最前，扫一眼就能看到风险集中在哪。 */
  segs: PoolQuotaSeg[]
  /** 计入容量的凭证数。 */
  capacity: number
  /** 已耗账号当量：Σ usedPct/100。 */
  usedAccounts: number
  /** 剩余账号当量：capacity - usedAccounts。 */
  remainAccounts: number
  /** 剩余占比 0-100（容量为 0 时为 0）。 */
  remainPct: number
}

function clampPct(v: unknown): number {
  return Math.max(0, Math.min(100, pct(v)))
}

function buildWindow(
  key: PoolWindow['key'],
  label: string,
  segs: PoolQuotaSeg[]
): PoolWindow {
  segs.sort((a, b) => b.usedPct - a.usedPct)
  const usedAccounts = segs.reduce((s, x) => s + x.usedPct / 100, 0)
  const capacity = segs.length
  const remainAccounts = capacity - usedAccounts
  return {
    key,
    label,
    segs,
    capacity,
    usedAccounts,
    remainAccounts,
    remainPct: capacity ? (remainAccounts / capacity) * 100 : 0,
  }
}

/**
 * 计入额度的凭证 = `accountUsable`（凭证有效即可用，运营确认口径）：
 * 无凭证 / 无效 / 过期 / revoke 不计；off / 冷却 / 限制照计。
 * setup-token 凭证无刷新流程，死活只看过期时间与探测结果，
 * 不受 OAuth refresh 相关错误字段影响（vm-05 案例）。
 */
export function poolEligible(vm: Vm): boolean {
  return accountUsable(vm)
}

export function poolQuota(vms: Vm[]): {
  windows: [PoolWindow, PoolWindow, PoolWindow]
  eligible: number
  withToken: number
} {
  const usable = vms.filter(poolEligible)
  const w5: PoolQuotaSeg[] = []
  const w7: PoolQuotaSeg[] = []
  const wf: PoolQuotaSeg[] = []
  for (const vm of usable) {
    const name = String(vm.name || vm.id)
    w5.push({
      id: vm.id,
      name,
      usedPct: usedPctOf(vm, '5h'),
      probed: Boolean(
        vm.utilization_5h != null ||
        vm.codex_usage?.windows?.some(
          (w) => w.id === '5h' && w.used_percent != null
        )
      ),
      resetAt: expiresAtToMs(vm.reset_5h),
    })
    w7.push({
      id: vm.id,
      name,
      usedPct: usedPctOf(vm, '7d'),
      probed: Boolean(
        vm.utilization_7d != null ||
        vm.codex_usage?.windows?.some(
          (w) => w.id === '7d' && w.used_percent != null
        )
      ),
      resetAt: expiresAtToMs(vm.reset_7d),
    })
    const fb = vm.fable || {}
    const tier = claudeTier(vm)
    if (tier.key !== 'max' || fablePlanDenied(fb) || fb.banned) continue
    const used = fableUsedOf(vm, tier.key)
    const weeklyFull = fableWeeklyFull(vm, tier.key)
    wf.push({
      id: vm.id,
      name,
      usedPct: weeklyFull ? 100 : used == null ? 0 : clampPct(used),
      probed: used != null || weeklyFull || Boolean(fb.ok),
      resetAt: expiresAtToMs(vm.reset_7d_oi),
    })
  }
  return {
    windows: [
      buildWindow('5h', '5h 窗口', w5),
      buildWindow('7d', '7d 窗口', w7),
      buildWindow('fable', 'Fable 7d', wf),
    ],
    eligible: usable.length,
    withToken: vms.filter((v) => v.has_token).length,
  }
}
