import fs from 'node:fs'
import path from 'node:path'
import { describeKernelCatalog } from '../admin/kernel-catalog.mjs'
import { writeKernelConfig } from '../transport/rust-kernel-supervisor.mjs'
import { applyScheduleOff, migrateScheduleRecord } from '../pool/schedule-state.mjs'
import { checkCragLicense } from './crag-license.mjs'
import { isValidVmId, withVmLock } from './vm-file.mjs'
import { ensureHostPrivateDir } from './private-dir.mjs'
import { getVm, patchVmRecord } from './vm-registry.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { stopSlot } from './slot-runtime.mjs'
import { officialCcUidGid, suspendVmRuntimeRestart } from './vm-runtime.mjs'
import { materializeResolvedKernel } from './wrap-cli-runtime.mjs'
import { pushKernelSelection } from '../cluster/remote-slot-files.mjs'

const PRODUCTS = new Set(['cli-node', 'crag'])
// Only exceptional installer holds may be cleared by a later explicit start.
// Key by record path so independent projects cannot release each other's slot.
const safetyHolds = new Map()

/** Caller holds this VM's lifecycle lock and has completed an explicit start. */
export function releaseKernelInstallSafetyHold(projectRoot, id, watchdog) {
  const file = path.join(projectRoot, 'vms', `${id}.json`)
  if (!watchdog || safetyHolds.get(file) !== watchdog) return false
  safetyHolds.delete(file)
  watchdog.release?.(id)
  return true
}
const failure = (target, code, error, stopped = false) => ({
  id: target?.id,
  kernel: target?.kernel,
  ok: false,
  code,
  error,
  stopped,
})
const report = (items) => {
  const failed_count = items.filter((item) => !item.ok).length
  return { ok: failed_count === 0, total: items.length, ok_count: items.length - failed_count, failed_count, items }
}

function desiredVm(vm, kernel) {
  const desired = { ...vm, dataplane: kernel === 'crag' ? 'crag' : 'wrap' }
  if (kernel === 'crag') desired.crag_kernel_version = 'v2'
  else delete desired.crag_kernel_version
  return desired
}

function placementFailure(vm, kernel) {
  if (isCodexVm(vm)) return { code: 'kernel_codex_unsupported', error: '请选择 Claude 虚拟机' }
  if (vm.node_platform === 'darwin') {
    return { code: 'kernel_install_unsupported_placement', error: 'macOS 原生节点不能在内核页重装' }
  }
  if (!vm.node_id && !isKvmRuntime(vm) && process.platform !== 'linux') {
    return {
      code: kernel === 'crag' ? 'crag_v2_unsupported_placement' : 'kernel_install_unsupported_placement',
      error: '内核重装仅支持本机 Linux Docker 虚拟机',
    }
  }
  return null
}

async function deployBakedKernel(projectRoot, vm, kernel) {
  try {
    return await pushKernelSelection(vm, projectRoot, kernel)
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'kernel_materialize_failed',
      error: String(error?.message || error).slice(0, 300),
    }
  }
}

function prepareNativeDirectories(runDir, owner) {
  if (!runDir || !path.isAbsolute(runDir) || /^\/mnt\/[a-z](?:\/|$)/i.test(runDir)) {
    throw Object.assign(new Error('CRAG 私有目录必须位于 Linux 文件系统'), {
      code: 'crag_v2_private_directory_invalid',
    })
  }
  const privileged = typeof process.getuid === 'function' && process.getuid() === 0
  for (const name of ['crag-native-assets', 'work']) {
    ensureHostPrivateDir(path.join(runDir, name), {
      uid: owner.uid,
      gid: owner.gid,
      privileged,
    })
  }
}

/** Explicit, bounded selection only; an invalid batch never partially installs. */
export function validateKernelTargets(projectRoot, targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { ok: false, status: 400, code: 'kernel_targets_required', error: '请明确选择虚拟机和内核' }
  }
  const ids = new Set()
  for (const target of targets) {
    if (!target || typeof target.id !== 'string' || !isValidVmId(target.id) || !PRODUCTS.has(target.kernel)) {
      return { ok: false, status: 400, code: 'kernel_target_invalid', error: '虚拟机 ID 或内核无效' }
    }
    if (ids.has(target.id)) {
      return { ok: false, status: 400, code: 'kernel_target_duplicate', error: '同一虚拟机不能重复选择' }
    }
    ids.add(target.id)
    const vm = getVm(projectRoot, target.id)
    if (!vm || vm.id !== target.id) {
      return { ok: false, status: 404, code: 'vm_not_found', error: '所选虚拟机不存在' }
    }
  }
  return { ok: true }
}

