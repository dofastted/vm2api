import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateCredentialEligibility,
  evaluateProxySync,
  evaluateSlotGate,
  slotHasBoundProxy,
  credPanelUnavailable,
  shouldMarkMissingRefresh,
  isCredentialRuntimeBlocked,
  isGrantRevoked,
  isLiveDiskGrant,
  isLeftoverGrantRevokeRuntime,
} from '../../src/lib/pool/schedule-eligibility.mjs'

function vm(claude = {}) {
  return {
    id: 'vm-01',
    status: 'running',
    schedulable: true,
    proxy_cli_enabled: true,
    proxy: { url: 'socks5h://127.0.0.1:1080' },
    claude,
  }
}
test('console API key without expiry is eligible', () => {
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_api_key: true, mode: 'apikey' }),
    workerStatus: {
      ok: true,
      credential: { has_access: true, has_refresh: false, needs_refresh: false, type: 'apikey' },
    },
  })
  assert.equal(r.ok, true)
})

test('retryable refresh error does not become permanent credential failure', () => {
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: true, expires_at: Date.now() - 60_000 }),
    workerStatus: {
      ok: false,
      last_error_class: 'retryable',
      last_error: 'OAuth refresh failed (timeout)',
      credential: { has_access: true, has_refresh: true, needs_refresh: true, expires_at: Date.now() - 60_000 },
    },
  })
  assert.equal(r.reason, 'refresh_pending')
})

test('expired access without refresh is oauth_expired', () => {
  const now = Date.now()
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: false, expires_at: Math.floor(now / 1000) - 60 }),
    now,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'oauth_expired')
})

test('revoked access is oauth_revoked even when TTL is future', () => {
  const now = Date.now()
  const r = evaluateCredentialEligibility({
    vm: vm({
      has_access: true,
      has_refresh: true,
      expires_at: Math.floor(now / 1000) + 3600,
      refresh_error: 'OAuth access token has been revoked.',
    }),
    now,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'oauth_revoked')
})

test('expired access with refresh remains schedulable while worker can refresh', () => {
  const now = Date.now()
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: true, expires_at: Math.floor(now / 1000) - 60 }),
    workerStatus: {
      ok: true,
      credential: { has_access: true, has_refresh: true, needs_refresh: true, expires_at: now - 60_000 },
    },
    now,
  })
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'refresh_pending')
})

test('invalid_grant takes the slot out of the pool', () => {
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: true, refresh_error: 'invalid_grant' }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'oauth_invalid_grant')
})

test('leftover worker last_error does not eject a live worker', () => {
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: true, refresh_error: 'invalid_grant' }),
    workerStatus: {
      ok: true,
      error: 'OAuth refresh failed (invalid_grant): Refresh token not found or invalid',
      credential: {
        has_access: true,
        has_refresh: true,
        needs_refresh: false,
        expires_at: Date.now() + 3600_000,
      },
    },
  })
  assert.equal(r.ok, true)
})

test('stale access 401 cooldown does not block a live grant', () => {
  const now = Date.now()
  assert.equal(
    isCredentialRuntimeBlocked(
      {
        status: 'cooldown',
        cooldown_until: now + 600_000,
        cooldown_reason: 'authentication_failed_after_refresh',
      },
      now,
    ),
    false,
  )
  assert.equal(
    isCredentialRuntimeBlocked(
      {
        status: 'cooldown',
        cooldown_until: now + 600_000,
        cooldown_reason: 'oauth_invalid_grant',
      },
      now,
    ),
    true,
  )
})

test('presence flags count as a credential without leftover tokens', () => {
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: true, expires_at: Math.floor(Date.now() / 1000) + 3600 }),
  })
  assert.equal(r.ok, true)
})

test('panel treats expired access with refresh as refreshable', () => {
  assert.equal(credPanelUnavailable({ has_refresh: true }, Date.now() - 60_000), false)
  assert.equal(credPanelUnavailable({}, Date.now() - 60_000), true)
})

test('operator schedule off is not credential-unavailable', () => {
  assert.equal(credPanelUnavailable({ schedulable: false, schedule_disabled_reason: 'disabled' }), false)
  assert.equal(credPanelUnavailable({ schedulable: false, schedule_disabled_reason: 'oauth_no_refresh' }), true)
})

test('leftover oauth_cleared with expired refreshable access remains available', () => {
  assert.equal(
    credPanelUnavailable(
      {
        schedulable: false,
        schedule_disabled_reason: 'oauth_cleared',
        has_refresh: true,
        has_token: true,
      },
      Date.now() - 60_000,
    ),
    false,
  )
})

test('leftover oauth_cleared is not unavailable after a live credential', () => {
  assert.equal(
    credPanelUnavailable({
      schedulable: false,
      schedule_disabled_reason: 'oauth_cleared',
      has_refresh: true,
    }),
    false,
  )
  assert.equal(
    credPanelUnavailable({
      schedulable: false,
      schedule_disabled_reason: 'oauth_cleared',
      has_token: true,
    }),
    false,
  )
  assert.equal(
    credPanelUnavailable({
      schedulable: false,
      schedule_disabled_reason: 'oauth_cleared',
    }),
    true,
  )
})

test('leftover oauth_no_refresh is not unavailable when refresh is present', () => {
  assert.equal(
    credPanelUnavailable({
      schedulable: false,
      schedule_disabled_reason: 'oauth_no_refresh',
      has_refresh: true,
    }),
    false,
  )
  assert.equal(
    credPanelUnavailable({
      schedulable: false,
      schedule_disabled_reason: 'oauth_no_refresh',
      worker_credential: { has_access: true, has_refresh: true },
    }),
    false,
  )
})

