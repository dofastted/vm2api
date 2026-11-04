import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createKernelWatchdog,
  watchdogProbeVm,
  NODE_SLOT_HEALTH_TIMEOUT_MS,
  NODE_SLOT_FAILURES_BEFORE_RESTART,
} from '../../src/lib/transport/kernel-watchdog.mjs'
import { kernelFaults } from '../../src/lib/transport/rust-kernel-client.mjs'

const RELAY = (nodeId, vmId) => ({
  kernel: `/relay/${nodeId}/slots/${vmId}/kernel.sock`,
  worker: `/relay/${nodeId}/slots/${vmId}/worker.sock`,
})

test('node slot is probed on its relay even when the record lost the runtime sockets', () => {
  const vm = { id: 'slot-a1', node_id: 'node-a', runtime: { type: 'docker' } }
  const probed = watchdogProbeVm(vm, { relayPaths: RELAY, exists: () => true })
  assert.equal(probed.runtime.kernel_socket, '/relay/node-a/slots/slot-a1/kernel.sock')
  assert.equal(probed.runtime.worker_socket, '/relay/node-a/slots/slot-a1/worker.sock')
  assert.equal(probed.runtime.type, 'docker')
  assert.equal(vm.runtime.kernel_socket, undefined, 'the listed record is not mutated')
  const local = { id: 'slot-local', runtime: { kernel_socket: '/opt/vm2api/vms/slot-local/run/kernel.sock' } }
  assert.equal(watchdogProbeVm(local, { relayPaths: RELAY, exists: () => false }), local)
})

test('no relay listening or no cluster: the node slot is skipped, not probed locally', () => {
  const vm = { id: 'slot-a2', node_id: 'node-a', runtime: { type: 'docker' } }
  assert.equal(watchdogProbeVm(vm, { relayPaths: RELAY, exists: () => false }), null)
  const noCluster = () => {
    throw new Error('集群未初始化')
  }
  assert.equal(watchdogProbeVm(vm, { relayPaths: noCluster, exists: () => true }), null)
})

test('a running node slot without a relay is never restarted because a local path is missing', async () => {
  const ensured = []
  const probed = []
  let now = 0
  const wd = createKernelWatchdog({
    listTargets: () => [{ id: 'slot-b1', node_id: 'node-b', status: 'running', runtime: { type: 'docker' } }],
    homeDirFor: (vm) => `/opt/vm2api/vms/${vm.id}/cli-home`,
    probeVm: (vm) => watchdogProbeVm(vm, { relayPaths: RELAY, exists: () => false }),
    health: async (exec) => {
      probed.push(exec.vm.runtime?.kernel_socket)
      return { ok: false, error: 'connect ENOENT /opt/vm2api/vms/slot-b1/run/kernel.sock' }
    },
    observeRuntime: async () => ({ state: 'running' }),
    ensure: async (exec) => {
      ensured.push(exec.vmId)
      return { ok: true }
    },
    now: () => now,
  })
  for (const at of [0, 60_000, 400_000, 1_400_000, 2_000_000]) {
    now = at
    await wd.tick()
  }
  assert.deepEqual(probed, [], 'the local vms/<id>/run/kernel.sock is never dialed for a node slot')
  assert.deepEqual(ensured, [])
  assert.equal(kernelFaults.has('slot-b1'), false)
})

test('a node slot that answers on its relay is left alone', async () => {
  const ensured = []
  const sockets = []
  let now = 0
  const wd = createKernelWatchdog({
    listTargets: () => [{ id: 'slot-b2', node_id: 'node-b', status: 'running', runtime: { type: 'docker' } }],
    homeDirFor: (vm) => `/opt/vm2api/vms/${vm.id}/cli-home`,
    probeVm: (vm) => watchdogProbeVm(vm, { relayPaths: RELAY, exists: () => true }),
    health: async (exec) => {
      sockets.push(exec.vm.runtime.kernel_socket)
      return { ok: true, healthy: true, ready_slots: 1, cli_pid: 7 }
    },
    observeRuntime: async () => ({ state: 'running' }),
    ensure: async (exec) => {
      ensured.push(exec.vmId)
      return { ok: true }
    },
    now: () => now,
  })
  for (const at of [0, 60_000, 400_000]) {
    now = at
    await wd.tick()
  }
  assert.deepEqual(sockets, Array(3).fill('/relay/node-b/slots/slot-b2/kernel.sock'))
  assert.deepEqual(ensured, [])
})

test('a genuinely dead remote kernel behind a live relay keeps the bounded L4/L5 budget after repeated probe failures', async () => {
  kernelFaults.delete('slot-a1')
  const ensured = []
  const faults = []
  let now = 0
  const wd = createKernelWatchdog({
    config: { restart_backoff_sec: [60, 300, 900], restart_window_sec: 3600 },
    listTargets: () => [{ id: 'slot-a1', node_id: 'node-a', status: 'running', runtime: { type: 'docker' } }],
    homeDirFor: (vm) => `/opt/vm2api/vms/${vm.id}/cli-home`,
    probeVm: (vm) => watchdogProbeVm(vm, { relayPaths: RELAY, exists: () => true }),
    health: async () => null,
    observeRuntime: async () => ({ state: 'running' }),
    ensure: async (exec) => {
      assert.equal(exec.vm.runtime.kernel_socket, '/relay/node-a/slots/slot-a1/kernel.sock')
      ensured.push(now)
      return { ok: true }
    },
    onFault: (vm, reason) => faults.push([vm.id, reason]),
    now: () => now,
  })
  for (const at of [0, 30_000, 60_000, 200_000, 360_000, 1_000_000, 1_260_000, 1_500_000, 2_200_000, 2_240_000]) {
    now = at
    await wd.tick()
  }
  assert.deepEqual(ensured, [200_000, 1_000_000, 2_200_000])
  assert.equal(faults.length, 1)
  assert.equal(faults[0][0], 'slot-a1')
  assert.equal(kernelFaults.has('slot-a1'), true)
  wd.reset('slot-a1')
})

