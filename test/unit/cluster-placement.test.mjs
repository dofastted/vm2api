import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'
import { ClusterManager } from '../../src/lib/cluster/cluster-manager.mjs'
import { remoteSlotOwner } from '../../src/lib/cluster/placement.mjs'
import { remoteIptablesScript, slotEgressNames } from '../../src/lib/cluster/remote-slot.mjs'
import {
  pullSlotCredentials,
  pushSlotCredentials,
  reconcileSlotCredentials,
  remoteSlotPath,
} from '../../src/lib/cluster/remote-slot-files.mjs'
import { slotImageSpec } from '../../src/lib/cluster/slot-image.mjs'
import { tarStream } from '../../src/lib/cluster/tar.mjs'
import { SocketRelay } from '../../src/lib/cluster/socket-relay.mjs'
import { connectSsh } from '../../src/lib/cluster/ssh-link.mjs'
import { iptablesPlan } from '../../src/lib/vm/egress.mjs'

const { Server, utils } = ssh2

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * In-memory SFTP + exec double: enough of ssh2's client surface for remote-slot-files.
 * `links` holds symlinks a guest planted; opening or reading through one fails like
 * O_EXCL / O_NOFOLLOW would, so a follow-the-link regression shows up as a leak.
 */
function fakeNode(files = new Map()) {
  const sftp = new EventEmitter()
  const ok = (cb, v) => setImmediate(() => cb(null, v))
  const fail = (cb, msg) => setImmediate(() => cb(Object.assign(new Error(msg), { code: 4 })))
  const modes = new Map()
  const links = new Map()
  const handles = new Map()
  sftp.open = (p, flags, attrs, cb) => {
    if (flags !== 'wx') return fail(cb, `unexpected flags ${flags}`)
    if (files.has(p) || links.has(p)) return fail(cb, 'EEXIST')
    const h = Buffer.from(String(handles.size))
    handles.set(h.toString(), { p, chunks: [] })
    files.set(p, Buffer.alloc(0))
    modes.set(p, attrs.mode)
    ok(cb, h)
  }
  sftp.write = (h, buf, off, len, _pos, cb) => {
    handles.get(h.toString()).chunks.push(Buffer.from(buf.subarray(off, off + len)))
    ok(cb)
  }
  sftp.fchmod = (h, mode, cb) => {
    modes.set(handles.get(h.toString()).p, mode)
    ok(cb)
  }
  sftp.fchown = (_h, _u, _g, cb) => ok(cb)
  sftp.close = (h, cb) => {
    const e = handles.get(h.toString())
    files.set(e.p, Buffer.concat(e.chunks))
    ok(cb)
  }
  sftp.unlink = (p, cb) => {
    files.delete(p)
    links.delete(p)
    ok(cb)
  }
  sftp.ext_openssh_rename = (from, to, cb) => {
    links.delete(to)
    files.set(to, files.get(from))
    modes.set(to, modes.get(from))
    files.delete(from)
    ok(cb)
  }
  sftp.symlink = (target, link, cb) => {
    links.set(link, target)
    ok(cb)
  }
  const client = {
    sftp: (cb) => ok(cb, sftp),
    exec: (cmd, cb) => {
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.close = () => {}
      ok(cb, stream)
      // readRemoteFileNoFollow: dd … | base64. Missing → exit 3; symlink → refused.
      // The path sits inside `bash -c '…'`, so its own quotes arrive as '\''…'\''.
      const m = /f='\\''(.+?)'\\''.*iflag=nofollow/.exec(cmd)
      let code = 0
      let out = ''
      if (m) {
        const p = m[1]
        if (links.has(p)) code = 1
        else if (!files.has(p)) code = 3
        else out = files.get(p).toString('base64')
      }
      setImmediate(() => {
        if (out) stream.emit('data', Buffer.from(out))
        if (code === 1) stream.stderr.emit('data', Buffer.from('Too many levels of symbolic links'))
        stream.emit('exit', code)
        stream.emit('close')
      })
    },
  }
  const host = { uid: 1000, gid: 1000, home: '/home/ubuntu', root: '/home/ubuntu/.vm2api', sudo: true }
  return {
    files,
    modes,
    links,
    session: { nodeId: 'node-t', client, host },
    remoteCred: `${host.root}/vms/vm-07/claude/credentials.json`,
  }
}

