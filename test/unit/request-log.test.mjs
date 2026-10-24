import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  RequestLogStore,
  resolveLogMode,
  summarizeBody,
  newRequestId,
  normalizeLoggingConfig,
  logsToCsv,
  logsToJsonl,
} from '../../src/lib/admin/request-log.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { gateVerdict } from '../../src/lib/protocol/intercept-stats.mjs'

function tmpStore(mode = 'normal') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-rlog-'))
  return new RequestLogStore({ dataDir: dir, mode })
}

test('resolveLogMode: env + header overrides', () => {
  assert.equal(resolveLogMode('normal', { headers: {} }), 'normal')
  assert.equal(resolveLogMode('normal', { headers: { 'x-kin-debug': '1' } }), 'debug')
  assert.equal(resolveLogMode('debug', { headers: { 'x-kin-log': 'off' } }), 'off')
  assert.equal(resolveLogMode('off', { headers: { 'x-kin-log': 'normal' } }), 'normal')
})

test('newRequestId keeps incoming X-Request-ID', () => {
  assert.equal(newRequestId({ headers: { 'x-request-id': 'rid-1' } }), 'rid-1')
  assert.match(newRequestId({ headers: {} }), /^[0-9a-f-]{36}$/i)
})

test('summarizeBody counts messages and tools', () => {
  const s = summarizeBody({
    model: 'claude-haiku-4-5-20251001',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ],
    tools: [{ name: 'Read' }],
    system: 'x'.repeat(10),
  })
  assert.equal(s.messages_count, 2)
  assert.equal(s.tools_count, 1)
  assert.equal(s.system_len, 10)
})

test('normal mode writes jsonl without body', () => {
  const store = tmpStore('normal')
  const ctx = store.start(
    { method: 'POST', headers: { 'user-agent': 't' }, socket: {} },
    { protocol: 'anthropic.messages', pathName: '/v1/messages' },
  )
  assert.equal(ctx.mode, 'normal')
  const sum = store.finish(ctx, {
    status: 200,
    model: 'claude-haiku-4-5-20251001',
    stream: false,
    inbound_body: { messages: [{ role: 'user', content: 'secret sk-ant-oat01-ABCDEFGH12345678' }] },
    api_key_kind: 'managed',
    api_key_id: 'key_1',
  })
  assert.equal(sum.status, 200)
  assert.equal(sum.api_key_id, 'key_1')
  assert.equal(sum.inbound_body, undefined)
  const listed = store.listNormal({ limit: 5 })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].request_id, ctx.request_id)
  // no debug file
  assert.equal(store.listDebug({ limit: 5 }).length, 0)
})

test('summary persists protocol usage detail (cache/model/ttft/stop_reason)', () => {
  const store = tmpStore('normal')
  const ctx = store.start(
    { method: 'POST', headers: {}, socket: {} },
    { protocol: 'anthropic.messages', pathName: '/v1/messages' },
  )
  const sum = store.finish(ctx, {
    status: 200,
    model: 'sonnet',
    requested_model: 'sonnet',
    upstream_model: 'claude-sonnet-5',
    first_token_ms: 42,
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 7,
      cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 3 },
    },
  })
  assert.equal(sum.cache_read_tokens, 3)
  assert.equal(sum.cache_creation_tokens, 7)
  assert.equal(sum.cache_creation_5m_tokens, 4)
  assert.equal(sum.cache_creation_1h_tokens, 3)
  assert.equal(sum.requested_model, 'sonnet')
  assert.equal(sum.upstream_model, 'claude-sonnet-5')
  assert.equal(sum.model_mismatch, 1)
  assert.equal(sum.first_token_ms, 42)
  assert.equal(sum.stop_reason, 'end_turn')
  // Sonnet 5 official: $2/$10/cache 5m $2.50/1h $4/read $0.20 per MTok
  assert.equal(sum.pricing_model, 'claude-sonnet-5')
  assert.ok(Math.abs(sum.total_cost - 0.0000926) < 1e-12)
  const row = store.queryNormal({ limit: 1 }).items[0]
  assert.equal(row.cache_creation_5m_tokens, 4)
  assert.equal(row.upstream_model, 'claude-sonnet-5')
  assert.equal(row.stop_reason, 'end_turn')
  assert.equal(row.total_cost, 0.0000926)
})

test('backfillMissingCosts restores actual cost with the stored group multiplier', () => {
  const store = tmpStore('normal')
  const insert = store.db.prepare(`
    INSERT INTO usage_logs (
      id, request_id, created_at, model, upstream_model, status,
      input_tokens, output_tokens, rate_multiplier
    ) VALUES (?, ?, ?, 'claude-opus-5', 'claude-opus-5', 200, 1000000, 0, ?)
  `)
  const now = new Date().toISOString()
  insert.run('log_old_bill_default', 'rid_old_bill_default', now, null)
  insert.run('log_old_bill_free', 'rid_old_bill_free', now, 0)
  insert.run('log_old_bill_double', 'rid_old_bill_double', now, 2)

  assert.equal(store.repo.backfillMissingCosts(), 3)
  const rows = store.db
    .prepare(
      "SELECT id, total_cost, actual_cost, pricing_model FROM usage_logs WHERE id LIKE 'log_old_bill_%' ORDER BY id",
    )
    .all()
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      { id: 'log_old_bill_default', total_cost: 5, actual_cost: 5, pricing_model: 'claude-opus-5' },
      { id: 'log_old_bill_double', total_cost: 5, actual_cost: 10, pricing_model: 'claude-opus-5' },
      { id: 'log_old_bill_free', total_cost: 5, actual_cost: 0, pricing_model: 'claude-opus-5' },
    ],
  )
  assert.equal(store.repo.backfillMissingCosts(), 0)
})

function finishWith(store, model, usage) {
  const ctx = store.start({ method: 'POST', headers: {}, socket: {} }, { protocol: 'x', pathName: '/v1' })
  return store.finish(ctx, { status: 200, model, upstream_model: model, vm_id: 'vm-t', account_id: 'acc-t', usage })
}

test('tier-unpriced rows stay unpriced after backfill', () => {
  const store = tmpStore('normal')
  // gpt-5.5 publishes no >272K fast column; gpt-5.3-codex has no flex band.
  const a = finishWith(store, 'gpt-5.5', { input_tokens: 1_000_000, output_tokens: 0, service_tier: 'priority' })
  const b = finishWith(store, 'gpt-5.3-codex', { input_tokens: 1000, output_tokens: 0, service_tier: 'flex' })
  assert.equal(a.total_cost, null)
  assert.equal(a.pricing_model, 'unpriced')
  assert.equal(a.service_tier, 'priority')
  assert.equal(b.pricing_model, 'unpriced')
  store.repo.billingStats()
  const rows = store.db.prepare('SELECT total_cost, actual_cost, pricing_model FROM usage_logs ORDER BY id').all()
  for (const r of rows) {
    assert.equal(r.total_cost, null)
    assert.equal(r.actual_cost, null)
    assert.equal(r.pricing_model, 'unpriced')
  }
})

