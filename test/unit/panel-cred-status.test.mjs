import test from 'node:test'
import assert from 'node:assert/strict'
import { credStatusFromQuota, inferClaudeTier, normalizePanelExpiresAt } from '../../src/lib/admin/panel-api.mjs'

const usageOk = { ok: true, source: 'vm-oauth-usage', at: '2026-08-24T00:00:00.000Z' }
const officialOk = { ok: true, source: 'official-cc-usage', at: '2026-08-24T00:00:00.000Z' }
const extrasLive = {
  has_refresh: true,
  schedulable: true,
  last_probe: usageOk,
  worker_credential: { has_access: true, has_refresh: true, needs_refresh: false },
}

test('panel expires_at is always milliseconds', () => {
  const sec = 1787413581
  assert.equal(normalizePanelExpiresAt(sec), sec * 1000)
  assert.equal(normalizePanelExpiresAt(sec, sec * 1000), sec * 1000)
  assert.equal(normalizePanelExpiresAt(null, sec * 1000), sec * 1000)
  assert.equal(normalizePanelExpiresAt(null, null), null)
})

test('5h 87% over default 85% is 5h 限制 not 不可用', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0.87,
      utilization_7d: 0.18,
      status_5h: 'allowed',
      status_7d: 'allowed',
      last_probe: usageOk,
    },
    Date.now() + 3600_000,
    extrasLive,
  )
  assert.equal(st.key, 'quota')
  assert.equal(st.text, '5h 限制')
  assert.equal(st.usable, true)
  assert.equal(st.accept, false)
})

test('fable banned without usage refresh is not 无效凭证', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0.1,
      status_5h: 'allowed',
      fable: { banned: true },
    },
    null,
    { has_refresh: true, schedulable: true },
  )
  assert.equal(st.text, '可用')
  assert.notEqual(st.text, '无效凭证')
})

test('fable banned without revoke text does not kill a live slot ticket', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0,
      status_5h: 'allowed',
      last_probe: usageOk,
      fable: { banned: true, status: 401, error: 'Error' },
    },
    Date.now() + 8 * 3600_000,
    extrasLive,
  )
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('leftover worker invalid_grant after live refresh is 可用', () => {
  const now = Date.now()
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0,
      status_5h: 'allowed',
      last_probe: officialOk,
    },
    now + 8 * 3600_000,
    {
      has_token: true,
      has_refresh: true,
      schedulable: true,
      refreshed_at: new Date(now - 60_000).toISOString(),
      last_probe: officialOk,
      worker_credential: {
        has_access: true,
        has_refresh: true,
        needs_refresh: false,
        expires_at: now + 8 * 3600_000,
        last_error: 'OAuth refresh failed (invalid_grant): Refresh token not found or invalid',
      },
    },
  )
  assert.equal(st.text, '可用')
  assert.equal(st.usable, true)
  assert.equal(st.accept, true)
})

test('leftover runtime revoke after live disk grant is 可用', () => {
  const now = Date.now()
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0,
      status_5h: 'allowed',
      last_probe: officialOk,
    },
    now + 8 * 3600_000,
    {
      vm: { claude: { has_access: true, has_refresh: true, refresh_error: null }, schedule_disabled_reason: null },
      has_token: true,
      has_refresh: true,
      schedulable: true,
      schedule_disabled_reason: null,
      refresh_error: null,
      last_probe: officialOk,
      cooldown_until: Number.MAX_SAFE_INTEGER,
      cooldown_reason: 'oauth_revoked',
      worker_credential: { has_access: true, has_refresh: true, needs_refresh: false, expires_at: now + 8 * 3600_000 },
    },
  )
  assert.equal(st.text, '可用')
  assert.equal(st.usable, true)
  assert.equal(st.accept, true)
})

test('messages 401 revoked displays revoke', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0,
      status_5h: 'allowed',
      last_probe: { ok: false, at: new Date().toISOString(), error: 'OAuth access token has been revoked.' },
    },
    Date.now() + 8 * 3600_000,
    {
      has_token: true,
      has_refresh: true,
      schedulable: true,
      last_probe: { ok: false, at: new Date().toISOString(), error: 'OAuth access token has been revoked.' },
      worker_credential: {
        has_access: true,
        has_refresh: true,
        needs_refresh: false,
        expires_at: Date.now() + 8 * 3600_000,
      },
    },
  )
  assert.equal(st.text, 'revoke')
  assert.equal(st.reason, 'oauth_revoked')
  assert.equal(st.usable, false)
  assert.equal(st.accept, false)
})

