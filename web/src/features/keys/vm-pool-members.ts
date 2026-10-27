/**
 * Membership rules for named slot pools on the keys page.
 *
 * A slot belongs to at most one pool (the server has a unique index), and a
 * slot can be deleted while its membership row survives. The editor therefore
 * only offers free slots and saves only slots that still exist; otherwise a
 * single stale id made every save fail with "槽位 X 不存在".
 */
import type { VmPool } from '@/types/panel-keys'
import type { Vm } from '@/types/panel-vm'

/** vm id → the other pool that already holds it. */
export function poolOwners(
  pools: VmPool[],
  selfPoolId?: string
): Map<string, VmPool> {
  const owners = new Map<string, VmPool>()
  for (const pool of pools) {
    if (selfPoolId && pool.id === selfPoolId) continue
    for (const vmId of pool.vm_ids) owners.set(vmId, pool)
  }
  return owners
}

/** Members whose slot record no longer exists. */
export function missingMemberIds(ids: string[], vms: Vm[]): string[] {
  const known = new Set(vms.map((vm) => vm.id))
  return ids.filter((id) => !known.has(id))
}

/** Members that may be saved: slot still exists and no other pool holds it. */
export function saveableMemberIds(
  ids: string[],
  vms: Vm[],
  owners: Map<string, VmPool>
): string[] {
  const known = new Set(vms.map((vm) => vm.id))
  return ids.filter((id) => known.has(id) && !owners.has(id))
}
