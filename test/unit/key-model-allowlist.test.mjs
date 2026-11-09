import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { SLA_OK_ERROR_CODES } from '../../src/lib/admin/error-class.mjs'
import {
  KEY_ALLOWED_MODELS_MAX,
  filterModelCatalogForKey,
  keyAllowsModel,
  keyModelError,
  normalizeKeyAllowedModels,
  parseKeyAllowedModels,
} from '../../src/lib/admin/key-models.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { handleUserCountTokens } from '../../src/lib/protocol/user-count-tokens.mjs'

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-key-models-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, store: new ApiKeyStore({ dataDir: dir }) }
}

function managed(allowed, extra = {}) {
  return {
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'key-1', user_id: 'u-admin', allowed_models: JSON.stringify(allowed), ...extra },
  }
}

test('write side trims, drops blanks and dedupes case-insensitively; bad input is invalid_allowed_models', () => {
  assert.deepEqual(normalizeKeyAllowedModels([' claude-haiku-4-5 ', '', '  ', 'CLAUDE-HAIKU-4-5', 'gpt-6-sol']), [
    'claude-haiku-4-5',
    'gpt-6-sol',
  ])
  assert.deepEqual(normalizeKeyAllowedModels(null), [])
  assert.deepEqual(normalizeKeyAllowedModels(undefined), [])
  assert.deepEqual(normalizeKeyAllowedModels([]), [])
  const many = Array.from({ length: KEY_ALLOWED_MODELS_MAX }, (_, i) => `model-${i}`)
  assert.equal(normalizeKeyAllowedModels(many).length, KEY_ALLOWED_MODELS_MAX)
  for (const bad of [
    'gpt-6-sol',
    'a,b',
    { model: 'x' },
    3,
    [1],
    ['ok', null],
    [...many, 'one-more'],
    ['x'.repeat(129)],
  ]) {
    assert.throws(
      () => normalizeKeyAllowedModels(bad),
      (e) => e.code === 'invalid_allowed_models',
      JSON.stringify(bad),
    )
  }
})

test('read side tolerates legacy and broken values as no limit', () => {
  assert.deepEqual(parseKeyAllowedModels(undefined), [])
  assert.deepEqual(parseKeyAllowedModels(''), [])
  assert.deepEqual(parseKeyAllowedModels('[]'), [])
  assert.deepEqual(parseKeyAllowedModels('not json'), [])
  assert.deepEqual(parseKeyAllowedModels('["a"," b ","A"]'), ['a', 'b'])
})

test('matching is exact and case-insensitive; an empty list allows everything', () => {
  assert.equal(keyAllowsModel([], 'anything'), true)
  assert.equal(keyAllowsModel('[]', ''), true)
  const list = ['claude-haiku-4-5', 'GPT-6-Sol']
  assert.equal(keyAllowsModel(list, 'claude-haiku-4-5'), true)
  assert.equal(keyAllowsModel(list, 'CLAUDE-HAIKU-4-5'), true)
  assert.equal(keyAllowsModel(list, ' gpt-6-sol '), true)
  // No prefix, snapshot or alias widening: those are separate names.
  assert.equal(keyAllowsModel(list, 'claude-haiku-4-5-20251001'), false)
  assert.equal(keyAllowsModel(list, 'claude-haiku'), false)
  assert.equal(keyAllowsModel(list, 'gpt-6-sol-fast'), false)
  assert.equal(keyAllowsModel(list, ''), false)
  assert.equal(keyAllowsModel(list, undefined), false)
})

test("Claude Code's client-side [1m] suffix is ignored on both sides", () => {
  const list = ['claude-opus-5-5', 'claude-sonnet-5[1m]']
  assert.equal(keyAllowsModel(list, 'claude-opus-5-5[1m]'), true)
  assert.equal(keyAllowsModel(list, 'Claude-Opus-5-5[1M]'), true)
  assert.equal(keyAllowsModel(list, 'claude-sonnet-5'), true)
  assert.equal(keyAllowsModel(list, 'claude-sonnet-5[1m]'), true)
  // The suffix never widens to another model, and a bare suffix is no name.
  assert.equal(keyAllowsModel(list, 'claude-haiku-5-5[1m]'), false)
  assert.equal(keyAllowsModel(list, '[1m]'), false)
})

