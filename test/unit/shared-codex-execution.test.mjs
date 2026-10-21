import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { SharedExecutionAdmissions } from '../../src/lib/pool/shared-execution-admissions.mjs'
import { handleCodexProtocol, pickCodexCandidates } from '../../src/lib/protocol/handle-codex.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { SharedCodexRuntime } from '../../src/lib/pool/shared-codex-runtime.mjs'
import { SharedRoutingConfig } from '../../src/lib/admin/shared-routing-config.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test
const accountId = 'codex:synthetic-shared-account'
const vmId = 'vm-shared-codex'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function until(check) {
  const deadline = Date.now() + 2000
  while (!(await check())) {
    if (Date.now() >= deadline) assert.fail('condition did not become true')
    await delay(5)
  }
}

function success(res) {
  const usage = { input_tokens: 1, output_tokens: 1 }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-usage': JSON.stringify(usage) })
  res.end(
    `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-shared', status: 'completed', output: [], usage } })}\n\n`,
  )
}

async function fixture(
  t,
  handle = (_job, _req, res) => success(res),
  { concurrency = 1, onCancel = (_job, _req, res) => res.end('{"ok":true,"cancelled":true}') } = {},
) {
  resetOpenAIAccountRuntime()
  const env = ['VM2API_CONTROL_PLANE_MODE', 'KIN_CRS_MOCK']
  const previous = Object.fromEntries(env.map((key) => [key, process.env[key]]))
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  process.env.KIN_CRS_MOCK = '0'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-codex-'))
  const runDir = path.join(root, 'vms', vmId, 'run')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(path.join(root, 'vms', vmId, 'cli-home'))
  const socket = path.join(runDir, 'codex-kernel.sock')
  const token = path.join(runDir, 'internal.token')
  fs.writeFileSync(token, 'synthetic-internal-token\n', { mode: 0o600 })
  fs.writeFileSync(
    path.join(root, 'vms', `${vmId}.json`),
    JSON.stringify({
      id: vmId,
      platform: 'openai',
      family: 'codex',
      schedulable: true,
      status: 'running',
      has_token: true,
      runtime: { codex_kernel_socket: socket, worker_run_dir: runDir, worker_token_file: token },
      policy: { maxConcurrency: concurrency, concurrencyOverride: true },
    }),
  )
  fs.writeFileSync(
    path.join(root, 'vms', vmId, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [
        {
          id: 'synthetic-id',
          access_token: 'synthetic-access',
          refresh_token: 'synthetic-refresh',
          chatgpt_account_id: 'synthetic-shared-account',
        },
      ],
    }),
  )
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const messages = []
  const cancellations = []
  const bindingsAtSend = []
  const runtimes = [db, other].map(
    (connection, index) => new SharedCodexRuntime(connection, { ownerId: `codex-controller-${index}` }),
  )
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const job = JSON.parse(Buffer.concat(chunks).toString())
      if (req.url.endsWith('/cancel')) {
        cancellations.push(job)
        await onCancel(job, req, res)
        return
      }
      messages.push(job)
      bindingsAtSend.push(await other.prepare('SELECT * FROM execution_jobs WHERE request_id = $1').get(job.request_id))
      await handle(job, req, res)
    })().catch((error) => res.destroy(error))
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await other.close()
    fs.rmSync(root, { recursive: true, force: true })
    for (const key of env) {
      if (previous[key] == null) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  return {
    root,
    db,
    other,
    messages,
    bindingsAtSend,
    cancellations,
    runtimes,
    counts: () => runtimes[1].admissions.getCounts(accountId, vmId),
    async run({ sharedRuntime, runtimeIndex, sessionId = null, signal, quota = {}, sessionTimeout = 100 } = {}) {
      if (runtimeIndex != null) sharedRuntime = runtimes[runtimeIndex]
      const response = Object.assign(new EventEmitter(), { headersSent: false, write() {}, end() {} })
      const req = Object.assign(new EventEmitter(), {
        headers: sessionId ? { 'x-session-id': sessionId } : {},
        apiKeyKind: 'user',
      })
      const abort = () => req.emit('aborted')
      signal?.addEventListener('abort', abort, { once: true })
      const body = { model: 'gpt-5.4', input: 'synthetic request', stream: false }
      try {
        await handleCodexProtocol({
          req,
          res: response,
          protocol: 'openai.responses',
          ctx: { body },
          inbound: body,
          projectRoot: root,
          logBag: {},
          stats: { requests: 0, errors: 0, by_route: {} },
          routing: {
            codex: { quota: { max_concurrency: concurrency, ...quota } },
            pool: { fallback_wait_timeout_ms: 1000 },
            failover: { session_queue_timeout_ms: sessionTimeout, max_total_attempts: 2, max_same_account_retries: 0 },
          },
          json(_res, status, payload) {
            response.status = status
            response.body = payload
            return payload
          },
          writeSSEHeaders() {
            response.headersSent = true
          },
          ops: { sharedRuntime, writeCodexKernelConfig() {}, ensureCodexKernel: async () => ({ ok: true }) },
        })
      } finally {
        signal?.removeEventListener('abort', abort)
      }
      return response
    },
  }
}

