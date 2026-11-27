import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_KVM_VSOCK_PORT,
  KVM_MODE_CUSTOM_EROFS,
  KVM_MODE_LEGACY,
  LXCFS_PROC_FILES,
  dockerLxcfsMountArgs,
  isCustomKvmMode,
  isVhostVsockUsable,
  resolveKvmMode,
} from '../../src/lib/vm/custom-os-runtime.mjs'
import { allocateCid, getCidLease } from '../../src/lib/vm/kvm-vsock-cid.mjs'
import {
  buildKvmRunArgs,
  finalizeKvmCidAfterStart,
  reconcileStoppedKvmContainerCid,
} from '../../src/lib/vm/vm-runtime.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'

const baseVm = {
  id: 'vm-custom-01',
  kernel: 'debian-13',
  timezone: 'UTC',
  locale: 'en_US.UTF-8',
  runtime: { type: 'kvm' },
  dataplane: 'crag',
  crag_kernel_version: 'v2',
  machine: {
    memory: '2g',
    vcpus: 2,
    disk_gb: 20,
    cpu_model: 'host',
    mac: '52:54:00:aa:bb:cc',
    disk_serial: 'KIN9001',
  },
  fingerprint: { hostname: 'ws-custom-01', guest_machine_id: '0123456789abcdef0123456789abcdef' },
}

function makeTempProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-custom-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const kvmDir = path.join(root, 'vms', baseVm.id, 'kvm')
  const storeDir = path.join(root, 'store')
  fs.mkdirSync(path.join(kvmDir, 'fingerprint'), { recursive: true })
  fs.mkdirSync(storeDir, { recursive: true })
  fs.writeFileSync(
    path.join(kvmDir, 'fingerprint', 'qemu-smbios.args'),
    ['-uuid', '11111111-2222-4333-8444-555555555555', '-smbios', 'type=1,manufacturer=LENOVO,product=ThinkPad'].join(
      '\n',
    ),
  )
  return { root, kvmDir, storeDir }
}

test('isVhostVsockUsable fails closed on ENODEV static nodes and closes fd on success', () => {
  let closedFd = null
  const ok = isVhostVsockUsable('/dev/vhost-vsock', {
    openSync: () => 42,
    closeSync: (fd) => {
      closedFd = fd
    },
  })
  assert.equal(ok, true)
  assert.equal(closedFd, 42)

  const enodev = isVhostVsockUsable('/dev/vhost-vsock', {
    openSync: () => {
      throw Object.assign(new Error('No such device'), { code: 'ENODEV' })
    },
  })
  assert.equal(enodev, false)
})

test('resolveKvmMode defaults to legacy and supports custom-erofs / custom-os opt-in', () => {
  assert.equal(resolveKvmMode({ env: {} }), KVM_MODE_LEGACY)
  assert.equal(isCustomKvmMode({ env: {} }), false)
  assert.equal(resolveKvmMode({ env: { KIN_KVM_MODE: 'custom-erofs' } }), KVM_MODE_CUSTOM_EROFS)
  assert.equal(resolveKvmMode({ env: { KIN_OS_RUNTIME_MODE: 'custom-os' } }), KVM_MODE_CUSTOM_EROFS)
  // Explicit legacy overrides custom-os runtime mode for instant rollback.
  assert.equal(resolveKvmMode({ env: { KIN_OS_RUNTIME_MODE: 'custom-os', KIN_KVM_MODE: 'legacy' } }), KVM_MODE_LEGACY)
})

