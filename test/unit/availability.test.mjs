import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateAccount,
  availabilityFromQuotaRefresh,
  isUsageRefreshSuccess,
  isQuotaLimitedAccount,
  isQuotaWindowReason,
  isLeftoverQuotaScheduleOff,
  resolveScheduleState,
} from '../../src/lib/pool/availability.mjs'

const usageOk = { ok: true, source: 'vm-oauth-usage', at: '2026-08-24T00:00:00.000Z' }
const officialOk = { ok: true, source: 'official-cc-usage', at: '2026-08-24T00:00:00.000Z' }

test('usage refresh sources: only oauth usage APIs count', () => {
  assert.equal(isUsageRefreshSuccess({ ok: true, source: 'vm-oauth-usage' }), true)
  assert.equal(isUsageRefreshSuccess({ ok: true, source: 'official-cc-usage' }), true)
  assert.equal(isUsageRefreshSuccess({ ok: true, source: 'test-chat' }), false)
  assert.equal(isUsageRefreshSuccess({ ok: false, source: 'vm-oauth-usage' }), false)
  assert.equal(isUsageRefreshSuccess({ ok: true }, 'official-cc-usage'), true)
  assert.equal(isUsageRefreshSuccess({ ok: true, source: 'messages-headers' }), true)
})

test('isQuotaWindowReason matches Extra 5h/7d rejects', () => {
  assert.equal(isQuotaWindowReason('quota_5h_header'), true)
  assert.equal(isQuotaWindowReason('quota_5h_safety'), true)
  assert.equal(isQuotaWindowReason('quota_7d_cli'), true)
  assert.equal(isQuotaWindowReason('quota_refresh_failed'), false)
  assert.equal(isQuotaWindowReason('disabled'), false)
})

test('no credential is none', () => {
  const av = evaluateAccount({ vm: {} })
  assert.equal(av.key, 'none')
  assert.equal(av.accept, false)
  assert.equal(av.usable, false)
})

test('refresh present but no usage probe is still 可用', () => {
  const av = evaluateAccount({
    hasToken: false,
    hasRefresh: true,
    schedulable: true,
    quota: { utilization_5h: 0, status_5h: 'active' },
  })
  assert.equal(av.key, 'ok')
  assert.equal(av.text, '可用')
  assert.equal(av.accept, true)
})

test('official /usage 429 does not paint 冷却中', () => {
  const av = evaluateAccount({
    hasRefresh: true,
    schedulable: true,
    lastProbe: {
      ok: true,
      source: 'official-cc-usage',
      rate_limited: true,
    },
    quota: { utilization_5h: 0.37, status_5h: 'allowed', utilization_7d: 0.48, status_7d: 'allowed' },
  })
  assert.equal(av.key, 'ok')
  assert.notEqual(av.key, 'cool')
  assert.equal(av.accept, true)
})

test('official /usage 429 does not paint 无效凭证', () => {
  const av = evaluateAccount({
    hasRefresh: true,
    schedulable: true,
    lastProbe: {
      ok: false,
      source: 'official-cc-usage',
      error: 'Rate limited. Please try again later.',
      rate_limited: true,
    },
    quota: { utilization_5h: 0.37, status_5h: 'allowed', utilization_7d: 0.48, status_7d: 'allowed' },
  })
  assert.equal(av.key, 'ok')
  assert.equal(av.text, '可用')
  assert.equal(av.accept, true)
})

test('oauth_revoked cooldown displays revoke not 鉴权冷却', () => {
  const av = evaluateAccount({
    vm: {
      claude: { has_access: true, has_refresh: true, refresh_error: 'oauth_revoked' },
      schedule_disabled_reason: 'oauth_revoked',
    },
    hasRefresh: true,
    schedulable: false,
    scheduleDisabledReason: 'oauth_revoked',
    refreshError: 'oauth_revoked',
    lastProbe: officialOk,
    cooldownUntil: Number.MAX_SAFE_INTEGER,
    cooldownReason: 'oauth_revoked',
    quota: { utilization_5h: 0.2, status_5h: 'allowed' },
  })
  assert.equal(av.key, 'bad')
  assert.equal(av.text, 'revoke')
  assert.equal(av.reason, 'oauth_revoked')
  assert.equal(av.usable, false)
  assert.equal(av.accept, false)
})

