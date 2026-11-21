import test from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveRateWindow,
  officialWindow,
  headerWindow,
  headerHardBlocked,
  WINDOW_5H_MS,
  toPercentUsed,
  usageWindowsEmpty,
  publicUsageWindow,
  parseLimitResetFromMessage,
  isPlanLimitMessage,
  isAccountQuotaExhausted,
  limitWindowFromMessage,
  hasOfficialUsageSample,
  hasLiveExtraSample,
  extraWindowSince,
  wipeElapsedHeaderWindows,
  parseResetMs,
  listQuotaFromHeaders,
  NO_RESET_REJECT_HOLD_MS,
  noResetRejectUntilMs,
} from '../../src/lib/pool/quota-window.mjs'
import { quotaGuardUsage } from '../../src/lib/pool/pool-scheduler.mjs'

test('wipeElapsedHeaderWindows clears unified 7d_oi when reset elapsed', () => {
  const now = Date.parse('2026-10-19T09:00:00Z')
  const resetSec = '1792206000'
  assert.ok(parseResetMs(resetSec) <= now)
  const { oi, changed } = wipeElapsedHeaderWindows(
    { '7d_oi': { utilization: 1, reset: resetSec, status: 'rejected' } },
    { now },
  )
  assert.equal(changed, true)
  assert.equal(oi.utilization, 0)
  assert.equal(oi.status, 'active')
  assert.equal(oi.stale_reason, 'reset_elapsed')
})

test('wipeElapsedHeaderWindows keeps unified 7d_oi when reset is still future', () => {
  const now = Date.parse('2026-10-19T09:00:00Z')
  const resetSec = '1792810800'
  assert.ok(parseResetMs(resetSec) > now)
  const { oi, changed } = wipeElapsedHeaderWindows(
    { '7d_oi': { utilization: 1, reset: resetSec, status: 'rejected' } },
    { now },
  )
  assert.equal(changed, false)
  assert.equal(oi, null)
})

test('listQuotaFromHeaders falls back to headers 7d_oi when unified has no window', () => {
  const now = Date.parse('2026-10-19T09:00:00Z')
  const resetSec = '1792810800'
  const listed = listQuotaFromHeaders(
    {
      headers: {
        '7d_oi': { utilization: 0.21, reset: resetSec, status: 'allowed' },
        '5h': { utilization: 0.1, status: 'allowed', reset: '2099-01-01T00:00:00Z' },
      },
    },
    { now },
  )
  assert.equal(listed.utilization_7d_oi, 0.21)
  assert.equal(listed.status_7d_oi, 'allowed')
  assert.equal(listed.reset_7d_oi, resetSec)
})

test('officialWindow prefers official over headers and leftover flat percent', () => {
  const u = {
    source: 'official-cc-usage',
    '5h': { utilization: 0.85, status: 'allowed' },
    official: { '5h': { utilization: 0.44, status: 'allowed', reset: '2026-08-24T21:40:00.000Z' } },
    headers: { '5h': { utilization: 0.44, status: 'rejected' } },
  }
  assert.equal(officialWindow(u, '5h').utilization, 0.44)
  assert.equal(headerWindow(u, '5h').status, 'rejected')
})

test('officialWindow does not fall back to headers', () => {
  const u = {
    '5h': { utilization: 0, status: 'active' },
    headers: { '5h': { utilization: 0.42, status: 'allowed' } },
  }
  assert.equal(officialWindow(u, '5h').utilization, 0)
  assert.equal(headerWindow(u, '5h').utilization, 0.42)
})

test('elapsed reset always clears, even with a recent last_used_at', () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z')
  const w = effectiveRateWindow(
    {
      utilization: 1,
      status: 'rejected',
      reset: '2026-08-24T11:59:00.000Z',
    },
    { now, lastUsedAt: now - 10_000, source: 'headers' },
  )
  assert.equal(w.utilization, 0)
  assert.equal(w.status, 'active')
  assert.equal(w.stale_reason, 'reset_elapsed')
})

