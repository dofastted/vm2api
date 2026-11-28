/**
 * Slot host contract. The control plane (main docker) manages every slot; a
 * slot's container runs either on this host or on a cluster node (a VPS joined
 * over SSH, `vm.node_id`). Callers never branch on placement: they ask
 * `slotHost(vm)` and call the same methods.
 *
 *   kind            'local' | 'node'
 *   bakedKernel     kernel + CLIs ship inside the slot image (no host kin-kernel,
 *                   no materialized .kin in the slot home)
 *   ownsSocketFiles slot sockets are real files of the slot (local). A node slot's
 *                   socket path is a local relay: never rm it, its mtime is not the kernel's
 *   bins            in-container CLI paths written to kernel.json
 *   supports(cap)   'official_cc' | 'wrap_cli' | 'engine_switch' | 'auth_scheme' | 'codex'
 *   dockerEnv()     env for async docker CLI spawns (undefined = this host's daemon)
 *   dockerApi()     Engine API connector for the daemon that runs the slot
 *   execUser(vm)    `docker exec -u` for in-slot kin-worker commands
 *   start/reload/stop/destroy   same result contract as vm-runtime
 *   setProxyEgressEnabled(vm, projectRoot, enabled) stop/resume only the proxy helper
 *   localExitProxyUrl(vm)  host-side route for a slot on local egress: '' = this
 *                   host's default route (or the deployment proxy of a Codex slot); a node
 *                   slot gets a loopback SOCKS5 that dials from the node itself
 *   syncRun(vm, slotDir)        publish run/ (kernel.json, worker.json, token) where the slot reads it
 *   queueSyncRun(vm, slotDir)   fire-and-forget syncRun
 *   syncCredentials(vm, slotDir) one-way Panel SSOT read-only projection of credentials to the slot
 *   onImport(vm, slotDir)       alias of syncCredentials (imported credential replaces the slot's copy)
 *   afterRefresh(vm, slotDir)   no-op under Panel SSOT (slots never rotate credentials or push back)
 *   syncTelemetry(vm, slotDir)  acknowledge run/seed publication for VM-native telemetry
 *   seedFiles(vm, slotDir)      read owner seed bytes plus actual HOME; null means missing, errors never fall back
 *   syncSeed(vm, slotDir)       acknowledge all three seed files without claiming native telemetry support
 *
 * A node may be a Mac (`platform: 'darwin'`): its slots are launchd services,
 * not containers. That host is `native: true`, has no Docker (dockerApi /
 * dockerEnv / execUser throw native_node_unsupported) and adds:
 *   slotPaths(vm)               node paths that replace the container paths in kernel.json / worker.json
 *   observe(vm)                 watchdog state of the kernel job
 *   inspect(vm)                 recovery-panel view (same shape as a container inspect)
 *   restartKernel(vm, root)     bounce or (re)load the kernel job
 *
 * Functions are wrapped, not referenced: this module sits in an import cycle
 * with vm-runtime / the kernel supervisor, so bindings are read at call time.
 */

