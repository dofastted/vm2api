import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSlotCapacityReconciler } from '../../src/lib/vm/slot-capacity-reconciler.mjs'
import { configureSlotCapacity } from '../../src/lib/vm/slot-capacity.mjs'

const GiB = 1024 ** 3

function fixture({ vms, stats = {}, hostGiB = 64, availableGiB = hostGiB, routing = {} }) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-cap-rec-'))
  const records = new Map(vms.map((vm) => [vm.id, structuredClone(vm)]))
  const calls = { memory: [], pids: [] }
  const events = []
  const counters = new Map(Object.entries(stats))
  const reconciler = createSlotCapacityReconciler({
    projectRoot,
    listTargets: () => [...records.values()].map((vm) => structuredClone(vm)),
    getRouting: () => routing,
    readStats: async (vm) => counters.get(vm.id) || { oomKills: 0, pidsMaxHits: 0, pidsLimit: 256 },
    raiseMemory: async (_root, vm, memory) => {
      calls.memory.push([vm.id, memory])
      records.get(vm.id).machine = { ...(records.get(vm.id).machine || {}), memory }
      return { ok: true, memory }
    },
    raisePids: async (_root, vm, pids) => {
      calls.pids.push([vm.id, pids])
      records.get(vm.id).machine = { ...(records.get(vm.id).machine || {}), pids_limit: pids }
      return { ok: true, pids_limit: pids }
    },
    hostMemory: () => ({ totalBytes: hostGiB * GiB, availableBytes: availableGiB * GiB }),
    onEvent: (e) => events.push(e),
    log: null,
  })
  return { reconciler, records, calls, events, counters, cleanup: () => fs.rmSync(projectRoot, { recursive: true }) }
}

const pro = (id, machine = { memory: '512m' }) => ({
  id,
  status: 'running',
  machine,
  claude: { rate_limit_tier: 'default_claude_ai' },
})
const max5 = (id, machine = { memory: '512m' }) => ({
  id,
  status: 'running',
  machine,
  claude: { rate_limit_tier: 'default_claude_max_5x' },
})

test.beforeEach(() => configureSlotCapacity())

test('raises every running Claude slot to its plan target once', async () => {
  const fx = fixture({ vms: [pro('cf-a'), max5('cf-b')] })
  await fx.reconciler.tick()
  assert.deepEqual(fx.calls.memory, [
    ['cf-a', '2g'],
    ['cf-b', '4g'],
  ])
  assert.deepEqual(fx.calls.pids, [
    ['cf-a', 448],
    ['cf-b', 896],
  ])
  await fx.reconciler.tick()
  assert.equal(fx.calls.memory.length, 2, 'already at target: no further raise')
  assert.equal(fx.calls.pids.length, 2)
  fx.cleanup()
})

test('skips codex, KVM and stopped slots', async () => {
  const fx = fixture({
    vms: [
      { ...pro('cf-codex'), platform: 'openai' },
      { ...pro('cf-kvm'), runtime: { type: 'kvm' } },
      { ...pro('cf-off'), status: 'stopped' },
    ],
  })
  await fx.reconciler.tick()
  assert.deepEqual(fx.calls, { memory: [], pids: [] })
  fx.cleanup()
})

test('a new OOM kill steps memory above the plan target; a pids hit doubles pids', async () => {
  const fx = fixture({
    vms: [pro('cf-a', { memory: '4g', pids_limit: 768 })],
    stats: { 'cf-a': { oomKills: 3, pidsMaxHits: 0, pidsLimit: 768 } },
  })
  await fx.reconciler.tick() // baseline: past kills do not count
  assert.deepEqual(fx.calls, { memory: [], pids: [] })
  fx.counters.set('cf-a', { oomKills: 4, pidsMaxHits: 2, pidsLimit: 768 })
  await fx.reconciler.tick()
  assert.deepEqual(fx.calls.memory, [['cf-a', '8g']])
  assert.deepEqual(fx.calls.pids, [['cf-a', 1536]])
  assert.deepEqual(
    fx.events.filter((e) => e.kind.endsWith('_raised')).map((e) => [e.kind, e.reason]),
    [
      ['memory_raised', 'oom_kill'],
      ['pids_raised', 'pids_limit_hit'],
    ],
  )
  fx.cleanup()
})

test('the host budget leaves room for non-slot memory and asks for another machine', async () => {
  // 10 GiB host, 4 GiB used outside slots: (10 − 4) × 0.9 ≈ 5529 MiB for slot limits.
  // Two 512m slots use 1024 MiB; one raise to 4g fits, the second does not.
  const fx = fixture({ vms: [max5('cf-a'), max5('cf-b')], hostGiB: 10, availableGiB: 6 })
  await fx.reconciler.tick()
  assert.deepEqual(fx.calls.memory, [['cf-a', '4g']], 'second raise would exceed the budget')
  const exhausted = fx.events.filter((e) => e.kind === 'host_memory_exhausted')
  assert.equal(exhausted.length, 1)
  assert.equal(exhausted[0].vm_id, 'cf-b')
  assert.equal(exhausted[0].non_slot_mib, 4096)
  // pids cost no host memory and still converge.
  assert.deepEqual(
    fx.calls.pids.map(([id]) => id),
    ['cf-a', 'cf-b'],
  )
  await fx.reconciler.tick()
  assert.equal(fx.events.filter((e) => e.kind === 'host_memory_exhausted').length, 1, 'repeat event is throttled')
  fx.cleanup()
})

test('memory the slots themselves use is not counted as non-slot memory', async () => {
  // Same 4 GiB in use, but it is the slots' own: nothing is set aside, both raises fit.
  const busy = { oomKills: 0, pidsMaxHits: 0, pidsLimit: 256, memoryCurrentBytes: 2 * GiB }
  const fx = fixture({
    vms: [max5('cf-a'), max5('cf-b')],
    hostGiB: 10,
    availableGiB: 6,
    stats: { 'cf-a': busy, 'cf-b': busy },
  })
  await fx.reconciler.tick()
  assert.deepEqual(fx.calls.memory, [
    ['cf-a', '4g'],
    ['cf-b', '4g'],
  ])
  assert.equal(fx.events.filter((e) => e.kind === 'host_memory_exhausted').length, 0)
  fx.cleanup()
})

test('disabled capacity does nothing', async () => {
  const fx = fixture({ vms: [pro('cf-a')], routing: { slot_capacity: { enabled: false } } })
  const out = await fx.reconciler.tick()
  assert.equal(out.skipped, 'disabled')
  assert.deepEqual(fx.calls, { memory: [], pids: [] })
  fx.cleanup()
})

test('a container already above its record is adopted, never lowered', async () => {
  const fx = fixture({
    vms: [pro('cf-a', { memory: '512m' })],
    stats: { 'cf-a': { oomKills: 0, pidsMaxHits: 0, pidsLimit: 2048, memoryBytes: 8 * GiB } },
  })
  await fx.reconciler.tick()
  assert.deepEqual(fx.calls.memory, [['cf-a', '8g']], 'records the live 8g instead of asking for 2g')
  assert.deepEqual(fx.calls.pids, [['cf-a', 2048]])
  assert.deepEqual(
    fx.events.filter((e) => e.kind.endsWith('_raised')).map((e) => e.reason),
    ['adopt_live', 'adopt_live'],
  )
  fx.cleanup()
})
