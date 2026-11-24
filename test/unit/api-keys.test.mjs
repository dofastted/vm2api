import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiKeyStore, generateApiKey, maskApiKey, makeApiKeyGateError } from '../../src/lib/admin/api-keys.mjs'

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

test('create + authenticate + list mask', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'demo', max_concurrency: 3, quota_requests: 10, rpm: 60 })
  assert.equal(rec.name, 'demo')
  assert.equal(rec.max_concurrency, 3)
  assert.equal(rec.quota_requests, 10)
  const auth = store.authenticate(rec.key)
  assert.equal(auth.ok, true)
  assert.equal(auth.record.id, rec.id)
  const stored = store.getById(rec.id)
  assert.notEqual(stored.key, rec.key)
  assert.match(stored.key, /^hmac:/)
  assert.ok(stored.key_hash)
  const listed = store.list()
  assert.equal(listed.length, 1)
  assert.ok(listed[0].key.includes('…'))
  assert.notEqual(listed[0].key, rec.key)
})

test('reveal returns the plaintext for copy; rotate swaps it in place', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'copyable', max_concurrency: 4 })
  const listed = store.list()[0]
  assert.equal(listed.revealable, true)
  assert.ok(listed.key.includes('…'), 'list stays masked')

  const shown = store.reveal(rec.id)
  assert.equal(shown.ok, true)
  assert.equal(shown.key, rec.key)

  const rotated = store.rotate(rec.id)
  assert.notEqual(rotated.key, rec.key)
  assert.equal(store.authenticate(rec.key).ok, false, 'old value dies')
  assert.equal(store.authenticate(rotated.key).ok, true)
  assert.equal(store.reveal(rec.id).key, rotated.key)
  const kept = store.getById(rec.id)
  assert.equal(kept.name, 'copyable')
  assert.equal(kept.max_concurrency, 4)
})

test('reveal reports hash-only rows as unrecoverable', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'legacy' })
  const row = store.getById(rec.id)
  row.key_secret = null
  store.repo.update(row)

  const out = store.reveal(rec.id)
  assert.equal(out.ok, false)
  assert.equal(out.code, 'key_not_recoverable')
  assert.equal(store.list()[0].revealable, false)
  assert.equal(store.reveal('key_missing'), null)
  assert.equal(store.authenticate(rec.key).ok, true, 'auth still works off the hash')
})

test('key_secret is encrypted at rest when KIN_DB_SECRET is set', () => {
  const prev = process.env.KIN_DB_SECRET
  process.env.KIN_DB_SECRET = 'unit-test-secret'
  try {
    const store = tmpStore()
    const rec = store.create({ name: 'enc' })
    const row = store.getById(rec.id)
    assert.match(row.key_secret, /^enc:v1:/)
    assert.ok(!row.key_secret.includes(rec.key))
    assert.equal(store.reveal(rec.id).key, rec.key)
  } finally {
    if (prev === undefined) delete process.env.KIN_DB_SECRET
    else process.env.KIN_DB_SECRET = prev
  }
})

test('canAccept rejects disabled / expired / quota / concurrency', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'lim', max_concurrency: 1, quota_requests: 2, rpm: 0 })
  assert.equal(store.canAccept(rec).ok, true)

  store.update(rec.id, { status: 'disabled' })
  assert.equal(store.canAccept(store.getById(rec.id)).code, 'api_key_disabled')
  store.update(rec.id, { status: 'active' })

  store.update(rec.id, { expires_at: new Date(Date.now() - 1000).toISOString() })
  assert.equal(store.canAccept(store.getById(rec.id)).code, 'api_key_expired')
  store.update(rec.id, { expires_at: null })

  const a = store.acquire(store.getById(rec.id))
  assert.equal(a.ok, true)
  const blocked = store.canAccept(store.getById(rec.id))
  assert.equal(blocked.code, 'api_key_concurrency_limit')
  store.release(rec.id)

  store.recordUsage(rec.id)
  store.recordUsage(rec.id)
  assert.equal(store.canAccept(store.getById(rec.id)).code, 'api_key_quota_exhausted')
})

test('rpm window blocks then recovers', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'rpm', max_concurrency: 0, quota_requests: 0, rpm: 2 })
  assert.equal(store.acquire(rec).ok, true)
  store.release(rec)
  assert.equal(store.acquire(rec).ok, true)
  store.release(rec)
  const gate = store.canAccept(store.getById(rec.id))
  assert.equal(gate.code, 'api_key_rate_limit')
})

