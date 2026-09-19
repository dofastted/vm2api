import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountQuota, extraHeadersFromLimitError } from '../../src/lib/pool/account-quota.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-quota-'))
}

test('ensure seeds account and is idempotent', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: {},
    accounts: [{ account_id: 'a1', vm_id: 'vm-1', email: 'a@x' }],
  })
  const acc = q.ensure({ account_id: 'a1' })
  assert.equal(acc.vm_id, 'vm-1')
  assert.equal(acc.email, 'a@x')
  assert.equal(acc.requests, 0)
  assert.equal(acc.unified['5h'].status, 'active')
})

function futureReset(msFromNow) {
  return new Date(Date.now() + msFromNow).toISOString()
}

test('ingestHeaders updates unified windows + counters + allocations', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ingestHeaders(
    'a2',
    {
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-7d-utilization': '0.10',
      'anthropic-ratelimit-unified-5h-reset': futureReset(4 * 3600_000),
    },
    { input_tokens: 100, output_tokens: 20 },
  )
  const snap = q.snapshot()
  const acc = snap.accounts.find((a) => a.account_id === 'a2')
  assert.equal(acc.unified['5h'].utilization, 0.42)
  assert.equal(acc.unified['7d'].utilization, 0.1)
  assert.equal(acc.requests, 1)
  assert.equal(acc.tokens_in, 100)
  assert.equal(acc.tokens_out, 20)
  assert.equal(acc.recent_allocations.length, 1)
  assert.equal(acc.recent_allocations[0].util_5h, 0.42)
  assert.ok(acc.unified.headers.sampled_at)
})

test('ingestHeaders countRequest:false does not overwrite Extra with hello 0%', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ingestHeaders('a-health', {
    'anthropic-ratelimit-unified-5h-utilization': '0.91',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': futureReset(4 * 3600_000),
  })
  q.ingestHeaders(
    'a-health',
    {
      'anthropic-ratelimit-unified-5h-utilization': '0.18',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-reset': futureReset(4 * 3600_000),
    },
    { input_tokens: 40, output_tokens: 8 },
    { countRequest: false },
  )
  const acc = q.snapshot().accounts.find((a) => a.account_id === 'a-health')
  assert.equal(acc.unified.headers['5h'].utilization, 0.91)
  assert.equal(acc.unified.headers['5h'].status, 'rejected')
  assert.equal(acc.requests, 1)
  assert.equal(acc.tokens_in, 0)
  assert.equal(acc.recent_allocations.length, 1)
})

test('ingestHeaders accumulates cache tokens and mirrors the session window', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  const windows = []
  q.attachRuntimeRepo({ updateWindow: (accountId, patch) => windows.push({ accountId, ...patch }) })
  q.ingestHeaders(
    'a-cache',
    {
      'anthropic-ratelimit-unified-5h-utilization': '0.2',
      'anthropic-ratelimit-unified-5h-reset': '2026-08-19T20:00:00Z',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    },
    {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 7,
    },
  )
  q.ingestHeaders('a-cache', {}, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 2 })
  const acc = q.snapshot().accounts.find((a) => a.account_id === 'a-cache')
  assert.equal(acc.cache_read_tokens, 5)
  assert.equal(acc.cache_creation_tokens, 7)
  assert.equal(windows.length, 2)
  const end = Date.parse('2026-08-19T20:00:00Z')
  assert.equal(windows[0].sessionWindowEnd, end)
  assert.equal(windows[0].sessionWindowStart, end - 5 * 3600_000)
  assert.equal(windows[0].sessionWindowStatus, 'allowed')
})

test('ingestHeaders reads OpenAI prompt_tokens_details cache fields', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ingestHeaders(
    'a-oa',
    {},
    {
      prompt_tokens: 20,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 11, cache_creation_tokens: 3 },
    },
  )
  const acc = q.snapshot().accounts.find((a) => a.account_id === 'a-oa')
  assert.equal(acc.tokens_in, 20)
  assert.equal(acc.tokens_out, 4)
  assert.equal(acc.cache_read_tokens, 11)
  assert.equal(acc.cache_creation_tokens, 3)
})

test('test-chat last_probe does not overwrite a successful usage probe', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.recordLastProbe('a-keep', { ok: true, source: 'vm-oauth-usage' })
  q.recordLastProbe('a-keep', {
    ok: false,
    source: 'test-chat',
    error: 'OAuth access token has been revoked.',
  })
  const acc = q.repo.get('a-keep')
  assert.equal(acc.unified.last_probe.source, 'vm-oauth-usage')
  assert.equal(acc.unified.last_probe.ok, true)
})

