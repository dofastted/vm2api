import { withSavepoint } from './database.mjs'

/**
 * Batched write-behind flusher for hot-path request logging & accounting.
 *
 * The request's finish listener returns immediately without blocking on DB I/O;
 * queued callbacks commit together in short transactions (`BEGIN IMMEDIATE` on
 * SQLite, `BEGIN` on PostgreSQL) on the next `setImmediate` turn.
 *
 * Hardened with a bounded queue (`maxQueueSize`, default 10000) that drains a
 * synchronous batch on overflow to prevent unbounded memory growth / OOM,
 * plus live observability metrics (`writeBehindStats()`).
 */
const DEFAULT_BATCH = 32
const DEFAULT_MAX_QUEUE_SIZE = 10_000

let batchSize = DEFAULT_BATCH
let maxQueueSize = DEFAULT_MAX_QUEUE_SIZE

const queue = []
let draining = false
let drainHandle = null
let db = null

const metrics = {
  enqueued: 0,
  flushed: 0,
  batches: 0,
  overflows: 0,
  overflowDrains: 0,
  errors: 0,
  dropped: 0,
  highWaterMark: 0,
  lastFlushMs: 0,
}

function clampPositiveInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.trunc(n)
}

function cancelScheduledDrain() {
  if (drainHandle !== null) {
    clearImmediate(drainHandle)
    drainHandle = null
  }
}

function scheduleDrain() {
  if (draining || !db || !queue.length) return
  draining = true
  drainHandle = setImmediate(drain)
}

export function configureWriteBehind({ maxQueueSize: nextMax, batchSize: nextBatch } = {}) {
  if (nextMax !== undefined) {
    maxQueueSize = clampPositiveInt(nextMax, DEFAULT_MAX_QUEUE_SIZE)
  }
  if (nextBatch !== undefined) {
    batchSize = clampPositiveInt(nextBatch, DEFAULT_BATCH)
  }
}

export function resetWriteBehindStats() {
  metrics.enqueued = 0
  metrics.flushed = 0
  metrics.batches = 0
  metrics.overflows = 0
  metrics.overflowDrains = 0
  metrics.errors = 0
  metrics.dropped = 0
  metrics.highWaterMark = queue.length
  metrics.lastFlushMs = 0
}

export function armWriteBehind(database, opts) {
  db = database || null
  if (opts && typeof opts === 'object') {
    configureWriteBehind(opts)
  }
  if (!db) {
    cancelScheduledDrain()
    draining = false
  } else if (queue.length > 0 && !draining) {
    scheduleDrain()
  }
}

export function writeBehindArmed() {
  return !!db
}

export function enqueueWrite(fn) {
  if (typeof fn !== 'function') return false
  metrics.enqueued += 1

  // Bounded queue overflow protection: synchronously drain a batch before accepting more.
  if (queue.length >= maxQueueSize) {
    metrics.overflows += 1
    if (db) {
      const progressed = drainBatch()
      if (progressed) {
        metrics.overflowDrains += 1
      } else {
        // DB transaction could not start; run inline best-effort to avoid OOM & silent loss.
        try {
          fn()
          metrics.flushed += 1
        } catch (err) {
          metrics.errors += 1
          metrics.dropped += 1
          console.warn('[write-behind]', err?.message || err)
        }
        return true
      }
    } else {
      // Unarmed overflow guard: bound memory strictly by evicting the oldest entry.
      queue.shift()
      metrics.dropped += 1
    }
  }

  queue.push(fn)
  if (queue.length > metrics.highWaterMark) {
    metrics.highWaterMark = queue.length
  }
  scheduleDrain()
  return true
}

export function flushWrites() {
  cancelScheduledDrain()
  if (!db || !queue.length) {
    draining = false
    return
  }
  draining = true
  try {
    while (queue.length) {
      if (!drainBatch()) break
    }
  } finally {
    draining = false
  }
}

export function pendingWrites() {
  return queue.length
}

export function writeBehindStats() {
  return {
    armed: !!db,
    queued: queue.length,
    maxQueueSize,
    batchSize,
    draining,
    enqueued: metrics.enqueued,
    flushed: metrics.flushed,
    batches: metrics.batches,
    overflows: metrics.overflows,
    overflowDrains: metrics.overflowDrains,
    errors: metrics.errors,
    dropped: metrics.dropped,
    highWaterMark: metrics.highWaterMark,
    lastFlushMs: metrics.lastFlushMs,
  }
}

function drain() {
  drainHandle = null
  if (!db || !queue.length) {
    draining = false
    return
  }
  const progressed = drainBatch()
  if (queue.length && progressed && db) {
    drainHandle = setImmediate(drain)
  } else {
    draining = false
  }
}

function drainBatch() {
  if (!db || !queue.length) return false
  const started = performance.now()
  const batch = queue.splice(0, batchSize)
  const beginSql = db.engine === 'postgres' ? 'BEGIN' : 'BEGIN IMMEDIATE'
  try {
    db.exec(beginSql)
  } catch (err) {
    queue.unshift(...batch)
    metrics.errors += 1
    console.warn('[write-behind]', err?.message || err)
    return false
  }

  let succeeded = 0
  try {
    for (let i = 0; i < batch.length; i += 1) {
      const fn = batch[i]
      try {
        withSavepoint(db, `wb_${i}`, fn)
        succeeded += 1
      } catch (err) {
        metrics.errors += 1
        metrics.dropped += 1
        console.warn('[write-behind]', err?.message || err)
      }
    }
    db.exec('COMMIT')
    metrics.flushed += succeeded
    metrics.batches += 1
    metrics.lastFlushMs = Math.round(Math.max(0, performance.now() - started) * 1000) / 1000
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    metrics.errors += 1
    metrics.dropped += succeeded
    console.warn('[write-behind]', err?.message || err)
  }
  return true
}
