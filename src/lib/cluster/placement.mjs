/**
 * VM placement on cluster nodes. A VM with `node_id` runs its slot container on
 * that node; everything else about it (vm json, scheduler, kernel transport)
 * stays on the control plane. This module is the only bridge from the slot
 * runtime (src/lib/vm, src/lib/transport) to the ClusterManager, bound once at
 * server start.
 *
 * Node reaches a remote slot three ways, all over the node's one SSH link:
 *   - docker CLI (async spawns only) → DOCKER_HOST=unix://<bridge> → remote docker.sock
 *   - kernel/worker socket → local SocketRelay → remote <root>/vms/<id>/run/*.sock
 *   - slot files → SFTP into <root>/vms/<id> (remote-slot-files.mjs)
 * A synchronous docker CLI call (execFileSync) through the bridge would deadlock:
 * the bridge is served by this same event loop. Remote lifecycle uses the Engine API.
 */

import fs from 'node:fs'
import { Transform } from 'node:stream'
import { slotRuntimeOwner } from '../oauth/oauth-credentials.mjs'
import { routingConfigFile } from '../core/config.mjs'
import { normalizeVmConfig, slotMemory } from '../vm/machine-spec.mjs'
import { runtimeKind } from '../vm/runtime-kind.mjs'
import { buildImage, dockerInfo, imagePresent, sshDocker } from './docker-remote.mjs'
import { runRemote, shellQuote } from './remote-fs.mjs'
import { slotBuildContext, slotImageSpec } from './slot-image.mjs'
import { ClusterError } from './ssh-link.mjs'

const MIN_DISK_KB = 3 * 1024 * 1024
const IMAGE_LOG_MAX = 64 * 1024

let bound = null

export function bindPlacement({ manager, projectRoot, getRouting }) {
  bound = { manager, projectRoot, getRouting }
}

export function unbindPlacement() {
  bound = null
}

export function vmNodeId(vm) {
  const id = vm?.node_id
  return id ? String(id) : null
}

/**
 * What a node slot can do (see vm/slot-host.mjs). Official CC init, setup-token
 * PTY, wrap repair/promote and engine switching drive host-side processes or
 * the host's .kin copy; codex runs its kernel on the host. None apply to a node.
 */
export const SLOT_CAPS_NODE = new Set()

function state() {
  if (!bound) throw new ClusterError(503, 'cluster_unavailable', '集群未初始化')
  return bound
}

export function clusterManager() {
  return state().manager
}

/** Ready SSH client + host facts. 409 node_not_ready / 404 node_not_found from the manager. */
export async function nodeSession(nodeId) {
  const manager = clusterManager()
  const client = manager.client(nodeId)
  const host = await manager.remoteHost(nodeId)
  return { nodeId, client, host, docker: sshDocker(client) }
}

export function remoteSlotDir(host, vmId) {
  return `${host.root}/vms/${vmId}`
}

/**
 * Container user. A non-root SSH user runs the slot as itself so the kernel's
 * 0600 socket is reachable through sshd streamlocal (which connects as that
 * user) and SFTP-written files need no chown. Root keeps per-slot 10000+n.
 */
export function remoteSlotOwner(host, vm) {
  if (host.uid === 0) return slotRuntimeOwner(vm)
  return { uid: host.uid, gid: host.gid }
}

export function parseMemoryBytes(value) {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(String(value || '').trim())
  if (!m) return 0
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()]
  return Math.round(Number(m[1]) * mult)
}

function gib(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

const imageJobs = new Map()
// Completion per running job; kept off the job object because the job is the API payload.
const imageJobDone = new WeakMap()

function imageJobKey(nodeId, kernel, runtime) {
  const kind = runtimeKind({ runtime_type: runtime })
  return kind === 'kvm' ? `${nodeId}:${kernel}:kvm` : `${nodeId}:${kernel}`
}

function placementRouting() {
  if (typeof bound?.getRouting === 'function') {
    try {
      return bound.getRouting()
    } catch {
      /* fall through to the on-disk file */
    }
  }
  const root = bound?.projectRoot
  if (!root) return null
  try {
    return JSON.parse(fs.readFileSync(routingConfigFile(root), 'utf8'))
  } catch {
    return null
  }
}

export function slotImageJob(nodeId, kernel, runtime) {
  return imageJobs.get(imageJobKey(nodeId, kernel, runtime)) || null
}

/** Resolves when the node's running build for `kernel` ends; `{status}` is 'done' or 'failed'. */
export function awaitSlotImageBuild(job) {
  return imageJobDone.get(job) || Promise.resolve(job)
}

/**
 * Build the self-contained slot image on the node. One job per node+kernel;
 * a second call while running returns the running job.
 */
export function startSlotImageBuild(nodeId, kernel, { runtime } = {}) {
  const kind = runtimeKind({ runtime_type: runtime })
  const key = imageJobKey(nodeId, kernel, kind)
  const current = imageJobs.get(key)
  if (current?.status === 'running') return current
  const spec = slotImageSpec(state().projectRoot, kernel, { runtime: kind })
  const client = clusterManager().client(nodeId)
  const job = {
    status: 'running',
    ref: spec.ref,
    kernel,
    log: '',
    started_at: new Date().toISOString(),
    finished_at: null,
  }
  imageJobs.set(key, job)
  const append = (text) => {
    job.log = (job.log + text + (text.endsWith('\n') ? '' : '\n')).slice(-IMAGE_LOG_MAX)
  }
  // Docker prints nothing until the whole context is uploaded; report the upload itself.
  // A Transform, not a 'data' listener: a listener would switch the stream to flowing
  // before dockerRequest pipes it, and every chunk emitted in between is lost.
  let sent = 0
  let reported = 0
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      sent += chunk.length
      if (sent - reported >= 8 << 20) {
        reported = sent
        append(`上传构建上下文 ${(sent / 1024 ** 2).toFixed(0)} MiB`)
      }
      cb(null, chunk)
    },
  })
  append(`构建 ${spec.ref}（基础镜像 ${spec.base}）`)
  const done = buildImage(sshDocker(client), {
    tag: spec.ref,
    context: slotBuildContext(spec).pipe(counter),
    onLog: append,
  })
    .then(() => {
      job.status = 'done'
      append('完成')
    })
    .catch((err) => {
      job.status = 'failed'
      append(`失败：${err.message}`)
    })
    .finally(() => {
      job.finished_at = new Date().toISOString()
    })
    .then(() => job)
  imageJobDone.set(job, done)
  return job
}

