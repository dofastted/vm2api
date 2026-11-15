import type { PanelUser } from '@/types/panel-users'
import type { Vm } from '@/types/panel-vm'
import { api } from '@/lib/api'

/** 是否允许收回进平台池（自建 VM 不可收回）。 */
export function canReclaimVm(vm: Vm): boolean {
  if (!String(vm.owner_user_id || '').trim()) return false
  return vm.origin !== 'user_created'
}

/** 列表第三行：有租户才显示，没有租户不占位。 */
export function rentedMark(
  ownerId: string | null | undefined
): '出租中' | null {
  return String(ownerId || '').trim() ? '出租中' : null
}

export function vmOriginLabel(origin: string | null | undefined): string {
  switch (origin) {
    case 'user_created':
      return '租户自建'
    case 'admin_assigned':
      return '管理员分配'
    case 'platform':
      return '平台池'
    default:
      return origin ? String(origin) : '平台池'
  }
}

export function resolveOwnerUsername(
  ownerId: string | null | undefined,
  users: PanelUser[] | undefined
): string {
  const id = String(ownerId || '').trim()
  if (!id) return '平台池（未分配）'
  const hit = users?.find((u) => u.id === id)
  return hit?.username || id
}

/** 分配下拉：启用中的租户账号。 */
export function assignableUsers(users: PanelUser[] | undefined): PanelUser[] {
  if (!users?.length) return []
  return users
    .filter((u) => u.enabled !== false && u.role === 'user')
    .sort((a, b) => a.username.localeCompare(b.username))
}

export type PatchVmOwnerResponse = { vm?: Vm }

export function patchVmOwner(vmId: string, user_id: string | null) {
  return api<PatchVmOwnerResponse>(
    `/api/panel/vms/${encodeURIComponent(vmId)}/owner`,
    {
      method: 'PATCH',
      body: JSON.stringify({ user_id }),
    }
  )
}