test('user concurrency caps regular users but never the admin operator', () => {
  const store = tmpStore()
  const now = new Date().toISOString()
  for (const [id, role] of [
    ['u-admin', 'admin'],
    ['u-user', 'user'],
  ]) {
    store.users.insert({ id, username: id, password_hash: 'x', role, concurrency: 1, created_at: now, updated_at: now })
  }
  const admin = store.create({ name: 'admin-key', max_concurrency: 0, user_id: 'u-admin' })
  const user = store.create({ name: 'user-key', max_concurrency: 0, user_id: 'u-user' })

  for (let i = 0; i < 3; i++) assert.equal(store.acquire(admin).ok, true)

  assert.equal(store.acquire(user).ok, true)
  const blocked = store.canAccept(user)
  assert.equal(blocked.code, 'user_concurrency_limit')
  assert.equal(blocked.status, 429)
  assert.equal(blocked.limit_type, 'user_concurrency')
  assert.equal(blocked.current, 1)
  assert.equal(blocked.limit, 1)
  assert.equal(blocked.remaining, 0)
  assert.equal(blocked.reset_at, null)
  assert.equal(blocked.retry_after, 1)
  assert.deepEqual(blocked.detail, { inflight: 1, max: 1 })
})

test('update reset_quota and remove', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'x', quota_requests: 5 })
  store.recordUsage(rec.id)
  store.recordUsage(rec.id)
  assert.equal(store.getById(rec.id).quota_requests_used, 2)
  store.update(rec.id, { reset_quota: true })
  assert.equal(store.getById(rec.id).quota_requests_used, 0)
  assert.equal(store.remove(rec.id), true)
  assert.equal(store.getById(rec.id), null)
  assert.equal(store.authenticate(rec.key).ok, false)
})

test('recordUsage accumulates cache token columns', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'cache' })
  store.recordUsage(rec.id, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 7,
  })
  store.recordUsage(rec.id, { input_tokens: 1, output_tokens: 1, cache_read_tokens: 2 })
  const saved = store.getById(rec.id)
  assert.equal(saved.tokens_in, 11)
  assert.equal(saved.tokens_out, 6)
  assert.equal(saved.cache_read_tokens, 5)
  assert.equal(saved.cache_creation_tokens, 7)
})

test('custom key rejected when duplicate', () => {
  const store = tmpStore()
  store.create({ name: 'a', key: 'sk-kin-customkey0001' })
  assert.throws(() => store.create({ name: 'b', key: 'sk-kin-customkey0001' }), /exists/)
})

test('keys persist in sqlite across store re-open (same dataDir)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-keys-'))
  const store = new ApiKeyStore({ dataDir: dir })
  const rec = store.create({ name: 'persist', quota_requests: 9 })
  store.recordUsage(rec.id, { input_tokens: 11, output_tokens: 22 })

  const store2 = new ApiKeyStore({ dataDir: dir })
  const again = store2.getById(rec.id)
  assert.ok(again, 'record should survive re-open')
  assert.equal(again.name, 'persist')
  assert.equal(again.quota_requests_used, 1)
  assert.equal(again.tokens_in, 11)
  assert.equal(again.tokens_out, 22)
  assert.equal(store2.authenticate(rec.key).ok, true)
  assert.ok(fs.existsSync(path.join(dir, 'kin.db')), 'kin.db file exists')
})

test('group_type all is the default and a platform group keeps its VM list', () => {
  const store = tmpStore()
  const open = store.create({ name: 'global' })
  assert.equal(store.list()[0].group_type, 'all')
  assert.deepEqual(store.list()[0].allowed_vms, [])
  const scoped = store.create({ name: 'claude', group_type: 'anthropic', allowed_vms: ['vm-01', 'vm-03'] })
  assert.equal(store.getById(scoped.id).group_type, 'anthropic')
  assert.equal(
    store
      .list()
      .find((k) => k.id === scoped.id)
      .allowed_vms.join(','),
    'vm-01,vm-03',
  )
  const widened = store.update(scoped.id, { group_type: 'all' })
  assert.equal(widened.group_type, 'all')
  assert.equal(widened.allowed_vms, '[]')
  assert.throws(() => store.create({ name: 'bare', group_type: 'openai' }), /至少勾选一台 VM/)
  store.update(open.id, { status: 'disabled' })
  assert.equal(store.getById(open.id).group_type, 'all')
})