test('stale last_probe revoke after a newer refresh is not 无效凭证', () => {
  const now = Date.now()
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0,
      status_5h: 'allowed',
      last_probe: {
        ok: false,
        source: 'vm-oauth-usage',
        at: new Date(now - 20 * 60_000).toISOString(),
        error: 'OAuth access token has been revoked.',
      },
      fable: {
        banned: true,
        status: 401,
        error: 'OAuth access token has been revoked.',
        probed_at: new Date(now - 20 * 60_000).toISOString(),
      },
    },
    now + 8 * 3600_000,
    {
      has_token: true,
      has_refresh: true,
      schedulable: true,
      refreshed_at: new Date(now - 5 * 60_000).toISOString(),
      last_probe: {
        ok: false,
        source: 'vm-oauth-usage',
        at: new Date(now - 20 * 60_000).toISOString(),
        error: 'OAuth access token has been revoked.',
      },
      worker_credential: { has_access: true, has_refresh: true, needs_refresh: false, expires_at: now + 8 * 3600_000 },
    },
  )
  assert.notEqual(st.text, '无效凭证')
  assert.equal(st.usable, true)
})

test('5h rejected is limited, not unavailable', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 1,
      status_5h: 'rejected',
      reset_5h: new Date(Date.now() + 3600_000).toISOString(),
      last_probe: officialOk,
      last_used_at: Date.now(),
    },
    null,
    { ...extrasLive, last_probe: officialOk },
  )
  assert.equal(st.key, 'quota')
  assert.equal(st.text, '5h 限制')
})

test('weekly split regular half full is 普通限制', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0.1,
      utilization_7d: 0.5,
      status_5h: 'allowed',
      status_7d: 'allowed',
      last_probe: usageOk,
      weekly_split: { enabled: true, mode: 'fable_only' },
    },
    null,
    extrasLive,
  )
  assert.equal(st.key, 'quota')
  assert.equal(st.text, '普通限制')
})

test('weekly split fable half full does not mark the account as 限制', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0.1,
      utilization_7d: 0.2,
      status_5h: 'allowed',
      status_7d: 'allowed',
      last_probe: usageOk,
      weekly_split: { enabled: true, mode: 'regular_only' },
    },
    null,
    extrasLive,
  )
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('fable 7d_oi rejected is still 可用 for Pro / Fable-unavailable', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0,
      utilization_7d: 0,
      status_5h: 'allowed',
      status_7d: 'allowed',
      utilization_7d_oi: 1,
      status_7d_oi: 'rejected',
      last_probe: usageOk,
      fable: { ok: false, limited: true, banned: false, status: 429 },
    },
    null,
    extrasLive,
  )
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('fable 403 permission is Pro, not 被吊销', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0.1,
      status_5h: 'allowed',
      last_probe: usageOk,
      fable: { banned: true, plan_denied: true, status: 403, error: 'permission_error' },
    },
    null,
    extrasLive,
  )
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('fable cooldown does not mark the account as 限制', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0.1,
      status_5h: 'allowed',
      last_probe: usageOk,
    },
    Date.now() + 3600_000,
    { ...extrasLive, fable_cooldown_until: Date.now() + 60_000 },
  )
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('weekly split off does not use mode', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0.1,
      status_5h: 'allowed',
      last_probe: usageOk,
      weekly_split: { enabled: false, mode: 'fable_only' },
    },
    null,
    extrasLive,
  )
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('stale worker expiry is ignored when vm.json TTL is newer and refresh exists', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0,
      status_5h: 'allowed',
      last_probe: usageOk,
    },
    Date.now() + 8 * 3600_000,
    {
      ...extrasLive,
      worker_credential: {
        has_access: true,
        has_refresh: true,
        needs_refresh: true,
        expires_at: Date.now() - 3600_000,
      },
    },
  )
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('expired TTL with refresh remains available for worker refresh', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0.1,
      status_5h: 'allowed',
      last_probe: usageOk,
    },
    Date.now() - 60_000,
    { ...extrasLive, worker_credential: { has_access: false, has_refresh: true } },
  )
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('expired TTL without usage refresh is not 无效凭证 when the grant is not dead', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0.1,
      status_5h: 'allowed',
    },
    Date.now() - 60_000,
    { worker_credential: { has_access: true, needs_refresh: false } },
  )
  assert.notEqual(st.text, '无效凭证')
})

