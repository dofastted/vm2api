import type { Vm } from '@/types/panel-vm'
import { describe, expect, it, vi } from 'vitest'
import {
  assignableUsers,
  canReclaimVm,
  patchVmOwner,
  resolveOwnerUsername,
  rentedMark,
  vmOriginLabel,
} from './vm-owner'

vi.mock('@/lib/session', () => ({
  apiBase: () => '',
  clearSession: vi.fn(),
  hasSession: () => true,
  sessionToken: () => '',
}))

function vm(over: Partial<Vm> = {}): Vm {
  return { id: 'vm-1', ...over }
}

describe('canReclaimVm', () => {
  it('allows reclaim for admin-assigned slots', () => {
    expect(
      canReclaimVm(vm({ owner_user_id: 'u1', origin: 'admin_assigned' }))
    ).toBe(true)
  })

  it('allows reclaim for platform-origin slots that already have an owner', () => {
    expect(canReclaimVm(vm({ owner_user_id: 'u1', origin: 'platform' }))).toBe(
      true
    )
  })

  it('blocks reclaim for tenant-created VMs', () => {
    expect(
      canReclaimVm(vm({ owner_user_id: 'u1', origin: 'user_created' }))
    ).toBe(false)
  })

  it('blocks reclaim when no owner', () => {
    expect(canReclaimVm(vm({ owner_user_id: null, origin: 'platform' }))).toBe(
      false
    )
  })

  it('shows 出租中 only when a tenant is assigned', () => {
    expect(rentedMark('user-1')).toBe('出租中')
    expect(rentedMark(null)).toBeNull()
    expect(rentedMark('  ')).toBeNull()
  })
})

describe('vmOriginLabel', () => {
  it('maps known origins', () => {
    expect(vmOriginLabel('platform')).toBe('平台池')
    expect(vmOriginLabel('admin_assigned')).toBe('管理员分配')
    expect(vmOriginLabel('user_created')).toBe('租户自建')
  })
})

describe('resolveOwnerUsername', () => {
  it('falls back to platform pool label', () => {
    expect(resolveOwnerUsername(null, [])).toBe('平台池（未分配）')
  })

  it('resolves username from the user list', () => {
    expect(
      resolveOwnerUsername('u1', [
        {
          id: 'u1',
          username: 'alice',
          role: 'user',
          enabled: true,
        },
      ])
    ).toBe('alice')
  })
})

describe('assignableUsers', () => {
  it('keeps enabled tenant accounts only', () => {
    expect(
      assignableUsers([
        { id: 'a', username: 'z', role: 'user', enabled: true },
        { id: 'b', username: 'a', role: 'user', enabled: false },
        { id: 'c', username: 'admin', role: 'admin', enabled: true },
      ]).map((u) => u.id)
    ).toEqual(['a'])
  })
})

describe('patchVmOwner', () => {
  it('PATCHes the owner endpoint with encoded vm id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { vm: { id: 'x' } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await patchVmOwner('vm/with spaces', 'user-9')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/panel/vms/vm%2Fwith%20spaces/owner',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ user_id: 'user-9' }),
      })
    )

    await patchVmOwner('vm-1', null)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/panel/vms/vm-1/owner',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ user_id: null }),
      })
    )
    fetchMock.mockRestore()
  })
})
