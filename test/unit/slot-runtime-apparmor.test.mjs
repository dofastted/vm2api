import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { activateCragLicense } from '../../src/lib/vm/crag-license.mjs'
import { reloadSlotReady } from '../../src/lib/vm/slot-runtime.mjs'
import { issueUniversalCode, seedEncryptedPackage } from '../fixtures/crag-license.mjs'

const linuxTest = process.platform === 'linux' ? test : test.skip

function fixture(t, { runtime = 'kvm', dataplane = 'crag' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-runtime-apparmor-'))
  const previous = {
    KIN_SLOT_RUN_ROOT: process.env.KIN_SLOT_RUN_ROOT,
    KIN_CRAG_V2_ROOT: process.env.KIN_CRAG_V2_ROOT,
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  process.env.KIN_SLOT_RUN_ROOT = path.join(root, 'run')
  process.env.KIN_CRAG_V2_ROOT = seedEncryptedPackage(root)
  const vm = {
    id: 'vm-13',
    status: 'running',
    inference_engine: 'rust',
    dataplane,
    crag_kernel_version: 'v2',
    has_token: true,
    runtime: { type: runtime },
  }
  fs.mkdirSync(path.join(root, 'vms', vm.id, 'cli-home'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const activated = activateCragLicense(root, vm, issueUniversalCode(root).code)
  assert.equal(activated.license.valid, true)
  return { root, vm }
}

for (const { name, action, runtime, dataplane, routing, prepare } of [
  { name: 'started KVM CRAG v2', action: 'started', prepare: true },
  { name: 'created KVM CRAG v2', action: 'created', prepare: true },
  { name: 'already-running KVM CRAG v2', action: 'already-running', prepare: false },
  { name: 'reloaded KVM CRAG v2', action: 'reloaded', prepare: false },
  { name: 'started Docker CRAG v2', action: 'started', runtime: 'docker', prepare: false },
  { name: 'created Docker CRAG v2', action: 'created', runtime: 'docker', prepare: false },
  { name: 'started KVM wrap', action: 'started', dataplane: 'wrap', prepare: false },
  { name: 'created KVM wrap', action: 'created', dataplane: 'wrap', prepare: false },
  {
    name: 'started KVM inheriting CRAG v2',
    action: 'started',
    dataplane: 'inherit',
    routing: { inference: { dataplane: 'crag', crag_kernel_version: 'v2' } },
    prepare: true,
  },
  {
    name: 'started KVM wrap overriding global CRAG v2',
    action: 'started',
    dataplane: 'wrap',
    routing: { inference: { dataplane: 'crag', crag_kernel_version: 'v2' } },
    prepare: false,
  },
]) {
  linuxTest(`reloadSlotReady ${name} ${prepare ? 'prepares' : 'does not prepare'} guest AppArmor`, async (t) => {
    const { root, vm } = fixture(t, { runtime, dataplane })
    const starts = []
    let reloads = 0
    let wrapMaterializations = 0
    const result = await reloadSlotReady(vm, root, {
      routing,
      timeoutMs: 1234,
      ops: {
        reloadSlot: async (candidate, projectRoot) => {
          assert.equal(candidate, vm)
          assert.equal(projectRoot, root)
          reloads++
          return { ok: true, action, runtime: vm.runtime }
        },
        ensureRustKernel: async (exec, options) => {
          starts.push({ exec, options })
          return { ok: true, reason: 'already_up' }
        },
        materializeWrapCli: () => {
          wrapMaterializations++
          return { ok: true, wrapper: true, kernel_bin: true }
        },
      },
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.rust_ok, true, JSON.stringify(result))
    assert.equal(result.action, action)
    assert.equal(reloads, 1)
    assert.equal(starts.length, 1)
    assert.equal(starts[0].exec.vmId, vm.id)
    assert.equal(starts[0].exec.homeDir, path.join(root, 'vms', vm.id, 'cli-home'))
    assert.equal(starts[0].options.timeoutMs, 1234)
    assert.equal(Object.hasOwn(starts[0].options, 'force'), false)
    if (prepare) assert.equal(starts[0].options.prepareGuestAppArmor, true)
    else assert.equal(Object.hasOwn(starts[0].options, 'prepareGuestAppArmor'), false)
    assert.equal(wrapMaterializations, dataplane === 'wrap' ? 1 : 0)
  })
}
