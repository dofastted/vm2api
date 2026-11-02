import { getDb } from '../database.mjs'
import { enqueueWrite, writeBehindArmed } from '../write-behind.mjs'

function parse(value, fallback = null) {
  if (value == null) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function rowToAttempt(row) {
  if (!row) return null
  return {
    id: row.id,
    request_id: row.request_id,
    attempt_no: row.attempt_no,
    vm_id: row.vm_id,
    account_id: row.account_id,
    model: row.model,
    selection_reason: row.selection_reason,
    started_at: row.started_at,
    completed_at: row.completed_at,
    upstream_status: row.upstream_status,
    error_scope: row.error_scope,
    action: row.action,
    cooldown_until: row.cooldown_until,
    downstream_committed: !!row.downstream_committed,
    terminal_state: row.terminal_state,
    usage: parse(row.usage_json),
    wait_ms: row.wait_ms,
    queue_wait_ms: row.queue_wait_ms,
    scheduling_ms: row.scheduling_ms,
    ttft_ms: row.ttft_ms,
    latency_ms: row.latency_ms,
  }
}

export class RequestAttemptsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._insert = db.prepare(`
      INSERT INTO request_attempts (
        request_id, attempt_no, vm_id, account_id, model, selection_reason,
        started_at, completed_at, upstream_status, error_scope, action,
        cooldown_until, downstream_committed, terminal_state, usage_json,
        wait_ms, ttft_ms, latency_ms, queue_wait_ms, scheduling_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._complete = db.prepare(`
      UPDATE request_attempts SET
        completed_at = ?, upstream_status = ?, error_scope = ?, action = ?,
        cooldown_until = ?, downstream_committed = ?, terminal_state = ?,
        usage_json = ?, ttft_ms = ?, latency_ms = ?
      WHERE request_id = ? AND attempt_no = ?
    `)
    this._list = db.prepare(`
      SELECT * FROM request_attempts WHERE request_id = ? ORDER BY attempt_no
    `)
    this._removeOld = db.prepare(`
      DELETE FROM request_attempts WHERE started_at < ?
    `)
  }

  begin({
    requestId,
    attemptNo,
    vmId,
    accountId,
    model,
    selectionReason,
    waitMs = 0,
    queueWaitMs = null,
    schedulingMs = null,
  }) {
    const startedAt = new Date().toISOString()
    const write = () => {
      this._insert.run(
        requestId,
        attemptNo,
        vmId ?? null,
        accountId ?? null,
        model ?? null,
        selectionReason ?? null,
        startedAt,
        null,
        null,
        null,
        null,
        null,
        0,
        'started',
        null,
        waitMs ?? 0,
        null,
        null,
        queueWaitMs,
        schedulingMs,
      )
    }
    if (writeBehindArmed()) {
      enqueueWrite(write)
      return null
    }
    write()
    return this.list(requestId).find((item) => item.attempt_no === attemptNo) || null
  }

  complete(requestId, attemptNo, result = {}) {
    const completedAt = new Date().toISOString()
    const write = () => {
      this._complete.run(
        completedAt,
        result.upstreamStatus ?? null,
        result.errorScope ?? null,
        result.action ?? null,
        result.cooldownUntil ?? null,
        result.downstreamCommitted ? 1 : 0,
        result.terminalState ?? null,
        result.usage != null ? JSON.stringify(result.usage) : null,
        result.ttftMs ?? null,
        result.latencyMs ?? null,
        requestId,
        attemptNo,
      )
    }
    if (writeBehindArmed()) {
      enqueueWrite(write)
      return null
    }
    write()
    return this.list(requestId).find((item) => item.attempt_no === attemptNo) || null
  }

  list(requestId) {
    return this._list.all(requestId).map(rowToAttempt)
  }

  cleanup(retainDays = 7) {
    const days = Math.max(1, Number(retainDays) || 7)
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
    return this._removeOld.run(cutoff).changes
  }
}
