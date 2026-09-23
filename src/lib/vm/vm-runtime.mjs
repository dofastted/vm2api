/**
 * Real VM runtime: one Docker container per kin VM.
 * Mixed guest OS: Ubuntu 24.04 / Debian 12 / Arch / Fedora 41.
 * The slot joins the bound SOCKS5's transparent network; the worker
 * dials origin directly. Missing bound proxy refuses start.
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readRoutingConfigFile } from '../core/config.mjs'
import { normalizeTimezone, US_TIMEZONES } from '../core/timezone.mjs'
import { runtimeKind } from './runtime-kind.mjs'
import { buildWorkerTelemetry } from './worker-telemetry.mjs'
import { kernelBinPath, writeKernelConfig } from '../transport/rust-kernel-supervisor.mjs'
import { assertCliHopAllowed, resolveOfficialCcInference } from './slot-engine.mjs'
import { ensureSlotClaudeOwnership, chownSlotRuntimeFile, replaceSlotOwnedFile } from '../oauth/oauth-credentials.mjs'
import { materializeWrapCli } from './wrap-cli-runtime.mjs'
import { ensureGuestMachineIdFile } from '../identity/workstation-fingerprint.mjs'
import { ensureProxyEgress, isLocalEgressProxy, slotNetworkForVm } from './egress.mjs'
import { toHostPath } from './host-path.mjs'
import { fileURLToPath } from 'node:url'
import { OS_CATALOG, OS_ORDER, imageForKernel, buildDirForKernel } from './os-catalog.mjs'

export const RUNTIME = 'docker'
const WORKER_BIN = process.env.KIN_WORKER_BIN || '/opt/kin-gateway/bin/kin-worker'
const GID = String(process.env.KIN_VM_GID || 987)
const UID_BASE = Number(process.env.KIN_VM_UID_BASE || 10000)
export const SLOT_MEMORY = process.env.KIN_VM_MEMORY || '500m'
const MEM = SLOT_MEMORY
const NET = process.env.KIN_VM_NETWORK || 'bridge'
const PUBLIC_IP = process.env.PUBLIC_HOST || '166.88.96.199'
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export { OS_REGISTRY, OS_CATALOG, OS_ORDER, imageForKernel } from './os-catalog.mjs'
export { normalizeTimezone, normalizeTimezone as normalizeUsTimezone, US_TIMEZONES } from '../core/timezone.mjs'
export const STANDARD_LOCALE = 'en_US.UTF-8'

export function kernelForIndex(i) {
  return OS_ORDER[(Number(i) - 1) % OS_ORDER.length]
}

export function timezoneForIndex(i) {
  return US_TIMEZONES[(Number(i) - 1) % US_TIMEZONES.length]
}

/** Pull the guest image, falling back to the in-repo Dockerfile when the registry is unreachable. */
export function ensureSlotImage(kernel, { run = sh, projectRoot } = {}) {
  const image = imageForKernel(kernel)
  if (run(['docker', 'image', 'inspect', image], { timeout: 10_000 }).ok) return { ok: true, action: 'present', image }
  if (run(['docker', 'pull', image], { timeout: 300_000 }).ok) return { ok: true, action: 'pulled', image }
  const dir = path.join(projectRoot || MODULE_ROOT, 'docker', 'kin-os', buildDirForKernel(kernel))
  if (!fs.existsSync(path.join(dir, 'Dockerfile'))) {
    return { ok: false, error: `guest image ${image} not available and no build context at ${dir}` }
  }
  const built = run(['docker', 'build', '-t', image, dir], { timeout: 900_000 })
  if (!built.ok) return { ok: false, error: built.stderr || `docker build ${image} failed` }
  return { ok: true, action: 'built', image }
}

export function parseVmIndex(value) {
  const s = String(value || '')
  const m = s.match(/^vm-(\d+)$/i) || s.match(/^0*(\d+)$/)
  return m ? Number(m[1]) : null
}

export function padVm(n) {
  return String(n).padStart(2, '0')
}

export function nextNumericIndex(vms) {
  const used = new Set()
  for (const v of vms || []) {
    const n = parseVmIndex(v?.name) ?? parseVmIndex(v?.id)
    if (n) used.add(n)
  }
  let n = 1
  while (used.has(n)) n++
  return n
}