async function sharedRouting(fx, quota) {
  const file = path.join(fx.root, 'synthetic-routing.json')
  fs.writeFileSync(file, JSON.stringify({ codex: { quota } }))
  const state = new SharedRoutingConfig({
    db: fx.db,
    file,
    normalize: (value) => value,
    merge: (current, patch) => ({ ...current, ...patch }),
    apply: async () => {},
  })
  await state.init()
  return state
}

unixTest('shared Codex candidates retain the policy revision and inherited VM limits they read', async (t) => {
  const fx = await fixture(t, undefined, { concurrency: 9 })
  const file = path.join(fx.root, 'vms', `${vmId}.json`)
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy = { maxConcurrency: 9, concurrencyOverride: false, maxRpm: 999, rpmOverride: false }
  fs.writeFileSync(file, JSON.stringify(vm))
  const state = await sharedRouting(fx, { max_concurrency: 1, max_rpm: 2 })
  const runtime = new SharedCodexRuntime(fx.db)
  const options = { routing: { codex: { quota: { max_concurrency: 9, max_rpm: 999 } } }, sharedRuntime: runtime }
  const req = { headers: {}, apiKeyKind: 'user' }
  const picked = await pickCodexCandidates(fx.root, req, options)
  assert.equal(picked.candidates[0].concurrency, 1)
  assert.equal(picked.candidates[0].maxRpm, 2)
  assert.equal(picked.candidates[0].routingRevision, 1)
  assert.equal(picked.quotaPolicy.max_rpm, 2)
  await state.patch({ codex: { quota: { max_concurrency: 2, max_rpm: 3 } } })
  await assert.rejects(runtime.tryReserve(fx.root, vm, picked.candidates[0], picked.quotaPolicy), {
    code: 'routing_config_stale',
  })
  assert.equal((await fx.counts()).vmInflight, 0)
  const fresh = await pickCodexCandidates(fx.root, req, options)
  assert.equal(fresh.candidates[0].concurrency, 2)
  assert.equal(fresh.candidates[0].maxRpm, 3)
  assert.equal(fresh.candidates[0].routingRevision, 2)
  const lease = await runtime.tryReserve(fx.root, vm, fresh.candidates[0], fresh.quotaPolicy)
  assert.ok(lease)
  await lease.release()
})