test('canAccept blocks at safety ratio and records last_blocked', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  })
  q.ingestHeaders('a3', { 'anthropic-ratelimit-unified-5h-utilization': '0.96' })
  const gate = q.canAccept('a3')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'quota_5h_safety')
  const acc = q.snapshot().accounts.find((a) => a.account_id === 'a3')
  assert.equal(acc.last_blocked.window, '5h')
})

test('cli rate_limit_event blocks via status', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ingestCliRateLimit('a4', { rateLimitType: 'five_hour', status: 'rejected', resetsAt: 1893456000 })
  const gate = q.canAccept('a4')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'quota_5h_cli')
})

test('extraHeadersFromLimitError fills Extra 5h when wrap omits headers', () => {
  const filled = extraHeadersFromLimitError(
    "provider error: You've hit your limit · resets 7:50pm (America/New_York)",
    {},
  )
  assert.equal(filled['anthropic-ratelimit-unified-5h-status'], 'rejected')
  const kept = extraHeadersFromLimitError('hit your limit', {
    'anthropic-ratelimit-unified-5h-utilization': '0.4',
  })
  assert.equal(kept['anthropic-ratelimit-unified-5h-utilization'], '0.4')
  assert.equal(kept['anthropic-ratelimit-unified-5h-status'], undefined)
})

test('cli rate_limit_event copies unifiedWindows utilization', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ingestCliRateLimit('a4-util', {
    rateLimitType: 'five_hour',
    status: 'allowed',
    resetsAt: 1893456000,
    unifiedWindows: { five_hour: { utilization: 81 } },
  })
  const acc = q.snapshot().accounts.find((a) => a.account_id === 'a4-util')
  assert.equal(acc.unified.headers['5h'].utilization, 0.81)
  assert.equal(acc.unified.headers['5h'].status, 'allowed')
})

test('tryAcquire enforces and releases the configured concurrency cap', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    accounts: [{ account_id: 'acc-reserve', max_concurrency: 1, concurrency_override: 1 }],
  })
  assert.equal(q.tryAcquire('acc-reserve').ok, true)
  assert.equal(q.tryAcquire('acc-reserve').reason, 'concurrency_limit')
  q.release('acc-reserve')
  assert.equal(q.tryAcquire('acc-reserve').ok, true)
  q.release('acc-reserve')
})

test('state persists across re-open (same dataDir)', () => {
  const dir = tmpDir()
  const q1 = new AccountQuota({ dataDir: dir, config: {} })
  q1.ingestHeaders('a5', { 'anthropic-ratelimit-unified-7d-utilization': '0.5' }, { input_tokens: 7, output_tokens: 3 })

  const q2 = new AccountQuota({ dataDir: dir, config: {} })
  const acc = q2.snapshot().accounts.find((a) => a.account_id === 'a5')
  assert.ok(acc)
  assert.equal(acc.unified['7d'].utilization, 0.5)
  assert.equal(acc.tokens_in, 7)
  assert.equal(acc.requests, 1)
  assert.equal(acc.recent_allocations.length, 1)
})

test('allocations trimmed to 50 per account', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  for (let i = 0; i < 60; i++) {
    q.ingestHeaders('a6', { 'anthropic-ratelimit-unified-5h-utilization': String(i / 100) })
  }
  assert.equal(q.repo.allocationCount('a6'), 50)
  const recent = q.repo.recentAllocations('a6', 5)
  assert.equal(recent.length, 5)
  assert.equal(recent[4].util_5h, 0.59)
})

test('max_concurrency 0 blocks instead of treating as unlimited', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: { concurrency: { default_max_per_account: 20 } } })
  q.ensure({ account_id: 'zero', max_concurrency: 0 })
  q.setMaxConcurrency('zero', 0, { override: true })
  const gate = q.canAccept('zero')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'concurrency_limit')
  assert.equal(gate.detail.max, 0)
})

test('rebindToVm moves the UUID row onto the new slot', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ensure({ account_id: '1c5a7a73', vm_id: 'vm-02', email: 'old@x' })
  q.rebindToVm('1c5a7a73', 'vm-04', { email: 'new@x' })
  const acc = q.snapshot().accounts.find((a) => a.account_id === '1c5a7a73')
  assert.equal(acc.vm_id, 'vm-04')
  assert.equal(acc.email, 'new@x')
})