test('keyModelError answers in the caller protocol and ignores master and unlimited keys', () => {
  assert.equal(keyModelError({ apiKeyKind: 'master' }, 'x'), null)
  assert.equal(keyModelError({ apiKeyKind: 'master', apiKeyRecord: { allowed_models: '["y"]' } }, 'x'), null)
  assert.equal(keyModelError({}, 'x'), null)
  assert.equal(keyModelError(managed([]), 'x'), null)
  assert.equal(keyModelError(managed(['x']), 'X'), null)
  const openai = keyModelError(managed(['x']), 'y')
  assert.equal(openai.status, 400)
  assert.deepEqual(openai.body, {
    error: {
      type: 'invalid_request_error',
      code: 'api_key_model_not_allowed',
      message: '此密钥不允许使用模型 y',
      param: 'model',
    },
  })
  const anthropic = keyModelError(managed(['x']), 'y', { anthropic: true })
  assert.equal(anthropic.body.type, 'error')
  assert.equal(anthropic.body.error.type, 'invalid_request_error')
  assert.match(keyModelError(managed(['x']), '').body.error.message, /必须写明 model/)
  assert.ok(SLA_OK_ERROR_CODES.has('api_key_model_not_allowed'), 'a client scope refusal is not an SLA failure')
})

test('/v1/models keeps only listed ids for a limited key', () => {
  const catalog = {
    object: 'list',
    data: [{ id: 'claude-haiku-4-5' }, { id: 'gpt-6-sol' }, { id: 'claude-sonnet-5' }],
    source: 'model-policy',
  }
  assert.equal(filterModelCatalogForKey(catalog, { apiKeyKind: 'master' }), catalog)
  assert.equal(filterModelCatalogForKey(catalog, managed([])), catalog)
  assert.deepEqual(filterModelCatalogForKey(catalog, managed(['GPT-6-SOL', 'not-in-catalog'])), {
    object: 'list',
    data: [{ id: 'gpt-6-sol' }],
    source: 'model-policy',
  })
})

test('ApiKeyStore stores allowed_models on create, patch and reopen', (t) => {
  const { dir, store } = tmpStore(t)
  const plain = store.create({ name: 'plain' })
  assert.equal(store.getById(plain.id).allowed_models, '[]')
  assert.deepEqual(store.list().find((k) => k.id === plain.id).allowed_models, [])

  const rec = store.create({ name: 'limited', allowed_models: [' claude-haiku-4-5 ', 'Claude-Haiku-4-5', 'gpt-6-sol'] })
  assert.equal(store.getById(rec.id).allowed_models, '["claude-haiku-4-5","gpt-6-sol"]')
  assert.equal(store.authenticate(rec.key).record.allowed_models, '["claude-haiku-4-5","gpt-6-sol"]')

  store.update(rec.id, { name: 'renamed' })
  assert.deepEqual(parseKeyAllowedModels(store.getById(rec.id).allowed_models), ['claude-haiku-4-5', 'gpt-6-sol'])

  store.update(rec.id, { allowed_models: ['claude-sonnet-5'] })
  assert.deepEqual(store.list().find((k) => k.id === rec.id).allowed_models, ['claude-sonnet-5'])

  assert.throws(
    () => store.update(rec.id, { name: 'nope', allowed_models: 'claude-sonnet-5' }),
    (e) => e.code === 'invalid_allowed_models',
  )
  assert.equal(store.getById(rec.id).name, 'renamed', 'a rejected patch writes nothing')
  assert.throws(
    () => store.create({ name: 'bad', allowed_models: [42] }),
    (e) => e.code === 'invalid_allowed_models',
  )
  assert.equal(store.list().length, 2)

  const reopened = new ApiKeyStore({ dataDir: dir })
  assert.deepEqual(reopened.list().find((k) => k.id === rec.id).allowed_models, ['claude-sonnet-5'])

  store.update(rec.id, { allowed_models: null })
  assert.deepEqual(store.list().find((k) => k.id === rec.id).allowed_models, [])
  store.update(rec.id, { allowed_models: ['x'] })
  store.update(rec.id, { allowed_models: [] })
  assert.equal(store.getById(rec.id).allowed_models, '[]')
})

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    headersSent: false,
    on() {},
    once() {},
    off() {},
    write() {},
    end() {},
  }
}