test('oauth_invalid_grant stays unavailable until access TTL is live', () => {
  assert.equal(
    credPanelUnavailable({
      schedulable: false,
      schedule_disabled_reason: 'oauth_invalid_grant',
      has_refresh: true,
    }),
    true,
  )
  assert.equal(
    credPanelUnavailable(
      {
        schedulable: false,
        schedule_disabled_reason: 'oauth_invalid_grant',
        has_refresh: true,
        worker_credential: { has_access: true, has_refresh: true, needs_refresh: true },
      },
      Date.now() - 60_000,
    ),
    true,
  )
  assert.equal(
    credPanelUnavailable(
      {
        schedulable: false,
        schedule_disabled_reason: 'oauth_invalid_grant',
        has_token: true,
        worker_credential: {
          has_access: true,
          has_refresh: true,
          needs_refresh: false,
          expires_at: Date.now() + 3600_000,
        },
      },
      Date.now() + 3600_000,
    ),
    false,
  )
})

test('proxy desync is fail-closed before hop', () => {
  const v = vm()
  v.proxy = { host: '72.1.181.43', port: 5437, url: 'socks5://u:p@72.1.181.43:5437' }
  assert.equal(evaluateProxySync({ vm: v, workerProxyEndpoint: '72.1.181.43:5437' }).ok, true)
  const bad = evaluateProxySync({ vm: v, workerProxyEndpoint: '154.9.177.229:5509' })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'proxy_desynced')
  assert.equal(evaluateProxySync({ vm: v }).ok, true)
  const missing = evaluateProxySync({ vm: v, workerProxyEndpoint: null })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'worker_proxy_missing')
  assert.equal(evaluateProxySync({ vm: v, workerProxyEndpoint: null, egressMode: 'transparent' }).ok, true)
})

test('local egress stays schedulable when the worker proxy url is empty', () => {
  const v = vm()
  v.proxy = { id: 'px-local', scheme: 'local', host: 'local', port: 0, url: null }
  assert.equal(evaluateProxySync({ vm: v, workerProxyEndpoint: null }).ok, true)
  assert.equal(evaluateProxySync({ vm: v, workerProxyEndpoint: '' }).ok, true)
})

test('paused slot without SOCKS is proxy_required even if pin would skip unschedulable', () => {
  const paused = {
    id: 'vm-01',
    status: 'paused',
    schedulable: false,
    schedule_disabled_reason: 'proxy_required',
    proxy_cli_enabled: true,
    proxy: {},
    claude: { has_access: true, has_refresh: true },
  }
  const gate = evaluateSlotGate(paused)
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'vm_unschedulable')
  assert.equal(slotHasBoundProxy(paused), false)
  assert.equal(
    slotHasBoundProxy({
      proxy_cli_enabled: true,
      proxy: { id: 'px-local', scheme: 'local', host: 'local' },
    }),
    true,
  )
})

test('shouldMarkMissingRefresh ignores stripped presence flags', () => {
  assert.equal(shouldMarkMissingRefresh({ claude: { has_refresh: true } }), false)
  assert.equal(shouldMarkMissingRefresh({ claude: { refresh_token: 'rt' } }), false)
  assert.equal(shouldMarkMissingRefresh({ claude: { has_access: true } }), true)
  assert.equal(shouldMarkMissingRefresh({ claude: {} }), true)
})

test('test-chat last_probe revoked is not a dead grant', () => {
  assert.equal(
    isGrantRevoked({
      last_probe: {
        ok: false,
        source: 'test-chat',
        error: 'OAuth access token has been revoked.',
      },
    }),
    false,
  )
  assert.equal(
    isGrantRevoked({
      last_probe: {
        ok: false,
        source: 'vm-oauth-usage',
        error: 'OAuth access token has been revoked.',
      },
    }),
    true,
  )
})

test('live disk grant ignores leftover runtime revoke', () => {
  const live = vm({ has_access: true, has_refresh: true, refresh_error: null })
  live.schedule_disabled_reason = null
  assert.equal(isLiveDiskGrant(live, { has_token: true, has_refresh: true }), true)
  assert.equal(
    isGrantRevoked({
      vm: live,
      has_token: true,
      has_refresh: true,
      schedule_disabled_reason: null,
      refresh_error: null,
      cooldown_reason: 'oauth_revoked',
      runtime: { cooldown_reason: 'oauth_revoked' },
    }),
    false,
  )
  const state = { status: 'disabled', cooldown_reason: 'oauth_revoked', cooldown_until: Number.MAX_SAFE_INTEGER }
  assert.equal(isLeftoverGrantRevokeRuntime(state, live), true)
  assert.equal(isCredentialRuntimeBlocked(state, Date.now(), live), false)
  assert.equal(isCredentialRuntimeBlocked(state, Date.now()), true)
})

test('disk oauth_revoked still blocks even if runtime was cleared', () => {
  const dead = vm({ has_access: true, has_refresh: true, refresh_error: 'oauth_revoked' })
  dead.schedule_disabled_reason = 'oauth_revoked'
  assert.equal(
    isLiveDiskGrant(dead, {
      refresh_error: 'oauth_revoked',
      schedule_disabled_reason: 'oauth_revoked',
      has_token: true,
    }),
    false,
  )
  assert.equal(
    isGrantRevoked({
      vm: dead,
      has_token: true,
      schedule_disabled_reason: 'oauth_revoked',
      refresh_error: 'oauth_revoked',
    }),
    true,
  )
})

test('slot-full kernel is eligible busy, not worker_unhealthy', () => {
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: true, expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    workerStatus: {
      ok: false,
      engine: 'rust',
      ready_slots: 0,
      cli_pid: 9,
      credential: { has_access: true, has_refresh: true },
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'slot_busy')
})
