import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { getDb } from '../../src/lib/db/database.mjs'

test('a returned uncertain execution keeps API key concurrency after usage settlement', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-protocol-uncertain-'))
  const store = new ApiKeyStore({ db: getDb(), sharedAdmission: true })
  const key = await store.create({ max_concurrency: 1 })
  let executed = false
  const handler = createHandleProtocol({
    cfg: {
      limits: { max_body_bytes: 1 << 20 },
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      paths: { project: root, data: root },
    },
    json(res, status, body) {
      res.statusCode = status
      res.body = body
    },
    readBody,
    requireAuth(req) {
      req.apiKeyRecord = key
      req.apiKeyKind = 'managed'
      return true
    },
    requestLog: { start: () => ({ request_id: 'uncertain-key', t0: Date.now() }) },
    stats: { errors: 0, requests: 0, by_route: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    apiKeyStore: store,
    stickyRouter: { resolve: () => null },
    accountQuota: { ingestHeaders() {} },
    failoverRunner: {
      async run() {
        executed = true
        return {
          ok: false,
          status: 502,
          finalState: 'incomplete',
          executionUncertain: true,
          accountId: 'uncertain-account',
          vmId: 'uncertain-vm',
          body: { type: 'error', error: { type: 'api_error', message: 'upstream connection interrupted' } },
        }
      },
    },
    routingConfig: { compatibility: { claude_code_only: false } },
  })
  const req = Readable.from([
    Buffer.from(
      JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 20, messages: [{ role: 'user', content: 'x' }] }),
    ),
  ])
  req.headers = { 'user-agent': 'claude-cli/2.1.0 (external, cli)', 'anthropic-version': '2023-06-01' }
  const res = new EventEmitter()
  res.setHeader = () => {}
  try {
    await handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')
    assert.equal(executed, true, JSON.stringify(res.body))
    const row = await getDb()
      .prepare('SELECT released_at, settled_at FROM api_key_admissions WHERE key_id = $1')
      .get(key.id)
    assert.ok(row.settled_at, 'usage settlement remains independent of execution termination')
    assert.equal(row.released_at, null)
    assert.equal((await store.reserve(key)).code, 'api_key_concurrency_limit')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
