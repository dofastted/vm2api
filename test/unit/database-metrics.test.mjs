import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../../src/lib/db/database.mjs'
import { snapshotDatabaseMetrics } from '../../src/lib/db/database-metrics.mjs'

const fakeDb = (failures = new Set()) => ({
  pool: { totalCount: 3, idleCount: 2, waitingCount: 1 },
  prepare(sql) {
    assert.match(sql, /^SELECT /)
    return {
      async get() {
        if (failures.has(sql)) throw new Error('private connection failure')
        if (sql.includes('pg_database_size')) return { bytes: '4096' }
        if (sql.includes('COUNT(*)')) return { count: '2' }
        if (sql.includes('version,')) return { version: '001', applied_at: '2026-10-21T00:00:00.000Z' }
        return { ok: 1 }
      },
    }
  },
})

test('PostgreSQL metrics report database size, migration state and this process pool', async () => {
  const snapshot = await snapshotDatabaseMetrics({ db: getDb(), usageCache: { stats: () => ({ requests: 4 }) } })
  assert.equal(snapshot.database.engine, 'postgresql')
  assert.equal(snapshot.database.ok, true)
  assert.ok(snapshot.database.size_bytes > 0)
  assert.ok(snapshot.database.migration_count > 0)
  assert.equal(typeof snapshot.database.pool_total, 'number')
  assert.equal(snapshot.usage_cache.requests, 4)
  assert.equal(JSON.stringify(snapshot).includes('postgresql://'), false)
  assert.equal('wal_size_bytes' in snapshot.database, false)
})

test('read-only snapshot retains independent metrics when the probe fails', async () => {
  const snapshot = await snapshotDatabaseMetrics({
    db: fakeDb(new Set(['SELECT 1 AS ok'])),
    now: () => Date.parse('2026-10-21T00:00:00.000Z'),
    usageCache: null,
  })
  assert.equal(snapshot.sampled_at, '2026-10-21T00:00:00.000Z')
  assert.equal(snapshot.database.ok, false)
  assert.equal(snapshot.database.probe_latency_ms, null)
  assert.equal(snapshot.database.size_bytes, 4096)
  assert.equal(snapshot.database.pool_total, 3)
  assert.equal(snapshot.database.pool_idle, 2)
  assert.equal(snapshot.database.pool_waiting, 1)
  assert.equal(JSON.stringify(snapshot).includes('private'), false)
})

test('cache-stat failure does not hide PostgreSQL health', async () => {
  const snapshot = await snapshotDatabaseMetrics({
    db: fakeDb(),
    usageCache: {
      stats() {
        throw new Error('cache failed')
      },
    },
  })
  assert.equal(snapshot.database.ok, true)
  assert.equal(snapshot.usage_cache, null)
})
