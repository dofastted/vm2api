import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiKeyStore, generateApiKey, maskApiKey } from '../../src/lib/admin/api-keys.mjs'

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-keys-'))
  return new ApiKeyStore({ dataDir: dir })
}

test('generateApiKey uses sk-vm- prefix and is long enough', () => {
  const k = generateApiKey()
  assert.match(k, /^sk-vm-[a-f0-9]{64}$/)
  assert.notEqual(k, generateApiKey())
})

test('maskApiKey hides middle', () => {
  const k = 'sk-vm-' + 'a'.repeat(64)
  const m = maskApiKey(k)
  assert.ok(m.includes('…'))
  assert.ok(!m.includes('a'.repeat(20)))
})

test('create + authenticate + list mask', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'demo', max_concurrency: 3, quota_requests: 10, rpm: 60 })
  assert.equal(rec.name, 'demo')
  assert.equal(rec.max_concurrency, 3)
  assert.equal(rec.quota_requests, 10)
  const auth = await store.authenticate(rec.key)
  assert.equal(auth.ok, true)
  assert.equal(auth.record.id, rec.id)
  const stored = await store.getById(rec.id)
  assert.notEqual(stored.key, rec.key)
  assert.match(stored.key, /^hmac:/)
  assert.ok(stored.key_hash)
  const listed = await store.list()
  assert.equal(listed.length, 1)
  assert.ok(listed[0].key.includes('…'))
  assert.notEqual(listed[0].key, rec.key)
})

test('reveal returns the plaintext for copy; rotate swaps it in place', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'copyable', max_concurrency: 4 })
  const listed = (await store.list())[0]
  assert.equal(listed.revealable, true)
  assert.ok(listed.key.includes('…'), 'list stays masked')

  const shown = await store.reveal(rec.id)
  assert.equal(shown.ok, true)
  assert.equal(shown.key, rec.key)

  const rotated = await store.rotate(rec.id)
  assert.notEqual(rotated.key, rec.key)
  assert.equal((await store.authenticate(rec.key)).ok, false, 'old value dies')
  assert.equal((await store.authenticate(rotated.key)).ok, true)
  assert.equal((await store.reveal(rec.id)).key, rotated.key)
  const kept = await store.getById(rec.id)
  assert.equal(kept.name, 'copyable')
  assert.equal(kept.max_concurrency, 4)
})

test('reveal reports hash-only rows as unrecoverable', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'legacy' })
  const row = await store.getById(rec.id)
  row.key_secret = null
  await store.repo.update(row)

  const out = await store.reveal(rec.id)
  assert.equal(out.ok, false)
  assert.equal(out.code, 'key_not_recoverable')
  assert.equal((await store.list())[0].revealable, false)
  assert.equal(await store.reveal('key_missing'), null)
  assert.equal((await store.authenticate(rec.key)).ok, true, 'auth still works off the hash')
})

test('key_secret is encrypted at rest when KIN_DB_SECRET is set', async () => {
  const prev = process.env.KIN_DB_SECRET
  process.env.KIN_DB_SECRET = 'unit-test-secret'
  try {
    const store = tmpStore()
    const rec = await store.create({ name: 'enc' })
    const row = await store.getById(rec.id)
    assert.match(row.key_secret, /^enc:v1:/)
    assert.ok(!row.key_secret.includes(rec.key))
    assert.equal((await store.reveal(rec.id)).key, rec.key)
  } finally {
    if (prev === undefined) delete process.env.KIN_DB_SECRET
    else process.env.KIN_DB_SECRET = prev
  }
})

test('canAccept rejects disabled / expired / quota / concurrency', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'lim', max_concurrency: 1, quota_requests: 2, rpm: 0 })
  assert.equal((await store.canAccept(rec)).ok, true)

  await store.update(rec.id, { status: 'disabled' })
  assert.equal((await store.canAccept(await store.getById(rec.id))).code, 'api_key_disabled')
  await store.update(rec.id, { status: 'active' })

  await store.update(rec.id, { expires_at: new Date(Date.now() - 1000).toISOString() })
  assert.equal((await store.canAccept(await store.getById(rec.id))).code, 'api_key_expired')
  await store.update(rec.id, { expires_at: null })

  const a = await store.acquire(await store.getById(rec.id))
  assert.equal(a.ok, true)
  const blocked = await store.canAccept(await store.getById(rec.id))
  assert.equal(blocked.code, 'api_key_concurrency_limit')
  store.release(rec.id)

  await store.recordUsage(rec.id)
  await store.recordUsage(rec.id)
  assert.equal((await store.canAccept(await store.getById(rec.id))).code, 'api_key_quota_exhausted')
})

test('request quotas compare imported bigint counters exactly', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'large quota' })
  await store.db
    .prepare('UPDATE api_keys SET quota_requests = $1, quota_requests_used = $2 WHERE id = $3')
    .run('10000000000000000', '9007199254740993', rec.id)
  assert.equal((await store.canAccept(await store.getById(rec.id))).ok, true)
  await store.db.prepare('UPDATE api_keys SET status = $1 WHERE id = $2').run('quota_exhausted', rec.id)
  assert.equal((await store.update(rec.id, { name: 'renamed' })).status, 'active')
  await store.db.prepare('UPDATE api_keys SET quota_requests_used = quota_requests WHERE id = $1').run(rec.id)
  assert.equal((await store.canAccept(await store.getById(rec.id))).code, 'api_key_quota_exhausted')
})

test('rpm window blocks then recovers', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'rpm', max_concurrency: 0, quota_requests: 0, rpm: 2 })
  assert.equal((await store.acquire(rec)).ok, true)
  store.release(rec)
  assert.equal((await store.acquire(rec)).ok, true)
  store.release(rec)
  const gate = await store.canAccept(await store.getById(rec.id))
  assert.equal(gate.code, 'api_key_rate_limit')
})

