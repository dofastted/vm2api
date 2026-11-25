import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { createGeminiPanelHandler } from '../../src/lib/gemini/routes.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { createGeminiSlotPrefs } from '../../src/lib/gemini/slot-prefs.mjs'
import { UnitCircuit } from '../../src/lib/pool/unit-circuit.mjs'

function makeReq(method, url) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = {}
  return req
}

function makeRes() {
  const res = {
    status: 0,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v
    },
  }
  return res
}

function jsonResponder(res, status, payload) {
  res.status = status
  res.body = payload
}

test('Gemini panel API enriches list with usage/health/inflight and serves health + stats endpoints', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-gem-panel-align-'))
  const requestLog = new RequestLogStore({ dataDir, mode: 'normal' })
  t.after(() => {
    requestLog.db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  // Record one successful and one failed Gemini request in usage_logs.
  const ctxOk = requestLog.start(
    { method: 'POST', url: '/v1beta/models/gemini-2.5-pro:generateContent', headers: {}, socket: {} },
    { protocol: 'google.gemini', pathName: '/v1beta/models/gemini-2.5-pro:generateContent' },
  )
  requestLog.finish(ctxOk, {
    status: 200,
    model: 'gemini-2.5-pro',
    upstream_model: 'gemini-2.5-pro',
    vm_id: 'gemini:gem-01',
    account_id: 'gem-01',
    final_account_id: 'gem-01',
    final_state: 'verified',
    via: 'craggemini',
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200 },
  })

  const ctxErr = requestLog.start(
    { method: 'POST', url: '/v1beta/models/gemini-2.5-pro:generateContent', headers: {}, socket: {} },
    { protocol: 'google.gemini', pathName: '/v1beta/models/gemini-2.5-pro:generateContent' },
  )
  requestLog.finish(ctxErr, {
    status: 502,
    model: 'gemini-2.5-pro',
    upstream_model: 'gemini-2.5-pro',
    vm_id: 'gemini:gem-01',
    account_id: 'gem-01',
    final_account_id: 'gem-01',
    final_state: 'failed',
    error_code: 'gemini_inference_failed',
    via: 'craggemini',
  })

  const envFixture = {
    id: 'gem-01',
    name: 'Gemini Pro 01',
    proxy_id: 'px-01',
    auth_state: 'authorized',
    auth_method: 'oauth',
    runtime_ready: true,
    max_concurrency: 12,
    active_slots: 1,
    models_discovered: true,
    models: ['gemini-2.5-pro'],
    account: {
      state: 'ok',
      checked_at: new Date().toISOString(),
      email: 'gem01@example.com',
      plan: 'Google AI Pro',
      quotas: [],
      quota_groups: [
        {
          name: 'Gemini',
          windows: [
            { id: 'gemini-5h', period: '5h', remaining_fraction: 0.25, reset_at: '2030-01-01T05:00:00Z' },
            { id: 'gemini-7d', period: 'weekly', remaining_fraction: 0.6, reset_at: '2030-01-07T00:00:00Z' },
          ],
        },
      ],
      credits: [],
    },
  }

  const proxyPool = {
    snapshot: () => ({ proxies: [{ id: 'px-01', enabled: true, status: 'ok', owner_user_id: null }] }),
    getProxyByIdWithAuth: () => ({ url: 'socks5://192.0.2.10:1080' }),
  }
  const poolScheduler = { inflight: new Map([['gemini:gem-01', 3]]) }

  const handler = createGeminiPanelHandler({
    json: jsonResponder,
    readBody: async () => ({}),
    proxyPool: () => proxyPool,
    poolScheduler: () => poolScheduler,
    requestLog,
    billingReady: true,
    callHost: async (op) => {
      if (op === 'list') {
        return {
          payload_state: 'installed',
          environments: [envFixture],
        }
      }
      throw new Error(`unexpected host op: ${op}`)
    },
  })

  const call = async (method, url) => {
    const res = makeRes()
    const pathname = new URL(url, 'http://127.0.0.1').pathname
    await handler(makeReq(method, url), res, pathname)
    return res
  }

  // 1. GET /api/panel/gemini attaches usage, health_24h, and live inflight.
  const listRes = await call('GET', '/api/panel/gemini')
  assert.equal(listRes.status, 200)
  const env = listRes.body.data.environments[0]
  assert.equal(env.max_concurrency, 12)
  assert.equal(env.active_slots, 1)
  assert.equal(env.inflight, 3)
  assert.ok(env.usage, 'expected usage metrics on Gemini environment')
  assert.equal(env.usage.today_requests, 2)
  assert.equal(env.usage.today_tokens, 1700)
  assert.equal(env.usage.window_7d_success, 1)
  assert.equal(env.usage.window_7d_errors, 1)
  assert.ok(Array.isArray(env.usage.health_24h) && env.usage.health_24h.length === 48)
  const lastBucket = env.usage.health_24h[47]
  assert.deepEqual(lastBucket, [1, 1])

  // 2. GET /api/panel/gemini/environments/:id/health returns 24h & 7d buckets + top_errors.
  const health24 = await call('GET', '/api/panel/gemini/environments/gem-01/health?range=24h')
  assert.equal(health24.status, 200)
  assert.equal(health24.body.data.range, '24h')
  assert.equal(health24.body.data.slot_min, 30)
  assert.equal(health24.body.data.buckets.length, 48)
  assert.equal(health24.body.data.top_errors[0]?.code, 'gemini_inference_failed')
  assert.equal(health24.body.data.top_errors[0]?.count, 1)

  const health7d = await call('GET', '/api/panel/gemini/environments/gem-01/health?range=7d')
  assert.equal(health7d.status, 200)
  assert.equal(health7d.body.data.range, '7d')
  assert.equal(health7d.body.data.slot_min, 120)
  assert.equal(health7d.body.data.buckets.length, 84)

  // 3. GET /api/panel/gemini/environments/:id/stats returns VmDetailPayload.billing shape.
  const statsRes = await call('GET', '/api/panel/gemini/environments/gem-01/stats')
  assert.equal(statsRes.status, 200)
  const billing = statsRes.body.data.billing
  assert.ok(billing.usage_stats)
  assert.equal(billing.usage_stats.days, 30)
  assert.equal(billing.usage_stats.history.length, 1)
  assert.equal(billing.usage_stats.history[0].requests, 2)
  assert.equal(billing.usage_stats.history[0].errors, 1)
  assert.equal(billing.by_model.length, 1)
  assert.equal(billing.by_model[0].model, 'gemini-2.5-pro')
  assert.equal(billing.window_5h.requests, 2)
  assert.equal(billing.window_7d.requests, 2)
})

