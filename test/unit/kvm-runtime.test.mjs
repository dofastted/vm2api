import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RFC4122_UUID_RE } from '../../src/lib/identity/rfc4122-uuid.mjs'
import {
  buildKvmRunArgs,
  computerDockerArgs,
  shouldPublishComputer,
  ensureSlotGuestBinDir,
  slotGuestBinMountArgs,
} from '../../src/lib/vm/vm-runtime.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'

const vm = {
  id: 'vm-02',
  kernel: 'ubuntu-24.04',
  timezone: 'UTC',
  locale: 'en_US.UTF-8',
  machine: {
    memory: '1g',
    vcpus: 2,
    disk_gb: 20,
    cpu_model: 'qemu64',
    mac: '52:54:00:11:22:33',
    smbios: {
      manufacturer: 'Dell Inc.',
      product: 'OptiPlex 7090',
      version: '1.0',
      family: 'OptiPlex',
      serial: 'ABC123',
      uuid: '11111111-2222-3333-4444-555555555555',
    },
    disk_serial: 'KIN123',
  },
  fingerprint: { hostname: 'guest-02', guest_machine_id: 'abc123' },
}

const kvmArgsProjectRoot = path.join(os.tmpdir(), 'kin-kvm-run-args')

function argsFor(accel) {
  fs.mkdirSync(kvmArgsProjectRoot, { recursive: true })
  return buildKvmRunArgs({
    vm,
    name: 'kin-02',
    image: 'ghcr.io/example/kin-kvm-ubuntu:24.04',
    hostName: 'guest-02',
    network: 'kin-eg-px',
    memory: '1g',
    accel,
    uid: 10002,
    gid: 987,
    home: '/data/vms/vm-02/cli-home',
    runDir: '/data/vms/vm-02/run',
    kvmDir: '/data/vms/vm-02/kvm',
    workerBin: '/opt/kin-gateway/bin/kin-worker',
    kernelBin: '/opt/kin-gateway/bin/kin-kernel',
    shares: 'home,run',
    hostOf: (p) => p,
    projectRoot: kvmArgsProjectRoot,
  })
}

test('kvm docker run mounts slot paths, stop-timeout 30, memory overhead', () => {
  const args = argsFor('tcg')
  assert.equal(args[0], 'docker')
  assert.equal(args[1], 'run')
  assert.equal(args[args.indexOf('--restart') + 1], 'no')
  assert.equal(args[args.indexOf('--stop-timeout') + 1], '30')
  assert.equal(args[args.indexOf('--memory') + 1], '1536m')
  assert.equal(args.includes('--device'), false)
  assert.ok(args.includes('/data/vms/vm-02/cli-home:/slot/home'))
  assert.ok(args.includes('/data/vms/vm-02/run:/slot/run'))
  assert.ok(args.includes('/data/vms/vm-02/kvm:/slot/kvm'))
  assert.ok(
    args.includes(`${path.join(kvmArgsProjectRoot, 'data', 'run', 'slot-guest-bin')}:/opt/kin-guest/usr/local/bin:ro`),
  )
  assert.ok(args.includes('kin.vm.runtime=kvm'))
  assert.ok(args.includes('KIN_KVM_ACCEL=tcg'))
  assert.ok(args.includes('KIN_KVM_MEMORY_MB=1024'))
  assert.ok(args.includes('KIN_KVM_SHARES=home,run'))
  assert.equal(args.includes('--user'), false)
  assert.equal(args.includes('--read-only'), false)
  for (const cap of ['SETUID', 'SETGID', 'SETPCAP', 'CHOWN', 'FOWNER', 'DAC_OVERRIDE']) {
    assert.equal(args[args.indexOf('--cap-add', args.indexOf(cap) - 1) + 1] === cap || args.includes(cap), true)
    const i = args.indexOf(cap)
    assert.ok(i > 0 && args[i - 1] === '--cap-add', cap)
  }
})

