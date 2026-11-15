import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as spec from '../../src/lib/vm/machine-spec.mjs'
import * as runtime from '../../src/lib/vm/vm-runtime.mjs'
import { slotContainerBody, startRemoteSlot } from '../../src/lib/cluster/remote-slot.mjs'
import { configureSlotCapacity } from '../../src/lib/vm/slot-capacity.mjs'

// These tests cover other behaviour on the legacy fixed 20 native slots;
// plan-based capacity has its own tests (slot-capacity*.test.mjs).
configureSlotCapacity({ enabled: false })

const options = { image: 'fixture', network: 'none', remoteDir: '/fixture', user: '1000:1000', routing: {} }
const vm = (machine = {}) => ({ id: 'vm-01', machine, runtime: { type: 'docker' } })

test('Docker CPU quota is opt-in; legacy vcpus never becomes a hard cap', () => {
  const legacy = spec.resolveMachineSpec({ runtime: 'docker', config: { vcpus: 2 } })
  assert.equal(Object.hasOwn(legacy, 'docker_cpus'), false)
  assert.equal(slotContainerBody(vm(legacy), options).HostConfig.NanoCpus, undefined)
  assert.equal(runtime.dockerSlotResourceArgs(vm(legacy), {}).includes('--cpus'), false)
})

test('create freezes an explicit Docker CPU quota separately from KVM vcpus', () => {
  for (const quota of [0, 0.01, 0.25, 1, 1.25, 16]) {
    const machine = spec.resolveMachineSpec({ runtime: 'docker', overrides: { docker_cpus: quota } })
    assert.equal(machine.docker_cpus, quota)
    const args = runtime.dockerSlotResourceArgs(vm(machine), {})
    assert.deepEqual(args.slice(0, 6), ['--memory', '512m', '--memory-swap', '512m', '--pids-limit', '256'])
    const expected = quota > 0 ? ['--cpus', String(quota)] : []
    assert.deepEqual(args.slice(6), expected)
    assert.equal(
      slotContainerBody(vm(machine), options).HostConfig.NanoCpus,
      quota > 0 ? Math.round(quota * 1e9) : undefined,
    )
  }
})

test('create rejects malformed, sub-minimum or excessive quotas instead of silently uncapping', () => {
  for (const quota of [-1, 0.001, 17, Infinity, NaN, '0.5', '', null, false, [], {}]) {
    assert.throws(
      () => spec.resolveMachineSpec({ runtime: 'docker', overrides: { docker_cpus: quota } }),
      (e) => e.status === 400 && e.code === 'invalid_machine' && /docker_cpus/.test(e.message),
      String(quota),
    )
  }
})

test('a Docker-only quota cannot be requested for KVM and never limits its runner', () => {
  assert.throws(
    () => spec.resolveMachineSpec({ runtime: 'kvm', overrides: { docker_cpus: 0.5 } }),
    (e) => e.status === 400 && e.code === 'invalid_machine',
  )
  const kvm = { ...vm({ docker_cpus: 0.5, vcpus: 4 }), runtime: { type: 'kvm' } }
  const body = slotContainerBody(kvm, options)
  assert.equal(body.HostConfig.NanoCpus, undefined)
  assert.ok(body.Env.includes('KIN_KVM_VCPUS=4'))
})

test('CPU caps apply equally to Claude and idle GPT Docker slots', () => {
  for (const platform of ['anthropic', 'openai']) {
    const slot = { ...vm({ docker_cpus: 0.5, memory: '1g' }), platform }
    const body = slotContainerBody(slot, options)
    assert.equal(body.HostConfig.NanoCpus, 500_000_000)
    assert.equal(body.HostConfig.Memory, 1024 ** 3)
    assert.deepEqual(runtime.dockerSlotResourceArgs(slot, {}), [
      '--memory',
      '1g',
      '--memory-swap',
      '1g',
      '--pids-limit',
      '256',
      '--cpus',
      '0.5',
    ])
  }
})

test('invalid persisted quotas fail before producing an unlimited runtime configuration', () => {
  assert.throws(() => slotContainerBody(vm({ docker_cpus: 'bad' }), options), /docker_cpus/)
  assert.throws(() => runtime.dockerSlotResourceArgs(vm({ docker_cpus: -1 }), {}), /docker_cpus/)
})

test('invalid persisted quotas are rejected before local/remote lifecycle work, even on recreate', async (t) => {
  assert.equal(typeof spec.slotDockerCpus, 'function')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cpu-preflight-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const invalid = vm({ docker_cpus: -1 })
  await assert.rejects(() => runtime.startVmRuntime(invalid, root, { recreate: true }), /docker_cpus/)
  const result = await startRemoteSlot(invalid, root, { recreate: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /docker_cpus/)
  assert.deepEqual(fs.readdirSync(root), [])
})
