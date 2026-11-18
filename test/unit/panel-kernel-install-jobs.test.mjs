import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-kernel-install-jobs-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = { id: 'vm-13', status: 'running', dataplane: 'wrap', owner_user_id: 'owner-a' }
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const stop = Promise.withResolvers()
  const stopCalls = []
  const handle = createPanelHandler({
    cfg: { paths: { project: root } },
    routingConfig: {},
    requireAuth(req) {
      req.panelUser = 'fixture'
      req.panelRole = req.role
      req.panelUserId = vm.owner_user_id
      return true
    },
    json(res, status, payload) {
      res.status = status
      res.body = payload
      return true
    },
    readBody: async (req) => req.body,
    kernelInstallOps: {
      describeKernelCatalog: () => [{ id: 'cli-node', ready: true }],
      stopSlot(current) {
        stopCalls.push(current.id)
        return stop.promise
      },
    },
  })
  return {
    root,
    vm,
    stop,
    stopCalls,
    async request(method, query = '', { body, role = 'admin' } = {}) {
      const response = {}
      await handle({ method, body, role }, response, new URL(`http://localhost/api/panel/kernels/install${query}`))
      return response
    },
  }
}

test('background install retains the final per-slot result after the POST returns', async (t) => {
  const { root, vm, stop, stopCalls, request } = fixture(t)
  const target = { id: vm.id, kernel: 'cli-node' }
  const receipt = await request('POST', '', { body: { background: true, targets: [target] } })
  assert.equal(receipt.status, 202)
  const query = `?job_id=${receipt.body.data.job_id}`
  assert.deepEqual((await request('GET', query)).body.data, { state: 'running' })
  assert.equal((await request('GET', '?job_id=missing')).status, 404)
  for (const role of ['user', 'super']) {
    assert.equal((await request('GET', query, { role })).status, 403)
  }
  stop.resolve({ ok: false, code: 'fixture_stop_failed', error: 'fixture refused to stop' })
  await new Promise((resolve) => setImmediate(resolve))
  const result = (await request('GET', query)).body.data
  assert.equal(result.state, 'completed')
  assert.deepEqual(result.report.items, [
    { ...target, ok: false, code: 'fixture_stop_failed', error: 'fixture refused to stop', stopped: false },
  ])
  assert.deepEqual(stopCalls, [vm.id])
  assert.equal(getVm(root, vm.id).status, 'running')
  assert.deepEqual((await request('GET', query)).body.data, result)
})