test('concurrency inflight gate stays in memory', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: { concurrency: { default_max_per_account: 1 } } })
  q.ensure({ account_id: 'a7' })
  q.setMaxConcurrency('a7', 1, { override: true })
  q.acquire('a7')
  const gate = q.canAccept('a7')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'concurrency_limit')
  q.release('a7')
  assert.equal(q.canAccept('a7').ok, true)
})

test('rpm window blocks then recovers', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ensure({ account_id: 'rpm-acc', max_concurrency: 8 })
  q.setMaxRpm('rpm-acc', 2, { override: true })
  assert.equal(q.tryAcquire('rpm-acc').ok, true)
  q.release('rpm-acc')
  assert.equal(q.tryAcquire('rpm-acc').ok, true)
  q.release('rpm-acc')
  const gate = q.canAccept('rpm-acc')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'rpm_limit')
  assert.equal(gate.detail.max, 2)
  assert.ok(gate.detail.reset_at > Date.now())
})

test('max_rpm 0 is unlimited', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ensure({ account_id: 'rpm-off', max_concurrency: 8, max_rpm: 0 })
  for (let i = 0; i < 5; i++) {
    assert.equal(q.tryAcquire('rpm-off').ok, true)
    q.release('rpm-off')
  }
  assert.equal(q.canAccept('rpm-off').ok, true)
})

test('quota gate still blocks before RPM wait', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, block_on_5h: true, block_on_7d: true } },
  })
  q.ensure({ account_id: 'rpm-quota', max_concurrency: 8, max_rpm: 60 })
  q.ingestHeaders('rpm-quota', {
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': new Date(Date.now() + 3600_000).toISOString(),
  })
  const gate = q.canAccept('rpm-quota')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'quota_5h_cli')
})

test('ingestOAuthUsage stores 5h/7d and isolated fable limit', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  })
  q.ingestOAuthUsage('acc-fable', {
    ok: true,
    five_hour: { utilization: 0.2, resets_at: '2026-08-18T20:00:00Z', status: 'allowed' },
    seven_day: { utilization: 0.4, resets_at: '2026-08-24T00:00:00Z', status: 'allowed' },
    seven_day_sonnet: { utilization: 0.1, resets_at: '2026-08-24T00:00:00Z', status: 'allowed' },
    extra_usage: { is_enabled: false, status: 'rejected' },
    fable: {
      ok: false,
      limited: true,
      banned: false,
      status: 429,
      model: 'claude-fable-5',
      reset_at: '2026-08-25T00:00:00Z',
    },
    seven_day_oi: { utilization: 0.54, resets_at: '2026-08-25T00:00:00Z', status: 'allowed' },
    probed_at: '2026-08-18T12:00:00Z',
  })
  const acc = q.repo.get('acc-fable')
  assert.equal(acc.unified['5h'].utilization, 0.2)
  assert.equal(acc.unified['7d'].utilization, 0.4)
  assert.equal(acc.unified.fable.limited, false)
  assert.equal(acc.unified.fable.utilization, 0.54)
  assert.equal(acc.unified['7d_oi'].utilization, 0.54)
  assert.equal(acc.unified['7d_oi'].status, 'allowed')
  assert.equal(acc.unified.seven_day_sonnet.utilization, 0.1)
  const gate = q.canAccept('acc-fable')
  assert.equal(gate.ok, true, 'fable weekly limit must not block the whole account')
})

test('official /usage 429 keeps the last successful probe', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  })
  q.ingestOAuthUsage('acc-rl', {
    ok: true,
    source: 'official-cc-usage',
    usage_status: 200,
    five_hour: { utilization: 0.37, status: 'allowed', resets_at: '2026-08-25T10:00:00Z' },
    seven_day: { utilization: 0.48, status: 'allowed' },
    probed_at: '2026-08-25T04:00:00.000Z',
  })
  q.ingestOAuthUsage('acc-rl', {
    ok: false,
    source: 'official-cc-usage',
    usage_status: 429,
    rate_limited: true,
    usage_error: 'Rate limited. Please try again later.',
    probed_at: '2026-08-25T05:35:00.000Z',
  })
  const acc = q.repo.get('acc-rl')
  const lp = acc.unified.last_probe
  assert.equal(lp.ok, true)
  assert.equal(lp.error, null)
  assert.equal(lp.rate_limited, true)
  assert.equal(acc.unified.official?.['5h']?.utilization ?? acc.unified['5h']?.utilization, 0.37)
  assert.ok(Date.parse(acc.unified.usage_rate_limited_until) > Date.now())
})

