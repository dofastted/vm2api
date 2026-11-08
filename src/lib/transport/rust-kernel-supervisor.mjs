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
import { maxRequestBytes, streamIdleTimeoutMs } from '../core/config.mjs'
import { profileForPreset } from '../identity/official-profiles.mjs'
import { resolveWorkstationProfile } from '../identity/workstation-profile.mjs'
import { cacheTtlFromRouting, normalizeCacheTtl } from '../protocol/cache-ttl.mjs'
import { thinkingDisplayMode } from '../protocol/thinking.mjs'
import { getModelPolicy } from '../protocol/model-policy.mjs'
import { ccEntrypointFromRouting } from '../identity/crs-persona.mjs'
import { setVmSchedulable, listVms, getVm } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { isKvmRuntime, runtimeKind } from '../vm/runtime-kind.mjs'
import { slotExecArgv } from '../vm/slot-exec.mjs'
import {
  CONTAINER_CLI_NODE_BIN,
  KERNEL_NATIVE_SLOT_COUNT,
  normalizeSessionIdleTtlSeconds,
  resolveCliSystemLayout,
  resolveCragKernelVersion,
  resolveKernelDataplane,
  resolveSlotPersonaPreset,
} from '../vm/slot-engine.mjs'
import {
  ensureOfficialCredentialLink,
  ensureSlotSubscriptionType,
  slotUidGidFromHomeDir,
  chownSlotRuntimeFile,
  replaceSlotOwnedFile,
  runtimeFileOwner,
} from '../oauth/oauth-credentials.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { buildNativeTelemetry } from '../vm/native-telemetry.mjs'
import { defaultSeedPolicy, isTelemetryEnabled } from '../protocol/seed-policy.mjs'
import { RETIRE_LEGACY_TELEMETRY } from '../vm/slot-process-status.mjs'
import { checkCragLicense } from '../vm/crag-license.mjs'
import { workerPaths } from './go-worker-client.mjs'

/** The native host is authenticated separately from account scheduling readiness. */
function runtimeReady(health, allowMissingCredential) {
  if (!allowMissingCredential) return rustKernelReachable(health)
  return (
    health?.vm_telemetry === true &&
    health?.telemetry_ready === true &&
    health?.healthy !== false &&
    Number(health?.cli_pid) > 0
  )
}

function normalizeAutoCompactWindow(value) {
  const windowTokens = Number(value)
  return Number.isInteger(windowTokens) && windowTokens >= 100_000 && windowTokens <= 1_000_000 ? windowTokens : null
}

const PANEL_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

function modelEffortTable(routing, previous) {
  if (routing == null) return previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}
  const models = getModelPolicy()?.models || {}
  const out = {}
  for (const [id, row] of Object.entries(models)) {
    const effort = row?.params?.default_effort
    if (PANEL_EFFORTS.includes(effort)) out[String(id).toLowerCase()] = effort
  }
  return out
}

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
  const host = slotHost(exec?.vm)
  // A macOS node has no container to exec into; its kernel is a launchd job (see startRustKernel).
  if (host.native) return async () => ({ ok: false, code: null, stdout: '', error: 'native_node_unsupported' })
  const env = host.dockerEnv()
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

