import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isClientStream } from '../../src/lib/protocol/convert.mjs'
import {
  normalizeHealthProbeConfig,
  isHealthShape,
  isSnapshotValid,
  decideHealthIntercept,
  inboundMatchesCacheModels,
  synthesizeProtocolResponse,
  formatHealthSse,
  healthUnavailableError,
  selectHealthProbeTargets,
  selectHealthProbeTargetsForModel,
  canonicalHealthModelKey,
  listPlatformCatalogModels,
  resolvePlatformProbeModels,
  createHealthProbeMonitor,
  hasCachedMessage,
  HEALTH_REAL_HEADER,
  HEALTH_VIA_CACHE,
  HEALTH_VIA_UNAVAILABLE,
  DEFAULT_HEALTH_PROBE,
} from '../../src/lib/admin/health-probe.mjs'

// The cache switch ships off. Intercept cases opt in.
const cfg = normalizeHealthProbeConfig({ enabled: true })

const unofficial = { 'user-agent': 'Go-http-client/2.0' }
const hiBody = {
  model: 'claude-haiku-4-5',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hi' }],
}

const cachedBody = {
  id: 'msg_01CachedHelloFromProbe',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5',
  content: [{ type: 'text', text: 'hello from cache' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 6 },
}

function cachedSnap(extra = {}) {
  return {
    ok: true,
    at: '2026-08-23T23:55:00.000Z',
    text: 'hello from cache',
    vm_id: 'vm-30',
    model: 'claude-haiku-4-5',
    body: { ...cachedBody },
    ...extra,
  }
}

test('probe cache ships off and can be turned on', () => {
  assert.equal(DEFAULT_HEALTH_PROBE.enabled, false)
  assert.equal(normalizeHealthProbeConfig().enabled, false)
  assert.equal(normalizeHealthProbeConfig({ enabled: false }).enabled, false)
  // Off means a third-party hello runs a real probe instead of a replay.
  assert.equal(
    decideHealthIntercept({
      headers: unofficial,
      body: hiBody,
      cfg: normalizeHealthProbeConfig({ enabled: false }),
      snapshot: cachedSnap(),
    }).action,
    'pass',
  )
})

test('normalize fills defaults and clamps', () => {
  const n = normalizeHealthProbeConfig({ interval_sec: 5, real: { outbound_mode: 'rewrite', max_tokens: 0 } })
  assert.equal(n.interval_sec, 30)
  assert.equal(n.probe_all_slots, false)
  assert.equal(n.concurrency, 1)
  assert.equal(normalizeHealthProbeConfig({ probe_all_slots: true, concurrency: 99 }).concurrency, 1)
  assert.equal(n.real.outbound_mode, 'official')
  assert.equal(n.real.prompt, 'hello')
  assert.equal(n.real.max_tokens, 64)
  assert.equal(normalizeHealthProbeConfig({ real: { outbound_mode: 'lite' } }).real.outbound_mode, 'official')
  assert.equal(normalizeHealthProbeConfig({ real: { outbound_mode: 'unofficial' } }).real.outbound_mode, 'unofficial')
  assert.equal(n.fail_closed, true)
  assert.equal(n.cache_ttl_sec, 900)
  assert.deepEqual(n.cache_models, [])
})

test('cache_ttl_sec is the validity window and aliases max_stale_sec', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z')
  const snap = { ok: true, at: '2026-08-23T23:50:00.000Z', text: 'ok' }
  const short = normalizeHealthProbeConfig({ cache_ttl_sec: 120 })
  const long = normalizeHealthProbeConfig({ max_stale_sec: 3600 })
  assert.equal(short.cache_ttl_sec, 120)
  assert.equal(short.max_stale_sec, 120)
  assert.equal(isSnapshotValid(snap, short, now), false)
  assert.equal(isSnapshotValid(snap, long, now), true)
})

test('cache_models restrict which inbound models are intercepted', () => {
  const limited = normalizeHealthProbeConfig({ cache_models: ['claude-haiku-4-5', 'claude-sonnet-5'] })
  assert.equal(inboundMatchesCacheModels({ model: 'claude-haiku-4-5' }, limited), true)
  assert.equal(inboundMatchesCacheModels({ model: 'claude-haiku-4-5-20251001' }, limited), true)
  assert.equal(inboundMatchesCacheModels({ model: 'claude-opus-5' }, limited), false)
  const now = Date.parse('2026-08-24T00:00:00.000Z')
  const snap = cachedSnap({ text: 'pong' })
  assert.equal(
    decideHealthIntercept({
      headers: unofficial,
      body: { ...hiBody, model: 'claude-opus-5' },
      cfg: limited,
      snapshot: snap,
      now,
    }).action,
    'pass',
  )
})

