/**
 * Slot lifecycle on a macOS cluster node (`platform: 'darwin'`). Same return
 * contract as remote-slot's Docker lifecycle, but nothing here touches Docker:
 * the slot kernel and its telemetry sidecar are launchd services of the node's
 * SSH user, driven with `launchctl` over the node's SSH link.
 *
 * Node layout (SSH user's HOME, no sudo):
 *   <root>/native/<digest>/{kin-kernel,cli-node,cc-node,kin-worker}   payload, shared
 *   <root>/vms/<id>/cli-home      HOME of the slot processes
 *   <root>/vms/<id>/claude        CLAUDE_CONFIG_DIR (credentials, settings)
 *   <root>/vms/<id>/run           kernel.json, worker.json, token, kernel/worker sockets
 *   <root>/vms/<id>/{logs,tmp}    service logs, TMPDIR
 *   <root>/vms/<id>/launchd       the two service plists
 *
 * The plists stay inside the slot tree, not in ~/Library/LaunchAgents: launchd
 * must not load a second copy at login next to the one this module bootstraps.
 * After a reboot the control plane finds the services missing and starts them
 * again (kernel watchdog → restartNativeKernel), so no console login is needed.
 *
 * Isolation is the user account: every slot on the node shares the SSH user,
 * its network and its hardware. First version: Claude slots on the node's own
 * network exit only (no SOCKS5 binding, no Codex, no crag).
 */

import fs from 'node:fs'
import path from 'node:path'
import { ensureGuestMachineIdFile } from '../identity/workstation-fingerprint.mjs'
import { isLocalEgressProxy } from '../vm/egress.mjs'
import { isKvmRuntime, runtimeKind } from '../vm/runtime-kind.mjs'
import { resolveKernelDataplane } from '../vm/slot-engine.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { displayName, normalizeTimezone, STANDARD_LOCALE, writeWorkerFiles } from '../vm/vm-runtime.mjs'
import { describeNativePayload, ensureNativePayload, remoteNativePayloadDir } from './native-payload.mjs'
import { clusterManager, nodeSession, placementProjectRoot, remoteSlotDir, vmNodeId } from './placement.mjs'
import { openSftp, readRemoteFileNoFollow, runRemote, shellQuote, writeRemoteFile } from './remote-fs.mjs'
import { pushSlotFiles, reconcileSlotCredentials, removeRemoteSlotDir } from './remote-slot-files.mjs'
import { ClusterError, execCollect } from './ssh-link.mjs'

// sockaddr_un.sun_path is 104 bytes on macOS, including the terminating NUL.
export const DARWIN_SUN_PATH_MAX = 103
const LOG_KEEP_BYTES = 1024 * 1024
const LOG_ROTATE_BYTES = 8 * 1024 * 1024
const BOOTOUT_WAIT_TRIES = 25
// kickstart -k waits for the old process to exit (up to the job's ExitTimeOut) before it returns.
const LAUNCHCTL_TIMEOUT_MS = 30_000
const LABEL_PREFIX = 'com.vm2api.slot'
export const LAUNCHD_GUI_REQUIRED =
  'SSH 用户没有登录 macOS 图形界面：launchd 槽位需要该用户保持登录（Mac mini 请开启自动登录）'

function failure(err, fallbackCode = 'native_slot_failed') {
  const code = err?.code && typeof err.code === 'string' ? err.code : fallbackCode
  return {
    ok: false,
    code,
    error: String(err?.message || err).slice(0, 500),
    ...(err?.vmOperationUncertain ? { vmOperationUncertain: true } : {}),
  }
}

export function nativeLabels(vmId) {
  return { kernel: `${LABEL_PREFIX}.${vmId}.kernel`, telemetry: `${LABEL_PREFIX}.${vmId}.telemetry` }
}

