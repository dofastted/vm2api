import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isCredentialRefreshTarget,
  needsScheduledRefresh,
  normalizeCredentialRefreshConfig,
  createCredentialRefreshMonitor,
  shouldForceRefresh,
} from '../../src/lib/oauth/credential-refresh-monitor.mjs'
import {
  classifyCredentialRefresh,
  markVmRefreshError,
  persistOauthToVm,
} from '../../src/lib/oauth/oauth-credentials.mjs'

const offSlot = {
  id: 'vm-09',
  status: 'paused',
  schedulable: false,
  has_refresh: true,
  expires_at: Date.now() - 60_000,
  proxy: { host: '127.0.0.1', port: 1080, url: 'socks5h://127.0.0.1:1080' },
  proxy_cli_enabled: true,
}

test('normalize fills defaults', () => {
  const n = normalizeCredentialRefreshConfig({ interval_sec: 3, concurrency: 99 })
  assert.equal(n.enabled, true)
  assert.equal(n.interval_sec, 60)
  assert.equal(n.concurrency, 8)
  assert.equal(n.run_on_start, true)
})

test('调度关 slot with refresh token is still a refresh target', () => {
  assert.equal(isCredentialRefreshTarget(offSlot), true)
  assert.equal(isCredentialRefreshTarget({ ...offSlot, schedulable: true, status: 'running' }), true)
})

test('no refresh / down / no proxy are skipped', () => {
  assert.equal(isCredentialRefreshTarget({ ...offSlot, has_refresh: false }), false)
  assert.equal(isCredentialRefreshTarget({ ...offSlot, status: 'stopped' }), false)
  assert.equal(isCredentialRefreshTarget({ ...offSlot, proxy: null, proxy_cli_enabled: false }), false)
})

test('due when expired, not due after a recorded refresh_error', () => {
  assert.equal(needsScheduledRefresh(offSlot), true)
  assert.equal(needsScheduledRefresh({ ...offSlot, refresh_error: 'invalid_grant' }), false)
  assert.equal(
    needsScheduledRefresh({
      ...offSlot,
      expires_at: Date.now() + 8 * 3600_000,
    }),
    false,
  )
})

test('revoked access with remaining TTL is an operator hint, not a scheduled force', () => {
  const now = Date.now()
  const revoked = {
    ...offSlot,
    expires_at: now + 90 * 60_000,
    refreshed_at: new Date(now - 10 * 60_000).toISOString(),
    last_probe: {
      ok: false,
      at: new Date(now - 60_000).toISOString(),
      error: 'OAuth access token has been revoked. · upstream_error · upstream_auth_error',
    },
  }
  assert.equal(shouldForceRefresh(revoked), true)
  assert.equal(needsScheduledRefresh(revoked, now), false)
  assert.equal(
    shouldForceRefresh({
      ...revoked,
      refreshed_at: new Date(now).toISOString(),
      last_probe: { ...revoked.last_probe, at: new Date(now - 60_000).toISOString() },
    }),
    false,
  )
})

test('classify reads invalid_grant from worker message', () => {
  assert.equal(
    classifyCredentialRefresh({
      ok: false,
      status: 502,
      error: {
        code: 'credential_refresh_failed',
        message: 'OAuth refresh failed (invalid_grant): Refresh token not found',
      },
    }),
    'fatal',
  )
  assert.equal(
    classifyCredentialRefresh({
      ok: false,
      status: 0,
      error: { code: 'worker_unavailable', message: 'slot worker timeout' },
    }),
    'retryable',
  )
})

test('markVmRefreshError writes refresh_error and persist clears it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refresh-'))
  const vmPath = path.join(dir, 'vm-09.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-09',
      schedulable: false,
      schedule_disabled_reason: 'disabled',
      schedule_manual: true,
      claude: { has_refresh: true, email: 'off@example.com' },
    }),
  )
  markVmRefreshError(vmPath, {
    ok: false,
    error: { code: 'credential_refresh_failed', message: 'OAuth refresh failed (invalid_grant): gone' },
  })
  const failed = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(failed.claude.refresh_error, 'invalid_grant')
  assert.equal(failed.schedulable, false)
  assert.equal(failed.schedule_manual, true)
  persistOauthToVm(vmPath, { has_access: true, has_refresh: true, expires_at: Date.now() + 3600_000 })
  const ok = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(ok.claude.refresh_error, null)
  assert.equal(ok.schedulable, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('fatal refresh takes a non-manual slot out of the pool', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refresh-'))
  const vmPath = path.join(dir, 'vm-11.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-11',
      status: 'running',
      schedulable: true,
      claude: { has_access: true, has_refresh: true, email: 'onhold@example.com' },
    }),
  )
  markVmRefreshError(vmPath, {
    ok: false,
    error: { code: 'credential_refresh_failed', message: 'OAuth refresh failed (invalid_grant): account_on_hold' },
  })
  const failed = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(failed.claude.refresh_error, 'invalid_grant')
  assert.equal(failed.schedulable, false)
  assert.equal(failed.schedule_disabled_reason, 'oauth_invalid_grant')
  assert.equal(failed.unschedulable.reason, 'oauth_invalid_grant')
  // A background refresh / mirror does not reopen 不可调度 (operator action only).
  persistOauthToVm(vmPath, { has_access: true, has_refresh: true, expires_at: Date.now() + 3600_000 })
  const mirrored = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(mirrored.claude.refresh_error, null)
  assert.equal(mirrored.schedulable, false)
  assert.equal(mirrored.unschedulable.reason, 'oauth_invalid_grant')
  // An operator import does.
  persistOauthToVm(
    vmPath,
    { has_access: true, has_refresh: true, expires_at: Date.now() + 3600_000 },
    { operatorImport: true },
  )
  const restored = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(restored.schedulable, true)
  assert.equal(restored.unschedulable, undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('fatal refresh parks a schedule_manual slot that was still in the pool', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refresh-manual-'))
  const vmPath = path.join(dir, 'vm-13.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-13',
      status: 'running',
      schedulable: true,
      schedule_manual: true,
      claude: { has_access: true, has_refresh: true },
    }),
  )
  markVmRefreshError(vmPath, {
    ok: false,
    error: { code: 'invalid_grant', message: 'OAuth credential was rejected' },
  })
  const failed = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(failed.claude.refresh_error, 'invalid_grant')
  assert.equal(failed.schedulable, false)
  assert.equal(failed.schedule_disabled_reason, 'oauth_invalid_grant')
  assert.equal(failed.status, 'paused')
  // The operator's "on" does not shield the slot from a dead grant.
  assert.equal(failed.unschedulable.reason, 'oauth_invalid_grant')
  assert.equal(failed.schedule_off, undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('monitor includes 调度关 and calls refreshOne', async () => {
  const seen = []
  const monitor = createCredentialRefreshMonitor({
    config: { interval_sec: 60, run_on_start: false },
    listTargets: () => [offSlot, { id: 'vm-10', status: 'running', has_refresh: false }],
    refreshOne: async (vm) => {
      seen.push(vm.id)
      return { ok: false, refresh_class: 'fatal' }
    },
  })
  const snap = await monitor.runOnce()
  assert.deepEqual(seen, ['vm-09'])
  assert.equal(snap.due, 1)
  assert.equal(snap.items[0].schedulable, false)
  assert.equal(snap.items[0].ok, false)
})
