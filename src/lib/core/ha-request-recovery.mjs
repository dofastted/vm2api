import { getActivityCoordinator, getDb, withTransaction } from '../db/database.mjs'
import { isDeepStrictEqual } from 'node:util'
import { normalizeNodeBinding, normalizeNodeCompletion } from './node-execution-proof.mjs'
import { SharedExecutionAdmissions } from '../pool/shared-execution-admissions.mjs'
import { SharedSessionTurns } from '../pool/shared-session-turns.mjs'
import { HaRequestBilling } from './ha-request-billing.mjs'

function unchangedGraph(graph) {
  return {
    admissions: graph.admissions.map((row) => [row.id, row.account_id, row.vm_id, row.seat_key, row.seat_generation]),
    jobs: graph.jobs.map((row) => [
      row.request_id,
      row.admission_id,
      row.ha_request_id,
      row.attempt_no,
      row.node_binding,
    ]),
    attempts: graph.attempts.map((row) => [row.id, row.attempt_no, row.vm_id, row.account_id]),
  }
}

/** Explicit recovery only. Closing a parent proves no late child can be admitted, not that a node ended. */
export class HaRequestRecovery {
  constructor(db = getDb(), { coordinator = getActivityCoordinator(db), readNodeRecoveryStatus = null } = {}) {
    if (!coordinator || coordinator.db !== db) throw new Error('HA recovery requires its activity coordinator')
    this.db = db
    this.coordinator = coordinator
    this.readNodeRecoveryStatus = readNodeRecoveryStatus
  }

