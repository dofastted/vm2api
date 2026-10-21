import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { createRateLimiter, hashKey } from '../../src/lib/core/security.mjs'

test('independent control planes share one atomic gateway token bucket', async () => {
  const db = getDb()
  const other = await createDatabase({ schema: db.schema })
  try {
    const first = createRateLimiter({ db, capacity: 3, refillPerSec: 0 })
    const second = createRateLimiter({ db: other, capacity: 3, refillPerSec: 0 })
    const admitted = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second)('shared-secret')))
    assert.equal(admitted.filter(Boolean).length, 3)
    assert.equal(await first('shared-secret'), false)
    assert.equal(await second('different-secret'), true)
    const rows = await db.prepare('SELECT bucket_hash FROM gateway_rate_buckets').all()
    assert.deepEqual(new Set(rows.map((row) => row.bucket_hash)), new Set([hashKey('shared-secret'), hashKey('different-secret')]))
  } finally {
    await other.close()
  }
})

test('bucket refill uses the database clock and survives a control-plane connection replacement', async () => {
  const db = getDb()
  const first = createRateLimiter({ db, capacity: 1, refillPerSec: 1 })
  assert.equal(await first('refill'), true)
  await db.prepare('UPDATE gateway_rate_buckets SET updated_at = updated_at - 2000 WHERE bucket_hash = $1').run(hashKey('refill'))
  const other = await createDatabase({ schema: db.schema })
  try {
    const replacement = createRateLimiter({ db: other, capacity: 1, refillPerSec: 1 })
    assert.equal(await replacement('refill'), true)
    assert.equal(await first('refill'), false)
  } finally {
    await other.close()
  }
})

test('a shared limiter fails closed when PostgreSQL is unavailable', async () => {
  const db = getDb()
  const other = await createDatabase({ schema: db.schema })
  const limiter = createRateLimiter({ db: other, capacity: 1 })
  await other.close()
  await assert.rejects(async () => await limiter('offline'), /closed/)
})