test('cache_model overrides the cached response model', () => {
  const pinned = normalizeHealthProbeConfig({ cache_model: 'claude-sonnet-5' })
  const msg = synthesizeProtocolResponse('anthropic.messages', hiBody, cachedSnap(), pinned)
  assert.equal(msg.model, 'claude-sonnet-5')
  assert.equal(msg.id, cachedBody.id)
})

test('hi + 16 tokens matches', () => {
  assert.equal(isHealthShape(unofficial, hiBody, cfg), true)
  assert.equal(isHealthShape(unofficial, { ...hiBody, max_tokens: 64 }, cfg), false)
  // Omitted stream (Go omitempty) and Accept must replay JSON, not SSE.
  assert.equal(isClientStream(hiBody, unofficial), false)
  assert.equal('stream' in hiBody, false)
})

test('official Claude Code is never a health shape', () => {
  const headers = { 'user-agent': 'claude-cli/2.1.241 (external, sdk-cli)' }
  const body = {
    ...hiBody,
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
    metadata: {
      user_id: JSON.stringify({
        device_id: 'a'.repeat(64),
        account_uuid: '11111111-1111-4111-8111-111111111111',
        session_id: '22222222-2222-4222-8222-222222222222',
      }),
    },
  }
  assert.equal(isHealthShape(headers, body, cfg), false)
})

test('V13: bare official UA spoof is NOT skipped; complete verified CC headers or officialTraffic=true are skipped', () => {
  assert.equal(isHealthShape({ 'user-agent': 'claude-cli/2.1.241 (external, sdk-cli)' }, hiBody, cfg), true)
  assert.equal(
    isHealthShape({ 'user-agent': 'claude-cli/2.1.241 (external, sdk-cli)' }, hiBody, cfg, 'anthropic.messages', {
      officialTraffic: true,
    }),
    false,
  )
  const fullHeaders = {
    'user-agent': 'claude-cli/2.1.321 (external, sdk-cli)',
    'x-app': 'cli',
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'Linux',
    'x-stainless-arch': 'x64',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': 'v26.12.1',
    'x-stainless-package-version': '0.128.0',
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
    'x-claude-code-session-id': '11111111-2222-4333-8444-555555555555',
  }
  assert.equal(isHealthShape(fullHeaders, hiBody, cfg), false)
})

test('bypass header skips match', () => {
  assert.equal(isHealthShape({ ...unofficial, [HEALTH_REAL_HEADER]: '1' }, hiBody, cfg), false)
})

test('system or tools or multi-turn are not probes', () => {
  assert.equal(isHealthShape(unofficial, { ...hiBody, system: 'x' }, cfg), false)
  assert.equal(isHealthShape(unofficial, { ...hiBody, tools: [{ name: 'x' }] }, cfg), false)
  assert.equal(
    isHealthShape(
      unofficial,
      {
        ...hiBody,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'yo' },
        ],
      },
      cfg,
    ),
    false,
  )
})

test('openai chat and completions extract the short user', () => {
  assert.equal(
    isHealthShape(
      unofficial,
      {
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      },
      cfg,
    ),
    true,
  )
  assert.equal(
    isHealthShape(
      unofficial,
      {
        model: 'claude-haiku-4-5',
        max_tokens: 8,
        prompt: 'ping',
      },
      cfg,
    ),
    true,
  )
})

test('valid snapshot vs stale / failed', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z')
  const fresh = { ok: true, at: '2026-08-23T23:55:00.000Z', text: 'ok' }
  const old = { ok: true, at: '2026-08-23T23:40:00.000Z', text: 'ok' }
  const failed = { ok: false, at: '2026-08-23T23:59:00.000Z', error: 'boom' }
  assert.equal(isSnapshotValid(fresh, cfg, now), true)
  assert.equal(isSnapshotValid(old, cfg, now), false)
  assert.equal(isSnapshotValid(failed, cfg, now), false)
})

