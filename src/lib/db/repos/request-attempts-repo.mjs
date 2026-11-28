import { getDb } from '../database.mjs'
import { enqueueWrite, writeBehindArmed } from '../write-behind.mjs'
import { getPgLogWriter } from '../pg/pg-log-writer.mjs'
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
  constructor(db = getDb(), { pgLogWriter = null, forceSyncWrite = false } = {}) {
    this.db = db
    this._pgLogWriter = pgLogWriter
    this._forceSyncWrite = !!forceSyncWrite
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

  _activePgLogWriter() {
    if (this._forceSyncWrite) return null
    if (this._pgLogWriter) {
      return this._pgLogWriter.stats?.().closed ? null : this._pgLogWriter
    }
    if (this.db?.engine !== 'postgres') return null
    const writer = getPgLogWriter()
    return writer && !writer.stats?.().closed ? writer : null
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
    const safeHopRequestId = correlationIdForLog(hopRequestId)
    const pgWriter = this._activePgLogWriter()
    if (pgWriter) {
      pgWriter.enqueueAttempt({
        request_id: requestId,
        attempt_no: attemptNo,
        vm_id: vmId ?? null,
        account_id: accountId ?? null,
        model: model ?? null,
        selection_reason: selectionReason ?? null,
        started_at: startedAt,
        completed_at: null,
        upstream_status: null,
        error_scope: null,
        action: null,
        cooldown_until: null,
        downstream_committed: 0,
        terminal_state: 'started',
        usage_json: null,
        wait_ms: waitMs ?? 0,
        ttft_ms: null,
        latency_ms: null,
        queue_wait_ms: queueWaitMs,
        scheduling_ms: schedulingMs,
        error_code: null,
        upstream_type: null,
        error_details_json: null,
        hop_request_id: safeHopRequestId,
        provider_run_id: null,
        provider_turn_id: null,
        provider_attempt_id: null,
        provider_request_id: null,
      })
      return null
    }
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
        safeHopRequestId,
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
    const cooldownUntil = normalizeCooldownUntilMs(result.cooldownUntil)
    const usageJson = result.usage != null ? JSON.stringify(result.usage) : null
    const errorDetailsJson = errorDetails ? JSON.stringify(errorDetails) : null
    const pgWriter = this._activePgLogWriter()
    if (pgWriter) {
      pgWriter.enqueueAttempt({
        request_id: requestId,
        attempt_no: attemptNo,
        completed_at: completedAt,
        upstream_status: result.upstreamStatus ?? null,
        error_scope: result.errorScope ?? null,
        action: result.action ?? null,
        cooldown_until: cooldownUntil,
        downstream_committed: result.downstreamCommitted ? 1 : 0,
        terminal_state: result.terminalState ?? null,
        usage_json: usageJson,
        ttft_ms: result.ttftMs ?? null,
        latency_ms: result.latencyMs ?? null,
        error_code: errorCode,
        upstream_type: upstreamType,
        error_details_json: errorDetailsJson,
        hop_request_id: hopRequestId,
        provider_run_id: providerRunId,
        provider_turn_id: providerTurnId,
        provider_attempt_id: providerAttemptId,
        provider_request_id: providerRequestId,
      })
      return null
    }
    const write = () => {
      this._complete.run(
        completedAt,
        result.upstreamStatus ?? null,
        result.errorScope ?? null,
        result.action ?? null,
        cooldownUntil,
        result.downstreamCommitted ? 1 : 0,
        result.terminalState ?? null,
        usageJson,
        result.ttftMs ?? null,
        result.latencyMs ?? null,
        errorCode,
        upstreamType,
        errorDetailsJson,
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

  /** Single-shot attempt upsert (accepts snake_case or camelCase fields). */
  record(attempt = {}) {
    if (!attempt || typeof attempt !== 'object') return null
    const requestId = attempt.request_id ?? attempt.requestId
    const attemptNo = attempt.attempt_no ?? attempt.attemptNo
    if (!requestId || attemptNo == null) return null

    const startedAt = attempt.started_at ?? attempt.startedAt ?? new Date().toISOString()
    const completedAt = attempt.completed_at ?? attempt.completedAt ?? null
    const errorCode = sanitizeErrorToken(attempt.error_code ?? attempt.errorCode, 128)
    const rawErrDetails = attempt.error_details ?? attempt.errorDetails
    const upstreamType = sanitizeErrorToken(
      attempt.upstream_type ?? attempt.upstreamType ?? rawErrDetails?.upstream_type,
      128,
    )
    const errorDetails = sanitizeErrorDetailsForLog(rawErrDetails, {
      status: attempt.upstream_status ?? attempt.upstreamStatus ?? null,
      upstreamType,
    })
    const hopRequestId = correlationIdForLog(attempt.hop_request_id ?? attempt.hopRequestId)
    const providerRunId = correlationIdForLog(attempt.provider_run_id ?? attempt.providerRunId)
    const rawTurnId = attempt.provider_turn_id ?? attempt.providerTurnId
    const providerTurnId = correlationIdForLog(
      typeof rawTurnId === 'number' && Number.isSafeInteger(rawTurnId) && rawTurnId >= 0
        ? String(rawTurnId)
        : rawTurnId,
    )
    const providerAttemptId = normalizeProviderAttemptId(attempt.provider_attempt_id ?? attempt.providerAttemptId)
    const providerRequestId = correlationIdForLog(attempt.provider_request_id ?? attempt.providerRequestId)
    const cooldownUntil = normalizeCooldownUntilMs(attempt.cooldown_until ?? attempt.cooldownUntil)
    const rawUsage = attempt.usage_json !== undefined ? attempt.usage_json : attempt.usage
    const usageJson = rawUsage == null ? null : typeof rawUsage === 'string' ? rawUsage : JSON.stringify(rawUsage)
    const errorDetailsJson =
      attempt.error_details_json !== undefined
        ? attempt.error_details_json
        : errorDetails
          ? JSON.stringify(errorDetails)
          : null

    const pgWriter = this._activePgLogWriter()
    if (pgWriter) {
      pgWriter.enqueueAttempt({
        request_id: requestId,
        attempt_no: attemptNo,
        vm_id: attempt.vm_id ?? attempt.vmId ?? null,
        account_id: attempt.account_id ?? attempt.accountId ?? null,
        model: attempt.model ?? null,
        selection_reason: attempt.selection_reason ?? attempt.selectionReason ?? null,
        started_at: startedAt,
        completed_at: completedAt,
        upstream_status: attempt.upstream_status ?? attempt.upstreamStatus ?? null,
        error_scope: attempt.error_scope ?? attempt.errorScope ?? null,
        action: attempt.action ?? null,
        cooldown_until: cooldownUntil,
        downstream_committed: (attempt.downstream_committed ?? attempt.downstreamCommitted) ? 1 : 0,
        terminal_state: attempt.terminal_state ?? attempt.terminalState ?? 'started',
        usage_json: usageJson,
        wait_ms: attempt.wait_ms ?? attempt.waitMs ?? 0,
        ttft_ms: attempt.ttft_ms ?? attempt.ttftMs ?? null,
        latency_ms: attempt.latency_ms ?? attempt.latencyMs ?? null,
        queue_wait_ms: attempt.queue_wait_ms ?? attempt.queueWaitMs ?? null,
        scheduling_ms: attempt.scheduling_ms ?? attempt.schedulingMs ?? null,
        error_code: errorCode,
        upstream_type: upstreamType,
        error_details_json: errorDetailsJson,
        hop_request_id: hopRequestId,
        provider_run_id: providerRunId,
        provider_turn_id: providerTurnId,
        provider_attempt_id: providerAttemptId,
        provider_request_id: providerRequestId,
      })
      return null
    }

    const write = () => {
      this._insert.run(
        requestId,
        attemptNo,
        attempt.vm_id ?? attempt.vmId ?? null,
        attempt.account_id ?? attempt.accountId ?? null,
        attempt.model ?? null,
        attempt.selection_reason ?? attempt.selectionReason ?? null,
        startedAt,
        completedAt,
        attempt.upstream_status ?? attempt.upstreamStatus ?? null,
        attempt.error_scope ?? attempt.errorScope ?? null,
        attempt.action ?? null,
        cooldownUntil,
        (attempt.downstream_committed ?? attempt.downstreamCommitted) ? 1 : 0,
        attempt.terminal_state ?? attempt.terminalState ?? 'started',
        usageJson,
        attempt.wait_ms ?? attempt.waitMs ?? 0,
        attempt.ttft_ms ?? attempt.ttftMs ?? null,
        attempt.latency_ms ?? attempt.latencyMs ?? null,
        attempt.queue_wait_ms ?? attempt.queueWaitMs ?? null,
        attempt.scheduling_ms ?? attempt.schedulingMs ?? null,
        errorCode,
        upstreamType,
        errorDetailsJson,
        hopRequestId,
        providerRunId,
        providerTurnId,
        providerAttemptId,
        providerRequestId,
      )
    }
    if (writeBehindArmed()) {
      enqueueWrite(write)
      return null
    }
    write()
    return this.list(requestId).find((item) => item.attempt_no === Number(attemptNo)) || null
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
