import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../../src/lib/db/database.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { SharedProxyOperations } from '../../src/lib/vm/shared-proxy-operations.mjs'
import { buildVmPackage } from '../../src/lib/vm/vm-package.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'

async function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-proxy-claims-'))
  fs.mkdirSync(path.join(project, 'vms'))
  const bin = path.join(project, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\necho "Error: No such network: synthetic" >&2\nexit 1\n', {
    mode: 0o700,
  })
  fs.writeFileSync(path.join(bin, 'iptables'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const saved = { mode: process.env.VM2API_CONTROL_PLANE_MODE, mock: process.env.KIN_CRS_MOCK, path: process.env.PATH }
  process.env.VM2API_CONTROL_PLANE_MODE = 'standalone'
  const db = getDb()
  const peer = await createRepositoryTestDatabase({ connectionString: db.connectionString, schema: db.schema })
  const pool = await new ProxyPool({ db, geoLookup: async () => ({ ok: true, geo: { timezone: 'UTC' } }) }).init()
  const imported = await pool.importLines('192.0.2.1:1080')
  const proxyId = imported.items[0].id
  await pool.bind(proxyId, 'vm-a')
  pool.stopScheduler()
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  process.env.KIN_CRS_MOCK = '1'
  process.env.PATH = bin + path.delimiter + process.env.PATH
  t.after(async () => {
    pool.stopScheduler()
    await peer.close()
    for (const [key, value] of [
      ['VM2API_CONTROL_PLANE_MODE', saved.mode],
      ['KIN_CRS_MOCK', saved.mock],
      ['PATH', saved.path],
    ]) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(project, { recursive: true, force: true })
  })
  const operations = new SharedVmOperations(db)
  const otherOperations = new SharedVmOperations(peer)
  function seed(id, extra = {}) {
    fs.writeFileSync(
      path.join(project, 'vms', id + '.json'),
      JSON.stringify({
        id,
        name: id,
        status: 'stopped',
        schedulable: false,
        timezone: 'UTC',
        timezone_source: 'manual',
        proxy: pool.getProxyByIdWithAuth(proxyId),
        ...extra,
      }),
    )
  }
  seed('vm-a')
  function handler(body, extra = {}) {
    const response = {}
    const handle = createPanelHandler({
      cfg: { paths: { project } },
      routingConfig: {},
      proxyPool: pool,
      vmOperations: operations,
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      readBody: async () => body,
      json(_res, status, payload) {
        response.status = status
        response.body = payload
        return true
      },
      ...extra,
    })
    return { response, request: (method, route) => handle({ method }, {}, new URL('http://localhost' + route)) }
  }
  return { db, peer, pool, project, proxyId, operations, otherOperations, handler, seed }
}

for (const [method, route, body] of [
  ['PUT', '', { label: 'changed' }],
  ['POST', '/bind', { vm_id: 'vm-a' }],
  ['POST', '/unbind', {}],
  ['DELETE', '', {}],
  ['POST', '/enable', {}],
  ['POST', '/disable', {}],
  ['POST', '/geo', {}],
]) {
  test(`panel proxy ${method} ${route || '/'} locks its bound VMs before mutation`, async (t) => {
    const f = await fixture(t)
    await new ExecutionAdmissionsRepo(f.peer).tryReserve({
      vmId: 'vm-a',
      accountId: 'synthetic',
      accountLimit: 2,
      vmLimit: 2,
      rpmLimit: 0,
      fableLimit: 0,
    })
    const before = fs.readFileSync(path.join(f.project, 'vms', 'vm-a.json'), 'utf8')
    const h = f.handler(body)
    await h.request(method, '/api/panel/proxies/' + f.proxyId + route).catch((error) => {
      h.response.status = 500
      h.response.body = { error: { code: error.code } }
    })
    assert.equal(h.response.status, 409, JSON.stringify(h.response.body))
    assert.equal(h.response.body.error.code, 'vm_execution_active')
    assert.equal(fs.readFileSync(path.join(f.project, 'vms', 'vm-a.json'), 'utf8'), before)
  })
}

test('proxy global configuration and auto allocation reject globally busy targets', async (t) => {
  const f = await fixture(t)
  await f.otherOperations.tryAcquire({ vmId: 'vm-a' })
  for (const [method, route, body] of [
    ['PUT', '/api/panel/proxies/config', { dns_primary: '1.1.1.1:53' }],
    ['POST', '/api/panel/vms/vm-a/allocate-proxy', {}],
    ['POST', '/api/panel/proxies/import', { text: '192.0.2.2:1080', bind_vm_id: 'vm-a' }],
  ]) {
    const h = f.handler(body)
    await h.request(method, route).catch((error) => {
      h.response.status = 500
      h.response.body = { error: { code: error.code } }
    })
    assert.equal(h.response.status, 409, JSON.stringify(h.response.body))
    assert.equal(h.response.body.error.code, 'vm_operation_active')
  }
})

test('a failed worker reload after proxy editing keeps the target claim unknown', async (t) => {
  const f = await fixture(t)
  process.env.KIN_CRS_MOCK = '0'
  f.seed('vm-a', { status: 'running' })
  const h = f.handler(
    { port: 2080 },
    {
      vmMutationOps: {
        ensureProxyEgress: async () => ({ ok: true }),
        reloadSlotReady: async () => ({ ok: false, error: 'worker ACK missing', vmOperationUncertain: true }),
      },
    },
  )
  await h.request('PUT', '/api/panel/proxies/' + f.proxyId)
  assert.equal(h.response.status, 200)
  assert.equal(h.response.body.data.workers[0].ok, false)
  assert.equal((await f.otherOperations.tryAcquire({ vmId: 'vm-a' })).ok, false)
  assert.equal((await new SharedProxyOperations(f.peer).tryAcquire()).ok, false)
})

test('an idle proxy binding owns the new target and releases both persistent claims after completion', async (t) => {
  const f = await fixture(t)
  f.seed('vm-b')
  const h = f.handler({ vm_id: 'vm-b' }, { vmMutationOps: { ensureProxyEgress: async () => ({ ok: true }) } })
  await h.request('POST', '/api/panel/proxies/' + f.proxyId + '/bind')
  assert.equal(h.response.status, 200, JSON.stringify(h.response.body))
  assert.deepEqual(f.pool.snapshot().proxies.find((proxy) => proxy.id === f.proxyId).bound_vm_ids, ['vm-a', 'vm-b'])
  const vmClaim = await f.otherOperations.tryAcquire({ vmId: 'vm-b' })
  assert.equal(vmClaim.ok, true)
  await vmClaim.release()
  const proxyClaim = await new SharedProxyOperations(f.peer).tryAcquire()
  assert.equal(proxyClaim.ok, true)
  await proxyClaim.release()
})

test('unknown cleanup of an empty proxy keeps its pool claim without inventing a VM target', async (t) => {
  const f = await fixture(t)
  process.env.VM2API_CONTROL_PLANE_MODE = 'standalone'
  await f.pool.unbind(f.proxyId)
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  const h = f.handler(
    {},
    { vmMutationOps: { stopProxyEgress: async () => ({ ok: false, error: 'synthetic unknown' }) } },
  )
  await h.request('DELETE', '/api/panel/proxies/' + f.proxyId)
  assert.equal(h.response.status, 502)
  assert.equal((await new SharedProxyOperations(f.peer).tryAcquire()).ok, false)
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM vm_operations').get()).n, 0)
})

test('proxy unbind awaits confirmed helper stop before releasing its VM claim', async (t) => {
  const f = await fixture(t)
  let finish
  let entered
  const pending = new Promise((resolve) => {
    finish = resolve
  })
  const ready = new Promise((resolve) => {
    entered = resolve
  })
  const h = f.handler(
    {},
    {
      vmMutationOps: {
        stopProxyEgress: async () => {
          entered()
          await pending
          return { ok: true, ended: true }
        },
      },
    },
  )
  const request = h.request('POST', '/api/panel/proxies/' + f.proxyId + '/unbind')
  await ready
  assert.equal((await f.otherOperations.tryAcquire({ vmId: 'vm-a' })).ok, false)
  finish()
  await request
  assert.equal(h.response.status, 200)
  const next = await f.otherOperations.tryAcquire({ vmId: 'vm-a' })
  assert.equal(next.ok, true)
  await next.release()
})

test('package update rejects global executions before its first metadata or credential write', async (t) => {
  const f = await fixture(t)
  const file = path.join(f.project, 'vms', 'vm-a.json')
  const before = fs.readFileSync(file, 'utf8')
  await new ExecutionAdmissionsRepo(f.peer).tryReserve({
    vmId: 'vm-a',
    accountId: 'synthetic',
    vmLimit: 1,
    accountLimit: 1,
    fableLimit: 0,
    rpmLimit: 0,
  })
  const body = buildVmPackage({ vm: { id: 'vm-a', name: 'must not be written', timezone: 'UTC' } })
  const h = f.handler(body, { packageImportBringUp: false })
  await h.request('PUT', '/api/panel/vms/vm-a/package')
  assert.equal(h.response.status, 409)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

test('package create rejects a busy physical alias before assigning an identity', async (t) => {
  const f = await fixture(t)
  await f.otherOperations.tryAcquire({ vmId: 'vm-new' })
  const body = buildVmPackage({ vm: { id: 'new', name: 'synthetic', timezone: 'UTC' } })
  const h = f.handler(body, { packageImportBringUp: false })
  await h.request('POST', '/api/panel/vms/package')
  assert.equal(h.response.status, 409)
  assert.equal(h.response.body.error.code, 'vm_operation_active')
  assert.equal(fs.existsSync(path.join(f.project, 'vms', 'new.json')), false)
})

test('Kubernetes package creation never renames outside its claimed identity', async (t) => {
  const f = await fixture(t)
  const before = fs.readFileSync(path.join(f.project, 'vms', 'vm-a.json'), 'utf8')
  const h = f.handler(buildVmPackage({ vm: { id: 'vm-a', name: 'must not rename', timezone: 'UTC' } }), {
    packageImportBringUp: false,
  })
  await h.request('POST', '/api/panel/vms/package')
  assert.equal(h.response.status, 409)
  assert.equal(h.response.body.error.code, 'vm_id_exists')
  assert.deepEqual(fs.readdirSync(path.join(f.project, 'vms')), ['vm-a.json'])
  assert.equal(fs.readFileSync(path.join(f.project, 'vms', 'vm-a.json'), 'utf8'), before)
})

test('Kubernetes package creation refuses a committed alias missing from this Pod files', async (t) => {
  const f = await fixture(t)
  await new VmsRepo(f.peer).upsertFromVmJson({ id: 'vm-new', status: 'stopped' })
  const h = f.handler(buildVmPackage({ vm: { id: 'new', timezone: 'UTC' } }), { packageImportBringUp: false })
  await h.request('POST', '/api/panel/vms/package')
  assert.equal(h.response.status, 409)
  assert.equal(fs.existsSync(path.join(f.project, 'vms', 'new.json')), false)
})
