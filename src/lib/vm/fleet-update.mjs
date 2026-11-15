/**
 * Rolling update across all slots. Reloads the guest worker (new shared
 * binary) and/or collects guest identity. Never restarts kin-gateway.
 * Never docker rm. KVM reloads the guest kernel unit, not the runner.
 */
import { listVms, getVm } from './vm-registry.mjs'
import { runtimeKind } from './runtime-kind.mjs'
import { reloadSlotReady, slotExec } from './slot-runtime.mjs'
import { collectSlotIdentity } from './guest-identity.mjs'
import {
  applyCragTelemetryPolicy,
  rustKernelHealth,
  rustKernelPaths,
  supportsCragTelemetryApply,
} from '../transport/rust-kernel-client.mjs'
import { restartRustKernel, wrapHopInflight } from '../transport/rust-kernel-supervisor.mjs'
import path from 'node:path'
import { syncNativeTelemetry } from './vm-runtime.mjs'
import { writeSlotSeedFiles } from './slot-seed.mjs'
import { readVmProxyGeo, writeVmProxyTelemetryEgress } from './native-telemetry.mjs'
import { slotHost } from './slot-host.mjs'
import { readSlotProcessStatus, retireLegacyTelemetry } from './slot-process-status.mjs'
import fs from 'node:fs'
import { withVmLock } from './vm-file.mjs'
import { normalizeVmKind } from './vm-kind.mjs'
import { resolveKernelDataplane } from './slot-engine.mjs'
import { cragV2KernelActive } from '../protocol/crag-print-prompt.mjs'
import { isTelemetryEnabled } from '../protocol/seed-policy.mjs'
import { withSlotMaintenance } from './slot-maintenance.mjs'

function publicationRevision(vm) {
  return JSON.stringify({
    node_id: vm.node_id,
    runtime: vm.runtime,
    runtime_type: vm.runtime_type,
    dataplane: vm.dataplane,
    crag_kernel_version: vm.crag_kernel_version,
    seed_policy: vm.seed_policy,
    proxy: vm.proxy,
    timezone: vm.timezone,
    locale: vm.locale,
    fingerprint: vm.fingerprint,
    kind: normalizeVmKind(vm).kind,
  })
}

function publicationPlacement(vm) {
  return JSON.stringify([
    vm.node_id,
    vm.runtime,
    runtimeKind(vm),
    normalizeVmKind(vm).kind,
    slotHost(vm).native === true,
  ])
}

const ACTIONS = new Set(['collect', 'reload', 'roll', 'telemetry'])

const cragTelemetryErrors = {
  telemetry_policy_not_published: 'CRAG 未读到已发布的槽内设置',
  telemetry_native_settings_blocked: 'Claude Code 槽内设置或 OS 特征阻止开启遥测',
  telemetry_restart_required: '槽内设置已发布；需排空并重启 CRAG 内核',
}

async function verifyCragTelemetry(exec, enabled, timeoutMs) {
  const { status, body } = await applyCragTelemetryPolicy(exec, enabled, { timeoutMs })
  if (
    status === 200 &&
    body?.ok === true &&
    body.applied === true &&
    body.enabled === enabled &&
    body.scope === 'native_claude_launch' &&
    body.upload_confirmed === false
  ) {
    return { ok: true, applied: true, action: 'applied', enabled, scope: body.scope, upload_confirmed: false }
  }
  const code = body?.error?.type
  if (status === 409 && Object.hasOwn(cragTelemetryErrors, code)) {
    return { ok: false, code, error: cragTelemetryErrors[code] }
  }
  return { ok: false, code: 'telemetry_observation_unavailable', error: 'CRAG 未确认原生遥测启动策略' }
}

