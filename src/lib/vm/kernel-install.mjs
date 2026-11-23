import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { describeKernelCatalog, reserveKernelInstallCache } from '../admin/kernel-catalog.mjs'
import { isCragPayloadTag } from '../admin/release-kernel.mjs'
import { isReleaseTag } from '../admin/release.mjs'
import { cancelRustKernelStart, writeKernelConfig } from '../transport/rust-kernel-supervisor.mjs'
import {
  applyHold,
  applyClearHold,
  applyClearUnschedulable,
  applyUnschedulable,
  deriveScheduleFields,
  HOLD_MAINTENANCE,
  migrateScheduleRecord,
} from '../pool/schedule-state.mjs'
import { clusterManager } from '../cluster/placement.mjs'
import { checkCragLicense } from './crag-license.mjs'
import { isValidVmId, withVmLock } from './vm-file.mjs'
import { ensureHostPrivateDir } from './private-dir.mjs'
import { getVm, listVms, patchVmRecord, vmHasSchedulableCredential, waitForSlotDrain } from './vm-registry.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { slotExec, startSlotReady, stopSlot } from './slot-runtime.mjs'
import { resolveKernelDataplane } from './slot-engine.mjs'
import { withCragRuntimeAdmission } from './slot-runtime-admission.mjs'
import { inspectInstalledCragEntry, officialCcUidGid, suspendVmRuntimeRestart } from './vm-runtime.mjs'
import {
  installedCragV2Root,
  materializeResolvedKernel,
  stageCragV2Tree,
  verifyCragV2Tree,
} from './wrap-cli-runtime.mjs'
import { initializeSlotSeedFiles } from './slot-seed.mjs'
import { slotHost } from './slot-host.mjs'
import { pushKernelSelection } from '../cluster/remote-slot-files.mjs'
import { accountIdOf } from '../pool/pool-scheduler.mjs'
import { unitCircuit } from '../pool/unit-circuit.mjs'
import { clearRustHealthCache } from '../transport/kernel-router.mjs'
import { rustKernelHealth, rustKernelReachable } from '../transport/rust-kernel-client.mjs'

const PRODUCTS = new Set(['cli-node', 'crag'])
const INTERRUPTED_COMMAND =
  /^(node_not_ready|ssh_timeout|ssh_connect_failed|ssh_closed|ssh_link_error|exec_timeout|docker_timeout|docker_io_failed|ECONNRESET|EPIPE)$/
// Exceptional switch holds may be cleared by a later explicit start.
// Key by record path so independent projects cannot release each other's slot.
const safetyHolds = new Map()

export function hasKernelInstallSafetyHold(projectRoot, id, watchdog) {
  return !!watchdog && safetyHolds.get(path.join(projectRoot, 'vms', `${id}.json`)) === watchdog
}

/** Preserve an existing watchdog hold after a confirmed stop could not be persisted. */
export function retainKernelInstallSafetyHold(projectRoot, id, watchdog) {
  if (typeof watchdog?.hold !== 'function') return false
  safetyHolds.set(path.join(projectRoot, 'vms', `${id}.json`), watchdog)
  return true
}

function clearInstallHold(record) {
  const operation = record.kernel_operation
  if (record.schedule_hold?.detail?.tag === operation?.id) {
    applyClearHold(record, HOLD_MAINTENANCE, { tag: operation.id })
    if (operation.previous_hold) record.schedule_hold = operation.previous_hold
  }
  delete record.kernel_operation
  deriveScheduleFields(record)
}

