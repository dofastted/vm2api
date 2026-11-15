import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  configureSlotCapacity,
  effectiveSlotCount,
  nextMemoryOption,
  normalizeSlotCapacityConfig,
  planSlots,
  resourcesForSlots,
  slotCreationLimits,
  slotPlanOf,
  slotsForLimits,
} from '../../src/lib/vm/slot-capacity.mjs'
import {
  expectedKernelSlots,
  kernelSlotsConverge,
  kernelSlotsDiffer,
  wrapSlotCount,
} from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { classifyUpstreamResult, shouldContinue } from '../../src/lib/pool/upstream-error-policy.mjs'

const pro = (machine = {}) => ({ id: 'cf-pro', machine, claude: { rate_limit_tier: 'default_claude_ai' } })
const max5 = (machine = {}) => ({ id: 'cf-max5', machine, claude: { rate_limit_tier: 'default_claude_max_5x' } })
const max20 = (machine = {}) => ({ id: 'cf-max20', machine, claude: { rate_limit_tier: 'default_claude_max_20x' } })

test.beforeEach(() => configureSlotCapacity())

test('plan comes from the OAuth rate-limit tier, then the scheduling tier', () => {
  assert.equal(slotPlanOf(pro()), 'pro')
  assert.equal(slotPlanOf(max5()), 'max_5x')
  assert.equal(slotPlanOf(max20()), 'max_20x')
  assert.equal(slotPlanOf({ claude: { account_tier: 'max' } }), 'max_5x')
  assert.equal(slotPlanOf({ account_tier: 'pro' }), 'pro')
  assert.equal(slotPlanOf({}), 'default')
})

test('default plans fill their memory step: Pro 5 in 2g, Max 5x 12 in 4g, Max 20x 20 in 8g', () => {
  assert.equal(planSlots(pro()), 5)
  assert.equal(planSlots(max5()), 12)
  assert.equal(planSlots(max20()), 20)
  assert.equal(planSlots({}), 5)
  assert.deepEqual(resourcesForSlots(5), { slots: 5, memory: '2g', memoryMiB: 2048, pids: 448 })
  assert.deepEqual(resourcesForSlots(12), { slots: 12, memory: '4g', memoryMiB: 4096, pids: 896 })
  assert.deepEqual(resourcesForSlots(20), { slots: 20, memory: '8g', memoryMiB: 8192, pids: 1408 })
  // One more session would need the next step.
  assert.equal(resourcesForSlots(6).memory, '4g')
  assert.equal(resourcesForSlots(13).memory, '8g')
})

test('effective slots are the plan target clamped to what the recorded limits hold', () => {
  // The pre-capacity default: 512m and 256 pids hold no full session, so one slot.
  assert.equal(effectiveSlotCount(pro({ memory: '512m' })), 1)
  assert.equal(effectiveSlotCount(pro({ memory: '1g', pids_limit: 448 })), 2)
  assert.equal(effectiveSlotCount(pro({ memory: '2g', pids_limit: 448 })), 5)
  // More room than the plan needs does not raise the slot count above the plan.
  assert.equal(effectiveSlotCount(pro({ memory: '16g', pids_limit: 4096 })), 5)
  // pids bind as well as memory.
  assert.equal(effectiveSlotCount(max5({ memory: '8g', pids_limit: 256 })), 2)
  assert.equal(effectiveSlotCount(max5({ memory: '4g', pids_limit: 896 })), 12)
  assert.equal(wrapSlotCount(max5({ memory: '4g', pids_limit: 896 })), 12)
  assert.equal(wrapSlotCount(max20({ memory: '8g', pids_limit: 1408 })), 20)
  assert.equal(slotsForLimits({ memoryMiB: 256, pids: 128 }), 0)
})

test('disabled capacity keeps the legacy fixed 20 slots and recorded limits', () => {
  configureSlotCapacity({ enabled: false })
  assert.equal(effectiveSlotCount(pro({ memory: '512m' })), 20)
  assert.deepEqual(slotCreationLimits(pro({ memory: '512m' })), { memory: '512m', pids: 256 })
})

