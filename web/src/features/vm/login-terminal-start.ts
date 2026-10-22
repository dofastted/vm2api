import type { Vm } from '@/types/panel-vm'
import { api } from '@/lib/api'

/** Empty import slots are created stopped so the operator can choose their exit. */
export async function prepareLoginTerminal(vm: Vm): Promise<void> {
  const hasExit = vm.can_import_credential ?? !!(vm.proxy?.host || vm.proxy_id)
  if (!hasExit) throw new Error('请先为槽位绑定出口，再打开官方登录终端')

  // Credential presence is unrelated to power: this terminal obtains the first grant.
  if (vm.status?.toLowerCase() === 'running') return

  await api(`/api/panel/vms/${encodeURIComponent(vm.id)}/start`, {
    method: 'POST',
  })
}
