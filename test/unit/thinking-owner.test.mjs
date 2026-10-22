import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../../src/lib/db/database.mjs'
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
  return new ThinkingOwnerStore({ db: getDb() })
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

test('a signature stays with the account that first returned it', async () => {
  const owners = store()
  const response = { content: [{ type: 'thinking', thinking: 'own chain', signature: OWN }] }
  assert.equal(await recordThinkingOwners(response, 'account-a', owners), 1)
  await recordThinkingOwners(response, 'account-b', owners)
  const out = await filterThinkingForAccount(history(), 'account-a', owners)
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

test('the same foreign signature converts to the same text on a later hop', async () => {
  const owners = store()
  await recordThinkingOwners(
    { content: [{ type: 'thinking', thinking: 'foreign chain', signature: FOREIGN }] },
    'account-b',
    owners,
  )
  const first = await filterThinkingForAccount(history(), 'account-a', owners)
  const second = await filterThinkingForAccount(history(), 'account-a', owners)
  assert.deepEqual(first.body.messages[1].content[1], second.body.messages[1].content[1])
  assert.equal(
    thinkingSignatureKey({ type: 'thinking', signature: FOREIGN }),
    thinkingSignatureKey({ type: 'thinking', signature: FOREIGN }),
  )
})

test('an unreachable database leaves the history untouched', async () => {
  const body = history()
  const closed = getDb()
  await closed.close()
  const owners = new ThinkingOwnerStore({ db: closed })
  const out = await filterThinkingForAccount(body, 'account-a', owners)
  assert.equal(out.body, body)
  assert.equal(out.kept, 4)
  assert.equal(out.converted, 0)
  assert.equal(await recordThinkingOwners(body.messages[1], 'account-a', owners), 4)
})

const SERVED = 'sig-served-by-account-a-0123456789'

test('a handler records the served signature and the next account replays it as text', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-thinking-owner-'))
  const owners = new ThinkingOwnerStore({ db: getDb() })
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
    apiKeyStore: { reserve: async (record) => ({ ok: true, record, release: async () => {} }) },
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
test('dropping the only signed block merges the neighbouring turns', async () => {
  const owners = store()
  await recordThinkingOwners({ content: [{ type: 'thinking', thinking: '', signature: FOREIGN }] }, 'account-b', owners)
  const out = await filterThinkingForAccount(
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
