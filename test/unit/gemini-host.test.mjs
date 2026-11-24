import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { dispatchGeminiNativeTurn, prepareGeminiNativeTurn } from '../../src/lib/gemini/native-turn.mjs'
import { AGY_SHA256, installGeminiPayload, readSignedGeminiManifest } from '../../src/lib/gemini/payload.mjs'
import {
  createGeminiPanelHandler,
  callGeminiHost,
  createGeminiPublicHandler,
  geminiKeyAllowsPath,
  isGeminiPublicPath,
  isGeminiSharedPath,
  officialGeminiAuthUrl,
  warmGeminiEnvironments,
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

function setup(callHost, proxy = bound, getProxyUrl = () => proxyUrl) {
  const response = { setHeader() {} }
  const panel = createGeminiPanelHandler({
    json: (_response, status, body) => ({ status, body }),
    readBody: async (req) => req.body,
    proxyPool: () => ({
      snapshot: ({ ownerUserId }) => {
        assert.equal(ownerUserId, null)
        return { proxies: [proxy] }
      },
      getProxyByIdWithAuth: (id) => (id === proxy.id ? { url: getProxyUrl() } : null),
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

test('Gemini inventory projects only scoped host inference metadata and does not dispatch work', async () => {
  const started = '2030-01-01T00:00:00+00:00'
  const finished = '2030-01-01T00:00:01.000Z'
  const evidence = {
    state: 'failed',
    model,
    started_at: started,
    finished_at: finished,
    error_code: 'gemini_location_unsupported',
  }
  const secret = 'fixture-private-data'
  const digest = createHash('sha256').update(proxyUrl).digest('hex')
  const values = [
    { ...evidence, prompt: secret, text: secret, profile: secret, usage: { total_tokens: 42 } },
    { ...evidence, error_code: secret, error: { message: secret } },
    { ...evidence, state: 'cancelled', error_code: 'gemini_inference_cancelled' },
    { ...evidence, state: 'running', finished_at: secret },
    { ...evidence, state: 'completed' },
    { ...evidence, state: secret },
    { ...evidence, model: proxyUrl },
    { ...evidence, started_at: secret },
    { ...evidence, finished_at: null },
    null,
  ]
  const operations = []
  const run = setup((operation, payload) => {
    operations.push([operation, payload])
    return {
      environments: [
        { ...record, id: 'old-host-record' },
        ...values.map((last_inference, i) => ({
          ...record,
          auth_state: 'authorized',
          id: `env-${i}`,
          runtime_ready: false,
          last_inference,
          last_inference_proxy_sha256: digest,
        })),
      ],
    }
  })
  const result = await run('GET', root)
  assert.equal(result.status, 200)
  assert.equal(result.body.data.available, true)
  assert.deepEqual(operations, [['list', {}]])
  const [oldHost, ...environments] = result.body.data.environments
  assert.equal(Object.hasOwn(oldHost, 'last_inference'), false)
  assert.ok(environments.every((environment) => environment.runtime_ready === false))
  assert.deepEqual(
    environments.map((environment) => environment.last_inference),
    [
      evidence,
      { ...evidence, error_code: null },
      { ...evidence, state: 'cancelled', error_code: 'gemini_inference_cancelled' },
      { ...evidence, state: 'running', finished_at: null, error_code: null },
      { ...evidence, state: 'completed', error_code: null },
      null,
      null,
      null,
      null,
      null,
    ],
  )
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-data|192\.0\.2\.11|total_tokens/)
  assert.ok(!JSON.stringify(result).includes(digest))
  assert.ok(!JSON.stringify(result).includes('last_inference_proxy_sha256'))
})

test('Gemini inventory hides evidence after same-ID endpoint or credential edits', async () => {
  let current = proxyUrl
  const evidence = {
    state: 'completed',
    model,
    started_at: '2030-01-01T00:00:00+00:00',
    finished_at: '2030-01-01T00:00:01+00:00',
    error_code: null,
  }
  const environment = { ...record, auth_state: 'authorized', last_inference: evidence }
  const recordEvidence = (url) => {
    environment.last_inference_proxy_sha256 = createHash('sha256').update(url).digest('hex')
  }
  const run = setup(
    (operation) => {
      assert.equal(operation, 'list')
      return { environments: [environment] }
    },
    bound,
    () => current,
  )
  const read = async () => (await run('GET', root)).body.data.environments[0]
  assert.equal((await read()).last_inference, null) // An unbound record cannot verify this proxy.
  recordEvidence(proxyUrl)
  assert.deepEqual((await read()).last_inference, evidence)
  for (const next of [proxyUrl.replace('192.0.2.11', '192.0.2.12'), proxyUrl.replace('private', 'rotated')]) {
    current = next
    const projected = await read()
    assert.equal(projected.proxy_id, environment.proxy_id)
    assert.equal(projected.proxy_ready, true)
    assert.equal(projected.last_inference, null)
  }
  recordEvidence(current)
  assert.deepEqual((await read()).last_inference, evidence)
})

test('Gemini host inference evidence follows admitted runs and their bindings', { timeout: 15_000 }, () => {
  execFileSync('python3', ['-B', fileURLToPath(new URL('./gemini-host-evidence.py', import.meta.url))], {
    stdio: 'pipe',
    timeout: 12_000,
  })
})

test('Gemini host auto-provisions models, plan, onboarding, and token refresh', { timeout: 15_000 }, () => {
  execFileSync('python3', ['-B', fileURLToPath(new URL('./gemini-account-and-auto-provision.py', import.meta.url))], {
    stdio: 'pipe',
    timeout: 12_000,
  })
})

// The default-payload fetcher used to hardcode the release version alongside the
// manifest pin, and the two drifted for three releases (#1677). Driven from here
// because `test:ci`'s standing set is 13 keywords that do not include this file:
// CI picks it up as a modified test, the same way every non-core test here runs.
test('the default Gemini payload fetcher derives its release from the manifest pin', { timeout: 15_000 }, () => {
  execFileSync('python3', ['-B', fileURLToPath(new URL('./fetch-default-gemini-pins.py', import.meta.url))], {
    stdio: 'pipe',
    timeout: 12_000,
  })
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

test('OAuth account import redacts credentials and preserves the authorization boundary', async () => {
  const endpoint = `${root}/environments`
  const credential = {
    access_token: 'fixture-access-never-returned',
    expiry_timestamp: 4102444800,
  }
  const body = { name: record.name, proxy_id: record.proxy_id, oauth_account: credential }
  const invalid = setup(() => assert.fail('malformed credentials must not reach the host'))
  const rejected = await invalid('POST', endpoint, {
    ...body,
    oauth_account: { ...credential, access_token: 'invalid\r\nheader' },
  })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.error.code, 'gemini_oauth_import_invalid')

  const run = setup(() => ({
    ...record,
    auth_state: 'authorized',
    auth_method: 'oauth',
    oauth_imported: true,
    oauth_account: credential,
    account: { state: 'ok', email: 'verified@example.test', access_token: credential.access_token },
  }))
  const accepted = await run('POST', endpoint, body)
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.data.oauth_imported, true)
  assert.equal(accepted.body.data.account.email, 'verified@example.test')
  assert.equal(accepted.body.data.runtime_ready, false)
  assert.doesNotMatch(JSON.stringify(accepted.body), /fixture-access-never-returned/)
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

test('Gemini public routes schedule one plain-text turn and reject other keys', async () => {
  const respond = (_res, status, body) => ({ status, body })
  const calls = []
  const handle = createGeminiPublicHandler({
    json: respond,
    readBody: async () => ({ model: 'gemini-3-pro', input: 'hello' }),
    scheduler: {
      async catalog() {
        return { models: [{ id: 'gemini-3-pro', object: 'model', owned_by: 'google' }] }
      },
      async complete(request) {
        calls.push(request)
        return {
          text: 'ok',
          usage: { input_tokens: 1, output_tokens: 1 },
          account_id: 'gemini-fixture',
          model: request.model,
        }
      },
    },
  })
  const res = { setHeader() {}, once() {} }
  for (const group_type of ['anthropic', 'openai']) {
    const denied = await handle({ apiKeyKind: 'managed', apiKeyRecord: { group_type }, once() {} }, res)
    assert.equal(denied.status, 403)
    assert.equal(denied.body.error.code, 'gemini_key_required')
  }
  assert.equal((await handle({ apiKeyKind: 'master', once() {} }, res)).status, 403)
  const allBareClaude = await handle(
    {
      method: 'POST',
      url: '/v1/messages',
      apiKeyKind: 'managed',
      apiKeyRecord: { group_type: 'all' },
      body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }] },
      once() {},
    },
    res,
  )
  assert.equal(allBareClaude.status, 404)
  assert.equal(allBareClaude.body.error.code, 'gemini_model_unavailable')
  const listed = await handle(
    {
      method: 'GET',
      url: '/v1/gemini/sessions',
      apiKeyKind: 'managed',
      apiKeyRecord: { group_type: 'gemini' },
      once() {},
    },
    res,
  )
  assert.equal(listed.status, 200)
  assert.equal(listed.body.data[0].id, 'gemini-3-pro')
  const result = await handle(
    {
      method: 'POST',
      url: '/v1/gemini/sessions/turn-1',
      apiKeyKind: 'managed',
      apiKeyRecord: { group_type: 'gemini' },
      once() {},
    },
    res,
  )
  assert.equal(result.status, 200)
  assert.equal(result.body.output_text, 'ok')
  assert.equal(calls.length, 1)
  // A Gemini key may also call the Anthropic entry point. That one must answer in the
  // Anthropic Messages shape, or an Anthropic client cannot read the reply: `output_text`
  // with no `type` / `role` / `content` is unparseable, and the id must not be the path.
  for (const url of ['/v1/messages', '/messages']) {
    const anthropic = await handle(
      {
        method: 'POST',
        url,
        apiKeyKind: 'managed',
        apiKeyRecord: { group_type: 'gemini' },
        body: { model, messages: [{ role: 'user', content: 'hello' }] },
        once() {},
      },
      res,
    )
    assert.equal(anthropic.status, 200)
    assert.match(anthropic.body.id, /^msg_[0-9a-f]{24}$/)
    assert.equal(anthropic.body.type, 'message')
    assert.equal(anthropic.body.role, 'assistant')
    assert.equal(anthropic.body.model, 'gemini-3-pro')
    assert.deepEqual(anthropic.body.content, [{ type: 'text', text: 'ok' }])
    assert.equal(anthropic.body.stop_reason, 'end_turn')
    assert.deepEqual(anthropic.body.usage, { input_tokens: 1, output_tokens: 1 })
    assert.equal(anthropic.body.output_text, undefined)
  }
  assert.equal(calls.length, 3)
  const scoped = { apiKeyKind: 'managed', apiKeyRecord: { group_type: 'gemini', allowed_models: [model] }, once() {} }
  for (const body of [
    { model: 'gemini-other', input: 'hello' },
    { model, input: 'hello', tools: [{ name: 'lookup' }] },
    { model, input: '测'.repeat(1366) },
  ]) {
    const result = await handle({ ...scoped, method: 'POST', url: '/v1/gemini/sessions/reject', body }, res)
    assert.equal(result.status, 400)
  }
  const filtered = await handle(
    {
      ...scoped,
      apiKeyRecord: { ...scoped.apiKeyRecord, allowed_models: ['gemini-other'] },
      method: 'GET',
      url: '/v1/models',
    },
    res,
  )
  assert.deepEqual(filtered.body.data, [])
  assert.equal(calls.length, 3)
  const bad = createGeminiPublicHandler({
    json: respond,
    readBody: async () => ({ model: 'gemini-3-pro', input: ['not text'] }),
    scheduler: { catalog() {}, complete() {} },
  })
  const rejected = await bad(
    {
      method: 'POST',
      url: '/v1/gemini/sessions/turn-2',
      apiKeyKind: 'managed',
      apiKeyRecord: { group_type: 'gemini' },
      once() {},
    },
    res,
  )
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.error.code, 'gemini_unsupported_turn')
})

test('the public scheduler completes one turn through the host socket', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gemini-public-'))
  const socketPath = path.join(directory, 'control.sock')
  const account = {
    id: 'gemini-fixture',
    auth_state: 'authorized',
    proxy_id: 'px-fixture',
    models_discovered: true,
    models: ['gemini-3-pro'],
  }
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      const payload =
        request.url === '/list'
          ? { payload_state: 'installed', environments: [account] }
          : request.url === '/get'
            ? account
            : request.url === '/test-chat' && body.prompt === 'hello'
              ? { run_id: runId }
              : request.url === '/test-chat-status'
                ? { state: 'completed', text: 'ready', usage: { input_tokens: 1, output_tokens: 1 } }
                : null
      response.writeHead(payload ? 200 : 404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(payload || { code: 'gemini_host_protocol_error' }))
    })
  })
  const previous = process.env.KIN_GEMINI_HOST_SOCKET
  process.env.KIN_GEMINI_HOST_SOCKET = socketPath
  const reservation = { release() {} }
  const scheduler = createGeminiScheduler({
    callHost: callGeminiHost,
    resolveProxy: () => proxyUrl,
    poolScheduler: {
      reserveExternalCandidates: (candidates) => ({
        selected: { ...candidates[0], accountId: `gemini:${account.id}` },
        reservation,
      }),
      unitCircuit: { recordSuccess() {}, recordFailure() {}, releaseProbe() {} },
      lastUsed: new Map(),
    },
  })
  const handle = createGeminiPublicHandler({
    json: (_response, status, body) => ({ status, body }),
    readBody: async () => ({ model, input: 'hello' }),
    scheduler,
  })
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve))
    const result = await handle(
      {
        method: 'POST',
        url: '/v1/gemini/sessions/turn-1',
        apiKeyKind: 'managed',
        apiKeyRecord: { group_type: 'gemini' },
        once() {},
      },
      { setHeader() {}, once() {} },
    )
    assert.equal(result.status, 200)
    assert.equal(result.body.output_text, 'ready')
    assert.equal(result.body.account_id, account.id)
  } finally {
    if (previous === undefined) delete process.env.KIN_GEMINI_HOST_SOCKET
    else process.env.KIN_GEMINI_HOST_SOCKET = previous
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('Gemini gateway uses shared account reservations and each selected environment proxy', async () => {
  const environments = ['1', '2'].map((digit, index) => ({
    id: `gemini-${digit.repeat(24)}`,
    auth_state: 'authorized',
    proxy_id: `px-${digit}`,
    models_discovered: true,
    models: [model],
    index,
  }))
  const started = []
  let finish = false
  let resolveFirst
  let resolveBoth
  const firstStarted = new Promise((resolve) => {
    resolveFirst = resolve
  })
  const bothStarted = new Promise((resolve) => {
    resolveBoth = resolve
  })
  const pool = new PoolScheduler()
  const scheduler = createGeminiScheduler({
    poolScheduler: pool,
    resolveProxy: (proxyId) => `socks5h://192.0.2.${proxyId === 'px-1' ? '11' : '12'}:1080`,
    callHost: async (operation, input) => {
      if (operation === 'list') return { payload_state: 'installed', environments }
      if (operation === 'get') return environments.find((environment) => environment.id === input.id)
      if (operation === 'test-chat') {
        started.push(input)
        if (started.length === 1) resolveFirst()
        if (started.length === 2) resolveBoth()
        return { run_id: started.length === 1 ? 'a'.repeat(32) : 'b'.repeat(32) }
      }
      if (operation === 'test-chat-status')
        return finish
          ? {
              state: 'completed',
              text: input.run_id[0] === 'a' ? 'reply one' : 'reply two',
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            }
          : { state: 'running' }
      throw new Error(`unexpected Gemini host operation: ${operation}`)
    },
  })
  const first = scheduler.complete({ model, text: 'hello' })
  await firstStarted
  const second = scheduler.complete({ model, text: 'hello' })
  await bothStarted
  assert.notEqual(started[0].id, started[1].id)
  assert.deepEqual(started.map(({ proxy_id, proxy_url }) => [proxy_id, proxy_url]).sort(), [
    ['px-1', 'socks5h://192.0.2.11:1080'],
    ['px-2', 'socks5h://192.0.2.12:1080'],
  ])
  assert.equal(pool.inflight.size, 2)
  finish = true
  const results = await Promise.all([first, second])
  assert.deepEqual(new Set(results.map((result) => result.text)), new Set(['reply one', 'reply two']))
  assert.equal(pool.inflight.size, 0)
})

test('a selected Gemini location rejection stays HTTP 403 and releases the half-open probe', async () => {
  const account = {
    id: 'gemini-location',
    auth_state: 'authorized',
    auth_method: 'oauth',
    proxy_id: 'px-location',
    models_discovered: true,
    models: [model],
  }
  const pool = new PoolScheduler()
  const accountId = `gemini:${account.id}`
  let now = 1000
  pool.unitCircuit.now = () => now
  pool.unitCircuit.configure({ failureThreshold: 1, openMs: 1000 })
  pool.unitCircuit.recordFailure(accountId)
  now = 2001
  const scheduler = createGeminiScheduler({
    poolScheduler: pool,
    resolveProxy: () => proxyUrl,
    callHost: async (operation, input) => {
      if (operation === 'list') return { payload_state: 'installed', environments: [account] }
      assert.equal(input.id, account.id)
      if (operation === 'get') return account
      if (operation === 'test-chat') return { run_id: runId }
      if (operation === 'test-chat-status') {
        assert.equal(pool.unitCircuit.inspect(accountId).reason, 'circuit_probe')
        return { state: 'failed', text: '', error: { code: 'gemini_location_unsupported' } }
      }
      assert.fail(`unexpected Gemini host operation: ${operation}`)
    },
  })
  const handle = createGeminiPublicHandler({
    json: (_res, status, body) => ({ status, body }),
    readBody: async (req) => req.body,
    scheduler,
  })
  const result = await handle(
    {
      method: 'POST',
      url: '/v1/chat/completions',
      body: { model, messages: [{ role: 'user', content: 'hello' }] },
      apiKeyKind: 'managed',
      apiKeyRecord: { group_type: 'gemini' },
      once() {},
    },
    { setHeader() {}, once() {} },
  )
  assert.equal(result.status, 403)
  assert.equal(result.body.error.code, 'gemini_location_unsupported')
  assert.deepEqual(pool.unitCircuit.inspect(accountId), { ok: true, state: 'half_open', probeAvailable: true })
  assert.equal(pool.unitCircuit.snapshot(accountId).failures, 1)
  assert.equal(pool.inflight.size, 0)
})

test('client disconnect cancels the Gemini run without recording a circuit failure', async () => {
  const account = {
    id: 'gemini-abort-0123456789abcdef01234567',
    auth_state: 'authorized',
    proxy_id: 'px-abort',
    models_discovered: true,
    models: [model],
  }
  const events = { failures: 0, probeAccountIds: [], hostCancelled: 0, reservationReleased: 0 }
  let resolveStatusPoll
  const statusPolled = new Promise((resolve) => {
    resolveStatusPoll = resolve
  })
  const scheduler = createGeminiScheduler({
    resolveProxy: () => proxyUrl,
    poolScheduler: {
      reserveExternalCandidates(candidates) {
        return {
          selected: candidates[0],
          reservation: {
            release() {
              events.reservationReleased += 1
            },
          },
        }
      },
      unitCircuit: {
        recordFailure() {
          events.failures += 1
        },
        releaseProbe(id) {
          events.probeAccountIds.push(id)
        },
      },
    },
    callHost: async (operation) => {
      if (operation === 'list') return { payload_state: 'installed', environments: [account] }
      if (operation === 'get') return account
      if (operation === 'test-chat') return { run_id: runId }
      if (operation === 'test-chat-status') {
        resolveStatusPoll()
        return { state: 'running' }
      }
      if (operation === 'test-chat-cancel') {
        events.hostCancelled += 1
        return { cancelled: true }
      }
      throw new Error(`unexpected Gemini host operation: ${operation}`)
    },
  })
  const handle = createGeminiPublicHandler({
    json: (_res, status, body) => ({ status, body }),
    readBody: async (req) => req.body,
    scheduler,
  })
  let onClose
  const req = {
    method: 'POST',
    url: '/v1/gemini/sessions/disconnect',
    body: { model, input: 'hello' },
    apiKeyKind: 'managed',
    apiKeyRecord: { group_type: 'gemini' },
    once() {},
  }
  const res = {
    writableEnded: false,
    setHeader() {},
    once(event, handler) {
      if (event === 'close') onClose = handler
    },
  }
  const response = handle(req, res)
  await statusPolled
  onClose()
  assert.equal(await response, undefined)
  assert.equal(events.failures, 0)
  assert.deepEqual(events.probeAccountIds, [`gemini:${account.id}`])
  assert.equal(events.hostCancelled, 1)
  assert.equal(events.reservationReleased, 1)
})

test('Google API route uses shared pool reservation and returns Google response wire shape', async () => {
  const account = {
    id: 'gemini-0123456789abcdef01234567',
    auth_state: 'authorized',
    proxy_id: 'px-gemini',
    models_discovered: true,
    models: [model],
  }
  const pool = new PoolScheduler()
  const testChat = []
  const scheduler = createGeminiScheduler({
    poolScheduler: pool,
    resolveProxy: () => proxyUrl,
    callHost: async (operation, payload) => {
      if (operation === 'list') return { payload_state: 'installed', environments: [account] }
      if (operation === 'get') return account
      if (operation === 'test-chat') {
        testChat.push(payload)
        return { run_id: runId }
      }
      if (operation === 'test-chat-status')
        return {
          state: 'completed',
          text: 'actual shared route',
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        }
      throw new Error(`unexpected host request: ${operation}`)
    },
  })
  const handle = createGeminiPublicHandler({
    json: (_res, status, body) => ({ status, body }),
    readBody: async () => ({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }),
    scheduler,
  })
  const response = await handle(
    {
      method: 'POST',
      url: '/v1beta/models/gemini-3-pro:generateContent',
      apiKeyKind: 'managed',
      apiKeyRecord: { group_type: 'gemini' },
      once() {},
    },
    { setHeader() {}, once() {} },
  )
  assert.equal(response.status, 200)
  assert.equal(response.body.candidates[0].content.parts[0].text, 'actual shared route')
  assert.equal(response.body.usageMetadata.totalTokenCount, 8)
  assert.equal(testChat.length, 1)
  assert.equal(testChat[0].id, account.id)
  assert.equal(testChat[0].proxy_id, account.proxy_id)
  assert.equal(pool.inflight.size, 0)
})

test('Gemini protocol adapters preserve stream framing and native Google errors', async () => {
  const scheduler = {
    async complete({ model: requested }) {
      return { text: 'converted', model: requested, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }
    },
  }
  const handle = createGeminiPublicHandler({
    json: (_res, status, body) => ({ status, body }),
    readBody: async (req) => req.body,
    scheduler,
  })
  const makeResponse = () => ({
    setHeader() {},
    once() {},
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    write(chunk) {
      this.chunks = [...(this.chunks || []), chunk]
    },
    end() {
      this.writableEnded = true
    },
  })
  const request = (url, body, response = makeResponse()) =>
    handle(
      { method: 'POST', url, body, apiKeyKind: 'managed', apiKeyRecord: { group_type: 'gemini' }, once() {} },
      response,
    )

  const openaiRes = makeResponse()
  await request('/v1/responses', { model, input: 'hello', stream: true }, openaiRes)
  assert.match(openaiRes.headers['Content-Type'], /text\/event-stream/)
  assert.match(openaiRes.chunks.join(''), /event: response\.output_text\.delta/)
  assert.match(openaiRes.chunks.join(''), /event: response\.completed/)

  const anthropicRes = makeResponse()
  await request('/v1/messages', { model, messages: [{ role: 'user', content: 'hello' }], stream: true }, anthropicRes)
  assert.match(anthropicRes.chunks.join(''), /event: message_start/)
  assert.match(anthropicRes.chunks.join(''), /event: message_stop/)

  const invalid = await request('/v1beta/models/gemini-3-pro:generateContent', {
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    generationConfig: { maxOutputTokens: 32 },
  })
  assert.equal(invalid.status, 400)
  assert.deepEqual(invalid.body.error.status, 'INVALID_ARGUMENT')
  assert.equal(invalid.body.error.details[0].reason, 'gemini_unsupported_turn')

  const anthropicError = await request('/v1/messages', {
    model,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(anthropicError.status, 400)
  assert.equal(anthropicError.body.type, 'error')
  assert.equal(anthropicError.body.error.type, 'invalid_request_error')
})

test('Gemini-compatible routes convert requests and results across supported protocols', async () => {
  const calls = []
  const handle = createGeminiPublicHandler({
    json: (_res, status, body) => ({ status, body }),
    readBody: async (req) => req.body,
    scheduler: {
      async catalog() {
        return { models: [{ id: model, object: 'model', owned_by: 'google' }] }
      },
      async complete(input) {
        calls.push(input)
        return {
          text: 'hello from CRAGGemini',
          usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
          account_id: 'gemini-a',
          model: input.model,
        }
      },
    },
  })
  const response = {
    setHeader() {},
    once() {},
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    write(chunk) {
      this.chunks = [...(this.chunks || []), chunk]
    },
    end() {
      this.writableEnded = true
    },
  }
  const request = (url, body) =>
    handle(
      { method: 'POST', url, body, apiKeyKind: 'managed', apiKeyRecord: { group_type: 'gemini' }, once() {} },
      response,
    )

  const google = await request('/v1beta/models/gemini-3-pro:generateContent', {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  })
  assert.equal(google.status, 200)
  assert.deepEqual(google.body.candidates[0].content.parts, [{ text: 'hello from CRAGGemini' }])
  assert.deepEqual(google.body.usageMetadata, { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 })

  const chat = await request('/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(chat.body.choices[0].message.content, 'hello from CRAGGemini')
  assert.equal(chat.body.usage.total_tokens, 11)

  const responses = await request('/v1/responses', { model, input: 'hi' })
  assert.equal(responses.body.object, 'response')
  assert.equal(responses.body.output[0].content[0].text, 'hello from CRAGGemini')

  const sse = await request('/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse', {
    contents: [{ parts: [{ text: 'hi' }] }],
  })
  assert.equal(sse, undefined)
  assert.equal(response.status, 200)
  assert.match(response.headers['Content-Type'], /text\/event-stream/)
  assert.match(response.chunks.join(''), /"finishReason":"STOP"/)
  assert.equal(calls.length, 4)
  assert.deepEqual(
    calls.map(({ model: id, text }) => [id, text]),
    Array.from({ length: 4 }, () => [model, 'hi']),
  )
})

test('Gemini keys allow supported protocol adapters and deny other inference surfaces', () => {
  for (const route of ['/v1/responses/compact', '/v1/completions', '/v1/images/edits', '/admin/models/refresh']) {
    assert.equal(geminiKeyAllowsPath(route, 'POST'), false)
    assert.equal(geminiKeyAllowsPath(route, 'GET'), false)
  }
  assert.equal(geminiKeyAllowsPath('/v1/responses', 'POST'), true)
  assert.equal(geminiKeyAllowsPath('/responses', 'POST'), true)
  assert.equal(geminiKeyAllowsPath('/v1/chat/completions', 'POST'), true)
  assert.equal(geminiKeyAllowsPath('/v1beta/models/gemini-3.8-flash:generateContent', 'POST'), true)
  assert.equal(geminiKeyAllowsPath('/v1beta/models', 'GET'), true)
  assert.equal(geminiKeyAllowsPath('/v1/gemini/sessions', 'POST'), true)
  assert.equal(geminiKeyAllowsPath('/v1/messages', 'POST'), true)
  assert.equal(geminiKeyAllowsPath('/messages', 'POST'), true)
  assert.equal(geminiKeyAllowsPath('/v1/me/quota', 'GET'), true)
})

test('only Gemini-exclusive paths dispatch by path alone', () => {
  // Claiming a shared path here makes the OpenAI handlers in server.mjs
  // unreachable — they sit after this check — and every non-Gemini caller gets
  // gemini_key_required. Keep the two sets apart.
  for (const shared of ['/v1/chat/completions', '/chat/completions', '/v1/responses', '/responses']) {
    assert.equal(isGeminiPublicPath(shared), false, `${shared} must not route by path alone`)
    assert.equal(isGeminiSharedPath(shared), true)
    // A Gemini key still reaches them.
    assert.equal(geminiKeyAllowsPath(shared, 'POST'), true)
  }
  for (const exclusive of [
    '/v1/gemini/sessions',
    '/v1/gemini/sessions/abc',
    '/v1beta/models/gemini-3.8-flash:generateContent',
    '/v1beta/models/gemini-3.8-flash:streamGenerateContent',
  ]) {
    assert.equal(isGeminiPublicPath(exclusive), true)
    assert.equal(isGeminiSharedPath(exclusive), false)
  }
  // Neither set may swallow a sibling the OpenAI side owns outright.
  for (const other of ['/v1/completions', '/completions', '/v1/responses/compact', '/v1/messages']) {
    assert.equal(isGeminiPublicPath(other), false)
    assert.equal(isGeminiSharedPath(other), false)
  }
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
  for (const version of ['0.3.0-rc.2', '0.3.0-rc.3', '0.3.0-rc.4']) {
    const bytes = Buffer.from(JSON.stringify({ ...manifest, version }))
    await writeFile(path.join(source, 'manifest.json'), bytes)
    await writeFile(path.join(source, 'manifest.sig'), sign(null, bytes, privateKey))
    if (version !== '0.3.0-rc.4') {
      assert.equal((await readSignedGeminiManifest(source, verificationKey)).manifest.version, version)
    } else {
      await assert.rejects(readSignedGeminiManifest(source, verificationKey), /gemini_payload_invalid_manifest/)
    }
  }
})

test('Gemini environment concurrency config and strict OAuth proxy calibration digest', async () => {
  for (const [role, allowed] of [
    ['user', false],
    ['super', false],
    ['admin', true],
  ]) {
    assert.equal(authorizePanelRoute('PUT', `${environmentPath}/concurrency`, role).ok, allowed)
  }

  const operations = []
  const run = setup((operation, payload) => {
    operations.push([operation, payload])
    if (operation === 'create') {
      return { ...record, max_concurrency: payload.max_concurrency, active_slots: 0 }
    }
    if (operation === 'concurrency-set') {
      return { ...record, max_concurrency: payload.max_concurrency, active_slots: 2 }
    }
    if (operation === 'get') return { ...record, max_concurrency: 10, active_slots: 0 }
    if (operation === 'authorize') return { url: official, attempt_id: 'attempt-calibrated' }
    if (operation === 'complete') return { ...record, auth_state: 'authorized', max_concurrency: 10, active_slots: 0 }
    throw new Error(`unexpected op ${operation}`)
  })

  for (const invalid of [0, -1, 65, '10', 1.5, null]) {
    const badCreate = await run('POST', `${root}/environments`, {
      name: record.name,
      proxy_id: record.proxy_id,
      max_concurrency: invalid,
    })
    assert.equal(badCreate.status, 400)
    assert.equal(badCreate.body.error.code, 'gemini_invalid_concurrency')

    const badPut = await run('PUT', `${environmentPath}/concurrency`, { max_concurrency: invalid })
    assert.equal(badPut.status, 400)
    assert.equal(badPut.body.error.code, 'gemini_invalid_concurrency')
  }
  assert.deepEqual(operations, [])

  const created = await run('POST', `${root}/environments`, {
    name: record.name,
    proxy_id: record.proxy_id,
    max_concurrency: 10,
  })
  assert.equal(created.status, 200)
  assert.equal(created.body.data.max_concurrency, 10)
  assert.equal(created.body.data.active_slots, 0)

  const scaled = await run('PUT', `${environmentPath}/concurrency`, { max_concurrency: 12 })
  assert.equal(scaled.status, 200)
  assert.equal(scaled.body.data.max_concurrency, 12)
  assert.equal(scaled.body.data.active_slots, 2)

  const expectedDigest = createHash('sha256').update(proxyUrl).digest('hex')
  const authStart = await run('POST', `${environmentPath}/authorization`)
  assert.equal(authStart.status, 200)
  const authDone = await run('PUT', `${environmentPath}/authorization`, {
    attempt_id: 'attempt-calibrated',
    code: 'calibrated-code',
  })
  assert.equal(authDone.status, 200)

  const authorizeOp = operations.find(([op]) => op === 'authorize')
  const completeOp = operations.find(([op]) => op === 'complete')
  assert.equal(authorizeOp[1].proxy_sha256, expectedDigest)
  assert.equal(completeOp[1].proxy_sha256, expectedDigest)
})

test('Gemini scheduler allows 10 concurrent slots on acc1 with strict per-account proxy calibration', async () => {
  const environments = [
    {
      id: 'gemini-acc1',
      auth_state: 'authorized',
      auth_method: 'oauth',
      proxy_id: 'px-1',
      max_concurrency: 10,
      models_discovered: true,
      models: [model],
    },
    {
      id: 'gemini-acc2',
      auth_state: 'authorized',
      auth_method: 'oauth',
      proxy_id: 'px-2',
      max_concurrency: 2,
      models_discovered: true,
      models: [model],
    },
  ]
  const proxyMap = {
    'px-1': 'socks5h://u1:p1@192.0.2.101:1080',
    'px-2': 'socks5h://u2:p2@192.0.2.102:1080',
  }
  const pool = new PoolScheduler()
  const inflightPayloads = []
  const releases = []
  let resolveAll10
  const tenActive = new Promise((resolve) => {
    resolveAll10 = resolve
  })

  const scheduler = createGeminiScheduler({
    poolScheduler: pool,
    resolveProxy: (pid) => proxyMap[pid],
    callHost: async (op, input) => {
      if (op === 'list') return { payload_state: 'installed', environments: [environments[0]] }
      if (op === 'get') return environments.find((e) => e.id === input.id)
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async (op, payload) => {
      assert.equal(op, 'infer')
      assert.equal(payload.id, 'gemini-acc1')
      assert.equal(payload.proxy_id, 'px-1')
      assert.equal(payload.proxy_sha256, createHash('sha256').update(proxyMap['px-1']).digest('hex'))
      inflightPayloads.push(payload)
      if (inflightPayloads.length === 10) resolveAll10()
      const gate = new Promise((resolve) => releases.push(resolve))
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        destroy() {},
        async *[Symbol.asyncIterator]() {
          await gate
          yield Buffer.from(
            `data: {"candidates":[{"content":{"parts":[{"text":"slot-${payload.request_id}"}]},"finishReason":"STOP"}]}\n\n`,
          )
        },
      }
    },
  })

  const tasks = Array.from({ length: 10 }, (_, i) =>
    scheduler.stream({
      model,
      requestId: `req-${i}`,
      geminiBody: { model, contents: [{ role: 'user', parts: [{ text: `hi ${i}` }] }] },
    }),
  )
  await tenActive
  assert.equal(pool.inflight.get('gemini:gemini-acc1'), 10)
  for (const release of releases) release()
  const results = await Promise.all(tasks)
  assert.equal(results.length, 10)
  assert.equal(pool.inflight.size, 0)
})

test('warmGeminiEnvironments proactively warms authorized licensed OAuth envs and skips ineligible ones', async () => {
  const warmedCalls = []
  const envReady = {
    id: 'gemini-aaaaaaaaaaaaaaaaaaaaaaaa',
    proxy_id: 'px-1',
    auth_method: 'oauth',
    auth_state: 'authorized',
    runtime_ready: true,
    models_discovered: true,
    crag_license: { valid: true },
  }
  const envNeedModels = {
    id: 'gemini-eeeeeeeeeeeeeeeeeeeeeeee',
    proxy_id: 'px-1',
    auth_method: 'oauth',
    auth_state: 'authorized',
    runtime_ready: true,
    models_discovered: false,
    crag_license: { valid: true },
  }
  const envCold = {
    id: 'gemini-bbbbbbbbbbbbbbbbbbbbbbbb',
    proxy_id: 'px-1',
    auth_method: 'oauth',
    auth_state: 'authorized',
    runtime_ready: false,
    crag_license: { valid: true },
  }
  const envUnlicensed = {
    id: 'gemini-cccccccccccccccccccccccc',
    proxy_id: 'px-1',
    auth_method: 'oauth',
    auth_state: 'authorized',
    runtime_ready: false,
    crag_license: { valid: false },
  }
  const envApiKey = {
    id: 'gemini-dddddddddddddddddddddddd',
    proxy_id: 'px-1',
    auth_method: 'api_key',
    auth_state: 'authorized',
    runtime_ready: false,
  }
  const report = await warmGeminiEnvironments({
    proxyPool: () => ({
      snapshot: () => ({ proxies: [{ id: 'px-1', enabled: true, status: 'ok', owner_user_id: null }] }),
      getProxyByIdWithAuth: (id) => (id === 'px-1' ? { url: proxyUrl } : null),
    }),
    callHost: async (op, payload) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          payload_mode: 'crag_subscription',
          environments: [envReady, envNeedModels, envCold, envUnlicensed, envApiKey],
        }
      }
      warmedCalls.push([op, payload])
      return payload.id === envNeedModels.id
        ? { warmed: true, runtime_ready: true, warming: false }
        : { warmed: false, runtime_ready: false, warming: true }
    },
  })
  assert.deepEqual(report, { warmed: 2, warming: 1, skipped: 2 })
  assert.equal(warmedCalls.length, 2)
  assert.equal(warmedCalls[0][0], 'warm')
  assert.equal(warmedCalls[0][1].id, envNeedModels.id)
  assert.equal(warmedCalls[1][0], 'warm')
  assert.equal(warmedCalls[1][1].id, envCold.id)
  assert.equal(warmedCalls[1][1].proxy_id, 'px-1')
  assert.equal(warmedCalls[1][1].proxy_url, proxyUrl)
  assert.equal(warmedCalls[1][1].proxy_sha256, createHash('sha256').update(proxyUrl).digest('hex'))
})
test('a host error code the control plane knows survives, and only an unknown one collapses (#1622)', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gemini-authcode-'))
  const socketPath = path.join(directory, 'control.sock')
  const previous = process.env.KIN_GEMINI_HOST_SOCKET
  process.env.KIN_GEMINI_HOST_SOCKET = socketPath
  let code = 'gemini_authorization_unavailable'
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    response.writeHead(503, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ code }))
  })
  t.after(async () => {
    if (previous === undefined) delete process.env.KIN_GEMINI_HOST_SOCKET
    else process.env.KIN_GEMINI_HOST_SOCKET = previous
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })

  // The socket answered, so the host service is up and it is the authorization
  // launch that failed. Reporting 'no host service' instead sent #1622 auditing
  // the service and its socket while the real fault was on the egress path.
  await assert.rejects(callGeminiHost('authorization', { id: record.id }), {
    code: 'gemini_authorization_unavailable',
    status: 503,
  })

  // The allow-list itself still holds: a code this version does not know stays
  // collapsed rather than being forwarded to the panel unvetted.
  code = 'gemini_not_a_real_code'
  await assert.rejects(callGeminiHost('authorization', { id: record.id }), { code: 'gemini_host_unavailable' })
})

test('synchronous host errors and polled test-chat runs report the same resident-pool copy for native worker/tty faults', async () => {
  for (const code of ['gemini_native_worker_unavailable', 'gemini_native_tty_unavailable']) {
    const run = setup((operation) => {
      if (operation === 'get') {
        return {
          ...record,
          auth_method: 'oauth',
          auth_state: 'authorized',
          models_discovered: true,
          models: [model],
        }
      }
      if (operation === 'test-chat') {
        throw Object.assign(new Error(code), { code, status: 503 })
      }
      if (operation === 'test-chat-status') {
        return { state: 'failed', text: '', error: { code } }
      }
      throw new Error(`unexpected ${operation}`)
    })
    const startRes = await run('POST', `${environmentPath}/test-chat`, { model, prompt: 'hello' })
    const pollRes = await run('GET', `${environmentPath}/test-chat/${runId}`)
    assert.equal(startRes.status, 503)
    assert.equal(startRes.body.error.code, code)
    assert.equal(pollRes.status, 200)
    assert.equal(pollRes.body.data.error.code, code)
    assert.equal(startRes.body.error.message, pollRes.body.data.error.message)
  }
})
