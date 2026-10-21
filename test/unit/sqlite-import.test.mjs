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
  const old = sqlite({dbPath:source})
  old.prepare('INSERT INTO accounts(id,load_factor) VALUES(?,?)').run('fractional',1.25)
  old.close()
  const db=getDb()
  await importSqlite({source,db})
  assert.equal((await db.prepare("SELECT load_factor FROM accounts WHERE id='fractional'").get()).load_factor,1.25)
  const {AccountRuntimeRepo}=await import('../../src/lib/db/repos/account-runtime-repo.mjs')
  const record=await new AccountRuntimeRepo(db).upsert({account_id:'fractional',vm_id:'vm-01',weight:2.75})
  assert.equal(record.weight,2.75)
})
