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
import fs from 'node:fs'
import path from 'node:path'
import { ensureGuestMachineIdFile } from '../identity/workstation-fingerprint.mjs'
import {
  boundProxyUrl,
  bridgeName,
  chainName,
  BRIDGE_NF_CALL_IPTABLES,
  claimSharedIp,
  configuredDnsUpstream,
  configuredSharedDnsEmptyTypes,
  proxyDnsEmptyTypes,
  egressConfigBody,
  egressConfigFor,
  gatewayFromSubnet,
  readSharedClaims,
  runExclusiveProxyEgress,
  sharedIptablesPlan,
  iptablesPlan,
  isLocalEgressProxy,
  LOCAL_EGRESS_ID,
  networkName,
  portFromListenSpec,
  portsForProxy,
  proxyKey,
} from '../vm/egress.mjs'
import { parseCidr, parseRouteSubnets, createSubnetAllocator, gatewayOf, subnetPoolConfig } from '../vm/subnet-pool.mjs'
import {
  DEFAULT_SHARED_PREFIX,
  assignSharedIp,
  isSharedModeVm,
  isSharedNetwork,
  networkModeOf,
  mergeSharedRoute,
  pruneSharedRoutes,
  sharedBridgeName,
  sharedChainName,
  sharedEgressId,
  sharedNetworkName,
  sharedNodeIdFromNetwork,
} from '../vm/shared-egress.mjs'
import { OS_CATALOG } from '../vm/os-catalog.mjs'
import {
  REMOTE_CRAG_ENTRY,
  REMOTE_KERNEL_ENTRY,
  resolveCragKernelVersion,
  resolveKernelDataplane,
} from '../vm/slot-engine.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { kernelCpuCommand, kernelCpuCommandMatches, usesKernelCpuLimit } from '../vm/kernel-cpu.mjs'
import { kvmCragAppArmorCommand } from '../vm/kvm-crag-apparmor.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'
import { isKvmRuntime, runtimeKind } from '../vm/runtime-kind.mjs'
import { slotMemory, slotDockerCpus, memoryMiB, normalizeVmConfig } from '../vm/machine-spec.mjs'
import { slotCreationLimits } from '../vm/slot-capacity.mjs'
import { dockerEnvMap, ensureKvmMachineRecord, kvmEnvMapIncomplete, kvmMachineFields } from '../vm/kvm-machine.mjs'
import { slotExecArgv, slotExecCmd } from '../vm/slot-exec.mjs'
import {
  CODEX_SLOT_ROLE,
  containerName,
  displayName,
  kvmBindChownArgv,
  normalizeTimezone,
  resolveSlotRouting,
  KVM_CAPS,
  STANDARD_LOCALE,
  writeWorkerFiles,
} from '../vm/vm-runtime.mjs'
import { projectCragUniversalVm, readCragClusterSubscription } from '../vm/crag-license.mjs'
import { withCragRuntimeAdmission } from '../vm/slot-runtime-admission.mjs'
import { publishKvmCragLicense } from '../vm/kvm-crag-license.mjs'
import { patchVmRecord } from '../vm/vm-registry.mjs'
import {
  containerAction,
  createContainerRaw,
  createNetwork,
  dockerJson,
  execDetached,
  imagePresent,
  inspectContainerOrNull,
  inspectNetworkOrNull,
  listNetworks,
  connectContainerToNetwork,
  disconnectContainerFromNetwork,
  removeContainer,
  signalContainer,
  removeNetwork,
  renameContainer,
} from './docker-remote.mjs'
import { refreshNativeSlotPayload, currentNativePayloadDigest } from './native-slot.mjs'
import {
  awaitSlotImageBuild,
  clusterManager,
  isNativeNodeVm,
  nodeSession,
  parseMemoryBytes,
  remoteSlotDir,
  remoteSlotOwner,
  startSlotImageBuild,
  vmNodeId,
} from './placement.mjs'
import { openSftp, readRemoteFileNoFollow, runRemote, shellQuote, writeRemoteFile } from './remote-fs.mjs'
import { stripSlotCredentialEmailBytes } from '../oauth/oauth-credentials.mjs'

import {
  pushCragSlot,
  pushSharedEgressBinary,
  pushSlotBinaries,
  pushSlotFiles,
  reconcileSlotCredentials,
  remoteSlotPath,
  removeRemoteSlotDir,
} from './remote-slot-files.mjs'
import { slotImageSpec } from './slot-image.mjs'
import {
  clusterSubscriptionBinds,
  hasClusterSubscriptionBinds,
  publishClusterSubscription,
} from './crag-subscription-files.mjs'
import {
  clusterComputerBinds,
  hasClusterComputerBinds,
  hasLocalComputer,
  pushClusterComputer,
} from './slot-computer-files.mjs'
import { defaultSeedPolicy, isTelemetryEnabled } from '../protocol/seed-policy.mjs'

const CRAG_V2_SECCOMP = JSON.stringify(
  JSON.parse(fs.readFileSync(new URL('../vm/crag-v2-seccomp.json', import.meta.url), 'utf8')),
)

/** Bump when the slot's mount layout changes; a running container with an older label is recreated. */
const SLOT_LAYOUT = '3'
const LIVE_BIN = '/opt/kin-live'
const LIVE_BIN_GUEST = '/opt/kin-guest/opt/kin-live'
const LIVE_SERVICE_MOUNT_DESTINATIONS = Object.freeze([LIVE_BIN, LIVE_BIN_GUEST])

function clusterDockerClaude(vm) {
  return !isCodexVm(vm) && !isKvmRuntime(vm) && !isNativeNodeVm(vm) && Boolean(vmNodeId(vm))
}

/** The running command has to match this slot's kernel. CRAG v2 also needs the userns sandbox. */
export function clusterDockerCommandReady(vm, info, routing) {
  if (!clusterDockerClaude(vm)) return true
  const crag =
    resolveKernelDataplane(vm, routing || {}) === 'crag' && resolveCragKernelVersion(vm, routing || {}) === 'v2'
  if (crag) return clusterCragContainerReady(info)
  const cmd = info?.Config?.Cmd || []
  return Array.isArray(cmd) && (cmd[0] === REMOTE_KERNEL_ENTRY || kernelCpuCommandMatches(cmd, REMOTE_KERNEL_ENTRY))
}

export function clusterCragContainerReady(info) {
  const cmd = info?.Config?.Cmd || []
  if (!Array.isArray(cmd) || cmd[0] !== REMOTE_CRAG_ENTRY) return false
  if (info?.HostConfig?.Init !== true) return false
  const opts = info?.HostConfig?.SecurityOpt || []
  return opts.some((opt) => String(opt).startsWith('seccomp=')) && opts.includes('apparmor=unconfined')
}

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
  await writeRemoteFile(await openSftp(session.client), dest, stripSlotCredentialEmailBytes(old).data, {
    mode: 0o600,
    owner,
  })
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

