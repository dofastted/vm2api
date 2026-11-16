import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as watchdog from '../../src/lib/transport/kernel-watchdog.mjs'
import { kernelFaults } from '../../src/lib/transport/rust-kernel-client.mjs'
import { activateCragLicense } from '../../src/lib/vm/crag-license.mjs'
import { configureCragRuntimeAdmission } from '../../src/lib/vm/slot-runtime-admission.mjs'
import { issueUniversalCode, seedEncryptedPackage } from '../fixtures/crag-license.mjs'

test.afterEach(() => {
  for (const id of ['vm-observation', 'vm-bad', 'vm-good']) kernelFaults.delete(id)
})

function fixture({ state = 'running', runtime, node_id, status = 'running', observe, health, ensure, revive } = {}) {
  let at = 0
  const actions = []
  const vm = { id: 'vm-observation', status, runtime, node_id }
  const wd = watchdog.createKernelWatchdog({
    listTargets: () => [vm],
    now: () => at,
    config: { restart_backoff_sec: [10] },
    health: health || (async () => null),
    observeRuntime: observe || (async () => ({ state })),
    ensure:
      ensure ||
      (async () => {
        actions.push('ensure')
        return { ok: true }
      }),
    revive:
      revive ||
      (async () => {
        actions.push('revive')
        return { ok: true }
      }),
  })
  return {
    wd,
    vm,
    actions,
    advance: (ms) => {
      at = ms
    },
  }
}

for (const state of ['unknown', 'paused']) {
  test(`${state} runtime does not spend recovery budget or cause a restart`, async () => {
    const f = fixture({ state })
    for (const ms of [0, 10_000, 20_000]) {
      f.advance(ms)
      await f.wd.tick()
    }
    assert.deepEqual(f.actions, [])
    assert.equal(f.wd.restartsInWindow(f.vm.id), 0)
    assert.equal(kernelFaults.has(f.vm.id), false)
  })
}
for (const state of ['missing', 'stopped', 'restarting']) {
  for (const placement of [
    { runtime: { type: 'docker' } },
    { runtime: { type: 'kvm' } },
    { node_id: 'node-fixture' },
  ]) {
    test(`${state} ${JSON.stringify(placement)} revives only after backoff, without a blind kernel restart`, async () => {
      const f = fixture({ state, ...placement })
      try {
        await f.wd.tick()
        assert.deepEqual(f.actions, [])
        f.advance(10_000)
        await f.wd.tick()
        assert.deepEqual(f.actions, ['revive'])
        assert.equal(f.wd.restartsInWindow(f.vm.id), 1)
        f.advance(30_000)
        await f.wd.tick()
        assert.deepEqual(f.actions, ['revive'])
        assert.ok(kernelFaults.has(f.vm.id))
      } finally {
        kernelFaults.delete(f.vm.id)
      }
    })
  }
}

test('unknown observations recover without consuming retries; running-but-dead kernel is still restarted', async () => {
  let state = 'unknown'
  const f = fixture({ observe: async () => ({ state }) })
  await f.wd.tick()
  f.advance(30_000)
  await f.wd.tick()
  state = 'running'
  await f.wd.tick()
  assert.deepEqual(f.actions, [])
  f.advance(40_000)
  await f.wd.tick()
  assert.deepEqual(f.actions, ['ensure'])
})

test('stopped intent is not probed or revived and planned intent is not booted', async () => {
  for (const status of ['stopped', 'disabled', 'planned']) {
    const f = fixture({ state: 'missing', status })
    await f.wd.tick()
    f.advance(10_000)
    await f.wd.tick()
    assert.deepEqual(f.actions, [])
    assert.equal(f.wd.restartsInWindow(f.vm.id), 0)
  }
})

test('a permission-like container_unavailable result cannot trigger boot without confirmed absence', async () => {
  const f = fixture({
    ensure: async () => ({ ok: false, reason: 'container_unavailable', error: 'daemon not running' }),
  })
  await f.wd.tick()
  f.advance(10_000)
  await f.wd.tick()
  assert.deepEqual(f.actions, [])
})

test('watchdog admits a running kernel restart and a physical revival before spending either attempt', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-watchdog-admission-'))
  const previousRunRoot = process.env.KIN_SLOT_RUN_ROOT
  process.env.KIN_SLOT_RUN_ROOT = path.join(root, 'run')
  t.after(() => {
    configureCragRuntimeAdmission(root, null)
    if (previousRunRoot === undefined) delete process.env.KIN_SLOT_RUN_ROOT
    else process.env.KIN_SLOT_RUN_ROOT = previousRunRoot
    fs.rmSync(root, { recursive: true, force: true })
  })
  const vm = { id: 'vm-observation', status: 'running', dataplane: 'crag' }
  const home = path.join(root, 'vms', vm.id, 'cli-home')
  fs.mkdirSync(home, { recursive: true })
  seedEncryptedPackage(root)
  assert.equal(activateCragLicense(root, vm, issueUniversalCode(root).code).license.valid, true)
  let state = 'running'
  let at = 0
  let admitted = 0
  let allow = false
  const actions = []
  configureCragRuntimeAdmission(root, (target, options, run) => {
    assert.equal(target.id, vm.id)
    assert.equal(options.action, 'recovery')
    admitted++
    return allow ? run() : { ok: false, code: 'crag_runtime_limit' }
  })
  const wd = watchdog.createKernelWatchdog({
    listTargets: () => [vm],
    now: () => at,
    config: { restart_backoff_sec: [10] },
    homeDirFor: () => home,
    health: async () => null,
    observeRuntime: async () => ({ state }),
    ensure: async () => actions.push('ensure'),
    revive: async () => {
      actions.push('revive')
      return { ok: true }
    },
  })
  await wd.tick()
  at = 10_000
  await wd.tick()
  state = 'missing'
  await wd.tick()
  assert.equal(admitted, 2)
  assert.equal(wd.restartsInWindow(vm.id), 0)
  assert.deepEqual(actions, [])
  allow = true
  await wd.tick()
  assert.equal(admitted, 3)
  assert.equal(wd.restartsInWindow(vm.id), 1)
  assert.deepEqual(actions, ['revive'])
})

