/**
 * Slot lifecycle for VMs placed on a cluster node (`vm.node_id`). Same shape
 * and return contract as vm-runtime's startVmRuntime / stopVmRuntime /
 * destroyVmRuntime / reloadSlotWorker, but every Docker call goes through the
 * Engine API over the node's SSH link (never the synchronous docker CLI, which
 * would deadlock on the in-process bridge).
 *
 * Remote layout (SSH user's HOME, no sudo):
 *   <root>/vms/<id>/{cli-home,run,machine-id}   bind-mounted like a local slot
 *   <root>/egress/<proxy>/egress.json           kin-egress config (SOCKS exits)
 */

import crypto from 'node:crypto'
import path from 'node:path'
import { ensureGuestMachineIdFile } from '../identity/workstation-fingerprint.mjs'
import {
  boundProxyUrl,
  bridgeName,
  chainName,
  configuredDnsUpstream,
  configuredDnsEmptyTypes,
  gatewayFromSubnet,
  iptablesPlan,
  isLocalEgressProxy,
  LOCAL_EGRESS_ID,
  networkName,
  portsForProxy,
  proxyKey,
} from '../vm/egress.mjs'
import { OS_CATALOG } from '../vm/os-catalog.mjs'
import { REMOTE_KERNEL_ENTRY, resolveKernelDataplane } from '../vm/slot-engine.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'
import { isKvmRuntime, runtimeKind } from '../vm/runtime-kind.mjs'
import { slotMemory, slotDockerCpus, memoryMiB, normalizeVmConfig, VM_CONFIG_DEFAULTS } from '../vm/machine-spec.mjs'
import { slotExecArgv, slotExecCmd } from '../vm/slot-exec.mjs'
import {
  CODEX_SLOT_ROLE,
  containerName,
  displayName,
  kvmBindChownArgv,
  normalizeTimezone,
  KVM_CAPS,
  STANDARD_LOCALE,
  writeWorkerFiles,
} from '../vm/vm-runtime.mjs'
import {
  containerAction,
  createContainerRaw,
  createNetwork,
  execDetached,
  imagePresent,
  inspectContainerOrNull,
  inspectNetworkOrNull,
  connectContainerToNetwork,
  disconnectContainerFromNetwork,
  removeContainer,
  removeNetwork,
  renameContainer,
} from './docker-remote.mjs'
import {
  awaitSlotImageBuild,
  clusterManager,
  nodeSession,
  parseMemoryBytes,
  remoteSlotDir,
  remoteSlotOwner,
  startSlotImageBuild,
  vmNodeId,
} from './placement.mjs'
import { openSftp, readRemoteFileNoFollow, runRemote, shellQuote, writeRemoteFile } from './remote-fs.mjs'
import {
  pushSlotBinaries,
  pushSlotFiles,
  reconcileSlotCredentials,
  remoteSlotPath,
  removeRemoteSlotDir,
} from './remote-slot-files.mjs'
import { REMOTE_WORKER_BIN, slotImageSpec } from './slot-image.mjs'

/** Bump when the slot's mount layout changes; a running container with an older label is recreated. */
const SLOT_LAYOUT = '3'
const LIVE_BIN = '/opt/kin-live'
const LIVE_BIN_GUEST = '/opt/kin-guest/opt/kin-live'
const LIVE_SERVICE_MOUNT_DESTINATIONS = Object.freeze([LIVE_BIN, LIVE_BIN_GUEST])

function failure(err, fallbackCode = 'remote_slot_failed') {
  return { ok: false, code: err?.code || fallbackCode, error: String(err?.message || err) }
}

const MIGRATION_CONFIG_KEYS = Object.freeze([
  'Hostname',
  'Domainname',
  'User',
  'AttachStdin',
  'AttachStdout',
  'AttachStderr',
  'Tty',
  'OpenStdin',
  'StdinOnce',
  'Env',
  'Cmd',
  'Image',
  'Volumes',
  'WorkingDir',
  'Entrypoint',
  'Labels',
  'StopSignal',
  'StopTimeout',
  'Shell',
  'ExposedPorts',
])
const MIGRATION_HOST_CONFIG_KEYS = Object.freeze([
  'Binds',
  'LogConfig',
  'NetworkMode',
  'PortBindings',
  'PublishAllPorts',
  'Privileged',
  'ReadonlyRootfs',
  'Dns',
  'DnsOptions',
  'DnsSearch',
  'ExtraHosts',
  'GroupAdd',
  'IpcMode',
  'Links',
  'Memory',
  'MemorySwap',
  'MemoryReservation',
  'MemorySwappiness',
  'NanoCpus',
  'CpuShares',
  'CpuQuota',
  'CpuPeriod',
  'CpusetCpus',
  'CpusetMems',
  'PidsLimit',
  'RestartPolicy',
  'CapAdd',
  'CapDrop',
  'SecurityOpt',
  'ShmSize',
  'UTSMode',
  'UsernsMode',
  'PidMode',
  'Devices',
  'DeviceCgroupRules',
  'Init',
  'OomKillDisable',
  'OomScoreAdj',
  'Runtime',
  'Sysctls',
  'Tmpfs',
  'VolumesFrom',
  'CgroupnsMode',
])

function bindDestination(bind) {
  const parts = String(bind || '').split(':')
  return parts.length >= 2 ? parts[1] : ''
}

function replaceBindMount(binds, source, destination, removeDestinations = []) {
  const remove = new Set([destination, ...removeDestinations])
  const next = (binds || []).filter((bind) => !remove.has(bindDestination(bind)))
  next.push(`${source}:${destination}:ro`)
  return next
}

