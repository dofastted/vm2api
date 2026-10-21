/** Isolate module mocks so ordinary tests need no experimental Node flag. */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { getDb } from '../../src/lib/db/database.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'

const [route, failure] = process.env.VM2API_SETTLEMENT_FAILURE_CASE.split(':')
async function completedUpstream({ req, logBag, json, res, onExecutionState }) {
  const execution = { requestId: 'synthetic-settlement-job', started: true, ended: false }
  await onExecutionState?.(req, execution)
  logBag.final_state = 'verified'
  logBag.usage = { input_tokens: 1, output_tokens: 1 }
  const result = json(res, 200, { upstream_completed: true })
  if (failure === 'backend') throw new Error('simulated execution-stage backend failure')
  await onExecutionState?.(req, { ...execution, ended: true, reason: 'http_body_complete' })
  return result
}
mock.module(new URL('../../src/lib/protocol/handle-codex.mjs', import.meta.url), {
  namedExports: {
    handleCodexProtocol: completedUpstream,
    handleCodexSearch: completedUpstream,
    usageFromSseLine: () => null,
  },
})
const { createHandleProtocol } = await import('../../src/lib/protocol/handle-protocol.mjs')

test(`${route}:${failure}`, async () => {
  const db = getDb()
  const store = new ApiKeyStore({ db, sharedAdmission: true })
  const key = await store.create({ max_concurrency: 0, quota_requests: 1 })
  const handler = createHandleProtocol({
    cfg: {
      limits: { max_body_bytes: 1 << 20 },
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      paths: { project: '/tmp', data: '/tmp' },
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
    requestLog: { start: () => ({ request_id: 'settlement-failure', t0: Date.now() }) },
    stats: { errors: 0, requests: 0, by_route: {} },
    groupsRepo: {
      rateMultiplier() {
        if (failure === 'multiplier') throw new Error('simulated execution-stage multiplier failure')
        return 1
      },
    },
    apiKeyStore: store,
    stickyRouter: { resolve: () => null },
    routingConfig: {
      codex: {
        clients: { openai_compatible: 'allow', unknown: 'allow' },
        protocols: { 'openai.responses': { enabled: true, mode: 'native' } },
      },
    },
  })
  const req = Readable.from([Buffer.from(JSON.stringify({ model: 'gpt-5.4', input: 'x' }))])
  req.headers = { 'user-agent': 'openai-node/1.0' }
  const res = new EventEmitter()
  res.setHeader = () => {}
  const request = route === 'search'
    ? handler.handleSearch(req, res, '/v1/alpha/search')
    : handler.handleProtocol(req, res, 'openai.responses', '/v1/responses')
  await assert.rejects(request, new RegExp(`simulated execution-stage ${failure} failure`))
  assert.equal(res.body.upstream_completed, true)
  assert.equal((await store.getById(key.id)).quota_requests_used, 0)
  const reservation = await db.prepare('SELECT released_at, settled_at FROM api_key_admissions WHERE key_id = $1').get(key.id)
  assert.equal(reservation.settled_at, null)
  assert.equal(reservation.released_at, null, 'retain the uncertain completed request until recovery can reconcile usage')
  const next = await store.reserve(key)
  assert.equal(next.code, 'api_key_quota_exhausted', 'pending quota must prevent another execution')
})
