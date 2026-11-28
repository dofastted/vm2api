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
const SIGNAL_REPLY_INDEX = 0
const SIGNAL_DEAD_INDEX = 1
const WAIT_SLICE_MS = 100

/**
 * Columns updated by routine per-request API key usage accounting (recordUsage /
 * dirty-set flush / last_used_at touch). Updating ONLY these columns must NOT
 * trigger a cluster-wide `apiKeys.invalidateAll()` L1 eviction storm; structural
 * admin mutations (status/quota/rate limits/scopes/key rotation/delete) still
 * emit plain `'api_keys'` and invalidate immediately.
 */
const ROUTINE_API_KEY_USAGE_COLUMNS = new Set([
  'requests',
  'quota_requests_used',
  'tokens_in',
  'tokens_out',
  'cache_read_tokens',
  'cache_creation_tokens',
  'quota_used',
  'usage_5h',
  'window_5h_start',
  'usage_1d',
  'window_1d_start',
  'usage_7d',
  'window_7d_start',
  'last_used_at',
  'updated_at',
])

/** Extract the SET clause body of a single UPDATE statement, stopping at top-level WHERE/FROM/RETURNING. */
function extractUpdateSetClause(sql, startIdx) {
  let i = startIdx
  const n = sql.length
  let depth = 0

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === "'") {
      i += 1
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '"') {
      i += 1
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      if (i < n) i += 2
      continue
    }
    if (ch === '(') {
      depth += 1
      i += 1
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      i += 1
      continue
    }
    if (depth === 0) {
      if (ch === ';') return sql.slice(startIdx, i)
      const tail = sql.slice(i)
      if (/^(?:WHERE|FROM|RETURNING)\b/i.test(tail)) {
        const prev = i > 0 ? sql[i - 1] : ' '
        if (!/[a-zA-Z0-9_$]/.test(prev)) {
          return sql.slice(startIdx, i)
        }
      }
    }
    i += 1
  }
  return sql.slice(startIdx)
}