test('backfill reprices with the stored service tier and speed', () => {
  const store = tmpStore('normal')
  const insert = store.db.prepare(`
    INSERT INTO usage_logs (id, request_id, created_at, model, upstream_model, status,
      input_tokens, output_tokens, service_tier, speed)
    VALUES (?, ?, ?, ?, ?, 200, ?, 0, ?, ?)
  `)
  const now = new Date().toISOString()
  // 100K stays under the 272K long-context threshold → plain flex band ($2.5/MTok input).
  insert.run('log_bf_flex', 'rid_bf_flex', now, 'gpt-5.5', 'gpt-5.5', 100_000, 'flex', null)
  insert.run('log_bf_fast', 'rid_bf_fast', now, 'claude-opus-4-8', 'claude-opus-4-8', 1_000_000, null, 'fast')
  insert.run('log_bf_weird', 'rid_bf_weird', now, 'gpt-5.5', 'gpt-5.5', 1000, 'weird', null)
  store.repo.backfillMissingCosts()
  const got = Object.fromEntries(
    store.db
      .prepare("SELECT id, total_cost, pricing_model FROM usage_logs WHERE id LIKE 'log_bf_%'")
      .all()
      .map((r) => [r.id, [r.total_cost, r.pricing_model]]),
  )
  assert.deepEqual(got.log_bf_flex, [0.25, 'gpt-5.5'])
  assert.deepEqual(got.log_bf_fast, [10, 'claude-opus-4-8'])
  assert.deepEqual(got.log_bf_weird, [null, 'unpriced'])
  assert.equal(store.repo.backfillMissingCosts(), 0)
})

