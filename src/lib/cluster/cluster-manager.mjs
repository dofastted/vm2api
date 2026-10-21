/**
 * Cluster control plane: every stored node gets a supervised SshLink, a local
 * docker bridge socket and a periodic health check. The HTTP routes and the
 * terminal WebSocket go through this object only.
 */

import crypto from 'node:crypto'
import { getDb, withTransaction } from '../db/database.mjs'
import { isKubernetesMode } from '../core/control-plane-mode.mjs'
import { OneTimeAuthRepo } from '../db/repos/one-time-auth-repo.mjs'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { DOCKER_SOCKET_PATH, dockerInfo, dockerPing, sshDocker } from './docker-remote.mjs'
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
  forwardOutStreamLocal,
  privateKeyProblem,
  SshLink,
} from './ssh-link.mjs'

export const HEALTH_INTERVAL_MS = 30_000
export const SHELL_TICKET_TTL_MS = 30_000
export const LOCAL_STATUS_TTL_MS = 30_000
// A failed gate dial sends that node's slot traffic over SSH until the next good health ping or this long.
export const DIRECT_LINK_BACKOFF_MS = 30_000
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
    authState = null,
    gateBin = process.env.KIN_CLUSTER_GATE_BIN || path.join(process.cwd(), 'bin', 'kin-slot-gate'),
  }) {
    this.gateBin = gateBin
    this.directState = new Map()
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
    this.nodes = new Map()
    this.platforms = new Map()
    this.directLinksState = new Map()
    // Unix sockets need a native filesystem; WSL drvfs (/mnt/<drive>) refuses them.
    this.socketDir = socketDir || path.join(dataDir, 'cluster')
    this.vmsOnNode = vmsOnNode
    this.logger = logger
    this.links = new Map()
    this.bridges = new Map()
    this.slotRelays = new Map()
    this.hosts = new WeakMap()
    // Last host facts per node, readable synchronously (slot paths in kernel.json) while the link is down.
    this.hostFacts = new Map()
    this.health = new Map()
    this.installs = new Map()
    this.tickets = new Map()
    this.authState = isKubernetesMode() ? authState || new OneTimeAuthRepo(repo.db || getDb()) : null
    this._healthTimer = null
  }

  async reload() {
    const nodes = await this.repo.list()
    const directLinks = this.repo.directLinks ? await this.repo.directLinks() : new Map()
    const platforms = await Promise.all(
      nodes.map(async (node) => [node.id, this.repo.platform ? await this.repo.platform(node.id) : 'linux']),
    )
    this.nodes = new Map(nodes.map((node) => [node.id, node]))
    this.directLinksState = directLinks
    this.platforms = new Map(platforms)
  }

  async rebind(db) {
    await this.stop()
    this.repo = new this.repo.constructor(db)
    await this.start()
    await this.restoreSlotRelays()
  }

  async start() {
    await this.reload()
    for (const node of this.nodes.values()) this._attach(node)
    this._healthTimer = setInterval(() => {
      for (const id of this.links.keys()) this._checkHealth(id)
    }, HEALTH_INTERVAL_MS)
    this._healthTimer.unref?.()
  }

  async stop() {
    clearInterval(this._healthTimer)
    this._healthTimer = null
    for (const link of this.links.values()) link.stop()
    const relays = [...this.bridges.values(), ...[...this.slotRelays.values()].flatMap((r) => [r.kernel, r.worker])]
    await Promise.all(relays.map((r) => r.stop().catch(() => {})))
    this.links.clear()
    this.bridges.clear()
    this.slotRelays.clear()
  }

  bridgeSocketPath(id) {
    return path.join(this.socketDir, id, 'docker.sock')
  }

  _attach(node) {
    const link = new SshLink({ id: node.id, resolveTarget: () => this._targetFor(node.id) })
    link.on('state', (state) => {
      this.logger.log(JSON.stringify({ event: 'cluster-link', node: node.id, state, error: link.error?.code || null }))
      if (state === 'ready') {
        // Host facts first: they carry the platform the health check branches on.
        Promise.resolve(this.remoteHost(node.id))
          .catch(() => {})
          .then(() => this._checkHealth(node.id))
          .catch(() => {})
          .finally(() => this._linkState(node.id, state))
        this._ensureGate(node.id).catch(() => {})
      } else {
        this.health.delete(node.id)
        this._linkState(node.id, state)
      }
    })
    this.links.set(node.id, link)
    const bridge = new SocketRelay({
      socketPath: this.bridgeSocketPath(node.id),
      remotePath: DOCKER_SOCKET_PATH,
      getClient: () => (link.state === 'ready' ? link.client : null),
      logger: this.logger,
    })
    this.bridges.set(node.id, bridge)
    bridge.start().catch((err) => this.logger.warn(`[cluster] bridge ${node.id} failed: ${err.message}`))
    link.start()
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
    const node = this.nodes.get(id)
    const secrets = await this.repo.getSecrets(id)
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

  async _checkHealth(id) {
    const link = this.links.get(id)
    const client = link?.state === 'ready' ? link.client : null
    if (!client) return
    // One channel-open round trip = SSH RTT; a refusal (no docker.sock) is still a server reply.
    const t0 = performance.now()
    let latencyMs = null
    try {
      const probe = await forwardOutStreamLocal(client, DOCKER_SOCKET_PATH)
      latencyMs = performance.now() - t0
      probe.close()
    } catch (err) {
      if (err.code === 'streamlocal_failed') latencyMs = performance.now() - t0
    }
    const platform = this.nodePlatform(id)
    const hostRead = execCollect(client, nodeHostCommand(platform), { timeoutMs: NODE_HOST_TIMEOUT_MS }).catch(
      () => null,
    )
    const directRead = this._probeDirect(id)
    let docker
    let containers = null
    if (platform === 'darwin') {
      docker = { ok: false, error: NATIVE_NO_DOCKER, native: true }
    } else {
      try {
        const info = await dockerInfo(sshDocker(client))
        docker = { ok: true, error: null }
        containers = { total: info.containers, running: info.running }
      } catch (err) {
        docker = { ok: false, error: err.message }
      }
    }
    await directRead
    const hostOut = await hostRead
    const host = hostOut?.code === 0 ? parseNodeHost(hostOut.stdout) : null
    if (link.client !== client) return
    if (docker.ok && !configuredIpv6Enabled()) {
      const exits = await syncIpv6ProxyEgress(null, null, { nodeId: id, vms: this.vmsOnNode(id) })
      for (const exit of exits.filter((item) => !item.ok)) {
        this.logger.warn('[ipv6-policy] exit not blocked', exit.vm_id, exit.error)
      }
    }
    this.health.set(id, {
      latency_ms: latencyMs == null ? null : Math.round(latencyMs),
      docker,
      containers,
      host,
      checked_at: new Date().toISOString(),
    })
  }

  _view(node, directLinks = this.directLinksState) {
    const link = this.links.get(node.id)
    return {
      ...node,
      platform: this.nodePlatform(node.id),
      link: link ? { ...link.snapshot(), host_key: link.hostKey } : { state: 'idle' },
      health: this.health.get(node.id) || null,
      bridge: this.bridges.get(node.id)?.snapshot() || null,
      install: this.installs.get(node.id) || null,
      direct_link: this._directView(node.id, directLinks.get(node.id)),
    }
  }

  list() {
    const directLinks = this.directLinksState
    return [...this.nodes.values()].map((node) => this._view(node, directLinks))
  }

  get(id) {
    const node = this.nodes.get(id)
    if (!node) throw new ClusterError(404, 'node_not_found', '节点不存在')
    return this._view(node)
  }

  _directView(id, cfg) {
    if (!cfg) return null
    const st = this.directState.get(id) || {}
    const fallback = (st.downUntil || 0) > Date.now()
    return {
      address: cfg.address,
      port: cfg.port,
      state: st.checked_at ? (fallback || st.error ? 'down' : 'ok') : 'pending',
      latency_ms: st.latency_ms ?? null,
      error: st.error || null,
      gate_error: st.gate_error || null,
      checked_at: st.checked_at || null,
    }
  }

  _directPatch(id, patch) {
    this.directState.set(id, { ...(this.directState.get(id) || {}), ...patch })
  }

  /** Ping the gate; a good answer lifts the SSH fallback early, a bad one starts it. */
  async _probeDirect(id) {
    const cfg = await this.repo.getDirectLink(id)
    if (!cfg?.certSha256) return
    const checked_at = new Date().toISOString()
    try {
      const ms = await pingGate(cfg)
      this._directPatch(id, { latency_ms: Math.round(ms), error: null, downUntil: 0, checked_at })
    } catch (err) {
      this._directPatch(id, {
        latency_ms: null,
        error: err.code || 'gate_unreachable',
        downUntil: Date.now() + DIRECT_LINK_BACKOFF_MS,
        checked_at,
      })
    }
  }

  /**
   * One slot connection over the direct link (`{ sock, ready }`), or null for
   * the SSH path: no link, no pinned certificate yet, in backoff, or the dial
   * failed before anything was sent. A refusal after that (bad token) starts
   * the backoff too; a missing slot socket does not, it is not a link fault.
   */
  async _dialDirect(nodeId, vmId, kind) {
    const cfg = await this.repo.getDirectLink(nodeId)
    if (!cfg?.certSha256) return null
    if ((this.directState.get(nodeId)?.downUntil || 0) > Date.now()) return null
    const down = (err) => {
      this._directPatch(nodeId, { error: err.code, downUntil: Date.now() + DIRECT_LINK_BACKOFF_MS })
      this.logger.warn(`[cluster] direct link ${nodeId} unavailable (${err.code}), using ssh`)
    }
    try {
      const conn = await dialGate({ ...cfg, vmId, kind })
      conn.ready.catch((err) => {
        if (err.code !== 'gate_no_socket') down(err)
      })
      return conn
    } catch (err) {
      down(err)
      return null
    }
  }

  async _ensureGate(id, { strict = false } = {}) {
    if (this.nodePlatform(id) === 'darwin') return
    const cfg = await this.repo.getDirectLink(id)
    const link = this.links.get(id)
    if (!cfg || link?.state !== 'ready' || !link.client) return
    const client = link.client
    try {
      const host = await this.remoteHost(id)
      const result = await ensureNodeGate({ client, host, docker: sshDocker(client) }, cfg, this.gateBin)
      if (result.certSha256 !== cfg.certSha256) {
        await this.repo.setDirectLinkCert(id, result.certSha256)
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
    if (!this.nodes.get(id)) throw new ClusterError(404, 'node_not_found', '节点不存在')
    this.assertLinuxNode(id, '直连通道')
    const { address, port } = parseDirectLinkInput(body)
    const token = (await this.repo.getDirectLink(id))?.token || newGateToken()
    await this.repo.setDirectLink(id, { address, port, token })
    this.directLinksState = await this.repo.directLinks()
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
    if (!this.nodes.get(id)) throw new ClusterError(404, 'node_not_found', '节点不存在')
    await this.repo.clearDirectLink(id)
    this.directLinksState.delete(id)
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
        existing_id: await this.repo.findByEndpoint(spec.host, spec.port, spec.username),
      }
    } finally {
      client.end()
    }
  }

  async add(input) {
    const spec = parseNodeInput(input, { requireHostKey: true })
    if (spec.jump_node_id && !this.nodes.get(spec.jump_node_id)) {
      throw new ClusterError(400, 'invalid_jump', '跳板节点不存在')
    }
    if (await this.repo.findByEndpoint(spec.host, spec.port, spec.username)) {
      throw new ClusterError(409, 'node_exists', '该主机与用户已接入')
    }
    const node = await this.repo.insert({
      ...spec,
      id: `node-${crypto.randomBytes(4).toString('hex')}`,
      host_key_alg: spec.host_key_alg || 'unknown',
    })
    this.nodes.set(node.id, node)
    this.platforms.set(node.id, 'linux')
    this._attach(node)
    this._nodesChanged()
    return this._view(node)
  }

  async _prepareEdit(id, input) {
    const node = this.nodes.get(id)
    if (!node) throw new ClusterError(404, 'node_not_found', '节点不存在')
    validateNodeEditPatch(node, input)
    const labelOnly = Object.keys(input).every((key) => key === 'label' || key === 'expected_updated_at')
    if (labelOnly) {
      const label = Object.hasOwn(input, 'label') ? input.label.trim() || node.host : node.label
      if (label.length > 64) throw new ClusterError(400, 'invalid_label', '备注过长')
      return { id, node, spec: { label }, connectionEdit: false, labelOnly: true, vms: this.vmsOnNode(id) }
    }
    const next = mergeNodeEdit(node, await this.repo.getSecrets(id), input)
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
    await this._assertEditCurrent(edit)
    return edit
  }

  async _assertEditCurrent(edit) {
    const current = await this.repo.get(edit.id)
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
    if ((await this.repo.dependentsOf(edit.id)).length) {
      throw new ClusterError(409, 'node_in_use', '仍有节点经由它跳转，暂不支持修改该节点的连接配置')
    }
    const duplicate = await this.repo.findByEndpoint(edit.spec.host, edit.spec.port, edit.spec.username)
    if (duplicate && duplicate !== edit.id) throw new ClusterError(409, 'node_exists', '该主机与用户已接入')
    if (this.installs.get(edit.id)?.status === 'running')
      throw new ClusterError(409, 'node_busy', '节点正在安装 Docker，请稍后重试')
    this.assertNodeEditable(edit.id)
  }

  async _probeEdit(edit) {
    let previousHost = null
    if (edit.vms.length && edit.client && edit.link.state === 'ready') previousHost = await this.remoteHost(edit.id)
    await this._assertEditCurrent(edit)
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
      await this._assertEditCurrent(edit)
      if (!candidate.live()) throw nodeEditConflict()
      return { ...candidate, host, docker }
    } catch (err) {
      candidate.cleanup()
      result.client.end()
      throw err
    }
  }

  async probeUpdate(id, input) {
    const edit = await this._prepareEdit(id, input)
    if (!edit.connectionEdit) {
      return {
        host_key: { alg: edit.node.host_key_alg, sha256: edit.node.host_key_sha256 },
        docker: this.health.get(id)?.docker || { ok: false, error: '未探测' },
        platform: this.nodePlatform(id),
        vm_count: edit.vms.length,
        dependent_count: (await this.repo.dependentsOf(id)).length,
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
    const edit = await this._prepareEdit(id, input)
    const candidate = edit.connectionEdit ? await this._probeEdit(edit) : null
    let adopted = false
    let committed = false
    let adoptedGeneration
    try {
      const saved = await withTransaction(this.repo.db, async () => {
        await this._assertEditCurrent(edit)
        const saved = edit.labelOnly
          ? await this.repo.updateLabel(id, edit.spec.label, edit.node.updated_at)
          : await this.repo.update(id, edit.spec, edit.node.updated_at)
        if (!saved) throw nodeEditConflict()
        if (candidate && this.authState) await this.authState.revokeShell('node', id)
        if (candidate) {
          // Reconnect and placement may change while PostgreSQL executes the CAS.
          // Keep this final check and adoption synchronous; a rejection rolls back the CAS.
          if (
            !candidate.live() ||
            this.links.get(id) !== edit.link ||
            edit.link.generation !== edit.generation ||
            edit.link.client !== edit.client ||
            nodePlacementVersion(this.vmsOnNode(id)) !== edit.placementVersion
          )
            throw nodeEditConflict()
          if (!edit.link.adopt(candidate, edit.generation)) throw nodeEditConflict()
          candidate.cleanup()
          adopted = true
          adoptedGeneration = edit.link.generation
        }
        return saved
      })
      committed = true
      this.nodes.set(id, saved)
      if (candidate) {
        if (edit.link.generation !== adoptedGeneration || edit.link.client !== candidate.client) {
          // A reconnect during COMMIT must resolve its target from the committed record.
          edit.link.reconnect()
        } else if (candidate.host) {
          this.hosts.set(candidate.client, Promise.resolve(candidate.host))
          await this._learnHost(id, candidate.host)
        }
        for (const [ticket, entry] of this.tickets) if (entry.nodeId === id) this.tickets.delete(ticket)
      }
      return this._view(saved)
    } catch (error) {
      if (adopted && !committed) {
        const persisted = await this.repo.get(id).catch(() => null)
        if (persisted) this.nodes.set(id, persisted)
        else this.nodes.delete(id)
        edit.link.reconnect()
      }
      if (error.code === '23505') throw new ClusterError(409, 'node_exists', '该主机与用户已接入')
      throw error
    } finally {
      if (candidate && (!adopted || !committed)) {
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
    if (!this.nodes.get(id)) throw new ClusterError(404, 'node_not_found', '节点不存在')
    const dependents = await this.repo.dependentsOf(id)
    if (dependents.length) {
      throw new ClusterError(409, 'node_in_use', `仍有节点经由它跳转：${dependents.join(', ')}`)
    }
    const placed = this.vmsOnNode(id).map((vm) => vm.id)
    if (placed.length) {
      throw new ClusterError(409, 'node_has_vms', `节点上仍有虚拟机：${placed.join(', ')}，先删除它们`)
    }
    await this.repo.remove(id)
    this.links.get(id)?.stop()
    this.links.delete(id)
    await this.bridges.get(id)?.stop()
    this.bridges.delete(id)
    this.health.delete(id)
    this.installs.delete(id)
    this.directState.delete(id)
    this.hostFacts.delete(id)
    this.nodes.delete(id)
    this.platforms.delete(id)
    this.directLinksState.delete(id)
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

  /** True while the node's SSH link is up; the scheduler skips slots of a node that is not. */
  linkReady(id) {
    return this.links.get(id)?.state === 'ready'
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
      .then(async (host) => {
        await this._learnHost(id, host)
        return host
      })
      .catch((error) => {
        this.hosts.delete(client)
        throw error
      })
    this.hosts.set(client, pending)
    return pending
  }

  async _learnHost(id, host) {
    try {
      if (!this.nodes.get(id)) return
      this.hostFacts.set(id, host)
      if (host.platform && this.nodePlatform(id) !== host.platform) {
        await this.repo.setPlatform(id, host.platform)
        this.platforms.set(id, host.platform)
        this.logger.log(JSON.stringify({ event: 'cluster-node-platform', node: id, platform: host.platform }))
      }
    } catch (err) {
      this.logger.warn(`[cluster] record platform of ${id}: ${err.message}`)
    }
  }

  /** 'linux' | 'darwin'. Unknown or unreadable (older schema) is Linux: the Docker runtime is the default. */
  nodePlatform(id) {
    try {
      return this.platforms.get(id) === 'darwin' ? 'darwin' : 'linux'
    } catch {
      return 'linux'
    }
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
   * transport dials these; each connection opens one streamlocal channel on the link.
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
    for (const node of [...this.nodes.values()]) {
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
    for (const node of [...this.nodes.values()]) {
      if (node.jump_node_id) continue
      const link = this.links.get(node.id)
      if (link?.state === 'ready' && link.client) return { node, client: link.client }
    }
    return null
  }

  issueShellTicket(id) {
    this.client(id)
    if (this.authState) return this.authState.issueShell('node', id, { ttlMs: SHELL_TICKET_TTL_MS })
    const now = Date.now()
    for (const [t, v] of this.tickets) if (v.exp <= now) this.tickets.delete(t)
    const ticket = crypto.randomBytes(24).toString('base64url')
    this.tickets.set(ticket, { nodeId: id, exp: now + SHELL_TICKET_TTL_MS })
    return { ticket, expires_in: SHELL_TICKET_TTL_MS / 1000 }
  }

  /** Shared tickets reject a wrong resource without consuming the grant. */
  consumeShellTicket(ticket, id) {
    if (this.authState) return this.authState.consumeShell('node', ticket, id).then(Boolean)
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
