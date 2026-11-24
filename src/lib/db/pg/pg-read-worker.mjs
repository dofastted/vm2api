/**
 * Off-main-thread PostgreSQL reader worker for heavy panel analytics scans
 * (`UsageLogsView`, `UsageLogsRepo`, `StatisticsRepo`).
 *
 * Uses a dedicated MessagePort connected directly to `pg-sync-worker`'s async
 * pg.Pool so multiple reader workers execute heavy scans concurrently without
 * ever blocking the gateway's HTTP/SSE event loop.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { PgSyncDb } from './pg-sync-db.mjs'
import { UsageLogsRepo } from '../repos/usage-logs-repo.mjs'
import { UsageLogsView } from '../repos/usage-logs-view.mjs'
import { StatisticsRepo } from '../repos/statistics-repo.mjs'

const VIEW_METHODS = new Set([
  'listBatch',
  'summary',
  'filterOptions',
  'activeSessions',
  'overview',
  'sessionSuggestions',
  'exportRows',
])
const REPO_METHODS = new Set(['totals', 'aggregate', 'windowStats', 'keyUsagePeriods', 'keyRecentRequests'])
const STATS_METHODS = new Set(['statistics', 'overview', 'timeseries', 'leaderboard', 'breakdown'])

let db = null
let view = null
let repo = null
let stats = null

function dispatch(msg) {
  if (msg.kind === 'view') {
    if (!VIEW_METHODS.has(msg.method)) throw new Error(`usage view method not readable: ${msg.method}`)
    view.mutedErrorClasses = Array.isArray(msg.mutedErrorClasses) ? msg.mutedErrorClasses : []
    return view[msg.method](...(msg.args || []))
  }
  if (msg.kind === 'repo') {
    if (!REPO_METHODS.has(msg.method)) throw new Error(`usage repo method not readable: ${msg.method}`)
    return repo[msg.method](...(msg.args || []))
  }
  if (msg.kind === 'stats') {
    if (!STATS_METHODS.has(msg.method)) throw new Error(`statistics method not readable: ${msg.method}`)
    return stats[msg.method](...(msg.args || []))
  }
  throw new Error(`unknown pg-read-worker op: ${msg.kind || msg.op}`)
}

try {
  if (!workerData?.port) throw new Error('pg-read-worker requires an attached MessagePort')
  db = new PgSyncDb({ port: workerData.port, ownsWorker: false })
  view = new UsageLogsView(db)
  repo = new UsageLogsRepo(db)
  stats = new StatisticsRepo(db)

  parentPort.on('message', (msg) => {
    if (msg?.op === 'all') {
      try {
        parentPort.postMessage({ id: msg.id, ok: true, result: db.prepare(msg.sql).all(...(msg.params || [])) })
      } catch (err) {
        parentPort.postMessage({ id: msg.id, ok: false, error: String(err?.message || err) })
      }
      return
    }
    try {
      parentPort.postMessage({ id: msg.id, ok: true, result: dispatch(msg) })
    } catch (err) {
      parentPort.postMessage({ id: msg.id, ok: false, error: String(err?.message || err) })
    }
  })

  parentPort.postMessage({ ready: true })
} catch (err) {
  parentPort.postMessage({ ready: false, error: String(err?.message || err) })
}
