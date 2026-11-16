import { describe, expect, it } from 'vitest'
import {
  WEEK_MS,
  resetRemainVisual,
  schedulingPriorityTextClass,
} from './vm-type-visual'

describe('type column visuals', () => {
  it.each([
    [1, 'text-slate-600 dark:text-slate-300'],
    [4, 'text-sky-800 dark:text-sky-300'],
    [8, 'text-blue-800 dark:text-blue-200'],
    [10, 'text-blue-800 dark:text-blue-200'],
    [11, 'text-muted-foreground'],
    [NaN, 'text-muted-foreground'],
  ])('uses a theme-aware text color for priority %s', (level, expected) => {
    expect(schedulingPriorityTextClass(level)).toBe(expected)
  })

  it('fills the reset bar while time remains and marks an overdue window', () => {
    const now = Date.parse('2026-11-15T00:00:00Z')
    const soon = resetRemainVisual(now + WEEK_MS / 10, now)
    const later = resetRemainVisual(now + WEEK_MS, now)
    const overdue = resetRemainVisual(now - 1000, now)
    expect(later.pct).toBe(100)
    expect(later.overdue).toBe(false)
    expect(soon.pct).toBe(10)
    expect(soon.color).not.toBe(later.color)
    expect(overdue).toMatchObject({ pct: 0, overdue: true })
  })
})
