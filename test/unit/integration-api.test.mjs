import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import {
  DEFAULT_INTEGRATION_SCOPES,
  INTEGRATION_SCOPES,
  IntegrationTokenStore,
  isLoopbackAddress,
} from '../../src/lib/admin/integration-tokens.mjs'
import {
  createIntegrationHandler,
  handleIntegrationAdminRoute,
  INTEGRATION_DELEGATED,
  matchIntegrationRoute,
} from '../../src/lib/admin/integration-routes.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'

function memorySettings() {
  const map = new Map()
  return {
    get(key, fallback = null) {
      return map.has(key) ? structuredClone(map.get(key)) : fallback
    },
    set(key, value) {
      map.set(key, structuredClone(value))
      return value
    },
    has(key) {
      return map.has(key)
    },
    remove(key) {
      map.delete(key)
    },
  }
}

function makeReq({
  method = 'GET',
  path = '/api/integration/v1/ping',
  headers = {},
  remoteAddress = '127.0.0.1',
  body,
} = {}) {
  const chunks = body !== undefined ? [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))] : []
  const req = Readable.from(chunks)
  req.method = method
  req.url = path
  req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  req.socket = { remoteAddress }
  return req
}

function makeRes() {
  return {
    headers: {},
    headersSent: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v
    },
  }
}

test('loopback address detection handles IPv4, IPv6, and IPv4-mapped IPv6 strictly', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.0.1.5'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('10.0.0.5'), false)
  assert.equal(isLoopbackAddress('192.168.1.10'), false)
  assert.equal(isLoopbackAddress('::ffff:10.0.0.5'), false)
  assert.equal(isLoopbackAddress(''), false)
})

test('network boundary blocks non-loopback callers by default and ignores X-Forwarded-For', () => {
  const store = new IntegrationTokenStore({ settings: memorySettings(), hashSecret: 'unit-secret', env: {} })
  const { token } = store.createToken({ name: 'panel-sync' })

  const denied = store.authenticate(
    makeReq({
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '127.0.0.1' },
      remoteAddress: '10.10.0.5',
    }),
  )
  assert.equal(denied.ok, false)
  assert.equal(denied.status, 403)
  assert.equal(denied.code, 'loopback_only')

  // Loopback succeeds
  const local = store.authenticate(
    makeReq({
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: '::ffff:127.0.0.1',
    }),
  )
  assert.equal(local.ok, true)
  assert.equal(local.token.name, 'panel-sync')

  // Remote enabled with allowlist enforces allowed_ips
  store.updateConfig({ allow_remote: true, allowed_ips: ['10.10.0.5'] })
  const allowedRemote = store.authenticate(
    makeReq({
      headers: { 'x-integration-token': token },
      remoteAddress: '::ffff:10.10.0.5',
    }),
  )
  assert.equal(allowedRemote.ok, true)

  const blockedRemote = store.authenticate(
    makeReq({
      headers: { 'x-api-key': token },
      remoteAddress: '10.10.0.99',
    }),
  )
  assert.equal(blockedRemote.ok, false)
  assert.equal(blockedRemote.code, 'ip_not_allowed')
})

test('token lifecycle supports custom auth header, disable, expiration, deletion, and env bootstrap', () => {
  const settings = memorySettings()
  const store = new IntegrationTokenStore({
    settings,
    hashSecret: 'unit-secret',
    env: {
      VM2API_INTEGRATION_TOKEN: 'sk-int-env-bootstrap-token-1234567890abcdef',
      VM2API_INTEGRATION_SCOPES: 'overview:read,vms:read',
    },
  })

  const listed = store.listTokens()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].source, 'env')
  assert.deepEqual(listed[0].scopes, ['overview:read', 'vms:read'])

  store.updateConfig({ custom_auth_header: 'X-Custom-Control-Auth' })
  const envAuth = store.authenticate(
    makeReq({ headers: { 'x-custom-control-auth': 'Bearer sk-int-env-bootstrap-token-1234567890abcdef' } }),
  )
  assert.equal(envAuth.ok, true)
  assert.equal(envAuth.token.id, 'itok_env_default')

  const created = store.createToken({ name: 'ops', scopes: ['vms:read', 'proxies:read'] })
  assert.ok(created.token.startsWith('sk-int-'))
  assert.equal(created.item.name, 'ops')

  // Plaintext is not stored in settings
  const storedRaw = JSON.stringify(settings.get('integration_api_tokens'))
  assert.equal(storedRaw.includes(created.token), false)

  // Disable rejects auth
  store.updateToken(created.item.id, { enabled: false })
  const disabledAuth = store.authenticate(makeReq({ headers: { authorization: `Bearer ${created.token}` } }))
  assert.equal(disabledAuth.ok, false)
  assert.equal(disabledAuth.code, 'integration_token_disabled')

  // Re-enable with past expiry rejects auth
  store.updateToken(created.item.id, { enabled: true, expires_at: new Date(Date.now() - 10_000).toISOString() })
  const expiredAuth = store.authenticate(makeReq({ headers: { authorization: `Bearer ${created.token}` } }))
  assert.equal(expiredAuth.ok, false)
  assert.equal(expiredAuth.code, 'integration_token_expired')

  // Delete removes token
  assert.equal(store.deleteToken(created.item.id), true)
  const deletedAuth = store.authenticate(makeReq({ headers: { authorization: `Bearer ${created.token}` } }))
  assert.equal(deletedAuth.ok, false)
  assert.equal(deletedAuth.code, 'invalid_integration_token')
})

