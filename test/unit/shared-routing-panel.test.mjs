import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

function fixture(t, persist) {
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-routing-panel-'))
  t.after(() => {
    fs.rmSync(project, { recursive: true, force: true })
    if (previous === undefined) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
  })
  const response = {}
  let restored = 0
  const ctx = {
    cfg: { paths: { project }, limits: { max_body_bytes: 4096 } },
    routingConfig: { logging: {}, inference: { engine: 'rust' } },
    stickyRouter: { reloadConfig() {} },
    accountQuota: { reloadConfig() {} },
    poolSchedulerConfig: () => ({}),
    requestLog: {
      setConfig() {
        restored++
      },
    },
    persistRoutingPatch: persist,
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => ({ pool: { queue_max: 7 } }),
  }
  return {
    response,
    ctx,
    restored: () => restored,
    run: () => createPanelHandler(ctx)({ method: 'PUT' }, {}, new URL('http://localhost/api/panel/routing')),
  }
}

test('shared routing HTTP response reports committed revision and pending VM application', async (t) => {
  const application = { status: 'pending', pending: [{ component: 'vm_projection', vm_id: 'vm-test', revision: 9 }] }
  const fx = fixture(t, async () => ({ revision: 9, application }))
  await fx.run()
  assert.equal(fx.response.status, 200)
  assert.equal(fx.response.body.data.routing_revision, 9)
  assert.deepEqual(fx.response.body.data.application, application)
})

test('shared routing PG failure does not restore a potentially newer local committed snapshot', async (t) => {
  const fx = fixture(t, async () => {
    throw new Error('synthetic PG failure')
  })
  await fx.run()
  assert.equal(fx.response.status, 503)
  assert.equal(fx.restored(), 0)
})


test('shared routing engine changes are committed as pending application', async (t) => {
  const fx = fixture(t, async () => ({ revision: 10, application: { status: 'pending', pending: [] } }))
  fx.ctx.routingConfig.inference.engine = 'go'
  fx.ctx.readBody = async () => ({ inference: { engine: 'rust' } })
  await fx.run()
  assert.equal(fx.response.status, 200)
  assert.equal(fx.response.body.data.inference_runtime.status, 'pending')
})
