import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { callGeminiHost, createGeminiPanelHandler } from '../../src/lib/gemini/routes.mjs'

const root = '/api/panel/gemini'
const baseEnv = {
  id: 'gemini-route-fix',
  proxy_id: 'px-platform',
  name: 'Route Fix Env',
  auth_state: 'authorized',
  auth_method: 'oauth',
}

function makePanel({ proxies = [], callHost, owners = new Map() }) {
  const response = { setHeader() {} }
  const proxyPool = () => ({
    snapshot: ({ ownerUserId = null } = {}) => ({
      proxies: proxies.filter((p) => {
        const pOwner = p.owner_user_id || null
        return ownerUserId ? pOwner === ownerUserId : !pOwner
      }),
    }),
    getProxyByIdWithAuth: (id) => {
      const hit = proxies.find((p) => p.id === id)
      return hit ? { ...hit, url: hit.url } : null
    },
  })
  const geminiOwnersRepo = {
    getOwner: (id) => owners.get(id) ?? null,
    setOwner: (id, owner) => owners.set(id, owner),
    remove: (id) => owners.delete(id),
  }
  const panel = createGeminiPanelHandler({
    json: (_res, status, body) => ({ status, body }),
    readBody: async (req) => req.body,
    proxyPool,
    geminiOwnersRepo,
    callHost,
  })
  return (method, pathname, body) => panel({ method, pathname, body }, response, pathname)
}

test('POST /environments forwards Format 1 & Format 2 metadata (oauth_client_key, is_gcp_tos, project_id) and multi-account index', async () => {
  const calls = []
  const run = makePanel({
    proxies: [
      {
        id: 'px-platform',
        enabled: true,
        status: 'ok',
        owner_user_id: null,
        url: 'http://user:pass@proxy.example.com:8080',
        domain_forward: true,
        dns_disable_svcb_https: true,
      },
    ],
    callHost: (operation, payload) => {
      calls.push({ operation, payload })
      return { ...baseEnv, proxy_id: payload.proxy_id, name: payload.name }
    },
  })

  // Format 1: bare array `[{ email, refresh_token }]`
  const r1 = await run('POST', `${root}/environments`, {
    name: 'fmt1',
    proxy_id: 'px-platform',
    oauth_account: [{ email: 'u1@gmail.com', refresh_token: '1//06M_Format1Token_abc' }],
  })
  assert.equal(r1.status, 200)
  assert.deepEqual(calls.at(-1).payload.oauth_account, {
    refresh_token: '1//06M_Format1Token_abc',
  })
  assert.equal(calls.at(-1).payload.proxy_url, 'http://user:pass@proxy.example.com:8080')
  assert.deepEqual(calls.at(-1).payload.egress_options, {
    domain_forward: true,
    dns_empty_types: [64, 65],
  })

  // Format 2: `{ schema_version: 2, accounts: [{ email, refresh_token, oauth_client_key, is_gcp_tos, project_id }] }`
  const r2 = await run('POST', `${root}/environments`, {
    name: 'fmt2',
    proxy_id: 'px-platform',
    oauth_account: {
      schema_version: 2,
      accounts: [
        {
          email: 'u2@gmail.com',
          refresh_token: '1//06Q_Format2Token_xyz',
          oauth_client_key: 'antigravity_enterprise',
          is_gcp_tos: false,
          project_id: 'aicode-consumers',
        },
        {
          email: 'u3@gmail.com',
          refresh_token: '1//06R_SecondAccount_999',
          oauth_client_key: 'consumer',
          is_gcp_tos: true,
          project_id: 'proj-second',
        },
      ],
    },
  })
  assert.equal(r2.status, 200)
  assert.deepEqual(calls.at(-1).payload.oauth_account, {
    refresh_token: '1//06Q_Format2Token_xyz',
    oauth_client_key: 'antigravity_enterprise',
    is_gcp_tos: false,
    project_id: 'aicode-consumers',
  })

  // Multi-account explicit `oauth_account_index: 1`
  const r3 = await run('POST', `${root}/environments`, {
    name: 'fmt2-second',
    proxy_id: 'px-platform',
    oauth_account_index: 1,
    oauth_account: {
      schema_version: 2,
      accounts: [
        { email: 'u2@gmail.com', refresh_token: '1//06Q_Format2Token_xyz' },
        {
          email: 'u3@gmail.com',
          refresh_token: '1//06R_SecondAccount_999',
          oauth_client_key: 'consumer',
          is_gcp_tos: true,
          project_id: 'proj-second',
        },
      ],
    },
  })
  assert.equal(r3.status, 200)
  assert.deepEqual(calls.at(-1).payload.oauth_account, {
    refresh_token: '1//06R_SecondAccount_999',
    oauth_client_key: 'consumer',
    is_gcp_tos: true,
    project_id: 'proj-second',
  })
})

