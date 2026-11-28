import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { classifierFixture } from '../fixtures/auto-mode.mjs'

openDatabase({ dbPath: ':memory:' })
after(() => closeDatabase())
for (const classifier of [false, true]) {
  for (const invalid of [
    { model: 'claude-opus-5-5' },
    { output_config: { effort: 'xhigh' } },
    { output_config: { effort: 'max' } },
    { thinking: { type: 'between_tools', display: 'omitted' } },
    { thinking: { type: 'between_tools', budget_tokens: 1024 } },
    { thinking: { type: 'between_tools', block_binding: true } },
  ]) {
    test(`${classifier ? 'classifier' : 'ordinary'} OAuth ingress rejects ${JSON.stringify(invalid)} before allocation`, async () => {
      const input = {
        ...(classifier
          ? classifierFixture({ model: 'claude-sonnet-5-5' })
          : {
              model: 'claude-sonnet-5-5',
              max_tokens: 64,
              messages: [{ role: 'user', content: 'Hello' }],
            }),
        thinking: { type: 'between_tools' },
        ...invalid,
      }
      const sessionId = '11111111-2222-4333-8444-555555555555'
      if (classifier) {
        input.metadata = { user_id: JSON.stringify({ device_id: 'a'.repeat(64), session_id: sessionId }) }
      }
      let admissions = 0
      let selections = 0
      const response = { headersSent: false, on() {}, once() {}, off() {}, write() {}, end() {} }
      const handler = createHandleProtocol({
        json: (_res, status, body) => {
          response.status = status
          response.body = body
        },
        writeSSEHeaders() {},
        readBody: async () => input,
        requireAuth: () => true,
        cfg: {
          rewrite: { enabled: false },
          intercept: { rules: [] },
          distill: { enabled: false },
          limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
          paths: { data: os.tmpdir(), project: os.tmpdir() },
        },
        requestLog: { start: () => ({ request_id: 'between-tools-test' }), finish() {} },
        stickyRouter: {},
        accountQuota: {},
        apiKeyStore: {
          acquire: () => {
            admissions++
            return { ok: true }
          },
          release() {},
          users: { getById: () => ({ role: 'admin' }) },
        },
        apiScheduler: {
          pick: () => {
            selections++
            return { ok: false }
          },
        },
        apiEndpointStore: {},
        stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
        routingConfig: { failover: {} },
        groupsRepo: { rateMultiplier: () => 1 },
      })
      const req = {
        method: 'POST',
        url: '/v1/messages',
        headers: classifier
          ? {
              'user-agent': 'claude-cli/2.1.293 (external, cli)',
              'x-app': 'cli',
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'claude-code-20250219',
              'anthropic-dangerous-direct-browser-access': 'true',
              'x-claude-code-session-id': sessionId,
              'x-stainless-lang': 'js',
              'x-stainless-package-version': '0.128.0',
              'x-stainless-os': 'Linux',
              'x-stainless-arch': 'x64',
              'x-stainless-runtime': 'node',
              'x-stainless-runtime-version': 'v26.12.1',
              'x-stainless-retry-count': '0',
              'x-stainless-timeout': '600',
            }
          : { 'user-agent': 'test-client' },
        apiKeyKind: 'managed',
        apiKeyRecord: { category: 'oauth', user_id: 'admin' },
        once() {},
        off() {},
      }
      await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
      assert.equal(response.status, 400)
      assert.equal(response.body.error.type, 'invalid_request_error')
      assert.equal(response.body.error.code, classifier ? 'classifier_model_incompatible' : 'thinking_incompatible')
      assert.equal(admissions, 0)
      assert.equal(selections, 0)
    })
  }
}
