import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { closeDatabase, createDatabase, getDb, openDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { zonedDayStartMs } from '../../src/lib/core/timezone.mjs'
import { createKeySelfHandler, decodeCursor, encodeCursor } from '../../src/lib/protocol/key-self.mjs'

const MASTER = 'master-secret-for-key-self-tests'
const NOW = Date.parse('2026-11-06T12:00:00.000Z')
const DAY = 86400_000

function freshDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-key-self-'))
  const db = createDatabase({ dbPath: path.join(dir, 'kin.db') })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return db
}

/** Same identity rules as server.mjs requireAuth: master, panel session, managed key (+ canAccept unless keyGate is off). */
function fakeRequireAuth(store) {
  return (req, res, { keyGate = true } = {}) => {
    if (req.panelSession) {
      req.panelUser = 'boss'
      req.panelRole = 'admin'
      return true
    }
    const auth = String(req.headers.authorization || '')
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : req.headers['x-api-key'] || ''
    if (token === MASTER) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    }
    const managed = store.authenticate(token)
    if (!managed.ok) {
      res.status = 401
      res.body = { error: { type: 'authentication_error', code: 'invalid_api_key' } }
      return false
    }
    const gate = keyGate ? store.canAccept(managed.record) : { ok: true }
    if (!gate.ok) {
      res.status = gate.status
      res.body = { error: { code: gate.code } }
      return false
    }
    req.apiKeyKind = 'managed'
    req.apiKeyRecord = managed.record
    return true
  }
}

function setup(t, { db = freshDb(t), rate, localReads = true } = {}) {
  const store = new ApiKeyStore({ db })
  const logs = new UsageLogsRepo(db)
  const handle = createKeySelfHandler({
    json(res, status, body) {
      res.status = status
      res.body = body
    },
    requireAuth: fakeRequireAuth(store),
    apiKeyStore: store,
    getUsageLogs: () => (localReads ? logs : assert.fail('usage read fell back to the main thread')),
    ...(rate ? { rate } : {}),
  })
  const call = async (pathAndQuery, { key, headers = {}, panelSession = false, now = NOW } = {}) => {
    const req = { headers: { ...headers }, panelSession }
    if (key) req.headers['x-api-key'] = key
    const res = {
      headers: {},
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v
      },
    }
    await handle(req, res, new URL(`http://localhost${pathAndQuery}`), now)
    return res
  }
  return { db, store, logs, call }
}

function addUser(store, id, { role = 'user', concurrency = 5 } = {}) {
  const at = new Date(NOW).toISOString()
  store.users.insert({ id, username: id, password_hash: 'x', role, concurrency, created_at: at, updated_at: at })
}

let seq = 0
function seedLog(logs, rec) {
  seq += 1
  logs.insertSummary({
    id: `log_${String(seq).padStart(6, '0')}`,
    request_id: `req-${seq}`,
    created_at: new Date(NOW - 60_000).toISOString(),
    log_mode: 'normal',
    method: 'POST',
    path: '/v1/messages',
    protocol: 'anthropic.messages',
    status: 200,
    model: 'claude-sonnet-5',
    api_key_kind: 'managed',
    ...rec,
  })
}

const FORBIDDEN = ['vm-secret-slot', 'acct-secret', '203.0.113.9', 'u-owner', 'u-other', 'socks5://', 'key_other']

function assertNoLeak(body) {
  const text = JSON.stringify(body)
  for (const s of FORBIDDEN) assert.ok(!text.includes(s), `response leaks ${s}`)
  for (const k of ['vm_id', 'account_id', 'final_account_id', 'user_id', 'api_key_id', 'ip', 'ip_address', 'proxy']) {
    assert.ok(!text.includes(`"${k}"`), `response carries field ${k}`)
  }
}