async function restartForCragTelemetry({ projectRoot, vmPath, current, revision, enabled, timeoutMs, lifecycle, ops }) {
  return withVmLock(vmPath, async () => {
    const record = current()
    const id = record.id
    const changed = () => publicationRevision(current()) !== revision
    const superseded = { ok: false, code: 'telemetry_publication_superseded', error: 'VM 配置已更改，未确认遥测应用' }
    const busy = { ok: false, code: 'telemetry_slot_busy', error: '槽位仍有活动或正在维护，未重启 CRAG' }
    if (changed()) return superseded
    if (record.kernel_operation || record.schedule_hold || record.runtime?.stopped === true) return busy
    const exec = slotExec(projectRoot, record)
    return withSlotMaintenance({
      projectRoot,
      id,
      ...lifecycle,
      drainTimeoutMs: timeoutMs,
      operation: async (tag) => {
        const supersededOperation = () => changed() || current().schedule_hold?.detail?.tag !== tag
        const verified = await verifyCragTelemetry(exec, enabled, timeoutMs)
        if (supersededOperation()) return superseded
        if (verified.code !== 'telemetry_restart_required') return verified
        const observed = await rustKernelHealth(exec, { timeoutMs })
        if (supersededOperation()) return superseded
        if (
          !supportsCragTelemetryApply(observed) ||
          observed.ready === false ||
          observed.recovering === true ||
          !['active', 'waiting', 'queued'].every((key) => observed[key] === 0) ||
          wrapHopInflight(exec) > 0
        )
          return busy
        const configMismatch = {
          ok: false,
          code: 'crag_telemetry_kernel_mismatch',
          error: '槽位启动配置不是 CRAG，未重启内核',
        }
        let kernelConfig
        try {
          kernelConfig = JSON.parse(fs.readFileSync(rustKernelPaths(exec).configPath, 'utf8'))
        } catch {
          return configMismatch
        }
        if (
          kernelConfig?.vm_id !== id ||
          kernelConfig.dataplane !== 'crag' ||
          kernelConfig.runtime_variant !== 'crag-v2'
        )
          return configMismatch
        const restarted = await (ops.restart || restartRustKernel)(exec)
        if (!restarted?.ok) return { ok: false, code: 'telemetry_restart_failed', error: 'CRAG 重启未确认' }
        if (supersededOperation()) return superseded
        const applied = await verifyCragTelemetry(exec, enabled, timeoutMs)
        if (supersededOperation()) return superseded
        return { ...applied, restarted: true }
      },
    })
  })
}

