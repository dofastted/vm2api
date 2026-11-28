import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import {
  ThinkingOwnerStore,
  filterThinkingForAccount,
  recordThinkingOwners,
  thinkingSignatureKey,
} from '../../src/lib/pool/thinking-owner.mjs'

const OWN = 'sig-own-account-0123456789abcdef'
const FOREIGN = 'sig-other-account-0123456789abcd'
const UNKNOWN = 'sig-never-recorded-0123456789abcd'
const SHORT = 'too-short'

function store() {
  return new ThinkingOwnerStore({ db: new DatabaseSync(':memory:') })
}

function history() {
  return {
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'own chain', signature: OWN },
          { type: 'thinking', thinking: 'foreign chain', signature: FOREIGN },
          { type: 'thinking', thinking: '   ', signature: UNKNOWN },
          { type: 'redacted_thinking', data: UNKNOWN },
          { type: 'thinking', thinking: 'unsigned', signature: SHORT },
          { type: 'text', text: 'answer' },
        ],
      },
    ],
  }
}

test('a signature stays with the account that first returned it', () => {
  const owners = store()
  const response = { content: [{ type: 'thinking', thinking: 'own chain', signature: OWN }] }
  assert.equal(recordThinkingOwners(response, 'account-a', owners), 1)
  recordThinkingOwners(response, 'account-b', owners)
  const out = filterThinkingForAccount(history(), 'account-a', owners)
  const blocks = out.body.messages[1].content
  assert.equal(blocks[0].type, 'thinking')
  assert.equal(blocks[0].signature, OWN)
  assert.deepEqual(blocks[1], { type: 'text', text: 'foreign chain' })
  assert.equal(
    blocks.some((block) => block.signature === UNKNOWN || block.data === UNKNOWN),
    false,
  )
  assert.equal(blocks.at(-2).signature, SHORT)
  assert.equal(blocks.at(-1).text, 'answer')
  assert.deepEqual(
    { kept: out.kept, converted: out.converted, dropped: out.dropped, unknown: out.unknown },
    { kept: 1, converted: 1, dropped: 2, unknown: 3 },
  )
})

test('the same foreign signature converts to the same text on a later hop', () => {
  const owners = store()
  recordThinkingOwners(
    { content: [{ type: 'thinking', thinking: 'foreign chain', signature: FOREIGN }] },
    'account-b',
    owners,
  )
  const first = filterThinkingForAccount(history(), 'account-a', owners)
  const second = filterThinkingForAccount(history(), 'account-a', owners)
  assert.deepEqual(first.body.messages[1].content[1], second.body.messages[1].content[1])
  assert.equal(
    thinkingSignatureKey({ type: 'thinking', signature: FOREIGN }),
    thinkingSignatureKey({ type: 'thinking', signature: FOREIGN }),
  )
})

test('an unreachable database leaves the history untouched', () => {
  const body = history()
  const closed = new DatabaseSync(':memory:')
  closed.close()
  const owners = new ThinkingOwnerStore({ db: closed })
  const out = filterThinkingForAccount(body, 'account-a', owners)
  assert.equal(out.body, body)
  assert.equal(out.kept, 4)
  assert.equal(out.converted, 0)
  assert.equal(recordThinkingOwners(body.messages[1], 'account-a', owners), 4)
})

const SERVED = 'sig-served-by-account-a-0123456789'

