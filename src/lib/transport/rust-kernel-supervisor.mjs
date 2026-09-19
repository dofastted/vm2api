/**
 * Rust gateway-worker lifecycle. kin-kernel is container PID 1.
 * Host writes credentials; slot kernel only reads AT for inference.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { rustKernelHealth, rustKernelPaths, rustKernelProcessUp, rustKernelReachable } from './rust-kernel-client.mjs'
import { OFFICIAL_CLI_VERSION } from '../identity/vm-identity.mjs'
import { setVmSchedulable } from '../vm/vm-registry.mjs'
import { resolveCliSystemLayout } from '../vm/slot-engine.mjs'
import { ensureOfficialCredentialLink, slotUidGidFromHomeDir } from '../oauth/oauth-credentials.mjs'

const starts = new Map()
const CONTAINER_KERNEL_BIN = '/home/kincli/.kin/kin-kernel'
const CONTAINER_KERNEL_CONFIG = '/run/kin/kernel.json'
export const CONTAINER_CLAUDE_BIN = '/home/kincli/.kin/cli-node'

export const WRAP_SLOT_MIN = 1
export const WRAP_SLOT_MAX = 2
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
  await runDockerExec(['exec', container, 'kill', '-CHLD', '1'], { timeoutMs: 2000 })
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
  const result = spawnSync(
    process.env.KIN_DOCKER_BIN || 'docker',
    [
      'exec',
      container,
      'sh',
      '-lc',
      'kill $(pidof kin-kernel) >/dev/null 2>&1 || true; kill $(pidof bun) >/dev/null 2>&1 || true',
    ],
    { encoding: 'utf8', timeout: 5000 },
  )
  return { ok: result.status === 0, code: result.status }
}

function runDocker(args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.env.KIN_DOCKER_BIN || 'docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
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

async function kernelProcessAlive(container, runDockerExec) {
  if (!container) return false
  const result = await runDockerExec(
    [
      'exec',
      container,
      'sh',
      '-c',
      'pgrep -f /home/kincli/.kin/kin-kernel.bin >/dev/null || pgrep -f /home/kincli/.kin/kin-kernel >/dev/null || pidof kin-kernel >/dev/null',
    ],
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
    if (!checkedProcess && Date.now() - started >= 1200 && container) {
      checkedProcess = true
      const alive = await kernelProcessAlive(container, runDockerExec)
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

export async function ensureRustKernel(exec, { timeoutMs = 30000, runDockerExec = runDocker } = {}) {
  const vmId = exec?.vmId || exec?.vm?.id || 'unknown'
  const pending = starts.get(vmId)
  if (pending) return pending.promise
  const control = { cancelled: false }
  const promise = startRustKernel(exec, { timeoutMs, vmId, control, runDockerExec })
  const start = { promise, control }
  starts.set(vmId, start)
  try {
    return await promise
  } finally {
    if (starts.get(vmId) === start) starts.delete(vmId)
  }
}

async function killWrapDataplane(container, runDockerExec) {
  if (!container) return
  await runDockerExec(
    [
      'exec',
      container,
      'sh',
      '-c',
      [
        'pkill -f /home/kincli/.kin/kin-kernel.bin',
        'pkill -f /home/kincli/.kin/glibc239/ld-linux',
        'pkill -f /home/kincli/.kin/cli-node',
        'true',
      ].join(' >/dev/null 2>&1; '),
    ],
    { timeoutMs: 3000 },
  )
}

export function wrapNewerThanKernel(exec) {
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

/** Host rotated credentials.json; running wrap still holds the revoked AT. */
export function credentialsNewerThanKernel(exec) {
  const home = String(exec?.homeDir || '').trim()
  const sock = rustKernelPaths(exec).socketPath
  if (!home || !sock) return false
  const cred = path.join(home, '.claude', 'credentials.json')
  try {
    if (!fs.existsSync(sock) || !fs.existsSync(cred)) return false
    return fs.statSync(cred).mtimeMs > fs.statSync(sock).mtimeMs + 500
  } catch {
    return false
  }
}

export async function restartRustKernel(exec, { timeoutMs = 30000, runDockerExec = runDocker } = {}) {
  await killWrapDataplane(slotContainerName(exec), runDockerExec)
  const paths = rustKernelPaths(exec)
  try {
    if (paths.socketPath) fs.rmSync(paths.socketPath, { force: true })
  } catch {}
  return ensureRustKernel(exec, { timeoutMs, runDockerExec })
}

export const WRAP_RECYCLE_COOLDOWN_MS = 30_000
/** Observed idle-first incomplete was 14–20 min. Recycle is explicit, not hop-path. */
export const WRAP_IDLE_RECYCLE_MS = 8 * 60 * 1000
const wrapRecycleAt = new Map()
const wrapRecyclePending = new Map()
const wrapLastHopAt = new Map()

export function resetWrapRecycleState() {
  wrapRecycleAt.clear()
  wrapRecyclePending.clear()
  wrapLastHopAt.clear()
}

function wrapVmId(exec) {
  return String(exec?.vmId || exec?.vm?.id || '').trim()
}

