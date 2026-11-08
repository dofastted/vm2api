import { describe, expect, it } from 'vitest'
import { slotNameLabel } from './vm-kind'

describe('slotNameLabel', () => {
  it('hides a creation number when the slot has no account', () => {
    expect(slotNameLabel({ id: 'vm-01', name: '01' })).toBe('未绑定账号')
    expect(slotNameLabel({ id: 'vm-01', name: 'vm-01' })).toBe('未绑定账号')
  })

  it('keeps a custom label even before an account is bound', () => {
    expect(slotNameLabel({ id: 'vm-08', name: '测试槽' })).toBe('测试槽')
  })

  it('still shows the account email path for a numbered slot', () => {
    expect(
      slotNameLabel({ id: 'vm-01', name: '01', email: 'a@example.com' })
    ).toBe('01')
  })

  it('keeps a non-numeric slot id visible', () => {
    expect(slotNameLabel({ id: 'desk', name: 'desk' })).toBe('desk')
  })
})
