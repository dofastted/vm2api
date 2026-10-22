import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vmContext from 'node:vm'
import { spawnSync } from 'node:child_process'
import { getDb } from '../../src/lib/db/database.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { parseLaunchctlPrint } from '../../src/lib/cluster/native-slot.mjs'
import { ClusterError } from '../../src/lib/cluster/ssh-link.mjs'

function section(file, start, end) {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
  return source.slice(source.indexOf(start), source.indexOf(end)).replaceAll('export ', '')
}

function localRuntime({
  inspectError,
  running = true,
  restarting = false,
  noop = false,
  replace = false,
  nameAbsent = false,
} = {}) {
  const commands = []
  let present = true
  let replacement = false
  const sh = (argv) => {
    commands.push(argv)
    if (argv[1] === 'inspect') {
      if (inspectError) return { ok: false, stderr: inspectError }
      const target = argv.at(-1)
      if (nameAbsent && target === 'kin-synthetic') return { ok: false, stderr: `Error: No such object: ${target}` }
      if (!present && !(replacement && target === 'kin-synthetic')) {
        return { ok: false, stderr: `Error: No such object: ${target}` }
      }
      const id = replacement && target === 'kin-synthetic' ? 'replacement-id' : 'original-id'
      return {
        ok: true,
        stdout: `${running}|${running ? 123 : 0}|bridge|now|image|host|docker|claude|${restarting}${argv[3].includes('{{.Id}}') ? `|${id}` : ''}`,
      }
    }
    if (!noop) {
      running = false
      restarting = false
      if (argv[1] === 'rm') present = false
      if (replace) {
        present = false
        replacement = true
      }
    }
    return { ok: true, stdout: '' }
  }
  const source =
    section('../../src/lib/vm/vm-runtime.mjs', 'export function inspectContainer(', '/** Label on GPT') +
    section('../../src/lib/vm/vm-runtime.mjs', 'export function destroyVmRuntime(', 'export function listRuntimeVms(')
  const api = vmContext.runInNewContext(`${source}; ({inspectContainer, stopVmRuntime, destroyVmRuntime})`, {
    sh,
    PUBLIC_IP: null,
    containerName: () => 'kin-synthetic',
    isKvmRuntime: () => false,
    runtimePatch: (vm, info) => {
      vm.runtime = { ...vm.runtime, pid: info?.pid, stopped: !info?.running }
    },
  })
  return { ...api, commands, vm: { id: 'vm-synthetic', runtime: {} } }
}

test('Docker permission or daemon failure is not proof that a container is absent', () => {
  for (const inspectError of ['permission denied connecting to Docker', 'Cannot connect to the Docker daemon']) {
    const f = localRuntime({ inspectError })
    assert.throws(() => f.inspectContainer('kin-synthetic'), { code: 'container_inspect_failed' })
    const result = f.stopVmRuntime(f.vm)
    assert.equal(result.ok, false)
    assert.equal(result.vmOperationUncertain, true)
  }
})

test('successful stop command requires observed immutable container termination', () => {
  const f = localRuntime({ noop: true })
  const result = f.stopVmRuntime(f.vm)
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
})

test('successful remove command requires observed immutable container absence', () => {
  const f = localRuntime({ noop: true })
  const result = f.destroyVmRuntime(f.vm)
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
})

test('stop and remove use the inspected immutable ID rather than a replaceable name', () => {
  for (const action of ['stopVmRuntime', 'destroyVmRuntime']) {
    const f = localRuntime()
    assert.equal(f[action](f.vm).ok, true)
    assert.equal(f.commands.find((argv) => ['stop', 'rm'].includes(argv[1])).at(-1), 'original-id')
  }
})

test('Docker restart backoff is not treated as an already stopped container', () => {
  const f = localRuntime({ restarting: true })
  assert.equal(f.stopVmRuntime(f.vm).action, 'stopped')
  assert.equal(
    f.commands.some((argv) => argv[1] === 'stop'),
    true,
  )
})

test('name replacement during stop is unknown and does not mark the VM stopped', () => {
  const f = localRuntime({ replace: true })
  const result = f.stopVmRuntime(f.vm)
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
  assert.notEqual(f.vm.runtime.stopped, true)
})

test('known absent and already stopped containers remain successful', () => {
  assert.equal(
    localRuntime({ inspectError: 'Error: No such object: kin-synthetic' }).inspectContainer('kin-synthetic'),
    null,
  )
  const f = localRuntime({ running: false })
  assert.equal(f.stopVmRuntime(f.vm).action, 'already-stopped')
})

test('a missing name cannot hide a still present recorded immutable local container', () => {
  for (const action of ['stopVmRuntime', 'destroyVmRuntime']) {
    const f = localRuntime({ nameAbsent: true, noop: true })
    f.vm.runtime.container_id = 'original-id'
    const result = f[action](f.vm)
    assert.equal(result.ok, false)
    assert.equal(result.vmOperationUncertain, true)
  }
})