/** Node-side paths of one slot; `payload` is the shared binaries directory of `digest`. */
export function nativeSlotPaths(root, vmId, digest) {
  const dir = `${root}/vms/${vmId}`
  return {
    dir,
    home: `${dir}/cli-home`,
    claude: `${dir}/claude`,
    run: `${dir}/run`,
    logs: `${dir}/logs`,
    tmp: `${dir}/tmp`,
    launchd: `${dir}/launchd`,
    payload: remoteNativePayloadDir(root, digest),
  }
}

/** Why `vm` cannot run on a macOS node in this version, or null. */
export function nativeUnsupported(vm, routing) {
  const no = (code, error) => ({ ok: false, code, error })
  if (isCodexVm(vm)) return no('native_codex_unsupported', 'macOS 原生节点暂不支持 Codex 槽位')
  if (isKvmRuntime(vm)) return no('native_kvm_unsupported', 'macOS 原生节点不运行 KVM 槽位')
  if (resolveKernelDataplane(vm, routing || {}) === 'crag' || vm?.dataplane === 'crag') {
    return no('native_crag_unsupported', 'crag 数据面暂不支持 macOS 原生节点')
  }
  if (!isLocalEgressProxy(vm?.proxy)) {
    return no('native_proxy_unsupported', 'macOS 原生节点目前只支持本机网络出口，请解除 SOCKS5 代理绑定')
  }
  return null
}

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c])

function plistValue(value, indent) {
  const pad = '  '.repeat(indent)
  if (typeof value === 'boolean') return `${pad}<${value}/>`
  if (typeof value === 'number') return `${pad}<integer>${Math.trunc(value)}</integer>`
  if (Array.isArray(value)) {
    return [`${pad}<array>`, ...value.map((v) => plistValue(v, indent + 1)), `${pad}</array>`].join('\n')
  }
  if (value && typeof value === 'object') {
    const lines = [`${pad}<dict>`]
    for (const [k, v] of Object.entries(value)) {
      lines.push(`${pad}  <key>${xml(k)}</key>`, plistValue(v, indent + 1))
    }
    lines.push(`${pad}</dict>`)
    return lines.join('\n')
  }
  return `${pad}<string>${xml(value)}</string>`
}

export function renderPlist(dict) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(dict, 0),
    '</plist>',
    '',
  ].join('\n')
}

function slotEnv(vm, p) {
  return {
    HOME: p.home,
    CLAUDE_CONFIG_DIR: p.claude,
    TMPDIR: `${p.tmp}/`,
    TZ: vm.timezone,
    LANG: vm.locale,
    PATH: `${p.payload}:/usr/bin:/bin:/usr/sbin:/sbin`,
    KIN_VM_ID: vm.id,
    KIN_VM_NAME: displayName(vm.id),
    KIN_VM_OS: 'macos',
  }
}

/** The two launchd jobs of a slot: `{ kernel, telemetry }`, each `{ label, path, body }`. */
export function nativeServicePlists(vm, p) {
  const labels = nativeLabels(vm.id)
  const env = slotEnv(vm, p)
  const common = { EnvironmentVariables: env, WorkingDirectory: p.home, Umask: 0o077, ProcessType: 'Standard' }
  const kernel = {
    Label: labels.kernel,
    ProgramArguments: [`${p.payload}/kin-kernel`, '--gateway-worker', '--config', `${p.run}/kernel.json`],
    ...common,
    RunAtLoad: true,
    // Like the container's unless-stopped: the kernel is always restarted, at most every 10 s.
    KeepAlive: true,
    ThrottleInterval: 10,
    // SIGTERM, then SIGKILL after 10 s: the grace `docker stop` gives the container's PID 1.
    ExitTimeOut: 10,
    StandardOutPath: `${p.logs}/kernel.log`,
    StandardErrorPath: `${p.logs}/kernel.log`,
  }
  const telemetry = {
    Label: labels.telemetry,
    ProgramArguments: [`${p.payload}/kin-worker`, 'telemetry', '--config', `${p.run}/worker.json`],
    ...common,
    RunAtLoad: true,
    // A clean exit (telemetry disabled, 4xx) stays down until the next start, like the docker exec sidecar.
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 60,
    ExitTimeOut: 5,
    StandardOutPath: `${p.logs}/telemetry.log`,
    StandardErrorPath: `${p.logs}/telemetry.log`,
  }
  return {
    kernel: { label: labels.kernel, path: `${p.launchd}/${labels.kernel}.plist`, body: renderPlist(kernel) },
    telemetry: {
      label: labels.telemetry,
      path: `${p.launchd}/${labels.telemetry}.plist`,
      body: renderPlist(telemetry),
    },
  }
}

