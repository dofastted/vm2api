/**
 * Rust gateway-worker lifecycle. kin-kernel is container PID 1.
 * Host writes credentials; slot kernel only reads AT for inference.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  rustKernelHealth,
  rustKernelPaths,
  rustKernelProcessUp,
  rustKernelReachable,
  rustKernelBusy,
} from './rust-kernel-client.mjs'
import { streamIdleTimeoutMs } from '../core/config.mjs'
import { OFFICIAL_CLI_VERSION } from '../identity/vm-identity.mjs'
import { cacheTtlFromRouting, normalizeCacheTtl } from '../protocol/cache-ttl.mjs'
import { setVmSchedulable, listVms, getVm } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { isKvmRuntime, runtimeKind } from '../vm/runtime-kind.mjs'
import { slotExecArgv } from '../vm/slot-exec.mjs'
import {
  CONTAINER_CLI_NODE_BIN,
  KERNEL_NATIVE_SLOT_COUNT,
  resolveCliSystemLayout,
  resolveKernelDataplane,
  resolveSlotPersonaPreset,
} from '../vm/slot-engine.mjs'
import {
  ensureOfficialCredentialLink,
  ensureSlotSubscriptionType,
  slotUidGidFromHomeDir,
  chownSlotRuntimeFile,
  replaceSlotOwnedFile,
} from '../oauth/oauth-credentials.mjs'
import { slotHost } from '../vm/slot-host.mjs'

const starts = new Map()
const KVM_HEALTH_MS = { kvm: 120_000, tcg: 480_000 }

function execArgv(exec, argv, opts) {
  return slotExecArgv(exec?.vm || { id: exec?.vmId }, argv, opts)
}

function kvmBootBudget(vm, timeoutMs) {
  const accel = vm?.runtime?.accel === 'kvm' ? 'kvm' : 'tcg'
  return Math.max(Number(timeoutMs) || 0, KVM_HEALTH_MS[accel])
}

/** Bind the VM's docker daemon into an injectable runner. */
function slotRunner(exec, run) {
  const env = slotHost(exec?.vm).dockerEnv()
  if (!env) return run
  return (args, opts = {}) => run(args, { ...opts, env })
}
const CONTAINER_KERNEL_BIN = '/home/kincli/.kin/kin-kernel'
const CONTAINER_KERNEL_CONFIG = '/run/kin/kernel.json'
export const CONTAINER_CLAUDE_BIN = CONTAINER_CLI_NODE_BIN

export const WRAP_SLOT_MIN = 1
export const WRAP_SLOT_MAX = KERNEL_NATIVE_SLOT_COUNT
export const WEDGED_READY_WAIT_MS = 3000

/** Pre-open native slots. 20 multiplexed CLI streams over one residential SOCKS incomplete-storm. */
export function wrapSlotCount(_vm = {}, _routing = {}) {
  return WRAP_SLOT_MAX
}

function startCurrent(control) {
  return control.cancelled !== true
}

export function kernelBinPath() {
  return String(process.env.KIN_KERNEL_BIN || '').trim()
}

export function slotContainerName(exec = {}) {
  const configured = String(exec?.vm?.runtime?.container || '').trim()
  if (configured) return configured
  const vmId = exec?.vmId || exec?.vm?.id || ''
  return vmId ? `kin-${String(vmId).replace(/^vm-/, '')}` : ''
}

