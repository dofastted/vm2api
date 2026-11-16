import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import { AGY_SHA256, installGeminiPayload, readSignedGeminiManifest } from '../../src/lib/gemini/payload.mjs'
import {
  createGeminiPanelHandler,
  geminiBillingUnavailable,
  officialGeminiAuthUrl,
} from '../../src/lib/gemini/routes.mjs'

const root = '/api/panel/gemini'
const official =
  'https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&code_challenge_method=S256&state=fixture&code_challenge=fixture'
const record = { id: 'gemini-fixture', proxy_id: 'px-fixture', name: 'Fixture', auth_state: 'unverified' }
const bound = { id: record.proxy_id, enabled: true, status: 'ok', owner_user_id: null }

function setup(callHost, proxy = bound) {
  const response = { setHeader() {} }
  const panel = createGeminiPanelHandler({
    json: (_response, status, body) => ({ status, body }),
    readBody: async (req, maxBytes) => {
      assert.equal(maxBytes, 4096)
      return req.body
    },
    proxyPool: () => ({
      snapshot: () => ({ proxies: [proxy] }),
      getProxyByIdWithAuth: () => ({ url: 'socks5://fixture:private@192.0.2.11:1080' }),
    }),
    callHost,
  })
  return (method, pathname, body) => panel({ method, body }, response, pathname)
}

test('Gemini import is admin-only and unavailable without the host service', async () => {
  assert.equal(authorizePanelRoute('GET', root, 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', `${root}/environments`, 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', `${root}/environments/${record.id}/refresh`, 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', `${root}/environments`, 'admin').ok, true)
  const run = setup(() => {
    throw new Error('private socket path')
  })
  const result = await run('GET', root)
  assert.deepEqual(result, { status: 200, body: { ok: true, data: { available: false, environments: [] } } })
})

test('reachable Gemini host reports lazy install without dependencies on an existing environment', async () => {
  const run = setup(() => ({ payload_state: 'install_on_create', environments: [] }))
  assert.deepEqual((await run('GET', root)).body.data, {
    available: true,
    payload_state: 'install_on_create',
    environments: [],
  })
  const invalidPayload = setup(() => {
    throw Object.assign(new Error(), { code: 'gemini_payload_invalid' })
  })
  const result = await invalidPayload('POST', `${root}/environments`, { name: record.name, proxy_id: record.proxy_id })
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'gemini_payload_invalid')
})

test('only explicit platform SOCKS5 environments are created and credentials stay private', async () => {
  const create = { name: 'Fixture', proxy_id: record.proxy_id }
  const run = setup((operation, payload) => {
    assert.equal(operation, 'create')
    assert.deepEqual(payload, { ...create, proxy_url: 'socks5h://fixture:private@192.0.2.11:1080' })
    return { ...record, proxy_url: payload.proxy_url, billing_ready: true }
  })
  const result = await run('POST', `${root}/environments`, create)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.data, {
    ...record,
    auth_method: 'oauth',
    kernel_version: null,
    account: null,
    created_at: null,
    updated_at: null,
    runtime_ready: false,
    models: [],
    billing_ready: false,
  })
  for (const proxy of [
    { ...bound, enabled: false },
    { ...bound, owner_user_id: 'tenant' },
    { ...bound, status: 'dead' },
  ]) {
    const blocked = setup(() => assert.fail('unavailable proxy must not reach the host'), proxy)
    assert.equal((await blocked('POST', `${root}/environments`, create)).status, 409)
  }
})

test('API key import returns only approved account and quota fields', async () => {
  const secret = 'AIza-fixture-never-returned'
  const create = { name: record.name, proxy_id: record.proxy_id, auth_method: 'api_key', api_key: secret }
  const run = setup((operation, payload) => {
    assert.equal(operation, 'create')
    assert.equal(payload.api_key, secret)
    assert.equal(payload.auth_method, 'api_key')
    assert.equal(payload.proxy_url, 'socks5h://fixture:private@192.0.2.11:1080')
    return {
      ...record,
      auth_method: 'api_key',
      auth_state: 'authorized',
      api_key: secret,
      models: ['gemini-3.1-pro'],
      account: {
        state: 'ok',
        access_token: secret,
        email: 'fixture@example.test',
        quotas: [
          { model: 'gemini-3.1-pro', remaining_fraction: 0, token: secret },
          { model: 'gemini-3.1-pro', remaining_fraction: 3 },
        ],
        credits: [{ type: 'AI', amount: '0', raw: secret }],
      },
    }
  })
  const result = await run('POST', `${root}/environments`, create)
  assert.equal(result.status, 200)
  assert.equal(result.body.data.account.email, 'fixture@example.test')
  assert.deepEqual(result.body.data.account.quotas, [
    { model: 'gemini-3.1-pro', remaining_fraction: 0, reset_at: null },
  ])
  assert.deepEqual(result.body.data.account.credits, [{ type: 'AI', amount: '0' }])
  assert.equal(result.body.data.billing_ready, false)
  assert.doesNotMatch(JSON.stringify(result.body), new RegExp(secret))
  assert.equal((await run('POST', `${root}/environments`, { ...create, api_key: 'invalid' })).status, 400)
})

