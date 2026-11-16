export const WEEK_MS = 7 * 86_400_000

export function schedulingPriorityTextClass(level: number): string {
  if (!Number.isInteger(level) || level < 1 || level > 10)
    return 'text-muted-foreground'
  if (level >= 8) return 'text-blue-800 dark:text-blue-200'
  if (level >= 4) return 'text-sky-800 dark:text-sky-300'
  return 'text-slate-600 dark:text-slate-300'
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
