import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { getDb } from '../../src/lib/db/database.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'

async function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-shared-vm-'))
  fs.mkdirSync(path.join(project, 'vms'))
  const bin = path.join(project, 'bin')
  fs.mkdirSync(bin)
  // Baseline lifecycle paths must never reach the real Docker daemon.
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\necho "Error: No such object: synthetic" >&2\nexit 1\n', {
    mode: 0o700,
  })
  const saved = { mode: process.env.VM2API_CONTROL_PLANE_MODE, path: process.env.PATH }
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  process.env.PATH = bin + path.delimiter + process.env.PATH
  t.after(() => {
    if (saved.mode == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = saved.mode
    process.env.PATH = saved.path
    fs.rmSync(project, { recursive: true, force: true })
  })
  const db = getDb()
  const peer = await createRepositoryTestDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => peer.close())
  const operations = new SharedVmOperations(db, { ownerId: 'pod-a' })
  const otherOperations = new SharedVmOperations(peer, { ownerId: 'pod-b' })
  function seed(id, extra = {}) {
    fs.writeFileSync(
      path.join(project, 'vms', id + '.json'),
      JSON.stringify({ id, name: id, status: 'running', schedulable: true, policy: { weight: 1 }, ...extra }),
    )
  }
  function read(id) {
    return JSON.parse(fs.readFileSync(path.join(project, 'vms', id + '.json'), 'utf8'))
  }
  function handler(body = {}, extra = {}) {
    const response = {}
    const handle = createPanelHandler({
      cfg: { paths: { project } },
      routingConfig: {},
      vmOperations: operations,
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
      readBody: async () => body,
      proxyPool: {
        unbindVm: async () => {},
        ensureBoundToVm: async () => null,
        allocateForVm: async () => null,
        getProxyForVm: () => null,
      },
      poolScheduler: { vmInflight: new Map() },
      accountQuota: { snapshot: () => ({ accounts: [] }) },
      vmTestSchedule: { remove: async () => {} },
      ...extra,
    })
    return { response, request: (method, route) => handle({ method }, {}, new URL('http://localhost' + route)) }
  }
  return { db, peer, project, seed, read, operations, otherOperations, handler }
}

for (const [method, suffix, body] of [
  ['PATCH', '', { weight: 8 }],
  ['POST', '/reload', {}],
  ['POST', '/start', {}],
  ['POST', '/recover', {}],
  ['POST', '/stop', {}],
  ['DELETE', '', {}],
  ['POST', '/schedulable', { schedulable: false }],
]) {
  test(`panel ${method} VM${suffix} rejects a global execution admission before any mutation`, async (t) => {
    const f = await fixture(t)
    f.seed('vm-synthetic')
    const before = f.read('vm-synthetic')
    await new ExecutionAdmissionsRepo(f.peer).tryReserve({
      vmId: 'vm-synthetic',
      accountId: 'synthetic',
      accountLimit: 2,
      vmLimit: 2,
      rpmLimit: 0,
      fableLimit: 0,
    })
    const h = f.handler(body)
    await h.request(method, '/api/panel/vms/vm-synthetic' + suffix)
    assert.equal(h.response.status, 409, JSON.stringify(h.response.body))
    assert.equal(h.response.body.error.code, 'vm_execution_active')
    assert.deepEqual(f.read('vm-synthetic'), before)
  })
}

test('create claims the new physical identity before writing a VM or fingerprint', async (t) => {
  const f = await fixture(t)
  await f.otherOperations.tryAcquire({ vmId: 'vm-synthetic' })
  const h = f.handler({ id: 'synthetic', start: false, auto_allocate_proxy: false })
  await h.request('POST', '/api/panel/vms/create')
  assert.equal(h.response.status, 409, JSON.stringify(h.response.body))
  assert.equal(fs.existsSync(path.join(f.project, 'vms', 'synthetic.json')), false)
  assert.equal(fs.existsSync(path.join(f.project, 'vms', 'synthetic')), false)
})

test('create rejects a committed PG identity even when this Pod has no corresponding file', async (t) => {
  const f = await fixture(t)
  await new VmsRepo(f.peer).upsertFromVmJson({ id: 'vm-synthetic', status: 'stopped' })
  const h = f.handler({ id: 'synthetic', start: false, auto_allocate_proxy: false })
  await h.request('POST', '/api/panel/vms/create')
  assert.equal(h.response.status, 409, JSON.stringify(h.response.body))
  assert.equal(fs.existsSync(path.join(f.project, 'vms', 'synthetic.json')), false)
})

test('hold cannot report global drain from an empty local inflight map', async (t) => {
  const f = await fixture(t)
  f.seed('vm-synthetic')
  await new ExecutionAdmissionsRepo(f.peer).tryReserve({
    vmId: 'vm-synthetic',
    accountId: 'synthetic',
    accountLimit: 2,
    vmLimit: 2,
    rpmLimit: 0,
    fableLimit: 0,
  })
  const h = f.handler({})
  await h.request('POST', '/api/panel/vms/schedule/hold')
  assert.equal(h.response.status, 409, JSON.stringify(h.response.body))
  assert.equal(f.read('vm-synthetic').schedulable, true)
})

test('batch policy acquires every claim before writing and releases earlier unstarted claims on busy', async (t) => {
  const f = await fixture(t)
  f.seed('vm-a')
  f.seed('vm-z')
  await f.otherOperations.tryAcquire({ vmId: 'vm-z' })
  const h = f.handler({ ids: ['vm-z', 'vm-a'], weight: 8 })
  await h.request('POST', '/api/panel/vms/pool-policy')
  assert.equal(h.response.status, 409, JSON.stringify(h.response.body))
  assert.equal(f.read('vm-a').policy.weight, 1)
  assert.equal(f.read('vm-z').policy.weight, 1)
  const first = await f.otherOperations.tryAcquire({ vmId: 'vm-a' })
  assert.equal(first.ok, true)
  await first.release()
})

test('a normal non-ok stop result preserves its durable claim', async (t) => {
  const f = await fixture(t)
  f.seed('vm-synthetic')
  const h = f.handler(
    {},
    { vmMutationOps: { stopSlot: async () => ({ ok: false, code: 'synthetic_unknown', vmOperationUncertain: true }) } },
  )
  await h.request('POST', '/api/panel/vms/vm-synthetic/stop')
  assert.equal(h.response.status, 500)
  assert.equal((await f.otherOperations.tryAcquire({ vmId: 'vm-synthetic' })).ok, false)
})
