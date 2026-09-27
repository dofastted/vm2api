import type { VmProxySnap } from '@/types/panel-vm'
import type { HealthBuckets } from '@/features/overview/health-gauge'
import { proxyOwnHealthOf } from '@/features/vm/proxy-health'

/** 代理健康分布，按 `proxyOwnHealthOf` 的 tone.cls 归桶，供 `HealthBar`/`HealthLegend` 用。 */
export function proxyHealthBuckets(list: VmProxySnap[]): HealthBuckets {
  const b: HealthBuckets = { ok: 0, caution: 0, warn: 0, bad: 0, none: 0 }
  for (const proxy of list) {
    const cls = proxyOwnHealthOf(proxy).tone.cls
    const bucket = cls in b ? (cls as keyof HealthBuckets) : 'none'
    b[bucket] += 1
  }
  return b
}

/** 代理池整体健康分，加权口径对齐 `healthScore()`（`web/src/lib/vm-status.ts`）。 */
export function proxyHealthScoreOf(list: VmProxySnap[]): number {
  if (!list.length) return 0
  const b = proxyHealthBuckets(list)
  return Math.round(
    (b.ok * 100 + b.caution * 84 + b.warn * 68 + b.bad * 28) / list.length
  )
}