function syncKernelSlotCount(configPath) {
  const prev = readExistingKernelConfig(configPath)
  if (!prev || typeof prev !== 'object') return false
  if (Number(prev.slots_per_worker) === WRAP_SLOT_MAX) return false
  prev.slots_per_worker = WRAP_SLOT_MAX
  try {
    fs.writeFileSync(configPath, JSON.stringify(prev, null, 2) + '\n', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}
export function readExistingKernelConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

/** crag and cc run cc-node. Restarting that slot SIGKILLs the worker. */
export function dataplaneUsesCcNode(exec) {
  const configPath = rustKernelPaths(exec).configPath
  if (!configPath) return false
  const plane = String(readExistingKernelConfig(configPath).dataplane || '')
    .trim()
    .toLowerCase()
  return plane === 'crag' || plane === 'cc' || plane === 'cc-node'
}
function projectRootFromExec(exec = {}) {
  if (exec?.projectRoot) return exec.projectRoot
  const home = String(exec?.homeDir || '')
  const marker = `${path.sep}vms${path.sep}`
  const at = home.indexOf(marker)
  if (at > 0) return home.slice(0, at)
  return ''
}

/**
 * Already-up kernels can still have unreaped zombies, or a leftover UI
 * `paused` mark while schedulable is true. CONNECT bridges are gone.
 */
export async function reconcileCliHopRuntime(exec, { runDockerExec = runDocker } = {}) {
  const container = slotContainerName(exec)
  if (!container) return { ok: false, reason: 'missing' }
  const actions = []
  await runDockerExec(execArgv(exec, ['kill', '-CHLD', '1']), { timeoutMs: 2000 })
  actions.push('reap_zombies')
  const root = projectRootFromExec(exec)
  const vmId = exec?.vmId || exec?.vm?.id
  if (root && vmId && exec?.vm?.schedulable !== false && String(exec?.vm?.status || '').toLowerCase() === 'paused') {
    setVmSchedulable(root, vmId, true)
    actions.push('status_running')
  }
  return { ok: true, actions, reason: 'transparent_egress' }
}

export function stopRustKernel(exec = {}) {
  const container = slotContainerName(exec)
  if (!container) return { ok: false, reason: 'container_missing' }
  const env = slotHost(exec?.vm).dockerEnv()
  const result = spawnSync(
    process.env.KIN_DOCKER_BIN || 'docker',
    execArgv(exec, [
      'sh',
      '-lc',
      'kill $(pidof kin-kernel) >/dev/null 2>&1 || true; kill $(pidof bun) >/dev/null 2>&1 || true',
    ]),
    { encoding: 'utf8', timeout: 5000, ...(env ? { env } : {}) },
  )
  return { ok: result.status === 0, code: result.status }
}

function runDocker(args, { timeoutMs = 5000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.env.KIN_DOCKER_BIN || 'docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    })
    const stdout = []
    const stderr = []
    const keep = (chunks, value) => {
      chunks.push(String(value))
      if (chunks.length > 20) chunks.shift()
    }
    child.stdout?.on?.('data', (value) => keep(stdout, value))
    child.stderr?.on?.('data', (value) => keep(stderr, value))
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(
      () => {
        try {
          child.kill('SIGKILL')
        } catch {}
        finish({ ok: false, error: `docker exec timeout after ${timeoutMs}ms` })
      },
      Math.max(200, Number(timeoutMs) || 5000),
    )
    timer.unref?.()
    child.once('error', (error) => finish({ ok: false, error: String(error?.message || error).slice(0, 300) }))
    child.once('close', (code) =>
      finish({
        ok: code === 0,
        code,
        stdout: stdout.join('').trim(),
        error: stderr.join('').trim().slice(0, 300),
      }),
    )
  })
}

async function waitForHealth(exec, timeoutMs) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 8000)
  let last = { ok: false, reason: 'not_ready' }
  while (Date.now() < deadline) {
    last = await rustKernelHealth(exec, { timeoutMs: 400 })
    if (rustKernelReachable(last)) return { ok: true, reason: 'started_in_vm', health: last }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  return { ok: false, reason: 'health_timeout', health: last, error: last?.error || 'rust kernel health timeout' }
}

async function kernelProcessAlive(exec, runDockerExec) {
  const container = slotContainerName(exec)
  if (!container) return false
  const result = await runDockerExec(
    execArgv(exec, [
      'sh',
      '-c',
      'pgrep -f /home/kincli/.kin/kin-kernel.bin >/dev/null || pgrep -f /home/kincli/.kin/kin-kernel >/dev/null || pidof kin-kernel >/dev/null',
    ]),
    { timeoutMs: 1500 },
  )
  return result?.ok === true
}