/** Records how far a request got: the key gate (acquire) and the API channel pick come after the allowlist. */
function harness({ body, routing = {}, rules = [] } = {}) {
  const seen = { acquire: 0, picks: [] }
  const handler = createHandleProtocol({
    json(res, status, payload) {
      res.statusCode = status
      res.body = payload
      return payload
    },
    writeSSEHeaders() {},
    readBody: body === undefined ? readBody : async () => body,
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules },
      distill: { enabled: false },
      limits: { max_body_bytes: 1 << 20, upstream_timeout_ms: 2000 },
      paths: { data: os.tmpdir(), project: os.tmpdir() },
    },
    requestLog: { start: () => ({ request_id: 'req-key-models' }), finish() {} },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: {
      users: { getById: () => ({ role: 'admin' }) },
      acquire() {
        seen.acquire += 1
        return { ok: false, status: 429, code: 'api_key_concurrency_limit', message: 'stop here' }
      },
      release() {},
    },
    apiScheduler: {
      pick(model) {
        seen.picks.push(model)
        return { ok: false, code: 'model_not_found', message: 'stop here' }
      },
    },
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
  })
  return { handler, seen }
}

function protocolReq(key, headers = {}) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer sk-vm-test', 'user-agent': 'test-client', ...headers },
    ...key,
    once() {},
    off() {},
  }
}

const chat = (model) => ({ model, messages: [{ role: 'user', content: 'hello' }] })

for (const [protocol, pathName, envelope] of [
  ['anthropic.messages', '/v1/messages', 'error'],
  ['openai.chat', '/v1/chat/completions', undefined],
  ['openai.completions', '/v1/completions', undefined],
  ['openai.responses', '/v1/responses', undefined],
]) {
  test(`${protocol} rejects an unlisted model with 400 before any key gate or scheduling`, async () => {
    const body = protocol === 'openai.responses' ? { model: 'claude-sonnet-5', input: 'hi' } : chat('claude-sonnet-5')
    const { handler, seen } = harness({ body })
    const res = fakeRes()
    await handler.handleProtocol(protocolReq(managed(['claude-haiku-4-5'])), res, protocol, pathName)
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.type, envelope)
    assert.equal(res.body.error.type, 'invalid_request_error')
    assert.equal(res.body.error.code, 'api_key_model_not_allowed')
    assert.equal(res.body.error.message, '此密钥不允许使用模型 claude-sonnet-5')
    assert.equal(res.body.error.param, 'model')
    assert.equal(seen.acquire, 0)
    assert.deepEqual(seen.picks, [])
  })
}

test('a listed model passes the allowlist regardless of case, and an empty list never blocks', async () => {
  for (const allowed of [['CLAUDE-HAIKU-4-5'], []]) {
    const { handler, seen } = harness({ body: chat('claude-haiku-4-5') })
    const res = fakeRes()
    await handler.handleProtocol(
      protocolReq(managed(allowed, { category: 'api' })),
      res,
      'anthropic.messages',
      '/v1/messages',
    )
    assert.deepEqual(seen.picks, ['claude-haiku-4-5'], JSON.stringify(allowed))
    assert.notEqual(res.body?.error?.code, 'api_key_model_not_allowed')
  }
})

