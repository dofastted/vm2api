import '../fixtures/kin-computer-test-env.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// Panel sessions persist under KIN_DATA_DIR at module load; keep them in an owned temp dir.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tenant-guards-data-'))
const previousDataDir = process.env.KIN_DATA_DIR
process.env.KIN_DATA_DIR = dataDir
after(() => {
  if (previousDataDir == null) delete process.env.KIN_DATA_DIR
  else process.env.KIN_DATA_DIR = previousDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const { createPanelHandler } = await import('../../src/lib/admin/panel-routes.mjs')
const { authorizePanelRoute } = await import('../../src/lib/admin/panel-acl.mjs')
const { ApiKeyStore } = await import('../../src/lib/admin/api-keys.mjs')
const { PanelUserStore } = await import('../../src/lib/admin/panel-users.mjs')
const { parseAllowedVms } = await import('../../src/lib/admin/key-scope.mjs')
const { createVmPool } = await import('../../src/lib/admin/vm-pools.mjs')
const { VmPoolsRepo } = await import('../../src/lib/db/repos/vm-pools-repo.mjs')
const { createDatabase } = await import('../../src/lib/db/database.mjs')
const { createPanelSession, verifyPanelSession } = await import('../../src/lib/core/security.mjs')
const { readCodexAccounts, upsertCodexAccount } = await import('../../src/lib/vm/codex-slot.mjs')

const TENANT = { panelUser: 'tenant', panelRole: 'user', panelUserId: 'u-1' }
const ADMIN = { apiKeyKind: 'master', panelRole: 'admin' }

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tenant-guards-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  return root
}

function writeVm(root, vm) {
  fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
}

function codexVm(root, id, owner) {
  writeVm(root, {
    id,
    platform: 'openai',
    family: 'codex',
    owner_user_id: owner,
    codex: { email: `${id}@example.com`, has_access: true, has_refresh: true },
  })
  upsertCodexAccount(root, id, { email: `${id}@example.com`, access_token: `old-${id}`, refresh_token: 'rt' })
}

function claudeVm(root, id, owner) {
  writeVm(root, { id, platform: 'anthropic', family: 'claude', owner_user_id: owner })
}

function makeHandler(root, who, body, extra = {}) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: root } },
    routingConfig: {},
    ...extra,
    requireAuth(req) {
      Object.assign(req, who)
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => body,
  })
  const call = (method, url) =>
    handlePanel({ method, headers: {} }, {}, new URL(`http://localhost${url}`)).then(() => response)
  return { call, response }
}

test('tenant cannot import credentials into another tenant slot; missing and foreign look the same', async (t) => {
  const root = makeProject(t)
  codexVm(root, 'vm-mine', 'u-1')
  codexVm(root, 'vm-other', 'u-2')
  const body = (vm_id) => ({ vm_id, mode: 'access_token', raw: 'tenant-at' })

  const foreign = await makeHandler(root, TENANT, body('vm-other')).call('POST', '/api/panel/vms/import')
  assert.equal(foreign.status, 404)
  const missing = await makeHandler(root, TENANT, body('vm-nope')).call('POST', '/api/panel/vms/import')
  assert.equal(missing.status, 404)
  assert.deepEqual(foreign.body, missing.body)
  assert.equal(readCodexAccounts(root, 'vm-other')[0].access_token, 'old-vm-other')

  const own = await makeHandler(root, TENANT, body('vm-mine')).call('POST', '/api/panel/vms/import')
  assert.equal(own.status, 200, JSON.stringify(own.body))
  assert.equal(readCodexAccounts(root, 'vm-mine')[0].access_token, 'tenant-at')
})

test('admin import still reaches any slot', async (t) => {
  const root = makeProject(t)
  codexVm(root, 'vm-other', 'u-2')
  const out = await makeHandler(root, ADMIN, { vm_id: 'vm-other', mode: 'access_token', raw: 'admin-at' }).call(
    'POST',
    '/api/panel/vms/import',
  )
  assert.equal(out.status, 200, JSON.stringify(out.body))
  assert.equal(readCodexAccounts(root, 'vm-other')[0].access_token, 'admin-at')
})