test('a handler records the served signature and the next account replays it as text', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-thinking-owner-'))
  const owners = new ThinkingOwnerStore({ db: new DatabaseSync(':memory:') })
  const seen = []
  const handler = createHandleProtocol({
    json: (_res, status) => status,
    writeSSEHeaders() {},
    readBody: async () =>
      seen.length
        ? {
            model: 'claude-haiku-4-5',
            messages: [
              { role: 'user', content: 'before' },
              {
                role: 'assistant',
                content: [
                  { type: 'thinking', thinking: 'served chain', signature: SERVED },
                  { type: 'thinking', thinking: '', signature: FOREIGN },
                ],
              },
              { role: 'user', content: 'after' },
            ],
          }
        : { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello' }] },
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'thinking-owner', mode: 'normal' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: path.join(root, 'routing.json'),
    routingConfig: { compatibility: {}, failover: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    thinkingOwners: owners,
    failoverRunner: {
      async run(opts) {
        const accountId = seen.length === 1 ? 'account-b' : 'account-a'
        const selected = { vmId: 'vm-01', accountId, vm: { id: 'vm-01' }, exec: { homeDir: root } }
        const prepared = await opts.applyAttempt(opts.canonicalBody, selected)
        seen.push(prepared.body)
        if (accountId === 'account-b') return { ok: false, status: 503, body: { error: { message: 'stop' } } }
        return {
          ok: true,
          status: 200,
          accountId,
          sawMessageStop: true,
          body: {
            type: 'message',
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [
              { type: 'thinking', thinking: 'served chain', signature: SERVED },
              { type: 'text', text: 'done' },
            ],
          },
        }
      },
    },
  })
  const response = { headersSent: false, on() {}, once() {}, off() {}, write() {}, end() {} }
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-x', 'user-agent': 'claude-cli/2.1.241 (external, cli)' },
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'key-1' },
    once() {},
    off() {},
  }
  try {
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    const other = seen[1].messages.find((message) => message.role === 'assistant')
    assert.deepEqual(other.content[0], { type: 'text', text: 'served chain' })
    const own = seen[2].messages.find((message) => message.role === 'assistant')
    assert.equal(own.content[0].signature, SERVED)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
test('dropping the only signed block merges the neighbouring turns', () => {
  const owners = store()
  recordThinkingOwners({ content: [{ type: 'thinking', thinking: '', signature: FOREIGN }] }, 'account-b', owners)
  const out = filterThinkingForAccount(
    {
      messages: [
        { role: 'user', content: 'before' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: FOREIGN }] },
        { role: 'user', content: 'after' },
      ],
    },
    'account-a',
    owners,
  )
  assert.equal(out.dropped, 1)
  assert.deepEqual(
    out.body.messages.map((message) => message.content),
    ['before\nafter'],
  )
  assert.equal(out.body.messages.length, 1)
})

test('ThinkingOwnerStore L1 negative cache absorbs repeated unknown signatures, evicts on record(), and sync SQL avoids json_each', () => {
  const db = new DatabaseSync(':memory:')
  const executedSql = []
  const origPrepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    const stmt = origPrepare(sql)
    return new Proxy(stmt, {
      get(target, prop) {
        const val = Reflect.get(target, prop, target)
        if (['get', 'all', 'run'].includes(prop)) {
          return (...args) => {
            executedSql.push(String(sql))
            return val.apply(target, args)
          }
        }
        return typeof val === 'function' ? val.bind(target) : val
      },
    })
  }

  const owners = new ThinkingOwnerStore({ db, negCacheTtlMs: 60_000, negCacheMaxItems: 128 })
  const k1 = thinkingSignatureKey({ type: 'thinking', signature: UNKNOWN })
  const k2 = thinkingSignatureKey({ type: 'thinking', signature: `${UNKNOWN}-2` })
  const t0 = 1_750_000_000_000

  // First miss hits DB once using PK `IN (?, ?)` (NO json_each!)
  const m1 = owners.ownersOf([k1, k2], t0)
  assert.equal(m1.size, 0)
  const selectSqls = executedSql.filter((s) => /SELECT key, account_id FROM thinking_signature_owners/i.test(s))
  assert.equal(selectSqls.length, 1)
  assert.equal(/json_each/i.test(selectSqls[0]), false, 'sync query must not use json_each')
  const plan = origPrepare(`EXPLAIN QUERY PLAN ${selectSqls[0]}`).all(k1, k2)
  assert.equal(
    /SCAN thinking_signature_owners\b/i.test(plan.map((r) => r.detail || '').join('\n')),
    false,
    'sync query must use primary key index',
  )

  // Second call within TTL hits bounded L1 negative cache -> 0 DB queries!
  executedSql.length = 0
  const m2 = owners.ownersOf([k1, k2], t0 + 10_000)
  assert.equal(m2.size, 0)
  assert.equal(executedSql.length, 0, 'repeated unknown signatures must hit L1 negative cache')

  // Recording k1 evicts it from negative cache immediately while k2 stays negatively cached
  owners.record([k1], 'account-new', t0 + 15_000)
  executedSql.length = 0
  const m3 = owners.ownersOf([k1, k2], t0 + 20_000)
  assert.equal(m3.get(k1), 'account-new')
  assert.equal(m3.has(k2), false)
  assert.equal(
    executedSql.filter((s) => /SELECT key, account_id/i.test(s)).length,
    0,
    'recorded key hits positive L1 and unrecorded key stays on negative L1',
  )

  // Past negative cache TTL -> re-queries DB for k2
  executedSql.length = 0
  owners.ownersOf([k2], t0 + 70_000)
  assert.equal(executedSql.filter((s) => /SELECT key, account_id/i.test(s)).length, 1)
  db.close()
})

