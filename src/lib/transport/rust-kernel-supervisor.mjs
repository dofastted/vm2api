/**
 * Rust gateway-worker lifecycle. kin-kernel is container PID 1.
 * Host writes credentials; slot kernel only reads AT for inference.
 */

import { spawn, spawnSync } from 'node:child_process'
import { isOverlap } from '../core/handover.mjs'
import fs from 'node:fs'
import path from 'node:path'
import {
  rustKernelHealth,
  rustKernelPaths,
  rustKernelProcessUp,
  rustKernelReachable,
  rustKernelBusy,
} from './rust-kernel-client.mjs'
import { maxRequestBytes, readRoutingConfigFile, streamIdleTimeoutMs } from '../core/config.mjs'
import { vmNodeId } from '../cluster/placement.mjs'
import { profileForPreset } from '../identity/official-profiles.mjs'
import { resolveWorkstationProfile } from '../identity/workstation-profile.mjs'
import { cacheTtlFromRouting, normalizeCacheTtl } from '../protocol/cache-ttl.mjs'
import { thinkingDisplayMode } from '../protocol/thinking.mjs'
import { getModelPolicy } from '../protocol/model-policy.mjs'
import { ccEntrypointFromRouting } from '../identity/crs-persona.mjs'
import { setVmSchedulable, listVms, getVm } from '../vm/vm-registry.mjs'
import {
  CUSTOM_OS_BRIDGE_TMPFS_DIR,
  CUSTOM_OS_PROFILES_DIR,
  DEFAULT_KVM_VSOCK_PORT,
  isCragDebian13Kernel,
  isCustomKvmMode,
  isCustomOsSlot,
  isVhostVsockUsable,
} from '../vm/custom-os-runtime.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { isKvmRuntime, runtimeKind } from '../vm/runtime-kind.mjs'
import { slotExecArgv } from '../vm/slot-exec.mjs'
import { ensureHostPrivateDir } from '../vm/private-dir.mjs'
import { withCragRuntimeAdmission } from '../vm/slot-runtime-admission.mjs'
import {
  activeCragManifestForSlot,
  CONTAINER_CLI_NODE_BIN,
  isHeadlessBridgeCaps,
  KERNEL_NATIVE_SLOT_COUNT,
  normalizeSessionIdleTtlSeconds,
  resolveSessionSlots,
  LOCAL_CRAG_CLAUDE,
  REMOTE_CRAG_CLAUDE,
  REMOTE_CRAG_ENTRY,
  resolveSlotClaude,
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
import { slotClaudeDir, slotHome } from '../vm/slot-identity.mjs'
import { repairClaudeConfigFromBackup } from '../vm/claude-config-repair.mjs'
import { buildNativeTelemetry } from '../vm/native-telemetry.mjs'
import { defaultSeedPolicy, isTelemetryEnabled } from '../protocol/seed-policy.mjs'
import { RETIRE_LEGACY_TELEMETRY, retireScriptVerdict } from '../vm/slot-process-status.mjs'
import { checkCragLicense } from '../vm/crag-license.mjs'
import { publishKvmCragLicense } from '../vm/kvm-crag-license.mjs'
import { kernelCpuCommand, kernelCpuCommandMatches, usesKernelCpuLimit } from '../vm/kernel-cpu.mjs'
import { kvmCragAppArmorCommand } from '../vm/kvm-crag-apparmor.mjs'
import { clearKvmCragSubscription } from '../vm/kvm-crag-subscription.mjs'
import { createKvmSlotAgentClient, readSlotAgentToken, syncCustomKvmSlotFiles } from '../vm/kvm-slot-agent-client.mjs'
import { workerPaths } from './go-worker-client.mjs'
import { effectiveSlotCount } from '../vm/slot-capacity.mjs'

/**
 * The native host is authenticated separately from account scheduling readiness.
 * A CRAG v2 process pool spawns its Claude processes on demand: with prewarm off an
 * idle healthy pool reports `cli_pid: 0`, so a live process is not required there.
 */
function runtimeReady(health, allowMissingCredential) {
  if (!allowMissingCredential) return rustKernelReachable(health)
  if (!rustKernelProcessUp(health) || health?.healthy === false) return false
  return (
    Number(health?.cli_pid) > 0 ||
    health?.execution_mode === 'v2_process_pool' ||
    health?.transport === 'headless_bridge' ||
    isHeadlessBridgeCaps(health?.capabilities)
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

function slotContainerKernelBin(vm) {
  return `${slotHome(vm)}/.kin/kin-kernel`
}

export const WRAP_SLOT_MIN = 1
export const WRAP_SLOT_MAX = KERNEL_NATIVE_SLOT_COUNT
export const WEDGED_READY_WAIT_MS = 3000

/**
 * Native slots for this VM: the plan's target clamped to what the container's
 * recorded memory and pids limits hold (see slot-capacity.mjs). A full crag
 * kernel never evicts idle sessions, so this is the resident process cap.
 */
export function wrapSlotCount(vm = {}, routing, options = null) {
  return Math.min(WRAP_SLOT_MAX, Math.max(WRAP_SLOT_MIN, effectiveSlotCount(vm, routing, options)))
}

/**
 * Slot count for a kernel start, from the current VM record. A request or a
 * pending idle reload carries a VM snapshot that a live capacity raise can
 * outdate; sizing from it would shrink the kernel back to the old limits.
 */
function kernelVm(exec) {
  const root = projectRootFromExec(exec)
  const id = exec?.vmId || exec?.vm?.id
  let vm = exec?.vm
  if (root && id) {
    try {
      vm = getVm(root, id) || vm
    } catch {}
  }
  return vm || {}
}

function kernelCapacityOptions(exec, vm, health = null) {
  const healthCaps = health?.capabilities || exec?.workerStatus?.capabilities
  if (Array.isArray(healthCaps) && healthCaps.length) return { capabilities: healthCaps }
  if (health?.transport === 'headless_bridge' || exec?.workerStatus?.transport === 'headless_bridge') {
    return { headlessBridge: true }
  }
  const configPath = rustKernelPaths(exec).configPath
  const filed = configPath ? readExistingKernelConfig(configPath) : {}
  const isCrag =
    filed?.runtime_variant === 'crag-v2' ||
    filed?.dataplane === 'crag' ||
    resolveKernelDataplane(vm, filed?.dataplane ? { inference: filed } : {}) === 'crag'
  if (!isCrag) return null
  const manifest = activeCragManifestForSlot(projectRootFromExec(exec), vm, exec?.homeDir || '')
  return manifest?.capabilities ? { capabilities: manifest.capabilities } : null
}

export function expectedKernelSlots(exec = {}) {
  const vm = kernelVm(exec)
  return wrapSlotCount(vm, undefined, kernelCapacityOptions(exec, vm))
}

export function requestedCragSessionSlots(vm, routing, fallback) {
  const followGlobal =
    routing?.inference?.session_slots != null &&
    (vm?.policy?.sessionSlotsOverride ?? vm?.session_slots_override) === false
  return resolveSessionSlots(followGlobal ? {} : vm, routing ?? fallback)
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

export function syncKernelSlotCount(configPath, expected = WRAP_SLOT_MAX, requested) {
  const prev = readExistingKernelConfig(configPath)
  if (!prev || typeof prev !== 'object') return false
  const sameCount = Number(prev.slots_per_worker) === expected
  const sessionSlots =
    prev.runtime_variant === 'crag-v2' && Number.isInteger(prev.session_slots)
      ? Math.min(!sameCount && Number.isInteger(requested) ? requested : prev.session_slots, expected)
      : prev.session_slots
  if (sameCount && prev.session_slots === sessionSlots) return false
  prev.slots_per_worker = expected
  if (sessionSlots !== undefined) prev.session_slots = sessionSlots
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

/**
 * Does the kernel's slot count differ from `expected`? A crag kernel reports
 * the count it runs with as `capacity`; the file alone can already be rewritten
 * while the old process still runs, so the live value wins when present.
 */
export function kernelSlotsDiffer(configPath, health, expected) {
  // crag reports `capacity`; the wrap dataplane reports its native host's `slots`.
  const live = Number(health?.capacity ?? health?.memory?.native_host?.slots)
  if (Number.isInteger(live) && live > 0 && rustKernelProcessUp(health)) return live !== expected
  const n = Number(readExistingKernelConfig(configPath).slots_per_worker)
  return Number.isFinite(n) && n !== expected
}

/**
 * Watchdog convergence: true when the running kernel needs a reload for its
 * slot count. When it already runs `expected` but the file holds another
 * count (an older release or a hand edit), only the file is rewritten so a
 * later crash restart reads the right count; that needs no reload.
 */
export function kernelSlotsConverge(configPath, health, expected, requested) {
  if (kernelSlotsDiffer(configPath, health, expected)) return true
  syncKernelSlotCount(configPath, expected, requested)
  return false
}

/** The cc dataplane runs cc-node. CRAG always runs native Claude. */
export function dataplaneUsesCcNode(exec) {
  const configPath = rustKernelPaths(exec).configPath
  if (!configPath) return false
  const config = readExistingKernelConfig(configPath)
  const plane = String(config.dataplane || '')
    .trim()
    .toLowerCase()
  return plane === 'cc' || plane === 'cc-node'
}
function projectRootFromExec(exec = {}) {
  if (exec?.projectRoot) return exec.projectRoot
  const home = String(exec?.homeDir || '')
  const marker = `${path.sep}vms${path.sep}`
  const at = home.indexOf(marker)
  if (at > 0) return home.slice(0, at)
  return ''
}

function admitKernelLaunch(exec, start, { bindSubscription = false } = {}) {
  const vm = exec?.vm
  const { dataplane } = readExistingKernelConfig(rustKernelPaths(exec).configPath)
  const candidate = dataplane === 'crag' && vm ? { ...vm, dataplane } : vm
  return withCragRuntimeAdmission(
    candidate,
    projectRootFromExec(exec),
    { routing: { inference: { dataplane } }, ...(bindSubscription ? { bindSubscription: true } : {}) },
    start,
  )
}

// A cluster-node slot bakes its kernel into the image, so the start path skips
// acceptNativeClaudeSetup (it edits host files, and the node's cli-home is not
// on this host). Without these flags the TUI sits on the onboarding page and
// CRAG refuses every prompt with a 502. Merge them inside the container instead.
export const NODE_CLAUDE_SETUP_PY = `
import json, os
home = os.environ.get("HOME") or "/home/kincli"
want = ("/run/kin/work", home)
for f in (home + "/.claude/.claude.json", home + "/.claude.json"):
    changed = False
    try:
        doc = json.load(open(f))
    except FileNotFoundError:
        os.makedirs(os.path.dirname(f), mode=0o700, exist_ok=True)
        doc = {}
        changed = True
    if not isinstance(doc, dict):
        continue
    if doc.get("hasCompletedOnboarding") is not True:
        doc["hasCompletedOnboarding"] = True
        changed = True
    if not isinstance(doc.get("theme"), str) or not doc["theme"]:
        doc["theme"] = "dark"
        changed = True
    if not isinstance(doc.get("projects"), dict):
        doc["projects"] = {}
        changed = True
    for folder in want:
        p = doc["projects"].get(folder)
        p = p if isinstance(p, dict) else {}
        if p.get("hasTrustDialogAccepted") is not True:
            p["hasTrustDialogAccepted"] = True
            doc["projects"][folder] = p
            changed = True
    if not changed:
        continue
    existed = os.path.exists(f)
    mode = os.stat(f).st_mode & 0o777 if existed else 0o600
    tmp = f + ".kin-setup.tmp"
    with open(tmp, "w") as fh:
        fh.write(json.dumps(doc) + "\\n")
    os.chmod(tmp, mode)
    os.replace(tmp, f)
    print("patched", f)
`
const NODE_SETUP_RECHECK_MS = 10 * 60_000
const nodeSetupAcceptedAt = new Map()

async function acceptNodeClaudeSetup(exec, runDockerExec) {
  if (isHeadlessBridgeCaps(exec?.workerStatus?.capabilities)) return null
  const host = slotHost(exec?.vm)
  if (!host.bakedKernel || host.native || isCodexVm(exec?.vm || {}) || isKvmRuntime(exec?.vm)) return null
  const vmId = exec?.vmId || exec?.vm?.id
  if (!vmId) return null
  const last = nodeSetupAcceptedAt.get(vmId) || 0
  if (Date.now() - last < NODE_SETUP_RECHECK_MS) return null
  const result = await runDockerExec(
    execArgv(exec, ['python3', '-c', NODE_CLAUDE_SETUP_PY], {
      user: host.execUser(exec.vm),
      env: [`HOME=${slotHome(exec?.vm)}`],
    }),
    { timeoutMs: 8000 },
  )
  if (!result?.ok) return 'node_claude_setup_failed'
  nodeSetupAcceptedAt.set(vmId, Date.now())
  return String(result.stdout || '').includes('patched') ? 'node_claude_setup' : null
}

/**
 * Already-up kernels can still have unreaped zombies, or a leftover UI
 * `paused` mark while schedulable is true. CONNECT bridges are gone.
 */
export async function reconcileCliHopRuntime(exec, { runDockerExec = runDocker } = {}) {
  const container = slotContainerName(exec)
  if (!container) return { ok: false, reason: 'missing' }
  const actions = []
  const customKvm = !exec?.vm?.node_id && isKvmRuntime(exec?.vm) && isCustomKvmMode({ vm: exec?.vm })
  if (!customKvm) {
    await runDockerExec(execArgv(exec, ['kill', '-CHLD', '1']), { timeoutMs: 2000 })
    actions.push('reap_zombies')
  }
  try {
    const setup = await acceptNodeClaudeSetup(exec, runDockerExec)
    if (setup) actions.push(setup)
  } catch {}
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

function runDocker(args, { timeoutMs = 5000, env, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.env.KIN_DOCKER_BIN || 'docker', args, {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
    child.stdin?.on?.('error', () => {})
    if (input !== undefined) child.stdin?.end(input)
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

/**
 * Cluster slots reach their container over one SSH relay hop, so a probe that
 * fits the local docker-exec budget (400ms) times out on the wire long before
 * the kernel is down. Keep the local budget for local slots and floor cluster
 * probes at 3s. The same applies to process checks inside the container.
 */
export function clusterProbeMs(exec, baseMs) {
  return vmNodeId(exec?.vm) ? Math.max(Number(baseMs) || 0, 3000) : baseMs
}

async function waitForHealth(exec, timeoutMs, allowMissingCredential = false) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 8000)
  let last = { ok: false, reason: 'not_ready' }
  while (Date.now() < deadline) {
    last = await rustKernelHealth(exec, { timeoutMs: clusterProbeMs(exec, 400) })
    if (runtimeReady(last, allowMissingCredential)) return { ok: true, reason: 'started_in_vm', health: last }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  return { ok: false, reason: 'health_timeout', health: last, error: last?.error || 'rust kernel health timeout' }
}

async function kernelProcessAlive(exec, runDockerExec) {
  const container = slotContainerName(exec)
  if (!container) return false
  const config = readExistingKernelConfig(rustKernelPaths(exec).configPath)
  const kernelBin = slotContainerKernelBin(exec?.vm)
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
      : `pgrep -f ${kernelBin}.bin >/dev/null || pgrep -f ${kernelBin} >/dev/null || pidof kin-kernel >/dev/null`
  const result = await runDockerExec(execArgv(exec, ['sh', '-c', probe]), { timeoutMs: clusterProbeMs(exec, 1500) })
  return result?.ok === true
}

async function waitForHealthOrExit(exec, { timeoutMs, container, runDockerExec, control, allowMissingCredential }) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 8000)
  const started = Date.now()
  let last = { ok: false, reason: 'not_ready' }
  let checkedProcess = false
  while (Date.now() < deadline) {
    if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
    last = await rustKernelHealth(exec, { timeoutMs: clusterProbeMs(exec, 400) })
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
    prepareGuestAppArmor = false,
    agentClient = null,
    publishCragLicense = null,
    waitForHealthFn = null,
  } = {},
) {
  const vmId = exec?.vmId || exec?.vm?.id || 'unknown'
  let pending = starts.get(vmId)
  while (pending && !force) {
    const result = await pending.promise
    if (!prepareGuestAppArmor || pending.prepareGuestAppArmor) {
      if (!allowMissingCredential || runtimeReady(result?.health, true)) return result
      return { ok: false, reason: 'kernel_not_ready', health: result?.health }
    }
    // A normal health check cannot satisfy cold-boot permission preparation.
    const next = starts.get(vmId)
    if (next === pending) break
    pending = next
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
    prepareGuestAppArmor,
    agentClient,
    publishCragLicense,
    waitForHealthFn,
  })
  const start = { promise, control, prepareGuestAppArmor }
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

export async function restartRustKernel(
  exec,
  { timeoutMs = 30000, runDockerExec = runDocker, bindSubscription = false } = {},
) {
  return admitKernelLaunch(exec, () => restartAdmittedRustKernel(exec, { timeoutMs, runDockerExec }), {
    bindSubscription,
  })
}

async function restartAdmittedRustKernel(exec, { timeoutMs, runDockerExec }) {
  if (isKvmRuntime(exec?.vm)) {
    return ensureRustKernel(exec, { timeoutMs, runDockerExec, force: true })
  }
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
    if (
      typeof health.prewarm_enabled === 'boolean' &&
      [health.active, health.waiting, health.active_requests, health.queued, health.cleaning].every(Number.isInteger)
    ) {
      return Math.max(health.active + health.waiting, health.active_requests) + health.queued + health.cleaning
    }
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
  {
    restart = restartRustKernel,
    health = rustKernelHealth,
    pollMs = KERNEL_RELOAD_POLL_MS,
    requireLiveKernel = false,
  } = {},
) {
  const id = wrapVmId(exec)
  if (!id) return { ok: false, reason: 'missing_vm' }
  const prev = kernelReloadPending.get(id)
  if (prev?.timer) clearTimeout(prev.timer)
  let resolve
  const done = new Promise((r) => {
    resolve = r
  })
  const entry = {
    exec,
    restart,
    health,
    pollMs,
    requireLiveKernel: requireLiveKernel || prev?.requireLiveKernel,
    timer: null,
    running: false,
    resolve,
  }
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
  if (entry.requireLiveKernel && getVm(projectRootFromExec(entry.exec), id)?.status !== 'running') {
    kernelReloadPending.delete(id)
    entry.resolve({ ok: true, reason: 'deferred_until_start' })
    return
  }
  // A hop that began during the health check retries from endWrapHop.
  if ((wrapInflight.get(id) || 0) > 0) return
  if ((entry.requireLiveKernel && !status?.ok) || kernelJobsRunning(entry.exec, status) > 0) {
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
  const info = await runDockerExec(['inspect', '--format', '{{json .Path}}{{printf "\\n"}}{{json .Args}}', container], {
    timeoutMs: 3000,
  })
  try {
    const [path, args] = String(info?.stdout || '')
      .trimEnd()
      .split('\n')
    const executable = JSON.parse(path)
    // Cluster CRAG boots the slot-bin entry; its node home has no .kin/kin-kernel to exec.
    if (/kin-kernel|(?:^|\/)crag-v2$/.test(executable) || executable === REMOTE_CRAG_ENTRY) return true
    return kernelCpuCommandMatches([executable, ...JSON.parse(args)])
  } catch {
    return false
  }
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
  const retired = await retireLegacyTelemetryChecked(
    execArgv(exec, ['sh', '-c', RETIRE_LEGACY_TELEMETRY]),
    runDockerExec,
  )
  if (retired.unverified) {
    console.warn(
      `[rust-kernel] ${exec?.vmId || exec?.vm?.id || 'unknown'} legacy telemetry retire unverified; boot continues`,
    )
  }
  return retired
}

/**
 * Shared transport-aware retire: a numeric exit after the script's marker is
 * its verdict; anything else means the exec never completed (docker CLI
 * transport error, node-link flap, timeout, spawn error). One retry, then fail open so transport jitter cannot brick
 * a boot; a genuinely stuck sender still fails deterministically.
 */
export async function retireLegacyTelemetryChecked(argv, runDockerExec) {
  const attempt = async () => {
    try {
      return await runDockerExec(argv, { timeoutMs: 5000 })
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }
  const deterministicFailure = {
    ok: false,
    reason: 'legacy_telemetry_stop_failed',
    error: 'Legacy telemetry process did not stop',
  }
  const first = await attempt()
  if (first?.ok) return { ok: true }
  if (retireScriptVerdict(first)) return deterministicFailure
  const retry = await attempt()
  if (retry?.ok) return { ok: true }
  if (retireScriptVerdict(retry)) return deterministicFailure
  return {
    ok: true,
    unverified: true,
    reason: 'legacy_telemetry_unverified',
    error: 'Legacy telemetry retire unverified (slot exec unavailable); boot continues',
  }
}

const AGENT_RETRYABLE_ERRORS = new Set(['agent_unreachable', 'agent_timeout', 'agent_eof', 'agent_transport_error'])

async function waitForCustomKvmAgentReady(client, { deadline, control }) {
  let last = { ok: false, error: 'agent_unreachable', message: 'KVM slot agent not ready' }
  while (startCurrent(control)) {
    last = await client.status({ timeoutMs: 2500 })
    if (last?.ok) return last
    if (!AGENT_RETRYABLE_ERRORS.has(last?.error) || Date.now() >= deadline) return last
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return { ok: false, error: 'start_cancelled', message: 'start cancelled' }
}

async function waitForCragRestartTransition(client, oldPid, { deadline, control, pollMs = 100 }) {
  const exitBudgetMs = Math.min(5000, Math.max(200, deadline - Date.now()))
  const exitDeadline = Date.now() + exitBudgetMs
  while (startCurrent(control)) {
    const st = await client.status({ timeoutMs: 2500 })
    if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
    if (st?.ok) {
      const curPid = Number(st.result?.crag_pid)
      if (!Number.isInteger(curPid) || curPid <= 0 || curPid !== oldPid) {
        return { ok: true, pid: Number.isInteger(curPid) && curPid > 0 ? curPid : null }
      }
    } else if (!AGENT_RETRYABLE_ERRORS.has(st?.error)) {
      return {
        ok: false,
        reason: st?.error || 'crag_restart_failed',
        error: st?.message || 'KVM slot agent failed while waiting for crag-v2 restart',
      }
    }
    if (Date.now() >= exitDeadline) {
      return {
        ok: false,
        reason: 'crag_restart_timeout',
        error: `Timed out waiting for guest crag-v2 pid ${oldPid} to exit after SIGTERM`,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return { ok: false, reason: 'start_cancelled' }
}

async function startCustomKvmGuestKernel(
  exec,
  {
    timeoutMs,
    control,
    runDockerExec,
    force,
    paths,
    container,
    allowMissingCredential,
    crag,
    agentClient = null,
    publishCragLicense = null,
    waitForHealthFn = null,
  },
) {
  const budget = kvmBootBudget(exec.vm, timeoutMs)
  const projectRoot = projectRootFromExec(exec)
  const deadline = Date.now() + budget
  let client = agentClient
  if (!client) {
    const kvmDir = path.join(projectRoot, 'vms', exec.vm.id, 'kvm')
    const token = readSlotAgentToken(kvmDir)
    if (!token) {
      return { ok: false, reason: 'agent_token_missing', error: 'KVM slot agent token is missing' }
    }
    client = createKvmSlotAgentClient({ socketPath: path.join(kvmDir, 'agent.sock'), token })
  }

  const ready = await waitForCustomKvmAgentReady(client, { deadline, control })
  if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  if (!ready?.ok) {
    return {
      ok: false,
      reason: ready?.error || 'agent_unreachable',
      error: ready?.message || 'KVM slot agent did not become ready',
    }
  }

  const publishFn = publishCragLicense || publishKvmCragLicense
  if (crag) {
    while (startCurrent(control)) {
      try {
        if (!(await publishFn(projectRoot, exec.vm, { force: true, runDockerExec, agentClient: client }))) {
          return { ok: false, reason: 'crag_guest_license_sync_failed', error: 'CRAG guest is not running' }
        }
        break
      } catch (error) {
        if (!error.retryable || Date.now() >= deadline) {
          return { ok: false, reason: error.code || 'crag_guest_license_sync_failed', error: error.message }
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  } else {
    try {
      await clearKvmCragSubscription(projectRoot, exec.vm, { runDockerExec, agentClient: client })
    } catch (error) {
      return { ok: false, reason: error.code || 'crag_subscription_projection_failed', error: error.message }
    }
    if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  }

  const synced = await syncCustomKvmSlotFiles(projectRoot, exec.vm, {
    client,
    runDir: paths.runDir,
    homeDir: exec.homeDir,
    requiredTargets: ['kernel_config'],
  })
  if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  if (!synced.ok) {
    return {
      ok: false,
      reason: synced.error || 'kvm_agent_sync_failed',
      error: synced.message || 'Failed to sync custom-erofs KVM slot files',
    }
  }

  const cragRunning = ready.result?.crag_running === true || Number(ready.result?.crag_pid) > 0
  if (force || cragRunning) {
    const restarted = await client.restartCrag()
    if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
    if (!restarted?.ok) {
      return {
        ok: false,
        reason: restarted?.error || 'crag_restart_failed',
        error: restarted?.message || 'Failed to signal guest crag-v2 restart',
      }
    }
    const signaledPid = Number(restarted.result?.pid)
    if (restarted.result?.signaled === true && Number.isInteger(signaledPid) && signaledPid > 0) {
      const exited = await waitForCragRestartTransition(client, signaledPid, { deadline, control })
      if (!exited.ok) return exited
    }
  }

  const waitHealth =
    waitForHealthFn ||
    ((targetExec, opts) =>
      waitForHealthOrExit(targetExec, {
        timeoutMs: opts.timeoutMs,
        container,
        runDockerExec,
        control,
        allowMissingCredential: opts.allowMissingCredential,
      }))
  const started = await waitHealth(exec, { timeoutMs: budget, allowMissingCredential })
  if (started?.ok) {
    started.reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
  }
  return started
}

async function startKvmGuestKernel(
  exec,
  {
    timeoutMs,
    control,
    runDockerExec,
    force,
    host,
    paths,
    container,
    allowMissingCredential,
    prepareGuestAppArmor,
    crag,
    agentClient = null,
    publishCragLicense = null,
    waitForHealthFn = null,
  },
) {
  if (!exec.vm?.node_id && isCustomKvmMode({ vm: exec.vm, kernel: exec.vm?.kernel })) {
    return startCustomKvmGuestKernel(exec, {
      timeoutMs,
      control,
      runDockerExec,
      force,
      paths,
      container,
      allowMissingCredential,
      crag,
      agentClient,
      publishCragLicense,
      waitForHealthFn,
    })
  }
  const budget = kvmBootBudget(exec.vm, timeoutMs)
  if (crag) {
    const deadline = Date.now() + budget
    while (startCurrent(control)) {
      try {
        if (!(await publishKvmCragLicense(projectRootFromExec(exec), exec.vm, { force: true, runDockerExec }))) {
          return { ok: false, reason: 'crag_guest_license_sync_failed', error: 'CRAG guest is not running' }
        }
        break
      } catch (error) {
        if (!error.retryable || Date.now() >= deadline) {
          return { ok: false, reason: error.code || 'crag_guest_license_sync_failed', error: error.message }
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  }
  if (!force && !crag) {
    const waited = await waitForHealth(exec, budget, allowMissingCredential)
    if (waited?.ok && !prepareGuestAppArmor) {
      waited.reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
      return waited
    }
  }
  const sshDeadline = Date.now() + (crag ? budget : 15_000)
  let prepared
  do {
    prepared = await runDockerExec(execArgv(exec, kvmCragAppArmorCommand(), { user: '0', interactive: true }), {
      timeoutMs: 30_000,
    })
    if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
    if (prepared?.ok) break
    // The guest health relay can become ready before sshd during cold boot.
    const sshUnavailable = `${prepared?.error || ''}\n${prepared?.stderr || ''}`.includes('guest ssh unavailable')
    if ((!prepareGuestAppArmor && !crag) || !sshUnavailable || Date.now() >= sshDeadline) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (startCurrent(control))
  if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  if (!prepared?.ok) {
    return {
      ok: false,
      reason: 'guest_apparmor_failed',
      error: String(prepared?.error || prepared?.stderr || 'Guest AppArmor preparation failed'),
    }
  }
  if (!exec.vm.node_id && !crag) {
    try {
      await clearKvmCragSubscription(projectRootFromExec(exec), exec.vm, { runDockerExec })
    } catch (error) {
      return { ok: false, reason: error.code || 'crag_subscription_projection_failed', error: error.message }
    }
    if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  }
  const retired = await retireLegacyTelemetryBeforeStart(exec, runDockerExec)
  if (!retired.ok) return retired
  await killWrapDataplane(exec, runDockerExec)
  const launched = await runDockerExec(
    execArgv(exec, ['systemctl', 'restart', 'kin-kernel.service'], { user: '0', interactive: true }),
    { timeoutMs: Math.min(budget, 30_000) },
  )
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
  {
    timeoutMs,
    healthTimeoutMs = 800,
    control,
    runDockerExec,
    force = false,
    allowMissingCredential = false,
    prepareGuestAppArmor = false,
    agentClient = null,
    publishCragLicense = null,
    waitForHealthFn = null,
  },
) {
  const licensed = checkCragLicense(projectRootFromExec(exec), exec?.vm, {
    inference: { dataplane: readExistingKernelConfig(rustKernelPaths(exec).configPath).dataplane },
  })
  if (!licensed.ok) return { ...licensed, reason: licensed.code }
  if (exec?.homeDir) {
    const ids = slotUidGidFromHomeDir(exec.homeDir)
    ensureOfficialCredentialLink(exec.homeDir, ids || {})
    try {
      ensureSlotSubscriptionType(exec.homeDir, exec.vm?.claude?.account_tier || exec.vm?.account_tier, {
        source: exec.vm?.claude?.account_tier ? exec.vm.claude.account_tier_source : exec.vm?.account_tier_source,
      })
    } catch {}
  }
  const paths = rustKernelPaths(exec)
  if (!paths.socketPath) return { ok: false, reason: 'socket_missing' }
  const existing = await rustKernelHealth(exec, { timeoutMs: healthTimeoutMs })
  if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  // Blue/green overlap: a newer wrap must not restart a kernel the draining controller may be using.
  // The deploy syncs wraps once that controller exits (handover exclusive pass).
  const staleWrap = !isOverlap() && wrapNewerThanKernel(exec)
  const currentVm = kernelVm(exec)
  const expectedSlots = wrapSlotCount(currentVm, undefined, kernelCapacityOptions(exec, currentVm, existing))
  const slotMismatch = !!paths.configPath && kernelSlotsDiffer(paths.configPath, existing, expectedSlots)
  let requestedSessionSlots
  if (slotMismatch && readExistingKernelConfig(paths.configPath)?.runtime_variant === 'crag-v2') {
    try {
      requestedSessionSlots = requestedCragSessionSlots(currentVm, readRoutingConfigFile(projectRootFromExec(exec)))
    } catch (error) {
      if (error.cause?.code !== 'ENOENT') console.warn('[kernel] could not read routing for CRAG session capacity')
    }
  }
  const occupied = rustKernelBusy(existing) || wrapHopInflight(exec) > 0
  const host = slotHost(exec?.vm)
  // A slot-count change is config convergence: never kill live sessions for it.
  // Write the file now and let the idle reload pick it up.
  if (slotMismatch && occupied && !force && !staleWrap && !prepareGuestAppArmor && !allowMissingCredential) {
    syncKernelSlotCount(paths.configPath, expectedSlots, requestedSessionSlots)
    requestKernelReloadWhenIdle(exec)
    const reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
    return { ok: true, reason: 'busy', slot_reload: 'pending', health: existing, reconcile }
  }
  // Credential rotation is read by the live kernel/CLI; it is not a lifecycle change.
  if (!allowMissingCredential && !force && !prepareGuestAppArmor && occupied && !staleWrap && !slotMismatch) {
    const reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
    return { ok: true, reason: 'busy', health: existing, reconcile }
  }
  if (
    !force &&
    !prepareGuestAppArmor &&
    runtimeReady(existing, allowMissingCredential) &&
    !staleWrap &&
    !slotMismatch
  ) {
    const reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
    return { ok: true, reason: 'already_up', health: existing, reconcile }
  }
  if (!paths.configPath || !fs.existsSync(paths.configPath)) return { ok: false, reason: 'config_missing' }
  return admitKernelLaunch(exec, () =>
    launchRustKernel(exec, {
      paths,
      expectedSlots,
      requestedSessionSlots,
      host,
      timeoutMs,
      control,
      runDockerExec,
      force,
      allowMissingCredential,
      prepareGuestAppArmor,
      licensed,
      existing,
      occupied,
      staleWrap,
      slotMismatch,
      agentClient,
      publishCragLicense,
      waitForHealthFn,
    }),
  )
}

async function launchRustKernel(
  exec,
  {
    paths,
    expectedSlots,
    requestedSessionSlots,
    host,
    timeoutMs,
    control,
    runDockerExec,
    force,
    allowMissingCredential,
    prepareGuestAppArmor,
    licensed,
    existing,
    occupied,
    staleWrap,
    slotMismatch,
    agentClient = null,
    publishCragLicense = null,
    waitForHealthFn = null,
  },
) {
  if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  syncKernelSlotCount(paths.configPath, expectedSlots, requestedSessionSlots)
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
      prepareGuestAppArmor,
      crag: !!licensed.license,
      agentClient,
      publishCragLicense,
      waitForHealthFn,
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
  const argv = [
    slotContainerKernelBin(exec?.vm) || CONTAINER_KERNEL_BIN,
    '--gateway-worker',
    '--config',
    CONTAINER_KERNEL_CONFIG,
  ]
  const cpuLimited = usesKernelCpuLimit({
    ...exec?.vm,
    dataplane: readExistingKernelConfig(paths.configPath).dataplane || exec?.vm?.dataplane,
  })
  const launched = pid1Kernel
    ? await runDockerExec(['restart', container], { timeoutMs: Math.min(timeoutMs, 15000) })
    : await runDockerExec(
        execArgv(exec, cpuLimited ? kernelCpuCommand(argv) : argv, {
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

/** Abandon one VM's pending kernel start; its health wait returns `start_cancelled`. */
export function cancelRustKernelStart(vmId) {
  const pending = starts.get(String(vmId || ''))
  if (!pending) return false
  pending.control.cancelled = true
  return true
}
function kernelConfigText(config) {
  return JSON.stringify(config, null, 2) + '\n'
}

function acceptNativeClaudeSetup(homeDir, workDir, vm) {
  // CLAUDE_CONFIG_DIR points at ~/.claude, so the TUI reads ~/.claude/.claude.json.
  // ~/.claude.json is a different file. Create the one the CLI opens when it is
  // missing; otherwise a completed home file still leaves the welcome screen up.
  // Root must hand a new 0700 dir to the slot user, or kincli cannot read it.
  const configDir = path.join(homeDir, '.claude')
  const privileged = typeof process.getuid === 'function' && process.getuid() === 0
  const owner = runtimeFileOwner(vm)
  const created = fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 })
  const home = fs.lstatSync(homeDir)
  if (!home.isDirectory()) return
  if (created && privileged) fs.chownSync(homeDir, owner.uid, owner.gid)
  ensureHostPrivateDir(configDir, { uid: owner.uid, gid: owner.gid, privileged })
  for (const file of [path.join(configDir, '.claude.json'), path.join(homeDir, '.claude.json')]) {
    let doc = {}
    let mode = 0o600
    let uid = privileged ? owner.uid : null
    let gid = privileged ? owner.gid : null
    let existed = false
    try {
      const st = fs.lstatSync(file)
      if (st.isSymbolicLink() || !st.isFile()) continue
      existed = true
      mode = st.mode & 0o777
      uid = st.uid
      gid = st.gid
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      doc = parsed
    } catch (error) {
      if (error?.code !== 'ENOENT') continue
    }
    let changed = !existed
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
    for (const folder of [workDir, slotHome(vm)]) {
      const current = doc.projects[folder]
      const project = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
      if (project.hasTrustDialogAccepted === true) continue
      project.hasTrustDialogAccepted = true
      doc.projects[folder] = project
      changed = true
    }
    if (!changed) continue
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(doc)}\n`, { mode })
    if (uid != null) {
      try {
        fs.chownSync(tmp, uid, gid)
      } catch {}
    }
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
  {
    token,
    proxyUrl,
    proxyRequired,
    officialCcInference,
    timezone,
    locale,
    routing,
    publish = true,
    runtimeMode,
    kvmMode,
    accel,
    sharedClaudeBin,
    wireProfileReadonlyDir,
    bridgeSocketDir,
    vsockEnabled,
    listenVsockPort,
    existsSync = fs.existsSync,
  } = {},
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
  const target = { ...record, ...vm }
  const kernelRouting = routing ?? { inference: previous }
  const dataplane = resolveKernelDataplane(target, kernelRouting) || 'wrap'
  const host = slotHost(record)
  // Before any kernel (cli-node or CRAG) starts the CLI: an empty .claude/.claude.json crash-loops it.
  if (host.kind === 'local' && !isCodexVm(record)) {
    try {
      const fixed = repairClaudeConfigFromBackup(homeDir)
      if (fixed.repaired)
        console.warn(`[kernel] ${vm.id}: restored unreadable .claude/.claude.json from ${fixed.backup}`)
    } catch {}
  }
  // A macOS node runs the kernel on the host itself: real node paths instead of the container mounts.
  // Unknown until that node has connected once; the slot's own start writes the config then.
  let nodePaths = null
  try {
    nodePaths = host.slotPaths?.(record) || null
  } catch (err) {
    if (host.native) return null
    throw err
  }
  const activeCragManifest = dataplane === 'crag' ? activeCragManifestForSlot(projectRoot, target, homeDir) : null
  const resolvedClaude = resolveSlotClaude(target, kernelRouting, {
    ...host,
    homeDir,
    manifest: activeCragManifest,
    ...(runtimeMode !== undefined ? { runtimeMode } : {}),
    ...(sharedClaudeBin !== undefined ? { sharedClaudeBin } : {}),
    ...(wireProfileReadonlyDir !== undefined ? { wireProfileReadonlyDir } : {}),
  })
  const claudeBin = resolvedClaude.bin
  const capacityOptions = activeCragManifest?.capabilities ? { capabilities: activeCragManifest.capabilities } : null
  const tz = String(timezone || target.timezone || target.fingerprint?.timezone || previous.timezone || '').trim()
  const loc = String(locale || target.locale || target.fingerprint?.locale || previous.locale || '').trim()
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
    credential_path: nodePaths ? `${nodePaths.claude}/credentials.json` : `${slotClaudeDir(target)}/credentials.json`,
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
    slots_per_worker: wrapSlotCount(vm, routing || {}, capacityOptions),
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
  if (dataplane === 'crag' && resolveCragKernelVersion(target, kernelRouting) === 'v2' && !host.native) {
    config.session_slots = Math.min(requestedCragSessionSlots(target, routing, kernelRouting), config.slots_per_worker)
    config.prewarm_enabled = kernelRouting.inference?.prewarm_enabled === true
    config.crag_kernel_version = 'v2'
    config.runtime_variant = 'crag-v2'
    config.asset_dir = '/run/kin/crag-native-assets'
    config.work_dir = '/run/kin/work'
    config.cli_version = ''
    const slotCustomOs =
      resolvedClaude.customOs ||
      resolvedClaude.sharedStore ||
      (isCragDebian13Kernel(target?.kernel) && isCustomOsSlot(target, { runtimeMode }))
    if (slotCustomOs) {
      config.wire_profile_readonly_dir = resolvedClaude.wireProfileReadonlyDir || CUSTOM_OS_PROFILES_DIR
      config.bridge_socket_dir = String(bridgeSocketDir || CUSTOM_OS_BRIDGE_TMPFS_DIR).trim()
    }
    if (kind === 'kvm' && isCustomKvmMode({ vm: target, kvmMode, runtimeMode })) {
      // Guest root holds CAP_SYS_PTRACE (`core_check` / `crag-core-check.mjs --user 0`),
      // while Docker slots keep `disable_dumpable` unset so non-root `kincli` checks pass.
      config.disable_dumpable = true
      const resolvedAccel = String(accel || target?.runtime?.accel || '')
        .trim()
        .toLowerCase()
      const hasVsockDev = existsSync === fs.existsSync ? isVhostVsockUsable() : existsSync('/dev/vhost-vsock')
      const useVsock =
        vsockEnabled === true ||
        (vsockEnabled !== false && resolvedAccel !== 'tcg' && existsSync('/dev/kvm') && hasVsockDev)
      if (useVsock) {
        const port = Number(listenVsockPort ?? DEFAULT_KVM_VSOCK_PORT)
        if (Number.isInteger(port) && port >= 1 && port <= 65535) {
          config.listen_vsock_port = port
        }
      }
    }
    if (!host.bakedKernel) {
      const owner = runtimeFileOwner(vm)
      for (const name of ['crag-native-assets', 'work']) {
        ensureHostPrivateDir(path.join(runDir, name), {
          uid: owner.uid,
          gid: owner.gid,
          privileged,
        })
      }
      if (!resolvedClaude.headlessBridge) acceptNativeClaudeSetup(homeDir, '/run/kin/work', vm)
    }
    if (
      config.telemetry &&
      isTelemetryEnabled(defaultSeedPolicy(target.seed_policy || {})) &&
      (!host.bakedKernel || kind !== 'kvm')
    ) {
      const workstation = resolveWorkstationProfile(target)
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
  if (loc) config.locale = loc
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
  if (changed && publish) {
    host.queueSyncRun(record, path.join(projectRoot, 'vms', vm.id))
    if (!host.bakedKernel && kind === 'kvm' && isCustomKvmMode({ vm: target, kvmMode, runtimeMode })) {
      const kvmDir = path.join(projectRoot, 'vms', vm.id, 'kvm')
      if (fs.existsSync(path.join(kvmDir, 'agent.sock')) && readSlotAgentToken(kvmDir)) {
        void syncCustomKvmSlotFiles(projectRoot, target, {
          runDir,
          targets: ['kernel_config'],
          timeoutMs: 2500,
        }).catch(() => {})
      }
    }
  }
  return {
    runDir,
    socketPath,
    configPath,
    credentialPath,
    tokenPath,
    provider: config.provider,
    changed,
    sessionPolicyChanged:
      changed &&
      config.runtime_variant === 'crag-v2' &&
      (previous.session_slots !== config.session_slots || previous.prewarm_enabled !== config.prewarm_enabled),
    persona_preset: config.persona_preset,
  }
}

const routingPersonaMtime = new Map()

export function syncCragSessionPolicy(projectRoot, vm, routing) {
  if (resolveKernelDataplane(vm, routing) !== 'crag') return false
  return writeKernelConfig(projectRoot, vm, { routing })?.sessionPolicyChanged === true
}

/** Project the web/routing persona switch onto every Claude kernel.json. Codex slots are left alone. */
export function syncClaudeKernelConfigs(projectRoot, routing, onSessionPolicyChanged) {
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
      if (written?.sessionPolicyChanged) onSessionPolicyChanged?.(vm)
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