import { inspectContainerOrNull, localDocker } from '../cluster/docker-remote.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { nodeSession, remoteSlotDir } from '../cluster/placement.mjs'
import { readRemoteFileNoFollow } from '../cluster/remote-fs.mjs'
import {
  clusterManager,
  isNativeNodeVm,
  placementProjectRoot,
  SLOT_CAPS_NODE,
  vmNodeId,
} from '../cluster/placement.mjs'
import {
  currentNativePayloadDigest,
  destroyNativeSlot,
  inspectNativeSlot,
  nativeSlotPaths,
  observeNativeSlot,
  reloadNativeSlot,
  restartNativeKernel,
  startNativeSlot,
  stopNativeSlot,
} from '../cluster/native-slot.mjs'
import { ClusterError } from '../cluster/ssh-link.mjs'
import { pushSlotCredentials, pushSlotFiles, queueSlotPush } from '../cluster/remote-slot-files.mjs'
import {
  destroyRemoteSlot,
  reloadRemoteSlot,
  setRemoteProxyEgressEnabled,
  startRemoteSlot,
  stopRemoteSlot,
} from '../cluster/remote-slot.mjs'
import {
  CONTAINER_CC_NODE_BIN,
  CONTAINER_CLI_NODE_BIN,
  REMOTE_CC_NODE_BIN,
  REMOTE_CLI_NODE_BIN,
  slotCcNodeBin,
  slotCliNodeBin,
} from './slot-engine.mjs'
import { isCustomSlotUser, slotGuestUidGid } from './slot-identity.mjs'
import {
  containerName,
  destroyVmRuntime,
  officialCcUidGid,
  reloadSlotWorker,
  startVmRuntime,
  stopVmRuntime,
} from './vm-runtime.mjs'
import {
  boundProxyUrl,
  ensureProxyEgress,
  inspectEgressProcess,
  isLocalEgressProxy,
  localEgressProxyUrl,
  stopEgressProcess,
} from './egress.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { nodeEgressProxyUrl } from '../cluster/node-egress-socks.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { isCustomKvmMode } from './custom-os-runtime.mjs'
import { resolveSlotAgentConnection, syncCustomKvmSlotFiles } from './kvm-slot-agent-client.mjs'
import { stripWorkerCredentialEmail } from '../oauth/oauth-credentials.mjs'
import { stopCodexKernel } from '../transport/codex-kernel-supervisor.mjs'
import { readLocalSlotSeedFiles } from './slot-seed.mjs'

const noop = async () => ({ skipped: true })

async function isLocalSlotContainerRunning(vm, { dockerApi = localDocker, inspect = inspectContainerOrNull } = {}) {
  const name = vm?.runtime?.container_name || (vm?.id ? containerName(vm.id) : '')
  if (!name) return false
  try {
    const info = await inspect(dockerApi(), name)
    return info?.State?.Running === true
  } catch {
    return String(vm?.status || '').toLowerCase() === 'running'
  }
}

/**
 * One-way Panel SSOT credential projection for local custom-erofs KVM slots.
 * Pushes sanitized `credentials.json` over `kin-slot-agent` (guest writes 0440
 * root:<slot-gid> + relative `.credentials.json` symlink). Skips cleanly when
 * the slot container is stopped (next boot syncs via rust-kernel-supervisor);
 * fails closed when the slot is running and the agent is unreachable or rejects.
 */
export async function pushCustomKvmSlotCredentials(vm, slotDir, deps = {}) {
  const homeDir = path.join(slotDir, 'cli-home')
  const localCred = path.join(homeDir, '.claude', 'credentials.json')
  if (!fs.existsSync(localCred)) return { pushed: false, reason: 'local_missing' }
  stripWorkerCredentialEmail(homeDir)

  const projectRoot = path.dirname(path.dirname(slotDir))
  const syncFn = deps.syncFiles || syncCustomKvmSlotFiles
  const checkRunning = () =>
    typeof deps.isRunning === 'function' ? deps.isRunning(vm) : isLocalSlotContainerRunning(vm, deps)

  if (!deps.client && !deps.syncFiles) {
    const conn = resolveSlotAgentConnection(projectRoot, vm, deps)
    const missingSocket = !conn.socketPath || !fs.existsSync(conn.socketPath)
    if (missingSocket || !conn.token) {
      if (!(await checkRunning())) return { pushed: false, skipped: true, reason: 'slot_stopped' }
      const code = missingSocket ? 'agent_socket_missing' : 'agent_token_missing'
      throw new ClusterError(502, code, `Custom-EROFS KVM slot agent is unavailable (${code})`)
    }
  }

  const synced = await syncFn(projectRoot, vm, {
    homeDir,
    targets: ['credentials'],
    requiredTargets: ['credentials'],
    ...(deps.client ? { client: deps.client } : {}),
    ...(deps.socketPath ? { socketPath: deps.socketPath } : {}),
    ...(deps.token ? { token: deps.token } : {}),
    ...(deps.timeoutMs != null ? { timeoutMs: deps.timeoutMs } : {}),
  })
  if (!synced?.ok) {
    if (synced?.error === 'agent_unreachable' && !(await checkRunning())) {
      return { pushed: false, skipped: true, reason: 'slot_stopped' }
    }
    throw new ClusterError(
      502,
      synced?.error || 'kvm_credential_sync_failed',
      synced?.message || 'Failed to sync credentials to custom-erofs KVM guest',
    )
  }
  return { pushed: true, synced: synced.synced || ['credentials'] }
}

