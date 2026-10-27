import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  shouldReplaceSlotContainer,
  ensureSlotImage,
  proxyEndpointFromUrl,
  proxyEndpointFromVm,
  readWorkerProxyEndpoint,
  readWorkerEgressMode,
  isSlotProxyDesynced,
  reloadSlotWorker,
  slotKernelAlive,
  slotContainerNetworkMismatch,
  slotWorkerNeedsRecreate,
  writeWorkerFiles,
  startVmRuntime,
  slotContainerCommand,
  CODEX_SLOT_ROLE,
} from '../../src/lib/vm/vm-runtime.mjs'
import { slotNetworkForVm } from '../../src/lib/vm/egress.mjs'

const running = { running: true, networkMode: 'host', image: 'kin-os/ubuntu:24.04' }
const stopped = { running: false, networkMode: 'host', image: 'kin-os/ubuntu:24.04' }

test('running slot is never replaced unless recreate is explicit', () => {
  assert.equal(
    shouldReplaceSlotContainer({ existing: running, recreate: false, network: 'bridge', image: 'other' }),
    false,
  )
  assert.equal(
    shouldReplaceSlotContainer({ existing: running, recreate: true, network: 'host', image: running.image }),
    true,
  )
})

test('stopped slot is replaced only when net or image is wrong', () => {
  assert.equal(
    shouldReplaceSlotContainer({ existing: stopped, recreate: false, network: 'host', image: stopped.image }),
    false,
  )
  assert.equal(
    shouldReplaceSlotContainer({ existing: stopped, recreate: false, network: 'bridge', image: stopped.image }),
    true,
  )
  assert.equal(
    shouldReplaceSlotContainer({ existing: stopped, recreate: false, network: 'host', image: 'other' }),
    true,
  )
})

test('stopped slot is replaced when runtime kind changes', () => {
  assert.equal(
    shouldReplaceSlotContainer({
      existing: stopped,
      recreate: false,
      network: 'host',
      image: stopped.image,
      runtime: 'docker',
    }),
    false,
  )
  assert.equal(
    shouldReplaceSlotContainer({
      existing: stopped,
      recreate: false,
      network: 'host',
      image: stopped.image,
      runtime: 'kvm',
    }),
    true,
  )
  assert.equal(
    shouldReplaceSlotContainer({
      existing: { ...stopped, runtime: 'kvm' },
      recreate: false,
      network: 'host',
      image: stopped.image,
      runtime: 'kvm',
    }),
    false,
  )
})

test('missing container is not replaced', () => {
  assert.equal(shouldReplaceSlotContainer({ existing: null, recreate: true }), false)
})

test('slotContainerNetworkMismatch compares docker network to bound proxy', () => {
  const vm = { id: 'vm-01', proxy: { id: 'px-new' } }
  const want = slotNetworkForVm(vm)
  assert.equal(want, 'kin-eg-px-new')
  assert.equal(slotContainerNetworkMismatch({ running: true, networkMode: 'kin-eg-px-old' }, vm), true)
  assert.equal(slotContainerNetworkMismatch({ running: true, networkMode: want }, vm), false)
  assert.equal(slotContainerNetworkMismatch({ running: true, networkMode: 'host' }, vm), true)
  assert.equal(slotContainerNetworkMismatch({ running: true, networkMode: null }, vm), true)
  assert.equal(slotContainerNetworkMismatch(null, vm), true)
  assert.equal(slotContainerNetworkMismatch({ running: true, networkMode: 'kin-eg-px-old' }, { id: 'vm-01' }), false)
})

test('reload recreates a docker slot when egress network mismatches', (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reload-net-'))
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }))
  const vm = { id: 'vm-04', proxy: { id: 'px-b', host: '1.2.3.4', port: 1080, url: 'socks5://u:p@1.2.3.4:1080' } }
  const paths = {
    socket: path.join(runDir, 'worker.sock'),
    kernelSocket: path.join(runDir, 'kernel.sock'),
  }
  fs.writeFileSync(paths.kernelSocket, '')
  const existing = { running: true, networkMode: 'kin-eg-px-a' }
  assert.equal(isSlotProxyDesynced(vm, runDir), false, 'transparent desync must not drive this path')
  assert.equal(slotWorkerNeedsRecreate(existing, vm, paths), true)
  assert.equal(
    shouldReplaceSlotContainer({
      existing,
      recreate: true,
      network: slotNetworkForVm(vm),
    }),
    true,
  )
})

