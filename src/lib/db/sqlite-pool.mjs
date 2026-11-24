/**
 * Off-main-thread read pool for panel scans (supports both SQLite and PostgreSQL).
 *
 * - SQLite mode: spawns read-only `sqlite-worker.mjs` threads so heavy scans
 *   never stall SSE or HTTP handling on the main thread.
 * - PostgreSQL mode: `readAll()` executes directly on the native async `pg.Pool`;
 *   `usageRead()` runs in `pg-read-worker.mjs` threads sharing `pg-sync-worker`'s
 *   async connection pool, keeping the event loop completely non-blocking.
 */
import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import { sanitizePgParams, translateSqliteToPg } from './pg/sql-compat.mjs'

const sqliteWorkerUrl = new URL('./sqlite-worker.mjs', import.meta.url)
const pgReadWorkerUrl = new URL('./pg/pg-read-worker.mjs', import.meta.url)
const READERS = Math.max(1, Math.min(4, availableParallelism() - 1))

let mode = null // 'sqlite' | 'postgres' | null
let file = null
let pgPoolRef = null
let readers = []
let ready = null
let rr = 0
let seq = 0
/** @type {Map<number, { resolve: Function, reject: Function, worker: Worker }>} */
const pending = new Map()

export function usagePoolEnabled() {
  return readers.length > 0
}

export function startSqlitePool(dbPath) {
  if (!dbPath) return Promise.resolve()
  if (mode === 'sqlite' && file === dbPath && ready) return ready
  stopSqlitePool()
  mode = 'sqlite'
  file = dbPath
  readers = Array.from({ length: READERS }, () => spawnSqliteWorker(dbPath))
  ready = Promise.all(readers.map((worker) => worker.opened))
  ready.catch((err) => console.warn('[sqlite-pool]', err?.message || err))
  return ready
}

export function startPgReadPool(pgSyncDb, pgPool) {
  if (!pgSyncDb || typeof pgSyncDb.createChannel !== 'function') return Promise.resolve()
  if (mode === 'postgres' && pgPoolRef === pgPool && ready) return ready
  stopSqlitePool()
  mode = 'postgres'
  pgPoolRef = pgPool || null
  readers = Array.from({ length: READERS }, () => spawnPgReadWorker(pgSyncDb.createChannel()))
  ready = Promise.all(readers.map((worker) => worker.opened))
  ready.catch((err) => console.warn('[pg-read-pool]', err?.message || err))
  return ready
}

export function stopSqlitePool() {
  const dying = readers
  readers = []
  mode = null
  file = null
  pgPoolRef = null
  ready = null
  rr = 0
  for (const worker of dying) {
    worker.worker.terminate()
  }
  for (const [id, waiter] of pending) {
    pending.delete(id)
    waiter.reject(new Error('db read pool stopped'))
  }
}

export async function usageRead({ kind, method, args = [], mutedErrorClasses = [] }) {
  const worker = await claim()
  return call(worker, { kind, method, args, mutedErrorClasses })
}

/** Read-only SQL. Runs natively async on pg.Pool in PG mode, or on a query_only SQLite worker. */
export async function readAll(sql, params = []) {
  if (mode === 'postgres' && pgPoolRef) {
    const translated = translateSqliteToPg(sql)
    if (translated.special?.kind === 'noop') return []
    if (translated.special?.kind === 'static') return translated.special.rows
    const res = await pgPoolRef.query(translated.sql, sanitizePgParams(params))
    return res.rows
  }
  const worker = await claim()
  return call(worker, { op: 'all', sql, params })
}

function attachWorkerHandlers(worker, settle) {
  worker.on('message', (msg) => {
    if (msg && msg.ready === true) {
      settle.resolve()
      return
    }
    if (msg && msg.ready === false) {
      settle.reject(new Error(msg.error || 'db reader worker failed'))
      return
    }
    const waiter = pending.get(msg?.id)
    if (!waiter) return
    pending.delete(msg.id)
    if (msg.ok) waiter.resolve(msg.result)
    else waiter.reject(new Error(msg.error || 'db reader worker failed'))
  })
  worker.on('error', (err) => {
    settle.reject(err)
    failWorker(worker, err)
  })
  worker.on('exit', (code) => {
    if (code !== 0) failWorker(worker, new Error(`db reader worker exited ${code}`))
  })
}

function spawnSqliteWorker(dbPath) {
  const worker = new Worker(sqliteWorkerUrl, { workerData: { path: dbPath } })
  worker.unref()
  let settle
  const opened = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  attachWorkerHandlers(worker, settle)
  return { worker, opened }
}

function spawnPgReadWorker(port) {
  const worker = new Worker(pgReadWorkerUrl, {
    workerData: { port },
    transferList: [port],
  })
  worker.unref()
  let settle
  const opened = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  attachWorkerHandlers(worker, settle)
  return { worker, opened }
}

function failWorker(worker, err) {
  for (const [id, waiter] of pending) {
    if (waiter.worker !== worker) continue
    pending.delete(id)
    waiter.reject(err instanceof Error ? err : new Error(String(err)))
  }
}

async function claim() {
  if (!ready) throw new Error('db read pool is not started')
  await ready
  if (!readers.length) throw new Error('db read pool is not started')
  const worker = readers[rr % readers.length]
  rr = (rr + 1) % readers.length
  return worker.worker
}

function call(worker, body) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, worker })
    worker.postMessage({ id, ...body })
  })
}