function localSlot(cred) {
  const slotDir = path.join(tmpDir('kin-remote-slot-'), 'vm-07')
  fs.mkdirSync(path.join(slotDir, 'cli-home', '.claude'), { recursive: true })
  if (cred != null) {
    const file = path.join(slotDir, 'cli-home', '.claude', 'credentials.json')
    fs.writeFileSync(file, cred)
    // Explicit chmod: the create mode is umask-masked (077 shells would turn 0444 into 0400).
    fs.chmodSync(file, 0o444)
  }
  return slotDir
}

const vm = { id: 'vm-07', node_id: 'node-t' }

test('start reconcile never overwrites a remote credential the slot already rotated', async () => {
  const node = fakeNode()
  node.files.set(node.remoteCred, Buffer.from('{"rt":"rotated"}'))
  const slotDir = localSlot('{"rt":"stale"}')
  const r = await reconcileSlotCredentials(vm, slotDir, node.session)
  assert.equal(r.pulled, true)
  assert.equal(node.files.get(node.remoteCred).toString(), '{"rt":"rotated"}', 'remote copy must stay authoritative')
  const local = path.join(slotDir, 'cli-home', '.claude', 'credentials.json')
  assert.equal(fs.readFileSync(local, 'utf8'), '{"rt":"rotated"}')
  assert.equal(fs.statSync(local).mode & 0o777, 0o444, 'local seal survives the pull')
})

test('start reconcile seeds an empty node dir from the local credential', async () => {
  const node = fakeNode()
  const slotDir = localSlot('{"rt":"first"}')
  const r = await reconcileSlotCredentials(vm, slotDir, node.session)
  assert.equal(r.pushed, true)
  assert.equal(node.files.get(node.remoteCred).toString(), '{"rt":"first"}')
  assert.equal(node.links.get(`${node.session.host.root}/vms/vm-07/claude/.credentials.json`), 'credentials.json')
})

test('explicit import replaces the node credential at 0600; identical pull is a no-op', async () => {
  const node = fakeNode()
  node.files.set(node.remoteCred, Buffer.from('{"rt":"old-account"}'))
  const slotDir = localSlot('{"rt":"imported"}')
  fs.chmodSync(path.join(slotDir, 'cli-home', '.claude', 'credentials.json'), 0o777)
  await pushSlotCredentials(vm, slotDir, node.session)
  assert.equal(node.files.get(node.remoteCred).toString(), '{"rt":"imported"}')
  assert.equal(node.modes.get(node.remoteCred), 0o600, 'a 0777 local checkout must not leak its mode to the node')
  assert.deepEqual(await pullSlotCredentials(vm, slotDir, node.session), { pulled: false, reason: 'same' })
})

test('a guest-planted symlink at the credential path is refused, not followed', async () => {
  const node = fakeNode()
  const sibling = `${node.session.host.root}/vms/vm-08/claude/credentials.json`
  node.files.set(sibling, Buffer.from('{"rt":"sibling-secret"}'))
  node.links.set(node.remoteCred, sibling)
  const slotDir = localSlot('{"rt":"mine"}')
  await assert.rejects(pullSlotCredentials(vm, slotDir, node.session), { code: 'remote_read_refused' })
  const local = path.join(slotDir, 'cli-home', '.claude', 'credentials.json')
  assert.equal(fs.readFileSync(local, 'utf8'), '{"rt":"mine"}', 'sibling credential must not reach the control plane')

  // An import replaces the link itself; the sibling file keeps its bytes.
  await pushSlotCredentials(vm, slotDir, node.session)
  assert.equal(node.files.get(sibling).toString(), '{"rt":"sibling-secret"}')
  assert.equal(node.links.has(node.remoteCred), false)
  assert.equal(node.files.get(node.remoteCred).toString(), '{"rt":"mine"}')
})

test('node paths keep ~/.claude in the host-owned mount, everything else in place', () => {
  assert.equal(remoteSlotPath('cli-home/.claude/settings.json'), 'claude/settings.json')
  assert.equal(remoteSlotPath('run/kernel.json'), 'run/kernel.json')
  assert.equal(remoteSlotPath('machine-id'), 'machine-id')
})

