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
import { readRoutingConfigFile, streamIdleTimeoutMs } from '../core/config.mjs'
import { US_TIMEZONES, validTimezone } from '../core/timezone.mjs'
import { runtimeKind, isKvmRuntime, RUNTIME_KVM } from './runtime-kind.mjs'
import { buildWorkerTelemetry } from './worker-telemetry.mjs'
import { kernelBinPath, writeKernelConfig } from '../transport/rust-kernel-supervisor.mjs'
import { assertCliHopAllowed, resolveOfficialCcInference } from './slot-engine.mjs'
import { ensureSlotClaudeOwnership, chownSlotRuntimeFile, replaceSlotOwnedFile } from '../oauth/oauth-credentials.mjs'
import { materializeWrapCli } from './wrap-cli-runtime.mjs'
import { ensureGuestMachineIdFile } from '../identity/workstation-fingerprint.mjs'
import { boundProxyUrl, ensureProxyEgress, isLocalEgressProxy, slotNetworkForVm } from './egress.mjs'
import { socksProxyEndpoint } from './socks-address.mjs'
import { assertProxyAllowed } from './proxy-policy.mjs'
import { toHostPath } from './host-path.mjs'
import { fileURLToPath } from 'node:url'
import {
  OS_CATALOG,
  OS_ORDER,
  imageForKernel,
  buildDirForKernel,
  kvmImageForKernel,
  KVM_BUILD_DIR,
} from './os-catalog.mjs'
import { slotMemory, memoryMiB, VM_CONFIG_DEFAULTS } from './machine-spec.mjs'
import { probeLocalKvm } from './kvm-host.mjs'
import { slotExecArgv } from './slot-exec.mjs'

export const RUNTIME = 'docker'
const WORKER_BIN = process.env.KIN_WORKER_BIN || '/opt/kin-gateway/bin/kin-worker'
const GID = String(process.env.KIN_VM_GID || 987)
const UID_BASE = Number(process.env.KIN_VM_UID_BASE || 10000)
const KVM_MEMORY_OVERHEAD_MIB = 512
const NET = process.env.KIN_VM_NETWORK || 'bridge'
const PUBLIC_IP = process.env.PUBLIC_HOST || '166.88.96.199'
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
// Root in the runner must write into the slot-uid 0700 dirs and drop qemu to the slot uid.
export const KVM_CAPS = ['SETUID', 'SETGID', 'SETPCAP', 'CHOWN', 'FOWNER', 'DAC_OVERRIDE']