/** Legacy crag and cc use cc-node; native V2 owns its own child lifecycle. */
export function dataplaneUsesCcNode(exec) {
  const configPath = rustKernelPaths(exec).configPath
  if (!configPath) return false
  const config = readExistingKernelConfig(configPath)
  const plane = String(config.dataplane || '')
    .trim()
    .toLowerCase()
  return (plane === 'crag' && config.crag_kernel_version !== 'v2') || plane === 'cc' || plane === 'cc-node'
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
  if (slotHost(exec?.vm).native) return { ok: false, reason: 'native_node' }
  const env = slotHost(exec?.vm).dockerEnv()
  const result = spawnSync(
    process.env.KIN_DOCKER_BIN || 'docker',
    execArgv(exec, [
      'sh',
      '-lc',
      [
        'for p in $(pidof crag-v2 2>/dev/null); do',
        '  case "$(tr "\\000" " " < "/proc/$p/cmdline" 2>/dev/null)" in',
        '    *" --gateway-worker "*) kill -TERM "$p" 2>/dev/null || true ;;',
        '  esac',
        'done',
        'kill $(pidof kin-kernel) >/dev/null 2>&1 || true',
        'kill $(pidof bun) >/dev/null 2>&1 || true',
      ].join('\n'),
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

async function waitForHealth(exec, timeoutMs, allowMissingCredential = false) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 8000)
  let last = { ok: false, reason: 'not_ready' }
  while (Date.now() < deadline) {
    last = await rustKernelHealth(exec, { timeoutMs: 400 })
    if (runtimeReady(last, allowMissingCredential)) return { ok: true, reason: 'started_in_vm', health: last }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  return { ok: false, reason: 'health_timeout', health: last, error: last?.error || 'rust kernel health timeout' }
}

async function kernelProcessAlive(exec, runDockerExec) {
  const container = slotContainerName(exec)
  if (!container) return false
  const config = readExistingKernelConfig(rustKernelPaths(exec).configPath)
  const probe =
    config.dataplane === 'crag' && config.crag_kernel_version === 'v2'
      ? [
          'for p in $(pidof crag-v2 2>/dev/null); do',
          '  case "$(tr "\\000" " " < "/proc/$p/cmdline" 2>/dev/null)" in',
          '    *" --gateway-worker "*) exit 0 ;;',
          '  esac',
          'done',
          'exit 1',
        ].join('\n')
      : 'pgrep -f /home/kincli/.kin/kin-kernel.bin >/dev/null || pgrep -f /home/kincli/.kin/kin-kernel >/dev/null || pidof kin-kernel >/dev/null'
  const result = await runDockerExec(execArgv(exec, ['sh', '-c', probe]), { timeoutMs: 1500 })
  return result?.ok === true
}

async function waitForHealthOrExit(exec, { timeoutMs, container, runDockerExec, control, allowMissingCredential }) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 8000)
  const started = Date.now()
  let last = { ok: false, reason: 'not_ready' }
  let checkedProcess = false
  while (Date.now() < deadline) {
    if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
    last = await rustKernelHealth(exec, { timeoutMs: 400 })
    if (runtimeReady(last, allowMissingCredential)) return { ok: true, reason: 'started_in_vm', health: last }
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

export async function ensureRustKernel(
  exec,
  {
    timeoutMs = 30000,
    healthTimeoutMs = 800,
    runDockerExec = runDocker,
    force = false,
    allowMissingCredential = false,
  } = {},
) {
  const vmId = exec?.vmId || exec?.vm?.id || 'unknown'
  const pending = starts.get(vmId)
  if (pending && !force) {
    const result = await pending.promise
    if (!allowMissingCredential || runtimeReady(result?.health, true)) return result
    return { ok: false, reason: 'telemetry_not_ready', health: result?.health }
  }
  const control = { cancelled: false }
  const run = slotRunner(exec, runDockerExec)
  const promise = startRustKernel(exec, {
    timeoutMs,
    healthTimeoutMs,
    vmId,
    control,
    runDockerExec: run,
    force,
    allowMissingCredential,
  })
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
        '  case "$exe" in */.kin/crag-v2/crag-v2)',
        '    case "$(tr "\\000" " " < "$d/cmdline" 2>/dev/null)" in *" --internal-execution-guard "*) continue ;; esac ;;',
        '  esac',
        '  case "$exe" in',
        '    */.kin/crag-v2/*|*/.kin/cli-node*|*/.kin/kin-kernel*|*/.kin/glibc239/ld-linux*|*/.kin/glibc239/arm64/ld-linux*|/opt/kin/cli-node*|/opt/kin/kin-kernel*|/opt/kin/glibc239/ld-linux*|/opt/kin/glibc239/arm64/ld-linux*)',
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
  if (health.runtime_variant === 'crag-v2') {
    return (
      Math.max(
        Number(health.active || 0) + Number(health.waiting || 0),
        Array.isArray(health.pids) ? health.pids.length : 0,
      ) + Number(health.queued || 0)
    )
  }
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
  return /kin-kernel|(?:^|\/)crag-v2$/.test(String(info?.stdout || '').trim())
}
function bootWaitMs(timeoutMs, { pid1Kernel, wedged }) {
  if (!pid1Kernel && !wedged) return 0
  const cap = WEDGED_READY_WAIT_MS
  const budget = Number(timeoutMs)
  if (Number.isFinite(budget) && budget > 0) return Math.min(budget, cap)
  return cap
}

/** Only actual Linux launches retire the old sender; healthy kernels do no extra exec. */
async function retireLegacyTelemetryBeforeStart(exec, runDockerExec) {
  try {
    const retired = await runDockerExec(execArgv(exec, ['sh', '-c', RETIRE_LEGACY_TELEMETRY], { user: '0' }), {
      timeoutMs: 5000,
    })
    if (retired?.ok) return { ok: true }
  } catch {}
  return { ok: false, reason: 'legacy_telemetry_stop_failed', error: 'Legacy telemetry process did not stop' }
}

async function startKvmGuestKernel(
  exec,
  { timeoutMs, control, runDockerExec, force, host, paths, container, allowMissingCredential },
) {
  const budget = kvmBootBudget(exec.vm, timeoutMs)
  if (!force) {
    const waited = await waitForHealth(exec, budget, allowMissingCredential)
    if (waited?.ok) {
      waited.reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
      return waited
    }
  }
  const retired = await retireLegacyTelemetryBeforeStart(exec, runDockerExec)
  if (!retired.ok) return retired
  await killWrapDataplane(exec, runDockerExec)
  const launched = await runDockerExec(execArgv(exec, ['systemctl', 'restart', 'kin-kernel.service'], { user: '0' }), {
    timeoutMs: Math.min(budget, 30_000),
  })
  if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  if (!launched?.ok) {
    const waited = await waitForHealth(exec, budget, allowMissingCredential)
    if (waited?.ok) {
      waited.reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
      return waited
    }
    const error = String(launched?.error || waited?.error || 'guest kernel restart failed')
    return { ok: false, reason: 'health_timeout', error }
  }
  const started = await waitForHealthOrExit(exec, {
    timeoutMs: budget,
    container,
    runDockerExec,
    control,
    allowMissingCredential,
  })
  if (started?.ok) {
    started.reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
  }
  return started
}

/** launchd keeps the job alive; a restart is a kickstart, or a full load when the node lost the job. */
async function startNativeKernel(exec, { timeoutMs, control, host }) {
  const restarted = await host.restartKernel(exec.vm, projectRootFromExec(exec))
  if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  if (!restarted?.ok) {
    return { ok: false, reason: 'start_failed', error: String(restarted?.error || 'launchd restart failed') }
  }
  return waitForHealth(exec, timeoutMs)
}

async function startRustKernel(
  exec,
  { timeoutMs, healthTimeoutMs = 800, control, runDockerExec, force = false, allowMissingCredential = false },
) {
  const licensed = checkCragLicense(projectRootFromExec(exec), exec?.vm, {
    inference: { dataplane: readExistingKernelConfig(rustKernelPaths(exec).configPath).dataplane },
  })
  if (!licensed.ok) return { ...licensed, reason: licensed.code }
  if (exec?.homeDir) {
    const ids = slotUidGidFromHomeDir(exec.homeDir)
    ensureOfficialCredentialLink(exec.homeDir, ids || {})
    try {
      ensureSlotSubscriptionType(exec.homeDir, exec.vm?.claude?.account_tier || exec.vm?.account_tier)
    } catch {}
  }
  const paths = rustKernelPaths(exec)
  if (!paths.socketPath) return { ok: false, reason: 'socket_missing' }
  const existing = await rustKernelHealth(exec, { timeoutMs: healthTimeoutMs })
  if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  const staleWrap = wrapNewerThanKernel(exec)
  const slotMismatch =
    !!paths.configPath && Number(readExistingKernelConfig(paths.configPath).slots_per_worker) !== WRAP_SLOT_MAX
  const occupied = rustKernelBusy(existing) || wrapHopInflight(exec) > 0
  const host = slotHost(exec?.vm)
  // Credential rotation is read by the live kernel/CLI; it is not a lifecycle change.
  if (!allowMissingCredential && !force && occupied && !staleWrap && !slotMismatch) {
    const reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
    return { ok: true, reason: 'busy', health: existing, reconcile }
  }
  if (!force && runtimeReady(existing, allowMissingCredential) && !staleWrap && !slotMismatch) {
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
  if (host.native) return startNativeKernel(exec, { timeoutMs, control, host })
  const container = slotContainerName(exec)
  if (!container) return { ok: false, reason: 'container_missing' }
  if (isKvmRuntime(exec?.vm)) {
    return startKvmGuestKernel(exec, {
      timeoutMs,
      control,
      runDockerExec,
      force,
      host,
      paths,
      container,
      allowMissingCredential,
    })
  }
  const wedged = rustKernelProcessUp(existing) && !rustKernelReachable(existing) && !occupied
  const pid1Kernel = await containerKernelIsPid1(container, runDockerExec, exec?.vm)
  const waitMs = force || staleWrap || slotMismatch ? 0 : bootWaitMs(timeoutMs, { pid1Kernel, wedged })
  if (waitMs > 0) {
    const waited = await waitForHealth(exec, waitMs, allowMissingCredential)
    if (waited?.ok) {
      waited.reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
      return waited
    }
  }
  const retired = await retireLegacyTelemetryBeforeStart(exec, runDockerExec)
  if (!retired.ok) return retired
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
  const started = await waitForHealthOrExit(exec, {
    timeoutMs,
    container,
    runDockerExec,
    control,
    allowMissingCredential,
  })
  if (started?.ok) {
    started.reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
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

function acceptNativeClaudeSetup(homeDir, workDir) {
  // The TUI refuses login, theme, and folder-trust screens. The credential file is
  // separate; these flags are what Claude reads before it will take a prompt.
  for (const file of [path.join(homeDir, '.claude', '.claude.json'), path.join(homeDir, '.claude.json')]) {
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    let doc
    try {
      doc = JSON.parse(raw)
    } catch {
      continue
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue
    let changed = false
    if (doc.hasCompletedOnboarding !== true) {
      doc.hasCompletedOnboarding = true
      changed = true
    }
    if (typeof doc.theme !== 'string' || !doc.theme) {
      doc.theme = 'dark'
      changed = true
    }
    if (!doc.projects || typeof doc.projects !== 'object' || Array.isArray(doc.projects)) {
      doc.projects = {}
      changed = true
    }
    for (const folder of [workDir, '/home/kincli']) {
      const current = doc.projects[folder]
      const project = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
      if (project.hasTrustDialogAccepted === true) continue
      project.hasTrustDialogAccepted = true
      doc.projects[folder] = project
      changed = true
    }
    if (!changed) continue
    const st = fs.statSync(file)
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(doc)}\n`, { mode: st.mode & 0o777 })
    try {
      fs.chownSync(tmp, st.uid, st.gid)
    } catch {}
    fs.renameSync(tmp, file)
  }
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
  { token, proxyUrl, proxyRequired, officialCcInference, timezone, routing, publish = true } = {},
) {
  // Callers pass partial vm snapshots; persisted placement owns the guest run mount.
  const record = getVm(projectRoot, vm.id) || vm
  const homeDir = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  const runDir = workerPaths({
    vm: record,
    homeDir,
    runRoot: String(process.env.KIN_SLOT_RUN_ROOT || '').trim(),
  }).runDir
  const privileged = typeof process.getuid === 'function' && process.getuid() === 0
  const dirMode = privileged ? 0o700 : 0o2770
  fs.mkdirSync(runDir, { recursive: true, mode: dirMode })
  fs.chmodSync(runDir, dirMode)
  try {
    // Same owner as the files inside (runtimeFileOwner). Taking every digit of a named id
    // (account2example -> 10002) disagreed with them, and the 0700 dir locked out the slot kernel (#740).
    const owner = runtimeFileOwner(vm)
    fs.chownSync(runDir, privileged ? owner.uid : -1, privileged ? owner.gid : process.getgid())
  } catch {}
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
  const host = slotHost(record)
  // A macOS node runs the kernel on the host itself: real node paths instead of the container mounts.
  // Unknown until that node has connected once; the slot's own start writes the config then.
  let nodePaths = null
  try {
    nodePaths = host.slotPaths?.(record) || null
  } catch (err) {
    if (host.native) return null
    throw err
  }
  const claudeBin = envBin || (dataplane === 'wrap' ? host.bins.cli : host.bins.cc)
  const tz = String(timezone || vm.timezone || previous.timezone || '').trim()
  const defaultCacheTtl = routing != null ? cacheTtlFromRouting(routing) : normalizeCacheTtl(previous.default_cache_ttl)
  const thinkingDisplay =
    routing != null
      ? thinkingDisplayMode(routing)
      : previous.thinking_display === 'passthrough'
        ? 'passthrough'
        : 'summarized'
  const previousIdleSeconds = Number(previous.idle_timeout_seconds)
  const idleMs = routing == null && previousIdleSeconds > 0 ? previousIdleSeconds * 1000 : streamIdleTimeoutMs(routing)
  const previousMax = Number(previous.max_request_bytes)
  const requestBytes = routing == null && previousMax > 0 ? previousMax : maxRequestBytes(routing)
  const cchEnabled = routing == null ? previous.cch_enabled !== false : routing?.compatibility?.cch_enabled !== false
  const previousWindow = Number(previous.auto_compact_window)
  const autoCompactWindow =
    routing == null
      ? Number.isInteger(previousWindow) && previousWindow >= 100_000 && previousWindow <= 1_000_000
        ? previousWindow
        : null
      : normalizeAutoCompactWindow(routing?.compatibility?.auto_compact_window)
  const sessionIdleTtlSeconds =
    routing == null
      ? normalizeSessionIdleTtlSeconds(previous.session_idle_ttl_seconds)
      : normalizeSessionIdleTtlSeconds(routing?.inference?.session_idle_ttl_seconds)

  const modelEffort = modelEffortTable(routing, previous.model_effort)
  const kind = runtimeKind(record)
  const config = {
    vm_id: vm.id,
    socket_path: nodePaths
      ? `${nodePaths.run}/kernel.sock`
      : kind === 'kvm'
        ? '/run/kin-guest/kernel.sock'
        : '/run/kin/kernel.sock',
    credential_path: nodePaths ? `${nodePaths.claude}/credentials.json` : '/home/kincli/.claude/credentials.json',
    proxy_url: '',
    proxy_required: false,
    internal_token: secret,
    delivery_mode: 'realtime',
    refresh_skew_seconds: 300,
    request_timeout_seconds: 0,
    first_byte_timeout_seconds: 600,
    idle_timeout_seconds: Math.ceil(idleMs / 1000),
    session_idle_ttl_seconds: sessionIdleTtlSeconds,
    max_request_bytes: requestBytes,
    max_response_bytes: 64 * 1024 * 1024,
    max_event_bytes: 64 * 1024 * 1024,
    runtime_kind: kind,
    test_endpoints: testEndpoints,
    provider: 'local_cli',
    dataplane,
    ...(dataplane === 'crag' ? { license_dir: '/run/kin/crag-license' } : {}),
    claude_bin: claudeBin,
    slots_per_worker: wrapSlotCount(vm, routing || {}),
    persona_preset: resolveSlotPersonaPreset(vm, routing || {}),
    system_layout: resolveCliSystemLayout(vm, routing || {}),
    // cli-node hot-reads this per job: UA, billing cc_version and CCH input follow the slot's profile.
    cli_version: profileForPreset(resolveSlotPersonaPreset(vm, routing || {})).cliVersion,
    default_cache_ttl: defaultCacheTtl,
    thinking_display: thinkingDisplay,
    cc_entrypoint:
      routing == null ? (previous.cc_entrypoint === 'sdk-cli' ? 'sdk-cli' : 'cli') : ccEntrypointFromRouting(routing),
    cch_enabled: cchEnabled,
    auto_compact_window: autoCompactWindow,
    model_effort: modelEffort,
    ...(!host.native && !isCodexVm(record) ? { telemetry: buildNativeTelemetry(record, projectRoot, routing) } : {}),
  }
  if (
    dataplane === 'crag' &&
    resolveCragKernelVersion({ ...record, ...vm }, routing || {}) === 'v2' &&
    !String(record?.node_id || '').trim() &&
    !isKvmRuntime(record)
  ) {
    config.crag_kernel_version = 'v2'
    config.runtime_variant = 'crag-v2'
    config.claude_bin = '/home/kincli/.kin/crag-v2/claude-code-2.1.317/claude'
    config.asset_dir = '/run/kin/crag-native-assets'
    config.work_dir = '/run/kin/work'
    const owner = runtimeFileOwner(vm)
    for (const name of ['crag-native-assets', 'work']) {
      const dir = path.join(runDir, name)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.chmodSync(dir, 0o700)
      if (privileged) fs.chownSync(dir, owner.uid, owner.gid)
    }
    acceptNativeClaudeSetup(homeDir, '/run/kin/work')
    // Native Claude owns UA/billing version; never inject a legacy profile version.
    config.cli_version = ''
    if (config.telemetry && isTelemetryEnabled(defaultSeedPolicy(record.seed_policy || {}))) {
      const workstation = resolveWorkstationProfile(record)
      config.telemetry = {
        ...config.telemetry,
        enabled: true,
        dmi_dir: '/etc/kin-dmi',
        identity: {
          enabled: true,
          linux_kernel: workstation.linux_kernel,
          linux_distro_id: workstation.linux_distro_id,
          linux_distro_version: workstation.linux_distro_version,
          shell: workstation.shell,
          terminal: workstation.terminal,
          package_managers: workstation.package_managers,
        },
      }
    }
  }

  if (tz) config.timezone = tz
  if (testEndpoints) {
    const anthropicBaseUrl = String(process.env.KIN_ANTHROPIC_BASE_URL || '').trim()
    const oauthTokenUrl = String(process.env.KIN_OAUTH_TOKEN_URL || '').trim()
    if (anthropicBaseUrl) config.anthropic_base_url = anthropicBaseUrl
    if (oauthTokenUrl) config.oauth_token_url = oauthTokenUrl
  }
  const changed = writeKernelJsonAtomically(configPath, config, vm)
  try {
    fs.chmodSync(configPath, privileged ? 0o600 : 0o640)
  } catch {}
  // Legacy cli-node hot-reads settings; native V2 uses an explicit idle restart.
  if (changed && publish) host.queueSyncRun(record, path.join(projectRoot, 'vms', vm.id))
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