test('remote slot runs as the SSH user unless that user is root', () => {
  assert.deepEqual(remoteSlotOwner({ uid: 1000, gid: 1001 }, { id: 'vm-03' }), { uid: 1000, gid: 1001 })
  const rootOwner = remoteSlotOwner({ uid: 0, gid: 0 }, { id: 'vm-03' })
  assert.equal(rootOwner.uid, 10003)
})

test('remote iptables script mirrors applyIptables semantics', () => {
  const plan = iptablesPlan({
    chain: 'KEGabc',
    bridge: 'kegabc',
    subnet: '172.30.0.0/16',
    tcpPort: 20000,
    dnsPort: 20001,
  })
  const script = remoteIptablesScript(plan, { sudo: true })
  const lines = script.split('\n')
  assert.equal(lines[0], 'set -e')
  assert.match(lines[1], /^sudo -n iptables '-t' 'nat' '-N' 'KEGabc' 2>\/dev\/null \|\| true$/)
  // -C guards exactly the following -A/-I; both halves on one line.
  assert.match(lines[2], /'-C' 'PREROUTING'.*\|\| sudo -n iptables .*'-A' 'PREROUTING'/)
  assert.ok(lines.at(-1).includes("'-C' 'FORWARD'") && lines.at(-1).includes("'-I' 'FORWARD' '1'"))
  assert.ok(script.includes("'!'"), 'negation is passed as its own quoted arg')
  const guards = plan.add.filter((row) => row.includes('-C')).length
  assert.equal(lines.length, 1 + plan.add.length - guards, '-C rows fold into their guarded row')
  const inputLines = lines.filter((line) => line.includes("'INPUT'"))
  assert.equal(inputLines.length, 2)
  for (const line of inputLines) {
    assert.match(line, /'-C' 'INPUT'.*\|\| sudo -n iptables .*'-I' 'INPUT' '1'/)
    assert.ok(line.includes("'-i' 'kegabc' '-s' '172.30.0.0/16' '-d' '172.30.0.0/16'"))
  }
  assert.doesNotMatch(remoteIptablesScript(plan, { sudo: false }), /sudo/)
})

test('a node SOCKS exit is named after its slot; kernel names stay collision-free', () => {
  const a = slotEgressNames('vm-02')
  assert.equal(a.slot, 'kin-02')
  assert.equal(a.egress, 'kin-02-egress')
  assert.equal(a.network, 'kin-02-net')
  // Linux caps iface names at 15; long ids sharing a prefix must still get distinct bridges/chains.
  const long1 = slotEgressNames('loutish-arches-3gicloudcom')
  const long2 = slotEgressNames('loutish-arches-3hicloudcom')
  for (const n of [a, long1, long2]) assert.ok(n.bridge.length <= 15, n.bridge)
  assert.notEqual(long1.bridge, long2.bridge)
  assert.notEqual(long1.chain, long2.chain)
  assert.notDeepEqual(long1.ports, long2.ports)
})

function fakeElf(file, fill) {
  const buf = Buffer.alloc(128, fill)
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0)
  buf.writeUInt16LE(62, 18)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buf)
}

