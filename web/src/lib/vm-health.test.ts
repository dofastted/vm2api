import { describe, expect, it } from 'vitest'
import { fmtHealthPct, healthSummary, healthTone, slotState } from './vm-health'

describe('vm-health', () => {
  it('slotState follows error-rate bands; empty slot is none', () => {
    expect(slotState([0, 0])).toBe('none')
    expect(slotState([100, 5])).toBe('ok')
    expect(slotState([10, 2])).toBe('slow')
    expect(slotState([1, 9])).toBe('down')
  })

  it('no requests → no health, all slots none', () => {
    const s = healthSummary(null)
    expect(s.pct).toBeNull()
    expect(s.tone).toBe('none')
    expect(s.slots).toHaveLength(48)
    expect(s.slots.every((x) => x === 'none')).toBe(true)
  })

  it('success rate is ok / (ok + err) across slots', () => {
    const raw = Array.from({ length: 48 }, (_, i) =>
      i === 47 ? [9, 1] : i === 10 ? [90, 0] : [0, 0]
    )
    const s = healthSummary(raw)
    expect(s.req).toBe(100)
    expect(s.err).toBe(1)
    expect(s.pct).toBe(99)
    expect(s.tone).toBe('ok')
    expect(s.active).toBe(2)
    expect(s.slots[47]).toBe('slow')
  })

  it('pads short input on the old side and drops garbage', () => {
    const s = healthSummary([[1, 1], 'x', [-3, 2]])
    expect(s.slots).toHaveLength(48)
    expect(s.slots[45]).toBe('down')
    expect(s.slots[46]).toBe('none')
    expect(s.err).toBe(3)
  })

  it('tone bands and formatting', () => {
    expect(healthTone(96)).toBe('caution')
    expect(healthTone(85)).toBe('warn')
    expect(healthTone(50)).toBe('bad')
    expect(fmtHealthPct(100)).toBe('100%')
    expect(fmtHealthPct(94.66)).toBe('94.7%')
    expect(fmtHealthPct(null)).toBe('—')
  })
})
