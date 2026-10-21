import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb, createDatabase } from '../../src/lib/db/database.mjs'
import { ControlPlaneLock } from '../../src/lib/db/control-plane-lock.mjs'

test('a one-connection pool rejects control-plane startup without consuming the business connection', async () => {
  const db = getDb()
  const single = await createDatabase({ connectionString: db.connectionString, schema: db.schema + '_single', max: 1 })
  const lock = new ControlPlaneLock(single)
  try {
    await assert.rejects(lock.start(), {
      code: 'control_plane_pool_too_small',
      message: 'Control-plane mode requires a PostgreSQL connection pool with at least 2 connections',
    })
    assert.equal(lock.healthy, false)
    assert.equal(single.pool.totalCount, single.pool.idleCount)
    assert.equal((await single.prepare('SELECT 1 AS n').get()).n, 1)
  } finally {
    await lock.stop()
    await single.close()
  }
})

test('one controller owns each database and schema until explicit stop', async () => {
  const db = getDb()
  let lost = 0
  const first = new ControlPlaneLock(db, {
    onLost: () => {
      lost += 1
    },
  })
  const second = new ControlPlaneLock(db)
  try {
    assert.equal(first.healthy, false)
    assert.equal(await first.start(), first)
    assert.equal(first.healthy, true)
    await Promise.all([first.start(), first.start()])
    await assert.rejects(second.start(), { code: 'control_plane_already_active' })
    assert.equal(second.healthy, false)
    await first.stop()
    await first.stop()
    assert.equal(first.healthy, false)
    assert.equal(lost, 0)
    await second.start()
    assert.equal(second.healthy, true)
  } finally {
    await first.stop()
    await second.stop()
  }
})

test('independent schemas do not block each other and stop releases the pool client', async () => {
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema + '_other', max: 1 })
  const first = new ControlPlaneLock(db)
  const second = new ControlPlaneLock(other)
  try {
    await Promise.all([first.start(), second.start()])
    assert.equal(first.healthy, true)
    assert.equal(second.healthy, true)
    await second.stop()
    assert.equal((await other.prepare('SELECT 1 AS n').get()).n, 1)
    await other.close()
  } finally {
    await first.stop()
    await second.stop()
    await other.close()
  }
})

test('a terminated lock connection fails closed and reports loss only once', async () => {
  const db = getDb()
  let signalLost
  const lost = new Promise((resolve) => {
    signalLost = resolve
  })
  let calls = 0
  const lock = new ControlPlaneLock(db, {
    onLost: (error) => {
      calls += 1
      signalLost(error)
    },
  })
  try {
    await lock.start()
    const ended = new Promise((resolve) => lock._client.once('end', resolve))
    const pid = lock._client.processID
    assert.equal((await db.prepare('SELECT pg_terminate_backend($1) AS terminated').get(pid)).terminated, true)
    await lost
    await ended
    assert.equal(lock.healthy, false)
    assert.equal(calls, 1)
    await assert.rejects(lock.start(), { code: 'control_plane_lock_lost' })
    await lock.stop()
    assert.equal(calls, 1)
  } finally {
    await lock.stop()
  }
})
