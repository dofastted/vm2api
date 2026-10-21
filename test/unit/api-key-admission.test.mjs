import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'

async function replicas() {
  const db = getDb()
  const other = await createDatabase({ connectionString: process.env.VM2API_TEST_DATABASE_URL, schema: db.schema })
  return [new ApiKeyStore({ db, sharedAdmission: true }), new ApiKeyStore({ db: other, sharedAdmission: true })]
}

async function user(store, { role = 'user', concurrency = 1 } = {}) {
  const id = 'user-' + crypto.randomUUID()
  const now = new Date().toISOString()
  return store.users.insert({
    id,
    username: id,
    password_hash: 'test',
    role,
    concurrency,
    created_at: now,
    updated_at: now,
  })
}

test('independent replicas atomically enforce key concurrency and release once', async () => {
  const stores = await replicas()
  const key = await stores[0].create({ max_concurrency: 1 })
  const gates = await Promise.all(Array.from({ length: 12 }, (_, i) => stores[i % 2].reserve(key)))
  assert.equal(gates.filter((g) => g.ok).length, 1)
  assert.ok(gates.filter((g) => !g.ok).every((g) => g.code === 'api_key_concurrency_limit'))
  const held = gates.find((g) => g.ok)
  assert.equal(held.shared, true)
  assert.equal((await stores[1].list())[0].inflight, 1)
  await Promise.all([held.release(), held.release()])
  const next = await stores[1].reserve(key)
  assert.equal(next.ok, true)
  await held.release()
  assert.equal((await stores[0].reserve(key)).code, 'api_key_concurrency_limit')
  await next.release()
})

test('different keys share their owner concurrency across replicas', async () => {
  const stores = await replicas()
  const owner = await user(stores[0])
  const keys = await Promise.all(stores.map((s) => s.create({ max_concurrency: 0, user_id: owner.id })))
  const gates = await Promise.all(stores.map((s, i) => s.reserve(keys[i])))
  assert.equal(gates.filter((g) => g.ok).length, 1)
  assert.equal(gates.find((g) => !g.ok).code, 'user_concurrency_limit')
  await gates.find((g) => g.ok).release()
  const accepted = await stores[1].reserve(keys[1])
  assert.equal(accepted.ok, true)
  await accepted.release()
})

test('released reservations remain in the global RPM window', async () => {
  const [first, second] = await replicas()
  const key = await first.create({ max_concurrency: 0, rpm: 1 })
  const gate = await first.reserve(key)
  assert.equal(gate.ok, true)
  await gate.release()
  const denied = await second.reserve(key)
  assert.equal(denied.code, 'api_key_rate_limit')
  assert.ok(denied.retry_after_ms > 0 && denied.retry_after_ms <= 60_000)
  await first.db.prepare("UPDATE api_key_admissions SET created_at = clock_timestamp() - interval '61 seconds'").run()
  const next = await second.reserve(key)
  assert.equal(next.ok, true)
  await next.release()
})

test('request quota includes pending reservations and settles exactly once', async () => {
  const [first, second] = await replicas()
  const key = await first.create({ max_concurrency: 0, quota_requests: 1 })
  const gates = await Promise.all([first.reserve(key), second.reserve(key)])
  assert.equal(gates.filter((g) => g.ok).length, 1)
  assert.equal(gates.find((g) => !g.ok).code, 'api_key_quota_exhausted')
  const gate = gates.find((g) => g.ok)
  await first.recordUsage(key, { input_tokens: 5 }, { reservation: gate })
  assert.equal(gate.settled, true)
  await first.recordUsage(key, { input_tokens: 5 }, { reservation: gate })
  const saved = await first.getById(key.id)
  assert.equal(saved.requests, 1)
  assert.equal(saved.quota_requests_used, 1)
  assert.equal(saved.tokens_in, 5)
  assert.equal((await second.reserve(key)).code, 'api_key_quota_exhausted')
  assert.equal((await first.list())[0].inflight, 1, 'settlement does not release active execution')
  await gate.release()
  assert.equal((await first.list())[0].inflight, 0)
  assert.equal((await second.reserve(key)).code, 'api_key_quota_exhausted')
})

test('quota count and pending settlement commit together under the key lock', async () => {
  const [first, second] = await replicas()
  const key = await first.create({ max_concurrency: 0, quota_requests: 2 })
  const gate = await first.reserve(key)
  let entered
  const waiting = new Promise((resolve) => {
    entered = resolve
  })
  let resume
  const proceed = new Promise((resolve) => {
    resume = resolve
  })
  const record = first.repo.recordUsage.bind(first.repo)
  first.repo.recordUsage = async (...args) => {
    const saved = await record(...args)
    entered()
    await proceed
    return saved
  }
  const settlement = first.recordUsage(key, {}, { reservation: gate })
  await waiting
  const observed = await second.getById(key.id)
  assert.equal(observed.quota_requests_used, 0, 'an uncommitted completion is invisible')
  const otherPending = await second.db
    .prepare('SELECT count(*) AS count FROM api_key_admissions WHERE settled_at IS NULL AND released_at IS NULL')
    .get()
  assert.equal(otherPending.count, 1, 'the pending reservation remains visible until completion commits')
  const competing = second.reserve(key)
  resume()
  await settlement
  const next = await competing
  assert.equal(next.ok, true, 'one completion and one new pending request fit a quota of two')
  assert.equal((await second.reserve(key)).code, 'api_key_quota_exhausted')
  await gate.release()
  await next.release()
})

test('unbilled failures release pending quota but cannot be settled later', async () => {
  const [first, second] = await replicas()
  const key = await first.create({ max_concurrency: 0, quota_requests: 1 })
  const gate = await first.reserve(key)
  await gate.release()
  await assert.rejects(first.recordUsage(key, {}, { reservation: gate }), { code: 'api_key_reservation_released' })
  assert.equal((await first.getById(key.id)).requests, 0)
  const next = await second.reserve(key)
  assert.equal(next.ok, true)
  await next.release()
})