test('Gemini panel supports schedulable, prefs, recover, and owner with scheduler integration', async () => {
  const settingsMap = new Map()
  const slotPrefs = createGeminiSlotPrefs({
    settingsRepo: {
      get: (k, f) => (settingsMap.has(k) ? settingsMap.get(k) : f),
      set: (k, v) => settingsMap.set(k, v),
    },
  })

  const owners = new Map()
  const geminiOwnersRepo = {
    getOwner: (id) => owners.get(id) ?? null,
    setOwner: (id, uid) => owners.set(id, uid),
    remove: (id) => owners.delete(id),
  }

  const users = new Map([['u-tenant-1', { id: 'u-tenant-1', username: 'alice', role: 'user' }]])
  const panelUsers = { getById: (id) => users.get(id) ?? null }

  const envState = {
    id: 'gem-01',
    name: 'Host Gemini 01',
    proxy_id: 'px-01',
    auth_state: 'authorized',
    auth_method: 'oauth',
    runtime_ready: true,
    max_concurrency: 10,
    models_discovered: true,
    models: ['gemini-2.5-pro'],
    account: { state: 'ok', email: 'g1@example.com', quotas: [], credits: [] },
  }

  const hostOps = []
  const callHost = async (op, payload) => {
    hostOps.push({ op, payload })
    if (op === 'list') return { payload_state: 'installed', environments: [envState] }
    if (op === 'get') return envState
    if (op === 'concurrency-set') {
      envState.max_concurrency = payload.max_concurrency
      return envState
    }
    if (op === 'delete') return { deleted: true }
    throw new Error(`unexpected host op: ${op}`)
  }

  const unitCircuit = new UnitCircuit({ failureThreshold: 2, openMs: 60_000 })
  const poolScheduler = { inflight: new Map(), unitCircuit }
  const proxyPool = {
    snapshot: () => ({ proxies: [{ id: 'px-01', enabled: true, status: 'ok', owner_user_id: null }] }),
    getProxyByIdWithAuth: () => ({ url: 'socks5://192.0.2.10:1080' }),
  }

  const geminiScheduler = createGeminiScheduler({
    callHost,
    poolScheduler,
    geminiOwnersRepo,
    slotPrefs,
  })

  let nextBody = {}
  const handler = createGeminiPanelHandler({
    json: jsonResponder,
    readBody: async () => nextBody,
    proxyPool: () => proxyPool,
    poolScheduler: () => poolScheduler,
    geminiOwnersRepo,
    geminiSlotPrefs: slotPrefs,
    geminiScheduler,
    panelUsers,
    callHost,
  })

  const call = async (method, url, body = {}) => {
    nextBody = body
    const res = makeRes()
    const pathname = new URL(url, 'http://127.0.0.1').pathname
    await handler(makeReq(method, url), res, pathname)
    return res
  }

  // Initially schedulable with auto level 5.
  assert.equal((await geminiScheduler.catalog()).accounts.length, 1)
  assert.equal((await geminiScheduler.catalog()).accounts[0].schedule_level, 5)

  // 1. Toggle schedulable OFF excludes slot from scheduler catalog.
  const offRes = await call('POST', '/api/panel/gemini/environments/gem-01/schedulable', { schedulable: false })
  assert.equal(offRes.status, 200)
  assert.equal(offRes.body.data.schedulable, false)
  assert.equal((await geminiScheduler.catalog()).accounts.length, 0)

  const listOff = await call('GET', '/api/panel/gemini')
  assert.equal(listOff.body.data.environments[0].schedulable, false)

  // Toggle back ON restores slot in catalog.
  const onRes = await call('POST', '/api/panel/gemini/environments/gem-01/schedulable', { schedulable: true })
  assert.equal(onRes.status, 200)
  assert.equal((await geminiScheduler.catalog()).accounts.length, 1)

  // 2. PATCH prefs updates display name, manual schedule level, and host max_concurrency.
  const prefsRes = await call('PATCH', '/api/panel/gemini/environments/gem-01/prefs', {
    name: '主力 Gemini',
    schedule_level: 9,
    max_concurrency: 24,
  })
  assert.equal(prefsRes.status, 200)
  assert.equal(prefsRes.body.data.name, '主力 Gemini')
  assert.equal(prefsRes.body.data.schedule_level, 9)
  assert.equal(prefsRes.body.data.schedule_level_mode, 'manual')
  assert.equal(prefsRes.body.data.max_concurrency, 24)
  assert.equal((await geminiScheduler.catalog()).accounts[0].schedule_level, 9)
  assert.ok(hostOps.some((x) => x.op === 'concurrency-set' && x.payload.max_concurrency === 24))

  // Invalid schedule level rejected with 400.
  const badLvl = await call('PATCH', '/api/panel/gemini/environments/gem-01/prefs', { schedule_level: 99 })
  assert.equal(badLvl.status, 400)

  // 3. Circuit open surfaces restriction + circuit, and POST /recover resets both.
  unitCircuit.recordFailure('gemini:gem-01')
  unitCircuit.recordFailure('gemini:gem-01')
  const listOpen = await call('GET', '/api/panel/gemini')
  assert.equal(listOpen.body.data.environments[0].circuit?.state, 'open')
  assert.equal(listOpen.body.data.environments[0].restriction?.reason, 'circuit_open')

  const recRes = await call('POST', '/api/panel/gemini/environments/gem-01/recover', {})
  assert.equal(recRes.status, 200)
  assert.equal(recRes.body.data.cleared, true)
  const listRecovered = await call('GET', '/api/panel/gemini')
  assert.equal(listRecovered.body.data.environments[0].circuit, undefined)
  assert.equal(listRecovered.body.data.environments[0].restriction, undefined)

  // 4. PATCH owner assigns and reclaims tenant owner; unknown user returns 404.
  const badOwner = await call('PATCH', '/api/panel/gemini/environments/gem-01/owner', { user_id: 'no-such-user' })
  assert.equal(badOwner.status, 404)
  const assignRes = await call('PATCH', '/api/panel/gemini/environments/gem-01/owner', { user_id: 'u-tenant-1' })
  assert.equal(assignRes.status, 200)
  assert.equal(assignRes.body.data.owner_user_id, 'u-tenant-1')
  assert.equal(owners.get('gem-01'), 'u-tenant-1')
  const reclaimRes = await call('PATCH', '/api/panel/gemini/environments/gem-01/owner', { user_id: null })
  assert.equal(reclaimRes.status, 200)
  assert.equal(reclaimRes.body.data.owner_user_id, null)
  assert.equal(owners.has('gem-01'), false)

  // 5. DELETE cleans up slotPrefs.
  const delRes = await call('DELETE', '/api/panel/gemini/environments/gem-01')
  assert.equal(delRes.status, 200)
  assert.equal(slotPrefs.get('gem-01').schedule_level, null)
})