function sh(argv, opts = {}) {
  try {
    const out = execFileSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      timeout: opts.timeout ?? 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout: out.trim(), stderr: '' }
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout || '').trim(),
      stderr: String(e.stderr || e.message || '').trim(),
      code: e.status,
    }
  }
}

export function containerName(vmId) {
  return `kin-${String(vmId || '').replace(/^vm-/, '')}`
}

export function displayName(vmId) {
  return String(vmId || '').replace(/^vm-/, '')
}

export function inspectContainer(name) {
  const r = sh([
    'docker',
    'inspect',
    '--format',
    '{{.State.Running}}|{{.State.Pid}}|{{.HostConfig.NetworkMode}}|{{.State.StartedAt}}|{{.Config.Image}}|{{.Config.Hostname}}',
    name,
  ])
  if (!r.ok) return null
  const [running, pid, networkMode, startedAt, image, hostname] = r.stdout.split('|')
  return {
    name,
    running: running === 'true',
    pid: Number(pid) || 0,
    ip: networkMode === 'host' ? PUBLIC_IP : null,
    networkMode: networkMode || null,
    startedAt: startedAt || null,
    image: image || null,
    hostname: hostname || null,
  }
}

export function containerHasKernelMount(name) {
  const r = sh(['docker', 'inspect', '--format', '{{range .Mounts}}{{println .Destination}}{{end}}', name])
  if (!r.ok) return false
  return r.stdout.split(/\s+/).includes('/usr/local/bin/kin-kernel')
}

function vmWantsOuterSocks(vm) {
  if (isLocalEgressProxy(vm?.proxy)) return false
  return !!(vm?.proxy_cli_enabled && vm?.proxy && (vm.proxy.host || vm.proxy.url))
}

export function socksUidFor(vm) {
  const n = parseVmIndex(vm?.id) || parseVmIndex(vm?.name) || 1
  return String(UID_BASE + n)
}

export function ensureOuterSocks(vm) {
  if (isLocalEgressProxy(vm?.proxy)) {
    return { ok: true, uid: socksUidFor(vm), transport: 'direct', direct: true }
  }
  if (vm?.proxy_required === false && !vmWantsOuterSocks(vm)) {
    return { ok: true, uid: socksUidFor(vm), transport: 'go-explicit-socks5', proxy_optional: true }
  }
  if (!vmWantsOuterSocks(vm)) return { ok: false, error: 'slot SOCKS5 proxy is required' }
  return { ok: true, uid: socksUidFor(vm), transport: 'go-explicit-socks5' }
}

function runtimeUser(vm) {
  return `${socksUidFor(vm)}:${GID}`
}

function runtimeUidNum(vm) {
  return Number(runtimeUser(vm).split(':')[0])
}

function runtimePatch(vm, info, extra = {}) {
  const kernel = vm.kernel || 'ubuntu-24.04'
  const meta = OS_CATALOG[kernel] || OS_CATALOG['ubuntu-24.04']
  vm.runtime = {
    type: runtimeKind(vm) === 'kvm' ? 'kvm' : RUNTIME,
    container: info?.name || containerName(vm.id),
    pid: info?.pid || null,
    ip: info?.ip || PUBLIC_IP,
    network: NET,
    network_mode: info?.networkMode || NET,
    started_at: info?.startedAt || extra.started_at || null,
    image: info?.image || meta.image,
    hostname: info?.hostname || displayName(vm.id),
    os: meta.pretty,
    memory: MEM,
    user: runtimeUser(vm),
    worker: extra.worker || vm.runtime?.worker || 'rust',
    worker_socket: extra.worker_socket || vm.runtime?.worker_socket || null,
    worker_run_dir: extra.worker_run_dir || vm.runtime?.worker_run_dir || null,
    worker_token_file: extra.worker_token_file || vm.runtime?.worker_token_file || null,
    kernel_socket: extra.kernel_socket || vm.runtime?.kernel_socket || null,
    egress: extra.egress || (isLocalEgressProxy(vm.proxy) ? 'local' : 'explicit-socks5'),
    ...extra,
  }
  return vm
}

function workerPaths(projectRoot, vmId) {
  const slotRoot = path.join(projectRoot, 'vms', vmId)
  const runDir = path.join(slotRoot, 'run')
  return {
    slotRoot,
    runDir,
    socket: path.join(runDir, 'worker.sock'),
    kernelSocket: path.join(runDir, 'kernel.sock'),
    token: path.join(runDir, 'internal.token'),
    config: path.join(runDir, 'worker.json'),
  }
}

