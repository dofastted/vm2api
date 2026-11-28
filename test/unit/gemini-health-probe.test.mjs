import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  DEFAULT_HEALTH_PROBE,
  HEALTH_REAL_HEADER,
  HEALTH_VIA_CACHE,
  cacheTtlSec,
  createHealthProbeMonitor,
  formatHealthSse,
  healthPlatformOf,
  isHealthShape,
  isSnapshotValid,
  normalizeHealthProbeConfig,
  resolvePlatformProbeModels,
  selectGeminiProbeModel,
  synthesizeProtocolResponse,
} from '../../src/lib/admin/health-probe.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'
import { createGeminiPublicHandler } from '../../src/lib/gemini/routes.mjs'

const unofficial = { 'user-agent': 'curl/8.5.0' }

function makeRes() {
  const res = new EventEmitter()
  res.statusCode = 0
  res.headers = {}
  res.chunks = []
  res.writableEnded = false
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = v
  }
  res.writeHead = (status, hdrs = {}) => {
    res.statusCode = status
    for (const [k, v] of Object.entries(hdrs)) res.headers[k.toLowerCase()] = v
  }
  res.write = (chunk) => {
    res.chunks.push(String(chunk))
  }
  res.end = (chunk) => {
    if (chunk !== undefined) res.chunks.push(String(chunk))
    res.writableEnded = true
    res.emit('finish')
  }
  res.bodyText = () => res.chunks.join('')
  res.bodyJson = () => JSON.parse(res.bodyText())
  return res
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

test('Google health probe defaults off with 1-hour interval (3600s), clamps bounds, and migrates legacy gemini block', () => {
  assert.equal(DEFAULT_HEALTH_PROBE.google.enabled, false)
  assert.equal(DEFAULT_HEALTH_PROBE.google.interval_sec, 3600)
  assert.equal(DEFAULT_HEALTH_PROBE.google.cache_ttl_sec, 5400)
  assert.deepEqual(DEFAULT_HEALTH_PROBE.google.models, [])
  assert.equal(DEFAULT_HEALTH_PROBE.google.all_models, false)

  // Legacy format { enabled: true, gemini: { ... } } migrates cleanly into google block.
  const normalized = normalizeHealthProbeConfig({
    enabled: true,
    gemini: { interval_sec: 10, cache_ttl_sec: 999999, model: ' gemini-3-flash ' },
  })
  assert.equal(normalized.google.enabled, true)
  assert.equal(normalized.google.interval_sec, 60)
  assert.equal(normalized.google.cache_ttl_sec, 172800)
  assert.deepEqual(normalized.google.models, ['gemini-3-flash'])
  assert.equal(normalized.gemini.model, 'gemini-3-flash')

  // Raising interval above default TTL without explicit cache_ttl_sec auto-aligns TTL
  const longInterval = normalizeHealthProbeConfig({
    google: { enabled: true, interval_sec: 7200 },
  })
  assert.equal(longInterval.google.interval_sec, 7200)
  assert.equal(longInterval.google.cache_ttl_sec, 7200)
  assert.equal(cacheTtlSec(longInterval, 'google'), 7200)
  assert.equal(cacheTtlSec(longInterval, 'gemini'), 7200)
  assert.equal(cacheTtlSec(longInterval, 'anthropic'), 900)
})

test('applyHealthProbeRoutingBody deep-merges google and legacy gemini patches without dropping siblings', () => {
  let routingConfig = {
    health_probe: normalizeHealthProbeConfig({
      enabled: true,
      real: { openai_model: 'gpt-5.4' },
      gemini: { interval_sec: 3600, cache_ttl_sec: 5400, model: 'gemini-3-flash' },
    }),
  }
  let applied = null
  const runtime = createRoutingRuntime({
    getRoutingConfig: () => routingConfig,
    setRoutingConfig: (next) => {
      routingConfig = next
    },
    getHealthMonitor: () => ({
      setConfig: (next) => {
        applied = next
      },
    }),
  })
  runtime.applyHealthProbeRoutingBody({ health_probe: { gemini: { interval_sec: 1800 } } }, routingConfig.health_probe)
  assert.equal(routingConfig.health_probe.enabled, true)
  assert.equal(routingConfig.health_probe.real.openai_model, 'gpt-5.4')
  assert.equal(routingConfig.health_probe.google.interval_sec, 1800)
  assert.equal(routingConfig.health_probe.google.cache_ttl_sec, 5400)
  assert.deepEqual(routingConfig.health_probe.google.models, ['gemini-3-flash'])
  assert.equal(routingConfig.health_probe.gemini.interval_sec, 1800)
  assert.equal(applied.google.interval_sec, 1800)

  // New canonical google patch updates models & all_models while preserving anthropic/openai.
  runtime.applyHealthProbeRoutingBody(
    { health_probe: { google: { all_models: true, models: ['gemini-3-flash', 'gemini-3.1-pro'] } } },
    routingConfig.health_probe,
  )
  assert.equal(routingConfig.health_probe.google.all_models, true)
  assert.deepEqual(routingConfig.health_probe.google.models, ['gemini-3-flash', 'gemini-3.1-pro'])
  assert.equal(routingConfig.health_probe.openai.enabled, true)
  assert.deepEqual(routingConfig.health_probe.openai.models, ['gpt-5.4'])
})