test('user concurrency caps regular users but never the admin operator', async () => {
  const store = tmpStore()
  const now = new Date().toISOString()
  for (const [id, role] of [
    ['u-admin', 'admin'],
    ['u-user', 'user'],
  ]) {
    await store.users.insert({
      id,
      username: id,
      password_hash: 'x',
      role,
      concurrency: 1,
      created_at: now,
      updated_at: now,
    })
  }
  const admin = await store.create({ name: 'admin-key', max_concurrency: 0, user_id: 'u-admin' })
  const user = await store.create({ name: 'user-key', max_concurrency: 0, user_id: 'u-user' })

  for (let i = 0; i < 3; i++) assert.equal((await store.acquire(admin)).ok, true)

  assert.equal((await store.acquire(user)).ok, true)
  const blocked = await store.canAccept(user)
  assert.equal(blocked.code, 'user_concurrency_limit')
  assert.deepEqual(blocked.detail, { inflight: 1, max: 1 })
})

test('update reset_quota and remove', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'x', quota_requests: 5 })
  await store.recordUsage(rec.id)
  await store.recordUsage(rec.id)
  assert.equal((await store.getById(rec.id)).quota_requests_used, 2)
  await store.update(rec.id, { reset_quota: true })
  assert.equal((await store.getById(rec.id)).quota_requests_used, 0)
  assert.equal(await store.remove(rec.id), true)
  assert.equal(await store.getById(rec.id), null)
  assert.equal((await store.authenticate(rec.key)).ok, false)
})

test('recordUsage accumulates cache token columns', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'cache' })
  await store.recordUsage(rec.id, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 7,
  })
  await store.recordUsage(rec.id, { input_tokens: 1, output_tokens: 1, cache_read_tokens: 2 })
  const saved = await store.getById(rec.id)
  assert.equal(saved.tokens_in, 11)
  assert.equal(saved.tokens_out, 6)
  assert.equal(saved.cache_read_tokens, 5)
  assert.equal(saved.cache_creation_tokens, 7)
})

test('custom key rejected when duplicate', async () => {
  const store = tmpStore()
  await store.create({ name: 'a', key: 'sk-kin-customkey0001' })
  await assert.rejects(async () => await store.create({ name: 'b', key: 'sk-kin-customkey0001' }), /exists/)
})

test('keys persist in PostgreSQL across store recreation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-keys-'))
  const store = new ApiKeyStore({ dataDir: dir })
  const rec = await store.create({ name: 'persist', quota_requests: 9 })
  await store.recordUsage(rec.id, { input_tokens: 11, output_tokens: 22 })

  const store2 = new ApiKeyStore({ dataDir: dir })
  const again = await store2.getById(rec.id)
  assert.ok(again, 'record should survive re-open')
  assert.equal(again.name, 'persist')
  assert.equal(again.quota_requests_used, 1)
  assert.equal(again.tokens_in, 11)
  assert.equal(again.tokens_out, 22)
  assert.equal((await store2.authenticate(rec.key)).ok, true)
})

test('group_type all is the default and a platform group keeps its VM list', async () => {
  const store = tmpStore()
  const open = await store.create({ name: 'global' })
  assert.equal((await store.list())[0].group_type, 'all')
  assert.deepEqual((await store.list())[0].allowed_vms, [])
  const scoped = await store.create({ name: 'claude', group_type: 'anthropic', allowed_vms: ['vm-01', 'vm-03'] })
  assert.equal((await store.getById(scoped.id)).group_type, 'anthropic')
  assert.equal((await store.list()).find((k) => k.id === scoped.id).allowed_vms.join(','), 'vm-01,vm-03')
  const widened = await store.update(scoped.id, { group_type: 'all' })
  assert.equal(widened.group_type, 'all')
  assert.equal(widened.allowed_vms, '[]')
  await assert.rejects(async () => await store.create({ name: 'bare', group_type: 'openai' }), /至少勾选一台 VM/)
  await store.update(open.id, { status: 'disabled' })
  assert.equal((await store.getById(open.id)).group_type, 'all')
})

test('simultaneous owned-key acquires reserve one concurrency slot', async () => {
  const store = tmpStore()
  await store.users.insert({
    id: 'parallel-owner',
    username: 'parallel-owner',
    password_hash: 'x',
    role: 'user',
    concurrency: 1,
  })
  const key = await store.create({ name: 'parallel-key', user_id: 'parallel-owner', max_concurrency: 1 })
  const results = await Promise.all(Array.from({ length: 12 }, () => store.acquire(key)))
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.equal(store.inflight.get(key.id), 1)
  store.release(key)
  assert.equal((await store.acquire(key)).ok, true)
  store.release(key)
})

test('simultaneous usage writes retain every counter and spending window', async () => {
  const store = tmpStore()
  const key = await store.create({ name: 'parallel-billing', quota: 2 })
  await Promise.all(
    Array.from({ length: 12 }, () =>
      store.recordUsage(key.id, { input_tokens: 3, output_tokens: 2, total_cost: 0.25 }),
    ),
  )
  const row = await store.getById(key.id)
  assert.equal(row.requests, 12)
  assert.equal(row.quota_requests_used, 12)
  assert.equal(row.tokens_in, 36)
  assert.equal(row.tokens_out, 24)
  assert.equal(row.quota_used, 3)
  assert.equal(row.usage_5h, 3)
  assert.equal(row.usage_1d, 3)
  assert.equal(row.usage_7d, 3)
  assert.equal(row.status, 'quota_exhausted')
})
