import { getVm, listVms } from './vm-registry.mjs'
import { slotHost } from './slot-host.mjs'
import { configuredIpv6Enabled } from './proxy-policy.mjs'
import { socksProxyFamily } from './socks-address.mjs'

/** Keep bridges/VMs intact. Stopping the helper closes existing proxy connections. */
export async function syncIpv6ProxyEgress(projectRoot, proxyPool, { nodeId, vms } = {}) {
  const results = []
  if (nodeId === undefined && !configuredIpv6Enabled()) {
    for (const proxy of proxyPool?.state?.proxies || []) {
      if (configuredIpv6Enabled()) break
      if (socksProxyFamily(proxy) !== 6) continue
      const result = await slotHost({ proxy }).setProxyEgressEnabled({ proxy }, projectRoot, false)
      results.push({ proxy_id: proxy.id, ok: result.ok, error: result.error || null })
    }
  }
  for (const summary of vms || listVms(projectRoot)) {
    if (nodeId !== undefined && summary.node_id !== nodeId) continue
    const vm = vms ? summary : getVm(projectRoot, summary.id)
    if (!vm || socksProxyFamily(vm.proxy) !== 6) continue
    const enabled = configuredIpv6Enabled()
    if (enabled && vm.status !== 'running') continue
    try {
      const host = slotHost(vm)
      let result = await host.setProxyEgressEnabled(vm, projectRoot, enabled)
      // Node operations may finish after another settings write; apply the current policy.
      const current = configuredIpv6Enabled()
      if (current !== enabled && (!current || vm.status === 'running')) {
        result = await host.setProxyEgressEnabled(vm, projectRoot, current)
      }
      results.push({ proxy_id: vm.proxy.id, vm_id: vm.id, ok: result.ok, error: result.error || null })
    } catch (error) {
      results.push({ proxy_id: vm.proxy.id, vm_id: vm.id, ok: false, error: error.code || error.message })
    }
  }
  return results
}
