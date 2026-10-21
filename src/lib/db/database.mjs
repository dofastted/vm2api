/** PostgreSQL persistence. SQLite is supported only by the offline importer. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { isKubernetesMode } from '../core/control-plane-mode.mjs'

const MIGRATIONS_DIR = fileURLToPath(new URL('./postgres-migrations/', import.meta.url))
const transactions = new AsyncLocalStorage()
const maintenance = new AsyncLocalStorage()
const instances = new Set()
const activityCoordinators = new WeakMap()
let singleton = null
let opening = null

export function registerActivityCoordinator(db, coordinator) {
  if (coordinator.db !== db || (activityCoordinators.has(db) && activityCoordinators.get(db) !== coordinator)) {
    throw new Error('database activity coordinator mismatch')
  }
  activityCoordinators.set(db, coordinator)
}

export function getActivityCoordinator(db) {
  return activityCoordinators.get(db) || null
}

export function quoteIdentifier(value) {
  return '"' + String(value).replaceAll('"', '""') + '"'
}

export function resolveDatabaseUrl({ connectionString } = {}) {
  const value = connectionString || process.env.VM2API_DATABASE_URL || process.env.KIN_DATABASE_URL
  if (!value || !/^postgres(?:ql)?:\/\//.test(value)) {
    throw new Error('PostgreSQL requires VM2API_DATABASE_URL or KIN_DATABASE_URL')
  }
  return value
}

function safeInteger(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : value
}

function databaseError(error, operation = 'query') {
  const out = new Error(`PostgreSQL ${operation} failed (${error.code || 'database_error'})`)
  out.code = error.code || 'database_error'
  if (error.constraint) out.constraint = error.constraint
  return out
}

export class PostgresDatabase {
  constructor({ connectionString, schema = 'public', max = 10 } = {}) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('invalid database schema')
    this.connectionString = resolveDatabaseUrl({ connectionString })
    this.schema = schema
    this.pool = new pg.Pool({
      connectionString: this.connectionString,
      max,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      statement_timeout: 60000,
      options: `-c search_path=${quoteIdentifier(schema)},pg_catalog -c timezone=UTC`,
      types: {
        getTypeParser(oid, format) {
          if (format !== 'binary' && (oid === 20 || oid === 1700)) {
            return (value) => (/^-?\d+$/.test(value) ? safeInteger(value) : Number(value))
          }
          return pg.types.getTypeParser(oid, format)
        },
      },
    })
    instances.add(this)
    this.closed = false
    this.active = 0
    this.maintaining = false
    this.waiters = []
    // Idle connection errors must not become uncaught EventEmitter errors.
    this.pool.on('error', () => {})
  }

  get isTransaction() {
    return transactions.getStore()?.db === this
  }

  async query(sql, params = []) {
    if (this.closed) throw new Error('database is closed')
    const tx = transactions.getStore()
    if (this.maintaining && maintenance.getStore() !== this && tx?.db !== this) {
      throw Object.assign(new Error('database maintenance in progress'), { code: 'database_maintenance' })
    }
    const finishPersistence = getActivityCoordinator(this)?.trackPersistence()
    this.active += 1
    try {
      return await (tx?.db === this ? tx.client : this.pool).query(sql, params)
    } catch (error) {
      throw databaseError(error)
    } finally {
      finishPersistence?.()
      this.active -= 1
      if (!this.active) for (const resolve of this.waiters.splice(0)) resolve()
    }
  }

  afterCommit(fn) {
    const tx = transactions.getStore()
    if (tx?.db === this) tx.commitCallbacks.push(fn)
    else fn()
  }

  prepare(sql) {
    return {
      get: async (...params) => (await this.query(sql, params)).rows[0],
      all: async (...params) => (await this.query(sql, params)).rows,
      run: async (...params) => {
        const result = await this.query(sql, params)
        return { changes: result.rowCount || 0, rows: result.rows }
      },
    }
  }

  async exec(sql) {
    await this.query(sql)
  }

  async withMaintenance(fn) {
    if (maintenance.getStore() === this) return fn()
    if (this.maintaining)
      throw Object.assign(new Error('database maintenance in progress'), { code: 'database_maintenance' })
    this.maintaining = true
    try {
      if (this.active) await new Promise((resolve) => this.waiters.push(resolve))
      return await maintenance.run(this, fn)
    } finally {
      this.maintaining = false
    }
  }

  async close() {
    if (this.closing) return this.closing
    if (this.closed) return
    this.closing = (async () => {
      let failure
      try {
        for (const queue of this.pendingWriteQueues || []) {
          try {
            await queue.flush()
          } catch (error) {
            failure ||= error
          }
        }
      } finally {
        try {
          await getActivityCoordinator(this)?.stop()
        } catch (error) {
          failure ||= error
        }
        this.closed = true
        await this.pool.end()
        instances.delete(this)
      }
      if (failure) throw failure
    })()
    return this.closing
  }
}

export async function withTransaction(db, fn) {
  getActivityCoordinator(db)?.assertActivity()
  const outer = transactions.getStore()
  if (outer?.db === db) return fn(db)
  if (db.closed) throw new Error('database is closed')
  if (db.maintaining && maintenance.getStore() !== db) {
    throw Object.assign(new Error('database maintenance in progress'), { code: 'database_maintenance' })
  }
  // Count the entire transaction, including time between individual queries.
  const finishPersistence = getActivityCoordinator(db)?.trackPersistence()
  db.active += 1
  let client
  try {
    client = await db.pool.connect()
    await client.query('BEGIN')
    const context = { db, client, commitCallbacks: [] }
    const result = await transactions.run(context, () => fn(db))
    await client.query('COMMIT')
    for (const callback of context.commitCallbacks) callback()
    return result
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    finishPersistence?.()
    client?.release()
    db.active -= 1
    if (!db.active) for (const resolve of db.waiters.splice(0)) resolve()
  }
}

/** A recoverable import record must roll back both SQL and cache commit callbacks. */
export async function withSavepoint(db, fn) {
  const tx = transactions.getStore()
  if (tx?.db !== db) return withTransaction(db, fn)
  const mark = tx.commitCallbacks.length
  const name = 'import_' + crypto.randomBytes(8).toString('hex')
  await db.exec(`SAVEPOINT ${name}`)
  try {
    const result = await fn()
    await db.exec(`RELEASE SAVEPOINT ${name}`)
    return result
  } catch (error) {
    tx.commitCallbacks.splice(mark)
    await db.exec(`ROLLBACK TO SAVEPOINT ${name}`)
    await db.exec(`RELEASE SAVEPOINT ${name}`)
    throw error
  }
}

