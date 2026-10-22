import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { getDb, quoteIdentifier, registerActivityCoordinator } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
import { createHaRecoveryMonitor } from '../../src/lib/core/ha-recovery-monitor.mjs'

async function fixture(t) {
  const db = getDb()
  const peer = await createRepositoryTestDatabase({ connectionString: db.connectionString, schema: db.schema })
  const coordinator = new GlobalMaintenanceCoordinator(db, { ownerId: 'scan-recovering-owner' })
  const original = new GlobalMaintenanceCoordinator(peer, { ownerId: 'original-scanner' })
  await coordinator.start()
  await original.start()
  registerActivityCoordinator(db, coordinator)
  registerActivityCoordinator(peer, original)
  await coordinator.acknowledgeEpoch(1)
  await original.acknowledgeEpoch(1)
  t.after(async () => {
    await Promise.allSettled([coordinator.stop(), original.stop()])
    const cleanup = new pg.Client({ connectionString: db.connectionString })
    await cleanup.connect()
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinator.schema)} CASCADE`)
    } finally {
      await cleanup.end()
    }
    await peer.close()
  })
  const monitor = createHaRecoveryMonitor({
    db,
    coordinator,
    readNodeRecoveryStatus: async () => assert.fail('no node command exists'),
  })
  t.after(() => monitor.stop())
  return { db, peer, coordinator, original, monitor }
}

async function killedScanner(t) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../fixtures/orphan-recovery-scan.mjs', import.meta.url))],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  )
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  const identity = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('synthetic scanner readiness timeout')), 5000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('synthetic scanner exited before readiness'))
    })
    child.once('message', (message) => {
      clearTimeout(timer)
      message.ready ? resolve(message) : reject(new Error('invalid readiness'))
    })
  })
  return {
    ...identity,
    kill: async () => {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGKILL')
      await exited
    },
  }
}

async function row(f, activityId) {
  return (await f.db.pool.query(`SELECT * FROM ${f.coordinator.qualified}.activities WHERE id=$1`, [activityId]))
    .rows[0]
}

async function failedMaintenance(f) {
  await assert.rejects(f.coordinator.beginMaintenance({ kind: 'backup', timeoutMs: 2000 }), {
    code: 'maintenance_claims_active',
  })
  await f.coordinator.cancelDrain((await f.coordinator.getState()).operationId)
}

test('SIGKILL leaves an unrecoverable scanner claim until another real monitor completes only that read-only activity', async (t) => {
  const f = await fixture(t)
  const child = await killedScanner(t)
  await f.monitor.runOnce()
  assert.equal((await row(f, child.activityId)).completed_at, null)
  await child.kill()
  await failedMaintenance(f)
  await f.monitor.runOnce()
  const ended = await row(f, child.activityId)
  assert.ok(ended.completed_at, 'the killed scanner must not permanently block maintenance')
  assert.equal(ended.reason, 'ha_recovery_scan_owner_lost')
  assert.equal(ended.uncertain_at, null)
  await f.monitor.runOnce()
  assert.deepEqual((await row(f, child.activityId)).completed_at, ended.completed_at)
  const own = (
    await f.db.pool.query(`SELECT * FROM ${f.coordinator.qualified}.activities WHERE owner_id=$1`, [
      f.coordinator.ownerId,
    ])
  ).rows
  assert.equal(own.length, 3)
  assert.ok(own.every((activity) => activity.completed_at && !activity.uncertain_at))
  const maintenance = await f.coordinator.beginMaintenance({ kind: 'backup', timeoutMs: 2000 })
  try {
    await maintenance.resume()
  } finally {
    await maintenance.close()
  }
})

test('scanner recovery never completes another unknown activity or releases a business claim of the same killed owner', async (t) => {
  const f = await fixture(t)
  const child = await killedScanner(t)
  await f.db.pool.query(
    `INSERT INTO ${f.coordinator.qualified}.activities(id,owner_id,epoch,kind,uncertain_at) VALUES('synthetic-business',$1,1,'api_endpoint',clock_timestamp())`,
    [child.ownerId],
  )
  await f.db.pool.query(
    "INSERT INTO api_key_admissions(id,key_id,owner_id) VALUES('synthetic-held-key','synthetic-key',$1)",
    [child.ownerId],
  )
  await child.kill()
  await f.monitor.runOnce()
  assert.ok((await row(f, child.activityId)).completed_at)
  const business = await row(f, 'synthetic-business')
  assert.equal(business.completed_at, null)
  assert.ok(business.uncertain_at)
  assert.equal(
    (await f.db.pool.query("SELECT released_at FROM api_key_admissions WHERE id='synthetic-held-key'")).rows[0]
      .released_at,
    null,
  )
  await failedMaintenance(f)
})

for (const condition of ['legacy_owner', 'other_epoch', 'parent', 'handoff', 'business_kind']) {
  test(`scanner recovery retains the exact activity when ${condition} prevents its proof`, async (t) => {
    const f = await fixture(t)
    const gate = await f.original.admit({
      kind: condition === 'business_kind' ? 'orphan_recovery' : 'ha_request_recovery',
    })
    await gate.complete({ ended: false, reason: 'synthetic_owner_loss' })
    if (condition === 'legacy_owner')
      await f.db.pool.query(`UPDATE ${f.coordinator.qualified}.members SET owner_lock_version=NULL WHERE owner_id=$1`, [
        gate.ownerId,
      ])
    if (condition === 'other_epoch')
      await f.db.pool.query(`UPDATE ${f.coordinator.qualified}.activities SET epoch=2 WHERE id=$1`, [gate.activityId])
    if (condition === 'parent')
      await f.db.pool.query(
        "INSERT INTO ha_request_contexts(id,activity_id,activity_owner_id,activity_epoch) VALUES('synthetic-parent',$1,$2,1)",
        [gate.activityId, gate.ownerId],
      )
    if (condition === 'handoff')
      await f.db.pool.query(
        `INSERT INTO ${f.coordinator.qualified}.operations(id,owner_id,kind,source_activity_id) VALUES('synthetic-handoff',$1,'backup',$2)`,
        [gate.ownerId, gate.activityId],
      )
    await f.original.stop()
    await f.monitor.runOnce()
    assert.equal((await row(f, gate.activityId)).completed_at, null)
    assert.equal((await row(f, gate.activityId)).reason, 'synthetic_owner_loss')
  })
}

test('one scanner page does not let twenty connected owners hide the next orphan page', async (t) => {
  const f = await fixture(t)
  for (let index = 0; index < 20; index++) {
    const gate = await f.original.admit({ kind: 'ha_request_recovery' })
    await f.db.pool.query(`UPDATE ${f.coordinator.qualified}.activities SET id=$2 WHERE id=$1`, [
      gate.activityId,
      `a-live-${String(index).padStart(2, '0')}`,
    ])
  }
  await f.db.pool.query(
    `INSERT INTO ${f.coordinator.qualified}.members(owner_id,owner_lock_version,bound_epoch) VALUES('synthetic-dead-scanner',1,1)`,
  )
  await f.db.pool.query(
    `INSERT INTO ${f.coordinator.qualified}.activities(id,owner_id,epoch,kind) VALUES('z-orphan','synthetic-dead-scanner',1,'ha_request_recovery')`,
  )
  await f.monitor.runOnce()
  assert.equal((await row(f, 'z-orphan')).completed_at, null)
  await f.monitor.runOnce()
  assert.ok((await row(f, 'z-orphan')).completed_at)
  const live = (
    await f.db.pool.query(`SELECT completed_at FROM ${f.coordinator.qualified}.activities WHERE id LIKE 'a-live-%'`)
  ).rows
  assert.equal(live.length, 20)
  assert.ok(live.every((activity) => !activity.completed_at))
})

test('concurrent scanner sweep transactions complete one exact row once and reject calls without an activity', async (t) => {
  const f = await fixture(t)
  const original = await f.original.admit({ kind: 'ha_request_recovery' })
  await original.complete({ ended: false, reason: 'synthetic_owner_loss' })
  await f.original.stop()
  await assert.rejects(f.coordinator.recoverHaRecoveryScans(), { code: 'maintenance_activity_closed' })
  const recover = () =>
    f.coordinator.runActivity({ kind: 'ha_request_recovery' }, async () => ({
      ended: true,
      value: await f.coordinator.recoverHaRecoveryScans(),
    }))
  const results = await Promise.all([recover(), recover()])
  assert.equal(results.flatMap((page) => page.results).filter((result) => result.recovered).length, 1)
  const ended = await row(f, original.activityId)
  assert.ok(ended.completed_at)
  assert.ok(ended.uncertain_at)
  assert.deepEqual((await recover()).results, [])
  assert.deepEqual((await row(f, original.activityId)).completed_at, ended.completed_at)
})