test('reload restarts a docker slot when egress network matches', (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reload-net-ok-'))
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }))
  const vm = { id: 'vm-05', proxy: { id: 'px-a', host: '1.2.3.4', port: 1080 } }
  const paths = { kernelSocket: path.join(runDir, 'kernel.sock') }
  fs.writeFileSync(paths.kernelSocket, '')
  const existing = { running: true, networkMode: 'kin-eg-px-a' }
  assert.equal(slotWorkerNeedsRecreate(existing, vm, paths), false)
})

test('kvm running without relay sock is not recreated when the network matches', (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reload-kvm-ok-'))
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }))
  const vm = { id: 'vm-06', runtime: { type: 'kvm' }, proxy: { id: 'px-a' } }
  const paths = { kernelSocket: path.join(runDir, 'kernel.sock') }
  const existing = { running: true, networkMode: 'kin-eg-px-a', runtime: 'kvm' }
  assert.equal(slotKernelAlive(existing, paths, vm), true)
  assert.equal(slotWorkerNeedsRecreate(existing, vm, paths), false)
})

test('kvm runner on the wrong egress network is recreated', (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reload-kvm-net-'))
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }))
  const vm = { id: 'vm-07', runtime: { type: 'kvm' }, proxy: { id: 'px-b' } }
  const paths = { kernelSocket: path.join(runDir, 'kernel.sock') }
  const existing = { running: true, networkMode: 'kin-eg-px-a', runtime: 'kvm' }
  assert.equal(slotKernelAlive(existing, paths, vm), true, 'missing sock must not itself recreate KVM')
  assert.equal(slotWorkerNeedsRecreate(existing, vm, paths), true)
})

test('crash-looping kvm runner is replaced and recreated on reload even on the right network', (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reload-kvm-loop-'))
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }))
  const vm = { id: 'vm-08', runtime: { type: 'kvm' }, proxy: { id: 'px-a' } }
  const paths = { kernelSocket: path.join(runDir, 'kernel.sock') }
  const existing = { running: false, restarting: true, networkMode: 'kin-eg-px-a', runtime: 'kvm', image: 'img' }
  assert.equal(slotWorkerNeedsRecreate(existing, vm, paths), true)
  assert.equal(
    shouldReplaceSlotContainer({ existing, recreate: false, network: 'kin-eg-px-a', image: 'img', runtime: 'kvm' }),
    true,
  )
})

test('ensureSlotImage refreshes a cached tag and falls back to it when the registry is unreachable', () => {
  const calls = []
  const registry = (pullOk) => (argv) => {
    calls.push(argv.slice(0, 3).join(' '))
    return { ok: argv[1] === 'pull' ? pullOk : true }
  }
  assert.equal(ensureSlotImage('debian-12', { runtime: 'kvm', run: registry(true) }).action, 'pulled')
  assert.deepEqual(calls, ['docker pull ghcr.io/dofastted/kin-kvm-debian:12'])
  calls.length = 0
  assert.equal(ensureSlotImage('debian-12', { runtime: 'kvm', run: registry(false) }).action, 'present')
  assert.deepEqual(calls, ['docker pull ghcr.io/dofastted/kin-kvm-debian:12', 'docker image inspect'])
})

test('unbound slot does not recreate for a missing desired network', (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reload-nopx-'))
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }))
  const vm = { id: 'vm-08' }
  const paths = { kernelSocket: path.join(runDir, 'kernel.sock') }
  fs.writeFileSync(paths.kernelSocket, '')
  const existing = { running: true, networkMode: 'kin-eg-px-old' }
  assert.equal(slotNetworkForVm(vm), '')
  assert.equal(slotContainerNetworkMismatch(existing, vm), false)
  assert.equal(slotWorkerNeedsRecreate(existing, vm, paths), false)
})