test('over-limit verdicts unify 402 (spend) vs 429 (RPM/concurrency/requests), metadata, Retry-After, and legacy error.type (#911)', () => {
  const store = tmpStore()
  const now = Date.parse('2026-11-24T12:00:00.000Z')

  // 1) Total USD quota -> 402 + quota_error + limit_type='usd_quota', no Retry-After
  const usdKey = store.create({ name: 'usd', quota: 2, rpm: 0, max_concurrency: 0 })
  store.recordUsage(usdKey.id, { total_cost: 2.5 })
  const usdGate = store.canAccept(store.getById(usdKey.id), now)
  assert.equal(usdGate.ok, false)
  assert.equal(usdGate.status, 402)
  assert.equal(usdGate.code, 'api_key_quota_exhausted')
  assert.equal(usdGate.limit_type, 'usd_quota')
  assert.equal(usdGate.current, 2.5)
  assert.equal(usdGate.limit, 2)
  assert.equal(usdGate.remaining, 0)
  assert.equal(usdGate.reset_at, null)
  assert.equal(usdGate.retry_after, null)
  const usdErr = makeApiKeyGateError(usdGate)
  assert.equal(usdErr.status, 402)
  assert.equal(usdErr.body.error.type, 'quota_error')
  assert.equal(usdErr.body.error.code, 'api_key_quota_exhausted')
  assert.equal(usdErr.body.error.details.limit_type, 'usd_quota')
  assert.equal(usdErr.body.error.details.current, 2.5)
  assert.equal(usdErr.body.error.details.limit, 2)
  assert.equal(usdErr.body.error.details.reset_at, null)
  assert.equal(usdErr.headers, undefined)

  // 2) 5h USD spend window -> 402 + rate_limit_error + reset_at + Retry-After
  const winKey = store.create({ name: 'win5h', rate_limit_5h: 1, rpm: 0, max_concurrency: 0 })
  store.recordUsage(winKey.id, { total_cost: 1.2 })
  const freshWin = store.getById(winKey.id)
  const winStart = Date.parse(freshWin.window_5h_start)
  const winNow = winStart + 3600_000
  const winGate = store.canAccept(freshWin, winNow)
  assert.equal(winGate.ok, false)
  assert.equal(winGate.status, 402)
  assert.equal(winGate.code, 'api_key_rate_limit')
  assert.equal(winGate.limit_type, 'spend_5h')
  assert.equal(winGate.current, 1.2)
  assert.equal(winGate.limit, 1)
  assert.equal(winGate.remaining, 0)
  assert.equal(winGate.reset_at, new Date(winStart + 5 * 3600_000).toISOString())
  assert.equal(winGate.retry_after, 4 * 3600)
  const winErr = makeApiKeyGateError(winGate)
  assert.equal(winErr.status, 402)
  assert.equal(winErr.body.error.type, 'rate_limit_error')
  assert.equal(winErr.body.error.details.limit_type, 'spend_5h')
  assert.equal(winErr.headers['Retry-After'], String(4 * 3600))

  // 3) Request-count quota -> 429 + quota_error + limit_type='requests_quota'
  const reqKey = store.create({ name: 'reqs', quota_requests: 1, rpm: 0, max_concurrency: 0 })
  store.recordUsage(reqKey.id, {})
  const reqGate = store.canAccept(store.getById(reqKey.id), now)
  assert.equal(reqGate.status, 429)
  assert.equal(reqGate.code, 'api_key_quota_exhausted')
  assert.equal(reqGate.limit_type, 'requests_quota')
  assert.equal(reqGate.current, 1)
  assert.equal(reqGate.limit, 1)
  assert.equal(reqGate.reset_at, null)
  const reqErr = makeApiKeyGateError(reqGate)
  assert.equal(reqErr.status, 429)
  assert.equal(reqErr.body.error.type, 'quota_error')
  assert.equal(reqErr.headers, undefined)

  // 4) RPM limit -> 429 + rate_limit_error + oldest+60s reset_at + Retry-After
  const rpmKey = store.create({ name: 'rpm-u', rpm: 2, max_concurrency: 0 })
  assert.equal(store.acquire(rpmKey, now - 20_000).ok, true)
  store.release(rpmKey)
  assert.equal(store.acquire(rpmKey, now - 5_000).ok, true)
  store.release(rpmKey)
  const rpmGate = store.canAccept(store.getById(rpmKey.id), now)
  assert.equal(rpmGate.status, 429)
  assert.equal(rpmGate.code, 'api_key_rate_limit')
  assert.equal(rpmGate.limit_type, 'rpm')
  assert.equal(rpmGate.current, 2)
  assert.equal(rpmGate.limit, 2)
  assert.equal(rpmGate.remaining, 0)
  assert.equal(rpmGate.reset_at, new Date(now + 40_000).toISOString())
  assert.equal(rpmGate.retry_after, 40)
  const rpmErr = makeApiKeyGateError(rpmGate)
  assert.equal(rpmErr.status, 429)
  assert.equal(rpmErr.body.error.type, 'rate_limit_error')
  assert.equal(rpmErr.headers['Retry-After'], '40')

  // 5) Key concurrency -> 429 + rate_limit_error + Retry-After: 1
  const concKey = store.create({ name: 'conc', max_concurrency: 1, rpm: 0 })
  assert.equal(store.acquire(concKey, now).ok, true)
  const concGate = store.canAccept(store.getById(concKey.id), now)
  assert.equal(concGate.status, 429)
  assert.equal(concGate.code, 'api_key_concurrency_limit')
  assert.equal(concGate.limit_type, 'key_concurrency')
  assert.equal(concGate.current, 1)
  assert.equal(concGate.limit, 1)
  assert.equal(concGate.reset_at, null)
  assert.equal(concGate.retry_after, 1)
  const concErr = makeApiKeyGateError(concGate)
  assert.equal(concErr.status, 429)
  assert.equal(concErr.body.error.type, 'rate_limit_error')
  assert.equal(concErr.headers['Retry-After'], '1')
  store.release(concKey)
})

