import { describe, expect, it } from 'vitest'
import {
  WEEK_MS,
  depthStyle,
  resetRemainVisual,
  scaleT,
} from './vm-type-visual'

describe('type column visuals', () => {
  it('maps the low end to a lighter chip than the high end', () => {
    const light = depthStyle(0)
    const deep = depthStyle(1)
    expect(scaleT(1, 1, 10)).toBe(0)
    expect(scaleT(10, 1, 10)).toBe(1)
    expect(scaleT(1, 1, 100)).toBe(0)
    expect(scaleT(100, 1, 100)).toBe(1)
    expect(light.backgroundColor).not.toBe(deep.backgroundColor)
    expect(light.color).not.toBe(deep.color)
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
