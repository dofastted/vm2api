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
 *   onImport(vm, slotDir)       an imported credential replaces the slot's copy
 *   afterRefresh(vm, slotDir)   the slot rotated its credential; mirror it back
 *   touch(vm, slotDir)          telemetry activity mark
 *
 * Functions are wrapped, not referenced: this module sits in an import cycle
 * with vm-runtime / the kernel supervisor, so bindings are read at call time.
 */

import { localDocker } from '../cluster/docker-remote.mjs'
import { clusterManager, SLOT_CAPS_NODE, vmNodeId } from '../cluster/placement.mjs'
import {
  pullSlotCredentials,
  pushSlotCredentials,
  pushSlotFiles,
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
  inspectEgressProcess,
  isLocalEgressProxy,
  localEgressProxyUrl,
  stopEgressProcess,
} from './egress.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { nodeEgressProxyUrl } from '../cluster/node-egress-socks.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { stopCodexKernel } from '../transport/codex-kernel-supervisor.mjs'

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
    if (enabled) return ensureProxyEgress(projectRoot, vm.proxy)
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
    syncRun: (vm, slotDir) => pushSlotFiles(vm, slotDir, ['run']),
    queueSyncRun: (vm, slotDir) => queueSlotPush(vm, slotDir, ['run']),
    onImport: (vm, slotDir) => pushSlotCredentials(vm, slotDir),
    afterRefresh: (vm, slotDir) => pullSlotCredentials(vm, slotDir),
    touch: (vm, slotDir) => pushTelemetryTouch(vm, slotDir),
  }
}

export function slotHost(vm) {
  const nodeId = vmNodeId(vm)
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
