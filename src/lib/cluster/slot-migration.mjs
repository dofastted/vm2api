/** Administrator-initiated, cold KVM migration. Persistent holds fail closed on controller restart. */
import crypto from 'node:crypto'
import path from 'node:path'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { resolveKernelDataplane } from '../vm/slot-engine.mjs'
import { applyHold } from '../pool/schedule-state.mjs'
import { getVm, patchVmRecord, clearScheduleHold } from '../vm/vm-registry.mjs'
import { isValidVmId, withVmLock } from '../vm/vm-file.mjs'
import { slotMemory, VM_MEMORY_OPTIONS } from '../vm/machine-spec.mjs'
import { runtimeKind } from '../vm/runtime-kind.mjs'
import { powerOnSlot, diagnoseSlotServices, redactSecrets } from '../vm/slot-recovery.mjs'
import { stopRemoteSlot } from './remote-slot.mjs'
import { parseMemoryBytes } from './placement.mjs'
import {
  migrationError,
  preflightMigration,
  copyMigrationTree,
  preserveMigrationContainer,
  publishMigrationTree,
  rollbackMigrationRuntime,
  finishMigration,
} from './slot-migration-remote.mjs'

const active = new Map()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function migrationActive(vm) {
  return ['running', 'needs_attention'].includes(vm?.slot_migration?.status)
}

export function slotMigrationBusy(projectRoot, id) {
  return active.get(projectRoot)?.vm_id === id || migrationActive(getVm(projectRoot, id))
}

export function slotMigrationJob(projectRoot, id) {
  const job = active.get(projectRoot)
  if (job?.vm_id === id) return { ...job.public }
  const saved = getVm(projectRoot, id)?.slot_migration
  if (!saved) return null
  const { rollback, ...view } = saved
  if (view.status === 'running')
    return {
      ...view,
      status: 'needs_attention',
      error: '主控在迁移中重启；调度保持暂停，请按迁移文档核对两端后恢复，勿同时启动两份槽位',
    }
  return view
}

export function migrationRequest(vm, body, routing) {
  if (!vm) throw migrationError('vm_not_found', '槽位不存在', 404)
  if (!vm.node_id || runtimeKind(vm) !== 'kvm' || isCodexVm(vm) || resolveKernelDataplane(vm, routing) === 'crag')
    throw migrationError('migration_unsupported', '首版仅支持远程 Linux 节点上的 Claude KVM 槽（不含 crag）')
  if (vm.status !== 'running') throw migrationError('migration_not_running', '请先确认原槽已正常运行')
  if (migrationActive(vm) || vm.schedule_hold)
    throw migrationError('migration_busy', '槽位正在迁移或维护中，请先完成原任务')
  if (!body || typeof body !== 'object' || Object.keys(body).some((k) => !['target_node_id', 'memory'].includes(k)))
    throw migrationError('migration_invalid', '仅接受 target_node_id 和 memory', 400)
  const targetNodeId = body.target_node_id
  if (typeof targetNodeId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(targetNodeId))
    throw migrationError('migration_invalid', '请选择目标节点', 400)
  const current = slotMemory(vm, routing)
  const memory = body.memory ?? current
  if (!VM_MEMORY_OPTIONS.includes(memory) || parseMemoryBytes(memory) < parseMemoryBytes(current))
    throw migrationError('migration_invalid_memory', '只支持保留内存或扩容，不能缩容', 400)
  if (targetNodeId === vm.node_id && memory === current)
    throw migrationError('migration_no_change', '请选择其他节点或更大的内存', 400)
  return { targetNodeId, memory }
}

async function drain(scheduler, id, { wait = sleep, now = Date.now } = {}) {
  if (!(scheduler?.vmInflight instanceof Map))
    throw migrationError('migration_drain_unavailable', '无法确认在途请求，未停止原槽')
  const deadline = now() + 120_000
  let quiet = 0
  do {
    if ((Number(scheduler.vmInflight.get(id)) || 0) === 0) quiet++
    else quiet = 0
    if (quiet >= 2) return
    await wait(3000)
  } while (now() < deadline)
  throw migrationError('migration_slots_busy', '在途请求未排空，已放弃迁移')
}

export function startSlotMigration(args) {
  const { projectRoot, id, body, routing } = args
  if (!isValidVmId(id)) throw migrationError('invalid_vm_id', '非法槽位 ID', 400)
  migrationRequest(getVm(projectRoot, id), body, routing)
  if (active.has(projectRoot)) throw migrationError('migration_busy', '已有迁移任务正在进行，请稍后再试')
  const job = {
    vm_id: id,
    public: {
      id: crypto.randomUUID(),
      vm_id: id,
      status: 'running',
      phase: 'queued',
      target_node_id: body.target_node_id,
      started_at: new Date().toISOString(),
    },
  }
  active.set(projectRoot, job)
  job.done = withVmLock(path.join(projectRoot, 'vms', `${id}.json`), () => runMigration(args, job))
    .catch((err) => {
      job.public = { ...job.public, status: 'needs_attention', error: redactSecrets(String(err.message || err)) }
    })
    .finally(() => active.delete(projectRoot))
  return { job: { ...job.public }, done: job.done }
}