test('buildKvmRunArgs legacy mode omits custom KVM env, vsock device, token, and store mount', (t) => {
  const { root, kvmDir } = makeTempProject(t)
  const args = buildKvmRunArgs({
    vm: baseVm,
    name: 'kin-custom-01',
    image: 'ghcr.io/example/kin-kvm-debian:13',
    hostName: 'ws-custom-01',
    network: 'kin-eg-px',
    memory: '2g',
    accel: 'kvm',
    uid: 10001,
    gid: 987,
    home: path.join(root, 'vms', baseVm.id, 'cli-home'),
    runDir: path.join(root, 'vms', baseVm.id, 'run'),
    kvmDir,
    projectRoot: root,
    kvmMode: KVM_MODE_LEGACY,
    vhostVsockAvailable: true,
  })

  assert.equal(args.includes('/dev/kvm'), true)
  assert.equal(args.includes('/dev/vhost-vsock'), false)
  assert.equal(
    args.some((a) => String(a).startsWith('KIN_KVM_MODE=')),
    false,
  )
  assert.equal(
    args.some((a) => String(a).startsWith('KIN_KVM_VSOCK_CID=')),
    false,
  )
  assert.equal(
    args.some((a) => String(a).startsWith('KIN_AGENT_TOKEN=')),
    false,
  )
  assert.equal(
    args.some((a) => String(a).includes(':/opt/kin/store:ro')),
    false,
  )
})

test('buildKvmRunArgs custom-erofs wires vsock device, CID lease, 0600 agent token, and read-only store mount', (t) => {
  const { root, kvmDir, storeDir } = makeTempProject(t)
  const args = buildKvmRunArgs({
    vm: baseVm,
    name: 'kin-custom-01',
    image: 'ghcr.io/example/kin-kvm-debian:13',
    hostName: 'ws-custom-01',
    network: 'kin-eg-px',
    memory: '2g',
    accel: 'kvm',
    uid: 10001,
    gid: 987,
    home: path.join(root, 'vms', baseVm.id, 'cli-home'),
    runDir: path.join(root, 'vms', baseVm.id, 'run'),
    kvmDir,
    projectRoot: root,
    kvmMode: KVM_MODE_CUSTOM_EROFS,
    vhostVsockAvailable: true,
    storeBlkImage: '/var/lib/kin/store.erofs',
  })

  assert.ok(args.includes('/dev/kvm'))
  assert.ok(args.includes('/dev/vhost-vsock'))
  assert.ok(args.includes('KIN_KVM_MODE=custom-erofs'))
  assert.ok(args.includes('KIN_KVM_VSOCK_PORT=7070'))
  assert.ok(args.includes('KIN_KVM_AGENT_VSOCK_PORT=7071'))
  assert.ok(args.includes('KIN_KVM_STORE_MODE=auto'))
  assert.ok(args.includes('KIN_KVM_STORE_DIR=/opt/kin/store'))
  assert.ok(args.includes('KIN_KVM_STORE_BLK_IMAGE=/var/lib/kin/store.erofs'))
  assert.ok(args.includes('KIN_KVM_SMBIOS_ARGS_FILE=/slot/kvm/fingerprint/qemu-smbios.args'))
  assert.ok(args.includes('KIN_KVM_HW_PLAN_FILE=/slot/kvm/fingerprint/hardware.json'))
  assert.ok(args.includes('KIN_KVM_AGENT_SOCK=/slot/kvm/agent.sock'))
  assert.ok(args.includes('KIN_KVM_KERNEL_SOCK=/slot/run/kernel.sock'))
  assert.ok(args.includes(`${storeDir}:/opt/kin/store:ro`))

  const cidEnv = args.find((a) => String(a).startsWith('KIN_KVM_VSOCK_CID='))
  assert.ok(cidEnv)
  const cid = Number(cidEnv.slice('KIN_KVM_VSOCK_CID='.length))
  assert.ok(Number.isInteger(cid) && cid >= 1000)
  assert.equal(getCidLease(baseVm.id, { projectRoot: root })?.cid, cid)

  const tokEnv = args.find((a) => String(a).startsWith('KIN_AGENT_TOKEN='))
  assert.ok(tokEnv)
  const token = tokEnv.slice('KIN_AGENT_TOKEN='.length)
  assert.match(token, /^[a-f0-9]{64}$/)
  const diskToken = fs.readFileSync(path.join(kvmDir, '.agent-token'), 'utf8').trim()
  assert.equal(diskToken, token)
})