test('probe sticky 100% with no last_used stays limited until reset', () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z')
  const w = effectiveRateWindow(
    {
      utilization: 1,
      status: 'rejected',
      reset: new Date(now + 4 * 3600_000).toISOString(),
    },
    {
      now,
      lastUsedAt: null,
      source: 'official-cc-usage',
      durationMs: WINDOW_5H_MS,
    },
  )
  assert.equal(w.utilization, 1)
  assert.equal(w.status, 'rejected')
  assert.equal(w.stale, false)
})

test('probe sticky 100% with last_used before this window is cleared', () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z')
  const reset = now + 4 * 3600_000
  const w = effectiveRateWindow(
    {
      utilization: 1,
      status: 'rejected',
      reset: new Date(reset).toISOString(),
    },
    {
      now,
      lastUsedAt: reset - WINDOW_5H_MS - 60_000,
      source: 'official-cc-usage',
      durationMs: WINDOW_5H_MS,
    },
  )
  assert.equal(w.utilization, 0)
  assert.equal(w.stale_reason, 'probe_no_in_window_usage')
})

test('health-probe last_used inside the new window would keep sticky 100%', () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z')
  const reset = now + 4 * 3600_000
  const w = effectiveRateWindow(
    {
      utilization: 1,
      status: 'rejected',
      reset: new Date(reset).toISOString(),
    },
    {
      now,
      lastUsedAt: now - 30_000,
      source: 'official-cc-usage',
      durationMs: WINDOW_5H_MS,
    },
  )
  assert.equal(w.utilization, 1)
  assert.equal(w.stale, false)
})

test('toPercentUsed converts Extra 0-1 once and keeps 0-100', () => {
  assert.equal(toPercentUsed(null), null)
  assert.equal(toPercentUsed(0.85), 85)
  assert.equal(toPercentUsed(85), 85)
  assert.equal(toPercentUsed(0), 0)
  assert.equal(publicUsageWindow({ utilization: 0.85, status: 'active', reset: 't' }).utilization, 85)
  assert.equal(publicUsageWindow({}), null)
  assert.equal(
    usageWindowsEmpty({
      utilization_5h: null,
      utilization_7d: null,
      '5h': { utilization: null, status: null, reset: null },
      '7d': { utilization: null, status: null, reset: null },
    }),
    true,
  )
  assert.equal(usageWindowsEmpty({ '5h': { utilization: 0.1, status: 'active' }, '7d': {} }), false)
})

test('26 percent with a rejected flag is not a hard block', () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z')
  const reset = new Date(now + 3600_000).toISOString()
  assert.equal(
    headerHardBlocked({ headers: { '5h': { utilization: 26, status: 'rejected', reset } } }, '5h', now),
    false,
  )
  assert.equal(
    headerHardBlocked({ headers: { '5h': { utilization: 0.26, status: 'rejected', reset } } }, '5h', now),
    true,
  )
  assert.equal(headerHardBlocked({ headers: { '5h': { utilization: 1, status: 'rejected', reset } } }, '5h', now), true)
  const w = effectiveRateWindow(
    { utilization: 26, status: 'rejected', reset },
    { now, source: 'headers', durationMs: WINDOW_5H_MS },
  )
  assert.equal(w.utilization, 26)
  assert.equal(w.stale, false)
})

test('parseLimitResetFromMessage reads CLI reset text in its timezone', () => {
  const now = Date.parse('2026-09-23T12:37:10Z')
  const at = (text) => parseLimitResetFromMessage(text, now)
  assert.equal(at("You've hit your limit · resets 11am (America/New_York)"), Date.parse('2026-09-23T15:00:00Z'))
  assert.equal(at("You've hit your session limit · resets 3:30pm (UTC)"), Date.parse('2026-09-23T15:30:00Z'))
  // 8am ET already passed today → tomorrow.
  assert.equal(at("You've hit your limit · resets 8am (America/New_York)"), Date.parse('2026-09-24T12:00:00Z'))
  assert.equal(
    at("You've hit your weekly limit · resets Sep 25, 3pm (America/New_York)"),
    Date.parse('2026-09-25T19:00:00Z'),
  )
  assert.equal(at('provider error: api_error'), null)
})

