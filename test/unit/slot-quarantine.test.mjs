import test from 'node:test'
import assert from 'node:assert/strict'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'

test('a failed slot stays out until the CLI restart clears it', () => {
  const pool = new PoolScheduler({})
  const held = pool.acquireSlot('vm-01', 'sess', 20)
  assert.equal(held.index, 0)
  assert.equal(pool.markSlotUnavailable('vm-01', 0), true)
  pool.releaseSlotHold('vm-01', held.holdKey)
  const moved = pool.acquireSlot('vm-01', 'sess', 20)
  assert.equal(moved.index, 1)
  pool.releaseSlotHold('vm-01', moved.holdKey)
  assert.equal(pool.slotsExhausted('vm-01', 20), false)
  pool.markSlotUnavailable('vm-01', 1)
  assert.equal(pool.badSlotCount('vm-01'), 2)
  assert.equal(pool.acquireSlot('vm-01', 'other', 2), null)
  assert.equal(pool.slotsExhausted('vm-01', 2), true)
  pool.clearSlotFaults('vm-01')
  const again = pool.acquireSlot('vm-01', 'fresh', 20)
  assert.equal(again.index, 0)
})
