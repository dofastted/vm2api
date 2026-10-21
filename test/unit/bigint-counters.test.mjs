import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../../src/lib/db/database.mjs'
import { runLegacyImport } from '../../src/lib/db/legacy-import.mjs'
import { AccountsRepo } from '../../src/lib/db/repos/accounts-repo.mjs'
import { ApiKeysRepo } from '../../src/lib/db/repos/api-keys-repo.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'
import { StatisticsRepo } from '../../src/lib/db/repos/statistics-repo.mjs'

const LARGE = '9007199254740993'
const INPUT_TOTAL = '9007199254740995'
const PROMPT_TOTAL = '9007199254741006'
const TOKEN_TOTAL = '9007199254741011'

async function seedLogs(db) {
  const now = Date.now()
  for (const [id, input, output, read, write] of [
    ['large', LARGE, 4, 5, 6],
    ['small', 2, 1, 0, 0],
  ]) {
    await db
      .prepare(`
      INSERT INTO usage_logs (id, request_id, created_at, model, status, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, vm_id, account_id, api_key_id, outbound_session_id,
        protocol, path, total_cost, actual_cost, pricing_model)
      VALUES ($1,$2,$3,$4,200,$5,$6,$7,$8,'vm-a','account-a','key-a','session-a',
        'anthropic.messages','/v1/messages',1,1,'synthetic-price')
    `)
      .run(id, 'request-' + id, new Date(now - 1).toISOString(), 'model-a', input, output, read, write)
  }
  return now + 1
}

test('legacy JSONL and summary inserts preserve exact bigint token fields', async (t) => {
  const db = getDb()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-bigint-import-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const ts = new Date().toISOString()
  const record = {
    id: 'legacy-large',
    request_id: 'legacy-large',
    ts,
    status: 200,
    input_tokens: LARGE,
    output_tokens: LARGE,
    cache_read_tokens: LARGE,
    cache_creation_tokens: LARGE,
    cache_creation_5m_tokens: LARGE,
    cache_creation_1h_tokens: LARGE,
    web_search_requests: LARGE,
  }
  const logDir = path.join(dir, 'request-logs')
  fs.mkdirSync(logDir)
  fs.writeFileSync(path.join(logDir, ts.slice(0, 10) + '.jsonl'), JSON.stringify(record) + '\n')
  assert.equal((await runLegacyImport({ dataDir: dir, projectRoot: dir, db })).counts.request_logs, 1)
  const logs = new UsageLogsRepo(db)
  const imported = await logs.getByRequestId('legacy-large')
  for (const field of Object.keys(record).filter((key) => key.endsWith('_tokens') || key === 'web_search_requests')) {
    assert.equal(imported[field], LARGE, field)
  }
  await logs.insertSummary({ ...imported, id: 'copied-large', request_id: 'copied-large' })
  assert.equal((await logs.getByRequestId('copied-large')).input_tokens, LARGE)
})

test('bigint counter writers reject an already rounded unsafe Number', async () => {
  const db = getDb()
  const logs = new UsageLogsRepo(db)
  await assert.rejects(
    logs.insertSummary({
      id: 'unsafe',
      request_id: 'unsafe',
      ts: new Date().toISOString(),
      input_tokens: Number(LARGE),
    }),
    RangeError,
  )
  const keys = new ApiKeysRepo(db)
  await keys.insert({ id: 'key-a', key: 'synthetic-key-a', status: 'active' })
  await assert.rejects(keys.recordUsage('key-a', { tokens_in: Number(LARGE) }), RangeError)
  assert.equal((await keys.getById('key-a')).tokens_in, 0)
})

test('API key usage preserves both large stored counters and exact string deltas', async () => {
  const keys = new ApiKeysRepo(getDb())
  await keys.insert({ id: 'key-a', key: 'synthetic-key-a', status: 'active', requests: LARGE, tokens_in: LARGE })
  const smallDelta = await keys.recordUsage('key-a', { tokens_in: 2 })
  assert.equal(smallDelta.requests, '9007199254740994')
  assert.equal(smallDelta.tokens_in, INPUT_TOTAL)
  await keys.insert({ id: 'key-b', key: 'synthetic-key-b', status: 'active' })
  const largeDelta = await keys.recordUsage('key-b', {
    tokens_in: LARGE,
    tokens_out: LARGE,
    cache_read_tokens: LARGE,
    cache_creation_tokens: LARGE,
  })
  for (const field of ['tokens_in', 'tokens_out', 'cache_read_tokens', 'cache_creation_tokens']) {
    assert.equal(largeDelta[field], LARGE, field)
  }
})