test('reloadSlotWorker recreates on network mismatch before the KVM restart path', () => {
  const src = fs.readFileSync(new URL('../../src/lib/vm/vm-runtime.mjs', import.meta.url), 'utf8')
  const reload = src.slice(
    src.indexOf('export async function reloadSlotWorker'),
    src.indexOf('export function slotKernelAlive'),
  )
  assert.match(reload, /slotWorkerNeedsRecreate\(existing, vm, paths\)/)
  assert.ok(
    reload.indexOf('slotWorkerNeedsRecreate') < reload.indexOf('if (isKvmRuntime(vm)) {'),
    'network recreate must run before systemctl restart',
  )
})

test('writeWorkerFiles uses the desired kin-eg network even if the container is gone', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-worker-want-net-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = {
    id: 'vm-10',
    proxy: { id: 'px-new', host: '1.2.3.4', port: 1080, url: 'socks5://u:p@1.2.3.4:1080' },
  }
  writeWorkerFiles(vm, root, { routing: {} })
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-10', 'run', 'worker.json'), 'utf8'))
  assert.equal(doc.egress_mode, 'transparent')
  assert.equal(doc.proxy_url, '')
  assert.equal(doc.proxy_required, false)
})

test('writeWorkerFiles keeps the control-plane gid when chown succeeds', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-worker-group-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = { id: 'vm-10', proxy: { id: 'px-new', host: '1.2.3.4', port: 1080 } }
  const calls = []
  const real = fs.chownSync
  t.mock.method(fs, 'chownSync', (file, uid, gid) => {
    calls.push({ file, uid, gid })
    try {
      real.call(fs, file, uid, gid)
    } catch {}
  })
  writeWorkerFiles(vm, root, { routing: {} })
  const runDir = path.join(root, 'vms', 'vm-10', 'run')
  for (const name of ['.', 'worker.json', 'kernel.json']) {
    const stat = fs.statSync(path.join(runDir, name))
    assert.equal(stat.gid, process.getgid(), name)
  }
  assert.equal(fs.statSync(path.join(runDir, 'internal.token')).mode & 0o077, 0)
  assert.equal(
    calls.some((call) => call.file === runDir && call.gid === Number(process.env.KIN_VM_GID || 987)),
    false,
  )
})

test('writeWorkerFiles hands runtime files to the slot user when the gateway is root', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-worker-root-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const vm = { id: 'vm-10', proxy: { id: 'px-new', host: '1.2.3.4', port: 1080 } }
  const calls = []
  t.mock.method(process, 'getuid', () => 0)
  t.mock.method(fs, 'chownSync', (file, uid, gid) => {
    calls.push({ file, uid, gid })
  })
  writeWorkerFiles(vm, dir, { routing: {} })
  const runDir = path.join(dir, 'vms', 'vm-10', 'run')
  const slotGid = Number(process.env.KIN_VM_GID || 987)
  const slotUid = Number(process.env.KIN_VM_UID_BASE || 10000) + 10
  assert.equal(fs.statSync(runDir).mode & 0o777, 0o700)
  for (const name of ['worker.json', 'kernel.json', 'internal.token']) {
    const file = path.join(runDir, name)
    assert.equal(fs.statSync(file).mode & 0o077, 0, name)
    assert.ok(
      calls.some((call) => call.file.startsWith(file) && call.uid === slotUid && call.gid === slotGid),
      name,
    )
  }
})

test('root adopts an unchanged config left by the non-root gateway', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-worker-adopt-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const vm = { id: 'vm-10', proxy: { id: 'px-new', host: '1.2.3.4', port: 1080 } }
  writeWorkerFiles(vm, dir, { routing: {} })
  const runDir = path.join(dir, 'vms', 'vm-10', 'run')
  for (const name of ['worker.json', 'kernel.json']) {
    fs.chownSync(path.join(runDir, name), process.getuid(), process.getgid())
  }
  const calls = []
  t.mock.method(process, 'getuid', () => 0)
  t.mock.method(fs, 'chownSync', (file, uid, gid) => {
    calls.push({ file, uid, gid })
  })
  writeWorkerFiles(vm, dir, { routing: {} })
  const slotGid = Number(process.env.KIN_VM_GID || 987)
  const slotUid = Number(process.env.KIN_VM_UID_BASE || 10000) + 10
  for (const name of ['worker.json', 'kernel.json']) {
    assert.ok(
      calls.some((call) => call.file === path.join(runDir, name) && call.uid === slotUid && call.gid === slotGid),
      name,
    )
  }
})

