import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'

let seq = 0

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ulview-'))
  const db = createDatabase({ dbPath: path.join(dir, 'logs.db') })
  db.exec(`
    INSERT INTO users (id, email, username, password_hash) VALUES ('u1', 'a@x', 'alice', 'x'), ('u2', 'b@x', 'bob', 'x');
    INSERT INTO api_keys (id, name, key, user_id) VALUES ('k1', 'alice-key', 'sk-1', 'u1'), ('k2', 'bob-key', 'sk-2', 'u2');
    INSERT INTO vms (id, name, vm_json) VALUES ('vm-a', 'Slot A', '{}'), ('vm-b', 'Slot B', '{}');
    INSERT INTO accounts (id, vm_id, email, name) VALUES ('acc-a', 'vm-a', 'a@pool', 'A'), ('acc-b', 'vm-b', NULL, 'Bee');
  `)
  return db
}

/** Insert rows newest-last; created_at defaults to a strictly increasing clock. */
function seed(db, rows) {
  const repo = new UsageLogsRepo(db)
  const out = []
  db.exec('BEGIN')
  for (const r of rows) {
    seq++
    const rec = {
      id: `log_${String(seq).padStart(8, '0')}`,
      request_id: `req-${seq}`,
      created_at: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(),
      log_mode: 'normal',
      method: 'POST',
      path: '/v1/messages',
      protocol: 'anthropic.messages',
      model: 'claude-sonnet-4',
      status: 200,
      vm_id: 'vm-a',
      ...r,
    }
    repo.insertSummary(rec)
    out.push(rec)
  }
  db.exec('COMMIT')
  return out
}

function pageAll(view, filters) {
  const seen = []
  let cursor = null
  for (let i = 0; i < 50; i++) {
    const page = view.listBatch({
      ...filters,
      cursor_created_at: cursor?.createdAt,
      cursor_id: cursor?.id,
    })
    seen.push(...page.logs)
    if (!page.hasMore) return { seen, pages: i + 1 }
    assert.ok(page.nextCursor, 'hasMore without cursor')
    cursor = page.nextCursor
  }
  throw new Error('paging did not terminate')
}

test('keyset paging returns every row once, newest first', () => {
  const db = freshDb()
  const rows = seed(
    db,
    Array.from({ length: 5 }, () => ({})),
  )
  const view = new UsageLogsView(db)
  const first = view.listBatch({ limit: 2 })
  assert.deepEqual(
    first.logs.map((r) => r.id),
    [rows[4].id, rows[3].id],
  )
  assert.equal(first.hasMore, true)
  const { seen, pages } = pageAll(view, { limit: 2 })
  assert.equal(pages, 3)
  assert.deepEqual(
    seen.map((r) => r.id),
    rows.map((r) => r.id).reverse(),
  )
})

test('JS-filtered paging hands back the scan cursor instead of ending early', () => {
  const db = freshDb()
  const old = seed(db, [
    { status: 504, error_code: 'upstream_timeout' },
    { status: 504, error_code: 'upstream_timeout' },
    { status: 504, error_code: 'upstream_timeout' },
  ])
  // 2100 newer errors of another class: more than one call's scan budget.
  seed(
    db,
    Array.from({ length: 2100 }, () => ({ status: 500, error_code: 'upstream_error' })),
  )
  const view = new UsageLogsView(db)
  const first = view.listBatch({ error_class: 'timeout', limit: 50 })
  assert.equal(first.logs.length, 0)
  assert.equal(first.hasMore, true)
  assert.ok(first.nextCursor)
  const { seen } = pageAll(view, { error_class: 'timeout', limit: 50 })
  assert.deepEqual(
    seen.map((r) => r.id),
    old.map((r) => r.id).reverse(),
  )
  assert.ok(seen.every((r) => r.errorClass === 'timeout'))
})

