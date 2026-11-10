/** Asynchronous Engine API memory raise, shared by local and SSH-hosted slots. */
import { slotHost } from './slot-host.mjs'
import { containerName } from './vm-runtime.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { memoryMiB, slotMemory, validateVmConfigPatch, VM_MEMORY_OPTIONS } from './machine-spec.mjs'
import { patchVmRecord } from './vm-registry.mjs'
import {
  execCapture,
  inspectContainerOrNull,
  updateContainerMemory,
  withDockerDeadline,
} from '../cluster/docker-remote.mjs'

export function formatDockerMemoryBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return null
  const gi = 1024 ** 3
  const mi = 1024 ** 2
  if (n % gi === 0) return `${n / gi}g`
  if (n % mi === 0) return `${n / mi}m`
  return `${Math.max(1, Math.round(n / mi))}m`
}

export function sameMemoryLimit(a, b) {
  return (
    String(a || '')
      .trim()
      .toLowerCase() ===
    String(b || '')
      .trim()
      .toLowerCase()
  )
}

/** cgroup v1「无上限」哨兵（与 Linux PAGE_COUNTER_MAX 同量级） */
const CGROUP_V1_UNLIMITED = 9223372036854771712

export function parseCgroupMemoryLimit(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { kind: 'unreadable' }
  if (text.toLowerCase() === 'max') return { kind: 'unlimited' }
  if (/^\d+$/.test(text)) {
    try {
      const big = BigInt(text)
      if (big >= BigInt(CGROUP_V1_UNLIMITED) - 1024n) return { kind: 'unlimited' }
      const bytes = Number(big)
      if (!Number.isSafeInteger(bytes) || bytes < 0) return { kind: 'unreadable' }
      return { kind: 'limited', bytes }
    } catch {
      return { kind: 'unreadable' }
    }
  }
  return { kind: 'unreadable' }
}

export async function readContainerCgroupMemoryLimit(_vm, containerId, connect) {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const result = await execCapture(connect, containerId, ['cat', file])
      if (result.exitCode !== 0) continue
      const parsed = parseCgroupMemoryLimit(result.stdout)
      if (parsed.kind !== 'unreadable') return parsed
    } catch {
      // Missing v2 files are normal on cgroup v1. Neither read may claim success.
    }
  }
  return { kind: 'unreadable' }
}

export async function inspectDockerContainerMemory(vm, { connect, id = containerName(vm?.id) } = {}) {
  try {
    connect ||= slotHost(vm).dockerApi()
    const data = await withDockerDeadline(connect, (c) => inspectContainerOrNull(c, id))
    if (!data) return { ok: false, code: 'container_not_found', message: '容器不存在' }
    const bytes = data.HostConfig?.Memory
    const swapBytes = data.HostConfig?.MemorySwap
    if (
      !/^[a-f0-9]{64}$/.test(data.Id) ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      !Number.isSafeInteger(swapBytes) ||
      swapBytes < -1 ||
      typeof data.State?.Running !== 'boolean'
    ) {
      return { ok: false, code: 'container_memory_unreadable', message: '无法读取容器身份或内存上限' }
    }
    return {
      ok: true,
      id: data.Id,
      memory: formatDockerMemoryBytes(bytes),
      bytes,
      swapBytes,
      running: data.State.Running,
    }
  } catch (error) {
    return { ok: false, code: 'container_inspect_failed', message: error.message }
  }
}

// Never shrink a running container after a raise: it may already use the new
// allowance. Restoring only a changed swap value (no memory shrink) is bounded,
// and is called a rollback only after a fresh inspect confirms both raw values.
async function failAfterUpdate(vm, connect, before, observed, failure, updateUncertain = false) {
  const result = {
    ok: false,
    ...failure,
    config_unchanged: Object.hasOwn(failure, 'config_unchanged') ? failure.config_unchanged : true,
    before_memory: before.memory,
    before_swap_bytes: before.swapBytes,
    container_memory: observed?.ok ? observed.memory : null,
    observed_memory_swap: observed?.ok ? observed.swapBytes : null,
    application_state: 'unknown',
    rollback_attempted: false,
    rollback_succeeded: false,
  }
  if (!observed?.ok || observed.id !== before.id) {
    result.message += ' 容器实际限额未知；配置未确认，请先核对，勿盲目重试。'
    return result
  }
  if (updateUncertain) {
    result.message += ' 更新请求可能仍在 Docker 端执行；当前读回值不能证明最终未变，不再修改限额，请稍后核对。'
    return result
  }
  if (observed.bytes === before.bytes && observed.swapBytes === before.swapBytes) {
    result.application_state = 'unchanged'
    return result
  }
  result.application_state = 'applied-unverified'
  if (
    observed.bytes > before.bytes ||
    observed.swapBytes === 0 ||
    (before.swapBytes !== -1 && (observed.swapBytes === -1 || observed.swapBytes > before.swapBytes))
  ) {
    result.message += ' 容器限额已提高，但核验或保存未完成；未强制收缩内存或 swap 以避免 OOM，请核对后重试。'
    return result
  }
  result.rollback_attempted = true
  try {
    await updateContainerMemory(connect, before.id, { memory: before.bytes, memorySwap: before.swapBytes })
  } catch {
    // A lost response can still mean the rollback was applied. Read it back.
  }
  const restored = await inspectDockerContainerMemory(vm, { connect, id: before.id })
  result.rollback_succeeded =
    restored.ok &&
    restored.id === before.id &&
    restored.bytes === before.bytes &&
    restored.swapBytes === before.swapBytes
  result.application_state = result.rollback_succeeded ? 'unchanged' : restored.ok ? 'applied-unverified' : 'unknown'
  result.container_memory = restored.ok ? restored.memory : null
  result.observed_memory_swap = restored.ok ? restored.swapBytes : null
  result.message += result.rollback_succeeded ? ' 已复查确认恢复原限额。' : ' 恢复结果未确认，请手动核对容器限额。'
  return result
}

