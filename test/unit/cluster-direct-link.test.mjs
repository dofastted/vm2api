import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import tls from 'node:tls'
import { DatabaseSync } from 'node:sqlite'
import { ClusterManager, DIRECT_LINK_BACKOFF_MS } from '../../src/lib/cluster/cluster-manager.mjs'
import {
  certSha256,
  dialGate,
  gateConfigBody,
  gateContainer,
  parseDirectLinkInput,
} from '../../src/lib/cluster/direct-link.mjs'
import { SocketRelay } from '../../src/lib/cluster/socket-relay.mjs'
import { ClusterNodesRepo } from '../../src/lib/db/repos/cluster-nodes-repo.mjs'
import { bindPlacement, unbindPlacement, vmNodeDataPath } from '../../src/lib/cluster/placement.mjs'

const TOKEN = 'a'.repeat(64)

function shortDir(t) {
  const dir = fs.mkdtempSync(path.join('/tmp', 'kdl-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function selfSigned(t) {
  const dir = shortDir(t)
  const key = path.join(dir, 'key.pem')
  const cert = path.join(dir, 'cert.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=kin-slot-gate',
    ],
    { stdio: 'ignore' },
  )
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
}

/**
 * In-process double of kin-slot-gate: TLS, same preface and replies. Bytes that
 * follow the preface are the request body (sent before OK), and a slot answers
 * with the upper-cased body once the client half-closes.
 */
async function fakeGate(t, { token = TOKEN, slots = new Set(['vm-1']), extra = '' } = {}) {
  const pair = selfSigned(t)
  const seen = []
  const held = new Set()
  const server = tls.createServer({ ...pair, minVersion: 'TLSv1.3', allowHalfOpen: true }, (sock) => {
    held.add(sock)
    sock.on('close', () => held.delete(sock))
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const nl = buf.indexOf(10)
      if (nl < 0) return
      sock.off('data', onData)
      const [magic, tok, vm, kind] = buf.subarray(0, nl).toString().split(' ')
      const parts = [buf.subarray(nl + 1)]
      seen.push({ vm, kind, early: parts[0].toString() })
      if (magic !== 'KSG1' || tok !== token) return sock.end('ERR auth\n')
      if (kind === 'ping') return sock.end('OK\n')
      if (!slots.has(vm)) return sock.end('ERR no_socket\n')
      sock.write(`OK\n${extra}`)
      sock.on('data', (c) => parts.push(c))
      sock.on('end', () => sock.end(Buffer.concat(parts).toString().toUpperCase()))
    }
    sock.on('data', onData)
    sock.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    for (const s of held) s.destroy()
    server.close()
  })
  return { address: '127.0.0.1', port: server.address().port, token, certSha256: certSha256(pair.cert), seen }
}

