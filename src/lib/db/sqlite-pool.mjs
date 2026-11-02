/**
 * Read-only worker pool for panel scans.
 *
 * The main thread keeps the single writer DatabaseSync (transactions stay
 * there). These workers only run the usage-log reads that were blocking
 * /logs behind a 31-byte response. Round-robin spreads one refresh across
 * the pool; each worker handles one query at a time.
 */
import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'

const workerUrl = new URL('./sqlite-worker.mjs', import.meta.url)
const READERS = Math.max(1, Math.min(4, availableParallelism() - 1))

let file = null
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
  if (file === dbPath && ready) return ready
  stopSqlitePool()
  file = dbPath
  readers = Array.from({ length: READERS }, () => spawn(dbPath))
  ready = Promise.all(readers.map((worker) => worker.opened))
  ready.catch((err) => console.warn('[sqlite-pool]', err?.message || err))
}

export function stopSqlitePool() {
  const dying = readers
  readers = []
  file = null
  ready = null
  rr = 0
  for (const worker of dying) {
    worker.worker.terminate()
  }
  for (const [id, waiter] of pending) {
    pending.delete(id)
    waiter.reject(new Error('sqlite pool stopped'))
  }
}

export async function usageRead({ kind, method, args = [], mutedErrorClasses = [] }) {
  const worker = await claim()
  return call(worker, { kind, method, args, mutedErrorClasses })
}

/** Read-only SQL. Writes fail because the worker is query_only. */
export async function readAll(sql, params = []) {
  const worker = await claim()
  return call(worker, { op: 'all', sql, params })
}

function spawn(dbPath) {
  const worker = new Worker(workerUrl, { workerData: { path: dbPath } })
  let settle
  const opened = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  worker.on('message', (msg) => {
    if (msg && msg.ready === true) {
      settle.resolve()
      return
    }
    if (msg && msg.ready === false) {
      settle.reject(new Error(msg.error || 'sqlite worker failed'))
      return
    }
    const waiter = pending.get(msg?.id)
    if (!waiter) return
    pending.delete(msg.id)
    if (msg.ok) waiter.resolve(msg.result)
    else waiter.reject(new Error(msg.error || 'sqlite worker failed'))
  })
  worker.on('error', (err) => {
    settle.reject(err)
    failWorker(worker, err)
  })
  worker.on('exit', (code) => {
    if (code !== 0) failWorker(worker, new Error(`sqlite worker exited ${code}`))
  })
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
  if (!ready) throw new Error('sqlite pool is not started')
  await ready
  if (!readers.length) throw new Error('sqlite pool is not started')
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
