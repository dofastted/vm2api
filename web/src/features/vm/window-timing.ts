import { expiresAtToMs } from '@/lib/fable-status'
import type { WindowReadout } from '@/features/vm/vm-rack-model'

const WINDOW_SPAN_MS: Record<string, number> = {
  '5h': 5 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  fable: 7 * 24 * 3600_000,
}

export type WindowTiming = {
  /** 窗口时间已过去的百分比（0–100）；无重置时间为 null */
  elapsedPct: number | null
  /** 用量% ÷ 时间%；>1 说明用得比时间快 */
  pace: number | null
  /** 按当前节奏重置前就会用满时，还需多少毫秒 */
  fullInMs: number | null
  startMs: number | null
  resetMs: number | null
}

/** 窗口起点 = 重置时间 − 窗口长度。只用已有的 reset 与 pct，不另取数据。 */
export function windowTiming(w: WindowReadout, now: number): WindowTiming {
  const span = WINDOW_SPAN_MS[w.key]
  const resetMs = expiresAtToMs(w.reset) || null
  if (!span || !resetMs || resetMs <= now) {
    return {
      elapsedPct: null,
      pace: null,
      fullInMs: null,
      startMs: null,
      resetMs,
    }
  }
  const startMs = resetMs - span
  const elapsed = Math.min(span, Math.max(0, now - startMs))
  const elapsedPct = (elapsed / span) * 100
  const pct = w.pct
  const pace = pct != null && elapsedPct > 0 ? pct / elapsedPct : null
  let fullInMs: number | null = null
  if (pct != null && pct > 0 && pct < 100 && elapsed > 0) {
    const need = ((100 - pct) / pct) * elapsed
    if (need < resetMs - now) fullInMs = need
  }
  return { elapsedPct, pace, fullInMs, startMs, resetMs }
}