/**
 * `launchctl print <domain>/<label>` → `{ state, pid, last_exit_code, runs }`.
 * state: 'running' | 'stopped' | 'missing'. The format is undocumented; only
 * the long-stable top-level `state =`, `pid =`, `runs =` and `last exit code =` lines are read.
 */
export function parseLaunchctlPrint(stdout, code = 0) {
  const text = String(stdout || '')
  if (code === 113 || /Could not find service/i.test(text))
    return { state: 'missing', pid: null, last_exit_code: null, runs: 0 }
  const field = (name) => {
    const m = new RegExp(`^\\t${name} = (.+)$`, 'm').exec(text)
    return m ? m[1].trim() : null
  }
  const state = field('state')
  const pid = Number(field('pid'))
  const exit = field('last exit code')
  const runs = Number(field('runs'))
  return {
    state: state === 'running' ? 'running' : state ? 'stopped' : 'unknown',
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    last_exit_code: exit == null || !/^-?\d+/.test(exit) ? null : Number.parseInt(exit, 10),
    runs: Number.isInteger(runs) ? runs : 0,
  }
}

const domains = new WeakMap()

/**
 * The SSH user's gui/<uid> domain. A non-root user can bootstrap jobs only
 * there (user/<uid> refuses with EIO), and it exists only while that user is
 * logged in at the console: a headless Mac mini needs automatic login, which
 * also brings the domain back after a reboot.
 */
export async function launchdDomain(session) {
  const cached = domains.get(session.client)
  if (cached) return cached
  const out = await runRemote(
    session.client,
    'u=$(id -u); if launchctl print "gui/$u" >/dev/null 2>&1; then echo "gui/$u"; else echo none; fi',
    { timeoutMs: LAUNCHCTL_TIMEOUT_MS },
  )
  const domain = out.trim()
  if (!/^gui\/\d+$/.test(domain)) {
    throw new ClusterError(409, 'launchd_gui_required', LAUNCHD_GUI_REQUIRED)
  }
  domains.set(session.client, domain)
  return domain
}

export async function nativeServiceStatus(session, domain, label) {
  const r = await execCollect(session.client, `launchctl print ${shellQuote(`${domain}/${label}`)}`, {
    timeoutMs: LAUNCHCTL_TIMEOUT_MS,
  })
  const status = parseLaunchctlPrint(`${r.stdout}\n${r.stderr}`, r.code)
  if ((r.code !== 0 && status.state !== 'missing') || status.state === 'unknown') {
    throw new ClusterError(502, 'launchd_status_unknown', r.stderr || 'Unable to inspect launchd service')
  }
  return status
}

