import test from 'node:test'
import assert from 'node:assert/strict'
import { haBillingFixture, billingRequest, statusFor } from '../fixtures/ha-billing.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { HaRequestRecovery } from '../../src/lib/core/ha-request-recovery.mjs'
import { withHaRequestContext } from '../../src/lib/core/ha-request-context.mjs'

for (const state of ['held-key', 'unrecovered-activity', 'normal-finished']) {
  test(`aged attempt cleanup retains only required HA evidence: ${state}`, async (t) => {
    const f = await haBillingFixture(t)
    const data = await billingRequest(f, async (current) => {
      if (state !== 'held-key') {
        await current.admission.release()
        await current.reservation.release()
      }
    })
    await f.recoveryGate.run(async () => {
      await f.peer
        .prepare('UPDATE request_attempts SET started_at=$1 WHERE ha_request_id=$2')
        .run('2000-01-01T00:00:00.000Z', 'billing-parent')
      if (state === 'normal-finished')
        await f.peer.query(
          `UPDATE ${f.recovery.qualified}.activities SET completed_at=clock_timestamp() WHERE id=$1 AND owner_id=$2`,
          [f.originalGate.activityId, f.original.ownerId],
        )
      const deleted = await new RequestAttemptsRepo(f.peer).cleanup(7)
      assert.equal(deleted, state === 'normal-finished' ? 1 : 0)
      if (state === 'held-key') {
        const outcome = await new HaRequestRecovery(f.peer, { coordinator: f.recovery }).recover('billing-parent', {
          readRecoveryStatus: async ({ requestId }) => statusFor(data, requestId),
        })
        assert.equal(outcome.recovered, true)
        assert.equal(outcome.billingHeld, false)
        assert.equal((await f.peer.prepare('SELECT requests FROM api_keys WHERE id=$1').get(data.key.id)).requests, 1)
      }
    })
  })
}

test('released admission history keeps its original job while the exact HA activity still needs recovery', async (t) => {
  const f = await haBillingFixture(t)
  const data = await billingRequest(f, async (current) => {
    await current.admission.release()
    await current.reservation.release()
  })
  await f.recoveryGate.run(async () => {
    await f.peer
      .prepare("UPDATE execution_admissions SET created_at=clock_timestamp()-interval '2 minutes' WHERE id=$1")
      .run(data.admission.admissionId)
    await withHaRequestContext({ db: f.peer, activity: f.recoveryGate, requestId: 'new-cleanup-trigger' }, async () => {
      const fresh = await new ExecutionAdmissionsRepo(f.peer).tryReserve({
        accountId: 'fixture-account',
        vmId: 'vm-fixture',
        accountLimit: 5,
        vmLimit: 5,
        fableLimit: 0,
        rpmLimit: 0,
      })
      assert.equal(fresh.ok, true)
      await fresh.release()
    })
    assert.ok(
      await f.peer.prepare('SELECT node_binding FROM execution_jobs WHERE request_id=$1').get(data.commandIds[0]),
      'exact original node binding must survive until its activity is recovered',
    )
  })
})