test('allowlist exposes only the five scoped capability domains and blocks sensitive admin paths', () => {
  // Allowed routes
  assert.equal(matchIntegrationRoute('GET', '/api/integration/v1/ping')?.kind, 'ping')
  assert.equal(matchIntegrationRoute('GET', '/api/integration/v1/overview')?.scope, 'overview:read')
  assert.equal(matchIntegrationRoute('GET', '/api/integration/v1/vms')?.scope, 'vms:read')
  assert.equal(matchIntegrationRoute('POST', '/api/integration/v1/vms')?.panelPath, '/api/panel/vms/create')
  assert.equal(matchIntegrationRoute('POST', '/api/integration/v1/vms/vm-01/start')?.scope, 'vms:write')
  assert.equal(matchIntegrationRoute('POST', '/api/integration/v1/vms/vm-01/stop')?.scope, 'vms:write')
  assert.equal(matchIntegrationRoute('DELETE', '/api/integration/v1/vms/vm-01')?.scope, 'vms:write')
  assert.equal(
    matchIntegrationRoute('POST', '/api/integration/v1/vms/vm-01/oauth/auth-url')?.scope,
    'credentials:write',
  )
  assert.equal(
    matchIntegrationRoute('POST', '/api/integration/v1/vms/vm-01/oauth/exchange')?.scope,
    'credentials:write',
  )
  assert.equal(matchIntegrationRoute('POST', '/api/integration/v1/vms/import')?.scope, 'credentials:write')
  assert.equal(matchIntegrationRoute('GET', '/api/integration/v1/gemini/environments')?.panelPath, '/api/panel/gemini')
  assert.equal(matchIntegrationRoute('POST', '/api/integration/v1/gemini/environments')?.scope, 'vms:write')
  assert.equal(matchIntegrationRoute('GET', '/api/integration/v1/api-endpoints')?.scope, 'endpoints:read')
  assert.equal(matchIntegrationRoute('POST', '/api/integration/v1/api-endpoints')?.scope, 'endpoints:write')
  assert.equal(matchIntegrationRoute('DELETE', '/api/integration/v1/api-endpoints/ep_1')?.scope, 'endpoints:write')
  assert.equal(
    matchIntegrationRoute('POST', '/api/integration/v1/gemini/environments/g1/authorization')?.scope,
    'credentials:write',
  )
  assert.equal(
    matchIntegrationRoute('PUT', '/api/integration/v1/gemini/environments/g1/authorization')?.scope,
    'credentials:write',
  )
  assert.equal(matchIntegrationRoute('GET', '/api/integration/v1/proxies')?.scope, 'proxies:read')
  assert.equal(matchIntegrationRoute('POST', '/api/integration/v1/proxies/import')?.scope, 'proxies:write')
  assert.equal(matchIntegrationRoute('POST', '/api/integration/v1/proxies/px-1/probe')?.scope, 'proxies:write')
  assert.equal(matchIntegrationRoute('POST', '/api/integration/v1/proxies/px-1/bind')?.scope, 'proxies:write')
  assert.equal(matchIntegrationRoute('GET', '/api/integration/v1/api-keys')?.scope, 'keys:read')
  assert.equal(matchIntegrationRoute('POST', '/api/integration/v1/api-keys')?.scope, 'keys:write')
  assert.equal(matchIntegrationRoute('DELETE', '/api/integration/v1/api-keys/key_1')?.scope, 'keys:write')

  // Sensitive internal routes MUST NOT match
  const forbidden = [
    ['GET', '/api/integration/v1/users'],
    ['POST', '/api/integration/v1/update'],
    ['GET', '/api/integration/v1/backups'],
    ['GET', '/api/integration/v1/database/metrics'],
    ['GET', '/api/integration/v1/kernels'],
    ['GET', '/api/integration/v1/cluster/nodes'],
    ['POST', '/api/integration/v1/proxies/px-1/reveal'],
    ['POST', '/api/integration/v1/api-keys/key_1/reveal'],
    ['POST', '/api/integration/v1/vms/vm-01/shell-ticket'],
    ['GET', '/api/integration/v1/routing'],
    ['GET', '/api/panel/users'],
  ]
  for (const [m, p] of forbidden) {
    assert.equal(matchIntegrationRoute(m, p), null, `${m} ${p} must not be exposed`)
  }
})

