/**
 * Synchronous DatabaseSync-compatible PostgreSQL client (`PgSyncDb`).
 *
 * Allows all existing repositories and synchronous callers (settings, users,
 * api_keys, accounts, crag-shop, vm-rename, sticky-sessions, etc.) to run
 * transparently against PostgreSQL while heavy scans and write-behind flushes
 * run asynchronously off the main thread.
 */
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads'
import { detectMutatedTables } from './sql-compat.mjs'

const syncWorkerUrl = new URL('./pg-sync-worker.mjs', import.meta.url)

function reconstructError(info) {
  const err = new Error(info?.message || 'PostgreSQL query failed')
  if (info?.code) {
    err.code = info.code
    err.pgCode = info.code
  }
  if (info?.detail) err.detail = info.detail
  if (info?.constraint) err.constraint = info.constraint
  if (info?.table) err.table = info.table
  if (info?.schema) err.schema = info.schema
  return err
}

export class PgSyncDb {
  /**
   * @param {{ worker?: Worker, port: MessagePort, ownsWorker?: boolean, onMutation?: (tables: string[]) => void, rpcTimeoutMs?: number }} opts
   */
  constructor({ worker = null, port, ownsWorker = false, onMutation = null, rpcTimeoutMs = 90_000 }) {
    this.engine = 'postgres'
    this._worker = worker
    this._port = port
    this._ownsWorker = ownsWorker
    this._onMutation = onMutation
    this._rpcTimeoutMs = Math.max(5_000, Number(rpcTimeoutMs) || 90_000)
    this._sab = new SharedArrayBuffer(4)
    this._signal = new Int32Array(this._sab)
    this._seq = 0
    this._inTransaction = false
    this._txMutatedTables = new Set()
    this._closed = false
    this._workerDead = false
    this._workerDeadReason = ''

    if (this._worker) {
      const wakeDead = (reason) => {
        this._workerDead = true
        this._workerDeadReason = reason
        this._inTransaction = false
        this._txMutatedTables.clear()
        Atomics.store(this._signal, 0, -1)
        Atomics.notify(this._signal, 0)
      }
      this._onWorkerError = (err) => wakeDead(`pg-sync-worker error: ${err?.message || err}`)
      this._onWorkerExit = (code) => {
        if (!this._closed) wakeDead(`pg-sync-worker exited unexpectedly with code ${code}`)
      }
      this._worker.on('error', this._onWorkerError)
      this._worker.on('exit', this._onWorkerExit)
    }
  }

  get isTransaction() {
    return this._inTransaction
  }

  setMutationHook(fn) {
    this._onMutation = typeof fn === 'function' ? fn : null
  }

  _rpc(op, sql = '', params = []) {
    if (this._closed) throw new Error('PostgreSQL sync connection is closed')
    if (this._workerDead) throw new Error(this._workerDeadReason || 'pg-sync-worker is not running')
    const id = ++this._seq
    Atomics.store(this._signal, 0, 0)
    this._port.postMessage({ id, op, sql, params, sab: this._sab })
    const waitStatus = Atomics.wait(this._signal, 0, 0, this._rpcTimeoutMs)
    if (waitStatus === 'timed-out') {
      throw Object.assign(new Error(`pg-sync-worker timed out after ${this._rpcTimeoutMs}ms for op=${op}`), {
        code: 'PG_SYNC_TIMEOUT',
      })
    }
    if (Atomics.load(this._signal, 0) < 0 || this._workerDead) {
      throw new Error(this._workerDeadReason || 'pg-sync-worker exited during query')
    }

    let envelope = receiveMessageOnPort(this._port)
    let spins = 0
    while (!envelope && spins < 500) {
      Atomics.wait(this._signal, 0, 1, 1)
      envelope = receiveMessageOnPort(this._port)
      spins += 1
    }
    if (!envelope?.message) {
      throw new Error(`pg-sync-worker returned no response for op=${op}`)
    }
    const msg = envelope.message
    if (!msg.ok) {
      throw reconstructError(msg.error)
    }
    return msg.result
  }

  _recordMutation(sql) {
    if (!this._onMutation) return
    const tables = detectMutatedTables(sql)
    if (!tables.length) return
    if (this._inTransaction) {
      for (const t of tables) this._txMutatedTables.add(t)
    } else {
      try {
        this._onMutation(tables)
      } catch {}
    }
  }

  _flushTxMutations() {
    if (!this._onMutation || this._txMutatedTables.size === 0) {
      this._txMutatedTables.clear()
      return
    }
    const tables = [...this._txMutatedTables]
    this._txMutatedTables.clear()
    try {
      this._onMutation(tables)
    } catch {}
  }

