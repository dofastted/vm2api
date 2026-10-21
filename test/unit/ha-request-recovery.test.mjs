import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { getDb, quoteIdentifier, registerActivityCoordinator, withTransaction } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator, coordinationSchemaFor } from '../../src/lib/db/global-maintenance.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
import { withHaRequestContext, withHaRequestAttempt } from '../../src/lib/core/ha-request-context.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { SharedExecutionAdmissions } from '../../src/lib/pool/shared-execution-admissions.mjs'
import { SharedSessionTurns } from '../../src/lib/pool/shared-session-turns.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { syntheticFence } from '../fixtures/fake-slotgate.mjs'

async function fixture(t) {
  const db = getDb()
  const peer = await createRepositoryTestDatabase({ connectionString: db.connectionString, schema: db.schema })
  const first = new GlobalMaintenanceCoordinator(db, { ownerId: 'original-owner' })
  const second = new GlobalMaintenanceCoordinator(peer, { ownerId: 'recovery-owner' })
  await first.start()
  await second.start()
  registerActivityCoordinator(db, first)
  registerActivityCoordinator(peer, second)
  await first.acknowledgeEpoch(1)
  await second.acknowledgeEpoch(1)
  const previousMode = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes-ha'
  t.after(async () => {
    if (previousMode == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previousMode
    await Promise.allSettled([first.stop(), second.stop()])
    const cleanup = new pg.Client({ connectionString: db.connectionString })
    await cleanup.connect()
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinationSchemaFor(db.schema))} CASCADE`)
    } finally {
      await cleanup.end()
    }
    await peer.close()
  })
  const gate = await second.admit({ kind: 'orphan_recovery' })
  t.after(() => gate.complete({ ended: true }).catch(() => {}))
  return { db, peer, first, second, gate }
}

async function parent(first, db, requestId, recoveryKind = 'claude_messages') {
  const activity = await first.admit({ kind: 'request', requestId })
  await activity.run(() => withHaRequestContext({ db, requestId, activity, recoveryKind }, async () => {}))
  await activity.complete({ ended: false, reason: 'synthetic_owner_lost' })
  return activity
}

async function graph({ db, first }, requestId, { withJob = true, graceMs = 30000 } = {}) {
  const activity = await first.admit({ kind: 'request', requestId })
  const nodeBinding = {
    protocol: 'KSG2',
    nodeId: 'original-node',
    vmId: 'vm-fixture',
    kind: 'kernel',
    fence: syntheticFence(),
  }
  let keyLease, turn, admission
  await activity.run(() =>
    withHaRequestContext({ db, requestId, activity, recoveryKind: 'claude_messages' }, async () => {
      const keys = new ApiKeyStore({ db })
      const key = await keys.create({ name: 'synthetic-key-' + requestId })
      keyLease = await keys.reserve(key)
      assert.equal(keyLease.ok, true)
      const turns = new SharedSessionTurns(db)
      turn = await turns.enqueue('session-' + requestId, 'not-a-parent-link')
      assert.equal(await turns.tryActivate(turn), true)
      await turns.markUncertain(turn)
      admission = await new SharedExecutionAdmissions(db).tryReserve({
        accountId: 'fixture-account',
        vmId: 'vm-fixture',
        accountLimit: 10,
        vmLimit: 10,
        fableLimit: 0,
        rpmLimit: 0,
        seatKey: 'seat-' + requestId,
        seatCap: 10,
        seatGraceMs: graceMs,
        seatReservePct: 0,
        seatHeadroom: 1,
      })
      assert.equal(admission.ok, true)
      if (withJob) {
        await new RequestAttemptsRepo(db).begin({
          requestId,
          attemptNo: 1,
          vmId: 'vm-fixture',
          accountId: 'fixture-account',
          model: 'claude-synthetic',
        })
        await withHaRequestAttempt(1, () =>
          admission.bindExecution({
            requestId: 'command-' + requestId,
            nodeBinding,
            billingSnapshot: {
              version: 1,
              model: 'claude-synthetic',
              rate_multiplier: 1,
              cache_ttl: '1h',
              requested_speed: null,
              resolved: null,
            },
          }),
        )
      }
      await admission.markUncertain()
    }),
  )
  await activity.complete({ ended: false, reason: 'synthetic_owner_lost' })
  return { activity, keyLease, turn, admission, nodeBinding, commandId: 'command-' + requestId }
}

function completed(original) {
  return { id: original.commandId, fence: original.nodeBinding.fence, status: 'completed', dispatched: true }
}

test('a live owner keeps its lifetime lock regardless of old member timestamps', async (t) => {
  const { peer, first, second, gate } = await fixture(t)
  await peer.pool.query(`UPDATE ${first.qualified}.members SET started_at='2000-01-01' WHERE owner_id=$1`, [
    first.ownerId,
  ])
  await gate.run(async () => {
    const result = await withTransaction(peer, () => second.lockAbsentOwner(first.ownerId))
    assert.deepEqual(result, { absent: false, reason: 'owner_connected' })
  })
  const member = (
    await peer.pool.query(`SELECT owner_lock_version FROM ${first.qualified}.members WHERE owner_id=$1`, [
      first.ownerId,
    ])
  ).rows[0]
  assert.equal(member.owner_lock_version, 1)
})

test('disconnect releases the lifetime lock but never permits re-registering an old owner identity', async (t) => {
  const { db, peer, first, second, gate } = await fixture(t)
  await first._client.end()
  await gate.run(async () => {
    assert.deepEqual(await withTransaction(peer, () => second.lockAbsentOwner(first.ownerId)), { absent: true })
  })
  const duplicate = new GlobalMaintenanceCoordinator(db, { ownerId: first.ownerId })
  t.after(() => duplicate.stop())
  await assert.rejects(duplicate.start(), { code: '23505' })
})

test('upgrading old private members leaves legacy owners unproven without a version marker', async (t) => {
  const { peer, first, second, gate } = await fixture(t)
  await first.stop()
  await peer.pool.query(`ALTER TABLE ${first.qualified}.members DROP COLUMN owner_lock_version`)
  const fresh = new GlobalMaintenanceCoordinator(peer, { ownerId: 'new-protocol-owner' })
  t.after(() => fresh.stop().catch(() => {}))
  await fresh.start()
  const rows = (
    await peer.pool.query(`SELECT owner_id, owner_lock_version FROM ${first.qualified}.members ORDER BY owner_id`)
  ).rows
  assert.equal(rows.find((row) => row.owner_id === first.ownerId).owner_lock_version, null)
  assert.equal(rows.find((row) => row.owner_id === fresh.ownerId).owner_lock_version, 1)
  await gate.run(async () => {
    assert.deepEqual(await withTransaction(peer, () => second.lockAbsentOwner(first.ownerId)), {
      absent: false,
      reason: 'owner_protocol_unproven',
    })
  })
})

test('recovery seals only an exact supported request after its registered owner disconnects', async (t) => {
  const { db, peer, first, second, gate } = await fixture(t)
  const original = await parent(first, db, 'recoverable')
  await parent(first, db, 'unrelated')
  const { HaRequestRecovery } = await import('../../src/lib/core/ha-request-recovery.mjs')
  const recovery = new HaRequestRecovery(peer, { coordinator: second })
  await gate.run(async () => {
    assert.deepEqual(await recovery.seal('recoverable'), { sealed: false, reason: 'owner_connected' })
  })
  await first.stop()
  await gate.run(async () => {
    const result = await recovery.seal('recoverable')
    assert.equal(result.sealed, true)
    const row = await peer.prepare('SELECT * FROM ha_request_contexts WHERE id=$1').get('recoverable')
    assert.equal(row.activity_id, original.activityId)
    assert.equal(row.accepting_children, false)
    assert.equal(row.recovery_kind, 'claude_messages')
    assert.equal(row.recovery_sealed_by, second.ownerId)
    assert.ok(row.recovery_sealed_at)
    assert.equal(
      (await peer.prepare('SELECT recovery_sealed_at FROM ha_request_contexts WHERE id=$1').get('unrelated'))
        .recovery_sealed_at,
      null,
    )
  })
})

test('untyped legacy parents and stale epochs cannot be sealed from absent owner alone', async (t) => {
  const { db, peer, first, second, gate } = await fixture(t)
  await parent(first, db, 'legacy-parent', null)
  await parent(first, db, 'stale-parent')
  await peer.pool.query('UPDATE ha_request_contexts SET activity_epoch=2 WHERE id=$1', ['stale-parent'])
  await first.stop()
  const { HaRequestRecovery } = await import('../../src/lib/core/ha-request-recovery.mjs')
  const recovery = new HaRequestRecovery(peer, { coordinator: second })
  await gate.run(async () => {
    assert.deepEqual(await recovery.seal('legacy-parent'), { sealed: false, reason: 'request_kind_unproven' })
    assert.deepEqual(await recovery.seal('stale-parent'), { sealed: false, reason: 'request_activity_mismatch' })
    assert.equal(
      (await peer.prepare('SELECT count(*) AS n FROM ha_request_contexts WHERE recovery_sealed_at IS NOT NULL').get())
        .n,
      0,
    )
  })
})

test('original completed node proof recovers only exact execution, seat, turn and activity while billing stays held', async (t) => {
  const f = await fixture(t)
  const original = await graph(f, 'ended-request')
  const unrelated = await graph(f, 'still-unknown')
  await f.first.stop()
  const { HaRequestRecovery } = await import('../../src/lib/core/ha-request-recovery.mjs')
  const recovery = new HaRequestRecovery(f.peer, { coordinator: f.second })
  await f.gate.run(async () => {
    let calls = 0
    const outcome = await recovery.recover('ended-request', {
      readCompletion: async ({ requestId, nodeBinding }) => {
        calls++
        assert.equal(f.peer.isTransaction, false)
        assert.equal(requestId, original.commandId)
        assert.deepEqual(nodeBinding, original.nodeBinding)
        return completed(original)
      },
    })
    assert.equal(outcome.recovered, true)
    assert.equal(outcome.billingHeld, true)
    assert.equal(calls, 1)
    const lease = await f.peer
      .prepare('SELECT * FROM execution_admissions WHERE id=$1')
      .get(original.admission.admissionId)
    assert.ok(lease.released_at)
    assert.ok(lease.uncertain_at, 'historical uncertainty remains in the audit row')
    const seat = await f.peer
      .prepare('SELECT *,clock_timestamp() AS now FROM execution_seats WHERE seat_key=$1')
      .get(original.admission.seatKey)
    assert.ok(seat.grace_until > seat.now)
    assert.equal(
      (await f.peer.prepare('SELECT count(*) AS n FROM session_turns WHERE id=$1').get(original.turn.id)).n,
      0,
    )
    assert.ok(
      (
        await f.peer.query(`SELECT completed_at FROM ${f.second.qualified}.activities WHERE id=$1`, [
          original.activity.activityId,
        ])
      ).rows[0].completed_at,
    )
    assert.equal(
      (
        await f.peer
          .prepare('SELECT released_at FROM api_key_admissions WHERE id=$1')
          .get(original.keyLease.reservationId)
      ).released_at,
      null,
    )
    assert.equal(
      (
        await f.peer
          .prepare('SELECT released_at FROM execution_admissions WHERE id=$1')
          .get(unrelated.admission.admissionId)
      ).released_at,
      null,
    )
    assert.equal(
      (
        await f.peer.query(`SELECT completed_at FROM ${f.second.qualified}.activities WHERE id=$1`, [
          unrelated.activity.activityId,
        ])
      ).rows[0].completed_at,
      null,
    )
    const job = await f.peer.prepare('SELECT * FROM execution_jobs WHERE request_id=$1').get(original.commandId)
    assert.ok(job.ended_at)
    assert.deepEqual(job.node_completion, completed(original))
    assert.equal(
      (await f.peer.prepare('SELECT terminal_state FROM request_attempts WHERE ha_request_id=$1').get('ended-request'))
        .terminal_state,
      'started',
      'no usage/result is fabricated',
    )
  })
})

for (const scenario of ['notfound', 'pending', 'undispatched', 'different-command', 'different-fence']) {
  test(`recovery preserves all claims when original node proof is ${scenario}`, async (t) => {
    const f = await fixture(t)
    const original = await graph(f, 'unproven')
    await f.first.stop()
    const { HaRequestRecovery } = await import('../../src/lib/core/ha-request-recovery.mjs')
    const recovery = new HaRequestRecovery(f.peer, { coordinator: f.second })
    const proof = completed(original)
    if (scenario === 'pending') proof.status = 'pending'
    if (scenario === 'undispatched') proof.dispatched = false
    if (scenario === 'different-command') proof.id = 'new-command'
    if (scenario === 'different-fence') proof.fence = { ...proof.fence, incarnation: 'replacement-container' }
    await f.gate.run(async () => {
      const outcome = await recovery.recover('unproven', {
        readCompletion: async () => (scenario === 'notfound' ? null : proof),
      })
      assert.equal(outcome.recovered, false)
      assert.equal(
        (
          await f.peer
            .prepare('SELECT released_at FROM execution_admissions WHERE id=$1')
            .get(original.admission.admissionId)
        ).released_at,
        null,
      )
      assert.equal(
        (await f.peer.prepare('SELECT ended_at FROM execution_jobs WHERE request_id=$1').get(original.commandId))
          .ended_at,
        null,
      )
      assert.equal(
        (await f.peer.prepare('SELECT count(*) AS n FROM session_turns WHERE id=$1').get(original.turn.id)).n,
        1,
      )
      assert.equal(
        (
          await f.peer.query(`SELECT completed_at FROM ${f.second.qualified}.activities WHERE id=$1`, [
            original.activity.activityId,
          ])
        ).rows[0].completed_at,
        null,
      )
      assert.equal(
        (
          await f.peer
            .prepare('SELECT released_at FROM api_key_admissions WHERE id=$1')
            .get(original.keyLease.reservationId)
        ).released_at,
        null,
      )
    })
  })
}

test('sealed supported requests with no bound node jobs can release execution and turns without inventing usage', async (t) => {
  const f = await fixture(t)
  const original = await graph(f, 'never-bound', { withJob: false, graceMs: 0 })
  await f.first.stop()
  const { HaRequestRecovery } = await import('../../src/lib/core/ha-request-recovery.mjs')
  const recovery = new HaRequestRecovery(f.peer, { coordinator: f.second })
  await f.gate.run(async () => {
    const outcome = await recovery.recover('never-bound', {
      readCompletion: async () => assert.fail('no original node job'),
    })
    assert.equal(outcome.recovered, true)
    assert.equal(outcome.billingHeld, false)
    assert.ok(
      (
        await f.peer
          .prepare('SELECT released_at FROM execution_admissions WHERE id=$1')
          .get(original.admission.admissionId)
      ).released_at,
    )
    assert.equal(
      await f.peer.prepare('SELECT seat_key FROM execution_seats WHERE seat_key=$1').get(original.admission.seatKey),
      undefined,
    )
  })
})

test('concurrent recoveries are idempotent and cannot extend recovered seat grace on retry', async (t) => {
  const f = await fixture(t)
  const original = await graph(f, 'concurrent')
  await f.first.stop()
  const { HaRequestRecovery } = await import('../../src/lib/core/ha-request-recovery.mjs')
  const recovery = new HaRequestRecovery(f.peer, { coordinator: f.second })
  await f.gate.run(async () => {
    const options = { readCompletion: async () => completed(original) }
    const outcomes = await Promise.all([
      recovery.recover('concurrent', options),
      recovery.recover('concurrent', options),
    ])
    assert.equal(
      outcomes.every((outcome) => outcome.recovered === true),
      true,
    )
    const before = await f.peer
      .prepare('SELECT grace_until FROM execution_seats WHERE seat_key=$1')
      .get(original.admission.seatKey)
    const again = await recovery.recover('concurrent', {
      readCompletion: async () => assert.fail('already persisted original completion'),
    })
    assert.equal(again.recovered, true)
    assert.deepEqual(
      await f.peer.prepare('SELECT grace_until FROM execution_seats WHERE seat_key=$1').get(original.admission.seatKey),
      before,
    )
  })
})

test('SIGKILL of a synthetic owner process releases only its connection lock, with no timestamp timeout', async (t) => {
  const { spawn } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const f = await fixture(t)
  const child = spawn(process.execPath, [fileURLToPath(new URL('../fixtures/orphan-owner.mjs', import.meta.url))], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('synthetic owner readiness timeout')), 5000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('synthetic owner exited before readiness'))
    })
    child.once('message', (message) => {
      clearTimeout(timer)
      message.ready === true ? resolve() : reject(new Error('invalid readiness'))
    })
  })
  await f.gate.run(async () => {
    assert.deepEqual(await withTransaction(f.peer, () => f.second.lockAbsentOwner('synthetic-killed-owner')), {
      absent: false,
      reason: 'owner_connected',
    })
    const exited = new Promise((resolve) => child.once('exit', resolve))
    assert.equal(child.kill('SIGKILL'), true)
    await exited
    assert.deepEqual(await withTransaction(f.peer, () => f.second.lockAbsentOwner('synthetic-killed-owner')), {
      absent: true,
    })
  })
})

for (const heldBy of ['pending-billing', 'sealed-recovery', 'normal-finished']) {
  test(`execution history cleanup preserves original proof for ${heldBy}`, async (t) => {
    const f = await fixture(t)
    const original = await graph(f, 'old-history')
    await f.first.stop()
    const { HaRequestRecovery } = await import('../../src/lib/core/ha-request-recovery.mjs')
    const recovery = new HaRequestRecovery(f.peer, { coordinator: f.second })
    await f.gate.run(async () => {
      if (heldBy === 'pending-billing') {
        assert.equal(
          (await recovery.recover('old-history', { readCompletion: async () => completed(original) })).recovered,
          true,
        )
      } else {
        if (heldBy === 'sealed-recovery') assert.equal((await recovery.seal('old-history')).sealed, true)
        await f.peer
          .prepare('UPDATE execution_jobs SET ended_at=clock_timestamp(),node_completion=$2::jsonb WHERE request_id=$1')
          .run(original.commandId, JSON.stringify(completed(original)))
        await f.peer
          .prepare('UPDATE execution_admissions SET released_at=clock_timestamp() WHERE id=$1')
          .run(original.admission.admissionId)
        await f.peer
          .prepare('UPDATE api_key_admissions SET released_at=clock_timestamp() WHERE id=$1')
          .run(original.keyLease.reservationId)
      }
      await f.peer
        .prepare("UPDATE execution_admissions SET created_at=clock_timestamp()-interval '2 minutes' WHERE id=$1")
        .run(original.admission.admissionId)
      await withHaRequestContext({ db: f.peer, requestId: 'fresh-request', activity: f.gate }, async () => {
        const lease = await new ExecutionAdmissionsRepo(f.peer).tryReserve({
          accountId: 'fixture-account',
          vmId: 'vm-fixture',
          accountLimit: 10,
          vmLimit: 10,
          fableLimit: 0,
          rpmLimit: 0,
        })
        assert.equal(lease.ok, true)
        await lease.release()
      })
      const job = await f.peer.prepare('SELECT * FROM execution_jobs WHERE request_id=$1').get(original.commandId)
      if (heldBy === 'normal-finished') assert.equal(job, undefined)
      else
        assert.deepEqual(job?.node_completion, completed(original), 'the only durable node proof must survive cleanup')
    })
  })
}