unixTest('shared Codex reselects after a routing race before sending any kernel job', async (t) => {
  const fx = await fixture(t, undefined, { concurrency: 2 })
  const state = await sharedRouting(fx, { max_concurrency: 2 })
  const runtime = new SharedCodexRuntime(fx.db)
  const held = await new SharedExecutionAdmissions(fx.other).tryReserve({
    accountId,
    vmId: 'vm-shared-other',
    accountLimit: 2,
    vmLimit: 2,
    fableLimit: 0,
    rpmLimit: 0,
  })
  const reserve = runtime.tryReserve.bind(runtime)
  let changed = false
  runtime.tryReserve = async (...args) => {
    if (!changed) {
      changed = true
      await state.patch({ codex: { quota: { max_concurrency: 1 } } })
    }
    return reserve(...args)
  }
  try {
    const response = await fx.run({ sharedRuntime: runtime })
    assert.equal(changed, true)
    assert.equal(response.status, 429)
    assert.equal(fx.messages.length, 0, 'the old candidate cannot authorize an execution under the new revision')
    assert.equal((await fx.counts()).accountInflight, 1)
  } finally {
    await held.release()
  }
})

unixTest('Kubernetes Codex persists its actual kernel job before submission and releases only after EOF', async (t) => {
  const fx = await fixture(t)
  const response = await fx.run()
  assert.equal(response.status, 200)
  assert.equal(fx.messages.length, 1)
  assert.ok(fx.bindingsAtSend[0], 'the kernel job must already exist on the independent database connection')
  const row = await fx.other
    .prepare(`SELECT j.request_id, j.ended_at, a.account_id, a.released_at FROM execution_jobs j
    JOIN execution_admissions a ON a.id = j.admission_id`)
    .get()
  assert.equal(row.account_id, accountId)
  assert.equal(row.request_id, fx.messages[0].request_id)
  assert.ok(row.ended_at && row.released_at >= row.ended_at)
})

for (const scope of ['account', 'VM']) {
  unixTest(`Codex cannot bypass ${scope} capacity held by another database connection`, async (t) => {
    const fx = await fixture(t)
    const held = await new SharedExecutionAdmissions(fx.other).tryReserve({
      accountId: scope === 'account' ? accountId : 'codex:another-account',
      vmId: scope === 'VM' ? vmId : 'vm-another-codex',
      accountLimit: 1,
      vmLimit: 1,
      fableLimit: 0,
      rpmLimit: 0,
    })
    try {
      const response = await fx.run()
      assert.equal(fx.messages.length, 0, 'PostgreSQL is the final capacity authority')
      assert.equal(response.status, 429)
      assert.equal(response.body.error.code, 'pool_overloaded')
    } finally {
      await held.release()
    }
  })
}

unixTest('a truncated Codex socket retains its admission and session turn without retry or failover', async (t) => {
  const fx = await fixture(t, (_job, _req, res) => res.destroy())
  const response = await fx.run({ runtimeIndex: 0, sessionId: 'unknown-conversation' })
  assert.equal(response.status, 502)
  assert.equal(response.body.error.code, 'codex_execution_uncertain')
  assert.equal(fx.messages.length, 1)
  assert.equal((await fx.counts()).vmInflight, 1)
  const job = await fx.other.prepare('SELECT * FROM execution_jobs').get()
  assert.equal(job.ended_at, null)
  const turn = await fx.other.prepare('SELECT * FROM session_turns').get()
  assert.equal(turn.state, 'active')
  assert.ok(turn.uncertain_at)
  const blocked = await fx.run({ runtimeIndex: 1, sessionId: 'unknown-conversation' })
  assert.equal(blocked.status, 429)
  assert.equal(fx.messages.length, 1)
})

unixTest('a complete Codex kernel internal error cannot release capacity or start another job', async (t) => {
  const fx = await fixture(t, (_job, _req, res) => {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: false,
        error: {
          type: 'worker_error',
          code: 'provider_error',
          message: 'provider error: client disconnected',
          status: 502,
        },
      }),
    )
  })
  const result = await fx.run({ runtimeIndex: 0, sessionId: 'kernel-cancelled-conversation' })
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'codex_execution_uncertain')
  assert.equal(fx.messages.length, 1)
  assert.equal((await fx.counts()).vmInflight, 1)
  assert.equal((await fx.other.prepare('SELECT ended_at FROM execution_jobs').get()).ended_at, null)
  const turn = await fx.other.prepare('SELECT * FROM session_turns').get()
  assert.ok(turn.uncertain_at)
  const blocked = await fx.run({ runtimeIndex: 1, sessionId: 'kernel-cancelled-conversation' })
  assert.equal(blocked.status, 429)
  assert.equal(fx.messages.length, 1)
})