test('routing.slot_capacity overrides plans and per-session costs', () => {
  const routing = { slot_capacity: { plans: { pro: 4 }, per_session_mib: 512, base_mib: 512 } }
  assert.equal(planSlots(pro(), routing), 4)
  // 512 + 4×512 = 2560 MiB → 4g option.
  assert.equal(resourcesForSlots(4, routing).memory, '4g')
  const cfg = normalizeSlotCapacityConfig({ plans: { pro: 99, max_5x: 0 }, host_memory_ratio: 5 })
  assert.equal(cfg.plans.pro, 20)
  assert.equal(cfg.plans.max_5x, 1)
  assert.equal(cfg.host_memory_ratio, 1)
})

test('new containers start at least at the plan target; codex slots keep their spec', () => {
  assert.deepEqual(slotCreationLimits(pro({ memory: '512m' })), { memory: '2g', pids: 448 })
  assert.deepEqual(slotCreationLimits(pro({ memory: '16g', pids_limit: 2048 })), { memory: '16g', pids: 2048 })
  assert.deepEqual(slotCreationLimits({ ...pro({ memory: '1g' }), platform: 'openai' }), { memory: '1g', pids: 256 })
})

test('nextMemoryOption steps through the standard options', () => {
  assert.equal(nextMemoryOption('4g'), '8g')
  assert.equal(nextMemoryOption('512m'), '1g')
  assert.equal(nextMemoryOption('16g'), null)
})

test('kernel slot mismatch prefers the live crag capacity over the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-cap-'))
  const file = path.join(dir, 'kernel.json')
  fs.writeFileSync(file, JSON.stringify({ slots_per_worker: 10 }))
  const up = { ok: true, engine: 'rust', healthy: true, capacity: 20, cli_pid: 1 }
  // File already rewritten to 10, process still runs 20: a reload is still owed.
  assert.equal(kernelSlotsDiffer(file, up, 10), true)
  assert.equal(kernelSlotsDiffer(file, { ...up, capacity: 10 }, 10), false)
  // No live value: fall back to the file.
  assert.equal(kernelSlotsDiffer(file, null, 10), false)
  assert.equal(kernelSlotsDiffer(file, null, 20), true)
  // The wrap dataplane reports its live count under memory.native_host.slots.
  const wrap = { ok: true, engine: 'rust', healthy: true, cli_pid: 86, memory: { native_host: { slots: 20 } } }
  assert.equal(kernelSlotsDiffer(file, wrap, 10), true)
  assert.equal(kernelSlotsDiffer(file, wrap, 20), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a dead native Claude process fails over without opening the unit circuit', () => {
  for (const message of [
    'Claude process exited (None): Claude native process exited with code None',
    'Claude process exited (Some(1)): Claude native process exited with code Some(1)',
  ]) {
    const policy = classifyUpstreamResult({
      ok: false,
      status: 502,
      body: { type: 'error', error: { type: 'process_error', message } },
    })
    assert.equal(policy.reason, 'worker_process_exit')
    assert.equal(policy.scope, 'worker')
    assert.equal(shouldContinue(policy), true)
    assert.equal(policy.retrySameAccount, false)
    assert.notEqual(policy.circuit, true)
    assert.equal(policy.cooldownUntil, null)
  }
})

test('a kernel start sizes from the current record, not the exec snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-cap-root-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const record = max5({ memory: '4g', pids_limit: 896 })
  fs.writeFileSync(path.join(root, 'vms', `${record.id}.json`), JSON.stringify(record))
  // The snapshot predates the raise: 512m would size the kernel to 1 slot.
  const exec = { vmId: record.id, vm: max5({ memory: '512m' }), homeDir: path.join(root, 'vms', record.id, 'cli-home') }
  assert.equal(expectedKernelSlots(exec), 12)
  // No record on disk: fall back to the snapshot.
  assert.equal(expectedKernelSlots({ vm: max5({ memory: '512m' }) }), 1)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a kernel already running the right count only gets its stale file rewritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-cap-'))
  const file = path.join(dir, 'kernel.json')
  fs.writeFileSync(file, JSON.stringify({ slots_per_worker: 1, dataplane: 'native' }))
  const up = { ok: true, engine: 'rust', healthy: true, capacity: 20, cli_pid: 1 }
  assert.equal(kernelSlotsConverge(file, up, 20), false, 'no reload owed')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { slots_per_worker: 20, dataplane: 'native' })
  assert.equal(kernelSlotsConverge(file, { ...up, capacity: 10 }, 20), true, 'live count differs: reload')
  fs.rmSync(dir, { recursive: true, force: true })
})
