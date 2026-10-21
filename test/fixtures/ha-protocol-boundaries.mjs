import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { readBody } from '../../src/lib/http/respond.mjs'

const kind = process.env.VM2API_HA_PROTOCOL_CASE
const events = []
const supervisor = await import('../../src/lib/transport/rust-kernel-supervisor.mjs')
const telemetry = await import('../../src/lib/vm/worker-telemetry.mjs')
const identity = await import('../../src/lib/identity/vm-identity.mjs')
const context = await import('../../src/lib/core/ha-request-context.mjs')
mock.module(new URL('../../src/lib/core/ha-request-context.mjs', import.meta.url), {
  namedExports: { ...context, currentHaRequestContext: () => ({ requestId: 'server-owned-ha-request' }) },
})
mock.module(new URL('../../src/lib/transport/rust-kernel-supervisor.mjs', import.meta.url), {
  namedExports: { ...supervisor, syncClaudeKernelConfigsFromFile() { events.push('sync'); if (kind !== 'touch') throw new Error('Pod publication forbidden'); return {} } },
})
mock.module(new URL('../../src/lib/vm/worker-telemetry.mjs', import.meta.url), {
  namedExports: { ...telemetry, touchTelemetrySession() { events.push('touch'); throw new Error('Pod telemetry publication forbidden') } },
})
mock.module(new URL('../../src/lib/identity/vm-identity.mjs', import.meta.url), {
  namedExports: { ...identity, loadVmIdentity: () => ({ accountUuid: 'ha-account', fingerprint: { device_id: 'synthetic-ha-device' } }) },
})
mock.module(new URL('../../src/lib/protocol/handle-codex.mjs', import.meta.url), {
  namedExports: { handleCodexProtocol: () => { events.push('codex'); return {} }, handleCodexSearch: () => { events.push('search'); return {} }, usageFromSseLine: () => null },
})
if (kind === 'rewrite-gpt') mock.module(new URL('../../src/lib/protocol/codex-model-mapping.mjs', import.meta.url), {
  namedExports: { applyCodexInboundModelRewrite: (body) => ({ ok: true, mapped: true, body: { ...body, model: 'gpt-5.4' } }) },
})
const { createHandleProtocol } = await import('../../src/lib/protocol/handle-protocol.mjs')

test(`HA protocol boundary ${kind}`, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-648-ha-protocol-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routing = { compatibility: { claude_code_only: false } }
  const routingConfigPath = path.join(root, 'routing.json')
  fs.writeFileSync(routingConfigPath, JSON.stringify(routing))
  let prepared
  const handler = createHandleProtocol({
    cfg: { limits: { max_body_bytes: 1 << 20 }, rewrite: { enabled: false }, intercept: { rules: [] }, distill: { enabled: false }, paths: { project: root, data: root } },
    json(res, status, body) { res.statusCode = status; res.body = body }, readBody,
    requireAuth(req) {
      req.apiKeyKind = kind === 'api' ? 'managed' : 'master'
      if (kind === 'api') req.apiKeyRecord = { id: 'fixture-key', category: 'api', group_type: 'all' }
      return true
    },
    requestLog: { start: () => ({ request_id: 'untrusted-client-id', t0: Date.now() }) },
    stats: { errors: 0, requests: 0, by_route: {} }, groupsRepo: { rateMultiplier: () => 1 },
    apiKeyStore: { reserve: async () => { events.push('reserve'); throw new Error('unsupported backend reservation forbidden') } },
    stickyRouter: { resolve: () => null }, accountQuota: { ingestHeaders() {} },
    routingConfig: routing, routingConfigPath,
    failoverRunner: { async run(args) {
      events.push('runner')
      prepared = await args.applyAttempt(structuredClone(args.canonicalBody), {
        vmId: 'ha-vm', accountId: 'ha-account', vm: { id: 'ha-vm', claude: { has_access: true } }, exec: { vmId: 'ha-vm', vm: {} },
      }, { attemptNo: 1, attemptStartedAt: Date.now() })
      return { ok: true, status: 200, finalState: 'verified', vmId: 'ha-vm', body: { id: 'ha-message', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'synthetic' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }
    } },
  })
  let body = { model: kind === 'gpt' ? 'gpt-5.4' : 'claude-sonnet-4-6', max_tokens: 20, messages: [{ role: 'user', content: 'synthetic static prompt' }] }
  let protocol = 'anthropic.messages'
  if (kind === 'chat') protocol = 'openai.chat'
  if (kind === 'responses') { protocol = 'openai.responses'; body = { model: 'claude-sonnet-4-6', input: 'synthetic static prompt' } }
  if (kind === 'completions') { protocol = 'openai.completions'; body = { model: 'claude-sonnet-4-6', prompt: 'synthetic static prompt', max_tokens: 20 } }
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.headers = { 'user-agent': 'synthetic-ha-client', 'x-request-id': 'untrusted-client-id' }
  const res = new EventEmitter()
  res.setHeader = () => {}
  if (kind === 'search') await handler.handleSearch(req, res, '/v1/alpha/search')
  else await handler.handleProtocol(req, res, protocol, '/synthetic-messages')
  if (kind === 'responses') {
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error.code, 'protocol_not_allowed')
    assert.deepEqual(events, [])
  } else if (['gpt', 'api', 'search', 'rewrite-gpt'].includes(kind)) {
    assert.equal(res.statusCode, 503)
    assert.equal(res.body.error.code, 'ha_operation_unsupported')
    assert.deepEqual(events, [])
  } else {
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res._kinRequestId, 'server-owned-ha-request')
    assert.ok(prepared?.body)
    assert.deepEqual(events, ['runner'])
  }
})