test('user owner scope keeps only own key / own user rows and ignores other tenants', () => {
  const db = freshDb()
  seed(db, [
    { user_id: 'u1', api_key_id: 'k1' },
    { user_id: null, api_key_id: 'k1' },
    { user_id: 'u2', api_key_id: 'k2' },
  ])
  const view = new UsageLogsView(db)
  const mine = view.listBatch({ owner_user_id: 'u1' }).logs
  assert.equal(mine.length, 2)
  assert.ok(mine.every((r) => r.keyId === 'k1'))
  assert.equal(view.summary({ owner_user_id: 'u1' }).totalRequests, 2)
  const opts = view.filterOptions({ owner_user_id: 'u1' })
  assert.deepEqual(opts.users, [{ id: 'u1', name: 'alice' }])
  assert.deepEqual(opts.keys, [{ id: 'k1', name: 'alice-key', userId: 'u1' }])
  assert.equal(view.listBatch({ user_id: 'u2' }).logs.length, 1)
})

test('muting follows RequestLogStore: settings default, explicit list, include_muted, error_class override', () => {
  const db = freshDb()
  seed(db, [
    { status: 401, error_code: 'invalid_api_key', vm_id: null },
    { status: 429, error_code: 'quota_5h_safety' },
    { status: 200 },
  ])
  const classes = (view, f = {}) =>
    view
      .listBatch(f)
      .logs.map((r) => r.errorClass ?? 'ok')
      .sort()
  const byDefault = new UsageLogsView(db)
  assert.deepEqual(classes(byDefault), ['ok', 'quota'])
  const settings = new UsageLogsView(db, { mutedErrorClasses: ['auth', 'quota'] })
  assert.deepEqual(classes(settings), ['ok'])
  assert.equal(settings.summary({}).totalRequests, 1)
  assert.deepEqual(classes(settings, { include_muted: true }), ['auth', 'ok', 'quota'])
  assert.deepEqual(classes(settings, { error_class: 'auth' }), ['auth'])
  assert.deepEqual(classes(settings, { exclude_error_class: 'quota' }), ['auth', 'ok'])
})

test('summary cache hit rate counts Claude writes and Codex disjoint input on both summary paths', () => {
  const db = freshDb()
  seed(db, [
    { input_tokens: 20, cache_read_tokens: 80_000, cache_creation_tokens: 20_000 },
    { via: 'codex-kernel', model: 'gpt-5.4', input_tokens: 20, cache_read_tokens: 80 },
  ])
  const want = 80_080 / 100_120
  const sqlPath = new UsageLogsView(db).summary({})
  const scanPath = new UsageLogsView(db, { mutedErrorClasses: ['auth', 'quota'] }).summary({})
  for (const summary of [sqlPath, scanPath]) {
    assert.equal(summary.totalRequests, 2)
    assert.ok(Math.abs(summary.cacheHitRate - want) < 1e-9, String(summary.cacheHitRate))
  }
})