test('costByModel splits rows by billing band', () => {
  const store = tmpStore('normal')
  finishWith(store, 'claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 0, speed: 'fast' })
  finishWith(store, 'claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 0 })
  const rows = store.repo.costByModel({ vmId: 'vm-t' })
  assert.equal(rows.length, 2)
  const fast = rows.find((r) => r.speed === 'fast')
  const std = rows.find((r) => r.speed !== 'fast')
  assert.equal(fast.total_cost, 10)
  assert.equal(fast.requests, 1)
  assert.equal(std.total_cost, 5)
  assert.equal(std.long_context, 0)
})

test('vmUsageStats buckets by Shanghai day, isolates the slot and ranks models and paths', () => {
  const store = tmpStore('normal')
  const insert = store.db.prepare(`
    INSERT INTO usage_logs (id, request_id, created_at, path, model, upstream_model, status,
      vm_id, input_tokens, output_tokens, total_cost, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100, 50, ?, ?)
  `)
  const shanghaiDay = (offsetDays) =>
    new Date(Date.now() + 8 * 3600_000 - offsetDays * 86400_000).toISOString().slice(0, 10)
  // 16:30Z is 00:30 the next Shanghai day: a UTC bucket would file it under the wrong date.
  const at = (offsetDays) => `${shanghaiDay(offsetDays + 1)}T16:30:00.000Z`
  insert.run('u1', 'r1', at(0), '/v1/messages', 'm-a', 'm-a', 200, 'vm-x', 1, 1000)
  insert.run('u2', 'r2', at(0), '/v1/messages', 'm-a', 'm-a', 200, 'vm-x', 1, 3000)
  insert.run('u3', 'r3', at(2), '/v1/chat/completions', 'm-b', 'm-b', 200, 'vm-x', 4, null)
  insert.run('u4', 'r4', at(0), '/v1/messages', 'm-a', 'm-a', 200, 'vm-other', 99, 1)
  insert.run('u5', 'r5', at(40), '/v1/messages', 'm-a', 'm-a', 200, 'vm-x', 99, 1)
  const out = store.repo.vmUsageStats({ vmId: 'vm-x', days: 30 })
  assert.deepEqual(
    out.history.map((h) => [h.day, h.requests, h.total_cost]),
    [
      [shanghaiDay(2), 1, 4],
      [shanghaiDay(0), 2, 2],
    ],
  )
  const today = out.history.at(-1)
  // rows without a duration must not drag the average toward zero
  assert.equal(today.duration_ms_sum / today.duration_n, 2000)
  assert.equal(out.history[0].duration_n, 0)
  assert.deepEqual(
    out.models.map((m) => [m.name, m.requests]),
    [
      ['m-a', 2],
      ['m-b', 1],
    ],
  )
  assert.deepEqual(
    out.endpoints.map((e) => e.name),
    ['/v1/messages', '/v1/chat/completions'],
  )
  assert.equal(out.endpoints[0].tokens, 300)
  assert.deepEqual(store.repo.vmUsageStats({ vmId: null }).history, [])
})

test('keyUsageStats counts only that key and ranks VMs', () => {
  const store = tmpStore('normal')
  const insert = store.db.prepare(`
    INSERT INTO usage_logs (id, request_id, created_at, path, model, upstream_model, status,
      vm_id, api_key_id, input_tokens, output_tokens, total_cost, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 100, 50, ?, ?)
  `)
  const now = new Date().toISOString()
  insert.run('k1', 'rk1', now, '/v1/messages', 'm-a', 'm-a', 200, 'vm-a', 'key_a', 1, 10)
  insert.run('k2', 'rk2', now, '/v1/messages', 'm-b', 'm-b', 200, 'vm-b', 'key_a', 3, 20)
  insert.run('k3', 'rk3', now, '/v1/messages', 'm-a', 'm-a', 200, 'vm-a', 'key_b', 99, 1)
  const out = store.repo.keyUsageStats({ apiKeyId: 'key_a', days: 30 })
  assert.equal(
    out.history.reduce((n, row) => n + row.requests, 0),
    2,
  )
  assert.equal(
    out.history.reduce((n, row) => n + row.total_cost, 0),
    4,
  )
  assert.deepEqual(
    out.vms.map((row) => [row.name, row.requests]),
    [
      ['vm-b', 1],
      ['vm-a', 1],
    ],
  )
  assert.equal(out.endpoints, undefined)
  assert.deepEqual(store.repo.keyUsageStats({ apiKeyId: null }).history, [])
})

test('zero group multiplier keeps usage and key counters but charges no USD', () => {
  const store = tmpStore('normal')
  const groups = new GroupsRepo(store.db)
  groups.update(1, { rate_multiplier: 0 })
  const rateMultiplier = groups.rateMultiplier(1)
  assert.equal(groups.getById(1).rate_multiplier, 0)
  assert.equal(rateMultiplier, 0)

  const ctx = store.start(
    { method: 'POST', headers: {}, socket: {} },
    { protocol: 'anthropic.messages', pathName: '/v1/messages' },
  )
  const summary = store.finish(ctx, {
    status: 200,
    model: 'claude-opus-5',
    upstream_model: 'claude-opus-5',
    rate_multiplier: rateMultiplier,
    usage: { input_tokens: 1_000_000, output_tokens: 0 },
  })
  assert.equal(summary.total_cost, 5)
  assert.equal(summary.actual_cost, 0)

  const keys = new ApiKeyStore({ db: store.db, hashSecret: 'group-zero-test' })
  const key = keys.create({ name: 'free-group', quota: 100 })
  keys.recordUsage(
    key.id,
    { input_tokens: 1_000_000 },
    {
      model: 'claude-opus-5',
      rateMultiplier,
    },
  )
  const stored = keys.getById(key.id)
  assert.equal(stored.requests, 1)
  assert.equal(stored.tokens_in, 1_000_000)
  assert.equal(stored.quota_used, 0)
  assert.equal(stored.usage_5h, 0)
})

test('billingStats Extra window excludes older logs outside reset-5h', () => {
  const store = tmpStore('normal')
  const now = Date.parse('2026-09-26T12:00:00.000Z')
  const ctxOld = store.start(
    { method: 'POST', headers: {}, socket: {} },
    { protocol: 'anthropic.messages', pathName: '/v1/messages' },
  )
  store.finish(ctxOld, {
    status: 200,
    model: 'claude-opus-5',
    upstream_model: 'claude-opus-5',
    vm_id: 'vm-01',
    account_id: 'acc-1',
    usage: { input_tokens: 1_000_000, output_tokens: 0 },
  })
  store.repo.db.prepare('UPDATE usage_logs SET created_at = ? WHERE vm_id = ?').run('2026-09-26T08:00:00.000Z', 'vm-01')
  const ctxNew = store.start(
    { method: 'POST', headers: {}, socket: {} },
    { protocol: 'anthropic.messages', pathName: '/v1/messages' },
  )
  store.finish(ctxNew, {
    status: 200,
    model: 'claude-opus-5',
    upstream_model: 'claude-opus-5',
    vm_id: 'vm-01',
    account_id: 'acc-1',
    usage: { input_tokens: 200_000, output_tokens: 0 },
  })
  store.repo.db
    .prepare(
      "UPDATE usage_logs SET created_at = '2026-09-26T11:30:00.000Z' WHERE created_at > '2026-09-26T10:00:00.000Z'",
    )
    .run()
  const reset5h = '2026-09-26T16:00:00.000Z'
  const bill = store.billingStats({
    now,
    accountWindows: [{ account_id: 'acc-1', vm_id: 'vm-01', reset_5h: reset5h }],
  })
  assert.equal(bill.accounts[0].window_5h_requests, 1)
  assert.ok(bill.accounts[0].window_5h_cost < 2)
  assert.equal(bill.accounts[0].window_5h_cost, bill.window_5h.total_cost)
  const rolling = store.billingStats({ now })
  assert.equal(rolling.accounts[0].window_5h_requests, 2)
})

test('billingStats aggregates official cost per account and today', () => {
  const store = tmpStore('normal')
  const ctx = store.start(
    { method: 'POST', headers: {}, socket: {} },
    { protocol: 'anthropic.messages', pathName: '/v1/messages' },
  )
  store.finish(ctx, {
    status: 200,
    model: 'claude-opus-5',
    upstream_model: 'claude-opus-5',
    vm_id: 'vm-01',
    account_id: 'acc-1',
    usage: { input_tokens: 1_000_000, output_tokens: 0 },
  })
  const bill = store.billingStats()
  assert.equal(bill.currency, 'USD')
  assert.equal(bill.total.total_cost, 5)
  assert.equal(bill.today.total_cost, 5)
  assert.equal(bill.accounts[0].account_id, 'acc-1')
  assert.equal(bill.accounts[0].total_cost, 5)
  assert.equal(bill.accounts[0].window_5h_cost, 5)
  assert.ok(bill.window_5h)
  assert.equal(bill.window_5h.total_cost, 5)
  assert.equal(bill.accounts[0].today.total_cost, 5)
  assert.equal(bill.accounts[0].today.input_tokens, 1_000_000)
  assert.equal(bill.accounts[0].window_5h.requests, 1)
  assert.equal(bill.accounts[0].window_7d_cost, 5)
  assert.equal(bill.accounts[0].window_7d_success, 1)
  assert.equal(bill.accounts[0].window_7d_errors, 0)
  assert.ok(bill.window_7d)
  const models = store.costByModel({ vmId: 'vm-01' })
  assert.equal(models.length, 1)
  assert.equal(models[0].model, 'claude-opus-5')
  assert.equal(models[0].total_cost, 5)
  assert.equal(models[0].input_tokens, 1_000_000)
})

test('finish writes OpenAI Responses cache read and cache write', () => {
  const store = tmpStore('normal')
  const ctx = store.start(
    { method: 'POST', headers: {}, socket: {} },
    { protocol: 'openai.responses', pathName: '/v1/responses' },
  )
  const sum = store.finish(ctx, {
    status: 200,
    protocol: 'openai.responses',
    model: 'gpt-5.6-sol',
    upstream_model: 'gpt-5.6-sol',
    usage: {
      input_tokens: 100,
      output_tokens: 4,
      input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
    },
  })
  assert.equal(sum.input_tokens, 10)
  assert.equal(sum.cache_read_tokens, 80)
  assert.equal(sum.cache_creation_tokens, 10)
})

test('finish prices OpenAI usage with top-level cached_tokens', () => {
  const store = tmpStore('normal')
  const ctx = store.start(
    { method: 'POST', headers: {}, socket: {} },
    { protocol: 'openai.chat', pathName: '/v1/chat/completions' },
  )
  const sum = store.finish(ctx, {
    status: 200,
    protocol: 'openai.chat',
    model: 'gpt-5.5',
    upstream_model: 'gpt-5.5',
    usage: { input_tokens: 1_000_000, output_tokens: 0, cached_tokens: 200_000 },
  })
  assert.equal(sum.input_tokens, 800_000)
  assert.equal(sum.cache_read_tokens, 200_000)
})

test('finish prices OpenAI-shaped usage from third-party clients', () => {
  const store = tmpStore('normal')
  const ctx = store.start(
    { method: 'POST', headers: { 'user-agent': 'OpenAI/Python 1.70.0' }, socket: {} },
    { protocol: 'openai.chat', pathName: '/v1/chat/completions' },
  )
  const sum = store.finish(ctx, {
    status: 200,
    protocol: 'openai.chat',
    model: 'claude-sonnet-5',
    upstream_model: 'claude-sonnet-5',
    usage: {
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 1_000_000 },
    },
  })
  assert.equal(sum.input_tokens, 0)
  assert.equal(sum.cache_read_tokens, 1_000_000)
})

test('cache breakdown without a split bills 5m unless cache_ttl is explicitly 1h', () => {
  const store = tmpStore('normal')
  const five = store.finish(
    store.start(
      { method: 'POST', headers: {}, socket: {} },
      { protocol: 'anthropic.messages', pathName: '/v1/messages' },
    ),
    {
      status: 200,
      model: 'claude-sonnet-5',
      upstream_model: 'claude-sonnet-5',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 9 },
    },
  )
  assert.equal(five.cache_creation_5m_tokens, 9)
  assert.equal(five.cache_creation_1h_tokens, 0)
  assert.equal(five.model_mismatch, 0)
  const hour = store.finish(
    store.start(
      { method: 'POST', headers: {}, socket: {} },
      { protocol: 'anthropic.messages', pathName: '/v1/messages' },
    ),
    {
      status: 200,
      model: 'claude-sonnet-5',
      upstream_model: 'claude-sonnet-5',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 9, cache_ttl: '1h' },
    },
  )
  assert.equal(hour.cache_creation_5m_tokens, 0)
  assert.equal(hour.cache_creation_1h_tokens, 9)
})

