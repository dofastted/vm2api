/**
 * Cluster control plane: every stored node gets a supervised SshLink, a local
 * docker bridge socket and a periodic health check. The HTTP routes and the
 * terminal WebSocket go through this object only.
 */

import { hostMemoryPressureOf } from './host-memory-pressure.mjs'
import { deferUntilExclusive } from '../core/handover.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import {
  DOCKER_SOCKET_PATH,
  dockerInfo,
  dockerPing,
  localDocker,
  sshDocker,
  withDockerDeadline,
} from './docker-remote.mjs'
import { collectLocalStatus } from './local-status.mjs'
import {
  mergeNodeEdit,
  nodeEditConflict,
  nodePlacementVersion,
  nodePlatformOf,
  readNodeHost,
  validateNodeEditPatch,
  verifyNodeRuntimes,
} from './node-edit.mjs'
import { NODE_HOST_TIMEOUT_MS, nodeHostCommand, parseNodeHost } from './node-host.mjs'
import {
  dialGate,
  GATE_DIAL_TIMEOUT_MS,
  ensureNodeGate,
  newGateToken,
  parseDirectLinkInput,
  pingGate,
  removeNodeGate,
} from './direct-link.mjs'
import { shellQuote } from './remote-fs.mjs'
import { SocketRelay } from './socket-relay.mjs'
import { configuredIpv6Enabled } from '../vm/proxy-policy.mjs'
import { syncIpv6ProxyEgress } from '../vm/proxy-policy-runtime.mjs'
import {
  ClusterError,
  connectSsh,
  execCollect,
  forwardOut,
  connectUnixSocket,
  unixTransportOf,
  privateKeyProblem,
  READY_TIMEOUT_MS,
  SshLink,
} from './ssh-link.mjs'

export const HEALTH_INTERVAL_MS = 30_000
// Two missed cycles: a snapshot this old says nothing about the node right now.
export const HEALTH_STALE_MS = 2 * HEALTH_INTERVAL_MS
// One check must finish inside its own cycle, channel opens and queueing included.
export const HEALTH_DEADLINE_MS = 25_000
// Outlasts one SSH handshake, so a slow node settles before it is called gone.
export const NODE_GONE_CHECK_MS = READY_TIMEOUT_MS + 5_000
export const SHELL_TICKET_TTL_MS = 30_000
export const LOCAL_STATUS_TTL_MS = 30_000
// A failed gate dial sends that node's slot traffic over SSH until the next good health ping or this long.
export const DIRECT_LINK_BACKOFF_MS = 30_000
const DIRECT_PROBE_INTERVAL_MS = 5_000
const DIRECT_PROBE_FRESH_MS = 2 * DIRECT_PROBE_INTERVAL_MS + GATE_DIAL_TIMEOUT_MS
const INSTALL_LOG_MAX = 64 * 1024
const NATIVE_NO_DOCKER = 'macOS 原生节点不使用 Docker'

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const USERNAME_RE = /^[a-z_][a-z0-9_.-]{0,63}$/i

// Installs Docker from get.docker.com when missing, then lets the SSH user reach
// docker.sock. Root runs directly; others need passwordless sudo (cloud images default).
const INSTALL_SCRIPT = [
  'set -e',
  'if [ "$(id -u)" = 0 ]; then S=""; else S="sudo -n"; fi',
  'if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | $S sh; fi',
  '$S systemctl enable --now docker',
  'if [ "$(id -u)" != 0 ]; then $S usermod -aG docker "$(id -un)"; fi',
  'docker --version || $S docker --version',
].join('\n')

/**
 * Normalize + validate the join form. `requireHostKey` for create (probe result pinned).
 */
export function parseNodeInput(input = {}, { requireHostKey = false } = {}) {
  const host = String(input.host || '').trim()
  if (!(net.isIP(host) || HOSTNAME_RE.test(host))) throw new ClusterError(400, 'invalid_host', '主机地址不合法')
  const port = input.port == null || input.port === '' ? 22 : Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ClusterError(400, 'invalid_port', '端口不合法')
  const username = String(input.username || '').trim()
  if (!USERNAME_RE.test(username)) throw new ClusterError(400, 'invalid_username', '用户名不合法')
  const label = String(input.label || '').trim() || host
  if (label.length > 64) throw new ClusterError(400, 'invalid_label', '备注过长')
  const authType = input.auth_type === 'password' ? 'password' : 'key'
  const password = authType === 'password' ? String(input.password || '') : null
  const privateKey = authType === 'key' ? String(input.private_key || '').trim() : null
  const passphrase = authType === 'key' && input.passphrase ? String(input.passphrase) : null
  if (authType === 'password' && !password) throw new ClusterError(400, 'missing_password', '请填写密码')
  if (authType === 'key') {
    if (!privateKey) throw new ClusterError(400, 'missing_private_key', '请粘贴私钥')
    if (privateKey.length > 32 * 1024) throw new ClusterError(400, 'invalid_private_key', '私钥过大')
    const problem = privateKeyProblem(privateKey, passphrase)
    if (problem) throw new ClusterError(400, 'invalid_private_key', `私钥无法解析：${problem}`)
  }
  const jumpNodeId = input.jump_node_id ? String(input.jump_node_id) : null
  const hostKeySha256 = input.host_key_sha256 ? String(input.host_key_sha256) : null
  if (requireHostKey && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKeySha256 || '')) {
    throw new ClusterError(400, 'missing_host_key', '缺少已确认的主机指纹，请先探测')
  }
  return {
    host,
    port,
    username,
    label,
    auth_type: authType,
    password,
    private_key: privateKey,
    passphrase,
    jump_node_id: jumpNodeId,
    host_key_sha256: hostKeySha256,
    host_key_alg: input.host_key_alg ? String(input.host_key_alg).slice(0, 64) : null,
  }
}