test('the allowlist judges the name the client sent, before mappings and intercept overrides', async () => {
  // API backend: a before_upstream rule rewrites the model before the channel pick.
  const rules = [
    {
      phase: 'before_upstream',
      match: { protocol: 'anthropic.messages' },
      action: { set_body_field: { model: 'claude-haiku-4-5' } },
    },
  ]
  const asAlias = harness({ body: chat('team-alias'), rules })
  await asAlias.handler.handleProtocol(
    protocolReq(managed(['team-alias'], { category: 'api' })),
    fakeRes(),
    'anthropic.messages',
    '/v1/messages',
  )
  assert.deepEqual(asAlias.seen.picks, ['claude-haiku-4-5'], 'listed alias passes; the mapped target is scheduled')

  const asTarget = harness({ body: chat('team-alias'), rules })
  const res = fakeRes()
  await asTarget.handler.handleProtocol(
    protocolReq(managed(['claude-haiku-4-5'], { category: 'api' })),
    res,
    'anthropic.messages',
    '/v1/messages',
  )
  assert.equal(res.body.error.code, 'api_key_model_not_allowed')
  assert.deepEqual(asTarget.seen.picks, [])

  // OAuth backend: a Codex model mapping to a listed target does not open the alias.
  const mapped = harness({
    body: chat('team-gpt'),
    routing: { codex: { model_mappings: { 'team-gpt': 'gpt-6-sol' } } },
  })
  const mappedRes = fakeRes()
  await mapped.handler.handleProtocol(
    protocolReq(managed(['gpt-6-sol'])),
    mappedRes,
    'openai.chat',
    '/v1/chat/completions',
  )
  assert.equal(mappedRes.statusCode, 400)
  assert.equal(mappedRes.body.error.message, '此密钥不允许使用模型 team-gpt')
  assert.equal(mapped.seen.acquire, 0)
})

function streamReq(key, payload, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))])
  req.headers = { 'content-type': 'application/json', 'user-agent': 'codex_exec/0.160.1', ...headers }
  Object.assign(req, key)
  return req
}

test('/v1/alpha/search checks the key allowlist before the key gate', async () => {
  const denied = harness()
  const res = fakeRes()
  await denied.handler.handleSearch(
    streamReq(managed(['gpt-6-sol']), { model: 'gpt-6.1-sol', commands: {} }),
    res,
    '/v1/alpha/search',
  )
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.type, undefined)
  assert.equal(res.body.error.code, 'api_key_model_not_allowed')
  assert.equal(denied.seen.acquire, 0)

  const allowed = harness()
  const ok = fakeRes()
  await allowed.handler.handleSearch(
    streamReq(managed(['GPT-6.1-SOL']), { model: 'gpt-6.1-sol', commands: {} }),
    ok,
    '/v1/alpha/search',
  )
  assert.equal(allowed.seen.acquire, 1)
  assert.equal(ok.statusCode, 429)
})

test('/v1/images checks the key allowlist, and a limited key must name the model', async () => {
  for (const [payload, expected] of [
    [{ model: 'gpt-image-2', prompt: 'x' }, '此密钥不允许使用模型 gpt-image-2'],
    [{ prompt: 'x' }, '此密钥只能调用指定模型，请求必须写明 model'],
  ]) {
    const { handler, seen } = harness()
    const res = fakeRes()
    await handler.handleImages(
      streamReq(managed(['gpt-image-2.5-flare']), payload),
      res,
      '/v1/images/generations',
      'generations',
    )
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error.message, expected)
    assert.equal(seen.acquire, 0)
  }
  const { handler, seen } = harness()
  await handler.handleImages(
    streamReq(managed(['gpt-image-2.5-flare']), { model: 'gpt-image-2.5-flare', prompt: 'x' }),
    fakeRes(),
    '/v1/images/generations',
    'generations',
  )
  assert.equal(seen.acquire, 1)
})

test('count_tokens checks the key allowlist before peeking a slot', async () => {
  const calls = []
  let peeks = 0
  const deps = {
    json: (_res, status, body) => calls.push({ status, body }),
    requireAuth: () => true,
    readBody: async () => ({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }),
    cfg: { limits: { max_body_bytes: 1024 } },
    stickyRouter: { extractPoolKey: () => null },
    getPoolScheduler: () => ({
      peekAccount: async () => {
        peeks += 1
        return { ok: true, vmId: 'vm-01', accountId: 'acc-1', vm: { credential_mode: 'setup-token' }, exec: {} }
      },
    }),
    countTokensViaWorker: async () => ({ ok: true, status: 200, body: { input_tokens: 3 } }),
  }
  await handleUserCountTokens(managed(['claude-haiku-4-5']), {}, deps)
  assert.equal(calls[0].status, 400)
  assert.equal(calls[0].body.type, 'error')
  assert.equal(calls[0].body.error.code, 'api_key_model_not_allowed')
  assert.equal(peeks, 0)
  await handleUserCountTokens(managed(['Claude-Sonnet-5']), {}, deps)
  assert.equal(calls[1].status, 200)
  assert.equal(peeks, 1)
})
