import crypto from 'node:crypto'
import { withTransaction } from '../database.mjs'
import { physicalContainerName, physicalVmAliases } from '../../vm/vm-physical-target.mjs'
import { readWatchdogState } from '../../transport/kernel-watchdog-state.mjs'
import { ExecutionCircuitsRepo } from './execution-circuits-repo.mjs'
import { normalizeNodeBinding, normalizeNodeCompletion, sameNodeBinding } from '../../core/node-execution-proof.mjs'
import { lockHaRequestContext } from '../../core/ha-request-context.mjs'

function invalid(field) {
  return Object.assign(new Error(`Invalid execution admission ${field}`), { code: 'invalid_execution_admission' })
}

function identifier(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(field)
  return value
}

function limit(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(field)
  return value
}

function denied(code, inflight, max, extra = {}) {
  return { ok: false, code, reason: code, detail: { inflight, max }, ...extra }
}

function jobError(code) {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { code })
}

/** Short PostgreSQL transactions for global account/VM execution limits. */
export class ExecutionAdmissionsRepo {
  constructor(db, { ownerId = 'controller_' + crypto.randomUUID(), assertRoutingRevision = null } = {}) {
    this.db = db
    this.ownerId = identifier(ownerId, 'ownerId')
    this.routingRevisionCheck = assertRoutingRevision
    this.circuits = new ExecutionCircuitsRepo(this)
  }

  async assertRoutingRevision(revision) {
    if (!this.routingRevisionCheck) return
    if (!this.db.isTransaction) throw jobError('execution_transaction_required')
    await this.routingRevisionCheck(revision)
  }

