import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { GeminiOwnersRepo } from '../../src/lib/db/repos/gemini-owners-repo.mjs'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'
import { apiScheduleScope, resolveInferenceBackend } from '../../src/lib/pool/api-protocol.mjs'
import {
  PLATFORM_SCOPE,
  endpointMatchesOwnerScope,
  geminiEnvMatchesOwnerScope,
  ownerScopeFromApiKey,
  ownerScopeFromRequest,
  vmMatchesOwnerScope,
} from '../../src/lib/admin/resource-owner.mjs'
import {
  assertKeyResourceOwnership,
  keyAllowsEndpoint,
  keyAllowsGeminiEnv,
  keyAllowsVm,
  keyScopeFromRequest,
  keyTierPolicyFromRecord,
} from '../../src/lib/admin/key-scope.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { createGeminiPublicHandler } from '../../src/lib/gemini/routes.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createIntegrationHandler } from '../../src/lib/admin/integration-routes.mjs'
import { DEFAULT_INTEGRATION_SCOPES, IntegrationTokenStore } from '../../src/lib/admin/integration-tokens.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'
import { createMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'

function makeReq({ method = 'GET', url = '/', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const chunks = body !== undefined ? [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))] : []
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  req.socket = { remoteAddress }
  return req
}

function makeRes() {
  return {
    headers: {},
    headersSent: false,
    writableEnded: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v
    },
    on() {},
    once() {},
    off() {},
    write() {},
    end() {
      this.writableEnded = true
    },
  }
}