/**
 * Can a slot of `kernel` be created on `nodeId` right now? Every check runs
 * against the live node; error-level failures block creation, warn-level ones
 * are shown but do not.
 */
export async function preflightNode(nodeId, { kernel, runtime } = {}) {
  const { manager, projectRoot } = state()
  const kind = runtimeKind({ runtime_type: runtime })
  const routing = placementRouting()
  const memStr = slotMemory(null, routing)
  const checks = []
  const add = (id, ok, level, message) => checks.push({ id, ok, level, message })
  let spec = null
  let specError = null
  try {
    spec = slotImageSpec(projectRoot, kernel, { runtime: kind })
  } catch (err) {
    specError = err
  }
  const image = { ref: spec?.ref || null, present: false, job: slotImageJob(nodeId, kernel, kind) }
  const result = () => ({
    node_id: nodeId,
    ok: !checks.some((c) => !c.ok && c.level === 'error'),
    image,
    checks,
  })

  manager.get(nodeId)
  let client
  try {
    client = manager.client(nodeId)
    add('ssh', true, 'error', 'SSH 已连接')
  } catch (err) {
    add('ssh', false, 'error', err.message)
    return result()
  }
  const docker = sshDocker(client)
  let info = null
  try {
    info = await dockerInfo(docker)
    add('docker', true, 'error', `Docker ${info.version}`)
  } catch (err) {
    add('docker', false, 'error', `Docker 不可用：${err.message}`)
  }
  if (info) {
    const arch = String(info.arch || '')
    add('arch', arch === 'x86_64' || arch === 'amd64', 'error', `架构 ${arch || '未知'}（槽位二进制只有 amd64）`)
    const need = parseMemoryBytes(memStr)
    const total = Number(info.mem_bytes) || 0
    add('memory', total >= need, 'warn', `内存 ${gib(total)}，单槽上限 ${memStr}`)
  }
  if (kind === 'kvm') {
    const allowTcg = normalizeVmConfig(routing?.vm).allow_tcg
    try {
      await runRemote(client, 'test -c /dev/kvm && test -r /dev/kvm && test -w /dev/kvm', { timeoutMs: 10_000 })
      add('kvm', true, 'error', '节点 /dev/kvm 可用')
    } catch {
      add(
        'kvm',
        false,
        allowTcg ? 'warn' : 'error',
        allowTcg ? '节点无 /dev/kvm，将使用 TCG 软件模拟' : '节点没有可用的 /dev/kvm',
      )
    }
  }
  let host = null
  try {
    host = await manager.remoteHost(nodeId)
    const vmsDir = `${host.root}/vms`
    // Slot trees hold credentials and tokens: nobody but the SSH user may list them.
    const root = shellQuote(host.root)
    const vms = shellQuote(vmsDir)
    await runRemote(client, `umask 077 && mkdir -p ${vms} && chmod 700 ${root} ${vms} && test -w ${vms}`, {
      timeoutMs: 15_000,
    })
    add('hostd', true, 'error', `槽位目录 ${vmsDir}`)
  } catch (err) {
    add('hostd', false, 'error', `槽位目录不可写：${err.message}`)
  }
  if (host) {
    const dirs = [host.root, info?.root_dir].filter(Boolean)
    try {
      const out = await runRemote(
        client,
        dirs.map((d) => `df -Pk ${shellQuote(d)} | awk 'NR==2{print $4}'`).join('; '),
        {
          timeoutMs: 15_000,
        },
      )
      const free = Math.min(...out.split(/\s+/).filter(Boolean).map(Number))
      add('disk', free >= MIN_DISK_KB, 'warn', `可用磁盘 ${gib(free * 1024)}`)
    } catch (err) {
      add('disk', false, 'warn', `无法读取磁盘：${err.message}`)
    }
    add(
      'sudo',
      host.uid === 0 || host.sudo,
      'warn',
      host.uid === 0 || host.sudo
        ? 'iptables 可用（root / 免密 sudo）'
        : 'SOCKS5 出口需要 root 或免密 sudo 写 iptables',
    )
    try {
      const kb = Number(await runRemote(client, `awk '/^SwapTotal:/{print $2}' /proc/meminfo`, { timeoutMs: 10_000 }))
      // Slots may swap up to their RAM cap; without host swap a small node fits few slots.
      add('swap', kb * 1024 >= parseMemoryBytes(memStr), 'warn', kb ? `Swap ${gib(kb * 1024)}` : '未开启 Swap')
    } catch (err) {
      add('swap', false, 'warn', `无法读取 Swap：${err.message}`)
    }
  }
  if (specError) {
    add('image', false, 'error', specError.message)
  } else if (info) {
    try {
      image.present = await imagePresent(docker, spec.ref)
      add('image', image.present, 'error', image.present ? `镜像 ${spec.ref} 已就绪` : `镜像 ${spec.ref} 未构建`)
    } catch (err) {
      add('image', false, 'error', err.message)
    }
  }
  return result()
}