const LOCAL_HOST = Object.freeze({
  kind: 'local',
  nodeId: null,
  bakedKernel: false,
  ownsSocketFiles: true,
  bins: Object.freeze({
    cli: CONTAINER_CLI_NODE_BIN,
    cc: CONTAINER_CC_NODE_BIN,
    oauthAuth: '/usr/local/bin/kin-oauth-auth',
    worker: '/usr/local/bin/kin-worker',
  }),
  supports: () => true,
  dockerEnv: () => undefined,
  dockerApi: () => localDocker(),
  execUser: (vm) => {
    const { uid, gid } = officialCcUidGid(vm?.id)
    return `${uid}:${gid}`
  },
  start: (vm, projectRoot, opts) => startVmRuntime(vm, projectRoot, opts),
  reload: (vm, projectRoot, opts) => reloadSlotWorker(vm, projectRoot, opts),
  stop: (vm) => stopVmRuntime(vm),
  destroy: (vm, opts) => destroyVmRuntime(vm, opts),
  setProxyEgressEnabled: async (vm, projectRoot, enabled) => {
    if (isCodexVm(vm)) {
      if (enabled) return { ok: true }
      const child = stopCodexKernel(vm.id)
      if (!child || child.exitCode !== null || child.signalCode !== null) return { ok: true }
      return new Promise((resolve) => {
        const exited = () => {
          clearTimeout(timeout)
          resolve({ ok: true })
        }
        const timeout = setTimeout(() => {
          child.off('exit', exited)
          resolve({ ok: false, error: 'codex_stop_timeout' })
        }, 2000)
        child.once('exit', exited)
      })
    }
    if (enabled) return await ensureProxyEgress(projectRoot, vm.proxy)
    const stopped = stopEgressProcess(projectRoot, vm.proxy?.id)
    if (!stopped.ok) return stopped
    const deadline = Date.now() + 2000
    while (inspectEgressProcess(projectRoot, vm.proxy?.id).ok) {
      if (Date.now() >= deadline) return { ok: false, error: 'egress_stop_timeout' }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return stopEgressProcess(projectRoot, vm.proxy?.id)
  },
  localExitProxyUrl: (vm) => (isCodexVm(vm) ? localEgressProxyUrl() : ''),
  // The container bind-mounts vms/<id>/ directly: every local write is already published.
  syncRun: noop,
  seedFiles: async (_vm, slotDir) => ({
    cli_home: path.join(slotDir, 'cli-home'),
    files: readLocalSlotSeedFiles(slotDir),
  }),
  syncSeed: async (_vm, slotDir) => {
    const files = readLocalSlotSeedFiles(slotDir)
    if (Object.values(files).some((value) => value === null)) {
      throw new ClusterError(502, 'seed_publish_failed', 'VM seed files are missing')
    }
    return { published: true }
  },
  syncTelemetry: async (vm, slotDir) => {
    const files = readLocalSlotSeedFiles(slotDir)
    if (Object.values(files).some((value) => value === null)) {
      throw new ClusterError(502, 'telemetry_publish_failed', 'VM seed files are missing')
    }
    const config = path.join(vm.runtime?.worker_run_dir || path.join(slotDir, 'run'), 'kernel.json')
    const fd = fs.openSync(config, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      if (!fs.fstatSync(fd).isFile())
        throw new ClusterError(502, 'telemetry_publish_failed', 'VM kernel config is unavailable')
    } finally {
      fs.closeSync(fd)
    }
    return { published: true }
  },
  telemetryLog: async (vm, slotDir) => {
    const file = path.join(vm.runtime?.worker_run_dir || path.join(slotDir, 'run'), 'telemetry-upload.log')
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      try {
        const stat = fs.fstatSync(fd)
        return stat.isFile() && stat.size <= 65536 ? fs.readFileSync(fd, 'utf8') : ''
      } finally {
        fs.closeSync(fd)
      }
    } catch (error) {
      if (error.code === 'ENOENT') return ''
      throw error
    }
  },
  queueSyncRun: () => null,
  syncCredentials: noop,
  onImport: noop,
  afterRefresh: noop,
})

