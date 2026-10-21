import { catalogIdCandidates, resolvePrice, validatePrice } from '../admin/price-catalog.mjs'
import { calculateCostAtPrice } from '../admin/pricing.mjs'
import { applyCacheTtlToUsage } from '../protocol/cache-ttl.mjs'
import { normalizeNodeReceipt } from './node-execution-proof.mjs'
import { normalizeNodeCompletion } from './node-execution-proof.mjs'
import { getActivityCoordinator, getDb, withTransaction } from '../db/database.mjs'
import { lockHaRequestContext, currentHaRequestContext } from './ha-request-context.mjs'
import { ApiKeysRepo } from '../db/repos/api-keys-repo.mjs'
import { isDeepStrictEqual } from 'node:util'

function invalid() {
  throw Object.assign(new Error('invalid HA billing snapshot'), { code: 'ha_billing_snapshot_invalid' })
}
function text(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) invalid()
  return value
}

export function normalizeHaBillingSnapshot(value) {
  if (
    !value ||
    value.version !== 1 ||
    Object.keys(value).some(
      (key) => !['version', 'model', 'rate_multiplier', 'cache_ttl', 'requested_speed', 'resolved'].includes(key),
    ) ||
    !Number.isFinite(value.rate_multiplier) ||
    value.rate_multiplier < 0 ||
    ![null, '5m', '1h'].includes(value.cache_ttl) ||
    ![null, 'standard', 'fast'].includes(value.requested_speed)
  )
    invalid()
  const result = {
    version: 1,
    model: text(value.model),
    rate_multiplier: value.rate_multiplier,
    cache_ttl: value.cache_ttl,
    requested_speed: value.requested_speed,
    resolved: null,
  }
  if (value.resolved !== null) {
    const resolved = value.resolved
    if (
      !resolved ||
      resolved.platform !== 'anthropic' ||
      Object.keys(resolved).some(
        (key) => !['id', 'platform', 'source', 'version', 'mode_sources', 'price'].includes(key),
      )
    )
      invalid()
    const validated = validatePrice(resolved.price, { platform: 'anthropic' })
    if (!validated.ok) invalid()
    result.resolved = {
      id: text(resolved.id),
      platform: 'anthropic',
      source: resolved.source == null ? null : text(resolved.source),
      version: resolved.version == null ? null : text(resolved.version),
      mode_sources: {},
      price: validated.price,
    }
  }
  return result
}

/** Called synchronously for the actual outbound body, before its job bind permits node submission. */
export function captureHaBillingSnapshot({ model, rateMultiplier = 1, cacheTtl = null, requestedSpeed = null }) {
  return normalizeHaBillingSnapshot({
    version: 1,
    model,
    rate_multiplier: rateMultiplier,
    cache_ttl: cacheTtl,
    requested_speed: requestedSpeed,
    resolved: resolvePrice(model, { refresh: false }),
  })
}

export function priceHaReceipt(receipt, snapshot) {
  try {
    const observed = normalizeNodeReceipt(receipt)
    const captured = normalizeHaBillingSnapshot(snapshot)
    if (
      !observed.usage_complete ||
      !captured.resolved ||
      !catalogIdCandidates(observed.model, 'anthropic').includes(captured.resolved.id)
    )
      return { known: false }
    const usage = {
      ...observed.usage,
      ...(observed.speed ? { speed: observed.speed } : {}),
      ...(observed.service_tier ? { service_tier: observed.service_tier } : {}),
      requested_speed: captured.requested_speed,
    }
    const effective = captured.cache_ttl ? applyCacheTtlToUsage(usage, captured.cache_ttl) : usage
    const pricing = calculateCostAtPrice(effective, observed.model, captured.resolved)
    const actualCost = pricing.total_cost * captured.rate_multiplier
    if (!pricing.known || !Number.isFinite(pricing.total_cost) || !Number.isFinite(actualCost)) return { known: false }
    return { known: true, pricing, actualCost }
  } catch {
    return { known: false }
  }
}

function failure(code) {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { code })
}

/** A final handler decision, not an ordering heuristic over failed attempts. */
export async function selectHaBillableCommand(db, commandId) {
  return withTransaction(db, async () => {
    const context = await lockHaRequestContext(db)
    if (!context) throw failure('ha_request_context_required')
    const job = await db
      .prepare(`SELECT j.request_id FROM execution_jobs j
      JOIN execution_admissions a ON a.id=j.admission_id AND a.ha_request_id=j.ha_request_id
      JOIN request_attempts t ON t.ha_request_id=j.ha_request_id AND t.attempt_no=j.attempt_no
        AND t.vm_id=a.vm_id AND t.account_id=a.account_id
      WHERE j.request_id=$1 AND j.ha_request_id=$2`)
      .get(commandId, context.requestId)
    if (!job) throw failure('ha_billable_command_mismatch')
    const row = await db
      .prepare(`UPDATE ha_request_contexts SET billable_command_id=$2
      WHERE id=$1 AND (billable_command_id IS NULL OR billable_command_id=$2) RETURNING id`)
      .get(context.requestId, commandId)
    if (!row) throw failure('ha_billable_command_mismatch')
    return { selected: true }
  })
}