export function validateDockerMemoryRaise(vm, requestedMemory, routing) {
  if (isKvmRuntime(vm)) {
    return {
      ok: false,
      code: 'kvm_memory_raise_forbidden',
      message: 'KVM 槽位不支持在线调整 Docker 内存',
    }
  }
  const checked = validateVmConfigPatch({ memory: requestedMemory })
  if (!checked.ok) {
    return { ok: false, code: 'invalid_memory', message: checked.error }
  }
  const target = String(requestedMemory).trim().toLowerCase()
  const configured = slotMemory(vm, routing)
  const configuredMiB = memoryMiB(configured)
  const targetMiB = memoryMiB(target)
  if (targetMiB <= configuredMiB) {
    return {
      ok: false,
      code: 'memory_not_increased',
      message: `新内存须高于当前配置 ${configured}（可选：${VM_MEMORY_OPTIONS.join('、')}）`,
      current: configured,
      requested: target,
    }
  }
  return { ok: true, memory: target, previous: configured }
}

export async function raiseDockerSlotMemory(projectRoot, vm, requestedMemory, { routing, connect } = {}) {
  const validated = validateDockerMemoryRaise(vm, requestedMemory, routing)
  if (!validated.ok) return validated
  try {
    connect ||= slotHost(vm).dockerApi()
  } catch (error) {
    return { ok: false, code: 'container_inspect_failed', message: error.message }
  }
  const before = await inspectDockerContainerMemory(vm, { connect })
  if (!before.ok) return before
  if (!before.running) return { ok: false, code: 'container_not_running', message: '容器未运行，无法验证在线扩容' }
  if (before.swapBytes === 0)
    return { ok: false, code: 'memory_swap_unrestorable', message: '原 swap 为默认值 0，无法可靠恢复，未修改限额' }
  const mem = validated.memory
  const requestedBytes = memoryMiB(mem) * 1024 ** 2
  if (before.bytes > requestedBytes)
    return {
      ok: false,
      code: 'live_memory_not_increased',
      message: '实际容器限额高于请求值，拒绝降低内存',
      container_memory: before.memory,
    }
  let warnings = []
  let updateError
  if (before.bytes !== requestedBytes || before.swapBytes !== requestedBytes) {
    try {
      // Keep existing policy: total memory+swap equals memory (swap disabled).
      ;({ warnings } = await updateContainerMemory(connect, before.id, {
        memory: requestedBytes,
        memorySwap: requestedBytes,
      }))
    } catch (error) {
      updateError = error
    }
  }
  // Fresh deadline, even when the update response was lost. No blind retry.
  let observed = await inspectDockerContainerMemory(vm, { connect, id: before.id })
  const fail = (code, message, extra = {}) =>
    failAfterUpdate(
      vm,
      connect,
      before,
      observed,
      { code, message, requested: mem, ...extra },
      !!updateError &&
        updateError.code !== 'docker_api_error' &&
        (!observed.ok || observed.bytes !== requestedBytes || observed.swapBytes !== requestedBytes),
    )
  if (!observed.ok || observed.id !== before.id) return fail('container_inspect_failed', '扩容后无法核对原容器')
  if (observed.bytes !== requestedBytes || observed.swapBytes !== requestedBytes) {
    return fail(
      updateError ? 'docker_update_failed' : 'memory_diverged',
      updateError?.message || '容器内存或 swap 与请求不一致，未写入配置',
    )
  }
  if (!observed.running) return fail('container_not_running', '扩容核验期间容器停止，未写入配置')
  const cgroup = await readContainerCgroupMemoryLimit(vm, before.id, connect)
  if (cgroup.kind !== 'limited' || cgroup.bytes !== requestedBytes) {
    return fail(
      cgroup.kind === 'limited' ? 'cgroup_memory_diverged' : 'cgroup_memory_unverified',
      '容器实际 cgroup 内存上限未确认，未写入配置',
    )
  }
  // Recheck after exec as well: deletion, stop or external limit changes must
  // not produce a successful config write. The existing caller owns the VM lock.
  observed = await inspectDockerContainerMemory(vm, { connect })
  if (
    !observed.ok ||
    observed.id !== before.id ||
    !observed.running ||
    observed.bytes !== requestedBytes ||
    observed.swapBytes !== requestedBytes
  ) {
    return fail('container_changed', '核验期间容器状态或限额发生变化，未写入配置')
  }
  let saved
  try {
    saved = patchVmRecord(projectRoot, vm.id, (record) => ({
      machine: { ...(record.machine || {}), memory: mem },
      ...(record.runtime && typeof record.runtime === 'object' ? { runtime: { ...record.runtime, memory: mem } } : {}),
    }))
  } catch {
    // Atomic rename / credential mirror notification can throw after a write.
    // Do not promise that the config is unchanged when its commit is unknown.
    return fail('vm_config_write_failed', '保存内存配置失败，配置写入状态需核对', { config_unchanged: null })
  }
  if (!saved) return fail('vm_not_found', 'vm not found')
  return { ok: true, memory: mem, previous: validated.previous, container_memory: mem, warnings, vm: saved }
}
