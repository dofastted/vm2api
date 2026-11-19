import type { Vm } from '@/types/panel-vm'
import { isAntigravityVm, isClaudeVm, isCodexVm } from '@/lib/vm-kind'
import type { KeyGroupType, KeyLimitsDraft } from './key-payload'

export function vmsInGroup(vms: Vm[], group: KeyGroupType): Vm[] {
  if (group === 'openai') return vms.filter((vm) => isCodexVm(vm))
  if (group === 'anthropic') return vms.filter((vm) => isClaudeVm(vm))
  if (group === 'antigravity') return vms.filter((vm) => isAntigravityVm(vm))
  return []
}

/** Derive the visible selection without resetting other fields during a refetch. */
export function keyVmSelection(
  draft: KeyLimitsDraft,
  vms: Vm[],
  inventoryReady: boolean
) {
  const scoped =
    draft.category === 'oauth' &&
    (draft.group_type === 'anthropic' ||
      draft.group_type === 'openai' ||
      draft.group_type === 'antigravity')
  if (!scoped || !inventoryReady) {
    return { draft, removed: [] as string[], blocked: scoped }
  }
  const visible = new Set(vmsInGroup(vms, draft.group_type).map((vm) => vm.id))
  const allowed = [...new Set(draft.allowed_vms)].filter((id) =>
    visible.has(id)
  )
  return {
    draft: { ...draft, allowed_vms: allowed },
    removed: draft.allowed_vms.filter((id) => !visible.has(id)),
    blocked: allowed.length === 0,
  }
}
