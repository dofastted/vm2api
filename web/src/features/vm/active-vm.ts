import type { Vm } from '@/types/panel-vm'
import { accountUsable } from '@/lib/vm-status'

/** `vms/active.json` 指向的槽位；与进程是否在跑、调度是否开启无关。 */
export function isActiveVmPointer(vm: Vm | undefined): boolean {
  return vm?.active === true
}

function slotProcessUp(vm: Vm): boolean {
  const s = String(vm.status || '').toLowerCase()
  if (s === 'stopped' || s === 'dead' || s === 'disabled') return false
  if (!vm.has_token) return false
  return s === 'running' || s === 'ok' || !s
}

/** 可接管活跃指针的其它槽：已开启调度且凭证仍可用。 */
export function activeVmReplacementCandidates(
  vms: Vm[],
  excludeId: string
): Vm[] {
  return vms.filter(
    (v) =>
      v.id !== excludeId &&
      v.schedulable !== false &&
      accountUsable(v)
  )
}

/** 删除当前活跃槽时默认切过去的候选：优先运行中、调度在池的槽。 */
export function pickActiveVmReplacement(
  vms: Vm[],
  excludeId: string
): Vm | null {
  const candidates = activeVmReplacementCandidates(vms, excludeId)
  if (!candidates.length) return null
  return candidates.slice().sort((a, b) => {
    const score = (vm: Vm) => {
      let s = 0
      if (slotProcessUp(vm)) s += 4
      if (vm.schedule_state === 'on') s += 2
      return s
    }
    const d = score(b) - score(a)
    if (d) return d
    return String(a.id).localeCompare(String(b.id))
  })[0]
}

export type DeleteActiveVmPlan =
  | { kind: 'normal' }
  | { kind: 'sole_active' }
  | { kind: 'switch'; replacement: Vm }
  | { kind: 'blocked' }

/** 删除确认框：当前槽仍占 active.json 时的文案与是否允许确认。 */
export function planDeleteActiveVm(target: Vm, vms: Vm[]): DeleteActiveVmPlan {
  if (!isActiveVmPointer(target)) return { kind: 'normal' }
  const others = vms.filter((v) => v.id !== target.id)
  if (!others.length) return { kind: 'sole_active' }
  const replacement = pickActiveVmReplacement(vms, target.id)
  if (replacement) return { kind: 'switch', replacement }
  return { kind: 'blocked' }
}
