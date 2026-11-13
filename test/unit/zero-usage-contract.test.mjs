import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { applyCrsUnofficialPersona, CRS_OFFICIAL_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'
import { estimateClaudeInputTokens, personaHideForUnofficial } from '../../src/lib/identity/crs-persona-usage.mjs'
import { costColumnsFromUsage } from '../../src/lib/admin/pricing.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test
const environment =
  '# Environment\n - Timezone: UTC\n - Caller-owned rule: ' + 'Keep the application rules. '.repeat(100)
const model = 'claude-haiku-4-5'
const messages = [{ role: 'user', content: 'Hello' }]
const baseUsage = { input_tokens: 10000, output_tokens: 1 }
const cacheUsage = (five, hour) => ({
  ...baseUsage,
  cache_creation_input_tokens: five + hour,
  cache_creation: { ephemeral_5m_input_tokens: five, ephemeral_1h_input_tokens: hour },
})

test('usage hiding excludes retained caller blocks regardless of their order or cache state', () => {
  const caller = [
    { type: 'text', text: environment },
    { type: 'text', text: CRS_OFFICIAL_SYSTEM, cache_control: { type: 'ephemeral' } },
  ]
  const before = { system: caller, messages }
  const rendered = applyCrsUnofficialPersona(before, { mode: 'zero', forceConfigured: true })
  const billing = rendered.system[0]
  // Reordering and moving a caller block out of cache must not make it an injection.
  const after = { ...rendered, system: [billing, { type: 'text', text: CRS_OFFICIAL_SYSTEM }, caller[0]] }
  const hide = personaHideForUnofficial(before, after, { mode: 'zero', hides: true })
  assert.equal(hide.official, estimateClaudeInputTokens(billing.text))
  assert.equal(hide.uncached, estimateClaudeInputTokens(billing.text))
  assert.equal(hide.overlay, 0)
})

const cases = [
  { name: 'caller environment', system: environment, usage: cacheUsage(0, 0), setting: '1h' },
  {
    name: 'caller environment sharing a block with stale billing',
    system: `x-anthropic-billing-header: stale;\n${environment}`,
    expectedSystem: environment,
    usage: cacheUsage(0, 0),
    setting: '1h',
  },
  {
    name: 'caller marker without TTL retains implicit 5m under the 1h setting',
    system: [{ type: 'text', text: 'Caller policy', cache_control: { type: 'ephemeral' } }],
    usage: cacheUsage(1000, 0),
    setting: '1h',
  },
  {
    name: 'mixed caller TTLs',
    system: [
      { type: 'text', text: 'Hour prefix', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'Five minute suffix', cache_control: { type: 'ephemeral', ttl: '5m' } },
    ],
    usage: cacheUsage(300, 700),
    setting: '5m',
  },
]

for (const stream of [false, true]) {
  for (const fixture of cases) {
    unixTest(`API zero preserves client usage and billing: ${fixture.name}, stream=${stream}`, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-usage-'))
      const socket = path.join(root, 'run', 'api-kernel.sock')
      fs.mkdirSync(path.dirname(socket), { recursive: true })
      const routing = {
        compatibility: { persona_preset: 'zero', overlay_preset: 'off', cache_ttl: fixture.setting },
        failover: {},
      }
      const routingFile = path.join(root, 'routing.json')
      fs.writeFileSync(routingFile, JSON.stringify(routing))
      let sent
      const kernel = http.createServer(async (req, res) => {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        sent = JSON.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')).body)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
        emit({
          type: 'message_start',
          message: { id: 'fixture', type: 'message', role: 'assistant', model, content: [], usage: fixture.usage },
        })
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'OK' } })
        emit({ type: 'content_block_stop', index: 0 })
        emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
        emit({ type: 'message_stop' })
        res.end()
      })
      t.after(async () => {
        await new Promise((resolve) => kernel.close(resolve))
        fs.rmSync(root, { recursive: true, force: true })
      })
      await new Promise((resolve, reject) => {
        kernel.once('error', reject)
        kernel.listen(socket, resolve)
      })
      const logged = [],
        charged = [],
        writes = []
      let finish
      const response = {
        headersSent: false,
        on(event, fn) {
          if (event === 'finish') finish = fn
        },
        once() {},
        off() {},
        write(chunk) {
          writes.push(String(chunk))
          return true
        },
        end() {},
      }
      const input = { model, max_tokens: 128, stream, system: fixture.system, messages }
      const handler = createHandleProtocol({
        json: (_res, status, body) => {
          response.status = status
          response.body = body
          return body
        },
        writeSSEHeaders(res) {
          res.headersSent = true
        },
        readBody: async () => input,
        requireAuth: () => true,
        cfg: {
          rewrite: { enabled: false },
          intercept: { rules: [] },
          distill: { enabled: false },
          limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
          paths: { data: root },
        },
        requestLog: {
          start: () => ({ request_id: `zero-usage-${stream}-${fixture.name}` }),
          finish: (_ctx, row) => logged.push(row),
        },
        stickyRouter: {},
        accountQuota: {},
        apiKeyStore: {
          acquire: () => ({ ok: true }),
          release() {},
          recordUsage: (_key, usage, options) => charged.push({ usage, options }),
        },
        apiScheduler: {
          pick: () => ({
            ok: true,
            endpoint: { id: 'ep', kind: 'claude', protocol: 'anthropic', base_url: 'https://upstream.invalid' },
            upstream_model: model,
            key: { id: 'fixture', api_key: 'fixture-not-secret' },
          }),
        },
        apiEndpointStore: {},
        stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
        routingConfigPath: routingFile,
        routingConfig: routing,
        groupsRepo: { rateMultiplier: () => 1 },
      })
      await handler.handleProtocol(
        {
          method: 'POST',
          url: '/v1/messages',
          headers: { authorization: 'Bearer fixture', 'user-agent': 'test-client' },
          apiKeyKind: 'managed',
          apiKeyRecord: { category: 'api' },
          once() {},
          off() {},
        },
        response,
        'anthropic.messages',
        '/v1/messages',
      )
      finish?.()
      let clientUsage
      if (stream) {
        const events = writes
          .join('')
          .split('\n')
          .filter((line) => line.startsWith('data: {'))
          .map((line) => JSON.parse(line.slice(6)))
        clientUsage = events.find((event) => event.type === 'message_start')?.message?.usage
      } else {
        assert.equal(response.status, 200)
        clientUsage = response.body.usage
      }
      assert.deepEqual(
        sent.system.slice(1),
        typeof fixture.system === 'string'
          ? [{ type: 'text', text: fixture.expectedSystem || fixture.system }]
          : fixture.expectedSystem || fixture.system,
      )
      assert.equal(
        clientUsage.input_tokens,
        fixture.usage.input_tokens - estimateClaudeInputTokens(sent.system[0].text),
      )
      assert.deepEqual(clientUsage.cache_creation, fixture.usage.cache_creation)
      assert.equal(logged.length, 1)
      assert.equal(charged.length, 1)
      for (const usage of [logged[0].usage, charged[0].usage]) {
        assert.equal(usage.input_tokens, fixture.usage.input_tokens)
        assert.deepEqual(usage.cache_creation, fixture.usage.cache_creation)
      }
      assert.equal(charged[0].options.officialCost, costColumnsFromUsage(fixture.usage, model).total_cost)
    })
  }
}
