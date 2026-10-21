import { randomUUID } from 'node:crypto'
import { getDb, withTransaction } from '../db/database.mjs'

function cancelled() {
  return Object.assign(new Error('Request was cancelled'), { code: 'request_cancelled' })
}

function timedOut() {
  return Object.assign(new Error('Session queue timed out'), { code: 'session_queue_timeout' })
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => finish(cancelled())
    const timer = setTimeout(() => finish(), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Persistent per-session FIFO. Transaction locks protect state changes, never execution lifetimes.
 * Owner loss does not delete active or waiting rows; orphan recovery requires separate execution evidence.
 */
export class SharedSessionTurns {
  constructor(db = getDb(), { ownerId = 'controller_' + randomUUID() } = {}) {
    this.db = db
    this.ownerId = ownerId
  }

  async lock(sessionKey) {
    await this.db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      `vm2api:session-turn:${this.db.schema}`,
      sessionKey,
    ])
  }

  async enqueue(sessionKey, requestId) {
    const id = randomUUID()
    return withTransaction(this.db, async () => {
      // Allocate sequence under the same lock as activation, so an uncommitted
      // earlier insert cannot be invisible when a later waiter claims the head.
      await this.lock(sessionKey)
      await this.db
        .prepare(`INSERT INTO session_turns (id, session_key, owner_id, request_id, state)
          VALUES ($1,$2,$3,$4,'waiting')`)
        .run(id, sessionKey, this.ownerId, requestId ?? null)
      return { id, sessionKey, ownerId: this.ownerId }
    })
  }

  async tryActivate(handle) {
    return withTransaction(this.db, async () => {
      await this.lock(handle.sessionKey)
      const head = await this.db
        .prepare('SELECT * FROM session_turns WHERE session_key = $1 ORDER BY sequence LIMIT 1 FOR UPDATE')
        .get(handle.sessionKey)
      if (head?.id !== handle.id || head.owner_id !== handle.ownerId || head.state !== 'waiting') return false
      await this.db
        .prepare("UPDATE session_turns SET state = 'active', activated_at = clock_timestamp() WHERE id = $1")
        .run(handle.id)
      return true
    })
  }

  async removeWaiting(handle) {
    await this.db
      .prepare("DELETE FROM session_turns WHERE id = $1 AND owner_id = $2 AND state = 'waiting'")
      .run(handle.id, handle.ownerId)
  }

  async release(handle) {
    return withTransaction(this.db, async () => {
      await this.lock(handle.sessionKey)
      const result = await this.db
        .prepare(
          "DELETE FROM session_turns WHERE id = $1 AND owner_id = $2 AND state = 'active' AND uncertain_at IS NULL",
        )
        .run(handle.id, handle.ownerId)
      return { released: result.changes > 0 }
    })
  }

  async markUncertain(handle) {
    return withTransaction(this.db, async () => {
      await this.lock(handle.sessionKey)
      const result = await this.db
        .prepare(`UPDATE session_turns SET uncertain_at = COALESCE(uncertain_at, clock_timestamp())
          WHERE id = $1 AND owner_id = $2 AND state = 'active'`)
        .run(handle.id, handle.ownerId)
      return { uncertain: result.changes > 0 }
    })
  }

  async acquire(sessionKey, { requestId, signal, timeoutMs } = {}) {
    if (typeof sessionKey !== 'string' || !sessionKey.trim()) {
      throw Object.assign(new Error('Session key is required'), { code: 'invalid_session_turn' })
    }
    if (signal?.aborted) throw cancelled()
    const timeout = Number(timeoutMs)
    const deadline = Number.isFinite(timeout) && timeout > 0 ? Date.now() + timeout : Infinity
    const handle = await this.enqueue(sessionKey, requestId)
    try {
      for (;;) {
        if (signal?.aborted) throw cancelled()
        if (Date.now() >= deadline) throw timedOut()
        if (await this.tryActivate(handle)) {
          // Cancellation while activation committed is still proven not sent:
          // the caller has not received this turn or entered runOnce yet.
          if (signal?.aborted || Date.now() >= deadline) {
            await this.release(handle)
            if (signal?.aborted) throw cancelled()
            throw timedOut()
          }
          return {
            turnId: handle.id,
            release: () => this.release(handle),
            markUncertain: () => this.markUncertain(handle),
          }
        }
        await wait(Math.min(250, Math.max(1, deadline - Date.now())), signal)
      }
    } catch (error) {
      // Never delete an active turn if a transaction's outcome is unknown.
      await this.removeWaiting(handle)
      throw error
    }
  }
}
