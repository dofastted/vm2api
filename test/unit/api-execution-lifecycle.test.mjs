import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runApiInference } from '../../src/lib/pool/api-protocol.mjs'
import { forwardApi } from '../../src/lib/transport/api-kernel-client.mjs'
import { createClaudeMessageAssembler, applyClaudeSSELineToMessage } from '../../src/lib/protocol/convert.mjs'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { SharedExecutionAdmissions } from '../../src/lib/pool/shared-execution-admissions.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function success(res, { stop = true, openai = false } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const events = openai
    ? [{ type: stop ? 'response.completed' : 'response.output_text.delta', response: { id: 'resp-test', output: [] } }]
    : [
        {
          type: 'message_start',
          message: {
            id: 'msg-test',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello message_stop' }],
          },
        },
        ...(stop ? [{ type: 'message_stop' }] : []),
      ]
  res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
}

async function fixture(t, handle = (_job, _req, res) => success(res)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-execution-'))
  const socket = path.join(root, 'run', 'api-kernel.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const jobs = []
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const job = JSON.parse(Buffer.concat(chunks).toString())
      jobs.push(job)
      await handle(job, req, res)
    })().catch((error) => res.destroy(error))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const cfg = { paths: { data: root } }
  return {
    cfg,
    jobs,
    async run(options = {}) {
      return runApiInference({
        cfg,
        req: { headers: {} },
        res: { headersSent: false, write() {} },
        convertedBody: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
        inbound: { model: 'claude-test' },
        protocol: 'anthropic.messages',
        deliveryMode: 'verified',
        clientStream: false,
        store: { listRaw: async () => [], setKeyCooldown: async () => {} },
        scheduler: {
          reload() {},
          pick: () => ({
            ok: true,
            endpoint: { id: 'ep-test', kind: 'claude', protocol: 'anthropic', base_url: 'https://synthetic.invalid' },
            key: { id: 'key-test', api_key: 'synthetic' },
            upstream_model: 'claude-test',
          }),
        },
        converters: { createClaudeMessageAssembler, applyClaudeSSELineToMessage, writeSSEHeaders() {} },
        ...options,
      })
    },
  }
}

test('API inference awaits start before forwarding and end after complete SSE EOF', async (t) => {
  const entered = deferred()
  const grant = deferred()
  const fx = await fixture(t)
  const starts = []
  const ends = []
  const pending = fx.run({
    onExecutionStart: async (execution) => {
      starts.push(execution)
      entered.resolve()
      await grant.promise
    },
    onExecutionEnd: async (execution) => {
      ends.push({ ...execution })
      await Promise.resolve()
    },
  })
  try {
    await Promise.race([entered.promise, pending.then(() => assert.fail('start hook was not called'))])
    assert.equal(fx.jobs.length, 0)
    grant.resolve()
    const result = await pending
    assert.equal(starts.length, 1)
    assert.equal(ends.length, 1)
    assert.equal(fx.jobs[0].request_id, starts[0].requestId)
    assert.equal(ends[0].requestId, starts[0].requestId)
    assert.equal(ends[0].ended, true)
    assert.deepEqual(result.execution, ends[0])
  } finally {
    grant.resolve()
    await pending
  }
})

for (const clientStream of [false, true]) {
  test(`API SSE missing terminal remains unknown (clientStream=${clientStream})`, async (t) => {
    const fx = await fixture(t, (_job, _req, res) => success(res, { stop: false }))
    const ended = []
    const result = await fx.run({ clientStream, onExecutionEnd: (execution) => ended.push(execution) })
    assert.equal(result.execution.ended, false)
    assert.equal(result.executionUncertain, true)
    assert.equal(ended.length, 1)
  })
}

