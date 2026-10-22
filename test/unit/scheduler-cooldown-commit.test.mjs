import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('shared cooldown side effects await PostgreSQL acceptance and skip a rejected observation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cooldown-commit-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  const file = path.join(root, 'vms', 'vm-cooldown.json')
  fs.writeFileSync(file, JSON.stringify({ id: 'vm-cooldown', claude: {} }))
  const entered = deferred()
  const resume = deferred()
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: {
      markCooldown() {},
      async markCooldownCommitted() {
        entered.resolve()
        await resume.promise
        return { applied: false, state: { cooldown_reason: null } }
      },
    },
  })
  pool.shared = true
  const result = Promise.resolve(
    pool.markCooldown(
      { vmId: 'vm-cooldown', accountId: 'account-cooldown' },
      {
        until: Date.now() + 60_000,
        reason: 'account_quota_exhausted',
        observation: 1,
      },
    ),
  )
  try {
    await Promise.race([
      entered.promise,
      result.then(() => assert.fail('VM cooldown changed before PostgreSQL accepted the observation')),
    ])
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).temp_unschedulable_reason, undefined)
  } finally {
    resume.resolve()
  }
  assert.equal(await result, false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).temp_unschedulable_reason, undefined)
})

test('a rejected cooldown observation cannot invalidate the current shared account sessions', async () => {
  let releases = 0
  const runner = new FailoverRunner({
    scheduler: {
      async selectAndReserve({ excluded }) {
        if (excluded.has('account-cooldown')) return { ok: false, reason: 'no_eligible_accounts' }
        return { ok: true, accountId: 'account-cooldown', vmId: 'vm-cooldown', release() {} }
      },
      async markCooldown() {
        return false
      },
      async releaseAccountSessions() {
        releases++
      },
    },
    config: { max_total_attempts: 1, max_same_account_retries: 0, same_account_retry_delay_ms: 0 },
  })
  await runner.run({
    requestId: 'rejected-cooldown',
    canonicalBody: { model: 'claude-test' },
    callAttempt: async () => ({
      ok: false,
      status: 429,
      terminalState: 'rejected',
      accountObservation: 1,
      body: { type: 'error', error: { type: 'api_error', message: "You've hit your limit · resets 11am (UTC)" } },
    }),
  })
  assert.equal(releases, 0)
})