test('decide: cache when valid, pass through transient miss, 503 only when no credential', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z')
  const snap = cachedSnap({ text: 'pong', vm_id: 'vm-01' })
  const cache = decideHealthIntercept({ headers: unofficial, body: hiBody, cfg, snapshot: snap, now })
  assert.equal(cache.action, 'cache')
  assert.equal(cache.via, HEALTH_VIA_CACHE)
  const transient = decideHealthIntercept({
    headers: unofficial,
    body: hiBody,
    cfg,
    snapshot: { ok: false, at: '2026-08-23T23:59:00.000Z', error: 'OAuth access token has been revoked.' },
    now,
  })
  assert.equal(transient.action, 'pass')
  const empty = decideHealthIntercept({ headers: unofficial, body: hiBody, cfg, snapshot: null, now })
  assert.equal(empty.action, 'pass')
  const fail = decideHealthIntercept({
    headers: unofficial,
    body: hiBody,
    cfg,
    snapshot: { ok: false, at: '2026-08-23T23:59:00.000Z', error: 'no_schedulable_credential' },
    now,
  })
  assert.equal(fail.action, 'fail')
  assert.equal(fail.via, HEALTH_VIA_UNAVAILABLE)
  const pass = decideHealthIntercept({
    headers: unofficial,
    body: hiBody,
    cfg: { ...cfg, fail_closed: false },
    snapshot: { ok: false, at: '2026-08-23T23:59:00.000Z', error: 'no_schedulable_credential' },
    now,
  })
  assert.equal(pass.action, 'pass')
})

test('disabled or non-probe body passes through', () => {
  assert.equal(
    decideHealthIntercept({
      headers: unofficial,
      body: hiBody,
      cfg: { ...cfg, enabled: false },
    }).action,
    'pass',
  )
  assert.equal(
    decideHealthIntercept({
      headers: unofficial,
      body: { ...hiBody, max_tokens: 2048, messages: [{ role: 'user', content: 'write a report' }] },
      cfg,
    }).action,
    'pass',
  )
})

test('replay cached Messages and chat.completions without synthesizing msg_health_*', () => {
  const snap = cachedSnap()
  const msg = synthesizeProtocolResponse('anthropic.messages', hiBody, snap)
  assert.equal(msg.id, 'msg_01CachedHelloFromProbe')
  assert.equal(msg.type, 'message')
  assert.equal(msg.stop_reason, 'end_turn')
  assert.equal(msg.content[0].text, 'hello from cache')
  assert.equal(msg.usage.output_tokens, 6)
  assert.equal(msg.kin, undefined)
  assert.doesNotMatch(msg.id, /msg_health_/)
  const chat = synthesizeProtocolResponse('openai.chat', { model: 'claude-haiku-4-5' }, snap)
  assert.equal(chat.object, 'chat.completion')
  assert.equal(chat.choices[0].message.content, 'hello from cache')
  assert.equal(chat.usage.total_tokens, 18)
  assert.match(chat.id, /^chatcmpl-msg_01CachedHelloFromProbe$/)
  assert.equal(synthesizeProtocolResponse('anthropic.messages', hiBody, { text: 'ok' }), null)
})

test('SSE Messages and chat.completions include the cached id and text', () => {
  const snap = cachedSnap({ body: { ...cachedBody, content: [{ type: 'text', text: 'ok-cache' }] } })
  const sse = formatHealthSse('anthropic.messages', hiBody, snap)
  assert.match(sse, /event: message_stop/)
  assert.match(sse, /ok-cache/)
  assert.match(sse, /msg_01CachedHelloFromProbe/)
  assert.doesNotMatch(sse, /msg_health_/)
  const chat = formatHealthSse('openai.chat', hiBody, snap)
  assert.match(chat, /chat.completion.chunk/)
  assert.match(chat, /\[DONE\]/)
  assert.match(chat, /chatcmpl-msg_01CachedHelloFromProbe/)
})

test('text-only snapshot is not a cache hit', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z')
  const snap = { ok: true, at: '2026-08-23T23:55:00.000Z', text: 'pong', vm_id: 'vm-01' }
  assert.equal(hasCachedMessage(snap), false)
  assert.equal(decideHealthIntercept({ headers: unofficial, body: hiBody, cfg, snapshot: snap, now }).action, 'pass')
})

test('503 body has health_unavailable and optional last_error', () => {
  const err = healthUnavailableError({ at: '2026-08-24T00:00:00.000Z', error: 'no slot' }, 'req-1')
  assert.equal(err.error.code, HEALTH_VIA_UNAVAILABLE)
  assert.equal(err.error.probed_at, '2026-08-24T00:00:00.000Z')
  assert.equal(err.error.last_error, 'no slot')
  assert.equal(err.error.request_id, 'req-1')
})

