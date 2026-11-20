import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import { dispatchGeminiNativeTurn, prepareGeminiNativeTurn } from '../../src/lib/gemini/native-turn.mjs'
import { AGY_SHA256, installGeminiPayload, readSignedGeminiManifest } from '../../src/lib/gemini/payload.mjs'
import {
  createGeminiPanelHandler,
  geminiKeyAllowsPath,
  handleGeminiPublic,
  officialGeminiAuthUrl,
} from '../../src/lib/gemini/routes.mjs'

const root = '/api/panel/gemini'
const official =
  'https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&code_challenge_method=S256&state=fixture&code_challenge=fixture'
const record = { id: 'gemini-fixture', proxy_id: 'px-fixture', name: 'Fixture', auth_state: 'unverified' }
const bound = { id: record.proxy_id, enabled: true, status: 'ok', owner_user_id: null }
const environmentPath = `${root}/environments/${record.id}`
const proxyUrl = 'socks5h://fixture:private@192.0.2.11:1080'
const runId = '0123456789abcdef0123456789abcdef'
const model = 'gemini-3-pro'

test('Gemini, Anthropic and OpenAI text inputs produce the same native turn envelope', () => {
  const model = 'gemini-3.1-pro'
  const requestId = 'turn-01'
  const text = '  你好\nworld  '
  const expected = {
    request_id: requestId,
    stream: true,
    body: { model, contents: [{ role: 'user', parts: [{ text }] }] },
  }
  for (const [protocol, body] of [
    ['gemini', { contents: [{ parts: [{ text: '  你好\n' }, { text: 'world  ' }] }] }],
    ['anthropic', { model, stream: true, messages: [{ role: 'user', content: [{ type: 'text', text }] }] }],
    ['openai-chat', { model, stream: true, messages: [{ role: 'user', content: text }] }],
    [
      'openai-responses',
      { model, stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] },
    ],
    ['openai-responses', { model, stream: true, input: text }],
  ]) {
    assert.deepEqual(prepareGeminiNativeTurn({ protocol, body, model, requestId, stream: true }), expected)
  }
})

test('native turn conversion rejects unsupported fields, turns, and unsafe text before dispatch', () => {
  const model = 'gemini-3.1-pro'
  const requestId = 'turn-01'
  const user = { role: 'user', content: 'hello' }
  const valid = { model, stream: true, messages: [user] }
  const turn = (body, options) =>
    prepareGeminiNativeTurn({ protocol: 'openai-chat', body, model, requestId, ...options })
  for (const body of [
    { ...valid, stream: false },
    { ...valid, stream: undefined },
    { ...valid, model: 'other' },
    { ...valid, temperature: 0 },
    { ...valid, tools: [] },
    { ...valid, messages: [{ role: 'system', content: 'do not drop' }, user] },
    { ...valid, messages: [user, user] },
    { ...valid, messages: [{ ...user, name: 'caller' }] },
    { ...valid, messages: [{ ...user, content: [{ type: 'image_url', image_url: {} }] }] },
    ...[' \t', 'hello\u0085/quit', 'hello\0world'].map((content) => ({ ...valid, messages: [{ ...user, content }] })),
  ]) {
    assert.throws(() => turn(body), { status: 400, code: 'gemini_unsupported_turn' })
  }
  assert.throws(() => turn(valid, { requestId: '../bad' }), { status: 400 })
  assert.throws(() => turn(valid, { stream: false }), { status: 400 })
  assert.throws(() => turn({ ...valid, messages: [{ ...user, content: '中'.repeat(90000) }] }), { status: 413 })
  assert.throws(
    () =>
      turn(
        { contents: [{ parts: [{ text: 'hello', thoughtSignature: 'preserve-or-reject' }] }] },
        { protocol: 'gemini', stream: true },
      ),
    { status: 400 },
  )
})

