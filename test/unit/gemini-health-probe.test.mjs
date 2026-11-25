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

test('Gemini health probe defaults to 1-hour interval (3600s) and clamps bounds', () => {
  assert.equal(DEFAULT_HEALTH_PROBE.gemini.enabled, true)
  assert.equal(DEFAULT_HEALTH_PROBE.gemini.interval_sec, 3600)
  assert.equal(DEFAULT_HEALTH_PROBE.gemini.cache_ttl_sec, 5400)
  assert.equal(DEFAULT_HEALTH_PROBE.gemini.model, '')

  const normalized = normalizeHealthProbeConfig({
    enabled: true,
    gemini: { interval_sec: 10, cache_ttl_sec: 999999, model: ' gemini-3-flash ' },
  })
  assert.equal(normalized.gemini.interval_sec, 60)
  assert.equal(normalized.gemini.cache_ttl_sec, 172800)
  assert.equal(normalized.gemini.model, 'gemini-3-flash')

  // Raising interval above default TTL without explicit cache_ttl_sec auto-aligns TTL
  const longInterval = normalizeHealthProbeConfig({
    gemini: { interval_sec: 7200 },
  })
  assert.equal(longInterval.gemini.interval_sec, 7200)
  assert.equal(longInterval.gemini.cache_ttl_sec, 7200)
  assert.equal(cacheTtlSec(longInterval, 'gemini'), 7200)
  assert.equal(cacheTtlSec(longInterval, 'anthropic'), 900)
})

test('applyHealthProbeRoutingBody deep-merges health_probe.gemini without dropping siblings', () => {
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
  assert.equal(routingConfig.health_probe.gemini.interval_sec, 1800)
  assert.equal(routingConfig.health_probe.gemini.cache_ttl_sec, 5400)
  assert.equal(routingConfig.health_probe.gemini.model, 'gemini-3-flash')
  assert.equal(applied.gemini.interval_sec, 1800)
})

