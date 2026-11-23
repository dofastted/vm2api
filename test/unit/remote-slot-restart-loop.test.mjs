import assert from 'node:assert/strict'
import fs from 'node:fs'
import vmContext from 'node:vm'
import test from 'node:test'
import {
  clusterCragContainerReady,
  clusterDockerCommandReady,
  slotContainerBody,
} from '../../src/lib/cluster/remote-slot.mjs'
import { hasClusterSubscriptionBinds } from '../../src/lib/cluster/crag-subscription-files.mjs'
import { createKernelWatchdog } from '../../src/lib/transport/kernel-watchdog.mjs'
import { kernelFaults } from '../../src/lib/transport/rust-kernel-client.mjs'
import { dockerEnvMap, ensureKvmMachineRecord, kvmEnvMapIncomplete } from '../../src/lib/vm/kvm-machine.mjs'
import { REMOTE_CRAG_ENTRY, REMOTE_KERNEL_ENTRY } from '../../src/lib/vm/slot-engine.mjs'
import { kernelCpuCommand } from '../../src/lib/vm/kernel-cpu.mjs'

// Execute the exact production lifecycle body with synthetic I/O boundaries.
// No SSH, Docker daemon, credentials or production filesystem is accessed.
const source = fs.readFileSync(new URL('../../src/lib/cluster/remote-slot.mjs', import.meta.url), 'utf8')
const start = source.slice(
  source.indexOf('export async function startRemoteSlot('),
  source.indexOf('/** Remote twin of reloadSlotWorker'),
)
const restartPolicy = source.slice(
  source.indexOf('function remoteSlotRestartPolicy('),
  source.indexOf('/** Reconcile an existing node slot'),
)

test('remote CRAG KVM preparation resolves guest and egress images instead of rejecting placement', async () => {
  const prepare = source.slice(source.indexOf('async function prepare('), source.indexOf('function runtimeLabelOf('))
  const images = []
  const session = { host: {}, docker: {} }
  const target = { id: 'vm-kvm', node_id: 'node-a', dataplane: 'crag', runtime: { type: 'kvm' } }
  const run = vmContext.runInNewContext(`${prepare}; prepare`, {
    isKvmRuntime: () => true,
    resolveKernelDataplane: () => 'crag',
    OS_CATALOG: { 'ubuntu-24.04': {} },
    normalizeTimezone: (value) => value || 'UTC',
    STANDARD_LOCALE: 'en_US.UTF-8',
    vmNodeId: (vm) => vm.node_id,
    nodeSession: async () => session,
    runtimeKind: () => 'kvm',
    ensureNodeSlotImage: async (_session, _node, _root, kernel, kind) => {
      images.push([kernel, kind])
      return { ref: `image-${kind}` }
    },
    remoteSlotOwner: () => ({ uid: 1000, gid: 1000 }),
    remoteSlotDir: () => '/remote/vms/vm-kvm',
    path: { join: (...parts) => parts.join('/') },
  })
  const result = await run(target, '/fixture', {})
  assert.equal(result.fail, undefined)
  assert.equal(result.image, 'image-kvm')
  assert.equal(result.egressImage, 'image-docker')
  assert.deepEqual(images, [
    ['ubuntu-24.04', 'kvm'],
    ['ubuntu-24.04', 'docker'],
  ])
})

function cragReadyContainer(base) {
  return {
    ...base,
    Config: {
      ...base.Config,
      Cmd: [REMOTE_CRAG_ENTRY, '--gateway-worker', '--config', '/run/kin/kernel.json'],
    },
    HostConfig: {
      ...base.HostConfig,
      Init: true,
      SecurityOpt: ['seccomp=/fixture/crag-v2-seccomp.json', 'apparmor=unconfined'],
    },
  }
}
function kernelContainer(base, cpuWrapped = false) {
  const argv = [REMOTE_KERNEL_ENTRY, '--gateway-worker', '--config', '/run/kin/kernel.json']
  return {
    ...base,
    Config: {
      ...base.Config,
      Cmd: cpuWrapped ? kernelCpuCommand(argv) : argv,
    },
  }
}