export function noteWrapHop(exec, now = Date.now()) {
  const id = wrapVmId(exec)
  if (id) wrapLastHopAt.set(id, now)
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

/** After a dead hop, drop bun HTTP pool. */
export function scheduleWrapRecycle(
  exec,
  { now = Date.now(), restart = restartRustKernel, cooldownMs = WRAP_RECYCLE_COOLDOWN_MS } = {},
) {
  const id = wrapVmId(exec)
  if (!id) return { ok: false, skipped: true, reason: 'missing_vm' }
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

async function containerKernelIsPid1(container, runDockerExec) {
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

async function startRustKernel(exec, { timeoutMs, control, runDockerExec }) {
  if (exec?.homeDir) {
    const ids = slotUidGidFromHomeDir(exec.homeDir)
    ensureOfficialCredentialLink(exec.homeDir, ids || {})
  }
  const paths = rustKernelPaths(exec)
  if (!paths.socketPath) return { ok: false, reason: 'socket_missing' }
  const existing = await rustKernelHealth(exec, { timeoutMs: 800 })
  if (!startCurrent(control)) return { ok: false, reason: 'start_cancelled' }
  const staleWrap = wrapNewerThanKernel(exec)
  const staleTicket = credentialsNewerThanKernel(exec)
  const slotMismatch =
    !!paths.configPath && Number(readExistingKernelConfig(paths.configPath).slots_per_worker) !== WRAP_SLOT_MAX
  if (rustKernelReachable(existing) && !staleWrap && !staleTicket && !slotMismatch) {
    const reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
    return { ok: true, reason: 'already_up', health: existing, reconcile }
  }
  if (!paths.configPath || !fs.existsSync(paths.configPath)) return { ok: false, reason: 'config_missing' }
  syncKernelSlotCount(paths.configPath)
  const container = slotContainerName(exec)
  if (!container) return { ok: false, reason: 'container_missing' }
  const wedged = rustKernelProcessUp(existing) && !rustKernelReachable(existing)
  const pid1Kernel = await containerKernelIsPid1(container, runDockerExec)
  const waitMs = staleWrap || staleTicket || slotMismatch ? 0 : bootWaitMs(timeoutMs, { pid1Kernel, wedged })
  if (waitMs > 0) {
    const waited = await waitForHealth(exec, waitMs)
    if (waited?.ok) {
      waited.reconcile = await reconcileCliHopRuntime(exec, { runDockerExec })
      return waited
    }
  }
  try {
    fs.rmSync(paths.socketPath, { force: true })
  } catch {}
  if (!pid1Kernel) await killWrapDataplane(container, runDockerExec)
  const launched = pid1Kernel
    ? await runDockerExec(['restart', container], { timeoutMs: Math.min(timeoutMs, 15000) })
    : await runDockerExec(
        [
          'exec',
          '-d',
          '-e',
          'KIN_SUBMIT_WAIT_MS=30000',
          '-e',
          'KIN_SLOT_MAX_LIFETIME_SECS=604800',
          container,
          CONTAINER_KERNEL_BIN,
          '--gateway-worker',
          '--config',
          CONTAINER_KERNEL_CONFIG,
        ],
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
        ['exec', '-d', container, '/usr/local/bin/kin-worker', 'telemetry', '--config', '/run/kin/worker.json'],
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
  if (secret) fs.writeFileSync(tokenPath, secret + '\n', { mode: 0o600 })
  const testEndpoints = process.env.KIN_KERNEL_TEST_ENDPOINTS === '1'
  const claudeBin = String(process.env.KIN_CLAUDE_BIN || '').trim() || CONTAINER_CLAUDE_BIN
  const tz = String(timezone || vm.timezone || previous.timezone || '').trim()
  const config = {
    vm_id: vm.id,
    socket_path: '/run/kin/kernel.sock',
    credential_path: '/home/kincli/.claude/credentials.json',
    proxy_url: '',
    proxy_required: false,
    internal_token: secret,
    delivery_mode: 'realtime',
    refresh_skew_seconds: 300,
    request_timeout_seconds: 0,
    first_byte_timeout_seconds: 600,
    idle_timeout_seconds: 180,
    max_request_bytes: 32 * 1024 * 1024,
    max_response_bytes: 64 * 1024 * 1024,
    max_event_bytes: 32 * 1024 * 1024,
    runtime_kind: 'docker',
    test_endpoints: testEndpoints,
    provider: 'local_cli',
    claude_bin: claudeBin,
    slots_per_worker: wrapSlotCount(vm, routing || {}),
    system_layout: resolveCliSystemLayout(vm, routing || {}),
    cli_version: OFFICIAL_CLI_VERSION,
  }

  if (tz) config.timezone = tz
  if (testEndpoints) {
    const anthropicBaseUrl = String(process.env.KIN_ANTHROPIC_BASE_URL || '').trim()
    const oauthTokenUrl = String(process.env.KIN_OAUTH_TOKEN_URL || '').trim()
    if (anthropicBaseUrl) config.anthropic_base_url = anthropicBaseUrl
    if (oauthTokenUrl) config.oauth_token_url = oauthTokenUrl
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  return { runDir, socketPath, configPath, credentialPath, tokenPath, provider: config.provider }
}