test('usage ok plus fable 401 does not poison last_probe with revoke text', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  })
  q.ingestOAuthUsage('acc-pro-401', {
    ok: true,
    usage_status: 200,
    five_hour: { utilization: 0, status: 'allowed' },
    seven_day: { utilization: 0, status: 'allowed' },
    fable: {
      ok: false,
      banned: true,
      plan_denied: false,
      status: 401,
      error: 'OAuth access token has been revoked.',
      model: 'claude-fable-5',
    },
    probed_at: '2026-08-22T08:42:00.000Z',
  })
  const acc = q.repo.get('acc-pro-401')
  assert.equal(acc.unified.last_probe.error, null)
  assert.equal(acc.unified.last_probe.ok, true)
  assert.equal(acc.unified.fable.banned, false)
  assert.equal(acc.unified.fable.plan_denied, true)
  q.clearGrantRevokeLeftover('acc-pro-401')
  const after = q.repo.get('acc-pro-401')
  assert.equal(after.unified.last_probe.error, null)
  assert.equal(after.unified.fable.plan_denied, true)
})

test('clearGrantRevokeLeftover drops stale revoke after refresh', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  })
  q.ingestOAuthUsage('acc-stale', {
    ok: false,
    usage_status: 401,
    fable: { ok: false, banned: true, status: 401, error: 'OAuth access token has been revoked.' },
    usage_error: 'OAuth access token has been revoked.',
    probed_at: '2026-08-22T08:42:00.000Z',
  })
  assert.match(String(q.repo.get('acc-stale').unified.last_probe.error || ''), /revoked/i)
  q.clearGrantRevokeLeftover('acc-stale')
  const acc = q.repo.get('acc-stale')
  assert.equal(acc.unified.last_probe.error, null)
  assert.equal(acc.unified.fable.banned, false)
  assert.equal(acc.unified.fable.plan_denied, true)
})

test('clearGrantRevokeLeftover keeps stored Max off leftover Fable revoke', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  })
  q.ingestOAuthUsage('acc-max', {
    ok: true,
    usage_status: 200,
    five_hour: { utilization: 0, status: 'allowed' },
    seven_day: { utilization: 0, status: 'allowed' },
    fable: { ok: true, status: 200, model: 'claude-fable-5' },
    seven_day_oi: { utilization: 0.1, resets_at: '2026-09-01T00:00:00Z', status: 'allowed' },
    probed_at: '2026-08-22T08:42:00.000Z',
  })
  assert.equal(q.repo.get('acc-max').unified.account_tier, 'max')
  q.ingestOAuthUsage('acc-max', {
    ok: false,
    usage_status: 401,
    fable: { ok: false, banned: true, status: 401, error: 'OAuth access token has been revoked.' },
    usage_error: 'OAuth access token has been revoked.',
    probed_at: '2026-08-27T08:00:00.000Z',
  })
  q.clearGrantRevokeLeftover('acc-max')
  const acc = q.repo.get('acc-max')
  assert.equal(acc.unified.account_tier, 'max')
  assert.equal(acc.unified.fable.banned, false)
  assert.equal(acc.unified.fable.plan_denied, false)
})

test('fable 429 without 7d_oi window does not invent a full Fable quota', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  })
  q.ingestOAuthUsage('acc-pro', {
    ok: true,
    five_hour: { utilization: 0.1, status: 'allowed' },
    seven_day: { utilization: 0.2, status: 'allowed' },
    fable: { ok: false, limited: true, banned: false, plan_denied: false, status: 429, model: 'claude-fable-5' },
    probed_at: '2026-08-22T00:00:00Z',
  })
  const acc = q.repo.get('acc-pro')
  assert.equal(acc.unified.fable.limited, false)
  assert.equal(acc.unified.fable.plan_denied, true)
  assert.equal(acc.unified['7d_oi']?.status || null, null)
  assert.equal(q.canAccept('acc-pro').ok, true)
  assert.equal(q.fableWindowLimited('acc-pro'), false)
})

test('pro usage probe without fable hop clears leftover 429 as plan_denied', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  })
  q.ingestOAuthUsage('acc-pro-skip', {
    ok: true,
    five_hour: { utilization: 0.1, status: 'allowed' },
    seven_day: { utilization: 0.2, status: 'allowed' },
    fable: {
      ok: false,
      limited: true,
      banned: false,
      plan_denied: false,
      status: 429,
      error: 'Error',
      model: 'claude-fable-5',
    },
    probed_at: '2026-08-22T00:00:00Z',
  })
  assert.equal(q.repo.get('acc-pro-skip').unified.account_tier, 'pro')
  q.ingestOAuthUsage('acc-pro-skip', {
    ok: true,
    usage_status: 200,
    source: 'official-cc-usage',
    five_hour: { utilization: 0.03, status: 'allowed' },
    seven_day: { utilization: 0.11, status: 'allowed' },
    probed_at: '2026-08-24T00:00:00Z',
  })
  const acc = q.repo.get('acc-pro-skip')
  assert.equal(acc.unified.fable.plan_denied, true)
  assert.equal(acc.unified.fable.ok, false)
  assert.equal(acc.unified.fable.error, 'plan_denied')
  assert.equal(acc.unified.account_tier, 'pro')
})