/** Caller holds this VM's lifecycle lock and has completed an explicit start. */
export function releaseKernelInstallSafetyHold(projectRoot, id, watchdog) {
  const file = path.join(projectRoot, 'vms', `${id}.json`)
  if (safetyHolds.has(file) && safetyHolds.get(file) !== watchdog) return false
  if (getVm(projectRoot, id)?.kernel_operation) patchVmRecord(projectRoot, id, clearInstallHold)
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
const ADMISSION_ERRORS = new Map([
  ['crag_subscription_unavailable', 'CRAG 订阅状态暂时读不到。槽位和原服务未改动，请稍后重试。'],
  ['crag_subscription_authority_unavailable', '授权服务暂时没有响应。槽位和原服务未改动，请稍后重试。'],
  ['crag_subscription_busy', 'CRAG 启动操作繁忙。槽位和原服务未改动，请稍后重试。'],
  ['license_crag_host_usage_unverified', '暂时对不上宿主机运行额度。槽位和原服务未改动，请稍后重试。'],
  ['license_crag_host_over_quota', '宿主订阅的运行槽位已满。原服务未改动；释放其他运行槽或增加额度后再更新。'],
])
function installLicenseFailure(target, check) {
  if (check.code === 'license_payload_key_mismatch') {
    return failure(
      target,
      'crag_subscription_migration_required',
      '下载包与已有许可使用不同的加密密钥。请选择兼容版本，或先完成授权迁移。',
    )
  }
  return failure(
    target,
    check.code || 'license_required',
    ADMISSION_ERRORS.get(check.code) || check.error || '请先激活 CRAG 授权',
  )
}

const healthy = (boot) => boot?.ok && boot.rust_ok !== false && boot.rust?.ok !== false && boot.kernel?.ok !== false

function markRunning(record, boot, projectRoot) {
  record.status = 'running'
  record.runtime = { ...record.runtime, ...(boot.runtime || boot.docker?.runtime), stopped: false }
  const hasCredential = vmHasSchedulableCredential(record, projectRoot)
  if (!hasCredential && !record.unschedulable) applyUnschedulable(record, 'no_credential')
  else if (hasCredential && record.unschedulable?.reason === 'runtime_start_failed') {
    applyClearUnschedulable(record, { by: 'operator' })
  }
  if (record.schedule_off_reason === 'stopped') {
    delete record.schedule_off
    delete record.schedule_off_reason
  }
  clearInstallHold(record)
  delete record.kernel_restart_pending
}

function manifestDigest(root) {
  return createHash('sha256')
    .update(fs.readFileSync(path.join(root, 'manifest.json')))
    .digest('hex')
}

function prepareCragRollback(projectRoot, vm, routing, licenseCheck) {
  const dest = installedCragV2Root(projectRoot, vm)
  if (!dest && vm.kernel_installation?.kernel !== 'crag') return null
  const verified = dest && verifyCragV2Tree(dest, { allowPreviousClaude: true })
  const grant = licenseCheck(projectRoot, vm, routing, { preferInstalled: true })
  if (!verified?.ok || !grant.ok || !inspectInstalledCragEntry(projectRoot, vm).ok) {
    throw Object.assign(new Error('Previous CRAG payload is not a verified rollback source'), {
      code: 'crag_rollback_unverified',
    })
  }
  const digest = manifestDigest(dest)
  // Copy distribution files only; never snapshot a license, H2 roster or slot identity.
  const backup = fs.mkdtempSync(path.join(projectRoot, 'vms', vm.id, 'crag-rollback-'))
  const pkg = path.join(backup, 'package')
  try {
    for (const rel of ['manifest.json', ...Object.keys(verified.manifest.sha256)]) {
      const out = path.join(pkg, rel)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.copyFileSync(path.join(dest, rel), out)
    }
    if (manifestDigest(pkg) !== digest || !verifyCragV2Tree(pkg).ok) {
      throw Object.assign(new Error('CRAG rollback copy failed verification'), { code: 'crag_rollback_unverified' })
    }
    return { backup, pkg, dest, digest }
  } catch (error) {
    fs.rmSync(backup, { recursive: true, force: true })
    throw error
  }
}

async function restoreCragRollback({ projectRoot, vm, rollback, routing, ops, bootAttempted }) {
  const current = getVm(projectRoot, vm.id)
  if (!current) return null
  if (bootAttempted) {
    const halt = await (ops.stopSlot || stopSlot)(current)
    if (!halt?.ok) return null
    const policy = await (ops.suspendVmRuntimeRestart || suspendVmRuntimeRestart)(current)
    if (!policy?.ok) return null
  }
  if (!verifyCragV2Tree(rollback.pkg).ok || manifestDigest(rollback.pkg) !== rollback.digest) return null
  const tree = stageCragV2Tree(rollback.pkg, rollback.dest)
  if (!tree.ok) return null
  tree.commit()
  const checked = (ops.checkCragLicense || checkCragLicense)(projectRoot, vm, routing, { preferInstalled: true })
  if (!checked.ok || manifestDigest(rollback.dest) !== rollback.digest) return null

  const prior = patchVmRecord(projectRoot, vm.id, (record) => {
    for (const key of ['dataplane', 'crag_kernel_version', 'kernel_installation']) {
      if (Object.hasOwn(vm, key)) record[key] = vm[key]
      else delete record[key]
    }
  })
  if (!prior) return null
  try {
    const boot = await (ops.startSlotReady || startSlotReady)(prior, projectRoot, {
      routing,
      allowMissingCredential: true,
      useInstalledCrag: true,
    })
    if (
      healthy(boot) &&
      boot.rust?.ok === true &&
      boot.rust.skipped !== true &&
      manifestDigest(rollback.dest) === rollback.digest
    ) {
      const exec = slotExec(projectRoot, { ...prior, runtime: boot.runtime || boot.docker?.runtime || prior.runtime })
      const health = await (ops.rustKernelHealth || rustKernelHealth)(exec, { requireInternalToken: true })
      if (
        health?.internalTokenAuthenticated === true &&
        rustKernelReachable(health) &&
        (health.execution_mode === 'v2_process_pool' || Number(health.cli_pid) > 0)
      ) {
        const running = patchVmRecord(projectRoot, vm.id, (record) => markRunning(record, boot, projectRoot))
        if (running) return running
      }
    }
  } catch {
    // The rollback may have started a container before losing health or persistence.
  }
  const halt = await (ops.stopSlot || stopSlot)(prior)
  if (!halt?.ok) return null
  await (ops.suspendVmRuntimeRestart || suspendVmRuntimeRestart)(prior)
  return null
}

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
    if (
      target.expected_tag !== undefined &&
      (typeof target.expected_tag !== 'string' || !isReleaseTag(target.expected_tag))
    ) {
      return { ok: false, status: 400, code: 'kernel_tag_invalid', error: '请选择有效的内核发行版本' }
    }
    if (target.payload_tag !== undefined && (target.kernel !== 'crag' || !isCragPayloadTag(target.payload_tag))) {
      return { ok: false, status: 400, code: 'kernel_target_invalid', error: 'CRAG 载荷版本无效' }
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

const CANCELLED = 'kernel_install_cancelled'
/** vmId → in-flight install, so an operator can abandon one without waiting on it. */
const activeInstalls = new Map()

/**
 * Force-cancel one VM's install. Frees the kernel cache reservation at once so other
 * VMs can install, aborts a pending kernel start, and stops the installer at its next
 * checkpoint. A slot already stopped is left stopped under maintenance for review.
 */
export function cancelKernelInstall(vmId) {
  const active = activeInstalls.get(String(vmId || ''))
  if (!active) return { ok: false, code: 'kernel_install_not_running', error: '该虚拟机没有进行中的安装' }
  active.control.cancelled = true
  active.releaseCache?.()
  cancelRustKernelStart(vmId)
  return { ok: true, id: vmId, kernel: active.kernel, phase: active.phase() }
}

export function listActiveKernelInstalls() {
  return [...activeInstalls.entries()].map(([id, active]) => ({
    id,
    kernel: active.kernel,
    phase: active.phase(),
    started_at: active.started_at,
    cancelled: active.control.cancelled,
  }))
}

/** Installation owns stop, replacement and verified restart under one record lock. */
export async function installKernelTargets({
  projectRoot,
  targets,
  routing = {},
  watchdog,
  poolScheduler,
  cragSubscription,
  releaseStoppedBinding = cragSubscription?.releaseStoppedBinding?.bind(cragSubscription),
  ops = {},
  resumeId = null,
}) {
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
        let operationId = null
        let operationPersisted = false
        let interrupted = false
        let bootFailure = null
        let clusterVm = false
        let rollback
        let releaseCache
        const inheritedSafetyHold = !!watchdog && safetyHolds.get(file) === watchdog
        let phase = 'kernel_preflight_failed'
        const control = { cancelled: false }
        const active = {
          control,
          kernel: target.kernel,
          started_at: new Date().toISOString(),
          phase: () => phase,
          releaseCache: null,
        }
        activeInstalls.set(target.id, active)
        const cancelled = () => (control.cancelled ? failure(target, CANCELLED, '安装已被强制取消', stopped) : null)
        try {
          // Hold inside the VM lock: another installer cannot release this hold early.
          // Drain a watchdog restart already past admission before touching the slot.
          held = true
          await watchdog?.hold?.(target.id)
          const vm = getVm(projectRoot, target.id)
          if (!vm || vm.id !== target.id) return failure(target, 'vm_not_found', '所选虚拟机不存在')
          clusterVm = !!vm.node_id
          if (resumeId && (vm.kernel_operation?.id !== resumeId || vm.kernel_operation.phase !== 'pending')) {
            return { id: target.id, kernel: target.kernel, ok: true, skipped: true }
          }
          if (resumeId) {
            operationId = resumeId
            operationPersisted = true
            stopped = vm.status === 'stopped'
            stoppedPersisted = stopped
          }
          const unsupported = placementFailure(vm, target.kernel)
          if (unsupported) return failure(target, unsupported.code, unsupported.error)
          const updateExisting = target.update_existing === true
          if (
            updateExisting &&
            (target.kernel !== 'crag' ||
              (!target.expected_tag && !target.payload_tag) ||
              resolveKernelDataplane(vm, routing) !== 'crag' ||
              !['running', 'stopped'].includes(vm.status))
          ) {
            return failure(target, 'crag_update_target_changed', '槽位不再是可更新的 CRAG 槽，请核对当前状态')
          }
          const keepStopped =
            updateExisting && (resumeId ? vm.kernel_operation.keep_stopped === true : vm.status === 'stopped')
          if (target.expected_tag || target.payload_tag) {
            releaseCache = reserveKernelInstallCache(projectRoot, target.kernel)
            if (!releaseCache) {
              interrupted = Boolean(resumeId)
              return failure(target, 'kernel_pull_busy', '正在重装同类内核，请稍后重试或强制取消进行中的安装')
            }
            active.releaseCache = releaseCache
          }
          const desired = desiredVm(vm, target.kernel)
          const catalog = (ops.describeKernelCatalog || describeKernelCatalog)(projectRoot)
          const product = catalog.find((item) => item.id === target.kernel)
          if (!product?.ready)
            return failure(target, product?.code || 'kernel_package_missing', product?.error || '请先拉取所选内核')
          if (isKvmRuntime(vm) && target.kernel !== 'crag') {
            const crag = catalog.find((item) => item.id === 'crag')
            if (!crag?.ready)
              return failure(target, crag?.code || 'crag_v2_package_missing', crag?.error || '请先拉取 CRAG 预装包')
          }
          const checkPin = (entry, stopped = false) => {
            if (target.expected_tag && entry?.release_tag !== target.expected_tag) {
              return failure(
                target,
                'kernel_release_changed',
                `缓存版本已变化，请重新拉取并确认 ${target.expected_tag}`,
                stopped,
              )
            }
            if (target.payload_tag && entry?.payload_tag !== target.payload_tag) {
              return failure(target, 'crag_payload_changed', 'CRAG 下载版本已变更，请刷新并重新确认安装', stopped)
            }
          }
          const stalePin = checkPin(product)
          if (stalePin) return stalePin
          const licenseCheck = ops.checkCragLicense || checkCragLicense
          const checkTargetLicense = () => licenseCheck(projectRoot, desired, routing, { preferInstalled: false })
          const grant = target.kernel === 'crag' ? checkTargetLicense() : null
          const canAuthorizeInstall = (check) =>
            (['license_required', 'license_crag_host_over_quota', 'license_binding_mismatch'].includes(check?.code) ||
              (check?.code === 'license_payload_key_mismatch' && target.reissue === true)) &&
            !!(target.expected_tag || target.payload_tag) &&
            !resumeId &&
            typeof cragSubscription?.authorizeInstall === 'function'
          if (grant && !grant.ok && !canAuthorizeInstall(grant)) return installLicenseFailure(target, grant)

          let bootAttempted = false
          let restartSuspended = false
          const resetHealth = (running) => {
            watchdog?.reset?.(target.id)
            clearRustHealthCache(target.id)
            poolScheduler?.healthCache?.delete?.(target.id)
            unitCircuit.reset(accountIdOf(running, projectRoot))
          }
          const switchKernel = async () => {
            phase = 'kernel_operation_persist_failed'
            operationId = resumeId || randomUUID()
            patchVmRecord(projectRoot, target.id, (record) => {
              migrateScheduleRecord(record)
              const previous = record.kernel_operation
              record.kernel_operation = {
                id: operationId,
                kernel: target.kernel,
                ...(target.expected_tag ? { expected_tag: target.expected_tag } : {}),
                ...(target.payload_tag ? { payload_tag: target.payload_tag } : {}),
                ...(updateExisting ? { update_existing: true, keep_stopped: keepStopped } : {}),
                phase: 'pending',
                recovery_attempts: resumeId ? (previous.recovery_attempts || 0) + 1 : 0,
                previous_hold: previous ? previous.previous_hold : record.schedule_hold || null,
                schedule_off: record.schedule_off === true,
                started_at: previous?.started_at || new Date().toISOString(),
              }
              applyHold(record, HOLD_MAINTENANCE, { tag: operationId })
            })
            operationPersisted = true
            phase = 'kernel_drain_failed'
            const drained = await waitForSlotDrain(poolScheduler, [target.id])
            if (cancelled()) return cancelled()
            if (!drained.ok) return failure(target, phase, '在途请求未结束，未重启内核')
            if (updateExisting && vm.status === 'running') {
              // Never fall back to a local worker socket for a node slot.
              const health =
                !clusterVm || vm.runtime?.kernel_socket
                  ? await (ops.rustKernelHealth || rustKernelHealth)(slotExec(projectRoot, vm), { timeoutMs: 3000 })
                  : null
              if (
                health?.healthy !== true ||
                health.runtime_variant !== 'crag-v2' ||
                health.license_valid !== true ||
                health.active_requests !== 0 ||
                health.continuations !== 0 ||
                health.queued !== 0
              ) {
                return failure(target, 'crag_slot_not_idle', 'CRAG 未确认空闲，未重启内核')
              }
            }

            const currentProduct = () =>
              (ops.describeKernelCatalog || describeKernelCatalog)(projectRoot).find(
                (item) => item.id === target.kernel,
              )
            const verifyPin = () => {
              if (!target.expected_tag && !target.payload_tag) return
              const current = currentProduct()
              const changed = checkPin(current)
              if (changed) return changed
              if (!current?.ready) {
                return failure(
                  target,
                  current?.code || 'kernel_package_missing',
                  current?.error || '内核缓存已变化，请重新拉取',
                )
              }
            }
            const stalePin = verifyPin()
            if (stalePin) return stalePin
            const pendingGrant = target.kernel === 'crag' ? checkTargetLicense() : null
            if (pendingGrant && !pendingGrant.ok) {
              if (!canAuthorizeInstall(pendingGrant)) return installLicenseFailure(target, pendingGrant)
              try {
                // The panel already authorized this intent (`mayBindSubscription`);
                // without passing it on, migrating a slot that holds an old grant
                // is unreachable.
                await cragSubscription.authorizeInstall(desired, { allowLegacyReissue: target.reissue === true })
              } catch (error) {
                const code = error?.code || 'crag_subscription_install_failed'
                const messages = {
                  host_subscription_inactive: '本机没有已激活且有效的宿主订阅。请先激活订阅，或选用现有许可兼容的包。',
                  slot_limit_reached: '宿主订阅没有剩余绑定槽位。请释放额度，或选用现有许可兼容的包。',
                  crag_subscription_sync_pending: '上一次订阅操作未确认。请先同步宿主订阅状态，再重试重装。',
                  crag_subscription_authority_unavailable:
                    '授权服务器未确认本次操作。请先刷新宿主订阅状态，再重试重装。',
                  crag_subscription_migration_required: '此槽已有宿主订阅绑定。请选择兼容版本，或先完成授权迁移。',
                }
                const message = Object.hasOwn(messages, code) ? messages[code] : `未能为下载包签发本槽许可（${code}）。`
                return failure(target, code, message)
              }
              const stalePin = verifyPin()
              if (stalePin) return stalePin
              const grant = checkTargetLicense()
              if (!grant.ok) return installLicenseFailure(target, grant)
            }
            if (
              !resumeId &&
              !clusterVm &&
              target.kernel === 'crag' &&
              vm.status === 'running' &&
              resolveKernelDataplane(vm, routing) === 'crag'
            ) {
              phase = 'crag_rollback_unverified'
              rollback = prepareCragRollback(projectRoot, vm, routing, licenseCheck)
              if (rollback) {
                patchVmRecord(projectRoot, target.id, (record) => {
                  record.kernel_operation.rollback_package = path.basename(rollback.backup)
                  record.kernel_operation.rollback_manifest_sha256 = rollback.digest
                  if (vm.kernel_installation) record.kernel_operation.rollback_installation = vm.kernel_installation
                })
              }
            }
            if (cancelled()) return cancelled()
            phase = 'kernel_stop_failed'
            const halt = await (ops.stopSlot || stopSlot)(vm)
            if (!halt?.ok) {
              interrupted = !!vm.node_id && INTERRUPTED_COMMAND.test(halt?.code || '')
              return failure(target, halt?.code || phase, halt?.error || '虚拟机停止失败')
            }
            stopped = true
            // Commit STOPPED immediately, even if replacement or config subsequently fails.
            // Re-read owned fields instead of overwriting credentials changed during drain.
            phase = 'kernel_stop_persist_failed'
            const halted = patchVmRecord(projectRoot, target.id, (record) => {
              record.status = 'stopped'
              record.runtime = { ...record.runtime, ...halt.runtime, stopped: true, pid: null, ip: null }
            })
            if (!halted) return failure(target, 'vm_not_found', '虚拟机记录已移除', true)
            stoppedPersisted = true
            phase = 'kernel_restart_policy_failed'
            // The node's stop operation already disables restart on its own daemon.
            const policy = clusterVm
              ? { ok: true }
              : await (ops.suspendVmRuntimeRestart || suspendVmRuntimeRestart)(halted)
            if (!policy?.ok)
              return failure(target, policy?.code || phase, policy?.error || '无法关闭容器自动重启', true)
            restartSuspended = true
            const candidate = desiredVm(halted, target.kernel)
            const owner = officialCcUidGid(target.id)
            phase = 'kernel_materialize_failed'
            // Pull publishes immutable packages by a synchronous pointer swap. Observe the
            // actual version in the same event-loop turn as the synchronous materializer.
            const installedProduct = currentProduct()
            if (!installedProduct?.ready) {
              return failure(
                target,
                installedProduct?.code || 'kernel_package_missing',
                installedProduct?.error || '内核缓存已变化，请重新拉取',
                true,
              )
            }
            const changedBeforeMaterialize = checkPin(installedProduct, true)
            if (changedBeforeMaterialize) return changedBeforeMaterialize
            let bindingRelease
            if (target.kernel !== 'crag' && typeof releaseStoppedBinding === 'function') {
              phase = 'kernel_selection_persist_failed'
              const selected = patchVmRecord(projectRoot, target.id, (record) => {
                record.dataplane = candidate.dataplane
                delete record.crag_kernel_version
              })
              if (!selected) return failure(target, 'vm_not_found', '虚拟机记录已移除', true)
              // Replacing the preinstalled CRAG package can replace its trust key.
              // Revoke the old permit while that verified package is still present.
              phase = 'crag_subscription_release_failed'
              try {
                bindingRelease = await releaseStoppedBinding(selected)
              } catch (error) {
                return failure(target, error.code || phase, 'CRAG 订阅绑定未能完成释放，请同步订阅状态后重试。', true)
              }
            }
            phase = 'kernel_materialize_failed'
            const baked = !!String(candidate.node_id || '').trim()
            const laid = baked
              ? await (ops.deployBakedKernel || deployBakedKernel)(projectRoot, candidate, target.kernel)
              : await (ops.materializeResolvedKernel || materializeResolvedKernel)(projectRoot, candidate, {
                  ...owner,
                  routing,
                })
            if (!laid?.ok) {
              interrupted = baked && INTERRUPTED_COMMAND.test(laid?.code || '')
              return failure(target, laid?.code || phase, laid?.error || '内核文件安装失败', true)
            }
            phase = 'kernel_seed_failed'
            await (ops.initializeSlotSeedFiles || initializeSlotSeedFiles)(projectRoot, candidate, slotHost(candidate), {
              routing,
            })
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
              if (!updateExisting) {
                record.dataplane = candidate.dataplane
                if (target.kernel === 'crag') record.crag_kernel_version = 'v2'
                else delete record.crag_kernel_version
              }
              record.kernel_installation = {
                kernel: target.kernel,
                version: installedProduct.version ?? null,
                ...(installedProduct.payload_tag ? { payload_tag: installedProduct.payload_tag } : {}),
                installed_at: new Date().toISOString(),
              }
            })
            if (!saved) return failure(target, 'vm_not_found', '虚拟机记录已移除', true)
            if (cancelled()) return cancelled()
            if (keepStopped) {
              patchVmRecord(projectRoot, target.id, clearInstallHold)
              installed = true
              return {
                id: target.id,
                kernel: target.kernel,
                ok: true,
                stopped: true,
                restarted: false,
                status: 'stopped',
                version: installedProduct.version ?? null,
                ...(installedProduct.payload_tag ? { payload_tag: installedProduct.payload_tag } : {}),
              }
            }
            phase = 'kernel_start_failed'
            bootAttempted = true
            const boot = await (ops.startSlotReady || startSlotReady)(saved, projectRoot, {
              routing,
              ...(target.kernel === 'crag' && {
                allowMissingCredential: true,
                ...(!baked && { useInstalledCrag: true }),
              }),
            })
            if (cancelled()) return cancelled()
            if (!healthy(boot) || (target.kernel === 'crag' && boot.rust?.skipped === true)) {
              interrupted = baked && INTERRUPTED_COMMAND.test(boot?.code || '')
              // A healthy container with a failed kernel carries its cause on boot.rust;
              // keep it instead of collapsing every start failure into the generic phase.
              bootFailure = {
                code: boot?.code || boot?.rust?.code || phase,
                error: boot?.error || boot?.rust?.error || '内核重启或健康检查失败',
                reason: boot?.rust?.rust?.reason || boot?.rust?.reason || null,
                at: new Date().toISOString(),
              }
              return failure(target, bootFailure.code, bootFailure.error, true)
            }
            phase = 'kernel_running_persist_failed'
            const running = patchVmRecord(projectRoot, target.id, (record) => markRunning(record, boot, projectRoot))
            if (!running) return failure(target, 'vm_not_found', '虚拟机记录已移除', false)
            installed = true
            stopped = false
            resetHealth(running)
            return {
              id: target.id,
              kernel: target.kernel,
              ok: true,
              stopped: false,
              restarted: true,
              schedulable: running.schedulable,
              status: running.status,
              version: installedProduct.version ?? null,
              ...(installedProduct.payload_tag ? { payload_tag: installedProduct.payload_tag } : {}),
              ...(bindingRelease?.reclaim_pending && { reclaim_pending: true }),
            }
          }
          const run = async () => {
            let result
            let thrown
            try {
              result = await switchKernel()
            } catch (error) {
              thrown = error
            }
            if (rollback && stopped && !installed && restartSuspended) {
              let recovered
              try {
                recovered = await restoreCragRollback({ projectRoot, vm, rollback, routing, ops, bootAttempted })
              } catch {
                // Keep the maintenance hold and the verified backup for an operator.
              }
              const failed = result || failure(target, thrown?.code || phase, '新内核安装或启动失败', true)
              if (recovered) {
                installed = true
                stopped = false
                resetHealth(recovered)
                return {
                  ...failed,
                  stopped: false,
                  rolled_back: true,
                  error: `${failed.error}；已恢复并验证原 CRAG 版本`,
                }
              }
              return { ...failed, rolled_back: false, error: `${failed.error}；未能验证原版本恢复，请检查保留的回滚包` }
            }
            if (thrown) throw thrown
            return result
          }
          const result = keepStopped
            ? await run()
            : await withCragRuntimeAdmission(desired, projectRoot, { routing, install: true }, run)
          return result.id === target.id
            ? result
            : failure(
                target,
                result.code || 'crag_runtime_admission_failed',
                ADMISSION_ERRORS.get(result.code) || result.error || 'CRAG 运行准入失败',
                stopped,
              )
        } catch (error) {
          interrupted = clusterVm && INTERRUPTED_COMMAND.test(error?.code || '')
          return failure(
            target,
            phase,
            stopped && !stoppedPersisted
              ? '虚拟机已停止，但停止状态写入失败；自动恢复保持暂停，请修复记录权限后重装或手动启动'
              : `内核操作失败（${error?.code || phase}），请检查包与文件权限`,
            stopped,
          )
        } finally {
          if (activeInstalls.get(target.id) === active) activeInstalls.delete(target.id)
          releaseCache?.()
          if (control.cancelled) phase = CANCELLED
          if (rollback && !stopped) {
            try {
              fs.rmSync(rollback.backup, { recursive: true, force: true })
            } catch {
              console.warn(`[kernel-install] ${target.id} rollback package cleanup failed`)
            }
          }
          if (operationPersisted && !installed) {
            // Lost acknowledgements retain intent; deterministic failures need operator attention.
            try {
              patchVmRecord(projectRoot, target.id, (record) => {
                if (record.kernel_operation?.id !== operationId) return
                record.kernel_operation.phase = interrupted ? 'pending' : 'failed'
                record.kernel_operation.code = phase
                if (bootFailure) record.kernel_operation.failure = bootFailure
                if (!stopped && !interrupted) clearInstallHold(record)
              })
            } catch {
              console.warn(`[kernel-install] ${target.id} failure state could not be persisted (${phase})`)
            }
          }
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

/** Resume only interrupted commands; the durable marker survives control-plane and SSH loss. */
export async function resumePendingKernelInstalls({
  projectRoot,
  routing = {},
  watchdog,
  poolScheduler,
  releaseStoppedBinding,
  ops = {},
}) {
  const items = []
  for (const summary of listVms(projectRoot)) {
    const vm = getVm(projectRoot, summary.id)
    const pending = vm?.kernel_operation
    if (pending?.phase !== 'pending') continue
    if (vm.node_id && !(ops.nodeReady || ((id) => clusterManager().get(id)?.link?.state === 'ready'))(vm.node_id)) {
      continue
    }
    // A crash during a local switch may have published the candidate already. Keep the
    // original backup and the maintenance hold for inspection instead of replaying blindly.
    if (
      pending.rollback_package ||
      pending.recovery_attempts >= 3 ||
      (vm.schedule_off === true && !pending.schedule_off)
    ) {
      patchVmRecord(projectRoot, vm.id, (record) => {
        if (record.kernel_operation?.id !== pending.id) return
        record.kernel_operation.phase = 'failed'
        record.kernel_operation.code = 'kernel_recovery_interrupted'
      })
      continue
    }
    const result = await installKernelTargets({
      projectRoot,
      targets: [
        {
          id: vm.id,
          kernel: pending.kernel,
          ...(pending.expected_tag ? { expected_tag: pending.expected_tag } : {}),
          ...(pending.payload_tag ? { payload_tag: pending.payload_tag } : {}),
          ...(pending.update_existing ? { update_existing: true } : {}),
        },
      ],
      routing,
      watchdog,
      poolScheduler,
      releaseStoppedBinding,
      ops,
      resumeId: pending.id,
    })
    items.push(...result.items)
  }
  return report(items)
}