test('official login links are validated and code is returned only to its selected environment', async () => {
  assert.equal(officialGeminiAuthUrl(official), official)
  assert.equal(officialGeminiAuthUrl(official.replace('accounts.google.com', 'accounts.google.com.example.test')), null)
  assert.equal(officialGeminiAuthUrl(official.replace('antigravity.google', 'example.test')), null)
  const auth = `${root}/environments/${record.id}/authorization`
  const operations = []
  const run = setup((operation, payload) => {
    operations.push(operation)
    assert.equal(payload.id, record.id)
    if (operation === 'get') return record
    assert.equal(payload.proxy_id, record.proxy_id)
    if (operation === 'authorize') return { url: official, attempt_id: 'login-fixture' }
    assert.equal(payload.attempt_id, 'login-fixture')
    assert.equal(payload.code, 'fixture/code')
    if (operations.length > 4) assert.equal(payload.state, 'fixture')
    return { ...record, auth_state: 'authorizing' }
  })
  assert.deepEqual((await run('POST', auth)).body.data, { url: official, attempt_id: 'login-fixture' })
  assert.equal((await run('PUT', auth, { attempt_id: 'login-fixture', code: 'fixture\n/quit' })).status, 400)
  const result = await run('PUT', auth, { attempt_id: 'login-fixture', code: 'fixture/code' })
  assert.equal(result.body.data.auth_state, 'authorizing')
  assert.deepEqual(operations, ['get', 'authorize', 'get', 'complete'])
  assert.equal(
    (
      await run('PUT', auth, {
        attempt_id: 'login-fixture',
        code: 'https://antigravity.google/oauth-callback?code=fixture%2Fcode&state=fixture',
      })
    ).status,
    200,
  )
  assert.equal(
    (
      await run('PUT', auth, {
        attempt_id: 'login-fixture',
        code: 'https://antigravity.google/oauth-callback?code=one&code=two&state=fixture',
      })
    ).status,
    400,
  )
})

test('missing official settlement cannot be enabled by a host response or a paid route request', () => {
  const result = geminiBillingUnavailable((_res, status, body) => ({ status, body }), { setHeader() {} })
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'gemini_official_billing_unavailable')
})

test('host installer refuses an unsigned manifest and never activates damaged payload members', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gemini-payload-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source')
  const destination = path.join(directory, 'installed')
  await mkdir(source)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const verificationKey = publicKey.export({ type: 'spki', format: 'pem' })
  const sum = (value) => createHash('sha256').update(value).digest('hex')
  const manifest = {
    schema: 1,
    platform: 'linux-amd64',
    version: '0.3.0-rc.1',
    files: [
      { name: 'craggemini', size: 3, sha256: sum('elf') },
      { name: 'libagy_bridge.so', size: 3, sha256: sum('lib') },
      { name: 'agy', size: 3, sha256: AGY_SHA256 },
    ],
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const signature = sign(null, manifestBytes, privateKey)
  await writeFile(path.join(source, 'manifest.json'), manifestBytes)
  await writeFile(path.join(source, 'manifest.sig'), Buffer.alloc(64))
  await assert.rejects(readSignedGeminiManifest(source, verificationKey), /gemini_payload_invalid_signature/)
  await writeFile(path.join(source, 'manifest.sig'), signature)
  assert.equal((await readSignedGeminiManifest(source, verificationKey)).manifest.version, '0.3.0-rc.1')
  await writeFile(path.join(source, 'craggemini'), 'elf')
  await writeFile(path.join(source, 'libagy_bridge.so'), 'bad')
  await assert.rejects(installGeminiPayload(source, destination, verificationKey), /gemini_payload_member_mismatch/)
  await assert.rejects(writeFile(path.join(destination, 'unexpected'), 'no'), { code: 'ENOENT' })
})
