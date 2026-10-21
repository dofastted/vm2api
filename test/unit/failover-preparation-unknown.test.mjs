import test from 'node:test'
import assert from 'node:assert/strict'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'

test('an unknown remote publication during preparation stops failover and preserves the admission', async () => {
  let selections = 0
  let marked = 0
  let calls = 0
  let released = 0
  let uncertain = false
  const scheduler = {
    async selectAndReserve() {
      selections++
      if (selections > 1) return { ok: false, reason: 'no_eligible_accounts' }
      return {
        ok: true,
        accountId: 'publication-account',
        vmId: 'publication-vm',
        bindExecution: async () => {},
        markUncertain: async () => {
          marked++
          uncertain = true
        },
        release: async () => {
          if (!uncertain) released++
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
})
