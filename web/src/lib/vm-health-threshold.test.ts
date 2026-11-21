import { describe, expect, it } from 'vitest'
import { SLOT_LABEL, slotState } from './vm-health'

describe('health threshold wording', () => {
  it('keeps five percent in the first band and thirty percent in the middle', () => {
    expect(slotState([95, 5])).toBe('ok')
    expect(slotState([94, 6])).toBe('slow')
    expect(slotState([70, 30])).toBe('slow')
    expect(slotState([69, 31])).toBe('down')
    expect(SLOT_LABEL.slow).toBe('错误率 >5% 且 ≤30%')
    expect(SLOT_LABEL.ok).toBe('错误率 ≤5%')
  })
})
