import test from 'node:test'
import assert from 'node:assert/strict'
import { haBillingFixture, billingRequest, statusFor } from '../fixtures/ha-billing.mjs'
import { withHaRequestContext } from '../../src/lib/core/ha-request-context.mjs'
import { HaRequestRecovery } from '../../src/lib/core/ha-request-recovery.mjs'

async function emptyParent(f, requestId, recoveryKind = 'claude_messages') {
  const gate = await f.original.admit({ kind: 'request', requestId })
  await gate.run(() => withHaRequestContext({ db: f.db, activity: gate, requestId, recoveryKind }, async () => {}))
  await gate.complete({ ended: false, reason: 'synthetic_orphan' })
}

test('scan paginates live-owner candidates and never treats old request timestamps as owner loss', async (t) => {
  const f = await haBillingFixture(t)
  await emptyParent(f, 'a-live')
  await emptyParent(f, 'b-live')
  await emptyParent(f, 'legacy-untyped', null)
  const recovery = new HaRequestRecovery(f.peer, { coordinator: f.recovery })
  await f.recoveryGate.run(async () => {
    const first = await recovery.scan({ limit: 1 })
    assert.equal(first.results.length, 1)
    assert.equal(first.results[0].requestId, 'a-live')
    assert.equal(first.results[0].reason, 'owner_connected')
    assert.equal(first.nextCursor, 'a-live')
    const second = await recovery.scan({ limit: 1, afterRequestId: first.nextCursor })
    assert.equal(second.results[0].requestId, 'b-live')
    assert.equal(second.nextCursor, null)
    assert.equal(
      (await f.peer.prepare('SELECT count(*) AS n FROM ha_request_contexts WHERE recovery_sealed_at IS NOT NULL').get())
        .n,
      0,
    )
    await f.original.stop()
    const dead = await recovery.scan({ limit: 10 })
    assert.equal(dead.results.length, 2)
    assert.equal(
      dead.results.every((result) => result.recovered === true),
      true,
    )
    assert.equal((await recovery.scan()).results.length, 0)
  })
})

test('scan continues after one exact recovery throws and excludes fully released settled requests', async (t) => {
  const f = await haBillingFixture(t)
  await emptyParent(f, 'a-unavailable')
  const data = await billingRequest(f)
  const recovery = new HaRequestRecovery(f.peer, {
    coordinator: f.recovery,
    readNodeRecoveryStatus: async ({ requestId }) => statusFor(data, requestId),
  })
  const recover = recovery.recover.bind(recovery)
  recovery.recover = async (requestId) => {
    if (requestId === 'a-unavailable')
      throw Object.assign(new Error('synthetic database failure'), { code: 'synthetic_unavailable' })
    return recover(requestId)
  }
  await f.recoveryGate.run(async () => {
    const results = await recovery.scan({ limit: 10 })
    assert.equal(results.results.length, 2)
    assert.equal(results.results[0].errorCode, 'synthetic_unavailable')
    assert.equal(results.results[1].requestId, 'billing-parent')
    assert.equal(results.results[1].billingHeld, false)
    assert.deepEqual((await recovery.scan({ afterRequestId: 'a-unavailable' })).results, [])
  })
})

test('scan includes already paid but unreleased reservations and excludes broken activity/epoch links', async (t) => {
  const f = await haBillingFixture(t)
  const data = await billingRequest(f, async (current) => {
    await current.keys.recordUsage(
      current.key,
      { input_tokens: 33 },
      { officialCost: 9, reservation: current.reservation },
    )
  })
  const recovery = new HaRequestRecovery(f.peer, {
    coordinator: f.recovery,
    readNodeRecoveryStatus: async ({ requestId }) => statusFor(data, requestId),
  })
  await f.recoveryGate.run(async () => {
    await f.peer
      .prepare(
        `INSERT INTO ha_request_contexts(id,activity_id,activity_owner_id,activity_epoch,recovery_kind) VALUES('broken-link','absent','missing-owner',1,'claude_messages')`,
      )
      .run()
    const result = await recovery.scan()
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].requestId, 'billing-parent')
    assert.equal(result.results[0].billingHeld, false)
    assert.equal((await f.peer.prepare('SELECT requests FROM api_keys WHERE id=$1').get(data.key.id)).requests, 1)
    assert.deepEqual((await recovery.scan()).results, [])
  })
})