function workerRuntimeExtra(worker) {
  return {
    worker_socket: worker.socket,
    worker_run_dir: worker.runDir,
    worker_token_file: worker.token,
    kernel_socket: worker.kernelSocket,
  }
}

function workerProxyUrl(vm) {
  if (!vmWantsOuterSocks(vm)) return null
  if (vm.proxy?.url) return String(vm.proxy.url).replace(/^socks5:\/\//i, 'socks5h://')
  if (!vm.proxy?.host || !vm.proxy?.port) return null
  const auth = vm.proxy.username
    ? `${encodeURIComponent(vm.proxy.username)}:${encodeURIComponent(vm.proxy.password || '')}@`
    : ''
  return `socks5h://${auth}${vm.proxy.host}:${vm.proxy.port}`
}

/** host:port only — never include userinfo. */
export function proxyEndpointFromUrl(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  try {
    const u = new URL(s.replace(/^socks5h:/i, 'socks5:'))
    if (!u.hostname || !u.port) return null
    return `${u.hostname}:${u.port}`
  } catch {
    return null
  }
}

export function proxyEndpointFromVm(vm) {
  const p = vm?.proxy || {}
  if (p.host && p.port) return `${p.host}:${Number(p.port)}`
  return proxyEndpointFromUrl(p.url)
}

export function readWorkerProxyEndpoint(projectRoot, vmId) {
  try {
    const file = workerPaths(projectRoot, vmId).config
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    return proxyEndpointFromUrl(doc.proxy_url) || null
  } catch {
    return undefined
  }
}

export function readWorkerEgressMode(projectRoot, vmId) {
  try {
    const file = workerPaths(projectRoot, vmId).config
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    return String(doc.egress_mode || '').trim()
  } catch {
    return ''
  }
}

/** Worker still dials a different SOCKS5 than vm.json — hop would refresh through the old exit. */
export function isSlotProxyDesynced(vm, projectRoot) {
  if (readWorkerEgressMode(projectRoot, vm?.id) === 'transparent') return false
  const want = proxyEndpointFromVm(vm)
  if (!want) return false
  const have = readWorkerProxyEndpoint(projectRoot, vm?.id)
  if (have === undefined) return false
  if (!have) return true
  return want !== have
}

/** Write worker.json.telemetry from seed_policy. Does not bounce the process. */
export function syncWorkerTelemetry(vm, projectRoot) {
  if (!vm?.id || !projectRoot) return { wrote: false }
  const paths = workerPaths(projectRoot, vm.id)
  if (!fs.existsSync(paths.config)) return { wrote: false }
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(paths.config, 'utf8'))
  } catch {
    return { wrote: false }
  }
  if (!doc || typeof doc !== 'object') return { wrote: false }
  doc.telemetry = buildWorkerTelemetry(vm, projectRoot)
  replaceSlotOwnedFile(paths.config, JSON.stringify(doc, null, 2) + '\n', vm)
  return { wrote: true, enabled: doc.telemetry.enabled === true }
}

/**
 * Rewrite worker.json from the current vm proxy and bounce the process.
 * Never docker rm — killing a live worker mid-refresh can invalidate the grant.
 */
export function reloadSlotWorker(vm, projectRoot, { routing } = {}) {
  if (!vm?.id) return { ok: false, error: 'vm required' }
  const paths = workerPaths(projectRoot, vm.id)
  let worker
  try {
    if (!isLocalEgressProxy(vm.proxy) && vm.proxy_required !== false && !workerProxyUrl(vm))
      throw new Error('slot SOCKS5 proxy is required')
    worker = writeWorkerFiles(vm, projectRoot, { routing })
  } catch (error) {
    if (!fs.existsSync(paths.config) || !fs.existsSync(paths.token)) {
      return { ok: false, error: String(error.message || error) }
    }
    worker = paths
  }
  const name = containerName(vm.id)
  const existing = inspectContainer(name)
  if (!existing) return startVmRuntime(vm, projectRoot, { recreate: false, routing })
  if (existing.running && !fs.existsSync(paths.socket)) {
    return startVmRuntime(vm, projectRoot, { recreate: true, routing })
  }
  const cmd = existing.running ? ['docker', 'restart', name] : ['docker', 'start', name]
  const r = sh(cmd, { timeout: 60_000 })
  if (!r.ok) return { ok: false, error: r.stderr || `${cmd.join(' ')} failed` }
  runtimePatch(vm, inspectContainer(name), workerRuntimeExtra(worker))
  return { ok: true, action: existing.running ? 'reloaded' : 'started', runtime: vm.runtime }
}