  /** Candidate discovery is read-only. recover() proves owner loss again for every exact parent. */
  async scan({ limit = 20, afterRequestId = null } = {}) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (afterRequestId !== null &&
        (typeof afterRequestId !== 'string' || !afterRequestId || afterRequestId.length > 128))
    ) {
      throw Object.assign(new Error('invalid HA recovery scan'), { code: 'ha_recovery_scan_invalid' })
    }
    const scope = this.coordinator.assertActivity()
    const rows = await this.db
      .prepare(`SELECT r.id FROM ha_request_contexts r
      JOIN ${this.coordinator.qualified}.activities a ON a.id=r.activity_id
        AND a.owner_id=r.activity_owner_id AND a.epoch=r.activity_epoch
      JOIN ${this.coordinator.qualified}.control c ON c.id=1 AND c.phase='open'
        AND c.epoch=r.activity_epoch AND c.epoch=$3
      WHERE r.recovery_kind='claude_messages' AND ($1::text IS NULL OR r.id>$1)
        AND ((r.execution_recovered_at IS NULL AND (a.completed_at IS NULL OR r.recovery_sealed_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM execution_admissions e WHERE e.ha_request_id=r.id AND e.released_at IS NULL)
          OR EXISTS (SELECT 1 FROM execution_jobs j WHERE j.ha_request_id=r.id AND j.ended_at IS NULL)))
          OR EXISTS (SELECT 1 FROM api_key_admissions k WHERE k.ha_request_id=r.id AND k.released_at IS NULL))
      ORDER BY r.id LIMIT $2`)
      .all(afterRequestId, limit + 1, scope.epoch)
    const page = rows.slice(0, limit)
    const results = []
    for (const row of page) {
      try {
        results.push({ requestId: row.id, ...(await this.recover(row.id)) })
      } catch (error) {
        const code = /^[A-Za-z0-9_]{1,80}$/.test(error?.code) ? error.code : 'ha_recovery_failed'
        results.push({ requestId: row.id, recovered: false, errorCode: code })
      }
    }
    return { results, nextCursor: rows.length > limit ? page.at(-1).id : null }
  }

  async seal(requestId) {
    return withTransaction(this.db, async () => {
      const { request, ...result } = await this._seal(requestId)
      return result
    })
  }

  async _seal(requestId) {
    const request = await this.db.prepare('SELECT * FROM ha_request_contexts WHERE id=$1 FOR UPDATE').get(requestId)
    if (!request) return { sealed: false, reason: 'request_missing' }
    if (request.recovery_kind !== 'claude_messages') return { sealed: false, reason: 'request_kind_unproven' }
    const absent = await this.coordinator.lockAbsentOwner(request.activity_owner_id)
    if (!absent.absent) return { sealed: false, reason: absent.reason }
    const scope = this.coordinator.assertActivity()
    const activity = (
      await this.db.query(`SELECT * FROM ${this.coordinator.qualified}.activities WHERE id=$1 FOR UPDATE`, [
        request.activity_id,
      ])
    ).rows[0]
    if (
      !activity ||
      activity.owner_id !== request.activity_owner_id ||
      String(activity.epoch) !== String(request.activity_epoch) ||
      String(request.activity_epoch) !== String(scope.epoch)
    ) {
      return { sealed: false, reason: 'request_activity_mismatch' }
    }
    const sibling = await this.db
      .prepare('SELECT id FROM ha_request_contexts WHERE activity_id=$1 AND id<>$2 LIMIT 1')
      .get(request.activity_id, requestId)
    if (sibling) return { sealed: false, reason: 'request_activity_ambiguous' }
    const operation = (
      await this.db.query(
        `SELECT id FROM ${this.coordinator.qualified}.operations WHERE source_activity_id=$1 AND ended_at IS NULL LIMIT 1`,
        [request.activity_id],
      )
    ).rows[0]
    if (operation) return { sealed: false, reason: 'request_operation_pending' }
    const sealed = await this.db
      .prepare(`UPDATE ha_request_contexts SET accepting_children=false,
        recovery_sealed_at=COALESCE(recovery_sealed_at,clock_timestamp()),
        recovery_sealed_by=COALESCE(recovery_sealed_by,$2) WHERE id=$1 RETURNING *`)
      .get(requestId, this.coordinator.ownerId)
    return { sealed: true, request: sealed }
  }

  async _graph(requestId) {
    const admissions = await this.db
      .prepare('SELECT * FROM execution_admissions WHERE ha_request_id=$1 ORDER BY id')
      .all(requestId)
    const jobs = await this.db
      .prepare(
        `SELECT * FROM execution_jobs WHERE ha_request_id=$1 OR admission_id=ANY($2::text[]) ORDER BY request_id`,
      )
      .all(
        requestId,
        admissions.map((row) => row.id),
      )
    const attempts = await this.db
      .prepare('SELECT id,attempt_no,vm_id,account_id FROM request_attempts WHERE ha_request_id=$1 ORDER BY id')
      .all(requestId)
    const turns = await this.db.prepare('SELECT * FROM session_turns WHERE ha_request_id=$1 ORDER BY id').all(requestId)
    return { admissions, jobs, attempts, turns }
  }

  _validGraph(requestId, graph) {
    for (const job of graph.jobs) {
      const admission = graph.admissions.find((row) => row.id === job.admission_id)
      const attempts = graph.attempts.filter(
        (row) =>
          row.attempt_no === job.attempt_no &&
          row.vm_id === admission?.vm_id &&
          row.account_id === admission?.account_id,
      )
      if (!admission || job.ha_request_id !== requestId || attempts.length !== 1 || !job.node_binding) return false
      try {
        if (normalizeNodeBinding(job.node_binding).vmId !== admission.vm_id) return false
      } catch {
        return false
      }
    }
    return true
  }

  async _billingHeld(requestId) {
    return !!(await this.db
      .prepare('SELECT id FROM api_key_admissions WHERE ha_request_id=$1 AND released_at IS NULL LIMIT 1')
      .get(requestId))
  }

  /** readCompletion authenticates the original node; it must never substitute current State or a new command. */
  async recover(requestId, { readCompletion, readRecoveryStatus = this.readNodeRecoveryStatus } = {}) {
    const snapshot = await withTransaction(this.db, async () => {
      const sealed = await this._seal(requestId)
      if (!sealed.sealed) return { reason: sealed.reason }
      if (sealed.request.execution_recovered_at) return { already: true }
      const graph = await this._graph(requestId)
      return this._validGraph(requestId, graph) ? { graph } : { reason: 'request_job_binding_unproven' }
    })
    if (snapshot.reason) return { recovered: false, reason: snapshot.reason }
    if (snapshot.already) return this._bill(requestId, readRecoveryStatus)
    const proofs = new Map()
    for (const job of snapshot.graph.jobs) {
      try {
        const value =
          job.ended_at && job.node_completion
            ? job.node_completion
            : readRecoveryStatus
              ? (
                  await readRecoveryStatus({
                    requestId: job.request_id,
                    nodeBinding: structuredClone(job.node_binding),
                  })
                )?.command
              : await readCompletion?.({ requestId: job.request_id, nodeBinding: structuredClone(job.node_binding) })
        proofs.set(
          job.request_id,
          normalizeNodeCompletion(value, { requestId: job.request_id, nodeBinding: job.node_binding }),
        )
      } catch {
        return { recovered: false, reason: 'node_completion_unproven' }
      }
    }
    const result = await withTransaction(this.db, async () => {
      const sealed = await this._seal(requestId)
      if (!sealed.sealed) return { recovered: false, reason: sealed.reason }
      if (sealed.request.execution_recovered_at)
        return { recovered: true, billingHeld: await this._billingHeld(requestId) }
      const graph = await this._graph(requestId)
      if (
        !this._validGraph(requestId, graph) ||
        !isDeepStrictEqual(unchangedGraph(graph), unchangedGraph(snapshot.graph))
      ) {
        return { recovered: false, reason: 'request_graph_changed' }
      }
      const shared = new SharedExecutionAdmissions(this.db)
      const turns = new SharedSessionTurns(this.db)
      for (const key of [...new Set(graph.admissions.map((row) => row.seat_key).filter(Boolean))].sort())
        await shared.lockDevice(key)
      const seats = await Promise.all(
        graph.admissions.filter((row) => row.seat_key).map((row) => shared.readSeat(row.seat_key)),
      )
      for (const accountId of [...new Set(graph.admissions.map((row) => row.account_id))].sort())
        await shared.executions.lockResources({ accountId })
      await shared.executions.lockResources({
        vmIds: [
          ...new Set([...graph.admissions.map((row) => row.vm_id), ...seats.filter(Boolean).map((row) => row.vm_id)]),
        ],
      })
      for (const key of [...new Set(graph.turns.map((row) => row.session_key))].sort()) await turns.lock(key)
      await this.db
        .prepare('SELECT id FROM execution_admissions WHERE ha_request_id=$1 ORDER BY id FOR UPDATE')
        .all(requestId)
      await this.db
        .prepare('SELECT request_id FROM execution_jobs WHERE ha_request_id=$1 ORDER BY request_id FOR UPDATE')
        .all(requestId)
      const current = await this._graph(requestId)
      if (!isDeepStrictEqual(unchangedGraph(current), unchangedGraph(snapshot.graph)))
        return { recovered: false, reason: 'request_graph_changed' }
      for (const job of current.jobs) {
        await this.db
          .prepare(`UPDATE execution_jobs SET ended_at=COALESCE(ended_at,clock_timestamp()),started=true,
          reason='node_completed_recovery',node_completion=$3::jsonb WHERE request_id=$1 AND ha_request_id=$2`)
          .run(job.request_id, requestId, JSON.stringify(proofs.get(job.request_id)))
      }
      for (const admission of current.admissions) {
        const result = await this.db
          .prepare(`UPDATE execution_admissions SET released_at=clock_timestamp()
          WHERE id=$1 AND ha_request_id=$2 AND released_at IS NULL`)
          .run(admission.id, requestId)
        if (!result.changes) continue
        await shared.executions.circuits.releaseProbe(admission.id)
        if (!admission.seat_key) continue
        const seat = await shared.readSeat(admission.seat_key)
        if (!seat || seat.generation !== admission.seat_generation || seat.inflight) continue
        if (seat.grace_ms > 0) {
          await this.db
            .prepare(`UPDATE execution_seats SET grace_until=clock_timestamp()+grace_ms*interval '1 millisecond'
            WHERE seat_key=$1 AND generation=$2`)
            .run(admission.seat_key, admission.seat_generation)
        } else {
          await this.db
            .prepare('DELETE FROM execution_seats WHERE seat_key=$1 AND generation=$2')
            .run(admission.seat_key, admission.seat_generation)
        }
      }
      for (const turn of current.turns)
        await this.db
          .prepare('DELETE FROM session_turns WHERE id=$1 AND owner_id=$2 AND ha_request_id=$3')
          .run(turn.id, turn.owner_id, requestId)
      await this.db.query(
        `UPDATE ${this.coordinator.qualified}.activities SET completed_at=COALESCE(completed_at,clock_timestamp()),
        reason='ha_request_execution_recovered' WHERE id=$1 AND owner_id=$2 AND epoch=$3`,
        [sealed.request.activity_id, sealed.request.activity_owner_id, sealed.request.activity_epoch],
      )
      await this.db
        .prepare('UPDATE ha_request_contexts SET execution_recovered_at=clock_timestamp() WHERE id=$1')
        .run(requestId)
      return { recovered: true, billingHeld: await this._billingHeld(requestId) }
    })
    return result.recovered ? this._bill(requestId, readRecoveryStatus) : result
  }

  async _bill(requestId, readRecoveryStatus) {
    const { record, ...billing } = await new HaRequestBilling(this.db).reconcile(requestId, { readRecoveryStatus })
    return { recovered: true, billingHeld: !billing.settled, billing }
  }
}
