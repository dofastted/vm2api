/**
 * Closed-window archive. The vendor only reports the live 5h / 7d window, so
 * once it rolls over its final used% is gone. Every quota write keeps the
 * latest reading per window; a reading that opens a new window moves the old
 * one to `prev`.
 *
 * Shape (per key '5h' | '7d'):
 *   { current: { reset, used_ratio }, prev: { start, end, used_ratio, closed_at } }
 */
import { parseResetMs, toPercentUsed, WINDOW_5H_MS, WINDOW_7D_MS } from './quota-window.mjs'

export const HISTORY_WINDOW_MS = { '5h': WINDOW_5H_MS, '7d': WINDOW_7D_MS }

// Same drop that `_observeUtil` reads as a reset: used% never falls inside a window
// except after a reset credit, and sources disagree by at most a rounding step.
const RESET_DROP = 0.02

const iso = (ms) => new Date(ms).toISOString()

/**
 * @param {object|null} history  previous archive
 * @param {{ '5h'?: { utilization?, reset? }, '7d'?: { utilization?, reset? } }} readings
 * @returns {object} next archive (the same object when nothing moved)
 */
export function rollWindowHistory(history, readings, now = Date.now()) {
  let out = history || {}
  for (const key of ['5h', '7d']) {
    const r = readings?.[key]
    const resetMs = parseResetMs(r?.reset)
    const pct = toPercentUsed(r?.utilization)
    // An elapsed reset is a leftover reading from the window that already ended.
    if (!Number.isFinite(resetMs) || resetMs <= now || pct == null) continue
    const used = pct / 100
    const dur = HISTORY_WINDOW_MS[key]
    const slot = out[key] || {}
    const cur = slot.current
    const curMs = parseResetMs(cur?.reset)
    const reading = { reset: iso(resetMs), used_ratio: used }
    let next
    if (!cur || !Number.isFinite(curMs)) {
      next = { ...slot, current: reading }
    } else if (resetMs - curMs > dur / 2 || (resetMs > curMs && used + RESET_DROP < Number(cur.used_ratio))) {
      // Natural rollover ends at the old reset; a reset credit ends where the new window starts.
      const end = Math.min(curMs, Math.max(resetMs - dur, curMs - dur))
      next = {
        current: reading,
        prev: { start: iso(curMs - dur), end: iso(end), used_ratio: Number(cur.used_ratio), closed_at: iso(now) },
      }
    } else if (cur.reset !== reading.reset || Number(cur.used_ratio) !== used) {
      next = { ...slot, current: reading }
    } else {
      continue
    }
    out = { ...out, [key]: next }
  }
  return out
}

/** The latest window that has ended: `current` once its reset passed, else the archived `prev`. */
export function lastClosedWindow(history, key, now = Date.now()) {
  const slot = history?.[key]
  const cur = slot?.current
  const curMs = parseResetMs(cur?.reset)
  if (cur && Number.isFinite(curMs) && curMs <= now) {
    return { start: iso(curMs - HISTORY_WINDOW_MS[key]), end: iso(curMs), used_ratio: Number(cur.used_ratio) }
  }
  return slot?.prev || null
}