function readProjectRouting(projectRoot) {
  return readRoutingConfigFile(projectRoot)
}

function writeWorkerFiles(vm, projectRoot, { transparent, routing } = {}) {
  const paths = workerPaths(projectRoot, vm.id)
  const uid = runtimeUidNum(vm)
  const gid = Number(GID)
  fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
  let token = ''
  try {
    token = fs.readFileSync(paths.token, 'utf8').trim()
  } catch {}
  if (!token) token = crypto.randomBytes(32).toString('hex')
  replaceSlotOwnedFile(paths.token, token + '\n', vm)
  const onEgress =
    transparent === true ||
    (transparent !== false && String(inspectContainer(containerName(vm.id))?.networkMode || '').startsWith('kin-eg-'))
  const local = isLocalEgressProxy(vm.proxy)
  const proxyUrl = onEgress || local ? '' : workerProxyUrl(vm) || ''
  if (!onEgress && !local && vm.proxy_required !== false && !proxyUrl) throw new Error('slot SOCKS5 proxy is required')
  const testEndpoints = process.env.KIN_WORKER_TEST_ENDPOINTS === '1'
  const workerConfig = {
    vm_id: vm.id,
    socket_path: '/run/kin/worker.sock',
    credential_path: '/home/kincli/.claude/credentials.json',
    proxy_url: proxyUrl,
    proxy_required: onEgress || local ? false : vm.proxy_required !== false,
    internal_token: token,
    delivery_mode: 'realtime',
    refresh_skew_seconds: 300,
    request_timeout_seconds: 0,
    first_byte_timeout_seconds: 600,
    idle_timeout_seconds: 180,
    max_request_bytes: 32 * 1024 * 1024,
    max_response_bytes: 64 * 1024 * 1024,
    max_event_bytes: 32 * 1024 * 1024,
    test_endpoints: testEndpoints,
    runtime_kind: runtimeKind(vm),
    telemetry: buildWorkerTelemetry(vm, projectRoot),
  }
  if (onEgress || local) workerConfig.egress_mode = 'transparent'
  if (testEndpoints) {
    const anthropicBaseUrl = String(process.env.KIN_ANTHROPIC_BASE_URL || '').trim()
    const oauthTokenUrl = String(process.env.KIN_OAUTH_TOKEN_URL || '').trim()
    if (anthropicBaseUrl) workerConfig.anthropic_base_url = anthropicBaseUrl
    if (oauthTokenUrl) workerConfig.oauth_token_url = oauthTokenUrl
  }
  replaceSlotOwnedFile(paths.config, JSON.stringify(workerConfig, null, 2) + '\n', vm)
  const resolvedRouting = routing != null ? routing : readProjectRouting(projectRoot)
  const allowed = assertCliHopAllowed(vm, resolvedRouting)
  if (!allowed.ok) throw new Error(allowed.error)
  const kernel = writeKernelConfig(projectRoot, vm, {
    token,
    proxyUrl,
    proxyRequired: vm.proxy_required !== false,
    officialCcInference: resolveOfficialCcInference(vm, resolvedRouting),
    timezone: vm.timezone || '',
    routing: resolvedRouting,
  })
  chownSlotRuntimeFile(paths.runDir, vm)
  chownSlotRuntimeFile(paths.token, vm)
  chownSlotRuntimeFile(paths.config, vm)
  if (kernel?.configPath) chownSlotRuntimeFile(kernel.configPath, vm)
  ensureSlotClaudeOwnership(path.join(projectRoot, 'vms', vm.id, 'cli-home'), uid, gid)
  return { ...paths, kernelSocket: kernel?.socketPath || paths.kernelSocket }
}

/** Running slots survive Node deploy. Only an explicit recreate may docker rm -f. */
export function shouldReplaceSlotContainer({ existing, recreate = false, network, image } = {}) {
  if (!existing) return false
  if (recreate === true) return true
  if (existing.running) return false
  const wrongNet = network != null && existing.networkMode && existing.networkMode !== network
  const wrongImg = image != null && existing.image && existing.image !== image
  return !!(wrongNet || wrongImg)
}

