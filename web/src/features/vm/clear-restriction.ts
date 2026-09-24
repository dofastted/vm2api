import type { Vm } from '@/types/panel-vm'
import { api } from '@/lib/api'
import { vmCircuit } from '@/lib/vm-status'

/**
 * 「清冷却」一个按钮收口：清运行时冷却；熔断未关闭时一并重置熔断。
 * 操作员不需要分辨槽位是在冷却还是在熔断。
 */
export async function clearVmRestriction(vm: Vm): Promise<void> {
  const id = encodeURIComponent(vm.id)
  await api(`/api/panel/vms/${id}/cooldown/clear`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  if (vmCircuit(vm)) {
    await api(`/api/panel/vms/${id}/circuit/reset`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
  }
}
