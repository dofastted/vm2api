/** 类型列的等级 / 权重色阶，以及周窗口重置条。 */

export const WEEK_MS = 7 * 86_400_000

/** 0 = 最浅，1 = 最深。同一冷蓝色相，避免被读成健康色或等级色。 */
export function depthStyle(t: number): {
  backgroundColor: string
  color: string
} {
  const x = Math.min(1, Math.max(0, t))
  const L = 0.94 - x * 0.56
  const C = 0.015 + x * 0.11
  const fgL = L < 0.62 ? 0.98 : 0.27
  return {
    backgroundColor: `oklch(${L.toFixed(3)} ${C.toFixed(3)} 250)`,
    color: `oklch(${fgL.toFixed(3)} 0.02 250)`,
  }
}

/** 把 [min, max] 收成 0–1。越界夹紧；非数字返回 null。 */
export function scaleT(value: number, min: number, max: number): number | null {
  if (!Number.isFinite(value) || !(max > min)) return null
  return Math.min(1, Math.max(0, (value - min) / (max - min)))
}

export type ResetRemainVisual = {
  /** 剩余时间占窗口的百分比。已过点为 0。 */
  pct: number
  overdue: boolean
  color: string
  textClass: string
}

/**
 * 重置条按剩余时间从满到空。颜色随紧迫度变深，文字色同步，不只靠颜色。
 * 距重置超过一个窗口时条保持满格。
 */
export function resetRemainVisual(
  resetMs: number,
  now: number,
  windowMs = WEEK_MS
): ResetRemainVisual {
  const left = resetMs - now
  const overdue = !Number.isFinite(resetMs) || left <= 0
  const remain = overdue || windowMs <= 0 ? 0 : Math.min(1, left / windowMs)
  const urgency = 1 - remain
  if (overdue) {
    return {
      pct: 0,
      overdue: true,
      color: 'var(--status-bad)',
      textClass: 'text-[color:var(--status-bad)]',
    }
  }
  if (urgency >= 0.85) {
    return {
      pct: Math.round(remain * 100),
      overdue: false,
      color: 'var(--status-warn)',
      textClass: 'text-[color:var(--status-warn)]',
    }
  }
  if (urgency >= 0.6) {
    return {
      pct: Math.round(remain * 100),
      overdue: false,
      color: 'var(--status-caution)',
      textClass: 'text-[color:var(--status-caution)]',
    }
  }
  return {
    pct: Math.round(remain * 100),
    overdue: false,
    color: 'var(--status-ok)',
    textClass: 'text-muted-foreground',
  }
}
