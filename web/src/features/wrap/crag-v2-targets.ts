import type { Vm } from '@/types/panel-vm'
import { isCodexVm } from '@/lib/vm-kind'
import { isRemoteVm } from '@/features/vm/placement'

export function cragV2BlockedReason(vm: Vm): string {
  if (isCodexVm(vm)) return 'Codex 槽不切换 Claude 内核'
  if (isRemoteVm(vm)) return '集群槽不运行 CRAG v2'
  if (vm.runtime_type === 'kvm') return 'KVM 槽不运行 CRAG v2'
  return ''
}

/** Eligible ids: the selection, or every VM when nothing is selected. */
export function cragV2UpdateIds(vms: Vm[], selected: string[]): string[] {
  const source = selected.length
    ? selected.flatMap((id) => {
        const vm = vms.find((item) => item.id === id)
        return vm ? [vm] : []
      })
    : vms
  return source.filter((vm) => !cragV2BlockedReason(vm)).map((vm) => vm.id)
}

export function slotPolicyFailure(
  report: {
    missing?: string[]
    failed?: { id?: string; code?: string; error?: string }[]
  },
  id: string
): string {
  if (report.missing?.includes(id)) return `${id}（不存在）`
  const row = report.failed?.find((item) => item.id === id)
  if (!row) return ''
  const reason = String(row.error || row.code || '失败').trim() || '失败'
  return `${id}（${reason}）`
}
