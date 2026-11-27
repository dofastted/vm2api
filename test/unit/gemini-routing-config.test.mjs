import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import {
  DEFAULT_GEMINI_ROUTING,
  isGeminiProtocolAllowed,
  mergeGeminiRouting,
  normalizeGeminiRouting,
  validateGeminiRoutingPatch,
} from '../../src/lib/gemini/routing-config.mjs'
import { createGeminiPanelHandler, createGeminiPublicHandler } from '../../src/lib/gemini/routes.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { createMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'

test('routing-config defaults, validation, merge, and protocol gating', () => {
  const def = normalizeGeminiRouting({})
  assert.equal(def.enabled, true)
  assert.equal(def.pool.strategy, 'balanced')
  assert.equal(def.pool.accounts_per_daemon, 50)
  assert.equal(def.pool.daemon_fault_isolation, true)
  assert.equal(def.pool.max_concurrency_per_account, 20)
  assert.equal(def.pool.max_sessions_per_account, 20)
  assert.equal(def.pool.eligibility_probe_interval_secs, 180)
  assert.equal(def.shm.require_shm, true)
  assert.equal(def.shm.request_mb, 4)
  assert.equal(def.shm.response_mb, 16)

  assert.throws(() => validateGeminiRoutingPatch({ gemini: { pool: { max_sessions_per_account: 0 } } }), {
    code: 'invalid_gemini_pool',
  })
  assert.throws(() => validateGeminiRoutingPatch({ gemini: { pool: { eligibility_probe_interval_secs: 10 } } }), {
    code: 'invalid_gemini_pool',
  })

  assert.throws(() => validateGeminiRoutingPatch({ gemini: { pool: { strategy: 'random' } } }), {
    code: 'invalid_gemini_pool',
  })
  assert.throws(() => validateGeminiRoutingPatch({ gemini: { pool: { accounts_per_daemon: 0 } } }), {
    code: 'invalid_gemini_pool',
  })
  assert.throws(
    () =>
      validateGeminiRoutingPatch({
        gemini: { pool: { max_concurrency_per_account: 2, min_warm_slots: 4 } },
      }),
    { code: 'invalid_gemini_pool' },
  )
  assert.throws(() => validateGeminiRoutingPatch({ gemini: { shm: { request_mb: 128 } } }), {
    code: 'invalid_gemini_shm',
  })

  const merged = mergeGeminiRouting(DEFAULT_GEMINI_ROUTING, {
    pool: { strategy: 'fill', accounts_per_daemon: 25, max_concurrency_per_account: 4 },
    sticky: { enabled: false },
    protocols: { 'openai.chat': { mode: 'convert', enabled: false } },
  })
  assert.equal(merged.pool.strategy, 'fill')
  assert.equal(merged.pool.accounts_per_daemon, 25)
  assert.equal(merged.pool.max_concurrency_per_account, 4)
  assert.equal(merged.sticky.enabled, false)
  assert.equal(isGeminiProtocolAllowed('openai.chat', merged).ok, false)
  assert.equal(isGeminiProtocolAllowed('google.gemini', merged).ok, true)

  const disabled = mergeGeminiRouting(merged, { enabled: false })
  const disabledCheck = isGeminiProtocolAllowed('google.gemini', disabled)
  assert.equal(disabledCheck.ok, false)
  assert.equal(disabledCheck.code, 'gemini_disabled')
  assert.equal(disabledCheck.status, 403)
})

