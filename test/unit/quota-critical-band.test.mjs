import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { officialMessagesBody } from '../../src/lib/protocol/anthropic-messages.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import {
  estimatePromptTokens,
  estimateRequestRisk,
  DEFAULT_LARGE_COLD_UNCACHED_TOKENS,
  promptEstimateStats,
  resetPromptEstimateStats,
} from '../../src/lib/pool/quota-request-risk.mjs'
import {
  clearCachePrefixSessions,
  confirmCachePrefix,
  peekCachePrefix,
  prepareCachePrefix,
} from '../../src/lib/protocol/cache-prefix.mjs'
import { rewritePoolErrorForClient, mapUpstreamError } from '../../src/lib/core/errors.mjs'
import { evaluateAccount } from '../../src/lib/pool/availability.mjs'
import { listQuotaFromHeaders } from '../../src/lib/pool/quota-window.mjs'

function track(key, body, now) {
  const { body: _sent, ...prefix } = prepareCachePrefix(key, body, now)
  return prefix
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-quota-band-'))
}

function quota(extra = {}) {
  return new AccountQuota({
    dataDir: tmpDir(),
    config: {
      quota: {
        safety_ratio: 0.8,
        weekly_safety_ratio: 0.8,
        block_on_5h: true,
        block_on_7d: true,
        critical_band: 0.05,
        large_cold_uncached_tokens: 100000,
        guard_large_cold: true,
        ...extra,
      },
      tiers: {
        default: { limit_5h: 0.8, limit_7d: 0.8, max_concurrency: 2 },
        pro: { limit_5h: 0.8, limit_7d: 0.8, max_concurrency: 2 },
        max: { limit_5h: 0.8, limit_7d: 0.8, max_concurrency: 2 },
      },
    },
  })
}

const smallRisk = {
  estimatedPromptTokens: 800,
  uncachedTokens: 1200,
  cold: true,
  largeCold: false,
}
const largeColdRisk = {
  estimatedPromptTokens: 180000,
  uncachedTokens: 240000,
  cold: true,
  largeCold: true,
}

function setUtil(q, id, { u5 = null, u7 = null } = {}) {
  const headers = {}
  if (u5 != null) {
    headers['anthropic-ratelimit-unified-5h-utilization'] = String(u5)
    headers['anthropic-ratelimit-unified-5h-status'] = 'allowed'
  }
  if (u7 != null) {
    headers['anthropic-ratelimit-unified-7d-utilization'] = String(u7)
    headers['anthropic-ratelimit-unified-7d-status'] = 'allowed'
  }
  q.ingestHeaders(id, headers)
}

test('79% admits a small request and rejects a single large cold with inflight=0', () => {
  const q = quota()
  setUtil(q, 'a', { u5: 0.79 })
  assert.equal(q.canAccept('a', { requestRisk: smallRisk }).ok, true)
  const large = q.canAccept('a', { requestRisk: largeColdRisk })
  assert.equal(large.ok, false)
  assert.equal(large.reason, 'quota_guard_request_too_large')
  assert.equal(q.tryAcquire('a', { requestRisk: largeColdRisk }).reason, 'quota_guard_request_too_large')
  assert.equal(q.inflight.get('a') || 0, 0)
})

test('5h and 7d bands are independent', () => {
  const q = quota()
  setUtil(q, 'five', { u5: 0.79, u7: 0.2 })
  assert.equal(q.canAccept('five', { requestRisk: largeColdRisk }).reason, 'quota_guard_request_too_large')
  assert.equal(q.canAccept('five', { requestRisk: smallRisk }).ok, true)

  setUtil(q, 'seven', { u5: 0.2, u7: 0.78 })
  assert.equal(q.canAccept('seven', { requestRisk: largeColdRisk }).reason, 'quota_guard_request_too_large')
  assert.equal(q.canAccept('seven', { requestRisk: smallRisk }).ok, true)

  setUtil(q, 'open', { u5: 0.5, u7: 0.5 })
  assert.equal(q.canAccept('open', { requestRisk: largeColdRisk }).ok, true)
})