test('parseLimitResetFromMessage follows DST in the named zone', () => {
  // 2026-11-01: US leaves DST. 11am ET the next day is UTC-5.
  const now = Date.parse('2026-11-01T20:00:00Z')
  assert.equal(parseLimitResetFromMessage('resets 11am (America/New_York)', now), Date.parse('2026-11-02T16:00:00Z'))
})

test('extraWindowSince uses reset minus duration, elapsed reset, or null', () => {
  const now = Date.parse('2026-09-26T12:00:00.000Z')
  assert.equal(extraWindowSince('2026-09-26T16:00:00.000Z', WINDOW_5H_MS, now), Date.parse('2026-09-26T11:00:00.000Z'))
  assert.equal(extraWindowSince('2026-09-26T10:00:00.000Z', WINDOW_5H_MS, now), Date.parse('2026-09-26T10:00:00.000Z'))
  assert.equal(extraWindowSince(null, WINDOW_5H_MS, now), null)
})

test('official /usage sample is detected without treating Extra as live', () => {
  const now = Date.parse('2026-09-26T12:00:00.000Z')
  const unified = {
    source: 'vm-oauth-usage',
    official: {
      '5h': { utilization: 0.22, status: 'allowed', reset: '2026-09-26T16:00:00.000Z' },
    },
  }
  assert.equal(hasOfficialUsageSample(unified), true)
  assert.equal(hasLiveExtraSample(unified, { now }), false)
})

test('isPlanLimitMessage matches CLI limit text but not the entitlement error', () => {
  assert.equal(isPlanLimitMessage("You've hit your limit · resets 11am"), true)
  assert.equal(isPlanLimitMessage("You've hit your weekly limit"), true)
  assert.equal(isPlanLimitMessage("You're out of extra usage · resets 3pm"), true)
  assert.equal(isPlanLimitMessage('Extra usage required for this model'), false)
  assert.equal(limitWindowFromMessage("You've hit your weekly limit"), '7d')
  assert.equal(limitWindowFromMessage("You've hit your limit"), '5h')
})

test('isAccountQuotaExhausted ignores 429s the pool synthesized itself', () => {
  const fableGate = { ok: false, status: 429, via: 'pool-failover' }
  assert.equal(isAccountQuotaExhausted(fableGate, 'Fable requires an available Max account'), false)
  const poolRateLimited = { ok: false, status: 429, via: 'pool-failover' }
  assert.equal(isAccountQuotaExhausted(poolRateLimited, 'rate limited'), false)
})

test('isAccountQuotaExhausted needs evidence: a bare provider 429 names no spent window', () => {
  assert.equal(isAccountQuotaExhausted({ ok: false, status: 429, via: 'go-worker-stream' }, ''), false)
  assert.equal(isAccountQuotaExhausted({ ok: false, status: 429 }, 'Error'), false)
  const bare = { ok: false, status: 429, via: 'go-worker-stream', headers: { 'request-id': 'req_1' } }
  assert.equal(isAccountQuotaExhausted({ ...bare, policy: { reason: 'rate_limited_request' } }, 'Error'), false)
  assert.equal(isAccountQuotaExhausted({ ...bare, policy: { reason: 'fable_rate_limited_unknown' } }, 'Error'), false)
  assert.equal(isAccountQuotaExhausted({ ...bare, policy: { reason: 'rate_limited_unknown' } }, 'Error'), false)
})

