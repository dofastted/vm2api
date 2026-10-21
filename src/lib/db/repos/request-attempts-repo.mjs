import { getDb } from '../database.mjs'

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
        wait_ms, ttft_ms, latency_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    `)
    this._complete = db.prepare(`
      UPDATE request_attempts SET
        completed_at = $1, upstream_status = $2, error_scope = $3, action = $4,
        cooldown_until = $5, downstream_committed = $6, terminal_state = $7,
        usage_json = $8, ttft_ms = $9, latency_ms = $10
      WHERE request_id = $11 AND attempt_no = $12
    `)
    this._list = db.prepare(`
      SELECT * FROM request_attempts WHERE request_id = $1 ORDER BY attempt_no
    `)
    this._removeOld = db.prepare(`
      DELETE FROM request_attempts WHERE started_at < $1
    `)
  }

  async begin({ requestId, attemptNo, vmId, accountId, model, selectionReason, waitMs = 0 }) {
    const startedAt = new Date().toISOString()
    await this._insert.run(
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
    )
    return (await this.list(requestId)).find((item) => item.attempt_no === attemptNo) || null
  }

  async complete(requestId, attemptNo, result = {}) {
    await this._complete.run(
      new Date().toISOString(),
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
    return (await this.list(requestId)).find((item) => item.attempt_no === attemptNo) || null
  }

  async list(requestId) {
    return (await this._list.all(requestId)).map(rowToAttempt)
  }

  async cleanup(retainDays = 7) {
    const days = Math.max(1, Number(retainDays) || 7)
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
    return (await this._removeOld.run(cutoff)).changes
  }
}
