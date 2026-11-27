import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'
import { calculateCost } from '../../src/lib/admin/pricing.mjs'
import { resolvePrice, setPriceCatalogTestHooks } from '../../src/lib/admin/price-catalog.mjs'
import {
  classifyAntigravityModel,
  isAntigravityRoutedModel,
  resolveUpstreamModel,
} from '../../src/lib/gemini/model-catalog.mjs'
import { createGeminiPanelHandler, createGeminiPublicHandler } from '../../src/lib/gemini/routes.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { createMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'
import { FULL_GEMINI_CAPABILITIES, NATIVE_TUI_CAPABILITIES } from '../../src/lib/protocol/gemini-convert.mjs'

function makeRes() {
  const res = new EventEmitter()
  res.headers = {}
  res.statusCode = 200
  res.chunks = []
  res.writableEnded = false
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v
  }
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status
    for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = v
  }
  res.write = (chunk) => {
    res.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }
  res.end = (chunk) => {
    if (chunk) res.write(chunk)
    res.writableEnded = true
    res.emit('finish')
    res.emit('close')
  }
  res.bodyText = () => res.chunks.join('')
  res.jsonBody = () => JSON.parse(res.bodyText())
  return res
}

function makeReq({ method = 'POST', url, body, headers = {}, groupType = 'gemini', apiKeyKind = 'managed' }) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.body = body
  req.headers = headers
  req.apiKeyKind = apiKeyKind
  req.apiKeyRecord = { id: 'key-1', user_id: 7, group_id: 2, group_type: groupType }
  return req
}

