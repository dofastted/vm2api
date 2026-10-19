import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { codexBodyToAnthropicMessage } from '../../src/lib/protocol/codex-convert.mjs'
import { estimateWindow } from '../../src/lib/admin/window-estimate.mjs'

let seq = 0

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ulrepo-'))
  const db = createDatabase({ dbPath: path.join(dir, 'logs.db') })
  db.exec(`
    INSERT INTO users (id, email, username, password_hash) VALUES ('u1', 'a@x', 'alice', 'x'), ('u2', 'b@x', 'bob', 'x');
    INSERT INTO api_keys (id, name, key, user_id) VALUES ('k1', 'alice-key', 'sk-1', 'u1'), ('k2', 'bob-key', 'sk-2', 'u2');
    INSERT INTO vms (id, name, vm_json) VALUES ('vm-a', 'Slot A', '{}');
  `)
  return { dir, db, repo: new UsageLogsRepo(db) }
}

function storedDebugBytes(db) {
  return db
    .prepare('SELECT record_json FROM request_log_debug')
    .all()
    .reduce((sum, row) => sum + Buffer.byteLength(row.record_json, 'utf8'), 0)
}

function seed(repo, rows) {
  for (const r of rows) {
    seq++
    repo.insertSummary({
      id: `log_${seq}`,
      request_id: `req-${seq}`,
      created_at: new Date().toISOString(),
      log_mode: 'normal',
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      model: 'claude-sonnet-4',
      ...r,
    })
  }
}

function assertHit(stats, prompt, read, label) {
  assert.equal(Number(stats.prompt_tokens), prompt, `${label} prompt_tokens`)
  assert.equal(Number(stats.cache_read_tokens), read, `${label} cache_read_tokens`)
  assert.equal(stats.cache_hit_rate, prompt > 0 ? read / prompt : null, `${label} cache_hit_rate`)
}

