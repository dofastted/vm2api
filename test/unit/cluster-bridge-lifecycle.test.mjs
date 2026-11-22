import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import ssh2 from 'ssh2'
import { ClusterManager, HEALTH_STALE_MS } from '../../src/lib/cluster/cluster-manager.mjs'
import { SocketRelay } from '../../src/lib/cluster/socket-relay.mjs'
import { connectUnixSocket, execCollect } from '../../src/lib/cluster/ssh-link.mjs'

const { Client, Server } = ssh2
const DOCKER = '/var/run/docker.sock'
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

async function within(promise, ms = 400) {
  let timer
  try {
    return await Promise.race([
      promise.then(
        (result) => ({ settled: true, result }),
        (err) => ({ settled: true, code: err.code, reason: err.reason }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Real ssh2 server whose sshd refuses direct-streamlocal, like OpenSSH 7.4 nodes. */
async function loopback(t, { rejectTarget = false, http = false, execDelayMs = 0 } = {}) {
  const peers = new Set()
  const state = { exec: 0, bridge: 0, sessions: 0, peerCloses: 0 }
  const server = new Server({ hostKeys: [privateKey] }, (peer) => {
    peers.add(peer)
    peer.on('error', () => {})
    peer.on('close', () => peers.delete(peer))
    peer.on('authentication', (ctx) => ctx.accept())
    if (rejectTarget) peer.on('openssh.streamlocal', (_accept, reject) => reject())
    peer.on('session', (accept) => {
      const session = accept()
      session.on('exec', async (accept, _reject, { command }) => {
        state.exec += 1
        if (execDelayMs) await delay(execDelayMs)
        const stream = accept()
        stream.resume()
        stream.on('error', () => {})
        if (command.startsWith('command -v')) {
          stream.write('/usr/bin/docker\n/usr/bin/socat\n')
          stream.exit(0)
          stream.end()
          return
        }
        if (command !== 'exec docker system dial-stdio' && !command.startsWith('exec socat')) {
          stream.exit(0)
          stream.end()
          return
        }
        state.bridge += 1
        state.sessions += 1
        stream.once('close', () => {
          state.sessions -= 1
          state.peerCloses += 1
        })
        if (http) {
          stream.once('data', (request) => {
            const body = request.toString().startsWith('GET /_ping ') ? 'OK' : '{"Containers":0,"ContainersRunning":0}'
            stream.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`)
          })
        }
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = new Client()
  client.on('error', () => {})
  client.connect({ host: '127.0.0.1', port: server.address().port, username: 'fixture', readyTimeout: 1500 })
  await once(client, 'ready')
  t.after(async () => {
    client.end()
    for (const peer of peers) peer.end()
    await new Promise((resolve) => server.close(resolve))
  })
  return { client, state }
}

function managerFor(client, platform = 'linux') {
  const manager = Object.create(ClusterManager.prototype)
  manager.links = new Map([['n1', { state: 'ready', client, hostKey: null, snapshot: () => ({ state: 'ready' }) }]])
  manager.health = new Map()
  manager.bridges = new Map()
  manager.hostFacts = new Map()
  manager.nodePlatform = () => platform
  manager.vmsOnNode = () => []
  manager.logger = { log() {}, warn() {} }
  return manager
}

test('numeric CONNECT_FAILED from ssh2 is a real answer, not a reason to open exec bridges', async (t) => {
  const { client, state } = await loopback(t, { rejectTarget: true })
  // ssh2 calls reject() with CONNECT_FAILED (2); the old string compare never matched.
  const before = state.exec
  const result = await within(connectUnixSocket(client, '/not-present'), 800)
  assert.equal(result.settled, true)
  assert.equal(result.code, 'streamlocal_failed')
  assert.equal(result.reason, 'CONNECT_FAILED')
  assert.equal(state.exec - before, 0)
})

test('closing an unread bridge returns its slot, so short probes never exhaust the link', async (t) => {
  const { client, state } = await loopback(t)
  for (let i = 0; i < 8; i += 1) {
    const probe = await connectUnixSocket(client, DOCKER, { docker: true })
    probe.close() // never read: the old code waited for 'end' forever and kept the slot
    await delay(30)
  }
  const ninth = await within(connectUnixSocket(client, DOCKER, { docker: true }), 800)
  assert.equal(ninth.settled, true)
  assert.equal(ninth.code, undefined)
  ninth.result.destroy()
  await delay(50)
  assert.equal(state.sessions, 0)
})

test('a full link answers bridge_wait_timeout within the deadline and does not re-probe', async (t) => {
  const { client, state } = await loopback(t)
  const held = await Promise.all(Array.from({ length: 6 }, () => connectUnixSocket(client, DOCKER, { docker: true })))
  const execBefore = state.exec
  const started = Date.now()
  const waiting = await within(connectUnixSocket(client, DOCKER, { docker: true, waitMs: 150 }), 1000)
  assert.equal(waiting.settled, true)
  assert.equal(waiting.code, 'bridge_wait_timeout')
  assert.ok(Date.now() - started < 900)
  assert.equal(state.exec, execBefore, 'a busy link must not drop the cached transport and probe tools again')
  for (const stream of held) stream.destroy()
  // Capacity is back once the holders are gone.
  const after = await within(connectUnixSocket(client, DOCKER, { docker: true, waitMs: 500 }), 1000)
  assert.equal(after.code, undefined)
  after.result.destroy()
})

test('long-lived relays leave one slot for short operations', async (t) => {
  const { client } = await loopback(t)
  const longs = await Promise.all(
    Array.from({ length: 5 }, () => connectUnixSocket(client, DOCKER, { docker: true, long: true })),
  )
  const sixthLong = within(connectUnixSocket(client, DOCKER, { docker: true, long: true, waitMs: 150 }), 800)
  const short = await within(connectUnixSocket(client, DOCKER, { docker: true, waitMs: 150 }), 800)
  assert.equal(short.code, undefined, 'health/API calls still get the reserved slot')
  assert.equal((await sixthLong).code, 'bridge_wait_timeout')
  short.result.destroy()
  for (const stream of longs) stream.destroy()
})

test('a waiter cancelled by its caller leaves the queue and never opens a bridge', async (t) => {
  const { client, state } = await loopback(t)
  const held = await Promise.all(Array.from({ length: 6 }, () => connectUnixSocket(client, DOCKER, { docker: true })))
  const bridgesBefore = state.bridge
  const abort = new AbortController()
  const pending = within(connectUnixSocket(client, DOCKER, { docker: true, signal: abort.signal }), 800)
  await delay(20)
  abort.abort()
  assert.equal((await pending).code, 'bridge_wait_aborted')
  held[0].destroy()
  await delay(300)
  assert.equal(state.bridge, bridgesBefore)
  for (const stream of held.slice(1)) stream.destroy()
})

test('relay whose local client hung up while queued does not open a bridge afterwards', async (t) => {
  const { client, state } = await loopback(t)
  const held = await Promise.all(Array.from({ length: 6 }, () => connectUnixSocket(client, DOCKER, { docker: true })))
  const relay = new SocketRelay({
    socketPath: '/fixture-listener',
    remotePath: DOCKER,
    docker: true,
    getClient: () => client,
  })
  const local = new EventEmitter()
  local.destroyed = false
  local.destroy = () => {
    local.destroyed = true
    local.emit('close')
  }
  const pending = relay._relay(local)
  await delay(30)
  local.destroy()
  assert.equal((await within(pending, 400)).settled, true, 'the queued relay gives up as soon as its client is gone')
  held[0].destroy()
  await delay(300)
  assert.equal(state.bridge, 6)
  for (const stream of held.slice(1)) stream.destroy()
})

test('waiters fail fast when the SSH connection drops', async (t) => {
  const { client } = await loopback(t)
  const held = await Promise.all(Array.from({ length: 6 }, () => connectUnixSocket(client, DOCKER, { docker: true })))
  const pending = within(connectUnixSocket(client, DOCKER, { docker: true, waitMs: 5000 }), 1500)
  await delay(20)
  client.end()
  assert.equal((await pending).code, 'bridge_link_closed')
  for (const stream of held) stream.destroy()
})

test('execCollect deadline covers a slow channel open', async (t) => {
  const { client } = await loopback(t, { execDelayMs: 400 })
  const started = Date.now()
  const result = await within(execCollect(client, 'true', { timeoutMs: 100 }), 1000)
  assert.equal(result.code, 'exec_timeout')
  assert.ok(Date.now() - started < 350, 'the timer starts when the command is issued, not when the channel opens')
})

test('eight health cycles on an old-OpenSSH node all complete and refresh the snapshot', async (t) => {
  const { client, state } = await loopback(t, { http: true })
  const manager = managerFor(client)
  let previous = null
  for (let round = 0; round < 8; round += 1) {
    assert.equal((await within(manager._checkHealth('n1'), 3000)).settled, true, `round ${round + 1}`)
    const snapshot = manager.health.get('n1')
    assert.equal(snapshot.docker.ok, true)
    assert.notEqual(snapshot, previous)
    previous = snapshot
  }
  await delay(50)
  assert.equal(state.sessions, 0)
})

test('concurrent health checks for one node share a single run', async (t) => {
  const { client, state } = await loopback(t, { http: true })
  const manager = managerFor(client)
  await manager._checkHealth('n1')
  const execBefore = state.exec
  await Promise.all([manager._checkHealth('n1'), manager._checkHealth('n1'), manager._checkHealth('n1')])
  const perRun = state.exec - execBefore
  await manager._checkHealth('n1')
  assert.equal(state.exec - execBefore - perRun, perRun, 'three overlapping calls cost one run')
})

test('a health snapshot older than two probe cycles is reported as stale, not green', () => {
  const manager = managerFor(null)
  manager.repo = { directLinks: () => new Map() }
  manager.installs = new Map()
  const old = new Date(Date.now() - HEALTH_STALE_MS - 1000).toISOString()
  manager.health.set('n1', { docker: { ok: true, error: null }, latency_ms: 5, checked_at: old })
  const view = manager._view({ id: 'n1' })
  assert.equal(view.health.stale, true)
  assert.equal(view.health.docker.ok, false)
  assert.match(view.health.docker.error, /过期/)
  manager.health.set('n1', { docker: { ok: true, error: null }, latency_ms: 5, checked_at: new Date().toISOString() })
  assert.equal(manager._view({ id: 'n1' }).health.docker.ok, true)
})

test('a healthy bridge keeps listeners it did not attach', async () => {
  const foreign = []
  const stream = new EventEmitter()
  stream.stderr = new EventEmitter()
  stream.close = () => stream.emit('close')
  const client = new EventEmitter()
  client.openssh_forwardOutStreamLocal = (_target, callback) =>
    callback(Object.assign(new Error('administratively prohibited'), { reason: 1 }))
  client.exec = (command, callback) => {
    if (command.startsWith('command -v')) {
      const probe = new EventEmitter()
      probe.stderr = new EventEmitter()
      probe.close = () => probe.emit('close')
      callback(null, probe)
      queueMicrotask(() => {
        probe.emit('data', Buffer.from('/usr/bin/docker\n'))
        probe.emit('exit', 0)
        probe.emit('close')
      })
      return
    }
    // Listeners other code attached to the channel before the bridge settled.
    stream.on('exit', () => foreign.push('exit'))
    stream.on('close', () => foreign.push('close'))
    callback(null, stream)
  }
  const bridged = await connectUnixSocket(client, DOCKER, { docker: true })
  assert.equal(bridged, stream)
  stream.emit('exit', 0)
  stream.emit('close')
  assert.deepEqual(foreign, ['exit', 'close'])
})
