import test from 'node:test'
import assert from 'node:assert/strict'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { getDb } from '../../src/lib/db/database.mjs'
import { SharedExecutionAdmissions } from '../../src/lib/pool/shared-execution-admissions.mjs'

test('an unknown remote publication during preparation stops failover and preserves the admission', async () => {
  let selections = 0
  let marked = 0
  let calls = 0
  let released = 0
  const db = getDb()
  const lease = await new SharedExecutionAdmissions(db).tryReserve({
    accountId: 'publication-account',
    vmId: 'publication-vm',
    accountLimit: 1,
    vmLimit: 1,
    fableLimit: 0,
    rpmLimit: 0,
  })
  assert.equal(lease.ok, true)
  const scheduler = {
    async selectAndReserve() {
      selections++
      if (selections > 1) return { ok: false, reason: 'no_eligible_accounts' }
      return {
        ...lease,
        ok: true,
        accountId: 'publication-account',
        vmId: 'publication-vm',
        bindExecution: async () => {},
        markUncertain: async () => {
          marked++
          await lease.markUncertain()
        },
        release: async () => {
          if ((await lease.release()).released) released++
        },
      }
    },
    markCooldown() {},
    markSuccess() {},
  }
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'publication-unknown',
    model: 'claude-test',
    canonicalBody: { model: 'claude-test' },
    applyAttempt() {
      throw Object.assign(new Error('synthetic SFTP connection lost after write'), {
        code: 'sftp_failed',
        executionUncertain: true,
      })
    },
    callAttempt: async () => {
      calls++
      return { ok: false }
    },
  })
  assert.equal(selections, 1, 'unknown preparation must not select another VM')
  assert.equal(marked, 1)
  assert.equal(calls, 0)
  assert.equal(released, 0)
  assert.equal(result.executionUncertain, true)
  const row = await db
    .prepare('SELECT released_at, uncertain_at FROM execution_admissions WHERE id=$1')
    .get(lease.admissionId)
  assert.equal(row.released_at, null)
  assert.ok(row.uncertain_at)
})