test('slot image tag follows payload bytes only; a VERSION bump keeps the image', (t) => {
  const root = tmpDir('kin-slot-image-')
  fs.writeFileSync(path.join(root, 'VERSION'), '9.9.9\n')
  for (const f of [
    'share/wrap-cli/cli-node',
    'share/wrap-cli/cc-node',
    'bin/kin-kernel',
    'bin/kin-worker',
    'bin/kin-egress',
  ]) {
    fakeElf(path.join(root, f), 1)
  }
  fakeElf(path.join(root, 'bin/kin-codex-kernel'), 1)
  const envKeys = [
    'KIN_KERNEL_BIN',
    'KIN_WORKER_BIN',
    'KIN_EGRESS_BIN',
    'KIN_CODEX_KERNEL_BIN',
    'KIN_WRAP_CLI_ROOT',
    'KIN_CLUSTER_WORKER_BIN',
    'KIN_CLUSTER_EGRESS_BIN',
  ]
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]))
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  for (const k of envKeys) delete process.env[k]
  process.env.KIN_CODEX_KERNEL_BIN = path.join(root, 'bin/kin-codex-kernel')
  // Use this test's amd64 fixtures independently of native controller defaults.
  process.env.KIN_CLUSTER_WORKER_BIN = path.join(root, 'bin/kin-worker')
  process.env.KIN_CLUSTER_EGRESS_BIN = path.join(root, 'bin/kin-egress')
  fs.chmodSync(process.env.KIN_CODEX_KERNEL_BIN, 0o755)

  const a = slotImageSpec(root, 'ubuntu-24.04')
  assert.match(a.ref, /^vm2api\/kin-slot-ubuntu-24\.04:[0-9a-f]{12}$/)
  const kvm = slotImageSpec(root, 'ubuntu-24.04', { runtime: 'kvm' })
  assert.match(kvm.ref, /^vm2api\/kin-slot-kvm-ubuntu-24\.04:[0-9a-f]{12}$/)
  assert.notEqual(kvm.ref, a.ref)
  fs.writeFileSync(path.join(root, 'VERSION'), '9.9.10\n')
  assert.equal(
    slotImageSpec(root, 'ubuntu-24.04').ref,
    a.ref,
    'release with unchanged binaries must not orphan node images',
  )
  const cli = path.join(root, 'share/wrap-cli/cli-node')
  fakeElf(cli, 2)
  fs.utimesSync(cli, new Date(), new Date(Date.now() + 5000))
  assert.notEqual(slotImageSpec(root, 'ubuntu-24.04').ref, a.ref, 'rebuilt cli-node = new image')

  fs.writeFileSync(path.join(root, 'bin/kin-worker'), '#!/bin/sh\n')
  assert.throws(() => slotImageSpec(root, 'ubuntu-24.04'), { code: 'slot_payload_invalid' })
  assert.throws(() => slotImageSpec(root, 'nope-os'), { code: 'invalid_kernel' })
})

test('amd64 node payload stays separate from native ARM control helpers', (t) => {
  const root = tmpDir('kin-arm-cluster-payload-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const file of [
    'share/wrap-cli/cli-node',
    'share/wrap-cli/cc-node',
    'bin/kin-kernel',
    'bin/kin-codex-kernel',
    'bin/kin-worker',
    'bin/kin-egress',
    'amd64/kin-worker',
    'amd64/kin-egress',
  ]) {
    fakeElf(path.join(root, file), 1)
  }
  for (const name of ['kin-worker', 'kin-egress']) {
    const file = path.join(root, 'bin', name)
    const arm = fs.readFileSync(file)
    arm.writeUInt16LE(183, 18) // ELF e_machine: AArch64.
    fs.writeFileSync(file, arm)
  }
  const envKeys = [
    'KIN_KERNEL_BIN',
    'KIN_WORKER_BIN',
    'KIN_EGRESS_BIN',
    'KIN_CODEX_KERNEL_BIN',
    'KIN_WRAP_CLI_ROOT',
    'KIN_CLUSTER_WORKER_BIN',
    'KIN_CLUSTER_EGRESS_BIN',
  ]
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  for (const key of envKeys) delete process.env[key]
  process.env.KIN_WORKER_BIN = path.join(root, 'bin', 'kin-worker')
  process.env.KIN_CODEX_KERNEL_BIN = path.join(root, 'bin', 'kin-codex-kernel')
  fs.chmodSync(process.env.KIN_CODEX_KERNEL_BIN, 0o755)
  process.env.KIN_CLUSTER_WORKER_BIN = path.join(root, 'amd64', 'kin-worker')
  process.env.KIN_CLUSTER_EGRESS_BIN = path.join(root, 'amd64', 'kin-egress')
  const payload = slotImageSpec(root, 'ubuntu-24.04')
  for (const name of ['kin-worker', 'kin-egress']) {
    const entry = payload.files.find((file) => file.name === `usr/local/bin/${name}`)
    assert.equal(entry.src, path.join(root, 'amd64', name))
    assert.equal(fs.readFileSync(entry.src).readUInt16LE(18), 62)
    assert.equal(fs.readFileSync(path.join(root, 'bin', name)).readUInt16LE(18), 183)
  }
  process.env.KIN_CLUSTER_WORKER_BIN = process.env.KIN_WORKER_BIN
  assert.throws(() => slotImageSpec(root, 'ubuntu-24.04'), { code: 'slot_payload_invalid' })
})

