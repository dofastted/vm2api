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

test('fresh running remote Claude slots repair links without refreshing or waking other slots', async () => {
  const fresh = { ...offSlot, status: 'running', node_id: 'node-a', expires_at: Date.now() + 3600_000 }
  const checked = []
  const monitor = createCredentialRefreshMonitor({
    listTargets: () => [
      fresh,
      { ...fresh, id: 'local', node_id: null },
      { ...fresh, id: 'off', status: 'stopped' },
      { ...fresh, id: 'other', platform: 'openai' },
    ],
    refreshOne: () => assert.fail('fresh grant must not be exchanged'),
    ensureLink: async (vm) => {
      checked.push(vm.id)
      if (checked.length === 1) throw new Error('private diagnostic')
      return { linked: true }
    },
  })
  const failed = await monitor.runOnce()
  assert.equal(failed.due, 0)
  assert.deepEqual(failed.link_failures, [{ vm_id: fresh.id, reason: 'credential_link_failed' }])
  assert.deepEqual((await monitor.runOnce()).link_failures, [])
  assert.deepEqual(checked, [fresh.id, fresh.id])
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

test('worker execution and output failures are retryable without weakening fatal grant errors', () => {
  for (const code of ['worker_output_invalid', 'worker_exec_failed', 'worker_output_limit', 'credential_pull_failed']) {
    assert.equal(classifyCredentialRefresh({ ok: false, status: 0, error: { code } }), 'retryable', code)
  }
  assert.equal(classifyCredentialRefresh({ ok: false, error: { code: 'config_failed' } }), 'failed')
  assert.equal(
    classifyCredentialRefresh({
      ok: false,
      error: { code: 'worker_output_invalid', message: 'invalid_grant' },
    }),
    'fatal',
  )
})

test('stored transient refresh errors retry when due but fatal and fresh grants stay protected', () => {
  for (const code of ['worker_output_invalid', 'worker_exec_failed', 'worker_output_limit', 'credential_pull_failed']) {
    assert.equal(needsScheduledRefresh({ ...offSlot, refresh_error: code }), true, code)
    assert.equal(needsScheduledRefresh({ ...offSlot, claude: { refresh_error: code } }), true, code)
    assert.equal(needsScheduledRefresh({ ...offSlot, refresh_error: code, expires_at: Date.now() + 3600_000 }), false)
    assert.equal(
      needsScheduledRefresh({ ...offSlot, refresh_error: code, claude: { refresh_error: 'invalid_grant' } }),
      false,
    )
  }
  for (const code of ['invalid_grant', 'oauth_revoked', 'refresh_token_missing', 'config_failed']) {
    assert.equal(needsScheduledRefresh({ ...offSlot, refresh_error: code }), false, code)
  }
})

test('a slot with a historical worker output error remains eligible on the next monitor run', async () => {
  const vm = { ...offSlot, refresh_error: 'worker_output_invalid' }
  let attempts = 0
  const monitor = createCredentialRefreshMonitor({
    listTargets: () => [vm],
    refreshOne: async () => {
      attempts++
      if (attempts === 1) return { ok: false, refresh_class: 'retryable' }
      delete vm.refresh_error
      vm.expires_at = Date.now() + 3600_000
      return { ok: true, refresh_class: 'refreshed' }
    },
  })
  assert.equal((await monitor.runOnce()).due, 1)
  const recovered = await monitor.runOnce()
  assert.equal(recovered.due, 1)
  assert.equal(recovered.items[0].ok, true)
  assert.equal(attempts, 2)
  assert.equal((await monitor.runOnce()).due, 0)
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

// --- slots parked behind an old worker --------------------------------------

const parked = (id, error = 'worker_upgrade_required') => ({
  ...offSlot,
  id,
  status: 'running',
  schedulable: true,
  claude: { has_refresh: true, refresh_error: error },
})

test('clearUpgradeRequired only clears that exact parked code', async () => {
  const { clearUpgradeRequired } = await import('../../src/lib/oauth/oauth-credentials.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parked-'))
  const file = (name, error) => {
    const p = path.join(dir, `${name}.json`)
    fs.writeFileSync(p, JSON.stringify({ id: name, claude: { has_refresh: true, refresh_error: error } }))
    return p
  }
  const a = file('a', 'worker_upgrade_required')
  const b = file('b', 'invalid_grant')
  const c = file('c', 'refresh_outcome_unknown')
  assert.equal(clearUpgradeRequired(a), true)
  assert.equal(JSON.parse(fs.readFileSync(a, 'utf8')).claude.refresh_error, null)
  for (const keep of [b, c]) {
    const before = fs.readFileSync(keep, 'utf8')
    assert.equal(clearUpgradeRequired(keep), false)
    assert.equal(fs.readFileSync(keep, 'utf8'), before)
  }
  assert.equal(clearUpgradeRequired(path.join(dir, 'missing.json')), false)
})

test('monitor probes slots parked on an old worker and leaves every other parked slot alone', async () => {
  const probed = []
  const refreshed = []
  const monitor = createCredentialRefreshMonitor({
    config: { enabled: true, interval_sec: 60, concurrency: 2 },
    listTargets: () => [
      parked('vm-a'),
      parked('vm-b', 'invalid_grant'),
      parked('vm-c', 'refresh_outcome_unknown'),
      parked('vm-d'),
    ],
    refreshOne: async (vm) => {
      refreshed.push(vm.id)
      return { ok: true }
    },
    reviveOne: async (vm) => {
      probed.push(vm.id)
      return vm.id === 'vm-a' ? { revived: true } : { revived: false }
    },
  })
  const run = await monitor.runOnce()
  assert.deepEqual(probed.sort(), ['vm-a', 'vm-d'])
  assert.deepEqual(refreshed, [], 'a parked slot is never refreshed in the same pass')
  assert.deepEqual(run.revived, ['vm-a'])
})

test('a failing probe never breaks the monitor pass', async () => {
  const monitor = createCredentialRefreshMonitor({
    config: { enabled: true, interval_sec: 60, concurrency: 1 },
    listTargets: () => [parked('vm-a'), parked('vm-b')],
    refreshOne: async () => ({ ok: true }),
    reviveOne: async (vm) => {
      if (vm.id === 'vm-a') throw new Error('docker exec failed')
      return { revived: true }
    },
  })
  const run = await monitor.runOnce()
  assert.deepEqual(run.revived, ['vm-b'])
})

test('a slot is parked for the upgrade exactly where clearUpgradeRequired looks, never somewhere it cannot clear', async () => {
  const { isUpgradeParked } = await import('../../src/lib/oauth/credential-refresh-monitor.mjs')
  const { clearUpgradeRequired } = await import('../../src/lib/oauth/oauth-credentials.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parked-'))
  const onDisk = (vm) => {
    const p = path.join(dir, `${vm.id}.json`)
    fs.writeFileSync(p, JSON.stringify(vm))
    return p
  }
  const nested = { id: 'nested', claude: { refresh_error: 'worker_upgrade_required' } }
  const topOnly = { id: 'top', refresh_error: 'worker_upgrade_required', claude: {} }
  // What the monitor decides to probe must be what a successful probe can then clear.
  assert.equal(isUpgradeParked(nested), true)
  assert.equal(clearUpgradeRequired(onDisk(nested)), true)
  assert.equal(isUpgradeParked(topOnly), false, 'a top-level code is not something clearUpgradeRequired can clear')
})
