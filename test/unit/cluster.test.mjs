import { behindNat, localAddresses, parseSshClient } from '../../src/lib/cluster/local-status.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import ssh2 from 'ssh2'
import { createAuthHandler } from '../../src/lib/cluster/ssh-auth.mjs'
import {
  BACKOFF_MAX_MS,
  backoffDelayMs,
  ClusterError,
  connectSsh,
  hostKeyDigest,
  SshLink,
} from '../../src/lib/cluster/ssh-link.mjs'
import { buildCreateSpec, demuxDockerLog, normalizeImageRef } from '../../src/lib/cluster/docker-remote.mjs'
import { ClusterManager, parseNodeInput } from '../../src/lib/cluster/cluster-manager.mjs'

const { Server, utils } = ssh2

function frame(kind, text) {
  const payload = Buffer.from(text)
  const head = Buffer.alloc(8)
  head[0] = kind
  head.writeUInt32BE(payload.length, 4)
  return Buffer.concat([head, payload])
}

/** sshd that accepts only password `pw` for user `u`. */
async function startServer() {
  // ssh2 1.17 emits a malformed ed25519 OpenSSH key ~0.4% of the time; ECDSA keys parse every time.
  const hostKey = utils.generateKeyPairSync('ecdsa', { bits: 256 })
  const server = new Server({ hostKeys: [hostKey.private] }, (conn) => {
    conn.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'u' && ctx.password === 'pw') return ctx.accept()
      ctx.reject(['password'])
    })
    conn.on('ready', () => {})
    conn.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const blob = Buffer.from(hostKey.public.split(' ')[1], 'base64')
  return { server, port: server.address().port, sha256: hostKeyDigest(blob), publicLine: hostKey.public }
}

test('backoff doubles from 1s, caps at 60s, and jitters within ±20%', () => {
  assert.equal(backoffDelayMs(0, 0.5), 1000)
  assert.equal(backoffDelayMs(3, 0.5), 8000)
  assert.equal(backoffDelayMs(20, 0.5), BACKOFF_MAX_MS)
  assert.equal(backoffDelayMs(0, 0), 800)
  assert.equal(backoffDelayMs(0, 1), 1200)
})

test('host key digest matches ssh-keygen SHA256 fingerprint', (t) => {
  const key = utils.generateKeyPairSync('ecdsa', { bits: 256 })
  let expected
  try {
    expected = execFileSync('ssh-keygen', ['-lf', '-'], { input: `${key.public}\n` })
      .toString()
      .split(' ')[1]
  } catch {
    t.skip('ssh-keygen unavailable')
    return
  }
  assert.equal(hostKeyDigest(Buffer.from(key.public.split(' ')[1], 'base64')), expected)
})

test('connectSsh pins the host key and classifies auth failures', async () => {
  const { server, port, sha256 } = await startServer()
  try {
    const probe = await connectSsh({ host: '127.0.0.1', port, username: 'u', authType: 'password', password: 'pw' })
    assert.equal(probe.hostKey.sha256, sha256)
    probe.client.end()

    const pinned = await connectSsh({
      host: '127.0.0.1',
      port,
      username: 'u',
      authType: 'password',
      password: 'pw',
      expectedSha256: sha256,
    })
    pinned.client.end()

    await assert.rejects(
      connectSsh({
        host: '127.0.0.1',
        port,
        username: 'u',
        authType: 'password',
        password: 'pw',
        expectedSha256: `SHA256:${'A'.repeat(43)}`,
      }),
      (err) => err.code === 'host_key_mismatch',
    )
    await assert.rejects(
      connectSsh({ host: '127.0.0.1', port, username: 'u', authType: 'password', password: 'nope' }),
      (err) => err.code === 'auth_failed',
    )
  } finally {
    server.close()
  }
})

test('auth plan never offers a method the server stopped allowing', () => {
  const tried = []
  const handler = createAuthHandler({ username: 'u', authType: 'password', password: 'pw' })
  handler(null, null, (m) => tried.push(m && m.type))
  // Server says only publickey remains: password-family methods must not be sent.
  handler(['publickey'], false, (m) => tried.push(m))
  assert.deepEqual(tried, ['password', false])

  const kbd = []
  const h2 = createAuthHandler({ username: 'u', authType: 'password', password: 'pw' })
  h2(null, null, (m) => kbd.push(m.type))
  h2(['keyboard-interactive'], false, (m) => kbd.push(m.type))
  assert.deepEqual(kbd, ['password', 'keyboard-interactive'])
})

