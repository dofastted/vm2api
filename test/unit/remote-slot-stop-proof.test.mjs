import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vmContext from 'node:vm'
import { getDb } from '../../src/lib/db/database.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'

function fixture({
  noop = false,
  replace = false,
  inspectError = false,
  actionError = false,
  running = true,
  nameAbsent = false,
} = {}) {
  const source = fs.readFileSync(new URL('../../src/lib/cluster/remote-slot.mjs', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('export async function stopRemoteSlot(')).replaceAll('export ', '')
  let present = true
  let replacement = false
  const events = []
  const inspect = async (_docker, target) => {
    if (inspectError) throw new Error('Docker daemon unavailable')
    if (target === 'kin-synthetic' && nameAbsent) return null
    if (target === 'kin-synthetic' && replacement) return { Id: 'replacement-id', State: { Running: true, Pid: 456 } }
    if (!present) return null
    return { Id: 'original-id', State: { Running: running, Restarting: false, Pid: running ? 123 : 0 }, HostConfig: {} }
  }
  const mutate = (id, operation) => {
    events.push([operation, id])
    if (!noop) {
      running = false
      if (operation === 'remove' || replace) present = false
      if (replace) replacement = true
    }
    if (actionError) throw new Error('Docker connection dropped after sending command')
  }
  const api = vmContext.runInNewContext(`${body}; ({stopRemoteSlot, destroyRemoteSlot})`, {
    nodeSession: async () => ({ docker: {} }),
    vmNodeId: () => 'node-synthetic',
    containerName: () => 'kin-synthetic',
    inspectContainerOrNull: inspect,
    containerAction: async (_docker, id) => mutate(id, 'stop'),
    removeContainer: async (_docker, id) => mutate(id, 'remove'),
    isKvmRuntime: () => false,
    runtimeLabelOf: () => 'docker',
    releaseRemoteEgress: async () => events.push(['egress-release']),
    removeRemoteSlotDir: async () => events.push(['files-remove']),
    clusterManager: () => ({ dropSlotRelays: async () => events.push(['relays-remove']) }),
    failure: (error) => ({ ok: false, error: error.message }),
  })
  return { ...api, events, vm: { id: 'vm-synthetic', runtime: {} } }
}

test('remote stop acknowledgement does not prove a still running container ended', async () => {
  const f = fixture({ noop: true })
  const result = await f.stopRemoteSlot(f.vm)
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
  assert.notEqual(f.vm.runtime.stopped, true)
})

test('remote removal acknowledgement cannot delete slot files while the container remains', async () => {
  const f = fixture({ noop: true })
  const result = await f.destroyRemoteSlot(f.vm)
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
  assert.equal(
    f.events.some(([name]) => name === 'files-remove'),
    false,
  )
})

test('remote stop and removal address the immutable inspected container ID', async () => {
  for (const action of ['stopRemoteSlot', 'destroyRemoteSlot']) {
    const f = fixture()
    assert.equal((await f[action](f.vm)).ok, true)
    assert.equal(f.events[0][1], 'original-id')
  }
})

test('remote container replacement leaves the mutation unknown and slot files intact', async () => {
  for (const action of ['stopRemoteSlot', 'destroyRemoteSlot']) {
    const f = fixture({ replace: true })
    const result = await f[action](f.vm)
    assert.equal(result.ok, false)
    assert.equal(result.vmOperationUncertain, true)
    assert.equal(
      f.events.some(([name]) => name === 'files-remove'),
      false,
    )
  }
})

test('remote Docker inspect failure retains uncertainty', async () => {
  const f = fixture({ inspectError: true })
  const result = await f.destroyRemoteSlot(f.vm)
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
  assert.deepEqual(f.events, [])
})

test('remote command error can complete only after an independent terminal observation', async () => {
  for (const action of ['stopRemoteSlot', 'destroyRemoteSlot']) {
    const f = fixture({ actionError: true })
    assert.equal((await f[action](f.vm)).ok, true)
  }
})

test('remote already stopped container remains successful', async () => {
  const f = fixture({ running: false })
  assert.equal((await f.stopRemoteSlot(f.vm)).ok, true)
})

test('a missing name cannot hide a still present recorded immutable remote container', async () => {
  for (const action of ['stopRemoteSlot', 'destroyRemoteSlot']) {
    const f = fixture({ nameAbsent: true, noop: true })
    f.vm.runtime.container_id = 'original-id'
    const result = await f[action](f.vm)
    assert.equal(result.ok, false)
    assert.equal(result.vmOperationUncertain, true)
    assert.equal(
      f.events.some(([name]) => name === 'files-remove'),
      false,
    )
  }
})

test('unconfirmed remote stop keeps its persistent VM operation active', async () => {
  const f = fixture({ noop: true })
  const operations = new SharedVmOperations(getDb())
  const result = await operations.run(f.vm.id, () => f.stopRemoteSlot(f.vm))
  assert.equal(result.ok, false)
  assert.equal((await operations.tryAcquire({ vmId: f.vm.id })).ok, false)
})
