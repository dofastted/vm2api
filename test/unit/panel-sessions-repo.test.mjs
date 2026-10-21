import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { getDb } from '../../src/lib/db/database.mjs'
import { PanelSessionsRepo } from '../../src/lib/db/repos/panel-sessions-repo.mjs'

const hash = (label) => crypto.createHash('sha256').update(label).digest('hex')
const nowSql = 'floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint'

test('panel sessions use PostgreSQL time and persist only token hashes', async (t) => {
  const db = getDb()
  const repo = new PanelSessionsRepo(db)
  t.mock.method(Date, 'now', () => 0)
  const before = (await db.prepare(`SELECT ${nowSql} AS now`).get()).now
  const created = await repo.create({ tokenHash: hash('token-a'), username: 'alice', role: 'user', ttlMs: 60_000 })
  const after = (await db.prepare(`SELECT ${nowSql} AS now`).get()).now
  assert.ok(created.exp >= before + 60_000 && created.exp <= after + 60_000)
  assert.deepEqual(await new PanelSessionsRepo(db).get(hash('token-a')), created)
  assert.equal(created.user, 'alice')
  assert.equal(created.role, 'user')
  const stored = await db.prepare('SELECT * FROM panel_sessions').get()
  assert.deepEqual(Object.keys(stored).sort(), ['expires_at', 'role', 'token_hash', 'username'])
  assert.equal(stored.token_hash, hash('token-a'))
})

test('expired and revoked sessions cannot be renewed or resurrected', async () => {
  const db = getDb()
  const repo = new PanelSessionsRepo(db)
  const key = hash('token-a')
  const created = await repo.create({ tokenHash: key, username: 'alice', role: 'user', ttlMs: 60_000 })
  await db.prepare('UPDATE panel_sessions SET expires_at = 0 WHERE token_hash = $1').run(key)
  assert.equal(await repo.get(key), null)
  assert.equal(await repo.renew(key, { expectedExp: 0, ttlMs: 60_000 }), null)
  assert.equal(await repo.remove(key), true)
  assert.equal(await repo.remove(key), false)
  assert.equal(await repo.renew(key, { expectedExp: created.exp, ttlMs: 60_000 }), null)
  assert.equal((await db.prepare('SELECT count(*) AS n FROM panel_sessions').get()).n, 0)
})

test('concurrent renewals compare the observed expiry and preserve the winner', async () => {
  const repo = new PanelSessionsRepo(getDb())
  const key = hash('token-a')
  const created = await repo.create({ tokenHash: key, username: 'alice', role: 'admin', ttlMs: 60_000 })
  const attempts = await Promise.all([
    repo.renew(key, { expectedExp: created.exp, ttlMs: 120_000 }),
    repo.renew(key, { expectedExp: created.exp, ttlMs: 180_000 }),
  ])
  const winners = attempts.filter(Boolean)
  assert.equal(winners.length, 1)
  assert.ok(winners[0].exp > created.exp)
  assert.deepEqual(await repo.get(key), winners[0])
  assert.equal(await repo.renew(key, { expectedExp: created.exp, ttlMs: 240_000 }), null)
})

test('user revocation preserves only the excluded hash and other users', async () => {
  const repo = new PanelSessionsRepo(getDb())
  for (const [label, username] of [
    ['a', 'alice'],
    ['b', 'alice'],
    ['c', 'alice'],
    ['d', 'bob'],
  ]) {
    await repo.create({ tokenHash: hash(label), username, role: 'user', ttlMs: 60_000 })
  }
  assert.equal(await repo.removeForUser('alice', { exceptHash: hash('b') }), 2)
  assert.equal(await repo.get(hash('a')), null)
  assert.equal(await repo.get(hash('c')), null)
  assert.equal((await repo.get(hash('b'))).user, 'alice')
  assert.equal((await repo.get(hash('d'))).user, 'bob')
  assert.equal(await repo.removeForUser('alice'), 1)
  assert.equal(await repo.get(hash('b')), null)
})

test('invalid session durations fail before writing a session', async () => {
  const db = getDb()
  const repo = new PanelSessionsRepo(db)
  for (const ttlMs of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      repo.create({ tokenHash: hash(String(ttlMs)), username: 'alice', role: 'user', ttlMs }),
      RangeError,
    )
  }
  assert.equal((await db.prepare('SELECT count(*) AS n FROM panel_sessions').get()).n, 0)
})
