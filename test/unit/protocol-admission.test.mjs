import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'

async function call({ search = false, denied = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-protocol-admission-'))
  const events = []
  const key = { id: 'managed-key', category: 'oauth', group_type: 'all', allowed_vms: [] }
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
    requireAuth: (req) => {
      req.apiKeyRecord = key
      req.apiKeyKind = 'managed'
      return true
    },
    requestLog: { start: () => ({ request_id: 'admission', t0: Date.now() }) },
    stats: { errors: 0, requests: 0, by_route: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    apiKeyStore: {
      async reserve() {
        events.push('reserve')
        return denied
          ? { ok: false, status: 429, code: 'api_key_concurrency_limit', message: 'shared capacity exhausted' }
          : {
              ok: true,
              release: async () => {
                events.push('release')
              },
            }
      },
    },
    stickyRouter: { resolve: () => null },
    routingConfig: {
      codex: {
        clients: { openai_compatible: 'allow', unknown: 'allow' },
        protocols: { 'openai.responses': { enabled: true, mode: 'native' } },
      },
    },
  })
  const body = search
    ? { model: 'gpt-5.4', commands: { search_query: [{ q: 'x' }] } }
    : { model: 'gpt-5.4', input: 'x' }
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.headers = { 'user-agent': 'openai-node/1.0' }
  const res = new EventEmitter()
  res.setHeader = () => {}
  try {
    if (search) await handler.handleSearch(req, res, '/v1/alpha/search')
    else await handler.handleProtocol(req, res, 'openai.responses', '/v1/responses')
    return { res, events }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

for (const search of [false, true]) {
  const route = search ? 'Codex search' : 'Codex responses'
  test(`${route} respects managed-key admission before entering the execution backend`, async () => {
    const { res, events } = await call({ search })
    assert.equal(res.statusCode, 429)
    assert.equal(res.body.error.code, 'api_key_concurrency_limit')
    assert.deepEqual(events, ['reserve'])
  })

  test(`${route} awaits reservation release after a failed selection`, async () => {
    const { res, events } = await call({ search, denied: false })
    assert.ok(res.statusCode >= 400)
    assert.deepEqual(events, ['reserve', 'release'])
  })
}
