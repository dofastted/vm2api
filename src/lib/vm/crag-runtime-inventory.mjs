import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { isNativeNodeVm, vmNodeId } from '../cluster/placement.mjs'
import { observeWatchdogContainer, watchdogProbeVm } from '../transport/kernel-watchdog.mjs'
import { rustKernelHealth, rustKernelPaths, rustKernelReachable } from '../transport/rust-kernel-client.mjs'
import { checkCragLicense, getCragLicense, readCragSubscriptionReleaseCandidate } from './crag-license.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { normalizeKernelDataplane, resolveKernelDataplane } from './slot-engine.mjs'
import { slotExec } from './slot-runtime.mjs'
import { isCodexVm } from './vm-kind.mjs'

const CACHE_TTL_MS = 2000
const MAX_PROBES = 8
const CONTAINER_TIMEOUT_MS = 1500
const HEALTH_TIMEOUT_MS = 2500
const MAX_H2_SLOTS = 10_000
const CONFIRMED_STOPPED = new Set(['stopped', 'missing'])
const STANDARD_VARIANTS = new Set(['wrap', 'cli-node', 'cc-node', 'standard'])
const MAX_CONFIG_BYTES = 1024 * 1024
const PUBLIC_VERSION = /^v?\d{1,5}\.\d{1,5}\.\d{1,5}(?:-native-v\d{1,3})?$/
const EXPIRED = Symbol('snapshot_expired')
const probeWaiters = new Set()
let activeProbes = 0

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)
const unknown = (state = 'unknown') => ({
  state,
  reachable: false,
  version: null,
  active_requests: null,
  queued: null,
  ready_slots: null,
})
const cragIdentity = (value) =>
  value?.runtime_variant === 'crag-v2' || (value?.runtime_variant == null && value?.dataplane === 'crag')
const localDocker = (vm) => process.platform === 'linux' && !vmNodeId(vm) && !isKvmRuntime(vm)

function healthObservation(value) {
  if (cragIdentity(value)) {
    if (
      value.internalTokenAuthenticated !== true ||
      !((value.status === 200 && value.ok === true) || value.status === 503)
    )
      return unknown()
    const readySlots = count(value.ready_slots)
    const version = value.worker_version ?? value.version
    return {
      state: 'running',
      reachable: value.status === 200 && value.license_valid === true && rustKernelReachable(value),
      version: typeof version === 'string' && PUBLIC_VERSION.test(version) ? version : null,
      active_requests: count(value.active_requests),
      queued: count(value.queued),
      ready_slots: readySlots,
    }
  }
  const plane = normalizeKernelDataplane(value?.dataplane, { inherit: true })
  const variant = value?.runtime_variant
  const standard =
    plane !== 'crag' && (variant == null ? plane === 'wrap' || plane === 'cc' : STANDARD_VARIANTS.has(variant))
  if (value?.status !== 200 || value.ok !== true || !standard) return unknown()
  const negative = unknown('not_running')
  // Status still reports an identifiable standard worker as non-CRAG when
  // unhealthy, but it is not strong enough evidence to free runtime capacity.
  return value.healthy === true ? { ...negative, non_crag_confirmed: true } : negative
}

function within(promise, signal) {
  if (signal.aborted) return Promise.resolve(EXPIRED)
  return new Promise((resolve, reject) => {
    const aborted = () => resolve(EXPIRED)
    signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted))
  })
}

