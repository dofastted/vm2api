import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseOAuthUsage,
  isCompleteOAuthUsage,
  parseFableProbe,
  isFablePlanDenied,
  isFableUnavailablePro,
  isOfficialUsageRateLimited,
  shouldHopOfficialUsage,
  shouldProbeFable,
  normUtilization,
  FABLE_PROBE_MODEL,
  tierFromFableAttempts,
  PASSIVE_HEADER_SOURCE,
  probeFromPassiveHeaders,
  probeVmUsage,
} from '../../src/lib/oauth/crs-usage-probe.mjs'

test('official weekly-only usage is complete without inventing a session window', () => {
  const data = {
    five_hour: null,
    seven_day: { utilization: 4, resets_at: '2026-11-05T12:00:00Z' },
    limits: [{ kind: 'weekly_all', percent: 4, resets_at: '2026-11-05T12:00:00Z' }],
  }
  const parsed = parseOAuthUsage(data)
  assert.equal(isCompleteOAuthUsage(data, parsed), true)
  assert.equal(parsed.five_hour, null)
  assert.equal(parsed.seven_day.utilization, 0.04)
  const { five_hour, ...omitted } = data
  assert.equal(isCompleteOAuthUsage(omitted), true)
  assert.equal(isCompleteOAuthUsage({ ...data, five_hour: { utilization: 12 } }), true)
  assert.equal(isCompleteOAuthUsage({ ...data, five_hour: {} }), false)
  assert.equal(isCompleteOAuthUsage({ ...data, seven_day: null }), false)
  assert.equal(isCompleteOAuthUsage({ five_hour: null, seven_day: null, limits: [] }), false)
  assert.equal(isCompleteOAuthUsage({}), false)
})

test('oauth usage parse: official percent scale 1 = 1%', () => {
  const p = parseOAuthUsage({
    five_hour: { utilization: 1, resets_at: '2026-08-18T20:00:00Z' },
    seven_day: { utilization: 34, resets_at: '2026-08-24T00:00:00Z' },
    seven_day_sonnet: { utilization: 8, resets_at: '2026-08-24T00:00:00Z' },
    extra_usage: { is_enabled: true, utilization: 1, status: 'allowed' },
  })
  assert.equal(p.five_hour.utilization, 0.01)
  assert.equal(p.five_hour.utilization_pct, 1)
  assert.equal(p.five_hour.status, 'allowed')
  assert.equal(p.seven_day.utilization, 0.34)
  assert.equal(p.seven_day_sonnet.utilization, 0.08)
  assert.equal(p.seven_day_opus, null)
  assert.equal(p.seven_day_oauth_apps, null)
  assert.equal(p.extra_usage.is_enabled, true)
})

test('oauth usage parse: 2.1.293 windows stay separate', () => {
  const p = parseOAuthUsage({
    five_hour: { utilization: 12, resets_at: '2026-10-07T20:00:00Z' },
    seven_day: { utilization: 34, resets_at: '2026-10-12T00:00:00Z' },
    seven_day_sonnet: { utilization: 8, resets_at: '2026-10-12T00:00:00Z' },
    seven_day_opus: { utilization: 2, resets_at: '2026-10-12T00:00:00Z' },
    seven_day_oauth_apps: { utilization: 5, resets_at: '2026-10-12T00:00:00Z' },
    extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 100, utilization: 5 },
  })
  assert.equal(p.seven_day_sonnet.utilization, 0.08)
  assert.equal(p.seven_day_opus.utilization, 0.02)
  assert.equal(p.seven_day_oauth_apps.utilization, 0.05)
  assert.equal(p.extra_usage.monthly_limit, 2000)
  assert.equal(p.extra_usage.used_credits, 100)
  assert.equal(p.extra_usage.utilization, 0.05)
})

test('oauth usage parse: Fable weekly_scoped from limits[]', () => {
  const p = parseOAuthUsage({
    five_hour: { utilization: 33, resets_at: '2026-08-18T20:00:00Z' },
    seven_day: { utilization: 88, resets_at: '2026-08-24T00:00:00Z' },
    limits: [
      { kind: 'session', percent: 33 },
      { kind: 'weekly_all', percent: 88 },
      {
        kind: 'weekly_scoped',
        percent: 54,
        resets_at: '2026-08-24T00:00:00Z',
        scope: { model: { display_name: 'Fable' } },
      },
    ],
  })
  assert.equal(p.seven_day_oi.utilization, 0.54)
  assert.equal(p.seven_day_oi.utilization_pct, 54)
  assert.equal(p.seven_day_oi.resets_at, '2026-08-24T00:00:00Z')
})