test('oauth_ disabled reason is 无效凭证', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0.1,
      status_5h: 'allowed',
    },
    Date.now() + 3600_000,
    { schedulable: false, schedule_disabled_reason: 'oauth_no_refresh' },
  )
  assert.equal(st.key, 'bad')
  assert.equal(st.text, '无效凭证')
})

test('operator schedule switch is 调度关 not 不可用', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0.1,
      status_5h: 'allowed',
      last_probe: usageOk,
    },
    Date.now() + 3600_000,
    { ...extrasLive, schedulable: false, schedule_disabled_reason: 'disabled' },
  )
  assert.equal(st.key, 'off')
  assert.equal(st.text, '调度关')
  assert.equal(st.accept, false)
})

test('leftover oauth_cleared out of pool is unavailable until usage refresh and in-pool', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0.1,
      status_5h: 'allowed',
      last_probe: usageOk,
    },
    Date.now() + 3600_000,
    {
      ...extrasLive,
      schedulable: false,
      schedule_disabled_reason: 'oauth_cleared',
    },
  )
  assert.equal(st.key, 'bad')
  assert.equal(st.text, '无效凭证')
})

test('leftover oauth_no_refresh out of pool is unavailable', () => {
  const st = credStatusFromQuota(
    true,
    {
      utilization_5h: 0.1,
      status_5h: 'allowed',
      last_probe: usageOk,
    },
    Date.now() + 3600_000,
    {
      ...extrasLive,
      schedulable: false,
      schedule_disabled_reason: 'oauth_no_refresh',
    },
  )
  assert.equal(st.key, 'bad')
  assert.equal(st.text, '无效凭证')
})

test('Claude tier: no token is none, plan denied is Pro, Fable window is Max', () => {
  assert.equal(inferClaudeTier({}).key, 'none')
  assert.equal(inferClaudeTier({ has_token: true }, { fable: { plan_denied: true, status: 403 } }).key, 'pro')
  assert.equal(inferClaudeTier({ has_token: true, utilization_7d_oi: 0.21 }).key, 'max')
  assert.equal(inferClaudeTier({ has_token: true, fable: { ok: true } }).key, 'max')
  assert.equal(
    inferClaudeTier({ has_token: true }, { fable: { plan_denied: true, status: 401, error: 'plan_denied' } }).key,
    'pro',
  )
  assert.equal(inferClaudeTier({ has_token: true }, { fable: { ok: false, status: 429, error: 'Error' } }).key, 'pro')
  assert.equal(
    inferClaudeTier(
      { has_token: true, utilization_7d_oi: 1 },
      {
        fable: { ok: false, status: 429, error: 'Error' },
        utilization_7d_oi: 1,
        status_7d_oi: 'rejected',
      },
    ).key,
    'pro',
  )
  assert.equal(
    inferClaudeTier(
      { has_token: true, utilization_7d_oi: 0.44, reset_7d_oi: '2026-08-24T00:00:00Z' },
      {
        fable: { ok: false, status: 502 },
        utilization_7d_oi: 0.44,
        reset_7d_oi: '2026-08-24T00:00:00Z',
      },
    ).key,
    'max',
  )
  assert.equal(inferClaudeTier({ has_token: true, account_tier: 'pro' }).key, 'pro')
  assert.equal(inferClaudeTier({ has_token: true, account_tier: 'max' }).key, 'max')
  assert.equal(
    inferClaudeTier(
      { has_token: true, account_tier: 'max' },
      {
        fable: { plan_denied: true, ok: false, status: 429, error: 'Error' },
      },
    ).key,
    'max',
  )
  assert.equal(
    inferClaudeTier(
      { has_token: true, account_tier: 'pro' },
      { utilization_7d_oi: 0.21, reset_7d_oi: '2026-08-24T00:00:00Z' },
    ).key,
    'max',
  )
  assert.equal(
    inferClaudeTier(
      { has_token: true, account_tier: 'pro' },
      { usage_has_fable: true, fable: { plan_denied: true, ok: false, status: 403 } },
    ).key,
    'max',
  )
  assert.equal(inferClaudeTier({ has_token: true }).key, 'unknown')
})
