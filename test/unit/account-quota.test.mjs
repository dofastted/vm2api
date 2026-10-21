import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountQuota, extraHeadersFromLimitError } from '../../src/lib/pool/account-quota.mjs'
import { parseResetMs } from '../../src/lib/pool/quota-window.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-quota-'))
}

test('ensure seeds account and is idempotent', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: {},
    accounts: [{ account_id: 'a1', vm_id: 'vm-1', email: 'a@x' }],
  }).init()
  const acc = q.ensure({ account_id: 'a1' })
  assert.equal(acc.vm_id, 'vm-1')
  assert.equal(acc.email, 'a@x')
  assert.equal(acc.requests, 0)
  assert.equal(acc.unified['5h'].status, 'active')
})

test('a model entitlement rejection is persisted for that account and model', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  q.ensure({ account_id: 'a-denied' })
  q.markModelUnsupported('a-denied', 'claude-fable-5')
  const until = q.repo.get('a-denied').unified.model_denied_until['claude-fable-5']
  assert.ok(until > Date.now())
  assert.ok(until <= Date.now() + 60 * 60_000)
  q.clearModelUnsupported('a-denied', 'claude-fable-5')
  assert.equal(q.repo.get('a-denied').unified.model_denied_until['claude-fable-5'], undefined)
})

function futureReset(msFromNow) {
  return new Date(Date.now() + msFromNow).toISOString()
}

test('ingestHeaders updates unified windows + counters + allocations', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
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

test('ingestHeaders countRequest:false does not overwrite Extra with hello 0%', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
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

test('ingestHeaders accumulates cache tokens and mirrors the session window', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
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

test('ingestHeaders reads OpenAI prompt_tokens_details cache fields', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
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
  assert.equal(acc.tokens_in, 6)
  assert.equal(acc.tokens_out, 4)
  assert.equal(acc.cache_read_tokens, 11)
  assert.equal(acc.cache_creation_tokens, 3)
})

test('test-chat last_probe does not overwrite a successful usage probe', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
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

test('canAccept blocks at safety ratio and records last_blocked', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
  q.ingestHeaders('a3', { 'anthropic-ratelimit-unified-5h-utilization': '0.96' })
  const gate = q.canAccept('a3')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'quota_5h_safety')
  const acc = q.snapshot().accounts.find((a) => a.account_id === 'a3')
  assert.equal(acc.last_blocked.window, '5h')
})

test('cli rate_limit_event blocks via status', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  q.ingestCliRateLimit('a4', { rateLimitType: 'five_hour', status: 'rejected', resetsAt: 1893456000 })
  const gate = q.canAccept('a4')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'quota_5h_cli')
})

test('official 26 percent does not trip the quota gate', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, block_on_5h: true, block_on_7d: true } },
  }).init()
  q.ingestHeaders('pct-26', {
    'anthropic-ratelimit-unified-5h-utilization': '26',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': futureReset(4 * 3600_000),
  })
  const gate = q.canAccept('pct-26')
  assert.equal(gate.ok, true)
  assert.equal(q.headerUnderSafety(q.repo.get('pct-26')), true)
})

test('extraHeadersFromLimitError fills Extra 5h + reset from the text when wrap omits headers', () => {
  const now = Date.parse('2026-09-23T12:37:10Z')
  const filled = extraHeadersFromLimitError(
    "provider error: You've hit your limit · resets 7:50pm (America/New_York)",
    {},
    now,
  )
  assert.equal(filled['anthropic-ratelimit-unified-5h-status'], 'rejected')
  assert.equal(filled['anthropic-ratelimit-unified-5h-reset'], String(Date.parse('2026-09-23T23:50:00Z') / 1000))
  const weekly = extraHeadersFromLimitError("You've hit your weekly limit · resets Sep 25, 3pm (UTC)", {}, now)
  assert.equal(weekly['anthropic-ratelimit-unified-7d-status'], 'rejected')
  assert.equal(weekly['anthropic-ratelimit-unified-5h-status'], undefined)
  const kept = extraHeadersFromLimitError('hit your limit', {
    'anthropic-ratelimit-unified-5h-status': 'allowed_warning',
  })
  assert.equal(kept['anthropic-ratelimit-unified-5h-status'], 'allowed_warning')
})

