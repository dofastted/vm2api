import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { ClusterManager } from '../../src/lib/cluster/cluster-manager.mjs'
import { dockerJson, localDocker } from '../../src/lib/cluster/docker-remote.mjs'
import { SshLink } from '../../src/lib/cluster/ssh-link.mjs'
import { SocketRelay } from '../../src/lib/cluster/socket-relay.mjs'

async function fixture(t) {
  // Keep the nested manager socket below macOS's sockaddr_un path limit.
  const dir = fs.mkdtempSync('/tmp/relay-purpose-')
  const sockets = new Set()
  const calls = []
  const engine = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ Version: '26.1.4' }))
  })
  engine.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  engine.listen(0, '127.0.0.1')
  await once(engine, 'listening')
  const client = {
    openssh_forwardOutStreamLocal(_target, callback) {
      callback(Object.assign(new Error('administratively prohibited'), { reason: 1 }))
    },
    exec(command, callback) {
      calls.push(command)
      if (command.startsWith('command -v')) {
        const stream = new EventEmitter()
        stream.stderr = new EventEmitter()
        stream.close = () => stream.emit('close')
        callback(null, stream)
        queueMicrotask(() => {
          stream.emit('data', Buffer.from('/usr/bin/docker\n'))
          stream.emit('exit', 0)
          stream.emit('close')
        })
        return
      }
      assert.equal(command, 'exec docker system dial-stdio')
      const stream = net.connect(engine.address().port, '127.0.0.1')
      stream.stderr = new PassThrough()
      stream.close = () => stream.destroy()
      sockets.add(stream)
      stream.once('close', () => sockets.delete(stream))
      callback(null, stream)
    },
    end() {},
  }
  t.after(async () => {
    for (const s of sockets) s.destroy()
    await new Promise((resolve) => engine.close(resolve))
    fs.rmSync(dir, { force: true, recursive: true })
  })
  return { dir, client, calls }
}

test('the manager-created Docker CLI bridge works on a Docker-only node refusing streamlocal', async (t) => {
  const { dir, client, calls } = await fixture(t)
  // Keep the real caller and relay. Only replace SSH connection establishment.
  t.mock.method(SshLink.prototype, 'start', () => {})
  const manager = new ClusterManager({ repo: {}, dataDir: dir, logger: { warn() {}, log() {} } })
  manager._attach({ id: 'node-test' })
  const link = manager.links.get('node-test')
  link.client = client
  link.state = 'ready'
  const bridge = manager.bridges.get('node-test')
  t.after(() => manager.stop())
  if (!bridge.listening) await once(bridge.server, 'listening')
  const result = await dockerJson(localDocker(manager.bridgeSocketPath('node-test')), {
    path: '/version',
    timeoutMs: 1500,
  })
  assert.equal(result.Version, '26.1.4')
  assert.ok(calls.includes('exec docker system dial-stdio'))
})

test('a generic kernel relay never falls back to Docker on a Docker-only node', async (t) => {
  const { dir, client, calls } = await fixture(t)
  const relay = new SocketRelay({
    socketPath: path.join(dir, 'kernel.sock'),
    remotePath: '/run/kin/kernel.sock',
    getClient: () => client,
    logger: { warn() {} },
  })
  await relay.start()
  t.after(() => relay.stop())
  await assert.rejects(dockerJson(localDocker(relay.socketPath), { path: '/version', timeoutMs: 1500 }))
  assert.equal(calls.includes('exec docker system dial-stdio'), false)
})