export function startVmRuntime(vm, projectRoot, { recreate = false, routing } = {}) {
  const name = containerName(vm.id)
  const slotName = displayName(vm.id)
  const host = String(vm.fingerprint?.hostname || '').trim() || slotName
  const kernel = vm.kernel && OS_CATALOG[vm.kernel] ? vm.kernel : 'ubuntu-24.04'
  vm.kernel = kernel
  vm.timezone = normalizeTimezone(vm.timezone)
  vm.locale = vm.locale || STANDARD_LOCALE
  const image = imageForKernel(kernel)
  const home = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  fs.mkdirSync(home, { recursive: true })
  ensureSlotClaudeOwnership(home, runtimeUidNum(vm), Number(GID))
  const proxy = ensureOuterSocks(vm)
  if (!proxy.ok) return proxy
  const eg = ensureProxyEgress(projectRoot, vm.proxy)
  if (!eg.ok) return eg
  if (!eg.network && !eg.name) return { ok: false, error: 'egress network missing; refusing host fallback' }

  let existing = inspectContainer(name)
  const paths = workerPaths(projectRoot, vm.id)
  const replace = recreate || (existing?.running && !fs.existsSync(paths.socket))
  // Node restart / 开机 must not bounce a live slot with a healthy worker.
  if (existing?.running && !replace) {
    runtimePatch(vm, existing, {
      worker_socket: paths.socket,
      worker_run_dir: paths.runDir,
      worker_token_file: paths.token,
    })
    return { ok: true, action: 'already-running', runtime: vm.runtime }
  }
  try {
    materializeWrapCli(projectRoot, vm, { uid: runtimeUidNum(vm), gid: Number(GID) })
  } catch {}
  const wrapKernel = path.join(home, '.kin', 'kin-kernel')
  const kernelBin = kernelBinPath()
  const mountKernel = !!kernelBin && fs.existsSync(kernelBin)
  if (!fs.existsSync(wrapKernel) && !mountKernel) {
    return { ok: false, error: 'kin-kernel missing; wrap CLI sample not materialized' }
  }

  let worker
  try {
    worker = writeWorkerFiles(vm, projectRoot, { transparent: true, routing })
  } catch (error) {
    return { ok: false, error: String(error.message || error) }
  }
  try {
    fs.chownSync(home, runtimeUidNum(vm), Number(GID))
  } catch {}

  if (shouldReplaceSlotContainer({ existing, recreate: replace, network: slotNetworkForVm(vm), image })) {
    sh(['docker', 'rm', '-f', name])
    existing = null
  }
  if (existing?.running) {
    runtimePatch(vm, existing, workerRuntimeExtra(worker))
    return { ok: true, action: 'already-running', runtime: vm.runtime }
  }
  if (existing) {
    const r = sh(['docker', 'start', name])
    if (!r.ok) return { ok: false, error: r.stderr || 'docker start failed' }
    runtimePatch(vm, inspectContainer(name), workerRuntimeExtra(worker))
    return { ok: true, action: 'started', runtime: vm.runtime }
  }

  const img = ensureSlotImage(kernel, { projectRoot })
  if (!img.ok) return img

  try {
    fs.rmSync(worker.socket, { force: true })
  } catch {}
  try {
    fs.rmSync(worker.kernelSocket, { force: true })
  } catch {}
  const machineIdFile = ensureGuestMachineIdFile(projectRoot, vm)
  // Slots are created by the host engine: every -v source must be a host path.
  const hostOf = (p) => toHostPath(p, { projectRoot })
  const machineMounts = machineIdFile
    ? [
        '-v',
        `${hostOf(machineIdFile)}:/etc/machine-id:ro`,
        '-v',
        `${hostOf(machineIdFile)}:/var/lib/dbus/machine-id:ro`,
      ]
    : []
  const netName = slotNetworkForVm(vm)
  if (!netName || netName === 'host' || netName === 'bridge') {
    return { ok: false, error: 'bound SOCKS5 network required; refusing host/bridge fallback' }
  }
  const args = [
    'docker',
    'run',
    '-d',
    '--name',
    name,
    '--hostname',
    host,
    '--network',
    netName,
    '--restart',
    'unless-stopped',
    '--memory',
    MEM,
    '--memory-swap',
    MEM,
    '--pids-limit',
    '256',
    '--user',
    runtimeUser(vm),
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=32m',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--label',
    'kin.vm=1',
    '--label',
    `kin.vm.id=${vm.id}`,
    '--label',
    `kin.vm.name=${slotName}`,
    '--label',
    `kin.vm.os=${kernel}`,
    '-v',
    `${hostOf(home)}:/home/kincli`,
    '-v',
    `${hostOf(worker.runDir)}:/run/kin`,
    ...(fs.existsSync(WORKER_BIN) ? ['-v', `${hostOf(WORKER_BIN)}:/usr/local/bin/kin-worker:ro`] : []),
    ...(mountKernel ? ['-v', `${hostOf(kernelBin)}:/usr/local/bin/kin-kernel:ro`] : []),
    ...machineMounts,
    '-e',
    'HOME=/home/kincli',
    '-e',
    'CLAUDE_CONFIG_DIR=/home/kincli/.claude',
    '-e',
    `TZ=${vm.timezone}`,
    '-e',
    `LANG=${vm.locale}`,
    '-e',
    `KIN_VM_ID=${vm.id}`,
    '-e',
    `KIN_VM_NAME=${slotName}`,
    '-e',
    `KIN_VM_OS=${kernel}`,
    ...(process.env.KIN_VM_HOST_GATEWAY === '1' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),

    '--dns',
    '8.8.8.8',
    '--dns-opt',
    'use-vc',
    '-w',
    '/home/kincli',
    image,
    fs.existsSync(wrapKernel) ? '/home/kincli/.kin/kin-kernel' : '/usr/local/bin/kin-kernel',
    '--gateway-worker',
    '--config',
    '/run/kin/kernel.json',
  ]

  const r = sh(args, { timeout: 90_000 })
  if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'docker run failed' }
  runtimePatch(vm, inspectContainer(name), {
    container_id: r.stdout,
    ...workerRuntimeExtra(worker),
  })
  if (fs.existsSync(WORKER_BIN)) {
    sh(['docker', 'exec', '-d', name, '/usr/local/bin/kin-worker', 'telemetry', '--config', '/run/kin/worker.json'], {
      timeout: 8_000,
    })
  }
  return { ok: true, action: 'created', runtime: vm.runtime }
}

