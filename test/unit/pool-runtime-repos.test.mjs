import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../../src/lib/db/database.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'

test('account runtime state persists account and model cooldowns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-runtime-repo-'))
  const db = await getDb()
  try {
    const repo = new AccountRuntimeRepo(db)
    await repo.upsert({
      account_id: 'account-1',
      vm_id: 'vm-01',
      status: 'ready',
      priority: 3,
      weight: 5,
      worker_heartbeat_at: Date.now(),
      worker_status: { ok: true },
    })
    const until = Date.now() + 60_000
    await repo.markCooldown('account-1', {
      vmId: 'vm-01',
      model: 'claude-test',
      until,
      reason: 'model_rate_limit',
    })
    const state = await repo.get('account-1')
    assert.equal(state.priority, 3)
    assert.equal(state.weight, 5)
    assert.equal(state.model_states['claude-test'].reason, 'model_rate_limit')
    assert.equal(state.model_states['claude-test'].cooldown_until, until)
  } finally {
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('account cooldown mirrors structured rate-limit columns (sub2api style)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-runtime-repo-'))
  const db = await getDb()
  try {
    const repo = new AccountRuntimeRepo(db)
    const until = Date.now() + 300_000
    await repo.markCooldown('account-rl', {
      vmId: 'vm-01',
      until,
      reason: 'account_quota_exhausted',
    })
    let state = await repo.get('account-rl')
    assert.equal(state.rate_limit_reset_at, until)
    assert.ok(state.rate_limited_at <= Date.now())
    assert.equal(state.overload_until, null)

    await repo.markCooldown('account-rl', { vmId: 'vm-01', until: until + 1000, reason: 'provider_overloaded' })
    state = await repo.get('account-rl')
    assert.equal(state.overload_until, null)
    assert.equal(state.cooldown_until, until + 1000)
    assert.equal(state.cooldown_reason, 'provider_overloaded')
    assert.equal(state.rate_limit_reset_at, until)
  } finally {
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('updateWindow persists session window without touching cooldowns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-runtime-repo-'))
  const db = await getDb()
  try {
    const repo = new AccountRuntimeRepo(db)
    const end = Date.now() + 3600_000
    await repo.updateWindow('account-w', {
      vmId: 'vm-02',
      sessionWindowStart: end - 5 * 3600_000,
      sessionWindowEnd: end,
      sessionWindowStatus: 'allowed_warning',
    })
    const state = await repo.get('account-w')
    assert.equal(state.session_window_end, end)
    assert.equal(state.session_window_start, end - 5 * 3600_000)
    assert.equal(state.session_window_status, 'allowed_warning')
    assert.equal(state.cooldown_until, null)
    // partial update keeps prior fields
    await repo.updateWindow('account-w', { sessionWindowStatus: 'rejected' })
    assert.equal((await repo.get('account-w')).session_window_end, end)
    assert.equal((await repo.get('account-w')).session_window_status, 'rejected')
  } finally {
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('clearAuthCooldown drops 401 leftover and keeps quota cools', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-runtime-auth-'))
  const db = await getDb()
  try {
    const repo = new AccountRuntimeRepo(db)
    const until = Date.now() + 600_000
    await repo.markCooldown('auth-1', {
      vmId: 'vm-11',
      until,
      reason: 'authentication_failed_after_refresh',
    })
    await repo.markCooldown('quota-1', {
      vmId: 'vm-12',
      until,
      reason: 'account_quota_exhausted',
    })
    assert.equal(await repo.clearAuthCooldown('auth-1', { vmId: 'vm-11' }), true)
    assert.equal((await repo.get('auth-1')).cooldown_reason, null)
    assert.equal((await repo.get('auth-1')).cooldown_until, null)
    assert.equal(await repo.clearAuthCooldown('quota-1', { vmId: 'vm-12' }), false)
    assert.equal((await repo.get('quota-1')).cooldown_reason, 'account_quota_exhausted')
    await repo.markCooldown('revoked-1', {
      vmId: 'vm-100',
      until: Number.MAX_SAFE_INTEGER,
      reason: 'oauth_revoked',
      status: 'disabled',
    })
    assert.equal(await repo.clearAuthCooldown('revoked-1', { vmId: 'vm-100' }), false)
    assert.equal((await repo.get('revoked-1')).cooldown_reason, 'oauth_revoked')
    assert.equal(await repo.clearGrantRevokeCooldown('revoked-1', { vmId: 'vm-100' }), true)
    assert.equal((await repo.get('revoked-1')).cooldown_reason, null)
    assert.equal((await repo.get('revoked-1')).status, 'ready')
    await repo.markCooldown('setup-1', {
      vmId: 'vm-05',
      until: Number.MAX_SAFE_INTEGER,
      reason: 'oauth_no_refresh',
      status: 'disabled',
    })
    assert.equal(await repo.clearGrantRevokeCooldown('setup-1', { vmId: 'vm-05' }), true)
    assert.equal((await repo.get('setup-1')).cooldown_reason, null)
    assert.equal((await repo.get('setup-1')).status, 'ready')
  } finally {
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('request attempt ledger records final state and commit boundary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-attempt-repo-'))
  const db = await getDb()
  try {
    const repo = new RequestAttemptsRepo(db)
    await repo.begin({
      requestId: 'req-1',
      attemptNo: 1,
      vmId: 'vm-01',
      accountId: 'account-1',
      model: 'claude-test',
      selectionReason: 'balanced',
      waitMs: 4,
    })
    await repo.complete('req-1', 1, {
      upstreamStatus: 429,
      errorScope: 'account',
      action: 'continue-and-cooldown',
      cooldownUntil: Date.now() + 60_000,
      terminalState: 'rejected',
      latencyMs: 12,
    })
    await repo.begin({
      requestId: 'req-1',
      attemptNo: 2,
      vmId: 'vm-02',
      accountId: 'account-2',
      model: 'claude-test',
      selectionReason: 'failover',
    })
    await repo.complete('req-1', 2, {
      upstreamStatus: 200,
      downstreamCommitted: true,
      terminalState: 'verified',
      usage: { input_tokens: 2, output_tokens: 3 },
      ttftMs: 20,
      latencyMs: 40,
    })
    const attempts = await repo.list('req-1')
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0].action, 'continue-and-cooldown')
    assert.equal(attempts[1].terminal_state, 'verified')
    assert.equal(attempts[1].downstream_committed, true)
    assert.deepEqual(attempts[1].usage, { input_tokens: 2, output_tokens: 3 })
  } finally {
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
