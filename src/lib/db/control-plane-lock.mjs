/** Single active controller guard. This does not fence remote execution or provide failover. */

const LOCK_SQL = 'SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext($1)) AS acquired'
const UNLOCK_SQL = 'SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1))'

function lockError(code, message) {
  return Object.assign(new Error(message), { code })
}

export class ControlPlaneLock {
  constructor(db, { onLost = null } = {}) {
    this.db = db
    this.onLost = onLost
    this.resource = `vm2api:control-plane:${db.schema}`
    this._healthy = false
    this._client = null
    this._starting = null
    this._stopping = null
    this._closing = false
    this._lost = false
    this._onError = (error) => this._lose(error)
    this._onEnd = () => this._lose(lockError('control_plane_lock_lost', 'Control-plane lock connection ended'))
  }

  get healthy() {
    return this._healthy
  }

  async start() {
    if (this._healthy) return this
    if (this._starting) return this._starting
    if (this._lost) throw lockError('control_plane_lock_lost', 'Control-plane lock was lost; restart is required')
    if (this._stopping) await this._stopping
    this._closing = false
    const pending = this._acquire()
    this._starting = pending
    try {
      return await pending
    } finally {
      if (this._starting === pending) this._starting = null
    }
  }

  async _acquire() {
    const client = await this.db.pool.connect()
    if (this._closing) {
      client.release()
      throw lockError('control_plane_lock_stopped', 'Control-plane lock startup was stopped')
    }
    this._client = client
    client.on('error', this._onError)
    client.on('end', this._onEnd)
    try {
      const result = await client.query(LOCK_SQL, [this.resource])
      if (!result.rows[0]?.acquired) {
        throw lockError('control_plane_already_active', 'Another control plane is active for this database and schema')
      }
      if (this._lost || this._closing) {
        throw lockError('control_plane_lock_lost', 'Control-plane lock was lost during startup')
      }
      this._healthy = true
      return this
    } catch (error) {
      this._healthy = false
      this._client = null
      this._detach(client)
      client.release(error.code === 'control_plane_already_active' ? undefined : true)
      throw error
    }
  }

  _lose(error) {
    if (this._closing || this._lost || !this._client) return
    this._healthy = false
    this._lost = true
    // The hook must synchronously stop admission and own any asynchronous cleanup.
    this.onLost?.(error)
  }

  _detach(client) {
    client.removeListener('error', this._onError)
    client.removeListener('end', this._onEnd)
  }

  async stop() {
    if (this._stopping) return this._stopping
    this._closing = true
    this._healthy = false
    const pending = this._release()
    this._stopping = pending
    try {
      await pending
    } finally {
      if (this._stopping === pending) this._stopping = null
    }
  }

  async _release() {
    if (this._starting) await this._starting.catch(() => {})
    const client = this._client
    if (!client) return
    this._client = null
    this._detach(client)
    let failed = this._lost
    try {
      if (!this._lost) await client.query(UNLOCK_SQL, [this.resource])
    } catch (error) {
      failed = true
      throw error
    } finally {
      client.release(failed)
    }
  }
}
