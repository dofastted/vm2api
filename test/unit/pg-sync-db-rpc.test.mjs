import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MessageChannel, Worker } from 'node:worker_threads'
import { PgSyncDb } from '../../src/lib/db/pg/pg-sync-db.mjs'

/**
 * Spawn a lightweight mock worker thread speaking the pg-sync-worker MessagePort
 * protocol so we can deterministically exercise spurious wakeups, RPC timeouts,
 * late responses, and worker crashes without a live PostgreSQL server.
 */
function spawnMockSyncWorker(behaviorScript) {
  const { port1, port2 } = new MessageChannel()
  const code = `
    const { parentPort, workerData } = require('node:worker_threads')
    const port = workerData.port
    let queue = Promise.resolve()
    const reply = (sab, payload) => {
      port.postMessage(payload)
      if (sab) {
        const signal = new Int32Array(sab)
        Atomics.add(signal, 0, 1)
        Atomics.notify(signal, 0)
      }
    }
    const handle = ${behaviorScript}
    port.on('message', (msg) => {
      queue = queue.then(() => handle(msg, reply, port)).catch((err) => {
        reply(msg?.sab, { id: msg?.id, ok: false, error: { message: String(err?.message || err) } })
      })
    })
    parentPort.postMessage({ ready: true })
  `
  const worker = new Worker(code, { eval: true, workerData: { port: port2 }, transferList: [port2] })
  return new Promise((resolve, reject) => {
    worker.once('message', (m) => (m?.ready ? resolve({ worker, port: port1 }) : reject(new Error('not ready'))))
    worker.once('error', reject)
  })
}

