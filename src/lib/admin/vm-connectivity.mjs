import { vmNodeReady } from '../cluster/placement.mjs'
import { kernelFaults } from '../transport/rust-kernel-client.mjs'

/** Read the same node path and terminal kernel fault used by the scheduler.
 * Unknown runtime state is never evidence of either failure or recovery.
 */
export function snapshotVmConnectivity(vms, { nodeReady = vmNodeReady, faults = kernelFaults } = {}) {
  return vms.map((vm) => {
    const status = String(vm.status || '').toLowerCase()
    const ignored = vm.schedule_off === true || vm.schedule_hold?.reason === 'maintenance' || status === 'disabled'
    let reason = null
    let detail = null
    if (!ignored) {
      if (['stopped', 'dead', 'error'].includes(status)) reason = `runtime_${status}`
      else if (!nodeReady(vm)) reason = 'node_offline'
      else if (faults.has(vm.id)) {
        reason = 'kernel_faulted'
        detail = String(faults.get(vm.id))
      }
    }
    return {
      id: vm.id,
      node_id: vm.node_id || null,
      monitored: !ignored,
      online: ignored ? null : reason ? false : ['running', 'ok'].includes(status) ? true : null,
      reason,
      detail,
    }
  })
}
