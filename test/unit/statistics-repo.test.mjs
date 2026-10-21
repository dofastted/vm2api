import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, openDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { StatisticsRepo, resolveWindow } from '../../src/lib/db/repos/statistics-repo.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { codexBodyToAnthropicMessage } from '../../src/lib/protocol/codex-convert.mjs'

let seq = 0

async function seedUsers(db) {
  await db.exec(`
    INSERT INTO users (id, email, username, password_hash) VALUES ('u1', 'a@x', 'alice', 'x'), ('u2', 'b@x', 'bob', 'x');
    INSERT INTO api_keys (id, name, key, user_id) VALUES ('k1', 'alice-key', 'sk-1', 'u1'), ('k2', 'bob-key', 'sk-2', 'u2');
    INSERT INTO vms (id, name, vm_json) VALUES ('vm-a', 'Slot A', '{}');
  `)
}

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-stats-'))
  const db = await getDb()
  await db.exec('TRUNCATE users, api_keys, vms, usage_logs, request_attempts')
  await seedUsers(db)
  return db
}

async function seed(db, rows) {
  const repo = new UsageLogsRepo(db)
  for (const r of rows) {
    seq++
    await repo.insertSummary({
      id: `log_${seq}`,
      request_id: `req-${seq}`,
      log_mode: 'normal',
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      model: 'claude-sonnet-4',
      ...r,
    })
  }
}

test('day buckets follow local midnights across a DST change', async () => {
  const tz = 'America/New_York'
  const now = Date.parse('2026-03-09T15:00:00Z') // 11:00 EDT, the day after spring-forward
  const { buckets, resolution } = resolveWindow('7days', tz, now)
  assert.equal(resolution, 'day')
  assert.equal(buckets.length, 7)
  assert.equal(new Date(buckets[0]).toISOString(), '2026-03-03T05:00:00.000Z')
  assert.equal(new Date(buckets[5]).toISOString(), '2026-03-08T05:00:00.000Z')
  assert.equal(new Date(buckets[6]).toISOString(), '2026-03-09T04:00:00.000Z')

  const db = await freshDb()
  await seed(db, [
    { created_at: '2026-03-09T03:30:00.000Z', total_cost: 1 }, // 23:30 EDT on Mar 8
    { created_at: '2026-03-09T04:30:00.000Z', total_cost: 2 }, // 00:30 EDT on Mar 9
  ])
  const data = await new StatisticsRepo(db).statistics({ range: '7days', dimension: 'model', tz, now })
  const cost = data.metrics.cost
  assert.equal(cost[5].date, '2026-03-08T05:00:00.000Z')
  assert.equal(cost[5].s0, 1)
  assert.equal(cost[6].s0, 2)
  assert.equal(data.tz, tz)
  assert.equal(data.since, '2026-03-03T05:00:00.000Z')
})

test('hourly buckets start at local midnight in half-hour zones; bad tz falls back to UTC', async () => {
  const db = await freshDb()
  const now = Date.parse('2026-05-01T00:00:00Z') // 05:30 in Kolkata
  await seed(db, [
    { created_at: '2026-04-30T18:29:59.000Z', total_cost: 100 }, // previous local day
    { created_at: '2026-04-30T19:29:00.000Z', total_cost: 1 }, // 00:59 local
    { created_at: '2026-04-30T19:30:00.000Z', total_cost: 2 }, // 01:00 local
  ])
  const repo = new StatisticsRepo(db)
  const data = await repo.statistics({ range: 'today', dimension: 'model', tz: 'Asia/Kolkata', now })
  assert.equal(data.resolution, 'hour')
  assert.equal(data.metrics.cost.length, 6)
  assert.equal(data.metrics.cost[0].date, '2026-04-30T18:30:00.000Z')
  assert.equal(data.metrics.cost[0].s0, 1)
  assert.equal(data.metrics.cost[1].s0, 2)
  assert.equal(data.totals.cost, 3)
  const utc = await repo.statistics({ range: 'today', tz: 'Mars/Base', now })
  assert.equal(utc.tz, 'UTC')
  assert.equal(utc.since, '2026-05-01T00:00:00.000Z')
})