function nodeHost(nodeId) {
  return {
    kind: 'node',
    nodeId,
    bakedKernel: true,
    ownsSocketFiles: false,
    bins: {
      cli: REMOTE_CLI_NODE_BIN,
      cc: REMOTE_CC_NODE_BIN,
      oauthAuth: '/usr/local/bin/kin-oauth-auth',
      worker: '/usr/local/bin/kin-worker',
    },
    supports: (cap) => SLOT_CAPS_NODE.has(cap),
    dockerEnv: () => ({ ...process.env, DOCKER_HOST: `unix://${clusterManager().bridgeSocketPath(nodeId)}` }),
    dockerApi: () => clusterManager().docker(nodeId),
    // The container runs as the node's SSH uid (or 10000+n when that is root); runtime.user records it.
    execUser: (vm) => vm?.runtime?.user || LOCAL_HOST.execUser(vm),
    start: (vm, projectRoot, opts) => startRemoteSlot(vm, projectRoot, opts),
    reload: (vm, projectRoot, opts) => reloadRemoteSlot(vm, projectRoot, opts),
    stop: (vm) => stopRemoteSlot(vm),
    destroy: (vm) => destroyRemoteSlot(vm),
    setProxyEgressEnabled: (vm, projectRoot, enabled) => setRemoteProxyEgressEnabled(vm, projectRoot, enabled),
    localExitProxyUrl: () => nodeEgressProxyUrl(nodeId),
    syncRun: (vm, slotDir) => pushSlotFiles(vm, slotDir, ['run']),
    seedFiles: async (vm) => {
      const session = await nodeSession(nodeId)
      const root = remoteSlotDir(session.host, vm.id)
      const files = {}
      for (const name of ['settings.json', 'claude.setting', 'kin-seed.json']) {
        const bytes = await readRemoteFileNoFollow(session.client, `${root}/claude/${name}`, {
          maxBytes: (1 << 20) + 1,
        })
        if (bytes && bytes.length > 1 << 20)
          throw new ClusterError(502, 'seed_file_too_large', 'VM seed file is too large')
        files[name] = bytes === null ? null : bytes.toString('utf8')
      }
      return { cli_home: `${root}/cli-home`, files }
    },
    syncSeed: async (vm, slotDir) => {
      const result = await pushSlotFiles(vm, slotDir, ['seed_settings'])
      if (
        !['settings.json', 'claude.setting', 'kin-seed.json'].every((name) =>
          result.pushed.includes(`cli-home/.claude/${name}`),
        )
      ) {
        throw new ClusterError(502, 'seed_publish_failed', 'VM seed configuration was not published')
      }
      return { ...result, published: true }
    },
    syncTelemetry: async (vm, slotDir) => {
      const result = await pushSlotFiles(vm, slotDir, ['telemetry'])
      if (
        ![
          'run/kernel.json',
          'cli-home/.claude/settings.json',
          'cli-home/.claude/claude.setting',
          'cli-home/.claude/kin-seed.json',
        ].every((file) => result.pushed.includes(file))
      ) {
        throw new ClusterError(502, 'telemetry_publish_failed', 'VM telemetry configuration was not published')
      }
      return { ...result, published: true }
    },
    telemetryLog: async (vm) => {
      const session = await nodeSession(nodeId)
      const bytes = await readRemoteFileNoFollow(
        session.client,
        `${remoteSlotDir(session.host, vm.id)}/run/telemetry-upload.log`,
        { maxBytes: 65536 },
      )
      return bytes?.toString('utf8') || ''
    },
    queueSyncRun: (vm, slotDir) => queueSlotPush(vm, slotDir, ['run']),
    syncCredentials: (vm, slotDir) => pushSlotCredentials(vm, slotDir),
    onImport: (vm, slotDir) => pushSlotCredentials(vm, slotDir),
    afterRefresh: noop,
  }
}

/**
 * Node paths of a native slot. The root comes from the node's last SSH session
 * (or the slot's own runtime record when the node has not connected since the
 * control plane started); the payload digest from the control plane's darwin build.
 */
function nativePaths(nodeId, vm) {
  const root = clusterManager().nodeHostFacts?.(nodeId)?.root || vm?.runtime?.remote_dir?.replace(/\/vms\/[^/]+$/, '')
  if (!root) throw new ClusterError(409, 'node_not_ready', `节点 ${nodeId} 尚未连接，无法确定槽位路径`)
  const digest = currentNativePayloadDigest(placementProjectRoot()) || vm?.runtime?.payload_digest || 'missing'
  return nativeSlotPaths(root, vm.id, digest)
}

