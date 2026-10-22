import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../../src/lib/db/database.mjs'
import { createRepositoryTestDatabase as createDatabase } from '../repository-database.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { dispatchStreamInference } from '../../src/lib/transport/kernel-router.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test
const accountId = 'account-lifecycle'
const vmId = 'vm-lifecycle'
const model = 'claude-test'
const seatKey = 'device-lifecycle'
const scopedSeatKey = `platform|${seatKey}`

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function success(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of [
    { type: 'message_start', message: { id: 'msg-lifecycle', type: 'message', role: 'assistant', model, content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  res.end()
}

/** Two controller instances share PostgreSQL; the kernel is a local Unix socket mock. */
async function fixture(t, handleMessage, handleCancel = (_job, _req, res) => res.end('{}')) {
  const env = ['VM2API_CONTROL_PLANE_MODE', 'KIN_KERNEL_BIN', 'KIN_CRS_MOCK']
  const previous = Object.fromEntries(env.map((key) => [key, process.env[key]]))
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  process.env.KIN_KERNEL_BIN = '/bin/true'
  process.env.KIN_CRS_MOCK = '0'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-hop-'))
  const runDir = path.join(root, 'vms', vmId, 'run')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(path.join(root, 'vms', vmId, 'cli-home'))
  const socket = path.join(runDir, 'kernel.sock')
  const token = path.join(runDir, 'internal.token')
  fs.writeFileSync(token, 'synthetic-internal-token\n', { mode: 0o600 })
  fs.writeFileSync(
    path.join(root, 'vms', `${vmId}.json`),
    JSON.stringify({
      id: vmId,
      status: 'running',
      schedulable: true,
      proxy_cli_enabled: true,
      proxy: { id: 'synthetic-proxy', url: 'socks5h://127.0.0.1:11001' },
      runtime: { kernel_socket: socket, worker_run_dir: runDir, worker_token_file: token },
      policy: { maxConcurrency: 1, concurrencyOverride: true },
      claude: {
        account_uuid: accountId,
        account_tier: 'max',
        access_token: 'synthetic-access',
        refresh_token: 'synthetic-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }),
  )
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const pools = [db, other].map(
    (connection) =>
      new PoolScheduler({
        projectRoot: root,
        accountQuota: {
          db: connection,
          canAccept: () => ({ ok: true }),
          limitFor: () => 2,
          policyFor: () => ({}),
          rpmLimitFor: () => 0,
        },
        workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
        config: { seat_grace_ms: 0, default_session_slots: 1 },
      }),
  )
  const runners = pools.map(
    (scheduler) =>
      new FailoverRunner({
        scheduler,
        config: { max_total_attempts: 3, max_account_switches: 2, total_retry_deadline_ms: 1000 },
      }),
  )
  const messages = []
  const cancellations = []
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const job = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (req.url === '/internal/v1/messages') {
        messages.push(job)
        await handleMessage(job, req, res)
      } else if (req.url === '/internal/v1/cancel') {
        cancellations.push(job)
        await handleCancel(job, req, res)
      } else {
        res.writeHead(404).end()
      }
    })().catch((error) => res.destroy(error))
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    try {
      for (const pool of pools) await pool.flush()
    } finally {
      await other.close()
      fs.rmSync(root, { recursive: true, force: true })
      for (const key of env) {
        if (previous[key] == null) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  const selected = []
  return {
    db,
    pools,
    messages,
    cancellations,
    selected,
    counts: () => pools[1].executionAdmissions.getCounts(accountId, vmId),
    async peerIsBlocked() {
      const candidate = await pools[1].selectAndReserve({ model, allowWait: false })
      try {
        assert.equal(candidate.ok, false, 'the other controller cannot reuse an unfinished VM execution')
        assert.ok(candidate.wait_reasons.includes('vm_concurrency_limit'))
      } finally {
        await candidate.release?.()
      }
    },
    run(index = 0, signal) {
      return runners[index].run({
        requestId: `synthetic-request-${selected.length}`,
        model,
        seatKey,
        canonicalBody: { model, messages: [{ role: 'user', content: 'synthetic request' }] },
        stream: true,
        signal,
        callAttempt({ candidate, body, signal, onCommit }) {
          selected.push(candidate)
          assert.equal(typeof candidate.bindExecution, 'function')
          assert.equal(typeof candidate.completeExecution, 'function')
          return dispatchStreamInference({
            exec: candidate.exec,
            body,
            signal,
            onCommit,
            onEvent: async () => {},
            timeoutMs: 1000,
            ensureRust: async () => ({ ok: true }),
            onExecutionStart: candidate.bindExecution,
            onExecutionEnd: candidate.completeExecution,
          })
        },
      })
    },
  }
}

unixTest('a shared streamed execution completes before releasing capacity and its device slot', async (t) => {
  const fx = await fixture(t, (_job, _req, res) => success(res))
  const result = await fx.run()
  assert.equal(result.ok, true)
  assert.equal(result.execution.ended, true)
  assert.equal(fx.messages.length, 1)
  assert.equal((await fx.counts()).vmInflight, 0)
  assert.equal(await fx.pools[1].executionAdmissions.getSeat(scopedSeatKey), null)
  const completed = await fx.db
    .prepare(`SELECT j.request_id, j.ended_at, a.released_at FROM execution_jobs j
      JOIN execution_admissions a ON a.id = j.admission_id`)
    .get()
  assert.equal(completed.request_id, fx.messages[0].request_id)
  assert.ok(completed.ended_at)
  assert.ok(completed.released_at >= completed.ended_at)
  const peerResult = await fx.run(1)
  assert.equal(peerResult.ok, true)
  assert.equal(fx.messages.length, 2)
  assert.deepEqual(
    fx.selected.map((candidate) => candidate.slotIndex),
    [0, 0],
  )
  assert.equal((await fx.counts()).accountInflight, 0)
})

unixTest('a truncated shared kernel socket cannot retry or release capacity to another controller', async (t) => {
  const fx = await fixture(t, (_job, _req, res) => res.destroy())
  const result = await fx.run()
  assert.equal(result.ok, false)
  assert.equal(result.executionUncertain, true)
  assert.equal(fx.messages.length, 1, 'neither the router nor the failover runner may submit a second job')
  assert.equal((await fx.counts()).vmInflight, 1)
  assert.equal((await fx.pools[1].executionAdmissions.getSeat(scopedSeatKey)).inflight, 1)
  await fx.peerIsBlocked()
})

unixTest('a complete kernel client-disconnected error retains its job, VM and device seat', async (t) => {
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
  const result = await fx.run()
  assert.equal(result.execution.ended, false)
  assert.equal(result.executionUncertain, true)
  assert.equal(fx.messages.length, 1)
  assert.equal((await fx.counts()).vmInflight, 1)
  assert.equal((await fx.pools[1].executionAdmissions.getSeat(scopedSeatKey)).inflight, 1)
  assert.equal((await fx.db.prepare('SELECT ended_at FROM execution_jobs').get()).ended_at, null)
  await fx.peerIsBlocked()
})

for (const [phase, trigger, code, expectedExecutions] of [
  ['binding', 'INSERT', 'P6481', 0],
  ['completion', 'UPDATE OF ended_at', 'P6482', 1],
]) {
  unixTest(`PostgreSQL ${phase} failure prevents replay and retains shared capacity`, async (t) => {
    const fx = await fixture(t, (_job, _req, res) => success(res))
    // This trigger exists only in the per-test schema and leaves admission uncertainty writes available.
    await fx.db.exec(`CREATE FUNCTION reject_lifecycle_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic execution ${phase} failure' USING ERRCODE = '${code}'; END;
      $$;
      CREATE TRIGGER reject_lifecycle_job BEFORE ${trigger} ON execution_jobs
        FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_job();`)
    const result = await fx.run()
    assert.equal(result.ok, false)
    assert.equal(result.executionUncertain, true)
    assert.equal(result.body.error.code, code, 'the original PostgreSQL failure reaches the request result')
    assert.equal(fx.messages.length, expectedExecutions)
    assert.equal(fx.selected.length, 1, 'persistence failure must not select a new attempt')
    assert.equal((await fx.counts()).vmInflight, 1)
    const rows = await fx.db.prepare('SELECT * FROM execution_jobs').all()
    assert.equal(rows.length, expectedExecutions)
    if (rows.length) {
      assert.equal(rows[0].request_id, fx.messages[0].request_id)
      assert.equal(rows[0].ended_at, null, 'failed completion does not create terminal evidence')
    }
    await fx.peerIsBlocked()
  })
}

unixTest(
  'a delayed successful cancel response does not prove a shared execution ended',
  { timeout: 5000 },
  async (t) => {
    const received = deferred()
    const cancelReceived = deferred()
    const answerCancel = deferred()
    const cancelAnswered = deferred()
    t.after(() => answerCancel.resolve())
    const fx = await fixture(
      t,
      (_job, _req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.flushHeaders()
        received.resolve()
      },
      async (_job, _req, res) => {
        cancelReceived.resolve()
        await answerCancel.promise
        res.end(JSON.stringify({ ok: true, cancelled: true }), () => cancelAnswered.resolve())
      },
    )
    const controller = new AbortController()
    const pending = fx.run(0, controller.signal)
    try {
      await Promise.race([received.promise, pending.then(() => assert.fail('execution did not reach the kernel'))])
      controller.abort()
      await cancelReceived.promise
      const result = await pending
      assert.equal(result.clientCancelled, true)
      assert.equal(fx.messages.length, 1)
      assert.equal(fx.cancellations[0].request_id, fx.messages[0].request_id)
      assert.equal((await fx.counts()).vmInflight, 1, 'capacity is retained while cancellation is pending')
      await fx.peerIsBlocked()
      answerCancel.resolve()
      await cancelAnswered.promise
      assert.equal((await fx.counts()).vmInflight, 1, 'HTTP cancel acceptance is not a native terminal acknowledgement')
      await fx.peerIsBlocked()
    } finally {
      controller.abort()
      answerCancel.resolve()
      await pending
    }
  },
)