test('cache breakdown puts the total beyond a partial split into the fallback TTL (#678)', () => {
  const store = tmpStore('normal')
  const sum = store.finish(
    store.start(
      { method: 'POST', headers: {}, socket: {} },
      { protocol: 'anthropic.messages', pathName: '/v1/messages' },
    ),
    {
      status: 200,
      model: 'claude-opus-5-5',
      upstream_model: 'claude-opus-5-5',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 14890,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 119 },
      },
    },
  )
  assert.equal(sum.cache_creation_5m_tokens, 14771)
  assert.equal(sum.cache_creation_1h_tokens, 119)
})

test('finish persists web_search_requests from server_tool_use', () => {
  const store = tmpStore('normal')
  const sum = store.finish(
    store.start(
      { method: 'POST', headers: {}, socket: {} },
      { protocol: 'anthropic.messages', pathName: '/v1/messages' },
    ),
    {
      status: 200,
      model: 'claude-sonnet-5',
      upstream_model: 'claude-sonnet-5',
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        server_tool_use: { web_search_requests: 3 },
      },
    },
  )
  assert.equal(sum.web_search_requests, 3)
  const row = store.db.prepare('SELECT web_search_requests FROM usage_logs WHERE id = ?').get(sum.id)
  assert.equal(row.web_search_requests, 3)
})

test('repriceRange rewrites total_cost and fills unpriced rows while actual_cost stays put', () => {
  const store = tmpStore('normal')
  const now = new Date().toISOString()
  store.db
    .prepare(`
    INSERT INTO usage_logs (
      id, request_id, created_at, model, upstream_model, status,
      input_tokens, output_tokens, total_cost, actual_cost, pricing_model, rate_multiplier
    ) VALUES
      ('log_rp_old', 'rid_rp_old', ?, 'claude-opus-5', 'claude-opus-5', 200, 1000000, 0, 1, 9, 'opus-5', 1),
      ('log_rp_null', 'rid_rp_null', ?, 'claude-opus-5', 'claude-opus-5', 200, 1000000, 0, NULL, 4, NULL, 2)
  `)
    .run(now, now)
  const out = store.repo.repriceRange({ since: now, until: now })
  assert.equal(out.rows, 2)
  assert.ok(out.changed >= 1)
  const rows = Object.fromEntries(
    store.db
      .prepare("SELECT id, total_cost, actual_cost, pricing_model FROM usage_logs WHERE id LIKE 'log_rp_%'")
      .all()
      .map((r) => [r.id, r]),
  )
  assert.equal(rows.log_rp_old.actual_cost, 9)
  assert.notEqual(rows.log_rp_old.total_cost, 1)
  assert.equal(rows.log_rp_null.actual_cost, 4)
  assert.equal(rows.log_rp_null.pricing_model, 'claude-opus-5')
  assert.equal(rows.log_rp_null.total_cost, 5)
})

test('finish records washed Responses path over inbound chat path', () => {
  const store = tmpStore('normal')
  const ctx = store.start(
    { method: 'POST', headers: {}, socket: {} },
    { protocol: 'openai.chat', pathName: '/v1/chat/completions' },
  )
  const sum = store.finish(ctx, {
    status: 200,
    protocol: 'openai.responses',
    path: '/v1/responses',
    model: 'gpt-5.6-sol',
  })
  assert.equal(sum.path, '/v1/responses')
  assert.equal(sum.protocol, 'openai.responses')
})

test('debug mode stores full redacted body', () => {
  const store = tmpStore('normal')
  const req = { method: 'POST', headers: { 'x-kin-debug': '1', authorization: 'Bearer sk-kin-abc' }, socket: {} }
  const ctx = store.start(req, { protocol: 'openai.chat', pathName: '/v1/chat/completions' })
  assert.equal(ctx.mode, 'debug')
  store.finish(ctx, {
    status: 200,
    model: 'm',
    inbound_body: { model: 'm', messages: [{ role: 'user', content: 'hi sk-ant-oat01-ABCDEFGH12345678' }] },
    hop_meta: { params: { dropped: ['max_tokens'] } },
  })
  const dbg = store.listDebug({ limit: 5 })
  assert.equal(dbg.length, 1)
  assert.equal(dbg[0].request_id, ctx.request_id)
  assert.ok(dbg[0].headers.authorization === '***REDACTED***')
  const bodyStr = JSON.stringify(dbg[0].inbound_body)
  assert.match(bodyStr, /REDACTED/)
  assert.doesNotMatch(bodyStr, /ABCDEFGH12345678/)
  assert.deepEqual(dbg[0].hop_meta.params.dropped, ['max_tokens'])
})

test('debug records retain final header provenance and a separate redacted worker envelope', () => {
  const store = tmpStore('debug')
  const ctx = store.start({ method: 'POST', headers: {}, socket: {} }, { protocol: 'anthropic.messages' })
  store.finish(ctx, {
    status: 200,
    outbound_headers_source: 'cli_final',
    outbound_headers: { accept: 'application/json, text/event-stream', authorization: 'Bearer final-secret' },
    worker_envelope_headers: { 'x-app': 'cli', authorization: 'Bearer envelope-secret' },
  })
  const [record] = store.listDebug({ limit: 1 })
  assert.equal(record.outbound_headers_source, 'cli_final')
  assert.equal(record.outbound_headers.accept, 'application/json, text/event-stream')
  assert.equal(record.outbound_headers.authorization, '***REDACTED***')
  assert.deepEqual(record.worker_envelope_headers, { 'x-app': 'cli', authorization: '***REDACTED***' })
})