function nativeHost(nodeId, record) {
  const unsupported = (what) => () => {
    throw new ClusterError(409, 'native_node_unsupported', `macOS 原生节点不支持${what}`)
  }
  const base = nodeHost(nodeId)
  return {
    ...base,
    native: true,
    supports: () => false,
    // Paths resolve on access: kernel.json is often written for a slot the node has not seen yet.
    get bins() {
      return {
        get cli() {
          return `${nativePaths(nodeId, record).payload}/cli-node`
        },
        get cc() {
          return `${nativePaths(nodeId, record).payload}/cc-node`
        },
      }
    },
    slotPaths: (vm) => nativePaths(nodeId, vm),
    dockerEnv: unsupported('容器命令'),
    dockerApi: unsupported('容器命令'),
    execUser: unsupported('容器命令'),
    syncTelemetry: unsupported('VM 原生遥测'),
    start: (vm, projectRoot, opts) => startNativeSlot(vm, projectRoot, opts),
    reload: (vm, projectRoot, opts) => reloadNativeSlot(vm, projectRoot, opts),
    stop: (vm) => stopNativeSlot(vm),
    destroy: (vm) => destroyNativeSlot(vm),
    setProxyEgressEnabled: async () => ({
      ok: false,
      code: 'native_proxy_unsupported',
      error: 'macOS 原生节点目前只支持本机网络出口',
    }),
    observe: (vm) => observeNativeSlot(vm),
    inspect: (vm) => inspectNativeSlot(vm),
    restartKernel: (vm, projectRoot, opts) => restartNativeKernel(vm, projectRoot, opts),
  }
}

export function slotHost(vm) {
  const nodeId = vmNodeId(vm)
  if (nodeId && isNativeNodeVm(vm)) return nativeHost(nodeId, vm)
  const base = nodeId ? nodeHost(nodeId) : LOCAL_HOST
  const localCustomBins =
    !nodeId && isCustomSlotUser(vm)
      ? {
          ...base.bins,
          cli: slotCliNodeBin(vm),
          cc: slotCcNodeBin(vm),
        }
      : base.bins
  if (!isKvmRuntime(vm)) {
    return localCustomBins === base.bins ? base : { ...base, bins: localCustomBins }
  }
  const customKvm = isCustomKvmMode({ vm })
  // Runner socat owns run/kernel.sock; deleting it severs the guest relay.
  // Custom-erofs KVM runs crag-v2 and owns /home/<user>/.claude as slotGuestUidGid(vm)
  // (1000:1000 for custom users, 999:987 for legacy kincli), so execUser must match.
  return {
    ...base,
    bins: {
      ...localCustomBins,
      oauthAuth: customKvm ? '/usr/local/bin/kin-oauth-auth' : '/opt/kin-payload/usr/local/bin/kin-oauth-auth',
      worker: customKvm ? '/usr/local/bin/kin-worker' : '/opt/kin-payload/usr/local/bin/kin-worker',
    },
    ...(customKvm
      ? {
          execUser: (targetVm = vm) => {
            const { uid, gid } = slotGuestUidGid(targetVm || vm)
            return `${uid}:${gid}`
          },
          ...(!nodeId
            ? {
                syncCredentials: (targetVm, slotDir) => pushCustomKvmSlotCredentials(targetVm || vm, slotDir),
                onImport: (targetVm, slotDir) => pushCustomKvmSlotCredentials(targetVm || vm, slotDir),
                afterRefresh: noop,
              }
            : {}),
        }
      : {}),
    ownsSocketFiles: false,
  }
}

/**
 * Exit for a host-side request made for this VM: its bound SOCKS5, or for local
 * egress the route of the VPS that runs the slot. A local Claude slot's container
 * has no proxy env, so its requests stay direct; a node slot's must not leave from here.
 */
export function hostProxyUrlForVm(vm) {
  if (!isLocalEgressProxy(vm?.proxy)) return boundProxyUrl(vm?.proxy)
  return slotHost(vm).localExitProxyUrl(vm)
}
