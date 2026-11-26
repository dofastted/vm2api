import { getDb } from '../database.mjs'
import { enqueueWrite, writeBehindArmed } from '../write-behind.mjs'
import { sanitizeErrorDetailsForLog, sanitizeErrorToken } from '../../core/errors.mjs'
import { correlationIdForLog } from '../../protocol/log-fields.mjs'

function parse(value, fallback = null) {
  if (value == null) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function normalizeCooldownUntilMs(value) {
  if (value == null || value === '') return null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed)
      return Number.isFinite(n) ? Math.trunc(n) : null
    }
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null
  }
  return null
}

function normalizeProviderAttemptId(value) {
  if (value == null || value === '') return null
  if (typeof value === 'bigint') {
    const n = Number(value)
    return Number.isSafeInteger(n) && n >= 0 ? n : null
  }
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim())
    return Number.isSafeInteger(n) && n >= 0 ? n : null
  }
  return null
}

function rowToAttempt(row) {
  if (!row) return null
  const errorDetails = parse(row.error_details_json)
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
    error_code: row.error_code ?? null,
    upstream_type: row.upstream_type ?? errorDetails?.upstream_type ?? null,
    error_details: errorDetails,
    action: row.action,
    cooldown_until: row.cooldown_until,
    downstream_committed: !!row.downstream_committed,
    terminal_state: row.terminal_state,
    usage: parse(row.usage_json),
    hop_request_id: row.hop_request_id ?? null,
    provider_run_id: row.provider_run_id ?? null,
    provider_turn_id: row.provider_turn_id ?? null,
    provider_attempt_id: normalizeProviderAttemptId(row.provider_attempt_id),
    provider_request_id: row.provider_request_id ?? null,
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
        wait_ms, ttft_ms, latency_ms, queue_wait_ms, scheduling_ms,
        error_code, upstream_type, error_details_json,
        hop_request_id, provider_run_id, provider_turn_id, provider_attempt_id, provider_request_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._complete = db.prepare(`
      UPDATE request_attempts SET
        completed_at = ?, upstream_status = ?, error_scope = ?, action = ?,
        cooldown_until = ?, downstream_committed = ?, terminal_state = ?,
        usage_json = ?, ttft_ms = ?, latency_ms = ?,
        error_code = ?, upstream_type = ?, error_details_json = ?,
        hop_request_id = ?, provider_run_id = ?, provider_turn_id = ?,
        provider_attempt_id = ?, provider_request_id = ?
      WHERE request_id = ? AND attempt_no = ?
    `)
    this._list = db.prepare(`
      SELECT * FROM request_attempts WHERE request_id = ? ORDER BY attempt_no
    `)
    this._removeByRequestId = db.prepare(`
      DELETE FROM request_attempts WHERE request_id = ?
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
    hopRequestId = null,
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
        null,
        null,
        null,
        correlationIdForLog(hopRequestId),
        null,
        null,
        null,
        null,
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
    const errorCode = sanitizeErrorToken(result.errorCode, 128)
    const upstreamType = sanitizeErrorToken(result.upstreamType ?? result.errorDetails?.upstream_type, 128)
    const errorDetails = sanitizeErrorDetailsForLog(result.errorDetails, {
      status: result.upstreamStatus ?? null,
      upstreamType,
    })
    const hopRequestId = correlationIdForLog(result.hopRequestId)
    const providerRunId = correlationIdForLog(result.providerRunId)
    const providerTurnId = correlationIdForLog(
      typeof result.providerTurnId === 'number' &&
        Number.isSafeInteger(result.providerTurnId) &&
        result.providerTurnId >= 0
        ? String(result.providerTurnId)
        : result.providerTurnId,
    )
    const providerAttemptId = normalizeProviderAttemptId(result.providerAttemptId)
    const providerRequestId = correlationIdForLog(result.providerRequestId)
    const write = () => {
      this._complete.run(
        completedAt,
        result.upstreamStatus ?? null,
        result.errorScope ?? null,
        result.action ?? null,
        normalizeCooldownUntilMs(result.cooldownUntil),
        result.downstreamCommitted ? 1 : 0,
        result.terminalState ?? null,
        result.usage != null ? JSON.stringify(result.usage) : null,
        result.ttftMs ?? null,
        result.latencyMs ?? null,
        errorCode,
        upstreamType,
        errorDetails ? JSON.stringify(errorDetails) : null,
        hopRequestId,
        providerRunId,
        providerTurnId,
        providerAttemptId,
        providerRequestId,
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

  removeByRequestId(requestId) {
    if (!requestId) return 0
    const write = () => this._removeByRequestId.run(requestId).changes
    if (writeBehindArmed()) {
      enqueueWrite(write)
      return 0
    }
    return write()
  }

  cleanup(retainDays = 7) {
    const days = Math.max(1, Number(retainDays) || 7)
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
    return this._removeOld.run(cutoff).changes
  }
}
