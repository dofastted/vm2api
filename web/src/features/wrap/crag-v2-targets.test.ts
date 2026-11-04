import { describe, expect, it } from 'vitest'
import type { Vm } from '@/types/panel-vm'
import {
  cragV2BlockedReason,
  cragV2UpdateIds,
  slotPolicyFailure,
} from './crag-v2-targets'

function vm(partial: Partial<Vm> & { id: string }): Vm {
  return partial as Vm
}

describe('crag v2 update targets', () => {
  const vms = [
    vm({ id: 'local' }),
    vm({ id: 'gpt', family: 'codex' }),
    vm({ id: 'remote', node_id: 'node-1' }),
    vm({ id: 'kvm', runtime_type: 'kvm' }),
  ]

  it('skips Codex, cluster, and KVM, and keeps a local Docker slot', () => {
    expect(cragV2BlockedReason(vms[0])).toBe('')
    expect(cragV2BlockedReason(vms[1])).toMatch(/Codex/)
    expect(cragV2BlockedReason(vms[2])).toMatch(/集群/)
    expect(cragV2BlockedReason(vms[3])).toMatch(/KVM/)
    expect(cragV2UpdateIds(vms, [])).toEqual(['local'])
  })

  it('updates only the eligible slots inside a selection', () => {
    expect(cragV2UpdateIds(vms, ['kvm', 'local', 'missing'])).toEqual([
      'local',
    ])
    expect(cragV2UpdateIds(vms, ['gpt'])).toEqual([])
  })

  it('names a slot-policy failure for one id', () => {
    expect(
      slotPolicyFailure(
        { failed: [{ id: 'local', error: 'CRAG v2 package missing' }] },
        'local'
      )
    ).toBe('local（CRAG v2 package missing）')
    expect(slotPolicyFailure({ missing: ['gone'] }, 'gone')).toBe(
      'gone（不存在）'
    )
    expect(slotPolicyFailure({ failed: [] }, 'local')).toBe('')
  })
})