test('quota returns the key limits, usage and the canAccept verdict', async (t) => {
  const { store, call } = setup(t)
  addUser(store, 'u-owner', { concurrency: 3 })
  const rec = store.create({
    name: 'client-a',
    user_id: 'u-owner',
    max_concurrency: 4,
    quota: 10,
    quota_requests: 100,
    rate_limit_5h: 5,
    rate_limit_1d: 0,
    rate_limit_7d: 50,
    rpm: 30,
    expires_at: '2027-01-01T00:00:00.000Z',
  })
  store.recordUsage(rec.id, { total_cost: 2.5 })
  const sibling = store.create({ name: 'sibling', user_id: 'u-owner', max_concurrency: 0 })
  assert.equal(store.acquire(store.getById(rec.id)).ok, true)
  assert.equal(store.acquire(sibling).ok, true)

  const res = await call('/v1/me/quota', { key: rec.key, now: Date.now() })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const body = res.body
  assert.equal(body.object, 'api_key_quota')
  assert.equal(body.key.name, 'client-a')
  assert.match(body.key.masked_key, /^sk-vm-[0-9a-f]{2}…[0-9a-f]{4}$/)
  assert.ok(!JSON.stringify(body).includes(rec.key), 'never the plaintext')
  assert.equal(body.key.status, 'active')
  assert.equal(body.key.expires_at, '2027-01-01T00:00:00.000Z')
  assert.equal(body.key.expired, false)
  assert.equal(body.accepting, true)
  assert.equal(body.blocked_by, null)
  assert.deepEqual(body.usd, { limit: 10, used: 2.5, remaining: 7.5, exceeded: false })
  assert.deepEqual(body.requests, { limit: 100, used: 1, remaining: 99, exceeded: false })
  const stored = store.getById(rec.id)
  assert.equal(body.windows['5h'].used, 2.5)
  assert.equal(body.windows['5h'].remaining, 2.5)
  assert.equal(body.windows['5h'].window_start, stored.window_5h_start)
  assert.equal(body.windows['5h'].reset_at, new Date(Date.parse(stored.window_5h_start) + 5 * 3600_000).toISOString())
  assert.deepEqual(
    { limit: body.windows['1d'].limit, remaining: body.windows['1d'].remaining, used: body.windows['1d'].used },
    { limit: null, remaining: null, used: 2.5 },
    'unlimited window still reports spend',
  )
  assert.equal(body.windows['7d'].reset_at, new Date(Date.parse(stored.window_7d_start) + 7 * DAY).toISOString())
  assert.deepEqual(body.rpm, { limit: 30, current: 1, exceeded: false })
  assert.deepEqual(body.concurrency, { limit: 4, inflight: 1, exceeded: false })
  assert.deepEqual(body.user_concurrency, { limit: 3, inflight: 2, exceeded: false })
  assertNoLeak(body)
})

test('quota limits read null when unlimited; keys without an owner have no user concurrency', async (t) => {
  const { store, call } = setup(t)
  const rec = store.create({ name: 'free', max_concurrency: 0 })
  const { body } = await call('/v1/me/quota', { key: rec.key })
  assert.deepEqual(body.usd, { limit: null, used: 0, remaining: null, exceeded: false })
  assert.deepEqual(body.requests, { limit: null, used: 0, remaining: null, exceeded: false })
  assert.deepEqual(body.windows['5h'], {
    limit: null,
    used: 0,
    remaining: null,
    exceeded: false,
    window_start: null,
    reset_at: null,
  })
  assert.deepEqual(body.rpm, { limit: null, current: 0, exceeded: false })
  assert.deepEqual(body.concurrency, { limit: null, inflight: 0, exceeded: false })
  assert.equal(body.user_concurrency, null)
  assert.equal(body.key.expires_at, null)
})

test('admin owners show no user concurrency cap, same as canAccept', async (t) => {
  const { store, call } = setup(t)
  addUser(store, 'u-admin', { role: 'admin', concurrency: 1 })
  const rec = store.create({ name: 'ops', user_id: 'u-admin', max_concurrency: 0 })
  store.acquire(rec)
  store.acquire(rec)
  assert.equal(store.canAccept(rec).ok, true)
  const { body } = await call('/v1/me/quota', { key: rec.key })
  assert.deepEqual(body.user_concurrency, { limit: null, inflight: 2, exceeded: false })
  assert.equal(body.accepting, true)
})

test('master key and panel sessions get 400; disabled, deleted and disabled-owner keys get 401', async (t) => {
  const { store, call } = setup(t)
  for (const p of ['/v1/me/quota', '/v1/me/usage']) {
    const master = await call(p, { headers: { authorization: `Bearer ${MASTER}` } })
    assert.equal(master.status, 400)
    assert.equal(master.body.error.code, 'managed_key_required')
    const panel = await call(p, { panelSession: true })
    assert.equal(panel.status, 400)
    assert.equal(panel.body.error.code, 'managed_key_required')
  }

  const disabled = store.create({ name: 'off' })
  store.update(disabled.id, { status: 'disabled' })
  for (const p of ['/v1/me/quota', '/v1/me/usage']) {
    const res = await call(p, { key: disabled.key })
    assert.equal(res.status, 401)
    assert.equal(res.body.error.type, 'authentication_error')
    assert.equal(res.body.error.code, 'api_key_disabled')
  }

  const gone = store.create({ name: 'gone' })
  store.remove(gone.id)
  assert.equal((await call('/v1/me/quota', { key: gone.key })).status, 401)

  addUser(store, 'u-banned')
  const orphan = store.create({ name: 'banned-owner', user_id: 'u-banned' })
  store.users.update({ ...store.users.getById('u-banned'), enabled: false })
  assert.equal((await call('/v1/me/quota', { key: orphan.key })).status, 401)

  assert.equal((await call('/v1/me/quota', { key: 'sk-vm-not-a-real-key-0000' })).status, 401)
  assert.equal((await call('/v1/me/quota')).status, 401)
})