async function waitForHealthOrExit(exec, { timeoutMs, container, runDockerExec, control }) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 8000)
  const started = Date.now()
  let last = { ok: false, reason: 'not_ready' }
  let checkedProcess = false
  while (Date.now() < deadline) {
    if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
    last = await rustKernelHealth(exec, { timeoutMs: 400 })
    if (rustKernelReachable(last)) return { ok: true, reason: 'started_in_vm', health: last }
    // KVM guest boot is minutes under TCG; a missing process at 1.2s is not failure.
    if (!isKvmRuntime(exec?.vm) && !checkedProcess && Date.now() - started >= 1200 && container) {
      checkedProcess = true
      const alive = await kernelProcessAlive(exec, runDockerExec)
      if (!alive) {
        return {
          ok: false,
          reason: 'start_failed',
          error: last?.error || 'kernel process exited',
          health: last,
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  return { ok: false, reason: 'health_timeout', health: last, error: last?.error || 'rust kernel health timeout' }
}

export async function ensureRustKernel(exec, { timeoutMs = 30000, runDockerExec = runDocker, force = false } = {}) {
  const vmId = exec?.vmId || exec?.vm?.id || 'unknown'
  const pending = starts.get(vmId)
  if (pending && !force) return pending.promise
  const control = { cancelled: false }
  const run = slotRunner(exec, runDockerExec)
  const promise = startRustKernel(exec, { timeoutMs, vmId, control, runDockerExec: run, force })
  const start = { promise, control }
  starts.set(vmId, start)
  try {
    return await promise
  } finally {
    if (starts.get(vmId) === start) starts.delete(vmId)
  }
}

async function killWrapDataplane(exec, runDockerExec) {
  const container = slotContainerName(exec)
  if (!container) return
  // Match /proc/pid/exe, not pkill -f. The docker exec shell's own argv
  // contains these paths, so pkill -f signals that shell and can return
  // before the running cli-node dies. The old inode then keeps serving.
  // Under binfmt QEMU (ARM64 host, amd64 slot) exe is the emulator and the
  // real program is argv[1] (P flag), so identify the process by that.
  await runDockerExec(
    execArgv(exec, [
      'sh',
      '-c',
      [
        'for d in /proc/[0-9]*; do',
        '  exe=$(readlink "$d/exe" 2>/dev/null || true)',
        '  case "$exe" in */qemu-*) exe=$(tr "\\000" "\\n" < "$d/cmdline" 2>/dev/null | sed -n 2p) ;; esac',
        '  case "$exe" in',
        '    */.kin/cli-node*|*/.kin/kin-kernel*|*/.kin/glibc239/ld-linux*|/opt/kin/cli-node*|/opt/kin/kin-kernel*|/opt/kin/glibc239/ld-linux*)',
        '      kill -KILL "${d#/proc/}" 2>/dev/null || true',
        '  esac',
        'done',
        'true',
      ].join('\n'),
    ]),
    { timeoutMs: 3000 },
  )
}

export function wrapNewerThanKernel(exec) {
  // A baked image's binaries are not the slot home's .kin copy.
  if (slotHost(exec?.vm).bakedKernel) return false
  const home = String(exec?.homeDir || '').trim()
  const sock = rustKernelPaths(exec).socketPath
  if (!home) return false
  const kin = path.join(home, '.kin')
  let wrapM = 0
  for (const name of ['kin-kernel', 'kin-kernel.bin', 'cli-node']) {
    try {
      wrapM = Math.max(wrapM, fs.statSync(path.join(kin, name)).mtimeMs)
    } catch {}
  }
  if (!wrapM) return false
  try {
    if (!sock || !fs.existsSync(sock)) return false
    return wrapM > fs.statSync(sock).mtimeMs + 500
  } catch {
    return false
  }
}

export async function restartRustKernel(exec, { timeoutMs = 30000, runDockerExec = runDocker } = {}) {
  const run = slotRunner(exec, runDockerExec)
  await killWrapDataplane(exec, run)
  const paths = rustKernelPaths(exec)
  // A relay socket path is not the kernel's file: removing it would cut the relay.
  try {
    if (paths.socketPath && slotHost(exec?.vm).ownsSocketFiles) fs.rmSync(paths.socketPath, { force: true })
  } catch {}
  return ensureRustKernel(exec, { timeoutMs, runDockerExec, force: true })
}

export const WRAP_RECYCLE_COOLDOWN_MS = 30_000
/** Observed idle-first incomplete was 14–20 min. Recycle is explicit, not hop-path. */
export const WRAP_IDLE_RECYCLE_MS = 8 * 60 * 1000
const wrapRecycleAt = new Map()
const wrapRecyclePending = new Map()
const wrapLastHopAt = new Map()
const wrapInflight = new Map()

export function resetWrapRecycleState() {
  wrapRecycleAt.clear()
  wrapRecyclePending.clear()
  wrapLastHopAt.clear()
  wrapInflight.clear()
  for (const entry of kernelReloadPending.values()) clearTimeout(entry.timer)
  kernelReloadPending.clear()
}

function wrapVmId(exec) {
  return String(exec?.vmId || exec?.vm?.id || '').trim()
}

export function noteWrapHop(exec, now = Date.now()) {
  const id = wrapVmId(exec)
  if (id) wrapLastHopAt.set(id, now)
}

export function beginWrapHop(exec, now = Date.now()) {
  const id = wrapVmId(exec)
  if (!id) return
  wrapInflight.set(id, (wrapInflight.get(id) || 0) + 1)
  wrapLastHopAt.set(id, now)
}

export function endWrapHop(exec, now = Date.now()) {
  const id = wrapVmId(exec)
  if (!id) return
  const n = (wrapInflight.get(id) || 1) - 1
  if (n <= 0) {
    wrapInflight.delete(id)
    if (kernelReloadPending.has(id)) void tryKernelReload(id)
  } else {
    wrapInflight.set(id, n)
  }
  wrapLastHopAt.set(id, now)
}

export function wrapHopInflight(exec) {
  const id = wrapVmId(exec)
  return id ? wrapInflight.get(id) || 0 : 0
}

export function wrapIdleMs(exec, now = Date.now()) {
  const id = wrapVmId(exec)
  if (!id) return 0
  const prev = wrapLastHopAt.get(id)
  if (prev == null) return Number.POSITIVE_INFINITY
  return now - prev
}

export async function awaitWrapRecycle(exec) {
  const id = wrapVmId(exec)
  const pending = wrapRecyclePending.get(id)
  if (pending) await pending
}

/**
 * Env-only kernel settings (the JOB_IDLE_SECS job watchdog) apply on restart.
 * Restart each kernel once nothing runs on it: a busy kernel retries when its last
 * hop ends, or on the next poll for jobs this process does not track.
 */
export const KERNEL_RELOAD_POLL_MS = 15_000
const kernelReloadPending = new Map()

/** Jobs on the kernel (any caller): configured slots that are neither ready nor closed. */
function kernelJobsRunning(exec, health) {
  if (!rustKernelProcessUp(health)) return 0
  if (health.recovering === true) return 1
  const ready = Number(health.ready_slots)
  if (!Number.isFinite(ready)) return 0
  const total = Number(readExistingKernelConfig(rustKernelPaths(exec).configPath).slots_per_worker) || WRAP_SLOT_MAX
  return Math.max(0, total - ready - (Number(health.closed_slots) || 0))
}

export function requestKernelReloadWhenIdle(
  exec,
  { restart = restartRustKernel, health = rustKernelHealth, pollMs = KERNEL_RELOAD_POLL_MS } = {},
) {
  const id = wrapVmId(exec)
  if (!id) return { ok: false, reason: 'missing_vm' }
  const prev = kernelReloadPending.get(id)
  if (prev?.timer) clearTimeout(prev.timer)
  let resolve
  const done = new Promise((r) => {
    resolve = r
  })
  const entry = { exec, restart, health, pollMs, timer: null, running: false, resolve }
  kernelReloadPending.set(id, entry)
  // A superseded request settles with the newer one's result.
  if (prev) done.then(prev.resolve)
  void tryKernelReload(id)
  return { ok: true, pending: true, done }
}

async function tryKernelReload(id) {
  const entry = kernelReloadPending.get(id)
  if (!entry || entry.running) return
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  entry.running = true
  const status = await Promise.resolve()
    .then(() => entry.health(entry.exec, { timeoutMs: 800 }))
    .catch(() => null)
  entry.running = false
  if (kernelReloadPending.get(id) !== entry) return
  // A hop that began during the health check retries from endWrapHop.
  if ((wrapInflight.get(id) || 0) > 0) return
  if (kernelJobsRunning(entry.exec, status) > 0) {
    entry.timer = setTimeout(() => void tryKernelReload(id), entry.pollMs)
    entry.timer.unref?.()
    return
  }
  kernelReloadPending.delete(id)
  const result = await Promise.resolve()
    .then(() => entry.restart(entry.exec))
    .catch((error) => ({ ok: false, error: String(error?.message || error) }))
  entry.resolve(result)
}

/** Deliberate credential/config cutover; failure recovery belongs to the watchdog. */
export function scheduleWrapRecycle(
  exec,
  { now = Date.now(), restart = restartRustKernel, cooldownMs = WRAP_RECYCLE_COOLDOWN_MS } = {},
) {
  const id = wrapVmId(exec)
  if (!id) return { ok: false, skipped: true, reason: 'missing_vm' }
  if (dataplaneUsesCcNode(exec)) return { ok: true, skipped: true, reason: 'cc_node' }
  const prev = wrapRecycleAt.get(id)
  if (prev != null && now - prev < cooldownMs) return { ok: true, skipped: true, reason: 'cooldown' }
  wrapRecycleAt.set(id, now)
  noteWrapHop(exec, now)
  const pending = Promise.resolve()
    .then(() => restart(exec))
    .catch(() => ({ ok: false }))
    .finally(() => {
      if (wrapRecyclePending.get(id) === pending) wrapRecyclePending.delete(id)
    })
  wrapRecyclePending.set(id, pending)
  return { ok: true, skipped: false, pending }
}

/** Kill wrap after idle so the next hop dials fresh TLS. Not on the hop path. */
export async function recycleWrapIfIdle(
  exec,
  { now = Date.now(), idleMs = WRAP_IDLE_RECYCLE_MS, restart = restartRustKernel } = {},
) {
  if (wrapIdleMs(exec, now) < idleMs) {
    noteWrapHop(exec, now)
    return { ok: true, skipped: true, reason: 'fresh' }
  }
  const rec = scheduleWrapRecycle(exec, { now, restart, cooldownMs: 0 })
  if (rec.pending) await rec.pending
  return rec
}

async function containerKernelIsPid1(container, runDockerExec, vm) {
  if (isKvmRuntime(vm)) return false
  const info = await runDockerExec(['inspect', '--format', '{{.Path}}', container], { timeoutMs: 3000 })
  return /kin-kernel/.test(String(info?.stdout || ''))
}
function bootWaitMs(timeoutMs, { pid1Kernel, wedged }) {
  if (!pid1Kernel && !wedged) return 0
  const cap = WEDGED_READY_WAIT_MS
  const budget = Number(timeoutMs)
  if (Number.isFinite(budget) && budget > 0) return Math.min(budget, cap)
  return cap
}

async function startKvmGuestKernel(exec, { timeoutMs, control, runDockerExec, force, host, paths, container }) {
  const budget = kvmBootBudget(exec.vm, timeoutMs)
  if (!force) {
    const waited = await waitForHealth(exec, budget)
    if (waited?.ok) {
      waited.reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
      return waited
    }
  }
  await killWrapDataplane(exec, runDockerExec)
  const launched = await runDockerExec(execArgv(exec, ['systemctl', 'restart', 'kin-kernel.service'], { user: '0' }), {
    timeoutMs: Math.min(budget, 30_000),
  })
  if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  if (!launched?.ok) {
    const waited = await waitForHealth(exec, budget)
    if (waited?.ok) {
      waited.reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
      return waited
    }
    const error = String(launched?.error || waited?.error || 'guest kernel restart failed')
    return { ok: false, reason: 'health_timeout', error }
  }
  const started = await waitForHealthOrExit(exec, { timeoutMs: budget, container, runDockerExec, control })
  if (started?.ok) {
    started.reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
    await runDockerExec(
      execArgv(exec, ['/usr/local/bin/kin-worker', 'telemetry', '--config', '/run/kin/worker.json'], { detach: true }),
      { timeoutMs: 5000 },
    )
  }
  return started
}

async function startRustKernel(exec, { timeoutMs, control, runDockerExec, force = false }) {
  if (exec?.homeDir) {
    const ids = slotUidGidFromHomeDir(exec.homeDir)
    ensureOfficialCredentialLink(exec.homeDir, ids || {})
    try {
      ensureSlotSubscriptionType(exec.homeDir, exec.vm?.claude?.account_tier || exec.vm?.account_tier)
    } catch {}
  }
  const paths = rustKernelPaths(exec)
  if (!paths.socketPath) return { ok: false, reason: 'socket_missing' }
  const existing = await rustKernelHealth(exec, { timeoutMs: 800 })
  if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  const staleWrap = wrapNewerThanKernel(exec)
  const slotMismatch =
    !!paths.configPath && Number(readExistingKernelConfig(paths.configPath).slots_per_worker) !== WRAP_SLOT_MAX
  const occupied = rustKernelBusy(existing) || wrapHopInflight(exec) > 0
  const host = slotHost(exec?.vm)
  // Credential rotation is read by the live kernel/CLI; it is not a lifecycle change.
  if (!force && occupied && !staleWrap && !slotMismatch) {
    const reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
    return { ok: true, reason: 'busy', health: existing, reconcile }
  }
  if (!force && rustKernelReachable(existing) && !staleWrap && !slotMismatch) {
    const reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
    return { ok: true, reason: 'already_up', health: existing, reconcile }
  }
  if (!paths.configPath || !fs.existsSync(paths.configPath)) return { ok: false, reason: 'config_missing' }
  syncKernelSlotCount(paths.configPath)
  try {
    await host.syncRun(exec.vm, path.dirname(paths.runDir))
  } catch (error) {
    return { ok: false, reason: 'slot_sync_failed', error: String(error?.message || error) }
  }
  const container = slotContainerName(exec)
  if (!container) return { ok: false, reason: 'container_missing' }
  if (isKvmRuntime(exec?.vm)) {
    return startKvmGuestKernel(exec, { timeoutMs, control, runDockerExec, force, host, paths, container })
  }
  const wedged = rustKernelProcessUp(existing) && !rustKernelReachable(existing) && !occupied
  const pid1Kernel = await containerKernelIsPid1(container, runDockerExec, exec?.vm)
  const waitMs = force || staleWrap || slotMismatch ? 0 : bootWaitMs(timeoutMs, { pid1Kernel, wedged })
  if (waitMs > 0) {
    const waited = await waitForHealth(exec, waitMs)
    if (waited?.ok) {
      waited.reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
      return waited
    }
  }
  try {
    if (host.ownsSocketFiles) fs.rmSync(paths.socketPath, { force: true })
  } catch {}
  if (!pid1Kernel) await killWrapDataplane(exec, runDockerExec)
  const launched = pid1Kernel
    ? await runDockerExec(['restart', container], { timeoutMs: Math.min(timeoutMs, 15000) })
    : await runDockerExec(
        execArgv(exec, [CONTAINER_KERNEL_BIN, '--gateway-worker', '--config', CONTAINER_KERNEL_CONFIG], {
          detach: true,
          env: ['KIN_SUBMIT_WAIT_MS=30000', 'KIN_SLOT_MAX_LIFETIME_SECS=604800'],
        }),
        { timeoutMs: Math.min(timeoutMs, 5000) },
      )

  if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  if (!launched?.ok) {
    const error = String(launched?.error || 'docker exec failed')
    const reason = /no such container|not running/i.test(error)
      ? 'container_unavailable'
      : /no such file|executable file not found/i.test(error)
        ? 'kernel_mount_missing'
        : 'start_failed'
    return { ok: false, reason, error }
  }
  if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  const started = await waitForHealthOrExit(exec, { timeoutMs, container, runDockerExec, control })
  if (started?.ok) {
    started.reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
    if (pid1Kernel) {
      await runDockerExec(
        execArgv(exec, ['/usr/local/bin/kin-worker', 'telemetry', '--config', '/run/kin/worker.json'], {
          detach: true,
        }),
        { timeoutMs: 5000 },
      )
    }
  }
  return started
}

/** Container-owned Rust processes survive Node deploys and stop with their slot container. */
export function stopAllRustKernels() {
  for (const pending of starts.values()) pending.control.cancelled = true
  const cancelled = starts.size
  starts.clear()
  return { ok: true, stopped: 0, cancelled }
}
function kernelConfigText(config) {
  return JSON.stringify(config, null, 2) + '\n'
}

function writeKernelJsonAtomically(configPath, config, vm) {
  const body = kernelConfigText(config)
  let same = false
  try {
    same = fs.readFileSync(configPath, 'utf8') === body
  } catch {}
  if (same) {
    chownSlotRuntimeFile(configPath, vm)
    return false
  }
  replaceSlotOwnedFile(configPath, body, vm)
  return true
}

export function writeKernelConfig(
  projectRoot,
  vm,
  { token, proxyUrl, proxyRequired, officialCcInference, timezone, routing } = {},
) {
  if (!projectRoot || !vm?.id) return null
  const runDir = path.join(projectRoot, 'vms', vm.id, 'run')
  const homeDir = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const socketPath = path.join(runDir, 'kernel.sock')
  const configPath = path.join(runDir, 'kernel.json')
  const tokenPath = path.join(runDir, 'internal.token')
  const credentialPath = path.join(homeDir, '.claude', 'credentials.json')
  let previous = {}
  try {
    previous = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {}
  let secret = String(token || '').trim()
  if (!secret) {
    try {
      secret = fs.readFileSync(tokenPath, 'utf8').trim()
    } catch {}
  }
  if (!secret) secret = String(previous.internal_token || '').trim()
  if (secret) replaceSlotOwnedFile(tokenPath, secret + '\n', vm)
  const testEndpoints = process.env.KIN_KERNEL_TEST_ENDPOINTS === '1'
  const dataplane = resolveKernelDataplane(vm, routing || {}) || 'wrap'
  const envBin = String(process.env.KIN_CLAUDE_BIN || '').trim()
  // Callers pass partial vm snapshots (summaries, exec contexts); the vm json decides placement.
  const record = getVm(projectRoot, vm.id) || vm
  const host = slotHost(record)
  const claudeBin = envBin || (dataplane === 'wrap' ? host.bins.cli : host.bins.cc)
  const tz = String(timezone || vm.timezone || previous.timezone || '').trim()
  const defaultCacheTtl = routing != null ? cacheTtlFromRouting(routing) : normalizeCacheTtl(previous.default_cache_ttl)
  const previousIdleSeconds = Number(previous.idle_timeout_seconds)
  const idleMs = routing == null && previousIdleSeconds > 0 ? previousIdleSeconds * 1000 : streamIdleTimeoutMs(routing)

  const kind = runtimeKind(record)
  const config = {
    vm_id: vm.id,
    socket_path: kind === 'kvm' ? '/run/kin-guest/kernel.sock' : '/run/kin/kernel.sock',
    credential_path: '/home/kincli/.claude/credentials.json',
    proxy_url: '',
    proxy_required: false,
    internal_token: secret,
    delivery_mode: 'realtime',
    refresh_skew_seconds: 300,
    request_timeout_seconds: 0,
    first_byte_timeout_seconds: 600,
    idle_timeout_seconds: Math.ceil(idleMs / 1000),
    max_request_bytes: 32 * 1024 * 1024,
    max_response_bytes: 64 * 1024 * 1024,
    max_event_bytes: 32 * 1024 * 1024,
    runtime_kind: kind,
    test_endpoints: testEndpoints,
    provider: 'local_cli',
    dataplane,
    claude_bin: claudeBin,
    slots_per_worker: wrapSlotCount(vm, routing || {}),
    persona_preset: resolveSlotPersonaPreset(vm, routing || {}),
    system_layout: resolveCliSystemLayout(vm, routing || {}),
    cli_version: OFFICIAL_CLI_VERSION,
    default_cache_ttl: defaultCacheTtl,
  }

  if (tz) config.timezone = tz
  if (testEndpoints) {
    const anthropicBaseUrl = String(process.env.KIN_ANTHROPIC_BASE_URL || '').trim()
    const oauthTokenUrl = String(process.env.KIN_OAUTH_TOKEN_URL || '').trim()
    if (anthropicBaseUrl) config.anthropic_base_url = anthropicBaseUrl
    if (oauthTokenUrl) config.oauth_token_url = oauthTokenUrl
  }
  const changed = writeKernelJsonAtomically(configPath, config, vm)
  // kin-kernel hot-reloads kernel.json: the change must reach wherever the slot reads it.
  if (changed) host.queueSyncRun(record, path.join(projectRoot, 'vms', vm.id))
  return {
    runDir,
    socketPath,
    configPath,
    credentialPath,
    tokenPath,
    provider: config.provider,
    changed,
    persona_preset: config.persona_preset,
  }
}

const routingPersonaMtime = new Map()

/** Project the web/routing persona switch onto every Claude kernel.json. Codex slots are left alone. */
export function syncClaudeKernelConfigs(projectRoot, routing) {
  if (!projectRoot) return { updated: 0, skipped: 0 }
  let updated = 0
  let skipped = 0
  for (const { id } of listVms(projectRoot)) {
    const vm = getVm(projectRoot, id)
    if (!vm || isCodexVm(vm)) {
      skipped += 1
      continue
    }
    try {
      const written = writeKernelConfig(projectRoot, vm, { routing })
      if (written?.changed) updated += 1
    } catch (error) {
      skipped += 1
      console.error(
        JSON.stringify({
          event: 'kernel_persona_sync_failed',
          vm_id: id,
          error: String(error?.message || error),
        }),
      )
    }
  }
  return { updated, skipped }
}

/**
 * routing.json is the web-managed authority. When its mtime moves (panel PUT or an
 * external edit), rewrite Claude kernel.json so the kernel hot-reload sees the new preset.
 * Unchanged bytes are not rewritten, so a repeat read does not bump mtime.
 */
export function syncClaudeKernelConfigsFromFile(projectRoot, routingFile) {
  if (!projectRoot || !routingFile) return { updated: 0, skipped: true }
  let mtimeMs
  try {
    mtimeMs = fs.statSync(routingFile).mtimeMs
  } catch {
    return { updated: 0, skipped: true }
  }
  if (routingPersonaMtime.get(routingFile) === mtimeMs) return { updated: 0, skipped: true }
  let routing
  try {
    routing = JSON.parse(fs.readFileSync(routingFile, 'utf8'))
  } catch {
    return { updated: 0, skipped: true }
  }
  const result = syncClaudeKernelConfigs(projectRoot, routing)
  routingPersonaMtime.set(routingFile, mtimeMs)
  return result
}