test('tenant proxy import cannot bind a slot it does not own', async (t) => {
  const root = makeProject(t)
  claudeVm(root, 'vm-other', 'u-2')
  const calls = []
  const proxyPool = {
    importLines(...args) {
      calls.push(['import', ...args])
      return { items: [{ id: 'px-1' }] }
    },
    bind(...args) {
      calls.push(['bind', ...args])
      return { ok: false, error: 'stub' }
    },
  }
  const tenant = await makeHandler(root, TENANT, { text: 'h:1080', bind_vm_id: 'vm-other' }, { proxyPool }).call(
    'POST',
    '/api/panel/proxies/import',
  )
  assert.equal(tenant.status, 404)
  assert.deepEqual(calls, [])

  const admin = await makeHandler(root, ADMIN, { text: 'h:1080', bind_vm_id: 'vm-other' }, { proxyPool }).call(
    'POST',
    '/api/panel/proxies/import',
  )
  assert.equal(admin.status, 200, JSON.stringify(admin.body))
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['import', 'bind'],
  )
})

function keyFixture(t) {
  const root = makeProject(t)
  claudeVm(root, 'vm-mine', 'u-1')
  claudeVm(root, 'vm-other', 'u-2')
  const store = new ApiKeyStore({ dataDir: fs.mkdtempSync(path.join(root, 'keys-')) })
  const key = store.create({ name: 'mine', user_id: 'u-1', group_id: 1 })
  return { root, store, key }
}

test('tenant key PATCH drops user_id and group_id', async (t) => {
  const { root, store, key } = keyFixture(t)
  const out = await makeHandler(
    root,
    TENANT,
    { name: 'renamed', user_id: 'u-2', group_id: 7 },
    { apiKeyStore: store },
  ).call('PATCH', `/api/panel/api-keys/${key.id}`)
  assert.equal(out.status, 200, JSON.stringify(out.body))
  const saved = store.getById(key.id)
  assert.equal(saved.name, 'renamed')
  assert.equal(saved.user_id, 'u-1')
  assert.equal(saved.group_id, 1)

  const cleared = await makeHandler(root, TENANT, { user_id: null }, { apiKeyStore: store }).call(
    'PATCH',
    `/api/panel/api-keys/${key.id}`,
  )
  assert.equal(cleared.status, 200)
  assert.equal(store.getById(key.id).user_id, 'u-1')
})

test('tenant key scope only accepts its own slots, on PATCH and create', async (t) => {
  const { root, store, key } = keyFixture(t)
  const foreign = { group_type: 'anthropic', allowed_vms: ['vm-other'] }
  const missing = { group_type: 'anthropic', allowed_vms: ['vm-nope'] }

  const patchForeign = await makeHandler(root, TENANT, foreign, { apiKeyStore: store }).call(
    'PATCH',
    `/api/panel/api-keys/${key.id}`,
  )
  assert.equal(patchForeign.status, 400)
  assert.equal(patchForeign.body.error.code, 'key_vm_unknown')
  const patchMissing = await makeHandler(root, TENANT, missing, { apiKeyStore: store }).call(
    'PATCH',
    `/api/panel/api-keys/${key.id}`,
  )
  assert.deepEqual(patchForeign.body, patchMissing.body)
  assert.equal(store.getById(key.id).group_type, 'all')

  const patchOwn = await makeHandler(
    root,
    TENANT,
    { group_type: 'anthropic', allowed_vms: ['vm-mine'] },
    { apiKeyStore: store },
  ).call('PATCH', `/api/panel/api-keys/${key.id}`)
  assert.equal(patchOwn.status, 200, JSON.stringify(patchOwn.body))
  assert.deepEqual(parseAllowedVms(store.getById(key.id).allowed_vms), ['vm-mine'])

  const before = store.list().length
  const createForeign = await makeHandler(root, TENANT, { name: 'x', ...foreign }, { apiKeyStore: store }).call(
    'POST',
    '/api/panel/api-keys',
  )
  assert.equal(createForeign.status, 400)
  assert.equal(createForeign.body.error.code, 'key_vm_unknown')
  assert.equal(store.list().length, before)

  const created = await makeHandler(
    root,
    TENANT,
    { name: 'new', user_id: 'u-2', group_id: 7, group_type: 'anthropic', allowed_vms: ['vm-mine'] },
    { apiKeyStore: store },
  ).call('POST', '/api/panel/api-keys')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const rec = store.getById(created.body.item.id)
  assert.equal(rec.user_id, 'u-1')
  assert.equal(rec.group_id, 1)
})