test('integration handler enforces scopes, projects overview, and restricts global API keys', async () => {
  const store = new IntegrationTokenStore({ settings: memorySettings(), hashSecret: 'unit-secret', env: {} })
  const readOnly = store.createToken({ name: 'reader', scopes: ['overview:read', 'proxies:read'] })
  const scopedWriter = store.createToken({ name: 'scoped', scopes: DEFAULT_INTEGRATION_SCOPES })
  const globalWriter = store.createToken({ name: 'global', scopes: INTEGRATION_SCOPES })

  const delegatedCalls = []
  const handlePanel = async (req, res, url) => {
    assert.equal(req[INTEGRATION_DELEGATED], true)
    const parsedBody = req.method !== 'GET' ? await (req._integrationReadBody || readBody)(req) : null
    delegatedCalls.push({ method: req.method, path: url.pathname, body: parsedBody })
    if (url.pathname === '/api/panel/dashboard') {
      res._integrationJson(res, 200, {
        ok: true,
        data: {
          health: { status: 'ok', service: 'vm2api', base_url: 'http://secret-internal' },
          host: { hostname: 'internal-box', pid: 999 },
          routing: { internal: true },
          summary: { vm_count: 2, account_count: 2, today_cost: 12.5 },
          vms: [{ id: 'vm-01', name: 's1', status: 'running', inflight: 3, queue_depth: 1, private_secret: 'nope' }],
          billing: { today: { requests: 40, total_cost: 12.5 }, total: { requests: 100, total_cost: 50 } },
          ops: { tps: 42.3, requests: 40 },
        },
      })
      return true
    }
    if (url.pathname === '/api/panel/api-keys' && req.method === 'POST') {
      res._integrationJson(res, 201, {
        ok: true,
        item: {
          id: 'key_abc',
          name: parsedBody.name,
          key: 'sk-vm-plain-once',
          group_type: parsedBody.group_type,
          allowed_vms: parsedBody.allowed_vms || [],
        },
        note: 'plaintext stays recoverable via POST /api/panel/api-keys/:id/reveal',
      })
      return true
    }
    if (url.pathname === '/api/panel/vms/create') {
      res._integrationJson(res, 201, { ok: true, data: { vm: { id: 'vm-09', name: parsedBody.name } } })
      return true
    }
    return false
  }

  let last = null
  const json = (_res, status, body) => {
    last = { status, body }
  }
  const handler = createIntegrationHandler({ tokenStore: store, handlePanel, json, readBody })

  // 1. Ping works for any valid token
  await handler(
    makeReq({ path: '/api/integration/v1/ping', headers: { authorization: `Bearer ${readOnly.token}` } }),
    makeRes(),
    new URL('http://127.0.0.1/api/integration/v1/ping'),
  )
  assert.equal(last.status, 200)
  assert.equal(last.body.ok, true)
  assert.equal(last.body.data.service, 'vm2api')
  assert.deepEqual(last.body.data.token.scopes, ['overview:read', 'proxies:read'])

  // 2. Overview strips internal host/routing/vm private fields
  await handler(
    makeReq({ path: '/api/integration/v1/overview', headers: { authorization: `Bearer ${readOnly.token}` } }),
    makeRes(),
    new URL('http://127.0.0.1/api/integration/v1/overview'),
  )
  assert.equal(last.status, 200)
  assert.equal(last.body.data.host, undefined)
  assert.equal(last.body.data.routing, undefined)
  assert.equal(last.body.data.vms[0].private_secret, undefined)
  assert.equal(last.body.data.vms[0].inflight, 3)

  // 3. Scope check blocks vms:write for readOnly token
  await handler(
    makeReq({
      method: 'POST',
      path: '/api/integration/v1/vms',
      headers: { authorization: `Bearer ${readOnly.token}` },
      body: { name: 'test', platform: 'anthropic' },
    }),
    makeRes(),
    new URL('http://127.0.0.1/api/integration/v1/vms'),
  )
  assert.equal(last.status, 403)
  assert.equal(last.body.error.code, 'scope_denied')

  // 4. Default token cannot mint unscoped global `all` key
  await handler(
    makeReq({
      method: 'POST',
      path: '/api/integration/v1/api-keys',
      headers: { authorization: `Bearer ${scopedWriter.token}` },
      body: { name: 'bad-global', group_type: 'all' },
    }),
    makeRes(),
    new URL('http://127.0.0.1/api/integration/v1/api-keys'),
  )
  assert.equal(last.status, 403)
  assert.equal(last.body.error.code, 'scope_denied')

  // 5. Default token CAN mint VM-scoped key; response envelope unwraps item and hides panel reveal note
  await handler(
    makeReq({
      method: 'POST',
      path: '/api/integration/v1/api-keys',
      headers: { authorization: `Bearer ${scopedWriter.token}` },
      body: { name: 'scoped-k', group_type: 'anthropic', allowed_vms: ['vm-01'], injected_admin_field: 'drop-me' },
    }),
    makeRes(),
    new URL('http://127.0.0.1/api/integration/v1/api-keys'),
  )
  assert.equal(last.status, 201)
  assert.equal(last.body.ok, true)
  assert.equal(last.body.note, undefined)
  assert.equal(last.body.data.key, 'sk-vm-plain-once')
  assert.deepEqual(last.body.data.allowed_vms, ['vm-01'])
  assert.equal(delegatedCalls.at(-1).body.injected_admin_field, undefined)

  // 6. Token with keys:global CAN mint global key
  await handler(
    makeReq({
      method: 'POST',
      path: '/api/integration/v1/api-keys',
      headers: { authorization: `Bearer ${globalWriter.token}` },
      body: { name: 'global-k', group_type: 'all' },
    }),
    makeRes(),
    new URL('http://127.0.0.1/api/integration/v1/api-keys'),
  )
  assert.equal(last.status, 201)
  assert.equal(last.body.data.group_type, 'all')

  // 7. VM create strips non-whitelisted internal fields
  await handler(
    makeReq({
      method: 'POST',
      path: '/api/integration/v1/vms',
      headers: { authorization: `Bearer ${scopedWriter.token}` },
      body: { name: 'slot-a', platform: 'anthropic', node_id: 'node-secret', reserved_inventory: true },
    }),
    makeRes(),
    new URL('http://127.0.0.1/api/integration/v1/vms'),
  )
  assert.equal(last.status, 201)
  assert.equal(delegatedCalls.at(-1).body.node_id, undefined)
  assert.equal(delegatedCalls.at(-1).body.reserved_inventory, undefined)
})

