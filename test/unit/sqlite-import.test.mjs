import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { createDatabase as sqlite } from '../../src/lib/db/sqlite-legacy.mjs'
import { importSqlite } from '../../src/lib/db/sqlite-import.mjs'
import { getDb } from '../../src/lib/db/database.mjs'
let dir, source
beforeEach(() => {
  dir = fs.mkdtempSync('/tmp/vm2api-import-test-')
  source = dir + '/source.db'
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
function digest() {
  return crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')
}

test('offline import preserves source, credentials, bigint, runtime and legacy data, and sequence high-water', async () => {
  const old = sqlite({ dbPath: source })
  old.exec(
    `CREATE TABLE thinking_signature_owners(key TEXT PRIMARY KEY,account_id TEXT NOT NULL,created_at INTEGER NOT NULL)`,
  )
  old.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('encrypted_fixture', '"enc:synthetic-ciphertext"')
  old.prepare('INSERT INTO thinking_signature_owners VALUES(?,?,?)').run('signature', 'account', 9007199254740993n)
  old.prepare("INSERT INTO redeem_codes(id,code,value) VALUES(100,'deleted-code',1)").run()
  old.prepare('DELETE FROM redeem_codes WHERE id=100').run()
  old.close()
  const before = digest()
  const db = getDb()
  const report = await importSqlite({ source, db })
  assert.equal(digest(), before)
  assert.equal(report.tables.thinking_signature_owners.count, 1)
  assert.equal(
    (await db.prepare('SELECT created_at FROM thinking_signature_owners').get()).created_at,
    '9007199254740993',
  )
  assert.equal(
    (await db.prepare("SELECT value FROM settings WHERE key='encrypted_fixture'").get()).value,
    '"enc:synthetic-ciphertext"',
  )
  const next = await db.prepare("INSERT INTO redeem_codes(code,value) VALUES('new-code',1) RETURNING id").get()
  assert.equal(next.id, 101)
  await assert.rejects(importSqlite({ source, db }), /target is not empty/)
})

test('PostgreSQL-only session rows make the import target nonempty', async () => {
  const old = sqlite({ dbPath: source })
  old.close()
  const before = digest()
  const db = getDb()
  await db
    .prepare(`
    INSERT INTO panel_sessions(token_hash,username,role,expires_at)
    VALUES($1,'alice','admin',floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 60000)
  `)
    .run('a'.repeat(64))
  await assert.rejects(importSqlite({ source, db }), /target is not empty \(panel_sessions\)/)
  assert.equal((await db.prepare('SELECT count(*) AS n FROM panel_sessions').get()).n, 1)
  assert.equal((await db.prepare('SELECT count(*) AS n FROM settings').get()).n, 0)
  assert.equal((await db.prepare('SELECT count(*) AS n FROM groups').get()).n, 2)
  assert.equal(digest(), before)
})

test('unmapped source schema is rejected without writing target', async () => {
  const old = sqlite({ dbPath: source })
  old.exec('CREATE TABLE unknown_business(id TEXT)')
  old.close()
  await assert.rejects(importSqlite({ source, db: getDb() }), /unmapped SQLite table/)
  assert.equal((await getDb().prepare('SELECT count(*) AS n FROM settings').get()).n, 0)
})

test('invalid source row rolls back all target data and seeds', async () => {
  const old = sqlite({ dbPath: source })
  old.exec("INSERT INTO settings(key,value) VALUES(NULL,'bad')")
  old.close()
  await assert.rejects(importSqlite({ source, db: getDb() }), { code: '23502' })
  assert.equal((await getDb().prepare('SELECT count(*) AS n FROM settings').get()).n, 0)
  assert.equal((await getDb().prepare('SELECT count(*) AS n FROM groups').get()).n, 2)
})

test('fractional scheduling weights survive SQLite import and PostgreSQL updates', async () => {
  const old = sqlite({ dbPath: source })
  old.prepare('INSERT INTO accounts(id,load_factor) VALUES(?,?)').run('fractional', 1.25)
  old.close()
  const db = getDb()
  await importSqlite({ source, db })
  assert.equal((await db.prepare("SELECT load_factor FROM accounts WHERE id='fractional'").get()).load_factor, 1.25)
  const { AccountRuntimeRepo } = await import('../../src/lib/db/repos/account-runtime-repo.mjs')
  const record = await new AccountRuntimeRepo(db).upsert({ account_id: 'fractional', vm_id: 'vm-01', weight: 2.75 })
  assert.equal(record.weight, 2.75)
})

test('fractional weights in the preserved legacy runtime table survive import', async () => {
  const old = sqlite({ dbPath: source })
  old
    .prepare('INSERT INTO account_runtime_states_legacy(account_id,vm_id,weight,updated_at) VALUES(?,?,?,?)')
    .run('legacy-fractional', 'vm-01', 1.25, '2026-10-21T00:00:00.000Z')
  old.close()
  const db = getDb()
  await importSqlite({ source, db })
  const row = await db
    .prepare('SELECT weight FROM account_runtime_states_legacy WHERE account_id=$1')
    .get('legacy-fractional')
  assert.equal(row.weight, 1.25)
})

test('fractional API endpoint priorities survive import and store mutations', async () => {
  const old = sqlite({ dbPath: source })
  old
    .prepare('INSERT INTO api_endpoints(id,name,base_url,priority) VALUES(?,?,?,?)')
    .run('fractional-endpoint', 'fractional', 'https://example.invalid', 1.25)
  old.close()
  const db = getDb()
  await importSqlite({ source, db })
  const { ApiEndpointStore } = await import('../../src/lib/admin/api-endpoints.mjs')
  const store = new ApiEndpointStore({ db })
  assert.equal((await store.getRaw('fractional-endpoint')).priority, 1.25)
  const created = await store.create({ base_url: 'https://example.invalid', priority: 2.75 })
  assert.equal(created.priority, 2.75)
  assert.equal((await store.update(created.id, { priority: 0.25 })).priority, 0.25)
})