test('outbound bodies are stored only when the operator configured debug, not via caller headers', () => {
  const outbound = { body: { system: 'gateway persona overlay' }, headers: { 'x-app': 'cli' } }
  const record = (store, headers) => {
    const ctx = store.start({ method: 'POST', headers, socket: {} }, { pathName: '/v1/messages' })
    store.finish(ctx, {
      status: 200,
      inbound_body: { model: 'm' },
      outbound_body: outbound.body,
      outbound_headers: outbound.headers,
      outbound_headers_source: 'cli_final',
      worker_envelope_headers: outbound.headers,
    })
    return store.getDebug(ctx.request_id)
  }
  for (const headers of [{ 'x-kin-debug': '1' }, { 'x-kin-log': 'debug' }]) {
    const forced = record(tmpStore('normal'), headers)
    assert.deepEqual(forced.inbound_body, { model: 'm' })
    assert.equal(forced.outbound_body, null)
    assert.equal(forced.outbound_headers, null)
    assert.equal(forced.outbound_headers_source, null)
    assert.equal(forced.worker_envelope_headers, null)
  }
  const operator = record(tmpStore('debug'), {})
  assert.deepEqual(operator.outbound_body, outbound.body)
  assert.deepEqual(operator.outbound_headers, outbound.headers)
})

test('off mode writes nothing', () => {
  const store = tmpStore('off')
  const ctx = store.start({ method: 'POST', headers: {}, socket: {} }, { pathName: '/v1/messages' })
  assert.equal(ctx.mode, 'off')
  assert.equal(store.finish(ctx, { status: 200 }), null)
  assert.equal(store.listNormal({ limit: 5 }).length, 0)
})

test('classifier debug diagnostics omit system and transcript bodies', () => {
  const store = tmpStore('debug')
  const ctx = store.start(
    { method: 'POST', headers: {}, socket: {} },
    { protocol: 'anthropic.messages', pathName: '/v1/messages' },
  )
  const body = {
    model: 'claude-sonnet-4-6',
    system: 'sensitive policy',
    messages: [{ role: 'user', content: 'sensitive transcript' }],
  }
  const classifier = {
    purpose: 'auto_mode_classifier',
    format: 'xml',
    layer: 'node_object',
    wire_observed: false,
    before: { max_tokens: 64 },
  }
  store.finish(ctx, { status: 200, classifier, inbound_body: body, outbound_body: body })
  const [debug] = store.listDebug({ limit: 1 })
  assert.deepEqual(debug.classifier, classifier)
  assert.equal(debug.request_body_snapshot, null)
  assert.equal(debug.inbound_body, null)
  assert.equal(debug.outbound_body, null)
  assert.equal(JSON.stringify(debug).includes('sensitive transcript'), false)
})

function logOne(store, extra = {}) {
  const ctx = store.start({ method: 'POST', headers: {}, socket: {} }, { pathName: extra.path || '/v1/messages' })
  return store.finish(ctx, { status: 200, ...extra })
}

test('summaries persist in sqlite across store re-open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-rlog-'))
  const s1 = new RequestLogStore({ dataDir: dir, mode: 'normal' })
  logOne(s1, { model: 'claude-haiku-4-5', api_key_id: 'key_p' })

  const s2 = new RequestLogStore({ dataDir: dir, mode: 'normal' })
  const listed = s2.listNormal({ limit: 10 })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].api_key_id, 'key_p')
  assert.equal(s2.snapshot().total_rows, 1)
})

test('gate stats count every inbound request and keep the stored verdict', () => {
  const store = tmpStore()
  // Plain successes: error_code and final_state stay NULL.
  logOne(store, { intercept: gateVerdict({ kind: 'pass', by: 'jev' }) })
  logOne(store, { intercept: gateVerdict({ kind: 'pass', by: 'regex' }) })
  logOne(store, { path: '/v1/responses', intercept: gateVerdict({ kind: 'pass', by: 'regex' }) })
  logOne(store, { status: 401, error_code: 'invalid_api_key' })
  logOne(store, {
    status: 403,
    via: 'distill-detect',
    final_state: 'distill_blocked',
    error_code: 'distill_blocked',
    intercept: gateVerdict({ kind: 'block', by: 'distill', keyword: 'Memory-stage-one extractor' }),
  })
  logOne(store, {
    status: 503,
    via: 'refusal-guard',
    final_state: 'refusal_device',
    error_code: 'refusal_guard',
    intercept: gateVerdict({ kind: 'block', by: 'refusal', keyword: 'device' }),
  })

  const stats = store.protocolEntryStats({ since: '1970-01-01T00:00:00.000Z' })
  assert.equal(stats.total, 6)
  assert.equal(stats.blocked, 2)
  assert.equal(stats.passed, 4)
  const passBy = Object.fromEntries(stats.passes.map((row) => [row.by, row.count]))
  assert.deepEqual(passBy, { jev: 1, regex: 2, unknown: 1 })
  const blockBy = Object.fromEntries(stats.blocks.map((row) => [`${row.by}:${row.keyword}`, row.count]))
  assert.deepEqual(blockBy, { 'distill:Memory-stage-one extractor': 1, 'refusal:device': 1 })
})

test('queryNormal filters + pagination + total', () => {
  const store = tmpStore('normal')
  logOne(store, { api_key_id: 'key_a', model: 'm1', input_tokens: 10, output_tokens: 5 })
  logOne(store, { api_key_id: 'key_a', model: 'm2', status: 500, error_code: 'upstream_error' })
  logOne(store, { api_key_id: 'key_b', model: 'm1', vm_id: 'vm-9' })

  assert.equal(store.queryNormal({ api_key_id: 'key_a' }).total, 2)
  assert.equal(store.queryNormal({ vm_id: 'vm-9' }).total, 1)
  assert.equal(store.queryNormal({ model: 'm1' }).total, 2)
  assert.equal(store.queryNormal({ status: 'error' }).total, 1)
  assert.equal(store.queryNormal({ status: 'ok' }).total, 2)
  assert.equal(store.queryNormal({ status: 'error', include_muted: true }).total, 1)
  assert.equal(store.queryNormal({ q: 'upstream' }).total, 1)
  const page = store.queryNormal({ limit: 2, offset: 2 })
  assert.equal(page.total, 3)
  assert.equal(page.items.length, 1)
})

test('windowStats computes ttft percentiles, sla and qps', () => {
  const store = tmpStore('normal')
  logOne(store, {
    status: 200,
    first_token_ms: 100,
    duration_ms: 200,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 80,
    cache_creation_tokens: 10,
    model: 'claude-sonnet-5',
  })
  logOne(store, {
    status: 200,
    first_token_ms: 300,
    duration_ms: 400,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    model: 'claude-sonnet-5',
  })
  logOne(store, { status: 503, error_code: 'overloaded', duration_ms: 50, model: 'claude-fable-5' })
  const w = store.windowStats({ since: new Date(Date.now() - 60_000).toISOString() })
  assert.equal(w.cache_read_tokens, 80)
  assert.equal(w.prompt_tokens, 110)
  assert.ok(Math.abs(w.cache_hit_rate - 80 / 110) < 1e-9)
  assert.equal(w.sticky.selections, 0)
  assert.equal(w.requests, 3)
  assert.equal(w.success, 2)
  assert.equal(w.errors, 1)
  assert.equal(w.status_503, 1)
  assert.equal(w.ttft.samples, 2)
  assert.equal(w.ttft.p50_ms, 100)
  assert.equal(w.ttft.max_ms, 300)
  assert.ok(Math.abs(w.sla - 2 / 3) < 1e-9)
  assert.ok(w.qps.avg > 0)
  assert.equal(w.by_model.length, 2)
  assert.equal(w.error_collection.total, 1)
  assert.equal(w.error_collection.by_class[0].id, 'overloaded')
  const filtered = store.queryNormal({ error_class: 'overloaded' })
  assert.equal(filtered.total, 1)
  assert.equal(filtered.items[0].error_label, '过载排队')
})

