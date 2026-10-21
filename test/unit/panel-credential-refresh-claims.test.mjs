import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { getDb } from '../../src/lib/db/database.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
import { withDatabaseActivities } from '../maintenance-fixture.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { writeCodexAccounts, readCodexAccounts, codexCredentialPath } from '../../src/lib/vm/codex-slot.mjs'

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
    return {
      response,
      request: (route) =>
        withDatabaseActivities([db], () => handle({ method: 'POST' }, {}, new URL('http://localhost' + route))),
    }
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

test('manual Codex refresh publishes the rotated credential before releasing its VM claim', async (t) => {
  const f = await fixture(t, { codex: true })
  let calls = 0
  const h = f.handler({
    vmMutationOps: {
      refreshCodexAccessToken: async ({ refreshToken }) => {
        calls++
        assert.equal(refreshToken, 'synthetic-old-refresh')
        const operation = await f.peer.prepare('SELECT account_id, released_at FROM vm_operations').get()
        assert.equal(operation.account_id, 'codex:synthetic-account')
        assert.equal(operation.released_at, null)
        return {
          ok: true,
          attemptFinished: true,
          access_token: 'synthetic-new-access',
          refresh_token: 'synthetic-new-refresh',
        }
      },
    },
  })
  await h.request('/api/panel/vms/vm-synthetic/oauth/refresh')
  assert.equal(h.response.status, 200, JSON.stringify(h.response.body))
  assert.equal(calls, 1)
  assert.equal(f.calls(), 0)
  assert.equal(readCodexAccounts(f.root, f.vm.id)[0].refresh_token, 'synthetic-new-refresh')
  assert.notEqual((await f.peer.prepare('SELECT released_at FROM vm_operations').get()).released_at, null)
  assert.notEqual((await f.peer.prepare('SELECT finished_at FROM background_task_runs').get()).finished_at, null)
  assert.equal(JSON.stringify(h.response.body).includes('synthetic-new-refresh'), false)
})

test('a complete Codex token rejection releases the manual operation without changing its credential', async (t) => {
  const f = await fixture(t, { codex: true })
  const h = f.handler({
    vmMutationOps: {
      refreshCodexAccessToken: async () => ({ ok: false, attemptFinished: true, error: 'refresh_rejected' }),
    },
  })
  await h.request('/api/panel/vms/vm-synthetic/oauth/refresh')
  assert.equal(h.response.status, 502)
  assert.equal(readCodexAccounts(f.root, f.vm.id)[0].refresh_token, 'synthetic-old-refresh')
  const next = await new SharedVmOperations(f.peer).tryAcquire({ vmId: f.vm.id })
  assert.equal(next.ok, true)
  await next.release()
})

test('publication failure after token rotation keeps the manual operation and forbids another refresh', async (t) => {
  const f = await fixture(t, { codex: true })
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === codexCredentialPath(f.root, f.vm.id))
      throw Object.assign(new Error('synthetic publication failure'), { code: 'EACCES' })
    return rename(from, to)
  })
  let calls = 0
  const h = f.handler({
    vmMutationOps: {
      refreshCodexAccessToken: async () => {
        calls++
        return { ok: true, attemptFinished: true, access_token: 'synthetic-new-access' }
      },
    },
  })
  await assert.rejects(h.request('/api/panel/vms/vm-synthetic/oauth/refresh'), { code: 'EACCES' })
  const next = f.handler()
  await next.request('/api/panel/vms/vm-synthetic/oauth/refresh')
  assert.equal(next.response.status, 409)
  assert.equal(calls, 1)
  assert.equal((await f.peer.prepare('SELECT released_at FROM vm_operations').get()).released_at, null)
})

for (const route of ['/api/panel/vms/vm-synthetic/oauth/refresh', '/admin/vm/oauth/refresh']) {
  test(`Claude manual refresh ${route} retains an explicit unknown response`, async (t) => {
    const f = await fixture(t)
    const h = f.handler({
      refreshWorkerCredentialForVm: async () => ({ ok: false, attemptFinished: false, credentialRefreshUnknown: true }),
    })
    await h.request(route)
    assert.equal(h.response.status, 502)
    const operation = await f.peer.prepare('SELECT uncertain_at, released_at FROM vm_operations').get()
    assert.notEqual(operation.uncertain_at, null)
    assert.equal(operation.released_at, null)
  })
}

test('Claude complete rejection can release its manual operation', async (t) => {
  const f = await fixture(t)
  const h = f.handler({ refreshWorkerCredentialForVm: async () => ({ ok: false, attemptFinished: true }) })
  await h.request('/api/panel/vms/vm-synthetic/oauth/refresh')
  assert.equal(h.response.status, 502)
  const next = await new SharedVmOperations(f.peer).tryAcquire({ vmId: f.vm.id })
  assert.equal(next.ok, true)
  await next.release()
})