test('series keep the top 8 by cost, fold the rest into __others__, and name empty values', async () => {
  const db = await freshDb()
  const now = Date.parse('2026-05-01T12:00:00Z')
  const at = '2026-05-01T10:00:00.000Z'
  const rows = []
  for (let i = 1; i <= 10; i++) rows.push({ created_at: at, model: `m${i}`, total_cost: i, input_tokens: 10 })
  rows.push({ created_at: at, model: null, total_cost: 20 })
  await seed(db, rows)
  const data = await new StatisticsRepo(db).statistics({ range: 'today', dimension: 'model', tz: 'UTC', now })
  assert.deepEqual(
    data.series.map((s) => s.id),
    ['__none__', 'm10', 'm9', 'm8', 'm7', 'm6', 'm5', 'm4', '__others__'],
  )
  assert.equal(data.series[0].name, '未知')
  assert.deepEqual(
    data.series.map((s) => s.dataKey),
    ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
  )
  // m1 + m2 + m3 land in others.
  assert.deepEqual(data.seriesTotals.s8, { cost: 6, requests: 3, tokens: 30 })
  const hour10 = data.metrics.requests.find((p) => p.date === at)
  assert.equal(hour10.s8, 3)
  assert.equal(data.metrics.requests[0].s8, 0)
  assert.equal(data.totals.requests, 11)
})

test('deltas compare with the previous equal-length window', async () => {
  const db = await freshDb()
  const now = Date.parse('2026-05-08T12:00:00Z')
  // 7days window = [2026-05-02, now); previous = same span ending 2026-05-02.
  await seed(db, [
    { created_at: '2026-05-05T00:00:00.000Z', total_cost: 3, input_tokens: 30 },
    { created_at: '2026-05-06T00:00:00.000Z', total_cost: 3, input_tokens: 30 },
    { created_at: '2026-04-28T00:00:00.000Z', total_cost: 2, input_tokens: 40 },
  ])
  const data = await new StatisticsRepo(db).statistics({ range: '7days', tz: 'UTC', now })
  assert.equal(data.deltas.requests, 1)
  assert.equal(data.deltas.cost, 2)
  assert.equal(data.deltas.tokens, 0.5)
  const empty = await new StatisticsRepo(db).statistics({ range: 'today', tz: 'UTC', now })
  assert.equal(empty.deltas.requests, null)
})

test('leaderboard sorts by official cost, names entities, and caps the limit', async () => {
  const db = await freshDb()
  const now = Date.parse('2026-05-01T12:00:00Z')
  const at = '2026-05-01T09:00:00.000Z'
  await seed(db, [
    {
      created_at: at,
      user_id: 'u1',
      api_key_id: 'k1',
      total_cost: 1,
      actual_cost: 2,
      input_tokens: 80,
      cache_read_tokens: 20,
    },
    { created_at: at, user_id: 'u1', api_key_id: 'k1', total_cost: 1, status: 500, error_code: 'upstream_error' },
    { created_at: at, user_id: 'u2', api_key_id: 'k2', total_cost: 5, duration_ms: 100 },
    { created_at: at, user_id: null, api_key_id: null, total_cost: 0.5 },
  ])
  const repo = new StatisticsRepo(db)
  const board = await repo.leaderboard({ range: 'today', scope: 'user', tz: 'UTC', now })
  assert.deepEqual(
    board.entries.map((e) => [e.id, e.name]),
    [
      ['u2', 'bob'],
      ['u1', 'alice'],
      ['__none__', '未知'],
    ],
  )
  const alice = board.entries[1]
  assert.equal(alice.totalRequests, 2)
  assert.equal(alice.successRequests, 1)
  assert.equal(alice.errorRequests, 1)
  assert.equal(alice.successRate, 0.5)
  assert.equal(alice.totalActualCost, 2)
  assert.equal(alice.cacheHitRate, 0.2)
  assert.equal(
    (await repo.leaderboard({ range: 'today', scope: 'key', limit: 1, tz: 'UTC', now })).entries[0].name,
    'bob-key',
  )
  assert.equal((await repo.leaderboard({ range: 'today', scope: 'key', limit: 500, tz: 'UTC', now })).entries.length, 3)
})

