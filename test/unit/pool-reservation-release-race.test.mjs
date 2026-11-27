import test from 'node:test'
import assert from 'node:assert/strict'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'

for (const phase of ['quota', 'circuit']) {
  test(`reservation preserves a release from the ${phase} admission hook`, () => {
    let releaseDuringAdmission = null
    let quotaInflight = 0
    const gate = (current) => {
      if (phase === current && releaseDuringAdmission) {
        const release = releaseDuringAdmission
        releaseDuringAdmission = null
        release()
      }
      return { ok: true }
    }
    const scheduler = new PoolScheduler({
      accountQuota: {
        tryAcquire() {
          gate('quota')
          quotaInflight += 1
          return { ok: true }
        },
        release() {
          quotaInflight -= 1
        },
      },
      schedulerRuntime: makeStubSchedulerRuntime(),
    })
    scheduler.unitCircuit = { admit: () => gate('circuit') }
    const candidate = { accountId: 'race-account', vmId: 'race-vm', model: 'claude-sonnet-4-5', maxConcurrency: 2 }

    for (let round = 0; round < 20; round += 1) {
      const first = scheduler.reserve(candidate)
      assert.ok(first)
      releaseDuringAdmission = first.release
      const second = scheduler.reserve(candidate)
      assert.ok(second)
      assert.equal(scheduler.inflight.get(candidate.accountId), 1)
      assert.equal(scheduler.vmInflight.get(candidate.vmId), 1)
      assert.equal(quotaInflight, 1)

      const third = scheduler.reserve(candidate)
      assert.ok(third, 'released capacity must be reusable')
      assert.equal(scheduler.reserve(candidate), null, 'the configured cap must still hold')
      second.release()
      third.release()
      third.release()
      assert.equal(scheduler.inflight.size, 0)
      assert.equal(scheduler.vmInflight.size, 0)
      assert.equal(quotaInflight, 0)
    }
  })
}

import {
  withM3SchedulerDeps,
  ensureApiSchedulerM3,
  makeStubSchedulerRuntime,
  makeMockGeminiRuntime,
  makeMockCodexRuntimeFor,
  withM3FailoverRunner,
} from '../fixtures/scheduler-runtime-mock.mjs'