test('limit error without a fresh reset does not inherit the elapsed reset', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  const elapsed = String(Math.floor((Date.now() - 3_600_000) / 1000))
  q.ingestHeaders('elapsed-5h', {
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.4',
    'anthropic-ratelimit-unified-5h-reset': elapsed,
  })
  q.ingestHeaders('elapsed-5h', extraHeadersFromLimitError('hit your limit', {}), null, {
    exhausted: true,
    countRequest: false,
  })
  const acc = q.repo.get('elapsed-5h')
  assert.equal(acc.unified.headers['5h'].status, 'rejected')
  assert.equal(acc.unified.headers['5h'].reset, null)
  assert.ok(acc.unified.headers.exhausted_at)
})

test('cli rate_limit_event copies unifiedWindows utilization', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
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

test('tryAcquire enforces and releases the configured concurrency cap', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    accounts: [{ account_id: 'acc-reserve', max_concurrency: 1, concurrency_override: 1 }],
  }).init()
  assert.equal(q.tryAcquire('acc-reserve').ok, true)
  assert.equal(q.tryAcquire('acc-reserve').reason, 'concurrency_limit')
  q.release('acc-reserve')
  assert.equal(q.tryAcquire('acc-reserve').ok, true)
  q.release('acc-reserve')
})

test('state persists across re-open (same dataDir)', async () => {
  const dir = tmpDir()
  const q1 = await new AccountQuota({ dataDir: dir, config: {} }).init()
  q1.ingestHeaders('a5', { 'anthropic-ratelimit-unified-7d-utilization': '0.5' }, { input_tokens: 7, output_tokens: 3 })

  const q2 = await new AccountQuota({ dataDir: dir, config: {} }).init()
  const acc = q2.snapshot().accounts.find((a) => a.account_id === 'a5')
  assert.ok(acc)
  assert.equal(acc.unified['7d'].utilization, 0.5)
  assert.equal(acc.tokens_in, 7)
  assert.equal(acc.requests, 1)
  assert.equal(acc.recent_allocations.length, 1)
})

test('allocations trimmed to 50 per account', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  for (let i = 0; i < 60; i++) {
    q.ingestHeaders('a6', { 'anthropic-ratelimit-unified-5h-utilization': String(i / 100) })
  }
  assert.equal(q.repo.allocationCount('a6'), 50)
  const recent = q.repo.recentAllocations('a6', 5)
  assert.equal(recent.length, 5)
  assert.equal(recent[4].util_5h, 0.59)
})

test('max_concurrency 0 blocks instead of treating as unlimited', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { concurrency: { default_max_per_account: 20 } },
  }).init()
  q.ensure({ account_id: 'zero', max_concurrency: 0 })
  q.setMaxConcurrency('zero', 0, { override: true })
  const gate = q.canAccept('zero')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'concurrency_limit')
  assert.equal(gate.detail.max, 0)
})

test('rebindToVm moves the UUID row onto the new slot', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  q.ensure({ account_id: '1c5a7a73', vm_id: 'vm-02', email: 'old@x' })
  q.rebindToVm('1c5a7a73', 'vm-04', { email: 'new@x' })
  const acc = q.snapshot().accounts.find((a) => a.account_id === '1c5a7a73')
  assert.equal(acc.vm_id, 'vm-04')
  assert.equal(acc.email, 'new@x')
})

test('concurrency inflight gate stays in memory', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { concurrency: { default_max_per_account: 1 } },
  }).init()
  q.ensure({ account_id: 'a7' })
  q.setMaxConcurrency('a7', 1, { override: true })
  q.acquire('a7')
  const gate = q.canAccept('a7')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'concurrency_limit')
  q.release('a7')
  assert.equal(q.canAccept('a7').ok, true)
})

