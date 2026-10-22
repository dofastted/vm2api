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

/** Public node journal metadata only. Counts remain exact decimal strings. */
export function normalizeNodeReceipt(value) {
  const object = (item, required, optional = []) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(item)) ||
      required.some((key) => !Object.hasOwn(item, key)) ||
      Object.keys(item).some((key) => !required.includes(key) && !optional.includes(key))
    )
      invalid()
  }
  const count = (item) => {
    if (typeof item !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(item) || BigInt(item) > 9223372036854775807n)
      invalid()
    return item
  }
  object(value, ['id', 'usage_complete', 'usage'], ['model', 'speed', 'service_tier', 'stop_reason'])
  if (typeof value.id !== 'string' || !/^[a-f0-9]{32}$/.test(value.id) || typeof value.usage_complete !== 'boolean')
    invalid()
  const result = { id: value.id, usage_complete: value.usage_complete, usage: {} }
  for (const key of ['model', 'speed', 'service_tier', 'stop_reason']) {
    if (!Object.hasOwn(value, key)) continue
    const item = value[key]
    if (
      typeof item !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(item) ||
      item.length > (key === 'model' ? 256 : 64)
    )
      invalid()
    if (key === 'stop_reason' && !['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'].includes(item)) invalid()
    result[key] = item
  }
  const main = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
  object(value.usage, [], [...main, 'cache_creation', 'server_tool_use'])
  for (const key of main) if (Object.hasOwn(value.usage, key)) result.usage[key] = count(value.usage[key])
  for (const [key, fields] of [
    ['cache_creation', ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']],
    ['server_tool_use', ['web_search_requests']],
  ]) {
    if (!Object.hasOwn(value.usage, key)) continue
    const nested = value.usage[key]
    object(nested, [], fields)
    if (!Object.keys(nested).length) invalid()
    result.usage[key] = Object.fromEntries(Object.entries(nested).map(([field, item]) => [field, count(item)]))
  }
  if (value.usage_complete && (!result.model || main.some((key) => !Object.hasOwn(result.usage, key)))) invalid()
  return result
}