test('panel ACL restricts /api/panel/integration/* strictly to admin role and admin route manages tokens', async () => {
  for (const [m, p] of [
    ['GET', '/api/panel/integration/config'],
    ['PUT', '/api/panel/integration/config'],
    ['GET', '/api/panel/integration/tokens'],
    ['POST', '/api/panel/integration/tokens'],
    ['DELETE', '/api/panel/integration/tokens/itok_123'],
  ]) {
    assert.equal(authorizePanelRoute(m, p, 'user').ok, false, `user must be denied ${m} ${p}`)
    assert.equal(authorizePanelRoute(m, p, 'super').ok, false, `super must be denied ${m} ${p}`)
    assert.equal(authorizePanelRoute(m, p, 'admin').ok, true, `admin must be allowed ${m} ${p}`)
  }

  const store = new IntegrationTokenStore({ settings: memorySettings(), hashSecret: 'unit-secret', env: {} })
  let last = null
  const json = (_res, status, body) => {
    last = { status, body }
  }

  await handleIntegrationAdminRoute(
    makeReq({
      method: 'POST',
      path: '/api/panel/integration/tokens',
      body: { name: 'ext-console', scopes: ['overview:read'] },
    }),
    makeRes(),
    '/api/panel/integration/tokens',
    { tokenStore: store, json, readBody },
  )
  assert.equal(last.status, 201)
  assert.ok(last.body.data.token.startsWith('sk-int-'))
  const id = last.body.data.item.id

  await handleIntegrationAdminRoute(
    makeReq({
      method: 'PUT',
      path: '/api/panel/integration/config',
      body: { allow_remote: true, allowed_ips: ['10.0.0.2'] },
    }),
    makeRes(),
    '/api/panel/integration/config',
    { tokenStore: store, json, readBody },
  )
  assert.equal(last.status, 200)
  assert.equal(last.body.data.allow_remote, true)
  assert.deepEqual(last.body.data.allowed_ips, ['10.0.0.2'])

  await handleIntegrationAdminRoute(
    makeReq({ method: 'DELETE', path: `/api/panel/integration/tokens/${id}` }),
    makeRes(),
    `/api/panel/integration/tokens/${id}`,
    { tokenStore: store, json, readBody },
  )
  assert.equal(last.status, 200)
  assert.equal(last.body.data.deleted, id)
})
