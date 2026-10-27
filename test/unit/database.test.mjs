import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  createDatabase,
  openDatabase,
  closeDatabase,
  getDb,
  isDbOpen,
  withTransaction,
  applyMigrations,
} from '../../src/lib/db/database.mjs'

const url = process.env.VM2API_TEST_DATABASE_URL
function options() {
  assert.ok(url && /_test$/.test(new URL(url).pathname), 'dedicated PostgreSQL *_test database required')
  return { connectionString: url, schema: 'db_' + crypto.randomBytes(8).toString('hex') }
}
const dbs = []
async function database(extra = {}) {
  const db = await createDatabase({ ...options(), ...extra })
  dbs.push(db)
  return db
}
after(async () => {
  await closeDatabase()
  for (const db of dbs) {
    if (!db.closed) await db.exec(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`)
    await db.close()
  }
})

test('PostgreSQL baseline includes business and historical tables and default groups', async () => {
  const db = await database()
  const rows = await db.prepare('SELECT table_name FROM information_schema.tables WHERE table_schema=$1').all(db.schema)
  assert.equal(rows.length, 45)
  for (const name of [
    'settings',
    'users',
    'api_keys',
    'accounts',
    'usage_logs',
    'thinking_signature_owners',
    'accounts_legacy',
    'panel_users_legacy',
    'panel_sessions',
    'api_key_admissions',
    'gateway_rate_buckets',
    'execution_admissions',
    'execution_circuits',
    'execution_seats',
    'execution_jobs',
    'ha_request_contexts',
    'ha_request_settlements',
    'session_turns',
    'vm_operations',
    'background_task_runs',
    'oauth_pkce_sessions',
    'shell_tickets',
    'claude_subscriptions',
  ]) {
    assert.ok(
      rows.some((r) => r.table_name === name),
      name,
    )
  }
  assert.deepEqual(
    (await db.prepare('SELECT id,name FROM groups ORDER BY id').all()).map((r) => [r.id, r.name]),
    [
      [1, 'coding'],
      [2, 'other'],
    ],
  )
  assert.deepEqual(await applyMigrations(db), [])
})

test('transactions await callbacks and rollback writes on the same connection', async () => {
  const db = await database()
  await withTransaction(db, async () => {
    await db.prepare('INSERT INTO settings(key,value) VALUES($1,$2)').run('outer', '1')
    await withTransaction(db, async () => {
      await db.prepare('INSERT INTO settings(key,value) VALUES($1,$2)').run('nested', '2')
    })
  })
  await assert.rejects(
    withTransaction(db, async () => {
      await db.prepare('INSERT INTO settings(key,value) VALUES($1,$2)').run('rolled', '3')
      await new Promise((r) => setImmediate(r))
      throw new Error('rollback marker')
    }),
    /rollback marker/,
  )
  assert.deepEqual(
    (await db.prepare('SELECT key FROM settings ORDER BY key').all()).map((r) => r.key),
    ['nested', 'outer'],
  )
})

test('concurrent transactions do not share a connection or rollback each other', async () => {
  const db = await database()
  await Promise.all([
    withTransaction(db, async () => {
      await db.prepare("INSERT INTO settings(key,value) VALUES('keep','1')").run()
    }),
    assert.rejects(
      withTransaction(db, async () => {
        await db.prepare("INSERT INTO settings(key,value) VALUES('drop','2')").run()
        throw new Error('fail')
      }),
      /fail/,
    ),
  ])
  assert.ok(await db.prepare("SELECT * FROM settings WHERE key='keep'").get())
  assert.equal(await db.prepare("SELECT * FROM settings WHERE key='drop'").get(), undefined)
})

test('concurrent initialization serializes migrations and checksums are enforced', async () => {
  const opts = options()
  const [a, b] = await Promise.all([createDatabase(opts), createDatabase(opts)])
  dbs.push(a, b)
  assert.equal((await a.prepare('SELECT count(*) AS n FROM schema_migrations').get()).n, 23)
  await a.prepare("UPDATE schema_migrations SET checksum='invalid'").run()
  await assert.rejects(applyMigrations(b), /checksum mismatch/)
})

test('failed migrations rollback DDL and migration records', async () => {
  const dir = fs.mkdtempSync('/tmp/vm2api-pg-migrations-')
  fs.writeFileSync(dir + '/999_bad.sql', 'CREATE TABLE partial_write(id text); INVALID SQL;')
  const db = await database()
  await assert.rejects(applyMigrations(db, { migrationsDir: dir }), /unknown PostgreSQL migration/)
  const migrations = new URL('../../src/lib/db/postgres-migrations/', import.meta.url)
  for (const file of fs.readdirSync(migrations).filter((name) => name.endsWith('.sql'))) {
    fs.copyFileSync(new URL(file, migrations), path.join(dir, file))
  }
  await assert.rejects(applyMigrations(db, { migrationsDir: dir }), /999_bad.sql failed/)
  assert.equal((await db.prepare('SELECT to_regclass($1) AS name').get(db.schema + '.partial_write')).name, null)
  assert.equal((await db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).n, 23)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('big integers preserve precision and errors exclude SQL parameter values', async () => {
  const db = await database()
  const row = await db.prepare('SELECT $1::bigint AS large, $2::bigint AS small').get('9007199254740993', 42)
  assert.equal(row.large, '9007199254740993')
  assert.equal(row.small, 42)
  await db.prepare('INSERT INTO settings(key,value) VALUES($1,$2)').run('sensitive-key', 'sensitive-value')
  await assert.rejects(
    db.prepare('INSERT INTO settings(key,value) VALUES($1,$2)').run('sensitive-key', 'sensitive-value'),
    (error) => error.code === '23505' && !error.message.includes('sensitive'),
  )
})

test('singleton opens once and closes explicitly', async () => {
  await closeDatabase()
  assert.throws(getDb, /not opened/)
  const opts = options()
  const [a, b] = await Promise.all([openDatabase(opts), openDatabase(opts)])
  assert.equal(a, b)
  assert.equal(getDb(), a)
  assert.equal(isDbOpen(), true)
  await a.exec(`DROP SCHEMA "${a.schema}" CASCADE`)
  await closeDatabase()
  assert.equal(isDbOpen(), false)
})

test('maintenance drains transactions and rejects unrelated writes', async () => {
  const db = await database()
  let release, started
  const ready = new Promise((r) => {
    started = r
  })
  const transaction = withTransaction(db, async () => {
    started()
    await new Promise((r) => {
      release = r
    })
    await db.prepare("INSERT INTO settings(key,value) VALUES('before','1')").run()
  })
  await ready
  const maintaining = db.withMaintenance(async () => {
    await db.prepare("INSERT INTO settings(key,value) VALUES('maintenance','1')").run()
  })
  await assert.rejects(db.prepare("INSERT INTO settings(key,value) VALUES('blocked','1')").run(), {
    code: 'database_maintenance',
  })
  release()
  await transaction
  await maintaining
  assert.equal((await db.prepare('SELECT count(*) AS n FROM settings').get()).n, 2)
})

test('migration 023 adds upstream image columns without changing old rows or migration checksums', async () => {
  const src = new URL('../../src/lib/db/postgres-migrations/', import.meta.url)
  const dir = fs.mkdtempSync('/tmp/vm2api-image-migration-')
  let db
  try {
    for (const file of fs.readdirSync(src).filter((name) => name.endsWith('.sql') && name < '023')) {
      fs.copyFileSync(new URL(file, src), path.join(dir, file))
    }
    db = await createDatabase({ ...options(), migrationsDir: dir })
    dbs.push(db)
    await db
      .prepare(`
      INSERT INTO usage_logs (id,request_id,created_at,model,input_tokens,cache_read_tokens,output_tokens,total_cost)
      VALUES ('old','r-old','2026-10-01T00:00:00.000Z','gpt-6-luna',100,20,5,0.5)
    `)
      .run()
    const checksums = await db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()
    const prompt =
      'SELECT SUM(COALESCE(input_tokens,0) + COALESCE(cache_read_tokens,0) + COALESCE(cache_creation_tokens,0)) AS n FROM usage_logs'
    const before = (await db.prepare(prompt).get()).n
    assert.deepEqual(await applyMigrations(db), ['023_usage_logs_image_generation.sql'])
    assert.deepEqual(
      await db.prepare("SELECT version, checksum FROM schema_migrations WHERE version < '023' ORDER BY version").all(),
      checksums,
    )
    assert.equal((await db.prepare(prompt).get()).n, before)
    assert.deepEqual(
      await db
        .prepare(
          "SELECT image_model,image_usage,image_input_tokens,image_output_tokens,image_cost,total_cost FROM usage_logs WHERE id = 'old'",
        )
        .get(),
      {
        image_model: null,
        image_usage: null,
        image_input_tokens: 0,
        image_output_tokens: 0,
        image_cost: null,
        total_cost: 0.5,
      },
    )
    assert.deepEqual(await applyMigrations(db), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