test('slotGuestBinMountArgs mounts a staging dir with only kin-worker and kin-kernel', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-guest-bin-'))
  const deployBin = path.join(root, 'deploy-bin')
  fs.mkdirSync(deployBin, { recursive: true })
  fs.writeFileSync(path.join(deployBin, 'kin-worker'), 'worker')
  fs.writeFileSync(path.join(deployBin, 'kin-kernel'), 'kernel')
  fs.writeFileSync(path.join(deployBin, 'kin-egress'), 'egress')
  const workerBin = path.join(deployBin, 'kin-worker')
  const kernelBin = path.join(deployBin, 'kin-kernel')
  const stage = ensureSlotGuestBinDir(root, { workerBin, kernelBin })
  assert.deepEqual(fs.readdirSync(stage).sort(), ['kin-kernel', 'kin-worker'])
  assert.deepEqual(
    slotGuestBinMountArgs({
      projectRoot: root,
      workerBin,
      kernelBin,
      guestBinDir: '/usr/local/bin',
    }),
    ['-v', `${stage}:/usr/local/bin:ro`],
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('slot-guest-bin entries resolve inside the slot and follow host replacements', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-guest-bin-'))
  const deployBin = path.join(root, 'deploy-bin')
  fs.mkdirSync(deployBin, { recursive: true })
  const workerBin = path.join(deployBin, 'kin-worker')
  const kernelBin = path.join(deployBin, 'kin-kernel')
  fs.writeFileSync(workerBin, 'worker-v1', { mode: 0o755 })
  fs.writeFileSync(kernelBin, 'kernel-v1', { mode: 0o755 })
  const stage = ensureSlotGuestBinDir(root, { workerBin, kernelBin })
  // The slot only sees the mounted dir; a symlink to the host path would dangle there.
  for (const name of ['kin-worker', 'kin-kernel']) {
    const st = fs.lstatSync(path.join(stage, name))
    assert.equal(st.isSymbolicLink(), false, name)
    assert.equal(st.mode & 0o777, 0o755, name)
  }
  assert.equal(fs.readFileSync(path.join(stage, 'kin-worker'), 'utf8'), 'worker-v1')
  const tmp = `${workerBin}.new`
  fs.writeFileSync(tmp, 'worker-v2', { mode: 0o755 })
  fs.renameSync(tmp, workerBin)
  ensureSlotGuestBinDir(root, { workerBin, kernelBin })
  assert.equal(fs.readFileSync(path.join(stage, 'kin-worker'), 'utf8'), 'worker-v2')
  assert.equal(fs.readFileSync(path.join(stage, 'kin-kernel'), 'utf8'), 'kernel-v1')
  // A GPT slot mounts no kernel; the shared dir keeps it for Claude slots.
  ensureSlotGuestBinDir(root, { workerBin, kernelBin: null })
  assert.deepEqual(fs.readdirSync(stage).sort(), ['kin-kernel', 'kin-worker'])
  fs.rmSync(kernelBin)
  ensureSlotGuestBinDir(root, { workerBin, kernelBin })
  assert.deepEqual(fs.readdirSync(stage), ['kin-worker'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('slot-guest-bin stages the real file behind a symlinked host binary', {
  skip: process.platform !== 'linux',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-guest-bin-'))
  const deployBin = path.join(root, 'deploy-bin')
  fs.mkdirSync(deployBin, { recursive: true })
  const real = path.join(root, 'kin-kernel.real')
  fs.writeFileSync(real, 'kernel-real', { mode: 0o755 })
  const kernelBin = path.join(deployBin, 'kin-kernel')
  fs.symlinkSync(real, kernelBin)
  const stage = ensureSlotGuestBinDir(root, { kernelBin })
  const st = fs.lstatSync(path.join(stage, 'kin-kernel'))
  assert.equal(st.isSymbolicLink(), false)
  assert.equal(fs.readFileSync(path.join(stage, 'kin-kernel'), 'utf8'), 'kernel-real')
  fs.rmSync(root, { recursive: true, force: true })
})

test('slot-guest-bin copies when a hard link is refused and skips identical copies', {
  skip: process.platform !== 'linux',
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-guest-bin-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const deployBin = path.join(root, 'deploy-bin')
  fs.mkdirSync(deployBin, { recursive: true })
  const kernelBin = path.join(deployBin, 'kin-kernel')
  fs.writeFileSync(kernelBin, 'kernel-v1', { mode: 0o755 })
  const linkSync = fs.linkSync
  t.after(() => {
    fs.linkSync = linkSync
  })
  fs.linkSync = () => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
  }
  const stage = ensureSlotGuestBinDir(root, { kernelBin })
  const dest = path.join(stage, 'kin-kernel')
  assert.equal(fs.readFileSync(dest, 'utf8'), 'kernel-v1')
  assert.equal(fs.statSync(dest).mode & 0o777, 0o755)
  const ino = fs.statSync(dest).ino
  ensureSlotGuestBinDir(root, { kernelBin })
  assert.equal(fs.statSync(dest).ino, ino, 'identical copy is not rewritten')
  fs.writeFileSync(kernelBin, 'kernel-v2', { mode: 0o755 })
  ensureSlotGuestBinDir(root, { kernelBin })
  assert.equal(fs.readFileSync(dest, 'utf8'), 'kernel-v2')
})

test('slotGuestBinMountArgs falls back to file mounts without projectRoot', () => {
  assert.deepEqual(
    slotGuestBinMountArgs({
      workerBin: '/opt/a/kin-worker',
      kernelBin: '/opt/b/kin-kernel',
      guestBinDir: '/opt/kin-guest/usr/local/bin',
    }),
    [
      '-v',
      '/opt/a/kin-worker:/opt/kin-guest/usr/local/bin/kin-worker:ro',
      '-v',
      '/opt/b/kin-kernel:/opt/kin-guest/usr/local/bin/kin-kernel:ro',
    ],
  )
})

test('kvm docker run attaches /dev/kvm only with accel kvm', () => {
  const kvm = argsFor('kvm')
  const deviceAt = kvm.indexOf('--device')
  assert.notEqual(deviceAt, -1)
  assert.equal(kvm[deviceAt + 1], '/dev/kvm')
  assert.ok(kvm.includes('KIN_KVM_ACCEL=kvm'))
  const tcg = argsFor('tcg')
  assert.equal(tcg.includes('--device'), false)
  assert.equal(tcg.includes('/dev/kvm'), false)
})

test('an existing container keeps its baked computer name', () => {
  assert.equal(shouldPublishComputer({ running: true, id: 'old' }), false)
  assert.equal(shouldPublishComputer({ running: false, id: 'stopped' }), false)
  assert.equal(shouldPublishComputer(null), true)
  assert.equal(shouldPublishComputer(undefined), true)
})

test('kvm env coerces missing or invalid fingerprint uuid for QEMU', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-fp-bad-uuid-'))
  const kvmDir = path.join(root, 'kvm')
  fs.mkdirSync(path.join(kvmDir, 'fingerprint'), { recursive: true })
  fs.writeFileSync(
    path.join(kvmDir, 'fingerprint', 'qemu-smbios.args'),
    ['-smbios', 'type=1,manufacturer=ASUS,product=System Product Name,sku=SKU', ''].join('\n'),
  )
  const args = buildKvmRunArgs({
    vm,
    name: 'kin-02',
    image: 'ghcr.io/example/kin-kvm-ubuntu:24.04',
    hostName: 'guest-02',
    network: 'kin-eg-px',
    memory: '1g',
    accel: 'tcg',
    uid: 10002,
    gid: 987,
    home: '/data/vms/vm-02/cli-home',
    runDir: '/data/vms/vm-02/run',
    kvmDir,
    shares: 'home,run',
  })
  const uuidEnv = args.find((arg) => String(arg).startsWith('KIN_KVM_SMBIOS_UUID='))
  assert.ok(uuidEnv)
  const value = String(uuidEnv).slice('KIN_KVM_SMBIOS_UUID='.length)
  assert.notEqual(value, '-')
  assert.match(value, RFC4122_UUID_RE)
  fs.rmSync(root, { recursive: true, force: true })
})

test('kvm env uses fingerprint SMBIOS and does not carry smc or rom', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-fp-'))
  const kvmDir = path.join(root, 'kvm')
  fs.mkdirSync(path.join(kvmDir, 'fingerprint'), { recursive: true })
  fs.writeFileSync(
    path.join(kvmDir, 'fingerprint', 'qemu-smbios.args'),
    [
      '-uuid',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '-smbios',
      'type=1,manufacturer=Framework,product=Laptop16,version=AB,serial=FW123,uuid=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,family=Laptop',
      '',
    ].join('\n'),
  )
  const args = buildKvmRunArgs({
    vm,
    name: 'kin-02',
    image: 'ghcr.io/example/kin-kvm-ubuntu:24.04',
    hostName: 'guest-02',
    network: 'kin-eg-px',
    memory: '1g',
    accel: 'tcg',
    uid: 10002,
    gid: 987,
    home: '/data/vms/vm-02/cli-home',
    runDir: '/data/vms/vm-02/run',
    kvmDir,
    shares: 'home,run',
  })
  assert.ok(args.includes('KIN_KVM_SMBIOS_MANUFACTURER=Framework'))
  assert.ok(args.includes('KIN_KVM_SMBIOS_PRODUCT=Laptop16'))
  assert.equal(
    args.some((arg) => String(arg).includes('OptiPlex')),
    false,
  )
  assert.equal(
    args.some((arg) => /smc_version|rom_hex/i.test(String(arg))),
    false,
  )
  assert.ok(args.includes('KIN_KVM_MAC=52:54:00:11:22:33'))
  assert.ok(args.includes('KIN_KVM_DISK_SERIAL=KIN123'))
  assert.ok(args.includes('KIN_KVM_MEMORY_MB=1024'))
  assert.ok(args.includes('KIN_KVM_VCPUS=2'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('docker computer mounts are read-only and use the persona MAC', () => {
  const args = computerDockerArgs({
    dir: '/data/vms/vm-02/kvm/fingerprint',
    mac: '3c:22:fb:f9:50:9d',
    hostOf: (p) => p,
  })
  assert.equal(args[args.indexOf('--mac-address') + 1], '3c:22:fb:f9:50:9d')
  assert.ok(args.includes('/data/vms/vm-02/kvm/fingerprint:/var/lib/kin-persona:ro'))
  assert.ok(args.includes('/data/vms/vm-02/kvm/fingerprint/system/etc/hostname:/etc/hostname:ro'))
  assert.ok(args.includes('/data/vms/vm-02/kvm/fingerprint/system/etc/kin-computer:/etc/kin-computer:ro'))
  assert.ok(args.includes('/data/vms/vm-02/kvm/fingerprint/system/dmi/id:/etc/kin-dmi:ro'))
  assert.ok(args.includes('/data/vms/vm-02/kvm/fingerprint/system/hardware:/etc/kin-hardware:ro'))
})

test('writeKernelConfig uses guest socket path and runtime_kind kvm', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-kernel-'))
  const written = writeKernelConfig(root, { id: 'vm-02', runtime: { type: 'kvm' } }, { token: 'tok' })
  const doc = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(doc.runtime_kind, 'kvm')
  assert.equal(doc.socket_path, '/run/kin-guest/kernel.sock')
  assert.equal(written.socketPath, path.join(root, 'vms', 'vm-02', 'run', 'kernel.sock'))
  fs.rmSync(root, { recursive: true, force: true })
})
