import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildKvmRunArgs } from '../../src/lib/vm/vm-runtime.mjs'
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

function argsFor(accel) {
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
  })
}

test('kvm docker run mounts slot paths, stop-timeout 30, memory overhead', () => {
  const args = argsFor('tcg')
  assert.equal(args[0], 'docker')
  assert.equal(args[1], 'run')
  assert.equal(args[args.indexOf('--stop-timeout') + 1], '30')
  assert.equal(args[args.indexOf('--memory') + 1], '1536m')
  assert.equal(args.includes('--device'), false)
  assert.ok(args.includes('/data/vms/vm-02/cli-home:/slot/home'))
  assert.ok(args.includes('/data/vms/vm-02/run:/slot/run'))
  assert.ok(args.includes('/data/vms/vm-02/kvm:/slot/kvm'))
  assert.ok(args.includes('/opt/kin-gateway/bin/kin-worker:/opt/kin-guest/usr/local/bin/kin-worker:ro'))
  assert.ok(args.includes('/opt/kin-gateway/bin/kin-kernel:/opt/kin-guest/usr/local/bin/kin-kernel:ro'))
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

test('writeKernelConfig uses guest socket path and runtime_kind kvm', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-kernel-'))
  const written = writeKernelConfig(root, { id: 'vm-02', runtime: { type: 'kvm' } }, { token: 'tok' })
  const doc = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(doc.runtime_kind, 'kvm')
  assert.equal(doc.socket_path, '/run/kin-guest/kernel.sock')
  assert.equal(written.socketPath, path.join(root, 'vms', 'vm-02', 'run', 'kernel.sock'))
  fs.rmSync(root, { recursive: true, force: true })
})