test('tar stream round-trips through system tar with modes intact', async (t) => {
  const dir = tmpDir('kin-tar-')
  const src = path.join(dir, 'blob')
  fs.writeFileSync(src, Buffer.alloc(1000, 7))
  const chunks = []
  for await (const c of tarStream([
    { name: 'Dockerfile', body: Buffer.from('FROM x\n'), mode: 0o644 },
    { name: 'opt/kin/blob', src, mode: 0o755 },
  ]))
    chunks.push(c)
  const tarFile = path.join(dir, 'ctx.tar')
  fs.writeFileSync(tarFile, Buffer.concat(chunks))
  let listing
  try {
    listing = execFileSync('tar', ['-tvf', tarFile], { encoding: 'utf8' })
  } catch {
    t.skip('tar unavailable')
    return
  }
  assert.match(listing, /-rw-r--r--.* Dockerfile/)
  assert.match(listing, /-rwxr-xr-x.* 1000 .*opt\/kin\/blob/)
  const out = path.join(dir, 'x')
  fs.mkdirSync(out)
  execFileSync('tar', ['-xf', tarFile, '-C', out])
  assert.ok(fs.readFileSync(path.join(out, 'opt/kin/blob')).equals(fs.readFileSync(src)))
})

test('socket relay resolves the remote path lazily and reaches a unix socket over streamlocal', async (t) => {
  const hostKey = utils.generateKeyPairSync('ed25519')
  const asked = []
  const server = new Server({ hostKeys: [hostKey.private] }, (conn) => {
    conn.on('authentication', (ctx) => ctx.accept())
    conn.on('ready', () => {})
    conn.on('error', () => {})
    conn.on('session', () => {})
    conn.on('openssh.streamlocal', (accept, reject, info) => {
      asked.push(info.socketPath)
      if (info.socketPath !== '/remote/run/kernel.sock') return reject()
      const ch = accept()
      // Like a hijacked `docker exec`: read until the client half-closes, answer afterwards.
      const got = []
      ch.on('data', (d) => got.push(d))
      ch.on('end', () =>
        setTimeout(() => {
          ch.end(Buffer.concat([Buffer.from('echo:'), ...got]))
        }, 30),
      )
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { client } = await connectSsh({
    host: '127.0.0.1',
    port: server.address().port,
    username: 'u',
    authType: 'password',
    password: 'x',
  })
  const dir = tmpDir('kin-relay-')
  let target = '/remote/run/kernel.sock'
  const relay = new SocketRelay({
    socketPath: path.join(dir, 'kernel.sock'),
    remotePath: async () => target,
    getClient: () => client,
  })
  t.after(async () => {
    await relay.stop()
    client.end()
    server.close()
  })
  await relay.start()
  assert.equal(fs.statSync(relay.socketPath).mode & 0o777, 0o600)
  const reply = await new Promise((resolve, reject) => {
    const chunks = []
    const s = net.connect({ path: relay.socketPath, allowHalfOpen: true }, () => s.end('ping'))
    s.on('data', (d) => chunks.push(d))
    s.once('close', () => resolve(Buffer.concat(chunks).toString()))
    s.once('error', reject)
  })
  assert.equal(reply, 'echo:ping', 'output after the client half-closes must still arrive')

  target = '/remote/run/missing.sock'
  const closed = await new Promise((resolve) => {
    const s = net.connect(relay.socketPath)
    s.once('close', () => resolve(true))
    s.on('error', () => {})
  })
  assert.equal(closed, true, 'a missing remote socket closes the local connection (caller sees not-ready)')
  assert.deepEqual(asked, ['/remote/run/kernel.sock', '/remote/run/missing.sock'])
})

test('a node with placed VMs cannot be removed', async () => {
  const manager = new ClusterManager({
    repo: { get: () => ({ id: 'n1' }), dependentsOf: () => [] },
    dataDir: '/tmp',
    vmsOnNode: () => [{ id: 'vm-02' }],
  })
  await assert.rejects(manager.remove('n1'), { code: 'node_has_vms' })
})