/** One ledger row and one counter increment, under the same parent/key/reservation transaction. */
export class HaRequestBilling {
  constructor(db = getDb()) {
    this.db = db
    this.keys = new ApiKeysRepo(db)
  }

  async reconcile(requestId, { readRecoveryStatus } = {}) {
    let result = await this.settle(requestId, { source: 'recovery' })
    if (!result.query || typeof readRecoveryStatus !== 'function') return result
    let nodeStatus
    try {
      nodeStatus = await readRecoveryStatus(result.query)
    } catch {
      return { settled: false, reason: 'node_receipt_unavailable' }
    }
    result = await this.settle(requestId, { source: 'recovery', commandId: result.query.requestId, nodeStatus })
    return result
  }

  async settle(requestId, { source, commandId, nodeStatus, reservation: handle } = {}) {
    return withTransaction(this.db, async () => {
      if (source === 'handler') {
        const context = await lockHaRequestContext(this.db)
        if (context?.requestId !== requestId) throw failure('ha_request_context_mismatch')
      } else if (source !== 'recovery') throw failure('ha_billing_source_invalid')
      const request = await this.db.prepare('SELECT * FROM ha_request_contexts WHERE id=$1 FOR UPDATE').get(requestId)
      if (!request || request.recovery_kind !== 'claude_messages')
        return { settled: false, reason: 'request_kind_unproven' }
      if (source === 'recovery') {
        if (!request.recovery_sealed_at || !request.execution_recovered_at || request.accepting_children)
          return { settled: false, reason: 'ha_execution_unproven' }
        const coordinator = getActivityCoordinator(this.db)
        if (!coordinator) throw failure('ha_recovery_coordinator_required')
        const absent = await coordinator.lockAbsentOwner(request.activity_owner_id)
        if (!absent.absent) return { settled: false, reason: absent.reason }
      }
      const prior = await this.db.prepare('SELECT * FROM ha_request_settlements WHERE ha_request_id=$1').get(requestId)
      if (prior) {
        if (handle && (prior.reservation_id !== handle.reservationId || prior.command_id !== commandId))
          throw failure('invalid_api_key_reservation')
        if (handle) {
          const original = await this.db
            .prepare('SELECT owner_id FROM api_key_admissions WHERE id=$1 AND ha_request_id=$2')
            .get(prior.reservation_id, requestId)
          if (original?.owner_id !== handle.ownerId) throw failure('invalid_api_key_reservation')
        }
        if (source === 'recovery')
          await this.db
            .prepare(
              'UPDATE api_key_admissions SET released_at=COALESCE(released_at,clock_timestamp()) WHERE id=$1 AND ha_request_id=$2 AND key_id=$3',
            )
            .run(prior.reservation_id, requestId, prior.key_id)
        const priced =
          prior.node_receipt && prior.billing_snapshot
            ? priceHaReceipt(prior.node_receipt, prior.billing_snapshot)
            : null
        return {
          settled: true,
          outcome: prior.outcome,
          pricing: priced?.known ? priced.pricing : null,
          record: await this.keys.getById(prior.key_id),
        }
      }
      const before = await this.db.prepare('SELECT * FROM api_key_admissions WHERE ha_request_id=$1').get(requestId)
      if (!before) return { settled: true, outcome: 'no_managed_reservation' }
      // Same key -> reservation order as the legacy settle path. The parent is always first.
      await this.db.prepare('SELECT id FROM api_keys WHERE id=$1 FOR UPDATE').get(before.key_id)
      const reservation = await this.db
        .prepare('SELECT * FROM api_key_admissions WHERE id=$1 AND ha_request_id=$2 FOR UPDATE')
        .get(before.id, requestId)
      if (
        !reservation ||
        reservation.key_id !== before.key_id ||
        (handle && (handle.reservationId !== reservation.id || handle.ownerId !== reservation.owner_id))
      )
        throw failure('invalid_api_key_reservation')
      const jobs = await this.db
        .prepare('SELECT * FROM execution_jobs WHERE ha_request_id=$1 ORDER BY request_id')
        .all(requestId)
      let chosen = request.billable_command_id
      let outcome,
        priced = null,
        job = null,
        observed = null
      if (reservation.settled_at) outcome = 'already_settled'
      else if (!jobs.length && source === 'recovery') outcome = 'not_dispatched'
      else {
        if (reservation.released_at) return { settled: false, reason: 'api_key_reservation_released' }
        if (!chosen && source === 'recovery' && jobs.length === 1) {
          chosen = jobs[0].request_id
          await this.db
            .prepare('UPDATE ha_request_contexts SET billable_command_id=$2 WHERE id=$1')
            .run(requestId, chosen)
        }
        if (!chosen || (commandId && chosen !== commandId))
          return { settled: false, reason: 'ha_billable_command_unproven' }
        job = jobs.find((row) => row.request_id === chosen)
        if (!job?.ended_at || !job.node_binding || !job.node_completion)
          return { settled: false, reason: 'node_completion_unproven' }
        const linked = await this.db
          .prepare(`SELECT a.id FROM execution_admissions a JOIN request_attempts t
          ON t.ha_request_id=a.ha_request_id AND t.attempt_no=$3 AND t.vm_id=a.vm_id AND t.account_id=a.account_id
          WHERE a.id=$1 AND a.ha_request_id=$2`)
          .get(job.admission_id, requestId, job.attempt_no)
        if (!linked) return { settled: false, reason: 'request_job_binding_unproven' }
        try {
          normalizeNodeCompletion(job.node_completion, { requestId: chosen, nodeBinding: job.node_binding })
          if (nodeStatus) {
            if (nodeStatus.found !== true) return { settled: false, reason: 'node_receipt_unavailable' }
            const completion = normalizeNodeCompletion(nodeStatus.command, {
              requestId: chosen,
              nodeBinding: job.node_binding,
            })
            if (!isDeepStrictEqual(completion, job.node_completion))
              return { settled: false, reason: 'node_completion_unproven' }
            observed = normalizeNodeReceipt(nodeStatus.receipt)
            if (job.node_receipt && !isDeepStrictEqual(observed, job.node_receipt))
              return { settled: false, reason: 'node_receipt_mismatch' }
          } else if (job.node_receipt) observed = normalizeNodeReceipt(job.node_receipt)
          else
            return {
              settled: false,
              reason: 'node_receipt_required',
              query: { requestId: chosen, nodeBinding: structuredClone(job.node_binding) },
            }
        } catch {
          return { settled: false, reason: 'node_receipt_unproven' }
        }
        if (nodeStatus)
          await this.db
            .prepare('UPDATE execution_jobs SET node_receipt=$2::jsonb WHERE request_id=$1')
            .run(chosen, JSON.stringify(observed))
        priced = priceHaReceipt(observed, job.billing_snapshot)
        if (!priced.known) return { settled: false, reason: 'ha_usage_unpriced' }
        const record = await this.keys.recordUsage(reservation.key_id, {
          tokens_in: observed.usage.input_tokens,
          tokens_out: observed.usage.output_tokens,
          cache_read_tokens: observed.usage.cache_read_input_tokens,
          cache_creation_tokens: observed.usage.cache_creation_input_tokens,
          cost: priced.actualCost,
        })
        outcome = record ? 'charged' : 'key_deleted'
      }
      await this.db
        .prepare(`INSERT INTO ha_request_settlements(ha_request_id,reservation_id,key_id,user_id,command_id,node_binding,node_receipt,billing_snapshot,outcome,official_cost,actual_cost,tokens_in,tokens_out,cache_read_tokens,cache_creation_tokens)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`)
        .run(
          requestId,
          reservation.id,
          reservation.key_id,
          reservation.user_id,
          job?.request_id ?? chosen ?? null,
          job?.node_binding ? JSON.stringify(job.node_binding) : null,
          observed ? JSON.stringify(observed) : null,
          job?.billing_snapshot ? JSON.stringify(job.billing_snapshot) : null,
          outcome,
          priced?.known ? priced.pricing.total_cost : null,
          priced?.known ? priced.actualCost : null,
          observed?.usage.input_tokens ?? null,
          observed?.usage.output_tokens ?? null,
          observed?.usage.cache_read_input_tokens ?? null,
          observed?.usage.cache_creation_input_tokens ?? null,
        )
      await this.db
        .prepare(`UPDATE api_key_admissions SET
        settled_at=CASE WHEN $3='not_dispatched' THEN settled_at ELSE COALESCE(settled_at,clock_timestamp()) END,
        released_at=CASE WHEN $4 THEN COALESCE(released_at,clock_timestamp()) ELSE released_at END
        WHERE id=$1 AND ha_request_id=$2`)
        .run(reservation.id, requestId, outcome, source === 'recovery')
      return {
        settled: true,
        outcome,
        pricing: priced?.known ? priced.pricing : null,
        record: await this.keys.getById(reservation.key_id),
      }
    })
  }
}

export async function recordHaRequestUsage(db, { reservation, commandId, nodeStatus }) {
  if (reservation?.shared !== true) throw failure('invalid_api_key_reservation')
  const context = currentHaRequestContext(db)
  if (!context) throw failure('ha_request_context_required')
  await selectHaBillableCommand(db, commandId)
  const result = await new HaRequestBilling(db).settle(context.requestId, {
    source: 'handler',
    commandId,
    nodeStatus,
    reservation,
  })
  if (result.settled) reservation?._markSettled?.()
  else if (reservation) reservation.billingFailed = true
  return result
}
