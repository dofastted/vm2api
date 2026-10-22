import crypto from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { normalizeNodeFence } from './node-execution-proof.mjs'

function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw commandFailure()
}

const COMMAND_KEYS = [
  'action',
  'node_id',
  'vm_id',
  'allocation_id',
  'operation_id',
  'owner_id',
  'command_id',
  'epoch',
  'fence',
  'expected_manifest_revision',
  'manifest_revision',
  'payload_digest',
  'preset_id',
  'policy_digest',
  'manifest_digest',
]
const digestPattern = /^[a-f0-9]{64}$/
function isDigest(value) {
  return typeof value === 'string' && digestPattern.test(value)
}
function commandFailure(code = 'node_command_invalid') {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { code })
}
function exactShape(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw commandFailure()
}
export function normalizeVacantNodeFence(value) {
  exactShape(value, ['generation', 'incarnation', 'executor'])
  exactShape(value.executor, ['kind', 'node_boot_id'])
  if (
    (value.generation !== '1' && value.generation !== 1) ||
    typeof value.incarnation !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.incarnation) ||
    value.executor.kind !== '' ||
    value.executor.node_boot_id !== ''
  )
    throw commandFailure()
  // Initial allocation generation 1 is exactly representable in the existing Go JSON number wire format.
  return { generation: 1, incarnation: value.incarnation, executor: { kind: '', node_boot_id: '' } }
}
export function normalizeNodeManagementIntent(value) {
  exactShape(value, COMMAND_KEYS)
  for (const key of ['node_id', 'vm_id', 'allocation_id', 'operation_id', 'owner_id', 'command_id'])
    identifier(value[key])
  if (
    typeof value.epoch !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value.epoch) ||
    BigInt(value.epoch) > 9223372036854775807n ||
    value.manifest_revision !== '1' ||
    value.preset_id !== 'claude-docker-v1' ||
    !isDigest(value.policy_digest)
  )
    throw commandFailure()
  if (value.action === 'publish-initial') {
    if (value.expected_manifest_revision !== '0' || !isDigest(value.payload_digest) || value.manifest_digest !== '')
      throw commandFailure()
  } else if (value.action === 'launch') {
    if (value.expected_manifest_revision !== '1' || value.payload_digest !== '' || !isDigest(value.manifest_digest))
      throw commandFailure()
  } else throw commandFailure()
  return { ...value, fence: normalizeVacantNodeFence(value.fence) }
}
export function nodeManagementIntentDigest(intent) {
  return crypto
    .createHash('sha256')
    .update(
      [
        'slotgate-command-v1',
        intent.action,
        intent.node_id,
        intent.vm_id,
        intent.allocation_id,
        intent.operation_id,
        intent.owner_id,
        intent.command_id,
        intent.epoch,
        String(intent.fence.generation),
        intent.fence.incarnation,
        intent.expected_manifest_revision,
        intent.manifest_revision,
        intent.payload_digest,
        intent.preset_id,
        intent.policy_digest,
        intent.manifest_digest,
      ].join('\0'),
    )
    .digest('hex')
}
export function normalizeNodeManagementGrant(value) {
  exactShape(value, ['intent', 'intentDigest'])
  const intent = normalizeNodeManagementIntent(value.intent)
  if (value.intentDigest !== nodeManagementIntentDigest(intent)) throw commandFailure()
  return { intent, intentDigest: value.intentDigest }
}
export function normalizeNodeManagementReceipt(grant, value) {
  grant = normalizeNodeManagementGrant(grant)
  try {
    const launch = grant.intent.action === 'launch'
    exactShape(value, ['intent', 'intent_digest', 'manifest_revision', 'manifest_digest', ...(launch ? ['fence'] : [])])
    const intent = normalizeNodeManagementIntent(value.intent)
    if (
      !isDeepStrictEqual(intent, grant.intent) ||
      value.intent_digest !== grant.intentDigest ||
      value.manifest_revision !== '1' ||
      !isDigest(value.manifest_digest) ||
      (launch && value.manifest_digest !== intent.manifest_digest)
    )
      throw commandFailure()
    const result = {
      intent,
      intent_digest: value.intent_digest,
      manifest_revision: '1',
      manifest_digest: value.manifest_digest,
    }
    if (launch) {
      result.fence = normalizeNodeFence(value.fence)
      if (result.fence.generation !== '1' || result.fence.incarnation !== intent.fence.incarnation)
        throw commandFailure()
    }
    return result
  } catch {
    throw commandFailure('node_command_receipt_invalid')
  }
}
