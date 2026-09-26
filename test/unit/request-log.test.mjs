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
  assert.equal(sum.pricing_model, 'sonnet-5')
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
      { id: 'log_old_bill_default', total_cost: 5, actual_cost: 5, pricing_model: 'opus-5' },
      { id: 'log_old_bill_double', total_cost: 5, actual_cost: 10, pricing_model: 'opus-5' },
      { id: 'log_old_bill_free', total_cost: 5, actual_cost: 0, pricing_model: 'opus-5' },
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
  assert.deepEqual(got.log_bf_fast, [10, 'opus-4.5'])
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
  store.repo.db
    .prepare('UPDATE usage_logs SET created_at = ? WHERE vm_id = ?')
    .run('2026-09-26T08:00:00.000Z', 'vm-01')
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
    .prepare("UPDATE usage_logs SET created_at = '2026-09-26T11:30:00.000Z' WHERE created_at > '2026-09-26T10:00:00.000Z'")
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
  assert.equal(sum.input_tokens, 1_000_000)
  assert.equal(sum.cache_read_tokens, 1_000_000)
  assert.equal(sum.total_cost, 2.2)
})

test('cache breakdown falls back to the default 1h bucket', () => {
  const store = tmpStore('normal')
  const ctx = store.start(
    { method: 'POST', headers: {}, socket: {} },
    { protocol: 'anthropic.messages', pathName: '/v1/messages' },
  )
  const sum = store.finish(ctx, {
    status: 200,
    model: 'claude-sonnet-5',
    upstream_model: 'claude-sonnet-5',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 9 },
  })
  assert.equal(sum.cache_creation_5m_tokens, 0)
  assert.equal(sum.cache_creation_1h_tokens, 9)
  assert.equal(sum.model_mismatch, 0)
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

test('off mode writes nothing', () => {
  const store = tmpStore('off')
  const ctx = store.start({ method: 'POST', headers: {}, socket: {} }, { pathName: '/v1/messages' })
  assert.equal(ctx.mode, 'off')
  assert.equal(store.finish(ctx, { status: 200 }), null)
  assert.equal(store.listNormal({ limit: 5 }).length, 0)
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