export async function applyMigrations(db, { migrationsDir = MIGRATIONS_DIR } = {}) {
  return withTransaction(db, async () => {
    // Transaction-scoped lock is automatically released on connection failure.
    await db.query('SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext($1))', [`vm2api:${db.schema}`])
    if (db.schema !== 'public') await db.exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(db.schema)}`)
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at text NOT NULL
    )`)
    const applied = new Map(
      (await db.prepare('SELECT version, checksum FROM schema_migrations').all()).map((r) => [r.version, r.checksum]),
    )
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => /^\d+.*\.sql$/.test(f))
      .sort()
    const known = new Set(files.map((f) => f.split('_')[0]))
    if ([...applied.keys()].some((v) => !known.has(v)))
      throw new Error('database contains an unknown PostgreSQL migration')
    const results = []
    for (const file of files) {
      const version = file.split('_')[0]
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8').replaceAll('\r\n', '\n')
      const checksum = crypto.createHash('sha256').update(sql).digest('hex')
      if (applied.has(version)) {
        if (applied.get(version) !== checksum) throw new Error(`migration checksum mismatch for ${file}`)
        continue
      }
      try {
        await db.exec(sql)
        await db
          .prepare('INSERT INTO schema_migrations (version,name,checksum,applied_at) VALUES ($1,$2,$3,$4)')
          .run(version, file, checksum, new Date().toISOString())
      } catch (error) {
        throw new Error(`migration ${file} failed (${error.code || 'migration_error'})`)
      }
      results.push(file)
    }
    return results
  })
}