test('healthPlatformOf and isHealthShape recognize Google Gemini models and native payloads', () => {
  const cfg = normalizeHealthProbeConfig({ google: { enabled: true } })
  assert.equal(healthPlatformOf({ model: 'gemini-3-flash' }), 'google')
  assert.equal(healthPlatformOf({ model: 'models/gemini-2.5-pro' }), 'google')
  assert.equal(healthPlatformOf({}, 'gemini-4-neon'), 'google')
  assert.equal(healthPlatformOf({ model: 'claude-sonnet-4-6' }), 'anthropic')
  assert.equal(healthPlatformOf({ model: 'gpt-5.4' }), 'openai')

  // Native Google Gemini payload without maxOutputTokens
  const nativeHi = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
  assert.equal(isHealthShape(unofficial, nativeHi, cfg, 'google.gemini'), true)
  assert.equal(
    isHealthShape(unofficial, { ...nativeHi, generationConfig: { maxOutputTokens: 16 } }, cfg, 'google.gemini'),
    true,
  )
  assert.equal(
    isHealthShape(unofficial, { ...nativeHi, generationConfig: { maxOutputTokens: 2048 } }, cfg, 'google.gemini'),
    false,
  )
  assert.equal(
    isHealthShape(
      unofficial,
      { ...nativeHi, systemInstruction: { parts: [{ text: 'You are a helpful assistant' }] } },
      cfg,
      'google.gemini',
    ),
    false,
  )
  assert.equal(
    isHealthShape(
      unofficial,
      { ...nativeHi, tools: [{ functionDeclarations: [{ name: 'search' }] }] },
      cfg,
      'google.gemini',
    ),
    false,
  )
  assert.equal(
    isHealthShape(
      unofficial,
      {
        contents: [{ role: 'user', parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/png', data: 'AA==' } }] }],
      },
      cfg,
      'google.gemini',
    ),
    false,
  )
  assert.equal(isHealthShape({ ...unofficial, [HEALTH_REAL_HEADER]: '1' }, nativeHi, cfg, 'google.gemini'), false)
  assert.equal(
    isHealthShape(
      unofficial,
      { contents: [{ role: 'user', parts: [{ text: 'Explain relativity' }] }] },
      cfg,
      'google.gemini',
    ),
    false,
  )
})

test('selectGeminiProbeModel and Google all_models intersect enabled policy with online catalog', () => {
  const catalog = {
    models: [
      { id: 'ag-claude-sonnet-4-6-high' },
      { id: 'gemini-3.1-pro-high' },
      { id: 'gemini-3.1-pro-low' },
      { id: 'gemini-3-flash' },
      { id: 'gemini-3.5-flash-lite' },
    ],
  }
  assert.equal(selectGeminiProbeModel(catalog, normalizeHealthProbeConfig()), 'gemini-3.5-flash-lite')
  assert.equal(
    selectGeminiProbeModel(
      { models: [{ id: 'gemini-3.1-pro-high' }, { id: 'gemini-3-flash' }] },
      normalizeHealthProbeConfig(),
    ),
    'gemini-3-flash',
  )
  assert.equal(
    selectGeminiProbeModel(catalog, normalizeHealthProbeConfig({ google: { models: ['gemini-4-neon'] } })),
    'gemini-4-neon',
  )
  assert.equal(
    selectGeminiProbeModel({ models: [{ id: 'ag-claude-sonnet-4-6-high' }] }, normalizeHealthProbeConfig()),
    null,
  )

  const allCfg = normalizeHealthProbeConfig({ google: { enabled: true, all_models: true } })
  const resolved = resolvePlatformProbeModels('google', allCfg, {
    geminiCatalog: catalog,
    listPlatformModels: () => [
      { id: 'gemini-4-neon', enabled: true },
      { id: 'gemini-3.1-pro', enabled: true },
      { id: 'gemini-3-flash', enabled: true },
      { id: 'gemini-3.5-flash-lite', enabled: false },
    ],
  })
  // Only enabled policy models supported by live accounts are probed; effort variants deduplicate per base.
  assert.deepEqual(resolved, ['gemini-3.1-pro-high', 'gemini-3-flash'])
})

test('Google multi-model probe runs on independent 1-hour TTL with strict per-model isolation', async () => {
  let nowMs = Date.parse('2026-11-25T00:00:00.000Z')
  const probedModels = []
  const monitor = createHealthProbeMonitor({
    config: {
      run_on_start: false,
      anthropic: { enabled: true, interval_sec: 600, cache_ttl_sec: 900, models: ['claude-haiku-4-5'] },
      google: { enabled: true, interval_sec: 3600, cache_ttl_sec: 5400, models: ['gemini-3-flash', 'gemini-3.1-pro'] },
    },
    now: () => nowMs,
    listTargets: () => [{ id: 'vm-01', platform: 'anthropic', schedulable: true, status: 'running', has_token: true }],
    runChat: async () => ({
      ok: true,
      status: 200,
      text: 'claude-ok',
      vm_id: 'vm-01',
      model: 'claude-haiku-4-5',
      body: {
        id: 'msg_claude_1',
        content: [{ type: 'text', text: 'claude-ok' }],
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    }),
    listGeminiTargets: async () => ({
      accounts: [{ id: 'gem-env-1', models: ['gemini-3-flash', 'gemini-3.1-pro-high'] }],
      models: [{ id: 'gemini-3.1-pro-high' }, { id: 'gemini-3-flash' }],
    }),
    runGeminiProbe: async ({ model }) => {
      probedModels.push(model)
      return {
        ok: true,
        status: 200,
        text: `hello from ${model}`,
        account_id: 'gem-env-1',
        model,
        usage: { input_tokens: 5, output_tokens: 4 },
      }
    },
  })

  await monitor.runRealProbe()
  assert.deepEqual(probedModels, ['gemini-3-flash', 'gemini-3.1-pro'])

  const snaps = monitor.getSnapshots()
  assert.equal(snaps.google.ok, true)
  assert.equal(snaps.google.total_models, 2)
  assert.equal(snaps.google.ok_models, 2)
  assert.equal(snaps.google.cache_ttl_sec, 5400)
  assert.equal(snaps.google.next_at, '2026-11-25T01:00:00.000Z')
  assert.equal(snaps.gemini.ok, true)
  assert.equal(snaps.anthropic.next_at, '2026-11-25T00:10:00.000Z')

  // After 45 minutes (2700s): Claude cache (900s) is stale, Google cache (5400s) is still valid.
  nowMs += 2700_000
  assert.equal(isSnapshotValid(monitor.rawSnapshot('anthropic'), monitor.getConfig(), nowMs, 'anthropic'), false)
  assert.equal(
    isSnapshotValid(monitor.rawSnapshot('google', 'gemini-3-flash'), monitor.getConfig(), nowMs, 'google'),
    true,
  )

  // Effort variant `gemini-3.1-pro-high` matches its own base model snapshot `gemini-3.1-pro`.
  const hitProVariant = monitor.decide(
    unofficial,
    { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    'google.gemini',
    { model: 'gemini-3.1-pro-high' },
  )
  assert.equal(hitProVariant.action, 'cache')
  assert.equal(hitProVariant.via, HEALTH_VIA_CACHE)
  assert.equal(hitProVariant.snapshot.text, 'hello from gemini-3.1-pro')

  const googleResp = synthesizeProtocolResponse(
    'google.gemini',
    { model: 'gemini-3.1-pro-high' },
    hitProVariant.snapshot,
    monitor.getConfig(),
  )
  assert.equal(googleResp.modelVersion, 'gemini-3.1-pro-high')
  assert.equal(googleResp.candidates[0].content.parts[0].text, 'hello from gemini-3.1-pro')
  assert.equal(googleResp.usageMetadata.totalTokenCount, 9)

  const googleSse = formatHealthSse(
    'google.gemini',
    { model: 'gemini-3.1-pro-high' },
    hitProVariant.snapshot,
    monitor.getConfig(),
  )
  assert.match(googleSse, /^data: \{.*hello from gemini-3\.1-pro.*\}\n\n$/)

  // Uncached Google model `gemini-4-neon` must NOT replay `gemini-3-flash` or `gemini-3.1-pro`.
  assert.equal(
    monitor.decide(unofficial, { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, 'google.gemini', {
      model: 'gemini-4-neon',
    }).action,
    'pass',
  )

  // Disabling Google health cache passes through even for previously cached models.
  monitor.setConfig(
    { ...monitor.getConfig(), google: { ...monitor.getConfig().google, enabled: false } },
    { restart: false },
  )
  assert.equal(
    monitor.decide(unofficial, { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, 'google.gemini', {
      model: 'gemini-3-flash',
    }).action,
    'pass',
  )
  monitor.stop()
})

test('createGeminiPublicHandler replays per-model Google cache and passes uncached models to scheduler', async () => {
  let schedulerCalls = 0
  const finishedLogs = []
  const monitor = createHealthProbeMonitor({
    config: {
      run_on_start: false,
      google: { enabled: true, all_models: true },
    },
    listPlatformModels: () => [
      { id: 'gemini-3-flash', enabled: true },
      { id: 'gemini-3.1-pro', enabled: true },
    ],
    listGeminiTargets: async () => ({
      accounts: [{ id: 'env-a', models: ['gemini-3-flash', 'gemini-3.1-pro-high'] }],
      models: [{ id: 'gemini-3-flash' }, { id: 'gemini-3.1-pro-high' }],
    }),
    runGeminiProbe: async ({ model }) => ({
      ok: true,
      status: 200,
      text: `pong:${model}`,
      account_id: 'env-a',
      model,
      usage: { input_tokens: 4, output_tokens: 3 },
    }),
  })
  await monitor.runRealProbe({ platform: 'google' })

  const handler = createGeminiPublicHandler({
    json: sendJson,
    readBody: async (req) => req.body,
    scheduler: {
      catalog: async () => ({
        accounts: [{ id: 'env-a' }],
        models: [{ id: 'gemini-3-flash' }, { id: 'gemini-3.1-pro-high' }, { id: 'gemini-4-neon' }],
      }),
      stream: async ({ model }) => {
        schedulerCalls += 1
        return {
          text: `live:${model}`,
          parts: [{ kind: 'text', text: `live:${model}` }],
          toolCalls: [],
          model,
          account_id: 'env-a',
          usage: { input_tokens: 10, output_tokens: 5 },
          stopReason: 'end_turn',
        }
      },
    },
    requestLog: {
      start: () => ({ request_id: 'req-gem-hp-1', t0: Date.now() }),
      finish: (_ctx, bag) => finishedLogs.push(bag),
    },
    getHealthMonitor: () => monitor,
  })

  // 1. Native non-stream generateContent on cached model -> cache hit
  {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/v1beta/models/gemini-3-flash:generateContent'
    req.headers = { 'user-agent': 'curl/8.5.0' }
    req.apiKeyKind = 'managed'
    req.apiKeyRecord = { id: 'k1', group_type: 'gemini' }
    req.body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
    const res = makeRes()
    await handler(req, res)
    assert.equal(res.statusCode, 200)
    const data = res.bodyJson()
    assert.equal(data.modelVersion, 'gemini-3-flash')
    assert.equal(data.candidates[0].content.parts[0].text, 'pong:gemini-3-flash')
    assert.equal(schedulerCalls, 0)
    assert.equal(finishedLogs.at(-1).via, HEALTH_VIA_CACHE)
    assert.equal(finishedLogs.at(-1).attempt_count, 0)
  }

  // 2. Native streamGenerateContent on cached pro model -> SSE cache hit with pro's own snapshot
  {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/v1beta/models/gemini-3.1-pro-high:streamGenerateContent?alt=sse'
    req.headers = { 'user-agent': 'curl/8.5.0' }
    req.apiKeyKind = 'managed'
    req.apiKeyRecord = { id: 'k1', group_type: 'gemini' }
    req.body = { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }
    const res = makeRes()
    await handler(req, res)
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /text\/event-stream/)
    assert.match(res.bodyText(), /pong:gemini-3\.1-pro-high/)
    assert.equal(schedulerCalls, 0)
  }

  // 3. OpenAI Chat protocol on cached model -> cache hit
  {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/v1/chat/completions'
    req.headers = { 'user-agent': 'curl/8.5.0' }
    req.apiKeyKind = 'managed'
    req.apiKeyRecord = { id: 'k1', group_type: 'gemini' }
    req.body = { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'hello' }] }
    const res = makeRes()
    await handler(req, res)
    assert.equal(res.statusCode, 200)
    const data = res.bodyJson()
    assert.equal(data.object, 'chat.completion')
    assert.equal(data.model, 'gemini-3-flash')
    assert.equal(data.choices[0].message.content, 'pong:gemini-3-flash')
    assert.equal(schedulerCalls, 0)
  }

  // 4. Uncached model `gemini-4-neon` passes through to live scheduler (strict per-model isolation)
  {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/v1/chat/completions'
    req.headers = { 'user-agent': 'curl/8.5.0' }
    req.apiKeyKind = 'managed'
    req.apiKeyRecord = { id: 'k1', group_type: 'gemini' }
    req.body = { model: 'gemini-4-neon', messages: [{ role: 'user', content: 'hello' }] }
    const res = makeRes()
    await handler(req, res)
    assert.equal(res.statusCode, 200)
    const data = res.bodyJson()
    assert.equal(data.choices[0].message.content, 'live:gemini-4-neon')
    assert.equal(schedulerCalls, 1)
  }

  // 5. Bypass header hits live scheduler even for a cached model
  {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/v1beta/models/gemini-3-flash:generateContent'
    req.headers = { 'user-agent': 'curl/8.5.0', [HEALTH_REAL_HEADER]: '1' }
    req.apiKeyKind = 'managed'
    req.apiKeyRecord = { id: 'k1', group_type: 'gemini' }
    req.body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
    const res = makeRes()
    await handler(req, res)
    assert.equal(res.statusCode, 200)
    assert.equal(schedulerCalls, 2)
  }

  monitor.stop()
})

test('health probes never run concurrently across models, slots, platforms, or simultaneous triggers', async () => {
  let active = 0
  let maxActive = 0
  const events = []
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))

  const monitor = createHealthProbeMonitor({
    config: {
      run_on_start: false,
      anthropic: {
        enabled: true,
        probe_all_slots: true,
        models: ['claude-haiku-4-5', 'claude-sonnet-4-6'],
      },
      openai: {
        enabled: true,
        models: ['gpt-5.4'],
      },
      google: {
        enabled: true,
        models: ['gemini-3-flash', 'gemini-3.1-pro'],
      },
    },
    listTargets: () => [
      { id: 'vm-a', platform: 'anthropic', schedulable: true, status: 'running', has_token: true },
      { id: 'vm-b', platform: 'anthropic', schedulable: true, status: 'running', has_token: true },
      { id: 'vm-codex', platform: 'openai', schedulable: true, status: 'running', has_token: true },
    ],
    runChat: async (vm, real) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      events.push(`start:${vm.id}:${real.model}`)
      await delay(10)
      events.push(`end:${vm.id}:${real.model}`)
      active -= 1
      return {
        ok: true,
        status: 200,
        text: vm.id,
        vm_id: vm.id,
        model: real.model,
        body: {
          id: `msg_${vm.id}_${real.model}`,
          content: [{ type: 'text', text: vm.id }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }
    },
    listGeminiTargets: async () => ({
      accounts: [{ id: 'gem-1', models: ['gemini-3-flash', 'gemini-3.1-pro'] }],
      models: [{ id: 'gemini-3-flash' }, { id: 'gemini-3.1-pro' }],
    }),
    runGeminiProbe: async ({ model }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      events.push(`start:google:${model}`)
      await delay(10)
      events.push(`end:google:${model}`)
      active -= 1
      return {
        ok: true,
        status: 200,
        text: 'gem-ok',
        account_id: 'gem-1',
        model,
        usage: { input_tokens: 2, output_tokens: 2 },
      }
    },
  })

  // Simultaneous platform triggers must still execute strictly one after another.
  await Promise.all([
    monitor.runRealProbe({ platform: 'anthropic' }),
    monitor.runRealProbe({ platform: 'openai' }),
    monitor.runRealProbe({ platform: 'google' }),
  ])
  assert.equal(maxActive, 1)
  assert.deepEqual(events, [
    'start:vm-a:claude-haiku-4-5',
    'end:vm-a:claude-haiku-4-5',
    'start:vm-b:claude-haiku-4-5',
    'end:vm-b:claude-haiku-4-5',
    'start:vm-a:claude-sonnet-4-6',
    'end:vm-a:claude-sonnet-4-6',
    'start:vm-b:claude-sonnet-4-6',
    'end:vm-b:claude-sonnet-4-6',
    'start:vm-codex:gpt-5.4',
    'end:vm-codex:gpt-5.4',
    'start:google:gemini-3-flash',
    'end:google:gemini-3-flash',
    'start:google:gemini-3.1-pro',
    'end:google:gemini-3.1-pro',
  ])

  // Full runRealProbe() must also execute strictly serially.
  events.length = 0
  await monitor.runRealProbe()
  assert.equal(maxActive, 1)
  assert.equal(events.length, 14)
  monitor.stop()
})