test('7d_oi window is Fable-only and does not block the account', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  })
  q.ingestHeaders('acc-oi', {
    'anthropic-ratelimit-unified-7d_oi-utilization': '1',
    'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
    'anthropic-ratelimit-unified-7d_oi-reset': '2026-08-25T00:00:00Z',
    'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
  })
  assert.equal(q.canAccept('acc-oi').ok, true)
  assert.equal(q.fableWindowLimited('acc-oi'), true)
  assert.equal(q.fableWindowResetAt('acc-oi'), Date.parse('2026-08-25T00:00:00Z'))
})

test('probe 5h rejected with no last_used stays a hard block until reset', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  })
  const reset = new Date(Date.now() + 4 * 3600_000).toISOString()
  q.ingestOAuthUsage('acc-sticky', {
    ok: true,
    five_hour: { utilization: 1, resets_at: reset, status: 'rejected' },
    seven_day: { utilization: 0, status: 'allowed' },
    probed_at: new Date().toISOString(),
  })
  assert.equal(q.canAccept('acc-sticky').ok, false)
  const acc = q.snapshot().accounts.find((a) => a.account_id === 'acc-sticky')
  assert.equal(Number(acc.unified['5h'].utilization), 1)
  assert.equal(acc.unified['5h'].status, 'rejected')
})

test('official leftover 100% does not overwrite live Extra allowed', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  })
  q.ingestHeaders('acc-live', {
    'anthropic-ratelimit-unified-5h-utilization': '0.36',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-reset': futureReset(4 * 3600_000),
  })
  q.ingestOAuthUsage('acc-live', {
    ok: true,
    source: 'official-cc-usage',
    five_hour: { utilization: 1, resets_at: new Date(Date.now() + 3600_000).toISOString(), status: 'rejected' },
    seven_day: { utilization: 0.3, status: 'allowed' },
    probed_at: new Date().toISOString(),
  })
  const acc = q.repo.get('acc-live')
  assert.equal(acc.unified.official['5h'].utilization, 1)
  assert.equal(acc.unified.headers['5h'].utilization, 0.36)
  assert.equal(acc.unified.headers['5h'].status, 'allowed')
  assert.equal(q.canAccept('acc-live').ok, true)
})

test('successful probe overwrites leftover rejected when official percent is low', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ingestHeaders(
    'acc-stale-status',
    {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
    },
    null,
    { exhausted: true, status: 429 },
  )
  q.ingestOAuthUsage('acc-stale-status', {
    ok: true,
    source: 'official-cc-usage',
    five_hour: { utilization: 0.12, resets_at: new Date(Date.now() + 3600_000).toISOString(), status: 'allowed' },
    seven_day: { utilization: 0.2, status: 'allowed' },
    probed_at: new Date().toISOString(),
  })
  const acc = q.repo.get('acc-stale-status')
  assert.equal(acc.unified['5h'].utilization, 0.12)
  assert.equal(acc.unified['5h'].status, 'allowed')
  assert.equal(q.canAccept('acc-stale-status').ok, true)
})

test('probe 5h rejected stays blocked when last_used is missing', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  })
  q.ingestOAuthUsage('acc-no-used', {
    ok: true,
    source: 'official-cc-usage',
    five_hour: {
      utilization: 1,
      resets_at: new Date(Date.now() + 4 * 3600_000).toISOString(),
      status: 'rejected',
    },
    seven_day: { utilization: 0, status: 'allowed' },
    probed_at: new Date().toISOString(),
  })
  const gate = q.canAccept('acc-no-used')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'quota_5h_cli')
})

test('probe 5h rejected stays blocked when the slot was used in this window', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  })
  const reset = new Date(Date.now() + 4 * 3600_000).toISOString()
  q.attachRuntimeRepo({
    get: () => ({ last_used_at: Date.now() - 60_000 }),
  })
  q.ingestOAuthUsage('acc-hot', {
    ok: true,
    five_hour: { utilization: 1, resets_at: reset, status: 'rejected' },
    seven_day: { utilization: 0, status: 'allowed' },
    probed_at: new Date().toISOString(),
  })
  const gate = q.canAccept('acc-hot')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'quota_5h_cli')
})

