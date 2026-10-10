/**
 * Rolling update across all slots. Reloads the guest worker (new shared
 * binary) and/or collects guest identity. Never restarts kin-gateway.
 * Never docker rm. KVM reloads the guest kernel unit, not the runner.
 */
import { listVms, getVm } from './vm-registry.mjs'
import { runtimeKind } from './runtime-kind.mjs'
import { reloadSlotReady, slotExec } from './slot-runtime.mjs'
import { collectSlotIdentity } from './guest-identity.mjs'
import { rustKernelHealth } from '../transport/rust-kernel-client.mjs'

const ACTIONS = new Set(['collect', 'reload', 'roll'])

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
    readyTimeoutMs = 15000,
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
  { action = 'roll', ids = null, concurrency = 4, routing = {}, reloadFn, collectFn, healthFn, readyTimeoutMs } = {},
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
      readyTimeoutMs,
    }),
  )
  const okCount = items.filter((row) => row.ok).length
  return {
    action: nextAction,
    concurrency: conc,
    total: items.length,
    ok_count: okCount,
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