/** Remove a job and wait until launchd has really let go of the label (bootout returns early). */
async function bootout(session, domain, label) {
  const target = shellQuote(`${domain}/${label}`)
  const before = await nativeServiceStatus(session, domain, label)
  if (before.state === 'missing') return
  const result = await execCollect(session.client, `launchctl bootout ${target}`, { timeoutMs: LAUNCHCTL_TIMEOUT_MS })
  if (result.code !== 0 && parseLaunchctlPrint(`${result.stdout}\n${result.stderr}`, result.code).state !== 'missing') {
    throw new ClusterError(502, 'launchd_bootout_failed', result.stderr || 'launchctl bootout failed')
  }
  for (let i = 0; i < BOOTOUT_WAIT_TRIES; i++) {
    const current = await nativeServiceStatus(session, domain, label)
    if (current.state === 'missing') {
      if (!before.pid) return
      const process = await execCollect(session.client, `ps -p ${before.pid} -o pid=`, {
        timeoutMs: LAUNCHCTL_TIMEOUT_MS,
      })
      if (process.code === 1 && !process.stdout.trim() && !process.stderr.trim()) return
      if (process.code !== 0)
        throw new ClusterError(502, 'launchd_exit_unknown', process.stderr || 'Unable to inspect old launchd process')
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new ClusterError(502, 'launchd_exit_unconfirmed', 'Old launchd process termination was not confirmed')
}

async function bootstrap(session, domain, plistPath) {
  await runRemote(session.client, `launchctl bootstrap ${shellQuote(domain)} ${shellQuote(plistPath)}`, {
    timeoutMs: LAUNCHCTL_TIMEOUT_MS,
    code: 'launchd_bootstrap_failed',
  })
}

async function kickstart(session, domain, label, { kill = true } = {}) {
  await runRemote(session.client, `launchctl kickstart ${kill ? '-k ' : ''}${shellQuote(`${domain}/${label}`)}`, {
    timeoutMs: LAUNCHCTL_TIMEOUT_MS,
    code: 'launchd_kickstart_failed',
  })
}

/**
 * Bring one job to the wanted shape: a changed plist is booted out and
 * bootstrapped again (launchd keeps the loaded copy otherwise), a missing job is
 * bootstrapped, and `restart` bounces a loaded one in place.
 */
async function applyService(session, domain, svc, { changed, restart }) {
  const status = await nativeServiceStatus(session, domain, svc.label)
  if (status.state !== 'missing' && changed) await bootout(session, domain, svc.label)
  if (status.state === 'missing' || changed) {
    await bootstrap(session, domain, svc.path)
    return 'loaded'
  }
  if (restart || status.state !== 'running') {
    await kickstart(session, domain, svc.label)
    return 'restarted'
  }
  return 'unchanged'
}

/** Write the plists; returns which of them changed on the node. */
async function publishPlists(session, plists) {
  const sftp = await openSftp(session.client)
  const changed = {}
  for (const [key, svc] of Object.entries(plists)) {
    const current = await readRemoteFileNoFollow(session.client, svc.path).catch(() => null)
    changed[key] = !current || current.toString('utf8') !== svc.body
    if (changed[key]) await writeRemoteFile(sftp, svc.path, svc.body, { mode: 0o600 })
  }
  return changed
}

async function prepareSlotTree(session, p) {
  const dirs = [p.dir, p.home, p.claude, p.run, p.logs, p.tmp, p.launchd].map(shellQuote).join(' ')
  // launchd appends forever: keep the newest 1 MiB of a log that grew past 8 MiB.
  const rotate = ['kernel.log', 'telemetry.log']
    .map((name) => {
      const f = shellQuote(`${p.logs}/${name}`)
      return `if [ -f ${f} ] && [ $(wc -c < ${f}) -gt ${LOG_ROTATE_BYTES} ]; then tail -c ${LOG_KEEP_BYTES} ${f} > ${f}.tmp && mv ${f}.tmp ${f}; fi`
    })
    .join('\n')
  await runRemote(session.client, `umask 077 && mkdir -p ${dirs} && chmod 700 ${dirs}\n${rotate}`, {
    timeoutMs: 20_000,
  })
}

function assertSocketPaths(p) {
  for (const name of ['kernel.sock', 'worker.sock']) {
    const sock = `${p.run}/${name}`
    if (Buffer.byteLength(sock) > DARWIN_SUN_PATH_MAX) {
      throw new ClusterError(
        409,
        'native_socket_path_too_long',
        `套接字路径超过 macOS 上限 ${DARWIN_SUN_PATH_MAX} 字节：${sock}（请换用 HOME 更短的 SSH 用户）`,
      )
    }
  }
}

async function nativeSession(vm) {
  const nodeId = vmNodeId(vm)
  const session = await nodeSession(nodeId)
  if (session.host.platform !== 'darwin') {
    throw new ClusterError(409, 'node_platform_mismatch', `节点 ${nodeId} 不是 macOS，不能按原生方式管理槽位`)
  }
  return session
}

function applyNativeRuntime(vm, { nodeId, session, p, digest, domain, relays, slotDir, kernel }) {
  vm.runtime = {
    ...(vm.runtime || {}),
    type: runtimeKind(vm),
    host: 'native',
    node_id: nodeId,
    container: null,
    container_id: null,
    pid: kernel?.pid || null,
    ip: null,
    network: null,
    network_mode: 'host',
    started_at: new Date().toISOString(),
    image: null,
    hostname: null,
    os: 'macOS',
    user: `${session.host.uid}:${session.host.gid}`,
    worker: 'rust',
    worker_socket: relays.worker,
    kernel_socket: relays.kernel,
    worker_run_dir: path.join(slotDir, 'run'),
    worker_token_file: path.join(slotDir, 'run', 'internal.token'),
    egress: 'local',
    egress_container: null,
    remote_dir: p.dir,
    payload_digest: digest,
    launchd: { domain, ...nativeLabels(vm.id) },
    stopped: false,
  }
}

/** The sidecar job runs only while worker.json enables telemetry (the panel switch); off means not loaded. */
function telemetryEnabled(slotDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(slotDir, 'run', 'worker.json'), 'utf8')).telemetry?.enabled === true
  } catch {
    return false
  }
}

