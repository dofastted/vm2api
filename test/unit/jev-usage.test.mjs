import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { JevUsageRepo } from '../../src/lib/db/repos/jev-usage-repo.mjs'
import {
  installJevUsageRecorder,
  recordJevUsage,
  normalizeJevUsage,
  jevKeyFingerprint,
  jevUsageStorageErrors,
  shanghaiUsageDay,
  isOfficialTypeSafeUrl,
} from '../../src/lib/protocol/jev-usage.mjs'

const NOW = Date.parse('2026-10-25T02:00:00.000Z')
const value = (extra = {}) => ({
  created_at: new Date(NOW).toISOString(),
  provider: 'jev',
  model: 'jev-latest',
  response_model: 'jev-1.14.0',
  key_fingerprint: jevKeyFingerprint('isolated-synthetic-credential'),
  http_status: 200,
  outcome: 'success',
  duration_ms: 12,
  usage: { input_tokens: 1000, output_tokens: 20 },
  official_typesafe: true,
  ...extra,
})
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-usage-'))
  let db
  t.after(() => {
    db?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db = createDatabase({ dbPath: path.join(dir, 'kin.db') })
  return new JevUsageRepo(db, { now: () => NOW })
}
test('attempt normalization strips all secret and content fields', () => {
  const raw = value({
    api_key: 'NEVER_STORE_THIS',
    state: 'NEVER_STORE_THIS',
    response: 'NEVER_STORE_THIS',
    url: 'NEVER_STORE_THIS',
  })
  const event = normalizeJevUsage(raw)
  assert.ok(!JSON.stringify(event).includes('NEVER_STORE_THIS'))
  assert.equal(event.model, 'jev-1.14.0')
  assert.equal(event.estimated_cost_nano_usd, 42000)
  assert.equal(event.output_nano_usd_per_token, 0)
})
test('failed responses without usage remain unknown, not free', (t) => {
  const repo = fixture(t)
  repo.record(normalizeJevUsage(value({ http_status: 402, outcome: 'http_error', usage: null })))
  const overview = repo.overview(),
    event = repo.list().rows[0]
  assert.equal(event.input_tokens, null)
  assert.equal(event.estimated_cost_nano_usd, null)
  assert.equal(overview.total.requests, 1)
  assert.equal(overview.total.successful, 0)
  assert.equal(overview.total.unknown_usage_requests, 1)
  assert.equal(overview.total.unknown_cost_requests, 1)
})
test('lifetime and Shanghai-day totals both count every actual call', (t) => {
  const repo = fixture(t)
  repo.record(normalizeJevUsage(value()))
  repo.record(normalizeJevUsage(value({ created_at: '2026-10-24T12:00:00.000Z' })))
  const s = repo.overview()
  assert.equal(s.day, '2026-10-25')
  assert.equal(s.total.requests, 2)
  assert.equal(s.total.input_tokens, 2000)
  assert.equal(s.today.requests, 1)
})
test('Shanghai daily boundary is used rather than host timezone', () => {
  assert.equal(shanghaiUsageDay('2026-10-24T15:59:59.000Z'), '2026-10-24')
  assert.equal(shanghaiUsageDay('2026-10-24T16:00:00.000Z'), '2026-10-25')
})
test('same-time pagination is stable and does not double count', (t) => {
  const repo = fixture(t)
  for (let i = 0; i < 7; i++) repo.record(normalizeJevUsage(value()))
  const first = repo.list({ limit: 3 }),
    next = repo.list({
      limit: 3,
      cursor_created_at: first.next_cursor.created_at,
      cursor_id: first.next_cursor.id,
    })
  assert.equal(first.has_more, true)
  assert.equal(new Set([...first.rows, ...next.rows].map((x) => x.id)).size, 6)
  assert.equal(repo.overview().total.requests, 7)
})
test('fingerprint filters and malformed cursors are bounded and validated', (t) => {
  const repo = fixture(t)
  repo.record(normalizeJevUsage(value()))
  assert.equal(repo.list({ key_fingerprint: '000000000000' }).rows.length, 0)
  assert.throws(() => repo.list({ cursor_id: 'wrong' }), TypeError)
  assert.throws(() => repo.list({ key_fingerprint: 'not-an-id' }), TypeError)
})
test('detail retention does not erase lifetime accounting', (t) => {
  const repo = fixture(t)
  repo.record(normalizeJevUsage(value({ created_at: new Date(NOW - 31 * 86400000).toISOString() })))
  assert.equal(repo.list().rows.length, 0)
  assert.equal(repo.overview().total.requests, 1)
  assert.equal(repo.overview().today.requests, 0)
})
test('duplicate persistence rolls back without doubling aggregates', (t) => {
  const repo = fixture(t),
    event = normalizeJevUsage(value())
  repo.record(event)
  assert.throws(() => repo.record(event))
  assert.equal(repo.overview().total.requests, 1)
})
test('unknown endpoints and malformed tokens do not fabricate prices', () => {
  assert.equal(isOfficialTypeSafeUrl('https://api.typesafe.ai/v1/systemone'), true)
  assert.equal(isOfficialTypeSafeUrl('https://api.typesafe.ai.other.example/v1/systemone'), false)
  assert.equal(isOfficialTypeSafeUrl('bad URL'), false)
  assert.equal(normalizeJevUsage(value({ official_typesafe: false })).estimated_cost_nano_usd, null)
  assert.equal(normalizeJevUsage(value({ usage: { input_tokens: -1, output_tokens: '5' } })).input_tokens, null)
})
test('telemetry storage errors are visible but cannot change classification flow', (t) => {
  const before = jevUsageStorageErrors()
  t.after(() => installJevUsageRecorder(null))
  installJevUsageRecorder(() => {
    throw new Error('synthetic store unavailable')
  })
  assert.doesNotThrow(() => recordJevUsage(value()))
  assert.equal(jevUsageStorageErrors(), before + 1)
})

test('the additive migration preserves old schema/data and permits old-version reopening', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-upgrade-'))
  const migrationDir = path.join(dir, 'baseline-migrations')
  fs.mkdirSync(migrationDir)
  const original = path.resolve(import.meta.dirname, '../../src/lib/db/migrations')
  for (const name of fs.readdirSync(original))
    if (name.endsWith('.sql') && name !== '045_jev_usage.sql')
      fs.copyFileSync(path.join(original, name), path.join(migrationDir, name))
  const file = path.join(dir, 'kin.db')
  let db
  t.after(() => {
    db?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db = createDatabase({ dbPath: file, migrationsDir: migrationDir })
  db.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?)').run(
    'jev_intercept',
    JSON.stringify({ enabled: true, api_keys: ['isolated-synthetic-key'] }),
    '2026-10-24T00:00:00.000Z',
  )
  const beforeSchema = db
    .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all()
  const beforeSettings = db.prepare('SELECT * FROM settings').all()
  const beforeMigrations = db.prepare('SELECT * FROM schema_migrations ORDER BY name').all()
  db.close()
  db = null
  db = createDatabase({ dbPath: file })
  const afterSchema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT IN ('jev_usage_events','jev_usage_meta','jev_usage_totals') ORDER BY type,name",
    )
    .all()
  assert.deepEqual(afterSchema, beforeSchema)
  assert.deepEqual(db.prepare('SELECT * FROM settings').all(), beforeSettings)
  assert.deepEqual(
    db.prepare("SELECT * FROM schema_migrations WHERE name <> '045_jev_usage.sql' ORDER BY name").all(),
    beforeMigrations,
  )
  const started = db.prepare('SELECT started_at FROM jev_usage_meta').get().started_at
  db.close()
  db = null
  db = createDatabase({ dbPath: file, migrationsDir: migrationDir })
  assert.deepEqual(db.prepare('SELECT * FROM settings').all(), beforeSettings)
  assert.equal(db.prepare('SELECT started_at FROM jev_usage_meta').get().started_at, started)
})