test('two-way official API endpoint isolation across platform, tenant, and resource tiers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-multitier-ep-'))
  try {
    const db = openDatabase({ dbPath: path.join(tmp, 'vm2api.db') })
    const epStore = new ApiEndpointStore({ db })
    const keyStore = new ApiKeyStore({ db })
    const scheduler = new ApiScheduler()

    const epAdmin = epStore.create({
      name: 'admin-official',
      kind: 'custom',
      protocol: 'anthropic',
      base_url: 'https://admin.example.invalid',
      owner_user_id: null,
      models: [
        { name: 'claude-admin-only', alias: 'claude-admin-only' },
        { name: 'claude-shared', alias: 'claude-shared' },
      ],
      api_key_entries: [{ api_key: 'sk-ant-admin-secret-111111' }],
    })
    const epSupA1 = epStore.create({
      name: 'sup-a-official-1',
      kind: 'custom',
      protocol: 'anthropic',
      base_url: 'https://supa1.example.invalid',
      owner_user_id: 'supplier-a',
      models: [
        { name: 'claude-supa1-only', alias: 'claude-supa1-only' },
        { name: 'claude-shared', alias: 'claude-shared' },
      ],
      api_key_entries: [{ api_key: 'sk-ant-supa1-secret-222222' }],
    })
    const epSupA2 = epStore.create({
      name: 'sup-a-official-2',
      kind: 'custom',
      protocol: 'gemini',
      base_url: 'https://supa2.example.invalid',
      owner_user_id: 'supplier-a',
      models: [{ name: 'gemini-supa2', alias: 'gemini-supa2' }],
      api_key_entries: [{ api_key: 'AIzaSySupA2SecretKey333333' }],
    })
    const epSupB = epStore.create({
      name: 'sup-b-official',
      kind: 'custom',
      protocol: 'anthropic',
      base_url: 'https://supb.example.invalid',
      owner_user_id: 'supplier-b',
      models: [
        { name: 'claude-supb-only', alias: 'claude-supb-only' },
        { name: 'claude-shared', alias: 'claude-shared' },
      ],
      api_key_entries: [{ api_key: 'sk-ant-supb-secret-444444' }],
    })
    scheduler.reload(epStore.listRaw())

    // 1. Platform/admin key CANNOT see or invoke any supplier's official API key
    const adminKey = keyStore.create({ name: 'admin-api', category: 'api', permission_tier: 'platform' })
    const adminReq = { apiKeyKind: 'managed', apiKeyRecord: adminKey }
    const adminScope = apiScheduleScope(adminReq, 'all')
    assert.deepEqual(adminScope.ownerScope, PLATFORM_SCOPE)
    const adminModels = scheduler.catalog(adminScope).data.map((m) => m.id)
    assert.deepEqual(adminModels.sort(), ['claude-admin-only', 'claude-shared'])
    assert.equal(scheduler.pick('claude-supa1-only', Date.now(), adminScope).ok, false)
    assert.equal(scheduler.pick('claude-supb-only', Date.now(), adminScope).ok, false)
    assert.equal(scheduler.pick('gemini-supa2', Date.now(), adminScope).ok, false)
    const adminShared = scheduler.pick('claude-shared', Date.now(), adminScope)
    assert.equal(adminShared.ok, true)
    assert.equal(adminShared.endpoint.id, epAdmin.id)

    // 2. Supplier A tenant key sees ALL Supplier A endpoints, NEVER Admin or Supplier B
    const supATenantKey = keyStore.create({
      name: 'sup-a-tenant',
      category: 'all',
      permission_tier: 'tenant',
      owner_id: 'supplier-a',
      group_type: 'all',
    })
    assert.equal(resolveInferenceBackend({ apiKeyKind: 'managed', apiKeyRecord: supATenantKey }), 'all')
    const supATenantScope = apiScheduleScope({ apiKeyKind: 'managed', apiKeyRecord: supATenantKey }, 'all')
    assert.deepEqual(supATenantScope.ownerScope, { type: 'user', userId: 'supplier-a' })
    const supAModels = scheduler.catalog(supATenantScope).data.map((m) => m.id)
    assert.deepEqual(supAModels.sort(), ['claude-shared', 'claude-supa1-only', 'gemini-supa2'])
    assert.equal(scheduler.pick('claude-admin-only', Date.now(), supATenantScope).ok, false)
    assert.equal(scheduler.pick('claude-supb-only', Date.now(), supATenantScope).ok, false)
    const supAShared = scheduler.pick('claude-shared', Date.now(), supATenantScope)
    assert.equal(supAShared.ok, true)
    assert.equal(supAShared.endpoint.id, epSupA1.id)
    const supAGem = scheduler.pick('gemini-supa2', Date.now(), supATenantScope)
    assert.equal(supAGem.ok, true)
    assert.equal(supAGem.endpoint.id, epSupA2.id)

    // 3. Supplier A resource key pinned ONLY to epSupA1 cannot reach epSupA2, Admin, or Supplier B
    const supAPinnedKey = keyStore.create({
      name: 'sup-a-pinned',
      category: 'api',
      permission_tier: 'resource',
      owner_id: 'supplier-a',
      group_type: 'all',
      allowed_endpoints: [epSupA1.id],
    })
    const supAPinnedScope = apiScheduleScope({ apiKeyKind: 'managed', apiKeyRecord: supAPinnedKey }, 'all')
    assert.equal(scheduler.pick('claude-supa1-only', Date.now(), supAPinnedScope).ok, true)
    assert.equal(scheduler.pick('gemini-supa2', Date.now(), supAPinnedScope).ok, false)
    assert.equal(scheduler.pick('claude-admin-only', Date.now(), supAPinnedScope).ok, false)

    // 4. Resource-tier key with empty allowed_endpoints fails closed
    const emptyResourceScope = apiScheduleScope(
      {
        apiKeyKind: 'managed',
        apiKeyRecord: {
          category: 'api',
          permission_tier: 'resource',
          owner_id: 'supplier-a',
          allowed_endpoints: '[]',
        },
      },
      'all',
    )
    assert.equal(scheduler.hasOwnedEndpoints(emptyResourceScope.ownerScope, emptyResourceScope), false)
    assert.equal(scheduler.catalog(emptyResourceScope).data.length, 0)
    assert.equal(scheduler.pick('claude-shared', Date.now(), emptyResourceScope).ok, false)

    // 5. Tenant-tier key missing owner_id fails closed
    const orphanTenantScope = ownerScopeFromApiKey({ permission_tier: 'tenant', owner_id: null, user_id: null })
    assert.deepEqual(orphanTenantScope, { type: 'none' })
    assert.equal(endpointMatchesOwnerScope(epAdmin, orphanTenantScope), false)
    assert.equal(endpointMatchesOwnerScope(epSupA1, orphanTenantScope), false)
    assert.equal(keyAllowsEndpoint(keyTierPolicyFromRecord(supAPinnedKey), epSupA1), true)
    assert.equal(keyAllowsEndpoint(keyTierPolicyFromRecord(supAPinnedKey), epSupA2), false)
    assert.equal(epSupB.owner_user_id, 'supplier-b')

    closeDatabase()
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('two-way Gemini environment isolation across platform, tenant, and resource tiers', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-multitier-gem-'))
  try {
    const db = openDatabase({ dbPath: path.join(tmp, 'vm2api.db') })
    const gemOwners = new GeminiOwnersRepo(db)
    gemOwners.setOwner('gem-sup-a-1', 'supplier-a')
    gemOwners.setOwner('gem-sup-a-2', 'supplier-a')
    gemOwners.setOwner('gem-sup-b-1', 'supplier-b')
    // gem-admin has no row -> platform owned (null)

    const envSpecs = [
      { id: 'gem-admin', proxy_id: 'px-1', models: ['gemini-admin-pro'] },
      { id: 'gem-sup-a-1', proxy_id: 'px-1', models: ['gemini-supa1-pro'] },
      { id: 'gem-sup-a-2', proxy_id: 'px-1', models: ['gemini-supa2-pro'] },
      { id: 'gem-sup-b-1', proxy_id: 'px-1', models: ['gemini-supb-pro'] },
    ]
    const inferredEnvs = []
    const scheduler = createGeminiScheduler({
      geminiOwnersRepo: gemOwners,
      schedulerRuntime: createMockSchedulerRuntime(),
      callHost: async (op, payload) => {
        if (op === 'list') {
          return {
            payload_state: 'installed',
            environments: envSpecs.map((e) => ({
              id: e.id,
              proxy_id: e.proxy_id,
              auth_state: 'authorized',
              auth_method: 'oauth',
              models_discovered: true,
              models: e.models,
            })),
          }
        }
        if (op === 'get') {
          const hit = envSpecs.find((e) => e.id === payload.id)
          return { id: hit.id, proxy_id: hit.proxy_id, auth_method: 'oauth' }
        }
        if (op === 'test-chat') {
          inferredEnvs.push(payload.id)
          return { run_id: 'a'.repeat(32) }
        }
        if (op === 'test-chat-status') {
          return { state: 'completed', text: `ok:${payload.id}`, usage: { input_tokens: 1, output_tokens: 1 } }
        }
        throw new Error(`unexpected op ${op}`)
      },
      resolveProxy: () => 'socks5h://1.2.3.4:1080',
    })

    const pub = createGeminiPublicHandler({
      json: (res, status, body) => {
        res.status = status
        res.body = body
      },
      readBody: async (req) => JSON.parse(req._raw || '{}'),
      scheduler,
    })

    // 1. Platform key sees ONLY gem-admin
    const adminListRes = makeRes()
    await pub(
      {
        method: 'GET',
        url: '/v1/models',
        headers: {},
        apiKeyKind: 'managed',
        apiKeyRecord: { id: 'k-adm', group_type: 'gemini', permission_tier: 'platform', owner_id: null },
      },
      adminListRes,
    )
    assert.equal(adminListRes.status, 200)
    assert.deepEqual(
      adminListRes.body.data.map((m) => m.id),
      ['gemini-admin-pro'],
    )

    // 2. Supplier A tenant key sees ONLY gem-sup-a-1 & gem-sup-a-2, CANNOT invoke gem-admin or gem-sup-b-1
    const supAReqBase = {
      apiKeyKind: 'managed',
      apiKeyRecord: { id: 'k-supa', group_type: 'gemini', permission_tier: 'tenant', owner_id: 'supplier-a' },
      once() {},
      off() {},
    }
    const supAListRes = makeRes()
    await pub({ ...supAReqBase, method: 'GET', url: '/v1/models', headers: {} }, supAListRes)
    assert.equal(supAListRes.status, 200)
    assert.deepEqual(supAListRes.body.data.map((m) => m.id).sort(), ['gemini-supa1-pro', 'gemini-supa2-pro'])

    const supACallAdminRes = makeRes()
    await pub(
      {
        ...supAReqBase,
        method: 'POST',
        url: '/v1beta/models/gemini-admin-pro:generateContent',
        headers: {},
        body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      },
      supACallAdminRes,
    )
    assert.equal(supACallAdminRes.status, 404)

    // 3. Supplier A resource key pinned ONLY to gem-sup-a-1 invokes gem-sup-a-1 and rejects gem-sup-a-2
    const supAPinRec = {
      id: 'k-supa-pin',
      group_type: 'gemini',
      permission_tier: 'resource',
      owner_id: 'supplier-a',
      allowed_gemini_envs: JSON.stringify(['gem-sup-a-1']),
    }
    assert.equal(keyAllowsGeminiEnv(keyTierPolicyFromRecord(supAPinRec), 'gem-sup-a-1'), true)
    assert.equal(keyAllowsGeminiEnv(keyTierPolicyFromRecord(supAPinRec), 'gem-sup-a-2'), false)
    assert.equal(geminiEnvMatchesOwnerScope(gemOwners.getOwner('gem-sup-a-1'), PLATFORM_SCOPE), false)

    const pinOkRes = makeRes()
    await pub(
      {
        method: 'POST',
        url: '/v1beta/models/gemini-supa1-pro:generateContent',
        headers: {},
        apiKeyKind: 'managed',
        apiKeyRecord: supAPinRec,
        body: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        once() {},
        off() {},
      },
      pinOkRes,
    )
    assert.equal(pinOkRes.status, 200)
    assert.deepEqual(inferredEnvs, ['gem-sup-a-1'])

    const pinDeniedRes = makeRes()
    await pub(
      {
        method: 'POST',
        url: '/v1beta/models/gemini-supa2-pro:generateContent',
        headers: {},
        apiKeyKind: 'managed',
        apiKeyRecord: supAPinRec,
        body: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        once() {},
        off() {},
      },
      pinDeniedRes,
    )
    assert.equal(pinDeniedRes.status, 404)

    closeDatabase()
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('protocol dispatch enforces supplier-only official API access and blocks platform/cross-tenant escalation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-proto-iso-'))
  try {
    const scheduler = new ApiScheduler()
    scheduler.reload([
      {
        id: 'ep-admin',
        kind: 'custom',
        protocol: 'anthropic',
        owner_user_id: null,
        base_url: 'https://admin.invalid',
        models: [{ name: 'claude-admin-only', alias: 'claude-admin-only' }],
        api_key_entries: [{ id: 'k-adm', api_key: 'sk-admin' }],
      },
      {
        id: 'ep-sup-a',
        kind: 'custom',
        protocol: 'anthropic',
        owner_user_id: 'supplier-a',
        base_url: 'https://supa.invalid',
        models: [{ name: 'claude-supa-only', alias: 'claude-supa-only' }],
        api_key_entries: [{ id: 'k-supa', api_key: 'sk-supa' }],
      },
    ])

    const makeHandler = (model) => {
      const response = makeRes()
      const handler = createHandleProtocol({
        json: (_res, status, body) => {
          response.status = status
          response.body = body
          return body
        },
        writeSSEHeaders() {},
        readBody: async () => ({ model, messages: [{ role: 'user', content: 'hi' }] }),
        requireAuth: () => true,
        cfg: {
          rewrite: { enabled: false },
          intercept: { rules: [] },
          distill: { enabled: false },
          limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
          paths: { data: root, project: root },
        },
        requestLog: { start: () => ({ request_id: 'proto-iso' }), finish() {} },
        stickyRouter: {},
        accountQuota: {},
        apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
        apiScheduler: scheduler,
        apiEndpointStore: {},
        stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
        routingConfig: { failover: {} },
        groupsRepo: { rateMultiplier: () => 1 },
      })
      return { handler, response }
    }

    // 1. Platform key CANNOT call supplier-a's official API model
    {
      const { handler, response } = makeHandler('claude-supa-only')
      await handler.handleProtocol(
        {
          method: 'POST',
          url: '/v1/messages',
          headers: { authorization: 'Bearer sk-admin', 'user-agent': 'test' },
          apiKeyKind: 'managed',
          apiKeyRecord: { category: 'api', permission_tier: 'platform', owner_id: null },
          once() {},
          off() {},
        },
        response,
        'anthropic.messages',
        '/v1/messages',
      )
      assert.equal(response.status, 404)
      assert.equal(response.body.error.code, 'model_not_found')
    }

    // 2. Supplier A key CANNOT call admin's official API model
    {
      const { handler, response } = makeHandler('claude-admin-only')
      await handler.handleProtocol(
        {
          method: 'POST',
          url: '/v1/messages',
          headers: { authorization: 'Bearer sk-supa', 'user-agent': 'test' },
          apiKeyKind: 'managed',
          apiKeyRecord: { category: 'api', permission_tier: 'tenant', owner_id: 'supplier-a' },
          once() {},
          off() {},
        },
        response,
        'anthropic.messages',
        '/v1/messages',
      )
      assert.equal(response.status, 404)
      assert.equal(response.body.error.code, 'model_not_found')
    }

    // 3. Supplier C (owns zero API endpoints) gets 403 api_backend_forbidden
    {
      const { handler, response } = makeHandler('claude-admin-only')
      await handler.handleProtocol(
        {
          method: 'POST',
          url: '/v1/messages',
          headers: { authorization: 'Bearer sk-supc', 'user-agent': 'test' },
          apiKeyKind: 'managed',
          apiKeyRecord: { category: 'api', permission_tier: 'tenant', owner_id: 'supplier-c' },
          once() {},
          off() {},
        },
        response,
        'anthropic.messages',
        '/v1/messages',
      )
      assert.equal(response.status, 403)
      assert.equal(response.body.error.code, 'api_backend_forbidden')
    }

    // 4. VM scope isolation: tenant tier allows all VMs of that owner's platform; resource tier requires exact pin
    const vmAdmin = { id: 'vm-admin', owner_user_id: null, platform: 'anthropic' }
    const vmSupA1 = { id: 'vm-supa-1', owner_user_id: 'supplier-a', platform: 'anthropic' }
    const vmSupA2 = { id: 'vm-supa-2', owner_user_id: 'supplier-a', platform: 'anthropic' }
    const supAScope = ownerScopeFromRequest({
      apiKeyKind: 'managed',
      apiKeyRecord: { permission_tier: 'tenant', owner_id: 'supplier-a', group_type: 'anthropic' },
    })
    assert.equal(vmMatchesOwnerScope(vmAdmin, supAScope), false)
    assert.equal(vmMatchesOwnerScope(vmSupA1, supAScope), true)
    assert.equal(vmMatchesOwnerScope(vmSupA1, PLATFORM_SCOPE), false)
    assert.equal(vmMatchesOwnerScope(vmAdmin, PLATFORM_SCOPE), true)

    const tenantVmKeyScope = {
      ...keyScopeFromRequest({
        apiKeyKind: 'managed',
        apiKeyRecord: { permission_tier: 'tenant', owner_id: 'supplier-a', group_type: 'anthropic', allowed_vms: '[]' },
      }),
      permission_tier: 'tenant',
    }
    assert.equal(keyAllowsVm(tenantVmKeyScope, vmSupA1), true)
    assert.equal(keyAllowsVm(tenantVmKeyScope, vmSupA2), true)

    const resourceVmKeyScope = {
      ...keyScopeFromRequest({
        apiKeyKind: 'managed',
        apiKeyRecord: {
          permission_tier: 'resource',
          owner_id: 'supplier-a',
          group_type: 'all',
          allowed_vms: JSON.stringify(['vm-supa-1']),
        },
      }),
      permission_tier: 'resource',
    }
    assert.equal(keyAllowsVm(resourceVmKeyScope, vmSupA1), true)
    assert.equal(keyAllowsVm(resourceVmKeyScope, vmSupA2), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('write-side anti-escalation guards block cross-owner binding and integration API hides upstream API secrets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-write-iso-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const writeVm = (id, owner) => {
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({ id, name: id, platform: 'anthropic', owner_user_id: owner, status: 'stopped' }),
    )
  }
  writeVm('vm-admin-1', null)
  writeVm('vm-supa-1', 'supplier-a')
  writeVm('vm-supb-1', 'supplier-b')

  try {
    const db = openDatabase({ dbPath: path.join(root, 'vm2api.db') })
    const apiKeyStore = new ApiKeyStore({ db })
    const apiEndpointStore = new ApiEndpointStore({ db })
    const apiScheduler = new ApiScheduler()
    const geminiOwnersRepo = new GeminiOwnersRepo(db)
    geminiOwnersRepo.setOwner('gem-supa-1', 'supplier-a')

    const epAdmin = apiEndpointStore.create({
      name: 'admin-ep',
      kind: 'claude',
      owner_user_id: null,
      api_key_entries: [{ api_key: 'sk-ant-admin-secret-999' }],
    })
    apiScheduler.reload(apiEndpointStore.listRaw())

    const tokenStore = new IntegrationTokenStore({ db, hashSecret: 'test-sec', env: {} })
    const { token } = tokenStore.createToken({ name: 'panel-int', scopes: DEFAULT_INTEGRATION_SCOPES })

    let last = null
    const json = (_res, status, body) => {
      last = { status, body }
    }
    const handlePanel = createPanelHandler({
      getDb: () => db,
      integrationTokenStore: tokenStore,
      geminiOwnersRepo,
      json,
      readBody,
      requireAuth: () => true,
      cfg: { paths: { project: root, data: root, root } },
      routingConfig: { concurrency: { default_key_concurrency: 20 } },
      apiKeyStore,
      apiEndpointStore,
      apiScheduler,
    })
    const handleIntegration = createIntegrationHandler({ tokenStore, handlePanel, json, readBody })

    const call = async (method, reqPath, body) => {
      last = null
      const req = makeReq({
        method,
        url: reqPath,
        headers: { 'x-integration-token': token },
        body,
      })
      await handleIntegration(req, makeRes(), new URL(`http://127.0.0.1${reqPath}`))
      return last
    }

    // 1. Create supplier-owned official API endpoint via integration API; response MUST NOT expose plaintext api_key
    const epRes = await call('POST', '/api/integration/v1/api-endpoints', {
      name: 'sup-a-claude-official',
      kind: 'claude',
      owner_user_id: 'supplier-a',
      api_key_entries: [{ api_key: 'sk-ant-api03-very-secret-supplier-key' }],
    })
    assert.equal(epRes.status, 201)
    assert.equal(epRes.body.ok, true)
    assert.equal(epRes.body.data.owner_user_id, 'supplier-a')
    assert.equal(JSON.stringify(epRes.body).includes('very-secret-supplier-key'), false)
    const epSupAId = epRes.body.data.id

    // 2. Supplier A tenant key (`category: 'all'`, `group_type: 'all'`) succeeds WITHOUT keys:global
    const tenantRes = await call('POST', '/api/integration/v1/api-keys', {
      name: 'sup-a-all',
      permission_tier: 'tenant',
      owner_id: 'supplier-a',
      category: 'all',
      group_type: 'all',
    })
    assert.equal(tenantRes.status, 201)
    assert.equal(tenantRes.body.data.permission_tier, 'tenant')
    assert.equal(tenantRes.body.data.owner_id, 'supplier-a')
    assert.equal(tenantRes.body.data.category, 'all')

    // 3. Supplier A resource key binding its own VM + official API endpoint + Gemini env succeeds
    const resOk = await call('POST', '/api/integration/v1/api-keys', {
      name: 'sup-a-pinned',
      permission_tier: 'resource',
      owner_id: 'supplier-a',
      category: 'all',
      group_type: 'all',
      allowed_vms: ['vm-supa-1'],
      allowed_endpoints: [epSupAId],
      allowed_gemini_envs: ['gem-supa-1'],
    })
    assert.equal(resOk.status, 201)
    assert.deepEqual(resOk.body.data.allowed_vms, ['vm-supa-1'])
    assert.deepEqual(resOk.body.data.allowed_endpoints, [epSupAId])
    assert.deepEqual(resOk.body.data.allowed_gemini_envs, ['gem-supa-1'])

    // 4. Anti-escalation: Supplier A CANNOT bind Admin's official API endpoint -> 403 scope_owner_mismatch
    const escalateEp = await call('POST', '/api/integration/v1/api-keys', {
      name: 'steal-admin-ep',
      permission_tier: 'resource',
      owner_id: 'supplier-a',
      category: 'api',
      group_type: 'all',
      allowed_endpoints: [epAdmin.id],
    })
    assert.equal(escalateEp.status, 403)
    assert.equal(escalateEp.body.error.code, 'scope_owner_mismatch')

    // 5. Anti-escalation: Supplier A CANNOT bind Admin's VM or Supplier B's VM -> 403 scope_owner_mismatch
    const escalateVm = await call('POST', '/api/integration/v1/api-keys', {
      name: 'steal-admin-vm',
      permission_tier: 'resource',
      owner_id: 'supplier-a',
      category: 'oauth',
      group_type: 'anthropic',
      allowed_vms: ['vm-admin-1'],
    })
    assert.equal(escalateVm.status, 403)
    assert.equal(escalateVm.body.error.code, 'scope_owner_mismatch')

    // 6. Reverse anti-escalation: Platform key CANNOT bind Supplier A's official API endpoint -> 403 scope_owner_mismatch
    const adminStealSupA = await call('POST', '/api/integration/v1/api-keys', {
      name: 'admin-steal-supa-ep',
      permission_tier: 'resource',
      category: 'api',
      group_type: 'all',
      allowed_endpoints: [epSupAId],
    })
    assert.equal(adminStealSupA.status, 403)
    assert.equal(adminStealSupA.body.error.code, 'scope_owner_mismatch')

    // 7. Reverse anti-escalation: Platform key CANNOT bind Supplier A's Gemini env -> 403 scope_owner_mismatch
    assert.throws(
      () =>
        assertKeyResourceOwnership({
          vms: [],
          endpoints: [],
          geminiOwnerMap: geminiOwnersRepo.ownerMap(),
          policy: {
            permission_tier: 'resource',
            owner_id: null,
            allowed_vms: [],
            allowed_endpoints: [],
            allowed_gemini_envs: ['gem-supa-1'],
          },
          ownerScope: PLATFORM_SCOPE,
        }),
      (err) => err.code === 'scope_owner_mismatch' && err.status === 403,
    )

    // 8. List & Delete integration keys work via delegated ownership
    const listRes = await call('GET', '/api/integration/v1/api-keys?owner_id=supplier-a')
    assert.equal(listRes.status, 200)
    assert.equal(listRes.body.data.items.length, 2)

    const delRes = await call('DELETE', `/api/integration/v1/api-keys/${resOk.body.data.id}`)
    assert.equal(delRes.status, 200)

    closeDatabase()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