function fixture({
  running = true,
  restarting = false,
  missing = false,
  mismatch = false,
  kind = 'docker',
  removeFails = false,
  cragReady = false,
  subscription = false,
  cpuWrapped = false,
} = {}) {
  const calls = []
  const target = {
    id: 'vm-restart-fixture',
    node_id: 'node-fixture',
    status: 'running',
    runtime: { type: kind, accel: 'kvm' },
  }
  const kvmEnv = kind === 'kvm' ? ['KIN_KVM_MAC=52:54:00:11:22:33', 'KIN_KVM_DISK_SERIAL=KINfixture01'] : undefined
  const base = {
    Id: 'fixture-cid',
    Config: {
      Image: mismatch ? 'old-image' : 'image',
      Labels: { 'kin.vm.layout': '2' },
      ...(kvmEnv ? { Env: kvmEnv } : {}),
    },
    HostConfig: { NetworkMode: 'network', RestartPolicy: { Name: 'unless-stopped' } },
    State: { Running: running, Restarting: restarting },
  }
  let info = missing
    ? null
    : kind !== 'docker'
      ? base
      : cragReady
        ? cragReadyContainer(base)
        : kernelContainer(base, cpuWrapped)
  const io = {
    resolveSlotRouting: (_root, routing) => routing || {},
    withCragRuntimeAdmission: (_vm, _root, _options, run) => run(),
    dockerJson: async (_docker, request) => {
      assert.equal(request.method, 'POST')
      assert.equal(request.path, '/containers/fixture-cid/update')
      assert.equal(request.body.RestartPolicy.Name, 'no')
      calls.push('disable-autorestart')
    },
    prepare: async () => ({
      nodeId: target.node_id,
      session: { docker: {}, client: {} },
      image: 'image',
      user: 'fixture',
      remoteDir: '/fixture',
      slotDir: '/fixture',
    }),
    isKvmRuntime: () => kind === 'kvm',
    ensureRemoteEgress: async () => ({ ok: true, network: 'network' }),
    containerName: () => 'kin-fixture',
    clusterManager: () => ({ ensureSlotRelays: async () => ({}) }),
    inspectContainerOrNull: async () => info,
    slotDockerCpus: () => 0,
    runtimeLabelOf: () => kind,
    runtimeKind: () => kind,
    codexRoleMatches: () => true,
    SLOT_LAYOUT: '2',
    applyRuntime: () => calls.push('runtime'),
    removeContainer: async () => {
      calls.push('remove')
      if (removeFails) throw new Error('remove denied')
      info = null
    },
    writeWorkerFiles: () => calls.push('files'),
    ensureGuestMachineIdFile: () => {},
    pushSlotFiles: async () => {},
    migrateClaudeDir: async () => {},
    runRemote: async () => {},
    shellQuote: (s) => s,
    reconcileSlotCredentials: async () => {},
    releaseRemoteEgress: async () => {},
    createContainerRaw: async () => {
      calls.push('create')
      info = { State: { Running: false, Restarting: false } }
    },
    slotContainerBody: () => ({}),
    containerAction: async (_docker, _name, action) => {
      calls.push(action)
      if (info.State.Restarting) throw new Error('restart loop was not replaced')
      info.State.Running = true
    },
    chownRemoteKvmBinds: async () => {},
    startRemoteTelemetry: async () => {},
    failure: (err) => ({ ok: false, error: err.message }),
    dockerEnvMap,
    ensureKvmMachineRecord,
    kvmEnvMapIncomplete,
    patchVmRecord: () => null,
    clusterDockerCommandReady,
    clusterCragContainerReady,
    clusterDockerClaude: (vm) => kind === 'docker' && Boolean(vm?.node_id),
    resolveKernelDataplane: (vm) => vm?.dataplane || 'kernel',
    projectCragUniversalVm: async () => {},
    readCragClusterSubscription: () => subscription,
    hasClusterSubscriptionBinds,
    publishClusterSubscription: async () => calls.push('publish-subscription'),
    clusterComputerPolicy: () => ({ computer: false, required: false }),
    hasClusterComputerBinds: () => true,
    pushClusterComputer: async () => false,
  }
  const boot = vmContext.runInNewContext(`${restartPolicy}; ${start.replace('export ', '')}; startRemoteSlot`, io)
  return { calls, target, boot: () => boot(target, '/fixture'), state: () => info?.State }
}

