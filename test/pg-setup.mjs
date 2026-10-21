/** Per-test PostgreSQL isolation for the Node test runner. Never use a deployment URL. */
import { beforeEach, afterEach } from 'node:test'
import crypto from 'node:crypto'
import pg from 'pg'
import { openDatabase, closeDatabase, closeDatabasesForSchema } from '../src/lib/db/database.mjs'

const url = process.env.VM2API_TEST_DATABASE_URL
if (!url || !/_test$/.test(new URL(url).pathname)) {
  throw new Error('tests require VM2API_TEST_DATABASE_URL pointing to a dedicated *_test database')
}
let schema
beforeEach(async () => {
  await closeDatabase()
  schema = `test_${process.pid}_${crypto.randomBytes(8).toString('hex')}`
  // Restore is restricted to this schema. Avoid DROP DATABASE's global checkpoint.
  process.env.VM2API_TEST_DATABASE_URL = url
  process.env.KIN_DATABASE_SCHEMA = schema
  process.env.KIN_DATABASE_URL = url
  process.env.VM2API_DATABASE_URL = url
  const db = await openDatabase({ connectionString: url, schema })
  const { loadSettingsState } = await import('../src/lib/db/settings-state.mjs')
  await loadSettingsState(db)
})
afterEach(async () => {
  await closeDatabase()
  if (!schema) return
  await closeDatabasesForSchema(schema, url)
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const schemas = (await client.query('SELECT nspname FROM pg_namespace WHERE left(nspname,length($1))=$1', [schema]))
      .rows
    for (const row of schemas) await client.query(`DROP SCHEMA IF EXISTS "${row.nspname}" CASCADE`)
  } finally {
    await client.end()
  }
  delete process.env.KIN_DATABASE_SCHEMA
})