test('leftover runtime revoke after live disk grant is 可用', () => {
  const av = evaluateAccount({
    vm: {
      claude: { has_access: true, has_refresh: true, refresh_error: null, refreshed_at: '2026-08-27T08:24:14.226Z' },
      schedule_disabled_reason: null,
      schedulable: true,
    },
    hasToken: true,
    hasRefresh: true,
    schedulable: true,
    scheduleDisabledReason: null,
    refreshError: null,
    lastProbe: officialOk,
    cooldownUntil: Number.MAX_SAFE_INTEGER,
    cooldownReason: 'oauth_revoked',
    quota: { utilization_5h: 0.2, status_5h: 'allowed' },
  })
  assert.equal(av.key, 'ok')
  assert.equal(av.text, '可用')
  assert.equal(av.reason, null)
  assert.equal(av.accept, true)
})

test('authentication_failed_after_refresh is 鉴权冷却 not 无效凭证', () => {
  const av = evaluateAccount({
    hasRefresh: true,
    schedulable: true,
    lastProbe: officialOk,
    workerLastError: 'authentication_failed_after_refresh',
    quota: { utilization_5h: 0.2, status_5h: 'allowed' },
    cooldownUntil: Date.now() + 60_000,
    cooldownReason: 'authentication_failed_after_refresh',
  })
  assert.equal(av.key, 'cool')
  assert.equal(av.text, '鉴权冷却')
  assert.equal(av.reason, 'auth_cooldown')
  assert.equal(av.usable, true)
  assert.equal(av.accept, false)
  assert.notEqual(av.text, '无效凭证')
})

test('worker TTL cannot paint green without usage refresh', () => {
  const av = evaluateAccount({
    hasToken: true,
    hasRefresh: true,
    schedulable: true,
    lastProbe: { ok: false, source: 'official-cc-usage', error: 'invalid_grant' },
    quota: { utilization_5h: 0.24, status_5h: 'allowed' },
  })
  assert.equal(av.key, 'bad')
  assert.equal(av.text, '无效凭证')
  assert.equal(av.reason, 'credential_refresh_failed')
})

test('credential refresh failure is 无效凭证 even if usage snapshot exists', () => {
  const av = evaluateAccount({
    hasRefresh: true,
    schedulable: true,
    lastProbe: officialOk,
    workerLastError: 'OAuth refresh failed (invalid_grant): Refresh token not found',
    quota: { utilization_5h: 0.24, status_5h: 'allowed' },
  })
  assert.equal(av.text, '无效凭证')
  assert.equal(av.reason, 'credential_refresh_failed')
})

test('expired access with worker_output_invalid is 无效凭证', () => {
  const now = Date.now()
  const av = evaluateAccount({
    vm: {
      has_token: true,
      has_refresh: true,
      expires_at: Math.floor((now - 6 * 3600_000) / 1000),
      refresh_error: 'worker_output_invalid',
    },
    hasToken: true,
    hasRefresh: true,
    schedulable: true,
    expiresAt: now - 6 * 3600_000,
    workerCredential: {
      has_access: true,
      has_refresh: true,
      needs_refresh: true,
      expires_at: now - 6 * 3600_000,
    },
    quota: { utilization_5h: 0.1, status_5h: 'allowed' },
    now,
  })
  assert.equal(av.key, 'bad')
  assert.equal(av.text, '无效凭证')
  assert.equal(av.reason, 'credential_refresh_failed')
  assert.equal(av.accept, false)
})

test('live access is kept despite a transient refresh error', () => {
  const now = Date.now()
  const av = evaluateAccount({
    vm: {
      has_token: true,
      has_refresh: true,
      expires_at: Math.floor((now + 3600_000) / 1000),
      refresh_error: 'worker_output_invalid',
    },
    hasToken: true,
    hasRefresh: true,
    schedulable: true,
    expiresAt: now + 3600_000,
    workerCredential: {
      has_access: true,
      has_refresh: true,
      needs_refresh: false,
      expires_at: now + 3600_000,
    },
    quota: { utilization_5h: 0.1, status_5h: 'allowed' },
    now,
  })
  assert.notEqual(av.key, 'bad')
  assert.equal(av.accept, true)
})

