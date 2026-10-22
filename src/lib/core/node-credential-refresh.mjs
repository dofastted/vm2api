import crypto from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { normalizeNodeFence } from './node-execution-proof.mjs'
export function refreshFailure(code = 'node_refresh_invalid') {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { code })
}
const keys = [
  'action',
  'node_id',
  'vm_id',
  'allocation_id',
  'operation_id',
  'owner_id',
  'command_id',
  'account_id',
  'bg_task_key',
  'bg_execution_id',
  'bg_owner_id',
  'epoch',
  'fence',
  'expected_credential_generation',
  'manifest_revision',
  'manifest_digest',
  'preset_id',
  'policy_digest',
  'force',
]
const digest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
function exact(v, required, optional = []) {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => !required.includes(k) && !optional.includes(k))
  )
    throw refreshFailure()
}
function decimal(v, positive = true) {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(v) ||
    BigInt(v) > 9223372036854775807n ||
    (positive && v === '0')
  )
    throw refreshFailure()
  return v
}
export function normalizeRefreshIntent(v) {
  exact(v, keys)
  for (const k of [
    'node_id',
    'vm_id',
    'allocation_id',
    'operation_id',
    'owner_id',
    'command_id',
    'account_id',
    'bg_execution_id',
    'bg_owner_id',
  ])
    if (typeof v[k] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v[k])) throw refreshFailure()
  if (
    v.action !== 'credential-refresh' ||
    v.bg_task_key !== `oauth-refresh:claude:${v.account_id}` ||
    v.manifest_revision !== '1' ||
    v.preset_id !== 'claude-docker-v1' ||
    !digest(v.manifest_digest) ||
    !digest(v.policy_digest) ||
    typeof v.force !== 'boolean'
  )
    throw refreshFailure()
  decimal(v.epoch)
  decimal(v.expected_credential_generation)
  if (BigInt(v.expected_credential_generation) === 9223372036854775807n) throw refreshFailure()
  const fence = normalizeNodeFence(v.fence)
  if (fence.executor.kind !== 'container') throw refreshFailure()
  return { ...v, fence }
}
export function refreshIntentDigest(v) {
  const i = normalizeRefreshIntent(v),
    e = i.fence.executor
  return crypto
    .createHash('sha256')
    .update(
      [
        'slotgate-refresh-v1',
        ...keys.slice(0, 12).map((k) => i[k]),
        i.fence.generation,
        i.fence.incarnation,
        e.kind,
        e.node_boot_id,
        e.container_id,
        e.docker_daemon_id,
        e.started_at,
        i.expected_credential_generation,
        i.manifest_revision,
        i.manifest_digest,
        i.preset_id,
        i.policy_digest,
        i.force ? '1' : '0',
      ].join('\0'),
    )
    .digest('hex')
}
export function normalizeRefreshGrant(g) {
  exact(g, ['intent', 'intentDigest'])
  const intent = normalizeRefreshIntent(g.intent)
  if (g.intentDigest !== refreshIntentDigest(intent)) throw refreshFailure()
  return { intent, intentDigest: g.intentDigest }
}
export function normalizeRefreshReceipt(grant, value) {
  const g = normalizeRefreshGrant(grant)
  exact(value, ['intent', 'intent_digest', 'finished', 'ok', 'status', 'refreshed', 'credential'], ['error_code'])
  const intent = normalizeRefreshIntent(value.intent)
  if (
    !isDeepStrictEqual(intent, g.intent) ||
    value.intent_digest !== g.intentDigest ||
    value.finished !== true ||
    typeof value.ok !== 'boolean' ||
    typeof value.refreshed !== 'boolean' ||
    !Number.isInteger(value.status)
  )
    throw refreshFailure()
  const c = value.credential
  exact(
    c,
    ['generation', 'expires_at', 'account_uuid', 'has_access', 'has_refresh', 'needs_refresh'],
    ['org_uuid', 'email'],
  )
  decimal(c.generation)
  decimal(c.expires_at, false)
  if (
    c.account_uuid !== intent.account_id ||
    ['has_access', 'has_refresh', 'needs_refresh'].some((k) => typeof c[k] !== 'boolean')
  )
    throw refreshFailure()
  for (const k of ['org_uuid', 'email'])
    if (c[k] !== undefined && (typeof c[k] !== 'string' || c[k].length > 512 || /[\x00-\x1f\x7f]/.test(c[k])))
      throw refreshFailure()
  if (value.ok) {
    if (
      value.status !== 200 ||
      value.error_code !== undefined ||
      !c.has_access ||
      (value.refreshed
        ? BigInt(c.generation) <= BigInt(intent.expected_credential_generation)
        : c.generation !== intent.expected_credential_generation)
    )
      throw refreshFailure()
  } else if (
    value.status < 400 ||
    value.status > 599 ||
    value.error_code !== 'credential_refresh_rejected' ||
    value.refreshed ||
    c.generation !== intent.expected_credential_generation
  )
    throw refreshFailure()
  return { ...value, intent, credential: { ...c } }
}