test('expired and exhausted keys still read their quota and see why they are refused', async (t) => {
  const { store, call } = setup(t)
  const expired = store.create({ name: 'old', expires_at: new Date(Date.now() - 1000).toISOString() })
  let res = await call('/v1/me/quota', { key: expired.key, now: Date.now() })
  assert.equal(res.status, 200)
  assert.equal(res.body.key.expired, true)
  assert.equal(res.body.accepting, false)
  assert.deepEqual(res.body.blocked_by, { code: 'api_key_expired', message: 'API key has expired', status: 403 })
  assert.equal((await call('/v1/me/usage', { key: expired.key })).status, 200)

  const usd = store.create({ name: 'broke', quota: 1 })
  store.recordUsage(usd.id, { total_cost: 1.25 })
  assert.equal(store.getById(usd.id).status, 'quota_exhausted')
  res = await call('/v1/me/quota', { key: usd.key })
  assert.equal(res.status, 200)
  assert.equal(res.body.key.status, 'quota_exhausted')
  assert.deepEqual(res.body.usd, { limit: 1, used: 1.25, remaining: 0, exceeded: true })
  assert.equal(res.body.blocked_by.code, 'api_key_quota_exhausted')
  assert.equal((await call('/v1/me/usage', { key: usd.key })).status, 200)

  const counted = store.create({ name: 'counted', quota_requests: 1 })
  store.recordUsage(counted.id, {})
  res = await call('/v1/me/quota', { key: counted.key })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.requests, { limit: 1, used: 1, remaining: 0, exceeded: true })
  assert.equal(res.body.blocked_by.code, 'api_key_quota_exhausted')
})

test('every limit flag agrees with canAccept', async (t) => {
  const { db, store, call } = setup(t)
  addUser(store, 'u-cap', { concurrency: 1 })
  const now = Date.now()
  const scenarios = [
    ['open', {}, () => {}],
    [
      'window 5h spent',
      { rate_limit_5h: 1 },
      (rec) => store.recordUsage(rec.id, { total_cost: 1 }),
      (b) => b.windows['5h'].exceeded,
    ],
    [
      'window 7d spent',
      { rate_limit_7d: 2 },
      (rec) => store.recordUsage(rec.id, { total_cost: 3 }),
      (b) => b.windows['7d'].exceeded,
    ],
    [
      'window 5h closed',
      { rate_limit_5h: 1 },
      (rec) => {
        store.recordUsage(rec.id, { total_cost: 5 })
        const stale = new Date(now - 5 * 3600_000).toISOString()
        db.prepare('UPDATE api_keys SET window_5h_start = ? WHERE id = ?').run(stale, rec.id)
      },
      (b) => b.windows['5h'].used === 0 && b.windows['5h'].reset_at === null && !b.windows['5h'].exceeded,
    ],
    [
      'rpm full',
      { rpm: 2, max_concurrency: 0 },
      (rec) => {
        store.acquire(rec, now)
        store.release(rec)
        store.acquire(rec, now)
        store.release(rec)
      },
      (b) => b.rpm.exceeded && b.rpm.current === 2,
    ],
    ['key concurrency full', { max_concurrency: 1 }, (rec) => store.acquire(rec), (b) => b.concurrency.exceeded],
    [
      'user concurrency full',
      { max_concurrency: 0, user_id: 'u-cap' },
      (rec) => store.acquire(store.create({ name: 'peer', user_id: 'u-cap', max_concurrency: 0 })),
      (b) => b.user_concurrency.exceeded && b.user_concurrency.inflight === 1,
    ],
  ]
  for (const [label, input, arrange, flagged] of scenarios) {
    const rec = store.create({ name: label, ...input })
    arrange(rec)
    const fresh = store.getById(rec.id)
    const gate = store.canAccept(fresh, now)
    const { body } = await call('/v1/me/quota', { key: rec.key, now })
    assert.equal(body.accepting, gate.ok, label)
    assert.equal(body.blocked_by?.code ?? null, gate.ok ? null : gate.code, label)
    if (flagged) assert.ok(flagged(body), `${label}: ${JSON.stringify(body)}`)
  }
})