test('the native transport uses the internal Unix socket and returns Gemini SSE verbatim', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gemini-turn-'))
  const socketPath = path.join(directory, 'kernel.sock')
  const internalToken = 'internal-fixture-not-a-secret'
  const turn = {
    socketPath,
    internalToken,
    protocol: 'gemini',
    model: 'gemini-pro',
    requestId: 'turn-01',
    stream: true,
    body: { contents: [{ parts: [{ text: 'hello' }] }] },
  }
  const sse = ': heartbeat\r\n\r\ndata: {"candidates":[{"finishReason":"STOP"}]}\r\n\r\n'
  const received = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received.push([
      request.method,
      request.url,
      request.headers['x-kin-internal-token'],
      JSON.parse(Buffer.concat(chunks)),
    ])
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(sse)
  })
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  await assert.rejects(dispatchGeminiNativeTurn({ ...turn, body: { ...turn.body, tools: [] } }), { status: 400 })
  const response = await dispatchGeminiNativeTurn({ ...turn, signal: AbortSignal.timeout(5000) })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'text/event-stream')
  const chunks = []
  for await (const chunk of response) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).toString(), sse)
  assert.deepEqual(received, [['POST', '/internal/v1/messages', internalToken, prepareGeminiNativeTurn(turn)]])
})

function setup(callHost, proxy = bound) {
  const response = { setHeader() {} }
  const panel = createGeminiPanelHandler({
    json: (_response, status, body) => ({ status, body }),
    readBody: async (req) => req.body,
    proxyPool: () => ({
      snapshot: ({ ownerUserId }) => {
        assert.equal(ownerUserId, null)
        return { proxies: [proxy] }
      },
      getProxyByIdWithAuth: (id) => (id === proxy.id ? { url: proxyUrl } : null),
    }),
    callHost,
  })
  return (method, pathname, body) => panel({ method, pathname, body }, response, pathname)
}

test('Gemini import is admin-only and unavailable without the host service', async () => {
  assert.equal(authorizePanelRoute('GET', root, 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', `${root}/environments`, 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', `${root}/environments/${record.id}/refresh`, 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', `${root}/environments`, 'admin').ok, true)
  for (const [method, suffix] of [
    ['POST', 'proxy/probe'],
    ['PUT', 'proxy'],
    ['POST', 'models'],
    ['POST', 'test-chat'],
    ['GET', `test-chat/${runId}`],
    ['DELETE', `test-chat/${runId}`],
  ]) {
    for (const [role, allowed] of [
      ['user', false],
      ['super', false],
      ['admin', true],
    ]) {
      assert.equal(authorizePanelRoute(method, `${environmentPath}/${suffix}`, role).ok, allowed)
    }
  }
  const run = setup(() => {
    throw new Error('private socket path')
  })
  const result = await run('GET', root)
  assert.equal(result.status, 200)
  assert.equal(result.body.data.available, false)
  assert.equal(result.body.data.host_error, 'gemini_host_unavailable')
  assert.deepEqual(result.body.data.environments, [])
  assert.doesNotMatch(JSON.stringify(result), /private socket path/)
})

test('unknown Gemini payload status is not installed and proxy failures do not hide inventory', async () => {
  const run = setup(() => ({ payload_state: 'unexpected', payload_issue: 'private', environments: [record] }), {
    ...bound,
    enabled: false,
  })
  const { body } = await run('GET', root)
  assert.equal(body.data.available, true)
  assert.equal(body.data.payload_state, 'unknown')
  assert.equal(body.data.payload_issue, null)
  assert.equal(body.data.environments[0].proxy_ready, false)
})

test('Gemini payload redemption is admin-only and rejects malformed codes before host dispatch', async () => {
  const route = `${root}/payload/redeem`
  assert.equal(authorizePanelRoute('POST', route, 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', route, 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', route, 'admin').ok, true)
  const blocked = setup(() => assert.fail('malformed code must not reach the host'))
  assert.equal((await blocked('POST', route, { redemption_code: 'CGG1-invalid' })).status, 400)
})

test('Gemini inventory distinguishes a missing socket from an invalid host response', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gemini-host-'))
  const socketPath = path.join(directory, 'control.sock')
  const server = http.createServer((_request, response) => response.end('<html>unexpected</html>'))
  const previous = process.env.KIN_GEMINI_HOST_SOCKET
  process.env.KIN_GEMINI_HOST_SOCKET = socketPath
  const run = createGeminiPanelHandler({ json: (_response, _status, body) => body })
  const status = async () => (await run({ method: 'GET' }, { setHeader() {} }, root)).data.host_error
  try {
    assert.equal(await status(), 'gemini_host_socket_missing')
    await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve))
    assert.equal(await status(), 'gemini_host_protocol_error')
  } finally {
    if (previous === undefined) delete process.env.KIN_GEMINI_HOST_SOCKET
    else process.env.KIN_GEMINI_HOST_SOCKET = previous
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('reachable Gemini host reports lazy install without dependencies on an existing environment', async () => {
  const run = setup(() => ({ payload_state: 'install_on_create', environments: [] }))
  const { body } = await run('GET', root)
  assert.equal(body.data.available, true)
  assert.equal(body.data.payload_state, 'install_on_create')
  assert.deepEqual(body.data.environments, [])
  const invalidPayload = setup(() => {
    throw Object.assign(new Error(), { code: 'gemini_payload_invalid' })
  })
  const result = await invalidPayload('POST', `${root}/environments`, { name: record.name, proxy_id: record.proxy_id })
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'gemini_payload_invalid')
})

test('Gemini host reports an unredeemed installation source separately from runtime', async () => {
  const run = setup(() => ({ payload_state: 'awaiting_redemption', release_activated: false, environments: [] }))
  assert.deepEqual((await run('GET', root)).body.data, {
    available: true,
    payload_state: 'awaiting_redemption',
    payload_issue: null,
    release_activated: false,
    oauth_runtime_issue: null,
    environments: [],
  })
  const invalidPayload = setup(() => {
    throw Object.assign(new Error(), { code: 'gemini_payload_invalid' })
  })
  const result = await invalidPayload('POST', `${root}/environments`, { name: record.name, proxy_id: record.proxy_id })
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'gemini_payload_invalid')
})