for (const [id, index] of [
  ['account2example', 1],
  ['vm-02', 2],
]) {
  test(`writeWorkerFiles gives run/ the slot owner of its files when root (${id})`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-worker-owner-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    // Digits inside a named id are not a slot index; only vm-N or a bare number is (#740).
    const vm = { id, proxy: { id: 'px-new', host: '1.2.3.4', port: 1080 } }
    const calls = []
    t.mock.method(process, 'getuid', () => 0)
    t.mock.method(fs, 'chownSync', (file, uid, gid) => {
      calls.push({ file, uid, gid })
    })
    writeWorkerFiles(vm, dir, { routing: {} })
    const runDir = path.join(dir, 'vms', id, 'run')
    const slotUid = Number(process.env.KIN_VM_UID_BASE || 10000) + index
    const slotGid = Number(process.env.KIN_VM_GID || 987)
    const dirCalls = calls.filter((call) => call.file === runDir)
    assert.ok(dirCalls.length > 0)
    for (const call of dirCalls) assert.deepEqual([call.uid, call.gid], [slotUid, slotGid])
    assert.ok(calls.some((call) => call.file.startsWith(path.join(runDir, 'kernel.json')) && call.uid === slotUid))
  })
}

test('proxyEndpoint strips userinfo', () => {
  assert.equal(proxyEndpointFromUrl('socks5h://user:pass@72.1.181.43:5437'), '72.1.181.43:5437')
  assert.equal(proxyEndpointFromVm({ proxy: { host: '72.1.181.43', port: 5437 } }), '72.1.181.43:5437')
})

test('isSlotProxyDesynced compares worker.json to vm.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-proxy-sync-'))
  const vm = { id: 'vm-02', proxy: { host: '72.1.181.43', port: 5437, url: 'socks5://u:p@72.1.181.43:5437' } }
  fs.mkdirSync(path.join(root, 'vms', 'vm-02', 'run'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-02', 'run', 'worker.json'),
    JSON.stringify({
      proxy_url: 'socks5h://old:pass@154.9.177.229:5509',
    }),
  )
  assert.equal(readWorkerProxyEndpoint(root, 'vm-02'), '154.9.177.229:5509')
  assert.equal(isSlotProxyDesynced(vm, root), true)
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-02', 'run', 'worker.json'),
    JSON.stringify({
      proxy_url: 'socks5h://u:p@72.1.181.43:5437',
    }),
  )
  assert.equal(isSlotProxyDesynced(vm, root), false)
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-02', 'run', 'worker.json'),
    JSON.stringify({
      proxy_url: '',
      proxy_required: false,
    }),
  )
  assert.equal(isSlotProxyDesynced(vm, root), true)
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-02', 'run', 'worker.json'),
    JSON.stringify({
      proxy_url: '',
      proxy_required: false,
      egress_mode: 'transparent',
    }),
  )
  assert.equal(isSlotProxyDesynced(vm, root), false)
  fs.rmSync(path.join(root, 'vms', 'vm-02', 'run', 'worker.json'))
  assert.equal(readWorkerProxyEndpoint(root, 'vm-02'), undefined)
  assert.equal(isSlotProxyDesynced(vm, root), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('reload writes transparent egress for local exit without a SOCKS url', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reload-local-'))
  const vm = {
    id: 'vm-09',
    proxy_cli_enabled: true,
    proxy: { id: 'px-local', scheme: 'local', host: 'local', port: 0, url: null },
  }
  const result = await reloadSlotWorker(vm, root, { routing: {} })
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-09', 'run', 'worker.json'), 'utf8'))
  assert.equal(doc.proxy_url, '')
  assert.equal(doc.proxy_required, false)
  assert.equal(doc.egress_mode, 'transparent')
  assert.equal(readWorkerEgressMode(root, 'vm-09'), 'transparent')
  assert.notEqual(result.error, 'slot SOCKS5 proxy is required')
  fs.rmSync(root, { recursive: true, force: true })
})