/** Build a replacement body from inspect data without changing VM-owned state. */
export function legacyServiceContainerBody(
  info,
  { name, sourceDir, destination = LIVE_BIN, removeDestinations = [], command, layout } = {},
) {
  const body = {}
  for (const key of MIGRATION_CONFIG_KEYS) {
    if (info?.Config && info.Config[key] !== undefined) body[key] = structuredClone(info.Config[key])
  }
  body.Image = info?.Config?.Image
  body.Labels = { ...(info?.Config?.Labels || {}) }
  if (layout) body.Labels['kin.vm.layout'] = SLOT_LAYOUT
  if (command) body.Cmd = command
  const host = info?.HostConfig || {}
  body.HostConfig = {}
  for (const key of MIGRATION_HOST_CONFIG_KEYS) {
    if (host[key] !== undefined) body.HostConfig[key] = structuredClone(host[key])
  }
  body.HostConfig.Binds = replaceBindMount(host.Binds, sourceDir, destination, removeDestinations)
  const networkMode = String(host.NetworkMode || '')
  const endpoint = info?.NetworkSettings?.Networks?.[networkMode]
  if (endpoint && networkMode && !['host', 'none', 'bridge', 'default'].includes(networkMode)) {
    body.NetworkingConfig = {
      EndpointsConfig: {
        [networkMode]: {
          ...(endpoint.IPAddress ? { IPAMConfig: { IPv4Address: endpoint.IPAddress } } : {}),
          ...(endpoint.Aliases ? { Aliases: endpoint.Aliases } : {}),
        },
      },
    }
  }
  return body
}

function migrationBackupName(name, stamp = Date.now()) {
  const suffix = `-legacy-${stamp}`
  return `${String(name).slice(0, Math.max(1, 63 - suffix.length))}${suffix}`
}

function hasBindDestination(info, destination, source = '') {
  return (info?.Mounts || []).some(
    (mount) => mount.Destination === destination && mount.RW === false && (!source || mount.Source === source),
  )
}

function hasLiveServiceMount(info, { sourceDir = '' } = {}) {
  return (info?.Mounts || []).some(
    (mount) =>
      LIVE_SERVICE_MOUNT_DESTINATIONS.includes(mount.Destination) &&
      mount.RW === false &&
      (!sourceDir || mount.Source === sourceDir),
  )
}

function isUserDefinedNetwork(name) {
  const value = String(name || '')
  return value && !['host', 'none', 'bridge', 'default'].includes(value) && !value.startsWith('container:')
}

function userDefinedNetworkNames(info) {
  const names = new Set()
  const mode = String(info?.HostConfig?.NetworkMode || '')
  if (isUserDefinedNetwork(mode)) names.add(mode)
  for (const net of Object.keys(info?.NetworkSettings?.Networks || {})) {
    if (isUserDefinedNetwork(net)) names.add(net)
  }
  return [...names]
}

function networkEndpointSnapshot(info) {
  const endpoints = {}
  for (const net of userDefinedNetworkNames(info)) {
    const ep = info?.NetworkSettings?.Networks?.[net]
    if (!ep) continue
    const endpoint = {}
    if (ep.IPAddress) endpoint.IPAMConfig = { IPv4Address: ep.IPAddress }
    if (ep.Aliases?.length) endpoint.Aliases = ep.Aliases
    if (Object.keys(endpoint).length) endpoints[net] = endpoint
  }
  return endpoints
}

export function needsLegacyServiceMigration(info, { sourceDir = '' } = {}) {
  return !!info && !hasLiveServiceMount(info, { sourceDir })
}

export async function migrateRemoteContainer(docker, name, body, { wasRunning, ops = {} } = {}) {
  const inspect = ops.inspect || inspectContainerOrNull
  const action = ops.action || containerAction
  const rename = ops.rename || renameContainer
  const create = ops.create || createContainerRaw
  const disconnect = ops.disconnect || disconnectContainerFromNetwork
  const connect = ops.connect || connectContainerToNetwork
  const existing = await inspect(docker, name)
  if (!existing) return { ok: true, action: 'absent', name }
  const backup = migrationBackupName(name)
  if (await inspect(docker, backup)) throw new Error(`legacy migration backup already exists: ${backup}`)
  const oldId = existing.Id
  const networks = userDefinedNetworkNames(existing)
  const endpoints = networkEndpointSnapshot(existing)
  if (wasRunning) await action(docker, name, 'stop', { t: 30 })
  await rename(docker, name, backup)
  for (const net of networks) {
    await disconnect(docker, net, oldId)
  }
  let createdId = null
  try {
    createdId = await create(docker, name, body)
    if (wasRunning) await action(docker, createdId, 'start')
    const next = await inspect(docker, name)
    if (!next || (wasRunning && !next.State?.Running) || (!wasRunning && next.State?.Running)) {
      throw new Error(`migrated container did not preserve state: ${name}`)
    }
    return { ok: true, action: 'migrated', name, old_id: oldId, new_id: next.Id, backup, was_running: wasRunning }
  } catch (error) {
    if (createdId) await rename(docker, createdId, migrationBackupName(`${name}-failed`)).catch(() => {})
    for (const [net, endpoint] of Object.entries(endpoints)) {
      await connect(docker, net, backup, endpoint).catch(() => {})
    }
    await rename(docker, backup, name).catch(() => {})
    if (wasRunning) await action(docker, name, 'start').catch(() => {})
    throw error
  }
}

/**
 * Layout 1 kept `.claude` inside the guest-writable home. Carry its credential into
 * the host-owned `claude/` mount once, unless the new location already has one.
 * Runs only after the container is removed, so the guest cannot race the checks;
 * a symlinked legacy `.claude` (pointing at a sibling slot) is skipped.
 */
async function migrateClaudeDir(session, vm, remoteDir) {
  const cred = 'cli-home/.claude/credentials.json'
  const dest = `${remoteDir}/${remoteSlotPath(cred)}`
  if (await readRemoteFileNoFollow(session.client, dest)) return
  const legacy = `${remoteDir}/cli-home/.claude`
  const isRealDir = await runRemote(session.client, `[ -d ${shellQuote(legacy)} ] && [ ! -L ${shellQuote(legacy)} ]`)
    .then(() => true)
    .catch(() => false)
  if (!isRealDir) return
  const old = await readRemoteFileNoFollow(session.client, `${remoteDir}/${cred}`).catch(() => null)
  if (!old?.length) return
  const owner = session.host.uid === 0 ? remoteSlotOwner(session.host, vm) : null
  await writeRemoteFile(await openSftp(session.client), dest, old, { mode: 0o600, owner })
}

/** iptables plan → one shell script; mirrors egress.mjs applyIptables (-N tolerant, -C guards the next row). */
export function remoteIptablesScript(plan, { sudo = false } = {}) {
  const ipt = `${sudo ? 'sudo -n ' : ''}iptables`
  const line = (args) => `${ipt} ${args.map(shellQuote).join(' ')}`
  const out = ['set -e']
  for (let i = 0; i < plan.add.length; i++) {
    const args = plan.add[i]
    if (args.includes('-N')) {
      out.push(`${line(args)} 2>/dev/null || true`)
      continue
    }
    if (args.includes('-C')) {
      out.push(`${line(args)} 2>/dev/null || ${line(plan.add[i + 1])}`)
      i += 1
      continue
    }
    out.push(line(args))
  }
  return out.join('\n')
}