test('buildKvmRunArgs falls back cleanly without /dev/vhost-vsock or under TCG', (t) => {
  const { root, kvmDir } = makeTempProject(t)

  for (const [accel, vhostVsockAvailable] of [
    ['kvm', false],
    ['tcg', true],
  ]) {
    const args = buildKvmRunArgs({
      vm: baseVm,
      name: 'kin-custom-01',
      image: 'ghcr.io/example/kin-kvm-debian:13',
      hostName: 'ws-custom-01',
      network: 'kin-eg-px',
      memory: '2g',
      accel,
      uid: 10001,
      gid: 987,
      home: path.join(root, 'vms', baseVm.id, 'cli-home'),
      runDir: path.join(root, 'vms', baseVm.id, 'run'),
      kvmDir,
      projectRoot: root,
      kvmMode: KVM_MODE_CUSTOM_EROFS,
      vhostVsockAvailable,
    })

    assert.equal(args.includes('/dev/vhost-vsock'), false)
    assert.equal(
      args.some((a) => String(a).startsWith('KIN_KVM_VSOCK_CID=')),
      false,
    )
    assert.ok(args.includes('KIN_KVM_MODE=custom-erofs'))
    assert.ok(args.some((a) => String(a).startsWith('KIN_AGENT_TOKEN=')))
  }
})

test('dockerLxcfsMountArgs is opt-in and requires all 4 host LXCFS proc files', (t) => {
  const lxcfsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-lxcfs-'))
  t.after(() => fs.rmSync(lxcfsDir, { recursive: true, force: true }))
  for (const name of LXCFS_PROC_FILES) {
    fs.writeFileSync(path.join(lxcfsDir, name), `${name}\n`)
  }

  // Disabled by default even when host LXCFS files exist.
  assert.deepEqual(dockerLxcfsMountArgs({ env: {}, lxcfsProcDir: lxcfsDir }), [])

  // Enabled when KIN_DOCKER_LXCFS=1 and all 4 files exist.
  const mounts = dockerLxcfsMountArgs({ env: { KIN_DOCKER_LXCFS: '1' }, lxcfsProcDir: lxcfsDir })
  assert.deepEqual(mounts, [
    '-v',
    `${lxcfsDir}/cpuinfo:/proc/cpuinfo:ro`,
    '-v',
    `${lxcfsDir}/meminfo:/proc/meminfo:ro`,
    '-v',
    `${lxcfsDir}/stat:/proc/stat:ro`,
    '-v',
    `${lxcfsDir}/uptime:/proc/uptime:ro`,
  ])

  // Missing any required proc file disables LXCFS cleanly.
  fs.rmSync(path.join(lxcfsDir, 'uptime'))
  assert.deepEqual(dockerLxcfsMountArgs({ env: { KIN_DOCKER_LXCFS: '1' }, lxcfsProcDir: lxcfsDir }), [])
})

