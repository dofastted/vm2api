/**
 * Dedicated PostgreSQL worker thread backing synchronous DatabaseSync-compatible
 * callers (`PgSyncDb`) and off-thread `pg-read-worker` analytics scans.
 *
 * Uses 4-byte SharedArrayBuffer + Atomics.notify paired with MessagePort structured
 * cloning (`receiveMessageOnPort`), supporting arbitrarily large result sets with
 * near-zero memory overhead and full async pg.Pool concurrency across ports.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { createPgPool } from './pg-pool.mjs'
import { sanitizePgParams, splitSqlStatements, translateSqliteToPg } from './sql-compat.mjs'

const pgConfig = workerData?.pgConfig
const pool = createPgPool(pgConfig, { maxOverride: pgConfig?.syncPoolMax ?? pgConfig?.max ?? 12 })

/** Per-port transaction state: each connected client can pin its own pg.Client inside a tx. */
const portStates = new Map()

function serializeError(err) {
  return {
    message: String(err?.message || err),
    code: err?.code ? String(err.code) : undefined,
    detail: err?.detail ? String(err.detail) : undefined,
    constraint: err?.constraint ? String(err.constraint) : undefined,
    table: err?.table ? String(err.table) : undefined,
    schema: err?.schema ? String(err.schema) : undefined,
  }
}

async function runStatementOnExecutor(executor, op, rawSql, rawParams) {
  const translated = translateSqliteToPg(rawSql, { returningId: op === 'run' })
  if (translated.special?.kind === 'noop') {
    if (op === 'all') return []
    if (op === 'get') return undefined
    return { changes: 0, lastInsertRowid: 0 }
  }
  if (translated.special?.kind === 'static') {
    if (op === 'all') return translated.special.rows
    if (op === 'get') return translated.special.rows[0]
    return { changes: 0, lastInsertRowid: 0 }
  }

  const params = sanitizePgParams(rawParams)
  const res = await executor.query(translated.sql, params)

  if (op === 'all') return res.rows
  if (op === 'get') return res.rows[0]
  const changes = Number(res.rowCount) || 0
  const lastInsertRowid = translated.hasReturningId && res.rows?.[0]?.id != null ? Number(res.rows[0].id) || 0 : 0
  return { changes, lastInsertRowid }
}

async function handlePortMessage(port, state, msg) {
  const signal = msg?.sab ? new Int32Array(msg.sab) : null
  const reply = (payload) => {
    port.postMessage(payload)
    if (signal) {
      Atomics.store(signal, 0, 1)
      Atomics.notify(signal, 0, 1)
    }
  }

  try {
    const { id, op, sql, params } = msg

    if (op === 'begin') {
      if (!state.txClient) {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
        } catch (err) {
          client.release()
          throw err
        }
        state.txClient = client
      }
      reply({ id, ok: true, result: { inTransaction: true } })
      return
    }

    if (op === 'commit') {
      if (state.txClient) {
        const client = state.txClient
        state.txClient = null
        try {
          await client.query('COMMIT')
        } finally {
          client.release()
        }
      }
      reply({ id, ok: true, result: { inTransaction: false } })
      return
    }

    if (op === 'rollback') {
      if (state.txClient) {
        const client = state.txClient
        state.txClient = null
        try {
          await client.query('ROLLBACK')
        } catch {
        } finally {
          client.release()
        }
      }
      reply({ id, ok: true, result: { inTransaction: false } })
      return
    }

    if (op === 'exec') {
      const statements = splitSqlStatements(String(sql || ''))
      for (const stmt of statements) {
        if (/^\s*BEGIN(?:\s+(?:IMMEDIATE|DEFERRED|EXCLUSIVE))?\s*$/i.test(stmt)) {
          if (!state.txClient) {
            const client = await pool.connect()
            try {
              await client.query('BEGIN')
            } catch (err) {
              client.release()
              throw err
            }
            state.txClient = client
          }
          continue
        }
        if (/^\s*COMMIT\s*$/i.test(stmt)) {
          if (state.txClient) {
            const client = state.txClient
            state.txClient = null
            try {
              await client.query('COMMIT')
            } finally {
              client.release()
            }
          }
          continue
        }
        if (/^\s*ROLLBACK\s*$/i.test(stmt)) {
          if (state.txClient) {
            const client = state.txClient
            state.txClient = null
            try {
              await client.query('ROLLBACK')
            } catch {
            } finally {
              client.release()
            }
          }
          continue
        }
        const executor = state.txClient || pool
        await runStatementOnExecutor(executor, 'exec', stmt, [])
      }
      reply({ id, ok: true, result: { inTransaction: !!state.txClient } })
      return
    }

    if (op === 'get' || op === 'all' || op === 'run') {
      const executor = state.txClient || pool
      const result = await runStatementOnExecutor(executor, op, sql, params)
      reply({ id, ok: true, result })
      return
    }

    if (op === 'stats') {
      reply({
        id,
        ok: true,
        result: {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
          active: Math.max(0, pool.totalCount - pool.idleCount),
          max: pool.options?.max ?? null,
        },
      })
      return
    }

    throw new Error(`unknown pg-sync-worker op: ${op}`)
  } catch (err) {
    reply({ id: msg?.id, ok: false, error: serializeError(err) })
  }
}

function attachPort(port) {
  const state = { txClient: null, queue: Promise.resolve() }
  portStates.set(port, state)

  // Serialize messages per port so BEGIN -> queries -> COMMIT execute in strict order,
  // while independent ports (e.g. multiple pg-read-worker threads) run concurrently.
  port.on('message', (msg) => {
    state.queue = state.queue.then(() => handlePortMessage(port, state, msg)).catch(() => {})
  })

  port.on('close', () => {
    portStates.delete(port)
    if (state.txClient) {
      const client = state.txClient
      state.txClient = null
      client
        .query('ROLLBACK')
        .catch(() => {})
        .finally(() => client.release())
    }
  })
}

parentPort.on('message', async (msg) => {
  if (msg?.op === 'attach' && msg.port) {
    attachPort(msg.port)
    return
  }
  if (msg?.op === 'shutdown') {
    for (const [port, state] of portStates) {
      if (state.txClient) {
        const client = state.txClient
        state.txClient = null
        try {
          await client.query('ROLLBACK')
        } catch {}
        client.release()
      }
      try {
        port.close()
      } catch {}
    }
    portStates.clear()
    try {
      await pool.end()
    } catch {}
    parentPort.postMessage({ shutdown: true })
  }
})

pool
  .query('SELECT 1')
  .then(() => parentPort.postMessage({ ready: true }))
  .catch((err) => parentPort.postMessage({ ready: false, error: String(err?.message || err) }))