async function ensureRemoteNetwork(docker, { name, bridge, masquerade, labels = {} }) {
  let info = await inspectNetworkOrNull(docker, name)
  if (!info) {
    await createNetwork(docker, {
      Name: name,
      Driver: 'bridge',
      EnableIPv6: false,
      Labels: labels,
      Options: {
        'com.docker.network.bridge.name': bridge,
        'com.docker.network.bridge.enable_ip_masquerade': masquerade ? 'true' : 'false',
        'com.docker.network.bridge.enable_icc': 'false',
      },
    })
    info = await inspectNetworkOrNull(docker, name)
  }
  const subnet = info?.IPAM?.Config?.[0]?.Subnet || ''
  if (!subnet) throw Object.assign(new Error(`egress network ${name} has no subnet`), { code: 'egress_network_failed' })
  const gateway = info.IPAM.Config[0].Gateway || gatewayFromSubnet(subnet)
  return { name, subnet, gateway, bridge }
}

/**
 * A node SOCKS exit belongs to one slot and is named after its container, so the
 * node's Docker list reads as pairs: kin-02 / kin-02-egress on kin-02-net. Bridge
 * and chain carry a hash (iface names cap at 15 chars; long VM ids must not collide).
 */
export function slotEgressNames(vmId) {
  const slot = containerName(vmId)
  const tag = crypto.createHash('sha1').update(String(vmId)).digest('hex').slice(0, 10)
  return {
    slot,
    network: `${slot}-net`,
    egress: `${slot}-egress`,
    bridge: `keg${tag}`,
    chain: `KEG${tag}`,
    ports: portsForProxy(vmId),
  }
}

/**
 * kin-egress container body. The helper reads a 0600 config written by the SSH
 * user, so it runs as that same uid:gid; with a root login the image default
 * (kincli) could not open the root-owned file and crash-looped on EACCES. The
 * user is part of the digest so a helper created under the old spec is rebuilt.
 */
export function remoteEgressContainer({ vmId, proxyId, dir, imageRef, body, host, binaryDigest = '' }) {
  const user = `${host.uid}:${host.gid}`
  const digest = crypto
    .createHash('sha256')
    .update(body)
    .update(imageRef)
    .update(user)
    .update(binaryDigest)
    .digest('hex')
    .slice(0, 16)
  return {
    digest,
    spec: {
      Image: imageRef,
      User: user,
      Cmd: [`${LIVE_BIN}/kin-egress`, '-config', '/etc/kin-egress/egress.json'],
      Labels: {
        'kin.egress': '1',
        'kin.egress.vm': vmId,
        'kin.egress.proxy': proxyId,
        'kin.egress.cfg': digest,
        'vm2api.cluster': '1',
      },
      HostConfig: {
        NetworkMode: 'host',
        Binds: [`${dir}:/etc/kin-egress:ro`, `${path.posix.join(dir, '..', 'slot-bin')}:${LIVE_BIN}:ro`],
        RestartPolicy: { Name: 'unless-stopped' },
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
      },
    },
  }
}

/** Keep the running helper only when it is healthy and matches the spec. A crash loop reports Running too. */
export function canReuseRemoteEgress(existing, digest) {
  return !!(
    existing?.State?.Running &&
    !existing.State.Restarting &&
    existing.Config?.Labels?.['kin.egress.cfg'] === digest
  )
}

/**
 * Build the VM's exit on the node. px-local = shared masquerading bridge (node's
 * own IP, no process). SOCKS = the slot's own non-masquerading bridge + its
 * kin-egress (host-network container from the slot image) + iptables REDIRECT,
 * exactly like egress.mjs does on the control plane.
 */
