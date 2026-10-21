import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'

async function replicas(t) {
  const { SharedExecutionAdmissions } = await import('../../src/lib/pool/shared-execution-admissions.mjs')
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => other.close())
  return [new SharedExecutionAdmissions(db, { ownerId: 'a' }), new SharedExecutionAdmissions(other, { ownerId: 'b' })]
}

function candidate(patch = {}) {
  return {
    accountId: 'account-1',
    vmId: 'vm-1',
    accountLimit: 20,
    vmLimit: 20,
    rpmLimit: 0,
    fableLimit: 0,
    seatKey: 'platform|device-1',
    seatCap: 2,
    seatGraceMs: 0,
    seatReservePct: 0.02,
    seatHeadroom: null,
    ...patch,
  }
}

test('one device cannot split across VMs on two controllers and shares its global slot index', async (t) => {
  const [first, second] = await replicas(t)
  const gates = await Promise.all([first.tryReserve(candidate()), second.tryReserve(candidate({ vmId: 'vm-2' }))])
  assert.equal(gates.filter((gate) => gate.ok).length, 1)
  const held = gates.find((gate) => gate.ok)
  const denied = gates.find((gate) => !gate.ok)
  assert.equal(denied.code, 'device_seat_bound')
  assert.equal(denied.vmId, held.vmId)
  const another = await second.tryReserve(candidate({ vmId: held.vmId }))
  assert.equal(another.ok, true)
  assert.equal(another.slotIndex, held.slotIndex)
  assert.equal(another.seatGeneration, held.seatGeneration)
  assert.equal((await first.getSeat(candidate().seatKey)).inflight, 2)
  await held.release()
  assert.equal((await second.getSeat(candidate().seatKey)).inflight, 1)
  await another.release()
  assert.equal(await first.getSeat(candidate().seatKey), null)
})

test('seat capacity is atomic across devices and denied seats consume no account RPM', async (t) => {
  const controllers = await replicas(t)
  const gates = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      controllers[i % 2].tryReserve(candidate({ seatKey: `device-${i}`, seatCap: 1 })),
    ),
  )
  assert.equal(gates.filter((gate) => gate.ok).length, 1)
  assert.ok(gates.filter((gate) => !gate.ok).every((gate) => gate.code === 'seat_limit'))
  assert.equal((await getDb().prepare('SELECT count(*) AS n FROM execution_admissions').get()).n, 1)
  await gates.find((gate) => gate.ok).release()
})

test('global seat indexes are distinct and a stale release cannot affect a newer generation', async (t) => {
  const [first, second] = await replicas(t)
  const a = await first.tryReserve(candidate())
  const b = await second.tryReserve(candidate({ seatKey: 'device-2' }))
  assert.deepEqual(new Set([a.slotIndex, b.slotIndex]), new Set([0, 1]))
  await a.release()
  const next = await second.tryReserve(candidate())
  assert.equal(next.slotIndex, a.slotIndex)
  assert.notEqual(next.seatGeneration, a.seatGeneration)
  await a.release()
  assert.equal((await first.getSeat(candidate().seatKey)).inflight, 1)
  await next.release()
  await b.release()
})

test('grace starts only after the last shared request ends and active seats cannot move', async (t) => {
  const [first, second] = await replicas(t)
  const a = await first.tryReserve(candidate({ seatGraceMs: 1000 }))
  const b = await second.tryReserve(candidate({ seatGraceMs: 1000 }))
  await a.release()
  assert.equal((await first.getSeat(candidate().seatKey)).graceUntil, null)
  const denied = await second.tryReserve(candidate({ vmId: 'vm-2', moveSeat: true }))
  assert.equal(denied.code, 'device_seat_bound')
  await b.release()
  const grace = await first.getSeat(candidate().seatKey)
  assert.equal(grace.inflight, 0)
  assert.ok(grace.graceUntil > Date.now())
  assert.equal((await second.tryReserve(candidate({ vmId: 'vm-2' }))).code, 'device_seat_bound')
  await getDb().prepare("UPDATE execution_seats SET grace_until = clock_timestamp() - interval '1 second'").run()
  const moved = await second.tryReserve(candidate({ vmId: 'vm-2' }))
  assert.equal(moved.ok, true)
  assert.notEqual(moved.seatGeneration, grace.generation)
  await moved.release()
})

test('new device budget uses global seat occupancy and existing devices need no new seat budget', async (t) => {
  const [first, second] = await replicas(t)
  const a = await first.tryReserve(candidate({ seatHeadroom: 0.03 }))
  assert.equal(a.ok, true)
  const denied = await second.tryReserve(candidate({ seatKey: 'device-2', seatHeadroom: 0.03 }))
  assert.equal(denied.code, 'seat_budget')
  const same = await second.tryReserve(candidate({ seatHeadroom: 0 }))
  assert.equal(same.ok, true)
  const next = await second.tryReserve(candidate({ seatKey: 'device-2', seatHeadroom: 0.04 }))
  assert.equal(next.ok, true)
  await Promise.all([a.release(), same.release(), next.release()])
})

test('an uncertain execution keeps its device and VM capacity after release and expiry', async (t) => {
  const [first, second] = await replicas(t)
  const gate = await first.tryReserve(candidate({ vmLimit: 1 }))
  await gate.markUncertain()
  await gate.release()
  await getDb().prepare("UPDATE execution_seats SET grace_until = clock_timestamp() - interval '1 hour'").run()
  assert.equal((await second.getSeat(candidate().seatKey)).inflight, 1)
  assert.equal((await second.tryReserve(candidate({ seatKey: 'device-2', vmLimit: 1 }))).code, 'vm_concurrency_limit')
  assert.equal((await second.tryReserve(candidate({ vmId: 'vm-2', moveSeat: true }))).code, 'device_seat_bound')
})

test('seat release and execution release roll back together and can be retried', async (t) => {
  const [first] = await replicas(t)
  const gate = await first.tryReserve(candidate({ seatGraceMs: 1000 }))
  await getDb().exec(`CREATE FUNCTION refuse_seat_release() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.grace_until IS NOT NULL THEN RAISE EXCEPTION 'synthetic release failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER refuse_seat_release BEFORE UPDATE ON execution_seats FOR EACH ROW EXECUTE FUNCTION refuse_seat_release()`)
  await assert.rejects(gate.release())
  assert.equal((await first.getSeat(candidate().seatKey)).inflight, 1)
  await getDb().exec('DROP TRIGGER refuse_seat_release ON execution_seats')
  await gate.release()
  assert.equal((await first.getSeat(candidate().seatKey)).inflight, 0)
})
