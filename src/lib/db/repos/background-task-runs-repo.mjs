import { withTransaction } from '../database.mjs'

function invalidPlan() {
  return Object.assign(new Error('invalid background task plan'), { code: 'invalid_background_task', status: 400 })
}

function identifier(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalidPlan()
  return value
}

export class BackgroundTaskRunsRepo {
  constructor(db) {
    this.db = db
  }

  async now() {
    return (await this.db.prepare('SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now_ms').get()).now_ms
  }

  async tryClaim({ taskKey, executionId, intervalMs, ownerId }) {
    identifier(taskKey, 512)
    identifier(ownerId, 200)
    if (executionId == null) {
      if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw invalidPlan()
    } else {
      identifier(executionId, 1024)
      if (intervalMs != null) throw invalidPlan()
    }
    if (this.db.isTransaction) {
      throw Object.assign(new Error('background task requires an independently committed claim'), {
        code: 'background_task_transaction_active',
      })
    }
    return withTransaction(this.db, async () => {
      await this.db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        `vm2api:background:${this.db.schema}`,
        taskKey,
      ])
      const active = await this.db
        .prepare('SELECT execution_id FROM background_task_runs WHERE task_key = $1 AND finished_at IS NULL')
        .get(taskKey)
      if (active) return { ok: false, code: 'background_task_active' }
      const id = executionId ?? `interval:${intervalMs}:${Math.floor((await this.now()) / intervalMs)}`
      const previous = await this.db
        .prepare('SELECT shared_result FROM background_task_runs WHERE task_key = $1 AND execution_id = $2')
        .get(taskKey, id)
      if (previous) {
        return {
          ok: false,
          code: 'background_task_completed',
          ...(previous.shared_result == null ? {} : { sharedResult: previous.shared_result }),
        }
      }
      await this.db
        .prepare('INSERT INTO background_task_runs (task_key, execution_id, owner_id) VALUES ($1, $2, $3)')
        .run(taskKey, id, ownerId)
      return { ok: true, taskKey, executionId: id, ownerId }
    })
  }

  async markUnknown({ taskKey, executionId, ownerId }) {
    const result = await this.db
      .prepare(`UPDATE background_task_runs SET unknown_at = COALESCE(unknown_at, clock_timestamp())
        WHERE task_key = $1 AND execution_id = $2 AND owner_id = $3 AND finished_at IS NULL`)
      .run(taskKey, executionId, ownerId)
    return { unknown: result.changes > 0 }
  }

  async complete({ taskKey, executionId, ownerId }, { sharedResult } = {}) {
    const result = await this.db
      .prepare(`UPDATE background_task_runs
        SET shared_result = CASE WHEN finished_at IS NULL THEN $4::jsonb ELSE shared_result END,
            finished_at = COALESCE(finished_at, clock_timestamp())
        WHERE task_key = $1 AND execution_id = $2 AND owner_id = $3 AND unknown_at IS NULL`)
      .run(taskKey, executionId, ownerId, sharedResult == null ? null : JSON.stringify(sharedResult))
    return { completed: result.changes > 0 }
  }
}