test('leftover invalid_grant after a live refresh does not block the pool', () => {
  const now = Date.now()
  const av = evaluateAccount({
    vm: {
      has_token: true,
      has_refresh: true,
      expires_at: Math.floor((now + 8 * 3600_000) / 1000),
      refreshed_at: new Date(now - 60_000).toISOString(),
    },
    hasToken: true,
    hasRefresh: true,
    schedulable: true,
    lastProbe: officialOk,
    workerLastError: 'OAuth refresh failed (invalid_grant): Refresh token not found or invalid',
    expiresAt: now + 8 * 3600_000,
    refreshedAt: new Date(now - 60_000).toISOString(),
    workerCredential: {
      has_access: true,
      has_refresh: true,
      needs_refresh: false,
      expires_at: now + 8 * 3600_000,
    },
    quota: { utilization_5h: 0.24, status_5h: 'allowed' },
    now,
  })
  assert.equal(av.key, 'ok')
  assert.equal(av.text, '可用')
  assert.equal(av.accept, true)
  assert.equal(av.in_pool, true)
})

test('a scheduled slot with a live access token is not pinned by leftover oauth_revoked', () => {
  const now = Date.now()
  const av = evaluateAccount({
    vm: {
      has_token: true,
      has_refresh: true,
      expires_at: Math.floor((now + 8 * 3600_000) / 1000),
      refreshed_at: new Date(now - 60_000).toISOString(),
      refresh_error: 'oauth_revoked',
      schedulable: true,
      schedule_disabled_reason: null,
    },
    hasToken: true,
    hasRefresh: true,
    schedulable: true,
    refreshError: 'oauth_revoked',
    expiresAt: now + 8 * 3600_000,
    refreshedAt: new Date(now - 60_000).toISOString(),
    workerCredential: {
      has_access: true,
      has_refresh: true,
      needs_refresh: false,
      expires_at: now + 8 * 3600_000,
    },
    quota: { utilization_5h: 0.1, status_5h: 'allowed' },
    now,
  })
  assert.equal(av.key, 'ok')
  assert.equal(av.text, '可用')
  assert.equal(av.accept, true)
})

test('a parked oauth_revoked schedule stays invalid even when the old expiry has not elapsed', () => {
  const now = Date.now()
  const av = evaluateAccount({
    vm: {
      has_token: true,
      expires_at: Math.floor((now + 8 * 3600_000) / 1000),
      refresh_error: 'oauth_revoked',
      schedule_disabled_reason: 'oauth_revoked',
    },
    hasToken: true,
    hasRefresh: true,
    schedulable: false,
    scheduleDisabledReason: 'oauth_revoked',
    refreshError: 'oauth_revoked',
    expiresAt: now + 8 * 3600_000,
    quota: { utilization_5h: 0.1, status_5h: 'allowed' },
    now,
  })
  assert.equal(av.key, 'bad')
  assert.equal(av.usable, false)
})

test('vm-05 style official-cc-usage in pool is available', () => {
  const av = evaluateAccount({
    hasToken: false,
    hasRefresh: true,
    schedulable: true,
    lastProbe: officialOk,
    quota: { utilization_5h: 0.02, status_5h: 'allowed', utilization_7d: 0.14, status_7d: 'allowed' },
  })
  assert.equal(av.key, 'ok')
  assert.equal(av.text, '可用')
  assert.equal(av.accept, true)
  assert.equal(av.in_pool, true)
})

test('调度关 plus fatal refresh is 无效凭证', () => {
  const av = evaluateAccount({
    hasRefresh: true,
    schedulable: false,
    scheduleDisabledReason: 'disabled',
    refreshError: 'invalid_grant',
    lastProbe: usageOk,
    quota: { utilization_5h: 0, status_5h: 'allowed' },
  })
  assert.equal(av.key, 'bad')
  assert.equal(av.text, '无效凭证')
  assert.equal(av.reason, 'credential_refresh_failed')
  assert.equal(av.accept, false)
  assert.equal(av.usable, false)
})

test('leftover quota-off is restricted, not 调度关', () => {
  const reset = new Date(Date.now() + 3600_000).toISOString()
  const av = evaluateAccount({
    vm: { schedulable: false, schedule_disabled_reason: 'quota_5h_header' },
    hasRefresh: true,
    schedulable: false,
    scheduleDisabledReason: 'quota_5h_header',
    lastProbe: usageOk,
    quota: { utilization_5h: 1, status_5h: 'rejected', reset_5h: reset },
  })
  assert.equal(av.key, 'quota')
  assert.equal(av.in_pool, true)
  assert.equal(av.accept, false)
  assert.equal(isLeftoverQuotaScheduleOff({ schedulable: false, schedule_disabled_reason: 'quota_5h_header' }), true)
  const triad = resolveScheduleState({
    schedulable: true,
    availability: av,
    restrictionUntil: av.until,
    restrictionReason: av.reason,
  })
  assert.equal(triad.schedule_state, 'restricted')
  assert.equal(triad.restriction_reason, 'quota_5h_header')
})