test('windowStats treats 429 quota/rate-limit as SLA success', () => {
  const store = tmpStore('normal')
  logOne(store, { status: 200, first_token_ms: 80, duration_ms: 100, model: 'claude-sonnet-5' })
  logOne(store, {
    status: 429,
    error_code: 'upstream_rate_limit',
    error_message: '5h extra usage',
    model: 'claude-opus-5',
  })
  const w = store.windowStats({ since: new Date(Date.now() - 60_000).toISOString() })
  assert.equal(w.requests, 2)
  assert.equal(w.success, 2)
  assert.equal(w.errors, 0)
  assert.equal(w.status_429, 1)
  assert.equal(w.sla, 1)
  assert.equal(w.error_collection.total, 1)
  assert.equal(w.error_collection.by_class[0].id, 'rate_limit')
})

test('windowStats treats ingress auth failures as SLA success like sub2api', () => {
  const store = tmpStore('normal')
  logOne(store, { status: 200, first_token_ms: 80, duration_ms: 100, model: 'claude-sonnet-5' })
  logOne(store, {
    status: 401,
    error_code: 'auth_failed',
    error_message: 'missing or invalid credentials',
    model: 'claude-sonnet-5',
  })
  logOne(store, {
    status: 401,
    error_code: 'invalid_api_key',
    error_message: 'Invalid credentials',
    model: 'claude-opus-5',
  })
  const w = store.windowStats({ since: new Date(Date.now() - 60_000).toISOString() })
  assert.equal(w.requests, 3)
  assert.equal(w.success, 3)
  assert.equal(w.errors, 0)
  assert.equal(w.sla, 1)
  assert.equal(w.error_collection.total, 2)
  assert.equal(w.error_collection.by_class[0].id, 'auth')
  assert.equal(w.error_collection.by_class[0].owner, 'client')
})

test('windowStats ignores client abort like sub2api ignore_context_canceled', () => {
  const store = tmpStore('normal')
  logOne(store, { status: 200, first_token_ms: 80, duration_ms: 100, model: 'claude-sonnet-5' })
  logOne(store, { status: 200, error_code: 'client_cancelled', error_message: 'ECONNRESET', model: 'claude-sonnet-5' })
  const w = store.windowStats({ since: new Date(Date.now() - 60_000).toISOString() })
  assert.equal(w.requests, 2)
  assert.equal(w.success, 2)
  assert.equal(w.errors, 0)
  assert.equal(w.error_collection.total, 0)
  assert.equal(store.queryNormal({ status: 'error' }).total, 0)
})

test('aggregate buckets by day with token sums', () => {
  const store = tmpStore('normal')
  logOne(store, { input_tokens: 10, output_tokens: 5 })
  logOne(store, { input_tokens: 20, output_tokens: 15, status: 500, error_code: 'x' })
  const rows = store.aggregate({ bucket: 'day' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].requests, 2)
  assert.equal(rows[0].errors, 1)
  assert.equal(rows[0].input_tokens, 30)
  assert.equal(rows[0].output_tokens, 20)
  const totals = store.totals()
  assert.equal(totals.requests, 2)
  assert.equal(totals.input_tokens, 30)
})

test('cleanup removes rows older than retainDays', () => {
  const store = tmpStore('normal')
  // one fresh row
  logOne(store, {})
  // one stale row injected directly
  store.repo.insertSummary({
    id: 'log_old',
    request_id: 'rid-old',
    ts: new Date(Date.now() - 30 * 86400_000).toISOString(),
  })
  store.repo.insertDebug('rid-old', new Date(Date.now() - 30 * 86400_000).toISOString(), { old: true })
  assert.equal(store.repo.count(), 2)
  store.cleanup()
  assert.equal(store.repo.count(), 1)
  assert.equal(store.getDebug('rid-old'), null)
})

test('jsonl mirror writes legacy format when enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-rlog-'))
  const store = new RequestLogStore({ dataDir: dir, mode: 'normal', jsonlMirror: true })
  logOne(store, { model: 'mm' })
  const day = new Date().toISOString().slice(0, 10)
  const file = path.join(dir, 'request-logs', `${day}.jsonl`)
  assert.ok(fs.existsSync(file))
  const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim())
  assert.equal(rec.model, 'mm')
})

test('sanitizeRequestBodySnapshot redacts secrets and summarizes tools', async () => {
  const { sanitizeRequestBodySnapshot } = await import('../../src/lib/admin/request-log.mjs')
  const snap = sanitizeRequestBodySnapshot({
    model: 'claude-haiku-4-5-20251001',
    authorization: 'Bearer secret',
    tools: [{ name: 'Read', type: 'custom' }, { function: { name: 'write' } }],
    messages: [{ role: 'user', content: 'x'.repeat(200) }],
  })
  assert.equal(snap.authorization, '[REDACTED]')
  assert.equal(snap.tools[0].name, 'Read')
  assert.ok(String(snap.messages[0].content).includes('…'))
})

test('sanitizeRequestBodySnapshot omits image bytes', async () => {
  const { sanitizeRequestBodySnapshot } = await import('../../src/lib/admin/request-log.mjs')
  const payload = 'iVBORw0KGgo'.repeat(20)
  const snap = sanitizeRequestBodySnapshot({
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload } }],
      },
    ],
  })
  assert.equal(snap.messages[0].content[0].source.data, undefined)
  assert.equal(snap.messages[0].content[0].source.bytes, payload.length)
  assert.equal(JSON.stringify(snap).includes(payload), false)
})

test('setConfig hot-updates mode', () => {
  const s = tmpStore('normal')
  s.setConfig({ mode: 'debug', retainDays: 3 })
  const snap = s.snapshot()
  assert.equal(snap.mode, 'debug')
  assert.equal(snap.retain_days, 3)
  assert.equal(snap.debug_retain_days, 3)
  assert.equal(snap.max_mb, 2048)
  assert.deepEqual(snap.muted_error_classes, ['auth'])
  s.setConfig({ mutedErrorClasses: [] })
  assert.deepEqual(s.snapshot().muted_error_classes, [])
})

test('cleanup keeps 7-day summaries and drops 3-day-old debug', () => {
  const store = tmpStore('normal')
  store.setConfig({ retainDays: 7, debugRetainDays: 3, maxMb: 0 })
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400_000).toISOString()
  store.repo.insertSummary({
    id: 'log_mid',
    request_id: 'rid-mid',
    ts: fiveDaysAgo,
  })
  store.repo.insertDebug('rid-mid', fiveDaysAgo, { old: true })
  store.cleanup()
  assert.equal(store.repo.count(), 1)
  assert.equal(store.repo.getDebug('rid-mid'), null)
})

