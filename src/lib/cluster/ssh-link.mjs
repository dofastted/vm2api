/**
 * One long-lived SSH connection to a cluster node.
 *
 * States: idle → connecting → ready; a drop from ready goes to backoff and
 * retries with capped exponential delay. Host-key mismatch and auth failure go
 * to `error` and stay there until an operator reconnects: retrying would keep
 * feeding credentials to a possibly impersonated host or trip sshd lockouts.
 *
 * Host-key digest and keepalive handling follow Tabby's `SSHSession`
 * (`tabby-ssh/src/session/ssh.ts` verifyHostKey / keepalive options).
 */

import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import ssh2 from 'ssh2'
import { createAuthHandler } from './ssh-auth.mjs'

const { Client, utils: sshUtils } = ssh2

// Lives here, not in docker-remote.mjs, which imports this module: the default below
// and the Docker connector must never drift apart.
export const DOCKER_SOCKET_PATH = '/var/run/docker.sock'
export const KEEPALIVE_INTERVAL_MS = 10_000
export const KEEPALIVE_COUNT_MAX = 3
export const READY_TIMEOUT_MS = 20_000
export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_MAX_MS = 60_000

export class ClusterError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** OpenSSH-style `SHA256:<base64 without padding>` digest of a raw host key blob. */
export function hostKeyDigest(keyBlob) {
  return `SHA256:${crypto.createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`
}

export function hostKeyAlgorithm(keyBlob) {
  const parsed = sshUtils.parseKey(keyBlob)
  if (parsed instanceof Error) return 'unknown'
  return (Array.isArray(parsed) ? parsed[0] : parsed).type || 'unknown'
}

/** Delay before retry `attempt` (0-based), ±20% jitter so nodes behind one NAT don't reconnect in lockstep. */
export function backoffDelayMs(attempt, rand = Math.random()) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt))
  return Math.round(base * (0.8 + 0.4 * rand))
}

/** Validate a private key the way ssh2 will read it; returns an error message or null. */
export function privateKeyProblem(privateKey, passphrase) {
  const parsed = sshUtils.parseKey(privateKey, passphrase || undefined)
  if (parsed instanceof Error) return parsed.message
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (!key?.isPrivateKey?.()) return 'not a private key'
  return null
}

/**
 * Open and authenticate one SSH connection.
 * `expectedSha256` null = probe mode: accept and report the host key.
 * @returns {Promise<{ client: import('ssh2').Client, hostKey: { alg: string, sha256: string } }>}
 */
export function connectSsh({
  host,
  port,
  username,
  authType,
  password,
  privateKey,
  passphrase,
  expectedSha256 = null,
  sock = null,
  readyTimeoutMs = READY_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let hostKey = null
    let mismatch = false
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      client.end()
      reject(err)
    }
    client.once('ready', () => {
      if (settled) return
      settled = true
      resolve({ client, hostKey })
    })
    client.on('error', (err) => {
      if (mismatch) {
        return fail(
          new ClusterError(409, 'host_key_mismatch', `主机指纹不符：期望 ${expectedSha256}，实际 ${hostKey?.sha256}`),
        )
      }
      if (err?.level === 'client-authentication') {
        return fail(new ClusterError(401, 'auth_failed', `SSH 认证失败（${username}@${host}）`))
      }
      if (err?.level === 'client-timeout') {
        return fail(new ClusterError(504, 'ssh_timeout', `SSH 握手超时（${host}:${port}）`))
      }
      fail(new ClusterError(502, 'ssh_connect_failed', `SSH 连接失败：${err?.message || err}`))
    })
    client.once('close', () => fail(new ClusterError(502, 'ssh_closed', 'SSH 连接在就绪前关闭')))

    client.connect({
      host,
      port,
      username,
      ...(sock ? { sock } : {}),
      readyTimeout: readyTimeoutMs,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      hostVerifier: (keyBlob) => {
        hostKey = { alg: hostKeyAlgorithm(keyBlob), sha256: hostKeyDigest(keyBlob) }
        if (expectedSha256 && hostKey.sha256 !== expectedSha256) {
          mismatch = true
          return false
        }
        return true
      },
      authHandler: createAuthHandler({ username, authType, password, privateKey, passphrase }),
    })
  })
}

