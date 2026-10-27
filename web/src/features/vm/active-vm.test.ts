import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  activeVmReplacementCandidates,
  pickActiveVmReplacement,
  planDeleteActiveVm,
} from './active-vm'

function vm(id: string, over: Partial<Vm> = {}): Vm {
  return {
    id,
    has_token: true,
    has_refresh: true,
    schedulable: true,
    schedule_state: 'on',
    status: 'running',
    ...over,
  }
}

describe('active vm replacement', () => {
  it('skips non-schedulable and dead-credential slots', () => {
    const rows = [
      vm('active', { active: true }),
      vm('good'),
      vm('off', { schedulable: false }),
      vm('bad', {
        availability: {
          key: 'bad',
          usable: false,
          text: '无效',
          reason: 'oauth_revoked',
        },
        refresh_error: 'oauth_revoked',
      }),
    ]
    expect(activeVmReplacementCandidates(rows, 'active').map((v) => v.id)).toEqual(
      ['good']
    )
    expect(pickActiveVmReplacement(rows, 'active')?.id).toBe('good')
  })

  it('prefers running in-pool slots', () => {
    const rows = [
      vm('active', { active: true }),
      vm('stopped', { status: 'stopped' }),
      vm('live', { status: 'running', schedule_state: 'on' }),
    ]
    expect(pickActiveVmReplacement(rows, 'active')?.id).toBe('live')
  })

  it('plans switch-and-delete when a replacement exists', () => {
    const target = vm('a', { active: true })
    const plan = planDeleteActiveVm(target, [target, vm('b')])
    expect(plan.kind).toBe('switch')
    if (plan.kind === 'switch') expect(plan.replacement.id).toBe('b')
  })

  it('blocks delete when active with no replacement', () => {
    const target = vm('a', { active: true, schedulable: false })
    const plan = planDeleteActiveVm(target, [
      target,
      vm('b', { schedulable: false }),
    ])
    expect(plan.kind).toBe('blocked')
  })
})