test('healthPlatformOf and isHealthShape recognize Gemini series models and native payloads', () => {
  const cfg = normalizeHealthProbeConfig({ enabled: true })
  assert.equal(healthPlatformOf({ model: 'gemini-3-flash' }), 'gemini')
  assert.equal(healthPlatformOf({ model: 'models/gemini-2.5-pro' }), 'gemini')
  assert.equal(healthPlatformOf({}, 'gemini-4-neon'), 'gemini')
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

test('selectGeminiProbeModel respects explicit config or picks lightweight Gemini model', () => {
  const catalog = {
    models: [
      { id: 'ag-claude-sonnet-4-6-high' },
      { id: 'gemini-3.1-pro-high' },
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
    selectGeminiProbeModel(catalog, normalizeHealthProbeConfig({ gemini: { model: 'gemini-4-neon' } })),
    'gemini-4-neon',
  )
  assert.equal(
    selectGeminiProbeModel({ models: [{ id: 'ag-claude-sonnet-4-6-high' }] }, normalizeHealthProbeConfig()),
    null,
  )
})

test('monitor runs Gemini probe on independent 1-hour TTL and serves all Gemini models from cache', async () => {
  let nowMs = Date.parse('2026-11-25T00:00:00.000Z')
  let geminiCalls = 0
  let probedModel = null
  const monitor = createHealthProbeMonitor({
    config: { enabled: true, interval_sec: 600, cache_ttl_sec: 900, run_on_start: false },
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
      geminiCalls += 1
      probedModel = model
      return {
        ok: true,
        status: 200,
        text: 'hello from gemini cache',
        account_id: 'gem-env-1',
        model,
        usage: { input_tokens: 5, output_tokens: 4 },
      }
    },
  })

  await monitor.runRealProbe()
  assert.equal(geminiCalls, 1)
  assert.equal(probedModel, 'gemini-3-flash')

  const snaps = monitor.getSnapshots()
  assert.equal(snaps.gemini.ok, true)
  assert.equal(snaps.gemini.vm_id, 'gemini:gem-env-1')
  assert.equal(snaps.gemini.model, 'gemini-3-flash')
  assert.equal(snaps.gemini.cache_ttl_sec, 5400)
  assert.equal(snaps.gemini.next_at, '2026-11-25T01:00:00.000Z')
  assert.equal(snaps.anthropic.next_at, '2026-11-25T00:10:00.000Z')

  // After 45 minutes (2700s): Claude cache (900s) is stale, Gemini cache (5400s) is still valid!
  nowMs += 2700_000
  assert.equal(isSnapshotValid(monitor.rawSnapshot('anthropic'), monitor.getConfig(), nowMs, 'anthropic'), false)
  assert.equal(isSnapshotValid(monitor.rawSnapshot('gemini'), monitor.getConfig(), nowMs, 'gemini'), true)

  const hitNative = monitor.decide(
    unofficial,
    { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    'google.gemini',
    { model: 'gemini-3.1-pro-high' },
  )
  assert.equal(hitNative.action, 'cache')
  assert.equal(hitNative.via, HEALTH_VIA_CACHE)

  const googleResp = synthesizeProtocolResponse(
    'google.gemini',
    { model: 'gemini-3.1-pro-high' },
    hitNative.snapshot,
    monitor.getConfig(),
  )
  assert.equal(googleResp.modelVersion, 'gemini-3.1-pro-high')
  assert.equal(googleResp.candidates[0].content.parts[0].text, 'hello from gemini cache')
  assert.equal(googleResp.usageMetadata.totalTokenCount, 9)

  const googleSse = formatHealthSse(
    'google.gemini',
    { model: 'gemini-3.1-pro-high' },
    hitNative.snapshot,
    monitor.getConfig(),
  )
  assert.match(googleSse, /^data: \{.*hello from gemini cache.*\}\n\n$/)

  const chatResp = synthesizeProtocolResponse(
    'openai.chat',
    { model: 'gemini-4-neon' },
    hitNative.snapshot,
    monitor.getConfig(),
  )
  assert.equal(chatResp.model, 'gemini-4-neon')
  assert.equal(chatResp.choices[0].message.content, 'hello from gemini cache')

  // Disabling Gemini health cache passes through
  monitor.setConfig(
    { ...monitor.getConfig(), gemini: { ...monitor.getConfig().gemini, enabled: false } },
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

test('createGeminiPublicHandler returns cached Gemini health response across protocols without calling scheduler', async () => {
  let schedulerCalls = 0
  const finishedLogs = []
  const monitor = createHealthProbeMonitor({
    config: { enabled: true, run_on_start: false },
    listGeminiTargets: async () => ({
      accounts: [{ id: 'env-a', models: ['gemini-3-flash'] }],
      models: [{ id: 'gemini-3-flash' }],
    }),
    runGeminiProbe: async ({ model }) => ({
      ok: true,
      status: 200,
      text: 'pong-gemini',
      account_id: 'env-a',
      model,
      usage: { input_tokens: 4, output_tokens: 3 },
    }),
  })
  await monitor.runRealProbe({ platform: 'gemini' })

  const handler = createGeminiPublicHandler({
    json: sendJson,
    readBody: async (req) => req.body,
    scheduler: {
      catalog: async () => ({ accounts: [{ id: 'env-a' }], models: [{ id: 'gemini-3-flash' }] }),
      stream: async ({ model }) => {
        schedulerCalls += 1
        return {
          text: 'live-upstream',
          parts: [{ kind: 'text', text: 'live-upstream' }],
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

  // 1. Native non-stream generateContent -> cache hit
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
    assert.equal(data.candidates[0].content.parts[0].text, 'pong-gemini')
    assert.equal(schedulerCalls, 0)
    assert.equal(finishedLogs.at(-1).via, HEALTH_VIA_CACHE)
    assert.equal(finishedLogs.at(-1).attempt_count, 0)
  }

  // 2. Native streamGenerateContent -> SSE cache hit
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
    assert.match(res.bodyText(), /pong-gemini/)
    assert.match(res.bodyText(), /gemini-3\.1-pro-high/)
    assert.equal(schedulerCalls, 0)
  }

  // 3. OpenAI Chat protocol with Gemini model -> cache hit
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
    assert.equal(data.object, 'chat.completion')
    assert.equal(data.model, 'gemini-4-neon')
    assert.equal(data.choices[0].message.content, 'pong-gemini')
    assert.equal(schedulerCalls, 0)
  }

  // 4. Bypass header hits live scheduler
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
    assert.equal(schedulerCalls, 1)
  }

  monitor.stop()
})

test('health probes never run concurrently across slots, platforms, or simultaneous triggers', async () => {
  let active = 0
  let maxActive = 0
  const events = []
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))

  const monitor = createHealthProbeMonitor({
    config: {
      enabled: true,
      probe_all_slots: true,
      concurrency: 4,
      run_on_start: false,
      real: { openai_model: 'gpt-5.4' },
    },
    listTargets: () => [
      { id: 'vm-a', platform: 'anthropic', schedulable: true, status: 'running', has_token: true },
      { id: 'vm-b', platform: 'anthropic', schedulable: true, status: 'running', has_token: true },
      { id: 'vm-codex', platform: 'openai', schedulable: true, status: 'running', has_token: true },
    ],
    runChat: async (vm, real) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      events.push(`start:${vm.id}`)
      await delay(15)
      events.push(`end:${vm.id}`)
      active -= 1
      return {
        ok: true,
        status: 200,
        text: vm.id,
        vm_id: vm.id,
        model: real.model,
        body: {
          id: `msg_${vm.id}`,
          content: [{ type: 'text', text: vm.id }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }
    },
    listGeminiTargets: async () => ({
      accounts: [{ id: 'gem-1', models: ['gemini-3-flash'] }],
      models: [{ id: 'gemini-3-flash' }],
    }),
    runGeminiProbe: async ({ model }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      events.push('start:gemini')
      await delay(15)
      events.push('end:gemini')
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

  // Simultaneous fleet + gemini triggers must still execute strictly one after another.
  await Promise.all([monitor.runRealProbe({ platform: 'fleet' }), monitor.runRealProbe({ platform: 'gemini' })])
  assert.equal(maxActive, 1)
  assert.deepEqual(events, [
    'start:vm-a',
    'end:vm-a',
    'start:vm-b',
    'end:vm-b',
    'start:vm-codex',
    'end:vm-codex',
    'start:gemini',
    'end:gemini',
  ])

  // Full runRealProbe() must also execute strictly serially.
  events.length = 0
  await monitor.runRealProbe()
  assert.equal(maxActive, 1)
  assert.deepEqual(events, [
    'start:vm-a',
    'end:vm-a',
    'start:vm-b',
    'end:vm-b',
    'start:vm-codex',
    'end:vm-codex',
    'start:gemini',
    'end:gemini',
  ])
  monitor.stop()
})
