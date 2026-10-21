import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { getDb } from '../../src/lib/db/database.mjs'
import { ClusterManager } from '../../src/lib/cluster/cluster-manager.mjs'
import {
  describeNativePayload,
  isDarwinArm64MachO,
  NATIVE_PAYLOAD_FILES,
  remoteNativePayloadDir,
} from '../../src/lib/cluster/native-payload.mjs'
import {
  nativeLabels,
  nativeServicePlists,
  nativeSlotPaths,
  nativeUnsupported,
  parseLaunchctlPrint,
  renderPlist,
} from '../../src/lib/cluster/native-slot.mjs'
import { nodePlatformOf } from '../../src/lib/cluster/node-edit.mjs'
import { nodeHostCommand, NODE_HOST_COMMAND, parseNodeHost } from '../../src/lib/cluster/node-host.mjs'
import {
  bindPlacement,
  isNativeNodeVm,
  nodePlatform,
  unbindPlacement,
  vmNodeReady,
} from '../../src/lib/cluster/placement.mjs'
import { ClusterNodesRepo } from '../../src/lib/db/repos/cluster-nodes-repo.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { slotHost } from '../../src/lib/vm/slot-host.mjs'

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function thinArm64(extra = '') {
  const head = Buffer.alloc(32)
  head.writeUInt32LE(0xfeedfacf, 0)
  head.writeUInt32LE(0x0100000c, 4)
  return Buffer.concat([head, Buffer.from(extra)])
}

function fatWith(...cpuTypes) {
  const head = Buffer.alloc(8 + cpuTypes.length * 20)
  head.writeUInt32BE(0xcafebabe, 0)
  head.writeUInt32BE(cpuTypes.length, 4)
  cpuTypes.forEach((cpu, i) => head.writeUInt32BE(cpu, 8 + i * 20))
  return head
}

function payloadDir(t, files = {}) {
  const dir = tmpDir('kin-darwin-payload-')
  for (const name of NATIVE_PAYLOAD_FILES) fs.writeFileSync(path.join(dir, name), files[name] ?? thinArm64(name))
  const previous = process.env.KIN_DARWIN_PAYLOAD_DIR
  process.env.KIN_DARWIN_PAYLOAD_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.KIN_DARWIN_PAYLOAD_DIR
    else process.env.KIN_DARWIN_PAYLOAD_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test('darwin/arm64 Mach-O detection accepts thin and universal binaries only', () => {
  assert.equal(isDarwinArm64MachO(thinArm64()), true)
  assert.equal(isDarwinArm64MachO(fatWith(0x01000007, 0x0100000c)), true)
  assert.equal(isDarwinArm64MachO(fatWith(0x01000007)), false, 'x86_64-only universal binary')
  const x86 = thinArm64()
  x86.writeUInt32LE(0x01000007, 4)
  assert.equal(isDarwinArm64MachO(x86), false)
  assert.equal(isDarwinArm64MachO(Buffer.from('\x7fELF\x02\x01\x01\x00')), false)
  // A Java class file shares 0xcafebabe; its version word is far above any arch count.
  const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41])
  assert.equal(isDarwinArm64MachO(javaClass), false)
  assert.equal(isDarwinArm64MachO(Buffer.alloc(4)), false)
})

test('native payload names the missing or foreign file and hashes content', (t) => {
  const dir = payloadDir(t)
  const first = describeNativePayload('/unused')
  assert.equal(first.dir, dir)
  assert.deepEqual(
    first.files.map((f) => f.name),
    NATIVE_PAYLOAD_FILES,
  )
  assert.match(first.digest, /^[0-9a-f]{16}$/)
  assert.equal(describeNativePayload('/unused').digest, first.digest)

  fs.writeFileSync(path.join(dir, 'cli-node'), thinArm64('rebuilt with a different body'))
  assert.notEqual(describeNativePayload('/unused').digest, first.digest)

  fs.writeFileSync(path.join(dir, 'cc-node'), Buffer.from('\x7fELF\x02\x01\x01\x00linux'))
  assert.throws(
    () => describeNativePayload('/unused'),
    (err) => {
      assert.equal(err.code, 'native_payload_invalid')
      assert.match(err.message, /cc-node/)
      return true
    },
  )
  fs.rmSync(path.join(dir, 'kin-kernel'))
  assert.throws(
    () => describeNativePayload('/unused'),
    (err) => {
      assert.equal(err.code, 'native_payload_missing')
      assert.match(err.message, /kin-kernel/)
      return true
    },
  )
  assert.equal(remoteNativePayloadDir('/Users/u/.vm2api', 'abc'), '/Users/u/.vm2api/native/abc')
})