test('rpm window blocks then recovers', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
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

test('max_rpm 0 is unlimited', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  q.ensure({ account_id: 'rpm-off', max_concurrency: 8, max_rpm: 0 })
  for (let i = 0; i < 5; i++) {
    assert.equal(q.tryAcquire('rpm-off').ok, true)
    q.release('rpm-off')
  }
  assert.equal(q.canAccept('rpm-off').ok, true)
})

test('quota gate still blocks before RPM wait', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, block_on_5h: true, block_on_7d: true } },
  }).init()
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

test('ingestOAuthUsage stores 5h/7d and isolated fable limit', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
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

test('official /usage 429 keeps the last successful probe', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
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

test('usage ok plus fable 401 does not poison last_probe with revoke text', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
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
  assert.equal(acc.unified.fable.plan_denied, false)
  q.clearGrantRevokeLeftover('acc-pro-401')
  const after = q.repo.get('acc-pro-401')
  assert.equal(after.unified.last_probe.error, null)
  assert.equal(after.unified.fable.plan_denied, false)
  assert.equal(after.unified.account_tier, undefined)
})

test('Fable 403 does not classify Pro when official usage cannot verify the grant', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  q.ingestOAuthUsage('acc-uncertain-403', {
    ok: false,
    usage_status: 500,
    fable: { ok: false, plan_denied: true, status: 403, model: 'claude-fable-5' },
    probed_at: new Date().toISOString(),
  })
  const acc = q.repo.get('acc-uncertain-403')
  assert.equal(acc.unified.account_tier, undefined)
  assert.equal(acc.unified.fable.plan_denied, false)
})

test('official usage without Fable evidence does not classify an unprobed account as Pro', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  q.ingestOAuthUsage('acc-unprobed', {
    ok: true,
    usage_status: 200,
    usage_has_fable: false,
    five_hour: { utilization: 0.1, status: 'allowed' },
    probed_at: new Date().toISOString(),
  })
  const acc = q.repo.get('acc-unprobed')
  assert.equal(acc.unified.account_tier, undefined)
  assert.equal(acc.unified.fable, undefined)
})

test('complete official usage without Fable classifies Pro', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  q.ingestOAuthUsage('acc-complete-pro', {
    ok: true,
    usage_status: 200,
    limits_present: true,
    usage_has_fable: false,
    five_hour: { utilization: 0.1, status: 'allowed' },
    seven_day: { utilization: 0.2, status: 'allowed' },
    probed_at: new Date().toISOString(),
  })
  const acc = q.repo.get('acc-complete-pro')
  assert.equal(acc.unified.usage_has_fable, false)
  assert.equal(acc.unified.account_tier, 'pro')
})

test('complete official usage overrides a stale profile tier', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  q.ensure({ account_id: 'acc-stale-profile' })
  q.setAccountTier('acc-stale-profile', 'max', { source: 'profile' })
  q.ingestOAuthUsage('acc-stale-profile', {
    ok: true,
    usage_status: 200,
    limits_present: true,
    usage_has_fable: false,
    five_hour: { utilization: 0.1, status: 'allowed' },
    seven_day: { utilization: 0.2, status: 'allowed' },
    probed_at: new Date().toISOString(),
  })
  const acc = q.repo.get('acc-stale-profile')
  assert.equal(acc.unified.account_tier, 'pro')
  assert.equal(acc.unified.account_tier_source, 'usage')
})

test('setup-token usage scope failure preserves historical tier and does not mark grant dead', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  q.ensure({ account_id: 'acc-setup-scope' })
  q.setAccountTier('acc-setup-scope', 'max', { source: 'usage' })
  q.ingestOAuthUsage('acc-setup-scope', {
    ok: false,
    usage_status: 403,
    usage_scope_missing: true,
    usage_error: '当前凭证缺少 user:profile scope，需导入完整 OAuth 后才能探测官方 /usage',
    probed_at: new Date().toISOString(),
  })
  const acc = q.repo.get('acc-setup-scope')
  assert.equal(acc.unified.account_tier, 'max')
  assert.equal(acc.unified.fable, undefined)
  assert.equal(acc.unified.last_probe.ok, false)
  assert.match(acc.unified.last_probe.error, /user:profile/)
})