test('schedule_manual leftover quota-off stays 调度关', () => {
  const av = evaluateAccount({
    vm: { schedulable: false, schedule_manual: true, schedule_disabled_reason: 'quota_5h_header' },
    hasRefresh: true,
    schedulable: false,
    scheduleDisabledReason: 'quota_5h_header',
    lastProbe: usageOk,
    quota: { utilization_5h: 1, status_5h: 'rejected' },
  })
  assert.equal(av.key, 'off')
  assert.equal(av.text, '调度关')
})

test('disabled slot is 调度关 not 不可用', () => {
  const av = evaluateAccount({
    hasRefresh: true,
    schedulable: false,
    scheduleDisabledReason: 'disabled',
    lastProbe: usageOk,
    quota: { utilization_5h: 0, status_5h: 'allowed' },
  })
  assert.equal(av.key, 'off')
  assert.equal(av.text, '调度关')
  assert.equal(av.accept, false)
  assert.equal(av.usable, false)
  assert.equal(av.in_pool, false)
})

test('proxy_required without fatal grant is 调度关', () => {
  const av = evaluateAccount({
    hasRefresh: true,
    schedulable: false,
    scheduleDisabledReason: 'proxy_required',
    lastProbe: { ok: false, source: 'vm-oauth-usage' },
  })
  assert.equal(av.key, 'off')
  assert.equal(av.text, '调度关')
})

test('test-chat probe still uses live refresh as 可用', () => {
  const av = evaluateAccount({
    hasRefresh: true,
    schedulable: true,
    lastProbe: { ok: true, source: 'test-chat' },
    quota: { utilization_5h: 0.56, status_5h: 'allowed' },
  })
  assert.equal(av.key, 'ok')
  assert.equal(av.accept, true)
})

test('test-chat 401 revoked does not paint a live grant as revoke', () => {
  const av = evaluateAccount({
    hasToken: true,
    hasRefresh: true,
    schedulable: true,
    lastProbe: {
      ok: false,
      source: 'test-chat',
      error: 'OAuth access token has been revoked. · upstream_error · upstream_auth_error',
      at: '2026-08-26T08:58:03.519Z',
    },
    refreshedAt: '2026-08-26T07:00:00.000Z',
    workerCredential: {
      has_access: true,
      has_refresh: true,
      needs_refresh: false,
      expires_at: Date.now() + 3600_000,
    },
    quota: { utilization_5h: 0.2, status_5h: 'allowed' },
  })
  assert.equal(av.key, 'ok')
  assert.equal(av.text, '可用')
  assert.notEqual(av.reason, 'oauth_revoked')
})

test('seed 0%/active row with refresh is 可用', () => {
  const av = evaluateAccount({
    hasRefresh: true,
    schedulable: true,
    account: { unified: { '5h': { utilization: 0, status: 'active' }, source: '-' } },
  })
  assert.equal(av.key, 'ok')
  assert.equal(av.accept, true)
})

test('leftover rejected status is ignored when utilization is below 100%', () => {
  const av = evaluateAccount({
    hasRefresh: true,
    schedulable: true,
    lastProbe: officialOk,
    quota: { utilization_5h: 0.12, status_5h: 'rejected', utilization_7d: 0.2, status_7d: 'allowed' },
  })
  assert.equal(av.key, 'ok')
  assert.equal(av.text, '可用')
  assert.equal(av.accept, true)
})

test('5h rejected after reset elapsed is available without a new probe', () => {
  const av = evaluateAccount({
    hasRefresh: true,
    schedulable: true,
    lastProbe: officialOk,
    account: { last_used_at: Date.now() - 6 * 3600_000 },
    quota: {
      utilization_5h: 1,
      status_5h: 'rejected',
      reset_5h: new Date(Date.now() - 60_000).toISOString(),
    },
  })
  assert.equal(av.key, 'ok')
  assert.equal(av.accept, true)
})

test('probe 100% without reset or last_used stays 限制 and does not accept', () => {
  const av = evaluateAccount({
    hasRefresh: true,
    schedulable: true,
    lastProbe: officialOk,
    quota: {
      utilization_5h: 1,
      status_5h: 'rejected',
    },
  })
  assert.equal(av.key, 'quota')
  assert.equal(av.text, '5h 限制')
  assert.equal(av.accept, false)
})

