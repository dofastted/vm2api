import { headerWindowOrEmpty, officialWindow, parseResetMs } from './quota-window.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_LEVEL = 1
const MAX_MANUAL_LEVEL = 10
const MAX_AUTO_LEVEL = 7

function normalizedManualLevel(value) {
  if (value == null || value === '' || String(value).trim().toLowerCase() === 'auto') return null
  const level = Number(value)
  return Number.isInteger(level) && level >= MIN_LEVEL && level <= MAX_MANUAL_LEVEL ? level : null
}

export function parseScheduleLevelInput(value) {
  if (value == null || String(value).trim().toLowerCase() === 'auto') {
    return { ok: true, value: null }
  }
  const level = Number(value)
  if (!Number.isInteger(level) || level < MIN_LEVEL || level > MAX_MANUAL_LEVEL) {
    return { ok: false, error: 'schedule_level must be an integer from 1 to 10, null, or "auto"' }
  }
  return { ok: true, value: level }
}

export function manualScheduleLevelOf(vm) {
  return normalizedManualLevel(vm?.policy?.priority)
}

/**
 * `routing.pool.reset_priority`: when on (default), an auto-level slot rises
 * one level per day closer to its weekly reset, so slots about to reset are
 * drained first. When off, every auto-level slot sits on one level and the
 * balanced ranking (occupancy, headroom) spreads load evenly. Manual levels
 * apply either way. The pool scheduler sets this on load and hot reload.
 */
let resetPriorityEnabled = true

export function setResetPriorityEnabled(enabled) {
  resetPriorityEnabled = enabled !== false
}

export function resetPriorityIsEnabled() {
  return resetPriorityEnabled
}

export function automaticScheduleLevel(resetAt, now = Date.now()) {
  if (!resetPriorityEnabled) return MIN_LEVEL
  const resetMs = parseResetMs(resetAt)
  if (!Number.isFinite(resetMs) || resetMs <= now) return MIN_LEVEL
  const fullDaysRemaining = Math.floor((resetMs - now) / DAY_MS)
  return Math.max(MIN_LEVEL, Math.min(MAX_AUTO_LEVEL, MAX_AUTO_LEVEL - fullDaysRemaining))
}

export function weeklyResetAt(unified = {}, now = Date.now()) {
  const header = headerWindowOrEmpty(unified, '7d', { now })
  const headerReset = header.reset ?? header.resets_at ?? null
  if (parseResetMs(headerReset) > now) return headerReset

  const official = officialWindow(unified, '7d')
  const officialReset = official.reset ?? official.resets_at ?? null
  return parseResetMs(officialReset) > now ? officialReset : null
}

export function resolveCredentialScheduleLevel({
  vm = null,
  manualLevel,
  unified = {},
  resetAt,
  now = Date.now(),
} = {}) {
  const manual = manualLevel === undefined ? manualScheduleLevelOf(vm) : normalizedManualLevel(manualLevel)
  if (manual != null) return { level: manual, mode: 'manual' }
  const effectiveReset = resetAt === undefined ? weeklyResetAt(unified, now) : resetAt
  return { level: automaticScheduleLevel(effectiveReset, now), mode: 'auto' }
}
