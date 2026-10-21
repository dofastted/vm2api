import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { getDb, quoteIdentifier, registerActivityCoordinator, withTransaction } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator, coordinationSchemaFor } from '../../src/lib/db/global-maintenance.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
import { withHaRequestContext } from '../../src/lib/core/ha-request-context.mjs'

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