test('cleanup trims oldest debug rows when over max_mb', () => {
  const store = tmpStore('debug')
  store.setConfig({ retainDays: 7, debugRetainDays: 7, maxMb: 1 })
  const blob = 'x'.repeat(400_000)
  for (let i = 0; i < 4; i++) {
    store.repo.insertDebug(`rid-${i}`, new Date(Date.now() - (4 - i) * 1000).toISOString(), { blob })
  }
  assert.ok(store.repo.debugBytes() > 1024 * 1024)
  store.cleanup()
  assert.ok(store.repo.debugBytes() <= 1024 * 1024)
  assert.equal(store.getDebug('rid-0'), null)
  assert.ok(store.getDebug('rid-3'))
})

test('normalizeLoggingConfig defaults debug retain to 3 and caps at retain_days', () => {
  const a = normalizeLoggingConfig({})
  assert.equal(a.retain_days, 7)
  assert.equal(a.debug_retain_days, 3)
  assert.equal(a.max_mb, 2048)
  const b = normalizeLoggingConfig({ retain_days: 1, debug_retain_days: 7, max_mb: 512 })
  assert.equal(b.retain_days, 1)
  assert.equal(b.debug_retain_days, 1)
  assert.equal(b.max_mb, 512)
})

test('ingress 401 stores presented key + ip and can be excluded from the list', () => {
  const store = tmpStore('normal')
  const ctx = store.start(
    {
      method: 'POST',
      headers: { 'user-agent': 'scanner', authorization: 'Bearer sk-bad-key-plain' },
      socket: { remoteAddress: '203.0.113.9' },
    },
    { protocol: 'anthropic.messages', pathName: '/v1/messages' },
  )
  store.finish(ctx, {
    status: 401,
    error_code: 'invalid_api_key',
    error_message: 'Invalid credentials',
    api_key_presented: 'sk-bad-key-plain',
  })
  assert.equal(store.queryNormal({ status: 'error' }).total, 0)
  const listed = store.queryNormal({ status: 'error', include_muted: true })
  assert.equal(listed.total, 1)
  assert.equal(listed.items[0].api_key_presented, 'sk-bad-key-plain')
  assert.equal(listed.items[0].ip, '203.0.113.9')
  assert.equal(listed.items[0].error_class, 'auth')
  assert.equal(store.queryNormal({ status: 'error', error_class: 'auth' }).total, 1)
  assert.equal(store.queryNormal({ status: 'error', exclude_error_class: 'auth' }).total, 0)
  const hits = store.windowStats().error_collection.ingress_hits
  assert.equal(hits.length, 1)
  assert.equal(hits[0].api_key_presented, 'sk-bad-key-plain')
  assert.equal(hits[0].ip, '203.0.113.9')
  assert.equal(hits[0].count, 1)
})

test('exportRows + csv/jsonl keep presented key and ip', () => {
  const store = tmpStore('normal')
  const ctx = store.start(
    {
      method: 'POST',
      headers: { authorization: 'Bearer sk-export-plain' },
      socket: { remoteAddress: '198.51.100.4' },
    },
    { pathName: '/v1/messages' },
  )
  store.finish(ctx, {
    status: 401,
    error_code: 'invalid_api_key',
    error_message: 'Invalid credentials',
    api_key_presented: 'sk-export-plain',
  })
  const { items, total } = store.exportRows({ status: 'error', include_muted: true, limit: 100 })
  assert.equal(total, 1)
  assert.equal(items[0].ip, '198.51.100.4')
  const csv = logsToCsv(items)
  assert.match(csv, /api_key_presented/)
  assert.match(csv, /sk-export-plain/)
  assert.match(csv, /198\.51\.100\.4/)
  const jsonl = logsToJsonl(items)
  assert.match(jsonl, /sk-export-plain/)
})

test('finish persists caller and outbound sessions (capped) and only known reasoning efforts', () => {
  const store = tmpStore('normal')
  const write = (extra) => {
    const ctx = store.start({ method: 'POST', headers: {}, socket: {} }, { pathName: '/v1/messages' })
    store.finish(ctx, { status: 200, ...extra })
    return store.repo.getByRequestId(ctx.request_id)
  }
  const kept = write({
    session_id: `  ${'s'.repeat(250)}  `,
    outbound_session_id: '11111111-2222-4333-8444-555555555555',
    reasoning_effort: 'xhigh',
  })
  assert.equal(kept.session_id, 's'.repeat(200))
  assert.equal(kept.outbound_session_id, '11111111-2222-4333-8444-555555555555')
  assert.equal(kept.reasoning_effort, 'xhigh')
  const dropped = write({ session_id: '   ', outbound_session_id: '', reasoning_effort: 'turbo' })
  assert.equal(dropped.session_id, null)
  assert.equal(dropped.outbound_session_id, null)
  assert.equal(dropped.reasoning_effort, null)
})

/** Minimal ServerResponse double: write/end/finish/getHeaders like node:http. */
function fakeRes() {
  const listeners = []
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v
    },
    getHeaders() {
      return { ...this.headers }
    },
    write() {
      return true
    },
    end() {
      for (const fn of listeners.splice(0)) fn()
    },
    once(event, fn) {
      if (event === 'finish') listeners.push(fn)
    },
  }
  return res
}

test('debug mode records the exact client response; normal mode leaves res untouched', () => {
  const store = new RequestLogStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kin-rlog-')),
    mode: 'debug',
    maxDebugBodyChars: 64,
  })
  const ctx = store.start({ method: 'POST', headers: {}, socket: {} }, { pathName: '/v1/messages' })
  const res = fakeRes()
  store.tapResponse(ctx, res)
  res.setHeader('content-type', 'text/event-stream')
  res.setHeader('set-cookie', 'panel=secret')
  res.write('event: message_start\ndata: {"a":1}\n\n')
  res.write(Buffer.from('data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n'))
  res.end('data: [DONE]\n\n')
  store.finish(ctx, { status: 200 })
  const rec = store.getDebug(ctx.request_id)
  assert.equal(rec.response.status, 200)
  assert.equal(rec.response.headers['content-type'], 'text/event-stream')
  assert.equal(rec.response.headers['set-cookie'], '***REDACTED***')
  assert.equal(rec.response.truncated, true)
  assert.equal(rec.response.body.length, 64)
  assert.ok(rec.response.body.startsWith('event: message_start'))
  assert.ok(rec.response.bytes > 64)

  const normal = tmpStore('normal')
  const nctx = normal.start({ method: 'POST', headers: {}, socket: {} }, { pathName: '/v1/messages' })
  const plain = fakeRes()
  const write = plain.write
  normal.tapResponse(nctx, plain)
  assert.equal(plain.write, write)
  assert.equal(nctx.response, undefined)
})