/** Reinstall a chosen product without starting, resetting or recreating a slot. */
export async function installKernelTargets({ projectRoot, targets, routing = {}, watchdog, ops = {} }) {
  const selection = validateKernelTargets(projectRoot, targets)
  if (!selection.ok) {
    return {
      ...report(
        Array.isArray(targets) ? targets.map((target) => failure(target, selection.code, selection.error)) : [],
      ),
      ...selection,
    }
  }
  const items = []
  for (const target of targets) {
    const file = path.join(projectRoot, 'vms', `${target.id}.json`)
    items.push(
      await withVmLock(file, async () => {
        let held = false
        let stopped = false
        let stoppedPersisted = false
        let installed = false
        const inheritedSafetyHold = !!watchdog && safetyHolds.get(file) === watchdog
        let phase = 'kernel_preflight_failed'
        try {
          // Hold inside the VM lock: another installer cannot release this hold early.
          // Drain a watchdog restart already past admission before touching the slot.
          held = true
          await watchdog?.hold?.(target.id)
          const vm = getVm(projectRoot, target.id)
          if (!vm || vm.id !== target.id) return failure(target, 'vm_not_found', '所选虚拟机不存在')
          const unsupported = placementFailure(vm, target.kernel)
          if (unsupported) return failure(target, unsupported.code, unsupported.error)
          const desired = desiredVm(vm, target.kernel)
          const product = (ops.describeKernelCatalog || describeKernelCatalog)(projectRoot).find(
            (item) => item.id === target.kernel,
          )
          if (!product?.ready)
            return failure(target, product?.code || 'kernel_package_missing', product?.error || '请先拉取所选内核')
          if (target.kernel === 'crag') {
            const grant = (ops.checkCragLicense || checkCragLicense)(projectRoot, desired, routing)
            if (!grant.ok) return failure(target, grant.code || 'license_required', grant.error || '请先激活 CRAG 授权')
          }
          phase = 'kernel_stop_failed'
          const halt = await (ops.stopSlot || stopSlot)(vm)
          if (!halt?.ok) return failure(target, halt?.code || phase, halt?.error || '虚拟机停止失败')
          stopped = true
          // Commit STOPPED immediately, even if replacement or config subsequently fails.
          // Re-read owned fields instead of overwriting credentials changed during drain.
          phase = 'kernel_stop_persist_failed'
          const halted = patchVmRecord(projectRoot, target.id, (record) => {
            record.status = 'stopped'
            record.runtime = { ...record.runtime, ...halt.runtime, stopped: true, pid: null, ip: null }
            migrateScheduleRecord(record)
            // applyScheduleOff drops reason "disabled"; that value is the operator's own off switch.
            const operatorDisabled = record.schedule_off === true && record.schedule_off_reason === 'disabled'
            const reason = record.schedule_off === true ? record.schedule_off_reason : 'stopped'
            applyScheduleOff(record, true, { reason })
            if (operatorDisabled) record.schedule_off_reason = 'disabled'
          })
          if (!halted) return failure(target, 'vm_not_found', '虚拟机记录已移除', true)
          stoppedPersisted = true
          phase = 'kernel_restart_policy_failed'
          const policy = await (ops.suspendVmRuntimeRestart || suspendVmRuntimeRestart)(halted)
          if (!policy?.ok) return failure(target, policy?.code || phase, policy?.error || '无法关闭容器自动重启', true)
          const candidate = desiredVm(halted, target.kernel)
          const owner = officialCcUidGid(target.id)
          phase = 'kernel_materialize_failed'
          // Pull publishes immutable packages by a synchronous pointer swap. Observe the
          // actual version in the same event-loop turn as the synchronous materializer.
          const installedProduct = (ops.describeKernelCatalog || describeKernelCatalog)(projectRoot).find(
            (item) => item.id === target.kernel,
          )
          if (!installedProduct?.ready)
            return failure(
              target,
              installedProduct?.code || 'kernel_package_missing',
              installedProduct?.error || '内核缓存已变化，请重新拉取',
              true,
            )
          const baked = !!String(candidate.node_id || '').trim()
          const laid = baked
            ? await (ops.deployBakedKernel || deployBakedKernel)(projectRoot, candidate, target.kernel)
            : await (ops.materializeResolvedKernel || materializeResolvedKernel)(projectRoot, candidate, {
                ...owner,
                routing,
              })
          if (!laid?.ok) return failure(target, laid?.code || phase, laid?.error || '内核文件安装失败', true)
          phase = 'kernel_config_failed'
          const config = (ops.writeKernelConfig || writeKernelConfig)(projectRoot, candidate, {
            routing,
            timezone: candidate.timezone,
            publish: false,
          })
          if (!config?.configPath) return failure(target, phase, '内核配置生成失败', true)
          if (target.kernel === 'crag' && !baked) prepareNativeDirectories(config.runDir, owner)
          phase = 'kernel_selection_persist_failed'
          const saved = patchVmRecord(projectRoot, target.id, (record) => {
            record.dataplane = candidate.dataplane
            if (target.kernel === 'crag') record.crag_kernel_version = 'v2'
            else delete record.crag_kernel_version
            record.kernel_installation = {
              kernel: target.kernel,
              version: installedProduct.version ?? null,
              installed_at: new Date().toISOString(),
            }
          })
          if (!saved) return failure(target, 'vm_not_found', '虚拟机记录已移除', true)
          installed = true
          return {
            id: target.id,
            kernel: target.kernel,
            ok: true,
            stopped: true,
            version: installedProduct.version ?? null,
          }
        } catch (error) {
          return failure(
            target,
            phase,
            stopped && !stoppedPersisted
              ? '虚拟机已停止，但停止状态写入失败；自动恢复保持暂停，请修复记录权限后重装或手动启动'
              : `内核操作失败（${error?.code || phase}），请检查包与文件权限`,
            stopped,
          )
        } finally {
          // Do not clear an inherited installer safety hold on an unsuccessful retry.
          if (held && ((stopped && !stoppedPersisted) || (inheritedSafetyHold && !installed))) {
            if (typeof watchdog?.hold === 'function') safetyHolds.set(file, watchdog)
          } else if (held) {
            safetyHolds.delete(file)
            watchdog?.release?.(target.id)
          }
        }
      }),
    )
  }
  return report(items)
}
