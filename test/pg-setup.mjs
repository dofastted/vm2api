/** Per-test PostgreSQL isolation for the Node test runner. Never use a deployment URL. */
import { beforeEach, afterEach, after } from 'node:test'
import crypto from 'node:crypto'
import pg from 'pg'
import { openDatabase, closeDatabase, closeDatabasesForSchema } from '../src/lib/db/database.mjs'

const url = process.env.VM2API_TEST_DATABASE_URL
if (!url || !/_test$/.test(new URL(url).pathname)) {
  throw new Error('tests require VM2API_TEST_DATABASE_URL pointing to a dedicated *_test database')
}
let schema
let dedicated
let testUrl = url
let fileUrl = url
const backupTest = process.argv.some((arg) =>
  /(?:^|[/\\])(?:backup-service\.test\.mjs|backup\.e2e\.test\.mjs)$/.test(arg),
)
beforeEach(async () => {
  await closeDatabase()
  schema = `test_${process.pid}_${crypto.randomBytes(8).toString('hex')}`
  testUrl = fileUrl
  if (backupTest && !dedicated) {
    dedicated = `vm2api_${crypto.randomBytes(8).toString('hex')}_test`
    const admin = new pg.Client({ connectionString: url })
    await admin.connect()
    try {
      await admin.query(`CREATE DATABASE "${dedicated}"`)
    } finally {
      await admin.end()
    }
    const target = new URL(url)
    target.pathname = '/' + dedicated
    testUrl = target.toString()
    fileUrl = testUrl
  }
  process.env.VM2API_TEST_DATABASE_URL = testUrl
  process.env.KIN_DATABASE_SCHEMA = schema
  process.env.KIN_DATABASE_URL = testUrl
  process.env.VM2API_DATABASE_URL = testUrl
  const db = await openDatabase({ connectionString: testUrl, schema })
  const { loadSettingsState } = await import('../src/lib/db/settings-state.mjs')
  await loadSettingsState(db)
})
afterEach(async () => {
  await closeDatabase()
  if (!schema) return
  await closeDatabasesForSchema(schema, testUrl)
  const client = new pg.Client({ connectionString: testUrl })
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

after(async () => {
  if (!dedicated) return
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE "${dedicated}" WITH (FORCE)`)
  } finally {
    await admin.end()
  }
  process.env.VM2API_TEST_DATABASE_URL = url
})