test('PUT /environments/:id/proxy forwards egress_options and enforces tenant proxy ownership consistently', async () => {
  const calls = []
  const owners = new Map([['gemini-tenant-env', 'user-42']])
  const run = makePanel({
    owners,
    proxies: [
      {
        id: 'px-platform',
        enabled: true,
        status: 'ok',
        owner_user_id: null,
        url: 'socks5://198.51.100.10:1080',
      },
      {
        id: 'px-tenant-http',
        enabled: true,
        status: 'ok',
        owner_user_id: 'user-42',
        url: 'http://tenant:secret@us.proxy.example.com:8080',
        domain_forward: true,
        dns_disable_svcb_https: true,
      },
      {
        id: 'px-other-tenant',
        enabled: true,
        status: 'ok',
        owner_user_id: 'user-99',
        url: 'socks5://198.51.100.99:1080',
      },
    ],
    callHost: (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'get') {
        return { ...baseEnv, id: payload.id, proxy_id: 'px-platform' }
      }
      return { ...baseEnv, id: payload.id, proxy_id: payload.proxy_id }
    },
  })

  // Tenant-owned env can bind its own HTTP + domain proxy and forwards egress_options
  const okRebind = await run('PUT', `${root}/environments/gemini-tenant-env/proxy`, {
    proxy_id: 'px-tenant-http',
  })
  assert.equal(okRebind.status, 200)
  const bindCall = calls.find((c) => c.operation === 'proxy-bind')
  assert.ok(bindCall)
  assert.deepEqual(bindCall.payload, {
    id: 'gemini-tenant-env',
    previous_proxy_id: 'px-platform',
    proxy_id: 'px-tenant-http',
    proxy_url: 'http://tenant:secret@us.proxy.example.com:8080',
    egress_options: {
      domain_forward: true,
      dns_empty_types: [64, 65],
    },
  })

  // Tenant-owned env cannot bind another tenant's proxy
  const otherTenant = await run('PUT', `${root}/environments/gemini-tenant-env/proxy`, {
    proxy_id: 'px-other-tenant',
  })
  assert.equal(otherTenant.status, 409)
  assert.equal(otherTenant.body.error.code, 'gemini_proxy_unavailable')

  // Platform env cannot bind a tenant's proxy
  const platformUsingTenant = await run('PUT', `${root}/environments/gemini-route-fix/proxy`, {
    proxy_id: 'px-tenant-http',
  })
  assert.equal(platformUsingTenant.status, 409)
  assert.equal(platformUsingTenant.body.error.code, 'gemini_proxy_unavailable')
})

test('POST /environments/:id/models returns call_models/models and preserves structured 401/403/409/429 errors from control.sock', async () => {
  // 1. Direct callHost mock returning call_models
  const runModels = makePanel({
    proxies: [
      {
        id: 'px-platform',
        enabled: true,
        status: 'ok',
        owner_user_id: null,
        url: 'socks5://198.51.100.10:1080',
      },
    ],
    callHost: (operation) => {
      if (operation === 'get') return baseEnv
      return {
        ...baseEnv,
        call_models: ['gemini-2.5-pro', 'gemini-3-flash'],
      }
    },
  })
  const okModels = await runModels('POST', `${root}/environments/${baseEnv.id}/models`)
  assert.equal(okModels.status, 200)
  assert.deepEqual(okModels.body.data.models, ['gemini-2.5-pro', 'gemini-3-flash'])
  assert.deepEqual(okModels.body.data.call_models, ['gemini-2.5-pro', 'gemini-3-flash'])
  assert.equal(okModels.body.data.models_discovered, true)

  // 2. Real UDS socket test (on Linux x64) verifying hostRequest status/code propagation
  if (process.platform === 'linux' && process.arch === 'x64') {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-gemini-sock-'))
    const sockPath = path.join(tmpDir, 'control.sock')
    let nextModelsError = { status: 403, body: { code: 'gemini_location_unsupported' } }
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (req.url === '/get') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(baseEnv))
          return
        }
        res.writeHead(nextModelsError.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(nextModelsError.body))
      })
    })
    await new Promise((resolve) => server.listen(sockPath, resolve))
    const prevSock = process.env.KIN_GEMINI_HOST_SOCKET
    process.env.KIN_GEMINI_HOST_SOCKET = sockPath
    try {
      const runViaSocket = makePanel({
        proxies: [
          {
            id: 'px-platform',
            enabled: true,
            status: 'ok',
            owner_user_id: null,
            url: 'socks5://198.51.100.10:1080',
          },
        ],
        callHost: callGeminiHost,
      })

      // 401 without code -> mapped to gemini_oauth_required (409), NOT 502/503
      nextModelsError = { status: 401, body: {} }
      const r401 = await runViaSocket('POST', `${root}/environments/${baseEnv.id}/models`)
      assert.equal(r401.status, 409)
      assert.equal(r401.body.error.code, 'gemini_oauth_required')

      // 403 known code -> preserved as 403
      nextModelsError = { status: 403, body: { code: 'gemini_location_unsupported' } }
      const r403 = await runViaSocket('POST', `${root}/environments/${baseEnv.id}/models`)
      assert.equal(r403.status, 403)
      assert.equal(r403.body.error.code, 'gemini_location_unsupported')

      // 403 without code -> mapped to gemini_account_ineligible (403) instead of 502/503
      nextModelsError = { status: 403, body: {} }
      const r403Bare = await runViaSocket('POST', `${root}/environments/${baseEnv.id}/models`)
      assert.equal(r403Bare.status, 403)
      assert.equal(r403Bare.body.error.code, 'gemini_account_ineligible')

      // 409 known code -> preserved as 409
      nextModelsError = { status: 409, body: { code: 'gemini_oauth_required' } }
      const r409 = await runViaSocket('POST', `${root}/environments/${baseEnv.id}/models`)
      assert.equal(r409.status, 409)
      assert.equal(r409.body.error.code, 'gemini_oauth_required')

      // 429 known code -> preserved as 429
      nextModelsError = { status: 429, body: { code: 'gemini_quota_exhausted' } }
      const r429 = await runViaSocket('POST', `${root}/environments/${baseEnv.id}/models`)
      assert.equal(r429.status, 429)
      assert.equal(r429.body.error.code, 'gemini_quota_exhausted')
    } finally {
      if (prevSock === undefined) delete process.env.KIN_GEMINI_HOST_SOCKET
      else process.env.KIN_GEMINI_HOST_SOCKET = prevSock
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }
})