/** Verify an operator-provisioned business schema without creating or migrating it. */
async function verifyCurrentMigrations(db, { migrationsDir = MIGRATIONS_DIR } = {}) {
  const unavailable = () =>
    Object.assign(new Error('database migrations are not current'), {
      code: 'database_migrations_not_current',
    })
  return withTransaction(db, async () => {
    await db.exec('SET TRANSACTION READ ONLY')
    await db.query('SELECT pg_advisory_xact_lock_shared(hashtext(current_database()),hashtext($1))', [
      `vm2api:${db.schema}`,
    ])
    const present = (
      await db.query('SELECT to_regnamespace($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AS ready', [
        db.schema,
        `${quoteIdentifier(db.schema)}.schema_migrations`,
      ])
    ).rows[0]
    if (!present.ready) throw unavailable()
    const applied = new Map(
      (await db.query(`SELECT version,name,checksum FROM ${quoteIdentifier(db.schema)}.schema_migrations`)).rows.map(
        (row) => [row.version, row],
      ),
    )
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort()
    if (applied.size !== files.length) throw unavailable()
    for (const file of files) {
      const row = applied.get(file.split('_')[0])
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8').replaceAll('\r\n', '\n')
      const checksum = crypto.createHash('sha256').update(sql).digest('hex')
      if (row?.name !== file || row.checksum !== checksum) throw unavailable()
    }
  })
}

export async function createDatabase(options = {}) {
  if (options.dataDir && fs.existsSync(path.join(options.dataDir, 'restore-maintenance.json'))) {
    throw new Error('restore maintenance marker exists; complete offline recovery before startup')
  }
  const db = new PostgresDatabase({ ...options, schema: options.schema || process.env.KIN_DATABASE_SCHEMA || 'public' })
  try {
    // Offline administration must verify before even private coordination DDL.
    // The live bootstrap scope repeats this check before using the schema.
    if (options.verifyMigrations === true) await verifyCurrentMigrations(db, options)
    if (isKubernetesMode()) {
      const { GlobalMaintenanceCoordinator } = await import('./global-maintenance.mjs')
      const coordinator = new GlobalMaintenanceCoordinator(db)
      registerActivityCoordinator(db, coordinator)
      await coordinator.start()
      db.bootstrapActivity = await coordinator.admitBootstrap()
    }
    const initialize = async () => {
      const version = Number((await db.prepare('SHOW server_version_num').get()).server_version_num)
      if (version < 170000 || version >= 180000)
        throw new Error('vm2api requires PostgreSQL 17 and PostgreSQL 17 backup clients')
      if (options.verifyMigrations === true) await verifyCurrentMigrations(db, options)
      else await applyMigrations(db, options)
      if (options.dataDir && fs.existsSync(path.join(options.dataDir, 'kin.db')) && !options.allowLegacySource) {
        const imported = await db.prepare("SELECT value FROM settings WHERE key = 'sqlite_import_done'").get()
        if (!imported) throw new Error('existing SQLite data requires db:import:sqlite before PostgreSQL startup')
      }
    }
    if (db.bootstrapActivity) await db.bootstrapActivity.run(initialize)
    else await initialize()
    return db
  } catch (error) {
    await db.bootstrapActivity?.complete({ ended: true, reason: 'database_initialization_failed' }).catch(() => {})
    await db.close()
    throw error
  }
}

export async function openDatabase(options = {}) {
  if (singleton) return singleton
  if (opening) return opening
  opening = createDatabase(options)
  try {
    singleton = await opening
    return singleton
  } finally {
    opening = null
  }
}

export function getDb() {
  if (!singleton) throw new Error('database not opened — await openDatabase() first')
  return singleton
}
export function isDbOpen() {
  return !!singleton
}
export function resolveStoreDb({ db } = {}) {
  return db || getDb()
}
export async function closeDatabase() {
  if (opening) await opening
  const db = singleton
  singleton = null
  if (db) await db.close()
}

/** Drain only explicitly identified test connections before deleting their schema. */
export async function closeDatabasesForSchema(schema, connectionString) {
  const matches = [...instances].filter((db) => db.schema === schema && db.connectionString === connectionString)
  const results = await Promise.allSettled(matches.map((db) => db.close()))
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) throw failed.reason
}