export function forwardOut(client, host, port) {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
      if (err) return reject(new ClusterError(502, 'jump_forward_failed', `跳板转发失败：${err.message}`))
      resolve(stream)
    })
  })
}

// RFC 4254 §5.1 open-failure codes. ssh2 hands them over as numbers; names keep logs readable.
const OPEN_FAILURE_REASONS = {
  1: 'ADMINISTRATIVELY_PROHIBITED',
  2: 'CONNECT_FAILED',
  3: 'UNKNOWN_CHANNEL_TYPE',
  4: 'RESOURCE_SHORTAGE',
}

export function openFailureReason(reason) {
  if (typeof reason === 'string' && Object.values(OPEN_FAILURE_REASONS).includes(reason)) return reason
  return OPEN_FAILURE_REASONS[reason] || null
}

export function forwardOutStreamLocal(client, socketPath) {
  return new Promise((resolve, reject) => {
    client.openssh_forwardOutStreamLocal(socketPath, (err, stream) => {
      if (err) {
        const failure = new ClusterError(502, 'streamlocal_failed', `打开远端 ${socketPath} 失败：${err.message}`)
        failure.reason = openFailureReason(err.reason)
        return reject(failure)
      }
      resolve(stream)
    })
  })
}

// link -> Map("docker|generic:<socketPath>" -> transport). A bridge that works for one
// socket says nothing about another (permissions differ, and dial-stdio only reaches
// Docker's own socket), so memory is per purpose and per path.
const unixTransport = new WeakMap()

const shQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`
const transportKey = (socketPath, docker) => `${docker ? 'docker' : 'generic'}:${socketPath}`

function rememberTransport(client, key, name) {
  let byKey = unixTransport.get(client)
  if (!byKey) unixTransport.set(client, (byKey = new Map()))
  byKey.set(key, name)
}

/**
 * Open a stream to a unix socket on the node. Prefers the SSH `direct-streamlocal`
 * channel; sshd builds that refuse it (OpenSSH 7.4 on CentOS 7, AllowStreamLocalForwarding no,
 * restricted keys) fall back to an exec channel that bridges the socket with tools the
 * node already has: `docker system dial-stdio` (only for `docker: true`, i.e. the Docker
 * socket), else socat / nc -U. The first working transport is remembered per link, purpose
 * and socket path.
 */
/**
 * `long` marks streams that may stay open (relayed CLI sessions, attach); they leave one
 * bridge slot free for short health and API calls. `signal` cancels while queued or
 * opening; `waitMs` bounds the wait for a slot.
 */
export async function connectUnixSocket(
  client,
  socketPath,
  { docker = false, long = false, signal = null, waitMs = BRIDGE_WAIT_MS } = {},
) {
  const key = transportKey(socketPath, docker)
  const bridge = { long, signal, deadlineAt: Date.now() + waitMs }
  const cached = unixTransport.get(client)?.get(key)
  if (cached && cached !== 'streamlocal') {
    try {
      return await execUnixStream(client, cached, socketPath, bridge)
    } catch (err) {
      // A busy or closing link says nothing about the bridge tool; re-probing would only add sessions.
      if (BRIDGE_WAIT_CODES.has(err.code)) throw err
      unixTransport.get(client)?.delete(key) // stale (tool removed, socket gone): re-probe below
    }
  }
  try {
    const stream = await forwardOutStreamLocal(client, socketPath)
    rememberTransport(client, key, 'streamlocal')
    return stream
  } catch (err) {
    if (err.code !== 'streamlocal_failed') throw err
    // The target socket not being there yet (kernel restarting) is a normal answer, and a
    // node short on resources will not do better on an exec channel; bridging would only
    // hide either answer and burn a session on the node.
    if (err.reason === 'CONNECT_FAILED' || err.reason === 'RESOURCE_SHORTAGE') throw err
    const tools = await probeBridgeTools(client)
    const order = [docker && tools.docker && 'docker-dial-stdio', tools.socat && 'socat', tools.nc && 'nc'].filter(
      Boolean,
    )
    for (const name of order) {
      try {
        const stream = await execUnixStream(client, name, socketPath, bridge)
        rememberTransport(client, key, name)
        return stream
      } catch (bridgeErr) {
        if (BRIDGE_WAIT_CODES.has(bridgeErr.code)) throw bridgeErr
        /* try next bridge */
      }
    }
    throw err
  }
}

/** Transport last selected for the Docker socket on this link (null before first use). */
export function unixTransportOf(client, socketPath = DOCKER_SOCKET_PATH) {
  return unixTransport.get(client)?.get(transportKey(socketPath, true)) ?? null
}

const bridgeTools = new WeakMap()

function probeBridgeTools(client) {
  // One answer per connection: the tool set does not change under a live link, and every
  // probe is another exec on a node that may already be short of sessions.
  let probe = bridgeTools.get(client)
  if (!probe) {
    // nc without -N keeps the remote process alive after our side closes, leaking one
    // session per call until the node's MaxSessions (default 10) is exhausted.
    probe = execCollect(
      client,
      'command -v docker socat nc 2>/dev/null; if command -v nc >/dev/null 2>&1 && nc -h 2>&1 | grep -q -e " -N"; then echo nc-N; fi',
      { timeoutMs: 8000 },
    ).then(
      (r) => {
        const out = r?.stdout ?? ''
        const has = (n) => new RegExp(`(^|/)${n}$`, 'm').test(out)
        return { docker: has('docker'), socat: has('socat'), nc: has('nc-N') }
      },
      () => {
        bridgeTools.delete(client) // a failed probe is no answer; ask again next time
        return { docker: false, socat: false, nc: false }
      },
    )
    bridgeTools.set(client, probe)
  }
  return probe
}

// Each bridge holds one SSH session for the life of the stream; sshd allows MaxSessions (10)
// per connection and Docker health, relays and guards all share the link. Keep headroom.
export const MAX_BRIDGE_SESSIONS = 6
// Long-lived relays may not take the last slot: health and API calls must still get through.
export const MAX_LONG_BRIDGE_SESSIONS = MAX_BRIDGE_SESSIONS - 1
export const MAX_BRIDGE_WAITERS = 6
export const BRIDGE_WAIT_MS = 10_000
const BRIDGE_WAIT_CODES = new Set(['bridge_busy', 'bridge_wait_timeout', 'bridge_wait_aborted', 'bridge_link_closed'])
// Keyed by the ssh2 Client, and `closed` never goes back to false. That holds only because
// SshLink._open builds a new Client for every connection and never reuses one after a drop, so
// bridgeSlots, bridgeTools and unixTransport all start fresh with it. Reusing a Client across
// reconnects would leave its bridges refused for good: reset this state there first.
const bridgeSlots = new WeakMap()

function bridgeState(client) {
  let state = bridgeSlots.get(client)
  if (state) return state
  state = { active: 0, long: 0, waiters: [], held: new Set(), closed: false }
  bridgeSlots.set(client, state)
  const onClose = () => {
    if (state.closed) return
    state.closed = true
    for (const waiter of state.waiters.splice(0)) {
      waiter.fail(new ClusterError(503, 'bridge_link_closed', 'SSH 连接已断开，桥接请求已取消'))
    }
    // Every channel died with the connection; nothing else would fire for them.
    for (const release of [...state.held]) release()
  }
  client.once?.('close', onClose)
  client.once?.('end', onClose)
  return state
}

const fits = (state, long) => state.active < MAX_BRIDGE_SESSIONS && (!long || state.long < MAX_LONG_BRIDGE_SESSIONS)

function grantNext(state) {
  for (let i = 0; i < state.waiters.length; i += 1) {
    if (fits(state, state.waiters[i].long)) {
      const [waiter] = state.waiters.splice(i, 1)
      waiter.grant()
      i -= 1
    }
  }
}

/** Resolves with a release function that may be called any number of times. */
export function acquireBridgeSlot(
  client,
  { long = false, signal = null, deadlineAt = Date.now() + BRIDGE_WAIT_MS } = {},
) {
  const state = bridgeState(client)
  const take = () => {
    state.active += 1
    if (long) state.long += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      state.held.delete(release)
      state.active -= 1
      if (long) state.long -= 1
      grantNext(state)
    }
    state.held.add(release)
    return release
  }
  if (signal?.aborted) return Promise.reject(new ClusterError(499, 'bridge_wait_aborted', '桥接请求已取消'))
  if (state.closed) return Promise.reject(new ClusterError(503, 'bridge_link_closed', 'SSH 连接已断开，桥接请求已取消'))
  // Queued waiters never fit right now (grantNext hands out every free slot), so no one is skipped.
  if (fits(state, long)) return Promise.resolve(take())
  if (state.waiters.length >= MAX_BRIDGE_WAITERS) {
    return Promise.reject(new ClusterError(503, 'bridge_busy', '节点桥接通道繁忙，请稍后重试'))
  }
  return new Promise((resolve, reject) => {
    let timer = null
    const leave = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const at = state.waiters.indexOf(waiter)
      if (at >= 0) state.waiters.splice(at, 1)
    }
    const waiter = {
      long,
      grant: () => {
        leave()
        resolve(take())
      },
      fail: (err) => {
        leave()
        reject(err)
      },
    }
    const onAbort = () => waiter.fail(new ClusterError(499, 'bridge_wait_aborted', '桥接请求已取消'))
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(
      () => waiter.fail(new ClusterError(503, 'bridge_wait_timeout', '等待节点桥接通道超时')),
      Math.max(0, deadlineAt - Date.now()),
    )
    timer.unref?.()
    state.waiters.push(waiter)
  })
}

/**
 * ssh2 emits a channel's 'close' only after its readable side has ended, so a caller that
 * closes without reading would keep the slot forever. Closing drains what is left instead.
 */
function drainOnClose(stream) {
  for (const name of ['close', 'destroy']) {
    const original = stream[name]?.bind(stream)
    if (!original) continue
    stream[name] = (...args) => {
      stream.resume?.()
      return original(...args)
    }
  }
}

async function execUnixStream(client, transport, socketPath, { long = false, signal = null, deadlineAt } = {}) {
  const q = shQuote(socketPath)
  const command =
    transport === 'docker-dial-stdio'
      ? 'exec docker system dial-stdio'
      : transport === 'socat'
        ? `exec socat - UNIX-CONNECT:${q}`
        : `exec nc -N -U ${q}`
  const done = await acquireBridgeSlot(client, { long, signal, deadlineAt })
  if (signal?.aborted) {
    done()
    throw new ClusterError(499, 'bridge_wait_aborted', '桥接请求已取消')
  }
  try {
    return await new Promise((resolve, reject) => {
      let abandoned = false
      const onAbort = () => {
        abandoned = true
        reject(new ClusterError(499, 'bridge_wait_aborted', '桥接请求已取消'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      client.exec(command, (err, stream) => {
        signal?.removeEventListener('abort', onAbort)
        if (err) {
          if (abandoned) done()
          return reject(new ClusterError(502, 'unix_bridge_failed', `远端桥接失败：${err.message}`))
        }
        drainOnClose(stream)
        if (abandoned) {
          // A late channel for a caller that already left: close it before any byte crosses.
          stream.once('close', done)
          stream.close()
          return
        }
        let settled = false
        const fail = (msg) => {
          if (settled) return
          settled = true
          stream.close()
          reject(new ClusterError(502, 'unix_bridge_failed', msg))
        }
        // A missing tool / refused socket exits at once; a healthy bridge stays open waiting for input.
        // Only our own two listeners are detached below: ssh2 keeps its own on the channel.
        const onExit = (code) => fail(`桥接命令提前退出(${code})`)
        const onEarlyClose = () => fail('桥接通道提前关闭')
        stream.once('exit', onExit)
        stream.once('close', onEarlyClose)
        setTimeout(() => {
          if (settled) return
          settled = true
          stream.off('exit', onExit)
          stream.off('close', onEarlyClose)
          stream.once('close', done) // the session is free again only when the channel is gone
          if (signal?.aborted) {
            stream.close()
            reject(new ClusterError(499, 'bridge_wait_aborted', '桥接请求已取消'))
            return
          }
          resolve(stream)
        }, 250)
      })
    })
  } catch (err) {
    // An abandoned channel releases on its own close; everything else frees the slot now.
    if (err.code !== 'bridge_wait_aborted') done()
    throw err
  }
}

/** Run a command, collect output. Rejects only on channel failure; non-zero exit is data. */
export function execCollect(client, command, { timeoutMs = 30_000, maxBytes = 1 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    let timedOut = false
    let channel = null
    // The deadline starts with the request: opening the channel is part of the wait.
    const timer = setTimeout(() => {
      timedOut = true
      channel?.close()
      reject(new ClusterError(504, 'exec_timeout', '远端执行超时'))
    }, timeoutMs)
    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        return reject(new ClusterError(502, 'exec_failed', `远端执行失败：${err.message}`))
      }
      if (timedOut) {
        stream.resume?.()
        stream.close()
        return
      }
      channel = stream
      let stdout = ''
      let stderr = ''
      let code = null
      const cap = (cur, chunk) => (cur.length >= maxBytes ? cur : (cur + chunk.toString('utf8')).slice(-maxBytes))
      stream.on('data', (chunk) => {
        stdout = cap(stdout, chunk)
      })
      stream.stderr.on('data', (chunk) => {
        stderr = cap(stderr, chunk)
      })
      stream.on('exit', (exitCode) => {
        code = exitCode
      })
      stream.on('close', () => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
    })
  })
}

const FATAL_CODES = new Set(['host_key_mismatch', 'auth_failed'])

/**
 * Supervised connection. `resolveTarget()` returns connectSsh options (fresh
 * credentials + optional jump sock) for every attempt, so a jump node that
 * reconnected in between is picked up.
 */
export class SshLink extends EventEmitter {
  constructor({
    id,
    resolveTarget,
    now = Date.now,
    random = Math.random,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    super()
    this.id = id
    this.resolveTarget = resolveTarget
    this.now = now
    this.random = random
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.state = 'idle'
    this.client = null
    this.error = null
    this.attempt = 0
    this.connectedAt = null
    this.nextRetryAt = null
    this.hostKey = null
    this._timer = null
    this._generation = 0
  }

  snapshot() {
    return {
      state: this.state,
      error: this.error,
      attempt: this.attempt,
      connected_at: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
      next_retry_at: this.nextRetryAt ? new Date(this.nextRetryAt).toISOString() : null,
    }
  }

  get generation() {
    return this._generation
  }

  /** Keep the link object used by relay closures, but take over an already verified connection. */
  adopt(result, expectedGeneration = this._generation) {
    if (expectedGeneration !== this._generation) return false
    this._teardown()
    this._setState('connecting')
    this._accept(result, this._generation)
    return true
  }

  start() {
    if (this.state !== 'idle') return
    this._connect()
  }

  /** Operator-triggered: clears fatal errors and backoff, reconnects now. */
  reconnect() {
    this._teardown()
    this.attempt = 0
    this.error = null
    this._connect()
  }

  stop() {
    this._teardown()
    this._setState('idle')
  }

  _teardown() {
    this._generation += 1
    this.clearTimer(this._timer)
    this._timer = null
    this.nextRetryAt = null
    const client = this.client
    this.client = null
    this.connectedAt = null
    if (client) client.end()
  }

  _setState(state) {
    if (this.state === state) return
    this.state = state
    this.emit('state', state)
  }

  async _connect() {
    const gen = ++this._generation
    this._setState('connecting')
    let result
    try {
      const target = await this.resolveTarget()
      if (gen !== this._generation) return
      result = await connectSsh(target)
    } catch (err) {
      if (gen !== this._generation) return
      this.error = { code: err.code || 'ssh_connect_failed', message: err.message || String(err) }
      if (FATAL_CODES.has(err.code)) {
        this._setState('error')
        return
      }
      this._scheduleRetry(gen)
      return
    }
    if (gen !== this._generation) {
      result.client.end()
      return
    }
    this._accept(result, gen)
  }

  _accept({ client, hostKey }, gen) {
    this.client = client
    this.hostKey = hostKey
    this.error = null
    this.attempt = 0
    this.connectedAt = this.now()
    client.on('error', (err) => {
      if (gen !== this._generation) return
      this.error = { code: 'ssh_link_error', message: err?.message || String(err) }
    })
    client.once('close', () => {
      if (gen !== this._generation) return
      this.client = null
      this.connectedAt = null
      if (!this.error) this.error = { code: 'ssh_closed', message: 'SSH 连接已断开' }
      this._scheduleRetry(gen)
    })
    this._setState('ready')
  }

  _scheduleRetry(gen) {
    const delay = backoffDelayMs(this.attempt, this.random())
    this.attempt += 1
    this.nextRetryAt = this.now() + delay
    this._setState('backoff')
    this._timer = this.setTimer(() => {
      this._timer = null
      if (gen !== this._generation) return
      this.nextRetryAt = null
      this._connect()
    }, delay)
    this._timer?.unref?.()
  }
}
