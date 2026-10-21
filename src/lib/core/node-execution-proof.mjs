import { isDeepStrictEqual } from 'node:util'

function invalid() {
  throw Object.assign(new Error('invalid captured node execution identity'), { code: 'invalid_node_execution' })
}

function shape(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid()
}

function identifier(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    value.length > 256 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    invalid()
  return value
}

function generation(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) invalid()
    value = String(value)
  } else if (typeof value === 'bigint') value = String(value)
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) invalid()
  return value
}

export function normalizeNodeFence(value) {
  shape(value, ['generation', 'incarnation', 'executor'])
  const executor = value.executor
  shape(executor, ['kind', 'node_boot_id', 'container_id', 'docker_daemon_id', 'started_at'])
  if (
    executor.kind !== 'container' ||
    typeof executor.container_id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(executor.container_id) ||
    typeof executor.started_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(executor.started_at) ||
    !Number.isFinite(Date.parse(executor.started_at))
  )
    invalid()
  const calendar = Date.parse(executor.started_at.slice(0, 19) + 'Z')
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 19) !== executor.started_at.slice(0, 19))
    invalid()
  return {
    generation: generation(value.generation),
    incarnation: identifier(value.incarnation),
    executor: {
      kind: 'container',
      node_boot_id: identifier(executor.node_boot_id),
      container_id: executor.container_id,
      docker_daemon_id: identifier(executor.docker_daemon_id),
      started_at: executor.started_at,
    },
  }
}

export function normalizeNodeBinding(value) {
  shape(value, ['protocol', 'nodeId', 'vmId', 'kind', 'fence'])
  if (
    value.protocol !== 'KSG2' ||
    value.kind !== 'kernel' ||
    typeof value.vmId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(value.vmId)
  )
    invalid()
  return {
    protocol: 'KSG2',
    nodeId: identifier(value.nodeId),
    vmId: value.vmId,
    kind: 'kernel',
    fence: normalizeNodeFence(value.fence),
  }
}

export function sameNodeBinding(left, right) {
  return isDeepStrictEqual(normalizeNodeBinding(left), normalizeNodeBinding(right))
}

export function normalizeNodeCommand(value, { requestId, nodeBinding }) {
  shape(value, ['id', 'fence', 'status', 'dispatched'])
  if (
    value.id !== requestId ||
    !['pending', 'unknown', 'completed', 'terminated'].includes(value.status) ||
    typeof value.dispatched !== 'boolean'
  )
    invalid()
  const fence = normalizeNodeFence(value.fence)
  if (!isDeepStrictEqual(fence, normalizeNodeBinding(nodeBinding).fence)) invalid()
  return { id: identifier(value.id), fence, status: value.status, dispatched: value.dispatched }
}

export function normalizeNodeCompletion(value, binding) {
  const command = normalizeNodeCommand(value, binding)
  if (command.status !== 'completed' || command.dispatched !== true) invalid()
  return command
}