test('Gemini redemption rejects Google codes and reports a different signed release as conflict', async () => {
  let count = 0
  const run = setup(() => {
    count++
    throw Object.assign(new Error('private information'), { code: 'gemini_release_payload_mismatch' })
  })
  const endpoint = `${root}/payload/redeem`
  const invalid = await run('POST', endpoint, { redemption_code: '4/google-oauth-code' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'gemini_release_code_invalid')
  assert.equal(count, 0)
  const mismatch = await run('POST', endpoint, { redemption_code: `CGG1-${'A'.repeat(43)}` })
  assert.equal(mismatch.status, 409)
  assert.doesNotMatch(JSON.stringify(mismatch), /private information/)
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

test('only a probe may use its currently bound enabled proxy with failed health', async () => {
  for (const status of ['fail', 'dead']) {
    const operations = []
    const run = setup(
      (operation, payload) => {
        operations.push([operation, payload])
        return operation === 'get' ? record : { ok: false, latency_ms: 14, code: 'private', detail: proxyUrl }
      },
      { ...bound, status },
    )
    const probe = await run('POST', `${environmentPath}/proxy/probe`, { proxy_id: 'untrusted', proxy_url: 'untrusted' })
    assert.deepEqual(probe, {
      status: 200,
      body: { ok: true, data: { ok: false, latency_ms: 14, code: 'gemini_proxy_probe_failed' } },
    })
    assert.deepEqual(operations, [
      ['get', { id: record.id }],
      ['proxy-probe', { id: record.id, proxy_id: bound.id, proxy_url: proxyUrl }],
    ])
    const blocked = [
      await run('PUT', `${environmentPath}/proxy`, { proxy_id: bound.id }),
      await run('POST', `${environmentPath}/models`),
      await run('POST', `${environmentPath}/test-chat`, { model, prompt: 'ping' }),
    ]
    assert.ok(blocked.every(({ status, body }) => status === 409 && body.error.code === 'gemini_proxy_unavailable'))
    assert.deepEqual(
      operations.slice(2).map(([operation]) => operation),
      ['get', 'get', 'get'],
    )
  }
  for (const proxy of [
    { ...bound, enabled: false },
    { ...bound, owner_user_id: 'tenant' },
    { ...bound, blocked_reason: 'ipv6_disabled' },
  ]) {
    const run = setup((operation) => {
      assert.equal(operation, 'get')
      return record
    }, proxy)
    assert.equal((await run('POST', `${environmentPath}/proxy/probe`)).status, 409)
  }
})

test('Gemini rebind and model discovery use trusted proxy arguments and return only the matching environment view', async () => {
  const newProxy = { ...bound, id: 'px-replacement' }
  const boundRecord = { ...record, proxy_id: newProxy.id }
  let stored = record
  const run = setup((operation, payload) => {
    if (operation === 'get') return stored
    assert.equal(payload.id, record.id)
    assert.equal(payload.proxy_id, newProxy.id)
    assert.equal(payload.proxy_url, proxyUrl)
    if (operation === 'proxy-bind') {
      assert.equal(payload.previous_proxy_id, bound.id)
      stored = boundRecord
      return { ...stored, proxy_url: proxyUrl, billing_ready: true }
    }
    assert.equal(operation, 'models')
    assert.equal(payload.previous_proxy_id, undefined)
    return { ...stored, models: [model, 'bad/slug', [model]], raw: proxyUrl, billing_ready: true }
  }, newProxy)
  const rebind = await run('PUT', `${environmentPath}/proxy`, { proxy_id: newProxy.id, proxy_url: 'untrusted' })
  assert.equal(rebind.status, 200)
  assert.equal(rebind.body.data.proxy_id, newProxy.id)
  assert.equal(rebind.body.data.billing_ready, false)
  const discovery = await run('POST', `${environmentPath}/models`, { proxy_id: bound.id, proxy_url: 'untrusted' })
  assert.equal(discovery.status, 200)
  assert.deepEqual(discovery.body.data.models, [model])
  assert.equal(discovery.body.data.billing_ready, false)
  assert.doesNotMatch(JSON.stringify([rebind, discovery]), /private|untrusted/)

  const mismatched = setup(() => ({ ...record, id: 'other-env', models: [model] }))
  assert.equal((await mismatched('POST', `${environmentPath}/models`)).body.error.code, 'gemini_host_protocol_error')
  const empty = setup(() => record)
  assert.equal((await empty('POST', `${environmentPath}/models`)).body.error.code, 'gemini_models_empty')
})

test('Gemini test-chat validates bytes and IDs before dispatch and polls or cancels without a proxy', async () => {
  const route = `${environmentPath}/test-chat`
  const poll = `${route}/${runId}`
  const prompt = '😺'.repeat(1024)
  const operations = []
  const start = setup((operation, payload) => {
    operations.push([operation, payload])
    return operation === 'get' ? record : { run_id: runId, proxy_url: proxyUrl }
  })
  assert.equal((await start('POST', route, { model: [model], prompt })).body.error.code, 'gemini_invalid_model')
  for (const invalid of [123, '  ', `${prompt}x`, '\ud800']) {
    assert.equal((await start('POST', route, { model, prompt: invalid })).body.error.code, 'gemini_invalid_prompt')
  }
  assert.equal((await start('GET', `${route}/${runId.toUpperCase()}`)).body.error.code, 'gemini_invalid_run_id')
  const invalidProxy = await start('PUT', `${environmentPath}/proxy`, { proxy_id: [bound.id] })
  assert.equal(invalidProxy.body.error.code, 'gemini_invalid_proxy_id')
  assert.deepEqual(operations, [])

  const started = await start('POST', route, { model, prompt, proxy_id: 'untrusted', proxy_url: 'untrusted' })
  assert.deepEqual(started.body.data, { run_id: runId })
  assert.deepEqual(operations, [
    ['get', { id: record.id }],
    ['test-chat', { id: record.id, proxy_id: bound.id, proxy_url: proxyUrl, model, prompt }],
  ])

  const status = createGeminiPanelHandler({
    json: (_res, httpStatus, body) => ({ status: httpStatus, body }),
    readBody: () => assert.fail('poll and cancel must not read a request body'),
    proxyPool: () => assert.fail('poll and cancel must not look up a proxy'),
    callHost(operation, payload) {
      assert.deepEqual(payload, { id: record.id, run_id: runId })
      if (operation === 'test-chat-cancel') return { cancelled: true, proxy_url: proxyUrl }
      assert.equal(operation, 'test-chat-status')
      return {
        state: 'failed',
        text: `${proxyUrl} ${'x'.repeat(16384)}`,
        usage: { input_tokens: 4, output_tokens: -1, total_tokens: 8, raw: proxyUrl },
        error: { code: 'gemini_proxy_error', message: proxyUrl },
      }
    },
  })
  const response = { setHeader() {} }
  const result = await status({ method: 'GET' }, response, poll)
  assert.equal(result.status, 200)
  assert.equal(result.body.data.state, 'failed')
  assert.equal(result.body.data.text.length, 16384)
  assert.deepEqual(result.body.data.usage, { input_tokens: 4, total_tokens: 8 })
  assert.equal(result.body.data.error.code, 'gemini_proxy_error')
  assert.doesNotMatch(JSON.stringify(result), /private|192\.0\.2\.11/)
  assert.deepEqual((await status({ method: 'DELETE' }, response, poll)).body.data, { cancelled: true })
})

test('Gemini diagnostics use fixed HTTP statuses and messages for known host errors', async () => {
  for (const [code, expected] of [
    ['gemini_operation_busy', 409],
    ['gemini_run_not_found', 404],
    ['gemini_oauth_required', 409],
    ['gemini_model_unavailable', 409],
    ['gemini_proxy_error', 502],
    ['gemini_inference_timeout', 503],
  ]) {
    const run = setup(() => {
      throw Object.assign(new Error(proxyUrl), { code, status: 400 })
    })
    const { body, status } = await run('GET', `${environmentPath}/test-chat/${runId}`)
    assert.equal(status, expected)
    assert.equal(body.error.code, code)
    assert.doesNotMatch(JSON.stringify(body), /private/)
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

test('Gemini panel exposes scoped quota windows without inventing missing fractions or exposing raw fields', async () => {
  const run = setup(() => ({
    environments: [
      {
        ...record,
        auth_state: 'authorized',
        account: {
          state: 'error',
          checked_at: '2030-01-02T00:00:00Z',
          data_at: '2030-01-01T00:00:00Z',
          quota_groups: [
            {
              name: 'Gemini Pro',
              raw: 'private fixture',
              windows: [
                {
                  id: 'gemini-5h',
                  period: '5h',
                  remaining_fraction: 0,
                  reset_at: '2030-01-02T05:00:00Z',
                  raw: 'private fixture',
                },
                { id: 'gemini-weekly', period: 'weekly', remaining_fraction: null },
                { id: 'invalid-window', period: 'monthly', remaining_fraction: 4 },
              ],
            },
          ],
        },
      },
    ],
  }))
  const result = await run('GET', root)
  const [environment] = result.body.data.environments
  assert.equal(environment.account.data_at, '2030-01-01T00:00:00Z')
  assert.deepEqual(environment.account.quota_groups, [
    {
      name: 'Gemini Pro',
      windows: [
        { id: 'gemini-5h', period: '5h', remaining_fraction: 0, reset_at: '2030-01-02T05:00:00Z' },
        { id: 'gemini-weekly', period: 'weekly', remaining_fraction: null, reset_at: null },
      ],
    },
  ])
  assert.doesNotMatch(JSON.stringify(result.body), /private fixture/)
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
  const respond = (_res, status, body) => ({ status, body })
  const res = { setHeader() {} }
  for (const group_type of ['all', 'anthropic', 'openai']) {
    const denied = handleGeminiPublic({ apiKeyKind: 'managed', apiKeyRecord: { group_type } }, res, respond)
    assert.equal(denied.status, 403)
    assert.equal(denied.body.error.code, 'gemini_key_required')
  }
  assert.equal(handleGeminiPublic({ apiKeyKind: 'master' }, res, respond).status, 403)
  const result = handleGeminiPublic({ apiKeyKind: 'managed', apiKeyRecord: { group_type: 'gemini' } }, res, respond)
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'gemini_runtime_not_supported')
})

test('Gemini keys cannot reach other inference endpoints via HTTP or WebSocket', () => {
  for (const route of [
    '/v1/responses',
    '/responses',
    '/v1/chat/completions',
    '/v1/messages',
    '/v1/images/edits',
    '/admin/models/refresh',
  ]) {
    assert.equal(geminiKeyAllowsPath(route, 'POST'), false)
    assert.equal(geminiKeyAllowsPath(route, 'GET'), false)
  }
  assert.equal(geminiKeyAllowsPath('/v1/gemini/sessions', 'POST'), true)
  assert.equal(geminiKeyAllowsPath('/v1/me/quota', 'GET'), true)
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
  for (const version of ['0.3.0-rc.2', '0.3.0-rc.3']) {
    const bytes = Buffer.from(JSON.stringify({ ...manifest, version }))
    await writeFile(path.join(source, 'manifest.json'), bytes)
    await writeFile(path.join(source, 'manifest.sig'), sign(null, bytes, privateKey))
    if (version === '0.3.0-rc.2') {
      assert.equal((await readSignedGeminiManifest(source, verificationKey)).manifest.version, version)
    } else {
      await assert.rejects(readSignedGeminiManifest(source, verificationKey), /gemini_payload_invalid_manifest/)
    }
  }
})