test('tenant cannot delete a self-created slot; admin still can', async (t) => {
  const root = makeProject(t)
  writeVm(root, {
    id: 'vm-mine',
    platform: 'anthropic',
    family: 'claude',
    owner_user_id: 'u-1',
    origin: 'user_created',
  })
  const tenantDel = await makeHandler(root, TENANT, {}, {}).call('DELETE', '/api/panel/vms/vm-mine')
  assert.equal(tenantDel.status, 403)
  assert.equal(tenantDel.body?.error?.code, 'forbidden')
  assert.ok(fs.existsSync(path.join(root, 'vms', 'vm-mine.json')))

  const adminDel = await makeHandler(root, ADMIN, {}, {}).call('DELETE', '/api/panel/vms/vm-mine')
  assert.equal(adminDel.status, 200, JSON.stringify(adminDel.body))
  assert.equal(adminDel.body?.data?.deleted, 'vm-mine')
})

test('only admins can create or switch keys to the API category', async (t) => {
  const { root, store, key } = keyFixture(t)
  const before = store.list().length
  const create = await makeHandler(root, TENANT, { name: 'direct', category: 'api' }, { apiKeyStore: store }).call(
    'POST',
    '/api/panel/api-keys',
  )
  assert.equal(create.status, 403)
  assert.equal(create.body.error.code, 'key_category_forbidden')
  assert.equal(store.list().length, before)

  const patch = await makeHandler(root, TENANT, { category: ' API ' }, { apiKeyStore: store }).call(
    'PATCH',
    `/api/panel/api-keys/${key.id}`,
  )
  assert.equal(patch.status, 403)
  assert.equal(store.getById(key.id).category, 'oauth')

  const admin = await makeHandler(root, ADMIN, { category: 'api' }, { apiKeyStore: store }).call(
    'PATCH',
    `/api/panel/api-keys/${key.id}`,
  )
  assert.equal(admin.status, 200, JSON.stringify(admin.body))
  assert.equal(store.getById(key.id).category, 'api')
})

test('admin key edits keep user_id, group_id and any slot', async (t) => {
  const { root, store, key } = keyFixture(t)
  const out = await makeHandler(
    root,
    ADMIN,
    { user_id: 'u-2', group_id: 7, group_type: 'anthropic', allowed_vms: ['vm-other'] },
    { apiKeyStore: store },
  ).call('PATCH', `/api/panel/api-keys/${key.id}`)
  assert.equal(out.status, 200, JSON.stringify(out.body))
  const saved = store.getById(key.id)
  assert.equal(saved.user_id, 'u-2')
  assert.equal(saved.group_id, 7)
  assert.deepEqual(parseAllowedVms(saved.allowed_vms), ['vm-other'])

  const created = await makeHandler(
    root,
    ADMIN,
    { name: 'for-u2', user_id: 'u-2', group_id: 7, group_type: 'anthropic', allowed_vms: ['vm-other'] },
    { apiKeyStore: store },
  ).call('POST', '/api/panel/api-keys')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const rec = store.getById(created.body.item.id)
  assert.equal(rec.user_id, 'u-2')
  assert.equal(rec.group_id, 7)
})