test('isAccountQuotaExhausted keeps provider 429s with evidence and plan-limit text', () => {
  const rejected = { 'anthropic-ratelimit-unified-5h-status': 'rejected' }
  assert.equal(
    isAccountQuotaExhausted({ ok: false, status: 429, via: 'go-worker-stream', headers: rejected }, ''),
    true,
  )
  const rejected7 = { 'Anthropic-Ratelimit-Unified-7d-Status': 'rate_limited' }
  assert.equal(isAccountQuotaExhausted({ ok: false, status: 429, headers: rejected7 }, ''), true)
  const allowed = { 'anthropic-ratelimit-unified-5h-status': 'allowed' }
  assert.equal(isAccountQuotaExhausted({ ok: false, status: 429, headers: allowed }, ''), false)
  const graded = { ok: false, status: 429, via: 'go-worker-stream', policy: { reason: 'account_quota_exhausted' } }
  assert.equal(isAccountQuotaExhausted(graded, "This request would exceed your account's rate limit."), true)
  // The classifier's grade wins over a stale header.
  assert.equal(
    isAccountQuotaExhausted({ ok: false, status: 429, headers: rejected, policy: { reason: 'rpm_limited' } }, ''),
    false,
  )
  const planText = "You've hit your limit · resets 3pm"
  assert.equal(isAccountQuotaExhausted({ ok: false, status: 400, via: 'pool-failover' }, planText), true)
  assert.equal(isAccountQuotaExhausted({ ok: true, status: 200 }, planText), false)
  assert.equal(isAccountQuotaExhausted({ ok: false, status: 503, via: 'go-worker' }, ''), false)
})

test('a rejected 5h header with no reset lifts after its hold', () => {
  // cf-9edf (2026-11-16): a bare 429 wrote 5h rejected with reset null and the
  // seat stayed parked for 15h until a manual 限额查询.
  const at = Date.parse('2026-11-16T15:12:05.879Z')
  const unified = {
    headers: {
      '5h': { utilization: 0, reset: null, status: 'rejected' },
      '7d': { utilization: 0.15, reset: '2026-11-21T12:00:00Z', status: 'allowed' },
      sampled_at: '2026-11-16T15:11:59.704Z',
      exhausted_at: '2026-11-16T15:12:05.879Z',
    },
  }
  assert.equal(noResetRejectUntilMs(unified, '5h'), at + NO_RESET_REJECT_HOLD_MS)
  assert.equal(headerHardBlocked(unified, '5h', at + 60_000), true)
  assert.equal(headerHardBlocked(unified, '5h', at + NO_RESET_REJECT_HOLD_MS), false)
  assert.equal(quotaGuardUsage(unified, at + 60_000)?.rejected, true)
  assert.notEqual(quotaGuardUsage(unified, at + NO_RESET_REJECT_HOLD_MS)?.rejected, true)

  const early = wipeElapsedHeaderWindows(unified, { now: at + 60_000 })
  assert.equal(early.changed, false)
  const late = wipeElapsedHeaderWindows(unified, { now: at + NO_RESET_REJECT_HOLD_MS + 1 })
  assert.equal(late.changed, true)
  assert.equal(late.headers['5h'].status, 'allowed')
  assert.equal(late.headers.exhausted_at, null)
  assert.equal(late.headers['7d'].status, 'allowed')
})

test('a rejected header with a future reset still holds past the no-reset hold', () => {
  const at = Date.parse('2026-11-16T15:12:05.879Z')
  const reset = new Date(at + 4 * 3600_000).toISOString()
  const unified = {
    headers: { '5h': { utilization: 1, reset, status: 'rejected' }, exhausted_at: new Date(at).toISOString() },
  }
  assert.equal(noResetRejectUntilMs(unified, '5h'), null)
  assert.equal(headerHardBlocked(unified, '5h', at + 2 * 3600_000), true)
  assert.equal(wipeElapsedHeaderWindows(unified, { now: at + 2 * 3600_000 }).changed, false)
})