test('Gemini scheduler honors balanced, fill, round_robin, sticky TTL, and gateway_policy', async () => {
  const envs = [
    {
      id: 'gemini-a',
      name: 'A',
      proxy_id: 'px-1',
      auth_state: 'authorized',
      auth_method: 'oauth',
      runtime_ready: true,
      models_discovered: true,
      max_concurrency: 4,
      capabilities: ['streaming'],
      models: ['gemini-3-pro'],
    },
    {
      id: 'gemini-b',
      name: 'B',
      proxy_id: 'px-1',
      auth_state: 'authorized',
      auth_method: 'oauth',
      runtime_ready: true,
      models_discovered: true,
      max_concurrency: 4,
      capabilities: ['streaming'],
      models: ['gemini-3-pro'],
    },
    {
      id: 'gemini-c',
      name: 'C',
      proxy_id: 'px-1',
      auth_state: 'authorized',
      auth_method: 'oauth',
      runtime_ready: true,
      models_discovered: true,
      max_concurrency: 4,
      capabilities: ['streaming'],
      models: ['gemini-3-pro'],
    },
  ]

  let routing = {
    gemini: mergeGeminiRouting(DEFAULT_GEMINI_ROUTING, {
      pool: {
        strategy: 'balanced',
        queue_timeout_ms: 8_000,
        first_byte_timeout_ms: 45_000,
        idle_timeout_ms: 22_000,
      },
      sticky: { enabled: true, ttl_seconds: 600 },
    }),
  }

  const dispatched = []
  let holdRelease = null
  const scheduler = createGeminiScheduler({
    schedulerRuntime: createMockSchedulerRuntime({ getRoutingConfig: () => routing, maxConcurrency: 4 }),
    resolveProxy: () => 'socks5h://u:p@192.0.2.11:1080',
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return envs.find((e) => e.id === payload?.id) || null
      return {}
    },
    callHostStream: async (_op, payload) => {
      dispatched.push(payload)
      const wait = holdRelease
      holdRelease = null
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        async *[Symbol.asyncIterator]() {
          if (wait) await wait
          yield Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n')
        },
        destroy() {},
      }
    },
    getRoutingConfig: () => routing,
  })

  // Hold 1 in-flight request on gemini-a, then balanced picks an idle account (gemini-b).
  let releaseHold
  holdRelease = new Promise((resolve) => {
    releaseHold = resolve
  })
  const heldPromise = scheduler.complete({ model: 'gemini-3-pro', prompt: 'hold' })
  await new Promise((r) => setTimeout(r, 15))
  const rBalanced = await scheduler.complete({
    model: 'gemini-3-pro',
    prompt: 'hi',
    stickyKey: 'conv-42',
  })
  assert.notEqual(rBalanced.account_id, 'gemini-a')
  assert.equal(dispatched[0].gateway_policy.queue_wait_ms, 8_000)
  assert.equal(dispatched[0].gateway_policy.first_byte_timeout_ms, 45_000)
  assert.equal(dispatched[0].gateway_policy.stream_idle_timeout_ms, 22_000)

  // Fill: while gemini-a still has 1 active slot (<4), fill concentrates onto gemini-a.
  routing = {
    gemini: mergeGeminiRouting(routing.gemini, { pool: { strategy: 'fill' } }),
  }
  const rFill = await scheduler.complete({ model: 'gemini-3-pro', prompt: 'fill-hit' })
  assert.equal(rFill.account_id, 'gemini-a')

  // Sticky still keeps conv-42 on its pinned account even under fill.
  const rSticky = await scheduler.complete({
    model: 'gemini-3-pro',
    prompt: 'follow-up',
    stickyKey: 'conv-42',
  })
  assert.equal(rSticky.account_id, rBalanced.account_id)
  releaseHold()
  await heldPromise

  // Round-robin cycles through all 3 candidates when sticky is disabled.
  routing = {
    gemini: mergeGeminiRouting(routing.gemini, {
      pool: { strategy: 'round_robin' },
      sticky: { enabled: false },
    }),
  }
  const rrPicks = new Set()
  for (let i = 0; i < 3; i++) {
    const res = await scheduler.complete({ model: 'gemini-3-pro', prompt: `rr-${i}` })
    rrPicks.add(res.account_id)
  }
  assert.equal(rrPicks.size, 3)
})

test('Gemini panel daemon-status, daemon-action, and public protocol gating', async () => {
  assert.equal(authorizePanelRoute('GET', '/api/panel/gemini/daemon-status', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/gemini/daemon-status', 'admin').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/gemini/daemon-action', 'super').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/gemini/daemon-action', 'admin').ok, true)

  const calls = []
  const panel = createGeminiPanelHandler({
    json: (_res, status, body) => ({ status, body }),
    readBody: async (req) => req.body,
    proxyPool: () => ({ snapshot: () => ({ proxies: [] }) }),
    callHost: async (op, payload) => {
      calls.push([op, payload])
      if (op === 'daemon-status') {
        return { mode: 'sharded', accounts_per_daemon: 50, shards: [] }
      }
      return { ok: true, action: payload.action }
    },
  })
  const res = { setHeader() {} }
  const statusRes = await panel({ method: 'GET' }, res, '/api/panel/gemini/daemon-status')
  assert.equal(statusRes.status, 200)
  assert.equal(statusRes.body.data.available, true)
  assert.equal(statusRes.body.data.accounts_per_daemon, 50)

  const badAction = await panel(
    { method: 'POST', body: { action: 'drop_all' } },
    res,
    '/api/panel/gemini/daemon-action',
  )
  assert.equal(badAction.status, 400)

  const goodAction = await panel(
    { method: 'POST', body: { action: 'rebalance' } },
    res,
    '/api/panel/gemini/daemon-action',
  )
  assert.equal(goodAction.status, 200)
  assert.equal(goodAction.body.data.ok, true)

  // Public route protocol gate
  let routing = {
    gemini: mergeGeminiRouting(DEFAULT_GEMINI_ROUTING, {
      protocols: { 'google.gemini.session': { mode: 'native', enabled: false } },
    }),
  }
  const pub = createGeminiPublicHandler({
    json: (_res, status, body) => ({ status, body }),
    readBody: async () => ({ model: 'gemini-3-pro', input: 'hello' }),
    scheduler: {
      catalog: async () => ({ models: [{ id: 'gemini-3-pro' }] }),
      complete: async () => assert.fail('disabled protocol must not dispatch'),
    },
    getRoutingConfig: () => routing,
  })
  const blocked = await pub(
    {
      method: 'POST',
      url: '/v1/gemini/sessions/turn-1',
      apiKeyKind: 'managed',
      apiKeyRecord: { group_type: 'gemini' },
      headers: {},
      once() {},
    },
    { setHeader() {}, once() {} },
  )
  assert.equal(blocked.status, 403)
  assert.equal(blocked.body.error.code, 'gemini_protocol_disabled')
})

test('Gemini host sharded daemon policy, capacity=50 sharding, and fault isolation', { timeout: 15_000 }, () => {
  execFileSync('python3', ['-B', fileURLToPath(new URL('./gemini-host-shards.py', import.meta.url))], {
    stdio: 'pipe',
    timeout: 12_000,
  })
})