export class ClusterManager {
  /**
   * @param {{ repo: import('../db/repos/cluster-nodes-repo.mjs').ClusterNodesRepo, dataDir: string, socketDir?: string, vmsOnNode?: (nodeId: string) => { id: string }[], logger?: Console }} opts
   */
  constructor({
    repo,
    dataDir,
    listen = { host: null, port: null },
    containerName = process.env.VM2API_CONTAINER_NAME,
    socketDir = process.env.VM2API_CLUSTER_SOCKET_DIR,
    vmsOnNode = () => [],
    logger = console,
    onNodesChanged = null,
    onLinkState = null,
    assertNodeEditable = () => {},
    gateBin = process.env.KIN_CLUSTER_GATE_BIN || path.join(process.cwd(), 'bin', 'kin-slot-gate'),
  }) {
    this.gateBin = gateBin
    this.directState = new Map()
    this.directProbes = new Map()
    this.listen = listen
    // Node add / remove: per-node resources (each VPS's local egress row) follow the list.
    this.onNodesChanged = onNodesChanged
    // Link settled (ready after its health check, or failed): per-node consumers refresh.
    this.onLinkState = onLinkState
    this.assertNodeEditable = assertNodeEditable
    this.containerName = containerName
    this._local = null
    this._localAt = 0
    this._localInflight = null
    this.repo = repo
    // Unix sockets need a native filesystem; WSL drvfs (/mnt/<drive>) refuses them.
    this.socketDir = socketDir || path.join(dataDir, 'cluster')
    this.vmsOnNode = vmsOnNode
    this.logger = logger
    this.links = new Map()
    /** Blue/green standby: SSH links dialled before activation, adopted by _attach. */
    this.prewarmed = new Map()
    this.bridges = new Map()
    this.slotRelays = new Map()
    this.hosts = new WeakMap()
    // Last host facts per node, readable synchronously (slot paths in kernel.json) while the link is down.
    this.hostFacts = new Map()
    this.health = new Map()
    this.installs = new Map()
    this.tickets = new Map()
    this._healthTimer = null
    this._directTimer = null
  }

  start() {
    for (const node of this.repo.list()) this._attach(node)
    this._healthTimer = setInterval(() => {
      for (const id of this.links.keys()) this._checkHealth(id)
    }, HEALTH_INTERVAL_MS)
    this._healthTimer.unref?.()
    const probeDirectLinks = () => {
      for (const id of this.repo.directLinks().keys()) {
        this._probeDirect(id).catch((err) => this.logger.warn(`[cluster] direct probe ${id}: ${err.code || 'failed'}`))
      }
    }
    probeDirectLinks()
    this._directTimer = setInterval(probeDirectLinks, DIRECT_PROBE_INTERVAL_MS)
    this._directTimer.unref?.()
  }

  async stop({ unlink = true } = {}) {
    clearInterval(this._healthTimer)
    this._healthTimer = null
    clearInterval(this._directTimer)
    this._directTimer = null
    this.directProbes.clear()
    this.directState.clear()
    for (const link of this.links.values()) link.stop()
    for (const link of this.prewarmed.values()) link.stop()
    this.prewarmed.clear()
    const relays = [...this.bridges.values(), ...[...this.slotRelays.values()].flatMap((r) => [r.kernel, r.worker])]
    await Promise.all(relays.map((r) => r.stop({ unlink }).catch(() => {})))
    this.links.clear()
    this.bridges.clear()
    this.slotRelays.clear()
  }

  bridgeSocketPath(id) {
    return path.join(this.socketDir, id, 'docker.sock')
  }

  /**
   * Blue/green standby: dial the node SSH links ahead of activation. Without this every node slot reads
   * "node not connected" for the ~10s the links take after activation, and the first requests after the
   * switch wait in scheduling. Only the links: no relays, gates, health checks, timers or state writes.
   */
  prewarmLinks() {
    for (const node of this.repo.list()) {
      if (this.links.has(node.id) || this.prewarmed.has(node.id)) continue
      const link = new SshLink({ id: node.id, resolveTarget: () => this._targetFor(node.id) })
      this.prewarmed.set(node.id, link)
      link.start()
    }
  }

