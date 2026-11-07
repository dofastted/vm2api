import { describe, expect, it } from 'vitest'
import { concurrencyLabel, parseConcurrency } from './user-concurrency'

describe('user concurrency', () => {
  it('accepts integers within 0–1000 (0 = no cap)', () => {
    expect(parseConcurrency('0')).toBe(0)
    expect(parseConcurrency('1')).toBe(1)
    expect(parseConcurrency(' 20 ')).toBe(20)
    expect(parseConcurrency('1000')).toBe(1000)
  })

  it('rejects empty, fractional and out-of-range input', () => {
    for (const raw of ['', ' ', '-3', '1001', '2.5', 'abc']) {
      expect(parseConcurrency(raw)).toBeNull()
    }
  })

  it('labels admins and zero as unlimited', () => {
    expect(concurrencyLabel({ role: 'user', concurrency: 8 })).toBe('8')
    expect(concurrencyLabel({ role: 'super', concurrency: 5 })).toBe('5')
    expect(concurrencyLabel({ role: 'admin', concurrency: 5 })).toBe('不限')
    expect(concurrencyLabel({ role: 'user', concurrency: 0 })).toBe('不限')
  })
})