async function applyTelemetry(c, { restart }) {
  if (!telemetryEnabled(c.slotDir)) {
    const status = await nativeServiceStatus(c.session, c.domain, c.plists.telemetry.label)
    if (status.state !== 'missing') await bootout(c.session, c.domain, c.plists.telemetry.label)
    return 'disabled'
  }
  return applyService(c.session, c.domain, c.plists.telemetry, { changed: c.changed.telemetry, restart })
}

async function configureSlot(vm, projectRoot, routing) {
  const blocked = nativeUnsupported(vm, routing)
  if (blocked) return { fail: blocked }
  vm.timezone = normalizeTimezone(vm.timezone)
  vm.locale = vm.locale || STANDARD_LOCALE
  const nodeId = vmNodeId(vm)
  const session = await nativeSession(vm)
  const payload = await ensureNativePayload(session, projectRoot)
  const p = nativeSlotPaths(session.host.root, vm.id, payload.digest)
  assertSocketPaths(p)
  const domain = await launchdDomain(session)
  const slotDir = path.join(projectRoot, 'vms', vm.id)
  await prepareSlotTree(session, p)
  const relays = await clusterManager().ensureSlotRelays(nodeId, vm.id)
  const worker = writeWorkerFiles(vm, projectRoot, { transparent: true, routing })
  await worker?.publication
  ensureGuestMachineIdFile(projectRoot, vm)
  await pushSlotFiles(vm, slotDir, ['run', 'seed'], session)
  await reconcileSlotCredentials(vm, slotDir, session)
  const plists = nativeServicePlists(vm, p)
  const changed = await publishPlists(session, plists)
  return { nodeId, session, p, digest: payload.digest, domain, relays, slotDir, plists, changed }
}

/** Twin of startRemoteSlot. A running kernel with an unchanged plist is left alone unless `recreate`. */
export async function startNativeSlot(vm, projectRoot, { recreate = false, routing } = {}) {
  try {
    const c = await configureSlot(vm, projectRoot, routing)
    if (c.fail) return c.fail
    const before = await nativeServiceStatus(c.session, c.domain, c.plists.kernel.label)
    const kernelAction = await applyService(c.session, c.domain, c.plists.kernel, {
      changed: c.changed.kernel,
      restart: recreate,
    })
    await applyTelemetry(c, { restart: recreate })
    const kernel = await nativeServiceStatus(c.session, c.domain, c.plists.kernel.label)
    applyNativeRuntime(vm, { ...c, kernel })
    const action = kernelAction === 'unchanged' ? 'already-running' : before.state === 'missing' ? 'created' : 'started'
    return { ok: true, action, runtime: vm.runtime }
  } catch (err) {
    return failure(err)
  }
}