test('selectHealthProbeTargets uses summary credential flags', () => {
  const vms = [
    { id: 'vm-01', schedulable: true, status: 'running', has_token: true },
    { id: 'vm-02', schedulable: true, status: 'running', has_token: false },
    { id: 'vm-03', schedulable: false, status: 'running', has_token: true },
    { id: 'vm-04', schedulable: true, status: 'running', has_refresh: true, refresh_error: 'invalid_grant' },
    {
      id: 'vm-05',
      schedulable: true,
      status: 'running',
      has_refresh: true,
      cooldown_until: Date.now() + 60_000,
      cooldown_reason: 'authentication_failed_after_refresh',
    },
  ]
  assert.deepEqual(
    selectHealthProbeTargets(vms, cfg).map((v) => v.id),
    ['vm-01'],
  )
  const pinned = normalizeHealthProbeConfig({ real: { vm_ids: ['vm-02'] } })
  assert.deepEqual(selectHealthProbeTargets(vms, pinned), [])
})

test('selectHealthProbeTargets skips slots outside their working window', () => {
  const now = Date.parse('2026-09-17T12:00:00.000Z')
  const vms = [
    {
      id: 'vm-rest',
      schedulable: true,
      status: 'running',
      has_token: true,
      active_hours: { start: '20:00', end: '08:00', timezone: 'UTC' },
    },
    {
      id: 'vm-day',
      schedulable: true,
      status: 'running',
      has_token: true,
      active_hours: { start: '08:00', end: '20:00', timezone: 'UTC' },
    },
  ]
  assert.deepEqual(
    selectHealthProbeTargets(vms, cfg, now).map((v) => v.id),
    ['vm-day'],
  )
})

for (const dataplane of ['crag', 'wrap']) {
  test(`${dataplane} setup-token import recovers from an empty probe snapshot without another probe`, async () => {
    const vm = { id: 'vm-01', status: 'running', dataplane, platform: 'anthropic', claude: {} }
    let probeCalls = 0
    const monitor = createHealthProbeMonitor({
      config: { enabled: true, fail_closed: true, real: { vm_ids: [vm.id] } },
      listTargets: () => [vm],
      runChat: async () => {
        probeCalls += 1
      },
    })
    await monitor.runRealProbe()
    assert.equal(monitor.rawSnapshot().error, 'no_schedulable_credential')
    assert.equal(monitor.decide(unofficial, hiBody).action, 'fail')

    vm.claude = { mode: 'setup-token', has_access: true, has_refresh: true }
    assert.equal(monitor.decide(unofficial, hiBody).action, 'pass')
    vm.schedulable = false
    assert.equal(monitor.decide(unofficial, hiBody).action, 'fail')
    assert.equal(probeCalls, 0)
  })
}