  /** Shared order: device (caller), account, then every involved VM sorted. */
  async lockResources({ accountId, vmIds = [] } = {}) {
    if (!this.db.isTransaction) {
      throw Object.assign(new Error('Execution resource locks require a transaction'), {
        code: 'execution_transaction_required',
      })
    }
    if (!Array.isArray(vmIds)) throw invalid('vmIds')
    const resources = vmIds.flatMap((id) => {
      identifier(id, 'vmId')
      return [...physicalVmAliases(id).map((alias) => 'vm:' + alias), 'vm-target:' + physicalContainerName(id)]
    })
    if (accountId != null) resources.push('account:' + identifier(accountId, 'accountId'))
    for (const resource of [...new Set(resources)].sort()) {
      await this.db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        `vm2api:execution:${this.db.schema}`,
        resource,
      ])
    }
  }

  async lockVm(vmId) {
    return this.lockResources({ vmIds: [vmId] })
  }

  async _counts(accountId, vmId, now) {
    const row = await this.db
      .prepare(`SELECT
        count(*) FILTER (WHERE account_id = $1 AND released_at IS NULL) AS account_inflight,
        count(*) FILTER (WHERE vm_id = ANY($2::text[]) AND released_at IS NULL) AS vm_inflight,
        count(*) FILTER (WHERE account_id = $1 AND released_at IS NULL AND model_family = 'fable') AS fable_inflight,
        count(*) FILTER (WHERE account_id = $1 AND created_at > $3::timestamptz - interval '60 seconds') AS rpm_count,
        min(created_at) FILTER (WHERE account_id = $1 AND created_at > $3::timestamptz - interval '60 seconds') AS rpm_oldest
        FROM execution_admissions WHERE account_id = $1 OR vm_id = ANY($2::text[])`)
      .get(accountId, vmId == null ? [] : physicalVmAliases(vmId), now)
    return {
      accountInflight: row.account_inflight,
      vmInflight: row.vm_inflight,
      fableInflight: row.fable_inflight,
      rpmCount: row.rpm_count,
      rpmResetAt: row.rpm_oldest ? row.rpm_oldest.getTime() + 60_000 : null,
    }
  }

  /** An eligibility snapshot only; tryReserve is the atomic admission gate. */
  async getCounts({ accountId, vmId } = {}) {
    if (accountId != null) identifier(accountId, 'accountId')
    if (vmId != null) identifier(vmId, 'vmId')
    if (accountId == null && vmId == null) throw invalid('resource')
    const { now } = await this.db.prepare('SELECT clock_timestamp() AS now').get()
    const counts = await this._counts(accountId ?? null, vmId ?? null, now)
    const fault = vmId == null ? null : (await readWatchdogState(this.db, vmId)).fault
    return fault ? { ...counts, kernelFault: fault } : counts
  }

  async tryReserve(input = {}) {
    const accountId = identifier(input.accountId, 'accountId')
    const vmId = identifier(input.vmId, 'vmId')
    const ownerId = identifier(input.ownerId === undefined ? this.ownerId : input.ownerId, 'ownerId')
    const requestId = identifier(input.requestId === undefined ? crypto.randomUUID() : input.requestId, 'requestId')
    const accountLimit = limit(input.accountLimit, 'accountLimit')
    const vmLimit = limit(input.vmLimit, 'vmLimit')
    const fableLimit = limit(input.fableLimit, 'fableLimit')
    const rpmLimit = limit(input.rpmLimit, 'rpmLimit')
    const family = input.family == null ? null : identifier(input.family, 'family')
    return withTransaction(this.db, async () => {
      const context = await lockHaRequestContext(this.db)
      await this.assertRoutingRevision(input.routingRevision)
      await this.lockResources({ accountId, vmIds: [vmId] })
      const operation = await this.db
        .prepare(`SELECT id FROM vm_operations WHERE released_at IS NULL
          AND (vm_id = ANY($1::text[]) OR account_id=$2) LIMIT 1`)
        .get(physicalVmAliases(vmId), accountId)
      if (operation) return denied('vm_operation_active', 0, vmLimit)
      // A candidate may have been read before a completed management hold.
      // Check every physical alias under the same VM locks after the hold commits.
      const held = await this.db
        .prepare('SELECT id FROM vms WHERE id = ANY($1::text[]) AND schedulable IS DISTINCT FROM 1 LIMIT 1')
        .get(physicalVmAliases(vmId))
      if (held) return denied('vm_not_schedulable', 0, vmLimit)
      if ((await readWatchdogState(this.db, vmId)).fault) return denied('kernel_faulted', 0, vmLimit)
      const alias = await this.db
        .prepare(`SELECT id FROM execution_admissions
          WHERE vm_id = ANY($1::text[]) AND vm_id <> $2 AND released_at IS NULL LIMIT 1`)
        .get(physicalVmAliases(vmId), vmId)
      if (alias) return denied('vm_physical_target_conflict', 0, vmLimit)
      const { now } = await this.db.prepare('SELECT clock_timestamp() AS now').get()
      await this.db
        .prepare(`DELETE FROM execution_admissions WHERE account_id = $1
          AND released_at IS NOT NULL AND created_at <= $2::timestamptz - interval '60 seconds'`)
        .run(accountId, now)
      const counts = await this._counts(accountId, vmId, now)
      // Concurrency zero disables execution; RPM/Fable zero adds no sublimit.
      if (counts.accountInflight >= accountLimit)
        return denied('concurrency_limit', counts.accountInflight, accountLimit)
      if (counts.vmInflight >= vmLimit) return denied('vm_concurrency_limit', counts.vmInflight, vmLimit)
      if (family === 'fable' && fableLimit > 0 && counts.fableInflight >= fableLimit) {
        return denied('fable_concurrency', counts.fableInflight, fableLimit)
      }
      if (rpmLimit > 0 && counts.rpmCount >= rpmLimit) {
        return denied('rpm_limit', counts.rpmCount, rpmLimit, {
          retry_after_ms: Math.max(1, counts.rpmResetAt - now.getTime()),
        })
      }
      const admissionId = crypto.randomUUID()
      const circuit =
        input.circuit && !input.pinned ? await this.circuits.admit(accountId, admissionId, now, input.circuit) : null
      if (circuit && !circuit.ok) return circuit
      const record = await this.db
        .prepare(`INSERT INTO execution_admissions (id, owner_id, request_id, account_id, vm_id, model_family, created_at, circuit_revision, ha_request_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`)
        .get(
          admissionId,
          ownerId,
          context?.requestId ?? requestId,
          accountId,
          vmId,
          family,
          now,
          circuit?.revision ?? null,
          context?.requestId ?? null,
        )
      const handle = { admissionId, ownerId }
      return {
        ok: true,
        admissionId,
        ownerId,
        requestId,
        accountId,
        vmId,
        record,
        release: (options) => this.release(handle, options),
        markUncertain: () => this.markUncertain(handle),
        bindExecution: (execution) => this.bindExecution(handle, execution),
        completeExecution: (execution) => this.completeExecution(handle, execution),
        noteCircuitResult: async (outcome) => {
          if (!input.circuit || input.pinned) return { updated: false }
          try {
            return await this.circuits.noteResult(handle, outcome, input.circuit)
          } catch (error) {
            await this.markUncertain(handle)
            throw error
          }
        },
      }
    })
  }

  async markUncertain({ admissionId, ownerId }) {
    const result = await this.db
      .prepare(`UPDATE execution_admissions SET uncertain_at = COALESCE(uncertain_at, clock_timestamp())
        WHERE id = $1 AND owner_id = $2 AND released_at IS NULL`)
      .run(admissionId, ownerId)
    return { uncertain: result.changes > 0 }
  }

  async _lockAdmission({ admissionId, ownerId }) {
    return this.db
      .prepare('SELECT * FROM execution_admissions WHERE id = $1 AND owner_id = $2 FOR UPDATE')
      .get(admissionId, ownerId)
  }

  async bindExecution(handle, execution) {
    const nodeBinding = execution?.nodeBinding === undefined ? null : normalizeNodeBinding(execution.nodeBinding)
    return withTransaction(this.db, async () => {
      const context = await lockHaRequestContext(this.db)
      const before = await this.db
        .prepare('SELECT account_id, vm_id FROM execution_admissions WHERE id = $1 AND owner_id = $2')
        .get(handle.admissionId, handle.ownerId)
      if (!before) throw jobError('execution_admission_inactive')
      // Refresh may hold this exact admission after its previous job ended.
      // Serialize with that operation before taking the admission row lock.
      await this.lockResources({ accountId: before.account_id, vmIds: [before.vm_id] })
      const admission = await this._lockAdmission(handle)
      if (
        !admission ||
        admission.released_at ||
        admission.uncertain_at ||
        admission.account_id !== before.account_id ||
        admission.vm_id !== before.vm_id
      ) {
        throw jobError('execution_admission_inactive')
      }
      if (typeof execution?.requestId !== 'string' || !execution.requestId.trim()) {
        throw jobError('invalid_execution_job')
      }
      if ((admission.ha_request_id ?? null) !== (context?.requestId ?? null))
        throw jobError('ha_request_context_mismatch')
      if (context) {
        if (!nodeBinding || !context.attemptNo) throw jobError('ha_request_attempt_missing')
        const attempt = await this.db
          .prepare(`SELECT id FROM request_attempts WHERE ha_request_id=$1
          AND attempt_no=$2 AND vm_id=$3 AND account_id=$4`)
          .get(context.requestId, context.attemptNo, admission.vm_id, admission.account_id)
        if (!attempt) throw jobError('ha_request_attempt_missing')
      }
      if (nodeBinding && nodeBinding.vmId !== admission.vm_id) throw jobError('execution_node_binding_mismatch')
      const operation = await this.db
        .prepare(`SELECT id FROM vm_operations WHERE released_at IS NULL
          AND (vm_id = ANY($1::text[]) OR account_id=$2) LIMIT 1`)
        .get(physicalVmAliases(admission.vm_id), admission.account_id)
      if (operation) throw jobError('vm_operation_active')
      const pending = await this.db
        .prepare('SELECT request_id FROM execution_jobs WHERE admission_id = $1 AND ended_at IS NULL LIMIT 1')
        .get(handle.admissionId)
      if (pending) throw jobError('execution_job_pending')
      const row = await this.db
        .prepare(`INSERT INTO execution_jobs (request_id, admission_id, node_binding, ha_request_id, attempt_no) VALUES ($1, $2, $3::jsonb, $4, $5)
        ON CONFLICT (request_id) DO NOTHING RETURNING request_id`)
        .get(
          execution.requestId,
          handle.admissionId,
          nodeBinding ? JSON.stringify(nodeBinding) : null,
          context?.requestId ?? null,
          context?.attemptNo ?? null,
        )
      if (!row) throw jobError('execution_job_exists')
      return {
        bound: true,
        admissionId: handle.admissionId,
        requestId: execution.requestId,
        ...(nodeBinding ? { nodeBinding } : {}),
      }
    })
  }

  async completeExecution(handle, execution) {
    const result = await withTransaction(this.db, async () => {
      const admission = await this._lockAdmission(handle)
      if (!admission) throw jobError('execution_admission_inactive')
      const valid =
        typeof execution?.requestId === 'string' &&
        execution.requestId.trim() &&
        typeof execution.started === 'boolean' &&
        typeof execution.ended === 'boolean' &&
        typeof execution.reason === 'string' &&
        execution.reason.trim()
      if (!valid) {
        await this.markUncertain(handle)
        // Commit the uncertainty before reporting the invalid metadata.
        return { error: 'invalid_execution_job' }
      }
      const job = await this.db
        .prepare('SELECT * FROM execution_jobs WHERE request_id = $1 AND admission_id = $2')
        .get(execution.requestId, handle.admissionId)
      if (!job) {
        await this.markUncertain(handle)
        return { error: 'execution_job_mismatch' }
      }
      let nodeCompletion = null
      if (job.node_binding) {
        try {
          if (!sameNodeBinding(execution.nodeBinding, job.node_binding))
            throw jobError('execution_node_binding_mismatch')
          if (execution.ended)
            nodeCompletion = normalizeNodeCompletion(execution.nodeCompletion, {
              requestId: execution.requestId,
              nodeBinding: job.node_binding,
            })
        } catch {
          await this.markUncertain(handle)
          return { error: 'execution_node_unconfirmed' }
        }
      } else if (execution.nodeBinding !== undefined || execution.nodeCompletion !== undefined) {
        await this.markUncertain(handle)
        return { error: 'execution_node_binding_mismatch' }
      }
      if (job.ended_at) return { ended: true, uncertain: !!admission.uncertain_at, requestId: execution.requestId }
      await this.db
        .prepare(`UPDATE execution_jobs SET
        ended_at = CASE WHEN $1 THEN clock_timestamp() ELSE ended_at END,
        started = COALESCE(started, false) OR $2, reason = $3, node_completion = $6::jsonb
        WHERE request_id = $4 AND admission_id = $5 AND ended_at IS NULL`)
        .run(
          execution.ended,
          execution.started,
          execution.reason,
          execution.requestId,
          handle.admissionId,
          nodeCompletion ? JSON.stringify(nodeCompletion) : null,
        )
      if (!execution.ended) await this.markUncertain(handle)
      return {
        ended: execution.ended,
        uncertain: !execution.ended || !!admission.uncertain_at,
        requestId: execution.requestId,
      }
    })
    if (result.error) throw jobError(result.error)
    return result
  }

  async release(handle, { uncertain = false } = {}) {
    if (uncertain) return this.markUncertain(handle)
    return withTransaction(this.db, async () => {
      // Lock before the pending-job query so a concurrent bind commits before
      // this statement takes its snapshot. An UPDATE alone can use an older one.
      if (!(await this._lockAdmission(handle))) return { released: false }
      const result = await this.db
        .prepare(`UPDATE execution_admissions SET released_at = clock_timestamp()
          WHERE id = $1 AND owner_id = $2 AND released_at IS NULL AND uncertain_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM execution_jobs j WHERE j.admission_id = execution_admissions.id AND j.ended_at IS NULL)`)
        .run(handle.admissionId, handle.ownerId)
      if (result.changes > 0) await this.circuits.releaseProbe(handle.admissionId)
      return { released: result.changes > 0 }
    })
  }
}
