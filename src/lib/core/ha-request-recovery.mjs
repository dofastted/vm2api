import { getActivityCoordinator, getDb, withTransaction } from '../db/database.mjs'

/** Explicit recovery only. Closing a parent proves no late child can be admitted, not that a node ended. */
export class HaRequestRecovery {
  constructor(db = getDb(), { coordinator = getActivityCoordinator(db) } = {}) {
    if (!coordinator || coordinator.db !== db) throw new Error('HA recovery requires its activity coordinator')
    this.db = db
    this.coordinator = coordinator
  }

  async seal(requestId) {
    return withTransaction(this.db, async () => {
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
      await this.db
        .prepare(`UPDATE ha_request_contexts SET accepting_children=false,
        recovery_sealed_at=COALESCE(recovery_sealed_at,clock_timestamp()),
        recovery_sealed_by=COALESCE(recovery_sealed_by,$2) WHERE id=$1`)
        .run(requestId, this.coordinator.ownerId)
      return { sealed: true }
    })
  }
}