test('oauth usage parse: Fable model id in limits is Max evidence', () => {
  const p = parseOAuthUsage({
    five_hour: { utilization: 10, resets_at: '2026-08-18T20:00:00Z' },
    seven_day: { utilization: 20, resets_at: '2026-08-24T00:00:00Z' },
    limits: [
      {
        kind: 'weekly_scoped',
        percent: 3,
        resets_at: '2026-08-24T00:00:00Z',
        scope: { model: { id: 'claude-fable-5-1' } },
      },
    ],
  })
  assert.equal(p.usage_has_fable, true)
  assert.equal(p.seven_day_oi.utilization, 0.03)
})

test('oauth usage parse: limits without Fable is not Max', () => {
  const p = parseOAuthUsage({
    five_hour: { utilization: 10 },
    seven_day: { utilization: 20 },
    limits: [{ kind: 'weekly_all', percent: 20, scope: { model: { display_name: 'Sonnet' } } }],
  })
  assert.equal(p.usage_has_fable, false)
  assert.equal(p.seven_day_oi, null)
})

test('normUtilization header/legacy: 85 is 0.85, 0.85 stays 0.85', () => {
  assert.equal(normUtilization(85), 0.85)
  assert.equal(normUtilization(0.85), 0.85)
})

test('fable 429 is isolated weekly limit, not account ban', () => {
  const r = parseFableProbe({
    status: 429,
    body: { error: { type: 'rate_limit_error', message: 'fable weekly limit' } },
  })
  assert.equal(r.model, FABLE_PROBE_MODEL)
  assert.equal(r.limited, true)
  assert.equal(r.banned, false)
  assert.equal(r.plan_denied, false)
  assert.equal(r.ok, false)
  assert.equal(r.utilization, null)
})

test('fable attempts: 200 is Max, 403-only is Pro, 429 does not classify', () => {
  assert.equal(
    tierFromFableAttempts([
      { ok: false, plan_denied: true, status: 403, model: 'claude-fable-5-1' },
      { ok: true, status: 200, model: 'claude-fable-5' },
    ]).tier,
    'max',
  )
  assert.equal(
    tierFromFableAttempts([
      { ok: false, plan_denied: true, status: 403, model: 'claude-fable-5-1' },
      { ok: false, plan_denied: true, status: 403, model: 'claude-fable-5' },
    ]).tier,
    'pro',
  )
  assert.equal(tierFromFableAttempts([{ ok: false, limited: true, status: 429, model: FABLE_PROBE_MODEL }]).tier, null)
  assert.equal(tierFromFableAttempts([{ transport: true, status: 0 }]).tier, null)
  assert.equal(FABLE_PROBE_MODEL, 'claude-fable-5-1')
})

test('fable 403 permission is plan denied, not account ban', () => {
  const r = parseFableProbe({
    status: 403,
    body: { error: { type: 'permission_error', message: 'Your organization does not have access' } },
  })
  assert.equal(r.banned, false)
  assert.equal(r.plan_denied, true)
  assert.equal(r.limited, false)
  assert.equal(r.ok, false)
})