test('tenant key create/patch vm_pool_id guard; admin can set pool', async (t) => {
  const { root, store, key } = keyFixture(t)
  const poolRepo = new VmPoolsRepo(store.db)
  const pool = createVmPool(poolRepo, { name: 'Shared Pool', vm_ids: [] })

  // 1. Tenant POST /api/panel/api-keys with non-empty vm_pool_id -> 403 key_pool_forbidden
  const countBefore = store.list().length
  const tenantCreateWithPool = await makeHandler(
    root,
    TENANT,
    { name: 'tenant-pool-key', vm_pool_id: pool.id },
    { apiKeyStore: store },
  ).call('POST', '/api/panel/api-keys')
  assert.equal(tenantCreateWithPool.status, 403, JSON.stringify(tenantCreateWithPool.body))
  assert.deepEqual(tenantCreateWithPool.body, {
    ok: false,
    error: { code: 'key_pool_forbidden', message: '只有管理员可以设置账号池' },
  })
  assert.equal(store.list().length, countBefore, 'did not write key to db on 403')

  // 2. Tenant POST /api/panel/api-keys without vm_pool_id or with null/empty string -> 201 success
  const tenantCreateEmpty = await makeHandler(
    root,
    TENANT,
    { name: 'tenant-empty-pool', vm_pool_id: '' },
    { apiKeyStore: store },
  ).call('POST', '/api/panel/api-keys')
  assert.equal(tenantCreateEmpty.status, 201, JSON.stringify(tenantCreateEmpty.body))
  const emptyKey = store.getById(tenantCreateEmpty.body.item.id)
  assert.equal(emptyKey.vm_pool_id, null)

  const tenantCreateNull = await makeHandler(
    root,
    TENANT,
    { name: 'tenant-null-pool', vm_pool_id: null },
    { apiKeyStore: store },
  ).call('POST', '/api/panel/api-keys')
  assert.equal(tenantCreateNull.status, 201, JSON.stringify(tenantCreateNull.body))
  const nullKey = store.getById(tenantCreateNull.body.item.id)
  assert.equal(nullKey.vm_pool_id, null)

  // 3. Admin POST with vm_pool_id -> 201 success
  const adminCreate = await makeHandler(
    root,
    ADMIN,
    { name: 'admin-pool-key', vm_pool_id: pool.id },
    { apiKeyStore: store },
  ).call('POST', '/api/panel/api-keys')
  assert.equal(adminCreate.status, 201, JSON.stringify(adminCreate.body))
  const adminKey = store.getById(adminCreate.body.item.id)
  assert.equal(adminKey.vm_pool_id, pool.id)

  // 4. Admin assigns pool to tenant key
  const adminPatchPool = await makeHandler(root, ADMIN, { vm_pool_id: pool.id }, { apiKeyStore: store }).call(
    'PATCH',
    `/api/panel/api-keys/${key.id}`,
  )
  assert.equal(adminPatchPool.status, 200, JSON.stringify(adminPatchPool.body))
  assert.equal(store.getById(key.id).vm_pool_id, pool.id)

  // 5. Tenant PATCH with non-empty vm_pool_id -> 403 key_pool_forbidden
  const tenantPatchWithPool = await makeHandler(
    root,
    TENANT,
    { vm_pool_id: 'pool_other01' },
    { apiKeyStore: store },
  ).call('PATCH', `/api/panel/api-keys/${key.id}`)
  assert.equal(tenantPatchWithPool.status, 403, JSON.stringify(tenantPatchWithPool.body))
  assert.deepEqual(tenantPatchWithPool.body, {
    ok: false,
    error: { code: 'key_pool_forbidden', message: '只有管理员可以设置账号池' },
  })
  assert.equal(store.getById(key.id).vm_pool_id, pool.id, 'retained existing pool')

  // 6. Tenant PATCH with null or empty string vm_pool_id -> retains existing pool without error
  const tenantPatchNull = await makeHandler(
    root,
    TENANT,
    { name: 'renamed-by-tenant', vm_pool_id: null },
    { apiKeyStore: store },
  ).call('PATCH', `/api/panel/api-keys/${key.id}`)
  assert.equal(tenantPatchNull.status, 200, JSON.stringify(tenantPatchNull.body))
  const keyAfterTenantNull = store.getById(key.id)
  assert.equal(keyAfterTenantNull.name, 'renamed-by-tenant')
  assert.equal(keyAfterTenantNull.vm_pool_id, pool.id, 'pool was not wiped by tenant')

  // 7. Tenant PATCH without vm_pool_id -> retains existing pool
  const tenantPatchOmit = await makeHandler(root, TENANT, { max_concurrency: 5 }, { apiKeyStore: store }).call(
    'PATCH',
    `/api/panel/api-keys/${key.id}`,
  )
  assert.equal(tenantPatchOmit.status, 200, JSON.stringify(tenantPatchOmit.body))
  assert.equal(store.getById(key.id).vm_pool_id, pool.id)
})

function usersFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tenant-guards-users-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const panelUsers = new PanelUserStore({ db })
  panelUsers.create({ username: 'boss', password: 'boss-pass-1', role: 'admin' })
  return panelUsers
}

