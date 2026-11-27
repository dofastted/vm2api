/**
 * In-place memory resize for KVM slots on the control-plane host (no node_id).
 *
 * Same cold flow as the remote migration (hold, drain, stop, boot, verify, roll back),
 * but nothing is copied: the stopped container is renamed and kept as the rollback
 * copy, and the replacement boots on the *exact* base image the slot already ran
 * (pinned by image ID on vm.machine.kvm_image_id), so the qcow overlay never gets a
 * different backing image. Guest identity (MAC, disk serial, SMBIOS, hostname,
 * machine-id, vCPU, disk size) must come out unchanged; only the memory differs.
 */
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { containerName } from './vm-runtime.mjs'
import { listVms } from './vm-registry.mjs'
import { slotMemory } from './machine-spec.mjs'
import { stopSlot } from './slot-runtime.mjs'
import { ensureKvmMachineRecord, dockerEnvMap } from './kvm-machine.mjs'
import { migrationError, assertMigrationCapacity } from '../cluster/slot-migration-remote.mjs'
import { parseMemoryBytes } from '../cluster/placement.mjs'

const OVERHEAD = 512 * 1024 ** 2
const IMAGE_ID_RE = /^sha256:[a-f0-9]{64}$/

/** Identity env that must survive the resize unchanged (memory is the only intended difference). */
export const LOCAL_RESIZE_IDENTITY_KEYS = Object.freeze([
  'KIN_VM_ID',
  'KIN_VM_OS',
  'KIN_KVM_VCPUS',
  'KIN_KVM_DISK_GB',
  'KIN_KVM_CPU_MODEL',
  'KIN_KVM_MAC',
  'KIN_KVM_SMBIOS_MANUFACTURER',
  'KIN_KVM_SMBIOS_PRODUCT',
  'KIN_KVM_SMBIOS_VERSION',
  'KIN_KVM_SMBIOS_FAMILY',
  'KIN_KVM_SMBIOS_SERIAL',
  'KIN_KVM_SMBIOS_UUID',
  'KIN_KVM_DISK_SERIAL',
  'KIN_KVM_HOSTNAME',
  'KIN_KVM_MACHINE_ID',
])

export function dockerRun(argv, { timeout = 30_000 } = {}) {
  try {
    const out = execFileSync('docker', argv, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, stdout: out.trim() }
  } catch (e) {
    return { ok: false, stdout: String(e.stdout || '').trim(), stderr: String(e.stderr || e.message || '').trim() }
  }
}

function inspect(ref, docker) {
  const r = docker(['inspect', ref], { timeout: 15_000 })
  if (!r.ok) return null
  try {
    return JSON.parse(r.stdout)[0] || null
  } catch {
    return null
  }
}

function hostMemory(readMeminfo = () => fs.readFileSync('/proc/meminfo', 'utf8')) {
  const text = readMeminfo()
  const kb = (key) => Number((new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text) || [])[1]) * 1024
  return { total: kb('MemTotal') || os.totalmem(), available: kb('MemAvailable') }
}

/** Env differences on the identity keys (empty = same guest). */
export function identityDrift(before, after) {
  const a = dockerEnvMap(before?.Config?.Env)
  const b = dockerEnvMap(after?.Config?.Env)
  return LOCAL_RESIZE_IDENTITY_KEYS.filter((k) => (a[k] ?? '') !== (b[k] ?? ''))
}

