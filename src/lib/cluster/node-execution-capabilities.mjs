import { isDeepStrictEqual } from 'node:util'
import { getDb } from '../db/database.mjs'
import { NodeManagementGrants } from './node-management-grants.mjs'
import { SlotgateClient } from '../transport/slotgate-client.mjs'
import { normalizeNodeFence } from '../core/node-execution-proof.mjs'

function failure(code = 'node_capability_unavailable') {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { code, status: 503 })
}

function freeze(value) {
  for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item)
  return Object.freeze(value)
}

function decimal(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
}

/**
 * Capture an independently verified PG launch receipt, never a VM JSON fence.
 * trustedNodes is the fixed, bootstrap-installed TLS/policy configuration.
 * The caller already owns a request/bootstrap/background database activity.
 */
export async function captureNodeExecution({
  db = getDb(),
  vmId,
  accountId,
  nodeId,
  trustedNodes,
  readLaunchReceipt,
  timeoutMs = 3000,
  signal,
}) {
  if (
    typeof vmId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(vmId) ||
    typeof accountId !== 'string' ||
    !accountId ||
    accountId.trim() !== accountId
  )
    throw failure()
  // The fixed trust configuration is captured before the first asynchronous
  // lookup, so an in-flight operation cannot inherit a later endpoint or pin.
  const nodes = structuredClone(trustedNodes)
  const read = readLaunchReceipt || ((input) => new NodeManagementGrants(db).readLaunchReceipt(input))
  // This method validates the private allocation -> publish -> launch chain
  // against its current maintenance epoch. It does not read live node state.
  const original = await read({ vmId, ...(nodeId === undefined ? {} : { nodeId }) })
  if (!original) throw failure()
  const receipt = structuredClone(original)
  const intent = receipt.intent
  const fixed =
    nodes instanceof Map
      ? nodes.get(intent?.node_id)
      : nodes && Object.hasOwn(nodes, intent?.node_id)
        ? nodes[intent.node_id]
        : null
  if (!fixed) throw failure()
  const configured = structuredClone(fixed)
  if (
    intent?.action !== 'launch' ||
    intent.vm_id !== vmId ||
    (nodeId !== undefined && intent.node_id !== nodeId) ||
    intent.preset_id !== 'claude-docker-v1' ||
    configured.presetId !== intent.preset_id ||
    !/^[a-f0-9]{64}$/.test(intent.policy_digest) ||
    configured.policyDigest !== intent.policy_digest ||
    !/^[a-f0-9]{64}$/.test(receipt.intent_digest) ||
    !decimal(intent.epoch) ||
    !decimal(receipt.manifest_revision) ||
    receipt.manifest_revision !== intent.manifest_revision ||
    receipt.manifest_revision !== intent.expected_manifest_revision ||
    !/^[a-f0-9]{64}$/.test(receipt.manifest_digest) ||
    receipt.manifest_digest !== intent.manifest_digest
  )
    throw failure()
  let fence
  try {
    fence = normalizeNodeFence(receipt.fence)
  } catch {
    throw failure()
  }
  const slotgate = {
    trusted: true,
    pgBindingReady: true,
    nodeId: intent.node_id,
    vmId,
    fence,
    manifest: { revision: receipt.manifest_revision, digest: receipt.manifest_digest },
    link: {
      address: configured.address,
      port: configured.port,
      token: configured.token,
      certSha256: configured.certSha256,
    },
  }
  let client
  try {
    client = new SlotgateClient(slotgate)
  } catch {
    throw failure()
  }
  const workerStatus = await client.health({ timeoutMs, signal })
  if (workerStatus.ok !== true) throw failure('node_health_unavailable')
  // Email is display metadata. Only the node-owned credential's account UUID
  // may authorize the scheduler's account, and conflicting identity is denied.
  if (
    workerStatus.credential?.account_uuid !== accountId ||
    (workerStatus.identity?.account_uuid !== undefined && workerStatus.identity.account_uuid !== accountId)
  )
    throw failure('node_account_mismatch')
  // A response to the old fence must not be relabeled after a concurrent PG
  // epoch/receipt change. No transaction or grant lock spans the TLS request.
  const after = await read({ vmId, ...(nodeId === undefined ? {} : { nodeId }) })
  if (!isDeepStrictEqual(receipt, after)) throw failure('node_capability_changed')
  return freeze({
    vmId,
    accountId,
    slotgate,
    nodeManifest: {
      revision: receipt.manifest_revision,
      digest: receipt.manifest_digest,
      presetId: intent.preset_id,
      policyDigest: intent.policy_digest,
      epoch: intent.epoch,
    },
    workerStatus,
  })
}