test('past the line plus overshoot still blocks ordinary requests', () => {
  const q = quota()
  setUtil(q, 'line', { u5: 0.8 })
  assert.equal(q.canAccept('line', { requestRisk: smallRisk }).ok, true, 'at the line, inside the 5% overshoot')
  setUtil(q, 'full', { u5: 0.85 })
  assert.equal(q.canAccept('full', { requestRisk: smallRisk }).reason, 'quota_5h_safety')
  setUtil(q, 'over', { u5: 0.99 })
  assert.equal(q.canAccept('over').reason, 'quota_5h_safety')
})

test('failed or cancelled release does not leave a reservation or stale band debt', () => {
  const q = quota()
  setUtil(q, 'rel', { u5: 0.79 })
  assert.equal(q.tryAcquire('rel', { requestRisk: smallRisk }).ok, true)
  assert.equal(q.inflight.get('rel'), 1)
  q.release('rel')
  assert.equal(q.inflight.get('rel'), 0)
  assert.equal(q.staleSettled.get('rel') || 0, 0)
  assert.equal(q.canAccept('rel', { requestRisk: smallRisk }).ok, true)
})

test('stale reading after an in-band settle blocks the next large request', () => {
  const q = quota()
  setUtil(q, 'stale', { u5: 0.79 })
  assert.equal(q.tryAcquire('stale', { requestRisk: smallRisk }).ok, true)
  q.noteBandSettled('stale')
  q.release('stale')
  assert.equal(q.canAccept('stale', { requestRisk: smallRisk }).ok, true)
  assert.equal(q.canAccept('stale', { requestRisk: largeColdRisk }).reason, 'quota_guard_request_too_large')
  setUtil(q, 'stale', { u5: 0.86 })
  assert.equal(q.canAccept('stale', { requestRisk: smallRisk }).reason, 'quota_5h_safety')
})

test('a same-percent header after settle keeps the stale large-cold block', () => {
  const q = quota()
  setUtil(q, 'lag', { u5: 0.78 })
  assert.equal(q.tryAcquire('lag', { requestRisk: smallRisk }).ok, true)
  q.noteBandSettled('lag')
  q.release('lag')
  setUtil(q, 'lag', { u5: 0.78 })
  assert.equal(q.canAccept('lag', { requestRisk: largeColdRisk }).reason, 'quota_guard_request_too_large')
})

test('official usage refresh clears stale band debt', () => {
  const q = quota()
  setUtil(q, 'off', { u5: 0.79 })
  assert.equal(q.tryAcquire('off', { requestRisk: smallRisk }).ok, true)
  q.noteBandSettled('off')
  q.release('off')
  q.ingestOAuthUsage('off', {
    ok: true,
    limits_present: true,
    five_hour: { utilization: 0.79, status: 'allowed' },
    seven_day: { utilization: 0.2, status: 'allowed' },
    interpretations: { official: { five_hour: { utilization: 0.79, status: 'allowed' } } },
  })
  assert.equal(q.staleSettled.get('off') || 0, 0)
})

function schedulerProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-quota-sched-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms, { recursive: true })
  const write = (id, accountId) => {
    const vm = {
      id,
      name: id,
      status: 'running',
      schedulable: true,
      proxy_cli_enabled: true,
      proxy: { id: `proxy-${id}`, url: `socks5h://127.0.0.1:${id === 'vm-01' ? 10001 : 10002}` },
      runtime: { worker_socket: path.join(vms, id, 'run', 'worker.sock') },
      policy: { maxConcurrency: 2, concurrencyOverride: true, weight: 1, priority: 0 },
      claude: {
        account_uuid: accountId,
        account_tier: 'pro',
        access_token: `access-${accountId}`,
        refresh_token: `refresh-${accountId}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }
    fs.writeFileSync(path.join(vms, `${id}.json`), JSON.stringify(vm))
  }
  write('vm-01', 'account-1')
  write('vm-02', 'account-2')
  fs.writeFileSync(path.join(vms, 'active.json'), JSON.stringify({ active_vm: 'vm-01' }))
  return root
}

class RuntimeRepo {
  states = new Map()
  get(id) {
    return this.states.get(id) || null
  }
  clearExpired() {}
  upsert(state) {
    const next = { ...(this.states.get(state.account_id) || {}), ...state }
    this.states.set(state.account_id, next)
    return next
  }
}

test('scheduler switches using requestRisk on the quotaRequest body estimate', async (t) => {
  const root = schedulerProject()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const accountQuota = quota()
  setUtil(accountQuota, 'account-1', { u5: 0.79 })
  setUtil(accountQuota, 'account-2', { u5: 0.2 })
  const orig = accountQuota.canAccept.bind(accountQuota)
  accountQuota.canAccept = (id, opts = {}) => orig(id, { ...opts, requestRisk: largeColdRisk })
  const origAcq = accountQuota.tryAcquire.bind(accountQuota)
  accountQuota.tryAcquire = (id, opts = {}) => origAcq(id, { ...opts, requestRisk: largeColdRisk })
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: new RuntimeRepo(),
    accountQuota,
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5 },
  })
  const selected = await pool.selectAndReserve({
    model: 'claude-sonnet-4-5',
    allowWait: false,
    quotaRequest: { body: { messages: [{ role: 'user', content: 'x' }] } },
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.accountId, 'account-2')
  selected.release()
})

test('all in-band accounts yield quota_guard_request_too_large', async (t) => {
  const root = schedulerProject()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const accountQuota = quota()
  setUtil(accountQuota, 'account-1', { u5: 0.79 })
  setUtil(accountQuota, 'account-2', { u5: 0.77 })
  const orig = accountQuota.canAccept.bind(accountQuota)
  accountQuota.canAccept = (id, opts = {}) => orig(id, { ...opts, requestRisk: largeColdRisk })
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: new RuntimeRepo(),
    accountQuota,
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5 },
  })
  const selected = await pool.selectAndReserve({
    model: 'claude-sonnet-4-5',
    allowWait: false,
    quotaRequest: { body: { messages: [{ role: 'user', content: 'x' }] } },
  })
  assert.equal(selected.ok, false)
  assert.equal(selected.reason, 'quota_guard_request_too_large')
  const runner = new FailoverRunner({
    scheduler: {
      selectAndReserve: async () => selected,
    },
    config: { total_retry_deadline_ms: 50, fallback_wait_timeout_ms: 5 },
  })
  const result = await runner.runOnce({
    requestId: 'r1',
    canonicalBody: { model: 'claude-sonnet-4-5', messages: [] },
    model: 'claude-sonnet-4-5',
    callAttempt: async () => {
      throw new Error('must not hop')
    },
  })
  assert.equal(result.status, 429)
  assert.equal(result.body.error.code, 'quota_guard_request_too_large')
})

test('peek does not record; unconfirmed attempts stay cold', () => {
  clearCachePrefixSessions()
  const body1 = { tools: [], system: 's', messages: [{ role: 'user', content: 'u1' }] }
  const body2 = {
    tools: [],
    system: 's',
    messages: [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ],
  }
  assert.equal(peekCachePrefix('acc:s', body1, 0).turn, 1)
  assert.equal(peekCachePrefix('acc:s', body1, 0).confirmed, false)
  assert.deepEqual(track('acc:s', body1, 0), { turn: 1, break: null })
  const peeked = peekCachePrefix('acc:s', body2, 1)
  assert.equal(peeked.turn, 2)
  assert.equal(peeked.confirmed, false)
  assert.equal(peeked.break, null)
  const risk = estimateRequestRisk(body2, { accountId: 'acc', sessionId: 's', now: 1, threshold: 100 })
  assert.equal(risk.cold, true)
  assert.equal(risk.coldReason, 'unconfirmed')
  assert.equal(confirmCachePrefix('acc:s', 1), true)
  const warm = estimateRequestRisk(body2, { accountId: 'acc', sessionId: 's', now: 1, threshold: 100 })
  assert.equal(warm.cold, false)
  assert.equal(warm.coldReason, 'warm')
})

test('token estimate counts a long prompt as large cold on first turn', () => {
  clearCachePrefixSessions()
  const body = {
    model: 'claude-opus-4-5',
    max_tokens: 64000,
    messages: [{ role: 'user', content: 'word '.repeat(80000) }],
  }
  const prompt = estimatePromptTokens(body)
  assert.ok(prompt > 50000, `prompt ${prompt}`)
  const risk = estimateRequestRisk(body, { accountId: 'a', sessionId: 's' })
  assert.equal(risk.cold, true)
  assert.ok(risk.uncachedTokens >= DEFAULT_LARGE_COLD_UNCACHED_TOKENS)
  assert.equal(risk.largeCold, true)
})

test('output ceiling does not make a short prompt large in the critical band', () => {
  clearCachePrefixSessions()
  const account = 'band'
  const session = 'sess-demo'
  const system = [{ type: 'text', text: 'You are Claude Code.' }]
  const history = [
    { role: 'user', content: 'read src/app.ts and fix the failing test' },
    { role: 'assistant', content: 'Done. The test now passes.' },
  ]
  const turn = (n) => ({
    model: 'claude-opus-5-5',
    max_tokens: 128000,
    system,
    messages: [...history.slice(0, n), { role: 'user', content: `follow-up ${n}` }],
  })
  const key = `${account}:${session}`
  track(key, turn(0))
  assert.equal(confirmCachePrefix(key), true)
  track(key, turn(2))
  assert.equal(confirmCachePrefix(key), true)

  const warm = estimateRequestRisk(turn(2), { accountId: account, sessionId: session })
  assert.equal(warm.cold, false)
  assert.equal(warm.coldReason, 'warm')
  assert.equal(warm.maxTokens, 128000)
  assert.ok(warm.uncachedTokens < 1000, `warm uncached ${warm.uncachedTokens}`)
  assert.equal(warm.largeCold, false)

  const fresh = estimateRequestRisk(turn(0), { accountId: account, sessionId: 'sess-new' })
  assert.equal(fresh.cold, true)
  assert.equal(fresh.coldReason, 'first_turn')
  assert.equal(fresh.maxTokens, 128000)
  assert.ok(fresh.uncachedTokens < 1000, `fresh uncached ${fresh.uncachedTokens}`)
  assert.equal(fresh.largeCold, false)

  const filled = officialMessagesBody({
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(filled.max_tokens, 128000)
  const omitted = estimateRequestRisk(filled, { accountId: account, sessionId: 'sess-omit' })
  assert.equal(omitted.largeCold, false)
  assert.ok(omitted.uncachedTokens < DEFAULT_LARGE_COLD_UNCACHED_TOKENS)

  const q = quota()
  setUtil(q, account, { u5: 0.79 })
  const warmReq = { body: turn(2), sessionId: session }
  assert.equal(q.canAccept(account, { quotaRequest: warmReq }).ok, true)
  assert.equal(q.tryAcquire(account, { quotaRequest: warmReq }).ok, true)
  q.noteBandSettled(account)
  q.release(account)
  assert.equal(q.staleSettled.get(account), 1)
  assert.equal(q.canAccept(account, { quotaRequest: warmReq }).ok, true)
  assert.equal(q.canAccept(account, { quotaRequest: { body: turn(0), sessionId: 'sess-new' } }).ok, true)

  const huge = {
    model: 'claude-opus-5-5',
    max_tokens: 128000,
    messages: [{ role: 'user', content: 'word '.repeat(80000) }],
  }
  assert.equal(estimateRequestRisk(huge, { accountId: account, sessionId: 'sess-huge' }).largeCold, true)
  assert.equal(
    q.canAccept(account, { quotaRequest: { body: huge, sessionId: 'sess-huge' } }).reason,
    'quota_guard_request_too_large',
  )
})

test('stale band still blocks a warm turn whose new user text is itself large', () => {
  clearCachePrefixSessions()
  const base = {
    model: 'claude-opus-5-5',
    max_tokens: 128000,
    messages: [{ role: 'user', content: 'short' }],
  }
  track('band:sess', base)
  assert.equal(confirmCachePrefix('band:sess'), true)
  const extended = {
    ...base,
    messages: [
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'word '.repeat(80000) },
    ],
  }
  const risk = estimateRequestRisk(extended, { accountId: 'band', sessionId: 'sess' })
  assert.equal(risk.cold, false)
  assert.equal(risk.largeCold, false)
  assert.ok(risk.uncachedTokens >= DEFAULT_LARGE_COLD_UNCACHED_TOKENS)
  const q = quota()
  setUtil(q, 'band', { u5: 0.79 })
  const quotaRequest = { body: extended, sessionId: 'sess' }
  assert.equal(q.canAccept('band', { quotaRequest }).ok, true)
  assert.equal(q.tryAcquire('band', { quotaRequest }).ok, true)
  q.noteBandSettled('band')
  q.release('band')
  assert.equal(q.canAccept('band', { quotaRequest }).reason, 'quota_guard_request_too_large')
})

test('quota_guard_request_too_large stays a 429 and is not rewritten to pool_unavailable', () => {
  const mapped = mapUpstreamError(429, {
    error: { type: 'rate_limit_error', code: 'quota_guard_request_too_large', message: '临近额度闸线' },
  })
  assert.equal(mapped.status, 429)
  assert.equal(mapped.body.error.code, 'quota_guard_request_too_large')
  const rewritten = rewritePoolErrorForClient(mapped, mapped.body)
  assert.equal(rewritten.status, 429)
  assert.equal(rewritten.body.error.code, 'quota_guard_request_too_large')
})

test('prompt estimate is skipped below the band and walked once for in-band accounts', () => {
  resetPromptEstimateStats()
  const q = quota()
  setUtil(q, 'low', { u5: 0.5, u7: 0.2 })
  setUtil(q, 'band-a', { u5: 0.79 })
  setUtil(q, 'band-b', { u5: 0.76 })
  const body = {
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'word '.repeat(200) }],
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
  }
  const quotaRequest = { body, sessionId: 'sess-1' }
  assert.equal(q.canAccept('low', { quotaRequest }).ok, true)
  assert.equal(promptEstimateStats.misses, 0)
  q.canAccept('band-a', { quotaRequest })
  q.canAccept('band-b', { quotaRequest })
  q.tryAcquire('band-a', { quotaRequest })
  assert.equal(promptEstimateStats.misses, 1)
  q.release('band-a')
})

test('admission and the panel agree near the gate (vm-10: pro, 7d 90% of a 95% line)', () => {
  const tier = { limit_5h: 0.95, limit_7d: 0.95, max_concurrency: 2 }
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: {
      quota: { block_on_5h: true, block_on_7d: true, critical_band: 0.05, gate_overshoot: 0.05 },
      tiers: { default: tier, pro: tier, max: tier },
    },
  })
  const panel = (u7) => {
    q.ingestHeaders('vm10', {
      'anthropic-ratelimit-unified-5h-utilization': '0.12',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': String(u7),
      'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
    })
    const acc = q.repo.get('vm10')
    const now = Date.now()
    return evaluateAccount({
      vm: { id: 'vm-10', schedulable: true },
      account: acc,
      hasToken: true,
      hasRefresh: true,
      schedulable: true,
      lastProbe: { ok: true, source: 'official-cc-usage', at: new Date(now).toISOString() },
      quota: listQuotaFromHeaders(acc.unified, { now }),
      policy: q.policyFor(acc),
      now,
    })
  }

  const near = panel(0.9)
  assert.equal(near.key, 'drain', 'the console must not paint this as 可用')
  assert.equal(near.accept, true)
  assert.equal(q.canAccept('vm10', { requestRisk: smallRisk }).ok, true)
  q.inflight.set('vm10', 1)
  assert.equal(q.canAccept('vm10', { requestRisk: smallRisk }).reason, 'quota_band_inflight')
  q.inflight.set('vm10', 0)

  const open = panel(0.5)
  assert.equal(open.key, 'ok')
  assert.equal(q.canAccept('vm10', { requestRisk: largeColdRisk }).ok, true)

  const gated = panel(1)
  assert.equal(gated.accept, false)
  assert.equal(q.canAccept('vm10', { requestRisk: smallRisk }).ok, false)
})
