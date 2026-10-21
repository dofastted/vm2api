import { AsyncLocalStorage } from 'node:async_hooks'
import { getActivityCoordinator, getDb } from '../db/database.mjs'
import { isKubernetesHaMode } from './control-plane-mode.mjs'

const requests = new AsyncLocalStorage()

function failure(code) {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { code })
}

export function currentHaRequestContext(db = getDb()) {
  if (!isKubernetesHaMode()) return null
  const context = requests.getStore()
  if (!context) throw failure('ha_request_context_required')
  if (context.db.schema !== db.schema || context.db.connectionString !== db.connectionString)
    throw failure('ha_request_context_mismatch')
  context.assertActive()
  return context
}

/** Must run inside the same short transaction as a new child row. */
export async function lockHaRequestContext(db) {
  const context = currentHaRequestContext(db)
  if (!context) return null
  if (!db.isTransaction) throw failure('ha_request_transaction_required')
  const row = await db.prepare('SELECT * FROM ha_request_contexts WHERE id=$1 FOR UPDATE').get(context.requestId)
  if (
    !row ||
    row.activity_id !== context.activityId ||
    row.activity_owner_id !== context.activityOwnerId ||
    String(row.activity_epoch) !== String(context.activityEpoch)
  )
    throw failure('ha_request_context_mismatch')
  if (!row.accepting_children) throw failure('ha_request_context_closed')
  return context
}

/** Correlation only: closing this context never releases a lease or unknown work. */
export async function withHaRequestContext({ db = getDb(), requestId, activity }, callback) {
  if (!isKubernetesHaMode()) return callback()
  if (requests.getStore()) throw failure('ha_request_context_nested')
  const coordinator = getActivityCoordinator(db)
  const scope = coordinator?.assertActivity()
  if (
    !scope ||
    activity?.activityId !== scope.id ||
    activity?.ownerId !== coordinator.ownerId ||
    String(activity?.epoch) !== String(scope.epoch)
  )
    throw failure('ha_request_activity_mismatch')
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128)
    throw failure('ha_request_id_invalid')
  const inserted = await db
    .prepare(`INSERT INTO ha_request_contexts(id,activity_id,activity_owner_id,activity_epoch)
    VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING id`)
    .get(requestId, scope.id, coordinator.ownerId, scope.epoch)
  if (!inserted) throw failure('ha_request_context_exists')
  let active = true
  const context = Object.freeze({
    db,
    requestId,
    activityId: scope.id,
    activityOwnerId: coordinator.ownerId,
    activityEpoch: scope.epoch,
    attemptNo: null,
    assertActive: () => {
      if (!active) throw failure('ha_request_context_closed')
    },
  })
  try {
    return await requests.run(context, callback)
  } finally {
    active = false
    const returned = await db
      .prepare(`UPDATE ha_request_contexts SET accepting_children=false,handler_returned_at=clock_timestamp()
      WHERE id=$1 AND activity_id=$2 AND activity_owner_id=$3 AND activity_epoch=$4 RETURNING id`)
      .get(requestId, scope.id, coordinator.ownerId, scope.epoch)
    if (!returned) throw failure('ha_request_context_mismatch')
  }
}

export function withHaRequestAttempt(attemptNo, callback) {
  if (!isKubernetesHaMode()) return callback()
  const context = requests.getStore()
  if (!context) throw failure('ha_request_context_required')
  context.assertActive()
  if (!Number.isSafeInteger(attemptNo) || attemptNo <= 0) throw failure('ha_request_attempt_invalid')
  return requests.run(Object.freeze({ ...context, attemptNo }), callback)
}
