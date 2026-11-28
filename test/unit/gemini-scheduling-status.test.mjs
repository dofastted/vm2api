import assert from 'node:assert/strict'
import test from 'node:test'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { normalizeStickyPlatform, scopeStickyKey } from '../../src/lib/pool/sticky-router.mjs'
import { mapCragWorkerError, buildDirectEnvelope } from '../../src/lib/gemini/direct-client.mjs'
import {
  DEFAULT_GEMINI_ROUTING,
  mergeGeminiRouting,
  normalizeGeminiRouting,
  validateGeminiRoutingPatch,
} from '../../src/lib/gemini/routing-config.mjs'
import {
  checkGeminiAccounts,
  createGeminiPanelHandler,
  createGeminiPublicHandler,
} from '../../src/lib/gemini/routes.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { createGeminiSlotPrefs } from '../../src/lib/gemini/slot-prefs.mjs'
import { SchedulerApiError } from '../../src/lib/transport/scheduler-client.mjs'

function makeMockGeminiRuntime() {
  let seq = 0
  return {
    async acquireNode(params) {
      const excluded = new Set(params.excludeNodes || [])
      const allowed = Array.isArray(params.allowedNodeKeys) ? params.allowedNodeKeys : []
      const key = allowed.find((k) => !excluded.has(k))
      if (!key) {
        throw new SchedulerApiError({
          status: 429,
          code: 'pool_exhausted',
          message: 'No gemini environment available',
          retryAfterSec: 5,
        })
      }
      const id = key.split(':').slice(1).join(':')
      return {
        lease_id: `gem-lease-${++seq}`,
        lease_ttl_ms: 30_000,
        resolved_pool_id: params.originPoolId || '__default_gemini__',
        selected_node: { node_type: 'gemini_env', node_id: id, node_key: key },
        explain: { affinity: { why: 'balanced' } },
      }
    },
    async switchNode(body) {
      return this.acquireNode(body.next_attempt || {})
    },
    async commitLease() {},
    async releaseLease() {},
  }
}

function sseResponse(chunks, { statusCode = 200, contentType = 'text/event-stream', headers = {} } = {}) {
  return {
    statusCode,
    headers: { 'content-type': contentType, ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield Buffer.from(chunk)
      }
    },
    destroy() {},
  }
}