export async function ensureRemoteEgress(session, vm, { imageRef, binaryDigest = '' }) {
  const proxy = vm.proxy
  const blocked = proxyBlockedReason(proxy)
  if (blocked) return { ok: false, code: blocked, error: blocked }
  if (isLocalEgressProxy(proxy)) {
    const id = proxy?.id || LOCAL_EGRESS_ID
    const net = await ensureRemoteNetwork(session.docker, {
      name: networkName(id),
      bridge: bridgeName(id),
      masquerade: true,
    })
    return { ok: true, mode: 'local', network: net.name, egress: null }
  }
  const proxyId = proxy?.id
  const proxyUrl = boundProxyUrl(proxy)
  if (!proxyId || !proxyUrl) {
    return { ok: false, code: 'proxy_required', error: 'bound SOCKS5 id and url required; refusing fallback' }
  }
  if (session.host.uid !== 0 && !session.host.sudo) {
    return { ok: false, code: 'egress_sudo_required', error: '节点需要 root 或免密 sudo 才能为 SOCKS5 出口写 iptables' }
  }
  const names = slotEgressNames(vm.id)
  // Keep the helper's executable on the persistent mount even when egress is
  // enabled independently of a slot start/update.
  const slotBin = shellQuote(`${remoteSlotDir(session.host, vm.id)}/slot-bin`)
  await runRemote(session.client, `umask 077 && mkdir -p ${slotBin} && chmod 755 ${slotBin}`)
  const net = await ensureRemoteNetwork(session.docker, {
    name: names.network,
    bridge: names.bridge,
    masquerade: false,
    labels: { 'kin.egress.vm': vm.id },
  })
  const cfg = {
    proxy_id: proxyId,
    proxy_url: proxyUrl,
    listen_tcp: `${net.gateway}:${names.ports.tcp}`,
    listen_dns: `${net.gateway}:${names.ports.dns}`,
  }
  const dnsUpstream = configuredDnsUpstream()
  if (dnsUpstream) cfg.dns_upstream = dnsUpstream
  const dnsEmptyTypes = configuredDnsEmptyTypes()
  if (dnsEmptyTypes.length) cfg.dns_empty_types = dnsEmptyTypes
  const body = `${JSON.stringify(cfg, null, 2)}\n`
  // Beside the slot tree, outside every guest bind: the guest never sees the proxy password.
  const dir = `${remoteSlotDir(session.host, vm.id)}/egress`
  const { digest, spec } = remoteEgressContainer({
    vmId: vm.id,
    proxyId,
    dir,
    imageRef,
    body,
    host: session.host,
    binaryDigest,
  })
  const existing = await inspectContainerOrNull(session.docker, names.egress)
  if (!canReuseRemoteEgress(existing, digest)) {
    await runRemote(session.client, `umask 077 && mkdir -p ${shellQuote(dir)} && chmod 700 ${shellQuote(dir)}`)
    await writeRemoteFile(await openSftp(session.client), `${dir}/egress.json`, body, { mode: 0o600 })
    if (existing) await removeContainer(session.docker, names.egress)
    await createContainerRaw(session.docker, names.egress, spec)
    await containerAction(session.docker, names.egress, 'start')
  }
  // Passive: a TCP connect would enter kin-egress's transparent path (it refuses self-destined conns).
  const tcp = names.ports.tcp
  const probe = `for i in $(seq 1 40); do ss -H -ltn 'sport = :${tcp}' | awk '{print $4}' | grep -qxF -e '${net.gateway}:${tcp}' -e '0.0.0.0:${tcp}' -e '*:${tcp}' && exit 0; sleep 0.2; done; exit 1`
  await runRemote(session.client, `bash -c ${shellQuote(probe)}`, { timeoutMs: 20_000, code: 'egress_not_listening' })
  const plan = iptablesPlan({
    chain: names.chain,
    bridge: net.bridge,
    subnet: net.subnet,
    tcpPort: tcp,
    dnsPort: names.ports.dns,
  })
  await runRemote(session.client, remoteIptablesScript(plan, { sudo: session.host.uid !== 0 }), {
    code: 'egress_iptables_failed',
  })
  return { ok: true, mode: 'socks', network: net.name, egress: names.egress }
}
/** Policy changes stop only the exit helper, preserving slot containers and bindings. */
export async function setRemoteProxyEgressEnabled(vm, projectRoot, enabled) {
  try {
    const session = await nodeSession(vmNodeId(vm))
    const current = vm.runtime?.egress_container || slotEgressNames(vm.id).egress
    const legacy = `kin-egress-${proxyKey(vm.proxy?.id)}`
    if (enabled) {
      const blocked = proxyBlockedReason(vm.proxy)
      if (blocked) return { ok: false, code: blocked, error: blocked }
      const name = vm.runtime?.network === networkName(vm.proxy?.id) ? legacy : current
      const existing = await inspectContainerOrNull(session.docker, name)
      if (existing) {
        if (!existing.State?.Running) await containerAction(session.docker, name, 'start')
        return { ok: true }
      }
      const image = slotImageSpec(projectRoot, vm.kernel || 'ubuntu-24.04')
      const binaries = await pushSlotBinaries(vm, projectRoot, session)
      return ensureRemoteEgress(session, vm, { imageRef: image.ref, binaryDigest: binaries.digest })
    }
    for (const name of new Set([current, legacy])) {
      const existing = await inspectContainerOrNull(session.docker, name)
      if (existing?.State?.Running) await containerAction(session.docker, name, 'stop')
    }
    return { ok: true }
  } catch (err) {
    return failure(err)
  }
}

/** Where a network's exit lives: per-slot (labelled), pre-1.3.88 per-proxy, or the shared px-local bridge. */
function exitOf(name, info, host) {
  const vmId = info.Labels?.['kin.egress.vm']
  if (vmId) {
    const n = slotEgressNames(vmId)
    return {
      egress: n.egress,
      chain: n.chain,
      bridge: n.bridge,
      ports: n.ports,
      dir: `${remoteSlotDir(host, vmId)}/egress`,
    }
  }
  const proxyId = name.slice('kin-eg-'.length)
  if (isLocalEgressProxy({ id: proxyId })) return { egress: null }
  const key = proxyKey(proxyId)
  return {
    egress: `kin-egress-${key}`,
    chain: chainName(proxyId),
    bridge: bridgeName(proxyId),
    ports: portsForProxy(proxyId),
    dir: `${host.root}/egress/${key}`,
  }
}

/**
 * Remote twin of stopProxyEgress, run when a slot leaves an exit network. The
 * network's own container list is the node-local truth: only an empty network
 * loses its kin-egress, iptables rows, bridge and config.
 */
export async function releaseRemoteEgress(session, networkMode) {
  const name = String(networkMode || '')
  const info = name ? await inspectNetworkOrNull(session.docker, name) : null
  if (!info) return { released: false }
  const owned = !!info.Labels?.['kin.egress.vm'] || name.startsWith('kin-eg-')
  if (!owned) return { released: false }
  if (Object.keys(info.Containers || {}).length) return { released: false, reason: 'in_use' }
  const exit = exitOf(name, info, session.host)
  if (exit.egress && (await inspectContainerOrNull(session.docker, exit.egress))) {
    await removeContainer(session.docker, exit.egress)
  }
  const subnet = info.IPAM?.Config?.[0]?.Subnet
  if (exit.egress && subnet) {
    const plan = iptablesPlan({
      chain: exit.chain,
      bridge: exit.bridge,
      subnet,
      tcpPort: exit.ports.tcp,
      dnsPort: exit.ports.dns,
    })
    const ipt = `${session.host.uid !== 0 ? 'sudo -n ' : ''}iptables`
    // Each row may already be gone; deletion keeps going like the local removeIptables.
    const script = plan.del.map((args) => `${ipt} ${args.map(shellQuote).join(' ')} 2>/dev/null || true`).join('\n')
    await runRemote(session.client, script, { code: 'egress_iptables_failed' })
  }
  await removeNetwork(session.docker, name)
  if (exit.dir) await runRemote(session.client, `rm -rf ${shellQuote(exit.dir)}`)
  return { released: true, network: name }
}

const KVM_MEMORY_OVERHEAD = 512 * 1024 * 1024

