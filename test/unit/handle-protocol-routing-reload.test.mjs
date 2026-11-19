import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

test('each Claude attempt reads routing.json instead of the stale in-memory snapshot', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-reload-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { persona_preset: 'zero' }, failover: {} }))
  const logged = []
  const handler = createHandleProtocol({
    json: (_res, status) => status,
    writeSSEHeaders() {},
    readBody: async () => ({ model: 'claude-haiku-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000, stream_idle_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: {
      start: () => ({ request_id: 'routing-reload', mode: 'normal' }),
      finish: (_ctx, row) => logged.push(row),
    },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility: { persona_preset: 'official_full' }, failover: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      async run(opts) {
        const selected = { vmId: 'vm-01', accountId: 'account-a', vm: { id: 'vm-01' }, exec: { homeDir: root } }
        await opts.applyAttempt(opts.canonicalBody, selected)
        return { ok: false, status: 503, body: { error: { message: 'stop' } } }
      },
    },
  })
  const res = {
    headersSent: false,
    on(event, fn) {
      if (event === 'finish') this.finish = fn
    },
    once() {},
    off() {},
    write() {},
    end() {},
  }
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer sk-vm-x', 'user-agent': 'claude-cli/2.1.241 (external, cli)' },
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'key-1' },
    once() {},
    off() {},
  }
  await handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')
  res.finish?.()
  assert.equal(logged.at(-1)?.persona_preset, 'zero')
})