function okSse(text) {
  return sseResponse([
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    })}\n\n`,
  ])
}

function makeEnv(id, extra = {}) {
  return {
    id,
    name: id,
    proxy_id: `px-${id}`,
    auth_state: 'authorized',
    auth_method: 'oauth',
    runtime_ready: true,
    models_discovered: true,
    max_concurrency: 4,
    capabilities: ['streaming', 'multi_turn'],
    models: ['gemini-3-pro'],
    account: { state: 'ok', checked_at: '2026-11-26T00:00:00Z', quotas: [], quota_groups: [] },
    ...extra,
  }
}

function makeMemoryStickyRouter() {
  const rows = new Map()
  return {
    rows,
    extractPoolKey(req, body, { platform } = {}) {
      const sid = req?.headers?.['x-session-id'] || body?.conversation_id || ''
      if (!sid) return null
      return scopeStickyKey(`k1:${sid}`, platform)
    },
    resolve(key, { platform } = {}) {
      const scoped = scopeStickyKey(key, platform)
      return rows.get(scoped) || null
    },
    bind(key, value, { platform } = {}) {
      const scoped = scopeStickyKey(key, platform)
      rows.set(scoped, { ...value })
    },
    unbind(key, { platform } = {}) {
      const scoped = scopeStickyKey(key, platform)
      rows.delete(scoped)
    },
  }
}

test('StickyRouter platform normalization supports gemini and routing-config validates new 502 & account check fields', () => {
  assert.equal(normalizeStickyPlatform('gemini'), 'gemini')
  assert.equal(normalizeStickyPlatform('antigravity'), 'gemini')
  assert.equal(scopeStickyKey('k1:sess-1', 'gemini'), 'p:gemini:k1:sess-1')

  const def = normalizeGeminiRouting({})
  assert.equal(def.failover.unschedulable_on_502, true)
  assert.equal(def.pool.account_check_interval_secs, 300)

  assert.throws(() => validateGeminiRoutingPatch({ gemini: { failover: { unschedulable_on_502: 'yes' } } }), {
    code: 'invalid_gemini_failover',
  })
  assert.throws(() => validateGeminiRoutingPatch({ gemini: { pool: { account_check_interval_secs: 30 } } }), {
    code: 'invalid_gemini_pool',
  })
  validateGeminiRoutingPatch({
    gemini: { failover: { unschedulable_on_502: false }, pool: { account_check_interval_secs: 0 } },
  })
  const merged = mergeGeminiRouting(DEFAULT_GEMINI_ROUTING, {
    failover: { unschedulable_on_502: false },
    pool: { account_check_interval_secs: 600 },
  })
  assert.equal(merged.failover.unschedulable_on_502, false)
  assert.equal(merged.pool.account_check_interval_secs, 600)
})

test('Req 1: Gemini sticky session reuses Codex StickyRouter, retries 429 once with restart_resume, and switches+releases sticky on second 429', async () => {
  const envs = [makeEnv('env-a'), makeEnv('env-b')]
  const stickyRouter = makeMemoryStickyRouter()
  const inferCalls = []
  let failAWith429 = false

  const stickyBySession = new Map()
  const activeLeases = new Map()
  let leaseSeq = 0
  const stickyRuntime = {
    async acquireNode(params) {
      const excluded = new Set(params.excludeNodes || [])
      const allowed = Array.isArray(params.allowedNodeKeys) ? params.allowedNodeKeys : []
      const pinned = params.sessionId ? stickyBySession.get(params.sessionId) : null
      const key =
        pinned && allowed.includes(pinned) && !excluded.has(pinned) ? pinned : allowed.find((k) => !excluded.has(k))
      if (!key) {
        throw new SchedulerApiError({
          status: 429,
          code: 'pool_exhausted',
          message: 'No gemini environment available',
          retryAfterSec: 5,
        })
      }
      const id = key.split(':').slice(1).join(':')
      const leaseId = `gem-sticky-${++leaseSeq}`
      activeLeases.set(leaseId, { sessionId: params.sessionId || null, nodeKey: key })
      return {
        lease_id: leaseId,
        lease_ttl_ms: 30_000,
        resolved_pool_id: params.originPoolId || '__default_gemini__',
        selected_node: { node_type: 'gemini_env', node_id: id, node_key: key },
        explain: { affinity: { why: pinned === key ? 'session_sticky' : 'balanced' } },
      }
    },
    async switchNode(body) {
      activeLeases.delete(body.release_lease_id)
      return this.acquireNode(body.next_attempt || {})
    },
    async commitLease(leaseId) {
      const rec = activeLeases.get(leaseId)
      if (rec?.sessionId) stickyBySession.set(rec.sessionId, rec.nodeKey)
    },
    async releaseLease(leaseId, payload) {
      const rec = activeLeases.get(leaseId)
      activeLeases.delete(leaseId)
      if (rec?.sessionId && payload?.outcome === 'ok') {
        stickyBySession.set(rec.sessionId, rec.nodeKey)
      }
    },
  }

  const scheduler = createGeminiScheduler({
    schedulerRuntime: stickyRuntime,
    stickyRouter,
    rateLimitRetryDelayMs: 0,
    resolveProxy: () => 'socks5h://u:p@192.0.2.10:1080',
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return envs.find((e) => e.id === payload.id)
      return {}
    },
    callHostStream: async (_op, payload) => {
      inferCalls.push({
        id: payload.id,
        restart_resume: payload.restart_resume === true,
        conversation_id: payload.body?.conversation_id || null,
      })
      if (payload.id === 'env-a' && failAWith429) {
        return sseResponse([JSON.stringify({ code: 'gemini_quota_exhausted', message: 'rate limited' })], {
          statusCode: 429,
          contentType: 'application/json',
        })
      }
      return okSse(`ok-from-${payload.id}`)
    },
    getRoutingConfig: () => ({ gemini: DEFAULT_GEMINI_ROUTING }),
  })

  // Turn 1 pins sticky session to env-a in Rust scheduler runtime and remembers outbound conversation_id.
  const t1 = await scheduler.complete({
    model: 'gemini-3-pro',
    text: 'first turn',
    stickyKey: 'k1:sess-429',
  })
  assert.equal(t1.account_id, 'env-a')
  assert.equal(stickyBySession.get('k1:sess-429'), 'gemini_env:env-a')
  assert.ok(t1.conversation_id, 'outbound conversation_id is minted and returned')

  // Turn 2: env-a hits 429 twice -> must actively retry env-a ONCE with restart_resume:true
  // keeping the same conversation_id, then release sticky and failover to env-b with new conv id!
  failAWith429 = true
  const beforeTurn2 = inferCalls.length
  const t2 = await scheduler.complete({
    model: 'gemini-3-pro',
    text: 'second turn hits 429',
    stickyKey: 'k1:sess-429',
  })
  assert.equal(t2.account_id, 'env-b')
  const turn2Calls = inferCalls.slice(beforeTurn2)
  assert.equal(turn2Calls.length, 3, '1st try env-a (429) -> 2nd try env-a (restart_resume 429) -> 3rd try env-b (ok)')
  assert.equal(turn2Calls[0].id, 'env-a')
  assert.equal(turn2Calls[0].restart_resume, false)
  assert.equal(turn2Calls[1].id, 'env-a')
  assert.equal(turn2Calls[1].restart_resume, true, '429 retry must request agy restart+resume once')
  assert.equal(
    turn2Calls[1].conversation_id,
    turn2Calls[0].conversation_id,
    'same-account 429 restart_resume retry must keep same conversation_id',
  )
  assert.equal(turn2Calls[2].id, 'env-b')
  assert.equal(turn2Calls[2].restart_resume, false)
  assert.notEqual(
    turn2Calls[2].conversation_id,
    turn2Calls[0].conversation_id,
    'switching account must mint a new conversation_id',
  )
  assert.equal(stickyBySession.get('k1:sess-429'), 'gemini_env:env-b', 'sticky binding migrated cleanly after failover')

  // Verify buildDirectEnvelope forwards restart_resume: true when requested.
  const envPayload = buildDirectEnvelope({
    model: 'gemini-3-pro',
    requestId: 'req-1',
    bodyObj: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    restartResume: true,
  })
  assert.equal(envPayload.restart_resume, true)
})

test('Req 2: 503 fails over without tripping circuit or unschedulable; 502 honors unschedulable_on_502 switch and prevents 502->503 loop', async () => {
  // Verify distinct 503 mapping in direct-client.
  const err503 = mapCragWorkerError(503, {
    code: 'upstream_unavailable',
    upstream_status: 503,
    error: 'upstream 503',
  })
  assert.equal(err503.code, 'gemini_upstream_unavailable')
  assert.equal(err503.status, 503)
  assert.equal(err503.upstreamStatus, 503)

  const envs = [makeEnv('env-a'), makeEnv('env-b')]
  const slotPrefs = createGeminiSlotPrefs()
  const pool = new PoolScheduler()
  pool.unitCircuit.configure({ failureThreshold: 1, openMs: 30_000 })
  const stickyRouter = makeMemoryStickyRouter()
  let routing = { gemini: mergeGeminiRouting(DEFAULT_GEMINI_ROUTING, { failover: { unschedulable_on_502: true } }) }
  let mode = '503_on_a'
  const calls = []

  const scheduler = createGeminiScheduler({
    schedulerRuntime: makeMockGeminiRuntime(),
    slotPrefs,
    poolScheduler: pool,
    stickyRouter,
    resolveProxy: () => 'socks5h://u:p@192.0.2.10:1080',
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return envs.find((e) => e.id === payload.id)
      return {}
    },
    callHostStream: async (_op, payload) => {
      calls.push(payload.id)
      if (payload.id === 'env-a' && mode === '503_on_a') {
        return sseResponse([JSON.stringify({ code: 'gemini_upstream_unavailable', message: '503 overloaded' })], {
          statusCode: 503,
          contentType: 'application/json',
        })
      }
      if (payload.id === 'env-a' && mode === '502_on_a') {
        return sseResponse([JSON.stringify({ code: 'gemini_inference_failed', message: '502 bad gateway' })], {
          statusCode: 502,
          contentType: 'application/json',
        })
      }
      return okSse(`ok-${payload.id}`)
    },
    getRoutingConfig: () => routing,
  })

  // 1. Upstream 503 on env-a -> switches to env-b, does NOT open circuit, does NOT mark unschedulable!
  const r503 = await scheduler.complete({ model: 'gemini-3-pro', text: 'test 503', stickyKey: 'k1:s503' })
  assert.equal(r503.account_id, 'env-b')
  assert.deepEqual(calls, ['env-a', 'env-b'])
  assert.equal(pool.unitCircuit.inspect('gemini:env-a').ok, true, '503 must NOT trip circuit breaker')
  assert.equal(slotPrefs.resolved('env-a').unschedulable, null, '503 must NOT mark account unschedulable')

  // Clear short 503 cooldown so env-a is eligible again, then trigger 502 with switch ON.
  scheduler.clearRestriction('env-a')
  mode = '502_on_a'
  calls.length = 0
  const r502 = await scheduler.complete({ model: 'gemini-3-pro', text: 'test 502', stickyKey: 'k1:s502' })
  assert.equal(r502.account_id, 'env-b')
  assert.equal(slotPrefs.resolved('env-a').unschedulable?.reason, 'upstream_502')
  assert.equal(pool.unitCircuit.inspect('gemini:env-a').ok, true, '502 parked cleanly without 502->503 circuit loop')

  // Next request skips env-a completely (no 502->503 loop!).
  calls.length = 0
  const rAfter = await scheduler.complete({ model: 'gemini-3-pro', text: 'after 502' })
  assert.equal(rAfter.account_id, 'env-b')
  assert.deepEqual(calls, ['env-b'])

  // Recovering env-a clears unschedulable.
  scheduler.clearRestriction('env-a')
  assert.equal(slotPrefs.resolved('env-a').unschedulable, null)

  // Now toggle unschedulable_on_502 OFF -> 502 still fails over without persisting unschedulable.
  routing = { gemini: mergeGeminiRouting(DEFAULT_GEMINI_ROUTING, { failover: { unschedulable_on_502: false } }) }
  calls.length = 0
  const r502Off = await scheduler.complete({ model: 'gemini-3-pro', text: 'test 502 switch off' })
  assert.equal(r502Off.account_id, 'env-b')
  assert.equal(slotPrefs.resolved('env-a').unschedulable, null, 'switch OFF must not persist unschedulable')
})

test('Req 3: All Gemini accounts unschedulable returns HTTP 429 High Load (gemini_pool_overloaded)', async () => {
  const envs = [makeEnv('env-a'), makeEnv('env-b')]
  const slotPrefs = createGeminiSlotPrefs()
  slotPrefs.markUnschedulable('env-a', 'upstream_502', '502 bad gateway')
  slotPrefs.patch('env-b', { schedulable: false })

  const scheduler = createGeminiScheduler({
    schedulerRuntime: makeMockGeminiRuntime(),
    slotPrefs,
    resolveProxy: () => 'socks5h://u:p@192.0.2.10:1080',
    callHost: async (op) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      return {}
    },
    getRoutingConfig: () => ({ gemini: DEFAULT_GEMINI_ROUTING }),
  })

  const handle = createGeminiPublicHandler({
    json: (_res, status, body) => ({ status, body }),
    readBody: async (req) => req.body,
    scheduler,
  })

  const headers = {}
  const res = await handle(
    {
      method: 'POST',
      url: '/v1/chat/completions',
      body: { model: 'gemini-3-pro', messages: [{ role: 'user', content: 'hi' }] },
      apiKeyKind: 'managed',
      apiKeyRecord: { id: 'k1', group_type: 'gemini' },
      headers: {},
      once() {},
    },
    {
      setHeader(k, v) {
        headers[k.toLowerCase()] = v
      },
      once() {},
    },
  )
  assert.equal(res.status, 429)
  assert.equal(res.body.error.type, 'rate_limit_error')
  assert.equal(res.body.error.code, 'gemini_pool_overloaded')
  assert.match(res.body.error.message, /负载过高/)
  assert.ok(Number(headers['retry-after']) >= 1)
})

test('Req 4: Periodic account status checker updates unschedulable errors, replenishes recovered quotas, and projects fields in panel API', async () => {
  const nowMs = Date.parse('2026-11-26T12:00:00Z')
  const envs = [
    makeEnv('env-reauth', {
      account: { state: 'ok', checked_at: '2026-11-26T10:00:00Z', quotas: [], quota_groups: [] },
    }),
    makeEnv('env-recovered', {
      account: {
        state: 'ok',
        checked_at: '2026-11-26T10:00:00Z',
        quotas: [{ model: 'gemini-3-pro', remaining_fraction: 0.8, reset_at: null }],
        quota_groups: [],
      },
    }),
    makeEnv('env-fresh', {
      account: { state: 'ok', checked_at: '2026-11-26T11:58:00Z', quotas: [], quota_groups: [] },
    }),
  ]
  const slotPrefs = createGeminiSlotPrefs({ now: () => nowMs })
  slotPrefs.markUnschedulable('env-recovered', 'verification_required', 'need verify')
  const refreshedIds = []
  let syncedQuotaArgs = null

  const proxyPool = {
    snapshot: () => ({
      proxies: envs.map((e) => ({
        id: e.proxy_id,
        enabled: true,
        status: 'ok',
      })),
    }),
    getProxyByIdWithAuth: (id) => ({ id, url: 'socks5h://u:p@192.0.2.15:1080' }),
  }

  const report = await checkGeminiAccounts({
    now: () => nowMs,
    proxyPool,
    slotPrefs,
    getRoutingConfig: () => ({ gemini: { pool: { account_check_interval_secs: 300 } } }),
    geminiScheduler: {
      invalidateCatalogCache() {},
      syncAccountQuotaState(id, account) {
        syncedQuotaArgs = { id, account }
        return { clearedModels: 1, clearedGroups: 0 }
      },
    },
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'refresh') {
        refreshedIds.push(payload.id)
        if (payload.id === 'env-reauth') {
          return {
            ...envs[0],
            auth_state: 'reauth_required',
            account: {
              state: 'reauth_required',
              checked_at: '2026-11-26T12:00:00Z',
              error_code: 'gemini_oauth_required',
              error_message: 'OAuth token revoked (401)',
              http_status: 401,
              quotas: [],
              quota_groups: [],
              credits: [],
            },
          }
        }
        return {
          ...envs[1],
          auth_state: 'authorized',
          account: {
            state: 'ok',
            checked_at: '2026-11-26T12:00:00Z',
            quotas: [{ model: 'gemini-3-pro', remaining_fraction: 0.85, reset_at: null }],
            quota_groups: [],
            credits: [],
          },
        }
      }
      return {}
    },
  })

  assert.deepEqual(refreshedIds, ['env-reauth', 'env-recovered'], 'only stale environments should be checked')
  assert.equal(report.checked, 2)
  assert.equal(report.ok, 1)
  assert.equal(report.errors, 1)
  assert.equal(report.skipped, 1)
  assert.equal(slotPrefs.resolved('env-reauth').unschedulable?.reason, 'reauth_required')
  assert.equal(slotPrefs.resolved('env-reauth').unschedulable?.detail, 'OAuth token revoked (401)')
  assert.equal(slotPrefs.resolved('env-recovered').unschedulable, null, 'recovered eligibility clears unschedulable')
  assert.equal(syncedQuotaArgs?.id, 'env-recovered')

  // Verify panel GET projects error_code / error_message / http_status and unschedulable cleanly.
  let listRes = null
  const panel = createGeminiPanelHandler({
    json: (_res, status, body) => {
      listRes = { status, body }
      return true
    },
    readBody: async () => ({}),
    proxyPool: () => proxyPool,
    geminiSlotPrefs: slotPrefs,
    callHost: async (op) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [
            {
              ...envs[0],
              auth_state: 'reauth_required',
              account: {
                state: 'reauth_required',
                checked_at: '2026-11-26T12:00:00Z',
                error_code: 'gemini_oauth_required',
                error_message: 'OAuth token revoked (401)',
                http_status: 401,
                quotas: [],
                quota_groups: [],
                credits: [],
              },
            },
          ],
        }
      }
      return {}
    },
  })
  await panel({ method: 'GET', url: '/api/panel/gemini' }, { setHeader() {} }, '/api/panel/gemini')
  assert.equal(listRes?.status, 200)
  const projected = listRes.body.data.environments[0]
  assert.equal(projected.unschedulable_reason, 'reauth_required')
  assert.equal(projected.account.error_code, 'gemini_oauth_required')
  assert.equal(projected.account.error_message, 'OAuth token revoked (401)')
  assert.equal(projected.account.http_status, 401)
})

test('local bridge_disconnected 502 does not mark accounts unschedulable or cascade across entire pool (#1985)', async (t) => {
  const mapped = mapCragWorkerError(502, {
    code: 'bridge_disconnected',
    error: 'native bridge disconnected',
  })
  assert.equal(mapped.code, 'gemini_inference_failed')
  assert.equal(mapped.status, 502)
  assert.equal(mapped.workerCode, 'bridge_disconnected')
  assert.equal(mapped.bridgeDisconnected, true)

  // Genuine upstream 502 is NOT flagged as bridgeDisconnected.
  const real502 = mapCragWorkerError(502, {
    code: 'upstream_error',
    upstream_status: 502,
    error: '502 bad gateway',
  })
  assert.equal(real502.bridgeDisconnected, undefined)

  const envs = [makeEnv('env-bridge-a'), makeEnv('env-bridge-b'), makeEnv('env-bridge-c')]
  const slotPrefs = createGeminiSlotPrefs()
  const pool = new PoolScheduler()
  pool.unitCircuit.configure({ failureThreshold: 1, openMs: 30_000 })
  for (const env of envs) pool.unitCircuit.reset(`gemini:${env.id}`)
  t.after(() => {
    for (const env of envs) pool.unitCircuit.reset(`gemini:${env.id}`)
  })
  const stickyRouter = makeMemoryStickyRouter()
  const routing = { gemini: mergeGeminiRouting(DEFAULT_GEMINI_ROUTING, { failover: { unschedulable_on_502: true } }) }
  const calls = []

  const scheduler = createGeminiScheduler({
    schedulerRuntime: makeMockGeminiRuntime(),
    slotPrefs,
    poolScheduler: pool,
    stickyRouter,
    resolveProxy: () => 'socks5h://u:p@192.0.2.10:1080',
    callHost: async (op, payload) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return envs.find((e) => e.id === payload.id)
      return {}
    },
    callHostStream: async (_op, payload) => {
      calls.push(payload.id)
      return sseResponse([JSON.stringify({ code: 'bridge_disconnected', error: 'native bridge disconnected' })], {
        statusCode: 502,
        contentType: 'application/json',
      })
    },
    getRoutingConfig: () => routing,
  })

  await assert.rejects(
    () => scheduler.complete({ model: 'gemini-3-pro', text: 'trigger bridge disconnect', stickyKey: 'k1:bridge' }),
    (err) => err?.code === 'gemini_inference_failed',
  )

  // At most 2 attempts (initial + 1 failover), never cascading to env-bridge-c.
  assert.deepEqual(calls, ['env-bridge-a', 'env-bridge-b'])
  // Zero accounts marked unschedulable and zero circuits tripped.
  for (const env of envs) {
    assert.equal(slotPrefs.resolved(env.id).unschedulable, null, `${env.id} must stay schedulable`)
    assert.equal(pool.unitCircuit.inspect(`gemini:${env.id}`).ok, true, `${env.id} circuit must stay closed`)
  }
})