function kvmContainerMemory(mem) {
  return `${memoryMiB(mem) + KVM_MEMORY_OVERHEAD_MIB}m`
}

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
export function ensureSlotImage(kernel, { run = sh, projectRoot, runtime } = {}) {
  const kvm = runtime === 'kvm' || runtime === RUNTIME_KVM
  const image = kvm ? kvmImageForKernel(kernel) : imageForKernel(kernel)
  if (run(['docker', 'image', 'inspect', image], { timeout: 10_000 }).ok) return { ok: true, action: 'present', image }
  if (run(['docker', 'pull', image], { timeout: 300_000 }).ok) return { ok: true, action: 'pulled', image }
  if (kvm) {
    const dir = path.join(projectRoot || MODULE_ROOT, KVM_BUILD_DIR)
    if (!fs.existsSync(path.join(dir, 'Dockerfile'))) {
      return { ok: false, error: `guest image ${image} not available and no build context at ${dir}` }
    }
    const cloud = (OS_CATALOG[kernel] || OS_CATALOG['ubuntu-24.04']).kvm?.cloud_image || ''
    const built = run(['docker', 'build', '-t', image, '--build-arg', `CLOUD_IMAGE_URL=${cloud}`, dir], {
      timeout: 900_000,
    })
    if (!built.ok) return { ok: false, error: built.stderr || `docker build ${image} failed` }
    return { ok: true, action: 'built', image }
  }
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

export function officialCcUidGid(vmId) {
  const n = parseVmIndex(vmId) || 1
  return { uid: UID_BASE + n, gid: Number(process.env.KIN_VM_GID || GID) }
}

export function displayName(vmId) {
  return String(vmId || '').replace(/^vm-/, '')
}

export function inspectContainer(name) {
  const r = sh([
    'docker',
    'inspect',
    '--format',
    '{{.State.Running}}|{{.State.Pid}}|{{.HostConfig.NetworkMode}}|{{.State.StartedAt}}|{{.Config.Image}}|{{.Config.Hostname}}|{{index .Config.Labels "kin.vm.runtime"}}',
    name,
  ])
  if (!r.ok) return null
  const [running, pid, networkMode, startedAt, image, hostname, runtime] = r.stdout.split('|')
  return {
    name,
    running: running === 'true',
    pid: Number(pid) || 0,
    ip: networkMode === 'host' ? PUBLIC_IP : null,
    networkMode: networkMode || null,
    startedAt: startedAt || null,
    image: image || null,
    hostname: hostname || null,
    runtime: String(runtime || '').trim() || null,
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

/**
 * The runner is root, so files it creates in run/ and home/ are root-owned; the guest's
 * kincli needs them as the slot uid. Same ownership contract as docker slots (root panel).
 */
export function kvmBindChownArgv(name, vm) {
  return ['docker', 'exec', name, 'chown', '-R', `${runtimeUidNum(vm)}:${GID}`, '/slot/run', '/slot/home']
}

function chownKvmBindMounts(name, vm) {
  const r = sh(kvmBindChownArgv(name, vm), { timeout: 15_000 })
  if (!r.ok) throw new Error(`kvm bind chown: ${(r.stderr || r.stdout || '').trim() || 'failed'}`)
}

function applyKvmBindChown(name, vm) {
  if (!isKvmRuntime(vm)) return null
  try {
    chownKvmBindMounts(name, vm)
    return null
  } catch (error) {
    return { ok: false, error: String(error.message || error) }
  }
}

function runtimePatch(vm, info, extra = {}) {
  const kernel = vm.kernel || 'ubuntu-24.04'
  const meta = OS_CATALOG[kernel] || OS_CATALOG['ubuntu-24.04']
  const { routing, memory, ...rest } = extra
  vm.runtime = {
    type: runtimeKind(vm) === 'kvm' ? 'kvm' : RUNTIME,
    container: info?.name || containerName(vm.id),
    pid: info?.pid || null,
    ip: info?.ip || PUBLIC_IP,
    network: NET,
    network_mode: info?.networkMode || NET,
    started_at: info?.startedAt || rest.started_at || null,
    image: info?.image || (runtimeKind(vm) === 'kvm' ? meta.kvm?.image : meta.image),
    hostname: info?.hostname || displayName(vm.id),
    os: meta.pretty,
    memory: memory || slotMemory(vm, routing),
    user: runtimeUser(vm),
    worker: rest.worker || vm.runtime?.worker || 'rust',
    worker_socket: rest.worker_socket || vm.runtime?.worker_socket || null,
    worker_run_dir: rest.worker_run_dir || vm.runtime?.worker_run_dir || null,
    worker_token_file: rest.worker_token_file || vm.runtime?.worker_token_file || null,
    kernel_socket: rest.kernel_socket || vm.runtime?.kernel_socket || null,
    egress: rest.egress || (isLocalEgressProxy(vm.proxy) ? 'local' : 'explicit-socks5'),
    ...rest,
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
  return boundProxyUrl(vm.proxy) || null
}

/** host:port only — never include userinfo. */
export function proxyEndpointFromUrl(raw) {
  return socksProxyEndpoint({ url: raw })
}

export function proxyEndpointFromVm(vm) {
  return socksProxyEndpoint(vm?.proxy)
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
 * KVM restarts the guest kin-kernel unit; docker restart would reboot the VM.
 */
export function reloadSlotWorker(vm, projectRoot, { routing } = {}) {
  if (!vm?.id) return { ok: false, error: 'vm required' }
  const paths = workerPaths(projectRoot, vm.id)
  const name = containerName(vm.id)
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
  const existing = inspectContainer(name)
  if (!existing) return startVmRuntime(vm, projectRoot, { recreate: false, routing })
  if (!slotKernelAlive(existing, paths, vm)) {
    return startVmRuntime(vm, projectRoot, { recreate: true, routing })
  }
  if (isKvmRuntime(vm)) {
    if (!existing.running) {
      const r = sh(['docker', 'start', name], { timeout: 60_000 })
      if (!r.ok) return { ok: false, error: r.stderr || 'docker start failed' }
      const chownErr = applyKvmBindChown(name, vm)
      if (chownErr) return chownErr
      startTelemetrySidecar(name, vm)
      runtimePatch(vm, inspectContainer(name), {
        ...workerRuntimeExtra(worker),
        memory: slotMemory(vm, routing),
        routing,
      })
      return { ok: true, action: 'started', runtime: vm.runtime }
    }
    const chownErr = applyKvmBindChown(name, vm)
    if (chownErr) return chownErr
    const r = sh(
      [
        'docker',
        ...slotExecArgv(
          { ...vm, runtime: { ...vm.runtime, container: name } },
          ['systemctl', 'restart', 'kin-kernel.service'],
          { user: '0' },
        ),
      ],
      { timeout: 60_000 },
    )
    if (!r.ok) return { ok: false, error: r.stderr || 'guest kernel restart failed' }
    startTelemetrySidecar(name, vm)
    runtimePatch(vm, inspectContainer(name), {
      ...workerRuntimeExtra(worker),
      memory: slotMemory(vm, routing),
      routing,
    })
    return { ok: true, action: 'reloaded', runtime: vm.runtime }
  }
  const cmd = existing.running ? ['docker', 'restart', name] : ['docker', 'start', name]
  const r = sh(cmd, { timeout: 60_000 })
  if (!r.ok) return { ok: false, error: r.stderr || `${cmd.join(' ')} failed` }
  startTelemetrySidecar(name, vm)
  runtimePatch(vm, inspectContainer(name), { ...workerRuntimeExtra(worker), memory: slotMemory(vm, routing), routing })
  return { ok: true, action: existing.running ? 'reloaded' : 'started', runtime: vm.runtime }
}

/**
 * A running docker slot is live when its PID1 kernel has bound run/kernel.sock.
 * KVM's relay socket appears only after guest boot (minutes under TCG); a
 * running runner is enough — missing sock must not docker rm the VM.
 */
export function slotKernelAlive(existing, paths, vm) {
  if (!existing?.running) return true
  if (isKvmRuntime(vm) || existing.runtime === 'kvm') return true
  return fs.existsSync(paths.kernelSocket)
}

/** The telemetry sidecar is a docker exec child: every container (re)start loses it. */
function startTelemetrySidecar(name, vm) {
  if (!fs.existsSync(WORKER_BIN)) return
  const target = { ...(vm || {}), runtime: { ...(vm?.runtime || {}), container: name, type: runtimeKind(vm) } }
  if (!target.id && name) target.id = `vm-${String(name).replace(/^kin-/, '')}`
  sh(
    [
      'docker',
      ...slotExecArgv(target, ['/usr/local/bin/kin-worker', 'telemetry', '--config', '/run/kin/worker.json'], {
        detach: true,
      }),
    ],
    {
      timeout: 8_000,
    },
  )
}

function readProjectRouting(projectRoot) {
  try {
    return readRoutingConfigFile(projectRoot)
  } catch {
    return null
  }
}

function resolveSlotRouting(projectRoot, routing) {
  if (routing != null) return routing
  return readProjectRouting(projectRoot) || {}
}

export function writeWorkerFiles(vm, projectRoot, { transparent, routing } = {}) {
  assertProxyAllowed(vm.proxy)
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
  const resolvedRouting = resolveSlotRouting(projectRoot, routing)
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
    idle_timeout_seconds: Math.ceil(streamIdleTimeoutMs(resolvedRouting) / 1000),
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
export function shouldReplaceSlotContainer({ existing, recreate = false, network, image, runtime } = {}) {
  if (!existing) return false
  if (recreate === true) return true
  if (existing.running) return false
  const wrongNet = network != null && existing.networkMode && existing.networkMode !== network
  const wrongImg = image != null && existing.image && existing.image !== image
  const haveRuntime = existing.runtime || 'docker'
  const wrongRuntime = runtime != null && haveRuntime !== runtime
  return !!(wrongNet || wrongImg || wrongRuntime)
}

function kvmMachineFields(vm) {
  const m = vm.machine && typeof vm.machine === 'object' ? vm.machine : {}
  const smbios = m.smbios && typeof m.smbios === 'object' ? m.smbios : {}
  const d = VM_CONFIG_DEFAULTS
  return {
    vcpus: Number.isInteger(m.vcpus) ? m.vcpus : d.vcpus,
    disk_gb: Number.isInteger(m.disk_gb) ? m.disk_gb : d.disk_gb,
    cpu_model: m.cpu_model || d.cpu_model,
    mac: m.mac || '',
    smbios: {
      manufacturer: smbios.manufacturer || d.smbios.manufacturer,
      product: smbios.product || d.smbios.product,
      version: smbios.version || d.smbios.version,
      family: smbios.family || d.smbios.family,
      serial: smbios.serial || '',
      uuid: smbios.uuid || '',
    },
    disk_serial: m.disk_serial || '',
  }
}

function kvmEnvPairs(vm, { uid, gid, memMb, accel, hostName, machineId, shares }) {
  const m = kvmMachineFields(vm)
  const s = m.smbios
  const slotName = displayName(vm.id)
  return [
    `KIN_VM_ID=${vm.id}`,
    `KIN_VM_NAME=${slotName}`,
    `KIN_VM_OS=${vm.kernel}`,
    `TZ=${vm.timezone || 'UTC'}`,
    `LANG=${vm.locale || STANDARD_LOCALE}`,
    `KIN_KVM_UID=${uid}`,
    `KIN_KVM_GID=${gid}`,
    `KIN_KVM_MEMORY_MB=${memMb}`,
    `KIN_KVM_VCPUS=${m.vcpus}`,
    `KIN_KVM_DISK_GB=${m.disk_gb}`,
    `KIN_KVM_CPU_MODEL=${m.cpu_model}`,
    `KIN_KVM_MAC=${m.mac}`,
    `KIN_KVM_SMBIOS_MANUFACTURER=${s.manufacturer}`,
    `KIN_KVM_SMBIOS_PRODUCT=${s.product}`,
    `KIN_KVM_SMBIOS_VERSION=${s.version}`,
    `KIN_KVM_SMBIOS_FAMILY=${s.family}`,
    `KIN_KVM_SMBIOS_SERIAL=${s.serial}`,
    `KIN_KVM_SMBIOS_UUID=${s.uuid}`,
    `KIN_KVM_DISK_SERIAL=${m.disk_serial}`,
    `KIN_KVM_HOSTNAME=${hostName}`,
    `KIN_KVM_MACHINE_ID=${machineId}`,
    `KIN_KVM_ACCEL=${accel}`,
    `KIN_KVM_SHARES=${shares}`,
  ]
}

/** Test seam: kvm `docker run` argv (including `docker`). */
export function buildKvmRunArgs({
  vm,
  name,
  image,
  hostName,
  network,
  memory,
  accel,
  uid,
  gid,
  home,
  runDir,
  kvmDir,
  workerBin,
  kernelBin,
  shares = 'home,run',
  hostOf = (p) => p,
}) {
  const slotName = displayName(vm.id)
  const mem = kvmContainerMemory(memory)
  const memMb = memoryMiB(memory)
  const machineId = String(vm.fingerprint?.guest_machine_id || vm.fingerprint?.machine_id || '').trim()
  const env = kvmEnvPairs(vm, { uid, gid, memMb, accel, hostName, machineId, shares })
  const capAdd = KVM_CAPS.flatMap((cap) => ['--cap-add', cap])
  const device = accel === 'kvm' ? ['--device', '/dev/kvm'] : []
  return [
    'docker',
    'run',
    '-d',
    '--name',
    name,
    '--hostname',
    hostName,
    '--network',
    network,
    '--restart',
    'unless-stopped',
    '--stop-timeout',
    '30',
    '--memory',
    mem,
    '--memory-swap',
    mem,
    '--pids-limit',
    '256',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    ...capAdd,
    ...device,
    '--label',
    'kin.vm=1',
    '--label',
    `kin.vm.id=${vm.id}`,
    '--label',
    `kin.vm.name=${slotName}`,
    '--label',
    `kin.vm.os=${vm.kernel}`,
    '--label',
    'kin.vm.runtime=kvm',
    '-v',
    `${hostOf(home)}:/slot/home`,
    '-v',
    `${hostOf(runDir)}:/slot/run`,
    '-v',
    `${hostOf(kvmDir)}:/slot/kvm`,
    ...(workerBin ? ['-v', `${hostOf(workerBin)}:/opt/kin-guest/usr/local/bin/kin-worker:ro`] : []),
    ...(kernelBin ? ['-v', `${hostOf(kernelBin)}:/opt/kin-guest/usr/local/bin/kin-kernel:ro`] : []),
    ...env.flatMap((pair) => ['-e', pair]),
    ...(process.env.KIN_VM_HOST_GATEWAY === '1' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
    '--dns',
    '8.8.8.8',
    '--dns-opt',
    'use-vc',
    image,
  ]
}

export function startVmRuntime(vm, projectRoot, { recreate = false, routing, accel: accelOpt } = {}) {
  if (isKvmRuntime(vm) && accelOpt !== 'kvm' && accelOpt !== 'tcg') {
    const recorded = vm.runtime?.accel
    if (recorded !== 'kvm' && recorded !== 'tcg') {
      const resolved = resolveSlotRouting(projectRoot, routing)
      return probeLocalKvm({ routing: resolved }).then((probe) => {
        if (!probe.ok) return { ok: false, code: 'kvm_unavailable', error: probe.error || '本机不支持 KVM' }
        return startVmRuntime(vm, projectRoot, { recreate, routing: resolved, accel: probe.accel })
      })
    }
    return startVmRuntime(vm, projectRoot, { recreate, routing, accel: recorded })
  }
  const kvm = isKvmRuntime(vm)
  const name = containerName(vm.id)
  const slotName = displayName(vm.id)
  const host = String(vm.fingerprint?.hostname || '').trim() || slotName
  const kernel = vm.kernel && OS_CATALOG[vm.kernel] ? vm.kernel : 'ubuntu-24.04'
  vm.kernel = kernel
  const zone = validTimezone(vm.timezone)
  if (zone) vm.timezone = zone
  vm.locale = vm.locale || STANDARD_LOCALE
  const resolvedRouting = resolveSlotRouting(projectRoot, routing)
  const mem = slotMemory(vm, resolvedRouting)
  const image = kvm ? kvmImageForKernel(kernel) : imageForKernel(kernel)
  const home = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  fs.mkdirSync(home, { recursive: true })
  try {
    ensureSlotClaudeOwnership(home, runtimeUidNum(vm), Number(GID))
  } catch (error) {
    if (!kvm) throw error
  }

  const proxy = ensureOuterSocks(vm)
  if (!proxy.ok) return proxy
  const eg = ensureProxyEgress(projectRoot, vm.proxy)
  if (!eg.ok) return eg
  if (!eg.network && !eg.name) return { ok: false, error: 'egress network missing; refusing host fallback' }

  let existing = inspectContainer(name)
  const paths = workerPaths(projectRoot, vm.id)
  const replace = recreate || !slotKernelAlive(existing, paths, vm)
  // Node restart / 开机 must not bounce a live slot with a healthy worker.
  if (existing?.running && !replace) {
    runtimePatch(vm, existing, {
      worker_socket: paths.socket,
      worker_run_dir: paths.runDir,
      worker_token_file: paths.token,
      memory: mem,
      routing: resolvedRouting,
      ...(kvm ? { accel: accelOpt || vm.runtime?.accel } : {}),
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
    worker = writeWorkerFiles(vm, projectRoot, { transparent: true, routing: resolvedRouting })
  } catch (error) {
    return { ok: false, error: String(error.message || error) }
  }
  try {
    fs.chownSync(home, runtimeUidNum(vm), Number(GID))
  } catch {}

  if (
    shouldReplaceSlotContainer({
      existing,
      recreate: replace,
      network: slotNetworkForVm(vm),
      image,
      runtime: runtimeKind(vm),
    })
  ) {
    sh(['docker', 'rm', '-f', name])
    existing = null
  }
  if (existing?.running) {
    const chownErr = applyKvmBindChown(name, vm)
    if (chownErr) return chownErr
    runtimePatch(vm, existing, { ...workerRuntimeExtra(worker), memory: mem, routing: resolvedRouting })
    return { ok: true, action: 'already-running', runtime: vm.runtime }
  }
  if (existing) {
    const r = sh(['docker', 'start', name])
    if (!r.ok) return { ok: false, error: r.stderr || 'docker start failed' }
    const chownErr = applyKvmBindChown(name, vm)
    if (chownErr) return chownErr
    startTelemetrySidecar(name, vm)
    runtimePatch(vm, inspectContainer(name), { ...workerRuntimeExtra(worker), memory: mem, routing: resolvedRouting })
    return { ok: true, action: 'started', runtime: vm.runtime }
  }

  const img = ensureSlotImage(kernel, { projectRoot, runtime: runtimeKind(vm) })
  if (!img.ok) return img

  try {
    fs.rmSync(worker.socket, { force: true })
  } catch {}
  // Creating a new runner: a leftover relay sock would block socat bind.
  try {
    fs.rmSync(worker.kernelSocket, { force: true })
  } catch {}
  const machineIdFile = ensureGuestMachineIdFile(projectRoot, vm)
  const hostOf = (p) => toHostPath(p, { projectRoot })
  const netName = slotNetworkForVm(vm)
  if (!netName || netName === 'host' || netName === 'bridge') {
    return { ok: false, error: 'bound SOCKS5 network required; refusing host/bridge fallback' }
  }

  let args
  if (kvm) {
    const kvmDir = path.join(projectRoot, 'vms', vm.id, 'kvm')
    fs.mkdirSync(kvmDir, { recursive: true, mode: 0o700 })
    try {
      fs.chownSync(kvmDir, runtimeUidNum(vm), Number(GID))
    } catch {}
    args = buildKvmRunArgs({
      vm,
      name,
      image,
      hostName: host,
      network: netName,
      memory: mem,
      accel: accelOpt,
      uid: runtimeUidNum(vm),
      gid: Number(GID),
      home,
      runDir: worker.runDir,
      kvmDir,
      workerBin: fs.existsSync(WORKER_BIN) ? WORKER_BIN : null,
      kernelBin: mountKernel ? kernelBin : null,
      shares: 'home,run',
      hostOf,
    })
  } else {
    const machineMounts = machineIdFile
      ? [
          '-v',
          `${hostOf(machineIdFile)}:/etc/machine-id:ro`,
          '-v',
          `${hostOf(machineIdFile)}:/var/lib/dbus/machine-id:ro`,
        ]
      : []
    args = [
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
      mem,
      '--memory-swap',
      mem,
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
      '--label',
      'kin.vm.runtime=docker',
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
      `TZ=${zone || 'UTC'}`,
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
  }

  const r = sh(args, { timeout: 90_000 })
  if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'docker run failed' }
  const chownErr = applyKvmBindChown(name, vm)
  if (chownErr) return chownErr
  runtimePatch(vm, inspectContainer(name), {
    container_id: r.stdout,
    memory: mem,
    routing: resolvedRouting,
    ...(kvm ? { accel: accelOpt } : {}),
    ...workerRuntimeExtra(worker),
  })
  startTelemetrySidecar(name, vm)
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
  const grace = isKvmRuntime(vm) || info.runtime === 'kvm' ? '30' : '3'
  const r = sh(['docker', 'stop', '-t', grace, name])
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