async function runMigration(args, job) {
  const { projectRoot, id, body, routing, proxyPool, watchdog, poolScheduler, ops = {} } = args
  const preflight = ops.preflight || preflightMigration
  const power = ops.powerOn || powerOnSlot
  const wait = ops.wait || sleep
  let plan,
    original,
    held = false,
    touched = false,
    committed = false
  const update = (patch, persist = true) => {
    job.public = { ...job.public, ...patch }
    if (persist) patchVmRecord(projectRoot, id, (vm) => ({ slot_migration: { ...vm.slot_migration, ...job.public } }))
  }
  const boot = async () => {
    const result = await power({
      projectRoot,
      id,
      proxyPool,
      routing,
      fillTimezone: async () => {},
      by: 'migration',
      runtimeOptions: { pinnedImageId: plan?.sourceInfo?.Image || null },
    })
    if (!result.ok || result.boot?.rust_ok === false || result.boot?.kernel?.ok === false)
      throw migrationError('migration_boot_failed', '槽位启动或内核就绪检查失败')
  }
  try {
    const vm = getVm(projectRoot, id)
    const request = migrationRequest(vm, body, routing)
    update({ phase: 'preflight' }, false)
    plan = await preflight({ projectRoot, vm, ...request, routing, jobId: job.public.id })
    original = {
      node_id: vm.node_id,
      machine: structuredClone(vm.machine),
      runtime: structuredClone(vm.runtime || {}),
      status: vm.status,
    }
    job.public = { ...job.public, ...plan.summary, phase: 'draining' }
    // Journal + maintenance hold are one atomic record write: no restart gap.
    patchVmRecord(projectRoot, id, (record) => {
      if (record.schedule_hold) throw migrationError('migration_busy', '槽位已有维护任务')
      applyHold(record, 'maintenance', { tag: `migration:${job.public.id}` })
      return { slot_migration: { ...job.public, rollback: original } }
    })
    held = true
    await watchdog?.hold?.(id)
    await drain(poolScheduler, id, { wait, now: ops.now || Date.now })
    update({ phase: 'stopping' })
    // A persistent marker also excludes the slot from watchdog/revive after a process restart.
    patchVmRecord(projectRoot, id, { status: 'stopped' })
    touched = true
    const stopped = await (ops.stop || stopRemoteSlot)(vm)
    if (!stopped?.ok) throw migrationError('migration_stop_failed', '原节点关机失败')
    await (ops.preserve || preserveMigrationContainer)(plan)
    if (!plan.sameNode) {
      update({ phase: 'copying' })
      const receipt = await (ops.copy || copyMigrationTree)(plan)
      update({ copied_bytes: receipt.copied_bytes, checksum: receipt.sha256 })
    }
    update({ phase: 'switching' })
    await (ops.publish || publishMigrationTree)(plan)
    patchVmRecord(projectRoot, id, (record) => ({
      node_id: request.targetNodeId,
      machine: { ...record.machine, memory: request.memory },
      runtime: {},
    }))
    update({ phase: 'starting' })
    await boot()
    update({ phase: 'verifying' })
    await wait(3000)
    watchdog?.reset?.(id)
    const diagnosis = await (ops.diagnose || diagnoseSlotServices)(getVm(projectRoot, id), {
      projectRoot,
      routing,
      watchdog,
      internal: true,
    })
    if (!diagnosis.ok) throw migrationError('migration_verification_failed', '迁移后服务检查未通过，正在回滚')
    committed = true
    update({ phase: 'cleanup' })
    try {
      await (ops.finish || finishMigration)(plan)
    } catch {
      update({
        warning: '新槽已验证；旧容器/出口或备份整理未完成，请按文档核对保留资源',
        source_container: plan.backupName,
        source_directory: plan.from,
      })
    }
    update({
      status: 'done',
      phase: 'done',
      backup_directory: plan.sameNode || job.public.warning ? null : plan.backupDir,
    })
  } catch (err) {
    if (!committed && touched) {
      update({ phase: 'rolling_back' })
      try {
        await (ops.rollback || rollbackMigrationRuntime)(plan)
        patchVmRecord(projectRoot, id, original)
        await boot()
        await wait(3000)
        const restored = await (ops.diagnose || diagnoseSlotServices)(getVm(projectRoot, id), {
          projectRoot,
          routing,
          watchdog,
          internal: true,
        })
        if (!restored.ok) throw migrationError('migration_rollback_unhealthy', '原槽服务尚未恢复')
        update({ status: 'failed', phase: 'rolled_back', error: redactSecrets(err.message) })
      } catch {
        update({
          status: 'needs_attention',
          phase: 'rollback_failed',
          error: '自动回滚未完成；保持维护暂停，请按文档核对两端，禁止同时启动两份槽位',
        })
      }
    } else update({ status: 'failed', phase: 'failed', error: redactSecrets(err.message) })
  } finally {
    if (held && job.public.status !== 'needs_attention') {
      clearScheduleHold(projectRoot, id, 'maintenance', { tag: `migration:${job.public.id}` })
    }
    if (held) watchdog?.release?.(id)
  }
}