test('cache hit rate uses disjoint input plus cache buckets for every route', async () => {
  const now = Date.parse('2026-05-01T12:00:00Z')
  const at = '2026-05-01T09:00:00.000Z'
  const disjoint = { input_tokens: 10, cache_read_tokens: 80, cache_creation_tokens: 10 }
  const cases = [
    {
      name: 'Claude writes previously made 80% display as 100.0%',
      row: { input_tokens: 20, cache_read_tokens: 80_000, cache_creation_tokens: 20_000 },
      rate: 80_000 / 100_020,
      display: '80.0',
    },
    { name: 'Codex kernel stores disjoint input', row: { ...disjoint, via: 'codex-kernel' }, rate: 0.8 },
    {
      name: 'Claude through Responses still uses input+read+write',
      row: {
        path: '/v1/responses',
        protocol: 'openai.responses',
        input_tokens: 20,
        cache_read_tokens: 40,
        cache_creation_tokens: 20,
      },
      rate: 0.5,
    },
    { name: 'cache creation without reads', row: { cache_creation_tokens: 100 }, rate: 0 },
    { name: 'missing input counts', row: { input_tokens: null, output_tokens: 50 }, rate: 0 },
  ]
  for (const { name, row, rate, display } of cases) {
    const db = await freshDb()
    try {
      await seed(db, [{ created_at: at, user_id: 'u1', ...row }])
      const repo = new StatisticsRepo(db)
      const totals = (await repo.statistics({ range: 'today', tz: 'UTC', now })).totals
      const entry = (await repo.leaderboard({ range: 'today', scope: 'user', tz: 'UTC', now })).entries[0]
      assert.equal(totals.cacheHitRate, rate, `totals: ${name}`)
      assert.equal(entry.cacheHitRate, rate, `leaderboard: ${name}`)
      if (display) assert.equal((entry.cacheHitRate * 100).toFixed(1), display)
    } finally {
    }
  }
})

test('Codex 100k input / 80k cached / 2k out stores 20k input and totals 102k tokens', async () => {
  const now = Date.parse('2026-05-01T12:00:00Z')
  const at = '2026-05-01T09:00:00.000Z'
  const db = await freshDb()
  try {
    await seed(db, [
      {
        created_at: at,
        user_id: 'u1',
        via: 'codex-kernel',
        model: 'gpt-5.4',
        input_tokens: 20_000,
        output_tokens: 2_000,
        cache_read_tokens: 80_000,
        cache_creation_tokens: 0,
      },
    ])
    const totals = (await new StatisticsRepo(db).statistics({ range: 'today', tz: 'UTC', now })).totals
    assert.equal(totals.inputTokens, 20_000)
    assert.equal(totals.tokens, 102_000)
    assert.notEqual(totals.tokens, 182_000)
  } finally {
  }
})

test('API OpenAI replies converted to non-streaming Anthropic retain disjoint historical cache counts', async () => {
  const now = Date.parse('2026-05-01T12:00:00Z')
  const at = '2026-05-01T09:00:00.000Z'
  for (const cacheWrite of [0, 10]) {
    const db = await freshDb()
    try {
      const upstream = {
        model: 'gpt-5.4',
        output: [],
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 80, cache_write_tokens: cacheWrite },
        },
      }
      const message = codexBodyToAnthropicMessage(upstream)
      // The API backend persists result.body.usage first. For an assembled
      // Anthropic reply it has already subtracted cache reads and writes.
      await seed(db, [
        {
          created_at: at,
          user_id: 'u1',
          api_key_id: 'k1',
          vm_id: 'vm-a',
          model: 'claude-sonnet-4',
          upstream_model: upstream.model,
          pricing_model: 'unpriced',
          via: 'api-kernel',
          protocol: 'anthropic.messages',
          stream: false,
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
          cache_read_tokens: message.usage.cache_read_input_tokens,
          cache_creation_tokens: message.usage.cache_creation_input_tokens,
          total_cost: 0.25,
          actual_cost: 0.2,
        },
      ])
      const stored = await db.prepare('SELECT * FROM usage_logs').all()
      assert.equal(stored[0].input_tokens, 20 - cacheWrite)
      assert.equal(stored[0].cache_read_tokens, 80)
      assert.equal(stored[0].cache_creation_tokens, cacheWrite)
      const repo = new StatisticsRepo(db)
      const options = { range: 'today', tz: 'UTC', now, owner_user_id: 'u1' }
      const totals = (await repo.statistics(options)).totals
      assert.equal(totals.cacheHitRate, 0.8)
      assert.equal(totals.inputTokens, 20 - cacheWrite)
      assert.equal(totals.cost, 0.25)
      for (const scope of ['user', 'key', 'model', 'vm']) {
        const entry = (await repo.leaderboard({ ...options, scope })).entries[0]
        assert.equal(entry.cacheHitRate, 0.8, scope)
        assert.equal((entry.cacheHitRate * 100).toFixed(1), '80.0', scope)
        assert.equal(entry.totalActualCost, 0.2, scope)
      }
      // Statistics fix the denominator without rewriting historical usage or billing.
      assert.deepEqual(await db.prepare('SELECT * FROM usage_logs').all(), stored)
      await seed(db, [
        {
          created_at: at,
          user_id: 'u1',
          via: 'api-kernel',
          protocol: 'anthropic.messages',
          stream: true,
          upstream_model: upstream.model,
          input_tokens: 600,
          cache_read_tokens: 400,
        },
      ])
      assert.equal((await repo.statistics(options)).totals.cacheHitRate, 480 / 1100)
      assert.equal((await repo.leaderboard({ ...options, scope: 'user' })).entries[0].cacheHitRate, 480 / 1100)
    } finally {
    }
  }
})

