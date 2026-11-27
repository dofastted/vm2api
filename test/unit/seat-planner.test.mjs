import test from 'node:test'
import assert from 'node:assert/strict'
import { PoolScheduler, normalizePoolRouting } from '../../src/lib/pool/pool-scheduler.mjs'
import { SeatPlanner, budgetAllows, rankSeatCandidates } from '../../src/lib/pool/seat-planner.mjs'

test('budget gate: 5% headroom, 2% reserve, 2 open seats blocks new seats on SeatPlanner', () => {
  assert.equal(budgetAllows(0.05, 2, 0.02), false)
  assert.equal(budgetAllows(0.05, 1, 0.02), true)
  assert.equal(budgetAllows(null, 9, 0.02), true)
  const planner = new SeatPlanner({ reservePct: 0.02 })
  planner.open('a', { vmId: 'vm-1', cap: 4 })
  assert.equal(planner.canOpen('vm-1', 4, 0.05), true)
  planner.open('b', { vmId: 'vm-1', cap: 4 })
  assert.equal(planner.canOpen('vm-1', 4, 0.05), false)
})

test('rankSeatCandidates orders by priority, balanced/fill occupancy, headroom, then vmId', () => {
  const openOf = () => 0
  const tie = [
    { vmId: 'vm-a', seatCap: 4, headroom: 0.3 },
    { vmId: 'vm-b', seatCap: 4, headroom: 0.5 },
  ]
  assert.equal(rankSeatCandidates(tie, { strategy: 'balanced', openOf })[0].vmId, 'vm-b')
  assert.equal(rankSeatCandidates(tie, { strategy: 'fill', openOf })[0].vmId, 'vm-b')
  const prio = [{ ...tie[0], priority: 9 }, tie[1]]
  assert.equal(rankSeatCandidates(prio, { strategy: 'balanced', openOf })[0].vmId, 'vm-a')
  const even = [
    { vmId: 'vm-b', seatCap: 4, headroom: 0.4 },
    { vmId: 'vm-a', seatCap: 4, headroom: 0.4 },
  ]
  assert.equal(rankSeatCandidates(even, { strategy: 'balanced', openOf })[0].vmId, 'vm-a')
})

test('pool routing normalization: queue_max clamps, legacy strategy, dropped per-account cap', () => {
  assert.equal(normalizePoolRouting({}).queue_max, 50)
  assert.equal(normalizePoolRouting({ queue_max: 0 }).queue_max, 1)
  assert.equal(normalizePoolRouting({ queue_max: 1000 }).queue_max, 999)
  for (const legacy of ['weighted-round-robin', 'round-robin', 'lru', 'fill-first', 'nope']) {
    assert.equal(normalizePoolRouting({ strategy: legacy }).strategy, 'balanced')
  }
  assert.equal(normalizePoolRouting({ strategy: 'fill' }).strategy, 'fill')
  const next = normalizePoolRouting({
    max_waiters_per_account: 100,
    seat_grace_ms: 999999,
    seat_budget_reserve_pct: 0.9,
  })
  assert.equal(Object.hasOwn(next, 'max_waiters_per_account'), false)
  assert.equal(next.seat_grace_ms, 120000)
  assert.equal(next.seat_budget_reserve_pct, 0.5)
  assert.equal(normalizePoolRouting({}).seat_budget_reserve_pct, 0.02)
})

test('M3 cutover (D4): PoolScheduler does not instantiate legacy Node SeatPlanner', () => {
  const pool = new PoolScheduler({ projectRoot: '/tmp/nonexistent-m3-seat-check' })
  assert.equal(pool.planner, undefined)
})