test('debug response body masks credentials that fit inside the capture window', () => {
  const store = tmpStore('debug')
  const ctx = store.start({ method: 'POST', headers: {}, socket: {} }, { pathName: '/v1/messages' })
  const res = fakeRes()
  store.tapResponse(ctx, res)
  res.end('{"echo":"sk-ant-oat01-ABCDEFGH12345678"}')
  store.finish(ctx, { status: 200 })
  const body = store.getDebug(ctx.request_id).response.body
  assert.doesNotMatch(body, /ABCDEFGH12345678/)
  assert.match(body, /REDACTED/)
})

test('tenant log scope follows the slot owner at write time, not the current owner', () => {
  const store = tmpStore()
  store.db.exec(`
    INSERT INTO users (id, email, username, password_hash) VALUES ('alice', 'a@x', 'alice', 'x'), ('bob', 'b@x', 'bob', 'x');
    INSERT INTO vms (id, name, vm_json) VALUES ('vm-a', 'Slot A', '{}');
  `)
  logOne(store, { user_id: 'bob', vm_id: 'vm-a', error_code: 'upstream_error', status: 500 })
  store.db.exec(`UPDATE vms SET owner_user_id = 'alice', origin = 'admin_assigned' WHERE id = 'vm-a'`)
  const testChat = logOne(store, { api_key_kind: 'master', vm_id: 'vm-a', error_code: 'upstream_error', status: 500 })

  const mine = store.queryNormal({ owner_user_id: 'alice' })
  assert.deepEqual(
    mine.items.map((r) => r.request_id),
    [testChat.request_id],
  )
  assert.deepEqual(
    store.windowStats({ owner_user_id: 'alice' }).error_collection.recent.map((r) => r.request_id),
    [testChat.request_id],
  )
  assert.equal(store.queryNormal({}).total, 2)
})

const IMAGE_GEN_USAGE = {
  input_tokens: 300,
  input_tokens_details: { text_tokens: 100, image_tokens: 200 },
  output_tokens: 1000,
  total_tokens: 1300,
}

test('Responses image tool usage is stored and billed on top of the text model', () => {
  const store = tmpStore('normal')
  const ctx = store.start(
    { method: 'POST', headers: {}, socket: {} },
    { protocol: 'openai.responses', pathName: '/v1/responses' },
  )
  const rec = store.finish(ctx, {
    status: 200,
    protocol: 'openai.responses',
    model: 'gpt-6-luna',
    upstream_model: 'gpt-6-luna',
    usage: { input_tokens: 1000, output_tokens: 100 },
    image_usage: IMAGE_GEN_USAGE,
    image_model: 'gpt-image-2.5-sunburst',
  })
  const row = store.db
    .prepare(
      'SELECT image_model, image_usage, image_input_tokens, image_output_tokens, image_cost, total_cost, actual_cost, pricing_model FROM usage_logs WHERE id = ?',
    )
    .get(rec.id)
  assert.equal(row.image_model, 'gpt-image-2.5-sunburst')
  assert.deepEqual(JSON.parse(row.image_usage), IMAGE_GEN_USAGE)
  assert.equal(row.image_input_tokens, 300)
  assert.equal(row.image_output_tokens, 1000)
  assert.ok(Math.abs(row.image_cost - 0.0321) < 1e-9)
  assert.equal(row.pricing_model, 'gpt-6-luna')
  assert.ok(row.total_cost > row.image_cost)
  assert.equal(row.actual_cost, row.total_cost)
})

test('Images endpoint rows bill only the image usage', () => {
  const store = tmpStore('normal')
  const ctx = store.start(
    { method: 'POST', headers: {}, socket: {} },
    { protocol: 'openai.images', pathName: '/v1/images/generations' },
  )
  const rec = store.finish(ctx, {
    status: 200,
    protocol: 'openai.images',
    model: 'gpt-image-2.5-flare',
    image_model: 'gpt-image-2.5-flare',
    image_usage: IMAGE_GEN_USAGE,
  })
  const row = store.db
    .prepare('SELECT image_cost, total_cost, pricing_model, input_tokens FROM usage_logs WHERE id = ?')
    .get(rec.id)
  assert.equal(row.pricing_model, 'gpt-image-2.5-flare')
  assert.ok(Math.abs(row.total_cost - 0.0321) < 1e-9)
  assert.equal(row.image_cost, row.total_cost)
  assert.equal(row.input_tokens, 0)
  const missing = store.finish(
    store.start(
      { method: 'POST', headers: {}, socket: {} },
      { protocol: 'openai.images', pathName: '/v1/images/generations' },
    ),
    { status: 200, protocol: 'openai.images', model: 'gpt-image-2.5-flare', image_model: 'gpt-image-2.5-flare' },
  )
  assert.equal(missing.pricing_model, 'unpriced')
  assert.equal(missing.total_cost, null)
})

test('repriceRange re-prices image usage from the stored JSON and keeps actual_cost', () => {
  const store = tmpStore('normal')
  const now = new Date().toISOString()
  store.db
    .prepare(`
    INSERT INTO usage_logs (
      id, request_id, created_at, protocol, model, upstream_model, status,
      input_tokens, output_tokens, image_model, image_usage, image_input_tokens, image_output_tokens,
      image_cost, total_cost, actual_cost, pricing_model, rate_multiplier
    ) VALUES
      ('log_img_tool', 'rid_img_tool', ?, 'openai.responses', 'gpt-6-luna', 'gpt-6-luna', 200, 0, 0,
       'gpt-image-2.5-flare', ?, 300, 1000, 1, 1, 7, 'gpt-6-luna', 1),
      ('log_img_only', 'rid_img_only', ?, 'openai.images', 'gpt-image-2.5-sunburst', NULL, 200, 0, 0,
       'gpt-image-2.5-sunburst', ?, 300, 1000, NULL, NULL, 5, NULL, 1)
  `)
    .run(now, JSON.stringify(IMAGE_GEN_USAGE), now, JSON.stringify(IMAGE_GEN_USAGE))
  const out = store.repo.repriceRange({ since: now, until: now })
  assert.equal(out.rows, 2)
  assert.equal(out.still_unpriced, 0)
  const rows = Object.fromEntries(
    store.db
      .prepare(
        "SELECT id, image_cost, total_cost, actual_cost, pricing_model FROM usage_logs WHERE id LIKE 'log_img_%'",
      )
      .all()
      .map((r) => [r.id, r]),
  )
  assert.ok(Math.abs(rows.log_img_tool.image_cost - 0.0321) < 1e-9)
  assert.ok(Math.abs(rows.log_img_tool.total_cost - 0.0321) < 1e-9)
  assert.equal(rows.log_img_tool.actual_cost, 7)
  assert.equal(rows.log_img_only.pricing_model, 'gpt-image-2.5-sunburst')
  assert.ok(Math.abs(rows.log_img_only.total_cost - 0.0321) < 1e-9)
  assert.equal(rows.log_img_only.actual_cost, 5)
})