test('mixed-provider cache rates weight each row by prompt tokens for every scope and owner', async () => {
  const db = await freshDb()
  try {
    const now = Date.parse('2026-05-01T12:00:00Z')
    const at = '2026-05-01T09:00:00.000Z'
    const shared = { created_at: at, user_id: 'u1', api_key_id: 'k1', vm_id: 'vm-a', model: 'shared-alias' }
    await seed(db, [
      { ...shared, upstream_model: 'claude-sonnet-4', cache_read_tokens: 80, cache_creation_tokens: 20 },
      { ...shared, via: 'codex-kernel', input_tokens: 500, cache_read_tokens: 400, cache_creation_tokens: 100 },
      { created_at: at, user_id: 'u2', api_key_id: 'k2', input_tokens: 50, cache_read_tokens: 50 },
      // Outside the current window: must not change its denominator.
      { ...shared, created_at: '2026-04-30T23:59:59.000Z', cache_creation_tokens: 10_000 },
    ])
    const repo = new StatisticsRepo(db)
    const options = { range: 'today', tz: 'UTC', now }
    const expected = 480 / 1100
    for (const scope of ['user', 'key', 'model', 'vm']) {
      const entries = (await repo.leaderboard({ ...options, scope, owner_user_id: 'u1' })).entries
      assert.equal(entries.length, 1, scope)
      assert.equal(entries[0].cacheHitRate, expected, scope)
    }
    const mine = (await repo.statistics({ ...options, owner_user_id: 'u1' })).totals
    assert.equal(mine.cacheHitRate, expected)
    assert.equal(mine.cacheReadTokens, 480)
    assert.equal(mine.cacheCreationTokens, 120)
    // The existing total-token metric is intentionally separate from this fix.
    assert.equal(mine.tokens, 1100)
    assert.equal((await repo.statistics(options)).totals.cacheHitRate, 530 / 1200)
    const empty = (await repo.statistics({ ...options, owner_user_id: 'missing-user' })).totals
    assert.equal(empty.cacheHitRate, 0)
  } finally {
  }
})

test('panel routes owner-scope statistics for users and reject user/vm groupings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-stats-route-'))
  const db = await openDatabase({ dbPath: path.join(dir, 'panel.db') })
  try {
    await db.exec('TRUNCATE users, api_keys, vms, usage_logs, request_attempts')
    await seedUsers(db)
    const at = new Date(Date.now() - 1000).toISOString()
    await seed(db, [
      { created_at: at, user_id: 'u1', api_key_id: 'k1', total_cost: 1 },
      { created_at: at, user_id: 'u2', api_key_id: 'k2', total_cost: 7 },
    ])
    const call = async (role, url) => {
      const response = {}
      const handle = createPanelHandler({
        cfg: { paths: { project: dir } },
        requireAuth(req) {
          req.panelUser = role
          req.panelRole = role
          req.panelUserId = 'u1'
          return true
        },
        json(_res, status, body) {
          response.status = status
          response.body = body
          return true
        },
      })
      await handle({ method: 'GET', url, headers: {} }, {}, new URL(`http://localhost${url}`))
      return response
    }
    assert.equal((await call('user', '/api/panel/statistics?dimension=user')).status, 400)
    assert.equal((await call('user', '/api/panel/statistics/leaderboard?scope=vm')).status, 400)
    assert.equal((await call('admin', '/api/panel/statistics?range=never')).status, 400)

    const mine = await call('user', '/api/panel/statistics/leaderboard?scope=key&range=today&user_id=u2')
    assert.equal(mine.status, 200)
    assert.deepEqual(
      mine.body.data.entries.map((e) => e.id),
      ['k1'],
    )
    const all = await call('admin', '/api/panel/statistics?dimension=user&range=today')
    assert.equal(all.status, 200)
    assert.equal(all.body.data.totals.cost, 8)
  } finally {
    await closeDatabase()
  }
})