test('self queries take no concurrency, RPM or usage', async (t) => {
  const { store, logs, call } = setup(t)
  const rec = store.create({ name: 'quiet', rpm: 1, max_concurrency: 1 })
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('/v1/me/quota', { key: rec.key })).status, 200)
    assert.equal((await call('/v1/me/usage', { key: rec.key })).status, 200)
  }
  const after = store.getById(rec.id)
  assert.equal(after.requests, 0)
  assert.equal(after.quota_requests_used, 0)
  assert.equal(after.last_used_at, null)
  assert.equal(store.inflight.get(rec.id) || 0, 0)
  assert.equal(store._rpmCount(rec.id), 0)
  assert.equal(logs.count(), 0)
  assert.equal(store.canAccept(after).ok, true)
})

test('usage sums today / 7d / 30d by client model and sees only this key', async (t) => {
  const { store, logs, call } = setup(t)
  addUser(store, 'u-owner')
  addUser(store, 'u-other')
  const mine = store.create({ name: 'mine', user_id: 'u-owner' })
  const sibling = store.create({ name: 'sibling', user_id: 'u-owner' })
  const stranger = store.create({ name: 'stranger', user_id: 'u-other' })
  const at = (ms) => new Date(ms).toISOString()
  const leaky = {
    vm_id: 'vm-secret-slot',
    account_id: 'acct-secret',
    final_account_id: 'acct-secret',
    ip_address: '203.0.113.9',
    user_id: 'u-owner',
    vm_owner_user_id: 'u-other',
    upstream_model: 'claude-mapped-target',
  }
  const row = (key, ms, extra) => seedLog(logs, { api_key_id: key.id, created_at: at(ms), ...leaky, ...extra })
  row(mine, NOW - 60_000, {
    model: 'claude-sonnet-5',
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 30,
    cache_creation_tokens: 40,
    total_cost: 1,
    actual_cost: 0.5,
  })
  row(mine, NOW - 3 * DAY, { model: 'claude-opus-5', input_tokens: 1, output_tokens: 2, actual_cost: 2 })
  row(mine, NOW - 20 * DAY, { model: 'claude-sonnet-5', input_tokens: 5, actual_cost: 0.25 })
  row(mine, NOW - 40 * DAY, { model: 'claude-sonnet-5', input_tokens: 999, actual_cost: 99 })
  row(mine, NOW - 2 * 3600_000, { model: 'claude-sonnet-5', status: 429, error_code: 'upstream_rate_limit' })
  row(sibling, NOW - 60_000, { model: 'claude-sonnet-5', input_tokens: 7777, actual_cost: 7 })
  row(stranger, NOW - 60_000, { model: 'gpt-6', input_tokens: 8888, actual_cost: 8 })
  seedLog(logs, { api_key_id: null, api_key_kind: 'master', created_at: at(NOW - 60_000), actual_cost: 9 })

  const res = await call('/v1/me/usage', { key: mine.key })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const { periods, recent, timezone } = res.body
  assert.equal(res.body.object, 'api_key_usage')
  assert.equal(timezone, 'UTC')
  assert.equal(periods.today.since, '2026-11-06T00:00:00.000Z')
  assert.equal(periods['7d'].since, '2026-10-31T00:00:00.000Z')
  assert.equal(periods['30d'].since, '2026-10-08T00:00:00.000Z')

  assert.equal(periods.today.requests, 2)
  assert.equal(periods.today.input_tokens, 10)
  assert.equal(periods.today.total_tokens, 100)
  assert.equal(periods.today.cost, 0.5)
  assert.deepEqual(
    periods.today.models.map((m) => [m.model, m.requests, m.cost]),
    [['claude-sonnet-5', 2, 0.5]],
  )
  assert.equal(periods['7d'].requests, 3)
  assert.equal(periods['7d'].cost, 2.5)
  assert.deepEqual(
    periods['7d'].models.map((m) => [m.model, m.requests, m.cost]),
    [
      ['claude-opus-5', 1, 2],
      ['claude-sonnet-5', 2, 0.5],
    ],
  )
  assert.equal(periods['30d'].requests, 4)
  assert.equal(periods['30d'].input_tokens, 16)
  assert.equal(periods['30d'].cost, 2.75)

  assert.equal(recent.items.length, 5, 'recent is not bounded to 30 days')
  assert.deepEqual(Object.keys(recent.items[0]).sort(), [
    'cache_creation_tokens',
    'cache_read_tokens',
    'cost',
    'created_at',
    'duration_ms',
    'error_code',
    'input_tokens',
    'model',
    'output_tokens',
    'request_id',
    'status',
  ])
  assert.equal(recent.items[0].model, 'claude-sonnet-5')
  assert.equal(recent.items[0].cost, 0.5)
  assert.equal(recent.items[1].status, 429)
  assert.equal(recent.items[1].error_code, 'upstream_rate_limit')
  assert.equal(recent.has_more, false)
  assert.equal(recent.next_before, null)
  assertNoLeak(res.body)
  assert.ok(!JSON.stringify(res.body).includes('claude-mapped-target'), 'mapping target stays internal')

  const other = await call('/v1/me/usage', { key: stranger.key })
  assert.equal(other.body.periods.today.requests, 1)
  assert.equal(other.body.periods.today.models[0].model, 'gpt-6')
  assert.equal(other.body.recent.items.length, 1)
})

