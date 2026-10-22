/**
 * PostgreSQL connections for repository and scheduler tests. These tests own
 * their fixture lifetime and do not boot a control-plane HTTP server. Tests of
 * maintenance admission use production createDatabase and real activity scopes.
 */
import { PostgresDatabase, applyMigrations } from '../src/lib/db/database.mjs'

export async function createRepositoryTestDatabase(options = {}) {
  const db = new PostgresDatabase({ ...options, schema: options.schema || process.env.KIN_DATABASE_SCHEMA || 'public' })
  try {
    await applyMigrations(db, options)
    return db
  } catch (error) {
    await db.close()
    throw error
  }
}
