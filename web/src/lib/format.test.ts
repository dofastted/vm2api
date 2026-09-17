import { describe, expect, it } from 'vitest'
import { pct, remainPct, usedPctOf } from '@/lib/format'

describe('usedPctOf', () => {
  it('prefers Codex used_percent and does not scale it', () => {
    expect(
      usedPctOf(
        {
          utilization_5h: 0.06,
          utilization_7d: 0.34,
          codex_usage: {
            windows: [
              { id: '5h', used_percent: 6 },
              { id: '7d', used_percent: 34 },
            ],
          },
        },
        '5h'
      )
    ).toBe(6)
    expect(
      usedPctOf(
        {
          utilization_5h: 1,
          codex_usage: { windows: [{ id: '5h', used_percent: 1 }] },
        },
        '5h'
      )
    ).toBe(1)
  })

  it('falls back to utilization ratio', () => {
    expect(usedPctOf({ utilization_5h: 0.12, utilization_7d: 0.4 }, '7d')).toBe(
      40
    )
  })
})

describe('pct', () => {
  it('keeps leftover 0-100 numbers', () => {
    expect(pct(12)).toBe(12)
    expect(remainPct(12)).toBe(88)
  })

  it('treats 0-1 utilization as a fraction', () => {
    expect(pct(0.12)).toBe(12)
  })
})