test('a subscribed cluster Docker slot replaces the old container before starting with read-only license mounts', async () => {
  const f = fixture({ cragReady: true, subscription: true })
  f.target.dataplane = 'crag'
  f.target.crag_kernel_version = 'v2'
  assert.equal((await f.boot()).action, 'created')
  assert.deepEqual(f.calls, ['remove', 'files', 'publish-subscription', 'create', 'start', 'runtime'])
  const body = slotContainerBody(f.target, {
    image: 'fixture',
    network: 'fixture',
    remoteDir: '/fixture',
    user: '1000:1000',
    routing: {},
    subscription: true,
  })
  assert.equal(hasClusterSubscriptionBinds(body, '/fixture'), true)
  assert.ok(body.HostConfig.Binds.includes('/fixture/subscription-host:/run/kin/crag-host:ro'))
  assert.ok(body.HostConfig.Binds.includes('/fixture/subscription-license:/run/kin/crag-license:ro'))
})

test('an already running CRAG slot is not bounced to disable legacy Docker autorestart', async () => {
  const f = fixture({ cragReady: true })
  f.target.dataplane = 'crag'
  assert.equal((await f.boot()).action, 'already-running')
  assert.deepEqual(f.calls, ['disable-autorestart', 'runtime'])
})

for (const kind of ['docker', 'kvm']) {
  for (const running of [true, false]) {
    test(`${kind} restart-loop Running=${running} is removed, recreated and started`, async () => {
      const f = fixture({ kind, running, restarting: true })
      assert.equal((await f.boot()).action, 'created')
      assert.deepEqual(f.calls, ['remove', 'files', 'create', 'start', 'runtime'])
      assert.equal(f.state().Restarting, false)
      assert.equal(f.state().Running, true)
    })
  }
}

for (const [options, action, calls] of [
  [{}, 'already-running', ['runtime']],
  [{ cpuWrapped: true }, 'already-running', ['runtime']],
  [{ running: false }, 'started', ['files', 'start', 'runtime']],
  [{ missing: true }, 'created', ['files', 'create', 'start', 'runtime']],
  [{ mismatch: true }, 'created', ['remove', 'files', 'create', 'start', 'runtime']],
  [{ cragReady: true }, 'created', ['remove', 'files', 'create', 'start', 'runtime']],
]) {
  test(`remote lifecycle preserves ${action} behavior: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options)
    assert.equal((await f.boot()).action, action)
    assert.deepEqual(f.calls, calls)
  })
}

test('remote readiness accepts direct and CPU-wrapped entries but not another executable', () => {
  const vm = { node_id: 'node-fixture' }
  for (const cpuWrapped of [false, true]) {
    assert.equal(clusterDockerCommandReady(vm, kernelContainer({}, cpuWrapped), {}), true)
  }
  const wrong = kernelCpuCommand(['/bin/sleep', 'infinity'])
  assert.equal(clusterDockerCommandReady(vm, { Config: { Cmd: wrong } }, {}), false)
})

test('failed restart-loop removal does not create or claim successful recovery', async () => {
  const f = fixture({ restarting: true, removeFails: true })
  assert.equal((await f.boot()).ok, false)
  assert.deepEqual(f.calls, ['remove'])
})

test('watchdog revival reaches the remote lifecycle and clears a restart loop without spending another attempt', async () => {
  const f = fixture({ restarting: true })
  let now = 0
  const wd = createKernelWatchdog({
    listTargets: () => [f.target],
    now: () => now,
    config: { restart_backoff_sec: [10] },
    health: async () => (f.state()?.Restarting ? null : { ok: true, healthy: true }),
    observeRuntime: async () => ({ state: f.state()?.Restarting ? 'restarting' : 'running' }),
    revive: f.boot,
    ensure: async () => {
      throw new Error('must revive the remote container, not blindly restart the kernel')
    },
  })
  try {
    await wd.tick()
    assert.deepEqual(f.calls, [])
    now = 10_000
    await wd.tick()
    assert.equal(f.state().Restarting, false)
    assert.equal(wd.restartsInWindow(f.target.id), 1)
    now = 30_000
    await wd.tick()
    assert.equal(kernelFaults.has(f.target.id), false)
    assert.equal(f.calls.filter((x) => x === 'create').length, 1)
  } finally {
    kernelFaults.delete(f.target.id)
  }
})