test('unconfirmed Docker termination retains the persistent VM operation', async () => {
  const operations = new SharedVmOperations(getDb())
  const f = localRuntime({ noop: true })
  const result = await operations.run(f.vm.id, () => f.stopVmRuntime(f.vm))
  assert.equal(result.ok, false)
  assert.equal((await operations.tryAcquire({ vmId: f.vm.id })).ok, false)
})

test('Codex stop awaits child exit before stopping its slot host', async () => {
  const events = []
  let finish
  const pending = new Promise((resolve) => {
    finish = resolve
  })
  const source = section('../../src/lib/vm/slot-runtime.mjs', 'export async function stopSlot(', '/** Destroy the slot')
  const stop = vmContext.runInNewContext(`${source}; stopSlot`, {
    isCodexVm: () => true,
    stopCodexKernel: () => ({ pid: 123 }),
    finishCodexRecycle: () => pending,
    slotHost: () => ({
      stop: () => {
        events.push('host-stop')
        return { ok: true }
      },
    }),
    process: { env: {} },
  })
  const task = stop({ id: 'vm-synthetic' })
  await Promise.resolve()
  assert.deepEqual(events, [])
  finish({ exited: true })
  assert.equal((await task).ok, true)
  assert.deepEqual(events, ['host-stop'])
})

test('Codex child exit failure and unknown Kubernetes owner keep the slot host running', async () => {
  const source = section('../../src/lib/vm/slot-runtime.mjs', 'export async function stopSlot(', '/** Destroy the slot')
  for (const child of [{ pid: 123 }, null]) {
    let hostStops = 0
    const stop = vmContext.runInNewContext(`${source}; stopSlot`, {
      isCodexVm: () => true,
      isKubernetesMode: () => true,
      stopCodexKernel: () => child,
      finishCodexRecycle: async () => ({ exited: false }),
      slotHost: () => ({
        stop: () => {
          hostStops++
          return { ok: true }
        },
      }),
    })
    const result = await stop({ id: 'vm-synthetic' })
    assert.equal(result.ok, false)
    assert.equal(result.vmOperationUncertain, true)
    assert.equal(hostStops, 0)
  }
})

function nativeApi(response) {
  const source = section(
    '../../src/lib/cluster/native-slot.mjs',
    'export async function nativeServiceStatus(',
    'async function bootstrap(',
  )
  return vmContext.runInNewContext(`${source}; ({nativeServiceStatus, bootout})`, {
    parseLaunchctlPrint,
    execCollect: async (_client, command) => (typeof response === 'function' ? response(command) : response),
    runRemote: async () => '',
    shellQuote: (s) => `'${s}'`,
    ClusterError,
    LAUNCHCTL_TIMEOUT_MS: 100,
    BOOTOUT_WAIT_TRIES: 1,
    setTimeout: (done) => done(),
  })
}

test('launchctl permission errors cannot prove native service termination', async () => {
  const api = nativeApi({ code: 1, stdout: '', stderr: 'Operation not permitted' })
  await assert.rejects(api.nativeServiceStatus({}, 'gui/501', 'label'))
  await assert.rejects(api.bootout({}, 'gui/501', 'label'))
})

test('native stop returns uncertainty and keeps its durable VM claim when launchd inspection fails', async () => {
  const api = nativeApi({ code: 1, stdout: '', stderr: 'Operation not permitted' })
  const source = section(
    '../../src/lib/cluster/native-slot.mjs',
    'export async function stopNativeSlot(',
    '/** Explicit delete / factory reset: both jobs',
  )
  const stop = vmContext.runInNewContext(`${source}; stopNativeSlot`, {
    ...api,
    nativeSession: async () => ({}),
    launchdDomain: async () => 'gui/501',
    nativeLabels: () => ({ kernel: 'kernel', telemetry: 'telemetry' }),
    failure: (error) => ({ ok: false, error: error.message }),
  })
  const operations = new SharedVmOperations(getDb())
  const result = await operations.run('vm-synthetic', () => stop({ id: 'vm-synthetic', runtime: {} }))
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
  assert.equal((await operations.tryAcquire({ vmId: 'vm-synthetic' })).ok, false)
})

test('launchd label disappearance alone does not prove the old PID exited', async () => {
  for (const process of [
    { code: 0, stdout: '123', stderr: '' },
    { code: 1, stdout: '', stderr: 'Operation not permitted' },
  ]) {
    let prints = 0
    const api = nativeApi((command) => {
      if (command.startsWith('ps ')) return process
      if (command.startsWith('launchctl bootout')) return { code: 0, stdout: '', stderr: '' }
      if (prints++ === 0) return { code: 0, stdout: '\tstate = running\n\tpid = 123', stderr: '' }
      return { code: 113, stdout: '', stderr: 'Could not find service' }
    })
    await assert.rejects(api.bootout({}, 'gui/501', 'label'))
  }
})