test('launchd plists run the kernel and sidecar from the slot tree with escaped values', () => {
  const p = nativeSlotPaths('/Users/o&b/.vm2api', 'vm-07', 'd1g3st')
  assert.equal(p.payload, '/Users/o&b/.vm2api/native/d1g3st')
  assert.equal(p.claude, '/Users/o&b/.vm2api/vms/vm-07/claude')
  const vm = { id: 'vm-07', timezone: 'Asia/Tokyo', locale: 'ja_JP.UTF-8' }
  const plists = nativeServicePlists(vm, p)
  assert.deepEqual(nativeLabels('vm-07'), {
    kernel: 'com.vm2api.slot.vm-07.kernel',
    telemetry: 'com.vm2api.slot.vm-07.telemetry',
  })
  assert.equal(plists.kernel.path, '/Users/o&b/.vm2api/vms/vm-07/launchd/com.vm2api.slot.vm-07.kernel.plist')
  const kernel = plists.kernel.body
  assert.match(kernel, /<string>\/Users\/o&amp;b\/\.vm2api\/native\/d1g3st\/kin-kernel<\/string>/)
  assert.match(kernel, /<string>--gateway-worker<\/string>/)
  assert.match(kernel, /<string>\/Users\/o&amp;b\/\.vm2api\/vms\/vm-07\/run\/kernel\.json<\/string>/)
  assert.match(
    kernel,
    /<key>CLAUDE_CONFIG_DIR<\/key>\s*<string>\/Users\/o&amp;b\/\.vm2api\/vms\/vm-07\/claude<\/string>/,
  )
  assert.match(kernel, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(kernel, /<key>Umask<\/key>\s*<integer>63<\/integer>/)
  assert.doesNotMatch(kernel, /o&b/, 'raw ampersand must be escaped')
  const telemetry = plists.telemetry.body
  assert.match(telemetry, /<string>telemetry<\/string>/)
  assert.match(telemetry, /<key>SuccessfulExit<\/key>\s*<false\/>/)
  assert.match(renderPlist({ a: '<x y="1">' }), /<string>&lt;x y=&quot;1&quot;&gt;<\/string>/)
})

test('launchctl print parsing covers running, exited and missing jobs', () => {
  const running =
    'com.x = {\n\tactive count = 1\n\tstate = running\n\truns = 3\n\tpid = 692\n\tlast exit code = (never exited)\n'
  assert.deepEqual(parseLaunchctlPrint(running), { state: 'running', pid: 692, last_exit_code: null, runs: 3 })
  const exited = 'com.x = {\n\tstate = not running\n\truns = 2\n\tlast exit code = 78: EX_CONFIG\n'
  assert.deepEqual(parseLaunchctlPrint(exited), { state: 'stopped', pid: null, last_exit_code: 78, runs: 2 })
  // Nested dictionaries repeat `state =` deeper; only the job's own top-level line counts.
  const nested = 'com.x = {\n\tstate = waiting\n\tendpoints = {\n\t\tstate = running\n\t}\n'
  assert.equal(parseLaunchctlPrint(nested).state, 'stopped')
  assert.equal(parseLaunchctlPrint('Could not find service "x" in domain', 113).state, 'missing')
  assert.equal(parseLaunchctlPrint('garbage').state, 'unknown')
})

test('only Claude slots on the node network exit can run natively', () => {
  const local = { id: 'vm-1', proxy: { id: 'px-local' } }
  assert.equal(nativeUnsupported(local, {}), null)
  // Same as a Docker slot: no bound exit at all is not a runnable slot.
  assert.equal(nativeUnsupported({ ...local, proxy: null }, {})?.code, 'native_proxy_unsupported')
  assert.equal(
    nativeUnsupported({ ...local, proxy: { id: 'px-1', type: 'socks5', host: '203.0.113.9', port: 1080 } }, {}).code,
    'native_proxy_unsupported',
  )
  assert.equal(nativeUnsupported({ ...local, kind: 'codex' }, {})?.code, 'native_codex_unsupported')
  assert.equal(nativeUnsupported({ ...local, dataplane: 'crag' }, {})?.code, 'native_crag_unsupported')
  assert.equal(nativeUnsupported({ ...local, runtime_type: 'kvm' }, {})?.code, 'native_kvm_unsupported')
})

test('node platform comes from uname -s and the darwin host stats parse like /proc', () => {
  assert.equal(nodePlatformOf('Darwin'), 'darwin')
  assert.equal(nodePlatformOf('Linux'), 'linux')
  assert.equal(nodePlatformOf(''), 'linux')
  assert.equal(nodeHostCommand('linux'), NODE_HOST_COMMAND)
  assert.notEqual(nodeHostCommand('darwin'), NODE_HOST_COMMAND)
  assert.match(nodeHostCommand('darwin'), /vm_stat/)
  const stats = parseNodeHost(
    'ncpu 10\nload  4.17 4.25 3.51 \nMemTotal: 33554432\nMemAvailable: 10110576\ncg 1048576 0\n',
  )
  assert.equal(stats.cpu_count, 10)
  assert.equal(stats.load1, 4.17)
  assert.equal(stats.mem_total, 33554432 * 1024)
  assert.equal(stats.containers_mem, 1048576)
})

test('platform is stored per node without touching the edit version', async () => {
  const db = getDb()
  const repo = new ClusterNodesRepo(db)
  const node = await repo.insert({
    id: 'node-m',
    label: 'mini',
    host: 'mini.example.test',
    port: 22,
    username: 'kin',
    auth_type: 'key',
    private_key: 'k',
    host_key_alg: 'ssh-ed25519',
    host_key_sha256: 'SHA256:x',
  })
  assert.equal(await repo.platform('node-m'), 'linux')
  assert.equal(await repo.setPlatform('node-m', 'darwin'), true)
  assert.equal(await repo.platform('node-m'), 'darwin')
  assert.equal((await repo.get('node-m')).updated_at, node.updated_at)
  assert.equal(await repo.platform('node-gone'), null)
  await db.close()
})

test('remote host discovery waits for the persisted platform and preserves one in-flight read', async () => {
  let releaseSave
  const savePending = new Promise((resolve) => {
    releaseSave = resolve
  })
  let signalSave
  const saveStarted = new Promise((resolve) => {
    signalSave = resolve
  })
  const manager = new ClusterManager({
    repo: {
      setPlatform: async () => {
        signalSave()
        await savePending
      },
    },
    dataDir: '/unused',
    logger: { log() {}, warn() {} },
  })
  manager.nodes.set('node-mac', { id: 'node-mac' })
  manager.platforms.set('node-mac', 'linux')
  const client = {
    exec(_command, callback) {
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.close = () => {}
      callback(null, stream)
      queueMicrotask(() => {
        stream.emit('data', Buffer.from('501\n20\n/Users/kin\nsudo\nDarwin\n'))
        stream.emit('exit', 0)
        stream.emit('close')
      })
    },
  }
  manager.links.set('node-mac', { state: 'ready', client })
  const pending = manager.remoteHost('node-mac')
  assert.equal(manager.remoteHost('node-mac'), pending)
  let settled = false
  pending.then(() => {
    settled = true
  })
  try {
    await saveStarted
    await Promise.resolve()
    assert.equal(settled, false)
  } finally {
    releaseSave()
  }
  assert.equal((await pending).platform, 'darwin')
  assert.equal(manager.nodePlatform('node-mac'), 'darwin')
})

function bindMac(t, { ready = true, root = '/Users/kin/.vm2api', projectRoot = '/unused' } = {}) {
  const manager = {
    nodePlatform: (id) => (id === 'node-mac' ? 'darwin' : 'linux'),
    nodeHostFacts: (id) => (id === 'node-mac' ? { root, uid: 501, gid: 20, platform: 'darwin' } : null),
    linkReady: () => ready,
    client: () => {
      throw Object.assign(new Error('offline in test'), { code: 'node_not_ready' })
    },
  }
  bindPlacement({ manager, projectRoot })
  t.after(() => unbindPlacement())
  return manager
}

test('a macOS node slot gets the native host: node paths, no Docker', (t) => {
  payloadDir(t)
  bindMac(t)
  const vm = { id: 'vm-07', node_id: 'node-mac' }
  assert.equal(nodePlatform('node-mac'), 'darwin')
  assert.equal(isNativeNodeVm(vm), true)
  assert.equal(isNativeNodeVm({ id: 'vm-08', node_id: 'node-linux' }), false)
  const host = slotHost(vm)
  assert.equal(host.native, true)
  assert.equal(host.supports('codex'), false)
  const digest = describeNativePayload('/unused').digest
  assert.equal(host.bins.cli, `/Users/kin/.vm2api/native/${digest}/cli-node`)
  assert.equal(host.bins.cc, `/Users/kin/.vm2api/native/${digest}/cc-node`)
  assert.equal(host.slotPaths(vm).run, '/Users/kin/.vm2api/vms/vm-07/run')
  assert.throws(
    () => host.dockerApi(),
    (err) => err.code === 'native_node_unsupported',
  )
  assert.throws(
    () => host.dockerEnv(),
    (err) => err.code === 'native_node_unsupported',
  )
  assert.equal(slotHost({ id: 'vm-08', node_id: 'node-linux' }).native, undefined)
  assert.equal(slotHost({ id: 'vm-09' }).kind, 'local')
})

test('kernel.json of a macOS slot points at node paths instead of container mounts', (t) => {
  payloadDir(t)
  const root = tmpDir('kin-native-cfg-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  bindMac(t, { projectRoot: root })
  const vm = { id: 'vm-07', node_id: 'node-mac' }
  const written = writeKernelConfig(root, vm, { token: 'tok', proxyUrl: '', proxyRequired: false })
  const doc = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  const digest = describeNativePayload(root).digest
  assert.equal(doc.socket_path, '/Users/kin/.vm2api/vms/vm-07/run/kernel.sock')
  assert.equal(doc.credential_path, '/Users/kin/.vm2api/vms/vm-07/claude/credentials.json')
  assert.equal(doc.claude_bin, `/Users/kin/.vm2api/native/${digest}/cli-node`)
  assert.equal(doc.runtime_kind, 'docker')
})

test('slots of a node whose SSH link is down are not schedulable', (t) => {
  bindMac(t, { ready: false })
  assert.equal(vmNodeReady({ id: 'vm-07', node_id: 'node-mac' }), false)
  assert.equal(vmNodeReady({ id: 'vm-09' }), true, 'local slots never depend on a node link')
  unbindPlacement()
  assert.equal(vmNodeReady({ id: 'vm-07', node_id: 'node-mac' }), true, 'no cluster bound: nothing to wait for')
})

test('kernel.json of a macOS slot whose node never connected is skipped, not written with container paths', (t) => {
  payloadDir(t)
  const root = tmpDir('kin-native-cfg-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manager = bindMac(t, { projectRoot: root })
  manager.nodeHostFacts = () => null
  const written = writeKernelConfig(root, { id: 'vm-07', node_id: 'node-mac' }, { token: 'tok' })
  assert.equal(written, null)
  assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-07', 'run', 'kernel.json')), false)
  // Once the slot has run, its own runtime record carries the node root.
  const known = { id: 'vm-07', node_id: 'node-mac', runtime: { remote_dir: '/Users/kin/.vm2api/vms/vm-07' } }
  const doc = JSON.parse(fs.readFileSync(writeKernelConfig(root, known, { token: 'tok' }).configPath, 'utf8'))
  assert.equal(doc.socket_path, '/Users/kin/.vm2api/vms/vm-07/run/kernel.sock')
})
