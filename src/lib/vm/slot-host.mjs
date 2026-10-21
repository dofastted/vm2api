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
 *   queueSyncRun(vm, slotDir)   serialized syncRun; callers must await the returned Promise
 *   onImport(vm, slotDir)       an imported credential replaces the slot's copy
 *   afterRefresh(vm, slotDir)   the slot rotated its credential; mirror it back
 *   touch(vm, slotDir)          telemetry activity mark
 *
 * A node may be a Mac (`platform: 'darwin'`): its slots are launchd services,
 * not containers. That host is `native: true`, has no Docker (dockerApi /
 * dockerEnv / execUser throw native_node_unsupported) and adds:
 *   slotPaths(vm)               node paths that replace the container paths in kernel.json / worker.json
 *   observe(vm)                 watchdog state of the kernel job
 *   inspect(vm)                 recovery-panel view (same shape as a container inspect)
 *   restartKernel(vm, root)     bounce or (re)load the kernel job
 *   telemetryRunning(vm)        sidecar job state
 *   restartTelemetry(vm, opts)  sidecar on/off
 *
 * Functions are wrapped, not referenced: this module sits in an import cycle
 * with vm-runtime / the kernel supervisor, so bindings are read at call time.
 */

import { localDocker } from '../cluster/docker-remote.mjs'
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
  nativeTelemetryRunning,
  observeNativeSlot,
  reloadNativeSlot,
  restartNativeKernel,
  restartNativeTelemetry,
  startNativeSlot,
  stopNativeSlot,
} from '../cluster/native-slot.mjs'
import { ClusterError } from '../cluster/ssh-link.mjs'
import {
  pullSlotCredentials,
  pushSlotCredentials,
  pushTelemetryTouch,
  queueSlotPush,
} from '../cluster/remote-slot-files.mjs'
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
} from './slot-engine.mjs'
import { destroyVmRuntime, officialCcUidGid, reloadSlotWorker, startVmRuntime, stopVmRuntime } from './vm-runtime.mjs'
import {
  boundProxyUrl,
  ensureProxyEgress,
  isLocalEgressProxy,
  localEgressProxyUrl,
  stopEgressProcessConfirmed,
} from './egress.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { nodeEgressProxyUrl } from '../cluster/node-egress-socks.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { stopCodexKernel, finishCodexRecycle } from '../transport/codex-kernel-supervisor.mjs'
import { isKubernetesMode, isKubernetesHaMode } from '../core/control-plane-mode.mjs'
import { haUnsupported } from '../core/ha-control-plane-policy.mjs'

const noop = async () => ({ skipped: true })

const LOCAL_HOST = Object.freeze({
  kind: 'local',
  nodeId: null,
  bakedKernel: false,
  ownsSocketFiles: true,
  bins: Object.freeze({ cli: CONTAINER_CLI_NODE_BIN, cc: CONTAINER_CC_NODE_BIN }),
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
  destroy: (vm) => destroyVmRuntime(vm),
  setProxyEgressEnabled: async (vm, projectRoot, enabled) => {
    if (isCodexVm(vm)) {
      if (enabled) return { ok: true }
      const child = stopCodexKernel(vm.id)
      if (!child)
        return isKubernetesMode()
          ? { ok: false, code: 'codex_kernel_owner_unknown', vmOperationUncertain: true }
          : { ok: true, notStarted: true }
      if (!(await finishCodexRecycle(child)).exited)
        return { ok: false, code: 'codex_kernel_exit_unconfirmed', vmOperationUncertain: true }
      return { ok: true, ended: true }
    }
    if (enabled) return await ensureProxyEgress(projectRoot, vm.proxy)
    return await stopEgressProcessConfirmed(projectRoot, vm.proxy?.id)
  },
  localExitProxyUrl: (vm) => (isCodexVm(vm) ? localEgressProxyUrl() : ''),
  // The container bind-mounts vms/<id>/ directly: every local write is already published.
  syncRun: noop,
  queueSyncRun: () => null,
  onImport: noop,
  afterRefresh: noop,
  touch: () => null,
})

function nodeHost(nodeId) {
  return {
    kind: 'node',
    nodeId,
    bakedKernel: true,
    ownsSocketFiles: false,
    bins: { cli: REMOTE_CLI_NODE_BIN, cc: REMOTE_CC_NODE_BIN },
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
    syncRun: (vm, slotDir) => queueSlotPush(vm, slotDir, ['run']),
    queueSyncRun: (vm, slotDir) => queueSlotPush(vm, slotDir, ['run']),
    onImport: (vm, slotDir) => pushSlotCredentials(vm, slotDir),
    afterRefresh: (vm, slotDir) => pullSlotCredentials(vm, slotDir),
    touch: (vm, slotDir) => pushTelemetryTouch(vm, slotDir),
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
    telemetryRunning: (vm) => nativeTelemetryRunning(vm),
    restartTelemetry: (vm, opts) => restartNativeTelemetry(vm, opts),
  }
}

export function slotHost(vm) {
  if (isKubernetesHaMode()) {
    const deny = () => {
      throw haUnsupported()
    }
    return {
      kind: 'managed',
      nodeId: vmNodeId(vm),
      bakedKernel: true,
      ownsSocketFiles: false,
      supports: () => false,
      dockerEnv: deny,
      dockerApi: deny,
      execUser: deny,
      start: deny,
      reload: deny,
      stop: deny,
      destroy: deny,
      setProxyEgressEnabled: deny,
      localExitProxyUrl: deny,
      syncRun: deny,
      queueSyncRun: deny,
      onImport: deny,
      afterRefresh: deny,
      touch: deny,
    }
  }
  const nodeId = vmNodeId(vm)
  if (nodeId && isNativeNodeVm(vm)) return nativeHost(nodeId, vm)
  const base = nodeId ? nodeHost(nodeId) : LOCAL_HOST
  if (!isKvmRuntime(vm)) return base
  // Runner socat owns run/kernel.sock; deleting it severs the guest relay.
  return { ...base, ownsSocketFiles: false }
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
