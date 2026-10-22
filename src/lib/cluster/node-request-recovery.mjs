import { normalizeNodeBinding } from '../core/node-execution-proof.mjs'
import { SlotgateClient } from '../transport/slotgate-client.mjs'

/** Historical status uses the PG job's original fence and the bootstrap TLS trust. */
export function createNodeRecoveryReader(trustedNodes) {
  const nodes = structuredClone(trustedNodes)
  return async ({ requestId, nodeBinding }) => {
    const binding = normalizeNodeBinding(nodeBinding)
    const link = Object.hasOwn(nodes, binding.nodeId) ? nodes[binding.nodeId] : null
    if (!link) throw Object.assign(new Error('original node is not trusted'), { code: 'node_recovery_unavailable' })
    const client = new SlotgateClient({
      trusted: true,
      pgBindingReady: true,
      nodeId: binding.nodeId,
      vmId: binding.vmId,
      fence: binding.fence,
      link,
    })
    return client.recoveryStatus(requestId, { timeoutMs: 3000 })
  }
}