function fakeTimers() {
  const pending = []
  return {
    pending,
    setTimer: (fn, ms) => {
      const handle = { fn, ms }
      pending.push(handle)
      return handle
    },
    clearTimer: (handle) => {
      const i = pending.indexOf(handle)
      if (i >= 0) pending.splice(i, 1)
    },
  }
}

test('SshLink stops on fatal errors but backs off on transient ones', async () => {
  const timers = fakeTimers()
  let nextError = new ClusterError(502, 'ssh_connect_failed', 'refused')
  const link = new SshLink({
    id: 'n1',
    random: () => 0.5,
    ...timers,
    resolveTarget: async () => {
      throw nextError
    },
  })
  link.start()
  await new Promise((r) => setImmediate(r))
  assert.equal(link.state, 'backoff')
  assert.equal(timers.pending.length, 1)
  assert.equal(timers.pending[0].ms, 1000)

  nextError = new ClusterError(409, 'host_key_mismatch', 'mismatch')
  timers.pending.shift().fn()
  await new Promise((r) => setImmediate(r))
  assert.equal(link.state, 'error')
  assert.equal(link.error.code, 'host_key_mismatch')
  assert.equal(timers.pending.length, 0, 'fatal errors must not schedule a retry')

  nextError = new ClusterError(502, 'ssh_connect_failed', 'refused')
  link.reconnect()
  await new Promise((r) => setImmediate(r))
  assert.equal(link.state, 'backoff')
  assert.equal(link.attempt, 1, 'operator reconnect restarts the backoff ladder')
  link.stop()
  assert.equal(timers.pending.length, 0)
})

test('SshLink returns to backoff when an established connection drops', async () => {
  const { server, port, sha256 } = await startServer()
  const timers = fakeTimers()
  const link = new SshLink({
    id: 'n2',
    ...timers,
    resolveTarget: async () => ({
      host: '127.0.0.1',
      port,
      username: 'u',
      authType: 'password',
      password: 'pw',
      expectedSha256: sha256,
    }),
  })
  try {
    const ready = new Promise((resolve) =>
      link.once('state', function wait(s) {
        if (s === 'ready') resolve()
        else link.once('state', wait)
      }),
    )
    link.start()
    await ready
    const dropped = new Promise((resolve) => link.once('state', resolve))
    link.client._sock.destroy()
    assert.equal(await dropped, 'backoff')
    assert.equal(timers.pending.length, 1)
  } finally {
    link.stop()
    server.close()
  }
})

test('docker log demux splits stdout/stderr frames and drops a cut tail', () => {
  const buf = Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n'), frame(1, 'partial').subarray(0, 10)])
  assert.deepEqual(demuxDockerLog(buf), [
    { stream: 'stdout', text: 'out\n' },
    { stream: 'stderr', text: 'err\n' },
  ])
})

test('image refs get :latest only when untagged', () => {
  assert.equal(normalizeImageRef('nginx'), 'nginx:latest')
  assert.equal(normalizeImageRef('nginx:alpine'), 'nginx:alpine')
  assert.equal(normalizeImageRef('registry.local:5000/app'), 'registry.local:5000/app:latest')
  assert.equal(normalizeImageRef('app@sha256:abc'), 'app@sha256:abc')
})

test('create spec maps ports/env and rejects malformed input', () => {
  const spec = buildCreateSpec({ image: 'nginx', name: 'web', ports: ['8080:80', '127.0.0.1:53:53/udp'], env: ['A=1'] })
  assert.deepEqual(spec.body.HostConfig.PortBindings, {
    '80/tcp': [{ HostIp: '', HostPort: '8080' }],
    '53/udp': [{ HostIp: '127.0.0.1', HostPort: '53' }],
  })
  assert.deepEqual(spec.body.Env, ['A=1'])
  assert.equal(spec.body.HostConfig.RestartPolicy.Name, 'unless-stopped')
  assert.throws(() => buildCreateSpec({ image: 'nginx', ports: ['80'] }), { code: 'invalid_port' })
  assert.throws(() => buildCreateSpec({ image: 'nginx', ports: ['70000:80'] }), { code: 'invalid_port' })
  assert.throws(() => buildCreateSpec({ image: 'nginx', env: ['1BAD=x'] }), { code: 'invalid_env' })
  assert.throws(() => buildCreateSpec({ image: 'nginx; rm -rf /' }), { code: 'invalid_image' })
})

