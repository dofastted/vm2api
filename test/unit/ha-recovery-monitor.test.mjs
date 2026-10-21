import test from 'node:test'
import assert from 'node:assert/strict'
import { haBillingFixture, billingRequest, statusFor } from '../fixtures/ha-billing.mjs'
import { withHaRequestContext } from '../../src/lib/core/ha-request-context.mjs'

function intervals(t) {
  const timers = []
  t.mock.method(globalThis, 'setInterval', (callback, delay) => {
    const timer = {
      callback,
      delay,
      unrefCalled: false,
      unref() {
        this.unrefCalled = true
      },
    }
    timers.push(timer)
    return timer
  })
  t.mock.method(globalThis, 'clearInterval', (timer) => {
    timer.cleared = true
  })
  return timers
}

async function monitorFor(t, f, readNodeRecoveryStatus) {
  const { createHaRecoveryMonitor } = await import('../../src/lib/core/ha-recovery-monitor.mjs')
  const monitor = createHaRecoveryMonitor({ db: f.peer, coordinator: f.recovery, readNodeRecoveryStatus })
  t.after(() => monitor.stop())
  return monitor
}

async function scannerActivities(f) {
  return (
    await f.peer.pool.query(
      `SELECT * FROM ${f.recovery.qualified}.activities WHERE kind='ha_request_recovery' ORDER BY created_at,id`,
    )
  ).rows
}

function assertScannersEnded(rows, expectedCount) {
  assert.equal(rows.length, expectedCount)
  for (const row of rows) {
    assert.ok(row.completed_at)
    assert.equal(row.uncertain_at, null)
  }
}

test('HA monitor immediately scans 20 live-owner parents, advances its local cursor every five seconds and resumes after stop', async (t) => {
  const f = await haBillingFixture(t)
  const timers = intervals(t)
  for (let index = 0; index < 21; index++) {
    const requestId = `live-${String(index).padStart(2, '0')}`
    const gate = await f.original.admit({ kind: 'request', requestId })
    await gate.run(() =>
      withHaRequestContext({ db: f.db, activity: gate, requestId, recoveryKind: 'claude_messages' }, async () => {}),
    )
    await gate.complete({ ended: false, reason: 'synthetic_live_owner' })
  }
  const monitor = await monitorFor(t, f, async () => assert.fail('a connected owner must not be queried'))
  const first = await monitor.start()
  assert.equal(first.results.length, 20)
  assert.ok(first.results.every((result) => result.reason === 'owner_connected'))
  assert.equal(first.nextCursor, 'live-19')
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delay, 5000)
  assert.equal(timers[0].unrefCalled, true)
  await monitor.start()
  assertScannersEnded(await scannerActivities(f), 1)
  timers[0].callback()
  const second = await monitor.flush()
  assert.deepEqual(
    second.results.map((result) => result.requestId),
    ['live-20'],
  )
  assert.equal(second.nextCursor, null)
  await monitor.stop()
  assert.equal(timers[0].cleared, true)
  timers[0].callback()
  await monitor.flush()
  assertScannersEnded(await scannerActivities(f), 2)
  const resumed = await monitor.start()
  assert.equal(resumed.results.length, 20)
  assert.equal(timers.length, 2)
  await monitor.stop()
  assert.equal(timers[1].cleared, true)
  assertScannersEnded(await scannerActivities(f), 3)
  assert.equal(
    (await f.peer.pool.query('SELECT count(*) AS n FROM ha_request_contexts WHERE recovery_sealed_at IS NOT NULL'))
      .rows[0].n,
    0,
  )
})

test('HA monitor leaves a connected owner alone then recovers its exact original proof and bills once after disconnection', async (t) => {
  const f = await haBillingFixture(t)
  const timers = intervals(t)
  const data = await billingRequest(f, async () => {}, { stopOwner: false })
  let reads = 0
  const monitor = await monitorFor(t, f, async ({ requestId, nodeBinding }) => {
    reads++
    assert.equal(requestId, data.commandIds[0])
    assert.deepEqual(nodeBinding, data.nodeBinding)
    return statusFor(data, requestId)
  })
  assert.equal((await monitor.start()).results[0].reason, 'owner_connected')
  assert.equal(reads, 0)
  assert.equal(
    (
      await f.peer.pool.query('SELECT released_at FROM api_key_admissions WHERE id=$1', [
        data.reservation.reservationId,
      ])
    ).rows[0].released_at,
    null,
  )
  await f.original._client.end()
  timers[0].callback()
  const recovered = await monitor.flush()
  assert.equal(recovered.results[0].recovered, true)
  assert.equal(recovered.results[0].billingHeld, false)
  assert.equal(reads, 1)
  timers[0].callback()
  assert.deepEqual((await monitor.flush()).results, [])
  await monitor.runOnce()
  const key = (await f.peer.pool.query('SELECT requests,tokens_in,quota_used FROM api_keys WHERE id=$1', [data.key.id]))
    .rows[0]
  assert.equal(key.requests, 1)
  assert.equal(key.tokens_in, 100)
  assert.ok(Math.abs(Number(key.quota_used) - 0.001272) < 1e-12)
  assert.equal((await f.peer.pool.query('SELECT count(*) AS n FROM ha_request_settlements')).rows[0].n, 1)
  const reservation = (
    await f.peer.pool.query('SELECT settled_at,released_at FROM api_key_admissions WHERE id=$1', [
      data.reservation.reservationId,
    ])
  ).rows[0]
  assert.ok(reservation.settled_at)
  assert.ok(reservation.released_at)
  assert.ok(
    (await f.peer.pool.query('SELECT released_at FROM execution_admissions WHERE id=$1', [data.admission.admissionId]))
      .rows[0].released_at,
  )
  assertScannersEnded(await scannerActivities(f), 4)
})