test('dual-quota key reports 429 requests_quota when USD cap is raised while requests remain exhausted', () => {
  const store = tmpStore()
  const now = Date.parse('2026-11-24T12:00:00.000Z')
  const rec = store.create({ name: 'dual', quota: 1, quota_requests: 2, rpm: 0, max_concurrency: 0 })
  store.recordUsage(rec.id, { total_cost: 0.6 })
  store.recordUsage(rec.id, { total_cost: 0.9 })
  assert.equal(store.getById(rec.id).status, 'quota_exhausted')

  // Raising USD quota alone leaves quota_requests exhausted so status stays quota_exhausted.
  store.update(rec.id, { quota: 10 })
  const updated = store.getById(rec.id)
  assert.equal(updated.status, 'quota_exhausted')

  const gate = store.canAccept(updated, now)
  assert.equal(gate.ok, false)
  assert.equal(gate.status, 429)
  assert.equal(gate.code, 'api_key_quota_exhausted')
  assert.equal(gate.limit_type, 'requests_quota')
  assert.equal(gate.current, 2)
  assert.equal(gate.limit, 2)
  assert.equal(gate.remaining, 0)
  assert.equal(gate.reset_at, null)
  assert.equal(gate.retry_after, null)

  const err = makeApiKeyGateError(gate)
  assert.equal(err.status, 429)
  assert.equal(err.body.error.type, 'quota_error')
  assert.equal(err.body.error.details.limit_type, 'requests_quota')
  assert.equal(err.headers, undefined)
})

test('lowered RPM computes reset_at and retry_after from the timestamp that frees capacity', () => {
  const store = tmpStore()
  const now = Date.parse('2026-11-24T12:00:00.000Z')
  const rec = store.create({ name: 'rpm-lowered', rpm: 4, max_concurrency: 0 })

  // 4 requests in the last 60s at -50s, -40s, -20s, -5s
  for (const offsetMs of [50_000, 40_000, 20_000, 5_000]) {
    assert.equal(store.acquire(rec, now - offsetMs).ok, true)
    store.release(rec)
  }

  // Lower RPM to 2: 3 oldest entries (-50s, -40s, -20s) must expire before count drops below 2.
  store.update(rec.id, { rpm: 2 })
  const lowered = store.getById(rec.id)
  const gate = store.canAccept(lowered, now)
  assert.equal(gate.ok, false)
  assert.equal(gate.status, 429)
  assert.equal(gate.code, 'api_key_rate_limit')
  assert.equal(gate.limit_type, 'rpm')
  assert.equal(gate.current, 4)
  assert.equal(gate.limit, 2)
  assert.equal(gate.remaining, 0)
  const expectedResetMs = now - 20_000 + 60_000
  assert.equal(gate.reset_at, new Date(expectedResetMs).toISOString())
  assert.equal(gate.retry_after, 40)

  // Still blocked 1ms before reset_at, accepted right at reset_at.
  assert.equal(store.canAccept(lowered, expectedResetMs - 1).ok, false)
  assert.equal(store.canAccept(lowered, expectedResetMs).ok, true)
})