export async function applyNativeTelemetry({
  projectRoot,
  vm,
  routing = {},
  timeoutMs = 6000,
  replaceEnv = false,
  lifecycle,
  ops = {},
} = {}) {
  const initial = { ok: false, wrote: false, published: false, applied: false, state: 'unknown' }
  if (!vm?.id || !projectRoot) return { ...initial, code: 'invalid_vm' }
  const vmPath = path.join(projectRoot, 'vms', `${vm.id}.json`)
  return withVmLock(`seed-publication:${vmPath}`, async () => {
    const result = { ...initial, supported: true }
    const current = () => {
      const record = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
      if (record.id !== vm.id) throw new Error('vm_record_changed')
      return record
    }
    try {
      let record = current()
      let host = slotHost(record)
      if (host.native || normalizeVmKind(record).kind !== 'claude') {
        return {
          ...result,
          supported: false,
          state: 'unsupported',
          code: 'telemetry_unsupported',
          error: '此槽不支持 VM 原生遥测',
        }
      }
      const placement = publicationPlacement(record)
      const retired = await (ops.retire || retireLegacyTelemetry)({ projectRoot, vm: record })
      if (!retired.ok) return { ...result, ...retired, published: false, applied: false }
      record = current()
      if (placement !== publicationPlacement(record)) {
        return { ...result, code: 'telemetry_publication_superseded', error: 'VM placement changed during publication' }
      }
      host = slotHost(record)
      const slotDir = path.join(projectRoot, 'vms', record.id)
      // A node's effective settings are authoritative; never preserve an old controller mirror.
      const existing = await host.seedFiles(record, slotDir)
      const observedPlacement = publicationPlacement(record)
      const exec = slotExec(projectRoot, record)
      const selectedCrag = resolveKernelDataplane(record, routing) === 'crag'
      const health = retired.running ? await rustKernelHealth(exec, { timeoutMs }) : null
      const liveCrag = cragV2KernelActive({ health })
      const crag = selectedCrag || liveCrag
      const supportsApply = selectedCrag && supportsCragTelemetryApply(health)
      record = current()
      if (observedPlacement !== publicationPlacement(record)) {
        return { ...result, code: 'telemetry_publication_superseded', error: 'VM placement changed during publication' }
      }
      const revision = publicationRevision(record)
      result.seed = writeSlotSeedFiles(projectRoot, record, null, {
        existingSettings: existing.files['settings.json'] === null ? {} : JSON.parse(existing.files['settings.json']),
        replaceEnv,
        cragNativeTelemetry: supportsApply,
      })
      result.wrote = result.seed.wrote === true
      if (crag) {
        const publication = await host.syncSeed(record, slotDir)
        if (publication?.published !== true)
          return {
            ...result,
            code: 'telemetry_publish_failed',
            error: 'VM configuration publication was not confirmed',
          }
        result.published = true
        const superseded = {
          ...result,
          code: 'telemetry_publication_superseded',
          error: 'VM 配置已更改，未确认遥测应用',
        }
        if (publicationRevision(current()) !== revision) return superseded
        if (!retired.running) return { ...result, ok: true, action: 'published', state: 'stopped' }
        if (!supportsApply)
          return { ...result, code: 'crag_telemetry_apply_unavailable', error: '运行中的 CRAG 不支持遥测生效路由' }
        const enabled = isTelemetryEnabled(record.seed_policy)
        const verified = await verifyCragTelemetry(exec, enabled, timeoutMs)
        if (publicationRevision(current()) !== revision) return superseded
        if (verified.code !== 'telemetry_restart_required' || !lifecycle) return { ...result, ...verified }
        const restarted = await restartForCragTelemetry({
          projectRoot,
          vmPath,
          current,
          revision,
          enabled,
          timeoutMs,
          lifecycle,
          ops,
        })
        if (publicationRevision(current()) !== revision) return superseded
        return { ...result, ...restarted }
      }
      const written = syncNativeTelemetry(record, projectRoot, routing, { publish: false })
      if (!written.supported || !written.wrote) return { ...result, code: written.error || 'telemetry_config_failed' }
      const geo = readVmProxyGeo(record)
      const egress = writeVmProxyTelemetryEgress(projectRoot, record, geo)
      if (geo && !egress.wrote && egress.reason !== 'proxy_geo_unavailable') {
        return { ...result, code: egress.reason || 'telemetry_egress_write_failed', published: false, applied: false }
      }
      result.egress = { wrote: egress.wrote, overwritten: egress.overwritten, reason: egress.reason || null }
      const publication = await host.syncTelemetry(record, slotDir)
      if (publication?.published !== true)
        return { ...result, code: 'telemetry_publish_failed', error: 'VM configuration publication was not confirmed' }
      result.published = true
      if (publicationRevision(current()) !== revision) {
        return {
          ...result,
          code: 'telemetry_publication_superseded',
          error: 'VM configuration changed during publication',
        }
      }
      if (!retired.running) return { ...result, ok: true, action: 'published', state: 'stopped' }
      const deadline = Date.now() + timeoutMs
      do {
        const { telemetry } = await readSlotProcessStatus({ projectRoot, vm: record })
        if (publicationRevision(current()) !== revision) {
          return {
            ...result,
            code: 'telemetry_publication_superseded',
            error: 'VM configuration changed during observation',
          }
        }
        if (
          telemetry?.enabled === written.enabled &&
          (written.enabled || (telemetry.state === 'disabled' && telemetry.pending_events === 0))
        ) {
          return { ...result, ...telemetry, ok: true, action: 'applied', applied: true }
        }
        await sleep(100)
      } while (Date.now() < deadline)
      return { ...result, code: 'telemetry_not_ready', error: 'native telemetry did not acknowledge policy' }
    } catch {
      return {
        ...result,
        code: result.published
          ? 'telemetry_observation_unavailable'
          : result.wrote
            ? 'telemetry_publish_failed'
            : 'telemetry_config_failed',
        error: 'VM telemetry configuration is unavailable',
      }
    }
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isWorkerProcessUp(health) {
  if (!health || health.transportError || health.code === 'worker_unavailable') return false
  if (health.vm_id) return true
  if (health.status === 'ready' || health.status === 'degraded') return true
  if (health.status === 200) return true
  return health.ok === true
}

export async function waitWorkerReady(exec, { timeoutMs = 15000, healthFn = rustKernelHealth } = {}) {
  const started = Date.now()
  let last = { ok: false, error: 'worker_not_ready' }
  while (Date.now() - started < timeoutMs) {
    last = await healthFn(exec, { timeoutMs: 1500 })
    if (isWorkerProcessUp(last)) return { ok: true, health: last }
    await sleep(400)
  }
  return { ok: false, error: last?.error || last?.code || 'worker_not_ready', health: last }
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const n = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1))
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      out[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()))
  return out
}

export function selectFleetTargets(projectRoot, ids = null) {
  const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map((id) => String(id))) : null
  return listVms(projectRoot)
    .filter((vm) => !wanted || wanted.has(vm.id))
    .map((vm) => getVm(projectRoot, vm.id) || vm)
}

