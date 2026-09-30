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
import {
  containerName,
  displayName,
  normalizeTimezone,
  SLOT_MEMORY,
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
  removeContainer,
  removeNetwork,
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
import { pushSlotFiles, reconcileSlotCredentials, remoteSlotPath, removeRemoteSlotDir } from './remote-slot-files.mjs'
import { REMOTE_WORKER_BIN, slotImageSpec } from './slot-image.mjs'

/** Bump when the slot's mount layout changes; a running container with an older label is recreated. */
const SLOT_LAYOUT = '2'

function failure(err, fallbackCode = 'remote_slot_failed') {
  return { ok: false, code: err?.code || fallbackCode, error: String(err?.message || err) }
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
 * Build the VM's exit on the node. px-local = shared masquerading bridge (node's
 * own IP, no process). SOCKS = the slot's own non-masquerading bridge + its
 * kin-egress (host-network container from the slot image) + iptables REDIRECT,
 * exactly like egress.mjs does on the control plane.
 */
export async function ensureRemoteEgress(session, vm, { imageRef }) {
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
  const body = `${JSON.stringify(cfg, null, 2)}\n`
  const digest = crypto.createHash('sha256').update(body).update(imageRef).digest('hex').slice(0, 16)
  // Beside the slot tree, outside every guest bind: the guest never sees the proxy password.
  const dir = `${remoteSlotDir(session.host, vm.id)}/egress`
  const owner = session.host.uid === 0 ? null : { uid: session.host.uid, gid: session.host.gid }
  const existing = await inspectContainerOrNull(session.docker, names.egress)
  if (!(existing?.State?.Running && existing.Config?.Labels?.['kin.egress.cfg'] === digest)) {
    await runRemote(session.client, `umask 077 && mkdir -p ${shellQuote(dir)} && chmod 700 ${shellQuote(dir)}`)
    await writeRemoteFile(await openSftp(session.client), `${dir}/egress.json`, body, { mode: 0o600 })
    if (existing) await removeContainer(session.docker, names.egress)
    await createContainerRaw(session.docker, names.egress, {
      Image: imageRef,
      ...(owner ? { User: `${owner.uid}:${owner.gid}` } : {}),
      Cmd: ['/usr/local/bin/kin-egress', '-config', '/etc/kin-egress/egress.json'],
      Labels: {
        'kin.egress': '1',
        'kin.egress.vm': vm.id,
        'kin.egress.proxy': proxyId,
        'kin.egress.cfg': digest,
        'vm2api.cluster': '1',
      },
      HostConfig: {
        NetworkMode: 'host',
        Binds: [`${dir}:/etc/kin-egress:ro`],
        RestartPolicy: { Name: 'unless-stopped' },
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
      },
    })
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
      return ensureRemoteEgress(session, vm, { imageRef: image.ref })
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

function slotContainerBody(vm, { image, network, remoteDir, user }) {
  const slotName = displayName(vm.id)
  const mem = parseMemoryBytes(SLOT_MEMORY)
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
    Cmd: [REMOTE_KERNEL_ENTRY, '--gateway-worker', '--config', '/run/kin/kernel.json'],
    Labels: {
      'kin.vm': '1',
      'kin.vm.id': vm.id,
      'kin.vm.name': slotName,
      'kin.vm.os': vm.kernel,
      'kin.vm.layout': SLOT_LAYOUT,
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
      ],
      NetworkMode: network,
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: mem,
      // RAM cap stays SLOT_MEMORY; an equal swap allowance lets idle CLI pages leave
      // RAM on small nodes (MemorySwap == Memory would forbid swap entirely).
      MemorySwap: mem * 2,
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

function applyRuntime(vm, { nodeId, name, info, image, network, user, relays, slotDir, egress, egressContainer }) {
  vm.runtime = {
    ...(vm.runtime || {}),
    type: 'docker',
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
    memory: SLOT_MEMORY,
    user,
    worker: 'rust',
    worker_socket: relays.worker,
    kernel_socket: relays.kernel,
    worker_run_dir: path.join(slotDir, 'run'),
    worker_token_file: path.join(slotDir, 'run', 'internal.token'),
    egress,
    egress_container: egressContainer || null,
    stopped: false,
  }
}

async function prepare(vm, projectRoot, routing) {
  if (isCodexVm(vm)) {
    return { fail: { ok: false, code: 'remote_unsupported', error: 'GPT 槽位暂不支持放到集群节点' } }
  }
  if (resolveKernelDataplane(vm, routing || {}) === 'crag') {
    return { fail: { ok: false, code: 'remote_unsupported', error: 'crag 数据面暂不支持集群节点' } }
  }
  vm.kernel = vm.kernel && OS_CATALOG[vm.kernel] ? vm.kernel : 'ubuntu-24.04'
  vm.timezone = normalizeTimezone(vm.timezone)
  vm.locale = vm.locale || STANDARD_LOCALE
  const nodeId = vmNodeId(vm)
  const session = await nodeSession(nodeId)
  const spec = slotImageSpec(projectRoot, vm.kernel)
  if (!(await imagePresent(session.docker, spec.ref))) {
    // The slot binaries changed since this node last built (an upgrade). An existing
    // slot must come back by itself, so build here (single-flight per node+kernel).
    const job = await awaitSlotImageBuild(startSlotImageBuild(nodeId, vm.kernel))
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
  }
  const owner = remoteSlotOwner(session.host, vm)
  return {
    nodeId,
    session,
    image: spec.ref,
    user: `${owner.uid}:${owner.gid}`,
    remoteDir: remoteSlotDir(session.host, vm.id),
    slotDir: path.join(projectRoot, 'vms', vm.id),
  }
}

/** Remote twin of startVmRuntime. Running + same image/network is left alone (Node restart must not bounce slots). */
export async function startRemoteSlot(vm, projectRoot, { recreate = false, routing } = {}) {
  try {
    const p = await prepare(vm, projectRoot, routing)
    if (p.fail) return p.fail
    const { nodeId, session, image, user, remoteDir, slotDir } = p
    const eg = await ensureRemoteEgress(session, vm, { imageRef: image })
    if (!eg.ok) return eg
    const name = containerName(vm.id)
    const relays = await clusterManager().ensureSlotRelays(nodeId, vm.id)
    let existing = await inspectContainerOrNull(session.docker, name)
    const matches =
      existing &&
      existing.Config?.Image === image &&
      existing.HostConfig?.NetworkMode === eg.network &&
      existing.Config?.Labels?.['kin.vm.layout'] === SLOT_LAYOUT &&
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
    }
    if (matches && existing.State?.Running) {
      applyRuntime(vm, { ...common, info: existing })
      return { ok: true, action: 'already-running', runtime: vm.runtime }
    }
    let previousNetwork = null
    if (existing && !matches) {
      // Remove first: from here on no guest process can touch the slot tree mid-migration.
      previousNetwork = existing.HostConfig?.NetworkMode
      await removeContainer(session.docker, name)
      existing = null
    }
    writeWorkerFiles(vm, projectRoot, { transparent: true, routing })
    ensureGuestMachineIdFile(projectRoot, vm)
    await pushSlotFiles(vm, slotDir, ['run', 'seed'], session)
    if (!existing) await migrateClaudeDir(session, vm, remoteDir)
    await reconcileSlotCredentials(vm, slotDir, session)
    if (previousNetwork && previousNetwork !== eg.network) await releaseRemoteEgress(session, previousNetwork)
    let action = 'started'
    if (!existing) {
      await createContainerRaw(
        session.docker,
        name,
        slotContainerBody(vm, { image, network: eg.network, remoteDir, user }),
      )
      action = 'created'
    }
    await containerAction(session.docker, name, 'start')
    await execDetached(session.docker, name, [
      REMOTE_WORKER_BIN,
      'telemetry',
      '--config',
      '/run/kin/worker.json',
    ]).catch(() => {})
    applyRuntime(vm, { ...common, info: await inspectContainerOrNull(session.docker, name) })
    return { ok: true, action, runtime: vm.runtime }
  } catch (err) {
    return failure(err)
  }
}

/** Remote twin of reloadSlotWorker: rewrite + push config, bounce the container, never remove it unless the exit moved. */
export async function reloadRemoteSlot(vm, projectRoot, { routing } = {}) {
  try {
    const p = await prepare(vm, projectRoot, routing)
    if (p.fail) return p.fail
    const { nodeId, session, image, user, remoteDir, slotDir } = p
    const eg = await ensureRemoteEgress(session, vm, { imageRef: image })
    if (!eg.ok) return eg
    const name = containerName(vm.id)
    const existing = await inspectContainerOrNull(session.docker, name)
    if (
      !existing ||
      existing.Config?.Image !== image ||
      existing.HostConfig?.NetworkMode !== eg.network ||
      existing.Config?.Labels?.['kin.vm.layout'] !== SLOT_LAYOUT
    ) {
      return startRemoteSlot(vm, projectRoot, { recreate: !!existing, routing })
    }
    const relays = await clusterManager().ensureSlotRelays(nodeId, vm.id)
    writeWorkerFiles(vm, projectRoot, { transparent: true, routing })
    await pushSlotFiles(vm, slotDir, ['run', 'seed'], session)
    await reconcileSlotCredentials(vm, slotDir, session)
    const running = !!existing.State?.Running
    await containerAction(session.docker, name, running ? 'restart' : 'start')
    await execDetached(session.docker, name, [
      REMOTE_WORKER_BIN,
      'telemetry',
      '--config',
      '/run/kin/worker.json',
    ]).catch(() => {})
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
      info: await inspectContainerOrNull(session.docker, name),
    })
    return { ok: true, action: running ? 'reloaded' : 'started', runtime: vm.runtime }
  } catch (err) {
    return failure(err)
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
    await containerAction(session.docker, name, 'stop')
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