/** Twin of reloadRemoteSlot: republish config, bounce the kernel and the sidecar. */
export async function reloadNativeSlot(vm, projectRoot, { routing } = {}) {
  try {
    const c = await configureSlot(vm, projectRoot, routing)
    if (c.fail) return c.fail
    const before = await nativeServiceStatus(c.session, c.domain, c.plists.kernel.label)
    await applyService(c.session, c.domain, c.plists.kernel, { changed: c.changed.kernel, restart: true })
    await applyTelemetry(c, { restart: true })
    const kernel = await nativeServiceStatus(c.session, c.domain, c.plists.kernel.label)
    applyNativeRuntime(vm, { ...c, kernel })
    return { ok: true, action: before.state === 'running' ? 'reloaded' : 'started', runtime: vm.runtime }
  } catch (err) {
    return failure(err)
  }
}

export async function stopNativeSlot(vm) {
  try {
    const session = await nativeSession(vm)
    const domain = await launchdDomain(session)
    const labels = nativeLabels(vm.id)
    const was = await nativeServiceStatus(session, domain, labels.kernel)
    await bootout(session, domain, labels.telemetry)
    await bootout(session, domain, labels.kernel)
    if (vm.runtime) vm.runtime = { ...vm.runtime, pid: null, stopped: true }
    return { ok: true, action: was.state === 'missing' ? 'absent' : 'stopped', runtime: vm.runtime || null }
  } catch (err) {
    return { ...failure(err), vmOperationUncertain: true }
  }
}

/** Explicit delete / factory reset: both jobs, the node-side slot tree and the local relays. */
export async function destroyNativeSlot(vm) {
  try {
    const session = await nativeSession(vm)
    const domain = await launchdDomain(session)
    const labels = nativeLabels(vm.id)
    const was = await nativeServiceStatus(session, domain, labels.kernel)
    await bootout(session, domain, labels.telemetry)
    await bootout(session, domain, labels.kernel)
    await removeRemoteSlotDir(vm, session)
    await clusterManager().dropSlotRelays(vm.id)
    if (vm.runtime) vm.runtime = { ...vm.runtime, pid: null, ip: null, stopped: true, removed: true }
    return { ok: true, action: was.state === 'missing' ? 'absent' : 'removed', runtime: vm.runtime || null }
  } catch (err) {
    return { ...failure(err), vmOperationUncertain: true }
  }
}

/** Watchdog view of the kernel job, same states as observeWatchdogContainer. Never throws. */
export async function observeNativeSlot(vm) {
  try {
    const session = await nativeSession(vm)
    const domain = await launchdDomain(session)
    const status = await nativeServiceStatus(session, domain, nativeLabels(vm.id).kernel)
    if (status.state === 'missing') return { state: 'missing' }
    if (status.state === 'running') return { state: 'running' }
    if (status.state === 'stopped') return { state: 'stopped' }
    return { state: 'unknown' }
  } catch {
    return { state: 'unknown' }
  }
}

/** Same shape as inspectSlotContainer, for the slot recovery panel. */
export async function inspectNativeSlot(vm) {
  const session = await nativeSession(vm)
  const domain = await launchdDomain(session)
  const status = await nativeServiceStatus(session, domain, nativeLabels(vm.id).kernel)
  if (status.state === 'missing') return { exists: false, running: false }
  const running = status.state === 'running'
  let logTail = []
  if (!running) {
    const log = shellQuote(`${remoteSlotDir(session.host, vm.id)}/logs/kernel.log`)
    const r = await execCollect(session.client, `tail -n 50 ${log} 2>/dev/null`, { timeoutMs: 10_000 }).catch(
      () => null,
    )
    logTail = String(r?.stdout || '')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-20)
  }
  return {
    exists: true,
    running,
    restarting: false,
    restart_count: status.runs > 0 ? status.runs - 1 : 0,
    status: running ? 'running' : 'exited',
    exit_code: status.last_exit_code,
    oom_killed: false,
    error: null,
    finished_at: null,
    log_tail: logTail,
  }
}