test('incomplete official usage without Fable does not downgrade a stored Max', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  q.ensure({ account_id: 'acc-incomplete-max' })
  q.setAccountTier('acc-incomplete-max', 'max', { source: 'usage' })
  q.ingestOAuthUsage('acc-incomplete-max', {
    ok: true,
    usage_status: 200,
    usage_has_fable: false,
    five_hour: { utilization: 0.1, status: 'allowed' },
    probed_at: new Date().toISOString(),
  })
  const acc = q.repo.get('acc-incomplete-max')
  assert.equal(acc.unified.usage_has_fable, undefined)
  assert.equal(acc.unified.account_tier, 'max')
})

test('clearGrantRevokeLeftover drops stale revoke after refresh', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
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
  assert.equal(acc.unified.fable.plan_denied, false)
  assert.equal(acc.unified.account_tier, undefined)
})

test('clearGrantRevokeLeftover keeps stored Max off leftover Fable revoke', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
  q.ingestOAuthUsage('acc-max', {
    ok: true,
    usage_status: 200,
    limits_present: true,
    usage_has_fable: true,
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

test('fable 429 without 7d_oi window does not invent a full Fable quota', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
  q.ingestOAuthUsage('acc-pro', {
    ok: true,
    five_hour: { utilization: 0.1, status: 'allowed' },
    seven_day: { utilization: 0.2, status: 'allowed' },
    fable: { ok: false, limited: true, banned: false, plan_denied: false, status: 429, model: 'claude-fable-5' },
    probed_at: '2026-08-22T00:00:00Z',
  })
  const acc = q.repo.get('acc-pro')
  assert.equal(acc.unified.fable.limited, false)
  assert.equal(acc.unified.fable.plan_denied, false)
  assert.equal(acc.unified.account_tier, undefined)
  assert.equal(acc.unified['7d_oi']?.status || null, null)
  assert.equal(q.canAccept('acc-pro').ok, true)
  assert.equal(q.fableWindowLimited('acc-pro'), false)
})

test('official usage without Fable hop does not turn leftover 429 into Pro', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
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
  assert.equal(q.repo.get('acc-pro-skip').unified.account_tier, undefined)
  q.ingestOAuthUsage('acc-pro-skip', {
    ok: true,
    usage_status: 200,
    source: 'official-cc-usage',
    five_hour: { utilization: 0.03, status: 'allowed' },
    seven_day: { utilization: 0.11, status: 'allowed' },
    probed_at: '2026-08-24T00:00:00Z',
  })
  const acc = q.repo.get('acc-pro-skip')
  assert.equal(acc.unified.fable.plan_denied, false)
  assert.equal(acc.unified.fable.ok, false)
  assert.equal(acc.unified.fable.error, 'Error')
  assert.equal(acc.unified.account_tier, undefined)
})

test('Fable hop alone does not classify Pro; complete usage can flip stored Pro to Max', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
  q.ingestOAuthUsage('acc-mispro', {
    ok: true,
    usage_status: 200,
    five_hour: { utilization: 0.1, status: 'allowed' },
    seven_day: { utilization: 0.2, status: 'allowed' },
    fable: { ok: false, plan_denied: true, status: 403, model: 'claude-fable-5' },
    probed_at: '2026-08-22T00:00:00Z',
  })
  assert.equal(q.repo.get('acc-mispro').unified.account_tier, undefined)
  q.setAccountTier('acc-mispro', 'pro', { source: 'usage' })
  q.ingestOAuthUsage('acc-mispro', {
    ok: true,
    usage_status: 200,
    limits_present: true,
    usage_has_fable: true,
    five_hour: { utilization: 0.1, status: 'allowed' },
    seven_day: { utilization: 0.2, resets_at: '2026-08-24T00:00:00Z', status: 'allowed' },
    seven_day_oi: { utilization: 0.21, resets_at: '2026-08-24T00:00:00Z', status: 'allowed' },
    fable: { ok: false, plan_denied: true, status: 403, model: 'claude-fable-5' },
    probed_at: '2026-08-24T00:00:00Z',
  })
  const acc = q.repo.get('acc-mispro')
  assert.equal(acc.unified.account_tier, 'max')
  assert.equal(acc.unified.usage_has_fable, true)
  assert.equal(acc.unified.fable.plan_denied, false)
  assert.equal(acc.unified.fable.ok, true)
})