/**
 * IPAM body for a node network, given what the node already holds. Pure, so the
 * allocation contract is testable without standing up a docker connection.
 *
 * Keyed on the network name, so a rebuild lands on the same range. Subnets are
 * per-node: VMs never talk to each other (enable_icc=false) and an IP is not a
 * VM's durable identity, so two nodes may hold the same range.
 */
export function remoteEgressIpam({ name, networks = [], routes = '', prefix: want } = {}) {
  const taken = []
  for (const net of networks) {
    for (const cfg of net?.IPAM?.Config || []) {
      const cidr = parseCidr(cfg?.Subnet)
      if (cidr) taken.push(cidr)
    }
  }
  taken.push(...parseRouteSubnets(routes))
  const { pool, prefix: perVm } = subnetPoolConfig()
  // A shared network holds one address per VM on the node, so it is sized for
  // the node rather than per VM.
  const prefix = Number.isInteger(want) ? want : perVm
  // A drained pool propagates: falling back here would only hide the same failure.
  const subnet = createSubnetAllocator({ pool, prefix, taken }).allocate(name)
  const gateway = gatewayOf(subnet)
  return { Driver: 'default', Config: [{ Subnet: subnet, ...(gateway ? { Gateway: gateway } : {}) }] }
}

/**
 * Explicit subnet for a node network. Created without one, docker draws from the
 * daemon's `default-address-pools`, which runs dry after a few dozen networks —
 * the reason a node stops creating exits past ~200 VMs, since a SOCKS slot holds
 * one network each.
 */
async function remoteSubnetIpam(docker, name, runIp, prefix) {
  let networks
  try {
    networks = await listNetworks(docker)
  } catch {
    // No conflict data means no safe explicit choice; let the daemon pool decide.
    return null
  }
  let routes = ''
  if (typeof runIp === 'function') {
    try {
      routes = await runIp()
    } catch {}
  }
  return remoteEgressIpam({ name, networks, routes, prefix })
}

/**
 * The IPv4 range of a node network.
 *
 * A dual-stack network lists several IPAM configs and the IPv6 one can come
 * first, so taking Config[0] whole yields a range that parses as neither a
 * subnet nor a gateway.
 */
export function ipv4ConfigOf(info) {
  for (const cfg of info?.IPAM?.Config || []) {
    const cidr = parseCidr(cfg?.Subnet)
    if (!cidr) continue
    return { subnet: String(cfg.Subnet), gateway: String(cfg.Gateway || '') || gatewayFromSubnet(cfg.Subnet) }
  }
  return null
}

