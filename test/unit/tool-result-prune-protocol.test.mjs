import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

const ORIGINAL = 'file output\n' + '0123456789abcdef'.repeat(900)
const PRUNED = ORIGINAL.slice(0, 4096) + '\n\n[... tool result middle pruned ...]\n\n' + ORIGINAL.slice(-1024)
const resultText = (body) =>
  body.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block.type === 'tool_result' && block.tool_use_id === 'read-1')?.content

function payload(protocol, content, next = false) {
  const tail = next
    ? [
        { role: 'assistant', content: 'Read it.' },
        { role: 'user', content: 'Continue.' },
      ]
    : []
  if (protocol === 'openai.chat')
    return {
      model: 'claude-opus-5',
      max_tokens: 1024,
      stream: false,
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      messages: [
        { role: 'user', content: 'Inspect this file.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
        },
        { role: 'tool', tool_call_id: 'read-1', content },
        ...tail,
      ],
    }
  return {
    model: 'claude-opus-5',
    max_tokens: 1024,
    stream: false,
    tools: [{ name: 'read', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'Inspect this file.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'read', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content }] },
      ...tail,
    ],
  }
}

async function fixture(t, { enabled = true, failSeed = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-prune-protocol-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routing = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: { persona_preset: 'official_full', overlay_preset: 'off', preserve_pruned_tool_results: enabled },
  }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const posted = []
  const logged = []
  let sequence = 0
  const vm = { id: 'fixture-slot', official_cc_inference: 'cli-hop' }
  const runner = new FailoverRunner({
    scheduler: {
      async selectAndReserve() {
        return { ok: true, vmId: vm.id, accountId: vm.id, vm, exec: { vmId: vm.id, vm, homeDir: root }, release() {} }
      },
      markSuccess() {},
      markCooldown() {},
      releaseAccountSessions() {},
    },
    config: { max_same_account_retries: 0 },
  })
  const handler = createHandleProtocol({
    json(res, status, body) {
      res.statusCode = status
      res.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async (req) => {
      if (req.disconnectDuringRead === 'close') req.response.emit('close')
      if (req.disconnectDuringRead === 'aborted') req.emit('aborted')
      return structuredClone(req.body)
    },
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: `prune-${++sequence}` }), finish: (_ctx, row) => logged.push(row) },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      run(opts) {
        return runner.run({
          ...opts,
          callAttempt({ body }) {
            posted.push(structuredClone(body))
            if (failSeed && posted.length === 1)
              return {
                ok: false,
                status: 400,
                terminalState: 'rejected',
                body: { type: 'error', error: { type: 'invalid_request_error', message: 'fixture rejection' } },
              }
            return {
              ok: true,
              status: 200,
              terminalState: 'verified',
              body: {
                id: 'fixture',
                type: 'message',
                role: 'assistant',
                model: body.model,
                content: [{ type: 'text', text: 'OK' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 20000, output_tokens: 10 },
              },
            }
          },
        })
      },
    },
  })
  return {
    posted,
    logged,
    async request(
      body,
      protocol,
      key = 'test-key',
      session = 'session-00000000-0000-4000-8000-000000000001',
      disconnectDuringRead = null,
    ) {
      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        url: '/v1/messages',
        body,
        headers: {
          authorization: `Bearer ${key}`,
          'user-agent': 'deepseek-harness/0.2.1',
          'x-client-request-id': session,
          'x-session-id': 'fixture-route',
        },
        apiKeyKind: 'managed',
        apiKeyRecord: { id: key },
        presentedApiKey: key,
      })
      const res = Object.assign(new EventEmitter(), { statusCode: 200, headersSent: false, write() {}, end() {} })
      req.response = res
      req.disconnectDuringRead = disconnectDuringRead
      await handler.handleProtocol(req, res, protocol, req.url)
      if (!disconnectDuringRead) {
        res.emit('finish')
        res.emit('close')
      }
      return res
    },
  }
}

for (const protocol of ['anthropic.messages', 'openai.chat']) {
  test(`${protocol}: restores before persona and quota preparation without mutating caller history`, async (t) => {
    const f = await fixture(t)
    assert.equal((await f.request(payload(protocol, ORIGINAL), protocol)).statusCode, 200)
    const request = payload(protocol, PRUNED, true)
    const before = structuredClone(request)
    assert.equal((await f.request(request, protocol)).statusCode, 200)
    assert.equal(resultText(f.posted[0]), ORIGINAL)
    assert.equal(resultText(f.posted[1]), ORIGINAL)
    assert.deepEqual(request, before)
    assert.deepEqual(f.logged[1].hop_meta.tool_result_prune, { restored: 1, reason: 'restored' })
  })
}

test('disabled protection forwards the caller-pruned text unchanged', async (t) => {
  const f = await fixture(t, { enabled: false })
  await f.request(payload('anthropic.messages', ORIGINAL), 'anthropic.messages')
  await f.request(payload('anthropic.messages', PRUNED, true), 'anthropic.messages')
  assert.equal(resultText(f.posted[1]), PRUNED)
  assert.equal(f.logged[1].hop_meta?.tool_result_prune, undefined)
})

test('a rejected upstream request cannot seed original text', async (t) => {
  const f = await fixture(t, { failSeed: true })
  assert.equal((await f.request(payload('anthropic.messages', ORIGINAL), 'anthropic.messages')).statusCode, 400)
  await f.request(payload('anthropic.messages', PRUNED, true), 'anthropic.messages')
  assert.equal(resultText(f.posted[1]), PRUNED)
})

test('the transport integration isolates different authenticated keys', async (t) => {
  const f = await fixture(t)
  await f.request(payload('anthropic.messages', ORIGINAL), 'anthropic.messages', 'key-a')
  await f.request(payload('anthropic.messages', PRUNED, true), 'anthropic.messages', 'key-b')
  assert.equal(resultText(f.posted[1]), PRUNED)
})

for (const earlyEvent of ['close', 'aborted']) {
  test(`an early ${earlyEvent} before prepare cannot strand the session transaction`, async (t) => {
    const f = await fixture(t)
    const session = 'session-00000000-0000-4000-8000-000000000099'
    await f.request(payload('anthropic.messages', ORIGINAL), 'anthropic.messages', 'test-key', session, earlyEvent)
    await f.request(payload('anthropic.messages', ORIGINAL), 'anthropic.messages', 'test-key', session)
    await f.request(payload('anthropic.messages', PRUNED, true), 'anthropic.messages', 'test-key', session)
    assert.equal(f.logged.length, 2)
    assert.equal(f.logged[0].hop_meta.tool_result_prune.reason, 'cold')
    assert.deepEqual(f.logged[1].hop_meta.tool_result_prune, { restored: 1, reason: 'restored' })
    assert.equal(resultText(f.posted.at(-1)), ORIGINAL)
  })
}