test('provider chains for a page come from one request_attempts query, ordered by attempt', () => {
  const db = freshDb()
  const [a, b, c] = seed(db, [
    { account_id: 'acc-a' },
    { final_account_id: 'acc-b', vm_id: 'vm-b', duration_ms: 2000 },
    {},
  ])
  const before = (row, ms) => new Date(Date.parse(row.created_at) - ms).toISOString()
  const ins = db.prepare(
    'INSERT INTO request_attempts (request_id, attempt_no, vm_id, account_id, started_at, selection_reason, downstream_committed) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  ins.run(a.request_id, 2, 'vm-b', 'acc-b', before(a, 200), 'failover', 1)
  ins.run(a.request_id, 1, 'vm-a', 'acc-a', before(a, 500), 'sticky', 0)
  ins.run(b.request_id, 1, 'vm-b', 'acc-b', before(b, 1500), 'roundrobin', 1)
  // Client-chosen x-request-id reused by later / earlier requests: their attempts
  // fall outside the row's own lifetime and must not be attached.
  ins.run(b.request_id, 2, 'vm-a', 'acc-a', before(b, 60_000), 'sticky', 1)
  ins.run(c.request_id, 1, 'vm-b', 'acc-b', before(c, -3600_000), 'sticky', 1)

  const attemptQueries = []
  const spy = {
    prepare(sql) {
      if (/request_attempts/.test(sql)) attemptQueries.push(sql)
      return db.prepare(sql)
    },
  }
  const logs = new UsageLogsView(spy).listBatch({}).logs
  assert.equal(attemptQueries.length, 1)
  const rowA = logs.find((r) => r.requestId === a.request_id)
  assert.deepEqual(
    rowA.providerChain.map((c) => [
      c.attemptNumber,
      c.vmName,
      c.providerName,
      c.selectionReason,
      c.downstreamCommitted,
    ]),
    [
      [1, 'Slot A', 'a@pool', 'sticky', false],
      [2, 'Slot B', 'Bee', 'failover', true],
    ],
  )
  assert.equal(rowA.providerName, 'a@pool')
  const rowB = logs.find((r) => r.requestId === b.request_id)
  assert.equal(rowB.providerName, 'Bee')
  assert.equal(rowB.vmName, 'Slot B')
  assert.deepEqual(
    rowB.providerChain.map((c) => c.attemptNumber),
    [1],
  )
  assert.deepEqual(logs.find((r) => r.requestId === c.request_id).providerChain, [])
})

test('filters: model/requested_model, status, attempts, session, debug, time, q', () => {
  const db = freshDb()
  const rows = seed(db, [
    { model: 'claude-opus-4', requested_model: 'opus-alias', session_id: 's-1', outbound_session_id: 'out-1' },
    { status: 500, error_code: 'upstream_error', attempt_count: 3, session_id: 's-2', outbound_session_id: 'out-2' },
    { status: 204, log_mode: 'debug', path: '/v1/chat/completions' },
    { status: 200, error_message: 'needle here', attempt_count: 1 },
  ])
  const view = new UsageLogsView(db)
  const ids = (f) =>
    view
      .listBatch(f)
      .logs.map((r) => r.id)
      .sort()
  assert.deepEqual(ids({ model: 'opus-alias' }), [rows[0].id])
  assert.deepEqual(ids({ status_code: '500' }), [rows[1].id])
  assert.deepEqual(ids({ exclude_status_200: true }), [rows[1].id])
  assert.deepEqual(ids({ exclude_status_200: true, status_code: '204' }), [rows[2].id])
  assert.deepEqual(ids({ min_attempt_count: '2' }), [rows[1].id])
  // Either the caller's id or the id the gateway sent upstream finds the row.
  assert.deepEqual(ids({ session_id: 's-2' }), [rows[1].id])
  assert.deepEqual(ids({ session_id: 'out-2' }), [rows[1].id])
  const [first] = view.listBatch({ session_id: 'out-1' }).logs
  assert.equal(first.sessionId, 'out-1')
  assert.equal(first.clientSessionId, 's-1')
  assert.deepEqual(ids({ debug_only: true }), [rows[2].id])
  assert.deepEqual(ids({ endpoint: '/v1/chat/completions' }), [rows[2].id])
  assert.deepEqual(ids({ q: 'needle' }), [rows[3].id])
  assert.deepEqual(ids({ start_time: rows[1].created_at, end_time: rows[3].created_at }), [rows[1].id, rows[2].id])
})

test('row badges: via only when non-default, context1m from long_context, fast/priority', () => {
  const db = freshDb()
  const [plain, special] = seed(db, [
    { via: 'go-worker-pool', stream: true },
    {
      via: 'api-kernel',
      long_context: 1,
      speed: 'fast',
      service_tier: 'priority',
      requested_model: 'a',
      upstream_model: 'b',
      model_mismatch: 1,
      workspace: 'client',
    },
  ])
  const logs = new UsageLogsView(db).listBatch({}).logs
  const keys = (id) =>
    logs
      .find((r) => r.id === id)
      .specialSettings.map((s) => s.key)
      .sort()
  assert.deepEqual(keys(plain.id), ['stream'])
  assert.deepEqual(keys(special.id), ['context1m', 'fast', 'mismatch', 'priority', 'via'])
  assert.equal(logs.find((r) => r.id === special.id).context1mApplied, true)
  assert.equal(logs.find((r) => r.id === plain.id).context1mApplied, null)
})

test('#777 badge: sent priority with a non-priority upstream echo is a Fast downgrade', () => {
  const db = freshDb()
  const [downgraded, honored, unechoed] = seed(db, [
    { protocol: 'openai.responses', service_tier: 'priority', upstream_service_tier: 'default' },
    { protocol: 'openai.responses', service_tier: 'priority', upstream_service_tier: 'priority' },
    { protocol: 'openai.responses', service_tier: 'priority' },
  ])
  const logs = new UsageLogsView(db).listBatch({}).logs
  const row = (id) => logs.find((r) => r.id === id)
  const downgrade = (id) => row(id).specialSettings.find((s) => s.key === 'tier_downgrade')
  assert.equal(downgrade(downgraded.id)?.value, 'priority → default')
  assert.equal(row(downgraded.id).upstreamServiceTier, 'default')
  assert.equal(downgrade(honored.id), undefined)
  assert.equal(downgrade(unechoed.id), undefined)
})

test('overview splits today/yesterday-same-time in the requested zone', () => {
  const db = freshDb()
  const now = Date.parse('2026-03-10T04:00:00Z') // 12:00 in Shanghai
  seed(db, [
    { created_at: '2026-03-09T02:00:00.000Z', total_cost: 1 }, // yesterday 10:00 local
    { created_at: '2026-03-09T06:00:00.000Z', total_cost: 2 }, // yesterday 14:00 local, after same-time
    {
      created_at: '2026-03-09T17:00:00.000Z',
      total_cost: 4,
      status: 500,
      error_code: 'upstream_error',
      input_tokens: 10,
      output_tokens: 4,
      cache_read_tokens: 6,
      cache_creation_tokens: 2,
      cache_creation_5m_tokens: 2,
    },
    {
      created_at: '2026-03-10T03:59:30.000Z',
      total_cost: 8,
      session_id: 's-live',
      outbound_session_id: 'out-live',
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_tokens: 3,
      cache_creation_1h_tokens: 3,
    },
  ])
  const view = new UsageLogsView(db)
  const sh = view.overview({ tz: 'Asia/Shanghai', now })
  assert.equal(sh.todayRequests, 2)
  assert.equal(sh.todayCost, 12)
  assert.equal(sh.todayErrors, 1)
  assert.equal(sh.todayInputTokens, 11)
  assert.equal(sh.todayOutputTokens, 5)
  assert.equal(sh.todayCacheReadTokens, 6)
  assert.equal(sh.todayCacheCreationTokens, 5)
  assert.equal(sh.todayCacheCreation5mTokens, 2)
  assert.equal(sh.todayCacheCreation1hTokens, 3)
  assert.equal(sh.todayTokens, 27)
  assert.equal(sh.todayCacheHitRate, 6 / 22)
  assert.equal(sh.yesterdayRequests, 1)
  assert.equal(sh.yesterdayCost, 1)
  assert.equal(sh.rpm, 1)
  assert.equal(sh.activeSessions, 1)
  // Unknown zone falls back to UTC: today starts 2026-03-10T00:00Z.
  const utc = view.overview({ tz: 'Not/AZone', now })
  assert.equal(utc.todayRequests, 1)
  assert.equal(utc.yesterdayRequests, 1)
})

test('active sessions and session suggestions group by outbound session, owner-scoped, newest first', () => {
  const db = freshDb()
  const now = Date.now()
  const iso = (ago) => new Date(now - ago).toISOString()
  // One client session that the gateway rebuilt into two upstream sessions (abc-1 / abc-1b).
  seed(db, [
    {
      created_at: iso(60_000),
      session_id: 'client-1',
      outbound_session_id: 'abc-1',
      api_key_id: 'k1',
      status: 500,
      error_code: 'upstream_error',
    },
    {
      created_at: iso(30_000),
      session_id: 'client-1',
      outbound_session_id: 'abc-1',
      api_key_id: 'k1',
      status: 200,
      input_tokens: 10,
    },
    { created_at: iso(25_000), session_id: 'client-1', outbound_session_id: 'abc-1b', api_key_id: 'k1' },
    { created_at: iso(20_000), session_id: 'client-2', outbound_session_id: 'abc-2', api_key_id: 'k2' },
    { created_at: iso(10 * 60_000), session_id: 'client-3', outbound_session_id: 'abc-3', api_key_id: 'k1' },
    { created_at: iso(5_000), session_id: 'client-legacy', api_key_id: 'k1' },
  ])
  const view = new UsageLogsView(db)
  const active = view.activeSessions({ owner_user_id: 'u1', now })
  assert.equal(active.total, 2)
  assert.deepEqual(
    active.sessions.map((s) => [s.sessionId, s.clientSessionId, s.requests]),
    [
      ['abc-1b', 'client-1', 1],
      ['abc-1', 'client-1', 2],
    ],
  )
  assert.equal(active.sessions[1].lastStatus, 200)
  assert.equal(active.sessions[1].keyName, 'alice-key')
  assert.equal(view.activeSessions({ now }).total, 3)
  assert.deepEqual(view.sessionSuggestions({ q: 'abc', owner_user_id: 'u1' }), ['abc-1b', 'abc-1', 'abc-3'])
  assert.deepEqual(view.sessionSuggestions({ q: 'abc-2' }), ['abc-2'])
  assert.deepEqual(view.sessionSuggestions({ q: 'client' }), [])
  assert.equal(view.overview({ now }).activeSessions, 3)
})

test('active sessions never resolve the last row from another tenant sharing the session id', () => {
  const db = freshDb()
  const now = Date.now()
  const at = new Date(now - 30_000).toISOString()
  // Same client-chosen session id and completion instant; bob's row sorts later by id.
  seed(db, [
    {
      created_at: at,
      session_id: 'shared',
      outbound_session_id: 'shared',
      api_key_id: 'k1',
      vm_id: 'vm-a',
      status: 200,
    },
    {
      created_at: at,
      session_id: 'shared',
      outbound_session_id: 'shared',
      api_key_id: 'k2',
      vm_id: 'vm-b',
      status: 500,
      error_code: 'upstream_error',
    },
  ])
  const [s] = new UsageLogsView(db).activeSessions({ owner_user_id: 'u1', now }).sessions
  assert.equal(s.keyName, 'alice-key')
  assert.equal(s.vmId, 'vm-a')
  assert.equal(s.lastStatus, 200)
})

test('tenant error collection hides other users and anonymous ingress failures', () => {
  const db = freshDb()
  seed(db, [
    {
      user_id: 'u2',
      api_key_id: 'k2',
      vm_id: null,
      ip: '198.51.100.7',
      status: 403,
      error_code: 'distill_blocked',
      error_message: '不允许蒸馏: secret prompt',
    },
    { vm_id: null, ip: '203.0.113.9', status: 401, error_code: 'invalid_api_key', api_key_presented: 'sk-bad' },
    { user_id: 'u1', api_key_id: 'k1', status: 500, error_code: 'upstream_error', error_message: 'boom' },
  ])
  const repo = new UsageLogsRepo(db)
  const mine = repo.windowStats({ owner_user_id: 'u1' }).error_collection
  assert.deepEqual(
    mine.recent.map((r) => r.error_code),
    ['upstream_error'],
  )
  assert.deepEqual(mine.ingress_hits, [])
  const all = repo.windowStats().error_collection
  assert.equal(all.recent.length, 3)
  assert.deepEqual(all.ingress_hits.map((h) => h.ip).sort(), ['198.51.100.7', '203.0.113.9'])
})