test('fable probe reads 7d_oi utilization from response headers', () => {
  const r = parseFableProbe({
    status: 200,
    body: { type: 'message', role: 'assistant' },
    headers: {
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.21',
      'anthropic-ratelimit-unified-7d_oi-reset': '2026-08-24T00:00:00Z',
      'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.utilization, 0.21)
  assert.equal(r.seven_day_oi.utilization, 0.21)
  assert.equal(r.reset_at, '2026-08-24T00:00:00Z')
})

test('Pro slots are rechecked after an hour so a mistaken tier can recover', () => {
  const recent = new Date().toISOString()
  const stale = new Date(Date.now() - 61 * 60_000).toISOString()
  assert.equal(
    shouldProbeFable({ storedTier: 'pro', fable: { plan_denied: true, status: 403, probed_at: recent } }),
    false,
  )
  assert.equal(
    shouldProbeFable({ storedTier: 'pro', fable: { plan_denied: true, status: 403, probed_at: stale } }),
    true,
  )
  assert.equal(shouldProbeFable({ storedTier: 'pro' }), true)
  assert.equal(shouldProbeFable({ fable: { ok: false, status: 429, error: 'Error' } }), true)
  assert.equal(
    shouldProbeFable({
      storedTier: 'pro',
      fable: { ok: false, status: 429, error: 'Error', probed_at: stale },
      quota: { utilization_7d_oi: 1, status_7d_oi: 'rejected' },
    }),
    true,
  )
  assert.equal(
    shouldProbeFable({ fable: { ok: true }, quota: { utilization_7d_oi: 0.21, reset_7d_oi: '2026-08-24T00:00:00Z' } }),
    false,
  )
  assert.equal(shouldProbeFable({ fable: {}, storedTier: 'max' }), true)
  assert.equal(shouldProbeFable({ storedTier: 'pro', quota: { usage_has_fable: true } }), false)
})

test('Fable 429 without a real 7d_oi window is not Pro evidence', () => {
  assert.equal(isFableUnavailablePro({ ok: false, status: 429, error: 'Error' }, {}), false)
  assert.equal(
    isFableUnavailablePro(
      { ok: false, status: 429, error: 'Error' },
      { utilization_7d_oi: 1, status_7d_oi: 'rejected' },
    ),
    false,
  )
  assert.equal(
    isFableUnavailablePro({ ok: false, status: 502 }, { utilization_7d_oi: 0.44, reset_7d_oi: '2026-08-24T00:00:00Z' }),
    false,
  )
})

test('isFablePlanDenied treats 403 permission as Pro, not revoke', () => {
  assert.equal(isFablePlanDenied({ status: 403, error: 'permission_error' }), true)
  assert.equal(isFablePlanDenied({ plan_denied: true }), true)
  assert.equal(isFablePlanDenied({ status: 401, error: 'authentication_error' }), false)
})

test('fable 401 is banned / rejected, not weekly limit', () => {
  const r = parseFableProbe({
    status: 401,
    body: { error: { type: 'authentication_error', message: 'OAuth token revoked' } },
  })
  assert.equal(r.banned, true)
  assert.equal(r.limited, false)
})

test('probeFromPassiveHeaders maps Messages headers without percent rescale', () => {
  const p = probeFromPassiveHeaders(
    {
      headers: {
        '5h': { utilization: 0.37, reset: '2026-08-25T06:00:00Z', status: 'allowed' },
        '7d': { utilization: 0.12, reset: '2026-08-27T00:00:00Z', status: 'allowed' },
      },
      '7d_oi': { utilization: 0.05, status: 'allowed' },
    },
    '2026-08-25T05:00:00.000Z',
  )
  assert.equal(p.ok, true)
  assert.equal(p.source, PASSIVE_HEADER_SOURCE)
  assert.equal(p.five_hour.utilization, 0.37)
  assert.equal(p.seven_day.utilization, 0.12)
  assert.equal(p.seven_day_oi.utilization, 0.05)
  assert.equal(probeFromPassiveHeaders({ headers: {} }), null)
})

test('usage hop is skipped while 429 backoff is live', () => {
  const now = Date.parse('2026-08-25T14:00:00.000Z')
  const live = { usage_rate_limited_until: '2026-08-25T14:15:00.000Z' }
  assert.equal(shouldHopOfficialUsage(live, { now }), false)
  assert.equal(shouldHopOfficialUsage(live, { now, hop: false }), false)
  assert.equal(shouldHopOfficialUsage(live, { now, force: true }), true)
  assert.equal(shouldHopOfficialUsage({}, { now, hop: false }), false)
  assert.equal(shouldHopOfficialUsage({}, { now }), true)
  assert.equal(shouldHopOfficialUsage({ usage_rate_limited_until: '2026-08-25T13:59:00.000Z' }, { now }), true)
})

test('official /usage 429 is rate-limited, not a dead grant', () => {
  assert.equal(
    isOfficialUsageRateLimited({
      ok: false,
      usage_status: 429,
      usage_error: 'Rate limited. Please try again later.',
    }),
    true,
  )
  assert.equal(
    isOfficialUsageRateLimited({
      ok: false,
      error: 'Rate limited. Please try again later.',
    }),
    true,
  )
  assert.equal(
    isOfficialUsageRateLimited({
      ok: false,
      usage_status: 401,
      usage_error: 'OAuth access token has been revoked.',
    }),
    false,
  )
})

test('KIN_CRS_MOCK probe returns 5h/7d/fable without network', async () => {
  const prev = process.env.KIN_CRS_MOCK
  process.env.KIN_CRS_MOCK = '1'
  try {
    const r = await probeVmUsage({ exec: { homeDir: '/tmp', vmId: 'vm-01' } })
    assert.equal(r.ok, true)
    assert.equal(r.source, 'official-cc-usage')
    assert.ok(r.five_hour.utilization > 0)
    assert.ok(r.seven_day.utilization > 0)
    assert.equal(r.fable.ok, true)
    assert.equal(r.fable.limited, false)
    assert.equal(r.seven_day_oi.utilization, 0.21)
    assert.equal(r.fable.utilization, 0.21)
  } finally {
    if (prev == null) delete process.env.KIN_CRS_MOCK
    else process.env.KIN_CRS_MOCK = prev
  }
})
