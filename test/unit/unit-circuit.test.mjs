import test from 'node:test'
import assert from 'node:assert/strict'
import { UnitCircuit } from '../../src/lib/pool/unit-circuit.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'

test('half-open admits one probe and holds the rest', () => {
  let now = 1_000
  const circuit = new UnitCircuit({ failureThreshold: 2, openMs: 500, now: () => now })
  circuit.recordFailure('vm-a', now)
  circuit.recordFailure('vm-a', now)
  assert.equal(circuit.admit('vm-a', now).ok, false)
  now = 1_600
  const probe = circuit.admit('vm-a', now)
  assert.equal(probe.ok, true)
  assert.equal(probe.probe, true)
  const blocked = circuit.admit('vm-a', now)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'circuit_probe')
  circuit.recordSuccess('vm-a')
  assert.equal(circuit.admit('vm-a', now).state, 'closed')
})

test('inspect does not consume the half-open probe', () => {
  let now = 1_000
  const circuit = new UnitCircuit({ failureThreshold: 1, openMs: 100, now: () => now })
  circuit.recordFailure('vm-c', now)
  now = 1_200
  assert.equal(circuit.inspect('vm-c', now).probeAvailable, true)
  assert.equal(circuit.inspect('vm-c', now).probeAvailable, true)
  assert.equal(circuit.admit('vm-c', now).probe, true)
  assert.equal(circuit.inspect('vm-c', now).reason, 'circuit_probe')
})

test('model-style failures are not required to open the circuit', () => {
  const circuit = new UnitCircuit({ failureThreshold: 1, openMs: 1000, now: () => 10 })
  assert.equal(circuit.admit('vm-b').ok, true)
  assert.equal(circuit.snapshot('vm-b').state, 'closed')
})

test('a session keeps its VM slot and a busy seat rejects the next session', () => {
  const scheduler = new PoolScheduler({ projectRoot: 'x:/unused', config: { default_session_slots: 1 } })
  const first = scheduler.acquireSlot('vm-1', 'session-a', 1)
  assert.equal(first.index, 0)
  assert.equal(scheduler.acquireSlot('vm-1', 'session-a', 1), null)
  assert.equal(scheduler.acquireSlot('vm-1', 'session-b', 1), null)
  scheduler.releaseSlotHold('vm-1', first.holdKey)
  const again = scheduler.acquireSlot('vm-1', 'session-a', 1)
  assert.equal(again.index, 0)
  scheduler.releaseSlotHold('vm-1', again.holdKey)
  const second = scheduler.acquireSlot('vm-1', 'session-b', 1)
  assert.equal(second.index, 0)
})

test('request release keeps the session decision and frees the inflight seat', () => {
  const scheduler = new PoolScheduler({ projectRoot: 'x:/unused', config: {} })
  const session = scheduler.reserve(
    { accountId: 'acc', vmId: 'vm-1', maxConcurrency: 2, sessionSlots: 2, model: 'claude' },
    { sessionKey: 'conversation' },
  )
  assert.equal(session.slotIndex, 0)
  session.release()
  assert.equal(scheduler.assignedSlot('vm-1', 'conversation'), 0)
  assert.equal(scheduler.usedSlotCount('vm-1'), 0)
  const anon = scheduler.reserve(
    { accountId: 'acc', vmId: 'vm-1', maxConcurrency: 2, sessionSlots: 2, model: 'claude' },
    {},
  )
  assert.equal(typeof anon.slotIndex, 'number')
  anon.release()
  assert.equal(scheduler.usedSlotCount('vm-1'), 0)
  assert.equal(scheduler.assignedSlot('vm-1', 'conversation'), 0)
})

test('reset closes an open unit and view reports state', () => {
  let now = 1_000
  const circuit = new UnitCircuit({ failureThreshold: 2, openMs: 500, now: () => now })
  circuit.recordFailure('vm-r', now)
  assert.deepEqual(circuit.view('vm-r', now), {
    state: 'closed',
    failures: 1,
    threshold: 2,
    open_until: null,
    open_ms: 500,
  })
  circuit.recordFailure('vm-r', now)
  assert.equal(circuit.view('vm-r', now).state, 'open')
  assert.equal(circuit.view('vm-r', now).open_until, 1_500)
  now = 1_600
  assert.equal(circuit.view('vm-r', now).state, 'half_open')
  circuit.reset('vm-r')
  assert.equal(circuit.view('vm-r', now).state, 'closed')
  assert.equal(circuit.view('vm-r', now).failures, 0)
  assert.equal(circuit.admit('vm-r', now).state, 'closed')
})