test('ThinkingOwnerStore PG mode runs ownersOfAsync/prewarmOwnersAsync/record on pgPool with 0 sync DB calls', async () => {
  const knownKey = thinkingSignatureKey({ type: 'thinking', signature: OWN })
  const unknownKey = thinkingSignatureKey({ type: 'thinking', signature: UNKNOWN })
  const pgQueries = []
  const mockPgPool = {
    async query(sql, params) {
      const text = String(sql)
      pgQueries.push({ sql: text, params })
      if (/SELECT key, account_id FROM thinking_signature_owners WHERE key = ANY/i.test(text)) {
        const requested = params[0] || []
        return {
          rows: requested.includes(knownKey) ? [{ key: knownKey, account_id: 'pg-acc-1' }] : [],
        }
      }
      return { rows: [], rowCount: 1 }
    },
  }
  const forbidSyncDb = {
    engine: 'postgres',
    prepare(sql) {
      throw new Error(`PG mode must not call sync db.prepare: ${sql}`)
    },
    exec(sql) {
      throw new Error(`PG mode must not call sync db.exec: ${sql}`)
    },
  }

  const owners = new ThinkingOwnerStore({ db: forbidSyncDb, pgPool: mockPgPool, negCacheTtlMs: 60_000 })
  const t0 = Date.now()

  // 1. prewarmOwnersAsync queries PG asynchronously with `WHERE key = ANY($1::text[])`
  const warmed = await owners.prewarmOwnersAsync([knownKey, unknownKey], t0)
  assert.equal(warmed.get(knownKey), 'pg-acc-1')
  assert.equal(warmed.has(unknownKey), false)
  assert.equal(
    pgQueries.filter((q) => /WHERE key = ANY\(\$1::text\[\]\)/i.test(q.sql)).length,
    1,
    'must execute 1 indexed PG ANY($1::text[]) lookup',
  )

  // 2. Subsequent sync ownersOf() & filterThinkingForAccount() resolve with 0 PG queries & 0 sync calls!
  pgQueries.length = 0
  const syncLookup = owners.ownersOf([knownKey, unknownKey], t0 + 1_000)
  assert.equal(syncLookup.get(knownKey), 'pg-acc-1')
  assert.equal(syncLookup.has(unknownKey), false)
  assert.equal(pgQueries.length, 0)

  const filtered = filterThinkingForAccount(
    {
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'mine', signature: OWN },
            { type: 'thinking', thinking: 'mystery', signature: UNKNOWN },
          ],
        },
      ],
    },
    'pg-acc-1',
    owners,
  )
  assert.equal(filtered.kept, 1)
  assert.equal(filtered.converted, 1)
  assert.equal(filtered.unknown, 1)

  // 3. record() in PG mode evicts negative cache and writes via UNNEST ... ON CONFLICT DO NOTHING
  owners.record([unknownKey], 'pg-acc-2', t0 + 2_000)
  await owners.flushPgWrites()
  const insertCall = pgQueries.find((q) =>
    /INSERT INTO thinking_signature_owners[\s\S]*UNNEST[\s\S]*ON CONFLICT \(key\) DO NOTHING/i.test(q.sql),
  )
  assert.ok(insertCall, 'PG record() must use async UNNEST ON CONFLICT DO NOTHING')
  assert.deepEqual(insertCall.params[0], [unknownKey])
  assert.equal(insertCall.params[1], 'pg-acc-2')
  assert.equal(owners.ownersOf([unknownKey], t0 + 3_000).get(unknownKey), 'pg-acc-2')
})