function readAll(sock) {
  return new Promise((resolve, reject) => {
    const parts = []
    sock.on('data', (c) => parts.push(c))
    sock.once('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    sock.once('error', reject)
    sock.resume()
  })
}

test('parseDirectLinkInput takes an IP literal and a non-privileged port', () => {
  assert.deepEqual(parseDirectLinkInput({ address: ' 203.0.113.7 ' }), { address: '203.0.113.7', port: 7790 })
  assert.deepEqual(parseDirectLinkInput({ address: '2001:db8::2', port: '7800' }), {
    address: '2001:db8::2',
    port: 7800,
  })
  for (const body of [
    { address: 'node.example' },
    { address: '10.0.0.1', port: 22 },
    { address: '10.0.0.1', port: 'x' },
  ]) {
    assert.throws(() => parseDirectLinkInput(body), /直连/)
  }
})

test('dialGate sends the body before OK and strips OK from the reply', async (t) => {
  const gate = await fakeGate(t, { extra: 'early:' })
  const { sock, ready } = await dialGate({ ...gate, vmId: 'vm-1', kind: 'kernel' })
  sock.end('hello')
  await ready
  assert.equal(await readAll(sock), 'early:HELLO')
  assert.equal(gate.seen[0].vm, 'vm-1')
})

test('dialGate refuses a gate whose certificate is not the pinned one, before sending anything', async (t) => {
  const gate = await fakeGate(t)
  await assert.rejects(dialGate({ ...gate, certSha256: '0'.repeat(64), vmId: 'vm-1', kind: 'kernel' }), {
    code: 'gate_cert_mismatch',
  })
  await assert.rejects(dialGate({ ...gate, certSha256: null, kind: 'ping' }), { code: 'gate_cert_mismatch' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(gate.seen, [], 'no preface (token) reached a mismatched gate')
})

test('dialGate reports refusals through ready and silence as unreachable', async (t) => {
  const gate = await fakeGate(t)
  const missing = await dialGate({ ...gate, vmId: 'vm-9', kind: 'worker' })
  await assert.rejects(missing.ready, { code: 'gate_no_socket' })
  const badToken = await dialGate({ ...gate, token: 'b'.repeat(64), vmId: 'vm-1', kind: 'worker' })
  await assert.rejects(badToken.ready, { code: 'gate_auth' })
  const held = []
  const silent = net.createServer((sock) => held.push(sock))
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    for (const sock of held) sock.destroy()
    silent.close()
  })
  await assert.rejects(dialGate({ ...gate, port: silent.address().port, kind: 'ping', timeoutMs: 150 }), {
    code: 'gate_unreachable',
  })
})

test('gate container: root keeps only DAC_OVERRIDE, only tls/ is writable, spec follows the config', () => {
  const root = { uid: 0, gid: 0, root: '/root/.vm2api' }
  const body = gateConfigBody({ host: root, link: { port: 7790, token: 't' } })
  assert.deepEqual(JSON.parse(body), {
    listen: '0.0.0.0:7790',
    root: '/root/.vm2api',
    token: 't',
    tls_dir: '/etc/kin-slot-gate/tls',
  })
  const a = gateContainer({ host: root, imageRef: 'vm2api/kin-slot-x:1', body, binaryDigest: 'd' })
  assert.deepEqual(a.spec.HostConfig.CapDrop, ['ALL'])
  assert.deepEqual(a.spec.HostConfig.CapAdd, ['DAC_OVERRIDE'])
  assert.equal(a.spec.HostConfig.ReadonlyRootfs, true)
  assert.deepEqual(a.spec.HostConfig.Binds, [
    '/root/.vm2api/gate:/etc/kin-slot-gate:ro',
    '/root/.vm2api/gate/tls:/etc/kin-slot-gate/tls',
    '/root/.vm2api/vms:/root/.vm2api/vms:ro',
  ])
  const user = gateContainer({
    host: { uid: 1000, gid: 1000, root: '/home/u/.vm2api' },
    imageRef: 'i',
    body,
    binaryDigest: 'd',
  })
  assert.deepEqual(user.spec.HostConfig.CapAdd, [])
  assert.notEqual(gateContainer({ host: root, imageRef: 'i', body: 'other', binaryDigest: 'd' }).digest, a.digest)
})

test('SocketRelay waits for the gate before forwarding bytes and can fall back to SSH safely', async (t) => {
  const gate = await fakeGate(t)
  const dir = shortDir(t)
  const sshAsked = []
  const mk = (name, dialDirect) => {
    const relay = new SocketRelay({
      socketPath: path.join(dir, name),
      remotePath: '/r',
      getClient: () => {
        sshAsked.push(name)
        if (name === 'm.sock') {
          const stream = new PassThrough()
          stream.close = () => stream.destroy()
          return { openssh_forwardOutStreamLocal: (_path, done) => done(null, stream) }
        }
        return null
      },
      dialDirect,
    })
    t.after(() => relay.stop())
    return relay
  }
  const direct = mk('d.sock', () => dialGate({ ...gate, vmId: 'vm-1', kind: 'worker' }))
  const fallback = mk('f.sock', async () => null)
  const missing = mk('m.sock', () => dialGate({ ...gate, vmId: 'vm-2', kind: 'worker' }))
  await Promise.all([direct.start(), fallback.start(), missing.start()])

  const c = net.connect(direct.socketPath)
  const reply = readAll(c)
  c.end('over the gate')
  assert.equal(await reply, 'OVER THE GATE')
  assert.equal(gate.seen[0].early, '')

  const switched = net.connect(missing.socketPath)
  const switchedReply = readAll(switched)
  switched.end('same vm via ssh')
  assert.equal(await switchedReply, 'same vm via ssh')
  assert.equal(gate.seen[1].early, '')

  const dropped = net.connect(fallback.socketPath)
  dropped.on('error', () => {})
  dropped.end('unavailable')
  await new Promise((resolve) => dropped.once('close', resolve))
  assert.deepEqual(sshAsked, ['m.sock', 'f.sock'])
})

function managerWithRepo(t, options = {}) {
  const db = new DatabaseSync(':memory:')
  for (const name of ['026_cluster_nodes.sql', '039_cluster_node_direct_links.sql']) {
    db.exec(fs.readFileSync(new URL(`../../src/lib/db/migrations/${name}`, import.meta.url), 'utf8'))
  }
  db.exec('PRAGMA foreign_keys = ON')
  t.after(() => db.close())
  const repo = new ClusterNodesRepo(db)
  repo.insert({
    id: 'node-a',
    label: 'A',
    host: '203.0.113.5',
    port: 22,
    username: 'root',
    auth_type: 'password',
    password: 'pw',
    host_key_alg: 'ssh-ed25519',
    host_key_sha256: 'SHA256:x',
  })
  const warnings = []
  const manager = new ClusterManager({
    repo,
    dataDir: os.tmpdir(),
    logger: { log() {}, warn: (m) => warnings.push(m) },
    ...options,
  })
  return { db, repo, manager, warnings }
}

test('an authenticated gate is still probed without SSH and keeps the original live stream', async (t) => {
  const gate = await fakeGate(t, { extra: 'connected:' })
  const socketDir = shortDir(t)
  const { repo, manager } = managerWithRepo(t, { socketDir })
  repo.setDirectLink('node-a', { address: gate.address, port: gate.port, token: TOKEN })
  repo.setDirectLinkCert('node-a', gate.certSha256)
  const link = { state: 'ready', stop() {} }
  t.mock.method(manager, '_attach', (node) => manager.links.set(node.id, link))
  t.after(() => manager.stop())
  bindPlacement({ manager, projectRoot: socketDir })
  t.after(() => unbindPlacement())
  manager.start()
  await manager.directProbes.get('node-a')
  const vm = { id: 'vm-1', node_id: 'node-a' }
  const { kernel } = await manager.ensureSlotRelays(vm.node_id, vm.id)
  const original = net.connect(kernel)
  t.after(() => original.destroy())
  assert.equal((await once(original, 'data'))[0].toString(), 'connected:')
  assert.equal(vmNodeDataPath(vm), 'ssh')

  link.state = 'backoff'
  await manager._probeDirect('node-a')
  assert.equal(gate.seen.filter(({ kind }) => kind === 'ping').length, 2)
  assert.equal(vmNodeDataPath(vm), 'direct')
  const reply = readAll(original)
  original.end('existing')
  assert.equal(await reply, 'EXISTING')

  const fresh = net.connect(kernel)
  t.after(() => fresh.destroy())
  const response = readAll(fresh)
  fresh.end('new')
  assert.equal(await response, 'connected:NEW')
  assert.equal(vmNodeDataPath({ ...vm, id: 'missing-relay' }), 'offline')
  link.state = 'error'
  assert.equal(vmNodeDataPath(vm), 'offline', 'fatal SSH errors are not treated as transient')
})

test('direct link: token and pin survive edits and never leave; failures fall back to SSH with backoff', async (t) => {
  const { db, repo, manager, warnings } = managerWithRepo(t)
  const gate = await fakeGate(t)

  await manager.setDirectLink('node-a', { address: '127.0.0.1', port: 1025 })
  const token = repo.getDirectLink('node-a').token
  assert.equal(await manager._dialDirect('node-a', 'vm-1', 'kernel'), null, 'no pin yet: SSH')
  assert.equal(manager.get('node-a').direct_link.state, 'pending')

  repo.setDirectLink('node-a', { address: gate.address, port: gate.port, token: TOKEN })
  repo.setDirectLinkCert('node-a', gate.certSha256)
  await manager.setDirectLink('node-a', { address: gate.address, port: gate.port })
  assert.equal(repo.getDirectLink('node-a').token, TOKEN, 'edit keeps the token')
  assert.notEqual(token, TOKEN)
  assert.equal(repo.getDirectLink('node-a').certSha256, gate.certSha256, 'edit keeps the pin')
  assert.equal(manager.get('node-a').direct_link.state, 'ok')
  const listed = JSON.stringify(manager.list())
  assert.equal(listed.includes(TOKEN), false)
  assert.equal(listed.includes(gate.certSha256), false)

  const conn = await manager._dialDirect('node-a', 'vm-1', 'kernel')
  conn.sock.end('ok')
  await conn.ready
  conn.sock.destroy()
  const missing = await manager._dialDirect('node-a', 'vm-2', 'kernel')
  await assert.rejects(missing.ready, { code: 'gate_no_socket' })
  assert.equal(manager.get('node-a').direct_link.state, 'ok', 'a missing slot socket is not a link fault')

  repo.setDirectLink('node-a', { address: gate.address, port: gate.port, token: 'c'.repeat(64) })
  const refused = await manager._dialDirect('node-a', 'vm-1', 'kernel')
  await assert.rejects(refused.ready, { code: 'gate_auth' })
  assert.match(warnings.at(-1), /gate_auth/)
  repo.setDirectLink('node-a', { address: gate.address, port: gate.port, token: TOKEN })
  const before = gate.seen.length
  assert.equal(await manager._dialDirect('node-a', 'vm-1', 'kernel'), null, 'still in backoff')
  assert.equal(gate.seen.length, before)
  assert.equal(manager.get('node-a').direct_link.state, 'down')
  assert.ok(manager.directState.get('node-a').downUntil <= Date.now() + DIRECT_LINK_BACKOFF_MS)
  await manager._probeDirect('node-a')
  assert.equal(manager.get('node-a').direct_link.state, 'ok', 'a good ping lifts the backoff')

  repo.setDirectLink('node-a', { address: '127.0.0.1', port: 1, token: TOKEN })
  assert.equal(await manager._dialDirect('node-a', 'vm-1', 'kernel'), null, 'unreachable: SSH')
  assert.match(warnings.at(-1), /gate_unreachable/)

  await manager.clearDirectLink('node-a')
  assert.equal(manager.get('node-a').direct_link, null)
  repo.setDirectLink('node-a', { address: gate.address, port: gate.port, token: TOKEN })
  db.prepare('DELETE FROM cluster_nodes WHERE id = ?').run('node-a')
  assert.equal(repo.getDirectLink('node-a'), null, 'removing the node drops its link')
})
