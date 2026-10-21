import crypto from 'node:crypto'
import { withTransaction } from '../database.mjs'
import { ApiKeysRepo } from './api-keys-repo.mjs'
import { UsersRepo } from './users-repo.mjs'
import { lockHaRequestContext } from '../../core/ha-request-context.mjs'

/** Shared concurrency, request-quota reservations and the rolling RPM history. */
export class ApiKeyAdmissionsRepo {
  constructor(db) {
    this.db = db
    this.keys = new ApiKeysRepo(db)
    this.users = new UsersRepo(db)
  }

  async reserve(keyId, ownerId, validate) {
    return withTransaction(this.db, async () => {
      const context = await lockHaRequestContext(this.db)
      // Every admission locks key then owner. The owner lock serializes
      // requests made with different keys belonging to the same user.
      const record = await this.keys.getById(keyId, { forUpdate: true })
      const owner = record?.user_id ? await this.users.getById(record.user_id, { forUpdate: true }) : null
      const { now } = await this.db.prepare('SELECT clock_timestamp() AS now').get()
      const nowMs = now.getTime()
      if (!record) return validate(record, { owner, now: nowMs })
      // Released rows outlive the full RPM window. Active rows never expire,
      // including those whose original controller has disconnected or died.
      await this.db
        .prepare(`DELETE FROM api_key_admissions
        WHERE key_id = $1 AND released_at IS NOT NULL AND created_at <= $2::timestamptz - interval '60 seconds'`)
        .run(keyId, now)
      const state = await this.db
        .prepare(`SELECT
        count(*) FILTER (WHERE released_at IS NULL) AS inflight,
        count(*) FILTER (WHERE released_at IS NULL AND settled_at IS NULL) AS pending_requests,
        count(*) FILTER (WHERE created_at > $2::timestamptz - interval '60 seconds') AS rpm_count,
        min(created_at) FILTER (WHERE created_at > $2::timestamptz - interval '60 seconds') AS rpm_oldest
        FROM api_key_admissions WHERE key_id = $1`)
        .get(keyId, now)
      const userInflight = record.user_id
        ? (
            await this.db
              .prepare('SELECT count(*) AS count FROM api_key_admissions WHERE user_id = $1 AND released_at IS NULL')
              .get(record.user_id)
          ).count
        : 0
      const gate = await validate(record, {
        owner,
        now: nowMs,
        inflight: state.inflight,
        pendingRequests: state.pending_requests,
        userInflight,
        rpmCount: state.rpm_count,
        retryAfterMs: state.rpm_oldest ? Math.max(1, state.rpm_oldest.getTime() + 60_000 - nowMs) : undefined,
      })
      if (!gate.ok) return gate
      const reservationId = crypto.randomUUID()
      await this.db
        .prepare(`INSERT INTO api_key_admissions (id, key_id, user_id, owner_id, created_at, ha_request_id)
        VALUES ($1, $2, $3, $4, $5, $6)`)
        .run(reservationId, keyId, record.user_id, ownerId, now, context?.requestId ?? null)
      return { ok: true, record, reservationId, ownerId }
    })
  }

  async release({ reservationId, ownerId }) {
    // Retain the history: cancellation releases concurrency/quota but a
    // request admitted in the last minute still consumes RPM.
    await this.db
      .prepare(`UPDATE api_key_admissions SET released_at = clock_timestamp()
      WHERE id = $1 AND owner_id = $2 AND released_at IS NULL`)
      .run(reservationId, ownerId)
  }

  async settle(keyId, { reservationId, ownerId }, recordUsage) {
    return withTransaction(this.db, async () => {
      // Match reserve's key lock. The counter increment and pending-quota
      // removal become visible in one commit, so neither overlaps nor gaps.
      const record = await this.keys.getById(keyId, { forUpdate: true })
      if (!record) return null
      const row = await this.db.prepare('SELECT * FROM api_key_admissions WHERE id = $1 FOR UPDATE').get(reservationId)
      if (!row || row.key_id !== keyId || row.owner_id !== ownerId) {
        throw Object.assign(new Error('Invalid API key reservation'), { code: 'invalid_api_key_reservation' })
      }
      if (row.settled_at) return record
      if (row.released_at) {
        throw Object.assign(new Error('API key reservation has been released'), {
          code: 'api_key_reservation_released',
        })
      }
      const saved = await recordUsage()
      await this.db
        .prepare('UPDATE api_key_admissions SET settled_at = clock_timestamp() WHERE id = $1')
        .run(reservationId)
      return saved
    })
  }

  async inflight() {
    return new Map(
      (
        await this.db
          .prepare(`SELECT key_id, count(*) AS count FROM api_key_admissions
      WHERE released_at IS NULL GROUP BY key_id`)
          .all()
      ).map((row) => [row.key_id, row.count]),
    )
  }
}