test('reservations re-read disabled, expired, rotated keys and missing or disabled owners', async () => {
  const [first, second] = await replicas()
  const owner = await user(first)
  const key = await first.create({ user_id: owner.id })
  await first.update(key.id, { status: 'disabled' })
  assert.equal((await second.reserve(key)).code, 'api_key_disabled')
  await first.update(key.id, { status: 'active', expires_at: new Date(Date.now() - 1000).toISOString() })
  assert.equal((await second.reserve(key)).code, 'api_key_expired')
  await first.update(key.id, { expires_at: null })
  await first.rotate(key.id)
  assert.equal((await second.reserve(key)).code, 'invalid_api_key')
  const current = await first.getById(key.id)
  await first.users.update({ ...owner, enabled: false })
  assert.equal((await second.reserve(current)).code, 'user_disabled')
  await first.users.remove(owner.id)
  assert.equal((await second.reserve(current)).code, 'user_disabled')
})

test('admin owner remains uncapped and current key configuration accompanies a reservation', async () => {
  const [first, second] = await replicas()
  const owner = await user(first, { role: 'admin' })
  const key = await first.create({ user_id: owner.id, max_concurrency: 0 })
  await first.update(key.id, { rpm: 20 })
  const gates = await Promise.all([first.reserve(key), second.reserve(key)])
  assert.ok(gates.every((g) => g.ok))
  assert.ok(gates.every((g) => g.record.rpm === 20))
  await Promise.all(gates.map((g) => g.release()))
})

test('authorization policy changes after authentication require a fresh request', async () => {
  const [first, second] = await replicas()
  const key = await first.create({ max_concurrency: 0 })
  for (const [column, value] of [
    ['category', 'api'],
    ['group_type', 'platform'],
    ['allowed_vms', '["vm-other"]'],
    ['vm_pool_id', 'pool-other'],
    ['user_id', 'owner-other'],
    ['group_id', 2],
  ]) {
    const stale = await first.getById(key.id)
    await first.db.prepare(`UPDATE api_keys SET ${column} = $1 WHERE id = $2`).run(value, key.id)
    assert.equal((await second.reserve(stale)).code, 'api_key_changed', column)
  }
})

test('a failed usage transaction retains pending quota and can be safely retried', async () => {
  const [first, second] = await replicas()
  const key = await first.create({ max_concurrency: 0, quota_requests: 1 })
  const gate = await first.reserve(key)
  const record = first.repo.recordUsage.bind(first.repo)
  first.repo.recordUsage = async (...args) => {
    await record(...args)
    throw new Error('settlement failed before commit')
  }
  await assert.rejects(first.recordUsage(key, {}, { reservation: gate }), /settlement failed before commit/)
  assert.equal(gate.settled, false)
  assert.equal((await first.getById(key.id)).quota_requests_used, 0)
  assert.equal((await second.reserve(key)).code, 'api_key_quota_exhausted')
  first.repo.recordUsage = record
  await first.recordUsage(key, {}, { reservation: gate })
  await gate.release()
  assert.equal((await first.getById(key.id)).quota_requests_used, 1)
})

test('old executing reservations do not expire or disappear when their connection closes', async () => {
  const [first, second] = await replicas()
  const key = await first.create({ max_concurrency: 1 })
  const gate = await second.reserve(key)
  await first.db.prepare("UPDATE api_key_admissions SET created_at = clock_timestamp() - interval '2 hours'").run()
  await second.db.close()
  assert.equal((await first.reserve(key)).code, 'api_key_concurrency_limit')
  const row = await first.db
    .prepare('SELECT owner_id, released_at FROM api_key_admissions WHERE id = $1')
    .get(gate.reservationId)
  assert.equal(row.owner_id, gate.ownerId)
  assert.equal(row.released_at, null)
})

test('deleting an executing key retains its owner concurrency until release', async () => {
  const [first, second] = await replicas()
  const owner = await user(first)
  const key = await first.create({ user_id: owner.id, max_concurrency: 0 })
  const otherKey = await first.create({ user_id: owner.id, max_concurrency: 0 })
  const gate = await first.reserve(key)
  assert.equal(await first.remove(key.id), true)
  assert.equal((await second.reserve(otherKey)).code, 'user_concurrency_limit')
  await gate.release()
  const next = await second.reserve(otherKey)
  assert.equal(next.ok, true)
  await next.release()
})

test('pending quota arithmetic remains exact above the safe integer boundary', async () => {
  const [first, second] = await replicas()
  const key = await first.create({ max_concurrency: 0 })
  await first.db
    .prepare('UPDATE api_keys SET quota_requests = $1, quota_requests_used = $2 WHERE id = $3')
    .run('9007199254740994', '9007199254740993', key.id)
  const gate = await first.reserve(key)
  assert.equal(gate.ok, true)
  assert.equal((await second.reserve(key)).code, 'api_key_quota_exhausted')
  await first.recordUsage(key, {}, { reservation: gate })
  await gate.release()
  assert.equal((await first.getById(key.id)).quota_requests_used, '9007199254740994')
  assert.equal((await second.reserve(key)).code, 'api_key_quota_exhausted')
})

test('an unavailable shared database cannot fall back to process-local admission', async () => {
  const [first, second] = await replicas()
  const key = await first.create({ max_concurrency: 0 })
  await second.db.close()
  await assert.rejects(second.reserve(key), /database is closed/)
  assert.equal(second.inflight.size, 0)
  assert.equal((await first.list())[0].inflight, 0)
})