test('account updates and allocation history preserve bigint counters', async () => {
  const accounts = new AccountsRepo(getDb())
  await accounts.insert({ account_id: 'account-a', vm_id: 'vm-a', requests: LARGE, tokens_in: LARGE })
  const account = await accounts.get('account-a')
  account.name = 'renamed'
  await accounts.save(account)
  await accounts.addAllocation('account-a', { tokens_in: LARGE })
  assert.equal((await accounts.get('account-a')).tokens_in, LARGE)
  assert.equal((await accounts.get('account-a')).requests, LARGE)
  assert.equal((await accounts.recentAllocations('account-a'))[0].tokens_in, LARGE)
})

test('usage totals and billing windows return exact integer sums', async () => {
  const db = getDb()
  const now = await seedLogs(db)
  const logs = new UsageLogsRepo(db)
  const totals = await logs.totals()
  assert.equal(totals.input_tokens, INPUT_TOTAL)
  assert.equal(totals.prompt_tokens, PROMPT_TOTAL)
  assert.equal(totals.requests, 2)
  assert.equal((await logs.aggregate())[0].input_tokens, INPUT_TOTAL)
  const owner = await logs.ownerBilling()
  assert.equal(owner.totals.tokens_in, PROMPT_TOTAL)
  assert.equal(owner.items[0].tokens_in, PROMPT_TOTAL)
  assert.equal((await logs.costByAccount())[0].input_tokens, INPUT_TOTAL)
  assert.equal((await logs.costByModel())[0].input_tokens, INPUT_TOTAL)
  const rolling = await logs.billingStats({ now })
  assert.equal(rolling.total.input_tokens, INPUT_TOTAL)
  assert.equal(rolling.window_5h.input_tokens, INPUT_TOTAL)
  assert.equal(rolling.accounts[0].window_5h_tokens, TOKEN_TOTAL)
  const aligned = await logs.billingStats({
    now,
    accountWindows: [
      {
        account_id: 'account-a',
        vm_id: 'vm-a',
        reset_5h: new Date(now + 60_000).toISOString(),
        reset_7d: new Date(now + 60_000).toISOString(),
      },
    ],
  })
  assert.equal(aligned.window_5h.input_tokens, INPUT_TOTAL)
  assert.equal(aligned.accounts[0].window_5h_tokens, TOKEN_TOTAL)
  assert.equal((await logs.vmUsageStats({ vmId: 'vm-a' })).history[0].input_tokens, INPUT_TOTAL)
  assert.equal((await logs.keyUsageStats({ apiKeyId: 'key-a' })).models[0].tokens, TOKEN_TOTAL)
  const window = await logs.windowStats()
  assert.equal(window.input_tokens, INPUT_TOTAL)
  assert.equal(window.prompt_tokens, PROMPT_TOTAL)
})

test('SQL and classified usage summaries return the same exact integers', async () => {
  const db = getDb()
  const now = await seedLogs(db)
  for (const mutedErrorClasses of [[], ['distill']]) {
    const view = new UsageLogsView(db, { mutedErrorClasses })
    const summary = await view.summary()
    assert.equal(summary.totalInputTokens, INPUT_TOTAL)
    assert.equal(summary.totalTokens, TOKEN_TOTAL)
    assert.equal(summary.totalRequests, 2)
    assert.equal((await view.activeSessions({ now })).sessions[0].totalTokens, TOKEN_TOTAL)
    assert.equal(
      (await view.exportRows({ include_muted: true })).items.find((row) => row.id === 'large').input_tokens,
      LARGE,
    )
  }
})

test('statistics totals, series, and leaderboards preserve exact integer sums', async () => {
  const db = getDb()
  const now = await seedLogs(db)
  const repo = new StatisticsRepo(db)
  const stats = await repo.statistics({ range: 'today', now })
  assert.equal(stats.totals.inputTokens, INPUT_TOTAL)
  assert.equal(stats.totals.tokens, TOKEN_TOTAL)
  assert.equal(stats.seriesTotals.s0.tokens, TOKEN_TOTAL)
  assert.equal(
    stats.metrics.tokens.flatMap((point) => point.s0).find((value) => value !== 0),
    TOKEN_TOTAL,
  )
  const entry = (await repo.leaderboard({ range: 'today', now })).entries[0]
  assert.equal(entry.inputTokens, INPUT_TOTAL)
  assert.equal(entry.totalTokens, TOKEN_TOTAL)
  assert.equal(entry.totalRequests, 2)
})
