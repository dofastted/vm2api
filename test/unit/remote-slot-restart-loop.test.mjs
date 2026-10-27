import assert from 'node:assert/strict'
import fs from 'node:fs'
import vmContext from 'node:vm'
import test from 'node:test'
import { createKernelWatchdog } from '../../src/lib/transport/kernel-watchdog.mjs'
import { kernelFaults } from '../../src/lib/transport/rust-kernel-client.mjs'
import { dockerEnvMap, ensureKvmMachineRecord, kvmEnvMapIncomplete } from '../../src/lib/vm/kvm-machine.mjs'

// Execute the exact production lifecycle body with synthetic I/O boundaries.
// No SSH, Docker daemon, credentials or production filesystem is accessed.
const source = fs.readFileSync(new URL('../../src/lib/cluster/remote-slot.mjs', import.meta.url), 'utf8')
const start = source.slice(
  source.indexOf('export async function startRemoteSlot('),
  source.indexOf('/** Remote twin of reloadSlotWorker'),
)

function fixture({
  running = true,
  restarting = false,
  missing = false,
  mismatch = false,
  kind = 'docker',
  removeFails = false,
  publication = null,
} = {}) {
  const calls = []
  const target = {
    id: 'vm-restart-fixture',
    node_id: 'node-fixture',
    status: 'running',
    runtime: { type: kind, accel: 'kvm' },
  }
  const kvmEnv = kind === 'kvm' ? ['KIN_KVM_MAC=52:54:00:11:22:33', 'KIN_KVM_DISK_SERIAL=KINfixture01'] : undefined
  let info = missing
    ? null
    : {
        Config: {
          Image: mismatch ? 'old-image' : 'image',
          Labels: { 'kin.vm.layout': '2' },
          ...(kvmEnv ? { Env: kvmEnv } : {}),
        },
        HostConfig: { NetworkMode: 'network' },
        State: { Running: running, Restarting: restarting },
      }
  const io = {
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
    writeWorkerFiles: () => {
      calls.push('files')
      return { publication }
    },
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
  }
  const boot = vmContext.runInNewContext(`${start.replace('export ', '')}; startRemoteSlot`, io)
  return { calls, target, boot: () => boot(target, '/fixture'), state: () => info?.State }
}

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
  [{ running: false }, 'started', ['files', 'start', 'runtime']],
  [{ missing: true }, 'created', ['files', 'create', 'start', 'runtime']],
  [{ mismatch: true }, 'created', ['remove', 'files', 'create', 'start', 'runtime']],
]) {
  test(`remote lifecycle preserves ${action} behavior: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options)
    assert.equal((await f.boot()).action, action)
    assert.deepEqual(f.calls, calls)
  })
}

test('failed restart-loop removal does not create or claim successful recovery', async () => {
  const f = fixture({ restarting: true, removeFails: true })
  assert.equal((await f.boot()).ok, false)
  assert.deepEqual(f.calls, ['remove'])
})

test('remote start awaits its original worker publication before creating or starting a container', async () => {
  let finish
  const publication = new Promise((resolve) => {
    finish = resolve
  })
  const f = fixture({ missing: true, publication })
  const starting = f.boot()
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(f.calls, ['files'])
  } finally {
    finish()
    await starting
  }
  assert.equal(f.calls.includes('create'), true)
})

test('remote start cannot hide a failed queued publication behind its later direct push', async () => {
  const publication = Promise.reject(new Error('synthetic queued SFTP disconnect'))
  publication.catch(() => {})
  const f = fixture({ missing: true, publication })
  const result = await f.boot()
  assert.equal(result.ok, false)
  assert.equal(f.calls.includes('create'), false)
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
