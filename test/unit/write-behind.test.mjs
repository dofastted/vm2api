import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import {
  armWriteBehind,
  configureWriteBehind,
  enqueueWrite,
  flushWrites,
  pendingWrites,
  resetWriteBehindStats,
  writeBehindArmed,
  writeBehindStats,
} from '../../src/lib/db/write-behind.mjs'

test('finish returns before the usage row is written, and flush commits it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-behind-'))
  const db = createDatabase({ dataDir: dir })
  const store = new RequestLogStore({ dataDir: dir, db, mode: 'normal' })
  resetWriteBehindStats()
  armWriteBehind(db)
  try {
    const ctx = store.start({ headers: {}, socket: {} }, { protocol: 'anthropic.messages', pathName: '/v1/messages' })
    const summary = store.finish(ctx, { status: 200, model: 'claude-haiku-4-5', input_tokens: 3, output_tokens: 1 })
    assert.equal(pendingWrites() > 0, true)
    assert.equal(store.repo.getByRequestId(summary.request_id), null)
    flushWrites()
    assert.equal(pendingWrites(), 0)
    assert.equal(store.repo.getByRequestId(summary.request_id)?.status, 200)
    assert.equal(writeBehindArmed(), true)

    const stats = writeBehindStats()
    assert.equal(stats.armed, true)
    assert.equal(stats.queued, 0)
    assert.equal(stats.maxQueueSize, 10_000)
    assert.equal(stats.batchSize, 32)
    assert.ok(stats.enqueued >= 1)
    assert.ok(stats.flushed >= 1)
    assert.ok(stats.batches >= 1)
    assert.equal(stats.errors, 0)
    assert.equal(stats.dropped, 0)
  } finally {
    armWriteBehind(null)
    flushWrites()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('write-behind enforces bounded maxQueueSize by draining a batch synchronously on overflow without data loss', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-behind-cap-'))
  const db = createDatabase({ dataDir: dir })
  resetWriteBehindStats()
  armWriteBehind(db, { maxQueueSize: 5, batchSize: 3 })
  try {
    const stmt = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    const ts = new Date().toISOString()
    for (let i = 1; i <= 10; i += 1) {
      enqueueWrite(() => stmt.run(`wb_k_${i}`, JSON.stringify(i), ts))
      assert.ok(pendingWrites() <= 5, `queue length ${pendingWrites()} must not exceed maxQueueSize=5`)
    }

    const beforeFlush = writeBehindStats()
    assert.ok(beforeFlush.overflows >= 1)
    assert.ok(beforeFlush.overflowDrains >= 1)
    assert.ok(beforeFlush.flushed >= 3)
    assert.equal(beforeFlush.dropped, 0)
    assert.ok(beforeFlush.highWaterMark <= 5)

    flushWrites()
    assert.equal(pendingWrites(), 0)
    const afterFlush = writeBehindStats()
    assert.equal(afterFlush.enqueued, 10)
    assert.equal(afterFlush.flushed, 10)
    assert.equal(afterFlush.dropped, 0)
    assert.equal(afterFlush.errors, 0)

    const count = db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key LIKE 'wb_k_%'").get().c
    assert.equal(count, 10)
  } finally {
    configureWriteBehind({ maxQueueSize: 10_000, batchSize: 32 })
    armWriteBehind(null)
    flushWrites()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('write-behind isolates per-callback errors, avoids idle spin, and bounds unarmed queues', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-behind-err-'))
  const db = createDatabase({ dataDir: dir })
  resetWriteBehindStats()
  armWriteBehind(db, { maxQueueSize: 4, batchSize: 4 })
  try {
    const ran = []
    enqueueWrite(() => ran.push('a'))
    enqueueWrite(() => {
      throw new Error('boom')
    })
    enqueueWrite(() => ran.push('b'))

    // Wait for automatic setImmediate drain (no manual flushWrites)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(pendingWrites(), 0)
    assert.deepEqual(ran, ['a', 'b'])

    const st = writeBehindStats()
    assert.equal(st.draining, false)
    assert.equal(st.flushed, 2)
    assert.equal(st.errors, 1)
    assert.equal(st.dropped, 1)

    // Unarmed overflow still enforces maxQueueSize to prevent OOM
    armWriteBehind(null)
    resetWriteBehindStats()
    const order = []
    for (let i = 1; i <= 6; i += 1) {
      enqueueWrite(() => order.push(i))
    }
    assert.equal(pendingWrites(), 4)
    assert.equal(writeBehindStats().dropped, 2)

    // Re-arming drains the retained 4 newest callbacks without dropping them
    armWriteBehind(db)
    flushWrites()
    assert.deepEqual(order, [3, 4, 5, 6])
    assert.equal(pendingWrites(), 0)
  } finally {
    configureWriteBehind({ maxQueueSize: 10_000, batchSize: 32 })
    armWriteBehind(null)
    flushWrites()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