for (const kind of ['ordinary_rejection', 'truncated_rejection', 'upstream_transport']) {
  test(`API ${kind} classifies execution after its body rather than response headers`, async (t) => {
    const fx = await fixture(t, (_job, _req, res) => {
      res.writeHead(kind === 'upstream_transport' ? 502 : 429, {
        'content-type': 'application/json',
        ...(kind === 'truncated_rejection' ? { 'content-length': '1000' } : {}),
      })
      const body = JSON.stringify({ error: { code: kind, message: 'synthetic' } })
      if (kind === 'truncated_rejection') {
        res.write(body.slice(0, 15))
        setImmediate(() => res.destroy())
      } else res.end(body)
    })
    const ended = []
    const result = await fx.run({ onExecutionEnd: (execution) => ended.push(execution) })
    assert.equal(ended.length, 1)
    assert.equal(result.execution.ended, kind === 'ordinary_rejection')
    assert.equal(!!result.executionUncertain, kind !== 'ordinary_rejection')
  })
}

test('API abort after headers remains unknown and invokes end once', async (t) => {
  const entered = deferred()
  const fx = await fixture(t, (_job, _req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"message_start"}\n\n')
    entered.resolve()
  })
  const controller = new AbortController()
  const ended = []
  const pending = fx.run({ signal: controller.signal, onExecutionEnd: (execution) => ended.push(execution) })
  await entered.promise
  controller.abort()
  const result = await pending
  assert.equal(result.execution.ended, false)
  assert.equal(result.executionUncertain, true)
  assert.equal(ended.length, 1)
})

for (const phase of ['start', 'end']) {
  test(`API ${phase} hook errors are rethrown unchanged`, async (t) => {
    const fx = await fixture(t)
    const error = new Error(`synthetic ${phase} error`)
    await assert.rejects(
      fx.run({
        [phase === 'start' ? 'onExecutionStart' : 'onExecutionEnd']: async () => {
          throw error
        },
      }),
      (actual) => actual === error,
    )
    assert.equal(fx.jobs.length, phase === 'start' ? 0 : 1)
  })
}

test('API no-endpoint rejection has not_started metadata and sends no callbacks', async (t) => {
  const fx = await fixture(t)
  const result = await fx.run({
    scheduler: { reload() {}, pick: () => ({ ok: false, code: 'no_endpoint' }) },
    onExecutionStart: () => assert.fail('no execution'),
    onExecutionEnd: () => assert.fail('no execution'),
  })
  assert.deepEqual(result.execution, { requestId: null, started: false, ended: true, reason: 'not_started' })
  assert.equal(fx.jobs.length, 0)
})

test('forwardApi headers carry an unfinished execution and never signal completion', async (t) => {
  const finish = deferred()
  const fx = await fixture(t, async (_job, _req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    await finish.promise
    res.end('data: {"type":"message_stop"}\n\n')
  })
  const upstream = await forwardApi({ cfg: fx.cfg, url: 'https://synthetic.invalid', body: {} })
  try {
    assert.equal(upstream.execution.started, true)
    assert.equal(upstream.execution.ended, false)
  } finally {
    finish.resolve()
    upstream.resume()
  }
})

test('API transport-error EOF retains a durable job and blocks independent PostgreSQL admission', async (t) => {
  const fx = await fixture(t, (_job, _req, res) => {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end('{"error":{"code":"upstream_transport"}}')
  })
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => other.close())
  const a = new SharedExecutionAdmissions(db)
  const b = new SharedExecutionAdmissions(other)
  const input = {
    accountId: 'api-key-test',
    vmId: 'api-endpoint-test',
    accountLimit: 1,
    vmLimit: 1,
    fableLimit: 0,
    rpmLimit: 0,
  }
  const lease = await a.tryReserve(input)
  const result = await fx.run({ onExecutionStart: lease.bindExecution, onExecutionEnd: lease.completeExecution })
  assert.equal(result.execution.ended, false)
  assert.equal((await lease.release()).released, false)
  const blocked = await b.tryReserve(input)
  assert.equal(blocked.ok, false)
  const job = await other.prepare('SELECT * FROM execution_jobs').get()
  assert.equal(job.request_id, fx.jobs[0].request_id)
  assert.equal(job.ended_at, null)
})