test('changing a user role or disabling it ends that user panel sessions', async (t) => {
  const panelUsers = usersFixture(t)
  const root = makeProject(t)
  for (const [i, patch] of [{ role: 'super' }, { enabled: false }].entries()) {
    const user = panelUsers.create({ username: `tenant${i}`, password: 'tenant-pass', role: 'user' })
    const token = createPanelSession(user.username, { role: 'user' })
    const other = createPanelSession('boss', { role: 'admin' })
    const out = await makeHandler(root, ADMIN, patch, { panelUsers }).call('PATCH', `/api/panel/users/${user.id}`)
    assert.equal(out.status, 200, JSON.stringify(out.body))
    assert.equal(verifyPanelSession(token), null, JSON.stringify(patch))
    assert.equal(verifyPanelSession(other)?.user, 'boss')
  }
})

test('unrelated user edits keep sessions alive', async (t) => {
  const panelUsers = usersFixture(t)
  const root = makeProject(t)
  const user = panelUsers.create({ username: 'quota', password: 'tenant-pass', role: 'user' })
  const token = createPanelSession(user.username, { role: 'user' })
  const out = await makeHandler(root, ADMIN, { vm_create_quota: 3, role: 'user', enabled: true }, { panelUsers }).call(
    'PATCH',
    `/api/panel/users/${user.id}`,
  )
  assert.equal(out.status, 200, JSON.stringify(out.body))
  assert.equal(verifyPanelSession(token)?.user, 'quota')
})

test('test-models is readable by user and super; other routes stay closed', () => {
  for (const role of ['user', 'super', 'admin']) {
    assert.equal(authorizePanelRoute('GET', '/api/panel/test-models', role).ok, true, role)
  }
  for (const role of ['user', 'super']) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal(authorizePanelRoute(method, '/api/panel/test-models', role).ok, false, `${role} ${method}`)
    }
  }
  assert.equal(authorizePanelRoute('GET', '/api/panel/test-models/x', 'user').ok, false)
  assert.equal(authorizePanelRoute('PUT', '/api/panel/test-schedule/default', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-01/test-chat', 'super').ok, false)
})

test('tenant test-models: own slot lists models, foreign slot 404s, refresh never goes live', async (t) => {
  const root = makeProject(t)
  // A listener standing in for the slot SOCKS5: any connection means a live catalog refresh ran.
  let dials = 0
  const socks = net.createServer((socket) => {
    dials += 1
    socket.destroy()
  })
  await new Promise((resolve) => socks.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => socks.close(resolve)))
  const proxy = { host: '127.0.0.1', port: socks.address().port }
  for (const [id, owner] of [
    ['vm-mine', 'u-1'],
    ['vm-other', 'u-2'],
  ]) {
    codexVm(root, id, owner)
    const file = path.join(root, 'vms', `${id}.json`)
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), proxy }))
  }
  // Fresh catalog-version cache so a refresh never reaches the public registry.
  fs.writeFileSync(
    path.join(dataDir, 'codex-catalog-client.json'),
    JSON.stringify({ version: '0.160.0', fetched_at: new Date().toISOString() }),
  )

  const own = await makeHandler(root, TENANT, null).call('GET', '/api/panel/test-models?vm_id=vm-mine&refresh=1')
  assert.equal(own.status, 200, JSON.stringify(own.body))
  assert.equal(own.body.data.source, 'policy')
  assert.ok(Array.isArray(own.body.data.items) && own.body.data.items.length > 0, JSON.stringify(own.body.data))
  assert.equal(dials, 0)

  const foreign = await makeHandler(root, TENANT, null).call('GET', '/api/panel/test-models?vm_id=vm-other')
  assert.equal(foreign.status, 404)
  const missing = await makeHandler(root, TENANT, null).call('GET', '/api/panel/test-models?vm_id=vm-nope')
  assert.deepEqual(foreign.body, missing.body)

  const superUser = { panelUser: 'ops', panelRole: 'super', panelUserId: 'u-9' }
  const sup = await makeHandler(root, superUser, null).call('GET', '/api/panel/test-models?vm_id=vm-other&refresh=1')
  assert.equal(sup.status, 200)
  assert.equal(dials, 0)

  const admin = await makeHandler(root, ADMIN, null).call('GET', '/api/panel/test-models?vm_id=vm-other&refresh=1')
  assert.equal(admin.status, 200)
  assert.ok(dials > 0, 'admin refresh still goes live')
})