test('probe_all_slots probes every target but snapshot uses first list success', async () => {
  const probed = []
  const monitor = createHealthProbeMonitor({
    config: { enabled: true, probe_all_slots: true, concurrency: 2, run_on_start: false },
    listTargets: () => [
      { id: 'vm-a', schedulable: true, status: 'running', has_token: true },
      { id: 'vm-b', schedulable: true, status: 'running', has_token: true },
      { id: 'vm-c', schedulable: true, status: 'running', has_token: true },
    ],
    runChat: async (vm) => {
      probed.push(vm.id)
      return {
        ok: true,
        text: vm.id,
        vm_id: vm.id,
        status: 200,
        model: 'claude-haiku-4-5',
        body: {
          id: `msg_${vm.id}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5',
          content: [{ type: 'text', text: vm.id }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }
    },
  })
  await monitor.runRealProbe()
  assert.deepEqual(probed.sort(), ['vm-a', 'vm-b', 'vm-c'])
  assert.equal(monitor.rawSnapshot().vm_id, 'vm-a')
  assert.equal(monitor.rawSnapshot().body.id, 'msg_vm-a')
  monitor.stop()
})

test('default probe stops after first success', async () => {
  const probed = []
  const monitor = createHealthProbeMonitor({
    config: { enabled: true, run_on_start: false },
    listTargets: () => [
      { id: 'vm-a', schedulable: true, status: 'running', has_token: true },
      { id: 'vm-b', schedulable: true, status: 'running', has_token: true },
    ],
    runChat: async (vm) => {
      probed.push(vm.id)
      return {
        ok: true,
        text: 'ok',
        vm_id: vm.id,
        status: 200,
        model: 'claude-haiku-4-5',
        body: {
          id: 'msg_first',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }
    },
  })
  await monitor.runRealProbe()
  assert.deepEqual(probed, ['vm-a'])
  monitor.stop()
})

test('monitor singleflight writes snapshot and fail_closed decides fail', async () => {
  let calls = 0
  const monitor = createHealthProbeMonitor({
    config: { enabled: true, interval_sec: 600, run_on_start: false },
    listTargets: () => [{ id: 'vm-01', schedulable: true, status: 'running', has_token: true }],
    runChat: async () => {
      calls += 1
      return {
        ok: true,
        text: 'hi',
        vm_id: 'vm-01',
        status: 200,
        model: 'claude-haiku-4-5',
        body: {
          id: 'msg_01RealProbeHi',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 8, output_tokens: 2 },
        },
      }
    },
    now: () => Date.parse('2026-08-24T00:00:00.000Z'),
  })
  const [a, b] = await Promise.all([monitor.runRealProbe(), monitor.runRealProbe()])
  assert.equal(calls, 1)
  assert.equal(a.ok, true)
  assert.equal(b.vm_id, 'vm-01')
  assert.equal(a.message_id, 'msg_01RealProbeHi')
  assert.equal(monitor.rawSnapshot().body.id, 'msg_01RealProbeHi')
  const hit = monitor.decide(unofficial, hiBody)
  assert.equal(hit.action, 'cache')
  const replay = synthesizeProtocolResponse('anthropic.messages', hiBody, monitor.rawSnapshot())
  assert.equal(replay.id, 'msg_01RealProbeHi')
  assert.doesNotMatch(replay.id, /msg_health_/)
  monitor.stop()
})

test('failed real probe keeps a still-valid cached snapshot', async () => {
  let calls = 0
  const now = Date.parse('2026-08-24T00:00:00.000Z')
  const monitor = createHealthProbeMonitor({
    config: { enabled: true, interval_sec: 600, cache_ttl_sec: 900, run_on_start: false },
    listTargets: () => [{ id: 'vm-01', schedulable: true, status: 'running', has_token: true }],
    runChat: async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: true,
          text: 'hi',
          vm_id: 'vm-01',
          status: 200,
          model: 'claude-haiku-4-5',
          body: {
            id: 'msg_01KeepOnFail',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 4, output_tokens: 1 },
          },
        }
      }
      return { ok: false, error: { message: 'OAuth access token has been revoked.' }, status: 401 }
    },
    now: () => now,
  })
  const first = await monitor.runRealProbe()
  assert.equal(first.ok, true)
  const second = await monitor.runRealProbe()
  assert.equal(second.ok, true)
  assert.equal(monitor.rawSnapshot().last_error, 'OAuth access token has been revoked.')
  assert.equal(monitor.rawSnapshot().body.id, 'msg_01KeepOnFail')
  assert.equal(monitor.decide(unofficial, hiBody).action, 'cache')
  monitor.stop()
})

test('default match tokens stay below default real probe budget', () => {
  assert.ok(DEFAULT_HEALTH_PROBE.match.max_tokens < DEFAULT_HEALTH_PROBE.real.max_tokens)
})

const cc = "You are Claude Code, Anthropic's official CLI for Claude."

test('account probe matches even with a claude-cli UA', () => {
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    temperature: 1,
    stream: true,
    system: [{ type: 'text', text: cc, cache_control: { type: 'ephemeral' } }],
    metadata: { user_id: 'user_x_account__session_y' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
  }
  const headers = { 'user-agent': 'claude-cli/2.1.258 (external, cli)', 'x-app': 'cli' }
  assert.equal(isHealthShape(headers, body, cfg, 'anthropic.messages'), true)
  assert.equal(isHealthShape(headers, { ...body, max_tokens: 2048 }, cfg, 'anthropic.messages'), false)
  assert.equal(isHealthShape(headers, { ...body, tools: [{ name: 'Bash' }] }, cfg, 'anthropic.messages'), false)
  assert.equal(
    isHealthShape(
      headers,
      { ...body, messages: [{ role: 'user', content: 'refactor this' }] },
      cfg,
      'anthropic.messages',
    ),
    false,
  )
  const off = normalizeHealthProbeConfig({ enabled: true, match: { sub2api_account_test: false } })
  assert.equal(isHealthShape(headers, body, off, 'anthropic.messages'), false)
})

test('chat and responses probes match without max_tokens', () => {
  const chat = { model: 'claude-haiku-4-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(isHealthShape(unofficial, chat, cfg, 'openai.chat'), true)
  const responses = {
    model: 'gpt-5.4',
    stream: true,
    instructions: 'You are Codex, based on GPT-5. '.repeat(20),
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  }
  assert.equal(isHealthShape(unofficial, responses, cfg, 'openai.responses'), true)
  assert.equal(
    isHealthShape(unofficial, { model: 'gpt-5.4', input: [{ role: 'user', content: 'hi' }] }, cfg, 'openai.responses'),
    true,
  )
  // A missing max_tokens never counts on /v1/messages.
  assert.equal(isHealthShape(unofficial, chat, cfg, 'anthropic.messages'), false)
  // Real chat turns still pass through.
  assert.equal(
    isHealthShape(unofficial, { ...chat, messages: [{ role: 'user', content: 'write a parser' }] }, cfg, 'openai.chat'),
    false,
  )
})

test('decide routes GPT models to the openai snapshot', async () => {
  const monitor = createHealthProbeMonitor({
    config: { enabled: true, run_on_start: false, real: { openai_model: 'gpt-5.4' } },
    listTargets: () => [
      { id: 'vm-01', platform: 'anthropic', schedulable: true, status: 'running', has_token: true },
      { id: 'vm-codex', platform: 'openai', schedulable: true, status: 'running', has_token: true },
    ],
    runChat: async (vm, real) => ({
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
    }),
  })
  await monitor.runRealProbe()
  const gpt = monitor.decide(unofficial, { model: 'gpt-5.4', input: 'hi' }, 'openai.responses')
  assert.equal(gpt.action, 'cache')
  assert.equal(gpt.snapshot.vm_id, 'vm-codex')
  const claude = monitor.decide(unofficial, hiBody, 'anthropic.messages')
  assert.equal(claude.snapshot.vm_id, 'vm-01')
  assert.equal(monitor.getSnapshots().openai.ok, true)
  monitor.stop()
})

test('no openai_model leaves GPT probes to the pool', async () => {
  const monitor = createHealthProbeMonitor({
    config: { enabled: true, run_on_start: false },
    listTargets: () => [{ id: 'vm-01', platform: 'anthropic', schedulable: true, status: 'running', has_token: true }],
    runChat: async () => ({ ok: true, status: 200, text: 'x', body: { id: 'msg_x', content: [] } }),
  })
  await monitor.runRealProbe()
  assert.equal(monitor.decide(unofficial, { model: 'gpt-5.4', input: 'hi' }, 'openai.responses').action, 'pass')
  monitor.stop()
})

test('health probe streams include protocol-specific completion markers', () => {
  const snap = cachedSnap()
  const chat = formatHealthSse('openai.chat', { model: 'claude-haiku-4-5' }, snap, cfg)
  const chatData = chat.split('\n').filter((l) => l.startsWith('data: '))
  assert.equal(chatData.at(-1), 'data: [DONE]')
  const finish = JSON.parse(chatData.at(-2).slice(6))
  assert.equal(finish.choices[0].finish_reason, 'stop')
  assert.ok(finish.usage && Number.isFinite(finish.usage.prompt_tokens))

  const resp = formatHealthSse('openai.responses', { model: 'gpt-5.4' }, snap, cfg)
  const events = resp
    .split('\n')
    .filter((l) => l.startsWith('event: '))
    .map((l) => l.slice(7))
  assert.deepEqual(events, ['response.created', 'response.output_text.delta', 'response.completed'])
  const completed = JSON.parse(
    resp
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .at(-1)
      .slice(6),
  )
  assert.equal(completed.response.status, 'completed')
  assert.ok(completed.response.usage)

  const msg = formatHealthSse('anthropic.messages', hiBody, snap, cfg)
  assert.match(msg, /event: message_stop/)
})

test('three platforms configure and toggle independently without cross-coupling', async () => {
  const probed = []
  const monitor = createHealthProbeMonitor({
    config: {
      run_on_start: false,
      anthropic: { enabled: false, models: ['claude-haiku-4-5'] },
      openai: { enabled: true, interval_sec: 120, cache_ttl_sec: 300, models: ['gpt-5.4', 'gpt-5.4-mini'] },
      google: { enabled: false, models: ['gemini-3-flash'] },
    },
    listTargets: () => [
      { id: 'vm-claude', platform: 'anthropic', schedulable: true, status: 'running', has_token: true },
      { id: 'vm-codex', platform: 'openai', schedulable: true, status: 'running', has_token: true },
    ],
    runChat: async (vm, real) => {
      probed.push(`${vm.id}:${real.model}`)
      return {
        ok: true,
        status: 200,
        text: `ok:${real.model}`,
        vm_id: vm.id,
        model: real.model,
        body: {
          id: `msg_${real.model}`,
          content: [{ type: 'text', text: `ok:${real.model}` }],
          usage: { input_tokens: 2, output_tokens: 2 },
        },
      }
    },
  })

  const normalized = monitor.getConfig()
  assert.equal(normalized.enabled, true)
  assert.equal(normalized.anthropic.enabled, false)
  assert.equal(normalized.openai.enabled, true)
  assert.equal(normalized.openai.interval_sec, 120)
  assert.equal(normalized.openai.cache_ttl_sec, 300)
  assert.equal(normalized.google.enabled, false)

  await monitor.runRealProbe()
  // Only OpenAI is enabled; Anthropic and Google must not be probed.
  assert.deepEqual(probed, ['vm-codex:gpt-5.4', 'vm-codex:gpt-5.4-mini'])

  // OpenAI models hit their own per-model snapshots.
  const hit54 = monitor.decide(unofficial, { model: 'gpt-5.4', input: 'hi' }, 'openai.responses')
  assert.equal(hit54.action, 'cache')
  assert.equal(hit54.snapshot.model, 'gpt-5.4')
  assert.equal(hit54.snapshot.body.id, 'msg_gpt-5.4')

  const hitMini = monitor.decide(unofficial, { model: 'gpt-5.4-mini', input: 'hi' }, 'openai.responses')
  assert.equal(hitMini.action, 'cache')
  assert.equal(hitMini.snapshot.model, 'gpt-5.4-mini')
  assert.equal(hitMini.snapshot.body.id, 'msg_gpt-5.4-mini')

  // Uncached OpenAI model and disabled Anthropic platform pass through strictly.
  assert.equal(monitor.decide(unofficial, { model: 'gpt-5.3-codex', input: 'hi' }, 'openai.responses').action, 'pass')
  assert.equal(monitor.decide(unofficial, hiBody, 'anthropic.messages').action, 'pass')

  const openaiView = monitor.getSnapshots().openai
  assert.equal(openaiView.total_models, 2)
  assert.equal(openaiView.ok_models, 2)
  assert.equal(openaiView.failed_models, 0)
  assert.deepEqual(
    openaiView.models.map((m) => m.model),
    ['gpt-5.4', 'gpt-5.4-mini'],
  )
  monitor.stop()
})

test('strict per-model isolation and alias canonicalization on Anthropic', async () => {
  const probed = []
  const monitor = createHealthProbeMonitor({
    config: {
      run_on_start: false,
      anthropic: {
        enabled: true,
        models: ['claude-haiku-4-5', 'claude-opus-5-5'],
      },
    },
    listTargets: () => [{ id: 'vm-01', platform: 'anthropic', schedulable: true, status: 'running', has_token: true }],
    runChat: async (vm, real) => {
      probed.push(real.model)
      return {
        ok: true,
        status: 200,
        text: `reply:${real.model}`,
        vm_id: vm.id,
        model: real.model,
        body: {
          id: `msg_${real.model}`,
          content: [{ type: 'text', text: `reply:${real.model}` }],
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      }
    },
  })

  await monitor.runRealProbe({ platform: 'anthropic' })
  assert.deepEqual(probed, ['claude-haiku-4-5', 'claude-opus-5-5'])

  // Canonical aliases resolve to the exact model cache.
  const datedHaiku = monitor.decide(unofficial, { ...hiBody, model: 'claude-haiku-4-5-20251001' }, 'anthropic.messages')
  assert.equal(datedHaiku.action, 'cache')
  assert.equal(datedHaiku.snapshot.body.id, 'msg_claude-haiku-4-5')

  const dottedOpus55 = monitor.decide(unofficial, { ...hiBody, model: 'claude-opus-5.5[1m]' }, 'anthropic.messages')
  assert.equal(dottedOpus55.action, 'cache')
  assert.equal(dottedOpus55.snapshot.body.id, 'msg_claude-opus-5-5')

  // Unconfigured / different models (even prefix sibling claude-opus-5) must pass through.
  assert.equal(monitor.decide(unofficial, { ...hiBody, model: 'claude-opus-5' }, 'anthropic.messages').action, 'pass')
  assert.equal(
    monitor.decide(unofficial, { ...hiBody, model: 'claude-sonnet-4-6' }, 'anthropic.messages').action,
    'pass',
  )

  // Removing a model from config prunes its cached snapshot immediately.
  monitor.setConfig(
    {
      ...monitor.getConfig(),
      anthropic: { ...monitor.getConfig().anthropic, models: ['claude-haiku-4-5'] },
    },
    { restart: false },
  )
  assert.equal(monitor.decide(unofficial, { ...hiBody, model: 'claude-opus-5-5' }, 'anthropic.messages').action, 'pass')
  assert.equal(
    monitor.decide(unofficial, { ...hiBody, model: 'claude-haiku-4-5' }, 'anthropic.messages').action,
    'cache',
  )
  monitor.stop()
})

test('all_models mode dynamically resolves enabled models per platform with deduplication', async () => {
  const anthropicCatalog = listPlatformCatalogModels('anthropic', {
    listPlatformModels: () => [
      { id: 'auto', enabled: true, family: 'auto' },
      { id: 'claude-haiku-4-5-20251001', enabled: true, family: 'haiku' },
      { id: 'claude-haiku-4-5', enabled: true, family: 'haiku' },
      { id: 'claude-sonnet-4-6', enabled: true, family: 'sonnet' },
      { id: 'claude-opus-4-6', enabled: false, family: 'opus' },
      { id: 'gpt-5.4', enabled: true, family: 'codex' },
    ],
  })
  assert.deepEqual(
    anthropicCatalog.map((m) => m.id),
    ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
  )

  const resolvedOpenai = resolvePlatformProbeModels(
    'openai',
    normalizeHealthProbeConfig({ openai: { enabled: true, all_models: true } }),
    {
      listPlatformModels: () => [
        { id: 'gpt-5.4', enabled: true, family: 'codex' },
        { id: 'gpt-5.4-mini', enabled: true, family: 'codex' },
        { id: 'gpt-5.3-codex', enabled: false, family: 'codex' },
      ],
    },
  )
  assert.deepEqual(resolvedOpenai, ['gpt-5.4', 'gpt-5.4-mini'])
  assert.equal(
    canonicalHealthModelKey('anthropic', 'claude-haiku-4-5'),
    canonicalHealthModelKey('anthropic', 'claude-haiku-4-5-20251001'),
  )
})

test('per-model slot gating respects allowed_models and fable_requires_max', async () => {
  const vms = [
    {
      id: 'vm-pro',
      platform: 'anthropic',
      schedulable: true,
      status: 'running',
      has_token: true,
      account_tier: 'pro',
      allowed_models: ['claude-haiku-4-5-20251001'],
    },
    {
      id: 'vm-max',
      platform: 'anthropic',
      schedulable: true,
      status: 'running',
      has_token: true,
      account_tier: 'max',
    },
  ]
  const multiCfg = normalizeHealthProbeConfig({
    anthropic: { enabled: true, models: ['claude-haiku-4-5', 'claude-fable-5'] },
  })
  assert.deepEqual(
    selectHealthProbeTargetsForModel(vms, multiCfg, 'anthropic', 'claude-haiku-4-5', Date.now(), {
      fableRequiresMax: true,
    }).map((v) => v.id),
    ['vm-pro', 'vm-max'],
  )
  assert.deepEqual(
    selectHealthProbeTargetsForModel(vms, multiCfg, 'anthropic', 'claude-fable-5', Date.now(), {
      fableRequiresMax: true,
    }).map((v) => v.id),
    ['vm-max'],
  )

  const calls = []
  const monitor = createHealthProbeMonitor({
    config: { run_on_start: false, anthropic: { enabled: true, models: ['claude-fable-5'] } },
    getFableRequiresMax: () => true,
    listTargets: () => vms,
    runChat: async (vm, real) => {
      calls.push(`${vm.id}:${real.model}`)
      return {
        ok: true,
        status: 200,
        text: 'fable-ok',
        vm_id: vm.id,
        model: real.model,
        body: {
          id: 'msg_fable',
          content: [{ type: 'text', text: 'fable-ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }
    },
  })
  await monitor.runRealProbe({ platform: 'anthropic' })
  assert.deepEqual(calls, ['vm-max:claude-fable-5'])
  monitor.stop()
})

test('runRealProbe supports single-model targeted reprobe', async () => {
  const probed = []
  const monitor = createHealthProbeMonitor({
    config: {
      run_on_start: false,
      anthropic: { enabled: true, models: ['claude-haiku-4-5', 'claude-sonnet-4-6'] },
    },
    listTargets: () => [{ id: 'vm-01', platform: 'anthropic', schedulable: true, status: 'running', has_token: true }],
    runChat: async (vm, real) => {
      probed.push(real.model)
      return {
        ok: true,
        status: 200,
        text: real.model,
        vm_id: vm.id,
        model: real.model,
        body: { id: `msg_${real.model}_${probed.length}`, content: [{ type: 'text', text: real.model }] },
      }
    },
  })
  await monitor.runRealProbe({ platform: 'anthropic' })
  assert.deepEqual(probed, ['claude-haiku-4-5', 'claude-sonnet-4-6'])

  probed.length = 0
  const single = await monitor.runRealProbe({ platform: 'anthropic', model: 'claude-sonnet-4-6' })
  assert.deepEqual(probed, ['claude-sonnet-4-6'])
  assert.equal(single.ok, true)
  assert.equal(single.model, 'claude-sonnet-4-6')
  monitor.stop()
})