  prepare(sql) {
    const db = this
    const text = String(sql)
    return {
      get(...params) {
        return db._rpc('get', text, params)
      },
      all(...params) {
        return db._rpc('all', text, params)
      },
      run(...params) {
        const res = db._rpc('run', text, params)
        if (res?.changes > 0) db._recordMutation(text)
        return res
      },
      *iterate(...params) {
        const rows = db._rpc('all', text, params)
        if (Array.isArray(rows)) {
          for (const row of rows) yield row
        }
      },
    }
  }

  exec(sql) {
    const text = String(sql || '').trim()
    if (!text) return
    if (/^BEGIN(?:\s+(?:IMMEDIATE|DEFERRED|EXCLUSIVE))?\s*;?$/i.test(text)) {
      this._rpc('begin')
      this._inTransaction = true
      return
    }
    if (/^COMMIT\s*;?$/i.test(text)) {
      try {
        this._rpc('commit')
      } finally {
        this._inTransaction = false
      }
      this._flushTxMutations()
      return
    }
    if (/^ROLLBACK\s*;?$/i.test(text)) {
      try {
        this._rpc('rollback')
      } finally {
        this._inTransaction = false
        this._txMutatedTables.clear()
      }
      return
    }
    const res = this._rpc('exec', text)
    if (res && typeof res.inTransaction === 'boolean') {
      const wasTx = this._inTransaction
      this._inTransaction = res.inTransaction
      if (wasTx && !this._inTransaction) this._flushTxMutations()
    }
    this._recordMutation(text)
  }

  /** Compatible with better-sqlite3 / node:sqlite style db.transaction(fn) helper. */
  transaction(fn) {
    return (...args) => {
      if (this._inTransaction) return fn(...args)
      this.exec('BEGIN')
      try {
        const out = fn(...args)
        this.exec('COMMIT')
        return out
      } catch (err) {
        if (this._inTransaction) {
          try {
            this.exec('ROLLBACK')
          } catch {}
        }
        throw err
      }
    }
  }

  /** Create an additional MessagePort attached to the same underlying worker pool. */
  createChannel() {
    if (!this._worker) {
      throw new Error('createChannel() requires the owner PgSyncDb instance')
    }
    const { port1, port2 } = new MessageChannel()
    this._worker.postMessage({ op: 'attach', port: port2 }, [port2])
    return port1
  }

  poolStats() {
    try {
      return this._rpc('stats')
    } catch {
      return null
    }
  }

  close() {
    if (this._closed) return
    this._closed = true
    try {
      this._port.close()
    } catch {}
    if (this._ownsWorker && this._worker) {
      if (this._onWorkerError) this._worker.off('error', this._onWorkerError)
      if (this._onWorkerExit) this._worker.off('exit', this._onWorkerExit)
      try {
        this._worker.postMessage({ op: 'shutdown' })
      } catch {}
      try {
        this._worker.terminate()
      } catch {}
      this._worker = null
    }
  }
}

/**
 * Spawn the dedicated `pg-sync-worker` and return an initialized `PgSyncDb` instance.
 */
export async function createPgSyncDb(pgConfig, { onMutation = null, rpcTimeoutMs = null } = {}) {
  const worker = new Worker(syncWorkerUrl, {
    workerData: { pgConfig },
  })
  worker.unref()

  await new Promise((resolve, reject) => {
    const onMsg = (msg) => {
      if (msg?.ready === true) {
        cleanup()
        resolve()
      } else if (msg?.ready === false) {
        cleanup()
        reject(new Error(msg.error || 'pg-sync-worker failed to initialize'))
      }
    }
    const onErr = (err) => {
      cleanup()
      reject(err)
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`pg-sync-worker exited during startup with code ${code}`))
    }
    const cleanup = () => {
      worker.off('message', onMsg)
      worker.off('error', onErr)
      worker.off('exit', onExit)
    }
    worker.on('message', onMsg)
    worker.on('error', onErr)
    worker.on('exit', onExit)
  })

  const { port1, port2 } = new MessageChannel()
  worker.postMessage({ op: 'attach', port: port2 }, [port2])

  const effectiveTimeout = rpcTimeoutMs ?? Math.max(30_000, (Number(pgConfig?.statementTimeoutMs) || 60_000) + 30_000)
  return new PgSyncDb({ worker, port: port1, ownsWorker: true, onMutation, rpcTimeoutMs: effectiveTimeout })
}
