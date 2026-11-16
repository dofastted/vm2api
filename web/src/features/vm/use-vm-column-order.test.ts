import { describe, expect, it } from 'vitest'
import { normalizeColumnOrder, VM_COLUMN_KEYS } from './use-vm-column-order'

describe('normalizeColumnOrder', () => {
  it('drops retired type / req keys from a stored order and keeps the rest', () => {
    expect(
      normalizeColumnOrder([
        'cost',
        'type',
        'vm',
        'req',
        'status',
        'sched',
        'usage',
      ])
    ).toEqual(['cost', 'vm', 'status', 'sched', 'usage'])
  })

  it('fills missing keys and survives garbage', () => {
    expect(normalizeColumnOrder(['usage'])).toEqual([
      'usage',
      'vm',
      'sched',
      'status',
      'cost',
    ])
    expect(normalizeColumnOrder('nope')).toEqual([...VM_COLUMN_KEYS])
  })
})