test('7d_oi window is Fable-only and does not block the account', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
  const reset = futureReset(7 * 24 * 3600_000)
  q.ingestHeaders('acc-oi', {
    'anthropic-ratelimit-unified-7d_oi-utilization': '1',
    'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
    'anthropic-ratelimit-unified-7d_oi-reset': reset,
    'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
  })
  assert.equal(q.canAccept('acc-oi').ok, true)
  assert.equal(q.fableWindowLimited('acc-oi'), true)
  assert.equal(q.fableWindowResetAt('acc-oi'), Date.parse(reset))
})

test('7d_oi rejected with elapsed second-level reset is not Fable-limited', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
  const now = Date.parse('2026-10-19T09:00:00Z')
  const resetSec = '1792206000'
  const acc = q.ensure({ account_id: 'acc-oi-elapsed' })
  acc.unified['7d_oi'] = {
    utilization: 1,
    reset: resetSec,
    status: 'rejected',
    claim: 'seven_day_overage_included',
  }
  q.repo.save(acc)
  assert.ok(parseResetMs(resetSec) <= now)
  assert.equal(q.fableWindowLimited('acc-oi-elapsed', now), false)
  assert.equal(q.fableWindowResetAt('acc-oi-elapsed'), parseResetMs(resetSec))
})

test('7d_oi rejected without reset stays Fable-limited', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  const acc = q.ensure({ account_id: 'acc-oi-no-reset' })
  acc.unified['7d_oi'] = { utilization: 1, status: 'rejected' }
  q.repo.save(acc)
  assert.equal(q.fableWindowLimited('acc-oi-no-reset'), true)
  assert.equal(q.fableWindowResetAt('acc-oi-no-reset'), null)
})

test('7d_oi rejected with future second-level reset stays Fable-limited', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  const now = Date.parse('2026-10-19T09:00:00Z')
  const resetSec = '1792810800'
  const acc = q.ensure({ account_id: 'acc-oi-future' })
  acc.unified['7d_oi'] = { utilization: 1, reset: resetSec, status: 'rejected' }
  q.repo.save(acc)
  assert.ok(parseResetMs(resetSec) > now)
  assert.equal(q.fableWindowLimited('acc-oi-future', now), true)
  assert.equal(q.fableWindowResetAt('acc-oi-future'), parseResetMs(resetSec))
})

test('persistEffectiveWindows clears elapsed unified 7d_oi', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  const now = Date.parse('2026-10-19T09:00:00Z')
  const acc = q.ensure({ account_id: 'acc-wipe-oi' })
  acc.unified['7d_oi'] = { utilization: 1, reset: '1792206000', status: 'rejected' }
  acc.unified.headers = { '5h': { utilization: 0.1, status: 'allowed', reset: '2099-01-01T00:00:00Z' } }
  q.repo.save(acc)
  q.persistEffectiveWindows('acc-wipe-oi', { now })
  const oi = q.repo.get('acc-wipe-oi').unified['7d_oi']
  assert.equal(oi.utilization, 0)
  assert.equal(oi.status, 'active')
  assert.equal(oi.stale_reason, 'reset_elapsed')
})

test('probe 5h rejected with no last_used stays a hard block until reset', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
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

test('official probe fills Extra reset when Extra has usage but no reset', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  q.ingestHeaders('acc-no-reset', {
    'anthropic-ratelimit-unified-5h-utilization': '0.44',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
  })
  assert.equal(q.repo.get('acc-no-reset').unified.headers['5h'].reset, null)
  const reset = futureReset(4 * 3600_000)
  q.ingestOAuthUsage('acc-no-reset', {
    ok: true,
    source: 'official-cc-usage',
    five_hour: { utilization: 0.12, status: 'allowed', resets_at: reset },
    seven_day: { utilization: 0.08, status: 'allowed', resets_at: futureReset(6 * 24 * 3600_000) },
    probed_at: new Date().toISOString(),
  })
  const acc = q.repo.get('acc-no-reset')
  assert.equal(acc.unified.headers['5h'].utilization, 0.44)
  assert.equal(acc.unified.headers['5h'].reset, reset)
})