test('debugBytes counts stored JSON bytes for empty, ASCII, and UTF-8 records', () => {
  const { dir, db, repo } = freshDb()
  try {
    assert.equal(storedDebugBytes(db), 0)
    assert.equal(repo.debugBytes(), 0)

    const records = [{ body: 'ascii' }, { body: '中🙂' }, { body: 'line\nquote"' }]
    records.forEach((record, i) => {
      repo.insertDebug(`debug-${i}`, `2026-10-15T21:00:0${i}.000Z`, record)
    })

    const expected = records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8'), 0)
    assert.equal(storedDebugBytes(db), expected)
    assert.equal(repo.debugBytes(), expected)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('trimDebugToMaxBytes removes oldest UTF-8 records until actual bytes fit', () => {
  const { dir, db, repo } = freshDb()
  try {
    const record = { body: '中'.repeat(10) }
    const serialized = JSON.stringify(record)
    const maxBytes = 164
    for (let i = 0; i < 5; i++) {
      repo.insertDebug(`debug-${i}`, `2026-10-15T21:00:0${i}.000Z`, record)
    }

    const before = db.prepare('SELECT record_json FROM request_log_debug').all()
    const characterCount = before.reduce((sum, row) => sum + row.record_json.length, 0)
    assert.equal(characterCount, serialized.length * 5)
    assert.ok(characterCount < maxBytes)
    assert.ok(storedDebugBytes(db) > maxBytes)

    const originalIds = db
      .prepare('SELECT request_id FROM request_log_debug ORDER BY ts ASC')
      .all()
      .map((row) => row.request_id)
    const deleted = repo.trimDebugToMaxBytes(maxBytes)
    assert.ok(deleted > 0 && deleted < originalIds.length)
    const remaining = db.prepare('SELECT request_id FROM request_log_debug ORDER BY ts ASC').all()
    const remainingIds = remaining.map((row) => row.request_id)
    assert.equal(remainingIds.length, originalIds.length - deleted)
    assert.deepEqual(remainingIds, originalIds.slice(deleted))
    assert.equal(remainingIds.at(-1), originalIds.at(-1))
    assert.ok(storedDebugBytes(db) <= maxBytes)
    assert.equal(repo.debugBytes(), storedDebugBytes(db))
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('mixed Claude/Codex usage keeps a row-wise prompt denominator on totals and windows', () => {
  const { db, repo } = freshDb()
  try {
    seed(repo, [
      {
        user_id: 'u1',
        api_key_id: 'k1',
        vm_id: 'vm-a',
        account_id: 'acc-1',
        input_tokens: 5,
        cache_read_tokens: 95,
      },
      {
        user_id: 'u1',
        api_key_id: 'k1',
        vm_id: 'vm-a',
        account_id: 'acc-1',
        via: 'codex-kernel',
        model: 'gpt-5.4',
        input_tokens: 5,
        cache_read_tokens: 95,
      },
      {
        user_id: 'u2',
        api_key_id: 'k2',
        input_tokens: 50,
        cache_read_tokens: 50,
      },
    ])
    assertHit(repo.totals(), 300, 240, 'totals')
    assertHit(repo.billingStats().total, 300, 240, 'billing.total')
    const since = new Date(Date.now() - 60_000).toISOString()
    assertHit(repo.windowStats({ since }), 300, 240, 'window')
    assertHit(repo.windowStats({ since, owner_user_id: 'u1' }), 200, 190, 'owner window')
    assertHit(repo.windowStats({ since, owner_user_id: 'u2' }), 100, 50, 'other owner')
  } finally {
    db.close()
  }
})

test('empty usage windows keep a null cache hit rate', () => {
  const { db, repo } = freshDb()
  try {
    assertHit(repo.totals(), 0, 0, 'empty totals')
    assertHit(repo.billingStats().total, 0, 0, 'empty billing')
    const empty = repo.windowStats({ since: '2099-01-01T00:00:00.000Z' })
    assert.equal(empty.requests, 0)
    assertHit(empty, 0, 0, 'empty window')
  } finally {
    db.close()
  }
})

test('billingStats reuses identical panel snapshots but separates account windows', () => {
  const { db, repo } = freshDb()
  try {
    let computes = 0
    const compute = repo._computeBillingStats.bind(repo)
    repo._computeBillingStats = (opts) => {
      computes++
      return compute(opts)
    }

    const winA = [{ account_id: 'acc-1', vm_id: 'vm-a', reset_5h: '2026-10-19T05:00:00.000Z' }]
    const winAReordered = [{ vm_id: 'vm-a', reset_5h: '2026-10-19T05:00:00.000Z', account_id: 'acc-1' }]
    const winB = [{ account_id: 'acc-1', vm_id: 'vm-a', reset_5h: '2026-10-19T06:00:00.000Z' }]

    assert.equal(repo.billingStats({ accountWindows: winA }), repo.billingStats({ accountWindows: winAReordered }))
    assert.equal(computes, 1)
    repo.billingStats({ accountWindows: winB })
    assert.equal(computes, 2)

    // Explicit historical snapshots are deterministic test/report calls and must
    // not be served from the live panel cache.
    repo.billingStats({ accountWindows: winA, now: Date.parse('2026-10-19T00:00:00.000Z') })
    repo.billingStats({ accountWindows: winA, now: Date.parse('2026-10-19T00:00:00.000Z') })
    assert.equal(computes, 4)
  } finally {
    db.close()
  }
})

test('billingStats rate-limits maintenance backfill independently of cache keys', () => {
  const { db, repo } = freshDb()
  try {
    let backfills = 0
    repo.backfillMissingCosts = () => {
      backfills++
      return 0
    }
    repo.billingStats()
    repo.billingStats({ accountWindows: [{ account_id: 'acc-1', vm_id: 'vm-a' }] })
    repo.billingStats({ accountWindows: [{ account_id: 'acc-2', vm_id: 'vm-a' }] })
    assert.equal(backfills, 1)
  } finally {
    db.close()
  }
})

test('aligned account windows re-sum per-row prompt tokens instead of mixed Anthropic formula', () => {
  const { db, repo } = freshDb()
  try {
    const now = Date.parse('2026-09-26T12:00:00.000Z')
    seed(repo, [
      {
        created_at: '2026-09-26T10:00:00.000Z',
        vm_id: 'vm-a',
        account_id: 'acc-1',
        input_tokens: 5,
        cache_read_tokens: 0,
        cache_creation_tokens: 10_000,
      },
      {
        created_at: '2026-09-26T11:30:00.000Z',
        vm_id: 'vm-a',
        account_id: 'acc-1',
        input_tokens: 5,
        cache_read_tokens: 95,
      },
      {
        created_at: '2026-09-26T11:45:00.000Z',
        vm_id: 'vm-a',
        account_id: 'acc-1',
        via: 'codex-kernel',
        model: 'gpt-5.4',
        input_tokens: 5,
        cache_read_tokens: 95,
      },
    ])
    const aligned = repo.billingStats({
      now,
      accountWindows: [{ account_id: 'acc-1', vm_id: 'vm-a', reset_5h: '2026-09-26T16:00:00.000Z' }],
    })
    assertHit(aligned.window_5h, 200, 190, 'aligned 5h')
    assert.equal(Number(aligned.accounts[0].window_5h.prompt_tokens), 200)
    assert.equal(Number(aligned.accounts[0].window_5h.cache_read_tokens), 190)
    const rolling = repo.billingStats({ now })
    assertHit(rolling.window_5h, 10_205, 190, 'rolling 5h')
  } finally {
    db.close()
  }
})

test('converted non-streaming Anthropic API usage stays disjoint in UsageLogsRepo totals', () => {
  const { db, repo } = freshDb()
  try {
    const upstream = {
      model: 'gpt-5.4',
      output: [],
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 80, cache_write_tokens: 0 },
      },
    }
    const message = codexBodyToAnthropicMessage(upstream)
    seed(repo, [
      {
        user_id: 'u1',
        via: 'api-kernel',
        protocol: 'anthropic.messages',
        stream: false,
        model: 'claude-sonnet-4',
        upstream_model: upstream.model,
        pricing_model: 'unpriced',
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_read_tokens: message.usage.cache_read_input_tokens,
        cache_creation_tokens: message.usage.cache_creation_input_tokens,
      },
      {
        user_id: 'u1',
        via: 'codex-kernel',
        model: 'gpt-5.4',
        input_tokens: 20,
        cache_read_tokens: 80,
      },
    ])
    assert.equal(message.usage.input_tokens, 20)
    assert.equal(message.usage.cache_read_input_tokens, 80)
    assertHit(repo.totals(), 200, 160, 'converted+codex totals')
  } finally {
    db.close()
  }
})

test('billingStats window tokens are total including cache', () => {
  const { db, repo } = freshDb()
  try {
    const now = Date.parse('2026-09-26T12:00:00.000Z')
    seed(repo, [
      {
        created_at: '2026-09-26T11:00:00.000Z',
        vm_id: 'vm-a',
        account_id: 'acc-1',
        input_tokens: 20,
        output_tokens: 2,
        cache_read_tokens: 80,
      },
    ])
    const bill = repo.billingStats({ now })
    assert.equal(bill.accounts[0].window_5h_tokens, 102)
    const window = repo.windowStats({ since: '2026-09-26T00:00:00.000Z', until: '2026-09-26T12:00:00.000Z' })
    assert.equal(window.input_tokens + window.output_tokens + window.cache_read_tokens, 102)
  } finally {
    db.close()
  }
})

test('log coverage follows recorded prunes, not the oldest row or the current retention', () => {
  const { db, repo } = freshDb()
  try {
    const now = Date.now()
    const iso = (msAgo) => new Date(now - msAgo).toISOString()
    db.prepare("UPDATE schema_migrations SET applied_at = ? WHERE version = '001'").run(iso(30 * 86400_000))
    seed(repo, [
      { created_at: iso(3 * 86400_000), vm_id: 'vm-a', account_id: 'acc-1', input_tokens: 1 },
      { created_at: iso(3600_000), vm_id: 'vm-a', account_id: 'acc-1', input_tokens: 1 },
    ])
    // Never pruned: a quiet stretch before the oldest row is still complete history.
    assert.equal(repo.billingStats().log_coverage_start, iso(30 * 86400_000))

    assert.equal(repo.cleanup({ retainDays: 1 }).usage_logs, 1)
    const afterPrune = Date.parse(repo.logCoverageStart())
    assert.ok(afterPrune >= now - 86400_000 && afterPrune <= Date.now() - 86400_000 + 1000)

    // Raising retention later does not bring the deleted day back.
    assert.equal(repo.cleanup({ retainDays: 7 }).usage_logs, 0)
    assert.equal(Date.parse(repo.logCoverageStart()), afterPrune)
    const week = estimateWindow({
      spentUsd: 5,
      usedRatio: 0.5,
      reset: iso(-86400_000),
      windowStart: iso(6 * 86400_000),
      coveredSince: repo.logCoverageStart(),
    })
    assert.equal(week.status, 'log_gap')
  } finally {
    db.close()
  }
})

test('window_fable only counts fable rows since reset_7d_oi', () => {
  const { db, repo } = freshDb()
  try {
    const now = Date.parse('2026-09-26T12:00:00.000Z')
    seed(repo, [
      {
        created_at: '2026-09-20T11:00:00.000Z',
        vm_id: 'vm-a',
        account_id: 'acc-1',
        model: 'claude-fable-5-1',
        upstream_model: 'claude-fable-5-1',
        pricing_model: 'claude-fable-5-1',
        input_tokens: 10,
        output_tokens: 1,
        total_cost: 9,
      },
      {
        created_at: '2026-09-25T11:00:00.000Z',
        vm_id: 'vm-a',
        account_id: 'acc-1',
        model: 'claude-fable-5-1',
        upstream_model: 'claude-fable-5-1',
        pricing_model: 'claude-fable-5-1',
        input_tokens: 20,
        output_tokens: 2,
        total_cost: 3,
      },
      {
        created_at: '2026-09-25T11:30:00.000Z',
        vm_id: 'vm-a',
        account_id: 'acc-1',
        model: 'claude-sonnet-5',
        pricing_model: 'claude-sonnet-5',
        input_tokens: 50,
        total_cost: 8,
      },
    ])
    const bill = repo.billingStats({
      now,
      accountWindows: [
        {
          account_id: 'acc-1',
          vm_id: 'vm-a',
          reset_7d_oi: '2026-10-01T12:00:00.000Z',
        },
      ],
    })
    const fable = bill.accounts[0].window_fable
    assert.ok(fable)
    assert.equal(fable.requests, 1)
    assert.equal(fable.cost, 3)
    assert.equal(fable.tokens, 22)
    assert.equal(bill.accounts[0].window_fable, fable)
    const none = repo.billingStats({
      now,
      accountWindows: [{ account_id: 'acc-1', vm_id: 'vm-a' }],
    })
    assert.equal(none.accounts[0].window_fable, null)
  } finally {
    db.close()
  }
})

test('unpricedModels lists unpriced rows', () => {
  const { db, repo } = freshDb()
  try {
    seed(repo, [
      { model: 'mystery', pricing_model: 'unpriced', input_tokens: 10 },
      { model: 'mystery', pricing_model: 'unpriced', input_tokens: 4 },
      { model: 'claude-sonnet-5', pricing_model: 'sonnet-5', input_tokens: 8 },
    ])
    const rows = repo.unpricedModels()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].model, 'mystery')
    assert.equal(rows[0].requests, 2)
  } finally {
    db.close()
  }
})