test('writeKernelConfig sets disable_dumpable and listen_vsock_port on custom KVM only', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-kcfg-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routing = { inference: { dataplane: 'crag', crag_kernel_version: 'v2' } }

  // 1. Custom KVM with vsock enabled.
  const kvmCustom = writeKernelConfig(
    root,
    { id: 'vm-kvm-1', runtime: { type: 'kvm' }, dataplane: 'crag' },
    { token: 'tok', routing, kvmMode: KVM_MODE_CUSTOM_EROFS, vsockEnabled: true },
  )
  const kvmDoc = JSON.parse(fs.readFileSync(kvmCustom.configPath, 'utf8'))
  assert.equal(kvmDoc.disable_dumpable, true)
  assert.equal(kvmDoc.listen_vsock_port, DEFAULT_KVM_VSOCK_PORT)

  // 2. Custom KVM with vsock disabled -> disable_dumpable stays true, no listen_vsock_port.
  const kvmNoVsock = writeKernelConfig(
    root,
    { id: 'vm-kvm-2', runtime: { type: 'kvm' }, dataplane: 'crag' },
    { token: 'tok', routing, kvmMode: KVM_MODE_CUSTOM_EROFS, vsockEnabled: false },
  )
  const kvmNoVsockDoc = JSON.parse(fs.readFileSync(kvmNoVsock.configPath, 'utf8'))
  assert.equal(kvmNoVsockDoc.disable_dumpable, true)
  assert.equal(kvmNoVsockDoc.listen_vsock_port, undefined)

  // 3. Legacy KVM -> neither flag set.
  const kvmLegacy = writeKernelConfig(
    root,
    { id: 'vm-kvm-3', runtime: { type: 'kvm' }, dataplane: 'crag' },
    { token: 'tok', routing, kvmMode: KVM_MODE_LEGACY, vsockEnabled: true },
  )
  const kvmLegacyDoc = JSON.parse(fs.readFileSync(kvmLegacy.configPath, 'utf8'))
  assert.equal(kvmLegacyDoc.disable_dumpable, undefined)
  assert.equal(kvmLegacyDoc.listen_vsock_port, undefined)

  // 4. Docker slot (even in custom-os runtimeMode) -> disable_dumpable stays unset for crag-core-check.mjs.
  const dockerSlot = writeKernelConfig(
    root,
    { id: 'vm-doc-1', runtime: { type: 'docker' }, dataplane: 'crag' },
    { token: 'tok', routing, runtimeMode: 'custom-os', vsockEnabled: true },
  )
  const dockerDoc = JSON.parse(fs.readFileSync(dockerSlot.configPath, 'utf8'))
  assert.equal(dockerDoc.disable_dumpable, undefined)
  assert.equal(dockerDoc.listen_vsock_port, undefined)

  // 5. Auto-probe skips listen_vsock_port under TCG or missing /dev/kvm even when /dev/vhost-vsock exists.
  const bothDevices = (p) => p === '/dev/kvm' || p === '/dev/vhost-vsock'
  const onlyVsock = (p) => p === '/dev/vhost-vsock'

  const autoKvm = writeKernelConfig(
    root,
    { id: 'vm-kvm-auto', runtime: { type: 'kvm', accel: 'kvm' }, dataplane: 'crag' },
    { token: 'tok', routing, kvmMode: KVM_MODE_CUSTOM_EROFS, existsSync: bothDevices },
  )
  assert.equal(JSON.parse(fs.readFileSync(autoKvm.configPath, 'utf8')).listen_vsock_port, DEFAULT_KVM_VSOCK_PORT)

  const autoTcgArg = writeKernelConfig(
    root,
    { id: 'vm-kvm-tcg1', runtime: { type: 'kvm' }, dataplane: 'crag' },
    { token: 'tok', routing, kvmMode: KVM_MODE_CUSTOM_EROFS, accel: 'tcg', existsSync: bothDevices },
  )
  const tcgArgDoc = JSON.parse(fs.readFileSync(autoTcgArg.configPath, 'utf8'))
  assert.equal(tcgArgDoc.disable_dumpable, true)
  assert.equal(tcgArgDoc.listen_vsock_port, undefined)

  const autoTcgVm = writeKernelConfig(
    root,
    { id: 'vm-kvm-tcg2', runtime: { type: 'kvm', accel: 'tcg' }, dataplane: 'crag' },
    { token: 'tok', routing, kvmMode: KVM_MODE_CUSTOM_EROFS, existsSync: bothDevices },
  )
  assert.equal(JSON.parse(fs.readFileSync(autoTcgVm.configPath, 'utf8')).listen_vsock_port, undefined)

  const autoNoKvm = writeKernelConfig(
    root,
    { id: 'vm-kvm-nokvm', runtime: { type: 'kvm', accel: 'kvm' }, dataplane: 'crag' },
    { token: 'tok', routing, kvmMode: KVM_MODE_CUSTOM_EROFS, existsSync: onlyVsock },
  )
  assert.equal(JSON.parse(fs.readFileSync(autoNoKvm.configPath, 'utf8')).listen_vsock_port, undefined)
})