  /** Resolves once every pre-dialled link is ready, or at the timeout: `{ ready, total }`. */
  async prewarmReady({ timeoutMs = 20_000, pollMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs
    const count = () => {
      const links = [...this.prewarmed.values(), ...this.links.values()]
      return { ready: links.filter((link) => link.state === 'ready').length, total: links.length }
    }
    for (;;) {
      const now = count()
      if (now.ready === now.total || Date.now() >= deadline) return now
      await new Promise((resolve) => setTimeout(resolve, pollMs).unref?.())
    }
  }

  _attach(node) {
    const warm = this.prewarmed.get(node.id)
    this.prewarmed.delete(node.id)
    const link = warm || new SshLink({ id: node.id, resolveTarget: () => this._targetFor(node.id) })
    let sshWasReady = false
    const onState = (state) => {
      this.logger.log(JSON.stringify({ event: 'cluster-link', node: node.id, state, error: link.error?.code || null }))
      if (state === 'ready') {
        // Host facts first: they carry the platform the health check branches on.
        Promise.resolve(this.remoteHost(node.id))
          .catch(() => {})
          .then(() => this._checkHealth(node.id))
          .catch(() => {})
          .finally(() => this._linkState(node.id, state))
        if (!sshWasReady || !this._directHealthy(node.id)) this._ensureGate(node.id).catch(() => {})
        sshWasReady = true
      } else {
        this.health.delete(node.id)
        this._linkState(node.id, state)
      }
    }
    link.on('state', onState)
    this.links.set(node.id, link)
    const bridge = new SocketRelay({
      socketPath: this.bridgeSocketPath(node.id),
      remotePath: DOCKER_SOCKET_PATH,
      docker: true,
      getClient: () => (link.state === 'ready' ? link.client : null),
      logger: this.logger,
    })
    this.bridges.set(node.id, bridge)
    bridge.start().catch((err) => this.logger.warn(`[cluster] bridge ${node.id} failed: ${err.message}`))
    if (!warm) link.start()
    // A pre-dialled link may already be up: replay its state so health, gate and link state run now.
    else if (link.state !== 'idle') onState(link.state)
  }

  async _jumpSock(jumpNodeId, host, port) {
    if (!jumpNodeId) return null
    const jump = this.links.get(jumpNodeId)
    if (!jump) throw new ClusterError(400, 'invalid_jump', '跳板节点不存在')
    if (jump.state !== 'ready' || !jump.client) {
      throw new ClusterError(503, 'jump_not_ready', '跳板节点未连接')
    }
    return forwardOut(jump.client, host, port)
  }

  async _targetFor(id) {
    const node = this.repo.get(id)
    const secrets = this.repo.getSecrets(id)
    if (!node || !secrets) throw new ClusterError(404, 'node_not_found', '节点不存在')
    return {
      host: node.host,
      port: node.port,
      username: node.username,
      authType: node.auth_type,
      password: secrets.password,
      privateKey: secrets.privateKey,
      passphrase: secrets.passphrase,
      expectedSha256: node.host_key_sha256,
      sock: await this._jumpSock(node.jump_node_id, node.host, node.port),
    }
  }

  /** At most one check per node in flight; overlapping callers share it. */
  _checkHealth(id) {
    this._healthRuns ??= new Map()
    const running = this._healthRuns.get(id)
    if (running) return running
    const run = this._runHealth(id).finally(() => {
      if (this._healthRuns.get(id) === run) this._healthRuns.delete(id)
    })
    this._healthRuns.set(id, run)
    return run
  }

  async _runHealth(id) {
    const link = this.links.get(id)
    const client = link?.state === 'ready' ? link.client : null
    if (!client) return
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), HEALTH_DEADLINE_MS)
    deadline.unref?.()
    try {
      await this._collectHealth(id, link, client, abort.signal)
    } finally {
      clearTimeout(deadline)
      abort.abort()
    }
  }

  async _collectHealth(id, link, client, signal) {
    // One channel-open round trip = SSH RTT; a refusal (no docker.sock) is still a server reply.
    const t0 = performance.now()
    const remaining = () => Math.max(1, HEALTH_DEADLINE_MS - (performance.now() - t0))
    let latencyMs = null
    try {
      const probe = await connectUnixSocket(client, DOCKER_SOCKET_PATH, { docker: true, signal })
      latencyMs = performance.now() - t0
      probe.destroy() // drains too: an undrained channel never gives its bridge slot back
    } catch (err) {
      if (err.code === 'streamlocal_failed') latencyMs = performance.now() - t0
    }
    const platform = this.nodePlatform(id)
    const hostRead = execCollect(client, nodeHostCommand(platform), {
      timeoutMs: Math.min(NODE_HOST_TIMEOUT_MS, remaining()),
    }).catch(() => null)
    let docker
    let containers = null
    if (platform === 'darwin') {
      docker = { ok: false, error: NATIVE_NO_DOCKER, native: true }
    } else {
      docker = await this._dockerHealth(id, client, signal, remaining)
      containers = docker.containers ?? null
      delete docker.containers
    }
    const hostOut = await hostRead
    const host = hostOut?.code === 0 ? parseNodeHost(hostOut.stdout) : null
    // A result from a connection that has since been replaced must not overwrite the new one.
    if (link.client !== client) return
    this.health.set(id, {
      latency_ms: latencyMs == null ? null : Math.round(latencyMs),
      docker,
      containers,
      host,
      checked_at: new Date().toISOString(),
    })
    if (docker.ok && !configuredIpv6Enabled()) {
      // Off the snapshot path: a slow egress sync must not hold back the node's health.
      syncIpv6ProxyEgress(null, null, { nodeId: id, vms: this.vmsOnNode(id) })
        .then((exits) => {
          for (const exit of exits.filter((item) => !item.ok)) {
            this.logger.warn('[ipv6-policy] exit not blocked', exit.vm_id, exit.error)
          }
        })
        .catch((err) => this.logger.warn('[ipv6-policy] sync failed', id, err?.message || err))
    }
  }

  /**
   * Docker is healthy only when both paths answer: the management API (SSH channel) and the
   * local relay socket the docker CLI — and so every slot worker call — actually dials.
   */
  async _dockerHealth(id, client, signal, remaining) {
    let info
    try {
      info = await withDockerDeadline(sshDocker(client, { signal }), (connect) => dockerInfo(connect), remaining())
    } catch (err) {
      return { ok: false, error: err.message, stage: 'api', code: err.code || null }
    }
    const containers = { total: info.containers, running: info.running }
    const bridge = this.bridges?.get(id)
    if (bridge) {
      try {
        if (!bridge.alive())
          throw new ClusterError(502, 'relay_not_listening', bridge.error || '本地 Docker 中继未监听')
        await withDockerDeadline(localDocker(this.bridgeSocketPath(id)), (connect) => dockerPing(connect), remaining())
      } catch (err) {
        return {
          ok: false,
          error: `Docker CLI 中继不可用：${err.message}`,
          stage: 'relay',
          code: err.code || null,
          containers,
        }
      }
    }
    return { ok: true, error: null, transport: unixTransportOf(client), containers }
  }

  /** Snapshot as served: an old success no longer vouches for the node. */
  _healthView(id) {
    const health = this.health.get(id)
    if (!health) return null
    const age = Date.now() - Date.parse(health.checked_at)
    if (!(age > HEALTH_STALE_MS) || !health.docker?.ok) return health
    const at = new Date(health.checked_at).toLocaleTimeString('zh-CN', { hour12: false })
    return {
      ...health,
      stale: true,
      docker: { ...health.docker, ok: false, error: `健康检查已过期（上次成功 ${at}）`, stale: true },
    }
  }

  _view(node, directLinks = this.repo.directLinks()) {
    const link = this.links.get(node.id)
    return {
      ...node,
      platform: this.nodePlatform(node.id),
      link: link ? { ...link.snapshot(), host_key: link.hostKey } : { state: 'idle' },
      health: this._healthView(node.id),
      memory_pressure: hostMemoryPressureOf(node.id),
      bridge: this.bridges.get(node.id)?.snapshot() || null,
      install: this.installs.get(node.id) || null,
      direct_link: this._directView(node.id, directLinks.get(node.id)),
    }
  }

  list() {
    const directLinks = this.repo.directLinks()
    return this.repo.list().map((node) => this._view(node, directLinks))
  }

  get(id) {
    const node = this.repo.get(id)
    if (!node) throw new ClusterError(404, 'node_not_found', '节点不存在')
    return this._view(node)
  }

  _directView(id, cfg) {
    if (!cfg) return null
    const st = this.directState.get(id) || {}
    return {
      address: cfg.address,
      port: cfg.port,
      state: st.error ? 'down' : this._directHealthy(id) ? 'ok' : 'pending',
      latency_ms: st.latency_ms ?? null,
      error: st.error || null,
      gate_error: st.gate_error || null,
      checked_at: st.checked_at || null,
    }
  }

  _directPatch(id, patch) {
    this.directState.set(id, { ...(this.directState.get(id) || {}), ...patch })
  }

  _directHealthy(id) {
    const state = this.directState.get(id)
    return !!state?.checked_at && !state.error && Date.now() - Date.parse(state.checked_at) < DIRECT_PROBE_FRESH_MS
  }

  _directConfigMatches(id, config) {
    const current = this.repo.getDirectLink(id)
    return (
      current?.address === config.address &&
      current.port === config.port &&
      current.token === config.token &&
      current.certSha256 === config.certSha256
    )
  }

  /** Ping the gate; a good answer lifts the SSH fallback early, a bad one starts it. */
  async _probeDirect(id) {
    const pending = this.directProbes.get(id)
    if (pending) return pending
    const cfg = this.repo.getDirectLink(id)
    if (!cfg?.certSha256) return
    const probe = pingGate(cfg)
      .then(
        (ms) => ({ latency_ms: Math.round(ms), error: null, downUntil: 0 }),
        (err) => ({
          latency_ms: null,
          error: err.code || 'gate_unreachable',
          downUntil: Date.now() + DIRECT_LINK_BACKOFF_MS,
        }),
      )
      .then((patch) => {
        if (this.directProbes.get(id) === probe && this._directConfigMatches(id, cfg)) {
          this._directPatch(id, { ...patch, checked_at: new Date().toISOString() })
        }
      })
      .finally(() => {
        if (this.directProbes.get(id) === probe) this.directProbes.delete(id)
      })
    this.directProbes.set(id, probe)
    return probe
  }

  /**
   * One slot connection over the direct link (`{ sock, ready }`), or null for
   * the SSH path: no link, no pinned certificate yet, in backoff, or the dial
   * failed before anything was sent. A refusal after that (bad token) starts
   * the backoff too; a missing slot socket does not, it is not a link fault.
   */
  async _dialDirect(nodeId, vmId, kind) {
    if (this.links.get(nodeId)?.state === 'error') return null
    const cfg = this.repo.getDirectLink(nodeId)
    if (!cfg?.certSha256) return null
    if ((this.directState.get(nodeId)?.downUntil || 0) > Date.now()) return null
    const link = this.links.get(nodeId)
    const down = (err) => {
      if (this.links.get(nodeId) !== link || link?.state === 'idle' || !this._directConfigMatches(nodeId, cfg)) return
      this._directPatch(nodeId, { error: err.code, downUntil: Date.now() + DIRECT_LINK_BACKOFF_MS })
      this.logger.warn(`[cluster] direct link ${nodeId} unavailable (${err.code}), using ssh`)
    }
    try {
      const conn = await dialGate({ ...cfg, vmId, kind })
      const ready = conn.ready.then(
        (sock) => {
          if (
            this.links.get(nodeId) !== link ||
            link?.state === 'idle' ||
            link?.state === 'error' ||
            !this._directConfigMatches(nodeId, cfg)
          ) {
            sock.destroy()
            throw new ClusterError(503, 'gate_changed', '节点直连链路已变化')
          }
          return sock
        },
        (err) => {
          if (err.code !== 'gate_no_socket') down(err)
          throw err
        },
      )
      ready.catch(() => {})
      return { sock: conn.sock, ready }
    } catch (err) {
      down(err)
      return null
    }
  }

  /** Re-check every connected node's gate (after a deploy refreshed bin/kin-slot-gate). */
  async refreshGates() {
    for (const id of [...this.links.keys()]) await this._ensureGate(id).catch(() => {})
  }

  async _ensureGate(id, { strict = false } = {}) {
    if (this.nodePlatform(id) === 'darwin') return
    const cfg = this.repo.getDirectLink(id)
    const link = this.links.get(id)
    if (!cfg || link?.state !== 'ready' || !link.client) return
    const client = link.client
    try {
      const host = await this.remoteHost(id)
      const result = await ensureNodeGate({ client, host, docker: sshDocker(client) }, cfg, this.gateBin)
      if (link.client !== client || !this._directConfigMatches(id, cfg)) return
      if (result.deferred) deferUntilExclusive(`gate:${id}`, () => this._ensureGate(id))
      if (result.certSha256 !== cfg.certSha256) {
        this.repo.setDirectLinkCert(id, result.certSha256)
        this.directProbes.delete(id)
        this.directState.delete(id)
        this.logger.log(`[cluster] slot gate on ${id}: pinned certificate ${result.certSha256.slice(0, 16)}…`)
      }
      this._directPatch(id, { gate_error: null })
      if (result.changed) this.logger.log(`[cluster] slot gate on ${id} (re)created from ${result.image}`)
    } catch (err) {
      this._directPatch(id, { gate_error: err.message })
      this.logger.warn(`[cluster] slot gate on ${id}: ${err.message}`)
      if (strict) throw err
    }
  }

  /** Enable or move the direct link. Token and certificate pin are kept across edits and never returned. */
  async setDirectLink(id, body) {
    if (!this.repo.get(id)) throw new ClusterError(404, 'node_not_found', '节点不存在')
    this.assertLinuxNode(id, '直连通道')
    const { address, port } = parseDirectLinkInput(body)
    const token = this.repo.getDirectLink(id)?.token || newGateToken()
    this.repo.setDirectLink(id, { address, port, token })
    this.directProbes.delete(id)
    this.directState.delete(id)
    await this._ensureGate(id).catch(() => {})
    // The gate needs a moment to bind after a (re)create.
    for (let i = 0; i < 5; i += 1) {
      await this._probeDirect(id)
      if (!this.directState.get(id)?.error) break
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return this.get(id)
  }

  async clearDirectLink(id) {
    if (!this.repo.get(id)) throw new ClusterError(404, 'node_not_found', '节点不存在')
    this.repo.clearDirectLink(id)
    this.directProbes.delete(id)
    this.directState.delete(id)
    const link = this.links.get(id)
    if (link?.state === 'ready' && link.client) {
      const client = link.client
      await removeNodeGate({ client, host: await this.remoteHost(id), docker: sshDocker(client) }).catch((err) =>
        this.logger.warn(`[cluster] remove slot gate on ${id}: ${err.message}`),
      )
    }
    return this.get(id)
  }

  /** Connect once with the form's credentials, report host key + docker reachability, disconnect. */
  async probe(input) {
    const spec = parseNodeInput(input)
    const sock = await this._jumpSock(spec.jump_node_id, spec.host, spec.port)
    const { client, hostKey } = await connectSsh({
      host: spec.host,
      port: spec.port,
      username: spec.username,
      authType: spec.auth_type,
      password: spec.password,
      privateKey: spec.private_key,
      passphrase: spec.passphrase,
      sock,
    })
    try {
      let docker
      try {
        await dockerPing(sshDocker(client))
        docker = { ok: true, error: null }
      } catch (err) {
        docker = { ok: false, error: err.message }
      }
      const uname = await execCollect(client, 'uname -srm', { timeoutMs: 10_000 }).catch(() => null)
      const unameText = uname?.code === 0 ? uname.stdout.trim() : null
      return {
        host_key: hostKey,
        docker,
        uname: unameText,
        platform: nodePlatformOf(unameText?.split(/\s+/)[0]),
        existing_id: this.repo.findByEndpoint(spec.host, spec.port, spec.username),
      }
    } finally {
      client.end()
    }
  }

  add(input) {
    const spec = parseNodeInput(input, { requireHostKey: true })
    if (spec.jump_node_id && !this.repo.get(spec.jump_node_id)) {
      throw new ClusterError(400, 'invalid_jump', '跳板节点不存在')
    }
    if (this.repo.findByEndpoint(spec.host, spec.port, spec.username)) {
      throw new ClusterError(409, 'node_exists', '该主机与用户已接入')
    }
    const node = this.repo.insert({
      ...spec,
      id: `node-${crypto.randomBytes(4).toString('hex')}`,
      host_key_alg: spec.host_key_alg || 'unknown',
    })
    this._attach(node)
    this._nodesChanged()
    return this._view(node)
  }

  _prepareEdit(id, input) {
    const node = this.repo.get(id)
    if (!node) throw new ClusterError(404, 'node_not_found', '节点不存在')
    validateNodeEditPatch(node, input)
    const labelOnly = Object.keys(input).every((key) => key === 'label' || key === 'expected_updated_at')
    if (labelOnly) {
      const label = Object.hasOwn(input, 'label') ? input.label.trim() || node.host : node.label
      if (label.length > 64) throw new ClusterError(400, 'invalid_label', '备注过长')
      return { id, node, spec: { label }, connectionEdit: false, labelOnly: true, vms: this.vmsOnNode(id) }
    }
    const next = mergeNodeEdit(node, this.repo.getSecrets(id), input)
    const spec = parseNodeInput(next, { requireHostKey: true })
    const link = this.links.get(id)
    const vms = this.vmsOnNode(id)
    const edit = {
      id,
      node,
      spec,
      // Explicit connection edits must authenticate, even if normalization yields the saved values.
      connectionEdit: true,
      link,
      generation: link?.generation,
      client: link?.client,
      vms,
      placementVersion: nodePlacementVersion(vms),
    }
    this._assertEditCurrent(edit)
    return edit
  }

  _assertEditCurrent(edit) {
    const current = this.repo.get(edit.id)
    if (!current) throw new ClusterError(404, 'node_not_found', '节点不存在')
    if (current.updated_at !== edit.node.updated_at) throw nodeEditConflict()
    if (!edit.connectionEdit) return
    if (
      !edit.link ||
      this.links.get(edit.id) !== edit.link ||
      edit.link.generation !== edit.generation ||
      edit.link.client !== edit.client
    )
      throw nodeEditConflict()
    if (nodePlacementVersion(this.vmsOnNode(edit.id)) !== edit.placementVersion) throw nodeEditConflict()
    if (edit.vms.length && edit.spec.username !== edit.node.username) {
      throw new ClusterError(409, 'node_username_in_use', '节点上仍有虚拟机，不能更换 SSH 用户；请先迁移或删除虚拟机')
    }
    if (this.repo.dependentsOf(edit.id).length) {
      throw new ClusterError(409, 'node_in_use', '仍有节点经由它跳转，暂不支持修改该节点的连接配置')
    }
    const duplicate = this.repo.findByEndpoint(edit.spec.host, edit.spec.port, edit.spec.username)
    if (duplicate && duplicate !== edit.id) throw new ClusterError(409, 'node_exists', '该主机与用户已接入')
    if (this.installs.get(edit.id)?.status === 'running')
      throw new ClusterError(409, 'node_busy', '节点正在安装 Docker，请稍后重试')
    this.assertNodeEditable(edit.id)
  }

  async _probeEdit(edit) {
    let previousHost = null
    if (edit.vms.length && edit.client && edit.link.state === 'ready') previousHost = await this.remoteHost(edit.id)
    this._assertEditCurrent(edit)
    const sock = await this._jumpSock(edit.spec.jump_node_id, edit.spec.host, edit.spec.port)
    const result = await connectSsh({
      host: edit.spec.host,
      port: edit.spec.port,
      username: edit.spec.username,
      authType: edit.spec.auth_type,
      password: edit.spec.password,
      privateKey: edit.spec.private_key,
      passphrase: edit.spec.passphrase,
      expectedSha256: edit.node.host_key_sha256,
      sock,
    })
    let closed = false
    const lost = () => {
      closed = true
    }
    result.client.once('close', lost)
    result.client.once('error', lost)
    const candidate = {
      ...result,
      live: () => !closed,
      cleanup: () => {
        result.client.off('close', lost)
        result.client.off('error', lost)
      },
    }
    try {
      let docker
      try {
        await dockerPing(sshDocker(result.client))
        docker = { ok: true, error: null }
      } catch {
        docker = { ok: false, error: 'Docker socket 不可用，请检查 SSH 用户权限与 Docker 服务' }
      }
      let host = null
      if (edit.vms.length) {
        host = await readNodeHost(result.client)
        if (!docker.ok && host.platform !== 'darwin')
          throw new ClusterError(409, 'node_runtime_mismatch', '新连接无法访问 Docker，不能确认现有虚拟机')
        await verifyNodeRuntimes(result.client, host, edit.vms, previousHost)
      } else {
        host = await readNodeHost(result.client).catch(() => null)
      }
      this._assertEditCurrent(edit)
      if (!candidate.live()) throw nodeEditConflict()
      return { ...candidate, host, docker }
    } catch (err) {
      candidate.cleanup()
      result.client.end()
      throw err
    }
  }

  async probeUpdate(id, input) {
    const edit = this._prepareEdit(id, input)
    if (!edit.connectionEdit) {
      return {
        host_key: { alg: edit.node.host_key_alg, sha256: edit.node.host_key_sha256 },
        docker: this.health.get(id)?.docker || { ok: false, error: '未探测' },
        platform: this.nodePlatform(id),
        vm_count: edit.vms.length,
        dependent_count: this.repo.dependentsOf(id).length,
      }
    }
    const candidate = await this._probeEdit(edit)
    try {
      return {
        host_key: candidate.hostKey,
        docker: candidate.docker,
        platform: candidate.host?.platform || this.nodePlatform(id),
        vm_count: edit.vms.length,
        dependent_count: 0,
      }
    } finally {
      candidate.cleanup()
      candidate.client.end()
    }
  }

  async update(id, input) {
    const edit = this._prepareEdit(id, input)
    const candidate = edit.connectionEdit ? await this._probeEdit(edit) : null
    let adopted = false
    try {
      this._assertEditCurrent(edit)
      if (candidate && !candidate.live()) throw nodeEditConflict()
      let saved
      try {
        saved = edit.labelOnly
          ? this.repo.updateLabel(id, edit.spec.label, edit.node.updated_at)
          : this.repo.update(id, edit.spec, edit.node.updated_at)
      } catch (err) {
        if (String(err.message).includes('UNIQUE constraint failed: cluster_nodes.')) {
          throw new ClusterError(409, 'node_exists', '该主机与用户已接入')
        }
        throw err
      }
      if (!saved) throw nodeEditConflict()
      if (candidate) {
        // No await between the final version check, SQLite CAS and adoption. Existing relay closures retain this link.
        candidate.cleanup()
        edit.link.adopt(candidate, edit.generation)
        adopted = true
        if (candidate.host) {
          this.hosts.set(candidate.client, Promise.resolve(candidate.host))
          this._learnHost(id, candidate.host)
        }
        for (const [ticket, entry] of this.tickets) if (entry.nodeId === id) this.tickets.delete(ticket)
      }
      return this._view(saved)
    } finally {
      if (candidate && !adopted) {
        candidate.cleanup()
        candidate.client.end()
      }
    }
  }

  _linkState(id, state) {
    try {
      this.onLinkState?.(id, state)
    } catch (err) {
      this.logger.warn(`[cluster] link-state hook failed: ${err.message}`)
    }
  }

  _nodesChanged() {
    try {
      this.onNodesChanged?.()
    } catch (err) {
      this.logger.warn(`[cluster] nodes-changed hook failed: ${err.message}`)
    }
  }

  async remove(id) {
    if (!this.repo.get(id)) throw new ClusterError(404, 'node_not_found', '节点不存在')
    const dependents = this.repo.dependentsOf(id)
    if (dependents.length) {
      throw new ClusterError(409, 'node_in_use', `仍有节点经由它跳转：${dependents.join(', ')}`)
    }
    const placed = this.vmsOnNode(id).map((vm) => vm.id)
    if (placed.length) {
      throw new ClusterError(409, 'node_has_vms', `节点上仍有虚拟机：${placed.join(', ')}，先删除它们`)
    }
    this.links.get(id)?.stop()
    this.links.delete(id)
    await this.bridges.get(id)?.stop()
    this.bridges.delete(id)
    this.health.delete(id)
    this.installs.delete(id)
    this.directProbes.delete(id)
    this.directState.delete(id)
    this.hostFacts.delete(id)
    this.repo.remove(id)
    this._nodesChanged()
  }

  reconnect(id) {
    const link = this.links.get(id)
    if (!link) throw new ClusterError(404, 'node_not_found', '节点不存在')
    link.reconnect()
    return this.get(id)
  }

  /** Ready SSH client or 409; callers never queue work behind a reconnect. */
  client(id) {
    const link = this.links.get(id)
    if (!link) throw new ClusterError(404, 'node_not_found', '节点不存在')
    if (link.state !== 'ready' || !link.client) {
      throw new ClusterError(409, 'node_not_ready', `节点未连接（${link.state}）`)
    }
    return link.client
  }

  docker(id) {
    this.assertLinuxNode(id, 'Docker 操作')
    return sshDocker(this.client(id))
  }

  /** True while the management link is up. */
  linkReady(id) {
    return this.links.get(id)?.state === 'ready'
  }

  slotDataPath(nodeId, vmId) {
    const state = this.links.get(nodeId)?.state
    if (state === 'ready') return 'ssh'
    const relays = this.slotRelays.get(vmId)
    if (
      (state === 'backoff' || state === 'connecting') &&
      relays?.nodeId === nodeId &&
      relays.kernel.alive() &&
      this._directHealthy(nodeId)
    )
      return 'direct'
    return 'offline'
  }

  /**
   * SSH user facts for slot placement, cached per live SSH client (a
   * reconnect after `usermod -aG docker` or a key change re-reads them).
   * `root` is where remote slot trees live: $HOME/.vm2api.
   */
  remoteHost(id) {
    const client = this.client(id)
    const cached = this.hosts.get(client)
    if (cached) return cached
    const pending = readNodeHost(client)
    pending.then(
      (host) => this._learnHost(id, host),
      () => this.hosts.delete(client),
    )
    this.hosts.set(client, pending)
    return pending
  }

  _learnHost(id, host) {
    try {
      if (!this.repo.get(id)) return
      this.hostFacts.set(id, host)
      if (host.platform && this.nodePlatform(id) !== host.platform) {
        this.repo.setPlatform(id, host.platform)
        this.logger.log(JSON.stringify({ event: 'cluster-node-platform', node: id, platform: host.platform }))
      }
    } catch (err) {
      this.logger.warn(`[cluster] record platform of ${id}: ${err.message}`)
    }
  }

  /** 'linux' | 'darwin'. Unknown or unreadable (older schema) is Linux: the Docker runtime is the default. */
  nodePlatform(id) {
    try {
      return this.repo.platform(id) === 'darwin' ? 'darwin' : 'linux'
    } catch {
      return 'linux'
    }
  }

  /** Memory figures from the node's last health probe: { total, available, at } bytes, or null. */
  nodeHostMemory(id) {
    const health = this.health.get(id)
    const total = Number(health?.host?.mem_total)
    const used = Number(health?.host?.mem_used)
    if (!(total > 0) || !Number.isFinite(used)) return null
    return { total, available: Math.max(0, total - used), at: Date.parse(health.checked_at) || Date.now() }
  }

  /** Host facts of the last SSH session (uid, root, platform), or null before the first connect. */
  nodeHostFacts(id) {
    return this.hostFacts.get(id) || null
  }

  assertLinuxNode(id, what) {
    if (this.nodePlatform(id) === 'darwin') {
      throw new ClusterError(409, 'native_node_unsupported', `macOS 原生节点不支持${what}`)
    }
  }

  slotRelayPaths(nodeId, vmId) {
    const dir = path.join(this.socketDir, nodeId, 'slots', vmId)
    return { kernel: path.join(dir, 'kernel.sock'), worker: path.join(dir, 'worker.sock') }
  }

  /**
   * Local unix sockets for a remote slot's kernel.sock / worker.sock. The unchanged
   * transport dials these; each connection uses the gate or one SSH channel.
   */
  async ensureSlotRelays(nodeId, vmId) {
    const current = this.slotRelays.get(vmId)
    if (current?.nodeId === nodeId) {
      await current.ready
      return current.paths
    }
    if (current) await this.dropSlotRelays(vmId)
    const link = this.links.get(nodeId)
    if (!link) throw new ClusterError(404, 'node_not_found', '节点不存在')
    const paths = this.slotRelayPaths(nodeId, vmId)
    const getClient = () => (link.state === 'ready' ? link.client : null)
    const remote = (name) => async () => `${(await this.remoteHost(nodeId)).root}/vms/${vmId}/run/${name}`
    const entry = {
      nodeId,
      paths,
      kernel: new SocketRelay({
        socketPath: paths.kernel,
        remotePath: remote('kernel.sock'),
        getClient,
        dialDirect: () => this._dialDirect(nodeId, vmId, 'kernel'),
      }),
      worker: new SocketRelay({
        socketPath: paths.worker,
        remotePath: remote('worker.sock'),
        getClient,
        dialDirect: () => this._dialDirect(nodeId, vmId, 'worker'),
      }),
    }
    entry.ready = Promise.all([entry.kernel.start(), entry.worker.start()])
    this.slotRelays.set(vmId, entry)
    try {
      await entry.ready
    } catch (err) {
      if (this.slotRelays.get(vmId) === entry) this.slotRelays.delete(vmId)
      throw err
    }
    return paths
  }

  async dropSlotRelays(vmId) {
    const entry = this.slotRelays.get(vmId)
    if (!entry) return
    this.slotRelays.delete(vmId)
    await Promise.all([entry.kernel.stop(), entry.worker.stop()])
    fs.rmSync(path.dirname(entry.paths.kernel), { recursive: true, force: true })
  }

  /** Link, node docker bridge and this slot's relays, for diagnosis. Never connects. */
  slotBridgeStatus(nodeId, vmId) {
    const link = this.links.get(nodeId)
    const relays = this.slotRelays.get(vmId)
    return {
      link: link ? link.snapshot() : null,
      data_path: this.slotDataPath(nodeId, vmId),
      bridge: this.bridges.get(nodeId)?.snapshot() || null,
      relays: relays?.nodeId === nodeId ? { kernel: relays.kernel.snapshot(), worker: relays.worker.snapshot() } : null,
    }
  }

  /** Reconnect unless ready or already connecting, then wait for the outcome. Throws node_not_ready. */
  async ensureLinkReady(nodeId, timeoutMs = 20_000) {
    const link = this.links.get(nodeId)
    if (!link) throw new ClusterError(404, 'node_not_found', '节点不存在')
    if (link.state === 'ready' && link.client) return link.snapshot()
    const settled = new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        link.off('state', onState)
        resolve()
      }
      const onState = (state) => {
        if (state === 'ready' || state === 'error' || state === 'backoff') done()
      }
      const timer = setTimeout(done, timeoutMs)
      link.on('state', onState)
    })
    if (link.state !== 'connecting') link.reconnect()
    await settled
    if (link.state !== 'ready' || !link.client) {
      const detail = link.error?.message ? `：${link.error.message}` : ''
      throw new ClusterError(409, 'node_not_ready', `节点未连接（${link.state}）${detail}`)
    }
    return link.snapshot()
  }

  /**
   * Gate for deleting a slot without touching its node: the node record is gone, or a
   * fresh connect attempt failed and no direct link answers. Otherwise 409 node_reachable.
   */
  async confirmNodeUnreachable(id, timeoutMs = NODE_GONE_CHECK_MS) {
    const link = this.links.get(id)
    if (!link || !this.repo.get(id)) return { state: 'missing', error: null }
    if (!this._directHealthy(id)) {
      await this.ensureLinkReady(id, timeoutMs).catch((err) => {
        if (err.code !== 'node_not_ready') throw err
      })
      if (link.state === 'backoff' || link.state === 'error') {
        return { state: link.state, error: link.error?.code || null }
      }
    }
    const message =
      link.state === 'connecting' ? '节点仍在连接中，稍后再试' : '节点仍可连接，请用普通删除清理节点上的容器'
    throw new ClusterError(409, 'node_reachable', message)
  }

  /**
   * Restart the node docker bridge if it died and rebuild this slot's relays if
   * missing or dead. `force` rebuilds the slot relays regardless (operator recovery).
   * Returns which pieces were rebuilt.
   */
  async healSlotBridges(nodeId, vmId, { force = false } = {}) {
    const healed = []
    const bridge = this.bridges.get(nodeId)
    if (bridge && !bridge.alive()) {
      await bridge.restart()
      healed.push('bridge')
    }
    const relays = this.slotRelays.get(vmId)
    const relaysAlive = relays?.nodeId === nodeId && relays.kernel.alive() && relays.worker.alive()
    if (force || !relaysAlive) {
      await this.dropSlotRelays(vmId)
      await this.ensureSlotRelays(nodeId, vmId)
      healed.push('relay')
    }
    return healed
  }

  /** Boot: relays exist before any link is ready so the scheduler's first health dial finds a socket. */
  async restoreSlotRelays() {
    for (const node of this.repo.list()) {
      for (const vm of this.vmsOnNode(node.id)) {
        await this.ensureSlotRelays(node.id, vm.id).catch((err) =>
          this.logger.warn(`[cluster] slot relay ${vm.id} on ${node.id}: ${err.message}`),
        )
      }
    }
  }

  /**
   * Cached 30s: each refresh runs two exec round trips on the observer node.
   * Concurrent callers share one in-flight collection.
   */
  async localStatus({ refresh = false } = {}) {
    const fresh = this._local && Date.now() - this._localAt < LOCAL_STATUS_TTL_MS
    if (fresh && !refresh) return this._local
    if (!this._localInflight) {
      this._localInflight = collectLocalStatus({
        listen: this.listen,
        containerName: this.containerName,
        observer: this._natObserver(),
      })
        .then((status) => {
          this._local = status
          this._localAt = Date.now()
          return status
        })
        .finally(() => {
          this._localInflight = null
        })
    }
    return this._localInflight
  }

  /** A jumped node sees the jump host as SSH_CLIENT, so only direct ready nodes can observe our public address. */
  _natObserver() {
    for (const node of this.repo.list()) {
      if (node.jump_node_id) continue
      const link = this.links.get(node.id)
      if (link?.state === 'ready' && link.client) return { node, client: link.client }
    }
    return null
  }

  issueShellTicket(id) {
    this.client(id)
    const now = Date.now()
    for (const [t, v] of this.tickets) if (v.exp <= now) this.tickets.delete(t)
    const ticket = crypto.randomBytes(24).toString('base64url')
    this.tickets.set(ticket, { nodeId: id, exp: now + SHELL_TICKET_TTL_MS })
    return { ticket, expires_in: SHELL_TICKET_TTL_MS / 1000 }
  }

  /** Single use: the ticket is burned whether or not it matches. */
  consumeShellTicket(ticket, id) {
    const entry = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    return !!entry && entry.nodeId === id && entry.exp > Date.now()
  }

  openShell(id, { cols = 80, rows = 24 } = {}) {
    const client = this.client(id)
    return new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) return reject(new ClusterError(502, 'shell_failed', `打开终端失败：${err.message}`))
        resolve(stream)
      })
    })
  }

  startDockerInstall(id) {
    this.assertLinuxNode(id, '安装 Docker')
    const client = this.client(id)
    const current = this.installs.get(id)
    if (current?.status === 'running') return current
    const job = {
      status: 'running',
      log: '',
      exit_code: null,
      started_at: new Date().toISOString(),
      finished_at: null,
    }
    this.installs.set(id, job)
    const append = (chunk) => {
      job.log = (job.log + chunk.toString('utf8')).slice(-INSTALL_LOG_MAX)
    }
    const finish = (status, code, extra) => {
      job.status = status
      job.exit_code = code
      job.finished_at = new Date().toISOString()
      if (extra) append(`\n${extra}\n`)
      // New docker group membership only applies to a fresh SSH login.
      if (status === 'done') this.links.get(id)?.reconnect()
    }
    client.exec(`sh -c ${shellQuote(INSTALL_SCRIPT)}`, (err, stream) => {
      if (err) return finish('failed', null, `exec 失败：${err.message}`)
      let code = null
      stream.on('data', append)
      stream.stderr.on('data', append)
      stream.on('exit', (exitCode) => {
        code = exitCode
      })
      stream.on('close', () => finish(code === 0 ? 'done' : 'failed', code))
    })
    return job
  }
}