test('configured keys aggregate separately, include unused keys, and distinguish quota from throttling', (t) => {
  const repo = fixture(t)
  const a = jevKeyFingerprint('synthetic-a'),
    b = jevKeyFingerprint('synthetic-b')
  repo.record(normalizeJevUsage(value({ key_fingerprint: a })))
  repo.record(
    normalizeJevUsage(
      value({
        key_fingerprint: a,
        created_at: '2026-10-25T02:01:00.000Z',
        http_status: 402,
        outcome: 'http_error',
        usage: null,
      }),
    ),
  )
  repo.record(
    normalizeJevUsage(
      value({
        key_fingerprint: b,
        http_status: 429,
        outcome: 'http_error',
        usage: null,
      }),
    ),
  )
  const keys = repo.configuredKeys([
    { number: 1, key_fingerprint: a, retired: false },
    { number: 2, key_fingerprint: b, retired: true },
    { number: 3, key_fingerprint: '000000000000', retired: false },
  ])
  assert.equal(keys[0].estimated_cost_nano_usd, 42000)
  assert.equal(keys[0].requests, 2)
  assert.equal(keys[0].unknown_cost_requests, 1)
  assert.equal(keys[0].status, 'insufficient_balance')
  assert.equal(keys[1].status, 'rate_limited')
  assert.equal(keys[2].status, 'unrequested')
  assert.equal(keys[2].last_request_at, null)
})