test('stopped custom KVM container CID reconcile restores free lease or triggers recreate on live conflict', (t) => {
  const { root } = makeTempProject(t)
  const live = new Set([701])
  const isPidAlive = (pid) => live.has(pid)

  const first = allocateCid('vm-01', { projectRoot: root, ownerPid: 701, isPidAlive })
  assert.equal(first.ok, true)

  // Container stops and another VM sweeps vm-01's exited lease.
  live.delete(701)
  live.add(702)
  const second = allocateCid('vm-02', { projectRoot: root, ownerPid: 702, isPidAlive })
  assert.equal(second.ok, true)
  assert.equal(getCidLease('vm-01', { projectRoot: root }), null)

  // Stopped vm-01 container still has its baked CID -> reconcile restores lease before docker start.
  const inspectFree = () => ({ ok: true, stdout: JSON.stringify([`KIN_KVM_VSOCK_CID=${first.cid}`]) })
  const restored = reconcileStoppedKvmContainerCid('vm-01', 'kin-01', {
    projectRoot: root,
    run: inspectFree,
    isPidAlive,
  })
  assert.equal(restored.ok, true)
  assert.equal(restored.needsRecreate, false)
  assert.equal(restored.cid, first.cid)
  assert.equal(getCidLease('vm-01', { projectRoot: root })?.cid, first.cid)

  // Binding live PID after docker start succeeds and persists owner_pid.
  live.add(703)
  const bound = finalizeKvmCidAfterStart('vm-01', {
    ok: true,
    pid: 703,
    bakedCid: restored.cid,
    projectRoot: root,
    isPidAlive,
  })
  assert.equal(bound.ok, true)
  assert.equal(getCidLease('vm-01', { projectRoot: root })?.owner_pid, 703)

  // Stopped vm-03 container whose baked CID is now owned by live vm-02 -> forces recreate.
  const inspectConflict = () => ({ ok: true, stdout: JSON.stringify([`KIN_KVM_VSOCK_CID=${second.cid}`]) })
  const conflict = reconcileStoppedKvmContainerCid('vm-03', 'kin-03', {
    projectRoot: root,
    run: inspectConflict,
    isPidAlive,
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.needsRecreate, true)
  assert.equal(conflict.code, 'vsock_cid_conflict')
})

test('failed docker run releases unowned custom KVM CID lease without leaking or harming live PIDs', (t) => {
  const { root, kvmDir } = makeTempProject(t)
  const args = buildKvmRunArgs({
    vm: baseVm,
    name: 'kin-custom-01',
    image: 'ghcr.io/example/kin-kvm-debian:13',
    hostName: 'ws-custom-01',
    network: 'kin-eg-px',
    memory: '2g',
    accel: 'kvm',
    uid: 10001,
    gid: 987,
    home: path.join(root, 'vms', baseVm.id, 'cli-home'),
    runDir: path.join(root, 'vms', baseVm.id, 'run'),
    kvmDir,
    projectRoot: root,
    kvmMode: KVM_MODE_CUSTOM_EROFS,
    vhostVsockAvailable: true,
  })
  assert.ok(args.some((a) => String(a).startsWith('KIN_KVM_VSOCK_CID=')))
  assert.equal(getCidLease(baseVm.id, { projectRoot: root })?.owner_pid, null)

  // Simulated docker run failure releases the unowned CID lease immediately.
  const released = finalizeKvmCidAfterStart(baseVm.id, { ok: false, projectRoot: root })
  assert.equal(released.ok, true)
  assert.equal(released.released, true)
  assert.equal(getCidLease(baseVm.id, { projectRoot: root }), null)

  // Live owner PID is never released even on a stray failure cleanup call.
  const liveAlloc = allocateCid(baseVm.id, { projectRoot: root, ownerPid: 808, isPidAlive: (p) => p === 808 })
  assert.equal(liveAlloc.ok, true)
  const protectedRes = finalizeKvmCidAfterStart(baseVm.id, {
    ok: false,
    projectRoot: root,
    isPidAlive: (p) => p === 808,
  })
  assert.equal(protectedRes.ok, false)
  assert.equal(protectedRes.code, 'vsock_cid_owner_alive')
  assert.equal(getCidLease(baseVm.id, { projectRoot: root })?.cid, liveAlloc.cid)
})
