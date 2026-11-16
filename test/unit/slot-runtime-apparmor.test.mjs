import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { activateCragLicense } from '../../src/lib/vm/crag-license.mjs'
import { reloadRemoteSlot, startRemoteSlot } from '../../src/lib/cluster/remote-slot.mjs'
import { configureCragRuntimeAdmission } from '../../src/lib/vm/slot-runtime-admission.mjs'
import { reloadSlotReady, startSlotReady, switchSlotInferenceEngine } from '../../src/lib/vm/slot-runtime.mjs'
import { reloadSlotWorker, startVmRuntime } from '../../src/lib/vm/vm-runtime.mjs'
import { materializeCragV2 } from '../../src/lib/vm/wrap-cli-runtime.mjs'
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

linuxTest('a denied CRAG reservation prevents start, reload and switch side effects at each entry point', async (t) => {
  const { root, vm } = fixture(t, { dataplane: 'inherit', runtime: 'docker' })
  const routing = { inference: { dataplane: 'crag' } }
  const denied = { ok: false, code: 'crag_runtime_limit' }
  const admitted = []
  configureCragRuntimeAdmission(root, (candidate, options) => {
    assert.equal(candidate.id, vm.id)
    assert.equal(options.routing, routing)
    admitted.push([options.action, options.bindSubscription === true])
    return denied
  })
  t.after(() => configureCragRuntimeAdmission(root, null))
  const unexpected = () => assert.fail('side effects after denied admission')
  const options = { routing, ops: { startSlot: unexpected, reloadSlot: unexpected } }
  assert.equal(await startSlotReady(vm, root, { ...options, bindSubscription: true }), denied)
  assert.equal(await reloadSlotReady(vm, root, options), denied)
  assert.equal(await startVmRuntime(vm, root, options), denied)
  assert.equal(await reloadSlotWorker(vm, root, options), denied)
  const nodeVm = { ...vm, node_id: 'must-not-contact' }
  assert.equal(await startRemoteSlot(nodeVm, root, options), denied)
  assert.equal(await reloadRemoteSlot(nodeVm, root, options), denied)
  assert.equal(
    await switchSlotInferenceEngine(vm, root, 'rust', { ops: { routing, inspectContainer: unexpected } }),
    denied,
  )
  assert.deepEqual(admitted, [
    ['start', true],
    ['reload', false],
    ['start', false],
    ['reload', false],
    ['start', false],
    ['reload', false],
    ['switch', false],
  ])
})

linuxTest(
  'ready-start retains one reservation through native readiness and preserves a recorded package',
  async (t) => {
    const { root, vm } = fixture(t, { runtime: 'docker' })
    const installed = materializeCragV2(root, vm)
    assert.equal(installed.ok, true)
    vm.kernel_installation = { kernel: 'crag' }
    const manifest = path.join(installed.dest, 'crag-v2', 'manifest.json')
    const original = fs.readFileSync(manifest)
    seedEncryptedPackage(root, { revision: 'changed-download-cache' })
    let held = false
    let checks = 0
    configureCragRuntimeAdmission(root, async (_candidate, _options, run) => {
      checks++
      held = true
      try {
        return await run()
      } finally {
        held = false
      }
    })
    t.after(() => configureCragRuntimeAdmission(root, null))
    const boot = await startSlotReady(vm, root, {
      ops: {
        startSlot: async () => {
          assert.equal(held, true)
          return { ok: true, action: 'started', runtime: vm.runtime }
        },
        ensureRustKernel: async () => {
          assert.equal(held, true)
          assert.deepEqual(fs.readFileSync(manifest), original)
          return { ok: true }
        },
      },
    })
    assert.equal(boot.rust_ok, true)
    assert.equal(checks, 1)
    assert.equal(held, false)
  },
)

linuxTest('a recorded CRAG selection never starts from cache if its slot package is missing', async (t) => {
  const { root, vm } = fixture(t, { runtime: 'docker' })
  vm.kernel_installation = { kernel: 'crag' }
  for (const boot of [startVmRuntime, reloadSlotWorker]) {
    const result = await boot(vm, root)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'crag_v2_package_missing')
  }
})