test('persistEffectiveWindows writes a cleared 5h after reset elapsed', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ingestOAuthUsage('acc-persist', {
    ok: true,
    source: 'vm-oauth-usage',
    five_hour: {
      utilization: 1,
      status: 'rejected',
      resets_at: new Date(Date.now() - 30_000).toISOString(),
    },
    seven_day: { utilization: 0.2, status: 'allowed' },
    probed_at: new Date(Date.now() - 3600_000).toISOString(),
  })
  const saved = q.persistEffectiveWindows('acc-persist')
  assert.equal(Number(saved.unified['5h'].utilization), 0)
  assert.equal(saved.unified['5h'].status, 'active')
  assert.equal(saved.unified['5h'].stale, true)
  assert.equal(q.canAccept('acc-persist').ok, true)
})

test('elapsed 5h reset is not a hard block even after a live header write', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  })
  q.ingestHeaders('acc-elapsed', {
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': new Date(Date.now() - 60_000).toISOString(),
  })
  assert.equal(q.canAccept('acc-elapsed').ok, true)
})

test('429 unified exhausted marks headers rejected without inventing official 100%', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ingestHeaders(
    'acc-429',
    {
      'anthropic-ratelimit-unified-5h-utilization': '0.84',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
    },
    null,
    { exhausted: true, status: 429 },
  )
  const acc = q.repo.get('acc-429')
  assert.equal(acc.unified.headers['5h'].status, 'rejected')
  assert.equal(acc.unified.headers['5h'].utilization, 0.84)
  assert.notEqual(acc.unified.official?.['5h']?.utilization, 1)
  assert.equal(q.canAccept('acc-429').ok, false)
})

test('stuck 5h header with growing tokens does not lift official utilization', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { block_on_5h: true }, tiers: { default: { limit_5h: 0.85 } } },
  })
  q.ingestOAuthUsage('acc-stall', {
    ok: true,
    source: 'official-cc-usage',
    five_hour: { utilization: 0.44, status: 'allowed', resets_at: futureReset(4 * 3600_000) },
    seven_day: { utilization: 0.36, status: 'allowed' },
    probed_at: new Date().toISOString(),
  })
  q.ingestHeaders(
    'acc-stall',
    { 'anthropic-ratelimit-unified-5h-utilization': '0.44' },
    { input_tokens: 100, output_tokens: 20 },
  )
  q.ingestHeaders(
    'acc-stall',
    { 'anthropic-ratelimit-unified-5h-utilization': '0.44' },
    { input_tokens: 8000, output_tokens: 2000 },
  )
  const acc = q.repo.get('acc-stall')
  assert.equal(acc.unified.official['5h'].utilization, 0.44)
  assert.equal(acc.unified['5h'].utilization, 0.44)
  assert.equal(acc.unified.header_stall, 0)
  assert.equal(q.canAccept('acc-stall').ok, true)
})

test('official /usage 40 percent is 0.40 and stays under the 80 percent gate', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, weekly_safety_ratio: 0.8, block_on_5h: true, block_on_7d: true } },
  })
  q.ingestOAuthUsage('acc-40', {
    ok: true,
    source: 'official-cc-usage',
    interpretations: {
      official: {
        five_hour: { utilization: 0.4, used_pct: 40, status: 'allowed' },
        seven_day: { utilization: 0.36, used_pct: 36, status: 'allowed' },
      },
    },
    probed_at: new Date().toISOString(),
  })
  const acc = q.repo.get('acc-40')
  assert.equal(acc.unified.official['5h'].utilization, 0.4)
  assert.equal(q.canAccept('acc-40').ok, true)
})

