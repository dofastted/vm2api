/** Global activity drain and durable restore latch, outside the restored application schema. */
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import { quoteIdentifier } from './database.mjs'

const activities = new AsyncLocalStorage()
const TRY_SHARED = 'SELECT pg_try_advisory_lock_shared(hashtext(current_database()), hashtext($1)) AS acquired'
const TRY_SHARED_TX = 'SELECT pg_try_advisory_xact_lock_shared(hashtext(current_database()), hashtext($1)) AS acquired'
const UNLOCK_SHARED = 'SELECT pg_advisory_unlock_shared(hashtext(current_database()), hashtext($1))'
const TRY_EXCLUSIVE = 'SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext($1)) AS acquired'
const EXCLUSIVE = 'SELECT pg_advisory_lock(hashtext(current_database()), hashtext($1))'
const UNLOCK_EXCLUSIVE = 'SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1))'
const BUSINESS_CLAIMS = [
  ['execution_admissions', 'released_at IS NULL'],
  ['execution_jobs', 'ended_at IS NULL'],
  ['api_key_admissions', 'released_at IS NULL'],
  ['vm_operations', 'released_at IS NULL'],
  ['background_task_runs', 'finished_at IS NULL'],
  ['session_turns', 'true'],
]

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details })
}

export function coordinationSchemaFor(applicationSchema) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(applicationSchema)) throw new Error('invalid database schema')
  return 'vm2api_coord_' + crypto.createHash('sha256').update(applicationSchema).digest('hex').slice(0, 32)
}

function stateOf(row) {
  return {
    phase: row.phase,
    epoch: Number(row.epoch),
    operationId: row.operation_id,
    ownerId: row.owner_id,
    kind: row.kind,
    reason: row.reason,
  }
}

/** One instance per process incarnation. A disconnected incarnation cannot reconnect its old scopes. */
export class GlobalMaintenanceCoordinator {
  constructor(db, { ownerId = crypto.randomUUID(), onLost = null } = {}) {
    this.db = db
    this.ownerId = ownerId
    this.onLost = onLost
    this.schema = coordinationSchemaFor(db.schema)
    this.qualified = quoteIdentifier(this.schema)
    this.activityResource = `vm2api:global-activity:${db.schema}`
    this.adminResource = `vm2api:global-maintenance:${db.schema}`
    this._client = null
    this._healthy = false
    this._lost = false
    this._closing = false
    this._held = false
    this._refs = 0
    this._serial = Promise.resolve()
    this._onError = (error) => this._lose(error)
    this._onEnd = () => this._lose(failure('maintenance_connection_lost', 'Activity connection ended'))
  }

  get healthy() {
    return this._healthy
  }

  _exclusiveLocal(fn) {
    const pending = this._serial.then(fn)
    this._serial = pending.catch(() => {})
    return pending
  }

  _assertHealthy() {
    if (!this._healthy || this._lost || this._closing) {
      throw failure('maintenance_connection_lost', 'Activity connection is unavailable; restart is required')
    }
  }

  _lose(error) {
    if (this._closing || this._lost) return
    this._healthy = false
    this._lost = true
    this.onLost?.(error)
  }

  _connection(label) {
    return new pg.Client({
      connectionString: this.db.connectionString,
      application_name: `vm2api-${label}`,
      connectionTimeoutMillis: 5000,
      statement_timeout: 60000,
    })
  }

