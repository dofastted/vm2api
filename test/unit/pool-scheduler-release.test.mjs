import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { getDb } from '../../src/lib/db/database.mjs'
import { SharedExecutionAdmissions } from '../../src/lib/pool/shared-execution-admissions.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'

function gate() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function reservation(t, { seat = false } = {}) {
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(() => {
    if (previous == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
  })
  const db = getDb()
  const service = new SharedExecutionAdmissions(db)
  const pool = new PoolScheduler({
    projectRoot: '/tmp',
    executionAdmissions: service,
    config: { seat_grace_ms: 0 },
    accountQuota: {
      canAccept: () => ({ ok: true }),
      limitFor: () => 2,
      policyFor: () => ({}),
      rpmLimitFor: () => 0,
    },
  })
  pool.unitCircuit = null
  const candidate = {
    accountId: 'release-account',
    vmId: 'release-vm',
    model: 'claude-test',
    maxConcurrency: 2,
    seatCap: 2,
    headroom: null,
    account: {},
    vm: { policy: { maxConcurrency: 2 } },
  }
  const selected = seat
    ? (await pool.claimSeatShared('release-seat', candidate, 'test')).reservation
    : await pool.reserve(candidate)
  const row = () => db.prepare('SELECT * FROM execution_admissions WHERE id = $1').get(selected.admissionId)
  return { db, service, pool, selected, row }
}

test('a rolled-back PostgreSQL release can be retried through the scheduler reservation', async (t) => {
  const { db, service, pool, selected, row } = await reservation(t)
  await db.exec(`CREATE FUNCTION refuse_scheduler_release() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.released_at IS NOT NULL THEN RAISE EXCEPTION 'synthetic release failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER refuse_scheduler_release BEFORE UPDATE ON execution_admissions
    FOR EACH ROW EXECUTE FUNCTION refuse_scheduler_release()`)
  try {
    await assert.rejects(selected.release(), { code: 'P0001' })
    assert.equal((await row()).released_at, null)
    assert.equal(pool.inflight.get('release-account'), 1)
    await db.exec('DROP TRIGGER refuse_scheduler_release ON execution_admissions')
    await assert.doesNotReject(selected.release())
    assert.ok((await row()).released_at)
    assert.equal(pool.inflight.has('release-account'), false)
    await selected.release()
    assert.equal(pool.vmInflight.has('release-vm'), false)
  } finally {
    await db.exec('DROP TRIGGER IF EXISTS refuse_scheduler_release ON execution_admissions')
    await service.release(selected)
  }
})

test('a PostgreSQL refusal to release preserves local counters and allows a later retry', async (t) => {
  const { db, service, pool, selected, row } = await reservation(t, { seat: true })
  await db.exec(`CREATE FUNCTION skip_scheduler_release() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.released_at IS NOT NULL THEN RETURN NULL; END IF; RETURN NEW; END $$;
    CREATE TRIGGER skip_scheduler_release BEFORE UPDATE ON execution_admissions
    FOR EACH ROW EXECUTE FUNCTION skip_scheduler_release()`)
  try {
    await selected.release()
    assert.equal((await row()).released_at, null)
    assert.equal(pool.inflight.get('release-account'), 1)
    assert.equal(pool.vmInflight.get('release-vm'), 1)
    assert.equal(pool.planner.seatOf('release-seat').inflight, 1)
    await db.exec('DROP TRIGGER skip_scheduler_release ON execution_admissions')
    await selected.release()
    assert.ok((await row()).released_at)
    assert.equal(pool.inflight.has('release-account'), false)
    assert.equal(pool.vmInflight.has('release-vm'), false)
    assert.equal(pool.planner.seatOf('release-seat'), null)
  } finally {
    await db.exec('DROP TRIGGER IF EXISTS skip_scheduler_release ON execution_admissions')
    await service.release(selected)
  }
})

test('release waits for an already requested uncertainty mark and retains PostgreSQL capacity', async (t) => {
  const { db, pool, selected, row } = await reservation(t)
  const entered = gate()
  const finishMark = gate()
  const query = db.query
  db.query = async function (sql, params) {
    if (sql.includes('UPDATE execution_admissions SET uncertain_at')) {
      entered.resolve()
      await finishMark.promise
    }
    return query.call(this, sql, params)
  }
  const marking = selected.markUncertain()
  await entered.promise
  let releaseSettled = false
  const releasing = selected.release().then(() => {
    releaseSettled = true
  })
  try {
    assert.equal(selected.uncertain, true, 'uncertainty is conservative as soon as marking is requested')
    await setImmediate()
    assert.equal(releaseSettled, false)
    assert.equal((await row()).released_at, null)
  } finally {
    finishMark.resolve()
    await Promise.all([marking, releasing])
    db.query = query
  }
  const stored = await row()
  assert.ok(stored.uncertain_at)
  assert.equal(stored.released_at, null)
  assert.equal(pool.inflight.get('release-account'), 1)
  assert.equal(pool.vmInflight.get('release-vm'), 1)
})

test('a failed uncertainty mark is retried instead of falling back to ordinary release', async (t) => {
  const { db, pool, selected, row } = await reservation(t)
  await db.exec(`CREATE FUNCTION refuse_scheduler_uncertainty() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.uncertain_at IS NOT NULL THEN RAISE EXCEPTION 'synthetic uncertainty failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER refuse_scheduler_uncertainty BEFORE UPDATE ON execution_admissions
    FOR EACH ROW EXECUTE FUNCTION refuse_scheduler_uncertainty()`)
  try {
    await assert.rejects(selected.markUncertain(), { code: 'P0001' })
    assert.equal(selected.uncertain, true)
    await db.exec('DROP TRIGGER refuse_scheduler_uncertainty ON execution_admissions')
    await selected.release()
    const stored = await row()
    assert.ok(stored.uncertain_at)
    assert.equal(stored.released_at, null)
    assert.equal(pool.inflight.get('release-account'), 1)
  } finally {
    await db.exec('DROP TRIGGER IF EXISTS refuse_scheduler_uncertainty ON execution_admissions')
  }
})

test('concurrent and repeated releases update PostgreSQL and local counters once', async (t) => {
  const { service, pool, selected, row } = await reservation(t)
  const release = service.executions.release.bind(service.executions)
  let calls = 0
  service.executions.release = async (...args) => {
    calls++
    return release(...args)
  }
  await Promise.all([selected.release(), selected.release()])
  const releasedAt = (await row()).released_at
  await selected.release()
  assert.ok(releasedAt)
  assert.deepEqual((await row()).released_at, releasedAt)
  assert.equal(calls, 1)
  assert.equal(pool.inflight.has('release-account'), false)
  assert.equal(pool.vmInflight.has('release-vm'), false)
})
