/**
 * Local unix socket that relays every connection to a unix socket on a
 * cluster node over the node's SSH link (`direct-streamlocal`).
 *
 * Two users:
 *   - docker bridge: <socketDir>/<node>/docker.sock → /var/run/docker.sock, so
 *     the host docker CLI can drive the remote daemon (DOCKER_HOST=unix://…).
 *   - slot relay: <socketDir>/<node>/slots/<vm>/kernel.sock → the remote slot's
 *     run/kernel.sock, so the unchanged unix-socket transport reaches a remote kernel.
 *
 * Unix socket + 0600 only; never a TCP port (a docker relay on TCP would hand
 * root on the VPS to anything that can reach it).
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { connectUnixSocket } from './ssh-link.mjs'

export class SocketRelay {
  /**
   * `remotePath` may be an async function: slot relays resolve the node's HOME
   * on first use, so they can listen at boot before the SSH link is up.
   * `dialDirect` (slot relays on a node with a direct link) returns `{ sock, ready }`
   * from dialGate, or null to use the SSH link.
   * `docker` is set only by the Docker bridge owner; kernel/worker sockets
   * must never be opened through Docker's daemon-only dial-stdio transport.
   * @param {{ socketPath: string, remotePath: string|(() => Promise<string>), getClient: () => import('ssh2').Client|null, docker?: boolean, dialDirect?: () => Promise<{ sock: import('node:net').Socket, ready: Promise<unknown> }|null>, logger?: Pick<Console, 'warn'> }} opts
   */
  constructor({ socketPath, remotePath, getClient, docker = false, dialDirect = null, logger = console }) {
    this.socketPath = socketPath
    this.remotePath = remotePath
    this.getClient = getClient
    this.docker = docker
    this.dialDirect = dialDirect
    this.logger = logger
    this.server = null
    this.listening = false
    this.error = null
    this.active = new Set()
  }

  /** Listening and the socket file still there: a removed file strands every dialer. */
  alive() {
    return this.listening && fs.existsSync(this.socketPath)
  }

  snapshot() {
    return {
      socket_path: this.socketPath,
      listening: this.listening,
      alive: this.alive(),
      error: this.error,
      active: this.active.size,
    }
  }

  async restart() {
    await this.stop()
    this.error = null
    await this.start()
  }

  async start() {
    try {
      await this._listen()
    } catch (err) {
      this.server = null
      this.error =
        err.code === 'ENOTSUP'
          ? `${err.message}（该文件系统不支持 unix socket，设置 VM2API_CLUSTER_SOCKET_DIR）`
          : err.message
      throw err
    }
  }

  async _listen() {
    if (this.server) return
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 })
    fs.rmSync(this.socketPath, { force: true })
    // Half-open: `docker exec`/attach hijack the connection and half-close their write side
    // after stdin EOF, then read output. Auto-ending here drops every byte of that output.
    const server = net.createServer({ allowHalfOpen: true }, (local) => this._relay(local))
    this.server = server
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    fs.chmodSync(this.socketPath, 0o600)
    server.on('error', (err) => this.logger.warn(`[cluster] relay ${this.socketPath}: ${err.message}`))
    this.listening = true
  }

  async _relay(local) {
    this.active.add(local)
    local.once('close', () => this.active.delete(local))
    local.on('error', () => {})
    if (this.dialDirect) {
      const direct = await this.dialDirect().catch(() => null)
      if (direct && (await this._pipeDirect(local, direct))) return
    }
    if (local.destroyed) return
    const client = this.getClient()
    if (!client) {
      local.destroy()
      return
    }
    let remote
    // A dialer that hangs up while we wait for a bridge slot must not get a bridge opened for it.
    const abort = new AbortController()
    const onLocalClose = () => abort.abort()
    local.once('close', onLocalClose)
    try {
      const target = typeof this.remotePath === 'function' ? await this.remotePath() : this.remotePath
      remote = await connectUnixSocket(client, target, { docker: this.docker, long: true, signal: abort.signal })
    } catch {
      // A missing remote socket (kernel restarting) is the normal "not ready" answer;
      // the caller's health poll sees a reset, same as a local ECONNREFUSED.
      local.destroy()
      return
    } finally {
      local.off?.('close', onLocalClose)
    }
    if (local.destroyed) {
      remote.close()
      return
    }
    remote.on('error', () => local.destroy())
    // end(), not destroy(): destroy would drop output still queued behind the pipe.
    remote.on('close', () => local.end())
    local.on('close', () => remote.close())
    local.pipe(remote)
    remote.pipe(local)
  }

  /**
   * A rejected preface is safe to fall back from: no request bytes have crossed the gate.
   */
  async _pipeDirect(local, { sock, ready }) {
    if (local.destroyed) {
      sock.destroy()
      return true
    }
    try {
      await ready
    } catch {
      sock.destroy()
      return false
    }
    if (local.destroyed) {
      sock.destroy()
      return true
    }
    if (sock.destroyed) return false
    local.once('close', () => sock.destroy())
    sock.on('error', () => local.destroy())
    sock.once('close', () => {
      if (!sock.readableEnded) local.destroy()
    })
    // pipe() forwards each half-close as end(); see the half-open note in _listen.
    local.pipe(sock)
    sock.pipe(local)
    return true
  }

  /**
   * unlink:false is for a controller that handed over: the path now belongs to the new leader, and
   * closing a listening unix server also unlinks its path in libuv. So leave the listener to die
   * with the process instead of closing it.
   */
  async stop({ unlink = true } = {}) {
    const server = this.server
    this.server = null
    this.listening = false
    for (const sock of this.active) sock.destroy()
    this.active.clear()
    if (!unlink) {
      server?.unref?.()
      return
    }
    if (server) await new Promise((resolve) => server.close(() => resolve()))
    fs.rmSync(this.socketPath, { force: true })
  }
}
