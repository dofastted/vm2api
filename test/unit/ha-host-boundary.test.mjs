import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { slotHost } from '../../src/lib/vm/slot-host.mjs'
import { atomicWriteJson, writeJsonIfChanged, withVmLock } from '../../src/lib/vm/vm-file.mjs'

test('HA legacy slot hosts refuse every mutating operation without invoking Docker or SSH', async (t) => {
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes-ha'
  t.after(() => {
    if (previous === undefined) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
  })
  for (const vm of [
    { id: 'local-ha-vm' },
    { id: 'remote-ha-vm', node_id: 'ha-node' },
    { id: 'kvm-ha-vm', runtime_type: 'kvm' },
  ]) {
    const host = slotHost(vm)
    assert.equal(host.supports('codex'), false)
    for (const method of [
      'start',
      'reload',
      'stop',
      'destroy',
      'dockerApi',
      'dockerEnv',
      'syncRun',
      'queueSyncRun',
      'onImport',
      'afterRefresh',
      'touch',
      'setProxyEgressEnabled',
    ]) {
      await assert.rejects(async () => host[method](vm, '/unused'), { code: 'ha_operation_unsupported' }, method)
    }
  }
})

test('HA legacy VM writes and locks reject before filesystem or callback effects', async (t) => {
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes-ha'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ha-host-boundary-'))
  t.after(() => {
    if (previous === undefined) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
    fs.rmSync(root, { recursive: true, force: true })
  })
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir)
  const file = path.join(dir, 'ha-vm.json')
  fs.writeFileSync(file, '{"id":"ha-vm"}')
  assert.throws(() => atomicWriteJson(file, { id: 'changed' }), { code: 'ha_operation_unsupported' })
  assert.throws(() => writeJsonIfChanged(file, { id: 'changed' }), { code: 'ha_operation_unsupported' })
  let calls = 0
  await assert.rejects(
    async () =>
      withVmLock(file, () => {
        calls++
      }),
    { code: 'ha_operation_unsupported' },
  )
  assert.equal(calls, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"id":"ha-vm"}')
  assert.deepEqual(fs.readdirSync(dir), ['ha-vm.json'])
})