  async _transaction(fn) {
    const client = await this.db.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async _initialize() {
    const q = this.qualified
    await this._transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext($1))', [
        `vm2api:coordination-bootstrap:${this.db.schema}`,
      ])
      const namespace = (
        await client.query(
          `SELECT pg_get_userbyid(nspowner) = current_user AS owned
        FROM pg_namespace WHERE nspname = $1`,
          [this.schema],
        )
      ).rows[0]
      if (namespace && !namespace.owned) {
        throw failure('maintenance_schema_owner', 'Coordination schema belongs to another role')
      }
      if (namespace) {
        const control = (await client.query('SELECT to_regclass($1) AS name', [`${q}.control`])).rows[0].name
        if (!control) throw failure('maintenance_schema_unrecognized', 'Coordination schema has no ownership record')
        const binding = (await client.query(`SELECT application_schema FROM ${q}.control WHERE id = 1`)).rows[0]
        if (binding?.application_schema !== this.db.schema) {
          throw failure('maintenance_schema_mismatch', 'Coordination schema belongs to another application schema')
        }
      }
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${q} AUTHORIZATION CURRENT_USER;
        REVOKE ALL ON SCHEMA ${q} FROM PUBLIC;
        CREATE TABLE IF NOT EXISTS ${q}.control (
          id integer PRIMARY KEY CHECK (id = 1),
          application_schema text NOT NULL,
          phase text NOT NULL CHECK (phase IN ('open','draining','restoring','rebinding','blocked')),
          epoch bigint NOT NULL CHECK (epoch > 0),
          operation_id text,
          owner_id text,
          kind text,
          reason text,
          changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
        );
        CREATE TABLE IF NOT EXISTS ${q}.members (
          owner_id text PRIMARY KEY,
          bound_epoch bigint,
          started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          stopped_at timestamptz
        );
        CREATE TABLE IF NOT EXISTS ${q}.activities (
          id text PRIMARY KEY,
          owner_id text NOT NULL,
          epoch bigint NOT NULL,
          kind text NOT NULL,
          request_id text,
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          completed_at timestamptz,
          uncertain_at timestamptz,
          reason text
        );
        CREATE INDEX IF NOT EXISTS activities_pending ON ${q}.activities (owner_id) WHERE completed_at IS NULL;
        REVOKE ALL ON ALL TABLES IN SCHEMA ${q} FROM PUBLIC`)
      await client.query(
        `INSERT INTO ${q}.control(id,application_schema,phase,epoch)
        VALUES (1,$1,'open',1) ON CONFLICT (id) DO NOTHING`,
        [this.db.schema],
      )
    })
  }

  async start() {
    if (this._healthy) return this
    if (this._starting) return this._starting
    if (this._lost || this._closing) throw failure('maintenance_connection_lost', 'Restart is required')
    this._starting = (async () => {
      await this._initialize()
      const client = this._connection('activity')
      client.on('error', this._onError)
      client.on('end', this._onEnd)
      try {
        await client.connect()
        this._client = client
        await this.db.pool.query(`INSERT INTO ${this.qualified}.members(owner_id) VALUES ($1)`, [this.ownerId])
        if (this._lost) throw failure('maintenance_connection_lost', 'Activity connection ended during startup')
        this._healthy = true
        return this
      } catch (error) {
        client.removeListener('error', this._onError)
        client.removeListener('end', this._onEnd)
        await client.end().catch(() => {})
        this._client = null
        throw error
      }
    })()
    try {
      return await this._starting
    } finally {
      this._starting = null
    }
  }

  async getState() {
    const row = (await this.db.pool.query(`SELECT * FROM ${this.qualified}.control WHERE id = 1`)).rows[0]
    if (!row || row.application_schema !== this.db.schema) {
      throw failure('maintenance_schema_mismatch', 'Coordination ownership record is unavailable')
    }
    return stateOf(row)
  }

  async acknowledgeEpoch(epoch) {
    this._assertHealthy()
    return this._transaction(async (client) => {
      const row = (await client.query(`SELECT * FROM ${this.qualified}.control WHERE id = 1 FOR SHARE`)).rows[0]
      if (!Number.isSafeInteger(epoch) || Number(row.epoch) !== epoch || !['open', 'rebinding'].includes(row.phase)) {
        throw failure('database_maintenance', 'The loaded application epoch cannot be acknowledged')
      }
      const updated = await client.query(
        `UPDATE ${this.qualified}.members SET bound_epoch = $2
        WHERE owner_id = $1 AND stopped_at IS NULL`,
        [this.ownerId, epoch],
      )
      if (updated.rowCount !== 1) throw failure('maintenance_connection_lost', 'Pod registration is unavailable')
      return stateOf(row)
    })
  }

  /** New activities always use another session; session-lock reentry cannot bypass a restore waiter. */
  async admit({ kind = 'request', requestId = null } = {}) {
    return this._exclusiveLocal(async () => {
      this._assertHealthy()
      try {
        if (!this._held) {
          const result = await this._client.query(TRY_SHARED, [this.activityResource])
          if (!result.rows[0].acquired) throw failure('database_maintenance', 'Global maintenance is in progress')
          this._held = true
        }
        const id = crypto.randomUUID()
        const epoch = await this._transaction(async (client) => {
          if (!(await client.query(TRY_SHARED_TX, [this.activityResource])).rows[0].acquired) {
            throw failure('database_maintenance', 'Global maintenance is waiting for activities to finish')
          }
          const row = (await client.query(`SELECT * FROM ${this.qualified}.control WHERE id = 1 FOR SHARE`)).rows[0]
          if (row.phase !== 'open') throw failure('database_maintenance', 'Global maintenance is in progress')
          const member = (
            await client.query(
              `SELECT bound_epoch FROM ${this.qualified}.members
            WHERE owner_id = $1 AND stopped_at IS NULL`,
              [this.ownerId],
            )
          ).rows[0]
          if (!member || Number(member.bound_epoch) !== Number(row.epoch)) {
            throw failure('maintenance_epoch_unbound', 'Pod caches have not loaded the current application epoch')
          }
          this._assertHealthy()
          await client.query(
            `INSERT INTO ${this.qualified}.activities(id,owner_id,epoch,kind,request_id)
            VALUES ($1,$2,$3,$4,$5)`,
            [id, this.ownerId, row.epoch, kind, requestId],
          )
          return Number(row.epoch)
        })
        this._assertHealthy()
        this._refs += 1
        return this._gate(id, epoch)
      } catch (error) {
        if (!this._refs) await this._releaseHolder()
        throw error
      }
    })
  }

  _gate(id, epoch) {
    const scope = { coordinator: this, id, epoch, active: true }
    const assertActive = () => {
      this._assertHealthy()
      if (!scope.active) throw failure('maintenance_activity_closed', 'The activity scope has completed')
    }
    const gate = {
      activityId: id,
      ownerId: this.ownerId,
      epoch,
      assertActive,
      run: (fn) => {
        assertActive()
        return activities.run(scope, fn)
      },
      complete: (execution) => this._complete(scope, execution),
      markUncertain: (reason) => this._complete(scope, { ended: false, reason }),
    }
    return gate
  }

  assertActivity() {
    this._assertHealthy()
    const scope = activities.getStore()
    if (scope?.coordinator !== this || !scope.active) {
      throw failure('maintenance_activity_closed', 'SQL requires a live admitted activity scope')
    }
    return scope
  }

  async _complete(scope, execution) {
    return this._exclusiveLocal(async () => {
      this._assertHealthy()
      const result = await this._transaction(async (client) => {
        const row = (
          await client.query(
            `SELECT * FROM ${this.qualified}.activities
          WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
            [scope.id, this.ownerId],
          )
        ).rows[0]
        if (!row) throw failure('maintenance_activity_missing', 'The durable activity is unavailable')
        if (row.completed_at) return { ended: true, uncertain: false }
        if (row.uncertain_at) return { ended: false, uncertain: true }
        const ended = execution?.ended === true
        await client.query(
          `UPDATE ${this.qualified}.activities SET
          completed_at = CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,
          uncertain_at = CASE WHEN $3 THEN NULL ELSE clock_timestamp() END,
          reason = $4 WHERE id = $1 AND owner_id = $2`,
          [scope.id, this.ownerId, ended, execution?.reason || (ended ? 'completed' : 'execution_unknown')],
        )
        return { ended, uncertain: !ended }
      })
      if (scope.active) {
        scope.active = false
        this._refs -= 1
        if (!this._refs) await this._releaseHolder()
      }
      return result
    })
  }

  async _releaseHolder() {
    if (!this._held) return
    if (!this._lost && this._client) await this._client.query(UNLOCK_SHARED, [this.activityResource])
    this._held = false
  }

  async _checkClaims(client) {
    const claims = {
      activities: Number(
        (
          await client.query(`SELECT count(*) FROM ${this.qualified}.activities
      WHERE completed_at IS NULL`)
        ).rows[0].count,
      ),
    }
    for (const [table, condition] of BUSINESS_CLAIMS) {
      const name = `${quoteIdentifier(this.db.schema)}.${quoteIdentifier(table)}`
      if (!(await client.query('SELECT to_regclass($1) AS name', [name])).rows[0].name) {
        throw failure('maintenance_claims_unavailable', `Cannot verify ${table} before maintenance`)
      }
      claims[table] = Number((await client.query(`SELECT count(*) FROM ${name} WHERE ${condition}`)).rows[0].count)
    }
    if (Object.values(claims).some((count) => count > 0)) {
      throw failure('maintenance_claims_active', 'Unfinished or uncertain activities prevent maintenance', { claims })
    }
    return claims
  }

  async beginMaintenance({ kind, signal = null, timeoutMs = 60000 } = {}) {
    this._assertHealthy()
    if (!['backup', 'restore'].includes(kind)) throw new Error('invalid maintenance kind')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid maintenance timeout')
    if (signal?.aborted) throw failure('maintenance_cancelled', 'Maintenance was cancelled before admission')
    const client = this._connection('maintenance')
    const operation = new MaintenanceOperation(this, client, kind)
    try {
      await client.connect()
      operation.backendPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      if (!(await client.query(TRY_EXCLUSIVE, [this.adminResource])).rows[0].acquired) {
        throw failure('maintenance_busy', 'Another maintenance or schema operation is active')
      }
      await client.query('BEGIN')
      try {
        const row = (await client.query(`SELECT * FROM ${this.qualified}.control WHERE id = 1 FOR UPDATE`)).rows[0]
        if (row.phase !== 'open') throw failure('database_maintenance', 'A durable maintenance operation is pending')
        await client.query(
          `UPDATE ${this.qualified}.control SET phase = 'draining', operation_id = $1,
          owner_id = $2, kind = $3, reason = NULL, changed_at = clock_timestamp() WHERE id = 1`,
          [operation.operationId, this.ownerId, kind],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
      // DRAINING is committed before waiting. Existing scopes never reacquire this lock for their SQL.
      await client.query("SELECT set_config('statement_timeout', $1, false)", [String(timeoutMs)])
      const abort = () => {
        void operation.close()
      }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        if (signal?.aborted) throw failure('maintenance_cancelled', 'Maintenance drain was cancelled')
        await client.query(EXCLUSIVE, [this.activityResource])
      } finally {
        signal?.removeEventListener('abort', abort)
      }
      operation._assertHealthy()
      await client.query("SELECT set_config('statement_timeout', '60000', false)")
      await this._checkClaims(client)
      return operation
    } catch (error) {
      await operation.close()
      throw error
    }
  }

  /** Only a still-running owner may cancel its proven pre-restore stage. No crashed-owner takeover. */
  async cancelDrain(operationId) {
    this._assertHealthy()
    const client = this._connection('maintenance-cancel')
    client.on('error', () => {})
    try {
      await client.connect()
      if (!(await client.query(TRY_EXCLUSIVE, [this.adminResource])).rows[0].acquired) {
        throw failure('maintenance_busy', 'The maintenance owner is still active')
      }
      const result = await client.query(
        `UPDATE ${this.qualified}.control SET phase = 'open', operation_id = NULL,
        owner_id = NULL, kind = NULL, reason = NULL, changed_at = clock_timestamp()
        WHERE id = 1 AND phase = 'draining' AND operation_id = $1 AND owner_id = $2`,
        [operationId, this.ownerId],
      )
      if (result.rowCount !== 1)
        throw failure('maintenance_operation_changed', 'The maintenance operation cannot be cancelled')
      return this.getState()
    } finally {
      await client.end().catch(() => {})
    }
  }

  async stop() {
    if (this._stopping) return this._stopping
    this._stopping = this._exclusiveLocal(async () => {
      this._closing = true
      this._healthy = false
      try {
        if (this._client) {
          await this.db.pool.query(
            `UPDATE ${this.qualified}.members SET stopped_at = clock_timestamp()
            WHERE owner_id = $1 AND NOT EXISTS (SELECT 1 FROM ${this.qualified}.activities
              WHERE owner_id = $1 AND completed_at IS NULL)`,
            [this.ownerId],
          )
        }
      } finally {
        const client = this._client
        this._client = null
        if (client) {
          client.removeListener('error', this._onError)
          client.removeListener('end', this._onEnd)
          await client.end().catch(() => {})
        }
      }
    })
    return this._stopping
  }
}