test('official leftover 100% does not overwrite live Extra allowed', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
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

test('successful probe overwrites leftover rejected when official percent is low', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
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

test('probe 5h rejected stays blocked when last_used is missing', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
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

test('probe 5h rejected stays blocked when the slot was used in this window', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
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

test('persistEffectiveWindows writes a cleared 5h after reset elapsed', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
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

test('elapsed 5h reset is not a hard block even after a live header write', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } },
  }).init()
  q.ingestHeaders('acc-elapsed', {
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': new Date(Date.now() - 60_000).toISOString(),
  })
  assert.equal(q.canAccept('acc-elapsed').ok, true)
})

test('429 unified exhausted marks headers rejected without inventing official 100%', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
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

test('local 429 without quota evidence does not reject the 5h window', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  q.ingestHeaders('acc-local-429', {
    'anthropic-ratelimit-unified-5h-utilization': '0.23',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.04',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
  })
  q.ingestHeaders('acc-local-429', {}, null, { status: 429, exhausted: false, countRequest: false })
  q.ingestHeaders('acc-local-503', {
    'anthropic-ratelimit-unified-5h-utilization': '0.23',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
  })
  q.ingestHeaders('acc-local-503', {}, null, { status: 503, exhausted: false, countRequest: false })
  const local = q.repo.get('acc-local-429')
  assert.equal(local.unified.headers['5h'].status, 'allowed')
  assert.equal(local.unified.headers['5h'].utilization, 0.23)
  assert.equal(local.unified.headers['7d'].status, 'allowed')
  assert.equal(q.repo.get('acc-local-503').unified.headers['5h'].status, 'allowed')
  q.ingestHeaders(
    'acc-header-429',
    {
      'anthropic-ratelimit-unified-5h-utilization': '0.9',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
    },
    null,
    { status: 429, exhausted: false, countRequest: false },
  )
  assert.equal(q.repo.get('acc-header-429').unified.headers['5h'].status, 'rejected')
  assert.equal(q.canAccept('acc-local-429').ok, true)
  assert.equal(q.canAccept('acc-header-429').ok, false)
})

test('stuck 5h header with growing tokens does not lift official utilization', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { block_on_5h: true }, tiers: { default: { limit_5h: 0.85 } } },
  }).init()
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

test('official /usage 40 percent is 0.40 and stays under the 80 percent gate', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, weekly_safety_ratio: 0.8, block_on_5h: true, block_on_7d: true } },
  }).init()
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

test('persistEffectiveWindows clears leftover quota cooldown when official is under the gate', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, block_on_5h: true, block_on_7d: true } },
  }).init()
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

test('official 0.44 allowed overwrites local 0.9 and clears quota cooldown', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, block_on_5h: true, block_on_7d: true } },
  }).init()
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
    // 0.85 line + 0.05 default overshoot.
    five_hour: { utilization: 0.9, status: 'allowed', resets_at: futureReset(4 * 3600_000) },
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

test('/usage 40 writes Extra 0.40; 1 percent writes 0.01 not 1.0', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, block_on_5h: true } },
  }).init()
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

test('official 0.90 plus header 0.40 is schedulable', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, weekly_safety_ratio: 0.8, block_on_5h: true, block_on_7d: true } },
  }).init()
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

test('header 0.90 plus official 0.40 hits the 5h gate', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, weekly_safety_ratio: 0.8, block_on_5h: true, block_on_7d: true } },
  }).init()
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

test('elapsed Extra is not restored from leftover official 100%', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, block_on_5h: true } },
  }).init()
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

test('already-wiped Extra stays empty when official leftover is still 100%', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, block_on_5h: true } },
  }).init()
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

test('persistEffectiveWindows heals Extra overwritten by leftover official 100%', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, block_on_5h: true } },
  }).init()
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

