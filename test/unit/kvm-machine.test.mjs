import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  dockerEnvMap,
  ensureKvmMachineRecord,
  kvmEnvMapIncomplete,
  kvmMachineFields,
} from '../../src/lib/vm/kvm-machine.mjs'
import { buildKvmRunArgs } from '../../src/lib/vm/vm-runtime.mjs'

test('dockerEnvMap parses Config.Env rows', () => {
  assert.deepEqual(dockerEnvMap(['KIN_KVM_MAC=52:54:00:11:22:33', 'FOO=bar']), {
    KIN_KVM_MAC: '52:54:00:11:22:33',
    FOO: 'bar',
  })
})

test('ensureKvmMachineRecord backfills from container env and persists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-machine-'))
  const id = 'vm-99'
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    `${JSON.stringify({ id, machine: { memory: '1g', vcpus: 2, disk_gb: 20 } }, null, 2)}\n`,
  )
  const vm = { id, machine: { memory: '1g', vcpus: 2, disk_gb: 20 } }
  const changed = ensureKvmMachineRecord(vm, {
    projectRoot: root,
    containerEnv: {
      KIN_KVM_MAC: '52:54:00:aa:bb:cc',
      KIN_KVM_DISK_SERIAL: 'KINdeadbeef',
    },
    persist: true,
  })
  assert.equal(changed, true)
  assert.equal(vm.machine.mac, '52:54:00:aa:bb:cc')
  assert.equal(vm.machine.disk_serial, 'KINdeadbeef')
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
  assert.equal(saved.machine.mac, '52:54:00:aa:bb:cc')
  assert.equal(saved.machine.disk_serial, 'KINdeadbeef')
  fs.rmSync(root, { recursive: true, force: true })
})

test('ensureKvmMachineRecord prefers slot record over container env', () => {
  const vm = {
    id: 'vm-01',
    machine: { mac: '52:54:00:11:22:33', disk_serial: 'KIN123' },
  }
  ensureKvmMachineRecord(vm, {
    containerEnv: { KIN_KVM_MAC: '52:54:00:ff:ff:ff', KIN_KVM_DISK_SERIAL: 'OTHER' },
  })
  assert.equal(vm.machine.mac, '52:54:00:11:22:33')
  assert.equal(vm.machine.disk_serial, 'KIN123')
})

test('kvmEnvMapIncomplete detects missing runner env', () => {
  assert.equal(kvmEnvMapIncomplete({ KIN_KVM_MAC: '52:54:00:11:22:33' }, ['KIN_KVM_MAC=52:54:00:11:22:33']), true)
  assert.equal(kvmEnvMapIncomplete({}, undefined), false)
  assert.equal(
    kvmEnvMapIncomplete({ KIN_KVM_MAC: '52:54:00:11:22:33', KIN_KVM_DISK_SERIAL: 'KIN1' }, [
      'KIN_KVM_MAC=52:54:00:11:22:33',
      'KIN_KVM_DISK_SERIAL=KIN1',
    ]),
    false,
  )
})

test('buildKvmRunArgs uses backfilled machine identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-run-backfill-'))
  const vm = {
    id: 'vm-02',
    kernel: 'debian-12',
    machine: { memory: '1g', vcpus: 2, disk_gb: 20 },
    fingerprint: { hostname: 'guest-02', guest_machine_id: 'abc123' },
  }
  ensureKvmMachineRecord(vm, {
    containerEnv: { KIN_KVM_MAC: '52:54:00:11:22:33', KIN_KVM_DISK_SERIAL: 'KIN123' },
  })
  const args = buildKvmRunArgs({
    vm,
    name: 'kin-02',
    image: 'ghcr.io/example/kin-kvm-debian:12',
    hostName: 'guest-02',
    network: 'kin-eg-px',
    memory: '1g',
    accel: 'tcg',
    uid: 10002,
    gid: 987,
    home: '/data/vms/vm-02/cli-home',
    runDir: '/data/vms/vm-02/run',
    kvmDir: path.join(root, 'kvm'),
    shares: 'home,run',
  })
  assert.ok(args.includes('KIN_KVM_MAC=52:54:00:11:22:33'))
  assert.ok(args.includes('KIN_KVM_DISK_SERIAL=KIN123'))
  assert.equal(kvmMachineFields(vm).mac, '52:54:00:11:22:33')
  fs.rmSync(root, { recursive: true, force: true })
})