function jsonResponder(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function sseResponse(frames, { statusCode = 200, contentType = 'text/event-stream; charset=utf-8' } = {}) {
  const stream = new Readable({ read() {} })
  stream.statusCode = statusCode
  stream.headers = { 'content-type': contentType }
  queueMicrotask(() => {
    for (const frame of frames) {
      if (stream.destroyed) return
      stream.push(frame)
    }
    if (!stream.destroyed) stream.push(null)
  })
  return stream
}

test('model-catalog SSOT splits Google/Anthropic/OpenAI families and enforces ag- prefix boundary', () => {
  const gem = classifyAntigravityModel('gemini-4-neon')
  assert.deepEqual(gem, {
    id: 'gemini-4-neon',
    public_id: 'gemini-4-neon',
    provider: 'google',
    owned_by: 'google',
    quota_group: 'gemini',
  })

  const argon = classifyAntigravityModel('gemini-4-argon')
  assert.equal(argon.quota_group, 'gemini-argon-wtu')

  const claude = classifyAntigravityModel('claude-sonnet-4-6-high')
  assert.deepEqual(claude, {
    id: 'claude-sonnet-4-6-high',
    public_id: 'ag-claude-sonnet-4-6-high',
    provider: 'anthropic',
    owned_by: 'anthropic',
    quota_group: '3p',
  })

  const gpt = classifyAntigravityModel('gpt-oss-120b-medium')
  assert.deepEqual(gpt, {
    id: 'gpt-oss-120b-medium',
    public_id: 'ag-gpt-oss-120b-medium',
    provider: 'openai',
    owned_by: 'openai',
    quota_group: '3p',
  })

  // Routing boundary for `all` keys: ONLY gemini-* and ag-* route to Antigravity.
  assert.equal(isAntigravityRoutedModel('gemini-4-neon'), true)
  assert.equal(isAntigravityRoutedModel('ag-claude-sonnet-4-6-high'), true)
  assert.equal(isAntigravityRoutedModel('ag-gpt-oss-120b-medium'), true)
  assert.equal(isAntigravityRoutedModel('claude-sonnet-4-6'), false)
  assert.equal(isAntigravityRoutedModel('claude-opus-4-6'), false)
  assert.equal(isAntigravityRoutedModel('gpt-5.4'), false)

  const rawModels = ['gemini-4-neon', 'claude-sonnet-4-6-high', 'gpt-oss-120b-medium']
  const hitPrefixed = resolveUpstreamModel('ag-claude-sonnet-4-6-high', rawModels, {
    allowUnprefixedNonGemini: false,
  })
  assert.equal(hitPrefixed.publicId, 'ag-claude-sonnet-4-6-high')
  assert.equal(hitPrefixed.upstreamModel, 'claude-sonnet-4-6-high')
  assert.equal(hitPrefixed.quotaGroup, '3p')

  // `all` keys (allowUnprefixedNonGemini: false) never resolve bare `claude-*`.
  assert.equal(resolveUpstreamModel('claude-sonnet-4-6-high', rawModels, { allowUnprefixedNonGemini: false }), null)
  // Dedicated `gemini` keys remain backwards-compatible with bare slugs.
  const hitLegacy = resolveUpstreamModel('claude-sonnet-4-6-high', rawModels, { allowUnprefixedNonGemini: true })
  assert.equal(hitLegacy.upstreamModel, 'claude-sonnet-4-6-high')
})

test('scheduler isolates 3p 429 cooldown from gemini quota group and automatically fails over across accounts', async () => {
  let clock = 1_700_000_000_000
  const calls = []
  const envs = [
    {
      id: 'env-a',
      proxy_id: 'px-1',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-4-neon', 'claude-sonnet-4-6-high'],
      capabilities: [...NATIVE_TUI_CAPABILITIES],
      account: {
        state: 'ok',
        model_catalog: [
          { id: 'gemini-4-neon', provider: 'google', quota_group: 'gemini' },
          { id: 'claude-sonnet-4-6-high', provider: 'anthropic', quota_group: '3p' },
        ],
        quotas: [],
        quota_groups: [],
      },
    },
    {
      id: 'env-b',
      proxy_id: 'px-2',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-4-neon', 'claude-sonnet-4-6-high'],
      capabilities: [...NATIVE_TUI_CAPABILITIES],
      account: {
        state: 'ok',
        model_catalog: [
          { id: 'gemini-4-neon', provider: 'google', quota_group: 'gemini' },
          { id: 'claude-sonnet-4-6-high', provider: 'anthropic', quota_group: '3p' },
        ],
        quotas: [],
        quota_groups: [],
      },
    },
  ]

  const scheduler = createGeminiScheduler({
    now: () => clock,
    quotaCooldownMs: 60_000,
    rateLimitRetryDelayMs: 0,
    schedulerRuntime: createMockSchedulerRuntime({ now: () => clock, quotaCooldownMs: 60_000 }),
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return envs.find((e) => e.id === payload.id)
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async (_op, payload) => {
      calls.push({ id: payload.id, model: payload.model })
      // env-a returns 429 ONLY for claude-sonnet-4-6-high (3p bucket)
      if (payload.id === 'env-a' && payload.model === 'claude-sonnet-4-6-high') {
        return sseResponse([JSON.stringify({ code: 'gemini_quota_exhausted', message: '3p quota exhausted' })], {
          statusCode: 429,
          contentType: 'application/json',
        })
      }
      return sseResponse([
        `data: ${JSON.stringify({
          candidates: [
            { content: { role: 'model', parts: [{ text: `reply-from-${payload.id}` }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
        })}\n\n`,
      ])
    },
    resolveProxy: () => 'socks5h://192.0.2.10:1080',
  })

  // Catalog splits models into Google vs ag- prefixed Anthropic with accurate owned_by.
  const catalog = await scheduler.catalog()
  assert.deepEqual(catalog.models, [
    { id: 'gemini-4-neon', object: 'model', owned_by: 'google' },
    { id: 'ag-claude-sonnet-4-6-high', object: 'model', owned_by: 'anthropic' },
  ])

  // 1. Call ag-claude-sonnet-4-6-high -> env-a hits 429 -> seamlessly fails over to env-b with stripped upstream slug!
  const turn1 = await scheduler.stream({
    model: 'ag-claude-sonnet-4-6-high',
    geminiBody: { model: 'ag-claude-sonnet-4-6-high', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    apiKeyRecord: { id: 'k-all', group_type: 'all' },
  })
  assert.equal(turn1.account_id, 'env-b')
  assert.equal(turn1.model, 'ag-claude-sonnet-4-6-high')
  assert.equal(turn1.upstream_model, 'claude-sonnet-4-6-high')
  assert.equal(turn1.text, 'reply-from-env-b')
  assert.deepEqual(calls, [
    { id: 'env-a', model: 'claude-sonnet-4-6-high' },
    { id: 'env-a', model: 'claude-sonnet-4-6-high' },
    { id: 'env-b', model: 'claude-sonnet-4-6-high' },
  ])

  // 2. Second call to ag-claude-sonnet-4-6-high within 60s skips env-a completely (0 wasted 429 hits).
  clock += 5_000
  const turn2 = await scheduler.stream({
    model: 'ag-claude-sonnet-4-6-high',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hi 2' }] }] },
    apiKeyRecord: { id: 'k-all', group_type: 'all' },
  })
  assert.equal(turn2.account_id, 'env-b')
  assert.equal(calls.length, 4)
  assert.equal(calls[3].id, 'env-b')

  // 3. Call to gemini-4-neon within the same 60s window STILL schedules env-a because `gemini` quota group is NOT cooled!
  const turn3 = await scheduler.stream({
    model: 'gemini-4-neon',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hi gemini' }] }] },
    apiKeyRecord: { id: 'k-all', group_type: 'all' },
  })
  assert.equal(turn3.account_id, 'env-a')
  assert.equal(turn3.model, 'gemini-4-neon')
  assert.equal(turn3.upstream_model, 'gemini-4-neon')
})

test('scheduler skips proactively exhausted accounts and fails over on verification_required', async () => {
  const futureReset = new Date(Date.now() + 3600_000).toISOString()
  const envs = [
    {
      id: 'env-exhausted',
      proxy_id: 'px-1',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-4-neon', 'claude-sonnet-4-6-high'],
      capabilities: [...NATIVE_TUI_CAPABILITIES],
      account: {
        state: 'ok',
        quotas: [{ model: 'claude-sonnet-4-6-high', remaining_fraction: 0, reset_at: futureReset }],
        quota_groups: [],
      },
    },
    {
      id: 'env-a-verify-fail',
      proxy_id: 'px-2',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-4-neon', 'claude-sonnet-4-6-high'],
      capabilities: [...NATIVE_TUI_CAPABILITIES],
      account: { state: 'ok', quotas: [], quota_groups: [] },
    },
    {
      id: 'env-b-healthy',
      proxy_id: 'px-3',
      auth_state: 'authorized',
      auth_method: 'oauth',
      models_discovered: true,
      models: ['gemini-4-neon', 'claude-sonnet-4-6-high'],
      capabilities: [...NATIVE_TUI_CAPABILITIES],
      account: { state: 'ok', quotas: [], quota_groups: [] },
    },
  ]

  const attempted = []
  const scheduler = createGeminiScheduler({
    schedulerRuntime: createMockSchedulerRuntime(),
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return envs.find((e) => e.id === payload.id)
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async (_op, payload) => {
      attempted.push(payload.id)
      if (payload.id === 'env-a-verify-fail') {
        return sseResponse([JSON.stringify({ code: 'gemini_account_verification_required' })], {
          statusCode: 403,
          contentType: 'application/json',
        })
      }
      return sseResponse([
        `data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'healthy-ok' }] }, finishReason: 'STOP' }],
        })}\n\n`,
      ])
    },
    resolveProxy: () => 'socks5h://192.0.2.10:1080',
  })

  const turn = await scheduler.stream({
    model: 'ag-claude-sonnet-4-6-high',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    apiKeyRecord: { id: 'k-all', group_type: 'all' },
  })
  assert.equal(turn.account_id, 'env-b-healthy')
  // env-exhausted was skipped proactively; env-a-verify-fail failed over cleanly to env-b-healthy!
  assert.deepEqual(attempted, ['env-a-verify-fail', 'env-b-healthy'])
})

test('Gemini builtin pricing & ag- prefix cost resolution cover Google, Anthropic, and OpenAI variants', () => {
  const store = {}
  setPriceCatalogTestHooks({
    settings: { get: (k, d = null) => (k in store ? store[k] : d), set: (k, v) => (store[k] = v) },
    backgroundRefresh: false,
  })
  try {
    // Google Gemini base + effort suffix + long-context tier
    const neon = resolvePrice('gemini-4-neon-high')
    assert.equal(neon.platform, 'google')
    assert.equal(neon.id, 'gemini-4-neon')
    const neonCost = calculateCost(
      { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000 },
      'gemini-4-neon-high',
    )
    assert.equal(neonCost.known, true)
    assert.equal(neonCost.long_context, true)
    assert.equal(neonCost.input_cost, 4)
    assert.equal(neonCost.output_cost, 18)
    assert.equal(neonCost.cache_read_cost, 0.4)

    // Antigravity-prefixed Anthropic Claude reuses exact Anthropic rate table
    const agClaude = resolvePrice('ag-claude-sonnet-4-6-high')
    assert.equal(agClaude.platform, 'anthropic')
    assert.equal(agClaude.id, 'claude-sonnet-4-6')
    const agClaudeCost = calculateCost(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      'ag-claude-sonnet-4-6-high',
    )
    assert.equal(agClaudeCost.known, true)
    assert.equal(agClaudeCost.input_cost, 3)
    assert.equal(agClaudeCost.output_cost, 15)

    // Antigravity-prefixed OpenAI OSS reuses OpenAI rate table
    const agGpt = resolvePrice('ag-gpt-oss-120b-medium')
    assert.equal(agGpt.platform, 'openai')
    assert.equal(agGpt.id, 'gpt-oss-120b')
  } finally {
    setPriceCatalogTestHooks(null)
  }
})

test('Gemini public handler records requestLog once on direct calls and populates external logBag without double logging', async () => {
  const started = []
  const finished = []
  const mockRequestLog = {
    start(req, meta) {
      const ctx = { id: `ctx-${started.length + 1}`, req, meta }
      started.push(ctx)
      return ctx
    },
    finish(ctx, extra) {
      finished.push({ ctx, extra })
    },
  }
  const scheduler = createGeminiScheduler({
    schedulerRuntime: createMockSchedulerRuntime(),
    callHost: async (op) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              id: 'env-1',
              proxy_id: 'px-1',
              auth_state: 'authorized',
              auth_method: 'api_key',
              models_discovered: true,
              models: ['gemini-4-neon', 'claude-sonnet-4-6-high'],
              capabilities: [...FULL_GEMINI_CAPABILITIES],
            },
          ],
        }
      }
      if (op === 'get') return { id: 'env-1', proxy_id: 'px-1', auth_method: 'api_key' }
      throw new Error(`unexpected op ${op}`)
    },
    callHostStream: async () =>
      sseResponse([
        `data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'logged-ok' }] }, finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: 100,
            cachedContentTokenCount: 20,
            candidatesTokenCount: 40,
            totalTokenCount: 140,
          },
        })}\n\n`,
      ]),
    resolveProxy: () => 'socks5h://192.0.2.10:1080',
  })

  const handler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async () => ({}),
    scheduler,
    requestLog: mockRequestLog,
    groupsRepo: { rateMultiplier: () => 1.5 },
    apiKeyStore: { users: { getById: () => ({ id: 7, role: 'admin' }) } },
  })

  // 1. Direct call (e.g. /v1beta/models/... with `all` key) writes one requestLog entry.
  const res1 = makeRes()
  await handler(
    makeReq({
      url: '/v1beta/models/gemini-4-neon:generateContent',
      groupType: 'all',
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    }),
    res1,
  )
  assert.equal(res1.statusCode, 200)
  assert.equal(started.length, 1)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].extra.model, 'gemini-4-neon')
  assert.equal(finished[0].extra.upstream_model, 'gemini-4-neon')
  assert.equal(finished[0].extra.account_id, 'env-1')
  assert.equal(finished[0].extra.vm_id, 'gemini:env-1')
  assert.equal(finished[0].extra.via, 'gemini_api_key')
  assert.equal(finished[0].extra.rate_multiplier, 1.5)
  assert.equal(finished[0].extra.usage.input_tokens, 80)
  assert.equal(finished[0].extra.usage.cache_read_tokens, 20)
  assert.equal(finished[0].extra.usage.output_tokens, 40)

  // 2. Delegated call (from handle-protocol.mjs with external logBag) populates logBag without calling requestLog.finish again.
  const externalLogBag = {}
  const res2 = makeRes()
  await handler(
    makeReq({
      url: '/v1/messages',
      groupType: 'all',
      body: { model: 'ag-claude-sonnet-4-6-high', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    }),
    res2,
    { logBag: externalLogBag },
  )
  assert.equal(res2.statusCode, 200)
  assert.equal(res2.jsonBody().model, 'ag-claude-sonnet-4-6-high')
  assert.equal(started.length, 1)
  assert.equal(finished.length, 1)
  assert.equal(externalLogBag.model, 'ag-claude-sonnet-4-6-high')
  assert.equal(externalLogBag.upstream_model, 'claude-sonnet-4-6-high')
  assert.equal(externalLogBag.vm_id, 'gemini:env-1')

  // 3. Panel handler exposes billing_ready ONLY when control plane enables it (still ignores untrusted host value).
  const panelWithBilling = createGeminiPanelHandler({
    json: (_res, status, body) => ({ status, body }),
    readBody: async () => ({}),
    billingReady: true,
    callHost: async () => ({
      payload_state: 'installed',
      environments: [
        {
          id: 'env-1',
          proxy_id: 'px-1',
          auth_state: 'authorized',
          auth_method: 'oauth',
          models: ['gemini-4-neon'],
          billing_ready: false,
          account: {
            state: 'ok',
            model_catalog: [{ id: 'gemini-4-neon', provider: 'google', quota_group: 'gemini' }],
          },
        },
      ],
    }),
  })
  const listed = await panelWithBilling({ method: 'GET' }, { setHeader() {} }, '/api/panel/gemini')
  assert.equal(listed.body.data.environments[0].billing_ready, true)
  assert.deepEqual(listed.body.data.environments[0].account.model_catalog, [
    { id: 'gemini-4-neon', provider: 'google', quota_group: 'gemini' },
  ])
})