test('usage today follows tz; unknown tz falls back to UTC', async (t) => {
  const { store, call } = setup(t)
  const rec = store.create({ name: 'tz' })
  const sh = await call('/v1/me/usage?tz=Asia/Shanghai', { key: rec.key })
  assert.equal(sh.body.timezone, 'Asia/Shanghai')
  assert.equal(sh.body.periods.today.since, new Date(zonedDayStartMs(NOW, 'Asia/Shanghai')).toISOString())
  assert.equal(sh.body.periods.today.since, '2026-11-05T16:00:00.000Z')
  const bad = await call('/v1/me/usage?tz=Mars/Base', { key: rec.key })
  assert.equal(bad.body.timezone, 'UTC')
})

test('recent requests page by cursor without gaps or repeats, capped at 100', async (t) => {
  const { store, logs, call } = setup(t)
  const rec = store.create({ name: 'pager' })
  const other = store.create({ name: 'noise' })
  const tied = new Date(NOW - 10 * 60_000).toISOString()
  for (let i = 0; i < 25; i++) {
    // five rows share a timestamp so the id tiebreak is exercised
    const created_at = i < 5 ? tied : new Date(NOW - (i + 20) * 60_000).toISOString()
    seedLog(logs, { api_key_id: rec.id, created_at, request_id: `mine-${i}` })
    seedLog(logs, { api_key_id: other.id, created_at, request_id: `noise-${i}` })
  }

  const first = await call('/v1/me/usage', { key: rec.key })
  assert.equal(first.body.recent.items.length, 20, 'default limit')
  assert.equal(first.body.recent.has_more, true)
  assert.ok(first.body.recent.next_before)
  const second = await call(`/v1/me/usage?before=${encodeURIComponent(first.body.recent.next_before)}`, {
    key: rec.key,
  })
  assert.equal(second.body.recent.items.length, 5)
  assert.equal(second.body.recent.has_more, false)
  assert.equal(second.body.recent.next_before, null)
  const ids = [...first.body.recent.items, ...second.body.recent.items].map((r) => r.request_id)
  assert.equal(new Set(ids).size, 25)
  assert.ok(ids.every((id) => id.startsWith('mine-')))
  const times = [...first.body.recent.items, ...second.body.recent.items].map((r) => r.created_at)
  assert.deepEqual(times, [...times].sort().reverse(), 'newest first')

  let cursor = null
  const walked = []
  for (let guard = 0; guard < 20; guard++) {
    const q = cursor ? `?limit=4&before=${encodeURIComponent(cursor)}` : '?limit=4'
    const page = await call(`/v1/me/usage${q}`, { key: rec.key })
    assert.ok(page.body.recent.items.length <= 4)
    walked.push(...page.body.recent.items.map((r) => r.request_id))
    cursor = page.body.recent.next_before
    if (!page.body.recent.has_more) break
  }
  assert.deepEqual(walked, ids, 'small pages walk the same rows through the tied timestamp')

  const byTime = await call(`/v1/me/usage?before=${encodeURIComponent(tied)}&limit=100`, { key: rec.key })
  assert.equal(byTime.body.recent.items.length, 20, 'plain ISO time keeps rows strictly older')

  for (const i of [0, 1]) {
    seedLog(logs, { api_key_id: rec.id, created_at: new Date(NOW - (i + 1) * 1000).toISOString() })
  }
  const capped = await call('/v1/me/usage?limit=500', { key: rec.key })
  assert.equal(capped.body.recent.items.length, 27)
  for (let i = 0; i < 100; i++) seedLog(logs, { api_key_id: rec.id, created_at: new Date(NOW - 5000).toISOString() })
  const max = await call('/v1/me/usage?limit=500', { key: rec.key })
  assert.equal(max.body.recent.items.length, 100)
  assert.equal(max.body.recent.has_more, true)

  const bad = await call('/v1/me/usage?before=not-a-cursor!', { key: rec.key })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'invalid_cursor')
  assert.equal(bad.body.error.param, 'before')
})

