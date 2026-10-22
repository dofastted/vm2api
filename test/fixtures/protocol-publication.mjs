import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import pg from 'pg'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { getDb, registerActivityCoordinator, quoteIdentifier } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { SharedExecutionAdmissions } from '../../src/lib/pool/shared-execution-admissions.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
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
      if (kind.startsWith('sync')) { enter(); return { publication } }
      return { updated: 0 }
    },
  },
})
const { createHandleProtocol } = await import('../../src/lib/protocol/handle-protocol.mjs')

test(`protocol uses the real shared runner for ${kind} publication`, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-protocol-publication-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const db = getDb()
  const store = new ApiKeyStore({ db, sharedAdmission: true })
  const key = await store.create({ max_concurrency: 1 })
  const peer = await createRepositoryTestDatabase({ connectionString: db.connectionString, schema: db.schema })
  const otherStore = new ApiKeyStore({ db: peer, sharedAdmission: true })
  const executions = new SharedExecutionAdmissions(db)
  const otherExecutions = new SharedExecutionAdmissions(peer)
  const coordinator = new GlobalMaintenanceCoordinator(db)
  await coordinator.start()
  await coordinator.acknowledgeEpoch(1)
  registerActivityCoordinator(db, coordinator)
  t.after(async () => {
    await coordinator.stop()
    await peer.close()
    const cleanup = new pg.Client({ connectionString: db.connectionString })
    await cleanup.connect()
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinator.schema)} CASCADE`)
    } finally {
      await cleanup.end()
    }
  })
  const activity = await coordinator.admit({ kind: 'http', requestId: 'publication-test' })
  let runnerCalls = 0
  let selections = 0
  let modelCalls = 0
  let marked = 0
  let finished = false
  let noteRunner
  const runnerStarted = new Promise((done) => { noteRunner = done })
  const states = []
  const plan = {
    vmId: 'publication-vm', accountId: 'publication-account',
    accountLimit: 1, vmLimit: 1, fableLimit: 0, rpmLimit: 0,
  }
  const scheduler = {
    executionAdmissions: executions,
    async selectAndReserve() {
      selections++
      if (selections > 1) return { ok: false, reason: 'no_eligible_accounts' }
      const lease = await executions.tryReserve(plan)
      assert.equal(lease.ok, true)
      return {
        ...lease,
        ...plan,
        vm: { id: plan.vmId, claude: {} },
        exec: { vmId: plan.vmId, homeDir: path.join(root, 'synthetic-home'), vm: {} },
        markUncertain: async () => {
          marked++
          return lease.markUncertain()
        },
      }
    },
    markCooldown() {},
    markSuccess() {},
  }
  const runner = new FailoverRunner({
    scheduler,
    config: { max_total_attempts: 2, max_account_switches: 1, max_same_account_retries: 0 },
  })
  const run = runner.run.bind(runner)
  // Keep the production runner's preparation/catch/finally path. Only backend execution is synthetic.
  t.mock.method(runner, 'run', async (args) => {
    runnerCalls++
    noteRunner()
    return run({
      ...args,
      callAttempt: async ({ candidate }) => {
        modelCalls++
        const execution = { requestId: 'synthetic-backend', started: true, ended: true, reason: 'synthetic_response' }
        await candidate.bindExecution(execution)
        await candidate.completeExecution(execution)
        return {
          ok: false, status: 400, terminalState: 'rejected', execution,
          body: { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic backend rejection' } },
        }
      },
    })
  })
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
    failoverRunner: runner,
    routingConfig: { compatibility: { claude_code_only: false } },
    onExecutionState: async (_req, state) => {
      states.push(state)
      activity.noteExecution(state)
    },
  })
  const req = Readable.from([Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 20, messages: [{ role: 'user', content: 'synthetic' }] }))])
  req.headers = { 'user-agent': 'claude-cli/2.1.0 (external, cli)', 'anthropic-version': '2023-06-01' }
  const res = new EventEmitter()
  res.setHeader = () => {}
  const request = activity.run(() => handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages'))
  request.then(() => { finished = true }, () => { finished = true })
  await entered
  await new Promise((done) => setImmediate(done))
  assert.equal(finished, false)
  assert.equal(modelCalls, 0)
  if (kind.startsWith('touch')) {
    assert.equal((await otherExecutions.tryReserve(plan)).ok, false, 'another connection cannot reuse pending capacity')
    assert.equal((await otherStore.reserve(key)).code, 'api_key_concurrency_limit')
  }
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
    assert.equal(modelCalls, 1)
    const keyAdmission = await peer.prepare('SELECT released_at FROM api_key_admissions WHERE key_id=$1').get(key.id)
    assert.ok(keyAdmission.released_at)
  } else {
    const finishedPublication = kind.endsWith('-finished')
    reject(Object.assign(new Error('synthetic publication failed'), {
      code: 'sftp_failed',
      ...(kind.includes('-finished') ? { publicationFinished: true } : {}),
      ...(!finishedPublication ? { executionUncertain: true } : {}),
    }))
    if (kind.startsWith('sync')) {
      await assert.rejects(request, /synthetic publication failed/)
      assert.equal(runnerCalls, 0)
    } else {
      await request
      assert.equal(runnerCalls, 1)
      assert.ok(res.statusCode >= 400)
      assert.ok(selections <= 2, 'the scheduler provides at most one candidate')
    }
    assert.equal(modelCalls, 0, 'publication preparation failure never invokes the model backend')
    assert.equal(marked > 0, !finishedPublication && kind.startsWith('touch'))
    assert.equal(states.some((state) => state.started === true && state.ended === false && !state.requestId), !finishedPublication)
    const row = await peer.prepare('SELECT released_at FROM api_key_admissions WHERE key_id=$1').get(key.id)
    if (kind.startsWith('sync')) {
      assert.equal(row, undefined, 'fleet publication precedes API key reservation')
    } else if (finishedPublication) {
      assert.ok(row.released_at)
      const next = await otherStore.reserve(key)
      assert.equal(next.ok, true)
      await next.release()
    } else {
      assert.equal(row.released_at, null)
      assert.equal((await otherStore.reserve(key)).code, 'api_key_concurrency_limit')
    }
  }
  const unknown = states.some((state) => state.started === true && state.ended === false)
  assert.equal(unknown, kind !== 'sync' && !kind.endsWith('-finished'))
  assert.equal((await peer.prepare('SELECT count(*) AS n FROM execution_jobs').get()).n, modelCalls)
  await activity.complete({ ended: !unknown, reason: unknown ? 'remote_publication_unknown' : 'request_finished' })
  const durableActivity = await peer.pool.query(
    `SELECT completed_at, uncertain_at FROM ${quoteIdentifier(coordinator.schema)}.activities WHERE id=$1`,
    [activity.activityId],
  )
  assert.equal(Boolean(durableActivity.rows[0].completed_at), !unknown)
  assert.equal(Boolean(durableActivity.rows[0].uncertain_at), unknown)
  const execution = await peer.prepare('SELECT released_at, uncertain_at FROM execution_admissions').get()
  if (kind.startsWith('sync') && kind !== 'sync') assert.equal(execution, undefined)
  else {
    assert.equal(Boolean(execution.released_at), !unknown)
    assert.equal(Boolean(execution.uncertain_at), unknown)
    const next = await otherExecutions.tryReserve(plan)
    assert.equal(next.ok, !unknown, 'another connection sees the final execution capacity')
    if (next.ok) await next.release()
  }
})