test('node input requires a well-formed pinned fingerprint on create', () => {
  const base = { host: '203.0.113.9', username: 'ubuntu', auth_type: 'password', password: 'x' }
  assert.equal(parseNodeInput(base).port, 22)
  assert.throws(() => parseNodeInput(base, { requireHostKey: true }), { code: 'missing_host_key' })
  assert.throws(() => parseNodeInput({ ...base, host: 'https://x' }), { code: 'invalid_host' })
  assert.throws(() => parseNodeInput({ ...base, auth_type: 'key', private_key: 'garbage' }), {
    code: 'invalid_private_key',
  })
})

test('shell tickets are single-use and bound to one node', () => {
  const manager = new ClusterManager({ repo: {}, dataDir: '/tmp' })
  manager.links.set('a', { state: 'ready', client: {} })
  manager.links.set('b', { state: 'ready', client: {} })
  const { ticket } = manager.issueShellTicket('a')
  assert.equal(manager.consumeShellTicket(ticket, 'b'), false)
  const second = manager.issueShellTicket('a').ticket
  assert.equal(manager.consumeShellTicket(second, 'a'), true)
  assert.equal(manager.consumeShellTicket(second, 'a'), false)
  manager.links.set('c', { state: 'backoff', client: null })
  assert.throws(() => manager.issueShellTicket('c'), { code: 'node_not_ready' })
})

/** Link double: reconnect() lands on `next` (or stays connecting) and counts attempts. */
function fakeLink(state, next) {
  const link = new EventEmitter()
  Object.assign(link, { state, client: state === 'ready' ? {} : null, error: null, reconnects: 0 })
  link.snapshot = () => ({ state: link.state })
  link.reconnect = () => {
    link.reconnects += 1
    link.state = 'connecting'
    link.emit('state', 'connecting')
    if (!next) return
    setImmediate(() => {
      link.state = next
      link.client = next === 'ready' ? {} : null
      link.error = next === 'ready' ? null : { code: 'ssh_timeout', message: 'SSH 握手超时' }
      link.emit('state', next)
    })
  }
  return link
}

test('a node only counts as gone when it is missing or a fresh connect attempt fails', async () => {
  const nodes = new Set(['up', 'down', 'back', 'slow', 'gated'])
  const manager = new ClusterManager({ repo: { get: (id) => (nodes.has(id) ? { id } : null) }, dataDir: '/tmp' })
  assert.deepEqual(await manager.confirmNodeUnreachable('gone'), { state: 'missing', error: null })

  manager.links.set('up', fakeLink('ready'))
  await assert.rejects(manager.confirmNodeUnreachable('up'), { status: 409, code: 'node_reachable' })
  assert.equal(manager.links.get('up').reconnects, 0)

  manager.links.set('down', fakeLink('backoff', 'backoff'))
  assert.deepEqual(await manager.confirmNodeUnreachable('down'), { state: 'backoff', error: 'ssh_timeout' })
  assert.equal(manager.links.get('down').reconnects, 1, 'a stale backoff is re-checked, not trusted')

  manager.links.set('back', fakeLink('backoff', 'ready'))
  await assert.rejects(manager.confirmNodeUnreachable('back'), { code: 'node_reachable' })

  manager.links.set('slow', fakeLink('backoff', null))
  await assert.rejects(manager.confirmNodeUnreachable('slow', 20), { code: 'node_reachable', message: /仍在连接中/ })

  manager.links.set('gated', fakeLink('backoff', 'backoff'))
  manager.directState.set('gated', { checked_at: new Date().toISOString() })
  await assert.rejects(manager.confirmNodeUnreachable('gated'), { code: 'node_reachable' })
  assert.equal(manager.links.get('gated').reconnects, 0, 'a live direct link means the machine is still there')
})

test('NAT verdict compares the address a node sees against local interfaces', () => {
  assert.equal(parseSshClient('203.0.113.7 51234 22'), '203.0.113.7')
  assert.equal(parseSshClient(''), null)
  assert.equal(parseSshClient('not-an-ip 1 22'), null)
  const addrs = localAddresses({
    lo: [{ address: '127.0.0.1', internal: true }],
    eth0: [{ address: '192.168.1.5', internal: false }],
    eth1: [{ address: '::ffff:198.51.100.4', internal: false }],
  })
  assert.deepEqual(addrs, ['192.168.1.5', '198.51.100.4'])
  assert.equal(behindNat('203.0.113.7', addrs), true)
  assert.equal(behindNat('198.51.100.4', addrs), false)
  assert.equal(behindNat('::ffff:198.51.100.4', addrs), false)
  assert.equal(behindNat(null, addrs), null)
})