test('key self-service reads seek the existing api_key_id index', (t) => {
  const db = freshDb(t)
  const plan = (sql, ...params) =>
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((r) => r.detail)
      .join('\n')
  const seen = []
  const logs = new UsageLogsRepo(db)
  const prepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    if (/FROM usage_logs\s+WHERE api_key_id/.test(sql)) seen.push(sql)
    return prepare(sql)
  }
  logs.keyUsagePeriods({ apiKeyId: 'k', periods: [{ name: 'today', since: NOW }] })
  logs.keyRecentRequests({ apiKeyId: 'k', before: { created_at: new Date(NOW).toISOString(), id: 'log_x' } })
  db.prepare = prepare
  assert.equal(seen.length, 2)
  for (const sql of seen) {
    const detail = plan(sql, ...Array.from({ length: (sql.match(/\?/g) || []).length }, () => 'x'))
    assert.match(detail, /USING INDEX idx_reqlog_key \(api_key_id=\? AND created_at[<>]\?\)/, detail)
  }
})

test('cursor round-trips and rejects junk', () => {
  const next = { created_at: '2026-11-06T11:00:00.000Z', id: 'log_abc' }
  assert.deepEqual(decodeCursor(encodeCursor(next)), { ok: true, before: next })
  assert.deepEqual(decodeCursor(''), { ok: true, before: null })
  assert.deepEqual(decodeCursor('2026-11-06T11:00:00+08:00'), {
    ok: true,
    before: { created_at: '2026-11-06T03:00:00.000Z' },
  })
  assert.equal(decodeCursor('2026-13-99').ok, false)
  assert.equal(decodeCursor('abc').ok, false)
  assert.equal(decodeCursor(Buffer.from('hello').toString('base64url')).ok, false)
  assert.equal(encodeCursor(null), null)
})

test('self queries are rate limited per key with Retry-After', async (t) => {
  const { store, call } = setup(t, { rate: { capacity: 3, refillPerSec: 1 / 20 } })
  const a = store.create({ name: 'a' })
  const b = store.create({ name: 'b' })
  assert.equal((await call('/v1/me/quota', { key: a.key })).status, 200)
  assert.equal((await call('/v1/me/usage', { key: a.key })).status, 200)
  assert.equal((await call('/v1/me/quota', { key: a.key })).status, 200)
  const limited = await call('/v1/me/usage', { key: a.key })
  assert.equal(limited.status, 429)
  assert.equal(limited.body.error.code, 'gateway_rate_limit')
  assert.equal(limited.headers['retry-after'], '20')
  assert.equal((await call('/v1/me/quota', { key: b.key })).status, 200, 'other keys keep their own bucket')
  assert.equal(store.canAccept(store.getById(a.id)).ok, true, 'inference gate is untouched')
})

test('usage reads go through the read-only worker pool when it runs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-key-self-pool-'))
  openDatabase({ dataDir: dir, pooled: true })
  t.after(() => {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const { store, logs, call } = setup(t, { db: getDb(), localReads: false })
  const rec = store.create({ name: 'pooled' })
  seedLog(logs, { api_key_id: rec.id, created_at: new Date(NOW - 60_000).toISOString(), actual_cost: 1.5 })
  const pooled = await call('/v1/me/usage', { key: rec.key })
  assert.equal(pooled.status, 200)
  assert.equal(pooled.body.periods.today.cost, 1.5)
  assert.equal(pooled.body.recent.items.length, 1)
  const local = logs.keyUsagePeriods({ apiKeyId: rec.id, periods: [{ name: 'today', since: '2026-11-06T00:00:00Z' }] })
  assert.deepEqual(pooled.body.periods.today, local.today)
})