unixTest('Codex EOF permits an implicit retry only with a new persisted job ID', async (t) => {
  let executions = 0
  const fx = await fixture(t, (_job, _req, res) => {
    if (++executions === 1) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end('{"error":{"code":"upstream_transport"}}')
    } else success(res)
  })
  const response = await fx.run({ runtimeIndex: 0, sessionId: 'retry-conversation' })
  assert.equal(response.status, 200)
  assert.equal(fx.messages.length, 2)
  assert.notEqual(fx.messages[0].request_id, fx.messages[1].request_id)
  assert.ok(fx.bindingsAtSend.every(Boolean))
  const rows = await fx.other.prepare('SELECT * FROM execution_jobs').all()
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => row.ended_at))
  assert.equal((await fx.counts()).vmInflight, 0)
  assert.equal((await fx.other.prepare('SELECT count(*) AS count FROM session_turns').get()).count, 0)
})

for (const [phase, trigger, code, expectedJobs] of [
  ['binding', 'INSERT', 'P6481', 0],
  ['completion', 'UPDATE OF ended_at', 'P6482', 1],
]) {
  unixTest(`a Codex PostgreSQL ${phase} failure stops jobs and retains capacity and its turn`, async (t) => {
    const fx = await fixture(t)
    await fx.db.exec(`CREATE FUNCTION reject_codex_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic codex ${phase}' USING ERRCODE = '${code}'; END;
      $$; CREATE TRIGGER reject_codex_job BEFORE ${trigger} ON execution_jobs FOR EACH ROW EXECUTE FUNCTION reject_codex_job();`)
    await assert.rejects(fx.run({ runtimeIndex: 0, sessionId: 'fault-conversation' }), { code })
    assert.equal(fx.messages.length, expectedJobs)
    assert.equal((await fx.counts()).vmInflight, 1)
    const turn = await fx.other.prepare('SELECT * FROM session_turns').get()
    assert.equal(turn.state, 'active')
    assert.ok(turn.uncertain_at)
  })
}

unixTest('a Codex admission release failure cannot release its shared session turn', async (t) => {
  const fx = await fixture(t)
  await fx.db.exec(`CREATE FUNCTION reject_codex_release() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic codex release' USING ERRCODE = 'P6483'; END;
    $$; CREATE TRIGGER reject_codex_release BEFORE UPDATE OF released_at ON execution_admissions
      FOR EACH ROW EXECUTE FUNCTION reject_codex_release();`)
  await assert.rejects(fx.run({ runtimeIndex: 0, sessionId: 'release-conversation' }), { code: 'P6483' })
  assert.equal(fx.messages.length, 1)
  assert.equal((await fx.counts()).vmInflight, 1)
  const turn = await fx.other.prepare('SELECT * FROM session_turns').get()
  assert.equal(turn.state, 'active')
  assert.ok(turn.uncertain_at)
})