test('5h rejected in pool is 5h 限制 and does not accept', () => {
  const av = evaluateAccount({
    hasRefresh: true,
    schedulable: true,
    lastProbe: officialOk,
    account: { last_used_at: Date.now() },
    quota: {
      utilization_5h: 1,
      status_5h: 'rejected',
      reset_5h: new Date(Date.now() + 3600_000).toISOString(),
    },
  })
  assert.equal(av.key, 'quota')
  assert.equal(av.text, '5h 限制')
  assert.equal(av.accept, false)
  assert.equal(av.usable, true)
})

test('vm-05 style allowed_warning over Pro 80% is 5h 限制 not 不可用', () => {
  const av = evaluateAccount({
    hasRefresh: true,
    schedulable: true,
    lastProbe: officialOk,
    quota: { utilization_5h: 0.9, status_5h: 'allowed_warning', utilization_7d: 0.2, status_7d: 'allowed' },
    policy: { limit_5h: 0.8, limit_7d: 0.8 },
  })
  assert.equal(av.key, 'quota')
  assert.equal(av.text, '5h 限制')
  assert.equal(av.accept, false)
  assert.equal(av.usable, true)
})

test('isQuotaLimitedAccount is true for an in-window 5h 限制', () => {
  const reset = new Date(Date.now() + 3600_000).toISOString()
  assert.equal(
    isQuotaLimitedAccount({
      last_probe: officialOk,
      unified: {
        source: 'official-cc-usage',
        last_probe: officialOk,
        official: { '5h': { utilization: 1, status: 'rejected', reset } },
        headers: {
          '5h': { utilization: 1, status: 'rejected', reset },
          '7d': { utilization: 0.1, status: 'allowed' },
        },
      },
    }),
    true,
  )
  assert.equal(
    isQuotaLimitedAccount({
      last_probe: officialOk,
      unified: {
        source: 'official-cc-usage',
        last_probe: officialOk,
        official: { '5h': { utilization: 0.9, status: 'allowed' } },
        headers: {
          '5h': { utilization: 0.1, status: 'allowed' },
          '7d': { utilization: 0.1, status: 'allowed' },
        },
      },
    }),
    false,
  )
})

test('official 0.90 plus header 0.40 is available; header 0.90 is 5h 限制', () => {
  const open = evaluateAccount({
    hasRefresh: true,
    schedulable: true,
    lastProbe: officialOk,
    account: {
      unified: {
        official: { '5h': { utilization: 0.9, status: 'allowed' } },
        headers: { '5h': { utilization: 0.4, status: 'allowed' } },
      },
    },
    policy: { limit_5h: 0.85, limit_7d: 0.8 },
  })
  assert.equal(open.accept, true)
  const shut = evaluateAccount({
    hasRefresh: true,
    schedulable: true,
    lastProbe: officialOk,
    account: {
      unified: {
        official: { '5h': { utilization: 0.4, status: 'allowed' } },
        headers: { '5h': { utilization: 0.9, status: 'allowed' } },
      },
    },
    policy: { limit_5h: 0.85, limit_7d: 0.8 },
  })
  assert.equal(shut.key, 'quota')
  assert.equal(shut.reason, 'quota_5h_safety')
  assert.equal(shut.accept, false)
})

test('availabilityFromQuotaRefresh still aliases evaluateAccount', () => {
  const av = availabilityFromQuotaRefresh({
    hasRefresh: true,
    schedulable: true,
    lastProbe: usageOk,
    quota: { utilization_5h: 0.2, status_5h: 'allowed' },
  })
  assert.equal(av.key, 'ok')
})

test('rest stays restricted even with a stale cooldown left on the slot', () => {
  const now = Date.parse('2026-09-17T12:00:00.000Z')
  const until = Date.parse('2026-09-17T20:00:00.000Z')
  const triad = resolveScheduleState({
    schedulable: true,
    availability: { key: 'rest', reason: 'rest_period', until },
    restrictionUntil: now - 60_000,
    restrictionReason: 'rate_limited',
    now,
  })
  assert.equal(triad.schedule_state, 'restricted')
  assert.equal(triad.restriction_reason, 'rest_period')
  assert.equal(triad.restriction_until, until)
  assert.equal(triad.restriction_text, '休息时段')
})
