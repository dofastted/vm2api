/**
 * One read-only SQLite connection for panel scans.
 *
 * The gateway's main thread also uses node:sqlite, and DatabaseSync methods
 * do not return until the query finishes. A /logs refresh runs several of
 * those scans at once; doing them here keeps the event loop free to write
 * SSE and answer the small requests that were queued behind them.
 *
 * The connection is query_only. Preparing an INSERT still succeeds (the repo
 * constructor prepares its write statements) but executing one fails.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { UsageLogsRepo } from './repos/usage-logs-repo.mjs'
import { UsageLogsView } from './repos/usage-logs-view.mjs'

const VIEW_METHODS = new Set([
  'listBatch',
  'summary',
  'filterOptions',
  'activeSessions',
  'overview',
  'sessionSuggestions',
  'exportRows',
])
const REPO_METHODS = new Set(['totals', 'aggregate', 'windowStats'])

const cache = new Map()

function cachedPrepare(db) {
  const prepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    let stmt = cache.get(sql)
    if (!stmt) {
      if (cache.size >= 128) cache.delete(cache.keys().next().value)
      stmt = prepare(sql)
      cache.set(sql, stmt)
    }
    return stmt
  }
  return db
}

let view = null
let repo = null

function call(msg) {
  if (msg.kind === 'view') {
    if (!VIEW_METHODS.has(msg.method)) throw new Error(`usage view method not readable: ${msg.method}`)
    view.mutedErrorClasses = Array.isArray(msg.mutedErrorClasses) ? msg.mutedErrorClasses : []
    return view[msg.method](...(msg.args || []))
  }
  if (msg.kind === 'repo') {
    if (!REPO_METHODS.has(msg.method)) throw new Error(`usage repo method not readable: ${msg.method}`)
    return repo[msg.method](...(msg.args || []))
  }
  throw new Error('unknown sqlite worker op')
}

try {
  const db = cachedPrepare(new DatabaseSync(workerData.path, { readOnly: true }))
  db.exec('PRAGMA query_only = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  view = new UsageLogsView(db)
  repo = new UsageLogsRepo(db)
  parentPort.on('message', (msg) => {
    if (msg.op === 'all') {
      try {
        parentPort.postMessage({ id: msg.id, ok: true, result: db.prepare(msg.sql).all(...(msg.params || [])) })
      } catch (err) {
        parentPort.postMessage({ id: msg.id, ok: false, error: String(err?.message || err) })
      }
      return
    }
    try {
      parentPort.postMessage({ id: msg.id, ok: true, result: call(msg) })
    } catch (err) {
      parentPort.postMessage({ id: msg.id, ok: false, error: String(err?.message || err) })
    }
  })
  parentPort.postMessage({ ready: true })
} catch (err) {
  parentPort.postMessage({ ready: false, error: String(err?.message || err) })
}