/** Explicit factory reset / delete only. Never call from Node deploy. */
export function destroyVmRuntime(vm) {
  if (!vm?.id) return { ok: false, error: 'vm required' }
  const name = containerName(vm.id)
  const info = inspectContainer(name)
  if (!info) {
    if (vm.runtime) vm.runtime = { ...vm.runtime, pid: null, ip: null, stopped: true, removed: true }
    return { ok: true, action: 'absent', runtime: vm.runtime || null }
  }
  const r = sh(['docker', 'rm', '-f', name], { timeout: 60_000 })
  if (!r.ok && inspectContainer(name)) {
    return { ok: false, error: r.stderr || 'docker rm failed' }
  }
  if (vm.runtime) vm.runtime = { ...vm.runtime, pid: null, ip: null, stopped: true, removed: true }
  return { ok: true, action: 'removed', runtime: vm.runtime || null }
}

export function stopVmRuntime(vm) {
  const name = containerName(vm.id)
  const info = inspectContainer(name)
  if (!info) {
    if (vm.runtime) vm.runtime = { ...vm.runtime, pid: null, ip: null, stopped: true }
    return { ok: true, action: 'absent', runtime: vm.runtime || null }
  }
  if (!info.running) {
    runtimePatch(vm, info)
    vm.runtime.stopped = true
    return { ok: true, action: 'already-stopped', runtime: vm.runtime }
  }
  const r = sh(['docker', 'stop', '-t', '3', name])
  if (!r.ok) return { ok: false, error: r.stderr || 'docker stop failed' }
  runtimePatch(vm, inspectContainer(name))
  vm.runtime.stopped = true
  vm.runtime.pid = null
  return { ok: true, action: 'stopped', runtime: vm.runtime }
}

export function listRuntimeVms() {
  const r = sh([
    'docker',
    'ps',
    '-a',
    '--filter',
    'label=kin.vm=1',
    '--format',
    '{{.Names}}\t{{.Status}}\t{{.Label "kin.vm.id"}}\t{{.Label "kin.vm.os"}}',
  ])
  if (!r.ok || !r.stdout) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, status, id, os] = line.split('\t')
      return { name, status, id, os }
    })
}