test('a real PG scan error completes only the scanner activity and logs its public code without retaining a scanner claim', async (t) => {
  const f = await haBillingFixture(t)
  const data = await billingRequest(f)
  const messages = []
  t.mock.method(console, 'warn', (...args) => {
    messages.push(args)
  })
  const monitor = await monitorFor(t, f, async ({ requestId }) => statusFor(data, requestId))
  await f.recoveryGate.run(() => f.peer.query('ALTER TABLE ha_request_contexts RENAME TO synthetic_hidden_requests'))
  const failed = await monitor.runOnce()
  assert.equal(failed.errorCode, '42P01')
  assert.deepEqual(messages, [['[ha-recovery] 42P01']])
  assertScannersEnded(await scannerActivities(f), 1)
  assert.equal(
    (
      await f.peer.pool.query('SELECT released_at FROM api_key_admissions WHERE id=$1', [
        data.reservation.reservationId,
      ])
    ).rows[0].released_at,
    null,
  )
  await f.recoveryGate.run(() => f.peer.query('ALTER TABLE synthetic_hidden_requests RENAME TO ha_request_contexts'))
  assert.equal((await monitor.runOnce()).results[0].billingHeld, false)
  assertScannersEnded(await scannerActivities(f), 2)
})

for (const response of ['unavailable', 'not_found']) {
  test(`HA monitor retains original unknown execution and quota when the node is ${response}`, async (t) => {
    const f = await haBillingFixture(t)
    const data = await billingRequest(f)
    await f.recoveryGate.run(() =>
      f.peer
        .prepare('UPDATE execution_jobs SET ended_at=NULL,node_completion=NULL WHERE request_id=$1')
        .run(data.commandIds[0]),
    )
    const monitor = await monitorFor(t, f, async () => {
      if (response === 'unavailable')
        throw Object.assign(new Error('synthetic private detail'), { code: 'synthetic_node_offline' })
      return { found: false, unknown: true }
    })
    const result = await monitor.runOnce()
    assert.equal(result.results[0].recovered, false)
    assert.equal(result.results[0].reason, 'node_completion_unproven')
    assert.equal(
      (
        await f.peer.pool.query('SELECT released_at FROM execution_admissions WHERE id=$1', [
          data.admission.admissionId,
        ])
      ).rows[0].released_at,
      null,
    )
    assert.equal(
      (
        await f.peer.pool.query('SELECT released_at FROM api_key_admissions WHERE id=$1', [
          data.reservation.reservationId,
        ])
      ).rows[0].released_at,
      null,
    )
    assert.equal(
      (
        await f.peer.pool.query('SELECT completed_at FROM ' + f.recovery.qualified + '.activities WHERE id=$1', [
          f.originalGate.activityId,
        ])
      ).rows[0].completed_at,
      null,
    )
    assert.equal((await f.peer.pool.query('SELECT count(*) AS n FROM ha_request_settlements')).rows[0].n, 0)
    assertScannersEnded(await scannerActivities(f), 1)
  })
}

test('HA monitor serializes runOnce and stop waits for its original in-flight read and durable settlement', async (t) => {
  const f = await haBillingFixture(t)
  const timers = intervals(t)
  const data = await billingRequest(f)
  let entered
  const reading = new Promise((resolve) => {
    entered = resolve
  })
  let resolveStatus
  const pendingStatus = new Promise((resolve) => {
    resolveStatus = resolve
  })
  let reads = 0
  const monitor = await monitorFor(t, f, async () => {
    reads++
    entered()
    return pendingStatus
  })
  const first = monitor.start()
  assert.equal(monitor.runOnce(), first)
  assert.equal(monitor.flush(), first)
  await reading
  timers[0].callback()
  assert.equal(reads, 1)
  let stopped = false
  const stop = monitor.stop().then(() => {
    stopped = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(timers[0].cleared, true)
  assert.equal(stopped, false)
  resolveStatus(statusFor(data, data.commandIds[0]))
  await stop
  assert.equal(stopped, true)
  assert.equal((await first).results[0].billingHeld, false)
  assertScannersEnded(await scannerActivities(f), 1)
  assert.equal(
    (await f.peer.pool.query('SELECT requests FROM api_keys WHERE id=$1', [data.key.id])).rows[0].requests,
    1,
  )
})
