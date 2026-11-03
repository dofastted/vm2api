import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKernelWatchdog, isKernelWatchdogTarget } from '../../src/lib/transport/kernel-watchdog.mjs'
import { kernelFaults } from '../../src/lib/transport/rust-kernel-client.mjs'

test('watchdog targets inherited rust; stored go is rust; skips Codex and stopped', () => {
  const rustRouting = { inference: { engine: 'rust' } }
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01' }, rustRouting), true)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01' }), true, 'empty routing still defaults to rust')
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01', inference_engine: 'rust' }), true)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01', runtime: { engine: 'rust' } }), true)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01', inference_engine: 'go' }), true)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01', status: 'stopped' }, rustRouting), false)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01', status: 'dead' }, rustRouting), false)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-kvm', runtime_kind: 'kvm' }, rustRouting), true)
  assert.equal(isKernelWatchdogTarget({ id: 'gpt-01', platform: 'openai' }, rustRouting), false)
  assert.equal(isKernelWatchdogTarget({ id: 'gpt-01', family: 'codex', inference_engine: 'rust' }, rustRouting), false)
})

test('watchdog restarts only a dead kernel or one that gave up on its CLI', async () => {
  const ensured = []
  let now = 0
  const wd = createKernelWatchdog({
    observeRuntime: async () => ({ state: 'running' }),
    now: () => now,
    listTargets: () => [
      { id: 'vm-up', inference_engine: 'rust' },
      { id: 'vm-busy', inference_engine: 'rust' },
      { id: 'vm-recovering', inference_engine: 'rust' },
      { id: 'vm-partial', inference_engine: 'rust' },
      { id: 'vm-gave-up', inference_engine: 'rust' },
      { id: 'vm-down', inference_engine: 'rust' },
    ],
    homeDirFor: (vm) => `/tmp/${vm.id}`,
    health: async (exec) => {
      if (exec.vmId === 'vm-up') return { ok: true, healthy: true, ready_slots: 1, cli_pid: 1 }
      if (exec.vmId === 'vm-busy') return { ok: true, healthy: true, ready_slots: 0, cli_pid: 9 }
      // The kernel is restarting its own CLI: a container restart would cut it off.
      if (exec.vmId === 'vm-recovering')
        return { ok: true, healthy: true, recovering: true, ready_slots: 0, cli_pid: 0 }
      // Closed slots are the kernel's own L1 business.
      if (exec.vmId === 'vm-partial') return { ok: true, healthy: true, ready_slots: 2, closed_slots: 18, cli_pid: 3 }
      if (exec.vmId === 'vm-gave-up') return { ok: true, healthy: false, unhealthy_reason: 'cli restarts spent' }
      return null
    },
    ensure: async (exec) => {
      ensured.push(exec.vmId)
      return { ok: true }
    },
  })
  await wd.tick()
  assert.deepEqual(ensured, [], 'even process failure waits before the first restart')
  now = 60_000
  await wd.tick()
  assert.deepEqual(ensured, ['vm-gave-up', 'vm-down'])
})

test('container restarts are bounded, spaced out, then the VM is faulted until healthy', async () => {
  let now = 0
  let health = { ok: true, healthy: false, unhealthy_reason: 'cli restarts spent' }
  const ensured = []
  const faults = []
  const wd = createKernelWatchdog({
    observeRuntime: async () => ({ state: 'running' }),
    config: { restart_backoff_sec: [60, 300], restart_window_sec: 3600 },
    listTargets: () => [{ id: 'vm-loop', inference_engine: 'rust' }],
    homeDirFor: () => '/tmp/vm-loop',
    health: async () => health,
    ensure: async () => {
      ensured.push(now)
      return { ok: true }
    },
    onFault: (vm, reason) => faults.push([vm.id, reason]),
    now: () => now,
  })
  try {
    await wd.tick()
    now = 30_000
    await wd.tick()
    assert.deepEqual(ensured, [], 'first restart waits out the initial backoff')
    now = 60_000
    await wd.tick()
    assert.deepEqual(ensured, [60_000])
    now = 360_000
    await wd.tick()
    assert.deepEqual(ensured, [60_000, 360_000])
    assert.equal(faults.length, 0, 'last restart gets a health observation before exhaustion')
    now = 380_000
    await wd.tick()
    assert.deepEqual(ensured, [60_000, 360_000], 'budget spent: no third restart')
    assert.equal(faults.length, 1)
    assert.match(faults[0][1], /2 recovery attempts: cli restarts spent/)
    assert.ok(kernelFaults.has('vm-loop'), 'faulted VM is skipped by scheduling')
    now = 10_000_000
    await wd.tick()
    assert.deepEqual(ensured, [60_000, 360_000], 'a faulted VM is not restarted again')
    assert.equal(faults.length, 1, 'fault is reported once')

    health = { ok: true, healthy: true, ready_slots: 20, cli_pid: 7 }
    await wd.tick()
    assert.equal(kernelFaults.has('vm-loop'), false, 'healthy again clears the fault')
    health = { ok: true, healthy: false, unhealthy_reason: 'again' }
    await wd.tick()
    assert.deepEqual(ensured, [60_000, 360_000], 'fresh recovery also respects the first backoff')
    now += 60_000
    await wd.tick()
    assert.deepEqual(ensured, [60_000, 360_000, 10_060_000])
  } finally {
    kernelFaults.delete('vm-loop')
  }
})

