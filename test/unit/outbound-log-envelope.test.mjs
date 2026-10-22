import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../../src/lib/db/database.mjs'
import { flushPendingWrites } from '../../src/lib/db/pending-writes.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { ThinkingOwnerStore } from '../../src/lib/pool/thinking-owner.mjs'

// Unix socket 在 Windows 上不可用，和 go-worker-client.test.mjs 的 unixTest 保持一致。
const unixTest = process.platform === 'win32' ? test.skip : test

/**
 * 假槽位 kernel：/internal/health 报告就绪，推理路由记下收到的 envelope 并回一段完整 SSE。
 * 请求日志该记的正是这里收到的 body / headers。
 */
async function fakeKernel() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-outbound-log-'))
  const runDir = path.join(root, 'vm-01', 'run')
  const homeDir = path.join(root, 'vm-01', 'cli-home')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  const tokenFile = path.join(runDir, 'internal.token')
  fs.writeFileSync(tokenFile, 'internal-test\n', { mode: 0o600 })
  const socket = path.join(runDir, 'kernel.sock')
  const posted = []
  const server = http.createServer(async (req, res) => {
    if (req.url === '/internal/health') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, engine: 'rust', healthy: true, ready_slots: 4 }))
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    posted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.setHeader('content-type', 'text/event-stream')
    const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    send({
      type: 'message_start',
      message: {
        id: `msg_log_${posted.length}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
    send({ type: 'content_block_stop', index: 0 })
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
    send({ type: 'message_stop' })
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  const vm = {
    id: 'vm-01',
    runtime: { worker_socket: socket, kernel_socket: socket, worker_run_dir: runDir, worker_token_file: tokenFile },
  }
  return {
    root,
    posted,
    selected: { vmId: 'vm-01', accountId: 'account-a', vm, exec: { vmId: 'vm-01', homeDir, vm } },
    async close() {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function fakeResponse() {
  const listeners = {}
  return {
    headersSent: false,
    statusCode: 200,
    on(event, fn) {
      listeners[event] = fn
    },
    once() {},
    off() {},
    setHeader() {},
    writeHead(status) {
      this.statusCode = status
      this.headersSent = true
    },
    write() {
      return true
    },
    end() {},
    finish() {
      listeners.finish?.()
    },
  }
}

unixTest('debug log records the envelope the slot kernel received, not the pre-transport body', async () => {
  const kernel = await fakeKernel()
  const finished = []
  const handler = createHandleProtocol({
    json: (res, status) => {
      res.statusCode = status
      return status
    },
    writeSSEHeaders(res) {
      res.headersSent = true
    },
    readBody: async (req) => req.body,
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 5000, stream_idle_timeout_ms: 5000 },
      paths: { data: kernel.root, project: kernel.root },
    },
    requestLog: {
      start: () => ({ request_id: 'outbound-log', mode: 'debug', capture_outbound: true }),
      finish: (_ctx, extra) => finished.push(extra),
    },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { reserve: async () => ({ ok: true, release: async () => {} }) },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: path.join(kernel.root, 'routing.json'),
    routingConfig: { compatibility: {}, failover: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    thinkingOwners: new ThinkingOwnerStore({ db: getDb() }),
    failoverRunner: {
      async run(opts) {
        const prepared = await opts.applyAttempt(opts.canonicalBody, kernel.selected)
        const hop = await opts.callAttempt({
          candidate: kernel.selected,
          body: prepared.body,
          attemptMeta: prepared.meta,
          deliveryMode: 'realtime',
          signal: new AbortController().signal,
          onCommit() {},
        })
        return { ...hop, accountId: kernel.selected.accountId, vmId: kernel.selected.vmId }
      },
    },
  })
  const request = (body) => ({
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-x', 'user-agent': 'claude-cli/2.1.304 (external, cli)' },
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'key-1' },
    body,
    once() {},
    off() {},
  })
  // 路由只检查宿主 kernel 路径非空才放行这一跳；真正接请求的是上面的假 kernel socket。
  const prevKernelBin = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = path.join(kernel.root, 'kin-kernel')
  try {
    // 非流式走 streamAndAssembleClaudeMessage，流式走 dispatchStreamInference，两条路都要记 envelope。
    for (const stream of [false, true]) {
      const res = fakeResponse()
      await handler.handleProtocol(
        request({ model: 'claude-haiku-4-5', stream, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
        res,
        'anthropic.messages',
        '/v1/messages',
      )
      res.finish()
      await flushPendingWrites()
    }
    assert.equal(
      kernel.posted.length,
      2,
      JSON.stringify(finished.map((f) => [f.status, f.error_code, f.error_message])),
    )
    assert.equal(finished.length, 2)
    for (const [i, extra] of finished.entries()) {
      const sent = kernel.posted[i]
      assert.deepEqual(JSON.parse(JSON.stringify(extra.outbound_body)), sent.body)
      // cli-hop 在传输层才补的字段：betas 与 cch 占位；billing 由 cli-hop 末段补上。
      assert.ok(Array.isArray(extra.outbound_body.betas))
      assert.match(extra.outbound_body.system[0].text, /^x-anthropic-billing-header: .*\bcch=00000;/)
      assert.equal(extra.outbound_headers['anthropic-beta'], sent.headers['anthropic-beta'])
    }
  } finally {
    if (prevKernelBin === undefined) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = prevKernelBin
    await kernel.close()
  }
})