test('persistEffectiveWindows clears leftover quota cooldown when official is under the gate', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, block_on_5h: true, block_on_7d: true } },
  })
  const runtime = new Map()
  q.attachRuntimeRepo({
    get: (id) => runtime.get(id) || null,
    upsert: (row) => {
      runtime.set(row.account_id, { ...runtime.get(row.account_id), ...row })
    },
    updateWindow: () => {},
  })
  runtime.set('acc-reconcile', {
    account_id: 'acc-reconcile',
    vm_id: 'vm-13',
    cooldown_until: Date.now() + 3600_000,
    cooldown_reason: 'account_quota_exhausted',
  })
  q.ingestOAuthUsage('acc-reconcile', {
    ok: true,
    source: 'official-cc-usage',
    five_hour: { utilization: 0.44, status: 'allowed', resets_at: futureReset(4 * 3600_000) },
    seven_day: { utilization: 0.36, status: 'allowed' },
    probed_at: new Date().toISOString(),
  })
  assert.equal(runtime.get('acc-reconcile').cooldown_until, null)
  runtime.set('acc-reconcile', {
    ...runtime.get('acc-reconcile'),
    cooldown_until: Date.now() + 3600_000,
    cooldown_reason: 'account_quota_exhausted',
  })
  q.persistEffectiveWindows('acc-reconcile')
  assert.equal(runtime.get('acc-reconcile').cooldown_until, null)
  assert.equal(q.canAccept('acc-reconcile').ok, true)
})

test('official 0.44 allowed overwrites local 0.85 and clears quota cooldown', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, block_on_5h: true, block_on_7d: true } },
  })
  const runtime = new Map()
  q.attachRuntimeRepo({
    get: (id) => runtime.get(id) || null,
    upsert: (row) => {
      runtime.set(row.account_id, { ...runtime.get(row.account_id), ...row })
    },
    updateWindow: () => {},
  })
  runtime.set('acc-clear', {
    account_id: 'acc-clear',
    vm_id: 'vm-13',
    cooldown_until: Date.now() + 3600_000,
    cooldown_reason: 'account_quota_exhausted',
  })
  q.ingestOAuthUsage('acc-clear', {
    ok: true,
    source: 'official-cc-usage',
    five_hour: { utilization: 0.85, status: 'allowed', resets_at: futureReset(4 * 3600_000) },
    seven_day: { utilization: 0.36, status: 'allowed' },
    probed_at: new Date().toISOString(),
  })
  assert.equal(q.canAccept('acc-clear').ok, false)
  q.ingestOAuthUsage('acc-clear', {
    ok: true,
    source: 'official-cc-usage',
    five_hour: { utilization: 0.44, status: 'allowed', resets_at: futureReset(4 * 3600_000) },
    seven_day: { utilization: 0.36, status: 'allowed' },
    probed_at: new Date().toISOString(),
  })
  const acc = q.repo.get('acc-clear')
  assert.equal(acc.unified.official['5h'].utilization, 0.44)
  assert.equal(q.canAccept('acc-clear').ok, true)
  assert.equal(runtime.get('acc-clear').cooldown_until, null)
  assert.equal(runtime.get('acc-clear').cooldown_reason, null)
})

test('/usage 40 writes Extra 0.40; 1 percent writes 0.01 not 1.0', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: { quota: { safety_ratio: 0.85, block_on_5h: true } } })
  q.ingestOAuthUsage('acc-scale', {
    ok: true,
    source: 'official-cc-usage',
    interpretations: {
      official: {
        five_hour: { utilization: 0.4, used_pct: 40, status: 'allowed' },
        seven_day: { utilization: 0.01, used_pct: 1, status: 'allowed' },
      },
    },
    probed_at: new Date().toISOString(),
  })
  const acc = q.repo.get('acc-scale')
  assert.equal(acc.unified.headers['5h'].utilization, 0.4)
  assert.equal(acc.unified.headers['7d'].utilization, 0.01)
  assert.notEqual(acc.unified.headers['7d'].utilization, 1)
})

test('official 0.90 plus header 0.40 is schedulable', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, weekly_safety_ratio: 0.8, block_on_5h: true, block_on_7d: true } },
  })
  const acc = q.ensure({ account_id: 'acc-mix-open' })
  acc.unified.official = {
    '5h': { utilization: 0.9, status: 'allowed', reset: futureReset(4 * 3600_000) },
    '7d': { utilization: 0.9, status: 'allowed' },
  }
  acc.unified['5h'] = acc.unified.official['5h']
  acc.unified['7d'] = acc.unified.official['7d']
  acc.unified.headers = {
    sampled_at: new Date().toISOString(),
    '5h': { utilization: 0.4, status: 'allowed', reset: futureReset(4 * 3600_000) },
    '7d': { utilization: 0.2, status: 'allowed' },
  }
  q.repo.save(acc)
  assert.equal(q.canAccept('acc-mix-open').ok, true)
})