unixTest(
  'independent Codex runtimes serialize one session, allow another, and await release before advancing FIFO',
  { timeout: 10000 },
  async (t) => {
    const entered = deferred()
    const finishJob = deferred()
    const releaseEntered = deferred()
    const finishRelease = deferred()
    let jobs = 0
    const fx = await fixture(
      t,
      async (_job, _req, res) => {
        if (++jobs === 1) {
          entered.resolve()
          await finishJob.promise
        }
        success(res)
      },
      { concurrency: 2 },
    )
    const reserve = fx.runtimes[0].admissions.tryReserve.bind(fx.runtimes[0].admissions)
    let first = true
    fx.runtimes[0].admissions.tryReserve = async (...args) => {
      const gate = await reserve(...args)
      if (gate.ok && first) {
        first = false
        const release = gate.release
        gate.release = async () => {
          releaseEntered.resolve()
          await finishRelease.promise
          return release()
        }
      }
      return gate
    }
    const pending = [fx.run({ runtimeIndex: 0, sessionId: 'same-conversation', sessionTimeout: 5000 })]
    try {
      await entered.promise
      pending.push(fx.run({ runtimeIndex: 1, sessionId: 'same-conversation', sessionTimeout: 5000 }))
      await until(
        async () =>
          (await fx.other.prepare("SELECT count(*) AS count FROM session_turns WHERE state = 'waiting'").get())
            .count === 1,
      )
      assert.equal(fx.messages.length, 1)
      const other = await fx.run({ runtimeIndex: 1, sessionId: 'different-conversation' })
      assert.equal(other.status, 200)
      assert.equal(fx.messages.length, 2, 'a different session executes while the first kernel job is pending')
      finishJob.resolve()
      await releaseEntered.promise
      assert.equal(fx.messages.length, 2, 'the same-session waiter still cannot execute before lease release')
      finishRelease.resolve()
      const completed = await Promise.all(pending)
      assert.ok(completed.every((response) => response.status === 200))
      assert.equal(fx.messages.length, 3)
      assert.equal((await fx.counts()).accountInflight, 0)
      assert.equal((await fx.other.prepare('SELECT count(*) AS count FROM session_turns').get()).count, 0)
    } finally {
      finishJob.resolve()
      finishRelease.resolve()
      await Promise.allSettled(pending)
    }
  },
)

unixTest(
  'a successful Codex cancel response cannot prove execution ended or free its turn',
  { timeout: 5000 },
  async (t) => {
    const entered = deferred()
    const cancelEntered = deferred()
    const answerCancel = deferred()
    const answered = deferred()
    const fx = await fixture(
      t,
      (_job, _req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.flushHeaders()
        entered.resolve()
      },
      {
        onCancel: async (_job, _req, res) => {
          cancelEntered.resolve()
          await answerCancel.promise
          res.end('{"ok":true,"cancelled":true}', () => answered.resolve())
        },
      },
    )
    const controller = new AbortController()
    const pending = fx.run({ runtimeIndex: 0, sessionId: 'cancel-conversation', signal: controller.signal })
    try {
      await entered.promise
      controller.abort()
      await cancelEntered.promise
      await pending
      assert.equal((await fx.counts()).vmInflight, 1)
      answerCancel.resolve()
      await answered.promise
      assert.equal((await fx.counts()).vmInflight, 1)
      assert.equal(fx.cancellations[0].request_id, fx.messages[0].request_id)
      const blocked = await fx.run({ runtimeIndex: 1, sessionId: 'cancel-conversation' })
      assert.equal(blocked.status, 429)
      assert.equal(fx.messages.length, 1)
    } finally {
      controller.abort()
      answerCancel.resolve()
      await pending
    }
  },
)

unixTest('released Codex admissions still enforce the shared account RPM window', async (t) => {
  const fx = await fixture(t)
  assert.equal((await fx.run({ runtimeIndex: 0, quota: { max_rpm: 1 } })).status, 200)
  const response = await fx.run({ runtimeIndex: 1, quota: { max_rpm: 1 } })
  assert.equal(response.status, 429)
  assert.equal(fx.messages.length, 1)
})

for (const accounts of [
  [{ id: 'without-stable-id' }],
  [{ chatgpt_account_id: 'first' }, { chatgpt_account_id: 'second' }],
]) {
  unixTest(
    `shared Codex rejects ${accounts.length === 1 ? 'missing stable identity' : 'multiple credential accounts'} before execution`,
    async (t) => {
      const fx = await fixture(t)
      fs.writeFileSync(path.join(fx.root, 'vms', vmId, 'codex-credentials.json'), JSON.stringify({ accounts }))
      const response = await fx.run({ runtimeIndex: 0 })
      assert.equal(response.status, 503)
      assert.equal(response.body.error.code, 'codex_account_identity_unavailable')
      assert.equal(fx.messages.length, 0)
    },
  )
}