test('a dead remote kernel whose node link is down is not restarted', async () => {
  const ensured = []
  let now = 0
  const wd = createKernelWatchdog({
    listTargets: () => [{ id: 'slot-a2', node_id: 'node-a', status: 'running', runtime: { type: 'docker' } }],
    homeDirFor: (vm) => `/opt/vm2api/vms/${vm.id}/cli-home`,
    probeVm: (vm) => watchdogProbeVm(vm, { relayPaths: RELAY, exists: () => true }),
    health: async () => null,
    observeRuntime: async () => ({ state: 'unknown' }),
    ensure: async (exec) => {
      ensured.push(exec.vmId)
      return { ok: true }
    },
    now: () => now,
  })
  for (const at of [0, 60_000, 400_000, 1_400_000]) {
    now = at
    await wd.tick()
  }
  assert.deepEqual(ensured, [])
})

test('a node slot gets a relay-sized health timeout; a local slot keeps 800ms', async () => {
  const timeouts = {}
  const wd = createKernelWatchdog({
    listTargets: () => [
      { id: 'slot-a1', node_id: 'node-a', status: 'running', runtime: { type: 'docker' } },
      { id: 'slot-local', status: 'running', runtime: { type: 'docker', kernel_socket: '/k.sock' } },
    ],
    homeDirFor: (vm) => `/opt/vm2api/vms/${vm.id}/cli-home`,
    probeVm: (vm) => (vm.node_id ? watchdogProbeVm(vm, { relayPaths: RELAY, exists: () => true }) : vm),
    health: async (exec, opts) => {
      timeouts[exec.vmId] = opts.timeoutMs
      return { ok: true, healthy: true, ready_slots: 1, cli_pid: 7 }
    },
    observeRuntime: async () => ({ state: 'running' }),
    ensure: async () => ({ ok: true }),
    now: () => 0,
  })
  await wd.tick()
  assert.deepEqual(timeouts, { 'slot-a1': NODE_SLOT_HEALTH_TIMEOUT_MS, 'slot-local': 800 })
  assert.ok(NODE_SLOT_HEALTH_TIMEOUT_MS >= 3000)
})

test('intermittent node transport failures do not spend the kernel recovery budget', async () => {
  let now = 0
  let probes = 0
  const ensured = []
  const ensureHealthTimeouts = []
  const wd = createKernelWatchdog({
    config: { interval_sec: 5, restart_backoff_sec: [10] },
    listTargets: () => [{ id: 'slot-flaky', node_id: 'node-a', status: 'running' }],
    probeVm: (vm) => watchdogProbeVm(vm, { relayPaths: RELAY, exists: () => true }),
    health: async () => {
      probes += 1
      return { ok: false, status: 0, code: 'worker_timeout' }
    },
    observeRuntime: async () => ({ state: 'running' }),
    ensure: async (_exec, options) => {
      ensured.push(now)
      ensureHealthTimeouts.push(options.healthTimeoutMs)
      return { ok: true, reason: 'already_up' }
    },
    now: () => now,
  })
  try {
    for (const at of [0, 5_000, 10_000, 15_000, 20_000, 25_000]) {
      now = at
      await wd.tick()
    }
    assert.equal(NODE_SLOT_FAILURES_BEFORE_RESTART, 3)
    assert.deepEqual(ensured, [20_000], 'recovery preflight sees the kernel is already healthy')
    assert.deepEqual(ensureHealthTimeouts, [NODE_SLOT_HEALTH_TIMEOUT_MS])
    assert.equal(probes, 6)
    assert.equal(wd.restartsInWindow('slot-flaky'), 0)
    assert.equal(kernelFaults.has('slot-flaky'), false)
  } finally {
    kernelFaults.delete('slot-flaky')
  }
})

test('a rejected node recovery still spends the bounded recovery budget', async () => {
  kernelFaults.delete('slot-rejected')
  let now = 0
  const ensured = []
  const faults = []
  const wd = createKernelWatchdog({
    config: { interval_sec: 5, restart_backoff_sec: [10] },
    listTargets: () => [{ id: 'slot-rejected', node_id: 'node-a', status: 'running' }],
    probeVm: (vm) => watchdogProbeVm(vm, { relayPaths: RELAY, exists: () => true }),
    health: async () => ({
      ok: false,
      status: 0,
      code: 'worker_timeout',
      error: 'slot worker timeout after 3000ms',
    }),
    observeRuntime: async () => ({ state: 'running' }),
    ensure: async () => {
      ensured.push(now)
      throw new Error('recovery transport failed')
    },
    onFault: (vm, reason) => faults.push([vm.id, reason]),
    now: () => now,
  })
  try {
    for (const at of [0, 5_000, 10_000, 15_000, 20_000, 25_000]) {
      now = at
      await wd.tick()
    }
    assert.deepEqual(ensured, [20_000])
    assert.equal(wd.restartsInWindow('slot-rejected'), 1)
    assert.equal(faults.length, 1)
    assert.match(faults[0][1], /1 recovery attempts: slot worker timeout after 3000ms/)
    assert.equal(kernelFaults.has('slot-rejected'), true)
  } finally {
    kernelFaults.delete('slot-rejected')
  }
})
