import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BatchGroups,
  batchGroupAppliesToKey,
  batchGroupKey,
  batchMemberSeatKey,
  isBatchMemberKey,
  mergeBatchGroupConfig,
} from '../../src/lib/pool/batch-group.mjs'

const cfg = (over = {}) => mergeBatchGroupConfig({ enabled: true, keys: ['k1'], per_member_concurrency: 2, ...over })
const HASH = 'a'.repeat(64)

test('config defaults are off and clamp bad values', () => {
  const c = mergeBatchGroupConfig(undefined)
  assert.equal(c.enabled, false)
  assert.equal(c.max, 0)
  assert.equal(mergeBatchGroupConfig({ per_member_concurrency: 0 }).per_member_concurrency, 3)
  assert.equal(mergeBatchGroupConfig({ min: 0 }).min, 1)
})

test('applies only to listed keys unless enabled_for_all', () => {
  assert.equal(batchGroupAppliesToKey(cfg(), 'k1'), true)
  assert.equal(batchGroupAppliesToKey(cfg(), 'k2'), false)
  assert.equal(batchGroupAppliesToKey(cfg({ enabled_for_all: true }), 'k2'), true)
  assert.equal(batchGroupAppliesToKey(mergeBatchGroupConfig({ keys: ['k1'] }), 'k1'), false)
})

test('group key comes from the cache seat hash or an explicit workload id', () => {
  assert.equal(batchGroupKey({ keyId: '1', seatKey: `seat:h:${HASH}` }), `k1:bg:s:${HASH}`)
  assert.equal(
    batchGroupKey({ keyId: '1', seatKey: `seat:h:${HASH}`, workloadId: 'u_abc12345' }),
    'k1:bg:u:u_abc12345',
  )
  assert.equal(batchGroupKey({ keyId: '1', seatKey: 'seat:sess:xyz' }), null)
  assert.equal(batchGroupKey({ keyId: '', seatKey: `seat:h:${HASH}` }), null)
  assert.equal(isBatchMemberKey('p:anthropic:k1:bg:s:ab#0'), true)
  assert.equal(isBatchMemberKey('k1:ch:ab'), false)
  assert.notEqual(batchMemberSeatKey('g', 0), batchMemberSeatKey('g', 1))
})

test('fills lowest member first, then grows without a ceiling', () => {
  const g = new BatchGroups()
  const c = cfg()
  const picks = [0, 1, 2, 3, 4].map(() => g.acquire('g', c))
  assert.deepEqual(
    picks.map((p) => p.index),
    [0, 0, 1, 1, 2],
  )
  assert.equal(picks[4].size, 3)
  assert.equal(g.snapshot().counters.grown, 2)
})

test('release frees room in the lowest member', () => {
  const g = new BatchGroups()
  const c = cfg()
  const a = g.acquire('g', c)
  g.acquire('g', c)
  const third = g.acquire('g', c)
  assert.equal(third.index, 1)
  a.release()
  a.release() // idempotent
  assert.equal(g.acquire('g', c).index, 0)
})

test('ceiling queues on the least loaded member instead of leaking', () => {
  const g = new BatchGroups()
  const c = cfg({ max: 2 })
  for (let i = 0; i < 4; i++) g.acquire('g', c)
  const extra = g.acquire('g', c)
  assert.equal(extra.queued, true)
  assert.ok([0, 1].includes(extra.index))
  assert.equal(extra.size, 2)
})

test('idle members above min are dropped and reported', () => {
  let now = 1_000_000
  const dropped = []
  const g = new BatchGroups({ now: () => now, onExpire: (k) => dropped.push(k) })
  const c = cfg({ idle_ttl_s: 60 })
  const a = g.acquire('g', c)
  const b = g.acquire('g', c)
  const d = g.acquire('g', c) // member 1
  a.release()
  b.release()
  d.release()
  now += 30_000
  g.sweep('g', c)
  assert.deepEqual(dropped, [])
  now += 40_000
  g.sweep('g', c)
  assert.deepEqual(dropped, ['g#1'])
  assert.equal(g.snapshot().groups[0].size, 1) // member 0 stays (min=1)
  assert.equal(g.snapshot().counters.shrunk, 1)
})

test('busy members are never swept', () => {
  let now = 0
  const g = new BatchGroups({ now: () => now })
  const c = cfg({ idle_ttl_s: 1 })
  g.acquire('g', c)
  g.acquire('g', c)
  g.acquire('g', c)
  now += 10_000
  assert.deepEqual(g.sweep('g', c), [])
})

test('groups are independent', () => {
  const g = new BatchGroups()
  const c = cfg()
  g.acquire('a', c)
  g.acquire('a', c)
  assert.equal(g.acquire('b', c).index, 0)
})