test('launchd confirms both missing label and old PID absence', async () => {
  let prints = 0
  const api = nativeApi((command) => {
    if (command.startsWith('ps ')) return { code: 1, stdout: '', stderr: '' }
    if (command.startsWith('launchctl bootout')) return { code: 0, stdout: '', stderr: '' }
    if (prints++ === 0) return { code: 0, stdout: '\tstate = running\n\tpid = 123', stderr: '' }
    return { code: 113, stdout: '', stderr: 'Could not find service' }
  })
  await api.bootout({}, 'gui/501', 'label')
})

test('launchctl explicit service-not-found remains a valid absence proof', async () => {
  const api = nativeApi({ code: 113, stdout: '', stderr: 'Could not find service' })
  assert.equal((await api.nativeServiceStatus({}, 'gui/501', 'label')).state, 'missing')
  await api.bootout({}, 'gui/501', 'label')
})

test('remote worker stop without a foreground exit acknowledgement stays unknown', async () => {
  const source = section(
    '../../src/lib/cluster/remote-slot.mjs',
    'export async function restartRemoteServices(',
    'export async function stopRemoteSlot(',
  )
  const restart = vmContext.runInNewContext(`${source}; restartRemoteServices`, {
    vmNodeId: () => 'node-synthetic',
    nodeSession: async () => ({ client: {}, host: {}, docker: {} }),
    remoteSlotDir: () => '/synthetic',
    path,
    containerName: () => 'kin-synthetic',
    migrateRemoteServiceContainers: async () => ({ ok: true, migrated: [] }),
    pushSlotFiles: async () => {},
    runtimeKind: () => 'docker',
    slotExecCmd: () => ({ Cmd: ['true'] }),
    slotExecArgv: () => ['docker', 'exec', 'original-id', 'true'],
    inspectContainerOrNull: async () => ({ Id: 'original-id', State: { Running: true } }),
    execDetached: async () => {},
    runRemote: async () => {
      throw new Error('SSH channel closed before exit')
    },
    shellQuote: (s) => `'${s}'`,
    setTimeout: (done) => done(),
    slotImageSpec: () => ({ ref: 'synthetic' }),
    ensureRemoteEgress: async () => ({ ok: true }),
    failure: (error) => ({ ok: false, error: error.message }),
  })
  const result = await restart({ id: 'vm-synthetic' }, '/synthetic', { telemetryEnabled: false })
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
})

test('remote worker termination script distinguishes live PIDs and inspection failures from exit', async () => {
  const source = section(
    '../../src/lib/cluster/remote-slot.mjs',
    'export async function restartRemoteServices(',
    'export async function stopRemoteSlot(',
  )
  let script
  const restart = vmContext.runInNewContext(`${source}; restartRemoteServices`, {
    vmNodeId: () => 'node-synthetic',
    nodeSession: async () => ({ client: {}, host: {}, docker: {} }),
    remoteSlotDir: () => '/synthetic',
    path,
    containerName: () => 'kin-synthetic',
    migrateRemoteServiceContainers: async () => ({ ok: true, migrated: [] }),
    pushSlotFiles: async () => {},
    runtimeKind: () => 'docker',
    slotExecCmd: () => ({}),
    slotExecArgv: (vm, argv) => {
      assert.equal(vm.runtime.container, 'immutable-id')
      script = argv[2]
      return ['exec', 'immutable-id', ...argv]
    },
    inspectContainerOrNull: async () => ({ Id: 'immutable-id', State: { Running: true } }),
    runRemote: async () => '',
    shellQuote: (s) => `'${s}'`,
    slotImageSpec: () => ({ ref: 'synthetic' }),
    ensureRemoteEgress: async () => ({ ok: true }),
    failure: (error) => ({ ok: false, error: error.message }),
  })
  assert.equal((await restart({ id: 'vm-synthetic' }, '/synthetic', {})).ok, true)
  for (const [ps, expected] of [
    ['printf "123\\n"; return 0', 3],
    ['printf "permission denied\\n" >&2; return 1', 2],
    ['return 1', 0],
  ]) {
    // Shell functions replace every process query/signal; no real process is inspected or killed.
    const synthetic = `pgrep() { printf '123\\n'; }; kill() { return 0; }; sleep() { :; }; ps() { ${ps}; };\n${script}`
    const result = spawnSync('/bin/sh', ['-c', synthetic], { encoding: 'utf8', timeout: 2000 })
    assert.equal(result.status, expected, result.stderr)
  }
})