async function ensureRemoteNetwork(docker, { name, bridge, masquerade, labels = {}, runIp, prefix } = {}) {
  let info = await inspectNetworkOrNull(docker, name)
  if (!info) {
    const ipam = await remoteSubnetIpam(docker, name, runIp, prefix)
    await createNetwork(docker, {
      Name: name,
      Driver: 'bridge',
      EnableIPv6: false,
      Labels: labels,
      ...(ipam ? { IPAM: ipam } : {}),
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
    // Bare hash of the VM id, and only a starting point: see
    // resolveRemoteEgressPorts, which keeps an already-started pair and
    // otherwise probes past the pairs other slots on the node hold.
    ports: portsForProxy(vmId),
  }
}

/** Port pair out of a slot's own egress.json; null when it was never started. */
async function readRemoteEgressPorts(session, dir, { readFile = readRemoteFileNoFollow } = {}) {
  const body = await readFile(session.client, `${dir}/egress.json`).catch(() => null)
  if (!body) return null
  try {
    const cfg = JSON.parse(body.toString('utf8'))
    const tcp = portFromListenSpec(cfg?.listen_tcp)
    const dns = portFromListenSpec(cfg?.listen_dns)
    return tcp && dns ? { tcp, dns } : null
  } catch {
    return null
  }
}

/**
 * Ports already spoken for on a node: every slot's recorded pair, plus whatever
 * is actually listening. Extracted on the node rather than shipped over, since a
 * node at scale holds thousands of configs.
 */
async function remoteAllocatedPorts(session, { run = runRemote } = {}) {
  const root = shellQuote(`${session.host.root}/vms`)
  const script = [
    `awk -F'"' '/listen_(tcp|dns)/{n=split($4,a,":"); print a[n]}' ${root}/*/egress/egress.json 2>/dev/null || true`,
    `ss -ltnH 2>/dev/null | awk '{n=split($4,a,":"); print a[n]}' || true`,
  ].join('\n')
  const used = new Set()
  const out = await run(session.client, script).catch(() => '')
  for (const line of String(out || '').split('\n')) {
    const port = Number(line.trim())
    if (Number.isInteger(port) && port > 0 && port < 65536) used.add(port)
  }
  return used
}

/**
 * The pair this slot's helper should listen on.
 *
 * An already-started helper keeps its pair: the iptables rows that REDIRECT into
 * it were written with those ports, and moving them would leave the rules
 * pointing at a port nothing listens on. Only a fresh exit probes, and then it
 * steps past the pairs other slots on the node already hold -- the bare hash has
 * 8000 slots and no collision check, so two slots on a busy node can otherwise
 * land on the same pair and have their traffic redirected into each other's
 * helper.
 */
export async function resolveRemoteEgressPorts(session, vmId, dir, io = {}) {
  const persisted = await readRemoteEgressPorts(session, dir, io)
  if (persisted) return { ...persisted, reused: true }
  const used = await remoteAllocatedPorts(session, io)
  if (!used.size) return { ...portsForProxy(vmId), reused: false }
  return {
    ...portsForProxy(vmId, { taken: (pair) => used.has(pair.tcp) || used.has(pair.dns) }),
    reused: false,
  }
}

/**
 * kin-egress container body. The helper reads a 0600 config written by the SSH
 * user, so it runs as that same uid:gid; with a root login the image default
 * (kincli) could not open the root-owned file and crash-looped on EACCES. The
 * user is part of the digest so a helper created under the old spec is rebuilt.
 *
 * Only what needs a new container is hashed: listen addresses, image, user,
 * binary and mounts. Proxy, DNS and policy fields reload via SIGHUP instead
 * (see ensureRemoteEgress), so `kin.egress.proxy` records the proxy at creation.
 */
export function remoteEgressContainer({ vmId, proxyId, dir, imageRef, body, host, binaryDigest = '' }) {
  const user = `${host.uid}:${host.gid}`
  let listen = ''
  try {
    const cfg = JSON.parse(body)
    listen = `${cfg.listen_tcp || ''}\0${cfg.listen_dns || ''}`
  } catch {
    listen = String(body)
  }
  const digest = crypto
    .createHash('sha256')
    .update(`egress-v2\0${listen}\0${dir}\0`)
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
        // Helpers created from this spec run a binary that reloads on SIGHUP.
        'kin.egress.reload': 'hup',
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

/** A reused helper may take a new config by SIGHUP only if it was created with a reload-capable binary. */
export function canReloadRemoteEgress(existing) {
  return existing?.Config?.Labels?.['kin.egress.reload'] === 'hup'
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
/**
 * Whether bridged traffic reaches iptables **on the node**.
 *
 * The control-plane helper reads its own /proc; a node is a different machine,
 * so this has to go over SSH. Both barriers between VMs sharing the folded
 * bridge live in iptables, and with br_netfilter off they are inert at once —
 * every VM on that node could reach every other, with nothing in any log.
 *
 * runRemote resolves to stdout itself, not to a result object. Reading a
 * `.stdout` off that string yields undefined, which made a correctly
 * configured node look like one with the switch off and refused shared egress
 * outright. A failed read still refuses, since a node whose state cannot be
 * established is not one to fold a bridge on.
 */
export async function remoteBridgeNetfilter(session) {
  const stdout = await runRemote(session.client, `cat ${BRIDGE_NF_CALL_IPTABLES}`).catch(() => null)
  if (stdout === null) return false
  return String(stdout).trim() === '1'
}

/**
 * Addresses held by endpoints on the node's shared network, with their holder.
 *
 * The holder matters: a VM's own endpoint is here once its container is
 * attached, and counting that as taken would renumber the VM on every restart.
 */
function remoteSharedEndpointIps(info) {
  const items = []
  const owners = {}
  for (const entry of Object.values(info?.Containers || {})) {
    const ip = String(entry?.IPv4Address || '')
      .split('/')[0]
      .trim()
    if (!ip) continue
    items.push(ip)
    owners[ip] = String(entry?.Name || '')
  }
  return { items, owners }
}

/** The route table the node's shared helper is currently configured with. */
async function remoteSharedRoutes(session, dir) {
  try {
    const raw = await readRemoteFileNoFollow(session.client, `${dir}/egress.json`)
    if (!raw) return []
    const cfg = JSON.parse(raw.toString('utf8'))
    return Array.isArray(cfg?.routes) ? cfg.routes : []
  } catch {
    return []
  }
}

/**
 * Make one VM on a cluster node routable through that node's shared helper.
 *
 * Remote twin of ensureSharedEgressForVm, and it inherits that function's
 * reason for existing: the whole table is rebuilt from the addresses the node's
 * shared network holds, the addresses promised to slots still starting, and the
 * table the helper already has. All of it under one acquisition of the node's
 * lock, because computing a whole-table replacement outside it lets two slots
 * start from one snapshot and the later publish drop the earlier slot's route.
 *
 * The lock and the claims live on the control plane, which is the only writer
 * to any node, so the same process-local serialisation covers a remote node as
 * it does the local host. What cannot be shared is anything that reads the
 * machine: the bridge check and the current route table go over SSH, since the
 * local versions would inspect the control plane instead of the node.
 */
export async function ensureRemoteSharedEgress(session, vm, projectRoot, { imageRef, binaryDigest = '' } = {}) {
  const proxy = vm.proxy
  const blocked = proxyBlockedReason(proxy)
  if (blocked) return { ok: false, code: blocked, error: blocked }
  const proxyUrl = boundProxyUrl(proxy)
  const vmId = String(vm?.id || '')
  if (!proxyUrl) {
    return { ok: false, code: 'proxy_required', error: 'bound SOCKS5 url required; refusing fallback' }
  }
  if (!vmId) return { ok: false, code: 'vm_required', error: 'vm id required for a shared address claim' }
  if (session.host.uid !== 0 && !session.host.sudo) {
    return { ok: false, code: 'egress_sudo_required', error: '节点需要 root 或免密 sudo 才能为 SOCKS5 出口写 iptables' }
  }
  const nodeId = session.nodeId || ''
  const names = sharedRemoteNames(nodeId, session.host)

  return runExclusiveProxyEgress(projectRoot, sharedEgressId(nodeId), async () => {
    if (!(await remoteBridgeNetfilter(session))) {
      return {
        ok: false,
        code: 'bridge_netfilter_disabled',
        error:
          '节点需要加载 br_netfilter 并设置 net.bridge.bridge-nf-call-iptables=1，否则共享网桥上的 VM 之间没有隔离',
      }
    }
    // The container binds <root>/egress/slot-bin as its executable directory,
    // and the per-slot push only ever fills a VM's own slot-bin, so without
    // this the helper has no binary to start from.
    const pushed = await pushSharedEgressBinary(session, projectRoot)
    if (!pushed.ok) return { ok: false, code: pushed.code || 'egress_binary_missing', error: pushed.error }
    // Sized for the whole node rather than for one VM.
    const net = await ensureRemoteNetwork(session.docker, {
      name: names.network,
      bridge: names.bridge,
      masquerade: false,
      prefix: DEFAULT_SHARED_PREFIX,
      runIp: () => runRemote(session.client, 'ip route'),
    })
    const info = await inspectNetworkOrNull(session.docker, names.network)
    const ipv4 = ipv4ConfigOf(info)
    if (!ipv4)
      return { ok: false, code: 'egress_network_failed', error: `shared network ${names.network} has no IPv4 range` }
    const live = remoteSharedEndpointIps(info)
    // This VM's own endpoint is in the live set once its container is attached,
    // so ownership is compared rather than membership.
    const selfContainer = String(vm?.runtime?.container || containerName(vm.id))
    const heldByOthers = live.items.filter((addr) => live.owners[addr] !== selfContainer)

    const at = Date.now()
    const claims = readSharedClaims(projectRoot, nodeId, at)
    const others = Object.entries(claims)
      .filter(([id]) => id !== vmId)
      .map(([, c]) => c.ip)
    let ip
    try {
      ip = assignSharedIp(vm, { subnet: ipv4.subnet, taken: [...heldByOthers, ...others] }).ip
    } catch (e) {
      return { ok: false, code: 'shared_subnet_full', error: e?.message || 'shared address allocation failed' }
    }
    claimSharedIp(projectRoot, nodeId, vmId, ip, at)

    const ports = await resolveRemoteEgressPorts(session, sharedEgressId(nodeId), names.dir)
    const existing = await remoteSharedRoutes(session, names.dir)
    const pruned = pruneSharedRoutes(existing, live.items, { keep: [ip, ...others] })
    const routes = mergeSharedRoute(pruned, { vmId, ip, proxyUrl })
    const cfg = egressConfigFor({
      proxyId: sharedEgressId(nodeId),
      // No default exit: every VM leaves through the upstream its route names.
      proxyUrl: '',
      listenTcp: `${net.gateway}:${ports.tcp}`,
      listenDns: `${net.gateway}:${ports.dns}`,
      dnsUpstream: configuredDnsUpstream(),
      // Intersection over this node's membership — one helper, many outlets.
      dnsEmptyTypes: configuredSharedDnsEmptyTypes(routes),
      routes,
    })
    const body = egressConfigBody(cfg)
    const { digest, spec } = remoteEgressContainer({
      vmId: sharedEgressId(nodeId),
      proxyId: sharedEgressId(nodeId),
      dir: names.dir,
      imageRef,
      body,
      host: session.host,
      binaryDigest,
    })

    const container = await inspectContainerOrNull(session.docker, names.egress)
    const cfgFile = `${names.dir}/egress.json`
    let reuse = canReuseRemoteEgress(container, digest) && canReloadRemoteEgress(container)
    let reloaded = false
    if (reuse) {
      const current = await readRemoteFileNoFollow(session.client, cfgFile).catch(() => null)
      if (current == null) reuse = false
      else if (current.toString('utf8') !== body) {
        // Membership change: keep the container and every established splice.
        await writeRemoteFile(await openSftp(session.client), cfgFile, body, { mode: 0o600 })
        await signalContainer(session.docker, names.egress, 'HUP')
        reloaded = true
      }
    }
    if (!reuse) {
      await runRemote(
        session.client,
        `umask 077 && mkdir -p ${shellQuote(names.dir)} && chmod 700 ${shellQuote(names.dir)}`,
      )
      await writeRemoteFile(await openSftp(session.client), cfgFile, body, { mode: 0o600 })
      if (container) await removeContainer(session.docker, names.egress)
      await createContainerRaw(session.docker, names.egress, spec)
      await containerAction(session.docker, names.egress, 'start')
    }

    const tcp = ports.tcp
    const probe = `for i in $(seq 1 40); do ss -H -ltn 'sport = :${tcp}' | awk '{print $4}' | grep -qxF -e '${net.gateway}:${tcp}' -e '0.0.0.0:${tcp}' -e '*:${tcp}' && exit 0; sleep 0.2; done; exit 1`
    await runRemote(session.client, `bash -c ${shellQuote(probe)}`, { timeoutMs: 20_000, code: 'egress_not_listening' })

    // The shared variant, so inter-VM traffic on the folded bridge is dropped.
    const plan = sharedIptablesPlan({
      chain: names.chain,
      bridge: net.bridge,
      subnet: ipv4.subnet,
      tcpPort: tcp,
      dnsPort: ports.dns,
    })
    await runRemote(session.client, remoteIptablesScript(plan, { sudo: session.host.uid !== 0 }), {
      code: 'egress_iptables_failed',
    })

    return {
      ok: true,
      mode: 'shared',
      network: net.name,
      bridge: net.bridge,
      subnet: ipv4.subnet,
      gateway: net.gateway,
      egress: names.egress,
      ip,
      routes: routes.length,
      reused: reuse,
      reloaded,
      ports: { tcp: ports.tcp, dns: ports.dns },
    }
  })
}

export async function ensureRemoteEgress(session, vm, { imageRef, binaryDigest = '', projectRoot = '' } = {}) {
  const proxy = vm.proxy
  const blocked = proxyBlockedReason(proxy)
  if (blocked) return { ok: false, code: blocked, error: blocked }
  // Dispatched here rather than at each call site: a site left unconverted
  // would bring a shared-mode VM up on a per-VM bridge, where the shared
  // helper has no route for it.
  if (isSharedModeVm(vm) && !isLocalEgressProxy(proxy)) {
    if (!projectRoot) {
      return {
        ok: false,
        code: 'project_root_required',
        error: 'shared egress needs projectRoot for its address claims',
      }
    }
    return ensureRemoteSharedEgress(session, vm, projectRoot, { imageRef, binaryDigest })
  }
  if (isLocalEgressProxy(proxy)) {
    const id = proxy?.id || LOCAL_EGRESS_ID
    const net = await ensureRemoteNetwork(session.docker, {
      name: networkName(id),
      bridge: bridgeName(id),
      masquerade: true,
      runIp: () => runRemote(session.client, 'ip route'),
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
  // Beside the slot tree, outside every guest bind: the guest never sees the proxy password.
  const dir = `${remoteSlotDir(session.host, vm.id)}/egress`
  // Resolved before the config is built: an existing helper keeps its pair so the
  // iptables rows that REDIRECT into it stay aligned, and a fresh one steps past
  // the pairs other slots on this node hold.
  const ports = await resolveRemoteEgressPorts(session, vm.id, dir)
  // Keep the helper's executable on the persistent mount even when egress is
  // enabled independently of a slot start/update.
  const slotBin = shellQuote(`${remoteSlotDir(session.host, vm.id)}/slot-bin`)
  await runRemote(session.client, `umask 077 && mkdir -p ${slotBin} && chmod 755 ${slotBin}`)
  const net = await ensureRemoteNetwork(session.docker, {
    name: names.network,
    bridge: names.bridge,
    masquerade: false,
    labels: { 'kin.egress.vm': vm.id },
    runIp: () => runRemote(session.client, 'ip route'),
  })
  // Built through the same builder the local side uses, so a field cannot be
  // present in one config writer and missing from the other. This was the
  // fourth construction site, in a second file, and the node side is where
  // thousands of VMs actually run.
  const cfg = egressConfigFor({
    proxyId,
    proxyUrl,
    listenTcp: `${net.gateway}:${ports.tcp}`,
    listenDns: `${net.gateway}:${ports.dns}`,
    dnsUpstream: configuredDnsUpstream(),
    // Per outlet: this helper serves exactly this proxy.
    dnsEmptyTypes: proxyDnsEmptyTypes(proxy),
  })
  const body = egressConfigBody(cfg)
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
  const cfgFile = `${dir}/egress.json`
  let reuse = canReuseRemoteEgress(existing, digest) && canReloadRemoteEgress(existing)
  let reloaded = false
  if (reuse) {
    const current = await readRemoteFileNoFollow(session.client, cfgFile).catch(() => null)
    if (current == null) reuse = false
    else if (current.toString('utf8') !== body) {
      // Proxy/DNS/policy change: keep the container and its established connections.
      await writeRemoteFile(await openSftp(session.client), cfgFile, body, { mode: 0o600 })
      await signalContainer(session.docker, names.egress, 'HUP')
      reloaded = true
    }
  }
  if (!reuse) {
    await runRemote(session.client, `umask 077 && mkdir -p ${shellQuote(dir)} && chmod 700 ${shellQuote(dir)}`)
    await writeRemoteFile(await openSftp(session.client), cfgFile, body, { mode: 0o600 })
    if (existing) await removeContainer(session.docker, names.egress)
    await createContainerRaw(session.docker, names.egress, spec)
    await containerAction(session.docker, names.egress, 'start')
  }
  // Passive: a TCP connect would enter kin-egress's transparent path (it refuses self-destined conns).
  const tcp = ports.tcp
  const probe = `for i in $(seq 1 40); do ss -H -ltn 'sport = :${tcp}' | awk '{print $4}' | grep -qxF -e '${net.gateway}:${tcp}' -e '0.0.0.0:${tcp}' -e '*:${tcp}' && exit 0; sleep 0.2; done; exit 1`
  await runRemote(session.client, `bash -c ${shellQuote(probe)}`, { timeoutMs: 20_000, code: 'egress_not_listening' })
  const plan = iptablesPlan({
    chain: names.chain,
    bridge: net.bridge,
    subnet: net.subnet,
    tcpPort: tcp,
    dnsPort: ports.dns,
  })
  await runRemote(session.client, remoteIptablesScript(plan, { sudo: session.host.uid !== 0 }), {
    code: 'egress_iptables_failed',
  })
  return {
    ok: true,
    mode: 'socks',
    network: net.name,
    egress: names.egress,
    reused: reuse,
    reloaded,
    ports: { tcp: ports.tcp, dns: ports.dns },
  }
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
      return ensureRemoteEgress(session, vm, { imageRef: image.ref, binaryDigest: binaries.digest, projectRoot })
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
/**
 * Where a node's shared exit lives. Node-level, beside the per-proxy exits
 * rather than inside any VM's tree, because it outlives every single VM on the
 * node.
 */
export function sharedRemoteNames(nodeId, host) {
  const id = sharedEgressId(nodeId)
  return {
    network: sharedNetworkName(nodeId),
    bridge: sharedBridgeName(nodeId),
    chain: sharedChainName(nodeId),
    egress: `kin-egress-${id}`,
    dir: `${host.root}/egress/${id}`,
    ports: portsForProxy(id),
  }
}

/**
 * Which helper, chain, bridge, ports and config directory a network's exit
 * uses. Pure, so the reclaim contract is testable without a docker connection —
 * getting it wrong deletes rules that were never created and leaves the real
 * ones behind, naming a bridge that is gone.
 */
export function exitOf(name, info, host) {
  // A shared network carries no per-VM label, so without this it falls through
  // to the per-proxy parse below, which reads 'shared-<nodeId>' as a proxy id
  // and derives a chain and bridge that were never created. Reclaiming the
  // network would then delete rules that do not exist and leave the real ones
  // behind, pointing at a bridge that is gone.
  if (isSharedNetwork(name)) {
    const nodeId = sharedNodeIdFromNetwork(name)
    if (nodeId === null) return { egress: null }
    const n = sharedRemoteNames(nodeId, host)
    return { egress: n.egress, chain: n.chain, bridge: n.bridge, ports: n.ports, dir: n.dir, shared: true }
  }
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
    // Read back the pair the helper was started with. Probing means the hash is
    // only a starting point, so recomputing it here would delete rows for ports
    // this exit never used and leave its real ones behind.
    const started = exit.dir ? await readRemoteEgressPorts(session, exit.dir) : null
    const ports = started || exit.ports
    const plan = iptablesPlan({
      chain: exit.chain,
      bridge: exit.bridge,
      subnet,
      tcpPort: ports.tcp,
      dnsPort: ports.dns,
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

/**
 * Endpoint config pinning a slot to its address on the shared network.
 *
 * The helper's route table is keyed on this exact address, so letting docker
 * assign one would put the VM on the bridge either with an address no route
 * names — refused fail-closed — or with an address another VM's route names.
 * Empty for a per-VM slot, which is alone on its bridge.
 */
function sharedEndpointConfig(network, ip) {
  if (!ip) return {}
  return { NetworkingConfig: { EndpointsConfig: { [network]: { IPAMConfig: { IPv4Address: ip } } } } }
}

function kvmSlotContainerBody(vm, { image, network, ip = '', remoteDir, routing, accel, slotUser }) {
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
      ...(usesKernelCpuLimit(vm, routing) ? ['KIN_KVM_KERNEL_CPU_LIMIT=1'] : []),
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
      RestartPolicy: { Name: remoteSlotRestartPolicy(vm, routing) },
      StopTimeout: 30,
      Memory: mem,
      MemorySwap: mem,
      PidsLimit: slotCreationLimits(vm, routing).pids,
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
      CapAdd: KVM_CAPS,
      Dns: ['8.8.8.8'],
      DnsOptions: ['use-vc'],
    },
    ...sharedEndpointConfig(network, ip),
  }
  if (accel === 'kvm') {
    body.HostConfig.Devices = [{ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' }]
  }
  return body
}

export function slotContainerBody(
  vm,
  { image, network, ip = '', remoteDir, user, routing, accel, subscription = false, computer = false },
) {
  if (isKvmRuntime(vm))
    return kvmSlotContainerBody(vm, { image, network, ip, remoteDir, routing, accel, slotUser: user })
  const slotName = displayName(vm.id)
  const limits = slotCreationLimits(vm, routing)
  const mem = parseMemoryBytes(limits.memory)
  const cpus = slotDockerCpus(vm)
  const codex = isCodexVm(vm)
  const crag =
    !codex && resolveKernelDataplane(vm, routing) === 'crag' && resolveCragKernelVersion(vm, routing) === 'v2'
  const entry = crag ? REMOTE_CRAG_ENTRY : REMOTE_KERNEL_ENTRY
  const argv = [entry, '--gateway-worker', '--config', '/run/kin/kernel.json']
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
    Cmd: codex ? ['sleep', 'infinity'] : usesKernelCpuLimit(vm, routing) ? kernelCpuCommand(argv) : argv,
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
        ...(subscription ? clusterSubscriptionBinds(remoteDir) : []),
        // Same read-only computer identity a local Docker slot gets (computerDockerArgs).
        ...(computer ? clusterComputerBinds(remoteDir) : []),
      ],
      NetworkMode: network,
      RestartPolicy: { Name: remoteSlotRestartPolicy(vm, routing) },
      Memory: mem,
      // Equal swap allowance lets idle CLI pages leave RAM on small nodes
      // (MemorySwap == Memory would forbid swap entirely).
      MemorySwap: mem * 2,
      ...(cpus > 0 ? { NanoCpus: Math.round(cpus * 1e9) } : {}),
      PidsLimit: limits.pids,
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' },
      SecurityOpt: crag
        ? ['no-new-privileges', `seccomp=${CRAG_V2_SECCOMP}`, 'apparmor=unconfined']
        : ['no-new-privileges'],
      ...(crag ? { Init: true } : {}),
      CapDrop: ['ALL'],
      Dns: ['8.8.8.8'],
      DnsOptions: ['use-vc'],
    },
    ...sharedEndpointConfig(network, ip),
  }
}

/**
 * Rebuild vm.runtime for a remote slot. Exported so the fields it must carry
 * across a refresh are testable without a node: this object is replaced
 * wholesale each time, so a field missing here is a field that silently
 * disappears on first start.
 */
export function applyRuntime(
  vm,
  { nodeId, name, info, image, network, user, relays, slotDir, egress, egressContainer, routing, accel, sharedIp },
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
    // Carried across every refresh, like the worker paths above. This object is
    // rebuilt from scratch each time, and these two decide which network the
    // slot attaches to and at which address: dropping them would leave a VM on
    // the shared bridge while the control plane looked for a per-VM one that
    // was never created for it. Same reason runtimePatch carries them locally.
    egress_mode: networkModeOf(vm),
    shared_ip: sharedIp || vm.runtime?.shared_ip || null,
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
 * Current control-plane payload (kernel, cli-node, cc-node and OAuth helpers)
 * as a slot image on this node. Same bytes local slots bind-mount; a node only
 * sees them after the content-hashed image exists and the container is recreated.
 */
export async function refreshNodeSlotPayload(
  vm,
  projectRoot,
  {
    routing,
    recreate = true,
    startFn = startRemoteSlot,
    sessionFor = nodeSession,
    inspect = inspectContainerOrNull,
  } = {},
) {
  const id = vm?.id
  const nodeId = vmNodeId(vm)
  if (!id || !nodeId) return { id, ok: false, code: 'not_cluster_slot', error: '不是集群槽' }
  if (isNativeNodeVm(vm)) return refreshNativeSlotPayload(vm, projectRoot, { routing, recreate })
  const resolvedRouting = resolveSlotRouting(projectRoot, routing)
  if (recreate !== false && vm.status === 'running') {
    const result = await withCragRuntimeAdmission(vm, projectRoot, { routing: resolvedRouting, action: 'reload' }, () =>
      refreshDockerSlotPayload(vm, projectRoot, { routing: resolvedRouting, recreate, startFn, sessionFor, inspect }),
    )
    return { id, node_id: nodeId, ...result }
  }
  return refreshDockerSlotPayload(vm, projectRoot, { routing: resolvedRouting, recreate, startFn, sessionFor, inspect })
}

async function refreshDockerSlotPayload(vm, projectRoot, { routing, recreate, startFn, sessionFor, inspect }) {
  const id = vm.id
  const nodeId = vmNodeId(vm)
  const kernel = vm.kernel && OS_CATALOG[vm.kernel] ? vm.kernel : 'ubuntu-24.04'
  const kind = runtimeKind(vm)
  try {
    const session = await sessionFor(nodeId)
    // Older images have no CRAG layer. The slot-bin mount is already there, so publish
    // the tree without recreating a container whose image is otherwise current.
    if (session?.client)
      await pushCragSlot(vm, projectRoot, session, { required: resolveKernelDataplane(vm, routing || {}) === 'crag' })
    const running = recreate !== false && vm.status === 'running'
    // A current image stays up only when its command matches this slot's kernel.
    if (running) {
      const ref = slotImageSpec(projectRoot, kernel, { runtime: kind }).ref
      const info = await inspect(session.docker, vm.runtime?.container || containerName(id))
      if (info?.State?.Running && info.Config?.Image === ref && clusterDockerCommandReady(vm, info, routing)) {
        return {
          id,
          node_id: nodeId,
          ok: true,
          image: ref,
          kernel_changed: false,
          restarted: false,
          kernel: { ok: true, skipped: true, reason: 'unchanged' },
        }
      }
      if (info?.State?.Running && info.Config?.Image === ref && clusterDockerClaude(vm)) {
        const boot = await startFn(vm, projectRoot, { recreate: true, routing })
        if (!boot?.ok) {
          return {
            id,
            node_id: nodeId,
            ok: false,
            code: boot?.code || 'slot_payload_refresh_failed',
            error: boot?.error || '集群槽切换内核失败',
            image: ref,
          }
        }
        return {
          id,
          node_id: nodeId,
          ok: true,
          image: ref,
          kernel_changed: true,
          restarted: true,
          kernel: { ok: true, action: boot.action || 'recreated' },
        }
      }
    }
    const spec = await ensureNodeSlotImage(session, nodeId, projectRoot, kernel, kind)
    if (spec.fail) return { id, node_id: nodeId, ...spec.fail }
    if (kind === 'kvm') {
      const dockerSpec = await ensureNodeSlotImage(session, nodeId, projectRoot, kernel, 'docker')
      if (dockerSpec.fail) return { id, node_id: nodeId, ...dockerSpec.fail }
    }
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
export async function inspectClusterPayloadChanges(
  projectRoot,
  vms,
  {
    routing,
    sessionFor = nodeSession,
    inspect = inspectContainerOrNull,
    nativeVm = isNativeNodeVm,
    nativeDigestFor = currentNativePayloadDigest,
  } = {},
) {
  const items = []
  const nativeDigest = nativeDigestFor(projectRoot)
  for (const vm of vms || []) {
    if (isCodexVm(vm)) continue
    const nodeId = vmNodeId(vm)
    if (nativeVm(vm)) {
      items.push({
        id: vm.id,
        node_id: nodeId,
        ok: nativeDigest != null,
        baked: true,
        native: true,
        code: nativeDigest ? undefined : 'native_payload_missing',
        kernel_changed: nativeDigest != null && vm.runtime?.payload_digest !== nativeDigest,
      })
      continue
    }
    const kernel = vm.kernel && OS_CATALOG[vm.kernel] ? vm.kernel : 'ubuntu-24.04'
    const spec = slotImageSpec(projectRoot, kernel, { runtime: runtimeKind(vm) })
    const session = await sessionFor(nodeId)
    const info = await inspect(session.docker, containerName(vm.id))
    const current = String(info?.Config?.Image || '')
    items.push({
      id: vm.id,
      node_id: nodeId,
      ok: true,
      baked: true,
      image: spec.ref,
      kernel_changed: current !== spec.ref,
    })
  }
  const changed = items.filter((item) => item.kernel_changed)
  return {
    ok: true,
    changed: changed.length > 0,
    total: items.length,
    ok_count: items.length,
    failed_count: 0,
    changed_count: changed.length,
    items,
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
    // Codex inference is the host Codex kernel; this update targets Claude CLI payloads.
    if (isCodexVm(vm)) continue
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

async function prepare(vm, projectRoot, routing, { pinnedImageId = null } = {}) {
  vm.kernel = vm.kernel && OS_CATALOG[vm.kernel] ? vm.kernel : 'ubuntu-24.04'
  vm.timezone = normalizeTimezone(vm.timezone)
  vm.locale = vm.locale || STANDARD_LOCALE
  const nodeId = vmNodeId(vm)
  const session = await nodeSession(nodeId)
  const kind = runtimeKind(vm)
  // A cold migration must boot the exact checked base, even if its tag changes during the copy.
  if (
    pinnedImageId &&
    (!/^sha256:[a-f0-9]{64}$/.test(pinnedImageId) || !(await imagePresent(session.docker, pinnedImageId)))
  ) {
    return { fail: { ok: false, code: 'migration_image_missing', error: '迁移锁定的原始镜像不存在' } }
  }
  const spec = pinnedImageId
    ? { ref: pinnedImageId }
    : await ensureNodeSlotImage(session, nodeId, projectRoot, vm.kernel, kind)
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

async function chownRemoteKvmBinds(session, name, vm) {
  if (!isKvmRuntime(vm)) return
  await runRemote(session.client, kvmBindChownArgv(name, vm).map(shellQuote).join(' '), { timeoutMs: 15_000 })
}

function remoteSlotRestartPolicy(vm, routing) {
  return resolveKernelDataplane(vm, routing) === 'crag' ? 'no' : 'unless-stopped'
}

async function updateRemoteSlotRestartPolicy(docker, info, policy) {
  if (!info || (info.HostConfig?.RestartPolicy?.Name || 'no') === policy) return false
  await dockerJson(docker, {
    method: 'POST',
    path: `/containers/${encodeURIComponent(info.Id)}/update`,
    body: { RestartPolicy: { Name: policy } },
    timeoutMs: 15_000,
  })
  return true
}

/** Reconcile an existing node slot without stopping, recreating or starting it. */
export async function syncRemoteSlotRestartPolicy(vm, routing) {
  if (!vmNodeId(vm) || isNativeNodeVm(vm) || remoteSlotRestartPolicy(vm, routing) !== 'no')
    return { ok: true, changed: false }
  try {
    const { docker } = await nodeSession(vmNodeId(vm))
    const info = await inspectContainerOrNull(docker, vm.runtime?.container || containerName(vm.id))
    return { ok: true, changed: await updateRemoteSlotRestartPolicy(docker, info, 'no') }
  } catch (err) {
    return failure(err, 'kernel_restart_policy_failed')
  }
}

/**
 * Docker slots get the control plane's computer identity bound read-only, like a
 * local slot. A running container only has to be recreated for it when telemetry
 * is on for that slot (the kernel refuses telemetry without it); otherwise the
 * binds are added the next time the container is created anyway.
 */
export function clusterComputerPolicy(projectRoot, vm) {
  const computer = !isKvmRuntime(vm) && !isCodexVm(vm) && hasLocalComputer(projectRoot, vm)
  const required = computer && isTelemetryEnabled(defaultSeedPolicy(vm.seed_policy || {}))
  return { computer, required }
}

/** Remote twin of startVmRuntime. Running + same image/network is left alone (Node restart must not bounce slots). */
export async function startRemoteSlot(vm, projectRoot, opts = {}) {
  const { recreate = false, pinnedImageId = null } = opts
  const routing = resolveSlotRouting(projectRoot, opts.routing)
  return withCragRuntimeAdmission(vm, projectRoot, { routing, action: 'start' }, () =>
    startRemoteSlotAdmitted(vm, projectRoot, { recreate, routing, pinnedImageId }),
  )
}

async function startRemoteSlotAdmitted(vm, projectRoot, { recreate, routing, pinnedImageId = null }) {
  try {
    if (!isKvmRuntime(vm)) slotDockerCpus(vm)
    const p = await prepare(vm, projectRoot, routing, { pinnedImageId })
    if (p.fail) return p.fail
    if (resolveKernelDataplane(vm, routing) === 'crag') await projectCragUniversalVm(projectRoot, vm)
    const { nodeId, session, image, egressImage, user, remoteDir, slotDir } = p
    const kvm = isKvmRuntime(vm)
    const crag = !kvm && resolveKernelDataplane(vm, routing) === 'crag'
    const subscription = crag && !!readCragClusterSubscription(projectRoot, vm)
    const computerPolicy = clusterComputerPolicy(projectRoot, vm)
    let accel = vm.runtime?.accel
    if (kvm && accel !== 'kvm' && accel !== 'tcg') {
      const probe = await probeRemoteAccel(session, routing)
      if (!probe.ok) return { ok: false, code: 'kvm_unavailable', error: probe.error }
      accel = probe.accel
    }
    const binaries =
      typeof pushSlotBinaries === 'function' ? await pushSlotBinaries(vm, projectRoot, session) : { digest: '' }
    const eg = await ensureRemoteEgress(session, vm, {
      imageRef: egressImage || image,
      binaryDigest: binaries.digest,
      projectRoot,
    })
    if (!eg.ok) return eg
    const name = containerName(vm.id)
    const relays = await clusterManager().ensureSlotRelays(nodeId, vm.id)
    let existing = await inspectContainerOrNull(session.docker, name)
    if (kvm && existing) {
      ensureKvmMachineRecord(vm, {
        projectRoot,
        containerEnv: dockerEnvMap(existing.Config?.Env),
        persist: true,
      })
    }
    const matches =
      existing &&
      existing.Config?.Image === image &&
      existing.HostConfig?.NetworkMode === eg.network &&
      existing.Config?.Labels?.['kin.vm.layout'] === SLOT_LAYOUT &&
      runtimeLabelOf(existing) === runtimeKind(vm) &&
      codexRoleMatches(existing, vm) &&
      clusterDockerCommandReady(vm, existing, routing) &&
      (!subscription || hasClusterSubscriptionBinds(existing, remoteDir)) &&
      (!computerPolicy.required || hasClusterComputerBinds(existing, remoteDir)) &&
      // Running stays true during Docker restart-policy backoff. Recreate the
      // loop just like the local runtime; otherwise watchdog revival is a no-op.
      !existing.State?.Restarting &&
      !recreate
    if (matches) await updateRemoteSlotRestartPolicy(session.docker, existing, remoteSlotRestartPolicy(vm, routing))
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
      if (subscription) await publishClusterSubscription(projectRoot, vm, session)
      await reconcileSlotCredentials(vm, slotDir, session)
      applyRuntime(vm, { ...common, info: existing, sharedIp: eg.ip })
      return { ok: true, action: 'already-running', runtime: vm.runtime }
    }
    let previousNetwork = null
    const envBroken = kvm && existing && kvmEnvMapIncomplete(dockerEnvMap(existing.Config?.Env), existing.Config?.Env)
    if (existing && (!matches || envBroken)) {
      previousNetwork = existing.HostConfig?.NetworkMode
      await removeContainer(session.docker, name)
      existing = null
    }
    writeWorkerFiles(vm, projectRoot, { transparent: true, routing })
    ensureGuestMachineIdFile(projectRoot, vm)
    await pushSlotFiles(vm, slotDir, ['run', 'seed'], session)
    if (subscription) await publishClusterSubscription(projectRoot, vm, session, { force: true })
    const computer =
      computerPolicy.computer &&
      (await pushClusterComputer(projectRoot, vm, session, {
        remoteDir,
        owner: session.host.uid === 0 ? remoteSlotOwner(session.host, vm) : null,
      }))
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
        slotContainerBody(vm, {
          image,
          network: eg.network,
          ip: eg.ip || '',
          remoteDir,
          user,
          routing,
          accel,
          subscription,
          computer,
        }),
      )
      action = 'created'
    }
    await containerAction(session.docker, name, 'start')
    await chownRemoteKvmBinds(session, name, vm)
    applyRuntime(vm, { ...common, info: await inspectContainerOrNull(session.docker, name), sharedIp: eg.ip })
    return { ok: true, action, runtime: vm.runtime }
  } catch (err) {
    return failure(err)
  }
}

/** Remote twin of reloadSlotWorker: rewrite + push config, bounce the container, never remove it unless the exit moved. */
export async function reloadRemoteSlot(vm, projectRoot, opts = {}) {
  const routing = resolveSlotRouting(projectRoot, opts.routing)
  return withCragRuntimeAdmission(vm, projectRoot, { routing, action: 'reload' }, () =>
    reloadRemoteSlotAdmitted(vm, projectRoot, { routing }),
  )
}

async function reloadRemoteSlotAdmitted(vm, projectRoot, { routing }) {
  try {
    if (!isKvmRuntime(vm)) slotDockerCpus(vm)
    const p = await prepare(vm, projectRoot, routing)
    if (p.fail) return p.fail
    const { nodeId, session, image, user, remoteDir, slotDir } = p
    const subscription =
      !isKvmRuntime(vm) &&
      resolveKernelDataplane(vm, routing) === 'crag' &&
      !!readCragClusterSubscription(projectRoot, vm)
    const binaries =
      typeof pushSlotBinaries === 'function' ? await pushSlotBinaries(vm, projectRoot, session) : { digest: '' }
    const eg = await ensureRemoteEgress(session, vm, {
      imageRef: p.egressImage || image,
      binaryDigest: binaries.digest,
      projectRoot,
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
      !codexRoleMatches(existing, vm) ||
      !clusterDockerCommandReady(vm, existing, routing) ||
      (subscription && !hasClusterSubscriptionBinds(existing, remoteDir)) ||
      (clusterComputerPolicy(projectRoot, vm).required && !hasClusterComputerBinds(existing, remoteDir))
    ) {
      return startRemoteSlotAdmitted(vm, projectRoot, { recreate: !!existing, routing })
    }
    await updateRemoteSlotRestartPolicy(session.docker, existing, remoteSlotRestartPolicy(vm, routing))
    const relays = await clusterManager().ensureSlotRelays(nodeId, vm.id)
    writeWorkerFiles(vm, projectRoot, { transparent: true, routing })
    await pushSlotFiles(vm, slotDir, ['run', 'seed'], session)
    if (subscription) await publishClusterSubscription(projectRoot, vm, session, { force: true })
    await reconcileSlotCredentials(vm, slotDir, session)
    const running = !!existing.State?.Running
    if (isKvmRuntime(vm) && running) {
      await chownRemoteKvmBinds(session, name, vm)
      if (resolveKernelDataplane(vm, routing) === 'crag') {
        await publishKvmCragLicense(projectRoot, vm, { force: true })
      }
      const argv = slotExecArgv(
        { ...vm, runtime: { ...(vm.runtime || {}), container: name, type: 'kvm' } },
        kvmCragAppArmorCommand({ restart: true }),
        { user: '0', interactive: true },
      )
      await runRemote(session.client, ['docker', ...argv].map(shellQuote).join(' '), { timeoutMs: 60_000 })
    } else {
      await containerAction(session.docker, name, running ? 'restart' : 'start')
      await chownRemoteKvmBinds(session, name, vm)
    }
    applyRuntime(vm, {
      nodeId,
      name,
      image,
      network: eg.network,
      ...(eg.ip ? { sharedIp: eg.ip } : {}),
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
export async function migrateRemoteServiceContainers(vm, projectRoot, opts = {}) {
  const routing = resolveSlotRouting(projectRoot, opts.routing)
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
      const migrate = async () => {
        if (remoteSlotRestartPolicy(vm, routing) === 'no') {
          await updateRemoteSlotRestartPolicy(session.docker, slot, 'no')
          body.HostConfig.RestartPolicy = { Name: 'no' }
        }
        return migrateRemoteContainer(session.docker, slotName, body, { wasRunning: !!slot.State?.Running })
      }
      const result = slot.State?.Running
        ? await withCragRuntimeAdmission(vm, projectRoot, { routing, action: 'reload' }, migrate)
        : await migrate()
      if (!result.ok) return result
      migrated.push(result)
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

export async function stopRemoteSlot(vm) {
  try {
    const session = await nodeSession(vmNodeId(vm))
    const name = containerName(vm.id)
    const info = await inspectContainerOrNull(session.docker, name)
    if (!info) {
      if (vm.runtime) vm.runtime = { ...vm.runtime, pid: null, ip: null, stopped: true }
      return { ok: true, action: 'absent', runtime: vm.runtime || null }
    }
    // A controller-confirmed stop can make the old CRAG seat eligible for reclaim.
    await updateRemoteSlotRestartPolicy(session.docker, info, 'no')
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
    return { ok: true, action: info ? 'removed' : 'absent', teardownConfirmed: true, runtime: vm.runtime || null }
  } catch (err) {
    return failure(err)
  }
}