export async function updateOneSlot(
  projectRoot,
  vm,
  {
    action = 'roll',
    routing = {},
    reloadFn = reloadSlotReady,
    collectFn = collectSlotIdentity,
    healthFn = rustKernelHealth,
    telemetryFn,
    telemetryEnabled,
    readyTimeoutMs = 15000,
    telemetryLifecycle,
  } = {},
) {
  const id = vm.id
  const kind = runtimeKind(vm)
  const result = { id, ok: false, action, runtime_kind: kind }
  try {
    if (action === 'reload' || action === 'roll') {
      const reloaded = await reloadFn(vm, projectRoot, { routing })
      result.reload = reloaded
      if (!reloaded?.ok) {
        result.error = reloaded?.error || 'reload failed'
        result.code = reloaded?.code || 'reload_failed'
        return result
      }
      const ready = await waitWorkerReady(slotExec(projectRoot, vm), {
        timeoutMs: readyTimeoutMs,
        healthFn,
      })
      result.ready = !!ready.ok
      if (!ready.ok && action === 'reload') {
        result.error = ready.error || 'worker_not_ready'
        return result
      }
    }
    if (action === 'telemetry') {
      const enabled =
        telemetryEnabled === undefined ? vm.seed_policy?.telemetry_disabled === false : telemetryEnabled === true
      const vmRef = getVm(projectRoot, id) || vm
      const changed = telemetryFn
        ? await telemetryFn({ projectRoot, vm: vmRef, telemetryEnabled: enabled, enabled })
        : await applyNativeTelemetry({ projectRoot, vm: vmRef, routing, lifecycle: telemetryLifecycle })
      result.telemetry = changed
      if (changed?.skipped) {
        result.skipped = true
        result.skip_reason = changed.reason || 'container_unavailable'
        result.ok = true
        return result
      }
      if (!changed?.ok) {
        result.error = changed?.error || 'telemetry service update failed'
        result.code = changed?.code || 'telemetry_update_failed'
        return result
      }
    }
    if (action === 'collect' || action === 'roll') {
      const collected = await collectFn(projectRoot, getVm(projectRoot, id) || vm)
      result.collect = collected
      if (!collected?.ok) {
        result.error = collected?.error || 'collect failed'
        result.code = collected?.code || 'collect_failed'
        return result
      }
    }
    result.ok = true
    return result
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 300)
    return result
  }
}

export async function runFleetUpdate(
  projectRoot,
  {
    action = 'roll',
    ids = null,
    concurrency = 4,
    routing = {},
    reloadFn,
    collectFn,
    healthFn,
    telemetryFn,
    telemetryEnabled,
    readyTimeoutMs,
    telemetryLifecycle,
  } = {},
) {
  const nextAction = ACTIONS.has(action) ? action : 'roll'
  const conc = Math.max(1, Math.min(8, Number(concurrency) || 4))
  const targets = selectFleetTargets(projectRoot, ids)
  const items = await mapPool(targets, conc, (vm) =>
    updateOneSlot(projectRoot, vm, {
      action: nextAction,
      routing,
      reloadFn,
      collectFn,
      healthFn,
      telemetryFn,
      telemetryEnabled,
      readyTimeoutMs,
      telemetryLifecycle,
    }),
  )
  const okCount = items.filter((row) => row.ok).length
  const skippedCount = items.filter((row) => row.skipped).length
  return {
    action: nextAction,
    concurrency: conc,
    total: items.length,
    ok_count: okCount,
    skipped_count: skippedCount,
    failed_count: items.length - okCount,
    items,
  }
}

export function fleetStatus(projectRoot) {
  return listVms(projectRoot).map((vm) => {
    const fp = vm.fingerprint || {}
    return {
      id: vm.id,
      runtime_kind: runtimeKind(vm),
      status: vm.status || null,
      worker: vm.runtime?.worker || null,
      hostname: fp.hostname || vm.runtime?.guest_hostname || vm.runtime?.hostname || null,
      os_pretty: fp.os_pretty || vm.runtime?.guest_os || vm.runtime?.os || null,
      kernel_release: fp.kernel_release || vm.runtime?.guest_kernel || null,
      worker_version: fp.worker_version || null,
      collected_at: fp.collected_at || vm.runtime?.identity_collected_at || null,
      source: fp.source || null,
    }
  })
}