class MaintenanceOperation {
  constructor(coordinator, client, kind) {
    this.coordinator = coordinator
    this.client = client
    this.kind = kind
    this.operationId = crypto.randomUUID()
    this.backendPid = null
    this._closed = false
    this._lost = false
    client.on('error', () => {
      this._lost = true
    })
    client.on('end', () => {
      this._lost = true
    })
  }

  _assertHealthy() {
    this.coordinator._assertHealthy()
    if (this._closed || this._lost)
      throw failure('maintenance_connection_lost', 'Maintenance ownership connection ended')
  }

  async _transaction(fn) {
    this._assertHealthy()
    const q = this.coordinator.qualified
    await this.client.query('BEGIN')
    try {
      const row = (await this.client.query(`SELECT * FROM ${q}.control WHERE id = 1 FOR UPDATE`)).rows[0]
      if (row.operation_id !== this.operationId || row.owner_id !== this.coordinator.ownerId) {
        throw failure('maintenance_operation_changed', 'Maintenance ownership changed')
      }
      const result = await fn(row)
      this._assertHealthy()
      await this.client.query('COMMIT')
      return result
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => {})
      throw error
    }
  }

  async beginRestore() {
    return this._transaction(async (row) => {
      if (this.kind !== 'restore' || row.phase !== 'draining')
        throw failure('maintenance_operation_changed', 'Restore is not in its pre-restore stage')
      await this.coordinator._checkClaims(this.client)
      if (!Number.isSafeInteger(Number(row.epoch) + 1)) throw new Error('application epoch exhausted')
      const result = await this.client.query(`UPDATE ${this.coordinator.qualified}.control SET phase = 'restoring',
        epoch = epoch + 1, changed_at = clock_timestamp() WHERE id = 1 RETURNING *`)
      return stateOf(result.rows[0])
    })
  }

  async beginRebind() {
    return this._transaction(async (row) => {
      if (row.phase !== 'restoring')
        throw failure('maintenance_operation_changed', 'Restore has not completed its data replacement stage')
      const result = await this.client.query(`UPDATE ${this.coordinator.qualified}.control SET phase = 'rebinding',
        changed_at = clock_timestamp() WHERE id = 1 RETURNING *`)
      return stateOf(result.rows[0])
    })
  }

  async resume() {
    const state = await this._transaction(async (row) => {
      if (
        (this.kind === 'restore' && row.phase !== 'rebinding') ||
        (this.kind === 'backup' && row.phase !== 'draining')
      ) {
        throw failure('maintenance_operation_changed', 'The maintenance phase does not permit resume')
      }
      await this.coordinator._checkClaims(this.client)
      const pending = (
        await this.client.query(
          `SELECT owner_id FROM ${this.coordinator.qualified}.members
        WHERE stopped_at IS NULL AND bound_epoch IS DISTINCT FROM $1`,
          [row.epoch],
        )
      ).rows
      if (pending.length)
        throw failure('maintenance_rebind_pending', 'Some Pods have not rebound to the restored epoch', {
          owners: pending.map((member) => member.owner_id),
        })
      const result = await this.client.query(`UPDATE ${this.coordinator.qualified}.control SET phase = 'open',
        operation_id = NULL, owner_id = NULL, kind = NULL, reason = NULL, changed_at = clock_timestamp()
        WHERE id = 1 RETURNING *`)
      return stateOf(result.rows[0])
    })
    await this.client.query(UNLOCK_EXCLUSIVE, [this.coordinator.activityResource])
    return state
  }

  async failBlocked(reason) {
    return this._transaction(async () => {
      const result = await this.client.query(
        `UPDATE ${this.coordinator.qualified}.control SET phase = 'blocked',
        reason = $1, changed_at = clock_timestamp() WHERE id = 1 RETURNING *`,
        [reason || 'maintenance_failed'],
      )
      return stateOf(result.rows[0])
    })
  }

  async close() {
    if (this._closed) return
    this._closed = true
    // Closing releases session locks, never the durable latch or unfinished claims.
    await this.client.end().catch(() => {})
  }
}