test('IPv6 address spelling does not desynchronize a slot, a changed endpoint does', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ipv6-sync-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = { id: 'vm-03', proxy: { host: '[2001:0db8::1]', port: 1080 } }
  const run = path.join(root, 'vms', vm.id, 'run')
  fs.mkdirSync(run, { recursive: true })
  const config = path.join(run, 'worker.json')
  fs.writeFileSync(config, JSON.stringify({ proxy_url: 'socks5h://user:p%40ss@[2001:db8::1]:1080' }))
  assert.equal(isSlotProxyDesynced(vm, root), false)
  fs.writeFileSync(config, JSON.stringify({ proxy_url: 'socks5h://user:p%40ss@[2001:db8::2]:1080' }))
  assert.equal(isSlotProxyDesynced(vm, root), true)
})

test('a running slot with a bound kernel.sock is live even though worker.sock never exists', (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-alive-'))
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }))
  const paths = { socket: path.join(runDir, 'worker.sock'), kernelSocket: path.join(runDir, 'kernel.sock') }
  assert.equal(slotKernelAlive({ running: true }, paths), false, 'no kernel socket: rebuild')
  fs.writeFileSync(paths.kernelSocket, '')
  assert.equal(slotKernelAlive({ running: true }, paths), true, 'reload must restart, not docker rm -f')
  assert.equal(slotKernelAlive({ running: false }, paths), true)
  assert.equal(slotKernelAlive(null, paths), true)
})

test('a running kvm runner is live even without the relay socket', (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-alive-'))
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }))
  const paths = { socket: path.join(runDir, 'worker.sock'), kernelSocket: path.join(runDir, 'kernel.sock') }
  const kvm = { id: 'vm-01', runtime: { type: 'kvm' } }
  assert.equal(slotKernelAlive({ running: true }, paths, kvm), true)
  assert.equal(slotKernelAlive({ running: true, runtime: 'kvm' }, paths), true)
})

test('a GPT slot container idles instead of booting the Claude kernel', () => {
  const codex = { id: 'vm-codex-01', platform: 'openai', family: 'codex', codex_kernel: true }
  const claude = { id: 'vm-03', platform: 'anthropic' }
  assert.deepEqual(slotContainerCommand(codex, { wrapKernel: true }), ['sleep', 'infinity'])
  assert.deepEqual(slotContainerCommand(claude, { wrapKernel: true }), [
    '/home/kincli/.kin/kin-kernel',
    '--gateway-worker',
    '--config',
    '/run/kin/kernel.json',
  ])
})

test('a GPT slot container is live without kernel.sock, and an old kin-kernel one is recreated once', (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-alive-'))
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }))
  const paths = { socket: path.join(runDir, 'worker.sock'), kernelSocket: path.join(runDir, 'kernel.sock') }
  const codex = { id: 'vm-codex-01', platform: 'openai', family: 'codex', codex_kernel: true }
  const current = { running: true, networkMode: null, role: CODEX_SLOT_ROLE }
  assert.equal(slotKernelAlive(current, paths, codex), true)
  assert.equal(slotWorkerNeedsRecreate(current, codex, paths), false, 'reload must not docker rm a healthy GPT slot')
  // Created before the role label: PID 1 is kin-kernel and restarts every few minutes.
  assert.equal(slotWorkerNeedsRecreate({ running: true, networkMode: null, role: null }, codex, paths), true)
  // A Claude slot is unaffected by the label.
  fs.writeFileSync(paths.kernelSocket, '')
  assert.equal(slotWorkerNeedsRecreate({ running: true, networkMode: null }, { id: 'vm-03' }, paths), false)
})

test('writeWorkerFiles and startVmRuntime use defaults when routing.json is absent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-no-routing-'))
  const prev = process.env.KIN_ROUTING_FILE
  delete process.env.KIN_ROUTING_FILE
  try {
    const vm = {
      id: 'vm-09',
      proxy_cli_enabled: true,
      proxy: { id: 'px-local', scheme: 'local', host: 'local', port: 0, url: null },
    }
    const paths = writeWorkerFiles(vm, root, { transparent: true })
    assert.ok(fs.existsSync(paths.config))
    const result = await startVmRuntime(vm, root)
    assert.ok(result)
    assert.equal(/Routing config/.test(String(result?.error || '')), false)
  } finally {
    if (prev !== undefined) process.env.KIN_ROUTING_FILE = prev
    else delete process.env.KIN_ROUTING_FILE
    fs.rmSync(root, { recursive: true, force: true })
  }
})
