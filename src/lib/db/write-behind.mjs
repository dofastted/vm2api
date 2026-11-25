import { withSavepoint } from './database.mjs'

/**
 * Batched write-behind flusher for hot-path request logging & accounting.
 *
 * The request's finish listener returns immediately without blocking on DB I/O;
 * queued callbacks commit together in short transactions (`BEGIN IMMEDIATE` on
 * SQLite, `BEGIN` on PostgreSQL) on the next `setImmediate` turn.
 */
const BATCH = 32
const queue = []
let draining = false
let db = null

export function armWriteBehind(database) {
  db = database || null
}

export function writeBehindArmed() {
  return !!db
}

export function enqueueWrite(fn) {
  queue.push(fn)
  if (draining) return
  draining = true
  setImmediate(drain)
}

export function flushWrites() {
  if (!db || !queue.length) return
  draining = true
  while (queue.length) {
    if (!drainBatch()) break
  }
  draining = false
}

export function pendingWrites() {
  return queue.length
}

function drain() {
  const progressed = drainBatch()
  if (queue.length && progressed) setImmediate(drain)
  else draining = false
}

function drainBatch() {
  const batch = queue.splice(0, BATCH)
  if (!batch.length || !db) return true
  const beginSql = db.engine === 'postgres' ? 'BEGIN' : 'BEGIN IMMEDIATE'
  try {
    db.exec(beginSql)
  } catch (err) {
    queue.unshift(...batch)
    console.warn('[write-behind]', err?.message || err)
    return false
  }
  try {
    for (let i = 0; i < batch.length; i += 1) {
      const fn = batch[i]
      try {
        withSavepoint(db, `wb_${i}`, fn)
      } catch (err) {
        console.warn('[write-behind]', err?.message || err)
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    console.warn('[write-behind]', err?.message || err)
  }
  return true
}