test('hold during an observation prevents restart and releases the in-flight tick', async () => {
  let finish
  const f = fixture({
    observe: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  })
  const tick = f.wd.tick()
  await new Promise((r) => setImmediate(r))
  const held = f.wd.hold(f.vm.id)
  finish({ state: 'missing' })
  await Promise.all([tick, held])
  f.advance(10_000)
  await f.wd.tick()
  assert.deepEqual(f.actions, [])
})

test('one rejected health probe or ensure call does not starve the next slot or reject tick', async () => {
  for (const phase of ['health', 'ensure', 'observe']) {
    let at = 0
    const ensured = []
    const wd = watchdog.createKernelWatchdog({
      config: { restart_backoff_sec: [10] },
      listTargets: () => [{ id: 'vm-bad' }, { id: 'vm-good' }],
      now: () => at,
      health: async (exec) => {
        if (phase === 'health' && exec.vmId === 'vm-bad') throw new Error('fixture health')
        return null
      },
      observeRuntime: async (vm) => {
        if (phase === 'observe' && vm.id === 'vm-bad') throw new Error('fixture permission')
        return { state: 'running' }
      },
      ensure: async (exec) => {
        if (phase === 'ensure' && exec.vmId === 'vm-bad') throw new Error('fixture ensure')
        ensured.push(exec.vmId)
        return { ok: true }
      },
    })
    await wd.tick()
    at = 10_000
    await wd.tick()
    assert.ok(ensured.includes('vm-good'))
  }
})

test('overlapping ticks do not duplicate observations or recovery', async () => {
  let finish,
    calls = 0
  const f = fixture({
    observe: () => {
      calls++
      return new Promise((r) => {
        finish = r
      })
    },
  })
  const first = f.wd.tick()
  await new Promise((r) => setImmediate(r))
  await f.wd.tick()
  assert.equal(calls, 1)
  finish({ state: 'running' })
  await first
})

test('Docker observation distinguishes 404, HTTP failures, malformed payloads and state flags on the selected host', async () => {
  const cases = [
    [404, {}, 'missing'],
    [403, {}, 'unknown'],
    [500, {}, 'unknown'],
    [200, {}, 'unknown'],
    [200, { State: { Running: true } }, 'running'],
    [200, { State: { Running: true, Paused: true } }, 'paused'],
    [200, { State: { Running: true, Restarting: true } }, 'restarting'],
    [200, { State: { Running: false, Status: 'paused' } }, 'paused'],
    [200, { State: { Running: true, Status: 'restarting' } }, 'restarting'],
    [200, { State: { Running: false, Status: 'exited', Restarting: true } }, 'restarting'],
    [200, { State: { Running: false, Status: 'exited' } }, 'stopped'],
    [200, { State: { Running: false } }, 'unknown'],
  ]
  for (const [status, payload, state] of cases) {
    const vm = { id: 'vm-fixture', node_id: 'node-fixture', runtime: { container: 'custom/name' } }
    const connector = () => {
      throw new Error('fixture must not connect')
    }
    const result = await watchdog.observeWatchdogContainer(vm, {
      hostFor: (target) => {
        assert.equal(target, vm)
        return { dockerApi: () => connector }
      },
      request: async (connect, options) => {
        assert.equal(connect, connector)
        assert.equal(options.path, '/containers/custom%2Fname/json')
        return { status, body: Buffer.from(JSON.stringify(payload)) }
      },
    })
    assert.equal(result.state, state)
  }
  const options = { hostFor: () => ({ dockerApi: () => () => {} }) }
  for (const request of [
    async () => {
      throw new Error('EACCES')
    },
    async () => ({ status: 200, body: Buffer.from('broken json') }),
  ]) {
    assert.equal((await watchdog.observeWatchdogContainer({ id: 'vm-01' }, { ...options, request })).state, 'unknown')
  }
  assert.equal(
    (
      await watchdog.observeWatchdogContainer(
        { id: 'vm-01' },
        { ...options, request: () => new Promise(() => {}), timeoutMs: 10 },
      )
    ).state,
    'unknown',
  )
})