test('elapsed header reset wipes Extra and becomes schedulable', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: { quota: { safety_ratio: 0.85, block_on_5h: true } },
  }).init()
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

test('complete usage may replace a profile-sourced tier', async () => {
  const quota = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  quota.ensure({ account_id: 'acct-profile', vm_id: 'vm-01' })
  quota.setAccountTier('acct-profile', 'pro', { source: 'profile' })
  quota.setAccountTier('acct-profile', 'max')
  assert.equal(quota.repo.get('acct-profile').unified.account_tier, 'pro')
  quota.ingestOAuthUsage('acct-profile', {
    ok: true,
    usage_status: 200,
    limits_present: true,
    usage_has_fable: true,
    seven_day_oi: { utilization: 0.2, resets_at: '2026-09-30T00:00:00Z' },
  })
  assert.equal(quota.repo.get('acct-profile').unified.account_tier, 'max')
  assert.equal(quota.repo.get('acct-profile').unified.account_tier_source, 'usage')
  quota.setAccountTier('acct-profile', 'max', { source: 'profile' })
  assert.equal(quota.repo.get('acct-profile').unified.account_tier, 'max')
})

test('concurrent completed hops persist every quota counter update', async () => {
  const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
  q.ensure({ account_id: 'parallel-account' })
  await Promise.all(
    Array.from({ length: 20 }, () =>
      Promise.resolve().then(() => {
        q.ingestHeaders('parallel-account', {}, { input_tokens: 3, output_tokens: 2 })
      }),
    ),
  )
  await q.flush()
  const stored = await q.persistence.get('parallel-account')
  assert.equal(stored.requests, 20)
  assert.equal(stored.tokens_in, 60)
  assert.equal(stored.tokens_out, 40)
})

test('restore reload does not recreate accounts from the original startup seed', async () => {
  const q = await new AccountQuota({
    dataDir: tmpDir(),
    config: {},
    accounts: [{ account_id: 'old-startup-account' }],
  }).init()
  await q.persistence.remove('old-startup-account')
  await q.rebind(q.db)
  assert.equal(q.repo.get('old-startup-account'), null)
  assert.equal(await q.persistence.get('old-startup-account'), null)
})

for (const source of ['headers', 'cli']) {
  test(`${source} quota counters add exactly beyond JavaScript safe integers`, async () => {
    const q = await new AccountQuota({ dataDir: tmpDir(), config: {} }).init()
    q.ensure({ account_id: 'large-counters' })
    await q.flush()
    await q.db
      .prepare(`UPDATE accounts SET requests = $1, tokens_in = $1, tokens_out = $1,
      cache_read_tokens = $1, cache_creation_tokens = $1 WHERE id = $2`)
      .run('9007199254740993', 'large-counters')
    await q.reload()
    if (source === 'headers')
      q.ingestHeaders(
        'large-counters',
        {},
        {
          input_tokens: 2,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 5,
        },
      )
    else q.ingestCliRateLimit('large-counters', null, { input_tokens: 2, output_tokens: 3 })
    await q.flush()
    const account = await q.persistence.get('large-counters')
    assert.equal(account.requests, '9007199254740994')
    assert.equal(account.tokens_in, '9007199254740995')
    assert.equal(account.tokens_out, '9007199254740996')
    assert.equal(account.cache_read_tokens, source === 'headers' ? '9007199254740997' : '9007199254740993')
    assert.equal(account.cache_creation_tokens, source === 'headers' ? '9007199254740998' : '9007199254740993')
    q.ensure({ account_id: 'large-delta' })
    if (source === 'headers')
      q.ingestHeaders(
        'large-delta',
        {},
        {
          input_tokens: '9007199254740993',
          output_tokens: '9007199254740995',
        },
      )
    else
      q.ingestCliRateLimit('large-delta', null, {
        input_tokens: '9007199254740993',
        output_tokens: '9007199254740995',
      })
    await q.flush()
    const delta = await q.persistence.get('large-delta')
    assert.equal(delta.tokens_in, '9007199254740993')
    assert.equal(delta.tokens_out, '9007199254740995')
  })
}
