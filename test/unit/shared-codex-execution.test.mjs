import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { SharedExecutionAdmissions } from '../../src/lib/pool/shared-execution-admissions.mjs'
import { handleCodexProtocol } from '../../src/lib/protocol/handle-codex.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test
const accountId = 'codex:synthetic-shared-account'
const vmId = 'vm-shared-codex'

function success(res) {
  const usage = { input_tokens: 1, output_tokens: 1 }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-usage': JSON.stringify(usage) })
  res.end(
    `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-shared', status: 'completed', output: [], usage } })}\n\n`,
  )
}

async function fixture(t, handle = (_job, _req, res) => success(res)) {
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
      policy: { maxConcurrency: 1, concurrencyOverride: true },
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
  const bindingsAtSend = []
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const job = JSON.parse(Buffer.concat(chunks).toString())
      if (req.url.endsWith('/cancel')) {
        res.end('{"ok":true,"cancelled":true}')
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
    async run({ sharedRuntime, sessionId = null } = {}) {
      const response = { headersSent: false, write() {}, end() {} }
      const body = { model: 'gpt-5.4', input: 'synthetic request', stream: false }
      await handleCodexProtocol({
        req: { headers: sessionId ? { 'x-session-id': sessionId } : {}, apiKeyKind: 'user' },
        res: response,
        protocol: 'openai.responses',
        ctx: { body },
        inbound: body,
        projectRoot: root,
        logBag: {},
        stats: { requests: 0, errors: 0, by_route: {} },
        routing: {
          codex: { quota: { max_concurrency: 1 } },
          failover: { fallback_wait_timeout_ms: 1000, max_total_attempts: 2, max_same_account_retries: 0 },
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
      return response
    },
  }
}

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

unixTest('Codex cannot bypass account capacity held by another database connection', async (t) => {
  const fx = await fixture(t)
  const held = await new SharedExecutionAdmissions(fx.other).tryReserve({
    accountId,
    vmId,
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