/**
 * Kernel watchdog / supervisor restart. A loaded job is bounced in place; a
 * missing one (node rebooted, job booted out) gets the full start.
 */
export async function restartNativeKernel(vm, projectRoot, { routing } = {}) {
  try {
    const session = await nativeSession(vm)
    const domain = await launchdDomain(session)
    const status = await nativeServiceStatus(session, domain, nativeLabels(vm.id).kernel)
    if (status.state === 'missing') return startNativeSlot(vm, projectRoot, { routing })
    await kickstart(session, domain, nativeLabels(vm.id).kernel)
    return { ok: true, action: 'restarted' }
  } catch (err) {
    return failure(err)
  }
}

/** true / false, or null when the node cannot be asked. */
export async function nativeTelemetryRunning(vm) {
  try {
    const session = await nativeSession(vm)
    const domain = await launchdDomain(session)
    const status = await nativeServiceStatus(session, domain, nativeLabels(vm.id).telemetry)
    return status.state === 'running'
  } catch {
    return null
  }
}

/** Telemetry switch: enabled bounces (or loads) the sidecar job, disabled boots it out. */
export async function restartNativeTelemetry(vm, { enabled } = {}) {
  try {
    const session = await nativeSession(vm)
    const domain = await launchdDomain(session)
    const labels = nativeLabels(vm.id)
    if (enabled !== true) {
      await bootout(session, domain, labels.telemetry)
      return { ok: true, action: 'stopped' }
    }
    // Same as a Docker node: the sidecar reads worker.json, so publish the current one first.
    const projectRoot = placementProjectRoot()
    if (projectRoot) await pushSlotFiles(vm, path.join(projectRoot, 'vms', vm.id), ['run', 'seed'], session)
    const svc = {
      label: labels.telemetry,
      path: `${remoteSlotDir(session.host, vm.id)}/launchd/${labels.telemetry}.plist`,
    }
    await applyService(session, domain, svc, { changed: false, restart: true })
    return { ok: true, action: 'restarted' }
  } catch (err) {
    return failure(err, 'service_update_failed')
  }
}

/** Payload digest the control plane would publish now, or null when the darwin payload is incomplete. */
export function currentNativePayloadDigest(projectRoot) {
  try {
    return describeNativePayload(projectRoot).digest
  } catch {
    return null
  }
}

/**
 * Slot payload refresh (panel "update slots"): a new darwin build is a new
 * digest, so the plists change and the jobs are reloaded onto it. Same result shape as refreshNodeSlotPayload.
 */
export async function refreshNativeSlotPayload(vm, projectRoot, { routing, recreate = true } = {}) {
  const id = vm?.id
  const nodeId = vmNodeId(vm)
  const digest = currentNativePayloadDigest(projectRoot)
  if (!digest) {
    return { id, node_id: nodeId, ok: false, code: 'native_payload_missing', error: '缺少 darwin/arm64 槽位产物' }
  }
  const changed = vm.runtime?.payload_digest !== digest
  const running = recreate !== false && vm.status === 'running'
  if (!changed || !running) {
    return {
      id,
      node_id: nodeId,
      ok: true,
      image: null,
      kernel_changed: changed,
      restarted: false,
      kernel: { ok: true, skipped: true, reason: changed ? 'vm_stopped' : 'unchanged' },
    }
  }
  const boot = await startNativeSlot(vm, projectRoot, { routing })
  if (!boot.ok) return { id, node_id: nodeId, ok: false, code: boot.code, error: boot.error, image: null }
  return {
    id,
    node_id: nodeId,
    ok: true,
    image: null,
    kernel_changed: true,
    restarted: true,
    kernel: { ok: true, action: boot.action },
  }
}
