/**
 * Cluster control plane: every stored node gets a supervised SshLink, a local
 * docker bridge socket and a periodic health check. The HTTP routes and the
 * terminal WebSocket go through this object only.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { DOCKER_SOCKET_PATH, dockerInfo, dockerPing, sshDocker } from './docker-remote.mjs'
import { collectLocalStatus } from './local-status.mjs'
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
const INSTALL_LOG_MAX = 64 * 1024

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
  }) {
    this.listen = listen
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
    this.bridges = new Map()
    this.slotRelays = new Map()
    this.hosts = new WeakMap()
    this.health = new Map()
    this.installs = new Map()
    this.tickets = new Map()
    this._healthTimer = null
  }

  start() {
    for (const node of this.repo.list()) this._attach(node)
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
      if (state === 'ready') this._checkHealth(node.id)
      else this.health.delete(node.id)
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
    let docker
    let containers = null
    try {
      const info = await dockerInfo(sshDocker(client))
      docker = { ok: true, error: null }
      containers = { total: info.containers, running: info.running }
    } catch (err) {
      docker = { ok: false, error: err.message }
    }
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
      checked_at: new Date().toISOString(),
    })
  }

  _view(node) {
    const link = this.links.get(node.id)
    return {
      ...node,
      link: link ? { ...link.snapshot(), host_key: link.hostKey } : { state: 'idle' },
      health: this.health.get(node.id) || null,
      bridge: this.bridges.get(node.id)?.snapshot() || null,
      install: this.installs.get(node.id) || null,
    }
  }

  list() {
    return this.repo.list().map((node) => this._view(node))
  }

  get(id) {
    const node = this.repo.get(id)
    if (!node) throw new ClusterError(404, 'node_not_found', '节点不存在')
    return this._view(node)
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
      return {
        host_key: hostKey,
        docker,
        uname: uname?.code === 0 ? uname.stdout.trim() : null,
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
    return this._view(node)
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
    this.repo.remove(id)
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
    return sshDocker(this.client(id))
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
    const script =
      'id -u; id -g; printf "%s\\n" "$HOME"; if sudo -n true 2>/dev/null; then echo sudo; else echo nosudo; fi'
    const pending = execCollect(client, `sh -c ${shellQuote(script)}`, { timeoutMs: 15_000 }).then((r) => {
      const [uid, gid, home, sudo] = r.stdout.split('\n').map((s) => s.trim())
      if (r.code !== 0 || !/^\d+$/.test(uid) || !/^\d+$/.test(gid) || !home.startsWith('/')) {
        throw new ClusterError(502, 'remote_host_unknown', `读取节点用户信息失败：${(r.stderr || r.stdout).trim()}`)
      }
      return {
        uid: Number(uid),
        gid: Number(gid),
        home,
        root: `${home.replace(/\/+$/, '')}/.vm2api`,
        sudo: sudo === 'sudo',
      }
    })
    pending.catch(() => this.hosts.delete(client))
    this.hosts.set(client, pending)
    return pending
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
      kernel: new SocketRelay({ socketPath: paths.kernel, remotePath: remote('kernel.sock'), getClient }),
      worker: new SocketRelay({ socketPath: paths.worker, remotePath: remote('worker.sock'), getClient }),
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
