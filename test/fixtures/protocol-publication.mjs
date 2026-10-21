import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { getDb } from '../../src/lib/db/database.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'

const kind = process.env.VM2API_PROTOCOL_PUBLICATION_CASE
const telemetry = await import('../../src/lib/vm/worker-telemetry.mjs')
const supervisor = await import('../../src/lib/transport/rust-kernel-supervisor.mjs')
let enter
let resolve
let reject
const entered = new Promise((done) => { enter = done })
const publication = new Promise((done, fail) => { resolve = done; reject = fail })
mock.module(new URL('../../src/lib/vm/worker-telemetry.mjs', import.meta.url), {
  namedExports: { ...telemetry, touchTelemetrySession() { enter(); return { wrote: true, publication } } },
})
mock.module(new URL('../../src/lib/transport/rust-kernel-supervisor.mjs', import.meta.url), {
  namedExports: {
    ...supervisor,
    syncClaudeKernelConfigsFromFile() {
      if (kind === 'sync') { enter(); return { publication } }
      return { updated: 0 }
    },
  },
})
const { createHandleProtocol } = await import('../../src/lib/protocol/handle-protocol.mjs')

test(`protocol waits for ${kind} publication and preserves unknown activity`, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-protocol-publication-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const db = getDb()
  const store = new ApiKeyStore({ db, sharedAdmission: true })
  const key = await store.create({ max_concurrency: 1 })
  let runnerCalls = 0
  let marked = 0
  let finished = false
  let noteRunner
  const runnerStarted = new Promise((done) => { noteRunner = done })
  const states = []
  const handler = createHandleProtocol({
    cfg: {
      limits: { max_body_bytes: 1 << 20 }, rewrite: { enabled: false },
      intercept: { rules: [] }, distill: { enabled: false }, paths: { project: root, data: root },
    },
    json(res, status, body) { res.statusCode = status; res.body = body },
    readBody,
    requireAuth(req) { req.apiKeyRecord = key; req.apiKeyKind = 'managed'; return true },
    requestLog: { start: () => ({ request_id: 'publication-test', t0: Date.now() }) },
    stats: { errors: 0, requests: 0, by_route: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    apiKeyStore: store,
    stickyRouter: { resolve: () => null },
    accountQuota: { ingestHeaders() {} },
    failoverRunner: {
      async run({ applyAttempt, canonicalBody }) {
        runnerCalls++
        noteRunner()
        if (kind === 'touch') await applyAttempt(canonicalBody, {
          vmId: 'publication-vm', accountId: 'publication-account', vm: {}, exec: {},
          markUncertain: async () => { marked++ },
        })
        return { ok: false, status: 502, body: { type: 'error', error: { type: 'api_error', message: 'synthetic' } } }
      },
    },
    routingConfig: { compatibility: { claude_code_only: false } },
    onExecutionState: async (_req, state) => states.push(state),
  })
  const req = Readable.from([Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 20, messages: [{ role: 'user', content: 'synthetic' }] }))])
  req.headers = { 'user-agent': 'claude-cli/2.1.0 (external, cli)', 'anthropic-version': '2023-06-01' }
  const res = new EventEmitter()
  res.setHeader = () => {}
  const request = handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')
  request.then(() => { finished = true }, () => { finished = true })
  await entered
  await new Promise((done) => setImmediate(done))
  assert.equal(finished, false)
  if (kind === 'sync') {
    const phase = await Promise.race([
      runnerStarted.then(() => 'started'),
      new Promise((done) => setTimeout(() => done('blocked'), 200)),
    ])
    assert.equal(phase, 'blocked', 'model scheduling waits for publication completion')
    assert.equal(runnerCalls, 0)
    resolve()
    await request
    assert.equal(runnerCalls, 1)
  } else {
    reject(Object.assign(new Error('synthetic publication failed'), { code: 'sftp_failed', executionUncertain: true }))
    await assert.rejects(request, /synthetic publication failed/)
    assert.equal(marked, 1)
    assert.ok(states.some((state) => state.started === true && state.ended === false && !state.requestId))
    const row = await db.prepare('SELECT released_at FROM api_key_admissions WHERE key_id=$1').get(key.id)
    assert.equal(row.released_at, null)
    assert.equal((await store.reserve(key)).code, 'api_key_concurrency_limit')
  }
})
