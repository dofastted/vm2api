import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { createFailoverMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'
import { validateCacheBreakpoints } from '../../src/lib/protocol/cache-ttl.mjs'

const rule = 'CALLER_SYSTEM_SURVIVES_REPAIR_38ba'
const success = {
  ok: true,
  status: 200,
  terminalState: 'verified',
  body: {
    id: 'fixture',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: 'OK' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  },
}
const cases = [
  {
    name: 'prefill',
    error: 'conversation must end with a user message',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Prefill' },
    ],
    check(body) {
      assert.equal(body.messages.at(-1).role, 'user')
    },
  },
  {
    name: 'signature',
    error: 'thinking.signature: Field required',
    messages: [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Reasoning', signature: 'fixture-signature-0123456789' },
          { type: 'text', text: 'Answer' },
        ],
      },
      { role: 'user', content: 'Continue' },
    ],
    check(body) {
      assert.equal(body.thinking, undefined)
      assert.ok(
        !body.messages.some(
          (message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'thinking'),
        ),
      )
    },
  },
  {
    name: 'search',
    error: 'messages.1.content.0: Invalid `encrypted_content` in `search_result` block',
    messages: [
      { role: 'user', content: 'Find it' },
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'release' } },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [
              { type: 'web_search_result', title: 'T', url: 'https://example.invalid', encrypted_content: 'fixture' },
            ],
          },
          { type: 'text', text: 'Found' },
        ],
      },
      { role: 'user', content: 'Continue' },
    ],
    check(body) {
      assert.ok(!JSON.stringify(body).includes('encrypted_content'))
    },
  },
]

async function runCase(t, fixture, { switchAfterRepair = false, repeatWithCachedSearchRepair = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-retry-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routing = {
    compatibility: { persona_preset: 'official', overlay_preset: 'off' },
    failover: { signature_repair: true },
  }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const scheduler = {
    async selectAndReserve({ excluded } = {}) {
      const alternate = switchAfterRepair && Boolean(excluded?.has('vm-zero'))
      const vmId = alternate ? 'vm-other' : 'vm-zero'
      const vm = { id: vmId, persona_preset: alternate ? 'official_full' : 'zero', official_cc_inference: 'cli-hop' }
      return { ok: true, vmId, accountId: vmId, vm, exec: { vmId, vm, homeDir: root }, release() {} }
    },
    markSuccess() {},
    markCooldown() {},
    releaseAccountSessions() {},
  }
  const runner = new FailoverRunner({
    scheduler,
    schedulerRuntime: createFailoverMockSchedulerRuntime({ scheduler }),
    config: { signature_repair: true, max_same_account_retries: 0 },
  })
  const hops = []
  const input = { model: 'claude-opus-5-5', max_tokens: 128, stream: false, system: rule, messages: fixture.messages }
  const response = { headersSent: false, on() {}, once() {}, off() {}, write() {}, end() {} }
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => input,
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'zero-retry-fixture' }), finish() {} },
    stickyRouter: {
      extractPoolKey: () => (repeatWithCachedSearchRepair ? 'search-repair-session' : null),
      collectPoolKeys: () => [],
    },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
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
          callAttempt({ body, attemptMeta, candidate }) {
            hops.push({
              body: structuredClone(body),
              repaired: attemptMeta.repaired,
              preset: candidate.vm.persona_preset,
            })
            if (hops.length === 1)
              return { ok: false, status: 400, terminalState: 'rejected', body: { error: { message: fixture.error } } }
            if (switchAfterRepair && hops.length === 2)
              return { ok: false, status: 529, terminalState: 'rejected', body: { error: { message: 'Overloaded' } } }
            return structuredClone(success)
          },
        })
      },
    },
  })
  const request = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer fixture', 'user-agent': 'test-client' },
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'fixture-key' },
    once() {},
    off() {},
  }
  await handler.handleProtocol(request, response, 'anthropic.messages', '/v1/messages')
  if (repeatWithCachedSearchRepair) {
    assert.equal(hops.length, 2)
    await handler.handleProtocol(request, response, 'anthropic.messages', '/v1/messages')
  }
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(hops.length, switchAfterRepair || repeatWithCachedSearchRepair ? 3 : 2)
  for (const [index, hop] of hops.entries()) {
    assert.equal(JSON.stringify(hop.body).split(rule).length - 1, 1)
    assert.equal(hop.repaired, index > 0 && !(repeatWithCachedSearchRepair && index === 2))
    assert.equal(hop.body.system[0].text.includes('prompt_version=<'), hop.preset === 'zero')
    // Mode 3 (zero) preserves caller system verbatim in system[] without relocating to messages[0];
    // non-zero presets relocate third-party caller system to the head of the first user turn.
    const firstUser = hop.body.messages.find((message) => message.role === 'user')
    if (hop.preset === 'zero') {
      assert.ok(hop.body.system.some((block) => block.text === rule))
      assert.ok(!firstUser.content.some((block) => block.text === rule))
    } else {
      assert.ok(firstUser.content.some((block) => block.text === rule))
      assert.ok(!JSON.stringify(hop.body.system).includes(rule))
    }
    if (index > 0) fixture.check(hop.body)
    validateCacheBreakpoints(hop.body)
  }
}

for (const fixture of cases) {
  test(`slot zero keeps caller system and the ${fixture.name} repair through the real handler and runner`, (t) =>
    runCase(t, fixture))
}
test('a repaired request uses the next slot preset when failover switches accounts', (t) =>
  runCase(t, cases[0], { switchAfterRepair: true }))
test('a cached search repair survives slot rendering on the next request without another retry', (t) =>
  runCase(t, cases[2], { repeatWithCachedSearchRepair: true }))