test('header 0.90 plus official 0.40 hits the 5h gate', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, weekly_safety_ratio: 0.8, block_on_5h: true, block_on_7d: true } },
  })
  const acc = q.ensure({ account_id: 'acc-mix-shut' })
  acc.unified.official = {
    '5h': { utilization: 0.4, status: 'allowed', reset: futureReset(4 * 3600_000) },
  }
  acc.unified.headers = {
    sampled_at: new Date().toISOString(),
    '5h': { utilization: 0.9, status: 'allowed', reset: futureReset(4 * 3600_000) },
  }
  q.repo.save(acc)
  const gate = q.canAccept('acc-mix-shut')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'quota_5h_safety')
})

test('elapsed Extra is not restored from leftover official 100%', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: { quota: { safety_ratio: 0.85, block_on_5h: true } } })
  const nextReset = new Date(Date.now() + 4 * 3600_000).toISOString()
  q.ingestOAuthUsage('acc-restore', {
    ok: true,
    source: 'official-cc-usage',
    five_hour: { utilization: 1, status: 'rejected', resets_at: nextReset },
    seven_day: { utilization: 0.2, status: 'allowed', resets_at: nextReset },
    probed_at: new Date().toISOString(),
  })
  const acc = q.repo.get('acc-restore')
  acc.unified.headers['5h'] = {
    utilization: 1,
    status: 'rejected',
    reset: new Date(Date.now() - 30_000).toISOString(),
  }
  q.repo.save(acc)
  const saved = q.persistEffectiveWindows('acc-restore')
  assert.equal(Number(saved.unified.headers['5h'].utilization), 0)
  assert.equal(saved.unified.headers['5h'].status, 'active')
  assert.equal(q.canAccept('acc-restore').ok, true)
})

test('already-wiped Extra stays empty when official leftover is still 100%', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: { quota: { safety_ratio: 0.85, block_on_5h: true } } })
  const nextReset = new Date(Date.now() + 4 * 3600_000).toISOString()
  q.ingestOAuthUsage('acc-stale-wipe', {
    ok: true,
    source: 'official-cc-usage',
    five_hour: { utilization: 1, status: 'rejected', resets_at: nextReset },
    seven_day: { utilization: 0.2, status: 'allowed', resets_at: nextReset },
    probed_at: new Date().toISOString(),
  })
  const acc = q.repo.get('acc-stale-wipe')
  acc.unified.headers['5h'] = {
    utilization: 0,
    status: 'active',
    reset: new Date(Date.now() - 30_000).toISOString(),
    stale: true,
    stale_reason: 'reset_elapsed',
  }
  q.repo.save(acc)
  const saved = q.persistEffectiveWindows('acc-stale-wipe')
  assert.equal(Number(saved.unified.headers['5h'].utilization), 0)
  assert.equal(saved.unified.headers['5h'].status, 'active')
  assert.equal(q.canAccept('acc-stale-wipe').ok, true)
})

test('persistEffectiveWindows heals Extra overwritten by leftover official 100%', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: { quota: { safety_ratio: 0.85, block_on_5h: true } } })
  const reset = futureReset(4 * 3600_000)
  q.ingestHeaders('acc-heal', {
    'anthropic-ratelimit-unified-5h-utilization': '0.36',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-reset': reset,
  })
  const acc = q.repo.get('acc-heal')
  acc.unified.official = {
    '5h': { utilization: 1, status: 'rejected', reset },
    '7d': { utilization: 0.5, status: 'allowed' },
  }
  acc.unified['5h'] = acc.unified.official['5h']
  acc.unified.headers['5h'] = { utilization: 1, status: 'rejected', reset }
  acc.unified.headers.sampled_at = '2026-08-25T08:40:57.012Z'
  acc.last_probe = { ok: true, source: 'official-cc-usage', at: '2026-08-25T08:40:57.012Z' }
  acc.unified.last_probe = acc.last_probe
  q.repo.save(acc)
  const saved = q.persistEffectiveWindows('acc-heal')
  assert.equal(Number(saved.unified.headers['5h'].utilization), 0.36)
  assert.equal(saved.unified.headers['5h'].status, 'allowed')
  assert.equal(q.canAccept('acc-heal').ok, true)
})

test('elapsed header reset wipes Extra and becomes schedulable', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: { quota: { safety_ratio: 0.85, block_on_5h: true } } })
  q.ingestHeaders('acc-wipe', {
    'anthropic-ratelimit-unified-5h-utilization': '0.91',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': new Date(Date.now() - 30_000).toISOString(),
  })
  assert.equal(q.canAccept('acc-wipe').ok, true)
  const saved = q.persistEffectiveWindows('acc-wipe')
  assert.equal(Number(saved.unified.headers['5h'].utilization), 0)
  assert.equal(saved.unified.headers['5h'].status, 'active')
})