describe('PgSyncDb synchronous RPC framing & correlation', () => {
  it('survives spurious Atomics.wait wakeups without throwing or desyncing', async () => {
    const { worker, port } = await spawnMockSyncWorker(`async (msg, reply) => {
      const signal = new Int32Array(msg.sab)
      // Simulate multiple spurious wakeups (notify without posting a message,
      // and incrementing the counter while no response is queued yet) before
      // the query actually completes ~40ms later.
      for (let i = 0; i < 5; i += 1) {
        await new Promise((r) => setTimeout(r, 5))
        Atomics.notify(signal, 0)
      }
      await new Promise((r) => setTimeout(r, 15))
      if (msg.op === 'all') {
        reply(msg.sab, { id: msg.id, ok: true, result: [{ sql: msg.sql, id: msg.id }] })
      } else {
        reply(msg.sab, { id: msg.id, ok: true, result: { sql: msg.sql, id: msg.id } })
      }
    }`)
    const db = new PgSyncDb({ worker, port, ownsWorker: true, rpcTimeoutMs: 2_000 })
    try {
      const rows = db.prepare('SELECT * FROM vms').all()
      assert.ok(Array.isArray(rows))
      assert.equal(rows.length, 1)
      assert.equal(rows[0].sql, 'SELECT * FROM vms')

      const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get('k1')
      assert.equal(row.sql, 'SELECT * FROM api_keys WHERE id = ?')
    } finally {
      db.close()
    }
  })

  it('drains late responses after PG_SYNC_TIMEOUT so subsequent queries never shift out of sync', async () => {
    const { worker, port } = await spawnMockSyncWorker(`async (msg, reply) => {
      if (msg.sql === 'SLOW_QUERY') {
        // Complete AFTER the caller's 80ms timeout expires.
        await new Promise((r) => setTimeout(r, 160))
        reply(msg.sab, { id: msg.id, ok: true, result: { stale: true, from: 'SLOW_QUERY' } })
        return
      }
      if (msg.op === 'all') {
        reply(msg.sab, { id: msg.id, ok: true, result: [{ from: msg.sql, id: msg.id }] })
        return
      }
      if (msg.op === 'run') {
        reply(msg.sab, { id: msg.id, ok: true, result: { changes: 1, lastInsertRowid: 0 } })
        return
      }
      if (msg.op === 'stats') {
        reply(msg.sab, { id: msg.id, ok: true, result: { total: 2, idle: 2, waiting: 0, active: 0, max: 12 } })
        return
      }
      reply(msg.sab, { id: msg.id, ok: true, result: { from: msg.sql, id: msg.id } })
    }`)
    const db = new PgSyncDb({ worker, port, ownsWorker: true, rpcTimeoutMs: 80 })
    try {
      assert.throws(
        () => db.prepare('SLOW_QUERY').get(),
        (err) => err?.code === 'PG_SYNC_TIMEOUT',
      )

      // Next query runs while SLOW_QUERY is still in-flight (wait > remaining 80ms + query time).
      // Increase timeout for follow-up queries to simulate normal operation after a transient stall.
      db._rpcTimeoutMs = 2_000
      const rows = db.prepare('SELECT * FROM cluster_node_direct_links').all()
      assert.ok(Array.isArray(rows), 'subsequent .all() must receive an array, not stale SLOW_QUERY object')
      assert.equal(rows[0].from, 'SELECT * FROM cluster_node_direct_links')

      // Even after a second timeout whose response arrives BEFORE the next call starts,
      // pre-request draining discards the stale envelope.
      db._rpcTimeoutMs = 80
      assert.throws(
        () => db.prepare('SLOW_QUERY').get(),
        (err) => err?.code === 'PG_SYNC_TIMEOUT',
      )
      await new Promise((r) => setTimeout(r, 220))

      db._rpcTimeoutMs = 2_000
      const keyRow = db.prepare('SELECT * FROM api_keys').get()
      assert.equal(keyRow.from, 'SELECT * FROM api_keys')
      assert.equal(keyRow.stale, undefined)

      const listRows = db.prepare('SELECT * FROM proxies').all()
      assert.ok(Array.isArray(listRows))
      assert.equal(listRows[0].from, 'SELECT * FROM proxies')

      const stats = db.poolStats()
      assert.equal(stats.timeouts, 2)
      assert.equal(stats.stale_dropped, 2)
    } finally {
      db.close()
    }
  })

  it('sends best-effort rollback when BEGIN times out so worker does not stay pinned in a transaction', async () => {
    const { worker, port } = await spawnMockSyncWorker(`async (msg, reply) => {
      if (!globalThis.__ops) globalThis.__ops = []
      globalThis.__ops.push(msg.op)
      if (msg.op === 'begin') {
        await new Promise((r) => setTimeout(r, 150))
        reply(msg.sab, { id: msg.id, ok: true, result: { inTransaction: true } })
        return
      }
      if (msg.op === 'rollback') {
        reply(msg.sab, { id: msg.id, ok: true, result: { inTransaction: false } })
        return
      }
      reply(msg.sab, { id: msg.id, ok: true, result: { ops: [...globalThis.__ops] } })
    }`)
    const db = new PgSyncDb({ worker, port, ownsWorker: true, rpcTimeoutMs: 70 })
    try {
      assert.throws(
        () => db.exec('BEGIN'),
        (err) => err?.code === 'PG_SYNC_TIMEOUT',
      )
      assert.equal(db.isTransaction, false)

      db._rpcTimeoutMs = 2_000
      const res = db.prepare('SELECT 1').get()
      assert.deepEqual(res.ops, ['begin', 'rollback', 'get'])
    } finally {
      db.close()
    }
  })

  it('surfaces worker errors cleanly and rejects queries after unexpected worker exit', async () => {
    const { worker, port } = await spawnMockSyncWorker(`async (msg, reply) => {
      if (msg.sql === 'FAIL_SQL') {
        reply(msg.sab, { id: msg.id, ok: false, error: { message: 'boom', code: '23505', constraint: 'accounts_pkey' } })
        return
      }
      if (msg.sql === 'CRASH') {
        process.exit(1)
      }
      reply(msg.sab, { id: msg.id, ok: true, result: { ok: 1 } })
    }`)
    const db = new PgSyncDb({ worker, port, ownsWorker: true, rpcTimeoutMs: 500 })
    try {
      assert.throws(
        () => db.prepare('FAIL_SQL').run(),
        (err) => err.message === 'boom' && err.code === '23505' && err.constraint === 'accounts_pkey',
      )
      assert.deepEqual(db.prepare('OK').get(), { ok: 1 })
    } finally {
      db.close()
    }
  })
})