async function boundedProbe(timeoutMs, run) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await within(run({ timeoutMs, signal: controller.signal }), controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

function acquireProbe(signal) {
  return new Promise((resolve) => {
    const finish = (release) => {
      probeWaiters.delete(attempt)
      signal.removeEventListener('abort', aborted)
      resolve(release)
    }
    const aborted = () => finish(null)
    const attempt = () => {
      if (signal.aborted) return finish(null)
      if (activeProbes >= MAX_PROBES) return
      activeProbes++
      finish(() => {
        activeProbes--
        for (const waiter of probeWaiters) {
          if (activeProbes >= MAX_PROBES) break
          waiter()
        }
      })
    }
    probeWaiters.add(attempt)
    signal.addEventListener('abort', aborted, { once: true })
    attempt()
  })
}

function inventoryExec(projectRoot, vm) {
  const exec = slotExec(projectRoot, vm)
  return { ...exec, runRoot: String(process.env.KIN_SLOT_RUN_ROOT || '').trim() }
}

function socketEntry(socketPath) {
  try {
    return fs.lstatSync(socketPath).isSocket() ? 'socket' : 'other'
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : 'other'
  }
}

function directSocket(exec) {
  if (!localDocker(exec.vm)) return false
  const expected = exec.runRoot
    ? path.resolve(exec.runRoot, exec.vm.id)
    : path.resolve(exec.projectRoot, 'vms', exec.vm.id, 'run')
  const { socketPath, tokenPath } = rustKernelPaths(exec)
  if (
    path.resolve(socketPath) !== path.join(expected, 'kernel.sock') ||
    path.resolve(tokenPath) !== path.join(expected, 'internal.token')
  )
    return false
  try {
    return (
      fs.realpathSync(expected) === expected && fs.lstatSync(tokenPath).isFile() && socketEntry(socketPath) !== 'other'
    )
  } catch {
    return false
  }
}

function publishedConfig(exec) {
  let fd
  try {
    fd = fs.openSync(
      rustKernelPaths(exec).configPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    )
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return { key: 'not_regular_config', crag: false }
    const buf = Buffer.alloc(stat.size + 1)
    const length = fs.readSync(fd, buf)
    if (length !== stat.size) return { key: 'changing_config', crag: false }
    const bytes = buf.subarray(0, length)
    let config
    try {
      config = JSON.parse(bytes.toString('utf8'))
    } catch {
      config = null
    }
    return {
      key: createHash('sha256').update(bytes).digest('hex'),
      crag: config?.dataplane === 'crag' || cragIdentity(config),
    }
  } catch (error) {
    return { key: `unreadable:${error.code}`, crag: false }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function subscriptionScope(projectRoot, vm, hostId) {
  let permit = null
  let permitError = false
  if (!isNativeNodeVm(vm)) {
    try {
      permit = readCragSubscriptionReleaseCandidate(projectRoot, vm, hostId)
    } catch {
      permitError = true
    }
  }
  return { permit, permitError }
}

function hostQuota({ hostId, claims, pending }, running, uncertain, now) {
  if (pending) return { host_runtime_available: null, host_over_limit: null }
  const seconds = Math.floor(now / 1000)
  if (!claims) return { host_runtime_available: 0, host_over_limit: null }
  const { version, slot_limit: slots, issued_at: issued, expires_at: expires } = claims
  if (
    ![1, 2].includes(version) ||
    claims.host_id !== hostId ||
    claims.product !== 'crag-v2' ||
    count(expires) === null ||
    count(issued) === null ||
    issued > seconds ||
    expires <= issued ||
    (slots !== 'unlimited' && (count(slots) === null || slots < 1 || slots > 2_147_483_647))
  )
    return { host_runtime_available: null, host_over_limit: null }
  if (expires <= seconds) return { host_runtime_available: 0, host_over_limit: null }
  if (version === 1 && slots === 'unlimited') return { host_runtime_available: 'unlimited', host_over_limit: false }
  const limit = version === 2 ? (slots === 'unlimited' ? MAX_H2_SLOTS : Math.min(slots, MAX_H2_SLOTS)) : slots
  const available = Math.max(0, limit - running)
  return {
    host_runtime_available: uncertain > 0 && available > 0 ? null : available,
    host_over_limit: running > limit ? true : running + uncertain <= limit ? false : null,
  }
}

export function createCragRuntimeInventory({
  projectRoot,
  listTargets,
  getRouting,
  observe = observeWatchdogContainer,
  health = rustKernelHealth,
  now = Date.now,
}) {
  const cache = new Map()

  async function probe(vm) {
    try {
      const physical = await boundedProbe(CONTAINER_TIMEOUT_MS, (options) => observe(vm, options))
      if (CONFIRMED_STOPPED.has(physical?.state)) return { ...unknown('not_running'), stopped_confirmed: true }
      if (physical?.state === 'paused' || physical?.state === 'restarting') return unknown('not_running')
      if (physical?.state !== 'running') return unknown()
      const target = watchdogProbeVm(vm, { exists: (socket) => socketEntry(socket) === 'socket' })
      if (!target) return unknown()
      const exec = inventoryExec(projectRoot, target)
      // A local KVM runner publishes the guest relay under its run mount, not
      // at an older Docker socket path retained in the slot record.
      if (!vmNodeId(target) && isKvmRuntime(target)) {
        const { runDir } = rustKernelPaths(exec)
        exec.vm = {
          ...target,
          runtime: {
            ...target.runtime,
            kernel_socket: path.join(runDir, 'kernel.sock'),
            worker_token_file: path.join(runDir, 'internal.token'),
          },
        }
        if (socketEntry(exec.vm.runtime.kernel_socket) !== 'socket') return unknown()
      }
      const direct = directSocket(exec)
      const observed = await boundedProbe(HEALTH_TIMEOUT_MS, (options) =>
        health(exec, {
          ...options,
          requireInternalToken: true,
        }),
      )
      if (direct && observed?.status === 0 && ['ENOENT', 'ECONNREFUSED'].includes(observed.code) && directSocket(exec))
        return unknown('not_running')
      return healthObservation(observed)
    } catch {
      return unknown()
    }
  }

  function cached(candidate) {
    const entry = cache.get(candidate.vm.id)
    if (entry?.key !== candidate.key) return null
    if (entry.promise) return entry.promise
    const age = now() - entry.at
    if (candidate.recheckNegative && entry.result?.state === 'not_running') return null
    return age >= 0 && age < CACHE_TTL_MS ? Promise.resolve(entry.result) : null
  }

  async function readProbe(candidate, signal, fresh) {
    // Admission must not borrow a probe that started before this snapshot.
    let result = fresh ? null : cached(candidate)
    if (result) return within(result, signal)
    const release = await acquireProbe(signal)
    if (!release) return EXPIRED
    result = fresh ? null : cached(candidate)
    if (result || signal.aborted) {
      release()
      return result ? within(result, signal) : EXPIRED
    }
    const entry = { key: candidate.key }
    entry.promise = Promise.resolve()
      .then(() => probe(candidate.vm))
      .then((observed) => {
        entry.result = observed
        entry.at = now()
        entry.promise = null
        return observed
      })
      .finally(release)
    if (!fresh) cache.set(candidate.vm.id, entry)
    return within(entry.promise, signal)
  }

  async function snapshot({ hostId, claims, pending, hostOnly = false, currentHop, timeoutMs, fresh = false } = {}) {
    const controller = new AbortController()
    const deadline = Number.isFinite(timeoutMs) ? performance.now() + Math.max(0, timeoutMs) : Infinity
    const expired = () => {
      if (performance.now() >= deadline) controller.abort()
      return controller.signal.aborted
    }
    const timer = Number.isFinite(deadline) ? setTimeout(() => controller.abort(), Math.max(0, timeoutMs)) : null
    try {
      const listed = listTargets()
      const targets = Array.isArray(listed) ? listed : await within(listed, controller.signal)
      if (!Array.isArray(targets)) throw new Error('crag_runtime_inventory_unavailable')
      const routing = getRouting ? await within(getRouting(), controller.signal) : {}
      if (routing === EXPIRED) throw new Error('crag_runtime_inventory_unavailable')
      const registered = new Map()
      for (const vm of targets) {
        if (
          !vm ||
          typeof vm.id !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(vm.id) ||
          vm.id === '..' ||
          isCodexVm(vm) ||
          isNativeNodeVm(vm) ||
          (!vmNodeId(vm) && process.platform !== 'linux')
        )
          continue
        registered.set(vm.id, structuredClone(vm))
      }
      for (const id of cache.keys()) if (!registered.has(id)) cache.delete(id)
      const hopHealth = currentHop?.health
      const candidates = []
      const selectedVms = new Map()
      for (const vm of registered.values()) {
        const scope = subscriptionScope(projectRoot, vm, hostId)
        if (hostOnly && !scope.permit && !scope.permitError) continue
        const exec = inventoryExec(projectRoot, vm)
        const published = publishedConfig(exec)
        const selected = resolveKernelDataplane(vm, routing) === 'crag'
        const expected = selected || published.crag || !!scope.permit || scope.permitError
        if (!hostOnly && !expected && vm.status !== 'running') continue
        const candidate = {
          vm,
          permit: scope.permit,
          watchOnly: !expected,
          // Ordinary readiness can trigger a strict recheck, but never prove CRAG is live.
          recheckNegative: vm.id === currentHop?.id && hopHealth?.status === 200 && cragIdentity(hopHealth),
          key: JSON.stringify([
            vm.id,
            vm.updated_at,
            vm.status,
            vm.node_id,
            vm.runtime,
            vm.runtime_type,
            vm.dataplane,
            vm.crag_kernel_version,
            vm.inference_engine,
            routing?.inference,
            exec.runRoot,
            published.key,
          ]),
        }
        candidates.push(candidate)
        selectedVms.set(vm.id, candidate)
      }
      const hop = !fresh && currentHop?.id ? healthObservation(currentHop.health) : null
      const hasHopEvidence = (vm, scope) => !!scope.permit && vm.id === currentHop?.id && hop?.state === 'running'
      const observations = new Map()
      let next = 0
      async function worker() {
        while (next < candidates.length && !expired()) {
          const candidate = candidates[next++]
          // An accepted hop already observed this same slot. Do not replace
          // that evidence with an older cached negative or put it in the cache.
          if (hasHopEvidence(candidate.vm, candidate)) continue
          const result = await readProbe(candidate, controller.signal, fresh)
          if (result === EXPIRED) return
          observations.set(candidate.vm.id, result)
        }
      }
      await Promise.all(Array.from({ length: Math.min(MAX_PROBES, candidates.length) }, () => worker()))
      const entries = []
      let hostRunning = 0
      let hostUnknown = 0
      let anyKnown = false
      for (const vm of registered.values()) {
        const candidate = selectedVms.get(vm.id)
        // A permit may have been installed while another slot was probed.
        // Without an observation it belongs in the upper bound, not outside it.
        const scope = subscriptionScope(projectRoot, vm, hostId)
        if ((hostOnly || !candidate) && !scope.permit && !scope.permitError) continue
        const observed = hasHopEvidence(vm, scope) ? hop : observations.get(vm.id) || unknown()
        if (observed.state !== 'unknown') anyKnown = true
        if (candidate?.watchOnly && !scope.permit && !scope.permitError && observed.state !== 'running') continue
        if (scope.permit && observed.state === 'running') hostRunning++
        if ((scope.permit && observed.state === 'unknown') || (scope.permitError && observed.state !== 'not_running'))
          hostUnknown++
        const hostBound = !!scope.permit || scope.permitError
        const license =
          observed.state === 'running' || scope.permit
            ? checkCragLicense(projectRoot, { ...vm, dataplane: 'crag', crag_kernel_version: 'v2' }, routing)
            : null
        const grantScope = (
          license?.license ?? (!scope.permit && !scope.permitError ? getCragLicense(projectRoot, vm).license : null)
        )?.scope
        const independent = ['device', 'kernel'].includes(grantScope)
        entries.push([
          vm.id,
          {
            state: observed.state,
            ...(observed.stopped_confirmed === true ? { stopped_confirmed: true } : {}),
            ...(observed.non_crag_confirmed === true ? { non_crag_confirmed: true } : {}),
            ready:
              observed.reachable &&
              license?.ok === true &&
              vm.schedulable !== false &&
              (!hostBound || (!!scope.permit && !!claims && !pending)),
            ...(license?.code === 'license_crag_host_over_quota' && { quota_blocked: true }),
            scope: scope.permit ? 'host' : !scope.permitError && independent ? 'independent' : 'unknown',
            version: observed.version,
            active_requests: observed.active_requests,
            queued: observed.queued,
            ready_slots: observed.ready_slots,
          },
        ])
      }
      // Status must not present a wholly failed sample as a verified zero.
      // Admission still needs the upper bound when every host observation is unknown.
      if (!hostOnly && (candidates.length > 0 || entries.length > 0) && !anyKnown)
        throw new Error('crag_runtime_inventory_unavailable')
      const checkedAt = now()
      const quota = hostQuota({ hostId, claims, pending }, hostRunning, hostUnknown, checkedAt)
      return {
        running_vms: entries.filter(([, value]) => value.state === 'running').length,
        ready_vms: entries.filter(([, value]) => value.ready).length,
        unknown_vms: entries.filter(([, value]) => value.state === 'unknown').length,
        host_running_vms: hostRunning,
        host_unknown_vms: hostUnknown,
        ...quota,
        checked_at: new Date(checkedAt).toISOString(),
        vms: Object.fromEntries(entries.map(([id, value]) => [id, value])),
      }
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  async function confirmReclaimableStop(vm) {
    const actual = await boundedProbe(CONTAINER_TIMEOUT_MS, (options) => observe(vm, options))
    return actual?.state === 'missing' || (actual?.state === 'stopped' && actual.restartDisabled === true)
  }

  return { snapshot, confirmReclaimableStop }
}