test('watchdog does not restart a live crag slot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wd-crag-'))
  const home = path.join(root, 'vms', 'vm-crag', 'cli-home')
  const run = path.join(root, 'vms', 'vm-crag', 'run')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'kernel.json'), JSON.stringify({ dataplane: 'crag' }))
  const ensured = []
  const wd = createKernelWatchdog({
    observeRuntime: async () => ({ state: 'running' }),
    listTargets: () => [{ id: 'vm-crag', inference_engine: 'rust' }],
    homeDirFor: () => home,
    health: async () => ({ ok: true, engine: 'rust', ready_slots: 0, cli_pid: 0 }),
    ensure: async (exec) => {
      ensured.push(exec.vmId)
      return { ok: true }
    },
  })
  await wd.tick()
  assert.deepEqual(ensured, [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('inherited rust slot reaches the restart ladder after CLI budget is spent', async () => {
  const ensured = []
  const faults = []
  let now = 0
  const wd = createKernelWatchdog({
    observeRuntime: async () => ({ state: 'running' }),
    now: () => now,
    getRouting: () => ({ inference: { engine: 'rust' } }),
    listTargets: () => [{ id: 'vm-inherit' }],
    homeDirFor: () => '/tmp/vm-inherit',
    health: async () => ({
      ok: true,
      healthy: false,
      unhealthy_reason: 'native cli stdout closed',
    }),
    ensure: async (exec) => {
      ensured.push(exec.vmId)
      return { ok: true }
    },
    onFault: (vm, reason) => faults.push([vm.id, reason]),
  })
  try {
    await wd.tick()
    assert.deepEqual(ensured, [], 'first restart waits out the initial backoff')
    now = 60_000
    await wd.tick()
    assert.deepEqual(ensured, ['vm-inherit'])
    now = 360_000
    await wd.tick()
    assert.deepEqual(ensured, ['vm-inherit', 'vm-inherit'])
    now = 1_260_000
    await wd.tick()
    assert.deepEqual(ensured, ['vm-inherit', 'vm-inherit', 'vm-inherit'])
    now = 1_280_000
    await wd.tick()
    assert.deepEqual(ensured, ['vm-inherit', 'vm-inherit', 'vm-inherit'], 'budget spent: no fourth restart')
    assert.equal(faults.length, 1)
    assert.match(faults[0][1], /3 recovery attempts: native cli stdout closed/)
    assert.ok(kernelFaults.has('vm-inherit'))
  } finally {
    kernelFaults.delete('vm-inherit')
  }
})

test('watchdog rereads routing each tick; Codex stays out of the restart path', async () => {
  const probed = []
  let routingCalls = 0
  let routing = { inference: { engine: 'rust' } }
  const wd = createKernelWatchdog({
    observeRuntime: async () => ({ state: 'running' }),
    getRouting: () => {
      routingCalls += 1
      return routing
    },
    listTargets: () => [{ id: 'vm-inherit' }, { id: 'gpt-01', platform: 'openai' }],
    health: async (exec) => {
      probed.push(exec.vmId)
      return { ok: true, healthy: true, ready_slots: 1, cli_pid: 1 }
    },
    ensure: async () => ({ ok: true }),
  })
  await wd.tick()
  assert.deepEqual(probed, ['vm-inherit'])
  assert.equal(routingCalls, 1)
  probed.length = 0
  // Historical go aliases to rust; inherited Claude slots stay kernel-watchdog targets.
  routing = { inference: { engine: 'go' } }
  await wd.tick()
  assert.deepEqual(probed, ['vm-inherit'])
  assert.equal(routingCalls, 2)
})

test('a missing container is booted, not just kernel-restarted, inside the same budget', async () => {
  let now = 0
  const revived = []
  const wd = createKernelWatchdog({
    observeRuntime: async () => ({ state: 'missing' }),
    listTargets: () => [
      { id: 'vm-gone', status: 'running', inference_engine: 'rust' },
      { id: 'vm-planned', status: 'planned', inference_engine: 'rust' },
    ],
    health: async () => null,
    ensure: async () => ({ ok: false, reason: 'container_unavailable', error: 'No such container' }),
    revive: async (vm) => {
      revived.push(vm.id)
      return { ok: true }
    },
    now: () => now,
  })
  await wd.tick()
  assert.deepEqual(revived, [], 'the first boot waits for the first backoff like any restart')
  now = 60_000
  await wd.tick()
  assert.deepEqual(revived, ['vm-gone'], 'only a running-intent slot is booted')
  assert.equal(wd.restartsInWindow('vm-gone'), 1)
})

test('a held slot is left alone; reset gives a faulted slot a fresh budget', async () => {
  let now = 0
  const probed = []
  const bridged = []
  const wd = createKernelWatchdog({
    observeRuntime: async () => ({ state: 'running' }),
    config: { restart_backoff_sec: [60] },
    listTargets: () => [
      { id: 'vm-held', inference_engine: 'rust' },
      { id: 'vm-loop', inference_engine: 'rust' },
    ],
    health: async (exec) => {
      probed.push(exec.vmId)
      return null
    },
    ensure: async () => ({ ok: true }),
    healBridges: async (vms) => bridged.push(vms.map((vm) => vm.id)),
    now: () => now,
  })
  try {
    wd.hold('vm-held')
    for (const at of [0, 60_000, 120_000]) {
      now = at
      await wd.tick()
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(probed.includes('vm-held'), false)
    assert.deepEqual(bridged[0], ['vm-loop'], 'bridge heal skips a held slot too')
    assert.ok(kernelFaults.has('vm-loop'), 'one restart spent: faulted')
    assert.deepEqual(wd.reset('vm-loop'), { faulted: true })
    assert.equal(kernelFaults.has('vm-loop'), false)
    assert.equal(wd.restartsInWindow('vm-loop'), 0)
    wd.release('vm-held')
    probed.length = 0
    await wd.tick()
    assert.deepEqual(probed, ['vm-held', 'vm-loop'])
  } finally {
    kernelFaults.delete('vm-loop')
  }
})

function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('a hold taken while the health probe is pending stops the restart and the boot', async () => {
  const probe = deferred()
  const actions = []
  const wd = createKernelWatchdog({
    observeRuntime: async () => ({ state: 'running' }),
    config: { restart_backoff_sec: [10] },
    listTargets: () => [{ id: 'vm-race', status: 'running', inference_engine: 'rust' }],
    health: () => probe.promise,
    ensure: async () => {
      actions.push('ensure')
      return { ok: false, reason: 'container_unavailable' }
    },
    revive: async () => {
      actions.push('revive')
      return { ok: true }
    },
    now: () => 60_000,
  })
  const ticking = wd.tick()
  await new Promise((resolve) => setImmediate(resolve))
  const drained = wd.hold('vm-race')
  probe.resolve(null)
  await ticking
  await drained
  assert.deepEqual(actions, [], 'the operator cycle owns the slot once held')
})

test('hold waits for a restart already in flight, and the boot after it is skipped', async () => {
  const restart = deferred()
  const actions = []
  let at = 0
  const wd = createKernelWatchdog({
    observeRuntime: async () => ({ state: 'running' }),
    config: { restart_backoff_sec: [10] },
    listTargets: () => [{ id: 'vm-busy', status: 'running', inference_engine: 'rust' }],
    health: async () => null,
    ensure: async () => {
      actions.push('ensure:start')
      await restart.promise
      actions.push('ensure:end')
      return { ok: false, reason: 'container_unavailable' }
    },
    revive: async () => {
      actions.push('revive')
      return { ok: true }
    },
    now: () => at,
  })
  await wd.tick()
  at = 10_000
  const ticking = wd.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(actions, ['ensure:start'])
  let settled = false
  const drained = wd.hold('vm-busy').then(() => {
    settled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false, 'hold does not return while a restart is still running')
  restart.resolve()
  await drained
  await ticking
  assert.deepEqual(actions, ['ensure:start', 'ensure:end'], 'no boot once the slot is held')
})