/** Split a SQL SET clause on top-level commas (outside quotes and parentheses). */
function splitTopLevelAssignments(setBody) {
  const parts = []
  let start = 0
  let depth = 0
  let i = 0
  const n = setBody.length

  while (i < n) {
    const ch = setBody[i]
    if (ch === "'") {
      i += 1
      while (i < n) {
        if (setBody[i] === "'") {
          if (setBody[i + 1] === "'") {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '"') {
      i += 1
      while (i < n) {
        if (setBody[i] === '"') {
          if (setBody[i + 1] === '"') {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      parts.push(setBody.slice(start, i))
      start = i + 1
    }
    i += 1
  }
  parts.push(setBody.slice(start))
  return parts.map((s) => s.trim()).filter(Boolean)
}

/**
 * Returns true iff `sql` is a single `UPDATE api_keys SET ...` that modifies
 * ONLY routine usage counter / spend window / `last_used_at` columns.
 */
export function isRoutineApiKeyUsageUpdate(sql) {
  if (typeof sql !== 'string') return false
  const trimmed = sql.trim().replace(/;+\s*$/, '')
  // Reject multi-statement scripts conservatively
  if (!/^UPDATE\s+/i.test(trimmed)) return false
  const header = trimmed.match(/^UPDATE\s+["`]?api_keys["`]?(?:\s+(?:AS\s+)?[a-zA-Z_][a-zA-Z0-9_]*)?\s+SET\s+/i)
  if (!header) return false
  // Reject if another DML keyword appears after a semicolon
  if (/;\s*(?:INSERT|UPDATE|DELETE)\b/i.test(trimmed)) return false

  const setBody = extractUpdateSetClause(trimmed, header[0].length)
  const assignments = splitTopLevelAssignments(setBody)
  if (!assignments.length) return false

  for (const item of assignments) {
    const eqIdx = item.indexOf('=')
    if (eqIdx <= 0) return false
    const lhs = item.slice(0, eqIdx).trim()
    // Strip optional alias (e.g. `k.quota_used`) and quotes
    const rawCol = lhs.includes('.') ? lhs.slice(lhs.lastIndexOf('.') + 1) : lhs
    const col = rawCol
      .replace(/^["`]|["`]$/g, '')
      .trim()
      .toLowerCase()
    if (!col || !ROUTINE_API_KEY_USAGE_COLUMNS.has(col)) return false
  }
  return true
}

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
    this._rpcTimeoutMs = Math.max(50, Number(rpcTimeoutMs) || 90_000)
    this._sab = new SharedArrayBuffer(8)
    this._signal = new Int32Array(this._sab)
    this._seq = 0
    this._inTransaction = false
    this._txMutatedTables = new Set()
    this._closed = false
    this._workerDead = false
    this._workerDeadReason = ''
    this._staleDropped = 0
    this._timeouts = 0

    if (this._worker) {
      const wakeDead = (reason) => {
        this._workerDead = true
        this._workerDeadReason = reason
        this._inTransaction = false
        this._txMutatedTables.clear()
        Atomics.store(this._signal, SIGNAL_DEAD_INDEX, 1)
        Atomics.add(this._signal, SIGNAL_REPLY_INDEX, 1)
        Atomics.notify(this._signal, SIGNAL_REPLY_INDEX)
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

  _drainStaleMessages(beforeId) {
    let envelope = receiveMessageOnPort(this._port)
    while (envelope) {
      const msg = envelope.message
      if (msg && typeof msg.id === 'number' && msg.id >= beforeId) {
        throw Object.assign(
          new Error(`pg-sync-worker protocol error: unexpected response id=${msg.id} before request id=${beforeId}`),
          { code: 'PG_SYNC_PROTOCOL_ERROR' },
        )
      }
      this._staleDropped += 1
      envelope = receiveMessageOnPort(this._port)
    }
  }

  _rpc(op, sql = '', params = []) {
    if (this._closed) throw new Error('PostgreSQL sync connection is closed')
    if (this._workerDead || Atomics.load(this._signal, SIGNAL_DEAD_INDEX) !== 0) {
      throw new Error(this._workerDeadReason || 'pg-sync-worker is not running')
    }
    const id = ++this._seq
    this._drainStaleMessages(id)
    this._port.postMessage({ id, op, sql, params, sab: this._sab })
    const deadline = Date.now() + this._rpcTimeoutMs

    while (true) {
      if (this._workerDead || Atomics.load(this._signal, SIGNAL_DEAD_INDEX) !== 0) {
        throw new Error(this._workerDeadReason || 'pg-sync-worker exited during query')
      }
      // Snapshot reply counter BEFORE reading the MessagePort so a reply
      // posted concurrently cannot cause a missed Atomics.wait wakeup.
      const seen = Atomics.load(this._signal, SIGNAL_REPLY_INDEX)
      let envelope = receiveMessageOnPort(this._port)
      while (envelope) {
        const msg = envelope.message
        if (msg && typeof msg.id === 'number') {
          if (msg.id < id) {
            this._staleDropped += 1
            envelope = receiveMessageOnPort(this._port)
            continue
          }
          if (msg.id === id) {
            if (!msg.ok) {
              throw reconstructError(msg.error)
            }
            return msg.result
          }
          throw Object.assign(new Error(`pg-sync-worker protocol error: expected id=${id}, got id=${msg.id}`), {
            code: 'PG_SYNC_PROTOCOL_ERROR',
          })
        }
        envelope = receiveMessageOnPort(this._port)
      }

      if (Atomics.load(this._signal, SIGNAL_REPLY_INDEX) !== seen) {
        continue
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        this._timeouts += 1
        if (op === 'begin') {
          // Best-effort async rollback so a late-completing BEGIN cannot leak state.txClient.
          try {
            const rollbackId = ++this._seq
            this._port.postMessage({ id: rollbackId, op: 'rollback', sql: '', params: [], sab: this._sab })
          } catch {}
        }
        throw Object.assign(new Error(`pg-sync-worker timed out after ${this._rpcTimeoutMs}ms for op=${op}`), {
          code: 'PG_SYNC_TIMEOUT',
        })
      }

      Atomics.wait(this._signal, SIGNAL_REPLY_INDEX, seen, Math.min(remaining, WAIT_SLICE_MS))
    }
  }

  _recordMutation(sql) {
    if (!this._onMutation) return
    const tables = detectMutatedTables(sql)
    if (!tables.length) return
    const normalized =
      tables.length === 1 && tables[0] === 'api_keys' && isRoutineApiKeyUsageUpdate(sql) ? ['api_keys:usage'] : tables
    if (this._inTransaction) {
      for (const t of normalized) this._txMutatedTables.add(t)
    } else {
      try {
        this._onMutation(normalized)
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
      const stats = this._rpc('stats')
      if (!stats || typeof stats !== 'object') return stats
      return {
        ...stats,
        stale_dropped: this._staleDropped,
        timeouts: this._timeouts,
      }
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
