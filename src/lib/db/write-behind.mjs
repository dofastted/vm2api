/**
 * Hot-path writes are recorded here and committed later, on the same
 * connection, in short batches. The request's finish listener returns
 * without touching SQLite, so RPM is not capped by index updates.
 *
 * One writer only. A second connection would make the next quota save
 * block the event loop on SQLITE_BUSY. setImmediate runs after the
 * current I/O batch, so the next request is accepted before the flush.
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
  try {
    db.exec('BEGIN IMMEDIATE')
  } catch (err) {
    queue.unshift(...batch)
    console.warn('[write-behind]', err?.message || err)
    return false
  }
  try {
    for (const fn of batch) {
      try {
        fn()
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