export async function preflightLocalResize({ projectRoot, vm, memory, routing, jobId, docker = dockerRun, meminfo }) {
  if (vm.node_id) throw migrationError('migration_unsupported', '本机扩容只适用于主控本机的槽')
  if (process.platform !== 'linux' && !meminfo) throw migrationError('migration_unsupported', '本机扩容仅支持 Linux 主控')
  const name = containerName(vm.id)
  const sourceInfo = inspect(name, docker)
  if (!sourceInfo) throw migrationError('migration_source_missing', '本机槽容器不存在')
  if (
    !sourceInfo.State?.Running ||
    sourceInfo.Config?.Labels?.['kin.vm.id'] !== vm.id ||
    sourceInfo.Config?.Labels?.['kin.vm.runtime'] !== 'kvm'
  )
    throw migrationError('migration_source_not_ready', '必须是此槽正在运行的 KVM 容器')
  if (!IMAGE_ID_RE.test(String(sourceInfo.Image || '')))
    throw migrationError('migration_image_missing', '无法确认原槽的基础镜像')
  const { total, available } = hostMemory(meminfo)
  const reserved = listVms(projectRoot, routing)
    .filter((v) => !v.node_id && v.id !== vm.id && v.status === 'running')
    .reduce((sum, v) => sum + parseMemoryBytes(slotMemory(v, routing)) + (v.runtime_type === 'kvm' ? OVERHEAD : 0), 0)
  assertMigrationCapacity({
    total,
    available,
    reserved,
    requested: parseMemoryBytes(memory) + OVERHEAD,
    current: parseMemoryBytes(slotMemory(vm, routing)) + OVERHEAD,
  })
  return {
    local: true,
    sameNode: true,
    vmId: vm.id,
    name,
    jobId,
    sourceInfo,
    backupName: `${name}-resize-${jobId}`,
    summary: {
      source_node_id: 'local',
      target_node_id: 'local',
      memory,
      available_memory: available,
      same_node: true,
    },
  }
}

export async function stopLocalSlot(vm) {
  return stopSlot(vm)
}

/** Stopped container -> kept aside under a new name; its MAC/disk serial are on the record first. */
export async function preserveLocalContainer(plan, { projectRoot, docker = dockerRun } = {}) {
  const current = inspect(plan.name, docker)
  if (current?.Id !== plan.sourceInfo.Id || current.State?.Running)
    throw migrationError('migration_source_changed', '原槽容器已变化或未确认停止，保持维护暂停')
  if (projectRoot) {
    const vm = { id: plan.vmId, machine: {} }
    ensureKvmMachineRecord(vm, { projectRoot, containerEnv: dockerEnvMap(current.Config?.Env), persist: true })
  }
  const policy = docker(['update', '--restart', 'no', current.Id])
  if (!policy.ok) throw migrationError('migration_preserve_failed', '无法关闭原容器的自动重启')
  const renamed = docker(['rename', current.Id, plan.backupName])
  if (!renamed.ok) throw migrationError('migration_preserve_failed', '无法保留原容器作回滚')
}

export async function publishLocalResize() {}

/** The replacement must be the same guest: identity env and base image unchanged. */
export async function verifyLocalResize(plan, { docker = dockerRun } = {}) {
  const after = inspect(plan.name, docker)
  if (!after?.State?.Running) throw migrationError('migration_verification_failed', '新容器未运行')
  if (after.Image !== plan.sourceInfo.Image)
    throw migrationError('migration_image_mismatch', '新容器的基础镜像和原槽不一致')
  const drift = identityDrift(plan.sourceInfo, after)
  if (drift.length) throw migrationError('migration_identity_changed', `槽位身份字段变化：${drift.join(', ')}`)
}

/** Replacement gone, original container back under its own name (stopped; the caller boots it). */
export async function rollbackLocalResize(plan, { docker = dockerRun } = {}) {
  const replacement = inspect(plan.name, docker)
  if (replacement && replacement.Id !== plan.sourceInfo.Id) {
    docker(['stop', '-t', '30', replacement.Id], { timeout: 75_000 })
    const removed = docker(['rm', '-f', replacement.Id])
    if (!removed.ok) throw migrationError('migration_cleanup_failed', '无法移除扩容后的新容器')
  }
  const original = inspect(plan.sourceInfo.Id, docker)
  if (!original) throw migrationError('migration_source_missing', '保留的原容器不见了')
  if (original.Name?.replace(/^\//, '') !== plan.name) {
    const renamed = docker(['rename', original.Id, plan.name])
    if (!renamed.ok) throw migrationError('migration_rollback_failed', '无法把原容器改回原名')
  }
}

export async function finishLocalResize(plan, { docker = dockerRun } = {}) {
  const kept = inspect(plan.sourceInfo.Id, docker)
  if (!kept) return
  if (kept.State?.Running) throw migrationError('migration_cleanup_failed', '保留的原容器在运行，未删除')
  const removed = docker(['rm', kept.Id])
  if (!removed.ok) throw migrationError('migration_cleanup_failed', '保留的原容器删除失败')
}
