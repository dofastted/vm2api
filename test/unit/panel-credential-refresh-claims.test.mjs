import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { getDb } from '../../src/lib/db/database.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'

async function fixture(t, { codex = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-refresh-claims-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  const vm = {
    id: 'vm-synthetic',
    status: 'running',
    ...(codex
      ? { platform: 'openai', family: 'codex', codex: { has_refresh: true } }
      : { claude: { mode: 'oauth', has_refresh: true } }),
  }
  fs.writeFileSync(path.join(root, 'vms', vm.id + '.json'), JSON.stringify(vm))
  if (codex) {
    fs.mkdirSync(path.join(root, 'vms', vm.id))
    writeCodexAccounts(root, vm.id, [
      {
        id: 'synthetic-account',
        chatgpt_account_id: 'synthetic-account',
        access_token: 'synthetic-old-access',
        refresh_token: 'synthetic-old-refresh',
      },
    ])
  }
  const db = getDb()
  const peer = await createRepositoryTestDatabase({ connectionString: db.connectionString, schema: db.schema })
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  let calls = 0
  // Baseline Codex refresh must not send a real provider request, even before the guard exists.
  t.mock.method(https, 'request', () => {
    calls++
    throw new Error('synthetic network disconnect')
  })
  t.after(async () => {
    await peer.close()
    if (previous == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
  })
  function handler(extra = {}) {
    const response = {}
    const handle = createPanelHandler({
      cfg: { paths: { project: root } },
      routingConfig: {},
      vmOperations: new SharedVmOperations(db),
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      readBody: async () => ({ vm_id: vm.id }),
      json(_res, status, body) {
        response.status = status
        response.body = body
        return true
      },
      refreshWorkerCredentialForVm: async () => {
        calls++
        return { ok: true }
      },
      ...extra,
    })
    return { response, request: (route) => handle({ method: 'POST' }, {}, new URL('http://localhost' + route)) }
  }
  return { db, peer, root, vm, handler, calls: () => calls }
}

for (const [codex, route] of [
  [true, '/api/panel/vms/vm-synthetic/oauth/refresh'],
  [false, '/api/panel/vms/vm-synthetic/oauth/refresh'],
  [false, '/admin/vm/oauth/refresh'],
]) {
  test(`manual ${codex ? 'Codex' : 'Claude'} refresh ${route} rejects a global execution before sending`, async (t) => {
    const f = await fixture(t, { codex })
    await new ExecutionAdmissionsRepo(f.peer).tryReserve({
      vmId: f.vm.id,
      accountId: 'synthetic-account',
      vmLimit: 1,
      accountLimit: 1,
      rpmLimit: 0,
      fableLimit: 0,
    })
    const h = f.handler()
    await h.request(route)
    assert.equal(h.response.status, 409, JSON.stringify(h.response.body))
    assert.equal(f.calls(), 0)
  })
}

test('an unknown manual Codex refresh is not resubmitted by the next HTTP request', async (t) => {
  const f = await fixture(t, { codex: true })
  const first = f.handler()
  await first.request('/api/panel/vms/vm-synthetic/oauth/refresh')
  assert.equal(first.response.status, 502)
  const second = f.handler()
  await second.request('/api/panel/vms/vm-synthetic/oauth/refresh')
  assert.equal(second.response.status, 409)
  assert.equal(f.calls(), 1)
  const operation = await f.peer.prepare('SELECT uncertain_at, released_at FROM vm_operations').get()
  assert.notEqual(operation.uncertain_at, null)
  assert.equal(operation.released_at, null)
})
