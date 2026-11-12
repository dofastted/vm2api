import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { reloadSlotWorker } from '../../src/lib/vm/vm-runtime.mjs'
import { reloadRemoteSlot } from '../../src/lib/cluster/remote-slot.mjs'
import { bindPlacement, unbindPlacement } from '../../src/lib/cluster/placement.mjs'
import { powerOnSlot, recoverSlot } from '../../src/lib/vm/slot-recovery.mjs'

function fixture(t, { quota = 'bad', kind = 'docker', remote = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-lifecycle-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = {
    id: 'vm-01',
    status: 'running',
    runtime: { type: kind },
    machine: { docker_cpus: quota },
    proxy_required: false,
    ...(remote ? { node_id: 'node-fixture' } : {}),
  }
  fs.mkdirSync(path.join(root, 'vms'))
  const file = path.join(root, 'vms', `${vm.id}.json`)
  fs.writeFileSync(file, JSON.stringify(vm))
  return { root, vm, file }
}

for (const cached of [false, true]) {
  test(`local reload validates before config write or cached-file fallback (cached=${cached})`, async (t) => {
    const { root, vm } = fixture(t)
    const run = path.join(root, 'vms', vm.id, 'run')
    if (cached) {
      fs.mkdirSync(run, { recursive: true })
      fs.writeFileSync(path.join(run, 'worker.json'), 'sentinel-config')
      fs.writeFileSync(path.join(run, 'internal.token'), 'synthetic-token')
    }
    await assert.rejects(() => reloadSlotWorker(vm, root), /docker_cpus/)
    if (cached) assert.equal(fs.readFileSync(path.join(run, 'worker.json'), 'utf8'), 'sentinel-config')
    else assert.equal(fs.existsSync(run), false)
  })
}

test('remote reload rejects malformed quotas before asking the cluster for a client', async (t) => {
  const { root, vm } = fixture(t, { remote: true })
  let calls = 0
  bindPlacement({
    projectRoot: root,
    manager: {
      client: () => {
        calls++
        throw new Error('unexpected node access')
      },
    },
  })
  t.after(unbindPlacement)
  const result = await reloadRemoteSlot(vm, root)
  assert.equal(result.ok, false)
  assert.match(result.error, /docker_cpus/)
  assert.equal(calls, 0)
  assert.equal(fs.existsSync(path.join(root, 'vms', vm.id)), false)
})

for (const remote of [false, true]) {
  test(`recovery rejects corrupt quota before hold/relay/stop/start (remote=${remote})`, async (t) => {
    const { root, vm, file } = fixture(t, { remote })
    const before = fs.readFileSync(file, 'utf8')
    const calls = []
    const result = await recoverSlot({
      projectRoot: root,
      id: vm.id,
      proxyPool: {},
      watchdog: {
        hold: () => calls.push('hold'),
        reset: () => {
          calls.push('reset')
          return {}
        },
        release: () => calls.push('release'),
      },
      ops: {
        cluster: () => ({
          ensureLinkReady: async () => calls.push('link'),
          healSlotBridges: async () => {
            calls.push('relay')
            return []
          },
        }),
        stopSlot: async () => {
          calls.push('stop')
          return { ok: true }
        },
        powerOn: async () => {
          calls.push('start')
          return { ok: true }
        },
        diagnose: async () => ({ ok: true }),
        settleMs: 0,
      },
    })
    assert.deepEqual(calls, [])
    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
    assert.equal(result.code, 'invalid_machine')
    assert.match(result.error, /docker_cpus/)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  })
}

test('power-on rejects corrupt quota before proxy allocation, timezone or runtime changes', async (t) => {
  const { root, vm, file } = fixture(t)
  const before = fs.readFileSync(file, 'utf8')
  let allocations = 0
  const result = await powerOnSlot({
    projectRoot: root,
    id: vm.id,
    proxyPool: {
      ensureBoundToVm: () => {
        allocations++
        return null
      },
    },
  })
  assert.equal(allocations, 0)
  assert.equal(result.status, 400)
  assert.equal(result.code, 'invalid_machine')
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

for (const options of [{ quota: 0 }, { quota: 0.25 }, { quota: 'bad', kind: 'kvm' }]) {
  test(`recovery preserves accepted settings ${JSON.stringify(options)}`, async (t) => {
    const { root, vm } = fixture(t, options)
    const calls = []
    const result = await recoverSlot({
      projectRoot: root,
      id: vm.id,
      proxyPool: {},
      ops: {
        cluster: () => null,
        stopSlot: async () => {
          calls.push('stop')
          return { ok: true }
        },
        powerOn: async () => {
          calls.push('start')
          return { ok: true }
        },
        diagnose: async () => ({ ok: true, checks: [] }),
        settleMs: 0,
      },
    })
    assert.equal(result.report.ok, true)
    assert.deepEqual(calls, ['stop', 'start'])
  })
}