async function probeRemoteAccel(session, routing) {
  const allowTcg = normalizeVmConfig(routing?.vm).allow_tcg === true
  try {
    await runRemote(session.client, 'test -c /dev/kvm && test -r /dev/kvm && test -w /dev/kvm', { timeoutMs: 8_000 })
    return { ok: true, accel: 'kvm' }
  } catch {
    if (allowTcg) return { ok: true, accel: 'tcg' }
    return { ok: false, error: '节点没有 /dev/kvm，且未允许 TCG' }
  }
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

function kvmSlotContainerBody(vm, { image, network, remoteDir, routing, accel, slotUser }) {
  const slotName = displayName(vm.id)
  const memStr = slotMemory(vm, routing)
  const mem = parseMemoryBytes(memStr) + KVM_MEMORY_OVERHEAD
  const [uid, gid] = String(slotUser || '0:0').split(':')
  const m = kvmMachineFields(vm)
  const s = m.smbios
  const hostName = String(vm.fingerprint?.hostname || '').trim() || slotName
  const machineId = String(vm.fingerprint?.guest_machine_id || vm.fingerprint?.machine_id || '').trim()
  const body = {
    Image: image,
    Hostname: hostName,
    User: '0',
    Env: [
      `KIN_VM_ID=${vm.id}`,
      `KIN_VM_NAME=${slotName}`,
      `KIN_VM_OS=${vm.kernel}`,
      `TZ=${vm.timezone}`,
      `LANG=${vm.locale}`,
      `KIN_KVM_UID=${uid}`,
      `KIN_KVM_GID=${gid}`,
      `KIN_KVM_MEMORY_MB=${memoryMiB(memStr)}`,
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
      'KIN_KVM_SHARES=home,run,claude',
    ],
    Labels: {
      'kin.vm': '1',
      'kin.vm.id': vm.id,
      'kin.vm.name': slotName,
      'kin.vm.os': vm.kernel,
      'kin.vm.layout': SLOT_LAYOUT,
      'kin.vm.runtime': 'kvm',
      'vm2api.cluster': '1',
    },
    HostConfig: {
      Binds: [
        `${remoteDir}/cli-home:/slot/home`,
        `${remoteDir}/claude:/slot/claude`,
        `${remoteDir}/run:/slot/run`,
        `${remoteDir}/kvm:/slot/kvm`,
        `${remoteDir}/slot-bin:/opt/kin-guest/opt/kin-live:ro`,
      ],
      NetworkMode: network,
      RestartPolicy: { Name: 'unless-stopped' },
      StopTimeout: 30,
      Memory: mem,
      MemorySwap: mem,
      PidsLimit: 256,
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
      CapAdd: KVM_CAPS,
      Dns: ['8.8.8.8'],
      DnsOptions: ['use-vc'],
    },
  }
  if (accel === 'kvm') {
    body.HostConfig.Devices = [{ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' }]
  }
  return body
}

export function slotContainerBody(vm, { image, network, remoteDir, user, routing, accel }) {
  if (isKvmRuntime(vm)) return kvmSlotContainerBody(vm, { image, network, remoteDir, routing, accel, slotUser: user })
  const slotName = displayName(vm.id)
  const mem = parseMemoryBytes(slotMemory(vm, routing))
  const cpus = slotDockerCpus(vm)
  const codex = isCodexVm(vm)
  return {
    Image: image,
    Hostname: String(vm.fingerprint?.hostname || '').trim() || slotName,
    User: user,
    WorkingDir: '/home/kincli',
    Env: [
      'HOME=/home/kincli',
      'CLAUDE_CONFIG_DIR=/home/kincli/.claude',
      `TZ=${vm.timezone}`,
      `LANG=${vm.locale}`,
      `KIN_VM_ID=${vm.id}`,
      `KIN_VM_NAME=${slotName}`,
      `KIN_VM_OS=${vm.kernel}`,
    ],
    // Node images bake the Claude kernel here; local slots bind-mount a different path.
    Cmd: codex ? ['sleep', 'infinity'] : [REMOTE_KERNEL_ENTRY, '--gateway-worker', '--config', '/run/kin/kernel.json'],
    Labels: {
      'kin.vm': '1',
      'kin.vm.id': vm.id,
      'kin.vm.name': slotName,
      'kin.vm.os': vm.kernel,
      'kin.vm.layout': SLOT_LAYOUT,
      'kin.vm.runtime': 'docker',
      ...(codex ? { 'kin.vm.role': CODEX_SLOT_ROLE } : {}),
      'vm2api.cluster': '1',
    },
    HostConfig: {
      Binds: [
        `${remoteDir}/cli-home:/home/kincli`,
        // Nested mount: the guest cannot replace ~/.claude with a symlink the host would follow.
        `${remoteDir}/claude:/home/kincli/.claude`,
        `${remoteDir}/run:/run/kin`,
        `${remoteDir}/machine-id:/etc/machine-id:ro`,
        `${remoteDir}/machine-id:/var/lib/dbus/machine-id:ro`,
        `${remoteDir}/slot-bin:${LIVE_BIN}:ro`,
      ],
      NetworkMode: network,
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: mem,
      // Equal swap allowance lets idle CLI pages leave RAM on small nodes
      // (MemorySwap == Memory would forbid swap entirely).
      MemorySwap: mem * 2,
      ...(cpus > 0 ? { NanoCpus: Math.round(cpus * 1e9) } : {}),
      PidsLimit: 256,
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' },
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
      Dns: ['8.8.8.8'],
      DnsOptions: ['use-vc'],
    },
  }
}

function applyRuntime(
  vm,
  { nodeId, name, info, image, network, user, relays, slotDir, egress, egressContainer, routing, accel },
) {
  vm.runtime = {
    ...(vm.runtime || {}),
    type: runtimeKind(vm),
    node_id: nodeId,
    container: name,
    container_id: info?.Id || vm.runtime?.container_id || null,
    pid: null,
    ip: null,
    network,
    network_mode: network,
    started_at: info?.State?.StartedAt || null,
    image,
    hostname: info?.Config?.Hostname || null,
    os: (OS_CATALOG[vm.kernel] || {}).pretty || vm.kernel,
    memory: slotMemory(vm, routing),
    user,
    worker: 'rust',
    worker_socket: relays.worker,
    kernel_socket: relays.kernel,
    worker_run_dir: path.join(slotDir, 'run'),
    worker_token_file: path.join(slotDir, 'run', 'internal.token'),
    egress,
    egress_container: egressContainer || null,
    stopped: false,
    ...(accel ? { accel } : {}),
  }
}

async function ensureNodeSlotImage(session, nodeId, projectRoot, kernel, runtime) {
  const spec = slotImageSpec(projectRoot, kernel, { runtime })
  if (await imagePresent(session.docker, spec.ref)) return spec
  const job = await awaitSlotImageBuild(startSlotImageBuild(nodeId, kernel, { runtime }))
  if (job.status !== 'done' || !(await imagePresent(session.docker, spec.ref))) {
    return {
      fail: {
        ok: false,
        code: 'slot_image_build_failed',
        error: `节点 ${nodeId} 构建槽位镜像 ${spec.ref} 失败：${String(job.log || '')
          .trim()
          .split('\n')
          .pop()}`,
      },
    }
  }
  return spec
}

/**
 * Current control-plane payload (kernel, cli-node, cc-node, kin-worker telemetry)
 * as a slot image on this node. Same bytes local slots bind-mount; a node only
 * sees them after the content-hashed image exists and the container is recreated.
 */
export async function refreshNodeSlotPayload(
  vm,
  projectRoot,
  { routing, recreate = true, startFn = startRemoteSlot } = {},
) {
  const id = vm?.id
  const nodeId = vmNodeId(vm)
  if (!id || !nodeId) return { id, ok: false, code: 'not_cluster_slot', error: '不是集群槽' }
  const kernel = vm.kernel && OS_CATALOG[vm.kernel] ? vm.kernel : 'ubuntu-24.04'
  const kind = runtimeKind(vm)
  try {
    const session = await nodeSession(nodeId)
    const spec = await ensureNodeSlotImage(session, nodeId, projectRoot, kernel, kind)
    if (spec.fail) return { id, node_id: nodeId, ...spec.fail }
    if (kind === 'kvm') {
      const dockerSpec = await ensureNodeSlotImage(session, nodeId, projectRoot, kernel, 'docker')
      if (dockerSpec.fail) return { id, node_id: nodeId, ...dockerSpec.fail }
    }
    const running = recreate !== false && vm.status === 'running'
    if (!running) {
      return {
        id,
        node_id: nodeId,
        ok: true,
        image: spec.ref,
        kernel_changed: true,
        restarted: false,
        kernel: { ok: true, skipped: true, reason: 'vm_stopped' },
      }
    }
    const boot = await startFn(vm, projectRoot, { recreate: true, routing })
    if (!boot?.ok) {
      return {
        id,
        node_id: nodeId,
        ok: false,
        code: boot?.code || 'slot_payload_refresh_failed',
        error: boot?.error || '集群槽换镜像失败',
        image: spec.ref,
      }
    }
    return {
      id,
      node_id: nodeId,
      ok: true,
      image: spec.ref,
      kernel_changed: true,
      restarted: true,
      kernel: { ok: true, action: boot.action || 'recreated' },
    }
  } catch (err) {
    return {
      id,
      node_id: nodeId,
      ok: false,
      code: err?.code || 'slot_payload_refresh_failed',
      error: String(err?.message || err).slice(0, 300),
    }
  }
}

/** One image build per node+kernel+runtime, then recreate each slot onto it. */
export async function refreshClusterSlotPayloads(
  projectRoot,
  vms,
  { routing, recreate = true, refreshFn = refreshNodeSlotPayload } = {},
) {
  const groups = new Map()
  const items = []
  for (const vm of vms || []) {
    // Codex inference is the host Codex kernel. The slot has no cli-node or Go telemetry.
    if (isCodexVm(vm)) continue
    if (resolveKernelDataplane(vm, routing || {}) === 'crag' || vm?.dataplane === 'crag') {
      items.push({
        id: vm.id,
        ok: false,
        code: 'remote_unsupported',
        error: 'crag 数据面暂不支持集群节点',
        kernel_changed: false,
      })
      continue
    }
    const nodeId = vmNodeId(vm)
    const kernel = vm.kernel && OS_CATALOG[vm.kernel] ? vm.kernel : 'ubuntu-24.04'
    const kind = runtimeKind(vm)
    const key = `${nodeId}\0${kernel}\0${kind}`
    const group = groups.get(key) || []
    group.push(vm)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    for (const vm of group) items.push(await refreshFn(vm, projectRoot, { routing, recreate }))
  }
  const failed = items.filter((item) => !item.ok)
  const changed = items.filter((item) => item.kernel_changed === true)
  return {
    ok: failed.length === 0,
    changed: changed.length > 0,
    total: items.length,
    ok_count: items.length - failed.length,
    failed_count: failed.length,
    changed_count: changed.length,
    items,
  }
}

async function prepare(vm, projectRoot, routing) {
  if (resolveKernelDataplane(vm, routing || {}) === 'crag') {
    return { fail: { ok: false, code: 'remote_unsupported', error: 'crag 数据面暂不支持集群节点' } }
  }
  vm.kernel = vm.kernel && OS_CATALOG[vm.kernel] ? vm.kernel : 'ubuntu-24.04'
  vm.timezone = normalizeTimezone(vm.timezone)
  vm.locale = vm.locale || STANDARD_LOCALE
  const nodeId = vmNodeId(vm)
  const session = await nodeSession(nodeId)
  const kind = runtimeKind(vm)
  const spec = await ensureNodeSlotImage(session, nodeId, projectRoot, vm.kernel, kind)
  if (spec.fail) return spec
  // Egress helper runs kin-egress at /usr/local/bin; kvm images bake payload under /opt/kin-guest.
  let egressImage = spec.ref
  if (kind === 'kvm') {
    const dockerSpec = await ensureNodeSlotImage(session, nodeId, projectRoot, vm.kernel, 'docker')
    if (dockerSpec.fail) return dockerSpec
    egressImage = dockerSpec.ref
  }
  const owner = remoteSlotOwner(session.host, vm)
  return {
    nodeId,
    session,
    image: spec.ref,
    egressImage,
    user: `${owner.uid}:${owner.gid}`,
    remoteDir: remoteSlotDir(session.host, vm.id),
    slotDir: path.join(projectRoot, 'vms', vm.id),
  }
}

function runtimeLabelOf(info) {
  return info?.Config?.Labels?.['kin.vm.runtime'] || 'docker'
}
function roleLabelOf(info) {
  return info?.Config?.Labels?.['kin.vm.role'] || ''
}

/**
 * Docker GPT slots idle as PID 1. One still running kin-kernel crash-loops and
 * must be recreated. KVM has no such label: its runner boots the guest, and the
 * Codex kernel stays on the control plane, so requiring the role would remove
 * a freshly built VM on every start.
 */
export function codexRoleMatches(info, vm) {
  if (isKvmRuntime(vm) || runtimeLabelOf(info) === 'kvm') return true
  const role = roleLabelOf(info)
  return isCodexVm(vm) ? role === CODEX_SLOT_ROLE : role !== CODEX_SLOT_ROLE
}

async function startRemoteTelemetry(docker, vm, name) {
  const target = { ...vm, runtime: { ...(vm.runtime || {}), container: name, type: runtimeKind(vm) } }
  const worker = isKvmRuntime(vm) ? '/opt/kin-payload/opt/kin-live/kin-worker' : REMOTE_WORKER_BIN
  const { Cmd, User } = slotExecCmd(target, [worker, 'telemetry', '--config', '/run/kin/worker.json'], {
    detach: true,
  })
  await execDetached(docker, name, Cmd, { user: User }).catch(() => {})
}

async function chownRemoteKvmBinds(session, name, vm) {
  if (!isKvmRuntime(vm)) return
  await runRemote(session.client, kvmBindChownArgv(name, vm).map(shellQuote).join(' '), { timeoutMs: 15_000 })
}

/** Remote twin of startVmRuntime. Running + same image/network is left alone (Node restart must not bounce slots). */
export async function startRemoteSlot(vm, projectRoot, { recreate = false, routing } = {}) {
  try {
    if (!isKvmRuntime(vm)) slotDockerCpus(vm)
    const p = await prepare(vm, projectRoot, routing)
    if (p.fail) return p.fail
    const { nodeId, session, image, egressImage, user, remoteDir, slotDir } = p
    const kvm = isKvmRuntime(vm)
    let accel = vm.runtime?.accel
    if (kvm && accel !== 'kvm' && accel !== 'tcg') {
      const probe = await probeRemoteAccel(session, routing)
      if (!probe.ok) return { ok: false, code: 'kvm_unavailable', error: probe.error }
      accel = probe.accel
    }
    const binaries =
      typeof pushSlotBinaries === 'function' ? await pushSlotBinaries(vm, projectRoot, session) : { digest: '' }
    const eg = await ensureRemoteEgress(session, vm, { imageRef: egressImage || image, binaryDigest: binaries.digest })
    if (!eg.ok) return eg
    const name = containerName(vm.id)
    const relays = await clusterManager().ensureSlotRelays(nodeId, vm.id)
    let existing = await inspectContainerOrNull(session.docker, name)
    const matches =
      existing &&
      existing.Config?.Image === image &&
      existing.HostConfig?.NetworkMode === eg.network &&
      existing.Config?.Labels?.['kin.vm.layout'] === SLOT_LAYOUT &&
      runtimeLabelOf(existing) === runtimeKind(vm) &&
      codexRoleMatches(existing, vm) &&
      // Running stays true during Docker restart-policy backoff. Recreate the
      // loop just like the local runtime; otherwise watchdog revival is a no-op.
      !existing.State?.Restarting &&
      !recreate
    const common = {
      nodeId,
      name,
      image,
      network: eg.network,
      user,
      relays,
      slotDir,
      egress: eg.mode,
      egressContainer: eg.egress,
      routing,
      accel,
    }
    if (matches && existing.State?.Running) {
      await reconcileSlotCredentials(vm, slotDir, session)
      applyRuntime(vm, { ...common, info: existing })
      return { ok: true, action: 'already-running', runtime: vm.runtime }
    }
    let previousNetwork = null
    if (existing && !matches) {
      previousNetwork = existing.HostConfig?.NetworkMode
      await removeContainer(session.docker, name)
      existing = null
    }
    writeWorkerFiles(vm, projectRoot, { transparent: true, routing })
    ensureGuestMachineIdFile(projectRoot, vm)
    await pushSlotFiles(vm, slotDir, ['run', 'seed'], session)
    if (!existing) await migrateClaudeDir(session, vm, remoteDir)
    if (kvm) {
      await runRemote(
        session.client,
        `umask 077 && mkdir -p ${shellQuote(`${remoteDir}/kvm`)} && chmod 700 ${shellQuote(`${remoteDir}/kvm`)}`,
      )
    }
    await reconcileSlotCredentials(vm, slotDir, session)
    if (previousNetwork && previousNetwork !== eg.network) await releaseRemoteEgress(session, previousNetwork)
    let action = 'started'
    if (!existing) {
      await createContainerRaw(
        session.docker,
        name,
        slotContainerBody(vm, { image, network: eg.network, remoteDir, user, routing, accel }),
      )
      action = 'created'
    }
    await containerAction(session.docker, name, 'start')
    await chownRemoteKvmBinds(session, name, vm)
    await startRemoteTelemetry(session.docker, vm, name)
    applyRuntime(vm, { ...common, info: await inspectContainerOrNull(session.docker, name) })
    return { ok: true, action, runtime: vm.runtime }
  } catch (err) {
    return failure(err)
  }
}

/** Remote twin of reloadSlotWorker: rewrite + push config, bounce the container, never remove it unless the exit moved. */
export async function reloadRemoteSlot(vm, projectRoot, { routing } = {}) {
  try {
    if (!isKvmRuntime(vm)) slotDockerCpus(vm)
    const p = await prepare(vm, projectRoot, routing)
    if (p.fail) return p.fail
    const { nodeId, session, image, user, remoteDir, slotDir } = p
    const binaries =
      typeof pushSlotBinaries === 'function' ? await pushSlotBinaries(vm, projectRoot, session) : { digest: '' }
    const eg = await ensureRemoteEgress(session, vm, {
      imageRef: p.egressImage || image,
      binaryDigest: binaries.digest,
    })
    if (!eg.ok) return eg
    const name = containerName(vm.id)
    const existing = await inspectContainerOrNull(session.docker, name)
    if (
      !existing ||
      existing.Config?.Image !== image ||
      existing.HostConfig?.NetworkMode !== eg.network ||
      existing.Config?.Labels?.['kin.vm.layout'] !== SLOT_LAYOUT ||
      runtimeLabelOf(existing) !== runtimeKind(vm) ||
      !codexRoleMatches(existing, vm)
    ) {
      return startRemoteSlot(vm, projectRoot, { recreate: !!existing, routing })
    }
    const relays = await clusterManager().ensureSlotRelays(nodeId, vm.id)
    writeWorkerFiles(vm, projectRoot, { transparent: true, routing })
    await pushSlotFiles(vm, slotDir, ['run', 'seed'], session)
    await reconcileSlotCredentials(vm, slotDir, session)
    const running = !!existing.State?.Running
    if (isKvmRuntime(vm) && running) {
      await chownRemoteKvmBinds(session, name, vm)
      const argv = slotExecArgv(
        { ...vm, runtime: { ...(vm.runtime || {}), container: name, type: 'kvm' } },
        ['systemctl', 'restart', 'kin-kernel.service'],
        { user: '0' },
      )
      await runRemote(session.client, ['docker', ...argv].map(shellQuote).join(' '), { timeoutMs: 60_000 })
    } else {
      await containerAction(session.docker, name, running ? 'restart' : 'start')
      await chownRemoteKvmBinds(session, name, vm)
    }
    await startRemoteTelemetry(session.docker, vm, name)
    applyRuntime(vm, {
      nodeId,
      name,
      image,
      network: eg.network,
      user,
      relays,
      slotDir,
      egress: eg.mode,
      egressContainer: eg.egress,
      routing,
      accel: vm.runtime?.accel,
      info: await inspectContainerOrNull(session.docker, name),
    })
    return { ok: true, action: running ? 'reloaded' : 'started', runtime: vm.runtime }
  } catch (err) {
    return failure(err)
  }
}

/** Update a node slot's Go services without recreating its VM/container. */
export async function migrateRemoteServiceContainers(vm, projectRoot) {
  try {
    const session = await nodeSession(vmNodeId(vm))
    const remoteDir = remoteSlotDir(session.host, vm.id)
    const slotBin = `${remoteDir}/slot-bin`
    const binaries = await pushSlotBinaries(vm, projectRoot, session)
    const migrated = []
    const slotName = vm.runtime?.container || containerName(vm.id)
    const slot = await inspectContainerOrNull(session.docker, slotName)
    if (needsLegacyServiceMigration(slot, { sourceDir: slotBin })) {
      const body = legacyServiceContainerBody(slot, {
        name: slotName,
        sourceDir: slotBin,
        removeDestinations: ['/usr/local/bin/kin-worker'],
        layout: true,
      })
      migrated.push(
        await migrateRemoteContainer(session.docker, slotName, body, {
          wasRunning: !!slot.State?.Running,
        }),
      )
    }
    const egressName = slotEgressNames(vm.id).egress
    const egress = await inspectContainerOrNull(session.docker, egressName)
    if (needsLegacyServiceMigration(egress, { sourceDir: slotBin })) {
      const body = legacyServiceContainerBody(egress, {
        name: egressName,
        sourceDir: slotBin,
        removeDestinations: ['/usr/local/bin/kin-egress'],
        command: [`${LIVE_BIN}/kin-egress`, '-config', '/etc/kin-egress/egress.json'],
      })
      migrated.push(
        await migrateRemoteContainer(session.docker, egressName, body, {
          wasRunning: !!egress.State?.Running,
        }),
      )
    }
    return {
      ok: true,
      action: migrated.length ? 'migrated' : 'unchanged',
      migrated,
      binary_digest: binaries.digest || null,
    }
  } catch (err) {
    return failure(err, 'legacy_service_migration_failed')
  }
}

export async function restartRemoteServices(vm, projectRoot, { telemetryEnabled } = {}) {
  try {
    const session = await nodeSession(vmNodeId(vm))
    const remoteDir = remoteSlotDir(session.host, vm.id)
    const slotDir = path.join(projectRoot, 'vms', vm.id)
    const name = vm.runtime?.container || containerName(vm.id)
    const migration = await migrateRemoteServiceContainers(vm, projectRoot)
    if (!migration.ok) return migration
    await pushSlotFiles(vm, slotDir, ['run', 'seed'], session)
    const target = { ...vm, runtime: { ...(vm.runtime || {}), container: name, type: runtimeKind(vm) } }
    const stop = 'pkill -TERM -x kin-worker 2>/dev/null || true'
    await execDetached(session.docker, name, slotExecCmd(target, ['sh', '-c', stop]).Cmd, {
      user: slotExecCmd(target, ['sh', '-c', stop]).User,
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (telemetryEnabled === true) await startRemoteTelemetry(session.docker, vm, name)
    const image = slotImageSpec(projectRoot, vm.kernel || 'ubuntu-24.04')
    const egress = await ensureRemoteEgress(session, vm, {
      imageRef: image.ref,
      binaryDigest: migration.binary_digest,
    })
    if (!egress.ok) return { ok: false, error: egress.error, code: egress.code || 'egress_update_failed' }
    return {
      ok: true,
      action: telemetryEnabled === true ? 'restarted' : 'stopped',
      remote_dir: remoteDir,
      binary_digest: migration.binary_digest,
      migration: migration.migrated,
    }
  } catch (err) {
    return failure(err, 'service_update_failed')
  }
}

export async function stopRemoteSlot(vm) {
  try {
    const session = await nodeSession(vmNodeId(vm))
    const name = containerName(vm.id)
    const info = await inspectContainerOrNull(session.docker, name)
    if (!info) {
      if (vm.runtime) vm.runtime = { ...vm.runtime, pid: null, ip: null, stopped: true }
      return { ok: true, action: 'absent', runtime: vm.runtime || null }
    }
    const t = isKvmRuntime(vm) || runtimeLabelOf(info) === 'kvm' ? 30 : undefined
    await containerAction(session.docker, name, 'stop', { t })
    vm.runtime = { ...(vm.runtime || {}), pid: null, stopped: true }
    return { ok: true, action: 'stopped', runtime: vm.runtime }
  } catch (err) {
    return failure(err)
  }
}

/** Explicit delete / factory reset: container, node-side slot tree and local relays. */
export async function destroyRemoteSlot(vm) {
  try {
    const session = await nodeSession(vmNodeId(vm))
    const name = containerName(vm.id)
    const info = await inspectContainerOrNull(session.docker, name)
    if (info) {
      await removeContainer(session.docker, name)
      await releaseRemoteEgress(session, info.HostConfig?.NetworkMode)
    }
    await removeRemoteSlotDir(vm, session)
    await clusterManager().dropSlotRelays(vm.id)
    if (vm.runtime) vm.runtime = { ...vm.runtime, pid: null, ip: null, stopped: true, removed: true }
    return { ok: true, action: info ? 'removed' : 'absent', runtime: vm.runtime || null }
  } catch (err) {
    return failure(err)
  }
}
